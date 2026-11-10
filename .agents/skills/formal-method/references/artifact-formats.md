# 成果物の形式

formal-method が受け取り、作り、返すデータの形の正本。値の意味は仕様（`docs/specifications/formal-method.md`、以下 SP-NNN）に従う。手順と配置は [CLI 契約](cli-contract.md) が正本。実装の `scripts/lib/schemas.mjs` は、この文書の形をそのまま機械の schema にする。

テストの担当は、この文書と [CLI 契約](cli-contract.md) と仕様だけで、テストを作れる。

## 目次

- [表記の約束](#表記の約束)
- [共通の型](#共通の型)
- [依頼（Request）](#依頼request)
- [結果（Result）](#結果result)
- [検査の終わり方（end）](#検査の終わり方end)
- [判定の 3 関数](#判定の-3-関数)
- [担当の成果物](#担当の成果物)
- [担当の返り値](#担当の返り値)
- [task の一覧](#task-の一覧)
- [Workflow の返り値](#workflow-の返り値)
- [作業記録](#作業記録)
- [記録台帳](#記録台帳)
- [id と参照の一覧](#id-と参照の一覧)

## 表記の約束

形は次の記法で書く。JSON Schema の部分集合と同じ意味である。

- `{ key: Type, ... }` は object。**閉じている**（書いていないキーは拒む）。ただし依頼（Request）だけは開いている（下記）。
- キーは全て**必須**。任意のキーは `key?:` と書く。省略と `null` は区別する。`null` を許すときは `Type | null` と書く。
- `string` は空でない文字列。空を許すときは `string0` と書く。
- `int` は安全な整数、`int≥n` は n 以上の整数。
- `[T]` は T の配列で、**空を許す**。空を許さないときは `[T]+` と書く。配列の要素の順は、各所に書いた順に固定する（書いていなければ、識別子の辞書順）。
- `"a" | "b"` は値の集合。値の集合は全て閉じている。自由な文（`string`）の欄は、テストで中身を照合しない（空でないことと型だけを照合する）。
- **値の言語**: キーは英語の snake_case。仕様が日本語で定める値（判定・保証・原因・組合せの区分・状態・段など）は、仕様の字面のまま日本語にする。仕様が定めない内部の値は英語にする。
- **空のときの扱い**: 該当が無い項目もキーを省かない。配列は `[]`、object は各欄を空にした値か、`{ "applicable": false, "reason": string }` で表す（その形は各所に書く）。

## 共通の型

```text
Id          = string                       // 英数字・「-」「_」「.」。同じ種類の中で一意
Sha256      = string                       // "sha256:" + 64 桁の小文字 16 進
Ref         = string                       // run の領域（<run_id>/）からの相対 path。この文書の全ての Ref に共通（担当が書く ref を含む）
RefHash     = { ref: Ref, hash: Sha256 }
Span        = string                       // "L<開始>-L<終了>"。1 始まり、両端を含む、開始 ≤ 終了
FilePath    = string                       // 対象の根からの相対 path。"/" 区切り、"." と ".." を含まない。単一のファイルの対象では、そのファイル名。除いたディレクトリを指すときだけ末尾に "/" を付ける
SourceRef   = { target_id: Id, file: FilePath, span: Span }
Stage       = "受付" | "洗い出し" | "モデル化" | "計画" | "実行" | "確認" | "集約"
Measure     = { value: number, unit: "ms" | "bytes" | "count" }
            | { status: "取得できず", reason: string }
            | { status: "該当なし", reason: string }
RecordKind  = "request" | "target_snapshot" | "document_rules" | "inventory" | "model" | "mapping" | "partitions"
            | "plan" | "mutations" | "query" | "execution_evidence" | "worklog" | "review_record" | "ledger"
            | "result" | "report" | "salvage_worklog" | "salvage_ledger"
ExecKind    = "property" | "composition" | "contract" | "sanity" | "mutation" | "replay"
```

- `Measure` の値は 0 を含めて実測値だけで、取れなかった値を 0 で表さない（SP-013）。

**対象**（依頼者の決定）

- 対象は、テキストのファイルの集まりである。`location` がファイルなら 1 つのファイルの集まり、ディレクトリならその下の全ての通常のファイルの集まりとする。
  - ディレクトリの下は再帰的にたどる。集まりの中の symbolic link はたどらず、`unread` に「symbolic link はたどらない」と載せる。
  - `location` そのものが symbolic link なら、1 度だけ解決し、解決した先をファイルかディレクトリとして扱う。解決した先の path を `verified_scope.targets[].resolved_location` に示す。解決できなければ `target_unavailable`。理由: 依頼元が指した場所なので、その意図どおりに読む。集まりの中の link はたどると集まりが対象の外に広がるので、たどらない。
  - 集まりから除くものは、次の 2 つだけである。
    - どの深さでも、名前が `.git` のもの（ディレクトリでもファイルでも）。worktree や submodule では `.git` がファイルになるためである。
    - formal-method 自身の保存先、つまり作業ツリーの根の `.formal-method/`（`start` を呼んだ process の現在のディレクトリの直下）。比べるのは symbolic link を解決した実際の path で、名前では比べない。利用者が深い場所に作った `.formal-method` は除かずに残す。除く理由: 含めると、run を重ねるたびに写しが対象に入り、書きかけの記録で指紋が変わり、抽出役が記録を検証の対象として読む。
  - 除いたものは対象の定義から外れ、対象の一部ではない。`unread` には載せず、`verified_scope.exclude` に `item: { kind: "location", target_id, file }`（ディレクトリなら `file` は `"<FilePath>/"`）、`reason: "formal-method が除く"`、`origin: "formal-method"` で載せる。理由: 対象でないものを「読めなかった箇所」に数えると、SP-004 の網羅（読めなかった箇所が残れば網羅済みにしない）が常に成り立たなくなる。
  - `.gitignore` には従わない（設計の決定）。
  - ファイルの並びは、`FilePath` のバイト列の辞書順とする。
- **テキストかどうか**: ファイルのバイト列が NUL を含むか、UTF-8 として読めなければ、バイナリのファイルとする。バイナリのファイルは受け付けない依頼にはせず、ファイルの全体を「読めない箇所」として `verified_scope.unread` に挙げる（未検証）。
- 集まりの中で読めないファイル（権限が無いなど）も同じく `unread` に挙げる。`target_unavailable` にするのは、`location` そのものが無い、根を読めない、又は扱えない URI の場合だけである。
- `Span` の行は、ファイルの固定した版のバイト列を UTF-8 で読み、`\n` で分けた行である。ファイルが `\n` で終わるとき、分けた最後の空の要素は行に数えない。空のファイルの行数は 0 で、どの `Span` も指せない。`\r` は行の中身として残す。
- **版と指紋**
  - ファイルの指紋は、バイト列の SHA-256。
  - 集まりの指紋（`content_hash`）は、`<FilePath> + "\0" + <ファイルの指紋> + "\n"` を `FilePath` の順につないだ文字列の SHA-256。バイナリと読めないファイルも、読めたバイト列があれば含め、読めなければ指紋を `"unreadable"` として含める。
  - 依頼の `content_hash` は、集まりの指紋と照合する。
  - `revision`（git の版）を依頼が添えたときは、`location` を含む git の作業ツリーから、その版の tree の内容を取る（ディレクトリなら、その版の tree の下の全てのファイル）。`location` が git の作業ツリーの外なら、版の内容を取れないので `revision_mismatch` とする。
  - 依頼が `revision` を添えないときは、作業ツリーのファイルを今の内容で読み、`fixed.revision` は `null` とする。git の中か外かによらない。内容は `content_hash` と各ファイルの指紋で特定する（SP-001 の「版又は内容を特定できる情報」）。

## 依頼（Request）

`start` の入力の `request`。SP-001 の項目だけを持つ。

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

- `location` は作業ツリーからの相対 path か絶対 path、又は `file://` の URI。他の URI は取得できない対象とする。
- `revision` は git の版の名前（英数字と `._/-`、`..` を含まない）。
- `content_hash` は集まりの指紋（[共通の型](#共通の型)の「版と指紋」）。
- **開いている object**: 依頼とその中の object は、書いていないキーを拒まない。そのキーは使わず、結果の `unverified[]` に「依頼の未知のキー: <JSON Pointer>」として載せる。理由: SP-001 は受け付けない場合を列挙しており、未知のキーで拒むと仕様より狭くなる。

**受け付けない依頼**（SP-001。検証を始めず、受付の段の `停止` の結果で、項目と理由を `stop_report.reasons` に載せる）

| 理由の `code` | 当たるとき |
|---|---|
| `target_missing` | `targets` が無いか空 |
| `goal_missing` | `goals` が無いか空 |
| `shape_invalid` | 上の形に合わない（型の違い、空の文字列、必須のキーの欠け）。書いていないキーは当たらない |
| `duplicate_id` | 同じ種類の中で `id` が重なる |
| `exclude_without_reason` | `exclude` の項目に `reason` が無い |
| `pointer_unresolved` | `Pointer` が依頼に無い識別子か、対象に無い箇所（集まりに無いファイル、又は行の範囲がファイルの行数を超える）を指す。`SourceRef` も同じ。バイナリか読めないファイルの行を指す場合も当たる |
| `time_limit_invalid` | `time_limit_seconds` が JSON の整数で 1 以上でない（文字列・小数・`null`・真偽値を含む）。理由: SP-001 が「1 未満又は整数でない時間の上限」を名指しするので、型の違いも `shape_invalid` でなくこちらに入れる |
| `target_unavailable` | 対象を取得できない（`location` が無い、根を読めない、扱えない URI）。集まりの中の一部のファイルが読めないだけなら当たらない |
| `revision_mismatch` | `revision` の内容を取れない（git の作業ツリーの外を含む）か、`content_hash` が集まりの指紋と一致しない |

- 依頼の検査・対象の取得・版と指紋の照合・写しの保存は、全て `run-daemon` が、同じ読み込みのバイト列で行う（[CLI 契約](cli-contract.md#起動の手順)）。

`request.json`（受け付けた依頼の正規形）は、上の形に省略の既定値を埋め、未知のキーを除き、各対象に次を足したものである。

```text
fixed = { revision: string | null, content_hash: Sha256, snapshot_ref: Ref,     // snapshot_ref は targets/<target_id>/
          files: [{ path: FilePath, content_hash: Sha256 | "unreadable", text: boolean }] }
```

## 結果（Result）

`status.json` の `result` と `result.json` の形（`result.json` は `run-daemon` か salvage の、先に公開した方の結果）。SP-003 の項目を全て持つ。`stop_report` だけは、状態が `停止` のときに object、`完了` のときに `null` である（AC-21）。

```text
Result = {
  schema: "formal-method.result/1",
  status: "完了" | "停止",
  provisional: boolean,                    // 仮の結果か。下の「仮の結果」
  verified_scope: VerifiedScope,
  properties: [PropertyResult],
  checks: [Check],
  models: [Model],
  decomposition: Decomposition,
  counterexamples: [Counterexample],
  causes: [Cause],
  confirmations: { deterministic: [Confirmation], meaning: [Confirmation] },
  unverified: [{ item: string, reason: string }],
  questions: [Question],
  records: Records,
  stop_report: StopReport | null,
  performance: Performance
}
```

**仮の結果**（依頼者の決定: 公開された結果を正とする）

- `provisional: true` の結果は、記録を保存できなかった仮の結果である。`result.json` に公開されずに返った `停止` の結果がこれに当たる。`run-daemon` が `status.json` で返した R'、salvage が標準出力で返した R'、`start` が run の領域の無いまま返した結果（`run_dir: null`。この場合は、あとで `result.json` が公開されることは無い）である。
- 不変: `provisional` が true であるのは、`records.unsaved` に `kind: "result"` の要素があるときだけで、そのとき `status` は `停止` である。公開された `result.json` の中身は、常に `provisional: false` である。
- あとで同じ run の `result.json` が公開されたら、それを run の結果とし、仮の結果はそれに置き換えられる。仮の結果を受け取った者は、`<run_dir>/result.json` を読めば正の結果を得られる。
- 理由: 保存できない状態では、どの手順も公開の成否を前もって知ることができない。その間に返した結果と、あとで公開された結果が食い違いうる（形式検証の 4 ケース。生死の誤判定が無くても、`status.json` が読めないだけでも起こる）。返した結果に仮であることを持たせれば、どちらを正とするかが結果から決まる。
- 退けた案: `records.unsaved` に `result` があることだけで仮の結果を表す。読む側が規則を知らないと見落とすので、明示の欄にした。

### 検証した対象と範囲（SP-001・003・004）

```text
VerifiedScope = {
  targets: [{ id: Id, location: string, resolved_location: string | null, revision: string | null, content_hash: Sha256,   // resolved_location は location が symbolic link のときだけ非 null
              files: [{ path: FilePath, content_hash: Sha256 | "unreadable", text: boolean }] }],
  include: [Pointer],
  exclude: [{ item: Pointer, reason: string, origin: "依頼元" | "formal-method" }],   // origin は除外の出どころ。依頼の exclude は 依頼元
  external_assumptions: [{ id: Id, text: string, source: SourceRef | null }],
  unread: [{ target_id: Id, file: FilePath, span: Span | null, reason: string }],   // span が null ならファイルの全体（バイナリ、読めない、symbolic link）
  internal_time_limits: { agent_batch_deadline_ms: int, tool_time_limit_max_s: int, note: "内部の上限" },
  extraction_coverage: { complete: boolean, reason: string }   // SP-004 の網羅。complete は、unread が空で、抽出の独立した確認が全て成り立つときだけ true
}
```

- 受付で止まって対象を取得していない場合、`targets` は `[]`。`include`・`exclude` は依頼のとおり（形が壊れていれば `[]`）。

### 性質ごとの結果（SP-003・004・005・007・011・012）

```text
PropertyResult = {
  id: Id,
  statement: string,
  sources: [{ kind: "goal" | "known_requirement" | "location", id: Id | null, source: SourceRef | null }]+,   // kind が location なら id は null で source は非 null
  formalizable: boolean,
  nonformal_reason: string | null,         // formalizable が false のときだけ非 null
  verdict: [Verdict]+,                     // 判定の集合。重複なし。順は下の Verdict の並び
  assurance: Assurance | null,             // 判定に使える保証が無いとき null
  detection: Detection,
  method: Method | null,                   // 形式化できない性質と、計画まで届かなかった性質は null
  check_ids: [Id],                         // この性質の判定に数える検査。結び付きの正本
  confirmation_ids: [Id],
  evidence_refs: [Ref],
  reason: string,                          // 判定の理由
  depends_on_questions: [Id]
}
Verdict = "検証済み" | "別手段で確認済み" | "反例" | "未実行" | "unknown" | "時間切れ" | "実行失敗" | "未確認"
Assurance =
    { kind: "範囲を限った検査", scope: string, bounds: [{ item: string, bound: string }]+, fairness_assumptions: [string] }
  | { kind: "無界の証明", proposition: string, open_obligations: [string], fairness_assumptions: [string] }
  | { kind: "形式検証でない確認", method: string }
Detection = {
  status: "検出を確認" | "検出せず" | "別の方法で確認" | "検出能力未確認",
  mutations: [{ id: Id, expected_violation: string, detected: boolean, confirmation_id: Id }],   // id は計画の変異の id（MutationsFile.mutations[].id）、confirmation_id はその確認の Confirmation.id
  reason: string
}
Method = {
  chosen: { technique: string, tool: string },
  candidates: [Candidate]+,                // 実行基盤の Rust と、検証器の Z3 を必ず含む（SP-007）
  reason: string,
  comparison_conditions: [ComparisonCondition]   // 性能の優劣を示したときだけ要素を持つ
}
Candidate = {
  role: "実行基盤" | "検証器",
  name: string,
  handles: string,                         // 扱える性質
  assurance: string,                       // 得られる保証
  environment: string,                     // 実行環境
  checkable_scope: string,                 // 検査できる範囲
  estimates: { setup: Measure, execution: Measure, resources: Measure },
  available: boolean,
  reason: string,
  comparison_basis: { property_ids: [Id], assumptions: [string], scope: string, assurance: string, judgment_rules: string },   // 比べる実行の条件。property_ids は inventory の性質の id
  performance_claim: { better_than: string, metric: "setup" | "execution" | "resources" } | null   // 他の候補より性能が良いという主張。無ければ null
}
ComparisonCondition = {   // 担当が performance_claim を書いた候補ごとに 1 つ。CLI が comparison_basis の 5 つを比べて作る
  compared: [string, string],              // 比べた 2 つの候補の name
  matches: { property: boolean, assumptions: boolean, scope: boolean, assurance: boolean, judgment_rules: boolean },
  result: "一致を確認" | "一致を確認できず",
  reason: string
}
```

- `verdict` の規則は [判定の 3 関数](#判定の-3-関数) の `aggregateProperty`。`検証済み`・`別手段で確認済み` は単独でだけ現れる。
- `properties` は必要な性質（範囲から除外したもの以外）だけを持つ。部分の契約（内部の性質）は入れない（`decomposition.contracts`）。
- `comparison_conditions` の `result` が `一致を確認できず` の組について、結果の候補の `performance_claim` を `null` にし、`reason`・`chosen` の理由に性能の優劣を書かない（SP-013）。主張があったことは、その `ComparisonCondition.reason` にだけ残す。

### 検査（SP-010）

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
  - 欠陥が残った計画の要素（検査・sanity・変異。`.smt2` の違反、道具の名前の違反、`target_id` の種類の違反などの全て）は、定めた検査に数えず、実行しない。`checks[]`・`confirmations` と、それを指す `check_ids` に載せず、`unverified[]` に、`item` を「計画の欠陥: <計画の id>」、`reason` を残った欠陥の理由として載せる。その結果、性質の検査が欠ければ [検査の欠け](#plan-と-mutations計画作成役) と同じ判定になる。理由: 欠陥の残った query を実行すると、性質の判定が欠陥の種類で `実行失敗` にも `未実行` にもなり、計画の欠けとしての扱い（`未確認`）と分かれる。
- `state: "実行していない"` の検査は `verdict: "未実行"`、`end.started: false`。
- 検査を指す欄に入る `kind` は次のとおりで、`Check` は指す側の欄を持たない。
  - `PropertyResult.check_ids`・`Model.mapping[].check_ids`: `property` と `composition` だけ。性質と検査の結び付きの正本は `PropertyResult.check_ids`。ある性質の `check_ids` は、その性質を `inventory_property_ids` に含むモデルの性質の `kind: property` の検査と、そのモデルの性質を `derived_from` に持つ合成の条件の `kind: composition` の検査である。
  - `composition_conditions[].check_ids`: `composition` だけ。
  - `Contract.check_ids`: `contract` だけ。CLI が、`PlanFile.checks` のうち `kind: "contract"` で `target_id` がその契約の id の検査を、計画の順に埋める。そのため `kind: "contract"` の検査は、ちょうど 1 つの `Contract.check_ids` に現れ、`PropertyResult.check_ids` には現れない。
  - 理由: AC-09 の外からの照合は、`properties[].check_ids` が指す `checks[].verdict` に集約の規則を当て直す。部分の契約は必要な性質でない（[分割と合成](#分割と合成sp-008009)）ので、その検査が性質の集合に混ざると、当て直した判定が実装の判定と食い違う。

### 形式モデルと対応（SP-005・006）

```text
Model = {
  id: Id,
  ref: Ref,
  covers: { targets: [Id], states: [string], events: [string],
            assumptions: [{ id: Id, text: string }], constraints: [string],
            excluded: [{ item: string, reason: string }] },
  mapping: [{ source: Pointer, property_id: Id, model_element: string, check_ids: [Id],
              relation: "形式化" | "形式検証でない確認" | "範囲外" | "対応なし", reason: string | null }],
  unmapped: { requirements: [Pointer], properties: [Id], model_elements: [string] },
  combinations: Combinations,
  paths: Paths,
  behavior: Behavior,
  diagram: Diagram
}
Combinations = { applicable: false, reason: string }
  | { applicable: true,
      cells: [{ state: string, event: string,
                class: "許される" | "禁止された" | "対応できていない",
                grounds: string,           // 許される遷移の条件、禁止の出所、又は不足する情報
                transition_ids: [Id] }] }  // cells は state × event の全ての組。順は states・events の宣言順
Paths = { applicable: false, reason: string }
  | { applicable: true,
      targets: [{ state: string, kind: "目標" | "完了" | "停止" | "再開先", property_id: Id }],
      verified: [{ path: string, property_id: Id }],
      excluded: [{ path: string, reason: string }],
      unverified: [{ target: string, reason: string }] }
Behavior = { applicable: false, reason: string }
  | { applicable: true,
      outcomes: { success: [string], failure: [string], interruption: [string], stop: [string] },
      human_inputs: [{ event: string, accepted_in: [string] }],
      resumptions: [{ transition_id: Id, resume_to: string }] }   // 検証する相手の状態遷移の再開
Diagram = { derivable: false, reason: string }
  | { derivable: true, format: "mermaid", text: string,
      element_map: [{ diagram_element: string, model_element: string }],
      extra: [string], missing: [string], omitted_conditions: [string] }
```

- `mapping.relation: "対応なし"` の行の `reason` は非 null。
- `relation: "形式化"` の行は、`check_ids` が空でないか、空で `reason` が非 null（計画にその性質の検査が無い理由）かのどちらかである。`check_ids` が空でない行の `reason` は、他の relation と同じく自由（null を許す）。
  - 検査が無くなるのは、適した道具が無いか準備できない場合（SP-007。`no_suitable_tool` が true）、計画の段で問いに依存すると分かった場合、計画作成役の欠けが修正の巡の後も残った場合（[plan と mutations](#plan-と-mutations計画作成役) の「検査の欠け」）、計画作成役が返らないか `cannot_proceed` を返して計画が無い場合である。
  - その性質の判定は [aggregateProperty](#aggregatepropertyfacts--verdict) の段 4・5 で決まる。SP-007 の場合は `["未実行"]`、それ以外は `["未確認"]` である。`reason` と同じ理由は `PropertyResult.reason` にも残る。
  - 理由: 担当の失敗や問いで run を止めずに次の段へ進む（[担当の返り値](#担当の返り値)）ので、検査の無い 形式化 の行も結果に表せる必要がある。空を禁じると、その結果は集約の照合で `内部の誤り` になる。モデルの要素との対応は事実なので、relation は `対応なし` に変えない。
- `combinations` で `対応できていない` の組は、`unverified` と `causes` にも現れる。

### 分割と合成（SP-008・009）

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

- **契約の判定**: `Contract.verdict` は、契約ごとに次の値の `PropertyFacts` を [aggregateProperty](#aggregatepropertyfacts--verdict) に当てた値である。「親の性質」は、`derived_from` のモデルの性質の `inventory_property_ids` が指す全ての性質で、その `PropertyFacts` から値を取る。
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
  - 理由: 部分の契約は必要な性質でない内部の性質で（[分割と合成](#分割と合成sp-008009)）、`Counterexample.property_id` は inventory の性質の名前空間にある。契約から辿ると `derived_from` → `inventory_property_ids` で複数の性質になりえ、反例を 1 つの性質に結び付けられない。
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
- **欠陥の残った分割**: 修正の巡の後も分割の照合の欠陥が残った `PartitionsFile` は採らない。結果の `decomposition` は分割しなかったときの形（`adopted: false`、`parts`・`boundaries`・`contracts`・`composition_conditions` は `[]`）で、`reason` は「分割の欠陥が残った」、`decisions` は CLI が導いた候補ごとに `adopted: false` と理由「分割の欠陥が残った」を持つ。計画作成役には分割の無いモデルだけを渡す。残った欠陥は、計画の段の作業記録と `syntax`・`reference` の確認に写る。理由: 欠陥の残った境界・契約（実在しない `responsible` など）を結果に載せると、結果の中の参照が [id と参照の一覧](#id-と参照の一覧)の実在の規則に反する。分割を採らないので、親の性質は全体のモデルの検査だけで判定し、その条件（[aggregateProperty](#aggregatepropertyfacts--verdict) の段 2）が全て成り立てば `検証済み` になりうる。理由: SP-009 の条件は分割したときの規則で、採らなかった分割の欠陥は全体のモデルの検査の正しさに関わらない。欠陥が残ったことは `syntax`・`reference` の確認（区分が `other` なら計画の段の作業記録）に残り、`syntax`・`reference` が `成り立たない` なら run は `確認が終わっていない` で `停止` する。
- **分割の照合の境界**: `Boundary.responsible` の各 id が同じ分割の `contracts[].id` に無いか、その契約の `part_id` が `Boundary.producer` と等しくなければ欠陥とする（保証を確かめる責任は、保証する側の部分の契約が負う。SP-009）。`assumption_basis.kind` が `共同不変条件` なら欠陥とする（今の版では受け付けない）。理由: 共同不変条件の検査は分割作成役の後に計画作成役が作るので、分割の段では id を決められず、その検査を誰がどの id で作るかの契約も無い。受け付けると、確かめていない前提で親の性質が `検証済み` になりうる（SP-009）。そのため前提の循環は常に欠陥になる。
- 親の性質（inventory の性質）が `検証済み` になるのは、それを `inventory_property_ids` に含むモデルの性質を `derived_from` に持つ合成の条件の全てが検査（`Check.kind: "composition"`）を 1 件以上持ってそれが全て成功し、`contracts` が全て `検証済み`、`assumption_basis` に `確認できない前提` が無く、`correspondence.unmatched` が空のときだけである（SP-009）。

### 反例と原因（SP-011）

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

- `Counterexample.check_id` は、`kind` が `property` か `composition` で `verdict` が `反例` の検査を指す（`kind: "contract"` の検査からは作らない。[分割と合成](#分割と合成sp-008009)）。`replay` の確認の作り方と `steps_ref` の指す先は [CLI 契約の証人](cli-contract.md#証人)。
- 全ての反例と `対応できていない` 組合せは、`causes` に 1 つずつ要素を持つ。
- `questions` に入るのは、原因の分類が `要求の不足` の問いだけである。

### 確認（SP-004・005・012）

```text
Confirmation = {
  id: Id,
  kind: "syntax" | "reference" | "result_presence" | "output_format" | "replay" | "sanity" | "mutation"   // deterministic
      | "extraction" | "nonformal" | "fidelity" | "assurance" | "composition",                          // meaning
  property_ids: [Id],                      // 確認が関わる inventory の性質の id。無ければ []
  model_property_id: Id | null,            // sanity・mutation・replay・assurance のとき、モデルの性質の id
  plan_id: Id | null,                      // 計画の sanity・変異から作った確認なら、その計画の id（PlanFile.sanity[].id・MutationsFile.mutations[].id）。他は null
  item: string,
  result: "成り立つ" | "成り立たない" | "確認できず",
  checker: string,                         // 決定的な検査は "cli"、意味の確認は担当の task_id（担当を出さなかった unit は "cli"）
  materials: [RefHash],                    // 確認した者に渡した資料
  end: End | null,                         // 道具を実行した確認（replay・sanity・mutation）だけ非 null
  reason: string
}
```

- `deterministic` と `meaning` は別の配列で、一方の `成り立つ` を他方の代わりにしない（SP-012）。
- **`result_presence` の作り方**（SP-012 の「全ての計画した検査の結果の有無」）: 計画作成役の `PlanFile` があれば、実行の段の終わりに CLI が `confirmations.deterministic` に 1 つ作る。無ければ作らない。欄は `kind: "result_presence"`、`property_ids: []`、`model_property_id: null`、`plan_id: null`、`item: "計画した全ての検査の結果"`、`checker: "cli"`、`materials: []`、`end: null`。`PlanFile.checks` の全ての要素（欠陥が残って除いたものを含む）が、同じ `id` の `checks[]` の要素を持てば `成り立つ`、持たない要素があれば `成り立たない` で、`reason` にその id を並べる。対象は `PlanFile.checks` だけで、sanity と変異は確認（`kind: sanity`・`mutation`）として別に数える。理由: 欠陥で除いた検査は定めた検査に数えず結果が無いので、計画した検査の結果が欠けたことを決定的な確認として示す。
- **`syntax`・`reference`・`output_format` の作り方**（SP-012 の構文・参照の解決・道具の出力の形式）: 新しい照合は足さず、既にある照合の結果を写す。集約の段で、CLI が `confirmations.deterministic` に kind ごとに 1 つ（run に最大 3 つ）作る。欄は `property_ids: []`、`model_property_id: null`、`plan_id: null`、`checker: "cli"`、`materials: []`、`end: null`。
  - **欠陥の区分**: 洗い出し・モデル化・計画の段の照合（`coverageCheck`・`modelCheck`・`partitionCheck`・`planCheck` と `.smt2` の規則）が出す欠陥に、CLI は次の区分を 1 つ付ける。
    - `syntax`: 担当の成果物のファイルを読めない、JSON でない、その形式の形（この文書の型）に合わない、`.smt2` が S 式として読めないか `.smt2` の規則（[担当の成果物](#担当の成果物)）に反する。
    - `reference`: id か `Ref` の欄が、[id と参照の一覧](#id-と参照の一覧)の「実在を確かめる所」がその段の照合とする先に実在しない（未定義の参照・実在しない id・領域の外の Ref）。
    - `other`: 上の 2 つに当たらない欠陥（網羅の欠け、件数、選択の欠け・重なり、循環、共同不変条件など）。この区分は決定的な確認に写さない。
    - 1 つの欠陥が両方に当たれば `syntax` とする（読めないものは参照を確かめられないため）。
    - [id と参照の一覧](#id-と参照の一覧)の「一意」の違反（重複）は `other`、「実在を確かめる所」の違反（`target_id` の種類の不一致を含む）は `reference` とする。
  - `syntax`（`item: "担当の成果物の構文"`）と `reference`（`item: "担当の成果物の参照の解決"`）: 照合した成果物が 1 つ以上あれば作る。修正の巡の後に残った欠陥（各段で最後の巡に照合した成果物の欠陥。受け入れたかによらない。返り値の形の違いで成功に数えなかった返り値は、成果物を照合しないので含まない。それは `担当の失敗` が扱う）のうち、その区分のものが無ければ `成り立つ`、あれば `成り立たない` で、`reason` に `<段>: <欠陥の文>` を並べる。照合した成果物が無ければ（担当が全て失敗したなど）作らない。修正の巡で直った欠陥は数えない。
  - `output_format`（`item: "道具の出力の形式"`）: `started: true` の道具の実行（`checks[]` と、道具を実行した確認）が 1 つ以上あれば作る。そのうち `stopped_by: null` の実行の全てで `unreadable_output: false` なら `成り立つ`、`unreadable_output: true` の実行があれば `成り立たない` で、`reason` にその実行の id を並べる。formal-method が止めた実行は道具が出力を終えていないので数えない。`tool_result: "判定以外のエラー"`（道具が query の誤りを報告した）は数えない。理由: 出力の形は崩れておらず、その検査は既に `実行失敗` で、停止の理由 `実行できない検査` が示す。`syntax` が扱うのは照合で見つけた欠陥だけである。
  - 3 つとも、`成り立つ` でなければ `confirmations_unresolved` が true になり（`確認が終わっていない`）、`stop_report` があれば `unconfirmed_scope` に `item` が入る。欠陥と実行の判定そのものは、今の規則（修正の巡、計画の欠陥の `unverified[]`、検査の判定 `実行失敗`）のまま変えず、この確認には写すだけである。`unverified[]` には写さない（欠陥は既に各規則で載る）。
  - 理由: SP-012 は、決定的な検査を意味の確認と別の記録と判定として示すことを求める。照合を新しく足すと同じ欠陥を 2 か所で判定するので、既にある照合の結果を区分ごとにまとめる。
- **意味の確認の作り方**: 意味の確認は、`context.perspective` が非 null の task（抽出・形式化でない確認・忠実さ・保証・合成の検証者。原因の分類役は含まない）ごとに、CLI が `confirmations.meaning` に 1 つ作る。
  - 共通の欄: `kind` = `context.perspective`、`item` = `unit_id`、`checker` = その `task_id`（担当を出さなかった unit は `"cli"`）、`plan_id: null`、`end: null`、`materials` = （担当を出さなかった unit は `[]`。他は）`context.input_refs` の各 `ref` と、各 ref が指すファイルの、`tasks.json` を書く前に取った指紋（ディレクトリの ref は [task の一覧](#task-の一覧)の「ディレクトリの ref の指紋」で展開する。`run-daemon` が控え、後で取り直さない）。`property_ids`・`model_property_id` は下の表の「関わる性質」。
  - 正常に返ったとき: `result` は `ReviewReturn.result`、`reason` は空でない文。
  - task が `担当の失敗` になったとき（[担当の返り値](#担当の返り値)。batch の拒否を含む）: `result: "確認できず"`、`reason` は停止の理由 `担当の失敗` の `detail` と同じ文。返り値は使わない。理由: 確認を作らないと、確かめるはずだった unit が結果から消え、「確認が要らなかった」と区別できない。`Confirmation.result` に `未確認` の値は無く、確かめられなかったことは `確認できず` で表す。
  - 担当を出さなかったとき（確認の段で組み立てた unit のうち、確認の段の中で時間の上限に達して後の batch を出さなかったか、`task.md`・`tasks.json` を保存できなかったもの。確認の段に入らずに止まった run では、意味の確認を作らない。原因は、確認の段に入らずに止まった run でも、全ての反例と `対応できていない` 組合せについて、[担当の返り値](#担当の返り値)の「原因の分類役を出さなかったとき」と同じ形（`cause: "原因未確認"`・`classified_by: "cli"`・`grounds` は止まった理由の文）で作る（全ての反例と組合せが `causes` を持つ規則を保つ）。[CLI 契約の時間の上限が小さい依頼](cli-contract.md#定数)）: `result: "確認できず"`、`checker: "cli"`、`materials: []`、`reason` は出さなかった理由の文。`担当の失敗` は記録しない（停止の理由は `時間の上限` か `保存の失敗` が持つ）。理由: 確かめる者がいなかったことを、task_id の無い値で区別する。
  - `result` が `確認できず` の意味の確認は、`unverified[]` にも `item` = `unit_id`、`reason` = 同じ文で写す。正本は `Confirmation` である（`unverified[]` は SP-003 の未検証・未確認の欄として機械的に読むための写し）。`stop_report` があれば、`unconfirmed_scope` に `unit_id` が入る。
- **意味の確認から判定の入力への写し**（正常と失敗で共通。「全て成り立つ」は、その欄に関わる確認が 1 つ以上あって全て `成り立つ` のとき）

  | 観点 | 関わる性質（`Confirmation.property_ids`・`model_property_id`） | 結果で決まる欄 | 成り立たないとき（失敗を含む）の性質の判定 |
  |---|---|---|---|
  | `extraction` | 無し（`[]`・null） | `extraction_coverage.complete`（全ての `extraction` の確認が成り立つときだけ true になりうる） | 性質の判定には写さない。`confirmations_unresolved` で完了を妨げる |
  | `nonformal` | `context.property_ids`・null | その性質の `alternative_confirmed` | `成功` でない検査があれば段 1 の値。無ければ段 3 で値を返さず、段 5 の `未確認` |
  | `fidelity` | `model_id` のモデルの全ての性質の `inventory_property_ids` の和（重複なし、辞書順）・null | その性質の `meaning_confirmed` | 下の注 |
  | `assurance` | `context.property_ids`・`unit_id` の `assurance-` の後の id | その性質の `meaning_confirmed` | 下の注 |
  | `composition` | 無し（`[]`・null） | 全ての契約の `meaning_confirmed`（[契約の判定](#分割と合成sp-008009)） | 契約が `検証済み` にならず、親の性質は合成の条件（SP-009）が成り立たない。下の注 |

  - inventory の性質の `meaning_confirmed` は、その性質を `property_ids` に含む `fidelity` の確認と `assurance` の確認がそれぞれ 1 つ以上あり、それらが全て `成り立つ` ときだけ true である。
  - 注（形式化できる性質）: 検査が 1 件以上あって全て `成功` なら、段 2 の条件が成り立たず段 5 の `未確認`。`成功` でない検査があれば段 1 の値。検査が 0 件なら段 4 か段 5 で、確認の結果によらない。

### 記録（SP-014）

```text
Records = {
  ledger_refs: [Ref]+,                     // ledger.json。salvage の結果なら salvage-ledger.json も
  saved: [{ kind: RecordKind, ref: Ref, hash: Sha256 | null }],
  unsaved: [{ kind: RecordKind, ref: Ref | null, reason: string }]
}
```

- 結果のファイル自身と台帳は、`saved` では `hash: null` で持つ（指紋が循環するため）。他の記録は `hash` を持つ。
- 保存できたとするのは、再読込で指紋が一致した記録だけである。例外は結果のファイル自身で、link に成功した後に fsync か再読込が I/O の誤りになっても、R の `saved` の参照は変えない（[CLI 契約の link の後の失敗](cli-contract.md#結果と台帳の保存の失敗)。依頼者の決定）。台帳と結果の保存の失敗の組合せは [CLI 契約](cli-contract.md#結果と台帳の保存の失敗)。

### 停止の報告（SP-015）

```text
StopReport = {
  stage: Stage,                            // 下の「stop_report.stage の決め方」
  reasons: [{ code: StopCode, stage: Stage,
              request_code: RequestCode | null,   // code が 依頼の不備 のときだけ非 null
              item: Pointer | null,               // 理由が指す依頼の項目。無ければ null
              field: string | null,               // 依頼の中の JSON Pointer（形の不備のとき）。無ければ null
              detail: string }]+,
  confirmed_scope: [string], unconfirmed_scope: [string],
  artifacts_created: [{ kind: RecordKind, ref: Ref }], artifacts_not_created: [{ kind: RecordKind, reason: string }],
  checks_running: [{ id: Id, kind: ExecKind }], checks_aborted: [{ id: Id, kind: ExecKind }],
  questions: [Id],                         // Result.questions の id
  unsaved: [RecordKind]                    // Result.records.unsaved の kind
}
RequestCode = "target_missing" | "goal_missing" | "shape_invalid" | "duplicate_id" | "exclude_without_reason"
            | "pointer_unresolved" | "time_limit_invalid" | "target_unavailable" | "revision_mismatch"
StopCode =
    "依頼の不備"                // SP-001。request_code・item・field で項目を示す
  | "起動の失敗" | "処理の中断" | "時間の上限" | "保存の失敗" | "内部の誤り"
  | "必要な性質が検証の成功でない" | "確認が終わっていない"   // SP-012 の未実行・失敗・未確認
  | "対応できていない組合せ" | "回答を待つ問い" | "記録の未保存"
  | "必要な性質が 0 件" | "検出能力未確認"
  | "反例" | "実行できない検査" | "担当の失敗"
```

- `checks_running`・`checks_aborted` には、`Check`（`property`・`composition`・`contract`）と、道具を実行した `Confirmation`（`sanity`・`mutation`・`replay`）の両方を、`kind` を付けて入れる。
- **`stop_report.stage` の決め方**:
  - 中断の理由（`依頼の不備`・`起動の失敗`・`時間の上限`・`保存の失敗`・`内部の誤り`・`処理の中断`）が 1 つ以上あれば、そのうち最初に記録されたものの段とする（`reasons` は中断の理由を記録の順に先に並べる）。理由: 中断は、それが起きた段で run が止まったことを表す。
  - 中断の理由が無く、完了の条件で止まった場合だけ、`reasons` の段のうち `Stage` の並びで最も上流の段とする。
- 停止の理由の `stage` は、code ごとに次で決まる（理由: どの段の作業記録に結び付くかを一意にする）。

  | code | stage |
  |---|---|
  | `依頼の不備`・`起動の失敗` | `受付` |
  | `保存の失敗`・`時間の上限`・`内部の誤り` | 起きたときに実行していた段 |
  | `処理の中断` | `state.json` の最後に確定した段 |
  | `対応できていない組合せ` | `モデル化` |
  | `実行できない検査` | 道具が無い・準備できない（SP-007）なら `計画`、検査が `未実行`・`実行失敗` で終わったなら `実行` |
  | `反例` | `実行` |
  | `担当の失敗` | 失敗した task の `context.stage` |
  | `回答を待つ問い` | `確認`（問いは原因の分類で確定する） |
  | `必要な性質が検証の成功でない`・`確認が終わっていない`・`記録の未保存`・`必要な性質が 0 件`・`検出能力未確認` | `集約` |
- `保存の失敗` と `記録の未保存` の使い分け:
  - `保存の失敗`: run の途中で記録を書けず、その時点で停止の手順に入った（SP-014 の「保存できない記録があるならば停止」）。`stage` は書けなかった段。
  - `記録の未保存`: 集約の段の完了の条件で、`records.unsaved` が空でない（SP-015 の「記録を全て保存した」が成り立たない）。`stage` は `集約`。
  - 途中で書けなかった run では、両方が入る。
- 7 項目（段、理由、確認済み・未確認、生成済み・未作成、実行中・中止した検査、問い、保存できなかった記録）は、該当が無くてもキーを持つ。

### 性能の記録（SP-013、PR-036）

```text
Performance = {
  location: "ローカル" | "CI",
  run: { total_ms: Measure, preparation_ms: Measure, build_ms: Measure, checks_ms: Measure,
         confirmation_ms: Measure, storage_ms: Measure, cpu_time_ms: Measure, peak_rss_bytes: Measure,
         cost: Measure, human_interventions: Measure, retries: Measure },
  executions: [{ id: Id, kind: ExecKind, elapsed_ms: Measure, cpu_time_ms: Measure, peak_rss_bytes: Measure }],
  findings: [{ id: Id, problem: string, evidence: string,
               candidates: [{ change: string, keeps_scope_and_assurance: string }],
               decision: "この run では採用しない", reason: string }]
}
```

- `build_ms` は、ビルドの無い道具では `{ status: "該当なし", reason }`。`cost` は CLI から観測できないので `取得できず`。`retries` は再試行を持たないので `{ value: 0, unit: "count" }`。
- salvage の結果では `total_ms` と salvage の所要時間を `取得できず`（理由は [CLI 契約](cli-contract.md#salvage-の手順)）。

## 検査の終わり方（end）

道具の 1 回の実行の終わり方。判定の入力で、`checks/<execution_id>/end.json` と `Check.end`・`Confirmation.end` に入る。

```text
End = {
  started: boolean,
  tool_result: "満たす" | "反する" | "判定できない" | "判定以外のエラー" | "なし",
  abnormal_exit: boolean,                  // formal-method が止めていない道具が 0 以外で終わった
  unreadable_output: boolean,
  stopped_by: "時間" | "その他" | null,    // formal-method が止めた理由。止めていなければ null
  time_limit_hit: "依頼元" | "道具" | null // 実行中に達した時間の上限
}
```

**オラクルの語彙との対応**（`tests/formal/formal-method-spec/endstates.py` の `RET`・`STOP`・`TL`）

| End | RET |
|---|---|
| `started: false` | `NotStarted` |
| `tool_result` が `満たす`・`反する`・`判定できない`・`判定以外のエラー` | `Ok`・`Cex`・`Undec`・`Err` |
| `tool_result: "なし"` で `abnormal_exit: true` | `Crash` |
| `tool_result: "なし"` で `unreadable_output: true`（`abnormal_exit: false`） | `Unread` |
| `tool_result: "なし"` で両方 false | `NoReturn` |

| End | STOP | TL |
|---|---|---|
| `stopped_by` `時間`・`その他`・null | `Time`・`Abort`・`NoStop` | — |
| `time_limit_hit` null・`依頼元`・`道具` | — | `None`・`Req`・`Tool` |

- 次の組は起こらないものとし、作らない。`classifyCheck` は `invalid_end` で拒む。
  - オラクルの網羅表の `除外` と `unsat` の行（例: 道具が返りを報告した後に止めた、依頼元の時間の上限に達したのに止めていない）。
  - オラクルの語彙に写せない組: `tool_result` が `なし` 以外で `abnormal_exit` か `unreadable_output` が true、`abnormal_exit` と `unreadable_output` が両方 true、`started: false` なのに `tool_result` が `なし` 以外・`abnormal_exit`・`unreadable_output`・`stopped_by`・`time_limit_hit` のどれかが既定（`なし`・false・null）でない。期限と道具の終わりが重なったときは、先に観測した出来事だけで決める（道具の終わりと出力の読み終わりが先なら `stopped_by: null`・`time_limit_hit` は null か `道具`、期限が先なら `stopped_by: "時間"`・`tool_result: "なし"`）。

## 判定の 3 関数

`scripts/lib/verdict.mjs` が持つ純粋関数の入出力。規則の正本は SP-011・015 で、ここでは入出力と評価の順だけを書く。

### classifyCheck(end) → CheckVerdict

- 入力: `End`。
- 出力: `CheckVerdict` の 1 つ。各値は SP-011 の表の使う条件が成り立つときだけ付き、2 つ以上成り立てば `反例`・`時間切れ`・`実行失敗`・`未実行`・`unknown` の順で先の値。`成功` は `tool_result: "満たす"` で他のどの条件も成り立たないときだけ。
- 起こらない組を受けたら、値を返さずに例外を投げる。例外は `name: "InvalidEndError"`、`code: "invalid_end"` を持つ `Error` で、テストは `code` で照合する（`message` は自由な文で照合しない）。

### aggregateProperty(facts) → [Verdict]+

```text
PropertyFacts = {
  formalizable: boolean,
  check_verdicts: [CheckVerdict],          // check_ids の順
  no_suitable_tool: boolean,               // SP-007 の場合（道具が無い・準備できない）。下の決め方
  depends_on_question: boolean,
  correspondence: boolean,                 // SP-005 の対応がある
  meaning_confirmed: boolean,              // SP-005 の意味の確認
  deterministic_confirmed: boolean,        // SP-012 の決定的な検査と意味の確認。下の注記
  composition_applies: boolean,
  composition_confirmed: boolean,          // SP-009 の合成の条件（composition_applies が false なら無視）
  detection_performed: boolean,
  detection_confirmed: boolean,            // detection_performed が false なら無視
  alternative_confirmed: boolean           // SP-004 の別の方法による独立した確認
}
```

- `deterministic_confirmed` は、次の 3 つが全て成り立つときだけ true になりうる。(1) その性質を `inventory_property_ids` に含むモデルの性質の `sanity` の確認が 1 つ以上あって全て `成り立つ`。(2) そのモデルの性質の `sanity` に、欠陥が残って除いたものが無い。(3) そのモデルの性質に、下の「検査の欠け」（`kind: property` の検査か sanity の欠け）が残ったものが 1 つも無い（計画があり、性質が問いに依存せず `no_suitable_tool` でないとき）。`sanity` の確認が 1 つも無い（計画に無い、又は欠陥が残って全て除いた）性質では false とする。理由: 前提の矛盾で成り立つ成功を除けない（SP-005）。空の集合を成り立つと読むと、確かめていない性質が `検証済み` になる。

評価の順（最初に当たった段で返す）:

| 段 | 条件 | 返す値 |
|---|---|---|
| 1 | `check_verdicts` に `成功` 以外がある | `成功` 以外の値の全て（重複なし、`Verdict` の順） |
| 2 | `check_verdicts` が空でなく全て `成功`、`formalizable` | 次が全て成り立てば `["検証済み"]`: `!depends_on_question`、`correspondence`、`meaning_confirmed`、`deterministic_confirmed`、合成の条件、検出の条件 |
| 3 | `!formalizable` | `!depends_on_question` かつ `alternative_confirmed` なら `["別手段で確認済み"]` |
| 4 | `check_verdicts` が空、`formalizable`、`no_suitable_tool` | `["未実行"]` |
| 5 | 上のどれにも当たらない | `["未確認"]` |

オラクル（`questions.py` の `prop`）との対応: `formal`=`formalizable`、`corr`=`correspondence`、`mean`=`meaning_confirmed`、`det`=`deterministic_confirmed`、`dd`=`detection_performed`、`dok`=`detection_confirmed`、`altok`=`alternative_confirmed`、`pq`=`depends_on_question`、`notool`=`no_suitable_tool`。

### decideStatus(global) → { status, unmet }

```text
GlobalFacts = {
  required_verdicts: [[Verdict]+],         // 必要な性質ごとの判定の集合
  confirmations_unresolved: boolean,       // confirmations.deterministic か confirmations.meaning に result が 成り立つ でない要素が 1 つ以上ある（SP-012 の未実行・失敗・未確認）
  uncovered_combinations: int≥0,
  pending_questions: int≥0,
  all_records_saved: boolean,
  detection_unconfirmed: int≥0,            // 検出能力未確認の必要な性質の数
  has_counterexample: boolean,             // 必要な性質の判定の集合に 反例 がある
  has_unrunnable: boolean                  // 必要な性質の判定の集合に 未実行 か 実行失敗 がある（SP-015 の「必要な性質の検査を実行できない」）
}
Decision = { status: "完了" | "停止", unmet: [StopCode] }
```

- `完了` は、次の 9 つの述語が全て成り立つときだけである。成り立たない述語ごとに `unmet` に 1 つ入れる（順は下の並び）。
  1. `required_verdicts` の全ての要素が `["検証済み"]` か `["別手段で確認済み"]`（`必要な性質が検証の成功でない`）
  2. `!confirmations_unresolved`（`確認が終わっていない`）
  3. `uncovered_combinations == 0`（`対応できていない組合せ`）
  4. `pending_questions == 0`（`回答を待つ問い`）
  5. `all_records_saved`（`記録の未保存`）
  6. `required_verdicts` が空でない（`必要な性質が 0 件`。保持規則）
  7. `detection_unconfirmed == 0`（`検出能力未確認`。保持規則）
  8. `!has_counterexample`（`反例`）
  9. `!has_unrunnable`（`実行できない検査`）
- 1 と 8・9 は重なりうる。成り立たない述語は全て `unmet` に入る。
- オラクルの `glob` との対応: `combos_left`=3、`saved`=5、`sp12_ok`=2、`detunconf`=7、`pq_any`=4、性質の数=6。

## 担当の成果物

担当は自分の `attempts/<task_id>/` に書き、返り値の `outputs` で参照する。担当が書く全ての `Ref`（`outputs[].ref`・`query_ref`・`input_refs`・`mutation_ref`・`record_ref`・`worklog_ref` など）は、run の領域からの相対 path で、`attempts/<task_id>/` で始まるか、task が渡した資料を指す。理由: 起点を 1 つにすると、CLI も外の検査も参照を同じ規則で解ける。

- **担当が書く全ての `.smt2`**（モデル作成役の性質と sanity の query、分割作成役の契約と合成の条件の query、計画作成役の変異）は、`(check-sat)` をちょうど 1 つ、ファイルの最後の form として持ち、`get-model`・`set-option`・`push`・`pop`・`reset`・`exit`・並列の設定を書かない。
  - 照らすのは、そのファイルを書いた役の段の照合である。モデル作成役の query はモデル化の照合（query の構文の検査）、分割作成役の query は計画の段の分割の照合、変異は計画の照合で照らす。違反はその役の修正の巡の欠陥になる。修正の巡の後も違反が残った `.smt2` を `input_refs` か `mutation_ref` に持つ実行は、計画の照合で欠陥とし、[検査](#検査sp-010)の節のとおり実行しない。理由: 修正の巡は欠陥を見つけた照合の役に戻るので、ファイルを書いた役の段で照らさないと、直せない役に欠陥が戻る。

### inventory（抽出役。対象 1 つにつき 1 つ）

```text
Inventory = {
  schema: "formal-method.inventory/1",
  target_id: Id, content_hash: Sha256,      // 集まりの指紋
  scanned: [{ file: FilePath, span: Span | null, status: "read" | "unread", reason: string | null }]+,
           // 集まりの全てのファイルを覆い、テキストのファイルは全ての行を覆う。unread は reason 非 null。span が null ならファイルの全体
  elements: [{ id: Id, kind: "requirement" | "goal" | "state" | "input" | "output" | "constraint" | "event" | "result",
               source: { target_id: Id, file: FilePath, span: Span, quote_hash: Sha256 },  // quote_hash は span の行を "\n" でつないだ文字列の SHA-256
               text: string }],
  properties: [{ id: Id, source_ids: [Id]+, statement: string, formalizable: boolean,
                 nonformal_reason: string | null, nonformal_method: string | null,
                 assumptions: [string], scope: string, blocked_by_question: [Id] }],
  external_dependencies: [{ id: Id, text: string, source: SourceRef | null }]
}
```

### model（モデル作成役）

```text
ModelFile = {
  schema: "formal-method.model/1",
  model_id: Id, adapter_id: "z3",
  covers: <Model.covers と同じ形>,
  state_machine: StateMachine | null,
  no_state_machine_reason: string | null,  // state_machine が null のときだけ非 null
  io_contracts: [{ id: Id, pre: string, post: string, source_ids: [Id] }],
  properties: [{ id: Id, inventory_property_ids: [Id]+, query_ref: Ref, expected: "unsat" | "sat",
                 assurance: Assurance,
                 sanity: [{ kind: "assumptions_consistent" | "initial_exists" | "nontrivial_witness", query_ref: Ref }] }],
  behavior: <Model.behavior と同じ形>,
  source_diagrams: [{ source: SourceRef, format: "mermaid" }],
  omitted_edges: [{ from: string, event: string, condition: string }]
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
- query のファイル（`.smt2`）は、[担当の成果物](#担当の成果物)の `.smt2` の規則に従う。性質の query は「前提と性質の否定」で `expected: "unsat"`、sanity の query は `sat` を期待する。SMT の記号の名前は `variables[].id` と同じにする。

### mapping（モデル作成役）

```text
MappingFile = { schema: "formal-method.mapping/1",
  model_id: Id,                            // 対応付けるモデル。モデルごとに 1 つの MappingFile
  rows: [{ source: Pointer, property_id: Id, model_element: string,
           relation: "形式化" | "形式検証でない確認" | "範囲外" | "対応なし", reason: string | null }] }
```

`check_ids` は計画の後に CLI が埋め、`Model.mapping` になる。

- モデル作成役は 1 つの task で全てのモデルを作り、`outputs` にモデルごとの `model` と `mapping` を並べる。`MappingFile.model_id` が `ModelFile.model_id` と一致する組で結び付ける。どのモデルにも `MappingFile` がちょうど 1 つあり、どの `MappingFile` も実在のモデルを指す。理由: モデルの数と分け方は、inventory の全体を見て初めて決まる。モデルごとに task を出すには、その数を task の前に決める者が要る。
- 退けた案: モデルごとに model-author の task を出す。

### partitions（分割作成役。候補が 2 つ以上のときだけ）

```text
PartitionsFile = { schema: "formal-method.partitions/1",
  decisions: [{ candidate_id: Id, adopted: boolean, reason: string }]+,
  adopted: boolean, reason: string,
  parts: [<Decomposition.parts の要素>], boundaries: [<Boundary から responsible を除いたもの + responsible>],
  contracts: [{ id: Id, model_id: Id, derived_from: Id, part_id: Id, statement: string, query_ref: Ref }],
  composition_conditions: [{ id: Id, model_id: Id, derived_from: Id, statement: string, query_ref: Ref, depends_on: [Id] }] }
```

### plan と mutations（計画作成役）

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

- `tool_time_limit_seconds` ≤ `TOOL_TIME_LIMIT_MAX_S`（[CLI 契約](cli-contract.md#定数)）。
- `checks[].expected` は `unsat` である（`property`・`contract`・`composition` の query は「前提 ∧ ¬性質（契約・全体の性質）」なので）。`sat` の検査は計画の欠陥とする。
- **変異のファイル**: 変異の `.smt2` を書くのは計画作成役だけである。`mutation_ref` は、その計画作成役自身の `attempts/<task_id>/` で始まる（task が渡した資料を指す例外は、`mutation_ref` には当てない）。外れれば計画の欠陥（修正の巡の対象）。台帳の entry の `producer` はその計画作成役の `task_id` である。理由: 変異は計画作成役の成果物で、計画の照合で `.smt2` の規則を照らし、直せる役に修正の巡を戻すため。他の役のファイルを変異にすると、書いた者と台帳の `producer` が食い違う。
- **変異の無い性質の `detection`**（依頼者の決定）: 欠陥の残らない変異を 1 つも持たない性質は、`unavailable` の有無と `alternative` の有無によらず、`status: "検出能力未確認"`・`mutations: []`（`detection_performed: false`）とする。`reason` には、`alternative` の文（あれば全て、`unavailable` の順に）と「別の方法の確認の結果が無い」ことを書く。欠陥で変異を除いた性質では、この 2 つに加えて、除いた変異の計画の id も書く（3 つとも書き、片方で代えない）。
  - 理由: SP-012 は、別の方法による検出能力の確認の「結果」を示すことを求める。`alternative` の文は方法の宣言で、どの担当の返り値にも、その方法で確認した結果の欄が無い（保証の独立検証者は `alternative` が妥当かを判断するだけである）。将来、担当の返り値に確認の結果の欄を足せば、その結果で `別の方法で確認` を使える。
- 必要な性質ごとに、`mutations` の要素か `unavailable` の要素が 1 つ以上ある。この照合は計画作成役が返した計画に当て、欠陥の残った変異を除いた後には当て直さない。変異を全て除かれて `unavailable` も無い性質は、変異も別の方法も無いので、`detection` は `status: "検出能力未確認"`・`mutations: []` で、`reason` に除いた変異の計画の id を書く（SP-012）。性質の判定は `detection_performed: false` で決まる（検出能力未確認は判定に混ぜず、`decideStatus` の述語 7 で `完了` を妨げる）。
- 形式化できる必要な性質（問いに依存するものを除く）ごとに、`selection` の要素がちょうど 1 つある。欠けか重なりは計画の欠陥（修正の巡の対象）とする。修正の巡の後も残れば、その性質の検査（下の「道具の名前」の照合と同じく `inventory_property_ids` と `derived_from` で辿る `property`・`contract`・`composition` の検査）も欠陥の残った計画の要素として実行しない（[検査](#検査sp-010)の節）。そのため性質の判定は検査の欠けと同じく `未確認`（`no_suitable_tool` なら `未実行`）で、run は `decideStatus` の述語 1（必要な性質が検証の成功でない）で `停止` になる。
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

## 担当の返り値

`attempts/<task_id>/return.json`。最後の応答は `{ "task_id": ..., "return_path": ... }` だけにする。

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
  perspective: "extraction" | "nonformal" | "fidelity" | "assurance" | "composition",
  result: "成り立つ" | "成り立たない" | "確認できず",
  findings: [{ ref: string, kind: "omission" | "addition" | "meaning_change" | "assurance_overclaim" | "vacuity" | "mutation_invalid" | "boundary_gap" | "circular_assumption" | "other", note: string }],
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

- 返り値が無い、形が違う、`outputs`・`record_ref`・`worklog_ref` が attempt の領域の外か存在しない、`task_id`・`unit_id` が task と違う場合は、成功に数えない（作業記録の失敗の欄に理由が残る）。
- これらの場合、`status: "cannot_proceed"`、及び受け箱の batch の拒否（[CLI 契約](cli-contract.md#受け箱)。その batch の全ての task）は、停止の理由 `担当の失敗` を、その task の `context.stage` を段として記録する。`担当の失敗` は中断の理由ではない。run は止めずに次の段へ進み、その担当が作るはずの成果物は未作成になる。`context.perspective` が非 null の task なら、その unit の確認は `result: "確認できず"` の `Confirmation` になる（[確認](#確認sp-004005012)）。原因の分類役の task なら、CLI がその `subject` の `Cause` を `cause: "原因未確認"`・`grounds` = `担当の失敗` の `detail` と同じ文・`classified_by` = その `task_id` で作る。原因の分類役を出さなかったとき（時間の上限か保存の失敗）は、同じ形で `grounds` = 出さなかった理由の文・`classified_by: "cli"` とする（全ての反例と組合せが `causes` に 1 つずつある規則を保つ。問いの `subject` なら、分類が `要求の不足` でないので問いとして返さない）。理由: 他の性質の検証を続ける（依頼者の決定）。そのうえで、`stop_report.stage` が失敗した処理の段になる（中断の理由が無いとき、段の並びで最も上流の段を取る規則による。AC-19）。
- **`AuthorReturn.blocked_by_question`**（担当の指示と `agent-obligations.md` のとおり、性質の id）:
  - 各 id は、モデル作成役・計画作成役では `context.property_ids` に、抽出役では返した inventory の `properties[].id` にある。無ければ返り値の形の違い（成功に数えない）。
  - 抽出役では、性質ごとの `Inventory.properties[].blocked_by_question`（問いの id）が依存の正本で、`AuthorReturn.blocked_by_question` はそれが空でない性質の id の集合と一致する。違えば形の違い。
  - モデル作成役・計画作成役が挙げた性質 P の `depends_on_questions` は、その返り値の `questions` のうち `affected` に P の id を含むものの id。1 つも無ければ、その返り値の全ての問いの id とする。
- **性質の id の名前空間**:
  - inventory の性質の id: `PropertyResult.id`、`Inventory.properties[].id`、`AuthorReturn.blocked_by_question`、`context.property_ids`、`nonformal-<id>`、`Confirmation.property_ids`、`PlanFile.selection[].property_id`（道具の選択は、結果の性質ごとの `method` になるため）、`MutationsFile.unavailable[].property_id`（検出能力の結果は性質ごとの `detection` になるため）。
  - モデルの性質の id（`ModelFile.properties[].id`。run の全てのモデルを通して一意）: graph の `prop:<model_id>/<id>`、`assurance-<id>`、`Confirmation.model_property_id`、`PlanFile.checks[].target_id`（`kind: property` のとき）、`PlanFile.sanity[].model_property_id`、`MutationsFile.mutations[].property_id`（検出役の検査がモデルの性質の検査であるため）。
  - `PlanFile.checks[].target_id` は、`kind: composition` なら `composition_conditions[].id`、`kind: contract` なら `contracts[].id` である。
  - 2 つの名前空間は `ModelFile.properties[].inventory_property_ids` で結び付く。

## task の一覧

`batches/<batch_id>/tasks.json`。

```text
TaskList = { batch_id: Id, deadline_wall_ms: int, tasks: [Task]+ }      // tasks は AGENT_BATCH_MAX 個以下
Task = {
  task_id: Id,
  role: "extractor" | "model-author" | "partition-author" | "plan-author"
      | "extraction-reviewer" | "fidelity-reviewer" | "assurance-reviewer" | "composition-reviewer" | "cause-analyst",
  model: string, effort: string,
  prompt: string,                         // "Read <task.md の絶対 path> and follow it exactly. It is your complete task."
  output_schema: { type: "object", additionalProperties: false, required: ["task_id", "return_path"],
                   properties: { task_id: { type: "string" }, return_path: { type: "string" } } },
  attempt_dir: string, return_path: string,               // 絶対 path
  context: TaskContext
}
TaskContext = {
  run_dir: string,                        // 絶対 path。Ref の起点
  stage: Stage,                           // task を出した段。担当の作業記録の stage はこの値
  unit_id: Id | null,                     // 独立検証者と原因の分類役だけ非 null。返り値の unit_id はこの値
  perspective: "extraction" | "nonformal" | "fidelity" | "assurance" | "composition" | null,   // 独立検証者だけ非 null
  target_id: Id | null,                   // extractor と perspective が extraction のとき非 null
  model_id: Id | null,
  property_ids: [Id],
  candidates: [{ id: Id, nodes: [string]+ }],   // partition-author だけ空でない（Decomposition.candidates と同じ id）
  subject: <Cause.subject と同じ形> | null,     // cause-analyst だけ非 null
  input_refs: [{ name: string, ref: Ref }],     // 読む資料。作成側の作業記録と attempt の領域のディレクトリは入れない
  revise_defects_ref: Ref | null                // 修正の巡のときだけ非 null
}
```

**役と context**（`unit_id` の作り方は決定的で、同じ run の中で一意）

| role | perspective | 非 null の欄 | `unit_id` |
|---|---|---|---|
| `extractor` | null | `target_id` | null |
| `model-author` | null | `property_ids`（必要な性質のうち、抽出役が `blocked_by_question` に挙げていないもの） | null |
| `plan-author` | null | `property_ids`（`model-author` の `property_ids` のうち、`formalizable` が true で、モデル作成役が `blocked_by_question` に挙げておらず、いずれかのモデルの性質の `inventory_property_ids` に含まれるもの） | null |
| `partition-author` | null | `candidates` が空でない | null |
| `extraction-reviewer` | `extraction` | `unit_id`・`target_id` | `extraction-<target_id>` |
| `assurance-reviewer` | `nonformal` | `unit_id`・`property_ids`（inventory の性質の id が 1 つ） | `nonformal-<inventory の性質の id>` |
| `assurance-reviewer` | `assurance` | `unit_id`・`model_id`・`property_ids`（そのモデルの性質の `inventory_property_ids`） | `assurance-<モデルの性質の id>`（`ModelFile.properties[].id`） |
| `fidelity-reviewer` | `fidelity` | `unit_id`・`model_id` | `fidelity-<model_id>` |
| `composition-reviewer` | `composition` | `unit_id` | `composition` |
| `cause-analyst` | null | `unit_id`・`subject` | `cause-counterexample-<id>`・`cause-combination-<model_id>-<n>`（`n` はその組の `Combinations.cells` の中の 0 から数えた位置を 10 進で書いたもの）・`cause-question-<id>` |

- `ReviewReturn.perspective` は `context.perspective` と同じ値を返す。
- 組合せの `unit_id` に状態と出来事の名前を入れないのは、名前が `Id` の文字（英数字・「-」「_」「.」）に合うとは限らないためである。`cells` の順は宣言順で決まる（[形式モデル](#形式モデルと対応sp-005006)の `Combinations`）ので、位置は同じモデルから決定的に決まる。組合せの名前は `context.subject`（`state`・`event`）が持つ。
- `PartitionsFile.decisions` は、`context.candidates` の全ての id を 1 つずつ持つ。

**独立検証者と原因の分類役の `input_refs`**（CLI が作る正本。担当の読む範囲は `agent-obligations.md` の独立検証者の節）

- `ref` は `run_dir` からの相対 path。どの行も、先頭に `{ name: "request", ref: "request.json" }` を置く（原因の分類を含む）。
- 「対象の写し」は `targets/<target_id>/files/`（ディレクトリ）、「照合の記録」は `worklogs/cli-<段>.json`、「検査の記録」は `checks/<execution_id>/`（ディレクトリ）を指す。

| 観点（`perspective`） | `input_refs` に入れるもの（`request` の後） |
|---|---|
| `extraction` | その `target_id` の写しと `manifest.json`、その対象の inventory、`worklogs/cli-洗い出し.json` |
| `fidelity` | 全ての対象の写しとその `manifest.json`、全ての inventory、その `model_id` のモデルと対応表、`worklogs/cli-モデル化.json`。図はモデルから CLI が導く値でファイルが無いので、モデルで代える |
| `assurance` | その `model_id` のモデルと対応表、その性質の `query_ref`、`PlanFile`、`MutationsFile`（あれば）、その性質（`unit_id` の `assurance-` の後の id）を `target_id` か `model_property_id` に持つ検査・sanity・変異・replay の各実行の検査の記録 |
| `nonformal` | その性質の `source_ids` の要素の `target_id` の写し、その性質を持つ inventory |
| `composition` | `PartitionsFile`、全てのモデル、`contracts[]`・`composition_conditions[]` の `query_ref`、`kind` が `contract`・`composition` の検査の記録、`worklogs/cli-計画.json`。依存グラフと候補は CLI が導く値でファイルが無いので、モデルと分割で代える |
| 原因の分類（`cause-analyst`、`perspective` は null） | 全ての対象の写し。`subject` が反例なら、その検査と replay の検査の記録、そのモデルと対応表。組合せなら、その `model_id` のモデルと対応表、`worklogs/cli-モデル化.json`。問いなら、問いを返した作成役の `outputs` のファイル |

- 実行していない検査（記録のディレクトリが無いもの）は入れない。`attempts/` のディレクトリは入れない（その中のファイルは入れてよい）。
- **ディレクトリの ref の指紋**: `materials` と台帳の `input_refs`（どちらも `[RefHash]`）では、ディレクトリを指す `input_refs` の要素を、その下の全てのファイル（再帰的に、ディレクトリ自身は除く）の `RefHash` に展開する。並びは `input_refs` の要素の順で、1 つのディレクトリから展開したものの中だけを `ref` の UTF-8 のバイト列の辞書順に並べる。ファイルを指す要素はそのまま 1 つの `RefHash` にする。指紋を取る時点は意味の確認の作り方と同じ（`tasks.json` を書く前）。理由: `RefHash` はファイル 1 つの指紋なので、ディレクトリの中身を渡した資料として再現できる形にする。

**task.md の形**: 次の 4 つの見出しをこの順に持つ Markdown。各見出しの下の本文は、空でない。

```text
## ROLE
<担当の指示ファイルの絶対 path と、共通の義務のファイルの絶対 path>
## TASK
<Task から prompt を除いた JSON（1 行）>
## RETURN_SCHEMA
<返り値の JSON Schema（AuthorReturn・ReviewReturn・CauseReturn のどれか）>
## WRITE
<書いてよい領域（attempt_dir）、返り値を書く path（return_path）、最後の応答の形 {"task_id", "return_path"}>
```
```

## Workflow の返り値

`submit` の `workflow_output_path` が指すファイル。

```text
WorkflowOutput = { batch_id: Id,
  results: [{ task_id: Id, status: "returned" | "missing" | "error",
              received: { task_id: Id, prompt: string, model: string, effort: string, output_schema: object },
              error?: string }] }
```

- `received` の 5 つの値が `tasks.json` の同じ task と全て一致し、`results` の task の集合が `tasks` と一致するときだけ、その batch の返り値を使う。一致しなければ batch の拒否（[CLI 契約](cli-contract.md#受け箱)）である。

## 作業記録

担当は `attempts/<task_id>/worklog.json`、決定的な処理は `worklogs/cli-<段>.json` に書く（PR-028・033・042）。担当の作業記録の `stage` は、task の `context.stage`（task を出した段）である。`run-daemon` は、入った全ての段（止まった段を含む）について `worklogs/cli-<段>.json` を、その段を出る前か停止の手順の中で書く。書けなければ `records.unsaved` に載せる。

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
- salvage の作業記録は時刻を含まない。

## 記録台帳

`ledger.json`（`run-daemon` だけが書く）と `salvage-ledger.json`（salvage の追補）。担当は書かない（PR-030）。

```text
Ledger = {
  schema: "formal-method.ledger/1",
  run_id: Id,
  kind: "main" | "salvage",
  entries: [{ kind: RecordKind, ref: Ref, hash: Sha256, stage: Stage,
              producer: string,           // "cli"、担当の task_id、又は "salvage"
              model: string | null, effort: string | null, permissions: [string],
              input_refs: [RefHash] }],    // producer が担当の task_id の entry は、その task の context.input_refs を「ディレクトリの ref の指紋」で展開したもの（作業記録を含む全ての記録で同じ）。"cli"・"salvage" の entry は []
  registered_result_hash: Sha256          // 登録した結果の指紋。結果のファイルが保存されたことは示さない
}
```

- `model`・`effort`・`permissions` は `producer` で決まる。
  - 担当の `task_id`: その task の `model`・`effort`（`tasks.json` の値）と、`permissions` = `scripts/lib/roles.mjs` の `AGENT_PERMISSIONS`（`["fresh-thread", "workspace-write"]`。Workflow の `meta.requirements` の値で、役によらず同じ）。
  - `"cli"`・`"salvage"`: `model: null`・`effort: null`・`permissions: []`。理由: agent でなく、Workflow が与える権限を持たない。
- 同じ内容を複数の記録に正本として書かない（PR-032）。判定の正本は結果、道具の生の入出力の正本は `checks/` の証拠で、台帳は参照と指紋を持つ。

## id と参照の一覧

id と参照の全ての欄の、名前空間・一意の範囲・実在の確かめ方・起点の正本。テストはこの表で照合する。

**名前空間と一意の範囲**

| 名前空間 | 作る者 | 一意の範囲 |
|---|---|---|
| 依頼の id（`targets`・`goals`・`known_requirements` の `id`） | 依頼元 | 種類ごとに依頼の中で一意（SP-001） |
| run_id・nonce・batch_id・task_id・unit_id・execution_id | CLI | run の中で一意（run_id は保存先の root の中で一意） |
| inventory の要素の id（`Inventory.elements[].id`） | 抽出役 | run の全ての inventory を通して一意 |
| inventory の性質の id（`Inventory.properties[].id`） | 抽出役 | run の全ての inventory を通して一意 |
| model_id | モデル作成役 | run の中で一意 |
| モデルの性質の id（`ModelFile.properties[].id`） | モデル作成役 | run の全てのモデルを通して一意 |
| モデルの中の名前（状態・出来事・変数の id・遷移の id・io_contracts の id） | モデル作成役 | 1 つのモデルの中で一意。モデルを跨ぐ参照は graph の要素の id で行う |
| graph の要素の id・辺の id | CLI（導出の規則） | run の中で一意（モデルの id か query の Ref を含む） |
| 候補の id（`C<n>`） | CLI | run の中で一意 |
| 部分・契約・合成の条件・境界の id | 分割作成役 | run の中で一意 |
| 実行と確認の id（`PlanFile.checks[].id`・`PlanFile.sanity[].id`・`MutationsFile.mutations[].id`・`Confirmation.id`）。1 つの名前空間 | 計画の 3 つは計画作成役。`Confirmation.id` は種類を問わず全て CLI が `confirm-<kind>-<n>` で作る（計画の sanity・変異から作った確認も同じ。計画の id は `plan_id` に残す） | run の中で、4 つを通して一意。計画の照合で、計画の 3 つの id が `confirm-` で始まらないことを確かめる |
| 反例の id・問いの id・findings の id | CLI | run の中で一意 |
| Ref | 書く者 | run の領域の中の path |
| FilePath | CLI（対象の取得） | 1 つの対象の集まりの中で一意 |

**欄ごとの表**（起点の列: 「run」は run の領域、「対象」は対象の根、「モデル」はモデルのファイル、「依頼」は依頼の JSON）

| 欄 | 名前空間 | モデルが 2 つ以上で一意か | 実在を確かめる所 | 起点 |
|---|---|---|---|---|
| `SourceRef.target_id`・`Pointer.target_id`（kind `location`）・`unread[].target_id` | 依頼の id（target） | 一意 | 受付の照合（`pointer_unresolved`） | — |
| `SourceRef.file`・`Pointer.file`・`unread[].file`・`fixed.files[].path` | FilePath | 一意 | 受付の照合 | 対象 |
| `Pointer.id`（kind `target`・`goal`・`known_requirement`） | 依頼の id | 一意 | 受付の照合 | — |
| `fixed.snapshot_ref`・`Model.ref`・`Location.file`・`evidence_refs`・`Records.*.ref`・`ledger_refs`・`steps_ref`・`materials[].ref`・`Worklog.inputs[].ref`・`unreadable_inputs[].ref`・`document_rules.ref`・`Ledger.entries[].ref`・`input_refs[].ref` | Ref | 一意 | 書いた者が書いた直後の再読込、集約の照合（結果の参照の再読込） | run |
| `Location.pointer` | JSON Pointer か `form:` | 一意（`file` と組で） | 依存グラフの導出 | モデル・`.smt2` |
| `PropertyResult.id`・`AuthorReturn.blocked_by_question`・`Counterexample.property_id`・`mapping[].property_id`・`Model.unmapped.properties`・`Confirmation.property_ids`・`context.property_ids`・`PlanFile.selection[].property_id`・`MutationsFile.unavailable[].property_id`・`comparison_basis.property_ids`・`inventory_property_ids` | inventory の性質の id | 一意 | 洗い出しの照合（inventory の中）、モデル化の照合（`inventory_property_ids`・mapping）、計画の照合（selection・unavailable） | — |
| `Inventory.properties[].source_ids`・`io_contracts[].source_ids`・`transitions[].source_ids`・`forbidden[].source_ids` | inventory の要素の id | 一意 | 洗い出しの照合（性質の出所）、モデル化の照合（モデルの出所） | — |
| `sources[].id`（kind `goal`・`known_requirement`） | 依頼の id | 一意 | 洗い出しの照合 | — |
| `Model.id`・`Check.model_id`・`context.model_id`・`MappingFile.model_id`・`parts[].model_id`・`Contract.model_id`・`composition_conditions[].model_id`・`Cause.subject.model_id`・`PlanFile.checks[].model_id` | model_id | 一意 | モデル化の照合（mapping とモデルの組）、計画の照合 | — |
| `goals[].property_id`・`Paths.targets[].property_id`・`Paths.verified[].property_id`・`composition_conditions[].derived_from`・`Confirmation.model_property_id`・`PlanFile.checks[].target_id`（kind `property`）・`PlanFile.sanity[].model_property_id`・`MutationsFile.mutations[].property_id`・`Contract.derived_from`・`assurance-<id>` | モデルの性質の id | 一意 | モデル化の照合（goals）、計画の照合（checks・sanity・mutations・契約。分割の照合で、契約と合成の条件の `derived_from` が同じ `model_id` のモデルの性質を指すこと） | — |
| `transition_ids`・`resumptions[].transition_id`・`Combinations.cells` の `state`・`event`・`Cause.subject.state`・`event` | モデルの中の名前 | モデルの中だけで一意。`Model.id` か `Cause.subject.model_id` と組で使う | モデル化の照合（直積と分類） | モデル |
| `graph.nodes[].id`・`graph.edges[].id`・`from`・`to`・`candidates[].nodes`・`parts[].owns_variables`・`parts[].transitions`・`Boundary.edge_id`・`correspondence` の要素 | graph の要素の id・辺の id | 一意 | 計画の照合（分割の照合） | — |
| `candidates[].id`・`strength_to[].candidate_id`・`decisions[].candidate_id`・`context.candidates[].id` | 候補の id | 一意 | 計画の照合（全ての候補に 1 つの判断） | — |
| `parts[].id`・`Boundary.producer`・`consumer`・`Contract.part_id`・`Boundary.responsible`・`assumption_basis.contract_id`・`PlanFile.checks[].target_id`（kind `contract` は `contracts[].id`、kind `composition` は `composition_conditions[].id`） | 部分・契約・合成の条件の id | 一意 | 計画の照合（`target_id` は `kind` に合う種類の id に実在すること）。`Boundary.responsible` は分割の照合（同じ分割の `contracts[].id` に実在すること） | — |
| `assumption_basis.known_requirement_id` | 依頼の id（known_requirement） | 一意 | 計画の照合（依頼に実在すること） | — |
| `PropertyResult.check_ids`・`Model.mapping[].check_ids`・`Contract.check_ids`・`composition_conditions[].check_ids`・`assumption_basis.check_ids`・`Counterexample.check_id`・`detector_check_id`・`depends_on`（checks）・`StopReport.checks_*[].id`・`Performance.executions[].id` | 実行と確認の id（1 つの名前空間） | 一意 | 計画の照合（計画の中）、集約の照合（結果の `checks[]` と `confirmations` を合わせた中に、ちょうど 1 つ実在。`PropertyResult.check_ids`・`Model.mapping[].check_ids`・`Contract.check_ids`・`composition_conditions[].check_ids`・`Counterexample.check_id` は、加えて `checks[]` に、[検査](#検査sp-010)の節と[反例と原因](#反例と原因sp-011)の節の `kind` で実在。`detector_check_id` は `kind: property`。`assumption_basis.check_ids` は `kind` を問わず `checks[]` に実在。空でよいかは各欄の型による。`Model.mapping[].check_ids` が 形式化 の行で空なら、その行の `reason` が非 null であることを照合する） | — |
| `PropertyResult.confirmation_ids`・`Detection.mutations[].confirmation_id`・`replay.confirmation_id` | 実行と確認の id のうち `Confirmation.id`（`confirm-` で始まる） | 一意 | 集約の照合（`confirmations` に実在） | — |
| `Confirmation.plan_id`・`Detection.mutations[].id` | 実行と確認の id のうち計画の id（`PlanFile.sanity[].id`・`MutationsFile.mutations[].id`） | 一意 | 計画の照合（計画の中に実在） | — |
| `Cause.subject.id`（kind `counterexample`）・`Counterexample.id` | 反例の id | 一意 | 集約の照合 | — |
| `Question.id`・`Cause.subject.id`（kind `question`）・`depends_on_questions`・`StopReport.questions`・`Inventory.properties[].blocked_by_question` | 問いの id | 一意 | 確認の段（原因の分類）と集約の照合。`Cause.subject.id`（kind `question`）が `questions[]` に実在するのは、その `Cause.cause` が `要求の不足` のときだけで、他の原因なら `questions[]` に無い | — |
| `Task.task_id`・`AuthorReturn.task_id`・`ReviewReturn.task_id`・`CauseReturn.task_id`・`Worklog.task_id`・`Cause.classified_by`・`Confirmation.checker`（意味の確認）・`Ledger.entries[].producer`・`WorkflowOutput.results[].task_id` | task_id | 一意 | 受け箱の読込み（task の照合）、返り値の回収 | — |
| `context.unit_id`・`ReviewReturn.unit_id`・`CauseReturn.unit_id` | unit_id | 一意 | 返り値の回収（task の `context.unit_id` と一致） | — |
| `TaskList.batch_id`・`WorkflowOutput.batch_id`・受け箱の `batch_id`・`Status.batch.batch_id` | batch_id | 一意 | 受け箱の読込み | — |
| `Task.attempt_dir`・`return_path`・`context.run_dir`・`Status.run_dir`・`tasks_path`・`workflow_script`・`workflow_output_path` | 絶対 path | 一意 | 読む者が読むとき | 絶対 |
| `AuthorReturn.outputs[].ref`・`record_ref`・`worklog_ref`・`ModelFile.properties[].query_ref`・`sanity[].query_ref`・`contracts[].query_ref`・`composition_conditions[].query_ref`・`PlanFile.checks[].input_refs`・`sanity[].input_refs`・`mutation_ref`・`revise_defects_ref` | Ref | 一意 | 返り値の回収（attempt の領域の中にあり実在すること）、計画の照合（query と input の実在） | run |
| `ReviewReturn.findings[].ref` | 自由な文（確認した箇所の表し） | — | 照合しない | — |
| `StopReport.reasons[].item` | `Pointer` | 一意 | 受付の照合 | 依頼 |
| `StopReport.reasons[].field`・`unverified[]` の未知のキーの表し | JSON Pointer | 一意 | — | 依頼 |
| `Status.daemon`・`run.lock`・`salvage.mark` の `pid`・`started_at`・`nonce` | process の識別 | — | 生死の判定（[CLI 契約](cli-contract.md#生死の判定)） | — |

- 「実在を確かめる所」に書いた照合で実在しない参照は、その段の欠陥（修正の巡の対象）か、結果の `unverified[]` の項目になる。集約の照合で見つかった結果の中の参照の欠けは、`内部の誤り` で止める（結果の構造が壊れているため）。

