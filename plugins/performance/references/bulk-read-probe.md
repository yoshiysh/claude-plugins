# 案件別 bulk-read 委譲のプローブ（観測専用）

大きな `Read` を検出して軽量 worker に委譲するか判定するための
**観測/提案モードの hook** 実装。親のコンテキスト膨張を抑制する責務分離を、測定可能な
形で導入するためのセンサー。実行中のツールコールを阻止することはしない（observation）。

## 何をするか（としないか）

- `PreToolUse` で `Read` を検知し、対象ファイルの **サイズ（byte）だけ** を `stat` する。
  本文は読まない。外部へ送信しない。モデル向けに stdout へ出力しない。常に exit 0。
- サイズがしきい値以上のとき、パスを SHA-256 ハッシュ化した記録をローカルの private ledger
  （`probe.log`）へ追記する。これにより「どの程度の読み取りがどれだけ起きたか」を測定でき、
  委譲の閾値を実測から正せる。
- 本文・生パス・モデル名・ID を ledger に保存しない。他ユーザーのファイルは所有権チェックで
  除外する。

## 配置と配布

`performance` plugin に同梱する hook。既存の measurement hook（UserPromptSubmit/Stop/SessionEnd
→ `native_hook.py`）と同じ
`hooks/hooks.json` に `PreToolUse` を追加形で載せる。両ホストとも default discovery で読み込む。

```text
plugins/performance/
  hooks/hooks.json                     # PreToolUse(matcher Read) を追記
  scripts/
    bulk_read_probe.py                 # 共通実行層のセンサー（観測専用）
  references/
    bulk-read-probe.md                 # 本文（このファイル）
    native-hooks.md                    # measurement hook の正本（参照維持）
```

`hooks/hooks.json` の PreToolUse は `${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/scripts/
bulk_read_probe.py` を呼ぶ。`${CLAUDE_PLUGIN_ROOT}` の展開は既存の `native_hook.py` と同一経路
なので、Claude/Codex 両方で plugin 配布時に解決される（`native-hooks.md` 受入証拠済み）。

## 両ホストの PreToolUse 入力差

| | Claude Code | Codex |
|---|---|---|
| 共通フィールド | `cwd`, `transcript_path` | `session_id`, `transcript_path`, `cwd`, `model`, `turn_id` |
| ツール情報 | `tool_name`, `tool_input`（Read→`file_path`） | `tool_name`, `tool_input`（local function tool は引数そのまま） |
| 判断出力 | `hookSpecificOutput.permissionDecision`（allow/deny/ask/defer）+ `updatedInput` | 同形＋旧 `{decision:block, reason}`、`systemMessage` |

`bulk_read_probe.py` は `turn_id` の有無で host を判定し（なければ claude）、`tool_input`
から `file_path` / `path` / 生文字列の順で対象パスを抽出する。未対応形でもクラッシュせず exit 0
で流す（観測はブロックしない）。

### trust と実行環境

- **Claude Code**: plugin を有効化すれば discovery される。`hooks/hooks.json` の既定 discovery
  （manifest-reference の default directory）による。
- **Codex**: `hooks/hooks.json` を plugin root に同梱すると default discovery される。plugin
  由来の hook は non-managed なので、ユーザーが `/hooks` で現在の定義を確認・trust するまで
  実行されない。**trust を迂回しない**。
- 両者とも hook スクリプトは実行環境に存在する必要があり、Web 導入だけではデプロイされない。

## 境界と安全性

- **所有権**: `safe_size` は regular file・own user・final component に symlink なし（`O_NOFOLLOW`）
  のみを許す。`private_file` の「group/other 権限なし」検査は流用しない（通常ソースは 0o644 で
  それが通らず、その検査は own store 専用）。これにより他ユーザーのデータは測定対象外。
- **非読取**: `stat` のみ。本文を読まない・外部へ送らない。
- **保存**: `~/.local/share/yoshiysh-performance/bulk-read/`（`BULK_READ_DATA_DIR` で上書き）。
  private dir（0o700・owner match・group/other 権限なし）に JSONL 追記。10MiB 超過時は
  `.1` に rotate（バックアップ1のみ）。保持期間は未実装。
- **非ブロック**: observation のため常に `permissionDecision: allow`（= stdout なし）。誤検知が
  作業を止めない。

## しきい値の補正

既定 `DEFAULT_THRESHOLD_BYTES = 20000` は観測開始点であり、正解ではない。350行を普遍的な
正解として固定せず、実測した size 分布から決める。`BULK_READ_THRESHOLD_BYTES` で上書き可
能（キャリブレーション用）。`probe.log` の分布を見て、委譲効果と誤検知を測定した後、固定値へ固める。

## 委譲実装

このプロブは**センサー**まで。実際の「軽量 worker への委譲実行」は共通実行層の別実装とし、
`dynamic-workflow-runner` を必須にせず hook から直接呼べる構成で導入する。
ここでは測定と提案のみで完結する。

## 検証

```sh
cd plugins/performance/tests
python3 -m unittest test_bulk_read_probe -v
```
