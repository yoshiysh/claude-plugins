---
name: coverage-audit
description: >
  与えられた目的と対象（設計・計画・要求・仕様・コード・テストなどのファイル）を、資産 × 観点の枡に分けて網羅的に検査し、
  確かめた指摘と、見ていない所（開示した枡）を台帳に残して返す検査専用の仕組み。1 体には 1 枡だけを渡し、
  読んだ証拠を本文の区画ごとの逐語の引用で機械が照らし、読む役と別のモデル・反証側の検証役が指摘を確かめ、
  悪かった出来事を振り返り、確かめた欠陥を根本原因で束ねて型を全ての資産へ横展開する。台帳は run をまたいで持ち越し、変わった枡だけを読み直す。
  「修正の前にこの設計・計画を観点ごとに漏れなく検査して」「この実装が目的と仕様を満たすか網羅的に検証して」
  「前回の台帳の続きから、変わった所だけ検査し直して」のような依頼で使う（Use when files must be audited for every part × every lens with machine-checked evidence, without fixing them）。
  対象外: 修正・生成の実行（このスキルは指摘と網羅の記録までを返し、直すのは呼ぶ側）、1 体で 1 回で済む小さな確認、このリポジトリの差分・PR のレビュー（repo-review）。
---

# Coverage audit

## 目次

- [目的](#目的)
- [始める前に決めること](#始める前に決めること)
- [手順](#手順)
- [Workflow を呼ぶ](#workflow-を呼ぶ)
- [止まったとき](#止まったとき)
- [役とモデル](#役とモデル)
- [参照](#参照)

## 目的

確率的な部品（1 体ずつの agent）から、全体として信頼できる検査の結果を出す。出すのは確かめた指摘と網羅の記録までで、対象のファイルを直さず、何も生成しない。使いどころは、修正の前の設計・計画の検査や、実装後の検証（変更が目的・仕様を満たすか）など。そのために次の形を取る。

- 1 体に任せる量を小さくする。読む役・検証役は 1 つの枡（資産 1 つ × 観点 1 つ）だけを読む。全体を見るのは計画役・統合役・束ね役だけ。
- どこを見たかを台帳に残し、空きを見える形にする。「見た」は自己申告を信じず、本文の区画ごとの逐語の引用で機械が照らす。
- 指摘と検証を分ける。検証役は新しい context で、読む役と別のモデル、反証側の枠組みで読む。
- 静的に決まること（範囲の列挙・枡の生成・引用と ID と件数の照合・形式・上限・止める条件）は script が決め、LLM には判断だけを任せる。
- 重要度で枡を絞らない。全ての枡を同じ扱い（網羅＋検証）にする。

独立は Anthropic のモデルどうしで役の枠組みを変えて作るので、盲点の重なりは減りにくい。結果を報告するときはこれを開示する。

## 始める前に決めること

利用者の依頼から次を作り、`stateDir`（作業ツリーの外。例: scratchpad）にファイルで置く。

目標（goal.md・criteria.md・constraints.md）には、検査で利用者が確かめたいことだけを書く。どう確かめるか（観点・手順などの手段の細部）は書かない。手段を目標に混ぜると、目標の照合が細部で揺れて往復するため。観点は計画役が目標と対象から切る。

| ファイル | 中身 |
|---|---|
| request.md | 依頼文（利用者の言葉のまま） |
| decisions.md（任意） | 利用者が会話で決めたこと。利用者の言葉のまま 1 行 1 件で `- ...` |
| goal.md | 検査の目標（何が満たされているかを確かめるのか）。1 行 1 件で `- G1: ...` |
| criteria.md（任意） | 受け入れ基準（対象が満たすべきこと。照らす仕様・規準もここに書く）。1 行 1 件で `- AC1: ...` |
| constraints.md（任意） | 制約（検査の進め方で守ること）。1 行 1 件で `- D1: ...` |
| lenses.json（任意） | 利用者が決めた観点 `[{id, name, procedure}]`。procedure は「何を列挙し、何と照らすか」の手続き。無ければ計画役が切る |

goal.md・criteria.md・constraints.md の各行の末尾に、request.md か decisions.md からの逐語の引用を `〔request: …〕` か `〔decisions: …〕` で 1 つ以上付ける。短い引用は、引用元の 1 件の全体（decisions.md の 1 行の全体、または request.md の空でない 1 行の全体〔前後の空白を除く〕）を引くとき以外は init が字数で拒否する（最小字数は `CITE_MIN`、拒否のメッセージにも出る）。引用の中に `〔` `〕` は書けない。`- ` で始まらない行（見出しと空行を除く）、引用の無い項目、引用元に逐語で無い引用は init が拒否する。指示語は固有名に置き換える。

| ファイル | 例（1 行が 1 件） |
|---|---|
| request.md | `この設計文書を観点ごとに漏れなく検査して、確かめた指摘を返してほしい` |
| decisions.md | `- 本文は直さない` |
| goal.md | `- G1: 設計文書の見落としを観点ごとに確かめた指摘の一覧 〔request: この設計文書を観点ごとに漏れなく検査して〕` |
| constraints.md | `- D1: 対象の本文を直さない 〔decisions: 本文は直さない〕` |

検査する対象は `--target` で渡す（複数可。文書・コード・テストなど種類を問わない）。仕様書そのものも検査するなら対象に加える。

coverage-build から呼ばれたときは、coverage-build の `next` が渡す init の引数（`init_argv`）をそのまま使う。その引数の `--goal-checked coverage-build` は、coverage-build が目標を照合済みである印で、この印があると init は引用を照らさず、目標の照合役も起動しない（目標のファイルの先頭の、検査の段を述べる文も受け付ける）。利用者が単独で呼ぶときは付けない。

## 手順

CLI は `node [SKILL_DIR]/scripts/ledger-cli.mjs`（以下 `CLI`）。出力は JSON。

1. 台帳を作る。台帳が既にある（続きから・変わった所だけ検査し直す）なら 2 へ。

   ```bash
   CLI init --state <stateDir> --goal goal.md --request request.md \
     --target <file> [--target <file> ...] [--decisions decisions.md] [--criteria criteria.md] [--constraints constraints.md] [--lenses lenses.json] \
     [--k N] [--max-cycles N] [--max-agents-total N] [--roles roles.json] [--seeds seeds.json]
   ```

   数の引数は正の整数だけを受け付け、省いた値は `scripts/ledger-core.mjs` の `DEFAULT_CONFIG` になる。読めない対象と、引用の照合を通らない項目（`problems`）があれば台帳を作らずに拒否する（直して init をやり直す）。出力の `hint` の文を利用者に示す（ヒントは run の途中でも `CLI hint --state <stateDir> --text "..."` で足せ、次の呼び出しの役に届く）。
2. `CLI next --state <stateDir>` を流す。
   - `stop` があれば終わり。「止まったとき」へ。
   - `step` があれば、`estimate_agents`（最悪の起動数）を見てから、下の「Workflow を呼ぶ」で `args_path` の args を 1 回流す。
3. Workflow の返り値をそのまま JSON でファイルに保存し、`CLI ingest --state <stateDir> --result <file>` を流す。native Workflow が tasks に残す出力ファイル（`.output`。返り値を `result` に包んだ形）は、保存し直さずにその path をそのまま `--result` に渡してよい。CLI が写しの hash・引用・件数・ID を照らし直し、通ったものだけを台帳に入れる。受け付けなかった出力があれば、その理由が出力の `rejected`（`ok` は呼び出しを取り込んだことを指す）に載るので、読んで直す。
4. 2 に戻る。

`next` は台帳だけから次の 1 手を決める（目標の照合と観点の計画 → 枡を読む → 振り返り → 束ねと横展開 → 次の周）。目標の照合では、照合役が依頼文と決定の記録から利用者の求める成果を引用つきで挙げ、各成果を受け止める項目の id を返す。script が引用の実在・id の実在を照らし、どの項目にも受け止められていない成果があれば `needs_input` で返す。照合役は、項目が依頼に無いものを足したか・範囲を狭めたかを判定しない（足していないことは init の引用の照合が確かめる）。同じ状態で `next` を流し直すと同じ呼び出し（同じ `call_id`）が返るので、Workflow が途中で落ちたら 2 からやり直せばよい。待っている `call_id` と違う結果は `ingest` が拒否する。

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
> `init --roles` の上書きの全て）に runner の `modelMap` を明示する。担当は `stateDir/snap/` の写しを Read で読む。
> Codex の runner の worker が `stateDir` のファイルを読めるかは確かめていない（読めなければ枡は欠けとして数えられ、開示に倒れる）。

```js
Workflow({
  scriptPath: "[SKILL_DIR]/scripts/coverage-audit.js",
  args: <next の args_path のファイルの中身（JSON object）をそのまま>
})
```

args を書き換えない（source が `argsSum` で写し違い・切り詰めを拒否し、`ingest` が `call_id` を照らす）。args には担当が読む文を載せない。目標・受け入れ基準・制約・依頼文・決定の記録・ヒント・回答・前の計画・計画の欠陥・観点の手続きは、`next` が呼び出しごとに `stateDir/snap/` に内容の hash の名前で書く束（brief）に入り、対象の本文・計画役に渡す対象の索引・束ね役に渡す指摘の全件も同じく写しに入る。args に載るのは、写しのファイル・行の範囲・hash と、id・件数・役の設定・`callId`・`argsSum` だけで、担当は Read で束と自分の範囲だけを読む。`ingest` は args の hash と写し（束を含む）の hash が違えば台帳を変えずに拒否する。1 回の呼び出しの起動数は `meta.limits.maxAgents` に収まるように `next` が枡を区切り、残りは次の呼び出しに回る。

## 止まったとき

`next` の `stop` ごとに、利用者へ返すもの。どの停止でも `CLI status --state <stateDir>` の結果（カバレッジ・開示した枡・確かめた指摘・検証不能・束・観点の外の気づき・役ごとの起動数・較正）を添え、「問題なし」とは書かない。

| stop | 返すもの | 続け方 |
|---|---|---|
| complete | 確かめた指摘（層・引用つき）、開示した枡（`disclosed`）とその理由、指摘の無い枡は読んだだけで検証役を通っていないこと（`coverage.settled_no_findings`）、盲点が相関しうることの開示 | 対象が変わったら同じ台帳で `next`（変わった枡だけ読み直し、新しい周で振り返りと束ねを通す） |
| needs_input | `reasons` と、決めること（`questions`・`upper`・`upper_groups`・`unverifiable`・`stuck`・`plan_defects`・`goal_gaps`）を判断材料つきで。`goal_gaps` は、どの項目にも受け止められていない成果とその引用 | 利用者の回答を `CLI answer --state <stateDir> --id <id> --text "..."` で足して `next`。`upper_groups` は束の id、`upper`・`unverifiable` は指摘の id、`stuck` は `attempts:<キー>`。質問への回答は利用者の言葉として決定の記録に足し、その行を引用する制約になる。目標・受け入れ基準・制約・決定の記録を直すときは `--id goal`・`criteria`・`constraints`・`decisions` と `--file <直したファイル>`（中身を置き換え、引用を照らし直し、目標の照合からやり直す。照合を通らなければ台帳を変えずに拒否する。coverage-build から渡された台帳では拒否し、coverage-build の台帳で直す） |
| limit | どの上限か、ここまでの結果 | 利用者が上限を変えるなら `CLI config --state <stateDir> --max-cycles N` か `--max-agents-total N` の後で `next` |
| blocked | `cause`（input・target・failure）と理由 | 原因を直して `next` |

上の層（方針・要求）が原因の欠陥・束は、呼ぶ側が直す前に利用者が判断するものとして `needs_input` で返す。下の層の確かめた指摘は `complete` の結果に入り、直すかどうかと直し方は呼ぶ側が決める。

## 役とモデル

役ごとのモデルと effort は `scripts/roles.json`（理由つき）が正本で、`init --roles <file>` で役ごとに上書きできる。値は実測で見直す前提。起動した役・指定した model・effort・成否は台帳の `agents`、token は `calls` に残る（runner では token を読めないので null と理由）。記録する model は指定した値で、実際に効いたかは記録から確かめられないので、効いていない前提で起動数の側で費用を抑える。

`k` を 2 以上にすると、全ての枡を p 回目ごとに `reader_p`（無ければ `reader_1`）で重ねて読み、その指摘を `verifier_p`（無ければ `verifier`）が確かめる。「検証役は読む役と別のモデル」は、各 p で `reader_p` と `verifier_p` のモデルが違うときだけ成り立つ。既定の表は p=1・2 で違うモデルにしてある。3 回目以上や `--roles` で上書きするときは、各回の組が別のモデルになるように `reader_p`・`verifier_p` を足す。

## 参照

- [references/ledger.md](references/ledger.md): 台帳の構成、段ごとの script と LLM の分け方、写しと ID と持ち越し、止める条件の全表、記録、汎用の設計の型から変えた点。
- 静的な照合の正本: Workflow source（上の callsite の script）の `// <checks>` 区間（CLI も同じ文を読み込む）。その中の `// <goalmap>` 区間（目標・基準・制約の引用と目標の照合）は coverage-build の Workflow source と同じ文。
