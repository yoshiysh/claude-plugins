//! SP-264-025: `mapping-rows`。対応表の `location` の行の骨組みを、性質の `source_ids` から決める。
// このテストは cargo の無い環境で手で書いた。rustfmt の形の差で `cargo fmt --check` が落ちないよう、
// ファイルの整形を外す（crate の根の inner 属性。rustfmt::skip を inner に直接書くのは安定版で使えない）。
#![cfg_attr(rustfmt, rustfmt::skip)]
#[rustfmt::skip]
mod common;

use common::{assert_conforms, assert_deterministic, assert_input_error_value, call, role};
use serde_json::{Value, json};

const SUB: &str = "mapping-rows";

fn element(id: &str, file: &str, span: &str) -> Value {
    json!({ "id": id, "source": { "target_id": "T1", "file": file, "span": span } })
}

fn sample() -> Value {
    json!({
        "model_id": "M1",
        "properties": [
            { "id": "P2", "source_ids": ["E3"], "formalizable": false, "nonformal_reason": "数で表せない" },
            { "id": "P1", "source_ids": ["E2", "E1"], "formalizable": true, "nonformal_reason": null }
        ],
        "elements": [
            element("E1", "spec.md", "L1-L1"),
            element("E2", "spec.md", "L2-L3"),
            element("E3", "other.md", "L5-L5")
        ]
    })
}

#[test]
fn one_location_row_per_property_and_source() {
    // 行の数・row_id・出所・性質は source_ids から一意に決まるので、作成役に書かせない
    let out = call(SUB, &sample());
    assert_conforms(&out, "MappingRowsOutput");
    let rows = out["rows"].as_array().expect("rows");
    let ids: Vec<&str> = rows.iter().map(|r| r["row_id"].as_str().expect("row_id")).collect();
    // 性質の id の順、その中は source_ids の並びのまま
    assert_eq!(ids, ["P1/E2", "P1/E1", "P2/E3"]);
    assert_eq!(
        rows[0]["source"],
        json!({ "kind": "location", "target_id": "T1", "file": "spec.md", "span": "L2-L3" })
    );
    assert_eq!(rows[0]["property_id"], json!("P1"));
    assert_eq!(
        rows[2]["source"],
        json!({ "kind": "location", "target_id": "T1", "file": "other.md", "span": "L5-L5" })
    );
    assert_eq!(rows[2]["property_id"], json!("P2"));
}

#[test]
fn nonformal_rows_get_the_nonformal_relation_and_reason() {
    // 形式化できない性質の行の関係は性質ごとに一意で、理由は洗い出しの nonformal_reason
    let out = call(SUB, &sample());
    let rows = out["rows"].as_array().expect("rows");
    let nonformal = role("relation_nonformal");
    assert_eq!(rows[2]["relation"], json!(nonformal));
    assert_eq!(rows[2]["reason"], json!("数で表せない"));
    // 形式化できる性質の行の relation は作成役が決める（骨組みは決めない）
    for r in &rows[..2] {
        assert_ne!(r["relation"], json!(nonformal), "形式化できる性質の行 {r}");
    }
}

#[test]
fn unknown_source_element_is_an_input_error() {
    // 要素の無い出所は CLI が渡した入力の不備で、推定で補わない
    let mut inp = sample();
    inp["properties"][0]["source_ids"] = json!(["E9"]);
    assert_input_error_value(SUB, &inp);
}

#[test]
fn same_input_gives_same_bytes() {
    // CLI は骨組みを view に書いて task の資料にする。揺れると指紋が変わる
    assert_deterministic(SUB, &sample());
}
