#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$base/../../../.." && pwd)
# The case runner and the section cutter are shared with the PRD model.
prd=$base/../prd
cases="$prd/tlc_cases.sh"
sh "$cases" jobs > /dev/null
jar=${TLA2TOOLS:?Set TLA2TOOLS to the pinned tla2tools.jar}
JAVA=${JAVA:-java}
NODE=${NODE:-node}
export JAVA TLA2TOOLS
expected_jar=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
actual_jar=$(shasum -a 256 "$jar" | cut -d ' ' -f 1)
[ "$actual_jar" = "$expected_jar" ] || { echo "Unexpected TLC jar SHA-256" >&2; exit 1; }
tmp=$(mktemp -d "${TMPDIR:-/tmp}/bp-spec-tlc.XXXXXX")
cleanup() {
  # An interrupted pool can leave TLC workers writing into $tmp while it is being removed.
  attempt=0
  until rm -rf "$tmp" 2> /dev/null || [ "$attempt" -ge 5 ]; do attempt=$((attempt + 1)); sleep 1; done
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# The model hand-writes the prose of these sections, so a change has to reach the model first.
sh "$prd/prd_sections.sh" print "$root" "$base/SPEC.sections" > "$tmp/pins"
if ! cmp -s "$tmp/pins" "$base/SPEC.sections"; then
  echo "Specification sections pinned by $base/SPEC.sections changed:" >&2
  diff "$base/SPEC.sections" "$tmp/pins" | sed -n 's/^> [0-9a-f]*	/  /p' >&2 || true
  cat >&2 <<MSG
Re-verify the model before updating the pins:
  1. Read each changed section and compare it with the .tla files and README.md (the row-by-row mapping and the list of what the model leaves out).
  2. Change the models, their properties and cases, and README where they no longer match, then run check.sh until it passes.
  3. Only then regenerate the pins (written next to the manifest first, because redirecting onto it empties it before it is read):
     sh '$prd/prd_sections.sh' print '$root' '$base/SPEC.sections' > '$base/SPEC.sections.new' && mv '$base/SPEC.sections.new' '$base/SPEC.sections'
MSG
  exit 1
fi
echo 'Pinned specification sections: OK'

"$NODE" "$base/gen_tables.mjs" "$tmp"
cp "$base/StartChecks.tla" "$base/RunLifecycle.tla" "$base/Authoring.tla" "$base/Inspection.tla" "$tmp/"
cd "$tmp"
invariant_violation=12
property_violation=13
success_message='Model checking completed. No error has been found.'
known=' [known spec ambiguity or gap: see README]'
: > all.list
add_case() {
  printf '%s\n' "$2" "$3" "$4" "$5" "$6" '' > "$1.case"
  echo "$1" >> all.list
}
# Every configuration is derived from a checked-in one by a sed script.
variant() { sed "$3" "$base/$2" > "$1.cfg"; }
expect_pass() {
  variant "$1" "$3" "$4"
  add_case "$1" "$2" 0 "$success_message" "Expected $1 to pass" "$1: no violation"
}
expect_invariant() {
  variant "$1" "$3" "$4; s/^INVARIANTS .*/INVARIANTS $5/; /^PROPERTIES /d"
  add_case "$1" "$2" "$invariant_violation" "Invariant $5 is violated" "Expected a counterexample for $1 ($5)" "$1: counterexample ($5)$6"
}
expect_property() {
  variant "$1" "$3" "$4; s/^INVARIANTS .*/INVARIANTS TypeOK/; s/^PROPERTIES .*/PROPERTIES $5/"
  add_case "$1" "$2" "$property_violation" "Action property $5 is violated" "Expected a counterexample for $1 ($5)" "$1: counterexample ($5)${6:-}"
}
mutation() { echo "s/Mutation = \"none\"/Mutation = \"$1\"/"; }

expect_pass start StartChecks StartChecks.cfg 's/^$//'
expect_invariant start-write-early StartChecks StartChecks.cfg "$(mutation write_early)" RefusalWritesNothing ''
expect_invariant start-reverse-order StartChecks StartChecks.cfg "$(mutation reverse_order)" FirstApplicable ''
expect_invariant start-WitnessRefusedAtLast StartChecks StartChecks.cfg 's/^$//' WitnessRefusedAtLast ' (reachable)'

expect_pass run RunLifecycle RunLifecycle.cfg 's/^$//'
expect_property run-refusal-registers RunLifecycle RunLifecycle.cfg "$(mutation refusal_registers)" RefusalChangesNothing
expect_invariant run-e7-any-run RunLifecycle RunLifecycle.cfg "$(mutation e7_any_run)" NeverOccurs ''
expect_property run-accept-stale RunLifecycle RunLifecycle.cfg "$(mutation accept_stale)" NoWriteOutsideCurrent
expect_invariant run-resend-appends RunLifecycle RunLifecycle.cfg "$(mutation resend_appends)" OneRecordPerKey ''
expect_property run-resume-done RunLifecycle RunLifecycle.cfg "$(mutation resume_done)" TableConformance
expect_property run-resume-done-stays RunLifecycle RunLifecycle.cfg "$(mutation resume_done)" CompletedStaysCompleted
expect_invariant run-stale-blocks RunLifecycle RunLifecycle.cfg "$(mutation stale_blocks_current)" StaleNotStopReason ''
for w in WitnessResumeFromRunning WitnessStaleRejected; do
  expect_invariant "run-$w" RunLifecycle RunLifecycle.cfg 's/^$//' "$w" ' (reachable)'
done

expect_pass auth-update Authoring Authoring.cfg 's/^$//'
expect_pass auth-create Authoring Authoring.cfg 's/Fn = "update"/Fn = "create"/'
expect_invariant auth-n6-head-vanish-open Authoring Authoring.cfg 's/^$//' HeadStagesFinished "$known"
expect_invariant auth-laststop-always Authoring Authoring.cfg "$(mutation laststop_always)" ResumeRowUnique ''
expect_invariant auth-same-round-after-gate Authoring Authoring.cfg "$(mutation same_round_after_gate)" NoStaleFormalResult ''
expect_invariant auth-skip-placement Authoring Authoring.cfg "$(mutation skip_placement)" PlacementBeforeGate ''
expect_invariant auth-skip-formal Authoring Authoring.cfg "$(mutation skip_formal)" CompleteAfterGateAndFormal ''
expect_invariant auth-resume-skips-check Authoring Authoring.cfg "$(mutation resume_skips_check)" NoSkippedStage ''
expect_invariant auth-head-counts Authoring Authoring.cfg "$(mutation head_counts)" NoLostRestart ''
expect_invariant auth-skip-snapshot-on-resume Authoring Authoring.cfg "$(mutation skip_snapshot_on_resume)" SnapshotBeforeGoal ''
expect_invariant auth-needs-input-anywhere Authoring Authoring.cfg "$(mutation needs_input_anywhere)" NeedsInputOnlyAtGoal ''
expect_invariant auth-needs-input-no-row Authoring Authoring.cfg "$(mutation needs_input_anywhere)" ResumeRowUnique ''
expect_invariant auth-limit-unchecked Authoring Authoring.cfg "$(mutation limit_unchecked)" IterationLimitPerRun ''
expect_invariant auth-stop-dry Authoring Authoring.cfg "$(mutation stop_dry)" StopKindsUsed ''
expect_invariant auth-resume-done Authoring Authoring.cfg "$(mutation resume_done)" NoRunAfterDone ''
for w in WitnessBlockedAtStart WitnessDone WitnessDoneAfterResume WitnessDoneAfterFormalFailed WitnessDoneAfterVerifiers WitnessDoneAfterLaunchAtGate WitnessHeadVanishDone WitnessIterationLimit; do
  expect_invariant "auth-$w" Authoring Authoring.cfg 's/^$//' "$w" ' (reachable)'
done

expect_pass insp-review Inspection Inspection.cfg 's/^$//'
expect_pass insp-audit Inspection Inspection.cfg 's/Fn = "review"/Fn = "audit"/'
expect_invariant insp-n6-head-vanish-open Inspection Inspection.cfg 's/^$//' HeadStagesFinished "$known"
expect_invariant insp-omit-placement Inspection Inspection.cfg "$(mutation omit_placement)" PlacementBeforeStop ''
expect_invariant insp-back-edge Inspection Inspection.cfg "$(mutation back_edge)" NoBackEdge ''
expect_invariant insp-skip-stage Inspection Inspection.cfg "$(mutation skip_stage)" NoSkippedStage ''
expect_invariant insp-mismatch-continues Inspection Inspection.cfg "$(mutation mismatch_continues)" NoVerifyAfterMismatch ''
expect_invariant insp-stop-needs-input Inspection Inspection.cfg "$(mutation stop_needs_input)" StopKindsUsed ''
expect_invariant insp-resume-done Inspection Inspection.cfg "$(mutation resume_done)" NoRunAfterDone ''
expect_invariant insp-fin-ignores-head Inspection Inspection.cfg "$(mutation fin_ignores_head)" NoLostRestart ''
expect_invariant insp-head-counts Inspection Inspection.cfg "$(mutation head_counts)" NoLostRestart ''
for w in WitnessDoneAfterResume WitnessDoneAfterCloseStop WitnessMismatch WitnessHeadVanishDone WitnessDoneAfterVanishStop; do
  expect_invariant "insp-$w" Inspection Inspection.cfg 's/^$//' "$w" ' (reachable)'
done

sh "$cases" run "$tmp" "$tmp/all.list"
sh "$cases" verify "$tmp" "$tmp/all.list"
for model in start run auth-update auth-create insp-review insp-audit; do printf '%s: ' "$model"; grep 'distinct states found' "$tmp/$model.log" | tail -1; done
