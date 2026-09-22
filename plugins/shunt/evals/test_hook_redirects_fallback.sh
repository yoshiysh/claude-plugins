#!/bin/bash
# Deterministic tests for the hooks' redirect handling and fallback reasons.
#
# bash-read-gate used to skip every command containing `>`, so a stderr-only
# redirect (`cat big.log 2>/dev/null`) bypassed the gate even though the file
# still lands in the assistant's context. Only stdout sent to a real file means
# "not a read into context". The fallback reasons are pinned too: when the
# worker is unavailable (preflight fails) the reason must not point at
# /bulk-reader, and must offer a targeted read instead.
#
# Runs without an API key and without network: preflight is forced to fail by
# unsetting CLAUDE_PLUGINS_GEMINI_API_KEY, and the decide-failed path uses a
# dummy key against a closed local port. SHUNT_MIN_LINES is pinned to its
# default so an operator's override cannot flip the 400/20-line fixtures.
#
# Usage: bash evals/test_hook_redirects_fallback.sh

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASH_HOOK="$HERE/../hooks/bash-read-gate/run"
READ_HOOK="$HERE/../hooks/read-gate/run"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/shunt-hook-test.XXXXXX") || exit 1
trap '/bin/rm -rf "$tmp"' EXIT
big="$tmp/big.log"
small="$tmp/small.log"
for i in $(seq 1 400); do echo "2026-09-22T00:00:$i INFO request $i"; done > "$big"
for i in $(seq 1 20); do echo "line $i"; done > "$small"

fail=0

bash_hook() {
  jq -n --arg c "$1" --arg d "${2:-}" '{tool_input: ({command: $c} + (if $d == "" then {} else {description: $d} end))}' \
    | env -u CLAUDE_PLUGINS_GEMINI_API_KEY SHUNT_MIN_LINES=350 bash "$BASH_HOOK"
}

read_hook() {
  jq -n --arg p "$1" '{tool_input: {file_path: $p}}' \
    | env -u CLAUDE_PLUGINS_GEMINI_API_KEY SHUNT_MIN_LINES=350 bash "$READ_HOOK"
}

expect_allow() {
  local name="$1" out="$2"
  if [ -z "$out" ]; then
    echo "PASS ($name): allow"
  else
    echo "FAIL ($name): expected allow (empty output), got: $out"
    fail=1
  fi
}

# Block output must be valid JSON with decision=block; the reason is returned
# through REASON for further checks.
expect_block() {
  local name="$1" out="$2"
  REASON=""
  if [ "$(printf '%s' "$out" | jq -r '.decision' 2>/dev/null)" = "block" ]; then
    REASON=$(printf '%s' "$out" | jq -r '.reason')
    echo "PASS ($name): block"
  else
    echo "FAIL ($name): expected a JSON block, got: ${out:-<empty>}"
    fail=1
  fi
}

reason_has() {
  local name="$1" needle="$2"
  if [[ "$REASON" == *"$needle"* ]]; then
    echo "PASS ($name): reason mentions '$needle'"
  else
    echo "FAIL ($name): reason does not mention '$needle': $REASON"
    fail=1
  fi
}

reason_lacks() {
  local name="$1" needle="$2"
  if [[ "$REASON" != *"$needle"* ]]; then
    echo "PASS ($name): reason does not mention '$needle'"
  else
    echo "FAIL ($name): reason mentions '$needle': $REASON"
    fail=1
  fi
}

# stderr-only redirects, and stdout pointed back at the terminal, still put
# the file into context — the gate must see them.
expect_block "stderr-to-devnull"   "$(bash_hook "cat $big 2>/dev/null")"
reason_has   "stderr-to-devnull"   "File is 400 lines"
expect_block "stderr-to-stdout"    "$(bash_hook "cat $big 2>&1")"
expect_block "stdout-to-stderr"    "$(bash_hook "cat $big >&2")"
expect_block "fd1-to-stderr"       "$(bash_hook "cat $big 1>&2")"
expect_block "stdout-to-devstderr" "$(bash_hook "cat $big > /dev/stderr")"
expect_block "stderr-append"       "$(bash_hook "cat $big 2>>$tmp/err.log")"
expect_block "redirect-before-path" "$(bash_hook "cat 2> /dev/null $big")"
reason_has   "redirect-before-path" "File is 400 lines"
expect_block "wrapped-stderr"      "$(bash_hook "sh -c 'cat $big 2>/dev/null'")"
reason_has   "wrapped-stderr"      "File is 400 lines"

# stdout to a real file keeps the content out of context.
expect_allow "stdout-to-file"      "$(bash_hook "cat $big > $tmp/out")"
expect_allow "stdout-append"       "$(bash_hook "cat $big >> $tmp/out")"
expect_allow "both-to-file"        "$(bash_hook "cat $big &> $tmp/out")"
expect_allow "fd1-to-file"         "$(bash_hook "cat $big 1>$tmp/out")"
expect_allow "stdout-to-devnull"   "$(bash_hook "cat $big >/dev/null")"
expect_allow "stdout-file-stderr-dup" "$(bash_hook "cat $big > $tmp/out 2>&1")"
expect_allow "wrapped-stdout-inside"  "$(bash_hook "sh -c 'cat $big > $tmp/out'")"
expect_allow "wrapped-stdout-outside" "$(bash_hook "sh -c 'cat $big' > $tmp/out")"

# Preflight-unavailable fallback: the worker cannot run, so the reason must
# offer a targeted read, not /bulk-reader. The "fallback line rule" phrase is
# what evals/run_regression.py keys its resolved_by=fallback label on.
expect_block "bash-preflight" "$(bash_hook "cat $big" "debug why request 42 failed")"
reason_lacks "bash-preflight" "bulk-reader"
reason_has   "bash-preflight" "sed -n"
reason_has   "bash-preflight" "offset/limit"
reason_has   "bash-preflight" "fallback line rule"

expect_block "read-preflight" "$(read_hook "$big")"
reason_lacks "read-preflight" "bulk-reader"
reason_has   "read-preflight" "offset/limit"
reason_has   "read-preflight" "fallback line rule"

# Decide-failed fallback: preflight passes (dummy key) but the request cannot
# reach a server, so the worker may still work and both options are offered.
decide_failed=$(jq -n --arg c "cat $big" '{tool_input: {command: $c}}' \
  | CLAUDE_PLUGINS_GEMINI_API_KEY=dummy SHUNT_GEMINI_ENDPOINT=http://127.0.0.1:9 SHUNT_DECIDE_TIMEOUT_SECONDS=2 SHUNT_MIN_LINES=350 \
    bash "$BASH_HOOK" 2>/dev/null)
expect_block "bash-decide-failed" "$decide_failed"
reason_has   "bash-decide-failed" "bulk-reader"
reason_has   "bash-decide-failed" "sed -n"
reason_has   "bash-decide-failed" "fallback line rule"

# Small files stay allow without any model call.
expect_allow "bash-small"          "$(bash_hook "cat $small 2>/dev/null")"
expect_allow "read-small"          "$(read_hook "$small")"

exit "$fail"
