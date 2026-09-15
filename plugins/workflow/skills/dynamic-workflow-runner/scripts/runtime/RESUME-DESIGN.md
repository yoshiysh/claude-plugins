# Quiescent checkpoint resume — experimental opt-in

## Implemented boundary

`resume.mjs` implements `quiescent-checkpoint-v1` behind an explicit `checkpoint`
host configuration. The common adapter and CLI forward this configuration and the
optional `resume` object. Existing source without this opt-in keeps the old runtime.
This does not enable caller routing, mutate any skill source, or resume old runs.
See [configuration and source API](README.md#explicit-checkpoint-and-continuation).

Source must explicitly `await checkpoint(label)`. Worker admission must be empty,
and runtime queue/in-flight inventory must be empty. Any failed, null or schema-invalid
historical result prevents sealing even if the source handled that null. The backend
promise must represent drained operation completion, as the SDK backend does; a custom
backend must honor this contract. An arbitrary agent await, `phase()` or a log line is
not a certified source boundary.

The selected `stopAfter` boundary records a sealed terminal checkpoint and stops the
worker. Other explicit checkpoints pass through. Only that sealed terminal checkpoint
can be resumed; crashes and deadline failures, including crashes during seal creation,
are not retryable. No automatic effect reconciliation is implemented.

## Durable evidence and continuation

1. Source/request files and a hash-chained journal are written with file fsync;
   run directory creation/file entries and checkpoint seal are directory-synced.
2. Every accepted call stores its complete prompt/options before queue admission.
   Dispatch intent is synced before backend invocation. Results and ordered reply
   release are synced before source replies. Journal failures poison dispatch.
3. Checkpoint sealing requires no pending work, records cumulative call/output usage,
   remaining execution milliseconds and dependency file hashes, then writes a seal
   binding source, request and final journal digest. No later journal event is allowed
   for an executable stopped run. A failure after the boundary but before safe stop
   either has no seal or a later failure event and is rejected.
4. Resume canonicalizes the predecessor directory and exclusively creates its
   `continuation.lock`. A failed acquisition never removes another owner's lock.
   Validation failure before successor ownership releases only this attempt's lock.
   After successor creation the claim is permanent, including on failure. A successor
   can be resumed only if it reaches its own new sealed checkpoint.
5. A new directory records the predecessor digest and copies the validated historical
   transcript (prior stops become passed checkpoints). Original evidence is untouched.
   The predecessor directory gains only the single-use continuation claim.
6. Trusted control flow reexecutes from the beginning. Each agent prompt/options/id,
   phase/log and checkpoint must match the recorded interaction order. Historical
   replies use validated results in their recorded release order, not completion or
   admission order. No live dispatch is admitted until the whole transcript reaches
   the exact prior boundary. The source executes the already-read, identity-checked
   source bytes, not a subsequent reread of a mutable path.

## Identity, freshness and limits

Source and args hashes, runtime/backend implementation and package-lock hashes,
source worker PATH/Node version, capabilities, declared requirements, backend policy,
model mapping/reasoning, file inventory and configured limits must match. SDK calls
require explicit model/reasoning and worker environment. Host-default model/environment
selection is not considered pinned. The full file inventory is explicit; files must
exist when a run starts and are hashed again at the boundary, during resume validation,
and before opening live admission after replay.

The inventory must include relevant configuration, reference/artifact and executable
files. Paths alone in environment policy are not binary-content identity. Neither a
file inventory nor code hashing enumerates all host config, installed plugins, service
state, authentication or mutable network evidence. The operator's
`dependenciesComplete: true` and `freshness: "verified"` declarations are necessary
trust assumptions, not machine-certified completeness or fresh external state. Live
evidence requires an actual renewed check; if that changes an input file, continuation
is rejected and a new analysis is required.

Calls and output bytes carry forward cumulatively. Replay does not count them twice.
Execution deadline carries the previous remaining milliseconds and replay consumes
that allowance. Offline pause and preflight/setup time are outside the execution
deadline, matching the runtime's setup/execution distinction. Configured limits cannot
be changed during continuation; no budget increase/reset or token-cap guarantee exists.

## Verification and limitations

`resume.test.mjs` uses mock backends and real JavaScript workers. It exercises ordinary
continuation without historical redispatch; reverse parallel completion and Promise.race;
multi-checkpoint budget carryover; source/args/backend/file/budget drift; failed/null and
pending work; missing/torn/edited evidence; simultaneous continuation claims and retained
single-use locks; common adapter SDK mocks; and write/fsync faults at accepted, dispatch,
result, reply and checkpoint events. Prior non-opt-in runtime/audit/rehearsal tests remain
separate regression coverage. These are not exhaustive distributed crash proofs.

Use trusted, quiescent run directories. Hashes detect inconsistent/torn evidence but do
not authenticate operator-controlled files against a coordinated rewrite. Filesystem
checks are not an atomic filesystem snapshot and cannot prevent later external mutation.
Do not claim arbitrary JavaScript determinism, exactly-once remote side effects, hostile
code isolation, cross-host transfer, automatic reconciliation or universal resume.
No live LLM resume experiment is included. A small separately authorized live test is a
rollout gate; the heavy review workflow must not be the first such experiment.

## Legacy diagnostics remain non-executable

`checkpoint-audit.mjs` inspects old evidence read-only. `checkpoint-rehearsal.mjs`
reexecutes saved trusted JavaScript with recorded successful results and no external
backend, stopping at the first unknown call. Their `executable: false` is unchanged.
Legacy journals do not establish complete accepted-call, reply-release, dependency or
effect histories and cannot be promoted to executable checkpoints. Do not synthesize
missing results or replace unknown effects with null to force progress.
