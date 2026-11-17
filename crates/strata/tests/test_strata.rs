use serde_json::json;
use std::collections::HashSet;
use std::io::Write;
use tempfile::{tempdir, NamedTempFile};

use strata::guidelines::{collect_guidelines, find_workspace_root};
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
    let guidelines = vec![("AGENTS.md".to_string(), "Follow strict rules.".to_string())];
    let prompt = build_user_prompt(
        "Generate exhaustive tests",
        Some("src/calc.py"),
        &contexts,
        Some("+ def add(a, b): return a + b"),
        &guidelines,
    );

    assert!(prompt.contains("## Goal\nGenerate exhaustive tests"));
    assert!(prompt.contains("## Repository Guidelines & Standards"));
    assert!(prompt.contains("### Guideline: AGENTS.md\nFollow strict rules."));
    assert!(prompt.contains("## Target\nsrc/calc.py"));
    assert!(prompt.contains("## Git Diff\n```diff\n+ def add(a, b): return a + b\n```"));
    assert!(prompt.contains("## Context & References"));
    assert!(prompt.contains("### Reference 1\nContext 1 content"));
    assert!(prompt.contains("### Reference 2\nContext 2 content"));
}

#[test]
fn test_guidelines_collection_and_dedup() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();

    std::fs::write(root.join("AGENTS.md"), "# Agents Rule").unwrap();
    std::fs::write(root.join("REVIEW.md"), "# Review Criteria").unwrap();
    std::fs::create_dir_all(root.join("docs/guidelines")).unwrap();
    std::fs::write(root.join("docs/guidelines/testing.md"), "# Testing Guide").unwrap();
    std::fs::write(root.join("docs/guidelines/README.md"), "# Common Guide").unwrap();

    // Symlink CLAUDE.md -> AGENTS.md
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join("AGENTS.md"), root.join("CLAUDE.md")).unwrap();

    // Subdirectory lookup for workspace root
    let sub = root.join("src/nested");
    std::fs::create_dir_all(&sub).unwrap();
    assert_eq!(find_workspace_root(&sub).as_deref(), Some(root));

    // test-gen should load CLAUDE.md/AGENTS.md (deduped to 1), REVIEW.md, testing.md, README.md
    let collected = collect_guidelines(root, "test-gen", &[]);
    let names: Vec<&str> = collected.iter().map(|(n, _)| n.as_str()).collect();
    assert!(names.contains(&"REVIEW.md"));
    assert!(names.contains(&"docs/guidelines/testing.md"));
    assert!(names.contains(&"docs/guidelines/README.md"));
    // Deduplication check: CLAUDE.md and AGENTS.md resolve to same canonical file, so only 1 should appear
    let agent_count = names.iter().filter(|&&n| n == "CLAUDE.md" || n == "AGENTS.md").count();
    assert_eq!(agent_count, 1);
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
