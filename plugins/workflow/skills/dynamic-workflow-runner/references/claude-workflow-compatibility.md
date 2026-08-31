# Claude Workflow Compatibility

## 目次

- [目的](#目的)
- [Caller 境界の固定](#caller-境界の固定)
- [Translation review の call binding](#translation-review-の-call-binding)
- [Phase と human gate の所有権](#phase-と-human-gate-の所有権)
- [返却境界](#返却境界)
- [v1 で意味保存できない graph](#v1-で意味保存できない-graph)
- [Runtime boundary checklist](#runtime-boundary-checklist)
- [強制できる範囲](#強制できる範囲)

## 目的

この文書は、内部互換経路が選択された**後**のcall receipt、translation review、phase/gate ownership、returnを
定義するruntime boundaryの正本である。いつ互換経路を選ぶか、何をtrigger / non-triggerとするか、nativeをいつ使うかは
`Workflow(...)` callsiteを宣言したcaller skillだけが定める。この文書やrunner自身はroutingを再判定しない。

caller skillは各active callsiteに次のroute契約を持つ。

1. callsiteに到達していないbranch、説明中の例、通常のscript実行ではrouteしない。
2. 現在のtool inventoryにnative Workflowがあり、このcallを未試行ならnativeを一度だけ使う。
3. native Workflowが存在しない時だけ`workflow:dynamic-workflow-runner`を内部利用し、ユーザーにrunner指定を求めない。
4. nativeを試行済みでerror / timeout / invalid resultになったcallは互換routeへfallbackしない。
5. caller root、declared script path、exact args、前後phase、人間gate、expected returnを渡し、verified returnだけで
   post-success phaseを再開する。

これはCodexのhost-global interceptorではない。任意の第三者skillを自動変換するには、そのskill自身が上記callsite契約を
持つ必要がある。Claude Codeのplugin dependencyは`workflow`を同時installできるが、Codexではcaller pluginと`workflow`
pluginを利用者が一度ずつinstallする。

## Caller 境界の固定

agent dispatch の前に、[workflow-call.schema.json](../schemas/workflow-call.schema.json) に従い、次を一つの
`dynamic-workflow-call/v1` receiptとして固定する。

- `call_id`。
- `invoking_skill.root` と `invoking_skill.skill_md.path` / `sha256`。
- `workflow.declared_script_path` と `workflow.resolved_source.path` / `sha256`。
- `arguments.value` と `arguments.canonical_sha256`。
- `native_workflow_observation.attempted=false` / `available=false`、`observed_at`、現在のtool inventoryに基づく
  `evidence`。
- `caller_phase_ownership.owner=caller_skill` と `pre_workflow`、`post_workflow`、`human_gates`。

native observationはこのcallを作る時点のtyped attestationであり、host-globalなnative不在証明ではない。
`attempted=true`、`available=true`、観測不能、または同じcallにnative attemptの記録がある場合はreceiptを作らず停止する。
native attemptがtimeout、tool error、invalid resultで終わっても互換経路へfallbackしない。

execution manifest は `invocation_mode=skill_bridge` とし、call receipt bytesのraw SHA-256を
`return_binding.workflow_call_sha256`へ結合する。callerへ返せる式とschemaも`return_binding`へ固定する。

receiptはhashを手作業で埋めず、caller / hostがplugin install/cacheと対象repositoryの外へ用意したfresh session root内で、
空のexecution run rootとは別の既存writable non-symlink artifact directoryに次で生成する。runner / caller skill rootは
read-onlyでよく、receiptや実行artifactのためにplugin install/cacheを書き換えない。

```bash
node [RUNNER_SKILL_DIR]/scripts/workflow-bridge.mjs prepare-call \
  --caller-skill-root <caller-skill-root> \
  --declared-script-path <exact-scriptPath> \
  --args <exact-args.json> \
  --phase-ownership <caller-phase-ownership.json> \
  --native-observation <native-workflow-observation.json> \
  --call-id <stable-call-id> \
  --output <bridge-artifact-root>/<call-id>/workflow-call.json
```

`prepare-call`はcaller `SKILL.md`、source、canonical argsのhashを生成し、missing、symlink、root escape、native attempted /
availableを出力前に拒否する。同一内容を同一outputへ再送した場合だけidempotentである。生成後も
`validate-call --call <workflow-call.json>`を実行し、dispatch直前のdriftを検出する。

`[RUNNER_SKILL_DIR]` はこの runner skill の root に置換する。一方、callsite の `declared-script-path` に
`[SKILL_DIR]` token が含まれる場合、その token は caller skill root として解決する。token を含まない relative path も
caller skill root を基準に解決し、process cwd、repository root、runner root を基準にしない。absolute pathを含め、解決後sourceはcaller skill root内に限定する。
解決後 path を canonicalize して regular non-symlink file と hash を固定する。
placeholder が未解決、path が曖昧、source が実行開始前に変化した場合は `rejected_source` とする。

`args` は caller が callsite で確定した JSON object をそのまま渡す。field の追加・削除、`undefined` の null 化、
既定値補完、文字列化、key rename、unknown の推定をしない。JSON として固定できない値や未評価 expression が残る場合は
実行しない。translator はこの object を manifest の `arguments` に意味等価なまま保存する。

## Translation review の call binding

`invocation_mode=skill_bridge`ではcontract verifierを起動する前に、translation-review inputとinvocation receiptへ次を
一組で固定する。

- `workflow_call.receipt.path` と、`workflow-call.json` raw bytesのSHA-256。
- call receiptからコピーした`caller_phase_ownership`全体。`pre_workflow`、`post_workflow`、`human_gates`を要約しない。
- call receiptからコピーした`native_workflow_observation`全体。`attempted`、`available`、`observed_at`、`evidence`を保つ。
- exact source path/hashとexecution manifest path/canonical hash。
- translated modeでは親がtranslator invocationから得たexact `translator_handle`。direct modeでは`null`。

review inputとreceiptのworkflow-call bindingおよび`translator_handle`は互いに一致し、review outputの
`translator_handle`、`return_binding.workflow_call_sha256`とも同じ境界へ結合されなければならない。controllerは
skill_bridge init時に`--workflow-call <absolute-workflow-call.json>`を必須とし、call receipt、review
input、review receipt、manifestのexact一致を検査してからrun内`translation/workflow-call.json`へ凍結する。direct modeでは
このfieldとCLI引数を受け付けない。

## Phase と human gate の所有権

runner が代行するのは到達した `Workflow(...)` 一回だけである。caller skill の workflow 前後の phase は caller
orchestrator が所有し続ける。

- pre-workflow phase が完了していなければ runner を開始しない。
- caller が Workflow の外側に置いた承認は caller の gate である。runner の `human_gate` へ移さない。
- source 自身が宣言する runner 内 gate と、caller 外側の gate は別 ID・別 receipt・別目的で管理する。
- runner 内 gate の approval を caller の保存、公開、送信、commit、push、PR 等の承認へ再利用しない。
- runner の失敗、停止、未検証 result の後は caller の post-success phase を開始しない。

## 返却境界

runner は final verification が pass し `workflow_complete` になった result だけを caller へ返す。返却値は、固定した
caller return contract と source 固有 result contract の双方に適合し、run、manifest、source、args、result の hash
lineage を辿れる必要がある。

sourceがexternal action packageを持つrunでは全packageのcontroller-generated handoffを`handoff-prepare` / `handoff-verify`で
閉じるまでreturnをmaterializeしない。callerのpost phaseはraw diff/valueを外部作用へ直接使わず、verified handoffだけを
専用executorへ渡す。executorは適用直前にhandoffとpackage SHA-256、action IDs、targets、scopes、preconditionsを再検証し、
それらへ結合した新しいhuman approvalを取得してから実行し、宣言済みread-backを行う。runner内gateの承認は再利用しない。

sourceが外部actionを宣言せず、caller所有のpost-workflow phaseが保存・適用・公開を初めて設計する場合、translatorは
sourceに存在しないpackageやgateを追加しない。callerはverified return receipt、exact action、target、content/diff hash、scope、
preconditionを結合したcaller-owned action packageを別途作り、そのpackageへの新しいhuman approvalを専用executorで取得する。
verified returnはpackage作成の入力には使えるが、それ自体は外部操作の承認ではない。

`workflow_incomplete`、`unsupported_runtime`、`rejected_source`、`cancelled`、native attempted 後の failure は成功値へ
変換しない。source が agent 欠測を診断用の非success値に変換する分岐も、互換経路ではその
source固有returnを再現せず `workflow_incomplete` に強化する。caller はその terminal state をそのまま
ユーザーへ伝え、成功時専用の後続 phase を停止する。
この安全強化はmanifestの`compatibility_normalizations`へsource line span、affected task、exact trigger、
source behavior、維持するdomain outcomeを宣言し、fresh contract verifierがsourceと照合した場合だけ許可する。
正常応答が返す`cannot-verify`等はtransport failureへ読み替えず、未宣言のfail-closed化もsilent driftとして拒否する。
互換層の診断や run path を、source が返す業務 result の代用品にしない。

## v1 で意味保存できない graph

compatibility preflight、translator、contract verifier のいずれかが次を検出した場合、最初の execution agent を
dispatch する前に `rejected_source` とする。

- hard maxがなく、agent result やruntime dataの件数に応じて実行中に新しいtask / edgeを追加するdynamic fan-out。
- 上限不明の loop、recursion、retry、自己変更 graph。
- runtime data に応じて graph topology 自体を生成・置換する処理。
- closure、prototype、module side effect 等を実行しなければ task 意味を復元できない処理。
- 非 JSON 値、hidden global、process state、random、wall clock に依存し、固定 manifest へ意味保存できない処理。

全候補 node と edge を事前列挙できる有限 conditional branch、明示上限まで静的展開できる semantic revise loop、
source schema/引数のhard maxまでslotを静的展開するbounded data fan-outは対象にできる。後者はvalidated JSON artifactの
pointer conditionとoptional fan-in markerを必須とする。runtime data が**列挙済み branch の選択**にだけ使われることと、
runtime data から**新しい graph を作る**ことを混同しない。

## Runtime boundary checklist

1. call receiptが`attempted=false` / `available=false`、caller/source/args、phase/gateをexactに固定しているか。
2. review input/receipt、manifest return binding、init引数が同じcall raw SHA-256へ結合されているか。
3. v1 へ意味保存できない graph をagent dispatch前に拒否したか。
4. verified returnだけをcallerへ返し、失敗時にpost-success phaseを止めたか。

## 強制できる範囲

control planeは一つのrunでcall hash、manifest、final review、returnを結合し、同じoutputの差替えや異なるreturnの
再materializeを拒否する。一方、別run rootを作って同じcallを再投入することまでをhost-global registryで排他してはいない。
native attempt receiptの保持、stable call IDの再利用、同じcallから別runを作らない判断はcaller orchestratorの責務である。
この境界を「global exactly-onceが機械保証される」と説明してはならない。
