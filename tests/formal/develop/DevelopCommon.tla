---------------------------- MODULE DevelopCommon ----------------------------
(* Constants and value vocabulary. It declares no VARIABLE: every module
   takes it with LOCAL INSTANCE, so a variable added here would need a
   substitution in each of them, and SANY rejects the yardstick and the
   environment, which have no skill state to substitute. *)
EXTENDS Naturals, FiniteSets

CONSTANTS Skills, Claims, MaxFaults, MaxHuman, MaxHints, MaxRaise, MaxRet,
          FixLimit0, RebuildLimit0, WaitLimit, Items

Ev(n) == [n |-> n, b |-> FALSE, x |-> {}, y |-> {}]
NoEv == Ev("none")

PlainNames == {
  "planOk", "planReject", "planHuman", "agentFail", "token", "write", "hint",
  "checkOk", "checkErr", "change", "noChange", "outOfPlan", "checkPass",
  "checkFailChange", "reviewFailed", "reviewLimit", "reviewLimitSame", "malformed", "tick",
  "finalFail", "commitOk", "pushOk", "pushRejected",
  "readListBad", "itemDone", "slotShort", "transportFail", "pinChanged",
  "finishClean", "finishPartial", "postDone", "postFail", "postMismatch",
  "clean", "dirty", "agreeFix", "agreeNoFix", "agreeNeedsDec", "mismatch",
  "pathMismatch", "pushable", "pushDenied", "implCommitted", "implVerified",
  "implNoChange", "implStopped", "ciSuccess", "ciNone", "ciFailure",
  "ciRunning", "ciUnreadable", "replyPost", "headStale", "confirmOk",
  "confirmMismatch", "resolvePost",
  "resume", "abort", "raise", "answer", "touchWt", "editWt", "reinvoke",
  "breakPin", "decideFix", "decideDecline", "decideOos", "pushByOther"}

RetEvs == {[n |-> "ret", b |-> c, x |-> U, y |-> {}] : c \in BOOLEAN, U \in SUBSET Claims}
DecEvs == {[n |-> "decide", b |-> FALSE, x |-> X, y |-> Y] : X \in SUBSET Claims, Y \in SUBSET Claims}
Events == {Ev(n) : n \in PlainNames} \cup RetEvs \cup DecEvs

Adverse == {
  "agentFail", "token", "write", "checkErr", "checkFailChange", "reviewFailed",
  "reviewLimit", "reviewLimitSame", "malformed", "finalFail", "pushRejected", "touchWt", "editWt",
  "planHuman", "readListBad", "slotShort", "transportFail", "pinChanged",
  "postFail", "postMismatch", "breakPin", "dirty", "mismatch", "pathMismatch",
  "pushDenied", "implStopped", "ciFailure", "ciRunning", "ciUnreadable",
  "headStale", "confirmMismatch", "pushByOther"}

HumanAtStop == {"resume", "answer", "reinvoke", "decide", "decideFix", "decideDecline", "decideOos"}

StopAts == {"none", "classify", "verify", "push", "reply", "resolve"}

NoRet == [id |-> 0, conf |-> FALSE, unv |-> {}]

ArgsSet ==
  {[skill |-> "implement", commitReq |-> cp[1], pushDecl |-> cp[2], planStop |-> ps, checkDecl |-> cd,
    postReq |-> FALSE, pr |-> TRUE, stopAt |-> "none"] :
     cp \in {<<FALSE, FALSE>>, <<TRUE, FALSE>>, <<TRUE, TRUE>>}, ps \in BOOLEAN, cd \in BOOLEAN}
  \cup {[skill |-> "review", commitReq |-> FALSE, pushDecl |-> FALSE, planStop |-> FALSE, checkDecl |-> TRUE,
         postReq |-> p, pr |-> TRUE, stopAt |-> "none"] : p \in BOOLEAN}
  \cup {[skill |-> "address", commitReq |-> FALSE, pushDecl |-> FALSE, planStop |-> FALSE, checkDecl |-> TRUE,
         postReq |-> FALSE, pr |-> p, stopAt |-> s] : p \in BOOLEAN, s \in StopAts}

UnvOf(r, dec) == {c \in r.unv : ~\E d \in dec : d.r = r.id /\ d.c = c}
ConfirmedOf(r, dec) == r.conf \/ \E d \in dec : d.r = r.id /\ d.v = "confirm"
NeedsCommitOf(a) == a.pr /\ a.stopAt \in {"none", "push", "reply", "resolve"}
EffFixOf(cls, dec) == IF cls \in {"needs", "mismatch"} THEN dec = "fix" ELSE cls = "fix"

=============================================================================
