import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./workflow-control.mjs", import.meta.url));
const BRIDGE_SCRIPT = fileURLToPath(new URL("./workflow-bridge.mjs", import.meta.url));
const NODE_RESULT_SCHEMA = fileURLToPath(new URL("../schemas/node-result.schema.json", import.meta.url));
const RUNNER_SKILL_ROOT = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const TRANSLATION_REVIEW_CONTRACT_FILES = [
  "SKILL.md",
  "agents/workflow-contract-verifier.md",
  "references/claude-workflow-compatibility.md",
  "references/portable-contract-extensions.md",
  "references/runtime-contract.md",
  "references/source-translation.md",
  "schemas/task-input-manifest.schema.json",
  "schemas/translation-review-input.schema.json",
  "schemas/translation-review-receipt.schema.json",
  "schemas/translation-review.schema.json",
  "schemas/workflow-manifest.schema.json",
  "scripts/json-schema-subset.mjs",
  "scripts/workflow-control.mjs",
];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

function canonicalSha256(value) {
  return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}

function runnerContract() {
  const files = TRANSLATION_REVIEW_CONTRACT_FILES.map((relativePath) => {
    const path = join(RUNNER_SKILL_ROOT, relativePath);
    return { path, sha256: sha256(path) };
  });
  const document = { skill_root: RUNNER_SKILL_ROOT, files };
  return { ...document, canonical_sha256: canonicalSha256(document) };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function invoke(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  assert.equal(result.status, expectedStatus, result.stderr);
  return JSON.parse(expectedStatus === 0 ? result.stdout : result.stderr);
}

function invokeBridge(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [BRIDGE_SCRIPT, ...args], { encoding: "utf8" });
  assert.equal(result.status, expectedStatus, result.stderr);
  return JSON.parse(expectedStatus === 0 ? result.stdout : result.stderr);
}

function invokeAsync(args) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolveResult({ status, stdout, stderr }));
  });
}

function invokeBridgeAsync(args) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [BRIDGE_SCRIPT, ...args], { encoding: "utf8" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolveResult({ status, stdout, stderr }));
  });
}

test("documents the mode-specific workflow-call init argument", () => {
  const result = invoke([], 1);
  assert.equal(result.code, "invalid_arguments");
  assert.match(result.message, /init .*\[--workflow-call FILE\]/);
  assert.match(result.message, /required for invocation_mode=skill_bridge and forbidden for invocation_mode=direct/);
});

function capabilities(overrides = {}) {
  return {
    schema_version: "dynamic-workflow-capabilities/v1",
    native_collaboration: true,
    spawn: true,
    collect_or_wait: true,
    stable_handle: true,
    message: true,
    resume: true,
    interrupt: true,
    max_parallel: 4,
    observed_at: "2026-08-13T00:00:00Z",
    filesystem_isolation: "attested_not_enforced",
    tool_isolation: "attested_not_enforced",
    external_mutation_enforcement: "attested_not_enforced",
    source_trust: "trusted",
    secret_bearing: false,
    fork_behavior: {
      context_isolation: "attested_not_enforced",
      model_context_inherited: false,
    },
    semantic_capabilities: {},
    permissions: {},
    context_support: {
      fresh: true,
      recent: { supported: true, max_turns: 100 },
      all: true,
    },
    diagnostics: {
      multi_agent_v2: "diagnostic_only",
      collaboration_modes: "diagnostic_only",
    },
    ...overrides,
  };
}

function defaultResultContract() {
  const document = {
    type: "object",
    required: ["summary"],
    properties: { summary: { type: "string", minLength: 1 } },
  };
  return {
    schema_version: "dynamic-workflow-task-result-contract/v1",
    target: { kind: "node_result" },
    schema: { kind: "inline", dialect: "https://json-schema.org/draft/2020-12/schema", document, canonical_sha256: canonicalSha256(document) },
    validation: { at_finish: true, at_final_review: true, on_missing: "workflow_incomplete", on_invalid: "workflow_incomplete" },
  };
}

function jsonArtifactResultContract(artifactPath, document) {
  return {
    schema_version: "dynamic-workflow-task-result-contract/v1",
    target: { kind: "json_artifact", artifact_path: artifactPath },
    schema: { kind: "inline", dialect: "https://json-schema.org/draft/2020-12/schema", document, canonical_sha256: canonicalSha256(document) },
    validation: { at_finish: true, at_final_review: true, on_missing: "workflow_incomplete", on_invalid: "workflow_incomplete" },
  };
}

function agentTask(id, dependsOn = [], overrides = {}) {
  return {
    id,
    kind: "agent",
    depends_on: dependsOn,
    required: true,
    prompt: `Execute ${id} and write the required result envelope.`,
    context_policy: { mode: "fresh" },
    requirements: { semantic_capabilities: [], permissions: [], on_unavailable: "unsupported_runtime" },
    result_contract: defaultResultContract(),
    inputs: [],
    output_path: `results/${id}.json`,
    artifact_paths: [],
    effect: "read_only",
    approval_gate_id: null,
    accepted_outcomes: ["pass"],
    ...overrides,
  };
}

function manifest(source, tasks, overrides = {}) {
  return {
    schema_version: "dynamic-workflow/v1",
    workflow_id: "portable-workflow",
    description: "A filename-independent workflow fixture.",
    translation_mode: "translated",
    compatibility_normalizations: [],
    source: {
      path: source,
      sha256: sha256(source),
      format: "source-text",
    },
    arguments: {},
    limits: {
      max_parallel: 3,
      max_agent_runs: 20,
      max_tasks: 30,
      max_depth: 12,
    },
    required_capabilities: ["native_collaboration", "spawn", "collect_or_wait", "stable_handle"],
    independent_pairs: [],
    tasks,
    ...overrides,
  };
}

test("validates declared compatibility normalizations without permitting silent semantic drift", () => {
  const task = agentTask("inspect");
  const validNormalization = {
    normalization_id: "inspect-null-fallback",
    kind: "agent_diagnostic_fallback_to_workflow_incomplete",
    source_span: { start_line: 12, end_line: 18 },
    affected_task_ids: ["inspect"],
    triggers: ["agent_result_missing_or_null"],
    source_behavior: "The source converts a missing agent result into a diagnostic placeholder.",
    compatibility_terminal: "workflow_incomplete",
    preserved_domain_outcomes: ["cannot-verify"],
    safety_rationale: "A transport failure cannot satisfy the task result contract.",
  };
  const bridgeFixture = (normalization) => {
    const paths = fixture([task]);
    const { callPath } = writeWorkflowCall(paths);
    enableBridge(paths, callPath, undefined, undefined, { compatibility_normalizations: [normalization] });
    return paths;
  };

  const paths = bridgeFixture(validNormalization);
  assert.equal(initialize(paths).status, "workflow_ready");

  const direct = fixture([task], { compatibility_normalizations: [validNormalization] });
  assert.match(initialize(direct, [], 1).message, /allowed only for translated skill_bridge/);

  const unknownTask = bridgeFixture({ ...validNormalization, affected_task_ids: ["missing"] });
  assert.match(initialize(unknownTask, [], 1).message, /unknown affected task/);

  const invertedSpan = bridgeFixture({ ...validNormalization, source_span: { start_line: 18, end_line: 12 } });
  assert.match(initialize(invertedSpan, [], 1).message, /source_span.end_line/);
});

function fixture(tasks, overrides = {}) {
  const sessionRoot = realpathSync(mkdtempSync(join(tmpdir(), "dynamic-workflow-runner-")));
  const root = join(sessionRoot, "caller");
  const bridgeDir = join(sessionRoot, "bridge");
  mkdirSync(root);
  mkdirSync(bridgeDir);
  const source = join(root, "arbitrary source.name");
  writeFileSync(source, "workflow source data\n");
  const manifestPath = join(root, "portable.input.json");
  const capabilitiesPath = join(root, "runtime-capabilities.json");
  const translationReviewPath = join(root, "translation-review.json");
  const translationReviewReceiptPath = join(root, "translation-review-receipt.json");
  const translationReviewPromptPath = join(root, "translation-review-prompt.md");
  const translationReviewInputPath = join(root, "translation-review-input.json");
  const runDir = join(sessionRoot, "run");
  writeJson(manifestPath, manifest(source, tasks, overrides));
  writeJson(capabilitiesPath, capabilities());
  const paths = { sessionRoot, root, bridgeDir, source, manifestPath, capabilitiesPath, translationReviewPath, translationReviewReceiptPath, translationReviewPromptPath, translationReviewInputPath, runDir };
  writeTranslationReview(paths);
  return paths;
}

function writeTranslationReview(paths, overrides = {}) {
  const sourceManifest = JSON.parse(readFileSync(paths.manifestPath, "utf8"));
  const translated = sourceManifest.translation_mode === "translated";
  let workflowCall;
  if ((sourceManifest.invocation_mode ?? "direct") === "skill_bridge") {
    assert.ok(paths.workflowCallPath, "bridge fixture requires workflowCallPath");
    const call = JSON.parse(readFileSync(paths.workflowCallPath, "utf8"));
    workflowCall = {
      receipt: { path: paths.workflowCallPath, sha256: sha256(paths.workflowCallPath) },
      caller_phase_ownership: call.caller_phase_ownership,
      native_workflow_observation: call.native_workflow_observation,
    };
  }
  writeFileSync(paths.translationReviewPromptPath, "Independently verify the source-to-manifest translation.\n");
  const reviewInput = {
    schema_version: "dynamic-workflow-translation-review-input/v1",
    translator_handle: translated ? "agent/translator" : null,
    source: { path: paths.source, sha256: sha256(paths.source) },
    manifest: { path: paths.manifestPath, canonical_sha256: canonicalSha256(sourceManifest) },
    runner_contract: runnerContract(),
  };
  if (workflowCall !== undefined) reviewInput.workflow_call = workflowCall;
  writeJson(paths.translationReviewInputPath, reviewInput);
  const receipt = {
    schema_version: "dynamic-workflow-translation-review-receipt/v1",
    invocation_id: "translation-review-invocation",
    translator_handle: translated ? "agent/translator" : null,
    reviewer_handle: "agent/contract-reviewer",
    context_policy: "fresh",
    parent_context_inherited: false,
    translation_mode: translated ? "translated" : "direct",
    handle_boundary: "attested_not_enforced",
    prompt: { path: paths.translationReviewPromptPath, sha256: sha256(paths.translationReviewPromptPath) },
    input_manifest: { path: paths.translationReviewInputPath, sha256: sha256(paths.translationReviewInputPath) },
    invoked_at: "2026-08-13T00:01:00Z",
  };
  if (workflowCall !== undefined) receipt.workflow_call = workflowCall;
  writeJson(paths.translationReviewReceiptPath, receipt);
  writeJson(paths.translationReviewPath, {
    schema_version: "dynamic-workflow-translation-review/v1",
    source_sha256: sha256(paths.source),
    manifest_sha256: canonicalSha256(sourceManifest),
    invocation_id: "translation-review-invocation",
    translator_handle: translated ? "agent/translator" : null,
    reviewer_handle: "agent/contract-reviewer",
    reviewed_at: "2026-08-13T00:02:00Z",
    verdict: "pass",
    findings: [],
    ...overrides,
  });
}

function mutateTranslationReviewInput(paths, mutate) {
  const reviewInput = JSON.parse(readFileSync(paths.translationReviewInputPath, "utf8"));
  mutate(reviewInput);
  writeJson(paths.translationReviewInputPath, reviewInput);
  const receipt = JSON.parse(readFileSync(paths.translationReviewReceiptPath, "utf8"));
  receipt.input_manifest.sha256 = sha256(paths.translationReviewInputPath);
  writeJson(paths.translationReviewReceiptPath, receipt);
}

function initialize(paths, extra = [], expectedStatus = 0) {
  const manifestValue = JSON.parse(readFileSync(paths.manifestPath, "utf8"));
  const workflowCallArgs = (manifestValue.invocation_mode ?? "direct") === "skill_bridge"
    ? ["--workflow-call", paths.workflowCallPath]
    : [];
  return invoke([
    "init",
    "--manifest",
    paths.manifestPath,
    "--capabilities",
    paths.capabilitiesPath,
    "--translation-review",
    paths.translationReviewPath,
    "--translation-review-receipt",
    paths.translationReviewReceiptPath,
    ...workflowCallArgs,
    "--run-dir",
    paths.runDir,
    ...extra,
  ], expectedStatus);
}

function prepareAndBind(paths, taskId, invocationId, handle) {
  invoke(["prepare", "--run-dir", paths.runDir, "--task", taskId, "--invocation", invocationId]);
  invoke(["bind", "--run-dir", paths.runDir, "--task", taskId, "--invocation", invocationId, "--agent", handle]);
}

function writeResult(paths, taskId, invocationId, outcome = "pass") {
  const path = join(paths.runDir, "results", `${taskId}.json`);
  const frozenManifest = JSON.parse(readFileSync(join(paths.runDir, "workflow.manifest.json"), "utf8"));
  const state = JSON.parse(readFileSync(join(paths.runDir, "workflow-state.json"), "utf8"));
  const task = frozenManifest.tasks.find((candidate) => candidate.id === taskId);
  const record = state.tasks[taskId];
  const taskInput = JSON.parse(readFileSync(join(paths.runDir, record.input_manifest_path), "utf8"));
  const artifacts = task.artifact_paths.map((artifactPath) => {
    const absolutePath = join(paths.runDir, artifactPath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    if (artifactPath.endsWith("action-package.json")) {
      writeJson(absolutePath, {
        schema_version: "dynamic-workflow-action-package/v1",
        package_id: "package-publish-local-output",
        source_task_id: taskId,
        action_id: "publish-local-output",
        action: "publish",
        targets: ["local-output"],
        scope: ["prepared-artifact-only"],
        parameters: {},
        preconditions: ["workflow package reviewed"],
        expected_effects: ["publish local-output"],
        read_back: {
          method: "read target",
          success_criteria: "target matches the approved package",
        },
        idempotency: {
          key: "publish-local-output",
          behavior: "verify_before_retry",
        },
        executor_capabilities: ["external.publish"],
        lineage: {
          source_sha256: frozenManifest.source.sha256,
          manifest_sha256: state.manifest_sha256,
          capability_snapshot_sha256: taskInput.capability_snapshot.sha256,
          task_input_manifest_sha256: record.input_manifest_sha256,
          result_contract_sha256: canonicalSha256(task.result_contract),
        },
        external_effects_performed: false,
      });
    } else {
      writeFileSync(absolutePath, `${taskId} artifact\n`);
    }
    return { path: artifactPath, sha256: sha256(absolutePath) };
  });
  writeJson(path, {
    schema_version: "dynamic-workflow-node-result/v1",
    task_id: taskId,
    invocation_id: invocationId,
    outcome,
    summary: `${taskId} finished`,
    artifacts,
    evidence: ["fixture"],
    errors: [],
  });
  return path;
}

function finish(paths, taskId, invocationId, outcome = "pass") {
  const resultPath = writeResult(paths, taskId, invocationId, outcome);
  return invoke([
    "finish",
    "--run-dir",
    paths.runDir,
    "--task",
    taskId,
    "--invocation",
    invocationId,
    "--result",
    resultPath,
  ]);
}

function finishJsonArtifact(paths, taskId, invocationId, artifactPath, value) {
  const absoluteArtifactPath = join(paths.runDir, artifactPath);
  mkdirSync(dirname(absoluteArtifactPath), { recursive: true });
  writeJson(absoluteArtifactPath, value);
  const resultPath = join(paths.runDir, "results", `${taskId}.json`);
  writeJson(resultPath, {
    schema_version: "dynamic-workflow-node-result/v1",
    task_id: taskId,
    invocation_id: invocationId,
    outcome: "pass",
    summary: `${taskId} finished`,
    artifacts: [{ path: artifactPath, sha256: sha256(absoluteArtifactPath) }],
    evidence: ["fixture"],
    errors: [],
  });
  return invoke(["finish", "--run-dir", paths.runDir, "--task", taskId, "--invocation", invocationId, "--result", resultPath]);
}

function projectionWorkflowTasks() {
  const claimsDocument = {
    type: "object",
    additionalProperties: false,
    required: ["claims"],
    properties: {
      claims: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["id", "text", "verify_method"],
          properties: {
            id: { type: "string" },
            text: { type: "string" },
            verify_method: { type: "string" },
            secret_context: { type: "string" },
          },
        },
      },
    },
  };
  const verdictDocument = {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "evidence_file"],
    properties: {
      verdict: { enum: ["verified", "cannot-verify"] },
      evidence_file: { type: "string", minLength: 1 },
    },
  };
  const producer = agentTask("select", [], {
    result_contract: jsonArtifactResultContract("artifacts/claims.json", claimsDocument),
    artifact_paths: ["artifacts/claims.json"],
    effect: "workspace_write",
  });
  const verifier = agentTask("verify", ["select"], {
    inputs: [{
      kind: "artifact_projection",
      task_id: "select",
      path: "artifacts/claims.json",
      pointer: "/claims/0",
      alias: "claim",
      fields: { id: "/id", text: "/text", verify_method: "/verify_method" },
    }],
    capability_requests: [{
      request_id: "claim-public-web-read",
      when: { input_alias: "claim", pointer: "/verify_method", predicate: "equals", expected: "web-search" },
      semantic_capabilities: ["public_web_read"],
      permissions: ["public_web_read"],
      on_unavailable: {
        action: "dispatch_with_assessment",
        result_guard: { artifact_path: "artifacts/verdict.json", pointer: "/verdict", predicate: "equals", expected: "cannot-verify" },
      },
    }],
    result_contract: jsonArtifactResultContract("artifacts/verdict.json", verdictDocument),
    artifact_paths: ["evidence/claim-0.md", "artifacts/verdict.json"],
    effect: "workspace_write",
  });
  return { producer, verifier };
}

function writeProjectionVerifierResult(paths, verdict) {
  const evidenceRelative = "evidence/claim-0.md";
  const verdictRelative = "artifacts/verdict.json";
  const evidenceAbsolute = join(paths.runDir, evidenceRelative);
  mkdirSync(dirname(evidenceAbsolute), { recursive: true });
  writeFileSync(evidenceAbsolute, "bounded evidence\n");
  writeJson(join(paths.runDir, verdictRelative), { verdict, evidence_file: evidenceAbsolute });
  const resultPath = join(paths.runDir, "results", "verify.json");
  writeJson(resultPath, {
    schema_version: "dynamic-workflow-node-result/v1",
    task_id: "verify",
    invocation_id: "invocation-verify",
    outcome: "pass",
    summary: "verification finished",
    artifacts: [
      { path: evidenceRelative, sha256: sha256(evidenceAbsolute) },
      { path: verdictRelative, sha256: sha256(join(paths.runDir, verdictRelative)) },
    ],
    evidence: [evidenceAbsolute],
    errors: [],
  });
  return { resultPath, evidenceAbsolute };
}

function writeWorkflowCall(paths, overrides = {}) {
  const skillMd = join(paths.root, "SKILL.md");
  if (!existsSync(skillMd)) writeFileSync(skillMd, "---\nname: bridge-fixture\n---\n");
  const value = overrides.arguments?.value ?? { topic: "portable execution" };
  const call = {
    schema_version: "dynamic-workflow-call/v1",
    call_id: "bridge-call",
    invoking_skill: {
      root: paths.root,
      skill_md: { path: skillMd, sha256: sha256(skillMd) },
    },
    native_workflow_observation: {
      attempted: false,
      available: false,
      observed_at: "2026-08-13T00:00:00Z",
      evidence: ["No native Workflow tool is present in the callable tool inventory."],
    },
    workflow: {
      declared_script_path: "[SKILL_DIR]/arbitrary source.name",
      resolved_source: { path: paths.source, sha256: sha256(paths.source) },
    },
    arguments: { value, canonical_sha256: canonicalSha256(value) },
    caller_phase_ownership: {
      owner: "caller_skill",
      pre_workflow: ["prepare caller inputs"],
      post_workflow: ["consume typed workflow return"],
      human_gates: ["caller publication approval"],
    },
    ...overrides,
  };
  const callPath = join(paths.bridgeDir, "workflow-call.json");
  writeJson(callPath, call);
  paths.workflowCallPath = callPath;
  return { call, callPath };
}

function enableBridge(paths, callPath, expression = { kind: "task_result", task_id: "inspect", pointer: "/summary" }, schemaDocument = { type: "string", minLength: 1 }, manifestOverrides = {}) {
  paths.workflowCallPath = callPath;
  const sourceManifest = JSON.parse(readFileSync(paths.manifestPath, "utf8"));
  sourceManifest.invocation_mode = "skill_bridge";
  sourceManifest.arguments = JSON.parse(readFileSync(callPath, "utf8")).arguments.value;
  sourceManifest.return_binding = {
    schema_version: "dynamic-workflow-return-binding/v1",
    workflow_call_sha256: sha256(callPath),
    expression,
    schema: {
      kind: "inline",
      dialect: "https://json-schema.org/draft/2020-12/schema",
      document: schemaDocument,
      canonical_sha256: canonicalSha256(schemaDocument),
    },
    limits: { max_depth: 8, max_nodes: 64 },
  };
  Object.assign(sourceManifest, manifestOverrides);
  writeJson(paths.manifestPath, sourceManifest);
  writeTranslationReview(paths);
}

function finalizeSingleTaskRun(paths, verdict = "pass") {
  initialize(paths);
  prepareAndBind(paths, "inspect", "invocation-inspect", "agent/inspect");
  finish(paths, "inspect", "invocation-inspect");
  const prompt = join(paths.runDir, "review", "prompt.md");
  mkdirSync(dirname(prompt), { recursive: true });
  writeFileSync(prompt, "Review the bridge fixture.\n");
  const preparation = invoke(["review-prepare", "--run-dir", paths.runDir, "--invocation", "invocation-final", "--prompt", prompt]);
  invoke(["review-bind", "--run-dir", paths.runDir, "--invocation", "invocation-final", "--agent", "agent/final-review"]);
  const state = JSON.parse(readFileSync(join(paths.runDir, "workflow-state.json"), "utf8"));
  const review = join(paths.runDir, "staging", "bridge-final-review.json");
  writeJson(review, {
    schema_version: "dynamic-workflow-run-review/v1",
    workflow_id: state.workflow_id,
    run_id: state.run_id,
    manifest_sha256: state.manifest_sha256,
    state_snapshot_sha256: preparation.state_snapshot_sha256,
    invocation_id: "invocation-final",
    reviewer_handle: "agent/final-review",
    prompt_sha256: preparation.prompt_sha256,
    input_manifest_sha256: preparation.input_manifest_sha256,
    verdict,
    summary: "Bridge fixture review completed.",
    findings: [],
  });
  invoke(["finalize", "--run-dir", paths.runDir, "--review", review]);
}

test("runs an arbitrary-named source through prepare, bind, finish, gate, and final review", () => {
  const tasks = [
    agentTask("analyze"),
    agentTask("action-package", ["analyze"], {
      effect: "workspace_write",
      artifact_paths: ["artifacts/action-package.json"],
    }),
    {
      id: "publish-gate",
      kind: "human_gate",
      depends_on: ["action-package"],
      required: true,
      action: "publish",
      targets: ["local-output"],
      scope: ["prepared-artifact-only"],
      action_package: { task_id: "action-package", path: "artifacts/action-package.json" },
    },
  ];
  const paths = fixture(tasks);
  assert.equal(initialize(paths).status, "workflow_ready");
  assert.deepEqual(invoke(["ready", "--run-dir", paths.runDir]).ready.map((task) => task.id), ["analyze"]);
  prepareAndBind(paths, "analyze", "invocation-analyze", "agent/analyze");
  assert.equal(finish(paths, "analyze", "invocation-analyze").status, "completed");
  prepareAndBind(paths, "action-package", "invocation-action-package", "agent/action-package");
  assert.equal(finish(paths, "action-package", "invocation-action-package").status, "completed");
  assert.equal(invoke(["status", "--run-dir", paths.runDir]).status, "workflow_waiting_for_gate");
  invoke(["approve", "--run-dir", paths.runDir, "--task", "publish-gate", "--decision", "approve", "--actor", "user"]);
  const executionVerification = invoke(["verify", "--run-dir", paths.runDir]);
  assert.equal(executionVerification.valid, true);
  assert.equal(executionVerification.structurally_complete, true);
  const reviewPrompt = join(paths.runDir, "review", "prompt.md");
  mkdirSync(dirname(reviewPrompt), { recursive: true });
  writeFileSync(reviewPrompt, "Independently verify the frozen workflow run.\n");
  const reviewPreparation = invoke(["review-prepare", "--run-dir", paths.runDir, "--invocation", "invocation-final-review", "--prompt", reviewPrompt]);
  writeJson(paths.capabilitiesPath, capabilities({ observed_at: "2026-08-13T03:00:00Z" }));
  assert.equal(initialize(paths, [], 1).code, "resume_not_allowed");
  const reviewInputs = JSON.parse(readFileSync(join(paths.runDir, reviewPreparation.input_manifest_path), "utf8"));
  assert.deepEqual(reviewInputs.results.map((result) => result.task_id), ["analyze", "action-package"]);
  assert.equal(reviewInputs.results.every((result) => result.result_contract_receipt.target_sha256.length === 64), true);
  assert.deepEqual(reviewInputs.gates.map((gate) => gate.task_id), ["publish-gate"]);
  assert.equal(reviewInputs.gates[0].external_authorization, false);
  assert.equal(reviewInputs.gates[0].requires_reapproval, true);
  assert.equal(reviewInputs.translation_review_receipt.path, "translation-review-receipt.json");
  invoke(["review-bind", "--run-dir", paths.runDir, "--invocation", "invocation-final-review", "--agent", "agent/final-reviewer"]);
  const verification = invoke(["verify", "--run-dir", paths.runDir]);
  assert.equal(verification.status, "workflow_reviewing");
  const state = JSON.parse(readFileSync(join(paths.runDir, "workflow-state.json"), "utf8"));
  const reviewPath = join(paths.runDir, "staging", "final-review.json");
  writeJson(reviewPath, {
    schema_version: "dynamic-workflow-run-review/v1",
    workflow_id: state.workflow_id,
    run_id: state.run_id,
    manifest_sha256: state.manifest_sha256,
    state_snapshot_sha256: reviewPreparation.state_snapshot_sha256,
    invocation_id: "invocation-final-review",
    reviewer_handle: "agent/final-reviewer",
    prompt_sha256: reviewPreparation.prompt_sha256,
    input_manifest_sha256: reviewPreparation.input_manifest_sha256,
    verdict: "pass",
    summary: "All required tasks and gates are closed.",
    findings: [],
  });
  assert.equal(invoke(["finalize", "--run-dir", paths.runDir, "--review", reviewPath]).status, "workflow_complete");
  assert.equal(invoke(["status", "--run-dir", paths.runDir]).status, "workflow_complete");
  const reviewInputPath = join(paths.runDir, reviewPreparation.input_manifest_path);
  const frozenReviewInput = readFileSync(reviewInputPath, "utf8");
  writeFileSync(reviewInputPath, "{}\n");
  assert.equal(invoke(["verify", "--run-dir", paths.runDir], 1).code, "review_crosswire");
  writeFileSync(reviewInputPath, frozenReviewInput);
  writeFileSync(reviewPrompt, "A substituted review prompt.\n");
  assert.equal(invoke(["verify", "--run-dir", paths.runDir], 1).code, "review_crosswire");
  writeFileSync(join(paths.runDir, "final-review.json"), "{}\n");
  assert.equal(invoke(["status", "--run-dir", paths.runDir], 1).code, "review_crosswire");
  writeFileSync(reviewPrompt, "Independently verify the frozen workflow run.\n");
  writeFileSync(join(paths.runDir, "final-review.json"), readFileSync(reviewPath));
  assert.equal(invoke(["verify", "--run-dir", paths.runDir]).valid, true);
  const handoff = invoke(["handoff-prepare", "--run-dir", paths.runDir, "--gate", "publish-gate"]);
  assert.equal(handoff.execution_status, "not_authorized");
  assert.equal(handoff.idempotent, false);
  const handoffValue = JSON.parse(readFileSync(join(paths.runDir, handoff.path), "utf8"));
  assert.deepEqual(handoffValue.requested_action_ids, ["publish-local-output"]);
  assert.deepEqual(handoffValue.executor_capabilities, ["external.publish"]);
  assert.deepEqual(handoffValue.targets, ["local-output"]);
  assert.deepEqual(handoffValue.scopes, ["prepared-artifact-only"]);
  assert.equal(handoffValue.workflow_gate.grants_external_authority, false);
  assert.equal(handoffValue.approval_contract.reuse_workflow_gate, false);
  assert.equal(invoke(["handoff-verify", "--run-dir", paths.runDir, "--gate", "publish-gate"]).valid, true);
  assert.equal(invoke(["handoff-prepare", "--run-dir", paths.runDir, "--gate", "publish-gate"]).idempotent, true);
  assert.equal(initialize(paths, [], 1).code, "resume_not_allowed");
  assert.equal(invoke(["verify", "--run-dir", paths.runDir]).valid, true);
});

test("does not execute a JavaScript-looking source during initialization", () => {
  const paths = fixture([agentTask("inspect")]);
  const marker = join(paths.root, "must-not-exist");
  writeFileSync(paths.source, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')\n`);
  writeJson(paths.manifestPath, manifest(paths.source, [agentTask("inspect")]));
  writeTranslationReview(paths);
  initialize(paths);
  assert.equal(spawnSync("test", ["-e", marker]).status, 1);
});

test("fails closed when a required runtime capability is absent", () => {
  const paths = fixture([agentTask("inspect")]);
  writeJson(paths.capabilitiesPath, capabilities({ spawn: false }));
  const error = invoke([
    "init",
    "--manifest",
    paths.manifestPath,
    "--capabilities",
    paths.capabilitiesPath,
    "--translation-review",
    paths.translationReviewPath,
    "--run-dir",
    paths.runDir,
  ], 1);
  assert.equal(error.code, "unsupported_runtime");
});

test("rejects path traversal and filesystem-equivalent output collisions", () => {
  const traversal = fixture([agentTask("escape", [], { output_path: "../escape.json" })]);
  assert.equal(invoke(["init", "--manifest", traversal.manifestPath, "--capabilities", traversal.capabilitiesPath, "--run-dir", traversal.runDir], 1).code, "unsafe_path");
  const collision = fixture([
    agentTask("left", [], { output_path: "results/SAME.json" }),
    agentTask("right", [], { output_path: "results/same.json" }),
  ]);
  assert.equal(invoke(["init", "--manifest", collision.manifestPath, "--capabilities", collision.capabilitiesPath, "--run-dir", collision.runDir], 1).code, "unsafe_path");
  const unicodeCollision = fixture([
    agentTask("composed", [], { output_path: "results/\u00e9.json" }),
    agentTask("decomposed", [], { output_path: "results/e\u0301.json" }),
  ]);
  assert.equal(invoke(["init", "--manifest", unicodeCollision.manifestPath, "--capabilities", unicodeCollision.capabilitiesPath, "--run-dir", unicodeCollision.runDir], 1).code, "unsafe_path");
});

test("rejects agent prompts that bypass controller-owned frozen inputs", () => {
  const tokenReference = fixture([agentTask("inspect", [], { prompt: "Read [SKILL_DIR]/agents/inspect.md." })]);
  assert.equal(initialize(tokenReference, [], 1).code, "unsafe_prompt_input");

  const liveFileReference = fixture([agentTask("inspect")]);
  const liveFile = join(liveFileReference.root, "agents", "inspect.md");
  mkdirSync(dirname(liveFile), { recursive: true });
  writeFileSync(liveFile, "live instructions\n");
  const liveFileManifest = JSON.parse(readFileSync(liveFileReference.manifestPath, "utf8"));
  liveFileManifest.tasks[0].inputs = [{ kind: "file", path: liveFile, sha256: sha256(liveFile) }];
  liveFileManifest.tasks[0].prompt = `Read ${liveFile}.`;
  writeJson(liveFileReference.manifestPath, liveFileManifest);
  writeTranslationReview(liveFileReference);
  assert.equal(initialize(liveFileReference, [], 1).code, "unsafe_prompt_input");

  const sourceReference = fixture([agentTask("inspect")]);
  const sourceManifest = JSON.parse(readFileSync(sourceReference.manifestPath, "utf8"));
  sourceManifest.tasks[0].prompt = `Read ${sourceReference.source}.`;
  writeJson(sourceReference.manifestPath, sourceManifest);
  writeTranslationReview(sourceReference);
  assert.equal(initialize(sourceReference, [], 1).code, "unsafe_prompt_input");

  const treeReference = fixture([agentTask("inspect")]);
  const { callPath } = writeWorkflowCall(treeReference);
  const treeManifest = JSON.parse(readFileSync(treeReference.manifestPath, "utf8"));
  treeManifest.tasks[0].prompt = `Inspect ${treeReference.root}/agents.`;
  writeJson(treeReference.manifestPath, treeManifest);
  enableBridge(treeReference, callPath);
  assert.equal(initialize(treeReference, [], 1).code, "unsafe_prompt_input");
});

test("rejects external writes because v1 only emits a verified handoff", () => {
  const paths = fixture([agentTask("publish", [], { effect: "external_write", approval_gate_id: null })]);
  const error = invoke(["init", "--manifest", paths.manifestPath, "--capabilities", paths.capabilitiesPath, "--run-dir", paths.runDir], 1);
  assert.equal(error.code, "invalid_schema");
});

test("prepares a handoff only after final review and rejects self-consistent authority cross-wires", () => {
  const tasks = [
    agentTask("package", [], { artifact_paths: ["artifacts/action-package.json"], effect: "workspace_write" }),
    {
      id: "publish-gate",
      kind: "human_gate",
      depends_on: ["package"],
      required: true,
      action: "publish",
      targets: ["local-output"],
      scope: ["prepared-artifact-only"],
      action_package: { task_id: "package", path: "artifacts/action-package.json" },
    },
  ];
  const paths = fixture(tasks);
  const { callPath } = writeWorkflowCall(paths);
  enableBridge(paths, callPath, { kind: "literal", value: "ready" }, { const: "ready" });
  initialize(paths);
  prepareAndBind(paths, "package", "invocation-package", "agent/package");
  finish(paths, "package", "invocation-package");
  invoke(["approve", "--run-dir", paths.runDir, "--task", "publish-gate", "--decision", "approve", "--actor", "user"]);
  assert.equal(invoke(["handoff-prepare", "--run-dir", paths.runDir, "--gate", "publish-gate"], 1).code, "handoff_not_ready");

  const promptPath = join(paths.runDir, "review", "prompt.md");
  mkdirSync(dirname(promptPath), { recursive: true });
  writeFileSync(promptPath, "Review the run.\n");
  const preparation = invoke(["review-prepare", "--run-dir", paths.runDir, "--invocation", "invocation-final", "--prompt", promptPath]);
  invoke(["review-bind", "--run-dir", paths.runDir, "--invocation", "invocation-final", "--agent", "agent/final"]);
  const state = JSON.parse(readFileSync(join(paths.runDir, "workflow-state.json"), "utf8"));
  const reviewPath = join(paths.runDir, "staging", "final.json");
  writeJson(reviewPath, {
    schema_version: "dynamic-workflow-run-review/v1",
    workflow_id: state.workflow_id,
    run_id: state.run_id,
    manifest_sha256: state.manifest_sha256,
    state_snapshot_sha256: preparation.state_snapshot_sha256,
    invocation_id: "invocation-final",
    reviewer_handle: "agent/final",
    prompt_sha256: preparation.prompt_sha256,
    input_manifest_sha256: preparation.input_manifest_sha256,
    verdict: "pass",
    summary: "The run is complete.",
    findings: [],
  });
  invoke(["finalize", "--run-dir", paths.runDir, "--review", reviewPath]);
  const returnPath = join(paths.runDir, "workflow-return.json");
  assert.equal(invokeBridge(["materialize", "--call", callPath, "--run-dir", paths.runDir, "--output", returnPath], 1).code, "handoff_missing");
  assert.equal(existsSync(returnPath), false);
  const statePath = join(paths.runDir, "workflow-state.json");
  const canonicalReviewPath = join(paths.runDir, "final-review.json");
  const recordedReview = readFileSync(canonicalReviewPath, "utf8");
  const recordedState = readFileSync(statePath, "utf8");
  const crossWiredReview = JSON.parse(recordedReview);
  crossWiredReview.reviewer_handle = "agent/substituted-reviewer";
  writeJson(canonicalReviewPath, crossWiredReview);
  const crossWiredState = JSON.parse(recordedState);
  crossWiredState.final_review.reviewer_handle = "agent/substituted-reviewer";
  crossWiredState.final_review.sha256 = sha256(canonicalReviewPath);
  crossWiredState.events.find((event) => event.type === "final_review_recorded").details.review_sha256 = crossWiredState.final_review.sha256;
  writeJson(statePath, crossWiredState);
  assert.equal(invoke(["handoff-prepare", "--run-dir", paths.runDir, "--gate", "publish-gate"], 1).code, "state_drift");
  writeFileSync(canonicalReviewPath, recordedReview);
  writeFileSync(statePath, recordedState);
  const prepared = invoke(["handoff-prepare", "--run-dir", paths.runDir, "--gate", "publish-gate"]);
  const handoffPath = join(paths.runDir, prepared.path);
  const recordedHandoff = readFileSync(handoffPath, "utf8");
  const stateWithHandoff = readFileSync(statePath, "utf8");
  const targetCrossWire = JSON.parse(recordedHandoff);
  targetCrossWire.targets = ["different-target"];
  writeJson(handoffPath, targetCrossWire);
  const targetCrossWireState = JSON.parse(stateWithHandoff);
  targetCrossWireState.action_handoffs[0].sha256 = sha256(handoffPath);
  targetCrossWireState.events.find((event) => event.type === "action_handoff_prepared").details.handoff_sha256 = targetCrossWireState.action_handoffs[0].sha256;
  writeJson(statePath, targetCrossWireState);
  assert.equal(invoke(["handoff-verify", "--run-dir", paths.runDir, "--gate", "publish-gate"], 1).code, "handoff_crosswire");
  writeFileSync(handoffPath, recordedHandoff);
  writeFileSync(statePath, stateWithHandoff);
  const handoff = JSON.parse(recordedHandoff);
  handoff.execution_status = "authorized";
  writeJson(handoffPath, handoff);
  const tamperedState = JSON.parse(readFileSync(statePath, "utf8"));
  const receipt = tamperedState.action_handoffs.find((candidate) => candidate.gate_id === "publish-gate");
  receipt.sha256 = sha256(handoffPath);
  const event = tamperedState.events.find((candidate) => candidate.type === "action_handoff_prepared" && candidate.task_id === "publish-gate");
  event.details.handoff_sha256 = receipt.sha256;
  writeJson(statePath, tamperedState);
  assert.equal(invoke(["handoff-verify", "--run-dir", paths.runDir, "--gate", "publish-gate"], 1).code, "handoff_authority_violation");
  writeFileSync(handoffPath, recordedHandoff);
  const orphanedHandoffState = JSON.parse(stateWithHandoff);
  orphanedHandoffState.action_handoffs = [];
  orphanedHandoffState.events = orphanedHandoffState.events.filter((candidate) => candidate.type !== "action_handoff_prepared");
  orphanedHandoffState.events.forEach((candidate, index) => { candidate.sequence = index + 1; });
  writeJson(statePath, orphanedHandoffState);
  assert.equal(invoke(["status", "--run-dir", paths.runDir], 1).code, "state_drift");
});

test("skips a bounded branch when its source outcome does not match", () => {
  const tasks = [
    agentTask("review", [], { accepted_outcomes: ["pass", "revise"] }),
    agentTask("repair", ["review"], { required: false, when: { task_id: "review", outcomes: ["revise"] } }),
  ];
  const paths = fixture(tasks);
  initialize(paths);
  prepareAndBind(paths, "review", "invocation-review", "agent/review");
  finish(paths, "review", "invocation-review", "pass");
  const status = invoke(["status", "--run-dir", paths.runDir]);
  assert.equal(status.status, "workflow_execution_complete");
  assert.equal(status.counts.skipped, 1);
});

test("expands bounded artifact slots and preserves skipped optional fan-in markers", () => {
  const artifactPath = "artifacts/plan.json";
  const planSchema = {
    type: "object",
    additionalProperties: false,
    required: ["items", "continue"],
    properties: {
      items: { type: "array", maxItems: 2, items: { type: "string" } },
      continue: { type: "boolean" },
    },
  };
  const producer = agentTask("plan", [], {
    artifact_paths: [artifactPath],
    effect: "workspace_write",
    result_contract: jsonArtifactResultContract(artifactPath, planSchema),
  });
  const slot = (id, index) => agentTask(id, ["plan"], {
    inputs: [{ kind: "artifact", task_id: "plan", path: artifactPath }],
    when: { task_id: "plan", artifact_path: artifactPath, pointer: `/items/${index}`, predicate: "exists" },
  });
  const aggregate = agentTask("aggregate", ["slot-0", "slot-1"], {
    inputs: [
      { kind: "optional_task_result", task_id: "slot-0" },
      { kind: "optional_task_result", task_id: "slot-1" },
    ],
  });
  const paths = fixture([producer, slot("slot-0", 0), slot("slot-1", 1), aggregate]);
  initialize(paths);
  prepareAndBind(paths, "plan", "invocation-plan", "agent/plan");
  finishJsonArtifact(paths, "plan", "invocation-plan", artifactPath, { items: ["one"], continue: true });
  assert.deepEqual(invoke(["ready", "--run-dir", paths.runDir]).ready.map((task) => task.id), ["slot-0"]);
  assert.equal(invoke(["status", "--run-dir", paths.runDir]).counts.skipped, 1);
  prepareAndBind(paths, "slot-0", "invocation-slot-0", "agent/slot-0");
  finish(paths, "slot-0", "invocation-slot-0");
  const prepared = invoke(["prepare", "--run-dir", paths.runDir, "--task", "aggregate", "--invocation", "invocation-aggregate"]);
  const inputs = JSON.parse(readFileSync(join(paths.runDir, prepared.input_manifest_path), "utf8")).inputs;
  assert.equal(inputs[0].status, "available");
  assert.match(inputs[0].sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(inputs[1], { kind: "optional_task_result", task_id: "slot-1", status: "skipped", path: null, sha256: null });

  writeJson(join(paths.runDir, artifactPath), { items: ["one", "two"], continue: true });
  assert.equal(invoke(["status", "--run-dir", paths.runDir], 1).code, "artifact_drift");
});

test("rejects unsafe artifact conditions before execution", () => {
  const artifactPath = "artifacts/plan.json";
  const producer = agentTask("plan", [], {
    artifact_paths: [artifactPath],
    effect: "workspace_write",
    result_contract: jsonArtifactResultContract(artifactPath, { type: "object" }),
  });
  const missingTypedInput = fixture([
    producer,
    agentTask("slot", ["plan"], { when: { task_id: "plan", artifact_path: artifactPath, pointer: "/items/0", predicate: "exists" } }),
  ]);
  assert.equal(invoke(["init", "--manifest", missingTypedInput.manifestPath, "--capabilities", missingTypedInput.capabilitiesPath, "--run-dir", missingTypedInput.runDir], 1).code, "invalid_graph");

  const objectEquality = fixture([
    producer,
    agentTask("slot", ["plan"], {
      inputs: [{ kind: "artifact", task_id: "plan", path: artifactPath }],
      when: { task_id: "plan", artifact_path: artifactPath, pointer: "/items", predicate: "equals", expected: [] },
    }),
  ]);
  assert.equal(invoke(["init", "--manifest", objectEquality.manifestPath, "--capabilities", objectEquality.capabilitiesPath, "--run-dir", objectEquality.runDir], 1).code, "invalid_schema");

  const conditionalSlot = agentTask("slot", ["plan"], {
    inputs: [{ kind: "artifact", task_id: "plan", path: artifactPath }],
    when: { task_id: "plan", artifact_path: artifactPath, pointer: "/items/0", predicate: "exists" },
  });
  const nonOptionalFanIn = fixture([
    producer,
    conditionalSlot,
    agentTask("aggregate", ["slot"], { inputs: [{ kind: "task_result", task_id: "slot" }] }),
  ]);
  assert.equal(invoke(["init", "--manifest", nonOptionalFanIn.manifestPath, "--capabilities", nonOptionalFanIn.capabilitiesPath, "--run-dir", nonOptionalFanIn.runDir], 1).code, "invalid_graph");
});

test("records revise separately and requires an explicit bounded handler", () => {
  const noHandler = fixture([agentTask("review", [], { accepted_outcomes: ["pass", "revise"] })]);
  assert.equal(invoke(["init", "--manifest", noHandler.manifestPath, "--capabilities", noHandler.capabilitiesPath, "--run-dir", noHandler.runDir], 1).code, "invalid_graph");
  const tasks = [
    agentTask("review", [], { accepted_outcomes: ["pass", "revise"] }),
    agentTask("repair", ["review"], { when: { task_id: "review", outcomes: ["revise"] } }),
  ];
  const paths = fixture(tasks);
  initialize(paths);
  prepareAndBind(paths, "review", "invocation-review", "agent/review");
  assert.equal(finish(paths, "review", "invocation-review", "revise").status, "resolved");
  assert.deepEqual(invoke(["ready", "--run-dir", paths.runDir]).ready.map((task) => task.id), ["repair"]);
});

test("makes duplicate finish idempotent and rejects a divergent replacement", () => {
  const paths = fixture([agentTask("inspect")]);
  initialize(paths);
  prepareAndBind(paths, "inspect", "invocation-inspect", "agent/inspect");
  assert.equal(finish(paths, "inspect", "invocation-inspect").idempotent, false);
  const resultPath = join(paths.runDir, "results", "inspect.json");
  assert.equal(invoke(["finish", "--run-dir", paths.runDir, "--task", "inspect", "--invocation", "invocation-inspect", "--result", resultPath]).idempotent, true);
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  result.summary = "changed after completion";
  writeJson(resultPath, result);
  const error = invoke(["finish", "--run-dir", paths.runDir, "--task", "inspect", "--invocation", "invocation-inspect", "--result", resultPath], 1);
  assert.equal(error.code, "result_conflict");
});

test("requires exact declared artifact spelling while retaining collision-safe keys", () => {
  const task = agentTask("package", [], {
    artifact_paths: ["artifacts/Pkg.json"],
    effect: "workspace_write",
  });
  const paths = fixture([task]);
  initialize(paths);
  prepareAndBind(paths, "package", "invocation-package", "agent/package");
  const resultPath = writeResult(paths, "package", "invocation-package");
  const exactArtifact = join(paths.runDir, "artifacts/Pkg.json");
  const caseVariant = join(paths.runDir, "artifacts/pkg.json");
  writeFileSync(caseVariant, readFileSync(exactArtifact));
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  result.artifacts[0] = { path: "artifacts/pkg.json", sha256: sha256(caseVariant) };
  writeJson(resultPath, result);
  assert.equal(invoke([
    "finish", "--run-dir", paths.runDir, "--task", "package",
    "--invocation", "invocation-package", "--result", resultPath,
  ], 1).code, "result_crosswire");
});

test("detects source drift before creating a run", () => {
  const paths = fixture([agentTask("inspect")]);
  writeFileSync(paths.source, "changed after manifest\n");
  const error = invoke(["init", "--manifest", paths.manifestPath, "--capabilities", paths.capabilitiesPath, "--run-dir", paths.runDir], 1);
  assert.equal(error.code, "source_drift");
});

test("blocks resume when the frozen manifest changes", () => {
  const paths = fixture([agentTask("inspect")]);
  initialize(paths);
  const changed = manifest(paths.source, [agentTask("inspect"), agentTask("extra", ["inspect"])]);
  writeJson(paths.manifestPath, changed);
  const error = invoke(["init", "--manifest", paths.manifestPath, "--capabilities", paths.capabilitiesPath, "--run-dir", paths.runDir], 1);
  assert.equal(error.code, "resume_manifest_drift");
});

test("rejects reuse of one agent handle for every fresh-context task history", () => {
  const tasks = [agentTask("producer"), agentTask("verifier", ["producer"])];
  const paths = fixture(tasks, { independent_pairs: [["producer", "verifier"]] });
  initialize(paths);
  prepareAndBind(paths, "producer", "invocation-producer", "agent/shared");
  finish(paths, "producer", "invocation-producer");
  invoke(["prepare", "--run-dir", paths.runDir, "--task", "verifier", "--invocation", "invocation-verifier"]);
  const error = invoke(["bind", "--run-dir", paths.runDir, "--task", "verifier", "--invocation", "invocation-verifier", "--agent", "agent/shared"], 1);
  assert.equal(error.code, "fresh_handle_reused");
});

test("does not report success while an invocation handle is missing or running", () => {
  const paths = fixture([agentTask("inspect")]);
  initialize(paths);
  invoke(["prepare", "--run-dir", paths.runDir, "--task", "inspect", "--invocation", "invocation-inspect"]);
  assert.equal(invoke(["status", "--run-dir", paths.runDir]).status, "workflow_running");
  invoke(["abort", "--run-dir", paths.runDir, "--task", "inspect", "--invocation", "invocation-inspect", "--reason", "spawn_failed"]);
  assert.equal(invoke(["status", "--run-dir", paths.runDir]).status, "workflow_incomplete");
});

test("resolves arguments, files, results, and artifacts into controller-owned input manifests", () => {
  const external = join(tmpdir(), `dynamic-workflow-external-${process.pid}-${Date.now()}.txt`);
  writeFileSync(external, "frozen external input\n");
  const producer = agentTask("producer", [], {
    inputs: [
      { kind: "argument", key: "topic" },
      { kind: "file", path: external, sha256: sha256(external) },
    ],
    artifact_paths: ["artifacts/producer.txt"],
    effect: "workspace_write",
  });
  const consumer = agentTask("consumer", ["producer"], {
    inputs: [
      { kind: "task_result", task_id: "producer" },
      { kind: "artifact", task_id: "producer", path: "artifacts/producer.txt" },
    ],
  });
  const paths = fixture([producer, consumer], { arguments: { topic: "portable execution" } });
  assert.equal(initialize(paths, ["--max-parallel", "1", "--max-agent-runs", "2"]).effective_max_parallel, 1);
  const preparedProducer = invoke(["prepare", "--run-dir", paths.runDir, "--task", "producer", "--invocation", "invocation-producer"]);
  const producerInputs = JSON.parse(readFileSync(join(paths.runDir, preparedProducer.input_manifest_path), "utf8"));
  const externalSha256 = sha256(external);
  assert.deepEqual(producerInputs.node_result_schema, {
    path: "schemas/node-result.schema.json",
    sha256: sha256(NODE_RESULT_SCHEMA),
  });
  assert.equal(
    sha256(join(paths.runDir, producerInputs.node_result_schema.path)),
    producerInputs.node_result_schema.sha256,
  );
  assert.deepEqual(producerInputs.result_contract, {
    contract_sha256: canonicalSha256(producer.result_contract),
    schema_sha256: producer.result_contract.schema.canonical_sha256,
    schema_path: "inputs/schemas/producer.json",
  });
  assert.deepEqual(
    JSON.parse(readFileSync(join(paths.runDir, producerInputs.result_contract.schema_path), "utf8")),
    producer.result_contract.schema.document,
  );
  assert.equal(
    sha256(join(paths.runDir, producerInputs.result_contract.schema_path)),
    producerInputs.result_contract.schema_sha256,
  );
  assert.deepEqual(producerInputs.output_contract, {
    result_path: "results/producer.json",
    artifact_paths: ["artifacts/producer.txt"],
  });
  assert.deepEqual(producerInputs.inputs[0], { kind: "argument", key: "topic", value: "portable execution" });
  assert.deepEqual(producerInputs.inputs[1], {
    kind: "file",
    path: "inputs/files/producer/0001.bin",
    sha256: externalSha256,
  });
  writeFileSync(external, "mutated after prepare\n");
  assert.equal(readFileSync(join(paths.runDir, producerInputs.inputs[1].path), "utf8"), "frozen external input\n");
  invoke(["bind", "--run-dir", paths.runDir, "--task", "producer", "--invocation", "invocation-producer", "--agent", "agent/producer"]);
  finish(paths, "producer", "invocation-producer");
  const preparedConsumer = invoke(["prepare", "--run-dir", paths.runDir, "--task", "consumer", "--invocation", "invocation-consumer"]);
  const consumerInputs = JSON.parse(readFileSync(join(paths.runDir, preparedConsumer.input_manifest_path), "utf8"));
  assert.deepEqual(consumerInputs.inputs.map((input) => input.kind), ["task_result", "artifact"]);
  assert.equal(invoke(["status", "--run-dir", paths.runDir]).effective_max_agent_runs, 2);
  assert.equal(invoke(["status", "--run-dir", paths.runDir]).agent_runs_remaining, 0);
});

test("rejects drift in a controller-owned frozen input", () => {
  const external = join(tmpdir(), `dynamic-workflow-frozen-drift-${process.pid}-${Date.now()}.txt`);
  writeFileSync(external, "trusted bytes\n");
  const paths = fixture([agentTask("inspect", [], { inputs: [{ kind: "file", path: external, sha256: sha256(external) }] })]);
  initialize(paths);
  const prepared = invoke(["prepare", "--run-dir", paths.runDir, "--task", "inspect", "--invocation", "invocation-inspect"]);
  const inputs = JSON.parse(readFileSync(join(paths.runDir, prepared.input_manifest_path), "utf8"));
  writeFileSync(join(paths.runDir, inputs.inputs[0].path), "tampered bytes\n");
  invoke(["bind", "--run-dir", paths.runDir, "--task", "inspect", "--invocation", "invocation-inspect", "--agent", "agent/inspect"]);
  const resultPath = writeResult(paths, "inspect", "invocation-inspect", "pass");
  const error = invoke([
    "finish", "--run-dir", paths.runDir, "--task", "inspect", "--invocation", "invocation-inspect", "--result", resultPath,
  ], 1);
  assert.equal(error.code, "input_drift");
});

test("projects only selected artifact fields and preserves absolute semantic paths over relative transport paths", () => {
  const { producer, verifier } = projectionWorkflowTasks();
  const paths = fixture([producer, verifier]);
  initialize(paths);
  prepareAndBind(paths, "select", "invocation-select", "agent/select");
  finishJsonArtifact(paths, "select", "invocation-select", "artifacts/claims.json", {
    claims: [{ id: "claim-0", text: "portable claim", verify_method: "web-search", secret_context: "must-not-leak" }],
  });

  const prepared = invoke(["prepare", "--run-dir", paths.runDir, "--task", "verify", "--invocation", "invocation-verify"]);
  const inputManifest = JSON.parse(readFileSync(join(paths.runDir, prepared.input_manifest_path), "utf8"));
  assert.deepEqual(inputManifest.inputs, [{
    kind: "artifact_projection",
    task_id: "select",
    alias: "claim",
    path: "inputs/projections/verify/0000.json",
    sha256: inputManifest.inputs[0].sha256,
  }]);
  const projectionText = readFileSync(join(paths.runDir, inputManifest.inputs[0].path), "utf8");
  assert.deepEqual(JSON.parse(projectionText), { id: "claim-0", text: "portable claim", verify_method: "web-search" });
  assert.doesNotMatch(projectionText, /secret_context|must-not-leak/u);
  assert.deepEqual(inputManifest.capability_requests, [{
    request_id: "claim-public-web-read",
    status: "unavailable",
    semantic_capabilities: ["public_web_read"],
    permissions: ["public_web_read"],
    reasons: ["semantic capability unavailable: public_web_read", "permission unavailable: public_web_read"],
    result_guard: { artifact_path: "artifacts/verdict.json", pointer: "/verdict", predicate: "equals", expected: "cannot-verify" },
  }]);

  invoke(["bind", "--run-dir", paths.runDir, "--task", "verify", "--invocation", "invocation-verify", "--agent", "agent/verify"]);
  const wrong = writeProjectionVerifierResult(paths, "verified");
  const guarded = invoke(["finish", "--run-dir", paths.runDir, "--task", "verify", "--invocation", "invocation-verify", "--result", wrong.resultPath], 1);
  assert.equal(guarded.code, "capability_result_guard_failed");
  const correct = writeProjectionVerifierResult(paths, "cannot-verify");
  assert.equal(invoke(["finish", "--run-dir", paths.runDir, "--task", "verify", "--invocation", "invocation-verify", "--result", correct.resultPath]).status, "completed");
  const verdict = JSON.parse(readFileSync(join(paths.runDir, "artifacts/verdict.json"), "utf8"));
  assert.equal(verdict.evidence_file, correct.evidenceAbsolute);
  assert.equal(JSON.parse(readFileSync(correct.resultPath, "utf8")).artifacts[0].path, "evidence/claim-0.md");
});

test("activates conditional capabilities only after projected data is frozen", () => {
  const { producer, verifier } = projectionWorkflowTasks();
  const paths = fixture([producer, verifier]);
  writeJson(paths.capabilitiesPath, capabilities({
    semantic_capabilities: {
      public_web_read: { availability: "supported", enforcement: "attested_not_enforced", constraints: {} },
    },
    permissions: {
      public_web_read: { status: "granted", enforcement: "attested_not_enforced", scope: {} },
    },
  }));
  writeTranslationReview(paths);
  assert.deepEqual(JSON.parse(readFileSync(paths.manifestPath, "utf8")).required_capabilities, ["native_collaboration", "spawn", "collect_or_wait", "stable_handle"]);
  initialize(paths);
  prepareAndBind(paths, "select", "invocation-select", "agent/select");
  finishJsonArtifact(paths, "select", "invocation-select", "artifacts/claims.json", {
    claims: [{ id: "claim-0", text: "portable claim", verify_method: "web-search", secret_context: "private" }],
  });
  const prepared = invoke(["prepare", "--run-dir", paths.runDir, "--task", "verify", "--invocation", "invocation-verify"]);
  const inputManifest = JSON.parse(readFileSync(join(paths.runDir, prepared.input_manifest_path), "utf8"));
  assert.equal(inputManifest.capability_requests[0].status, "available");
  assert.equal(inputManifest.capability_requests[0].result_guard, null);
  invoke(["bind", "--run-dir", paths.runDir, "--task", "verify", "--invocation", "invocation-verify", "--agent", "agent/verify"]);
  const verified = writeProjectionVerifierResult(paths, "verified");
  assert.equal(invoke(["finish", "--run-dir", paths.runDir, "--task", "verify", "--invocation", "invocation-verify", "--result", verified.resultPath]).status, "completed");
});

test("leaves a conditional capability request inactive when frozen projected data does not match", () => {
  const { producer, verifier } = projectionWorkflowTasks();
  const paths = fixture([producer, verifier]);
  initialize(paths);
  prepareAndBind(paths, "select", "invocation-select", "agent/select");
  finishJsonArtifact(paths, "select", "invocation-select", "artifacts/claims.json", {
    claims: [{ id: "claim-0", text: "portable claim", verify_method: "not-verifiable", secret_context: "private" }],
  });
  const prepared = invoke(["prepare", "--run-dir", paths.runDir, "--task", "verify", "--invocation", "invocation-verify"]);
  const inputManifest = JSON.parse(readFileSync(join(paths.runDir, prepared.input_manifest_path), "utf8"));
  assert.deepEqual(inputManifest.capability_requests, [{
    request_id: "claim-public-web-read",
    status: "inactive",
    semantic_capabilities: ["public_web_read"],
    permissions: ["public_web_read"],
    reasons: [],
    result_guard: null,
  }]);
  invoke(["bind", "--run-dir", paths.runDir, "--task", "verify", "--invocation", "invocation-verify", "--agent", "agent/verify"]);
  const assessed = writeProjectionVerifierResult(paths, "verified");
  assert.equal(invoke(["finish", "--run-dir", paths.runDir, "--task", "verify", "--invocation", "invocation-verify", "--result", assessed.resultPath]).status, "completed");
});

test("fails closed when an artifact projection pointer does not resolve", () => {
  const { producer, verifier } = projectionWorkflowTasks();
  verifier.inputs[0].pointer = "/claims/99";
  const paths = fixture([producer, verifier]);
  initialize(paths);
  prepareAndBind(paths, "select", "invocation-select", "agent/select");
  finishJsonArtifact(paths, "select", "invocation-select", "artifacts/claims.json", {
    claims: [{ id: "claim-0", text: "portable claim", verify_method: "web-search", secret_context: "private" }],
  });
  const error = invoke(["prepare", "--run-dir", paths.runDir, "--task", "verify", "--invocation", "invocation-verify"], 1);
  assert.equal(error.code, "input_projection_failed");
});

test("evaluates an optional task condition through its declared projection without exposing the full artifact", () => {
  const { producer, verifier } = projectionWorkflowTasks();
  verifier.required = false;
  verifier.when = { task_id: "select", input_alias: "claim", pointer: "/id", predicate: "exists" };
  const paths = fixture([producer, verifier]);
  initialize(paths);
  prepareAndBind(paths, "select", "invocation-select", "agent/select");
  finishJsonArtifact(paths, "select", "invocation-select", "artifacts/claims.json", {
    claims: [{ id: "claim-0", text: "portable claim", verify_method: "web-search", secret_context: "must-not-leak" }],
  });
  const ready = invoke(["ready", "--run-dir", paths.runDir]);
  assert.deepEqual(ready.ready.map((task) => task.id), ["verify"]);
  const prepared = invoke(["prepare", "--run-dir", paths.runDir, "--task", "verify", "--invocation", "invocation-verify"]);
  const inputManifest = JSON.parse(readFileSync(join(paths.runDir, prepared.input_manifest_path), "utf8"));
  assert.deepEqual(inputManifest.inputs.map((input) => input.kind), ["artifact_projection"]);
  assert.equal(inputManifest.inputs.some((input) => input.path === "artifacts/claims.json"), false);
});

test("skips an absent bounded slot through a projection condition before materializing its missing input", () => {
  const { producer, verifier } = projectionWorkflowTasks();
  verifier.required = false;
  verifier.inputs[0].pointer = "/claims/1";
  verifier.when = { task_id: "select", input_alias: "claim", pointer: "/id", predicate: "exists" };
  const paths = fixture([producer, verifier]);
  initialize(paths);
  prepareAndBind(paths, "select", "invocation-select", "agent/select");
  finishJsonArtifact(paths, "select", "invocation-select", "artifacts/claims.json", {
    claims: [{ id: "claim-0", text: "only bounded slot", verify_method: "web-search", secret_context: "private" }],
  });
  const ready = invoke(["ready", "--run-dir", paths.runDir]);
  assert.deepEqual(ready.ready, []);
  const state = JSON.parse(readFileSync(join(paths.runDir, "workflow-state.json"), "utf8"));
  assert.equal(state.tasks.verify.status, "skipped");
  assert.equal(state.tasks.verify.input_manifest_path, null);
});

test("rejects producer drift after an artifact projection has been frozen", () => {
  const { producer, verifier } = projectionWorkflowTasks();
  const paths = fixture([producer, verifier]);
  initialize(paths);
  prepareAndBind(paths, "select", "invocation-select", "agent/select");
  finishJsonArtifact(paths, "select", "invocation-select", "artifacts/claims.json", {
    claims: [{ id: "claim-0", text: "version one", verify_method: "web-search", secret_context: "private" }],
  });
  invoke(["prepare", "--run-dir", paths.runDir, "--task", "verify", "--invocation", "invocation-verify"]);
  invoke(["bind", "--run-dir", paths.runDir, "--task", "verify", "--invocation", "invocation-verify", "--agent", "agent/verify"]);
  writeJson(join(paths.runDir, "artifacts/claims.json"), {
    claims: [{ id: "claim-0", text: "version two", verify_method: "web-search", secret_context: "private" }],
  });
  const result = writeProjectionVerifierResult(paths, "cannot-verify");
  const error = invoke(["finish", "--run-dir", paths.runDir, "--task", "verify", "--invocation", "invocation-verify", "--result", result.resultPath], 1);
  assert.equal(error.code, "input_drift");
});

test("rejects drift in the run-frozen common node-result schema", () => {
  const paths = fixture([agentTask("inspect")]);
  initialize(paths);
  const prepared = invoke(["prepare", "--run-dir", paths.runDir, "--task", "inspect", "--invocation", "invocation-inspect"]);
  const input = JSON.parse(readFileSync(join(paths.runDir, prepared.input_manifest_path), "utf8"));
  writeFileSync(join(paths.runDir, input.node_result_schema.path), "{}\n");
  const error = invoke(["status", "--run-dir", paths.runDir], 1);
  assert.equal(error.code, "state_drift");
  assert.match(error.message, /node-result schema hash mismatch/u);
});

test("rejects drift in a run-frozen inline task result schema", () => {
  const paths = fixture([agentTask("inspect")]);
  initialize(paths);
  const prepared = invoke(["prepare", "--run-dir", paths.runDir, "--task", "inspect", "--invocation", "invocation-inspect"]);
  const input = JSON.parse(readFileSync(join(paths.runDir, prepared.input_manifest_path), "utf8"));
  assert.equal(input.result_contract.schema_path, "inputs/schemas/inspect.json");
  writeFileSync(join(paths.runDir, input.result_contract.schema_path), "{}\n");
  invoke(["bind", "--run-dir", paths.runDir, "--task", "inspect", "--invocation", "invocation-inspect", "--agent", "agent/inspect"]);
  const resultPath = writeResult(paths, "inspect", "invocation-inspect", "pass");
  const error = invoke([
    "finish", "--run-dir", paths.runDir, "--task", "inspect", "--invocation", "invocation-inspect", "--result", resultPath,
  ], 1);
  assert.equal(error.code, "result_contract_drift");
  assert.match(error.message, /frozen result schema changed/u);
});

test("rejects an absolute artifact path in the common node-result contract", () => {
  const paths = fixture([agentTask("inspect", [], {
    artifact_paths: ["artifacts/inspect.txt"],
    effect: "workspace_write",
  })]);
  initialize(paths);
  prepareAndBind(paths, "inspect", "invocation-inspect", "agent/inspect");
  const resultPath = writeResult(paths, "inspect", "invocation-inspect", "pass");
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  result.artifacts[0].path = join(paths.runDir, result.artifacts[0].path);
  writeJson(resultPath, result);
  const error = invoke([
    "finish", "--run-dir", paths.runDir, "--task", "inspect", "--invocation", "invocation-inspect", "--result", resultPath,
  ], 1);
  assert.equal(error.code, "unsafe_path");
  assert.match(error.message, /must be relative/u);
});

test("rejects external input drift before invocation preparation", () => {
  const external = join(tmpdir(), `dynamic-workflow-drift-${process.pid}-${Date.now()}.txt`);
  writeFileSync(external, "version one\n");
  const paths = fixture([agentTask("inspect", [], { inputs: [{ kind: "file", path: external, sha256: sha256(external) }] })]);
  initialize(paths);
  writeFileSync(external, "version two\n");
  const error = invoke(["prepare", "--run-dir", paths.runDir, "--task", "inspect", "--invocation", "invocation-inspect"], 1);
  assert.equal(error.code, "input_drift");
});

test("requires a fresh translation-review invocation receipt bound to the review", () => {
  const paths = fixture([agentTask("inspect")]);
  const receipt = JSON.parse(readFileSync(paths.translationReviewReceiptPath, "utf8"));
  receipt.parent_context_inherited = true;
  writeJson(paths.translationReviewReceiptPath, receipt);
  const error = invoke([
    "init",
    "--manifest",
    paths.manifestPath,
    "--capabilities",
    paths.capabilitiesPath,
    "--translation-review",
    paths.translationReviewPath,
    "--translation-review-receipt",
    paths.translationReviewReceiptPath,
    "--run-dir",
    paths.runDir,
  ], 1);
  assert.equal(error.code, "reviewer_not_independent");
});

test("binds translation review to the exact executing runner contract inventory", () => {
  const wrongRoot = fixture([agentTask("inspect")]);
  mutateTranslationReviewInput(wrongRoot, (input) => {
    input.runner_contract.skill_root = wrongRoot.root;
    input.runner_contract.canonical_sha256 = canonicalSha256({
      skill_root: input.runner_contract.skill_root,
      files: input.runner_contract.files,
    });
  });
  assert.equal(initialize(wrongRoot, [], 1).code, "translation_review_crosswire");

  const wrongHash = fixture([agentTask("inspect")]);
  mutateTranslationReviewInput(wrongHash, (input) => {
    input.runner_contract.files[0].sha256 = "0".repeat(64);
    input.runner_contract.canonical_sha256 = canonicalSha256({
      skill_root: input.runner_contract.skill_root,
      files: input.runner_contract.files,
    });
  });
  assert.equal(initialize(wrongHash, [], 1).code, "translation_review_crosswire");

  const missingFile = fixture([agentTask("inspect")]);
  mutateTranslationReviewInput(missingFile, (input) => {
    input.runner_contract.files.pop();
    input.runner_contract.canonical_sha256 = canonicalSha256({
      skill_root: input.runner_contract.skill_root,
      files: input.runner_contract.files,
    });
  });
  assert.equal(initialize(missingFile, [], 1).code, "translation_review_crosswire");
});

test("binds translated provenance across review input, invocation receipt, and review output", () => {
  const inputCrosswire = fixture([agentTask("inspect")]);
  mutateTranslationReviewInput(inputCrosswire, (input) => {
    input.translator_handle = "agent/substituted-translator";
  });
  assert.equal(initialize(inputCrosswire, [], 1).code, "translation_review_crosswire");

  const receiptCrosswire = fixture([agentTask("inspect")]);
  const receipt = JSON.parse(readFileSync(receiptCrosswire.translationReviewReceiptPath, "utf8"));
  receipt.translator_handle = "agent/substituted-translator";
  writeJson(receiptCrosswire.translationReviewReceiptPath, receipt);
  assert.equal(initialize(receiptCrosswire, [], 1).code, "translation_review_crosswire");

  const reusedHandle = fixture([agentTask("inspect")]);
  const reusedReceipt = JSON.parse(readFileSync(reusedHandle.translationReviewReceiptPath, "utf8"));
  reusedReceipt.reviewer_handle = reusedReceipt.translator_handle;
  writeJson(reusedHandle.translationReviewReceiptPath, reusedReceipt);
  assert.equal(initialize(reusedHandle, [], 1).code, "reviewer_not_independent");

  const direct = fixture([agentTask("inspect")], { translation_mode: "direct" });
  assert.equal(initialize(direct).status, "workflow_ready");
});

test("rejects a human gate as a conditional outcome source", () => {
  const tasks = [
    {
      id: "gate",
      kind: "human_gate",
      depends_on: [],
      required: true,
      action: "decide",
      targets: ["local-package"],
      scope: ["decision-only"],
      action_package: null,
    },
    agentTask("consumer", ["gate"], { when: { task_id: "gate", outcomes: ["pass"] } }),
  ];
  const paths = fixture(tasks);
  const error = invoke(["init", "--manifest", paths.manifestPath, "--capabilities", paths.capabilitiesPath, "--run-dir", paths.runDir], 1);
  assert.equal(error.code, "invalid_graph");
});

test("rejects failed and blocked outcomes as branch completion signals", () => {
  for (const outcome of ["failed", "blocked"]) {
    const tasks = [
      agentTask("producer"),
      agentTask("recovery", ["producer"], { when: { task_id: "producer", outcomes: [outcome] } }),
    ];
    const paths = fixture(tasks);
    const error = invoke(["init", "--manifest", paths.manifestPath, "--capabilities", paths.capabilitiesPath, "--run-dir", paths.runDir], 1);
    assert.equal(error.code, "invalid_schema");
  }
});

test("rejects agent outputs that collide with controller-owned paths", () => {
  for (const outputPath of ["workflow-state.json", "review/input-manifest.json", "inputs/task.json", "translation/review-input.json"]) {
    const paths = fixture([agentTask("inspect", [], { output_path: outputPath })]);
    const error = invoke(["init", "--manifest", paths.manifestPath, "--capabilities", paths.capabilitiesPath, "--run-dir", paths.runDir], 1);
    assert.equal(error.code, "unsafe_path");
  }
});

test("rejects non-string evidence instead of drifting from the result schema", () => {
  const paths = fixture([agentTask("inspect")]);
  initialize(paths);
  prepareAndBind(paths, "inspect", "invocation-inspect", "agent/inspect");
  const resultPath = writeResult(paths, "inspect", "invocation-inspect");
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  result.evidence = [null];
  writeJson(resultPath, result);
  const error = invoke(["finish", "--run-dir", paths.runDir, "--task", "inspect", "--invocation", "invocation-inspect", "--result", resultPath], 1);
  assert.equal(error.code, "invalid_schema");
});

test("preserves exact translation review bytes and the original receipt lineage", () => {
  const paths = fixture([agentTask("inspect")]);
  const originalInput = readFileSync(paths.translationReviewInputPath);
  const originalReceipt = readFileSync(paths.translationReviewReceiptPath);
  initialize(paths);
  assert.deepEqual(readFileSync(join(paths.runDir, "translation", "review-input.json")), originalInput);
  assert.deepEqual(readFileSync(join(paths.runDir, "translation", "original-review-receipt.json")), originalReceipt);
  const frozenReceipt = JSON.parse(readFileSync(join(paths.runDir, "translation-review-receipt.json"), "utf8"));
  assert.equal(frozenReceipt.translation_mode, "translated");
  assert.equal(frozenReceipt.handle_boundary, "attested_not_enforced");
  assert.equal(frozenReceipt.input_manifest.sha256, sha256(paths.translationReviewInputPath));
  assert.equal(frozenReceipt.original_receipt.sha256, sha256(paths.translationReviewReceiptPath));
  const frozenInput = JSON.parse(originalInput);
  assert.equal(frozenInput.manifest.path, paths.manifestPath);
});

test("binds direct translation mode to a null translator handle", () => {
  const paths = fixture([agentTask("inspect")], { translation_mode: "direct" });
  assert.equal(initialize(paths).status, "workflow_ready");

  const mismatch = fixture([agentTask("inspect")]);
  const mismatchReview = JSON.parse(readFileSync(mismatch.translationReviewPath, "utf8"));
  mismatchReview.translator_handle = null;
  writeJson(mismatch.translationReviewPath, mismatchReview);
  const error = invoke([
    "init", "--manifest", mismatch.manifestPath, "--capabilities", mismatch.capabilitiesPath,
    "--translation-review", mismatch.translationReviewPath,
    "--translation-review-receipt", mismatch.translationReviewReceiptPath,
    "--run-dir", mismatch.runDir,
  ], 1);
  assert.equal(error.code, "translation_review_crosswire");
});

test("never closes optional failed or blocked tasks at review or finalize boundaries", () => {
  const failed = fixture([agentTask("optional", [], { required: false })]);
  initialize(failed);
  prepareAndBind(failed, "optional", "invocation-optional", "agent/optional");
  invoke(["abort", "--run-dir", failed.runDir, "--task", "optional", "--invocation", "invocation-optional", "--reason", "fixture failure"]);
  assert.equal(invoke(["status", "--run-dir", failed.runDir]).status, "workflow_incomplete");
  const failedPrompt = join(failed.runDir, "review", "prompt.md");
  mkdirSync(dirname(failedPrompt), { recursive: true });
  writeFileSync(failedPrompt, "review\n");
  assert.equal(invoke(["review-prepare", "--run-dir", failed.runDir, "--invocation", "review-failed", "--prompt", failedPrompt], 1).code, "workflow_not_complete");

  const tampered = fixture([agentTask("inspect")]);
  initialize(tampered);
  prepareAndBind(tampered, "inspect", "invocation-inspect", "agent/inspect");
  finish(tampered, "inspect", "invocation-inspect");
  const prompt = join(tampered.runDir, "review", "prompt.md");
  mkdirSync(dirname(prompt), { recursive: true });
  writeFileSync(prompt, "review\n");
  invoke(["review-prepare", "--run-dir", tampered.runDir, "--invocation", "review-tampered", "--prompt", prompt]);
  invoke(["review-bind", "--run-dir", tampered.runDir, "--invocation", "review-tampered", "--agent", "agent/final-review"]);
  const statePath = join(tampered.runDir, "workflow-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.tasks.inspect.status = "blocked";
  writeJson(statePath, state);
  const stagedReview = join(tampered.runDir, "staging", "review.json");
  writeJson(stagedReview, {});
  assert.equal(invoke(["finalize", "--run-dir", tampered.runDir, "--review", stagedReview], 1).code, "state_drift");
});

test("rejects terminal task states without matching transition provenance", () => {
  const pendingAgent = fixture([agentTask("inspect")]);
  initialize(pendingAgent);
  let statePath = join(pendingAgent.runDir, "workflow-state.json");
  let state = JSON.parse(readFileSync(statePath, "utf8"));
  state.tasks.inspect.status = "skipped";
  writeJson(statePath, state);
  assert.equal(invoke(["verify", "--run-dir", pendingAgent.runDir], 1).code, "state_drift");

  const gateOnly = fixture([{
    id: "approval-gate",
    kind: "human_gate",
    depends_on: [],
    required: true,
    action: "publish",
    targets: ["local-output"],
    scope: ["prepared-artifact-only"],
    action_package: null,
  }]);
  initialize(gateOnly);
  statePath = join(gateOnly.runDir, "workflow-state.json");
  state = JSON.parse(readFileSync(statePath, "utf8"));
  state.tasks["approval-gate"].status = "approved";
  writeJson(statePath, state);
  assert.equal(invoke(["verify", "--run-dir", gateOnly.runDir], 1).code, "state_drift");

  const aborted = fixture([agentTask("inspect")]);
  initialize(aborted);
  prepareAndBind(aborted, "inspect", "invocation-inspect", "agent/inspect");
  invoke(["abort", "--run-dir", aborted.runDir, "--task", "inspect", "--invocation", "invocation-inspect", "--reason", "fixture abort"]);
  statePath = join(aborted.runDir, "workflow-state.json");
  state = JSON.parse(readFileSync(statePath, "utf8"));
  state.tasks.inspect.status = "skipped";
  writeJson(statePath, state);
  assert.equal(invoke(["verify", "--run-dir", aborted.runDir], 1).code, "state_drift");

  const completed = fixture([agentTask("inspect")]);
  initialize(completed);
  prepareAndBind(completed, "inspect", "invocation-inspect", "agent/inspect");
  finish(completed, "inspect", "invocation-inspect");
  statePath = join(completed.runDir, "workflow-state.json");
  state = JSON.parse(readFileSync(statePath, "utf8"));
  state.tasks.inspect.status = "resolved";
  writeJson(statePath, state);
  assert.equal(invoke(["verify", "--run-dir", completed.runDir], 1).code, "state_drift");
});

test("binds execution limits, run counters, and agent identity to event history", () => {
  const mutations = [
    (state) => { state.agent_runs_prepared = 0; },
    (state) => { state.frozen_max_parallel = 2; },
    (state) => { state.effective_max_parallel = 2; },
    (state) => { state.effective_max_agent_runs = 3; },
    (state) => { state.tasks.inspect.agent_handle = null; },
  ];
  for (const mutate of mutations) {
    const paths = fixture([agentTask("inspect")]);
    initialize(paths, ["--max-parallel", "1", "--max-agent-runs", "2"]);
    prepareAndBind(paths, "inspect", "invocation-inspect", "agent/inspect");
    finish(paths, "inspect", "invocation-inspect");
    const statePath = join(paths.runDir, "workflow-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    mutate(state);
    writeJson(statePath, state);
    assert.equal(invoke(["status", "--run-dir", paths.runDir], 1).code, "state_drift");
  }
});

test("rejects dirty run roots, canonicalizes a root alias, and rejects marker symlinks", () => {
  const dirty = fixture([agentTask("inspect")]);
  mkdirSync(dirty.runDir);
  writeFileSync(join(dirty.runDir, "unrelated.txt"), "do not overwrite\n");
  assert.equal(invoke([
    "init", "--manifest", dirty.manifestPath, "--capabilities", dirty.capabilitiesPath,
    "--translation-review", dirty.translationReviewPath,
    "--translation-review-receipt", dirty.translationReviewReceiptPath,
    "--run-dir", dirty.runDir,
  ], 1).code, "run_dir_not_clean");

  const rootLink = fixture([agentTask("inspect")]);
  initialize(rootLink);
  const realRun = `${rootLink.runDir}-real`;
  renameSync(rootLink.runDir, realRun);
  symlinkSync(realRun, rootLink.runDir, "dir");
  assert.equal(invoke(["status", "--run-dir", rootLink.runDir]).status, "workflow_ready");

  const markerLink = fixture([agentTask("inspect")]);
  initialize(markerLink);
  const statePath = join(markerLink.runDir, "workflow-state.json");
  const realState = join(markerLink.runDir, "workflow-state.real.json");
  renameSync(statePath, realState);
  symlinkSync(realState, statePath);
  assert.equal(invoke(["status", "--run-dir", markerLink.runDir], 1).code, "unsafe_path");
});

test("recovers a typed stale lock only through one serialized audited command and refuses an active lock", async () => {
  const stale = fixture([agentTask("inspect")]);
  mkdirSync(stale.runDir);
  writeJson(join(stale.runDir, ".workflow-control.lock"), {
    schema_version: "dynamic-workflow-lock/v1",
    pid: 2147483647,
    hostname: hostname(),
    acquired_at: "2026-08-13T00:00:00Z",
    token: "00000000-0000-4000-8000-000000000001",
  });
  assert.equal(initialize(stale, [], 1).code, "stale_lock");
  const recoverArgs = ["recover-lock", "--run-dir", stale.runDir, "--actor", "operator:test"];
  const recoveries = await Promise.all([invokeAsync(recoverArgs), invokeAsync(recoverArgs)]);
  assert.equal(recoveries.filter((result) => result.status === 0).length, 1);
  assert.equal(JSON.parse(recoveries.find((result) => result.status === 0).stdout).status, "stale_lock_recovered");
  assert.equal(initialize(stale).status, "workflow_ready");
  const recoveryFiles = readdirSync(join(stale.runDir, "lock-recovery"));
  assert.equal(recoveryFiles.filter((path) => path.endsWith(".lock.json")).length, 1);
  assert.equal(recoveryFiles.filter((path) => path.endsWith(".recovery.json")).length, 1);
  assert.equal(invoke(["verify", "--run-dir", stale.runDir]).valid, true);
  writeJson(join(stale.runDir, ".workflow-control.lock"), {
    schema_version: "dynamic-workflow-lock/v1",
    pid: 2147483647,
    hostname: hostname(),
    acquired_at: "2026-08-13T00:03:00Z",
    token: "00000000-0000-4000-8000-000000000003",
  });
  assert.equal(invoke(["status", "--run-dir", stale.runDir], 1).code, "stale_lock");
  assert.equal(invoke(["recover-lock", "--run-dir", stale.runDir, "--actor", "operator:test"]).status, "stale_lock_recovered");
  assert.equal(invoke(["verify", "--run-dir", stale.runDir]).valid, true);

  const active = fixture([agentTask("inspect")]);
  mkdirSync(active.runDir);
  writeJson(join(active.runDir, ".workflow-control.lock"), {
    schema_version: "dynamic-workflow-lock/v1",
    pid: process.pid,
    hostname: hostname(),
    acquired_at: "2026-08-13T00:00:00Z",
    token: "00000000-0000-4000-8000-000000000002",
  });
  assert.equal(initialize(active, [], 1).code, "run_locked");

  const staleRecoveryGuard = fixture([agentTask("inspect")]);
  mkdirSync(staleRecoveryGuard.runDir);
  writeJson(join(staleRecoveryGuard.runDir, ".workflow-control.lock"), {
    schema_version: "dynamic-workflow-lock/v1",
    pid: 2147483647,
    hostname: hostname(),
    acquired_at: "2026-08-13T00:00:00Z",
    token: "00000000-0000-4000-8000-000000000004",
  });
  writeJson(join(staleRecoveryGuard.runDir, ".workflow-control.recovery.lock"), {
    schema_version: "dynamic-workflow-recovery-lock/v1",
    pid: 2147483647,
    hostname: hostname(),
    acquired_at: "2026-08-13T00:00:00Z",
    token: "00000000-0000-4000-8000-000000000005",
  });
  assert.equal(invoke(["recover-lock", "--run-dir", staleRecoveryGuard.runDir, "--actor", "operator:test"], 1).code, "run_locked");
  assert.equal(existsSync(join(staleRecoveryGuard.runDir, ".workflow-control.recovery.lock")), true);

  const partialLock = fixture([agentTask("inspect")]);
  mkdirSync(partialLock.runDir);
  writeFileSync(join(partialLock.runDir, ".workflow-control.lock"), "");
  assert.equal(initialize(partialLock, [], 1).code, "run_locked");

  const partialRecoveryGuard = fixture([agentTask("inspect")]);
  mkdirSync(partialRecoveryGuard.runDir);
  writeJson(join(partialRecoveryGuard.runDir, ".workflow-control.lock"), {
    schema_version: "dynamic-workflow-lock/v1",
    pid: 2147483647,
    hostname: hostname(),
    acquired_at: "2026-08-13T00:00:00Z",
    token: "00000000-0000-4000-8000-000000000006",
  });
  writeFileSync(join(partialRecoveryGuard.runDir, ".workflow-control.recovery.lock"), "");
  assert.equal(invoke(["recover-lock", "--run-dir", partialRecoveryGuard.runDir, "--actor", "operator:test"], 1).code, "run_locked");
});

test("serializes competing initializers without overwriting the winning run", async () => {
  const paths = fixture([agentTask("inspect")]);
  const args = [
    "init", "--manifest", paths.manifestPath,
    "--capabilities", paths.capabilitiesPath,
    "--translation-review", paths.translationReviewPath,
    "--translation-review-receipt", paths.translationReviewReceiptPath,
    "--run-dir", paths.runDir,
  ];
  const results = await Promise.all([invokeAsync(args), invokeAsync(args)]);
  assert.equal(results.filter((result) => result.status === 0).length, 1);
  const loser = results.find((result) => result.status !== 0);
  const error = JSON.parse(loser.stderr);
  assert.ok(["run_locked", "run_already_initialized", "run_dir_not_clean", "stale_capability_snapshot"].includes(error.code));
  assert.equal(invoke(["verify", "--run-dir", paths.runDir]).valid, true);
});

test("rejects ancestor and descendant output collisions including controller descendants", () => {
  const overlap = fixture([
    agentTask("parent", [], { output_path: "results" }),
    agentTask("child", [], { output_path: "results/child.json" }),
  ]);
  assert.equal(invoke(["init", "--manifest", overlap.manifestPath, "--capabilities", overlap.capabilitiesPath, "--run-dir", overlap.runDir], 1).code, "unsafe_path");
  for (const outputPath of ["workflow-state.json/child.json", "review", "translation/review-prompt/child"] ) {
    const paths = fixture([agentTask("inspect", [], { output_path: outputPath })]);
    assert.equal(invoke(["init", "--manifest", paths.manifestPath, "--capabilities", paths.capabilitiesPath, "--run-dir", paths.runDir], 1).code, "unsafe_path");
  }
});

test("requires typed capability isolation, trust, secret, fork, and observation metadata", () => {
  const missing = fixture([agentTask("inspect")]);
  const missingCapabilities = capabilities();
  delete missingCapabilities.tool_isolation;
  writeJson(missing.capabilitiesPath, missingCapabilities);
  assert.equal(invoke(["init", "--manifest", missing.manifestPath, "--capabilities", missing.capabilitiesPath, "--run-dir", missing.runDir], 1).code, "invalid_schema");

  const staleShape = fixture([agentTask("inspect")]);
  writeJson(staleShape.capabilitiesPath, capabilities({ observed_at: "not-a-date" }));
  assert.equal(invoke(["init", "--manifest", staleShape.manifestPath, "--capabilities", staleShape.capabilitiesPath, "--run-dir", staleShape.runDir], 1).code, "invalid_schema");

  for (const observedAt of ["2025-02-31T00:00:00Z", "2025-01-01T24:00:00Z", "2025-01-01T00:00:00.1234567890Z"]) {
    const invalidDate = fixture([agentTask("inspect")]);
    writeJson(invalidDate.capabilitiesPath, capabilities({ observed_at: observedAt }));
    assert.equal(invoke(["init", "--manifest", invalidDate.manifestPath, "--capabilities", invalidDate.capabilitiesPath, "--run-dir", invalidDate.runDir], 1).code, "invalid_schema");
  }

  for (const overrides of [{ source_trust: "untrusted" }, { secret_bearing: true }]) {
    const unsafe = fixture([agentTask("inspect")]);
    writeJson(unsafe.capabilitiesPath, capabilities(overrides));
    assert.equal(invoke(["init", "--manifest", unsafe.manifestPath, "--capabilities", unsafe.capabilitiesPath, "--run-dir", unsafe.runDir], 1).code, "unsupported_runtime");
  }

  const inherited = fixture([agentTask("inspect")]);
  writeJson(inherited.capabilitiesPath, capabilities({ fork_behavior: { context_isolation: "attested_not_enforced", model_context_inherited: true } }));
  assert.equal(invoke(["init", "--manifest", inherited.manifestPath, "--capabilities", inherited.capabilitiesPath, "--run-dir", inherited.runDir], 1).code, "unsupported_runtime");
});

test("binds action-package action, targets, scope, hash, and reapproval semantics", () => {
  const tasks = [
    agentTask("package", [], { artifact_paths: ["artifacts/action-package.json"], effect: "workspace_write" }),
    {
      id: "handoff",
      kind: "human_gate",
      depends_on: ["package"],
      required: true,
      action: "publish",
      targets: ["local-output"],
      scope: ["prepared-artifact-only"],
      action_package: { task_id: "package", path: "artifacts/action-package.json" },
    },
  ];
  const paths = fixture(tasks);
  initialize(paths);
  prepareAndBind(paths, "package", "invocation-package", "agent/package");
  const resultPath = writeResult(paths, "package", "invocation-package");
  const packagePath = join(paths.runDir, "artifacts", "action-package.json");
  const actionPackage = JSON.parse(readFileSync(packagePath, "utf8"));
  actionPackage.scope = ["broader-than-approved"];
  writeJson(packagePath, actionPackage);
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  result.artifacts[0].sha256 = sha256(packagePath);
  writeJson(resultPath, result);
  invoke(["finish", "--run-dir", paths.runDir, "--task", "package", "--invocation", "invocation-package", "--result", resultPath]);
  assert.equal(invoke(["approve", "--run-dir", paths.runDir, "--task", "handoff", "--decision", "approve", "--actor", "user"], 1).code, "input_crosswire");
});

test("rejects action packages that claim an external effect or cross-wire lineage", () => {
  function handoffFixture() {
    return fixture([
      agentTask("package", [], { artifact_paths: ["artifacts/action-package.json"], effect: "workspace_write" }),
      {
        id: "handoff",
        kind: "human_gate",
        depends_on: ["package"],
        required: true,
        action: "publish",
        targets: ["local-output"],
        scope: ["prepared-artifact-only"],
        action_package: { task_id: "package", path: "artifacts/action-package.json" },
      },
    ]);
  }

  for (const [field, expectedCode] of [["external", "external_effect_forbidden"], ["lineage", "input_crosswire"]]) {
    const paths = handoffFixture();
    initialize(paths);
    prepareAndBind(paths, "package", `invocation-${field}`, `agent/${field}`);
    const resultPath = writeResult(paths, "package", `invocation-${field}`);
    const packagePath = join(paths.runDir, "artifacts", "action-package.json");
    const actionPackage = JSON.parse(readFileSync(packagePath, "utf8"));
    if (field === "external") actionPackage.external_effects_performed = true;
    else actionPackage.lineage.source_sha256 = "0".repeat(64);
    writeJson(packagePath, actionPackage);
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    result.artifacts[0].sha256 = sha256(packagePath);
    writeJson(resultPath, result);
    invoke(["finish", "--run-dir", paths.runDir, "--task", "package", "--invocation", `invocation-${field}`, "--result", resultPath]);
    assert.equal(invoke(["approve", "--run-dir", paths.runDir, "--task", "handoff", "--decision", "approve", "--actor", "user"], 1).code, expectedCode);
  }
});

test("rejects duplicate action IDs across separately approved action packages", () => {
  const tasks = [
    agentTask("package-one", [], { artifact_paths: ["artifacts/one/action-package.json"], effect: "workspace_write" }),
    agentTask("package-two", [], { artifact_paths: ["artifacts/two/action-package.json"], effect: "workspace_write" }),
    {
      id: "gate-one",
      kind: "human_gate",
      depends_on: ["package-one"],
      required: true,
      action: "publish",
      targets: ["local-output"],
      scope: ["prepared-artifact-only"],
      action_package: { task_id: "package-one", path: "artifacts/one/action-package.json" },
    },
    {
      id: "gate-two",
      kind: "human_gate",
      depends_on: ["package-two"],
      required: true,
      action: "publish",
      targets: ["local-output"],
      scope: ["prepared-artifact-only"],
      action_package: { task_id: "package-two", path: "artifacts/two/action-package.json" },
    },
  ];
  const paths = fixture(tasks);
  initialize(paths);
  for (const packageId of ["package-one", "package-two"]) {
    prepareAndBind(paths, packageId, `invocation-${packageId}`, `agent/${packageId}`);
    finish(paths, packageId, `invocation-${packageId}`);
  }
  invoke(["approve", "--run-dir", paths.runDir, "--task", "gate-one", "--decision", "approve", "--actor", "user"]);
  const conflict = invoke(["approve", "--run-dir", paths.runDir, "--task", "gate-two", "--decision", "approve", "--actor", "user"], 1);
  assert.equal(conflict.code, "action_package_conflict");
  assert.equal(invoke(["status", "--run-dir", paths.runDir]).status, "workflow_waiting_for_gate");
});

test("rechecks source lineage while using controller-owned input snapshots after prepare", () => {
  const sourceDrift = fixture([agentTask("inspect")]);
  initialize(sourceDrift);
  writeFileSync(sourceDrift.source, "post-init source drift\n");
  assert.equal(invoke(["verify", "--run-dir", sourceDrift.runDir], 1).code, "source_drift");

  const external = join(tmpdir(), `dynamic-workflow-finish-drift-${process.pid}-${Date.now()}.txt`);
  writeFileSync(external, "version one\n");
  const inputDrift = fixture([agentTask("inspect", [], { inputs: [{ kind: "file", path: external, sha256: sha256(external) }] })]);
  initialize(inputDrift);
  prepareAndBind(inputDrift, "inspect", "invocation-inspect", "agent/inspect");
  const inputResult = writeResult(inputDrift, "inspect", "invocation-inspect");
  writeFileSync(external, "version two\n");
  assert.equal(invoke(["finish", "--run-dir", inputDrift.runDir, "--task", "inspect", "--invocation", "invocation-inspect", "--result", inputResult]).status, "completed");

  const duplicateExternal = join(tmpdir(), `dynamic-workflow-duplicate-finish-${process.pid}-${Date.now()}.txt`);
  writeFileSync(duplicateExternal, "version one\n");
  const duplicateDrift = fixture([agentTask("inspect", [], { inputs: [{ kind: "file", path: duplicateExternal, sha256: sha256(duplicateExternal) }] })]);
  initialize(duplicateDrift);
  prepareAndBind(duplicateDrift, "inspect", "invocation-inspect", "agent/inspect");
  const duplicateResult = writeResult(duplicateDrift, "inspect", "invocation-inspect");
  invoke(["finish", "--run-dir", duplicateDrift.runDir, "--task", "inspect", "--invocation", "invocation-inspect", "--result", duplicateResult]);
  writeFileSync(duplicateExternal, "version two\n");
  assert.equal(invoke(["finish", "--run-dir", duplicateDrift.runDir, "--task", "inspect", "--invocation", "invocation-inspect", "--result", duplicateResult]).idempotent, true);

  const crosswire = fixture([agentTask("inspect")]);
  initialize(crosswire);
  prepareAndBind(crosswire, "inspect", "invocation-inspect", "agent/inspect");
  const crosswireStatePath = join(crosswire.runDir, "workflow-state.json");
  const crosswireState = JSON.parse(readFileSync(crosswireStatePath, "utf8"));
  const inputPath = join(crosswire.runDir, crosswireState.tasks.inspect.input_manifest_path);
  const input = JSON.parse(readFileSync(inputPath, "utf8"));
  input.task_id = "another-task";
  writeJson(inputPath, input);
  crosswireState.tasks.inspect.input_manifest_sha256 = sha256(inputPath);
  writeJson(crosswireStatePath, crosswireState);
  const crosswireResult = writeResult(crosswire, "inspect", "invocation-inspect");
  assert.equal(invoke(["finish", "--run-dir", crosswire.runDir, "--task", "inspect", "--invocation", "invocation-inspect", "--result", crosswireResult], 1).code, "state_drift");

  const finalizeDrift = fixture([agentTask("inspect")]);
  initialize(finalizeDrift);
  prepareAndBind(finalizeDrift, "inspect", "invocation-inspect", "agent/inspect");
  finish(finalizeDrift, "inspect", "invocation-inspect");
  const prompt = join(finalizeDrift.runDir, "review", "prompt.md");
  mkdirSync(dirname(prompt), { recursive: true });
  writeFileSync(prompt, "review\n");
  invoke(["review-prepare", "--run-dir", finalizeDrift.runDir, "--invocation", "review-source-drift", "--prompt", prompt]);
  invoke(["review-bind", "--run-dir", finalizeDrift.runDir, "--invocation", "review-source-drift", "--agent", "agent/final-review"]);
  writeFileSync(finalizeDrift.source, "drift before finalize\n");
  const reviewPath = join(finalizeDrift.runDir, "staging", "review.json");
  writeJson(reviewPath, {});
  assert.equal(invoke(["finalize", "--run-dir", finalizeDrift.runDir, "--review", reviewPath], 1).code, "source_drift");
});

test("fails closed on semantic, permission, and context requirements but skips only optional tasks", () => {
  const required = agentTask("required", [], {
    context_policy: { mode: "recent", turns: 8 },
    requirements: { semantic_capabilities: ["semantic.search"], permissions: ["permission.read"], on_unavailable: "unsupported_runtime" },
  });
  const missing = fixture([required]);
  writeJson(missing.capabilitiesPath, capabilities({
    semantic_capabilities: { "semantic.search": { availability: "supported" } },
    permissions: { "permission.read": { status: "denied", enforcement: "enforced" } },
    context_support: { fresh: true, recent: { supported: true, max_turns: 4 }, all: true },
  }));
  assert.equal(invoke([
    "init", "--manifest", missing.manifestPath, "--capabilities", missing.capabilitiesPath,
    "--translation-review", missing.translationReviewPath, "--translation-review-receipt", missing.translationReviewReceiptPath,
    "--run-dir", missing.runDir,
  ], 1).code, "unsupported_runtime");

  const optionalTask = agentTask("optional", [], {
    required: false,
    requirements: { semantic_capabilities: ["semantic.missing"], permissions: [], on_unavailable: "skip_optional" },
  });
  const optional = fixture([optionalTask]);
  assert.equal(initialize(optional).status, "workflow_execution_complete");
  assert.equal(invoke(["status", "--run-dir", optional.runDir]).counts.skipped, 1);
});

test("validates result contracts at finish and rejects unsupported or unsafe schemas", () => {
  const invalid = fixture([agentTask("inspect", [], {
    result_contract: (() => {
      const contract = defaultResultContract();
      contract.schema.document.required = ["missing_field"];
      contract.schema.canonical_sha256 = canonicalSha256(contract.schema.document);
      return contract;
    })(),
  })]);
  initialize(invalid);
  prepareAndBind(invalid, "inspect", "invocation-inspect", "agent/inspect");
  const resultPath = writeResult(invalid, "inspect", "invocation-inspect");
  assert.equal(invoke(["finish", "--run-dir", invalid.runDir, "--task", "inspect", "--invocation", "invocation-inspect", "--result", resultPath], 1).code, "result_contract_invalid");

  const unsupportedContract = defaultResultContract();
  unsupportedContract.schema.document.format = "email";
  unsupportedContract.schema.canonical_sha256 = canonicalSha256(unsupportedContract.schema.document);
  const unsupported = fixture([agentTask("inspect", [], { result_contract: unsupportedContract })]);
  assert.equal(invoke([
    "init", "--manifest", unsupported.manifestPath, "--capabilities", unsupported.capabilitiesPath,
    "--translation-review", unsupported.translationReviewPath, "--translation-review-receipt", unsupported.translationReviewReceiptPath,
    "--run-dir", unsupported.runDir,
  ], 1).code, "unsupported_result_schema");

  for (const invalidKeyword of [
    { type: "array", uniqueItems: "true" },
    { type: "string", minLength: -1 },
    { type: "string", pattern: "^(a+)+$" },
  ]) {
    const contract = defaultResultContract();
    contract.schema.document.properties.summary = invalidKeyword;
    contract.schema.canonical_sha256 = canonicalSha256(contract.schema.document);
    const malformed = fixture([agentTask("inspect", [], { result_contract: contract })]);
    assert.equal(invoke([
      "init", "--manifest", malformed.manifestPath, "--capabilities", malformed.capabilitiesPath,
      "--translation-review", malformed.translationReviewPath, "--translation-review-receipt", malformed.translationReviewReceiptPath,
      "--run-dir", malformed.runDir,
    ], 1).code, "unsupported_result_schema");
  }
});

test("validates bounded Draft 2020-12 prefixItems tuples without widening additional items", () => {
  const tupleDocument = {
    type: "array",
    prefixItems: [
      { type: "string", const: "alpha" },
      { type: "integer", minimum: 1 },
    ],
    items: false,
    minItems: 2,
    maxItems: 2,
  };
  const tupleTask = () => agentTask("tuple", [], {
    result_contract: jsonArtifactResultContract("artifacts/tuple.json", tupleDocument),
    artifact_paths: ["artifacts/tuple.json"],
    effect: "workspace_write",
  });

  const valid = fixture([tupleTask()]);
  initialize(valid);
  prepareAndBind(valid, "tuple", "invocation-tuple", "agent/tuple");
  assert.equal(finishJsonArtifact(valid, "tuple", "invocation-tuple", "artifacts/tuple.json", ["alpha", 7]).status, "completed");

  for (const value of [["wrong", 7], ["alpha", 7, "extra"]]) {
    const invalid = fixture([tupleTask()]);
    initialize(invalid);
    prepareAndBind(invalid, "tuple", "invocation-tuple", "agent/tuple");
    const artifactPath = join(invalid.runDir, "artifacts/tuple.json");
    writeJson(artifactPath, value);
    const resultPath = join(invalid.runDir, "results/tuple.json");
    writeJson(resultPath, {
      schema_version: "dynamic-workflow-node-result/v1",
      task_id: "tuple",
      invocation_id: "invocation-tuple",
      outcome: "pass",
      summary: "tuple finished",
      artifacts: [{ path: "artifacts/tuple.json", sha256: sha256(artifactPath) }],
      evidence: [],
      errors: [],
    });
    assert.equal(invoke([
      "finish", "--run-dir", invalid.runDir, "--task", "tuple",
      "--invocation", "invocation-tuple", "--result", resultPath,
    ], 1).code, "result_contract_invalid");
  }

  for (const prefixItems of [{ type: "string" }, Array.from({ length: 101 }, () => ({ type: "string" }))]) {
    const malformedDocument = { type: "array", prefixItems, items: false };
    const malformed = fixture([agentTask("tuple", [], {
      result_contract: jsonArtifactResultContract("artifacts/tuple.json", malformedDocument),
      artifact_paths: ["artifacts/tuple.json"],
    })]);
    assert.equal(initialize(malformed, [], 1).code, "unsupported_result_schema");
  }
});

test("accepts a prefixItems-bound typed workflow return", () => {
  const paths = fixture([agentTask("inspect")]);
  const { callPath } = writeWorkflowCall(paths);
  enableBridge(
    paths,
    callPath,
    { kind: "array", items: [{ kind: "literal", value: "alpha" }, { kind: "literal", value: 7 }] },
    {
      type: "array",
      prefixItems: [{ const: "alpha" }, { type: "integer", minimum: 1 }],
      items: false,
      minItems: 2,
      maxItems: 2,
    },
  );
  finalizeSingleTaskRun(paths);
  const output = join(paths.runDir, "workflow-return.json");
  assert.equal(invokeBridge(["materialize", "--call", callPath, "--run-dir", paths.runDir, "--output", output]).status, "workflow_return_ready");
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")).value, ["alpha", 7]);
});

test("uses one semantic identifier grammar in manifests and capability snapshots", () => {
  const invalidManifest = fixture([agentTask("inspect", [], {
    requirements: { semantic_capabilities: ["1semantic.search"], permissions: [], on_unavailable: "unsupported_runtime" },
  })]);
  assert.equal(invoke([
    "init", "--manifest", invalidManifest.manifestPath, "--capabilities", invalidManifest.capabilitiesPath,
    "--translation-review", invalidManifest.translationReviewPath, "--translation-review-receipt", invalidManifest.translationReviewReceiptPath,
    "--run-dir", invalidManifest.runDir,
  ], 1).code, "invalid_schema");

  const invalidSnapshot = fixture([agentTask("inspect")]);
  writeJson(invalidSnapshot.capabilitiesPath, capabilities({
    semantic_capabilities: { "1semantic.search": { availability: "supported" } },
  }));
  assert.equal(invoke([
    "init", "--manifest", invalidSnapshot.manifestPath, "--capabilities", invalidSnapshot.capabilitiesPath,
    "--translation-review", invalidSnapshot.translationReviewPath, "--translation-review-receipt", invalidSnapshot.translationReviewReceiptPath,
    "--run-dir", invalidSnapshot.runDir,
  ], 1).code, "invalid_schema");
});

test("bounds result JSON bytes and JSON Schema evaluation work", () => {
  const oversized = fixture([agentTask("inspect")]);
  initialize(oversized);
  prepareAndBind(oversized, "inspect", "invocation-inspect", "agent/inspect");
  const oversizedResult = join(oversized.runDir, "results", "inspect.json");
  writeJson(oversizedResult, {
    schema_version: "dynamic-workflow-node-result/v1",
    task_id: "inspect",
    invocation_id: "invocation-inspect",
    outcome: "pass",
    summary: "x".repeat(8 * 1024 * 1024),
    artifacts: [],
    evidence: [],
    errors: [],
  });
  assert.equal(invoke([
    "finish", "--run-dir", oversized.runDir, "--task", "inspect",
    "--invocation", "invocation-inspect", "--result", oversizedResult,
  ], 1).code, "resource_limit");

  const document = { $defs: { s0: { const: "never-matches-node-result" } }, $ref: "#/$defs/s20" };
  for (let depth = 1; depth <= 20; depth += 1) {
    document.$defs[`s${depth}`] = {
      anyOf: [
        { $ref: `#/$defs/s${depth - 1}` },
        { $ref: `#/$defs/s${depth - 1}` },
      ],
    };
  }
  const contract = defaultResultContract();
  contract.schema.document = document;
  contract.schema.canonical_sha256 = canonicalSha256(document);
  const bounded = fixture([agentTask("inspect", [], { result_contract: contract })]);
  initialize(bounded);
  prepareAndBind(bounded, "inspect", "invocation-inspect", "agent/inspect");
  const resultPath = writeResult(bounded, "inspect", "invocation-inspect");
  const started = Date.now();
  assert.equal(invoke([
    "finish", "--run-dir", bounded.runDir, "--task", "inspect",
    "--invocation", "invocation-inspect", "--result", resultPath,
  ], 1).code, "result_contract_invalid");
  assert.ok(Date.now() - started < 2000, "schema evaluation budget should stop exponential work");
});

test("hash-pins file-backed result contract schemas", () => {
  const schemaPath = join(mkdtempSync(join(tmpdir(), "dynamic-workflow-schema-")), "contract.any-name");
  writeJson(schemaPath, { type: "object", required: ["summary"], properties: { summary: { type: "string" } } });
  const contract = defaultResultContract();
  contract.schema = { kind: "file", dialect: "https://json-schema.org/draft/2020-12/schema", path: schemaPath, sha256: sha256(schemaPath) };
  const paths = fixture([agentTask("inspect", [], { result_contract: contract })]);
  initialize(paths);
  writeJson(schemaPath, { type: "null" });
  assert.equal(invoke(["status", "--run-dir", paths.runDir], 1).code, "result_contract_drift");
});

test("freezes resume capability receipts without replacing the original snapshot", () => {
  const paths = fixture([agentTask("inspect")]);
  initialize(paths);
  const frozenCapabilityPath = join(paths.runDir, "capabilities.json");
  const originalSha = sha256(frozenCapabilityPath);
  const resumed = capabilities({ max_parallel: 1, observed_at: "2026-08-13T03:00:00Z" });
  writeJson(paths.capabilitiesPath, resumed);
  assert.equal(initialize(paths).effective_max_parallel, 1);
  assert.equal(sha256(frozenCapabilityPath), originalSha);
  const state = JSON.parse(readFileSync(join(paths.runDir, "workflow-state.json"), "utf8"));
  assert.equal(state.capability_receipts.length, 2);
  assert.equal(state.active_capabilities.path, "capability-receipts/0002.json");
  assert.equal(sha256(join(paths.runDir, state.active_capabilities.path)), state.active_capabilities.sha256);
  writeJson(paths.capabilitiesPath, capabilities({ observed_at: "2026-08-13T02:00:00Z" }));
  assert.equal(invoke([
    "init", "--manifest", paths.manifestPath, "--capabilities", paths.capabilitiesPath,
    "--translation-review", paths.translationReviewPath, "--translation-review-receipt", paths.translationReviewReceiptPath,
    "--run-dir", paths.runDir,
  ], 1).code, "stale_capability_snapshot");
  assert.equal(JSON.parse(readFileSync(join(paths.runDir, "workflow-state.json"), "utf8")).capability_receipts.length, 2);
  writeJson(paths.capabilitiesPath, capabilities({ context_support: { fresh: false, recent: { supported: true, max_turns: 100 }, all: true }, observed_at: "2026-08-13T04:00:00Z" }));
  const unavailable = invoke([
    "init", "--manifest", paths.manifestPath, "--capabilities", paths.capabilitiesPath,
    "--translation-review", paths.translationReviewPath, "--translation-review-receipt", paths.translationReviewReceiptPath,
    "--run-dir", paths.runDir,
  ]);
  assert.equal(unavailable.status, "workflow_incomplete");
  let resumedState = JSON.parse(readFileSync(join(paths.runDir, "workflow-state.json"), "utf8"));
  assert.equal(resumedState.capability_receipts.length, 3);
  assert.equal(resumedState.active_capabilities.path, "capability-receipts/0003.json");
  assert.deepEqual(invoke(["ready", "--run-dir", paths.runDir]).ready, []);
  const assessmentDrift = JSON.parse(JSON.stringify(resumedState));
  assessmentDrift.tasks.inspect.capability_assessment = { available: true, reasons: [] };
  writeJson(join(paths.runDir, "workflow-state.json"), assessmentDrift);
  assert.equal(invoke(["ready", "--run-dir", paths.runDir], 1).code, "state_drift");
  writeJson(join(paths.runDir, "workflow-state.json"), resumedState);
  const beforeRecoveryState = JSON.parse(JSON.stringify(resumedState));

  writeJson(paths.capabilitiesPath, capabilities({ observed_at: "2026-08-13T05:00:00Z" }));
  assert.equal(initialize(paths).status, "workflow_ready");
  resumedState = JSON.parse(readFileSync(join(paths.runDir, "workflow-state.json"), "utf8"));
  assert.equal(resumedState.capability_receipts.length, 4);
  assert.deepEqual(invoke(["ready", "--run-dir", paths.runDir]).ready.map((task) => task.id), ["inspect"]);
  writeJson(join(paths.runDir, "workflow-state.json"), beforeRecoveryState);
  assert.equal(invoke(["status", "--run-dir", paths.runDir], 1).code, "state_drift");
});

test("keeps manifest and capability snapshot parity for collaboration, recent context, and date-time", () => {
  const missingNative = fixture([agentTask("inspect")]);
  const missingNativeManifest = JSON.parse(readFileSync(missingNative.manifestPath, "utf8"));
  missingNativeManifest.required_capabilities = ["spawn", "collect_or_wait", "stable_handle"];
  writeJson(missingNative.manifestPath, missingNativeManifest);
  writeTranslationReview(missingNative);
  assert.equal(invoke([
    "init", "--manifest", missingNative.manifestPath, "--capabilities", missingNative.capabilitiesPath,
    "--translation-review", missingNative.translationReviewPath, "--translation-review-receipt", missingNative.translationReviewReceiptPath,
    "--run-dir", missingNative.runDir,
  ], 1).code, "invalid_schema");

  for (const recent of [
    { supported: false, max_turns: 3 },
    { supported: true, max_turns: null },
  ]) {
    const invalidRecent = fixture([agentTask("inspect")]);
    writeJson(invalidRecent.capabilitiesPath, capabilities({
      context_support: { fresh: true, recent, all: true },
    }));
    assert.equal(invoke([
      "init", "--manifest", invalidRecent.manifestPath, "--capabilities", invalidRecent.capabilitiesPath,
      "--translation-review", invalidRecent.translationReviewPath, "--translation-review-receipt", invalidRecent.translationReviewReceiptPath,
      "--run-dir", invalidRecent.runDir,
    ], 1).code, "invalid_schema");
  }

  const offset = fixture([agentTask("inspect")]);
  writeJson(offset.capabilitiesPath, capabilities({ observed_at: "2026-08-13T09:00:00+09:00" }));
  assert.equal(initialize(offset).status, "workflow_ready");

  const invalidDescription = fixture([agentTask("inspect")]);
  const invalidDescriptionManifest = JSON.parse(readFileSync(invalidDescription.manifestPath, "utf8"));
  invalidDescriptionManifest.description = { text: "not a string" };
  writeJson(invalidDescription.manifestPath, invalidDescriptionManifest);
  writeTranslationReview(invalidDescription);
  assert.equal(invoke([
    "init", "--manifest", invalidDescription.manifestPath, "--capabilities", invalidDescription.capabilitiesPath,
    "--translation-review", invalidDescription.translationReviewPath, "--translation-review-receipt", invalidDescription.translationReviewReceiptPath,
    "--run-dir", invalidDescription.runDir,
  ], 1).code, "invalid_schema");
});

test("resume reevaluates pending task requirements but does not require capabilities used only by completed tasks", () => {
  const task = agentTask("inspect", [], {
    requirements: { semantic_capabilities: ["semantic.inspect"], permissions: [], on_unavailable: "unsupported_runtime" },
  });
  const paths = fixture([task]);
  writeJson(paths.capabilitiesPath, capabilities({
    semantic_capabilities: { "semantic.inspect": { availability: "supported" } },
  }));
  initialize(paths);
  prepareAndBind(paths, "inspect", "invocation-inspect", "agent/inspect");
  finish(paths, "inspect", "invocation-inspect");
  writeJson(paths.capabilitiesPath, capabilities({
    observed_at: "2026-08-13T03:00:00Z",
    semantic_capabilities: { "semantic.inspect": { availability: "unsupported", reason: "no longer callable" } },
  }));
  const resumed = initialize(paths);
  assert.equal(resumed.status, "workflow_execution_complete");
  assert.equal(JSON.parse(readFileSync(join(paths.runDir, "workflow-state.json"), "utf8")).capability_receipts.length, 2);
});

test("rejects capability receipt metadata drift and active receipt rollback", () => {
  for (const mutation of ["observed_at", "active_receipt"]) {
    const paths = fixture([agentTask("inspect")]);
    initialize(paths);
    writeJson(paths.capabilitiesPath, capabilities({ observed_at: "2026-08-13T03:00:00Z" }));
    initialize(paths);
    const statePath = join(paths.runDir, "workflow-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (mutation === "observed_at") state.capability_receipts[1].observed_at = "2026-08-12T23:00:00Z";
    else state.active_capabilities = { path: state.capability_receipts[0].path, sha256: state.capability_receipts[0].sha256 };
    writeJson(statePath, state);
    assert.equal(invoke(["status", "--run-dir", paths.runDir], 1).code, "state_drift");
  }
});

test("treats multi_agent_v2 and collaboration_modes as nested diagnostics only", () => {
  const paths = fixture([agentTask("inspect")]);
  const snapshot = capabilities();
  snapshot.multi_agent_v2 = "diagnostic_only";
  writeJson(paths.capabilitiesPath, snapshot);
  assert.equal(invoke([
    "init", "--manifest", paths.manifestPath, "--capabilities", paths.capabilitiesPath,
    "--translation-review", paths.translationReviewPath, "--translation-review-receipt", paths.translationReviewReceiptPath,
    "--run-dir", paths.runDir,
  ], 1).code, "invalid_schema");
});

test("checks max_agent_runs before creating an invocation input receipt", () => {
  const paths = fixture([agentTask("first"), agentTask("second")]);
  initialize(paths, ["--max-agent-runs", "1"]);
  prepareAndBind(paths, "first", "invocation-first", "agent/first");
  finish(paths, "first", "invocation-first");
  assert.equal(invoke(["status", "--run-dir", paths.runDir]).status, "workflow_incomplete");
  const ready = invoke(["ready", "--run-dir", paths.runDir]);
  assert.equal(ready.capacity, 0);
  assert.deepEqual(ready.ready, []);
  assert.equal(invoke(["prepare", "--run-dir", paths.runDir, "--task", "second", "--invocation", "invocation-second"], 1).code, "budget_exceeded");
  assert.equal(existsSync(join(paths.runDir, "inputs", "second.json")), false);
});

test("bridges an arbitrary-named caller Workflow call into a typed return only after final review pass", () => {
  const paths = fixture([agentTask("inspect")]);
  const { callPath } = writeWorkflowCall(paths);
  assert.equal(invokeBridge(["validate-call", "--call", callPath]).status, "workflow_call_valid");
  enableBridge(paths, callPath);
  finalizeSingleTaskRun(paths);
  const frozenCallPath = join(paths.runDir, "translation", "workflow-call.json");
  assert.deepEqual(readFileSync(frozenCallPath), readFileSync(callPath));
  const frozenReceipt = JSON.parse(readFileSync(join(paths.runDir, "translation-review-receipt.json"), "utf8"));
  assert.equal(frozenReceipt.workflow_call.receipt.path, "translation/workflow-call.json");
  assert.equal(frozenReceipt.workflow_call.receipt.sha256, sha256(callPath));
  const state = JSON.parse(readFileSync(join(paths.runDir, "workflow-state.json"), "utf8"));
  assert.equal(state.workflow_call_sha256, sha256(callPath));
  assert.equal(state.events[0].details.workflow_call_sha256, sha256(callPath));
  const output = join(paths.runDir, "workflow-return.json");
  const materialized = invokeBridge(["materialize", "--call", callPath, "--run-dir", paths.runDir, "--output", output]);
  assert.equal(materialized.status, "workflow_return_ready");
  assert.equal(materialized.caller_continuation_allowed, true);
  const value = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(value.schema_version, "dynamic-workflow-return/v1");
  assert.equal(value.value, "inspect finished");
  assert.equal(value.receipt.workflow_call_sha256, sha256(callPath));
  assert.equal(value.receipt.manifest_sha256, sha256(join(paths.runDir, "workflow.manifest.json")));
  assert.equal(value.receipt.final_review_sha256, sha256(join(paths.runDir, "final-review.json")));
  assert.equal(value.receipt.value_canonical_sha256, canonicalSha256("inspect finished"));
  assert.deepEqual(value.caller_continuation.post_workflow, ["consume typed workflow return"]);
  assert.deepEqual(value.caller_continuation.human_gates, ["caller publication approval"]);
  assert.equal(invokeBridge(["materialize", "--call", callPath, "--run-dir", paths.runDir, "--output", output]).idempotent, true);
  for (const invalidTime of [undefined, "2026-08-21t00:10:00z", "2026-08-21T00:10:60Z"]) {
    const invalidReturn = JSON.parse(JSON.stringify(value));
    if (invalidTime === undefined) delete invalidReturn.receipt.materialized_at;
    else invalidReturn.receipt.materialized_at = invalidTime;
    writeJson(output, invalidReturn);
    assert.equal(invokeBridge(["materialize", "--call", callPath, "--run-dir", paths.runDir, "--output", output], 1).code, "return_schema_invalid");
  }
});

test("requires exact workflow-call lineage in bridge translation review before dispatch", () => {
  const missing = fixture([agentTask("inspect")]);
  const { callPath: missingCall } = writeWorkflowCall(missing);
  enableBridge(missing, missingCall);
  const missingError = invoke([
    "init", "--manifest", missing.manifestPath, "--capabilities", missing.capabilitiesPath,
    "--translation-review", missing.translationReviewPath, "--translation-review-receipt", missing.translationReviewReceiptPath,
    "--run-dir", missing.runDir,
  ], 1);
  assert.equal(missingError.code, "invalid_arguments");

  const inputMissing = fixture([agentTask("inspect")]);
  const { callPath: inputMissingCall } = writeWorkflowCall(inputMissing);
  enableBridge(inputMissing, inputMissingCall);
  const input = JSON.parse(readFileSync(inputMissing.translationReviewInputPath, "utf8"));
  delete input.workflow_call;
  writeJson(inputMissing.translationReviewInputPath, input);
  const inputReceipt = JSON.parse(readFileSync(inputMissing.translationReviewReceiptPath, "utf8"));
  inputReceipt.input_manifest.sha256 = sha256(inputMissing.translationReviewInputPath);
  writeJson(inputMissing.translationReviewReceiptPath, inputReceipt);
  assert.equal(initialize(inputMissing, [], 1).code, "translation_review_crosswire");

  const receiptWire = fixture([agentTask("inspect")]);
  const { callPath: receiptCall } = writeWorkflowCall(receiptWire);
  enableBridge(receiptWire, receiptCall);
  const receipt = JSON.parse(readFileSync(receiptWire.translationReviewReceiptPath, "utf8"));
  receipt.workflow_call.caller_phase_ownership.post_workflow = ["import caller continuation into workflow"];
  writeJson(receiptWire.translationReviewReceiptPath, receipt);
  assert.equal(initialize(receiptWire, [], 1).code, "translation_review_crosswire");

  const nativeWire = fixture([agentTask("inspect")]);
  const { callPath: nativeCall } = writeWorkflowCall(nativeWire);
  enableBridge(nativeWire, nativeCall);
  const nativeInput = JSON.parse(readFileSync(nativeWire.translationReviewInputPath, "utf8"));
  nativeInput.workflow_call.native_workflow_observation.observed_at = "2026-08-13T00:00:01Z";
  writeJson(nativeWire.translationReviewInputPath, nativeInput);
  const nativeReceipt = JSON.parse(readFileSync(nativeWire.translationReviewReceiptPath, "utf8"));
  nativeReceipt.input_manifest.sha256 = sha256(nativeWire.translationReviewInputPath);
  writeJson(nativeWire.translationReviewReceiptPath, nativeReceipt);
  assert.equal(initialize(nativeWire, [], 1).code, "translation_review_crosswire");
});

test("controller enforces the same caller and source bindings as the bridge before dispatch", () => {
  const paths = fixture([agentTask("inspect")]);
  const { callPath } = writeWorkflowCall(paths);
  const call = JSON.parse(readFileSync(callPath, "utf8"));
  call.invoking_skill.skill_md = { path: paths.source, sha256: sha256(paths.source) };
  writeJson(callPath, call);
  enableBridge(paths, callPath);
  assert.equal(initialize(paths, [], 1).code, "caller_crosswire");
  assert.equal(existsSync(join(paths.runDir, "workflow-state.json")), false);
});

test("rejects missing or drifted frozen workflow-call lineage", () => {
  const missing = fixture([agentTask("inspect")]);
  const { callPath: missingCall } = writeWorkflowCall(missing);
  enableBridge(missing, missingCall);
  initialize(missing);
  renameSync(join(missing.runDir, "translation", "workflow-call.json"), join(missing.runDir, "translation", "workflow-call.removed"));
  assert.equal(invoke(["status", "--run-dir", missing.runDir], 1).code, "run_missing");

  const drift = fixture([agentTask("inspect")]);
  const { callPath: driftCall } = writeWorkflowCall(drift);
  enableBridge(drift, driftCall);
  initialize(drift);
  const frozenPath = join(drift.runDir, "translation", "workflow-call.json");
  const frozen = JSON.parse(readFileSync(frozenPath, "utf8"));
  frozen.caller_phase_ownership.human_gates = ["substituted gate"];
  writeJson(frozenPath, frozen);
  assert.equal(invoke(["status", "--run-dir", drift.runDir], 1).code, "workflow_call_crosswire");
});

test("prepares a call deterministically from caller-owned JSON inputs without filename semantics", () => {
  const paths = fixture([agentTask("inspect")]);
  writeFileSync(join(paths.root, "SKILL.md"), "---\nname: prepared-bridge-fixture\n---\n");
  const argsPath = join(paths.root, "caller-args.data");
  const phasesPath = join(paths.root, "caller-phases.data");
  const observationPath = join(paths.root, "runtime-observation.data");
  const outputPath = join(paths.bridgeDir, "arbitrary-call.receipt");
  writeJson(argsPath, { z: 1, a: { nested: true } });
  writeJson(phasesPath, { owner: "caller_skill", pre_workflow: ["prepare"], post_workflow: ["continue"], human_gates: ["publish"] });
  writeJson(observationPath, { attempted: false, available: false, observed_at: "2026-08-13T00:00:00Z", evidence: ["native Workflow absent"] });
  const args = [
    "prepare-call", "--caller-skill-root", paths.root,
    "--declared-script-path", "[SKILL_DIR]/arbitrary source.name",
    "--args", argsPath,
    "--phase-ownership", phasesPath,
    "--native-observation", observationPath,
    "--call-id", "prepared-call",
    "--output", outputPath,
  ];
  const prepared = invokeBridge(args);
  assert.equal(prepared.status, "workflow_call_ready");
  assert.equal(prepared.idempotent, false);
  assert.equal(invokeBridge(args).idempotent, true);
  const call = JSON.parse(readFileSync(outputPath, "utf8"));
  assert.equal(call.arguments.canonical_sha256, canonicalSha256({ z: 1, a: { nested: true } }));
  assert.equal(call.workflow.resolved_source.path, paths.source);
  assert.equal(call.workflow.resolved_source.sha256, sha256(paths.source));

  const callerAlias = join(paths.sessionRoot, "caller-alias");
  symlinkSync(paths.root, callerAlias, "dir");
  const aliasOutput = join(paths.bridgeDir, "alias-call.receipt");
  const aliasPrepared = invokeBridge([
    "prepare-call", "--caller-skill-root", callerAlias,
    "--declared-script-path", "[SKILL_DIR]/arbitrary source.name",
    "--args", argsPath,
    "--phase-ownership", phasesPath,
    "--native-observation", observationPath,
    "--call-id", "alias-call",
    "--output", aliasOutput,
  ]);
  assert.equal(aliasPrepared.invoking_skill_root, paths.root);
  assert.equal(JSON.parse(readFileSync(aliasOutput, "utf8")).invoking_skill.root, paths.root);

  const outputAlias = join(paths.bridgeDir, "output-into-caller");
  symlinkSync(paths.root, outputAlias, "dir");
  const escapedOutputArgs = [...args];
  escapedOutputArgs[escapedOutputArgs.indexOf("--call-id") + 1] = "escaped-output";
  escapedOutputArgs[escapedOutputArgs.indexOf("--output") + 1] = join(outputAlias, "must-not-write.json");
  assert.equal(invokeBridge(escapedOutputArgs, 1).code, "unsafe_path");
  assert.equal(existsSync(join(paths.root, "must-not-write.json")), false);

  writeJson(observationPath, { attempted: true, available: false, observed_at: "2026-08-13T00:00:01Z", evidence: ["Native Workflow invocation failed."] });
  const attemptedArgs = args.map((item, index) => args[index - 1] === "--output" ? join(paths.bridgeDir, "attempted-call.receipt") : item);
  assert.equal(invokeBridge(attemptedArgs, 1).code, "native_workflow_attempted");
});

test("publishes one divergent workflow-call receipt under concurrent prepare", async () => {
  const paths = fixture([agentTask("inspect")]);
  writeFileSync(join(paths.root, "SKILL.md"), "---\nname: concurrent-bridge-fixture\n---\n");
  const phasesPath = join(paths.root, "caller-phases.data");
  const observationPath = join(paths.root, "runtime-observation.data");
  const outputPath = join(paths.bridgeDir, "concurrent-call.receipt");
  writeJson(phasesPath, { owner: "caller_skill", pre_workflow: [], post_workflow: ["continue"], human_gates: [] });
  writeJson(observationPath, { attempted: false, available: false, observed_at: "2026-08-13T00:00:00Z", evidence: ["native Workflow absent"] });
  const calls = Array.from({ length: 20 }, (_, index) => {
    const argsPath = join(paths.root, `caller-args-${index}.data`);
    writeJson(argsPath, { value: index });
    return invokeBridgeAsync([
      "prepare-call", "--caller-skill-root", paths.root,
      "--declared-script-path", "[SKILL_DIR]/arbitrary source.name",
      "--args", argsPath,
      "--phase-ownership", phasesPath,
      "--native-observation", observationPath,
      "--call-id", "concurrent-call",
      "--output", outputPath,
    ]);
  });
  const results = await Promise.all(calls);
  assert.equal(results.filter((result) => result.status === 0).length, 1);
  for (const result of results.filter((candidate) => candidate.status !== 0)) {
    assert.equal(JSON.parse(result.stderr).code, "workflow_call_conflict");
  }
  assert.equal(invokeBridge(["validate-call", "--call", outputPath]).status, "workflow_call_valid");
});

test("materializes bounded literal, argument, task-result, artifact, object, and array return expressions", () => {
  const paths = fixture([agentTask("inspect", [], {
    effect: "workspace_write",
    artifact_paths: ["artifacts/action-package.json"],
  })]);
  const { callPath } = writeWorkflowCall(paths);
  const expression = {
    kind: "object",
    entries: {
      literal: { kind: "literal", value: true },
      topic: { kind: "argument", key: "topic", pointer: "" },
      summary: { kind: "task_result", task_id: "inspect", pointer: "/summary" },
      action: { kind: "artifact", task_id: "inspect", path: "artifacts/action-package.json", pointer: "/action" },
      nested: { kind: "array", items: [{ kind: "literal", value: 1 }, { kind: "argument", key: "topic", pointer: "" }] },
    },
  };
  const schema = {
    type: "object",
    required: ["literal", "topic", "summary", "action", "nested"],
    properties: {
      literal: { const: true },
      topic: { type: "string" },
      summary: { type: "string" },
      action: { const: "publish" },
      nested: { type: "array", minItems: 2, maxItems: 2 },
    },
  };
  enableBridge(paths, callPath, expression, schema);
  finalizeSingleTaskRun(paths);
  const output = join(paths.runDir, "workflow-return.json");
  invokeBridge(["materialize", "--call", callPath, "--run-dir", paths.runDir, "--output", output]);
  const value = JSON.parse(readFileSync(output, "utf8")).value;
  assert.deepEqual(value, {
    literal: true,
    topic: "portable execution",
    summary: "inspect finished",
    action: "publish",
    nested: [1, "portable execution"],
  });
});

test("resolves [SKILL_DIR], relative, and absolute sources only inside the invoking skill root", () => {
  for (const declared of ["[SKILL_DIR]/arbitrary source.name", "arbitrary source.name"] ) {
    const paths = fixture([agentTask("inspect")]);
    const { call, callPath } = writeWorkflowCall(paths);
    call.workflow.declared_script_path = declared;
    writeJson(callPath, call);
    assert.equal(invokeBridge(["validate-call", "--call", callPath]).status, "workflow_call_valid");
  }

  const escaped = fixture([agentTask("inspect")]);
  const { call: escapedCall, callPath: escapedPath } = writeWorkflowCall(escaped);
  const outside = join(escaped.root, "..", "outside.workflow");
  writeFileSync(outside, "outside\n");
  escapedCall.workflow = { declared_script_path: "../outside.workflow", resolved_source: { path: outside, sha256: sha256(outside) } };
  writeJson(escapedPath, escapedCall);
  assert.equal(invokeBridge(["validate-call", "--call", escapedPath], 1).code, "unsafe_path");

  const ambiguous = fixture([agentTask("inspect")]);
  const { call: ambiguousCall, callPath: ambiguousPath } = writeWorkflowCall(ambiguous);
  ambiguousCall.workflow.declared_script_path = `scripts/[SKILL_DIR]/${ambiguous.source}`;
  writeJson(ambiguousPath, ambiguousCall);
  assert.equal(invokeBridge(["validate-call", "--call", ambiguousPath], 1).code, "ambiguous_source_path");

  const missing = fixture([agentTask("inspect")]);
  const { call: missingCall, callPath: missingPath } = writeWorkflowCall(missing);
  missingCall.workflow = { declared_script_path: "missing.workflow", resolved_source: { path: join(missing.root, "missing.workflow"), sha256: "0".repeat(64) } };
  writeJson(missingPath, missingCall);
  assert.equal(invokeBridge(["validate-call", "--call", missingPath], 1).code, "input_missing");

  const linked = fixture([agentTask("inspect")]);
  const { call: linkedCall, callPath: linkedPath } = writeWorkflowCall(linked);
  const sourceLink = join(linked.root, "linked.workflow");
  symlinkSync(linked.source, sourceLink);
  linkedCall.workflow = { declared_script_path: "linked.workflow", resolved_source: { path: sourceLink, sha256: sha256(linked.source) } };
  writeJson(linkedPath, linkedCall);
  assert.equal(invokeBridge(["validate-call", "--call", linkedPath], 1).code, "unsafe_path");
});

test("rejects native availability and caller, source, or exact argument drift before agent dispatch", () => {
  const attempted = fixture([agentTask("inspect")]);
  const { call: attemptedCall, callPath: attemptedPath } = writeWorkflowCall(attempted);
  attemptedCall.native_workflow_observation.attempted = true;
  attemptedCall.native_workflow_observation.evidence = ["Native Workflow invocation failed before bridge fallback."];
  writeJson(attemptedPath, attemptedCall);
  assert.equal(invokeBridge(["validate-call", "--call", attemptedPath], 1).code, "native_workflow_attempted");

  const native = fixture([agentTask("inspect")]);
  const { call: nativeCall, callPath: nativePath } = writeWorkflowCall(native);
  nativeCall.native_workflow_observation.available = true;
  writeJson(nativePath, nativeCall);
  assert.equal(invokeBridge(["validate-call", "--call", nativePath], 1).code, "native_workflow_available");

  const caller = fixture([agentTask("inspect")]);
  const { callPath: callerPath } = writeWorkflowCall(caller);
  writeFileSync(join(caller.root, "SKILL.md"), "changed caller skill\n");
  assert.equal(invokeBridge(["validate-call", "--call", callerPath], 1).code, "caller_drift");

  const source = fixture([agentTask("inspect")]);
  const { callPath: sourcePath } = writeWorkflowCall(source);
  writeFileSync(source.source, "changed source\n");
  assert.equal(invokeBridge(["validate-call", "--call", sourcePath], 1).code, "source_drift");

  const argumentsDrift = fixture([agentTask("inspect")]);
  const { call: argumentsCall, callPath: argumentsPath } = writeWorkflowCall(argumentsDrift);
  argumentsCall.arguments.value.topic = "changed without rehash";
  writeJson(argumentsPath, argumentsCall);
  assert.equal(invokeBridge(["validate-call", "--call", argumentsPath], 1).code, "arguments_drift");
});

test("rejects call, source, arguments, producer, pointer, and schema cross-wires", () => {
  const callWire = fixture([agentTask("inspect")]);
  const { call: callWireValue, callPath: callWirePath } = writeWorkflowCall(callWire);
  enableBridge(callWire, callWirePath);
  finalizeSingleTaskRun(callWire);
  callWireValue.caller_phase_ownership.post_workflow = ["substituted continuation"];
  writeJson(callWirePath, callWireValue);
  assert.equal(invokeBridge(["materialize", "--call", callWirePath, "--run-dir", callWire.runDir, "--output", join(callWire.runDir, "workflow-return.json")], 1).code, "workflow_call_crosswire");

  const sourceWire = fixture([agentTask("inspect")]);
  const { callPath: sourceWireCall } = writeWorkflowCall(sourceWire);
  enableBridge(sourceWire, sourceWireCall);
  const alternateSource = join(sourceWire.root, "alternate arbitrary source");
  writeFileSync(alternateSource, "alternate workflow source\n");
  const sourceWireManifest = JSON.parse(readFileSync(sourceWire.manifestPath, "utf8"));
  sourceWireManifest.source = { path: alternateSource, sha256: sha256(alternateSource), format: "source-text" };
  writeJson(sourceWire.manifestPath, sourceWireManifest);
  const originalSource = sourceWire.source;
  sourceWire.source = alternateSource;
  writeTranslationReview(sourceWire);
  sourceWire.source = originalSource;
  assert.equal(initialize(sourceWire, [], 1).code, "workflow_call_crosswire");

  const argumentWire = fixture([agentTask("inspect")]);
  const { callPath: argumentWireCall } = writeWorkflowCall(argumentWire);
  enableBridge(argumentWire, argumentWireCall, { kind: "task_result", task_id: "inspect", pointer: "/summary" }, { type: "string" }, { arguments: { topic: "different manifest arguments" } });
  assert.equal(initialize(argumentWire, [], 1).code, "arguments_crosswire");

  const pointer = fixture([agentTask("inspect")]);
  const { callPath: pointerCall } = writeWorkflowCall(pointer);
  enableBridge(pointer, pointerCall, { kind: "task_result", task_id: "inspect", pointer: "/not-present" });
  finalizeSingleTaskRun(pointer);
  assert.equal(invokeBridge(["materialize", "--call", pointerCall, "--run-dir", pointer.runDir, "--output", join(pointer.runDir, "workflow-return.json")], 1).code, "return_pointer_missing");

  const producer = fixture([agentTask("inspect")]);
  const { callPath: producerCall } = writeWorkflowCall(producer);
  enableBridge(producer, producerCall, { kind: "task_result", task_id: "unknown", pointer: "" });
  assert.equal(initialize(producer, [], 1).code, "invalid_graph");

  const schema = fixture([agentTask("inspect")]);
  const { callPath: schemaCall } = writeWorkflowCall(schema);
  enableBridge(schema, schemaCall, { kind: "task_result", task_id: "inspect", pointer: "/summary" }, { type: "number" });
  finalizeSingleTaskRun(schema);
  assert.equal(invokeBridge(["materialize", "--call", schemaCall, "--run-dir", schema.runDir, "--output", join(schema.runDir, "workflow-return.json")], 1).code, "return_schema_invalid");
});

test("never emits a success return for incomplete, revise, or stop-with-unknowns reviews", () => {
  const incomplete = fixture([agentTask("inspect")]);
  const { callPath: incompleteCall } = writeWorkflowCall(incomplete);
  enableBridge(incomplete, incompleteCall);
  initialize(incomplete);
  const incompleteOutput = join(incomplete.runDir, "workflow-return.json");
  assert.equal(invokeBridge(["materialize", "--call", incompleteCall, "--run-dir", incomplete.runDir, "--output", incompleteOutput], 1).code, "input_missing");
  assert.equal(existsSync(incompleteOutput), false);

  for (const verdict of ["revise", "stop_with_unknowns"]) {
    const paths = fixture([agentTask("inspect")]);
    const { callPath } = writeWorkflowCall(paths);
    enableBridge(paths, callPath);
    finalizeSingleTaskRun(paths, verdict);
    const output = join(paths.runDir, "workflow-return.json");
    assert.equal(invokeBridge(["materialize", "--call", callPath, "--run-dir", paths.runDir, "--output", output], 1).code, "run_invalid");
    assert.equal(existsSync(output), false);
  }
});

test("detects producer, final-review, and return-schema drift after completion", () => {
  const producer = fixture([agentTask("inspect")]);
  const { callPath: producerCall } = writeWorkflowCall(producer);
  enableBridge(producer, producerCall);
  finalizeSingleTaskRun(producer);
  writeJson(join(producer.runDir, "results", "inspect.json"), { substituted: true });
  assert.equal(invokeBridge(["materialize", "--call", producerCall, "--run-dir", producer.runDir, "--output", join(producer.runDir, "workflow-return.json")], 1).code, "run_invalid");

  const review = fixture([agentTask("inspect")]);
  const { callPath: reviewCall } = writeWorkflowCall(review);
  enableBridge(review, reviewCall);
  finalizeSingleTaskRun(review);
  const reviewPath = join(review.runDir, "final-review.json");
  const changedReview = JSON.parse(readFileSync(reviewPath, "utf8"));
  changedReview.summary = "substituted review";
  writeJson(reviewPath, changedReview);
  assert.equal(invokeBridge(["materialize", "--call", reviewCall, "--run-dir", review.runDir, "--output", join(review.runDir, "workflow-return.json")], 1).code, "run_invalid");

  const schema = fixture([agentTask("inspect")]);
  const { callPath: schemaCall } = writeWorkflowCall(schema);
  const schemaPath = join(schema.root, "return-schema.json");
  writeJson(schemaPath, { type: "string" });
  enableBridge(schema, schemaCall);
  const manifestValue = JSON.parse(readFileSync(schema.manifestPath, "utf8"));
  manifestValue.return_binding.schema = {
    kind: "file",
    dialect: "https://json-schema.org/draft/2020-12/schema",
    path: schemaPath,
    sha256: sha256(schemaPath),
  };
  writeJson(schema.manifestPath, manifestValue);
  writeTranslationReview(schema);
  finalizeSingleTaskRun(schema);
  writeJson(schemaPath, { type: "number" });
  assert.equal(invokeBridge(["materialize", "--call", schemaCall, "--run-dir", schema.runDir, "--output", join(schema.runDir, "workflow-return.json")], 1).code, "run_invalid");
});
