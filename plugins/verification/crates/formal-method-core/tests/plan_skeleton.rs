//! SP-264-020: `plan-skeleton`。計画の検査と sanity の列挙・id・参照・依存をモデルと分割から決める。
// このテストは cargo の無い環境で手で書いた。rustfmt の形の差で `cargo fmt --check` が落ちないよう、
// ファイルの整形を外す（crate の根の inner 属性。rustfmt::skip を inner に直接書くのは安定版で使えない）。
#![cfg_attr(rustfmt, rustfmt::skip)]
#[rustfmt::skip]
mod common;

use common::{assert_conforms, assert_deterministic, call, role, strs};
use serde_json::{Value, json};

const SUB: &str = "plan-skeleton";

fn model() -> Value {
    json!({
        "model_id": "M1",
        "properties": [
            { "id": "M1.p1", "inventory_property_ids": ["P1"], "query_ref": "attempts/t1/q1.smt2",
              "sanity": [{ "query_ref": "attempts/t1/s1.smt2" }] },
            { "id": "M1.p2", "inventory_property_ids": ["P2"], "query_ref": "attempts/t1/q2.smt2",
              "sanity": [] }
        ]
    })
}

fn target(id: &str, seconds: u64, scope: &str) -> Value {
    json!({ "target_id": id, "tool_time_limit_seconds": seconds, "assumptions": [format!("{id} の前提")], "scope": scope })
}

fn partitions() -> Value {
    let other = role("basis_other_part");
    json!({
        "parts": [
            { "id": "A", "model_id": "M1", "owns_variables": ["var:M1/x"], "transitions": ["tr:M1/t1"] },
            { "id": "B", "model_id": "M1", "owns_variables": ["var:M1/y"], "transitions": ["tr:M1/t2"] }
        ],
        "boundaries": [
            { "edge_id": "e1", "producer": "A", "consumer": "B", "shared_symbols": ["x"],
              "assumption": "x は 0 以上", "guarantee": "x は 0 以上",
              "assumption_basis": { "kind": other, "contract_id": "K1" }, "responsible": ["A"] },
            { "edge_id": "e2", "producer": "B", "consumer": "A", "shared_symbols": ["y"],
              "assumption": "y は 0 以上", "guarantee": "y は 0 以上",
              "assumption_basis": { "kind": "確認できない前提", "reason": "確かめる手段が無い" }, "responsible": ["B"] }
        ],
        "contracts": [
            { "id": "K1", "model_id": "M1", "derived_from": "M1.p1", "part_id": "A",
              "statement": "A は x を保つ", "query_ref": "attempts/t2/k1.smt2" },
            { "id": "K2", "model_id": "M1", "derived_from": "M1.p2", "part_id": "B",
              "statement": "B は y を保つ", "query_ref": "attempts/t2/k2.smt2" }
        ],
        "composition_conditions": [
            { "id": "C1", "model_id": "M1", "derived_from": "M1.p2", "statement": "全体で保つ",
              "query_ref": "attempts/t2/c1.smt2", "depends_on": ["K1", "K2"] }
        ]
    })
}

fn all_targets() -> Value {
    json!([
        target("M1.p1", 30, "s1"),
        target("M1.p2", 40, "s2"),
        target("K1", 50, "k1"),
        target("K2", 60, "k2"),
        target("C1", 70, "c1")
    ])
}

fn input(partitions: Value, excluded: &[&str], targets: Value) -> Value {
    json!({ "models": [model()], "partitions": partitions, "excluded_property_ids": excluded, "targets": targets })
}

fn ids(v: &Value) -> Vec<String> {
    v.as_array().expect("配列").iter().map(|x| x["id"].as_str().expect("id").to_string()).collect()
}

fn find<'a>(v: &'a Value, id: &str) -> &'a Value {
    v.as_array().expect("配列").iter().find(|x| x["id"] == json!(id)).unwrap_or_else(|| panic!("{id} が無い"))
}

#[test]
fn property_checks_and_sanity_follow_the_model() {
    // 検査の id・target_id・model_id・expected・input_refs はモデルから一意に決まるので、計画作成役に書かせない
    let out = call(SUB, &input(Value::Null, &[], all_targets()));
    assert_conforms(&out, "PlanSkeletonOutput");
    assert_eq!(ids(&out["checks"]), ["prop-M1.p1", "prop-M1.p2"]);
    let c = find(&out["checks"], "prop-M1.p1");
    assert_eq!(c["kind"], json!("property"));
    assert_eq!(c["target_id"], json!("M1.p1"));
    assert_eq!(c["model_id"], json!("M1"));
    assert_eq!(c["expected"], json!("unsat"));
    assert_eq!(c["input_refs"], json!(["attempts/t1/q1.smt2"]));
    assert_eq!(c["depends_on"], json!([]));
    // 時間の上限・前提・範囲は計画作成役の targets から写す
    assert_eq!(c["tool_time_limit_seconds"], json!(30));
    assert_eq!(c["assumptions"], json!(["M1.p1 の前提"]));
    assert_eq!(c["scope"], json!("s1"));
    assert_eq!(find(&out["checks"], "prop-M1.p2")["tool_time_limit_seconds"], json!(40));
    // sanity は sanity[] の 1 始まりの位置で名付ける
    assert_eq!(ids(&out["sanity"]), ["sanity-M1.p1-1"]);
    let s = find(&out["sanity"], "sanity-M1.p1-1");
    assert_eq!(s["model_property_id"], json!("M1.p1"));
    assert_eq!(s["input_refs"], json!(["attempts/t1/s1.smt2"]));
    assert_eq!(s["tool_time_limit_seconds"], json!(30));
    assert_eq!(out["missing_targets"], json!([]));
}

#[test]
fn excluded_property_has_neither_check_nor_sanity() {
    // 今の checkGaps と同じく、除く性質は検査も sanity も出さない
    let out = call(SUB, &input(Value::Null, &["P1"], all_targets()));
    assert_eq!(ids(&out["checks"]), ["prop-M1.p2"]);
    assert_eq!(out["sanity"], json!([]));
}

#[test]
fn property_is_kept_unless_all_its_inventory_properties_are_excluded() {
    // 除くのは inventory_property_ids の全てが除かれる性質だけ
    let mut inp = input(Value::Null, &["P1"], all_targets());
    inp["models"][0]["properties"][0]["inventory_property_ids"] = json!(["P1", "P3"]);
    let out = call(SUB, &inp);
    assert_eq!(ids(&out["checks"]), ["prop-M1.p1", "prop-M1.p2"]);
    assert_eq!(ids(&out["sanity"]), ["sanity-M1.p1-1"]);
}

#[test]
fn contract_and_composition_checks_depend_in_the_boundary_direction() {
    // 契約 K の検査は、consumer が K の部分で他の部分の保証に頼る境界の契約を待つ
    let out = call(SUB, &input(partitions(), &[], all_targets()));
    assert_conforms(&out, "PlanSkeletonOutput");
    // モデルの中で property → contract → composition、各々宣言の順
    assert_eq!(
        ids(&out["checks"]),
        ["prop-M1.p1", "prop-M1.p2", "contract-K1", "contract-K2", "comp-C1"]
    );
    let k1 = find(&out["checks"], "contract-K1");
    assert_eq!(k1["kind"], json!("contract"));
    assert_eq!(k1["target_id"], json!("K1"));
    assert_eq!(k1["model_id"], json!("M1"));
    assert_eq!(k1["input_refs"], json!(["attempts/t2/k1.smt2"]));
    assert_eq!(k1["expected"], json!("unsat"));
    // e2 の出どころは他の部分の保証でないので、K1 は何も待たない
    assert_eq!(k1["depends_on"], json!([]));
    assert_eq!(find(&out["checks"], "contract-K2")["depends_on"], json!(["contract-K1"]));
    let c1 = find(&out["checks"], "comp-C1");
    assert_eq!(c1["kind"], json!("composition"));
    assert_eq!(c1["input_refs"], json!(["attempts/t2/c1.smt2"]));
    assert_eq!(c1["depends_on"], json!(["contract-K1", "contract-K2"]));
    assert_eq!(c1["tool_time_limit_seconds"], json!(70));
}

#[test]
fn checks_not_emitted_are_not_depended_on() {
    // K1 は除く性質から導いたので出さない。出していない検査を待つと計画が閉じない
    let out = call(SUB, &input(partitions(), &["P1"], all_targets()));
    assert_eq!(ids(&out["checks"]), ["prop-M1.p2", "contract-K2", "comp-C1"]);
    assert_eq!(find(&out["checks"], "contract-K2")["depends_on"], json!([]));
    assert_eq!(find(&out["checks"], "comp-C1")["depends_on"], json!(["contract-K2"]));
}

#[test]
fn missing_targets_are_reported_and_not_emitted() {
    // targets の欠けは担当の欠陥（CLI が other にする）。値を推定で埋めない
    let targets = json!([target("M1.p1", 30, "s1"), target("K2", 60, "k2"), target("C1", 70, "c1")]);
    let out = call(SUB, &input(partitions(), &[], targets));
    // missing_targets の要素は target_id と読む（検査の id でも同じ対象を指すので、どちらも受ける）
    let missing = strs(&out["missing_targets"]);
    assert_eq!(missing.len(), 2, "{missing:?}");
    for (target_id, check_id) in [("K1", "contract-K1"), ("M1.p2", "prop-M1.p2")] {
        assert!(missing.iter().any(|x| x == target_id || x == check_id), "{missing:?}");
    }
    let got = ids(&out["checks"]);
    assert!(!got.iter().any(|x| x == "prop-M1.p2" || x == "contract-K1"), "{got:?}");
}

#[test]
fn no_id_starts_with_confirm() {
    // 確認の id（confirm-<kind>-<n>）と重ならない
    let out = call(SUB, &input(partitions(), &[], all_targets()));
    for id in ids(&out["checks"]).into_iter().chain(ids(&out["sanity"])) {
        assert!(!id.starts_with("confirm-"), "{id}");
    }
}

#[test]
fn same_input_gives_same_bytes() {
    // 骨組みは入力だけで決まる
    assert_deterministic(SUB, &input(partitions(), &["P2"], all_targets()));
}
