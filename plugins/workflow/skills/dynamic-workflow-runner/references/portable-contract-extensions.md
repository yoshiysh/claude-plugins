# Portable Contract Extensions

この文書は、任意の source path から生成する portable manifest と Codex direct collaboration adapter の間の
実行契約を定義する。`workflow-manifest.schema.json` と controller はここで定義する translation mode、task requirements、
context policy、result contract、resume capability receipt を機械検証する。source の意味を表現できない場合は、
既存 field だけへ縮退させず `rejected_source` とする。

## 目次

- [Manifest extension](#manifest-extension)
- [Translation mode](#translation-mode)
- [Task result contract](#task-result-contract)
- [Semantic capability and permission negotiation](#semantic-capability-and-permission-negotiation)
- [Context policy](#context-policy)
- [Retry boundary](#retry-boundary)
- [Resume capability renegotiation](#resume-capability-renegotiation)
- [External action package and handoff](#external-action-package-and-handoff)

## Manifest extension

実行 manifest は filename、extension、source language、具体的な collaboration tool、provider、model、config flag を
workflow identity にしない。次の field を追加する。

```json
{
  "translation_mode": "translated",
  "tasks": [
    {
      "id": "verify-1",
      "context_policy": { "mode": "recent", "turns": 4 },
      "requirements": {
        "semantic_capabilities": ["research.read"],
        "permissions": ["workspace.read"],
        "on_unavailable": "unsupported_runtime"
      },
      "result_contract": {
        "schema_version": "dynamic-workflow-task-result-contract/v1",
        "target": { "kind": "json_artifact", "artifact_path": "artifacts/verify-1.json" },
        "schema": {
          "kind": "file",
          "dialect": "https://json-schema.org/draft/2020-12/schema",
          "path": "/absolute/frozen/schema.json",
          "sha256": "<raw-file-sha256>"
        },
        "validation": {
          "at_finish": true,
          "at_final_review": true,
          "on_missing": "workflow_incomplete",
          "on_invalid": "workflow_incomplete"
        }
      }
    }
  ]
}
```

- `result_contract` は
  [task-result-contract.schema.json](../schemas/task-result-contract.schema.json) に従う。共通
  `node-result` envelope の検証を置き換えず、その task 固有の意味 payload を追加検証する。
- `requirements` と `context_policy` はtask-level portable manifest extensionであり、この文書の判別可能shapeに従う。
  machine-readable shapeは [capabilities.schema.json](../schemas/capabilities.schema.json) の `$defs/task_requirements` と
  `$defs/context_policy` を参照する。
- `translation_mode` は `direct` または `translated` だけを許す。

## Translation mode

`translation_mode` は拡張子や `source.format` の自己申告ではなく、source の内容と変換経路を表す。

- `direct`: 入力JSON自体が完全な`dynamic-workflow/v1` execution manifestとしてschema validationを通り、manifest自身ではない
  実sourceのpath/raw SHA-256へ結合されている。translator invocationは存在せず、translation reviewの
  `translator_handle` は `null`。portable definitionを別shapeのexecution manifestへ変えるnormalizerは存在しない。
  non-self bindingはschema単独ではなくfresh contract verifierがmanifest pathとsource bindingを照合して確定する。
- `translated`: directの条件を満たさない任意sourceを、source languageとして実行せずfresh translatorが変換する。
  `translator_handle` は必須で、contract reviewer handleと異ならなければならない。

どちらも別handleのfresh contract reviewを必要とする。`direct` はreview省略を意味しない。source path、raw SHA-256、
execution manifest canonical SHA-256、mode、invocation receiptをexact bindする。modeをfilename、拡張子、既知workflow名から
推測してはならない。

## Task result contract

task固有schemaはinline JSON Schemaまたはhash固定fileとして持つ。inline schemaの `canonical_sha256` はmanifestと同じ
canonical JSON規則で `document` だけをhashした値、file schemaの `sha256` はraw bytesの値とする。
schemaは自己完結させ、`$ref` は同じdocument内のfragmentだけを許す。remote URL、別file、dynamic reference resolver、
custom validator code、network取得を必要とするformatはunsupportedとする。
Node.js native RegExpには実行時間上限がないため、v1のtask固有schemaでは `pattern` もunsupportedとする。
文字列制約は `enum`、`const`、`minLength`、`maxLength` 等で表現し、正規表現が意味上必須なら
translatorは安全で決定的なvalidatorを推測せず `rejected_source` とする。
controllerはJSON入力を1ファイル8 MiBまでに制限し、schema評価も10,000 stepで停止する。
通常artifactのSHA-256は固定長bufferで計算し、artifact全体をheapへ載せない。

- `target.kind=node_result`: 共通envelope全体に追加schemaを適用する。
- `target.kind=json_artifact`: 宣言済み `artifact_path` のJSON内容にschemaを適用する。
- `json_artifact.artifact_path` はrun root内のrelative pathとし、absolute path、`..`、NULを拒否する。file schemaの
  `path` はhash固定する実fileのabsolute pathだけを許す。
- schema、target、hashの欠落・不一致・validation errorは `workflow_incomplete`。空objectや成功へ変換しない。
- controllerは `finish` で検証し、final reviewer inputにcontract ref/hashとvalidation receiptを含めて再検証する。
- 非JSON output contractを意味保存できない場合は、translatorが自由文promptへ畳まず `rejected_source` とする。

## Semantic capability and permission negotiation

taskは具体的tool名ではなく安定した意味IDを `semantic_capabilities` と `permissions` に列挙する。意味IDのregistryは
adapter実装ごとに解決できるが、unknown IDを利用可能と推測しない。

`on_unavailable` は次だけを許す。

- `unsupported_runtime`: required/optionalを問わず、task dispatch前に停止する。
- `skip_optional`: sourceがその省略を意味上許し、かつ `required=false` のtaskだけを明示skipする。代替tool、別provider、
  単一agent、空resultへfallbackしない。

runtime基盤能力とsemantic/permission/context inventoryのsnapshotは
[capabilities.schema.json](../schemas/capabilities.schema.json) に従う。adapterはtask要求を現在のsnapshotへ照合し、semantic ID、
判定、根拠、observed timeをtask preflight receiptへ残す。
`multi_agent_v2`、`collaboration_modes`、host build、model availabilityのような値はdiagnosticにだけ保存でき、要求を満たす
根拠にはならない。provider/model固有性がsourceの本質で、portableな意味能力へ写せない場合は `rejected_source` とする。

permissionやisolationの `attested_not_enforced` は `enforced` と同一視しない。sourceが強制sandboxを要求し、runtimeがfilesystem/tool isolationを
強制できない場合は `unsupported_runtime` とする。

## Context policy

context policyは文字列ではなく次の判別可能objectにする。

- `{ "mode": "fresh" }`
- `{ "mode": "recent", "turns": N }` (`N >= 1`)
- `{ "mode": "all" }`

adapterは `recent.turns <= context_support.recent.max_turns` とhostがturn数をexactに適用できることをpreflightで確認し、
その判定をtask receiptへ残す。hostがturn数を
指定できない場合、`recent` を `all` や固定turn数へ丸めず `unsupported_runtime` とする。`fresh` はconversation非継承であり、
filesystem/tool isolationを意味しない。

## Retry boundary

v1が表現するのは、sourceに明示された有限の意味的 `revise -> repair -> verify` loopだけであり、開始前にflat DAGへ
展開する。transport error、timeout、rate limit、lost handle、schema-invalid responseに対する同一task retryは現行state
machineでexactly-onceに閉じられないため **unsupported** とする。translatorはsemantic repairへ読み替えず
`unsupported_constructs` に残す。暗黙retry、ad-hoc reset、同じtask IDへのrespawnを行わない。

## Resume capability renegotiation

manifest、source、初回user limits、完了済みresult、初回capability snapshotは凍結する。一方、runtimeの現在能力はresume
ごとに新しいsnapshotとして取得し、dispatch前に再交渉する。

```text
effective_parallel = min(
  frozen_manifest.max_parallel,
  frozen_user.max_parallel,
  current_runtime.max_parallel
)
```

current snapshotは新しいreceiptとして保存し、初回snapshotを上書きしない。全pending taskのsemantic capability、permission、
context policyも再評価する。能力消失時は新規dispatchを行わず `unsupported_runtime` または既に一部実行済みなら
`workflow_incomplete` とする。running handleをcapacity低下だけで失われたと推測したり、別handleへ付け替えたりしない。

## External action package and handoff

external mutationを要求するsourceは、run root内に
[action-package.schema.json](../schemas/action-package.schema.json) のpackageを生成し、workflow gateとfinal reviewを閉じる。
packageはexact action、target、scope、parameters、preconditions、期待effect、read-back、idempotency方針をsource/manifest/
capability/result hashへ結合し、`external_effects_performed=false` とする。
`action_id` とbinding対象の `task_id` はそれぞれ一意でなければならず、schema validationに加えてcontrollerがkey単位の
重複を検査する。

workflow完了後は [action-handoff.schema.json](../schemas/action-handoff.schema.json) のhandoffだけを専用executorへ渡す。
handoff時点の `execution_status` は `not_authorized` であり、workflow gateは意味確認にすぎず外部操作権限を付与しない。
executorはpackage SHA-256、action IDs、targets、scopesへ結合した新しい承認を取得しなければならない。handoff schemaは
承認receiptそのものではなく、再承認が必要であることを機械可読にする境界である。
handoffは手書きせず、`workflow-control.mjs handoff-prepare` で生成し、`handoff-verify` を通したものだけを渡す。
controllerはapproved gateのaction/targets/scopeとpackage本文を再照合し、package・gate receipt・final reviewの実file hashを
固定する。workflow gateを外部approvalへ昇格させたり、handoffの `execution_status` を変更した場合は拒否する。
