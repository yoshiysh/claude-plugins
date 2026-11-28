//! SP-264-029: `complete-return`。作業記録と返り値の文脈の欄を task の値で入れる。
//! 役の見分け方は spec に無いので、次のとおり読む: perspective が null でなければ確認役、
//! role が cause-analyst なら原因の分類役、他は作成役。
// このテストは cargo の無い環境で手で書いた。rustfmt の形の差で `cargo fmt --check` が落ちないよう、
// ファイルの整形を外す（crate の根の inner 属性。rustfmt::skip を inner に直接書くのは安定版で使えない）。
#![cfg_attr(rustfmt, rustfmt::skip)]
#[rustfmt::skip]
mod common;

use common::{assert_conforms, assert_deterministic, call, strs};
use serde_json::{Value, json};

const SUB: &str = "complete-return";

fn task(task_id: &str, role: &str, stage: &str, target: &str, unit_id: Value, perspective: Value) -> Value {
    json!({ "task_id": task_id, "role": role, "stage": stage, "target": target, "unit_id": unit_id, "perspective": perspective })
}

fn worklog_draft() -> Value {
    json!({
        "inputs": [{ "ref": "request.json" }],
        "actions": "資料を読んだ。",
        "results": "返り値を書いた。",
        "grounds": "資料の記述による。",
        "failures": [],
        "unconfirmed": [],
        "unreadable_inputs": []
    })
}

fn author_ret() -> Value {
    json!({
        "status": "done",
        "outputs": [{ "kind": "inventory", "ref": "attempts/t001-extractor/inventory.json" }],
        "questions": [],
        "blocked_by_question": [],
        "reason": null,
        "worklog_ref": "attempts/t001-extractor/worklog.json"
    })
}

fn review_ret() -> Value {
    json!({
        "findings": [],
        "items": [{ "ref": "観点", "result": "成り立つ" }],
        "judgments": [],
        "record_ref": "attempts/t005-fidelity-reviewer/review.json",
        "worklog_ref": "attempts/t005-fidelity-reviewer/worklog.json"
    })
}

fn complete(task: Value, worklog: Value, ret: Value) -> Value {
    let out = call(SUB, &json!({ "task": task, "worklog": worklog, "ret": ret }));
    assert_conforms(&out, "CompleteReturnOutput");
    out
}

/// a に b の欄を足したもの（足した欄以外が変わらないことを比べるため）。
fn with(a: &Value, extra: &Value) -> Value {
    let mut m = a.as_object().expect("object").clone();
    for (k, v) in extra.as_object().expect("object") {
        m.insert(k.clone(), v.clone());
    }
    Value::Object(m)
}

#[test]
fn author_worklog_and_return_get_the_task_values() {
    // 文脈の欄は task から一意に決まるので、担当に書き写させない
    let t = task("t001-extractor", "extractor", "洗い出し", "T1", Value::Null, Value::Null);
    let out = complete(t, worklog_draft(), author_ret());
    let ctx = json!({
        "schema": "formal-method.worklog/1", "role": "extractor", "task_id": "t001-extractor",
        "stage": "洗い出し", "target": "T1"
    });
    assert_eq!(out["worklog"], with(&worklog_draft(), &ctx));
    // 作成役の返り値は task_id だけを持つ（unit_id・perspective を足さない）
    assert_eq!(out["ret"], with(&author_ret(), &json!({ "task_id": "t001-extractor" })));
    assert_eq!(out["problems"], json!([]));
}

#[test]
fn reviewer_return_gets_task_unit_and_perspective() {
    // 確認役の返り値の unit_id・perspective も task の値
    let t = task("t005-fidelity-reviewer", "fidelity-reviewer", "確認", "fidelity-M1", json!("fidelity-M1"), json!("fidelity"));
    let out = complete(t, worklog_draft(), review_ret());
    let extra = json!({ "task_id": "t005-fidelity-reviewer", "unit_id": "fidelity-M1", "perspective": "fidelity" });
    assert_eq!(out["ret"], with(&review_ret(), &extra));
    assert_eq!(out["worklog"]["target"], json!("fidelity-M1"));
    assert_eq!(out["problems"], json!([]));
}

#[test]
fn cause_analyst_return_has_no_perspective() {
    // CauseReturn は perspective の欄を持たない
    let ret = json!({ "cause": "対象が性質を満たさない", "grounds": "根拠", "questions": [],
        "record_ref": "attempts/t009-cause-analyst/cause.json", "worklog_ref": "attempts/t009-cause-analyst/worklog.json" });
    let t = task("t009-cause-analyst", "cause-analyst", "確認", "cause-check-C1", json!("cause-check-C1"), Value::Null);
    let out = complete(t, worklog_draft(), ret.clone());
    let extra = json!({ "task_id": "t009-cause-analyst", "unit_id": "cause-check-C1" });
    assert_eq!(out["ret"], with(&ret, &extra));
    assert!(out["ret"].get("perspective").is_none());
}

#[test]
fn same_values_in_the_draft_are_not_problems() {
    // 下書きに同じ値があっても誤りにしない（今の担当の返り値も受ける）
    let t = task("t001-extractor", "extractor", "洗い出し", "T1", Value::Null, Value::Null);
    let ret = with(&author_ret(), &json!({ "task_id": "t001-extractor" }));
    let wl = with(&worklog_draft(), &json!({ "role": "extractor", "task_id": "t001-extractor" }));
    let out = complete(t, wl, ret);
    assert_eq!(out["problems"], json!([]));
}

#[test]
fn different_values_in_the_draft_are_reported() {
    // 違う値は CLI が今の「返り値の task_id が task と違う」と同じく直させる
    let t = task("t005-fidelity-reviewer", "fidelity-reviewer", "確認", "fidelity-M1", json!("fidelity-M1"), json!("fidelity"));
    let ret = with(&review_ret(), &json!({ "task_id": "t004-other", "unit_id": "fidelity-M2" }));
    let wl = with(&worklog_draft(), &json!({ "stage": "計画" }));
    let out = complete(t, wl, ret);
    let problems = strs(&out["problems"]);
    for name in ["task_id", "unit_id", "stage"] {
        assert!(problems.iter().any(|p| p == name), "{name} が problems に無い: {problems:?}");
    }
    assert!(!problems.iter().any(|p| p == "perspective"), "{problems:?}");
}

#[test]
fn same_input_gives_same_bytes() {
    // 補いは入力だけで決まる
    let t = task("t001-extractor", "extractor", "洗い出し", "T1", Value::Null, Value::Null);
    assert_deterministic(SUB, &json!({ "task": t, "worklog": worklog_draft(), "ret": author_ret() }));
}
