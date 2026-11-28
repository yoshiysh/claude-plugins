<!-- 生成物: scripts/role-references.mjs が references/artifact-formats.md から作る。ここを直さずに正本を直して、node scripts/role-references.mjs を流す -->

# 型の抜粋（extractor）

この役が書く型（`Worklog`・`AuthorReturn`・`InventoryDraft`）の節と、読む型（`Task`・`Request`・`fixed`・`Manifest`）と、それらの定義が参照する全ての型の定義を [成果物の形式](../artifact-formats.md) から抜き出したもの。形と値の正本は成果物の形式で、CLI はそれで照合する。

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
```

## 依頼（Request）

```text
Request = {
  targets: [Target]+,
  goals: [Statement]+,
  known_requirements?: [Statement],       // 省略は []
  scope?: Scope,                          // 省略は対象と目標の全体
  time_limit_seconds?: int≥1              // 省略は上限を渡さなかったもの
}
Target    = { id: Id, location: string, revision?: string, content_hash?: Sha256 }   // location はファイルかディレクトリ
Statement = { id: Id, text: string, source?: SourceRef }
Scope     = { include: [Pointer]+, exclude: [{ item: Pointer, reason: string }] }
Pointer   = { kind: "target" | "goal" | "known_requirement", id: Id }
          | { kind: "location", target_id: Id, file: FilePath, span?: Span }   // span を省くとファイルの全体
```

```text
fixed = { revision: string | null, content_hash: Sha256, root: string,          // root は対象の元の絶対パス（symbolic link を解決した先）
          manifest_ref: Ref,                                                      // targets/<target_id>/manifest.json
          files: [{ path: FilePath, abs_path: string, content_hash: Sha256 | "unreadable", text: boolean }] }   // abs_path は元のファイルの絶対パス
Manifest = { root: string, files: [{ path: FilePath, abs_path: string, workspace_path: string | null,   // workspace_path は作業ツリーからの相対 path（外なら null）
             content_hash: Sha256 | "unreadable", text: boolean }] }
```

## 反例と原因（SP-011）

```text
Question = { id: Id, missing_decision: string, affected: [string]+, options: [string]+ }
Subject = { kind: "counterexample", id: Id } | { kind: "combination", model_id: Id, state: string, event: string } | { kind: "question", id: Id }   // 原因を分ける主題
```

## 担当の成果物

担当は自分の `attempts/<task_id>/` に書き、返り値の `outputs` で参照する。担当が書く全ての `Ref`（`outputs[].ref`・`query_ref`・`mutation_ref`・`record_ref`・`worklog_ref` など）は、run の領域からの相対 path で、`attempts/<task_id>/` で始まるか、task が渡した資料を指す。理由: 起点を 1 つにすると、CLI も外の検査も参照を同じ規則で解ける。

- **下書きと組み立て**（#264）: 抽出役・モデル作成役の対応表・分割作成役・計画作成役が書くのは下書き（`InventoryDraft`・`MappingDraft`・`PartitionsDraft`・`PlanDraft`・`MutationsDraft`）である。inventory・対応表・分割・計画のうち入力から決定的に決まる欄（走査の範囲、対応表の `location` の行、分割の採否・部分・境界の向き、検査と sanity の列挙・依存・入力）は、実行体 `formal-method-core`（[CLI 契約「実行体」](../cli-contract.md#実行体)）が骨組みとして決める。CLI は骨組みと下書きから下の今の型（`Inventory`・`MappingFile`・`PartitionsFile`・`PlanFile`・`MutationsFile`）を組み立て、今の照合を当てる。理由: 決まった値を担当に書かせると、書くたびに揺れて照合の欠陥と修正の巡が増える。
  - 組み立てた後のファイルは、run の領域の `assembled/<task_id>/<kind>.json` に 1 つだけ書き（`kind` は `inventory`・`mapping`・`partitions`・`plan`・`mutations`）、台帳に `producer` をその task の `task_id` として載せる。担当の attempt の領域の下書きは置き換えない。後の段と後の担当が読むのは組み立てた後のファイルである（計画と変異は、モデルごとのファイルをモデルの順につないだ値を CLI がメモリに持つ）。
  - 下書きが骨組みと合わない（骨組みの行への書き込みの欠け・余り、task の文脈に無い id）ときは、担当の欠陥として今の修正の巡に回す。

- **担当が書く全ての `.smt2`**（モデル作成役の性質と sanity の query、分割作成役の契約と合成の条件の query、計画作成役の変異）は、`(check-sat)` をちょうど 1 つ、ファイルの最後の form として持ち、`get-model`・`set-option`・`push`・`pop`・`reset`・`exit`・並列の設定を書かない。
- **節の名前（`:named`）**: モデル作成役の性質の query と、計画作成役の変異は、トップレベルの assert を全て `(assert (! <項> :named <name>))` の形で書く。`<name>` は `Id` の文字で、その性質の `clauses[].name` のどれかと一致し、query の中で重ならない。性質の query の名前の集合は `clauses` の名前の集合と一致し、変異の名前の集合は検出役の性質の `clauses` の名前の集合と一致する。違反はモデル化の照合（性質の query）と計画の照合（変異）の欠陥で、形の違い・名前の無い assert・名前の重なりは `syntax`、`clauses` に無い名前・assert の無い節は `reference` である。sanity・契約・合成の条件の query には当てない。理由: 静的な確認は名前で節を切り取る（[architecture.md「静的な確認」](../architecture.md#静的な確認)）。
  - 照らすのは、そのファイルを書いた役の段の照合である。モデル作成役の query はモデル化の照合（query の構文の検査）、分割作成役の query は計画の段の分割の照合、変異は計画の照合で照らす。違反はその役の修正の巡の欠陥になる。修正の巡の後も違反が残った `.smt2` を `input_refs` か `mutation_ref` に持つ実行は、計画の照合で欠陥とし、[検査](../artifact-formats.md#検査sp-010)の節のとおり実行しない。理由: 修正の巡は欠陥を見つけた照合の役に戻るので、ファイルを書いた役の段で照らさないと、直せない役に欠陥が戻る。

## inventory（抽出役。対象 1 つにつき 1 つ）

```text
Inventory = {
  schema: "formal-method.inventory/1",
  target_id: Id, content_hash: Sha256,      // 集まりの指紋
  scanned: [{ file: FilePath, span: Span | null, status: "read" | "unread", reason: string | null }]+,
           // 依頼の範囲を覆う。scope.include がその対象を target で挙げたか、その対象を指す location が無ければ全てのファイルの全体。
           // それ以外は location が指すファイル（span があればその行、無ければ全体）だけ。範囲の外のファイル・行は求めず、unread にもしない。
           // unread は reason 非 null。span が null ならファイルの全体
  elements: [{ id: Id, kind: "requirement" | "goal" | "state" | "input" | "output" | "constraint" | "event" | "result",
               source: { target_id: Id, file: FilePath, span: Span, quote_hash: Sha256 },  // quote_hash は span の行を "\n" でつないだ文字列の SHA-256。
                                                                                              // 抽出役は省いてよく、submit の照合で CLI が補う（書けば照らす）
               text: string }],
  properties: [{ id: Id, source_ids: [Id]+, statement: string, formalizable: boolean,
                 nonformal_reason: string | null, nonformal_method: string | null,
                 assumptions: [string], scope: string, blocked_by_question: [Id] }],
  external_dependencies: [{ id: Id, text: string, source: SourceRef | null }]
}
InventoryDraft = { <Inventory の scanned 以外の欄> }   // 抽出役が書く形。schema は Inventory と同じ "formal-method.inventory/1"
```

- **抽出役が書くのは `InventoryDraft`** である（`scanned` を書かない）。CLI は実行体 `extract-skeleton` で、依頼の範囲（上の `scanned` の注釈の範囲）から `scanned` を決めて埋める。テキストのファイルは範囲の span ごと（行数を超える span は行数で切る）に `read`、テキストでないか読めないファイルは `unread`（`reason` は [core.schema.json](../core.schema.json) の `x-core.texts.unread_non_text` の文）である。
- **ID の形の外部の参照**: CLI は依頼の範囲の本文にある、その対象で定義されない ID の参照（下の網羅の照合と同じ決め方）を、抽出役の task の `context.external_references` に `{ id, file, line }` で渡す。抽出役の下書きの `external_dependencies` がその id を含まなければ、CLI が `{ id, text, source: { target_id, file, span: "L<line>-L<line>" } }` を足す。`text` は `x-core.texts.external_reference_template` の `{id}`・`{file}`・`{line}` を埋めた文で、同じ id は最初の参照を使う。抽出役が `external_dependencies` に書くのは、表の見出しの語が違うなど ID の形で拾えない参照だけである。
- **網羅の照合**（洗い出しの照合）: どの性質の `source_ids` にも無い要素と、依頼の範囲の本文にある、その対象で定義されない ID の参照（`external_dependencies` の `id` にも `text` にも無いもの）は `other` の欠陥とする。ID の参照の決め方は [architecture.md「静的な確認」](../architecture.md#静的な確認)の作成役の照合への前倒し。

## 担当の返り値

`attempts/<task_id>/return.json`（claim の Task の `result_path`）。担当はここに書いてから `submit` を流す。Workflow の返り値に内容を書かない（`run-daemon` は返り値を読まない）。

```text
AuthorReturn = {                          // 担当が書く形。task_id は CLI が補う（下の「文脈の値」）
  status: "done" | "needs_answer" | "cannot_proceed",
  outputs: [{ kind: "inventory" | "model" | "mapping" | "partitions" | "plan" | "mutations", ref: Ref }],
  questions: [Question],                  // needs_answer のとき 1 つ以上
  blocked_by_question: [Id],              // 回答を待つ問いに依存する inventory の性質の id（問いの id ではない）
  reason: string | null,                  // cannot_proceed のとき非 null
  worklog_ref: Ref
}
```

- **文脈の値**（#264）: 返り値の `task_id`（全ての役）・`unit_id`（確認役と原因の分類役）・`perspective`（確認役だけ）と、作業記録の `schema`・`role`・`task_id`・`stage`・`target` は、担当が書かない。CLI は `submit` の照合の初めに、実行体 `complete-return` で task の値を入れて返り値と作業記録を書き直し、補った後の返り値に今の型（`claim` の `return_schemas` の形に、これらの欄を足したもの）を当てる。担当がそれらの欄を書き、値が task と違えば、その欄の名前を `problems` で返す（同じ担当が直して出し直す）。
- **確認の結果の集計**: 確認役は `result` を書かない。CLI は実行体 `review-tally` で、`findings` が 1 つ以上なら `成り立たない`、`items` が 1 つ以上で全てが `成り立つ` なら `成り立つ`、それ以外（`items` が空を含む）は `確認できず` を確認の `result` とする。理由: 何も見た記録の無い確認を成り立つとしない。観点ごとに `items` を書く義務があるので、見終えた確認役の結果は変わらない。`judgments` は今のとおり確認役が書く。
- 返り値が無い、形が違う、`outputs`・`record_ref`・`worklog_ref` が attempt の領域の外か存在しない、補った `task_id`・`unit_id` が task と違う、忠実さの `judgments` がそのモデルの判断を要する項目にちょうど 1 つずつ答えていない場合は、成功に数えない（作業記録の失敗の欄に理由が残る）。
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
  instructions: [string, string, string, string],   // 担当の指示（agents/<role>.md）、その役の分の義務（references/obligations/<author|confirmer>.md）、
                                                // その役の型の抜粋（references/types/<role>.md）、適用する文書の一般規約（run の領域の
                                                // document-rules/<指紋>.md。写しを保存できなかったときは同じ版の references/document-rules.md）の絶対 path。
                                                // 2・3 つ目は scripts/role-references.mjs が正本（agent-obligations.md・この文書）から作る生成物
  attempt_dir: string, result_path: string,     // 絶対 path。result_path は attempt_dir の return.json
  context: TaskContext
}
TaskContext = {
  run_dir: string,                        // 絶対 path。Ref の起点
  stage: Stage,                           // task を出した段。担当の作業記録の stage はこの値
  unit_id: Id | null,                     // 独立検証者と原因の分類役だけ非 null。CLI が返り値の unit_id にこの値を入れる
  perspective: "extraction" | "nonformal" | "fidelity" | "composition" | null,   // 独立検証者だけ非 null
  target_id: Id | null,                   // extractor と perspective が extraction のとき非 null
  model_id: Id | null,
  property_ids: [Id],
  candidates: [{ id: Id, nodes: [string]+,      // partition-author だけ空でない（Decomposition.candidates と同じ id）
                  edges: [{ edge_id: string, to_candidate: Id, producer_candidate: Id, consumer_candidate: Id, shared_symbols: [string]+ }] }],
                                          // edges はその候補と他の候補を結ぶ依存グラフの辺（上の partitions の節）
  subject: Subject | null,                // cause-analyst だけ非 null
  model_property_id_prefix: string | null,   // モデル化の段の model-author だけ非 null（"<model_id>."。モデルの性質の id の接頭辞）
  target_ids: [Id],                       // 計画の段の plan-author だけ空でない（そのモデルで検査を出しうる target_id の一覧）
  external_references: [{ id: Id, file: FilePath, line: int≥1 }]   // extractor だけ空でない（依頼の範囲の本文の、ID の形の外部の参照。上の inventory の節）
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
- 担当の作業記録の `schema`・`role`・`task_id`・`stage`・`target` は、担当が書かない。CLI が `submit` の照合で、実行体 `complete-return` により task の値を入れる（`target` は、作成役は `context.target_id`、無ければ `model_id`、無ければ対象の id の並び、確認役と原因の分類役は `context.unit_id`）。担当が書いた値が task と違えば、その欄の名前を `problems` で返す。
- 担当の作業記録の `inputs[].hash`・`inputs[].spans[].hash`・`document_rules` は、担当が省いてよい。`submit` の照合で、CLI が省いた値を補い（指紋はその担当の `materials`（最初の `query` の時点の指紋）の値。`document_rules` は `claim` の値）、`worklog.json` を書き直してから照合する。担当が書いた値が CLI の値と違えば、作業記録の欠陥として `problems` で差し戻す。登録する作業記録は補った後の、この形のファイルである。理由: 指紋を CLI だけが持てば、担当が手で求めた値との食い違いが起きない。
- 補うのは `materials` にある ref と範囲だけである。`materials` に無い ref（渡していない資料。`query` を流す前の提出では全ての ref）と、その ref の `materials` の `spans` に無い範囲は、今のファイルで求めずに作業記録の欠陥として差し戻す（担当が指紋を書いていても同じ）。理由: `inputs` は渡した資料のうち読んだものの欄で（SP-012 の「渡した資料」）、渡していない資料の指紋を補うと、資料の外を読んだ記録が登録される。
- salvage の作業記録は時刻を含まない。
