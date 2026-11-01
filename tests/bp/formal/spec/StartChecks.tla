----------------------------- MODULE StartChecks -----------------------------
\* SP-BPRUN-003: the start operation checks in the order of the numbered list (StartChecks, generated),
\* answers with the first one that applies, and writes the state only after all of them pass.
\* response: -1 not yet answered, 0 the run starts, n refused by check n. failing: the checks the
\* request would fail (the environment chooses). written: the CLI wrote the state (a new state or a run).
EXTENDS Integers, Sequences, FiniteSets, SpecTables
CONSTANTS Mutation
VARIABLES kind, failing, written, response, next
vars == <<kind, failing, written, response, next>>

N == Len(StartChecks)
Applies(k) == {c \in 1..N : StartChecks[c].scope \in {"both", k}}
MinOf(S) == CHOOSE x \in S : \A y \in S : x <= y
\* The order the CLI walks: the list order, or reversed for the mutation.
At(i) == IF Mutation = "reverse_order" THEN N + 1 - i ELSE i

Init == /\ kind \in {"new", "resume"} /\ failing \in SUBSET (1..N) /\ written = FALSE
        /\ response = -1 /\ next = 1

Check == /\ response = -1 /\ next <= N
         /\ LET c == At(next) IN
            /\ written' = (written \/ (Mutation = "write_early" /\ c = 6))
            /\ IF c \in Applies(kind) /\ c \in failing
               THEN response' = c /\ next' = next
               ELSE response' = response /\ next' = next + 1
         /\ UNCHANGED <<kind, failing>>
Begin == /\ response = -1 /\ next = N + 1 /\ written' = TRUE /\ response' = 0
         /\ UNCHANGED <<kind, failing, next>>
Next == Check \/ Begin
Spec == Init /\ [][Next]_vars

TypeOK == response \in -1..N /\ written \in BOOLEAN
Refused == response \in 1..N
\* A refusal writes nothing: no state for a new start, no run, stop record or premise for a resume.
RefusalWritesNothing == Refused => ~written
\* The answer is the first check in the list that applies and fails.
FirstApplicable == Refused => response = MinOf(failing \cap Applies(kind))
\* The run starts only when no applicable check fails.
StartOnlyWhenClean == response = 0 => failing \cap Applies(kind) = {}

WitnessRefusedAtLast == ~(Refused /\ response = N)
=============================================================================
