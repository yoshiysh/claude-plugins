# doc_check 新規5指摘の判定通知

確認者は bp_docs_scope_review である。親から受け取った通知では、前回の確認対象は SP-BPENTRY-004・019 の2件だけだった。今回、PR-BPDESIGNEDSKILL-010・PR-BPOPERATIONS-038・SP-BPAUTHORING-007 の3件を追加で確認し、現時点で次の5件全てを必須修復不要とする限定判定が通知された。以前から全5件が確認・通知済みだったという記録は訂正する。

資料はPR213修復前に凍結した要求・仕様の該当項目、SP-BPENTRY-008、SP-BPCONFORMANCE-028 と当時のdoc_checkの新規5指摘である。規範本文の版は mechanical-verification.json の historical_before_pr213.sources で特定する。この記録は親の通知の relay であり、本文生成担当の自己合格ではない。現在版への追加承認とは扱わない。

| 検出箇所 | 検出語 | 確認時点 | 通知された判定の範囲と根拠 |
|---|---|---|---|
| PR-BPDESIGNEDSKILL-010 | など | 今回追加 | 生成・検証は理由文中の役割の例。適用する権限の原則は設計方針文書を参照しており、適合範囲をこの例示で決めない |
| PR-BPOPERATIONS-038 | 十分な（不十分な） | 今回追加 | 前件は次機能の必須入力。満たすべき入力はcalleeの契約で決まるため、任意の十分性を追加する意味にしない。仕様のENTRY008もcalleeの入力確認に委ねるよう修復済み |
| SP-BPAUTHORING-007 | まで | 今回追加 | 参照するSP-BPCONFORMANCE-028が最初の1回を含む3回以下と定めている。上限を含む境界が参照先で決まる |
| SP-BPENTRY-004 | など | 前回 | 対象の作成と修正根拠は入出力の依存関係の例。順序決定と確認の条件は依頼の指定・依存・不能・矛盾で定める |
| SP-BPENTRY-019 | など | 前回 | 後方のcreateは依存矛盾の例。規則は全ての指定順と入出力の依存矛盾に適用し、createだけへ限定しない |

今回のdoc_checkは基準版18指摘、現版20指摘。検出IDの比較では新規5件・除去3件・共通15件であり、差分+2を新規欠陥2件と読まない。今回の追加確認は新規5件だけを対象とし、文書全体、共通15件、16のnot_checkedへの追加承認ではない。共通15件と16のnot_checkedを機械的な合格へ変換していない。表は字句flagへの判定であり、未検証の実装動作や文書全体の証明ではない。

PR213最終refreeze後のcurrent JSONでも検出IDは同じ20件だった。現在の唯一の機械出力はdoc-check-current.json、現在のsource hashはmechanical-verification.jsonのsourcesである。この一致は検出IDの照合であり、過去の意味判断を現文書全体の合格へ拡張するものではない。
