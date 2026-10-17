# claude-plugins

Claude Code / Codex 向けの汎用スキル集。marketplace plugin として配布する。

## Plugins

| plugin | 内容 |
|---|---|
| `git` | commit メッセージ生成・PR 作成・ブランチ掃除 |
| `research` | 一次情報検証つき調査（search）・多角深掘り（dispatch）・URL 読み取り（url-reader） |
| `notion` | Notion の capture queue を根拠付きで整理・登録 |
| `skill-creator` | マルチエージェントでスキルを作成・評価・更新 |
| `workflow` | 要求文書/仕様書の作成（prd-spec）・文書レビュー（review-document）・PR 等の多観点レビューと指摘修正（pr-review / pr-review-fix）・Codex 向け Workflow 互換層 |
| `performance` | エージェント作業のトークン使用量の opt-in 計測と、品質を維持した改善候補の提示 |
| `claim-gate` | 不在・網羅型の断定に裏付けか手段スコープが無ければ排出前に差し戻す Stop hook（opt-in・既定 off） |
| `shunt` | 大きなファイルの読み込みとボイラープレート生成を Gemini worker へ委譲してトークンを節約する（`CLAUDE_PLUGINS_GEMINI_API_KEY` が必要） |

各 plugin の詳細は `plugins/<plugin>/README.md`。

## インストール

```bash
claude plugin marketplace add https://github.com/yoshiysh/claude-plugins.git
claude plugin install <plugin>@yoshiysh-claude-plugins
```

Claude Code のセッション内なら `/plugin install <plugin>@yoshiysh-claude-plugins`。

## License

[MIT](LICENSE)

## 開発

構成・作業ルール・検証は [AGENTS.md](AGENTS.md) を参照（`CLAUDE.md` はその symlink で、Claude Code と Codex は同じ内容を読む）。検証の入口は `make check`。

## self-hosted runner

GitHub Actions の self-hosted runner は `tools/` の 2 本で扱う。引数の詳細は各コマンドの `--help`。

| やりたいこと | コマンド |
|---|---|
| runner を設置して登録し、サービスとして常駐化する | `tools/provision-gh-runner --repo owner/repo --target wsl:HOST` |
| 同じリポジトリに 2 台目以降を足す | 上に `--dir actions-runner-2` のように設置先を付ける |
| 状態を見る | `tools/gh-runner-ctl --target wsl:HOST status` |
| 止まった runner を上げ直す | `tools/gh-runner-ctl --target wsl:HOST start` |
| 登録を解除する | `tools/provision-gh-runner --repo owner/repo --target wsl:HOST --remove` |

`provision-gh-runner` は何度実行してもよい。終了コードが 3 のときは、登録と起動はできたが常駐化できておらず、再起動で止まる。WSL では sudo のパスワードを 1 回入力すると常駐化まで進むので、対話できる端末から再実行する。

runner ホストに Docker や Node を入れるのは `ansible/runner-host.yml` の役割で、runner 自体の設置とは分けている。
