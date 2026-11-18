---
name: strata-worker
description: "Delegates code/test/documentation generation and ruthless adversarial review to the high-speed Strata worker. Use test-gen for comprehensive tests, test-review for catching mock abuse, code-gen for minimal robust implementations, code-review for bug hunting, doc-gen for specs, and doc-review for semantic consistency."
---

# Strata Worker

高速推論エンジン **Strata**（`http://127.0.0.1:8080/v1` または `STRATA_BASE_URL`）へ、特化型ワーカーとしてタスクをオフロード（委譲）します。

生成役と敵対的検証役を明確に分離し、1 回完結型のプロンプト（数千トークン）で高速に実行します。

---

## 1. MCP ツールとしての利用

プラグイン同梱の `.mcp.json` により `strata` MCP サーバーが自動登録され、以下のツールを呼び出せます。

* **`strata_generate`**:
  * `role`: `"test-gen"`, `"code-gen"`, または `"doc-gen"`
  * `goal`: 達成すべき完了条件（必須）
  * `target`: 対象ファイルまたはシンボル名
  * `context`: 型定義、参考ファイル、契約
  * `output_path`: 保存先パス（指定時は自動で構文検査を実施）
  * `workspace_root`: 規約検出用のルートディレクトリ（任意）
  * `use_guidelines`: リポジトリ規約の自動注入を行うか（既定 `true`）
  * `max_tokens`: 最大出力トークン数（既定 `4096`）
  * `reasoning_effort`: 思考量レベル（`"low"`, `"medium"`, `"high"`。任意）
* **`strata_review`**:
  * `role`: `"test-review"`, `"code-review"`, または `"doc-review"`
  * `goal`: 検証基準・重点監査項目（必須）
  * `target`: 対象ファイルまたはコンポーネント
  * `context`: 仕様書・参考実装
  * `diff`: git diff 文字列
  * `workspace_root`: 規約検出用のルートディレクトリ（任意）
  * `use_guidelines`: リポジトリ規約の自動注入を行うか（既定 `true`）
  * `max_tokens`: 最大出力トークン数（既定 `4096`）
  * `reasoning_effort`: 思考量レベル（`"low"`, `"medium"`, `"high"`。任意）

### 用途別の使い分け

* **テスト生成 (`test-gen`)**: 正常系・異常系・境界値を網羅する単体テストの生成
* **敵対的テストレビュー (`test-review`)**: 甘いアサーション・モック隠蔽・Flaky 要因の検知
* **コード実装 (`code-gen`)**: 既存規約に沿った最小堅牢な実装の生成
* **敵対的コードレビュー (`code-review`)**: リーク・Off-by-one・エラー握りつぶし等の欠陥検知
* **ドキュメント生成 (`doc-gen`)**: 仕様・API リファレンスの作成
* **ドキュメント監査 (`doc-review`)**: 実装と文書の言行不一致検知

---

## 2. リポジトリ規約・レビュー観点の自動注入

既定（`use_guidelines: true`）では、`workspace_root`（未指定時はワークスペースルート）から以下の規約ファイルを自動検出してプロンプトに注入します（シンボリックリンクは重複排除）：

* **全ロール共通（生成・レビュー双方）**: `CLAUDE.md`, `AGENTS.md`, `REVIEW.md`
  * 実装役（`*-gen`）にも `REVIEW.md` を事前に渡すことで、レビュー基準から外れないコード・テスト・文書を生成します。
* **ロール別追加ガイドライン**:
  * `code-*`: `docs/guidelines/README.md`, `docs/guidelines/javascript.md`
  * `test-*`: `docs/guidelines/testing.md`, `docs/guidelines/README.md`
  * `doc-*`: `docs/guidelines/documentation.md`, `docs/guidelines/README.md`

---

## 3. 設定と前提

* **Strata API エンドポイント**:
  * 指定された OpenAI 互換エンドポイント（既定: `http://127.0.0.1:8080/v1`）が稼働・到達可能であること。
* **環境変数（任意）**:
  * `STRATA_BASE_URL`: 既定は `http://127.0.0.1:8080/v1`
  * `STRATA_API_KEY`: 既定は `~/.config/strata/api_key` から自動読込
  * `STRATA_MODEL`: 既定は `qwen3.8-flash-next-iq2_xs`
