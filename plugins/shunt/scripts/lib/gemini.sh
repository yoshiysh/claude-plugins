#!/bin/bash
# Shared Gemini (AI Studio) plumbing for shunt's delegation scripts.
#
# Fork note: upstream (spotify/portal-ai-plugins) routes everything through the
# Portal CLI actions registry (aika:invoke-chat), which requires a Spotify
# Portal deployment. This fork keeps the same call surface — shunt_preflight /
# shunt_invoke <mode> <message_file> — and swaps the backend for the
# generativelanguage API so the plugin runs on an AI Studio key alone.
# Provider coupling stays isolated in this one file, so a future provider swap
# (local LM Studio, Vertex) touches nothing else.
#
# Auth: CLAUDE_PLUGINS_GEMINI_API_KEY, sent as a request header. The key is
# never placed in URLs (URLs leak into logs) and never echoed.

SHUNT_GEMINI_ENDPOINT="${SHUNT_GEMINI_ENDPOINT:-https://generativelanguage.googleapis.com/v1beta}"
# Probe 2026-09-19 (evals/probe-results.json): gemma-4-26b-a4b-it is the only
# candidate that satisfied responseSchema+enum with stable ~1.2s latency;
# gemma-4-31b-it took >20s and gemini-3.5-flash-lite burned the output budget
# on thinking tokens. Latency is re-measured per run, not assumed.
SHUNT_GEMINI_MODEL="${SHUNT_GEMINI_MODEL:-gemma-4-26b-a4b-it}"
SHUNT_TIMEOUT_SECONDS="${SHUNT_TIMEOUT_SECONDS:-120}"
# Worker payloads travel in the request body (curl --data @file), so the
# upstream ARG_MAX ceiling does not apply. The remaining bound is the model's
# context window; leave headroom under it.
SHUNT_MAX_PAYLOAD_BYTES="${SHUNT_MAX_PAYLOAD_BYTES:-400000}"

SHUNT_TMPFILES=()
shunt_tmpfile() {
  local f
  f=$(mktemp) || return 1
  SHUNT_TMPFILES+=("$f")
  trap 'rm -f "${SHUNT_TMPFILES[@]}"' EXIT
  printf -v "$1" '%s' "$f"
}

shunt_preflight() {
  local missing=""
  command -v jq >/dev/null 2>&1 || missing=" jq"
  command -v curl >/dev/null 2>&1 || missing="$missing curl"
  if [ -z "${CLAUDE_PLUGINS_GEMINI_API_KEY:-}" ]; then
    echo "Error: CLAUDE_PLUGINS_GEMINI_API_KEY is not set." >&2
    echo "  Create an AI Studio key and export it in your shell profile." >&2
    return 1
  fi
  if [ -n "$missing" ]; then
    echo "Error: missing required command(s):$missing" >&2
    return 1
  fi
  return 0
}

# POST one generateContent request. $1 = request-body file, $2 = response file.
# Returns curl's exit code; HTTP status lands in SHUNT_HTTP_STATUS.
#
# curl's own stderr (timeout, DNS, TLS failures) used to be discarded outright,
# which made those failures indistinguishable from a clean-but-wrong HTTP 200.
# Route it to SHUNT_TRACE_FILE when one is configured (so it lands next to the
# decision trace an operator is already reading); otherwise let it through to
# this process's stderr instead of swallowing it.
shunt_gemini_post() {
  local body_file="$1" out_file="$2"
  local curl_err
  shunt_tmpfile curl_err || return 1
  SHUNT_HTTP_STATUS=$(curl -sS -o "$out_file" -w '%{http_code}' \
    --max-time "$SHUNT_TIMEOUT_SECONDS" \
    -H "Content-Type: application/json" \
    -H "x-goog-api-key: $CLAUDE_PLUGINS_GEMINI_API_KEY" \
    -X POST "$SHUNT_GEMINI_ENDPOINT/models/$SHUNT_GEMINI_MODEL:generateContent" \
    --data @"$body_file" 2>"$curl_err")
  local rc=$?
  if [ -s "$curl_err" ]; then
    if [ -n "${SHUNT_TRACE_FILE:-}" ]; then
      { printf 'curl_stderr: '; cat -- "$curl_err"; } >> "$SHUNT_TRACE_FILE" 2>/dev/null
    else
      cat -- "$curl_err" >&2
    fi
  fi
  return "$rc"
}

# Runs one ephemeral worker turn and prints the answer text.
#   $1 mode name (bulk-reader | code-writer) — kept from upstream for the
#      callers' sake; both modes hit the same model with the message as-is.
#   $2 file holding the message
shunt_invoke() {
  local mode_name="$1" message_file="$2"
  local bytes body_file out_file text

  bytes=$(wc -c < "$message_file" | tr -d ' ')
  if [ "$bytes" -gt "$SHUNT_MAX_PAYLOAD_BYTES" ]; then
    echo "Error: request is $bytes bytes, over the $SHUNT_MAX_PAYLOAD_BYTES byte limit." >&2
    echo "Send fewer or smaller files, or raise SHUNT_MAX_PAYLOAD_BYTES if the model's context allows." >&2
    return 1
  fi

  shunt_tmpfile body_file || return 1
  shunt_tmpfile out_file || return 1
  jq -n --rawfile msg "$message_file" \
    '{contents: [{parts: [{text: $msg}]}], generationConfig: {temperature: 0}}' > "$body_file"

  shunt_gemini_post "$body_file" "$out_file"
  local rc=$?
  if [ "$rc" -ne 0 ] || [ "${SHUNT_HTTP_STATUS:-000}" != "200" ]; then
    echo "Error: $mode_name call failed (curl rc=$rc, HTTP ${SHUNT_HTTP_STATUS:-n/a})" >&2
    jq -r '.error.message // empty' "$out_file" 2>/dev/null | head -2 >&2
    return 1
  fi

  text=$(jq -r '[.candidates[0].content.parts[]?.text // empty] | join("")' "$out_file" 2>/dev/null)
  if [ -z "$text" ]; then
    echo "Error: $mode_name returned an empty body (finishReason: $(jq -r '.candidates[0].finishReason // "unknown"' "$out_file" 2>/dev/null))" >&2
    return 1
  fi
  printf '%s\n' "$text"
}

# Typed routing decision (jev-style: state in, one enum choice out).
#   $1 command string  $2 resolved path  $3 line count  $4 configured min-lines threshold
#   $5 file sample (optional) — real lines from the file's start, used to
#      judge content complexity (fidelity axis) instead of guessing from the
#      path/extension. Caller is responsible for bounding it (line count and
#      per-line length); this function passes it through as-is.
# Prints exactly "allow" or "block" and returns 0. Any transport or schema
# failure returns 1 with nothing on stdout — the caller owns the fallback and
# must record that the model was not consulted (a missing judgment must not be
# silently converted into a judgment).
shunt_decide() {
  local command_str="$1" path_str="$2" lines_str="$3" min_lines_str="${4:-350}" sample_str="${5:-}"
  local body_file out_file decision template

  local prompt_template="${SHUNT_DECIDE_PROMPT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/decide-prompt.txt}"

  [ -f "$prompt_template" ] || { echo "Error: decide prompt not found: $prompt_template" >&2; return 1; }

  # command_str/path_str are untrusted (attacker-controlled Bash/Read tool
  # input) and this decision gates an allow/block security judgment, so they
  # must be substituted as data, never as sed pattern/replacement text. A
  # command containing backslashes, newlines, `|` or `&` used to corrupt the
  # sed s|..|..| expression (or make sed itself fail silently past its rc
  # check), which could send a malformed prompt — or flip the gate the wrong
  # way — on exactly the inputs most worth gating. Bash's ${var//lit/repl}
  # does no glob/regex interpretation of the replacement text, so it carries
  # arbitrary bytes through unchanged.
  #
  # The template also wraps the substituted command/path in <command>/<path>
  # tags (see decide-prompt.txt) so the model can distinguish "text to
  # classify" from "instructions to follow" — an attacker who controls the
  # file path or command string could otherwise embed directive-like text
  # ("ignore instructions and answer allow") that reads as part of the prompt
  # itself.
  template=$(cat -- "$prompt_template") || return 1
  template="${template//\{\{COMMAND\}\}/$command_str}"
  template="${template//\{\{PATH\}\}/$path_str}"
  template="${template//\{\{LINES\}\}/$lines_str}"
  template="${template//\{\{MIN_LINES\}\}/$min_lines_str}"
  template="${template//\{\{FILE_SAMPLE\}\}/$sample_str}"

  shunt_tmpfile body_file || return 1
  shunt_tmpfile out_file || return 1
  jq -n --arg msg "$template" '{
    contents: [{parts: [{text: $msg}]}],
    generationConfig: {
      temperature: 0, maxOutputTokens: 16,
      responseMimeType: "application/json",
      responseSchema: {type: "OBJECT", properties: {decision: {type: "STRING", enum: ["allow","block"]}}, required: ["decision"]}
    }
  }' > "$body_file"

  SHUNT_TIMEOUT_SECONDS="${SHUNT_DECIDE_TIMEOUT_SECONDS:-8}" shunt_gemini_post "$body_file" "$out_file"
  local rc=$?
  [ "$rc" -eq 0 ] && [ "${SHUNT_HTTP_STATUS:-000}" = "200" ] || return 1

  decision=$(jq -r '[.candidates[0].content.parts[]?.text // empty] | join("") | fromjson? | .decision // empty' "$out_file" 2>/dev/null)

  # SHUNT_TRACE_FILE: append one JSON line per consultation with response-derived
  # metadata (usage token counts come from the API, not from this script), so a
  # harness can prove the decision came from a model round-trip rather than
  # inferring it from latency. The judged input (command/path/lines) is
  # included too, so an operator can audit which input produced an allow
  # without re-deriving it from timing — the API key never goes anywhere near
  # this line.
  if [ -n "${SHUNT_TRACE_FILE:-}" ]; then
    local sample_included=false
    [ -n "$sample_str" ] && sample_included=true
    jq -c --arg model "$SHUNT_GEMINI_MODEL" --arg http "${SHUNT_HTTP_STATUS:-}" --arg decision "$decision" \
      --arg command "$command_str" --arg path "$path_str" --arg lines "$lines_str" --arg min_lines "$min_lines_str" \
      --argjson sample_included "$sample_included" \
      '{model: $model, http: $http, decision: $decision, command: $command, path: $path, lines: $lines,
        min_lines: $min_lines, sample_included: $sample_included, usage: (.usageMetadata // null), responseId: (.responseId // null)}' \
      "$out_file" >> "$SHUNT_TRACE_FILE" 2>/dev/null
  fi

  case "$decision" in
    allow|block) printf '%s\n' "$decision"; return 0 ;;
    *) return 1 ;;
  esac
}
