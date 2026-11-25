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

// ---- 優先度 2: ROLE_INPUT_COVERAGE・ENUM_SET_MISMATCH（D 段の設計 §2.2・§2.3） ----
// 新しい欄（conditions[].ref・sections[].roles・sections[].uses）は JSON で渡す。今の struct はこれらを読み捨てるので、
// 今の実装でもコンパイルは通り、新しい振る舞いのテストだけが落ちる。

fn only<'a>(
    found: &'a [(&'static str, Vec<String>)],
    code: &str,
) -> Vec<&'a (&'static str, Vec<String>)> {
    found.iter().filter(|(c, _)| *c == code).collect()
}

/// ` / ` でつないだ値を、並びを問わない集合にする（ENUM の「比べた値」の並びは設計が決めていない）。
fn value_set(joined: &str) -> std::collections::BTreeSet<String> {
    joined
        .split(" / ")
        .filter(|x| !x.is_empty())
        .map(String::from)
        .collect()
}

#[test]
fn role_input_missing_from_the_declaration_is_reported() {
    // r2-cd-002 の型: 規則が渡された「前の巡の指摘」を使うのに、検査役の宣言に無い。
    let f = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[
              {"key":"SP-A-001","id":"SP-A-001","body":"","roles":[{"role":"検査役","inputs":["対象の文書","観点の一覧"]}]},
              {"key":"SP-A-005","id":"SP-A-005","body":"","uses":[{"input":"前の巡の指摘","roles":["検査役"]}]}]}]}"#,
    );
    assert_eq!(
        codes(&f),
        vec![(
            "ROLE_INPUT_COVERAGE",
            vec![
                "SP-A-005".into(),
                "検査役".into(),
                "前の巡の指摘".into(),
                "[\"SP-A-001\"]".into()
            ]
        )]
    );
    let declared = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[
              {"key":"SP-A-001","id":"SP-A-001","body":"","roles":[{"role":"検査役","inputs":["対象の文書","観点の一覧"]}]},
              {"key":"SP-A-005","id":"SP-A-005","body":"","uses":[{"input":"観点の一覧","roles":["検査役"]}]}]}]}"#,
    );
    assert!(codes(&declared).is_empty(), "宣言にある入力は拾わない");
}

#[test]
fn role_input_is_resolved_by_the_section_declaring_one_role() {
    // 文に役の名前が無くても、使う区間自身が役を 1 つだけ宣言していれば、その役で照らす。
    let missing = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[
              {"key":"SP-A-001","id":"SP-A-001","body":"","roles":[{"role":"検査役","inputs":["対象の文書"]}],
               "uses":[{"input":"前の巡の指摘","roles":[]}]}]}]}"#,
    );
    assert_eq!(
        codes(&missing),
        vec![(
            "ROLE_INPUT_COVERAGE",
            vec![
                "SP-A-001".into(),
                "検査役".into(),
                "前の巡の指摘".into(),
                "[\"SP-A-001\"]".into()
            ]
        )]
    );
    let present = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[
              {"key":"SP-A-001","id":"SP-A-001","body":"","roles":[{"role":"検査役","inputs":["対象の文書"]}],
               "uses":[{"input":"対象の文書","roles":[]}]}]}]}"#,
    );
    assert!(codes(&present).is_empty());
}

#[test]
fn role_input_not_reported_when_ambiguous_or_undeclared() {
    // 同じ文に役が 2 つ: どの役の入力か決まらない。
    let two = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[
              {"key":"SP-A-001","id":"SP-A-001","body":"","roles":[{"role":"検査役","inputs":["対象の文書"]},{"role":"司令塔","inputs":["記録"]}]},
              {"key":"SP-A-005","id":"SP-A-005","body":"","uses":[{"input":"前の巡の指摘","roles":["検査役","司令塔"]}]}]}]}"#,
    );
    assert!(codes(&two).is_empty(), "役が 2 つ以上なら拾わない");
    // 役が空で、使う区間も役を宣言しない。
    let none = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[
              {"key":"SP-A-001","id":"SP-A-001","body":"","roles":[{"role":"検査役","inputs":["対象の文書"]}]},
              {"key":"SP-A-005","id":"SP-A-005","body":"","uses":[{"input":"前の巡の指摘","roles":[]}]}]}]}"#,
    );
    assert!(
        codes(&none).is_empty(),
        "役を 1 つに決められなければ拾わない"
    );
    // 役の宣言が全文書に無い（既存の文書は全てこれに当たる）。
    let undeclared = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[
              {"key":"SP-A-005","id":"SP-A-005","body":"","uses":[{"input":"前の巡の指摘","roles":["検査役"]}]}]}]}"#,
    );
    assert!(codes(&undeclared).is_empty(), "宣言が無ければ拾わない");
    // 使う側が固定の文書。
    let fixed_use = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[
              {"key":"SP-A-001","id":"SP-A-001","body":"","roles":[{"role":"検査役","inputs":["対象の文書"]}]}]},
            {"key":"specifications/c","fixed":true,"sections":[
              {"key":"SP-C-005","id":"SP-C-005","body":"","uses":[{"input":"前の巡の指摘","roles":["検査役"]}]}]}]}"#,
    );
    assert!(codes(&fixed_use).is_empty(), "固定の文書の規則は拾わない");
    // 宣言が固定の文書にある: 照らす。
    let fixed_decl = facts(
        r#"{"docs":[{"key":"specifications/c","fixed":true,"sections":[
              {"key":"SP-C-001","id":"SP-C-001","body":"","roles":[{"role":"検査役","inputs":["対象の文書"]}]}]},
            {"key":"specifications/a","sections":[
              {"key":"SP-A-005","id":"SP-A-005","body":"","uses":[{"input":"前の巡の指摘","roles":["検査役"]}]}]}]}"#,
    );
    assert_eq!(
        codes(&fixed_decl),
        vec![(
            "ROLE_INPUT_COVERAGE",
            vec![
                "SP-A-005".into(),
                "検査役".into(),
                "前の巡の指摘".into(),
                "[\"SP-C-001\"]".into()
            ]
        )],
        "宣言は固定の文書のものも数える"
    );
}

#[test]
fn role_input_declarations_of_the_same_role_are_merged() {
    // 役ごとの宣言は全文書の同じ役の inputs の和。related は宣言の区間の key の昇順。
    let f = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[
              {"key":"SP-A-009","id":"SP-A-009","body":"","roles":[{"role":"検査役","inputs":["観点の一覧"]}]},
              {"key":"SP-A-001","id":"SP-A-001","body":"","roles":[{"role":"検査役","inputs":["対象の文書"]}]},
              {"key":"SP-A-005","id":"SP-A-005","body":"","uses":[{"input":"観点の一覧","roles":["検査役"]},{"input":"前の巡の指摘","roles":["検査役"]}]}]}]}"#,
    );
    assert_eq!(
        codes(&f),
        vec![(
            "ROLE_INPUT_COVERAGE",
            vec![
                "SP-A-005".into(),
                "検査役".into(),
                "前の巡の指摘".into(),
                "[\"SP-A-001\",\"SP-A-009\"]".into()
            ]
        )]
    );
}

#[test]
fn role_input_matches_after_squashing() {
    // name_key: 空白とバッククォートを除いて照らす。
    let f = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[
              {"key":"SP-A-001","id":"SP-A-001","body":"","roles":[{"role":"検査役","inputs":["観点の 一覧"]}]},
              {"key":"SP-A-005","id":"SP-A-005","body":"","uses":[{"input":"`観点の一覧`","roles":["検査役"]}]}]}]}"#,
    );
    assert!(codes(&f).is_empty());
    let differs = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[
              {"key":"SP-A-001","id":"SP-A-001","body":"","roles":[{"role":"検査役","inputs":["観点の 一覧"]}]},
              {"key":"SP-A-005","id":"SP-A-005","body":"","uses":[{"input":"観点の表","roles":["検査役"]}]}]}]}"#,
    );
    assert_eq!(
        only(&codes(&differs), "ROLE_INPUT_COVERAGE").len(),
        1,
        "綴りが違えば拾う"
    );
}

#[test]
fn enum_reference_without_declaration_is_reported() {
    let f = facts(
        r#"{"docs":[{"key":"specifications/run","sections":[
              {"key":"SP-RUN-010","id":"SP-RUN-010","body":"","conditions":[{"name":"結末","values":[],"ref":"SP-RUN-099"}]}]}]}"#,
    );
    assert_eq!(
        codes(&f),
        vec![(
            "ENUM_SET_MISMATCH",
            vec![
                "unresolved".into(),
                "SP-RUN-010".into(),
                "結末".into(),
                "".into(),
                "".into(),
                "[\"SP-RUN-099\"]".into()
            ]
        )]
    );
    let fixed = facts(
        r#"{"docs":[{"key":"specifications/run","fixed":true,"sections":[
              {"key":"SP-RUN-010","id":"SP-RUN-010","body":"","conditions":[{"name":"結末","values":[],"ref":"SP-RUN-099"}]}]}]}"#,
    );
    assert!(codes(&fixed).is_empty(), "固定の文書の区間は拾わない");
}

#[test]
fn enum_redeclared_with_another_set_is_reported() {
    // r5-im-run-001 の型: 参照される名前を、参照先でない項目が別の値の集合で書き直している。
    let f = facts(
        r#"{"docs":[{"key":"specifications/run","sections":[
              {"key":"SP-RUN-003","id":"SP-RUN-003","body":"","conditions":[{"name":"結末","values":["完了","中断","失敗"]}]},
              {"key":"SP-RUN-010","id":"SP-RUN-010","body":"","conditions":[{"name":"結末","values":["完了","中断","失敗"],"ref":"SP-RUN-003"}]},
              {"key":"SP-RUN-012","id":"SP-RUN-012","body":"","conditions":[{"name":"結末","values":["完了","失敗"]}]}]}]}"#,
    );
    let found = codes(&f);
    assert_eq!(found.len(), 1, "{found:?}");
    let (code, a) = &found[0];
    assert_eq!(*code, "ENUM_SET_MISMATCH");
    assert_eq!(
        (a[0].as_str(), a[1].as_str(), a[2].as_str(), a[3].as_str()),
        ("redeclared", "SP-RUN-012", "結末", "完了 / 失敗")
    );
    assert_eq!(value_set(&a[4]), value_set("完了 / 中断 / 失敗"));
    assert_eq!(a[5], "[\"SP-RUN-003\",\"SP-RUN-010\"]");
    let reordered = facts(
        r#"{"docs":[{"key":"specifications/run","sections":[
              {"key":"SP-RUN-003","id":"SP-RUN-003","body":"","conditions":[{"name":"結末","values":["完了","中断","失敗"]}]},
              {"key":"SP-RUN-010","id":"SP-RUN-010","body":"","conditions":[{"name":"結末","values":["完了","中断","失敗"],"ref":"SP-RUN-003"}]},
              {"key":"SP-RUN-012","id":"SP-RUN-012","body":"","conditions":[{"name":"結末","values":["失敗","完了","中断"]}]}]}]}"#,
    );
    assert!(codes(&reordered).is_empty(), "並びが違うだけなら同じ集合");
}

#[test]
fn enum_split_canonical_sets_are_reported() {
    // 同じ名前の参照先どうしの値の集合が違う。参照する区間ごとに出す。
    let f = facts(
        r#"{"docs":[{"key":"specifications/run","sections":[
              {"key":"SP-RUN-003","id":"SP-RUN-003","body":"","conditions":[{"name":"結末","values":["完了","中断","失敗"]}]},
              {"key":"SP-RUN-004","id":"SP-RUN-004","body":"","conditions":[{"name":"結末","values":["完了","失敗"]}]},
              {"key":"SP-RUN-010","id":"SP-RUN-010","body":"","conditions":[{"name":"結末","values":["完了","中断","失敗"],"ref":"SP-RUN-003"}]},
              {"key":"SP-RUN-020","id":"SP-RUN-020","body":"","conditions":[{"name":"結末","values":["完了","失敗"],"ref":"SP-RUN-004"}]}]}]}"#,
    );
    let found = codes(&f);
    assert_eq!(found.len(), 2, "{found:?}");
    let related = "[\"SP-RUN-003\",\"SP-RUN-004\",\"SP-RUN-010\",\"SP-RUN-020\"]";
    let at = |key: &str| {
        found
            .iter()
            .find(|(c, a)| *c == "ENUM_SET_MISMATCH" && a[1] == key)
            .unwrap_or_else(|| panic!("{key} の split がありません: {found:?}"))
    };
    let (_, a) = at("SP-RUN-010");
    assert_eq!(
        (a[0].as_str(), a[2].as_str(), a[3].as_str(), a[5].as_str()),
        ("split", "結末", "完了 / 中断 / 失敗", related)
    );
    assert_eq!(value_set(&a[4]), value_set("完了 / 失敗"));
    let (_, a) = at("SP-RUN-020");
    assert_eq!(
        (a[0].as_str(), a[2].as_str(), a[3].as_str(), a[5].as_str()),
        ("split", "結末", "完了 / 失敗", related)
    );
    assert_eq!(value_set(&a[4]), value_set("完了 / 中断 / 失敗"));
    let same = facts(
        r#"{"docs":[{"key":"specifications/run","sections":[
              {"key":"SP-RUN-003","id":"SP-RUN-003","body":"","conditions":[{"name":"結末","values":["完了","中断","失敗"]}]},
              {"key":"SP-RUN-004","id":"SP-RUN-004","body":"","conditions":[{"name":"結末","values":["失敗","完了","中断"]}]},
              {"key":"SP-RUN-010","id":"SP-RUN-010","body":"","conditions":[{"name":"結末","values":["完了","中断","失敗"],"ref":"SP-RUN-003"}]},
              {"key":"SP-RUN-020","id":"SP-RUN-020","body":"","conditions":[{"name":"結末","values":["失敗","完了","中断"],"ref":"SP-RUN-004"}]}]}]}"#,
    );
    assert!(codes(&same).is_empty(), "参照先の集合が同じなら拾わない");
}

#[test]
fn enum_not_checked_without_any_reference() {
    // 参照の無い名前の直書きどうしは、文脈の違いと区別できないので見ない（ユーザーの決定）。
    let f = facts(
        r#"{"docs":[{"key":"specifications/run","sections":[
              {"key":"SP-RUN-003","id":"SP-RUN-003","body":"","conditions":[{"name":"結末","values":["完了","中断","失敗"]}]},
              {"key":"SP-RUN-012","id":"SP-RUN-012","body":"","conditions":[{"name":"結末","values":["完了","失敗"]}]}]}]}"#,
    );
    assert!(codes(&f).is_empty());
    // 対照: 同じ 2 つに参照を 1 つ足すと、書き直しとして拾う。
    let referenced = facts(
        r#"{"docs":[{"key":"specifications/run","sections":[
              {"key":"SP-RUN-003","id":"SP-RUN-003","body":"","conditions":[{"name":"結末","values":["完了","中断","失敗"]}]},
              {"key":"SP-RUN-010","id":"SP-RUN-010","body":"","conditions":[{"name":"結末","values":["完了","中断","失敗"],"ref":"SP-RUN-003"}]},
              {"key":"SP-RUN-012","id":"SP-RUN-012","body":"","conditions":[{"name":"結末","values":["完了","失敗"]}]}]}]}"#,
    );
    assert_eq!(only(&codes(&referenced), "ENUM_SET_MISMATCH").len(), 1);
}

#[test]
fn enum_redeclared_in_a_fixed_doc_is_not_reported_but_fixed_declarations_count() {
    // 固定の文書の区間は拾わない。正の集合と参照元は固定の文書のものも数える。
    let fixed_redecl = facts(
        r#"{"docs":[{"key":"specifications/run","sections":[
              {"key":"SP-RUN-003","id":"SP-RUN-003","body":"","conditions":[{"name":"結末","values":["完了","中断","失敗"]}]},
              {"key":"SP-RUN-010","id":"SP-RUN-010","body":"","conditions":[{"name":"結末","values":["完了","中断","失敗"],"ref":"SP-RUN-003"}]}]},
            {"key":"specifications/c","fixed":true,"sections":[
              {"key":"SP-C-012","id":"SP-C-012","body":"","conditions":[{"name":"結末","values":["完了","失敗"]}]}]}]}"#,
    );
    assert!(codes(&fixed_redecl).is_empty());
    let fixed_canon = facts(
        r#"{"docs":[{"key":"specifications/c","fixed":true,"sections":[
              {"key":"SP-C-003","id":"SP-C-003","body":"","conditions":[{"name":"結末","values":["完了","中断","失敗"]}]},
              {"key":"SP-C-010","id":"SP-C-010","body":"","conditions":[{"name":"結末","values":["完了","中断","失敗"],"ref":"SP-C-003"}]}]},
            {"key":"specifications/run","sections":[
              {"key":"SP-RUN-012","id":"SP-RUN-012","body":"","conditions":[{"name":"結末","values":["完了","失敗"]}]}]}]}"#,
    );
    let found = only(&codes(&fixed_canon), "ENUM_SET_MISMATCH")
        .into_iter()
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(
        (
            found[0].1[0].as_str(),
            found[0].1[1].as_str(),
            found[0].1[5].as_str()
        ),
        ("redeclared", "SP-RUN-012", "[\"SP-C-003\",\"SP-C-010\"]")
    );
}

#[test]
fn doc_flow_table_skips_unresolved_reference() {
    // 解けない参照（ref があり values が空）は、空集合と flow の値を比べて偽の指摘を出さない。指摘は ENUM が出す。
    let unresolved = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[{"key":"SP-A-046","id":"SP-A-046","body":"",
              "conditions":[{"name":"resumes","values":[],"ref":"SP-A-099"}]}],
            "trace":[{"item_id":"SP-A-046","kind":"flow","ref":"F-051"}]}],
            "flow":[{"id":"F-051","inputs":[{"name":"resumes","values":["無い","停止の記録がある"]}]}]}"#,
    );
    assert!(
        only(&codes(&unresolved), "DOC_FLOW_TABLE").is_empty(),
        "{:?}",
        codes(&unresolved)
    );
    // 解けた参照は、解いた値で今どおり比べる。
    let resolved = facts(
        r#"{"docs":[{"key":"specifications/a","sections":[
              {"key":"SP-A-010","id":"SP-A-010","body":"","conditions":[{"name":"resumes","values":["無い","停止の記録がある","それ以外"]}]},
              {"key":"SP-A-046","id":"SP-A-046","body":"",
               "conditions":[{"name":"resumes","values":["無い","停止の記録がある","それ以外"],"ref":"SP-A-010"}]}],
            "trace":[{"item_id":"SP-A-046","kind":"flow","ref":"F-051"}]}],
            "flow":[{"id":"F-051","inputs":[{"name":"resumes","values":["無い","停止の記録がある"]}]}]}"#,
    );
    let table = only(&codes(&resolved), "DOC_FLOW_TABLE")
        .into_iter()
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(table.len(), 1, "{table:?}");
    assert_eq!(table[0].1[0], "SP-A-046");
}
