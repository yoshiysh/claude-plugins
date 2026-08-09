# エージェント間入出力スキーマ定義

skill-creator-best-practices 内の各エージェントが入出力するデータの契約書。
フィールド名のズレでパイプラインが壊れるため、変更時は全エージェントに伝播させること。

## 目次
- [Phase 2：基準生成の出力](#phase-2基準生成の出力)
- [Phase 2.5：構成設計の出力](#phase-25構成設計の出力)
- [Phase 3：執筆の出力](#phase-3執筆の出力)
- [Phase 4：テスト・検証の出力](#phase-4テスト検証の出力)
- [eval framework](#eval-framework優先度c)

---

## Phase 2：基準生成の出力

### criteria-gen / criteria-comp の出力（検証基準リスト）

自由形式のテキストだが、以下の構造を維持すること。

```
## [カテゴリ名]

N. **[基準名]**：[判定方法（「〜が含まれているか」「〜が明記されているか」など判定可能な形式）]
N. ...

判定可能かどうか不安なものには ⚠️ を付ける。
```

---

## Phase 2.5：構成設計の出力

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

### structure-reviewer の出力（構成レビューレポート）

```
## 構成レビューレポート

### A. 要件との整合性
結果: ✅ / ⚠️ / ❌
根拠: ...

### B. 実現可能性
結果: ✅ / ⚠️ / ❌
根拠: ...

### C. 情報の流れ
結果: ✅ / ⚠️ / ❌
根拠: ...

### D. 目次・nav の同期
結果: ✅ / ⚠️ / ❌
根拠: ...

### 総合判定
通過: X/4 項目
❌ の項目: [リスト]
⚠️ の項目: [リスト]
構成の修正が必要か: はい / いいえ
優先度高い修正点: ...
```

---

## Phase 3：執筆の出力

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

## Phase 4：並列評価・採点の出力

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
  ],
  "summary": {
    "with_skill": { "pass": 2, "partial": 1, "fail": 0, "pass_rate": 0.83 },
    "baseline":   { "pass": 1, "partial": 0, "fail": 2, "pass_rate": 0.33 },
    "delta": 0.50
  }
}
```

partial は pass の 0.5 点として pass_rate を計算する。
3件の grading 結果を平均して最終 delta を算出する。

### reviewer の出力（定性チェックレポート）

```
## 検証レポート

### 基準チェック
#### [基準名]
結果: ✅ / ⚠️ / ❌
根拠: （テキストの該当箇所を引用、またはなぜ不足しているか）

### ワークフロー設計チェック（Sub-agent を使う設計の場合のみ）
[各項目を ✅ / ⚠️ / ❌ で判定]

### トリガー判定
テスト1: 発動する / しない / 不明　理由: ...
テスト2: 発動する / しない / 不明　理由: ...
テスト3: 誤発動リスク あり / なし　理由: ...

### 総合判定
通過: X/Y 項目
❌ の項目: [リスト]
⚠️ の項目: [リスト]
優先度高い改善点: ...
```

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

## Phase 4 Step 4-5：comparator の出力

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

## Phase 4 Step 4-5：analyzer の出力

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
