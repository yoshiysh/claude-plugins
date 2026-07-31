# cleanup-branches

マージ済みブランチと不要な作業状態を検出・削除し、worktree を最新の主ブランチに同期する。 「ブランチを整理して」「不要なブランチを消したい」「マージ済みブランチをクリーンアップして」 「main を更新」「最新にして」「sync」「同期」「マージしたから更新」「ブランチを更新」 「掃除して」等のキーワードで起動する。 ローカル・remote 双方のマージ済みブランチ（squash merge・cherry-pick・rebase で 取り込まれたものを含む）、stash の滞留、submodule の drift、終了済み workspace までを 1 回の実行で洗い出す。判定基準は main / develop / release-*/dev-* を動的に列挙するため、 develop が主軸で dev/{version} のような並走ブランチを持つリポジトリでも正しく判定する。

## 含まれるスキル

| スキル | 説明 |
|---|---|
| `cleanup-branches` | マージ済みブランチと不要な作業状態を検出・削除し、worktree を最新の主ブランチに同期する。 「ブランチを整理して」「不要なブランチを消したい」「マージ済みブランチをクリーンアップして」 「main を更新」「最新にして」「sync」「同期」「マージしたから更新」「ブランチを更新」 「掃除して」等のキーワードで起動する。 ローカル・remote 双方のマージ済みブランチ（squash merge・cherry-pick・rebase で 取り込まれたものを含む）、stash の滞留、submodule の drift、終了済み workspace までを 1 回の実行で洗い出す。判定基準は main / develop / release-*/dev-* を動的に列挙するため、 develop が主軸で dev/{version} のような並走ブランチを持つリポジトリでも正しく判定する。 |

## 使い方

プラグインを有効化したうえで、スキルを呼び出します。

```
/cleanup-branches <依頼内容>
```

詳細なフローは `skills/cleanup-branches/SKILL.md` を参照してください。

## 構成について

このプラグインの `skills/cleanup-branches` は、リポジトリ本体の
`.claude/skills/cleanup-branches` への相対シンボリックリンクです。
スキルの実体は `.claude/skills/` を唯一の正とし、公開時はリンク経由で参照します。

## worktree-sync からの変更点

`worktree-sync`（main 固定）と自作の `cleanup-branches`（main/develop/release-*/dev-* を
動的列挙 + 退避タグ）を統合し、`cleanup-branches` の名前に一本化した。取り込まれたブランチの
検出は `worktree-sync` の 3 経路判定（ancestor / PR merged / patch-id）を踏襲しつつ、
比較対象を単一の main から動的な複数 primary ref に拡張している。
