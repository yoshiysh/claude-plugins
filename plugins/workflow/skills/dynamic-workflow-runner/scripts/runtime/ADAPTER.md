# Common Workflow adapter

The common host binds the adapter once; callers retain the standard request shape.
No caller-name registry, source filename convention, per-skill patch, prompt classifier,
model translator or additional coordinator is used.

```javascript
import { createWorkflow } from './adapter.mjs';
const Workflow = createWorkflow({
  cwd: workerDirectory,
  runRoot: existingPrivateRunDirectory,
  trustedSource: true,
  modelMap: explicitHostModelMap,
  maxAgents: 2,
  concurrency: 2,
  timeoutMs: 60000
});
const result = await Workflow({ scriptPath, args });
```

The snippet belongs to the common host, not every caller skill. `trustedSource: true`
acknowledges that sources passed to this function have been reviewed and authorized.
Do not expose that bound function as an unrestricted hostile-source execution service.
The existing runtime capability, permission and source validation still applies.

`runRoot` is an existing absolute directory. Each call selects a UUID child; runtime
creates it exclusively and stores its normal request/source/event journal there.
No cleanup, overwrite or retry is added. Host configuration and each request are
snapshotted so concurrent calls and later caller mutations do not share mutable policy.
Each run has its own backend. Results are returned unchanged, without a new envelope.
Limits are per Workflow call, not a global budget across calls. This adapter does not
add native tool registration, global interception, approval forwarding or resume.

The one-shot CLI delegates to `executeWorkflow(request, host)` in this same module.
It accepts an explicit runDir rather than allocating one. Low-level `runtime.mjs`
and `codexBackend` remain available for tests and specialized hosts; they are not the
common policy entry and retain their existing unspecified-context behavior.

## Context ownership

The adapter's default disables personal Memory use/generation, while inheriting Apps
and plugins. It therefore avoids rebuilding an assignment list for every source while
retaining potentially required dependency catalogs. It does not enable host-disabled
features. Task knowledge and references belong in source-owned prompts/args, not implicit
personal Memory. A host intentionally relying on Memory can explicitly select inherit.

The default is a declared `defaultProfile`, not an automatic guess. It handles runtime-
generated and absent labels. Advanced hosts can still supply exact assignments; these
take precedence. Without defaultProfile, an unassigned label remains an error.
An unknown defaultProfile is rejected. Selection origin is recorded as `host-default`
or `exact-label`. Source request keys remain only scriptPath/args; a source cannot add
context, permission or host overrides to that call.

The adapter does not inspect prompt prose to decide which plugins to disable, nor does
it extract paths to synthesize provenance. Reference hashes are optional host checks;
an empty inventory does not certify that the worker read nothing or needs no references.
Whole-plugin suppression remains an explicit host option for known local-only work.
The prior 54% live first-input reduction measured Memory plus Apps/plugins suppression;
it is not a measured result for this dependency-preserving default.

## Verification boundary

Mock SDK tests execute real source control flow through both adapter entry points,
including arbitrary filenames, dynamic/unlabelled roles, input snapshots, preserved
returns, default/explicit settings and rejection of host overrides. No model inference
is required. These tests do not establish every Claude source construct or installed
caller route is supported. Existing caller-side legacy instructions are outside this
patch; hosts must select this common JS entry rather than the old manifest bridge.
