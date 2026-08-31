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

sourceが上流JSON objectから選んだfieldだけをagentへ渡す場合、`artifact_projection`を使う。producerはhash固定済み
`json_artifact`をresult contractで検証し、consumerはそのdirect dependency、artifact path、base RFC 6901 pointer、
agent-visible alias、field名からrelative pointerへのexact mapを宣言する。controllerだけが原本を読み、選択fieldだけの
canonical JSONをtask inputへ凍結する。agentへsource未指定fieldや上流artifact全体を見せる変換は入力拡張であり拒否する。

bounded optional slotの有無も同じ投影fieldだけで決まる場合、conditionは`when.input_alias`でそのprojectionへ結合する。
condition評価のためだけに`artifact` / `optional_artifact`を追加し、producer JSON全体をagent-visible inputへ戻してはならない。
controllerはprojection baseが無いslotをcondition falseとしてskipできるが、baseが存在するのに宣言fieldが欠ける場合は
invalid projectionとして停止する。

このexact-input規則は一つのsource agent callの前後にも適用する。sourceが決定的前処理でagent引数を作り、agent resultを
決定的後処理で正規化してから次のagentを呼ぶなら、前処理、semantic agent、後処理を別task/artifactへ分ける。
semantic agent taskへ前後処理のsource file、全量中間artifact、finalization用引数を渡して一つに畳まない。source roleが
bounded evidence fileを必要時だけReadできる場合は、producer順を保った`optional_artifact`としてavailable/skippedを渡す。
そのreadをpromptで一律禁止してresourceを落とすことも、sourceに無いresourceを追加することも意味変更である。

raw agent resultと正規化後resultも別契約である。source raw schemaが任意stringを許し、後段でexact pathへ上書きするなら、
raw task schemaをexact pathの`const`へ狭化しない。raw taskはsource-validなshapeをそのまま受理し、後段transform artifactが
上書き後のexact invariantを持つ。後段値をraw promptで期待することと、raw schemaでsource-valid値を拒否することは別である。

入力値に応じて必要な外部読取能力が変わり、sourceが能力不足を`cannot-verify`等の正常domain resultへ変換する場合、
全candidate taskの静的`requirements`へ全能力を要求しない。`capability_requests`の条件を投影済みinput alias/pointerへ
結合し、prepare時のfrozen capability snapshotで評価する。利用不能ならtaskをdispatchし、sourceのvalidated JSON verdict
artifactへのequals guardをcontrollerがfinish/final verificationで強制する。利用可能ならguardは発火しない。
source operationのtarget scopeをboundedに表現できないfile/live API readを暗黙のworkspace/network権限へ拡張しない。
graph-level`required_capabilities`はcore 4とsourceが実際に呼ぶ追加collaboration operationだけにする。

artifact envelopeの`artifacts[].path`はrun-relative transport pathである。一方、source固有verdictやreturn objectが
`${workspaceDir}`からabsolute file path stringを構築する場合、そのsemantic valueはexact absolute stringのまま保持する。
transport安全性のためにsource result fieldまでrelativeへ変更してはならない。
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
  domain 上の検証不能とtransport failureは混ぜない。この安全強化はmanifestの
  `compatibility_normalizations`へsource line span、affected task、trigger、source behavior、維持するdomain outcomeを
  明示した場合だけ許可し、未宣言の意味変更はsilent driftとして拒否する
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

source schemaのrequired/optional field、name、type、enum、nullability、array/string bound、`additionalProperties`と、
sourceが構築するartifact relative path、round/final return shapeはexactに保存する。source-valid値を拒否する狭化、
source-invalid値を受理する拡張、fieldの追加・削除・改名はsilent driftである。文字列正規化やkey生成は、source languageの
whitespace class、case変換、trim、stable sort、dedupe/filter順序まで同じであることをtyped input/outputから再計算できなければ
ならない。runner診断用fieldをsource resultへ混入させず、共通node envelopeまたは宣言済みnormalizationへ分離する。

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
- `compatibility_normalizations`の全entryとsource span。sourceの診断用agent欠測fallbackだけを
  `workflow_incomplete`へ強化し、正常なdomain resultを維持していること。該当分岐が無ければ空配列であること
- taskごとのsemantic capability、permission、`on_unavailable`
- `artifact_projection`のbase/field pointerとagent-visible exact input set、投影外fieldの非漏洩
- semantic agent callsiteごとのexact visible input、前後の決定的transformとのtask分離、source-authorized optional read target
- raw agent schemaと後段normalization schemaの分離、後段invariantをraw contractへ先取りしていないこと
- 入力値依存`capability_requests`、available/unavailable receipt、domain fallback result guard
- graph-level collaboration capabilityの最小性と、transport relative path / semantic absolute pathの分離
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
reviewer 起動前に exact prompt と、source raw hash・manifest canonical JSON hashに加え、実行runner root、必須
SKILL/role/reference/schema/controller fileのabsolute path/raw hash、inventory canonical hashを含む input manifest を保存する。
controllerはexact inventoryを実行中のrunner rootへ照合する。reviewerはinventory外のinstalled/cache/worktree copyを
探索・代用してはならず、別copyを根拠にしたreviewはexecutionをunlockしない。
skill_bridgeではinputとinvocation receiptの両方をcall receipt raw hash、`caller_phase_ownership`全体、
`native_workflow_observation`全体へexact bindする。
fresh/non-inherited invocation receipt と review output は同じ invocation ID/handle に結合し、review 時刻は
invocation より後でなければならない。
translated modeでは親がtranslator invocationから得たhandleをreview inputとinvocation receiptへ起動前に固定し、
review outputの`translator_handle`とも一致させる。reviewerは固定入力だけからtranslator/reviewer handleの分離を再計算する。
direct modeではinput/receipt/outputの三者すべて`translator_handle=null`とする。reviewerによるtranslator identityの
自己申告やsentinel値はexecutionをunlockしない。
controller はその exact prompt / input bytes を書き換えずrunへcopyし、外部で受け取ったoriginal receipt自体もhash付きで
保存する。frozen wrapperの `translation_mode` と `handle_boundary` はoriginal receiptから変更できず、modeと
`translator_handle` のnull/non-null境界を機械照合する。`attested_not_enforced` はfresh forkをhostが強制した証明ではない。
