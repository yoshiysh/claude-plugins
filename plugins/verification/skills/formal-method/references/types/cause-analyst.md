<!-- 生成物: scripts/role-references.mjs が references/artifact-formats.md から作る。ここを直さずに正本を直して、node scripts/role-references.mjs を流す -->

# 型の抜粋（cause-analyst）

この役が読み書きする型だけを [成果物の形式](../artifact-formats.md) から抜き出したもの。形と値の正本は成果物の形式で、CLI はそれで照合する。

## 共通の型

```text
Id          = string                       // 英数字・「-」「_」「.」。同じ種類の中で一意
Sha256      = string                       // "sha256:" + 64 桁の小文字 16 進
Ref         = string                       // run の領域（<run_id>/）からの相対 path か、対象のファイルを指す "target:<target_id>/<FilePath>"（担当に渡す資料の
                                           // ref。path は元のファイルの絶対パス）。この文書の全ての Ref に共通（担当が書く ref を含む）
RefHash     = { ref: Ref, hash: Sha256 | "unreadable", spans?: [{ span: Span, hash: Sha256 }] }   // spans は範囲を渡した対象のファイルだけ（下の「担当に渡す資料」）。
                                           // 指紋を取る時点で読めないファイルは "unreadable"（spans を持たない。対象のファイルなら集約の段で 対象の変化）
Span        = string                       // "L<開始>-L<終了>"。1 始まり、両端を含む、開始 ≤ 終了
FilePath    = string                       // 対象の根からの相対 path。"/" 区切り、"." と ".." を含まない。単一のファイルの対象では、そのファイル名。除いたディレクトリを指すときだけ末尾に "/" を付ける
SourceRef   = { target_id: Id, file: FilePath, span: Span }
Stage       = "受付" | "洗い出し" | "モデル化" | "計画" | "実行" | "確認" | "集約"
Measure     = { value: number, unit: "ms" | "bytes" | "count" | "tokens" }
            | { status: "取得できず", reason: string }
            | { status: "該当なし", reason: string }
RecordKind  = "request" | "target_snapshot" | "document_rules" | "inventory" | "model" | "mapping" | "partitions" | "material_view"
            | "plan" | "mutations" | "query" | "execution_evidence" | "worklog" | "review_record" | "judgments" | "ledger"
            | "result" | "report" | "salvage_worklog" | "salvage_ledger"
ExecKind    = "property" | "composition" | "contract" | "sanity" | "mutation" | "replay" | "ablation"   // ablation は静的な確認の実行
```

## model（モデル作成役）

```text
ModelFile = {
  schema: "formal-method.model/2",
  model_id: Id, adapter_id: "z3",
  covers: <Model.covers と同じ形>,
  state_machine: StateMachine | null,
  no_state_machine_reason: string | null,  // state_machine が null のときだけ非 null
  io_contracts: [{ id: Id, pre: string, post: string, source_ids: [Id] }],
  properties: [{ id: Id, inventory_property_ids: [Id]+, query_ref: Ref, expected: "unsat" | "sat",
                 assurance: Assurance,
                 clauses: [Clause]+,
                 sanity: [{ kind: "assumptions_consistent" | "initial_exists" | "nontrivial_witness", query_ref: Ref }] }],
  behavior: <Model.behavior と同じ形>,
  source_diagrams: [{ source: SourceRef, format: "mermaid" }],
  omitted_edges: [{ from: string, event: string, condition: string }]
}
Clause = {                                 // 性質の query の節（トップレベルの assert 1 つ）
  name: Id,                                // その assert の :named の名前
  role: "rule" | "premise" | "goal",       // 出所の規則・前提・性質の否定
  source_ids: [Id],                        // inventory の要素の id。rule は 1 つ以上
  basis: "出所の文" | "外部の依存" | "作成役の仮定" | null,   // premise は非 null
  external_dependency_id: Id | null,       // basis が 外部の依存 のときだけ非 null。inventory の external_dependencies[].id
  note: string
}
StateMachine = {
  states: [string]+, events: [string]+, initial: string,
  variables: [{ id: string, sort: string, domain: string, init: string }],   // init は SMT-LIB の項
  transitions: [{ id: Id, from: string, event: string, to: string,
                  guard: string,                       // SMT-LIB の項（真なら "true"）
                  updates: [{ var: string, term: string }],   // SMT-LIB の項
                  unchanged: [string], source_ids: [Id] }],
  forbidden: [{ from: string, event: string, source_ids: [Id]+ }],
  uncovered: [{ from: string, event: string, missing_info: string }],
  goals: [{ state: string, kind: "目標" | "完了" | "停止" | "再開先", property_id: Id }]
}
```

- `goals[].property_id` は、同じ `ModelFile` の `properties[].id` に実在する参照である。モデル化の照合で確かめ、無ければ `reference` の区分の欠陥（修正の巡の対象）とする。対象外として飛ばさない。理由: 目標への経路は、その性質の検査で確かめる（`Paths.targets[].property_id`）。指す性質が無い目標を飛ばすと、確かめていない目標が結果から消える。修正の巡の後も残れば、その目標は `Paths.targets` に載せず、`Paths.unverified` に理由「目標の性質が無い」で載せる。
- query のファイル（`.smt2`）は、[担当の成果物](../artifact-formats.md#担当の成果物)の `.smt2` の規則と節の名前の規則に従う。性質の query は「出所の規則と前提と性質の否定」で `expected: "unsat"`、sanity の query は `sat` を期待する。SMT の記号の名前は `variables[].id` と同じにする。
- **節の照合**（モデル化の照合）: `clauses` の名前の重なりと `goal` の無い性質は `other`、出所の無い `rule`・`basis` の無い `premise`・`basis` と `external_dependency_id` の食い違いは `syntax`、inventory の要素に無い `source_ids`・inventory の `external_dependencies` に無い `external_dependency_id`・query で宣言されていない `assurance.scope_variables` は `reference` の欠陥とする。
- 古い形（`formal-method.model/1`、`clauses` の無い性質）は形の違い（`syntax`）として拒む（後方互換性を持たない。`docs/guidelines/agent-work.md`「最小の成果を同じファイルで育てる」）。

## mapping（モデル作成役）

```text
MappingFile = { schema: "formal-method.mapping/1",
  model_id: Id,                            // 対応付けるモデル。モデルごとに 1 つの MappingFile
  rows: [{ source: Pointer, property_id: Id, model_element: string,
           relation: "形式化" | "形式検証でない確認" | "範囲外" | "対応なし", reason: string | null }] }
```

`check_ids` は計画の後に CLI が埋め、`Model.mapping` になる。

- モデル作成役は 1 つの task で全てのモデルを作り、`outputs` にモデルごとの `model` と `mapping` を並べる。`MappingFile.model_id` が `ModelFile.model_id` と一致する組で結び付ける。どのモデルにも `MappingFile` がちょうど 1 つあり、どの `MappingFile` も実在のモデルを指す。理由: モデルの数と分け方は、inventory の全体を見て初めて決まる。モデルごとに task を出すには、その数を task の前に決める者が要る。
- 退けた案: モデルごとに model-author の task を出す。

## 検査（SP-010）

```text
Check = {
  id: Id,
  kind: "property" | "composition" | "contract",
  model_id: Id,
  assumptions: [string],
  scope: string,
  unit: string,                            // 実行の単位（道具と query の参照）
  tool_time_limit: { seconds: int≥1, source: "計画（内部の上限 TOOL_TIME_LIMIT_MAX_S 以下）" },
  state: "実行した" | "実行していない",
  verdict: CheckVerdict,
  end: End,
  reason: string,
  evidence_refs: [Ref],
  completed_scope: string | null,          // 途中で止まったときだけ非 null
  incomplete_scope: string | null
}
CheckVerdict = "成功" | "反例" | "未実行" | "unknown" | "時間切れ" | "実行失敗"
```

- `checks` は、計画の `PlanFile.checks` の要素のうち、修正の巡の後に計画の照合の欠陥が残らなかったものごとに 1 つ、同じ `id` と `kind` で持つ。SP-010 の「定めた全ての検査」は、この 3 種である（確認用の実行は `confirmations`）。
  - 欠陥が残った計画の要素（検査・sanity・変異。`.smt2` の違反、道具の名前の違反、`target_id` の種類の違反などの全て）は、定めた検査に数えず、実行しない。`checks[]`・`confirmations` と、それを指す `check_ids` に載せず、`unverified[]` に、`item` を「計画の欠陥: <計画の id>」、`reason` を残った欠陥の理由として載せる。その結果、性質の検査が欠ければ [検査の欠け](../artifact-formats.md#plan-と-mutations計画作成役) と同じ判定になる。理由: 欠陥の残った query を実行すると、性質の判定が欠陥の種類で `実行失敗` にも `未実行` にもなり、計画の欠けとしての扱い（`未確認`）と分かれる。
- `state: "実行していない"` の検査は `verdict: "未実行"`、`end.started: false`。
- 検査を指す欄に入る `kind` は次のとおりで、`Check` は指す側の欄を持たない。
  - `PropertyResult.check_ids`・`Model.mapping[].check_ids`: `property` と `composition` だけ。性質と検査の結び付きの正本は `PropertyResult.check_ids`。ある性質の `check_ids` は、その性質を `inventory_property_ids` に含むモデルの性質の `kind: property` の検査と、そのモデルの性質を `derived_from` に持つ合成の条件の `kind: composition` の検査である。
  - `composition_conditions[].check_ids`: `composition` だけ。
  - `Contract.check_ids`: `contract` だけ。CLI が、`PlanFile.checks` のうち `kind: "contract"` で `target_id` がその契約の id の検査を、計画の順に埋める。そのため `kind: "contract"` の検査は、ちょうど 1 つの `Contract.check_ids` に現れ、`PropertyResult.check_ids` には現れない。
  - 理由: AC-09 の外からの照合は、`properties[].check_ids` が指す `checks[].verdict` に集約の規則を当て直す。部分の契約は必要な性質でない（[分割と合成](../artifact-formats.md#分割と合成sp-008009)）ので、その検査が性質の集合に混ざると、当て直した判定が実装の判定と食い違う。

## 反例と原因（SP-011）

```text
Counterexample = {
  id: Id, property_id: Id, sources: [Pointer]+, check_id: Id,
  input_and_trace: string, violated_condition: string,
  replay: { confirmation_id: Id, steps_ref: Ref }
}
Cause = {
  subject: { kind: "counterexample", id: Id } | { kind: "combination", model_id: Id, state: string, event: string } | { kind: "question", id: Id },
  cause: "要求の不足" | "形式モデルの欠陥" | "分類処理の欠陥" | "対象が性質を満たさない" | "原因未確認",
  grounds: string,
  classified_by: string                    // 分類した担当の task_id。担当を出さなかったときだけ "cli"
}
Question = { id: Id, missing_decision: string, affected: [string]+, options: [string]+ }
```

- `Counterexample.check_id` は、`kind` が `property` か `composition` で `verdict` が `反例` の検査を指す（`kind: "contract"` の検査からは作らない。[分割と合成](../artifact-formats.md#分割と合成sp-008009)）。`replay` の確認の作り方と `steps_ref` の指す先は [CLI 契約の証人](../cli-contract.md#証人)。
- 全ての反例と `対応できていない` 組合せは、`causes` に 1 つずつ要素を持つ。
- `questions` に入るのは、原因の分類が `要求の不足` の問いだけである。

## 担当の返り値

`attempts/<task_id>/return.json`（claim の Task の `result_path`）。担当はここに書いてから `submit` を流す。Workflow の返り値に内容を書かない（`run-daemon` は返り値を読まない）。

```text
AuthorReturn = {
  task_id: Id,
  status: "done" | "needs_answer" | "cannot_proceed",
  outputs: [{ kind: "inventory" | "model" | "mapping" | "partitions" | "plan" | "mutations", ref: Ref }],
  questions: [Question],                  // needs_answer のとき 1 つ以上
  blocked_by_question: [Id],              // 回答を待つ問いに依存する inventory の性質の id（問いの id ではない）
  reason: string | null,                  // cannot_proceed のとき非 null
  worklog_ref: Ref
}
ReviewReturn = {
  task_id: Id, unit_id: Id,
  perspective: "extraction" | "nonformal" | "fidelity" | "composition",
  result: "成り立つ" | "成り立たない" | "確認できず",
  findings: [{ ref: string, kind: "omission" | "addition" | "meaning_change" | "clause_role" | "assurance_overclaim" | "vacuity" | "mutation_invalid" | "boundary_gap" | "circular_assumption" | "other", note: string }],
  judgments: [{ id: Id, result: "成り立つ" | "成り立たない" | "確認できず", note: string }],   // 忠実さだけ: そのモデルの判断を要する項目の全てに 1 つずつ。他は []
  record_ref: Ref, worklog_ref: Ref
}
CauseReturn = {
  task_id: Id, unit_id: Id,
  cause: "要求の不足" | "形式モデルの欠陥" | "分類処理の欠陥" | "対象が性質を満たさない" | "原因未確認",
  grounds: string,
  questions: [Question],                  // cause が 要求の不足 のとき 1 つ以上、他は []
  record_ref: Ref, worklog_ref: Ref
}
```

- 返り値が無い、形が違う、`outputs`・`record_ref`・`worklog_ref` が attempt の領域の外か存在しない、`task_id`・`unit_id` が task と違う、忠実さの `judgments` がそのモデルの判断を要する項目にちょうど 1 つずつ答えていない場合は、成功に数えない（作業記録の失敗の欄に理由が残る）。
- `submit` はこれらの場合に `ok: false` と原因を返し、担当は直して出し直せる（`cannot_proceed` は出し直させない。上限は [CLI 契約の依頼と応答](../cli-contract.md#依頼と応答)）。呼び出しを閉じるまでに受理されなかった task（これらの場合のまま閉じた、`cannot_proceed`、取らなかった、取ったまま出さなかった。[CLI 契約](../cli-contract.md#受け箱)）は、停止の理由 `担当の失敗` を、その task の `context.stage` を段として記録する。`担当の失敗` は中断の理由ではない。run は止めずに次の段へ進み、その担当が作るはずの成果物は未作成になる。`context.perspective` が非 null の task なら、その unit の確認は `result: "確認できず"` の `Confirmation` になる（[確認](../artifact-formats.md#確認sp-004005012)）。原因の分類役の task なら、CLI がその `subject` の `Cause` を `cause: "原因未確認"`・`grounds` = `担当の失敗` の `detail` と同じ文・`classified_by` = その `task_id` で作る。原因の分類役を出さなかったとき（時間の上限か保存の失敗）は、同じ形で `grounds` = 出さなかった理由の文・`classified_by: "cli"` とする（全ての反例と組合せが `causes` に 1 つずつある規則を保つ。問いの `subject` なら、分類が `要求の不足` でないので問いとして返さない）。理由: 他の性質の検証を続ける（依頼者の決定）。そのうえで、`stop_report.stage` が失敗した処理の段になる（中断の理由が無いとき、段の並びで最も上流の段を取る規則による。AC-19）。
- **`AuthorReturn.blocked_by_question`**（担当の指示と `agent-obligations.md` のとおり、性質の id）:
  - 各 id は、モデル作成役・計画作成役では `context.property_ids` に、抽出役では返した inventory の `properties[].id` にある。無ければ返り値の形の違い（成功に数えない）。
  - 抽出役では、性質ごとの `Inventory.properties[].blocked_by_question`（問いの id）が依存の正本で、`AuthorReturn.blocked_by_question` はそれが空でない性質の id の集合と一致する。違えば形の違い。
  - モデル作成役・計画作成役が挙げた性質 P の `depends_on_questions` は、その返り値の `questions` のうち `affected` に P の id を含むものの id。1 つも無ければ、その返り値の全ての問いの id とする。
- **性質の id の名前空間**:
  - inventory の性質の id: `PropertyResult.id`、`Inventory.properties[].id`、`AuthorReturn.blocked_by_question`、`context.property_ids`、`nonformal-<id>`、`Confirmation.property_ids`、`PlanFile.selection[].property_id`（道具の選択は、結果の性質ごとの `method` になるため）、`MutationsFile.unavailable[].property_id`（検出能力の結果は性質ごとの `detection` になるため）。
  - モデルの性質の id（`ModelFile.properties[].id`。run の全てのモデルを通して一意）: graph の `prop:<model_id>/<id>`、`Confirmation.model_property_id`、`Judgment.model_property_id`、`PlanFile.checks[].target_id`（`kind: property` のとき）、`PlanFile.sanity[].model_property_id`、`MutationsFile.mutations[].property_id`（検出役の検査がモデルの性質の検査であるため）。
  - `PlanFile.checks[].target_id` は、`kind: composition` なら `composition_conditions[].id`、`kind: contract` なら `contracts[].id` である。
  - 2 つの名前空間は `ModelFile.properties[].inventory_property_ids` で結び付く。

## claim の Task

```text
Task = {
  task_id: Id,
  role: "extractor" | "model-author" | "partition-author" | "plan-author"
      | "extraction-reviewer" | "fidelity-reviewer" | "assurance-reviewer" | "composition-reviewer" | "cause-analyst",
  model: string, effort: string,                // workers の行と同じ値（正本は scripts/lib/roles.mjs）
  instructions: [string, string, string],       // 担当の指示（agents/<role>.md）、その役の分の義務（references/obligations/<author|confirmer>.md）、
                                                // その役の型の抜粋（references/types/<role>.md）の絶対 path。後の 2 つは scripts/role-references.mjs が
                                                // 正本（agent-obligations.md・この文書）から作る生成物
  attempt_dir: string, result_path: string,     // 絶対 path。result_path は attempt_dir の return.json
  context: TaskContext
}
TaskContext = {
  run_dir: string,                        // 絶対 path。Ref の起点
  stage: Stage,                           // task を出した段。担当の作業記録の stage はこの値
  unit_id: Id | null,                     // 独立検証者と原因の分類役だけ非 null。返り値の unit_id はこの値
  perspective: "extraction" | "nonformal" | "fidelity" | "composition" | null,   // 独立検証者だけ非 null
  target_id: Id | null,                   // extractor と perspective が extraction のとき非 null
  model_id: Id | null,
  property_ids: [Id],
  candidates: [{ id: Id, nodes: [string]+ }],   // partition-author だけ空でない（Decomposition.candidates と同じ id）
  subject: <Cause.subject と同じ形> | null      // cause-analyst だけ非 null
}
```

## 作業記録

担当は `attempts/<task_id>/worklog.json`、決定的な処理は `worklogs/cli-<段>.json` に書く（PR-028・040）。担当の作業記録の `stage` は、task の `context.stage`（task を出した段）である。`run-daemon` は、入った全ての段（止まった段を含む）について `worklogs/cli-<段>.json` を、その段を出る前か停止の手順の中で書く。書けなければ `records.unsaved` に載せる。

```text
Worklog = {
  schema: "formal-method.worklog/1",
  role: string,                           // 担当の role、決定的な処理は "cli"
  task_id: Id | null,                     // cli は null
  stage: Stage,
  target: string,                         // 対象
  inputs: [RefHash],                      // 対象に加えて渡されたもの
  actions: string, results: string, grounds: string,
  failures: [string], unconfirmed: [string],
  unreadable_inputs: [{ ref: Ref, reason: string }],
  document_rules: { ref: Ref, version: Sha256 }
}
```

- 文の欄（`actions` など）は、文書の一般規約（`document_rules` が指す写し）に従って書く。
- 担当の作業記録の `inputs[].hash`・`inputs[].spans[].hash`・`document_rules` は、担当が省いてよい。`submit` の照合で、CLI が省いた値を補い（指紋はその担当の `materials`（最初の `query` の時点の指紋）の値。`materials` に無い ref と範囲は今のファイルとその範囲の行で求める。`document_rules` は `claim` の値）、`worklog.json` を書き直してから照合する。担当が書いた値が CLI の値と違えば、作業記録の欠陥として `problems` で差し戻す。登録する作業記録は補った後の、この形のファイルである。理由: 指紋を CLI だけが持てば、担当が手で求めた値との食い違いが起きない。
- salvage の作業記録は時刻を含まない。
