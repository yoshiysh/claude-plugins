---
name: coverage-ledger
description: >
  LLM の agent の作業（文書・設計・計画のレビューや作成）の見落としを構造で減らす汎用の仕組み。
  対象を資産 × 観点の枡に分けて台帳に載せ、1 体には 1 枡だけを渡し、読んだ証拠を引用の機械照合で確かめ、
  別のモデル・反証側の枠組みの検証役で指摘を確かめ、悪かった出来事を振り返って原因の層へ戻し、確かめた欠陥の型を全ての資産へ横展開する。
  台帳は run をまたいで持ち越し、変わった枡だけを読み直す。
  「この文書を観点ごとに漏れなくレビューして」「入力を全部扱って設計文書を作り、網羅的に検証して」
  「前回の台帳の続きから、変わった所だけ見直して」のような依頼で使う（Use when a review or a generated document must cover every part × every lens with machine-checked evidence）。
  対象外: 1 体で 1 回で済む小さな確認、このリポジトリの差分・PR のレビュー（repo-review）、コードの実装や修正。
---

# Coverage ledger

## 目次

- [目的](#目的)
- [始める前に決めること](#始める前に決めること)
- [手順](#手順)
- [Workflow を呼ぶ](#workflow-を呼ぶ)
- [止まったとき](#止まったとき)
- [役とモデル](#役とモデル)
- [参照](#参照)

## 目的

確率的な部品（1 体ずつの agent）から、全体として信頼できる結果を出す。そのために次の形を取る。

- 1 体に任せる量を小さくする。読む役・検証役は 1 つの枡（資産 1 つ × 観点 1 つ）、実行役は 1 つの論点、振り分け役は 1 束の入力だけを読む。全体を見るのは計画役・統合役・書き手・束ね役だけ。
- どこを見たかを台帳に残し、空きを見える形にする。「見た」は自己申告を信じず、本文の区画ごとの逐語の引用で機械が照らす。
- 生成と検証を分ける。検証役は新しい context で、読む役と別のモデル、反証側の枠組みで読む。
- 静的に決まること（範囲の列挙・枡の生成・引用と ID と件数の照合・形式・上限・止める条件）は script が決め、LLM には判断だけを任せる。
- 重要度で枡を絞らない。全ての枡を同じ扱い（網羅＋検証）にする。

独立は Anthropic のモデルどうしで役の枠組みを変えて作るので、盲点の重なりは減りにくい。結果を報告するときはこれを開示する。

## 始める前に決めること

利用者の依頼から次を作り、`stateDir`（作業ツリーの外。例: scratchpad）にファイルで置く。指示語は固有名に置き換え、依頼に無い目標・制約を足さない。

| ファイル | 中身 |
|---|---|
| goal.md | 固定する目標。最終的に確かめられる成果物で書き、手順を入れない |
| request.md | 依頼文（利用者の言葉のまま） |
| constraints.md（任意） | 固定した制約。1 行 1 件で `- D1: ...` |
| lenses.json（任意） | 利用者が決めた観点 `[{id, name, procedure}]`。procedure は「何を列挙し、何と照らすか」の手続き。無ければ計画役が切る |
| 入力（任意） | 材料のファイル。`.jsonl`（1 行 1 項目 `{id,text}`）か Markdown（見出しごとに 1 項目） |

mode は 2 つ。

- `review`: 既にある対象（`--target`、複数可）を見る。
- `create`: 入力から成果物（`--artifact`）を作り、作った成果物を同じ仕組みで見て、確かめた欠陥を論点へ戻して直す。

## 手順

CLI は `node [SKILL_DIR]/scripts/ledger-cli.mjs`（以下 `CLI`）。出力は JSON。

1. 台帳を作る。台帳が既にある（続きから・変わった所だけ見直す）なら 2 へ。

   ```bash
   CLI init --state <stateDir> --mode review --goal goal.md --request request.md \
     --target <file> [--target <file> ...] [--constraints constraints.md] [--lenses lenses.json] \
     [--input <file>[::PREFIX[::ref]] ...] [--k 1] [--max-cycles 4] [--max-agents-total 600] [--seeds seeds.json]
   ```

   `create` では `--target` の代わりに `--artifact <書く先>`。`::ref` を付けた入力は参照だけで、行き先を要らない。読めない入力は `blocked` で拒否される。出力の `hint` の文を利用者に示す（ヒントは run の途中でも `CLI hint --state <stateDir> --text "..."` で足せ、次の呼び出しの役に届く）。
2. `CLI next --state <stateDir>` を流す。
   - `stop` があれば終わり。「止まったとき」へ。
   - `step` があれば、`estimate_agents`（最悪の起動数）を見てから、下の「Workflow を呼ぶ」で `args_path` の args を 1 回流す。
3. Workflow の返り値をそのまま JSON でファイルに保存し、`CLI ingest --state <stateDir> --result <file>` を流す。CLI が引用・件数・ID を照らし直し、通ったものだけを台帳に入れる。
4. 2 に戻る。

`next` は台帳だけから次の 1 手を決める（目標の照合と計画 → 案と書き手 → 枡を読む → 振り返り → 束ねと横展開 → 次の周）。同じ状態で `next` を流し直すと同じ呼び出し（同じ `call_id`）が返るので、Workflow が途中で落ちたら 2 からやり直せばよい。待っている `call_id` と違う結果は `ingest` が拒否する。

## Workflow を呼ぶ

> **透過実行 route**: 現在の tool inventory に native `Workflow` があり、この call が未試行なら
> native を 1 回だけ使う。native が存在しない Codex では `workflow:dynamic-workflow-runner` を
> 内部互換層として使い、ユーザーに runner の指定を求めない。native を試行後に error / timeout /
> invalid result となった場合は runner へ fallback しない（`next` からやり直す）。human gate は無し。caller が所有する
> 前処理は「手順」の 1〜2、成功後処理は 3。runner の verified return 以外で 3 へ進まず、runner 未 install・
> `unsupported_runtime`・`rejected_source`・`workflow_incomplete` はそのまま報告する。
>
> **Codex classification: read-only supported**。runner request の `requirements` と `limits` は source の
> `meta.requirements`・`meta.limits` をそのまま使い、SKILL.md に値を写さない。args の `roles` にある model 名（既定の役の表と
> `init --roles` の上書きの全て）に runner の `modelMap` を明示する。worker は対象を読む必要が無い（本文は args で渡る）。

```js
Workflow({
  scriptPath: "[SKILL_DIR]/scripts/coverage-ledger.js",
  args: <next の args_path のファイルの中身（JSON object）をそのまま>
})
```

args を書き換えない（source が `argsSum` で写し違い・切り詰めを拒否し、`ingest` が `call_id` を照らす）。1 回の呼び出しの起動数は `meta.limits.maxAgents` に収まるように `next` が枡や論点を区切り、残りは次の呼び出しに回る。args は本文を含むので大きくなりうる（入力が数百件の plan では数百 KB）。

## 止まったとき

`next` の `stop` ごとに、利用者へ返すもの。どの停止でも `CLI status --state <stateDir>` の結果（カバレッジ・開示した枡・確かめた指摘・検証不能・束・観点の外の気づき・役ごとの起動数・較正）を添え、「問題なし」とは書かない。

| stop | 返すもの | 続け方 |
|---|---|---|
| complete | 確かめた指摘（層・引用つき）、開示した枡（`disclosed`）とその理由、指摘の無い枡は読んだだけで検証役を通っていないこと（`coverage.settled_no_findings`）、盲点が相関しうることの開示 | 対象が変わったら同じ台帳で `next`（変わった枡だけ読み直す） |
| needs_input | `reasons` と、決めること（`questions`・`upper`・`unverifiable`・`rejected`・`stuck`・`plan_defects`・`goal_problems`）を判断材料つきで | 利用者の回答を `CLI answer --state <stateDir> --id <id> --text "..."` で足して `next`。目標を直すときは `--id goal` |
| limit | どの上限か、ここまでの結果 | 利用者が上限を変えるなら `CLI config --state <stateDir> --max-cycles N` か `--max-agents-total N` の後で `next` |
| blocked | `cause`（input・target・failure）と理由 | 原因を直して `next` |

上の層（方針・要求）が原因の欠陥は自動で直さない。create で直すのは、それより下の層の確かめた欠陥だけで、成果物の節から論点へ戻して案を出し直し、書き手が全ての欠陥に「直した／退けた」を返す。

## 役とモデル

役ごとのモデルと effort は `scripts/roles.json`（理由つき）が正本で、`init --roles <file>` で役ごとに上書きできる。値は実測で見直す前提。起動した役・指定した model・effort・成否は台帳の `agents`、token は `calls` に残る（runner では token を読めないので null と理由）。記録する model は指定した値で、実際に効いたかは記録から確かめられないので、効いていない前提で起動数の側で費用を抑える。`k` を 2 以上にすると、全ての枡を `reader_1`・`reader_2`…で重ねて読む。

## 参照

- [references/ledger.md](references/ledger.md): 台帳の構成、段ごとの script と LLM の分け方、ID と持ち越し、止める条件の全表、記録、設計の正本から離れたところ。
- [references/writing.md](references/writing.md): 書き手に渡す文書の書き方（表・図・散文の使い分け）。
- 静的な照合の正本: Workflow source（上の callsite の script）の `// <checks>` 区間（CLI も同じ文を読み込む）。
