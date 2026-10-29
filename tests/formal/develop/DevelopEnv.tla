----------------------------- MODULE DevelopEnv -----------------------------
(* The environment, the caller and the human. The module declares its record
   `hist`, the input slot `inbox`, the adversity budget `bud` and `obs`, the
   part of the skill's output it reacts to: whether the skill runs or stopped,
   at which stage, and the reason it returned. It cannot name the skill's
   state; SANY rejects any such reference. `hist` keeps the values the
   environment gave and the facts they make true; it holds no expectation of
   what the skill does next. *)
EXTENDS Naturals, FiniteSets

CONSTANTS Skills, Claims, MaxFaults, MaxHuman, MaxHints, MaxRaise, MaxRet,
          FixLimit0, RebuildLimit0, WaitLimit, Items

VARIABLES hist, inbox, bud, obs

LOCAL INSTANCE DevelopCommon

Running == obs.st = "running"
Stopped == obs.st = "stopped"
g == obs.stage
k == obs.kind
args == hist.args
IsI == args.skill = "implement"
IsR == args.skill = "review"
IsA == args.skill = "address"

HInit(a) ==
  [args |-> a,
   \* implement
   unread |-> 0, rets |-> 0, ret |-> NoRet, dec |-> {}, wtSinceRet |-> TRUE,
   change |-> FALSE, check |-> "none", retAfterCheck |-> FALSE,
   commit |-> FALSE, push |-> FALSE, touched |-> FALSE,
   planPending |-> FALSE, unfed |-> {},
   frState |-> "none", rpState |-> "none", dState |-> "none",
   \* review
   rItems |-> 0, rFail |-> FALSE, rPartial |-> FALSE, rPost |-> FALSE, rPin |-> FALSE,
   \* address
   aClean |-> FALSE, aClass |-> "none", aDec |-> "none", aImpl |-> "none", aPush |-> FALSE,
   aCi |-> "none", aReplyPosted |-> FALSE, aReplyConf |-> "none",
   aResolvePosted |-> FALSE, aResolveConf |-> "none", aHeadMoved |-> FALSE,
   wrState |-> "none", rPosts |-> 0, baseAfterChange |-> FALSE, psSeen |-> FALSE,
   excused |-> FALSE, freePlan |-> FALSE, aStaleReply |-> FALSE,
   revLimited |-> FALSE, editAtLimit |-> FALSE, fixRaised |-> FALSE, limitHint |-> FALSE, s072 |-> "none", skip072 |-> FALSE]

HInitSet == {HInit(a) : a \in {aa \in ArgsSet : aa.skill \in Skills}}

-----------------------------------------------------------------------------
(* Facts the environment and the human know from their own record. *)

Unv(r) == {c \in r.unv : ~\E d \in hist.dec : d.r = r.id /\ d.c = c}
HumanConfirmed(r) == \E d \in hist.dec : d.r = r.id /\ d.v = "confirm"
Confirmed(r) == r.conf \/ HumanConfirmed(r)
ValidDec(e) == /\ e.x \cap e.y = {}
               /\ e.x \cup e.y # {}
               /\ e.x \cup e.y \subseteq Unv(hist.ret)

NeedsCommit == args.pr /\ args.stopAt \in {"none", "push", "reply", "resolve"}
EffFix == IF hist.aClass \in {"needs", "mismatch"} THEN hist.aDec = "fix" ELSE hist.aClass = "fix"

-----------------------------------------------------------------------------
(* Alphabet: what the agents, the CLI, git, GitHub and the human can return
   at the stage the skill asks at, and what the human can do at a stop given
   the reason the skill returned. *)

IAlpha(e) ==
  IF Running
  THEN CASE g = "plan" -> e.n \in {"planOk", "planReject", "planHuman", "agentFail", "token", "write", "hint"}
         [] g = "baseline" -> e.n \in {"checkOk", "checkErr", "token", "hint"}
         [] g = "impl" -> e.n \in {"change", "noChange", "agentFail", "token", "hint"}
                                  \cup (IF hist.rets > 0 /\ Confirmed(hist.ret) THEN {"outOfPlan"} ELSE {})
         [] g = "check" -> e.n \in {"checkErr", "hint"}
                              \cup CASE hist.check = "pass" -> {"checkPass"}
                                     [] hist.check = "fail" -> {"checkFailChange"}
                                     [] OTHER -> {"checkPass", "checkFailChange"}
         [] g = "review" -> e.n \in {"ret", "reviewFailed", "reviewLimit", "malformed", "hint"}
                                   \cup (IF hist.revLimited THEN {"reviewLimitSame"} ELSE {})
         [] g = "decide" -> e.n = "tick"
         [] g = "final" -> e.n \in {"tick", "finalFail", "hint"}
         [] g = "commit" -> e.n \in {"commitOk", "write", "hint"}
         [] g = "push" -> e.n \in {"pushOk", "pushRejected", "hint"}
         [] OTHER -> FALSE
  ELSE \/ e.n \in {"resume", "abort", "hint"}
       \/ k \in {"limit_fix", "limit_plan"} /\ e.n = "raise"
       \/ k = "limit_fix" /\ e.n = "editWt"
       \/ k = "abandon" /\ e.n = "decide" /\ ValidDec(e)
       \/ k = "needs_input" /\ e.n = "answer"
       \/ k = "plan_stop" /\ e.n = "touchWt"
       \/ (k \in {"no_check", "wt_changed"} \/ (k = "plan_stop" /\ hist.touched)) /\ e.n = "reinvoke"

RAlpha(e) ==
  IF Running
  THEN CASE g = "plan" -> e.n \in {"planOk", "readListBad", "write"}
         [] g = "items" -> IF hist.rItems < Items
                           THEN e.n \in {"itemDone", "slotShort", "token", "transportFail", "pinChanged", "write"}
                           ELSE e.n \in {"finishClean", "finishPartial"}
         [] g = "post" -> e.n \in {"postDone", "postFail"}
         [] g = "postCheck" -> e.n \in {"confirmOk", "postMismatch"}
         [] OTHER -> FALSE
  ELSE \/ e.n \in {"resume", "abort", "breakPin"}
       \/ k = "read_list" /\ e.n = "reinvoke"

AAlpha(e) ==
  IF Running
  THEN CASE g = "entry" -> IF args.pr \/ args.stopAt \in {"push", "reply", "resolve"}
                           THEN e.n = "tick" ELSE e.n \in {"clean", "dirty"}
         [] g = "classify" -> e.n \in {"agreeFix", "agreeNoFix", "agreeNeedsDec", "mismatch",
                                       "pathMismatch", "write", "agentFail", "token"}
         [] g = "route" -> IF args.stopAt # "classify" /\ EffFix /\ NeedsCommit
                           THEN e.n \in {"pushable", "pushDenied"} ELSE e.n = "tick"
         [] g = "implement" -> e.n \in (IF NeedsCommit THEN {"implCommitted"} ELSE {"implVerified"})
                                       \cup {"implNoChange", "implStopped"}
         [] g = "push" -> e.n \in {"pushOk", "pushRejected"}
         [] g = "wait" -> e.n \in {"ciSuccess", "ciNone", "ciFailure", "ciRunning", "ciUnreadable"}
         [] g = "reply" -> e.n \in (IF hist.aHeadMoved THEN {"headStale"} ELSE {"replyPost", "headStale"})
         [] g = "replyCheck" -> e.n \in {"confirmOk", "confirmMismatch"}
         [] g = "resolve" -> e.n = "resolvePost"
         [] g = "resolveCheck" -> e.n \in {"confirmOk", "confirmMismatch"}
         [] OTHER -> FALSE
  ELSE \/ e.n \in {"resume", "abort"}
       \/ k \in {"needs_input", "mismatch"} /\ e.n \in {"decideFix", "decideDecline", "decideOos"}
       \/ k = "limit_run" /\ g = "wait" /\ e.n = "pushByOther"
       \/ (k \in {"reject_args", "refused", "stale", "head_moved", "push_denied"}
           \/ (k = "limit_run" /\ hist.aHeadMoved))
          /\ e.n = "reinvoke"

Alpha(e) == CASE IsI -> IAlpha(e) [] IsR -> RAlpha(e) [] OTHER -> AAlpha(e)

-----------------------------------------------------------------------------
(* Budgets: the assumptions under which Termination is claimed (README). *)

\* A failure that the record already makes certain is not new adversity.
Repeat(e) == \/ e.n = "checkFailChange" /\ hist.check = "fail"
             \/ e.n = "headStale" /\ hist.aHeadMoved
             \/ e.n = "reviewLimitSame" /\ hist.revLimited

Budget(e) ==
  CASE Repeat(e) -> TRUE
    [] e.n \in Adverse -> bud.faults < MaxFaults
    [] e.n = "hint" -> bud.hints < MaxHints
    [] e.n = "raise" -> bud.raises < MaxRaise
    [] e.n \in HumanAtStop -> bud.human < MaxHuman
    [] e.n = "ret" -> IF hist.wtSinceRet
                      THEN hist.rets < MaxRet \/ (e.b = FALSE /\ e.x = {})
                      ELSE e.b = hist.ret.conf /\ e.x = hist.ret.unv
    [] OTHER -> TRUE

Gate(e) == Alpha(e) /\ Budget(e)

Spend(e) ==
  [bud EXCEPT
     !.faults = @ + (IF e.n \in Adverse /\ ~Repeat(e) THEN 1 ELSE 0),
     !.human = @ + (IF e.n \in HumanAtStop THEN 1 ELSE 0),
     !.hints = @ + (IF e.n = "hint" THEN 1 ELSE 0),
     !.raises = @ + (IF e.n = "raise" THEN 1 ELSE 0)]

\* decided 8 (b), PR-DEVELOPIMPLEMENT-010/015, PR-DEVELOPADDRESSREVIEW-021
NewArgs ==
  CASE IsI -> [args EXCEPT !.checkDecl = TRUE, !.planStop = FALSE]
    [] k = "reject_args" -> [args EXCEPT !.stopAt = "none"]
    [] k = "push_denied" -> [args EXCEPT !.stopAt = "verify"]
    [] OTHER -> args

ImplRun(e) == IsI /\ Running /\ g = "impl" /\ e.n \in {"change", "noChange", "outOfPlan"}

Rec(e) ==
  IF e.n = "reinvoke" THEN HInit(NewArgs) ELSE
  [hist EXCEPT
     !.unread = CASE IsI /\ e.n = "hint" -> @ + 1
                  [] IsI /\ Running /\ g = "plan" /\ e.n \in {"planOk", "planReject"} -> 0
                  [] OTHER -> @,
     !.rets = IF e.n = "ret" THEN @ + 1 ELSE @,
     !.ret = IF e.n = "ret" THEN [id |-> hist.rets + 1, conf |-> e.b, unv |-> e.x] ELSE @,
     !.dec = IF e.n = "decide"
             THEN @ \cup {[r |-> hist.ret.id, c |-> c, v |-> "confirm"] : c \in e.x}
                    \cup {[r |-> hist.ret.id, c |-> c, v |-> "reject"] : c \in e.y}
             ELSE @,
     !.wtSinceRet = CASE IsI /\ e.n \in {"change", "editWt"} -> TRUE [] e.n = "ret" -> FALSE [] OTHER -> @,
     !.change = @ \/ (IsI /\ e.n = "change"),
     !.check = CASE IsI /\ e.n \in {"change", "editWt"} -> "none"
                 [] e.n = "checkPass" -> "pass"
                 [] e.n = "checkFailChange" -> "fail"
                 [] OTHER -> @,
     !.retAfterCheck = CASE IsI /\ e.n \in {"change", "editWt", "checkPass", "checkFailChange"} -> FALSE
                         [] e.n = "ret" -> TRUE
                         [] OTHER -> @,
     !.commit = @ \/ (IsI /\ e.n = "commitOk"),
     !.push = @ \/ (IsI /\ e.n = "pushOk"),
     !.touched = @ \/ (IsI /\ e.n = "touchWt"),
     \* N11: an accepted plan waits for an implementation run
     !.planPending = CASE IsI /\ Running /\ g = "plan" /\ e.n = "planOk" -> TRUE
                       [] ImplRun(e) -> FALSE
                       [] OTHER -> @,
     \* N12: returns whose confirmed findings neither an implementation run took
     \* nor a human edit at the fix-round limit covered (the check and review
     \* after that edit are what ImplGoal reads at done)
     !.unfed = CASE ImplRun(e) -> {}
                 [] e.n = "ret" /\ e.b -> @ \cup {hist.rets + 1}
                 [] e.n = "decide" /\ e.x # {} -> @ \cup {hist.ret.id}
                 [] IsI /\ Stopped /\ k = "limit_fix" /\ e.n = "editWt" -> {}
                 [] OTHER -> @,
     \* witness: a fix-round limit raised, then the next 029 judgment with confirmed findings
     !.frState = CASE IsI /\ Stopped /\ k = "limit_fix" /\ e.n = "raise" -> "raised"
                   [] hist.frState = "raised" /\ Running /\ g = "decide" /\ e.n = "tick"
                      /\ Unv(hist.ret) = {} /\ Confirmed(hist.ret) -> "ticked"
                   [] hist.frState = "ticked" -> "none"
                   [] OTHER -> @,
     \* witness: a plan limit raised, then a rejection
     !.rpState = CASE IsI /\ Stopped /\ k = "limit_plan" /\ e.n = "raise" -> "raised"
                   [] hist.rpState = "raised" /\ Running /\ g = "plan" /\ e.n = "planReject" -> "rejected"
                   [] hist.rpState = "rejected" -> "none"
                   [] OTHER -> @,
     \* witness: a decision at abandon, then the next 029 judgment on the same return
     !.dState = CASE IsI /\ Stopped /\ k = "abandon" /\ e.n = "decide" -> "decided"
                  [] e.n = "ret" -> "none"
                  [] hist.dState = "decided" /\ Running /\ g = "decide" /\ e.n = "tick" -> "ticked"
                  [] hist.dState = "ticked" -> "none"
                  [] OTHER -> @,
     !.rItems = IF ~IsR THEN @ ELSE CASE e.n = "planOk" -> 0 [] e.n = "itemDone" -> @ + 1 [] OTHER -> @,
     !.rFail = @ \/ (IsR /\ e.n \in {"write", "transportFail", "pinChanged"}),
     !.rPartial = IF ~IsR THEN @ ELSE CASE e.n = "finishPartial" -> TRUE [] e.n = "finishClean" -> FALSE [] OTHER -> @,
     !.rPost = @ \/ (IsR /\ e.n = "confirmOk"),
     !.rPin = IF ~IsR THEN @ ELSE CASE e.n = "breakPin" -> TRUE [] e.n = "planOk" -> FALSE [] OTHER -> @,
     !.aClean = @ \/ (IsA /\ e.n = "clean"),
     !.aClass = IF ~IsA THEN @ ELSE CASE e.n = "agreeFix" -> "fix" [] e.n = "agreeNoFix" -> "nofix"
                                     [] e.n = "agreeNeedsDec" -> "needs"
                                     [] e.n \in {"mismatch", "pathMismatch"} -> "mismatch" [] OTHER -> @,
     !.aDec = IF ~IsA THEN @ ELSE CASE e.n = "decideFix" -> "fix" [] e.n = "decideDecline" -> "decline"
                                   [] e.n = "decideOos" -> "oos" [] OTHER -> @,
     !.aImpl = IF ~IsA THEN @ ELSE CASE e.n = "implCommitted" -> "committed" [] e.n = "implVerified" -> "verified"
                                    [] e.n = "implNoChange" -> "nochange" [] OTHER -> @,
     !.aPush = @ \/ (IsA /\ e.n = "pushOk"),
     !.aCi = IF ~IsA THEN @ ELSE CASE e.n = "ciSuccess" -> "success" [] e.n = "ciNone" -> "nochecks"
                                  [] e.n = "ciFailure" -> "failure" [] e.n = "ciRunning" -> "running"
                                  [] e.n = "ciUnreadable" -> "unreadable" [] OTHER -> @,
     !.aReplyPosted = @ \/ (IsA /\ e.n = "replyPost"),
     !.aReplyConf = IF IsA /\ Running /\ g = "replyCheck" /\ e.n \in {"confirmOk", "confirmMismatch"}
                    THEN (IF e.n = "confirmOk" THEN "ok" ELSE "mismatch") ELSE @,
     !.aResolvePosted = @ \/ (IsA /\ e.n = "resolvePost"),
     !.aResolveConf = IF IsA /\ Running /\ g = "resolveCheck" /\ e.n \in {"confirmOk", "confirmMismatch"}
                      THEN (IF e.n = "confirmOk" THEN "ok" ELSE "mismatch") ELSE @,
     !.aHeadMoved = @ \/ (IsA /\ e.n \in {"pushByOther", "headStale"}),
     \* witness: a resume from the wait limit, then CI still running
     !.wrState = CASE IsA /\ Stopped /\ k = "limit_run" /\ g = "wait" /\ e.n = "resume" -> "resumed"
                   [] hist.wrState = "resumed" /\ Running /\ g = "wait" /\ e.n = "ciRunning" -> "ran"
                   [] hist.wrState = "ran" -> "none"
                   [] OTHER -> @,
     \* J10: posts under the same pin (a broken pin restarts the review, PR-DEVELOPREVIEW-043)
     !.rPosts = CASE IsR /\ e.n = "postDone" -> @ + 1 [] IsR /\ e.n = "breakPin" -> 0 [] OTHER -> @,
     \* B2b: a start check run on a worktree that holds the change (065, 059)
     !.baseAfterChange = @ \/ (IsI /\ Running /\ g = "baseline" /\ e.n = "checkOk" /\ hist.change),
     \* J8: a plan accepted again after the plan stop, without a hint or 043 (012, sp:184)
     !.psSeen = @ \/ (IsI /\ Stopped /\ k = "plan_stop"),
     !.excused = @ \/ (IsI /\ e.n \in {"hint", "outOfPlan"} /\ (hist.psSeen \/ (Stopped /\ k = "plan_stop"))),
     !.freePlan = @ \/ (IsI /\ Running /\ g = "plan" /\ e.n = "planOk" /\ hist.psSeen /\ ~hist.excused),
     \* a review stopped at its limit and is recalled; the next limit may leave as many items untouched
     !.revLimited = CASE IsI /\ Running /\ g = "review" /\ e.n \in {"reviewLimit", "reviewLimitSame"} -> TRUE
                      [] IsI /\ (e.n = "ret" \/ Stopped) -> FALSE
                      [] OTHER -> @,
     \* witness (decision 4): the worktree edited at the fix-round limit, no raise of that limit
     !.editAtLimit = @ \/ (IsI /\ Stopped /\ k = "limit_fix" /\ e.n = "editWt"),
     !.fixRaised = @ \/ (IsI /\ Stopped /\ k = "limit_fix" /\ e.n = "raise"),
     \* IMPL-072: a plan rebuilt after the fix-round limit with an unread hint is
     \* followed by a check and a review before any implementation run
     !.limitHint = CASE IsI /\ Stopped /\ k = "limit_fix" /\ e.n \in {"resume", "raise"} /\ hist.unread > 0 -> TRUE
                     [] IsI /\ Running /\ g = "plan" /\ e.n = "planOk" -> FALSE
                     [] OTHER -> @,
     !.s072 = CASE IsI /\ Running /\ g = "plan" /\ e.n = "planOk" /\ hist.limitHint -> "planned"
                [] hist.s072 = "planned" /\ e.n \in {"checkPass", "checkFailChange"} -> "checked"
                [] hist.s072 = "checked" /\ e.n = "ret" -> "none"
                [] OTHER -> @,
     !.skip072 = @ \/ (ImplRun(e) /\ hist.s072 # "none"),
     \* a reply confirmed while the head had moved (036, 050)
     !.aStaleReply = @ \/ (IsA /\ Running /\ g = "replyCheck" /\ e.n = "confirmOk" /\ hist.aHeadMoved)]

Input ==
  /\ obs.st \in {"running", "stopped"}
  /\ inbox = NoEv
  /\ \E e \in Events : Gate(e) /\ inbox' = e /\ bud' = Spend(e) /\ hist' = Rec(e)

=============================================================================
