//! SP-264-010・011: `partition-models`。性質を `source_ids` の連結成分で分け、`model_id` を前回の割り当てで決める。
// このテストは cargo の無い環境で手で書いた。rustfmt の形の差で `cargo fmt --check` が落ちないよう、
// ファイルの整形を外す（crate の根の inner 属性。rustfmt::skip を inner に直接書くのは安定版で使えない）。
#![cfg_attr(rustfmt, rustfmt::skip)]
#[rustfmt::skip]
mod common;

use common::{assert_conforms, assert_deterministic, assert_input_error_value, call, strs};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const SUB: &str = "partition-models";

fn props(list: &[(&str, &[&str], bool)]) -> Value {
    Value::Array(
        list.iter()
            .map(|(id, src, f)| json!({ "id": id, "source_ids": src, "formalizable": f }))
            .collect(),
    )
}

fn prev(list: &[(&str, &[&str])]) -> Value {
    Value::Array(
        list.iter()
            .map(|(m, ps)| json!({ "model_id": m, "property_ids": ps }))
            .collect(),
    )
}

fn input(properties: Value, previous: Value) -> Value {
    json!({ "properties": properties, "previous": previous })
}

/// `m-<h>`: 性質の id を順に改行でつないだ UTF-8 の SHA-256 の 16 進の先頭 12 文字（SP-264-011）。
fn hashed(ids: &[&str]) -> String {
    let digest = Sha256::digest(ids.join("\n").as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("m-{}", &hex[..12])
}

/// 出力を (model_id, property_ids) の組にし、並びと網羅の不変条件を確かめる。
fn run_models(inp: &Value) -> Vec<(String, Vec<String>)> {
    let out = call(SUB, inp);
    assert_conforms(&out, "PartitionModelsOutput");
    let models: Vec<(String, Vec<String>)> = out["models"]
        .as_array()
        .expect("models")
        .iter()
        .map(|m| {
            let id = m["model_id"].as_str().expect("model_id").to_string();
            (id, strs(&m["property_ids"]))
        })
        .collect();
    // models は model_id の順、property_ids は id の順
    let ids: Vec<&String> = models.iter().map(|(m, _)| m).collect();
    let mut sorted = ids.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(ids, sorted, "models は model_id の順で重ならない");
    for (_, ps) in &models {
        let mut s = ps.clone();
        s.sort();
        assert_eq!(ps, &s, "property_ids は id の順");
    }
    // どの性質もちょうど 1 つのモデルに入る
    let mut all: Vec<String> = models.iter().flat_map(|(_, ps)| ps.clone()).collect();
    all.sort();
    let mut expect: Vec<String> = inp["properties"]
        .as_array()
        .expect("properties")
        .iter()
        .map(|p| p["id"].as_str().expect("id").to_string())
        .collect();
    expect.sort();
    assert_eq!(all, expect, "どの性質もちょうど 1 つのモデルに入る");
    models
}

fn m(id: &str, ps: &[&str]) -> (String, Vec<String>) {
    (id.to_string(), ps.iter().map(|s| s.to_string()).collect())
}

fn sorted(mut v: Vec<(String, Vec<String>)>) -> Vec<(String, Vec<String>)> {
    v.sort();
    v
}

#[test]
fn properties_without_shared_sources_go_to_separate_models() {
    // 出所を共有しない性質を 1 つのモデルにまとめる理由は無い。
    // external_dependencies は入力に欄が無いので辺にならない（共有しない 2 組で確かめる）
    let inp = input(props(&[("P1", &["E1"], true), ("P2", &["E2"], true)]), json!([]));
    let got = run_models(&inp);
    let want = sorted(vec![m(&hashed(&["P1"]), &["P1"]), m(&hashed(&["P2"]), &["P2"])]);
    assert_eq!(got, want);
}

#[test]
fn chain_through_shared_sources_is_one_model() {
    // P1 と P3 は直接は共有しないが、P2 を介して同じ成分になる
    let inp = input(
        props(&[("P1", &["E1"], true), ("P2", &["E1", "E2"], true), ("P3", &["E2"], true)]),
        json!([]),
    );
    let got = run_models(&inp);
    assert_eq!(got, vec![m(&hashed(&["P1", "P2", "P3"]), &["P1", "P2", "P3"])]);
}

#[test]
fn nonformal_component_joins_the_smallest_model_id() {
    // 形式化できない性質もちょうど 1 つの対応表に行を持つ。model_id は形式の成分だけで決まる
    let inp = input(
        props(&[("P1", &["E1"], true), ("P2", &["E2"], true), ("P3", &["E3"], false)]),
        json!([]),
    );
    let got = run_models(&inp);
    let (h1, h2) = (hashed(&["P1"]), hashed(&["P2"]));
    let want = if h1 < h2 {
        vec![m(&h1, &["P1", "P3"]), m(&h2, &["P2"])]
    } else {
        vec![m(&h2, &["P2", "P3"]), m(&h1, &["P1"])]
    };
    assert_eq!(got, sorted(want));
}

#[test]
fn all_nonformal_is_one_model() {
    // 今の CLI は形式化できない性質だけでも model-author を 1 体出す
    let inp = input(props(&[("P1", &["E1"], false), ("P2", &["E2"], false)]), json!([]));
    let got = run_models(&inp);
    assert_eq!(got, vec![m(&hashed(&["P1", "P2"]), &["P1", "P2"])]);
}

#[test]
fn empty_source_ids_is_an_input_error() {
    // 洗い出しの照合を通らない入力。成分を作れないので推定で補わない
    let inp = input(props(&[("P1", &[], true)]), json!([]));
    assert_input_error_value(SUB, &inp);
}

#[test]
fn duplicated_property_id_is_an_input_error() {
    // 同じ id の性質は 2 つのモデルに入りうる
    let inp = input(props(&[("P1", &["E1"], true), ("P1", &["E2"], true)]), json!([]));
    assert_input_error_value(SUB, &inp);
}

#[test]
fn inconsistent_previous_is_an_input_error() {
    // 前回の割り当てが一意でなければ、id の引き継ぎが決まらない
    let ps = props(&[("P1", &["E1"], true), ("P2", &["E2"], true)]);
    let dup_id = prev(&[("A", &["P1"]), ("A", &["P2"])]);
    assert_input_error_value(SUB, &input(ps.clone(), dup_id));
    let shared = prev(&[("A", &["P1"]), ("B", &["P1"])]);
    assert_input_error_value(SUB, &input(ps.clone(), shared));
    // `.` を含む id は、モデルの性質の id の接頭辞 `<model_id>.` を一意にしない（SP-264-012）
    let dotted = prev(&[("A.1", &["P1"])]);
    assert_input_error_value(SUB, &input(ps, dotted));
}

#[test]
fn input_order_does_not_change_output() {
    // 洗い出しの並びが揺れても、モデルの分け方と id は変わらない
    let a = input(
        props(&[("P1", &["E1"], true), ("P2", &["E1", "E2"], true), ("P3", &["E3"], false)]),
        prev(&[("A", &["P1"]), ("B", &["P3"])]),
    );
    let b = input(
        props(&[("P3", &["E3"], false), ("P2", &["E2", "E1"], true), ("P1", &["E1"], true)]),
        prev(&[("B", &["P3"]), ("A", &["P1"])]),
    );
    assert_eq!(call(SUB, &a).to_string(), call(SUB, &b).to_string());
}

#[test]
fn same_input_gives_same_bytes() {
    // 同じ入力と前回の割り当てからは同じ出力（SP-264-005・011）
    let inp = input(
        props(&[("P1", &["E1"], true), ("P2", &["E2"], true)]),
        prev(&[("A", &["P1"])]),
    );
    assert_deterministic(SUB, &inp);
    let empty = input(props(&[("P1", &["E1"], true), ("P2", &["E2"], true)]), json!([]));
    assert_deterministic(SUB, &empty);
    assert_eq!(run_models(&empty), run_models(&empty));
}

#[test]
fn unchanged_components_keep_previous_ids() {
    // 性質の組が変わらなければ、前回の model_id を保つ
    let inp = input(
        props(&[("P1", &["E1"], true), ("P2", &["E2"], true)]),
        prev(&[("A", &["P1"]), ("B", &["P2"])]),
    );
    assert_eq!(run_models(&inp), vec![m("A", &["P1"]), m("B", &["P2"])]);
}

#[test]
fn component_with_an_added_property_keeps_previous_id() {
    // 性質を足した成分は、重なる前回の id を保つ
    let inp = input(
        props(&[("P1", &["E1"], true), ("P4", &["E1"], true)]),
        prev(&[("A", &["P1"])]),
    );
    assert_eq!(run_models(&inp), vec![m("A", &["P1", "P4"])]);
}

#[test]
fn merged_component_keeps_the_most_overlapping_id() {
    // 併合は大きく重なる方の id を保ち、残りの前回の id は使わない
    let ps = props(&[("P1", &["E1"], true), ("P2", &["E1"], true), ("P3", &["E1"], true)]);
    let inp = input(ps.clone(), prev(&[("Z", &["P1", "P2"]), ("B", &["P3"])]));
    assert_eq!(run_models(&inp), vec![m("Z", &["P1", "P2", "P3"])]);
    // 重なりが同じなら小さい id
    let tie = input(ps, prev(&[("Z", &["P1"]), ("B", &["P2"])]));
    assert_eq!(run_models(&tie), vec![m("B", &["P1", "P2", "P3"])]);
}

#[test]
fn split_component_gives_the_new_part_a_hashed_id() {
    // 分割は大きく重なる方が前回の id を保ち、他は m-<h> の 14 文字になる
    let inp = input(
        props(&[("P1", &["E1"], true), ("P2", &["E1"], true), ("P3", &["E3"], true)]),
        prev(&[("A", &["P1", "P2", "P3"])]),
    );
    let got = run_models(&inp);
    let fresh = hashed(&["P3"]);
    assert!(fresh.starts_with("m-") && fresh.len() == 14);
    assert_eq!(got, sorted(vec![m("A", &["P1", "P2"]), m(&fresh, &["P3"])]));
}
