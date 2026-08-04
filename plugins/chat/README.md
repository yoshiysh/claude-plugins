# chat

Claude Fable 5 相当の壁打ち相談を提供するプラグイン。

## 収録スキル

| スキル | 呼び出し | 説明 |
|---|---|---|
| `fable` | `/chat:fable` | > |
| `rigorous` | `/chat:rigorous` | > |

## 使い方

```
/chat:fable <相談内容>
/chat:rigorous <対象/トピック>
```

詳細なフローは `skills/chat/SKILL.md` / `skills/chat-rigorous/SKILL.md` を参照してください。

## 構成

このプラグインの `skills/` 配下は、リポジトリ本体の
`.claude/skills/` への相対シンボリックリンクです。スキル実体はディレクトリ名
（`chat` / `chat-rigorous`）のまま、frontmatter の `name`（`fable` / `rigorous`）で公開されます。
