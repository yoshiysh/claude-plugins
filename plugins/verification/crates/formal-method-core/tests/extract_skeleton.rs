//! SP-264-026: `extract-skeleton`。走査の範囲（scanned）と、ID の形の外部の参照の下書きを決める。
//! 入力の files の要素は `{ path, text, lines }` と読む: text はテキストのファイルか（bool）、
//! lines は受付で固定した行数（テキストでなければ null）。
// このテストは cargo の無い環境で手で書いた。rustfmt の形の差で `cargo fmt --check` が落ちないよう、
// ファイルの整形を外す（crate の根の inner 属性。rustfmt::skip を inner に直接書くのは安定版で使えない）。
#![cfg_attr(rustfmt, rustfmt::skip)]
#[rustfmt::skip]
mod common;

use common::{assert_conforms, assert_deterministic, call, text};
use serde_json::{Value, json};

const SUB: &str = "extract-skeleton";

fn files() -> Value {
    json!([
        { "path": "c.md", "text": true, "lines": 3 },
        { "path": "a.md", "text": true, "lines": 10 },
        { "path": "b.bin", "text": false, "lines": null },
        { "path": "d.md", "text": true, "lines": 4 }
    ])
}

fn input(scope: Value, references: Value) -> Value {
    json!({ "target_id": "T1", "files": files(), "scope": scope, "references": references })
}

fn read(file: &str, span: Value) -> Value {
    json!({ "file": file, "span": span, "status": "read", "reason": null })
}

#[test]
fn scanned_follows_the_scope_in_path_order() {
    // 走査の範囲は依頼の範囲と受付の行数から一意に決まるので、抽出役に書かせない
    let scope = json!([
        { "file": "c.md", "spans": ["L2-L9"] },
        { "file": "a.md", "spans": ["L1-L2", "L5-L6"] },
        { "file": "b.bin", "spans": null }
    ]);
    let out = call(SUB, &input(scope, json!([])));
    assert_conforms(&out, "ExtractSkeletonOutput");
    let unread = json!({ "file": "b.bin", "span": null, "status": "unread", "reason": text("unread_non_text") });
    assert_eq!(
        out["scanned"],
        json!([
            read("a.md", json!("L1-L2")),
            read("a.md", json!("L5-L6")),
            unread,
            // 行数を超える span は行数で切る
            read("c.md", json!("L2-L3"))
        ])
    );
    // 範囲の外のファイル（d.md）は覆わない
    assert_eq!(out["external_dependencies"], json!([]));
}

#[test]
fn whole_file_scope_has_null_span() {
    // 範囲の指定が無いファイルは全体を読んだ記録（span: null）
    let scope = json!([{ "file": "a.md", "spans": null }, { "file": "d.md", "spans": null }]);
    let out = call(SUB, &input(scope, json!([])));
    assert_eq!(out["scanned"], json!([read("a.md", Value::Null), read("d.md", Value::Null)]));
}

#[test]
fn external_references_become_drafts_in_id_order() {
    // ID の形の参照は今の externalReferences が求め、実行体は下書きの文と出所だけを作る
    let refs = json!([
        { "id": "X-2", "file": "a.md", "line": 4 },
        { "id": "X-1", "file": "c.md", "line": 2 },
        { "id": "X-2", "file": "c.md", "line": 1 }
    ]);
    let scope = json!([{ "file": "a.md", "spans": null }, { "file": "c.md", "spans": null }]);
    let out = call(SUB, &input(scope, refs));
    assert_conforms(&out, "ExtractSkeletonOutput");
    let fill = |id: &str, file: &str, line: u64| {
        text("external_reference_template")
            .replace("{id}", id)
            .replace("{file}", file)
            .replace("{line}", &line.to_string())
    };
    let deps = out["external_dependencies"].as_array().expect("external_dependencies");
    assert_eq!(deps.len(), 2, "同じ id は 1 つ");
    assert_eq!(deps[0]["id"], json!("X-1"));
    assert_eq!(deps[0]["text"], json!(fill("X-1", "c.md", 2)));
    assert_eq!(deps[0]["source"], json!({ "target_id": "T1", "file": "c.md", "span": "L2-L2" }));
    // 同じ id は最初の参照
    assert_eq!(deps[1]["id"], json!("X-2"));
    assert_eq!(deps[1]["text"], json!(fill("X-2", "a.md", 4)));
    assert_eq!(deps[1]["source"], json!({ "target_id": "T1", "file": "a.md", "span": "L4-L4" }));
}

#[test]
fn same_input_gives_same_bytes() {
    // 骨組みは入力だけで決まる
    let scope = json!([{ "file": "c.md", "spans": ["L1-L2"] }, { "file": "b.bin", "spans": null }]);
    let refs = json!([{ "id": "X-1", "file": "c.md", "line": 2 }]);
    assert_deterministic(SUB, &input(scope, refs));
}
