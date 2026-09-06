# Prototype validation — 2026-09-06 JST

## Implemented boundary

Real JavaScript source -> isolated process -> bounded host scheduler -> Codex SDK.
No LLM translator, per-run semantic-review agents, or model-driven scheduling loop.
This prototype is opt-in and does not replace the existing caller route.

## Live smoke (one run, two calls, no retry)

- SDK 0.153.4 using its bundled CLI; model not overridden.
- Source: smoke.flow, the same format as the documented Claude metadata/body shape.
- Fresh temporary cwd, read-only worker settings, network/web search disabled.
- Started 2026-09-05T19:08:31.646Z; completed 19:08:43.298Z (11.652 seconds).
- Result: `{"text":"workflow smoke","matches":true}`.
- First worker input 19,190, output 20; second input 19,042, output 15.
- Total input 38,232; cached input 0; output 35. Reasoning output is a subset,
  not added again. These counts exclude the parent implementation conversation.
- Runtime journal reported exactly two agent starts/completions and no in-flight
  tasks at successful return.
- Thread IDs: `01a072f8-f8dc-7d91-9ea4-340aa7ee36ad`,
  `01a072f9-0b26-7c93-94eb-9d477c4e322f`.

Raw local run directory (temporary; not portable or a fixture dependency):
`/var/folders/j1/xj39qyh11db8zh2gh50ybkp40000gn/T/workflow-live-smoke-PtzNGU/run`.

## Interpretation

The narrow JS-to-Codex execution path is proven live. This does not establish
unchanged pdca/research/skill-creator execution, tool-policy parity, replay, sandbox
security for untrusted JS, or production readiness. Baseline worker inputs remain
about 19k tokens. Do not present the old preflight-vs-this-smoke token difference
as a controlled benchmark or a quota/price conversion.

Mock tests cover source parsing, ordered/nested fan-out, null failures, schema
validation including Unicode length, call/deadline/output limits, unawaited work,
SDK options/events and missing completion. Existing runner tests remain separate.

Final `make check` exited 0: 104 Node tests (14 new runtime/adapter tests),
41 Python tests and 36 fixture preflights passed. Model-driven fixture evals remain
not_executed (72 variants); they are not the two-call live smoke above. Portability
reported existing cleanup-branches/manage-marketplace-plugin categories; the
dynamic-workflow-runner entry was clean. `git diff --check` passed.

The existing build_skill.js was parsed successfully without execution. This proves
only source-format acceptance, not its runtime behavior or quality semantics.

## Skill/context/model update — subsequent local verification

The parent entry now separates source-owned prompts/references from runtime control,
and moves the old manifest instructions to LEGACY.md. Model mapping accepts explicit
model/effort pairs, snapshots policy, and emits model.selected for each SDK call.

Repository verification exited 0 with 106 Node tests, 41 Python tests and 36 fixture
preflights. The four adapter/model tests were rerun after the final effort assertion
and passed. No additional live inference or model-driven reviewer was started.
The earlier smoke above predates model.selected logging and is not evidence of a live
model/effort mapping test. Caller migration and unchanged-caller E2E remain open.

The portability scanner reports env_build at this document's historical command
line (the earlier verification command), not a discovered missing runtime dependency.
That lexical warning is retained rather than silently suppressed. Independently,
the actual runtime still requires Node, installed pinned npm dependencies and Codex
authentication; installation alone is not verified as zero-setup execution.
