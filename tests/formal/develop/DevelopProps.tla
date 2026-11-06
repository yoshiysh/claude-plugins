---------------------------- MODULE DevelopProps ----------------------------
(* The yardstick. It declares the environment's record and input, and `out`,
   what the skill returns ([st, stage, kind, res]). It extends no module that
   declares a variable and cannot name the skill's state; SANY rejects any
   such reference. MC takes it with an unnamed INSTANCE, so a property of the
   same name defined in MC is a duplicate definition. Helpers are LOCAL. *)
EXTENDS Naturals, FiniteSets

CONSTANTS Skills, Claims, MaxFaults, MaxHuman, MaxHints, MaxRaise, MaxRet,
          FixLimit0, RebuildLimit0, WaitLimit, Items

VARIABLES hist, inbox, bud, out

LOCAL INSTANCE DevelopCommon

LOCAL pvars == <<hist, inbox, bud, out>>
LOCAL args == hist.args
LOCAL IsI == args.skill = "implement"
LOCAL IsR == args.skill = "review"
LOCAL IsA == args.skill = "address"
LOCAL Stopped == out.st = "stopped"
LOCAL Processing == inbox # NoEv /\ inbox' = NoEv

-----------------------------------------------------------------------------

\* What the skill returns changes only on a step that takes a recorded input,
\* the steps without an input included; leaving a stop is one such change.
OutputOnInput == [][out' # out => Processing]_pvars

\* docs/design/skill-design-patterns.md「再開した run は必ず計画役から始め、止まっていた間に増えたヒントを読ませる」原則:
\* a resumed run starts at the planner when a hint is unread (implement) or
\* the pin broke (PR-DEVELOPREVIEW-043), otherwise at the position the stop
\* recorded. A new invocation is not a resume.
LOCAL ResumeStage ==
  CASE IsI /\ hist.unread > 0 -> "plan"
    [] IsR /\ hist.rPin -> "plan"
    [] OTHER -> out.stage

ResumePosition ==
  [][(Processing /\ Stopped /\ out'.st = "running" /\ inbox.n # "reinvoke") => out'.stage = ResumeStage]_pvars

\* (d) under the budgets of README
Termination == <>(out.st \in {"done", "aborted"})

-----------------------------------------------------------------------------
(* Goals, read from hist. *)

LOCAL Unv(r) == UnvOf(r, hist.dec)
LOCAL Confirmed(r) == ConfirmedOf(r, hist.dec)

\* The goals are conjunctions of named conditions; the completion conditions
\* of the requirement documents cite each name once.
LOCAL ImplCheckDecl == args.checkDecl
LOCAL ImplNoChange == out.res = "nochange" => (hist.rets = 0 /\ ~hist.change)
LOCAL ImplVerified ==
  out.res # "nochange" =>
    /\ out.res \in {"verified", "committed"}
    /\ hist.rets > 0 /\ hist.check = "pass" /\ hist.retAfterCheck
    /\ ~Confirmed(hist.ret) /\ Unv(hist.ret) = {}
    /\ (out.res = "committed") = args.commitReq
    /\ hist.commit = args.commitReq
    /\ hist.push = (args.commitReq /\ args.pushDecl)
LOCAL ImplNoUnread == hist.unread = 0
LOCAL ImplPlanImplemented == ~hist.planPending
LOCAL ImplConfirmedFed == hist.unfed = {}
LOCAL ImplNoBaselineAfterChange == ~hist.baseAfterChange
LOCAL ImplPlanReaccept == ~hist.freePlan
LOCAL ImplRebuiltChecked == ~hist.skip072

\* req: PR-DEVELOPIMPLEMENT-070, PR-DEVELOPIMPLEMENT-071, PR-DEVELOPIMPLEMENT-072
\* N11 and N12 (revised) of the acceptance
ImplGoal ==
  (IsI /\ out.st = "done") =>
    /\ ImplCheckDecl
    /\ ImplNoChange
    /\ ImplVerified
    /\ ImplNoUnread
    /\ ImplPlanImplemented
    /\ ImplRebuiltChecked
    /\ ImplConfirmedFed
    /\ ImplNoBaselineAfterChange
    /\ ImplPlanReaccept

LOCAL ReviewPostsOnce == hist.rPosts <= 1
LOCAL ReviewFailedIff == hist.rFail = (out.res = "failed")
LOCAL ReviewAllItems ==
  ~hist.rFail =>
    /\ hist.rItems = Items
    /\ out.res = (IF hist.rPartial THEN "degraded" ELSE "success")
LOCAL ReviewPostConfirmed == (~hist.rFail /\ args.postReq) => hist.rPost

\* req: PR-DEVELOPREVIEW-074, PR-DEVELOPREVIEW-075, PR-DEVELOPREVIEW-076
ReviewGoal ==
  IsR =>
    /\ ReviewPostsOnce
    /\ out.st = "done" => (ReviewFailedIff /\ ReviewAllItems /\ ReviewPostConfirmed)

LOCAL WaitsChecks == args.pr /\ args.stopAt \in {"none", "reply", "resolve"}
LOCAL NeedsCommit == NeedsCommitOf(args)
LOCAL EffFix == EffFixOf(hist.aClass, hist.aDec)

LOCAL Performed ==
  (IF hist.aImpl # "none" THEN {"implemented"} ELSE {})
  \cup (IF hist.aImpl = "committed" THEN {"committed"} ELSE {})
  \cup (IF hist.aPush THEN {"pushed"} ELSE {})
  \cup (IF hist.aCi # "none" THEN {"waited"} ELSE {})
  \cup (IF hist.aReplyPosted THEN {"replied"} ELSE {})
  \cup (IF hist.aResolvePosted THEN {"resolved"} ELSE {})

\* PR-DEVELOPADDRESSREVIEW-021 "行わない操作"
LOCAL Forbidden ==
  IF args.pr
  THEN CASE args.stopAt = "classify" -> {"implemented", "committed", "pushed", "waited", "replied", "resolved"}
         [] args.stopAt = "verify" -> {"committed", "pushed", "waited", "replied", "resolved"}
         [] args.stopAt = "push" -> {"waited", "replied", "resolved"}
         [] args.stopAt = "reply" -> {"resolved"}
         [] OTHER -> {}
  ELSE {"committed", "pushed", "waited", "replied", "resolved"}
       \cup (IF args.stopAt = "classify" THEN {"implemented"} ELSE {})

LOCAL AddrNoForbidden == Performed \cap Forbidden = {}
LOCAL AddrImplOnlyFix == hist.aImpl # "none" => (EffFix /\ (args.pr \/ hist.aClean))
LOCAL AddrReplyAfterChecks == hist.aReplyPosted => hist.aCi \in {"success", "nochecks"}
LOCAL AddrResolveAfterReply == hist.aResolvePosted => hist.aReplyConf = "ok"
LOCAL AddrNoStaleReply == ~hist.aStaleReply
LOCAL AddrClassified ==
  /\ hist.aClass # "none"
  /\ hist.aClass \in {"needs", "mismatch"} => hist.aDec # "none"
LOCAL AddrNoPr ==
  /\ args.pr \/ args.stopAt \notin {"push", "reply", "resolve"}
  /\ args.pr \/ hist.aClean
LOCAL AddrImplOnFix ==
  /\ (EffFix /\ args.stopAt # "classify") => hist.aImpl # "none"
  /\ (hist.aDec = "fix" /\ args.stopAt # "classify") => hist.aImpl # "none"
LOCAL AddrCommitPushed == (EffFix /\ NeedsCommit /\ hist.aImpl # "nochange") => (hist.aImpl = "committed" /\ hist.aPush)
LOCAL AddrReplyConfirmed == WaitsChecks => (hist.aCi \in {"success", "nochecks"} /\ hist.aReplyConf = "ok")
LOCAL AddrResolveConfirmed == (args.pr /\ args.stopAt \in {"none", "resolve"}) => hist.aResolveConf = "ok"

\* req: PR-DEVELOPADDRESSREVIEW-060, PR-DEVELOPADDRESSREVIEW-063
AddressGoal ==
  IsA =>
    /\ AddrNoForbidden
    /\ AddrImplOnlyFix
    /\ AddrReplyAfterChecks
    /\ AddrResolveAfterReply
    /\ AddrNoStaleReply
    /\ out.st = "done" =>
         /\ AddrClassified
         /\ AddrNoPr
         /\ AddrImplOnFix
         /\ AddrCommitPushed
         /\ AddrReplyConfirmed
         /\ AddrResolveConfirmed

-----------------------------------------------------------------------------
(* Witnesses, each violated somewhere in the correct model: the human's
   raise, the human's decision on unverified findings and the per-run
   recount take effect. *)

W_FixBeyond == ~(hist.frState = "ticked" /\ inbox = NoEv /\ out.st = "running" /\ out.stage = "impl")
W_PlanBeyond == ~(hist.rpState = "rejected" /\ inbox = NoEv /\ out.st = "running" /\ out.stage = "plan")
W_DecideEffect == ~(hist.dState = "ticked" /\ inbox = NoEv /\ out.st = "running")
W_EditDone == ~(hist.editAtLimit /\ ~hist.fixRaised /\ out.st = "done")
W_WaitBeyond == ~(hist.wrState = "ran" /\ inbox = NoEv /\ out.st = "running" /\ out.stage = "wait")

=============================================================================
