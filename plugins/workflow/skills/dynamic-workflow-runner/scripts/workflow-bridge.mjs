#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  linkSync,
  openSync,
  realpathSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JSON_SCHEMA_DIALECT, inspectJsonSchema, isCanonicalDateTime, jsonSchemaErrors } from "./json-schema-subset.mjs";

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])*)*$/u;
const RETURN_FILE = "workflow-return.json";
const CONTROL_SCRIPT = fileURLToPath(new URL("./workflow-control.mjs", import.meta.url));
const RUNNER_SKILL_ROOT = realpathSync(resolve(fileURLToPath(new URL("..", import.meta.url))));
const WORKFLOW_RETURN_SCHEMA = fileURLToPath(new URL("../schemas/workflow-return.schema.json", import.meta.url));

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(condition, code, message) {
  if (!condition) throw new BridgeError(code, message);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    fail(key?.startsWith("--") && index + 1 < rest.length, "invalid_arguments", `Invalid option: ${key}`);
    options[key.slice(2)] = rest[index + 1];
  }
  return { command, options };
}

function requireOption(options, key) {
  fail(typeof options[key] === "string" && options[key].length > 0, "invalid_arguments", `Missing --${key}`);
  return options[key];
}

function readBounded(path) {
  const descriptor = openSync(path, "r");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_JSON_BYTES + 1 - total));
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      fail(total <= MAX_JSON_BYTES, "resource_limit", `${path} exceeds JSON size limit`);
      chunks.push(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  return Buffer.concat(chunks, total);
}

function readJsonSnapshot(path) {
  try {
    const bytes = readBounded(path);
    return { value: JSON.parse(bytes.toString("utf8")), sha256: sha256Bytes(bytes) };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("invalid_json", `${path}: ${error.message}`);
  }
}

function readJson(path) {
  return readJsonSnapshot(path).value;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Text(text) {
  return sha256Bytes(Buffer.from(text));
}

function sha256File(path) {
  const descriptor = openSync(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function assertExactKeys(value, allowed, label) {
  fail(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_schema", `${label} must be an object`);
  for (const key of Object.keys(value)) fail(allowed.has(key), "invalid_schema", `${label} has unknown field ${key}`);
}

function assertString(value, label, maximum = 4096) {
  fail(typeof value === "string" && value.length > 0 && value.length <= maximum, "invalid_schema", `${label} must be a bounded non-empty string`);
}

function assertSha256(value, label) {
  fail(SHA256_PATTERN.test(value ?? ""), "invalid_schema", `${label} must be lowercase SHA-256`);
}

function assertDateTime(value, label) {
  assertString(value, label);
  fail(isCanonicalDateTime(value), "invalid_schema", `${label} must be canonical RFC 3339 date-time`);
}

function assertRegularNoSymlink(path, label) {
  fail(existsSync(path), "input_missing", `${label} does not exist: ${path}`);
  fail(!lstatSync(path).isSymbolicLink() && statSync(path).isFile(), "unsafe_path", `${label} must be a regular non-symlink file: ${path}`);
}

function assertNoSymlinkComponents(path, boundary = "/") {
  let current = resolve(path);
  const stop = resolve(boundary);
  while (true) {
    if (existsSync(current)) fail(!lstatSync(current).isSymbolicLink(), "unsafe_path", `Path has a symlink component: ${current}`);
    if (current === stop) return;
    const parent = dirname(current);
    fail(parent !== current, "unsafe_path", `${path} does not descend from ${boundary}`);
    current = parent;
  }
}

function assertInside(root, path, label) {
  const relation = relative(root, path);
  fail(relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation), "unsafe_path", `${label} escapes invoking skill root`);
}

function canonicalPath(path) {
  const absolute = resolve(path);
  let existing = absolute;
  const missing = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    fail(parent !== existing, "unsafe_path", `Cannot resolve a trusted ancestor for ${path}`);
    missing.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...missing);
}

function pathsOverlap(left, right) {
  const a = canonicalPath(left).split(sep).join("/").normalize("NFD").toLowerCase();
  const b = canonicalPath(right).split(sep).join("/").normalize("NFD").toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function expectedSourcePath(root, declared) {
  fail(!declared.includes("\0"), "unsafe_path", "declared_script_path contains NUL");
  const marker = "[SKILL_DIR]";
  if (declared.startsWith(marker)) {
    fail(declared === marker || declared.startsWith(`${marker}/`) || declared.startsWith(`${marker}\\`), "ambiguous_source_path", "[SKILL_DIR] must be a complete leading path segment");
    fail(declared.indexOf(marker, marker.length) === -1, "ambiguous_source_path", "declared_script_path contains multiple [SKILL_DIR] markers");
    return resolve(root, declared.slice(marker.length).replace(/^[/\\]+/u, ""));
  }
  fail(!declared.includes(marker), "ambiguous_source_path", "[SKILL_DIR] may appear only as the leading segment");
  return isAbsolute(declared) ? resolve(declared) : resolve(root, declared);
}

function validatePhaseList(value, label) {
  fail(Array.isArray(value) && value.length <= 128, "invalid_schema", `${label} must be a bounded array`);
  fail(new Set(value).size === value.length, "invalid_schema", `${label} contains duplicates`);
  value.forEach((item) => assertString(item, label, 512));
}

function validateWorkflowCall(call, callPath) {
  assertExactKeys(call, new Set(["schema_version", "call_id", "invoking_skill", "native_workflow_observation", "workflow", "arguments", "caller_phase_ownership"]), "workflow call");
  fail(call.schema_version === "dynamic-workflow-call/v1", "unsupported_schema", "Unsupported workflow call schema");
  fail(CALL_ID_PATTERN.test(call.call_id ?? ""), "invalid_schema", "Invalid call_id");

  assertExactKeys(call.invoking_skill, new Set(["root", "skill_md"]), "invoking_skill");
  const root = resolve(call.invoking_skill.root ?? "");
  fail(isAbsolute(call.invoking_skill.root ?? "") && root === call.invoking_skill.root, "unsafe_path", "invoking_skill.root must be a normalized absolute path");
  fail(existsSync(root) && statSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), "unsafe_path", "invoking_skill.root must be a non-symlink directory");
  fail(!pathsOverlap(callPath, root), "unsafe_path", "Workflow call receipt must be outside the caller skill install tree");
  fail(!pathsOverlap(callPath, RUNNER_SKILL_ROOT), "unsafe_path", "Workflow call receipt must be outside the runner skill install tree");
  assertExactKeys(call.invoking_skill.skill_md, new Set(["path", "sha256"]), "invoking_skill.skill_md");
  const expectedSkillMd = join(root, "SKILL.md");
  fail(call.invoking_skill.skill_md.path === expectedSkillMd, "caller_crosswire", "skill_md.path must be <invoking_skill.root>/SKILL.md");
  assertSha256(call.invoking_skill.skill_md.sha256, "invoking_skill.skill_md.sha256");
  assertNoSymlinkComponents(expectedSkillMd, root);
  assertRegularNoSymlink(expectedSkillMd, "invoking SKILL.md");
  fail(sha256File(expectedSkillMd) === call.invoking_skill.skill_md.sha256, "caller_drift", "Invoking SKILL.md hash mismatch");

  assertExactKeys(call.native_workflow_observation, new Set(["attempted", "available", "observed_at", "evidence"]), "native_workflow_observation");
  fail(call.native_workflow_observation.attempted === false, "native_workflow_attempted", "Compatibility bridge is not a fallback after attempting native Workflow");
  fail(call.native_workflow_observation.available === false, "native_workflow_available", "Compatibility bridge must not run when native Workflow is available");
  assertDateTime(call.native_workflow_observation.observed_at, "native_workflow_observation.observed_at");
  validatePhaseList(call.native_workflow_observation.evidence, "native_workflow_observation.evidence");
  fail(call.native_workflow_observation.evidence.length > 0, "invalid_schema", "native_workflow_observation.evidence is required");

  assertExactKeys(call.workflow, new Set(["declared_script_path", "resolved_source"]), "workflow");
  assertString(call.workflow.declared_script_path, "workflow.declared_script_path");
  assertExactKeys(call.workflow.resolved_source, new Set(["path", "sha256"]), "workflow.resolved_source");
  const expectedSource = expectedSourcePath(root, call.workflow.declared_script_path);
  assertInside(root, expectedSource, "workflow source");
  fail(call.workflow.resolved_source.path === expectedSource, "source_crosswire", "resolved_source.path does not match caller-root resolution");
  assertSha256(call.workflow.resolved_source.sha256, "workflow.resolved_source.sha256");
  assertNoSymlinkComponents(expectedSource, root);
  assertRegularNoSymlink(expectedSource, "workflow source");
  fail(sha256File(expectedSource) === call.workflow.resolved_source.sha256, "source_drift", "Workflow source hash mismatch");

  assertExactKeys(call.arguments, new Set(["value", "canonical_sha256"]), "arguments");
  fail(call.arguments.value !== null && typeof call.arguments.value === "object" && !Array.isArray(call.arguments.value), "invalid_schema", "arguments.value must be an object");
  assertSha256(call.arguments.canonical_sha256, "arguments.canonical_sha256");
  fail(sha256Text(canonicalJson(call.arguments.value)) === call.arguments.canonical_sha256, "arguments_drift", "Arguments canonical hash mismatch");

  assertExactKeys(call.caller_phase_ownership, new Set(["owner", "pre_workflow", "post_workflow", "human_gates"]), "caller_phase_ownership");
  fail(call.caller_phase_ownership.owner === "caller_skill", "phase_ownership_crosswire", "Caller must own phases outside Workflow");
  for (const key of ["pre_workflow", "post_workflow", "human_gates"]) validatePhaseList(call.caller_phase_ownership[key], `caller_phase_ownership.${key}`);
  return {
    call_path: callPath,
    call_sha256: sha256File(callPath),
    call_id: call.call_id,
    invoking_skill_root: root,
    resolved_source_path: expectedSource,
    resolved_source_sha256: call.workflow.resolved_source.sha256,
    arguments_canonical_sha256: call.arguments.canonical_sha256,
  };
}

function resolvePointer(value, pointer, label) {
  fail(POINTER_PATTERN.test(pointer), "invalid_pointer", `${label} has an invalid JSON pointer`);
  if (pointer === "") return value;
  let current = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const token = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(current)) {
      fail(/^(?:0|[1-9]\d*)$/u.test(token), "return_pointer_missing", `${label} does not address an array index`);
      const index = Number(token);
      fail(Number.isSafeInteger(index) && index < current.length, "return_pointer_missing", `${label} array index is missing`);
      current = current[index];
    } else {
      fail(current !== null && typeof current === "object" && Object.hasOwn(current, token), "return_pointer_missing", `${label} property is missing`);
      current = current[token];
    }
  }
  return current;
}

function assertRunPath(runDir, path, label) {
  const absolute = resolve(runDir, path);
  const relation = relative(runDir, absolute);
  fail(relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation), "unsafe_path", `${label} escapes run directory`);
  assertNoSymlinkComponents(absolute, runDir);
  return absolute;
}

function loadReturnSchema(binding) {
  const schema = binding.schema;
  fail(schema?.dialect === JSON_SCHEMA_DIALECT, "unsupported_result_schema", "Return schema dialect is unsupported");
  if (schema.kind === "inline") {
    assertExactKeys(schema, new Set(["kind", "dialect", "document", "canonical_sha256"]), "return schema");
    assertSha256(schema.canonical_sha256, "return schema canonical_sha256");
    fail(sha256Text(canonicalJson(schema.document)) === schema.canonical_sha256, "return_schema_drift", "Inline return schema hash mismatch");
    inspectJsonSchema(schema.document);
    return { document: schema.document, sha256: schema.canonical_sha256 };
  }
  assertExactKeys(schema, new Set(["kind", "dialect", "path", "sha256"]), "return schema");
  fail(schema.kind === "file" && isAbsolute(schema.path), "invalid_schema", "Return schema path must be absolute");
  assertSha256(schema.sha256, "return schema sha256");
  assertRegularNoSymlink(schema.path, "return schema");
  const snapshot = readJsonSnapshot(schema.path);
  fail(snapshot.sha256 === schema.sha256, "return_schema_drift", "Return schema hash mismatch");
  const document = snapshot.value;
  inspectJsonSchema(document);
  return { document, sha256: schema.sha256 };
}

function validateReturnExpression(expression, manifest, depth = 1, counters = { nodes: 0 }) {
  const limits = manifest.return_binding.limits;
  fail(depth <= limits.max_depth, "budget_exceeded", "Return expression exceeds max_depth");
  counters.nodes += 1;
  fail(counters.nodes <= limits.max_nodes, "budget_exceeded", "Return expression exceeds max_nodes");
  fail(expression !== null && typeof expression === "object" && !Array.isArray(expression), "invalid_schema", "Return expression must be an object");
  const taskMap = new Map(manifest.tasks.map((task) => [task.id, task]));
  if (expression.kind === "literal") assertExactKeys(expression, new Set(["kind", "value"]), "literal return expression");
  else if (expression.kind === "argument") {
    assertExactKeys(expression, new Set(["kind", "key", "pointer"]), "argument return expression");
    fail(Object.hasOwn(manifest.arguments, expression.key), "return_producer_crosswire", `Unknown argument ${expression.key}`);
    fail(POINTER_PATTERN.test(expression.pointer), "invalid_pointer", "Invalid argument pointer");
  } else if (expression.kind === "task_result") {
    assertExactKeys(expression, new Set(["kind", "task_id", "pointer"]), "task result return expression");
    fail(taskMap.get(expression.task_id)?.kind === "agent", "return_producer_crosswire", `Unknown result producer ${expression.task_id}`);
    fail(POINTER_PATTERN.test(expression.pointer), "invalid_pointer", "Invalid task result pointer");
  } else if (expression.kind === "artifact") {
    assertExactKeys(expression, new Set(["kind", "task_id", "path", "pointer"]), "artifact return expression");
    const task = taskMap.get(expression.task_id);
    fail(task?.kind === "agent" && task.artifact_paths.includes(expression.path), "return_producer_crosswire", `Unknown artifact producer ${expression.task_id}:${expression.path}`);
    fail(POINTER_PATTERN.test(expression.pointer), "invalid_pointer", "Invalid artifact pointer");
  } else if (expression.kind === "object") {
    assertExactKeys(expression, new Set(["kind", "entries"]), "object return expression");
    fail(expression.entries !== null && typeof expression.entries === "object" && !Array.isArray(expression.entries), "invalid_schema", "Object return entries must be an object");
    for (const child of Object.values(expression.entries)) validateReturnExpression(child, manifest, depth + 1, counters);
  } else if (expression.kind === "array") {
    assertExactKeys(expression, new Set(["kind", "items"]), "array return expression");
    fail(Array.isArray(expression.items), "invalid_schema", "Array return items must be an array");
    for (const child of expression.items) validateReturnExpression(child, manifest, depth + 1, counters);
  } else fail(false, "invalid_schema", `Unsupported return expression kind ${expression.kind}`);
  return counters;
}

function materializeExpression(expression, manifest, state, runDir) {
  if (expression.kind === "literal") return expression.value;
  if (expression.kind === "argument") return resolvePointer(manifest.arguments[expression.key], expression.pointer, `argument:${expression.key}`);
  if (expression.kind === "object") return Object.fromEntries(Object.entries(expression.entries).map(([key, child]) => [key, materializeExpression(child, manifest, state, runDir)]));
  if (expression.kind === "array") return expression.items.map((child) => materializeExpression(child, manifest, state, runDir));
  const record = state.tasks?.[expression.task_id];
  fail(record !== undefined && ["completed", "resolved"].includes(record.status), "return_producer_incomplete", `Return producer ${expression.task_id} is not complete`);
  const resultPath = assertRunPath(runDir, record.result_path, `result:${expression.task_id}`);
  assertRegularNoSymlink(resultPath, `result:${expression.task_id}`);
  fail(sha256File(resultPath) === record.result_sha256, "return_producer_drift", `Result producer ${expression.task_id} drifted`);
  const result = readJson(resultPath);
  if (expression.kind === "task_result") return resolvePointer(result, expression.pointer, `task_result:${expression.task_id}`);
  const artifact = result.artifacts?.find((candidate) => candidate.path === expression.path);
  fail(artifact !== undefined, "return_producer_crosswire", `Artifact ${expression.path} is absent from producer result`);
  const artifactPath = assertRunPath(runDir, artifact.path, `artifact:${expression.task_id}`);
  assertRegularNoSymlink(artifactPath, `artifact:${expression.task_id}`);
  fail(sha256File(artifactPath) === artifact.sha256, "return_producer_drift", `Artifact ${expression.path} drifted`);
  let value;
  try {
    value = readJson(artifactPath);
  } catch (error) {
    throw new BridgeError("return_source_invalid", `${expression.path} is not a bounded JSON artifact: ${error.message}`);
  }
  return resolvePointer(value, expression.pointer, `artifact:${expression.task_id}:${expression.path}`);
}

function validateBridgeManifest(manifest, call, callSha256) {
  fail(manifest?.schema_version === "dynamic-workflow/v1", "unsupported_schema", "Unsupported workflow manifest");
  fail(manifest.invocation_mode === "skill_bridge", "bridge_contract_missing", "Manifest is not a skill_bridge invocation");
  fail(manifest.return_binding !== undefined, "bridge_contract_missing", "Manifest has no return_binding");
  assertExactKeys(manifest.return_binding, new Set(["schema_version", "workflow_call_sha256", "expression", "schema", "limits"]), "return_binding");
  fail(manifest.return_binding.schema_version === "dynamic-workflow-return-binding/v1", "unsupported_schema", "Unsupported return binding schema");
  fail(manifest.return_binding.workflow_call_sha256 === callSha256, "workflow_call_crosswire", "Manifest is bound to a different workflow call");
  fail(manifest.source?.path === call.workflow.resolved_source.path && manifest.source?.sha256 === call.workflow.resolved_source.sha256, "source_crosswire", "Manifest source differs from workflow call");
  fail(canonicalJson(manifest.arguments) === canonicalJson(call.arguments.value), "arguments_crosswire", "Manifest arguments differ from workflow call");
  assertExactKeys(manifest.return_binding.limits, new Set(["max_depth", "max_nodes"]), "return_binding.limits");
  fail(Number.isInteger(manifest.return_binding.limits.max_depth) && manifest.return_binding.limits.max_depth >= 1 && manifest.return_binding.limits.max_depth <= 32, "invalid_schema", "Invalid return max_depth");
  fail(Number.isInteger(manifest.return_binding.limits.max_nodes) && manifest.return_binding.limits.max_nodes >= 1 && manifest.return_binding.limits.max_nodes <= 4096, "invalid_schema", "Invalid return max_nodes");
  validateReturnExpression(manifest.return_binding.expression, manifest);
}

function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function commandValidateCall(options) {
  const requestedCallPath = resolve(requireOption(options, "call"));
  assertRegularNoSymlink(requestedCallPath, "workflow call");
  const callPath = realpathSync(requestedCallPath);
  const summary = validateWorkflowCall(readJson(callPath), callPath);
  process.stdout.write(`${JSON.stringify({ status: "workflow_call_valid", ...summary })}\n`);
}

function commandPrepareCall(options) {
  const requestedRoot = resolve(requireOption(options, "caller-skill-root"));
  const declaredScriptPath = requireOption(options, "declared-script-path");
  const argumentsPath = resolve(requireOption(options, "args"));
  const phaseOwnershipPath = resolve(requireOption(options, "phase-ownership"));
  const nativeObservationPath = resolve(requireOption(options, "native-observation"));
  const callId = requireOption(options, "call-id");
  const requestedOutputPath = resolve(requireOption(options, "output"));
  fail(CALL_ID_PATTERN.test(callId), "invalid_arguments", "Invalid --call-id");
  fail(existsSync(requestedRoot) && statSync(requestedRoot).isDirectory(), "unsafe_path", "Caller skill root must resolve to a directory");
  const root = realpathSync(requestedRoot);
  fail(!lstatSync(root).isSymbolicLink(), "unsafe_path", "Canonical caller skill root must be a non-symlink directory");
  const outputPath = canonicalPath(requestedOutputPath);
  fail(!pathsOverlap(outputPath, root), "unsafe_path", "Workflow call output must be outside the caller skill install tree");
  fail(!pathsOverlap(outputPath, RUNNER_SKILL_ROOT), "unsafe_path", "Workflow call output must be outside the runner skill install tree");
  fail(existsSync(dirname(outputPath)) && statSync(dirname(outputPath)).isDirectory() && !lstatSync(dirname(outputPath)).isSymbolicLink(), "input_missing", "Workflow call output parent must be an existing non-symlink directory");
  const skillMd = join(root, "SKILL.md");
  assertNoSymlinkComponents(skillMd, root);
  assertRegularNoSymlink(skillMd, "invoking SKILL.md");
  for (const [path, label] of [[argumentsPath, "arguments"], [phaseOwnershipPath, "phase ownership"], [nativeObservationPath, "native Workflow observation"]]) {
    assertRegularNoSymlink(path, label);
  }
  const argumentsValue = readJson(argumentsPath);
  fail(argumentsValue !== null && typeof argumentsValue === "object" && !Array.isArray(argumentsValue), "invalid_schema", "Arguments input must be a JSON object");
  const phaseOwnership = readJson(phaseOwnershipPath);
  const nativeObservation = readJson(nativeObservationPath);
  const sourcePath = expectedSourcePath(root, declaredScriptPath);
  assertInside(root, sourcePath, "workflow source");
  assertNoSymlinkComponents(sourcePath, root);
  assertRegularNoSymlink(sourcePath, "workflow source");
  const document = {
    schema_version: "dynamic-workflow-call/v1",
    call_id: callId,
    invoking_skill: {
      root,
      skill_md: { path: skillMd, sha256: sha256File(skillMd) },
    },
    native_workflow_observation: nativeObservation,
    workflow: {
      declared_script_path: declaredScriptPath,
      resolved_source: { path: sourcePath, sha256: sha256File(sourcePath) },
    },
    arguments: {
      value: argumentsValue,
      canonical_sha256: sha256Text(canonicalJson(argumentsValue)),
    },
    caller_phase_ownership: phaseOwnership,
  };
  if (existsSync(outputPath)) {
    assertRegularNoSymlink(outputPath, "workflow call output");
    fail(canonicalJson(readJson(outputPath)) === canonicalJson(document), "workflow_call_conflict", "Existing workflow call differs from requested call");
    const summary = validateWorkflowCall(readJson(outputPath), outputPath);
    process.stdout.write(`${JSON.stringify({ status: "workflow_call_ready", ...summary, idempotent: true })}\n`);
    return;
  }
  const temporary = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  let idempotent = false;
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    validateWorkflowCall(readJson(temporary), temporary);
    try {
      linkSync(temporary, outputPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      assertRegularNoSymlink(outputPath, "workflow call output");
      fail(canonicalJson(readJson(outputPath)) === canonicalJson(document), "workflow_call_conflict", "Concurrent workflow call differs from requested call");
      idempotent = true;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  const published = readJson(outputPath);
  fail(canonicalJson(published) === canonicalJson(document), "workflow_call_conflict", "Published workflow call differs from requested call");
  const summary = validateWorkflowCall(published, outputPath);
  process.stdout.write(`${JSON.stringify({ status: "workflow_call_ready", ...summary, idempotent })}\n`);
}

function commandMaterialize(options) {
  const requestedCallPath = resolve(requireOption(options, "call"));
  assertRegularNoSymlink(requestedCallPath, "workflow call");
  const callPath = realpathSync(requestedCallPath);
  const runDir = canonicalPath(requireOption(options, "run-dir"));
  const outputPath = canonicalPath(requireOption(options, "output"));
  fail(outputPath === join(runDir, RETURN_FILE), "unsafe_path", `Bridge return must be ${join(runDir, RETURN_FILE)}`);
  fail(existsSync(runDir) && statSync(runDir).isDirectory() && !lstatSync(runDir).isSymbolicLink(), "run_missing", "Run directory is unavailable");
  const callSnapshot = readJsonSnapshot(callPath);
  const call = callSnapshot.value;
  validateWorkflowCall(call, callPath);
  const manifestPath = join(runDir, "workflow.manifest.json");
  const statePath = join(runDir, "workflow-state.json");
  const finalReviewPath = join(runDir, "final-review.json");
  for (const [path, label] of [[manifestPath, "manifest"], [statePath, "state"], [finalReviewPath, "final review"]]) {
    assertNoSymlinkComponents(path, runDir);
    assertRegularNoSymlink(path, label);
  }
  const manifestSnapshot = readJsonSnapshot(manifestPath);
  const manifest = manifestSnapshot.value;
  validateBridgeManifest(manifest, call, callSnapshot.sha256);
  const finalReviewSnapshot = readJsonSnapshot(finalReviewPath);
  const finalReview = finalReviewSnapshot.value;
  const verification = spawnSync(process.execPath, [CONTROL_SCRIPT, "verify", "--run-dir", runDir], { encoding: "utf8" });
  fail(verification.status === 0, "run_invalid", `Controller verification failed: ${verification.stderr.trim() || verification.stdout.trim()}`);
  let verificationResult;
  try {
    verificationResult = JSON.parse(verification.stdout);
  } catch (error) {
    throw new BridgeError("run_invalid", `Controller verification returned invalid JSON: ${error.message}`);
  }
  fail(
    verificationResult.valid === true
      && verificationResult.status === "workflow_complete"
      && Array.isArray(verificationResult.errors)
      && verificationResult.errors.length === 0,
    "run_invalid",
    `Controller verification rejected the run: ${verification.stdout.trim()}`,
  );
  fail(sha256File(statePath) === verificationResult.state_snapshot_sha256, "run_invalid", "Run state changed after controller verification");
  const state = readJson(statePath);
  fail(state.manifest_sha256 === manifestSnapshot.sha256, "manifest_drift", "State is bound to a different manifest");
  fail(state.status === "workflow_complete", "workflow_not_complete", "Bridge return requires workflow_complete");
  fail(state.final_review?.verdict === "pass" && finalReview.verdict === "pass", "workflow_not_complete", "Bridge return requires a passing final review");
  fail(state.final_review.path === "final-review.json" && state.final_review.sha256 === finalReviewSnapshot.sha256, "final_review_crosswire", "Final review lineage mismatch");
  const requiredHandoffGates = manifest.tasks
    .filter((task) => task.kind === "human_gate" && task.action_package !== null)
    .map((task) => task.id)
    .sort();
  const preparedHandoffGates = (state.action_handoffs ?? []).map((receipt) => receipt.gate_id).sort();
  fail(
    canonicalJson(preparedHandoffGates) === canonicalJson(requiredHandoffGates),
    "handoff_missing",
    "Every external action package requires a controller-verified handoff before caller continuation",
  );
  const schema = loadReturnSchema(manifest.return_binding);
  const value = materializeExpression(manifest.return_binding.expression, manifest, state, runDir);
  const errors = jsonSchemaErrors(schema.document, value);
  fail(errors.length === 0, "return_schema_invalid", errors.join("; "));
  const document = {
    schema_version: "dynamic-workflow-return/v1",
    call_id: call.call_id,
    workflow_id: state.workflow_id,
    run_id: state.run_id,
    status: "workflow_complete",
    value,
    receipt: {
      workflow_call_sha256: callSnapshot.sha256,
      manifest_sha256: manifestSnapshot.sha256,
      final_review_sha256: finalReviewSnapshot.sha256,
      value_canonical_sha256: sha256Text(canonicalJson(value)),
      schema_sha256: schema.sha256,
      materialized_at: new Date().toISOString(),
    },
    caller_continuation: {
      allowed: true,
      owner: "caller_skill",
      invoking_skill_root: call.invoking_skill.root,
      post_workflow: call.caller_phase_ownership.post_workflow,
      human_gates: call.caller_phase_ownership.human_gates,
    },
  };
  if (existsSync(outputPath)) {
    assertNoSymlinkComponents(outputPath, runDir);
    assertRegularNoSymlink(outputPath, "workflow return");
    const existing = readJson(outputPath);
    const returnSchema = readJson(WORKFLOW_RETURN_SCHEMA);
    const existingErrors = jsonSchemaErrors(returnSchema, existing);
    fail(existingErrors.length === 0, "return_schema_invalid", existingErrors.join("; "));
    const stableDocument = { ...document, receipt: { ...document.receipt, materialized_at: existing.receipt.materialized_at } };
    fail(canonicalJson(existing) === canonicalJson(stableDocument), "return_conflict", "Existing workflow return differs from current lineage");
    process.stdout.write(`${JSON.stringify({ status: "workflow_return_ready", path: outputPath, sha256: sha256File(outputPath), idempotent: true, caller_continuation_allowed: true })}\n`);
    return;
  }
  atomicWriteJson(outputPath, document);
  process.stdout.write(`${JSON.stringify({ status: "workflow_return_ready", path: outputPath, sha256: sha256File(outputPath), idempotent: false, caller_continuation_allowed: true })}\n`);
}

function usage() {
  return [
    "workflow-bridge.mjs prepare-call --caller-skill-root DIR --declared-script-path PATH --args FILE --phase-ownership FILE --native-observation FILE --call-id ID --output FILE",
    "workflow-bridge.mjs validate-call --call FILE",
    "workflow-bridge.mjs materialize --call FILE --run-dir DIR --output RUN_DIR/workflow-return.json",
  ].join("\n");
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "prepare-call") commandPrepareCall(options);
  else if (command === "validate-call") commandValidateCall(options);
  else if (command === "materialize") commandMaterialize(options);
  else throw new BridgeError("invalid_arguments", usage());
}

try {
  main();
} catch (error) {
  const code = error instanceof BridgeError || typeof error?.code === "string" ? error.code : "internal_error";
  process.stderr.write(`${JSON.stringify({ status: "error", code, message: error.message })}\n`);
  process.exitCode = 1;
}
