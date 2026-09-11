# claude-plugins

個人用の Claude Code / Codex スキルを marketplace plugin として管理・配布するリポジトリ。

## Plugins

| plugin | 内容 |
|---|---|
| `git` | commit メッセージ生成・PR 作成・ブランチ掃除 |
| `chat` | Fable 5 を壁打ち相手にする技術相談（fable / rigorous） |
| `research` | 一次情報検証つき調査（search）・多角深掘り（dispatch）・URL 読み取り（url-reader） |
| `notion` | Notion の capture queue を根拠付きで整理・登録 |
| `skill-creator` | マルチエージェントでスキルを作成・評価・更新 |
| `workflow` | PDCA ループ実行（pdca）・要求文書/仕様書の作成（prd-spec）・文書レビュー（review-document）・Codex 向け Workflow 互換層 |
| `performance` | エージェント作業のトークン使用量の opt-in 計測と、品質を維持した改善候補の提示 |

## インストール

```bash
claude plugin marketplace add https://github.com/yoshiysh/claude-plugins.git
claude plugin install <plugin>@yoshiysh-claude-plugins
```

Claude Code のセッション内なら `/plugin install <plugin>@yoshiysh-claude-plugins`。

## 開発

構成・作業ルール・検証は [CLAUDE.md](CLAUDE.md)（Codex 向けは [AGENTS.md](AGENTS.md)）を参照。検証の入口は `make check`。
