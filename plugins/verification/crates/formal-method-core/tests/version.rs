//! SP-264-002: `--version` は `formal-method-core <版>` の 1 行を出し、版は Cargo.toml と schema で同じ。
// このテストは cargo の無い環境で手で書いた。rustfmt の形の差で `cargo fmt --check` が落ちないよう、
// ファイルの整形を外す（crate の根の inner 属性。rustfmt::skip を inner に直接書くのは安定版で使えない）。
#![cfg_attr(rustfmt, rustfmt::skip)]
#[rustfmt::skip]
mod common;

use common::{MANIFEST_DIR, run, schema};

fn cargo_version() -> String {
    let text = std::fs::read_to_string(format!("{MANIFEST_DIR}/Cargo.toml")).expect("Cargo.toml");
    let mut in_package = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_package = line == "[package]";
            continue;
        }
        if in_package && line.starts_with("version") {
            let v = line.split('"').nth(1).expect("version の値");
            return v.to_string();
        }
    }
    panic!("[package] の version が無い");
}

#[test]
fn version_prints_one_line_and_exits_0() {
    // start の版の検査はこの 1 行を字句どおり比べる（SP-264-002）
    let out = run(&["--version"], "");
    assert_eq!(out.code, Some(0));
    assert_eq!(out.stdout, format!("formal-method-core {}\n", cargo_version()));
}

#[test]
fn cargo_version_equals_schema_version() {
    // 版が 2 つの正本で食い違うと、start は正しい実行体を拒むか古い実行体を通す
    let s = schema();
    assert_eq!(s["x-core"]["version"].as_str(), Some(cargo_version().as_str()));
}
