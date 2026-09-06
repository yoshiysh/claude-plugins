# workflow

Claude Code 向け skill の active `Workflow({ scriptPath, args })` callsite を扱う内部プラグイン。
現在は JavaScript 実行 runtime へ移行中です。source が worker の prompt と参照資料を所有し、
runner が追加の LLM 変換担当・契約レビュアーを起動しない構成にしています。

## 収録スキル

| スキル | 呼び出し | 説明 |
|---|---|---|
| `dynamic-workflow-runner` | 内部専用 | caller skill が native Workflow 不在時に透過利用する compatibility layer |

## 使い方

ユーザーが runner を直接呼ぶ必要はありません。対応済み caller skill が active callsite に到達し、
native Workflow が現在の tool inventory に無いときだけ、この runner を内部利用します。

Claude Code では caller plugin の `dependencies` から導入されます。Codex は plugin dependency を
自動導入しないため、対応済み caller plugin と `workflow` をそれぞれ一度 install してください。

新 runtime は信頼済み source を JavaScript として実行し、Codex SDK の fresh thread へ
`agent()` の exact prompt を渡します。モデル名と reasoning effort は明示的な対応表で指定します。
adapter は既定で read-only。明示設定で workspace-write と完全 commit hash 起点の独立 worktree を使用できます。
call 数・並行数・期限を制限しますが、厳密な token 上限ではありません。

導入だけで native Workflow が追加されるわけではありません。既存 caller の旧 receipt 経路は
まだ新 runtime へ自動移行していません。現時点の検証範囲は自動テストと小さな live smoke であり、
全 caller の E2E、書込の live 検証、承認転送、resume は未完了です。
旧 manifest 手順は `skills/dynamic-workflow-runner/LEGACY.md` に隔離しています。

詳細なフローは `skills/dynamic-workflow-runner/SKILL.md` を参照してください。

## 構成

このプラグインの `skills/` 配下がスキルの実体です。
リポジトリ内の `.agents/skills/<name>` がここへの相対シンボリックリンクになっています。
