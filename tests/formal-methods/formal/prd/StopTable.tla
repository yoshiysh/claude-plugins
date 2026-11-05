------------------------------ MODULE StopTable ------------------------------
(* Unit "stop decision": the run-time rows of the PR-175 table and the order
   rules PR-232/251/252/253/254/259/260/263. The entry rows (043/155/231/192)
   are decided by the Launch unit before any run-time flag can hold. *)
EXTENDS FiniteSets
CONSTANTS Mutation, Fixes, Relax

Flags == {"create", "targetDefect", "attrDone", "stepDone", "allDone",
          "budgetHit", "trialCap", "inputChanged", "nonConv", "scatter2",
          "fixCap", "modelDefect", "ledgerFail", "miscFail", "recSaveFail",
          "stopRecFail"}
Rows == {"Complete", "IterLimit", "Defect", "Failure", "SaveFail", "StopRec"}
Blocked == {"Defect", "Failure", "SaveFail", "StopRec"}
(* IDs of the "when" column of each row of the PR-175 table; check.sh compares them with the document. *)
RowIds == [Complete |-> {178, 180, 192}, IterLimit |-> {165, 154, 156}, Defect |-> {152, 153, 163},
           Failure |-> {111, 121, 158, 174, 163}, SaveFail |-> {}, StopRec |-> {}]

VARIABLE f
vars == <<f>>
H(x) == x \in f

T152 == H("create") /\ H("targetDefect") /\ ~H("budgetHit")
T153 == ~H("create") /\ H("targetDefect") /\ ~H("budgetHit")
T163s == H("nonConv") /\ H("scatter2") /\ ~H("budgetHit")
T163n == H("nonConv") /\ ~H("scatter2") /\ ~H("budgetHit")
T165 == H("fixCap") /\ H("modelDefect")
TFailOnly == (H("trialCap") /\ ~H("budgetHit")) \/ H("inputChanged") \/ T163n
             \/ H("ledgerFail") \/ H("miscFail")
CompleteCond == H("allDone") /\ ~H("targetDefect") /\ ~H("modelDefect")
R152 == T152 /\ H("stepDone")
R153 == T153 /\ H("allDone")
TriggerNoSave == R152 \/ R153 \/ T163s \/ TFailOnly \/ T165 \/ H("budgetHit")
StopRequired == TriggerNoSave \/ CompleteCond

Constraint(s) ==
  LET h(x) == x \in s
      t152 == h("create") /\ h("targetDefect") /\ ~h("budgetHit")
      t153 == ~h("create") /\ h("targetDefect") /\ ~h("budgetHit")
      t163s == h("nonConv") /\ h("scatter2") /\ ~h("budgetHit")
      trig == (t152 /\ h("stepDone")) \/ (t153 /\ h("allDone")) \/ t163s \/ h("trialCap") \/ h("inputChanged") \/ h("nonConv")
              \/ h("ledgerFail") \/ h("miscFail") \/ (h("fixCap") /\ h("modelDefect"))
              \/ h("budgetHit") \/ (h("allDone") /\ ~h("targetDefect") /\ ~h("modelDefect"))
  IN /\ "allDoneStep" \notin Relax => (h("allDone") => h("stepDone"))
     /\ "budgetStep" \notin Relax => (h("budgetHit") => ~h("stepDone"))
     /\ ~h("create") => ~h("nonConv") /\ ~h("fixCap") /\ ~h("modelDefect")
     /\ h("scatter2") => h("nonConv")
     /\ h("nonConv") => h("modelDefect")
     /\ "scatterAttr" \notin Relax => (h("scatter2") => h("attrDone"))
     /\ "capFirst" \notin Relax => (h("fixCap") => ~h("nonConv"))
     /\ "saveNeedsTrigger" \notin Relax => ((h("recSaveFail") \/ h("stopRecFail")) => trig)
     /\ ("F1" \in Fixes /\ ((t152 /\ h("stepDone")) \/ (t153 /\ h("allDone")) \/ t163s)) => h("attrDone")

DefectRow == H("attrDone") /\ (R152 \/ R153 \/ T163s)
FailureRow == IF Mutation = "m156_trial_ignores_budget"
              THEN TFailOnly \/ H("trialCap") ELSE TFailOnly
IterRow == T165 \/ (H("budgetHit") /\ (Mutation # "m154_defect_blocks_limit" \/ ~H("targetDefect")))

Applicable ==
  {r \in Rows :
     \/ r = "Complete" /\ CompleteCond
     \/ r = "IterLimit" /\ IterRow
     \/ r = "Defect" /\ DefectRow
     \/ r = "Failure" /\ FailureRow
     \/ r = "SaveFail" /\ H("recSaveFail")
     \/ r = "StopRec" /\ H("stopRecFail")}

Before(a, b) ==
  \/ a = "StopRec" /\ b # "StopRec" /\ Mutation # "m232_drop"
  \/ /\ a = "Defect" /\ b \in {"Failure", "SaveFail", "IterLimit"}
     /\ ~H("stopRecFail") /\ ~H("inputChanged") /\ H("attrDone") /\ Mutation # "m251_drop"
  \/ /\ a = "Failure" /\ b = "Defect" /\ H("inputChanged") /\ ~H("stopRecFail")
     /\ Mutation # "m259_drop"
  \/ a \in {"Failure", "SaveFail"} /\ b = "IterLimit" /\ Mutation # "m252_drop"
  \/ a = "Failure" /\ b = "SaveFail" /\ Mutation # "m260_drop"
  \/ a \in Blocked /\ b = "Complete" /\ Mutation # "m254_drop"

Selected == {r \in Applicable : ~\E s \in Applicable : Before(s, r)}

(* Columns of the PR-175 table, one value per row. *)
RangeColOf(r) == CASE r = "SaveFail" -> "returnOnly" [] r = "StopRec" -> "none" [] OTHER -> "written"
NextArgsOf(r) == r \in {"IterLimit", "Failure", "SaveFail", "StopRec"}
                 \/ (r = "Defect" /\ Mutation = "m175_defect_next_args")
ScopeOf(r) == CASE r = "Failure" -> {x \in {"ledgerFail"} : H(x)}
                [] r = "SaveFail" -> {"recSaveFail"}
                [] OTHER -> {}
Chosen == CHOOSE r \in Rows : Selected = {r}
(* 253: the record columns come from the save-failure row when it is hit. 263: the
   unsaved scopes of every hit save-failure row are returned. *)
RangeCol == IF Selected = {"StopRec"} \/ "SaveFail" \notin Applicable \/ Mutation = "m253_drop"
            THEN RangeColOf(Chosen) ELSE RangeColOf("SaveFail")
ReturnedSaveFailures ==
  UNION {ScopeOf(r) : r \in (IF Mutation = "m263_only_selected" THEN Selected ELSE Applicable)}
NextArgs == NextArgsOf(Chosen)
(* Term 82 for the state this stop leaves; F2 limits the 163 clause to rule scatter. *)
PrevResultCond ==
  /\ ~H("inputChanged") /\ H("attrDone")
  /\ \/ (H("targetDefect") /\ (R152 \/ R153 \/ (H("nonConv") /\ "F2" \notin Fixes /\ ~H("budgetHit"))))
     \/ T163s

Init == f \in {s \in SUBSET Flags : Constraint(s)}
Next == UNCHANGED vars
Spec == Init /\ [][Next]_vars

TypeOK == f \subseteq Flags
ExactlyOneRow == StopRequired => Cardinality(Selected) = 1
LimitWhenBudget ==
  (H("budgetHit") /\ ~H("inputChanged") /\ ~H("ledgerFail") /\ ~H("miscFail")
   /\ ~H("recSaveFail") /\ ~H("stopRecFail")) => Selected = {"IterLimit"}
InputChangeIsFailure == (H("inputChanged") /\ ~H("stopRecFail")) => Selected = {"Failure"}
DefectFirst == (DefectRow /\ ~H("inputChanged") /\ ~H("stopRecFail")) => Selected = {"Defect"}
StopRecFirst == H("stopRecFail") => Selected = {"StopRec"}
FailureBeforeSave == (FailureRow /\ H("recSaveFail") /\ ~H("stopRecFail") /\ ~DefectRow) => Selected = {"Failure"}
CompleteOnlyClean == "Complete" \in Selected => Applicable \cap Blocked = {}
NoUnsavedRecordClaimed == (Cardinality(Selected) = 1 /\ RangeCol = "written") => ~H("recSaveFail") /\ ~H("stopRecFail")
EveryUnsavedScopeReturned == Cardinality(Selected) = 1 => {x \in {"ledgerFail", "recSaveFail"} : H(x)} \subseteq ReturnedSaveFailures
NextArgsOnlyIfContinuable == (Cardinality(Selected) = 1 /\ Selected # {"StopRec"} /\ NextArgs) => ~PrevResultCond

WitnessComplete == Selected # {"Complete"}
WitnessIterLimit == Selected # {"IterLimit"}
WitnessDefect == Selected # {"Defect"}
WitnessFailure == Selected # {"Failure"}
WitnessSaveFail == Selected # {"SaveFail"}
WitnessStopRec == Selected # {"StopRec"}
WitnessDefectWithFailure == ~(DefectRow /\ FailureRow /\ Selected = {"Defect"})
=============================================================================
