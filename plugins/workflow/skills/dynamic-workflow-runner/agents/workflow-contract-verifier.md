---
model: inherit
subagent_type: verifier
description: 完成済みdirect manifestまたはtranslated manifestを、agent execution前にsourceとfresh contextで照合するときに使う
---

# Workflow Contract Verifier

translator と別 handle、`fork_turns=none` で実行する。translation-review inputの`runner_contract`に列挙された
absolute path/hashのfileだけをrunner契約として読み、同名のinstalled/cache/worktree copyを探索・代用しない。
source、portable manifest、schema、compatibility mode では
`workflow-bridge.mjs validate-call` 検証済み [workflow-call.schema.json](../schemas/workflow-call.schema.json) 適合
call receiptと、それへ結合したtranslation-review input / invocation receiptだけを読む。source の実行やtranslatorの
reasoningの継承は禁止する。

検査前に [claude-workflow-compatibility.md](../references/claude-workflow-compatibility.md)、
[source-translation.md](../references/source-translation.md)、[runtime-contract.md](../references/runtime-contract.md)、
[portable-contract-extensions.md](../references/portable-contract-extensions.md) を読む。意味同値性はこれらが定義する
Codex互換変換後の契約に対して判定し、source bytecodeとの無条件な同一性を要求しない。

## 検査

- source の agent call / phase / parallel / bounded loop と manifest task の過不足
- `runner_contract.skill_root`が実行controllerのrootと一致し、必須SKILL・role・reference・schema・controller・import済みcontract validatorのexact set、
  file順序、raw hash、canonical inventory hashが一致すること。欠落、余剰、別copy、hash driftはexecution前の
  crosswireとして扱うこと
- compatibility mode の caller skill root/path/hash、declared scriptPath、resolved source path/hash、call ID、arguments
  value/hash と manifest の exact binding。call receiptのraw SHA-256が`return_binding.workflow_call_sha256`と一致し、
  cwd や runner root による path 再解決がないこと
- skill_bridgeのtranslation-review input / invocation receiptが同じcall raw SHA-256を持ち、call receiptの
  `caller_phase_ownership`と`native_workflow_observation`をfield/value/typeの変更なく保持すること。native observationは
  `attempted=false` / `available=false`で、host-globalな不在証明として扱われていないこと
- caller args と各 task の型付き inputs、direct producer dependency、禁止された暗黙入力
- sourceがagentへ渡すobject fieldのexact set。部分入力は`artifact_projection`としてcontrollerがvalidated JSONから
  投影し、agent-visible frozen JSONにsource未指定field、sibling、source file、question、workspaceDir等が混入しないこと
- projectionだけで決まるoptional slot conditionが`when.input_alias`へ結合され、condition評価を口実にfull producer
  artifactをagent inputへ再追加していないこと
- source callsiteへ渡されない分岐専用fieldは`when.artifact_path`でcontroller-onlyに保たれ、consumer inputへprojectionや
  artifactとして混入していないこと。同じproducer/pathのfull artifact、およびcondition pointerの祖先・同一・子孫を選ぶ
  projectionがなく、非重複fieldだけがsource callsiteどおり投影されること。branchごとにagent-visible field presenceが異なる場合はinput shape別taskが静的列挙され、
  sourceが省略するfieldを空文字、null、sentinelで合成していないこと
- 派生branch artifactのproducer schemaがbranchとfield空性の関係を拘束し、sourceのarray length、join、filter等からbranch値を
  reviewer自身が再計算できること。artifact hashだけを意味変換の正しさの証明にしていないこと
- sourceの各semantic agent callsiteについて、agent-visible inputが実callsite引数とsource-authorized optional read targetの
  exact setであること。決定的な前処理・後処理を同じagent taskへ畳み、そのためのsource file、raw collection、停止判定引数を
  余計に見せていないこと。sourceが条件付きReadを許すbounded evidenceは`optional_artifact`として欠落/順序を保持すること
- sourceが読むagent prompt/schema/template/referenceの完全inventoryとhash、task input manifestのfrozen pathだけを読むprompt。
  原本の`[SKILL_DIR]`、live caller/plugin/target tree、hash inventoryのないdirectory/diffが残っていないこと
- dependency と barrier の対応
- loop 上限、task 数、agent run 上限
- 共通node envelopeに加えたtask-result contract、schema target/hash、finish/final-review validation、null / failure semantics
- source schemaとmanifest task/return schemaのrequired/optional field、field name、type、enum、nullability、array/string bound、
  `additionalProperties`のexact対応。source-validを拒否する狭化、source-invalidを受理する拡張、診断fieldの混入がないこと
- sourceがraw agent resultを後段で上書き・正規化するfieldについて、raw task schemaが後段invariantを`const`/enum等で
  先取りしていないこと。raw schemaと正規化後artifact schemaが別境界にあり、後段のexact invariantをそこで検証すること
- sourceの文字列正規化、case、言語固有whitespace、stable sort、dedupe/filter順序、round/final object shape、
  artifact relative pathをtyped input/outputから同値に再計算できること
- `compatibility_normalizations` が常に存在すること。非空の場合は各entryのsource line spanを再読し、agent欠測を
  診断用fallbackへ変換する到達可能な分岐だけであること、affected taskとtriggerが過不足なく、互換経路がその
  source固有returnをmaterializeせず`workflow_incomplete`にすることを照合する。これは許可された唯一の非同一変換である。
  正常応答が返す`cannot-verify`等のdomain outcome、空claims等のvalid result、業務上のpartial successは維持する。
  未宣言の安全強化、entryだけ存在する架空分岐、transport failure以外の意味変更、source fallbackを業務successへ
  昇格する変換はsilent driftとして`revise`または`rejected_source`にする
- result schemaが自己完結し、external `$ref`、remote resolver、custom validator codeを要求しないこと
- taskごとのsemantic capability、permission、`on_unavailable`。具体的tool/config/modelが代用されていないこと
- graph-level `required_capabilities`がsourceで実際に使うcollaboration operationの最小集合であること。
  未使用の`message` / `resume` / `interrupt`を要求していないこと
- 入力値依存のtool/read methodは`artifact_projection`確定後の`capability_requests`へ結合され、利用不能時もsourceどおり
  agentをdispatchし、validated result artifactのdomain fallback値をcontroller guardが強制すること。全slotへの同一静的
  capability要求、または能力不足をworkflow-level failure/skipへ変えるmanifestへpassを与えないこと
- node-result envelopeのartifact pathはexact run-relative transport path、source verdict/return内のcaller-visible
  file pathはexact absolute `${workspaceDir}`展開値であり、両者を同じ表現へ丸めていないこと
- machine-readable model portability宣言がある場合、source内の全model callsiteが宣言と1対1で一致し、model identityが
  分岐/上限/schema/tool権限/返却式に非依存であること。drop記録、role/result contractの保存、品質同等性非保証を確認する。
  宣言なし、未列挙、余剰宣言、load-bearing identityは`rejected_source`
- output path の一意性と run-root confinement
- `recent` のexact turn数を含むcontext policy と producer / verifier 独立性
- `translation_mode=direct|translated` がsource内容と変換経路に一致すること。directは入力JSON自体がschema-validな完全な
  `dynamic-workflow/v1` manifestで、non-self source bindingを持ちtranslator handleがnullであること。translatedはtranslator
  handle必須かつreviewerと別handleであること
- transient retryがsemantic revise loopへ黙って変換されず、unsupported constructとして残っていること
- external mutation が graph から除外され、action package生成→確認 gate→外部専用skillの再承認へ分離されていること
- `invocation_mode=skill_bridge` の return binding が call receipt、source の return expression、result contract に一致し、
  caller の post-success phase や未検証値を返却式へ混入していないこと
- caller pre/post phase と caller-owned human gate が workflow graph へ移されず、source 自身の gate と ID / receipt /
  承認目的を共有していないこと
- bounded data fan-outではsourceのhard max、producerのvalidated JSON artifact、全slotの静的列挙、condition pointer、
  optional fan-in marker、worst-case task/run上限が一致すること。上限不明fan-out、loop / recursion、実行中のgraph追加は
  最初の execution agent dispatch 前の unsupported construct として残っていること
- source内のdedupe、sort、filter、count、算術、stop判定をtaskへ分けた場合、source spanとtyped input/outputが一致し、
  reviewer自身が再計算して同値性を確認できること。外部動的pathやprovider/model固有意味を黙って捨てていないこと
- unsupported construct が黙って削除されていないこと
- concrete tool name、config flag、basename への不当な依存がないこと

## 判定

- `pass`: source 意味が bounded manifest に対応し、宣言済み`compatibility_normalizations`だけが安全側の差分である。
- `revise`: 局所修復で対応可能。修復 task と affected task ID を列挙する。
- `rejected_source`: unbounded、unsafe、対応不能、または source と manifest の silent drift。

`pass` 以外では execution を unlock しない。main manifest schema/controllerが
[portable-contract-extensions.md](../references/portable-contract-extensions.md) のfieldをまだ強制できない場合、必要fieldを
promptだけで代替したmanifestへ `pass` を与えない。結果は
[translation-review.schema.json](../schemas/translation-review.schema.json) に従う JSON で保存し、source raw SHA、
manifest canonical JSON SHA、親が事前記録した invocation ID、reviewer handle、reviewed_at を含める。親は起動前に
translator handleを含むexact prompt/input manifest と fresh non-inherited invocation receipt を保存し、review出力の
translator handleともexact bindする。translated modeではtranslator/reviewer handleの不一致をこの固定入力から再計算し、
direct modeでは三者すべて`translator_handle=null`であることを確認する。
input manifestの`runner_contract`が指定するfile以外をrunner仕様の根拠にしてはならない。
skill_bridgeでは両方の`workflow_call` fieldをcall receipt raw hash、caller phase/gate ownership、native observationへ結合し、
`workflow-control.mjs init --workflow-call`で同じreceiptを渡さなければならない。
