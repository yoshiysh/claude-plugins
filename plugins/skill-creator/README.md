# skill-creator

マルチエージェントで高品質なスキルを設計・作成・評価するプラグイン。

## 収録スキル

| スキル | 呼び出し | 説明 |
|---|---|---|
| `best-practices` | `/skill-creator:best-practices` | 要件整理・検証基準生成・構成設計・執筆・テスト・検証を専門 Sub-agent に分担させてスキルを生成する |

## 使い方

```
/skill-creator:best-practices <作りたいスキルの説明>
```

詳細なフローは `skills/skill-creator-best-practices/SKILL.md` を参照してください。

## 構成

このプラグインの `skills/` 配下は、リポジトリ本体の
`.claude/skills/` への相対シンボリックリンクです。スキル実体はディレクトリ名
（`skill-creator-best-practices`）のまま、frontmatter の `name`（`best-practices`）で公開されます。
