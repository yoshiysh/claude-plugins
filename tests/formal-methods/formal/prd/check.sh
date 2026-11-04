#!/bin/sh
set -eu
LC_ALL=C
export LC_ALL
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$base/../../../.." && pwd)
shared="$root/tests/formal/bp-prd"
cases="$shared/tlc_cases.sh"
doc="$root/docs/requirements/formal-methods.md"
sh "$cases" jobs > /dev/null
jar=${TLA2TOOLS:?Set TLA2TOOLS to the pinned tla2tools.jar}
JAVA=${JAVA:-java}
export JAVA TLA2TOOLS
expected_jar=$(sed -n 's/^expected_jar=//p' "$shared/check.sh")
actual_jar=$(shasum -a 256 "$jar" | cut -d ' ' -f 1)
[ "$actual_jar" = "$expected_jar" ] || { echo "Unexpected TLC jar SHA-256" >&2; exit 1; }
sh "$shared/prd_sections.sh" check "$root" "$base/PRD.sections"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/fm-prd-tlc.XXXXXX")
cleanup() {
  attempt=0
  until rm -rf "$tmp" 2> /dev/null || [ "$attempt" -ge 5 ]; do attempt=$((attempt + 1)); sleep 1; done
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

grep '^#### PR-FORMALMETHODS-' "$doc" | cut -d ' ' -f 2 | sort > "$tmp/doc.ids"
cut -f 1 "$base/coverage.tsv" | sort > "$tmp/map.ids"
[ "$(wc -l < "$tmp/doc.ids" | tr -d ' ')" -eq 255 ] || { echo "Requirement count is not 255" >&2; exit 1; }
if ! cmp -s "$tmp/doc.ids" "$tmp/map.ids"; then
  echo "coverage.tsv does not list every requirement exactly once" >&2
  diff "$tmp/doc.ids" "$tmp/map.ids" >&2 || true
  exit 1
fi
awk -F '\t' 'NF != 3 || ($2 != "入れる" && $2 != "入れない") || $3 == "" { print FILENAME ":" NR; bad = 1 } END { exit bad }' "$base/coverage.tsv"
echo "coverage.tsv assigns all 255 requirements"
awk '/^#### PR-FORMALMETHODS-175 /{f=1;next} /^#### /{f=0} f && /^\| / && !/^\| 停止 \|/ && !/^\|---/ { split($0, c, " \\| "); sub(/^\| /, "", c[1]); print c[1] }' "$doc" | sort > "$tmp/doc.rows"
cut -f 1 "$base/rows.tsv" | sort > "$tmp/map.rows"
if ! cmp -s "$tmp/doc.rows" "$tmp/map.rows"; then
  echo "rows.tsv does not match the rows of the PR-175 table" >&2
  diff "$tmp/doc.rows" "$tmp/map.rows" >&2 || true
  exit 1
fi
awk -F '\t' '{ split($2, a, ":"); n = split(a[2], names, "+"); for (i = 1; i <= n; i++) print a[1], names[i] }' "$base/rows.tsv" | while read -r module name; do
  grep -F "\"$name\"" "$base/$module.tla" > /dev/null || { echo "rows.tsv names $module $name, which the model lacks" >&2; exit 1; }
done
echo "rows.tsv matches the PR-175 table"

awk '/^#### PR-FORMALMETHODS-175 /{f=1;next} /^#### /{f=0} f && /^\| / && !/^\| 停止 \|/ && !/^\|---/ { split($0, c, " \\| "); sub(/^\| /, "", c[1]); print c[1] "\t" c[2] }' "$doc" > "$tmp/doc.when"
while IFS="$(printf '\t')" read -r row target; do
  module=${target%%:*} name=${target#*:}; name=${name%%+*}
  doc_ids=$(awk -F '\t' -v r="$row" '$1 == r { print $2 }' "$tmp/doc.when" | grep -o 'PR-FORMALMETHODS-[0-9]*' | sed 's/PR-FORMALMETHODS-0*//' | sort -n | tr '\n' ' ')
  model_ids=$(grep -o "$name |-> {[0-9, ]*}" "$base/$module.tla" | head -n 1 | sed 's/.*{//; s/}//' | tr ',' '\n' | tr -d ' ' | grep . | sort -n | tr '\n' ' ' || true)
  [ "$doc_ids" = "$model_ids" ] || { echo "PR-175 row $row: the document lists [$doc_ids], $module.RowIds.$name lists [$model_ids]" >&2; exit 1; }
done < "$base/rows.tsv"
echo "RowIds match the when column of the PR-175 table"
awk '/^#### PR-FORMALMETHODS-043 /{f=1;next} /^#### /{f=0} f && /^\| / && !/^\| 拒否する入力/ && !/^\|---/' "$doc" | sed 's/^| //; s/ |$//' > "$tmp/doc.reject"
cut -f 1 "$base/reject.tsv" > "$tmp/map.reject"
if ! cmp -s "$tmp/doc.reject" "$tmp/map.reject"; then
  echo "reject.tsv does not match the rows of the PR-043 table" >&2
  diff "$tmp/doc.reject" "$tmp/map.reject" >&2 || true
  exit 1
fi
cut -f 2 "$base/reject.tsv" | grep -v '^対象外:' | while IFS=: read -r module name; do
  grep -F "$name" "$base/$module.tla" > /dev/null || { echo "reject.tsv names $module $name, which the model lacks" >&2; exit 1; }
done
echo "reject.tsv matches the PR-043 table"
mkdir -p "$tmp/pin/docs/requirements"
awk '{ print } /^### 停止の表と完了$/ { print "" }' "$doc" > "$tmp/pin/docs/requirements/formal-methods.md"
if sh "$shared/prd_sections.sh" check "$tmp/pin" "$base/PRD.sections" > "$tmp/pin.log" 2>&1; then
  echo "Section pins did not fail on a changed pinned section" >&2; exit 1
fi
grep -F 'CHANGED' "$tmp/pin.log" > /dev/null || { echo "Section pin check failed for another reason" >&2; cat "$tmp/pin.log" >&2; exit 1; }
echo "Section pins fail on a changed pinned section"

cp "$base"/*.tla "$tmp/"
cd "$tmp"
inv=12 tmp_prop=13 ok=0
okmsg='Model checking completed. No error has been found.'
: > all.list
add() {
  id=$1 module=$2 code=$3 message=$4 label=$5 okline=$6
  printf '%s\n' "$module" "$code" "$message" "$label" "$okline" '' > "$id.case"
  echo "$id" >> all.list
}
cfg() {
  id=$1 consts=$2 invs=$3 props=$4
  {
    echo "CONSTANTS $consts"
    echo 'SPECIFICATION Spec'
    echo 'CHECK_DEADLOCK FALSE'
    [ -z "$invs" ] || echo "INVARIANTS $invs"
    [ -z "$props" ] || echo "PROPERTIES $props"
  } > "$id.cfg"
}
expect_ok() { cfg "$1" "$3" "$4" "$5"; add "$1" "$2" "$ok" "$okmsg" "Expected $1 to pass" "$6"; }
expect_inv() { cfg "$1" "$3" "$4" ''; add "$1" "$2" "$inv" "Invariant $4 is violated" "Expected $1 to violate $4" "$5"; }
expect_act() { cfg "$1" "$3" '' "$4"; add "$1" "$2" "$tmp_prop" "Action property $4 is violated" "Expected $1 to violate $4" "$5"; }

EMPTY='{}'
st() { echo "Mutation = \"$1\" Fixes = $2 Relax = ${3:-$EMPTY}"; }
ST_INV='TypeOK LimitWhenBudget InputChangeIsFailure DefectFirst StopRecFirst FailureBeforeSave CompleteOnlyClean NoUnsavedRecordClaimed EveryUnsavedScopeReturned'
ST_ALL="$ST_INV ExactlyOneRow NextArgsOnlyIfContinuable"
expect_ok st-baseline StopTable "$(st none '{}')" "$ST_INV" '' 'StopTable baseline: OK'
expect_inv st-F1 StopTable "$(st none '{}')" ExactlyOneRow 'reading-dependent F1: a 152 stop counted before the attribution step matches no row'
expect_inv st-F2 StopTable "$(st none '{"F1"}')" NextArgsOnlyIfContinuable 'finding F2: a failure row returns next_args for a previous-result state'
expect_ok st-fixed StopTable "$(st none '{"F1", "F2"}')" "$ST_ALL" '' 'StopTable with F1 and F2 fixed: OK'
for pair in m232_drop:StopRecFirst m251_drop:DefectFirst m259_drop:InputChangeIsFailure m252_drop:ExactlyOneRow \
  m260_drop:FailureBeforeSave m254_drop:CompleteOnlyClean m253_drop:NoUnsavedRecordClaimed \
  m263_only_selected:EveryUnsavedScopeReturned m156_trial_ignores_budget:LimitWhenBudget \
  m154_defect_blocks_limit:LimitWhenBudget m154_defect_blocks_limit:ExactlyOneRow m175_defect_next_args:NextArgsOnlyIfContinuable; do
  m=${pair%%:*} p=${pair#*:}
  expect_inv "st-$m-$p" StopTable "$(st "$m" '{"F1", "F2"}')" "$p" "$m: detected by $p"
done
for r in scatterAttr capFirst saveNeedsTrigger; do
  expect_ok "st-relax-$r" StopTable "$(st none '{"F1", "F2"}' "{\"$r\"}")" "$ST_ALL" '' "added constraint $r removed: all StopTable properties still hold"
done
for r in allDoneStep budgetStep; do
  expect_inv "st-relax-$r" StopTable "$(st none '{"F1", "F2"}' "{\"$r\"}")" ExactlyOneRow "added constraint $r removed: completion and the 154 limit hit together, and no rule orders them"
done
for w in WitnessComplete WitnessIterLimit WitnessDefect WitnessFailure WitnessSaveFail WitnessStopRec WitnessDefectWithFailure; do
  expect_inv "st-$w" StopTable "$(st none '{"F1", "F2"}')" "$w" "$w: reachable"
done

lc() { echo "Mutation = \"$1\" Fixes = $2 Relax = ${5:-$EMPTY} MaxLaunches = ${3:-3} MaxChanges = ${4:-2}"; }
LN_ACT='PrevResultClosed PrevResultReturned RedoStoppedStep CompletedReturnsCompleted NewStateIsFresh InputChangeStopsAtStepEnd ContinueKeepsProgress'
LN_FIX='{"F2", "F3", "F11"}'
expect_ok ln-baseline Launch "$(lc none '{}')" TypeOK "$LN_ACT" 'Launch baseline: OK'
expect_inv ln-F2 Launch "$(lc none '{}')" NextArgsContinue 'finding F2: next_args returned for a previous-result state'
expect_act ln-F3 Launch "$(lc none '{"F2"}')" ResultsOnIdentity 'finding F3: results from changed input survive a step-boundary check'
expect_inv ln-F11 Launch "$(lc none '{"F2", "F3"}')" NoUnreadHintAtComplete 'finding F11 (lc J-008): a hint added in the last step stays unread at completion'
expect_ok ln-fixed Launch "$(lc none "$LN_FIX")" 'TypeOK NextArgsContinue NoUnreadHintAtComplete' "$LN_ACT ResultsOnIdentity" 'Launch with F2, F3 and F11 fixed: OK'
expect_ok ln-fixed-wide Launch "$(lc none "$LN_FIX" 4 3)" 'TypeOK NextArgsContinue NoUnreadHintAtComplete' "$LN_ACT ResultsOnIdentity" 'Launch with F2, F3 and F11 fixed, 4 launches and 3 changes: OK'
expect_ok ln-relax-keep121mark Launch "$(lc none "$LN_FIX" 3 2 '{"keep121mark"}')" 'TypeOK NextArgsContinue NoUnreadHintAtComplete' "$LN_ACT ResultsOnIdentity" 'added constraint keep121mark removed: all Launch properties still hold'
for pair in m177_continue_before_prev:PrevResultReturned m177_continue_before_prev:PrevResultClosed \
  m177_limit_before_prev:PrevResultReturned m256_keep_items:RedoStoppedStep m249_inherit:NewStateIsFresh \
  m234_accept_hint:PrevResultClosed m121_ignore:InputChangeStopsAtStepEnd m192_skip_complete:CompletedReturnsCompleted \
  m193_restart:ContinueKeepsProgress m250_rewind_on_hint:ContinueKeepsProgress m264_skip_item_check:ResultsOnIdentity; do
  m=${pair%%:*} p=${pair#*:}
  expect_act "ln-$m-$p" Launch "$(lc "$m" "$LN_FIX")" "$p" "$m: detected by $p"
done
expect_inv ln-m175_defect_next_args Launch "$(lc m175_defect_next_args "$LN_FIX")" NextArgsContinue 'm175_defect_next_args: detected by NextArgsContinue'
for w in WitnessPrev WitnessRedo WitnessComplete WitnessContinueAfterHint WitnessHintThenComplete; do
  expect_inv "ln-$w" Launch "$(lc none "$LN_FIX")" "$w" "$w: reachable"
done

lk() { echo "Mutation = \"$1\" Slots = {1, 2, 3}"; }
expect_ok lk-baseline Lock "$(lk none)" 'TypeOK LockMutex' StaleLockDoesNotBlock 'Lock baseline: OK'
expect_act lk-m043_stale_lock_blocks Lock "$(lk m043_stale_lock_blocks)" StaleLockDoesNotBlock 'm043_stale_lock_blocks: detected by StaleLockDoesNotBlock'
expect_inv lk-m043_no_lock Lock "$(lk m043_no_lock)" LockMutex 'm043_no_lock: detected by LockMutex'
for w in WitnessStaleThenEnter WitnessRejected; do expect_inv "lk-$w" Lock "$(lk none)" "$w" "$w: reachable"; done

df() { echo "Mutation = \"$1\" Fixes = $2 Relax = ${3:-$EMPTY} Steps = 3 MaxDefects = 2"; }
DF_INV='TypeOK NoDownstreamForUpstreamGap AmbiguousOnlyAfterTwo SecondDecidedAdopted'
DF_FIX='{"F5", "K2", "K1"}'
expect_ok df-baseline Defects "$(df none '{}')" "$DF_INV" AttributionStepAttributesAll 'Defects baseline: OK'
expect_inv df-F5 Defects "$(df none '{}')" NoUnattributedPrevResult 'reading-dependent F5: a defect found after the attribution step is returned unattributed'
expect_inv df-K2 Defects "$(df none '{"F5"}')" ReturnedDefectsAttributed 'finding K2: a 154 or 121 stop returns defects without attribution'
expect_ok df-K1 Defects "$(df none '{}')" WitnessCompleteAfterFix '' 'finding K1: no completion after a fixed model defect (witness unreachable)'
expect_inv df-K1-fixed Defects "$(df none '{"K1"}')" WitnessCompleteAfterFix 'K1 fixed: completion after a fixed model defect is reachable'
expect_inv df-relax-conflict218 Defects "$(df none '{}' '{"conflict218"}')" SecondDecidedAdopted 'added constraint conflict218 removed (lc K3): a decided second judgment ends as ambiguous'
expect_ok df-fixed Defects "$(df none "$DF_FIX")" "$DF_INV NoUnattributedPrevResult ReturnedDefectsAttributed" AttributionStepAttributesAll 'Defects with F5, K2 and K1 fixed: OK'
for pair in m246_position_first:NoDownstreamForUpstreamGap m144_no_second:AmbiguousOnlyAfterTwo m262_leave_unattributed:NoUnattributedPrevResult; do
  m=${pair%%:*} p=${pair#*:}
  expect_inv "df-$m-$p" Defects "$(df "$m" "$DF_FIX")" "$p" "$m: detected by $p"
done
expect_act df-m262_leave_unattributed-step Defects "$(df m262_leave_unattributed '{}')" AttributionStepAttributesAll 'm262_leave_unattributed: detected by AttributionStepAttributesAll'
for w in WitnessPrevResult WitnessAmbiguous WitnessLimitStopWithDefects; do expect_inv "df-$w" Defects "$(df none "$DF_FIX")" "$w" "$w: reachable"; done

cv() { echo "Mutation = \"$1\" Fixes = $2 Relax = ${6:-$EMPTY} W = ${3:-2} C = ${4:-3} T = ${5:-2} MaxRuns = 3"; }
CV_INV='TypeOK TrialCapCumulative TrialCountCarried'
CV_ACT='ExtraRoundAfterCap TriedAfterReset NoCappedAfterResume'
CV_FIX='{"F7", "F9"}'
expect_ok cv-baseline Convergence "$(cv none '{}')" "$CV_INV" "$CV_ACT" 'Convergence baseline: OK'
for p in WidthReached ConvergenceOnIdentityRounds CountIsCumulative; do
  expect_inv "cv-F7-$p" Convergence "$(cv none '{"F9"}')" "$p" "finding F7: redoing a step after 121 breaks $p"
done
expect_act cv-F9 Convergence "$(cv none '{"F7"}')" RoundBeforeRejudge 'finding F9: a continued launch can stop on the old non-convergence judgment before any round'
for wct in 2:3:2 1:2:2 2:3:3; do
  w=${wct%%:*} rest=${wct#*:}; c=${rest%%:*} t=${rest#*:}
  expect_ok "cv-fixed-$wct" Convergence "$(cv none "$CV_FIX" "$w" "$c" "$t")" "$CV_INV WidthReached ConvergenceOnIdentityRounds CountIsCumulative" "$CV_ACT RoundBeforeRejudge" "Convergence with F7 and F9 fixed, W:C:T = $wct: OK"
done
expect_ok cv-relax-judgeFirst Convergence "$(cv none "$CV_FIX" 2 3 2 '{"judgeFirst"}')" "$CV_INV WidthReached ConvergenceOnIdentityRounds CountIsCumulative" "$CV_ACT RoundBeforeRejudge" 'added constraint judgeFirst removed: all Convergence properties still hold'
expect_inv cv-m162_width_eq_cap Convergence "$(cv none "$CV_FIX" 3 3)" WidthReached 'm162_width_eq_cap (W = C): detected by WidthReached'
for pair in m266_run_local:WidthReached m166_reset_count:CountIsCumulative m173_drop_carry:CountIsCumulative \
  m258_run_local:TrialCapCumulative m159_reset_trials:TrialCountCarried m256_keep_rounds:ConvergenceOnIdentityRounds; do
  m=${pair%%:*} p=${pair#*:}
  expect_inv "cv-$m-$p" Convergence "$(cv "$m" "$CV_FIX")" "$p" "$m: detected by $p"
done
for pair in m167_no_extra_round:ExtraRoundAfterCap m247_no_retry:TriedAfterReset m160_keep_capped:NoCappedAfterResume; do
  m=${pair%%:*} p=${pair#*:}
  expect_act "cv-$m-$p" Convergence "$(cv "$m" "$CV_FIX")" "$p" "$m: detected by $p"
done
for w in WitnessIter165 WitnessBlocked163 WitnessResumeAtCap WitnessComplete WitnessRejudgeAfterResume WitnessTrialStopAfterResume; do
  expect_inv "cv-$w" Convergence "$(cv none "$CV_FIX")" "$w" "$w: reachable"
done

bg() { echo "Mutation = \"$1\" Fixes = $2 E = ${3:-1} R = ${4:-1} MaxL = 4"; }
expect_ok bg-baseline Budget "$(bg none '{}')" 'TypeOK EntryWritesOnlyWithinLimit' '' 'Budget baseline: OK'
expect_inv bg-F8 Budget "$(bg none '{}')" StopRecordWritable 'finding F8: the 155 entry check leaves no launch for the stop record'
for er in 1:1 2:2 1:2; do
  expect_ok "bg-fixed-$er" Budget "$(bg none '{"F8"}' "${er%%:*}" "${er#*:}")" 'TypeOK StopRecordWritable EntryWritesOnlyWithinLimit' '' "Budget with F8 fixed, E:R = $er: OK"
done
expect_inv bg-m138_no_reserve Budget "$(bg m138_no_reserve '{"F8"}')" StopRecordWritable 'm138_no_reserve: detected by StopRecordWritable'
expect_inv bg-m155_drop Budget "$(bg m155_drop '{"F8"}' 2 1)" EntryWritesOnlyWithinLimit 'm155_drop: detected by EntryWritesOnlyWithinLimit'
for w in WitnessStopWritten WitnessRejected; do expect_inv "bg-$w" Budget "$(bg none '{"F8"}')" "$w" "$w: reachable"; done

sh "$cases" run "$tmp" "$tmp/all.list"
sh "$cases" verify "$tmp" "$tmp/all.list"
printf 'TLC cases: '; wc -l < "$tmp/all.list" | tr -d ' '
for id in st-baseline ln-baseline lk-baseline df-baseline cv-baseline bg-baseline ln-fixed-wide; do
  printf '%s: ' "$id"; grep 'distinct states found' "$tmp/$id.log" | tail -1
done
