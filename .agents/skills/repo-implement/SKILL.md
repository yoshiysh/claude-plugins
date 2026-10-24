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
  既にあるレビュー結果・PR のレビュー指摘を反映する修正（address-review、汎用のものは workflow:pr-review-fix）、PRD・仕様書の作成（prd-spec）、
  別のリポジトリでの実装。
---

# Repo implement

## 目次

- [目的と段](#目的と段)
- [開始: 状態を固定する](#開始-状態を固定する)
- [計画と計画のレビュー](#計画と計画のレビュー)
- [受け入れと開始時の check](#受け入れと開始時の-check)
- [実装の回](#実装の回)
- [check と修正ループ](#check-と修正ループ)
- [独立レビュー](#独立レビュー)
- [止まるとき](#止まるとき)
- [最終照合と報告](#最終照合と報告)
- [照合しないもの](#照合しないもの)

## 目的と段

このリポジトリの変更を、計画 → 独立の計画レビュー → 実装（コードとテスト）→ 実測の check → 独立レビュー → 上限つきの修正で進める。決められる処理（状態の固定・段の順序・変更の照合・check の実行・修正の入力の選択・最終の照合）は `scripts/implement-cli.mjs` が行い、計画・照合・実装・レビューは別々の agent が行う。司令塔（このスキルを読む session）は段を選び、返り値を手を加えずに CLI と次の段へ写すだけで、成果物（コード・テスト・文書）を書かず、計画やレビューの合否を自分で決めない（司令塔の手修正は検証を通らずに成果物へ届く）。

| 段 | 担い手 | 書き込み |
| --- | --- | --- |
| 開始 | CLI `start` | repo の外の `stateDir` だけ |
| 計画 | 計画の Workflow（planner → plan-reviewer、上限つきで planner に戻す） | 無し |
| 受け入れ・開始時の check | CLI `inventory`・`run-checks` | `stateDir` だけ |
| 実装・修正の回 | CLI `begin-round` → 実装の Workflow（implementer だけ）→ CLI `inventory` | 作業ツリー |
| check | CLI `run-checks`（plan の check を固定の argv で実行） | check が書くもの |
| レビュー | `repo-review` スキル（working_tree モード）→ CLI `record-review` | 無し |
| 最終照合 | CLI `verify` | 無し |

書き込みのできる run には implementer だけを置く。runner は役ごとに書き込みの権限を分けられないので、同じ run に計画やレビューの役を置くと、その役も書けてしまう。commit・push・PR の作成は利用者が頼んだときだけ行い、merge はしない。

CLI は段ごとの作業ツリーの snapshot を `stateDir` の記録に残し、次の段の始めに今の snapshot と照らす。段の外での書き込み（計画の段・券を閉じた後の実装の Workflow・check とレビューの間）は、次の段で `E_STATE` か `changed_outside_steps` として見つかる。記録が見ないものは「照合しないもの」にまとめる。

CLI の入力は stdin の JSON、出力は 1 行の JSON。`ok: false` は拒否で、`code` と `reason` を持つ（code の一覧は `scripts/implement-core.mjs` の `CODES`、個々の拒否の理由は `reason`）。拒否されたら次の段へ進まず、`reason` を報告する。

## 開始: 状態を固定する

1. 依頼・Issue・要求文書から、外から確かめられる期待の挙動と守る性質を把握する。対象か期待が一意に決まらず、公開の契約・データの損失・互換性に複数の妥当な選択肢があるときだけ、根拠と選択肢を示して利用者に確かめる。
2. `mktemp -d` で repo の外に `stateDir` を作り、`start` を流す。方針の版（policyRef）は CLI が主ブランチの remote の先端に固定する（正本は `scripts/implement-core.mjs` の `DEFAULT_POLICY_REF`）。

   ```bash
   node [SKILL_DIR]/scripts/implement-cli.mjs start <<'JSON'
   {"repo": "<作業ツリーの絶対パス>", "stateDir": "<stateDir>"}
   JSON
   ```

   CLI は HEAD と policyRef の完全な SHA、開始時の変更の path（`preservedPaths`。変更の集合の定義は repo-review の working_tree と同じで、正本は `scripts/implement-core.mjs` の `unreviewablePaths` のコメント）と、その内容・status・index の entry、作業ツリーの snapshot を記録する。policyRef は入力に取らない（作業 branch の規約で同じ変更を免責しないため）。次のときは `E_PIN` で拒否するので、`reason` を利用者に伝え、片付いてからやり直す: 主ブランチの上や branch の無い HEAD（依頼の commit が主ブランチに直接入るか、どの branch にも残らない）、未追跡の入れ子の repo や、index だけが HEAD と違う path がある（レビューの変更の集合として扱えない）。出力の `state`・`state_sum`・`state_path` を以後の全ての段に手を加えずに写す（写し間違いは sum で拒否される）。

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

`skillDir` はこのスキルの実ディレクトリの絶対パス（Workflow source は自分の位置を解決できない）。

planner は影響する path・守る性質・手順・追加の check と、変更の条件ごとの **ケース計画**（条件 → ケースの対応表。各ケースの観点・検証層・入力と期待値、観点ごとの不適用の理由、カバーできない条件の理由）を返す。形の正本は計画の Workflow source の schema。script はケース計画の形を検査して必須の check を足し、plan-reviewer は計画を依頼・既存の契約と照らし、ケース計画を条件の取りこぼし・観点の未検討・実装から取った期待値で照合する。形の検査か plan-reviewer に通らなかった計画は、理由を添えて planner に戻す（回数の上限は source の定数 `MAX_PLAN_REVISIONS`）。

| status | 司令塔の処理 |
| --- | --- |
| **approved** | 返り値の `plan` と `plan_sum` を手を加えずに次の段へ写す |
| **no_change** | 受け入れ（次の節の 1）と `verify` だけを流し、計画の根拠（`no_change_reason` と plan-reviewer の `evidence`）を示して「変更不要」と報告する |
| **needs_human_decision** | `questions` と判断の材料を示して止まる。回答を依頼の文に足して計画からやり直す |
| **needs_isolated_worktree** | `preservedOverlaps` を示して止まる。開始時の変更を動かさないまま、開始時の HEAD から別の worktree を用意するか、利用者に確かめる |
| **blocked**・**incomplete** | `reason` と `issues`・`test_plan_review`・`problems` を示して止まる。`revisions_exhausted: true` は planner に戻す上限に達したことを表す。成功として扱わない |

## 受け入れと開始時の check

1. **受け入れ**: `implementation` を付けずに `inventory` を流す。CLI は、計画の段で作業ツリーが変わっていないこと、plan の path が symlink を通らず（通ると書き込みが plan の外の実体の path に現れるか repo の外へ出る）ignore されないこと、plan の check が許可リストに収まり必須の check を含むこと（正本は `scripts/implement-core.mjs` の `MAKE_TARGETS`・`NODE_TEST_SUFFIX`・`REQUIRED_CHECKS`）を確かめ、`admitted: true` のときだけ plan を記録する。`false` なら `problems` を示して止まる（許可リストに無い check が要るなら、利用者に手で実行するか見送るかを確かめる）。実装の回の前なら、計画し直した plan を受け入れ直せる。

   ```bash
   node [SKILL_DIR]/scripts/implement-cli.mjs inventory <<'JSON'
   {"statePath": "<state_path>", "stateSum": "<state_sum>", "plan": <plan>, "planSum": "<plan_sum>"}
   JSON
   ```

2. **開始時の check**: 同じ入力に `"phase": "baseline"` を足して `run-checks` を流す。実装の後に失敗した check が変更の起こしたものかを、CLI がこの記録と照らして決める。`make test` は数分かかり、shell の前景の実行の時間上限を超え得るので、`run-checks` は background で実行して終了を待つ（途中で打ち切ると記録が残らず、その段をやり直すことになる）。

## 実装の回

実装の回は、CLI の `begin-round` が出す券（ticket）で 1 回ずつ開き、実装の Workflow を 1 回呼び、`inventory` で閉じる。round の番号と修正の入力は CLI が記録から決め、券に載せる（司令塔は修正の入力を選ばない）。

```bash
node [SKILL_DIR]/scripts/implement-cli.mjs begin-round <<'JSON'
{"statePath": "<state_path>", "stateSum": "<state_sum>", "plan": <plan>, "planSum": "<plan_sum>", "repair": null}
JSON
```

`repair` は、最初の実装では `null`、check の修正では `"checks"`、レビューの修正では `"review"`。`needs_replan: true` が返ったら、確定指摘が計画の外か対象の外（`findingsOutsidePlan`）を指しているので、券を出さずに止まり、その指摘を報告する（実装の回の後は plan を受け入れ直さない。計画の外の修正をこの run に混ぜると、開始時の check と既に通した照合が別の計画のものになる）。

> **透過実行 route**: 現在の tool inventory に native `Workflow` があり、この call が未試行なら
> native を 1 回だけ使う。native が存在しない Codex では `workflow:dynamic-workflow-runner` を
> 内部互換層として使い、ユーザーに runner の指定を求めない。native を試行後に error / timeout /
> invalid result となった場合は runner へ fallback しない。human gate は無し。caller が所有する
> 前処理は `begin-round`、成功後処理はこの節の `inventory` と「check と修正ループ」。runner の verified return 以外で
> 成功後処理へ進まず、runner 未 install・`unsupported_runtime`・`rejected_source`・`workflow_incomplete` はそのまま報告する。
>
> **Codex classification: workspace-write required**。host は worker の `cwd` を repo にし、`workspace.mode: "workspace-write"` を設定する
> （source の要求だけでは書き込みの権限は上がらず、許可が無ければ runner が最初の agent の前に拒否する）。`requirements`・`limits`・`modelMap` の扱いは
> 計画の Workflow と同じ（`requirements` は source の `meta.requirements` をそのまま使う）。

```js
Workflow({
  scriptPath: "[SKILL_DIR]/scripts/implement.js",
  args: { skillDir: "[SKILL_DIR]", state: <start の state>, stateSum: "<state_sum>", plan: <plan>, planSum: "<plan_sum>", ticket: <begin-round の ticket>, ticketSum: "<ticket_sum>" }
})
```

**どの status でも**、返り値をそのまま `implementation` に入れて `inventory` を流す（受け入れと同じ入力に `"implementation": <返り値>`）。CLI は券の round を閉じて記録し、開始時の HEAD からの実際の変更を plan の path・touched_paths の和・preservedPaths の不変と照らし、申告と作業ツリーの動きが合うか（実装したと返したのに何も変わっていない、失敗したのに変わった）を照らす。`passed: false` なら「止まるとき」に従う（plan の外の変更や申告漏れを司令塔が戻さない。戻すのは破壊的な操作で、利用者が決める）。通らなかった round の後は、CLI が check・レビュー・次の回を受け付けない。

| status | 司令塔の処理 |
| --- | --- |
| **ready_for_check** | 実装の Workflow の実行が終わったことだけを表す。次の節の check へ進む |
| **repair_limit_reached** | 修正の回の上限（実装の Workflow source の定数 `MAX_REPAIR_ROUNDS`）を超えた券で、implementer を起動していない。暴走を止める backstop で止まったこととして、残った失敗・確定指摘を示して「止まるとき」に従う |
| **blocked**・**incomplete** | `reason` と、ケースのテストの欠け（`caseTestGaps`）・未解決（`implementation.unresolved`）を示して「止まるとき」に従う。承認済みの計画に implementer だけが変更不要と返したもの（`no-change-against-approved-plan`）もここに入る |

Workflow が返り値無しに終わった（error・timeout）ときは券が開いたままなので、`inventory` は流せない。「止まるとき」に従う。

## check と修正ループ

1. 受け入れと同じ入力に `"phase": "after"` を足して `run-checks` を background で流す。CLI は plan の check を 1 件ずつ固定の argv で実行し、command・exit code・HEAD・出力の末尾と、実行の前後の snapshot を記録する。モデルの文や PR のコメントを shell に渡さない。
2. `passed: true` なら独立レビューへ進む。`repairable: true` の失敗（開始時に成功していたか、開始時にまだ無かったテストの失敗）があれば、`"repair": "checks"` で次の回を開く。`failed_at_baseline` が `true` の失敗は開始時から失敗していたので直さず、原因を切り分けられなかったこととして「止まるとき」に従う。check の実行中に作業ツリーが変わった（`tree_changed: true`）ときも同じ。同じ回の run を流し直してもよいが、CLI は同じ回の全ての run の失敗を数えるので、一度失敗した check は修正の回を経ないと通らない。
3. 修正の回の後は、毎回この節の 1 から（check の全件と独立レビューを）やり直す。

## 独立レビュー

check が通ったら、`repo-review` スキルを**スキル呼び出し**で起動し、working_tree モードで、baseRef と headSha に `state.head`、policyRef に `state.policyRef`、preservedPaths に `start` の出力の `preservedPaths` を渡してレビューさせる（repo-review の前処理と Workflow の呼び方は repo-review の SKILL.md が正本）。repo-review の返り値と、その `plan` 操作の出力の `plan_path`・`plan_sum` を、そのまま `record-review` に渡す。

```bash
node [SKILL_DIR]/scripts/implement-cli.mjs record-review <<'JSON'
{"statePath": "<state_path>", "stateSum": "<state_sum>", "review": <repo-review の返り値>, "reviewPlanPath": "<plan_path>", "reviewPlanSum": "<plan_sum>"}
JSON
```

CLI は、返り値の `sum`（repo-review の Workflow が本文に付ける）、mode・SHA・対象・除外・生成物・preserved を repo-review の計画のファイルと開始時の記録に照らし、completed なら観点ごとの coverage が計画の reviewers と一致して pin が崩れていないこと、対象・除外・生成物の和が今の変更の集合と一致し、計画のファイルの内容の digest が今の内容と一致することを確かめてから記録する（レビューの範囲を狭めた・返り値から指摘を落とした・前の回の結果を出し直した、は拒否される）。記録は 1 回に 1 つで、やり直せるのは前の記録が `review_incomplete` のときだけ（そのときも前の確定指摘は残る）。

repo-review が「レビューの対象が 0 件」（変更が除外・生成物だけ）で Workflow を呼ばずに終えたときは、記録するレビューが無く `verify` は通らない。レビューを経ていない変更として「止まるとき」に従う。

- 確定指摘があれば `"repair": "review"` で次の回を開く（券には CLI が記録した確定指摘が載る）。`refuted` は直さない。
- `review_incomplete` や `unverified` が残るときは、レビューが通ったことにしない。司令塔の読み直しを独立レビューの代わりにしない（自分の読みは生成と同じ視点で、欠陥が見えない）。

## 止まるとき

実装の回を始めた後に止まる（上の各段の「止まるとき」・CLI の拒否・人の判断待ち）ときは、理由を添えて `abandon` を流す。CLI は開いた回を放棄として閉じ、以後の段を受け付けず、残った変更の path（`remaining`）と開始時の変更（`preservedPaths`）を返す。

```bash
node [SKILL_DIR]/scripts/implement-cli.mjs abandon <<'JSON'
{"statePath": "<state_path>", "stateSum": "<state_sum>", "reason": "<止まった理由>"}
JSON
```

残った変更は消さない。報告に、止まった理由、`remaining` の path、`changedOutsideSteps`、取れる手（commit して別の run で続ける・破棄する・別の worktree に移す）を書き、どれを取るかは利用者が決める（どれも作業ツリーの内容を変える操作で、未保存の作業を失い得る）。続けるときは、片付いた作業ツリーで新しい `stateDir` から始める。

## 最終照合と報告

受け入れと同じ入力で `verify` を流す。CLI は記録だけを使い、HEAD が開始時のまま、run が abandon で終わっておらず、開いた回が無く、最後の回が実装を終えて inventory を通り、承認済みの計画の変更が作業ツリーにあり、実際の変更が plan と touched_paths の和に収まり、preservedPaths が変わらず、最後の回の後の check が全て成功し、最後のレビューが確定指摘も未検証も無く通り、今の snapshot が最後に check とレビューを通した時点と一致することを照らす。`passed: true` のときだけ完了として報告する。

報告に書くもの: 変更の内容と path、ケース計画（条件ごとのケースとテストの所在、不適用の理由、未カバーの条件と理由）、check ごとの argv と exit code、レビューの対象・観点・確定・棄却・未検証の件数、修正の回数（上限で止まったならそのこと）、`verify` の `problems`、照合の外にあるもの（ignore される path・入れ子の repo の中身）、実行していない確認と残した判断。成功していないものを成功として書かない。

commit を頼まれたときは、commit の直前に `verify` を流し、`passed: true` のときだけ commit する。`false` なら commit せず、check とレビューからやり直す。

## 照合しないもの

CLI の記録と照合が見ないものは次のとおりで、報告では照合した範囲に含めない。

- `.gitignore` に当たる path への書き込み（`git status` に出ない）。受け入れは ignore される path を plan に入れさせないが、implementer が plan の外の ignore される path に書いたことは見えない。
- 実行中に作られた未追跡の入れ子の repo の中身（path だけが変更として現れる）。
- 同じ券で実装の Workflow を 2 回走らせ、どちらも `inventory` の前に書き終えたときの 2 回目の書き込み（1 回分の変更として受け入れられ、touched_paths の申告と合う限り区別できない）。
- sum を計算し直した意図的な改変（state・plan・券・Workflow の返り値・repo-review の返り値の sum は写し間違いと落としを検出するもので、署名ではない）。
