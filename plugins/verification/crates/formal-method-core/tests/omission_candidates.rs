//! SP-264-027: `omission-candidates`。モデルが引かず、対応表のどの行も触れない要素を漏れの候補にする。
//! 「触れる」は今の omissionDefects（checks/model.mjs）の定め: target の行はその対象の要素、
//! location の行は同じ対象・同じファイルで span が重なるか span が無い。goal・known_requirement の行は触れない。
// このテストは cargo の無い環境で手で書いた。rustfmt の形の差で `cargo fmt --check` が落ちないよう、
// ファイルの整形を外す（crate の根の inner 属性。rustfmt::skip を inner に直接書くのは安定版で使えない）。
#![cfg_attr(rustfmt, rustfmt::skip)]
#[rustfmt::skip]
mod common;

use common::{assert_conforms, assert_deterministic, call};
use serde_json::{Value, json};

const SUB: &str = "omission-candidates";

fn el(id: &str, target: &str, file: &str, span: &str) -> Value {
    json!({ "id": id, "source": { "target_id": target, "file": file, "span": span } })
}

fn loc(target: &str, file: &str, span: Option<&str>) -> Value {
    match span {
        Some(s) => json!({ "source": { "kind": "location", "target_id": target, "file": file, "span": s } }),
        None => json!({ "source": { "kind": "location", "target_id": target, "file": file } }),
    }
}

fn candidate_ids(out: &Value) -> Vec<String> {
    out["candidates"]
        .as_array()
        .expect("candidates")
        .iter()
        .map(|x| x["id"].as_str().expect("id").to_string())
        .collect()
}

fn sample() -> Value {
    json!({
        "elements": [
            el("E7", "T3", "a.md", "L3-L5"),
            el("E1", "T1", "a.md", "L1-L1"),
            el("E2", "T1", "a.md", "L3-L5"),
            el("E3", "T1", "a.md", "L8-L9"),
            el("E4", "T1", "b.md", "L1-L2"),
            el("E5", "T1", "c.md", "L3-L4"),
            el("E6", "T2", "x.md", "L1-L1"),
            el("E8", "T1", "g.md", "L1-L1")
        ],
        "cited_ids": ["E1"],
        "rows": [
            loc("T1", "a.md", Some("L5-L7")),
            loc("T1", "a.md", Some("L10-L12")),
            loc("T1", "b.md", None),
            loc("T1", "c.md", Some("L5-L6")),
            { "source": { "kind": "target", "id": "T2" } },
            { "source": { "kind": "goal", "id": "G1" } }
        ]
    })
}

#[test]
fn only_uncited_untouched_elements_are_candidates() {
    // 要素の集合の差は決定的に取れるので、忠実さの確認役は候補の判断だけをする
    let out = call(SUB, &sample());
    assert_conforms(&out, "OmissionCandidatesOutput");
    // E1 は引かれ、E2 は L5 で重なり、E4 は span の無い行、E6 は target の行が触れる。
    // E3・E5 は重ならず、E7 は別の対象、E8 は goal の行しか無い
    assert_eq!(candidate_ids(&out), ["E3", "E5", "E7", "E8"]);
    let e3 = &out["candidates"][0];
    assert_eq!(e3["source"], json!({ "target_id": "T1", "file": "a.md", "span": "L8-L9" }));
}

#[test]
fn span_overlap_includes_the_shared_end_line() {
    // L3-L5 と L5-L7 は L5 を共有するので触れる。L3-L4 と L5-L6 は触れない
    let inp = json!({
        "elements": [el("A", "T1", "a.md", "L3-L5"), el("B", "T1", "a.md", "L3-L4")],
        "cited_ids": [],
        "rows": [loc("T1", "a.md", Some("L5-L7")), loc("T1", "z.md", Some("L3-L4"))]
    });
    assert_eq!(candidate_ids(&call(SUB, &inp)), ["B"]);
    let inp2 = json!({
        "elements": [el("B", "T1", "a.md", "L3-L4")],
        "cited_ids": [],
        "rows": [loc("T1", "a.md", Some("L5-L6"))]
    });
    assert_eq!(candidate_ids(&call(SUB, &inp2)), ["B"]);
}

#[test]
fn same_input_gives_same_bytes() {
    // view に書く候補は入力だけで決まる
    assert_deterministic(SUB, &sample());
}
