# Runtime Contract

## 目次

- [責務境界](#責務境界)
- [Portable manifest](#portable-manifest)
- [State transitions](#state-transitions)
- [Capability negotiation](#capability-negotiation)
- [Result contract](#result-contract)
- [Context policy](#context-policy)
- [Resume renegotiation](#resume-renegotiation)
- [Parallel writes](#parallel-writes)
- [Final verification](#final-verification)

## 責務境界

orchestrator は workflow の意味、task prompt、agent persona、証拠十分性、結果の採否を判断する。
control script は次だけを扱う。

- manifest と state の schema
- task ID、dependency、output path の一意性
- DAG と上限
- manifest / result の SHA-256
- task の状態遷移と invocation の idempotency
- human gate の明示決定
- task input manifest と final-review input manifest の機械的生成・hash binding
- terminal state と対応eventの機械的照合、および外部executor向けhandoffの生成・検証

control script は結果本文を評価せず、taxonomy、persona、モデル選択、合格理由を allowlist にしない。

## Portable manifest

正本 schema は [workflow-manifest.schema.json](../schemas/workflow-manifest.schema.json)。task は flat DAG とし、
入力順に依存しない。順次処理は `depends_on`、並列処理は同じ dependency frontier、分岐は `when` で表す。
bounded loop は translator が反復を task ID へ展開する。runtime 中に task graph 自体を書き換えない。

task固有result contract、semantic capability/permission、turn数付きcontext policy、translation modeは
[portable-contract-extensions.md](portable-contract-extensions.md) を統合契約とする。対応schemaは
[task-result-contract.schema.json](../schemas/task-result-contract.schema.json)。runtime基盤能力のsnapshotは別途
[capabilities.schema.json](../schemas/capabilities.schema.json) に従う。これらは main manifest schema と controller の
`init` / `prepare` / `finish` / `verify` / `review-prepare` / `finalize` に統合されている。表現できないsource semanticsを
promptへ退避せず `rejected_source` とする。

translation reviewはsource/manifest/call lineageだけでなく、reviewerが参照したrunner契約自体も固定する。
`translation-review-input.schema.json`の`runner_contract`を実行controllerのrootとexact ordered file inventoryへ結合し、
controllerが各raw hashとinventory canonical hashを再計算する。別install copy、古いcache、欠落/余剰file、順序変更、
symlink、live driftは`translation_review_crosswire`として最初のexecution agent dispatch前に停止する。
inventoryにはcontroller本体だけでなく、controllerがimportしてtask/return contractを判定するJSON Schema subset evaluatorも
含める。review対象外のvalidator実装へ安全性やschema意味論を委譲してはならない。
translated modeのtranslator identityも、review input、fresh reviewer invocation receipt、review outputの
`translator_handle`三者へ固定する。controllerは三者一致、translation modeのnull/non-null境界、reviewer handleとの分離を
検査する。review output単独のattestationはtranslator provenanceとして受理しない。

`when` はdirect dependencyであるagent taskの`result.outcome`に対する有限`outcomes`集合、または同taskの
hash固定済み`json_artifact`へのRFC 6901 pointerを扱う。artifact条件は`exists`かJSON scalarへの`equals`だけで、
`when.artifact_path`はcontroller-onlyの分岐入力でありconsumerのagent-visible `inputs`へ追加しない。
controllerは同じproducer/pathのfull `artifact` / `optional_artifact` inputと、condition pointerの祖先・同一・子孫を
選ぶ`artifact_projection`を拒否する。同じartifactの非重複fieldだけを投影することは許す。
consumerが同じ値をsource callsite引数として受け取る場合だけ、必要fieldを`artifact_projection`で宣言し
`when.input_alias`へ結合する。参照不能、invalid JSON、hash driftをfalseやunknownへ丸めない。
outcome分岐は`pass` / `revise`だけであり、`failed` / `blocked`は修復分岐へ昇格させずrunをincompleteにする。
sourceがtransport failureを非success診断値に変換する場合も、互換経路はその業務returnを合成せず
`workflow_incomplete`へ強化する。この差分はfrozen manifestの`compatibility_normalizations`へsource line span、
affected task、exact trigger、source behavior、維持するdomain outcomeとともに宣言し、controllerのshape/task照合と
fresh contract reviewのsource照合を通す。正常応答が返すdomain上の非確定値だけをcompleted resultとして扱い、
宣言のないfail-closed化もsilent driftとして拒否する。

各 agent task は `inputs` を明記する。`argument` はmanifestの`arguments` key、`task_result`と`artifact`は
direct dependency、`file`はabsolute pathとSHA-256に結合する。bounded slotのfan-inだけは`optional_task_result` /
`optional_artifact`を使い、producerがcondition不成立または明示的に許可されたcapability不足で
skipされた場合も`status=skipped`の明示markerを順序保持して渡す。
producer failureやblockをoptionalで吸収しない。controller は prepare 時にそれらを解決して
外部 file / upstream result / artifact の原本hashを照合してcontroller-owned copyへ凍結し、task input manifest を作る。
共通node-result schemaとtask固有result schemaも同じ入力境界に含める。task固有schemaはinline / file-backedの別に
かかわらずcontroller-owned fileへ凍結し、task input manifestのpath/hashからagentが本文を読めるようにする。
hashだけ、またはnull pathだけを渡してfrozen manifest treeの探索をagentへ要求してはならない。
task input manifestはさらにresult pathと宣言済みartifact pathのexact setを `output_contract` として持つ。
agentは書込み時だけrun rootに対するabsolute pathへ解決し、共通envelopeにはexact run-relative artifact pathを記録する。
absolute path、宣言外path、欠落pathはschema/controllerのどちらでもsuccessにしない。
agent prompt に原本のfile path、workflow source path、caller skill tree、`[SKILL_DIR]`を残したmanifestは
`unsafe_prompt_input`で拒否する。agentはprepare後のtask input manifestに記録されたfrozen pathだけを読む。
上流validated JSONの一部だけがsource上のagent引数なら`artifact_projection`を使う。manifestはproducer artifact、
base RFC 6901 pointer、alias、field-to-pointer mapを固定し、controllerが原本を読み、選択fieldだけのcanonical JSONを
`inputs/projections/`へ凍結する。agent-visible task inputには原本artifact path/contentや投影外fieldを含めない。
finish/final verificationではproducer result/artifact hashと投影値を再計算し、原本またはprojection driftを拒否する。
`when.input_alias`は同じtaskに宣言された`artifact_projection`だけをcondition sourceにできる。controllerは投影値を
agent dispatch前に評価し、base pointer不在をbounded slotのcondition falseとして扱う。一方、baseが存在するのに宣言fieldが
欠ける場合は`input_projection_failed`で停止する。condition評価用のfull artifact inputを別途要求しない。
分岐判定だけに使うfieldは`when.artifact_path`でvalidated producer JSONからcontrollerが読み、task input manifestへ
materializeしない。同じartifactから別のagent-visible fieldを投影する場合も、condition pointerと重なる祖先・同一・子孫を
projectionへ含めない。分岐によりsource callsiteのagent-visible field有無が変わる場合は、入力shapeごとのtaskを静的列挙し、
空文字、null、sentinelをsourceに存在しないfieldの代用品として注入しない。
controllerはinvocationを作成済みのagent taskとdecision済みhuman gateについてconditionを再評価し、producer result/artifactの
hash driftやtrueからの変化を拒否する。artifact hashはbytes/provenanceを固定するが、source transformから派生branchへの
意味対応自体は証明しないため、producer result contractでbranchとfield空性を拘束し、fresh contract verifierがsourceから
変換を再計算する。`capability_requests`はagent-visible `artifact_projection` alias専用であり、controller-only artifact条件を
能力要求の入力へ流用しない。
source内の決定的前処理→agent call→決定的後処理は、入力可視性が異なる三つの境界として扱う。semantic agent taskは
source callsite引数とsource-authorized optional read targetだけを受け取り、前後transform用source、全量artifact、
finalization引数を受け取らない。sourceがbounded evidence readを許す場合は`optional_artifact`でproducer順と
available/skippedを凍結する。raw agent result schemaはsource schemaのまま検証し、sourceが後段で上書き・正規化する
不変条件はdownstream transform artifact/result contractで初めて強制する。
順序付きtupleをsource-exactに固定する場合はboundedなDraft 2020-12 `prefixItems`と`items: false`を使える。
controllerは最大100 prefix schema、全体1000 schema node、実行時10000 evaluationの上限内で各indexと余剰itemを検査する。
manifest path/hash、context policy、観測済み fork behavior を invocation receiptへ入れる。prepare後の`finish`とfinal reviewは
原本ではなく凍結copyとreceiptの task/run/invocation/hashを再検査する。原本path/hashのprovenanceはfrozen workflow manifestと
controller stateだけに残し、agent-visible task input manifestには公開しない。
subagent に暗黙の workspace 探索を
許可入力として扱わせない。

## State transitions

```text
pending -> prepared -> running -> completed
                               -> resolved  (`revise`を受理し、静的handlerへ渡した)
                               -> failed
                               -> blocked
pending -> skipped          (resolved false condition only)
human_gate: pending -> approved | rejected
```

一つの task に複数の running invocation を持たせない。`finish` は task、invocation、result hash の exact
一致を要求する。同じ hash の二重 finish は成功、異なる hash は conflict。
controllerはstateを信頼せず、`skipped` をcondition/capability receipt、`approved`をgate receipt、
`completed` / `resolved` / `failed` / `blocked`を対応するresult・abort・dependency eventへ照合する。
task kindで許されないstatus、eventなしのterminal化、statusとoutcomeの不一致は `state_drift` とする。

## Capability negotiation

capability snapshot は runtime が自己申告する feature flag ではなく、親 orchestrator が現在の callable tool
inventoryから作る。正本shapeは [capabilities.schema.json](../schemas/capabilities.schema.json) とし、最低限の
collaboration operationに加えて現在の並列上限、isolation/enforcement、source trust、secret取扱い、fork behaviorを記録する。
加えてtask要求を照合するsemantic capability/permission inventoryと、exact-turn context supportを同じ観測時点へ固定する。
概念上の最小例:

```json
{
  "schema_version": "dynamic-workflow-capabilities/v1",
  "native_collaboration": true,
  "spawn": true,
  "collect_or_wait": true,
  "stable_handle": true,
  "message": true,
  "resume": true,
  "interrupt": true,
  "max_parallel": 4,
  "filesystem_isolation": "attested_not_enforced",
  "tool_isolation": "attested_not_enforced",
  "external_mutation_enforcement": "attested_not_enforced",
  "source_trust": "trusted",
  "secret_bearing": false,
  "fork_behavior": {
    "context_isolation": "attested_not_enforced",
    "model_context_inherited": false
  },
  "semantic_capabilities": {
    "research.read": {"availability": "supported", "enforcement": "enforced"}
  },
  "permissions": {
    "workspace.read": {"status": "granted", "enforcement": "enforced"}
  },
  "context_support": {
    "fresh": true,
    "recent": {"supported": true, "max_turns": 8},
    "all": true
  },
  "diagnostics": {
    "multi_agent_v2": "diagnostic_only",
    "collaboration_modes": "diagnostic_only"
  },
  "observed_at": "2026-01-01T00:00:00Z"
}
```

`multi_agent_v2`、`collaboration_modes`、host build等は `diagnostics` 内にだけ保持でき、上の基盤能力やtask要求を代替しない。
task-level `semantic_capabilities`、`permissions`、`on_unavailable` はportable manifest extensionに置く。adapterはdispatch前に
現在のsnapshot inventoryへ照合し、判定根拠をtask preflight receiptへ保存する。unknown/unsupported/deniedを利用可能と
推測しない。具体的tool名はadapter内に留める。

graph-level `required_capabilities`はcoreの`native_collaboration` / `spawn` / `collect_or_wait` / `stable_handle`に、
sourceが実際に呼ぶ追加collaboration operationだけを加える。capability snapshotが`message` / `resume` / `interrupt`を
観測していても、sourceが使わないoperationをmanifestの必須条件へ昇格しない。

agent入力値に応じて外部読取能力が変わり、sourceが能力不足を正常domain fallbackへ変換する場合、taskの
`capability_requests`を`artifact_projection` alias/pointerへ結合する。controllerはprojection freeze後に各requestを
`inactive` / `available` / `unavailable`としてdispatch capability receiptへ固定する。`unavailable`でもtaskをdispatchし、
宣言済みvalidated JSON artifactのpointerがsource固有fallback scalarと一致することを`finish`、idempotent再finish、
run verificationで強制する。静的task requirementsの不足、optional task skip、transport failureと混同しない。

全 control contract の `date-time` は RFC 3339 のうち、`T` と `Z` を大文字に固定し、秒は `00`–`59` とする
canonical subsetを使う。小文字の `t` / `z` と leap-second表記 `:60` はschemaとcontrollerの両方で拒否し、数値offsetは許可する。

## Result contract

正本 schema は [node-result.schema.json](../schemas/node-result.schema.json)。`outcome` は `pass`、`revise`、
`blocked`、`failed` のいずれか。`pass` は `completed`、manifest が明示受理した `revise` は成功と区別した
`resolved` になる。`revise` を受理する task は、直接の全 consumer が outcome 条件を持ち、少なくとも一つが
`revise` を処理しなければならない。`blocked` / `failed` は受理済み completion に昇格しない。runtime が
producer task を推測して巻き戻すことはなく、修復 loop は manifest に展開しておく。

共通envelopeだけでsource固有output shapeを代替しない。taskが `result_contract` を持つ場合は
[task-result-contract.schema.json](../schemas/task-result-contract.schema.json) に従い、`finish` とfinal reviewの両方で
hash固定schemaを適用する。schema/target/hashの欠落やvalidation errorは `workflow_incomplete` であり、空payload、
free-form summary、`pass`へ変換しない。
node-result envelopeの`artifacts[].path`はrun-relative transport identifierである。source固有JSONのfile path fieldや
workflow returnが`${workspaceDir}`から構築するabsolute stringはsemantic valueであり、result schema/return bindingで
exactに維持する。安全なtransport表現へ合わせる目的でsemantic fieldをrelativeへ書き換えない。
v1のbounded JSON Schema subsetはnative RegExpの実行時間を保証できないため `pattern` を受理しない。
JSON入力は1ファイル8 MiB、task-result schema評価は10,000 stepをcontroller ceilingとする。

v1は意味的なbounded revise loopを静的展開できるが、transport error、timeout、rate limit、lost handle、schema-invalid
responseに対する同一task retryを実装しない。そのretryがsource semanticsに含まれる場合はtranslation時点で
`rejected_source` とする。

## Context policy

context policyはtask-level portable manifest extensionに置き、shapeは capability schemaの `$defs/context_policy` に従う。
`recent` はturn数を必須とし、`context_support.recent.max_turns` 以下であることをpreflightで確認してreceiptへ残す。
hostがexact turn数を指定できない場合は `recent` を `all` へ丸めず
`unsupported_runtime` とする。`fresh` はconversation非継承だけを意味し、filesystem/tool isolationはsnapshotの別fieldで判定する。
controllerが固定するのは要求したmodeとturn数、capability観測、dispatch inputであり、hostが実際に適用したcontext量の
外部署名ではない。host側のenforced receiptがないruntimeでは、この境界をattestationとして扱い、強制隔離の証明と表現しない。

## Resume renegotiation

resume identityにはfrozen manifest、source、初回user limits、完了済みresult、初回capability snapshotを使う。ただし
現在のruntime capacityとsemantic capability/permission/context supportはresumeごとに新しいsnapshotで再取得し、pending taskの
requirements/context policyを新しいtask preflight receiptで再交渉する。前receiptより新しい `observed_at` だけを受理し、
初回snapshotを上書きせずresume snapshotのexact bytesを追加する。凍結後に再読・再検証し、その同じbytesだけからreceipt metadata、
effective capacity、pending task assessmentを生成する。completed taskだけが使用した能力は再要求しない。

final reviewの予約後はreview入力とstate snapshotのlineageを固定するため、stateに `final_review_invocation`、`final_review`、
または1件以上の `action_handoffs` が存在するrunへの `init` resumeは `resume_not_allowed` とする。既存runは証拠として保持し、
final reviewやhandoffの修復は新runで明示的に行う。

実効並列数は `min(frozen manifest limit, frozen user limit, current runtime max_parallel)`。能力低下時に凍結済み上限を
そのままdispatch数として使わない。必要能力が消失した場合は新規dispatchを止め、実行前なら `unsupported_runtime`、一部
実行済みなら `workflow_incomplete` とする。capacity低下だけを理由にrunning handleをlost扱いしたり、別handleへ再bind
したりしない。

## Parallel writes

- 全 output path は相対 path で run root 内。
- `..`、絶対 path、NUL、空 path を拒否する。
- task の primary result / artifact path は case-fold 後も一意で、相互に ancestor / descendant でない。
- run root は新規または空で、resume 時は controller marker を持つ。各 mutation 前に run root、marker、controller path の
  symlink を再検査する。
- shared input は read-only。複数 task が同じ output を宣言した manifest は開始前に拒否する。
- v1 の書込み範囲は run root 内に限る。repo 本体や外部 system の更新要求は、run 内に exact action package を
  作って human gate を閉じるところまでとし、実操作は runner の外で別途承認・実行する。run 内 gate receipt は
  外部操作の権限として移送しない。外部実行側が exact package hash / action IDs / targets / scopes を再承認させる。

action packageは [action-package.schema.json](../schemas/action-package.schema.json)、handoffは
[action-handoff.schema.json](../schemas/action-handoff.schema.json) に従う。handoffの `execution_status=not_authorized` と
`reuse_workflow_gate=false` は、外部executorが新しいapprovalを取得するまで操作不能であることを表す。
`workflow_complete` 後にだけ `handoff-prepare --gate <id>` がcontroller-owned gate receipt、package、pass済みfinal reviewを
結合した `handoffs/<gate-id>.json` を作る。`handoff-verify` はそのhash、action IDs、executor capabilities、targets、scopes、
新規承認契約を再検査する。handoffは外部操作を実行せず、権限を示すfieldも持たない。

## Final verification

final verifier は少なくとも次を確認する。

- manifest / capability / state hash
- manifest task 集合と安全な terminal task 集合の exact match
- optional を含む全 task に failed / blocked / rejected がなく、completed / resolved / skipped / approved のみで閉じていること
- result file の存在、schema、hash
- running task 0、未決 gate 0
- independent pair の異なる task / handle
- controller-generated final review input manifest が manifest/capabilities/translation receipt/state/results/gates の exact setを持つこと
- task-result contract/schema hashと各validation receiptのexact setを持つこと
- gateのaction package参照がtask/path/hash/action IDsに加え、executor capabilities、targets、scopesのexact setを保持すること
- external action が workflow 内で実行されていないこと
- source、controller-owned frozen input、task input receipt、result、action package の現在 hash が frozen lineage と一致すること
- handoffがある場合、controller-owned receipt、package、final review、state eventのexact lineageと
  `execution_status=not_authorized` / `reuse_workflow_gate=false` が維持されること

ローカル hash は accidental drift と partial splice の検出用であり、共有 filesystem 全体を協調改竄する攻撃に
対する外部 trust root ではない。この限界を cryptographic proof と表現しない。
