#!/bin/sh
set -eu
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
run() {
  "$java" -Djava.io.tmpdir="$tmp" -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers 1 -metadir "$tmp/states-$1" -config "$tmp/$1.cfg" BP.tla > "$tmp/$1.log" 2>&1
}
cp BP.cfg baseline.cfg
if ! "$java" -Djava.io.tmpdir="$tmp" -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers 1 -metadir "$tmp/states-baseline" -config "$tmp/baseline.cfg" -dump dot,actionlabels "$tmp/graph.dot" BP.tla > "$tmp/baseline.log" 2>&1; then
  cat "$tmp/baseline.log" >&2; exit 1
fi
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
grep -F 'Model checking completed. No error has been found.' "$tmp/baseline.log" >/dev/null
printf 'normal: '; grep 'distinct states found' "$tmp/baseline.log" | tail -1
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
  status=0; run "$name" || status=$?
  if [ "$status" -ne 12 ] || ! grep -F "Invariant $invariant is violated" "$tmp/$name.log" >/dev/null; then
    echo "Expected counterexample for $name ($invariant); exit=$status" >&2
    cat "$tmp/$name.log" >&2; exit 1
  fi
  echo "$name: expected counterexample ($invariant)"
done
for invariant in NoUnspecifiedTransitions RunningRequiresAcceptedPlan; do
  sed "s/Mutation = \"none\"/Mutation = \"ghost_start\"/; s/^INVARIANTS .*/INVARIANTS $invariant/; /^PROPERTIES /d" BP.cfg > "ghost-$invariant.cfg"
  status=0; run "ghost-$invariant" || status=$?
  if [ "$status" -ne 12 ] || ! grep -F "Invariant $invariant is violated" "$tmp/ghost-$invariant.log" >/dev/null; then
    echo "Expected ghost transition counterexample ($invariant); exit=$status" >&2
    cat "$tmp/ghost-$invariant.log" >&2; exit 1
  fi
  echo "ghost_start: expected counterexample ($invariant)"
done
for action in AddHint Deliver AcceptPlan PlanFailed NeedsInput DryStop LimitStop ReplanForHint VerifyPass VerifyFail PartialSave SavePass SaveFail Complete StopSave StopSaveFail Report Repair Answer Resume RequestDelete Delete; do
  name=omit_$action
  sed "s/Mutation = \"none\"/Mutation = \"$name\"/; s/^INVARIANTS .*/INVARIANTS EventContract/; /^PROPERTIES /d" BP.cfg > "$name.cfg"
  status=0; run "$name" || status=$?
  if [ "$status" -ne 12 ] || ! grep -F 'Invariant EventContract is violated' "$tmp/$name.log" >/dev/null; then
    echo "Expected missing-event counterexample for $action; exit=$status" >&2
    cat "$tmp/$name.log" >&2; exit 1
  fi
  echo "$name: missing required transition detected"
done
for case in wrong_plan_failure_result wrong_needs_input_result wrong_accept_plan_result wrong_verify_failure_result wrong_save_failure_result wrong_resume_result wrong_report_reason missing_report_omitted wrong_save_failure_report omit_save_failure_report; do
  sed "s/Mutation = \"none\"/Mutation = \"$case\"/; s/^INVARIANTS .*/INVARIANTS OutcomeContract/; /^PROPERTIES /d" BP.cfg > "$case.cfg"
  status=0; run "$case" || status=$?
  if [ "$status" -ne 12 ] || ! grep -F 'Invariant OutcomeContract is violated' "$tmp/$case.log" >/dev/null; then
    echo "Expected wrong-outcome counterexample for $case; exit=$status" >&2
    cat "$tmp/$case.log" >&2; exit 1
  fi
  echo "$case: wrong required outcome detected"
done
for pair in premature_hint_read:HintReadOnlyAfterAccept resume_without_report:ResumeOnlyAfterReportAndRepair resume_without_repair:ResumeOnlyAfterReportAndRepair; do
  case=${pair%%:*}; property=${pair#*:}
  sed "s/Mutation = \"none\"/Mutation = \"$case\"/; s/ OutcomeContract//" BP.cfg > "$case.cfg"
  status=0; run "$case" || status=$?
  if [ "$status" -ne 13 ] || ! grep -F "Action property $property is violated" "$tmp/$case.log" >/dev/null; then
    echo "Expected temporal counterexample for $case; exit=$status" >&2
    cat "$tmp/$case.log" >&2; exit 1
  fi
  echo "$case: expected temporal counterexample"
done
# A witness is checked by intentionally making the sought state violate an invariant.
for witness in WitnessHintResume WitnessNeedsInputResume WitnessDryResume WitnessLimitResume WitnessPartialStopSave WitnessPartialStopFailure WitnessPartialSaveFailure WitnessTwoRunsRecords; do
  sed "s/^INVARIANTS .*/INVARIANTS $witness/; /^PROPERTIES /d" BP.cfg > "$witness.cfg"
  status=0; run "$witness" || status=$?
  if [ "$status" -ne 12 ] || ! grep -F "Invariant $witness is violated" "$tmp/$witness.log" >/dev/null; then
    echo "Required state is unreachable: $witness; exit=$status" >&2; cat "$tmp/$witness.log" >&2; exit 1
  fi
  echo "$witness: reachable"
done
for witness in WitnessHintResume WitnessNeedsInputResume WitnessDryResume WitnessLimitResume; do
  for case in no_hint_after_stop no_resume; do
    name="$case-$witness"
    sed "s/Mutation = \"none\"/Mutation = \"$case\"/; s/^INVARIANTS .*/INVARIANTS $witness/; /^PROPERTIES /d" BP.cfg > "$name.cfg"
    if ! run "$name" || ! grep -F 'Model checking completed. No error has been found.' "$tmp/$name.log" >/dev/null; then
      echo "Expected $witness to be unreachable after $case" >&2; cat "$tmp/$name.log" >&2; exit 1
    fi
    echo "$name: missing route detected (witness unreachable)"
  done
done
sed 's/SPECIFICATION Spec$/SPECIFICATION SpecWithoutFair/' BP.cfg > no_fairness.cfg
status=0; run no_fairness || status=$?
if [ "$status" -ne 13 ] || ! grep -F 'Temporal properties were violated' "$tmp/no_fairness.log" >/dev/null; then
  echo "Expected progress counterexample without fairness; exit=$status" >&2; cat "$tmp/no_fairness.log" >&2; exit 1
fi
echo 'no_fairness: expected progress counterexample'
if [ "${TLC_DOT:-}" ]; then
  "$java" -Djava.io.tmpdir="$tmp" -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers 1 -metadir "$tmp/dump-states" -config BP.cfg -dump dot,actionlabels "$TLC_DOT" BP.tla > "$tmp/dump.log" 2>&1
  echo "state graph: $TLC_DOT"
fi
