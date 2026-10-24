---
name: repo-implement
description: >
  yoshiysh/claude-plugins リポジトリの中で、コード・スクリプト・テスト・スキル・文書の実装・バグ修正・挙動の変更・リファクタを
  頼まれたら使うこと。依頼をそのまま書き始めず、条件ごとのケース計画を含む計画を planner が立てて別の plan-reviewer が照らし、
  承認後に implementer だけが書き、CLI が check を固定の argv で実測し、repo-review の独立レビューと上限つきの修正ループを経て、
  作業ツリーが最後に check とレビューを通した状態のままかを CLI が照合してから報告する。
  「この関数のバグを直して」「この CLI に option を足して」「この SKILL.md の手順を直して」「このスクリプトをリファクタして」を、
  このリポジトリについて頼まれたら使う（Use when implementing, fixing, or refactoring code, tests, skills, or docs in the yoshiysh/claude-plugins repository）。
  対象外: 新しいスキルの作成や best-practices への適合の評価・改稿（skill-creator-best-practices）、変更のレビューだけ（repo-review）、
  PR のレビュー指摘への対応（address-review）、PRD・仕様書の作成（prd-spec）、別のリポジトリでの実装。
---

# Repo implement

## 目次

- [目的と段](#目的と段)
- [開始: 状態を固定する](#開始-状態を固定する)
- [計画と計画のレビュー](#計画と計画のレビュー)
- [受け入れと開始時の check](#受け入れと開始時の-check)
- [実装](#実装)
- [check と修正ループ](#check-と修正ループ)
- [独立レビュー](#独立レビュー)
- [最終照合と報告](#最終照合と報告)

## 目的と段

このリポジトリの変更を、計画 → 独立の計画レビュー → 実装（コードとテスト）→ 実測の check → 独立レビュー → 上限つきの修正で進める。決められる処理（状態の固定・変更の照合・check の実行・最終の照合）は `scripts/implement-cli.mjs` が行い、計画・照合・実装・レビューは別々の agent が行う。司令塔（このスキルを読む session）は agent に振り、返り値を手を加えずに CLI と次の段へ写すだけで、成果物（コード・テスト・文書）を書かず、計画やレビューの合否を自分で決めない（司令塔の手修正は検証を通らずに成果物へ届く）。

| 段 | 担い手 | 書き込み |
| --- | --- | --- |
| 開始 | CLI `start` | repo の外の `stateDir` だけ |
| 計画 | 計画の Workflow（planner → plan-reviewer） | 無し |
| 受け入れ・開始時の check | CLI `inventory`・`run-checks` | `stateDir` だけ |
| 実装・修正 | 実装の Workflow（implementer だけ） | 作業ツリー |
| check | CLI `run-checks`（plan の check を固定の argv で実行） | check が書くもの |
| レビュー | `repo-review` スキル（working_tree モード） | 無し |
| 最終照合 | CLI `verify` | 無し |

書き込みのできる run には implementer だけを置く。runner は役ごとに書き込みの権限を分けられないので、同じ run に計画やレビューの役を置くと、その役も書けてしまう。commit・push・PR の作成は利用者が頼んだときだけ行い、merge はしない。

CLI の入力は stdin の JSON、出力は 1 行の JSON。`ok: false` は拒否で、`code` と `reason` を持つ（`E_INPUT` は入力の形・sum の不一致、`E_PIN` は始められない状態、`E_CHECK` は許可されない check、`E_STATE` は段の順の誤り、`E_IO` は git やファイルが読めない）。拒否されたら次の段へ進まず、`reason` を報告する。

## 開始: 状態を固定する

1. 依頼・Issue・要求文書から、外から確かめられる期待の挙動と守る性質を把握する。対象か期待が一意に決まらず、公開の契約・データの損失・互換性に複数の妥当な選択肢があるときだけ、根拠と選択肢を示して利用者に確かめる。
2. `mktemp -d` で repo の外に `stateDir` を作り、次を流す。`policyRef` は主ブランチの先端（`origin/main`）。

   ```bash
   node [SKILL_DIR]/scripts/implement-cli.mjs start <<'JSON'
   {"repo": "<作業ツリーの絶対パス>", "stateDir": "<stateDir>", "policyRef": "origin/main"}
   JSON
   ```

   CLI は HEAD と policyRef の完全な SHA、開始時の staged・unstaged・untracked の path（`preservedPaths`）と内容の digest、作業ツリーの snapshot を記録する。`main` の上では `E_PIN` で拒否するので、作業 branch を用意してからやり直す。出力の `state`・`state_sum`・`state_path` を以後の全ての段に手を加えずに写す（写し間違いは sum で拒否される）。

## 計画と計画のレビュー

> **透過実行 route**: 現在の tool inventory に native `Workflow` があり、この call が未試行なら
> native を 1 回だけ使う。native が存在しない Codex では `workflow:dynamic-workflow-runner` を
> 内部互換層として使い、ユーザーに runner の指定を求めない。native を試行後に error / timeout /
> invalid result となった場合は runner へ fallback しない。human gate は無し。caller が所有する
> 前処理は「開始: 状態を固定する」、成功後処理はこの節の status の表。runner の verified return 以外で
> 成功後処理へ進まず、runner 未 install・`unsupported_runtime`・`rejected_source`・`workflow_incomplete` はそのまま報告する。
>
> **Codex classification: read-only supported**。runner request の `requirements` と `limits` は source の
> `meta.requirements`・`meta.limits` をそのまま使い、SKILL.md に値を写さない。source が `agent()` に渡す
> model 名（source の `ROLE_MODELS`）の全てに runner の `modelMap` を明示する。worker の `cwd` は repo にする。

```js
Workflow({
  scriptPath: "[SKILL_DIR]/scripts/plan.js",
  args: { skillDir: "[SKILL_DIR]", request: "<利用者の依頼の文>", state: <start の state>, stateSum: "<state_sum>" }
})
```

`skillDir` はこのスキルの実ディレクトリの絶対パス（Workflow source は自分の位置を解決できない）。計画し直すときは `replanContext` に、前の計画と、その外を指した確定指摘（実装の Workflow の `findingsOutsidePlan`）を手を加えずに足す。

planner は影響する path・守る性質・手順・追加の check と、変更の条件ごとの **ケース計画**（条件 → ケースの対応表。各ケースの観点・検証層・入力と期待値、観点ごとの不適用の理由、カバーできない条件の理由）を返す。形の正本は Workflow source の schema と `agents/planner.md`。script はケース計画の形（観点ごとにケースか不適用の理由のどちらか一方、未カバーは理由つき、どの条件にも結び付かないケースが無い）を検査し、必須の check を足す。plan-reviewer は計画を依頼・既存の契約と照らし、ケース計画を条件の取りこぼし・観点の未検討・実装から取った期待値で照合する。

| status | 司令塔の処理 |
| --- | --- |
| **approved** | 返り値の `plan` と `plan_sum` を手を加えずに次の段へ写す |
| **no_change** | 受け入れ（次の節の 1）と `verify` だけを流し、計画の根拠（`no_change_reason` と plan-reviewer の `evidence`）を示して「変更不要」と報告する |
| **needs_human_decision** | `questions` と判断の材料を示して止まる。回答を依頼の文に足して計画からやり直す |
| **needs_isolated_worktree** | `preservedOverlaps` を示して止まる。開始時の変更を動かさないまま、開始時の HEAD から別の worktree を用意するか、利用者に確かめる |
| **blocked** | `issues`・`test_plan_review` を示して止まる |
| **incomplete** | `reason`（と `problems`）を示して止まる。成功として扱わない |

## 受け入れと開始時の check

1. **受け入れ**: `implementation` を付けずに `inventory` を流す。CLI は plan の path が symlink を通らないこと（通ると書き込みが plan の外の実体の path に現れるか repo の外へ出る）と、plan の check が許可リスト（正本は `scripts/implement-core.mjs` の `MAKE_TARGETS`・`NODE_TEST_SUFFIX`・`REQUIRED_CHECKS`）にあることを確かめ、`admitted: true` のときだけ plan を記録する。`false` なら `problems` の理由で計画し直す（許可リストに無い check が要るなら、利用者に手で実行するか見送るかを確かめる）。

   ```bash
   node [SKILL_DIR]/scripts/implement-cli.mjs inventory <<'JSON'
   {"statePath": "<state_path>", "stateSum": "<state_sum>", "plan": <plan>, "planSum": "<plan_sum>"}
   JSON
   ```

2. **開始時の check**: 同じ入力に `"phase": "baseline"` を足して `run-checks` を流す。実装の後に失敗した check が変更の起こしたものかを、CLI がこの記録と照らして決める。まだ無いテストの check は `not_run` として記録される。`make test` は数分かかり、shell の前景の実行の時間上限を超え得るので、`run-checks` は background で実行して終了を待つ（途中で打ち切ると記録が残らず、その段をやり直すことになる）。

## 実装

> **透過実行 route**: 現在の tool inventory に native `Workflow` があり、この call が未試行なら
> native を 1 回だけ使う。native が存在しない Codex では `workflow:dynamic-workflow-runner` を
> 内部互換層として使い、ユーザーに runner の指定を求めない。native を試行後に error / timeout /
> invalid result となった場合は runner へ fallback しない。human gate は無し。caller が所有する
> 前処理は「受け入れと開始時の check」、成功後処理は「check と修正ループ」。runner の verified return 以外で
> 成功後処理へ進まず、runner 未 install・`unsupported_runtime`・`rejected_source`・`workflow_incomplete` はそのまま報告する。
>
> **Codex classification: workspace-write required**。host が `workspace-write` を許可したときだけ動き、許可が無ければ
> runner が最初の agent の前に拒否する（source の要求だけで権限は上がらない）。`requirements`・`limits`・`modelMap` の扱いは計画の Workflow と同じ。worker の `cwd` は repo にする。

```js
Workflow({
  scriptPath: "[SKILL_DIR]/scripts/implement.js",
  args: { skillDir: "[SKILL_DIR]", state: <start の state>, stateSum: "<state_sum>", plan: <plan>, planSum: "<plan_sum>", repairRound: 0 }
})
```

最初の実装は `repairRound: 0` で、修正の入力を渡さない。修正の回は同じ call に、`repairRound` を 1 増やした値と、次のどちらかを足す。

- `checkRun`・`checkRunSum`: 実装の後の `run-checks` の出力の `run` と `run_sum`。script は `repairable: true`（開始時に成功していた check の失敗）の結果だけを implementer に渡す。
- `reviewFindings`: repo-review の返り値の `findings`（確定した指摘）。script は確定していない指摘を拒否し、計画の外か対象の外を指す指摘があれば implementer を起動せずに `needs_replan` を返す。

**どの status でも**、返り値をそのまま `implementation` に入れて `inventory` を流す（受け入れと同じ入力に `"implementation": <返り値>`）。CLI は round を記録し（round は 0 から 1 ずつ増え、戻すと `E_STATE` で拒否する）、開始時の HEAD からの実際の変更を plan の path・touched_paths の和・preservedPaths の不変と照らす。`passed: false` なら `problems` を報告して止まる（plan の外の変更や申告漏れを司令塔が戻さない。戻すのは破壊的な操作で、利用者が決める）。

| status | 司令塔の処理 |
| --- | --- |
| **ready_for_check** | 実装の Workflow の実行が終わったことだけを表す。次の節の check へ進む |
| **no_change** | 最初の実装なら `verify` を流して「実装不要」と報告する |
| **needs_replan** | `findingsOutsidePlan` を `replanContext` に入れて計画からやり直す（round は戻さない） |
| **blocked**・**incomplete** | `reason` と、ケースのテストの欠け（`caseTestGaps`）・未解決（`implementation.unresolved`）を示して止まる |

## check と修正ループ

1. 受け入れと同じ入力に `"phase": "after"` を足して `run-checks` を流す。CLI は plan の check を 1 件ずつ固定の argv で実行し、command・exit code・HEAD・出力の末尾と、実行の前後の snapshot を記録する。モデルの文や PR のコメントを shell に渡さない。
2. `passed: true` なら独立レビューへ進む。`repairable: true` の失敗があれば、`run`・`run_sum` を渡して修正の回を流す。`failed_at_baseline` が `true` か `null`（開始時に実行していない）の失敗は今回の変更が起こしたと決められないので直さず、原因を切り分けられなかったこととして報告する。
3. 修正の回の上限は、実装の Workflow source の定数 `MAX_REPAIR_ROUNDS` で、check の修正とレビューの修正の合計で数える。上限を超える `repairRound` は script が implementer を起動する前に拒否する。上限に達しても失敗・確定指摘・未検証が残るなら、残ったものを示して未完了として報告する。
4. 修正の回の後は、毎回この節の 1 から（check の全件と独立レビューを）やり直す。

## 独立レビュー

check が通ったら、`repo-review` スキルを**スキル呼び出し**で起動し、working_tree モードで、baseRef と headSha に `state.head`、policyRef に `state.policyRef`、preservedPaths に `start` の出力の `preservedPaths` を渡してレビューさせる（repo-review の前処理と Workflow の呼び方は repo-review の SKILL.md が正本）。返り値をそのまま `record-review` に渡す。

```bash
node [SKILL_DIR]/scripts/implement-cli.mjs record-review <<'JSON'
{"statePath": "<state_path>", "stateSum": "<state_sum>", "review": <repo-review の返り値>}
JSON
```

- `findings` があれば、それだけを `reviewFindings` に入れて修正の回を流す。`refuted` は直さない。
- `review_incomplete` や `unverified` が残るときは、レビューが通ったことにしない。司令塔の読み直しを独立レビューの代わりにしない（自分の読みは生成と同じ視点で、欠陥が見えない）。

## 最終照合と報告

受け入れと同じ入力で `verify` を流す。CLI は記録だけを使い、HEAD が開始時のまま、実際の変更が plan と touched_paths の和に収まり、preservedPaths が変わらず、最後の round の後の check が全て成功し、最後のレビューが確定指摘も未検証も無く通り、今の snapshot が最後に check とレビューを通した時点と一致することを照らす。`passed: true` のときだけ完了として報告する。

報告に書くもの: 変更の内容と path、ケース計画（条件ごとのケースとテストの所在、不適用の理由、未カバーの条件と理由）、check ごとの argv と exit code、レビューの対象・観点・確定・棄却・未検証の件数、修正の回数、`verify` の `problems`、実行していない確認と残した判断。成功していないものを成功として書かない。

commit を頼まれたときは、commit の直前に `verify` を流し、`passed: true` のときだけ commit する。`false` なら commit せず、check とレビューからやり直す。
