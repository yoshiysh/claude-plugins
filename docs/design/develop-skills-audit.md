# 3 スキルの監査：repo-implement・repo-review・address-review

`repo-implement`・`repo-review`・`address-review` を、設計方針文書（`docs/design/skill-design-patterns.md`）の節に照らした結果。再設計の案は `docs/design/develop-skills-redesign.md` に置き、この文書は不適合とその根拠だけを持つ。要求は `docs/requirements/bp-designed-skill.md`（以下 PR-BPDESIGNEDSKILL-NNN を「PR-NNN」と略す）。

発端：PR #182 の指摘への対応（文書 8 行の修正）に、計画の Workflow が 5 回、レビューが 2 回走り、cache 読みが約 8,850 万 token になった（依頼者の観察）。

## 目次
- [材料と表記](#材料と表記)
- [結論](#結論)
- [観察 1〜7 と原因](#観察-17-と原因)
- [不適合の表](#不適合の表)
- [設計方針の側の欠け](#設計方針の側の欠け)
- [照らした節と照らせなかった節](#照らした節と照らせなかった節)
- [未確定事項](#未確定事項)

## 材料と表記

- 監査役は 4 体。スキルごとに 1 体ずつと、スキル間の受け渡しを見る 1 体。この文書は 4 体の結果を統合し、重複をまとめたもの。
- path:line はリポジトリ直下からのパスで、行番号は監査役が行番号つきで抜き出した束（原本の行番号を保つ）から取った。束を切った commit は確かめていない。この文書を書く側が確かめたのは、全ての path:line（162 件）についてファイルが今の作業ツリーにあり行番号がファイルの行数に収まることを script で照らしたことと、数件の行の中身を束と照らしたことだけ。それ以外の行の中身は、監査役が束に照らして確かめたもの。
- 【推測】は、監査役が記録（抜き出した行・計測表・transcript）では確かめず、そこから導いたもの。印の無いものは記録で確かめた。
- 計測表：e5ea919c のセッションで走った Workflow 18 本・agent 82 体の transcript から、agent ごとの model・effort（api-request の params）・token・tool_result の文字数・同じ agent の中での同じファイルの再読を集計したもの。リポジトリには置いていない。役ごとの合計は次のとおり。

| 役 | 体数 | model / effort | cache 読み | 出力 token | tool_result の文字数 |
|---|---|---|---|---|---|
| planner | 19 | opus-5-5 / high | 43.05M | 674,627 | 1,537,747 |
| plan-reviewer | 16 | opus-5-5 / high | 38.87M | 298,217 | 1,280,464 |
| reviewer | 15 | opus-5-5 / high | 12.32M | 141,085 | 685,604 |
| 検証役（1 段目） | 6 | opus-5-5 / high | 3.07M | 61,568 | 158,542 |
| 検証役（2 段目） | 8 | opus-5-5 / high | 4.39M | 56,412 | 192,145 |
| 運搬役 | 13 | haiku-5-5 / low | 2.24M | 49,477 | 17,232 |
| comment-triager | 1 | opus-5-5 / high | 1.21M | 12,386 | 31,072 |
| triage-verifier | 1 | opus-5-5 / high | 1.02M | 9,166 | 20,513 |
| implementer | 3 | opus-5-5 / high | 0.74M | 7,805 | 16,210 |
| 計 | 82 | | 106.92M | | |

Workflow の内訳は、計画 9 本・実装 3 本・レビュー 5 本・分類 1 本。実装の 3 本はどれも `implementer-0` だけで、修正の回（round ≥ 1）は 1 度も走っていない。

## 結論

重い費用の出どころは、各スキルの中の形ではなく、次の 5 つにある。

1. **変更の種類を問わず、全ての修正に同じ重い経路を当てている。** address-review は全ての fix を repo-implement の全段（計画の run → 4 観点のケース計画 → 実装 → 必須の check → repo-review）へ流す（#1）。8 行の文書修正に形の判定の図を当てると、強いられるのは「書く run とレビューの run を分ける」ことだけで、計画の run を強いる問いは無い。
2. **確かめた事実をスキルの境界で文に潰し、後段が白紙から読み直す。** triage が確かめた根拠と直す path は自然文の依頼になり（#3）、planner が同じファイルを読み直す。repo-review は依頼も前の指摘も知らずに一から読む（#4）。同じ主張を triage-verifier・plan-reviewer・repo-review の検証役が別々に確かめる（#18）。
3. **状態が run ごとに捨てられ、止まり方が「捨てて最初から」しかない。** 計画の外の指摘・修正の上限・運搬の失敗のどれでも、新しい `stateDir` から始め直す（#7・#11）。計測表の計画 9 本に対し実装 3 本、修正の回 0 回という比は、反復が run の中ではなく run の作り直しで起きていたことと矛盾しない【推測】。
4. **範囲を守る規則と根を直す規則がぶつかる場所に、解き方が無い。** 最小差分の縛りが 4 箇所にあり、2 箇所で機械的に強制される。根が広いときに止まって人に範囲を確かめる経路は無い（#12・#13）。
5. **費用の設定と運搬の形が、測定と原則に沿っていない。** 判断役は全て最上位のモデル・`high`（#19）。運搬役に 6〜8KB の本文を逐語で写させ、失敗すると検証済みの結果を全て捨てる（#11・#22）。

計画の 2 役（planner・plan-reviewer）が cache 読みの約 77%（81.9M / 106.9M）を占める。

## 観察 1〜7 と原因

観察は依頼者が #182 の対応で見たもの。原因の欄の # は「不適合の表」の行。

| 観察 | 成り立つか | 原因 |
|---|---|---|
| 1. 判断役が全て最上位のモデル・`high` で走る | 成り立つ。計測表で opus-5-5 / high が 69 体、haiku-5-5 / low が 13 体（運搬役）で、他の組は無い | `ROLE_MODELS` が全ての判断役を `opus`・`high` に固定し、`high` にした測定が無い（#19）。運搬役の最小のモデル・`low` は方針どおり |
| 2. 各 agent が同じ文書を毎回冷読みする | 成り立つ。方針の束は repo-review だけが作って配る。対象側（差分・担当ファイル・呼び出し元）と、repo-implement・address-review の規則文書は、各役が自分で読む | 対象の束を 1 回作って配る段が無い（#2）。境界で事実を文に潰す（#3）。差し戻しの新しい planner も一から読む（#10）。例：wf_9e929ee2 の planner-0 は tool_result 293,424 文字・18 回読み、続く plan-reviewer 3 体が各 147k〜163k 文字 |
| 3. 共有すべき状態と各 agent の作業ファイルが分かれず、差し戻しで前の分析が引き継がれない | 成り立つ | planner に戻すのは `{draft, issues, test_plan_review}` だけで、planner が読んだもの・確かめた path:line は渡らない。次の plan-reviewer は前の回の指摘を知らない（#10）。repo-review は reviewer・検証役の出力を状態に残さない（#11）。スキルごとに `stateDir` が別で、共通の事実の置き場が無い（#3・#4） |
| 4. address-review が文書とコードを分けず、全ての fix を repo-implement へ渡す | 成り立つ | fix が 1 件でもあれば implement へ進み、全ての fix を 1 本の依頼文に束ねる。`repair_paths` は経路の選択に使わない（#1） |
| 5. 計画が実装の写しになって膨らみ、plan-reviewer の指摘面が増えて収束しない | 成り立つ | 計画の schema が `implementation_steps` と条件 × 4 観点のケース計画を必須にし、粒度の上限が無い。plan-reviewer は 5 種類のリストのどれかに 1 件あれば不承認で、重大度が無い。毎回 draft の全体を独立に読む（#20）。依頼文で fix を渡すので、planner は「どの文をどう書くか」まで計画に書く【推測】 |
| 6. 運搬役が 6〜8KB の JSON を逐語で写しきれず E_TRANSPORT で落ちる | 成り立つ。最終の判定の運搬役 5 体中 4 体が落ち、wf_21436ea8 と wf_796bca4b は 2 回とも落ちて carrier_failed になった。transcript では、evidence の 1 要素の path の取り違え・脱落・存在しない要素の追加だった | 運搬役が本文を LLM の出力として再生成する構造（#22）。再送が同じ本文の繰り返し（#23）。失敗で全てを捨てる停止（#11） |
| 7. 直す側の欠陥：束ねる段が無い、最小差分の縛り、needs_input が無い、検証役に渡す範囲 | 成り立つ | 指摘を束ねて同じ根か・設計の欠けかを問う段がどこにも無い（#12）。最小差分の縛りが 4 箇所にあり、根が広いときの needs_input が修正の回に無い（#13）。repo-review の reviewer と検証役は差分と主張の周りだけを見て、依頼・前の指摘・触れる要求 ID を知らない（#4）。#182 の連鎖（064→063→021・047・062→035→052→040）はこの 4 つが同時に効いた結果として説明できる【推測。連鎖の各回の記録は計測表に無い】 |

## 不適合の表

設計方針文書の節ごとに置く。要求 ID の注記：

- 「文脈の配達」「機械で確かめる」「証拠記録の保存と照会」「記録と改善」に当たる PR は、要求文書に無い（見出しを全て読んで確かめた）。
- PR-012（状態の書き込み）は、探索グラフか資産台帳を持つスキルにだけ掛かる。今の 3 スキルはどちらも持たない。「状態の書き込み」の行は、要求 ID なしの原則の不適合として扱う。repo-review は資産台帳の適用条件に当たるので、台帳を足した後は PR-012・013 が掛かる（#27）。
- address-review の監査役は、要求 ID を節名から対応づけたと断っている（address-review の要求に当たる本文を読んでいない）。その行の ID は【推測】。

### 形の判定

| # | 要求 ID | path:line | ずれ | 守らないと壊れること |
|---|---|---|---|---|
| 1 | PR-001・002・004 | `.agents/skills/address-review/scripts/address-core.mjs:307`、`:319-342`、`.agents/skills/address-review/SKILL.md:33`、`.agents/skills/repo-implement/SKILL.md:35-45`、`.agents/skills/repo-implement/scripts/plan.js:21-24`、`:92-97`、`:121`、`:174`、`:179-192`、`.agents/skills/repo-implement/scripts/implement-core.mjs:21` | 変更の種類（文書・SKILL.md・コード）によらず、全ての fix が repo-implement の全段を通る。計画の run を置く理由が書かれていない（`SKILL.md:45` は書く役を分ける理由で、計画役を置く理由ではない）。ケース計画は schema で必須で、変更があって条件 0 件は不合格、各条件は 4 観点それぞれにケースか不適用の理由を要る。文書の変更でも `make test` を開始時と各回に流す | 8 行の文書修正に、計画の Workflow（最大 6 体）、`make test` 2 回（1 回約 349 秒。設計方針文書「水準と未決事項」の実測）、3 観点 × 2 段のレビューが走る |

### 文脈の配達

| # | 要求 ID | path:line | ずれ | 守らないと壊れること |
|---|---|---|---|---|
| 2 | なし | `.agents/skills/repo-implement/scripts/plan.js:196-206`、`.agents/skills/repo-implement/agents/planner.md:12-13`、`.agents/skills/repo-implement/agents/plan-reviewer.md:12`、`:14`、`.agents/skills/repo-implement/agents/implementer.md:12`、`.agents/skills/address-review/scripts/triage.js:116-126`、`.agents/skills/address-review/agents/comment-triager.md:13-14`、`.agents/skills/address-review/agents/triage-verifier.md:13`、`.agents/skills/repo-review/scripts/review.js:158-163`、`:197-217`、`.agents/skills/repo-review/agents/reviewer.md:18-22`、`.agents/skills/repo-review/agents/finding-verifier.md:16` | 共有するのはパスと方針の版の `git show` の指示だけで、対象と規則文書は各役が自分で読む。方針の束を行番号つきで 1 回作って配るのは repo-review だけ（`.agents/skills/repo-review/scripts/review-core.mjs:729-757`。ここは適合）で、対象側の束は誰も作らない。`plan.js:206` の prefix を揃える注記は数百 byte の共有文にしか効かない | 同じ文書を役ごと・回ごとに読み直す。計測表：reviewer 15 体で tool_result 計 685,604 文字、wf_8416d2a0 の planner-0 は review-core.mjs を 3 回読み直す |
| 3 | なし | `.agents/skills/address-review/scripts/address-core.mjs:319-342`（特に `:327-330`）、`.agents/skills/repo-implement/scripts/plan.js:215-222` | triage が確かめた `evidence`（path:line）と `repair_paths` を Markdown の文に潰して依頼に入れる。triage-verifier の `reason`・`evidence` は依頼に載らない。plan の `affected_paths` と `repair_paths` を照らす CLI は無い | 確かめた事実が境界で失われ、planner が一から読み直す。triage と違う範囲を計画しても、push 後の recheck の `repair_paths_unchanged` まで分からない |
| 4 | なし | `.agents/skills/repo-implement/SKILL.md:156`、`.agents/skills/repo-review/scripts/review.js:161`、`:167-182`、`:207`、`.agents/skills/repo-review/agents/reviewer.md:18` | repo-review は何を直す変更か（依頼・triage の指摘・計画の invariants）も、前の回の確定指摘も受け取らない。reviewer は差分の周りを、検証役は主張の path と根拠の path だけを見る | 修正の回ごとに別の行への新しい指摘が出る。前の指摘が直ったかを誰も照らさない。同じ根の指摘が 1 件ずつ直される |
| 5 | なし | `.agents/skills/address-review/scripts/triage.js:66-91`、`:162-193`、`.agents/skills/address-review/SKILL.md:107-120` | 分類役が読んだ範囲・読めなかった範囲を返す項目が無い。SKILL.md の「照合しないもの」は CLI の限界だけを挙げる | 規則文書を読まずに分類した指摘が decline などで確定し、その返信が公開される |

### 目標の固定

| # | 要求 ID | path:line | ずれ | 守らないと壊れること |
|---|---|---|---|---|
| 6 | PR-006 | `.agents/skills/repo-implement/scripts/plan.js:55`、`:217`、`.agents/skills/repo-implement/SKILL.md:53`、`:58` | 依頼文をそのまま `request` として配る。範囲・禁止事項の抽出、指示語の固有名化、数値条件の固定が無い。「期待の挙動と守る性質を把握する」は司令塔の頭の中の作業で、状態に書かれない | 指示語の残った依頼（「さっきの repo-review の確定指摘」）が fresh な agent に渡ると範囲が決まらず、後段の計画外の停止になって返る |

### 停止・再開と人間の入力

| # | 要求 ID | path:line | ずれ | 守らないと壊れること |
|---|---|---|---|---|
| 7 | PR-007 | `.agents/skills/repo-implement/SKILL.md:92`、`:189`、`.agents/skills/repo-implement/scripts/implement-cli.mjs:213-215`、`.agents/skills/repo-implement/scripts/implement-core.mjs:164`、`.agents/skills/address-review/SKILL.md:40`、`.agents/skills/address-review/scripts/address-cli.mjs:144` | 止まった後の再開の経路が無い。abandon の後も、address-review の次の周も、新しい `stateDir` から始める。ledger に計画は無く `plan_sum` だけ | 止まるたびに計画の Workflow と開始時の `make test` から全てやり直す |
| 8 | PR-007 | `.agents/skills/repo-implement/SKILL.md:92-95`、`:118`、`.agents/skills/repo-implement/scripts/implement-cli.mjs:282-283`、`.agents/skills/repo-implement/scripts/plan.js:246`、`:277`、`.agents/skills/address-review/scripts/address-core.mjs:303-306`、`.agents/skills/address-review/scripts/address-cli.mjs:180` | needs_input に当たる停止（`needs_human_decision`・`needs_replan`・`decide`）が返すのは問いか `findingsOutsidePlan` だけ。ここまでの検証結果・影響の範囲・残った未着手を返さない。`next_args` も無い | 人が材料集めの往復で止まる。範囲外の指摘が、根が広いのか別件なのかを判断する材料なしに止まる |
| 9 | PR-007【推測】 | `.agents/skills/address-review/scripts/triage.js:184-186`、`:191-192`、`.agents/skills/address-review/scripts/address-cli.mjs:144` | 食い違い 1 件・unverified 1 件で run 全体が止まり、合意した他の fix も直されない。止まった時点の分類と検証の結果を次の run が引き継がない | 1 件のために、合意済みの分類（2 体分の分析）を捨てて最初から読み直す |
| 10 | PR-007 | `.agents/skills/repo-implement/scripts/plan.js:217-218`、`:233-237`、`:243-244`、`:252-254`、`:266-269`、`:282-283` | 差し戻しは新しい planner に `{draft, problems}` を渡し、計画の全文を返させる。前の planner の読み（影響の調査）は渡らない。plan-reviewer の `evidence` も planner の次の回に渡らない。2 回目以降の plan-reviewer は前の回の指摘を知らない | 1 件の指摘のために全文を作り直し、直していない部分が揺れて別の指摘を生む。計測表：wf_9e929ee2 の planner-1・-2 が各 130k・99k 文字を読み直す |
| 11 | PR-007 | `.agents/skills/repo-review/scripts/review.js:301-317`、`.agents/skills/repo-review/SKILL.md:54`、`.agents/skills/repo-implement/scripts/implement-core.mjs:338`、`.agents/skills/repo-implement/SKILL.md:174` | 運搬が失敗した停止は `findings: []` を返し、1 段目で確定した判定も reviewer・検証役の出力も状態に残さない（`stateDir` にあるのは計画と方針の束だけ）。repo-implement は `retry_review` で repo-review を丸ごと呼び直す | 最終の判定の運搬 1 回の失敗で、reviewer 3 体と検証役最大 6 体の作業を捨てる。計測表：落ちた 2 run の cache 読みは 5.82M＋7.37M＝約 13.2M |
| 12 | PR-007 | `.agents/skills/address-review/agents/comment-triager.md:20`、`:24`、`:27`、`.agents/skills/address-review/scripts/triage.js:79-84`、`.agents/skills/address-review/scripts/address-core.mjs:15`、`.agents/skills/repo-implement/scripts/implement-core.mjs:229-235`、`.agents/skills/repo-implement/SKILL.md:110` | 指摘を束ねて、同じ根から来ていないか・設計の欠けではないかを問う段が無い。分類は 1 件ずつで、schema に根・グループの欄が無く、分類の 5 値に「根が広い」が無い。`needs_decision` の条件に「範囲を広げるべきか」が無い。確定指摘はそのまま券に載り（`implement-core.mjs:235`）、「修正の入力は CLI が選ぶ」（`SKILL.md:110`）が、束ねる段を置く場所を塞ぐ | 同じ根の指摘を症状ごとに最小差分で塞ぎ、隣の要求とぶつかって次の指摘を生む |
| 13 | PR-007 | 縛り：`.agents/skills/address-review/scripts/address-core.mjs:336`、`.agents/skills/repo-implement/agents/planner.md:14`、`.agents/skills/repo-implement/agents/implementer.md:15`、`.agents/skills/repo-implement/scripts/implement.js:144`。強制：`.agents/skills/repo-implement/scripts/implement.js:154-158`、`.agents/skills/repo-implement/scripts/implement-core.mjs:208-210`、`:232-233`。止まり方：`.agents/skills/repo-implement/SKILL.md:118`、`.agents/skills/repo-implement/scripts/implement-cli.mjs:283` | 最小差分の縛りが 4 箇所（依頼文「指摘に無い変更をしない」、planner「依頼の範囲を広げない」、implementer と implement.js の「範囲を広げない」）。plan 外の書き込みは blocked、plan 外の指摘は needs_replan で止まる。根が広いときに範囲を広げてよいかを人に聞く needs_input は、計画の段の `human_decision_required` にしか無い。`insidePlan` は path が `affected_paths` にあるかだけを見るので、同じファイルの中での根の広がりは検出されない | 根が 6 箇所に散った要求文書で、最小差分の修正が隣の要求とぶつかり、新しい指摘 → 止まる → 作り直し、が連鎖する |
| 14 | PR-007【推測】 | `.agents/skills/address-review/scripts/triage.js:131-134`、`:164`、`:175`、`.agents/skills/address-review/scripts/address-core.mjs:301-305` | `catch { return null }` が throw の中身（timeout・権限・schema 違反）を捨て、`*-unavailable` の 1 種に潰す | 原因が残らず、`classify_again` が原因不明のまま同じ失敗を繰り返す |

### 体数と同時実行

| # | 要求 ID | path:line | ずれ | 守らないと壊れること |
|---|---|---|---|---|
| 15 | PR-008 | `.agents/skills/repo-review/scripts/review.js:13`、`:321-323` | 同時実行を 8 体にし、初期値（3 体）から上げた根拠の測定が無い。script でも枠を絞らない | レート制限に当たる。1 run で cache 読み 5.8〜7.4M が短時間に出る |
| 16 | PR-008 | `.agents/skills/repo-review/scripts/review.js:13`、`:52-68` | トークン量の上限を run の入力として受け取る経路が無い（`meta.limits` は個数と時間だけ） | 消費の大きい run を止められない |
| 17 | PR-008 | `.agents/skills/repo-implement/scripts/implement.js:109-111`、`.agents/skills/repo-review/scripts/review.js:69`、`:409-425`、`.agents/skills/address-review/scripts/triage.js:157-160` | 実際に起動した agent のモデル・effort を結果に残さない（repo-review は起動数だけ） | モデル指定が効いたかを run の記録で確かめられない。今回の分析も外から集めた計測表に頼った |
| 18 | PR-008 | `.agents/skills/address-review/scripts/address-core.mjs:319-341`、`.agents/skills/repo-implement/scripts/plan.js:266-269`、`.agents/skills/repo-review/scripts/review.js:167-182` | 同じ主張を triage-verifier・plan-reviewer・repo-review の検証役が 3 回、別の context で確かめ直す。前の段で確かめた事実が後の段に事実として渡らない。LLM に渡す前に機械で減らす原則に沿わない | 判断役の数だけ `high` の費用が掛け算になる |

### モデル・effort・prompt

| # | 要求 ID | path:line | ずれ | 守らないと壊れること |
|---|---|---|---|---|
| 19 | PR-009 | `.agents/skills/repo-implement/scripts/plan.js:12-16`、`.agents/skills/repo-implement/scripts/implement.js:11-13`、`.agents/skills/repo-review/scripts/review.js:17-21`、`.agents/skills/address-review/scripts/triage.js:12-17` | planner・plan-reviewer・implementer・reviewer・検証役・comment-triager・triage-verifier が全て `opus`・`high`。Opus 5.5 の既定は `medium`（設計方針文書「モデル・effort・prompt」の初期値の表）で、上げた理由は「判断だから上位」という注記だけで測定が無い。運搬役の `haiku`・`low` は適合 | 測っていない設定で全ての判断役を払う。計画の 2 役の出力 token は計 97 万（planner-0 が最大 99,817） |
| 20 | PR-009 | `.agents/skills/repo-implement/scripts/plan.js:75-123`、`:110-112`、`:124-140`、`:142-164`、`:250-254`、`:278-284`、`.agents/skills/repo-implement/agents/planner.md:21-23`、`.agents/skills/repo-implement/agents/plan-reviewer.md:15-17`、`:24` | ケースの `input`・`expected`・`expected_basis` が全件必須の非空文字列。文書の変更では「置き換える文の全文」を期待値に書くのが最短の充足になる【推測】。plan-reviewer は 5 種類のリストのどれかに 1 件あれば不承認で重大度が無い。script の形の検査に落ちた計画も 1 回分の作り直しを使う | 計画が実装の写しになって膨らむ。planner の出力が 7k〜99k token（最小は wf_5f75be09 の planner-1 の 7,163）。指摘面が増えるほど不承認が増え、期待値が `implementation_derived_expectations` と往復する |

### 権限

| # | 要求 ID | path:line | ずれ | 守らないと壊れること |
|---|---|---|---|---|
| 21 | PR-010・014・015 | `.agents/skills/repo-implement/scripts/plan.js:4`、`:210`、`.agents/skills/repo-implement/SKILL.md:47`、`:199-206`、`.agents/skills/repo-review/scripts/review.js:186`、`:205`、`:246`、`:321`、`:345`、`:409-425`、`.agents/skills/repo-review/SKILL.md:94`、`.agents/skills/address-review/scripts/triage.js:9`、`:121`、`.agents/skills/address-review/agents/comment-triager.md:1-4`、`.agents/skills/address-review/agents/triage-verifier.md:1-4` | `agent()` に agent type も道具の制限も渡さず、役の prompt で「agents/X.md を読め」と言うだけ。`meta.requirements` の `read-only` は Codex runner でしか効かない。native Workflow では書き込ませない役の書き込みを事後に検出するだけ（snapshot・pin）で、その残る危険を結果に書かない | 検出だけの保証が防止として読まれる。pin が崩れても、どの役の段かを切り分けられない |

### 状態の書き込み

| # | 要求 ID | path:line | ずれ | 守らないと壊れること |
|---|---|---|---|---|
| 22 | なし | `.agents/skills/repo-review/scripts/review.js:224-239`、`:351-359`、`:367`、`:375`、`.agents/skills/repo-review/scripts/review-cli.mjs:403-406`、`.agents/skills/repo-review/scripts/review-core.mjs:497-513`、`:515-530`、`:581`、`:592` | 運搬役に、検証役の全 claim の evidence と 2 段分の rounds を含む 6.4〜8.0KB の本文を heredoc として再出力させる。計画には path（`planPath`）を使うのに、検証役の出力には本文を使う。最終の判定は 1 段目の本文を再送する。`assignments` は CLI が候補から導ける値で、evidence は形の検査にしか使わないのに全件を運ぶ | 写し間違いで E_TRANSPORT になり、最終の判定が出ない（観察 6） |
| 23 | なし | `.agents/skills/repo-review/scripts/review.js:32`、`:241-276` | 送り直しは同じ prompt・同じモデル・同じ本文の再送で、写しが直る機構が無い。wf_21436ea8 では 2 体が同じ誤りを、wf_796bca4b では 2 体が違う誤りをした | 再送が効かず、運搬役 2 体分を足して全損になる |
| 24 | なし | `.agents/skills/repo-implement/SKILL.md:50`、`:80`、`:102`、`:114`、`:135`、`:160`、`.agents/skills/repo-implement/scripts/implement-core.mjs:164`、`:239-243`、`.agents/skills/repo-implement/scripts/implement-cli.mjs:155-161`、`:333-335` | 計画の JSON の全文を、司令塔が inventory・run-checks・begin-round・Workflow の args・verify のたびに書き写す。record-review も repo-review の返り値（6〜8KB）を写し、計画のファイルの path と sum を別の値として写す。sum は写し間違いの検出で、写さない構造ではない | SKILL.md の手順どおりに進めると、司令塔が計画か返り値を inline で写す箇所が 5 つある（`SKILL.md:80`・`:102`・`:114`・`:135`・`:160` を数えた値で、実 run の回数ではない）。回が増えるほど司令塔の context が膨らむ |
| 25 | なし | `.agents/skills/repo-implement/scripts/implement-cli.mjs:370-377`、`:380-382`、`.agents/skills/address-review/scripts/address-cli.mjs:186-198`、`.agents/skills/address-review/SKILL.md:118` | address-review が repo-implement の合否を受け取るのは、司令塔が写す `{passed, actual}` だけ。sum も記録の path も無い | 写し間違いや作った値でも、record-fix は commit・push へ進む。他の受け渡しは sum で守るのに、ここだけ穴になる |

### 機械で確かめる

| # | 要求 ID | path:line | ずれ | 守らないと壊れること |
|---|---|---|---|---|
| 26 | なし | `.agents/skills/address-review/scripts/triage.js:18-46`、`.agents/skills/address-review/scripts/address-core.mjs:12`、`.agents/skills/repo-review/scripts/review.js:22-31` | core の定数・`canonical`・`fnvSum`・path の判定を Workflow source に書き写し、一致をテストで照らす。script が core を import できないことが根 | 片方だけ直すとテストが落ちるまでずれる。写しの検査は検出止まりで、原因を除かない |

### 資産台帳

| # | 要求 ID | path:line | ずれ | 守らないと壊れること |
|---|---|---|---|---|
| 27 | PR-005（台帳を足した後は PR-013） | `.agents/skills/repo-review/scripts/review.js:199`、`:339`、`.agents/skills/repo-review/SKILL.md:59`、`:94` | repo-review は fan-out した結果の「見た」範囲を宣言する必要があり、適用条件に当たるのに台帳が無い。指摘の ID は run の中の添字で、回をまたいで同じ指摘を同じと数えられない。担当はファイル単位。coverage の欠けは記録して続けるだけで、skip 一覧だけを渡す追加起動が無い | 同じ PR を何度レビューしても、直った指摘と残った指摘を ID で辿れない（5 run を比べられない）。coverage の穴が残ったまま進む |

### 記録と改善

| # | 要求 ID | path:line | ずれ | 守らないと壊れること |
|---|---|---|---|---|
| 28 | なし | `.agents/skills/repo-implement/SKILL.md:189`、`.agents/skills/address-review/SKILL.md:40` | run をまたぐ記録（どの指摘で止まったか、何回作り直したか）を持たない。`stateDir` は run ごとに捨てる | 「計画外で止まる → 作り直す」の繰り返しがスキルの記録に現れず、設計の直しにつなげられない。今回の計測も外から transcript を集めて作った |

## 設計方針の側の欠け

スキルの不適合ではなく、設計方針文書が持っていないために 3 スキルの形を止められなかったもの。直し方は `docs/design/develop-skills-redesign.md` の「設計方針文書への提案」に置く。

- 「形の判定」の例の着地の表の、計画・実装・check・レビュー・修正の行が、変更の種類を問わず重い形を一律に許す。文書だけの修正という場合を持たない。
- 「状態の書き込み」の、運搬役は逐語で写すかパスだけを渡す、という行に、写す本文の大きさの上限が無い（要約には上限がある）。そのため大きい本文でも合格に見える【推測】。
- 「停止・再開と人間の入力」に、根の広さを判定して needs_input にする原則の行が無い。あるのは、判断の材料を返すという一般の行だけ。

## 照らした節と照らせなかった節

照らした節：用語、構成要素、文脈の配達、形の判定、目標の固定、停止・再開と人間の入力、体数と同時実行、モデル・effort・prompt、権限、状態の書き込み、機械で確かめる、資産台帳（repo-review）、記録と改善。

照らせなかった節と範囲：

| 節・範囲 | 理由 |
|---|---|
| 探索グラフ | 3 スキルとも形として当たらない。試すもの（観点・計画の `affected_paths`・分類する指摘）の集合を run の中で結果によって変えない（変わるときは止まる）。再設計で足す「根を探す段」には形の問いを当て直す（再設計の文書の「形の判定」） |
| 資産台帳（repo-implement・address-review） | 適用条件に当たらない。repo-implement は fan-out が無く、address-review の分類は 1 体が全件を読む。address-review に台帳を足せば #5 は解ける【推測】 |
| 証拠記録の保存と照会 | 3 スキルとも保存する構成に当たらない。repo-implement の check の記録（argv・exit・HEAD・出力の末尾 40 行。`.agents/skills/repo-implement/scripts/implement-core.mjs:23`）は ID も取得条件も持たず、構成に当たるかが境界。設計方針文書がこの節の一部を未決にしているので、照らす基準が無い |
| repo-review の目標の固定のうち、依頼文の指示語の解決 | script が行う箇所を、抜き出した行の範囲で確かめていない |
| repo-review の停止のうち needs_input とヒント | needs_input は run の境界（前処理）にあり、Workflow の内側に無い。適合とも不適合とも判定していない |
| `implement-cli.mjs` の全ての op、`review-core.mjs` と `review-cli.mjs` の全文 | 観察 6 と照合に要る範囲だけ読んだ |
| 要求文書の address-review に当たる本文 | 見出しの確認まで。ID の対応づけは【推測】 |
| `develop-plugin.md` の 39-125 行・154-209 行・222-348 行・408-448 行 | スキル間の監査役は、衝突を 24-25・32・126-152・210-221・350-406 行の範囲で見た |
| 実機の挙動（Codex runner でのモデルの解決、agent の権限の実効性） | 実行していない。計測表と抜き出した行だけで判断した |
| `tests/` の模擬実行のテストが全数列挙か標本か | 抜き出した束に入れていない |
| 起動数の上限（PR-016・017・019〜023） | 監査役は照らしていない。fan-out を持つのは review の run だけで、構成案「起動数の上限」が扱う。再設計で足す役が起動数に与える影響は、再設計の文書の「体数と起動数」に置く |

## 未確定事項

- **#182 の 8 行の修正に当たる Workflow を、計測表から決められない。** 計測表は計画 9・実装 3・レビュー 5・分類 1 本で、依頼者の観察（計画 5・レビュー 2）と本数が合わない。cache 読み 1.07 億は 18 本の全体の値で、8,850 万との対応も決められない。手がかりは 1 つだけある【推測】：レビューの観点の名前が、文書の観点（doc-writing・claim-scope・req-consistency：wf_21436ea8・wf_796bca4b・wf_b17f9011）とコードの観点（script-bugs・test-meaning・root-cause：wf_aba2ddfb・wf_cd0662ed）に分かれ、carrier_failed の 2 run はどちらも文書の側にある。計画の Workflow のうち、読んだファイルに review-core.mjs などのコードが出るものは、別の作業のものを含む。
- **運搬役以外の transport_err。** 計測表で planner・plan-reviewer・reviewer にも 1〜6 件が立つ。E_TRANSPORT の文字列を含むソースやテストを読んだ回数を拾ったものと考えられる【推測。該当の transcript は見ていない】。運搬の失敗の件数としては運搬役の行だけを数えた。
- **計画の Workflow が上限まで回ったか。** wf_065c6f59・wf_34f04ca0・wf_07a14f9e・wf_9e929ee2 に `planner-2`・`planReviewer-2` があり、上限（2 回の作り直し）まで回ったことと矛盾しない。`revisions_exhausted` で終わったかは表から分からない【推測】。
- **wf_b17f9011 が落ちた run の呼び直しか。** wf_21436ea8 か wf_796bca4b の `retry_review` だった可能性がある【推測】。
- **#182 の連鎖の各回の記録。** 指摘の連鎖（064→063→021・047・062→035→052→040）は依頼者の記録で、どの run のどの指摘かは計測表に無い。
