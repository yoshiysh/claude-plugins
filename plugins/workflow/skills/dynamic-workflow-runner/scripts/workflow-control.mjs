#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { JSON_SCHEMA_DIALECT, inspectJsonSchema, isCanonicalDateTime, jsonSchemaErrors } from "./json-schema-subset.mjs";

const STATE_FILE = "workflow-state.json";
const MANIFEST_FILE = "workflow.manifest.json";
const CAPABILITIES_FILE = "capabilities.json";
const TRANSLATION_REVIEW_FILE = "translation-review.json";
const TRANSLATION_REVIEW_RECEIPT_FILE = "translation-review-receipt.json";
const TRANSLATION_ORIGINAL_RECEIPT_FILE = "original-review-receipt.json";
const TRANSLATION_WORKFLOW_CALL_FILE = "workflow-call.json";
const LOCK_FILE = ".workflow-control.lock";
const RECOVERY_LOCK_FILE = ".workflow-control.recovery.lock";
const LOCK_RECOVERY_DIRECTORY = "lock-recovery";
const LOCK_PUBLICATION_RETRIES = 20;
const LOCK_PUBLICATION_WAIT_MS = 2;
const LOCK_PUBLICATION_WAIT = new Int32Array(new SharedArrayBuffer(4));
const RESERVED_ROOT_FILES = new Set([
  STATE_FILE,
  MANIFEST_FILE,
  CAPABILITIES_FILE,
  TRANSLATION_REVIEW_FILE,
  TRANSLATION_REVIEW_RECEIPT_FILE,
  LOCK_FILE,
  RECOVERY_LOCK_FILE,
  "final-review.json",
  "workflow-return.json",
].map(pathKey));
const RESERVED_ROOT_DIRECTORIES = new Set(["inputs", "review", "translation", "capability-receipts", "gates", "handoffs", LOCK_RECOVERY_DIRECTORY].map(pathKey));
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SEMANTIC_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const INVOCATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const CALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const OUTCOMES = new Set(["pass", "revise", "blocked", "failed"]);
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const TERMINAL = new Set(["completed", "resolved", "failed", "blocked", "skipped", "approved", "rejected"]);
const SATISFIED = new Set(["completed", "resolved", "skipped", "approved"]);
const CAPABILITY_KEYS = new Set([
  "native_collaboration",
  "spawn",
  "collect_or_wait",
  "stable_handle",
  "message",
  "resume",
  "interrupt",
]);
const RUNNER_SKILL_ROOT = realpathSync(resolve(fileURLToPath(new URL("..", import.meta.url))));

class WorkflowError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(condition, code, message) {
  if (!condition) {
    throw new WorkflowError(code, message);
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    fail(key?.startsWith("--"), "invalid_arguments", `Expected option, received: ${key}`);
    fail(index + 1 < rest.length, "invalid_arguments", `Missing value for ${key}`);
    options[key.slice(2)] = rest[index + 1];
  }
  return { command, options };
}

function readBoundedBytes(path, maxBytes = MAX_JSON_BYTES) {
  const descriptor = openSync(path, "r");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      fail(total <= maxBytes, "resource_limit", `${path}: exceeds ${maxBytes} byte JSON limit`);
      chunks.push(chunk.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  return Buffer.concat(chunks, total);
}

function readJson(path) {
  try {
    return JSON.parse(readBoundedBytes(path).toString("utf8"));
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError("invalid_json", `${path}: ${error.message}`);
  }
}

function readJsonSnapshot(path) {
  try {
    const bytes = readBoundedBytes(path);
    return {
      value: JSON.parse(bytes.toString("utf8")),
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError("invalid_json", `${path}: ${error.message}`);
  }
}

function freezeJsonSnapshot(snapshot, destination) {
  writeFileSync(destination, snapshot.bytes, { mode: 0o600 });
  fail(sha256File(destination) === snapshot.sha256, "state_drift", "JSON snapshot changed while freezing");
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
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

function isoNow() {
  return new Date().toISOString();
}

function atomicWriteJson(path, value) {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, path);
}

function atomicWriteBytes(path, bytes) {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, bytes, { mode: 0o600 });
  renameSync(tempPath, path);
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

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function validateLockDocument(lock) {
  assertExactKeys(lock, new Set(["schema_version", "pid", "hostname", "acquired_at", "token"]), "workflow lock");
  fail(lock.schema_version === "dynamic-workflow-lock/v1", "run_locked", "Unsupported workflow lock schema");
  fail(Number.isInteger(lock.pid) && lock.pid > 0, "run_locked", "Workflow lock pid is invalid");
  assertString(lock.hostname, "workflow lock hostname");
  assertDateTime(lock.acquired_at, "workflow lock acquired_at");
  fail(typeof lock.token === "string" && /^[a-f0-9-]{36}$/u.test(lock.token), "run_locked", "Workflow lock token is invalid");
}

function readPublishedLock(path, label) {
  let identity = null;
  for (let attempt = 0; attempt < LOCK_PUBLICATION_RETRIES; attempt += 1) {
    try {
      const before = lstatSync(path);
      fail(!before.isSymbolicLink() && before.isFile(), "run_locked", `${label} must be a regular non-symlink file`);
      if (identity !== null) {
        fail(before.dev === identity.dev && before.ino === identity.ino, "lock_race", `${label} identity changed while it was being published`);
      }
      identity = before;
      const snapshot = readJsonSnapshot(path);
      const after = lstatSync(path);
      fail(after.dev === before.dev && after.ino === before.ino, "lock_race", `${label} identity changed while it was being read`);
      return snapshot;
    } catch (error) {
      if (error?.code === "ENOENT") throw error;
      if (error?.code !== "invalid_json") throw error;
      if (attempt + 1 === LOCK_PUBLICATION_RETRIES) {
        throw new WorkflowError("run_locked", `${label} was not published as one complete JSON document`);
      }
      Atomics.wait(LOCK_PUBLICATION_WAIT, 0, 0, LOCK_PUBLICATION_WAIT_MS);
    }
  }
  throw new WorkflowError("run_locked", `${label} publication could not be observed`);
}

function acquireRecoveryLock(runDir) {
  const recoveryLockPath = join(runDir, RECOVERY_LOCK_FILE);
  const guard = {
    schema_version: "dynamic-workflow-recovery-lock/v1",
    pid: process.pid,
    hostname: hostname(),
    acquired_at: isoNow(),
    token: randomUUID(),
  };
  try {
    const descriptor = openSync(recoveryLockPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(guard, null, 2)}\n`);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readPublishedLock(recoveryLockPath, "workflow recovery lock");
    assertExactKeys(existing.value, new Set(["schema_version", "pid", "hostname", "acquired_at", "token"]), "workflow recovery lock");
    fail(existing.value.schema_version === "dynamic-workflow-recovery-lock/v1", "run_locked", "Unsupported recovery lock schema");
    fail(Number.isInteger(existing.value.pid) && existing.value.pid > 0, "run_locked", "Recovery lock pid is invalid");
    assertString(existing.value.hostname, "workflow recovery lock hostname");
    assertDateTime(existing.value.acquired_at, "workflow recovery lock acquired_at");
    fail(typeof existing.value.token === "string" && /^[a-f0-9-]{36}$/u.test(existing.value.token), "run_locked", "Recovery lock token is invalid");
    const ownerState = existing.value.hostname === hostname() && !processIsAlive(existing.value.pid) ? "stale" : "active_or_unverifiable";
    throw new WorkflowError("run_locked", `Recovery guard is ${ownerState}; it is never removed automatically`);
  }
  return () => {
    fail(existsSync(recoveryLockPath), "lock_lost", "Recovery lock disappeared before release");
    const current = readJson(recoveryLockPath);
    fail(current.token === guard.token, "lock_lost", "Recovery lock ownership changed before release");
    rmSync(recoveryLockPath);
  };
}

function acquireLock(runDir) {
  const lockPath = join(runDir, LOCK_FILE);
  const recoveryLockPath = join(runDir, RECOVERY_LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    fail(!existsSync(recoveryLockPath), "run_locked", "Explicit stale-lock recovery is in progress");
    const lock = {
      schema_version: "dynamic-workflow-lock/v1",
      pid: process.pid,
      hostname: hostname(),
      acquired_at: isoNow(),
      token: randomUUID(),
    };
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(descriptor, `${JSON.stringify(lock, null, 2)}\n`);
      } finally {
        closeSync(descriptor);
      }
      if (existsSync(recoveryLockPath)) {
        const current = readJson(lockPath);
        if (current.token === lock.token) rmSync(lockPath);
        throw new WorkflowError("run_locked", "Explicit stale-lock recovery started during lock acquisition");
      }
      return () => {
        fail(existsSync(lockPath), "lock_lost", "Workflow lock disappeared before release");
        const current = readJson(lockPath);
        fail(current.token === lock.token, "lock_lost", "Workflow lock ownership changed before release");
        rmSync(lockPath);
      };
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      if (error?.code !== "EEXIST") {
        throw new WorkflowError("run_locked", `${runDir}: ${error.message}`);
      }
      try {
        const existing = readPublishedLock(lockPath, "workflow lock").value;
        validateLockDocument(existing);
        if (existing.hostname === hostname() && !processIsAlive(existing.pid)) {
          throw new WorkflowError("stale_lock", `${runDir}: stale lock requires explicit recover-lock with an actor`);
        }
        throw new WorkflowError("run_locked", `${runDir}: active or unverifiable lock held by ${existing.hostname}:${existing.pid}`);
      } catch (inspectionError) {
        if (inspectionError?.code === "ENOENT") continue;
        throw inspectionError;
      }
    }
  }
  throw new WorkflowError("run_locked", `${runDir}: lock changed repeatedly during acquisition`);
}

function requireOption(options, key) {
  fail(typeof options[key] === "string" && options[key].length > 0, "invalid_arguments", `Missing --${key}`);
  return options[key];
}

function assertExactKeys(value, allowed, label) {
  fail(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_schema", `${label} must be an object`);
  for (const key of Object.keys(value)) {
    fail(allowed.has(key), "invalid_schema", `${label} has unknown field: ${key}`);
  }
}

function assertString(value, label) {
  fail(typeof value === "string" && value.length > 0, "invalid_schema", `${label} must be a non-empty string`);
}

function validateStringArray(value, label) {
  fail(Array.isArray(value), "invalid_schema", `${label} must be an array`);
  value.forEach((item) => assertString(item, label));
}

function assertInteger(value, min, max, label) {
  fail(Number.isInteger(value) && value >= min && value <= max, "invalid_schema", `${label} must be ${min}..${max}`);
}

function assertDateTime(value, label) {
  assertString(value, label);
  fail(isCanonicalDateTime(value), "invalid_schema", `${label} must be a canonical RFC 3339 date-time`);
}

function assertNoSymlinkAncestors(path, label, boundary = "/") {
  let current = resolve(path);
  const stop = resolve(boundary);
  while (true) {
    if (existsSync(current)) {
      fail(!lstatSync(current).isSymbolicLink(), "unsafe_path", `${label} has a symlink component: ${current}`);
    }
    if (current === stop) {
      break;
    }
    const parent = dirname(current);
    fail(parent !== current, "unsafe_path", `${label} escapes its trusted boundary`);
    current = parent;
  }
}

function pathKey(path) {
  return normalize(path).split(sep).join("/").normalize("NFD").toLowerCase();
}

function pathSpelling(path) {
  return normalize(path).split(sep).join("/");
}

function pathsOverlap(left, right) {
  const a = pathKey(canonicalPath(left));
  const b = pathKey(canonicalPath(right));
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function validateCondition(condition, taskIds, dependencyIds, label) {
  if (condition === undefined) {
    return;
  }
  fail(taskIds.has(condition.task_id), "invalid_graph", `${label}.task_id is unknown`);
  fail(dependencyIds.has(condition.task_id), "invalid_graph", `${label}.task_id must be a direct dependency`);
  if (Object.hasOwn(condition, "outcomes")) {
    assertExactKeys(condition, new Set(["task_id", "outcomes"]), label);
    fail(Array.isArray(condition.outcomes) && condition.outcomes.length > 0, "invalid_schema", `${label}.outcomes is required`);
    fail(new Set(condition.outcomes).size === condition.outcomes.length, "invalid_schema", `${label}.outcomes has duplicates`);
    for (const outcome of condition.outcomes) {
      fail(["pass", "revise"].includes(outcome), "invalid_schema", `${label}.outcomes contains unsupported branch outcome ${outcome}`);
    }
    return;
  }
  const hasExpected = Object.hasOwn(condition, "expected");
  assertExactKeys(condition, new Set(["task_id", "artifact_path", "pointer", "predicate", ...(hasExpected ? ["expected"] : [])]), label);
  condition.artifact_path = validateRelativePath(condition.artifact_path, `${label}.artifact_path`);
  validateJsonPointer(condition.pointer, `${label}.pointer`);
  fail(["exists", "equals"].includes(condition.predicate), "invalid_schema", `${label}.predicate is unsupported`);
  fail(condition.predicate === "equals" ? hasExpected : !hasExpected, "invalid_schema", `${label}.expected must appear exactly for predicate=equals`);
  if (hasExpected) {
    fail(condition.expected === null || ["string", "number", "boolean"].includes(typeof condition.expected), "invalid_schema", `${label}.expected must be a JSON scalar`);
    canonicalJson(condition.expected);
  }
}

function validateRelativePath(path, label) {
  assertString(path, label);
  fail(!path.includes("\0"), "unsafe_path", `${label} contains NUL`);
  fail(!isAbsolute(path), "unsafe_path", `${label} must be relative`);
  const rawParts = path.split(/[\\/]/u);
  fail(!rawParts.includes(".."), "unsafe_path", `${label} contains a parent segment`);
  const normalized = normalize(path);
  const parts = normalized.split(/[\\/]/u);
  fail(!parts.includes(".."), "unsafe_path", `${label} escapes the run directory`);
  fail(![".git", ".codex", ".agent"].includes(parts[0]?.toLowerCase()), "unsafe_path", `${label} targets a protected path`);
  fail(normalized !== "." && normalized.length > 0, "unsafe_path", `${label} is empty`);
  return normalized;
}

function validateTaskShape(task, taskIds) {
  const baseKeys = ["id", "kind", "depends_on", "required", "when"];
  fail(ID_PATTERN.test(task.id ?? ""), "invalid_schema", `Invalid task id: ${task.id}`);
  fail(task.kind === "agent" || task.kind === "human_gate", "invalid_schema", `${task.id}: unknown kind`);
  fail(Array.isArray(task.depends_on), "invalid_schema", `${task.id}: depends_on must be an array`);
  fail(new Set(task.depends_on).size === task.depends_on.length, "invalid_schema", `${task.id}: duplicate dependency`);
  for (const dependency of task.depends_on) {
    fail(taskIds.has(dependency), "invalid_graph", `${task.id}: unknown dependency ${dependency}`);
    fail(dependency !== task.id, "invalid_graph", `${task.id}: self dependency`);
  }
  fail(typeof task.required === "boolean", "invalid_schema", `${task.id}: required must be boolean`);
  validateCondition(task.when, taskIds, new Set(task.depends_on), `${task.id}.when`);
  if (task.kind === "agent") {
    validateAgentTask(task, baseKeys);
  } else {
    validateHumanGate(task, baseKeys);
  }
}

function validateAgentTask(task, baseKeys) {
  assertExactKeys(task, new Set([...baseKeys, "prompt", "context_policy", "requirements", "result_contract", "inputs", "output_path", "artifact_paths", "effect", "approval_gate_id", "accepted_outcomes"]), task.id);
  assertString(task.prompt, `${task.id}.prompt`);
  validateContextPolicy(task.context_policy, `${task.id}.context_policy`);
  validateTaskRequirements(task.requirements, task.required, `${task.id}.requirements`);
  validateResultContract(task.result_contract, `${task.id}.result_contract`);
  fail(Array.isArray(task.inputs), "invalid_schema", `${task.id}: inputs must be an array`);
  fail(new Set(task.inputs.map(canonicalJson)).size === task.inputs.length, "invalid_schema", `${task.id}: duplicate input`);
  task.inputs.forEach((input, index) => validateInputRef(input, `${task.id}.inputs[${index}]`));
  fail(!task.prompt.includes("[SKILL_DIR]"), "unsafe_prompt_input", `${task.id}: prompt references the live caller skill token`);
  for (const input of task.inputs.filter((candidate) => candidate.kind === "file")) {
    fail(!task.prompt.includes(input.path), "unsafe_prompt_input", `${task.id}: prompt references a live file input path`);
  }
  task.output_path = validateRelativePath(task.output_path, `${task.id}.output_path`);
  fail(Array.isArray(task.artifact_paths), "invalid_schema", `${task.id}: artifact_paths must be an array`);
  task.artifact_paths = task.artifact_paths.map((path) => validateRelativePath(path, `${task.id}.artifact_paths`));
  fail(new Set(task.artifact_paths.map(pathKey)).size === task.artifact_paths.length, "unsafe_path", `${task.id}: artifact_paths collide`);
  if (task.result_contract.target.kind === "json_artifact") {
    fail(task.artifact_paths.some((path) => pathKey(path) === pathKey(task.result_contract.target.artifact_path)), "invalid_graph", `${task.id}: result contract target must be a declared artifact`);
  }
  fail(["read_only", "workspace_write"].includes(task.effect), "invalid_schema", `${task.id}: invalid effect`);
  fail(task.approval_gate_id === null || ID_PATTERN.test(task.approval_gate_id ?? ""), "invalid_schema", `${task.id}: invalid approval_gate_id`);
  fail(task.effect !== "workspace_write" || task.artifact_paths.length > 0, "invalid_schema", `${task.id}: workspace_write requires artifact_paths`);
  fail(Array.isArray(task.accepted_outcomes) && task.accepted_outcomes.length > 0, "invalid_schema", `${task.id}: accepted_outcomes required`);
  fail(new Set(task.accepted_outcomes).size === task.accepted_outcomes.length, "invalid_schema", `${task.id}: duplicate accepted outcome`);
  for (const outcome of task.accepted_outcomes) {
    fail(["pass", "revise"].includes(outcome), "invalid_schema", `${task.id}: invalid accepted outcome ${outcome}`);
  }
}

function validateContextPolicy(policy, label) {
  fail(policy !== null && typeof policy === "object" && !Array.isArray(policy), "invalid_schema", `${label} must be an object`);
  if (policy.mode === "recent") {
    assertExactKeys(policy, new Set(["mode", "turns"]), label);
    assertInteger(policy.turns, 1, 1000, `${label}.turns`);
    return;
  }
  assertExactKeys(policy, new Set(["mode"]), label);
  fail(["fresh", "all"].includes(policy.mode), "invalid_schema", `${label}.mode is invalid`);
}

function validateTaskRequirements(requirements, required, label) {
  assertExactKeys(requirements, new Set(["semantic_capabilities", "permissions", "on_unavailable"]), label);
  for (const key of ["semantic_capabilities", "permissions"]) {
    validateStringArray(requirements[key], `${label}.${key}`);
    fail(new Set(requirements[key]).size === requirements[key].length, "invalid_schema", `${label}.${key} has duplicates`);
    requirements[key].forEach((value) => fail(value.length <= 160 && SEMANTIC_ID_PATTERN.test(value), "invalid_schema", `${label}.${key} has invalid semantic identifier ${value}`));
  }
  fail(["unsupported_runtime", "skip_optional"].includes(requirements.on_unavailable), "invalid_schema", `${label}.on_unavailable is invalid`);
  fail(requirements.on_unavailable !== "skip_optional" || required === false, "invalid_schema", `${label}.skip_optional requires required=false`);
}

function validateResultContract(contract, label) {
  assertExactKeys(contract, new Set(["schema_version", "contract_id", "target", "schema", "validation"]), label);
  fail(contract.schema_version === "dynamic-workflow-task-result-contract/v1", "unsupported_schema", `${label}.schema_version is unsupported`);
  if (contract.contract_id !== undefined) fail(ID_PATTERN.test(contract.contract_id), "invalid_schema", `${label}.contract_id is invalid`);
  if (contract.target?.kind === "node_result") assertExactKeys(contract.target, new Set(["kind"]), `${label}.target`);
  else {
    assertExactKeys(contract.target, new Set(["kind", "artifact_path"]), `${label}.target`);
    fail(contract.target.kind === "json_artifact", "invalid_schema", `${label}.target.kind is invalid`);
    contract.target.artifact_path = validateRelativePath(contract.target.artifact_path, `${label}.target.artifact_path`);
  }
  fail(contract.schema?.dialect === JSON_SCHEMA_DIALECT, "unsupported_result_schema", `${label}.schema dialect is unsupported`);
  if (contract.schema.kind === "inline") {
    assertExactKeys(contract.schema, new Set(["kind", "dialect", "document", "canonical_sha256"]), `${label}.schema`);
    fail(SHA256_PATTERN.test(contract.schema.canonical_sha256 ?? ""), "invalid_schema", `${label}.schema canonical hash is invalid`);
    fail(sha256Text(canonicalJson(contract.schema.document)) === contract.schema.canonical_sha256, "result_contract_drift", `${label}.schema canonical hash mismatch`);
    inspectJsonSchema(contract.schema.document);
  } else {
    assertExactKeys(contract.schema, new Set(["kind", "dialect", "path", "sha256"]), `${label}.schema`);
    fail(contract.schema.kind === "file" && isAbsolute(contract.schema.path), "unsafe_path", `${label}.schema.path must be absolute`);
    fail(SHA256_PATTERN.test(contract.schema.sha256 ?? ""), "invalid_schema", `${label}.schema hash is invalid`);
    fail(existsSync(contract.schema.path) && statSync(contract.schema.path).isFile() && !lstatSync(contract.schema.path).isSymbolicLink(), "input_missing", `${label}.schema file is unavailable`);
    const snapshot = readJsonSnapshot(contract.schema.path);
    fail(snapshot.sha256 === contract.schema.sha256, "result_contract_drift", `${label}.schema file hash mismatch`);
    inspectJsonSchema(snapshot.value);
  }
  assertExactKeys(contract.validation, new Set(["at_finish", "at_final_review", "on_missing", "on_invalid"]), `${label}.validation`);
  fail(contract.validation.at_finish === true && contract.validation.at_final_review === true && contract.validation.on_missing === "workflow_incomplete" && contract.validation.on_invalid === "workflow_incomplete", "invalid_schema", `${label}.validation must fail closed`);
}

function validateReturnSchema(schema, label) {
  fail(schema !== null && typeof schema === "object" && !Array.isArray(schema), "invalid_schema", `${label} must be an object`);
  fail(schema.dialect === JSON_SCHEMA_DIALECT, "unsupported_result_schema", `${label}.dialect is unsupported`);
  if (schema.kind === "inline") {
    assertExactKeys(schema, new Set(["kind", "dialect", "document", "canonical_sha256"]), label);
    fail(SHA256_PATTERN.test(schema.canonical_sha256 ?? ""), "invalid_schema", `${label}.canonical_sha256 is invalid`);
    fail(sha256Text(canonicalJson(schema.document)) === schema.canonical_sha256, "return_binding_drift", `${label} canonical hash mismatch`);
    inspectJsonSchema(schema.document);
    return;
  }
  assertExactKeys(schema, new Set(["kind", "dialect", "path", "sha256"]), label);
  fail(schema.kind === "file" && isAbsolute(schema.path), "unsafe_path", `${label}.path must be absolute`);
  fail(SHA256_PATTERN.test(schema.sha256 ?? ""), "invalid_schema", `${label}.sha256 is invalid`);
  fail(existsSync(schema.path) && statSync(schema.path).isFile() && !lstatSync(schema.path).isSymbolicLink(), "input_missing", `${label} file is unavailable`);
  const snapshot = readJsonSnapshot(schema.path);
  fail(snapshot.sha256 === schema.sha256, "return_binding_drift", `${label} file hash mismatch`);
  inspectJsonSchema(snapshot.value);
}

function validateJsonPointer(pointer, label) {
  fail(typeof pointer === "string" && /^(?:\/(?:[^~/]|~[01])*)*$/u.test(pointer), "invalid_schema", `${label} must be an RFC 6901 JSON pointer`);
  fail(pointer.length <= 2048 && (pointer === "" || pointer.slice(1).split("/").length <= 64), "invalid_schema", `${label} is too large`);
}

function validateReturnExpression(expression, manifest, taskById, limits, counters, depth = 1, label = "return_binding.expression") {
  fail(depth <= limits.max_depth, "budget_exceeded", `${label} exceeds max_depth`);
  counters.nodes += 1;
  fail(counters.nodes <= limits.max_nodes, "budget_exceeded", `${label} exceeds max_nodes`);
  fail(expression !== null && typeof expression === "object" && !Array.isArray(expression), "invalid_schema", `${label} must be an object`);
  if (expression.kind === "literal") {
    assertExactKeys(expression, new Set(["kind", "value"]), label);
    fail(expression.value !== undefined, "invalid_schema", `${label}.value must be JSON data`);
    canonicalJson(expression.value);
    return;
  }
  if (expression.kind === "argument") {
    assertExactKeys(expression, new Set(["kind", "key", "pointer"]), label);
    assertString(expression.key, `${label}.key`);
    fail(Object.hasOwn(manifest.arguments, expression.key), "invalid_graph", `${label} references unknown argument ${expression.key}`);
    validateJsonPointer(expression.pointer, `${label}.pointer`);
    return;
  }
  if (expression.kind === "task_result") {
    assertExactKeys(expression, new Set(["kind", "task_id", "pointer"]), label);
    fail(taskById.get(expression.task_id)?.kind === "agent", "invalid_graph", `${label} references unknown agent task ${expression.task_id}`);
    validateJsonPointer(expression.pointer, `${label}.pointer`);
    return;
  }
  if (expression.kind === "artifact") {
    assertExactKeys(expression, new Set(["kind", "task_id", "path", "pointer"]), label);
    const producer = taskById.get(expression.task_id);
    fail(producer?.kind === "agent", "invalid_graph", `${label} references unknown agent task ${expression.task_id}`);
    expression.path = validateRelativePath(expression.path, `${label}.path`);
    fail(producer.artifact_paths.includes(expression.path), "invalid_graph", `${label} references undeclared artifact ${expression.path}`);
    validateJsonPointer(expression.pointer, `${label}.pointer`);
    return;
  }
  if (expression.kind === "object") {
    assertExactKeys(expression, new Set(["kind", "entries"]), label);
    fail(expression.entries !== null && typeof expression.entries === "object" && !Array.isArray(expression.entries), "invalid_schema", `${label}.entries must be an object`);
    for (const [key, child] of Object.entries(expression.entries)) {
      fail(key.length > 0 && key.length <= 512, "invalid_schema", `${label}.entries has an invalid key`);
      validateReturnExpression(child, manifest, taskById, limits, counters, depth + 1, `${label}.entries.${key}`);
    }
    return;
  }
  if (expression.kind === "array") {
    assertExactKeys(expression, new Set(["kind", "items"]), label);
    fail(Array.isArray(expression.items), "invalid_schema", `${label}.items must be an array`);
    expression.items.forEach((child, index) => validateReturnExpression(child, manifest, taskById, limits, counters, depth + 1, `${label}.items[${index}]`));
    return;
  }
  throw new WorkflowError("invalid_schema", `${label}.kind is unsupported`);
}

function validateReturnBinding(binding, manifest) {
  assertExactKeys(binding, new Set(["schema_version", "workflow_call_sha256", "expression", "schema", "limits"]), "return_binding");
  fail(binding.schema_version === "dynamic-workflow-return-binding/v1", "unsupported_schema", "Unsupported return binding schema");
  fail(SHA256_PATTERN.test(binding.workflow_call_sha256 ?? ""), "invalid_schema", "return_binding.workflow_call_sha256 is invalid");
  assertExactKeys(binding.limits, new Set(["max_depth", "max_nodes"]), "return_binding.limits");
  assertInteger(binding.limits.max_depth, 1, 32, "return_binding.limits.max_depth");
  assertInteger(binding.limits.max_nodes, 1, 4096, "return_binding.limits.max_nodes");
  validateReturnSchema(binding.schema, "return_binding.schema");
  validateReturnExpression(binding.expression, manifest, new Map(manifest.tasks.map((task) => [task.id, task])), binding.limits, { nodes: 0 });
}

function loadResultContractSchema(task, record, runDir) {
  const contract = task.result_contract;
  if (contract.schema.kind === "inline") return contract.schema.document;
  fail(record.input_manifest_path !== null, "result_contract_missing", `${task.id}: input manifest is missing`);
  const inputManifest = readJson(assertPathInsideRun(runDir, record.input_manifest_path));
  const schemaPath = inputManifest.result_contract.schema_path;
  fail(typeof schemaPath === "string", "result_contract_missing", `${task.id}: frozen result schema path is missing`);
  const absolute = assertPathInsideRun(runDir, schemaPath);
  const snapshot = readJsonSnapshot(absolute);
  fail(snapshot.sha256 === contract.schema.sha256, "result_contract_drift", `${task.id}: frozen result schema drifted`);
  return snapshot.value;
}

function validateResultContractValue(task, result, runDir, record) {
  const contract = task.result_contract;
  const schema = loadResultContractSchema(task, record, runDir);
  let value = result;
  let targetPath = task.output_path;
  if (contract.target.kind === "json_artifact") {
    const artifact = result.artifacts.find((candidate) => pathKey(candidate.path) === pathKey(contract.target.artifact_path));
    fail(artifact !== undefined, "result_contract_missing", `${task.id}: result contract artifact is missing`);
    targetPath = artifact.path;
    value = readJson(assertPathInsideRun(runDir, targetPath));
  }
  const errors = jsonSchemaErrors(schema, value);
  fail(errors.length === 0, "result_contract_invalid", `${task.id}: ${errors.join("; ")}`);
  const targetAbsolute = assertPathInsideRun(runDir, targetPath);
  return {
    contract_sha256: sha256Text(canonicalJson(contract)),
    schema_sha256: contract.schema.kind === "inline" ? contract.schema.canonical_sha256 : contract.schema.sha256,
    target_kind: contract.target.kind,
    target_path: targetPath,
    target_sha256: sha256File(targetAbsolute),
    validated_at: isoNow(),
  };
}

function revalidateResultContract(task, record, runDir) {
  fail(record.result_contract_receipt !== null, "result_contract_missing", `${task.id}: result contract receipt is missing`);
  const resultPath = assertPathInsideRun(runDir, record.result_path);
  const current = validateResultContractValue(task, readJson(resultPath), runDir, record);
  for (const key of ["contract_sha256", "schema_sha256", "target_kind", "target_path", "target_sha256"]) {
    fail(current[key] === record.result_contract_receipt[key], "result_contract_drift", `${task.id}: result contract receipt mismatch for ${key}`);
  }
}

function validateInputRef(input, label) {
  fail(input !== null && typeof input === "object" && !Array.isArray(input), "invalid_schema", `${label} must be an object`);
  if (input.kind === "argument") {
    assertExactKeys(input, new Set(["kind", "key"]), label);
    assertString(input.key, `${label}.key`);
    return;
  }
  if (input.kind === "task_result" || input.kind === "optional_task_result") {
    assertExactKeys(input, new Set(["kind", "task_id"]), label);
    fail(ID_PATTERN.test(input.task_id ?? ""), "invalid_schema", `${label}.task_id is invalid`);
    return;
  }
  if (input.kind === "artifact" || input.kind === "optional_artifact") {
    assertExactKeys(input, new Set(["kind", "task_id", "path"]), label);
    fail(ID_PATTERN.test(input.task_id ?? ""), "invalid_schema", `${label}.task_id is invalid`);
    input.path = validateRelativePath(input.path, `${label}.path`);
    return;
  }
  if (input.kind === "file") {
    assertExactKeys(input, new Set(["kind", "path", "sha256"]), label);
    assertString(input.path, `${label}.path`);
    fail(isAbsolute(input.path), "unsafe_path", `${label}.path must be absolute`);
    fail(SHA256_PATTERN.test(input.sha256 ?? ""), "invalid_schema", `${label}.sha256 is invalid`);
    return;
  }
  throw new WorkflowError("invalid_schema", `${label}.kind is invalid`);
}

function validateHumanGate(task, baseKeys) {
  assertExactKeys(task, new Set([...baseKeys, "action", "targets", "scope", "action_package"]), task.id);
  assertString(task.action, `${task.id}.action`);
  fail(Array.isArray(task.targets) && task.targets.length > 0, "invalid_schema", `${task.id}: targets required`);
  fail(new Set(task.targets).size === task.targets.length, "invalid_schema", `${task.id}: duplicate target`);
  task.targets.forEach((target) => assertString(target, `${task.id}.targets`));
  fail(Array.isArray(task.scope) && task.scope.length > 0, "invalid_schema", `${task.id}: scope required`);
  fail(new Set(task.scope).size === task.scope.length, "invalid_schema", `${task.id}: duplicate scope entry`);
  task.scope.forEach((entry) => assertString(entry, `${task.id}.scope`));
  if (task.action_package !== null) {
    assertExactKeys(task.action_package, new Set(["task_id", "path"]), `${task.id}.action_package`);
    fail(ID_PATTERN.test(task.action_package.task_id ?? ""), "invalid_schema", `${task.id}: invalid action package task_id`);
    task.action_package.path = validateRelativePath(task.action_package.path, `${task.id}.action_package.path`);
  }
}

function calculateDepth(taskId, taskMap, cache, visiting) {
  if (cache.has(taskId)) {
    return cache.get(taskId);
  }
  fail(!visiting.has(taskId), "invalid_graph", `Cycle detected at ${taskId}`);
  visiting.add(taskId);
  const dependencies = taskMap.get(taskId).depends_on;
  const depth = dependencies.length === 0
    ? 1
    : 1 + Math.max(...dependencies.map((dependency) => calculateDepth(dependency, taskMap, cache, visiting)));
  visiting.delete(taskId);
  cache.set(taskId, depth);
  return depth;
}

function hasAncestor(taskId, ancestorId, taskMap, visited = new Set()) {
  if (visited.has(taskId)) {
    return false;
  }
  visited.add(taskId);
  for (const dependency of taskMap.get(taskId).depends_on) {
    if (dependency === ancestorId || hasAncestor(dependency, ancestorId, taskMap, visited)) {
      return true;
    }
  }
  return false;
}

function validateManifest(manifest) {
  const topKeys = new Set(["schema_version", "workflow_id", "description", "translation_mode", "invocation_mode", "source", "arguments", "limits", "required_capabilities", "independent_pairs", "tasks", "return_binding"]);
  assertExactKeys(manifest, topKeys, "manifest");
  fail(manifest.schema_version === "dynamic-workflow/v1", "unsupported_schema", "Unsupported manifest schema_version");
  fail(ID_PATTERN.test(manifest.workflow_id ?? ""), "invalid_schema", "Invalid workflow_id");
  if (manifest.description !== undefined) assertString(manifest.description, "manifest.description");
  fail(["direct", "translated"].includes(manifest.translation_mode), "invalid_schema", "Invalid translation_mode");
  const invocationMode = manifest.invocation_mode ?? "direct";
  fail(["direct", "skill_bridge"].includes(invocationMode), "invalid_schema", "Invalid invocation_mode");
  validateSource(manifest.source);
  fail(manifest.arguments !== null && typeof manifest.arguments === "object" && !Array.isArray(manifest.arguments), "invalid_schema", "arguments must be an object");
  validateLimits(manifest.limits);
  validateCapabilitiesRequired(manifest.required_capabilities);
  fail(Array.isArray(manifest.tasks) && manifest.tasks.length > 0, "invalid_schema", "tasks must be non-empty");
  fail(manifest.tasks.length <= manifest.limits.max_tasks, "budget_exceeded", "Task count exceeds max_tasks");
  const taskIds = new Set(manifest.tasks.map((task) => task.id));
  fail(taskIds.size === manifest.tasks.length, "invalid_graph", "Duplicate task id");
  manifest.tasks.forEach((task) => validateTaskShape(task, taskIds));
  for (const task of manifest.tasks.filter((candidate) => candidate.kind === "agent")) {
    fail(!task.prompt.includes(manifest.source.path), "unsafe_prompt_input", `${task.id}: prompt references the live workflow source path`);
  }
  validateGraph(manifest, taskIds);
  if (invocationMode === "skill_bridge") {
    fail(manifest.return_binding !== undefined, "invalid_schema", "skill_bridge requires return_binding");
    validateReturnBinding(manifest.return_binding, manifest);
  } else {
    fail(manifest.return_binding === undefined, "invalid_schema", "return_binding requires invocation_mode=skill_bridge");
  }
  return manifest;
}

function validateSource(source) {
  assertExactKeys(source, new Set(["path", "sha256", "format"]), "source");
  assertString(source.path, "source.path");
  fail(isAbsolute(source.path), "unsafe_path", "source.path must be absolute");
  fail(SHA256_PATTERN.test(source.sha256 ?? ""), "invalid_schema", "source.sha256 must be lowercase SHA-256");
  assertString(source.format, "source.format");
}

function validateLimits(limits) {
  assertExactKeys(limits, new Set(["max_parallel", "max_agent_runs", "max_tasks", "max_depth"]), "limits");
  assertInteger(limits.max_parallel, 1, 16, "limits.max_parallel");
  assertInteger(limits.max_agent_runs, 1, 1000, "limits.max_agent_runs");
  assertInteger(limits.max_tasks, 1, 1000, "limits.max_tasks");
  assertInteger(limits.max_depth, 1, 64, "limits.max_depth");
}

function validateCapabilitiesRequired(capabilities) {
  fail(Array.isArray(capabilities), "invalid_schema", "required_capabilities must be an array");
  fail(new Set(capabilities).size === capabilities.length, "invalid_schema", "required_capabilities has duplicates");
  capabilities.forEach((capability) => fail(CAPABILITY_KEYS.has(capability), "invalid_schema", `Unknown capability: ${capability}`));
  for (const required of ["native_collaboration", "spawn", "collect_or_wait", "stable_handle"]) {
    fail(capabilities.includes(required), "invalid_schema", `Missing core capability declaration: ${required}`);
  }
}

function validateGraph(manifest, taskIds) {
  const taskMap = new Map(manifest.tasks.map((task) => [task.id, task]));
  const depths = new Map();
  for (const taskId of taskIds) {
    calculateDepth(taskId, taskMap, depths, new Set());
  }
  fail(Math.max(...depths.values()) <= manifest.limits.max_depth, "budget_exceeded", "Graph exceeds max_depth");
  const agentCount = manifest.tasks.filter((task) => task.kind === "agent").length;
  fail(agentCount <= manifest.limits.max_agent_runs, "budget_exceeded", "Agent task count exceeds max_agent_runs");
  const outputs = manifest.tasks
    .filter((task) => task.kind === "agent")
    .flatMap((task) => [task.output_path, ...task.artifact_paths])
    .map(pathKey);
  for (let index = 0; index < outputs.length; index += 1) {
    for (let other = index + 1; other < outputs.length; other += 1) {
      fail(!pathsOverlap(outputs[index], outputs[other]), "unsafe_path", `Agent output paths overlap: ${outputs[index]} and ${outputs[other]}`);
    }
  }
  for (const path of outputs) {
    const root = pathKey(path.split(/[\\/]/u)[0]);
    const controllerPaths = [...RESERVED_ROOT_FILES, ...RESERVED_ROOT_DIRECTORIES];
    fail(!controllerPaths.some((controllerPath) => pathsOverlap(path, controllerPath)) && !RESERVED_ROOT_DIRECTORIES.has(root), "unsafe_path", `Agent output targets controller-owned path: ${path}`);
  }
  for (const task of manifest.tasks) {
    if (task.when) {
      const conditionSource = taskMap.get(task.when.task_id);
      fail(conditionSource?.kind === "agent", "invalid_graph", `${task.id}: condition source must be an agent task`);
      if (Object.hasOwn(task.when, "artifact_path")) {
        fail(!conditionSource.accepted_outcomes.includes("revise"), "invalid_graph", `${task.id}: artifact condition source cannot have a revise outcome`);
        fail(conditionSource.result_contract.target.kind === "json_artifact" && pathKey(conditionSource.result_contract.target.artifact_path) === pathKey(task.when.artifact_path), "invalid_graph", `${task.id}: artifact condition must use the source's validated JSON artifact`);
        fail(task.inputs.some((input) => ["artifact", "optional_artifact"].includes(input.kind) && input.task_id === task.when.task_id && pathKey(input.path) === pathKey(task.when.artifact_path)), "invalid_graph", `${task.id}: artifact condition must also be a typed task input`);
      }
    }
    if (task.kind === "agent" && task.approval_gate_id !== null) {
      const gate = taskMap.get(task.approval_gate_id);
      fail(gate?.kind === "human_gate", "missing_human_gate", `${task.id}: approval_gate_id is not a human gate`);
      fail(hasAncestor(task.id, task.approval_gate_id, taskMap), "missing_human_gate", `${task.id}: approval gate is not an ancestor`);
    }
    if (task.kind === "agent" && task.accepted_outcomes.includes("revise")) {
      const consumers = manifest.tasks.filter((candidate) => candidate.depends_on.includes(task.id));
      fail(consumers.some((consumer) => consumer.when?.task_id === task.id && consumer.when.outcomes?.includes("revise")), "invalid_graph", `${task.id}: revise outcome has no explicit handler`);
      fail(consumers.every((consumer) => consumer.when?.task_id === task.id && Array.isArray(consumer.when.outcomes)), "invalid_graph", `${task.id}: every direct consumer must branch explicitly on a revise-capable task`);
    }
    if (task.kind === "agent") {
      validateTaskInputs(task, manifest, taskMap);
    } else if (task.action_package !== null) {
      fail(task.depends_on.includes(task.action_package.task_id), "invalid_graph", `${task.id}: action package producer must be a direct dependency`);
      const producer = taskMap.get(task.action_package.task_id);
      fail(producer?.kind === "agent" && producer.artifact_paths.includes(task.action_package.path), "invalid_graph", `${task.id}: action package must reference a declared producer artifact`);
    }
  }
  validateIndependentPairs(manifest.independent_pairs ?? [], taskIds);
}

function validateTaskInputs(task, manifest, tasks) {
  const dependencies = new Set(task.depends_on);
  for (const input of task.inputs) {
    if (input.kind === "argument") {
      fail(Object.hasOwn(manifest.arguments, input.key), "invalid_graph", `${task.id}: unknown argument ${input.key}`);
      continue;
    }
    if (input.kind === "file") {
      continue;
    }
    fail(dependencies.has(input.task_id), "invalid_graph", `${task.id}: input producer ${input.task_id} must be a direct dependency`);
    const producer = tasks.get(input.task_id);
    fail(producer?.kind === "agent", "invalid_graph", `${task.id}: input producer ${input.task_id} must be an agent task`);
    const producerCanSkip = producer.when !== undefined || (producer.required === false && producer.requirements.on_unavailable === "skip_optional");
    const inputIsOptional = input.kind === "optional_task_result" || input.kind === "optional_artifact";
    const consumerSkipsWithProducer = task.when?.task_id === producer.id;
    fail(!producerCanSkip || inputIsOptional || consumerSkipsWithProducer, "invalid_graph", `${task.id}: skip-capable producer ${input.task_id} requires an optional input`);
    if (input.kind === "artifact" || input.kind === "optional_artifact") {
      fail(producer.artifact_paths.includes(input.path), "invalid_graph", `${task.id}: undeclared artifact input ${input.path}`);
    }
  }
}

function validateIndependentPairs(pairs, taskIds) {
  fail(Array.isArray(pairs), "invalid_schema", "independent_pairs must be an array");
  const normalized = new Set();
  for (const pair of pairs) {
    fail(Array.isArray(pair) && pair.length === 2, "invalid_schema", "independent pair must have two task ids");
    fail(pair[0] !== pair[1] && pair.every((id) => taskIds.has(id)), "invalid_graph", "Invalid independent pair");
    const key = [...pair].sort().join("::");
    fail(!normalized.has(key), "invalid_graph", `Duplicate independent pair: ${key}`);
    normalized.add(key);
  }
}

function validateCapabilitySnapshot(capabilities, manifest, enforceTaskRequirements = true) {
  const requiredKeys = [
    "schema_version",
    "spawn",
    "collect_or_wait",
    "stable_handle",
    "max_parallel",
    "observed_at",
    "filesystem_isolation",
    "tool_isolation",
    "external_mutation_enforcement",
    "source_trust",
    "secret_bearing",
    "fork_behavior",
    "semantic_capabilities",
    "permissions",
    "context_support",
    "diagnostics",
  ];
  const capabilityKeys = new Set([...requiredKeys, ...CAPABILITY_KEYS]);
  assertExactKeys(capabilities, capabilityKeys, "capabilities");
  requiredKeys.forEach((key) => fail(Object.hasOwn(capabilities, key), "invalid_schema", `Capability snapshot missing ${key}`));
  CAPABILITY_KEYS.forEach((key) => fail(Object.hasOwn(capabilities, key) && typeof capabilities[key] === "boolean", "invalid_schema", `Capability snapshot ${key} must be boolean`));
  fail(capabilities.schema_version === "dynamic-workflow-capabilities/v1", "unsupported_schema", "Unsupported capability schema");
  assertInteger(capabilities.max_parallel, 1, 1024, "capabilities.max_parallel");
  assertDateTime(capabilities.observed_at, "capabilities.observed_at");
  for (const key of ["filesystem_isolation", "tool_isolation", "external_mutation_enforcement"]) {
    fail(["enforced", "attested_not_enforced"].includes(capabilities[key]), "invalid_schema", `capabilities.${key} is invalid`);
  }
  fail(["trusted", "untrusted"].includes(capabilities.source_trust), "invalid_schema", "capabilities.source_trust is invalid");
  fail(typeof capabilities.secret_bearing === "boolean", "invalid_schema", "capabilities.secret_bearing must be boolean");
  assertExactKeys(capabilities.fork_behavior, new Set(["context_isolation", "model_context_inherited"]), "capabilities.fork_behavior");
  fail(["enforced", "attested_not_enforced"].includes(capabilities.fork_behavior.context_isolation), "invalid_schema", "capabilities.fork_behavior.context_isolation is invalid");
  fail(typeof capabilities.fork_behavior.model_context_inherited === "boolean", "invalid_schema", "capabilities.fork_behavior.model_context_inherited must be boolean");
  fail(capabilities.semantic_capabilities !== null && typeof capabilities.semantic_capabilities === "object" && !Array.isArray(capabilities.semantic_capabilities), "invalid_schema", "capabilities.semantic_capabilities must be an object");
  for (const [id, value] of Object.entries(capabilities.semantic_capabilities)) {
    fail(id.length <= 160 && SEMANTIC_ID_PATTERN.test(id), "invalid_schema", `Invalid semantic capability id: ${id}`);
    fail(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_schema", `Invalid semantic capability: ${id}`);
    assertExactKeys(value, new Set(["availability", "enforcement", "constraints", "reason"]), `capabilities.semantic_capabilities.${id}`);
    fail(["supported", "limited", "unsupported"].includes(value.availability), "invalid_schema", `Invalid semantic capability: ${id}`);
    if (value.enforcement !== undefined) fail(["enforced", "attested_not_enforced", "unsupported"].includes(value.enforcement), "invalid_schema", `Invalid semantic capability enforcement: ${id}`);
    if (value.constraints !== undefined) fail(value.constraints !== null && typeof value.constraints === "object" && !Array.isArray(value.constraints), "invalid_schema", `Invalid semantic capability constraints: ${id}`);
    if (value.reason !== undefined) assertString(value.reason, `capabilities.semantic_capabilities.${id}.reason`);
  }
  fail(capabilities.permissions !== null && typeof capabilities.permissions === "object" && !Array.isArray(capabilities.permissions), "invalid_schema", "capabilities.permissions must be an object");
  for (const [id, value] of Object.entries(capabilities.permissions)) {
    fail(id.length <= 160 && SEMANTIC_ID_PATTERN.test(id), "invalid_schema", `Invalid permission id: ${id}`);
    fail(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_schema", `Invalid permission: ${id}`);
    assertExactKeys(value, new Set(["status", "enforcement", "scope", "reason"]), `capabilities.permissions.${id}`);
    fail(["granted", "denied", "requires_human_gate"].includes(value.status), "invalid_schema", `Invalid permission: ${id}`);
    fail(["enforced", "attested_not_enforced"].includes(value.enforcement), "invalid_schema", `Invalid permission enforcement: ${id}`);
    if (value.scope !== undefined) fail(value.scope !== null && typeof value.scope === "object" && !Array.isArray(value.scope), "invalid_schema", `Invalid permission scope: ${id}`);
    if (value.reason !== undefined) assertString(value.reason, `capabilities.permissions.${id}.reason`);
  }
  assertExactKeys(capabilities.context_support, new Set(["fresh", "recent", "all"]), "capabilities.context_support");
  fail(typeof capabilities.context_support.fresh === "boolean" && typeof capabilities.context_support.all === "boolean", "invalid_schema", "capabilities.context_support flags must be boolean");
  assertExactKeys(capabilities.context_support.recent, new Set(["supported", "max_turns"]), "capabilities.context_support.recent");
  fail(typeof capabilities.context_support.recent.supported === "boolean", "invalid_schema", "capabilities.context_support.recent.supported must be boolean");
  fail(capabilities.context_support.recent.max_turns === null || Number.isInteger(capabilities.context_support.recent.max_turns) && capabilities.context_support.recent.max_turns >= 1 && capabilities.context_support.recent.max_turns <= 1000, "invalid_schema", "capabilities.context_support.recent.max_turns is invalid");
  fail(capabilities.context_support.recent.supported ? Number.isInteger(capabilities.context_support.recent.max_turns) : capabilities.context_support.recent.max_turns === null, "invalid_schema", "capabilities.context_support.recent supported/max_turns combination is invalid");
  fail(capabilities.diagnostics !== null && typeof capabilities.diagnostics === "object" && !Array.isArray(capabilities.diagnostics), "invalid_schema", "capabilities.diagnostics must be an object");
  for (const capability of manifest.required_capabilities) {
    fail(capabilities[capability] === true, "unsupported_runtime", `Required capability unavailable: ${capability}`);
  }
  if (capabilities.source_trust === "untrusted" || capabilities.secret_bearing) {
    const enforced = capabilities.filesystem_isolation === "enforced"
      && capabilities.tool_isolation === "enforced"
      && capabilities.external_mutation_enforcement === "enforced"
      && capabilities.fork_behavior.context_isolation === "enforced"
      && capabilities.fork_behavior.model_context_inherited === false;
    fail(enforced, "unsupported_runtime", "Untrusted or secret-bearing workflows require enforced filesystem, tool, external-mutation, and fresh-context isolation");
  }
  if (enforceTaskRequirements) {
    for (const task of manifest.tasks.filter((candidate) => candidate.kind === "agent")) {
      const assessment = assessTaskCapabilities(task, capabilities);
      if (!assessment.available && task.requirements.on_unavailable !== "skip_optional") {
        fail(false, "unsupported_runtime", `${task.id}: ${assessment.reasons.join(", ")}`);
      }
    }
  }
}

function assessTaskCapabilities(task, capabilities) {
  const reasons = [];
  for (const id of task.requirements.semantic_capabilities) {
    if (capabilities.semantic_capabilities[id]?.availability !== "supported") reasons.push(`semantic capability unavailable: ${id}`);
  }
  for (const id of task.requirements.permissions) {
    if (capabilities.permissions[id]?.status !== "granted") reasons.push(`permission unavailable: ${id}`);
  }
  const policy = task.context_policy;
  if (policy.mode === "fresh" && !(capabilities.context_support.fresh === true && capabilities.fork_behavior.model_context_inherited === false)) reasons.push("fresh context unavailable");
  if (policy.mode === "recent" && !(capabilities.context_support.recent.supported === true && capabilities.context_support.recent.max_turns !== null && capabilities.context_support.recent.max_turns >= policy.turns)) reasons.push(`recent(${policy.turns}) context unavailable`);
  if (policy.mode === "all" && capabilities.context_support.all !== true) reasons.push("all context unavailable");
  return { available: reasons.length === 0, reasons };
}

function validateTranslationReview(review, manifest, manifestPath, receipt = undefined) {
  const keys = new Set(["schema_version", "source_sha256", "manifest_sha256", "invocation_id", "translator_handle", "reviewer_handle", "reviewed_at", "verdict", "findings"]);
  assertExactKeys(review, keys, "translation review");
  fail(review.schema_version === "dynamic-workflow-translation-review/v1", "unsupported_schema", "Unsupported translation review schema");
  fail(review.source_sha256 === manifest.source.sha256, "translation_review_crosswire", "Translation review source hash mismatch");
  fail(review.manifest_sha256 === sha256Text(canonicalJson(readJson(manifestPath))), "translation_review_crosswire", "Translation review manifest canonical hash mismatch");
  assertString(review.invocation_id, "translation review invocation_id");
  fail(review.translator_handle === null || typeof review.translator_handle === "string" && review.translator_handle.length > 0, "invalid_schema", "Invalid translator handle");
  assertString(review.reviewer_handle, "translation review reviewer_handle");
  assertDateTime(review.reviewed_at, "translation review reviewed_at");
  fail(review.translator_handle === null || review.translator_handle !== review.reviewer_handle, "reviewer_not_independent", "Translator and contract reviewer must use different handles");
  const expectedReceiptMode = manifest.translation_mode;
  if (receipt !== undefined) fail(receipt.translation_mode === expectedReceiptMode, "translation_review_crosswire", "Translation receipt mode does not match manifest");
  fail(manifest.translation_mode === "direct" ? review.translator_handle === null : review.translator_handle !== null, "translation_review_crosswire", "Translation mode does not match translator handle boundary");
  fail(review.verdict === "pass", "translation_review_failed", `Translation review verdict is ${review.verdict}`);
  validateStringArray(review.findings, "translation review findings");
}

function validateCallerPhaseOwnership(ownership, label) {
  assertExactKeys(ownership, new Set(["owner", "pre_workflow", "post_workflow", "human_gates"]), label);
  fail(ownership.owner === "caller_skill", "invalid_schema", `${label}.owner must be caller_skill`);
  for (const key of ["pre_workflow", "post_workflow", "human_gates"]) {
    validateStringArray(ownership[key], `${label}.${key}`);
    fail(ownership[key].length <= 128 && new Set(ownership[key]).size === ownership[key].length, "invalid_schema", `${label}.${key} is not a bounded unique list`);
    fail(ownership[key].every((item) => item.length <= 512), "invalid_schema", `${label}.${key} contains an oversized item`);
  }
}

function validateNativeWorkflowObservation(observation, label) {
  assertExactKeys(observation, new Set(["attempted", "available", "observed_at", "evidence"]), label);
  fail(observation.attempted === false, "native_workflow_attempted", "Compatibility bridge cannot follow an attempted native Workflow invocation");
  fail(observation.available === false, "native_workflow_available", "Compatibility bridge must not run when native Workflow is available");
  assertDateTime(observation.observed_at, `${label}.observed_at`);
  validateStringArray(observation.evidence, `${label}.evidence`);
  fail(observation.evidence.length >= 1 && observation.evidence.length <= 128 && new Set(observation.evidence).size === observation.evidence.length, "invalid_schema", `${label}.evidence is not a bounded unique list`);
  fail(observation.evidence.every((item) => item.length <= 512), "invalid_schema", `${label}.evidence contains an oversized item`);
}

function workflowCallBinding(call, path, sha256) {
  return {
    receipt: { path, sha256 },
    caller_phase_ownership: call.caller_phase_ownership,
    native_workflow_observation: call.native_workflow_observation,
  };
}

function resolveDeclaredWorkflowSource(root, declared) {
  fail(typeof declared === "string" && !declared.includes("\0"), "unsafe_path", "Workflow declared_script_path contains NUL");
  const marker = "[SKILL_DIR]";
  if (declared.startsWith(marker)) {
    fail(declared === marker || declared.startsWith(`${marker}/`) || declared.startsWith(`${marker}\\`), "ambiguous_source_path", "[SKILL_DIR] must be a complete leading path segment");
    fail(declared.indexOf(marker, marker.length) === -1, "ambiguous_source_path", "Workflow declared_script_path contains multiple [SKILL_DIR] markers");
    return resolve(root, declared.slice(marker.length).replace(/^[/\\]+/u, ""));
  }
  fail(!declared.includes(marker), "ambiguous_source_path", "[SKILL_DIR] may appear only as the leading segment");
  return isAbsolute(declared) ? resolve(declared) : resolve(root, declared);
}

function validateWorkflowCallDocument(call, manifest, rawSha256, callPath) {
  assertExactKeys(call, new Set(["schema_version", "call_id", "invoking_skill", "native_workflow_observation", "workflow", "arguments", "caller_phase_ownership"]), "workflow call");
  fail(call.schema_version === "dynamic-workflow-call/v1", "unsupported_schema", "Unsupported workflow call schema");
  fail(CALL_ID_PATTERN.test(call.call_id ?? ""), "invalid_schema", "Workflow call call_id is invalid");
  assertExactKeys(call.invoking_skill, new Set(["root", "skill_md"]), "workflow call invoking_skill");
  const root = resolve(call.invoking_skill.root ?? "");
  fail(isAbsolute(call.invoking_skill.root ?? "") && root === call.invoking_skill.root, "unsafe_path", "Workflow caller root must be a normalized absolute path");
  fail(existsSync(root) && statSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), "unsafe_path", "Workflow caller root must be a non-symlink directory");
  fail(!pathsOverlap(callPath, root), "unsafe_path", "Workflow call receipt must be outside the caller skill install tree");
  fail(!pathsOverlap(callPath, RUNNER_SKILL_ROOT), "unsafe_path", "Workflow call receipt must be outside the runner skill install tree");
  assertExactKeys(call.invoking_skill.skill_md, new Set(["path", "sha256"]), "workflow call skill_md");
  const skillMd = join(root, "SKILL.md");
  fail(call.invoking_skill.skill_md.path === skillMd && SHA256_PATTERN.test(call.invoking_skill.skill_md.sha256 ?? ""), "caller_crosswire", "Workflow caller SKILL.md binding is invalid");
  assertNoSymlinkAncestors(skillMd, "Workflow caller SKILL.md", root);
  fail(existsSync(skillMd) && statSync(skillMd).isFile() && !lstatSync(skillMd).isSymbolicLink(), "unsafe_path", "Workflow caller SKILL.md must be a regular non-symlink file");
  fail(sha256File(skillMd) === call.invoking_skill.skill_md.sha256, "caller_drift", "Workflow caller SKILL.md hash mismatch");
  validateNativeWorkflowObservation(call.native_workflow_observation, "workflow call native_workflow_observation");
  validateCallerPhaseOwnership(call.caller_phase_ownership, "workflow call caller_phase_ownership");
  assertExactKeys(call.workflow, new Set(["declared_script_path", "resolved_source"]), "workflow call workflow");
  assertString(call.workflow.declared_script_path, "workflow call declared_script_path");
  assertExactKeys(call.workflow.resolved_source, new Set(["path", "sha256"]), "workflow call resolved_source");
  const expectedSource = resolveDeclaredWorkflowSource(root, call.workflow.declared_script_path);
  const sourceRelation = relative(root, expectedSource);
  fail(sourceRelation !== "" && sourceRelation !== ".." && !sourceRelation.startsWith(`..${sep}`) && !isAbsolute(sourceRelation), "unsafe_path", "Workflow source escapes caller root");
  fail(call.workflow.resolved_source.path === expectedSource && SHA256_PATTERN.test(call.workflow.resolved_source.sha256 ?? ""), "source_crosswire", "Workflow resolved source binding is invalid");
  assertNoSymlinkAncestors(expectedSource, "Workflow source", root);
  fail(existsSync(expectedSource) && statSync(expectedSource).isFile() && !lstatSync(expectedSource).isSymbolicLink(), "unsafe_path", "Workflow source must be a regular non-symlink file");
  fail(sha256File(expectedSource) === call.workflow.resolved_source.sha256, "source_drift", "Workflow source hash mismatch");
  fail(call.workflow.resolved_source.path === manifest.source.path && call.workflow.resolved_source.sha256 === manifest.source.sha256, "workflow_call_crosswire", "Workflow call source differs from manifest");
  for (const task of manifest.tasks.filter((candidate) => candidate.kind === "agent")) {
    fail(!task.prompt.includes(root), "unsafe_prompt_input", `${task.id}: prompt references the live caller skill tree`);
  }
  assertExactKeys(call.arguments, new Set(["value", "canonical_sha256"]), "workflow call arguments");
  fail(call.arguments.value !== null && typeof call.arguments.value === "object" && !Array.isArray(call.arguments.value), "invalid_schema", "Workflow call arguments.value must be an object");
  fail(call.arguments.canonical_sha256 === sha256Text(canonicalJson(call.arguments.value)), "arguments_drift", "Workflow call argument hash mismatch");
  fail(canonicalJson(call.arguments.value) === canonicalJson(manifest.arguments), "arguments_crosswire", "Workflow call arguments differ from manifest");
  fail(manifest.return_binding?.workflow_call_sha256 === rawSha256, "workflow_call_crosswire", "Manifest is bound to a different workflow call receipt");
}

function validateWorkflowCallBinding(binding, expected, label) {
  assertExactKeys(binding, new Set(["receipt", "caller_phase_ownership", "native_workflow_observation"]), label);
  assertExactKeys(binding.receipt, new Set(["path", "sha256"]), `${label}.receipt`);
  assertString(binding.receipt.path, `${label}.receipt.path`);
  fail(SHA256_PATTERN.test(binding.receipt.sha256 ?? ""), "invalid_schema", `${label}.receipt.sha256 is invalid`);
  validateCallerPhaseOwnership(binding.caller_phase_ownership, `${label}.caller_phase_ownership`);
  validateNativeWorkflowObservation(binding.native_workflow_observation, `${label}.native_workflow_observation`);
  fail(canonicalJson(binding) === canonicalJson(expected), "translation_review_crosswire", `${label} differs from the exact workflow call boundary`);
}

function loadExternalWorkflowCall(options, manifest) {
  const bridge = (manifest.invocation_mode ?? "direct") === "skill_bridge";
  if (!bridge) {
    fail(options["workflow-call"] === undefined, "invalid_arguments", "--workflow-call is only valid for invocation_mode=skill_bridge");
    return null;
  }
  const requestedPath = resolve(requireOption(options, "workflow-call"));
  fail(existsSync(requestedPath) && statSync(requestedPath).isFile() && !lstatSync(requestedPath).isSymbolicLink(), "unsafe_path", "Workflow call receipt must be a regular non-symlink file");
  const path = realpathSync(requestedPath);
  const snapshot = readJsonSnapshot(path);
  validateWorkflowCallDocument(snapshot.value, manifest, snapshot.sha256, path);
  return { path, snapshot, binding: workflowCallBinding(snapshot.value, path, snapshot.sha256) };
}

function validateTranslationReviewInput(input, manifest, manifestPath, frozen = false, expectedWorkflowCall = null) {
  const keys = new Set(["schema_version", "source", "manifest"]);
  if (expectedWorkflowCall !== null) keys.add("workflow_call");
  assertExactKeys(input, keys, "translation review input");
  fail((expectedWorkflowCall === null) === (input.workflow_call === undefined), "translation_review_crosswire", "Translation review input workflow-call presence differs from invocation mode");
  fail(input.schema_version === "dynamic-workflow-translation-review-input/v1", "unsupported_schema", "Unsupported translation review input schema");
  assertExactKeys(input.source, new Set(["path", "sha256"]), "translation review input source");
  assertExactKeys(input.manifest, new Set(["path", "canonical_sha256"]), "translation review input manifest");
  fail(input.source.path === manifest.source.path && input.source.sha256 === manifest.source.sha256, "translation_review_crosswire", "Translation review source input mismatch");
  fail(isAbsolute(input.manifest.path), "unsafe_path", "Translation review manifest path must be absolute");
  if (!frozen) {
    fail(input.manifest.path === manifestPath, "translation_review_crosswire", "Translation review manifest path mismatch");
  }
  fail(input.manifest.canonical_sha256 === sha256Text(canonicalJson(manifest)), "translation_review_crosswire", "Translation review manifest input hash mismatch");
  if (expectedWorkflowCall !== null) validateWorkflowCallBinding(input.workflow_call, expectedWorkflowCall, "translation review input workflow_call");
}

function validateReceiptShape(receipt, frozen = false, expectWorkflowCall = false) {
  const keys = new Set(["schema_version", "invocation_id", "reviewer_handle", "context_policy", "parent_context_inherited", "translation_mode", "handle_boundary", "prompt", "input_manifest", "invoked_at"]);
  if (expectWorkflowCall) keys.add("workflow_call");
  if (frozen) {
    keys.add("original_receipt");
  }
  assertExactKeys(receipt, keys, "translation review receipt");
  fail(expectWorkflowCall === (receipt.workflow_call !== undefined), "translation_review_crosswire", "Translation review receipt workflow-call presence differs from invocation mode");
  fail(receipt.schema_version === "dynamic-workflow-translation-review-receipt/v1", "unsupported_schema", "Unsupported translation review receipt schema");
  assertString(receipt.invocation_id, "translation review receipt invocation_id");
  assertString(receipt.reviewer_handle, "translation review receipt reviewer_handle");
  fail(receipt.context_policy === "fresh" && receipt.parent_context_inherited === false, "reviewer_not_independent", "Translation reviewer must use fresh non-inherited context");
  fail(["direct", "translated"].includes(receipt.translation_mode), "invalid_schema", "translation review receipt translation_mode is invalid");
  fail(["runtime_enforced", "attested_not_enforced"].includes(receipt.handle_boundary), "invalid_schema", "translation review receipt handle_boundary is invalid");
  for (const [key, ref] of [["prompt", receipt.prompt], ["input_manifest", receipt.input_manifest]]) {
    assertExactKeys(ref, new Set(["path", "sha256"]), `translation review receipt ${key}`);
    assertString(ref.path, `translation review receipt ${key}.path`);
    fail(SHA256_PATTERN.test(ref.sha256 ?? ""), "invalid_schema", `translation review receipt ${key}.sha256 is invalid`);
  }
  if (frozen) {
    assertExactKeys(receipt.original_receipt, new Set(["path", "sha256"]), "translation review receipt original_receipt");
    assertString(receipt.original_receipt.path, "translation review receipt original_receipt.path");
    fail(SHA256_PATTERN.test(receipt.original_receipt.sha256 ?? ""), "invalid_schema", "translation review receipt original_receipt.sha256 is invalid");
  }
  assertDateTime(receipt.invoked_at, "translation review receipt invoked_at");
}

function validateExternalTranslationReceipt(receipt, review, manifest, manifestPath, workflowCall = null) {
  validateReceiptShape(receipt, false, workflowCall !== null);
  validateTranslationReview(review, manifest, manifestPath, receipt);
  fail(receipt.invocation_id === review.invocation_id && receipt.reviewer_handle === review.reviewer_handle, "translation_review_crosswire", "Translation review invocation receipt mismatch");
  fail(Date.parse(review.reviewed_at) > Date.parse(receipt.invoked_at), "translation_review_crosswire", "Translation review must be completed after invocation");
  for (const ref of [receipt.prompt, receipt.input_manifest]) {
    fail(isAbsolute(ref.path), "unsafe_path", "Translation review receipt paths must be absolute before freezing");
    fail(existsSync(ref.path) && statSync(ref.path).isFile(), "input_missing", `Translation review input missing: ${ref.path}`);
    fail(!lstatSync(ref.path).isSymbolicLink(), "unsafe_path", `Translation review input cannot be a symlink: ${ref.path}`);
    fail(sha256File(ref.path) === ref.sha256, "translation_review_crosswire", `Translation review receipt hash mismatch: ${ref.path}`);
  }
  if (workflowCall !== null) validateWorkflowCallBinding(receipt.workflow_call, workflowCall.binding, "translation review receipt workflow_call");
  validateTranslationReviewInput(readJson(receipt.input_manifest.path), manifest, manifestPath, false, workflowCall?.binding ?? null);
}

function validateFrozenTranslationReceipt(paths, review, manifest) {
  const bridge = (manifest.invocation_mode ?? "direct") === "skill_bridge";
  let frozenCall = null;
  let frozenBinding = null;
  if (bridge) {
    const snapshot = readJsonSnapshot(paths.translationWorkflowCall);
    validateWorkflowCallDocument(snapshot.value, manifest, snapshot.sha256, paths.translationWorkflowCall);
    frozenCall = snapshot;
    frozenBinding = workflowCallBinding(snapshot.value, "translation/workflow-call.json", snapshot.sha256);
  }
  const receipt = readJson(paths.translationReviewReceipt);
  validateReceiptShape(receipt, true, bridge);
  validateTranslationReview(review, manifest, paths.manifest, receipt);
  fail(receipt.invocation_id === review.invocation_id && receipt.reviewer_handle === review.reviewer_handle, "translation_review_crosswire", "Frozen translation review receipt mismatch");
  fail(Date.parse(review.reviewed_at) > Date.parse(receipt.invoked_at), "translation_review_crosswire", "Frozen translation review chronology is invalid");
  const expectedRefs = {
    prompt: { path: "translation/review-prompt", sha256: sha256File(paths.translationPrompt) },
    input_manifest: { path: "translation/review-input.json", sha256: sha256File(paths.translationInput) },
    original_receipt: { path: "translation/original-review-receipt.json", sha256: sha256File(paths.translationOriginalReceipt) },
  };
  fail(canonicalJson(receipt.prompt) === canonicalJson(expectedRefs.prompt), "translation_review_crosswire", "Frozen translation review prompt mismatch");
  fail(canonicalJson(receipt.input_manifest) === canonicalJson(expectedRefs.input_manifest), "translation_review_crosswire", "Frozen translation review input mismatch");
  fail(canonicalJson(receipt.original_receipt) === canonicalJson(expectedRefs.original_receipt), "translation_review_crosswire", "Original translation review receipt provenance mismatch");
  const originalReceipt = readJson(paths.translationOriginalReceipt);
  validateReceiptShape(originalReceipt, false, bridge);
  for (const key of ["schema_version", "invocation_id", "reviewer_handle", "context_policy", "parent_context_inherited", "translation_mode", "handle_boundary", "invoked_at"]) {
    fail(receipt[key] === originalReceipt[key], "translation_review_crosswire", `Frozen translation receipt changed ${key}`);
  }
  fail(receipt.prompt.sha256 === originalReceipt.prompt.sha256 && receipt.input_manifest.sha256 === originalReceipt.input_manifest.sha256, "translation_review_crosswire", "Frozen translation receipt changed reviewed bytes");
  if (bridge) {
    validateWorkflowCallBinding(receipt.workflow_call, frozenBinding, "frozen translation review receipt workflow_call");
    const originalExpected = workflowCallBinding(frozenCall.value, originalReceipt.workflow_call.receipt.path, frozenCall.sha256);
    validateWorkflowCallBinding(originalReceipt.workflow_call, originalExpected, "original translation review receipt workflow_call");
    validateTranslationReviewInput(readJson(paths.translationInput), manifest, paths.manifest, true, originalReceipt.workflow_call);
  } else {
    validateTranslationReviewInput(readJson(paths.translationInput), manifest, paths.manifest, true);
  }
}

function ensureSourceHash(manifest) {
  fail(existsSync(manifest.source.path), "source_missing", `Source does not exist: ${manifest.source.path}`);
  fail(!lstatSync(manifest.source.path).isSymbolicLink(), "unsafe_path", "Source cannot be a symlink");
  fail(statSync(manifest.source.path).isFile(), "source_missing", "Source is not a file");
  fail(sha256File(manifest.source.path) === manifest.source.sha256, "source_drift", "Source SHA-256 mismatch");
}

function initializeState(manifest, manifestSha, capabilitiesSha, capabilities, frozenParallel, effectiveParallel, effectiveAgentRuns) {
  const tasks = Object.fromEntries(manifest.tasks.map((task) => [task.id, {
    status: "pending",
    invocation_id: null,
    agent_handle: null,
    prepared_at: null,
    started_at: null,
    completed_at: null,
    result_path: null,
    result_sha256: null,
    input_manifest_path: null,
    input_manifest_sha256: null,
    outcome: null,
    result_contract_receipt: null,
    capability_assessment: task.kind === "agent" ? assessTaskCapabilities(task, capabilities) : null,
    gate: null,
  }]));
  return {
    schema_version: "dynamic-workflow-state/v1",
    run_id: randomUUID(),
    workflow_id: manifest.workflow_id,
    manifest_sha256: manifestSha,
    capabilities_sha256: capabilitiesSha,
    frozen_max_parallel: frozenParallel,
    active_capabilities: { path: CAPABILITIES_FILE, sha256: capabilitiesSha },
    capability_receipts: [{ path: CAPABILITIES_FILE, sha256: capabilitiesSha, observed_at: capabilities.observed_at, recorded_at: isoNow() }],
    translation_review_sha256: null,
    translation_review_receipt_sha256: null,
    workflow_call_sha256: null,
    effective_max_parallel: effectiveParallel,
    effective_max_agent_runs: effectiveAgentRuns,
    agent_runs_prepared: 0,
    status: "workflow_ready",
    created_at: isoNow(),
    updated_at: isoNow(),
    tasks,
    final_review_invocation: null,
    final_review: null,
    action_handoffs: [],
    events: [],
  };
}

function appendEvent(state, type, taskId, details = {}) {
  state.events.push({
    sequence: state.events.length + 1,
    at: isoNow(),
    type,
    task_id: taskId,
    details,
  });
  state.updated_at = isoNow();
}

function taskEvents(state, taskId, type) {
  return state.events.filter((event) => event.task_id === taskId && event.type === type);
}

function validateTerminalTaskLineage(task, record, state, runDir) {
  const resultEvents = taskEvents(state, task.id, "agent_result_recorded");
  const abortEvents = taskEvents(state, task.id, "agent_invocation_aborted");
  const skipEvents = taskEvents(state, task.id, "task_skipped");
  const blockedEvents = taskEvents(state, task.id, "task_blocked_by_dependency");
  const gateEvents = taskEvents(state, task.id, "human_gate_decided");
  if (record.status === "skipped") {
    fail(skipEvents.length === 1, "state_drift", `${task.id}: skipped state lacks one skip event`);
    const reason = skipEvents[0].details?.reason;
    if (reason === "condition_false") {
      fail(conditionState(task, state, runDir) === "false", "state_drift", `${task.id}: condition skip is no longer justified`);
    } else {
      fail(reason === "capability_unavailable" && task.kind === "agent" && task.required === false && task.requirements.on_unavailable === "skip_optional" && record.capability_assessment?.available === false, "state_drift", `${task.id}: capability skip is not justified`);
      fail(canonicalJson(skipEvents[0].details.details) === canonicalJson(record.capability_assessment.reasons), "state_drift", `${task.id}: capability skip reasons differ`);
    }
    return;
  }
  if (record.status === "approved" || record.status === "rejected") {
    fail(task.kind === "human_gate" && gateEvents.length === 1 && record.gate !== null, "state_drift", `${task.id}: gate terminal state lacks one decision event`);
    fail(record.gate.decision === (record.status === "approved" ? "approve" : "reject"), "state_drift", `${task.id}: gate decision differs from status`);
    fail(canonicalJson(gateEvents[0].details) === canonicalJson(record.gate), "state_drift", `${task.id}: gate event differs from state receipt`);
    fail(record.gate.action === task.action && canonicalJson(record.gate.targets) === canonicalJson(task.targets) && canonicalJson(record.gate.scope) === canonicalJson(task.scope), "state_drift", `${task.id}: gate receipt differs from manifest`);
    fail(record.gate.external_authorization === false && record.gate.requires_reapproval === (record.gate.action_package !== null), "state_drift", `${task.id}: gate authority boundary changed`);
    return;
  }
  if (record.status === "completed" || record.status === "resolved") {
    fail(task.kind === "agent" && resultEvents.length === 1, "state_drift", `${task.id}: successful terminal state lacks one result event`);
    fail(task.accepted_outcomes.includes(record.outcome), "state_drift", `${task.id}: terminal outcome is not accepted`);
    fail(record.status === (record.outcome === "pass" ? "completed" : "resolved"), "state_drift", `${task.id}: terminal status differs from outcome`);
    const details = resultEvents[0].details;
    fail(details.invocation_id === record.invocation_id && details.outcome === record.outcome && details.result_sha256 === record.result_sha256, "state_drift", `${task.id}: result event differs from state`);
    fail(canonicalJson(details.result_contract) === canonicalJson(record.result_contract_receipt), "state_drift", `${task.id}: result contract receipt differs from event`);
    return;
  }
  if (record.status === "failed") {
    const fromAbort = abortEvents.length === 1 && abortEvents[0].details?.invocation_id === record.invocation_id;
    const fromResult = resultEvents.length === 1 && resultEvents[0].details?.outcome === record.outcome && !task.accepted_outcomes.includes(record.outcome);
    fail(task.kind === "agent" && (fromAbort !== fromResult), "state_drift", `${task.id}: failed state lacks one unambiguous provenance event`);
    return;
  }
  if (record.status === "blocked") {
    const dependencyBlocked = blockedEvents.length === 1 && task.depends_on.some((id) => ["failed", "blocked", "rejected"].includes(state.tasks[id]?.status));
    const resultBlocked = task.kind === "agent" && resultEvents.length === 1 && resultEvents[0].details?.outcome === record.outcome && !task.accepted_outcomes.includes(record.outcome);
    fail(dependencyBlocked !== resultBlocked, "state_drift", `${task.id}: blocked state lacks one unambiguous provenance event`);
  }
}

function validateAgentInvocationLineage(task, record, state) {
  const preparedEvents = taskEvents(state, task.id, "agent_invocation_prepared");
  const boundEvents = taskEvents(state, task.id, "agent_handle_bound");
  const resultEvents = taskEvents(state, task.id, "agent_result_recorded");
  const abortEvents = taskEvents(state, task.id, "agent_invocation_aborted");
  if (record.invocation_id === null) {
    fail(
      record.agent_handle === null &&
        record.prepared_at === null &&
        record.started_at === null &&
        record.completed_at === null &&
        record.result_path === null &&
        record.result_sha256 === null &&
        record.input_manifest_path === null &&
        record.input_manifest_sha256 === null &&
        record.outcome === null &&
        record.result_contract_receipt === null &&
        preparedEvents.length === 0 &&
        boundEvents.length === 0 &&
        resultEvents.length === 0 &&
        abortEvents.length === 0,
      "state_drift",
      `${task.id}: unprepared invocation carries execution state`,
    );
    return;
  }
  fail(INVOCATION_PATTERN.test(record.invocation_id), "state_drift", `${task.id}: invocation id is invalid`);
  assertDateTime(record.prepared_at, `${task.id}.prepared_at`);
  fail(typeof record.input_manifest_path === "string" && SHA256_PATTERN.test(record.input_manifest_sha256 ?? ""), "state_drift", `${task.id}: prepared input binding is invalid`);
  fail(preparedEvents.length === 1, "state_drift", `${task.id}: invocation lacks one prepared event`);
  fail(
    canonicalJson(preparedEvents[0].details) === canonicalJson({
      invocation_id: record.invocation_id,
      input_manifest_sha256: record.input_manifest_sha256,
    }),
    "state_drift",
    `${task.id}: prepared event differs from invocation state`,
  );
  fail(Date.parse(preparedEvents[0].at) >= Date.parse(record.prepared_at), "state_drift", `${task.id}: prepared event precedes prepared_at`);
  if (record.agent_handle === null) {
    fail(record.started_at === null && boundEvents.length === 0, "state_drift", `${task.id}: unbound invocation carries bound state`);
    fail(record.status === "prepared" || (record.status === "failed" && abortEvents.length === 1), "state_drift", `${task.id}: invocation requires an agent handle`);
  } else {
    assertString(record.agent_handle, `${task.id}.agent_handle`);
    assertDateTime(record.started_at, `${task.id}.started_at`);
    fail(
      boundEvents.length === 1 && canonicalJson(boundEvents[0].details) === canonicalJson({
        invocation_id: record.invocation_id,
        agent_handle: record.agent_handle,
      }),
      "state_drift",
      `${task.id}: bound event differs from invocation state`,
    );
    fail(boundEvents[0].sequence > preparedEvents[0].sequence && Date.parse(boundEvents[0].at) >= Date.parse(record.started_at), "state_drift", `${task.id}: handle binding order is invalid`);
  }
  if (TERMINAL.has(record.status)) {
    assertDateTime(record.completed_at, `${task.id}.completed_at`);
    const terminalEvents = [...resultEvents, ...abortEvents];
    fail(terminalEvents.length === 1, "state_drift", `${task.id}: terminal invocation lacks one completion event`);
    fail(terminalEvents[0].sequence > preparedEvents[0].sequence && Date.parse(terminalEvents[0].at) >= Date.parse(record.completed_at), "state_drift", `${task.id}: completion event order is invalid`);
  } else {
    fail(record.completed_at === null && resultEvents.length === 0 && abortEvents.length === 0, "state_drift", `${task.id}: active invocation carries terminal state`);
  }
}

function validateFinalReviewStateShape(state) {
  const invocation = state.final_review_invocation;
  const finalReview = state.final_review;
  const preparedEvents = taskEvents(state, null, "final_review_invocation_prepared");
  const boundEvents = taskEvents(state, null, "final_review_handle_bound");
  const recordedEvents = taskEvents(state, null, "final_review_recorded");
  if (invocation === null) {
    fail(finalReview === null && preparedEvents.length === 0 && boundEvents.length === 0 && recordedEvents.length === 0, "state_drift", "Final review state exists without an invocation");
    return;
  }
  assertExactKeys(invocation, new Set([
    "invocation_id", "agent_handle", "status", "prepared_at", "started_at", "prompt_path", "prompt_sha256",
    "state_snapshot_path", "state_snapshot_sha256", "input_manifest_path", "input_manifest_sha256",
  ]), "final review invocation");
  fail(INVOCATION_PATTERN.test(invocation.invocation_id ?? ""), "state_drift", "Final review invocation id is invalid");
  fail(["prepared", "running", "completed"].includes(invocation.status), "state_drift", "Final review invocation status is invalid");
  assertDateTime(invocation.prepared_at, "final review invocation.prepared_at");
  for (const [pathKey, hashKey] of [["prompt_path", "prompt_sha256"], ["state_snapshot_path", "state_snapshot_sha256"], ["input_manifest_path", "input_manifest_sha256"]]) {
    fail(typeof invocation[pathKey] === "string" && SHA256_PATTERN.test(invocation[hashKey] ?? ""), "state_drift", `Final review invocation ${pathKey} binding is invalid`);
  }
  fail(preparedEvents.length === 1, "state_drift", "Final review invocation lacks one prepared event");
  fail(canonicalJson(preparedEvents[0].details) === canonicalJson({
    invocation_id: invocation.invocation_id,
    prompt_sha256: invocation.prompt_sha256,
    state_snapshot_sha256: invocation.state_snapshot_sha256,
    input_manifest_sha256: invocation.input_manifest_sha256,
  }), "state_drift", "Final review prepared event differs from invocation state");
  if (invocation.status === "prepared") {
    fail(invocation.agent_handle === null && invocation.started_at === null && boundEvents.length === 0 && finalReview === null && recordedEvents.length === 0, "state_drift", "Prepared final review carries later-stage state");
    return;
  }
  assertString(invocation.agent_handle, "final review invocation.agent_handle");
  assertDateTime(invocation.started_at, "final review invocation.started_at");
  fail(boundEvents.length === 1 && canonicalJson(boundEvents[0].details) === canonicalJson({ invocation_id: invocation.invocation_id, agent_handle: invocation.agent_handle }), "state_drift", "Final review bound event differs from invocation state");
  if (invocation.status === "running") {
    fail(finalReview === null && recordedEvents.length === 0, "state_drift", "Running final review carries a recorded result");
    return;
  }
  assertExactKeys(finalReview, new Set(["path", "sha256", "reviewer_handle", "verdict", "recorded_at"]), "final review state");
  fail(finalReview.path === "final-review.json" && SHA256_PATTERN.test(finalReview.sha256 ?? ""), "state_drift", "Final review canonical binding is invalid");
  fail(finalReview.reviewer_handle === invocation.agent_handle && ["pass", "revise", "stop_with_unknowns"].includes(finalReview.verdict), "state_drift", "Final review state differs from its invocation");
  assertDateTime(finalReview.recorded_at, "final review.recorded_at");
  fail(recordedEvents.length === 1 && canonicalJson(recordedEvents[0].details) === canonicalJson({ verdict: finalReview.verdict, review_sha256: finalReview.sha256 }), "state_drift", "Final review recorded event differs from state");
}

function validateStateInvariants(manifest, state, activeCapabilities, runDir) {
  const stateKeys = new Set([
    "schema_version", "run_id", "workflow_id", "manifest_sha256", "capabilities_sha256",
    "frozen_max_parallel", "active_capabilities", "capability_receipts", "translation_review_sha256",
    "translation_review_receipt_sha256", "workflow_call_sha256", "effective_max_parallel", "effective_max_agent_runs",
    "agent_runs_prepared", "status", "created_at", "updated_at", "tasks", "final_review_invocation",
    "final_review", "action_handoffs", "events",
  ]);
  assertExactKeys(state, stateKeys, "workflow state");
  fail(state.schema_version === "dynamic-workflow-state/v1", "state_drift", "Unsupported workflow state schema");
  assertString(state.run_id, "state.run_id");
  assertDateTime(state.created_at, "state.created_at");
  assertDateTime(state.updated_at, "state.updated_at");
  fail(Array.isArray(state.events), "state_drift", "State events must be an array");
  state.events.forEach((event, index) => {
    assertExactKeys(event, new Set(["sequence", "at", "type", "task_id", "details"]), `state.events[${index}]`);
    fail(event.sequence === index + 1, "state_drift", "State event sequence is not contiguous");
    assertDateTime(event.at, `state.events[${index}].at`);
    assertString(event.type, `state.events[${index}].type`);
    fail(event.task_id === null || manifest.tasks.some((task) => task.id === event.task_id), "state_drift", `State event refers to unknown task: ${event.task_id}`);
    fail(event.details !== null && typeof event.details === "object" && !Array.isArray(event.details), "state_drift", "State event details must be an object");
  });
  const initializationEvents = state.events.filter((event) => event.type === "run_initialized" && event.task_id === null);
  fail(initializationEvents.length === 1, "state_drift", "State lacks one initialization event");
  for (const [key, maximum] of [["frozen_max_parallel", manifest.limits.max_parallel], ["effective_max_parallel", manifest.limits.max_parallel], ["effective_max_agent_runs", manifest.limits.max_agent_runs]]) {
    fail(Number.isInteger(state[key]) && state[key] >= 1 && state[key] <= maximum, "state_drift", `State ${key} is outside its manifest bound`);
  }
  fail(Number.isInteger(state.agent_runs_prepared) && state.agent_runs_prepared >= 0, "state_drift", "State agent_runs_prepared is invalid");
  if ((manifest.invocation_mode ?? "direct") === "skill_bridge") {
    fail(SHA256_PATTERN.test(state.workflow_call_sha256 ?? "") && state.workflow_call_sha256 === manifest.return_binding.workflow_call_sha256, "state_drift", "State workflow-call binding differs from the bridge manifest");
  } else {
    fail(state.workflow_call_sha256 === null, "state_drift", "Direct workflow state carries a workflow-call binding");
  }
  fail(state.effective_max_parallel <= state.frozen_max_parallel, "state_drift", "Effective parallelism exceeds its frozen bound");
  fail(activeCapabilities !== null && state.effective_max_parallel === Math.min(state.frozen_max_parallel, activeCapabilities.max_parallel), "state_drift", "Effective parallelism differs from the active capability bound");
  fail(
    canonicalJson(initializationEvents[0].details) === canonicalJson({
      source_sha256: manifest.source.sha256,
      frozen_max_parallel: state.frozen_max_parallel,
      effective_max_agent_runs: state.effective_max_agent_runs,
      capability_receipt: state.capability_receipts[0],
      workflow_call_sha256: state.workflow_call_sha256,
    }),
    "state_drift",
    "Initialization event differs from frozen execution limits",
  );
  const preparedEventCount = state.events.filter((event) => event.type === "agent_invocation_prepared").length;
  fail(state.agent_runs_prepared === preparedEventCount && state.agent_runs_prepared <= state.effective_max_agent_runs, "state_drift", "Agent-run budget counter differs from prepared invocation history");
  fail(state.tasks !== null && typeof state.tasks === "object" && !Array.isArray(state.tasks), "state_drift", "State tasks must be an object");
  fail(Array.isArray(state.action_handoffs), "state_drift", "State action_handoffs must be an array");
  state.action_handoffs.forEach((receipt) => {
    assertExactKeys(receipt, new Set(["gate_id", "path", "sha256", "created_at"]), "action handoff receipt");
    fail(ID_PATTERN.test(receipt.gate_id ?? "") && typeof receipt.path === "string" && SHA256_PATTERN.test(receipt.sha256 ?? ""), "state_drift", "Action handoff receipt is invalid");
    assertDateTime(receipt.created_at, "action handoff receipt.created_at");
  });
  fail(new Set(state.action_handoffs.map((receipt) => receipt.gate_id)).size === state.action_handoffs.length, "state_drift", "Duplicate action handoff receipt");
  const taskRecordKeys = new Set([
    "status", "invocation_id", "agent_handle", "prepared_at", "started_at", "completed_at",
    "result_path", "result_sha256", "input_manifest_path", "input_manifest_sha256", "outcome",
    "result_contract_receipt", "capability_assessment", "gate",
  ]);
  fail(Object.keys(state.tasks).length === manifest.tasks.length, "state_drift", "State task set size differs from manifest");
  for (const task of manifest.tasks) {
    const record = state.tasks[task.id];
    fail(record !== null && typeof record === "object" && !Array.isArray(record), "state_drift", `${task.id}: missing task state`);
    assertExactKeys(record, taskRecordKeys, `${task.id} state`);
    const allowed = task.kind === "agent"
      ? ["pending", "prepared", "running", "completed", "resolved", "failed", "blocked", "skipped"]
      : ["pending", "approved", "rejected", "blocked", "skipped"];
    fail(allowed.includes(record.status), "state_drift", `${task.id}: status is invalid for ${task.kind}`);
    if (task.kind === "agent") {
      fail(record.gate === null && record.capability_assessment !== null, "state_drift", `${task.id}: agent state shape is invalid`);
      if (record.status === "pending") {
        fail(
          canonicalJson(record.capability_assessment) === canonicalJson(assessTaskCapabilities(task, activeCapabilities)),
          "state_drift",
          `${task.id}: pending capability assessment differs from the active snapshot`,
        );
      }
      validateAgentInvocationLineage(task, record, state);
    } else {
      fail(record.invocation_id === null && record.agent_handle === null && record.result_path === null && record.result_sha256 === null && record.input_manifest_path === null && record.input_manifest_sha256 === null && record.outcome === null && record.result_contract_receipt === null && record.capability_assessment === null, "state_drift", `${task.id}: gate carries agent-only state`);
    }
    if (TERMINAL.has(record.status)) validateTerminalTaskLineage(task, record, state, runDir);
  }
  validateFinalReviewStateShape(state);
  fail(state.status === deriveStatus(manifest, state, runDir), "state_drift", "Workflow status differs from task and review state");
}

function statePaths(runDir) {
  return {
    state: join(runDir, STATE_FILE),
    manifest: join(runDir, MANIFEST_FILE),
    capabilities: join(runDir, CAPABILITIES_FILE),
    translationReview: join(runDir, TRANSLATION_REVIEW_FILE),
    translationReviewReceipt: join(runDir, TRANSLATION_REVIEW_RECEIPT_FILE),
    translationPrompt: join(runDir, "translation", "review-prompt"),
    translationInput: join(runDir, "translation", "review-input.json"),
    translationOriginalReceipt: join(runDir, "translation", TRANSLATION_ORIGINAL_RECEIPT_FILE),
    translationWorkflowCall: join(runDir, "translation", TRANSLATION_WORKFLOW_CALL_FILE),
  };
}

function capabilityRefPath(runDir, ref) {
  const path = resolve(runDir, ref.path);
  const relation = relative(runDir, path);
  fail(relation !== "" && !relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation), "unsafe_path", "Capability receipt escapes run directory");
  assertNoSymlinkAncestors(path, "capability receipt", runDir);
  fail(existsSync(path) && statSync(path).isFile() && !lstatSync(path).isSymbolicLink(), "run_missing", `Capability receipt missing: ${ref.path}`);
  fail(sha256File(path) === ref.sha256, "state_drift", `Capability receipt hash mismatch: ${ref.path}`);
  return path;
}

function validateCapabilityReceiptLineage(state, runDir, manifest) {
  fail(Array.isArray(state.capability_receipts) && state.capability_receipts.length > 0, "state_drift", "Capability receipt lineage is missing");
  const receiptDir = join(runDir, "capability-receipts");
  const expectedReceiptFiles = state.capability_receipts.slice(1).map((receipt) => receipt.path.split("/").at(-1)).sort();
  const actualReceiptFiles = existsSync(receiptDir) ? readdirSync(receiptDir).sort() : [];
  fail(canonicalJson(actualReceiptFiles) === canonicalJson(expectedReceiptFiles), "state_drift", "Capability receipt directory differs from state lineage");
  const initializationEvents = state.events.filter((event) => event.type === "run_initialized" && event.task_id === null);
  const resumeEvents = state.events.filter((event) => event.type === "capability_snapshot_resumed" && event.task_id === null);
  fail(initializationEvents.length === 1, "state_drift", "Capability lineage lacks one initialization event");
  fail(resumeEvents.length === state.capability_receipts.length - 1, "state_drift", "Capability resume events and receipts differ");
  let previousObservedAt = null;
  let activeCapabilities = null;
  for (const [index, receipt] of state.capability_receipts.entries()) {
    assertExactKeys(receipt, new Set(["path", "sha256", "observed_at", "recorded_at"]), "capability receipt");
    assertDateTime(receipt.observed_at, "capability receipt observed_at");
    assertDateTime(receipt.recorded_at, "capability receipt recorded_at");
    fail(previousObservedAt === null || Date.parse(receipt.observed_at) > previousObservedAt, "state_drift", "Capability receipt observations are not strictly increasing");
    const expectedPath = index === 0 ? CAPABILITIES_FILE : `capability-receipts/${String(index + 1).padStart(4, "0")}.json`;
    fail(receipt.path === expectedPath, "state_drift", "Capability receipt path is not canonical");
    const receiptPath = capabilityRefPath(runDir, receipt);
    const snapshot = readJson(receiptPath);
    validateCapabilitySnapshot(snapshot, manifest, false);
    fail(snapshot.observed_at === receipt.observed_at, "state_drift", "Capability receipt observation does not match its snapshot");
    if (index === 0) {
      fail(canonicalJson(initializationEvents[0].details?.capability_receipt) === canonicalJson(receipt), "state_drift", "Initial capability receipt differs from its initialization event");
      fail(Date.parse(initializationEvents[0].at) >= Date.parse(receipt.recorded_at), "state_drift", "Initial capability receipt was recorded after initialization");
    } else {
      const event = resumeEvents[index - 1];
      assertExactKeys(event.details, new Set(["path", "sha256", "observed_at", "recorded_at", "blocked_required_tasks"]), "capability resume event");
      fail(canonicalJson({
        path: event.details.path,
        sha256: event.details.sha256,
        observed_at: event.details.observed_at,
        recorded_at: event.details.recorded_at,
      }) === canonicalJson(receipt), "state_drift", "Capability resume event differs from its receipt");
      fail(Date.parse(event.at) >= Date.parse(receipt.recorded_at), "state_drift", "Capability receipt was recorded after its resume event");
    }
    previousObservedAt = Date.parse(receipt.observed_at);
    activeCapabilities = snapshot;
  }
  const latest = state.capability_receipts.at(-1);
  fail(canonicalJson(state.active_capabilities) === canonicalJson({ path: latest.path, sha256: latest.sha256 }), "state_drift", "Active capability receipt is not the latest observation");
  return activeCapabilities;
}

function validateRunRootForMutation(runDir) {
  assertNoSymlinkAncestors(runDir, "run-dir");
  fail(existsSync(runDir) && statSync(runDir).isDirectory(), "run_missing", `Run directory does not exist: ${runDir}`);
  const paths = statePaths(runDir);
  const required = [
    paths.state,
    paths.manifest,
    paths.capabilities,
    paths.translationReview,
    paths.translationReviewReceipt,
    paths.translationPrompt,
    paths.translationInput,
    paths.translationOriginalReceipt,
  ];
  for (const path of required) {
    assertNoSymlinkAncestors(path, "controller path", runDir);
    fail(existsSync(path) && statSync(path).isFile(), "run_missing", `Run control marker missing: ${path}`);
  }
  const manifest = validateManifest(readJson(paths.manifest));
  const bridge = (manifest.invocation_mode ?? "direct") === "skill_bridge";
  if (bridge) {
    assertNoSymlinkAncestors(paths.translationWorkflowCall, "controller path", runDir);
    fail(existsSync(paths.translationWorkflowCall) && statSync(paths.translationWorkflowCall).isFile(), "run_missing", `Run control marker missing: ${paths.translationWorkflowCall}`);
  } else {
    fail(!existsSync(paths.translationWorkflowCall), "state_drift", "Direct run contains an unexpected workflow-call receipt");
  }
}

function loadRun(runDir) {
  const paths = statePaths(runDir);
  fail(existsSync(paths.state) && existsSync(paths.manifest) && existsSync(paths.capabilities) && existsSync(paths.translationReview) && existsSync(paths.translationReviewReceipt) && existsSync(paths.translationPrompt) && existsSync(paths.translationInput) && existsSync(paths.translationOriginalReceipt), "run_missing", `Incomplete run directory: ${runDir}`);
  const manifest = validateManifest(readJson(paths.manifest));
  const state = readJson(paths.state);
  const bridge = (manifest.invocation_mode ?? "direct") === "skill_bridge";
  if (bridge) {
    fail(existsSync(paths.translationWorkflowCall) && statSync(paths.translationWorkflowCall).isFile() && !lstatSync(paths.translationWorkflowCall).isSymbolicLink(), "run_missing", "Frozen workflow-call receipt is missing");
    const workflowCallSnapshot = readJsonSnapshot(paths.translationWorkflowCall);
    validateWorkflowCallDocument(workflowCallSnapshot.value, manifest, workflowCallSnapshot.sha256, paths.translationWorkflowCall);
    fail(state.workflow_call_sha256 === workflowCallSnapshot.sha256, "state_drift", "Workflow-call state binding mismatch");
  } else {
    fail(!existsSync(paths.translationWorkflowCall) && state.workflow_call_sha256 === null, "state_drift", "Direct run carries workflow-call lineage");
  }
  fail(state.manifest_sha256 === sha256File(paths.manifest), "state_drift", "Frozen manifest hash mismatch");
  fail(state.capabilities_sha256 === sha256File(paths.capabilities), "state_drift", "Capability snapshot hash mismatch");
  fail(state.active_capabilities !== null && typeof state.active_capabilities === "object", "state_drift", "Active capability receipt is missing");
  const capabilities = validateCapabilityReceiptLineage(state, runDir, manifest);
  fail(state.translation_review_sha256 === sha256File(paths.translationReview), "state_drift", "Translation review hash mismatch");
  fail(state.translation_review_receipt_sha256 === sha256File(paths.translationReviewReceipt), "state_drift", "Translation review receipt hash mismatch");
  fail(state.workflow_id === manifest.workflow_id, "state_drift", "workflow_id mismatch");
  validateTranslationReview(readJson(paths.translationReview), manifest, paths.manifest);
  validateFrozenTranslationReceipt(paths, readJson(paths.translationReview), manifest);
  validateCapabilitySnapshot(capabilities, manifest, false);
  validateStateInvariants(manifest, state, capabilities, runDir);
  ensureSourceHash(manifest);
  const run = { paths, manifest, capabilities, state };
  validateFinalReviewStateLineage(run, runDir);
  validateActionHandoffLineage(run, runDir);
  return run;
}

function taskMap(manifest) {
  return new Map(manifest.tasks.map((task) => [task.id, task]));
}

function jsonPointerLookup(document, pointer) {
  let value = document;
  if (pointer === "") return { found: true, value };
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(value)) {
      fail(/^(?:0|[1-9][0-9]*)$/u.test(token), "invalid_schema", "Array JSON pointer tokens must use canonical non-negative indexes");
    }
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, token)) {
      return { found: false, value: undefined };
    }
    value = value[token];
  }
  return { found: true, value };
}

function conditionArtifactValue(task, state, runDir) {
  const source = state.tasks[task.when.task_id];
  fail(runDir !== undefined, "state_drift", `${task.id}: artifact condition requires a run directory`);
  const resultPath = assertPathInsideRun(runDir, source.result_path);
  const result = readJsonSnapshot(resultPath);
  fail(result.sha256 === source.result_sha256, "artifact_drift", `${task.id}: condition source result drifted`);
  const artifact = result.value.artifacts.find((candidate) => pathKey(candidate.path) === pathKey(task.when.artifact_path));
  fail(artifact !== undefined, "result_crosswire", `${task.id}: condition artifact is missing from its producer result`);
  const artifactPath = assertPathInsideRun(runDir, artifact.path);
  const artifactSnapshot = readJsonSnapshot(artifactPath);
  fail(artifactSnapshot.sha256 === artifact.sha256, "artifact_drift", `${task.id}: condition artifact drifted`);
  return jsonPointerLookup(artifactSnapshot.value, task.when.pointer);
}

function conditionState(task, state, runDir) {
  if (!task.when) {
    return "true";
  }
  const source = state.tasks[task.when.task_id];
  if (source.status === "skipped") {
    return "false";
  }
  if (!TERMINAL.has(source.status) || source.outcome === null) {
    return "unknown";
  }
  if (Object.hasOwn(task.when, "outcomes")) {
    return task.when.outcomes.includes(source.outcome) ? "true" : "false";
  }
  const lookup = conditionArtifactValue(task, state, runDir);
  if (task.when.predicate === "exists") return lookup.found ? "true" : "false";
  return lookup.found && canonicalJson(lookup.value) === canonicalJson(task.when.expected) ? "true" : "false";
}

function reconcileState(manifest, state, runDir) {
  let changed = true;
  const tasks = taskMap(manifest);
  while (changed) {
    changed = false;
    for (const task of manifest.tasks) {
      const record = state.tasks[task.id];
      if (record.status !== "pending") {
        continue;
      }
      if (task.kind === "agent" && task.requirements.on_unavailable === "skip_optional" && record.capability_assessment?.available === false) {
        record.status = "skipped";
        appendEvent(state, "task_skipped", task.id, { reason: "capability_unavailable", details: record.capability_assessment.reasons });
        changed = true;
        continue;
      }
      const dependencies = task.depends_on.map((id) => state.tasks[id]);
      if (dependencies.some((dependency) => ["failed", "blocked", "rejected"].includes(dependency.status))) {
        record.status = "blocked";
        appendEvent(state, "task_blocked_by_dependency", task.id);
        changed = true;
        continue;
      }
      if (!dependencies.every((dependency) => SATISFIED.has(dependency.status))) {
        continue;
      }
      if (conditionState(task, state, runDir) === "false") {
        record.status = "skipped";
        appendEvent(state, "task_skipped", task.id, { reason: "condition_false" });
        changed = true;
      }
    }
  }
  state.status = deriveStatus(manifest, state, runDir);
}

function isReady(task, state, runDir) {
  if (state.tasks[task.id].status !== "pending") {
    return false;
  }
  if (task.kind === "agent" && state.tasks[task.id].capability_assessment?.available === false) {
    return false;
  }
  const dependenciesReady = task.depends_on.every((id) => SATISFIED.has(state.tasks[id].status));
  return dependenciesReady && conditionState(task, state, runDir) === "true";
}

function deriveStatus(manifest, state, runDir) {
  const records = Object.values(state.tasks);
  const closureBad = records.some((record) => ["failed", "blocked", "rejected"].includes(record.status));
  if (closureBad) {
    return records.some((record) => record.status === "rejected") ? "cancelled" : "workflow_incomplete";
  }
  if (state.final_review?.verdict === "pass") {
    return "workflow_complete";
  }
  if (state.final_review !== null) {
    return "workflow_incomplete";
  }
  if (["prepared", "running"].includes(state.final_review_invocation?.status)) {
    return "workflow_reviewing";
  }
  if (records.some((record) => record.status === "running" || record.status === "prepared")) {
    return "workflow_running";
  }
  const readyAgent = manifest.tasks.some((task) => task.kind === "agent" && isReady(task, state, runDir));
  const readyGate = manifest.tasks.some((task) => task.kind === "human_gate" && isReady(task, state, runDir));
  const agentRunBudgetRemaining = state.agent_runs_prepared < state.effective_max_agent_runs;
  if (readyAgent && agentRunBudgetRemaining) {
    return "workflow_ready";
  }
  if (readyGate) {
    return "workflow_waiting_for_gate";
  }
  if (readyAgent) {
    return "workflow_incomplete";
  }
  const allTerminal = manifest.tasks.every((task) => TERMINAL.has(state.tasks[task.id].status));
  return allTerminal ? "workflow_execution_complete" : "workflow_incomplete";
}

function assertExecutionClosure(manifest, state) {
  const invalid = manifest.tasks
    .filter((task) => !SATISFIED.has(state.tasks[task.id]?.status))
    .map((task) => `${task.id}:${state.tasks[task.id]?.status ?? "missing"}`);
  fail(invalid.length === 0, "workflow_not_complete", `Execution closure contains unsatisfied tasks: ${invalid.join(", ")}`);
}

function summarize(manifest, state) {
  const counts = {};
  for (const record of Object.values(state.tasks)) {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
  }
  return {
    run_id: state.run_id,
    workflow_id: state.workflow_id,
    status: state.status,
    counts,
    total_tasks: manifest.tasks.length,
    agent_runs_prepared: state.agent_runs_prepared,
    agent_runs_remaining: Math.max(0, state.effective_max_agent_runs - state.agent_runs_prepared),
    effective_max_parallel: state.effective_max_parallel,
    effective_max_agent_runs: state.effective_max_agent_runs,
  };
}

function parseOptionalLimit(options, key, maximum) {
  if (options[key] === undefined) {
    return maximum;
  }
  const value = Number(options[key]);
  fail(Number.isInteger(value) && value >= 1 && value <= maximum, "invalid_arguments", `--${key} must be 1..${maximum}`);
  return value;
}

function commandInit(options) {
  const manifestPath = resolve(requireOption(options, "manifest"));
  const capabilitiesPath = resolve(requireOption(options, "capabilities"));
  const runDir = canonicalPath(requireOption(options, "run-dir"));
  const manifest = validateManifest(readJson(manifestPath));
  fail(existsSync(capabilitiesPath) && statSync(capabilitiesPath).isFile() && !lstatSync(capabilitiesPath).isSymbolicLink(), "unsafe_path", "Capability snapshot must be a regular non-symlink file");
  const capabilitySnapshot = readJsonSnapshot(capabilitiesPath);
  const capabilities = capabilitySnapshot.value;
  validateCapabilitySnapshot(capabilities, manifest, false);
  ensureSourceHash(manifest);
  const initialRun = !existsSync(join(runDir, STATE_FILE));
  const workflowCall = initialRun ? loadExternalWorkflowCall(options, manifest) : null;
  fail(!pathsOverlap(runDir, RUNNER_SKILL_ROOT), "unsafe_path", "run-dir must be outside the runner skill install tree");
  if (workflowCall !== null) {
    fail(
      !pathsOverlap(runDir, workflowCall.snapshot.value.invoking_skill.root),
      "unsafe_path",
      "run-dir must be outside the caller skill install tree",
    );
  }
  assertNoSymlinkAncestors(runDir, "run-dir");
  if (existsSync(runDir)) {
    fail(statSync(runDir).isDirectory(), "unsafe_path", "run-dir must be a directory");
    const entries = readdirSync(runDir);
    fail(
      entries.includes(STATE_FILE) || entries.every((entry) => entry === LOCK_FILE || entry === LOCK_RECOVERY_DIRECTORY),
      "run_dir_not_clean",
      "Existing run-dir without a workflow marker must contain only controller lock metadata",
    );
  }
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  assertNoSymlinkAncestors(runDir, "run-dir");
  const paths = statePaths(runDir);
  if (existsSync(paths.state)) {
    const release = acquireLock(runDir);
    try {
      const current = loadRun(runDir);
      fail(sha256Text(canonicalJson(manifest)) === sha256Text(canonicalJson(current.manifest)), "resume_manifest_drift", "Existing run uses a different manifest");
      fail(
        current.state.final_review_invocation === null && current.state.final_review === null && current.state.action_handoffs.length === 0,
        "resume_not_allowed",
        "A run with final-review or action-handoff lineage is immutable; repair in a new run",
      );
      const previousReceipt = current.state.capability_receipts.at(-1);
      fail(Date.parse(capabilities.observed_at) > Date.parse(previousReceipt.observed_at), "stale_capability_snapshot", "Resume capability snapshot must be newer than the latest recorded observation");
      const relativePath = `capability-receipts/${String(current.state.capability_receipts.length + 1).padStart(4, "0")}.json`;
      const destination = join(runDir, relativePath);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      freezeJsonSnapshot(capabilitySnapshot, destination);
      const frozenCapabilities = readJson(destination);
      validateCapabilitySnapshot(frozenCapabilities, current.manifest, false);
      const receipt = { path: relativePath, sha256: capabilitySnapshot.sha256, observed_at: frozenCapabilities.observed_at, recorded_at: isoNow() };
      current.state.capability_receipts.push(receipt);
      const ref = { path: receipt.path, sha256: receipt.sha256 };
      current.state.active_capabilities = ref;
      current.state.effective_max_parallel = Math.min(current.state.frozen_max_parallel, frozenCapabilities.max_parallel);
      for (const task of current.manifest.tasks.filter((candidate) => candidate.kind === "agent" && current.state.tasks[candidate.id].status === "pending")) {
        current.state.tasks[task.id].capability_assessment = assessTaskCapabilities(task, frozenCapabilities);
      }
      const blockedRequired = current.manifest.tasks
        .filter((task) => task.kind === "agent" && current.state.tasks[task.id].status === "pending")
        .filter((task) => current.state.tasks[task.id].capability_assessment?.available === false && task.requirements.on_unavailable !== "skip_optional")
        .map((task) => ({ task_id: task.id, reasons: current.state.tasks[task.id].capability_assessment.reasons }));
      appendEvent(current.state, "capability_snapshot_resumed", null, {
        path: ref.path,
        sha256: ref.sha256,
        observed_at: frozenCapabilities.observed_at,
        recorded_at: receipt.recorded_at,
        blocked_required_tasks: blockedRequired,
      });
      reconcileState(current.manifest, current.state, runDir);
      current.capabilities = frozenCapabilities;
      validateStateInvariants(current.manifest, current.state, frozenCapabilities, runDir);
      const resumeErrors = validateRunIntegrity(current, runDir);
      fail(resumeErrors.length === 0, "state_drift", `Resume would violate run lineage: ${resumeErrors.join(", ")}`);
      atomicWriteJson(current.paths.state, current.state);
      process.stdout.write(`${JSON.stringify(summarize(current.manifest, current.state))}\n`);
      return;
    } finally {
      release();
    }
  }
  validateCapabilitySnapshot(capabilities, manifest);
  const translationReviewPath = resolve(requireOption(options, "translation-review"));
  const translationReviewReceiptPath = resolve(requireOption(options, "translation-review-receipt"));
  const translationReview = readJson(translationReviewPath);
  const translationReviewReceipt = readJson(translationReviewReceiptPath);
  const translationReviewReceiptFileSha = sha256File(translationReviewReceiptPath);
  validateTranslationReview(translationReview, manifest, manifestPath);
  validateExternalTranslationReceipt(translationReviewReceipt, translationReview, manifest, manifestPath, workflowCall);
  const release = acquireLock(runDir);
  try {
    fail(!existsSync(paths.state), "run_already_initialized", "Run was initialized while this init command was waiting for the lock");
    const unexpectedEntries = readdirSync(runDir).filter((entry) => entry !== LOCK_FILE && entry !== LOCK_RECOVERY_DIRECTORY);
    fail(unexpectedEntries.length === 0, "run_dir_not_clean", "Initial run-dir changed before initialization");
    atomicWriteJson(paths.manifest, manifest);
    freezeJsonSnapshot(capabilitySnapshot, paths.capabilities);
    copyFileSync(translationReviewPath, paths.translationReview);
    mkdirSync(dirname(paths.translationPrompt), { recursive: true, mode: 0o700 });
    copyFileSync(translationReviewReceipt.prompt.path, paths.translationPrompt);
    copyFileSync(translationReviewReceipt.input_manifest.path, paths.translationInput);
    copyFileSync(translationReviewReceiptPath, paths.translationOriginalReceipt);
    if (workflowCall !== null) freezeJsonSnapshot(workflowCall.snapshot, paths.translationWorkflowCall);
    fail(sha256File(paths.translationPrompt) === translationReviewReceipt.prompt.sha256, "translation_review_crosswire", "Translation review prompt changed while freezing");
    fail(sha256File(paths.translationInput) === translationReviewReceipt.input_manifest.sha256, "translation_review_crosswire", "Translation review input changed while freezing");
    fail(sha256File(paths.translationOriginalReceipt) === translationReviewReceiptFileSha, "translation_review_crosswire", "Translation review receipt changed while freezing");
    const frozenTranslationReceipt = {
      ...translationReviewReceipt,
      prompt: { path: "translation/review-prompt", sha256: sha256File(paths.translationPrompt) },
      input_manifest: { path: "translation/review-input.json", sha256: sha256File(paths.translationInput) },
      original_receipt: { path: "translation/original-review-receipt.json", sha256: sha256File(paths.translationOriginalReceipt) },
    };
    if (workflowCall !== null) {
      frozenTranslationReceipt.workflow_call = workflowCallBinding(workflowCall.snapshot.value, "translation/workflow-call.json", workflowCall.snapshot.sha256);
    }
    atomicWriteJson(paths.translationReviewReceipt, frozenTranslationReceipt);
    const frozenManifest = validateManifest(readJson(paths.manifest));
    const frozenCapabilities = readJson(paths.capabilities);
    validateCapabilitySnapshot(frozenCapabilities, frozenManifest);
    validateTranslationReview(readJson(paths.translationReview), frozenManifest, paths.manifest);
    validateFrozenTranslationReceipt(paths, readJson(paths.translationReview), frozenManifest);
    ensureSourceHash(frozenManifest);
    const manifestSha = sha256File(paths.manifest);
    const capabilitiesSha = sha256File(paths.capabilities);
    const userMaxParallel = parseOptionalLimit(options, "max-parallel", 1024);
    const userMaxAgentRuns = parseOptionalLimit(options, "max-agent-runs", 1000);
    const frozenParallel = Math.min(manifest.limits.max_parallel, userMaxParallel);
    const effectiveParallel = Math.min(frozenParallel, capabilities.max_parallel);
    const effectiveAgentRuns = Math.min(manifest.limits.max_agent_runs, userMaxAgentRuns);
    const state = initializeState(manifest, manifestSha, capabilitiesSha, frozenCapabilities, frozenParallel, effectiveParallel, effectiveAgentRuns);
    state.translation_review_sha256 = sha256File(paths.translationReview);
    state.translation_review_receipt_sha256 = sha256File(paths.translationReviewReceipt);
    state.workflow_call_sha256 = workflowCall?.snapshot.sha256 ?? null;
    appendEvent(state, "run_initialized", null, {
      source_sha256: manifest.source.sha256,
      frozen_max_parallel: frozenParallel,
      effective_max_agent_runs: effectiveAgentRuns,
      capability_receipt: state.capability_receipts[0],
      workflow_call_sha256: state.workflow_call_sha256,
    });
    reconcileState(manifest, state, runDir);
    atomicWriteJson(paths.state, state);
    process.stdout.write(`${JSON.stringify(summarize(manifest, state))}\n`);
  } finally {
    release();
  }
}

function withMutableRun(options, callback) {
  const runDir = canonicalPath(requireOption(options, "run-dir"));
  validateRunRootForMutation(runDir);
  const release = acquireLock(runDir);
  try {
    validateRunRootForMutation(runDir);
    const run = loadRun(runDir);
    const result = callback(run, runDir);
    reconcileState(run.manifest, run.state, runDir);
    atomicWriteJson(run.paths.state, run.state);
    process.stdout.write(`${JSON.stringify(result ?? summarize(run.manifest, run.state))}\n`);
  } finally {
    release();
  }
}

function commandRecoverLock(options) {
  const runDir = canonicalPath(requireOption(options, "run-dir"));
  const actor = requireOption(options, "actor");
  fail(actor.length <= 256, "invalid_arguments", "--actor is too long");
  assertNoSymlinkAncestors(runDir, "run-dir");
  fail(existsSync(runDir) && statSync(runDir).isDirectory(), "run_missing", `Run directory does not exist: ${runDir}`);
  const releaseRecovery = acquireRecoveryLock(runDir);
  try {
    const lockPath = join(runDir, LOCK_FILE);
    fail(existsSync(lockPath) && statSync(lockPath).isFile() && !lstatSync(lockPath).isSymbolicLink(), "run_locked", "No recoverable regular lock is present");
    const lockIdentity = lstatSync(lockPath);
    const snapshot = readJsonSnapshot(lockPath);
    validateLockDocument(snapshot.value);
    fail(snapshot.value.hostname === hostname(), "run_locked", "Cannot recover a lock owned by another host");
    fail(!processIsAlive(snapshot.value.pid), "run_locked", `Lock owner pid ${snapshot.value.pid} is still active`);
    const paths = statePaths(runDir);
    if (existsSync(paths.state)) {
      validateRunRootForMutation(runDir);
      const run = loadRun(runDir);
      const errors = validateRunIntegrity(run, runDir);
      fail(errors.length === 0, "run_invalid", `Refusing stale-lock recovery for an invalid run: ${errors.join(", ")}`);
    } else {
      const unexpected = readdirSync(runDir).filter((entry) => ![LOCK_FILE, RECOVERY_LOCK_FILE, LOCK_RECOVERY_DIRECTORY].includes(entry));
      fail(unexpected.length === 0, "run_dir_not_clean", "Uninitialized run contains files other than lock recovery metadata");
    }
    const recoveryDirectory = join(runDir, LOCK_RECOVERY_DIRECTORY);
    mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
    const stem = `${Date.now()}-${snapshot.value.token}`;
    const archivedLock = join(recoveryDirectory, `${stem}.lock.json`);
    const currentIdentity = lstatSync(lockPath);
    const currentSnapshot = readJsonSnapshot(lockPath);
    fail(currentIdentity.dev === lockIdentity.dev && currentIdentity.ino === lockIdentity.ino, "lock_race", "Stale lock file identity changed during recovery");
    fail(currentSnapshot.sha256 === snapshot.sha256 && currentSnapshot.value.token === snapshot.value.token, "lock_race", "Stale lock changed during recovery");
    renameSync(lockPath, archivedLock);
    fail(sha256File(archivedLock) === snapshot.sha256, "lock_race", "Stale lock changed during recovery");
    const recoveryPath = join(recoveryDirectory, `${stem}.recovery.json`);
    atomicWriteJson(recoveryPath, {
      schema_version: "dynamic-workflow-lock-recovery/v1",
      stale_lock_sha256: snapshot.sha256,
      recovered_at: isoNow(),
      actor,
      recovered_by: { pid: process.pid, hostname: hostname() },
    });
    process.stdout.write(`${JSON.stringify({ status: "stale_lock_recovered", archived_lock: relative(runDir, archivedLock), receipt: relative(runDir, recoveryPath) })}\n`);
  } finally {
    releaseRecovery();
  }
}

function commandReady(options) {
  withMutableRun(options, ({ manifest, state }, runDir) => {
    reconcileState(manifest, state, runDir);
    const running = Object.values(state.tasks).filter((record) => record.status === "running" || record.status === "prepared").length;
    const parallelCapacity = Math.max(0, state.effective_max_parallel - running);
    const remainingAgentRuns = Math.max(0, state.effective_max_agent_runs - state.agent_runs_prepared);
    const capacity = Math.min(parallelCapacity, remainingAgentRuns);
    const ready = manifest.tasks
      .filter((task) => task.kind === "agent" && isReady(task, state, runDir))
      .slice(0, capacity)
      .map((task) => ({
        id: task.id,
        prompt: task.prompt,
        context_policy: task.context_policy,
        output_path: task.output_path,
        effect: task.effect,
      }));
    return { status: state.status, capacity, ready };
  });
}

function getTask(run, taskId, expectedKind = undefined) {
  const task = run.manifest.tasks.find((candidate) => candidate.id === taskId);
  fail(task !== undefined, "unknown_task", `Unknown task: ${taskId}`);
  if (expectedKind) {
    fail(task.kind === expectedKind, "wrong_task_kind", `${taskId} is not ${expectedKind}`);
  }
  return { task, record: run.state.tasks[taskId] };
}

function describeTaskInputs(run, runDir, task) {
  return task.inputs.map((input) => {
    if (input.kind === "argument") {
      return { kind: "argument", key: input.key, value: run.manifest.arguments[input.key] };
    }
    if (input.kind === "file") {
      fail(existsSync(input.path) && statSync(input.path).isFile(), "input_missing", `Input file does not exist: ${input.path}`);
      fail(!lstatSync(input.path).isSymbolicLink(), "unsafe_path", `Input file cannot be a symlink: ${input.path}`);
      fail(sha256File(input.path) === input.sha256, "input_drift", `Input file hash mismatch: ${input.path}`);
      return { kind: "file", source_path: input.path, source_sha256: input.sha256 };
    }
    const producer = run.state.tasks[input.task_id];
    if (input.kind.startsWith("optional_") && producer.status === "skipped") {
      return input.kind === "optional_task_result"
        ? { kind: input.kind, task_id: input.task_id, status: "skipped", path: null, sha256: null }
        : { kind: input.kind, task_id: input.task_id, status: "skipped", path: input.path, sha256: null };
    }
    fail(["completed", "resolved"].includes(producer.status), "input_not_ready", `Input producer is not complete: ${input.task_id}`);
    const resultPath = assertPathInsideRun(runDir, producer.result_path);
    fail(sha256File(resultPath) === producer.result_sha256, "input_drift", `Producer result drifted: ${input.task_id}`);
    if (input.kind === "task_result") {
      return { kind: "task_result", task_id: input.task_id, source_path: producer.result_path, source_sha256: producer.result_sha256 };
    }
    if (input.kind === "optional_task_result") {
      return { kind: input.kind, task_id: input.task_id, status: "available", source_path: producer.result_path, source_sha256: producer.result_sha256 };
    }
    const result = readJson(resultPath);
    const artifact = result.artifacts.find((candidate) => candidate.path === input.path);
    fail(artifact !== undefined, "input_crosswire", `Producer did not emit artifact: ${input.path}`);
    const artifactPath = assertPathInsideRun(runDir, artifact.path);
    fail(sha256File(artifactPath) === artifact.sha256, "input_drift", `Producer artifact drifted: ${input.path}`);
    return input.kind === "optional_artifact"
      ? { kind: input.kind, task_id: input.task_id, status: "available", source_path: artifact.path, source_sha256: artifact.sha256 }
      : { kind: "artifact", task_id: input.task_id, source_path: artifact.path, source_sha256: artifact.sha256 };
  });
}

function freezeTaskInputs(run, runDir, task) {
  return describeTaskInputs(run, runDir, task).map((input, index) => {
    if (input.kind === "argument" || input.status === "skipped") return input;
    const sourcePath = isAbsolute(input.source_path) ? input.source_path : join(runDir, input.source_path);
    const bytes = readBoundedBytes(sourcePath);
    fail(createHash("sha256").update(bytes).digest("hex") === input.source_sha256, "input_drift", `Input changed while freezing: ${input.source_path}`);
    const frozenPath = `inputs/files/${task.id}/${String(index).padStart(4, "0")}.bin`;
    const destination = join(runDir, frozenPath);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    atomicWriteBytes(destination, bytes);
    fail(!lstatSync(destination).isSymbolicLink() && statSync(destination).isFile(), "unsafe_path", `Frozen input is not a regular file: ${frozenPath}`);
    fail(sha256File(destination) === input.source_sha256, "input_drift", `Frozen input hash mismatch: ${frozenPath}`);
    if (input.kind === "file") return { kind: input.kind, path: frozenPath, sha256: input.source_sha256 };
    const frozen = { kind: input.kind, task_id: input.task_id, path: frozenPath, sha256: input.source_sha256 };
    if (Object.hasOwn(input, "status")) frozen.status = input.status;
    return frozen;
  });
}

function expectedFrozenTaskInputs(run, task, frozenInputs) {
  fail(Array.isArray(frozenInputs) && frozenInputs.length === task.inputs.length, "input_crosswire", `${task.id}: frozen input count changed`);
  return task.inputs.map((input, index) => {
    if (input.kind === "argument") return { kind: "argument", key: input.key, value: run.manifest.arguments[input.key] };
    const producer = input.kind === "file" ? null : run.state.tasks[input.task_id];
    if (input.kind.startsWith("optional_") && producer.status === "skipped") {
      return input.kind === "optional_task_result"
        ? { kind: input.kind, task_id: input.task_id, status: "skipped", path: null, sha256: null }
        : { kind: input.kind, task_id: input.task_id, status: "skipped", path: input.path, sha256: null };
    }
    const path = `inputs/files/${task.id}/${String(index).padStart(4, "0")}.bin`;
    if (input.kind === "file") {
      return { kind: "file", path, sha256: input.sha256 };
    }
    if (input.kind === "task_result") {
      return { kind: input.kind, task_id: input.task_id, path, sha256: producer.result_sha256 };
    }
    if (input.kind === "optional_task_result") {
      return { kind: input.kind, task_id: input.task_id, status: "available", path, sha256: producer.result_sha256 };
    }
    const frozen = frozenInputs[index];
    return input.kind === "optional_artifact"
      ? { kind: input.kind, task_id: input.task_id, status: "available", path, sha256: frozen.sha256 }
      : { kind: input.kind, task_id: input.task_id, path, sha256: frozen.sha256 };
  });
}

function freezeResultContractSchema(runDir, task) {
  const sha256 = task.result_contract.schema.kind === "inline"
    ? task.result_contract.schema.canonical_sha256
    : task.result_contract.schema.sha256;
  if (task.result_contract.schema.kind === "inline") return { schema_sha256: sha256, schema_path: null };
  const bytes = readBoundedBytes(task.result_contract.schema.path);
  fail(createHash("sha256").update(bytes).digest("hex") === sha256, "result_contract_drift", `${task.id}: result schema changed while freezing`);
  const schemaPath = `inputs/schemas/${task.id}.json`;
  const destination = join(runDir, schemaPath);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  atomicWriteBytes(destination, bytes);
  fail(sha256File(destination) === sha256, "result_contract_drift", `${task.id}: frozen result schema hash mismatch`);
  inspectJsonSchema(readJson(destination));
  return { schema_sha256: sha256, schema_path: schemaPath };
}

function writeTaskInputManifest(run, runDir, task, invocationId) {
  const path = join(runDir, "inputs", `${task.id}.json`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const frozenResultSchema = freezeResultContractSchema(runDir, task);
  atomicWriteJson(path, {
    schema_version: "dynamic-workflow-task-input/v1",
    workflow_id: run.state.workflow_id,
    run_id: run.state.run_id,
    task_id: task.id,
    invocation_id: invocationId,
    context_policy: task.context_policy,
    requirements: task.requirements,
    capability_snapshot: run.state.active_capabilities,
    capability_assessment: assessTaskCapabilities(task, run.capabilities),
    fork_behavior: run.capabilities.fork_behavior,
    result_contract: {
      contract_sha256: sha256Text(canonicalJson(task.result_contract)),
      ...frozenResultSchema,
    },
    inputs: freezeTaskInputs(run, runDir, task),
  });
  return {
    path: relative(runDir, path).split(sep).join("/"),
    sha256: sha256File(path),
  };
}

function commandPrepare(options) {
  withMutableRun(options, (run, runDir) => {
    const taskId = requireOption(options, "task");
    const invocationId = requireOption(options, "invocation");
    fail(INVOCATION_PATTERN.test(invocationId), "invalid_arguments", "Invalid invocation id");
    const { task, record } = getTask(run, taskId, "agent");
    const currentAssessment = assessTaskCapabilities(task, run.capabilities);
    fail(currentAssessment.available, "unsupported_runtime", `${taskId}: ${currentAssessment.reasons.join(", ")}`);
    fail(canonicalJson(record.capability_assessment) === canonicalJson(currentAssessment), "state_drift", `${taskId}: capability assessment drifted before dispatch`);
    fail(isReady(task, run.state, runDir), "task_not_ready", `${taskId} is not ready`);
    fail(run.state.agent_runs_prepared < run.state.effective_max_agent_runs, "budget_exceeded", "effective max_agent_runs reached");
    const inputManifest = writeTaskInputManifest(run, runDir, task, invocationId);
    record.status = "prepared";
    record.invocation_id = invocationId;
    record.prepared_at = isoNow();
    record.input_manifest_path = inputManifest.path;
    record.input_manifest_sha256 = inputManifest.sha256;
    run.state.agent_runs_prepared += 1;
    appendEvent(run.state, "agent_invocation_prepared", taskId, { invocation_id: invocationId, input_manifest_sha256: inputManifest.sha256 });
    return { task_id: taskId, invocation_id: invocationId, status: record.status, input_manifest_path: inputManifest.path, input_manifest_sha256: inputManifest.sha256 };
  });
}

function commandBind(options) {
  withMutableRun(options, (run) => {
    const taskId = requireOption(options, "task");
    const invocationId = requireOption(options, "invocation");
    const agentHandle = requireOption(options, "agent");
    const { task, record } = getTask(run, taskId, "agent");
    fail(record.status === "prepared", "invalid_transition", `${taskId} is not prepared`);
    fail(record.invocation_id === invocationId, "invocation_conflict", "Invocation id mismatch");
    const activeHandles = Object.values(run.state.tasks).filter((candidate) => candidate.status === "running").map((candidate) => candidate.agent_handle);
    fail(!activeHandles.includes(agentHandle), "agent_handle_conflict", `Agent handle already bound: ${agentHandle}`);
    if (task.context_policy.mode === "fresh") {
      const translationReview = readJson(run.paths.translationReview);
      const historicalHandles = [
        ...Object.entries(run.state.tasks).filter(([id]) => id !== taskId).map(([, candidate]) => candidate.agent_handle),
        translationReview.translator_handle,
        translationReview.reviewer_handle,
        run.state.final_review_invocation?.agent_handle,
      ].filter(Boolean);
      fail(!historicalHandles.includes(agentHandle), "fresh_handle_reused", `Fresh-context task cannot reuse historical handle: ${agentHandle}`);
    }
    record.status = "running";
    record.agent_handle = agentHandle;
    record.started_at = isoNow();
    appendEvent(run.state, "agent_handle_bound", taskId, { invocation_id: invocationId, agent_handle: agentHandle });
    return { task_id: taskId, invocation_id: invocationId, agent_handle: agentHandle, status: record.status };
  });
}

function assertPathInsideRun(runDir, relativePath) {
  const target = resolve(runDir, relativePath);
  const relation = relative(runDir, target);
  fail(relation !== "" && !relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation), "unsafe_path", "Result escapes run directory");
  let current = dirname(target);
  while (current !== runDir) {
    if (existsSync(current)) {
      fail(!lstatSync(current).isSymbolicLink(), "unsafe_path", `Symlink ancestor rejected: ${current}`);
    }
    current = dirname(current);
  }
  fail(existsSync(target) && statSync(target).isFile(), "result_missing", `Result file missing: ${target}`);
  fail(!lstatSync(target).isSymbolicLink(), "unsafe_path", "Result file cannot be a symlink");
  return target;
}

function validateNodeResult(result, task, invocationId, runDir) {
  const allowed = new Set(["schema_version", "task_id", "invocation_id", "outcome", "summary", "artifacts", "evidence", "errors"]);
  assertExactKeys(result, allowed, "node result");
  fail(result.schema_version === "dynamic-workflow-node-result/v1", "unsupported_schema", "Unsupported node result schema");
  fail(result.task_id === task.id, "result_crosswire", "Result task_id mismatch");
  fail(result.invocation_id === invocationId, "result_crosswire", "Result invocation_id mismatch");
  fail(OUTCOMES.has(result.outcome), "invalid_schema", "Invalid result outcome");
  fail(typeof result.summary === "string", "invalid_schema", "Result summary must be string");
  fail(Array.isArray(result.artifacts), "invalid_schema", "Result artifacts must be array");
  validateStringArray(result.evidence, "Result evidence");
  validateStringArray(result.errors, "Result errors");
  const artifactPaths = [];
  for (const artifact of result.artifacts) {
    assertExactKeys(artifact, new Set(["path", "sha256"]), "result artifact");
    const path = validateRelativePath(artifact.path, "result artifact.path");
    fail(SHA256_PATTERN.test(artifact.sha256 ?? ""), "invalid_schema", "result artifact.sha256 is invalid");
    const absolutePath = assertPathInsideRun(runDir, path);
    fail(sha256File(absolutePath) === artifact.sha256, "artifact_drift", `Artifact hash mismatch: ${path}`);
    artifactPaths.push(pathSpelling(path));
  }
  const declared = task.artifact_paths.map(pathSpelling).sort();
  fail(new Set(artifactPaths.map(pathKey)).size === artifactPaths.length, "result_crosswire", "Duplicate result artifact path");
  fail(JSON.stringify(artifactPaths.sort()) === JSON.stringify(declared), "result_crosswire", "Result artifacts differ from manifest artifact_paths");
}

function validateTaskInputManifest(run, runDir, task, record) {
  fail(record.input_manifest_path !== null && record.input_manifest_sha256 !== null, "input_crosswire", `${task.id}: input manifest binding is missing`);
  const path = assertPathInsideRun(runDir, record.input_manifest_path);
  fail(sha256File(path) === record.input_manifest_sha256, "input_drift", `${task.id}: input manifest hash mismatch`);
  const inputManifest = readJson(path);
  assertExactKeys(inputManifest, new Set(["schema_version", "workflow_id", "run_id", "task_id", "invocation_id", "context_policy", "requirements", "capability_snapshot", "capability_assessment", "fork_behavior", "result_contract", "inputs"]), `${task.id} input manifest`);
  fail(inputManifest.schema_version === "dynamic-workflow-task-input/v1", "input_crosswire", `${task.id}: input schema mismatch`);
  fail(inputManifest.workflow_id === run.state.workflow_id && inputManifest.run_id === run.state.run_id, "input_crosswire", `${task.id}: input run identity mismatch`);
  fail(inputManifest.task_id === task.id && inputManifest.invocation_id === record.invocation_id, "input_crosswire", `${task.id}: input invocation mismatch`);
  fail(canonicalJson(inputManifest.context_policy) === canonicalJson(task.context_policy), "input_crosswire", `${task.id}: context policy mismatch`);
  fail(canonicalJson(inputManifest.requirements) === canonicalJson(task.requirements), "input_crosswire", `${task.id}: requirements mismatch`);
  const capabilityPath = capabilityRefPath(runDir, inputManifest.capability_snapshot);
  const dispatchCapabilities = readJson(capabilityPath);
  validateCapabilitySnapshot(dispatchCapabilities, run.manifest);
  fail(canonicalJson(inputManifest.capability_assessment) === canonicalJson(assessTaskCapabilities(task, dispatchCapabilities)), "input_crosswire", `${task.id}: capability assessment mismatch`);
  fail(inputManifest.capability_assessment.available === true, "unsupported_runtime", `${task.id}: unavailable capability was dispatched`);
  fail(canonicalJson(inputManifest.fork_behavior) === canonicalJson(dispatchCapabilities.fork_behavior), "input_crosswire", `${task.id}: fork behavior changed`);
  const schemaSha256 = task.result_contract.schema.kind === "inline" ? task.result_contract.schema.canonical_sha256 : task.result_contract.schema.sha256;
  const expectedSchemaPath = task.result_contract.schema.kind === "inline" ? null : `inputs/schemas/${task.id}.json`;
  fail(canonicalJson(inputManifest.result_contract) === canonicalJson({
    contract_sha256: sha256Text(canonicalJson(task.result_contract)),
    schema_sha256: schemaSha256,
    schema_path: expectedSchemaPath,
  }), "input_crosswire", `${task.id}: result contract changed`);
  if (expectedSchemaPath !== null) {
    fail(sha256File(assertPathInsideRun(runDir, expectedSchemaPath)) === schemaSha256, "result_contract_drift", `${task.id}: frozen result schema changed`);
  }
  const expectedInputs = expectedFrozenTaskInputs(run, task, inputManifest.inputs);
  fail(canonicalJson(inputManifest.inputs) === canonicalJson(expectedInputs), "input_drift", `${task.id}: resolved inputs changed`);
  for (const input of inputManifest.inputs) {
    if (input.kind === "argument" || input.status === "skipped") continue;
    fail(sha256File(assertPathInsideRun(runDir, input.path)) === input.sha256, "input_drift", `${task.id}: frozen input changed: ${input.path}`);
  }
}

function commandFinish(options) {
  withMutableRun(options, (run, runDir) => {
    const taskId = requireOption(options, "task");
    const invocationId = requireOption(options, "invocation");
    const resultOption = requireOption(options, "result");
    const { task, record } = getTask(run, taskId, "agent");
    const expectedPath = assertPathInsideRun(runDir, task.output_path);
    fail(resolve(resultOption) === expectedPath, "result_crosswire", "--result must match manifest output_path");
    const result = readJson(expectedPath);
    validateNodeResult(result, task, invocationId, runDir);
    const resultSha = sha256File(expectedPath);
    if (TERMINAL.has(record.status) && record.invocation_id === invocationId && record.result_sha256 === resultSha) {
      ensureSourceHash(run.manifest);
      validateTaskInputManifest(run, runDir, task, record);
      revalidateResultContract(task, record, runDir);
      return { task_id: taskId, status: record.status, idempotent: true, result_sha256: resultSha };
    }
    if (TERMINAL.has(record.status)) {
      if (record.invocation_id === invocationId) {
        throw new WorkflowError("result_conflict", `${taskId} already has a different result for this invocation`);
      }
      throw new WorkflowError("invocation_conflict", `${taskId} is already terminal under another invocation`);
    }
    fail(record.status === "running", "invalid_transition", `${taskId} is not running`);
    fail(record.invocation_id === invocationId, "invocation_conflict", "Invocation id mismatch");
    ensureSourceHash(run.manifest);
    validateTaskInputManifest(run, runDir, task, record);
    const resultContractReceipt = validateResultContractValue(task, result, runDir, record);
    record.outcome = result.outcome;
    record.result_path = task.output_path;
    record.result_sha256 = resultSha;
    record.completed_at = isoNow();
    record.result_contract_receipt = resultContractReceipt;
    record.status = task.accepted_outcomes.includes(result.outcome)
      ? result.outcome === "pass" ? "completed" : "resolved"
      : result.outcome === "failed" ? "failed" : "blocked";
    appendEvent(run.state, "agent_result_recorded", taskId, { invocation_id: invocationId, outcome: result.outcome, result_sha256: resultSha, result_contract: resultContractReceipt });
    return { task_id: taskId, status: record.status, idempotent: false, result_sha256: resultSha, result_contract_receipt: resultContractReceipt };
  });
}

function commandAbort(options) {
  withMutableRun(options, (run) => {
    const taskId = requireOption(options, "task");
    const invocationId = requireOption(options, "invocation");
    const reason = requireOption(options, "reason");
    const { record } = getTask(run, taskId, "agent");
    fail(["prepared", "running"].includes(record.status), "invalid_transition", `${taskId} is not active`);
    fail(record.invocation_id === invocationId, "invocation_conflict", "Invocation id mismatch");
    record.status = "failed";
    record.completed_at = isoNow();
    appendEvent(run.state, "agent_invocation_aborted", taskId, { invocation_id: invocationId, reason });
    return { task_id: taskId, status: record.status };
  });
}

function resolveActionPackage(run, runDir, gate) {
  if (gate.action_package === null) {
    return null;
  }
  const producer = run.state.tasks[gate.action_package.task_id];
  fail(["completed", "resolved"].includes(producer.status), "input_not_ready", `${gate.id}: action package producer is not complete`);
  const producerTask = run.manifest.tasks.find((candidate) => candidate.id === gate.action_package.task_id);
  validateTaskInputManifest(run, runDir, producerTask, producer);
  const producerInputManifest = readJson(assertPathInsideRun(runDir, producer.input_manifest_path));
  const resultPath = assertPathInsideRun(runDir, producer.result_path);
  fail(sha256File(resultPath) === producer.result_sha256, "input_drift", `${gate.id}: action package producer result drifted`);
  const result = readJson(resultPath);
  const artifact = result.artifacts.find((candidate) => pathKey(candidate.path) === pathKey(gate.action_package.path));
  fail(artifact !== undefined, "input_crosswire", `${gate.id}: action package artifact is missing`);
  const packagePath = assertPathInsideRun(runDir, artifact.path);
  fail(sha256File(packagePath) === artifact.sha256, "artifact_drift", `${gate.id}: action package artifact drifted`);
  const actionPackage = readJson(packagePath);
  assertExactKeys(actionPackage, new Set([
    "schema_version", "package_id", "source_task_id", "action_id", "action", "targets", "scope", "parameters",
    "preconditions", "expected_effects", "read_back", "idempotency", "executor_capabilities", "lineage", "external_effects_performed",
  ]), `${gate.id} action package`);
  fail(actionPackage.schema_version === "dynamic-workflow-action-package/v1", "unsupported_schema", `${gate.id}: unsupported action package schema`);
  fail(ID_PATTERN.test(actionPackage.package_id ?? ""), "invalid_schema", `${gate.id}: invalid action package package_id`);
  fail(ID_PATTERN.test(actionPackage.action_id ?? ""), "invalid_schema", `${gate.id}: invalid action package action_id`);
  fail(actionPackage.source_task_id === gate.action_package.task_id, "input_crosswire", `${gate.id}: action package source_task_id mismatch`);
  fail(actionPackage.action === gate.action, "input_crosswire", `${gate.id}: action package action mismatch`);
  validateStringArray(actionPackage.targets, `${gate.id} action package targets`);
  validateStringArray(actionPackage.scope, `${gate.id} action package scope`);
  fail(actionPackage.targets.length > 0 && new Set(actionPackage.targets).size === actionPackage.targets.length, "invalid_schema", `${gate.id}: action package targets must be non-empty and unique`);
  fail(actionPackage.scope.length > 0 && new Set(actionPackage.scope).size === actionPackage.scope.length, "invalid_schema", `${gate.id}: action package scope must be non-empty and unique`);
  validateStringArray(actionPackage.executor_capabilities, `${gate.id} action package executor_capabilities`);
  fail(actionPackage.executor_capabilities.length > 0 && new Set(actionPackage.executor_capabilities).size === actionPackage.executor_capabilities.length, "invalid_schema", `${gate.id}: executor_capabilities must be non-empty and unique`);
  actionPackage.executor_capabilities.forEach((capability) => fail(capability.length <= 160 && SEMANTIC_ID_PATTERN.test(capability), "invalid_schema", `${gate.id}: invalid executor capability ${capability}`));
  fail(canonicalJson(actionPackage.targets) === canonicalJson(gate.targets), "input_crosswire", `${gate.id}: action package targets mismatch`);
  fail(canonicalJson(actionPackage.scope) === canonicalJson(gate.scope), "input_crosswire", `${gate.id}: action package scope mismatch`);
  fail(actionPackage.parameters !== null && typeof actionPackage.parameters === "object" && !Array.isArray(actionPackage.parameters), "invalid_schema", `${gate.id}: action package parameters must be an object`);
  for (const key of ["preconditions", "expected_effects"]) {
    validateStringArray(actionPackage[key], `${gate.id} action package ${key}`);
    fail(actionPackage[key].length > 0 && new Set(actionPackage[key]).size === actionPackage[key].length, "invalid_schema", `${gate.id}: action package ${key} must be non-empty and unique`);
  }
  assertExactKeys(actionPackage.read_back, new Set(["method", "success_criteria"]), `${gate.id} action package read_back`);
  assertString(actionPackage.read_back.method, `${gate.id} action package read_back.method`);
  assertString(actionPackage.read_back.success_criteria, `${gate.id} action package read_back.success_criteria`);
  assertExactKeys(actionPackage.idempotency, new Set(["key", "behavior"]), `${gate.id} action package idempotency`);
  assertString(actionPackage.idempotency.key, `${gate.id} action package idempotency.key`);
  fail(["safe_to_retry", "verify_before_retry", "not_retryable"].includes(actionPackage.idempotency.behavior), "invalid_schema", `${gate.id}: invalid action package idempotency behavior`);
  assertExactKeys(actionPackage.lineage, new Set(["source_sha256", "manifest_sha256", "capability_snapshot_sha256", "task_input_manifest_sha256", "result_contract_sha256"]), `${gate.id} action package lineage`);
  Object.entries(actionPackage.lineage).forEach(([key, value]) => fail(SHA256_PATTERN.test(value ?? ""), "invalid_schema", `${gate.id}: invalid action package lineage ${key}`));
  fail(actionPackage.lineage.source_sha256 === run.manifest.source.sha256, "input_crosswire", `${gate.id}: action package source lineage mismatch`);
  fail(actionPackage.lineage.manifest_sha256 === run.state.manifest_sha256, "input_crosswire", `${gate.id}: action package manifest lineage mismatch`);
  fail(actionPackage.lineage.capability_snapshot_sha256 === producerInputManifest.capability_snapshot.sha256, "input_crosswire", `${gate.id}: action package capability lineage mismatch`);
  fail(actionPackage.lineage.task_input_manifest_sha256 === producer.input_manifest_sha256, "input_crosswire", `${gate.id}: action package input lineage mismatch`);
  fail(actionPackage.lineage.result_contract_sha256 === producer.result_contract_receipt?.contract_sha256, "input_crosswire", `${gate.id}: action package result contract lineage mismatch`);
  fail(actionPackage.external_effects_performed === false, "external_effect_forbidden", `${gate.id}: action package cannot attest that external effects were performed`);
  return {
    task_id: gate.action_package.task_id,
    path: artifact.path,
    sha256: artifact.sha256,
    action_ids: [actionPackage.action_id],
    executor_capabilities: actionPackage.executor_capabilities,
    targets: actionPackage.targets,
    scopes: actionPackage.scope,
  };
}

function commandApprove(options) {
  withMutableRun(options, (run, runDir) => {
    const taskId = requireOption(options, "task");
    const decision = requireOption(options, "decision");
    const actor = requireOption(options, "actor");
    fail(decision === "approve" || decision === "reject", "invalid_arguments", "decision must be approve or reject");
    const { task, record } = getTask(run, taskId, "human_gate");
    fail(isReady(task, run.state, runDir), "task_not_ready", `${taskId} gate is not ready`);
    const actionPackage = resolveActionPackage(run, runDir, task);
    if (actionPackage !== null) {
      const existingBindings = Object.entries(run.state.tasks)
        .filter(
          ([otherTaskId, otherRecord]) =>
            otherTaskId !== taskId &&
            otherRecord.gate?.action_package !== undefined &&
            otherRecord.gate.action_package !== null,
        )
        .map(([, otherRecord]) => otherRecord.gate.action_package);
      fail(
        existingBindings.every((binding) => binding.task_id !== actionPackage.task_id),
        "action_package_conflict",
        `${taskId}: action package producer is already bound to another gate`,
      );
      const claimedActionIds = new Set(existingBindings.flatMap((binding) => binding.action_ids));
      fail(
        actionPackage.action_ids.every((actionId) => !claimedActionIds.has(actionId)),
        "action_package_conflict",
        `${taskId}: action_id is already bound to another gate`,
      );
    }
    record.status = decision === "approve" ? "approved" : "rejected";
    record.completed_at = isoNow();
    record.gate = {
      decision,
      actor,
      action: task.action,
      targets: task.targets,
      scope: task.scope,
      action_package: actionPackage,
      external_authorization: false,
      requires_reapproval: actionPackage !== null,
    };
    mkdirSync(join(runDir, "gates"), { recursive: true, mode: 0o700 });
    atomicWriteJson(join(runDir, "gates", `${taskId}.json`), record.gate);
    appendEvent(run.state, "human_gate_decided", taskId, record.gate);
    return { task_id: taskId, status: record.status, decision };
  });
}

function actionHandoffPath(runDir, gateId) {
  return join(runDir, "handoffs", `${gateId}.json`);
}

function validateFileRef(ref, expected, label) {
  assertExactKeys(ref, new Set(["path", "sha256"]), label);
  fail(canonicalJson(ref) === canonicalJson(expected), "handoff_crosswire", `${label} differs from the approved lineage`);
}

function expectedActionHandoff(run, runDir, gate, createdAt) {
  validateFinalReviewStateLineage(run, runDir);
  const record = run.state.tasks[gate.id];
  fail(record?.status === "approved" && record.gate?.decision === "approve", "handoff_not_ready", `${gate.id}: gate is not approved`);
  fail(record.gate.action_package !== null, "handoff_not_ready", `${gate.id}: gate has no action package`);
  fail(run.state.status === "workflow_complete" && run.state.final_review?.verdict === "pass", "handoff_not_ready", "Workflow lacks a passing final review");
  const packageBinding = resolveActionPackage(run, runDir, gate);
  fail(canonicalJson(packageBinding) === canonicalJson(record.gate.action_package), "handoff_crosswire", `${gate.id}: approved package binding drifted`);
  const gatePath = join(runDir, "gates", `${gate.id}.json`);
  fail(existsSync(gatePath) && statSync(gatePath).isFile() && !lstatSync(gatePath).isSymbolicLink(), "handoff_crosswire", `${gate.id}: gate receipt is missing`);
  fail(canonicalJson(readJson(gatePath)) === canonicalJson(record.gate), "handoff_crosswire", `${gate.id}: gate receipt differs from state`);
  const finalReviewPath = assertPathInsideRun(runDir, run.state.final_review.path);
  fail(sha256File(finalReviewPath) === run.state.final_review.sha256, "handoff_crosswire", "Final review drifted before handoff");
  return {
    schema_version: "dynamic-workflow-action-handoff/v1",
    handoff_id: `handoff-${gate.id}`,
    workflow_id: run.state.workflow_id,
    run_id: run.state.run_id,
    package: { path: packageBinding.path, sha256: packageBinding.sha256 },
    final_review: { path: run.state.final_review.path, sha256: run.state.final_review.sha256 },
    workflow_gate: {
      receipt: { path: `gates/${gate.id}.json`, sha256: sha256File(gatePath) },
      meaning: "workflow_semantic_confirmation_only",
      grants_external_authority: false,
    },
    requested_action_ids: packageBinding.action_ids,
    executor_capabilities: packageBinding.executor_capabilities,
    targets: packageBinding.targets,
    scopes: packageBinding.scopes,
    approval_contract: {
      status: "required_after_handoff",
      must_bind: ["package_sha256", "action_ids", "targets", "scopes"],
      reuse_workflow_gate: false,
    },
    execution_status: "not_authorized",
    created_at: createdAt,
  };
}

function validateActionHandoffValue(handoff, expected, runDir, gateId) {
  assertExactKeys(handoff, new Set([
    "schema_version", "handoff_id", "workflow_id", "run_id", "package", "final_review", "workflow_gate",
    "requested_action_ids", "executor_capabilities", "targets", "scopes", "approval_contract", "execution_status", "created_at",
  ]), `${gateId} action handoff`);
  fail(handoff.schema_version === "dynamic-workflow-action-handoff/v1", "unsupported_schema", `${gateId}: unsupported handoff schema`);
  assertDateTime(handoff.created_at, `${gateId} handoff.created_at`);
  fail(handoff.created_at === expected.created_at, "handoff_crosswire", `${gateId}: handoff creation time differs from its receipt`);
  fail(handoff.handoff_id === expected.handoff_id && handoff.workflow_id === expected.workflow_id && handoff.run_id === expected.run_id, "handoff_crosswire", `${gateId}: handoff identity differs`);
  validateFileRef(handoff.package, expected.package, `${gateId} package ref`);
  validateFileRef(handoff.final_review, expected.final_review, `${gateId} final review ref`);
  assertExactKeys(handoff.workflow_gate, new Set(["receipt", "meaning", "grants_external_authority"]), `${gateId} workflow gate`);
  validateFileRef(handoff.workflow_gate.receipt, expected.workflow_gate.receipt, `${gateId} gate receipt ref`);
  fail(handoff.workflow_gate.meaning === "workflow_semantic_confirmation_only" && handoff.workflow_gate.grants_external_authority === false, "handoff_authority_violation", `${gateId}: workflow gate cannot authorize external execution`);
  validateStringArray(handoff.requested_action_ids, `${gateId} requested_action_ids`);
  validateStringArray(handoff.executor_capabilities, `${gateId} executor_capabilities`);
  validateStringArray(handoff.targets, `${gateId} targets`);
  validateStringArray(handoff.scopes, `${gateId} scopes`);
  fail(canonicalJson(handoff.requested_action_ids) === canonicalJson(expected.requested_action_ids), "handoff_crosswire", `${gateId}: action IDs differ from the package`);
  fail(canonicalJson(handoff.executor_capabilities) === canonicalJson(expected.executor_capabilities), "handoff_crosswire", `${gateId}: executor capabilities differ from the package`);
  fail(canonicalJson(handoff.targets) === canonicalJson(expected.targets), "handoff_crosswire", `${gateId}: targets differ from the package`);
  fail(canonicalJson(handoff.scopes) === canonicalJson(expected.scopes), "handoff_crosswire", `${gateId}: scopes differ from the package`);
  assertExactKeys(handoff.approval_contract, new Set(["status", "must_bind", "reuse_workflow_gate"]), `${gateId} approval contract`);
  fail(canonicalJson(handoff.approval_contract) === canonicalJson(expected.approval_contract), "handoff_authority_violation", `${gateId}: external approval contract changed`);
  fail(handoff.execution_status === "not_authorized", "handoff_authority_violation", `${gateId}: handoff cannot attest execution authority`);
  for (const ref of [handoff.package, handoff.final_review, handoff.workflow_gate.receipt]) {
    fail(sha256File(assertPathInsideRun(runDir, ref.path)) === ref.sha256, "handoff_crosswire", `${gateId}: referenced handoff input drifted`);
  }
}

function validateActionHandoffLineage(run, runDir, onlyGateId = null) {
  const handoffDir = join(runDir, "handoffs");
  const expectedHandoffFiles = run.state.action_handoffs.map((receipt) => receipt.path.split("/").at(-1)).sort();
  const actualHandoffFiles = existsSync(handoffDir) ? readdirSync(handoffDir).sort() : [];
  fail(canonicalJson(actualHandoffFiles) === canonicalJson(expectedHandoffFiles), "state_drift", "Action handoff directory differs from state lineage");
  const events = run.state.events.filter((event) => event.type === "action_handoff_prepared");
  fail(events.length === run.state.action_handoffs.length, "state_drift", "Action handoff events and receipts differ");
  fail(new Set(events.map((event) => event.task_id)).size === events.length, "state_drift", "Duplicate action handoff event");
  fail(
    canonicalJson([...events.map((event) => event.task_id)].sort()) === canonicalJson([...run.state.action_handoffs.map((receipt) => receipt.gate_id)].sort()),
    "state_drift",
    "Action handoff event and receipt gate sets differ",
  );
  for (const receipt of run.state.action_handoffs) {
    if (onlyGateId !== null && receipt.gate_id !== onlyGateId) continue;
    const gate = run.manifest.tasks.find((task) => task.id === receipt.gate_id && task.kind === "human_gate");
    fail(gate !== undefined, "state_drift", `Unknown action handoff gate: ${receipt.gate_id}`);
    const expectedPath = actionHandoffPath(runDir, receipt.gate_id);
    fail(relative(runDir, expectedPath).split(sep).join("/") === receipt.path, "state_drift", `${receipt.gate_id}: handoff path differs from canonical path`);
    fail(existsSync(expectedPath) && statSync(expectedPath).isFile() && !lstatSync(expectedPath).isSymbolicLink(), "state_drift", `${receipt.gate_id}: handoff artifact is missing`);
    fail(sha256File(expectedPath) === receipt.sha256, "state_drift", `${receipt.gate_id}: handoff receipt hash differs`);
    const handoff = readJson(expectedPath);
    const expected = expectedActionHandoff(run, runDir, gate, receipt.created_at);
    validateActionHandoffValue(handoff, expected, runDir, gate.id);
    const gateEvents = taskEvents(run.state, gate.id, "action_handoff_prepared");
    fail(gateEvents.length === 1, "state_drift", `${gate.id}: handoff event lineage differs`);
    assertExactKeys(gateEvents[0].details, new Set(["path", "handoff_sha256", "created_at"]), `${gate.id} handoff event`);
    fail(canonicalJson(gateEvents[0].details) === canonicalJson({
      path: receipt.path,
      handoff_sha256: receipt.sha256,
      created_at: receipt.created_at,
    }), "state_drift", `${gate.id}: handoff event lineage differs`);
    fail(Date.parse(gateEvents[0].at) >= Date.parse(receipt.created_at), "state_drift", `${gate.id}: handoff event precedes its receipt`);
  }
  if (onlyGateId !== null) {
    fail(run.state.action_handoffs.some((receipt) => receipt.gate_id === onlyGateId), "handoff_missing", `${onlyGateId}: handoff is not prepared`);
  }
}

function commandHandoffPrepare(options) {
  withMutableRun(options, (run, runDir) => {
    const gateId = requireOption(options, "gate");
    const { task: gate } = getTask(run, gateId, "human_gate");
    const existing = run.state.action_handoffs.find((receipt) => receipt.gate_id === gateId);
    if (existing) {
      validateActionHandoffLineage(run, runDir, gateId);
      return { gate_id: gateId, path: existing.path, sha256: existing.sha256, execution_status: "not_authorized", idempotent: true };
    }
    const createdAt = isoNow();
    const handoff = expectedActionHandoff(run, runDir, gate, createdAt);
    const path = actionHandoffPath(runDir, gateId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    atomicWriteJson(path, handoff);
    const receipt = {
      gate_id: gateId,
      path: relative(runDir, path).split(sep).join("/"),
      sha256: sha256File(path),
      created_at: createdAt,
    };
    run.state.action_handoffs.push(receipt);
    appendEvent(run.state, "action_handoff_prepared", gateId, {
      path: receipt.path,
      handoff_sha256: receipt.sha256,
      created_at: receipt.created_at,
    });
    validateActionHandoffLineage(run, runDir, gateId);
    return { gate_id: gateId, path: receipt.path, sha256: receipt.sha256, execution_status: "not_authorized", idempotent: false };
  });
}

function commandHandoffVerify(options) {
  withMutableRun(options, (run, runDir) => {
    const gateId = requireOption(options, "gate");
    validateActionHandoffLineage(run, runDir, gateId);
    const receipt = run.state.action_handoffs.find((candidate) => candidate.gate_id === gateId);
    return { valid: true, gate_id: gateId, path: receipt.path, sha256: receipt.sha256, execution_status: "not_authorized" };
  });
}

function validateRunIntegrity(run, runDir) {
  const errors = [];
  try {
    ensureSourceHash(run.manifest);
  } catch (error) {
    errors.push(`${error.code ?? "source_error"}:source_lineage`);
  }
  if (run.state.manifest_sha256 !== sha256File(run.paths.manifest)) {
    errors.push("manifest_sha256_mismatch");
  }
  if (run.state.capabilities_sha256 !== sha256File(run.paths.capabilities)) {
    errors.push("capabilities_sha256_mismatch");
  }
  try {
    validateCapabilityReceiptLineage(run.state, runDir, run.manifest);
  } catch (error) {
    errors.push(`${error.code ?? "capability_error"}:capability_receipt_lineage`);
  }
  if (run.state.translation_review_sha256 !== sha256File(run.paths.translationReview)) {
    errors.push("translation_review_sha256_mismatch");
  }
  if (run.state.translation_review_receipt_sha256 !== sha256File(run.paths.translationReviewReceipt)) {
    errors.push("translation_review_receipt_sha256_mismatch");
  }
  if ((run.manifest.invocation_mode ?? "direct") === "skill_bridge") {
    if (!existsSync(run.paths.translationWorkflowCall) || run.state.workflow_call_sha256 !== sha256File(run.paths.translationWorkflowCall)) {
      errors.push("workflow_call_sha256_mismatch");
    }
  } else if (run.state.workflow_call_sha256 !== null || existsSync(run.paths.translationWorkflowCall)) {
    errors.push("unexpected_workflow_call_lineage");
  }
  try {
    validateFrozenTranslationReceipt(run.paths, readJson(run.paths.translationReview), run.manifest);
  } catch (error) {
    errors.push(`${error.code ?? "translation_review_error"}:translation_review_receipt`);
  }
  for (const task of run.manifest.tasks) {
    const record = run.state.tasks[task.id];
    if (!record) {
      errors.push(`missing_state:${task.id}`);
      continue;
    }
    if (task.kind === "agent" && ["prepared", "running", "completed", "resolved", "failed", "blocked"].includes(record.status) && record.invocation_id !== null) {
      try {
        validateTaskInputManifest(run, runDir, task, record);
      } catch (error) {
        errors.push(`${error.code ?? "input_error"}:${task.id}`);
      }
    }
    if (["completed", "resolved"].includes(record.status)) {
      if (task.kind !== "agent" || !record.result_path || !record.result_sha256) {
        errors.push(`incomplete_result_binding:${task.id}`);
        continue;
      }
      try {
        const path = assertPathInsideRun(runDir, record.result_path);
        if (sha256File(path) !== record.result_sha256) {
          errors.push(`result_sha256_mismatch:${task.id}`);
        }
        validateNodeResult(readJson(path), task, record.invocation_id, runDir);
        revalidateResultContract(task, record, runDir);
      } catch (error) {
        errors.push(`${error.code ?? "result_error"}:${task.id}`);
      }
    }
  }
  const stateIds = new Set(Object.keys(run.state.tasks));
  const manifestIds = new Set(run.manifest.tasks.map((task) => task.id));
  for (const id of stateIds) {
    if (!manifestIds.has(id)) {
      errors.push(`unexpected_state:${id}`);
    }
  }
  for (const [left, right] of run.manifest.independent_pairs ?? []) {
    const leftRecord = run.state.tasks[left];
    const rightRecord = run.state.tasks[right];
    if (["completed", "resolved"].includes(leftRecord.status) && ["completed", "resolved"].includes(rightRecord.status) && leftRecord.agent_handle === rightRecord.agent_handle) {
      errors.push(`independent_handle_reused:${left}:${right}`);
    }
  }
  const reviewInvocation = run.state.final_review_invocation;
  if (reviewInvocation !== null) {
    for (const [pathKey, hashKey] of [["prompt_path", "prompt_sha256"], ["state_snapshot_path", "state_snapshot_sha256"], ["input_manifest_path", "input_manifest_sha256"]]) {
      try {
        const path = assertPathInsideRun(runDir, reviewInvocation[pathKey]);
        if (sha256File(path) !== reviewInvocation[hashKey]) {
          errors.push(`final_review_${hashKey}_mismatch`);
        }
      } catch (error) {
        errors.push(`${error.code ?? "review_input_error"}:${pathKey}`);
      }
    }
    try {
      validateRunReviewInputManifest(run, runDir, reviewInvocation);
    } catch (error) {
      errors.push(`${error.code ?? "review_input_error"}:input_manifest`);
    }
  }
  if (run.state.final_review !== null) {
    try {
      const reviewPath = assertPathInsideRun(runDir, run.state.final_review.path);
      if (sha256File(reviewPath) !== run.state.final_review.sha256) {
        errors.push("final_review_sha256_mismatch");
      }
      validateFinalReviewStateLineage(run, runDir);
    } catch (error) {
      errors.push(`${error.code ?? "review_error"}:final_review_lineage`);
    }
  }
  if (["workflow_execution_complete", "workflow_reviewing", "workflow_complete"].includes(run.state.status)) {
    try {
      assertExecutionClosure(run.manifest, run.state);
    } catch (error) {
      errors.push(`${error.code ?? "closure_error"}:execution_closure`);
    }
  }
  return errors;
}

function commandStatus(options) {
  withMutableRun(options, ({ manifest, state }) => summarize(manifest, state));
}

function commandVerify(options) {
  withMutableRun(options, (run, runDir) => {
    reconcileState(run.manifest, run.state, runDir);
    const errors = validateRunIntegrity(run, runDir);
    const structurallyComplete = ["workflow_execution_complete", "workflow_reviewing", "workflow_complete"].includes(run.state.status);
    return {
      valid: errors.length === 0,
      structurally_complete: structurallyComplete,
      status: run.state.status,
      errors,
      state_snapshot_sha256: sha256Text(`${JSON.stringify(run.state, null, 2)}\n`),
    };
  });
}

function runFileRef(runDir, path) {
  return {
    path: relative(runDir, path).split(sep).join("/"),
    sha256: sha256File(path),
  };
}

function writeReviewStateSnapshot(run, runDir) {
  const path = join(runDir, "review", "state-snapshot.json");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteJson(path, {
    schema_version: "dynamic-workflow-review-state/v1",
    captured_at: isoNow(),
    workflow_id: run.state.workflow_id,
    run_id: run.state.run_id,
    manifest_sha256: run.state.manifest_sha256,
    capabilities_sha256: run.state.capabilities_sha256,
    active_capabilities: run.state.active_capabilities,
    capability_receipts: run.state.capability_receipts,
    translation_review_sha256: run.state.translation_review_sha256,
    translation_review_receipt_sha256: run.state.translation_review_receipt_sha256,
    execution_status: run.state.status,
    agent_runs_prepared: run.state.agent_runs_prepared,
    effective_max_parallel: run.state.effective_max_parallel,
    effective_max_agent_runs: run.state.effective_max_agent_runs,
    tasks: run.state.tasks,
    events: run.state.events,
  });
  return runFileRef(runDir, path);
}

function writeRunReviewInputManifest(run, runDir, stateSnapshot) {
  const path = join(runDir, "review", "input-manifest.json");
  const results = run.manifest.tasks
    .filter((task) => task.kind === "agent" && run.state.tasks[task.id].result_path !== null)
    .map((task) => {
      const record = run.state.tasks[task.id];
      return {
        task_id: task.id,
        invocation_id: record.invocation_id,
        outcome: record.outcome,
        status: record.status,
        path: record.result_path,
        sha256: record.result_sha256,
        result_contract_receipt: record.result_contract_receipt,
      };
    });
  const gates = run.manifest.tasks
    .filter((task) => task.kind === "human_gate" && run.state.tasks[task.id].gate !== null)
    .map((task) => ({ task_id: task.id, status: run.state.tasks[task.id].status, ...run.state.tasks[task.id].gate }));
  atomicWriteJson(path, {
    schema_version: "dynamic-workflow-run-review-input/v1",
    workflow_id: run.state.workflow_id,
    run_id: run.state.run_id,
    manifest: runFileRef(runDir, run.paths.manifest),
    capabilities: runFileRef(runDir, run.paths.capabilities),
    active_capabilities: run.state.active_capabilities,
    capability_receipts: run.state.capability_receipts,
    translation_review: runFileRef(runDir, run.paths.translationReview),
    translation_review_receipt: runFileRef(runDir, run.paths.translationReviewReceipt),
    state_snapshot: stateSnapshot,
    results,
    gates,
  });
  return runFileRef(runDir, path);
}

function validateRunReviewInputManifest(run, runDir, invocation) {
  const path = assertPathInsideRun(runDir, invocation.input_manifest_path);
  fail(sha256File(path) === invocation.input_manifest_sha256, "review_crosswire", "Final review input manifest drifted");
  const input = readJson(path);
  assertExactKeys(input, new Set(["schema_version", "workflow_id", "run_id", "manifest", "capabilities", "active_capabilities", "capability_receipts", "translation_review", "translation_review_receipt", "state_snapshot", "results", "gates"]), "run review input manifest");
  fail(input.schema_version === "dynamic-workflow-run-review-input/v1", "review_crosswire", "Final review input schema mismatch");
  fail(input.workflow_id === run.state.workflow_id && input.run_id === run.state.run_id, "review_crosswire", "Final review input run identity mismatch");
  const expectedRefs = {
    manifest: runFileRef(runDir, run.paths.manifest),
    capabilities: runFileRef(runDir, run.paths.capabilities),
    translation_review: runFileRef(runDir, run.paths.translationReview),
    translation_review_receipt: runFileRef(runDir, run.paths.translationReviewReceipt),
    state_snapshot: { path: invocation.state_snapshot_path, sha256: invocation.state_snapshot_sha256 },
  };
  for (const [key, expected] of Object.entries(expectedRefs)) {
    fail(canonicalJson(input[key]) === canonicalJson(expected), "review_crosswire", `Final review ${key} reference mismatch`);
    const referenced = assertPathInsideRun(runDir, input[key].path);
    fail(sha256File(referenced) === input[key].sha256, "review_crosswire", `Final review ${key} drifted`);
  }
  fail(canonicalJson(input.active_capabilities) === canonicalJson(run.state.active_capabilities), "review_crosswire", "Final review active capability reference mismatch");
  fail(canonicalJson(input.capability_receipts) === canonicalJson(run.state.capability_receipts), "review_crosswire", "Final review capability receipt lineage mismatch");
  input.capability_receipts.forEach((receipt) => capabilityRefPath(runDir, receipt));
  const expectedResults = run.manifest.tasks
    .filter((task) => task.kind === "agent" && run.state.tasks[task.id].result_path !== null)
    .map((task) => {
      const record = run.state.tasks[task.id];
      return { task_id: task.id, invocation_id: record.invocation_id, outcome: record.outcome, status: record.status, path: record.result_path, sha256: record.result_sha256, result_contract_receipt: record.result_contract_receipt };
    });
  const expectedGates = run.manifest.tasks
    .filter((task) => task.kind === "human_gate" && run.state.tasks[task.id].gate !== null)
    .map((task) => ({ task_id: task.id, status: run.state.tasks[task.id].status, ...run.state.tasks[task.id].gate }));
  fail(canonicalJson(input.results) === canonicalJson(expectedResults), "review_crosswire", "Final review result set mismatch");
  fail(canonicalJson(input.gates) === canonicalJson(expectedGates), "review_crosswire", "Final review gate set mismatch");
}

function commandReviewPrepare(options) {
  withMutableRun(options, (run, runDir) => {
    reconcileState(run.manifest, run.state, runDir);
    fail(run.state.status === "workflow_execution_complete", "workflow_not_complete", "Execution is not structurally complete");
    assertExecutionClosure(run.manifest, run.state);
    const errors = validateRunIntegrity(run, runDir);
    fail(errors.length === 0, "run_invalid", errors.join(", "));
    fail(run.state.final_review_invocation === null, "invalid_transition", "Final review invocation already exists");
    const invocationId = requireOption(options, "invocation");
    fail(INVOCATION_PATTERN.test(invocationId), "invalid_arguments", "Invalid invocation id");
    const promptPath = assertPathInsideRun(runDir, requireOption(options, "prompt"));
    const promptRelative = relative(runDir, promptPath).split(sep).join("/").toLowerCase();
    fail(!["review/state-snapshot.json", "review/input-manifest.json", "final-review.json"].includes(promptRelative), "unsafe_path", "Final review prompt collides with controller-owned path");
    const stateSnapshot = writeReviewStateSnapshot(run, runDir);
    const inputManifest = writeRunReviewInputManifest(run, runDir, stateSnapshot);
    run.state.final_review_invocation = {
      invocation_id: invocationId,
      agent_handle: null,
      status: "prepared",
      prepared_at: isoNow(),
      started_at: null,
      prompt_path: relative(runDir, promptPath).split(sep).join("/"),
      prompt_sha256: sha256File(promptPath),
      state_snapshot_path: stateSnapshot.path,
      state_snapshot_sha256: stateSnapshot.sha256,
      input_manifest_path: inputManifest.path,
      input_manifest_sha256: inputManifest.sha256,
    };
    appendEvent(run.state, "final_review_invocation_prepared", null, {
      invocation_id: invocationId,
      prompt_sha256: run.state.final_review_invocation.prompt_sha256,
      state_snapshot_sha256: stateSnapshot.sha256,
      input_manifest_sha256: run.state.final_review_invocation.input_manifest_sha256,
    });
    return { invocation_id: invocationId, status: "prepared", prompt_sha256: run.state.final_review_invocation.prompt_sha256, state_snapshot_sha256: stateSnapshot.sha256, input_manifest_path: inputManifest.path, input_manifest_sha256: inputManifest.sha256 };
  });
}

function commandReviewBind(options) {
  withMutableRun(options, (run) => {
    const invocationId = requireOption(options, "invocation");
    const agentHandle = requireOption(options, "agent");
    const invocation = run.state.final_review_invocation;
    fail(invocation?.status === "prepared", "invalid_transition", "Final review invocation is not prepared");
    fail(invocation.invocation_id === invocationId, "invocation_conflict", "Final review invocation id mismatch");
    const producerHandles = Object.values(run.state.tasks).map((record) => record.agent_handle).filter(Boolean);
    fail(!producerHandles.includes(agentHandle), "reviewer_not_independent", "Final reviewer handle was used by a workflow task");
    const translationReview = readJson(run.paths.translationReview);
    fail(![translationReview.translator_handle, translationReview.reviewer_handle].filter(Boolean).includes(agentHandle), "reviewer_not_independent", "Final reviewer handle was used during translation or contract review");
    invocation.agent_handle = agentHandle;
    invocation.status = "running";
    invocation.started_at = isoNow();
    appendEvent(run.state, "final_review_handle_bound", null, { invocation_id: invocationId, agent_handle: agentHandle });
    return { invocation_id: invocationId, agent_handle: agentHandle, status: "running" };
  });
}

function validateRunReview(review, run, runDir, expectedInvocationStatus = "running") {
  const keys = new Set(["schema_version", "workflow_id", "run_id", "manifest_sha256", "state_snapshot_sha256", "invocation_id", "reviewer_handle", "prompt_sha256", "input_manifest_sha256", "verdict", "summary", "findings"]);
  assertExactKeys(review, keys, "run review");
  fail(review.schema_version === "dynamic-workflow-run-review/v1", "unsupported_schema", "Unsupported run review schema");
  fail(review.workflow_id === run.state.workflow_id, "review_crosswire", "Review workflow_id mismatch");
  fail(review.run_id === run.state.run_id, "review_crosswire", "Review run_id mismatch");
  fail(review.manifest_sha256 === run.state.manifest_sha256, "review_crosswire", "Review manifest hash mismatch");
  const invocation = run.state.final_review_invocation;
  fail(invocation?.status === expectedInvocationStatus, "invalid_transition", `Final review invocation is not ${expectedInvocationStatus}`);
  fail(review.state_snapshot_sha256 === invocation.state_snapshot_sha256, "review_crosswire", "Review state snapshot hash mismatch");
  fail(review.invocation_id === invocation.invocation_id, "review_crosswire", "Review invocation id mismatch");
  fail(review.prompt_sha256 === invocation.prompt_sha256, "review_crosswire", "Review prompt hash mismatch");
  fail(review.input_manifest_sha256 === invocation.input_manifest_sha256, "review_crosswire", "Review input manifest hash mismatch");
  fail(sha256File(assertPathInsideRun(runDir, invocation.prompt_path)) === invocation.prompt_sha256, "review_crosswire", "Final review prompt drifted");
  fail(sha256File(assertPathInsideRun(runDir, invocation.input_manifest_path)) === invocation.input_manifest_sha256, "review_crosswire", "Final review input manifest drifted");
  validateRunReviewInputManifest(run, runDir, invocation);
  assertString(review.reviewer_handle, "reviewer_handle");
  fail(review.reviewer_handle === invocation.agent_handle, "review_crosswire", "Review handle differs from bound reviewer handle");
  fail(["pass", "revise", "stop_with_unknowns"].includes(review.verdict), "invalid_schema", "Invalid review verdict");
  fail(typeof review.summary === "string", "invalid_schema", "Invalid review summary");
  validateStringArray(review.findings, "Review findings");
  const producerHandles = Object.values(run.state.tasks).map((record) => record.agent_handle).filter(Boolean);
  fail(!producerHandles.includes(review.reviewer_handle), "reviewer_not_independent", "Final reviewer handle was used by a workflow task");
  const translationReview = readJson(run.paths.translationReview);
  fail(![translationReview.translator_handle, translationReview.reviewer_handle].filter(Boolean).includes(review.reviewer_handle), "reviewer_not_independent", "Final reviewer handle was used during translation or contract review");
}

function validateFinalReviewStateLineage(run, runDir) {
  validateFinalReviewStateShape(run.state);
  const invocation = run.state.final_review_invocation;
  if (invocation === null) return;
  for (const [pathKey, hashKey] of [["prompt_path", "prompt_sha256"], ["state_snapshot_path", "state_snapshot_sha256"], ["input_manifest_path", "input_manifest_sha256"]]) {
    fail(sha256File(assertPathInsideRun(runDir, invocation[pathKey])) === invocation[hashKey], "review_crosswire", `Final review invocation ${pathKey} drifted`);
  }
  validateRunReviewInputManifest(run, runDir, invocation);
  if (invocation.status !== "completed") return;
  const finalReview = run.state.final_review;
  const reviewPath = assertPathInsideRun(runDir, finalReview.path);
  fail(sha256File(reviewPath) === finalReview.sha256, "review_crosswire", "Final review file differs from state");
  const review = readJson(reviewPath);
  validateRunReview(review, run, runDir, "completed");
  fail(review.reviewer_handle === finalReview.reviewer_handle && review.verdict === finalReview.verdict, "review_crosswire", "Final review document differs from state");
}

function commandFinalize(options) {
  withMutableRun(options, (run, runDir) => {
    reconcileState(run.manifest, run.state, runDir);
    fail(run.state.status === "workflow_reviewing", "workflow_not_complete", "Final review invocation is not active");
    assertExecutionClosure(run.manifest, run.state);
    ensureSourceHash(run.manifest);
    const errors = validateRunIntegrity(run, runDir);
    fail(errors.length === 0, "run_invalid", errors.join(", "));
    const reviewPath = resolve(requireOption(options, "review"));
    const reviewRelation = relative(runDir, reviewPath);
    fail(reviewRelation !== "" && !reviewRelation.startsWith(`..${sep}`) && reviewRelation !== ".." && !isAbsolute(reviewRelation), "unsafe_path", "Review must be staged inside the run directory");
    assertPathInsideRun(runDir, reviewRelation);
    const review = readJson(reviewPath);
    validateRunReview(review, run, runDir);
    const destination = join(runDir, "final-review.json");
    fail(resolve(reviewPath) !== destination, "invalid_arguments", "Review must be staged outside canonical final-review.json");
    copyFileSync(reviewPath, destination);
    run.state.final_review = {
      path: "final-review.json",
      sha256: sha256File(destination),
      reviewer_handle: review.reviewer_handle,
      verdict: review.verdict,
      recorded_at: isoNow(),
    };
    run.state.final_review_invocation.status = "completed";
    appendEvent(run.state, "final_review_recorded", null, { verdict: review.verdict, review_sha256: run.state.final_review.sha256 });
    return { status: review.verdict === "pass" ? "workflow_complete" : "workflow_incomplete", verdict: review.verdict };
  });
}

function usage() {
  return [
    "workflow-control.mjs init --manifest FILE --translation-review FILE --translation-review-receipt FILE --capabilities FILE --run-dir DIR [--workflow-call FILE] [--max-parallel N] [--max-agent-runs N]",
    "  init: --workflow-call FILE is required for invocation_mode=skill_bridge and forbidden for invocation_mode=direct",
    "workflow-control.mjs ready --run-dir DIR",
    "workflow-control.mjs prepare --run-dir DIR --task ID --invocation ID",
    "workflow-control.mjs bind --run-dir DIR --task ID --invocation ID --agent HANDLE",
    "workflow-control.mjs finish --run-dir DIR --task ID --invocation ID --result FILE",
    "workflow-control.mjs abort --run-dir DIR --task ID --invocation ID --reason TEXT",
    "workflow-control.mjs approve --run-dir DIR --task ID --decision approve|reject --actor NAME",
    "workflow-control.mjs status --run-dir DIR",
    "workflow-control.mjs verify --run-dir DIR",
    "workflow-control.mjs review-prepare --run-dir DIR --invocation ID --prompt FILE",
    "workflow-control.mjs review-bind --run-dir DIR --invocation ID --agent HANDLE",
    "workflow-control.mjs finalize --run-dir DIR --review FILE",
    "workflow-control.mjs handoff-prepare --run-dir DIR --gate ID",
    "workflow-control.mjs handoff-verify --run-dir DIR --gate ID",
    "workflow-control.mjs recover-lock --run-dir DIR --actor NAME",
  ].join("\n");
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const commands = {
    init: commandInit,
    ready: commandReady,
    prepare: commandPrepare,
    bind: commandBind,
    finish: commandFinish,
    abort: commandAbort,
    approve: commandApprove,
    status: commandStatus,
    verify: commandVerify,
    "review-prepare": commandReviewPrepare,
    "review-bind": commandReviewBind,
    finalize: commandFinalize,
    "handoff-prepare": commandHandoffPrepare,
    "handoff-verify": commandHandoffVerify,
    "recover-lock": commandRecoverLock,
  };
  fail(commands[command] !== undefined, "invalid_arguments", usage());
  commands[command](options);
}

try {
  main();
} catch (error) {
  const code = error instanceof WorkflowError || typeof error?.code === "string" ? error.code : "internal_error";
  process.stderr.write(`${JSON.stringify({ status: "error", code, message: error.message })}\n`);
  process.exitCode = 1;
}
