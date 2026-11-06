-------------------------------- MODULE Run --------------------------------
(* run の生涯。書き手は prd-spec.js（司令塔の段の loop）と SKILL.md の司令塔（保存）。依頼者の呼び直しは環境。
   段は prd-spec.js の STAGES を次のように畳む: intake = 1・2・3、apply = 3a・3b・3a'、decide = 6、
   revise = 7、reaudit・judge = 8、final = finalHold、report = 9、save・save_wait・end = SKILL.md「保存と事後報告」。
   pass は段 5 で 1 に戻る（state.pass = 1）。entry（new・existing・expand）は模型にせず、existing も段 4 を通す（性質の結果は変えない）。
   MUT は変異（mutants/*.cfg）、OPT_* は残った問いの選択肢（options/*.cfg）。OPT_NC = "impl" は実装の欠陥（not_checked を記録しない）。
   model-1 からの変更は model-1-verify、model-2 からの変更は model-2-verify の指摘による。
   OPT_ARGS・OPT_FIXER・OPT_WLOST は問いではなく実装の欠陥の切り替え（"impl" = 実装のまま、"q10" = 決定 Q10 から導いた形）。 *)
EXTENDS Naturals, FiniteSets

CONSTANTS MAX_GATES, MAX_AUDIT_PASSES, MAX_CHECK_REWORK, MAX_RERUN,
          OPT_NC, OPT_LOSTCOUNT, OPT_DIGEST, OPT_DOUBT, OPT_W, OPT_ARGS, OPT_FIXER, OPT_WLOST, MUT, VARY

VARIABLES rs, status, stopReason, hasNext, cause, from,
          gates, pass, stops, reruns, rework,
          deferred, redraft, specOnly, audited,
          blk, docBlk, unchecked, notChecked,
          saved, saveWait, saveCond, ncRecorded,
          wExists, pluginUpd, argsBad

ctl == <<rs, status, stopReason, hasNext, cause, from>>
cnt == <<gates, pass, stops, reruns, rework>>
flg == <<deferred, redraft, specOnly, audited>>
res == <<blk, docBlk, unchecked, notChecked>>
sav == <<saved, saveWait, saveCond, ncRecorded>>
env == <<wExists, pluginUpd, argsBad>>
rvars == <<ctl, cnt, flg, res, sav, env>>

RStages == {"S0", "intake", "draft", "audit", "decide", "decide2", "apply", "apply2",
            "revise", "reaudit", "judge", "report", "save", "save_wait", "end"}
Causes == {"none", "notrun", "script", "fixer_unknown", "integrity", "budget", "verify_soft", "verify_hard", "finalhold",
           "upstream", "unreadable", "doubt", "wlost", "answers", "digest", "digest_rerun",
           "args_hash", "args_old", "args_fixedkeys", "args_try", "args_wmissing"}

RTypeOK ==
  /\ rs \in RStages /\ from \in RStages
  /\ status \in {"running", "needs_answers", "blocked", "done", "exception"}
  /\ stopReason \in {"none", "pass_limit", "no_progress", "budget", "upstream_gap"}
  /\ hasNext \in BOOLEAN /\ cause \in Causes
  /\ gates \in Nat /\ pass \in Nat /\ stops \in Nat /\ reruns \in 0..MAX_RERUN /\ rework \in Nat
  /\ blk \in 0..1 /\ docBlk \in 0..1
  /\ saveCond \in {"na", "git", "stop"}

RInit ==
  /\ rs = "S0" /\ status = "running" /\ stopReason = "none" /\ hasNext = FALSE
  /\ cause = "none" /\ from = "S0"
  /\ gates = 0 /\ pass = 0 /\ stops = 0 /\ reruns = 0 /\ rework = 0
  /\ deferred = FALSE /\ redraft = FALSE /\ specOnly \in BOOLEAN /\ audited = FALSE
  /\ blk = 0 /\ docBlk = 0 /\ unchecked = FALSE /\ notChecked = FALSE
  /\ saved = FALSE /\ saveWait = FALSE /\ saveCond = "na" /\ ncRecorded = FALSE
  /\ wExists = TRUE /\ pluginUpd = FALSE /\ argsBad = FALSE

Running == status = "running"
CanAsk == IF MUT = "Q3gates" THEN gates <= MAX_GATES ELSE gates < MAX_GATES
ReworkLimitHit == IF MUT = "Q3rework" THEN rework > MAX_CHECK_REWORK ELSE rework >= MAX_CHECK_REWORK
PassLimitHit == IF MUT = "Q3pass" THEN pass > MAX_AUDIT_PASSES ELSE pass >= MAX_AUDIT_PASSES
Blocking == blk + docBlk

Goto(s) == rs' = s /\ UNCHANGED <<status, stopReason, hasNext, cause, from>>

Block(c, nxt, sr) ==
  /\ status' = "blocked" /\ cause' = c /\ hasNext' = nxt /\ stopReason' = sr /\ from' = rs
  /\ UNCHANGED <<rs, cnt, flg, res, sav, env>>

OpenGateR(nx, rd) ==
  /\ status' = "needs_answers" /\ cause' = "answers" /\ hasNext' = (MUT # "Q7") /\ stopReason' = "none"
  /\ from' = nx /\ gates' = gates + 1 /\ stops' = stops + 1
  /\ redraft' = rd /\ deferred' = FALSE
  /\ UNCHANGED <<rs, pass, reruns, rework, specOnly, audited, res, sav, env>>
OpenGate(nx) == OpenGateR(nx, redraft \/ deferred)

\* @row Run|S0|司令塔が workspace を用意する|所在を示された文書を読める|intake|Workflow を起動|impl
\* @trace S0Go|plugins/workflow/skills/prd-spec/SKILL.md:69|**W を作る**: native では `[SKILL_DIR]/workspace/<案件>/`|OPT_W=ask は案件名を聞くので依頼者を 1 回止める
S0Go == rs = "S0" /\ Running /\ Goto("intake")
        /\ stops' = (IF OPT_W = "ask" THEN stops + 1 ELSE stops)
        /\ UNCHANGED <<gates, pass, reruns, rework, flg, res, sav, env>>
\* @row Run|S0|所在を示された文書を読めない|-|blocked（next_args なし）|読めなかった文書の所在|decision:Q10
\* @trace S0Unreadable|decision:Q10|-|読み取れない文書があれば run を始めずに止める
S0Unreadable == rs = "S0" /\ Running /\ Block("unreadable", FALSE, "none")
\* @row Run|S0|作成に入る前の判定に迷う|OPT_DOUBT=ask_end|blocked（next_args なし）|迷った点と問い|open:QM-06
\* @trace S0DoubtEnd|plugins/workflow/skills/prd-spec/SKILL.md:35|空入力・単語のみのときは、推測で対象を決めずに次を返して終える|空入力の扱いを判定の迷いに広げた選択肢
S0DoubtEnd == OPT_DOUBT = "ask_end" /\ rs = "S0" /\ Running /\ Block("doubt", FALSE, "none")
\* @row Run|S0|作成に入る前の判定に迷う|OPT_DOUBT=defer|intake（迷った点を問いにして持ち越す）|-|open:QM-06
\* @trace S0DoubtDefer|-|-|open:QM-06 の選択肢 2（実装にも決定にも無い遷移）
S0DoubtDefer == OPT_DOUBT = "defer" /\ rs = "S0" /\ Running /\ Goto("intake") /\ UNCHANGED <<cnt, flg, res, sav, env>>
\* @row Run|S0|作成に入る前の判定に迷う|OPT_DOUBT=pregate|needs_answers（作成前の中断点）|questions.json|open:QM-06
\* @trace S0DoubtPregate|-|-|open:QM-06 の選択肢 3（実装にも決定にも無い遷移）
S0DoubtPregate == OPT_DOUBT = "pregate" /\ rs = "S0" /\ Running /\ OpenGateR("apply", TRUE)

\* @row Run|intake|段 1〜3 が終わる|問いがあり ~specOnly|draft（deferred: 問いを持ち越す）|-|impl
\* @row Run|intake|段 1〜3 が終わる|問いが無いか specOnly|draft|-|impl
\* @trace IntakeCarry|plugins/workflow/workflows/prd-spec.js:2210|if (!specOnly()) state.deferred = true|too-loose（rev.tsv）: entry=existing の段 5 直行（2455）を模型にせず draft を通す。draft の失敗注入が existing でも起きる分だけ緩く、性質の結果は変えない
IntakeCarry(pqAfter) ==
  /\ rs = "intake" /\ Running /\ ~(MUT = "Q6" /\ pqAfter /\ ~specOnly)
  /\ Goto("draft") /\ deferred' = (deferred \/ (pqAfter /\ ~specOnly))
  /\ UNCHANGED <<cnt, redraft, specOnly, audited, res, sav, env>>
\* @trace IntakeAskNow|-|-|変異 Q6 専用（最初のゲートを段 6 まで持ち越さない変更）
IntakeAskNow == MUT = "Q6" /\ rs = "intake" /\ Running /\ ~specOnly /\ OpenGateR("apply", TRUE)

\* @row Run|draft|writer が初稿を書く|-|audit|-|impl
\* @trace Draft|plugins/workflow/workflows/prd-spec.js:2606|async function stage4() {|writer の null は FailNotRun が持つ
Draft == rs = "draft" /\ Running /\ Goto("audit") /\ UNCHANGED <<cnt, flg, res, sav, env>>

AuditResult(v, nc, to) ==
  /\ Goto(to)
  /\ blk' \in {0, 1} /\ notChecked' = nc
  /\ docBlk' \in (IF v = "zero" THEN {0} ELSE {0, 1}) /\ unchecked' = (v = "zero")

\* @row Run|audit|監査役が全員返す|v=proceed または zero|decide（pass=1）|指摘・doc_blocking|impl
\* @row Run|audit|監査役の結果が無い|v=rerun|blocked（next_args あり）|-|impl
\* @trace Audit|plugins/workflow/workflows/prd-spec.js:2694|state.pass = 1|段 5 に入るたびに pass は 1 に戻る
Audit(v, nc) ==
  /\ rs = "audit" /\ Running
  /\ IF v = "rerun" THEN Block("notrun", TRUE, "none")
     ELSE /\ AuditResult(v, nc, "decide") /\ pass' = 1 /\ audited' = TRUE
          /\ UNCHANGED <<gates, stops, reruns, rework, deferred, redraft, specOnly, sav, env>>

\* @row Run|decide|resolver が段 6 の裁定をする（両立しない指摘は裁定役が決め、価値の判断なら問い）|-|decide2|-|decision:Q12
\* @trace Decide|plugins/workflow/workflows/prd-spec.js:2768|async function stage6() {|裁定は Issue!AriseAndRule が持つ
Decide == rs = "decide" /\ Running /\ Goto("decide2") /\ UNCHANGED <<cnt, flg, res, sav, env>>

\* @row Run|decide2|回答待ちの問いがある|canAsk かつ ~specOnly|needs_answers（gates+1、next_args あり）|questions.json|impl
\* @trace Decide2Ask|plugins/workflow/workflows/prd-spec.js:2784|if (allowQuestions) return needsAnswers("3a'", '7')|deferred なら 3a から入り初稿を書き直す（redraft）
Decide2Ask == rs = "decide2" /\ Running /\ CanAsk /\ (~specOnly \/ MUT = "Q9") /\ OpenGate("apply")
\* @row Run|decide2|回答待ちの問いがある|canAsk かつ specOnly|blocked（upstream_gap、next_args なし）|questions.md|impl
\* @trace Decide2Upstream|plugins/workflow/workflows/prd-spec.js:2249|stop_reason: 'upstream_gap',|要求文書を直すと固定の文書の sha が変わるので next_args を付けない
Decide2Upstream == rs = "decide2" /\ Running /\ CanAsk /\ specOnly /\ MUT # "Q9" /\ Block("upstream", FALSE, "upstream_gap")
\* @row Run|decide2|回答待ちの問いが無いか ~canAsk|-|revise（~canAsk なら問いを保持規則に）|-|impl
\* @trace Decide2Go|plugins/workflow/workflows/prd-spec.js:2785|const he = await holdLeft('6', pendingQuestions(state), 'Decide', LIMIT_WHY)|聞ける回数の上限の後は保持規則
Decide2Go == rs = "decide2" /\ Running /\ Goto("revise") /\ UNCHANGED <<cnt, flg, res, sav, env>>

\* @trace Apply|plugins/workflow/workflows/prd-spec.js:2462|async function stageApply(stageId) {|回答の反映は Issue!ApplyStep が持つ
Apply == rs = "apply" /\ Running /\ UNCHANGED rvars
\* @row Run|apply|回答をすべて当て終える|-|apply2|-|impl
\* @trace ApplyDone|plugins/workflow/workflows/prd-spec.js:2488|if (res.error) return blocked(res.error, res.rerun === false ? null : stageId)|段を出るとき doc_check のやり直しの回数は 0 に戻る
ApplyDone == rs = "apply" /\ Running /\ Goto("apply2") /\ rework' = 0
             /\ UNCHANGED <<gates, pass, stops, reruns, flg, res, sav, env>>
\* @row Run|apply|回答を当てた flow が doc_check flow の検査に落ちる|rework<MAX_CHECK_REWORK|apply（resolver に直させる、rework+1）|-|impl
\* @trace ApplyRework|plugins/workflow/workflows/prd-spec.js:2149|}, MAX_CHECK_REWORK)|生成者への差し戻しは MAX_CHECK_REWORK 回まで
ApplyRework == rs = "apply" /\ Running /\ ~ReworkLimitHit /\ rework' = rework + 1
               /\ UNCHANGED <<ctl, gates, pass, stops, reruns, flg, res, sav, env>>
\* @row Run|apply|差し戻しが上限に達しても flow が閉じない|直し手の表にある符号|blocked（next_args あり）|-|impl
\* @trace ApplyReworkLimit|plugins/workflow/workflows/prd-spec.js:2152|if (done.defect) return { error: `段 ${stage}: 回答を当てた flow が閉じていません（${done.defect.text}）`, rerun: !done.defect.stop }|直し手の表にある符号は MAX_CHECK_REWORK 回の差し戻しの後に止まる
ApplyReworkLimit == rs = "apply" /\ Running /\ ReworkLimitHit /\ Block("notrun", TRUE, "none")
\* @row Run|apply|回答を当てた flow に直し手の表に無い符号がある|-|blocked（next_args なし。reason は §5 の「prd-spec.js を直す」に回る形）|-|decision:Q10
\* @trace ApplyFixerUnknown|plugins/workflow/workflows/prd-spec.js:444|for (let i = 0; defect && !defect.stop && i < limit; i++)|rev2.tsv の too-strong への対応: 表に無い符号（608 の stop: true）は差し戻しを回さずに止まる。実装の reason は「script の不変条件に反しました」を持たず §5 に回らない（OPT_FIXER="impl"）。決定 Q10 から §5 に回す形（"q10"）を導いた（model-2 の QM-17）
ApplyFixerUnknown == rs = "apply" /\ Running /\ Block("fixer_unknown", FALSE, "none")
\* @row Run|apply2|反映で問いが残る|canAsk|needs_answers（gates+1）|questions.json|impl
\* @trace Apply2Ask|plugins/workflow/workflows/prd-spec.js:2492|if (allowQuestions) return needsAnswers(stageId)|回答の後の続きの問いも MAX_GATES から引く
Apply2Ask == rs = "apply2" /\ Running /\ CanAsk /\ OpenGate("apply")
\* @row Run|apply2|反映で問いが残らないか ~canAsk|-|draft（redraft）/ revise|-|impl
\* @trace Apply2Go|plugins/workflow/workflows/prd-spec.js:2497|return ENTRY === 'existing' ? '5' : '4'|too-loose（rev.tsv）: existing も draft を通し、3a → 3b の組み直しは apply に畳む。性質の結果は変えない
Apply2Go == rs = "apply2" /\ Running /\ rs' = (IF redraft THEN "draft" ELSE "revise") /\ redraft' = FALSE
            /\ UNCHANGED <<status, stopReason, hasNext, cause, from, cnt, deferred, specOnly, audited, res, sav, env>>

\* @row Run|revise|改稿する指摘か裁定がある|-|reaudit|-|impl
\* @trace ReviseReaudit|plugins/workflow/workflows/prd-spec.js:2851|await backupDocs('7', auditDocs())|writer の null は FailNotRun
ReviseReaudit == rs = "revise" /\ Running /\ Goto("reaudit") /\ UNCHANGED <<cnt, flg, res, sav, env>>
\* @row Run|revise|改稿の対象が無い|Blocking=0|report|-|impl
\* @trace ReviseReport|plugins/workflow/workflows/prd-spec.js:2847|log('改稿する指摘も裁定も無いので、改稿と再監査を飛ばします（最後の書き込みは段 5 で全体を監査済み）')|unchecked のまま来ても止まらない（A-024 の経路）
ReviseReport == rs = "revise" /\ Running /\ (Blocking = 0 \/ MUT = "Q1") /\ Goto("report") /\ UNCHANGED <<cnt, flg, res, sav, env>>
\* @row Run|revise|改稿の対象が無い|Blocking>0|blocked（no_progress、next_args なし）|report_path・hold_drafts|impl
\* @trace ReviseFinal|plugins/workflow/workflows/prd-spec.js:2846|if (p.blocking.length) return finalHold(p.blocking.length, [], 'no_progress', '改稿に回せる指摘も裁定も無いまま blocking が残った', '7')|finalHold の blocked は next_args を付けない
ReviseFinal == rs = "revise" /\ Running /\ Blocking > 0 /\ Block("finalhold", FALSE, "no_progress")
\* @row Run|revise・judge（finalHold の中）|保持規則への変換の flow の照合か独立の flow-check が落ちる|-|blocked（next_args あり。段 7 から、段 8 で止めたときは範囲を絞った再監査から。stop_reason は no_progress・pass_limit）|report_path|impl
\* @trace FinalHoldFail|plugins/workflow/workflows/prd-spec.js:3021|if (kept) return blocked(kept.error, kept.rerun ? stage : null, report)|rev2.tsv の wrong への対応: 再実行先は finalHold を呼んだ段（7 か 8）で、返り値は report の stop_reason を持つ。guard は JudgeNoProgress・JudgeLimit と同じ過大近似
FinalHoldFail ==
  /\ Running /\ Blocking > 0
  /\ \/ rs = "revise" /\ from' = "revise" /\ stopReason' = "no_progress"
     \/ rs = "judge" /\ from' = "reaudit" /\ stopReason' \in (IF PassLimitHit THEN {"no_progress", "pass_limit"} ELSE {"no_progress"})
  /\ status' = "blocked" /\ cause' = "notrun" /\ hasNext' = TRUE
  /\ UNCHANGED <<rs, cnt, flg, res, sav, env>>

\* @row Run|reaudit|範囲を絞った監査が返る|v=proceed または zero|judge|指摘・doc_blocking|impl
\* @row Run|reaudit|監査役の結果が無い|v=rerun|blocked（next_args あり）|-|impl
\* @trace Reaudit|plugins/workflow/workflows/prd-spec.js:2947|const docCheck = parseStdout(d.doc_check)|usable(d) は doc_check を見ない
Reaudit(v, nc) ==
  /\ rs = "reaudit" /\ Running
  /\ IF v = "rerun" THEN Block("notrun", TRUE, "none")
     ELSE AuditResult(v, nc, "judge") /\ UNCHANGED <<cnt, flg, sav, env>>

\* @row Run|judge|blocking が 0（低重大度の指摘と not_checked は数えず検査記録へ。帰結: consumer の完了条件「機械検査が全部通る」（D-023）を「改稿を必須とする指摘が 0 件」に改める要求の改訂が要る）|-|report|-|decision:Q11
\* @trace JudgeReport|plugins/workflow/workflows/prd-spec.js:2973|if (!blocking) return '9'|終了は blocking 0 件で判定する（Q11。QM-13 の答え）
JudgeReport == rs = "judge" /\ Running /\ Blocking = 0 /\ Goto("report") /\ UNCHANGED <<cnt, flg, res, sav, env>>
\* @row Run|judge|blocking が残り進展が無い|-|blocked（no_progress、next_args なし）|report_path|impl
\* @trace JudgeNoProgress|plugins/workflow/workflows/prd-spec.js:2979|return finalHold(blocking, newTbd, 'no_progress',|too-loose（rev.tsv）: 実装の条件（尽きた項目・新しい TBD なし・doc_blocking が減らない）を環境の選択で過大近似する。不変式には反例を増やす向きだけ
JudgeNoProgress == rs = "judge" /\ Running /\ Blocking > 0 /\ Block("finalhold", FALSE, "no_progress")
\* @row Run|judge|blocking が残り pass が上限|-|blocked（pass_limit、next_args なし）|report_path|impl
\* @trace JudgeLimit|plugins/workflow/workflows/prd-spec.js:2981|if (state.pass >= MAX_AUDIT_PASSES) return finalHold(blocking, newTbd, 'pass_limit',|上限は暴走止め
JudgeLimit == rs = "judge" /\ Running /\ Blocking > 0 /\ PassLimitHit /\ Block("finalhold", FALSE, "pass_limit")
\* @row Run|judge|blocking が残り pass が上限未満|-|decide（pass+1）|-|impl
\* @trace JudgeLoop|plugins/workflow/workflows/prd-spec.js:2982|state.pass += 1|段 6 → 7 → 8 をもう 1 パス
JudgeLoop == rs = "judge" /\ Running /\ Blocking > 0 /\ ~PassLimitHit /\ Goto("decide")
             /\ pass' = (IF MUT = "TERM" THEN pass ELSE pass + 1)
             /\ UNCHANGED <<gates, stops, reruns, rework, flg, res, sav, env>>

\* @row Run|report|段 9（固定の文書に開いた TBD があっても done。「完成しました」と言わず件数と ID を示す）|-|save（status=done、next_args なし）|report_path・open_tbd|decision:Q2
\* @trace Report|plugins/workflow/workflows/prd-spec.js:3037|return finish('done', { report_path: `${W}/report.md`, tree_digest: state.tree_digest, docs: auditDocs(), fixed_docs: FIXED_KEYS })|固定の文書の carried_tbd は new_tbd に入らず done に残る（2316）。Q2 の本文どおり（QM-12 の答え）
Report == rs = "report" /\ Running /\ status' = "done" /\ rs' = "save"
          /\ UNCHANGED <<stopReason, hasNext, cause, from, cnt, flg, res, sav, env>>

\* @row Run|save|tree digest が一致し保存先が git で戻せる|-|end（承認を待たずに saved。not_checked は検査記録に載せる）|事後報告|decision:Q5・Q11
\* @row Run|save|tree digest が一致し不変条件・git 管理外・上書き|-|save_wait|差分と問い|impl
\* @row Run|save|tree digest が一致しない|OPT_DIGEST=restart / undef / existing|end（保存しない）|食い違い|open:QM-04
\* @row Run|save|tree digest が一致しない|OPT_DIGEST=rerun8|blocked（next_args: 段 8）|食い違い|open:QM-04
\* @trace Save|plugins/workflow/skills/prd-spec/SKILL.md:157|違えば保存しない。|保存しない後の行動は実装にも SKILL.md にも無い（A-022）。ncRecorded は Q11 の記録（OPT_NC=impl は記録しない実装の欠陥）
Save(match) ==
  /\ rs = "save" /\ status = "done"
  /\ IF ~match THEN
       IF OPT_DIGEST = "rerun8"
       THEN /\ status' = "blocked" /\ hasNext' = TRUE /\ cause' = "digest_rerun" /\ from' = "reaudit"
            /\ stopReason' = "none" /\ UNCHANGED <<rs, cnt, flg, res, sav, env>>
       ELSE /\ rs' = "end" /\ cause' = "digest"
            /\ UNCHANGED <<status, stopReason, hasNext, from, cnt, flg, res, sav, env>>
     ELSE
       \/ /\ saveCond' = "git"
          /\ IF MUT = "Q5"
             THEN rs' = "save_wait" /\ saveWait' = TRUE /\ UNCHANGED <<saved, ncRecorded>>
             ELSE rs' = "end" /\ saved' = TRUE /\ saveWait' = FALSE /\ ncRecorded' = (OPT_NC = "record" /\ notChecked)
          /\ UNCHANGED <<status, stopReason, hasNext, cause, from, cnt, flg, res, env>>
       \/ /\ saveCond' = "stop" /\ rs' = "save_wait" /\ saveWait' = TRUE
          /\ UNCHANGED <<saved, ncRecorded, status, stopReason, hasNext, cause, from, cnt, flg, res, env>>

\* @row Run|save_wait|依頼者が保存を承認する|-|end（saved）|-|impl
\* @trace SaveApprove|plugins/workflow/skills/prd-spec/SKILL.md:169|新規保存で同名のファイルが既にあれば上書きせず、差分を見せて判断を求める。|承認・拒否は依頼者の非決定的な行動
SaveApprove == rs = "save_wait" /\ rs' = "end" /\ saved' = TRUE /\ ncRecorded' = (OPT_NC = "record" /\ notChecked)
               /\ UNCHANGED <<status, stopReason, hasNext, cause, from, cnt, flg, res, saveWait, saveCond, env>>
\* @row Run|save_wait|依頼者が保存を拒む|-|end（保存しない）|-|impl
\* @trace SaveDecline|plugins/workflow/skills/prd-spec/SKILL.md:169|新規保存で同名のファイルが既にあれば上書きせず、差分を見せて判断を求める。|too-strong（rev.tsv）のまま直さない: 衝突しない文書は写す部分保存を「保存しない」に畳む。保存する木は同じ監査済みの版なので saved を読む Q1・Q1nc の結果は変わらない
SaveDecline == rs = "save_wait" /\ rs' = "end" /\ UNCHANGED <<status, stopReason, hasNext, cause, from, cnt, flg, res, sav, env>>

\* @row Run|needs_answers|依頼者が回答を書いて next_args で呼び直す|W がある|apply（3a・3a'）|-|impl
\* @trace ReqAnswer|plugins/workflow/skills/prd-spec/SKILL.md:111|そのうえで下の「呼び直し」のとおりに呼び直す。|依頼者は無応答でもよい（run は返したまま。Q7）
ReqAnswer == status = "needs_answers" /\ wExists /\ status' = "running" /\ rs' = from /\ hasNext' = FALSE /\ cause' = "none"
             /\ UNCHANGED <<stopReason, from, cnt, flg, res, sav, env>>
\* @row Run|needs_answers・blocked（next_args あり）|呼び直す|W が無い（plugin の更新）|例外（W が無い。S0 から）|-|decision:Q10
\* @trace ReqWLost|plugins/workflow/workflows/prd-spec.js:3113|if (!fc) return blocked(`flow-check（段 ${from} の入口）が doc_check flow の stdout を返しませんでした`, from)|実装（OPT_WLOST="impl"）: W が無いと入口の flow-check が doc_check（4462）で落ち、enterFromDisk が next_args ありの blocked を返し、同じ呼び直しで同じ所に戻る。決定 Q10（読み取れない文書があれば始めずに止める・段からと最初からの区別）から起動の前に止める形（"q10"）を導いた（model-2 の QM-18）
ReqWLost == status \in {"needs_answers", "blocked"} /\ hasNext /\ ~wExists
            /\ IF OPT_WLOST = "impl"
               THEN status' = "blocked" /\ hasNext' = TRUE /\ cause' = "wlost" /\ stopReason' = "none"
                    /\ UNCHANGED <<rs, from, cnt, flg, res, sav, env>>
               ELSE status' = "exception" /\ hasNext' = FALSE /\ cause' = "args_wmissing" /\ stopReason' = "none"
                    /\ UNCHANGED <<rs, from, cnt, flg, res, sav, env>>
\* @row Run|needs_answers・blocked（next_args あり）|返った next_args と違う args（existing_docs の打ち間違いを含む）・tx.try が不正|-|例外（返った next_args を変えずに渡す）|例外の文|impl
\* @row Run|needs_answers・blocked（next_args あり）|旧版の next_args（state.gates が無い）で呼び直す|-|例外（S0 から。§5 の「渡した args を確かめる」は当たらない）|例外の文|decision:Q10
\* @row Run|needs_answers・blocked（next_args あり）|hash は合うが state.fixed_sha のキーが existing_docs と合わない|-|例外（段 1 から。「next_args を変えずに渡す」は当たらない）|例外の文|decision:Q10
\* @trace ReqBadArgs|plugins/workflow/workflows/prd-spec.js:911|返った next_args を変えずに渡すか、段 1 から始めてください|起動の前の検査（902・907・911・928）。rev2.tsv の wrong への対応: existing_docs の打ち間違いは state_hash が覆うので 902 で落ち（392・397）、固定の文書の本文の変化は 911 でなく監査の fixedMoved（2331-2334）が持つ（FailIntegrity）。907・911 の文は 2 つの行動を示しうる（OPT_ARGS="impl"）。決定 Q10 から原因ごとに 1 つの行動にした（"q10"。model-2 の QM-16 は前提が誤りだったので外した）
ReqBadArgs == status \in {"needs_answers", "blocked"} /\ hasNext /\ wExists /\ ~argsBad
              /\ status' = "exception" /\ hasNext' = FALSE /\ stopReason' = "none" /\ argsBad' = TRUE
              /\ cause' \in {"args_hash", "args_old", "args_fixedkeys", "args_try"}
              /\ UNCHANGED <<rs, from, cnt, flg, res, sav, wExists, pluginUpd>>
\* @row Run|needs_answers|回答の記録が失われて呼び直す|OPT_LOSTCOUNT=nocount|needs_answers（同じゲート、stops+1）|同じ問い|impl
\* @trace ReqLoseNoCount|plugins/workflow/workflows/prd-spec.js:2281|ac.exists !== true ? 'ファイルがありません（段 1 の reset が消したことがある）'|同じゲート名で止め直し、gates を数えない
ReqLoseNoCount == OPT_LOSTCOUNT = "nocount" /\ status = "needs_answers" /\ wExists /\ stops' = stops + 1
                  /\ UNCHANGED <<ctl, gates, pass, reruns, rework, flg, res, sav, env>>
\* @row Run|needs_answers|回答の記録が失われて呼び直す|OPT_LOSTCOUNT=count かつ canAsk|needs_answers（gates+1）|同じ問い|open:QM-03
\* @trace ReqLoseCountAsk|-|-|open:QM-03 の選択肢 2（数える）
ReqLoseCountAsk == OPT_LOSTCOUNT = "count" /\ status = "needs_answers" /\ wExists /\ CanAsk
                   /\ gates' = gates + 1 /\ stops' = stops + 1
                   /\ UNCHANGED <<ctl, pass, reruns, rework, flg, res, sav, env>>
\* @row Run|needs_answers|回答の記録が失われて呼び直す|OPT_LOSTCOUNT=count かつ ~canAsk|apply（その問いは保持規則）|-|open:QM-03
\* @trace ReqLoseCountHold|-|-|open:QM-03 の選択肢 2（数える）で上限に達したとき
ReqLoseCountHold == OPT_LOSTCOUNT = "count" /\ status = "needs_answers" /\ wExists /\ ~CanAsk
                    /\ status' = "running" /\ rs' = from /\ hasNext' = FALSE /\ cause' = "none"
                    /\ UNCHANGED <<stopReason, from, cnt, flg, res, sav, env>>
\* @row Run|blocked（next_args あり）|原因を除いて next_args で呼び直す|W がある|止まった段|-|impl
\* @trace Rerun|plugins/workflow/skills/prd-spec/SKILL.md:114|`next_args` があるのは、その段からやり直せる失敗（agent が応答|呼び直しの回数は MAX_RERUN で有限にする
Rerun == status = "blocked" /\ hasNext /\ wExists /\ reruns < MAX_RERUN
         /\ status' = "running" /\ rs' = from /\ hasNext' = FALSE /\ cause' = "none" /\ stopReason' = "none"
         /\ reruns' = reruns + 1 /\ UNCHANGED <<from, gates, pass, stops, rework, flg, res, sav, env>>
\* @row Run|needs_answers・blocked|plugin を更新する|OPT_W=skilldir|W が消える|-|impl
\* @trace PluginUpdate|plugins/workflow/skills/prd-spec/SKILL.md:70|native はこの skill の版ごとの install 先に置くので、plugin を更新すると W は新しい版に引き継がれない|plugin の更新は環境
PluginUpdate == status \in {"needs_answers", "blocked"} /\ ~pluginUpd /\ pluginUpd' = TRUE
                /\ wExists' = (OPT_W # "skilldir") /\ UNCHANGED <<ctl, cnt, flg, res, sav, argsBad>>

(* 失敗の注入は代表の段に限る（状態数を 2 分に収めるため）。agent の null は段の種類ごとに 1 つ、script の欠陥・所有表の外の書き込みは段 4、token は段 6。 *)
FailStages == {"intake", "audit", "apply", "reaudit"}
\* @row Run|段の途中|agent が null か例外|-|blocked（next_args あり）|-|impl
\* @trace FailNotRun|plugins/workflow/workflows/prd-spec.js:3157|else if (e && e.rerunStage) r = blocked(e.message, running)|段から再実行
FailNotRun == rs \in FailStages /\ Running /\ Block("notrun", TRUE, "none")
\* @row Run|段の途中|script の不変条件に反する・callDefect|-|blocked（next_args なし、reason が「script の不変条件に反しました」）|-|decision:Q10
\* @trace FailScript|plugins/workflow/workflows/prd-spec.js:3161|if (scriptDefect) r = blocked(`script の不変条件に反しました（段 ${running}）: ${scriptDefect}`, null)|SKILL.md の中継が reason の接頭辞で workflow-io.md §5（prd-spec.js を直す）へ回す（QM-11 の答え）
FailScript == rs = "draft" /\ Running /\ Block("script", FALSE, "none")
\* @row Run|段の途中|所有表の外の書き込み（固定の文書の変化・消えた控え）|-|blocked（next_args なし）|-|impl
\* @trace FailIntegrity|plugins/workflow/workflows/prd-spec.js:3088|W を段の入口に戻せないので、S0 からやり直してください|最初からやり直す。固定の文書の本文の変化（監査の fixedMoved、2331-2334、rerun: false）もここに畳む
FailIntegrity == rs = "draft" /\ Running /\ Block("integrity", FALSE, "none")
\* @row Run|段の途中・段の境界|token の目標に達する|-|blocked（budget、next_args あり）|-|impl
\* @trace FailBudget|plugins/workflow/workflows/prd-spec.js:3156|else if (e && e.budgetStop) r = blocked(e.message, running, { stop_reason: 'budget' })|目標を上げて段から再実行
FailBudget == rs = "decide" /\ Running /\ Block("budget", MUT # "Q10", "budget")
\* @row Run|apply|保持規則・裁定が直しても検証に落ちる（rerun を偽にしない）|-|blocked（next_args あり）|-|impl
\* @trace FailVerify|plugins/workflow/workflows/prd-spec.js:2104|const stuck = (ids) => ({ error: `段 ${stage}: 保持規則 ${list(ids)} が書き直した後も検証に落ちました|rerun を偽にしないので next_args が付く
FailVerify == rs = "apply" /\ Running /\ Block("verify_soft", TRUE, "none")
\* @row Run|apply・decide|domain assessment の独立検証が修正後も失敗・問いへの変換後の独立検証が合格しない（rerun: false）|-|blocked（next_args なし）|-|impl
\* @trace FailVerifyHard|plugins/workflow/workflows/prd-spec.js:1779|if (missing.length) return { error: `段 ${stage}: 問いへの変換後の独立検証が合格を返しませんでした（${list(missing)}）。確認できるまで依頼者に提示できません`, rerun: false }|fwd.tsv の missing（1598・1653・1769・1776・1779）への対応。決定 Q8「直しても検証に落ちれば止める」
FailVerifyHard == rs \in {"apply", "decide2"} /\ Running /\ Block("verify_hard", FALSE, "none")

(* 依頼者の次の行動。DocActions は workflow-io.md §3・§5 と SKILL.md「中継」・決定 Q10 にある行動の閉集合:
   回答する（SKILL.md:102 needs_answers）・段から呼び直す（§5 agent が応答しない・budget・questionsDrift）・最初からやり直す
   （Q10 の next_args なし、SKILL.md:131 原因を直すまで再起動しない）・要求文書を先に直す（SKILL.md:124 upstream_gap）・
   prd-spec.js を直す（§5 script の欠陥）・返った next_args を変えずに渡す（§5 args の検査）。
   ObsSet は返り値の形（status・stop_reason・next_args・reason の接頭辞・例外の文）から文書が割り当てる行動の集合、
   Remedy は止めた原因を除く行動（実装の停止の文と決定から）。 *)
DocActions == {"answer", "rerun_stage", "restart", "fix_requirements", "fix_script", "fix_args"}
ScriptPrefix(c) == c = "script" \/ (c = "fixer_unknown" /\ OPT_FIXER = "q10")
ExActions(c) ==
  CASE c \in {"args_hash", "args_try"} -> {"fix_args"}
    [] c = "args_wmissing" -> {"restart"}
    [] c \in {"args_old", "args_fixedkeys"} -> (IF OPT_ARGS = "q10" THEN {"restart"} ELSE {"fix_args", "restart"})
    [] OTHER -> {}
ObsSet ==
  CASE status = "needs_answers" -> {"answer"}
    [] status = "exception" -> ExActions(cause)
    [] status = "blocked" /\ ScriptPrefix(cause) -> {"fix_script"}
    [] status = "blocked" /\ stopReason = "upstream_gap" -> {"fix_requirements"}
    [] status = "blocked" /\ hasNext -> {"rerun_stage"}
    [] status = "blocked" -> {"restart"}
    [] rs = "end" /\ cause = "digest" ->
         (CASE OPT_DIGEST = "restart" -> {"restart"}
            [] OPT_DIGEST = "existing" -> {"existing_rerun"}
            [] OTHER -> {})
    [] OTHER -> {}
Remedy(c) ==
  CASE c \in {"notrun", "budget", "verify_soft", "digest_rerun"} -> "rerun_stage"
    [] c \in {"script", "fixer_unknown"} -> "fix_script"
    [] c \in {"integrity", "finalhold", "unreadable", "doubt", "wlost", "verify_hard", "args_old", "args_fixedkeys", "args_wmissing"} -> "restart"
    [] c \in {"args_hash", "args_try"} -> "fix_args"
    [] c = "upstream" -> "fix_requirements"
    [] c = "answers" -> "answer"
    [] c = "digest" -> (CASE OPT_DIGEST = "restart" -> "restart"
                          [] OPT_DIGEST = "existing" -> "existing_rerun"
                          [] OTHER -> "re_audit")
    [] OTHER -> "none"
Returned == status \in {"needs_answers", "blocked", "exception"} \/ (rs = "end" /\ cause = "digest")
Terminal == Returned \/ rs \in {"end", "save_wait"}

(* 模型に入れていないもの: 事後報告は独立の状態にせず、保存の後の end と finalHold の report_path に含めた（読む性質が無いため）。
   段 3・3b・3v の裁定と検証の差し戻し、settle の巡回（MAX_SETTLE_ROUNDS）、段 2 の lint の差し戻しは、apply の MAX_CHECK_REWORK を代表にした。 *)
(* 性質（決定から） *)
Q1   == saved => (blk = 0 /\ docBlk = 0 /\ ~unchecked)
Q1nc == (saved /\ notChecked) => ncRecorded
Q3a  == gates <= MAX_GATES /\ pass <= MAX_AUDIT_PASSES /\ rework <= MAX_CHECK_REWORK
Q3b  == stops <= MAX_GATES
Q4   == ~unchecked
Q5   == saveWait => saveCond = "stop"
Q6   == gates > 0 => audited
Q7   == status = "needs_answers" => hasNext
Q7W  == (status \in {"needs_answers", "blocked"} /\ hasNext) => wExists
Q9   == /\ specOnly => gates = 0
        /\ (status = "blocked" /\ stopReason = "upstream_gap") => (audited /\ ~hasNext)
Q10  == Returned => (Cardinality(ObsSet) = 1 /\ ObsSet \subseteq DocActions /\ Remedy(cause) \in ObsSet)

(* 到達の確認（空振りの検出）: どれも破れる（到達できる）ことを期待する *)
ReachSaved == ~saved
ReachDone == status # "done"
ReachUpstream == stopReason # "upstream_gap"
ReachPassLimit == stopReason # "pass_limit"
ReachNoProgress == stopReason # "no_progress"
ReachGateMax == gates < MAX_GATES
ReachPassMax == pass < MAX_AUDIT_PASSES
ReachRedraft == ~(rs = "draft" /\ audited)
ReachException == status # "exception"
ReachVerifyHard == cause # "verify_hard"

(* 単体の駆動: 論点と継ぎ目は非決定的な引数として置く *)
RInternal ==
  \/ S0Go \/ S0Unreadable \/ S0DoubtEnd \/ S0DoubtDefer \/ S0DoubtPregate
  \/ \E p \in BOOLEAN : IntakeCarry(p)
  \/ IntakeAskNow \/ Draft
  \/ \E v \in {"proceed", "rerun", "zero"}, nc \in BOOLEAN : Audit(v, nc) \/ Reaudit(v, nc)
  \/ Decide \/ Decide2Ask \/ Decide2Upstream \/ Decide2Go
  \/ ApplyDone \/ ApplyRework \/ ApplyReworkLimit \/ ApplyFixerUnknown \/ Apply2Ask \/ Apply2Go
  \/ ReviseReaudit \/ ReviseReport \/ ReviseFinal \/ FinalHoldFail
  \/ JudgeReport \/ JudgeNoProgress \/ JudgeLimit \/ JudgeLoop
  \/ Report \/ \E m \in BOOLEAN : Save(m)
  \/ FailNotRun \/ FailScript \/ FailIntegrity \/ FailBudget \/ FailVerify \/ FailVerifyHard
REnv == ReqAnswer \/ ReqWLost \/ ReqBadArgs \/ ReqLoseNoCount \/ ReqLoseCountAsk \/ ReqLoseCountHold
        \/ Rerun \/ PluginUpdate \/ SaveApprove \/ SaveDecline
RDone == Terminal /\ UNCHANGED rvars
RNext == RInternal \/ REnv \/ RDone
RSpec == RInit /\ [][RNext]_rvars /\ WF_rvars(RInternal)
RTerm == (~Terminal) ~> Terminal
=============================================================================
