# Plugin-bundled native measurement

## Installation and first use

`performance` は `hooks/hooks.json` をpluginに同梱する。hook設定の手書き転記や他スキルへの
組込みは不要。Claude/Codexともpluginの有効化が必要で、Codexでは `/hooks` から現在の
hook定義を確認・信頼承認する。承認や管理者ポリシーを迂回しない。

ユーザー向け入口は `/performance:agent このプロジェクトの自動計測を有効にして`。
親はhost、対象プロジェクト、許可するtranscriptルート、保存先を一度確認し、同梱CLIを実行する。
全プロジェクトの一括有効化を推測しない。設定と集計はモデルを呼ばない。

```sh
python3 [SKILL_DIR]/scripts/native_hook.py enable --host claude --project <absolute-project> --transcript-root <absolute-transcript-root>
python3 [SKILL_DIR]/scripts/native_hook.py status
python3 [SKILL_DIR]/scripts/native_hook.py disable --host claude --project <absolute-project> --transcript-root <absolute-transcript-root>
```

Codexの場合は `--host codex`。標準候補はClaudeの `~/.claude/projects`、Codexの
`$CODEX_HOME/sessions`（未設定なら `~/.codex/sessions`）だが、実在と設定を確認する。
読込範囲はhookのcwdと一致する許可済みproject、および許可済みroot内の明示transcriptだけ。
子ディレクトリのcwdは自動許可しない。subagent transcriptや履歴一覧を探索しない。

保存先の既定は `~/.local/share/yoshiysh-performance`。任意の絶対パスを
`PERFORMANCE_DATA_DIR` で指定できるが、設定コマンドとhost起動時に同じ値が必要。
plugin更新で消えるcacheには保存しない。policyには許可パスを保存するが、native-ledgerには
本文・生ID・パス・モデル名を保存しない。両方private権限、ローカル保存のみ。
pluginの無効化/uninstallは今後のhook発火を止める。既存のローカル記録を勝手に削除しない。

## Input and accounting boundary

Claudeはassistant message IDごとに最新usageへ更新し、fresh+cache creation+cache readを入力とする。
Codexはtoken_countのsession累積snapshotを置換する。snapshot同士を加算しない。
通常会話のtranscriptはSDK query/exec JSONとは別形式なので、専用parserだけに渡す。
現在のplugin hookは親sessionだけを対象とし、スキル別の厳密帰属・子実行網羅性・課金換算を提供しない。
同じ内容を持つfork session等の費用重複排除は保証しない。集計は観測値で、請求やquotaではない。

transcriptは安定APIではない。認識したusage構造の欠損・退行・不正値は拒否し、0に補完しない。
未認識のレコード種別を計測できたとは扱わない。`measurement_complete=null`、品質未評価を維持する。
Stopで未到着のusageはSessionEnd/次のUserPromptSubmitで再読込できる場合があるが、最終回収保証ではない。

## Cost and limits

hookはstdin最大64KiB・最長1秒、収集子プロセス最長1秒、host側timeout3秒。
stdout/stderrへ本文やモデル向け追加文脈を出さず、LLM・ネットワークを起動しない。
未設定・無効化ならtranscriptを開かない。収集失敗は本来の作業を止めないが、収集成功とも扱わない。
現在は最大16MiBの対象ファイルを再解析する方式で、差分読込ではない。上限超過は収集しない。
10万行・1行1MiB・保持100session/2000usage records・30日。容量超過時は古いsessionを除外する。
定期削除ではなく、収集時に期限切れを除去し、reportは期限内だけを表示する。
sourceの祖先ディレクトリは信頼済みであること。所有者・regular file・末端symlink禁止を検査する。

## Acceptance evidence

2026-09-10: Claude Code 2.1.267で同梱hookを `--plugin-dir` から読み込む実推論1件を実施。
入力396/cached0/出力73が直接のusageとnative ledgerで一致。応答本文literalも一致。
Claudeの隔離marketplace install（別試験）、Codex 0.153.4の隔離marketplace add/install成功。
Codexのインストール済みhookの信頼承認後実行、Claudeの同じmarketplaceインストール個体からの
実推論は未検証。これらを同一のend-to-end試験済みとは表現しない。

Sources: [Claude hooks](https://code.claude.com/docs/en/hooks),
[Codex hooks](https://learn.chatgpt.com/docs/hooks).
