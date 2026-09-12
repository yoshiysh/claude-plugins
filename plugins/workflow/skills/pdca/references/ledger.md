# run ledger（追記型台帳）

1 run に 1 本、`workspace/<run-id>/ledger.jsonl` を置く。Plan の改稿・verifier の findings・
棄却案と棄却理由・司令塔の自己解決裁定・Do/Check/Act の結果が**起きた順**に並ぶ。

## 何のためにあるか

agent は毎回 fresh context で立つので、前の agent が何を裁定したかを持っていない。
その結果、(1) 一度潰した論点が次の周で無かったことになる、(2) 逆に決着済みの論点が
再提起され、同じ議論を予算を使って繰り返す、の両方が起きる。ledger はこの 2 つを
同じ 1 本の記録で塞ぐ。

**効かせ所は反復の禁止であって検証の免除ではない。** 裁定済み（`resolution`）の論点を
verifier が再提起すること自体は正当で、封じてはならない — 裁定が間違っていることは
ありうるし、封じれば「一度通せば以後検証されない」経路ができる。求めるのは
**その解決がなぜ不十分かを、entry を参照して述べること**だけである。

## entry の型

型の値の正本は `scripts/ledger.py` の `ENTRY_TYPES`。この表は意味（誰の出来事か・主な payload）の説明で、
値を追加・変更するときは ENTRY_TYPES を先に直し、この表を追随させる。

| type | 誰の出来事 | 主な payload |
|---|---|---|
| `plan_v` | planner が出した Plan の版 | 版番号、成功基準、採用案 |
| `review_v` | plan-verifier / build-verifier / verifier の findings | lens、severity、claim |
| `resolution` | 論点の裁定（司令塔の自己解決、棄却案とその理由） | method、reason、rejected_alternatives |
| `build` | builder の成果物と測定点 | artifacts、measurement_points |
| `build_review` | build-verifier の判定 | verdict、findings |
| `do_run` | 条件 × 反復の実行と検証 | condition_id、run_index、measured、score |
| `check` | 集計・機序・較正 | delta、mechanisms、confidence |
| `act_decision` | act-judge の decision と根拠 | decision、matched_rule、basis |
| `note` | 上記に当てはまらない観測事実 | 自由 |

共通欄は `seq`（採番は writer）／`type`／`phase`／`summary`（1〜2 文）／`refs[]`（参照する
entry の seq）／`payload`。

## 書くのは script、読むのは agent

**agent は ledger を読むだけで、書かない。** 追記が agent の裁量に乗った時点で、
都合の悪い entry の欠落と後からの書き換えが検出できなくなる（このスキルが Plan の
基準後付けを禁じるのと同じ理由で、記録の後付けも禁じる）。

workflow runtime にはファイル IO が無いため、経路は 2 段になる。

1. `scripts/pdca-plan.js` / `scripts/pdca.js` が、各 agent の返り値から entry を
   **script の算術で**構成し、返り値の `ledger_entries[]` に載せる
2. 司令塔がその JSON を**編集せずそのまま** writer に流す:

```bash
python3 [SKILL_DIR]/scripts/ledger.py append --path <workspace>/<run-id>/ledger.jsonl --json '<返り値の ledger_entries をそのまま>'
```

`scripts/ledger.py` が seq を採番し、型と必須欄を検査し、既存行の削除・並べ替え・
書き換えを検出する（`validate` サブコマンド）。次の workflow 呼び出しの前に

```bash
python3 [SKILL_DIR]/scripts/ledger.py read --path <workspace>/<run-id>/ledger.jsonl
```

の出力を `args.ledger` に渡す。渡さなければ空として動く（初周・既存 caller の互換）。

## 誰に何を見せるか（全文ではない）

| agent | 見える entry | 理由 |
|---|---|---|
| builder / build-verifier / mechanism-analyst | 全部 | 前周の結果を踏まえて作る・照合する・機序を立てるのが仕事 |
| planner / evidence-collector / intake | `plan_v` / `review_v` / `resolution` | Do/Check の中間結果が見えていると、出た結果に通る基準を書ける |
| verifier | `resolution` / `review_v` | 前周の score が見えていると、期待に沿う読み方で採点できる（Plan 本文を見せないのと同じ理由を別経路で塞ぐ） |
| plan-verifier | 全部 | 反証が仕事で、隠すべき中間結果を持つ工程より前に立つ。裁定済み論点への refs 参照義務を果たすには resolution を含む全履歴が要る |
| runner | 渡さない | 台帳には他条件の記録が載る。読ませると `isolation: 'worktree'` で切っている条件間の遮断が文脈経由で破れる |
| mechanism-arbiter | 渡さない | 対応付けは 2 名の出力だけで判断する仕事で、文脈が入るとどちらかに寄る |

絞り込みは script が入力の段で行う（agent への「読むな」という指示に頼らない）。

## 再提起の扱い（差し戻せる形にする）

verifier / plan-verifier / build-verifier は `[LEDGER]` を読み、`resolution` で裁定済みの
論点を再提起するときは finding に

- `refs`: 参照する `resolution` entry の seq
- `why_resolution_insufficient`: その解決がなぜ不十分か

を付ける。script はこの 2 つが欠けた再提起に `relitigated_without_reference: true` を
**ラベルとして付ける**だけで、finding を落とさない・severity を下げない。判断するのは
司令塔で、差し戻すなら理由を `resolution` entry として ledger に積む。自動で消す経路を
作らないのは、それが「生成物への異論を生成側の都合で消せる」構図になり、このスキルの
生成と検証の不変条件に真っ向から反するため。
