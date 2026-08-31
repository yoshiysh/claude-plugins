---
name: dynamic-workflow-runner
user-invocable: false
description: >
  Claude Code 向け skill が実行中に到達した Workflow({scriptPath,args}) 呼び出しを、
  bounded multi-agent graph へ適合させる Codex 内部互換層。ユーザーが直接呼ぶスキルではなく、
  Workflow callsite を持つ caller skill が native Workflow 不在時に透過的に内部利用する。
  Use when: 選択済み caller skill の active callsite がこの内部互換層を要求した場合だけ。
  通常のNode.js/Python/shell実行、単発subagent委譲、外部更新の無承認自動化、hostile sourceに対する強制sandboxには使わない。
---

# Dynamic Workflow Runner

Claude Code 向け skill の `Workflow(...)` 呼び出しを透過的に受ける compatibility mode が通常経路である。
ユーザーにこの runner の存在や直接指定を要求しない。完成済み manifest の direct mode は保守・移行検証用の
非公開経路であり、caller skill の通常利用からは選ばない。どちらも workflow の意味を Codex の実行時に実在する collaboration 能力へ結び付ける。特定の
`.js` ファイル名、具体的な tool 名、`multi_agent_v2` や `collaboration_modes` の設定値を実行契約に
しない。スキルが orchestration を担い、[workflow-control.mjs](scripts/workflow-control.mjs) は manifest、
状態、hash、依存関係、上限だけを機械的に管理する。

## 不変条件

1. **実際に呼べる能力を優先する。** config flag、feature 名、モデル名は補助情報であり、`spawn`、
   `collect_or_wait`、stable handle が現在の tool surface に存在する場合だけ multi-agent execution を開始する。
2. **source のファイル名や拡張子を意味にしない。** JSON manifest は直接検証する。それ以外の source は
   [workflow-translator.md](agents/workflow-translator.md) が読んで portable manifest へ変換する。
3. **JavaScript を直接評価しない。** `eval`、dynamic import、workflow source の shell 実行、再帰的な
   `codex exec`、生 HTTP への自動 fallback を禁止する。
4. **LLM と control plane を分離する。** task 分解、prompt、結果の意味、証拠十分性は LLM が判断する。
   code は型、path、DAG、上限、hash、状態遷移、重複完了だけを検証する。
5. **全 task を安全に閉じる。** optional を含め failed / blocked / rejected が一つでもあれば completion にせず、
   null、欠落 result、unknown status、verifier 不在を success や 0 件へ変換しない。
6. **共有 filesystem を暗黙の coordination bus にしない。** task ごとの output path を run root 内に固定し、
   並列 task の出力重複を拒否する。親は subagent の chat 応答ではなく、その task result を正本にする。
7. **外部更新を実行面から分離する。** v1 の agent task は run root 内の artifact だけを作る。commit、push、
   PR、publish、外部送信は verified action package と human gate までを生成し、実操作は workflow 完了後に
   ユーザーが明示承認した専用 skill へ handoff する。run 内 gate は外部操作の approval receipt として再利用せず、
   専用 skill が exact package hash、action IDs、targets、scopes に対する承認を改めて取得する。
8. **名前の任意性と信頼境界を混同しない。** 任意の filename / extension は受け付けるが、任意の hostile codeを
   安全に実行する sandbox ではない。現在の collaboration runtime が child の tool/filesystem 権限を強制分離できない
   場合、その境界は `attested_not_enforced` と表示し、adversarial source・secret-bearing taskには使わない。
9. **compatibility route は caller skill の active callsite に従う。** 起動可否と native-first / exactly-once の判断は
   `Workflow(...)` を宣言した caller skill が所有する。runner は選択済み call の caller root基準source、
   exact args、per-call native observation、outer phase/gate ownershipを固定し、native attempt済みのcallを拒否する。
10. **verified return だけを caller へ返す。** caller の pre/post phase と human gate は caller が所有し、runner 内gateを
    流用しない。`workflow_complete` とfinal verificationに結合されたreturnだけsuccessとし、失敗時はpost-success phaseを止める。
11. **transport failure を業務resultに変えない。** native source が agent 欠測を診断用の非success値に
    変換する分岐は、Codex 互換経路では `workflow_incomplete` に強化する。正常応答が返す domain 上の
    `cannot-verify` 等と、timeout・lost handle・schema-invalid・応答欠落を区別する。

必要なreferenceだけを次の条件で読む。通常実行で全資料を一括読込しない。

| 条件 | 読むreference |
| --- | --- |
| 常時: runtime状態遷移、result contract、resume、external handoffを実行・検証する | [runtime-contract.md](references/runtime-contract.md)、[portable-contract-extensions.md](references/portable-contract-extensions.md) |
| compatibility: caller skillの`Workflow(...)`を内部互換経路で処理する | [claude-workflow-compatibility.md](references/claude-workflow-compatibility.md) |
| translation: sourceが完成済みexecution manifestではなく、manifestへ変換する | [source-translation.md](references/source-translation.md) |
| capability mismatch: tool surface、context、permission、optional capabilityを判定する | [codex-capabilities.md](references/codex-capabilities.md) |
| security-sensitive: untrusted source、secret、強制隔離、外部作用を扱う | [security-model.md](references/security-model.md) |
| incident-only: 失敗原因の調査、既知incidentとの照合、回帰分析をする | [incident-analysis.md](references/incident-analysis.md) |

`incident-analysis.md`はtroubleshooting専用であり、正常系の実行前提として読まない。

## 入力

入力 mode を混在させない。

- direct mode（保守・移行検証専用）: `source`（必須）は workflow source または完成済み manifest の絶対 path、`args`（任意）は
  JSON object。JSON を translator なしで受けるのは、それ自体が完全な `dynamic-workflow/v1` execution manifestで、
  schema-validかつ自分自身ではないsource path/hashへ結合され、独立contract verifierがpassした場合だけである。それ以外は
  translated sourceとして扱う。
- compatibility mode: caller skill root、callsiteのdeclared `scriptPath`、exact args JSON file、caller-owned phase JSON、
  current native observation JSON、call IDを受ける。`prepare-call`が
  [workflow-call.schema.json](schemas/workflow-call.schema.json) 適合receiptへ固定し、以後の`source`と`args`は
  そのreceiptからのみ読む。
- `session_root`（必須）: caller / host が caller root、runner root、plugin install/cache、対象repositoryの
  いずれにも含まれない場所へ用意するcanonical絶対path。直下を `bridge/`、`preflight/`、`run/` に分ける。
- `run_root`（必須）: `session_root/run` に置く、
  いずれにも含まれない場所へ用意した、新規・空・writable・non-symlink directoryのcanonical絶対path。
- `bridge_artifact_root`（compatibility modeで必須）: caller / host が同じ外部session root内に用意した、
  execution `run_root`とは別の新規・writable・non-symlink directory。call receiptだけを置く。
- `preflight_artifact_root`（必須）: 同じ外部session rootの `preflight/`。capability snapshot、portable manifest、
  translation prompt/input/review/receiptを置く。`run_root`へinit前artifactを置かない。
- `max_parallel` / `max_agent_runs`（任意）: user 上限。manifest と runtime 上限の最小値を使う。
- `resume`（任意）: 既存 run root。frozen manifest hash が一致する場合だけ再開する。

## 実行フロー

### 0. Routed caller boundary

1. compatibility mode は、既に選択された caller skill が active branch で到達した callだけを受ける。
   runner 内で別branchや説明中の例から新しいcallを推測しない。direct modeは通常の自動routeから選ばない。
2. compatibility callのnative observationはexactに`attempted=false`かつ`available=false`でなければならない。
   これは当該call時点のtool inventoryに対するtyped attestationで、host-globalな不在証明ではない。native attempt後の
   error、timeout、invalid resultをrunnerへfallbackしない。
3. compatibility modeではcaller / hostがplugin install/cache外にfresh session rootを用意し、その中を
   `bridge/`、`preflight/`、空のexecution `run/`へ分ける。runner自身のinstall treeをworkspaceにしない。
   `prepare-call`でreceiptを決定的に生成する。
   caller rootからsourceを解決し、caller `SKILL.md` / source / argumentsのhash、per-call native observation、caller
   pre/post phase・human gateの所有権を固定する。
4. call receiptが欠落・曖昧・不整合なら agentを起動せず `rejected_source`。通常script実行へfallbackしない。

```bash
node [SKILL_DIR]/scripts/workflow-bridge.mjs prepare-call \
  --caller-skill-root <caller-skill-root> \
  --declared-script-path <exact-scriptPath> \
  --args <exact-args.json> \
  --phase-ownership <caller-phase-ownership.json> \
  --native-observation <native-workflow-observation.json> \
  --call-id <stable-call-id> \
  --output <bridge-artifact-root>/<call-id>/workflow-call.json

node [SKILL_DIR]/scripts/workflow-bridge.mjs validate-call \
  --call <bridge-artifact-root>/<call-id>/workflow-call.json>
```

`prepare-call`はpath/hashを手入力させず機械生成し、同一内容・同一outputの再送だけidempotentにする。receipt outputの
既存parentはnon-symlinkとし、caller skill root自体への書き込みは要求しない。生成・再検証はsourceのcaller root
confinement、非symlink、arguments canonical hash、`native_workflow_observation.attempted=false` / `available=false` を確認する。
sourceをimport、eval、実行しない。

### 1. Capability preflight

現在の tool inventory を読み、意味的能力へ対応付け、
[capabilities.schema.json](schemas/capabilities.schema.json) の snapshot を作る。

| 能力 | 必須 | 現行 Codex での例 |
| --- | --- | --- |
| `native_collaboration` | yes | 親が child task を直接管理できる collaboration 面 |
| `spawn` | yes | subagent を起動できる direct tool |
| `collect_or_wait` | yes | handle を指定して完了を待てる tool |
| `stable_handle` | yes | task と agent を一意に対応付ける handle |
| `message` | no | 実行中 agent への追送 |
| `resume` | no | idle agent への follow-up |
| `interrupt` | no | 実行中 agent の停止 |

- `collaboration_modes` や `multi_agent_v2` が true でも、必須能力がなければ `unsupported_runtime`。
- optional 能力がない場合は one-shot task だけを `limited` として許可する。steering 必須 workflow は停止する。
- tool 名の対応はこの時点で決め、portable manifest や state へ具体名を埋め込まない。
- 能力確認のためだけの試験 agent は起動しない。
- task ごとの `requirements.semantic_capabilities`、`requirements.permissions`、`context_policy` を現在の
  snapshot と照合する。unknown / denied / unsupported は利用可能と推測しない。
- `requirements.on_unavailable=skip_optional` は `required=false` にだけ許し、それ以外は開始前に停止する。
- graph-level `required_capabilities`はcore 4とsourceが実際に使う追加operationだけにする。snapshotにある未使用の
  `message` / `resume` / `interrupt`を必須化しない。
- sourceがinput値ごとに能力不足をdomain fallbackへ変換する場合は、静的requirementsではなく投影済みinputへ結合した
  `capability_requests`を使い、利用不能時のvalidated result guardを必須にする。

### 2. Source translation

1. compatibility modeでは検証済みcall receiptのresolved sourceとargumentsだけを入力にし、manifestへ
   `invocation_mode=skill_bridge` と、sourceのreturn expressionを保存した`return_binding`を持たせる。callerの
   outer phase/gateをtaskへ変換しない。
2. direct modeで渡されたJSONが**すでに**完全な`dynamic-workflow/v1` execution manifestとしてschema validationを通り、
   manifest自身ではない実sourceのpath/hashへ結合されている場合だけ`translation_mode=direct`で受理する。任意JSONや
   portable definitionをexecution manifestへ変える決定的normalizerは存在しない。non-self bindingをschema validationだけの
   保証とせず、独立contract verifierがmanifest pathとsource path/hashを照合する。
3. compatibility sourceと、前項を満たさないdirect sourceは、`fork_turns=none` の
   [workflow-translator.md](agents/workflow-translator.md) を起動する。
4. translator は source を読むだけで実行せず、bounded DAG に変換する。source schemaと引数にhard maxがある
   bounded data fan-outは全slotを静的列挙し、validated JSON artifact conditionとoptional fan-in markerへ変換できる。
   上限不明fan-out、unbounded loop / recursion、実行中のdata-dependent graph追加などv1へ意味保存できない処理は拒否する。
   agent/transport 失敗を最終業務successにしない診断分岐だけは、互換経路側でより厳しい
   `workflow_incomplete` に正規化し、その分岐のsource固有returnはmaterializeしない。この差分はmanifestの
   `compatibility_normalizations`へsource span、affected task、trigger、維持するdomain outcomeとともに宣言する。
   sourceがagentへ上流JSONの一部だけを渡すときは`artifact_projection`でexact field setだけをcontrollerに凍結させる。
   source未指定field、source file、question、workspaceDir、sibling contextをagent inputへ追加しない。transport artifact pathと
   source result内のsemantic absolute pathを別契約として保存する。bounded optional slotの有無も同じ投影で判定する場合は
   `when.input_alias`を使い、条件評価のためだけにproducer artifact全体をtyped inputへ追加しない。
   source内で決定的な前処理→agent call→決定的な後処理が連続する場合も、semantic agent taskへ前後処理用source、
   中間artifact、最終化引数を同居させない。各agent taskのvisible inputはsourceの実callsite引数と、sourceがそのagentへ
   明示的に許したoptional read targetだけに一致させ、決定的変換は依存関係を持つ別task/artifactへ分離する。
   source agentのraw result schemaを、sourceが後段で上書き・正規化する値の`const`や狭いenumへ先取りしてはならない。
   raw contractはsource schemaのまま受理し、正規化後の不変条件は後段artifact/result contractで検証する。
5. 別 handle・fresh context の [workflow-contract-verifier.md](agents/workflow-contract-verifier.md) が、
   source と manifest の対応、上限、unsupported construct、write path を独立に確認する。
6. reviewer の dispatch 前に exact prompt と source/manifest input manifest を保存する。input manifestには、実際に
   `init`を実行するrunner rootと、verifierが読むSKILL・role・reference・schema・controllerの必須file inventoryを
   absolute path/raw SHA-256/canonical inventory hashで保存する。controllerはexact file set・順序・root confinement・
   非symlink・live hashを照合し、別install copyや古いcacheを読んだreviewを拒否する。skill_bridgeではinput/receiptを
   call receiptのraw SHA-256、caller phase/gate ownership、native observationへexact bindする。`fork_turns=none`、
   parent context 非継承、`translation_mode`、handle boundary、invocation ID、translator/reviewer handle、prompt/input hash、時刻を
   invocation receipt に記録する。translated modeの実translator handleをreview inputにも事前固定し、review outputを含む
   三者一致とreviewer handleとの差をcontrollerが検証する。direct modeでは三者とも`null`にする。init はそのbytesを
   書き換えず、original receiptも別hash lineageとして保持する。
7. verifier が `pass` しなければ agent execution を開始しない。

### 3. Freeze and initialize

capability snapshot、manifest、translation review一式を `preflight_artifact_root` に保存し、空の `run_root`へ
次を実行する。init が検証済みbytesだけをrunへcopy/freezeする。

```bash
node [SKILL_DIR]/scripts/workflow-control.mjs init \
  --manifest <portable-manifest.json> \
  --translation-review <translation-review.json> \
  --translation-review-receipt <translation-review-receipt.json> \
  --workflow-call <workflow-call.json> \
  --run-dir <run-root> \
  --capabilities <capabilities.json> \
  --max-parallel <user-cap> \
  --max-agent-runs <user-cap>
```

`--workflow-call`は`invocation_mode=skill_bridge`で必須、directでは禁止する。`init` は source を任意 path から受け付けるが、
run root は新規または空に限り、run 内では
`workflow.manifest.json` に凍結する。既存 run の
manifest hash が異なる場合は resume せず、新 run id を作る。user 上限は初回 `init` で manifest/runtime 上限と
比較して凍結し、resume 時に暗黙変更しない。上限を変える場合も新 run とする。

### 4. Schedule bounded waves

`ready` が返した task だけを、実効並列数まで direct collaboration tool で起動する。

```bash
node [SKILL_DIR]/scripts/workflow-control.mjs ready --run-dir <run-root>
```

各 task について:

1. 次の完全なcommandで、重複起動を防ぐ reservation を先に記録する。controller は
   `argument`、上流 `task_result`、上流 `artifact`、validated JSONからexact fieldだけを抽出する`artifact_projection`、
   condition skipを明示markerにする`optional_task_result` / `optional_artifact`、
   hash 固定した外部 `file` を解決し、task 別 input manifest を生成する。

   ```bash
   node [SKILL_DIR]/scripts/workflow-control.mjs prepare \
     --run-dir <run-root> \
     --task <task-id> \
     --invocation <stable-invocation-id>
   ```

2. manifest の `prompt`、型付き `context_policy`、controller が返した input manifest path/hash を subagent に渡して
   起動する。subagent は input manifest 内で hash 固定された共通 `node_result_schema` と task 固有
   `result_contract.schema_path` の両方を読み、前者を output envelope、後者を semantic payload の契約として扱う。
   inline / file-backed の別にかかわらず task 固有 schema 本文は controller-owned file として凍結され、hash だけを渡して
   agent に manifest tree の暗黙探索を要求してはならない。
   同じ input manifest の `output_contract` はresult pathと宣言済みartifact pathのexact setである。agentはfileを
   run rootから解決して書くが、node-result envelopeの `artifacts[].path` にはabsolute pathではなく、このrun-relative
   artifact pathをexactに記録する。
   `artifact_projection`はcontroller-owned JSONだけを読み、producer原本を探索しない。`capability_requests` receiptが
   `unavailable`なら、そのreasonとresult guardに従ってsource固有fallbackを返す。
3. 起動後すぐ、次のcommandで実 handle を結び付ける。

   ```bash
   node [SKILL_DIR]/scripts/workflow-control.mjs bind \
     --run-dir <run-root> \
     --task <task-id> \
     --invocation <stable-invocation-id> \
     --agent <spawned-agent-handle>
   ```

4. `{ "mode": "fresh" }` は `fork_turns=none` を使う。`recent` は exact turn 数を host が指定できる場合だけ、
   `all` は明記された場合だけ使う。指定を別 mode へ丸めない。
5. subagent は割当 output path 以外を書き換えず、input manifest の `node_result_schema.path` を run root から解決し、
   同 manifest の SHA-256 と一致することを確認してから、その schema に従う JSON を保存する。skill install tree 上の
   [node-result.schema.json](schemas/node-result.schema.json) を直接参照して frozen contract を迂回してはならない。
   output envelopeのartifact pathは `output_contract.artifact_paths` のexact run-relative setとし、absolute pathや
   書込み時に解決したfilesystem pathを転記しない。
6. 完了後、次のcommandを実行する。controller は共通 envelope に加えて task 固有
   `result_contract` を検証し、validation receipt を記録する。同じ invocation と同じ hash の再送は idempotent、
   異なる hash は conflict として拒否する。

   ```bash
   node [SKILL_DIR]/scripts/workflow-control.mjs finish \
     --run-dir <run-root> \
     --task <task-id> \
     --invocation <stable-invocation-id> \
     --result <run-root>/<task-result-output-path>.json
   ```

7. wave ごとに `verify` を実行する。ready 0 でも running / gate / blocked があれば success にしない。

### 5. Gates and completion

- `human_gate` は次の完全なcommand以外で閉じない。

  ```bash
  node [SKILL_DIR]/scripts/workflow-control.mjs approve \
    --run-dir <run-root> \
    --task <human-gate-task-id> \
    --decision approve \
    --actor <actor-name>
  ```

  拒否時は`--decision reject`へ置き換える。それ以外の値は受け付けない。
- 外部更新を提案する場合は、先に run 内 action package を生成し、その内容を確認する gate を後段に置く。この
  gate は workflow の意味確認であり、外部操作を実行する権限ではない。
- `ready` が空で workflow が未完了なら、`status` の blocker をそのまま報告する。
- optional を含む全 task が安全な terminal、つまり `completed`、静的 revise handler と downstream が
  正常に閉じた `resolved`、または条件・明示的に許可された capability 不足による `skipped` であり、
  必須 gate が approved、running 0 の場合だけ `workflow_execution_complete`。最終反復の `revise`、handler 不在、
  handler/downstream の failed / blocked は正当な `resolved` ではない。これは最終成功ではない。
- 完了後、reviewer へ渡す exact prompt を run 内に保存し、次を実行する。controller が
  frozen manifest、capability snapshot、translation review/receipt、pre-review state snapshot、全 result、全 gate を列挙した
  canonical input manifest を自動生成し、hash と final review invocation を予約する。その後 `fork_turns=none` の
  [workflow-run-verifier.md](agents/workflow-run-verifier.md) を別 handle で起動し、その実handleを二つ目のcommandで結合する。

  ```bash
  node [SKILL_DIR]/scripts/workflow-control.mjs review-prepare \
    --run-dir <run-root> \
    --invocation <final-review-invocation-id> \
    --prompt <run-root>/<exact-review-prompt-path>

  node [SKILL_DIR]/scripts/workflow-control.mjs review-bind \
    --run-dir <run-root> \
    --invocation <final-review-invocation-id> \
    --agent <fresh-reviewer-handle>
  ```
- verifier は frozen manifest、state snapshot、task results、hash、欠落 task、出力重複を独立検査し、
  [run-review.schema.json](schemas/run-review.schema.json) に従う review を run 内 staging path に保存する。
- reviewerがschema適合reviewをrun内のcanonical `final-review.json`以外のstaging pathへ保存した後、次を実行する。
  `finalize` が invocation / handle / controller-generated input manifest / pre-review state snapshot / manifest hash を
  exact bindし、verdict が pass の場合だけ
  `workflow_complete`。それまで publish や irreversible action を解禁しない。

  ```bash
  node [SKILL_DIR]/scripts/workflow-control.mjs finalize \
    --run-dir <run-root> \
    --review <run-root>/<final-review-staging-path>.json
  ```

- 外部操作のpackageを含む場合だけ、完了後に次を実行する。controllerはpackage、
  gate receipt、pass済みfinal review、action IDs、executor capabilityを
  [action-handoff.schema.json](schemas/action-handoff.schema.json) へexact bindし、二つ目のcommandで再検証する。

  ```bash
  node [SKILL_DIR]/scripts/workflow-control.mjs handoff-prepare \
    --run-dir <run-root> \
    --gate <external-action-gate-task-id>

  node [SKILL_DIR]/scripts/workflow-control.mjs handoff-verify \
    --run-dir <run-root> \
    --gate <external-action-gate-task-id>
  ```

  handoffは常に `not_authorized` であり、外部executorはpackage内の
  targets/scopesを含む新しい承認を別途取得する。

### 6. Compatibility return

compatibility modeだけ、`finalize` 後にverified returnをmaterializeする。
external action packageを持つrunでは、全対象gateについて前節の`handoff-prepare`と`handoff-verify`を
先に通す。1件でもhandoffが欠ける場合、`materialize`は`handoff_missing`でcaller continuationを拒否する。

```bash
node [SKILL_DIR]/scripts/workflow-bridge.mjs materialize \
  --call <same-workflow-call.json> \
  --run-dir <run-root> \
  --output <run-root>/workflow-return.json
```

[workflow-return.schema.json](schemas/workflow-return.schema.json) に適合し、commandが
`workflow_return_ready` と `caller_continuation_allowed=true` を返した場合だけ、`value`をcallerのWorkflow返却値として
渡す。scriptは `workflow_complete`、pass済みfinal review、call/manifest/source/args/return schema/result hashを再検証する。
それ以外のstatusやmaterialize errorではsuccess returnを作らず、callerのpost-workflow phaseを開始しない。
source自身が外部action packageを宣言したrunでは、returnのdiff/valueを直接実行根拠にせず、controller-verified
handoffだけを専用executorへ渡す。caller所有のpost-workflow phaseが初めて外部作用を設計する場合はrunnerがsourceに
存在しないpackage/gateを捏造しない。callerがverified return receiptへ結合した別のaction packageを作り、専用executorが
package SHA-256、action IDs、targets、scopes、preconditionsへ結合した新しいhuman approvalを取得してから実行・read-backする。

## Resume

1. `verify --run-dir <run-root>` で state、source、manifest、既存 result の整合を確認する。
2. stateに `final_review_invocation`、`final_review`、または1件以上の `action_handoffs` があるrunは再開しない。
   controllerは `resume_not_allowed` で拒否するため、そのrunを証拠として保持し、修復は新runで行う。
3. 現在の tool inventory から新しい capability snapshot を作り、同じ manifest と run root に対して `init` を再実行する。
   resume では translation review 引数は不要で、初回 snapshot を上書きせず `capability-receipts/` に新 receipt を追加する。

```bash
node [SKILL_DIR]/scripts/workflow-control.mjs init \
  --manifest <same-portable-manifest.json> \
  --capabilities <current-capabilities.json> \
  --run-dir <existing-run-root>
```

4. `observed_at` が直前 receipt より新しい snapshot だけを追記し、pending task の semantic capability、permission、
   context support を再評価する。能力が失われていれば新規 dispatch せず、能力低下前の snapshot や古い観測へ
   fallbackしない。completed taskだけが使った能力は再要求しない。
5. `status` で running task を列挙する。実 handle の状態を確認できる場合だけ reconcile する。
6. 完了済み task は再実行しない。running の handle が失われた場合は `workflow_incomplete` とし、同じ
   task id へ勝手に新 handle を割り当てない。
7. v1 controller は同じ task の ad-hoc retry/reset を実装しない。修復は manifest に展開した別 task で行う。
   lost handle や abort 済み task をやり直す場合は、完了済み成果物を保持したうえで新 run として明示する。

## 終了状態

- `workflow_complete`: optionalを含む全 task が安全なterminal、全 gate、独立 final verification が完了。
- `workflow_incomplete`: 一部完了、timeout、lost handle、capacity exhaustion、必要 result 欠落。
- `unsupported_runtime`: 必須 capability、source construct、policy permission が不足。
- `rejected_source`: source と manifest が対応しない、非 bounded、危険な side effect を含む。
- `cancelled`: user または human gate が停止を選択。

`workflow_incomplete` と `unsupported_runtime` は degraded success ではない。完了済み成果物は保持するが、
final result や publish を成功扱いしない。

## 完了条件

- frozen manifest と capability snapshot が存在し、hash が state と一致する。
- capability snapshot は観測時刻、source trust、secret-bearing、filesystem/tool/external mutation enforcement、
  fork behaviorを型付きで持ち、untrusted/secret-bearing時は必要な隔離がenforcedである。
- translation review は別 handle の fresh invocation receipt、input/receipt/outputで一致するtranslator handle、exact prompt/input hash、source hash、manifest canonical hash、
  invocation より後の review timestamp に結合されている。
- prepare 済み task は controller-generated input manifest を持ち、宣言された argument/result/artifact/projection/file の exact set と一致する。
- task input manifest は dispatch 時の current capability receipt、意味能力・permission・context assessment、
  条件付きcapability request receipt、result contract hashに結合されている。
- task 数、完了、失敗、skip、running の合計が一致し、optionalを含め failed / blocked / rejected が0。
- completed / resolved task の result が共通 schema と task 固有 result contract の双方に適合し、state の result hash、
  schema hash、validation receipt と一致する。
- 並列 output path に重複がない。
- generator/verifier の独立性が manifest で要求された場合、異なる task id と agent handle である。
- [workflow-run-verifier.md](agents/workflow-run-verifier.md) が pass。
- compatibility modeでは検証済み`dynamic-workflow-call/v1`と`invocation_mode=skill_bridge`、call hashに結合した
  `return_binding`が存在し、finalize後に[workflow-return.schema.json](schemas/workflow-return.schema.json)適合returnが
  materializeされている。caller continuationはそのreceiptの`allowed=true`だけを根拠にする。
- 外部更新要求を含む場合、workflow 内では exact action package と human gate までで停止し、外部実行 skill が
  controller生成・検証済みhandoffだけを受け取り、package hash・action IDs・targets・scopes に結合した新しい承認を
  必要とすることが明記されている。

## 禁止事項

- source の basename による特別扱い。
- config flag だけを見た supported 判定。
- workflow source の実行、`eval`、dynamic import、shell fallback。
- native `Workflow` attempt後のcompatibility fallback、またはnativeとrunnerの二重実行。
- 説明、参考例、未到達branch、通常script実行からのcompatibility推測。
- caller root以外を基準にした`scriptPath`解決、`args`の補完・rename・型変換。
- caller-owned gateとrunner内gateのreceipt共有、未検証return後のpost-success phase開始。
- capacity 不足時の silent truncation。
- lost handle の無記録 respawn。
- null / unknown / missing result の成功化。
- transport failure を source 固有の業務successへ変換すること。非success診断分岐は
  `workflow_incomplete` へ強化し、caller の成功後 phase を開始しない。
- verifier と producer の同一 handle 化。
- workflow 内からの commit、push、PR、publish、外部送信。
