//! SP-264-003: schema を 1 つのファイルを正本にし、値を src に写さない。
// このテストは cargo の無い環境で手で書いた。rustfmt の形の差で `cargo fmt --check` が落ちないよう、
// ファイルの整形を外す（crate の根の inner 属性。rustfmt::skip を inner に直接書くのは安定版で使えない）。
#![cfg_attr(rustfmt, rustfmt::skip)]
#[rustfmt::skip]
mod common;

use common::{MANIFEST_DIR, SUBCOMMANDS, run_env, schema, strs, temp_path};
use serde_json::{Value, json};

const STAGE: [&str; 7] = ["受付", "洗い出し", "モデル化", "計画", "実行", "確認", "集約"];
const CONFIRMATION_RESULT: [&str; 3] = ["成り立つ", "成り立たない", "確認できず"];
const ASSUMPTION_BASIS_KIND: [&str; 4] =
    ["他の部分の保証", "依頼の要求・制約", "共同不変条件", "確認できない前提"];
const MAPPING_RELATION: [&str; 4] = ["形式化", "形式検証でない確認", "範囲外", "対応なし"];

fn pascal(sub: &str) -> String {
    sub.split('-')
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().chain(c).collect::<String>(),
                None => String::new(),
            }
        })
        .collect()
}

fn enum_of(s: &Value, name: &str) -> Vec<String> {
    strs(&s["$defs"][name]["enum"])
}

#[test]
fn defs_have_input_and_output_of_every_subcommand() {
    // 実行体の入出力の型は schema の $defs が正本（SP-264-003）
    let s = schema();
    for sub in SUBCOMMANDS {
        for suffix in ["Input", "Output"] {
            let name = format!("{}{suffix}", pascal(sub));
            assert!(s["$defs"][&name].is_object(), "$defs/{name} が無い");
        }
    }
}

#[test]
fn enums_equal_the_current_values() {
    // 値は今の schemas.mjs の値と同じ（Node もこの列挙を読む）
    let s = schema();
    assert_eq!(enum_of(&s, "Stage"), STAGE);
    assert_eq!(enum_of(&s, "ConfirmationResult"), CONFIRMATION_RESULT);
    assert_eq!(enum_of(&s, "AssumptionBasisKind"), ASSUMPTION_BASIS_KIND);
    assert_eq!(enum_of(&s, "MappingRelation"), MAPPING_RELATION);
}

#[test]
fn x_core_has_the_fixed_fields() {
    // start と callCore が読む上限と名前
    let x = &schema()["x-core"];
    assert_eq!(x["binary"], json!("formal-method-core"));
    assert!(x["version"].is_string());
    assert!(x["repository"].is_string());
    assert!(x["tag_prefix"].is_string());
    assert_eq!(x["version_timeout_ms"], json!(5000));
    assert_eq!(x["call_timeout_ms"], json!(60000));
}

#[test]
fn roles_name_exactly_five_values_of_their_enums() {
    // 実行体は列挙の位置でなく名前で値を選ぶ（並びを変えても意味が変わらない）
    let s = schema();
    let roles = s["x-core"]["roles"].as_object().expect("x-core.roles");
    let mut names: Vec<&str> = roles.keys().map(String::as_str).collect();
    names.sort();
    assert_eq!(
        names,
        [
            "basis_other_part",
            "relation_nonformal",
            "result_fails",
            "result_holds",
            "result_unknown",
        ]
    );
    let expect = [
        ("relation_nonformal", "MappingRelation", "形式検証でない確認"),
        ("basis_other_part", "AssumptionBasisKind", "他の部分の保証"),
        ("result_holds", "ConfirmationResult", "成り立つ"),
        ("result_fails", "ConfirmationResult", "成り立たない"),
        ("result_unknown", "ConfirmationResult", "確認できず"),
    ];
    for (name, enum_name, value) in expect {
        let r = &roles[name];
        assert_eq!(r["enum"], json!(enum_name), "{name} の enum");
        assert_eq!(r["value"], json!(value), "{name} の value");
        assert!(enum_of(&s, enum_name).iter().any(|v| v == value), "{name} は列挙の値");
    }
}

#[test]
fn texts_hold_the_fixed_sentences() {
    // 実行体が出す日本語の文は schema が持つ（SP-264-026）
    let t = &schema()["x-core"]["texts"];
    assert_eq!(t["unread_non_text"], json!("テキストでないファイル"));
    assert_eq!(
        t["external_reference_template"],
        json!("本文が参照する外部の ID {id}（{file}:L{line}）")
    );
}

fn rust_sources(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    for e in std::fs::read_dir(dir).expect("src を読める") {
        let p = e.expect("entry").path();
        if p.is_dir() {
            rust_sources(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

/// .rs の本文から文字列リテラル（"…"・r"…"・r#"…"#）の中身を取り出す。コメントは飛ばす。
/// 日本語のコメントに「計画」などの語が出るのは値の写しではないので、リテラルだけを走査する。
fn string_literals(src: &str) -> Vec<String> {
    let b: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let next = b.get(i + 1).copied();
        if c == '/' && next == Some('/') {
            while i < b.len() && b[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && next == Some('*') {
            i += 2;
            while i + 1 < b.len() && (b[i] != '*' || b[i + 1] != '/') {
                i += 1;
            }
            i += 2;
        } else if c == 'r' && (next == Some('"') || next == Some('#')) {
            let mut j = i + 1;
            let mut hashes = 0;
            while j < b.len() && b[j] == '#' {
                hashes += 1;
                j += 1;
            }
            if j < b.len() && b[j] == '"' {
                let close = format!("\"{}", "#".repeat(hashes));
                let rest: String = b[j + 1..].iter().collect();
                let end = rest.find(&close).unwrap_or(rest.len());
                out.push(rest[..end].to_string());
                i = j + 1 + rest[..end].chars().count() + close.chars().count();
            } else {
                i += 1;
            }
        } else if c == '"' {
            let mut lit = String::new();
            i += 1;
            while i < b.len() && b[i] != '"' {
                if b[i] == '\\' {
                    i += 1;
                }
                if i < b.len() {
                    lit.push(b[i]);
                }
                i += 1;
            }
            out.push(lit);
            i += 1;
        } else if c == '\'' && next == Some('\\') {
            // 文字のリテラルの escape '\n'・'\''・'\"'
            i += 3;
            while i < b.len() && b[i] != '\'' {
                i += 1;
            }
            i += 1;
        } else if c == '\'' && b.get(i + 2) == Some(&'\'') {
            // 文字のリテラル 'x'（"を含みうる）
            i += 3;
        } else {
            i += 1;
        }
    }
    out
}

#[test]
fn string_literals_skip_comments() {
    // 走査の補助そのものの確かめ: コメントの語は拾わず、リテラルは拾う
    let src = "// \"c\"\nlet a = \"x\\\"y\"; /* \"d\" */ let b = r#\"z\"#; let q = '\"';";
    let lits = string_literals(src);
    assert_eq!(lits, ["x\"y", "z"]);
}

#[test]
fn src_does_not_copy_schema_values() {
    // 値を src に写すと、schema を直しても実行体が古い値を使い続ける（字句の走査）。
    // binary の名前も走査に含める: --version は env!("CARGO_PKG_NAME") で出せる
    let s = schema();
    let x = &s["x-core"];
    let mut forbidden: Vec<String> = Vec::new();
    for name in ["Stage", "ConfirmationResult", "AssumptionBasisKind", "MappingRelation"] {
        forbidden.extend(enum_of(&s, name));
    }
    for r in x["roles"].as_object().expect("roles").values() {
        forbidden.push(r["value"].as_str().expect("value").to_string());
    }
    for t in x["texts"].as_object().expect("texts").values() {
        forbidden.push(t.as_str().expect("text").to_string());
    }
    for key in ["binary", "repository", "tag_prefix"] {
        forbidden.push(x[key].as_str().expect("x-core の文字列").to_string());
    }
    let mut files = Vec::new();
    rust_sources(&std::path::Path::new(MANIFEST_DIR).join("src"), &mut files);
    assert!(!files.is_empty(), "src に .rs がある");
    for f in files {
        let body = std::fs::read_to_string(&f).expect("src を読める");
        for lit in string_literals(&body) {
            for v in &forbidden {
                // リテラル全体が値と同じものを写しと見なす（「確認」「計画」のような短い値を部分で禁じると、
                // 値でない日本語のエラーの文まで書けなくなる。固定の文は {id} を埋める前の形で比べる）
                assert!(
                    lit != *v,
                    "{} のリテラルに schema の値 {v}",
                    f.display()
                );
            }
        }
    }
}

#[test]
fn role_outside_its_enum_exits_2() {
    // 名前付きの対応が列挙と食い違う schema では、誤った値を出す前に止まる（DD-11）
    let mut s = schema();
    s["x-core"]["roles"]["result_holds"]["value"] = json!("列挙に無い値");
    let path = temp_path("broken-role.schema.json");
    std::fs::write(&path, s.to_string()).expect("一時の schema を書ける");
    let input = json!({ "findings": [], "items": [] }).to_string();
    let p = path.to_str().expect("path");
    let out = run_env(
        &["review-tally"],
        &input,
        &[("FORMAL_METHOD_CORE_SCHEMA_OVERRIDE", p)],
    );
    let _ = std::fs::remove_file(&path);
    assert_eq!(out.code, Some(2), "stderr={}", out.stderr);
    assert_eq!(out.stdout, "");
    assert!(!out.stderr.trim().is_empty());
}

#[test]
fn override_with_the_real_schema_still_works() {
    // 上のテストが override の効かない build で偶然 exit 2 になっていないことを確かめる
    let input = json!({ "findings": [], "items": [] }).to_string();
    let out = run_env(
        &["review-tally"],
        &input,
        &[("FORMAL_METHOD_CORE_SCHEMA_OVERRIDE", common::SCHEMA_PATH)],
    );
    assert_eq!(out.code, Some(0), "stderr={}", out.stderr);
}
