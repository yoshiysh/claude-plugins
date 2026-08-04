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

`plugins/<plugin>/skills/<スキル実体ディレクトリ名>` は、必ず `../../../.claude/skills/<同名>` への相対 symlink にする。絶対 symlink やスキル本体のコピーは作らない。symlink 名は実体ディレクトリ名に揃える（公開名は frontmatter の `name` が担う。install 先のキャッシュは symlink 名でディレクトリが作られるため、`../<兄弟スキル>/` 参照を壊さないように実体名を保つ）。

## 収録スキル

実体はすべて `.agents/skills/<ディレクトリ>`。plugin はカテゴリ単位（`git` / `chat` / `research` / `notion` / `skill-creator`）でまとめ、呼び出し名は `plugin:skill` になる。スキルの公開名（frontmatter の `name`）がディレクトリ名と異なる場合があり、その対応は「公開名」列に示す。

| ディレクトリ | 公開名（呼び出し） | 用途 | plugin |
|---|---|---|---|
| `chat` | `chat:fable` | Fable 5 を壁打ち相手に技術相談し、整形して relay する | `chat` |
| `chat-rigorous` | `chat:rigorous` | 反証耐性の高い分析ワークフローを instructions で強制する壁打ち | `chat` |
| `cleanup-branches` | `git:cleanup-branches` | マージ済みブランチと作業状態を掃除し worktree を主ブランチに同期する | `git` |
| `commit` | `git:commit` | staged 変更から Conventional Commits メッセージを生成しコミットする | `git` |
| `dispatch` | `research:dispatch` | Fable 5 が計画・評価し、Workflow スクリプトが subagent を反復実行する | `research` |
| `manage-marketplace-plugin` | —（未登録） | 既存スキルを marketplace plugin として登録・更新・検証する | 未登録 |
| `notion-organize-knowledge` | `notion:organize-knowledge` | Notion の capture queue を根拠付きで整理し検証付きで書き込む | `notion` |
| `pr-create` | `git:pr-create` | diff を解析して PR タイトル・本文を生成し draft PR を作る | `git` |
| `reference` | `research:reference` | 技術的な回答で推測と確認済み情報を区別させる（`user-invocable: false`） | `research` |
| `search` | `research:search` | 一次情報検証つき調査。全事実主張を三値判定してから回答を組む | `research` |
| `skill-creator-best-practices` | `skill-creator:best-practices` | マルチエージェントでスキルを設計・作成・評価する | `skill-creator` |
| `url-reader` | `research:url-reader` | ドメイン別 reader backend で URL を安定 Markdown 化する | `research` |

frontmatter の `name` はディレクトリ名より優先される（plugin スキルの公式仕様）。ディレクトリ名 ≠ 公開名のスキルは `chat`（→`fable`）、`chat-rigorous`（→`rigorous`）、`notion-organize-knowledge`（→`organize-knowledge`）、`skill-creator-best-practices`（→`best-practices`）の 4 つ。

Marketplace に登録された plugin は次の形でインストールできる。

```bash
/plugin install <plugin-name>@yoshiysh-claude-plugins
```

plugin の改名・削除で残骸になった旧 plugin は `tools/update-plugins` がカタログ照合で検出して uninstall する（新 plugin の install は手動）。

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
  git/                     # 例。chat / research / notion / skill-creator も同構成
    .claude-plugin/plugin.json
    README.md
    skills/commit -> ../../../.claude/skills/commit
    skills/pr-create -> ../../../.claude/skills/pr-create
    skills/cleanup-branches -> ../../../.claude/skills/cleanup-branches
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
make test         # 合否ゲート: 全スキルの quick_validate + 各スキルの tests/ の unittest
make portability  # 配布 portability の一覧（install 先で壊れる参照の検出）
make check        # 上記 2 つをまとめて
```

`make portability` を合否ゲートにしていないのは、`check_portability.py` が blocker を検出しても exit 0 を返すことと、既知の false positive が 2 件（`manage-marketplace-plugin` の自己参照 `external_script`、`cleanup-branches` の設定例中の `env_build`）あるため。詳細は `skills-audit.md` §4.1b。

個別スキルだけを見るとき:

```bash
python3 .claude/skills/skill-creator-best-practices/scripts/quick_validate.py .agents/skills/<name> --verbose
python3 .claude/skills/manage-marketplace-plugin/scripts/check_portability.py --skill <name>
```

Marketplace 登録後の install 検証:

```bash
python3 .claude/skills/manage-marketplace-plugin/scripts/verify_install.py --plugin <plugin-name>
```

`make test` は `.codex/hooks.json` の PostToolUse hook（matcher `Edit|Write|MultiEdit`）からも呼ばれる。`.claude/settings.json` 側には検証 hook は無く、通知系（Notification / Stop）のみ。

`quick_validate.py` が通っても全項目の合格ではない。検証者の有無・description の実発火など機械判定できない項目は `SKIP:` として毎回申告されるので、公開前にはそこを設計レビューで見る。

## 注意点

- `.claude/skills` は symlink なので、Git 上では旧 `.claude/skills/...` 実ファイル削除と symlink 追加が見えることがある。
- `.claude-plugin/marketplace.json` の `name` を変えると `/plugin install <plugin>@<marketplace>` の marketplace 名も変わる。

## 言語

ユーザーへの返答は日本語で行う。
