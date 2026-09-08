# Common and per-role context policy

## Responsibility and limits

The parent reads the caller SKILL and runtime entry. The trusted source owns role
prompts, reference selection, dependencies and reviews. The host maps the source's
existing exact agent labels to explicit profiles. This leaves Claude-style source
control flow and arbitrary source filenames unchanged. No new source option,
translator, coordinator or role inference is introduced.

This first slice controls unrelated Memory, Apps and plugin context. It preserves
base instructions, applicable project instructions, permissions, hooks and the
existing model policy. It is neither a tool allowlist nor a complete minimal-context
sandbox. Do not use it to bypass mandatory instructions or suppress required tools.

## Request

`context` is optional at the request/backend level, not an `agent()` option.
The common adapter supplies an explicit defaultProfile with Memory off and Apps/plugins
inherited. No per-role assignments are required on that path. Low-level policy callers
without a defaultProfile must assign every dispatched label. There is no implicit
fallback, inferred role classification, or source-controlled policy escalation.
All referenced profile names must exist. A profile explicitly supplies each field:

```json
{
  "context": {
    "profiles": {
      "local-check": {
        "memory": "off",
        "apps": "off",
        "plugins": "off",
        "references": []
      },
      "connected-research": {
        "memory": "off",
        "apps": "inherit",
        "plugins": "inherit",
        "references": []
      }
    },
    "assignments": {
      "Check": "local-check",
      "Research": "connected-research"
    }
  }
}
```

Labels above are examples, not reserved roles. Match the actual source's label
strings, including dynamic labels, case and whitespace. Repeated calls may reuse a
label; every call still starts a fresh SDK thread. Profile identifiers use letters,
digits, underscore, dot and dash with an alphanumeric first character (max 80).

Optional `defaultProfile` names an existing profile and covers dynamically generated
or absent labels without listing them in advance. Explicit assignments take precedence.
The assignments object can be empty only when a valid defaultProfile is supplied.
Its selection is recorded as host-default; exact matches are recorded as exact-label.
This is a host-wide policy choice, not an assertion that all roles have identical needs.

References are `{ "path": "<absolute path>", "sha256": "<64 lowercase hex>" }`.
The parent computes the digest from the actual source-owned reference. Runtime
canonicalizes paths, rejects missing/non-file/oversized references and duplicates,
checks exact digests, and rechecks canonical identity before dispatch. It does not
append file bodies or paths to the role prompt: source retains ownership of what
the worker is instructed to read. A receipt is NOT proof of reading, skill discovery
or worker sandbox access. Filesystem drift after checking remains possible.
References must not contain secrets merely for provenance logging; only paths and
hashes are logged, but their contents remain accessible under the host's policies.

Memory `off` requests both `memories.use_memories=false` and
`memories.generate_memories=false`. Apps `off` requests `features.apps=false`.
Plugins `off` requests `features.plugins=false` and `features.remote_plugin=false`.
`inherit` supplies no override: the effective host state can still be disabled or
unavailable. No setting enables a capability disabled by the host. A fresh SDK
instance for each scoped call prevents concurrent roles from sharing mutable config.
The existing PATH override is preserved. Global config and process environment are
not edited. This module does not set CODEX_HOME or change authentication.

## Receipts and failures

`request.json.backendPolicy.context` records the profile inventory, assignments and
canonical reference hashes after preflight. Each scoped call emits `context.selected`
with label, profile, requested settings, settings hash and reference inventory.
Status is `configured-not-runtime-certified`, never `minimal` or `verified`.
Missing context at the low-level backend records `host-context-unverified`. The common
adapter and CLI supply their documented default instead; see [adapter contract](ADAPTER.md).

Unknown profile fields, malformed inventories and unknown labels without a declared
defaultProfile are configuration errors. Bad references stop preflight before run-directory creation. A changed
reference stops the affected dispatch; existing backend-error/null semantics apply
to dispatch-time I/O failures. Already completed calls are not rolled back. No
automatic retry or policy widening is allowed. All profile references are checked
upfront, even for a conditional branch that might not execute.

## Deferred selection boundary

Do NOT add `skills.config` array replacement as a shortcut. Without a verified merge
of effective host configuration this can drop existing disabled entries. Individual
skill selection, required-skill discovery receipts and complete tool inventory checks
are deferred. `disabledSkills`, `requiredSkills`, arbitrary CLI overrides and catalog
token budgets are not accepted fields. Until that boundary is implemented, a role
needing plugin skills keeps plugins inherited; a source-required tool allowlist
remains unsupported. Do not advertise exact dependency isolation.

The next slice needs a read-only effective-inventory loader, preservation of existing
denials, a role-specific selection plan and validation in the actual worker cwd
(including allocated worktrees). A filesystem reference alone cannot satisfy that
gate. Unsupported CLI versions or inventory formats must fail closed, not infer a
successful selection from a recognized flag.

## Validation / rollout

Deterministic tests cover exact assignments, input snapshots, reference identity,
changed/missing references, concurrent SDK configuration isolation, unchanged prompts
and restrictive permissions, unsupported fields, receipts and no-dispatch failures.
The staged tests do not use model inference.

Before enabling this policy in a caller route, run no-inference prompt diagnostics
against the pinned CLI and inspect retained rules. Then run one approved equivalent
live smoke. Compare first-step input and total input separately, including cached
tokens and outcome. A debug prompt is not the full model request: it may omit Memory,
base instructions and tool definitions. Character reductions are not token savings.
Keep source-required independent reviewers. Neither fresh threads nor maxAgents
implies minimal context or a hard inner-turn token budget.
