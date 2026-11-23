<!-- 生成物: scripts/role-references.mjs が references/artifact-formats.md から作る。ここを直さずに正本を直して、node scripts/role-references.mjs を流す -->

# 型の抜粋（composition-reviewer）

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

## partitions（分割作成役。候補が 2 つ以上のときだけ）

```text
PartitionsFile = { schema: "formal-method.partitions/1",
  decisions: [{ candidate_id: Id, adopted: boolean, reason: string }]+,
  adopted: boolean, reason: string,
  parts: [<Decomposition.parts の要素>], boundaries: [<Boundary から responsible を除いたもの + responsible>],
  contracts: [{ id: Id, model_id: Id, derived_from: Id, part_id: Id, statement: string, query_ref: Ref }],
  composition_conditions: [{ id: Id, model_id: Id, derived_from: Id, statement: string, query_ref: Ref, depends_on: [Id] }] }
```

## 分割と合成（SP-008・009）

```text
Decomposition = {
  graph: { nodes: [{ id: string, kind: "variable" | "transition" | "property" | "smt_declaration" | "smt_definition" | "smt_assertion", location: Location }],
           edges: [{ id: string, from: string, to: string, kind: "write" | "read" | "reference" | "property", location: Location }],   // id は "<kind>:<from>-><to>"
           unconfirmed: [{ relation: string, reason: string }] },
  criteria: { algorithm: "writer-merge-scc/1" },   // 当て直しの手順は下の「候補の導出の手順」
  candidates: [{ id: Id, nodes: [string]+, strength_to: [{ candidate_id: Id, edges: int≥1 }] }],
  decisions: [{ candidate_id: Id, adopted: boolean, reason: string }],
  adopted: boolean,
  reason: string,                          // 分割した、又はしなかった理由
  parts: [{ id: Id, model_id: Id, owns_variables: [string], transitions: [string] }],   // 名前は graph の要素の id（var:<model_id>/<id>・tr:<model_id>/<id>）。1 つの部分の要素は全て model_id のモデルのもの
  boundaries: [Boundary],
  contracts: [Contract],
  composition_conditions: [{ id: Id, model_id: Id, derived_from: Id, statement: string, check_ids: [Id], depends_on: [Id] }],   // model_id は親の性質のモデル、derived_from は親の性質（モデルの性質の id）。check_ids が空になりうる場合は plan と mutations の「検査の欠け」
  correspondence: { matched: [{ element: string, to: [string]+ }], unmatched: [string], excluded: [{ element: string, reason: string }] }
}
Location = { file: Ref, pointer: string }  // file は、状態遷移と性質の要素なら models[].ref と同じ path（モデルのファイル）、SMT の要素なら query の Ref。pointer は JSON Pointer（モデルのファイル）か "form:<番号>:<開始>-<終了>"（.smt2）
Boundary = {
  edge_id: string,                         // 部分を跨ぐ graph.edges の要素の id（"read:tr:<model_id>/<id>->var:<model_id>/<id>" など）。境界の契約は跨ぐ辺ごとに 1 つ
  producer: Id, consumer: Id, shared_symbols: [string]+,
  assumption: string, guarantee: string,
  assumption_basis: { kind: "他の部分の保証", contract_id: Id }
                  | { kind: "依頼の要求・制約", known_requirement_id: Id }
                  | { kind: "共同不変条件", check_ids: [Id]+ }    // 今の版では分割の照合の欠陥（分割の照合の境界）
                  | { kind: "確認できない前提", reason: string },
  responsible: [Id]+                       // 保証を確かめる契約の id。同じ分割の contracts[].id に実在する
}
Contract = {
  id: Id, model_id: Id,                    // 部分の model_id と同じ
  derived_from: Id,                        // 親の性質（モデルの性質の id）
  part_id: Id, statement: string,
  verdict: [Verdict]+, check_ids: [Id], reason: string     // 判定は下の「契約の判定」
}
```

- **契約の判定**: `Contract.verdict` は、契約ごとに次の値の `PropertyFacts` を [aggregateProperty](../artifact-formats.md#aggregatepropertyfacts--verdict) に当てた値である。「親の性質」は、`derived_from` のモデルの性質の `inventory_property_ids` が指す全ての性質で、その `PropertyFacts` から値を取る。
  - `formalizable`: true（契約は query を持つ）。
  - `check_verdicts`: `Contract.check_ids` の順の、各検査（`kind: "contract"`）の `verdict`。
  - `no_suitable_tool`・`depends_on_question`: 親の性質のどれかで true なら true。
  - `correspondence`・`deterministic_confirmed`: 親の性質の全てで true なら true。
  - `meaning_confirmed`: `confirmations.meaning` に `kind: "composition"` の確認が 1 つ以上あり、全て `成り立つ`。合成の検証者の unit は run に 1 つ（`unit_id: "composition"`）で、run の分割の全体を確かめるので、確認は契約や親の性質ごとに絞らない。
  - `composition_applies`: false（`composition_confirmed` は使わない）。理由: 親の性質の合成の条件は契約の判定を入力にするので、契約の側に入れると循環する。
  - `detection_performed`: false（`detection_confirmed` は使わない）。理由: 変異は `MutationsFile.mutations[].property_id` でモデルの性質を指し、契約を指せない。
  - `alternative_confirmed`: false（`formalizable` が true なので使われない）。
  - 親の性質の `PropertyFacts` のうち、ここで使う欄は契約の判定を入力にしないので、評価の順は親の性質のこれらの欄 → 契約の判定 → 親の性質の `composition_confirmed` で決まる。
- `kind: "contract"` の検査が `反例` でも、`Counterexample` は作らない（`Counterexample` は `property`・`composition` の検査からだけ作る。依頼者の決定）。
  - 反例は `Contract.verdict` の `反例` と `reason` に示す。親の性質は、契約が `検証済み` でないので `検証済み` にならず、合成の条件の検査が成功なら `未確認`（段 5）になる。
  - そのため、契約の反例は replay と原因の分類（`causes`）を持たず、`decideStatus` の `has_counterexample` にも数えない（必要な性質の判定に `反例` が無いため）。
  - 理由: 部分の契約は必要な性質でない内部の性質で（[分割と合成](../artifact-formats.md#分割と合成sp-008009)）、`Counterexample.property_id` は inventory の性質の名前空間にある。契約から辿ると `derived_from` → `inventory_property_ids` で複数の性質になりえ、反例を 1 つの性質に結び付けられない。
  - 退けた案: 契約の反例にも `Counterexample` を作る。

- 1 つの部分・契約・合成の条件は 1 つのモデルに属する（`model_id`）。候補は依存グラフの強連結成分なので、モデルを跨ぐ候補はできない（モデルの間には状態遷移の辺が無い）。合成の条件が参照する部分と契約は、全て同じ `model_id` を持つ。契約と合成の条件の検査の `Check.model_id` は、その `model_id` である。
- 分割しなかったときも `graph`・`criteria`・`candidates`・`decisions` を持ち、`adopted: false`、`parts`・`boundaries`・`contracts`・`composition_conditions` は `[]`、`correspondence` は 3 つとも `[]`。
- **依存グラフの導出の規則**（形式モデル `ModelFile` と、それが参照する `.smt2` から決定的に導く。AC-06・07 の照合はこの規則で導き直す）

  | 要素 | id | 導く元 | `location` |
  |---|---|---|---|
  | 変数 | `var:<model_id>/<variables[i].id>` | `state_machine.variables` の各要素 | `/state_machine/variables/<i>` |
  | 遷移 | `tr:<model_id>/<transitions[i].id>` | `state_machine.transitions` の各要素 | `/state_machine/transitions/<i>` |
  | 性質 | `prop:<model_id>/<properties[i].id>` | `properties` の各要素（モデルの性質の id） | `/properties/<i>` |
  | SMT の宣言 | `smt:<query の Ref>#<記号>` | `.smt2` の `declare-const`・`declare-fun`・`declare-sort`・`define-sort` | `form:<form の番号>:<開始>-<終了>` |
  | SMT の定義 | `smt:<query の Ref>#<記号>` | `.smt2` の `define-fun` | 同上 |
  | SMT の assert | `smt:<query の Ref>#assert-<form の番号>` | `.smt2` の `assert` | 同上 |

  - モデルが 2 つ以上あるとき、graph は全てのモデルの要素と辺を 1 つにしたものである。状態遷移と性質の要素の id には `<model_id>/` を入れ、モデルの間で重ならないようにする。SMT の要素の id は query の Ref を含むので、そのままで重ならない。`property` の辺は、同じモデルの変数にだけ引く。
  - `.smt2` は、`ModelFile.properties[].query_ref` と `sanity[].query_ref` が指すファイルだけを、Ref の辞書順に読む。form の番号は 0 始まり、`<開始>-<終了>` はファイルの中の文字の位置（0 始まり、終了を含まない）。

  | 辺 | `from` → `to` | 導く元 | `location` |
  |---|---|---|---|
  | `write` | 遷移 → 変数 | `transitions[i].updates[j].var` | `/state_machine/transitions/<i>/updates/<j>/var` |
  | `read` | 遷移 → 変数 | `transitions[i].guard` と `updates[j].term` の中の記号のうち、変数の id と同じもの | 最初に現れた所（`guard`、次に `updates` の順）の `/state_machine/transitions/<i>/guard` か `/updates/<j>/term` |
  | `reference` | SMT の定義・assert → SMT の宣言・定義 | 同じ `.smt2` の中で、本体に現れる記号 | 参照する側の form |
  | `property` | 性質 → 変数 | 性質の `query_ref` のファイルで宣言された記号のうち、変数の id と同じもの | その宣言の form |

  - 記号の読み方: SMT-LIB の項を S 式として読み、`let`・`forall`・`exists` と `define-fun` の引数で束縛された名前を除く。次の予約語、数値、`:` で始まる keyword、`#x`・`#b` の literal、文字列の literal は記号に数えない: `assert` `and` `or` `not` `xor` `=>` `=` `distinct` `ite` `let` `forall` `exists` `true` `false` `+` `-` `*` `/` `div` `mod` `abs` `<` `<=` `>` `>=` `to_real` `to_int` `is_int` `select` `store` `Int` `Real` `Bool` `Array` `!` `named` `pattern` `as` `_`。
    - `|…|` で引用した記号は、引用を外した名前として読む（`|x|` は `x`）。
    - `(! t :named n)` の `n` は記号として数える。`n` は、その名前付けで宣言されたものとし、`smt:<Ref>#<n>`（`kind: smt_definition`、`location` は名前付けを含む top level の form）の要素を作る。そのため、`n` を参照しても未確認にならない。`t` の中の記号は、名前付けを含む form の記号として数える。
  - 同じ (`kind`, `from`, `to`) の辺は 1 つにまとめる。そのため辺の id `<kind>:<from>-><to>` は一意である。
  - **未確認**（`graph.unconfirmed`）: 導けない関係は辺にせず、`relation`（`<from の id>-><記号>`。項を S 式として読めない場合は `<from の id>-><項の文字列>`）と理由を載せる。対象は、遷移の項に現れて変数でも予約語でもない記号、`updates[].var` が宣言の無い名前、`.smt2` で宣言の無い記号、項を S 式として読めない場合である。
  - 並び: `nodes` は id のバイト列の辞書順、`edges` は id の辞書順、`unconfirmed` は `relation` の辞書順。

- **候補の導出の手順**（`writer-merge-scc/1`。AC-06 の当て直しはこの手順で行う）:
  1. `graph.nodes` のうち `kind` が `variable` と `transition` のものだけを使う。
  2. `kind: "write"` の辺ごとに、両端を同じ組にする（union-find）。
  3. 組の間の有向辺を作る。`kind: "read"` の辺（`from` が遷移 t、`to` が変数 v）ごとに、v の組から t の組へ辺を引く（同じ組なら引かない）。
  4. 組の有向グラフの強連結成分を求める。1 つの成分に入る組の全てのノードが、1 つの候補になる。
  5. 候補の中のノードは id のバイト列の辞書順に並べる。候補は、最小のノードの id の辞書順に並べ、順に `C1`・`C2`… と名付ける。
  6. `strength_to` は、候補の組ごとに、両端がそれぞれの候補にある `graph.edges` の数（向きと `kind` を問わない）。0 の組は載せない。`strength_to` の並びは `candidate_id` の辞書順。
  - 候補の id とノードは、この手順だけで決まる。別の実装が同じ `graph` に当て直すと、同じ `candidates` になる。
- **欠陥の残った分割**: 修正の巡の後も分割の照合の欠陥が残った `PartitionsFile` は採らない。結果の `decomposition` は分割しなかったときの形（`adopted: false`、`parts`・`boundaries`・`contracts`・`composition_conditions` は `[]`）で、`reason` は「分割の欠陥が残った」、`decisions` は CLI が導いた候補ごとに `adopted: false` と理由「分割の欠陥が残った」を持つ。計画作成役には分割の無いモデルだけを渡す。残った欠陥は、計画の段の作業記録と `syntax`・`reference` の確認に写る。理由: 欠陥の残った境界・契約（実在しない `responsible` など）を結果に載せると、結果の中の参照が [id と参照の一覧](../artifact-formats.md#id-と参照の一覧)の実在の規則に反する。分割を採らないので、親の性質は全体のモデルの検査だけで判定し、その条件（[aggregateProperty](../artifact-formats.md#aggregatepropertyfacts--verdict) の段 2）が全て成り立てば `検証済み` になりうる。理由: SP-009 の条件は分割したときの規則で、採らなかった分割の欠陥は全体のモデルの検査の正しさに関わらない。欠陥が残ったことは `syntax`・`reference` の確認（区分が `other` なら計画の段の作業記録）に残り、`syntax`・`reference` が `成り立たない` なら run は `確認が終わっていない` で `停止` する。
- **分割の照合の境界**: `Boundary.responsible` の各 id が同じ分割の `contracts[].id` に無いか、その契約の `part_id` が `Boundary.producer` と等しくなければ欠陥とする（保証を確かめる責任は、保証する側の部分の契約が負う。SP-009）。`assumption_basis.kind` が `共同不変条件` なら欠陥とする（今の版では受け付けない）。理由: 共同不変条件の検査は分割作成役の後に計画作成役が作るので、分割の段では id を決められず、その検査を誰がどの id で作るかの契約も無い。受け付けると、確かめていない前提で親の性質が `検証済み` になりうる（SP-009）。そのため前提の循環は常に欠陥になる。
- 親の性質（inventory の性質）が `検証済み` になるのは、それを `inventory_property_ids` に含むモデルの性質を `derived_from` に持つ合成の条件の全てが検査（`Check.kind: "composition"`）を 1 件以上持ってそれが全て成功し、`contracts` が全て `検証済み`、`assumption_basis` に `確認できない前提` が無く、`correspondence.unmatched` が空のときだけである（SP-009）。

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
