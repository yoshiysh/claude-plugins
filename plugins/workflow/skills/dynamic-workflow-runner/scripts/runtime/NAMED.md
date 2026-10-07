# Named workflows from trusted plugins on Codex

The common adapter and CLI accept `Workflow({name,args})` alongside `Workflow({scriptPath,args})`.
A call must select exactly one source selector. This is an explicit caller route; installation does
not register or intercept native tools. Native Workflow remains first choice, and a call already
attempted natively must never be retried through this runner.

The host supplies existing canonical absolute `trustedPluginRoots`. These are reviewed plugin roots;
trust applies to the sources in those roots. A root is not a skill directory or marketplace directory.
Each root's `.claude-plugin/plugin.json` establishes its namespace. Exactly one trusted root must match
the requested namespace. The resolver reads the direct `.js` files in that plugin's `workflows/`
directory and selects the unique literal `meta.name` matching the local part of the qualified name.
A source filename need not match its metadata name. No per-caller name allowlist or separate Codex
registration file is required. The qualified name is `<plugin namespace>:<source meta.name>`.

Root, manifest directory/file, workflows directory and direct source files must be canonical and
symlink-free. Named manifest/source reads use the validated regular-file handle, check file identity
before and after reading, and reject replacement or invalid UTF-8. The selected source is rechecked
against its admitted file identity and exact bytes. These checks do not create an atomic snapshot of
the ancestor directories. Invalid namespaces or source names, ambiguous plugin identities, duplicate source
metadata names, missing names and changed source bytes fail before an execution agent is dispatched.
The request journal records the resolved name, plugin root, source path and source hash. The common
runtime still validates source syntax, declared requirements, model mappings, options and host limits.
Each invocation resolves its catalog once and keeps that snapshot through adapter classification and
execution. Host-bound update arguments retain the selected source identity. The selected source is
read again and checked against the snapshot before execution; later calls resolve the current catalog.
Name discovery does not certify that a caller's graph or required capabilities are supported.
Sources remain trusted code; these checks do not turn Node VM into a hostile-code sandbox.

Both selectors preserve the source result, including `resumable` and `next_args`, without rewriting
fields. Caller contracts decide how to interpret that result and continue. Native `resumeFromRunId`
is unsupported; a returned native resume hint cannot enable it. Sources with explicit quiescent
checkpoints may use the common runtime `checkpoint`/`resume` protocol under its existing identity,
dependency, freshness and single-use rules; see [runtime README](README.md#explicit-checkpoint-and-continuation).
The old runDir is never reused. CLI `completed` means the source returned normally; source-specific
statuses remain inside `result`. A host deadline or agent-count violation still fails the entire run
and cannot be converted into a source continuation.

`pipeline` waits for every item and maps callback exceptions to null, retaining input order. Host
configuration and resource failures remain fatal outside that callback path. Schema validation uses
the original source schema; SDK structured output travels in the existing JSON-string envelope.

## prd-spec request

`workflow:prd-spec-run` resolves this plugin's `workflows/prd-spec.js` by its literal metadata name.
Read the [caller SKILL.md](../../../prd-spec/SKILL.md) and perform S0 first.
Set worker `cwd` to the existing canonical W selected by S0, outside the plugin install and target
repository. Thus agents can write W with workspace-write while plugin references and the target
repository are read by absolute path. The caller/host must check that W is the worker cwd, writable,
and outside those roots, and explicitly request `workspace-write` capability. These are prd-spec's
workspace requirements, not generic named-source argument rules. Make relevant repository rules and
locations explicit in the verbatim input; W's workers do
not inherit the main conversation. Keep the source's `role_opts` in Claude model labels and configure
an explicit host modelMap for those labels. Mapping expresses operator policy, not provider equivalence.

Example CLI request (replace angle-bracket placeholders with actual absolute paths and model IDs):

```json
{
  "name": "workflow:prd-spec-run",
  "trustedPluginRoots": ["<workflow plugin root>"],
  "args": {
    "workspace": "<W>",
    "skillDir": "<workflow plugin root>/skills/prd-spec",
    "entry": "existing",
    "existing_docs": [{"key": "requirements/example", "source": "<original document path>", "fixed": false}]
  },
  "cwd": "<W>",
  "workspace": {"mode": "workspace-write"},
  "requirements": ["workspace-write"],
  "modelMap": {"opus": "<explicit Codex model>", "sonnet": "<explicit Codex model>"},
  "runDir": "<new external run directory>",
  "limits": {"maxAgents": 200, "concurrency": 4, "timeoutMs": 3600000, "agentTimeoutMs": 300000, "maxOutputBytes": 20000000}
}
```

The limits are an example host budget, not a completion or token-budget guarantee. The source's native
`budget` global is absent, so its token-based `budgetOut()` does not stop Codex runs. Inspect actual
SDK usage in events; host call counts and timeouts are not token limits. `role_opts` overrides require
corresponding explicit mappings. Do not claim all caller graphs or full prd-spec live behavior is verified.
The production source is unmodified; mock tests cover its normal run, all three human gates, continuation,
failed agents, and rejected altered continuation hashes through the real VM and schema validator.

Run `node cli.mjs REQUEST.json --live --trusted-source`. For this caller's continuation, ignore the
native `resumable` hint, write human answers verbatim to the source's answer file, and copy the returned
`next_args` unchanged into the request's `args`. Allocate a new runDir, keep cwd=W, and invoke the same
name without adding `gates_answered`. A missing `next_args` prevents automatic continuation. This
caller does not use runner checkpoints. Questions, answers, artifact validation, saving and external
actions remain owned by the caller; see its SKILL.md for the authoritative continuation rules.

## skill-creator request

`skill-creator:skill-creator-build` and `skill-creator:skill-creator-review` resolve the skill-creator plugin's
`workflows/build_skill.js` and `workflows/review_skill.js` by their literal metadata names. The trusted root is
the skill-creator plugin root (not this workflow plugin), and `args.skillDir` is
`<skill-creator plugin root>/skills/skill-creator-best-practices`. Read the
caller SKILL.md first: it runs `scripts/select_runtime.js` before every call, and its selection decides whether
a runner request is made at all. Only `create` and host-policy-bound `update` are runnable; `review` stops as
`rejected_source` before any agent is dispatched. The update authority checks key on the literal metadata name
`skill-creator-review`, so a named request reaches the same updatePolicy binding, staging and checkpoint
restrictions as a scriptPath request. Do not pass `args.stagingDir`; the host updatePolicy selects staging.
Configure an explicit modelMap for the labels the source passes (update uses `opus` and `sonnet`;
create drops the hints listed in its portability declaration). Persona approval, saving and update
application remain owned by the caller.

```json
{
  "name": "skill-creator:skill-creator-build",
  "trustedPluginRoots": ["<skill-creator plugin root>"],
  "args": {"skillDir": "<skill-creator plugin root>/skills/skill-creator-best-practices", "...": "caller args"},
  "runDir": "<new external run directory>"
}
```

## One-agent live probe

`node named-smoke.mjs <new absolute external artifact directory> <explicit Codex model>` prepares a
reviewable request and a small trusted temporary plugin. Run its request with the CLI above. Verify
both `result.contents` and the actual `marker.txt` equal `named-workflow-ok` plus one newline; keep
request, stdout, journal and file hash as evidence. This verifies named lookup, SDK transport and
writing W. It is not a complete prd-spec live run. The helper does no inference itself and does not
modify the installed plugin or production sources.
