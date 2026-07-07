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

| スキル | 実体 | 用途 |
|---|---|---|
| `skill-creator-multi-agent` | `.agents/skills/skill-creator-multi-agent` | マルチエージェントでスキルを設計・作成・評価する |
| `manage-marketplace-plugin` | `.agents/skills/manage-marketplace-plugin` | 既存スキルを marketplace plugin として登録・更新・検証する |

Marketplace に登録された plugin は次の形でインストールできる。

```bash
/plugin install <plugin-name>@yoshiysh-claude-plugins
```

## ディレクトリ構成

```text
.agents/skills/
  skill-creator-multi-agent/
  manage-marketplace-plugin/
.claude/
  settings.json
  skills -> ../.agents/skills
.claude-plugin/
  marketplace.json
plugins/
  skill-creator-multi-agent/
    .claude-plugin/plugin.json
    README.md
    skills/skill-creator-multi-agent -> ../../../.claude/skills/skill-creator-multi-agent
```

## 作業ルール

- `.agents/skills/` 側を編集する。`.claude/skills/` は symlink なので直接実体を増やさない。
- skill の `SKILL.md` は frontmatter の `name` と `description` を必ず持つ。
- 具体的な処理はできるだけ `scripts/` に寄せ、`SKILL.md` はフロー・分岐・完了条件を中心に保つ。
- plugin 登録時は `manage-marketplace-plugin` のスクリプトを使う。
- plugin author の既定値は `yoshiysh`。

## 検証

基本検証:

```bash
python3 .claude/skills/skill-creator-multi-agent/scripts/quick_validate.py .claude/skills/skill-creator-multi-agent --verbose
python3 .claude/skills/skill-creator-multi-agent/scripts/quick_validate.py .claude/skills/manage-marketplace-plugin --verbose
```

Marketplace 登録後の install 検証:

```bash
python3 .claude/skills/manage-marketplace-plugin/scripts/verify_install.py --skill skill-creator-multi-agent
```

`.claude/settings.json` と `.codex/hooks.json` には `make test` hook があるが、このリポジトリには現在 `Makefile` がない。hook を有効運用するなら `Makefile` を追加するか、hook コマンドを上記の検証コマンドに更新する。

## 注意点

- `.claude/skills` は symlink なので、Git 上では旧 `.claude/skills/...` 実ファイル削除と symlink 追加が見えることがある。
- `.claude-plugin/marketplace.json` の `name` を変えると `/plugin install <plugin>@<marketplace>` の marketplace 名も変わる。

## 言語

ユーザーへの返答は日本語で行う。
