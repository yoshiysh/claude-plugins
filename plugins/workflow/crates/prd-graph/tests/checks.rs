use prd_graph::checks::{CheckFacts, check, ids_in};

fn facts(json: &str) -> CheckFacts {
    serde_json::from_str(json).unwrap()
}

fn codes(f: &CheckFacts) -> Vec<(&'static str, Vec<String>)> {
    check(f)
        .into_iter()
        .map(|x| {
            (
                x.code,
                x.args
                    .iter()
                    .map(|a| {
                        a.as_str()
                            .map(String::from)
                            .unwrap_or_else(|| a.to_string())
                    })
                    .collect(),
            )
        })
        .collect()
}

#[test]
fn ids_in_follows_the_word_boundary_of_doc_check() {
    // doc_check の ID_IN_TEXT（\b）と同じく、直前の `-` は語頭として許し、英数字は許さない。
    assert_eq!(
        ids_in("SP-A-001 と PR-B-02、XSP-A-001、SP-A-001x、x-SP-C-003、RUN048"),
        vec!["SP-A-001", "PR-B-02", "SP-C-003"]
    );
}

#[test]
fn decision_naming_an_editable_item_needs_its_trace() {
    let doc = r#"{"key":"specifications/a","sections":[{"key":"SP-A-001","id":"SP-A-001","body":"本文"}]"#;
    let f = facts(&format!(
        r#"{{"docs":[{doc}}}],"decisions":[{{"id":"D-004","named":["SP-A-001","SP-Z-036"]}}]}}"#
    ));
    assert_eq!(
        codes(&f),
        vec![(
            "DECISION_UNAPPLIED",
            vec!["SP-A-001".into(), "D-004".into(), "[\"SP-A-001\"]".into()]
        )]
    );
    let traced = facts(&format!(
        r#"{{"docs":[{doc},"trace":[{{"item_id":"specifications/a§検証方法","kind":"decision","ref":"D-004"}}]}}],"decisions":[{{"id":"D-004","named":["SP-A-001"]}}]}}"#
    ));
    assert!(
        codes(&traced).is_empty(),
        "同じ文書のどこかに trace があれば当てたとみなす（表の行だけを直す決定がある）"
    );
}

#[test]
fn decision_naming_only_fixed_items_is_not_checked() {
    let f = facts(
        r#"{"docs":[{"key":"specifications/c","fixed":true,"sections":[{"key":"SP-C-003","id":"SP-C-003","body":"x"}]}],
            "decisions":[{"id":"D-015","named":["SP-C-003"]}]}"#,
    );
    assert!(codes(&f).is_empty());
}

#[test]
fn abbreviated_id_is_reported_with_the_full_id() {
    let f = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[
              {"key":"specifications/a§検証方法","body":"| SP-A-028 | RUN048 の結果、BPRUN047 も |","ids":["SP-A-028"]}]},
            {"key":"specifications/r","fixed":true,"sections":[{"key":"SP-BPRUN-048","id":"SP-BPRUN-048","body":"x","ids":["SP-BPRUN-047"]}]}]}"#,
    );
    assert_eq!(
        codes(&f),
        vec![
            (
                "ABBREV_ID",
                vec![
                    "specifications/a§検証方法".into(),
                    "RUN048".into(),
                    "SP-BPRUN-048".into()
                ]
            ),
            (
                "ABBREV_ID",
                vec![
                    "specifications/a§検証方法".into(),
                    "BPRUN047".into(),
                    "SP-BPRUN-047".into()
                ]
            ),
        ]
    );
}

#[test]
fn abbreviation_without_a_single_matching_id_is_not_reported() {
    // 当たる ID が無い語（HTTP200 など）や、2 つ以上に当たる語は、どれの略記か決まらないので拾わない。
    let f = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[{"key":"SP-A-001","id":"SP-A-001","body":"HTTP200 と RUN048"}]},
            {"key":"specifications/r","fixed":true,"sections":[{"key":"SP-BPRUN-048","id":"SP-BPRUN-048","body":"x","ids":["SP-XRUN-048"]}]}]}"#,
    );
    assert!(codes(&f).is_empty());
}

#[test]
fn abbreviation_in_a_fixed_doc_is_not_reported() {
    let f = facts(
        r#"{"docs":[{"key":"specifications/c","fixed":true,"sections":[{"key":"SP-C-001","id":"SP-C-001","body":"BPRUN048 を見る"}]},
            {"key":"specifications/r","sections":[{"key":"SP-BPRUN-048","id":"SP-BPRUN-048","body":"x"}]}]}"#,
    );
    assert!(codes(&f).is_empty());
}

#[test]
fn doc_condition_differing_from_its_flow_decision_is_reported() {
    let f = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[{"key":"SP-A-046","id":"SP-A-046","body":"",
              "conditions":[{"name":"resumes","values":["無い","停止の記録がある","停止の記録が無い","それ以外"]}]}],
            "trace":[{"item_id":"SP-A-046","kind":"flow","ref":"F-051"}]}],
            "flow":[{"id":"F-051","inputs":[{"name":"resumes","values":["無い","停止の記録がある","停止の記録が無い"]}]}]}"#,
    );
    assert_eq!(codes(&f)[0].0, "DOC_FLOW_TABLE");
    let same = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[{"key":"SP-A-046","id":"SP-A-046","body":"",
              "conditions":[{"name":"resumes","values":["停止の記録がある","無い"]}]}],
            "trace":[{"item_id":"SP-A-046","kind":"flow","ref":"F-051"}]}],
            "flow":[{"id":"F-051","inputs":[{"name":"resumes","values":["無い","停止の記録がある"]}]}]}"#,
    );
    assert!(codes(&same).is_empty(), "並びが違うだけなら同じ集合");
}

#[test]
fn glossary_row_pointing_to_a_definition_needs_the_term_there() {
    let f = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[
              {"key":"SP-A-041","id":"SP-A-041","body":"作業記録は書き込みに含める。"},
              {"key":"SP-A-042","id":"SP-A-042","body":"作業記録の 担当 は役と項目の組とする。"}],
            "glossary":[{"section":"specifications/a§用語定義","term":"作業記録の担当","target":"SP-A-041"},
                        {"section":"specifications/a§用語定義","term":"作業記録の担当","target":"SP-A-042"}]}]}"#,
    );
    assert_eq!(
        codes(&f),
        vec![(
            "GLOSSARY_BACKREF",
            vec![
                "specifications/a§用語定義".into(),
                "作業記録の担当".into(),
                "SP-A-041".into()
            ]
        )],
        "空白を詰めて照らすので SP-A-042 は当たる"
    );
}

#[test]
fn changed_item_referencing_a_held_item_without_the_hold_is_reported() {
    let f = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[
              {"key":"SP-A-007","id":"SP-A-007","body":"SP-A-046 と同じく一覧を読む。","ids":["SP-A-046"]},
              {"key":"SP-A-008","id":"SP-A-008","body":"SP-A-046 の裁定が下るまで一覧を使ってはならない。","ids":["SP-A-046"]},
              {"key":"SP-A-009","id":"SP-A-009","body":"SP-A-046 を見る。","ids":["SP-A-046"]}]}],
            "holds":[{"id":"RS-033","item_ids":["SP-A-046"]}],"changed":["SP-A-007","SP-A-008"]}"#,
    );
    assert_eq!(
        codes(&f),
        vec![(
            "HOLD_PROPAGATION",
            vec!["SP-A-007".into(), "SP-A-046".into(), "RS-033".into()]
        )]
    );
}

#[test]
fn field_described_only_by_labels_is_reported() {
    let f = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[
              {"key":"SP-A-046","id":"SP-A-046","body":"検証役は `checkedRoleLimits` に、役の名前・制限の中身・配布先・結果の 4 項目で返す。"},
              {"key":"SP-A-047","id":"SP-A-047","body":"`checkedRoleLimits` の要素は `role`・`restriction`・`host`・`result` の 4 項目とする。"},
              {"key":"SP-A-048","id":"SP-A-048","body":"`x` は a・b・c・d・e・f・g・h・i・j・k・l の 12 項目を持つ。"}]}]}"#,
    );
    assert_eq!(
        codes(&f),
        vec![
            (
                "FIELD_SPELLING",
                vec!["SP-A-046".into(), "checkedRoleLimits".into(), "4".into()]
            ),
            (
                "FIELD_SPELLING",
                vec!["SP-A-048".into(), "x".into(), "12".into()]
            ),
        ]
    );
}

#[test]
fn field_count_defined_elsewhere_or_without_labels_is_not_reported() {
    let f = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[
              {"key":"SP-A-001","id":"SP-A-001","body":"SP-C-020 の 4 項目で `residualRisks` に載せる。"},
              {"key":"SP-A-002","id":"SP-A-002","body":"`residualRisks` は配布先を持たない 2 項目を含めない。"},
              {"key":"SP-A-003","id":"SP-A-003","body":"`a`・`b`・`c` の 3 項目を返す。"}]}]}"#,
    );
    assert!(codes(&f).is_empty());
}

#[test]
fn fixed_docs_are_not_checked_for_their_own_text() {
    let f = facts(
        r#"{"docs":[{"key":"specifications/c","fixed":true,"sections":[
              {"key":"SP-C-001","id":"SP-C-001","body":"`x` を役・中身・先の 3 項目で返す。"}],
              "glossary":[{"section":"specifications/c§用語","term":"無い語","target":"SP-C-001"}]}]}"#,
    );
    assert!(codes(&f).is_empty());
}
