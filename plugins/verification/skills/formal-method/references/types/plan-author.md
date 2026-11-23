<!-- 生成物: scripts/role-references.mjs が references/artifact-formats.md から作る。ここを直さずに正本を直して、node scripts/role-references.mjs を流す -->

# 型の抜粋（plan-author）

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

## 担当の成果物

担当は自分の `attempts/<task_id>/` に書き、返り値の `outputs` で参照する。担当が書く全ての `Ref`（`outputs[].ref`・`query_ref`・`input_refs`・`mutation_ref`・`record_ref`・`worklog_ref` など）は、run の領域からの相対 path で、`attempts/<task_id>/` で始まるか、task が渡した資料を指す。理由: 起点を 1 つにすると、CLI も外の検査も参照を同じ規則で解ける。

- **担当が書く全ての `.smt2`**（モデル作成役の性質と sanity の query、分割作成役の契約と合成の条件の query、計画作成役の変異）は、`(check-sat)` をちょうど 1 つ、ファイルの最後の form として持ち、`get-model`・`set-option`・`push`・`pop`・`reset`・`exit`・並列の設定を書かない。
- **節の名前（`:named`）**: モデル作成役の性質の query と、計画作成役の変異は、トップレベルの assert を全て `(assert (! <項> :named <name>))` の形で書く。`<name>` は `Id` の文字で、その性質の `clauses[].name` のどれかと一致し、query の中で重ならない。性質の query の名前の集合は `clauses` の名前の集合と一致し、変異の名前の集合は検出役の性質の `clauses` の名前の集合と一致する。違反はモデル化の照合（性質の query）と計画の照合（変異）の欠陥で、形の違い・名前の無い assert・名前の重なりは `syntax`、`clauses` に無い名前・assert の無い節は `reference` である。sanity・契約・合成の条件の query には当てない。理由: 静的な確認は名前で節を切り取る（[architecture.md「静的な確認」](../architecture.md#静的な確認)）。
  - 照らすのは、そのファイルを書いた役の段の照合である。モデル作成役の query はモデル化の照合（query の構文の検査）、分割作成役の query は計画の段の分割の照合、変異は計画の照合で照らす。違反はその役の修正の巡の欠陥になる。修正の巡の後も違反が残った `.smt2` を `input_refs` か `mutation_ref` に持つ実行は、計画の照合で欠陥とし、[検査](../artifact-formats.md#検査sp-010)の節のとおり実行しない。理由: 修正の巡は欠陥を見つけた照合の役に戻るので、ファイルを書いた役の段で照らさないと、直せない役に欠陥が戻る。

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

## partitions（分割作成役。候補が 2 つ以上のときだけ）

```text
PartitionsFile = { schema: "formal-method.partitions/1",
  decisions: [{ candidate_id: Id, adopted: boolean, reason: string }]+,
  adopted: boolean, reason: string,
  parts: [<Decomposition.parts の要素>], boundaries: [<Boundary から responsible を除いたもの + responsible>],
  contracts: [{ id: Id, model_id: Id, derived_from: Id, part_id: Id, statement: string, query_ref: Ref }],
  composition_conditions: [{ id: Id, model_id: Id, derived_from: Id, statement: string, query_ref: Ref, depends_on: [Id] }] }
```

## plan と mutations（計画作成役）

```text
PlanFile = { schema: "formal-method.plan/1",
  selection: [{ property_id: Id, candidates: [Candidate]+, chosen: { technique: string, tool: string }, reason: string }],   // chosen.tool は下の「道具の名前」
  checks: [{ id: Id, kind: "property" | "composition" | "contract", target_id: Id,   // property_id / condition_id / contract_id
             model_id: Id, input_refs: [Ref]+, expected: "unsat" | "sat",
             assumptions: [string], scope: string, tool_time_limit_seconds: int≥1, depends_on: [Id] }],
  sanity: [{ id: Id, model_property_id: Id, input_refs: [Ref]+, tool_time_limit_seconds: int≥1 }] }
MutationsFile = { schema: "formal-method.mutations/1",
  mutations: [{ id: Id, property_id: Id, mutation_ref: Ref, expected_violation: "sat" | "unsat", detector_check_id: Id }],   // mutation_ref は計画作成役自身の attempts/<task_id>/ の中
  unavailable: [{ property_id: Id, reason: string, alternative: string | null }] }
```

- `tool_time_limit_seconds` ≤ `TOOL_TIME_LIMIT_MAX_S`（[CLI 契約](../cli-contract.md#定数)）。
- `checks[].expected` は `unsat` である（`property`・`contract`・`composition` の query は「前提 ∧ ¬性質（契約・全体の性質）」なので）。`sat` の検査は計画の欠陥とする。
- **変異のファイル**: 変異の `.smt2` を書くのは計画作成役だけである。`mutation_ref` は、その計画作成役自身の `attempts/<task_id>/` で始まる（task が渡した資料を指す例外は、`mutation_ref` には当てない）。外れれば計画の欠陥（修正の巡の対象）。台帳の entry の `producer` はその計画作成役の `task_id` である。理由: 変異は計画作成役の成果物で、計画の照合で `.smt2` の規則を照らし、直せる役に修正の巡を戻すため。他の役のファイルを変異にすると、書いた者と台帳の `producer` が食い違う。
- **性質の検査の入力**: `kind: property` の検査の `input_refs` は、`target_id` のモデルの性質の `query_ref` を含む。含まなければ計画の欠陥（`reference`。修正の巡の対象）とする。理由: 静的な確認は、その query の節の印で検査の入力を切り取る（[architecture.md「静的な確認」](../architecture.md#静的な確認)）。
- **変異の節**: 変異は検出役の性質の query と同じ節の名前の集合を持ち（[担当の成果物](../artifact-formats.md#担当の成果物)の節の名前）、出所の規則（`role: "rule"`）の節の項だけを 1 つ以上変える（性質の否定・前提の節の項と、assert でない form は変えない）。名前の照合は計画の照合（違反は修正の巡の対象）、規則の節だけを変えるかは静的な確認 `mutation_scope`（[確認](../artifact-formats.md#確認sp-004005012)）が確かめる。理由: 前提か性質の否定を変えた変異は、規則を変えていても自明な違反を作れるので、検査が規則の違反を見つけられるかを示さない（SP-012）。
- **変異の無い性質の `detection`**（依頼者の決定）: 欠陥の残らない変異を 1 つも持たない性質は、`unavailable` の有無と `alternative` の有無によらず、`status: "検出能力未確認"`・`mutations: []`（`detection_performed: false`）とする。`reason` には、`alternative` の文（あれば全て、`unavailable` の順に）と「別の方法の確認の結果が無い」ことを書く。欠陥で変異を除いた性質では、この 2 つに加えて、除いた変異の計画の id も書く（3 つとも書き、片方で代えない）。
  - 理由: SP-012 は、別の方法による検出能力の確認の「結果」を示すことを求める。`alternative` の文は方法の宣言で、どの担当の返り値にも、その方法で確認した結果の欄が無い。将来、担当の返り値に確認の結果の欄を足せば、その結果で `別の方法で確認` を使える。
- 必要な性質ごとに、`mutations` の要素か `unavailable` の要素が 1 つ以上ある。この照合は計画作成役が返した計画に当て、欠陥の残った変異を除いた後には当て直さない。変異を全て除かれて `unavailable` も無い性質は、変異も別の方法も無いので、`detection` は `status: "検出能力未確認"`・`mutations: []` で、`reason` に除いた変異の計画の id を書く（SP-012）。性質の判定は `detection_performed: false` で決まる（検出能力未確認は判定に混ぜず、`decideStatus` の述語 7 で `完了` を妨げる）。
- 形式化できる必要な性質（問いに依存するものを除く）ごとに、`selection` の要素がちょうど 1 つある。欠けか重なりは計画の欠陥（修正の巡の対象）とする。修正の巡の後も残れば、その性質の検査（下の「道具の名前」の照合と同じく `inventory_property_ids` と `derived_from` で辿る `property`・`contract`・`composition` の検査）も欠陥の残った計画の要素として実行しない（[検査](../artifact-formats.md#検査sp-010)の節）。そのため性質の判定は検査の欠けと同じく `未確認`（`no_suitable_tool` なら `未実行`）で、run は `decideStatus` の述語 1（必要な性質が検証の成功でない）で `停止` になる。
- **道具の名前**: CLI が実行できる道具（adapter のある道具。今は Z3 だけ）は、`Candidate.name` と `chosen.tool` に adapter の id（`z3`。`ModelFile.adapter_id` と同じ値）を書く。他の道具は、その候補の `name` をそのまま `chosen.tool` に書く。
  - 計画の照合は、各 `selection` の要素について、`candidates` に `role: "検証器"`・`name: "z3"` の候補があること（SP-007 の Z3 を含むこと）と、`chosen.tool` がその要素の `candidates` のどれかの `name` であることを確かめる。違えば計画の欠陥（修正の巡の対象）である。
  - `chosen.tool` が `z3` でない性質の検査も計画の欠陥とする。対象は、`kind: property` で `target_id` のモデルの性質の `inventory_property_ids` にその性質を含む検査、そのモデルの性質を `derived_from` に持つ契約の検査（`kind: contract`）、そのモデルの性質を `derived_from` に持つ合成の条件の検査（`kind: composition`）である。理由: z3 で実行すると、`method.chosen` が実行していない道具を示す（SP-007）。
  - 理由: 名前の書き方を決めて照合で拒めば、`Z3` のような表記の揺れが修正の巡で直り、全ての性質が `未実行` に倒れない。候補に無い名前を選んだ計画は、選んだ根拠が結果に残らない。
  - 結果の `method` は、`selection` の要素をそのまま写したもの（CLI が変えるのは、`comparison_conditions` を足すことと、一致を確かめられない候補の `performance_claim` を null にすることだけ）で、名前もこの規則のとおりである。
- **検査の欠け**: 次の各々に、`PlanFile.checks` の要素（`kind` と `target_id` が合うもの）が 1 つ以上ある。無ければ計画の欠陥（修正の巡の対象）とする。
  - モデルの性質（`ModelFile.properties[].id`。`kind: property`）。ただし、その `inventory_property_ids` の全てが、問いに依存する（作成役の `blocked_by_question` に挙がる）か `no_suitable_tool` が true なら除く。
  - モデルの性質の `sanity`（`PlanFile.sanity[].model_property_id`）。除く場合は上の `kind: property` の検査と同じ。
  - 部分の契約（`contracts[].id`。`kind: contract`）と合成の条件（`composition_conditions[].id`。`kind: composition`）。`derived_from` のモデルの性質の `inventory_property_ids` が指す性質（契約の判定の「親の性質」と同じ範囲）の全てで `no_suitable_tool` が true なら除く。
  - 欠けは、性質に関わるモデルの性質の一部だけで起きてもよい。その場合も、その性質の `deterministic_confirmed` は false で、残りのモデルの性質の検査が全て成功しても `検証済み` にならない（段 5 の `未確認`。`成功` でない検査があれば段 1 の値）。
  - 修正の巡の後も欠けが残れば、止めずに次の段へ進む。計画作成役が返らないか `cannot_proceed` を返して計画が無いときも、全ての検査が欠けたものとして同じに扱う。その性質の mapping の 形式化 の行は `check_ids` が空で `reason` を持ち、性質の判定は `未確認`（SP-007 なら `未実行`）になる。検査の無い契約は `check_verdicts` が空なので `検証済み` にならず、検査の無い合成の条件があれば、それを `derived_from` で指す親の性質は `検証済み` にならない。
- **`no_suitable_tool` の決め方**（性質ごと）: 準備で z3 を見つけられないか版を読めなかったとき、又はその性質の `PlanFile.selection[].chosen.tool` が CLI の持つ adapter の id（`z3`。上の「道具の名前」）と一致しないときだけ true。計画が無い性質と、修正の巡の後も `selection` の要素が無いか 2 つ以上残った性質では、準備の結果だけで決め、`method` は null とする。理由: CLI が実行できるのは adapter のある道具だけなので、それ以外を選んだ性質には、実行できる適した道具が無い（SP-007）。
- `MutationsFile.mutations[].detector_check_id` は `kind: property` の検査で、その `target_id` は同じ要素の `property_id` である。

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
