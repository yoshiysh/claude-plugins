# エージェント間入出力スキーマ定義

skill-creator-best-practices 内の各エージェントが入出力するデータの契約書。
フィールド名のズレでパイプラインが壊れるため、変更時は全エージェントに伝播させること。

## 目次
- [Criteria：基準生成の出力](#criteria基準生成の出力)
- [Structure：構成設計の出力](#structure構成設計の出力)
- [Write：執筆の出力](#write執筆の出力)
- [Test/Grade：テスト・検証の出力](#testgradeテスト検証の出力)
- [eval framework](#eval-framework優先度c)

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
| セクションID | 操作 | タイトル | 使用コンポーネント | 目的・理由 |
|------------|------|--------|-----------------|----------|

### 情報の流れ
（箇条書き）

### 目次・nav への反映
（箇条書き）

### ⚠️ 懸念点
```

### structure-reviewer の出力（STRUCTURE_REVIEW_SCHEMA）

```json
{
  "checks": [
    { "name": "A. 要件との整合性", "result": "ok | warn | fail", "rationale": "根拠（構成案からの引用）" },
    { "name": "B. 実現可能性", "result": "ok | warn | fail", "rationale": "..." },
    { "name": "C. 情報の流れ", "result": "ok | warn | fail", "rationale": "..." },
    { "name": "D. 目次・nav の同期", "result": "ok | warn | fail", "rationale": "..." }
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

制約は `references/skill-writing-guide.md`「Workflow 型スキルの執筆」を正とする
（`meta` は純粋リテラル・`import()` 禁止・`Date.now()` / `Math.random()` 禁止・
`phase()` のタイトルは `meta.phases[].title` と一致・`agent()` の結果は `.filter(Boolean)`）。

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
`pass_rate` / `delta` は `scripts/build_skill.js` が算出して各 grading 行へ付け足す
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

## review/update の入出力

`scripts/review_skill.js` が finder / refuter / updater と交換する契約。
**観点の一覧・反証者の観点・閾値・改稿ループの停止条件は script の `FINDERS` / `PERSPECTIVES` /
`MIN_VALID_VOTES` / `REVISE_SEVERITIES` が唯一の正**なので、ここには写さない。
ここが定義するのはフィールドの形と、その形が保証していることだけ。

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
| `findings[].present_in_original` | 任意（Reverify のみ） | evidence の引用が改稿前の原本の同じファイルにもそのまま存在し、かつ指摘が成立する条件（参照先・前提）が改稿で変わっていなければ `true`、それ以外は `false`。`[INTENT]` との不一致を指摘するものは、前提である意図が改稿で与えられたので常に `false`。原本が読めなければ省略する（分からないものを `false` にしない）。script はこれで `new` と `preexisting` を分け、diff scope では `out_of_scope` に入れるかも決める（「review_skill.js の戻り値」の `out_of_scope` を参照） |
| `unchecked_judgments` | ○（担当観点のみ） | `[UNCHECKED_ITEMS]` の各 id に対する `pass` / `partial` / `fail` / `unknown` と根拠。どの観点が担当するかは script の `FINDERS` の `owns_unchecked` が正本 |

#### 委譲項目（[UNCHECKED_ITEMS]）の受け渡し

```json
{ "unchecked_judgments": [ { "id": "verifier-path", "verdict": "fail", "evidence": "..." } ] }
```

- **id 一覧の正本は `scripts/quick_validate.py` の `UNCHECKED_ITEMS`**。workflow script は
  ファイルを開けないので、司令塔が `--emit-unchecked` の出力を `args.uncheckedItems` へ
  そのまま渡し、script が prompt へ verbatim 注入する。js 側に id を書き写さない。
- 合格にならない verdict の集合は script の `UNCHECKED_BLOCKING` が正本
  （`fail` と `partial` と `unknown` は同格。どれも「満たしている」と言えていない）。
- 返ってこなかった id は script が集合の差で拾い、未判定として失格／未解消に変換する。
  委譲を散文で宣言するだけだと、受け取った側が落としても出力に現れず誰にも分からない。

### refuter の出力（REFUTE_SCHEMA）

```json
{ "verdict": "refuted", "reason": "SKILL.md L52 に該当の記述があり、指摘の引用と一致しない" }
```

`verdict` は `refuted` / `not_refuted` / `unreadable` の三値。boolean にすると
「読めなかった」を `false`（反証できなかった）に押し込むことになり、検証していない票が
確定側の有効票として数えられる。`unreadable` は集計の分母から外れ、有効票が
`MIN_VALID_VOTES` に届かなければその指摘は `unverified` になる。

### updater の出力（UPDATE_SCHEMA）

```json
{
  "changed_files": [
    { "path": "SKILL.md", "reason": "モード判定に優先順位規則を追加", "findings_addressed": ["p1-loopholes-1"] },
    { "path": "agents/finder.md", "reason": "unreadable の返し方を追記", "findings_addressed": ["intent"] }
  ],
  "summary": "指摘2件を解消し、意図どおり observability を追加した。未検証の指摘1件は判断できず据え置いた。"
}
```

`changed_files` は**実際に内容を変えたファイルだけ**。staging には対象スキルの全ファイルが
複製されるが、この一覧は承認後に本体へコピーする対象そのものなので、無変更のファイルを
載せると承認されていない上書きが起きる。`findings_addressed` を必須にしているのは、
指摘にも意図にも紐づかない改稿を後段の突き合わせで説明できないため（意図由来なら
`"intent"` と書く）。

### review_skill.js の戻り値

```json
{
  "mode": "update",
  "target": { "skillPath": "/abs/path", "scope": "full", "diffRef": null, "focus": null },
  "verdict": "applied_to_staging",
  "findings": { "confirmed": [], "rejected": [], "unverified": [] },
  "unchecked_failures": [],
  "findings_source": "after",
  "by_category": { "before": { "why-driven": 1 }, "after": { "why-driven": 0 } },
  "reverify_missing": [],
  "reverify_receipt": {
    "phase": "Reverify", "staging_dir": "/abs/path-workspace/staging",
    "fresh_thread": true, "completed": true,
    "by_category": { "why-driven": 0 },
    "updater_thread_id": "update-sonnet-p1",
    "fresh_thread_id": "find-why-driven-p2r1"
  },
  "staging": {
    "dir": "/abs/path-workspace/staging",
    "changed_files": [],
    "resolved": [], "remaining": [], "new": [],
    "unverified": [], "possibly_rephrased": [], "unobserved": [],
    "reclassified": [], "out_of_scope": [], "preexisting": [], "reverify_missing": []
  },
  "revisions_used": 0
}
```

| フィールド | 意味 |
|---|---|
| `findings_source` | `findings` が最後に完了した検査パスのどちらか（`before` = 改稿前 / `after` = 再検証後） |
| `unchecked_failures` | 委譲項目（`[UNCHECKED_ITEMS]`）の未達と未判定。反証を通していないので `findings.confirmed` には混ぜない（混ぜると「3 体の反証を生き残った指摘」という意味が薄まる）。1 件でもあれば `clean` にならず、update では未解消として改稿ループへ戻る |
| `by_category.after === null` | 再検証のパス自体が走らなかった（review、または改稿前に止まった） |
| `by_category.<pass>.<観点> === null` | そのパスは走ったが、その観点の担当が応答しなかった（欠測） |
| `reverify_missing` | Reverify の欠測観点。最初の試行で欠測があれば全観点を一度だけ再試行し、その後も欠測が残れば `reverify_incomplete` として保持する |
| `reverify_receipt` | update の Reverify 完了証跡。`completed: false` または欠測がある場合、runner は action package を発行しない |
| `resolved` / `remaining` / `new` | 常に**最初の**確定指摘との突き合わせ。直前ラウンドとの比較ではない |
| `possibly_rephrased` | 観点とファイルは一致するが主張の文言が変わり、機械的には `new` になったもの。`new` にも残る |
| `unobserved` | 再検証でそのファイルを同じ観点の担当が読んでいないため、`resolved` に数えられないもの |
| `out_of_scope` | `scope: "diff"` のときだけ。改稿前に読まれたファイルにも今回変更したファイルにも無い場所で再検証が見つけた確定指摘。`present_in_original: true` の指摘だけが入り、提示だけして blocker 判定には入れない（`full` では常に空）。`false` や省略の指摘は、updater が変更を `changed_files` に申告し漏らした場合や意図の未達を隠さないよう、ここには入れず `new` として未解消に数える |
| `revisions_used` | **再**改稿の回数。初回の改稿は含まない |
