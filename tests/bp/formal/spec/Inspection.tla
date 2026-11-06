----------------------------- MODULE Inspection -----------------------------
\* review/audit: the stages (SP-BPINSPECTION-001/002), the closing stage (019, SP-BPRUN-031 stop), the
\* vanished-asset stage over the retake rounds (SP-BPFINDINGS-020), and the resume of SP-BPRUN-015 with the
\* entry of SP-BPINSPECTION-030. InspStageSeqReview/Audit, RecordKeys and StopUse come from SpecTables.
\* The skip-list part (verify-extra) runs right after "verify" (SP-BPINSPECTION-001 after the table).
EXTENDS Naturals, Sequences, FiniteSets, SpecTables
CONSTANTS Fn, MaxRuns, Mutation
VARIABLES log, run, alive, stage, phase, pend, rnd, changed, ghost, touched
vars == <<log, run, alive, stage, phase, pend, rnd, changed, ghost, touched>>

Base == IF Fn = "review" THEN InspStageSeqReview ELSE InspStageSeqAudit
Pos(x) == CHOOSE i \in 1..Len(Base) : Base[i] = x
Order(x) == IF x = "extra" THEN Pos("verify") * 2 + 1 ELSE Pos(x) * 2
Flow == ({Base[i] : i \in 1..Len(Base)} \ {"start"}) \cup {"extra"}
After(x) == IF x = "verify" THEN "extra" ELSE IF x = "extra" THEN Base[Pos("verify") + 1] ELSE Base[Pos(x) + 1]
Items(s) == CASE s = "verify" -> {1, 2} [] s \in {"extra", "refute", "vanish", "applic"} -> {1} [] OTHER -> {}
Recs(t) == {i \in 1..Len(log) : log[i].t = t}
MaxOf(S) == IF S = {} THEN 0 ELSE CHOOSE i \in S : \A j \in S : j <= i
Rec(t, s, r) == {i \in Recs(t) : log[i].s = s /\ log[i].rnd = r}
ItemRec(t, s, r, k) == {i \in Recs(t) : log[i].item = <<s, r, k>>}
Started(s, r) == Rec("enter", s, r) # {}
Finished(s, r) == Rec("fin", s, r) # {}
Done(s, r, k) == ItemRec("res", s, r, k) # {} \/ ItemRec("abort", s, r, k) # {}
\* SP-BPFINDINGS-020: the retake rounds whose vanished-asset stage has no finish record, in order.
Rounds == {log[i].g : i \in Recs("retake")}
OpenRounds == {g \in Rounds : ~Finished("vanish", g)}
MinOf(S) == CHOOSE x \in S : \A y \in S : x <= y

\* ---- SP-BPRUN-018 ----
StageRecs == Recs("enter") \cup Recs("reread") \cup Recs("fin")
ReportedStage == IF StageRecs = {} THEN "none" ELSE log[MaxOf(StageRecs)].s
\* The run is inside a stage it started or read again ("pass" is a finished stage passed without a record).
InRecorded == phase \in {"items", "end"}
StopRec(kind) == [t |-> "stop", run |-> run, kind |-> kind, stage |-> ReportedStage,
                  actual |-> IF phase = "begin" THEN touched ELSE stage, cur |-> IF InRecorded THEN stage ELSE "pre"]
End(rs, kind) == /\ log' = log \o rs \o <<StopRec(kind)>> /\ alive' = FALSE /\ stage' = "idle" /\ phase' = "none" /\ pend' = {}

Init == /\ log = <<[t |-> "start", run |-> 1, changed |-> FALSE]>> /\ run = 1 /\ alive = TRUE /\ stage = "targets"
        /\ phase = "begin" /\ pend = {} /\ rnd = 0 /\ changed = FALSE /\ touched = "none"
        /\ ghost = [relaunch |-> FALSE]

Fail(how) ==
  /\ alive /\ run < MaxRuns /\ stage \in Flow /\ phase \in {"begin", "items"}
  /\ CASE how = "launch" -> phase = "begin" /\ End(<<>>, "limit")
       [] how = "carrier" -> phase = "begin" /\ End(<<>>, "blocked")
       [] how = "unreadable" -> stage = "targets" /\ phase = "begin" /\ End(<<>>, "blocked")
       [] how = "needs_input" -> Mutation = "stop_needs_input" /\ End(<<>>, "needs_input")
       [] how = "crash" -> alive' = FALSE /\ stage' = "idle" /\ phase' = "none" /\ pend' = {} /\ log' = log
  /\ UNCHANGED <<run, rnd, changed, ghost, touched>>

\* SP-BPRUN-015 3 with SP-BPINSPECTION-030: targets and ledger are done again in a resumed run (their
\* stage-start is written first); other finished stages are passed; started ones are read again.
Redo(s) == s \in {"targets", "ledger"}
\* Mutation enter_again writes a second stage-start record for a recorded stage and round instead.
Reread(s, r) == IF Mutation = "enter_again" THEN <<[t |-> "enter", s |-> s, rnd |-> r, run |-> run]>>
                ELSE IF Mutation = "no_reread" \/ (\E i \in Recs("reread") : log[i].run = run /\ log[i].s = s /\ log[i].rnd = r)
                THEN <<>> ELSE <<[t |-> "reread", run |-> run, s |-> s, rnd |-> r]>>
Begin ==
  /\ alive /\ phase = "begin" /\ stage \notin {"vanish", "close"}
  /\ LET s == stage r == rnd IN
     CASE Finished(s, r) /\ ~Redo(s) /\ Mutation # "rerun_finished" -> phase' = "pass" /\ pend' = {} /\ log' = log
       [] Started(s, r) ->
            /\ log' = log \o Reread(s, r)
            /\ pend' = IF Mutation = "redo_all_items" \/ (Finished(s, r) /\ Mutation = "rerun_finished") THEN Items(s) ELSE {k \in Items(s) : ~Done(s, r, k)}
            /\ phase' = "items"
       [] OTHER -> log' = log \o <<[t |-> "enter", s |-> s, rnd |-> r, run |-> run]>> /\ pend' = Items(s) /\ phase' = "items"
  /\ touched' = stage /\ UNCHANGED <<run, alive, stage, rnd, changed, ghost>>

\* The vanished-asset stage takes the open retake rounds in order, one round after another.
BeginVanish ==
  /\ alive /\ phase = "begin" /\ stage = "vanish"
  /\ LET todo == IF Mutation = "vanish_latest_only" /\ OpenRounds # {} THEN {CHOOSE g \in OpenRounds : \A h \in OpenRounds : h <= g} ELSE OpenRounds IN
     IF todo = {} \/ (Mutation = "vanish_latest_only" /\ rnd > 0)
     THEN phase' = "next" /\ pend' = {} /\ rnd' = 0 /\ log' = log
     ELSE LET g == MinOf(todo) IN
          /\ rnd' = g
          /\ IF Started("vanish", g) THEN log' = log \o Reread("vanish", g) /\ pend' = {k \in Items("vanish") : ~Done("vanish", g, k)}
             ELSE log' = log \o <<[t |-> "enter", s |-> "vanish", rnd |-> g, run |-> run]>> /\ pend' = Items("vanish")
          /\ phase' = "items"
  /\ touched' = stage /\ UNCHANGED <<run, alive, stage, changed, ghost>>

ItemStep ==
  /\ alive /\ phase = "items" /\ pend # {}
  /\ \E k \in pend :
       /\ ghost' = [ghost EXCEPT !.relaunch = ghost.relaunch \/ Done(stage, rnd, k)]
       /\ \/ log' = log \o <<[t |-> "res", item |-> <<stage, rnd, k>>]>>
          \/ stage \in {"verify", "extra", "refute"} /\ log' = log \o <<[t |-> "abort", item |-> <<stage, rnd, k>>]>>
       /\ pend' = pend \ {k} /\ phase' = IF pend \ {k} = {} THEN "end" ELSE "items"
  /\ UNCHANGED <<run, alive, stage, rnd, changed, touched>>
ItemsDone == /\ alive /\ phase = "items" /\ pend = {} /\ phase' = "end" /\ UNCHANGED <<log, run, alive, stage, pend, rnd, changed, ghost, touched>>

FinRec(s, r) == IF Finished(s, r) THEN <<>> ELSE <<[t |-> "fin", s |-> s, rnd |-> r, run |-> run]>>
Go(s) == stage' = s /\ phase' = "begin" /\ pend' = {} /\ rnd' = 0
EndStage ==
  /\ alive /\ phase \in {"end", "next", "pass"} /\ stage # "close"
  /\ LET s == stage r == rnd
         aborted == Items(s) # {} /\ \A k \in Items(s) : ItemRec("abort", s, r, k) # {} IN
     CASE s = "targets" /\ phase = "end" /\ run > 1 /\ changed /\ (\E i \in Rec("fin", "targets", 0) : log[i].run < run) /\ Mutation # "mismatch_continues" ->
            \* SP-BPINSPECTION-029: targets changed after an earlier run finished the stage.
            End(<<>>, "blocked") /\ UNCHANGED rnd
       [] s \in {"verify", "extra", "refute"} /\ aborted ->
            End(<<>>, "blocked") /\ UNCHANGED rnd
       [] s = "vanish" /\ phase = "end" ->
            log' = log \o FinRec(s, r) /\ phase' = "begin" /\ pend' = {} /\ UNCHANGED <<stage, rnd>> /\ UNCHANGED alive
       [] Mutation = "back_edge" /\ s = "refute" /\ ~(\E i \in Recs("reread") : log[i].run = run /\ log[i].s = "assign") ->
            \* The mutation goes back from the refutation stage and enumerates the assignment stage again.
            log' = log \o FinRec(s, r) \o <<[t |-> "reread", run |-> run, s |-> "assign", rnd |-> 0]>> /\ Go(After("assign")) /\ UNCHANGED alive
       [] OTHER ->
            /\ log' = log \o (IF phase = "end" THEN FinRec(s, r) ELSE <<>>)
            /\ Go(IF Mutation = "skip_stage" /\ After(s) = "refute" THEN After(After(s)) ELSE After(s))
            /\ UNCHANGED alive
  /\ UNCHANGED <<run, changed, ghost, touched>>

\* SP-BPINSPECTION-019 and SP-BPRUN-031 stop: review sends placement before stop; the CLI refuses the complete
\* stop of a review without a placement record of the current run (E_INPUT -> BLOCKED).
Close == /\ alive /\ phase = "begin" /\ stage = "close"
         /\ LET e == IF Started("close", 0) THEN Reread("close", 0) ELSE <<[t |-> "enter", s |-> "close", rnd |-> 0, run |-> run]>>
                send == Fn = "review" /\ ~(Mutation = "omit_placement" /\ run > 1)
                place == IF send THEN <<[t |-> "place", run |-> run]>> ELSE <<>> IN
            IF Fn = "review" /\ ~send /\ Mutation # "omit_placement"
            THEN End(e, "blocked")
            ELSE End(e \o place, "done")
         /\ UNCHANGED <<run, rnd, changed, ghost, touched>>

\* ---- Resume (SP-BPRUN-015, SP-BPINSPECTION-030): the start retakes the ledger (a retake round when it
\* finds gone assets with findings, chosen by the environment); the entry is the targets stage. ----
Resume == /\ ~alive /\ run < MaxRuns /\ (~(\E i \in Recs("stop") : log[i].kind = "done") \/ Mutation = "resume_done")
          /\ run' = run + 1 /\ alive' = TRUE /\ phase' = "begin" /\ pend' = {} /\ rnd' = 0 /\ touched' = "none"
          /\ stage' = IF Mutation = "entry_skips_targets" THEN "assign" ELSE "targets"
          /\ \E c \in BOOLEAN, gone \in BOOLEAN :
               /\ changed' = c
               /\ log' = log \o <<[t |-> "start", run |-> run + 1, changed |-> c]>>
                         \o (IF gone /\ Finished("ledger", 0) THEN <<[t |-> "retake", g |-> run + 1]>> ELSE <<>>)
          /\ UNCHANGED ghost

Next == Begin \/ BeginVanish \/ ItemStep \/ ItemsDone \/ EndStage \/ Close \/ Resume
        \/ \E h \in {"launch", "carrier", "unreadable", "needs_input", "crash"} : Fail(h)
Spec == Init /\ [][Next]_vars

DoneIdx == {i \in Recs("stop") : log[i].kind = "done"}
NoRelaunch == ~ghost.relaunch
\* SP-BPINSPECTION-002: within a run, a stage is never followed by an earlier stage (by stage records).
WorkOf(r) == {i \in StageRecs : log[i].run = r}
NoBackEdge == \A i, k \in Recs("enter") \cup Recs("reread") :
                (i < k /\ log[i].run = log[k].run /\ log[i].s # log[k].s) => Order(log[i].s) < Order(log[k].s)
PlacementBeforeStop == Fn = "review" => \A i \in DoneIdx : \E k \in Recs("place") : k < i /\ log[k].run = log[i].run
NoSkippedStage == \A i \in DoneIdx : \A s \in Flow \ {"close", "vanish"} : \E k \in Rec("fin", s, 0) : k < i
\* SP-BPINSPECTION-029: a resumed run whose targets changed after an earlier run finished the targets stage
\* starts no verification, extra or refutation stage.
NoVerifyAfterMismatch == \A i \in Recs("start") :
  (log[i].changed /\ \E k \in Rec("fin", "targets", 0) : k < i) =>
    ~(\E e \in Recs("enter") \cup Recs("reread") : e > i /\ log[e].run = log[i].run /\ log[e].s \in {"verify", "extra", "refute"})
\* SP-BPFINDINGS-020 (N6): every retake round's vanished-asset stage is finished before completion.
AllRoundsMatched == \A i \in DoneIdx : \A g \in Rounds : \E k \in Rec("fin", "vanish", g) : k < i
StopKindsUsed == \A i \in Recs("stop") : \E u \in StopUse : u.fn = Fn /\ u.kind = log[i].kind
                   /\ (u.use = "yes" \/ (u.use = "launchOnly" /\ log[i].kind = "limit"))
NoRunAfterDone == \A i \in DoneIdx : \A k \in Recs("start") : k < i
\* SP-BPINSPECTION-030: a resumed run's first stage record is the targets stage.
EntryIsTargets == \A r \in 2..MaxRuns : WorkOf(r) # {} => log[MinOf(WorkOf(r))].s = "targets"
KeyUnique == \A k \in RecordKeys : \A i, j \in Recs(k.t) : i < j => \E f \in k.fields : log[i][f] # log[j][f]
StoppedStageOfRun == \A i \in Recs("stop") : log[i].cur \in {"pre", log[i].stage}
StoppedStageReal == \A i \in Recs("stop") : log[i].actual \in {"none", log[i].stage}

WitnessDoneAfterResume == ~(\E i \in DoneIdx : log[i].run > 1)
WitnessMismatch == ~(\E i \in Recs("stop") : log[i].kind = "blocked" /\ \E k \in Recs("start") :
                       k < i /\ log[k].run = log[i].run /\ log[k].changed /\ \E f \in Rec("fin", "targets", 0) : f < k)
WitnessTwoRoundsMatched == ~(\E i \in DoneIdx : Cardinality(Rounds) >= 2)
=============================================================================
