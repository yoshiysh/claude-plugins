# skill-creator

マルチエージェントでスキルを設計・作成し、既存スキルの評価と更新も同じ枠組みで行うプラグイン。

## 収録スキル

| スキル | 呼び出し | 説明 |
|---|---|---|
| `best-practices` | `/skill-creator:best-practices` | create: 要件整理・基準生成・構成設計・執筆・テスト・検証を Sub-agent に分担して生成 / review: 観点別指摘 → 独立反証で生き残った指摘だけを返す / update: staging へ改稿 → 再検証 → 承認後に反映 |

## 使い方

```
/skill-creator:best-practices <作りたいスキルの説明>
/skill-creator:best-practices このスキルを best-practices に沿ってるか評価して  # review
/skill-creator:best-practices Issue #NN に沿ってこのスキルを更新して           # update
```

詳細なフローは `skills/skill-creator-best-practices/SKILL.md` を参照してください。

create / review / update の Workflow callsite は native Workflow を優先し、それが無い Codex では
`workflow:dynamic-workflow-runner` を内部利用します。runner v1の対象はcreateだけです。live target treeを読むreviewと
dynamic staging writeを持つupdateは意味保存できないためexecution前にfail closedします。Claude Code は plugin dependency で
`workflow` も導入しますが、Codex では `skill-creator` と `workflow` を一度ずつ install してください。

## 構成

このプラグインの `skills/` 配下がスキルの実体です。
リポジトリ内の `.agents/skills/<name>` がここへの相対シンボリックリンクになっています。スキル実体はディレクトリ名
（`skill-creator-best-practices`）のまま、frontmatter の `name`（`best-practices`）で公開されます。
