-------------------------------- MODULE Lock --------------------------------
(* Unit "launch lock": PR-043 rejects a launch while another launch with the same
   identity is running, and does not count a lock left by a launch that is not
   running. Launches here all carry the same identity. *)
EXTENDS Naturals
CONSTANTS Mutation, Slots

VARIABLES phase, holder, rejected
vars == <<phase, holder, rejected>>
Running(i) == phase[i] = "running"

Init == phase = [i \in Slots |-> "idle"] /\ holder = 0 /\ rejected = {}

LockBlocks == IF Mutation = "m043_stale_lock_blocks" THEN holder # 0
              ELSE holder # 0 /\ Running(holder)
Enter(i) ==
  /\ phase[i] = "idle"
  /\ IF LockBlocks /\ Mutation # "m043_no_lock"
     THEN phase' = [phase EXCEPT ![i] = "rejected"] /\ rejected' = rejected \cup {i} /\ UNCHANGED holder
     ELSE phase' = [phase EXCEPT ![i] = "running"] /\ holder' = i /\ UNCHANGED rejected
Finish(i) == /\ Running(i) /\ phase' = [phase EXCEPT ![i] = "done"]
             /\ holder' = (IF holder = i THEN 0 ELSE holder) /\ UNCHANGED rejected
HostEnd(i) == /\ Running(i) /\ phase' = [phase EXCEPT ![i] = "dead"] /\ UNCHANGED <<holder, rejected>>

Next == \E i \in Slots : Enter(i) \/ Finish(i) \/ HostEnd(i)
Spec == Init /\ [][Next]_vars

TypeOK == phase \in [Slots -> {"idle", "running", "done", "dead", "rejected"}] /\ holder \in Slots \cup {0}
LockMutex == \A i, j \in Slots : (Running(i) /\ Running(j)) => i = j
StaleLockDoesNotBlock == [][\A i \in Slots : (i \notin rejected /\ i \in rejected') => holder # 0 /\ Running(holder)]_vars
WitnessStaleThenEnter == ~(\E i, j \in Slots : phase[i] = "dead" /\ Running(j))
WitnessRejected == rejected = {}
=============================================================================
