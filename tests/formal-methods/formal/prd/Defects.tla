------------------------------- MODULE Defects ------------------------------
(* Unit "defects and attribution": target defects found by steps, the step that
   decides attribution (140/142/143/144/218/246/262), the previous-result
   condition of term 82, stops by 154 and 121 in any step (138), and model
   defects found and fixed in fix rounds (157/168/178). The requirements do not
   fix where the attribution step sits among the checking steps, so its position
   attrAfter is left open. *)
EXTENDS Naturals, FiniteSets
CONSTANTS Mutation, Fixes, Relax, Steps, MaxDefects

Layers == {"target", "upstream"}
Feats == {"spans", "undefUp", "posTarget"}
VARIABLES fn, attrAfter, step, stopped, attrDone, defects, feat, attr, judged,
          modelFound, modelOpen, modelFixed, done, second, stopKind
vars == <<fn, attrAfter, step, stopped, attrDone, defects, feat, attr, judged,
          modelFound, modelOpen, modelFixed, done, second, stopKind>>

Init == /\ fn \in {"create", "audit"} /\ attrAfter \in 1..Steps /\ step = 1
        /\ stopped = FALSE /\ attrDone = FALSE /\ defects = {} /\ feat = [d \in 1..MaxDefects |-> {}]
        /\ attr = [d \in 1..MaxDefects |-> "none"] /\ judged = [d \in 1..MaxDefects |-> 0]
        /\ modelFound = 0 /\ modelOpen = 0 /\ modelFixed = 0 /\ done = FALSE
        /\ second = [d \in 1..MaxDefects |-> "none"] /\ stopKind = "none"

(* PR-246: 143, then 142, then 140. *)
RuleLayer(fs) ==
  IF Mutation = "m246_position_first"
  THEN IF "posTarget" \in fs THEN "target" ELSE "upstream"
  ELSE IF "undefUp" \in fs THEN "upstream"
       ELSE IF "spans" \in fs THEN "upstream"
       ELSE IF "posTarget" \in fs THEN "target" ELSE "upstream"

Found(fs) ==
  /\ ~stopped /\ Cardinality(defects) < MaxDefects
  /\ LET d == CHOOSE k \in 1..MaxDefects : k \notin defects
     IN /\ defects' = defects \cup {d} /\ feat' = [feat EXCEPT ![d] = fs]
  /\ UNCHANGED <<fn, attrAfter, step, stopped, attrDone, attr, judged, modelFound, modelOpen, modelFixed, done, second, stopKind>>

(* One judgment of one defect (144/218/262). Added constraint: a decided second
   judgment is adopted. Relax "conflict218" drops it: a decided second judgment may
   count as "the two judgments disagree" of 218 and end as ambiguous. *)
Judge(d, outcome) ==
  /\ ~stopped /\ ((step = attrAfter /\ ~attrDone) \/ "F5" \in Fixes \/ "K2" \in Fixes)
  /\ d \in defects /\ attr[d] = "none"
  /\ judged[d] < 2 /\ judged' = [judged EXCEPT ![d] = judged[d] + 1]
  /\ outcome = "conflict" => ("conflict218" \in Relax /\ judged[d] = 1)
  /\ second' = IF judged[d] = 1
               THEN [second EXCEPT ![d] = IF outcome = "undecided" THEN "undecided" ELSE "decided"]
               ELSE second
  /\ attr' = [attr EXCEPT ![d] =
       CASE outcome = "decided" -> RuleLayer(feat[d])
         [] judged[d] = 1 \/ Mutation = "m144_no_second" ->
              IF Mutation = "m262_leave_unattributed" THEN "none" ELSE "cited"
         [] OTHER -> "none"]
  /\ UNCHANGED <<fn, attrAfter, step, stopped, attrDone, defects, feat, modelFound, modelOpen, modelFixed, done, stopKind>>
AttrComplete == \A d \in defects : judged[d] >= 1 /\ (attr[d] # "none" \/ judged[d] = 2 \/ Mutation = "m144_no_second")
AttrStepEnd ==
  /\ ~stopped /\ step = attrAfter /\ ~attrDone /\ AttrComplete
  /\ attrDone' = TRUE
  /\ UNCHANGED <<fn, attrAfter, step, stopped, defects, feat, attr, judged, modelFound, modelOpen, modelFixed, done, second, stopKind>>

(* Fix rounds of the create function (157): a round finds or fixes a model defect. *)
FixFind == /\ ~stopped /\ fn = "create" /\ modelFound < 2
           /\ modelFound' = modelFound + 1 /\ modelOpen' = modelOpen + 1
           /\ UNCHANGED <<fn, attrAfter, step, stopped, attrDone, defects, feat, attr, judged, modelFixed, done, second, stopKind>>
FixRepair == /\ ~stopped /\ modelOpen > 0 /\ modelOpen' = modelOpen - 1 /\ modelFixed' = modelFixed + 1
             /\ UNCHANGED <<fn, attrAfter, step, stopped, attrDone, defects, feat, attr, judged, modelFound, done, second, stopKind>>

(* The model defects 178/180 count. 168 writes found defects to the state and no
   requirement says how a fixed one is recorded (lc K1); this model reads 178 as
   counting the found ones. K1 records fixed ones apart and counts the rest. *)
ModelDefectsCounted == IF "K1" \in Fixes THEN modelOpen ELSE modelFound

WillStop == (fn = "create" /\ defects # {}) \/ step = Steps
StepReady == ~stopped /\ (step # attrAfter \/ attrDone)
            /\ ("F5" \notin Fixes \/ ~WillStop \/ AttrComplete)
StepEnd ==
  /\ StepReady
  /\ IF WillStop
     THEN /\ stopped' = TRUE /\ stopKind' = "step"
          /\ done' = (defects = {} /\ ModelDefectsCounted = 0)
          /\ UNCHANGED step
     ELSE /\ step' = step + 1 /\ UNCHANGED <<stopped, done, stopKind>>
  /\ UNCHANGED <<fn, attrAfter, attrDone, defects, feat, attr, judged, modelFound, modelOpen, modelFixed, second>>

(* 154 and 121 can stop the run in any step. K2 keeps launches to finish attribution first. *)
OtherStop(kind) ==
  /\ ~stopped /\ ("K2" \notin Fixes \/ AttrComplete)
  /\ stopped' = TRUE /\ stopKind' = kind /\ done' = FALSE
  /\ UNCHANGED <<fn, attrAfter, step, attrDone, defects, feat, attr, judged, modelFound, modelOpen, modelFixed, second>>

Next == \/ \E fs \in SUBSET Feats : Found(fs)
        \/ \E d \in 1..MaxDefects, o \in {"decided", "undecided", "conflict"} : Judge(d, o)
        \/ AttrStepEnd \/ FixFind \/ FixRepair \/ StepEnd
        \/ \E k \in {"limit154", "fail121"} : OtherStop(k)
Spec == Init /\ [][Next]_vars

(* Term 82 for a stopped run (not a 121 stop); F5 closes every stop with the attribution step. *)
PrevResult == stopped /\ stopKind = "step" /\ ~done /\ defects # {} /\ (attrDone \/ "F5" \in Fixes)

TypeOK == /\ defects \subseteq 1..MaxDefects /\ step \in 1..Steps
          /\ \A d \in 1..MaxDefects : attr[d] \in Layers \cup {"none", "cited"} /\ judged[d] \in 0..2
NoUnattributedPrevResult == PrevResult => \A d \in defects : attr[d] # "none"
ReturnedDefectsAttributed == stopped => \A d \in defects : attr[d] # "none"
NoDownstreamForUpstreamGap ==
  \A d \in defects : (attr[d] \in Layers /\ feat[d] \cap {"undefUp", "spans"} # {}) => attr[d] = "upstream"
AttributionStepAttributesAll == [][(~attrDone /\ attrDone') => \A d \in defects : attr'[d] # "none"]_vars
AmbiguousOnlyAfterTwo == \A d \in defects : attr[d] = "cited" => judged[d] = 2
SecondDecidedAdopted == \A d \in defects : second[d] = "decided" => attr[d] \in Layers
WitnessCompleteAfterFix == ~(done /\ modelFixed > 0)
WitnessPrevResult == ~PrevResult
WitnessAmbiguous == ~(\E d \in defects : attr[d] = "cited")
WitnessLimitStopWithDefects == ~(stopKind = "limit154" /\ defects # {})
=============================================================================
