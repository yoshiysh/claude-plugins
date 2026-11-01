------------------------------ MODULE Authoring ------------------------------
\* create/update stages (SP-BPAUTHORING-005), gate and its next step (021-026), the formal
\* verification stage (042-045), and resume (035 with SP-BPRUN-015/018/045). Stages ledger..review
\* are folded into "check" (gen_tables.mjs refuses a resume row that splits them).
\* AuthStageSeq, GateNext, FormalRows, AuthResume and StopUse come from SpecTables, generated
\* from the markdown on every check.
EXTENDS Naturals, Sequences, FiniteSets, SpecTables
CONSTANTS Fn, MaxRuns, Limit, MaxIter, MaxRound, Mutation
VARIABLES log, run, alive, stage, it, fr, ghost, cont
vars == <<log, run, alive, stage, it, fr, ghost, cont>>

Stages == {AuthStageSeq[i] : i \in 1..Len(AuthStageSeq)}
Idx(S, x) == CHOOSE i \in 1..Len(S) : S[i] = x
RecsIn(L, t) == {i \in 1..Len(L) : L[i].t = t}
Recs(t) == RecsIn(log, t)
MaxOf(S) == IF S = {} THEN 0 ELSE CHOOSE i \in S : \A j \in S : j <= i
MinOf(S) == IF S = {} THEN 0 ELSE CHOOSE i \in S : \A j \in S : i <= j
LastIdx(t) == MaxOf(Recs(t))
NumGates == Cardinality(Recs("gate"))
LastGate == LastIdx("gate")
Has(t, f, v) == \E i \in Recs(t) : log[i][f] = v
At(t, f, v) == CHOOSE i \in Recs(t) : log[i][f] = v
GoalFixed == Recs("goal") # {}
GatesOfRun(r) == {i \in Recs("gate") : log[i].run = r}
FormalEnter(f) == {i \in Recs("enter") : log[i].s = "formal" /\ log[i].fr = f}
NextStage(s) == LET n == AuthStageSeq[Idx(AuthStageSeq, s) + 1] IN IF n = "snapshot" /\ Fn = "create" THEN "goal" ELSE n

\* ---- SP-BPRUN-018: the stopped stage and the source stop, as functions of a log ----
\* Head stages (stage-start with head: true) are left out of rules 1-3.
WorkIn(L) == {i \in RecsIn(L, "enter") : ~L[i].head}
LastWorkStage(L) == IF WorkIn(L) = {} THEN "start" ELSE L[MaxOf(WorkIn(L))].s
\* The source stop: the last stop of the earlier runs.
SrcIn(L) == MaxOf(RecsIn(L, "stop"))
Rule1(L) == SrcIn(L) > 0 /\ ~(\E k \in WorkIn(L) : k > SrcIn(L))
StoppedStageIn(L) == IF Rule1(L) THEN L[SrcIn(L)].stage ELSE LastWorkStage(L)
\* lastStop is the source stop only when rule 1 applies, otherwise null ("no stop record").
\* Mutation laststop_always returns the source stop also when rule 1 does not apply.
UseSrc(L) == SrcIn(L) > 0 /\ (Rule1(L) \/ Mutation = "laststop_always")
KindIn(L) == IF UseSrc(L) THEN L[SrcIn(L)].kind ELSE "nostop"
CauseIn(L) == IF UseSrc(L) THEN L[SrcIn(L)].cause ELSE "none"
LimitIn(L) == IF UseSrc(L) THEN L[SrcIn(L)].limit ELSE "na"
MatchesIn(L) == {x \in AuthResume :
                   /\ x.kind = KindIn(L)
                   /\ (x.kind = "limit" => x.limit = LimitIn(L))
                   /\ (x.kind = "blocked" => CauseIn(L) \in x.causes)
                   /\ (x.kind # "done" => StoppedStageIn(L) \in x.stages[Fn])}
RowIn(L) == CHOOSE x \in MatchesIn(L) : TRUE
\* An empty run started no work stage and wrote no stop.
Empty(r) == /\ ~(\E i \in RecsIn(log, "enter") : log[i].run = r /\ ~log[i].th)
            /\ ~(\E i \in RecsIn(log, "stop") : log[i].run = r)
\* The log without the empty runs, and with head stages marked as head (what the decision must equal).
WithoutEmpty(L, r) == LET kept == SelectSeq(L, LAMBDA x : ~("run" \in DOMAIN x /\ x.run # r /\ Empty(x.run))) IN
                      [i \in 1..Len(kept) |-> IF kept[i].t = "enter" THEN [kept[i] EXCEPT !.head = kept[i].th] ELSE kept[i]]

\* The stop record's stage is decided by rules 2-3 when it is written (SP-BPRUN-018).
StopRecord(kind, cause, limit) == [t |-> "stop", run |-> run, kind |-> kind, cause |-> cause, limit |-> limit, stage |-> LastWorkStage(log)]
\* th marks a head stage whatever the record says (only the property reads it: mutation head_counts).
EnterRec(s, i, f, h) == [t |-> "enter", s |-> s, it |-> i, fr |-> f, run |-> run, head |-> h, th |-> h]
\* A stage-start record is keyed by stage and round (SP-BPRUN-005): enumerating it again adds nothing.
AddEnter(s, i, f) == IF \E k \in Recs("enter") : log[k].s = s /\ log[k].it = i /\ log[k].fr = f /\ ~log[k].head
                     THEN <<>> ELSE <<EnterRec(s, i, f, FALSE)>>
EnterFormal(f) == IF FormalEnter(f) # {} THEN <<>> ELSE <<EnterRec("formal", it, f, FALSE)>>
StopAfter(rs, kind, cause, limit) ==
  /\ log' = log \o rs \o <<StopRecord(kind, cause, limit)>> /\ alive' = FALSE /\ stage' = "idle"

Init == /\ log = <<[t |-> "start", run |-> 1]>> /\ run = 1 /\ alive = TRUE /\ stage = "start"
        /\ it = 0 /\ fr = 0 /\ ghost = [stale |-> FALSE, rejectedComplete |-> FALSE, lost |-> FALSE] /\ cont = FALSE

TypeOK == /\ run \in 1..MaxRuns /\ alive \in BOOLEAN /\ stage \in Stages \cup {"idle", "head", "vanishH", "vanishOpen"}
          /\ it \in 0..MaxIter + 1 /\ fr \in 0..MaxRound + 1

\* Environment failures at a stage (SP-BPRUN-018/020/027/028, SP-BPAUTHORING-008).
Fail(how) ==
  /\ alive /\ run < MaxRuns
  /\ CASE how = "launch" -> StopAfter(<<>>, "limit", "none", "launch")
       [] how = "carrier" -> StopAfter(<<>>, "blocked", "none", "na")
       [] how = "verifiers" -> stage \in {"check", "formal"} /\ StopAfter(<<>>, "blocked", "verifiers", "na")
       [] how = "needs_input" -> ((stage = "goal" /\ ~GoalFixed) \/ Mutation = "needs_input_anywhere") /\ StopAfter(<<>>, "needs_input", "none", "na")
       [] how = "dry" -> Mutation = "stop_dry" /\ StopAfter(<<>>, "dry", "none", "na")
       [] how = "crash" -> alive' = FALSE /\ stage' = "idle" /\ log' = log
  /\ UNCHANGED <<run, it, fr, ghost, cont>>

\* SP-BPRUN-031 stop (complete), SP-BPAUTHORING-026/032: the last gate passed and the last formal round
\* started after it has a passing result. Otherwise the CLI refuses (E_CONFLICT -> BLOCKED: SP-BPRUN-029).
FreshPass(L) ==
  LET gs == {i \in 1..Len(L) : L[i].t = "gate"}
      lg == MaxOf(gs)
      rounds == {i \in 1..Len(L) : L[i].t = "enter" /\ L[i].s = "formal" /\ i > lg}
      last == MaxOf(rounds) IN
  /\ lg > 0 /\ L[lg].d = "pass" /\ rounds # {}
  /\ \E k \in 1..Len(L) : L[k].t = "fres" /\ L[k].fr = L[last].fr /\ L[k].ok
Complete(rs) ==
  IF FreshPass(log \o rs)
  THEN StopAfter(rs, "done", "none", "na") /\ UNCHANGED ghost
  ELSE StopAfter(rs, "blocked", "none", "na") /\ ghost' = [ghost EXCEPT !.rejectedComplete = TRUE]

StepStart == /\ alive /\ stage = "start" /\ stage' = NextStage("start") /\ log' = log \o AddEnter(NextStage("start"), it, fr)
             /\ UNCHANGED <<run, alive, it, fr, ghost, cont>>
StepSnapshot == /\ alive /\ stage = "snapshot" /\ stage' = "goal"
                /\ log' = log \o (IF Recs("snap") = {} THEN <<[t |-> "snap"]>> ELSE <<>>) \o AddEnter("goal", it, fr)
                /\ UNCHANGED <<run, alive, it, fr, ghost, cont>>
\* SP-BPAUTHORING-010: a fixed goal is not fixed again; the next iteration starts at the write stage.
StepGoal == /\ alive /\ stage = "goal" /\ NumGates < MaxIter
            /\ it' = NumGates + 1 /\ stage' = "write"
            /\ log' = log \o (IF GoalFixed THEN <<>> ELSE <<[t |-> "goal"]>>) \o AddEnter("write", NumGates + 1, fr)
            /\ UNCHANGED <<run, alive, fr, ghost, cont>>
StepWrite == /\ alive /\ stage = "write"
             /\ log' = log \o (IF Has("write", "it", it) THEN <<>> ELSE <<[t |-> "write", it |-> it]>>) \o AddEnter("check", it, fr)
             /\ stage' = "check" /\ UNCHANGED <<run, alive, it, fr, ghost, cont>>
StepCheck == /\ alive /\ stage = "check"
             /\ log' = log \o (IF Has("check", "it", it) THEN <<>> ELSE <<[t |-> "check", it |-> it]>>) \o AddEnter("gate", it, fr)
             /\ stage' = "gate" /\ UNCHANGED <<run, alive, it, fr, ghost, cont>>

GateNextOf(d, lim) == (CHOOSE g \in GateNext : g.d = d /\ g.lim \in {lim, "*"}).next
\* Where a gate result leads (SP-BPAUTHORING-025); round is the formal round to enter on pass.
FollowGate(rs, d, reached, round) ==
  LET n == GateNextOf(d, IF reached THEN "reached" ELSE "below") IN
  CASE n = "formal" /\ Mutation = "skip_formal" -> StopAfter(rs, "done", "none", "na") /\ UNCHANGED <<it, fr, ghost>>
    [] n = "formal" -> log' = log \o rs \o EnterFormal(round) /\ fr' = round /\ stage' = "formal" /\ UNCHANGED <<it, alive, ghost>>
    [] n = "rewrite" -> it < MaxIter /\ log' = log \o rs \o <<EnterRec("write", it + 1, fr, FALSE)>> /\ it' = it + 1 /\ stage' = "write" /\ UNCHANGED <<fr, alive, ghost>>
    [] n = "iterationLimit" -> StopAfter(rs, "limit", "none", "iteration") /\ UNCHANGED <<it, fr, ghost>>
    [] n = "blocked" -> StopAfter(rs, "blocked", "verifiers", "na") /\ UNCHANGED <<it, fr, ghost>>

\* SP-BPAUTHORING-021: placement precedes gate in the same carrier; gate refuses an iteration without it,
\* and placement refuses when no iteration up to this one has a write result (E_INPUT -> BLOCKED).
\* The gate result is written first; following it is a separate step (a stop can fall in between).
StepGate ==
  /\ alive /\ stage = "gate" /\ ~Has("gate", "it", it)
  /\ IF ~(\E k \in Recs("write") : log[k].it <= it)
     THEN StopAfter(<<>>, "blocked", "none", "na") /\ UNCHANGED <<it, fr, ghost>>
     ELSE \E d \in {"pass", "fail", "unverifiable"} :
            LET place == IF Mutation = "skip_placement" THEN <<>> ELSE <<[t |-> "place", it |-> it]>> IN
            log' = log \o place \o <<[t |-> "gate", it |-> it, d |-> d, run |-> run]>> /\ UNCHANGED <<stage, alive, it, fr, ghost>>
  /\ UNCHANGED <<run, cont>>

\* Following a gate result in the state (SP-BPAUTHORING-025), also when a resumed run continues the
\* gate stage. SP-BPAUTHORING-036: the formal round is the same only when the stopped stage is the
\* formal stage, so going on from the gate stage always starts a new round.
ContinueGate ==
  /\ alive /\ stage = "gate" /\ Has("gate", "it", it)
  /\ LET g == log[At("gate", "it", it)]
         round == IF Mutation = "same_round_after_gate" /\ cont /\ fr > 0 THEN fr ELSE fr + 1 IN
     FollowGate(<<>>, g.d, Cardinality(GatesOfRun(run)) >= Limit /\ Mutation # "limit_unchecked", round)
  /\ cont' = FALSE /\ UNCHANGED run

\* SP-BPAUTHORING-042/044/045. With a result already in the state for this round the script uses it.
StepFormal ==
  /\ alive /\ stage = "formal"
  /\ IF Has("fres", "fr", fr)
     THEN LET k == At("fres", "fr", fr)
              stale == MinOf(FormalEnter(fr)) < LastGate IN
          IF log[k].ok THEN Complete(<<>>)
          ELSE StopAfter(<<>>, "blocked", log[k].cause, "na") /\ ghost' = [ghost EXCEPT !.stale = ghost.stale \/ stale]
     ELSE \E row \in FormalRows :
            LET rs == <<[t |-> "fres", fr |-> fr, ok |-> row.passes, cause |-> row.cause]>> IN
            IF row.passes THEN Complete(rs) ELSE StopAfter(rs, "blocked", row.cause, "na") /\ UNCHANGED ghost
  /\ UNCHANGED <<run, it, fr, cont>>

\* ---- Resume (SP-BPRUN-003/014/015/018, SP-BPAUTHORING-004/035) ----
\* The start (head 1: its retake is inside the start), then the vanished-asset stage as a head stage
\* (head: true) when the retake found gone assets with findings, then the stage-start the row says.
\* A refused start changes nothing (StartChecks.tla, RunLifecycle.tla), so it is not a step here.
\* A stop can fall between any two steps.
ResumeRowUnique == (~alive /\ run < MaxRuns) => Cardinality(MatchesIn(log)) = 1

ResumeStart ==
  /\ ~alive /\ run < MaxRuns /\ Cardinality(MatchesIn(log)) = 1
  /\ (RowIn(log).mode # "reject" \/ Mutation = "resume_done")
  /\ run' = run + 1 /\ alive' = TRUE /\ log' = log \o <<[t |-> "start", run |-> run + 1]>>
  /\ stage' \in {"head", "vanishH"}
  /\ UNCHANGED <<it, fr, ghost, cont>>

\* The head vanished-asset stage of this run's retake round (round = run): start, then finish.
ResumeVanish ==
  /\ alive /\ stage = "vanishH"
  /\ log' = log \o <<[EnterRec("check", it, run, Mutation # "head_counts") EXCEPT !.th = TRUE]>>
  /\ stage' = "vanishOpen" /\ UNCHANGED <<run, alive, it, fr, ghost, cont>>
ResumeVanishFin ==
  /\ alive /\ stage = "vanishOpen"
  /\ log' = log \o <<[t |-> "fin", s |-> "check", fr |-> run, run |-> run, head |-> TRUE]>>
  /\ stage' = "head" /\ UNCHANGED <<run, alive, it, fr, ghost, cont>>

Begin(sg, i, f) == /\ stage' = sg /\ it' = i /\ fr' = f /\ log' = log \o AddEnter(sg, i, f)
ResumeEnter ==
  /\ alive /\ stage = "head" /\ Cardinality(MatchesIn(log)) = 1 /\ RowIn(log).mode # "reject"
  /\ LET row == RowIn(log)
         s == StoppedStageIn(log)
         newIt == NumGates + 1
         \* SP-BPAUTHORING-004: an update without a snapshot record takes it before anything else.
         snapFirst == Fn = "update" /\ Recs("snap") = {} /\ Mutation # "skip_snapshot_on_resume" IN
     IF snapFirst /\ row.mode \in {"continue", "fromSnapshot", "goalRestart", "goalSkipOrRestart"}
     THEN Begin("snapshot", it, fr)
     ELSE CASE row.mode = "continue" ->
                 IF s \in {"start", "snapshot"} THEN Begin("goal", it, fr) ELSE Begin(s, it, fr)
            [] row.mode = "fromSnapshot" /\ Fn = "update" -> Begin("snapshot", it, fr)
            [] row.mode \in {"goalRestart", "goalSkipOrRestart", "fromSnapshot"} -> Begin("goal", it, fr)
            [] row.mode = "newIterWrite" -> newIt <= MaxIter /\ Begin("write", newIt, fr)
            [] row.mode = "newIterLedger" -> newIt <= MaxIter
                 /\ stage' = (IF Mutation = "resume_skips_check" THEN "gate" ELSE "check") /\ it' = newIt /\ fr' = fr
                 /\ log' = log \o <<EnterRec("check", newIt, fr, FALSE)>>
            [] row.mode = "formalNewRound" -> fr < MaxRound /\ Begin("formal", it, fr + 1)
  \* N1: an empty run (no work stage, no stop but an SP-BPRUN-045 one) must not change the decision.
  /\ ghost' = [ghost EXCEPT !.lost = ghost.lost \/
                 (Cardinality(MatchesIn(WithoutEmpty(log, run))) # 1 \/ RowIn(WithoutEmpty(log, run)) # RowIn(log))]
  /\ cont' = (RowIn(log).mode = "continue") /\ UNCHANGED <<run, alive>>

Next == \/ StepStart \/ StepSnapshot \/ StepGoal \/ StepWrite \/ StepCheck \/ StepGate \/ ContinueGate \/ StepFormal
        \/ \E how \in {"launch", "carrier", "verifiers", "needs_input", "dry", "crash"} : Fail(how)
        \/ ResumeStart \/ ResumeVanish \/ ResumeVanishFin \/ ResumeEnter
Spec == Init /\ [][Next]_vars

\* ---- Properties ----
Done == {i \in Recs("stop") : log[i].kind = "done"}
\* SP-BPAUTHORING-026: completion only after a pass and the formal stage that follows it.
CompleteAfterGateAndFormal == \A i \in Done : FreshPass(SubSeq(log, 1, i - 1))
\* The script never asks the CLI for a completion it must refuse.
NoRefusedCompletion == ~ghost.rejectedComplete
\* A formal result recorded before the last gate never decides the stop (SP-BPAUTHORING-032's "after").
NoStaleFormalResult == ~ghost.stale
\* SP-BPAUTHORING-021: gate of an iteration only after placement of that iteration.
PlacementBeforeGate == \A i \in Recs("gate") : \E k \in Recs("place") : k < i /\ log[k].it = log[i].it
\* SP-BPAUTHORING-005/035: no stage is skipped, also across resumes.
NoSkippedStage ==
  /\ \A i \in Recs("gate") : \E k \in Recs("check") : k < i /\ log[k].it = log[i].it
  /\ \A i \in Recs("check") : \E k \in Recs("write") : k < i /\ log[k].it <= log[i].it
  /\ \A i \in Recs("write") : \E k \in Recs("goal") : k < i
  /\ \A i \in Recs("fres") : \E k \in Recs("gate") : k < i /\ log[k].d = "pass"
\* SP-BPRUN-013, SP-BPAUTHORING-024: gates per run stay within the per-run increment limit.
IterationLimitPerRun == \A r \in 1..MaxRuns : Cardinality(GatesOfRun(r)) <= Limit
\* SP-BPAUTHORING-027: needs_input only at the goal stage.
NeedsInputOnlyAtGoal == \A i \in Recs("stop") : log[i].kind = "needs_input" => log[i].stage = "goal"
\* SP-BPRUN-010: only the stop kinds the table uses for this function.
StopKindsUsed == \A i \in Recs("stop") : \E u \in StopUse : u.fn = Fn /\ u.kind = log[i].kind /\ u.use = "yes"
\* SP-BPRUN-014: a completed state gets no new run.
NoRunAfterDone == \A i \in Done : \A k \in Recs("start") : k < i
\* SP-BPRUN-018: an empty resumed run (head stages only, or the SP-BPRUN-045 stop) does not lose the restart.
NoLostRestart == ~ghost.lost
\* SP-BPAUTHORING-004: update takes the snapshot before the goal is fixed, also across resumes.
SnapshotBeforeGoal == Fn = "update" => \A i \in Recs("goal") : \E k \in Recs("snap") : k < i

\* N6: a head vanished-asset stage that started is finished before completion (its pending items are processed).
HeadStagesFinished == \A i \in Done : \A e \in Recs("enter") :
  (e < i /\ log[e].th) => \E f \in Recs("fin") : e < f /\ f < i /\ log[f].fr = log[e].fr

BoundOK == NumGates <= MaxIter /\ fr <= MaxRound

\* Reachability witnesses (checked as invariants that must be violated).
WitnessDone == Done = {}
WitnessDoneAfterResume == ~(\E i \in Done : log[i].run > 1)
WitnessDoneAfterFormalFailed == ~(\E i \in Done, k \in Recs("stop") : k < i /\ log[k].cause = "formalFailed")
WitnessDoneAfterVerifiers == ~(\E i \in Done, k \in Recs("stop") : k < i /\ log[k].cause = "verifiers")
WitnessDoneAfterLaunchAtGate == ~(\E i \in Done, k \in Recs("stop") : k < i /\ log[k].limit = "launch" /\ log[k].stage = "gate")
WitnessHeadVanishDone == ~(\E i \in Done, k \in Recs("fin") : k < i)
WitnessIterationLimit == ~(\E k \in Recs("stop") : log[k].limit = "iteration")
WitnessBlockedAtStart == ~(\E i \in Recs("stop") : log[i].stage = "start" /\ log[i].kind = "blocked" /\ \E k \in Recs("start") : k > i)
=============================================================================
