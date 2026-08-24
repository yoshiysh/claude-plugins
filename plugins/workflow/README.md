# workflow

Claude Code 向け skill の active `Workflow({ scriptPath, args })` callsite を、Codex の bounded
multi-agent graph で fail-closed に実行する内部互換プラグイン。

## 収録スキル

| スキル | 呼び出し | 説明 |
|---|---|---|
| `dynamic-workflow-runner` | 内部専用 | caller skill が native Workflow 不在時に透過利用する compatibility layer |

## 使い方

ユーザーが runner を直接呼ぶ必要はありません。対応済み caller skill が active callsite に到達し、
native Workflow が現在の tool inventory に無いときだけ、この runner を内部利用します。

Claude Code では caller plugin の `dependencies` から導入されます。Codex は plugin dependency を
自動導入しないため、対応済み caller plugin と `workflow` をそれぞれ一度 install してください。

runner は workflow source を実行せずに読み、source と exact args に結合した bounded DAG へ変換します。
上限不明の fan-out / loop、意味保存できない処理、外部更新の無承認実行、未検証 return は
success に丸めず停止します。

詳細なフローは `skills/dynamic-workflow-runner/SKILL.md` を参照してください。

## 構成

このプラグインの `skills/` 配下がスキルの実体です。
リポジトリ内の `.agents/skills/<name>` がここへの相対シンボリックリンクになっています。
