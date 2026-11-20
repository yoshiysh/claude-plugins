---
name: coverage-audit
description: >
  与えられた目的と対象（設計・計画・要求・仕様・コード・テストなどのファイル）を網羅的に検査し、
  確かめた指摘と、見ていない所（見られなかったファイル・判定できなかった意図）を台帳に残して返す検査専用の仕組み。読む役はファイルを 1 つずつ取って全文を観点の一覧の全てで読み、
  観点ごとに読んだ証拠を逐語の引用で機械が照らし、全体の段が台帳の事実から作る意図ごとに、指摘の判定・ファイルをまたぐ食い違い・前提・目標の抜けを確かめ、
  別のモデルの確認が足した指摘と落とした指摘を確かめる。確かめた欠陥を根本原因で束ねて型の当たるファイルへ横展開する。台帳は run をまたいで持ち越し、変わったファイルだけを読み直す。
  「修正の前にこの設計・計画を観点ごとに漏れなく検査して」「この実装が目的と仕様を満たすか網羅的に検証して」
  「前回の台帳の続きから、変わった所だけ検査し直して」のような依頼で使う（Use when files must be audited against fixed goals file by file and across files with machine-checked evidence, without fixing them）。
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

- 1 体に任せる量を、1 つの単位の全文か 1 つの意図にする。単位は対象のファイルで、1 体の文脈に収まらない大きさのファイルだけを構造の境目で分ける（境目と上限は references/ledger.md）。読む役は単位を 1 つずつ取り、全文を観点の一覧の全てで読む。他の単位の書き込みは読まない。
- ファイルをまたぐ判断は全体の段が持つ。CLI が台帳の事実（指摘・保証と前提・静的な検査の結果）から次に調べること（意図）を決定的に作り、全体の段の役は意図ごとに根拠と関係する事実だけを台帳から引いて判定する。範囲が大きくても、1 体の入力が全体に膨らまない。
- どこを見たかを台帳に残し、空きを見える形にする。「見た」は自己申告を信じず、観点ごとの答えと逐語の引用を機械が照らす。
- 指摘と検証を分ける。読む役の指摘は全体の段が残すか落とすかを判定し、全体の段が足した指摘と落とした指摘は、全体の段と別のモデルの確認が確かめる（落とす側を厳しくする）。
- 指摘は目標か受け入れ基準（義務）と原因の層に結んだものだけを確定にする。結べない気づきは参考として別に返し、指摘の件数に数えない。
- 静的に決まること（単位の列挙・意図の生成・引用と ID と件数の照合・形式・上限・止める条件）は script が決め、LLM には判断だけを任せる。重要度で単位を絞らない。

独立は Anthropic のモデルどうしで役の枠組みを変えて作るので、盲点の重なりは減りにくい。結果を報告するときはこれを開示する。

## 始める前に決めること

利用者の依頼から次を作り、`stateDir`（作業ツリーの外。例: scratchpad）にファイルで置く。

目標（goal.md・criteria.md・constraints.md）には、検査で利用者が確かめたいことだけを書く。どう確かめるか（観点・手順などの手段の細部）は書かない。手段を目標に混ぜると、目標の照合が細部で揺れて往復するため。観点は計画役が目標と対象から足す。

| ファイル | 中身 |
|---|---|
| request.md | 依頼文（利用者の言葉のまま） |
| decisions.md（任意） | 利用者が会話で決めたこと。利用者の言葉のまま 1 行 1 件で `- ...` |
| goal.md | 検査の目標（何が満たされているかを確かめるのか）。1 行 1 件で `- G1: ...` |
| criteria.md（任意） | 受け入れ基準（対象が満たすべきこと。照らす仕様・規準もここに書く）。1 行 1 件で `- AC1: ...` |
| constraints.md（任意） | 制約（検査の進め方で守ること）。1 行 1 件で `- D1: ...` |
| lenses.json（任意） | 利用者が決めた観点 `[{id, name, procedure}]`。procedure は「何を列挙し、何と照らすか」の手続き。全ての単位に渡す観点は、この観点、仕組みの標準の観点（`scripts/ledger-core.mjs` の `STANDARD_LENSES`。観点を絞らない通読を含む）、計画役の提案を合わせたものになる。呼ぶ側の観点だけでは呼ぶ側の死角を共有するため |

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
- 印のある台帳は振り返りの単位を作らない。出来事は `status` の `events` で返し、coverage-build の探索グラフが受ける（振り返りを 1 か所に寄せるため）。束ねと横展開は検査の一部なので残す。
- 段が変わると `reframe` で目標の冒頭の文・目標・基準・制約・依頼文・決定の記録・観点・対象と段を差し替える（下の「手順」）。

## 手順

CLI は `node [SKILL_DIR]/scripts/ledger-cli.mjs`（以下 `CLI`）。出力は JSON。

1. 台帳を作る。台帳が既にある（続きから・変わった所だけ検査し直す）なら 2 へ。

   ```bash
   CLI init --state <stateDir> --goal goal.md --request request.md \
     --target <file> [--target <file> ...] [--decisions decisions.md] [--criteria criteria.md] [--constraints constraints.md] [--lenses lenses.json] \
     [--max-cycles N] [--max-agents-total N] [--roles roles.json] [--seeds seeds.json] [--link <正規表現>]
   ```

   `--phase <段>`（任意）は呼ぶ側の段の名前で、台帳の `phase` に残り、`status` を段ごとに分ける。`--link <正規表現>`（任意）は対象の中の id の型で、静的な検査が範囲で書いた参照（例: `U1〜U3`）を 1 件ずつに展開し、どのファイルにも無い id を指摘の判定にかける（references/ledger.md の「全体の段」）。

   印（`--goal-checked coverage-build`）と段のある台帳は、段が変わったら init をやり直さずに `reframe` で差し替える。

   ```bash
   CLI reframe --state <stateDir> --goal goal.md --request request.md [--decisions decisions.md] [--criteria criteria.md] [--constraints constraints.md] \
     [--lenses lenses.json] --target <file> [--target <file> ...] --phase <段> [--link <正規表現>]
   ```

   reframe は印を残して枠を差し替える。`--lenses` を渡せば利用者の観点を差し替え、渡さなければ今の利用者の観点を保つ。`--link` も枠の一部で、渡さなければ null に戻る。
   - 同じ段で、手続き（利用者の観点・目標・基準・制約・決定の記録・link）が前と同じなら、出力は `kept: true` になる。全てを読み直しにせず、次の `next` が内容の変わった単位だけを読み直す（止まった後なら新しい回を始める）。
   - それ以外は、出ていく段の `status` の節（指摘・束ね・出来事）を `phase_records` に写してから、計画・回答・横展開の型・束ね・試行を捨て、全ての単位を読み直しにする（中身が同じでも読み直す）。

   起動数の上限は段の始まり（init か、`kept` でない reframe）から、周の上限は今の回の始まりから数える。印の無い台帳・`--phase` の無い reframe・照合を通らない項目・読めない対象は、台帳を変えずに拒否する。

   ファイルの段と横展開は 1 単位に 1 体で、1 回の呼び出しの起動数は読む単位の数を `meta.limits.maxAgents` と残りの起動数の予算に収めた数になる（残りは次の呼び出しで読む）。`CLI config --state <stateDir> --workers N` が変えるのは、全体の段の名寄せ・判定・確認の行の数だけ（既定は `scripts/ledger-core.mjs` の `DEFAULT_CONFIG` の `workers`。`meta.limits.maxAgents` を超える値は拒否する）。

   数の引数は正の整数だけを受け付け、省いた値は `DEFAULT_CONFIG` になる。読めない対象と、引用の照合を通らない項目（`problems`）があれば台帳を作らずに拒否する（直して init をやり直す）。台帳の形が今の形と違えば、init 以外のコマンドが拒否するので、新しい `stateDir` で init からやり直す。出力の `hint` の文を利用者に示す（ヒントは run の途中でも `CLI hint --state <stateDir> --text "..."` で足せ、次の呼び出しの役に届く）。
2. `CLI next --state <stateDir>` を流す。
   - `stop` があれば終わり。「止まったとき」へ。
   - `step` があれば、`estimate_agents`（この呼び出しで起動する役の数）を見てから、下の「Workflow を呼ぶ」で `args_path` の args を 1 回流す。役は Workflow の中で `claim`・`query`・`submit` を Bash で流し、結果を台帳に直接出す。
3. Workflow の返り値をそのまま JSON でファイルに保存し、`CLI ingest --state <stateDir> --call <next の call_id> --result <file>` を流す。native Workflow が tasks に残す出力ファイル（`.output`。返り値を `result` に包んだ形）は、保存し直さずにその path をそのまま `--result` に渡してよい。ingest は呼び出しを閉じるだけで、読むのは起動の記録と token だけ（役の結果は既に台帳にある）。取ったまま提出されなかった担当は試行に数える。この呼び出しで照合に落ちた提出があれば、その理由が出力の `rejected`（`ok` は呼び出しを閉じたことを指す）に載る。
4. 2 に戻る。

`next` は台帳だけから次の 1 手を決める（目標の照合 → 観点の計画〔計画役 2 体 → 統合 → 観点の検証。利用者の観点があるときの提案が試行の上限まで出なければ、出来事 `plan_skipped` を残して読み進める〕→ ファイルの段 → 全体の段〔開いた意図が 0 になるまで〕→ 振り返り → 束ねと反証 → 横展開の新しい型があれば次の周）。開いた呼び出しがある間の `next` は同じ呼び出し（同じ `call_id` と `args_path`）を返すので、Workflow が途中で落ちたら 2 からやり直せばよい。待っている `call_id` と違う `--call` は `ingest` が拒否する。各段の役と照合、意図の種類、確定の条件は references/ledger.md。

## Workflow を呼ぶ

> **透過実行 route**: 現在の tool inventory に native `Workflow` があり、この call が未試行なら
> native を 1 回だけ使う。native が存在しない Codex では `workflow:dynamic-workflow-runner` を
> 内部互換層として使い、ユーザーに runner の指定を求めない。native を試行後に error / timeout /
> invalid result となった場合は runner へ fallback しない（`next` からやり直す）。human gate は無し。caller が所有する
> 前処理は「手順」の 1〜2、成功後処理は 3。runner の verified return 以外で 3 へ進まず、runner 未 install・
> `unsupported_runtime`・`rejected_source`・`workflow_incomplete` はそのまま報告する。
>
> **Codex classification: workspace-write required**（全ての役が `stateDir` に結果のファイルを書くため。host は `workspace.mode: "workspace-write"` を設定する）。runner request の `requirements` と `limits` は source の
> `meta.requirements`・`meta.limits` をそのまま使い、SKILL.md に値を写さない。args の `workers` の各行の model 名に runner の `modelMap` を明示する。
> 役は `stateDir` の入口（`<stateDir>/ledger-cli.mjs`。init と next のたびに CLI が書く）で `claim`・`query`・`submit` を Bash で流し、`stateDir/snap/` の写しを Read で読み、結果のファイルを Write で書く。native Workflow の subagent が Bash で CLI を流せることは確かめてある。
> `stateDir` は作業ツリーの外にあり、Codex の runner の worker がそこを読めるか・書けるか、CLI を流せるかは確かめていない（流せなければ提出の無い呼び出しとして数えられ、続けば blocked（failure）で止まる）。

```js
Workflow({
  scriptPath: "[SKILL_DIR]/scripts/coverage-audit.js",
  args: <next の args_path のファイルの中身（JSON object）をそのまま>
})
```

args は `{state, callId, stage, workers}` だけで、`workers` は役の行 `{id, role, model, effort}`。args を書き換えない。担当が読む文（目標・依頼文・本文・前の役の出力・事実）は args にも prompt にも載らず、役が `claim` と `query` で台帳から引く。役の結果も返り値で運ばず、役が `submit` で台帳に書く。返り値は起動の記録と token（`{agents, tokens}`）だけ。

## 止まったとき

`next` の `stop` の出力には、どの停止でも理由（`reasons`）、開いたままの意図（`open_intents`）、判定できずに開示して閉じた意図（`undecided`）、status のファイルの path（`status_path`）が載る。`status_path`（`<stateDir>/status-<段>.json`。段の無い台帳は `status.json`）の中身は `CLI status --state <stateDir>` の出力と同じで、主な欄は単位ごとの状態（`units`。持ち越した読みは `carried`）・カバレッジ（`coverage`）・見られなかった単位と理由（`skip`）・事実（`facts`）・意図（`intents`）・判定できなかった意図（`undecided`）・確かめた指摘と検証不能（`findings`。確定した指摘は出どころ `provenance` を持つ）・参考（`references`）・束（`groups`）・横展開の型（`lateral_types`）・出来事（`events`）・run の指標（`metrics`・`run_records`）・開いた呼び出し（`pending`）。これを添えて返し、「問題なし」とは書かない。上の階層の指摘・束・出来事と止める判断（`upper`・`upper_groups`・`unverifiable`）は今の段のものだけで、出ていった段の節は `phases` に残る。

| stop | 返すもの | 続け方 |
|---|---|---|
| complete | 確かめた指摘（結ぶ目標か基準・原因の層・path・引用つき）、参考、見られなかった単位（`skip`）とその理由、判定できなかった意図（`undecided`）とその理由、盲点が相関しうることの開示 | 対象が変わったら同じ台帳で `next`（変わった単位だけ読み直し、関係する意図を開き直し、新しい周で振り返りと束ねを通す） |
| needs_input | `reasons` と、決めること（`questions`・`upper`・`upper_groups`・`unverifiable`・`lateral_groups`・`stuck`・`plan_defects`・`goal_gaps`）を判断材料つきで。`goal_gaps` は、どの項目にも受け止められていない成果とその引用。`lateral_groups` は、上限の周で横展開が収束せず展開しなかった新しい型の群（`status` の `groups` で根本原因・層が分かる） | 利用者の回答を `CLI answer --state <stateDir> --id <id> --text "..."` で足して `next`。`upper_groups` は束の id、`lateral_groups` は群の id で、回答した群は展開せずに記録し、全ての群に回答があれば complete になる（展開を続けるなら回答せずに `CLI config --state <stateDir> --max-cycles N` で上限を上げて `next`）。`upper`・`unverifiable` は指摘の id、`stuck` は `attempts:<キー>`（キーは `goal`・`plan`・`unit:<観点の id>`）。`plan_defects` は各件の id（`P<n>`。今の欠陥だけを指せ、台帳に無い id は拒否する）に、直し方や受け入れ方を答える。質問と `P<n>` への回答は利用者の言葉として決定の記録に足し、その行を引用する制約になり、統合からやり直す（欠陥が残れば、また止まる）。目標・受け入れ基準・制約・決定の記録を直すときは `--id goal`・`criteria`・`constraints`・`decisions` と `--file <直したファイル>`（中身を置き換え、引用を照らし直し、目標の照合からやり直す。照合を通らなければ台帳を変えずに拒否する。coverage-build から渡された台帳では拒否する。coverage-build の台帳で直すと、coverage-build の次の `next` が `reframe_argv` で差し替える） |
| limit | どの上限か（周は持ち越しで超えたときだけ。横展開の収束しない周は needs_input）、ここまでの結果と開いたままの意図 | 利用者が上限を変えるなら `CLI config --state <stateDir> --max-cycles N` か `--max-agents-total N` の後で `next` |
| blocked | `cause`（input・target・failure）と理由。failure には、役が 1 件も提出しない・claim しない呼び出しが続いたもの（役が Bash で CLI を流せない・`stateDir` に書けないなど）を含む | 原因を直して `next`（環境の失敗で増えた試行は戻る） |

試行の上限で判定できなかった意図は止める理由にせず、`undecided` で開示して complete まで進む。上の層（方針・要求）が原因の欠陥・束は、呼ぶ側が直す前に利用者が判断するものとして `needs_input` で返す。下の層の確かめた指摘は `complete` の結果に入り、直すかどうかと直し方は呼ぶ側が決める。

## 役とモデル

役の名前、モデルと effort の組、その理由は `scripts/roles.json` が正本で、`init --roles <file>` で役ごとに上書きできる。値は実測で見直す前提。作った者と確かめる者は別のモデルにする（観点を作る者と観点の検証役、全体の段と確認、束ね役と反証役、2 体の反証役どうし）。同じ盲点で通さないため。上書きするときもこの組を崩さない。起動した役・指定した model・effort・成否は台帳の `agents`、token は `calls` に残る（runner では token を読めないので null と理由）。記録する model は指定した値で、実際に効いたかは記録から確かめられないので、効いていない前提で起動数の側で費用を抑える。

## 参照

- [references/ledger.md](references/ledger.md): 台帳の構成、呼び出しと役の読み書き、段ごとの script と LLM の分け方、単位と観点と持ち越し、全体の段の意図と確定の条件、止める条件の全表、記録、汎用の設計の型から変えた点。
- 静的な照合の正本: Workflow source（上の callsite の script）の `// <checks>` 区間（CLI も同じ文を読み込む）。その中の `// <goalmap>` 区間（目標・基準・制約の引用と目標の照合）は coverage-build の Workflow source と同じ文。ファイルの段の結果と意図の判定の照合は `scripts/ledger-core.mjs`・`scripts/ledger-cli.mjs` が持つ。
