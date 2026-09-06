# JavaScript workflow runtime — experimental opt-in

This is a new executable runtime, not the existing source-to-manifest bridge.
Existing skill routing is unchanged. Do not claim that installing this prototype
enables native Workflow interception, resume, or unchanged execution of every caller.

## Contract

`Workflow({scriptPath,args}, hostOptions)` executes a trusted script in a separate
Node process. The first statement is a literal `export const meta = {name,description}`;
the remaining body supports top-level await and return. The parser removes only the
metadata statement by its AST source span, not regex or model translation. Names and
extensions are arbitrary. Imports and additional exports fail before execution.

The injected API is `agent(prompt,{model,label,phase,schema,isolation})`, `parallel(thunks)`,
`pipeline(items,fn)`, `phase(title)`, `log(message)`, and `args`. Agent results are text
or schema-validated JSON. Backend failures and invalid outputs become null. Ordered
fan-out retains nulls. Configuration errors, resource limits and script exceptions
fail the entire run; catching an agent error cannot bypass host limits.

For structured results the SDK receives a fixed strict envelope `{json: string}`.
The original role prompt is retained as a prefix, followed by transport instructions
and the original JSON Schema. After parsing the envelope and its JSON string, the
runtime validates against the unchanged source schema. Optional properties remain
optional and additional properties are not silently forbidden. This is a transport
adaptation, not byte-identical SDK prompt forwarding; malformed envelopes fail without
retry. Text-only calls retain the original prompt and have no envelope.
SDK error events are drained before surfacing failure, and cancellation listeners
are detached when a turn ends, preventing later host aborts from hitting cleaned-up
SDK child processes.

This shape follows [Claude workflows](https://code.claude.com/docs/en/workflows).
No filesystem, shell, module loading or clock/randomness API is intentionally exposed
to the body. **Node vm is not a hostile-code security boundary. Only run reviewed,
trusted source.** Process separation is for lifecycle control, not an untrusted-code
sandbox. Worker permissions are independent of the JavaScript process.

## Install and verify without inference

In this directory run `npm ci --ignore-scripts`, then `npm test`.
Dependencies are pinned in package-lock.json. Tests use mock backends and real JS.

## Explicit live execution

Create a JSON request containing `scriptPath`, `args`, a new `runDir`, and an explicit
worker `cwd`. Optional `model` and `modelReasoningEffort` select the default;
`modelMap` maps source model names to explicitly chosen Codex models. Entries are
either model ID strings or objects with `model` and optional `modelReasoningEffort`.
Unknown source labels and malformed mappings fail before the call starts. Each call
logs `model.selected` with its requested label, target and effort. With no explicit
default, `host-default` is recorded; the actual host-selected ID is not inferred.
No Claude-to-Codex equivalence or target availability is implied.
`limits` accepts maxAgents, concurrency, timeoutMs and maxOutputBytes.
Unknown request, host, backend, and limit fields are rejected, including resume and
permission overrides. `requirements` may be declared in source metadata and/or the
host request; both are checked before run creation or agent dispatch. Default capabilities
are read-only and fresh-thread; explicit workspace configuration can add workspace-write
and worktree. Callers must declare
their needs, including capabilities hidden behind dynamically constructed options.
As a conservative additional gate, literal option-shaped objects containing model,
label or schema and unsupported capability keys are rejected (literal isolation:
"worktree" is accepted only when the host provides worktree capability)
across the whole source, even in inactive branches. This may reject similarly shaped
domain data; it is not whole-program capability inference. Computed/indirect options
still require truthful requirements and retain runtime validation.
Run `node cli.mjs REQUEST.json --live --trusted-source`.

Default limits are two agent calls, two concurrent workers and 60 seconds. The
Codex SDK backend creates a fresh thread for each call, read-only, network disabled,
web search disabled, approvals never. It does not inherit this Desktop conversation.
The SDK uses its pinned CLI unless codexPathOverride is explicitly supplied.
Normal local Codex authentication/configuration applies; no credential is copied into
the source worker. Installed MCP tools and host policies need separate verification:
read-only filesystem settings are NOT an external-service write prohibition.
Do not use this adapter for workflows requiring tool allowlists or approval forwarding.

### Explicit writable and isolated checkouts

The optional request `workspace` object accepts `mode` (read-only by default, or
workspace-write), plus `worktreeRoot` and `baseCommit` together. `worktreeRoot` must
be an existing absolute directory separate from the repository; `cwd` must be its
repository root, and `baseCommit` must be an existing full lowercase commit hash,
not a branch or HEAD. Host permission applies uniformly to all calls; source cannot
escalate it. Network/search remain disabled and approvalPolicy remains never.

With this policy, `agent(prompt, {isolation: "worktree", ...})` receives a unique
detached Git checkout at that exact commit. Other agents use the original cwd.
Dirty/untracked parent files are not copied. Source owns artifact transfer between
workers; checkout isolation does not prevent reading absolute paths elsewhere.
Only use trusted repositories: disabling Git hooks does not disable checkout filters.
Worktrees are preserved after success, failure or cancellation; no automatic cleanup,
merge, reset or retry occurs. Events record allocated/ready paths and baseline, and
request.json records the canonical backend policy. Setup Git commands have their own
10-second timeout; setup precedes the workflow execution deadline.

Writable SDK options and unchanged PDCA control flow have mock-backed tests with real
Git checkouts. Actual writable live-agent enforcement and full PDCA role execution
remain unverified; do not infer those guarantees from the mock SDK.

`request.json`, source.txt and events.jsonl contain source/args hashes, phases,
task IDs, thread IDs, results, failures and completed-turn token usage. They may
contain private data; run directories/files use owner-only modes. Full tool outputs
are not relayed. The CLI emits only the terminal result. Await it through the host's
normal background process mechanism; no model-driven per-task polling is required.

## Deliberate gaps / rollout gate

### Optional command environment preflight

Request `environment` accepts `path` (a PATH string of absolute, nonempty entries)
and a nonempty `requiredCommands` array of simple executable names. Include hook
dependencies such as rtk explicitly when the host uses them. No platform-specific
directory is inserted automatically. The backend passes this PATH via per-instance
SDK `shell_environment_policy.set.PATH`; global configuration is never edited.
Missing executables fail before run creation and thread dispatch. Canonical executable
paths and the selected PATH are recorded in request.json backendPolicy.environment.
The check is repeated before dispatch, but does not prevent subsequent filesystem drift.

This is an executable-file lookup, not execution in the actual worker sandbox or a
proof of shell-startup/hook compatibility. Shell startup can still alter PATH; required
commands do not automatically enumerate hook dependencies. Omitting environment retains
host behavior and records host-default-unverified. No executable is run by preflight.
Neither minimal injected context nor a hard inner-turn token limit is implemented.

- No transparent replay/resume. A reused run directory is rejected. Failed runs list
  in-flight task IDs; abort delivery does not prove external effects were rolled back.
- No live token hard cap: this SDK reports completed-turn usage, not a strict debit
  reservation. Agent count/deadline limits are not token or billing guarantees.
- No automatic retry, model substitution, per-agent tool allowlist, human approval
  forwarding, nested workflow support, native progress UI or caller auto-routing.
- Claude cache staggering and runtime implementation equivalence are not claimed.
- Runtime unit tests are not a live Codex or unchanged existing-skill E2E test.

First validate mock scheduling, error and resource behavior. Then perform exactly one
two-agent read-only live smoke with an explicit request and record usage. Only after
that evaluate one lightweight existing caller and design routing changes separately.
The SDK boundary is replaceable by an App Server adapter when finer-grained approval
and event handling is needed; see [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk).
