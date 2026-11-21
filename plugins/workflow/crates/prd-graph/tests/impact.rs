use prd_graph::{Facts, impact};

fn facts(json: &str) -> Facts {
    serde_json::from_str(json).unwrap()
}

#[test]
fn doc_without_entry_counts_every_item_as_changed() {
    // 新しく書く文書には入口が無い。全てを変わった項目に数えないと、新しい項目の検査が外れる。
    let f = facts(
        r#"{"docs":[{"key":"specifications/a","items":[{"id":"SP-A-001","digest":"x"},{"id":"SP-A-002","digest":"y"}]}]}"#,
    );
    let r = impact(&f);
    assert_eq!(r.changed, vec!["SP-A-001", "SP-A-002"]);
    assert_eq!(r.impact, vec!["SP-A-001", "SP-A-002"]);
    assert!(r.baselined.is_empty());
}

#[test]
fn unchanged_item_outside_neighbors_is_not_in_impact() {
    // 改訂していない既存の項目を影響の範囲に入れると、直せない機械検査の指摘が blocking に積もる。
    let f = facts(
        r#"{"entry":{"specifications/a":{"SP-A-001":"x","SP-A-002":"y","SP-A-003":"z"}},
            "docs":[{"key":"specifications/a","items":[
              {"id":"SP-A-001","digest":"x2","refs":["SP-A-002"]},
              {"id":"SP-A-002","digest":"y"},
              {"id":"SP-A-003","digest":"z"}]}]}"#,
    );
    let r = impact(&f);
    assert_eq!(r.changed, vec!["SP-A-001"]);
    assert_eq!(r.impact, vec!["SP-A-001", "SP-A-002"]);
    assert_eq!(r.baselined, vec!["specifications/a"]);
}

#[test]
fn items_referencing_a_changed_item_are_in_impact() {
    // 変えた項目を参照する側も読み直す（改訂が他の項目と食い違うのを拾うため）。
    let f = facts(
        r#"{"entry":{"specifications/a":{"SP-A-001":"x","SP-A-002":"y"}},
            "docs":[{"key":"specifications/a","items":[
              {"id":"SP-A-001","digest":"x2"},
              {"id":"SP-A-002","digest":"y","refs":["SP-A-001"]}]}]}"#,
    );
    assert_eq!(impact(&f).impact, vec!["SP-A-001", "SP-A-002"]);
}

#[test]
fn siblings_under_the_same_requirement_are_in_impact() {
    let f = facts(
        r#"{"entry":{"specifications/a":{"SP-A-001":"x","SP-A-002":"y","SP-A-003":"z"}},
            "docs":[{"key":"specifications/a","items":[
              {"id":"SP-A-001","digest":"x2"},{"id":"SP-A-002","digest":"y"},{"id":"SP-A-003","digest":"z"}],
              "links":[{"requirement_id":"PR-A-001","spec_id":"SP-A-001"},{"requirement_id":"PR-A-001","spec_id":"SP-A-002"},
                       {"requirement_id":"PR-A-002","spec_id":"SP-A-003"}]}]}"#,
    );
    assert_eq!(impact(&f).impact, vec!["PR-A-001", "SP-A-001", "SP-A-002"]);
}

#[test]
fn removed_item_pulls_in_items_that_still_reference_it() {
    let f = facts(
        r#"{"entry":{"specifications/a":{"SP-A-001":"x","SP-A-002":"y"}},
            "docs":[{"key":"specifications/a","items":[{"id":"SP-A-002","digest":"y","refs":["SP-A-001"]}]}]}"#,
    );
    let r = impact(&f);
    assert_eq!(r.removed, vec!["SP-A-001"]);
    assert!(r.changed.is_empty());
    assert_eq!(r.impact, vec!["SP-A-001", "SP-A-002"]);
}

#[test]
fn neighbors_are_one_hop_only() {
    // 2 hop 先まで広げると、参照の多い文書では影響の範囲がほぼ全体になり、範囲を分ける意味が無くなる。
    let f = facts(
        r#"{"entry":{"specifications/a":{"SP-A-001":"x","SP-A-002":"y","SP-A-003":"z"}},
            "docs":[{"key":"specifications/a","items":[
              {"id":"SP-A-001","digest":"x2","refs":["SP-A-002"]},
              {"id":"SP-A-002","digest":"y","refs":["SP-A-003"]},
              {"id":"SP-A-003","digest":"z"}]}]}"#,
    );
    assert_eq!(impact(&f).impact, vec!["SP-A-001", "SP-A-002"]);
}

#[test]
fn output_is_deterministic() {
    let src = r#"{"entry":{"specifications/a":{"SP-A-002":"y","SP-A-001":"x"}},
        "docs":[{"key":"specifications/a","items":[{"id":"SP-A-002","digest":"y2","refs":["SP-A-001"]},{"id":"SP-A-001","digest":"x"}]}]}"#;
    assert_eq!(impact(&facts(src)), impact(&facts(src)));
}

#[test]
fn fixed_doc_without_entry_is_never_changed() {
    // 固定の文書は入口を持たないが書き換えない。変わった項目に数えると、参照の多い run で影響の範囲が全体になる。
    let f = facts(
        r#"{"entry":{"specifications/a":{"SP-A-001":"x"}},
            "docs":[{"key":"specifications/a","items":[{"id":"SP-A-001","digest":"x"}]},
                    {"key":"requirements/r","fixed":true,"items":[{"id":"PR-R-001","digest":"p","refs":["SP-A-001"]}]}]}"#,
    );
    let r = impact(&f);
    assert!(r.changed.is_empty());
    assert!(r.impact.is_empty());
}

#[test]
fn items_of_a_removed_doc_are_removed() {
    let f = facts(
        r#"{"entry":{"specifications/old":{"SP-OLD-001":"x"}},
            "docs":[{"key":"specifications/a","items":[{"id":"SP-A-001","digest":"y","refs":["SP-OLD-001"]}]}]}"#,
    );
    let r = impact(&f);
    assert_eq!(r.removed, vec!["SP-OLD-001"]);
    assert_eq!(r.impact, vec!["SP-A-001", "SP-OLD-001"]);
}
