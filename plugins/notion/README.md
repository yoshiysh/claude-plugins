# notion

Notion の知識整理を支援するプラグイン。

## 収録スキル

| スキル | 呼び出し | 説明 |
|---|---|---|
| `organize-knowledge` | `/notion:organize-knowledge` | Notion の capture queue を根拠付きで整理し検証付きで書き込む |

## 使い方

```
/notion:organize-knowledge
```

詳細なフローは `skills/notion-organize-knowledge/SKILL.md` を参照してください。

## 構成

このプラグインの `skills/` 配下がスキルの実体です。
リポジトリ内の `.agents/skills/<name>` がここへの相対シンボリックリンクになっています。スキル実体はディレクトリ名
（`notion-organize-knowledge`）のまま、frontmatter の `name`（`organize-knowledge`）で公開されます。
