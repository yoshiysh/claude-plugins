# worktree-sync

Worktree を最新の main に同期し、マージ済みブランチと不要な作業状態を掃除する。 「main を更新」「最新にして」「sync」「同期」「マージしたから更新」「main を取得」 「ブランチを更新」「ブランチを整理」「掃除して」等のキーワードで起動する。 ローカル・remote 双方のマージ済みブランチ、stash の滞留、submodule の drift、 終了済み workspace までを 1 回の実行で洗い出す。

## 含まれるスキル

| スキル | 説明 |
|---|---|
| `worktree-sync` | Worktree を最新の main に同期し、マージ済みブランチと不要な作業状態を掃除する。 「main を更新」「最新にして」「sync」「同期」「マージしたから更新」「main を取得」 「ブランチを更新」「ブランチを整理」「掃除して」等のキーワードで起動する。 ローカル・remote 双方のマージ済みブランチ、stash の滞留、submodule の drift、 終了済み workspace までを 1 回の実行で洗い出す。 |

## 使い方

プラグインを有効化したうえで、スキルを呼び出します。

```
/worktree-sync <依頼内容>
```

詳細なフローは `skills/worktree-sync/SKILL.md` を参照してください。

## 構成について

このプラグインの `skills/worktree-sync` は、リポジトリ本体の
`.claude/skills/worktree-sync` への相対シンボリックリンクです。
スキルの実体は `.claude/skills/` を唯一の正とし、公開時はリンク経由で参照します。
