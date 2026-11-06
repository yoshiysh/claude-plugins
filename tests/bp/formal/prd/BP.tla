----------------------------- MODULE BP -----------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Mutation, MaxRuns
VARIABLES phase, verification, persistence, records, everSaved, deleteRequested,
          hint, planAccepted, reason, reported, repaired, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, saveFailureReason, reportedSaveFailureReason,
          dryStreak, stopCause, passed, dryRoundsObserved
vars == <<phase, verification, persistence, records, everSaved, deleteRequested,
          hint, planAccepted, reason, reported, repaired, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, saveFailureReason, reportedSaveFailureReason,
          dryStreak, stopCause, passed, dryRoundsObserved>>
Stopped == {"blocked", "needs_input", "dry", "limit"}
DryK == 2
Init == /\ phase = "planning" /\ verification = "pending" /\ persistence = "pending"
        /\ records = {} /\ everSaved = {} /\ deleteRequested = FALSE
        /\ hint = "none" /\ planAccepted = FALSE /\ directWrite = FALSE /\ hintOnStop = FALSE /\ needsInputSeen = FALSE /\ hintBlocked = FALSE
        /\ reason = "none" /\ reported = FALSE /\ repaired = FALSE /\ run = 1
        /\ missing = {} /\ reportedReason = "none" /\ reportedMissing = {} /\ hintStopKind = "none" /\ fullySaved = {} /\ partialRuns = {} /\ saveFailureReason = "none" /\ reportedSaveFailureReason = "none"
        /\ dryStreak = 0 /\ stopCause = "none" /\ passed = {} /\ dryRoundsObserved = 0
AddHint == /\ phase # "done" /\ hint = "none" /\ ~(Mutation = "no_hint_after_stop" /\ phase \in Stopped) /\ hint' = "unread"
  /\ hintOnStop' = (phase \in Stopped) /\ hintBlocked' = (phase = "blocked")
  /\ hintStopKind' = (IF phase \in Stopped THEN phase ELSE "none")
  /\ UNCHANGED <<phase, verification, persistence, records, everSaved, deleteRequested, planAccepted, reason, reported, repaired, run, directWrite, needsInputSeen, missing, reportedReason, reportedMissing, fullySaved, partialRuns, saveFailureReason, reportedSaveFailureReason, dryStreak, stopCause, passed, dryRoundsObserved>>
Deliver == /\ phase = "planning" /\ hint = "unread" /\ hint' = (IF Mutation = "premature_hint_read" THEN "read" ELSE "delivered")
  /\ UNCHANGED <<phase, verification, persistence, records, everSaved, deleteRequested, planAccepted, reason, reported, repaired, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, saveFailureReason, reportedSaveFailureReason, dryStreak, stopCause, passed, dryRoundsObserved>>
AcceptPlan == /\ phase = "planning" /\ hint # "unread" /\ phase' = "running" /\ planAccepted' = (Mutation # "wrong_accept_plan_result")
  /\ hint' = (IF hint = "delivered" THEN "read" ELSE hint) /\ passed' = {} /\ dryStreak' = 0 /\ dryRoundsObserved' = 0
  /\ UNCHANGED <<verification, persistence, records, everSaved, deleteRequested, reason, reported, repaired, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, saveFailureReason, reportedSaveFailureReason, stopCause>>
PlanFailed == /\ phase = "planning" /\ phase' = (IF Mutation = "wrong_plan_failure_result" THEN "needs_input" ELSE "blocked") /\ reason' = (IF Mutation = "wrong_plan_failure_result" THEN "needs_input" ELSE "planner") /\ reported' = FALSE /\ repaired' = FALSE
  /\ hint' = (IF hint = "delivered" THEN "unread" ELSE hint) /\ stopCause' = "planner"
  /\ UNCHANGED <<verification, persistence, records, everSaved, deleteRequested, planAccepted, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, saveFailureReason, reportedSaveFailureReason, dryStreak, passed, dryRoundsObserved>>
NeedsInput == /\ phase \in {"planning", "running"} /\ phase' = (IF Mutation = "wrong_needs_input_result" THEN "blocked" ELSE "needs_input")
  /\ reason' = "needs_input" /\ reported' = FALSE /\ repaired' = FALSE /\ needsInputSeen' = TRUE
  /\ hint' = (IF hint = "delivered" THEN "unread" ELSE hint) /\ stopCause' = "needs_input"
  /\ UNCHANGED <<verification, persistence, records, everSaved, deleteRequested, planAccepted, run, directWrite, hintOnStop, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, saveFailureReason, reportedSaveFailureReason, dryStreak, passed, dryRoundsObserved>>
DryRound == /\ phase = "planning" /\ dryStreak < DryK /\ dryStreak' = dryStreak + 1 /\ dryRoundsObserved' = dryRoundsObserved + 1
  /\ UNCHANGED <<phase, verification, persistence, records, everSaved, deleteRequested, hint, planAccepted, reason, reported, repaired, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, saveFailureReason, reportedSaveFailureReason, stopCause, passed>>
DryStop == /\ phase = "planning" /\ (IF Mutation = "dry_blocks_read_hint" THEN hint = "none" ELSE hint \notin {"unread", "delivered"} \/ Mutation = "dry_ignores_hint") /\ dryStreak >= (IF Mutation = "dry_k1" THEN 1 ELSE DryK)
  /\ phase' = "dry" /\ reason' = "dry" /\ reported' = FALSE /\ repaired' = FALSE /\ stopCause' = "dry"
  /\ UNCHANGED <<verification, persistence, records, everSaved, deleteRequested, hint, planAccepted, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, saveFailureReason, reportedSaveFailureReason, dryStreak, passed, dryRoundsObserved>>
LimitStop == /\ phase \in {"planning", "running"}
  /\ phase' = "limit" /\ reason' = (IF Mutation = "stop_without_reason" THEN "none" ELSE "limit") /\ reported' = FALSE /\ repaired' = FALSE
  /\ hint' = (IF hint = "delivered" THEN "unread" ELSE hint) /\ stopCause' = "limit"
  /\ UNCHANGED <<verification, persistence, records, everSaved, deleteRequested, planAccepted, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, saveFailureReason, reportedSaveFailureReason, dryStreak, passed, dryRoundsObserved>>
ReplanForHint == /\ phase = "running" /\ hint = "unread" /\ phase' = "planning" /\ planAccepted' = FALSE
  /\ verification' = (IF Mutation = "replan_keeps_results" THEN verification ELSE "pending")
  /\ persistence' = (IF Mutation = "replan_keeps_results" THEN persistence ELSE "pending")
  /\ fullySaved' = (IF Mutation = "replan_keeps_full_save" THEN fullySaved ELSE fullySaved \ {run}) /\ passed' = {}
  /\ UNCHANGED <<records, everSaved, deleteRequested, hint, reason, reported, repaired, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, partialRuns, saveFailureReason, reportedSaveFailureReason, dryStreak, stopCause, dryRoundsObserved>>
VerifyPass == /\ phase = "running" /\ verification = "pending" /\ verification' = "pass" /\ passed' = passed \cup {"verify"}
  /\ UNCHANGED <<phase, persistence, records, everSaved, deleteRequested, hint, planAccepted, reason, reported, repaired, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, saveFailureReason, reportedSaveFailureReason, dryStreak, stopCause, dryRoundsObserved>>
VerifyFail == /\ phase = "running" /\ verification = "pending" /\ verification' = (IF Mutation = "wrong_verify_failure_result" THEN "pass" ELSE "fail")
  /\ phase' = (IF Mutation = "no_stop_verification" THEN "running" ELSE "blocked")
  /\ reason' = "verify" /\ reported' = FALSE /\ repaired' = FALSE /\ stopCause' = "verify"
  /\ UNCHANGED <<persistence, records, everSaved, deleteRequested, hint, planAccepted, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, saveFailureReason, reportedSaveFailureReason, dryStreak, passed, dryRoundsObserved>>
Verify == VerifyPass \/ VerifyFail
PartialSave == /\ phase = "running" /\ persistence = "pending" /\ run \notin records
  /\ records' = records \cup {run} /\ everSaved' = everSaved \cup {run} /\ partialRuns' = partialRuns \cup {run}
  /\ UNCHANGED <<phase, verification, persistence, deleteRequested, hint, planAccepted, reason, reported, repaired, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, fullySaved, saveFailureReason, reportedSaveFailureReason, dryStreak, stopCause, passed, dryRoundsObserved>>
SavePass == /\ phase = "running" /\ persistence = "pending" /\ persistence' = "pass" /\ passed' = passed \cup {"save"}
  /\ records' = records \cup {IF Mutation = "wrong_run_saved" THEN 1 ELSE run} /\ everSaved' = everSaved \cup {IF Mutation = "wrong_run_saved" THEN 1 ELSE run}
  /\ fullySaved' = fullySaved \cup {IF Mutation = "wrong_run_saved" THEN 1 ELSE run}
  /\ UNCHANGED <<phase, verification, deleteRequested, hint, planAccepted, reason, reported, repaired, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, partialRuns, saveFailureReason, reportedSaveFailureReason, dryStreak, stopCause, dryRoundsObserved>>
SaveFail == /\ phase = "running" /\ persistence = "pending" /\ persistence' = (IF Mutation = "wrong_save_failure_result" THEN "pass" ELSE "fail")
  /\ phase' = (IF Mutation = "no_stop_save" THEN "running" ELSE "blocked")
  /\ reason' = "save" /\ reported' = FALSE /\ repaired' = FALSE /\ stopCause' = "save"
  /\ records' = (IF Mutation = "partial_save_loss" THEN {} ELSE records)
  /\ missing' = missing \cup {run} /\ saveFailureReason' = (IF Mutation = "save_failure_reason_dropped" THEN saveFailureReason ELSE "storage")
  /\ UNCHANGED <<verification, everSaved, deleteRequested, hint, planAccepted, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, reportedSaveFailureReason, dryStreak, passed, dryRoundsObserved>>
Save == SavePass \/ SaveFail
Complete == /\ phase = "running" /\ (hint \notin {"unread", "delivered"} \/ Mutation = "complete_with_unread_hint")
  /\ (\/ verification = "pass" /\ persistence = "pass"
      \/ Mutation = "premature_complete" /\ persistence = "pass"
      \/ Mutation = "premature_persistence" /\ verification = "pass")
  /\ phase' = "done"
  /\ UNCHANGED <<verification, persistence, records, everSaved, deleteRequested, hint, planAccepted, reason, reported, repaired, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, saveFailureReason, reportedSaveFailureReason, dryStreak, stopCause, passed, dryRoundsObserved>>
StopSave == /\ phase \in Stopped /\ run \notin fullySaved /\ run \notin missing
  /\ records' = records \cup {run} /\ everSaved' = everSaved \cup {run} /\ fullySaved' = fullySaved \cup {run} /\ passed' = passed \cup {"save"}
  /\ UNCHANGED <<phase, verification, persistence, deleteRequested, hint, planAccepted, reason, reported, repaired, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, partialRuns, saveFailureReason, reportedSaveFailureReason, dryStreak, stopCause, dryRoundsObserved>>
StopSaveFail == /\ phase \in Stopped /\ run \notin fullySaved /\ run \notin missing
  /\ missing' = missing \cup {run} /\ saveFailureReason' = "storage"
  /\ UNCHANGED <<phase, verification, persistence, records, everSaved, deleteRequested, hint, planAccepted, reason, reported, repaired, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, reportedSaveFailureReason, dryStreak, stopCause, passed, dryRoundsObserved>>
Report == /\ phase \in Stopped /\ ~reported
  /\ (run \in fullySaved \/ run \in missing \/ Mutation = "report_without_stop_record" \/ (Mutation = "premature_partial_report" /\ run \in records)) /\ reported' = TRUE
  /\ reportedReason' = (IF Mutation = "wrong_report_reason" THEN "wrong" ELSE reason)
  /\ reportedMissing' = (IF Mutation = "missing_report_omitted" THEN {} ELSE missing)
  /\ reportedSaveFailureReason' = (IF Mutation = "wrong_save_failure_report" THEN "wrong" ELSE IF Mutation = "omit_save_failure_report" THEN "none" ELSE saveFailureReason)
  /\ UNCHANGED <<phase, verification, persistence, records, everSaved, deleteRequested, hint, planAccepted, reason, repaired, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, hintStopKind, fullySaved, partialRuns, saveFailureReason, dryStreak, stopCause, passed, dryRoundsObserved>>
Repair == /\ phase \in {"blocked", "dry", "limit"} /\ (reported \/ Mutation = "resume_without_report") /\ ~repaired /\ repaired' = TRUE
  /\ UNCHANGED <<phase, verification, persistence, records, everSaved, deleteRequested, hint, planAccepted, reason, reported, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, saveFailureReason, reportedSaveFailureReason, dryStreak, stopCause, passed, dryRoundsObserved>>
Answer == /\ phase = "needs_input" /\ reported /\ ~repaired /\ repaired' = TRUE
  /\ UNCHANGED <<phase, verification, persistence, records, everSaved, deleteRequested, hint, planAccepted, reason, reported, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, saveFailureReason, reportedSaveFailureReason, dryStreak, stopCause, passed, dryRoundsObserved>>
Resume == /\ phase \in Stopped /\ (reported \/ Mutation = "resume_without_report")
  /\ (repaired \/ Mutation = "resume_without_repair") /\ run < MaxRuns /\ Mutation # "no_resume"
  /\ phase' = "planning" /\ run' = (IF Mutation = "wrong_resume_result" THEN run ELSE run + 1) /\ planAccepted' = FALSE
  /\ verification' = "pending"
  /\ persistence' = "pending"
  /\ reason' = "none" /\ reported' = FALSE /\ repaired' = FALSE
  /\ reportedReason' = "none" /\ reportedMissing' = {} /\ reportedSaveFailureReason' = "none"
  /\ dryStreak' = (IF Mutation = "dry_streak_carried" THEN dryStreak ELSE 0) /\ stopCause' = "none" /\ dryRoundsObserved' = 0 /\ passed' = {}
  /\ UNCHANGED <<records, everSaved, deleteRequested, hint, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, hintStopKind, fullySaved, partialRuns, saveFailureReason>>
RequestDelete == /\ ~deleteRequested /\ deleteRequested' = TRUE
  /\ UNCHANGED <<phase, verification, persistence, records, everSaved, hint, planAccepted, reason, reported, repaired, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, saveFailureReason, reportedSaveFailureReason, dryStreak, stopCause, passed, dryRoundsObserved>>
Delete == /\ records # {} /\ (deleteRequested \/ Mutation = "unrequested_deletion") /\ records' = {}
  /\ UNCHANGED <<phase, verification, persistence, everSaved, deleteRequested, hint, planAccepted, reason, reported, repaired, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, saveFailureReason, reportedSaveFailureReason, dryStreak, stopCause, passed, dryRoundsObserved>>
DirectWrite == /\ Mutation = "direct_ledger_write" /\ phase = "running" /\ directWrite' = TRUE
  /\ UNCHANGED <<phase, verification, persistence, records, everSaved, deleteRequested, hint, planAccepted, reason, reported, repaired, run, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, saveFailureReason, reportedSaveFailureReason, dryStreak, stopCause, passed, dryRoundsObserved>>
GhostStart == /\ Mutation = "ghost_start" /\ phase = "planning" /\ phase' = "running"
  /\ UNCHANGED <<verification, persistence, records, everSaved, deleteRequested, hint, planAccepted, reason, reported, repaired, run, directWrite, hintOnStop, needsInputSeen, hintBlocked, missing, reportedReason, reportedMissing, hintStopKind, fullySaved, partialRuns, saveFailureReason, reportedSaveFailureReason, dryStreak, stopCause, passed, dryRoundsObserved>>
StepAddHint == /\ Mutation # "omit_AddHint" /\ AddHint
StepDeliver == /\ Mutation # "omit_Deliver" /\ Deliver
StepAcceptPlan == /\ Mutation # "omit_AcceptPlan" /\ AcceptPlan
StepPlanFailed == /\ Mutation # "omit_PlanFailed" /\ PlanFailed
StepNeedsInput == /\ Mutation # "omit_NeedsInput" /\ NeedsInput
StepDryRound == /\ Mutation # "omit_DryRound" /\ DryRound
StepDryStop == /\ Mutation # "omit_DryStop" /\ DryStop
StepLimitStop == /\ Mutation # "omit_LimitStop" /\ LimitStop
StepReplanForHint == /\ Mutation # "omit_ReplanForHint" /\ ReplanForHint
StepVerifyPass == /\ Mutation # "omit_VerifyPass" /\ VerifyPass
StepVerifyFail == /\ Mutation # "omit_VerifyFail" /\ VerifyFail
StepPartialSave == /\ Mutation # "omit_PartialSave" /\ PartialSave
StepSavePass == /\ Mutation # "omit_SavePass" /\ SavePass
StepSaveFail == /\ Mutation # "omit_SaveFail" /\ SaveFail
StepComplete == /\ Mutation # "omit_Complete" /\ Complete
StepStopSave == /\ Mutation # "omit_StopSave" /\ StopSave
StepStopSaveFail == /\ Mutation # "omit_StopSaveFail" /\ StopSaveFail
StepReport == /\ Mutation # "omit_Report" /\ Report
StepRepair == /\ Mutation # "omit_Repair" /\ Repair
StepAnswer == /\ Mutation # "omit_Answer" /\ Answer
StepResume == /\ Mutation # "omit_Resume" /\ Resume
StepRequestDelete == /\ Mutation # "omit_RequestDelete" /\ RequestDelete
StepDelete == /\ Mutation # "omit_Delete" /\ Delete
Next == StepAddHint \/ StepDeliver \/ StepAcceptPlan \/ StepPlanFailed \/ StepNeedsInput \/ StepDryRound \/ StepDryStop \/ StepLimitStop \/ StepReplanForHint \/ StepVerifyPass \/ StepVerifyFail \/ StepPartialSave \/ StepSavePass \/ StepSaveFail \/ StepComplete \/ StepStopSave \/ StepStopSaveFail \/ StepReport \/ StepRepair \/ StepAnswer \/ StepResume \/ StepRequestDelete \/ StepDelete \/ DirectWrite \/ GhostStart
Allowed == AddHint \/ Deliver \/ AcceptPlan \/ PlanFailed \/ NeedsInput \/ DryRound \/ DryStop \/ LimitStop \/ ReplanForHint \/ VerifyPass \/ VerifyFail \/ PartialSave \/ SavePass \/ SaveFail \/ Complete \/ StopSave \/ StopSaveFail \/ Report \/ Repair \/ Answer \/ Resume \/ RequestDelete \/ Delete
NoUnspecifiedTransitions == ~ENABLED (Next /\ ~Allowed)
TypeOK == /\ phase \in {"planning", "running", "blocked", "needs_input", "dry", "limit", "done"}
  /\ verification \in {"pending", "pass", "fail"} /\ persistence \in {"pending", "pass", "fail"}
  /\ records \subseteq 1..MaxRuns /\ everSaved \subseteq 1..MaxRuns /\ deleteRequested \in BOOLEAN
  /\ planAccepted \in BOOLEAN /\ directWrite \in BOOLEAN /\ hintOnStop \in BOOLEAN /\ needsInputSeen \in BOOLEAN /\ hintBlocked \in BOOLEAN /\ hint \in {"none", "unread", "delivered", "read"}
  /\ reason \in {"none", "planner", "verify", "save", "needs_input", "dry", "limit"}
  /\ reportedReason \in {"none", "planner", "verify", "save", "needs_input", "dry", "limit", "wrong"}
  /\ missing \subseteq 1..MaxRuns /\ reportedMissing \subseteq 1..MaxRuns /\ reported \in BOOLEAN /\ repaired \in BOOLEAN /\ run \in 1..MaxRuns
  /\ hintStopKind \in {"none", "blocked", "needs_input", "dry", "limit"}
  /\ fullySaved \subseteq everSaved /\ partialRuns \subseteq 1..MaxRuns
  /\ saveFailureReason \in {"none", "storage"} /\ reportedSaveFailureReason \in {"none", "storage", "wrong"}
  /\ dryStreak \in 0..DryK /\ dryRoundsObserved \in 0..DryK
  /\ stopCause \in {"none", "planner", "verify", "save", "needs_input", "dry", "limit"} /\ passed \subseteq {"verify", "save"}
CompleteRequiresVerifiedAndPersisted == phase = "done" => verification = "pass" /\ persistence = "pass"
CompleteHasCurrentRunRecord == phase = "done" => run \in fullySaved /\ (deleteRequested \/ run \in records)
RunningRequiresAcceptedPlan == phase = "running" => planAccepted
StopReportHasRecordedOrMissing == reported => (run \in fullySaved \/ run \in reportedMissing)
VerificationFailureStops == verification = "fail" => phase = "blocked"
SaveFailureStops == persistence = "fail" => phase = "blocked"
RetentionWithoutDeleteRequest == ~deleteRequested => records = everSaved
StopHasReason == phase \in Stopped => reason # "none"
HintReadOnlyAfterAccept == [][((hint # "read" /\ hint' = "read") => (phase = "planning" /\ phase' = "running" /\ planAccepted'))]_vars
NoUnreadHintOnCompletion == phase = "done" => hint \notin {"unread", "delivered"}
CompletionAfterChecksOfAcceptedPlan == phase = "done" => passed = {"verify", "save"}
RecordedPassHappened == /\ (verification = "pass" => "verify" \in passed)
                        /\ (persistence = "pass" => "save" \in passed)
StopKindFor(cause) == IF cause \in {"planner", "verify", "save"} THEN "blocked" ELSE cause
StopMatchesCause == stopCause # "none" => phase = StopKindFor(stopCause) /\ reason = stopCause
ResumeStartsNewRun == [][((phase \in Stopped /\ phase' = "planning") => run' \notin everSaved \cup missing)]_vars
DryStopAfterTwoDryRounds == phase = "dry" => dryRoundsObserved >= 2
DryStopWithoutUnreadHint == [][((phase # "dry" /\ phase' = "dry") => hint \notin {"unread", "delivered"})]_vars
SavedOrMissingExclusive == ~(run \in fullySaved /\ run \in missing)
StopReportReflectsCurrentSave == reported => ("save" \in passed \/ run \in reportedMissing)
EventContract ==
  /\ (phase # "done" /\ hint = "none") => ENABLED (Next /\ AddHint)
  /\ (phase = "planning" /\ hint = "unread") => ENABLED (Next /\ Deliver)
  /\ (phase = "planning" /\ hint # "unread") => ENABLED (Next /\ AcceptPlan)
  /\ (phase = "planning") => ENABLED (Next /\ PlanFailed)
  /\ (phase \in {"planning", "running"}) => ENABLED (Next /\ NeedsInput)
  /\ (phase = "planning" /\ dryStreak < DryK) => ENABLED (Next /\ DryRound)
  /\ (phase = "planning" /\ hint \notin {"unread", "delivered"} /\ dryStreak >= DryK) => ENABLED (Next /\ DryStop)
  /\ (phase \in {"planning", "running"}) => ENABLED (Next /\ LimitStop)
  /\ (phase = "running" /\ hint = "unread") => ENABLED (Next /\ ReplanForHint)
  /\ (phase = "running" /\ verification = "pending") => ENABLED (Next /\ VerifyPass)
  /\ (phase = "running" /\ verification = "pending") => ENABLED (Next /\ VerifyFail)
  /\ (phase = "running" /\ persistence = "pending" /\ run \notin records) => ENABLED (Next /\ PartialSave)
  /\ (phase = "running" /\ persistence = "pending") => ENABLED (Next /\ SavePass)
  /\ (phase = "running" /\ persistence = "pending") => ENABLED (Next /\ SaveFail)
  /\ (phase = "running" /\ hint \notin {"unread", "delivered"} /\ verification = "pass" /\ persistence = "pass") => ENABLED (Next /\ Complete)
  /\ (phase \in Stopped /\ run \notin fullySaved /\ run \notin missing) => ENABLED (Next /\ StopSave)
  /\ (phase \in Stopped /\ run \notin fullySaved /\ run \notin missing) => ENABLED (Next /\ StopSaveFail)
  /\ (phase \in Stopped /\ ~reported /\ (run \in fullySaved \/ run \in missing)) => ENABLED (Next /\ Report)
  /\ (phase \in {"blocked", "dry", "limit"} /\ reported /\ ~repaired) => ENABLED (Next /\ Repair)
  /\ (phase = "needs_input" /\ reported /\ ~repaired) => ENABLED (Next /\ Answer)
  /\ (phase \in Stopped /\ reported /\ repaired /\ run < MaxRuns) => ENABLED (Next /\ Resume)
  /\ (~deleteRequested) => ENABLED (Next /\ RequestDelete)
  /\ (records # {} /\ deleteRequested) => ENABLED (Next /\ Delete)
OutcomeContract ==
  /\ ~ENABLED (Next /\ AddHint /\ ~(hint' = "unread" /\ hintOnStop' = (phase \in Stopped) /\ hintBlocked' = (phase = "blocked") /\ hintStopKind' = (IF phase \in Stopped THEN phase ELSE "none")))
  /\ ~ENABLED (Next /\ Deliver /\ ~(hint' = "delivered"))
  /\ ~ENABLED (Next /\ AcceptPlan /\ ~(phase' = "running" /\ planAccepted' = TRUE /\ hint' = (IF hint = "delivered" THEN "read" ELSE hint) /\ dryStreak' = 0))
  /\ ~ENABLED (Next /\ PlanFailed /\ ~(phase' = "blocked" /\ reason' = "planner" /\ ~reported' /\ ~repaired' /\ hint' = (IF hint = "delivered" THEN "unread" ELSE hint)))
  /\ ~ENABLED (Next /\ NeedsInput /\ ~(phase' = "needs_input" /\ reason' = "needs_input" /\ ~reported' /\ ~repaired' /\ needsInputSeen' /\ hint' = (IF hint = "delivered" THEN "unread" ELSE hint)))
  /\ ~ENABLED (Next /\ DryRound /\ ~(dryStreak' = dryStreak + 1))
  /\ ~ENABLED (Next /\ DryStop /\ ~(phase' = "dry" /\ reason' = "dry" /\ ~reported' /\ ~repaired'))
  /\ ~ENABLED (Next /\ LimitStop /\ ~(phase' = "limit" /\ reason' = "limit" /\ ~reported' /\ ~repaired' /\ hint' = (IF hint = "delivered" THEN "unread" ELSE hint)))
  /\ ~ENABLED (Next /\ ReplanForHint /\ ~(phase' = "planning" /\ ~planAccepted' /\ verification' = "pending" /\ persistence' = "pending" /\ fullySaved' = fullySaved \ {run}))
  /\ ~ENABLED (Next /\ VerifyPass /\ ~(verification' = "pass"))
  /\ ~ENABLED (Next /\ VerifyFail /\ ~(verification' = "fail" /\ phase' = "blocked" /\ reason' = "verify" /\ ~reported' /\ ~repaired'))
  /\ ~ENABLED (Next /\ PartialSave /\ ~(records' = records \cup {run} /\ everSaved' = everSaved \cup {run} /\ partialRuns' = partialRuns \cup {run}))
  /\ ~ENABLED (Next /\ SavePass /\ ~(persistence' = "pass" /\ records' = records \cup {run} /\ everSaved' = everSaved \cup {run} /\ fullySaved' = fullySaved \cup {run} /\ missing' = missing /\ saveFailureReason' = saveFailureReason))
  /\ ~ENABLED (Next /\ SaveFail /\ ~(persistence' = "fail" /\ phase' = "blocked" /\ reason' = "save" /\ ~reported' /\ ~repaired' /\ records' = records /\ missing' = missing \cup {run} /\ saveFailureReason' = "storage"))
  /\ ~ENABLED (Next /\ Complete /\ ~(phase' = "done"))
  /\ ~ENABLED (Next /\ StopSave /\ ~(records' = records \cup {run} /\ everSaved' = everSaved \cup {run} /\ fullySaved' = fullySaved \cup {run}))
  /\ ~ENABLED (Next /\ StopSaveFail /\ ~(missing' = missing \cup {run} /\ saveFailureReason' = "storage"))
  /\ ~ENABLED (Next /\ Report /\ ~(reported' /\ reportedReason' = reason /\ reportedMissing' = missing /\ reportedSaveFailureReason' = saveFailureReason))
  /\ ~ENABLED (Next /\ Repair /\ ~(repaired'))
  /\ ~ENABLED (Next /\ Answer /\ ~(repaired'))
  /\ ~ENABLED (Next /\ Resume /\ ~(phase' = "planning" /\ run' = run + 1 /\ ~planAccepted' /\ verification' = "pending" /\ persistence' = "pending" /\ reason' = "none" /\ ~reported' /\ ~repaired' /\ dryStreak' = 0))
  /\ ~ENABLED (Next /\ RequestDelete /\ ~(deleteRequested'))
  /\ ~ENABLED (Next /\ Delete /\ ~(records' = {}))
ReportAccurate == reported => (reportedReason = reason /\ reportedMissing = missing /\ reportedSaveFailureReason = saveFailureReason)
SaveFailureReasonConsistent == (missing = {}) <=> (saveFailureReason = "none")
NoDirectWrite == ~directWrite
ResumeOnlyAfterReportAndRepair == [][((phase \in Stopped /\ phase' = "planning") => (reported /\ repaired))]_vars
PlanStep == Deliver \/ AcceptPlan \/ PlanFailed
Spec == Init /\ [][Next]_vars /\ WF_vars(PlanStep) /\ WF_vars(ReplanForHint)
        /\ WF_vars(Verify) /\ WF_vars(Save) /\ WF_vars(Complete)
        /\ WF_vars(StopSave \/ StopSaveFail) /\ WF_vars(Report) /\ WF_vars(Resume)
SpecWithoutFair == Init /\ [][Next]_vars
Progress == [](phase \in {"planning", "running"} => <> (phase \in Stopped \union {"done"}))
StopReported == [](phase \in Stopped /\ ~reported => <> reported)
ResumeProgress == []((phase \in Stopped /\ reported /\ repaired /\ run < MaxRuns) => <> (phase = "planning"))
WitnessHintResume == ~(run = 2 /\ phase = "running" /\ hint = "read" /\ hintBlocked)
WitnessNeedsInputResume == ~(run = 2 /\ phase = "running" /\ hint = "read" /\ hintOnStop /\ needsInputSeen)
WitnessDryResume == ~(run = 2 /\ phase = "running" /\ hint = "read" /\ hintStopKind = "dry")
WitnessLimitResume == ~(run = 2 /\ phase = "running" /\ hint = "read" /\ hintStopKind = "limit")
WitnessPartialStopSave == ~(phase = "needs_input" /\ reported /\ run \in partialRuns /\ run \in fullySaved)
WitnessPartialStopFailure == ~(phase = "needs_input" /\ reported /\ run \in partialRuns /\ run \notin fullySaved /\ run \in reportedMissing)
WitnessTwoRunsRecords == ~(run = 2 /\ 1 \in records /\ 2 \in records)
WitnessPartialSaveFailure == ~(phase = "blocked" /\ reason = "save" /\ records # {} /\ run \in partialRuns)
WitnessCompleteAfterHint == ~(phase = "done" /\ hint = "read" /\ ~hintOnStop)
WitnessDryInResumedRun == ~(run = 2 /\ phase = "dry")
WitnessDryAfterReadHint == ~(phase = "dry" /\ hint = "read")
=============================================================================
