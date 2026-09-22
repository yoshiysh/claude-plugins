#!/bin/bash
# Deterministic test for shunt_decide's trace: one JSON line per API attempt.
#
# The trace used to be written only on HTTP 200, so a run that hit the quota
# (HTTP 429 RESOURCE_EXHAUSTED) fell back to the line rule without recording
# why. Every attempt, failed or not, must now leave exactly one line carrying
# its http status, error status and outcome, and the API key must never reach
# the trace.
#
# shunt_gemini_post is stubbed, so no network call happens.
#
# Usage: bash evals/test_decide_trace.sh

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHUNT_ROOT="$(cd "$HERE/.." && pwd)"

# shellcheck source=../scripts/lib/gemini.sh
. "$SHUNT_ROOT/scripts/lib/gemini.sh"

STUB_KEY="stub-key-must-not-leak-5f3a9c"
CLAUDE_PLUGINS_GEMINI_API_KEY="$STUB_KEY"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/shunt-trace-test.XXXXXX") || exit 1
trap '/bin/rm -rf "$tmp"' EXIT
SHUNT_TRACE_FILE="$tmp/trace.jsonl"
: > "$SHUNT_TRACE_FILE"

STUB_MODE=""
shunt_gemini_post() {
  local out_file="$2"
  SHUNT_CURL_STDERR=""
  case "$STUB_MODE" in
    quota)
      printf '%s' '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota"}}' > "$out_file"
      SHUNT_HTTP_STATUS="429" ;;
    decided)
      printf '%s' '{"candidates":[{"content":{"parts":[{"text":"{\"decision\": \"block\"}"}]}}],"usageMetadata":{"totalTokenCount":42},"responseId":"stub-response"}' > "$out_file"
      SHUNT_HTTP_STATUS="200" ;;
  esac
  return 0
}

fail=0
check() {
  local name="$1" cond="$2"
  if [ "$cond" = true ]; then
    echo "PASS ($name)"
  else
    echo "FAIL ($name)"
    fail=1
  fi
}

# Runs one decide call in stub mode $2 and checks its return code and that it
# added exactly one trace line; the added line lands in LAST_LINE.
run_case() {
  local name="$1" mode="$2" want_rc="$3" before after rc
  STUB_MODE="$mode"
  before=$(wc -l < "$SHUNT_TRACE_FILE" 2>/dev/null | tr -d ' '); before=${before:-0}
  shunt_decide "cat /tmp/big.log" "/tmp/big.log" "800" "350" "line 1" "debug the crash" >/dev/null 2>&1
  rc=$?
  after=$(wc -l < "$SHUNT_TRACE_FILE" 2>/dev/null | tr -d ' '); after=${after:-0}
  [ "$rc" = "$want_rc" ] && check "$name: return code $want_rc" true || { check "$name: return code $want_rc (got $rc)" false; }
  [ $((after - before)) -eq 1 ] && check "$name: exactly one trace line" true || check "$name: exactly one trace line (added $((after - before)))" false
  LAST_LINE=$(tail -n 1 "$SHUNT_TRACE_FILE" 2>/dev/null)
}

field_is() {
  local name="$1" filter="$2" want="$3" got
  got=$(printf '%s' "$LAST_LINE" | jq -c "$filter" 2>/dev/null)
  if [ "$got" = "$want" ]; then
    check "$name: $filter == $want" true
  else
    check "$name: $filter == $want (got ${got:-<unparseable>})" false
  fi
}

run_case "quota-429" quota 1
field_is "quota-429" '.http' '"429"'
field_is "quota-429" '.error_status' '"RESOURCE_EXHAUSTED"'
field_is "quota-429" '.outcome' '"http_error"'
field_is "quota-429" '.decision' '""'
field_is "quota-429" '.purpose' '"debug the crash"'

run_case "decided-200" decided 0
field_is "decided-200" '.http' '"200"'
field_is "decided-200" '.error_status' 'null'
field_is "decided-200" '.outcome' '"decided"'
field_is "decided-200" '.decision' '"block"'
field_is "decided-200" '.responseId' '"stub-response"'

if grep -qF "$STUB_KEY" "$SHUNT_TRACE_FILE"; then
  check "no trace line contains the API key" false
else
  check "no trace line contains the API key" true
fi

# shunt_tmpfile replaces the EXIT trap set above, so clean up explicitly.
/bin/rm -rf "$tmp"
exit "$fail"
