---
name: dispatch
description: >
  Fable 5 を「計画・評価の頭脳」として使い、Sonnet/Opus/Haiku の subagent を複数ラウンドに
  渡って計画→並列実行→fresh-context 検証→評価するループで、単一の視点や一問一答では答えが
  出ない難問を解く。ドメイン非依存（コードの根本原因調査、アーキテクチャ考古学、オープンエンド
  な調査統合、設計空間の多角探索、複雑な意思決定の材料集めなど）。投資判断（銘柄評価・売買
  タイミング・ポートフォリオ構築）は扱わない（→ investment-strategist / magi）。単発の壁打ちで
  十分な相談は扱わない（→ chat）。ユーザーが「徹底的に調べてほしい」「多角的に検証しながら
  深掘りしてほしい」「一人の視点では信用できないので複数の観点でチェックしながら進めてほしい」
  のように、反復的な検証を伴う難しい調査・分析タスクを持ちかけたときに使う。
---

# Dispatch（Fable 5 駆動の反復 subagent 委譲ループ）

「答えの形が事前にわからない難問」に対して、**Fable 5 が毎ラウンド「次に誰にどう動いて
もらうか」を判断し、判断結果に基づいて Workflow スクリプトが実際に subagent を立て、
結果を fresh-context な subagent が検証し、Fable がまた評価する**——を収束するまで繰り返す
スキル。

## なぜこの構造か（アーキテクチャの核）

Claude Code には「subagent はさらに subagent を spawn できない（ネストは1段まで）」という
制約がある（magi-issue-resolver スキルの「アーキテクチャ」節で既に
明文化されている、本リポジトリで確立済みの前提）。したがって「Fable がオーケストレーターと
して subagent を立てる」を文字通り実装することはできない。

このスキルは、Fable を **Workflow ツールの `agent()` 呼び出しの1つ**として扱うことで
この制約を構造的に回避する。Fable 自身は Agent ツールを一切呼ばず、「次のラウンドで誰を
どう動かすか」を構造化データ（JSON schema 準拠）として**返すだけ**。実際に subagent を
立てる・並列実行する・ループを回す・予算管理するのは、**Workflow スクリプト（決定的な
JavaScript）**の仕事にする。これは loop engineering の「検証は
generator-verifier で分離する」と skill 設計ベストプラクティスの Determinism
Split（「ループ・並列処理・ファイル操作は script、判断・合成は Coding Agent」）をそのまま
体現した形。

副次的な利点: Workflow ツールは `resumeFromRunId` によるネイティブな再開機構を持つため、
`magi` が自前で構築した `state.json` + `resume_from_state.py` 相当の仕組みを本スキールで
は手で作る必要がない。

## 何をしないか（境界）

- **投資判断を扱わない**：銘柄評価・売買タイミング・ポートフォリオ構築の相談は
  `investment-strategist` / `magi` へ誘導する。理由は `chat/SKILL.md` と同じ
  （投資助言の規制境界を一元管理から外さない）。
- **単発の壁打ちには使わない**：1往復の助言で足りる相談は `chat` の方が速く安い。
  本スキルは「複数ラウンドの反復検証が本質的に必要な難問」向け。
- **Fable/subagent に状態変更をさせない**：本スキルの deliverable は
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

判断に迷う場合（難問かどうか自体が曖昧）は、迷わずループ側に倒してよい——本スキールの
対象はまさに「答えの形が事前にわからない」問いであり、判定を厳密にしすぎると本来の
対象まで弾いてしまう。

## Step 1: コスト透明性

Workflow 起動前に一言伝える（承認を待つ必要はない。investment-strategist 等と異なり
状態変更を伴わないため）:

```
最大 {maxRounds} ラウンド、1ラウンドあたり Fable 呼び出し2回（計画・評価）+ 最大
{subagentsPerRoundCap} 件の実行 subagent + 最大 {subagentsPerRoundCap} 件の検証
subagent（Sonnet/Opus/Haiku）を回します。収束すれば途中で打ち切ります。
```

`maxRounds` 既定値は 6、`subagentsPerRoundCap` 既定値は 6（詳細な根拠は
`scripts/orchestrate.js` 冒頭のコメント参照。voodoo constant であることを認めた上での
初期値であり、実績を見て調整する対象）。ユーザーが明示的に上限を指定した場合はそれを
`args` に渡す。

## Step 2: Workflow を呼ぶ

```
Workflow({
  scriptPath: "[SKILL_DIR]/scripts/orchestrate.js",
  args: {
    skillDir: "[SKILL_DIR]",
    topic: "<topic>", maxRounds: <number|undefined>, subagentsPerRoundCap: <number|undefined>
  }
})
```

`skillDir` には本スキルの実ディレクトリ（install 元によって変わる）を実パスで渡す。スクリプトは自身の位置を解決できず、subagent に渡す役割定義の Read パスがここでしか決まらない。

Workflow はバックグラウンドで実行される（`Workflow` ツールの標準挙動）。完了すると
`{ topic, rounds_run, termination_reason, synthesis, history }` が返る。

## 結果の提示

`synthesis` をそのままユーザーに提示する（`synthesis` の文体は
`references/synthesis-role.md` が既に outcome-first・可読性を整えた形で生成している
ため、Coordinator 側で再整形する必要はない）。加えて以下を短く添える:

- `termination_reason`: `converged`（収束）/ `stalled`（進捗なしで打ち切り）/
  `max_rounds`（ラウンド上限到達）/ `budget_exhausted`（トークン予算到達）。
  `converged` 以外の場合は**必ずその旨を明示する**（達成度を実態より良く見せない。
  `references/evaluator-role.md` の "Ground progress claims" 原則と同じ姿勢を
  Coordinator 自身にも適用する）。
- `rounds_run`: 何ラウンドで終わったか。

## エラー時の挙動

- Workflow 呼び出し自体が失敗（構文エラー・ツール未許可等）→ ユーザーにエラー内容を
  そのまま伝える。生成物を捏造しない。
- 個々の `agent()` 呼び出しが失敗（`null` を返す）→ script 側で `.filter(Boolean)` 済みの
  想定で組んである。全滅した場合は Evaluate が `stalled` を返す設計（history に有効な
  findings が積み上がらないため、evaluator-role.md の判断基準上 `continue` を選びにくい）。
- Workflow が `resumeFromRunId` で再開可能であることをユーザーに伝えてよい
  （長時間ラウンドの途中で中断した場合、同じ `scriptPath` + `resumeFromRunId` で再開できる）。

## モデル交代時の更新ポイント

Fable 5 は現行フラッグシップ。次期モデルへ交代する際は、`scripts/orchestrate.js` 内の
`model: 'fable'` を差し替え、`references/fable-orchestration-prompting-guide.md` を
新モデルの prompting guide に基づいて更新する（`chat/agents/sounding-board-consultant.md`
と同じ更新ポイント。本スキール名にモデル名を含めていないのはこの更新を名前変更なしで
行えるようにするため）。

## References（1 level deep）

- `scripts/orchestrate.js` — ループ本体（Plan/Execute/Verify/Evaluate/Synthesize、
  実行はここで完結する。読む場合はコメントを含めて全文読むこと）
- `references/planner-role.md` — Plan ステップで Fable が読む役割定義
  （subagent 分解・model/effort 選択・thinking-stance.md からのペルソナ付与）
- `references/verifier-role.md` — Verify ステップで検証 subagent が読む役割定義
  （fresh-context、`code-review` スキルと同じ CONFIRMED/PLAUSIBLE/REFUTED 語彙を再利用）
- `references/evaluator-role.md` — Evaluate ステップで Fable が読む役割定義
  （収束判定基準、Ground progress claims 原則）
- `references/synthesis-role.md` — 最終統合ステップで Fable が読む役割定義
  （outcome-first、`chat` の readability パターンを参照）
- `references/fable-orchestration-prompting-guide.md` — 公式 Fable 5 prompting guide の
  うち、`chat/references/target-model-prompting-guide.md`（単発助言向け）が扱っていない
  「並列委譲・自己検証・メモリ・自律運用」節を条件抜粋したもの
