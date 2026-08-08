# Claude Fable 5 Prompting Guide — orchestration 抜粋（condensed）

> **時限性の注意**：この reference は Claude Fable 5 というモデル固有の挙動に基づく。
> 次期フラッグシップモデルへ交代する際は、`SKILL.md`「モデル交代時の更新ポイント」節に
> 従って本ファイルと `scripts/orchestrate.js` の `model: 'fable'` を差し替えること。

Anthropic 公式ドキュメント "Prompting Claude Fable 5" の抜粋を condensed したもの。
`chat` スキルの target-model-prompting-guide は**単発助言**（壁打ち
1往復、subagent 委譲なし）向けの節だけを条件抜粋しており、本ファイルはその補集合——
**複数ラウンドの subagent 委譲ループ**特有の節だけを条件抜粋している。両者は重複しない。

## Parallel subagents（Plan ステップが従う）

Fable 5 は先行モデルより並列 subagent の委譲に長けており、積極的に使ってよい。
非同期の運用（委譲後ブロックせず動き続ける）を好む。長寿命な subagent はコンテキストを
跨いで保持することで cache read の節約と「最も遅い subagent への律速」の回避になる——
ただし本スキルでは Claude Code の「subagent はさらに subagent を spawn できない」
制約により、subagent の長寿命化・再委譲は行わない（1ラウンド1ショットの subagent として
設計する）。

```
Delegate independent subtasks to subagents and keep working while they run. Intervene if a subagent goes off track or is missing relevant context.
```

## Consider all effort levels（Plan ステップが従う）

`effort` は「知性・レイテンシ・コスト」のトレードオフを制御する主要パラメータ。
`high` を大半のタスクの既定にし、特に判断に敏感なタスクには `xhigh`、定型作業には
`medium`/`low` を使う。低い effort でも先行モデルの `xhigh` を上回ることが多い。

## Recommended scaffolding: fresh-context verifier（Verify ステップの設計根拠）

> "Separate, fresh-context verifier subagents tend to outperform self-critique."

自己採点（同じ subagent が自分の出力を自己批評する）より、**文脈を共有しない別の
subagent が検証する**方が品質が高い。本スキルの Verify ステップは、Execute で
出力した subagent 自身にではなく、常に**別の agent() 呼び出し**（`references/verifier-role.md`
準拠）に検証させる。これは loop engineering の「検証は generator-verifier で分離する。
自分が書いたものを自分で採点しない」と完全に一致する原則。

## Construct a memory system（Synthesize ステップが意識する）

Fable 5 は過去のラウンドの教訓を記録・参照できる場があると特に性能が上がる。
1教訓1ファイル、冒頭に一行要約、訂正と確認済みアプローチの両方を記録し、重複作成せず
既存ノートを更新する。

本スキルでは、この原則を以下の形で運用する:

- **ラウンド間（同一実行内）**: `history` 配列（`orchestrate.js` が保持）がこの役割を
  果たす。Plan/Evaluate はすべての過去ラウンドの `summary`/`findings`/`open_questions`
  を毎回受け取る。
- **実行を跨いだ恒久的な教訓**: 本スキル自体が汎用的に改善すべき教訓（例:「特定の
  タスク種別では〇〇系 subagent を必ず含めるべき」）に気づいた場合、Synthesize
  ステップの出力に「次回この skill を改善するなら」を含めてよい。ただし**自動で
  `references/*.md` を書き換えない**——ユーザーへの提示に留め、恒久化はユーザー承認を
  経て行う（loop engineering の自己改善原則、および「プロジェクトの制約ファイル変更は
  ユーザー承認制」という既定の運用に合わせる）。

## Rare cases of early stopping / autonomous operation（全ステップ共通）

長い自律実行の途中で、許可を求めて止まってしまうことがある。本スキルの各ステップは
ユーザーが見ていない/介入できない前提で動くため、以下の姿勢を各 role ファイルで前提とする:

```
You are operating autonomously. The user is not watching in real time and cannot answer questions mid-task, so asking "Want me to…?" or "Shall I…?" will block the work. For reversible actions that follow from the original request, proceed without asking.
```

本スキルの subagent は state を変更しない（read-only な調査・分析・評価に限定）ため、
「不可逆な行動」に該当するものはそもそも存在しない。この指示は「止まらずに調査・分析を
完遂せよ」という意味で適用する。

## Ground progress claims（Evaluate ステップが最重要視する）

```
Before reporting progress, audit each claim against a tool result from this session. Only report work you can point to evidence for; if something is not yet verified, say so explicitly. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.
```

`references/evaluator-role.md` の収束判定はこの原則そのものを審査基準に据える
（「subagent が出力を返した」ことと「難問に対する答えが実際に得られた」ことを混同しない）。

## Don't ask Fable to reproduce its internal reasoning（全ステップ共通の禁止事項）

Fable 5 に「内部の推論過程をそのまま応答に書き出せ」と指示すると、
`reasoning_extraction` という拒否カテゴリに触れ、Opus へのフォールバックが増える。
本スキルの role ファイル（planner/evaluator/synthesis）は、いずれも「結論・判断・
その根拠となった具体的な証拠」を書かせる設計であり、「内部の思考過程そのものを逐語
的に書き出せ」という指示は含めない（分析の深さを求める指示と、内部推論の逐語転写を
求める指示は別物であることに注意する）。
