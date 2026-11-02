----------------------------- MODULE Convergence ----------------------------
(* Unit "fix rounds and convergence": counts and results carried in the state of
   one launch identity across continued launches (159/160/162-167/170/172/173/
   247/256/258/265/266). W is the judgment width, C the fix-round cap, T the
   trial cap; their values belong to the specification, so they are constants. *)
EXTENDS Naturals, Sequences
CONSTANTS Mutation, Fixes, Relax, W, C, T, MaxRuns

VARIABLES active, runs, stop, seq, count, runRounds, modelOpen, resumedAtCap,
          judgedFull, tainted, tc, runTrials, totalTries, item, allRounds
vars == <<active, runs, stop, seq, count, runRounds, modelOpen, resumedAtCap,
          judgedFull, tainted, tc, runTrials, totalTries, item, allRounds>>
Counters == <<seq, count, judgedFull, tainted, tc, totalTries>>

Init == /\ active = TRUE /\ runs = 1 /\ stop = "none" /\ seq = <<>> /\ count = 0
        /\ runRounds = 0 /\ modelOpen = TRUE /\ resumedAtCap = FALSE /\ judgedFull = FALSE
        /\ tainted = FALSE /\ tc = 0 /\ runTrials = 0 /\ totalTries = 0 /\ item = "todo" /\ allRounds = 0

Window == IF Mutation = "m266_run_local" THEN runRounds ELSE Len(seq)
NonConv(s, n) == n >= W /\ \A i \in (Len(s) - W + 1)..Len(s) : s[i] = "bad"
CapReached == count >= C

(* One fix round (157). Added constraint: the cap is checked before the judgment, as 162
   reasons. Relax "judgeFirst" judges first. *)
Round ==
  /\ active /\ stop = "none" /\ modelOpen
  /\ ~CapReached \/ (resumedAtCap /\ runRounds = 0 /\ Mutation # "m167_no_extra_round")
  /\ \E r \in {"bad", "ok"}, open \in BOOLEAN :
       LET s2 == Append(seq, r) n2 == IF Mutation = "m266_run_local" THEN runRounds + 1 ELSE Len(s2)
       IN /\ seq' = s2 /\ count' = count + 1 /\ allRounds' = allRounds + 1 /\ runRounds' = runRounds + 1 /\ modelOpen' = open
          /\ IF count + 1 >= C /\ open /\ ~("judgeFirst" \in Relax /\ NonConv(s2, n2))
             THEN /\ stop' = "iter165" /\ active' = FALSE
                  /\ judgedFull' = (judgedFull \/ ("judgeFirst" \in Relax /\ n2 >= W))
             ELSE /\ judgedFull' = (judgedFull \/ n2 >= W)
                  /\ IF open /\ NonConv(s2, n2) THEN stop' = "blocked163" /\ active' = FALSE
                     ELSE UNCHANGED <<stop, active>>
  /\ UNCHANGED <<runs, resumedAtCap, tainted, tc, runTrials, totalTries, item>>
StopAtCapWithoutRound ==
  /\ active /\ stop = "none" /\ modelOpen /\ CapReached /\ resumedAtCap /\ runRounds = 0
  /\ Mutation = "m167_no_extra_round"
  /\ stop' = "iter165" /\ active' = FALSE
  /\ UNCHANGED <<runs, seq, count, runRounds, modelOpen, resumedAtCap, judgedFull, tainted, tc, runTrials, totalTries, item, allRounds>>
(* The requirements do not say whether a continued launch judges before its first round. *)
JudgeAtStart ==
  /\ active /\ stop = "none" /\ modelOpen /\ runRounds = 0 /\ runs > 1 /\ "F9" \notin Fixes
  /\ NonConv(seq, Window) /\ stop' = "blocked163" /\ active' = FALSE
  /\ UNCHANGED <<runs, seq, count, runRounds, modelOpen, resumedAtCap, judgedFull, tainted, tc, runTrials, totalTries, item, allRounds>>
Budget154 == /\ active /\ stop = "none" /\ stop' = "iter154" /\ active' = FALSE
             /\ UNCHANGED <<runs, seq, count, runRounds, modelOpen, resumedAtCap, judgedFull, tainted, tc, runTrials, totalTries, item, allRounds>>
Input121 == /\ active /\ stop = "none" /\ stop' = "failure121" /\ active' = FALSE
            /\ UNCHANGED <<runs, seq, count, runRounds, modelOpen, resumedAtCap, judgedFull, tainted, tc, runTrials, totalTries, item, allRounds>>

(* 158/159/258: an item is retried up to the cumulative trial cap. 247: a reset item is tried once. *)
TrialCapFor == IF Mutation = "m258_run_local" THEN runTrials >= T ELSE tc >= T
TryFail ==
  /\ active /\ stop = "none" /\ item = "todo"
  /\ ~TrialCapFor \/ (runTrials = 0 /\ Mutation # "m247_no_retry")
  /\ tc' = tc + 1 /\ runTrials' = runTrials + 1 /\ totalTries' = totalTries + 1
  /\ IF (IF Mutation = "m258_run_local" THEN runTrials + 1 >= T ELSE tc + 1 >= T)
     THEN stop' = "failureTrial" /\ active' = FALSE /\ item' = "capped"
     ELSE UNCHANGED <<stop, active, item>>
  /\ UNCHANGED <<runs, seq, count, runRounds, modelOpen, resumedAtCap, judgedFull, tainted, allRounds>>
StopTrialWithoutTry ==
  /\ active /\ stop = "none" /\ item = "todo" /\ TrialCapFor /\ runTrials = 0 /\ Mutation = "m247_no_retry"
  /\ stop' = "failureTrial" /\ active' = FALSE /\ item' = "capped"
  /\ UNCHANGED <<runs, seq, count, runRounds, modelOpen, resumedAtCap, judgedFull, tainted, tc, runTrials, totalTries, allRounds>>
TryPass == /\ active /\ stop = "none" /\ item = "todo" /\ item' = "done"
           /\ UNCHANGED <<active, runs, stop, seq, count, runRounds, modelOpen, resumedAtCap, judgedFull, tainted, tc, runTrials, totalTries, allRounds>>

(* 193/170/173: a continued launch reads the counts and results back. 256 redoes the step
   stopped by 121 without its item results; whether the fix-round results of that step are
   such results is not stated, so both readings are left open unless F7 decides it. *)
Resume ==
  /\ ~active /\ stop \in {"iter165", "iter154", "failureTrial", "failure121", "blocked163"} /\ runs < MaxRuns
  /\ active' = TRUE /\ runs' = runs + 1 /\ stop' = "none" /\ runRounds' = 0 /\ runTrials' = 0
  /\ item' = IF item = "capped" /\ Mutation # "m160_keep_capped" THEN "todo" ELSE item
  /\ UNCHANGED <<modelOpen, totalTries>>
  /\ IF stop = "failure121"
     THEN IF "F7" \in Fixes
          THEN IF Mutation = "m256_keep_rounds"
               THEN /\ seq' = seq /\ count' = count /\ judgedFull' = judgedFull /\ resumedAtCap' = (count >= C)
                    /\ tainted' = (tainted \/ seq # <<>>) /\ UNCHANGED <<tc, allRounds>>
               ELSE /\ seq' = <<>> /\ count' = 0 /\ allRounds' = 0 /\ judgedFull' = FALSE /\ resumedAtCap' = FALSE
                    /\ UNCHANGED <<tainted, tc>>
          ELSE \E keep \in BOOLEAN :
                 /\ seq' = (IF keep THEN seq ELSE <<>>) /\ count' = count
                 /\ judgedFull' = (keep /\ judgedFull) /\ tainted' = (tainted \/ (keep /\ seq # <<>>))
                 /\ resumedAtCap' = (count >= C) /\ UNCHANGED <<tc, allRounds>>
     ELSE /\ seq' = (IF Mutation = "m173_drop_carry" THEN <<>> ELSE seq)
          /\ count' = (IF Mutation \in {"m166_reset_count", "m173_drop_carry"} THEN 0 ELSE count)
          /\ tc' = (IF Mutation = "m159_reset_trials" THEN 0 ELSE tc)
          /\ resumedAtCap' = (count >= C /\ Mutation \notin {"m166_reset_count", "m173_drop_carry"})
          /\ UNCHANGED <<judgedFull, tainted, allRounds>>

Complete == /\ active /\ stop = "none" /\ ~modelOpen /\ item = "done" /\ stop' = "complete" /\ active' = FALSE
            /\ UNCHANGED <<runs, seq, count, runRounds, modelOpen, resumedAtCap, judgedFull, tainted, tc, runTrials, totalTries, item, allRounds>>

Next == Round \/ StopAtCapWithoutRound \/ JudgeAtStart \/ Budget154 \/ Input121
        \/ TryFail \/ StopTrialWithoutTry \/ TryPass \/ Resume \/ Complete
Spec == Init /\ [][Next]_vars

TypeOK == stop \in {"none", "iter165", "iter154", "failureTrial", "failure121", "blocked163", "complete"}
WidthReached == stop = "iter165" => judgedFull
ConvergenceOnIdentityRounds == ~tainted
CountIsCumulative == count = allRounds /\ Len(seq) = allRounds
ExtraRoundAfterCap == [][(resumedAtCap /\ runRounds = 0 /\ active /\ ~active' /\ stop' = "iter165") => runRounds' = 1]_vars
RoundBeforeRejudge == [][(active /\ runs > 1 /\ ~active' /\ stop' = "blocked163") => runRounds' >= 1]_vars
TriedAfterReset == [][(active /\ ~active' /\ stop' = "failureTrial") => runTrials' >= 1]_vars
NoCappedAfterResume == [][(~active /\ active') => item' # "capped"]_vars
TrialCapCumulative == tc <= T + runs - 1
TrialCountCarried == tc = totalTries
WitnessIter165 == stop # "iter165"
WitnessBlocked163 == stop # "blocked163"
WitnessResumeAtCap == ~(resumedAtCap /\ runs > 1)
WitnessComplete == stop # "complete"
WitnessRejudgeAfterResume == ~(runs > 1 /\ stop = "blocked163")
WitnessTrialStopAfterResume == ~(runs > 1 /\ stop = "failureTrial")
=============================================================================
