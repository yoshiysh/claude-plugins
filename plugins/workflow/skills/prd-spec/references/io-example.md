# 入出力の例

依頼から保存までを 1 パターン、通しで示す。W は案件 `expense` の W（置き場は SKILL.md S0 の 2。絶対パスに置き換える）。

**依頼（S0 で `W/input.md` に逐語で書く）**:

```
社内の経費精算ツールの要件をまとめたい。申請者が領収書の写真を上げて、部長が承認したら
経理に回る。承認は速やかに通知したい。金額の上限はまだ決まってない。
```

**1 回目の呼び出し**:

```
Workflow({ name: "workflow:prd-spec-run",
           args: { workspace: "<W の絶対パス>", skillDir: "[SKILL_DIR]", entry: "new" } })
```

intake が「承認したら経理に回る」を確定に、「金額の上限」「速やかに」を未決に仕分け、flow-framer が流れを
描いて「差し戻しの行き先」を未決に足す。resolver は、差し戻しの行き先を問い（価値の判断）に、通知の文面の
書式を方法論の決定（事後報告）にする。返り値:

```json
{ "status": "needs_answers", "gate": "g0", "questions_path": ".../expense/questions.md", "answers_path": ".../expense/answers/g0.md",
  "question_ids": ["RS-002", "RS-003"], "next_args": { "…": "変えずに渡す（workflow-io §3）" } }
```

resolver は問いを resolutions.json の `question`・`options` に put で書く（例は RS-002 の一部）:

```json
{ "id": "RS-002", "ruling": "question",
  "question": { "header": "差し戻し先", "text": "部長が差し戻したとき、申請はどこへ戻りますか?", "searched": "依頼文には差し戻しの記述がありませんでした" },
  "options": [
    { "label": "申請者に戻る", "description": "申請者が直して出し直す", "flow_effect": "F-006（差し戻し）から F-002（申請の修正）へ進む", "decision_text": "差し戻された申請は申請者が修正して再提出する" },
    { "label": "差し戻さない", "description": "承認か却下の 2 択にする", "flow_effect": "F-006 を消し、承認か却下の 2 値にする", "decision_text": "部長は承認か却下のどちらかを選ぶ" }
  ] }
```

**司令塔が見せるもの**: 先に `doc_check questions --ids RS-002,RS-003` で問いを導出し、`questions.md` をそのまま見せる
（`questions.json` は同じ問いを選択式で出すための形）。

```markdown
## RS-002

部長が差し戻したとき、申請はどこへ戻りますか?

依頼文で探したところ: 依頼文には差し戻しの記述がありませんでした

- **申請者に戻る**: 申請者が直して出し直す（選ばれたら: F-006（差し戻し）から F-002（申請の修正）へ進む）
- **差し戻さない**: 承認か却下の 2 択にする（選ばれたら: F-006 を消し、承認か却下の 2 値にする）

## RS-003
…
```

**依頼者の回答を `answers/g0.md` に逐語で書き、SKILL.md「## 中継」の「呼び直し」のとおりに呼び直す**（同じセッションなら `gates_answered: { g0: ["RS-002", "RS-003"] }` を足して resume する）:

```
RS-002: 申請者に戻る
RS-003: 1 分以内でいい
```

2 回目の run は、G0 より前の agent が保存された結果を返し、問いが RS-002・RS-003 のままで `answers/g0.md` が両方に答えていることを
flow-check の `doc_check answers` で確かめてから、段 3a から live で走る。候補を選んだ回答はそのまま当たり、「1 分以内でいい」は候補の外の自由記述なので
resolver が RS-003 に対応づけ、verifier がその対応づけを検証する。初稿・監査・改稿・範囲を絞った監査を経て
`status: "done"` が返る。

**出力（`W/requirements-notification.md` 抜粋）**:

```markdown
#### PR-NOTIFICATION-001 承認完了の通知
申請が承認されたとき、システムは承認から 1 分以内に申請者へ承認完了を通知しなければならない。

#### PR-EXPENSE-004 金額の上限
金額の上限の裁定が下るまで、金額を伴う自動承認を設けてはならない。
```

本文に根拠句も未確定事項の章も無い（`document-structure.md` §4）。根拠は `W/requirements-notification.meta.json`
の trace にあり、決まらなかった金額の上限は保持規則になって、裁定は Issue の文案として `report.md` に出る。

```json
{ "trace": [ { "item_id": "PR-NOTIFICATION-001", "kind": "answers", "quote": "1 分以内でいい" },
             { "item_id": "PR-NOTIFICATION-001", "kind": "flow", "ref": "F-007" } ] }
```

writer はこの meta を `doc_check put --ledger meta --doc requirements/notification --token <プロンプトのトークン>` の標準入力で書く。put は
`answers` の引用が回答のファイルに逐語であるかを照合してから書く。

**保存**: `tree-digest` を返り値の `tree_digest` と照合し、`doc_check index` の出力を `docs/requirements/INDEX.md`
と `docs/specifications/INDEX.md` へ逐語で写し、文書を保存先へ写す。

**事後報告（`doc_check report` で導出した `report.md` をそのまま見せる。例）**:

`````markdown
# 事後報告

## 方法論として決めたこと

- RS-004: 通知の文面は件名に申請番号を含める（件名だけで申請を特定できる）

## 保持規則と Issue の文案

### RS-005

**保持規則**: 金額の上限の裁定が下るまで、金額を伴う自動承認を設けてはならない

**触れる項目**: PR-EXPENSE-004

**Issue の文案**:

````markdown
経費申請の金額の上限を決める。決まるまで自動承認は設けない（PR-EXPENSE-004）。
````

## 上位文書の改訂の文案

0 件。
`````

開いている TBD（返り値の `open_tbd`）が 0 件なので、「このまま次工程に着手できます」と伝える。Issue は承認を
得てから起票する。
