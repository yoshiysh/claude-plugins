# Codex Workflow 互換契約

create / review / update の active `Workflow(...)` callsite に到達した場合だけ読む。

## 共通 route

1. 現在の tool inventory に native `Workflow` があり、この call が未試行なら native を1回だけ使う。
2. native が存在しない Codex では `workflow:dynamic-workflow-runner` を内部互換層として利用し、ユーザーに runner の指定を求めない。
3. native を試行後に error / timeout / invalid result となった call は runner へ fallback しない。
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

- caller の前処理は Phase 1、成功後処理は Phase 3。
- Phase 1 の対象・範囲・意図確認と、update 時の Phase 3 適用承認は caller が所有し、runner 内 gate に移さない。
- `mode: review` は現行runner v1では `rejected_source` とする。対象skill treeはruntimeで決まり、full/diffとも
  file inventory、件数/bytes上限、各content hash、git diff snapshotがcall receiptに無い。finder/refuterがlive treeを
  暗黙入力として読むmanifestへ変換してはならない。
- `mode: update` は現行runner v1では `rejected_source` とする。sourceはruntimeで決まる複数fileをstaging mirrorへ書き、改稿ごとに
  同じpathを上書きする一方、manifestは全artifact pathの事前列挙と単一ownerを要求する。outer Phase 3の適用gateもsource内packageではない。
  translatorがstaging/action package/gateを捏造すると意味が変わるため、最初のexecution agentを起動しない。
- review/updateはnative Workflowがある環境だけ従来経路を使う。Codexでは別modeへ自動縮退せず、未実施と拒否理由を伝えて止める。
