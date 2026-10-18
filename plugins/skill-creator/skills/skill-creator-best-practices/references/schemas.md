# エージェント間入出力スキーマ定義

skill-creator-best-practices 内の各エージェントが入出力するデータの契約書。
フィールド名のズレでパイプラインが壊れるため、変更時は全エージェントに伝播させること。

## 目次
- [Criteria：基準生成の出力](#criteria基準生成の出力)
- [Structure：構成設計の出力](#structure構成設計の出力)
- [Write：執筆の出力](#write執筆の出力)
- [Test/Grade：テスト・検証の出力](#testgradeテスト検証の出力)
- [build_skill.js の戻り値](#build_skilljs-の戻り値)
- [eval framework](#eval-framework優先度c)
- [review/update/audit の入出力](#reviewupdateaudit-の入出力)

---

## Criteria：基準生成の出力

### criteria-gen / criteria-comp の出力（検証基準リスト）

自由形式のテキストだが、以下の構造を維持すること。

```
## [カテゴリ名]

N. **[基準名]**：[判定方法（「〜が含まれているか」「〜が明記されているか」など判定可能な形式）]
N. ...

判定可能かどうか不安なものには ⚠️ を付ける。
```

---

## Structure：構成設計の出力

### structure-designer の出力（構成案）

```
## 構成案

### アーキテクチャ設計（マルチエージェント系スキルの場合のみ）
採用パターン：[パターン名（複数可）]

| agent名 | モデル | 責務（1行） |
|--------|--------|-----------|
| ...    | ...    | ...       |

assets に分離するもの：[ファイル名：内容]

### 変更サマリー
（追加 N件 / 変更 N件 / 削除 N件）

### セクション構成
| セクションID | 操作 | タイトル | 位置 | 目的・理由 | 対応する基準 |
|------------|------|--------|------|----------|-----------|

### 情報の流れ
（箇条書き）

### ⚠️ 懸念点
```

### structure-reviewer の出力（STRUCTURE_REVIEW_SCHEMA）

```json
{
  "checks": [
    { "name": "A. 要件との整合性", "result": "ok | warn | fail", "rationale": "根拠（構成案からの引用）" },
    { "name": "B. 実現可能性", "result": "ok | warn | fail", "rationale": "..." },
    { "name": "C. 情報の流れ", "result": "ok | warn | fail", "rationale": "..." }
  ],
  "failed": ["言葉で補足する問題の要点"],
  "warnings": ["要確認の点"],
  "priority_fixes": ["先に直すべき箇所"],
  "report": "構成レビューレポート本文（散文）"
}
```

`checks[].result` が判定の契約で、`fail` は `build_skill.js` が直接走査して差し戻しに回す
（`failed[]` への転記に依存しない）。`name` は項目ごとに区別できる文字列にする
（同名の `fail` が複数あると script 側の重複除去で 1 件に畳まれる）。

---

## Write：執筆の出力

### writer（initial モード）の出力（SKILL.md 全文）

```
---
name: [スキル識別子（英小文字・ハイフン区切り・最大64文字）]
description: >
  [3人称で記述。最大1024文字。[What]+[When]の両方を含む。XML タグ禁止]
---

# [スキル名]

[本文]
```

### writer（initial モード）の追加出力（`ARCHITECTURE` が `workflow` のときのみ）

SKILL.md 全文に続けて、workflow script を ```` ```javascript ```` フェンスで出力する。
`build_skill.js` は**`export const meta` で始まるフェンスブロック**を script 本体として取り出す
（本文中の説明用 JS 断片と取り違えないための条件）。取り出せない場合はその場で打ち切る。

````
```javascript
export const meta = {
  name: '[スキル名]',
  description: '[一行の説明]',
  phases: [{ title: '[phase 名]', detail: '[説明]' }],
}

phase('[phase 名]')
...
```
````

script の制約は `references/skill-writing-guide.md`「Workflow 型スキルの執筆」の禁止表が正本（ここに列挙しない）。

### script-reviewer の出力（`ARCHITECTURE` が `workflow` のときのみ）

```json
{
  "verdict": "ok | mismatch",
  "intended_behavior": "要件だけから先に導いた「本来の挙動」（必須）",
  "failed": [
    {
      "category": "A | B | C | D | E",
      "item": "該当する検査項目",
      "evidence": "script 中の該当箇所",
      "why_it_matters": "実行時に何が起きるか",
      "should_be": "本来どう動くべきか（挙動の記述）",
      "fix": "そのために script をどう直すか"
    }
  ],
  "warnings": [{ "item": "確認したい点", "note": "補足" }],
  "script_summary": "実際に読んだ script の構造の要約（必須）"
}
```

- カテゴリ：A=起動前・実行中に落ちる / B=黙って間違える / C=barrier の誤用 / D=人間ゲートと停止条件 / **E=設計が要件に対して正しいか**（工程分割・不変条件の構造化・verify の独立性・集約が問いに答えているか）
- `intended_behavior` は **script を読む前に要件だけから導く**。これを必須にしているのは、script の構造を所与として禁止構文を探すだけの検査になるのを防ぐため（script 中のコメントは主張であって根拠ではない）。E は A・B より重い — 禁止構文は直せば済むが、工程分割の誤りは書き直しになる
- A または B が 1 件でもあれば `verdict: mismatch`
- `script_summary` が必須なのは、reviewer が script を読まずに `ok` を返す経路を残さないため
- reviewer が応答しなかった場合、`build_skill.js` はそれを「失格 0 件」と読まず
  `verdict: script_review_incomplete` で返す（未検証を検証済みに化けさせない）

### writer（revise モード）の出力

```
[修正後の完全な SKILL.md テキスト]

## 変更箇所
- [変更箇所の説明を箇条書き]
```

---

## Test/Grade：並列評価・採点の出力

### tester の出力（テストケース3件）

```
テスト1（正常系エッジ・発動すべき）: [ユーザーの発話文]
テスト2（準正常系・発動すべき）: [ユーザーの発話文]
テスト3（発動すべきでない）: [ユーザーの発話文]
```

### grader の出力（採点結果 JSON）

```json
{
  "eval_id": 1,
  "assertions": [
    {
      "text": "アサーション文",
      "with_skill": { "result": "pass|fail|partial", "evidence": "根拠" },
      "baseline":   { "result": "pass|fail|partial", "evidence": "根拠" }
    }
  ]
}
```

**grader は集計を返さない（破壊的変更。旧 schema の `summary` は required から外れた）。**
`pass_rate` / `delta` は create の workflow（plugin の `workflows/build_skill.js`）が算出して各 grading 行へ付け足す
（`summary.with_skill.pass_rate` / `summary.baseline.pass_rate` / `summary.delta`）。
partial の重み（`PARTIAL_WEIGHT`）と側間の差の定義は script の 1 箇所だけにある。

自己申告の数値を受け取ると、判定の内訳と数値が食い違っていても突き合わせる材料が無く、
ゲートに入るのは数値の方になる。判定だけを受け取れば内訳と数字は常に一致する。
判定が 1 つでも欠けている側の `pass_rate` は `0` ではなく `null`（測れなかった）。

### reviewer の出力（REVIEW_SCHEMA）

```json
{
  "criteria_checks": [
    { "name": "基準名", "result": "ok | warn | fail", "rationale": "根拠（対象テキストの引用）" }
  ],
  "trigger_checks": [
    { "test_id": "テストケースの id", "expectation_met": true, "rationale": "判断と理由" }
  ],
  "unchecked_judgments": [
    { "id": "UNCHECKED_ITEMS の id", "verdict": "pass | partial | fail | unknown", "evidence": "根拠" }
  ],
  "failed": ["言葉で補足する失格の要点"],
  "warnings": ["要確認"],
  "priority_improvements": ["優先度の高い改善点"],
  "report": "散文の検証レポート本文"
}
```

| フィールド | 必須 | 保証していること |
|---|---|---|
| `criteria_checks[].result` | ○ | 基準ごとの判定。script が `fail` を直接走査して失格に足す |
| `trigger_checks` | ○（破壊的変更で追加） | 任意のままだと、description の発火可否という判定を「返さなければ無かったこと」にできる |
| `trigger_checks[].expectation_met` | ○ | `false` を script が直接走査して失格に足す |
| `unchecked_judgments` | ○（破壊的変更で追加） | 機械検査が判定しないと宣言した項目の判定。返ってこなかった id は script が集合の差で拾い、未判定として失格にする |
| `failed[]` | ○ | 判定フィールドの**言い換えではなく補足**。ここへの書き漏れで失格が消えることはない |

**判定は判定フィールドが正で、`failed[]` は要約**。ゲートが `failed[]` だけを見ると、判定を
そこへ書き写す作業が agent の裁量に残り、落ちても script からは「失格 0 件」と同じ形に見える。
昇格の実装は `build_skill.js` の `judgmentFailures`（STRUCTURE / REVIEW の双方が同じ関数を呼ぶ）。
`unchecked_judgments` のどの verdict が合格にならないかは script の `UNCHECKED_BLOCKING` が正本。

同じことが `STRUCTURE_REVIEW_SCHEMA` の `checks[].result` にも当てはまる（`fail` は
script が直接失格へ回し、`failed[]` への転記に依存しない）。

`unchecked_judgments` のうち `requires_measurement: true` の項目（「委譲項目（[UNCHECKED_ITEMS]）の受け渡し」）は
失格に数えず、満たしたと判定されなかったもの（未判定を含む）を `pending_measurement` に分ける。

---

## build_skill.js の戻り値

create の workflow（plugin の `workflows/build_skill.js`）が返す値。

```
{
  task_type, architecture, workflow_script, script_review,
  criteria, structure: { plan, attempts, unresolved, review },
  skill_draft, test_cases, iterations[], final, revisions_used, pending_measurement, verdict
}
```

| フィールド | 意味 |
|---|---|
| `iterations[].review_failures` | reviewer の失格（`criteria_checks` の `fail`・`trigger_checks` の `expectation_met: false`・改稿で満たせる委譲項目の未達と未判定・`failed[]`）を script が合算したもの。改稿の writer にはこれだけを渡す |
| `iterations[].pending_measurement` | `requires_measurement: true` の委譲項目のうち、reviewer が満たしたと判定しなかった（`UNCHECKED_BLOCKING` の verdict か未判定）ものの id。改稿では変わらないので失格にも改稿の起動条件にも数えない。reviewer が応答しなかった回は `null`（判定していない。`[]` は「待ちは無い」） |
| `pending_measurement` | 最後の `iterations[]` の `pending_measurement` |

`verdict` は次の値を取る（`script_rejected` / `script_review_incomplete` は `architecture: "workflow"` のときだけ出る）。
判定の順は script が持つ。

| verdict | 意味 |
|---|---|
| `passed` | 全テストケースが採点され、reviewer も応答し、delta が `DELTA_THRESHOLD` 以上（workflow は delta を見ない）、失格 0 件、かつ `pending_measurement` が空 |
| `pending_measurement` | `passed` の条件のうち `pending_measurement` が空でないことだけが欠けている。改稿で直せるものは満たしたが、残りは evals の実測でしか確かめられないので改稿を起動していない。合格ではない |
| `needs_human_decision` | 評価は揃ったが、改稿上限に達しても閾値に届かなかった（品質の問題） |
| `evaluation_incomplete` | 採点 agent か reviewer が応答せず、合否を判定できなかった（品質とは無関係）。workflow では reviewer 欠測のみが該当 |
| `revision_failed` | 改稿 agent が応答しなかった |
| `script_rejected` | **workflow のみ**。評価は通ったが script-reviewer が失格項目を挙げた |
| `script_review_incomplete` | **workflow のみ**。script-reviewer が応答せず、script を検証できなかった |

---

## eval framework（優先度C）

### evals.json の構造

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "ユーザーのタスクプロンプト",
      "expected_output": "期待する動作の説明",
      "files": [],
      "assertions": [
        "〜が含まれているか",
        "〜が明記されているか"
      ]
    }
  ]
}
```

### grading.json の構造

```json
{
  "eval_id": 1,
  "configuration": "with_skill",
  "expectations": [
    {
      "text": "〜が含まれているか",
      "passed": true,
      "evidence": "該当箇所の引用"
    }
  ],
  "summary": {
    "total": 3,
    "passed": 2,
    "failed": 1,
    "pass_rate": 0.67
  }
}
```

### benchmark.json の構造

aggregate_benchmark.py が生成する形式。

```json
{
  "skill_name": "example-skill",
  "iteration": "iteration-1",
  "configs": {
    "with_skill": { "mean": 0.85, "stddev": 0.05, "min": 0.67, "max": 1.0, "n": 3 },
    "without_skill": { "mean": 0.55, "stddev": 0.10, "min": 0.33, "max": 0.67, "n": 3 }
  },
  "delta": {
    "config_a": "with_skill",
    "config_b": "without_skill",
    "pass_rate": 0.30
  }
}
```

---

## Analyze：comparator の出力

```json
{
  "winner": "A または B または TIE",
  "scores": {
    "A": {
      "content": { "accuracy": 4, "completeness": 3, "precision": 4, "total": 3.67 },
      "structure": { "organization": 4, "format": 5, "usability": 4, "total": 4.33 },
      "overall": 4.0
    },
    "B": {
      "content": { "accuracy": 3, "completeness": 4, "precision": 3, "total": 3.33 },
      "structure": { "organization": 3, "format": 3, "usability": 3, "total": 3.0 },
      "overall": 3.17
    }
  },
  "assertion_pass_rate": { "A": 0.83, "B": 0.67 },
  "reasoning": "A はコンテンツの正確性と構造のフォーマットで優れており...",
  "notable_differences": ["A は対象外リクエストを正確に拒否した"]
}
```

## Analyze：analyzer の出力

```json
{
  "mode": "post-hoc または benchmark",
  "winner": "with_skill または without_skill または tie",
  "summary": "1〜2文の総評",
  "patterns": {
    "with_skill_wins": ["アサーション文"],
    "without_skill_wins": ["アサーション文"],
    "both_pass": ["アサーション文"],
    "both_fail": ["アサーション文"]
  },
  "improvements": [
    {
      "category": "instructions",
      "priority": "high",
      "suggestion": "具体的な改善案",
      "affected_assertions": ["関連するアサーション文"]
    }
  ]
}
```

## feedback.json の構造

eval-viewer のレビュー完了後にダウンロードされる形式。

```json
{
  "reviews": [
    {
      "run_id": "1",
      "feedback": "チェック項目の確認がより丁寧だった",
      "timestamp": "2026-05-27T10:32:45Z"
    }
  ],
  "status": "complete"
}
```

---

## review/update/audit の入出力

review/update/audit の workflow（plugin の `workflows/review_skill.js`）が finder / refuter / updater と交換する契約。
**観点の一覧・反証者の観点・閾値・改稿ループの停止条件・prompt-audit の確信度から severity への写像は script の
`FINDERS` / `PERSPECTIVES` / `FIRST_STAGE_PERSPECTIVES` / `REVISE_SEVERITIES` / `PROMPT_AUDIT_SEVERITY` が唯一の正**なので、ここには写さない。
ここが定義するのはフィールドの形と、その形が保証していることだけ。

### caller input: `snapshot`

`review` / `update` / `audit` は `review-snapshot.mjs prepare` の出力を `args.snapshot` として渡す。
`targetRoot` は `target.skillPath` と同じ canonical absolute path、`scope` は `target.scope` と同じ値でなければならない。
`diff` は同じ `diffRef`・実際の diff bytes・changed paths を持つ。`select_runtime.js` は receipt と manifest の hash、
対象 tree の各 content hash、diff artifacts を検証してから route する。Workflow の戻り値にある
`source_snapshot.validation` は `required_after_workflow_before_result_is_trusted`。caller は post-run `verify` が
`status: verified` を返すまで review verdict を信頼しない。

```json
{
  "version": 1,
  "status": "ready",
  "scope": "diff",
  "targetRoot": "/abs/repo/plugins/example/skills/demo",
  "snapshotDir": "/tmp/codex-skill-review-random/tree",
  "manifestPath": "/tmp/codex-skill-review-random/manifest.json",
  "manifestSha256": "<sha256>",
  "receiptPath": "/tmp/codex-skill-review-random/receipt.json",
  "diffRef": "main...HEAD",
  "diffPath": "/tmp/codex-skill-review-random/diff.patch",
  "changedPathsPath": "/tmp/codex-skill-review-random/changed-paths.json",
  "diffSha256": "<sha256>",
  "changedPaths": ["SKILL.md"],
  "evidencePackPath": "/tmp/codex-skill-review-random/evidence-pack.txt",
  "evidencePackSha256": "<sha256>"
}
```

`evidencePackPath` / `evidencePackSha256` は prepare が snapshot の文書を行番号つきで連結した evidence pack と、その
SHA-256（manifest の `evidencePack` にも入り、selector と verify が照合する）。pack に入れる拡張子は
`review-snapshot.mjs` の `EVIDENCE_PACK_EXTENSIONS` が正本で、入れなかったファイルは pack の冒頭と manifest の
`evidencePack.excludedFiles` に宣言される。workflow は Find / Verify の各体に `[EVIDENCE_PACK]` としてパスを渡す。
`full` では diff 関連フィールドは `null` で、`changedPaths` は空配列。selector の Codex route が返す `runner_limits` は
dynamic-workflow-runner request の top-level `limits` へ渡し、`args` には入れない。

### caller input: `seedFindings`（update のみ・任意）

先行する 1 つの run が出した指摘を、改稿の候補としてそのまま渡す欄。渡すと Find を走らせず、指摘を severity に
関わらず全件 Verify（反証）にかける。反証を生き残ったものだけを updater の `[CONFIRMED_FINDINGS]` と Reverify の
突き合わせの基準（`resolved` / `remaining` を決める最初の確定指摘）にし、棄却・未検証は通常の Verify と同じ
バケット（`findings_before.rejected` / `findings_before.unverified`）に入る。Find を省くのは、同じ対象をもう一度
全観点から探し直すと頼まれていない指摘まで確定して改稿が広がるため。反証にかけるのは、先行 run の後に対象が
変わって evidence が今の snapshot に無い指摘を「直した」と数えないため。

```json
{ "source_run_id": "<先行 run の run id>", "findings": [ <下のコピー元の要素をそのまま> ] }
```

- `source_run_id`: 指摘を出した Workflow run の識別子。native Workflow ではその run の `runId`（`resumeFromRunId` に
  渡す値）、Codex runner ではその run の request に caller が割り当てた `runDir`（run ごとに新しく作る）。checkpoint から
  続けた run は新しい `runDir` で走るので、指摘を返した最後の run の `runDir` を使う。
  script は値を照合せず出所として戻り値の `seed` に載せるだけなので、他の文書はこの定義を参照する。
- 1 つの run の指摘だけを受ける。指摘 id は run ごとに振られ、別の run の id は衝突する（review と audit の両方に
  `p1-prompt-audit-1` が出る）。複数の run の指摘を直すときは update を分ける。
- **コピー元（閉じた列挙。正本はここ）**:
  - review / audit の結果を直すとき: その run の `findings.confirmed` と `findings.reported_minor` のうち、
    ユーザーが直すと選んだ要素。
  - update の `needs_human_decision` / `reverify_incomplete` / `update_failed` から回し直すとき: その run の
    `findings_before.confirmed` と `findings_before.unverified`。先の staging は捨てられ、原本には改稿前に見えていた
    指摘が全部残っている（未検証の blocker を落とすと追跡から消える。seed は全件 Verify にかかるので、未検証が
    確定に化けることは無い）。`staging.new` などは捨てた staging にしか無い欠陥なので含めない。
  - `unchecked_failures` の要素はコピーしない（下の拒否条件）。委譲項目は Reverify で毎回判定し直される。
- 司令塔は要素を**加工せずにコピーする**（内容を書き換えない）。`votes` などの余分な欄は script が読まずに捨てる。
  script が読むのは `id`・`category`・`file`・`location`・`claim`・`evidence`・`severity`・`suggested_fix`。
- 形が合わなければ起動直後に落とす（原則は「範囲を絞る入力は、形が合わなければ全体へ広げず落とす」で、
  検査の正本は `review_skill.js` の `seedFindings` の組み立て）。落ちる形の例: mode が `update` でない、object でない
  （配列で複数 run を渡した）、`source_run_id` や `findings` が空、必須欄の欠落や `location` が文字列でない、
  `category` が `FINDERS` の id でない、`severity` が `blocker` / `major` / `minor` でない、`file` が相対パスでない、
  diff scope で `file` が changed paths に無い、`id` や観点・ファイル・主張の重複、1 観点あたり `MAX_FINDINGS_PER_FINDER`
  件の超過（Reverify の finder がその件数しか再報告できないため）、`requires_measurement` を持つ要素がある
  （`unchecked_failures` の要素。指摘として再報告されないので、seed にすると読んだだけで解消に数えられる）、
  `target.intentScope` との併用。
- 戻り値の `seed` に出所が載り、`by_category.before`・`skipped_unavailable.before`・`declared_only.before` は
  `null`（Find を走らせていない）。委譲項目は Reverify で初めて判定される。

### caller input: `target.intentScope`（update のみ・任意）

`seedFindings` を渡さず自由文の `intent` だけで回すときに、Find を変更意図の範囲に絞る欄。司令塔が閉集合から選ぶ。

```json
{ "categories": ["why-driven", "loopholes"], "files": ["SKILL.md"] }
```

| フィールド | 意味 |
|---|---|
| `categories` | 任意。Find で走らせる観点（`FINDERS` の id の重複のない空でない部分集合）。省略すると全観点 |
| `files` | 任意。Find が指摘を報告してよいファイル（対象スキルからの相対パスの重複のない空でない配列。diff scope では changed paths の部分集合）。範囲外の指摘を返した観点は欠測になる（diff scope の changed paths と同じ扱い）。走らせたどの観点も読まなかったファイルがあれば `unscanned_intent_files` に載り、`review_incomplete` で止まる（存在しないパスを渡して何も見ないまま通る経路を塞ぐ）。updater にも同じ一覧が渡り、一覧の外の既存ファイルは変えない（新設の可否は `agents/updater.md` の規則に従う） |

少なくとも一方が要り、形が合わなければ起動直後に落とす（検査の正本は `review_skill.js` の `intentScope` の組み立て）。
未指定なら従来どおり全観点・全体。Reverify は改稿後の回帰の守りなので、この欄に関わらず変更されたファイルに
全観点をかける（報告範囲は「review_skill.js の戻り値」の `reverify_scope`）。走らせなかった観点は
`by_category.before` に `"out_of_intent_scope"` で載る（見ていない）。`files` の外も Find では見ていない。

### finder の出力（FINDINGS_SCHEMA）

```json
{
  "findings": [
    {
      "file": "SKILL.md",
      "location": "## モード判定",
      "claim": "複数行に一致したときの優先順位が書かれていない",
      "evidence": "| 依頼の形 | モード | 進む先 |",
      "severity": "blocker",
      "suggested_fix": "実体を伴う行を優先する規則を1行足す",
      "present_in_original": true
    }
  ],
  "scanned_files": ["SKILL.md", "agents/writer.md", "references/best-practices.md"],
  "unreadable": false,
  "note": ""
}
```

| フィールド | 必須 | 保証していること |
|---|---|---|
| `findings[].evidence` | ○ | 引用が無い指摘は反証者が検証できず、確定も棄却もされないまま未検証で終わる |
| `findings[].severity` | ○ | `blocker` / `major` / `minor`。update の打ち切り判定に使う |
| `scanned_files` | ○ | 再検査で「指摘が消えた」と「そのファイルを誰も開かなかった」を区別する唯一の手がかり。任意にすると `unobserved` の判定が動かない |
| `unreadable` | ○ | 読めなかったことを「指摘 0 件」と区別する。`true` の観点は欠測として `by_category` に `null` で載る |
| `findings[].present_in_original` | 任意（Reverify のみ） | evidence の引用が改稿前の原本の同じファイルにもそのまま存在し、かつ指摘が成立する条件（参照先・前提）が改稿で変わっていなければ `true`、それ以外は `false`。`[INTENT]` との不一致を指摘するものは、前提である意図が改稿で与えられたので常に `false`。原本が読めなければ省略する（分からないものを `false` にしない）。script はこれで `new` と `preexisting` を分け、`[REVERIFY_SCOPE]` の外の指摘を反証に回すかも決める（「review_skill.js の戻り値」の `reverify_scope` を参照） |
| `unchecked_judgments` | 担当観点のみ（schema 上は任意） | `[UNCHECKED_ITEMS]` の各 id に対する判定と根拠（`file` / `location` を含む欄の契約は「委譲項目（[UNCHECKED_ITEMS]）の受け渡し」）。どの観点が担当するかは script の `FINDERS` の `owns_unchecked` が正本。担当が省いても、返ってこなかった id は集合の差で未判定になる |
| `unavailable` | 任意 | 依存する skill / criteria / capability を利用できず検査を実施できなかったときだけ `true`。`unreadable`（対象が読めない）とは別。受け付ける条件（観点・`args.promptAuditExpected`・pass）は `review_skill.js` の `may_be_unavailable` の注釈が正本で、受け付けないときは欠測として扱う |
| `audit_header` | prompt-audit の観点のみ | 監査対象 scope、`references/prompt-audit.md` の criteria source、target model の前提（対象に記載が無い場合は未指定）を記した非空の receipt。空なら script は監査済み no-findings と区別できず、その観点を欠測として扱う |
| `findings[].audit_confidence` / `findings[].audit_action` | prompt-audit の観点のみ | 監査レポートの Confidence（`High` / `Medium` / `Low`）と Action。severity への写像・写像の外の扱い・再確認中の指摘の例外は `review_skill.js` の `PROMPT_AUDIT_SEVERITY` と `mapAuditItems` の注釈が正本。戻り値の指摘にもそのまま残る |
| `declared_only` | prompt-audit の観点のみ | 写像の外（`Low`・`flag`）の項目の `{ file, location, claim, audit_confidence, audit_action }`。指摘にはせず、戻り値の `declared_only` に載る |

schema は全観点で 1 つにしてある（理由は `skill-writing-guide.md`「subagent への指示と prompt cache」）。
観点ごとの必須性は script が担当の観点についてだけ読むことで保つ。

#### 委譲項目（[UNCHECKED_ITEMS]）の受け渡し

```json
{ "unchecked_judgments": [ { "id": "verifier-path", "verdict": "fail", "evidence": "...", "file": "SKILL.md", "location": "L120" } ] }
```

委譲項目の判定契約の正本はこの節で、受け取る agent（reviewer・finder）はここを参照する。

- **id 一覧の正本は `scripts/quick_validate.py` の `UNCHECKED_ITEMS`**。workflow script は
  ファイルを開けないので、司令塔が `--emit-unchecked` の出力を `args.uncheckedItems` へ
  そのまま渡し、script が prompt へ verbatim 注入する。js 側に id を書き写さない。
- 受け取った agent は、渡された id **すべて**について `verdict`（`pass` / `partial` / `fail` / `unknown`）と
  根拠の `evidence` を返す。対象から判断できないなら `unknown` にし、`pass` に丸めない。
- finder（review_skill.js）は、`partial` / `fail` の判定に、満たしていない箇所の `file`（`[TARGET_DIR]` からの相対）と
  `location` を付け、`evidence` には何が足りないかを書く。未達は `unchecked_failures` の要素として updater に渡り、
  updater はこの欄だけで直す箇所を決めるため（省くと `file` は `SKILL.md`、`location` は `機械判定できない項目: <id>` になる）。`unknown` は
  判定できなかったことを表し、満たしていない箇所を特定していないので付けない。reviewer（build_skill.js）の schema には
  この 2 欄が無い。
- 合格にならない verdict の集合は script の `UNCHECKED_BLOCKING` が正本。`fail` を避けて中間の値を
  選んでも合格にはならない。
- 各項目は真偽値の `requires_measurement` を持つ（正本は同じ `UNCHECKED_ITEMS`）。`true` は「満たしたかを evals の
  実測でしか確かめられず、文書の改稿では満たせない」項目。workflow はこの値を args から読むだけで、項目 id を
  自分では持たない。欠けている・真偽値でない要素があれば起動直後に落ちる。`true` の項目の未達と未判定は、
  create では失格に数えず `pending_measurement` に、review / update では `unchecked_failures` に
  `requires_measurement: true` を付けて残す（update の未解消には数えない）。どちらも「満たした」扱いにはしない。
  `false` の項目の未達は、update で未解消に数え、updater に `[UNCHECKED_FAILURES]` として渡す。
- 返ってこなかった id は script が集合の差で拾い、未判定として失格／未解消に変換する。
  id で渡すのは、委譲を散文で宣言するだけだと、受け取った側が落としても出力に現れず誰にも分からないため。

### refuter の出力（REFUTE_SCHEMA）

```json
{ "verdicts": [
  { "id": "p1-why-driven-1", "verdict": "refuted", "reason": "SKILL.md L52 に該当の記述があり、指摘の引用と一致しない" },
  { "id": "p1-loopholes-2", "verdict": "not_refuted", "reason": "L80-L84 を読んだが分岐の優先順位は書かれていない" }
] }
```

refuter 1 体は同じファイルにある指摘の束（最大 `MAX_FINDINGS_PER_REFUTER` 件。超えた分は別の束）を観点 1 つで判定し、
指摘 `id` ごとの票を返す。script は `id` で照合し、返答に無い `id`・2 回以上返った `id`・agent の失敗はその指摘の
欠測（有効票に数えない）にする。`not_refuted` に寄せると、判定されていない指摘が確定側の票を得るため。
束に無い `id` の票は捨てる。多数決・早期決着は束ではなく指摘ごとに下す。

`verdict` は `refuted` / `not_refuted` / `unreadable` の三値。boolean にすると
「読めなかった」を `false`（反証できなかった）に押し込むことになり、検証していない票が
確定側の有効票として数えられる。`unreadable` と欠測は有効票に数えない。

反証は 2 段で起動する。体数は指摘の重さと票だけで script が決め、agent の申告では変わらない。
1 段目の観点（重さと `seedFindings` かどうかごとに何体・どれか）は script の `FIRST_STAGE_PERSPECTIVES` が正本。
1 体の段は `not_refuted` の有効票 1 つで確定する。2 体以上の段は全員が有効票で同じ verdict を返したときだけ
その verdict で決着する。決着しなかった指摘（`refuted`・`unreadable`・欠測・不一致）だけを観点ごとに束ね直して
残りの観点を全て起動し、全観点の有効票のうち同じ verdict が `REFUTE_MAJORITY` に届いたときだけ確定・棄却する。
届かなければ `unverified`。観点の並び（1 段目に何を置くか）の根拠は `PERSPECTIVES` の注釈が正本。
反論役どうしは互いの票を見ない（票の独立が崩れると多数決が 1 つの判断の写しになる）。
起動しなかった観点は各指摘の `skipped_perspectives` に残り、起動した観点の票は `votes[]` に
`{ perspective, verdict, reason }` として残る。段ごとの起動数は戻り値の `refuter_dispatch` に残る。反証に回すのは severity が
`REVISE_SEVERITIES` の指摘だけで、それ以外は戻り値の `reported_minor` に入る（例外は `seedFindings` で、severity に
関わらず全件を、`FIRST_STAGE_PERSPECTIVES` の seed の行で始めて反証にかける。1 段目に existence を含める理由は `review_skill.js` の `FIRST_STAGE_PERSPECTIVES` 直上のコメントが正本）。束の thunk が落ちて行が返らなかった指摘も、集合の差で拾って票の無い `unverified` にする
（結果から消さない）。

各指摘の `missing_perspectives` は起動したが有効な票を返さなかった観点（束の thunk ごと落ちた指摘は、起動していない観点も含めて全観点）、`skipped_perspectives` は 1 段目で決着した
ため意図的に起動しなかった観点を示す。未実施と意図的な省略を混同しない。

### updater の出力（UPDATE_SCHEMA）

```json
{
  "changed_files": [
    { "path": "SKILL.md", "reason": "モード判定に優先順位規則を追加", "findings_addressed": ["p1-loopholes-1"] },
    { "path": "agents/finder.md", "reason": "unreadable の返し方を追記", "findings_addressed": ["intent"] }
  ],
  "out_of_scope_changes": [
    { "kind": "outside_skill", "path": "plugins/skill-creator/workflows/review_skill.js", "change": "戻り値に観点の件数を足す（スキル内の散文だけでは指摘が解消しないため）" }
  ],
  "summary": "指摘2件を解消し、意図どおり observability を追加した。未検証の指摘1件は判断できず据え置いた。"
}
```

`changed_files` は**実際に内容を変えたファイルだけ**。staging には対象スキルの全ファイルが
複製されるが、この一覧は承認後に本体へコピーする対象そのものなので、無変更のファイルを
載せると承認されていない上書きが起きる。`findings_addressed` を必須にしているのは、
指摘にも意図にも紐づかない改稿を後段の突き合わせで説明できないため（意図由来なら
`"intent"` と書く）。`out_of_scope_changes` は staging では行わなかった変更（スキル内の削除・改名・移動、対象スキルの外の
変更、渡された指摘と `intent` の範囲の外で必要だと updater が判断した変更。`kind` の値は `workflows/review_skill.js` の
`UPDATE_SCHEMA` の enum が正本）で、`summary` と違い
script が戻り値の `staging` に、巡をまたいで累積して載せる（同じ `kind`・`path` は 1 件にまとめる）。

### review_skill.js の戻り値

```json
{
  "mode": "update",
  "target": { "skillPath": "/abs/path", "scope": "full", "diffRef": null, "focus": null, "intentScope": null },
  "unscanned_intent_files": null,
  "seed": null,
  "refuter_dispatch": {
    "before": { "batches": 1, "stage_agents": [2, 1], "lost_batches": 0 },
    "after": [{ "pass": "p2r1", "batches": 1, "stage_agents": [1, 0], "lost_batches": 0 }]
  },
  "source_snapshot": { "target_root": "/abs/path", "snapshot_dir": "/tmp/codex-skill-review-x/tree", "receipt_path": "/tmp/codex-skill-review-x/receipt.json", "manifest_sha256": "<sha256>", "evidence_pack_sha256": "<sha256>", "scope": "full", "diff_ref": null, "validation": "required_after_workflow_before_result_is_trusted" },
  "verdict": "applied_to_staging",
  "stop_reason": "resolved",
  "findings": { "confirmed": [], "rejected": [], "unverified": [], "reported_minor": [] },
  "findings_before": { "confirmed": [], "rejected": [], "unverified": [], "reported_minor": [] },
  "unchecked_failures": [],
  "skipped_unavailable": { "before": [], "after": [] },
  "declared_only": { "before": [], "after": [] },
  "findings_source": "after",
  "by_category": { "before": { "why-driven": 1 }, "after": { "why-driven": 0 } },
  "reverify_missing": [],
  "reverify_receipt": {
    "phase": "Reverify", "staging_dir": "/abs/path-workspace/staging",
    "fresh_thread": true, "completed": true,
    "by_category": { "why-driven": 0 },
    "skipped_unavailable": [],
    "updater_thread_id": "update-sonnet-p1",
    "fresh_thread_id": "find-why-driven-p2r1"
  },
  "staging": {
    "dir": "/abs/path-workspace/staging",
    "changed_files": [],
    "out_of_scope_changes": [],
    "resolved": [], "remaining": [], "new": [],
    "unverified": [], "possibly_rephrased": [], "unobserved": [],
    "reclassified": [], "preexisting": [],
    "preexisting_recheck": { "still_confirmed": [], "resolved": [], "minor": [], "still_unverified": [], "refuted_on_recheck": [], "unobserved": [] },
    "still_unverified": [], "refuted_on_recheck": [],
    "unverified_absent": [], "unverified_unobserved": [],
    "reverify_scope": {
      "changed_files": ["SKILL.md"], "recheck_ids": ["p1-why-driven-1"],
      "report_files": { "why-driven": ["SKILL.md", "references/a.md"] },
      "excluded_findings": []
    },
    "reverify_missing": []
  },
  "revisions_used": 0
}
```

| フィールド | 意味 |
|---|---|
| `refuter_dispatch` | `{ before, after }`。反証の段ごとの起動数 `{ batches, stage_agents: [1 段目, 2 段目], lost_batches }`（`lost_batches` は thunk が落ちて行が返らなかった束の数）。`before` は Verify の記録（走らなければ `null`）。`after` は update で完了した Reverify の巡ごとの記録の配列（各要素は `pass` に Reverify の pass ラベルを足したもの。update 全体の帳簿）。review / audit では `after` が `null` |
| `seed` | `seedFindings` で Find を省いた run なら `{ source_run_id, count }`（`count` は渡された指摘の数）、それ以外は `null`。`seed` のとき `findings_before` は渡された指摘をこの run で反証した結果（`confirmed` は生き残った指摘、`rejected` / `unverified` はそれ以外。`reported_minor` は空） |
| `target.intentScope` | 受け取った `target.intentScope` を正規化した値（`{ categories, files }`。省略した欄は `null`）。無ければ `null` |
| `unscanned_intent_files` | `target.intentScope.files` のうち Find のどの観点も読まなかったもの。1 件でもあれば `review_incomplete`。`files` が無ければ `null` |
| `findings.confirmed` / `findings.rejected` / `findings.unverified` | 反証を生き残った指摘 / 過半数の反証で棄却された指摘 / 有効票が足りず確定にも棄却にもできなかった指摘（票の欠けた観点は各指摘の `missing_perspectives`） |
| `staging` | update で改稿を書いた後の結果一式。review / audit と、最初の Update より前に止まった update では `null` |
| `staging.dir` | 改稿の書き出し先。対象スキルの**全ファイルのミラー**（変更しなかったファイルも入る） |
| `staging.changed_files` | updater が実際に内容を変えたファイルと、その理由・対応する指摘（UPDATE_SCHEMA の `changed_files` の `path` から先頭の `./` を除いたもの。再検証の範囲もこの値で決まる）。承認後に本体へ適用する対象そのもの |
| `staging.out_of_scope_changes` | updater が staging では行えないため行わなかった変更（各巡の UPDATE_SCHEMA の `out_of_scope_changes` を累積したもの）。承認しても適用されないので、別途の対応が要る。`update_failed` では落ちた巡の申告が含まれない。1 巡目で落ちたときは申告が 1 つも無いため `null`（0 件とは言えない）、2 巡目以降で落ちたときは前の巡までの累積 |
| `staging.new` | 再検証で新しく出た確定指摘のうち、改稿が持ち込んだ可能性があるもの（`preexisting` との分け方は `preexisting` の行） |
| `staging.unverified` | 再検証で確定にも棄却にもできなかった指摘。`remaining` と混ぜない |
| `reclassified` | 改稿前に未検証・棄却だった指摘が、再検証で票が揃って確定したもの。改稿が持ち込んだものではないので `new` に入れない |
| `preexisting` | 分類: 再検証で確定した指摘のうち、最初の確定指摘でも改稿前に見えていた指摘でもないものは、`present_in_original: true` なら preexisting、それ以外は `new` に分ける。分類は指摘が最初に分けられた巡で固定し、以後の巡で `present_in_original` が揺れても変えない。中身: その巡で初めて preexisting に分けられた指摘だけ（前巡までに分けられた指摘のその後は `preexisting_recheck`）。改稿前の検査が見落とした既存の問題なので `new` には入れないが、`REVISE_SEVERITIES` のものは未解消に数え、以後の全巡の updater に `[PREEXISTING_FINDINGS]` として渡し、再確認の対象にも入れる |
| `preexisting_recheck` | 前巡までに `preexisting` に入った指摘の、この巡の再確認の結果。`still_confirmed`（再び確定した。prompt-audit の指摘が `changed_files` に無いファイルから消えたときもここに置く。理由は `resolved` / `remaining` / `new` の行の prompt-audit の扱いと同じ。未解消に数える）/ `resolved`（そのファイルを同じ観点の担当が報告範囲内で読み、再報告しなかった）/ `minor`（minor に格下げして再報告された）/ `still_unverified`（再報告されたが確定にも棄却にもならなかった。`staging.unverified` の内数で、未解消に数える）/ `refuted_on_recheck`（過半数の反証で棄却された）/ `unobserved`（読まれなかった、または報告範囲外）。blocker だったものでどこに入ると止まるかは `stop_reason` の行 |
| `stop_reason` | update の改稿ループをどの出口で抜けたか。`resolved`（未解消 0 件 → `applied_to_staging`）/ `unverified_blocker`（未検証の blocker、または `unobserved` / `unverified_unobserved` / `preexisting_recheck.unobserved` の blocker）/ `contested_blocker`（最初の確定時（`preexisting` は最初に入った時）に blocker だった指摘が再確認で棄却された（`refuted_on_recheck` / `preexisting_recheck.refuted_on_recheck`）か minor に格下げされて反証を通らずに戻った（`remaining` の minor / `preexisting_recheck.minor`）もので、ファイルが `changed_files` に無いか `present_in_original: true` のもの。重さは再報告側ではなく最初の確定時の値で見る。改稿で手が入っていないのに Verify と Reverify の判定が割れただけで、直った証拠ではない）/ `dried`（未解消の同一性キー集合が前巡と同一）/ `stalled`（未解消件数がそれまでの最小値を下回らない巡が `STALL_ROUNDS` 続いた）/ `update_round_limit`（再検証後も未解消項目が残った状態で、固定安全上限 `MAX_UPDATE_ROUNDS` に達した）/ `budget`（Workflow の `budget.total` が設定され、残りが `MIN_ROUND_BUDGET_TOKENS` を下回った。`budget` を持たない Codex runner では発火しない。最初の Update より前に止まると `staging` は `null`、`findings_source` は `before`）/ `seeds_refuted`（`seedFindings` が Verify で全件棄却され、確定も未検証も残らなかった。改稿の根拠が無いので updater を起動しない。`staging` は `null`）/ `update_failed` / `reverify_incomplete` / `review_incomplete`（verdict と同名）。`unverified_blocker` / `contested_blocker` / `dried` / `stalled` / `update_round_limit` / `budget` / `seeds_refuted` はどれも verdict が `needs_human_decision` になるため、区別はこのフィールドだけが持つ。review / audit では `null` |
| `source_snapshot` | review / update / audit の対象入力と post-run 検証義務。caller は receipt を `review-snapshot.mjs verify` に渡し、`status: verified` のときだけ他の結果を信頼する。失敗時は workflow の verdict に関係なく結果を無効にする |
| `source_snapshot.evidence_pack_sha256` | snapshot 作成時に `review-snapshot.mjs prepare` が書いた evidence pack（`evidence-pack.txt`）の sha256（receipt の `evidencePackSha256`）。`verify` が pack の実体と manifest・receipt の値を照合するので、Find / 反証役が読んだ pack が作成後に差し替わっていないことを caller が確かめる根拠になる |
| `findings.reported_minor` | severity が `REVISE_SEVERITIES` の外のため**設計上反証していない**指摘。改稿を動かさないので反証の票を使わないが、黙って落とすと「見ていないもの」が消えるので未検証のまま返す。updater には渡さない。review では 1 件でもあれば `clean` にならない |
| `findings_before` | update のとき、改稿前（Verify）の `{ confirmed, rejected, unverified, reported_minor }`。`findings` は再検証後のものに置き換わり、Reverify は報告範囲を絞るため、改稿前の棄却・未検証・minor は再登場しないことがある。持ち越さないと改稿前に見えていた指摘が黙って消える。review / audit では `null`（`findings` がそれ自体） |
| `still_unverified` | 最初の確定指摘、または前巡の未解消の `new` / `reclassified` が再検証で再報告され、反証で確定にも棄却にもならなかったもの。`staging.unverified` にも載る（その内数）。直ったと確かめられていないので `resolved` に数えず、未解消として改稿ループへ戻す |
| `refuted_on_recheck` | 最初の確定指摘が再検証で再報告され、過半数の反証で棄却されたもの。`resolved`（再検証で報告されなかった）とは別枠で、未解消にも数えない（止まる条件は `stop_reason` の行）。改稿前に未検証だった指摘が再確認で棄却・格下げされた場合はここに入れず、`findings.rejected` / `findings.reported_minor` と `findings_before.unverified` に残る（一度も確定していないので、判定が割れたことにはならない） |
| `unverified_absent` | 改稿前（Verify）に未検証だった指摘のうち、再検証で同じ観点の担当がそのファイルを報告範囲内で読み、再報告しなかったもの。確定したことが無いので消えても不自然ではなく、`resolved` とは呼ばずに提示だけする（未解消にも blocker 判定にも入れない） |
| `unverified_unobserved` | 改稿前に未検証だった指摘のうち、再検証でそのファイルが同じ観点の担当に読まれなかった（または報告範囲外の）もの（止まる条件は `stop_reason` の行） |
| `findings_source` | `findings` が最後に完了した検査パスのどちらか（`before` = 改稿前 / `after` = 再検証後）。review / audit では検査が 1 回なので常に `before` |
| `unchecked_failures` | 委譲項目（`[UNCHECKED_ITEMS]`）の未達と未判定。反証を通していないので `findings.confirmed` には混ぜない（混ぜると「反証を生き残った指摘」という意味が薄まる）。1 件でもあれば `clean` にならない。各要素は委譲項目の id（`item_id`）と `requires_measurement` を持ち、`false` のものは update で未解消として改稿ループへ戻る（`dried` の同一性は `item_id` で見る。`file` / `location` は判定ごとに finder が申告し直す updater 向けの情報で、同一性に入れると同じ未達が毎巡動いたことになる）。`true` のものは evals の実測で確かめる項目で、改稿では満たせないため未解消（ループの継続・`dried`・`stalled` の判定）に数えず、ここに残すだけ。audit では委譲項目を判定する観点を走らせないので `null`（`[]` は「全部満たした」と読まれる）。update で委譲項目を判定する観点が一度も走らずに止まった（`seed` か `target.intentScope` で外したうえで最初の Reverify より前に止まった）ときも `null` |
| `verdict`（review / audit） | `clean`（確定・未検証・`reported_minor`・委譲項目の未達・実施できなかった観点のどれも無い）/ `clean_except_unavailable`（指摘は無いが `skipped_unavailable.before` の観点は見ていない）/ `findings` / `review_incomplete`（観点が欠測。prompt-audit は同梱 criteria を実施できなければここに入る） |
| `skipped_unavailable` | `{ before, after }`。必要な skill / criteria / capability が実行環境に無く実施できなかった観点の id。欠測（`by_category` の `null`・`review_incomplete`・`reverify_missing`）とは別枠で、Reverify の再試行も起こさない。`after` は Reverify が走らなければ `null` |
| `declared_only` | `{ before, after }`。prompt-audit が挙げたが `PROMPT_AUDIT_SEVERITY` の外のため指摘にしなかった項目（`{ file, location, claim, audit_confidence, audit_action }`）。反証も改稿もしない。`after` は Reverify が走らなければ `null` |
| `skipped_unavailable` の入力側 | `args.promptAuditExpected`（必須の真偽値）。同梱 criteria を使う通常経路では `true`。`true` のとき prompt-audit の `unavailable` は欠測になり、no-findings と混ざらない |
| `by_category.<pass>.<観点> === "unavailable"` | その観点に必要な skill / criteria / capability が無く実施できなかった（`skipped_unavailable` と同じ事実）。`null`（応答しなかった）とも `0`（見て何も無かった）とも違う |
| `by_category.after === null` | 再検証のパス自体が走らなかった（review / audit、または改稿前に止まった） |
| `by_category.before === null` / `skipped_unavailable.before === null` / `declared_only.before === null` | `seedFindings` を渡したため Find が走らなかった |
| `by_category.before.<観点> === "out_of_intent_scope"` | `target.intentScope.categories` で外したため、その観点は Find で走らせていない（見ていない） |
| `by_category.<pass>.<観点> === null` | そのパスは走ったが、その観点の担当が応答しなかった（欠測） |
| `by_category.after.<観点> === 0` | 報告範囲（`staging.reverify_scope.report_files`）の中で確定指摘が無かった。範囲の外は再走査していないので、スキル全体で問題が無いという意味ではない |
| `reverify_missing` | Reverify の欠測観点。最初の試行で欠測があれば全観点を一度だけ再試行し、その後も欠測が残れば `reverify_incomplete` として保持する |
| `reverify_receipt` | update の Reverify 完了証跡。`completed: false` または欠測がある場合、runner は action package を発行しない。実施できなかった観点は `by_category` から外して `skipped_unavailable` に宣言する。receipt は欠測を完了扱いせず、利用できた観点の件数と未実施の観点を別々に保持する |
| `resolved` / `remaining` / `new` | 常に**最初の**確定指摘との突き合わせ。直前ラウンドとの比較ではない。最初の確定指摘が severity を下げて再報告された（`reported_minor` に入った）ときは `remaining` に数え、`resolved` にしない。prompt-audit の確定指摘が `changed_files` に無いファイルから消えたときも `remaining` に数える（prompt-audit の確信度は揺れうるので、手を入れていないファイルで消えたことは直った証拠にならない） |
| `possibly_rephrased` | 観点とファイルは一致するが主張の文言が変わり、機械的には `new` になったもの。`new` にも残る |
| `unobserved` | 最初の確定指摘、または前巡の未解消の `new` / `reclassified` のうち、再検証で再報告されず、かつそのファイルを同じ観点の担当が読んでいない、または報告範囲（`reverify_scope.report_files`）の外にあるため、`resolved` に数えられないもの |
| `reverify_scope` | 再検証の報告範囲の宣言。`report_files` は観点ごとに指摘を報告させたファイル（`changed_files` ∪ その観点で再確認する指摘のファイル）で、**この外は再走査していない**。`recheck_ids` は再確認させた指摘（最初の確定指摘 ∪ 改稿前に未検証だった指摘 ∪ 前巡の未解消 ∪ それまでの巡の `preexisting`。委譲項目は `[UNCHECKED_ITEMS]` で毎回判定するので含めない）。`excluded_findings` は範囲外のファイルで `present_in_original: true` として返ってきたため反証に回さなかった指摘（未検証・未分類で、blocker 判定にも入れない）。`false` や省略の指摘は `[INTENT]` の未達や `changed_files` の申告漏れを隠さないよう範囲外でも反証に回す。Reverify が完了しなかった出口では `null` |
| `revisions_used` | **再**改稿の回数（起動した updater の数 − 1。1 体も起動しなければ 0）。初回の改稿は含まない。review / audit では `0` |
