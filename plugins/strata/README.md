# strata

Delegates code/test/doc generation and adversarial review to high-speed local Strata models via skill and MCP server.

## 収録スキル

| スキル | 呼び出し | 説明 |
|---|---|---|
| `strata-worker` | `/strata:strata-worker` | Delegates code/test/doc generation and adversarial review to high-speed local Strata models via skill and MCP server. |

## 使い方

```
/strata:strata-worker <依頼内容>
```

詳細なフローは `skills/strata-worker/SKILL.md` を参照してください。

## 構成

このプラグインの `skills/` 配下がスキルの実体です。
リポジトリ内の `.agents/skills/<name>` がここへの相対シンボリックリンクになっています。

## MCP サーバー

`.mcp.json` により `strata` MCP サーバー（`strata_generate` / `strata_review`）が自動登録されます。

- エントリポイント: `${CLAUDE_PLUGIN_ROOT}/scripts/strata-mcp`
- バイナリ解決順: `PATH` 上の `strata` → `${XDG_DATA_HOME:-$HOME/.local/share}/strata/bin/strata` → ローカルリポジトリのリリースバイナリ → `cargo install` による自動導入
- 主な環境変数: `STRATA_BASE_URL`（既定 `http://127.0.0.1:8080/v1`）、`STRATA_API_KEY`、`STRATA_MODEL`
