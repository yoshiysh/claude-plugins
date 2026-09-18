# pr-review

汎用的な対象レビューを複数観点で実施し、根拠付き inline comment と summary を返すスキル。

## 収録スキル

| スキル | 呼び出し | 説明 |
|---|---|---|
| `pr-review` | `/pr-review:pr-review` | 汎用的な対象レビューを複数観点で実施し、根拠付き inline comment と summary を返すスキル。 |

## 使い方

```
/pr-review:pr-review <依頼内容>
```

詳細なフローは `skills/pr-review/SKILL.md` を参照してください。

## 構成

このプラグインの `skills/` 配下がスキルの実体です。
リポジトリ内の `.agents/skills/<name>` がここへの相対シンボリックリンクになっています。
