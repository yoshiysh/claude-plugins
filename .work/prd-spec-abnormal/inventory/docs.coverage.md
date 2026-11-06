# docs 棚卸しの coverage

## 読んだ範囲（全文を読んだ）

- docs/requirements/requester.md（371 行）、docs/requirements/consumer.md（297 行）
- docs/specifications/flow.md（636 行）、verification.md（462 行）、elicitation.md（400 行）、authoring.md（629 行）
- 隣の .tbd.json 6 本（requester / consumer / flow / verification / elicitation / authoring）の全 TBD
- 機械照合: 6 文書の `#### PR-*` / `#### SP-*` の見出し集合に対する参照の切れ、tbd.json の ID と本文参照の突き合わせ、各文書のトレーサビリティ表に現れない要求・仕様項目の有無

## 読めなかった・読まなかった範囲

- docs/requirements/INDEX.md、docs/specifications/INDEX.md（指示の対象外。本文書群は INDEX を一式の一部として参照する）
- 同じディレクトリの他文書（formal-methods.md、bp-*.md、develop-*.md、cleanup.md）は対象外のため未読
- plugins/ 配下の実装・SKILL.md は対象外のため未読。docs/specifications 側の文面だけを根拠にしている

## docs.tsv の作り方

- condition / outcome は各文書からの逐語引用。改行・空白を除去した文字列で原文との一致を機械検証済み（197 行全件が一致）
- doc:line は condition（無ければ outcome）の開始行
- TBD 行（kind=tbd）は tbd.json の text をそのまま condition に入れ、blocking 値と本文参照元を note に記載
- kind の付け方は担当者の分類。ask は依頼者への確認・提示、hold は推測禁止・再質問禁止・保持規則・起票、limit は上限・残件、fail は失敗・未実施・中断、retry は作り直し・再検査・やり直し、resume は引き継ぎ・次の実行、stop-blocked は作成や保存に入らない規範文

## 機械照合で得た事実（本文に書かれていること）

- 参照先が定義されていない ID: PR-CONSUMER-014（authoring.md 547・592 行）、PR-CONSUMER-032（verification.md の SP-VERIFICATION-010 の行）。consumer.md の `####` 見出しは 001-013・015・017-031
- 本文から参照されていない TBD: TBD-RREQUESTER-011、TBD-RREQUESTER-017、TBD-RCONSUMER-014、TBD-SELICITATION-005、TBD-SELICITATION-014（いずれも tbd.json のみ）
- トレーサビリティ表に現れない PR-* と SP-* は 0 件

## 判断に迷って入れなかった候補

| doc:line | 理由 |
|---|---|
| requester.md PR-REQUESTER-013 | 判定方法の規範。迷う場合の確認は PR-REQUESTER-037・040 の行で扱った |
| flow.md:177 SP-FLOW-007（対応する語が無いことは非着手の理由にならない） | 両方作成する定義済みの正常系エッジ。停止ではない |
| flow.md SP-FLOW-022 | 完成判定の正常系。上限到達側は SP-FLOW-045 の行で扱った |
| flow.md SP-FLOW-025・026・036 | 保存前提示と書き込みの正常系 |
| flow.md 状態 × イベント表の E4 各行 | SP-FLOW-033 の行にまとめて記載 |
| flow.tbd.json TBD-SFLOW-012・TBD-SFLOW-024 | 中間生成物の置き場、進行可能の提示。停止条件・結果に直結しないため TBD 行から除外 |
| requester.tbd.json TBD-RREQUESTER-006・014・016 | 分量、外部依存、案件名。TBD-RREQUESTER-014 は flow.md の外部システム行で言及 |
| consumer.tbd.json TBD-RCONSUMER-004・008・009・010・012・013・014 | 生成文書の記述水準・分量の論点。停止・失敗に直結しない |
| verification.tbd.json TBD-SVERIFICATION-003・017 | 再検査の範囲、照合元の入力の範囲。停止条件・結果に直結しない |
| elicitation.tbd.json TBD-SELICITATION-006・007・008・012・014・016 | 分割案・問い・識別子の論点 |
| authoring.tbd.json TBD-SAUTHORING-003・004・010・011・013・016・017・019・020 | 章構成・採番・INDEX 等。異常系表に「未定義」として現れる TBD のみ採録 |
| authoring.md:500-501 異常系表（人物名の役割名化、決定者・期限を持たせない） | 定義済みで、停止や保留を伴わない |
| authoring.md SP-AUTHORING-087・010 | 常設章に材料が無いときの記述の規範。停止ではない |
| elicitation.md:5 | 本文冒頭に「本文の全文は…保存済み」の一文と表記規約の見出しが重複して存在する。異常系ではないため行に入れていない |

## 注意（未実施・未確認）

- 「無い」と書いた箇所（例: flow.md に検査不能・残った指摘を受け取る項目が無い、裁定の起票先が 6 文書に無い）は、6 文書を全文読んだ範囲と、検査・反復・改稿・残った指摘・Issue・裁定・聞き返し の grep に基づく
- INDEX.md と他文書に別の定義がある可能性は確認していない
