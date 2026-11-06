# AGENTS.md

Claude Code と Codex がこのリポジトリで作業するときの入口。
ユーザーへの返答は日本語で行う。

## リポジトリ概要

Claude/Codex向けの汎用スキルをmarketplace pluginとして管理・配布する。
Marketplaceの定義は `.claude-plugin/marketplace.json`、利用者向けの入口は [README.md](README.md)。

## 現在の実体

配置と配布の規則は [リポジトリの運用](docs/guidelines/repository-operations.md#配置と配布) を読む。
公開済みスキルは `plugins/<plugin>/skills/<name>/` が実体、`.agents/skills/<name>` が相対symlink。
未公開スキルは `.agents/skills/<name>/` が実体。`.claude/skills` は `.agents/skills` への参照。
公開・登録・plugin間の利用を変える前に、同文書の配置と依存の契約を確認する。

## 収録スキル

一覧を書き写さず、marketplace定義、各pluginの `README.md` と `skills/`、`.agents/skills/` から導出する。
公開名は各 `SKILL.md` frontmatter の `name` で確認する。

## 作業ルール

変更の前に次の表から必要な正本の節を読み、目的に適用する。毎回全ファイルの通読を要求しない。

| 正本 | 読む目的 |
|---|---|
| [エージェントの作業](docs/guidelines/agent-work.md) | 目的・合格基準・範囲の固定、設計と独立検証、役割、反復の終了、最小成果 |
| [リポジトリの運用](docs/guidelines/repository-operations.md) | 編集・登録・配布、実行環境、検証の手順と制約 |
| [共通ガイドライン](docs/guidelines/README.md) | コード・テスト・文書の基準と検査 |

必要な詳細へ辿れるよう、このファイルは地図に保つ。規則の追加は正本の既存箇所を更新する。
スキル設計の正本は [best-practices](plugins/skill-creator/skills/skill-creator-best-practices/references/best-practices.md)。

## 検証

[Makefile](Makefile) が入口。コマンドの意味・個別検証・限界は [運用の検証](docs/guidelines/repository-operations.md#検証) を読む。

```bash
make test
make portability
make check
```

レビューは [REVIEW.md](REVIEW.md) が入口。機械的な検査の成功と意味の合格を区別する。

## インストール

利用者の手順は [README.md](README.md)、依存とWorkflowの条件は [実行と環境](docs/guidelines/repository-operations.md#実行と環境) を読む。

## 注意点

配布のmanifest、symlink走査、runtimeの拒否条件、opt-inは [リポジトリの運用](docs/guidelines/repository-operations.md) にまとめている。
規約を運ぶツールはこのリンクの自動追跡を仮定せず、REVIEW.md等の読む文書の集合へ正本を直接含める。

## Claude Code 固有

pluginの依存解決とinstallは [実行と環境](docs/guidelines/repository-operations.md#実行と環境) を読む。

## Codex 固有

marketplace登録・依存の手動導入・Worktree setup・hookは [実行と環境](docs/guidelines/repository-operations.md#実行と環境) を読む。
