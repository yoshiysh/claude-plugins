//! テストの補助。実行体を黒箱として起動し、出力を schema の `$defs` と照らす（DD-10）。
//! lib の API は仕様に無いので呼ばない。
// 整形は各テストの `#[rustfmt::skip] mod common;` で外す（cargo の無い環境で手で書いたため）。
#![allow(dead_code)]

use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

pub const BIN: &str = env!("CARGO_BIN_EXE_formal-method-core");
pub const SCHEMA_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../skills/formal-method/references/core.schema.json"
);
pub const MANIFEST_DIR: &str = env!("CARGO_MANIFEST_DIR");

pub const SUBCOMMANDS: [&str; 8] = [
    "partition-models",
    "plan-skeleton",
    "partition-assemble",
    "mapping-rows",
    "extract-skeleton",
    "omission-candidates",
    "review-tally",
    "complete-return",
];

pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
}

pub fn run(args: &[&str], stdin: &str) -> Output {
    run_env(args, stdin, &[])
}

pub fn run_env(args: &[&str], stdin: &str, envs: &[(&str, &str)]) -> Output {
    let mut cmd = Command::new(BIN);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().expect("実行体を起動できる");
    {
        let mut si = child.stdin.take().expect("stdin");
        // 実行体が先に終わると書き込みが失敗しうるので、誤りは無視する
        let _ = si.write_all(stdin.as_bytes());
    }
    let out = child.wait_with_output().expect("実行体の終わりを待てる");
    Output {
        stdout: String::from_utf8(out.stdout).expect("stdout は UTF-8"),
        stderr: String::from_utf8(out.stderr).expect("stderr は UTF-8"),
        code: out.status.code(),
    }
}

/// サブコマンドを呼び、exit 0・stdout が末尾に改行を持つ 1 行の JSON であることを確かめて返す。
pub fn call(sub: &str, input: &Value) -> Value {
    let out = run(&[sub], &input.to_string());
    assert_eq!(out.code, Some(0), "{sub} の exit: stderr={}", out.stderr);
    assert!(out.stdout.ends_with('\n'), "{sub} の stdout は改行で終わる");
    let body = &out.stdout[..out.stdout.len() - 1];
    assert!(!body.contains('\n'), "{sub} の stdout は 1 行");
    serde_json::from_str(body).expect("stdout は JSON")
}

/// 同じ入力を 2 回流して、標準出力のバイト列が一致することを確かめる（SP-264-005）。
pub fn assert_deterministic(sub: &str, input: &Value) {
    let text = input.to_string();
    let a = run(&[sub], &text);
    let b = run(&[sub], &text);
    assert_eq!(a.code, Some(0), "{sub}: {}", a.stderr);
    assert_eq!(a.stdout, b.stdout, "{sub} の出力は入力だけで決まる");
}

/// 入力の誤り: exit 2・stdout は空・stderr に理由の 1 行（SP-264-005）。
pub fn assert_input_error(sub: &str, stdin: &str) {
    let out = run(&[sub], stdin);
    assert_eq!(out.code, Some(2), "{sub} は入力 {stdin} を拒む");
    assert_eq!(out.stdout, "", "{sub} は誤りのとき stdout に何も出さない");
    let msg = out.stderr.trim_end_matches('\n');
    assert!(!msg.is_empty(), "{sub} は理由を stderr に出す");
    assert!(!msg.contains('\n'), "{sub} の理由は 1 行: {msg}");
}

pub fn assert_input_error_value(sub: &str, input: &Value) {
    assert_input_error(sub, &input.to_string());
}

pub fn schema() -> Value {
    let text = std::fs::read_to_string(SCHEMA_PATH).expect("core.schema.json を読める");
    serde_json::from_str(&text).expect("core.schema.json は JSON")
}

/// `x-core.roles.<name>.value`。実行体が選ぶ値を、テストも同じ名前で引く。
pub fn role(name: &str) -> String {
    schema()["x-core"]["roles"][name]["value"]
        .as_str()
        .unwrap_or_else(|| panic!("x-core.roles.{name}.value が無い"))
        .to_string()
}

pub fn text(name: &str) -> String {
    schema()["x-core"]["texts"][name]
        .as_str()
        .unwrap_or_else(|| panic!("x-core.texts.{name} が無い"))
        .to_string()
}

static SEQ: AtomicUsize = AtomicUsize::new(0);

/// 一時ファイルの path（pid と連番で重ならない）。
pub fn temp_path(name: &str) -> std::path::PathBuf {
    let n = SEQ.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!("fm-core-test-{}-{n}-{name}", std::process::id()))
}

/// 値が `$defs/<def_name>` に合うこと（required が全てあり、properties に無い欄が無い）。
pub fn assert_conforms(value: &Value, def_name: &str) {
    let s = schema();
    let node = &s["$defs"][def_name];
    assert!(node.is_object(), "$defs/{def_name} が無い");
    if let Err(e) = check(&s, node, value, def_name) {
        panic!("{def_name} に合わない: {e}\n値: {value}");
    }
}

fn resolve<'a>(root: &'a Value, node: &'a Value) -> &'a Value {
    let mut cur = node;
    while let Some(r) = cur.get("$ref").and_then(Value::as_str) {
        let name = r
            .strip_prefix("#/$defs/")
            .unwrap_or_else(|| panic!("未対応の $ref {r}"));
        cur = &root["$defs"][name];
    }
    cur
}

fn type_allows_null(node: &Value) -> bool {
    match node.get("type") {
        Some(Value::String(t)) => t == "null",
        Some(Value::Array(ts)) => ts.iter().any(|t| t == "null"),
        _ => false,
    }
}

fn check(root: &Value, node: &Value, value: &Value, at: &str) -> Result<(), String> {
    let node = resolve(root, node);
    for key in ["anyOf", "oneOf"] {
        if let Some(Value::Array(branches)) = node.get(key) {
            let mut errs = Vec::new();
            for b in branches {
                let b = resolve(root, b);
                if value.is_null() && type_allows_null(b) {
                    return Ok(());
                }
                match check(root, b, value, at) {
                    Ok(()) => return Ok(()),
                    Err(e) => errs.push(e),
                }
            }
            return Err(format!("{at}: どの枝にも合わない ({})", errs.join(" / ")));
        }
    }
    if value.is_null() && type_allows_null(node) {
        return Ok(());
    }
    if let (Some(Value::Object(props)), Some(obj)) = (node.get("properties"), value.as_object()) {
        if let Some(Value::Array(req)) = node.get("required") {
            for r in req {
                let r = r.as_str().unwrap_or_default();
                if !obj.contains_key(r) {
                    return Err(format!("{at}: 必須の欄 {r} が無い"));
                }
            }
        }
        for (k, v) in obj {
            match props.get(k) {
                None => return Err(format!("{at}: 未知の欄 {k}")),
                Some(p) => check(root, p, v, &format!("{at}.{k}"))?,
            }
        }
        return Ok(());
    }
    if node.get("properties").is_some() && !value.is_object() {
        return Err(format!("{at}: object でない"));
    }
    if let (Some(items), Some(arr)) = (node.get("items"), value.as_array()) {
        for (i, v) in arr.iter().enumerate() {
            check(root, items, v, &format!("{at}[{i}]"))?;
        }
    }
    Ok(())
}

/// 文字列の配列を Vec<String> にする。
pub fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap_or_else(|| panic!("配列でない: {v}"))
        .iter()
        .map(|x| x.as_str().unwrap_or_else(|| panic!("文字列でない: {x}")).to_string())
        .collect()
}
