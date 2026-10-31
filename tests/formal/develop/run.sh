#!/usr/bin/env bash
# Pass/fail is decided by three things only:
#   normal    every configuration ends with "No error has been found", and every
#             action of the skill's table (printed by TLC from MC's ASSUME) fires
#             in some configuration.
#   mutants   every patch in mutants/ is broken by the one property EXPECTED
#             names, checked alone (SANY, deadlock, NOTFIRED:<action>, or a
#             witness that the patch must leave unreached).
# The witness stage belongs to the mutant check: a witness kills a mutant only
# if the correct model reaches it, so the correct model must reach every one.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
jar="${TLA2TOOLS:-$HOME/.local/share/tla/tla2tools.jar}"
tlc=(java -Xmx8g -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers auto)
if command -v timeout >/dev/null 2>&1; then limit=(timeout 1200); elif command -v gtimeout >/dev/null 2>&1; then limit=(gtimeout 1200); else limit=(); fi
work="$(mktemp -d)"
echo "work dir (logs kept): $work"
mode="${1:-all}"
only="${2:-.}"
modules=(DevelopCommon DevelopSkill DevelopEnv DevelopProps Develop MC)
normal_cfgs=(Develop.cfg DevelopImpl.cfg DevelopImplClaims.cfg DevelopImplWide.cfg mutants/Impl.cfg)
invariants=" NoDeadEnd ImplGoal ReviewGoal AddressGoal W_FixBeyond W_PlanBeyond W_DecideEffect W_WaitBeyond W_EditDone "
witnesses=("mutants/Impl.cfg W_FixBeyond" "mutants/Impl.cfg W_PlanBeyond" "mutants/Impl.cfg W_DecideEffect" "mutants/Impl.cfg W_EditDone" "Develop.cfg W_WaitBeyond")

copy_src() { mkdir -p "$1"; for m in "${modules[@]}"; do cp "$here/$m.tla" "$1/"; done; }

# cfg_for <base cfg> <skill or -> <property or ->: the constants of <base>, one property
cfg_for() {
  sed '/^SPECIFICATION/,$d' "$1" | if [[ "$2" == - ]]; then cat; else sed "s/Skills = .*/Skills = {\"$2\"}/"; fi
  echo "SPECIFICATION Spec"
  if [[ "$3" != - ]]; then
    if [[ "$invariants" == *" $3 "* ]]; then echo "INVARIANT $3"; else echo "PROPERTY $3"; fi
  fi
}

fired_counts() {
  grep -E '^<[IRAH]_[A-Za-z]+ line' "$1" | awk -F'>: ' '{split($2,a,":"); split($1,b," "); sub("<","",b[1]); n[b[1]]+=a[2]} END {for (k in n) print k, n[k]}'
}

table_actions() { awk '/"ACTIONS"/ {f=1} f {print} f && /\}/ {exit}' "$1" | grep -oE '"[IRAH]_[A-Za-z]+"' | tr -d '"' | sort -u; }

run_normal() {
  local rc=0 cfg d tag
  : > "$work/fired"; : > "$work/acts"
  for cfg in "${normal_cfgs[@]}"; do
    tag="$(tr '/' '_' <<<"$cfg")"; d="$work/normal-$tag"; copy_src "$d"; cp "$here/$cfg" "$d/MC.cfg"
    (cd "$d" && "${tlc[@]}" -coverage 1 -metadir "$d/meta" MC) > "$d.log" 2>&1
    echo "NORMAL $cfg: $(grep -m1 -E '^[0-9]+ states generated' "$d.log")"
    if grep -q 'Model checking completed. No error has been found.' "$d.log"; then echo "NORMAL $cfg: PASS"
    else echo "NORMAL $cfg: FAIL ($(grep -m1 -E '^Error' "$d.log"))"; rc=1; fi
    fired_counts "$d.log" >> "$work/fired"; table_actions "$d.log" >> "$work/acts"
  done
  local a t n=0
  for a in $(sort -u "$work/acts"); do
    n=$((n+1))
    t="$(awk -v a="$a" '$1==a {s+=$2; seen=1} END {if (seen) print s; else print "missing"}' "$work/fired")"
    if [[ "$t" == missing || "$t" == 0 ]]; then echo "NOT FIRED: $a ($t)"; rc=1; fi
  done
  [[ $n -gt 0 ]] || { echo "NOT FIRED: no action list printed"; rc=1; }
  [[ $rc == 0 ]] && echo "COVERAGE: all $n actions fired"
  return $rc
}

run_witness() {
  local rc=0 line cfg w d
  for line in "${witnesses[@]}"; do
    read -r cfg w <<<"$line"; d="$work/witness-$w"; copy_src "$d"
    cfg_for "$here/$cfg" - "$w" > "$d/MC.cfg"
    (cd "$d" && "${tlc[@]}" -deadlock -metadir "$d/meta" MC) > "$d.log" 2>&1
    if grep -q "Invariant $w is violated" "$d.log"; then echo "WITNESS $w: reached"
    else echo "WITNESS $w: NOT REACHED ($(grep -m1 '^Error' "$d.log" || echo 'no violation'))"; rc=1; fi
  done
  return $rc
}

run_mutants() {
  local rc=0 name skill exp origin d base verdict
  while read -r name skill exp origin; do
    [[ -z "$name" || "$name" == \#* ]] && continue
    [[ "$name" =~ $only ]] || continue
    d="$work/m-$name"; copy_src "$d"
    if ! (cd "$d" && patch -s -F 0 -p0 < "$here/mutants/$name.patch"); then echo "MUTANT $name: PATCH FAILED"; rc=1; continue; fi
    if [[ "$skill" == implement ]]; then base="$here/mutants/Impl.cfg"; else base="$here/Develop.cfg"; fi
    case "$exp" in
      SANY|deadlock|NOTFIRED:*) cfg_for "$base" "$skill" - > "$d/MC.cfg" ;;
      *) cfg_for "$base" "$skill" "$exp" > "$d/MC.cfg" ;;
    esac
    local flags=(-metadir "$d/meta")
    case "$exp" in deadlock) ;; NOTFIRED:*) flags+=(-deadlock -coverage 1) ;; *) flags+=(-deadlock) ;; esac
    (cd "$d" && ${limit[@]+"${limit[@]}"} "${tlc[@]}" "${flags[@]}" MC) > "$d.log" 2>&1 || true
    verdict="survived"
    case "$exp" in
      SANY) grep -qE 'Semantic errors|Parse Error|Unknown operator|Substitution missing|Multiple declarations' "$d.log" && verdict=killed ;;
      deadlock) grep -q 'Deadlock reached' "$d.log" && verdict=killed ;;
      NOTFIRED:*) grep -q 'No error has been found' "$d.log" && grep -qxF "${exp#NOTFIRED:}" <<<"$(table_actions "$d.log")" && \
                    [[ "$(fired_counts "$d.log" | awk -v a="${exp#NOTFIRED:}" '$1==a {print $2}')" =~ ^0?$ ]] && verdict=killed ;;
      W_*) grep -q 'No error has been found' "$d.log" && verdict=killed ;;
      Termination) grep -q 'Temporal properties were violated' "$d.log" && verdict=killed ;;
      *) grep -qE "(Invariant|Action property) ([A-Za-z]+!)?$exp is violated" "$d.log" && verdict=killed ;;
    esac
    if [[ "$verdict" == killed ]]; then echo "MUTANT $name: killed by $exp"
    else echo "MUTANT $name: NOT KILLED by $exp ($(grep -m1 -E '^Error|No error' "$d.log" || echo 'no verdict'))"; rc=1; fi
  done < "$here/mutants/EXPECTED"
  return $rc
}

n=0
case "$mode" in
  normal) run_normal || n=1 ;;
  witness) run_witness || n=1 ;;
  mutants) run_mutants || n=1 ;;
  *) run_normal || n=1; run_witness || n=1; run_mutants || n=1 ;;
esac
exit "$n"
