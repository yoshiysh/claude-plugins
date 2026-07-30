# Claude Fable 5 Prompting Guide（condensed）

> **時限性の注意**：この reference は Claude Fable 5 というモデル固有の挙動に基づく。
> 次期フラッグシップモデルへ交代する際は、**本ファイルと `agents/*.md`（特に
> sounding-board-consultant.md）の `model:` frontmatter を差し替えること**。
> モデルが変われば有効な prompting パターンも変わりうる。

Anthropic 公式ドキュメント "Prompting Claude Fable 5" の抜粋を condensed したもの。
各パターンのプロンプト例文（コードブロック内）は **原文の英語のまま**残している
（改変すると Fable への実効性が変わりうるため）。

## 目次
- [Longer turns by default（過剰計画の抑制）](#longer-turns-by-default)
- [Strong instruction following（冗長さの抑制）](#strong-instruction-following)
- [State the boundaries（越権行動の抑制・最重要）](#state-the-boundaries)
- [Ground progress claims（根拠なき進捗報告の防止）](#ground-progress-claims)
- [Give the reason（背景付与で精度向上）](#give-the-reason)
- [Readability when communicating with the user（relay 用）](#readability-when-communicating-with-the-user)

---

## Longer turns by default

行動可能な情報が揃ったら行動する。既に確立した事実の再導出・決定済み事項の蒸し返し・
採らない選択肢の羅列を避けさせる。選択を迷うなら網羅列挙でなく推奨を出させる。

```
When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue in user-facing messages. If you are weighing a choice, give a recommendation, not an exhaustive survey. This does not apply to thinking blocks.
```

## Strong instruction following

簡潔な指示で誘導できる。結論を先頭に置かせ、readability を最優先させる（簡潔さと readability は別物）。

```
Lead with the outcome. Your first sentence after finishing should answer "what happened" or "what did you find": the thing the user would ask for if they said "just give me the TLDR." Supporting detail and reasoning come after. Being readable and being concise are different things, and readability matters more.
```

## State the boundaries

**本スキルで最重要。** ユーザーが問題説明・質問・思考の整理をしているとき、deliverable は
「assessment（見解）」であり、依頼されるまで修正を適用しない。状態を変えるコマンド実行前に
証拠がその行動を支持するか確認させる。

```
When the user is describing a problem, asking a question, or thinking out loud rather than requesting a change, the deliverable is your assessment. Report your findings and stop. Don't apply a fix until they ask for one. Before running a command that changes system state (restarts, deletes, config edits), check that the evidence actually supports that specific action. A signal that pattern-matches to a known failure may have a different cause.
```

## Ground progress claims

進捗報告の各主張をセッション内のツール結果と照合させる。未検証は明示させ、根拠なき断定を防ぐ。

```
Before reporting progress, audit each claim against a tool result from this session. Only report work you can point to evidence for; if something is not yet verified, say so explicitly. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.
```

## Give the reason

相談の背景（誰のための何か、何を可能にするか）を伝えると精度が上がる。prompt-compiler が
相談文に背景があればこの型で再構成する。

```
I'm working on [the larger task] for [who it's for]. They need [what the output enables]. With that in mind: [request].
```

## Readability when communicating with the user

**relay-formatter が直接適用するパターン。** ツール呼び出し間の terse な shorthand は
「考え中の独り言」として許容されるが、最終サマリはそれを見ていない読者向けに書き直す。
working thread の続きでなく re-grounding として、outcome を先に置き、作業中に作った語彙は
持ち込まない。矢印連鎖・ハイフン連結・自作ラベルを落とし、完全な文で書く。識別子には
それぞれ平易な節を与える。短さと明快さが両立しないなら明快さを選ぶ。

```
Terse shorthand is fine between tool calls (that's you thinking out loud, and brevity there is good). Your final summary is different: it's for a reader who didn't see any of that.

Write it as a re-grounding, not a continuation of your working thread: the outcome first, then the one or two things you need from them, each explained as if new. The vocabulary you built up while working is yours, not theirs; leave it behind unless you re-introduce it.

When you write the summary at the end, drop the working shorthand. Write complete sentences. Spell out terms. Don't use arrow chains, hyphen-stacked compounds, or labels you made up earlier. When you mention files, commits, flags, or other identifiers, give each one its own plain-language clause. Open with the outcome: one sentence on what happened or what you found. Then the supporting detail. If you have to choose between short and clear, choose clear.
```
