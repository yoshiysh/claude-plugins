use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::path::Path;

use crate::client::call_strata_api;
use crate::guidelines::{collect_guidelines, resolve_workspace_root};
use crate::personas::{build_user_prompt, find_persona};
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
        }
    ])
}

fn handle_generate(args: &Value) -> Result<String, String> {
    let role = args.get("role").and_then(|r| r.as_str()).unwrap_or("code-gen");
    let goal = args.get("goal").and_then(|g| g.as_str()).unwrap_or("");
    let target = args.get("target").and_then(|t| t.as_str());
    let context_str = args.get("context").and_then(|c| c.as_str());
    let output_path = args.get("output_path").and_then(|o| o.as_str());
    let workspace_root = args.get("workspace_root").and_then(|w| w.as_str());
    let use_guidelines = args
        .get("use_guidelines")
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
    let user_prompt = build_user_prompt(
        goal,
        target_formatted.as_deref(),
        &contexts,
        None,
        &guidelines,
    );
    let persona = find_persona(role).ok_or_else(|| format!("Unknown role: {}", role))?;

    let api_key = resolve_api_key(None);
    let api_base = std::env::var("STRATA_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:8080/v1".to_string());
    let model = std::env::var("STRATA_MODEL").unwrap_or_else(|_| "qwen3.8-flash-next-iq2_xs".to_string());

    let raw_output = call_strata_api(
        &api_base,
        &api_key,
        &model,
        persona.system_prompt,
        &user_prompt,
        persona.temperature,
        max_tokens,
        reasoning_effort,
    )?;

    let clean_output = clean_markdown_fences(&raw_output);

    if let Some(out_path) = output_path {
        let p = Path::new(out_path);
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(p, &clean_output).map_err(|e| format!("Failed to write to {}: {}", out_path, e))?;

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
    let role = args.get("role").and_then(|r| r.as_str()).unwrap_or("code-review");
    let goal = args.get("goal").and_then(|g| g.as_str()).unwrap_or("");
    let target = args.get("target").and_then(|t| t.as_str());
    let context_str = args.get("context").and_then(|c| c.as_str());
    let diff = args.get("diff").and_then(|d| d.as_str());
    let workspace_root = args.get("workspace_root").and_then(|w| w.as_str());
    let use_guidelines = args
        .get("use_guidelines")
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
    let user_prompt = build_user_prompt(
        goal,
        target_formatted.as_deref(),
        &contexts,
        diff,
        &guidelines,
    );
    let persona = find_persona(role).ok_or_else(|| format!("Unknown role: {}", role))?;

    let api_key = resolve_api_key(None);
    let api_base = std::env::var("STRATA_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:8080/v1".to_string());
    let model = std::env::var("STRATA_MODEL").unwrap_or_else(|_| "qwen3.8-flash-next-iq2_xs".to_string());

    let raw_output = call_strata_api(
        &api_base,
        &api_key,
        &model,
        persona.system_prompt,
        &user_prompt,
        persona.temperature,
        max_tokens,
        reasoning_effort,
    )?;

    Ok(raw_output.trim().to_string())
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
                _ => {
                    return Some(json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {
                            "code": -32601,
                            "message": format!("Unknown tool: {}", tool_name)
                        }
                    }))
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
