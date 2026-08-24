# run 表テンプレート

```
## run 表（周回 N / M）
| 条件 | 結果（metric, 向き） | action・コスト | 失敗機序 |
|---|---|---|---|
| A: <label> (n=<measured_n>, 欠測 <unmeasured>) | mean=<mean_score> spread=<spread> | <cost> | <mechanism hint> |
| B: <label> (n=...) | ... | ... | ... |

delta = <delta>（<delta_basis>）→ favored: <favored>   ※ null は「測れていない」であって引き分けではない
criteria_validity: <check.criteria_validity>
confidence: <confidence> — <calibration_notes を 1 文に>
測れていないもの: <check.unmeasured>
切り詰め: <truncations>（無ければ「無し」）
```
数字の後に必ず criteria_validity・confidence・測れていないものを添える。数字だけ出すと強さの較正が読み手に丸投げされる。
