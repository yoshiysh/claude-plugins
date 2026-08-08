# research

一次情報検証つきの調査ツールを提供するプラグイン。

## 収録スキル

| スキル | 呼び出し | 説明 |
|---|---|---|
| `search` | `/research:search` | 一次情報検証つき調査。全事実主張を三値判定してから回答を組む |
| `reference` | `/research:reference` | 技術的な回答で推測と確認済み情報を区別させる（`user-invocable: false`） |
| `url-reader` | `/research:url-reader` | ドメイン別 reader backend で URL を安定 Markdown 化する |
| `dispatch` | `/research:dispatch` | Fable 5 が計画・評価し、subagent を複数ラウンド反復実行して難問を解く |

## 使い方

```
/research:search <調査したいこと>
/research:dispatch <深掘りしたい難問>
```

詳細なフローは `skills/<name>/SKILL.md` を参照してください。

## 構成

このプラグインの `skills/` 配下がスキルの実体です。
リポジトリ内の `.agents/skills/<name>` がここへの相対シンボリックリンクになっています。
