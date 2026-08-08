# スキル執筆ガイドライン

## 目次
- [SKILL.md の必須構造](#skillmd-の必須構造)
- [命名規則](#命名規則)
- [description の書き方（最重要）](#description-の書き方最重要)
- [本文の書き方](#本文の書き方)
- [マルチエージェント設計の原則](#マルチエージェント設計の原則)
- [document タイプの追加ルール](#document-タイプの追加ルール)
- [eval-first 開発](#eval-first-開発)
- [パターン選択](#パターン選択)
- [良い SKILL.md の基準](#良い-skillmd-の基準)
- [よくある失敗パターン](#よくある失敗パターン)

執筆 Sub-agent が参照するスキル執筆ルール。
`references/best-practices.md` の知見をエージェント向けに凝縮したもの。

---

## SKILL.md の必須構造

```
---
name: スキル識別子（英小文字・ハイフン区切り・最大64文字）
description: >
  [3人称で記述。最大1024文字。[What]+[When]の両方を含む]
---

# スキル名

## 目的・概要

## フロー / 手順（またはアーキテクチャフロー図）

## 入出力の定義

## 注意事項
```

---

## 命名規則

- gerund 形式を推奨：`processing-pdfs`、`analyzing-spreadsheets`、`editing-guide`
- lowercase / numbers / hyphens のみ（最大64文字）
- 曖昧な名前は避ける：`helper`、`utils`、`tools`、`data`、`files`

---

## description の書き方（最重要）

description はスキルが「いつ自動で呼ばれるか」を決める唯一の手がかり。

**必須ルール：**
- **3人称で書く**（"I can help" や "You can use" は禁止）
- [What]（何をするか）+ [When]（いつ使うか）の両方を含む
- 最大1024文字・XML タグ禁止
- 競合しそうなスキルと区別できる表現を入れる
- 除外条件（対象外）も明記する
- 「少し押し強め」に書く（Claudeはスキルを使わなすぎる傾向がある）

**良い例：**
```
PDF ファイルのテキスト抽出・フォーム入力・結合・分割を行うスキル。
「この PDF からデータを抜いて」「PDF にパスワードをかけて」「複数の PDF を1つにまとめて」
といったリクエストで使うこと。.pdf ファイルへの言及があれば積極的に使う。
月報や Word 文書は対象外。
```

**悪い例：**
```
ドキュメントを処理するスキル。
```

---

## 本文の書き方

### Why-driven prompt design

MUST/NEVER を並べるのではなく、理由を説明する。

| NG（Must-driven） | OK（Why-driven） |
|-------------------|-----------------|
| ALWAYS validate before submission. | Validation prevents API errors that waste tokens. |
| NEVER skip the formatting step. | Consistent formatting ensures the viewer can parse results. |

例外：スキーマのフィールド名一致など「崖の近く」のクリティカルな箇所では制約も必要。

### 長さの目安

- SKILL.md 本体：**500行以内**（超えたら references/ に分割）
- 参照ファイルは SKILL.md から **1レベル深さまで**（それ以上ネストすると Claude が部分的にしか読まない）
- 参照ファイルが **100行を超える場合は冒頭に目次を入れる**

### 選択肢を絞る

複数の選択肢を並べず、デフォルトを1つ示して例外だけ補足する。

```
# 悪い例
"pypdf、pdfplumber、PyMuPDF、pdf2image のどれかを使う"

# 良い例
"テキスト抽出には pdfplumber を使う。スキャン PDF（OCR が必要）の場合は pdf2image + pytesseract を使う"
```

### 時間依存情報を避ける

```
# 悪い例
"2025年8月以前は旧 API を使う"

# 良い例（old patterns セクションに分離）
## 現在の方法
v2 API を使う: api.example.com/v2/messages

## 旧仕様（廃止済み）
v1 API: api.example.com/v1/messages（2025-08 廃止）
```

---

## マルチエージェント設計の原則

### Orchestratorの純粋性

SKILL.md（Orchestrator）は「誰に何を渡すか」だけを定義する。

- ドメイン知識（HTML仕様・コンポーネント詳細・業務ルール）は agents/ や assets/ に分離
- 判断ロジックは Sub-agent の責務
- SKILL.md にドメイン知識が混在し始めたら分割のサイン

**MVC 的な責務分離：**

```
SKILL.md          → Orchestrator（制御フロー）
agents/           → 専門家プロンプト（ドメインロジック・スクリプト呼び出しの判断）
references/       → データ契約 or ドメイン知識
assets/           → 変化しない参照データ（仕様・設定値）
scripts/          → 確定的処理（実行エンジン）
```

**agent と scripts の関係：**
- agent は「何をどのスクリプトで処理するか」を判断し、スクリプトを呼ぶ
- scripts は確定的な変換・計算・フォーマットを実装する（Claude が変換ロジックを自前実装しない）
- Claude が変換ロジックを agent の本文に直書きしている場合は scripts に切り出すサイン

**他スキルのパイプライン呼び出し：**
- 別スキルの呼び出しも agent の責務。SKILL.md から直接呼ばない
- 例：`update-confluence-page` では `existing-page-fetcher` agent が `fetch-confluence-page` スキルを呼ぶ
- 別スキルを呼ぶ agent は「呼び出しの責任を持つ単一責務 agent」として切り出す
- 別スキルを呼ぶ際は、そのスキルの出力フォーマット（YAML フロントマター等）から必要なフィールドを取り出す

**出力フォーマットの後続スキル向け設計：**
- 後続スキルが使うフィールドを最初から出力フォーマットに含める
- 例：`fetch-confluence-page` の出力に `version`（更新 API 必須）・`space_key`・`edit_url` を含める
- 後続スキルが何を必要とするかを Phase 1 の要件整理時に確認しておく

### 単一責務の原則

- 各 agent は「1入力 → 1出力」
- 判断・変換・生成を1つのエージェントに混在させない
- Generator と Verifier は別エージェント（自分の出力を自分で検証しない）
- フロントマターで `model:` を指定する（SKILL.md にモデルを書かない）

### assets の分離

変化しない参照データは `assets/` に分離する：

```
assets/
  components.md   コンポーネント一覧・仕様（HTMLの仕様書など）
  structure.md    ファイル構造・命名規則
```

`agents/` に置く .md ファイルは「処理の指示」だけを含む。
Sub-agent が必要なタイミングで `assets/` を Read する設計にする。

### schemas 先行設計

エージェントを複数使う設計の場合、`references/schemas.md` を最初に設計する。
フィールド名のズレでパイプラインが壊れるため、契約書を先に書く。

---

## document タイプの追加ルール

- 実際の入力例と出力例をセットで **1パターン以上含める**（「省略」と書いて省くことは禁止）
- サンプルが具体的であるほど、Claude の出力品質が安定する

---

## eval-first 開発

スキルを書く前にテストケースを作る。

```
1. スキルなしで代表的なタスクを実行 → 失敗・不足を記録
2. テストケースを3件作成（evals.json）
3. スキルなしのベースラインを計測
4. 最小限の指示を書いてギャップを埋める
5. 評価 → ベースラインと比較 → 改善
```

evals.json のフォーマットは `references/schemas.md` を参照。

---

## パターン選択

`references/coordination-patterns.md` を参照して適切なパターンを選ぶ。
基本は Orchestrator-Subagent を骨格とし、以下を組み合わせる：

- 品質保証が必要 → Generator-Verifier を追加
- 独立した複数観点の検証 → Parallelization を追加

---

## 良い SKILL.md の基準

「このSKILL.mdを読んだだけで動作を再現できるか」が判断基準。
読んだ後に「〜の場合はどうするの？」という追加の質問が必要なら、仕様として未完成。

---

## よくある失敗パターン

| 失敗 | 対策 |
|------|------|
| description が抽象的すぎてトリガーされない | [What]+[When] を具体的なユーザー発話で示す |
| description が1人称になっている | 3人称で書く（"Processes..." の形式） |
| 指示が多すぎてモデルが迷う | 優先順位を明示する（「最重要は〜」） |
| MUST/NEVER を多用する | 理由を説明する（Why-driven） |
| SKILL.md にドメイン知識を詰め込む | agents/ / assets/ / references/ に分離。変換ルール・定型メッセージ・設定値・URL はすべて外出しする |
| SKILL.md に変換ルール表を書く | references/ または assets/ に分離。SKILL.md は「○○変換スクリプトを実行する」とだけ書く |
| SKILL.md に定型エラーメッセージを書く | assets/error-messages.md 等に分離。SKILL.md はエラー種別の分岐だけ書く |
| agents/ に参照データを直書きする | 参照データは assets/ に置き、agent が Read する設計にする |
| 確定的な処理を Claude に任せる | scripts/ にスクリプトとして実装し、agents/ 経由で呼ぶ |
| SKILL.md が直接スクリプトを呼ぶ | スクリプト呼び出しも Sub-agent の責務。SKILL.md は「agent を呼ぶ」とだけ書く |
| 「シンプルだから Sub-agent 不要」と判断する | 処理の複雑さに関係なく常に Sub-agent に切り出す。SKILL.md はフローの進行のみ |
| 参照が深くネストしている | SKILL.md から1レベル深さまでに制限 |
| 選択肢を多く提示しすぎる | デフォルトを1つ示し、例外だけ補足 |
| エラー時の記述がなく止まる | 「〜の場合は〜して続ける」を入れる |
| 非エンジニアが読めない | 技術用語に括弧で補足を入れる |
| 入出力が曖昧 | 「入力：〜 → 出力：〜」を明示する |
| document タイプでサンプルが省略されている | 入力例・出力例のセットを必ず完全に記述する |
| schemas がない | エージェント間の入出力フォーマットを先に定義する |
| 異常系・準正常系・正常系エッジケースが未定義 | 空・不完全・想定外の入力への挙動を3種で整理して明示する |
| agent の description が「何をするか」だけで「いつ呼ばれるか」がない | 前のステップの agent 名またはスキル起動タイミングを description に明記する |
| agent の description に除外条件がない | 「何をしないか」「エラー時はどうするか」を description に追記する |
| agent 本文に命令だけあって理由がない | Why-driven で書く。なぜそのコマンド・順番・条件なのかを添える |
| 変換ロジックを agent 本文に Claude が直書きしている | scripts/ に確定的処理を切り出し、agent はそれを呼ぶだけにする |
| 別スキルと同じ処理を重複実装している | 既存スキルをパイプライン呼び出しで再利用する。専用 agent に呼び出しを委譲する |
| SKILL.md から直接別スキルを呼んでいる | 別スキルの呼び出しも agent の責務。SKILL.md はその agent を呼ぶとだけ書く |
| 後続スキルが必要とするフィールドを出力に含めていない | Phase 1 で後続スキルの入力要件を確認し、出力フォーマットに必要フィールドを最初から含める |
