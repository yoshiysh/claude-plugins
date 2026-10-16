# Prompt audit criteria

Use this reference for the `prompt-audit` review lens. It is a shared, model-neutral checklist; it does not depend on a Claude-only skill or claim that a prompt pattern is obsolete in a particular model release.

## Scope

Review only instructions that direct a model or agent: role, priority, task, inputs, tools, constraints, decision rules, output contract, and stop or escalation behavior. Do not turn the audit into a general code, security, or prose review.

When the target itself names a model, tool, API, or version, check those instructions against authoritative documentation included in the frozen target or available in the current environment. If there is no such evidence, do not claim that model-specific guidance is outdated. Report a concrete internal contradiction or reliability defect when one exists; otherwise return no findings.

## Finding criteria

Report a finding only when the target contains specific evidence for at least one of these conditions and the effect on execution can be explained:

1. **Conflicting instructions**: two instructions assign incompatible priorities, actions, or output requirements without a rule for resolving the conflict.
2. **Unreachable or missing behavior**: the prompt requires a tool, input, state, or capability that its caller does not provide, or omits a condition needed to choose among materially different actions.
3. **Unbounded or unstable procedure**: a loop, retry, fan-out, or decision is left to unconstrained judgment where repeated execution can change results or exceed the task's stated bounds.
4. **Unsupported model or tool assumptions**: the prompt asserts behavior that conflicts with authoritative evidence for the named target, or depends on a tool/API that the caller does not make available.
5. **Output-contract mismatch**: instructions conflict with the schema or consume fields that the caller does not produce, so valid work can be rejected or incomplete work can appear complete.
6. **Stale internal guidance**: instructions refer to removed files, old interfaces, superseded policy, or behavior contradicted by the target's current sources.

Do not report a style preference as a defect. Shorter wording, a different tone, or a familiar prompting convention is not a finding unless the target evidence shows a material failure mechanism.

## Confidence and action

- **High**: the conflict, broken path, unsupported capability, or obsolete reference is directly demonstrated by the target or an authoritative source.
- **Medium**: the reliability failure has a clear mechanism in the target, but its impact depends on an unverified execution condition.
- **Low**: the issue is a weak preference or speculative concern. Put it in `declared_only`; do not create a finding.

Use `remove`, `rewrite`, `move`, `replace-with-API-feature`, or `add` only when that action follows from the evidence. Use `flag` when the evidence is insufficient to recommend a change. Do not invent a specific replacement instruction when the target does not establish one.

For every finding, quote the target text, identify its file and location, explain the execution impact, and give the smallest evidence-supported change. For model- or API-specific claims, cite the authoritative source in the explanation. Preserve `Low` and `flag` observations in `declared_only`; they are not confirmed defects.

## Audit receipt

Return a non-empty `audit_header` with the audited scope and this criteria source. State the target model only when the target identifies one; otherwise write `Target model: not specified; model-specific freshness not assessed`. If the criteria file cannot be read, report the audit as unavailable or unreadable rather than returning an empty successful audit.
