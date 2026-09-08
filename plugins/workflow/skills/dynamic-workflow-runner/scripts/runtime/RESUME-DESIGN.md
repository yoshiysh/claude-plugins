# Safe resume design — not enabled

## Status and inspection

The runtime still rejects resume execution. `checkpoint-audit.mjs` is a read-only
evidence inspector, not a replay backend or an authorization gate. Run:

```sh
node checkpoint-audit.mjs /absolute/path/to/previous/run
```

It checks the source and args hashes, journal sequence and lifecycle, result schemas,
and terminal in-flight inventory. It reports completed historical result candidates
separately from started, failed or null-result tasks. `executable` is always false.
The evidence digest detects changes relative to a recorded digest; it does not
authenticate an operator-controlled journal or prove artifact freshness. All input
files must be read from a trusted, quiescent run directory. The inspector does not
lock the files or provide an atomic cross-file snapshot.

## Why the existing run cannot be blindly replayed

The current runtime queues journal appends without awaiting durability before backend
dispatch and source reply. It logs started calls, but not every accepted queued call
and its full prompt, nor the moment a reply was delivered to the source. A missing
thread ID or result cannot prove that no inference, filesystem write or external
operation happened. Existing source/args hashes do not bind mutable reference files.

Never fabricate a missing result, retry an ambiguous task, or replace it with null
to force progress. Failed and null-result tasks also need outcome reconciliation.
Read-only filesystem mode alone does not prove external services had no effects.
Legacy results remain evidence until dependencies and outcomes are independently
bound. No caller-specific exception is justified by a familiar phase or label.

## Required protocol for a future executable checkpoint

1. **Write-ahead journal:** durably record every accepted call and its prompt/options
   digest, then a dispatch intent before the backend may act. Persist each result and
   the ordered reply-release event before allowing source continuation. Journal I/O
   failure must stop new dispatch, not merely fail finalization.
2. **Quiet checkpoint:** close admission, drain accepted work, and certify that no
   task or backend process is unresolved. A crash between dispatch intent and a
   durable result is ambiguous and requires reconciliation, never an automatic retry.
3. **Execution identity:** bind source/args, runtime/protocol version, capability,
   model selection and reasoning policy, worker environment and source-declared
   references/artifacts. Require an explicit freshness decision for live evidence;
   absence of declarations is not proof of no dependencies.
4. **Transcript replay:** reexecute only the trusted JavaScript control flow, with
   historical agent calls fulfilled from validated results. Match each prompt and
   options before reuse; preserve recorded reply ordering, including concurrency.
   Do not dispatch any new backend work until the entire prior transcript boundary
   has matched. Promise races and data-dependent branches make an ID-only cache unsafe.
5. **New-run ownership:** never append to the original run. Acquire an exclusive
   continuation lease and record predecessor digest, checkpoint boundary and remaining
   budget. Do not reset or increase budget silently. An interrupted continuation is
   itself another ambiguous run requiring a new audit.
6. **Effect reconciliation:** bind any operator decision to an exact task and its
   evidence. Distinguish externally verified completion, verified not-dispatched and
   genuinely unknown outcomes. General approval to continue is not evidence of an
   outcome. Cross-host and writable-worktree artifact transfer remain explicit.

## Acceptance gates

Before execution is enabled, fault-injection tests must cover every journal/dispatch/
reply boundary, parallel out-of-order completions and races, source/prompt/args/model/
reference drift, torn or edited journals, a running predecessor, simultaneous resume
attempts, schema failures, and unchanged budget accounting. Counting backend calls
must prove zero redispatch of completed work and zero new dispatch before transcript
validation. Mock proof must be followed by one small, separately authorized live test;
the heavy review workflow must not be the first executable resume experiment.

The audit tests cover only evidence inspection. They do not satisfy these execution
gates. Neither this design nor an inspector result claims exactly-once remote effects.
# Diagnostic rehearsal (not executable resume)

`checkpoint-rehearsal.mjs` exports `rehearseCheckpoint({previousRun, runDir,
trustedSource: true})`. It executes the saved trusted JavaScript with a backend
that can only return recorded successful results. It accepts no SDK or external
backend. A prompt/options mismatch is fatal; the first missing or unresolved
outcome stops execution. Output is written to a new, exclusive run directory.
`modelCalls: 0` describes this diagnostic only, not the historical run.

Use only quiescent, trusted evidence directories: reads are not a locked atomic
snapshot, and the saved source is read again by the worker launcher. The audit
fingerprint is not an authenticity guarantee. Rehearsal cannot certify freshness
of referenced files, absence of external effects, or historical reply-delivery
ordering. It must never be promoted to a live continuation permit.
