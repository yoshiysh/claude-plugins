----------------------------- MODULE DevelopSkill -----------------------------
(* develop:implement, develop:review and develop:address-review. The module
   declares only the skill state `sk`, the input slot `inbox` and the call
   arguments `args` (Develop substitutes hist.args), so the skill cannot name
   the environment's record; SANY rejects any such reference. *)
EXTENDS Naturals, FiniteSets

CONSTANTS Skills, Claims, MaxFaults, MaxHuman, MaxHints, MaxRaise, MaxRet,
          FixLimit0, RebuildLimit0, WaitLimit, Items

VARIABLES sk, inbox, args

LOCAL INSTANCE DevelopCommon

IInit == [unread |-> 0, fixRound |-> 0, fixLim |-> FixLimit0, rebuilds |-> 0,
          rebLim |-> RebuildLimit0, baseline |-> FALSE, planStopUsed |-> FALSE,
          rets |-> 0, last |-> NoRet, decisions |-> {}, checkFail |-> FALSE,
          wtChanged |-> FALSE, changed |-> FALSE, edited |-> FALSE,
          fromLimit |-> FALSE, planned |-> FALSE, recalled |-> FALSE]
RInit == [pending |-> 0, pinBroken |-> FALSE]
AInit == [hasFix |-> FALSE, waitCnt |-> 0, headMoved |-> FALSE]

SkInit(a) == [st |-> "running", stage |-> IF a.skill = "address" THEN "entry" ELSE "plan",
              kind |-> "none", res |-> "none", im |-> IInit, rv |-> RInit, ad |-> AInit]

I == args.skill = "implement"
R == args.skill = "review"
A == args.skill = "address"
Running == sk.st = "running"
Stopped == sk.st = "stopped"
im == sk.im
rv == sk.rv
ad == sk.ad

\* req: PR-DEVELOPIMPLEMENT-063, PR-DEVELOPIMPLEMENT-064
CountUnv(r) == r.unv \ {d.c : d \in {dd \in im.decisions : dd.r = r.id}}
\* req: PR-DEVELOPIMPLEMENT-063, PR-DEVELOPIMPLEMENT-027
CountConf(r) == r.conf \/ \E d \in im.decisions : d.r = r.id /\ d.v = "confirm"
HasRet == im.last.id > 0
\* req: PR-DEVELOPIMPLEMENT-029, PR-DEVELOPIMPLEMENT-019
\* decided: additional decision 4 (a check failure caused by the change is a fix target)
NeedFix == CountConf(im.last) \/ im.checkFail
\* req: PR-DEVELOPIMPLEMENT-057
FinalOk == HasRet /\ ~im.checkFail /\ ~CountConf(im.last) /\ CountUnv(im.last) = {}

ValidDec(e) == /\ e.x \cap e.y = {}
               /\ e.x \cup e.y # {}
               /\ e.x \cup e.y \subseteq CountUnv(im.last)

NeedsCommit == args.pr /\ args.stopAt \in {"none", "push", "reply", "resolve"}
WaitsChecks == args.pr /\ args.stopAt \in {"none", "reply", "resolve"}

Sys(gd, n) == gd /\ sk' = n /\ inbox' = NoEv

SI(s, g, k, o, m) == [sk EXCEPT !.st = s, !.stage = g, !.kind = k, !.res = o, !.im = m]
SR(s, g, k, o, r) == [sk EXCEPT !.st = s, !.stage = g, !.kind = k, !.res = o, !.rv = r]
SA(s, g, k, a) == [sk EXCEPT !.st = s, !.stage = g, !.kind = k, !.ad = a]

IRun(g, e, n) == I /\ Running /\ sk.stage = g /\ e.n = n
IStop(e, n) == I /\ Stopped /\ e.n = n

\* principle: sp-380c49d.md:184
IResumeStage == IF im.unread > 0 THEN "plan" ELSE sk.stage

(* --- develop:implement --- *)

\* req: PR-DEVELOPIMPLEMENT-010, PR-DEVELOPIMPLEMENT-068
I_PlanOkNoCheck_g(e) == IRun("plan", e, "planOk") /\ ~args.checkDecl
I_PlanOkNoCheck_n(e) == SI("stopped", "plan", "no_check", sk.res, [im EXCEPT !.unread = 0])
I_PlanOkNoCheck(e) == Sys(I_PlanOkNoCheck_g(e), I_PlanOkNoCheck_n(e))

\* req: PR-DEVELOPIMPLEMENT-012, PR-DEVELOPIMPLEMENT-066, PR-DEVELOPIMPLEMENT-068
I_PlanOkStop_g(e) == IRun("plan", e, "planOk") /\ args.checkDecl /\ args.planStop /\ ~im.planStopUsed
I_PlanOkStop_n(e) == SI("stopped", "baseline", "plan_stop", sk.res, [im EXCEPT !.unread = 0, !.planStopUsed = TRUE])
I_PlanOkStop(e) == Sys(I_PlanOkStop_g(e), I_PlanOkStop_n(e))

\* req: PR-DEVELOPIMPLEMENT-006, PR-DEVELOPIMPLEMENT-040, PR-DEVELOPIMPLEMENT-065, PR-DEVELOPIMPLEMENT-067, PR-DEVELOPIMPLEMENT-058, PR-DEVELOPIMPLEMENT-059, PR-DEVELOPIMPLEMENT-072
\* decided: D19 C and additional decision 2 (a plan rebuilt after resuming from the fix-round limit goes to check and review first)
I_PlanOkGo_g(e) == IRun("plan", e, "planOk") /\ args.checkDecl /\ ~(args.planStop /\ ~im.planStopUsed)
I_PlanOkGo_n(e) == SI("running",
                      CASE im.fromLimit -> "check"
                        [] im.baseline -> "impl"
                        [] OTHER -> "baseline",
                      "none", sk.res, [im EXCEPT !.unread = 0, !.fromLimit = FALSE, !.planned = im.fromLimit])
I_PlanOkGo(e) == Sys(I_PlanOkGo_g(e), I_PlanOkGo_n(e))

\* req: PR-DEVELOPIMPLEMENT-006
\* principle: sp-380c49d.md:179
I_PlanReject_g(e) == IRun("plan", e, "planReject") /\ im.rebuilds < im.rebLim
I_PlanReject_n(e) == SI("running", "plan", "none", sk.res, [im EXCEPT !.rebuilds = @ + 1, !.unread = 0])
I_PlanReject(e) == Sys(I_PlanReject_g(e), I_PlanReject_n(e))

\* req: PR-DEVELOPIMPLEMENT-007, PR-DEVELOPIMPLEMENT-068
\* principle: sp-380c49d.md:185
I_PlanRejectLimit_g(e) == IRun("plan", e, "planReject") /\ im.rebuilds >= im.rebLim
I_PlanRejectLimit_n(e) == SI("stopped", "plan", "limit_plan", sk.res, [im EXCEPT !.unread = 0])
I_PlanRejectLimit(e) == Sys(I_PlanRejectLimit_g(e), I_PlanRejectLimit_n(e))

\* req: PR-DEVELOPIMPLEMENT-008, PR-DEVELOPPLUGIN-037, PR-DEVELOPIMPLEMENT-068
I_PlanHuman_g(e) == IRun("plan", e, "planHuman")
I_PlanHuman_n(e) == SI("stopped", "plan", "needs_input", sk.res, im)
I_PlanHuman(e) == Sys(I_PlanHuman_g(e), I_PlanHuman_n(e))

\* req: PR-DEVELOPIMPLEMENT-009, PR-DEVELOPPLUGIN-033, PR-DEVELOPPLUGIN-040, PR-DEVELOPIMPLEMENT-025, PR-DEVELOPIMPLEMENT-056, PR-DEVELOPIMPLEMENT-031, PR-DEVELOPIMPLEMENT-050, PR-DEVELOPIMPLEMENT-068
I_Blocked_g(e) == I /\ Running /\ e.n \in {"agentFail", "write", "checkErr", "reviewFailed", "malformed", "finalFail", "pushRejected"}
I_Blocked_n(e) == SI("stopped", sk.stage, "blocked", sk.res, im)
I_Blocked(e) == Sys(I_Blocked_g(e), I_Blocked_n(e))

\* req: PR-DEVELOPPLUGIN-045, PR-DEVELOPIMPLEMENT-068
I_Token_g(e) == I /\ Running /\ e.n = "token"
I_Token_n(e) == SI("stopped", sk.stage, "limit_run", sk.res, im)
I_Token(e) == Sys(I_Token_g(e), I_Token_n(e))

\* req: PR-DEVELOPIMPLEMENT-039
I_HintRun_g(e) == I /\ Running /\ e.n = "hint"
I_HintRun_n(e) == SI("running", sk.stage, "none", sk.res, [im EXCEPT !.unread = @ + 1])
I_HintRun(e) == Sys(I_HintRun_g(e), I_HintRun_n(e))

\* req: PR-DEVELOPIMPLEMENT-016, PR-DEVELOPIMPLEMENT-013
I_BaselineOk_g(e) == IRun("baseline", e, "checkOk")
I_BaselineOk_n(e) == SI("running", "impl", "none", sk.res, [im EXCEPT !.baseline = TRUE])
I_BaselineOk(e) == Sys(I_BaselineOk_g(e), I_BaselineOk_n(e))

\* req: PR-DEVELOPIMPLEMENT-018
I_Change_g(e) == IRun("impl", e, "change")
I_Change_n(e) == SI("running", "check", "none", sk.res, [im EXCEPT !.changed = TRUE, !.planned = FALSE])
I_Change(e) == Sys(I_Change_g(e), I_Change_n(e))

\* req: PR-DEVELOPIMPLEMENT-044, PR-DEVELOPIMPLEMENT-061, PR-DEVELOPIMPLEMENT-070
\* decided: 1
I_NoChangeEnd_g(e) == IRun("impl", e, "noChange") /\ ~HasRet /\ ~im.changed /\ im.unread = 0
I_NoChangeEnd_n(e) == SI("done", sk.stage, "none", "nochange", [im EXCEPT !.planned = FALSE])
I_NoChangeEnd(e) == Sys(I_NoChangeEnd_g(e), I_NoChangeEnd_n(e))

\* req: PR-DEVELOPIMPLEMENT-057, PR-DEVELOPIMPLEMENT-073
\* decided: 1
I_NoChangeKeep_g(e) == IRun("impl", e, "noChange") /\ (HasRet \/ im.changed)
I_NoChangeKeep_n(e) == SI("running", "check", "none", sk.res, [im EXCEPT !.planned = FALSE])
I_NoChangeKeep(e) == Sys(I_NoChangeKeep_g(e), I_NoChangeKeep_n(e))

\* req: PR-DEVELOPIMPLEMENT-043, PR-DEVELOPIMPLEMENT-058, PR-DEVELOPIMPLEMENT-060
\* decided: 2 (the rebuild uses one fix round)
I_OutOfPlan_g(e) == IRun("impl", e, "outOfPlan") /\ im.fixRound < im.fixLim
I_OutOfPlan_n(e) == SI("running", "plan", "none", sk.res, [im EXCEPT !.fixRound = @ + 1, !.planned = FALSE])
I_OutOfPlan(e) == Sys(I_OutOfPlan_g(e), I_OutOfPlan_n(e))

\* req: PR-DEVELOPIMPLEMENT-060, PR-DEVELOPIMPLEMENT-021, PR-DEVELOPIMPLEMENT-055, PR-DEVELOPIMPLEMENT-068
\* decided: 2
I_OutOfPlanLimit_g(e) == IRun("impl", e, "outOfPlan") /\ im.fixRound >= im.fixLim
I_OutOfPlanLimit_n(e) == SI("stopped", "decide", "limit_fix", sk.res, [im EXCEPT !.planned = FALSE])
I_OutOfPlanLimit(e) == Sys(I_OutOfPlanLimit_g(e), I_OutOfPlanLimit_n(e))

\* req: PR-DEVELOPIMPLEMENT-019
I_CheckPass_g(e) == IRun("check", e, "checkPass")
I_CheckPass_n(e) == SI("running", "review", "none", sk.res, [im EXCEPT !.checkFail = FALSE])
I_CheckPass(e) == Sys(I_CheckPass_g(e), I_CheckPass_n(e))

\* req: PR-DEVELOPIMPLEMENT-019, PR-DEVELOPIMPLEMENT-029, PR-DEVELOPIMPLEMENT-074
I_CheckFail_g(e) == IRun("check", e, "checkFailChange")
I_CheckFail_n(e) == SI("running", "review", "none", sk.res, [im EXCEPT !.checkFail = TRUE])
I_CheckFail(e) == Sys(I_CheckFail_g(e), I_CheckFail_n(e))

\* req: PR-DEVELOPIMPLEMENT-023, PR-DEVELOPIMPLEMENT-025, PR-DEVELOPREVIEW-032, PR-DEVELOPREVIEW-069
I_Ret_g(e) == IRun("review", e, "ret")
I_Ret_n(e) == SI("running", "decide", "none", sk.res,
                 [im EXCEPT !.recalled = FALSE, !.rets = @ + 1, !.last = [id |-> im.rets + 1, conf |-> e.b, unv |-> e.x]])
I_Ret(e) == Sys(I_Ret_g(e), I_Ret_n(e))

\* req: PR-DEVELOPIMPLEMENT-024, PR-DEVELOPREVIEW-066
I_ReviewRecall_g(e) == I /\ Running /\ sk.stage = "review"
                       /\ (e.n = "reviewLimit" \/ (e.n = "reviewLimitSame" /\ ~im.recalled))
I_ReviewRecall_n(e) == SI("running", "review", "none", sk.res, [im EXCEPT !.recalled = TRUE])
I_ReviewRecall(e) == Sys(I_ReviewRecall_g(e), I_ReviewRecall_n(e))

\* req: PR-DEVELOPIMPLEMENT-024, PR-DEVELOPIMPLEMENT-075
\* decided: additional decision 4 (a recalled review that leaves as many items untouched stops)
I_ReviewStuck_g(e) == IRun("review", e, "reviewLimitSame") /\ im.recalled
I_ReviewStuck_n(e) == SI("stopped", "review", "blocked", sk.res, im)
I_ReviewStuck(e) == Sys(I_ReviewStuck_g(e), I_ReviewStuck_n(e))

\* req: PR-DEVELOPIMPLEMENT-028, PR-DEVELOPIMPLEMENT-029, PR-DEVELOPIMPLEMENT-046, PR-DEVELOPIMPLEMENT-047, PR-DEVELOPIMPLEMENT-048, PR-DEVELOPIMPLEMENT-062, PR-DEVELOPIMPLEMENT-068
I_DecideAbandon_g(e) == IRun("decide", e, "tick") /\ CountUnv(im.last) # {}
I_DecideAbandon_n(e) == SI("stopped", "decide", "abandon", sk.res, im)
I_DecideAbandon(e) == Sys(I_DecideAbandon_g(e), I_DecideAbandon_n(e))

\* req: PR-DEVELOPIMPLEMENT-029, PR-DEVELOPIMPLEMENT-027, PR-DEVELOPIMPLEMENT-019
I_DecideFix_g(e) == IRun("decide", e, "tick") /\ CountUnv(im.last) = {} /\ NeedFix /\ im.fixRound < im.fixLim
I_DecideFix_n(e) == SI("running", "impl", "none", sk.res, [im EXCEPT !.fixRound = @ + 1])
I_DecideFix(e) == Sys(I_DecideFix_g(e), I_DecideFix_n(e))

\* req: PR-DEVELOPIMPLEMENT-021, PR-DEVELOPIMPLEMENT-022, PR-DEVELOPIMPLEMENT-029, PR-DEVELOPIMPLEMENT-055, PR-DEVELOPIMPLEMENT-068, PR-DEVELOPIMPLEMENT-019
I_DecideLimit_g(e) == IRun("decide", e, "tick") /\ CountUnv(im.last) = {} /\ NeedFix /\ im.fixRound >= im.fixLim
I_DecideLimit_n(e) == SI("stopped", "decide", "limit_fix", sk.res, im)
I_DecideLimit(e) == Sys(I_DecideLimit_g(e), I_DecideLimit_n(e))

\* req: PR-DEVELOPIMPLEMENT-029, PR-DEVELOPIMPLEMENT-072
\* decided: D19 C and additional decision 2 (that plan is implemented even when 029 finds nothing)
I_DecideNext_g(e) == IRun("decide", e, "tick") /\ CountUnv(im.last) = {} /\ ~NeedFix
I_DecideNext_n(e) == SI("running", IF im.planned THEN "impl" ELSE "final", "none", sk.res, im)
I_DecideNext(e) == Sys(I_DecideNext_g(e), I_DecideNext_n(e))

\* req: PR-DEVELOPIMPLEMENT-071
\* decided: 7, additional decision 5 (every completion, the no-change one included)
I_FinalGate_g(e) == I /\ Running /\ im.unread > 0 /\
  (\/ sk.stage = "final" /\ e.n = "tick"
   \/ sk.stage = "impl" /\ e.n = "noChange" /\ ~HasRet /\ ~im.changed
   \/ sk.stage = "commit" /\ e.n = "commitOk" /\ ~args.pushDecl
   \/ sk.stage = "push" /\ e.n = "pushOk")
I_FinalGate_n(e) == SI("running", "plan", "none", sk.res, im)
I_FinalGate(e) == Sys(I_FinalGate_g(e), I_FinalGate_n(e))

\* req: PR-DEVELOPIMPLEMENT-057, PR-DEVELOPIMPLEMENT-033
I_FinalCommit_g(e) == IRun("final", e, "tick") /\ im.unread = 0 /\ FinalOk /\ args.commitReq
I_FinalCommit_n(e) == SI("running", "commit", "none", sk.res, im)
I_FinalCommit(e) == Sys(I_FinalCommit_g(e), I_FinalCommit_n(e))

\* req: PR-DEVELOPIMPLEMENT-057, PR-DEVELOPIMPLEMENT-033, PR-DEVELOPIMPLEMENT-035, PR-DEVELOPIMPLEMENT-070
I_FinalDone_g(e) == IRun("final", e, "tick") /\ im.unread = 0 /\ FinalOk /\ ~args.commitReq
I_FinalDone_n(e) == SI("done", sk.stage, "none", "verified", im)
I_FinalDone(e) == Sys(I_FinalDone_g(e), I_FinalDone_n(e))

\* req: PR-DEVELOPIMPLEMENT-034
I_CommitPush_g(e) == IRun("commit", e, "commitOk") /\ args.pushDecl
I_CommitPush_n(e) == SI("running", "push", "none", sk.res, im)
I_CommitPush(e) == Sys(I_CommitPush_g(e), I_CommitPush_n(e))

\* req: PR-DEVELOPIMPLEMENT-034, PR-DEVELOPIMPLEMENT-070
I_CommitDone_g(e) == IRun("commit", e, "commitOk") /\ ~args.pushDecl /\ im.unread = 0
I_CommitDone_n(e) == SI("done", sk.stage, "none", "committed", im)
I_CommitDone(e) == Sys(I_CommitDone_g(e), I_CommitDone_n(e))

\* req: PR-DEVELOPIMPLEMENT-034, PR-DEVELOPIMPLEMENT-070
I_PushOk_g(e) == IRun("push", e, "pushOk") /\ im.unread = 0
I_PushOk_n(e) == SI("done", sk.stage, "none", "committed", im)
I_PushOk(e) == Sys(I_PushOk_g(e), I_PushOk_n(e))

\* req: PR-DEVELOPIMPLEMENT-069, PR-DEVELOPIMPLEMENT-072
\* principle: sp-380c49d.md:183, sp-380c49d.md:184
\* decided: 4, 11, D19 C
I_Resume_g(e) == IStop(e, "resume") /\
  (\/ sk.kind \in {"blocked", "limit_run"}
   \/ sk.kind = "plan_stop" /\ ~im.wtChanged
   \/ sk.kind = "limit_fix" /\ im.edited
   \/ sk.kind \in {"abandon", "needs_input"} /\ im.unread > 0)
I_Resume_n(e) == SI("running", IResumeStage, "none", sk.res,
                    [im EXCEPT !.edited = FALSE, !.recalled = FALSE,
                               !.fromLimit = @ \/ (sk.kind = "limit_fix" /\ im.unread > 0)])
I_Resume(e) == Sys(I_Resume_g(e), I_Resume_n(e))

\* req: PR-DEVELOPIMPLEMENT-014, PR-DEVELOPIMPLEMENT-068, PR-DEVELOPIMPLEMENT-069
\* decided: 10
I_ResumeWtChanged_g(e) == IStop(e, "resume") /\ sk.kind = "plan_stop" /\ im.wtChanged
I_ResumeWtChanged_n(e) == SI("stopped", sk.stage, "wt_changed", sk.res, im)
I_ResumeWtChanged(e) == Sys(I_ResumeWtChanged_g(e), I_ResumeWtChanged_n(e))

\* req: PR-DEVELOPIMPLEMENT-069
\* principle: sp-380c49d.md:185
\* decided: 4
I_RefuseResume_g(e) == IStop(e, "resume") /\
  (\/ sk.kind \in {"limit_plan", "no_check", "wt_changed"}
   \/ sk.kind = "limit_fix" /\ ~im.edited
   \/ sk.kind \in {"abandon", "needs_input"} /\ im.unread = 0)
I_RefuseResume_n(e) == sk
I_RefuseResume(e) == Sys(I_RefuseResume_g(e), I_RefuseResume_n(e))

\* req: PR-DEVELOPIMPLEMENT-022, PR-DEVELOPIMPLEMENT-055, PR-DEVELOPIMPLEMENT-069
\* decided: 4, additional decision 2 (a resume after the edit starts at check and review; a raise alone resumes at 029)
I_EditWt_g(e) == IStop(e, "editWt") /\ sk.kind = "limit_fix"
I_EditWt_n(e) == SI("stopped", "check", sk.kind, sk.res, [im EXCEPT !.edited = TRUE])
I_EditWt(e) == Sys(I_EditWt_g(e), I_EditWt_n(e))

\* req: PR-DEVELOPIMPLEMENT-022, PR-DEVELOPIMPLEMENT-069, PR-DEVELOPIMPLEMENT-072
\* decided: 4, D19 C
I_RaiseFix_g(e) == IStop(e, "raise") /\ sk.kind = "limit_fix"
I_RaiseFix_n(e) == SI("running", IResumeStage, "none", sk.res,
                      [im EXCEPT !.fixLim = @ + 1, !.edited = FALSE, !.fromLimit = @ \/ (im.unread > 0)])
I_RaiseFix(e) == Sys(I_RaiseFix_g(e), I_RaiseFix_n(e))

\* req: PR-DEVELOPIMPLEMENT-007, PR-DEVELOPIMPLEMENT-069
\* principle: sp-380c49d.md:185
I_RaisePlan_g(e) == IStop(e, "raise") /\ sk.kind = "limit_plan"
I_RaisePlan_n(e) == SI("running", IResumeStage, "none", sk.res, [im EXCEPT !.rebLim = @ + 1])
I_RaisePlan(e) == Sys(I_RaisePlan_g(e), I_RaisePlan_n(e))

\* req: PR-DEVELOPIMPLEMENT-062, PR-DEVELOPIMPLEMENT-064, PR-DEVELOPIMPLEMENT-069
\* decided: 11
I_Decide_g(e) == IStop(e, "decide") /\ sk.kind = "abandon" /\ ValidDec(e)
I_Decide_n(e) == SI("running", IResumeStage, "none", sk.res,
                    [im EXCEPT !.decisions = @ \cup {[r |-> im.last.id, c |-> c, v |-> "confirm"] : c \in e.x}
                                                 \cup {[r |-> im.last.id, c |-> c, v |-> "reject"] : c \in e.y}])
I_Decide(e) == Sys(I_Decide_g(e), I_Decide_n(e))

\* req: PR-DEVELOPIMPLEMENT-052, PR-DEVELOPIMPLEMENT-069
I_Answer_g(e) == IStop(e, "answer") /\ sk.kind = "needs_input"
I_Answer_n(e) == SI("running", "plan", "none", sk.res, im)
I_Answer(e) == Sys(I_Answer_g(e), I_Answer_n(e))

\* req: PR-DEVELOPIMPLEMENT-014
I_TouchWt_g(e) == IStop(e, "touchWt") /\ sk.kind = "plan_stop"
I_TouchWt_n(e) == SI("stopped", sk.stage, sk.kind, sk.res, [im EXCEPT !.wtChanged = TRUE])
I_TouchWt(e) == Sys(I_TouchWt_g(e), I_TouchWt_n(e))

\* req: PR-DEVELOPIMPLEMENT-010, PR-DEVELOPIMPLEMENT-015, PR-DEVELOPPLUGIN-050, PR-DEVELOPIMPLEMENT-076
I_Reinvoke_g(e) == IStop(e, "reinvoke")
I_Reinvoke_n(e) == [sk EXCEPT !.st = "running", !.stage = "plan", !.kind = "none", !.im = IInit]
I_Reinvoke(e) == Sys(I_Reinvoke_g(e), I_Reinvoke_n(e))

\* req: PR-DEVELOPIMPLEMENT-039
OnlyNewCall == sk.kind \in {"no_check", "wt_changed"} \/ (sk.kind = "plan_stop" /\ im.wtChanged)

\* req: PR-DEVELOPIMPLEMENT-039, PR-DEVELOPIMPLEMENT-076
I_HintStopped_g(e) == IStop(e, "hint") /\ ~OnlyNewCall
I_HintStopped_n(e) == SI("stopped", sk.stage, sk.kind, sk.res, [im EXCEPT !.unread = @ + 1])
I_HintStopped(e) == Sys(I_HintStopped_g(e), I_HintStopped_n(e))

\* req: PR-DEVELOPIMPLEMENT-042, PR-DEVELOPIMPLEMENT-076
\* decided: 9
I_HintRefused_g(e) == IStop(e, "hint") /\ OnlyNewCall
I_HintRefused_n(e) == sk
I_HintRefused(e) == Sys(I_HintRefused_g(e), I_HintRefused_n(e))

(* --- develop:review --- *)

RRun(g) == R /\ Running /\ sk.stage = g

\* req: PR-DEVELOPREVIEW-001
R_PlanOk_g(e) == RRun("plan") /\ e.n = "planOk"
R_PlanOk_n(e) == SR("running", "items", "none", sk.res, [rv EXCEPT !.pending = Items, !.pinBroken = FALSE])
R_PlanOk(e) == Sys(R_PlanOk_g(e), R_PlanOk_n(e))

\* req: PR-DEVELOPREVIEW-015, PR-DEVELOPPLUGIN-032, PR-DEVELOPREVIEW-072
R_ReadListBad_g(e) == RRun("plan") /\ e.n = "readListBad"
R_ReadListBad_n(e) == SR("stopped", "plan", "read_list", sk.res, rv)
R_ReadListBad(e) == Sys(R_ReadListBad_g(e), R_ReadListBad_n(e))

\* req: PR-DEVELOPREVIEW-030, PR-DEVELOPREVIEW-034, PR-DEVELOPREVIEW-074
\* decided: 3
R_Failed_g(e) == \/ RRun("plan") /\ e.n = "write"
                 \/ RRun("items") /\ rv.pending > 0 /\ e.n \in {"write", "transportFail", "pinChanged"}
R_Failed_n(e) == SR("done", sk.stage, "none", "failed", rv)
R_Failed(e) == Sys(R_Failed_g(e), R_Failed_n(e))

\* req: PR-DEVELOPREVIEW-024, PR-DEVELOPREVIEW-028
R_ItemDone_g(e) == RRun("items") /\ rv.pending > 0 /\ e.n = "itemDone"
R_ItemDone_n(e) == SR("running", "items", "none", sk.res, [rv EXCEPT !.pending = @ - 1])
R_ItemDone(e) == Sys(R_ItemDone_g(e), R_ItemDone_n(e))

\* req: PR-DEVELOPREVIEW-037, PR-DEVELOPREVIEW-039, PR-DEVELOPREVIEW-041, PR-DEVELOPREVIEW-066, PR-DEVELOPPLUGIN-045, PR-DEVELOPREVIEW-072
R_LimitStop_g(e) == RRun("items") /\ rv.pending > 0 /\ e.n \in {"slotShort", "token"}
R_LimitStop_n(e) == SR("stopped", "items", "limit_run", sk.res, rv)
R_LimitStop(e) == Sys(R_LimitStop_g(e), R_LimitStop_n(e))

\* req: PR-DEVELOPREVIEW-030, PR-DEVELOPREVIEW-047
R_FinishPost_g(e) == RRun("items") /\ rv.pending = 0 /\ e.n \in {"finishClean", "finishPartial"} /\ args.postReq
R_FinishPost_n(e) == SR("running", "post", "none", IF e.n = "finishClean" THEN "success" ELSE "degraded", rv)
R_FinishPost(e) == Sys(R_FinishPost_g(e), R_FinishPost_n(e))

\* req: PR-DEVELOPREVIEW-030, PR-DEVELOPREVIEW-031, PR-DEVELOPREVIEW-032, PR-DEVELOPREVIEW-033, PR-DEVELOPREVIEW-069, PR-DEVELOPREVIEW-074
R_FinishDone_g(e) == RRun("items") /\ rv.pending = 0 /\ e.n \in {"finishClean", "finishPartial"} /\ ~args.postReq
R_FinishDone_n(e) == SR("done", sk.stage, "none", IF e.n = "finishClean" THEN "success" ELSE "degraded", rv)
R_FinishDone(e) == Sys(R_FinishDone_g(e), R_FinishDone_n(e))

\* req: PR-DEVELOPREVIEW-047, PR-DEVELOPREVIEW-075
R_PostDone_g(e) == RRun("post") /\ e.n = "postDone"
R_PostDone_n(e) == SR("running", "postCheck", "none", sk.res, rv)
R_PostDone(e) == Sys(R_PostDone_g(e), R_PostDone_n(e))

\* req: PR-DEVELOPREVIEW-067, PR-DEVELOPREVIEW-072
R_PostFail_g(e) == RRun("post") /\ e.n = "postFail"
R_PostFail_n(e) == SR("stopped", "post", "blocked", sk.res, rv)
R_PostFail(e) == Sys(R_PostFail_g(e), R_PostFail_n(e))

\* req: PR-DEVELOPREVIEW-050, PR-DEVELOPREVIEW-074
R_PostConfirmed_g(e) == RRun("postCheck") /\ e.n = "confirmOk"
R_PostConfirmed_n(e) == SR("done", sk.stage, "none", sk.res, rv)
R_PostConfirmed(e) == Sys(R_PostConfirmed_g(e), R_PostConfirmed_n(e))

\* req: PR-DEVELOPREVIEW-051, PR-DEVELOPREVIEW-072
\* principle: sp-380c49d.md:184
R_PostMismatch_g(e) == RRun("postCheck") /\ e.n = "postMismatch"
R_PostMismatch_n(e) == SR("stopped", "postCheck", "blocked", sk.res, rv)
R_PostMismatch(e) == Sys(R_PostMismatch_g(e), R_PostMismatch_n(e))

\* req: PR-DEVELOPREVIEW-073, PR-DEVELOPREVIEW-076
\* principle: sp-380c49d.md:184, sp-380c49d.md:185
R_Resume_g(e) == R /\ Stopped /\ e.n = "resume" /\ sk.kind # "read_list"
R_Resume_n(e) == SR("running", IF rv.pinBroken THEN "plan" ELSE sk.stage, "none", sk.res, rv)
R_Resume(e) == Sys(R_Resume_g(e), R_Resume_n(e))

\* req: PR-DEVELOPREVIEW-073, PR-DEVELOPREVIEW-015
R_RefuseResume_g(e) == R /\ Stopped /\ e.n = "resume" /\ sk.kind = "read_list"
R_RefuseResume_n(e) == sk
R_RefuseResume(e) == Sys(R_RefuseResume_g(e), R_RefuseResume_n(e))

\* req: PR-DEVELOPREVIEW-073, PR-DEVELOPREVIEW-015, PR-DEVELOPPLUGIN-050, PR-DEVELOPREVIEW-077
R_Reinvoke_g(e) == R /\ Stopped /\ e.n = "reinvoke"
R_Reinvoke_n(e) == [sk EXCEPT !.st = "running", !.stage = "plan", !.kind = "none", !.res = "none", !.rv = RInit]
R_Reinvoke(e) == Sys(R_Reinvoke_g(e), R_Reinvoke_n(e))

\* req: PR-DEVELOPREVIEW-043, PR-DEVELOPREVIEW-073, PR-DEVELOPREVIEW-077
R_BreakPin_g(e) == R /\ Stopped /\ e.n = "breakPin"
R_BreakPin_n(e) == SR("stopped", sk.stage, sk.kind, sk.res, [rv EXCEPT !.pinBroken = TRUE])
R_BreakPin(e) == Sys(R_BreakPin_g(e), R_BreakPin_n(e))

(* --- develop:address-review --- *)

ARun(g, e, n) == A /\ Running /\ sk.stage = g /\ e.n = n
AStop(e, n) == A /\ Stopped /\ e.n = n

\* req: PR-DEVELOPADDRESSREVIEW-021, PR-DEVELOPPLUGIN-032, PR-DEVELOPADDRESSREVIEW-058
A_RejectArgs_g(e) == ARun("entry", e, "tick") /\ ~args.pr /\ args.stopAt \in {"push", "reply", "resolve"}
A_RejectArgs_n(e) == SA("stopped", "entry", "reject_args", ad)
A_RejectArgs(e) == Sys(A_RejectArgs_g(e), A_RejectArgs_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-002
A_EntryPR_g(e) == ARun("entry", e, "tick") /\ args.pr
A_EntryPR_n(e) == SA("running", "classify", "none", ad)
A_EntryPR(e) == Sys(A_EntryPR_g(e), A_EntryPR_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-003, PR-DEVELOPADDRESSREVIEW-004
A_EntryClean_g(e) == ARun("entry", e, "clean") /\ ~args.pr
A_EntryClean_n(e) == SA("running", "classify", "none", ad)
A_EntryClean(e) == Sys(A_EntryClean_g(e), A_EntryClean_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-004, PR-DEVELOPADDRESSREVIEW-058
A_EntryDirty_g(e) == ARun("entry", e, "dirty")
A_EntryDirty_n(e) == SA("stopped", "entry", "refused", ad)
A_EntryDirty(e) == Sys(A_EntryDirty_g(e), A_EntryDirty_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-020
A_Classified_g(e) == A /\ Running /\ sk.stage = "classify" /\ e.n \in {"agreeFix", "agreeNoFix"}
A_Classified_n(e) == SA("running", "route", "none", [ad EXCEPT !.hasFix = (e.n = "agreeFix")])
A_Classified(e) == Sys(A_Classified_g(e), A_Classified_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-019, PR-DEVELOPPLUGIN-037, PR-DEVELOPADDRESSREVIEW-058
A_NeedsDecision_g(e) == ARun("classify", e, "agreeNeedsDec")
A_NeedsDecision_n(e) == SA("stopped", "route", "needs_input", ad)
A_NeedsDecision(e) == Sys(A_NeedsDecision_g(e), A_NeedsDecision_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-014, PR-DEVELOPADDRESSREVIEW-053, PR-DEVELOPADDRESSREVIEW-058
\* decided: 5
A_ClassifyMismatch_g(e) == A /\ Running /\ sk.stage = "classify" /\ e.n \in {"mismatch", "pathMismatch"}
A_ClassifyMismatch_n(e) == SA("stopped", "route", "mismatch", ad)
A_ClassifyMismatch(e) == Sys(A_ClassifyMismatch_g(e), A_ClassifyMismatch_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-015, PR-DEVELOPPLUGIN-040, PR-DEVELOPADDRESSREVIEW-058
A_ClassifyBlocked_g(e) == A /\ Running /\ sk.stage = "classify" /\ e.n \in {"write", "agentFail"}
A_ClassifyBlocked_n(e) == SA("stopped", "classify", "blocked", ad)
A_ClassifyBlocked(e) == Sys(A_ClassifyBlocked_g(e), A_ClassifyBlocked_n(e))

\* req: PR-DEVELOPPLUGIN-045, PR-DEVELOPADDRESSREVIEW-058
A_ClassifyToken_g(e) == ARun("classify", e, "token")
A_ClassifyToken_n(e) == SA("stopped", "classify", "limit_run", ad)
A_ClassifyToken(e) == Sys(A_ClassifyToken_g(e), A_ClassifyToken_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-021, PR-DEVELOPADDRESSREVIEW-056, PR-DEVELOPADDRESSREVIEW-060
A_RouteClassifyOnly_g(e) == ARun("route", e, "tick") /\ args.stopAt = "classify"
A_RouteClassifyOnly_n(e) == SA("done", sk.stage, "none", ad)
A_RouteClassifyOnly(e) == Sys(A_RouteClassifyOnly_g(e), A_RouteClassifyOnly_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-021, PR-DEVELOPADDRESSREVIEW-023, PR-DEVELOPADDRESSREVIEW-060
A_RouteNoFixStop_g(e) == ARun("route", e, "tick") /\ args.stopAt # "classify" /\ ~ad.hasFix /\ ~WaitsChecks
A_RouteNoFixStop_n(e) == SA("done", sk.stage, "none", ad)
A_RouteNoFixStop(e) == Sys(A_RouteNoFixStop_g(e), A_RouteNoFixStop_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-021, PR-DEVELOPADDRESSREVIEW-023, PR-DEVELOPADDRESSREVIEW-027, PR-DEVELOPADDRESSREVIEW-047
A_RouteNoFixWait_g(e) == ARun("route", e, "tick") /\ args.stopAt # "classify" /\ ~ad.hasFix /\ WaitsChecks
A_RouteNoFixWait_n(e) == SA("running", "wait", "none", ad)
A_RouteNoFixWait(e) == Sys(A_RouteNoFixWait_g(e), A_RouteNoFixWait_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-021
A_RouteImpl_g(e) == ARun("route", e, "tick") /\ args.stopAt # "classify" /\ ad.hasFix /\ ~NeedsCommit
A_RouteImpl_n(e) == SA("running", "implement", "none", ad)
A_RouteImpl(e) == Sys(A_RouteImpl_g(e), A_RouteImpl_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-010, PR-DEVELOPADDRESSREVIEW-021
A_RoutePushable_g(e) == ARun("route", e, "pushable") /\ args.stopAt # "classify" /\ ad.hasFix /\ NeedsCommit
A_RoutePushable_n(e) == SA("running", "implement", "none", ad)
A_RoutePushable(e) == Sys(A_RoutePushable_g(e), A_RoutePushable_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-011, PR-DEVELOPPLUGIN-038, PR-DEVELOPADDRESSREVIEW-058
\* decided: 8
A_RoutePushDenied_g(e) == ARun("route", e, "pushDenied")
A_RoutePushDenied_n(e) == SA("stopped", "route", "push_denied", ad)
A_RoutePushDenied(e) == Sys(A_RoutePushDenied_g(e), A_RoutePushDenied_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-049
A_ImplCommitted_g(e) == ARun("implement", e, "implCommitted") /\ NeedsCommit
A_ImplCommitted_n(e) == SA("running", "push", "none", ad)
A_ImplCommitted(e) == Sys(A_ImplCommitted_g(e), A_ImplCommitted_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-021, PR-DEVELOPADDRESSREVIEW-060
A_ImplVerified_g(e) == ARun("implement", e, "implVerified") /\ ~NeedsCommit
A_ImplVerified_n(e) == SA("done", sk.stage, "none", ad)
A_ImplVerified(e) == Sys(A_ImplVerified_g(e), A_ImplVerified_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-054, PR-DEVELOPADDRESSREVIEW-057, PR-DEVELOPADDRESSREVIEW-021, PR-DEVELOPADDRESSREVIEW-060
A_ImplNoChangeStop_g(e) == ARun("implement", e, "implNoChange") /\ ~WaitsChecks
A_ImplNoChangeStop_n(e) == SA("done", sk.stage, "none", ad)
A_ImplNoChangeStop(e) == Sys(A_ImplNoChangeStop_g(e), A_ImplNoChangeStop_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-054, PR-DEVELOPADDRESSREVIEW-027
A_ImplNoChangeWait_g(e) == ARun("implement", e, "implNoChange") /\ WaitsChecks
A_ImplNoChangeWait_n(e) == SA("running", "wait", "none", ad)
A_ImplNoChangeWait(e) == Sys(A_ImplNoChangeWait_g(e), A_ImplNoChangeWait_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-024, PR-DEVELOPADDRESSREVIEW-058
A_ImplStopped_g(e) == ARun("implement", e, "implStopped")
A_ImplStopped_n(e) == SA("stopped", "implement", "impl_stopped", ad)
A_ImplStopped(e) == Sys(A_ImplStopped_g(e), A_ImplStopped_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-025, PR-DEVELOPADDRESSREVIEW-021, PR-DEVELOPADDRESSREVIEW-056, PR-DEVELOPADDRESSREVIEW-060
A_PushOkDone_g(e) == ARun("push", e, "pushOk") /\ args.stopAt = "push"
A_PushOkDone_n(e) == SA("done", sk.stage, "none", ad)
A_PushOkDone(e) == Sys(A_PushOkDone_g(e), A_PushOkDone_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-025, PR-DEVELOPADDRESSREVIEW-027
A_PushOkWait_g(e) == ARun("push", e, "pushOk") /\ args.stopAt # "push"
A_PushOkWait_n(e) == SA("running", "wait", "none", ad)
A_PushOkWait(e) == Sys(A_PushOkWait_g(e), A_PushOkWait_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-052, PR-DEVELOPADDRESSREVIEW-058
A_PushRejected_g(e) == ARun("push", e, "pushRejected")
A_PushRejected_n(e) == SA("stopped", "push", "blocked", ad)
A_PushRejected(e) == Sys(A_PushRejected_g(e), A_PushRejected_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-029
A_CiPass_g(e) == A /\ Running /\ sk.stage = "wait" /\ e.n \in {"ciSuccess", "ciNone"}
A_CiPass_n(e) == SA("running", "reply", "none", ad)
A_CiPass(e) == Sys(A_CiPass_g(e), A_CiPass_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-029, PR-DEVELOPADDRESSREVIEW-030, PR-DEVELOPPLUGIN-033, PR-DEVELOPADDRESSREVIEW-058
A_CiStop_g(e) == A /\ Running /\ sk.stage = "wait" /\ e.n \in {"ciFailure", "ciUnreadable"}
A_CiStop_n(e) == SA("stopped", "wait", "blocked", ad)
A_CiStop(e) == Sys(A_CiStop_g(e), A_CiStop_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-029
A_CiRunning_g(e) == ARun("wait", e, "ciRunning") /\ ad.waitCnt < WaitLimit
A_CiRunning_n(e) == SA("running", "wait", "none", [ad EXCEPT !.waitCnt = @ + 1])
A_CiRunning(e) == Sys(A_CiRunning_g(e), A_CiRunning_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-029, PR-DEVELOPADDRESSREVIEW-058
\* principle: sp-380c49d.md:185
A_CiWaitLimit_g(e) == ARun("wait", e, "ciRunning") /\ ad.waitCnt >= WaitLimit
A_CiWaitLimit_n(e) == SA("stopped", "wait", "limit_run", ad)
A_CiWaitLimit(e) == Sys(A_CiWaitLimit_g(e), A_CiWaitLimit_n(e))

\* req: PR-DEVELOPPLUGIN-048
A_ReplyPost_g(e) == ARun("reply", e, "replyPost")
A_ReplyPost_n(e) == SA("running", "replyCheck", "none", ad)
A_ReplyPost(e) == Sys(A_ReplyPost_g(e), A_ReplyPost_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-036, PR-DEVELOPADDRESSREVIEW-050, PR-DEVELOPADDRESSREVIEW-058
A_ReplyStale_g(e) == ARun("reply", e, "headStale")
A_ReplyStale_n(e) == SA("stopped", "reply", "stale", ad)
A_ReplyStale(e) == Sys(A_ReplyStale_g(e), A_ReplyStale_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-021, PR-DEVELOPADDRESSREVIEW-056, PR-DEVELOPADDRESSREVIEW-060
A_ReplyConfirmedDone_g(e) == ARun("replyCheck", e, "confirmOk") /\ args.stopAt = "reply"
A_ReplyConfirmedDone_n(e) == SA("done", sk.stage, "none", ad)
A_ReplyConfirmedDone(e) == Sys(A_ReplyConfirmedDone_g(e), A_ReplyConfirmedDone_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-041
A_ReplyConfirmedNext_g(e) == ARun("replyCheck", e, "confirmOk") /\ args.stopAt # "reply"
A_ReplyConfirmedNext_n(e) == SA("running", "resolve", "none", ad)
A_ReplyConfirmedNext(e) == Sys(A_ReplyConfirmedNext_g(e), A_ReplyConfirmedNext_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-040, PR-DEVELOPADDRESSREVIEW-044, PR-DEVELOPADDRESSREVIEW-058
A_CheckMismatch_g(e) == A /\ Running /\ sk.stage \in {"replyCheck", "resolveCheck"} /\ e.n = "confirmMismatch"
A_CheckMismatch_n(e) == SA("stopped", sk.stage, "blocked", ad)
A_CheckMismatch(e) == Sys(A_CheckMismatch_g(e), A_CheckMismatch_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-041, PR-DEVELOPADDRESSREVIEW-042
A_ResolvePost_g(e) == ARun("resolve", e, "resolvePost")
A_ResolvePost_n(e) == SA("running", "resolveCheck", "none", ad)
A_ResolvePost(e) == Sys(A_ResolvePost_g(e), A_ResolvePost_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-046, PR-DEVELOPADDRESSREVIEW-060
A_ResolveConfirmed_g(e) == ARun("resolveCheck", e, "confirmOk")
A_ResolveConfirmed_n(e) == SA("done", sk.stage, "none", ad)
A_ResolveConfirmed(e) == Sys(A_ResolveConfirmed_g(e), A_ResolveConfirmed_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-031, PR-DEVELOPADDRESSREVIEW-033, PR-DEVELOPADDRESSREVIEW-059
\* principle: sp-380c49d.md:184, sp-380c49d.md:185 (the wait count starts from 0 in every resumed run)
\* decided: 8
A_Resume_g(e) == AStop(e, "resume") /\
  (\/ sk.kind \in {"blocked", "impl_stopped", "push_denied"}
   \/ sk.kind = "limit_run" /\ ~(sk.stage = "wait" /\ ad.headMoved))
A_Resume_n(e) == SA("running", sk.stage, "none", [ad EXCEPT !.waitCnt = 0])
A_Resume(e) == Sys(A_Resume_g(e), A_Resume_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-032, PR-DEVELOPADDRESSREVIEW-058, PR-DEVELOPADDRESSREVIEW-059
A_ResumeHeadMoved_g(e) == AStop(e, "resume") /\ sk.kind = "limit_run" /\ sk.stage = "wait" /\ ad.headMoved
A_ResumeHeadMoved_n(e) == SA("stopped", sk.stage, "head_moved", ad)
A_ResumeHeadMoved(e) == Sys(A_ResumeHeadMoved_g(e), A_ResumeHeadMoved_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-019, PR-DEVELOPADDRESSREVIEW-048, PR-DEVELOPADDRESSREVIEW-021, PR-DEVELOPADDRESSREVIEW-004, PR-DEVELOPADDRESSREVIEW-059
\* decided: 5
A_RefuseResume_g(e) == AStop(e, "resume") /\ sk.kind \in {"needs_input", "mismatch", "refused", "reject_args", "stale", "head_moved"}
A_RefuseResume_n(e) == sk
A_RefuseResume(e) == Sys(A_RefuseResume_g(e), A_RefuseResume_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-019, PR-DEVELOPADDRESSREVIEW-048, PR-DEVELOPADDRESSREVIEW-059, PR-DEVELOPADDRESSREVIEW-061, PR-DEVELOPADDRESSREVIEW-062
\* decided: 5, 6
A_Decide_g(e) == A /\ Stopped /\ sk.kind \in {"needs_input", "mismatch"} /\ e.n \in {"decideFix", "decideDecline", "decideOos"}
A_Decide_n(e) == SA("running", sk.stage, "none", [ad EXCEPT !.hasFix = (e.n = "decideFix")])
A_Decide(e) == Sys(A_Decide_g(e), A_Decide_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-032
A_PushByOther_g(e) == AStop(e, "pushByOther") /\ sk.kind = "limit_run" /\ sk.stage = "wait"
A_PushByOther_n(e) == SA("stopped", sk.stage, sk.kind, [ad EXCEPT !.headMoved = TRUE])
A_PushByOther(e) == Sys(A_PushByOther_g(e), A_PushByOther_n(e))

\* req: PR-DEVELOPADDRESSREVIEW-004, PR-DEVELOPADDRESSREVIEW-036, PR-DEVELOPADDRESSREVIEW-050, PR-DEVELOPADDRESSREVIEW-021, PR-DEVELOPADDRESSREVIEW-065
\* decided: 8 (b)
A_Reinvoke_g(e) == AStop(e, "reinvoke")
A_Reinvoke_n(e) == [sk EXCEPT !.st = "running", !.stage = "entry", !.kind = "none", !.ad = AInit]
A_Reinvoke(e) == Sys(A_Reinvoke_g(e), A_Reinvoke_n(e))

(* --- shared --- *)

\* req: PR-DEVELOPPLUGIN-032, PR-DEVELOPIMPLEMENT-076, PR-DEVELOPREVIEW-077, PR-DEVELOPADDRESSREVIEW-065
H_Abort_g(e) == Stopped /\ e.n = "abort"
H_Abort_n(e) == [sk EXCEPT !.st = "aborted"]
H_Abort(e) == Sys(H_Abort_g(e), H_Abort_n(e))

-----------------------------------------------------------------------------
(* The table that Determinism reads. Develop lists the actions again as the
   disjuncts of Next, only so that TLC reports coverage per action; a step
   that is not the table's unique response breaks Determinism, and a table
   entry missing from Next deadlocks where it is the only response. *)

IActs == {"I_PlanOkNoCheck", "I_PlanOkStop", "I_PlanOkGo", "I_PlanReject",
  "I_PlanRejectLimit", "I_PlanHuman", "I_Blocked", "I_Token", "I_HintRun",
  "I_BaselineOk", "I_Change", "I_NoChangeEnd", "I_NoChangeKeep", "I_OutOfPlan",
  "I_OutOfPlanLimit", "I_CheckPass", "I_CheckFail", "I_Ret", "I_ReviewRecall", "I_ReviewStuck",
  "I_DecideAbandon", "I_DecideFix", "I_DecideLimit", "I_DecideNext", "I_FinalGate",
  "I_FinalCommit", "I_FinalDone", "I_CommitPush", "I_CommitDone",
  "I_PushOk", "I_Resume", "I_ResumeWtChanged", "I_RefuseResume", "I_EditWt",
  "I_RaiseFix", "I_RaisePlan", "I_Decide", "I_Answer", "I_TouchWt", "I_Reinvoke",
  "I_HintStopped", "I_HintRefused", "H_Abort"}
RActs == {"R_PlanOk", "R_ReadListBad", "R_Failed", "R_ItemDone", "R_LimitStop",
  "R_FinishPost", "R_FinishDone", "R_PostDone", "R_PostFail", "R_PostConfirmed",
  "R_PostMismatch", "R_Resume", "R_RefuseResume", "R_Reinvoke", "R_BreakPin", "H_Abort"}
AActs == {"A_RejectArgs", "A_EntryPR", "A_EntryClean", "A_EntryDirty",
  "A_Classified", "A_NeedsDecision", "A_ClassifyMismatch", "A_ClassifyBlocked",
  "A_ClassifyToken", "A_RouteClassifyOnly", "A_RouteNoFixStop",
  "A_RouteNoFixWait", "A_RouteImpl", "A_RoutePushable", "A_RoutePushDenied",
  "A_ImplCommitted", "A_ImplVerified", "A_ImplNoChangeStop", "A_ImplNoChangeWait",
  "A_ImplStopped", "A_PushOkDone", "A_PushOkWait", "A_PushRejected", "A_CiPass",
  "A_CiStop", "A_CiRunning", "A_CiWaitLimit", "A_ReplyPost", "A_ReplyStale",
  "A_ReplyConfirmedDone", "A_ReplyConfirmedNext", "A_CheckMismatch",
  "A_ResolvePost", "A_ResolveConfirmed", "A_Resume", "A_ResumeHeadMoved",
  "A_RefuseResume", "A_Decide", "A_PushByOther", "A_Reinvoke", "H_Abort"}

AllActs == IActs \cup RActs \cup AActs
ActsOf == CASE I -> IActs [] R -> RActs [] OTHER -> AActs

G(a, e) ==
  CASE a = "I_PlanOkNoCheck" -> I_PlanOkNoCheck_g(e)
    [] a = "I_PlanOkStop" -> I_PlanOkStop_g(e)
    [] a = "I_PlanOkGo" -> I_PlanOkGo_g(e)
    [] a = "I_PlanReject" -> I_PlanReject_g(e)
    [] a = "I_PlanRejectLimit" -> I_PlanRejectLimit_g(e)
    [] a = "I_PlanHuman" -> I_PlanHuman_g(e)
    [] a = "I_Blocked" -> I_Blocked_g(e)
    [] a = "I_Token" -> I_Token_g(e)
    [] a = "I_HintRun" -> I_HintRun_g(e)
    [] a = "I_BaselineOk" -> I_BaselineOk_g(e)
    [] a = "I_Change" -> I_Change_g(e)
    [] a = "I_NoChangeEnd" -> I_NoChangeEnd_g(e)
    [] a = "I_NoChangeKeep" -> I_NoChangeKeep_g(e)
    [] a = "I_OutOfPlan" -> I_OutOfPlan_g(e)
    [] a = "I_OutOfPlanLimit" -> I_OutOfPlanLimit_g(e)
    [] a = "I_CheckPass" -> I_CheckPass_g(e)
    [] a = "I_CheckFail" -> I_CheckFail_g(e)
    [] a = "I_Ret" -> I_Ret_g(e)
    [] a = "I_ReviewRecall" -> I_ReviewRecall_g(e)
    [] a = "I_ReviewStuck" -> I_ReviewStuck_g(e)
    [] a = "I_DecideAbandon" -> I_DecideAbandon_g(e)
    [] a = "I_DecideFix" -> I_DecideFix_g(e)
    [] a = "I_DecideLimit" -> I_DecideLimit_g(e)
    [] a = "I_DecideNext" -> I_DecideNext_g(e)
    [] a = "I_FinalGate" -> I_FinalGate_g(e)
    [] a = "I_FinalCommit" -> I_FinalCommit_g(e)
    [] a = "I_FinalDone" -> I_FinalDone_g(e)
    [] a = "I_CommitPush" -> I_CommitPush_g(e)
    [] a = "I_CommitDone" -> I_CommitDone_g(e)
    [] a = "I_PushOk" -> I_PushOk_g(e)
    [] a = "I_Resume" -> I_Resume_g(e)
    [] a = "I_ResumeWtChanged" -> I_ResumeWtChanged_g(e)
    [] a = "I_RefuseResume" -> I_RefuseResume_g(e)
    [] a = "I_EditWt" -> I_EditWt_g(e)
    [] a = "I_RaiseFix" -> I_RaiseFix_g(e)
    [] a = "I_RaisePlan" -> I_RaisePlan_g(e)
    [] a = "I_Decide" -> I_Decide_g(e)
    [] a = "I_Answer" -> I_Answer_g(e)
    [] a = "I_TouchWt" -> I_TouchWt_g(e)
    [] a = "I_Reinvoke" -> I_Reinvoke_g(e)
    [] a = "I_HintStopped" -> I_HintStopped_g(e)
    [] a = "I_HintRefused" -> I_HintRefused_g(e)
    [] a = "R_PlanOk" -> R_PlanOk_g(e)
    [] a = "R_ReadListBad" -> R_ReadListBad_g(e)
    [] a = "R_Failed" -> R_Failed_g(e)
    [] a = "R_ItemDone" -> R_ItemDone_g(e)
    [] a = "R_LimitStop" -> R_LimitStop_g(e)
    [] a = "R_FinishPost" -> R_FinishPost_g(e)
    [] a = "R_FinishDone" -> R_FinishDone_g(e)
    [] a = "R_PostDone" -> R_PostDone_g(e)
    [] a = "R_PostFail" -> R_PostFail_g(e)
    [] a = "R_PostConfirmed" -> R_PostConfirmed_g(e)
    [] a = "R_PostMismatch" -> R_PostMismatch_g(e)
    [] a = "R_Resume" -> R_Resume_g(e)
    [] a = "R_RefuseResume" -> R_RefuseResume_g(e)
    [] a = "R_Reinvoke" -> R_Reinvoke_g(e)
    [] a = "R_BreakPin" -> R_BreakPin_g(e)
    [] a = "A_RejectArgs" -> A_RejectArgs_g(e)
    [] a = "A_EntryPR" -> A_EntryPR_g(e)
    [] a = "A_EntryClean" -> A_EntryClean_g(e)
    [] a = "A_EntryDirty" -> A_EntryDirty_g(e)
    [] a = "A_Classified" -> A_Classified_g(e)
    [] a = "A_NeedsDecision" -> A_NeedsDecision_g(e)
    [] a = "A_ClassifyMismatch" -> A_ClassifyMismatch_g(e)
    [] a = "A_ClassifyBlocked" -> A_ClassifyBlocked_g(e)
    [] a = "A_ClassifyToken" -> A_ClassifyToken_g(e)
    [] a = "A_RouteClassifyOnly" -> A_RouteClassifyOnly_g(e)
    [] a = "A_RouteNoFixStop" -> A_RouteNoFixStop_g(e)
    [] a = "A_RouteNoFixWait" -> A_RouteNoFixWait_g(e)
    [] a = "A_RouteImpl" -> A_RouteImpl_g(e)
    [] a = "A_RoutePushable" -> A_RoutePushable_g(e)
    [] a = "A_RoutePushDenied" -> A_RoutePushDenied_g(e)
    [] a = "A_ImplCommitted" -> A_ImplCommitted_g(e)
    [] a = "A_ImplVerified" -> A_ImplVerified_g(e)
    [] a = "A_ImplNoChangeStop" -> A_ImplNoChangeStop_g(e)
    [] a = "A_ImplNoChangeWait" -> A_ImplNoChangeWait_g(e)
    [] a = "A_ImplStopped" -> A_ImplStopped_g(e)
    [] a = "A_PushOkDone" -> A_PushOkDone_g(e)
    [] a = "A_PushOkWait" -> A_PushOkWait_g(e)
    [] a = "A_PushRejected" -> A_PushRejected_g(e)
    [] a = "A_CiPass" -> A_CiPass_g(e)
    [] a = "A_CiStop" -> A_CiStop_g(e)
    [] a = "A_CiRunning" -> A_CiRunning_g(e)
    [] a = "A_CiWaitLimit" -> A_CiWaitLimit_g(e)
    [] a = "A_ReplyPost" -> A_ReplyPost_g(e)
    [] a = "A_ReplyStale" -> A_ReplyStale_g(e)
    [] a = "A_ReplyConfirmedDone" -> A_ReplyConfirmedDone_g(e)
    [] a = "A_ReplyConfirmedNext" -> A_ReplyConfirmedNext_g(e)
    [] a = "A_CheckMismatch" -> A_CheckMismatch_g(e)
    [] a = "A_ResolvePost" -> A_ResolvePost_g(e)
    [] a = "A_ResolveConfirmed" -> A_ResolveConfirmed_g(e)
    [] a = "A_Resume" -> A_Resume_g(e)
    [] a = "A_ResumeHeadMoved" -> A_ResumeHeadMoved_g(e)
    [] a = "A_RefuseResume" -> A_RefuseResume_g(e)
    [] a = "A_Decide" -> A_Decide_g(e)
    [] a = "A_PushByOther" -> A_PushByOther_g(e)
    [] a = "A_Reinvoke" -> A_Reinvoke_g(e)
    [] a = "H_Abort" -> H_Abort_g(e)

N(a, e) ==
  CASE a = "I_PlanOkNoCheck" -> I_PlanOkNoCheck_n(e)
    [] a = "I_PlanOkStop" -> I_PlanOkStop_n(e)
    [] a = "I_PlanOkGo" -> I_PlanOkGo_n(e)
    [] a = "I_PlanReject" -> I_PlanReject_n(e)
    [] a = "I_PlanRejectLimit" -> I_PlanRejectLimit_n(e)
    [] a = "I_PlanHuman" -> I_PlanHuman_n(e)
    [] a = "I_Blocked" -> I_Blocked_n(e)
    [] a = "I_Token" -> I_Token_n(e)
    [] a = "I_HintRun" -> I_HintRun_n(e)
    [] a = "I_BaselineOk" -> I_BaselineOk_n(e)
    [] a = "I_Change" -> I_Change_n(e)
    [] a = "I_NoChangeEnd" -> I_NoChangeEnd_n(e)
    [] a = "I_NoChangeKeep" -> I_NoChangeKeep_n(e)
    [] a = "I_OutOfPlan" -> I_OutOfPlan_n(e)
    [] a = "I_OutOfPlanLimit" -> I_OutOfPlanLimit_n(e)
    [] a = "I_CheckPass" -> I_CheckPass_n(e)
    [] a = "I_CheckFail" -> I_CheckFail_n(e)
    [] a = "I_Ret" -> I_Ret_n(e)
    [] a = "I_ReviewRecall" -> I_ReviewRecall_n(e)
    [] a = "I_ReviewStuck" -> I_ReviewStuck_n(e)
    [] a = "I_DecideAbandon" -> I_DecideAbandon_n(e)
    [] a = "I_DecideFix" -> I_DecideFix_n(e)
    [] a = "I_DecideLimit" -> I_DecideLimit_n(e)
    [] a = "I_DecideNext" -> I_DecideNext_n(e)
    [] a = "I_FinalGate" -> I_FinalGate_n(e)
    [] a = "I_FinalCommit" -> I_FinalCommit_n(e)
    [] a = "I_FinalDone" -> I_FinalDone_n(e)
    [] a = "I_CommitPush" -> I_CommitPush_n(e)
    [] a = "I_CommitDone" -> I_CommitDone_n(e)
    [] a = "I_PushOk" -> I_PushOk_n(e)
    [] a = "I_Resume" -> I_Resume_n(e)
    [] a = "I_ResumeWtChanged" -> I_ResumeWtChanged_n(e)
    [] a = "I_RefuseResume" -> I_RefuseResume_n(e)
    [] a = "I_EditWt" -> I_EditWt_n(e)
    [] a = "I_RaiseFix" -> I_RaiseFix_n(e)
    [] a = "I_RaisePlan" -> I_RaisePlan_n(e)
    [] a = "I_Decide" -> I_Decide_n(e)
    [] a = "I_Answer" -> I_Answer_n(e)
    [] a = "I_TouchWt" -> I_TouchWt_n(e)
    [] a = "I_Reinvoke" -> I_Reinvoke_n(e)
    [] a = "I_HintStopped" -> I_HintStopped_n(e)
    [] a = "I_HintRefused" -> I_HintRefused_n(e)
    [] a = "R_PlanOk" -> R_PlanOk_n(e)
    [] a = "R_ReadListBad" -> R_ReadListBad_n(e)
    [] a = "R_Failed" -> R_Failed_n(e)
    [] a = "R_ItemDone" -> R_ItemDone_n(e)
    [] a = "R_LimitStop" -> R_LimitStop_n(e)
    [] a = "R_FinishPost" -> R_FinishPost_n(e)
    [] a = "R_FinishDone" -> R_FinishDone_n(e)
    [] a = "R_PostDone" -> R_PostDone_n(e)
    [] a = "R_PostFail" -> R_PostFail_n(e)
    [] a = "R_PostConfirmed" -> R_PostConfirmed_n(e)
    [] a = "R_PostMismatch" -> R_PostMismatch_n(e)
    [] a = "R_Resume" -> R_Resume_n(e)
    [] a = "R_RefuseResume" -> R_RefuseResume_n(e)
    [] a = "R_Reinvoke" -> R_Reinvoke_n(e)
    [] a = "R_BreakPin" -> R_BreakPin_n(e)
    [] a = "A_RejectArgs" -> A_RejectArgs_n(e)
    [] a = "A_EntryPR" -> A_EntryPR_n(e)
    [] a = "A_EntryClean" -> A_EntryClean_n(e)
    [] a = "A_EntryDirty" -> A_EntryDirty_n(e)
    [] a = "A_Classified" -> A_Classified_n(e)
    [] a = "A_NeedsDecision" -> A_NeedsDecision_n(e)
    [] a = "A_ClassifyMismatch" -> A_ClassifyMismatch_n(e)
    [] a = "A_ClassifyBlocked" -> A_ClassifyBlocked_n(e)
    [] a = "A_ClassifyToken" -> A_ClassifyToken_n(e)
    [] a = "A_RouteClassifyOnly" -> A_RouteClassifyOnly_n(e)
    [] a = "A_RouteNoFixStop" -> A_RouteNoFixStop_n(e)
    [] a = "A_RouteNoFixWait" -> A_RouteNoFixWait_n(e)
    [] a = "A_RouteImpl" -> A_RouteImpl_n(e)
    [] a = "A_RoutePushable" -> A_RoutePushable_n(e)
    [] a = "A_RoutePushDenied" -> A_RoutePushDenied_n(e)
    [] a = "A_ImplCommitted" -> A_ImplCommitted_n(e)
    [] a = "A_ImplVerified" -> A_ImplVerified_n(e)
    [] a = "A_ImplNoChangeStop" -> A_ImplNoChangeStop_n(e)
    [] a = "A_ImplNoChangeWait" -> A_ImplNoChangeWait_n(e)
    [] a = "A_ImplStopped" -> A_ImplStopped_n(e)
    [] a = "A_PushOkDone" -> A_PushOkDone_n(e)
    [] a = "A_PushOkWait" -> A_PushOkWait_n(e)
    [] a = "A_PushRejected" -> A_PushRejected_n(e)
    [] a = "A_CiPass" -> A_CiPass_n(e)
    [] a = "A_CiStop" -> A_CiStop_n(e)
    [] a = "A_CiRunning" -> A_CiRunning_n(e)
    [] a = "A_CiWaitLimit" -> A_CiWaitLimit_n(e)
    [] a = "A_ReplyPost" -> A_ReplyPost_n(e)
    [] a = "A_ReplyStale" -> A_ReplyStale_n(e)
    [] a = "A_ReplyConfirmedDone" -> A_ReplyConfirmedDone_n(e)
    [] a = "A_ReplyConfirmedNext" -> A_ReplyConfirmedNext_n(e)
    [] a = "A_CheckMismatch" -> A_CheckMismatch_n(e)
    [] a = "A_ResolvePost" -> A_ResolvePost_n(e)
    [] a = "A_ResolveConfirmed" -> A_ResolveConfirmed_n(e)
    [] a = "A_Resume" -> A_Resume_n(e)
    [] a = "A_ResumeHeadMoved" -> A_ResumeHeadMoved_n(e)
    [] a = "A_RefuseResume" -> A_RefuseResume_n(e)
    [] a = "A_Decide" -> A_Decide_n(e)
    [] a = "A_PushByOther" -> A_PushByOther_n(e)
    [] a = "A_Reinvoke" -> A_Reinvoke_n(e)
    [] a = "H_Abort" -> H_Abort_n(e)

Enabled(e) == {a \in ActsOf : G(a, e)}

\* (b) Every step of the skill, including one taken with no input waiting,
\* is the unique response of the table to the waiting input.
Determinism ==
  [][(sk' # sk \/ (inbox # NoEv /\ inbox' = NoEv)) =>
       /\ Cardinality(Enabled(inbox)) = 1
       /\ \A a \in Enabled(inbox) : sk' = N(a, inbox)]_<<sk, inbox>>

\* The skill's response to an input, for the dead-end check in Develop.
Response(e) == N(CHOOSE a \in Enabled(e) : TRUE, e)
Handles(e) == Enabled(e) # {}

=============================================================================
