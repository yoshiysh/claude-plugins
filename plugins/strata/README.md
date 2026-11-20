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

`.mcp.json` により `strata` MCP サーバーが自動登録されます（提供ツールと使い方は `skills/strata-worker/SKILL.md` を参照してください）。

- エントリポイント: `${CLAUDE_PLUGIN_ROOT}/scripts/strata-mcp`
- 接続先 URL 解決: `STRATA_BASE_URL` 未設定時は `${CLAUDE_PLUGIN_ROOT}/scripts/resolve-strata-url.sh` で接続先を解決します。既定では LAN 探索を行わず `http://127.0.0.1:${STRATA_PORT:-8080}/v1` へフォールバックし、`STRATA_LAN_RESOLVE=1` または `STRATA_LAN_HOST` 指定時のみ `curl` で疎通確認して到達可能な LAN URL を選択します（`STRATA_LAN_RESOLVE=0` のときは `STRATA_LAN_HOST` 指定時でも探索を無効化します）
- バイナリ解決順:
  1. ローカルリポジトリのリリースバイナリ（`crates/strata/target/release/strata`。リポジトリを checkout した開発環境でのみ有効）
  2. 版別キャッシュ（`${XDG_DATA_HOME:-$HOME/.local/share}/strata/<version>/bin/strata`）
  3. `PATH` 上の `strata`
- 事前導入と未導入時の挙動: 起動タイムアウトを防ぐため MCP 起動時の自動ビルドは行いません。上記のいずれにもバイナリが見つからない場合は、事前導入コマンド（`cargo install --locked --git https://github.com/yoshiysh/claude-plugins.git --tag strata-v<version> --bin strata --root "${XDG_DATA_HOME:-$HOME/.local/share}/strata/<version>"`）を標準エラー出力に表示して終了コード `1` で終了します。
- 主な環境変数:
  - `STRATA_BASE_URL`: 接続先エンドポイント（設定時は探索をスキップ、既定フォールバックは `http://127.0.0.1:8080/v1`）
  - `STRATA_PORT`: 接続先探索およびフォールバックに使うポート番号（既定 `8080`）
  - `STRATA_LAN_RESOLVE`: `1` で `STRATA_HOST` への SSH（`ssh -G` / `ssh hostname`）による LAN 探索を有効化、`0` で `STRATA_LAN_HOST` を含め探索を常に無効化（既定は未設定で SSH 探索無効）
  - `STRATA_LAN_HOST`: 起動時に疎通確認する LAN ホスト名または IP（`STRATA_LAN_RESOLVE=0` でない場合に探索対象へ追加）
  - `STRATA_HOST`: `STRATA_LAN_RESOLVE=1` 時の起動時 SSH 先および `strata_diagnose` の対象ホスト名（既定 `winbox`）
  - `STRATA_API_KEY`: API キー
  - `STRATA_MODEL`: 使用モデル
