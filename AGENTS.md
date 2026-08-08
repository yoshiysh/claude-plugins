# AGENTS.md

This file provides guidance to Codex when working in this repository.

内容は `CLAUDE.md` と同じ設計を Codex 視点で述べたもの。齟齬があれば `CLAUDE.md` を正とする。

## リポジトリ概要

個人用の Claude/Codex skill と marketplace plugin を管理するリポジトリ。スキルは `.agents/skills/<name>` から参照する。Claude 用には `.claude/skills -> ../.agents/skills` の symlink が同じものを指している。

## 現在の実体

スキル実体の置き場は「公開済みかどうか」で決まる。

- **公開済み（plugin に属する）**: 実体は `plugins/<plugin>/skills/<name>/`。`.agents/skills/<name>` はそこへの相対 symlink（`../../plugins/<plugin>/skills/<name>`）。
- **未公開・未登録**: 実体は `.agents/skills/<name>/`（現状は `manage-marketplace-plugin` のみ）。
- Marketplace 定義: `.claude-plugin/marketplace.json`（Codex も legacy パスとして読む）
- Marketplace 名: `yoshiysh-claude-plugins`
- 公開用 plugin: `plugins/<name>/`

新規スキルは `.agents/skills/` に実体で作る。`manage-marketplace-plugin` で公開した瞬間に `register_plugin.py` が実体を `plugins/` へ移し、`.agents/skills/<name>` を逆向き symlink に置き換える。

### なぜ実体が plugins/ 側なのか

**配布サブツリー（`plugins/<plugin>/` 配下）に symlink を置いてはいけない。**

Codex は plugin サブツリーだけを取得し、symlink を落とす。実測では `~/.codex/plugins/cache/yoshiysh-claude-plugins/<plugin>/<version>/skills/` が空になり、`plugin.json` は読めているのにスキルが 1 つも入らなかった。Claude Code は同一 marketplace 内を指す symlink を dereference する仕様なので旧構成でも動いていたが、両方で動く形は「symlink を置かない」しかない。

### plugin 間でスキルは共有できない

実体は常に 1 箇所。複数 plugin での共有はコピーになり drift するため禁止（`register_plugin.py` が exit 4 で止める）。別 plugin のスキルが必要な場合は、

1. `.claude-plugin/plugin.json` の `dependencies` に宣言する（Claude Code は同時 install する。**Codex に同等機能は無いので、依存 plugin は手動で install する**）。
2. 呼び出しはスキル呼び出しで行う。相手のファイルをパス参照したりスクリプトを直接実行したりしない。
3. 呼び出し側が自分で実行する必要のある手順書だけ、自前の `references/` に持つ。

## Plugin マニフェスト

各 plugin は 2 つのマニフェストを持つ。

| パス | 用途 |
|---|---|
| `plugins/<p>/.claude-plugin/plugin.json` | Claude Code 用。`dependencies` はこちらだけに書く |
| `plugins/<p>/.codex-plugin/plugin.json` | Codex 用（[公式仕様](https://developers.openai.com/codex/plugins/build)で required）。Codex 仕様に無いフィールドは書かない |

`dependencies` を除く共通フィールドは一致していなければならず、`verify_install.py` の L2 がそれを検査する。

## ディレクトリ構成

```text
.agents/skills/
  manage-marketplace-plugin/                         # 未登録スキルはここが実体
  commit -> ../../plugins/git/skills/commit          # 公開済みは plugins/ への symlink
  ...
.claude/
  settings.json
  skills -> ../.agents/skills
.claude-plugin/
  marketplace.json
.codex/
  config.toml
  hooks.json
plugins/
  git/                     # 例。chat / research / notion / skill-creator も同構成
    .claude-plugin/plugin.json
    .codex-plugin/plugin.json
    README.md
    skills/commit/         # ← 実体
    skills/pr-create/
    skills/cleanup-branches/
```

## 作業ルール

- 編集は `.agents/skills/<name>/` から行う。
- 新規スキルは `.agents/skills/<name>/` に実体で作る。`plugins/` へ手で置かない。
- `plugins/` 配下に symlink を作らない。
- skill の `SKILL.md` は frontmatter の `name` と `description` を必ず持つ。
- 具体的な処理はできるだけ `scripts/` に寄せ、`SKILL.md` はフロー・分岐・完了条件を中心に保つ。
- plugin 登録時は `manage-marketplace-plugin` のスクリプトを使う。
- plugin author の既定値は `yoshiysh`。

## 検証

`Makefile` が入口。対象スキルは `.agents/skills/*/` から毎回導出する。

```bash
make test         # 合否ゲート: 参照先の実在チェック + 全スキルの quick_validate + 各スキルの tests/ の unittest
make portability  # 配布 portability の一覧（合否ゲートではない）
make check        # 上記 2 つをまとめて
```

個別に見るとき:

```bash
python3 .agents/skills/skill-creator-best-practices/scripts/quick_validate.py .agents/skills/<name> --verbose
python3 .agents/skills/manage-marketplace-plugin/scripts/check_portability.py --skill <name>
python3 .agents/skills/manage-marketplace-plugin/scripts/check_references.py --skill <name>
python3 .agents/skills/manage-marketplace-plugin/scripts/verify_install.py --plugin <plugin-name>
```

`make test` は `.codex/hooks.json` の PostToolUse hook（matcher `Edit|Write|MultiEdit`）からも呼ばれる。

## インストール

```bash
/plugin install <plugin-name>@yoshiysh-claude-plugins
```

`notion` plugin は `url-reader` スキルを使うため、Codex では `research` plugin も併せて install する（Claude Code は `dependencies` により自動で入る）。

## 注意点

- `.claude/skills` は symlink なので、Git 上では実ファイル削除と symlink 追加が見えることがある。
- `.claude-plugin/marketplace.json` の `name` を変えると `/plugin install <plugin>@<marketplace>` の marketplace 名も変わる。

## 言語

ユーザーへの返答は日本語で行う。
