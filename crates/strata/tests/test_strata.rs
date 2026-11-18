use serde_json::json;
use std::collections::HashSet;
use std::io::Write;
use tempfile::{tempdir, NamedTempFile};

use strata::client::read_sse_stream;
use strata::context::{
    distill_context_with, estimate_tokens, minify_json_in_text, split_into_chunks,
};
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

#[test]
fn test_read_sse_stream() {
    use std::io::BufReader;

    let sse_data = r#"data: {"choices":[{"delta":{"role":"assistant","content":""}}]}

: keep-alive

data: {"choices":[{"delta":{"reasoning_content":"Thinking..."}}]}

data: {"choices":[{"delta":{"content":"Hello "}}]}

data: {"choices":[{"delta":{"content":"World!"}}]}

data: [DONE]
"#;
    let res = read_sse_stream(BufReader::new(sse_data.as_bytes())).unwrap();
    assert_eq!(res, "Hello World!");

    let reasoning_only = r#": keep-alive
data: {"choices":[{"delta":{"reasoning_content":"Only "}}]}
data: {"choices":[{"delta":{"reasoning_content":"reasoning"}}]}
data: [DONE]
"#;
    let res2 = read_sse_stream(BufReader::new(reasoning_only.as_bytes())).unwrap();
    assert_eq!(res2, "Only reasoning");
}

#[test]
fn test_minify_json_in_text() {
    // 1. Full pretty JSON
    let pretty = "{\n  \"name\": \"strata\",\n  \"items\": [\n    1,\n    2,\n    3\n  ]\n}";
    let min = minify_json_in_text(pretty);
    assert_eq!(min, r#"{"items":[1,2,3],"name":"strata"}"#);

    // 2. Markdown with fenced json block and normal code
    let md = "Intro text\nFile: config.json\n```\n{\n  \"a\": true,\n  \"b\": 123\n}\n```\n```python\nx = 1\n```";
    let md_min = minify_json_in_text(md);
    assert!(md_min.contains(r#"{"a":true,"b":123}"#));
    assert!(md_min.contains("x = 1"));

    // 3. Invalid JSON stays untouched
    let invalid = "```json\n{broken: true\n```";
    assert_eq!(minify_json_in_text(invalid), invalid);
}

#[test]
fn test_estimate_tokens() {
    // 12 ASCII chars -> ceil(12/4) = 3
    assert_eq!(estimate_tokens("123456789012"), 3);
    // 4 Japanese chars -> 4
    assert_eq!(estimate_tokens("あいうえ"), 4);
    // Mixed: 4 ASCII (1) + 3 Japanese (3) = 4
    assert_eq!(estimate_tokens("abcdあいう"), 1 + 3);
}

#[test]
fn test_semantic_chunking_preserves_functions() {
    let fn_a = "/// Doc for A\npub fn alpha() {\n    let a1 = 1;\n    let a2 = 2;\n    let a3 = 3;\n    let a4 = 4;\n    let a5 = 5;\n}";
    let fn_b = "/// Doc for B\npub fn beta() {\n    let b1 = 10;\n    let b2 = 20;\n    let b3 = 30;\n    let b4 = 40;\n    let b5 = 50;\n}";
    let fn_c = "/// Doc for C\npub fn gamma() {\n    let c1 = 100;\n    let c2 = 200;\n    let c3 = 300;\n    let c4 = 400;\n    let c5 = 500;\n}";

    let code = format!("{}\n\n{}\n\n{}", fn_a, fn_b, fn_c);
    // Budget 64 tokens -> each function (~35 tokens) stays completely intact in its own chunk
    let chunks = split_into_chunks(&code, 64);
    assert!(chunks.len() >= 2);
    // Verify alpha, beta, gamma are each wholly contained within a single chunk (never split mid-function)
    assert!(chunks.iter().any(|c| c.contains("/// Doc for A") && c.contains("let a5 = 5;")));
    assert!(chunks.iter().any(|c| c.contains("/// Doc for B") && c.contains("let b5 = 50;")));
    assert!(chunks.iter().any(|c| c.contains("/// Doc for C") && c.contains("let c5 = 500;")));
}

#[test]
fn test_split_into_chunks() {
    let mut lines = Vec::new();
    for i in 0..100 {
        lines.push(format!("line_{}: some_identifier_value_0123456789_abcdef", i));
    }
    let big_text = lines.join("\n");
    let chunks = split_into_chunks(&big_text, 200);
    assert!(chunks.len() >= 3);
    for c in &chunks {
        assert!(estimate_tokens(c) <= 200, "chunk exceeded budget: {}", estimate_tokens(c));
    }

    // Oversized single line (e.g. minified JSON)
    let single_line = "a".repeat(1500);
    let single_chunks = split_into_chunks(&single_line, 200);
    assert!(single_chunks.len() >= 2);
    for c in &single_chunks {
        assert!(estimate_tokens(c) <= 200);
    }
}

#[test]
fn test_map_reduce_distillation_mock() {
    // Below threshold: should NOT call distill closure
    let mut calls = 0usize;
    let (res_small, did_distill) = distill_context_with(
        "Review",
        "small context",
        500,
        200,
        |_sys, _usr| {
            calls += 1;
            Ok("distilled".to_string())
        },
    )
    .unwrap();
    assert!(!did_distill);
    assert_eq!(calls, 0);
    assert_eq!(res_small, "small context");

    // Above threshold: should trigger Map (and Reduce if needed)
    let big_ctx = (0..80)
        .map(|i| format!("function item_{}() {{ return {}; }}", i, i))
        .collect::<Vec<_>>()
        .join("\n");
    let mut map_calls = 0usize;
    let (res_big, did_distill_big) = distill_context_with(
        "Review",
        &big_ctx,
        300,
        200,
        |sys, usr| {
            map_calls += 1;
            assert!(usr.contains("## Goal\nReview"));
            if sys.contains("synthesizer") {
                Ok("- merged concise note".to_string())
            } else {
                Ok("- distilled bullet".to_string())
            }
        },
    )
    .unwrap();
    assert!(did_distill_big);
    assert!(map_calls >= 2);
    assert!(estimate_tokens(&res_big) <= 300);
}
