# スキル設計ベストプラクティス

## 目次
1. [SKILL.md の設計原則](#1-skillmd-の設計原則)
2. [description の設計](#2-description-の設計)
3. [Sub-agent 設計](#3-sub-agent-設計)
4. [スキーマ契約（schemas.md）](#4-スキーマ契約schemasmd)
5. [確定的処理はスクリプトに追い出す](#5-確定的処理はスクリプトに追い出す)
6. [評価（eval）フレームワーク](#6-評価evalフレームワーク)
7. [アーキテクチャパターンの選択](#7-アーキテクチャパターンの選択)
8. [Human-in-the-Loop の設計](#8-human-in-the-loop-の設計)
9. [よくある失敗パターン](#9-よくある失敗パターン)
10. [チェックリスト（スキル公開前の確認）](#10-チェックリストスキル公開前の確認)

スキル本体の更新・新規スキル設計時の指標となる参照ドキュメント。
以下4ソースを統合している：
- [anthropics/skills - skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator)
- [Agent Skills Best Practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [nyosegawa - skill-creator and orchestration skill](https://nyosegawa.com/posts/skill-creator-and-orchestration-skill/)
- [Multi-agent coordination patterns](https://claude.com/blog/multi-agent-coordination-patterns)

---

## 1. SKILL.md の設計原則

### コンテキストは公共財

コンテキストウィンドウは全スキルが共有する。トークンコストを常に意識する。

**3層ローディング（Progressive Disclosure）**

| 層 | 内容 | 読込タイミング |
|---|---|---|
| Level 1 | name + description（~100トークン） | 常時注入 |
| Level 2 | SKILL.md 本体（推奨500行以内） | トリガー時 |
| Level 3 | references/ assets/ scripts/ | 参照・実行時のみ |

Level 3 のファイルはアクセスされるまでコンテキストを消費しない。
参照ファイルが大きくても問題ない。SKILL.md のみ軽量に保つ。

### Orchestratorの純粋性

SKILL.md は「誰に何を渡すか」だけを定義する。

- ドメイン知識（HTML仕様・コンポーネント詳細・業務ルール）は agents/ や assets/ に分離
- 判断ロジックは Sub-agent の責務
- SKILL.md にドメイン知識が混在し始めたら分割のサイン

**MVC的な責務分離**

```
SKILL.md          → Orchestrator（制御フロー）
agents/           → 専門家プロンプト（ドメインロジック）
references/       → データ契約 or ドメイン知識
assets/           → 変化しない参照データ（仕様・設定値）
scripts/          → 確定的処理（実行エンジン）
```

### 参照ファイルの深さ制限

参照は SKILL.md から **1レベル深さまで**。それ以上ネストすると Claude が部分的にしか読まない。

```
# 悪い例
SKILL.md → advanced.md → details.md → actual-info.md

# 良い例
SKILL.md → advanced.md
SKILL.md → details.md
SKILL.md → reference.md
```

100行を超える参照ファイルには **目次を冒頭に入れる**。
Claude が部分読みした場合でも全体像を把握できる。

---

## 2. description の設計

description はスキル発見の唯一の手がかり。最も重要な要素。

### 必須ルール

- **3人称で書く**（"I can help" や "You can use" は禁止）
- 最大1024文字
- XML タグ禁止
- [What] + [When] の両方を含む

**良い例**
```
Extracts text and tables from PDF files, fills forms, and merges documents.
Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
```

**悪い例**
```
Helps with documents
```

### トリガー精度の最適化

- Claudeは「スキルを使わなすぎる」傾向があるため、少し積極的（押し強め）に書く
- 「〜の場合に使う」より「〜なら使うこと」のスタイルが有効
- 競合しそうなスキルと明確に区別できる表現を入れる
- 除外条件（対象外）も明記する

### 命名規則

- lowercase letters / numbers / hyphens のみ（最大64文字）
- gerund 形式推奨：`processing-pdfs`、`analyzing-spreadsheets`
- 曖昧な名前は避ける：`helper`、`utils`、`tools`

---

## 3. Sub-agent 設計

### フロントマターでモデルを指定

各エージェントファイルの冒頭に記述。SKILL.md にモデルを書かなくてよくなる。

```markdown
---
model: sonnet
---

# agent-name
...
```

### モデル選定基準

| タスクの性質 | モデル |
|------------|--------|
| 深い創造・推論・高品質な生成 | Opus |
| 構造的判断・分類・計画 | Sonnet |
| 定型処理・パターンマッチング | Haiku（定型化済みのタスクのみ） |

Haiku は処理が完全に定型化できてから適用する。曖昧さや推論が残る場合は Sonnet 以上。

### 単一責務の原則

- 各 agent は「1入力 → 1出力」
- 「コンポーネントを選ぶ」と「挿入位置を決める」は別 agent
- Generator と Verifier は別エージェント（自分の出力を自分で検証しない）

### Why-driven prompt design

MUST/NEVER を並べるのではなく、理由を説明する。

```
# 悪い例
ALWAYS validate before submission.
NEVER skip the formatting step.

# 良い例
Validation prevents API errors that waste tokens.
Consistent formatting ensures the viewer can parse results.
```

例外：スキーマのフィールド名一致など「崖の近く」のクリティカルな箇所では制約も必要。

---

## 4. スキーマ契約（schemas.md）

エージェント間の入出力フォーマットを `references/schemas.md` に先に定義する。

```markdown
# schemas.md

## clarifier の出力
{
  "operation": "追加 | 削除 | 変更 | ...",
  "target_section": "section id or 新規",
  "summary": "変更内容の概要",
  "needs_clarification": true | false,
  "clarification_message": "確認が必要な場合のメッセージ or null"
}

## planner の出力
{
  ...
}
```

フィールド名のズレ（`config` vs `configuration`）でパイプラインが壊れる。
契約書を先に書き、全エージェントがその契約に従う設計にする。

---

## 5. 確定的処理はスクリプトに追い出す

| 処理の種類 | 担当 |
|-----------|------|
| 判断・分析・文章生成 | Claude（エージェント） |
| ループ・集計・ファイル操作 | scripts/ のスクリプト |
| 数値計算・統計処理 | scripts/ のスクリプト |

スクリプトを使う利点：
- LLM より信頼性が高い
- トークンを消費しない（出力だけが context に入る）
- 同じ処理を毎回安定して実行できる

スクリプトが失敗したとき Claude がフォールバックできるように設計する。

---

## 6. 評価（eval）フレームワーク

### eval-first 開発

**評価を先に作ってから実装する**。想定される問題ではなく実際の問題を解くため。

```
1. スキルなしで代表的なタスクを実行 → 失敗・不足を記録
2. テストケースを3件作成（evals.json）
3. スキルなしのベースラインを計測
4. 最小限の指示を書いてギャップを埋める
5. 評価 → ベースラインと比較 → 改善
```

### evals.json の構造

```json
{
  "skill_name": "generated-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "ユーザーのタスクプロンプト",
      "expected_output": "期待する動作の説明",
      "assertions": [
        "適切なライブラリを使用して処理している",
        "出力が指定フォーマットに従っている"
      ]
    }
  ]
}
```

### with_skill vs baseline の並列比較

```
with_skill版実行 → grading.json（PASS/FAILと根拠）
baseline版実行  → grading.json（PASS/FAILと根拠）
                       ↓
          aggregate_benchmark.py で統計集約
                       ↓
          analyzer.md でパターン分析・改善提案
```

### description 最適化ループ

```
20件のトリガー評価クエリを作成
  └─ should_trigger 8〜10件（様々な言い回し）
  └─ should_not_trigger 8〜10件（近い関連ドメイン）

60/40 で train/test 分割
各クエリを3回実行（信頼性確保）
最大5反復で description を改善
test スコアでベストを選択（過学習防止）
```

---

## 7. アーキテクチャパターンの選択

`references/coordination-patterns.md` を参照。

### 2つのアーキテクチャ

**Sub-agent 型**（1スキル内でサブエージェントを生成）
- SKILL.md がマネージャー役に徹する
- 並列処理で時間短縮
- 適例：品質保証が重要・Human-in-the-Loop が必要

**Skill Chain 型**（独立したスキルを直列連結）
- 各スキルが独立して再利用可能
- 明確な順序性があるフェーズ移行
- 適例：調査→実装→レポートのような独立フェーズ

### パターン組み合わせの例

skill-creator は Parallelization + Orchestrator-Workers + Evaluator-Optimizer を組み合わせている。
単一パターンに縛られず、要件に応じて組み合わせる。

---

## 8. Human-in-the-Loop の設計

チャット UI に閉じず、タスクに最適なインターフェースを生成する。

```
eval-viewer/generate_review.py → ローカル HTML ダッシュボード
feedback.json で構造化フィードバック収集
5秒 auto-refresh で最適化ループの進捗をリアルタイム表示
```

フィードバック収集のポイント：
- 「スキルが期待通りにトリガーされるか」
- 「指示が明確か」
- 「何が不足しているか」

---

## 9. よくある失敗パターン

| 失敗 | 対策 |
|------|------|
| SKILL.md にドメイン知識を詰め込む | agents/ / assets/ / references/ に分離 |
| 参照が深くネストしている | SKILL.md から1レベル深さまでに制限 |
| description が抽象的 | [What] + [When] を具体的なユーザー発話で示す |
| 選択肢を多く提示しすぎる | デフォルトを1つ示し、例外だけ補足する |
| MUST/NEVER を多用する | 理由を説明する（Why-driven） |
| 評価なしで実装する | eval-first：テストケースを先に作る |
| スキーマ定義がない | schemas.md を先に書く |
| 確定的処理を LLM に任せる | scripts/ にスクリプトとして実装する |
| 時間に依存した情報を書く | "old patterns" セクションに分離 |
| Windows スタイルのパス | 常に forward slash を使う |
| エージェント間の競合環境を無視する | description の改善は競合スキルを考慮して設計する |

---

## 10. チェックリスト（スキル公開前の確認）

### 基本品質
- [ ] description が具体的で [What] + [When] の両方を含んでいる
- [ ] description が3人称で書かれている
- [ ] SKILL.md 本体が500行以内
- [ ] 追加の詳細が別ファイルに分離されている
- [ ] 参照ファイルの深さが1レベルに収まっている
- [ ] 100行超の参照ファイルに目次がある
- [ ] 時間依存の情報が含まれていない
- [ ] 用語が一貫している
- [ ] 具体的な例が含まれている
- [ ] フィードバックループ（検証→修正）が設計されている

### マルチエージェント設計（該当する場合）
- [ ] SKILL.md がフロー制御のみを持っている
- [ ] 各エージェントが単一責務を持っている
- [ ] フロントマターでモデルが指定されている
- [ ] schemas.md でエージェント間の入出力が定義されている
- [ ] assets/ に参照データが分離されている
- [ ] Generator と Verifier が別エージェントになっている
- [ ] エラー時の差し戻し先（計画レベル/実装レベル）が定義されている

### テスト
- [ ] 最低3件の評価テストケースを作成した
- [ ] Sonnet と Opus でテストした
- [ ] 実際のユースケースでテストした
