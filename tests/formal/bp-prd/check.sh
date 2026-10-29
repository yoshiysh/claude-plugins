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
jar=${TLA2TOOLS:?Set TLA2TOOLS to the pinned tla2tools.jar}
java=${JAVA:-java}
rustc=${RUSTC:-rustc}
expected_jar=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
actual_jar=$(shasum -a 256 "$jar" | cut -d ' ' -f 1)
[ "$actual_jar" = "$expected_jar" ] || { echo "Unexpected TLC jar SHA-256" >&2; exit 1; }
(cd "$root" && shasum -a 256 -c "$base/PRD.sha256")
tmp=$(mktemp -d "${TMPDIR:-/tmp}/bp-prd-tlc.XXXXXX")
trap 'rm -r "$tmp"' EXIT HUP INT TERM
cp "$base/BP.tla" "$base/BP.cfg" "$tmp/"
cd "$tmp"
run_module=BP
run() {
  run_name=$1; shift
  "$java" -Djava.io.tmpdir="$tmp" -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers 1 -metadir "$tmp/states-$run_name" -config "$tmp/$run_name.cfg" "$@" "$run_module.tla" > "$tmp/$run_name.log" 2>&1
}
expect_exit() {
  expect_name=$1; expect_code=$2; expect_message=$3; expect_label=$4; shift 4
  expect_status=0; run "$expect_name" "$@" || expect_status=$?
  if [ "$expect_status" -ne "$expect_code" ] || ! grep -F "$expect_message" "$tmp/$expect_name.log" >/dev/null; then
    echo "$expect_label; exit=$expect_status" >&2
    cat "$tmp/$expect_name.log" >&2; exit 1
  fi
}
invariant_violation=12
temporal_violation=13
success=0
success_message='Model checking completed. No error has been found.'
cp BP.cfg baseline.cfg
expect_exit baseline "$success" "$success_message" 'Expected successful baseline' -dump dot,actionlabels "$tmp/graph.dot"
"$rustc" "$base/project_graph.rs" -o "$tmp/project-graph"
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
run_module=BPMaxRuns
expect_exit three-runs "$success" "$success_message" 'Expected TypeOK with three runs'
sed 's/INVARIANTS TypeOK/INVARIANTS WitnessThree/' three-runs.cfg > witness-three.cfg
expect_exit witness-three "$invariant_violation" 'Invariant WitnessThree is violated' 'Expected a record for the third run'
run_module=BP
echo 'TypeOK accepts a reachable third-run record'
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
  missing_report_omitted:ReportAccurate; do
  name=${case%%:*}; invariant=${case#*:}
  sed "s/Mutation = \"none\"/Mutation = \"$name\"/; s/^INVARIANTS .*/INVARIANTS $invariant/; /^PROPERTIES /d" BP.cfg > "$name.cfg"
  expect_exit "$name" "$invariant_violation" "Invariant $invariant is violated" "Expected counterexample for $name ($invariant)"
  echo "$name: expected counterexample ($invariant)"
done
for invariant in NoUnspecifiedTransitions RunningRequiresAcceptedPlan; do
  sed "s/Mutation = \"none\"/Mutation = \"ghost_start\"/; s/^INVARIANTS .*/INVARIANTS $invariant/; /^PROPERTIES /d" BP.cfg > "ghost-$invariant.cfg"
  expect_exit "ghost-$invariant" "$invariant_violation" "Invariant $invariant is violated" "Expected ghost transition counterexample ($invariant)"
  echo "ghost_start: expected counterexample ($invariant)"
done
for action in AddHint Deliver AcceptPlan PlanFailed NeedsInput DryStop LimitStop ReplanForHint VerifyPass VerifyFail PartialSave SavePass SaveFail Complete StopSave StopSaveFail Report Repair Answer Resume RequestDelete Delete; do
  name=omit_$action
  sed "s/Mutation = \"none\"/Mutation = \"$name\"/; s/^INVARIANTS .*/INVARIANTS EventContract/; /^PROPERTIES /d" BP.cfg > "$name.cfg"
  expect_exit "$name" "$invariant_violation" 'Invariant EventContract is violated' "Expected missing-event counterexample for $action"
  echo "$name: missing required transition detected"
done
for case in wrong_plan_failure_result wrong_needs_input_result wrong_accept_plan_result wrong_verify_failure_result wrong_save_failure_result wrong_resume_result wrong_report_reason missing_report_omitted wrong_save_failure_report omit_save_failure_report; do
  sed "s/Mutation = \"none\"/Mutation = \"$case\"/; s/^INVARIANTS .*/INVARIANTS OutcomeContract/; /^PROPERTIES /d" BP.cfg > "$case.cfg"
  expect_exit "$case" "$invariant_violation" 'Invariant OutcomeContract is violated' "Expected wrong-outcome counterexample for $case"
  echo "$case: wrong required outcome detected"
done
for pair in premature_hint_read:HintReadOnlyAfterAccept resume_without_report:ResumeOnlyAfterReportAndRepair resume_without_repair:ResumeOnlyAfterReportAndRepair; do
  case=${pair%%:*}; property=${pair#*:}
  sed "s/Mutation = \"none\"/Mutation = \"$case\"/; s/ OutcomeContract//" BP.cfg > "$case.cfg"
  expect_exit "$case" "$temporal_violation" "Action property $property is violated" "Expected temporal counterexample for $case"
  echo "$case: expected temporal counterexample"
done
# A witness is checked by intentionally making the sought state violate an invariant.
for witness in WitnessHintResume WitnessNeedsInputResume WitnessDryResume WitnessLimitResume WitnessPartialStopSave WitnessPartialStopFailure WitnessPartialSaveFailure WitnessTwoRunsRecords; do
  sed "s/^INVARIANTS .*/INVARIANTS $witness/; /^PROPERTIES /d" BP.cfg > "$witness.cfg"
  expect_exit "$witness" "$invariant_violation" "Invariant $witness is violated" "Required state is unreachable: $witness"
  echo "$witness: reachable"
done
for witness in WitnessHintResume WitnessNeedsInputResume WitnessDryResume WitnessLimitResume; do
  for case in no_hint_after_stop no_resume; do
    name="$case-$witness"
    sed "s/Mutation = \"none\"/Mutation = \"$case\"/; s/^INVARIANTS .*/INVARIANTS $witness/; /^PROPERTIES /d" BP.cfg > "$name.cfg"
    expect_exit "$name" "$success" "$success_message" "Expected $witness to be unreachable after $case"
    echo "$name: missing route detected (witness unreachable)"
  done
done
sed 's/SPECIFICATION Spec$/SPECIFICATION SpecWithoutFair/' BP.cfg > no_fairness.cfg
expect_exit no_fairness "$temporal_violation" 'Temporal properties were violated' 'Expected progress counterexample without fairness'
echo 'no_fairness: expected progress counterexample'
if [ "${TLC_DOT:-}" ]; then
  cp "$tmp/graph.dot" "$TLC_DOT"
  echo "state graph: $TLC_DOT"
fi
