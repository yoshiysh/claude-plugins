------------------------------- MODULE Budget -------------------------------
(* Unit "launch budget": the per-run launch limit L (037), the entry check of 155,
   the step that cannot finish within the limit (154) and the launches kept back to
   write the stop record (premise of the requirements, method in the specification).
   E launches write the state at entry; R launches write a stop record. *)
EXTENDS Naturals
CONSTANTS Mutation, Fixes, E, R, MaxL

VARIABLES L, left, phase, stopRec
vars == <<L, left, phase, stopRec>>

Init == L \in 1..MaxL /\ left = L /\ phase = "start" /\ stopRec = "none"

EntryNeed == IF "F8" \in Fixes THEN E + R ELSE E
Entry ==
  /\ phase = "start"
  /\ IF L < EntryNeed /\ Mutation # "m155_drop"
     THEN phase' = "rejected" /\ UNCHANGED <<left, stopRec>>
     ELSE phase' = "running" /\ left' = (IF left >= E THEN left - E ELSE 0) /\ UNCHANGED stopRec
  /\ UNCHANGED L
Reserve == IF Mutation = "m138_no_reserve" THEN 0 ELSE R
Work == /\ phase = "running" /\ left > Reserve /\ left' = left - 1 /\ UNCHANGED <<L, phase, stopRec>>
(* Any stop that writes the state: 154 when the next launch would eat the reserve,
   or any other stop row, or completion. *)
StopWrite ==
  /\ phase = "running" /\ phase' = "stopped" /\ UNCHANGED L
  /\ IF left >= R THEN stopRec' = "written" /\ left' = left - R
     ELSE stopRec' = "noLaunch" /\ UNCHANGED left

Next == Entry \/ Work \/ StopWrite
Spec == Init /\ [][Next]_vars

TypeOK == left \in 0..MaxL /\ phase \in {"start", "rejected", "running", "stopped"}
StopRecordWritable == stopRec # "noLaunch"
EntryWritesOnlyWithinLimit == phase \in {"running", "stopped"} => L >= E
WitnessStopWritten == stopRec # "written"
WitnessRejected == phase # "rejected"
=============================================================================
