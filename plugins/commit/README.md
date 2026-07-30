# commit

Generate intelligent commit messages and execute commits.

## 含まれるスキル

| スキル | 説明 |
|---|---|
| `commit` | Generate intelligent commit messages and execute commits. |

## 使い方

プラグインを有効化したうえで、スキルを呼び出します。

```
/commit <依頼内容>
```

詳細なフローは `skills/commit/SKILL.md` を参照してください。

## 構成について

このプラグインの `skills/commit` は、リポジトリ本体の
`.claude/skills/commit` への相対シンボリックリンクです。
スキルの実体は `.claude/skills/` を唯一の正とし、公開時はリンク経由で参照します。
