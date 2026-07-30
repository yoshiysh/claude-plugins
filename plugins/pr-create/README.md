# pr-create

Automate intelligent Pull Request creation (Diff analysis, Template filling, Draft mode).

## 含まれるスキル

| スキル | 説明 |
|---|---|
| `pr-create` | Automate intelligent Pull Request creation (Diff analysis, Template filling, Draft mode). |

## 使い方

プラグインを有効化したうえで、スキルを呼び出します。

```
/pr-create <依頼内容>
```

詳細なフローは `skills/pr-create/SKILL.md` を参照してください。

## 構成について

このプラグインの `skills/pr-create` は、リポジトリ本体の
`.claude/skills/pr-create` への相対シンボリックリンクです。
スキルの実体は `.claude/skills/` を唯一の正とし、公開時はリンク経由で参照します。
