use crate::personas::build_user_prompt;
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
use std::path::Path;

use crate::context::execute_optimized;
use crate::diagnose::{DiagnoseOptions, HealthOptions, run_diagnose, run_health};
use crate::guidelines::{collect_guidelines, resolve_workspace_root};
use crate::personas::find_persona;
use crate::syntax::verify_syntax;
use crate::utils::{clean_markdown_fences, format_target, resolve_api_key};

pub fn get_tools() -> Value {
    json!([
        {
            "name": "strata_generate",
            "description": "Generate tests, implementation code, or documentation using high-speed local Strata models. Zero cloud API cost, clean syntax validation.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "role": {
                        "type": "string",
                        "enum": ["test-gen", "code-gen", "doc-gen"],
                        "description": "Specialized generation persona to activate."
                    },
                    "goal": {
                        "type": "string",
                        "description": "Specific goal and acceptance criteria for generation."
                    },
                    "target": {
                        "type": "string",
                        "description": "Target file path or symbol name."
                    },
                    "context": {
                        "type": "string",
                        "description": "Relevant context (reference files, types, API contracts)."
                    },
                    "output_path": {
                        "type": "string",
                        "description": "Optional destination file path to write and syntax-verify the output."
                    },
                    "workspace_root": {
                        "type": "string",
                        "description": "Optional workspace root directory for discovering CLAUDE.md/REVIEW.md guidelines."
                    },
                    "use_guidelines": {
                        "type": "boolean",
                        "description": "Whether to auto-load repository guidelines (default: true)."
                    },
                    "optimize": {
                        "type": "boolean",
                        "description": "Whether to auto-minify JSON and run Map-Reduce context distillation when exceeding budget (default: true)."
                    },
                    "max_tokens": {
                        "type": "integer",
                        "description": "Maximum output tokens (default: 4096)."
                    },
                    "reasoning_effort": {
                        "type": "string",
                        "enum": ["low", "medium", "high"],
                        "description": "Optional reasoning effort level for thinking models (low, medium, high)."
                    }
                },
                "required": ["role", "goal"]
            }
        },
        {
            "name": "strata_review",
            "description": "Run ruthless adversarial review on tests, code, or documentation using local Strata auditor. Focuses strictly on bugs, leaks, race conditions, weak mocks, and semantic drift. Compliments forbidden.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "role": {
                        "type": "string",
                        "enum": ["test-review", "code-review", "doc-review"],
                        "description": "Adversarial review lens to apply."
                    },
                    "goal": {
                        "type": "string",
                        "description": "Verification criteria or high-risk areas to scrutinize."
                    },
                    "target": {
                        "type": "string",
                        "description": "Target file or component under audit."
                    },
                    "context": {
                        "type": "string",
                        "description": "Relevant reference implementation, contract, or specifications."
                    },
                    "diff": {
                        "type": "string",
                        "description": "Optional git diff or proposed code changes to review."
                    },
                    "workspace_root": {
                        "type": "string",
                        "description": "Optional workspace root directory for discovering CLAUDE.md/REVIEW.md guidelines."
                    },
                    "use_guidelines": {
                        "type": "boolean",
                        "description": "Whether to auto-load repository guidelines (default: true)."
                    },
                    "optimize": {
                        "type": "boolean",
                        "description": "Whether to auto-minify JSON and run Map-Reduce context distillation when exceeding budget (default: true)."
                    },
                    "max_tokens": {
                        "type": "integer",
                        "description": "Maximum output tokens (default: 4096)."
                    },
                    "reasoning_effort": {
                        "type": "string",
                        "enum": ["low", "medium", "high"],
                        "description": "Optional reasoning effort level for thinking models (low, medium, high)."
                    }
                },
                "required": ["role", "goal"]
            }
        },
        {
            "name": "strata_diagnose",
            "description": "Self-diagnose Strata API health, SSH tunnel, engine/server logs, OOM/SIGKILL causes, and WSL2 settings (ROTA, swappiness, Linger). Works even when Strata itself is stopped or unreachable.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "host": {
                        "type": "string",
                        "description": "SSH host running Strata WSL2 (default: STRATA_HOST env or 'winbox'; use 'local' for current host)."
                    },
                    "include_logs": {
                        "type": "boolean",
                        "description": "Include recent server/engine log tails (default: true)."
                    },
                    "ai_analyze": {
                        "type": "boolean",
                        "description": "Also run AI log analysis if Strata model is currently loaded (default: false)."
                    }
                }
            }
        },
        {
            "name": "strata_health",
            "description": "Fast preflight health check (<0.1s) verifying Strata API reachability, model load status, and timeout settings before sending requests. Set warmup=true to run a minimal 1-token inference and measure latency (auto-loads model if unloaded, taking tens of seconds).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "warmup": {
                        "type": "boolean",
                        "description": "Run a minimal 1-token inference to measure latency; auto-loads model if unloaded (default: false)."
                    },
                    "strict": {
                        "type": "boolean",
                        "description": "Treat degraded state (unloaded model or non-zero timeout settings) as an error (default: false)."
                    }
                }
            }
        }
    ])
}

fn resolve_mcp_api_base() -> String {
    std::env::var("STRATA_BASE_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:8080/v1".to_string())
}

fn anthropic_base_url(api_base: &str) -> String {
    let trimmed = api_base.trim().trim_end_matches('/');
    trimmed.strip_suffix("/v1").unwrap_or(trimmed).to_string()
}

#[allow(clippy::too_many_arguments)]
fn try_execute_claude_p(
    api_base: &str,
    api_key: &str,
    persona: &crate::personas::Persona,
    goal: &str,
    target_formatted: Option<&str>,
    contexts: &[String],
    diff: Option<&str>,
    guidelines: &[(String, String)],
    workspace_root: Option<&str>,
) -> Option<Result<String, String>> {
    if std::env::var("STRATA_MCP_BACKEND").ok().as_deref() == Some("direct") {
        return None;
    }
    let claude_bin = std::env::var("STRATA_CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string());
    let claude_model =
        std::env::var("STRATA_CLAUDE_MODEL").unwrap_or_else(|_| "sonnet".to_string());
    let perm_mode = std::env::var("STRATA_CLAUDE_PERMISSION_MODE")
        .unwrap_or_else(|_| "acceptEdits".to_string());
    let user_prompt = build_user_prompt(goal, target_formatted, contexts, diff, guidelines);

    let mut cmd = std::process::Command::new(&claude_bin);
    cmd.arg("-p")
        .arg(&user_prompt)
        .arg("--system-prompt")
        .arg(persona.system_prompt)
        .arg("--model")
        .arg(&claude_model)
        .arg("--bare")
        .arg("--setting-sources")
        .arg("user")
        .arg("--permission-mode")
        .arg(&perm_mode)
        .arg("--output-format")
        .arg("text")
        .env("ANTHROPIC_BASE_URL", anthropic_base_url(api_base))
        .env_remove("CLAUDECODE");

    if !api_key.is_empty() {
        cmd.env("ANTHROPIC_AUTH_TOKEN", api_key)
            .env("ANTHROPIC_API_KEY", api_key);
    }
    if let Some(ws) = workspace_root {
        let p = Path::new(ws);
        if p.is_dir() {
            cmd.current_dir(p);
        }
    }

    match cmd.output() {
        Ok(out) if out.status.success() => {
            Some(Ok(String::from_utf8_lossy(&out.stdout).into_owned()))
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            Some(Err(format!(
                "claude -p exited with {}: {}",
                out.status,
                stderr.trim()
            )))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => Some(Err(format!("failed to execute claude -p: {}", e))),
    }
}

#[allow(clippy::too_many_arguments)]
fn execute_mcp_worker(
    api_base: &str,
    api_key: &str,
    model: &str,
    persona: &crate::personas::Persona,
    goal: &str,
    target_formatted: Option<&str>,
    contexts: &[String],
    diff: Option<&str>,
    guidelines: &[(String, String)],
    workspace_root: Option<&str>,
    max_tokens: u32,
    reasoning_effort: Option<&str>,
    optimize: bool,
) -> Result<String, String> {
    if let Some(res) = try_execute_claude_p(
        api_base,
        api_key,
        persona,
        goal,
        target_formatted,
        contexts,
        diff,
        guidelines,
        workspace_root,
    ) {
        return res;
    }

    execute_optimized(
        api_base,
        api_key,
        model,
        persona,
        goal,
        target_formatted,
        contexts,
        diff,
        guidelines,
        persona.temperature,
        max_tokens,
        reasoning_effort,
        optimize,
    )
}

fn handle_generate(args: &Value) -> Result<String, String> {
    let role = args
        .get("role")
        .and_then(|r| r.as_str())
        .unwrap_or("code-gen");
    let goal = args.get("goal").and_then(|g| g.as_str()).unwrap_or("");
    let target = args.get("target").and_then(|t| t.as_str());
    let context_str = args.get("context").and_then(|c| c.as_str());
    let output_path = args.get("output_path").and_then(|o| o.as_str());
    let workspace_root = args.get("workspace_root").and_then(|w| w.as_str());
    let use_guidelines = args
        .get("use_guidelines")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let optimize = args
        .get("optimize")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let max_tokens = args
        .get("max_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(4096) as u32;
    let reasoning_effort = args.get("reasoning_effort").and_then(|v| v.as_str());

    let mut contexts = Vec::new();
    if let Some(c) = context_str {
        contexts.push(c.to_string());
    }

    let guidelines = if use_guidelines {
        if let Some(root) = resolve_workspace_root(workspace_root, target.or(output_path)) {
            collect_guidelines(&root, role, &[])
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    let target_formatted = format_target(target);
    let persona = find_persona(role).ok_or_else(|| format!("Unknown role: {}", role))?;

    let api_key = resolve_api_key(None);
    let api_base = resolve_mcp_api_base();
    let model =
        std::env::var("STRATA_MODEL").unwrap_or_else(|_| "qwen3.8-flash-next-iq2_xs".to_string());

    let raw_output = execute_mcp_worker(
        &api_base,
        &api_key,
        &model,
        persona,
        goal,
        target_formatted.as_deref(),
        &contexts,
        None,
        &guidelines,
        workspace_root,
        max_tokens,
        reasoning_effort,
        optimize,
    )?;

    let clean_output = clean_markdown_fences(&raw_output);

    if let Some(out_path) = output_path {
        let p = Path::new(out_path);
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(p, &clean_output)
            .map_err(|e| format!("Failed to write to {}: {}", out_path, e))?;

        let (valid, msg) = verify_syntax(p);
        let status_msg = if valid {
            format!("✓ Saved to {} ({})", out_path, msg)
        } else {
            format!("⚠ Saved to {} with syntax warning: {}", out_path, msg)
        };
        Ok(format!("{}\n\n```\n{}\n```", status_msg, clean_output))
    } else {
        Ok(clean_output)
    }
}

fn handle_review(args: &Value) -> Result<String, String> {
    let role = args
        .get("role")
        .and_then(|r| r.as_str())
        .unwrap_or("code-review");
    let goal = args.get("goal").and_then(|g| g.as_str()).unwrap_or("");
    let target = args.get("target").and_then(|t| t.as_str());
    let context_str = args.get("context").and_then(|c| c.as_str());
    let diff = args.get("diff").and_then(|d| d.as_str());
    let workspace_root = args.get("workspace_root").and_then(|w| w.as_str());
    let use_guidelines = args
        .get("use_guidelines")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let optimize = args
        .get("optimize")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let max_tokens = args
        .get("max_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(4096) as u32;
    let reasoning_effort = args.get("reasoning_effort").and_then(|v| v.as_str());

    let mut contexts = Vec::new();
    if let Some(c) = context_str {
        contexts.push(c.to_string());
    }

    let guidelines = if use_guidelines {
        if let Some(root) = resolve_workspace_root(workspace_root, target) {
            collect_guidelines(&root, role, &[])
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    let target_formatted = format_target(target);
    let persona = find_persona(role).ok_or_else(|| format!("Unknown role: {}", role))?;

    let api_key = resolve_api_key(None);
    let api_base = resolve_mcp_api_base();
    let model =
        std::env::var("STRATA_MODEL").unwrap_or_else(|_| "qwen3.8-flash-next-iq2_xs".to_string());

    let raw_output = execute_mcp_worker(
        &api_base,
        &api_key,
        &model,
        persona,
        goal,
        target_formatted.as_deref(),
        &contexts,
        diff,
        &guidelines,
        workspace_root,
        max_tokens,
        reasoning_effort,
        optimize,
    )?;

    Ok(raw_output.trim().to_string())
}

fn handle_diagnose(args: &Value) -> Result<String, String> {
    let default_host = std::env::var("STRATA_HOST").unwrap_or_else(|_| "winbox".to_string());
    let host = args
        .get("host")
        .and_then(|v| v.as_str())
        .unwrap_or(&default_host);
    let include_logs = args
        .get("include_logs")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let ai_analyze = args
        .get("ai_analyze")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let api_key = resolve_api_key(None);
    let api_base =
        std::env::var("STRATA_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:8080/v1".to_string());
    let model =
        std::env::var("STRATA_MODEL").unwrap_or_else(|_| "qwen3.8-flash-next-iq2_xs".to_string());

    let opts = DiagnoseOptions {
        api_base: &api_base,
        api_key: &api_key,
        model: &model,
        host,
        include_logs,
        ai_analyze,
        json_output: false,
    };

    run_diagnose(&opts)
}

fn handle_health(args: &Value) -> Result<String, String> {
    let warmup = args
        .get("warmup")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let strict = args
        .get("strict")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let api_key = resolve_api_key(None);
    let api_base =
        std::env::var("STRATA_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:8080/v1".to_string());
    let model =
        std::env::var("STRATA_MODEL").unwrap_or_else(|_| "qwen3.8-flash-next-iq2_xs".to_string());

    let opts = HealthOptions {
        api_base: &api_base,
        api_key: &api_key,
        model: &model,
        warmup,
        strict,
        json_output: false,
    };

    let (_report, text, exit_code) = run_health(&opts)?;
    if exit_code != 0 {
        return Err(text);
    }
    Ok(text)
}

pub fn handle_rpc(request: &Value) -> Option<Value> {
    let req_id = request.get("id").cloned();
    let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");

    match method {
        "initialize" => Some(json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "strata-mcp",
                    "version": "1.0.0"
                }
            }
        })),
        "notifications/initialized" => None,
        "ping" => Some(json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {}
        })),
        "tools/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "tools": get_tools()
            }
        })),
        "tools/call" => {
            let params = request.get("params").cloned().unwrap_or(json!({}));
            let tool_name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let arguments = params.get("arguments").cloned().unwrap_or(json!({}));

            let result = match tool_name {
                "strata_generate" => handle_generate(&arguments),
                "strata_review" => handle_review(&arguments),
                "strata_diagnose" => handle_diagnose(&arguments),
                "strata_health" => handle_health(&arguments),
                _ => {
                    return Some(json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {
                            "code": -32601,
                            "message": format!("Unknown tool: {}", tool_name)
                        }
                    }));
                }
            };

            match result {
                Ok(text) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [
                            {
                                "type": "text",
                                "text": text
                            }
                        ]
                    }
                })),
                Err(err) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "isError": true,
                        "content": [
                            {
                                "type": "text",
                                "text": format!("Strata Worker Error: {}", err)
                            }
                        ]
                    }
                })),
            }
        }
        _ => Some(json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {
                "code": -32601,
                "message": format!("Method not found: {}", method)
            }
        })),
    }
}

pub fn run_mcp_server() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if let Ok(req) = serde_json::from_str::<Value>(trimmed) {
            if let Some(resp) = handle_rpc(&req) {
                let s = serde_json::to_string(&resp)?;
                writeln!(stdout, "{}", s)?;
                stdout.flush()?;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_anthropic_base_url_strips_v1_suffix() {
        assert_eq!(
            anthropic_base_url("http://desktop-bc0ci5m.local:8080/v1"),
            "http://desktop-bc0ci5m.local:8080"
        );
        assert_eq!(
            anthropic_base_url("http://127.0.0.1:8080/v1/"),
            "http://127.0.0.1:8080"
        );
        assert_eq!(
            anthropic_base_url("http://127.0.0.1:8080"),
            "http://127.0.0.1:8080"
        );
    }
}
