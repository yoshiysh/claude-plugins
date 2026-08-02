# Agent 入出力契約（search スキル）

3 エージェントの入出力と最終レポートの契約を定義する単一の権威ファイル。SKILL.md と各 agent は
本ファイルのフィールド名・型を正とする。フィールド名がずれると後段の並列 spawn / 合成が
噛み合わないため、生成時は必ず本スキーマを参照する。

## Table of Contents

- [エビデンス強度ラベル（語彙定義）](#エビデンス強度ラベル語彙定義)
- [claim-extractor](#claim-extractor)
- [source-verifier](#source-verifier)
- [root-cause-synthesizer](#root-cause-synthesizer)
- [final-report（最終レポート契約）](#final-report最終レポート契約)
- [delegation-verify-claim（委譲呼び出し契約）](#delegation-verify-claim委譲呼び出し契約)

---

## エビデンス強度ラベル（語彙定義）

全 agent・最終レポートで一貫して使うラベル。混用しない。

| ラベル | 意味 | 置き場所 |
| --- | --- | --- |
| `verified` | 一次情報が主張を字義通り裏付け、その情報源が完全 | `verified_facts[].confidence` / verdict |
| `refuted` | 一次情報が主張と矛盾する（確認して偽） | verdict / `unverified_or_inconclusive[].reason` |
| `cannot-verify` | 一次情報に到達不能 / 情報源が不完全 / 原理的に検証不能 | verdict / `unverified_or_inconclusive[].reason` |
| `inference` | 複数の検証済み事実から導いた合成主張（単独の一次情報には基づかない） | `inferences[]` / `claims[].kind` |
| `unverified` | 抽出されたが検証が完了しなかった（打ち切り時の残余） | `unverified_or_inconclusive[].reason` |

---

## claim-extractor

### 入力

```json
{
  "question": "元の調査依頼（string）",
  "draft": "現時点のドラフト回答（string, 無ければ空文字）",
  "next_question": "前ラウンドで synthesizer が出した追加検証の問い（string | null）",
  "verified_claims": ["既に検証済みの主張文（string[]、初回は空）"]
}
```

`verified_claims` に載っている主張は既に verdict が付いており、再抽出しても
`investigate.js` が重複として除外する（同じ主張を毎ラウンド検証し直さないため）。
抽出時は新規の主張に注力する。

### 出力

```json
{
  "claims": [
    {
      "id": "c1",
      "text": "検証すべき事実主張（string）",
      "kind": "fact | inference",
      "verify_method": "live-api | file-read | web-search | web-fetch | not-verifiable-by-nature",
      "priority": "high | medium | low",
      "hedge": false,
      "based_on": ["inference の場合、根拠になる claim の id 配列。fact の場合は省略"]
    }
  ],
  "note": "claims が空の場合の理由や、抽出上の留意点（string, 任意）"
}
```

**フィールド規約**：

- `kind: "fact"` は単独の一次情報で真偽が付く主張。`kind: "inference"` は複数事実の合成で、
  `based_on` に根拠 claim の id を必ず入れる。
- `hedge: true` は元の問い/ドラフト/情報源が留保している主張（断定形に硬化させない）。
- `verify_method: "not-verifiable-by-nature"` は未来予測・主観的価値判断など原理的に検証
  不能な主張。source-verifier はこれを `cannot-verify`（理由=原理的に検証不能）で返す。
- `priority` は本筋の結論を支える load-bearing な主張ほど `high`。検証順の配分に使う。
- 事実主張が無い純粋な定義・意見の問いは `claims: []` + `note` を返す。

---

## source-verifier

claim ごとに 1 回呼ばれ、1 主張分の verdict を返す。

### 入力

```json
{
  "id": "c1",
  "text": "検証対象の 1 主張（string）",
  "verify_method": "live-api | file-read | web-search | web-fetch | not-verifiable-by-nature"
}
```

### 出力

```json
{
  "id": "c1",
  "verdict": "verified | refuted | cannot-verify",
  "evidence_ref": "URL / ファイルパス+行 / 実行した API とレスポンス要点（string）",
  "source_completeness": "complete | partial | unavailable",
  "as_of": "情報源の as-of 時点（ISO 日付/日時 or 記述, 任意）",
  "independence": "original | reposted | unknown（出典が独立原典か転載か, 任意）",
  "note": "判定理由。字義通り裏付けた該当箇所の引用、否定/例外/留保の確認結果、矛盾源の優先順位、鮮度の注記、失敗理由等（string）"
}
```

**フィールド規約**：

- `verdict: verified` は `source_completeness: complete` かつ引用-主張が字義通り整合する
  ときのみ。トピック一致だけ・部分情報だけでは `verified` にしない。
- `source_completeness: partial`（truncation/pagination で全体未取得）や `unavailable`
  （到達不能）で真偽が付かなければ `verdict: cannot-verify`。
- `evidence_ref` は必須。記憶ベースの主張は不可（実行した取得の参照を入れる）。
- 矛盾する複数一次情報を採否したときは、採用理由と不採用源を `note` に残す。

---

## root-cause-synthesizer

### 入力

```json
{
  "question": "元の調査依頼（string）",
  "verdicts": [
    {
      "id": "c1",
      "text": "主張（string）",
      "kind": "fact | inference",
      "verdict": "verified | refuted | cannot-verify",
      "evidence_ref": "一次情報参照（string）",
      "based_on": ["inference の根拠 id, 任意"],
      "hedge": false,
      "note": "source-verifier の判定理由（string）"
    }
  ]
}
```

### 出力

```json
{
  "root_cause": "反証を経て特定できた根本原因（string） | null",
  "disconfirmation_attempted": true,
  "contradictions": [
    {"between": ["c2", "c5"], "description": "矛盾の内容（string）"}
  ],
  "scope_assumption": "調査範囲が問いから一意に定まらず前提を選んだ場合の宣言（string, 任意）",
  "next_question": "次に検証すべき最も決定的な 1 問（string） | null",
  "same_question_as_previous": false,
  "report": { "final-report を参照" }
}
```

**フィールド規約**：

- `disconfirmation_attempted` は常に `true`（反証を試みたことが root_cause 主張の前提）。
  何を反証として試したかは `report.root_cause` 付近か `note` に残す。
- `next_question != null` の間はループ継続（`scripts/investigate.js` が round 上限と
  進捗ガードで打ち切る）。
- `next_question: null` のとき `report` を確定版として返す。
- `same_question_as_previous` は、返す `next_question` が前ラウンドのものと実質的に同じ問い
  （言い回しが違っても検証対象と論点が同一）なら `true`。前ラウンドが無い場合と
  `next_question: null` の場合は `false`。進捗ガードの条件(b) にスクリプトが使う。
  「実質同一」は言い換えを含む意味判断のため機械的な文字列比較には落とせず、判断を
  synthesizer 側に置いている。

入力の `verdicts[]` は、その時点で抽出された全 claim に検証が走った結果である
（`investigate.js` が claim ごとに verifier を spawn する）。未検証の主張が混入する経路は
構造上存在しない。

---

## final-report（最終レポート契約）

SKILL.md が Step 3 でユーザー / 呼び出し元へ返す最終成果物。root-cause-synthesizer が組み立てる。

```json
{
  "verified_facts": [
    {
      "claim": "検証済みの事実主張（string）",
      "evidence_ref": "一次情報参照 URL/ファイルパス/API レスポンス（string）",
      "confidence": "verified"
    }
  ],
  "unverified_or_inconclusive": [
    {
      "claim": "未確定の主張（string）",
      "reason": "cannot-verify | refuted | unverified",
      "note": "到達できなかった一次情報 / 矛盾内容 / 打ち切り理由（string）"
    }
  ],
  "root_cause": "特定できた場合の記述（string） | null（+ 特定できなかった理由と必要だった一次情報）",
  "inferences": [
    {
      "claim": "複数の検証済み事実から導いた合成主張（string）",
      "based_on": ["verified_facts のインデックス or claim id"],
      "note": "推論であり単独の一次情報には基づかない。相関どまりならその旨も（string）"
    }
  ]
}
```

**契約規約**：

- `verified_facts` には `verdict: verified` の主張のみを載せる。各要素に `evidence_ref` 必須。
- `cannot-verify` と `refuted` を混ぜず、`reason` で区別する。
- `root_cause` は反証を経たもののみ。未特定は `null` + 理由（推測で埋めない）。
- `inferences` は事実に格上げしない。ヘッジ付き根拠のヘッジは保持する。
- 区分間で矛盾がないこと（確定前に synthesizer が自己照合済み）。

---

## delegation-verify-claim（委譲呼び出し契約）

他スキルが `Skill({skill: "search"})` を呼び、先頭に
`[SKILL_DELEGATION caller=<skill> purpose=verify-claim]` を付けた場合の契約。

- claim-extractor と root-cause-synthesizer を経由せず、ヘッダを除いた本文を検証対象主張
  （1 個 or 少数）として source-verifier へ直接渡す（複数なら並列 spawn）。

### 入力（呼び出し元 → source-verifier）

```json
{
  "claim": "検証対象の主張（string）",
  "verify_method": "live-api | file-read | web-search | web-fetch | not-verifiable-by-nature | null"
}
```

`verify_method` は呼び出し元が検証手段を把握していれば明示する（省略可）。**省略時（`null`
または未指定）は source-verifier 自身が主張の文面から推定する**（claim-extractor を経由しない
経路のため、この推定は source-verifier.md の責務として定義する。詳細は同ファイル参照）。

- 返却は各主張の三値 verdict のみ：

```json
{
  "results": [
    {
      "claim": "検証対象の主張（string）",
      "verdict": "verified | refuted | cannot-verify",
      "evidence_ref": "一次情報参照（string）",
      "note": "判定理由 / 到達できなかった理由（string）"
    }
  ]
}
```

呼び出し元が求めているのは主張の裏付け可否であり、root_cause 合成は行わない。
