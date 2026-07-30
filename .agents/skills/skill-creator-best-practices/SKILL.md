---
name: skill-creator-best-practices
description: >
  マルチエージェントを用いて高品質なスキルを自動生成する。要件整理・検証基準生成・
  構成設計・執筆・テスト・検証を複数の専門 Sub-agent に分担させ、単独実行より品質の高い
  スキルを生み出す。「スキルをマルチエージェントで作りたい」「品質チェック付きでスキルを作って」
  「〜という業務を自動化するスキルを作ってほしい」「チームで使えるスキルを設計して」
  といったリクエストで使うこと。既存スキルの実行や通常のチャット質問への回答は対象外。
---

# マルチエージェント スキルクリエイター

複数の Sub Agent を実際に起動して役割分担し、単独実行より高品質なスキルを生み出す。
ユーザーは「何をしたいか」を日本語で伝えるだけでよい。

各 Sub Agent のプロンプトは `agents/` 配下の個別ファイルに定義されている。
各ファイルの frontmatter に `model`・`subagent_type`・`description` が記載されている。
司令塔は該当ファイルを Read し、frontmatter から `model` と `subagent_type` を取得して Agent ツールに渡す。
`[PLACEHOLDER]` は実際の値に置き換えてから渡す。

---

## 目次

1. [全体フロー](#全体フロー)
2. [Phase 1: 要件整理とペルソナ設計](#phase-1-要件整理とペルソナ設計)
3. [Phase 2: 基準生成](#phase-2-基準生成)
4. [Phase 2.5: 構成設計・検証](#phase-25-構成設計検証documentタイプのみ)
5. [Phase 3: スキル初稿執筆](#phase-3-スキル初稿執筆)
6. [Phase 4: 並列評価と採点・比較分析](#phase-4-並列評価と採点)
7. [Phase 5: 統合・保存](#phase-5-統合保存ユーザーへの提示)
8. [入出力の定義](#入出力の定義)
9. [ユーザーへの話し方](#ユーザーへの話し方)
10. [ファイル構成](#ファイル構成参照先)

---

## 全体フロー

```
Phase 1: 要件整理・ペルソナ設計（司令塔が単独で実行）
  └─ 要件を構造化 → ペルソナを推論 → ユーザーに確認
  ※ 詳細手順： references/orchestrator-requirements.md を Read すること

Phase 2: 基準生成（Agent ツールを順番に2回呼ぶ）
  → [基準生成] agents/criteria-gen.md
  → [基準補完] agents/criteria-comp.md

Phase 2.5: 構成設計・検証（document タイプのみ・Agent ツールを順番に2回呼ぶ）
  → [構成設計] agents/structure-designer.md（Sonnet）
  → [構成検証] agents/structure-reviewer.md（Sonnet）
  ❌ があれば構成を差し戻して再設計する

Phase 3: スキル初稿執筆（Agent ツールを1回呼ぶ・Opus）
  → [執筆] agents/writer.md（[MODE]=initial）
  ※ document タイプは Phase 2.5 の構成案を [STRUCTURE_PLAN] として渡す

Phase 4: 並列評価と採点（Parallelization + Generator-Verifier）
  Step 4-1: [テストプロンプト生成] agents/tester.md（Haiku）
  Step 4-2: with_skill / baseline を同一ターンで並列実行（6エージェント同時起動）
  Step 4-3: [採点] agents/grader.md を3件並列（Sonnet）→ pass_rate を集計
  Step 4-4: [定性チェック] agents/reviewer.md（Opus）
  Step 4-5: [比較・分析] agents/comparator.md + agents/analyzer.md を並列（Sonnet）
  Step 4-6: eval-viewer 生成コマンドをユーザーに案内
  delta < 0.2 または ❌ があれば analyzer の改善提案を参考に writer.md（revise）で修正 → Step 4-2 からやり直す

Phase 5: 統合・保存（司令塔が単独で実行）
  └─ pass_rate と定性レポートをユーザーに提示 → 承認後に保存
  ※ 詳細手順： references/orchestrator-output.md を Read すること
```

---

## Phase 1: 要件整理とペルソナ設計

**Agent ツールは呼び出さない。司令塔が単独で行う。**

`references/orchestrator-requirements.md` を Read し、手順に従って実行する。

完了条件：ユーザーがペルソナを承認したらPhase 2へ進む。

---

## Phase 2: 基準生成

ユーザーへの一言：
> 「2つの視点から検証基準を作成しています...」

**Step 2-1（基準生成）：**
`agents/criteria-gen.md` を Read し、以下を埋め込んで Agent ツールを呼ぶ。
- `[PERSONA_CRITERIA_GEN]` → 基準生成係のペルソナ説明文
- `[REQUIREMENTS]` → 構造化した要件全体
- `[TASK_TYPE]` → document / workflow / data

**Step 2-2（基準補完）：**
Step 2-1 の結果を受け取ってから、`agents/criteria-comp.md` を Read し、
以下を埋め込んで Agent ツールを呼ぶ。
- `[PERSONA_CRITERIA_COMP]` → 基準補完係のペルソナ説明文
- `[REQUIREMENTS]` → 構造化した要件全体
- `[TASK_TYPE]` → document / workflow / data
- `[EXISTING_CRITERIA]` → Step 2-1 の出力

両エージェントの出力を統合し、重複を除いた検証基準リストを確定する。

---

## Phase 2.5: 構成設計・検証（document タイプのみ）

タスク種別が `document` 以外の場合はこの Phase をスキップして Phase 3 へ進む。

ユーザーへの一言：
> 「コンテンツ構成を設計して検証しています...」

**Step 2.5-1（構成設計）：**
`agents/structure-designer.md` を Read し、以下を埋め込んで Agent ツールを呼ぶ。
- `[PERSONA_STRUCTURE_DESIGNER]` → 構成設計係のペルソナ説明文
- `[REQUIREMENTS]` → 構造化した要件全体
- `[CRITERIA]` → Phase 2 で確定した検証基準リスト

**Step 2.5-2（構成検証）：**
Step 2.5-1 の結果を受け取ってから、`agents/structure-reviewer.md` を Read し、
以下を埋め込んで Agent ツールを呼ぶ。
- `[PERSONA_STRUCTURE_REVIEWER]` → 構成検証係のペルソナ説明文
- `[REQUIREMENTS]` → 構造化した要件全体
- `[CRITERIA]` → Phase 2 で確定した検証基準リスト
- `[STRUCTURE_PLAN]` → Step 2.5-1 の出力（構成案全文）

**判定：**
- **❌ が0件：** 構成案を確定して Phase 3 へ進む
- **❌ が1件以上：** 問題点を structure-designer に差し戻して再設計する（Opus は使わない）。再設計後は Step 2.5-2 の検証をやり直す。2回目以降も ❌ が残る場合はユーザーに提示して判断を仰ぐ

確定した構成案を `[STRUCTURE_PLAN]` として Phase 3 に引き渡す。

---

## Phase 3: スキル初稿執筆

ユーザーへの一言：
> 「スキルの初稿を執筆しています...」

`agents/writer.md` を Read し、以下を埋め込んで Agent ツールを呼ぶ。
- `[MODE]` → `initial`
- `[PERSONA_WRITER]` → 執筆係のペルソナ説明文
- `[REQUIREMENTS]` → 構造化した要件全体
- `[TASK_TYPE]` → document / workflow / data
- `[STRUCTURE_PLAN]` → Phase 2.5 で確定した構成案（document タイプのみ。それ以外は「該当なし」と記載）

受け取った SKILL.md 全文を `[SKILL_DRAFT]` として Phase 4 に引き渡す。

---

## Phase 4: 並列評価と採点

ユーザーへの一言：
> 「スキルありなしで実際に動かして品質を測っています...」

**Step 4-1（テストプロンプト生成）：**
`agents/tester.md` を Read し、以下を埋め込んで Agent ツールを呼ぶ。
- `[PERSONA_TESTER]` → テスト作成係のペルソナ説明文
- `[SKILL_NAME]` → スキル名（フロントマターの `name`）
- `[SKILL_DESCRIPTION]` → フロントマターの `description` のみ（全文ではない）
- `[REQUIREMENTS_SUMMARY]` → Phase 1 で整理したトリガー条件・対象ユーザーの要約

**Step 4-2（with_skill / baseline の並列実行）：**
Step 4-1 で生成したテストケース3件について、各テストケースごとに以下の2エージェントを**同一ターンで同時起動**する（合計6エージェントを1ターンで発行）。

- `with_skill` エージェント：生成した SKILL.md をシステムプロンプトに含めた状態でテストプロンプトを実行
- `baseline` エージェント：SKILL.md を渡さずに同じテストプロンプトを実行

各エージェントへの指示：
> 「以下のプロンプトに対してそのまま回答してください。[TEST_PROMPT]」

全6エージェントの完了を待ってから Step 4-3 へ進む。

**Step 4-3（採点）：**
各テストケースの with_skill / baseline 出力ペアについて、`agents/grader.md` を Read し以下を埋め込んでAgentツールを**3件並列**で呼ぶ。
- `[SKILL_NAME]` → スキル名
- `[TEST_CASE]` → テストケース（プロンプト + assertions）
- `[TEST_CASE_ID]` → テストケースの id
- `[WITH_SKILL_OUTPUT]` → with_skill エージェントの出力
- `[BASELINE_OUTPUT]` → baseline エージェントの出力

3件の grading 結果を受け取り、pass_rate を集計する：
- with_skill の平均 pass_rate
- baseline の平均 pass_rate
- delta（差分）

**Step 4-4（定性チェック）：**
`agents/reviewer.md` を Read し、以下を埋め込んで Agent ツールを呼ぶ。
- `[PERSONA_REVIEWER]` → 検証係のペルソナ説明文
- `[SKILL_DRAFT]` → Phase 3 で生成した SKILL.md 全文
- `[CRITERIA]` → Phase 2 で確定した検証基準リスト
- `[TEST_CASES]` → Step 4-1 で生成したテストケース3件

**Step 4-5（比較・分析）：**
Step 4-3 の grading 結果を受けて、`agents/comparator.md` と `agents/analyzer.md` を**同一ターンで並列に**呼ぶ。

`agents/comparator.md` を Read し、以下を埋め込んで Agent ツールを呼ぶ。
- `[OUTPUT_A]` → テスト1の with_skill 出力
- `[OUTPUT_B]` → テスト1の without_skill 出力
- `[ASSERTION_RATES]` → Step 4-3 の pass_rate 集計結果
- `[TEST_PROMPT]` → テスト1のプロンプト

`agents/analyzer.md` を Read し、以下を埋め込んで Agent ツールを呼ぶ。
- `[MODE]` → `post-hoc`
- `[WINNER]` → delta が正なら `with_skill`、負なら `without_skill`、±0.05 以内なら `tie`
- `[GRADING_RESULTS]` → Step 4-3 の3件の grading 結果全文
- `[COMPARATOR_RESULT]` → comparator の出力（同一ターンなので受け取り後に analyst へ渡す）

analyzer の改善提案（priority: high）は Phase 5 の提示に含める。

**Step 4-6（eval-viewer 生成）：**
以下のコマンドをユーザーに案内する（実行はユーザーが行う）：

```bash
# 評価結果をワークスペースに保存
python3 [SKILL_DIR]/scripts/run_eval.py \
  --skill-path .claude/skills/[スキル名] --iteration 1

# review.html を生成してブラウザで確認
python3 [SKILL_DIR]/eval-viewer/generate_review.py \
  .claude/skills/[スキル名]-workspace/iteration-1 --output review.html
```

**判定：**
- **delta ≥ 0.2 かつ reviewer の ❌ が0件：** Phase 5 へ進む
- **delta < 0.2 または reviewer の ❌ が1件以上（実装レベル）：** 問題点をユーザーに伝え、analyzer の改善提案を参考に writer.md（revise モード）で修正 → Step 4-2 からやり直す（上限1回）
- **2回目以降も改善しない / 構造的な問題（計画レベル）：** ユーザーに提示して Phase 1/2 まで遡るか判断を仰ぐ

---

## Phase 5: 統合・改善ループ・ユーザーへの提示

**Agent ツールは呼び出さない。司令塔が単独で行う（修正ループ時を除く）。**

`references/orchestrator-output.md` を Read し、手順に従って実行する。

---

## 入出力の定義

**入力（ユーザーが伝えること）：**
- 作りたいスキルの説明（自然言語・日本語可）
- 例：「月報を自動生成するスキルが欲しい」「PDF を要約するスキルを作って」

**出力（このスキルが生成するもの）：**
- `.claude/skills/[スキル名]/SKILL.md`（スキル本体）
- `.claude/skills/[スキル名]/evals/evals.json`（テストケース3件）
- マルチエージェント設計の場合はさらに `agents/` / `assets/` / `schemas/` も生成

**スキル発動に必要な条件：**
- 「スキルを作りたい」「スキルを設計して」「〜を自動化するスキル」などのリクエスト
- 対象外：既存スキルの実行・通常の質問への回答

---

## ユーザーへの話し方

- 技術用語（エージェント・アサーション・フロントマターなど）は使わない
- 処理中は何をしているかを一言で伝える
- 確認は一度にまとめる。細かい質問を何度も繰り返さない
- 選択肢は「Aで進めます。問題あれば言ってください」の形が使いやすい

---

## ファイル構成（参照先）

```
agents/                         # 各 Sub-agent プロンプト（フロントマターに model: 指定済み）
  criteria-gen.md               # Phase 2 Step 2-1：基準生成（Sonnet）
  criteria-comp.md              # Phase 2 Step 2-2：基準補完（Sonnet）
  structure-designer.md         # Phase 2.5 Step 1：構成設計（Sonnet・document のみ）
  structure-reviewer.md         # Phase 2.5 Step 2：構成検証（Sonnet・document のみ）
  writer.md                     # Phase 3：初稿執筆（Opus）/ 修正版執筆（Opus）
  tester.md                     # Phase 4 Step 4-1：テストプロンプト生成（Haiku）
  grader.md                     # Phase 4 Step 4-3：with_skill vs baseline 採点（Sonnet）
  reviewer.md                   # Phase 4 Step 4-4：定性チェック（Opus）
  comparator.md                 # Phase 4 Step 4-5：ブラインド A/B 比較（Sonnet）
  analyzer.md                   # Phase 4 Step 4-5：grading 結果のパターン分析・改善提案（Sonnet）

eval-viewer/
  generate_review.py            # ワークスペースをスキャンして静的 HTML レビューを生成
  viewer.html                   # レビュー UI テンプレート（grading 可視化・feedback 入力）

evals/
  evals.json                    # このスキル自体の評価テストケース（3件）

references/
  orchestrator-requirements.md  # 司令塔：要件整理・eval設計・パターン選択・ペルソナ設計の詳細手順
  orchestrator-output.md        # 司令塔：提示フォーマット・ループ・保存・eval実行の詳細手順
  coordination-patterns.md      # マルチエージェント協調パターン集（パターン選択・モデル選定に使用）
  best-practices.md             # スキル設計ベストプラクティス集（本体更新・スキル作成時の指標）
  schemas.md                    # エージェント間入出力スキーマ定義・evals/grading/benchmark の契約書
  skill-writing-guide.md        # 執筆 Sub Agent が参照するスキル執筆ルール
  criteria-by-task.md           # 基準生成 Sub Agent が参照するデフォルト基準
  flow-design.md                # Phase 1 で司令塔が参照するフロー設計手順

scripts/
  utils.py                      # 共通ヘルパー（JSON 読み書き・パス解決・description 更新）
  aggregate_benchmark.py        # grading 結果を統計集約して benchmark.json / benchmark.md を生成
  run_eval.py                   # evals.json を実行して grading.json をワークスペースに保存
  improve_description.py        # history から description 改善案を生成（blinded_history で過学習防止）
  run_loop.py                   # train/test 分割で description を最大5回反復改善
  package_skill.py              # スキルを .skill（ZIP）ファイルにパッケージング
  quick_validate.py             # スキル公開前の基本バリデーション（name・description・agents/ フロントマター）
```
