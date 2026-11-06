# 模型の作り役の brief

R=/Users/yoshi/github/yoshiysh/claude-plugins/.claude/worktrees/skill-update-generic-design-720616
目的: prd-spec の run の準正常系・異常系（止まる・保留・失敗・やり直し・上限・無応答・回答の検査落ち・blocked の条件）を、文ごとではなく run 全体の状態とイベントとして TLA+ で模型にし、TLC で欠陥の証拠を出す（証明とは扱わない）。
prd-spec スキル・formal-methods スキル・Workflow は使わない。文書・実装は書き換えない。

## 出力先
R/.work/prd-spec-abnormal/<起動文の出力先>/ のみ。.md の報告ファイルは書かない（hook が拒否する。説明は .tla のコメントか .tsv に置く）。書き込みが hook や権限で拒否されたら迂回せず、最終報告に書いて止まる。git 操作をしない。
TLC: `java -XX:+UseParallelGC -Djava.io.tmpdir=<出力先>/tmp -cp /Users/yoshi/.local/share/tla/tla2tools.jar tlc2.TLC -metadir <出力先>/states -workers 4 -config X.cfg X.tla`（v1.7.4。1 回の検査は 2 分以内に収まる定数にする）。

## 入力
- 実装（模型の正本）: R/plugins/workflow/workflows/prd-spec.js、R/plugins/workflow/skills/prd-spec/SKILL.md・references/workflow-io.md、必要なら scripts/doc_check.mjs
- 継ぎ目の閉集合: R/.work/prd-spec-abnormal/reconcile-A/seam.tsv（prd-spec.js の blocked・hold・finalHold・error・status を返す箇所の grep 286 行）
- 欠陥の一覧: reconcile-A/findings.tsv・reconcile-B/findings.tsv・verify-B/missed.tsv（52 件 + 2 件）と insp-req-1/C/defects.tsv・V/missed.tsv
- 利用者の決定: questions/questions.json と answers.json（12 問すべて推奨）。各問いの選んだ選択肢の description が決定の中身。
- 参考（新しい要求の草稿。正本ではない）: R/docs/requirements/requester.md・consumer.md の現行版。build-req-2/open.tsv の「未決」8 件は、模型で答えを導くか、反例として返す対象。
- 既存の模型 R/tests/formal/prd-spec/PrdSpec.tla は 16 状態の抽象で blocked を 1 つにまとめている。参考にするだけで、拡張しなくてよい。

## 作るもの
1. 単位（書き手ごとに切る）
   - Run: run の生涯。段、pass・gate の回数（実装の定数名 MAX_GATES・MAX_AUDIT_PASSES・MAX_CHECK_REWORK を CONSTANT にし、検査では小さい値）、status（needs_answers / blocked の stop_reason ごとと next_args の有無 / done）、保存したか、事後報告。書き手は prd-spec.js（司令塔）。
   - Issue: 論点の生涯。open → 問いにした → 回答（中身あり / 空 / 「決まっていない」 / 確定値と異なる / 対応づけられない）・無応答・記録の消失 → 確定 / 保持規則と Issue の文案 / 未確定のまま。依頼者は非決定的な環境として置く。
   - 継ぎ目: 監査役（下位 agent）が結果を返す・返さない・形式違反、doc_check の blocking の受け渡し、保存直前の照合（tree digest）、仕様書だけの run での upstream_gap。
   - 単位ごとに .tla を分け、継ぎ目は合成した模型で見る。
2. 性質（INVARIANT / PROPERTY）。決定から立てる。最低限:
   - Q1: 直せていない指摘か検査できなかった箇所が残る稿は保存されない
   - Q2: done のとき開いた未確定事項は 0 件（保持規則にした論点は閉じた扱い）
   - Q3: gate と pass の回数は上限で止まる（無限に回らない）
   - Q4: 下位 agent の結果が無いことを指摘 0 件として扱わない
   - Q7: 無応答で止まり続けず run を返し、next_args で続けられる
   - Q8 と PR-REQUESTER-007: 同じ中身の再質問は、回答の記録が失われた場合だけ
   - Q10: 止まった状態ごとに依頼者の次の行動（段から再実行 / 最初から / 要求文書を先に直す / 回答する）が 1 つに決まる
   - 全ての到達可能な非終端状態から、終端（done / 再開不能な blocked / 依頼者の行動待ちで run を返した状態）に到達できる
3. 変異（mutants/ 以下）: 性質ごとに 1 つ以上、性質を破る小さな変更（例: A-024 の「監査役が doc_check の出力を返さないと doc_blocking を 0 とする」fail-open）を入れ、TLC がそれを検出することを示す。検出しない性質は空振りとして記録する。
4. 対応表 trace.tsv（列: action	impl_ref	impl_quote	note）: 模型の各 action が実装のどの行に当たるか。impl_quote は逐語（空白を除いて原文の部分文字列）。実装に当たらない action（決定から足したもの）は impl_ref を decision:Qn にする。
5. 結果 results.tsv（列: check	cfg	states	result	counterexample_file	note）と、反例のトレースを cex/ 以下に保存。
6. 反例と、模型を作る中で一意に決まらなかった遷移を questions.tsv（列: qid	state	event	problem	options	evidence）に書く。problem は「この状態でこのイベントの遷移が 0 本（未定義）か 2 本以上（決まらない）」の形。options は 2〜4 個、各選択肢の帰結（何が止まり・何が進み・どの性質が破れるか）を書き、各選択肢を模型に入れたときに TLC が通るかを実際に回して書く。決定（answers）から一意に導ける遷移は問いにしない。
7. 状態×イベント表 table.tsv（列: unit	state	event	guard	next_state	output	source）: 模型から導いた表。source は impl:<ref> / decision:Qn / open:<qid>。後で要求・仕様を書き直す正本にする。

最終報告は短く日本語で: 単位と状態数、性質ごとの結果（通った / 反例 / 空振り）、questions の件数、出力パス。
