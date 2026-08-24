# pdca

PDCA ループ実行スキル。契約固定・思考オペレータ選択型（問題/動機/主張検証の 3 起点）

## 収録スキル

| スキル | 呼び出し | 説明 |
|---|---|---|
| `pdca` | `/pdca:pdca` | PDCA ループ実行スキル。契約固定・思考オペレータ選択型（問題/動機/主張検証の 3 起点） |

## 使い方

```
/pdca:pdca <依頼内容>
```

詳細なフローは `skills/pdca/SKILL.md` を参照してください。

Do/Check の Workflow callsite は native Workflow を優先します。nativeが無いCodexでは
`workflow:dynamic-workflow-runner` を内部利用しますが、現行sourceが要求するworktree isolationとdynamic artifactは
runner v1で意味保存できないためexecution前にfail closedします。Claude Code は plugin dependency で
`research` / `workflow` を導入しますが、Codex では必要なpluginを一度ずつ installしてください。

## 構成

このプラグインの `skills/` 配下がスキルの実体です。
リポジトリ内の `.agents/skills/<name>` がここへの相対シンボリックリンクになっています。
