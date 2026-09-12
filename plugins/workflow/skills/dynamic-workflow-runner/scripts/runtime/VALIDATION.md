# Verification boundaries

Run `npm test` in this directory to check the current execution contract.
Run the repository checks as well when changing caller routing or shared references.

## Deterministic checks

Tests cover source parsing, input and result schemas, ordered and nested fan-out,
call/deadline/output limits, unawaited work, SDK events, model selection, context
policy, and workspace allocation. Temporary Git repositories check isolation from
dirty parent contents and invalid workspace configuration.

Caller-source tests use mock worker responses to exercise orchestration and result
shapes. They do not establish that real workers read the required references,
produce correct analysis, or respect every tool restriction.

## Live evidence

Small read-only smoke runs have exercised the JavaScript-to-Codex transport.
A PDCA Plan run has exercised intake, evidence and planner workers; its
`UNVERIFIABLE` result is not evidence that Do/Check completed.

A successful source return proves execution completion, not task quality.
Report the actual run and its journal when making a live-execution claim;
test counts and temporary machine-local paths are not permanent guarantees.

## Boundaries requiring separate verification

- Full caller workflows and their independent quality reviews.
- Real writable-worker behavior and external-tool permission enforcement.
- Explicit model/effort availability and quality equivalence on the selected host.
- Approval forwarding and safe live resume, which are not implemented.
- Controlled token comparisons: mocks and unrelated smoke runs are not baselines.

The runtime executes trusted JavaScript. Process separation and Node vm do not
make hostile source safe. Call/deadline limits also do not enforce a token budget.
