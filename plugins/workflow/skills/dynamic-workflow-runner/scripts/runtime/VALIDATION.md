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

## Unsupported-input regression and live transport recheck

Before the fix, a direct request with resumeFromRunId and a new runDir ran the source
again; unsupported host permission fields were ignored. Unchanged pdca.js invoked its
mock builder once before rejecting the runner's isolation option. These were reproduced
without live inference.

The regression checks now reject unknown request/host/backend/limit fields, reject
unsupported declared requirements, and reject the unchanged PDCA literal isolation
option before run creation and with zero backend calls. Static option detection is
conservative and incomplete for computed options; caller requirements remain necessary.
This is rejection coverage, not implementation of worktree, writes, approval or resume.

One subsequent live smoke ran on 2026-09-06 from 10:57:17.634Z to 10:57:30.824Z:
two calls, result `{"text":"workflow smoke","matches":true}`, inFlight empty.
Input 18,759 + 18,788 = 37,547; output 21 + 15 = 36; cached input zero.
Reasoning output is already included. Parent conversation usage is excluded.
Both model events recorded host-default; explicit model/effort availability was not tested.
No retries and no full PDCA/research/skill-creator live execution were performed.
Temporary evidence directory:
`/var/folders/j1/xj39qyh11db8zh2gh50ybkp40000gn/T/workflow-live-smoke-o5muvh/run`.

## Explicit workspace policy — local verification

The default remains read-only. An explicit host policy can select workspace-write
and provide an existing separate worktree root plus an exact commit baseline.
Source requirements and literal isolation options are checked against that policy.
Three added tests pass using actual temporary Git repositories:

- Two concurrent isolated checkouts start from the committed baseline, not dirty
  parent contents; changes in one do not modify the other or the parent checkout.
- Invalid modes, incomplete configuration, symbolic baselines, overlapping paths and
  pre-aborted allocation fail without worker dispatch.
- Unmodified PDCA JavaScript completes Build → Run → Verify → Analyze through a mock
  SDK (four calls). Only Run receives its own worktree. SDK options record writable
  mode and approvals never. Mock role responses do not read actual role references;
  this is routing/schema coverage, not full PDCA behavior or quality validation.

No additional live inference was performed for this change. Actual writable-agent
execution, approval forwarding, resume and unchanged-caller live E2E remain open.
The SKILL entry and runtime documentation were aligned with this bounded capability;
the formal skill-creator evaluation Workflow was not executed.
