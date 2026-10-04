# Approved named workflows on Codex

The common adapter and CLI accept `Workflow({name,args})` alongside `Workflow({scriptPath,args})`.
A call must select exactly one source selector. This is an explicit caller route; installation does
not register or intercept native tools. Native Workflow remains first choice, and a call already
attempted natively must never be retried through this runner.

The host authorizes an exact qualified name in `allowedWorkflowNames` and supplies existing canonical
absolute `trustedPluginRoots`. These are plugin roots, not skill roots or the marketplace directory.
Each plugin's `.claude-plugin/plugin.json` establishes its namespace. Exactly one trusted root must
match it. The plugin's `workflows/codex-workflows.json` registers reviewed Codex-compatible sources;
a source merely present in `workflows/` is not executable by name. The registry has `schemaVersion: 1`
and a `workflows` array. Each entry declares `name`, a direct `.js` basename `scriptPath`, runtime
`requirements`, and `continuation: "next_args"`. Optional `workspaceArg` names an args field containing
a canonical existing writable workspace. Root, manifest, workflows directory, registry, and source
must be canonical and symlink-free. Duplicate plugin identities or registrations, unknown names,
traversal, source metadata mismatch, and unavailable requirements fail before any execution agent.
The request receipt records the resolved name, plugin root, registry path, source path and source hash.
Sources remain trusted code; these checks do not turn Node VM into a hostile-code sandbox.

The runner provides no native `resumeFromRunId`. Named calls reject runner `checkpoint`/`resume` too:
that protocol depends on explicit source checkpoints and does not implement native saved-agent replay.
A named source result containing `resumable` is returned with that field set to `false`. Every other
field, including `next_args`, remains unchanged. The caller writes human answers verbatim to the source's
answer file and starts a fresh run with the returned `next_args`; it does not reconstruct state or add
`gates_answered`. A missing `next_args` means the caller cannot continue automatically. The old runDir
is never reused. CLI `completed` means the source returned normally; inspect `result.status` for
`needs_answers`, `blocked`, or `done`. A host deadline or agent-count violation still fails the entire
run and cannot be converted into a source continuation.

`pipeline` waits for every item and maps callback exceptions to null, retaining input order. Host
configuration and resource failures remain fatal outside that callback path. Schema validation uses
the original source schema; SDK structured output travels in the existing JSON-string envelope.

## prd-spec request

`workflow:prd-spec-run` is registered in this plugin. Read its caller SKILL.md and perform S0 first.
Set worker `cwd` to the existing canonical W selected by S0, outside the plugin install and target
repository. Thus agents can write W with workspace-write while plugin references and the target
repository are read by absolute path. The preflight rejects W outside prepared cwd or a read-only
backend. Make relevant repository rules and locations explicit in the verbatim input; W's workers do
not inherit the main conversation. Keep the source's `role_opts` in Claude model labels and configure
an explicit host modelMap for those labels. Mapping expresses operator policy, not provider equivalence.

Example CLI request (replace angle-bracket placeholders with actual absolute paths and model IDs):

```json
{
  "name": "workflow:prd-spec-run",
  "trustedPluginRoots": ["<workflow plugin root>"],
  "allowedWorkflowNames": ["workflow:prd-spec-run"],
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

Run `node cli.mjs REQUEST.json --live --trusted-source`. For continuation, copy the returned `next_args`
unchanged into the request's `args`, allocate a new runDir, keep cwd=W, and invoke the same name.
Questions, answers, artifact validation, saving and external actions remain owned by the caller.

## One-agent live probe

`node named-smoke.mjs <new absolute external artifact directory> <explicit Codex model>` prepares a
reviewable request and a small trusted temporary plugin. Run its request with the CLI above. Verify
both `result.contents` and the actual `marker.txt` equal `named-workflow-ok` plus one newline; keep
request, stdout, journal and file hash as evidence. This verifies named lookup, SDK transport and
writing W. It is not a complete prd-spec live run. The helper does no inference itself and does not
modify the installed plugin or production registry.
