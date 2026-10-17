# Codex Workflow 互換契約

create / review / update / audit の active `Workflow(...)` callsite に到達した場合だけ読む。

## 共通 route

**経路選択は `scripts/select_runtime.js` が決める。** 下の 1-3 はその判定の根拠（なぜそう
決まるか）で、判定そのものを散文から読み取って自己適用しない。散文の分岐条件として置くと、
「未試行か」「何回試したか」という状態を司令塔の記憶が追うことになり、同じ呼び出しでも
実行のたびに経路がブレる。

```bash
node [SKILL_DIR]/scripts/select_runtime.js \
  --mode create|review|update|audit \
  --native-available|--no-native [--native-attempted] \
  --runner-installed|--no-runner [--update-policy-bound] \
  [--snapshot-receipt ABSOLUTE_PATH --snapshot-target CANONICAL_PATH --snapshot-scope full|diff \
    [--snapshot-diff-ref BASE...HEAD]]
# → { "selected_runtime": "native" | "dynamic-workflow-runner" | null,
#     "rejected_reason": null | "...", "halt": true|false,
#     "runner_limits": { ... } when selected_runtime is dynamic-workflow-runner }
```

`halt: true` なら execution agent を 1 体も起動せず、`rejected_reason` をそのまま伝えて止める。
`selected_runtime` の値を Workflow 呼び出しにそのまま使う（読み替えない）。

1. `review` / `audit` / `update` の caller は先に `review-snapshot.mjs prepare` を実行し、その receipt path・canonical target・scope・diff range を selector に渡す。selector は ready receipt と manifest SHA-256 が一致しない限り停止する。
2. 現在の tool inventory に native `Workflow` があり、この call が未試行なら native を1回だけ使う。
3. native が存在しない Codex では、snapshot proof が有効な `review` / `audit` を `workflow:dynamic-workflow-runner` で実行する。update はさらに host-bound policy がある場合だけ選ぶ。ユーザーに runner の指定を求めない。
4. native を試行後に error / timeout / invalid result となった call は runner へ fallback しない。
   **理由**: native はどの phase まで進んだか（どの副作用が残っているか）を呼び出し側から
   確定できず、同じ call を runner で再実行すると部分実行の上に二重実行が重なる。加えて
   human gate の所有が native 側と runner 側に分かれ、どちらが承認を持つのかが決まらない。
5. callsite の qualified name（`skill-creator:skill-creator-build` / `skill-creator:skill-creator-review`）と args、この plugin の canonical root を `trustedPluginRoots` として、前後 phase、human gate の所有権とともに runner へ渡す。review source の `sonnet` / `opus` label は current Codex model への明示的な `modelMap` を要求する（provider 間の同等性は保証しない）。selector の `runner_limits` は Codex runner request の top-level `limits` にそのまま渡す。`args` に移したり数値を再計算したりしない。runner は root の `workflows/` から meta.name で source を解決する。
6. `review-snapshot.mjs verify --receipt <receiptPath>` が `status: verified` を返し、かつ runner が `workflow_complete` と final verification に結合した verified return を返した場合だけ、レビュー結果を信頼して成功後 phase を再開する。runner 未install、`unsupported_runtime`、`rejected_source`、`workflow_incomplete`、snapshot validation failure では成功後 phase を開始しない。

Codex runner に渡す review request は、`limits` と `modelMap` を args の外側に置く。

```javascript
{
  name: "skill-creator:skill-creator-review",
  trustedPluginRoots: ["<skill-creator plugin canonical root>"],
  args: { ...workflowArgs, snapshot: <review-snapshot.mjs prepare output> },
  modelMap: { sonnet: "<explicit Codex model>", opus: "<explicit Codex model>" },
  requirements: ["read-only", "fresh-thread"],
  limits: <select_runtime.js output.runner_limits, unchanged>
}
```

`modelMap` は source role labels を current host で利用できる Codex model へ明示的に結ぶ。`limits` は source fan-out に対する host ceiling で、token 数の上限や品質同等性を表さない。

## create mapping

- caller の前処理は Phase 1、成功後処理は Phase 5。
- Phase 1 のペルソナ承認と Phase 5 の保存承認は caller が所有し、runner 内 gate に移さない。
- create source内の固定model identityは分岐・上限・schema・返却式を決めないscheduling hintであり、sourceの
  machine-readable declarationに列挙されたcallsiteだけCodex翻訳時にdropできる。役割とresult contractを保存するが、
  provider/model差による品質同等性は保証しない。未列挙model callsiteが1つでもあれば`rejected_source`。
- verified returnは草稿を返すだけで保存権限ではない。hash-bound action packageを生成・再検証・read-backできる
  caller-owned executorが無いCodex環境では、草稿と保存候補を提示して停止し、保存済みと報告しない。

## review / update / audit mapping

`review` / `audit` の許可条件は `scripts/review-snapshot.mjs` の target snapshot receipt と
`scripts/select_runtime.js` の proof validation が正本。snapshot validation failure は結果を無効にする。

- caller の前処理は Phase 1、成功後処理は Phase 3。
- Phase 1 の対象・範囲・意図確認と、update 時の Phase 3 適用承認は caller が所有し、runner 内 gate に移さない。
- `review-snapshot.mjs` は target を canonicalize し、sorted regular-file inventory、file / byte caps、各 file の
  SHA-256 を持つ manifest と読み取り専用コピーを作る。symlink、special file、path escape、cap 超過を拒否する。
  `diff` では指定した two-endpoint commit range の diff bytes と target-relative changed paths も保存する。
  Post-run verification は live target、snapshot tree、diff bytes、changed paths を receipt に照合し、1 つでも
  drift すれば結果を信頼しない。
  検証後に保持する必要がなければ `review-snapshot.mjs cleanup --receipt <receiptPath>` で一時コピーを消す。
- Find / Verify の各 agent は `snapshot.snapshotDir` だけを対象として受け取る。diff mode の findings は frozen
  changed paths 内だけ許可される。runner worker の `workingDirectory` は各 fresh thread 専用で、target snapshot
  は `os.tmpdir()/codex-skill-review-<random>/tree` に別置きされ、read-only 権限で作られる。
- `mode: audit` は同梱の `references/prompt-audit.md` を適用するので Codex でも実施できる。Claude-only
  `claude-api` skill に依存しない。criteria / target が利用できない場合は `unavailable` / `unreadable` を
  findings 0 件と混同せず、clean と報告しない。
- `promptAuditExpected` は共有 criteria を実行できる環境かを示す。criteria を同梱するこの Codex route では
  `true` を渡す。`unavailable` は未実施の印であり、no findings にはならない。
- runner が audit criteria を利用できないと報告した場合、Codex caller は `promptAuditExpected: true` を渡すため、
  audit は欠測として扱われる。Find / Reverify の一方だけが欠測なら `review_incomplete` / `reverify_incomplete` になり、
  その観点のない update package を完了扱いにしない。
- `mode: update` は common caller の host が `createWorkflow({ updatePolicy: { targetRoot, stagingRoot }, ... })`
  を静的に束縛したときだけ `--update-policy-bound` を指定できる。request から policy を作ってはならない。
  runtime は capability と policy を execution agent dispatch 前に照合し、target は読み取り専用、write は
  host が選ぶ `stagingRoot/update-<uuid>` 配下の phase に限定する。`args.stagingDir` は受け付けず host が staging を選ぶ。
  Find / Verify / Reverify の role agents は runner の read-only fresh thread で走る。target snapshot は runner の
  per-agent `workingDirectory` と別に置かれ、update draft は host-bound staging workspace に置かれる。
- timeout 後は backend の終了を待ち、quiescence を確認できなければ verified package を返さない。
  Reverify の evidence receipt と staging tree / target tree hash に結合した add/update/delete manifest を
  `action_package_path` と `action_package_sha256` で返す。caller は承認後に
  `scripts/apply-update-package.mjs` だけで再 hash 検証と置換・rollback を行い、手動コピーへ縮退しない。
