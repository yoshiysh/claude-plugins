# Source Translation

## 目次

- [原則](#原則)
- [対応できる意味](#対応できる意味)
- [拒否する構文・意味](#拒否する構文意味)
- [Bounded loop の変換](#bounded-loop-の変換)
- [Prompt と persona](#prompt-と-persona)
- [Translation review](#translation-review)

## 原則

source はデータとして読む。拡張子と basename は routing hint にすら使わない。sourceのJSONがそれ自体で完全な
`dynamic-workflow/v1` execution manifestとしてschema validationを通り、manifest自身ではない実sourceのpath/hashへ
結合されている場合だけ`translation_mode=direct`で受理する。それ以外の任意sourceは`translation_mode=translated`として
fresh translatorを使う。portable definitionをexecution manifestへ変える別のnormalizerは存在しない。どちらも別handleの
fresh verifierを使う。mode、result contract、capability、context、retry、
resumeの詳細は [portable-contract-extensions.md](portable-contract-extensions.md) に従う。Claude skill の
`Workflow(...)` を受ける `invocation_mode=skill_bridge` は translation mode と別軸であり、
[claude-workflow-compatibility.md](claude-workflow-compatibility.md) の call / return binding に従う。

`direct` は保守・移行検証で完成済みmanifestを渡す非公開の副次経路であり、caller skillの内部互換実行では通常
使わない。translator invocationを作らず、translation reviewの `translator_handle=null` とする。`translated` では
translator handleを必須とし、reviewer handleと分離する。sourceの `format` 自己申告、filename、拡張子、既知workflow名を
mode判定に使わない。

## 対応できる意味

- sequential stage: dependency chain
- parallel stage: 同じ predecessor を持つ sibling tasks
- phase: task ID prefix と dependency barrier
- agent call: `kind=agent`
- human approval: `kind=human_gate`
- bounded loop: 最大反復回数を明示した task 展開
- conditional branch: 先行 result の `outcome` に対する有限条件
- bounded data fan-out: source schemaと引数にhard maxがあり、全slotを実行前に静的列挙できる配列展開
- structured result: 共通node result envelopeと、taskごとにhash固定した追加result contract

source 固有の関数名は対応表の根拠にできるが、runtime の必須 API にはしない。
manifest の `arguments` は caller が渡した JSON object を保ち、各 task の `inputs` は許可する値だけを型付きで
列挙する。上流 result や artifact を読む task は、その producer を direct dependency として明示する。
workspace 全体、過去 run、会話履歴を暗黙入力にしない。

sourceやcaller root内のagent prompt、schema、template、referenceなど、taskが読む補助fileはtranslatorが
absolute path/SHA-256の`file` inputとして全件列挙する。実行promptは原本pathや`[SKILL_DIR]`を読ませず、
prepare後のtask input manifestにあるcontroller-owned frozen `path`だけを読むよう変換する。runtimeで決まる
directory、git diff、workspace treeを読むsourceは、caller receiptが件数/総bytesのhard maxとpath/content hashの
完全inventoryを持たない限り`rejected_source`とする。

各taskは具体的tool名ではなく `semantic_capabilities`、`permissions`、`on_unavailable` を宣言する。
`on_unavailable=skip_optional` はsourceが省略を明示的に許す `required=false` taskだけに使える。それ以外は
`unsupported_runtime` とする。provider/model固有要件をportableな意味能力へ変換できない場合は、似たmodelへ置換せず
unsupported constructとする。
例外はsource自身がmachine-readable `claude-workflow-model-portability/v1`宣言で全model callsiteを列挙し、
model identityが分岐・上限・schema・tool権限・返却式を決めないscheduling hintだと宣言した場合だけである。
translatorは全callsiteとの完全一致と非load-bearing性を確認してmodel hintをdropし、role/result contractを保存する。
未列挙callsite、宣言とsourceの不一致、load-bearing identityは拒否する。互換実行の品質同等性は保証しない。

context policyは `{mode: fresh}`、`{mode: recent, turns: N}`、`{mode: all}` のいずれかに正規化する。sourceがrecent
contextを要求するのにturn数が確定できない場合、`all` や固定既定値で補わない。

## 拒否する構文・意味

- 無限または上限不明の loop / recursion
- `eval`、`Function` constructor、dynamic import
- source 実行時の filesystem、network、shell、副作用
- 実行中に task graph を任意追加する self-modifying workflow
- hard maxがないagent resultやruntime dataの件数に応じてtask / edgeを追加するdynamic fan-out、または実行中のdata-dependent graph生成
- wall-clock、random、環境変数だけで task 意味が変わる処理
- result 欠落を業務上の成功に変換する catch-all。source が欠測を非success診断として返すだけの
  分岐は、互換経路ではsource固有returnを作らず `workflow_incomplete` に強化する。正常応答が表す
  domain 上の検証不能とtransport failureは混ぜない
- transport error、timeout、rate limit、lost handle、schema-invalid responseを同じtask IDで再実行するretry
- external mutation を graph 内で行う処理。v1 は action package 生成と確認 gate へ変換し、外部実行は別 skill に残す
- output path が source / repository の任意領域へ拡散する処理

有限 conditional branch は、全候補nodeとedgeを実行前に列挙し、runtime resultが既存branchの選択だけに使われる場合に
限り対応できる。runtime resultから実行中に新しいnodeやedgeを作る処理は拒否する。

## Bounded data fan-out

配列件数に応じたfan-outは、次をすべて満たす宣言的subsetだけを扱う。

- source自身のschemaとcaller引数に変更不能なhard maxがある
- translatorが`0..maxItems-1`のslot task、edge、outputを最初のagent dispatch前に完全列挙する
- 各slotはproducerのhash固定済み`json_artifact`をtyped inputに持ち、RFC 6901 pointerの`exists`または
  JSON scalarへの`equals`だけで選択する
- 実行しないslotは`condition_false`でskipし、agent invocationやoutputを作らない
- downstream fan-inは`optional_task_result` / `optional_artifact`を使い、`available`と`skipped`を順序付きmarkerとして受け取る
- optionalはcontrollerが明示的に認可・記録した`condition_false`または`capability_unavailable`
  skipだけを吸収し、failed / blocked / rejected producerを成功化しない
- manifestの`max_tasks`、`max_agent_runs`、depthは全slotを展開したworst caseを収容する

sourceに明記されたdedupe、sort、filter、count、算術、stop判定などを別taskへ分けることは、source spanと
入出力schemaをexactに対応付け、同じ計算を独立reviewerが再検算できる場合に限る。品質向上目的のtask追加ではなく、
sourceの既存処理を可視化する変換である。外部pathへの動的出力、provider/model固有の実行意味、またはsource実行なしに
同値性を検証できない処理は、このsubsetに含めず`rejected_source`とする。

## Bounded loop の変換

例えば最大3回の generator-verifier loopは、次のように静的展開する。

```text
generate-1 -> verify-1
               | outcome=revise
               v
            generate-2 -> verify-2
                              | outcome=revise
                              v
                           generate-3 -> verify-3
```

`verify-1=pass` の場合、2回目以降は `when` false で skipped になる。最大反復後も `revise` なら
`workflow_incomplete`。runtime が暗黙に回数を増やさない。

これは意味的な修復loopでありtransient retryではない。transport failure等のretryを `revise` へ読み替えず、v1では
`unsupported_constructs` に残す。

## Prompt と persona

translator は source に書かれた intent を保存するが、固定 persona catalog を作らない。task の目的、許可入力、
禁止入力、成果物、成功条件、停止条件から orchestrator がその実行時に prompt / persona を組み立てる。
必要な task だけ fresh context を選び、常に fresh にして情報を失うことも、常に full context にして独立性を
壊すこともしない。

## Translation review

verifier は source を再読し、少なくとも次を source span と task ID で対応付ける。

- agent call の過不足
- sequential / parallel barrier
- loop 上限
- result schemaとtask-result contractのtarget/schema hash/validation point
- failure / null semantics
- taskごとのsemantic capability、permission、`on_unavailable`
- `recent` のturn数を含むcontext policy
- `translation_mode` とtranslator/reviewer handle規則
- transient retryがunsupportedとして保持されていること
- action package、確認 gate、graph 外の外部副作用という境界
- output ownership
- context isolation
- compatibility modeではcall receipt raw hash、caller/source/args、native observation、caller phase/gate ownership、
  `invocation_mode=skill_bridge`、return binding、caller outer phase/gateの非取り込み
- sourceが読む全補助fileのabsolute path/hash inventory、各taskのtyped file input、実行promptが参照するfrozen path。
  live caller/plugin/target treeへの暗黙Readがないこと
- model portability宣言がある場合、source hashとSKILL hashに結合した全model callsite/role/modelの完全一致、
  非load-bearing性、drop記録、品質同等性を保証しない旨

対応不能な箇所は `unsupported_constructs` へ残す。空にできない場合は `rejected_source`。
reviewer 起動前に exact prompt と、source raw hash・manifest canonical JSON hash を含む input manifest を保存する。
skill_bridgeではinputとinvocation receiptの両方をcall receipt raw hash、`caller_phase_ownership`全体、
`native_workflow_observation`全体へexact bindする。
fresh/non-inherited invocation receipt と review output は同じ invocation ID/handle に結合し、review 時刻は
invocation より後でなければならない。
controller はその exact prompt / input bytes を書き換えずrunへcopyし、外部で受け取ったoriginal receipt自体もhash付きで
保存する。frozen wrapperの `translation_mode` と `handle_boundary` はoriginal receiptから変更できず、modeと
`translator_handle` のnull/non-null境界を機械照合する。`attested_not_enforced` はfresh forkをhostが強制した証明ではない。
