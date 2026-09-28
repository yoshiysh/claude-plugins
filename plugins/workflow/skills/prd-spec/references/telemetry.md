# telemetry: スキル実行の実測を記録し、改善候補の選別と対照 run の判定に使う

配布スキル自身を改善の対象にするときの、実測の取り方と使い方。記録と判定は 2 本の script が
持ち、この文書はその呼び出し手順だけを書く。実測を会話ログや記憶から取ると、run の詳細が
session とともに消え、次の改善で同じ抽出を手でやり直すことになる。

## 単位: leg と run

`prd.js` の 1 回の Workflow 呼び出しを **leg** と呼ぶ。1 run（依頼 1 件の完了まで）は、
`needs_answers`（G0 / G0-2 / G1）で区切られた複数 leg に分かれることがある
（`references/workflow-io.md` §3・§4）。

- `record` は 1 leg を 1 レコードとして記録する。`--label` はその leg の識別名、`--run-id`
  （省略時は `--label` と同じ）は同じ run に属する leg をまとめる識別子。1 run の全 leg に
  同じ `--run-id` と同じ `--input-ref` を付けて record する。
- `summary`・`compare`・`goal_selector.py` は `--run-id` ごとに leg を
  `skill_telemetry.aggregate_run()` で集計してから扱う（値の抜き方は `extract()` と
  `aggregate_run()` を正とし、ここには書き写さない）。集計は 2 種類に分かれる。
  - **leg の値の合算**: `SUM_FIELDS` の欄（各 leg は独立した Workflow 実行で、問いの ID も
    leg ごとに異なるため合算してよい）。
  - **終端 leg だけを採る**: `TERMINAL_FIELDS` の欄（`prd.js` の `state` が run を通じて積み上がる
    値なので、合算すると二重に数える）。
  - `holds`・`hold_drafts`・`remaining_blocking`・`carried_blocking` の意味と互いの関係は `references/workflow-io.md` §3 を正とする
    （件数を足し合わせる前に読む）。
  - `integrity` は照合の食い違い、`notices` は照合ではない所見（W に所有表に無いファイルが
    あった、など）で、別の件数として数える。`goal_selector.py` の R4 は `integrity_count`
    だけを見る（所見を混ぜると、毎回の run が照合の食い違いに数えられる）。
  - 終端 leg は `result.next_args` が null の leg（`done`、または再開できない `blocked`）。
    label の辞書順や記録した順序ではなく、この構造で決まる。
  - 終端 leg がちょうど 1 件で、全 leg の `input_ref` が一致している run だけを「完了して
    測定できる run」として扱う。それ以外（0 件・2 件以上・input_ref 不一致）は未完了として
    `summary` に出るが `compare`・`goal_selector` の対象からは外れる。

## 前提

- 対象スキルの実行実測が `~/.claude/skill-telemetry/<skill>/` に 1 run 以上あること。
  無ければ、まず通常運転の run を `python3 [SKILL_DIR]/scripts/skill_telemetry.py record` で
  記録する。実測ゼロでは現状を事実として書けず、完了条件は現状を作る最小の試作から始まる。
- 記録と照合は `input_ref`（同一入力で再実行できる入力一式のパス）で結ぶ。これが無いと
  対照測定が組めない。

## 観測: 改善候補の選別

`python3 [SKILL_DIR]/scripts/goal_selector.py select --skill <対象>` で在庫から候補を選別し、
pending 全件を一括で依頼者に示して、裁定（approved / rejected / done / superseded と理由）を
`decide` で記録する。approved の statement を、そのまま改善の依頼として使う。selector は在庫の
決定的な関数で、候補を発明しない。傾向を目視したいだけなら `skill_telemetry.py summary` を使う。

## 対照 run の判定

control（本体版）と treatment（staging 版）を、同一入力・独立ドラフト・対で発行する。
互いの作業ファイルを共有させない（run 間の相互影響を断つため）。結果は両条件とも
`skill_telemetry.py record` で、同じ `--input-ref` を付けて記録する。判定は散文で読まず、
script に返させる:

```bash
python3 [SKILL_DIR]/scripts/skill_telemetry.py compare --skill <対象> \
  --control <本体版の run_id> --treatment <staging 版の run_id> \
  --criteria-file <run の前に固定した基準ファイル>
```

基準ファイルは `criteria{metric, higher_is_better, threshold}` を持つ JSON で、run の前に
固定し、改変されていないことを呼び出し側が digest で照合する。指標・向き・閾値を CLI に
手で書くと、差分を入れた本人が判定の時点で判定の仕方を選び直せてしまう。

`compare` が exit 2 で判定を返さない条件は `skill_telemetry.py` の `cmd_compare()` docstring
を正とする（ここには書き写さない）。exit 2 は「差が無い」ではなく「測定が成立していない」
なので、判定に進まず対照を組み直す。

## 1 ランの費用と時間

`python3 [SKILL_DIR]/scripts/usage.py --workspace <W> <transcript のディレクトリ>` が、agent ごとのターン数・
入力（cache read と creation）・最初のターンの入力・壁時計、合計、agent が動いていた時間の和、周回ごとの
指摘の件数を出す。何を 1 ランの agent として数えるか（空の transcript と、W を参照しない別案件の transcript を
除く）は script が持つ。数え方を呼ぶ人に任せると、同じランが別の体数で報告され、ラン同士を比べられない。
