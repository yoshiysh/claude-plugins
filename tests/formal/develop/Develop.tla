------------------------------- MODULE Develop -------------------------------
(* The composition: the skill (DevelopSkill) and the environment
   (DevelopEnv) take turns on the input slot. The skill reads the call
   arguments as `args <- hist.args` and nothing else of the record; the
   environment sees the skill as `obs`. *)
EXTENDS Naturals, FiniteSets

CONSTANTS Skills, Claims, MaxFaults, MaxHuman, MaxHints, MaxRaise, MaxRet,
          FixLimit0, RebuildLimit0, WaitLimit, Items

VARIABLES sk, inbox, bud, hist

vars == <<sk, inbox, bud, hist>>

LOCAL INSTANCE DevelopCommon

S == INSTANCE DevelopSkill WITH args <- hist.args
Env == INSTANCE DevelopEnv WITH obs <- [st |-> sk.st, stage |-> sk.stage, kind |-> sk.kind]

Frozen == UNCHANGED <<hist, bud>>

(* One operator per skill action, so that TLC reports coverage per action. *)
I_PlanOkNoCheck == S!I_PlanOkNoCheck(inbox) /\ Frozen
I_PlanOkStop == S!I_PlanOkStop(inbox) /\ Frozen
I_PlanOkGo == S!I_PlanOkGo(inbox) /\ Frozen
I_PlanReject == S!I_PlanReject(inbox) /\ Frozen
I_PlanRejectLimit == S!I_PlanRejectLimit(inbox) /\ Frozen
I_PlanHuman == S!I_PlanHuman(inbox) /\ Frozen
I_Blocked == S!I_Blocked(inbox) /\ Frozen
I_Token == S!I_Token(inbox) /\ Frozen
I_HintRun == S!I_HintRun(inbox) /\ Frozen
I_BaselineOk == S!I_BaselineOk(inbox) /\ Frozen
I_Change == S!I_Change(inbox) /\ Frozen
I_NoChangeEnd == S!I_NoChangeEnd(inbox) /\ Frozen
I_NoChangeKeep == S!I_NoChangeKeep(inbox) /\ Frozen
I_OutOfPlan == S!I_OutOfPlan(inbox) /\ Frozen
I_OutOfPlanLimit == S!I_OutOfPlanLimit(inbox) /\ Frozen
I_CheckPass == S!I_CheckPass(inbox) /\ Frozen
I_CheckFail == S!I_CheckFail(inbox) /\ Frozen
I_Ret == S!I_Ret(inbox) /\ Frozen
I_ReviewRecall == S!I_ReviewRecall(inbox) /\ Frozen
I_ReviewStuck == S!I_ReviewStuck(inbox) /\ Frozen
I_DecideAbandon == S!I_DecideAbandon(inbox) /\ Frozen
I_DecideFix == S!I_DecideFix(inbox) /\ Frozen
I_DecideLimit == S!I_DecideLimit(inbox) /\ Frozen
I_DecideNext == S!I_DecideNext(inbox) /\ Frozen
I_FinalGate == S!I_FinalGate(inbox) /\ Frozen
I_FinalCommit == S!I_FinalCommit(inbox) /\ Frozen
I_FinalDone == S!I_FinalDone(inbox) /\ Frozen
I_CommitPush == S!I_CommitPush(inbox) /\ Frozen
I_CommitDone == S!I_CommitDone(inbox) /\ Frozen
I_PushOk == S!I_PushOk(inbox) /\ Frozen
I_Resume == S!I_Resume(inbox) /\ Frozen
I_ResumeWtChanged == S!I_ResumeWtChanged(inbox) /\ Frozen
I_RefuseResume == S!I_RefuseResume(inbox) /\ Frozen
I_EditWt == S!I_EditWt(inbox) /\ Frozen
I_RaiseFix == S!I_RaiseFix(inbox) /\ Frozen
I_RaisePlan == S!I_RaisePlan(inbox) /\ Frozen
I_Decide == S!I_Decide(inbox) /\ Frozen
I_Answer == S!I_Answer(inbox) /\ Frozen
I_TouchWt == S!I_TouchWt(inbox) /\ Frozen
I_Reinvoke == S!I_Reinvoke(inbox) /\ Frozen
I_HintStopped == S!I_HintStopped(inbox) /\ Frozen
I_HintRefused == S!I_HintRefused(inbox) /\ Frozen
R_PlanOk == S!R_PlanOk(inbox) /\ Frozen
R_ReadListBad == S!R_ReadListBad(inbox) /\ Frozen
R_Failed == S!R_Failed(inbox) /\ Frozen
R_ItemDone == S!R_ItemDone(inbox) /\ Frozen
R_LimitStop == S!R_LimitStop(inbox) /\ Frozen
R_FinishPost == S!R_FinishPost(inbox) /\ Frozen
R_FinishDone == S!R_FinishDone(inbox) /\ Frozen
R_PostDone == S!R_PostDone(inbox) /\ Frozen
R_PostFail == S!R_PostFail(inbox) /\ Frozen
R_PostConfirmed == S!R_PostConfirmed(inbox) /\ Frozen
R_PostMismatch == S!R_PostMismatch(inbox) /\ Frozen
R_Resume == S!R_Resume(inbox) /\ Frozen
R_RefuseResume == S!R_RefuseResume(inbox) /\ Frozen
R_Reinvoke == S!R_Reinvoke(inbox) /\ Frozen
R_BreakPin == S!R_BreakPin(inbox) /\ Frozen
A_RejectArgs == S!A_RejectArgs(inbox) /\ Frozen
A_EntryPR == S!A_EntryPR(inbox) /\ Frozen
A_EntryClean == S!A_EntryClean(inbox) /\ Frozen
A_EntryDirty == S!A_EntryDirty(inbox) /\ Frozen
A_Classified == S!A_Classified(inbox) /\ Frozen
A_NeedsDecision == S!A_NeedsDecision(inbox) /\ Frozen
A_ClassifyMismatch == S!A_ClassifyMismatch(inbox) /\ Frozen
A_ClassifyBlocked == S!A_ClassifyBlocked(inbox) /\ Frozen
A_ClassifyToken == S!A_ClassifyToken(inbox) /\ Frozen
A_RouteClassifyOnly == S!A_RouteClassifyOnly(inbox) /\ Frozen
A_RouteNoFixStop == S!A_RouteNoFixStop(inbox) /\ Frozen
A_RouteNoFixWait == S!A_RouteNoFixWait(inbox) /\ Frozen
A_RouteImpl == S!A_RouteImpl(inbox) /\ Frozen
A_RoutePushable == S!A_RoutePushable(inbox) /\ Frozen
A_RoutePushDenied == S!A_RoutePushDenied(inbox) /\ Frozen
A_ImplCommitted == S!A_ImplCommitted(inbox) /\ Frozen
A_ImplVerified == S!A_ImplVerified(inbox) /\ Frozen
A_ImplNoChangeStop == S!A_ImplNoChangeStop(inbox) /\ Frozen
A_ImplNoChangeWait == S!A_ImplNoChangeWait(inbox) /\ Frozen
A_ImplStopped == S!A_ImplStopped(inbox) /\ Frozen
A_PushOkDone == S!A_PushOkDone(inbox) /\ Frozen
A_PushOkWait == S!A_PushOkWait(inbox) /\ Frozen
A_PushRejected == S!A_PushRejected(inbox) /\ Frozen
A_CiPass == S!A_CiPass(inbox) /\ Frozen
A_CiStop == S!A_CiStop(inbox) /\ Frozen
A_CiRunning == S!A_CiRunning(inbox) /\ Frozen
A_CiWaitLimit == S!A_CiWaitLimit(inbox) /\ Frozen
A_ReplyPost == S!A_ReplyPost(inbox) /\ Frozen
A_ReplyStale == S!A_ReplyStale(inbox) /\ Frozen
A_ReplyConfirmedDone == S!A_ReplyConfirmedDone(inbox) /\ Frozen
A_ReplyConfirmedNext == S!A_ReplyConfirmedNext(inbox) /\ Frozen
A_CheckMismatch == S!A_CheckMismatch(inbox) /\ Frozen
A_ResolvePost == S!A_ResolvePost(inbox) /\ Frozen
A_ResolveConfirmed == S!A_ResolveConfirmed(inbox) /\ Frozen
A_Resume == S!A_Resume(inbox) /\ Frozen
A_ResumeHeadMoved == S!A_ResumeHeadMoved(inbox) /\ Frozen
A_RefuseResume == S!A_RefuseResume(inbox) /\ Frozen
A_Decide == S!A_Decide(inbox) /\ Frozen
A_PushByOther == S!A_PushByOther(inbox) /\ Frozen
A_Reinvoke == S!A_Reinvoke(inbox) /\ Frozen
H_Abort == S!H_Abort(inbox) /\ Frozen

SkillNext ==
  \/ I_PlanOkNoCheck
  \/ I_PlanOkStop
  \/ I_PlanOkGo
  \/ I_PlanReject
  \/ I_PlanRejectLimit
  \/ I_PlanHuman
  \/ I_Blocked
  \/ I_Token
  \/ I_HintRun
  \/ I_BaselineOk
  \/ I_Change
  \/ I_NoChangeEnd
  \/ I_NoChangeKeep
  \/ I_OutOfPlan
  \/ I_OutOfPlanLimit
  \/ I_CheckPass
  \/ I_CheckFail
  \/ I_Ret
  \/ I_ReviewRecall
  \/ I_ReviewStuck
  \/ I_DecideAbandon
  \/ I_DecideFix
  \/ I_DecideLimit
  \/ I_DecideNext
  \/ I_FinalGate
  \/ I_FinalCommit
  \/ I_FinalDone
  \/ I_CommitPush
  \/ I_CommitDone
  \/ I_PushOk
  \/ I_Resume
  \/ I_ResumeWtChanged
  \/ I_RefuseResume
  \/ I_EditWt
  \/ I_RaiseFix
  \/ I_RaisePlan
  \/ I_Decide
  \/ I_Answer
  \/ I_TouchWt
  \/ I_Reinvoke
  \/ I_HintStopped
  \/ I_HintRefused
  \/ R_PlanOk
  \/ R_ReadListBad
  \/ R_Failed
  \/ R_ItemDone
  \/ R_LimitStop
  \/ R_FinishPost
  \/ R_FinishDone
  \/ R_PostDone
  \/ R_PostFail
  \/ R_PostConfirmed
  \/ R_PostMismatch
  \/ R_Resume
  \/ R_RefuseResume
  \/ R_Reinvoke
  \/ R_BreakPin
  \/ A_RejectArgs
  \/ A_EntryPR
  \/ A_EntryClean
  \/ A_EntryDirty
  \/ A_Classified
  \/ A_NeedsDecision
  \/ A_ClassifyMismatch
  \/ A_ClassifyBlocked
  \/ A_ClassifyToken
  \/ A_RouteClassifyOnly
  \/ A_RouteNoFixStop
  \/ A_RouteNoFixWait
  \/ A_RouteImpl
  \/ A_RoutePushable
  \/ A_RoutePushDenied
  \/ A_ImplCommitted
  \/ A_ImplVerified
  \/ A_ImplNoChangeStop
  \/ A_ImplNoChangeWait
  \/ A_ImplStopped
  \/ A_PushOkDone
  \/ A_PushOkWait
  \/ A_PushRejected
  \/ A_CiPass
  \/ A_CiStop
  \/ A_CiRunning
  \/ A_CiWaitLimit
  \/ A_ReplyPost
  \/ A_ReplyStale
  \/ A_ReplyConfirmedDone
  \/ A_ReplyConfirmedNext
  \/ A_CheckMismatch
  \/ A_ResolvePost
  \/ A_ResolveConfirmed
  \/ A_Resume
  \/ A_ResumeHeadMoved
  \/ A_RefuseResume
  \/ A_Decide
  \/ A_PushByOther
  \/ A_Reinvoke
  \/ H_Abort

EnvInput == Env!Input /\ UNCHANGED sk

Terminated == sk.st \in {"done", "aborted"} /\ UNCHANGED vars

Init ==
  /\ inbox = NoEv
  /\ bud = [faults |-> 0, human |-> 0, hints |-> 0, raises |-> 0]
  /\ hist \in Env!HInitSet
  /\ sk = S!SkInit(hist.args)

Next == EnvInput \/ SkillNext \/ Terminated

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

Determinism == S!Determinism

\* (a) with TLC's deadlock check: from every stop some input the human can
\* give, other than abort, leads out of it (budgets aside).
NoDeadEnd ==
  (sk.st = "stopped" /\ inbox = NoEv) =>
    \E e \in Events : /\ e.n # "abort"
                      /\ Env!Alpha(e)
                      /\ S!Handles(e)
                      /\ S!Response(e).st # "stopped"

=============================================================================
