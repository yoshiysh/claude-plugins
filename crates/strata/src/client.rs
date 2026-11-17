use serde_json::{json, Value};
use std::time::Duration;

pub fn ensure_model_loaded(api_base: &str, api_key: &str) {
    let clean_base = api_base.trim_end_matches('/');
    let models_url = format!("{}/models", clean_base);

    // 1. Check if model is already loaded
    let mut check_req = ureq::get(&models_url).timeout(Duration::from_secs(5));
    if !api_key.is_empty() {
        check_req = check_req.set("Authorization", &format!("Bearer {}", api_key));
    }

    if let Ok(resp) = check_req.call() {
        if let Ok(val) = resp.into_json::<Value>() {
            if let Some(data) = val.get("data").and_then(|d| d.as_array()) {
                let is_loaded = data.iter().any(|m| {
                    m.get("status")
                        .and_then(|s| s.get("value"))
                        .and_then(|v| v.as_str())
                        == Some("loaded")
                });
                if is_loaded {
                    return;
                }
            }
        }
    }

    // 2. Trigger /load
    eprintln!("[Strata Worker] Model is unloaded; sending /load request...");
    let base_host = clean_base.split("/v1").next().unwrap_or(clean_base);
    let load_endpoint = format!("{}/load", base_host);

    let mut load_req = ureq::post(&load_endpoint)
        .timeout(Duration::from_secs(60))
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
        let mut poll_req = ureq::get(&models_url).timeout(Duration::from_secs(5));
        if !api_key.is_empty() {
            poll_req = poll_req.set("Authorization", &format!("Bearer {}", api_key));
        }

        if let Ok(resp) = poll_req.call() {
            if let Ok(val) = resp.into_json::<Value>() {
                if let Some(data) = val.get("data").and_then(|d| d.as_array()) {
                    let is_loaded = data.iter().any(|m| {
                        m.get("status")
                            .and_then(|s| s.get("value"))
                            .and_then(|v| v.as_str())
                            == Some("loaded")
                    });
                    if is_loaded {
                        eprintln!("[Strata Worker] Model successfully loaded.");
                        return;
                    }
                }
            }
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
) -> Result<String, String> {
    ensure_model_loaded(api_base, api_key);

    let clean_base = api_base.trim_end_matches('/');
    let url = format!("{}/chat/completions", clean_base);

    let payload = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    });

    let mut retries = 0;
    let resp = loop {
        let mut req = ureq::post(&url)
            .timeout(Duration::from_secs(1800))
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
                    "Failed to connect to Strata at {}: {}\nEnsure the Strata server is running (e.g. tools/claude-strata --start-server).",
                    url, e
                ));
            }
        }
    };

    let res_json: Value = resp
        .into_json()
        .map_err(|e| format!("Failed to parse response JSON: {}", e))?;

    let choices = res_json
        .get("choices")
        .and_then(|c| c.as_array())
        .ok_or_else(|| "Strata returned empty or invalid choices".to_string())?;

    if choices.is_empty() {
        return Err("Strata returned empty choices array".to_string());
    }

    let message = choices[0]
        .get("message")
        .ok_or_else(|| "Missing message object in choice".to_string())?;

    let content = message
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim();

    let reasoning = message
        .get("reasoning_content")
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .trim();

    if !content.is_empty() {
        Ok(content.to_string())
    } else if !reasoning.is_empty() {
        Ok(reasoning.to_string())
    } else {
        Ok(String::new())
    }
}
