---
name: pdca
description: >
  起点が問題・動機・主張検証のいずれであっても、Plan→Do→Check→Act を 1 ループとして回し、
  機序付きの選択肢・実行前に固定した成功基準・対制御での測定・機序分析・恒久化までを一貫させるスキル。
  「PDCA を回して」「/pdca」「こういうのをやってみたい、作って測って改善したい」「この記事の手法が
  本当か自分の環境で再現して比べて」「レビューの往復が多いので減らしたい、施策を測れる形で立てて」
  「なぜダメだったのか機序まで出して次の一手を決めて」といった依頼で積極的に使うこと。
  作る/やる工程と測る工程の両方があるなら、実験でなくても（施策・文書・運用改善でも）使う。
  対象外：調査・原因究明だけで改善ループを伴わない依頼（research:search）、反復のない 1 回限りの
  実行依頼、実装方針そのものの審議（magi）。
---

# Running PDCA Loops

## 目的・概要

PDCA の**契約は固定**し、契約を満たすための**手段（思考オペレータ）は Plan で選ぶ**。
AI は思考しないが、思考は既存手順の組み合わせで模倣できる。オペレータカタログ
（[references/operators.md](references/operators.md)）がその部品で、Plan はそこから
「今回どの手順で契約を満たすか」を選ぶ工程にあたる。

固定するのは 4 つだけ：

- Plan：事実と目標を分けて書き、機序付きの選択肢を 2 案以上出し、**成功基準と測定方法を実行前に固定**する
- Do：Plan どおりに作る/やる。作る側と測る側を別 agent にする
- Check：基準との差だけでなく、**差が出た機序**と**基準自体の妥当性**を出す
- Act：standardize / revise / stop の三択。revise は機序に対応する差分のみ、1 周 3 点以内

基準を実行後に決めると、出た結果に合う基準を後付けできてしまう。機序を伴わない案は、
外れたときに「何が違ったのか」が残らない。この 2 点がループを学習に変える条件なので、
順序を崩さない。

## ファイル構成

- [references/operators.md](references/operators.md) — 思考オペレータカタログ（Plan が選ぶ）
- [assets/plan-template.md](assets/plan-template.md) / [assets/run-table.md](assets/run-table.md) — Plan 雛形・run 表
- [schemas/agent-contracts.md](schemas/agent-contracts.md) — agent 間契約と script の args / 返り値
- agents: [intake](agents/intake.md) / [evidence-collector](agents/evidence-collector.md) / [planner](agents/planner.md) / [builder](agents/builder.md) / [runner](agents/runner.md) / [verifier](agents/verifier.md) / [mechanism-analyst](agents/mechanism-analyst.md) / [plan-verifier](agents/plan-verifier.md) / [act-judge](agents/act-judge.md) / [revision-planner](agents/revision-planner.md)（builder/runner/verifier/mechanism-analyst は `scripts/pdca.js` が、intake/evidence-collector/planner/plan-verifier は `scripts/pdca-plan.js` が Read させる。act-judge / revision-planner は司令塔が Act で呼ぶ）
- [evals/evals.json](evals/evals.json) — テストケース 4 件（起点 3 モード + 誤発動）

## 起点の判定（3 モード）

最初にどの起点かを決める。**入口が変わるのは Plan だけ**で、Do 以降の契約は共通。

| 起点 | 典型的な言い方 | Plan の入口 | 現状把握 |
|---|---|---|---|
| 問題起点 | 「L2 で沈む」「レビュー往復が多い」 | 現状の事実化 → 目標との差 → 機序分析 | 必須 |
| 動機起点 | 「こういうのをやってみたい」 | 動機 → 「できたと分かる状態」の定義 → 最小試作で現状を作る | **強制しない**（無いものを捏造しない） |
| 主張検証起点 | 「この記事の手法は本当か」 | 主張の一次情報化 → 公開された制約からの逆算 → 対制御の測定計画 | 主張側の事実で代替 |

動機起点で現状把握を強制すると、存在しない事実を埋めることになる。代わりに 1 周目の Do を
「現状を作るため」に使い、成功基準は `provisional` として置き、Check で確定する。

## Plan フェーズ（Workflow 呼び出し）

Plan 区間は `scripts/pdca-plan.js` に閉じている。intake → evidence-collector → planner →
**plan-verifier（敵対的検証）** → 改稿、の until-pass ループを script が持つ（改稿上限 2）。
人間承認の代わりに、Plan を書いていない fresh context の verifier が「この Plan が使えない測定を
生む理由」を 8 レンズ（正本は [agents/plan-verifier.md](agents/plan-verifier.md)。指標の崩壊・検証契約の実行可能性・交絡・停止条件の操作化・標本選択バイアス・独立性の証拠経路・水準整合・天井飽和）で反証し、blocker/major が 0 になるまで Do に進む分岐が無い。

```js
Workflow({
  scriptPath: '<このスキルの絶対パス>/scripts/pdca-plan.js',
  args: {
    skillDir: '<このスキルの絶対パス>',
    input: '<起点の文（問題 / 動機 / 主張）>',
    materials: '<資料 URL・パス（任意）>',
    budget: { maxRuns: 8, cycles: 3 },
  },
})
```

役割定義: [agents/intake.md](agents/intake.md)（起点判定・不足入力の問い返し）、
[agents/evidence-collector.md](agents/evidence-collector.md)（`research:search` 委譲、出典付き事実のみ。
動機起点では事実欄は空のまま）、[agents/planner.md](agents/planner.md)（オペレータ選択・機序付き選択肢・
基準の事前固定。Do/Check の中間結果は渡さない — 見えていると出た結果に通る基準を書けてしまう）、
[agents/plan-verifier.md](agents/plan-verifier.md)（反証専任）。

返り値の `status`:

| status | 意味と次の一手 |
|---|---|
| `ok` | `plan` と `plan_review` を持つ。**ユーザー承認を待たずに Do/Check へ進んでよい** |
| `NEEDS_INPUT` | intake の問い返し。`questions[]` をユーザーに聞いて埋め、再実行する |
| `UNVERIFIABLE` | 測れる形にできない。理由と「何が要るか」を返して止める（`research:search` で調査だけ続ける選択肢を添える） |
| `BLOCKED` | 改稿上限まで pass しなかった。findings を添えてユーザーの判断を仰ぐ |

Plan で選択肢が割れて審議が要ると planner が判断したら、`magi` に委譲してから戻る。

## Plan から Do への遷移（人間ゲート無し）

> pdca-plan.js が `status: ok` を返したら、**ユーザー承認を待たずに** Do/Check へ進む。
> 承認の代替は plan-verifier の敵対的検証（blocker/major 0 が構造条件）。人間の関与が要るのは
> `NEEDS_INPUT` / `UNVERIFIABLE` / `BLOCKED` の 3 経路と、Act の standardize だけ。
> Do 起動時、`plan` と `plan_review.findings`（minor 含む）を pdca.js の args にそのまま載せ、
> ユーザーには「Plan が検証を通過したので Do に進む」ことを要約付きで**事後報告**する（黙って進めない）。
> 動機起点の仮基準（provisional）もこの経路で通る — 仮であることは Check の基準確定で回収される。

## Do/Check フェーズ（Workflow 呼び出し）

検証を通過した Plan をそのまま args に載せて workflow を起動する。この区間には人間ゲートが無く、
条件ごとの fan-out・独立検証・集計が連なるので、順序と反復は script が持つ。

```js
Workflow({
  scriptPath: '<このスキルの絶対パス>/scripts/pdca.js',
  args: {
    skillDir: '<このスキルの絶対パス>',
    plan: '<pdca-plan.js が返した plan の全文>',
    successCriteria: {
      text: '<成功基準と測定方法。verifier はこれだけを見て採点する>',
      metric: '<verifier が score に入れる指標名（例: 到達レベル数、action 数）>',
      higher_is_better: true,   // 指標の向き。false なら小さいほど良い（action 数・所要時間・エラー件数）
    },
    conditions: [
      { id: 'A', label: 'fresh session 型', spec: '条件 A の差分だけを記述' },
      { id: 'B', label: '継続型',           spec: '条件 B の差分だけを記述' },
    ],
    fixed: '全条件で固定するもの（モデル・入力・環境・評価者）',
    runsPerCondition: 3,
    budget: { maxRuns: 12, note: 'トークン・時間の上限は文章で' },  // maxRuns を超える発行は script が止める
    cycle: 1,                // 何周目か。revise のたびに +1。上限は script が持つ（3）
    previous: null,          // revise のときだけ前周の返り値（artifacts / runs / check.mechanisms）をそのまま渡す
    revisionDiffs: [],       // revise の差分（3 点以内。超えると script が止める）
  },
})
```

条件が 1 本のときは対制御を組まず単一条件として回る（動機起点や非実験の問題起点はこれ）。
反復上限・欠測の扱い・confidence の決め方は script が持つので、ここでは指定しない。

script が構造で保証するもの：対制御の対発行（1 本の pipeline）／run ごとの worktree 分離／
集計は算術のみ／欠測（`unmeasured`）と score 欠落（`unscored`）を別枠で数え成績に混ぜない／
`delta` の符号は `higher_is_better` から機械的に `favored` へ変換／反復・条件・周回の上限と
切り詰めは `truncations` と log に出る／`budget.maxRuns` 超過は実行前に BLOCKED／
revise は `previous` が無ければ BLOCKED（前周を土台にしない再実行を revise と呼ばない）。

返り値：

| フィールド | 中身 |
|---|---|
| `status` | `ok` / `BLOCKED`（理由と証拠つき） |
| `do.artifacts[]` / `do.runs[]` | 作った物と、条件×反復ごとの実行記録 |
| `check.results` / `check.gap` | 検証済みの測定値と、基準との差。`favored` が優劣（`higher_is_better` 反映済み）、`unmeasured` / `unscored` は成績外 |
| `check.mechanisms[]` | 差が出た機序（点数とは分離。builder と別 agent が出す） |
| `check.criteria_validity` | 基準自体が主張を捉えていたかの判定 |
| `confidence` | `mechanism_identified` / `suggestive` / `inconclusive` |
| `runTable[]` | 人間向け run 表の行 |
| `cycle` / `truncations` / `calibration_notes` | 周回数、上限で切り詰めた事実、確信度を下げた理由 |

`status: "BLOCKED"` は「script が判断できない地点」を意味する。理由と証拠をそのまま
ユーザーに出し、判断を得てから再実行する。

## 返り値の解釈と人間への提示

[assets/run-table.md](assets/run-table.md) の形で run 表（条件 / 結果 / action・コスト / 失敗機序）を出し、
そのあとに次の 3 点を必ず添える。数字だけを出すと、強さの較正が読み手側に丸投げされる。

- **`check.criteria_validity`**：測った指標が本当に主張を捉えていたか。捉えていなければ
  数字の大小より先にこれを言う
- **`confidence` の意味**：`mechanism_identified` = 機序まで特定、`suggestive` = 差はあるが
  機序未確定、`inconclusive` = n・欠測・非決定性から差を主張できない
- **測れていないもの**：n、非決定性、欠測（`delta` が `null` の場合は「引き分け」ではなく
  「測れていない」）

提示例：

```
## run 表
| 条件 | 結果 | action・コスト | 失敗機序 |
|---|---|---|---|
| A: fresh session 型 (n=3) | 到達 L2 平均 2.0 / 36 action | 108 action | 文脈を跨げず同じ扉を再探索 |
| B: 継続型 (n=3)           | 到達 L2 平均 3.3 / 36 action | 108 action | 後半で古い地図を信じて誤進入 |

delta = +1.3（B 優位）／ 基準は事前登録（Plan 承認時に固定）
criteria_validity: 「到達レベル」は主張（36 action/レベル）を直接は捉えていない。
  action 効率で見ると差は縮む。
confidence: suggestive（n=3、実行の非決定性が残り、機序は 2 案が併存）
測れていないもの: 探索順序のランダム性、モデル側のキャッシュ影響
```

## Act ゲート：判定は act-judge、停止は証拠、人間は入力と不変条件のみ

> decision の判定は [agents/act-judge.md](agents/act-judge.md) に委譲する。act-judge は
> Act 判定表を機械的に適用し、`decision` / `matched_rule` / `auto_executable` を返す。
>
> **自動実行の線引きは操作の種類ではなく対象で引く**:
> - `revise_criteria` / `revise_plan` / `stop` / `standardize` → 自動実行してよい。実行後に
>   matched_rule と根拠を**事後報告**する（黙って進めない）。standardize の書き込みは
>   git で可逆な範囲（当該スキルのファイル・references・memory）に限る
> - **不変条件に触れる standardize だけ人間ゲート**: `.claude/rules/` と `CLAUDE.md` の変更、
>   PR のマージ、外部公開。これらは対象が承認制と定められている
> - `escalate_intake`（問いの前提・価値が崩れた）→ NEEDS_INPUT としてユーザーに返す
> - `human_required`（表に無い状況・行の衝突）→ 人間ゲート。act-judge が規則を発明しない
>
> ユーザーが「毎回確認したい」と言った場合は auto_executable を無視して全件ゲートに戻す。
> 介入は **redirect のみ**（停滞の指摘・未探索領域の提示）に留め、仮説や答えを供給しない。
> 供給すると、次の周で検証しているのは自分の仮説になり、ループが自己確認に変わる。

## Act フェーズ

decision は次の規則で決まる（適用は act-judge が行う）。規則が無いと「もう少し頑張る」が revise に化ける。
**行の優先順位は上から**で、複数行に該当し順序で解決できない場合は human_required。

失敗の種別が戻る深さを決める（スコープの梯子）。測定の欠陥は基準へ、前提の欠陥は Plan へ、
問いの欠陥はユーザーへ戻る。梯子が無いと、前提が崩れているのに測定修正だけを重ねて周回を使い切る
（実測: コーパスが 3 年しか無く「時期偏り」という前提自体が弱いと 1 周目で見えていたのに、
3 周とも測定修正に費やした）。

| 条件 | decision |
|---|---|
| 成功基準を満たし、`confidence` が `mechanism_identified` | **standardize** |
| `check.mechanisms[]` が Plan の前提（環境・コーパス・タスク構造）の不成立を示す | **revise_plan**（pdca-plan.js へ戻る。findings を materials に渡して再立案） |
| 問いそのものの価値・入力が崩れた（測っても使い道が無い、環境が用意できない） | **escalate_intake**（NEEDS_INPUT としてユーザーへ） |
| 成功基準未達だが新しい `identified: true` の機序があり、予算内 | **revise_criteria**（測定・基準の差分 3 点以内で Do/Check 再実行） |
| **この周で新しい identified 機序が 1 つも出なかった（乾いた）** | **stop**（証拠が乾いた。回数ではなくこれが本来の停止条件） |
| `confidence` が `inconclusive` かつ測定設計の欠陥も特定できない | **stop**（判定不能。設計に戻る材料も無い） |
| 予算（budget.maxRuns / トークン / 時間）到達、または script が BLOCKED | **stop**（どの停止条件に当たったか明記） |
| 成功基準は満たしたが `criteria_validity` が「主張を捉えていない」 | **revise_criteria**（差分は基準の見直し。成果物は変えない） |

周回の上限（`maxCycles`、既定 5）は**較正された停止条件ではなく暴走の backstop** — 正常なループは
乾き・前提崩れ・予算のどれかで先に止まる。backstop に当たって止まった場合はその旨を明記する
（「3 周で決まる」といった回数の根拠は存在しない。回数を停止条件に使った過去の設計は、
前提の弱さが見えていても周回を消化する挙動を生んだ）。

動機起点の 1 周目は成功基準が `provisional` なので、standardize の前に Check で基準を確定させる。

act-judge の decision に従う（auto_executable なら事後報告、そうでなければゲート）。

- **standardize**：学びの恒久化先を指定する。共通のコード規約・設計原則なら `.claude/rules/`
  （**ここだけ人間ゲート**）、その作業/スキル固有なら当該スキルのファイル、session 文脈の想起なら
  `memory/`。置き場所を決めずに残すと腐る
- **revise_criteria**：`agents/revision-planner.md` に `check.mechanisms[]` と Plan を渡し、
  **機序に対応する差分だけ**を 3 点以内で作らせる。差分を `revisionDiffs` に、前周の返り値を
  `previous` に、`cycle` を +1 して Do/Check を再実行する
- **revise_plan**：pdca-plan.js を再実行する。`materials` に前周の check（機序・criteria_validity・
  unmeasured）を渡し、planner が前提から立て直す。plan-verifier の検証も再度通る
- **stop**：停止条件（乾き・判定不能・予算・backstop）のどれに当たったかを明記して終える

## 出力契約

ループ 1 周の最終出力は次の形にまとめる。フィールド名は
[schemas/agent-contracts.md](schemas/agent-contracts.md) の各 agent 契約と一致させる。

```json
{
  "origin_mode": "problem | motivation | claim_check",
  "plan": {
    "facts": ["出典付きの事実（動機起点では空配列）"],
    "goal": "何がどうなれば成功か",
    "analysis": "なぜ今そうなっているか（機序・制約・前提）",
    "options": [{ "option": "案", "mechanism": "なぜ効くか" }],
    "chosen": "採用案",
    "rejected": [{ "option": "案", "reason": "棄却理由" }],
    "success_criteria": { "text": "基準", "provisional": false },
    "measurement": "測定方法（何を固定し何を変えるか）",
    "stop_conditions": "予算・反復上限・達成条件",
    "operators_used": ["逆算", "対制御比較"]
  },
  "do":   { "artifacts": [], "runs": [] },
  "check":{ "results": {}, "gap": "", "mechanisms": [], "criteria_validity": "" },
  "act":  { "decision": "standardize | revise | stop", "diffs": [], "next": "", "persist_to": "" },
  "confidence": "mechanism_identified | suggestive | inconclusive"
}
```

## 既存スキルとの関係

| 依頼 | 行き先 |
|---|---|
| 「この CI が落ちる理由を調べて」 | `research:search`（改善ループを伴わないのでこのスキルは発動しない） |
| 「多角的に深掘り調査して」（作って測る工程が無い） | `research:dispatch` |
| 「どの方式を採るべきか審議して」 | `magi`。Plan で選択肢が割れたときはこのスキルから委譲する |
| Plan の事実確認 | `research:search`（`evidence-collector` 経由で呼ぶ） |

`.claude/rules/loop-engineering.md` の closed-loop 要件（ゴール・ステップ・各ステップの eval・
終了条件）は、Plan の成功基準／Do の測定点／Check の検証／stop_conditions が対応する。

## 注意事項

- Do/Check は Claude Code の Workflow ランタイムを使う。使えない環境ではこのスキルは
  Plan とゲートまでしか進められないので、その旨を伝えて止める
- 予算（run 数・トークン・時間）は Plan の停止条件に必ず入れる。入っていないと 1 周が
  いくらでも伸びる
- 人間ゲートは NEEDS_INPUT / BLOCKED / human_required と、不変条件（`.claude/rules/`・`CLAUDE.md`・
  PR マージ・外部公開）に触れる standardize のみ。ゲートに当たったら承認そのものを得る
  （承認の記録を承認の代わりに使わない）
- successCriteria に検証手順を書いたら、それは verifier への契約になる。verifier が実施できなかった
  検証は met=false（未実施）として返り、mechanism-analyst の unmeasured に載る。「書いたのに
  実施されず pass」は起きない設計にする