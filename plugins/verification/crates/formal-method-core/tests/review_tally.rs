//! SP-264-028: `review-tally`。確認役の結果（3 値）を指摘と項目ごとの記録から決める。
// このテストは cargo の無い環境で手で書いた。rustfmt の形の差で `cargo fmt --check` が落ちないよう、
// ファイルの整形を外す（crate の根の inner 属性。rustfmt::skip を inner に直接書くのは安定版で使えない）。
#![cfg_attr(rustfmt, rustfmt::skip)]
#[rustfmt::skip]
mod common;

use common::{assert_conforms, assert_deterministic, call, role};
use serde_json::{Value, json};

const SUB: &str = "review-tally";

fn finding() -> Value {
    json!({ "ref": "P1", "kind": "meaning_change", "note": "否定が逆" })
}

fn items(results: &[String]) -> Value {
    Value::Array(
        results
            .iter()
            .enumerate()
            .map(|(i, r)| json!({ "ref": format!("観点{i}"), "result": r }))
            .collect(),
    )
}

fn tally(findings: Value, items: Value) -> Value {
    let out = call(SUB, &json!({ "findings": findings, "items": items }));
    assert_conforms(&out, "ReviewTallyOutput");
    out["result"].clone()
}

#[test]
fn any_finding_fails() {
    // 指摘があれば、項目が全て成り立つと書いてあっても成り立たない
    let (holds, fails) = (role("result_holds"), role("result_fails"));
    assert_eq!(tally(json!([finding()]), items(&[holds.clone(), holds])), json!(fails));
    assert_eq!(tally(json!([finding()]), json!([])), json!(fails));
}

#[test]
fn all_items_holding_holds() {
    // 指摘が無く、見た項目が全て成り立つときだけ成り立つ
    let holds = role("result_holds");
    assert_eq!(tally(json!([]), items(&[holds.clone(), holds.clone()])), json!(holds));
}

#[test]
fn any_other_item_is_unknown() {
    // 1 つでも見終えられない・成り立たない項目があれば確認できず（指摘の無い成り立たないは結論にしない）
    let (holds, fails, unknown) = (role("result_holds"), role("result_fails"), role("result_unknown"));
    assert_eq!(tally(json!([]), items(&[holds.clone(), unknown.clone()])), json!(unknown));
    assert_eq!(tally(json!([]), items(&[holds, fails])), json!(unknown));
}

#[test]
fn empty_items_is_unknown() {
    // 何も見た記録の無い確認を成り立つとしない
    assert_eq!(tally(json!([]), json!([])), json!(role("result_unknown")));
}

#[test]
fn same_input_gives_same_bytes() {
    // 集計は入力だけで決まる
    let inp = json!({ "findings": [], "items": items(&[role("result_holds")]) });
    assert_deterministic(SUB, &inp);
}
