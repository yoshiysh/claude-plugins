# Codex Workflow 互換契約

create / review / update の active `Workflow(...)` callsite に到達した場合だけ読む。

## 共通 route

**経路選択は `scripts/select_runtime.js` が決める。** 下の 1-3 はその判定の根拠（なぜそう
決まるか）で、判定そのものを散文から読み取って自己適用しない。散文の分岐条件として置くと、
「未試行か」「何回試したか」という状態を司令塔の記憶が追うことになり、同じ呼び出しでも
実行のたびに経路がブレる。

```bash
node [SKILL_DIR]/scripts/select_runtime.js \
  --mode create|review|update \
  --native-available|--no-native [--native-attempted] \
  --runner-installed|--no-runner
# → { "selected_runtime": "native" | "dynamic-workflow-runner" | null,
#     "rejected_reason": null | "...", "halt": true|false }
```

`halt: true` なら execution agent を 1 体も起動せず、`rejected_reason` をそのまま伝えて止める。
`selected_runtime` の値を Workflow 呼び出しにそのまま使う（読み替えない）。

1. 現在の tool inventory に native `Workflow` があり、この call が未試行なら native を1回だけ使う。
2. native が存在しない Codex では、対応 mode に `workflow:dynamic-workflow-runner` を内部互換層として利用し、ユーザーに runner の指定を求めない。review / update は runner で拒否する。
3. native を試行後に error / timeout / invalid result となった call は runner へ fallback しない。
   **理由**: native はどの phase まで進んだか（どの副作用が残っているか）を呼び出し側から
   確定できず、同じ call を runner で再実行すると部分実行の上に二重実行が重なる。加えて
   human gate の所有が native 側と runner 側に分かれ、どちらが承認を持つのかが決まらない。
4. caller root、callsite の exact script path と args、前後 phase、human gate の所有権を runner へ渡す。
5. `workflow_complete` と final verification に結合した verified return だけで成功後 phase を再開する。runner 未install、`unsupported_runtime`、`rejected_source`、`workflow_incomplete` では成功後 phase を開始しない。

## create mapping

- caller の前処理は Phase 1、成功後処理は Phase 5。
- Phase 1 のペルソナ承認と Phase 5 の保存承認は caller が所有し、runner 内 gate に移さない。
- create source内の固定model identityは分岐・上限・schema・返却式を決めないscheduling hintであり、sourceの
  machine-readable declarationに列挙されたcallsiteだけCodex翻訳時にdropできる。役割とresult contractを保存するが、
  provider/model差による品質同等性は保証しない。未列挙model callsiteが1つでもあれば`rejected_source`。
- verified returnは草稿を返すだけで保存権限ではない。hash-bound action packageを生成・再検証・read-backできる
  caller-owned executorが無いCodex環境では、草稿と保存候補を提示して停止し、保存済みと報告しない。

## review / update mapping

runner で拒否される mode の**正本は `scripts/select_runtime.js` の `RUNNER_REJECTED_MODES`**。
以下は拒否理由で、判定は script が返す。

- caller の前処理は Phase 1、成功後処理は Phase 3。
- Phase 1 の対象・範囲・意図確認と、update 時の Phase 3 適用承認は caller が所有し、runner 内 gate に移さない。
- `mode: review` は現行runnerでは `rejected_source` とする。対象skill treeはruntimeで決まり、full/diffとも
  file inventory、件数/bytes上限、各content hash、git diff snapshotがcall receiptに無い。finder/refuterがlive treeを
  暗黙入力として読むmanifestへ変換してはならない。
- `mode: update` は Codex runner で常に `rejected_source` とする。staging だけに書ける workspace 境界、
  追加・削除を含む action manifest、late side-effect を隔離する timeout 境界、caller が承認後に適用する
  経路が未完成である。能力の自己申告だけではこれらを保証できず、generic `workspace-write` への
  自動縮退も許可しない。native Workflow は native の経路として選択する。
