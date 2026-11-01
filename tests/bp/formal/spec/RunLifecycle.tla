---------------------------- MODULE RunLifecycle ----------------------------
\* bp-run.md "## 状態とイベント" (E1-E10) and SP-BPRUN-005/006/011/014/017/018/029.
\* The CLI view of a state is derived from the append-only log only (SP-BPRUN-005);
\* processes (alive) and in-flight requests are outside the CLI and invisible to it.
EXTENDS Naturals, FiniteSets, SpecTables
CONSTANTS MaxRuns, Vals, Mutation
VARIABLES log, alive, inflight, ev, cause
vars == <<log, alive, inflight, ev, cause>>

Runs == 1..MaxRuns
StopEvents == [E2 |-> "done", E3 |-> "needs_input", E4 |-> "limit", E5 |-> "limit", E6 |-> "blocked"]
StopIds == {"E2", "E3", "E4", "E5", "E6"}
Starts(L) == {r.run : r \in {x \in L : x.t = "start"}}
Max(S) == CHOOSE x \in S : \A y \in S : y <= x
Cur(L) == IF Starts(L) = {} THEN 0 ELSE Max(Starts(L))
StopOf(L, r) == {x \in L : x.t = "stop" /\ x.run = r}
Status(L) == IF Cur(L) = 0 THEN "none"
             ELSE IF StopOf(L, Cur(L)) = {} THEN "running"
             ELSE (CHOOSE x \in StopOf(L, Cur(L)) : TRUE).kind
Writable(L, r) == r = Cur(L) /\ StopOf(L, r) = {}

Msgs == [op : {"w"}, run : Runs, val : Vals] \cup [op : {"stop"}, run : Runs, e : StopIds]

TypeOK ==
  /\ log \subseteq ([t : {"start"}, run : Runs] \cup [t : {"stop"}, run : Runs, kind : {"done", "needs_input", "limit", "blocked"}, e : StopIds]
                    \cup [t : {"w"}, run : Runs, val : Vals, n : 1..2] \cup [t : {"fail"}, run : Runs])
  /\ alive \subseteq Runs /\ inflight \subseteq Msgs
  /\ ev \in RunEvents \cup {"init", "send", "write", "same", "conflict", "E7stale", "refused"}
  /\ cause \in [Runs -> 0..MaxRuns]

Init == /\ log = {} /\ alive = {} /\ inflight = {} /\ ev = "init" /\ cause = [r \in Runs |-> 0]

\* E1 (SP-BPRUN-003): only a missing state can be started; the same key returns the same state.
E1 == /\ Status(log) = "none" /\ log' = {[t |-> "start", run |-> 1]} /\ alive' = {1}
      /\ ev' = "E1" /\ UNCHANGED <<inflight, cause>>

\* A live run (current or superseded) sends one keyed write (one key, two possible contents).
Send(r, v) == /\ r \in alive /\ ~(\E m \in inflight : m.op = "w" /\ m.run = r) /\ inflight' = inflight \cup {[op |-> "w", run |-> r, val |-> v]}
              /\ ev' = "send" /\ UNCHANGED <<log, alive, cause>>

KeyRecs(L) == {x \in L : x.t = "w"}
\* SP-BPRUN-006 + SP-BPRUN-017: deliveries may repeat (resend after a lost response).
Deliver(m) ==
  /\ m \in inflight /\ m.op = "w"
  /\ IF Writable(log, m.run) \/ Mutation = "accept_stale"
     THEN IF KeyRecs(log) = {}
          THEN /\ log' = log \cup {[t |-> "w", run |-> m.run, val |-> m.val, n |-> 1]} /\ ev' = "write" /\ UNCHANGED cause
          ELSE LET old == CHOOSE x \in KeyRecs(log) : TRUE IN
               IF old.val = m.val
               THEN IF Mutation = "resend_appends" /\ old.n = 1
                    THEN /\ log' = log \cup {[old EXCEPT !.n = 2]} /\ ev' = "write" /\ UNCHANGED cause
                    ELSE /\ log' = log /\ ev' = "same" /\ UNCHANGED cause
               ELSE /\ log' = log /\ ev' = "conflict" /\ cause' = [cause EXCEPT ![m.run] = m.run]
     ELSE /\ log' = log /\ ev' = "E9"
          /\ cause' = IF Mutation = "stale_blocks_current" /\ Cur(log) > 0 THEN [cause EXCEPT ![Cur(log)] = m.run] ELSE cause
  /\ UNCHANGED <<alive, inflight>>

\* E2-E6: the run asks for its stop record, then returns (SP-BPRUN-011). E_CONFLICT on the
\* current run must end in BLOCKED (SP-BPRUN-029).
StopSend(r, e) == /\ r \in alive /\ (cause[r] # 0 => e = "E6")
                  /\ inflight' = inflight \cup {[op |-> "stop", run |-> r, e |-> e]} /\ alive' = alive \ {r}
                  /\ ev' = "send" /\ UNCHANGED <<log, cause>>
StopDeliver(m) ==
  /\ m \in inflight /\ m.op = "stop"
  /\ IF Writable(log, m.run)
     THEN log' = log \cup {[t |-> "stop", run |-> m.run, kind |-> StopEvents[m.e], e |-> m.e]} /\ ev' = m.e
     ELSE IF \E x \in StopOf(log, m.run) : x.e = m.e
          THEN log' = log /\ ev' = "same"
          ELSE log' = log /\ ev' = "E9"
  /\ UNCHANGED <<alive, inflight, cause>>

\* E7 (SP-BPRUN-018, bp-run.md "## 状態とイベント"): the current run ends without a stop record; nothing
\* reaches the log. A superseded run ending is not E7 (its writes are E9).
E7(r) == /\ r \in alive /\ alive' = alive \ {r}
         /\ ev' = IF r = Cur(log) \/ Mutation = "e7_any_run" THEN "E7" ELSE "E7stale"
         /\ UNCHANGED <<log, inflight, cause>>

\* E8 (SP-BPRUN-014/018): a new run from next_args, only when the start accepts it. The resume of a
\* completed state is refused (SP-BPRUN-003 4), which is not E8 (Refuse below).
E8 == /\ Status(log) \notin {"none", "done"} \/ (Status(log) = "done" /\ Mutation = "resume_done")
      /\ Cur(log) < MaxRuns
      /\ log' = log \cup {[t |-> "start", run |-> Cur(log) + 1]} /\ alive' = alive \cup {Cur(log) + 1}
      /\ ev' = "E8" /\ UNCHANGED <<inflight, cause>>
\* SP-BPRUN-003/045, bp-run.md "## 状態とイベント": a resume the start refuses (any of its checks, also a
\* completed state) is not E8 and changes nothing (no run, stop record or premise). The order of the
\* checks is StartChecks.tla.
Refuse == /\ Status(log) # "none" /\ Cur(log) < MaxRuns
          /\ log' = IF Mutation = "refusal_registers"
                    THEN log \cup {[t |-> "start", run |-> Cur(log) + 1], [t |-> "stop", run |-> Cur(log) + 1, kind |-> "blocked", e |-> "E6"]}
                    ELSE log
          /\ ev' = "refused" /\ UNCHANGED <<alive, inflight, cause>>

\* E10 (SP-BPRUN-028): an item step fails; the attempt is recorded and the run goes on.
E10 == /\ Cur(log) \in alive /\ Writable(log, Cur(log)) /\ ~(\E x \in log : x.t = "fail" /\ x.run = Cur(log))
       /\ log' = log \cup {[t |-> "fail", run |-> Cur(log)]} /\ ev' = "E10" /\ UNCHANGED <<alive, inflight, cause>>

Next == \/ E1 \/ E8 \/ E10 \/ Refuse
        \/ \E r \in Runs, v \in Vals : Send(r, v)
        \/ \E r \in Runs, e \in StopIds : StopSend(r, e)
        \/ \E m \in inflight : Deliver(m) \/ StopDeliver(m)
        \/ \E r \in Runs : E7(r)
Spec == Init /\ [][Next]_vars

\* Every table event moves the CLI view only along a row of the table or the diagram.
TableConformance == [][ev' \in RunEvents => <<Status(log), ev', Status(log')>> \in RunAllowed]_vars
\* No step labelled with an event the table marks "does not occur" is possible in that state.
NeverOccurs == \A p \in RunNever : Status(log) = p[1] => ~ENABLED (Next /\ ev' = p[2])
\* SP-BPRUN-006: resending the same request never adds a record; one record per key.
OneRecordPerKey == Cardinality(KeyRecs(log)) <= 1
\* SP-BPRUN-017: no record of a run is added after a later run started or after its own stop.
NoWriteOutsideCurrent == [][\A x \in log' \ log : x.t \in {"w", "fail"} => Writable(log, x.run)]_vars
\* SP-BPRUN-017: the rejection of a stale write is never a stop reason of the current run.
StaleNotStopReason == \A r \in Runs : cause[r] \in {0, r}
\* A refused resume leaves the state as it was.
RefusalChangesNothing == [][ev' = "refused" => log' = log]_vars
CompletedStaysCompleted == [][Status(log) = "done" => Status(log') = "done"]_vars

WitnessResumeFromRunning == ~(\E r \in Runs : r > 1 /\ r - 1 \in alive /\ r \in Starts(log))
WitnessStaleRejected == ev # "E9"
===============================================================================
