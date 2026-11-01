----------------------------- MODULE Inspection -----------------------------
\* review/audit stages (SP-BPINSPECTION-001/002), the closing stage (019, SP-BPRUN-031 stop), and resume
\* (029/030 with SP-BPRUN-015/018/045). InspStageSeqReview/Audit, InspResume, InspResumeSeq,
\* InspClosePlacement and StopUse come from SpecTables. The skip-list part (verify-extra) is a part of
\* the verification stage (SP-BPINSPECTION-001 after the table), so the model runs it right after "verify".
EXTENDS Naturals, Sequences, FiniteSets, SpecTables
CONSTANTS Fn, MaxRuns, Mutation
\* gone: the retake of this run's start found gone assets with findings (the environment chooses).
VARIABLES log, run, alive, stage, prefix, changed, gone
vars == <<log, run, alive, stage, prefix, changed, gone>>

Base == IF Fn = "review" THEN InspStageSeqReview ELSE InspStageSeqAudit
Pos(x) == CHOOSE i \in 1..Len(Base) : Base[i] = x
\* Order of the flow with the skip-list part right after the verification stage.
Order(x) == IF x = "extra" THEN Pos("verify") * 2 + 1 ELSE Pos(x) * 2
Flow == ({Base[i] : i \in 1..Len(Base)} \ {"start"}) \cup {"extra"}
After(x) == IF x = "verify" THEN "extra" ELSE IF x = "extra" THEN Base[Pos("verify") + 1] ELSE Base[Pos(x) + 1]
Recs(t) == {i \in 1..Len(log) : log[i].t = t}
MaxOf(S) == IF S = {} THEN 0 ELSE CHOOSE i \in S : \A j \in S : j <= i
Entered(s) == {i \in Recs("enter") : log[i].s = s}
Finished(s) == {i \in Recs("fin") : log[i].s = s}
\* SP-BPINSPECTION-030: in a resumed run the stages before the resolution are head stages (head: true).
IsHead == prefix /\ Mutation # "head_counts"
\* th marks a head stage whatever the record says (only the property reads it: mutation head_counts).
Rec(t, s) == [t |-> t, s |-> s, run |-> run, head |-> IsHead, th |-> prefix]

\* ---- SP-BPRUN-018, as functions of a log ----
RecsIn(L, t) == {i \in 1..Len(L) : L[i].t = t}
WorkIn(L) == {i \in RecsIn(L, "enter") : ~L[i].head}
WorkFinIn(L) == {i \in RecsIn(L, "fin") : ~L[i].head}
\* Rule 2 (a work stage started and not finished, the last) and rule 3 (the last finished work stage).
\* stage-finish closes only a start of the same stage and head (mutation fin_ignores_head: any head).
\* m is the mutation the computation follows (the property's reference computation passes "none").
Closers(L, m) == IF m = "fin_ignores_head" THEN RecsIn(L, "fin") ELSE WorkFinIn(L)
OpenIn(L, m) == {i \in WorkIn(L) : ~(\E k \in Closers(L, m) : k > i /\ L[k].s = L[i].s)}
Rule23In(L, m) == IF OpenIn(L, m) # {} THEN L[MaxOf(OpenIn(L, m))].s ELSE IF WorkFinIn(L) # {} THEN L[MaxOf(WorkFinIn(L))].s ELSE "start"
\* The source stop: the last stop of the earlier runs.
SrcIn(L) == MaxOf(RecsIn(L, "stop"))
Rule1In(L) == SrcIn(L) > 0 /\ ~(\E k \in WorkIn(L) : k > SrcIn(L))
StoppedIn(L, m) == IF Rule1In(L) THEN L[SrcIn(L)].s ELSE Rule23In(L, m)
DoneIn(L, m) == ~Rule1In(L) /\ OpenIn(L, m) = {} /\ WorkFinIn(L) # {}
Rule23Stage == Rule23In(log, Mutation)
StoppedStage == StoppedIn(log, Mutation)
StoppedDone == DoneIn(log, Mutation)
\* An empty run started no work stage and wrote no stop.
Empty(r) == /\ ~(\E i \in Recs("enter") : log[i].run = r /\ ~log[i].th)
            /\ ~(\E i \in Recs("stop") : log[i].run = r)
\* The log without the empty runs, with head stages marked as head: the decision must equal the one on it.
Ideal(r) == LET kept == SelectSeq(log, LAMBDA x : ~(x.run # r /\ Empty(x.run))) IN
            [i \in 1..Len(kept) |-> IF kept[i].t \in {"enter", "fin"} THEN [kept[i] EXCEPT !.head = kept[i].th] ELSE kept[i]]
\* SP-BPRUN-018: an empty resumed run (head stages only) does not change where the next run starts, and a head
\* stage-finish closes only a head stage-start.
NoLostRestart == (alive /\ stage = "resolve") => (StoppedIn(Ideal(run), "none") = StoppedStage /\ DoneIn(Ideal(run), "none") = StoppedDone)

\* The stop record's stage: rules 2-3 when it is written (SP-BPRUN-018).
StopRec(kind, limit, cause) == [t |-> "stop", kind |-> kind, limit |-> limit, cause |-> cause, s |-> Rule23Stage, run |-> run]
End(rs, kind, limit) == /\ log' = log \o rs \o <<[StopRec(kind, limit, "none") EXCEPT !.s = IF rs = <<>> THEN Rule23Stage ELSE rs[1].s]>>
                        /\ alive' = FALSE /\ stage' = "idle"
\* A stop in a head stage records the work stage by rules 2-3; in a work stage that stage itself.
EndAt(kind, limit) == IF IsHead THEN End(<<>>, kind, limit) ELSE End(<<Rec("enter", stage)>>, kind, limit)

Init == /\ log = <<[t |-> "start", run |-> 1, changed |-> FALSE]>> /\ run = 1 /\ alive = TRUE /\ stage = "targets"
        /\ prefix = FALSE /\ changed = FALSE /\ gone = FALSE

\* Stages without a special rule: start (enter), finish, go on along the flow without returning.
Plain == Flow \ {"targets", "close"}
Step == /\ alive /\ stage \in Plain
        /\ LET nxt == IF prefix /\ stage = "ledger" THEN "vanishCheck" ELSE After(stage) IN
           /\ log' = log \o <<Rec("enter", stage), Rec("fin", stage)>>
           /\ stage' = IF Mutation = "back_edge" /\ stage = "refute" /\ Entered("assign") # {} /\ Cardinality(Entered("assign")) < 2 THEN "assign" ELSE nxt
        /\ UNCHANGED <<run, alive, changed, prefix, gone>>

\* SP-BPINSPECTION-004/029: a resumed run whose earlier runs finished this stage only compares.
Targets == /\ alive /\ stage = "targets"
           /\ IF prefix /\ Finished("targets") # {} /\ changed /\ Mutation # "mismatch_continues"
              THEN End(<<>>, "blocked", "na")
              ELSE log' = log \o <<Rec("enter", "targets"), Rec("fin", "targets")>> /\ stage' = "ledger" /\ alive' = TRUE
           /\ UNCHANGED <<run, prefix, changed, gone>>

\* SP-BPINSPECTION-019: review sends placement before stop in the same carrier. SP-BPRUN-031: the complete
\* stop of a review needs a placement record of the current run, or the CLI refuses it (E_INPUT -> BLOCKED).
\* On resume, SP-BPINSPECTION-030 (InspClosePlacement) says whether review sends placement again.
Close == /\ alive /\ stage = "close"
         /\ LET resumed == \E i \in Recs("redo") : log[i].run = run
                send == Fn = "review" /\ (~resumed \/ (InspClosePlacement /\ Mutation # "omit_placement"))
                place == IF send THEN <<Rec("place", "close")>> ELSE <<>>
                checked == Fn = "review" /\ Mutation # "omit_placement" IN
            IF checked /\ ~send
            THEN End(<<Rec("enter", "close")>>, "blocked", "na")
            ELSE End(<<Rec("enter", "close")>> \o place, "done", "na")
         /\ UNCHANGED <<run, prefix, changed, gone>>

Fail(how) ==
  /\ alive /\ run < MaxRuns /\ stage \in Flow \cup {"vanishOpen"}
  /\ CASE how = "launch" -> EndAt("limit", "launch")
       [] how = "carrier" -> EndAt("blocked", "na")
       [] how = "unreadable" -> stage = "targets" /\ EndAt("blocked", "na")
       [] how = "needs_input" -> Mutation = "stop_needs_input" /\ EndAt("needs_input", "na")
       [] how = "crash" -> log' = log \o (IF IsHead THEN <<>> ELSE <<Rec("enter", stage)>>) /\ alive' = FALSE /\ stage' = "idle"
  /\ UNCHANGED <<run, prefix, changed, gone>>

\* SP-BPINSPECTION-030: after the head stages, the stopped stage of SP-BPRUN-018; if it finished, the next stage.
\* SP-BPINSPECTION-030 head 4: the vanished-asset stage, when the stopped stage is the first-flow one or the
\* retake of this start found gone assets with findings. Started and finished as a head stage of round run.
VanishCheck == /\ alive /\ stage = "vanishCheck"
               /\ IF StoppedStage = "vanish" \/ gone
                  THEN log' = log \o <<[Rec("enter", "vanish") EXCEPT !.th = TRUE]>> /\ stage' = "vanishOpen"
                  ELSE log' = log /\ stage' = "resolve"
               /\ UNCHANGED <<run, alive, prefix, changed, gone>>
VanishFin == /\ alive /\ stage = "vanishOpen"
             /\ log' = log \o <<[Rec("fin", "vanish") EXCEPT !.th = TRUE]>> /\ stage' = "resolve"
             /\ UNCHANGED <<run, alive, prefix, changed, gone>>

Rows(s) == {r \in InspResume : s \in r.stages}
ResumeRowUnique == (alive /\ stage = "resolve") => Cardinality(Rows(StoppedStage)) = 1
Resolve ==
  /\ alive /\ stage = "resolve" /\ Cardinality(Rows(StoppedStage)) = 1
  /\ LET row == CHOOSE r \in Rows(StoppedStage) : TRUE
         target == CASE row.mode = "fromAssign" -> "assign"
                     [] row.mode = "toClose" -> "close"
                     [] StoppedDone -> After(StoppedStage)
                     [] OTHER -> StoppedStage IN
     /\ stage' = IF Mutation = "skip_stage" /\ target = "assign" THEN "verify" ELSE target
     /\ log' = IF row.mode = "redoClose" THEN log \o <<Rec("redo", "close")>> ELSE log
  /\ prefix' = FALSE /\ UNCHANGED <<run, alive, changed, gone>>

\* changed: the targets differ from the recorded fingerprint at this run's start (the environment chooses).
\* A refused start changes nothing (StartChecks.tla), so it is not a step here.
Resume == /\ ~alive /\ run < MaxRuns /\ (~(\E i \in Recs("stop") : log[i].kind = "done") \/ Mutation = "resume_done")
          /\ run' = run + 1 /\ alive' = TRUE /\ stage' = "targets" /\ prefix' = TRUE /\ gone' \in BOOLEAN
          /\ \E c \in BOOLEAN : changed' = c /\ log' = log \o <<[t |-> "start", run |-> run + 1, changed |-> c]>>

Next == Step \/ Targets \/ Close \/ VanishCheck \/ VanishFin \/ Resolve \/ Resume \/ \E h \in {"launch", "carrier", "unreadable", "needs_input", "crash"} : Fail(h)
Spec == Init /\ [][Next]_vars

Done == {i \in Recs("stop") : log[i].kind = "done"}
\* SP-BPINSPECTION-002: within a run, a work stage is never followed by itself or an earlier stage
\* (the head stages of SP-BPINSPECTION-030 excepted: they start each resumed run).
NoBackEdge == \A i, k \in WorkIn(log) :
                (i < k /\ log[i].run = log[k].run
                 /\ ~(\E j \in i + 1..k - 1 : log[j].t = "enter" /\ log[j].s = log[k].s)
                 /\ log[i].s # log[k].s) => Order(log[i].s) < Order(log[k].s)
\* SP-BPINSPECTION-019 / SP-BPCONFORMANCE-041: a completed review has its placement in the same run.
PlacementBeforeStop == Fn = "review" => \A i \in Done : \E k \in Recs("place") : k < i /\ log[k].run = log[i].run
\* SP-BPINSPECTION-001/030: every stage of the flow finished before completion, across resumes.
NoSkippedStage == \A i \in Done : \A s \in Flow \ {"close"} : \E k \in Finished(s) : k < i
\* SP-BPINSPECTION-029: a resumed run whose targets changed after an earlier run finished the targets
\* stage starts no verification, extra or refutation stage.
NoVerifyAfterMismatch == \A i \in Recs("start") :
  (log[i].changed /\ \E k \in Finished("targets") : k < i) =>
    ~(\E e \in Recs("enter") : e > i /\ log[e].run = log[i].run /\ log[e].s \in {"verify", "extra", "refute"})
\* SP-BPRUN-010: review/audit never stop with needs_input, and the iteration limit only by the launch limit.
StopKindsUsed == \A i \in Recs("stop") : \E u \in StopUse : u.fn = Fn /\ u.kind = log[i].kind
                   /\ (u.use = "yes" \/ (u.use = "launchOnly" /\ log[i].limit = "launch"))
NoRunAfterDone == \A i \in Done : \A k \in Recs("start") : k < i

WitnessDoneAfterResume == ~(\E i \in Done : log[i].run > 1)
WitnessDoneAfterCloseStop == ~(\E i \in Done, k \in Recs("stop") : k < i /\ log[k].s = "close")
WitnessMismatch == ~(\E i \in Recs("stop") : log[i].kind = "blocked" /\ \E k \in Recs("start") :
                       k < i /\ log[k].run = log[i].run /\ log[k].changed /\ \E f \in Finished("targets") : f < k)
WitnessHeadVanishDone == ~(\E i \in Done, k \in Recs("fin") : k < i /\ log[k].th /\ log[k].s = "vanish")
WitnessDoneAfterVanishStop == ~(\E i \in Done, k \in Recs("stop") : k < i /\ log[k].s = "vanish")
\* N6: every head vanished-asset stage that started is finished before completion (its pending items are processed).
HeadStagesFinished == \A i \in Done : \A e \in Recs("enter") :
  (e < i /\ log[e].th /\ log[e].s = "vanish") => \E f \in Recs("fin") : e < f /\ f < i /\ log[f].th /\ log[f].s = "vanish" /\ log[f].run = log[e].run
=============================================================================
