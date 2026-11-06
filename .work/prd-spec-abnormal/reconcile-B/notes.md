# 照合役 B の notes

## 仮説の成否

| # | 仮説 | 結果 | 根拠 |
|---|---|---|---|
| 1 | 中断点で無応答のときが未定義（TBD-SFLOW-008） | 未確認（担当外） | flow.md は A の担当。B の担当文書からの受け渡しには現れない |
| 2 | 「迷ったら確認」後の扱いと状態が無い | 成立 → B-005（実装側の欠落は下の「実装の追加所見」） | verification SP-045・elicitation SP-046 の確認を受ける状態・イベントが flow の軸に無い（文書生成中×E3 は「応答を待たない」）。応答後は TBD-SVERIFICATION-012・TBD-SELICITATION-017（いずれも blocking） |
| 3 | verification の「検査不能」「残った指摘」を flow が受ける項目が無い | 成立 → B-004 | flow.md を grep（検査不能・残った指摘・検査記録・残件）。残件は SP-FLOW-045 の着手不能 TBD だけ |
| 4 | SP-FLOW-045 と PR-CONSUMER-007 の矛盾 | 未確認（担当外） | flow.md・consumer.md の内部は A の担当 |
| 5 | SP-FLOW-047（任意）と SP-VERIFICATION-039（必須）の強さの違い | 一部成立 → B-006 | 強さの違い自体は flow.md:384-386 が範囲を分けて独立に数えると明記しており、それだけでは矛盾でない。欠陥は上限超過後の帰結（SP-FLOW-033 の run 終了 と SP-VERIFICATION-044 の未実施記録・続行）が同じ事象に掛かること |
| 6 | 保持規則と Issue の経路が文書に無い | 成立 → B-018（保持規則を作る条件の食い違いは B-017） | 6 文書・tbd.json・INDEX 2 本を grep（Issue・issue・起票先・裁定）。裁定は authoring.md:376・605 だけ |
| 7 | elicitation の状態×イベント表に未定義 10 行 | 成立 → B-001、cells.tsv | 3 状態 × 7 イベント = 21 組。表 19 行 + 図の主フロー 2 組。❌ は 10 行（未確定 E4・E7、確定 E1・E4・E5・E7、保留 E1・E2・E4・E7）。発生しない 2 行、✅ 7 行（うち 3 行は引用先が状態を覆わない: B-002） |
| 8 | PR-CONSUMER-014・032 が未定義 | 成立 → B-019 | consumer.md の `#### PR-CONSUMER-` は 001〜013・015・017〜031。requirements/INDEX.md:12 は「001〜031、欠番は 014・016」。014 は欠番の参照、032 は存在しない番号 |
| 9 | error を blocked に変える式が段ごとに 2 通り | 未確認（担当外） | prd-spec.js の段の制御は A の担当。B が読んだ範囲（notRun・once・issue・finalHold）では、notRun は rerunStage 付き、finalHold は next_args 無し（stage null）の blocked を返す 2 系統があることだけ見た |

## 実装の追加所見（findings に入れた行の補足）

- verification SP-043・SP-045（同一性を判定できないとき同一とみなさず依頼者に確認）を担う監査役の指示は `agents/cross-doc.md` に無い（全 49 行を読んだ。矛盾・重複・用語の揺れの節に「迷ったら」の扱いが無い）。B-005 の受け手欠落と同根なので独立の行にしていない。
- prd-spec.js に `not_checked` の参照は 0 件（grep）。B-012 の根拠。
- brief-B の受け渡し項目「問いの回答の検査落ち」は B-027（一部無回答の出し直しと、回答の反映が検証に落ちたときの問い・保持規則への変換）。flow の回答待ち 2 状態の行（flow.md:502-509・518-525）に対応イベントは無い。
- 「無い」と判定した行（B-004・005・014・015・018・019・020・021・025・027）は rationale に grep の語と対象（6 文書・INDEX 2 本・tbd.json）を書いた。

## 見なかった範囲

- 文書: flow.md・requester.md・consumer.md は受け渡し項目の有無を確かめる範囲だけ読んだ（flow.md:36-44・55-90・255-310・376-470・470-517、consumer.md:95-146・184-201、requester.md は grep のみ）。内部の欠陥は A の担当として見ていない。INDEX 2 本は grep のみ（行 12 など該当行だけ）。
- 担当 3 文書（verification・elicitation・authoring）と各 .tbd.json は全文を読んだ。
- 実装: prd-spec.js は 50-62・612-630・660・1145-1200・1290-1300・2160-2195・2405-2420・2660-2735・2950-3040 だけを読んだ。段 1〜4・3a/3b/6 の本体と settle は読んでいない。doc_check.mjs は棚卸し TSV の fail-open・limit・state-check の全行と check-fail の一覧を見た上で、620-660・744-748・858-880・1108-1200・1944-2007・2246-2255・2858-2920・2946-2980・3133-3140・3696-3750・3755-3810・4128-4160 を原文で確認した。agents/ は cross-doc.md だけ、schemas/ は読んでいない。runtime（agent() の schema 検証の出し直し）は読んでいない（B-008 の confidence を medium にした理由）。
- doc_check の check-fail 152 行のうち、担当文書の規定に対応づけて原文まで確かめたのは MODAL・NOUNIT・IDHEADING・TBD_NORESOLVE（degraded）・NO_EVIDENCE・AMBIGUOUS・STATE_*（入口）・PLAN_*・questions の bad・wsIndex。FLOW_*（flow.json の検査）・台帳の reject 群（storedRejects・verbatimRejects・domainAssessmentRejects の大半）は flow・台帳側の検査で担当文書に対応規定が無く、照合していない。

## 判断に迷って入れなかった候補

| 箇所 | 理由 |
|---|---|
| verification SP-038（文書 0 件で検査しない）と doc_check wsDoc の `throw new Error('workspace に文書…がありません')`（3760） | 文書は検査不能で反復を終えるとし、実装は CLI の失敗になる。prd-spec.js が段 5 で文書 0 件に至る経路があるかを読んでおらず、実害が確かめられない |
| doc_check の limit（STDOUT_BUDGET・CONTRACT_BUDGET・SIZE_BUDGET・GAPS_SHOWN・MaxSteps・NC_DTABLE の 4096 通り） | 担当文書に対応する規定は無いが、実行基盤の出力上限か目安で、NC_DTABLE は not_checked に載る（SP-004 に適う）。停止にも無言の対象外にもならない |
| elicitation.md:1-5 の重複した「## 表記規約」と「本文の全文は…保存済み」の一文、`#` タイトルより前に `##` がある | 異常系ではない。SP-AUTHORING-011（`#` は 1 文書に 1 つ、先頭）の自己適用違反の可能性として記録だけする |
| verification の状態×イベント表（4 状態 × 9 イベント = 36 行）の ❌ 3 行（TBD-SVERIFICATION-006・012・014） | TBD として宣言済み。012 は B-005、014 は進行可能。006（同じ指摘の再発）は実装の recurringItems（再発 → decision → hold → 尽きた項目）が既に決めているが、B-009 の上限の食い違いの一部として扱った |
| elicitation SP-ELICITATION-038（分割単位の名前の衝突）の後の扱い | TBD-SELICITATION-018 として宣言済み。実装の衝突時の挙動（plan の検査）を読んでいない |
| authoring の異常系表の「未定義」10 行（505-514） | いずれも TBD を引いて宣言済み。実装が決めてしまっているもの（TBD-001・009・020）は B-022・B-023・B-024 に個別に入れた |
| SP-ELICITATION-010 の「不明」と実装の「未評価」の扱い（質問や open にしない、revisit_when） | 進行可能の TBD-SELICITATION-010 の範囲で、実装が一方を選んだだけ。値の名前の食い違いは B-016 に入れた |
