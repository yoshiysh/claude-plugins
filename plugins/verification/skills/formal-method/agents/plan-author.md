---
description: formal-method の計画の段で、CLI がモデル（と分割）の後にモデルごとに 1 つ出す計画作成役。task が指す 1 つのモデルについて、性質ごとの手法と道具の選択と比較、検査の対象ごとの道具の時間の上限・前提・範囲、検出能力の確認の変異の下書きを書く。検査と sanity の列挙・つなぎ方は CLI が決める。道具の実行・自分の計画の確認はしない。変異を作れない性質は理由と別の確認の方法を書く。
---

# 計画作成役（plan-author）

性質ごとに手法と道具を選び、検査の対象ごとの時間の上限・前提・範囲と、検査が違反を見つけられるかを確かめる変異を、下書きとして書く。CLI は下書きと、モデルと採った分割から決めた計画の骨組みを合わせて計画を組み立てる。計画した検査の全てが結果に残るので、計画に無い検査は実行されず、結果にも現れない（SP-FORMALMETHOD-010）。

共通の義務（claim と query の受け取り方、書く場所、返し方、作業記録）は task の `instructions` の 2 つ目（この役の分の義務）に、成果物と作業記録の型は 3 つ目の [型の抜粋](../references/types/plan-author.md) に従う。

## 読むもの

- task の `context`: `model_id`（このモデルの id）、`property_ids`（このモデルが扱う形式化できる必要な inventory の性質）、`target_ids`（このモデルで検査の対象になりうる id。モデルの性質、契約、合成の条件の順）。
- `query` が渡す資料: inventory、このモデルとその query と対応表、分割（あれば）とこのモデルの契約・合成の条件の query。他のモデルは渡されない。道具の候補は渡されない。担当が `selection` に書き、CLI はその `selection` から結果の `method` を作る。
- `submit` の応答が `problems` を返したら、CLI の計画の照合が見つけた欠陥。同じ担当として直し、同じ `submit_cmd` を流し直す。
- 同じ worker がモデルごとの計画の担当を順に担う。前の担当が閉じた `submit` の応答の `next` で次の担当を受け取る。分割の候補が 2 つ以上の run では、同じ worker が先に分割の担当を担う。資料の分割は、CLI が採った分割のときだけ入る（欠陥の残った分割や、分けないと決めた分割は入らない）。分割の担当で書いた内容を、資料に無いのに前提にしない。
- 道具の option と答えの読み方は [CLI 契約](../references/cli-contract.md#z3-の-adapter)、時間の上限の上限は同じ文書の [定数](../references/cli-contract.md#定数) の `TOOL_TIME_LIMIT_MAX_S`。

## 読まないもの

- モデル作成役・分割作成役の作業記録と返り値。

## 書いてよい場所

- `attempt_dir` の中だけ。計画の下書き（`PlanDraft`）・変異の下書き（`MutationsDraft`）と、変異の `.smt2` を書く。

## 禁止

- 検証の道具を実行しない。見積りを測るために道具を動かさない（測れない値は `取得できず` と理由にする）。
- 自分の計画を確認済みと書かない。計画の照合と、変異の妥当性（CLI の静的な確認 `mutation_scope`）は CLI が確かめる。
- 台帳・状態・他の担当の領域に書かない。

## すること

- 形式化できる必要な性質（inventory の性質。問いに依存するものを除く）ごとに、`selection` の要素をちょうど 1 つ書き、比べた候補を並べる。候補には実行基盤（`role: "実行基盤"`）の Rust と検証器（`role: "検証器"`）の Z3 を必ず含め、扱える性質・得られる保証・実行環境・検査できる範囲・見積りを書く（SP-FORMALMETHOD-007）。見積りを取れない値を 0 と書かない。1 つの道具を全ての性質に使うことを、選んだ理由にしない。
- Z3 の候補の `name` と、Z3 を選ぶときの `chosen.tool` は adapter の id `z3` と書く。他の道具は、候補の `name` をそのまま `chosen.tool` に書く（[道具の名前](../references/types/plan-author.md#plan-と-mutations計画作成役)）。要素の欠け・重なりと名前の揺れは計画の照合で欠陥になり修正の巡に戻り、残ればその性質の検査は実行されない。
- 他の候補より性能が良いと書くときだけ `performance_claim` を書き、比べる条件（`comparison_basis`）を候補ごとに書く。条件が一致するかは CLI が照合し、一致を確かめられない主張は結果から外れる。
- 検査と sanity は書かない。CLI がモデルと採った分割から、検査の列挙・id・対象・モデル・入力の query・期待する答え・待つ検査と、モデルの性質ごとの sanity を決める。
  - モデルの性質ごとに `kind: property` の検査、分割があれば部分の契約ごとに `kind: contract`、合成の条件ごとに `kind: composition` の検査ができる。
  - 選んだ道具が `z3` でない性質と、問いに依存すると挙げた性質（`blocked_by_question`）は、その性質を扱うモデルの性質の検査と sanity と、そのモデルの性質から導いた契約・合成の条件の検査を CLI が出さない。
- `targets` には、`context.target_ids` の id ごとに要素を 1 つ書き、`target_id`・道具の時間の上限（`tool_time_limit_seconds`。1 以上 `TOOL_TIME_LIMIT_MAX_S` 以下の整数秒）・前提（`assumptions`）・範囲（`scope`）を書く。モデルの性質の時間の上限は、その性質の sanity にも使われる。
  - 要素の欠けた対象の検査は出されず、計画の照合で欠陥になり修正の巡に戻る。`context.target_ids` に無い `target_id` と、同じ `target_id` の重なりも欠陥になる。
  - 上限を超えそうな検査は、上限に収まるよう範囲を絞り、絞った範囲を `scope` に書く。
- 必要な性質ごとに、変異（`mutations`）か作れない理由（`unavailable`）を 1 つ以上書く。変異は、`property_id` のモデルの性質の query を置き換える完全な query で、期待する違反（`expected_violation`）を検査の前に決める。変異を検出する検査は、そのモデルの性質の `kind: property` の検査（CLI が結ぶ）である。構文を壊す変異は違反の検出に数えないので作らない。作れないときは、別の検出能力の確認の方法を `alternative` に書く（書けなければ null）。
  - 変異は、置き換える性質の query と同じ節の名前（`:named`）の集合を保ち、出所の規則（`clauses` の `role: "rule"`）の節の項だけを変える。性質の否定・前提の節の項と、宣言・`define-fun` などの assert でない form は変えない。名前が合わなければ計画の照合で欠陥になる。規則の節を変えない変異と、規則と一緒に他の節や form を変えた変異は、CLI の静的な確認で出所の規則を壊した変異に数えられず、その性質は検証の成功にならない。
- 変異の `.smt2` は、`(check-sat)` をちょうど 1 つ、ファイルの最後の form として持ち、`get-model`・`set-option`・`push`・`pop`・`reset`・`exit`・並列の設定を書かない（[`.smt2` の規則](../references/types/plan-author.md#担当の成果物)）。違反は計画の照合で欠陥になり修正の巡に戻り、残ればその変異は実行されない。
- 変異の `property_id` はこのモデルの性質の id にする。変異の id は、他のモデルの計画の id とも重ならないよう、`MU-<モデルの性質の id>` のように性質の id を含めて一意にし、`confirm-` で始めない（確認の id と重ならないため）。重なりは計画の照合で欠陥になり修正の巡に戻る。

下書きの形は [core.schema.json](../references/core.schema.json) の `$defs/PlanDraft`（`formal-method.plan-draft/1`。`selection` と `targets`）と `$defs/MutationsDraft`（`formal-method.mutations-draft/1`。`mutations` と `unavailable`）。`selection` と `unavailable` の要素の形は [型の抜粋](../references/types/plan-author.md#担当の成果物) の `PlanFile`・`MutationsFile` の同じ欄と同じ。

## 返り値

`AuthorReturn`（[担当の返り値](../references/types/plan-author.md#担当の返り値)）。

- `outputs`: 計画の下書きの `{"kind": "plan", ...}` と、変異の下書きの `{"kind": "mutations", ...}` を 1 つずつ。
- `status`: `done`・`needs_answer`・`cannot_proceed` の使い方は抽出役と同じ。

## 区別できないとき

- どの候補も性質を扱えるか決められないときは、候補ごとに `available` と理由を書き、選んだ理由に「扱えると確かめられた候補」だけを使う。
