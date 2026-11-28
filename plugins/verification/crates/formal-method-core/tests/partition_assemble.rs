//! SP-264-023: `partition-assemble`。分割の adopted・parts・境界の向きと共有の記号を候補と辺から決める。
// このテストは cargo の無い環境で手で書いた。rustfmt の形の差で `cargo fmt --check` が落ちないよう、
// ファイルの整形を外す（crate の根の inner 属性。rustfmt::skip を inner に直接書くのは安定版で使えない）。
#![cfg_attr(rustfmt, rustfmt::skip)]
#[rustfmt::skip]
mod common;

use common::{assert_conforms, assert_deterministic, assert_input_error_value, call, role};
use serde_json::{Value, json};

const SUB: &str = "partition-assemble";

fn candidates() -> Value {
    json!([
        { "id": "c1", "nodes": ["tr:M1/t1", "var:M1/x2", "var:M1/x"] },
        { "id": "c2", "nodes": ["var:M1/y", "tr:M1/t2"] },
        { "id": "c3", "nodes": ["var:M1/z"] }
    ])
}

// 辺は from が to に依る向き。e1 は c2 → c1 を跨ぎ、e2 は c1 の中、e3 は c1 と c3 を結ぶ
fn edges() -> Value {
    json!([
        { "id": "e1", "from": "tr:M1/t2", "to": "var:M1/x", "kind": "read" },
        { "id": "e2", "from": "tr:M1/t1", "to": "var:M1/x2", "kind": "write" },
        { "id": "e3", "from": "tr:M1/t1", "to": "var:M1/z", "kind": "read" }
    ])
}

fn decisions(adopted: &[&str]) -> Value {
    let all = ["c1", "c2", "c3"];
    Value::Array(
        all.iter()
            .map(|c| json!({ "candidate_id": c, "adopted": adopted.contains(c), "reason": format!("{c} の理由") }))
            .collect(),
    )
}

fn draft_boundary(edge_id: &str) -> Value {
    json!({
        "edge_id": edge_id,
        "assumption": format!("{edge_id} の前提"),
        "guarantee": format!("{edge_id} の保証"),
        "assumption_basis": { "kind": role("basis_other_part"), "contract_id": "K1" },
        "responsible": ["K1"]
    })
}

fn input(adopted: &[&str], boundaries: Value) -> Value {
    json!({ "candidates": candidates(), "graph_edges": edges(), "decisions": decisions(adopted), "boundaries": boundaries })
}

/// missing・extra の要素は edge_id と読む（edge_id を持つ object でも受ける）。
fn edge_ids(v: &Value) -> Vec<String> {
    v.as_array()
        .expect("配列")
        .iter()
        .map(|x| x.as_str().or_else(|| x["edge_id"].as_str()).expect("edge_id").to_string())
        .collect()
}

fn all_part_nodes(out: &Value) -> Vec<String> {
    let mut n = Vec::new();
    for p in out["parts"].as_array().expect("parts") {
        for key in ["owns_variables", "transitions"] {
            n.extend(common::strs(&p[key]));
        }
    }
    n
}

#[test]
fn adopting_two_candidates_builds_parts_and_the_crossing_boundary() {
    // parts と境界の向き・共有の記号は候補と辺から一意に決まるので、分割作成役に書かせない
    let out = call(SUB, &input(&["c1", "c2"], json!([draft_boundary("e1")])));
    assert_conforms(&out, "PartitionAssembleOutput");
    assert_eq!(out["adopted"], json!(true));
    assert_eq!(
        out["parts"],
        json!([
            { "id": "c1", "model_id": "M1", "owns_variables": ["var:M1/x", "var:M1/x2"], "transitions": ["tr:M1/t1"] },
            { "id": "c2", "model_id": "M1", "owns_variables": ["var:M1/y"], "transitions": ["tr:M1/t2"] }
        ])
    );
    let b = out["boundaries"].as_array().expect("boundaries");
    assert_eq!(b.len(), 1, "跨ぐのは e1 だけ（e2 は部分の中、e3 は部分の無い節点を指す）");
    assert_eq!(b[0]["edge_id"], json!("e1"));
    // producer は to の節点の部分、consumer は from の節点の部分
    assert_eq!(b[0]["producer"], json!("c1"));
    assert_eq!(b[0]["consumer"], json!("c2"));
    assert_eq!(b[0]["shared_symbols"], json!(["x"]));
    // 前提・保証・出どころ・責任は下書きから写す
    assert_eq!(b[0]["assumption"], json!("e1 の前提"));
    assert_eq!(b[0]["guarantee"], json!("e1 の保証"));
    assert_eq!(b[0]["assumption_basis"], json!({ "kind": role("basis_other_part"), "contract_id": "K1" }));
    assert_eq!(b[0]["responsible"], json!(["K1"]));
    assert_eq!(out["missing_boundaries"], json!([]));
    assert_eq!(out["extra_boundaries"], json!([]));
}

#[test]
fn nodes_of_unadopted_candidates_are_in_no_part() {
    // 採らなかった候補の節点は、分割前後の照合で対応の無い要素になる（今の意味を変えない）
    let out = call(SUB, &input(&["c1", "c2"], json!([draft_boundary("e1")])));
    assert!(!all_part_nodes(&out).contains(&"var:M1/z".to_string()));
}

#[test]
fn adopting_one_candidate_is_adopted_without_boundaries() {
    // adopted は decisions の adopted の論理和
    let out = call(SUB, &input(&["c1"], json!([])));
    assert_conforms(&out, "PartitionAssembleOutput");
    assert_eq!(out["adopted"], json!(true));
    let parts = out["parts"].as_array().expect("parts");
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0]["id"], json!("c1"));
    assert_eq!(out["boundaries"], json!([]));
    assert_eq!(out["missing_boundaries"], json!([]));
}

#[test]
fn adopting_none_is_not_adopted_and_empty() {
    // 採らなければ部分も境界も無い
    let out = call(SUB, &input(&[], json!([])));
    assert_eq!(out["adopted"], json!(false));
    assert_eq!(out["parts"], json!([]));
    assert_eq!(out["boundaries"], json!([]));
}

#[test]
fn missing_and_extra_draft_boundaries_are_reported() {
    // 下書きの欠けは boundary-missing、跨がない辺の下書きは boundary-edge の欠陥に CLI がする
    let out = call(SUB, &input(&["c1", "c2"], json!([draft_boundary("e2"), draft_boundary("e3")])));
    assert_eq!(edge_ids(&out["missing_boundaries"]), ["e1"]);
    let mut extra = edge_ids(&out["extra_boundaries"]);
    extra.sort();
    assert_eq!(extra, ["e2", "e3"]);
    assert_eq!(out["boundaries"], json!([]), "下書きの無い辺に境界を出さない");
}

#[test]
fn candidate_spanning_two_models_is_an_input_error() {
    // 候補の節点は 1 つのモデルに属する（writer-merge-scc/1）。跨ぐなら CLI の入力の不備
    let mut inp = input(&["c1"], json!([]));
    inp["candidates"][0]["nodes"] = json!(["var:M1/x", "var:M2/y"]);
    assert_input_error_value(SUB, &inp);
}

#[test]
fn same_input_gives_same_bytes() {
    // 組み立ては入力だけで決まる
    assert_deterministic(SUB, &input(&["c1", "c2"], json!([draft_boundary("e1"), draft_boundary("e2")])));
}
