---
name: best-practices
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
生成の中核（Phase 2–4）は `scripts/build_skill.js`（Workflow スクリプト）が実行し、
各 agent には `model` と役割定義ファイルの Read 指示を渡す。司令塔が担うのは、その前後にある
2 つの人間ゲート（Phase 1 のペルソナ承認・Phase 5 の保存承認）だけ。

## 目次

1. [全体フロー](#全体フロー)
2. [Phase 1: 要件整理とペルソナ設計](#phase-1-要件整理とペルソナ設計)
3. [Phase 2–4: Workflow を呼ぶ](#phase-24-workflow-を呼ぶ)
4. [Phase 5: 統合・保存](#phase-5-統合改善ループユーザーへの提示)
5. [入出力の定義](#入出力の定義)
6. [ユーザーへの話し方](#ユーザーへの話し方)
7. [ファイル構成](#ファイル構成参照先)

---

## 全体フロー

```
Phase 1: 要件整理・ペルソナ設計（司令塔が単独で実行・人間ゲート）
  └─ 要件を構造化 → ペルソナを推論 → ユーザーに確認
  ※ 詳細手順： references/orchestrator-requirements.md を Read すること

Phase 2–4: Workflow を呼ぶ（scripts/build_skill.js が全て内包）
  Criteria   criteria-gen（Sonnet）→ criteria-comp（Sonnet）で検証基準を確定
  Structure  document のみ。structure-designer → structure-reviewer の until-pass ループ
  Write      writer（Opus, MODE=initial）が初稿を執筆
  Test       tester（Haiku）が assertions 付きテストケース3件を生成
  Evaluate   with_skill / baseline を全ケース分まとめて並列実行（6 agent）
  Grade      grader を3件並列（Sonnet）+ reviewer（Opus）を同時実行 → pass_rate を集計
  Analyze    comparator（Sonnet）→ その結果を入力に analyzer（Sonnet）
  → delta < 0.2 または reviewer の失格項目があれば writer（revise）で改稿し Evaluate へ戻る
     （改稿は1回まで。それでも届かなければ判断材料を添えて Phase 5 へ返す）

Phase 5: 統合・保存（司令塔が単独で実行・人間ゲート）
  └─ pass_rate と定性レポートをユーザーに提示 → 承認後に保存
  ※ 詳細手順： references/orchestrator-output.md を Read すること
```

**なぜ Phase 2–4 だけを script にするか**: この区間は fan-out・集約・閾値判定・条件付き
再実行の連なりで、途中に人間の判断が要らない。散文で「同一ターンで6エージェント同時起動」
「delta を集計して 0.2 未満なら改稿」と書いても、実行者がまとめ忘れたり閾値を目分量で
判断したりする余地が残る。script にすれば並列化も集計も閾値判定も構造として決まる。

一方 Phase 1（ペルソナ承認）と Phase 5（保存承認）は**設計された人間ゲート**であり、
Workflow は実行中にユーザー入力を受け取れないため script に入れられない。この 2 つは
司令塔が持つ。

---

## Phase 1: 要件整理とペルソナ設計

**Agent ツールは呼び出さない。司令塔が単独で行う。**

`references/orchestrator-requirements.md` を Read し、手順に従って実行する。

完了条件：ユーザーがペルソナを承認したらPhase 2へ進む。

---

## Phase 2–4: Workflow を呼ぶ

ユーザーへの一言：
> 「基準づくりから執筆・品質チェックまでをまとめて回しています...」

```
Workflow({
  scriptPath: "[SKILL_DIR]/scripts/build_skill.js",
  args: {
    skillDir: "[SKILL_DIR]",
    requirements: "<Phase 1 で構造化した要件全体>",
    requirementsSummary: "<トリガー条件・対象ユーザーの要約>",
    taskType: "document | workflow | data",
    personas: {
      criteriaGen: "...", criteriaComp: "...",
      structureDesigner: "...", structureReviewer: "...",
      writer: "...", tester: "...", reviewer: "..."
    }
  }
})
```

`skillDir` には本スキルの実ディレクトリを実パスで渡す。スクリプトは自身の位置を解決できず、
`agents/*.md` の Read パスがここでしか決まらない。`personas` は Phase 1 でユーザーが承認した
ペルソナ説明文を役割ごとに入れる（未指定の役割は script 側で「要件から自分で置く」旨の
指示に落ちる）。

完了すると以下が返る：

```
{
  task_type, criteria, structure: { plan, attempts, unresolved, review },
  skill_draft, test_cases, iterations[], final, revisions_used, verdict
}
```

`verdict` は次の 4 値。

| verdict | 意味 |
|---|---|
| `passed` | 全テストケースが採点され、reviewer も応答し、delta >= 0.2 かつ失格 0 件 |
| `needs_human_decision` | 評価は揃ったが、改稿上限に達しても閾値に届かなかった（品質の問題） |
| `evaluation_incomplete` | 採点 agent か reviewer が応答せず、合否を判定できなかった（品質とは無関係） |
| `revision_failed` | 改稿 agent が応答しなかった |

`passed` は「閾値を超えた」だけでなく**評価が揃った**ことも要求する。落ちた agent の分を
欠測として扱わず平均に含めると、生き残った少数の結果から出た数字が全体の成績に見える
（3 件中 2 件が落ちて 1 件だけ delta 0.9 を返すと平均も 0.9 になる）。reviewer も同じで、
応答が無い状態を「失格 0 件」と読むと「レビューされていない」が「レビューを通った」に化ける。
1 件も採点できなかったときの `delta` は `0` ではなく `null` を返す（`0` は実測の引き分けを
意味する値なので、欠測をそこに丸めない）。

### script が構造として保証すること

散文の手順書で担保していたものを、実行構造そのものに置き換えた対応表。

| 保証 | 実現方法 |
|---|---|
| with_skill と baseline が必ず対で走る | 全テストケース分を 1 つの `parallel()` にまとめて発行。直列化も片側だけの実行も起こりえない |
| pass_rate と delta が正確 | 集計は script の算術。LLM に平均を出させない |
| 閾値判定がぶれない | `delta >= 0.2 && reviewer.failed.length === 0` という式。目分量が入らない |
| 改稿が無限に続かない | `revision >= maxRevisions`（既定 1）で打ち切り、判断材料を添えて司令塔へ返す |
| 構成の差し戻しが止まる | designer → reviewer を最大 2 回。未解決の指摘は `structure.unresolved` に載せて返す |
| Generator と Verifier が別 agent | designer と reviewer、writer と reviewer をそれぞれ別 spawn |
| テストが改稿を跨いで同一 | テストケース生成はループの外。pass_rate の変化が「スキルの改善」だけを反映する |
| 出力欠損を成績に混ぜない | 片側の出力が欠けたペアは採点に回さず `ungraded_cases` として数える |
| 検証結果が書式に左右されない | reviewer 系は schema で `failed[]` を返す。markdown 中の ❌ を script が数えない |

### 判定を script に閉じない箇所

`verdict: needs_human_decision` は「実装レベルの修正では届かなかった」という報告であって、
失敗の宣告ではない。Phase 5 でユーザーに提示し、要件・基準（Phase 1/2 相当）まで遡るかを
人間が決める。script はそこを自動で判断しない。

### eval-viewer の生成

Workflow 完了後、以下のコマンドをユーザーに案内する（実行はユーザーが行う）：

```bash
# 評価結果をワークスペースに保存
python3 [SKILL_DIR]/scripts/run_eval.py \
  --skill-path .claude/skills/[スキル名] --iteration 1

# review.html を生成してブラウザで確認
python3 [SKILL_DIR]/eval-viewer/generate_review.py \
  .claude/skills/[スキル名]-workspace/iteration-1 --output review.html
```

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
agents/                         # 各 Sub-agent プロンプト（build_skill.js が Read させる）
  criteria-gen.md               # Criteria：基準生成（Sonnet）
  criteria-comp.md              # Criteria：基準補完（Sonnet）
  structure-designer.md         # Structure：構成設計（Sonnet・document のみ）
  structure-reviewer.md         # Structure：構成検証（Sonnet・document のみ）
  writer.md                     # Write：初稿執筆 / 改稿（Opus）
  tester.md                     # Test：テストケース生成（Haiku）
  grader.md                     # Grade：with_skill vs baseline 採点（Sonnet）
  reviewer.md                   # Grade：定性チェック（Opus）
  comparator.md                 # Analyze：ブラインド A/B 比較（Sonnet）
  analyzer.md                   # Analyze：grading 結果のパターン分析・改善提案（Sonnet）

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
  build_skill.js                # Phase 2–4 本体（Criteria/Structure/Write/Test/Evaluate/Grade/Analyze
                                #   + 改稿ループ。読む場合はコメントを含めて全文読むこと）
  utils.py                      # 共通ヘルパー（JSON 読み書き・パス解決・description 更新）
  aggregate_benchmark.py        # grading 結果を統計集約して benchmark.json / benchmark.md を生成
  run_eval.py                   # evals.json を実行して grading.json をワークスペースに保存
  improve_description.py        # history から description 改善案を生成（blinded_history で過学習防止）
  run_loop.py                   # train/test 分割で description を最大5回反復改善
  package_skill.py              # スキルを .skill（ZIP）ファイルにパッケージング
  quick_validate.py             # スキル公開前の基本バリデーション（name・description・agents/ フロントマター）
```
