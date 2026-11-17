use serde_json::json;
use std::collections::HashSet;
use std::io::Write;
use tempfile::NamedTempFile;

use strata::mcp::{get_tools, handle_rpc};
use strata::personas::{build_user_prompt, PERSONAS};
use strata::syntax::verify_syntax;
use strata::utils::clean_markdown_fences;

#[test]
fn test_personas_structure() {
    let roles: HashSet<&str> = PERSONAS.iter().map(|p| p.name).collect();
    let expected: HashSet<&str> = [
        "test-gen",
        "test-review",
        "code-gen",
        "code-review",
        "doc-gen",
        "doc-review",
    ]
    .into_iter()
    .collect();

    assert_eq!(roles, expected);

    for p in PERSONAS {
        assert!(!p.system_prompt.trim().is_empty());
        assert!(p.temperature > 0.0 && p.temperature <= 1.0);
    }
}

#[test]
fn test_clean_markdown_fences() {
    let fenced = "```python\ndef hello():\n    return 'world'\n```";
    assert_eq!(clean_markdown_fences(fenced), "def hello():\n    return 'world'");

    let unfenced = "def hello():\n    return 'world'";
    assert_eq!(clean_markdown_fences(unfenced), unfenced);
}

#[test]
fn test_build_user_prompt() {
    let contexts = vec!["Context 1 content".to_string(), "Context 2 content".to_string()];
    let prompt = build_user_prompt(
        "Generate exhaustive tests",
        Some("src/calc.py"),
        &contexts,
        Some("+ def add(a, b): return a + b"),
    );

    assert!(prompt.contains("## Goal\nGenerate exhaustive tests"));
    assert!(prompt.contains("## Target\nsrc/calc.py"));
    assert!(prompt.contains("## Git Diff\n```diff\n+ def add(a, b): return a + b\n```"));
    assert!(prompt.contains("## Context & References"));
    assert!(prompt.contains("### Reference 1\nContext 1 content"));
    assert!(prompt.contains("### Reference 2\nContext 2 content"));
}

#[test]
fn test_verify_syntax() {
    // Valid python
    let mut valid_py = NamedTempFile::with_suffix(".py").unwrap();
    writeln!(valid_py, "x = 42\nprint(x)").unwrap();
    let (ok, msg) = verify_syntax(valid_py.path());
    assert!(ok, "valid_py syntax check failed: {}", msg);

    // Invalid python
    let mut invalid_py = NamedTempFile::with_suffix(".py").unwrap();
    writeln!(invalid_py, "def broken_syntax(").unwrap();
    let (ok, err) = verify_syntax(invalid_py.path());
    assert!(!ok);
    assert!(err.contains("Syntax error"));

    // Valid json
    let mut valid_json = NamedTempFile::with_suffix(".json").unwrap();
    writeln!(valid_json, r#"{{"key": "value"}}"#).unwrap();
    let (ok, _) = verify_syntax(valid_json.path());
    assert!(ok);

    // Invalid json
    let mut invalid_json = NamedTempFile::with_suffix(".json").unwrap();
    writeln!(invalid_json, r#"{{"key": broken}}"#).unwrap();
    let (ok, _) = verify_syntax(invalid_json.path());
    assert!(!ok);
}

#[test]
fn test_mcp_initialize_and_tools_list() {
    // 1. initialize
    let init_req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {}
    });
    let init_resp = handle_rpc(&init_req).expect("should return response");
    assert_eq!(init_resp["id"], 1);
    assert_eq!(init_resp["result"]["protocolVersion"], "2024-11-05");
    assert_eq!(init_resp["result"]["serverInfo"]["name"], "strata-mcp");

    // 2. tools/list
    let list_req = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    });
    let list_resp = handle_rpc(&list_req).expect("should return response");
    assert_eq!(list_resp["id"], 2);
    let tools = list_resp["result"]["tools"].as_array().expect("tools array");
    let tool_names: HashSet<&str> = tools
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    let expected_tools: HashSet<&str> = ["strata_generate", "strata_review"].into_iter().collect();
    assert_eq!(tool_names, expected_tools);

    // 3. get_tools schema check
    let direct_tools = get_tools();
    assert!(direct_tools.as_array().unwrap().len() >= 2);
}
