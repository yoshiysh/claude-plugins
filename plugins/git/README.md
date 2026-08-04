# git

Git ワークフローを支援するプラグイン。

## 収録スキル

| スキル | 呼び出し | 説明 |
|---|---|---|
| `commit` | `/git:commit` | staged 変更を解析し Conventional Commits メッセージを生成してコミットする |
| `pr-create` | `/git:pr-create` | diff を解析して PR タイトル・本文を生成し draft PR を作る |
| `cleanup-branches` | `/git:cleanup-branches` | マージ済みブランチと不要な作業状態を掃除し worktree を主ブランチに同期する |

## 使い方

```
/git:commit
/git:pr-create
/git:cleanup-branches
```

詳細なフローは `skills/<name>/SKILL.md` を参照してください。

## 構成

このプラグインの `skills/` 配下は、リポジトリ本体の
`.claude/skills/` への相対シンボリックリンクです。
