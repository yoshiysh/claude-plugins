#!/bin/sh
set -eu
if [ -n "${TLC_DOT:-}" ]; then
  case "$TLC_DOT" in
    /*) ;;
    *) echo 'TLC_DOT must be an absolute path' >&2; exit 1 ;;
  esac
fi
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$base/../../.." && pwd)
cases="$base/tlc_cases.sh"
sh "$cases" jobs > /dev/null
jar=${TLA2TOOLS:?Set TLA2TOOLS to the pinned tla2tools.jar}
JAVA=${JAVA:-java}
export JAVA TLA2TOOLS
rustc=${RUSTC:-rustc}
expected_jar=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
actual_jar=$(shasum -a 256 "$jar" | cut -d ' ' -f 1)
[ "$actual_jar" = "$expected_jar" ] || { echo "Unexpected TLC jar SHA-256" >&2; exit 1; }
sh "$base/prd_sections.sh" check "$root" "$base/PRD.sections"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/bp-prd-tlc.XXXXXX")
rustc_pid=
cleanup() {
  if [ -n "$rustc_pid" ]; then kill "$rustc_pid" 2> /dev/null || true; wait "$rustc_pid" 2> /dev/null || true; fi
  # An interrupted pool can leave TLC workers writing into $tmp while it is being removed.
  attempt=0
  until rm -rf "$tmp" 2> /dev/null || [ "$attempt" -ge 5 ]; do attempt=$((attempt + 1)); sleep 1; done
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cp "$base/BP.tla" "$base/BP.cfg" "$tmp/"
cd "$tmp"
invariant_violation=12
temporal_violation=13
success=0
success_message='Model checking completed. No error has been found.'
: > baseline.list; : > three.list; : > cases.list
add_case() {
  list=$1 id=$2 module=$3 code=$4 message=$5 label=$6 okline=$7 dump=${8:-}
  printf '%s\n' "$module" "$code" "$message" "$label" "$okline" "$dump" > "$id.case"
  echo "$id" >> "$list"
}
mutate() {
  sed "s/Mutation = \"none\"/Mutation = \"$1\"/; s/^INVARIANTS .*/INVARIANTS $2/; /^PROPERTIES /d" BP.cfg > "$3.cfg"
}
cp BP.cfg baseline.cfg
add_case baseline.list baseline BP "$success" "$success_message" 'Expected successful baseline' '' graph.dot
cat > BPMaxRuns.tla <<'TLA'
-------------------------- MODULE BPMaxRuns --------------------------
EXTENDS BP
NextThree ==
  \/ /\ phase = "planning" /\ AcceptPlan
  \/ /\ phase = "running" /\ VerifyFail
  \/ /\ phase = "blocked" /\ run \notin fullySaved /\ StopSave
  \/ /\ phase = "blocked" /\ run \in fullySaved /\ ~reported /\ Report
  \/ /\ phase = "blocked" /\ reported /\ ~repaired /\ Repair
  \/ /\ phase = "blocked" /\ reported /\ repaired /\ run < MaxRuns /\ Resume
WitnessThree == ~(run = 3 /\ 3 \in records)
======================================================================
TLA
cat > three-runs.cfg <<'CFG'
CONSTANTS Mutation = "none" MaxRuns = 3
INIT Init
NEXT NextThree
INVARIANTS TypeOK
CHECK_DEADLOCK FALSE
CFG
add_case three.list three-runs BPMaxRuns "$success" "$success_message" 'Expected TypeOK with three runs' ''
sed 's/INVARIANTS TypeOK/INVARIANTS WitnessThree/' three-runs.cfg > witness-three.cfg
add_case three.list witness-three BPMaxRuns "$invariant_violation" 'Invariant WitnessThree is violated' 'Expected a record for the third run' 'TypeOK accepts a reachable third-run record'
for case in \
  no_stop_verification:VerificationFailureStops \
  no_stop_save:SaveFailureStops \
  premature_complete:CompleteRequiresVerifiedAndPersisted \
  premature_persistence:CompleteRequiresVerifiedAndPersisted \
  partial_save_loss:RetentionWithoutDeleteRequest \
  unrequested_deletion:RetentionWithoutDeleteRequest \
  direct_ledger_write:NoDirectWrite \
  wrong_run_saved:CompleteHasCurrentRunRecord \
  report_without_stop_record:StopReportHasRecordedOrMissing \
  premature_partial_report:StopReportHasRecordedOrMissing \
  wrong_report_reason:ReportAccurate \
  wrong_save_failure_report:ReportAccurate \
  omit_save_failure_report:ReportAccurate \
  missing_report_omitted:ReportAccurate \
  stop_without_reason:StopHasReason \
  complete_with_unread_hint:NoUnreadHintOnCompletion \
  save_failure_reason_dropped:SaveFailureReasonConsistent; do
  name=${case%%:*}; invariant=${case#*:}
  mutate "$name" "$invariant" "invariant-$name"
  add_case cases.list "invariant-$name" BP "$invariant_violation" "Invariant $invariant is violated" "Expected counterexample for $name ($invariant)" "$name: expected counterexample ($invariant)"
done
for invariant in NoUnspecifiedTransitions RunningRequiresAcceptedPlan; do
  mutate ghost_start "$invariant" "ghost-$invariant"
  add_case cases.list "ghost-$invariant" BP "$invariant_violation" "Invariant $invariant is violated" "Expected ghost transition counterexample ($invariant)" "ghost_start: expected counterexample ($invariant)"
done
for action in AddHint Deliver AcceptPlan PlanFailed NeedsInput DryRound DryStop LimitStop ReplanForHint VerifyPass VerifyFail PartialSave SavePass SaveFail Complete StopSave StopSaveFail Report Repair Answer Resume RequestDelete Delete; do
  mutate "omit_$action" EventContract "omit_$action"
  add_case cases.list "omit_$action" BP "$invariant_violation" 'Invariant EventContract is violated' "Expected missing-event counterexample for $action" "omit_$action: missing required transition detected"
done
for case in wrong_plan_failure_result wrong_needs_input_result wrong_accept_plan_result wrong_verify_failure_result wrong_save_failure_result wrong_resume_result wrong_report_reason missing_report_omitted wrong_save_failure_report omit_save_failure_report replan_keeps_results replan_keeps_full_save; do
  mutate "$case" OutcomeContract "outcome-$case"
  add_case cases.list "outcome-$case" BP "$invariant_violation" 'Invariant OutcomeContract is violated' "Expected wrong-outcome counterexample for $case" "$case: wrong required outcome detected"
done
for pair in \
  wrong_plan_failure_result:StopMatchesCause \
  wrong_needs_input_result:StopMatchesCause \
  wrong_accept_plan_result:RunningRequiresAcceptedPlan \
  wrong_verify_failure_result:RecordedPassHappened \
  wrong_save_failure_result:RecordedPassHappened \
  replan_keeps_results:CompletionAfterChecksOfAcceptedPlan \
  dry_k1:DryStopAfterTwoDryRounds \
  dry_streak_carried:DryStopAfterTwoDryRounds \
  replan_keeps_full_save:SavedOrMissingExclusive \
  replan_keeps_full_save:StopReportReflectsCurrentSave; do
  case=${pair%%:*}; property=${pair#*:}
  mutate "$case" "$property" "requirement-$case-$property"
  add_case cases.list "requirement-$case-$property" BP "$invariant_violation" "Invariant $property is violated" "Expected requirement-side counterexample for $case ($property)" "$case: requirement-side counterexample ($property)"
done
for pair in wrong_resume_result:ResumeStartsNewRun dry_ignores_hint:DryStopWithoutUnreadHint; do
  case=${pair%%:*}; property=${pair#*:}
  sed "s/Mutation = \"none\"/Mutation = \"$case\"/; s/^INVARIANTS .*/INVARIANTS TypeOK/; s/^PROPERTIES .*/PROPERTIES $property/" BP.cfg > "requirement-$case-$property.cfg"
  add_case cases.list "requirement-$case-$property" BP "$temporal_violation" "Action property $property is violated" "Expected requirement-side counterexample for $case ($property)" "$case: requirement-side counterexample ($property)"
done
for pair in premature_hint_read:HintReadOnlyAfterAccept resume_without_report:ResumeOnlyAfterReportAndRepair resume_without_repair:ResumeOnlyAfterReportAndRepair; do
  case=${pair%%:*}; property=${pair#*:}
  sed "s/Mutation = \"none\"/Mutation = \"$case\"/; s/ OutcomeContract//" BP.cfg > "temporal-$case.cfg"
  add_case cases.list "temporal-$case" BP "$temporal_violation" "Action property $property is violated" "Expected temporal counterexample for $case" "$case: expected temporal counterexample"
done
# A witness is checked by intentionally making the sought state violate an invariant.
for witness in WitnessHintResume WitnessNeedsInputResume WitnessDryResume WitnessLimitResume WitnessPartialStopSave WitnessPartialStopFailure WitnessPartialSaveFailure WitnessTwoRunsRecords WitnessCompleteAfterHint WitnessDryInResumedRun WitnessDryAfterReadHint; do
  mutate none "$witness" "$witness"
  add_case cases.list "$witness" BP "$invariant_violation" "Invariant $witness is violated" "Required state is unreachable: $witness" "$witness: reachable"
done
for witness in WitnessHintResume WitnessNeedsInputResume WitnessDryResume WitnessLimitResume; do
  for case in no_hint_after_stop no_resume; do
    mutate "$case" "$witness" "$case-$witness"
    add_case cases.list "$case-$witness" BP "$success" "$success_message" "Expected $witness to be unreachable after $case" "$case-$witness: missing route detected (witness unreachable)"
  done
done
for pair in omit_PartialSave:WitnessPartialSaveFailure dry_blocks_read_hint:WitnessDryAfterReadHint; do
  case=${pair%%:*}; witness=${pair#*:}
  mutate "$case" "$witness" "$case-$witness"
  add_case cases.list "$case-$witness" BP "$success" "$success_message" "Expected $witness to be unreachable after $case" "$case-$witness: missing route detected (witness unreachable)"
done
sed 's/SPECIFICATION Spec$/SPECIFICATION SpecWithoutFair/' BP.cfg > no_fairness.cfg
add_case cases.list no_fairness BP "$temporal_violation" 'Temporal properties were violated' 'Expected progress counterexample without fairness' 'no_fairness: expected progress counterexample'
cat baseline.list three.list cases.list > all.list
"$rustc" "$base/project_graph.rs" -o "$tmp/project-graph" > "$tmp/rustc.log" 2>&1 &
rustc_pid=$!
sh "$cases" run "$tmp" "$tmp/all.list"
if ! wait "$rustc_pid"; then rustc_pid=; cat "$tmp/rustc.log" >&2; exit 1; fi
rustc_pid=
sh "$cases" verify "$tmp" "$tmp/baseline.list"
cat > "$tmp/initial-fixture.dot" <<'DOT'
strict digraph DiskGraph {
1 [label="/\\ phase = \"needs_input\"",style = filled]
2 [label="/\\ phase = \"planning\""]
1 -> 2 [label="StepResume"];
}
DOT
"$tmp/project-graph" "$tmp/initial-fixture.dot" > "$tmp/initial-fixture.md"
grep -F '[*] --> needs_input' "$tmp/initial-fixture.md" >/dev/null
sed 's/,style = filled//' "$tmp/initial-fixture.dot" > "$tmp/no-initial.dot"
if "$tmp/project-graph" "$tmp/no-initial.dot" > /dev/null 2>&1; then
  echo 'Graph projection accepted a missing initial state' >&2; exit 1
fi
cat > "$tmp/two-initial.dot" <<'DOT'
strict digraph DiskGraph {
1 [label="/\\ phase = \"needs_input\"",style = filled]
2 [label="/\\ phase = \"planning\"",style = filled]
1 -> 2 [label="StepResume"];
}
DOT
if "$tmp/project-graph" "$tmp/two-initial.dot" > /dev/null 2>&1; then
  echo 'Graph projection accepted multiple initial states' >&2; exit 1
fi
echo 'Graph initial-state fixtures passed'
"$tmp/project-graph" "$tmp/graph.dot" > "$tmp/generated-graph.md"
awk '/<!-- state-graph:start -->/{f=1;next}/<!-- state-graph:end -->/{f=0}f' "$base/README.md" > "$tmp/documented-graph.md"
if ! cmp -s "$tmp/generated-graph.md" "$tmp/documented-graph.md"; then
  echo "README state graph differs from TLC projection" >&2
  diff -u "$tmp/documented-graph.md" "$tmp/generated-graph.md" >&2 || true
  exit 1
fi
echo "README state graph matches TLC projection"
printf 'normal: '; grep 'distinct states found' "$tmp/baseline.log" | tail -1
sh "$cases" verify "$tmp" "$tmp/three.list"
sh "$cases" verify "$tmp" "$tmp/cases.list"
if [ "${TLC_DOT:-}" ]; then
  cp "$tmp/graph.dot" "$TLC_DOT"
  echo "state graph: $TLC_DOT"
fi
