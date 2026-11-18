use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::time::Duration;

pub fn base_host_from_api_base(api_base: &str) -> &str {
    let clean_base = api_base.trim_end_matches('/');
    clean_base.split("/v1").next().unwrap_or(clean_base)
}

/// Returns the loaded model id only when `data[].status.value == "loaded"`.
pub fn parse_loaded_model_id(val: &Value) -> Option<String> {
    let data = val.get("data").and_then(|d| d.as_array())?;
    data.iter().find_map(|m| {
        let is_loaded = m
            .get("status")
            .and_then(|s| s.get("value"))
            .and_then(|v| v.as_str())
            == Some("loaded");
        if is_loaded {
            Some(
                m.get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
            )
        } else {
            None
        }
    })
}

pub fn query_models_endpoint(
    agent: &ureq::Agent,
    api_base: &str,
    api_key: &str,
) -> Result<Option<String>, (Option<u16>, String)> {
    let clean_base = api_base.trim_end_matches('/');
    let models_url = format!("{}/models", clean_base);
    let mut req = agent.get(&models_url);
    if !api_key.is_empty() {
        req = req.set("Authorization", &format!("Bearer {}", api_key));
    }
    match req.call() {
        Ok(resp) => match resp.into_json::<Value>() {
            Ok(val) => Ok(parse_loaded_model_id(&val)),
            Err(e) => Err((None, format!("Invalid JSON from /models: {}", e))),
        },
        Err(ureq::Error::Status(code, _)) => {
            Err((Some(code), format!("HTTP {} from /models", code)))
        }
        Err(e) => Err((None, e.to_string())),
    }
}

pub fn ensure_model_loaded(api_base: &str, api_key: &str) {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .timeout_read(Duration::from_secs(5))
        .build();

    // 1. Check if model is already loaded
    if let Ok(Some(_)) = query_models_endpoint(&agent, api_base, api_key) {
        return;
    }

    // 2. Trigger /load
    eprintln!("[Strata Worker] Model is unloaded; sending /load request...");
    let base_host = base_host_from_api_base(api_base);
    let load_endpoint = format!("{}/load", base_host);

    let mut load_req = ureq::post(&load_endpoint)
        .timeout(Duration::from_secs(180))
        .set("Origin", base_host)
        .set("Content-Type", "application/json");

    if !api_key.is_empty() {
        load_req = load_req.set("Authorization", &format!("Bearer {}", api_key));
    }

    match load_req.send_string("{}") {
        Ok(_) => {
            eprintln!("[Strata Worker] /load completed.");
            return;
        }
        Err(e) => {
            eprintln!("Warning: /load request returned {}", e);
        }
    }

    // 3. Poll for model load status
    for _ in 0..30 {
        std::thread::sleep(Duration::from_secs(2));
        if let Ok(Some(_)) = query_models_endpoint(&agent, api_base, api_key) {
            eprintln!("[Strata Worker] Model successfully loaded.");
            return;
        }
    }

    eprintln!("Warning: Timed out waiting for model to load");
}

pub fn call_strata_api(
    api_base: &str,
    api_key: &str,
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
    temperature: f32,
    max_tokens: u32,
    reasoning_effort: Option<&str>,
) -> Result<String, String> {
    ensure_model_loaded(api_base, api_key);

    let clean_base = api_base.trim_end_matches('/');
    let url = format!("{}/chat/completions", clean_base);

    let mut payload = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": true,
    });

    if let Some(effort) = reasoning_effort {
        payload["reasoning_effort"] = json!(effort);
    }

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(600))
        .build();

    let mut retries = 0;
    let resp = loop {
        let mut req = agent
            .post(&url)
            .set("Content-Type", "application/json");

        if !api_key.is_empty() {
            req = req.set("Authorization", &format!("Bearer {}", api_key));
        }

        match req.send_json(payload.clone()) {
            Ok(r) => break r,
            Err(ureq::Error::Status(503, _)) if retries < 15 => {
                retries += 1;
                eprintln!("[Strata Worker] Received 503 (model warming up), retrying in 3s ({}/15)...", retries);
                std::thread::sleep(Duration::from_secs(3));
            }
            Err(e) => {
                return Err(format!(
                    "Failed to connect to Strata at {}: {}\nEnsure the Strata server is running and reachable.",
                    url, e
                ));
            }
        }
    };

    let reader = BufReader::new(resp.into_reader());
    read_sse_stream(reader)
}

pub fn read_sse_stream<R: std::io::Read>(reader: BufReader<R>) -> Result<String, String> {
    let mut content_buf = String::new();
    let mut reasoning_buf = String::new();
    let mut keepalive_count: usize = 0;
    let mut data_count: usize = 0;
    let mut received_done = false;

    for line_res in reader.lines() {
        let line = line_res.map_err(|e| format!("Stream read error: {}", e))?;
        let trimmed = line.trim();

        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with(':') {
            keepalive_count += 1;
            continue;
        }

        if let Some(data_str) = trimmed.strip_prefix("data:") {
            let data_str = data_str.trim();
            if data_str == "[DONE]" {
                received_done = true;
                break;
            }
            data_count += 1;
            if let Ok(chunk) = serde_json::from_str::<Value>(data_str) {
                if let Some(err_obj) = chunk.get("error") {
                    return Err(format!("Strata API error chunk: {}", err_obj));
                }
                if let Some(choices) = chunk.get("choices").and_then(|c| c.as_array()) {
                    if let Some(first) = choices.first() {
                        if let Some(delta) = first.get("delta") {
                            if let Some(c) = delta.get("content").and_then(|v| v.as_str()) {
                                content_buf.push_str(c);
                            }
                            if let Some(r) = delta.get("reasoning_content").and_then(|v| v.as_str()) {
                                reasoning_buf.push_str(r);
                            }
                        } else if let Some(msg) = first.get("message") {
                            if let Some(c) = msg.get("content").and_then(|v| v.as_str()) {
                                content_buf.push_str(c);
                            }
                            if let Some(r) = msg.get("reasoning_content").and_then(|v| v.as_str()) {
                                reasoning_buf.push_str(r);
                            }
                        }
                    }
                }
            }
        } else if trimmed.starts_with('{') {
            data_count += 1;
            // Fallback for non-streaming JSON response
            if let Ok(res_json) = serde_json::from_str::<Value>(trimmed) {
                if let Some(err_obj) = res_json.get("error") {
                    return Err(format!("Strata API error: {}", err_obj));
                }
                if let Some(choices) = res_json.get("choices").and_then(|c| c.as_array()) {
                    if let Some(first) = choices.first() {
                        if let Some(msg) = first.get("message") {
                            if let Some(c) = msg.get("content").and_then(|v| v.as_str()) {
                                content_buf.push_str(c);
                            }
                            if let Some(r) = msg.get("reasoning_content").and_then(|v| v.as_str()) {
                                reasoning_buf.push_str(r);
                            }
                        }
                    }
                }
            }
        }
    }

    let content_trimmed = content_buf.trim();
    if !content_trimmed.is_empty() {
        Ok(content_trimmed.to_string())
    } else {
        let reasoning_trimmed = reasoning_buf.trim();
        if !reasoning_trimmed.is_empty() {
            Ok(reasoning_trimmed.to_string())
        } else {
            Err(format!(
                "Strata returned empty response stream (keepalives={}, data_chunks={}, done={})",
                keepalive_count, data_count, received_done
            ))
        }
    }
}
