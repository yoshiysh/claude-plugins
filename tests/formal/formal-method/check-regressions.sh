#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
root=$(CDPATH= cd -- "$base/../../.." && pwd)
rustc=${RUSTC:-rustc}
z3=${Z3:-z3}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/formal-regressions.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/repo/docs/requirements" "$tmp/repo/tests/formal/formal-method"
work="$tmp/repo/tests/formal/formal-method"
cp "$root/docs/requirements/formal-method.md" "$tmp/repo/docs/requirements/"
for file in check.rs extra_checks.rs requirements-map.json identity.smt2 mapping.smt2 reporting.smt2 job-ledger.smt2 operational_checks.rs operational.smt2 boundary_composition.rs boundary-contracts.smt2 storage.smt2 storage_checks.rs durable_storage.rs durable_storage_tests.rs PRD.sha256; do cp "$base/$file" "$work/"; done
"$rustc" --edition 2021 "$work/check.rs" -o "$tmp/check"
for file in identity.smt2 mapping.smt2 reporting.smt2 job-ledger.smt2 extra_checks.rs requirements-map.json operational.smt2 operational_checks.rs boundary_composition.rs boundary-contracts.smt2 storage.smt2 storage_checks.rs durable_storage.rs durable_storage_tests.rs; do
  printf '\n' >> "$work/$file"
  if (cd "$tmp/repo" && Z3="$z3" "$tmp/check" > "$tmp/drift.log" 2>&1); then echo "$file drift accepted" >&2; exit 1; fi
  if ! grep -F 'changed after compilation' "$tmp/drift.log" >/dev/null; then cat "$tmp/drift.log" >&2; exit 1; fi
  cp "$base/$file" "$work/"
  echo "$file: compile snapshot drift rejected"
done
printf '\nchanged\n' >> "$tmp/repo/docs/requirements/formal-method.md"
if (cd "$tmp/repo" && Z3="$z3" "$tmp/check" > "$tmp/prd.log" 2>&1); then echo 'PRD drift accepted' >&2; exit 1; fi
grep -F 'PRD has changed' "$tmp/prd.log" >/dev/null
cp "$root/docs/requirements/formal-method.md" "$tmp/repo/docs/requirements/"
echo 'PRD: drift rejected'
cat > "$tmp/fake-z3" <<'WRAPPER'
#!/bin/sh
set -eu
if [ "$1" = -version ]; then
  if [ "$MODE" = version ] && [ -f "$MARKER" ]; then echo 'Z3 version changed'; else "$REAL_Z3" "$@"; fi
  exit 0
fi
input=$(mktemp "${TMPDIR:-/tmp}/canonical-z3-input.XXXXXX")
trap 'rm -f "$input"' EXIT HUP INT TERM
cat > "$input"
case "$MODE" in
 unknown) awk '/\(check-sat\)/ { print "unknown" }' "$input"; exit 0 ;;
 solver) if [ ! -f "$MARKER" ]; then printf '\n# drift\n' >> "$0"; touch "$MARKER"; fi ;;
 version) touch "$MARKER" ;;
 forged)
  if grep -F '(get-value' "$input" >/dev/null; then
    "$REAL_Z3" "$@" < "$input" | sed 's/((phase 0) 0)/((phase 0) 1)/'
    touch "$MARKER"
    exit 0
  fi ;;
esac
"$REAL_Z3" "$@" < "$input"
WRAPPER
for mode in unknown solver version forged; do
 cp "$tmp/fake-z3" "$tmp/solver-$mode"
 chmod +x "$tmp/solver-$mode"
 marker="$tmp/$mode.seen"
 if (cd "$tmp/repo" && FORMAL_RUN_DIR="$tmp/evidence-$mode" REAL_Z3="$z3" MODE="$mode" MARKER="$marker" Z3="$tmp/solver-$mode" "$tmp/check" > "$tmp/$mode.log" 2>&1); then echo "$mode was accepted" >&2; exit 1; fi
 case "$mode" in
 unknown) expected='identity_reuse_oracle: unexpected result; no verification pass' ;;
 solver) expected='dependency changed during verification' ;;
 version) expected='solver version changed or could not be verified' ;;
 forged) expected='replay failed' ;;
 esac
 if ! grep -F "$expected" "$tmp/$mode.log" >/dev/null; then cat "$tmp/$mode.log" >&2; exit 1; fi
 if [ "$mode" != unknown ] && [ ! -f "$marker" ]; then echo "$mode did not apply" >&2; exit 1; fi
 echo "$mode: rejected by current harness"
done
