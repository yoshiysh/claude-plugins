---
name: dispatch
description: >
  planner/executor/verifier を分け、複数ラウンドで計画→並列実行→fresh-context 検証→評価する
  bounded loop で、単一の視点や一問一答では答えが出ない難問を解く。ドメイン非依存
  （コードの根本原因調査、アーキテクチャ考古学、オープンエンドな調査統合、設計空間の多角探索、
  複雑な意思決定の材料集めなど）。投資判断（銘柄評価・売買
  タイミング・ポートフォリオ構築）は扱わない（→ investment-strategist / magi）。単発の壁打ちで
  十分な相談は扱わない。ユーザーが「徹底的に調べてほしい」「多角的に検証しながら
  深掘りしてほしい」「一人の視点では信用できないので複数の観点でチェックしながら進めてほしい」
  のように、反復的な検証を伴う難しい調査・分析タスクを持ちかけたときに使う。
---

# Dispatch（反復 subagent 委譲ループ）

「答えの形が事前にわからない難問」に対して、native Claude Workflow では Fable 5 が毎ラウンド
「次に誰にどう動いてもらうか」を判断し、Workflow スクリプトが実際に subagent を立て、
結果を fresh-context な subagent が検証して評価する。Codex の dynamic-workflow-runner では
同じ planner/executor/verifier 構造と bounded loop を
Codex host-default model で実行する。Codex を Fable 5 と同一・同等とは扱わない。

## なぜこの構造か（アーキテクチャの核）

Claude Code には「subagent はさらに subagent を spawn できない（ネストは1段まで）」という
制約がある（magi-issue-resolver スキルの「アーキテクチャ」節で既に
明文化されている、本リポジトリで確立済みの前提）。したがって「Planner がオーケストレーターと
して subagent を立てる」を文字通り実装することはできない。

このスキルは、Planner を **Workflow ツールの `agent()` 呼び出しの1つ**として扱うことで
この制約を構造的に回避する。Planner 自身は Agent ツールを一切呼ばず、「次のラウンドで誰を
どう動かすか」を構造化データ（JSON schema 準拠）として**返すだけ**。実際に subagent を
立てる・並列実行する・ループを回す・予算管理するのは、**Workflow スクリプト（決定的な
JavaScript）**の仕事にする。これは loop engineering の「検証は
generator-verifier で分離する」と skill 設計ベストプラクティスの Determinism
Split（「ループ・並列処理・ファイル操作は script、判断・合成は Coding Agent」）をそのまま
体現した形。

native Claude Workflow の副次的な利点: Workflow ツールは `resumeFromRunId` によるネイティブな
再開機構を持つため、`magi` が自前で構築した `state.json` + `resume_from_state.py` 相当の
仕組みを本スキルで手で作る必要がない。Codex runner profile には source checkpoint がなく、
この再開機能は適用されない。

## 何をしないか（境界）

- **投資判断を扱わない**：銘柄評価・売買タイミング・ポートフォリオ構築の相談は
  `investment-strategist` / `magi` へ誘導する。理由は、投資助言の規制境界を一元管理から外さないため。
- **単発の壁打ちには使わない**：1往復の助言で足りる相談では複数ラウンドの費用に見合わない。
  本スキルは「複数ラウンドの反復検証が本質的に必要な難問」向け。
- **agent に状態変更をさせない**：本スキルの deliverable は
  synthesis（統合された見解・調査結果）であり、ファイル変更やコマンド実行の実施ではない。
  各 subagent の役割定義（`references/*.md`）でこの境界を明示する。

## フロー

```
/dispatch <topic>
  │
  ├─[0] 短絡判定（Coordinator が直接判定）
  │       投資判断トピック → investment-strategist/magi へ誘導して終了
  │       単純な一問一答で答えられる → 「このスキルは不要、直接回答します」と伝えて
  │       通常回答に切り替え（ループのコスト正当化のため）
  │
  ├─[1] コスト見積りを一言伝える（承認ゲートではなく透明性のため）
  │       最大ラウンド数・ラウンドあたり subagent 数上限を伝える
  │
  └─[2] Workflow を呼ぶ
          scriptPath: scripts/orchestrate.js
          args: { topic, maxRounds?, subagentsPerRoundCap? }
          Codex only: add executionProfile: codex_host_default
          ループ本体（Plan → Execute → Verify → Evaluate、収束まで反復 → Synthesize）は
          scripts/orchestrate.js が全て内包する。詳細は同ファイルのコメントを参照。
```

## Step 0: 短絡判定

`<topic>` を読み、以下のいずれかに該当する場合は Workflow を呼ばずに終了する。

- **投資判断トピック**（銘柄評価・買い時/売り時・組み入れ・目標株価等）:
  「投資判断は investment-strategist / magi が扱います。そちらをお試しください」と案内する。
- **単純な一問一答**（コード1箇所の確認、既知事実の確認等、Coordinator が直接調べれば
  数分で答えが出るもの）: 「この規模の質問であればループを回さず直接お答えします」と伝え、
  通常のツール（Read/Grep/WebSearch 等）で直接対応する。
  理由: Workflow は数十 agent を並列生成しうる高コストな仕組み（ツール自身のドキュメントが
  明示的に警告している）。単純な質問にまで適用するのはコストの正当化ができない。

判断に迷う場合（難問かどうか自体が曖昧）は、迷わずループ側に倒してよい——本スキルの
対象はまさに「答えの形が事前にわからない」問いであり、判定を厳密にしすぎると本来の
対象まで弾いてしまう。

## Step 1: コスト透明性

Workflow 起動前に一言伝える（承認を待つ必要はない。investment-strategist 等と異なり
状態変更を伴わないため）:

```
最大 {maxRounds} ラウンド、1ラウンドあたり計画・評価 agent call 各1回 + 最大
{subagentsPerRoundCap} 件の実行 subagent + 最大 {subagentsPerRoundCap} 件の検証
subagent を実行します。native Claude は Fable 5 と planner が選ぶモデルを使い、Codex runner は
全役割で host-default model を使います。収束すれば途中で打ち切ります。
```

既定値と hard cap は `scripts/orchestrate.js` の literal `meta.defaults` / `meta.caps` を正本とする。
見積もり時にその値を読み、SKILL.md 側へ写さない。ユーザーが上限を明示した場合はその値を
`args` に渡す。

## Step 2: Workflow を呼ぶ

> **実行 route**: 現在の tool inventory に native `Workflow` があり、この call が未試行なら
> native を1回だけ使い、`executionProfile` を省略する（source は `claude_native` を既定にする）。
> native が使えない Codex では `workflow:dynamic-workflow-runner` を使い、
> `args.executionProfile` を `codex_host_default` にする。
> Codex profile は全 agent call の `model` と `effort` を省略し、shared runner の host-default model に委ねる。
> planner/executor/verifier の役割、独立した検証、bounded loop は維持するが、Codex を Fable 5 と同一・
> 同等とは扱わない。source result と host-default の `model.selected` event のどちらにも実 model ID は
> 含まれない。runner event が `origin=host-default` を記録する。native を試行後に error / timeout /
> invalid result となった場合も runner へ fallback しない。
>
> **Codex classification: host-default supported**（`codex_host_default` profile の bounded loop。Claude Fable 5 との品質同等性は主張しない）。

native `Workflow` は従来どおりの args を使い、profile を追加しない:

```javascript
Workflow({ scriptPath: "[SKILL_DIR]/scripts/orchestrate.js", args: {
  skillDir: "[SKILL_DIR]", topic: "<topic>", maxRounds: <number|undefined>,
  subagentsPerRoundCap: <number|undefined>
}})
```

Codex runner 経由では `executionProfile` を明示する:

```javascript
Workflow({ scriptPath: "[SKILL_DIR]/scripts/orchestrate.js", args: {
  skillDir: "[SKILL_DIR]", topic: "<topic>", executionProfile: "codex_host_default",
  maxRounds: <number|undefined>, subagentsPerRoundCap: <number|undefined>
}})
```

Codex route の dynamic-workflow-runner request では、source の literal `meta.limits` を `args` の外側の
`limits` にそのまま渡す。これは hard cap 全体を処理する host ceiling で、per-run の再計算や縮小はしない。
source は `args.maxRounds` と `args.subagentsPerRoundCap` を `meta.defaults` / `meta.caps` に照らして検証し、
実際のループを制限する。返却される `model_map_disclosure.required_runner_limits` も同じ `meta.limits` を示す。

```javascript
{
  scriptPath: "[SKILL_DIR]/scripts/orchestrate.js",
  args: { skillDir: "[SKILL_DIR]", topic: "<topic>", executionProfile: "codex_host_default" },
  limits: <scripts/orchestrate.js の literal meta.limits をそのまま渡す>
}
```

`skillDir` には本スキルの実ディレクトリ（install 元によって変わる）を実パスで渡す。スクリプトは自身の位置を解決できず、subagent に渡す役割定義の Read パスがここでしか決まらない。

Codex 互換経路で caller が所有する前処理は Step 0〜1、成功後処理は「結果の提示」、human gate は無し。
Codex profile は全 agent role に host-default model を使い、別のモデルを推定しない。結果には
`execution_profile` と `model_map_disclosure` が含まれる。Codex profile の `required_runner_limits` は
source の `meta.limits` を返す。runner の `model.selected` event で
`origin=host-default` は確認できるが、実 model ID は source result と event のどちらにも公開されない。

Workflow はバックグラウンドで実行される（`Workflow` ツールの標準挙動）。完了すると
`{ topic, execution_profile, model_map_disclosure, rounds_run, termination_reason, synthesis, history }` が返る。

## 結果の提示

`synthesis` をそのままユーザーに提示する（`synthesis` の文体は
`references/synthesis-role.md` が既に outcome-first・可読性を整えた形で生成している
ため、Coordinator 側で再整形する必要はない）。加えて以下を短く添える:

- `termination_reason`: `converged`（収束）/ `stalled`（進捗なしで打ち切り）/
  `max_rounds`（ラウンド上限到達）。実行量は `maxRounds` と `subagentsPerRoundCap` の
  hard max で決まる。dynamic-workflow-runner host により、より低い agent call 上限・期限が適用される
  場合は run 全体が失敗することがある。host limit をスキル側で上書きできるとは扱わない。
  `converged` 以外の場合は**必ずその旨を明示する**（達成度を実態より良く見せない。
  `references/evaluator-role.md` の "Ground progress claims" 原則と同じ姿勢を
  Coordinator 自身にも適用する）。
- `rounds_run`: 何ラウンドで終わったか。
- `execution_profile` と `model_map_disclosure`: 実行 route と各役割の model 選択方針。
  `codex_host_default` は Codex runner の host default を表すだけで、Fable 5 との同一性・同等性を表さない。

## エラー時の挙動

- Workflow 呼び出し自体が失敗（構文エラー・ツール未許可等）→ ユーザーにエラー内容を
  そのまま伝える。生成物を捏造しない。
- 個々の `agent()` 呼び出しが失敗（`null` を返す）→ script 側で `.filter(Boolean)` 済みの
  想定で組んである。全滅した場合は Evaluate が `stalled` を返す設計（history に有効な
  findings が積み上がらないため、evaluator-role.md の判断基準上 `continue` を選びにくい）。
- native Claude Workflow の `resumeFromRunId` はその host が保証する範囲で案内してよい。dynamic-
  workflow-runner の Codex profile はこの source に checkpoint を定義していないため、native の
  `resumeFromRunId` で再開できるとは案内しない。

## Execution profiles

native Claude Workflow の `claude_native` profile は Fable 5 を計画・評価・統合に使い、
planner が executor と verifier の model/effort を選ぶ。Codex runner の `codex_host_default`
profile は全 agent call で `model` と `effort` を省略し、runner host default に委ねる。
source result と runner event は host-default の使用を示すが、実 model ID は分からない。
この分岐で Fable 5 と Codex の同一性や品質同等性を主張しない。

## Claude model update procedure

Claude の native profile が使う named model を交代する場合は、まず現在の Claude model-selection 仕様と
置き換え先 model の公式 prompting guidance を確認する。そのうえで `scripts/orchestrate.js` の native
Plan/Evaluate/Synthesize 呼び出し、planner schema の model enum と disclosure、native の verifier
fallback、`references/planner-role.md` の選択条件と model 固有の実行境界、evaluator/synthesis の
model 記述、`references/fable-orchestration-prompting-guide.md` の内容と見出し、関連 evals を揃えて更新し、
両 profile の targeted tests を実行する。Codex の `codex_host_default` route は `model` と `effort` を
省略して host default を使うため、この native model 交代には追従させない。

## References（1 level deep）

- `scripts/orchestrate.js` — ループ本体（Plan/Execute/Verify/Evaluate/Synthesize、
  実行はここで完結する。読む場合はコメントを含めて全文読むこと）
- `references/planner-role.md` — native Claude Plan ステップで読む役割定義
  （subagent 分解・model/effort 選択・thinking-stance.md からのペルソナ付与）
- `references/verifier-role.md` — native Claude Verify ステップで検証 subagent が読む役割定義
  （fresh-context、`code-review` スキルと同じ CONFIRMED/PLAUSIBLE/REFUTED 語彙を再利用。Codex は専用の role file を読む）
- `references/evaluator-role.md` — native Claude Evaluate ステップで読む役割定義
  （収束判定基準、Ground progress claims 原則）
- `references/synthesis-role.md` — native Claude 最終統合ステップで読む役割定義
  （outcome-first、読者向け再記述の文体を本文に持つ）
- `references/codex-host-default/*.md` — Codex profile の各 role instructions。Fable 固有のガイドは参照せず、
  全 worker を host-default model で実行する。
- `references/fable-orchestration-prompting-guide.md` — [Claude model update procedure](#claude-model-update-procedure) が対象にする、公式 Fable 5 prompting guide の
  うち「並列委譲・自己検証・メモリ・自律運用」節を条件抜粋したもの
