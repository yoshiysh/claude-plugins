# Runtime / skill design

## Ownership

The caller owns its SKILL instructions, active callsite, exact arguments, permissions,
and post-return gates. Source owns agent prompts, reference selection, dependency flow,
and domain review. The host owns process lifetime, accounting, and SDK policy.
Do not reimplement source planning in a second model-driven control plane.

The entry SKILL is parent-only. Runtime documentation is conditional setup material.
Legacy graph contracts are maintenance-only. A worker receives the source's exact
prompt, schema, and chosen model policy, not a parent-history fork. Referenced files
remain subject to worker access and applicable local instructions; a path is neither
an access grant nor proof the worker read the file. If evidence of reading matters,
the source must ask for a bounded citation/result, not inject every contract globally.

## Model policy

Source labels such as sonnet/opus/haiku are lookup keys, not inferred equivalents.
The operator supplies a request-level map to model IDs and optional reasoning effort.
Resolve before starting a thread; unknown keys and malformed policies fail without
inference. Emit requested key and configured target for every call. If source and
request omit a model, record host-default, not an invented resolved model ID.
Configured targets are not availability attestations; SDK/provider rejection remains
a backend failure. No automatic cheaper/larger replacement or retry is permitted.

## Rollout boundaries

The JavaScript implementation is opt-in until caller routes have their native-once,
source/args binding, and return semantics migrated and tested. Old receipt-based caller
instructions do not authorize bypassing their checks. Keep existing run maintenance
separate; do not build permanent backward-compatibility translation into the runtime.
This release does not certify write-heavy skill-creator or research workflows.

## Acceptance

Deterministic tests cover source parsing, dependency order, null/schema behavior,
deadlines, hard call limits, fresh threads, exact prompt forwarding, explicit model
policy and invalid settings. A live smoke demonstrates transport only, not full
caller equivalence. Writable mode and worktree routing are opt-in host policy, with
real Git/mock SDK coverage. Source owns artifact handoff; independent checkouts are
not strict read isolation. The baseline is an explicit commit, never an implicit copy
of dirty parent state. A bounded disposable-worktree live test remains required before
claiming writable-agent behavior; full PDCA roles are still unverified. Record call
count, usage and actual outcomes before expanding caller routing.
Never launch an extra review workflow merely to execute an already-reviewed source.

## Context selection

The parent declares host-owned context profiles and exact source-label assignments.
Source still owns prompts and reference selection; no Codex-specific source option
or filename convention is necessary. Request preflight validates profile shape and
reference hashes; dispatch records the selected profile and requested settings.
The implementation contract and rollout gates live in [CONTEXT.md](../scripts/runtime/CONTEXT.md).

The initial implementation may suppress unrelated Memory, Apps and plugins, but must
not overwrite inherited per-skill denial arrays, trim AGENTS rules, replace base
instructions or pretend that file provenance proves tool availability. Individual
skill/tool selection waits for a verified effective-inventory merge. Missing host
context policy stays visibly unverified, not silently advertised as minimal.
# Common adapter revision

The standard call shape is fixed; do not create caller-specific connection schemes.
`scripts/runtime/adapter.mjs` owns shared CLI/bound-function execution and the default
context policy. Source owns dynamic role labels, prompts and reference instructions.
See [common adapter contract](../scripts/runtime/ADAPTER.md) for configuration, authority,
selection and verification boundaries. No additional LLM role is introduced.
