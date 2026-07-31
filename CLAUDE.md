# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## リポジトリ概要

個人用の Claude/Codex skill と marketplace plugin を管理するリポジトリ。スキル本体を `.agents/skills/` に置き、Claude 用には `.claude/skills` symlink 経由で同じ実体を参照する。

## 現在の実体

- スキル実体: `.agents/skills/<name>/`
- Claude からの参照: `.claude/skills -> ../.agents/skills`
- Marketplace 定義: `.claude-plugin/marketplace.json`
- Marketplace 名: `yoshiysh-claude-plugins`
- 公開用 plugin: `plugins/<name>/`

`plugins/<name>/skills/<name>` は、必ず `../../../.claude/skills/<name>` への相対 symlink にする。絶対 symlink やスキル本体のコピーは作らない。

## 収録スキル

実体はすべて `.agents/skills/<name>`。「plugin」列は `.claude-plugin/marketplace.json` への登録状況。

| スキル | 用途 | plugin |
|---|---|---|
| `chat` | Fable 5 を壁打ち相手に技術相談し、整形して relay する | `chat` |
| `chat-rigorous` | 反証耐性の高い分析ワークフローを instructions で強制する壁打ち | `chat`（同梱） |
| `commit` | staged 変更から Conventional Commits メッセージを生成しコミットする | `commit` |
| `dispatch` | Fable 5 が計画・評価し、Workflow スクリプトが subagent を反復実行する | `dispatch` |
| `manage-marketplace-plugin` | 既存スキルを marketplace plugin として登録・更新・検証する | 未登録 |
| `notion-organize-knowledge` | Notion の capture queue を根拠付きで整理し検証付きで書き込む | 未登録 |
| `pr-create` | diff を解析して PR タイトル・本文を生成し draft PR を作る | `pr-create` |
| `reference` | 技術的な回答で推測と確認済み情報を区別させる（`user-invocable: false`） | `reference` |
| `search` | 一次情報検証つき調査。全事実主張を三値判定してから回答を組む | `search` |
| `skill-creator-best-practices` | マルチエージェントでスキルを設計・作成・評価する | `skill-creator-best-practices` |
| `url-reader` | ドメイン別 reader backend で URL を安定 Markdown 化する | 未登録 |
| `worktree-sync` | worktree を main に同期し、マージ済みブランチと作業状態を掃除する | `worktree-sync` |

Marketplace に登録された plugin は次の形でインストールできる。

```bash
/plugin install <plugin-name>@yoshiysh-claude-plugins
```

## ディレクトリ構成

```text
.agents/skills/
  <skill-name>/            # 全 12 スキルの実体（上表参照）
.claude/
  settings.json
  skills -> ../.agents/skills
.claude-plugin/
  marketplace.json
plugins/
  skill-creator-best-practices/
    .claude-plugin/plugin.json
    README.md
    skills/skill-creator-best-practices -> ../../../.claude/skills/skill-creator-best-practices
```

## 作業ルール

- `.agents/skills/` 側を編集する。`.claude/skills/` は symlink なので直接実体を増やさない。
- skill の `SKILL.md` は frontmatter の `name` と `description` を必ず持つ。
- 具体的な処理はできるだけ `scripts/` に寄せ、`SKILL.md` はフロー・分岐・完了条件を中心に保つ。
- plugin 登録時は `manage-marketplace-plugin` のスクリプトを使う。
- plugin author の既定値は `yoshiysh`。

## 検証

`Makefile` が入口。対象スキルは `.agents/skills/*/` から毎回導出するので、スキルを追加しても検証対象に入れ忘れることはない。

```bash
make test         # 合否ゲート: 全スキルの quick_validate + worktree-sync / url-reader の unittest
make portability  # 配布 portability の一覧（install 先で壊れる参照の検出）
make check        # 上記 2 つをまとめて
```

`make portability` を合否ゲートにしていないのは、`check_portability.py` が blocker を検出しても exit 0 を返すことと、既知の false positive が 2 件（`manage-marketplace-plugin` の自己参照 `external_script`、`worktree-sync` の設定例中の `env_build`）あるため。詳細は `skills-audit.md` §4.1b。

個別スキルだけを見るとき:

```bash
python3 .claude/skills/skill-creator-best-practices/scripts/quick_validate.py .agents/skills/<name> --verbose
python3 .claude/skills/manage-marketplace-plugin/scripts/check_portability.py --skill <name>
```

Marketplace 登録後の install 検証:

```bash
python3 .claude/skills/manage-marketplace-plugin/scripts/verify_install.py --skill <name>
```

`make test` は `.codex/hooks.json` の PostToolUse hook（matcher `Edit|Write|MultiEdit`）からも呼ばれる。`.claude/settings.json` 側には検証 hook は無く、通知系（Notification / Stop）のみ。

`quick_validate.py` が通っても全項目の合格ではない。検証者の有無・description の実発火など機械判定できない項目は `SKIP:` として毎回申告されるので、公開前にはそこを設計レビューで見る。

## 注意点

- `.claude/skills` は symlink なので、Git 上では旧 `.claude/skills/...` 実ファイル削除と symlink 追加が見えることがある。
- `.claude-plugin/marketplace.json` の `name` を変えると `/plugin install <plugin>@<marketplace>` の marketplace 名も変わる。

## 言語

ユーザーへの返答は日本語で行う。
