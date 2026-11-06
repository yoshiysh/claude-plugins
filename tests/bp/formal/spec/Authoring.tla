------------------------------ MODULE Authoring ------------------------------
\* create/update: the stages (SP-BPAUTHORING-005), gate (021-026), the formal stage (042-045), and the
\* resume of SP-BPRUN-015 with the entry table of SP-BPAUTHORING-035. Stages ledger..review are folded
\* into "check" (two items, so "all aborted" and "some aborted" both occur). AuthStageSeq, AuthEntry,
\* GateNext, FormalRows, RecordKeys and StopUse come from SpecTables, generated from the markdown.
EXTENDS Naturals, Sequences, FiniteSets, SpecTables
CONSTANTS Fn, MaxRuns, Limit, MaxIter, MaxRound, Mutation
\* touched: the last stage this run began (started, read again, or passed as finished).
\* vr: the retake round the vanished-asset stage before the entry works on.
VARIABLES log, run, alive, stage, phase, pend, it, fr, gr, after, ghost, touched, vr
vars == <<log, run, alive, stage, phase, pend, it, fr, gr, after, ghost, touched, vr>>

IterStages == {"write", "check", "gate"}
Items(s) == CASE s = "check" -> {1, 2} [] s \in {"goal", "write", "formal", "vanish"} -> {1} [] OTHER -> {}
Rnd(s) == CASE s \in IterStages -> it [] s = "formal" -> fr [] s = "goal" -> gr [] s = "vanish" -> vr [] OTHER -> 0
Recs(t) == {i \in 1..Len(log) : log[i].t = t}
MaxOf(S) == IF S = {} THEN 0 ELSE CHOOSE i \in S : \A j \in S : j <= i
Rec(t, s, r) == {i \in Recs(t) : log[i].s = s /\ log[i].rnd = r}
ItemRec(t, s, r, k) == {i \in Recs(t) : log[i].item = <<s, r, k>>}
Started(s, r) == Rec("enter", s, r) # {}
Finished(s, r) == Rec("fin", s, r) # {}
Done(s, r, k) == ItemRec("res", s, r, k) # {} \/ ItemRec("abort", s, r, k) # {}
GoalFixed == Recs("goal") # {}
Rounds == {log[i].g : i \in Recs("retake")}
NextStage(s) == LET m == AuthStageSeq[(CHOOSE i \in 1..Len(AuthStageSeq) : AuthStageSeq[i] = s) + 1] IN
                IF m = "snapshot" /\ Fn = "create" THEN "goal" ELSE m

\* ---- the state, as SP-BPAUTHORING-035 reads it ----
IterRounds == {log[i].rnd : i \in {j \in Recs("enter") : log[j].s \in IterStages}}
LastIter == IF IterRounds = {} THEN 0 ELSE CHOOSE n \in IterRounds : \A m \in IterRounds : m <= n
GateRes(n) == ItemRec("res", "gate", n, 1)
GateOf(n) == log[MaxOf(GateRes(n))].v
\* A stage of iteration n started and not finished whose items are all aborted (at least one item).
AllAbortedIn(n) == \E s \in {"write", "check"} :
  /\ Started(s, n) /\ ~Finished(s, n)
  /\ \A k \in Items(s) : ItemRec("abort", s, n, k) # {}
SomeAbortedIn(n) == \E s \in {"write", "check"} : Started(s, n) /\ ~Finished(s, n) /\ \E k \in Items(s) : ItemRec("abort", s, n, k) # {}
FormalRounds == {i \in Recs("enter") : log[i].s = "formal" /\ i > MaxOf(GateRes(LastIter))}
LastFormal == IF FormalRounds = {} THEN 0 ELSE log[MaxOf(FormalRounds)].rnd
FormalResult == ItemRec("res", "formal", LastFormal, 1)
Cond(c) ==
  CASE c = "noGoal" -> ~GoalFixed
    [] c = "noIter" -> LastIter = 0
    [] c = "allAborted" -> GateRes(LastIter) = {} /\ (IF Mutation = "discard_any" THEN SomeAbortedIn(LastIter) ELSE AllAbortedIn(LastIter))
    [] c = "noGate" -> GateRes(LastIter) = {}
    [] c = "gateFailBlocked" -> GateRes(LastIter) # {} /\ GateOf(LastIter) = "fail" /\ log[MaxOf(GateRes(LastIter))].why = "outOfScope"
    [] c = "gateFail" -> GateRes(LastIter) # {} /\ GateOf(LastIter) = "fail"
    \* Row 8: after the pass, a matching changed a finding's state or is "unknown", or the content changed.
    [] c = "passChanged" -> GateRes(LastIter) # {} /\ GateOf(LastIter) = "pass"
                            /\ \/ \E i \in Recs("res") : i > MaxOf(GateRes(LastIter)) /\ log[i].item[1] = "vanish" /\ log[i].v \in {"changed", "unsure"}
                               \/ \E i \in Recs("fp") : i > MaxOf(GateRes(LastIter))
    [] c = "gateUnverifiable" -> GateRes(LastIter) # {} /\ GateOf(LastIter) = "unverifiable"
    [] c = "formalPending" -> GateRes(LastIter) # {} /\ GateOf(LastIter) = "pass" /\ LastFormal > 0 /\ FormalResult = {} /\ ItemRec("abort", "formal", LastFormal, 1) = {}
    [] c = "formalPassed" -> GateRes(LastIter) # {} /\ GateOf(LastIter) = "pass" /\ FormalResult # {} /\ log[MaxOf(FormalResult)].v = "pass"
    [] c = "formalFailed" -> GateRes(LastIter) # {} /\ GateOf(LastIter) = "pass" /\ FormalResult # {} /\ log[MaxOf(FormalResult)].v = "formalFailed"
    [] c = "passOther" -> GateRes(LastIter) # {} /\ GateOf(LastIter) = "pass"
Table == IF Mutation = "drop_last_row" THEN SubSeq(AuthEntry, 1, Len(AuthEntry) - 1) ELSE AuthEntry
EntryRows == {i \in 1..Len(Table) : Cond(Table[i].cond)}
EntryRow == CHOOSE i \in EntryRows : \A j \in EntryRows : i <= j
Entry == Table[EntryRow].entry
OpenRounds == {g \in Rounds : Rec("fin", "vanish", g) = {}}

\* ---- SP-BPRUN-018: the stopped stage, from the last stage record (start, reread or finish) ----
StageRecs == Recs("enter") \cup Recs("reread") \cup Recs("fin")
ReportedStage == IF StageRecs = {} THEN "none" ELSE log[MaxOf(StageRecs)].s

\* actual: the last stage the run began (also when it passed a finished stage without a record);
\* cur: the stage the run is inside after writing its stage-start or reread record ("pre" otherwise).
\* The run is inside a stage it started or read again ("pass" is a finished stage passed without a record).
InRecorded == phase \in {"items", "end"}
StopRec(kind) == [t |-> "stop", run |-> run, kind |-> kind, stage |-> ReportedStage,
                  actual |-> IF phase = "begin" THEN touched ELSE stage, cur |-> IF InRecorded THEN stage ELSE "pre"]
End(rs, kind) == /\ log' = log \o rs \o <<StopRec(kind)>> /\ alive' = FALSE /\ stage' = "idle" /\ phase' = "none" /\ pend' = {}

Init == /\ log = <<[t |-> "start", run |-> 1]>> /\ run = 1 /\ alive = TRUE /\ stage = NextStage("start") /\ phase = "begin"
        /\ pend = {} /\ it = 0 /\ fr = 0 /\ gr = 1 /\ after = "none"
        /\ ghost = [rejectedComplete |-> FALSE, relaunch |-> FALSE] /\ touched = "none" /\ vr = 0

TypeOK == /\ run \in 1..MaxRuns /\ alive \in BOOLEAN /\ phase \in {"begin", "items", "end", "pass", "none"}
          /\ it \in 0..MaxIter + 1 /\ fr \in 0..MaxRound + 1

\* Environment failures (SP-BPRUN-018/020/027/029, SP-BPAUTHORING-008): launch limit, carrier, crash.
Fail(how) ==
  /\ alive /\ stage \in {"snapshot", "goal", "write", "check", "gate", "formal", "vanish"}
  /\ (phase \in {"begin", "items"} \/ (how = "crash" /\ phase = "end"))
  \* The launch limit and carrier failures are taken at a stage's beginning (a stop with items in flight
  \* is covered by the crash, which leaves the same records).
  /\ CASE how = "launch" -> phase = "begin" /\ End(<<>>, "limit")
       [] how = "carrier" -> phase = "begin" /\ End(<<>>, "blocked")
       [] how = "dry" -> Mutation = "stop_dry" /\ End(<<>>, "dry")
       [] how = "needs_input" -> Mutation = "needs_input_anywhere" /\ End(<<>>, "needs_input")
       [] how = "crash" -> alive' = FALSE /\ stage' = "idle" /\ phase' = "none" /\ pend' = {} /\ log' = log
  /\ UNCHANGED <<run, it, fr, gr, after, ghost, touched, vr>>

\* SP-BPRUN-015 3: a finished stage is passed without its agents; a started one is read again
\* (stage-start without keys: the reread record, first time in this run) and only its pending items run;
\* a stage not started is started with its items.
RereadRec(s, r) == [t |-> "reread", run |-> run, s |-> s, rnd |-> r]
Begin ==
  /\ alive /\ phase = "begin" /\ stage # "entry"
  /\ LET s == stage r == Rnd(stage) IN
     \* The snapshot stage is redone on every resume by the entry rule, so it is read again, not passed.
     CASE Finished(s, r) /\ s # "snapshot" /\ Mutation # "rerun_finished" ->
            phase' = "pass" /\ pend' = {} /\ log' = log
       [] Started(s, r) ->
            \* Mutation enter_again writes a second stage-start record for a recorded stage and round instead.
            /\ log' = log \o (IF Mutation = "enter_again" THEN <<[t |-> "enter", s |-> s, rnd |-> r, run |-> run]>>
                              ELSE IF Mutation = "no_reread" \/ (\E i \in Recs("reread") : log[i].run = run /\ log[i].s = s /\ log[i].rnd = r)
                              THEN <<>> ELSE <<RereadRec(s, r)>>)
            /\ pend' = IF Mutation = "redo_all_items" \/ (Finished(s, r) /\ Mutation = "rerun_finished") THEN Items(s) ELSE {k \in Items(s) : ~Done(s, r, k)}
            /\ phase' = "items"
       [] OTHER ->
            /\ log' = log \o <<[t |-> "enter", s |-> s, rnd |-> r, run |-> run]>>
            /\ pend' = Items(s) /\ phase' = "items"
  /\ touched' = stage /\ UNCHANGED <<run, alive, stage, it, fr, gr, after, ghost, vr>>

\* An item's agent is launched (ghost record) and returns a result, or the item is aborted (SP-BPRUN-028).
ItemStep ==
  /\ alive /\ phase = "items" /\ pend # {}
  /\ \E k \in pend :
       LET s == stage r == Rnd(stage) x == <<s, r, k>>
           v == CASE s = "goal" -> {"fixed", "missing"} [] s = "formal" -> {"pass", "formalFailed", "formalUnrunnable"}
                  [] s = "vanish" -> {"changed", "same", "unsure"} [] OTHER -> {"ok"} IN
       \* The launch is a ghost: relaunch marks an agent launched again for an item with a result or an
       \* abort, or in a finished stage (SP-BPRUN-015 3, PR-BPDESIGNEDSKILL-020).
       /\ ghost' = [ghost EXCEPT !.relaunch = ghost.relaunch \/ Done(s, r, k) \/ Finished(s, r)]
       /\ \/ \E val \in v : log' = log \o <<[t |-> "res", item |-> x, v |-> val]>>
          \/ s \in {"write", "check", "formal"} /\ log' = log \o <<[t |-> "abort", item |-> x]>>
     /\ pend' = pend \ {k} /\ phase' = IF pend \ {k} = {} THEN "end" ELSE "items"
  /\ UNCHANGED <<run, alive, stage, it, fr, gr, after, touched, vr>>
ItemsDone == /\ alive /\ phase = "items" /\ pend = {} /\ phase' = "end" /\ UNCHANGED <<log, run, alive, stage, pend, it, fr, gr, after, ghost, touched, vr>>

FinRec(s, r) == IF Finished(s, r) THEN <<>> ELSE <<[t |-> "fin", s |-> s, rnd |-> r, run |-> run]>>
Go(s) == stage' = s /\ phase' = "begin" /\ pend' = {}
FreshPass(L) ==
  LET gs == {i \in 1..Len(L) : L[i].t = "res" /\ L[i].item[1] = "gate"}
      lg == MaxOf(gs)
      rounds == {i \in 1..Len(L) : L[i].t = "enter" /\ L[i].s = "formal" /\ i > lg}
      last == L[MaxOf(rounds)].rnd IN
  /\ lg > 0 /\ L[lg].v = "pass" /\ rounds # {}
  /\ \E k \in 1..Len(L) : L[k].t = "res" /\ L[k].item = <<"formal", last, 1>> /\ L[k].v = "pass"
Complete(rs) == IF FreshPass(log \o rs) THEN End(rs, "done") /\ UNCHANGED ghost
                ELSE End(rs, "blocked") /\ ghost' = [ghost EXCEPT !.rejectedComplete = TRUE]
GatesOfRun(r) == {i \in Recs("res") : log[i].item[1] = "gate" /\ log[i].run = r}
\* why: whether a fail is only out-of-scope nonconformity (the writer cannot fix it: SP-BPAUTHORING-025).
GateNextOf(d, why, lim) == (CHOOSE g \in GateNext : g.d = d /\ g.why \in {why, "*"} /\ g.lim \in {lim, "*"}).next
FormalRounds2 == {log[i].rnd : i \in {j \in Recs("enter") : log[j].s = "formal"}}
NewFormalRound == IF FormalRounds2 = {} THEN 1 ELSE (CHOOSE n \in FormalRounds2 : \A m \in FormalRounds2 : m <= n) + 1

\* The end of a stage: its own rule, then the next stage along the flow (or `after`, the entry stage).
EndStage ==
  /\ alive /\ phase \in {"end", "pass"}
  /\ LET s == stage r == Rnd(stage)
         aborted == \A k \in Items(s) : ItemRec("abort", s, r, k) # {}
         next == IF after # "none" THEN after ELSE NextStage(s) IN
     CASE s = "snapshot" ->
            /\ log' = log \o (IF Recs("snap") = {} THEN <<[t |-> "snap"]>> ELSE <<>>) \o FinRec(s, r)
            /\ Go(IF after # "none" THEN after ELSE "goal") /\ after' = "none" /\ UNCHANGED <<run, alive, it, fr, gr, ghost>>
       [] s = "vanish" ->
            log' = log \o FinRec(s, r) /\ Go("entry") /\ UNCHANGED <<run, alive, it, fr, gr, after, ghost>>
       [] s = "goal" ->
            LET res == ItemRec("res", "goal", r, 1) IN
            IF res # {} /\ log[MaxOf(res)].v = "missing"
            THEN End(FinRec(s, r), "needs_input") /\ UNCHANGED <<run, it, fr, gr, after, ghost>>
            ELSE /\ log' = log \o (IF GoalFixed THEN <<>> ELSE <<[t |-> "goal"]>>) \o FinRec(s, r)
                 /\ it' = LastIter + 1 /\ LastIter + 1 <= MaxIter /\ Go("write") /\ UNCHANGED <<run, alive, fr, gr, after, ghost>>
       [] s \in {"write", "check"} /\ aborted ->
            End(<<>>, "blocked") /\ UNCHANGED <<run, it, fr, gr, after, ghost>>
       [] s \in {"write", "check"} ->
            \* The folded check stage holds the vanished-asset stage: it matches every open retake round in order
            \* (SP-BPFINDINGS-020); its items are not modelled.
            LET open == IF s = "check" THEN {g \in Rounds : Rec("fin", "vanish", g) = {}} ELSE {}
                todo == IF Mutation = "vanish_latest_only" /\ open # {} THEN {CHOOSE g \in open : \A h \in open : h <= g} ELSE open
                vf == [n \in 1..Cardinality(todo) |-> [t |-> "fin", s |-> "vanish", rnd |-> CHOOSE g \in todo : Cardinality({h \in todo : h <= g}) = n, run |-> run]] IN
            log' = log \o FinRec(s, r) \o vf /\ Go(NextStage(s)) /\ UNCHANGED <<run, alive, it, fr, gr, after, ghost>>
       [] s = "gate" ->
            \* SP-BPAUTHORING-021: placement before gate in the same carrier; the result is written once.
            LET known == GateRes(r) # {} IN
            \E d \in (IF known THEN {GateOf(r)} ELSE {"pass", "fail", "unverifiable"}) :
            \E why \in (IF known THEN {log[MaxOf(GateRes(r))].why} ELSE IF d = "fail" THEN {"outOfScope", "other"} ELSE {"other"}) :
              LET rs == (IF known THEN <<>> ELSE (IF Mutation = "skip_placement" THEN <<>> ELSE <<[t |-> "place", rnd |-> r]>>)
                                                   \o <<[t |-> "res", item |-> <<"gate", r, 1>>, v |-> d, why |-> why, run |-> run]>>) \o FinRec(s, r)
                  n == GateNextOf(d, why, IF Cardinality(GatesOfRun(run)) + (IF known THEN 0 ELSE 1) >= Limit /\ Mutation # "limit_unchecked" THEN "reached" ELSE "below") IN
              (CASE n = "formal" /\ Mutation = "skip_formal" -> End(rs, "done") /\ UNCHANGED <<run, it, fr, gr, after, ghost>>
                [] n = "formal" -> log' = log \o rs /\ fr' = NewFormalRound /\ fr' <= MaxRound /\ Go("formal") /\ UNCHANGED <<run, alive, it, gr, after, ghost>>
                [] n = "rewrite" -> log' = log \o rs /\ it' = r + 1 /\ r + 1 <= MaxIter /\ Go("write") /\ UNCHANGED <<run, alive, fr, gr, after, ghost>>
                [] n = "iterationLimit" -> End(rs, "limit") /\ UNCHANGED <<run, it, fr, gr, after, ghost>>
                [] n = "blocked" -> End(rs, "blocked") /\ UNCHANGED <<run, it, fr, gr, after, ghost>>)
       [] s = "formal" ->
            LET res == ItemRec("res", "formal", r, 1) IN
            IF res = {} THEN End(FinRec(s, r), "blocked") /\ UNCHANGED <<run, it, fr, gr, after, ghost>>
            ELSE IF log[MaxOf(res)].v = "pass" THEN Complete(FinRec(s, r)) /\ UNCHANGED <<run, it, fr, gr, after>>
            ELSE End(FinRec(s, r), "blocked") /\ UNCHANGED <<run, it, fr, gr, after, ghost>>
  /\ UNCHANGED <<touched, vr>>

\* ---- Resume (SP-BPRUN-015, SP-BPAUTHORING-035) ----
EntryDefined == (~alive /\ run < MaxRuns) => EntryRows # {}
DoneStop == \E i \in Recs("stop") : log[i].kind = "done"
GoalRound == LET rs == {log[i].rnd : i \in {j \in Recs("enter") : log[j].s = "goal"}}
                 last == IF rs = {} THEN 0 ELSE CHOOSE n \in rs : \A m \in rs : m <= n IN
             IF last = 0 THEN 1 ELSE IF ~Done("goal", last, 1) THEN last ELSE last + 1
\* The entry stage and round; update takes the snapshot stage first (SP-BPAUTHORING-004/035).
Resume ==
  /\ ~alive /\ run < MaxRuns /\ EntryRows # {} /\ (~DoneStop \/ Mutation = "resume_done")
  /\ run' = run + 1 /\ alive' = TRUE /\ pend' = {} /\ touched' = "none" /\ phase' = "begin"
  \* SP-BPRUN-015 1: the start retakes the ledger; a retake round when it finds gone assets with findings.
  \* The content may have changed while stopped (a new fingerprint record), with or without gone assets.
  /\ \E c \in {"none", "edit", "gone"} :
       log' = log \o <<[t |-> "start", run |-> run + 1]>> \o (IF c # "none" THEN <<[t |-> "fp", run |-> run + 1]>> ELSE <<>>)
              \o (IF c = "gone" /\ \E i \in Recs("fin") : log[i].s = "check" THEN <<[t |-> "retake", g |-> run + 1]>> ELSE <<>>)
  \* SP-BPAUTHORING-004/035: update takes the snapshot stage before the entry.
  /\ IF Fn = "update" /\ Mutation # "skip_snapshot_on_resume" THEN stage' = "snapshot" /\ after' = "entry" ELSE stage' = "entry" /\ after' = "none"
  /\ UNCHANGED <<it, fr, gr, ghost, vr>>

\* SP-BPAUTHORING-035: the entry from the table; for the rows of AuthPreVanish with open retake rounds, the
\* vanished-asset stage first (round by round), then the table again (its row 8 sees changed findings).
EntryStep ==
  /\ alive /\ stage = "entry" /\ phase = "begin" /\ EntryRows # {}
  /\ LET e == Entry
         first == IF Started("write", LastIter) THEN "write" ELSE "check" IN
     IF EntryRow \in AuthPreVanish /\ OpenRounds # {} /\ Mutation # "skip_pre_vanish"
     THEN vr' = (CHOOSE g \in OpenRounds : \A h \in OpenRounds : g <= h) /\ Go("vanish") /\ UNCHANGED <<log, alive, it, fr, gr, after>>
     ELSE CASE e = "complete" ->
                 log' = log \o <<[t |-> "stop", run |-> run, kind |-> IF FreshPass(log) THEN "done" ELSE "blocked", stage |-> ReportedStage, actual |-> "none", cur |-> "pre"]>>
                 /\ alive' = FALSE /\ stage' = "idle" /\ phase' = "none" /\ pend' = {} /\ UNCHANGED <<it, fr, gr, after, vr>>
            [] OTHER ->
                 LET target == CASE e = "goal" -> "goal" [] e = "write1" -> "write" [] e = "newIterLedger" -> "check"
                                  [] e = "continueIter" -> first [] e = "newIterWrite" -> "write"
                                  [] e \in {"formalSame", "formalNew"} -> "formal" IN
                 /\ it' = CASE e = "write1" -> 1 [] e \in {"newIterLedger", "newIterWrite"} -> LastIter + 1 [] OTHER -> LastIter
                 /\ it' <= MaxIter
                 /\ fr' = CASE e = "formalSame" -> LastFormal [] e = "formalNew" -> NewFormalRound [] OTHER -> fr
                 /\ fr' <= MaxRound
                 /\ gr' = IF e = "goal" THEN GoalRound ELSE gr
                 /\ Go(target) /\ UNCHANGED <<log, alive, after, vr>>
  /\ UNCHANGED <<run, ghost, touched>>

Next == \/ Begin \/ ItemStep \/ ItemsDone \/ EndStage \/ EntryStep
        \* The entry depends on the records, not on the stop kind (SP-BPRUN-015), so one stop with a record
        \* (the launch limit) and the end without one (crash) cover the resumes; BLOCKED comes from the stages.
        \/ \E how \in {"launch", "dry", "needs_input", "crash"} : Fail(how)
        \/ Resume
Spec == Init /\ [][Next]_vars

\* ---- Properties ----
\* SP-BPFINDINGS-020: every retake round's vanished-asset matching is finished before completion.
AllRoundsMatched == \A i \in Recs("stop") : log[i].kind = "done" => \A g \in Rounds : \E k \in Recs("fin") : k < i /\ log[k].s = "vanish" /\ log[k].rnd = g
DoneIdx == {i \in Recs("stop") : log[i].kind = "done"}
\* SP-BPAUTHORING-026: completion only after a pass and the formal stage that follows it.
CompleteAfterGateAndFormal == \A i \in DoneIdx : FreshPass(SubSeq(log, 1, i - 1))
NoRefusedCompletion == ~ghost.rejectedComplete
\* SP-BPRUN-015 3 / PR-BPDESIGNEDSKILL-020: an agent is never launched again for an item with a result or an
\* abort, nor in a finished stage; resumed runs go on from the pending items.
NoRelaunch == ~ghost.relaunch
\* SP-BPAUTHORING-035 3: an iteration without a gate result is left for a new one only when a stage of it
\* has all its items aborted.
DiscardOnlyAllAborted == \A n \in 1..MaxIter :
  ((\E i \in Recs("enter") : log[i].s \in IterStages /\ log[i].rnd = n + 1) /\ GateRes(n) = {} /\ n \in IterRounds)
    => \E s \in {"write", "check"} : Started(s, n) /\ \A k \in Items(s) : ItemRec("abort", s, n, k) # {}
\* SP-BPRUN-018: a run that stops inside a stage it started or read again reports that stage.
StoppedStageOfRun == \A i \in Recs("stop") : log[i].cur \in {"pre", log[i].stage}
\* The stopped stage is the last stage the run began, also when it passed finished stages without a record.
StoppedStageReal == \A i \in Recs("stop") : log[i].actual \in {"none", log[i].stage}
\* SP-BPRUN-005: no two records of a type share the key the record table gives.
KeyUnique == \A k \in RecordKeys : \A i, j \in Recs(k.t) : i < j => \E f \in k.fields : log[i][f] # log[j][f]
PlacementBeforeGate == \A i \in Recs("res") : log[i].item[1] = "gate" => \E k \in Recs("place") : k < i /\ log[k].rnd = log[i].item[2]
SnapshotBeforeGoal == Fn = "update" => \A i \in Recs("goal") : \E k \in Recs("snap") : k < i
IterationLimitPerRun == \A r \in 1..MaxRuns : Cardinality(GatesOfRun(r)) <= Limit
NeedsInputOnlyAtGoal == \A i \in Recs("stop") : log[i].kind = "needs_input" => log[i].stage = "goal"
StopKindsUsed == \A i \in Recs("stop") : \E u \in StopUse : u.fn = Fn /\ u.kind = log[i].kind /\ u.use = "yes"
NoRunAfterDone == \A i \in DoneIdx : \A k \in Recs("start") : k < i

BoundOK == LastIter <= MaxIter /\ fr <= MaxRound

WitnessDone == DoneIdx = {}
WitnessDoneAfterResume == ~(\E i \in DoneIdx : log[i].run > 1)
WitnessDiscardAllAborted == ~(\E n \in 1..MaxIter : GateRes(n) = {} /\ n \in IterRounds /\ \E i \in Recs("enter") : log[i].s \in IterStages /\ log[i].rnd = n + 1)
WitnessCompleteByEntry == ~(\E i \in DoneIdx : log[i].actual = "none")
WitnessFormalFailedThenDone == ~(\E i \in DoneIdx, k \in Recs("res") : k < i /\ log[k].v = "formalFailed")
\* The vanished-asset stage before the entry (rows of AuthPreVanish) is not reached: a retake round means the
\* content changed, so the row "the content changed after the pass" comes first (README: N9).
PreVanishUnreached == stage # "vanish"
WitnessNewIterAfterPass == ~(\E n \in 1..MaxIter : GateRes(n) # {} /\ GateOf(n) = "pass" /\ \E i \in Recs("enter") : log[i].s = "check" /\ log[i].rnd = n + 1)
WitnessIterationLimit == ~(\E i \in Recs("stop") : log[i].kind = "limit" /\ log[i].stage = "gate")
=============================================================================
