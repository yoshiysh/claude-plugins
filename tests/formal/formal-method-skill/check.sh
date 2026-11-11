#!/bin/sh
# formal-method の内部の設計（Run.tla・Lock.tla）を TLC で検査する入口。
# 1 ケースごとに JSON を 1 行、標準出力に出し、最後に集計の行を出す。
# 期待と違うケースが 1 つでもあれば exit 1。反例の trace は OUT_DIR（既定は一時の領域）に残す。
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
jar=${TLA2TOOLS:?Set TLA2TOOLS to the pinned tla2tools.jar}
JAVA=${JAVA:-java}
expected_jar=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
actual_jar=$(shasum -a 256 "$jar" | cut -d ' ' -f 1)
[ "$actual_jar" = "$expected_jar" ] || { echo "Unexpected TLC jar SHA-256: $actual_jar" >&2; exit 1; }
only=${ONLY:-}   # 空でなければ、id がこの拡張正規表現に合うケースだけを回す

out=${OUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/formal-method-skill-out.XXXXXX")}
mkdir -p "$out"
work=$(mktemp -d "${TMPDIR:-/tmp}/formal-method-skill-tlc.XXXXXX")
cleanup() {
  attempt=0
  until rm -rf "$work" 2> /dev/null || [ "$attempt" -ge 5 ]; do attempt=$((attempt + 1)); sleep 1; done
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cp "$base/Run.tla" "$base/Lock.tla" "$work/"
cd "$work"

# 到達の証人の印は、性質の名前として拡張のモジュールに置く（TLC の cfg は引数を取れないため）。
lock_tags='s_cap_fail s_spawn_fail s_start_fail s_status s_status_terminal s_working0 s_salvage_path s_kill_after_rename
busy_daemon busy_salvage busy_unknown rule2 rule3 r4_winner_dead r1_reuse_dead r1_misjudged s_both_ok s_ledger_fail s_result_fail s_result_lost
d_ledger_fail d_result_fail d_result_lost d_status_fail d_save_fail_loop d_crash_after_result winner_crash_after_ledger duplicate accepted d_quit_on_mark result_unreadable s_mark_io'
{
  echo '---- MODULE LockW ----'
  echo 'EXTENDS Lock'
  for t in $lock_tags; do echo "W_$t == Never(\"$t\")"; done
  echo '===='
} > LockW.tla
run_tags='start_spawn_fail start_crash_before_rename start_crash_after_rename start_slow_working start_slow_killed start_kill_after_rename
start_status start_fail_no_dir start_salvage_saved start_salvage_new terminal_by_status terminal_by_salvage busy_daemon busy_salvage
stale salvage_garbled salvage_hang duplicate_submit stale_submit batch_timed_out deadline_hit confirmation_stopped independent_after_cex
dependent_skipped still_waiting_unknown save_fail status_fail'
{
  echo '---- MODULE RunW ----'
  echo 'EXTENDS Run'
  for t in $run_tags; do echo "W_$t == Never(\"$t\")"; done
  echo '===='
} > RunW.tla

failures=0 total=0
json_str() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

# run_case id module kind props expect consts spec
#   kind: baseline | witness | mutation | finding | limit
#   expect: pass（成り立つ） | violation（名指しした性質の反例が出る）
#   consts: cfg の CONSTANTS の本文（改行区切り）
run_case() {
  id=$1 module=$2 kind=$3 props=$4 expect=$5 consts=$6 spec=${7:-Spec}
  if [ -n "$only" ] && ! printf '%s' "$id" | grep -Eq "$only"; then return; fi
  total=$((total + 1))
  temporal=no
  [ "$spec" = FairSpec ] && temporal=yes   # 公平性つきの仕様では、性質を時相の性質（PROPERTIES）として回す
  {
    printf 'CONSTANTS\n%s\n' "$consts"
    printf 'SPECIFICATION %s\nCHECK_DEADLOCK FALSE\n' "$spec"
    if [ "$temporal" = yes ]; then printf 'PROPERTIES %s\n' "$props"; else printf 'INVARIANTS %s\n' "$props"; fi
  } > "$id.cfg"
  set +e
  "$JAVA" -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers auto -metadir "$id.states" -config "$id.cfg" "$module" > "$id.out" 2>&1
  code=$?
  set -e
  gen=$(sed -n 's/^\([0-9,]*\) states generated.*/\1/p' "$id.out" | tail -1 | tr -d ,)
  dist=$(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$id.out" | tail -1 | tr -d ,)
  violated=
  if grep -q 'Error: Parsing\|Semantic errors\|Error: Evaluating\|is not completely specified\|TLC threw' "$id.out"; then
    observed=error
  elif [ "$code" -eq 0 ] && grep -qF 'Model checking completed. No error has been found.' "$id.out"; then
    observed=pass
  else
    violated=$(sed -n 's/^Error: Invariant \([A-Za-z0-9_]*\) is violated.*/\1/p' "$id.out" | head -1)
    if [ -z "$violated" ] && grep -q 'Temporal properties were violated' "$id.out"; then violated=temporal; fi
    if [ -z "$violated" ] && grep -q 'Error: Action property' "$id.out"; then
      violated=$(sed -n 's/^Error: Action property \([A-Za-z0-9_]*\).*/\1/p' "$id.out" | head -1)
    fi
    if [ -n "$violated" ]; then observed=violation; else observed=error; fi
  fi
  match=no
  if [ "$expect" = pass ] && [ "$observed" = pass ]; then match=yes; fi
  if [ "$expect" = violation ] && [ "$observed" = violation ]; then
    if [ "$temporal" = yes ] || [ "$violated" = "$props" ]; then match=yes; fi
  fi
  trace=null
  if [ "$observed" != pass ]; then cp "$id.out" "$out/$id.out"; trace=$(json_str "$out/$id.out"); fi
  printf '{"id":%s,"module":%s,"kind":%s,"properties":%s,"expect":%s,"observed":%s,"violated":%s,"match":%s,"exit":%d,"states_generated":%s,"distinct_states":%s,"config":%s,"trace":%s}\n' \
    "$(json_str "$id")" "$(json_str "$module")" "$(json_str "$kind")" "$(json_str "$props")" "$(json_str "$expect")" \
    "$(json_str "$observed")" "$(json_str "${violated:-}")" "$( [ "$match" = yes ] && echo true || echo false)" "$code" \
    "${gen:-null}" "${dist:-null}" "$(json_str "$(printf '%s' "$consts" | tr '\n' ' ')")" "$trace"
  [ "$match" = yes ] || failures=$((failures + 1))
  rm -rf "$id.states"
}

# ---------------- Lock.tla ----------------
lc() {  # lc mutation misjudge clients [track] [corrupt]
  printf '  Mutation = "%s"\n  Misjudge = %s\n  MaxRange = 1\n  Salvagers = {"v1", "v2"}\n  Clients = %s\n  UMax = 2\n  Track = %s\n  Corrupt_ = %s' "$1" "$2" "$3" "${4:-FALSE}" "${5:-$cr}"
}
cr='{"result"}' crs='{"result", "status"}'

c0='{}' c2='{"c1", "c2"}'
lock_inv='TypeOK WritersOnlyDaemon RunDirAppearsWithLock LockRemovedOnlyByOwner SalvageWritesNoState OneResultPublished ReceivedNonProvisionalMatches ProvisionalShape ExclusiveSalvageWork DeterministicSalvageResult ResultInLedger CompleteOnlyIfPublished NoWriteAfterMarkSeen InboxComplete MarkHasIdentity SavedOnlyPublished UnreadableOnlyWithPublished'
# 生死の誤判定を非決定で起こす（計画の範囲）。性質 (4b) は仮の結果を除いて、公開された結果との一致を見る（除外は置かない）。
run_case lock-baseline Lock baseline "$lock_inv" pass "$(lc none TRUE "$c2")"
# status.json が読めない出来事を加えた版（client 0）。
run_case lock-baseline-status-unreadable Lock baseline "$lock_inv" pass "$(lc none TRUE "$c0" FALSE "$crs")"
run_case lock-termination-determinable Lock baseline TerminationIfDeterminable pass "$(lc none TRUE "$c0")" FairSpec
# (7) の限界: 生死を判定できない状態が続けば、司令塔は LIVENESS_UNKNOWN_MAX 回の後に結果を作らずに終える。
run_case lock-termination Lock baseline Termination pass "$(lc none TRUE "$c0")" FairSpec

# 到達の証人は、LockW.tla を生成した lock_tags をそのまま回す（2 か所に書くと、生成側だけに足した印が回らない）
for w in $lock_tags; do
  case $w in duplicate|accepted) cl=$c2 ;; *) cl=$c0 ;; esac
  run_case "lock-witness-$w" LockW witness "W_$w" violation "$(lc none TRUE "$cl" TRUE)"
done
for w in NeverSalvageResult NeverDaemonResultFile NeverSalvageResultFile NeverTwoSalvageReturns NeverCompleteReceived NeverRprimeReceived NeverMisjudgeAndIO NeverProvisionalSuperseded NeverGaveUp NeverUnreadable; do
  run_case "lock-witness-$w" Lock witness "$w" violation "$(lc none TRUE "$c0")"
done
run_case lock-witness-NeverInboxRead Lock witness NeverInboxRead violation "$(lc none TRUE "$c2")"

lmut() { run_case "lock-mut-$1" Lock mutation "$2" violation "$(lc "$1" TRUE "${3:-$c0}")" "${4:-Spec}"; }
lmut two_names OneResultPublished
lmut loser_returns_own ReceivedNonProvisionalMatches
lmut complete_before_publish CompleteOnlyIfPublished
lmut foreign_unlock LockRemovedOnlyByOwner
lmut dir_before_lock RunDirAppearsWithLock
lmut salvage_writes_state SalvageWritesNoState
lmut salvage_writes_state WritersOnlyDaemon
lmut no_holder_check DeterministicSalvageResult
# 変異 no_saved_check（規則 2・3 を飛ばす）は、公開された結果を正とする規則の下では、どの性質も壊さない（README）。
lmut no_winner_check ExclusiveSalvageWork
lmut winner_always_busy TerminationIfDeterminable "$c0" FairSpec
lmut creator_in_result DeterministicSalvageResult
lmut result_before_ledger ResultInLedger
lmut result_despite_ledger_fail ResultInLedger
lmut mark_create_then_write MarkHasIdentity
lmut no_mark_check NoWriteAfterMarkSeen
lmut pid_only TerminationIfDeterminable "$c0" FairSpec
lmut slow_no_kill ReceivedNonProvisionalMatches
lmut inbox_create_then_write InboxComplete "$c2"
lmut saved_without_reload SavedOnlyPublished
run_case lock-mut-saved_without_reload-provisional Lock mutation ProvisionalShape violation "$(lc saved_without_reload TRUE "$c0")"
lmut unreadable_returns_new ReceivedNonProvisionalMatches
lmut no_provisional ReceivedNonProvisionalMatches

# ---------------- Run.tla ----------------

rc() {  # rc mutation batchstages env track
  printf '  Mutation = "%s"\n  BatchStages = %s\n  UMax = 2\n  Env = %s\n  Track = %s' "$1" "$2" "$3" "$4"
}
b2='{3, 6}' b4='{2, 3, 4, 6}'
eall='{"crash", "save", "deadline", "ps", "stale", "garbled", "svcrash"}'
estage='{"crash", "save", "deadline"}'
elive='{"crash", "save", "deadline", "stale", "garbled", "svcrash"}'
run_inv='TypeOK UnreadableNoNewResult OneResult NothingStartsAfterDeadline StaleSubmitNoEffect SaveFailureStops CompleteOnlyIf IndependentRunsToEnd ClientWritesNothing WaitReturnsOnlyOnChange BusyFollowsRole StartReturnsOnce StartFailOnlyWithoutDir'
run_case run-baseline Run baseline "$run_inv" pass "$(rc none "$b2" "$eall" FALSE)"
eread='{"crash", "save", "garbled", "corrupt", "statusread", "svcrash"}'
run_case run-baseline-unreadable Run baseline "$run_inv" pass "$(rc none "$b2" "$eread" FALSE)"
run_case run-termination-unreadable Run baseline Termination pass "$(rc none "$b2" '{"crash", "save", "corrupt", "statusread"}' FALSE)" FairSpec
run_case run-baseline-4stages Run baseline "$run_inv" pass "$(rc none "$b4" "$estage" FALSE)"
run_case run-termination Run baseline Termination pass "$(rc none "$b2" "$elive" FALSE)" FairSpec
run_case run-termination-ps Run baseline Termination pass "$(rc none "$b2" '{"crash", "ps", "svcrash"}' FALSE)" FairSpec
run_case run-commander-ends Run baseline CommanderEnds pass "$(rc none "$b2" '{"crash", "ps", "svcrash"}' FALSE)" FairSpec
run_case run-save-failure-reaches Run baseline SaveFailureReaches pass "$(rc none "$b2" '{"crash", "save", "ps"}' FALSE)" FairSpec

# 到達の証人は、RunW.tla を生成した run_tags をそのまま回す
for w in $run_tags; do
  run_case "run-witness-$w" RunW witness "W_$w" violation "$(rc none "$b2" "$eall" TRUE)"
done
run_case run-witness-NeverUnreadable Run witness NeverUnreadable violation "$(rc none "$b2" "$eread" TRUE)"
for w in NeverCompleted NeverStoppedCex NeverStoppedDeadline NeverStoppedSave NeverStoppedQuestion NeverStoppedUndetected NeverRejected \
         NeverSalvageFinal NeverStartFail NeverGaveUp NeverDuplicateNoEffect; do
  run_case "run-witness-$w" Run witness "$w" violation "$(rc none "$b2" "$eall" TRUE)"
done

rmut() { run_case "run-mut-$1" Run mutation "$2" violation "$(rc "$1" "$b2" "${3:-$eall}" FALSE)" "${4:-Spec}"; }
rmut slow_no_kill OneResult
rmut slow_no_kill StartFailOnlyWithoutDir
rmut no_batch_deadline Termination "$elive" FairSpec
rmut check_after_deadline NothingStartsAfterDeadline
rmut confirm_after_deadline NothingStartsAfterDeadline
rmut batch_after_deadline NothingStartsAfterDeadline
rmut inbox_overwrite StaleSubmitNoEffect
rmut read_any_batch StaleSubmitNoEffect
rmut hang_on_save_failure SaveFailureReaches '{"crash", "save", "ps"}' FairSpec
rmut ignore_save_failure SaveFailureStops
rmut ignore_save_failure CompleteOnlyIf
rmut complete_ignores_confirmation CompleteOnlyIf
rmut complete_before_publish CompleteOnlyIf
rmut stop_on_failure IndependentRunsToEnd
rmut stop_on_question IndependentRunsToEnd
rmut client_writes_status ClientWritesNothing
rmut wait_ignores_seq WaitReturnsOnlyOnChange
rmut stale_on_unknown WaitReturnsOnlyOnChange
rmut busy_daemon_to_salvage BusyFollowsRole
rmut busy_salvage_to_wait BusyFollowsRole
rmut unreadable_returns_new OneResult "$eread"

printf '{"summary":true,"total":%d,"mismatched":%d,"out_dir":%s}\n' "$total" "$failures" "$(json_str "$out")"
[ "$failures" -eq 0 ] || { echo "$failures case(s) did not match" >&2; exit 1; }
