---
name: coverage-audit
description: >
  与えられた目的と対象（設計・計画・要求・仕様・コード・テストなどのファイル）を、資産 × 観点の枡に分けて網羅的に検査し、
  確かめた指摘と、見ていない所（開示した枡）を台帳に残して返す検査専用の仕組み。読む役は資産を 1 つずつ取り、観点ごとの枡に分けて 1 枡ずつ出し、
  読んだ証拠を本文の区画ごとの逐語の引用で機械が照らし、読む役と別のモデル・反証側の検証役が指摘を確かめ、
  悪かった出来事を振り返り、確かめた欠陥を根本原因で束ねて型の当たる資産へ横展開する。台帳は run をまたいで持ち越し、変わった枡だけを読み直す。
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

- 1 体に任せる判断を小さくする。読む役の worker は待ち行列から資産を 1 つ取って 1 回読み、観点を枡（資産 1 つ × 観点 1 つ）ごとに切り替えて 1 枡ずつ出す。前の枡の結果は次の枡に持ち込まない。検証役の worker は指摘のある枡を 1 つずつ取る。全体を見るのは計画役・統合役・束ね役だけ。資産は中身の境目で切る（Markdown は frontmatter と節の中の段落・箇条書き・表・コード、JS は宣言。切り方と id は references/ledger.md）。
- どこを見たかを台帳に残し、空きを見える形にする。「見た」は自己申告を信じず、本文の区画ごとの逐語の引用で機械が照らす。
- 指摘と検証を分ける。検証役は新しい context で、読む役と別のモデル、反証側の枠組みで読む。
- 静的に決まること（範囲の列挙・枡の生成・引用と ID と件数の照合・形式・上限・止める条件）は script が決め、LLM には判断だけを任せる。
- 観点は、目標と資産の中身に関係する資産にだけ当てる。計画役が観点ごとに当てる資産を決め、どの観点も関係しない資産は、理由と共に除く資産（`excluded`）に入れる。script は、id の実在と、全ての資産が観点の当てる資産か除く資産のどちらか一方にちょうど 1 回入ることを照らす。関係の無い組は枡にしない。除いた資産は見ていない所として開示する。
- 重要度で枡を絞らない。作った枡は全て同じ扱い（網羅＋検証）にする。

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
| lenses.json（任意） | 利用者が決めた観点 `[{id, name, procedure}]`。procedure は「何を列挙し、何と照らすか」の手続き。全ての資産に当てる。無ければ計画役が観点と当てる資産を切る |

goal.md・criteria.md・constraints.md の各行の末尾に、request.md か decisions.md からの逐語の引用を `〔request: …〕` か `〔decisions: …〕` で 1 つ以上付ける。引用は 12 字以上にする（decisions.md の 1 行の全体、または request.md の空でない 1 行の全体〔前後の空白を除く〕を引くときは短くてよい）。引用の中に `〔` `〕` は書けない。`- ` で始まらない行（見出しと空行を除く）、引用の無い項目、引用元に逐語で無い引用は init が拒否する。指示語は固有名に置き換える。

| ファイル | 例（1 行が 1 件） |
|---|---|
| request.md | `この設計文書を観点ごとに漏れなく検査して、確かめた指摘を返してほしい` |
| decisions.md | `- 本文は直さない` |
| goal.md | `- G1: 設計文書の見落としを観点ごとに確かめた指摘の一覧 〔request: この設計文書を観点ごとに漏れなく検査して〕` |
| constraints.md | `- D1: 対象の本文を直さない 〔decisions: 本文は直さない〕` |

検査する対象は `--target` で渡す（複数可。文書・コード・テストなど種類を問わない）。仕様書そのものも検査するなら対象に加える。

coverage-build から呼ばれたときは、coverage-build の `next` が渡す引数（`init_argv` か `reframe_argv`）をそのまま使う。台帳は coverage-build の段（`--phase`）をまたいで 1 つに固定する。
- `--goal-checked coverage-build` は、coverage-build が目標を照合済みである印。この印があると init は引用を照らさず、目標の照合役も起動しない（目標のファイルの先頭の、検査の段を述べる文も受け付ける）。利用者が単独で呼ぶときは付けない。
- 印のある台帳は振り返りの資産を作らない。出来事は `status` の `events` で返し、coverage-build の探索グラフが受ける（振り返りを 1 か所に寄せるため）。束ねと横展開は検査の一部なので残す。
- 段が変わると `reframe` で目標の冒頭の文・目標・基準・制約・依頼文・決定の記録・対象と段を差し替える（下の「手順」）。

## 手順

CLI は `node [SKILL_DIR]/scripts/ledger-cli.mjs`（以下 `CLI`）。出力は JSON。

1. 台帳を作る。台帳が既にある（続きから・変わった所だけ検査し直す）なら 2 へ。

   ```bash
   CLI init --state <stateDir> --goal goal.md --request request.md \
     --target <file> [--target <file> ...] [--decisions decisions.md] [--criteria criteria.md] [--constraints constraints.md] [--lenses lenses.json] \
     [--k N] [--max-cycles N] [--max-agents-total N] [--roles roles.json] [--seeds seeds.json]
   ```

   `--phase <段>`（任意）は呼ぶ側の段の名前で、台帳の `phase` に残り、`status` を段ごとに分ける。

   印（`--goal-checked coverage-build`）と段のある台帳は、段が変わったら init をやり直さずに `reframe` で差し替える。

   ```bash
   CLI reframe --state <stateDir> --goal goal.md --request request.md [--decisions decisions.md] [--criteria criteria.md] [--constraints constraints.md] \
     --target <file> [--target <file> ...] --phase <段>
   ```

   reframe は印を残し、出ていく段の `status` の節（指摘・束ね・出来事）を `phase_records` に写してから、計画・回答・横展開の観点・束ね・試行を捨て、全ての枡を読み直しにして計画から作り直す（中身が同じでも読み直す）。周と起動数の上限は、段の始まり（init か reframe）から数える。印の無い台帳・`--phase` の無い reframe・照合を通らない項目・読めない対象は、台帳を変えずに拒否する。

   review の 1 回の呼び出しで回と待ち行列ごとに起動する worker の数は `CLI config --state <stateDir> --workers N` で変える（既定は `DEFAULT_CONFIG` の `workers`。`2 × k × N` が `meta.limits.maxAgents` を超える値は拒否する）。

   数の引数は正の整数だけを受け付け、省いた値は `scripts/ledger-core.mjs` の `DEFAULT_CONFIG` になる。読めない対象と、引用の照合を通らない項目（`problems`）があれば台帳を作らずに拒否する（直して init をやり直す）。出力の `hint` の文を利用者に示す（ヒントは run の途中でも `CLI hint --state <stateDir> --text "..."` で足せ、次の呼び出しの役に届く）。
2. `CLI next --state <stateDir>` を流す。
   - `stop` があれば終わり。「止まったとき」へ。
   - `step` があれば、`estimate_agents`（最悪の起動数）を見てから、下の「Workflow を呼ぶ」で `args_path` の args を 1 回流す。
   review の段では、Workflow の中の worker が `CLI claim` と `CLI submit` を Bash で流して枡を 1 つずつ台帳に出す（下の「枡を読む」）。
3. Workflow の返り値をそのまま JSON でファイルに保存し、`CLI ingest --state <stateDir> --result <file>` を流す。native Workflow が tasks に残す出力ファイル（`.output`。返り値を `result` に包んだ形）は、保存し直さずにその path をそのまま `--result` に渡してよい。CLI が写しの hash・引用・件数・ID を照らし直し、通ったものだけを台帳に入れる。受け付けなかった出力があれば、その理由が出力の `rejected`（`ok` は呼び出しを取り込んだことを指す）に載るので、読んで直す。
4. 2 に戻る。

`next` は台帳だけから次の 1 手を決める（目標の照合と観点の計画 → 枡を読む → 振り返り → 束ねと横展開 → 次の周）。束ね役は群ごとに、既にある横展開の観点の型の例（`extends` にその観点の id）か新しい型（`pattern`）かを返し、新しい型のときだけ横展開の観点を作って次の周を開く。新しい型が 0 件なら次の周に進まず、上限の周（既定 `max_cycles` 2）で新しい型が残れば展開せずに needs_input で返す（収束の条件の詳細は references/ledger.md の「横展開の収束」）。計画は、観点ごとに当てる資産（`applies_to`）と受け持つ目標の部分（`goals: [{id, part}]`。part は目標・受け入れ基準の本文からの逐語の引用）を持ち、どの観点も関係しない資産を理由と共に除く資産（`excluded`）に入れる。全ての資産が `applies_to` の和か `excluded` のどちらか一方にちょうど 1 回入ること、`applies_to` と `goals` の id の実在、part の逐語、どの目標・基準もどれかの観点の `goals` に入ることを script が照らし、外れは計画の欠陥として統合役に戻す。持ち越しで資産が変わったときも、枡を読む前に同じ照合を流す。除いた資産は purpose・layer を含めどの観点でも読まず、`status` の `excluded` で開示する。観点ごとの検証役には閉じた問い（手続きが何を列挙するかを書いているか・何と照らすかを書いているか・`goals` の要素ごとにその部分が果たされたかを確かめられるか）だけを yes/no と逐語の引用で答えさせ、no の答えだけが計画の欠陥（id は `P<n>`）になる。統合役が no の欠陥に `rejected` と応答しても退けたことにはならず、その観点は次の検証で問い直される。手続きの細部の良し悪しは計画の段で聞かず、枡を読んだ結果で直す（理由は references/ledger.md）。目標の照合では、照合役が依頼文と決定の記録から利用者の求める成果を引用つきで挙げ、各成果を受け止める項目の id を返す。script が引用の実在・id の実在を照らし、どの項目にも受け止められていない成果があれば `needs_input` で返す。照合役は、項目が依頼に無いものを足したか・範囲を狭めたかを判定しない（足していないことは init の引用の照合が確かめる）。同じ状態で `next` を流し直すと同じ呼び出し（同じ `call_id`）が返るので、Workflow が途中で落ちたら 2 からやり直せばよい。待っている `call_id` と違う結果は `ingest` が拒否する。

枡を読む（review）の段は、待ち行列から枡を取る worker の形で回る。
- `args.workers` の行（`{id, role, pass, queue}`。回ごとに読む役と検証役の待ち行列へ `workers` 体ずつ）ごとに 1 体を起動する。検証役の worker は、全ての回の読む役の worker が終わってから起動する。読む役と検証役の worker は混ぜない。
- 読む役の worker は `claim` でまだ読んでいない資産を 1 つ（写しの範囲と、その回の当たる観点の全ての枡）取り、資産を 1 回読み、枡ごとに観点の束を読んで結果を書き `submit` する。検証役の worker は指摘のある枡を 1 つずつ、その枡の指摘だけと共に取る。`claim` が `done` を返すまで繰り返す。
- `submit` は `ingest` と同じ照合（引用・区画・判定）をかける。落ちたら理由（`problems`）を返して試行に数え、worker は直して出し直す。上限に達した枡は開示に倒し `dropped` を返す。
- 取られたまま提出されなかった枡は、その呼び出しの `ingest`（無ければ次の `next`）が戻して試行に数える。提出が 1 件も無い呼び出しは、全ての役が欠けた呼び出しと同じく数える。台帳を書くコマンドは `stateDir/ledger.lock` で直列になる。

観点の精査役は、統合の後・観点の検証の前に、観点ごとに閉じた問いへ yes/no で答える。
- N1（当てた資産ごと）: この資産に、手続きが列挙するものがあるか。答えには資産の本文からの逐語の引用を付ける。no の資産は script がその観点の `applies_to` から外し、統合には戻さない。どの観点にも残らない資産は、理由に N1 を書いて `excluded` に移す。
- N2（他の計画の観点ごと）: 同じものを列挙し、同じものと照らすか。yes には両方の手続きからの引用を付け、観点の組ごとに 1 件の計画の欠陥として統合役に戻す。
- `applies_to` が空になった観点は落とし、検証にかけず、`status` の `dropped_lenses` で開示する。落とした観点だけが受け皿だった目標・基準・制約は、計画の欠陥として統合役に戻す。
- 統合をやり直したら全ての観点を精査し直す。精査を終えていない観点が残る間は、枡を読む段に進まない。

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
> review の worker は `stateDir` に結果のファイルを書き、Bash で `CLI claim`・`CLI submit` を流す。native Workflow の subagent が Bash で CLI を流せることは確かめてある。
> Codex の runner の worker が `stateDir` のファイルを読めるか・書けるか、CLI を流せるかは確かめていない（流せなければ提出の無い呼び出しとして数えられ、続けば blocked（failure）で止まる）。

```js
Workflow({
  scriptPath: "[SKILL_DIR]/scripts/coverage-audit.js",
  args: <next の args_path のファイルの中身（JSON object）をそのまま>
})
```

args を書き換えない（source が `argsSum` で写し違い・切り詰めを拒否し、`ingest` が `call_id` を照らす）。args には担当が読む文を載せない。目標・受け入れ基準・制約・依頼文・決定の記録・ヒント・回答・前の計画・計画の欠陥・観点の手続きは、`next` が呼び出しごとに `stateDir/snap/` に内容の hash の名前で書く束（brief）に入り、対象の本文・計画役に渡す対象の索引・束ね役に渡す指摘の全件と既にある横展開の観点の一覧（id・型・根本原因）も同じく写しに入る。args に載るのは、写しのファイル・行の範囲・hash と、id・件数・役の設定・`callId`・`argsSum` だけで（写しは置き場 `snapDir` からのファイル名、資産・枡の id と path は対象の共通の基準 `targetBase` からの相対で、2 つの基準は 1 回だけ載る）、担当は Read で束と自分の範囲だけを読む。`ingest` は args の hash と写し（束を含む）の hash が違えば台帳を変えずに拒否する。review の args には枡の一覧を載せず、worker の行と `call_seq`（取り込みと取りの戻しで進む通し番号）だけを載せる。1 回の呼び出しの起動数は worker の行の数（`2 × k × workers`）で、`config --workers` が `meta.limits.maxAgents` に収める。読み切れなかった枡は次の呼び出しに回る。

## 止まったとき

`next` の `stop` ごとに、利用者へ返すもの。どの停止でも `CLI status --state <stateDir>` の結果（カバレッジ・開示した枡・計画が除いた資産・確かめた指摘・検証不能・束・出来事・観点の外の気づき・役ごとの起動数・較正）を添え、「問題なし」とは書かない。status の上の階層の指摘・束・出来事と、止める判断（`upper`・`upper_groups`・`unverifiable`）は今の段のものだけで、出ていった段の節は `phases` に残る。

| stop | 返すもの | 続け方 |
|---|---|---|
| complete | 確かめた指摘（層・引用つき）、開示した枡（`disclosed`）とその理由、指摘の無い枡は読んだだけで検証役を通っていないこと（`coverage.settled_no_findings`）、盲点が相関しうることの開示 | 対象が変わったら同じ台帳で `next`（変わった枡だけ読み直し、新しい周で振り返りと束ねを通す） |
| needs_input | `reasons` と、決めること（`questions`・`upper`・`upper_groups`・`unverifiable`・`lateral_groups`・`stuck`・`plan_defects`・`goal_gaps`）を判断材料つきで。`goal_gaps` は、どの項目にも受け止められていない成果とその引用。`lateral_groups` は、上限の周で横展開が収束せず展開しなかった新しい型の群（`status` の `groups` で根本原因・層が分かる） | 利用者の回答を `CLI answer --state <stateDir> --id <id> --text "..."` で足して `next`。`upper_groups` は束の id、`lateral_groups` は群の id で、回答した群は展開せずに記録し、全ての群に回答があれば complete になる（展開を続けるなら回答せずに `CLI config --state <stateDir> --max-cycles N` で上限を上げて `next`）。`upper`・`unverifiable` は指摘の id、`stuck` は `attempts:<キー>`（観点の精査が受け付けられないまま上限に達したものは `attempts:lens:<観点の id>`）。`plan_defects` は各件の id（`P<n>`。今の欠陥だけを指せ、台帳に無い id は拒否する）に、直し方や受け入れ方を答える。質問と `P<n>` への回答は利用者の言葉として決定の記録に足し、その行を引用する制約になり、統合からやり直す（欠陥が残れば、また止まる）。目標・受け入れ基準・制約・決定の記録を直すときは `--id goal`・`criteria`・`constraints`・`decisions` と `--file <直したファイル>`（中身を置き換え、引用を照らし直し、目標の照合からやり直す。照合を通らなければ台帳を変えずに拒否する。coverage-build から渡された台帳では拒否する。coverage-build の台帳で直すと、coverage-build の次の `next` が `reframe_argv` で差し替える） |
| limit | どの上限か（周は持ち越しで超えたときだけ。横展開の収束しない周は needs_input）、ここまでの結果 | 利用者が上限を変えるなら `CLI config --state <stateDir> --max-cycles N` か `--max-agents-total N` の後で `next` |
| blocked | `cause`（input・target・failure）と理由。failure には、review の worker が 1 件も提出しない呼び出しが続いたもの（worker が Bash で CLI を流せない・`stateDir` に書けないなど）を含む | 原因を直して `next`（環境の失敗で増えた試行は戻る） |

上の層（方針・要求）が原因の欠陥・束は、呼ぶ側が直す前に利用者が判断するものとして `needs_input` で返す。下の層の確かめた指摘は `complete` の結果に入り、直すかどうかと直し方は呼ぶ側が決める。

## 役とモデル

役ごとのモデルと effort は `scripts/roles.json`（理由つき）が正本で、`init --roles <file>` で役ごとに上書きできる。値は実測で見直す前提。作った者と確かめる者は別のモデルにする（統合役と観点の検証役、束ね役と反証役 a。反証役 b は a と別のモデル）。同じ盲点で通さないため。観点の精査役は、統合役と別の context で閉じた問いだけに答える。起動した役・指定した model・effort・成否は台帳の `agents`、token は `calls` に残る（runner では token を読めないので null と理由）。記録する model は指定した値で、実際に効いたかは記録から確かめられないので、効いていない前提で起動数の側で費用を抑える。

review の worker の役は、p 回目の読む役の待ち行列が `reader_p`（無ければ `reader_1`）、検証の待ち行列が `verifier_p`（無ければ `verifier`）で、worker はその回の枡だけを取る。`k` を 2 以上にすると、全ての枡を p 回目ごとに重ねて読み、その指摘を同じ回の検証役が確かめる。「検証役は読む役と別のモデル」は、各 p で `reader_p` と `verifier_p` のモデルが違うときだけ成り立つ。既定の表は p=1・2 で違うモデルにしてある。3 回目以上や `--roles` で上書きするときは、各回の組が別のモデルになるように `reader_p`・`verifier_p` を足す。

## 参照

- [references/ledger.md](references/ledger.md): 台帳の構成、段ごとの script と LLM の分け方、写しと ID と持ち越し、止める条件の全表、記録、汎用の設計の型から変えた点。
- 静的な照合の正本: Workflow source（上の callsite の script）の `// <checks>` 区間（CLI も同じ文を読み込む）。その中の `// <goalmap>` 区間（目標・基準・制約の引用と目標の照合）は coverage-build の Workflow source と同じ文。
