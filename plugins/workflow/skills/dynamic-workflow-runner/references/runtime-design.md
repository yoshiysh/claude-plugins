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
caller equivalence. Use a lightweight read-only caller for the next integration test;
record call count, usage and actual outcomes before expanding permissions.
Never launch an extra review workflow merely to execute an already-reviewed source.
