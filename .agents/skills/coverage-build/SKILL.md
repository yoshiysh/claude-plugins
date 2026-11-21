---
name: coverage-build
description: >
  文書でもプログラムでも、作る（create）・既にあるものを目標に合わせて直す（update）・作らずに目標に照らして確かめる（review）作業を、
  目標の固定 →（update は現状の検査）→ 設計 → 設計レビュー → 実装 → 実装レビューの段で回し、見落としを構造で減らす汎用の仕組み。
  役は台帳から担当を取って結果を台帳に出し、1 体には文脈に収まる分の単位を詰め、テストは実装と別の担当が先に書き、レビューは coverage-audit を呼び、悪かった出来事を探索グラフで振り返って
  欠陥を原因の層（目標・設計・実装）へ戻す（指摘の箇所だけを直す経路は持たない）。台帳は run をまたいで持ち越し、変わったものだけを見直す。
  「この機能を設計からレビューまで通して作って」「このスキルを目標に合わせて直して（文書とコードが混ざってよい）」
  「この実装が目標を満たすか確かめて、直すならどの層からかを返して」のような依頼で使う
  （Use when building or updating documents or code through goal, design, design review, implementation, and implementation review with layer-routed rework）。
  対象外: 目標に照らした網羅的な検査だけで振り返りも要らないもの（coverage-audit）、1 体で 1 回で済む小さな変更、このリポジトリの差分・PR のレビュー（repo-review）。
---

# Coverage build

## 目次

- [目的](#目的)
- [mode と段](#mode-と段)
- [始める前に決めること](#始める前に決めること)
- [手順](#手順)
- [Workflow を呼ぶ](#workflow-を呼ぶ)
- [coverage-audit を呼ぶ](#coverage-audit-を呼ぶ)
- [止まったとき](#止まったとき)
- [役とモデル](#役とモデル)
- [参照](#参照)

## 目的

同じ全体を 1 体が書き、別の 1 体が全体を見て、毎回別の欠陥が出る改稿の往復を、構造で止める。そのために次の形を取る。

- 単位を小さくする。設計は方式設計（単位への分割）と単位ごとの詳細設計に分け、実装も単位ごとに担当を分ける。1 体は文脈に収まる分の単位の担当を続けて受け持つ（起動ごとの前置きの費用を体数分払わない）。
- 生成と検証を分ける。レビューは同じ repo のスキル coverage-audit が行い、プログラムの単位ではテストを実装とは別の担当が先に書く。
- 欠陥は原因の層へ戻す。設計の欠陥は単位（と依存する単位）を設計からやり直し、実装の欠陥は単位の実装をやり直す。目標・方針の層の欠陥は人間に返す。指摘の箇所だけを局所で直す経路は無い。
- 静的に決まること（単位の検査・依存の順・ファイルの持ち主・照合・やり直し・次に起動する役・上限・止める条件）は CLI が決め、LLM には判断だけを任せる。重要度で単位を絞らない。
- 台帳を全ての役が読み書きする唯一の場所にする。役は CLI の `claim` で担当を取り、`query` で入力（前の役の出力を含む）を引き、`submit` で結果を出す。照合に落ちた結果は `submit` が理由を付けて拒み、同じ体が直して出し直す（やり直しに新しい agent を起こさない）。

司令塔（このスキルを読む session）は段を選び、出力を手を加えずに次へ渡すだけで、成果物を書かない。対象のファイルを書くのは実装の役（テストの担当・実装の担当）だけ。

## mode と段

| 段 | create | update | review | 担い手 |
|---|---|---|---|---|
| 目標の固定 | ○ | ○ | ○ | 司令塔が入力のファイルを作り、init が引用を照らし、目標の照合役が成果を項目に対応づける（照合はこのスキルだけが行い、coverage-audit には照合済みとして渡す） |
| 現状の検査 | - | ○（目標・方針の層の指摘が出たら設計に進まず人間に返す） | ○（これが本体） | coverage-audit |
| 設計 | ○ | ○（現状の検査の指摘と開示した単位を入力にする） | - | 方式設計の役 → 単位ごとの詳細設計の役 |
| 設計レビュー | ○ | ○ | - | coverage-audit |
| 実装 | ○ | ○ | - | テストの担当（code の単位、先に）→ 実装の担当（依存の順） |
| check | 指定があれば | 指定があれば | - | CLI（利用者が init で固定した argv だけを実行） |
| 実装レビュー | ○ | ○ | - | coverage-audit |
| 振り返り | レビューか check の後ごと | 同じ | レビューの後 | 探索グラフ（計画役 → 実行役 → 検証役）、層への戻しは CLI |

review は直さず、出来事ごとに戻す先の層を報告して終わる。

## 始める前に決めること

利用者の依頼から次を作り、作業ツリーの外（例: scratchpad）にファイルで置く。台帳の置き場 `stateDir` も作業ツリーの外にする。

目標には利用者が達成したいことだけを書く。どう達成するか（手段・確かめ方の細部。例: 既存のテストと同じ基準以下にする）は書かない。それは設計の段で決め、設計レビューで目標に照らす。

| ファイル・引数 | 中身 |
|---|---|
| request.md | 依頼文（利用者の言葉のまま） |
| decisions.md（任意） | 利用者が会話で決めたこと。利用者の言葉のまま 1 行 1 件で `- ...` |
| goal.md | 目標。1 行 1 件で `- G1: ...` |
| criteria.md（任意） | 受け入れ基準。1 行 1 件で `- AC1: ...` |
| constraints.md（任意） | 制約。1 行 1 件で `- D1: ...` |
| `--input`（複数可） | 読む材料。方式設計の役は全てについて、読んだ証拠の引用か読まない理由を返す |
| `--target`（update・review。複数可） | 既にある対象のファイル |
| `--check`（任意・複数可） | 実装の後に流す check の argv の JSON 配列（例 `'["node","--test","x.test.mjs"]'`）。shell を通さず、cwd は `--repo` |

goal.md・criteria.md・constraints.md の各行の末尾に、request.md か decisions.md からの逐語の引用を `〔request: …〕` か `〔decisions: …〕` で 1 つ以上付ける。引用は 12 字以上にする（decisions.md の 1 行の全体、または request.md の空でない 1 行の全体〔前後の空白を除く〕を引くときは短くてよい）。引用の中に `〔` `〕` は書けない。`- ` で始まらない行（見出しと空行を除く）、引用の無い項目、引用元に逐語で無い引用は init が拒否する。指示語は固有名に置き換える。

| ファイル | 例（1 行が 1 件） |
|---|---|
| request.md | `値を計算する関数を作り、使い方を書いてほしい` |
| decisions.md | `- 入力が 1 なら 2 を返す`<br>`- 依存を足さない` |
| goal.md | `- G1: 値を計算する関数と、その使い方の文書 〔request: 値を計算する関数を作り、使い方を書いてほしい〕` |
| criteria.md | `- AC1: 入力が 1 なら 2 を返す 〔decisions: 入力が 1 なら 2 を返す〕` |
| constraints.md | `- D1: 依存を足さない 〔decisions: 依存を足さない〕` |

## 手順

CLI は `node [SKILL_DIR]/scripts/build-cli.mjs`（以下 `CLI`）。出力は JSON。

1. 台帳を作る。台帳が既にある（続きから・対象が変わった後の見直し）なら 2 へ。

   ```bash
   CLI init --state <stateDir> --mode create|update|review --repo <作業ツリーの絶対パス> --goal goal.md --request request.md \
     [--decisions decisions.md] [--criteria criteria.md] [--constraints constraints.md] [--input <file> ...] [--target <file> ...] [--check '<argv JSON>' ...] \
     [--roles roles.json] [--max-cycles N] [--max-agents-total N] [--max-unit-rounds N]
   ```

   数の引数は正の整数だけを受け付け、省いた値は `scripts/build-core.mjs` の `DEFAULT_CONFIG`。読めないファイルと、引用の照合を通らない項目（`problems`）があれば台帳を作らずに拒否する。出力の `hint` の文を利用者に示す（ヒントは run の途中でも `CLI hint --state <stateDir> --text "..."` で足せ、次の呼び出しの役の query に入る）。
2. `CLI next --state <stateDir>` を流し、出力に従う。

   | 出力 | 司令塔の処理 |
   |---|---|
   | `stop` | 「止まったとき」へ |
   | `step` が design・retro・tests・implement | `estimate_agents` を見てから、「Workflow を呼ぶ」で `workflow` の source に `args_path` の args を 1 回流し、返り値をそのまま JSON でファイルに保存して `CLI ingest --state <stateDir> --call <call_id> --result <file>`（呼び出しを閉じるだけ。役の結果は役が `submit` で台帳に出してある。拒んだ提出があれば理由が出力の `rejected` に載る） |
   | `step: audit` | 「coverage-audit を呼ぶ」に従い、`CLI import-audit --state <stateDir>` |
   | `step: checks` | `CLI run-checks --state <stateDir>` を background で流し、終わるまで待つ（途中で止めると記録が残らない） |

3. 2 に戻る。

最初の design の呼び出しで、目標の照合役が依頼文と決定の記録から利用者の求める成果を引用つきで挙げ、各成果を受け止める項目の id を返す。CLI が引用の実在・id の実在を照らし、どの項目にも受け止められていない成果があれば `needs_input` で返す。照合役は、項目が依頼に無いものを足したか・範囲を狭めたかを判定しない（足していないことは init の引用の照合が確かめる）。

`next` は台帳と今のファイルの hash だけから次の 1 手と、起動する役（args の `workers` の行）を決める。design は目標の照合 → 方式設計 → 詳細設計を別の呼び出しにする（前の役の出力を読む役は次の呼び出しに置く）。振り返りは計画役 → 実行役 → 検証役を別の呼び出しにし、検証役は実行役が支持した結論があるときだけ起動する。振り返りの結論を層へ戻す段は agent を起動しないので、`next` の中で済む。呼び出しが開いている間に `next` を流し直すと同じ呼び出し（同じ `call_id`）が返り、閉じるのは `ingest --call` だけなので、Workflow が途中で落ちたら同じ args で流し直してから閉じればよい（出し終えた担当は台帳に残る）。開いていない `--call` は `ingest`・`claim`・`submit` が拒否する。

## Workflow を呼ぶ

どの段も同じ 1 つの source（`build-step.js`）を流す。役は全て、担当の結果を stateDir の `result_path` に書いて `submit` を流すので、書かない run を分ける理由が無い。テストの担当・実装の担当だけが repo のファイルを書く。CLI は呼び出しを開いた時と後の hash で、受け持ちの外（書かない段では単位のファイル・入力・対象の全て）の変更を照らし、出来事に残す。書く段では、その変更がある提出と呼び出しで受理した単位を受け付けない。

> **透過実行 route**: 現在の tool inventory に native `Workflow` があり、この call が未試行なら
> native を 1 回だけ使う。native が存在しない Codex では `workflow:dynamic-workflow-runner` を
> 内部互換層として使い、ユーザーに runner の指定を求めない。native を試行後に error / timeout /
> invalid result となった場合は runner へ fallback しない（`next` からやり直す）。human gate は無し。caller が所有する
> 前処理は「手順」の 1〜2、成功後処理は `ingest`。runner の verified return 以外で `ingest` へ進まず、runner 未 install・
> `unsupported_runtime`・`rejected_source`・`workflow_incomplete` はそのまま報告する。
>
> **Codex classification: workspace-write required**（`build-step.js`。host は worker の `cwd` を `--repo` にし、
> `workspace.mode: "workspace-write"` を設定する）。runner request の `requirements` と `limits` は source の `meta.requirements`・`meta.limits` をそのまま使い、
> SKILL.md に値を写さない。args の `workers` にある model 名の全てに runner の `modelMap` を明示する。役は Bash で `stateDir` の CLI を流し、`stateDir` の `result_path` を書く。
> Codex の runner の worker が、`--repo` の外にある `stateDir` で CLI を流して `result_path` を書けるかは確かめていない。

```js
Workflow({
  scriptPath: "[SKILL_DIR]/scripts/build-step.js",
  args: <next の args_path のファイルの中身（JSON object）をそのまま>
})
```

args は `{state, callId, stage, workers}` だけで、本文も id の一覧も載らない。script は `workers` の行ごとに役を 1 体起動し、役の prompt には担当を取る命令（`stateDir/build-cli.mjs` の `claim`）と手順・役の指示・結果の形だけを置く。役の入力（目標・依頼文・入力の path・前の役の出力）は役が `query` で台帳から引く。返り値は起動の記録（`agents`）と `tokens` だけで、司令塔はそれを保存して `ingest --call` に渡す。native Workflow が tasks の `.output` に残す返り値（`result` に包んだ形）も、そのまま `ingest` に渡してよい。

## coverage-audit を呼ぶ

現状の検査・設計レビュー・実装レビュー・review の検査は、同じ repo のスキル coverage-audit を**スキル呼び出し**で使う（このスキルの CLI から coverage-audit のファイルを読んだり実行したりしない）。coverage-audit の台帳は `stateDir/audit/state` の 1 つに固定し、段ごとに作り直さない。`next` の `audit` には、台帳の置き場 `state` と、その段のファイル（`goal`・`request`・`decisions`・`criteria`・`constraints`）と `targets` が載り、引数は `init_argv`（台帳が無いとき）か `reframe_argv`（あるとき）の一方だけが載る。これらは CLI が書いたもので、司令塔は言い換えずにそのまま渡す。受け入れ基準（実装レビューでは単位ごとの受け入れ `U<n>A<m>` を含む）は制約と別の `criteria` で渡る。基準・制約が 0 件なら `criteria`・`constraints` とその引数は載らない。どちらの引数も段（`--phase`。baseline・design・impl・review）を含み、design の段の引数だけが関係する資産を結ぶ id の型（`--link`）を含む。`init_argv` は照合済みの印 `--goal-checked coverage-build` を含み、coverage-audit は目標の照合を流さない。`reframe_argv` は台帳の印を残したまま目標・基準・制約・決定の記録・対象と段を差し替え、coverage-audit は全ての単位を読み直して計画から作り直す。

1. `audit.init_argv` か `audit.reframe_argv` を coverage-audit の CLI にそのまま渡す。どちらも無く `audit.framed` が true なら、この段の台帳に既にしてあるので何も渡さない（検査の途中で `next` を流し直したとき。reframe し直すと途中の検査と coverage-audit の answer で足した `A<n>` が消える）。answer で制約が足されたときや単位ごとの受け入れが変わったときは入力が変わるので、同じ台帳の `reframe_argv` が載る。
2. coverage-audit の手順を、その `next` が止まるまで回す。coverage-audit が needs_input で止まったときは、上の層の指摘・検証不能（`upper`・`upper_groups`・`unverifiable`）だけなら回答せずに 3 へ進む（このスキルが層への戻しと人間への返し方を決める）。それ以外（質問・試行の上限）は、回答せずに進まず、coverage-audit の「止まったとき」に従って利用者に返す。
3. `CLI import-audit --state <stateDir>` を流す。coverage-audit は止まったときに `<audit.state>/status-<段>.json`（中身は coverage-audit の `status` の出力と同じ）を書き、`import-audit` はそのファイルを自分で読む。司令塔は `status` の出力を写さない。ファイルが無ければ（coverage-audit が止まる前）、その path を理由に拒否する。

`import-audit` は、検査が終わっていない（読み終えていない単位がある・blocked・limit）出力、待っている段と違う段の出力（`status.phase`）、検査に渡した後に対象が変わった出力を拒否する。coverage-audit の status は段ごとに分かれ、上の階層の指摘・束ね・出来事は今の段のものだけなので、取り込むのはその段の分だけ。coverage-audit はこの印のある台帳では振り返りを流さず、検査の中の出来事を status の `events` で返す。取り込みはそれを進め方の出来事（`audit_internal`）として 1 回だけ受け、このスキルの振り返りの探索グラフが受ける。確かめた指摘の引用を今の本文に照らし、指摘を単位と層へ結ぶ（指摘の path は `paths` の先頭で、引用はその本文にある。現状の検査の指摘は設計の入力にし、目標・方針の層だけを人間に返す）。参考（目標・受け入れ基準に結べない気づき）は指摘にせず `audits.<段>.references` に残す。試行の上限で判定できずに閉じた意図を含む complete も取り込み、その意図を進め方の出来事にする。見られなかった単位は見ていないものとして記録し、見たとして扱わない。coverage-audit の run の指標（指摘の出どころ・持ち越した読みの数・全体の段で落とした数と確認で復活した数）は `audits.<段>.metrics` に残る。

## 止まったとき

どの停止でも `CLI status --state <stateDir>` の結果（単位ごとの状態・レビューごとの指摘と見ていない単位・check・戻した層・受理した原因・進め方の気づき・役ごとの起動数）を添え、「問題なし」とは書かない。

| stop | 返すもの | 続け方 |
|---|---|---|
| complete | create・update: 単位ごとの成果物の path、レビューで見ていない単位（`audits.*.not_seen`）、check の結果、進め方の気づき（`notes`）。review: 出来事ごとに戻す先の層（`routes`）。盲点が相関しうること（どの役も Anthropic のモデル） | 対象が変わったら同じ台帳で `next`（変わったものだけを見直す） |
| needs_input | `reasons` と、決めること（`human`・`questions`・`stuck`・`goal_gaps`）を判断材料つきで。`goal_gaps` は、どの項目にも受け止められていない成果とその引用 | 利用者の判断を `CLI answer --state <stateDir> --id <id> --text "..."`（回答を利用者の言葉として決定の記録に足し、その行を引用する制約にして、方式設計からやり直す）か `CLI dismiss ...`（直さない判断を記録するだけ）で足して `next`。目標・受け入れ基準・制約・決定の記録を直すときは `--id goal`・`criteria`・`constraints`・`decisions` と `--file <直したファイル>`（中身を置き換え、引用を照らし直し、目標の照合からやり直す。照合を通らなければ台帳を変えずに拒否する）。`stuck` は `--id attempts:<キー>`、やり直しの上限は `human` に出る `--id rounds:<単位>#<周>`（超えた回ごとに別の id）。周の上限は `human` に出る `--id cycles#<周>`（`text` が待っているやり直し。answer・dismiss の扱いは references/ledger.md の「止める条件」） |
| limit | 起動数の上限、ここまでの結果（周の上限は needs_input の `cycles#<周>`） | 利用者が上限を変えるなら `CLI config --state <stateDir> --max-agents-total N`（か `--max-cycles`・`--max-unit-rounds`。周の上限を上げても、保留したやり直しは `cycles#<周>` に答えるまで当たらない）の後で `next` |
| blocked | `cause`（input・failure）と理由 | 原因を直して `next` |

## 役とモデル

役ごとのモデルと effort は `scripts/roles.json`（理由つき）が正本で、`init --roles <file>` で役ごとに上書きできる。値は実測で見直す前提。上位のモデルの役は中程度の effort にする。テストを書く役と実装する役、振り返りの実行役と検証役は、別のモデル・別の体にする。

1 体に詰める単位の量は、単位が読むファイルの本文のバイト数で決める（上限は `scripts/build-core.mjs` の `UNIT_MAX_BYTES` の 1 つ）。詳細設計・テスト・実装の役は単位の並びで前から上限まで 1 体に詰め、収まらない分だけ体数を増やす。実装の担当は依存がそろった単位だけを受け取り、前の単位を出した後に次の単位を取り直す。振り返りの実行役と検証役は、それぞれ 1 体が全ての意図を順に処理する。照合に落ちた提出は同じ体が出し直し、試行の上限（`MAX_ATTEMPTS`）に達した単位の担当は `stuck` として needs_input で開示する（振り返りの意図は、判定できずに開示して閉じた状態 `undecided` にして振り返りを進める。退けた意図とは区別する）。試行に数えるのは、役が query か submit で手を付けた担当だけ。起動した役・指定した model・effort・成否は台帳の `agents`、token は `calls` に残る（runner では token を読めないので null と理由）。記録する model は指定した値で、実際に効いたかは記録から確かめられないので、効いていない前提で起動数の側で費用を抑える。

## 参照

- [references/ledger.md](references/ledger.md): 台帳の構成、段ごとの script と LLM の分け方、層への戻し方、振り返りの探索グラフ、coverage-audit との口、止める条件、記録、設計の型から変えた点、照合しないもの。
- [references/writing.md](references/writing.md): 文書を書くときの規則（表・図・散文の使い分け）。文書の単位の担当が読む。
- 静的な照合と役の結果の形の正本: `scripts/build-step.js` の `// <checks>` 区間（CLI の `submit` も同じ文を読み込む）。その中の `// <goalmap>` 区間（目標・基準・制約の引用と目標の照合）は coverage-audit の Workflow source と同じ文。
