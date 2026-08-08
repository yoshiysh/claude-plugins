# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## リポジトリ概要

個人用の Claude/Codex skill と marketplace plugin を管理するリポジトリ。スキルは `.agents/skills/<name>` から参照し、Claude 用には `.claude/skills` symlink 経由で同じものを見る。

## 現在の実体

スキル実体の置き場は「公開済みかどうか」で決まる。

- **公開済み（plugin に属する）**: 実体は `plugins/<plugin>/skills/<name>/`。`.agents/skills/<name>` はそこへの相対 symlink（`../../plugins/<plugin>/skills/<name>`）。
- **未公開・未登録**: 実体は `.agents/skills/<name>/`（現状は `manage-marketplace-plugin` のみ）。
- Claude からの参照: `.claude/skills -> ../.agents/skills`
- Marketplace 定義: `.claude-plugin/marketplace.json`
- Marketplace 名: `yoshiysh-claude-plugins`
- 公開用 plugin: `plugins/<name>/`

新規スキルは従来どおり `.agents/skills/` に実体で作る。`manage-marketplace-plugin` で公開した瞬間に、`register_plugin.py` が実体を `plugins/` 側へ移し、`.agents/skills/<name>` を逆向き symlink に置き換える。

### なぜ実体が plugins/ 側なのか（symlink ではない理由）

**配布サブツリー（`plugins/<plugin>/` 配下）に symlink を置いてはいけない。**

- Claude Code は plugin dir をキャッシュへコピーする際、同一 marketplace 内を指す symlink を dereference する（[公式仕様](https://code.claude.com/docs/en/plugins-reference) "Share files within a marketplace with symlinks"）。以前の `plugins/<plugin>/skills/<name> -> ../../../.claude/skills/<name>` はこの仕様に沿った正しい構成だった。
- しかし Codex は plugin サブツリーだけを取得し、symlink を落とす。実測では `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/skills/` が空になり、`plugin.json` は読めているのにスキルが 1 つも入らなかった。
- 両方で動く構成は「配布サブツリーに symlink を置かない」形しかないため、実体を `plugins/` 側に置き、リポジトリ内の開発用参照を symlink にする向きに反転した。

つまりこれは設計ミスの修正ではなく、Codex 互換のための譲歩である。

ディレクトリ名は実体名に揃える（公開名は frontmatter の `name` が担う。install 先のキャッシュはこのディレクトリ名で作られるため、`../<兄弟スキル>/` 参照を壊さないように名前を保つ）。

### plugin 間でスキルは共有できない

実体は常に 1 箇所。symlink が使えない以上、複数 plugin での共有はコピーになり drift するため禁止する（`register_plugin.py` が exit 4 で止める）。別 plugin のスキルが必要な場合は:

1. `.claude-plugin/plugin.json` の `dependencies` にその plugin を宣言する（Claude Code が同時 install する。Codex に同等機能は無いので手動 install 前提）。
2. 呼び出しは**スキル呼び出し**で行う。相手のファイルをパス参照したりスクリプトを直接実行したりしない（install 先では別ディレクトリに展開されるため解決しない）。
3. 呼び出し側の agent が自分で実行する必要がある手順書だけは、自前の `references/` に持つ。

実例: `notion-organize-knowledge` は `url-reader` を `research:url-reader` として呼び出し、`dependencies: ["research"]` を宣言し、caller 実行が必須な in-app Browser fallback protocol だけ自前の `references/in-app-browser-fallback.md` に持っている。

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
  manage-marketplace-plugin/          # 未登録スキルはここが実体
  commit -> ../../plugins/git/skills/commit          # 公開済みは plugins/ への symlink
  ...                                                # 他 10 スキルも同様
.claude/
  settings.json
  skills -> ../.agents/skills
.claude-plugin/
  marketplace.json
plugins/
  git/                     # 例。chat / research / notion / skill-creator も同構成
    .claude-plugin/plugin.json         # Claude 用（dependencies はこちらだけ）
    .codex-plugin/plugin.json          # Codex 用（共通フィールドのみ）
    README.md
    skills/commit/                     # ← 実体
    skills/pr-create/
    skills/cleanup-branches/
```

## 作業ルール

- 編集は `.agents/skills/<name>/` から行う（公開済みスキルは symlink 越しに `plugins/` の実体を触ることになる）。`.claude/skills/` は symlink なので直接実体を増やさない。
- 新規スキルは `.agents/skills/<name>/` に実体で作る。`plugins/` へ手で置かない（移動は `register_plugin.py` の仕事）。
- `plugins/` 配下に symlink を作らない。
- skill の `SKILL.md` は frontmatter の `name` と `description` を必ず持つ。
- 具体的な処理はできるだけ `scripts/` に寄せ、`SKILL.md` はフロー・分岐・完了条件を中心に保つ。
- plugin 登録時は `manage-marketplace-plugin` のスクリプトを使う。
- plugin author の既定値は `yoshiysh`。

## 検証

`Makefile` が入口。対象スキルは `.agents/skills/*/` から毎回導出するので、スキルを追加しても検証対象に入れ忘れることはない。

```bash
make test         # 合否ゲート: 参照先の実在チェック + 全スキルの quick_validate + 各スキルの tests/ の unittest
make portability  # 配布 portability の一覧（install 先で壊れる「書き方」の検出）
make check        # 上記 2 つをまとめて
```

`make test` は `check_references.py`（参照先の実在チェック）を含む。これは合否ゲートで、全スキルで 0 件になることを確認済み。`[SKILL_DIR]/...`・markdown リンク・リポジトリ絶対パス参照を見て、存在しない参照先があれば exit 1 で落とす。プレースホルダ（`<f>` / `...` / `${}`）は除外しているため誤検知は出ない。

`make portability` を合否ゲートにしていないのは、`check_portability.py` が blocker を検出しても exit 0 を返すことと、既知の false positive が 2 件（`manage-marketplace-plugin` の自己参照 `external_script`、`cleanup-branches` の設定例中の `env_build`）あるため。詳細は `skills-audit.md` §4.1b。

個別スキルだけを見るとき:

```bash
python3 .claude/skills/skill-creator-best-practices/scripts/quick_validate.py .agents/skills/<name> --verbose
python3 .claude/skills/manage-marketplace-plugin/scripts/check_portability.py --skill <name>
python3 .claude/skills/manage-marketplace-plugin/scripts/check_references.py --skill <name>
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
- `plugin.json` は `.claude-plugin/` と `.codex-plugin/` の 2 箇所にある。Codex の公式仕様は `.codex-plugin/plugin.json` を required としており、`.claude-plugin` が読めているのは undocumented な legacy 互換に乗っているだけなので、両方を維持する。内容は `dependencies` を除いて同一で、`verify_install.py` の L2 が一致を検査する。
- Codex が `plugin.json` の未知フィールドを許容するかは未確認。Codex 仕様に無いフィールド（現状 `dependencies`）は `.codex-plugin/` 側に書かない。
- **`.agents/skills/` を `find` で走査するときは `-L` を付ける。** 公開済みスキルは symlink なので、`find` は既定で中へ降りず、結果が静かに 0 件になる（`find -L .agents/skills -name '*.js'` のように書く）。同じ理由で `grep -r` も `-r` ではなく実体側（`plugins/`）か `-L` 相当の指定を使う。`make` の `$(wildcard .agents/skills/*/)` と Python の `Path.rglob` は symlink を辿るので影響を受けない（実測確認済み）。
- `search` / `dispatch` / `skill-creator-best-practices` は Claude Code の dynamic workflows に依存するため **Codex では動作しない**。install 自体は成功するので、実行時まで気づけない。新たに Workflow を使うスキルを作る場合は SKILL.md に同じ注記を入れる。

## 言語

ユーザーへの返答は日本語で行う。
