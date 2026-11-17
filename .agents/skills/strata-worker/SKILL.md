---
name: strata-worker
description: "Delegates code/test/documentation generation and ruthless adversarial review to the high-speed local Strata worker (Qwen MoE via WSL). Use test-gen for comprehensive tests, test-review for catching mock abuse, code-gen for minimal robust implementations, code-review for bug hunting, doc-gen for specs, and doc-review for semantic consistency."
---

# Strata Worker

Windows/WSL 上で稼働する高速ローカル推論エンジン **Strata**（`http://127.0.0.1:8080/v1`）へ、
特化型ワーカーとしてタスクをオフロード（委譲）します。

生成役と敵対的検証役を明確に分離し、1 回完結型のプロンプト（数千トークン）で高速に実行します。

---

## 1. CLI からの実行

ネイティブ Rust バイナリ `tools/strata run`（または互換ラッパー `tools/strata-worker`）経由で実行します。起動時間は 1ms 未満です。

```bash
# テストコード生成 (正常系・異常系・境界値を網羅)
tools/strata run --role test-gen --target "path/to/target.py" --goal "Write comprehensive unit tests covering all edge cases" --output "tests/test_target.py"

# 敵対的テストレビュー (甘いアサーション、モック隠蔽、Flaky 検知)
tools/strata run --role test-review --target "tests/test_target.py" --context "path/to/target.py" --goal "Verify test quality and attack weaknesses"

# コード実装 (既存規約に沿った最小堅牢な実装)
tools/strata run --role code-gen --target "path/to/file.py" --goal "Implement user authentication helper" --context "path/to/types.py" --output "path/to/file.py"

# 敵対的コードレビュー (欠陥ハンター: リーク、Off-by-one、エラー握りつぶし)
tools/strata run --role code-review --target "path/to/file.py" --diff --goal "Find all critical failure modes and concurrency bugs"

# ドキュメント作成 (仕様解説)
tools/strata run --role doc-gen --target "path/to/file.py" --goal "Write API reference document" --output "docs/api.md"

# ドキュメント監査 (言行不一致検知)
tools/strata run --role doc-review --target "docs/api.md" --context "path/to/file.py" --goal "Verify consistency between doc and actual implementation"
```

※ 従来の `tools/strata-worker --role ...` も透過的に Rust 実装へ委譲されます。

---

## 2. MCP ツールとしての利用

MCP クライアント（Claude Code, Antigravity, Cursor 等）の `mcpServers` 設定に `tools/strata mcp`（または `tools/strata-mcp`）を登録することで、以下のツールを呼び出せます：

* **`strata_generate`**:
  * `role`: `"test-gen"`, `"code-gen"`, または `"doc-gen"`
  * `goal`: 達成すべき完了条件（必須）
  * `target`: 対象ファイルまたはシンボル名
  * `context`: 型定義、参考ファイル、契約
  * `output_path`: 保存先パス（指定時は自動で構文検査を実施）
* **`strata_review`**:
  * `role`: `"test-review"`, `"code-review"`, または `"doc-review"`
  * `goal`: 検証基準・重点監査項目（必須）
  * `target`: 対象ファイルまたはコンポーネント
  * `context`: 仕様書・参考実装
  * `diff`: git diff 文字列

---

## 3. 設定と前提

* **Strata サーバーの起動**:
  ```bash
  tools/claude-strata --start-server
  ```
* **環境変数（任意）**:
  * `STRATA_BASE_URL`: 既定は `http://127.0.0.1:8080/v1`
  * `STRATA_API_KEY`: 既定は `~/.config/strata/api_key` から自動読込
  * `STRATA_MODEL`: 既定は `qwen3.8-flash-next-iq2_xs`
