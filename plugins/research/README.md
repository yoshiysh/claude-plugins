# research

一次情報検証つきの調査ツールを提供するプラグイン。

## 収録スキル

| スキル | 呼び出し | 説明 |
|---|---|---|
| `search` | `/research:search` | 一次情報検証つき調査。全事実主張を三値判定してから回答を組む |
| `reference` | `/research:reference` | 技術的な回答で推測と確認済み情報を区別させる（`user-invocable: false`） |
| `url-reader` | `/research:url-reader` | ドメイン別 reader backend で URL を安定 Markdown 化する |
| `dispatch` | `/research:dispatch` | planner/executor/verifier を分け、複数ラウンドの調査・検証を行う |

## 使い方

```
/research:search <調査したいこと>
/research:dispatch <深掘りしたい難問>
```

詳細なフローは `skills/<name>/SKILL.md` を参照してください。

`search` / `dispatch` の Workflow callsite は native Workflow を優先し、それが無い Codex では
`workflow:dynamic-workflow-runner` を内部利用します。search は bounded mapping を使います。dispatch は
Codex profile で全 agent call の model と effort を省略し、runner の host-default model で実行します。
native Claude Workflow の Fable 5 model profile と同一・同等とは扱いません。実 model ID は dispatch の
source result と runner の `model.selected` event のどちらにも現れません。Claude Code は plugin dependency で
`workflow` も導入しますが、Codex では `research` と `workflow` を一度ずつ install してください。
Codex runner request の top-level `limits` には `dispatch/scripts/orchestrate.js` の literal
`meta.limits` をそのまま渡します。実行ごとの loop 上限は source が args と本体の既定値・hard cap の定数
（`DEFAULT_*` / `HARD_*`）から適用します。

## 構成

このプラグインの `skills/` 配下がスキルの実体です。
リポジトリ内の `.agents/skills/<name>` がここへの相対シンボリックリンクになっています。
