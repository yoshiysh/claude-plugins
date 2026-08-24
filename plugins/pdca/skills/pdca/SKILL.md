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
- agents: [intake](agents/intake.md) / [evidence-collector](agents/evidence-collector.md) / [planner](agents/planner.md) / [builder](agents/builder.md) / [runner](agents/runner.md) / [verifier](agents/verifier.md) / [mechanism-analyst](agents/mechanism-analyst.md) / [act-judge](agents/act-judge.md) / [revision-planner](agents/revision-planner.md)（後半 4 つは `scripts/pdca.js` が Read させる）
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

## Plan フェーズ

`intake` → `evidence-collector` → `planner` の順に呼ぶ。逐次なのは、後段が前段の出力だけを
入力に取るため。

1. **`agents/intake.md`** に起点の文（と資料 URL・測れる環境・予算があればそれ）を渡す。
   起点モードを判定し、不足入力（測れる環境が無い／成功の定義が無い等）があればここで問い返す。
   問い返しが返ってきたらユーザーに聞き、埋めてから次へ進む。
2. **`agents/evidence-collector.md`** に intake の出力を渡す。事実確認オペレータの実行担当で、
   `research:search` へパイプライン委譲して一次情報を集め、**出典付きの事実だけ**を返す。
   動機起点では事実欄を「無し」で返す。裏が取れなかったものは事実に混ぜず未確認として残す。
3. **`agents/planner.md`** に intake と evidence-collector の出力を渡す。オペレータ選択・
   選択肢（各案に機序）・選定基準・棄却理由・成功基準・測定方法・停止条件を確定させる。
   planner に渡すのは evidence-collector の出力までで、**過去の類似 run のログや Do/Check の
   中間結果は渡さない**。見えていると、出た結果に通る基準を書けてしまう。
   雛形は [assets/plan-template.md](assets/plan-template.md)（起点別）を使わせる。

Plan で選択肢が割れて審議が要ると planner が判断したら、`magi` に委譲してから戻る。

### 検証不能の経路

planner は次のどれかに当たるとき、Plan を書かずに `status: "unverifiable"` と理由を返す。
無理に対制御を組むと、測っているのは主張ではなく測れる何かになる。

- 主張検証起点で、主張の一次情報が得られず数字・制約が無い（逆算の材料が無い）
- 測れる環境が無く、ユーザーも用意できないと答えた
- 成功基準を「何が観測されたら」の形に落とせない（「良くなる」「速くなる」のまま）

この場合はユーザーにその旨と「測れる形にするには何が要るか」を返して止める。`research:search`
で調査だけ続ける選択肢を添える。

## ゲート①：Plan 承認

> Plan をユーザーに提示し、**承認を得るまで Do に進まない**。
> workflow は実行中にユーザー入力を受け取れないので、判断はこの境界に置く。
> 動機起点では「仮基準（provisional）のまま 1 周目を回す」ことへの承認として取る。
> 提示するのは Plan の全文（事実・目標・選択肢と機序・採用/棄却・成功基準・測定方法・停止条件）。

## Do/Check フェーズ（Workflow 呼び出し）

承認された Plan をそのまま args に載せて workflow を起動する。この区間には人間ゲートが無く、
条件ごとの fan-out・独立検証・集計が連なるので、順序と反復は script が持つ。

> **透過実行 route**: 現在の tool inventory に native `Workflow` があり、このcallが未試行なら
> native を1回だけ使う。native が存在しない Codex では `workflow:dynamic-workflow-runner` を
> 内部互換層として自動利用するが、現行`pdca.js`はconditionごとのworktree isolationとruntime-generated artifact pathを
> 必須にするためrunner v1ではagent起動前に`rejected_source`となる。isolationやartifactを弱めて実行したことにしない。
> native を試行後にerror / timeout / invalid result となった場合も runner へ fallback しない。
>
> **Codex v1 classification: `rejected_source_v1`**（worktree isolation / runtime-generated artifacts）。

```js
Workflow({
  scriptPath: '<このスキルの絶対パス>/scripts/pdca.js',
  args: {
    skillDir: '<このスキルの絶対パス>',
    plan: '<承認された Plan の全文>',
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

caller が所有する前処理は Plan フェーズとゲート①、成功後処理は結果提示と Act、human gate はゲート①②。
これらをrunner内gateに移さない。現行Codex互換経路は`rejected_source`をそのまま報告し、Do/Checkの結果提示やActを開始しない。
runner未install、`unsupported_runtime`、`workflow_incomplete`でも同様に止める。

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

## ゲート②：Act の判定と承認

> decision の候補出しは [agents/act-judge.md](agents/act-judge.md) に委譲する。act-judge は
> Act 判定表を機械的に適用し、`decision` / `matched_rule` / `auto_executable` を返す。
>
> **自動実行の線引き**（承認済み停止条件が上限を構造で持つことが前提）:
> - `revise`・`stop` で `auto_executable: true` → ユーザー承認なしで実行してよい。実行後に
>   matched_rule と根拠を**事後報告**する（黙って進めない）
> - `standardize` → 必ず人間ゲート。rules / skill / memory への恒久化は不可逆側の操作
> - `human_required`（表に無い状況・行の衝突）→ 必ず人間ゲート。act-judge が発明した規則で
>   進めない
>
> ユーザーが「毎回確認したい」と言った場合は auto_executable を無視して全件ゲートに戻す。
> ここでの人間・司令塔の介入は **redirect のみ**（停滞の指摘・未探索領域の提示）に留め、
> 仮説や答えを供給しない。供給すると、次の周で検証しているのは自分の仮説になり、
> ループが自己確認に変わる。

## Act フェーズ

decision は次の規則で決まる（適用は act-judge が行う）。規則が無いと「もう少し頑張る」が revise に化ける。
**行の優先順位は上から**で、複数行に該当し順序で解決できない場合は human_required。

| 条件 | decision 候補 |
|---|---|
| 成功基準を満たし、`confidence` が `mechanism_identified` | **standardize** |
| 成功基準未達だが `check.mechanisms[]` に `identified: true` があり、`cycle < 3`、予算内 | **revise** |
| `confidence` が `inconclusive`（n・欠測・非決定性で差を主張できない） | **stop**（測定設計に戻る。revise で差分を足しても判定できない） |
| 機序が 1 つも特定できない（全て `identified: false`） | **stop**（機序に紐づかない差分は次の Check で分離できない） |
| `cycle` が上限、または `budget.maxRuns` 到達、または script が BLOCKED | **stop**（どの停止条件に当たったか明記） |
| 成功基準は満たしたが `criteria_validity` が「主張を捉えていない」 | **revise**（差分は基準の見直し。成果物は変えない） |

動機起点の 1 周目は成功基準が `provisional` なので、standardize の前に Check で基準を確定させる。

承認された decision に従う。

- **standardize**：学びの恒久化先を指定する。共通のコード規約・設計原則なら `.claude/rules/`、
  その作業/スキル固有なら当該スキルのファイル、session 文脈の想起だけなら `memory/`。
  置き場所を決めずに残すと腐る
- **revise**：`agents/revision-planner.md` に `check.mechanisms[]` と Plan を渡し、
  **機序に対応する差分だけ**を 3 点以内で作らせる。機序に紐づかない思いつきの変更を混ぜると、
  次の Check で何が効いたか分離できなくなる。できた差分を `revisionDiffs` に、前周の返り値を
  `previous` に、`cycle` を +1 して Do/Check を再実行する
- **stop**：停止条件（予算・反復上限・達成）のどれに当たったかを明記して終える

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

- Do/Check は native Workflow、または Codex の内部互換経路を使う。どちらも利用できない
  環境では Plan とゲートまでしか進めず、利用不可のterminal stateをそのまま伝えて止める
- 予算（run 数・トークン・時間）は Plan の停止条件に必ず入れる。入っていないと 1 周が
  いくらでも伸びる
- ゲート①②はユーザーの承認そのものが要る地点。承認の記録を承認の代わりに使わない
- successCriteria に検証手順を書いたら、それは verifier への契約になる。verifier が実施できなかった
  検証は met=false（未実施）として返り、mechanism-analyst の unmeasured に載る。「書いたのに
  実施されず pass」は起きない設計にする
