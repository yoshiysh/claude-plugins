#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const evalDir = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(evalDir, "..");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`JSON parse failed for ${path}: ${error.message}`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

function unique(values, label) {
  invariant(new Set(values).size === values.length, `${label} must be unique`);
}

function safeSkillPath(fileRef) {
  invariant(typeof fileRef === "string" && fileRef.length > 0, "file reference must be a non-empty string");
  invariant(!isAbsolute(fileRef), `absolute file reference is forbidden: ${fileRef}`);
  const path = resolve(skillDir, fileRef);
  invariant(path.startsWith(`${skillDir}${sep}`), `file reference escapes the skill directory: ${fileRef}`);
  const stat = lstatSync(path);
  invariant(stat.isFile(), `file reference is not a regular file: ${fileRef}`);
  invariant(!stat.isSymbolicLink(), `symlink fixture is not reproducible: ${fileRef}`);
  return path;
}

function safeSkillDirectory(directoryRef) {
  invariant(typeof directoryRef === "string" && directoryRef.length > 0, "directory reference must be a non-empty string");
  invariant(!isAbsolute(directoryRef), `absolute directory reference is forbidden: ${directoryRef}`);
  const path = resolve(skillDir, directoryRef);
  invariant(path.startsWith(`${skillDir}${sep}`), `directory reference escapes the skill directory: ${directoryRef}`);
  const stat = lstatSync(path);
  invariant(stat.isDirectory(), `directory reference is not a directory: ${directoryRef}`);
  invariant(!stat.isSymbolicLink(), `symlink fixture directory is not reproducible: ${directoryRef}`);
  return path;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function assertExactArray(actual, expected, label) {
  invariant(Array.isArray(actual), `${label} must be an array`);
  invariant(JSON.stringify(actual) === JSON.stringify(expected), `${label} does not exactly match`);
}

function resolveSchemaRef(root, ref) {
  invariant(typeof ref === "string" && ref.startsWith("#/"), `unsupported schema reference: ${ref}`);
  return ref.slice(2).split("/").reduce((value, token) => {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    invariant(value !== null && typeof value === "object" && Object.hasOwn(value, key), `unresolved schema reference: ${ref}`);
    return value[key];
  }, root);
}

function typeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function stringErrors(schema, value, path) {
  if (typeof value !== "string") return [];
  const errors = [];
  if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than minLength`);
  if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than maxLength`);
  if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: pattern mismatch`);
  if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) errors.push(`${path}: invalid date-time`);
  return errors;
}

function numberErrors(schema, value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) return [];
  const errors = [];
  if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
  if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`);
  return errors;
}

function arrayErrors(schema, value, root, path) {
  if (!Array.isArray(value)) return [];
  const errors = [];
  if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`);
  if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: too many items`);
  if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${path}: duplicate items`);
  for (const [index, child] of (schema.prefixItems ?? []).entries()) if (index < value.length) errors.push(...schemaErrors(child, value[index], root, `${path}[${index}]`));
  const offset = schema.prefixItems?.length ?? 0;
  if (schema.items === false && value.length > offset) errors.push(`${path}: additional items`);
  else if (schema.items && typeof schema.items === "object") value.slice(offset).forEach((item, index) => errors.push(...schemaErrors(schema.items, item, root, `${path}[${index + offset}]`)));
  if (schema.contains !== undefined && !value.some((item, index) => schemaErrors(schema.contains, item, root, `${path}[${index}]`).length === 0)) errors.push(`${path}: contains mismatch`);
  return errors;
}

function objectErrors(schema, value, root, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const errors = [];
  for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}: missing property ${key}`);
  for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key)) errors.push(...schemaErrors(child, value[key], root, `${path}.${key}`));
  const extras = Object.keys(value).filter((key) => !Object.hasOwn(schema.properties ?? {}, key));
  if (schema.additionalProperties === false && extras.length > 0) errors.push(`${path}: additional properties ${extras.join(",")}`);
  else if (schema.additionalProperties && typeof schema.additionalProperties === "object") extras.forEach((key) => errors.push(...schemaErrors(schema.additionalProperties, value[key], root, `${path}.${key}`)));
  return errors;
}

function schemaErrors(schema, value, root = schema, path = "$") {
  if (schema === true) return [];
  if (schema === false) return [`${path}: false schema`];
  const errors = [];
  if (schema.$ref !== undefined) errors.push(...schemaErrors(resolveSchemaRef(root, schema.$ref), value, root, path));
  if (schema.type !== undefined && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some((type) => typeMatches(value, type))) errors.push(`${path}: type mismatch`);
  if (Object.hasOwn(schema, "const") && JSON.stringify(value) !== JSON.stringify(schema.const)) errors.push(`${path}: const mismatch`);
  if (schema.enum !== undefined && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) errors.push(`${path}: enum mismatch`);
  errors.push(...stringErrors(schema, value, path), ...numberErrors(schema, value, path), ...arrayErrors(schema, value, root, path), ...objectErrors(schema, value, root, path));
  for (const child of schema.allOf ?? []) errors.push(...schemaErrors(child, value, root, path));
  if (schema.anyOf !== undefined && !schema.anyOf.some((child) => schemaErrors(child, value, root, path).length === 0)) errors.push(`${path}: anyOf mismatch`);
  if (schema.oneOf !== undefined && schema.oneOf.filter((child) => schemaErrors(child, value, root, path).length === 0).length !== 1) errors.push(`${path}: oneOf mismatch`);
  if (schema.not !== undefined && schemaErrors(schema.not, value, root, path).length === 0) errors.push(`${path}: not matched`);
  if (schema.if !== undefined && schemaErrors(schema.if, value, root, path).length === 0 && schema.then !== undefined) errors.push(...schemaErrors(schema.then, value, root, path));
  return errors;
}

function assertSchemaValid(schema, value, label) {
  const errors = schemaErrors(schema, value);
  invariant(errors.length === 0, `${label} failed schema validation: ${errors.slice(0, 5).join("; ")}`);
}

function resolveDeclaredSource(root, declared) {
  invariant(typeof declared === "string" && declared.length > 0, "declared workflow source must be a non-empty string");
  invariant(!declared.includes("\0"), "declared workflow source contains NUL");
  const marker = "[SKILL_DIR]";
  let path;
  if (declared.startsWith(marker)) {
    invariant(declared === marker || declared.startsWith(`${marker}/`) || declared.startsWith(`${marker}\\`), "ambiguous [SKILL_DIR] marker");
    invariant(declared.indexOf(marker, marker.length) === -1, "multiple [SKILL_DIR] markers");
    path = resolve(root, declared.slice(marker.length).replace(/^[/\\]+/u, ""));
  } else {
    invariant(!declared.includes(marker), "[SKILL_DIR] marker is not leading");
    path = isAbsolute(declared) ? resolve(declared) : resolve(root, declared);
  }
  const relation = relative(root, path);
  invariant(relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation), "workflow source escapes caller root");
  return path;
}

function runBridgeCallValidation(callPath, expectedSuccess, expectedCode = null) {
  const bridgeScript = resolve(skillDir, "scripts/workflow-bridge.mjs");
  const execution = spawnSync(process.execPath, [bridgeScript, "validate-call", "--call", callPath], { encoding: "utf8" });
  if (expectedSuccess) {
    invariant(execution.status === 0, `bridge call validation failed: ${execution.stderr.trim() || execution.stdout.trim()}`);
    const result = JSON.parse(execution.stdout);
    invariant(result.status === "workflow_call_valid", "bridge validate-call did not report workflow_call_valid");
    return result;
  }
  invariant(execution.status !== 0, `bridge call mutation unexpectedly passed: ${callPath}`);
  const error = JSON.parse(execution.stderr);
  invariant(error.status === "error", "bridge call mutation did not report error status");
  if (expectedCode !== null) invariant(error.code === expectedCode, `bridge mutation expected ${expectedCode} but received ${error.code}`);
  return error;
}

function materializeCallTemplate(template, callSchema, temporaryDirectory) {
  const fixtureCallerRoot = safeSkillDirectory(template.caller_root_ref);
  const fixtureSkillMdPath = resolve(fixtureCallerRoot, "caller-skill.fixture.txt");
  const fixtureSourcePath = safeSkillPath(template.source_ref);
  const sourceRelativePath = relative(fixtureCallerRoot, fixtureSourcePath);
  invariant(sourceRelativePath !== "" && !sourceRelativePath.startsWith(`..${sep}`) && !isAbsolute(sourceRelativePath), `source fixture escapes caller root for ${template.template_id}`);
  const callerRoot = resolve(temporaryDirectory, "callers", template.template_id);
  const skillMdPath = resolve(callerRoot, "SKILL.md");
  const sourcePath = resolve(callerRoot, sourceRelativePath);
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(skillMdPath, readFileSync(fixtureSkillMdPath), { mode: 0o600 });
  writeFileSync(sourcePath, readFileSync(fixtureSourcePath), { mode: 0o600 });
  const callDirectory = resolve(temporaryDirectory, "bridge", template.template_id);
  mkdirSync(callDirectory, { recursive: true });
  const callPath = resolve(callDirectory, `${template.template_id}.json`);
  const argumentsPath = resolve(callDirectory, `${template.template_id}.arguments.json`);
  const phaseOwnershipPath = resolve(callDirectory, `${template.template_id}.phases.json`);
  const nativeObservationPath = resolve(callDirectory, `${template.template_id}.native.json`);
  writeJson(argumentsPath, template.call.arguments.value);
  writeJson(phaseOwnershipPath, template.call.caller_phase_ownership);
  writeJson(nativeObservationPath, template.call.native_workflow_observation);
  const bridgeScript = resolve(skillDir, "scripts/workflow-bridge.mjs");
  const prepared = spawnSync(process.execPath, [
    bridgeScript,
    "prepare-call",
    "--caller-skill-root", callerRoot,
    "--declared-script-path", template.call.workflow.declared_script_path,
    "--args", argumentsPath,
    "--phase-ownership", phaseOwnershipPath,
    "--native-observation", nativeObservationPath,
    "--call-id", template.call.call_id,
    "--output", callPath,
  ], { encoding: "utf8" });
  invariant(prepared.status === 0, `prepare-call failed for ${template.template_id}: ${prepared.stderr.trim() || prepared.stdout.trim()}`);
  invariant(JSON.parse(prepared.stdout).status === "workflow_call_ready", `prepare-call did not report workflow_call_ready for ${template.template_id}`);
  const call = readJson(callPath);
  invariant(resolveDeclaredSource(callerRoot, call.workflow.declared_script_path) === sourcePath, `declared source does not resolve to fixture for ${template.template_id}`);
  invariant(canonicalJson(call.arguments.value) === canonicalJson(template.call.arguments.value), `prepared arguments changed for ${template.template_id}`);
  invariant(canonicalJson(call.caller_phase_ownership) === canonicalJson(template.call.caller_phase_ownership), `prepared phase ownership changed for ${template.template_id}`);
  invariant(canonicalJson(call.native_workflow_observation) === canonicalJson(template.call.native_workflow_observation), `prepared native observation changed for ${template.template_id}`);
  assertSchemaValid(callSchema, call, `materialized workflow call ${template.template_id}`);
  const validation = runBridgeCallValidation(callPath, true);
  invariant(validation.call_id === call.call_id, `bridge validation call_id mismatch for ${template.template_id}`);
  invariant(validation.resolved_source_path === sourcePath, `bridge validation source mismatch for ${template.template_id}`);
  invariant(validation.arguments_canonical_sha256 === call.arguments.canonical_sha256, `bridge validation arguments hash mismatch for ${template.template_id}`);
  return {
    template_id: template.template_id,
    call,
    call_path: callPath,
    call_file_sha256: sha256(readFileSync(callPath)),
    caller_root: callerRoot,
    source_path: sourcePath,
  };
}

function assertReturnBound(workflowReturn, returnSchemaDocument, callRecord) {
  invariant(workflowReturn.call_id === callRecord.call.call_id, "workflow return call_id is crosswired");
  invariant(workflowReturn.receipt.workflow_call_sha256 === callRecord.call_file_sha256, "workflow return call hash is crosswired");
  invariant(workflowReturn.receipt.value_canonical_sha256 === sha256(canonicalJson(workflowReturn.value)), "workflow return value hash drifted");
  invariant(workflowReturn.receipt.schema_sha256 === sha256(canonicalJson(returnSchemaDocument)), "workflow return schema hash drifted");
  invariant(workflowReturn.caller_continuation.invoking_skill_root === callRecord.caller_root, "workflow return caller root is crosswired");
  assertExactArray(workflowReturn.caller_continuation.post_workflow, callRecord.call.caller_phase_ownership.post_workflow, "workflow return post_workflow");
  assertExactArray(workflowReturn.caller_continuation.human_gates, callRecord.call.caller_phase_ownership.human_gates, "workflow return human_gates");
  invariant(schemaErrors(returnSchemaDocument, workflowReturn.value).length === 0, "workflow return value violates its bound schema");
}

function materializeReturnTemplate(template, returnSchema, callByTemplate) {
  const callRecord = callByTemplate.get(template.call_template_id);
  invariant(callRecord, `unknown call template ${template.call_template_id}`);
  const workflowReturn = structuredClone(template.return);
  workflowReturn.receipt.workflow_call_sha256 = callRecord.call_file_sha256;
  workflowReturn.receipt.manifest_sha256 = sha256(`manifest:${template.template_id}`);
  workflowReturn.receipt.final_review_sha256 = sha256(`final-review:${template.template_id}`);
  workflowReturn.receipt.value_canonical_sha256 = sha256(canonicalJson(workflowReturn.value));
  workflowReturn.receipt.schema_sha256 = sha256(canonicalJson(template.return_schema));
  workflowReturn.caller_continuation.invoking_skill_root = callRecord.caller_root;
  assertSchemaValid(returnSchema, workflowReturn, `materialized workflow return ${template.template_id}`);
  assertReturnBound(workflowReturn, template.return_schema, callRecord);
  return { template_id: template.template_id, workflow_return: workflowReturn, return_schema: template.return_schema };
}

function materializeReturnBindingTemplate(template, workflowSchema, callByTemplate) {
  const callRecord = callByTemplate.get(template.call_template_id);
  invariant(callRecord, `unknown call template ${template.call_template_id}`);
  const binding = structuredClone(template.binding);
  binding.workflow_call_sha256 = callRecord.call_file_sha256;
  if (binding.schema.kind === "inline") binding.schema.canonical_sha256 = sha256(canonicalJson(binding.schema.document));
  const errors = schemaErrors(workflowSchema.$defs.return_binding, binding, workflowSchema, `return_binding:${template.template_id}`);
  invariant(errors.length === 0, `return binding ${template.template_id} failed schema validation: ${errors.slice(0, 5).join("; ")}`);
  invariant(binding.workflow_call_sha256 === callRecord.call_file_sha256, `return binding ${template.template_id} is crosswired`);
  return { template_id: template.template_id, binding, call_template_id: template.call_template_id };
}

function deriveRoute(routeCase, callByTemplate) {
  if (routeCase.active_workflow_callsite === false) return { route: "not_applicable", bridge: 0, native: 0 };
  if (routeCase.native_workflow_attempted === true) return { route: "reject", bridge: 0, native: 1 };
  if (routeCase.native_workflow_callable === true) return { route: "native", bridge: 0, native: 1 };
  if (routeCase.ambiguous === true) return { route: "reject", bridge: 0, native: 0 };
  const templateIds = routeCase.call_template_ids ?? (routeCase.call_template_id === null ? [] : [routeCase.call_template_id]);
  if (templateIds.length > 0) {
    invariant(templateIds.every((templateId) => callByTemplate.has(templateId)), `route case ${routeCase.case_id} references an unknown call template`);
    return { route: "bridge", bridge: templateIds.length, native: 0 };
  }
  if (routeCase.declared_script_path !== undefined) {
    const callerRoot = safeSkillDirectory(routeCase.caller_root_ref);
    try {
      const path = resolveDeclaredSource(callerRoot, routeCase.declared_script_path);
      const stat = lstatSync(path);
      if (stat.isFile() && !stat.isSymbolicLink()) return { route: "bridge", bridge: 1, native: 0 };
    } catch {
      return { route: "reject", bridge: 0, native: 0 };
    }
  }
  return { route: "reject", bridge: 0, native: 0 };
}

function workflowCallBinding(callRecord) {
  return {
    receipt: { path: callRecord.call_path, sha256: callRecord.call_file_sha256 },
    caller_phase_ownership: structuredClone(callRecord.call.caller_phase_ownership),
    native_workflow_observation: structuredClone(callRecord.call.native_workflow_observation),
  };
}

function assertBridgeTranslationBinding(document, expectedBinding, label) {
  invariant(Object.hasOwn(document, "workflow_call"), `${label} is missing workflow_call for skill_bridge`);
  invariant(canonicalJson(document.workflow_call) === canonicalJson(expectedBinding), `${label} is crosswired`);
}

function verifyTranslationCallBindings(cases, callByTemplate, inputSchema, receiptSchema) {
  invariant(Array.isArray(cases) && cases.length >= 3, "workflow-call fixtures must contain translation binding cases");
  unique(cases.map((item) => item.mutation_id), "translation binding mutation ids");
  let accepted = 0;
  let rejected = 0;

  for (const fixture of cases) {
    const targetCall = callByTemplate.get(fixture.call_template_id);
    invariant(targetCall, `translation binding ${fixture.mutation_id} references an unknown target call`);
    const expectedBinding = workflowCallBinding(targetCall);
    const boundCall = fixture.binding_call_template_id === null ? null : callByTemplate.get(fixture.binding_call_template_id);
    invariant(fixture.binding_call_template_id === null || boundCall, `translation binding ${fixture.mutation_id} references an unknown bound call`);
    const suppliedBinding = boundCall === null ? null : workflowCallBinding(boundCall);
    const reviewInput = {
      schema_version: "dynamic-workflow-translation-review-input/v1",
      source: {
        path: targetCall.call.workflow.resolved_source.path,
        sha256: targetCall.call.workflow.resolved_source.sha256,
      },
      manifest: {
        path: resolve(targetCall.caller_root, ".workflow-calls", "manifest.json"),
        canonical_sha256: sha256(`manifest:${fixture.mutation_id}`),
      },
    };
    const reviewReceipt = {
      schema_version: "dynamic-workflow-translation-review-receipt/v1",
      invocation_id: `translation-review:${fixture.mutation_id}`,
      reviewer_handle: "fresh-translation-reviewer",
      context_policy: "fresh",
      parent_context_inherited: false,
      translation_mode: "translated",
      handle_boundary: "runtime_enforced",
      prompt: { path: resolve(targetCall.caller_root, ".workflow-calls", "review-prompt.txt"), sha256: sha256(`prompt:${fixture.mutation_id}`) },
      input_manifest: { path: resolve(targetCall.caller_root, ".workflow-calls", "review-input.json"), sha256: sha256(`input:${fixture.mutation_id}`) },
      invoked_at: "2026-08-21T00:00:00Z",
    };
    if (suppliedBinding !== null) {
      reviewInput.workflow_call = structuredClone(suppliedBinding);
      reviewReceipt.workflow_call = structuredClone(suppliedBinding);
    }

    if (fixture.mutation !== "missing") {
      assertSchemaValid(inputSchema, reviewInput, `translation input ${fixture.mutation_id}`);
      assertSchemaValid(receiptSchema, reviewReceipt, `translation receipt ${fixture.mutation_id}`);
    }
    let wasRejected = false;
    try {
      assertBridgeTranslationBinding(reviewInput, expectedBinding, `translation input ${fixture.mutation_id}`);
      assertBridgeTranslationBinding(reviewReceipt, expectedBinding, `translation receipt ${fixture.mutation_id}`);
    } catch {
      wasRejected = true;
    }
    if (fixture.expected_binding === "accept") {
      invariant(!wasRejected, `translation binding ${fixture.mutation_id} was unexpectedly rejected`);
      accepted += 1;
    } else {
      invariant(fixture.expected_binding === "reject" && wasRejected, `translation binding ${fixture.mutation_id} was not rejected`);
      rejected += 1;
    }
  }
  return { accepted, rejected };
}

function verifyBridgePathMutations(callByTemplate, temporaryDirectory) {
  const orbit = callByTemplate.get("orbit-deep-call");
  invariant(orbit, "orbit call fixture is missing");

  const rootEscape = structuredClone(orbit.call);
  rootEscape.workflow.declared_script_path = "../outside.pipeline";
  rootEscape.workflow.resolved_source.path = resolve(orbit.caller_root, "../outside.pipeline");
  rootEscape.workflow.resolved_source.sha256 = "0".repeat(64);
  const mutationDirectory = resolve(temporaryDirectory, "bridge", "mutations");
  mkdirSync(mutationDirectory, { recursive: true });
  const rootEscapePath = resolve(mutationDirectory, "root-escape.json");
  writeJson(rootEscapePath, rootEscape);
  runBridgeCallValidation(rootEscapePath, false, "unsafe_path");

  const missing = structuredClone(orbit.call);
  missing.workflow.declared_script_path = "scripts/missing.pipeline";
  missing.workflow.resolved_source.path = resolve(orbit.caller_root, "scripts/missing.pipeline");
  missing.workflow.resolved_source.sha256 = "0".repeat(64);
  const missingPath = resolve(mutationDirectory, "missing-source.json");
  writeJson(missingPath, missing);
  runBridgeCallValidation(missingPath, false, "input_missing");

  const argsDrift = structuredClone(orbit.call);
  argsDrift.arguments.canonical_sha256 = "0".repeat(64);
  const argsDriftPath = resolve(mutationDirectory, "arguments-drift.json");
  writeJson(argsDriftPath, argsDrift);
  runBridgeCallValidation(argsDriftPath, false, "arguments_drift");

  const syntheticRoot = resolve(temporaryDirectory, "symlink-caller");
  const syntheticScripts = resolve(syntheticRoot, "scripts");
  mkdirSync(syntheticScripts, { recursive: true });
  const syntheticSkillMd = resolve(syntheticRoot, "SKILL.md");
  const target = resolve(temporaryDirectory, "outside-source.pipeline");
  const link = resolve(syntheticScripts, "linked.pipeline");
  writeFileSync(syntheticSkillMd, "---\nname: symlink-caller\n---\n", { mode: 0o600 });
  writeFileSync(target, "workflow synthetic {}\n", { mode: 0o600 });
  symlinkSync(target, link);
  const symlinkCall = structuredClone(orbit.call);
  symlinkCall.call_id = "symlink-caller:1";
  symlinkCall.invoking_skill.root = syntheticRoot;
  symlinkCall.invoking_skill.skill_md.path = syntheticSkillMd;
  symlinkCall.invoking_skill.skill_md.sha256 = sha256(readFileSync(syntheticSkillMd));
  symlinkCall.workflow.declared_script_path = "scripts/linked.pipeline";
  symlinkCall.workflow.resolved_source.path = link;
  symlinkCall.workflow.resolved_source.sha256 = sha256(readFileSync(target));
  const symlinkCallPath = resolve(mutationDirectory, "symlink-source.json");
  writeJson(symlinkCallPath, symlinkCall);
  runBridgeCallValidation(symlinkCallPath, false, "unsafe_path");
}

function verifyWorkflowBridgeFixtures(callFixture, returnFixture, callSchema, returnSchema, workflowSchema, translationInputSchema, translationReceiptSchema, mappingByCase) {
  invariant(callFixture.schema_version === "dynamic-workflow-call-fixtures/v1", "unexpected workflow-call fixture schema version");
  invariant(returnFixture.schema_version === "dynamic-workflow-return-fixtures/v1", "unexpected workflow-return fixture schema version");
  invariant(Array.isArray(callFixture.calls) && callFixture.calls.length > 0, "workflow-call fixtures must contain calls[]");
  invariant(Array.isArray(callFixture.routing_cases) && callFixture.routing_cases.length > 0, "workflow-call fixtures must contain routing_cases[]");
  invariant(Array.isArray(callFixture.translation_binding_cases) && callFixture.translation_binding_cases.length >= 3, "workflow-call fixtures must contain translation_binding_cases[]");
  invariant(Array.isArray(callFixture.negative_path_mutations) && callFixture.negative_path_mutations.length >= 3, "workflow-call fixtures must contain path mutations");
  invariant(Array.isArray(returnFixture.returns) && returnFixture.returns.length > 0, "workflow-return fixtures must contain returns[]");
  invariant(Array.isArray(returnFixture.return_bindings) && returnFixture.return_bindings.length > 0, "workflow-return fixtures must contain return_bindings[]");
  unique(callFixture.calls.map((item) => item.template_id), "workflow call template ids");
  unique(callFixture.routing_cases.map((item) => item.case_id), "workflow routing case ids");
  unique(returnFixture.returns.map((item) => item.template_id), "workflow return template ids");
  unique(returnFixture.return_bindings.map((item) => item.template_id), "workflow return binding template ids");

  const temporaryDirectory = realpathSync(mkdtempSync(resolve(tmpdir(), "dynamic-workflow-evals-")));
  try {
    const callByTemplate = new Map(callFixture.calls.map((template) => {
      const materialized = materializeCallTemplate(template, callSchema, temporaryDirectory);
      return [template.template_id, materialized];
    }));
    const returnByTemplate = new Map(returnFixture.returns.map((template) => {
      const materialized = materializeReturnTemplate(template, returnSchema, callByTemplate);
      return [template.template_id, materialized];
    }));
    const bindingByTemplate = new Map(returnFixture.return_bindings.map((template) => {
      const materialized = materializeReturnBindingTemplate(template, workflowSchema, callByTemplate);
      return [template.template_id, materialized];
    }));
    const translationBindings = verifyTranslationCallBindings(callFixture.translation_binding_cases, callByTemplate, translationInputSchema, translationReceiptSchema);

    for (const routeCase of callFixture.routing_cases) {
      const mapping = mappingByCase.get(routeCase.case_id);
      invariant(mapping, `missing expected mapping for workflow route ${routeCase.case_id}`);
      const derived = deriveRoute(routeCase, callByTemplate);
      invariant(derived.route === routeCase.expected_route && derived.route === mapping.expected_route, `route mismatch for ${routeCase.case_id}`);
      invariant(derived.bridge === routeCase.expected_bridge_executions && derived.bridge === mapping.expected_bridge_executions, `bridge execution count mismatch for ${routeCase.case_id}`);
      invariant(derived.native === routeCase.expected_native_executions && derived.native === mapping.expected_native_executions, `native execution count mismatch for ${routeCase.case_id}`);
    }

    for (const mutation of returnFixture.crosswire_mutations ?? []) {
      const callRecord = callByTemplate.get(mutation.target_call_template_id);
      const returnRecord = returnByTemplate.get(mutation.return_template_id);
      invariant(callRecord && returnRecord, `crosswire mutation ${mutation.mutation_id} references an unknown template`);
      let rejected = false;
      try {
        assertReturnBound(returnRecord.workflow_return, returnRecord.return_schema, callRecord);
      } catch {
        rejected = true;
      }
      invariant(rejected && mutation.expected_binding === "reject", `crosswire mutation ${mutation.mutation_id} was not rejected`);
    }
    for (const mutation of returnFixture.return_binding_crosswire_mutations ?? []) {
      const targetCall = callByTemplate.get(mutation.target_call_template_id);
      const bindingRecord = bindingByTemplate.get(mutation.binding_template_id);
      invariant(targetCall && bindingRecord, `return binding mutation ${mutation.mutation_id} references an unknown template`);
      const rejected = bindingRecord.binding.workflow_call_sha256 !== targetCall.call_file_sha256;
      invariant(rejected && mutation.expected_binding === "reject", `return binding mutation ${mutation.mutation_id} was not rejected`);
    }
    verifyBridgePathMutations(callByTemplate, temporaryDirectory);
    return {
      calls_schema_validated: callByTemplate.size,
      returns_schema_validated: returnByTemplate.size,
      return_bindings_schema_validated: bindingByTemplate.size,
      route_cases_checked: callFixture.routing_cases.length,
      path_mutations_rejected: 4,
      return_crosswires_rejected: returnFixture.crosswire_mutations?.length ?? 0,
      return_binding_crosswires_rejected: returnFixture.return_binding_crosswire_mutations?.length ?? 0,
      translation_call_bindings_accepted: translationBindings.accepted,
      translation_call_bindings_rejected: translationBindings.rejected,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function evidenceFilePath(ledgerDirectory, ledger, evalCase, variant, evidencePath) {
  invariant(ledger.evidence_root === "evidence", "actual ledger evidence_root must be the dedicated evidence directory");
  invariant(typeof evidencePath === "string" && evidencePath.length > 0 && !evidencePath.includes("\0"), `invalid evidence path for ${evalCase.case_id}/${variant}`);
  invariant(!isAbsolute(evidencePath) && !evidencePath.includes("\\"), `evidence path must be portable and relative for ${evalCase.case_id}/${variant}`);
  const evidenceRoot = resolve(ledgerDirectory, ledger.evidence_root);
  const rootStat = lstatSync(evidenceRoot);
  invariant(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "actual ledger evidence_root must be a non-symlink directory");
  const expectedPrefix = `${evalCase.case_id}/${variant}/`;
  invariant(evidencePath.startsWith(expectedPrefix), `evidence path is crosswired for ${evalCase.case_id}/${variant}`);
  const path = resolve(evidenceRoot, evidencePath);
  const relation = relative(evidenceRoot, path);
  invariant(relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation), `evidence path escapes evidence_root for ${evalCase.case_id}/${variant}`);
  invariant(relation.split(sep).join("/") === evidencePath, `evidence path is not canonical for ${evalCase.case_id}/${variant}`);
  let cursor = evidenceRoot;
  for (const component of relation.split(sep)) {
    cursor = resolve(cursor, component);
    invariant(!lstatSync(cursor).isSymbolicLink(), `evidence path contains a symlink for ${evalCase.case_id}/${variant}`);
  }
  const stat = lstatSync(path);
  invariant(stat.isFile() && !stat.isSymbolicLink(), `evidence path is not a regular non-symlink file for ${evalCase.case_id}/${variant}`);
  const realRelation = relative(realpathSync(evidenceRoot), realpathSync(path));
  invariant(realRelation !== "" && realRelation !== ".." && !realRelation.startsWith(`..${sep}`) && !isAbsolute(realRelation), `evidence realpath escapes evidence_root for ${evalCase.case_id}/${variant}`);
  return path;
}

function deriveLedgerExecution(executedVariants, totalVariants, gradedCases, totalCases) {
  const status = executedVariants === 0
    ? "not_executed"
    : executedVariants === totalVariants
      ? "completed"
      : "partial";
  return { performed: executedVariants > 0, status, executed_variants: executedVariants, total_variants: totalVariants, graded_cases: gradedCases, total_cases: totalCases };
}

function verifyActualLedger(ledger, evals, mappingByCase, ledgerDirectory = evalDir) {
  invariant(ledger.schema_version === "dynamic-workflow-eval-actuals/v1", "unexpected actual-results schema_version");
  invariant(ledger.evidence_root === "evidence", "unexpected actual ledger evidence_root");
  invariant(typeof ledger.model_execution?.performed === "boolean", "actual ledger model_execution.performed must be boolean");
  invariant(["not_executed", "partial", "completed"].includes(ledger.model_execution?.status), "actual ledger model_execution.status is invalid");
  invariant(typeof ledger.model_execution?.reason === "string" && ledger.model_execution.reason.length > 0, "actual ledger model_execution.reason is required");
  invariant(Array.isArray(ledger.cases), "actual ledger cases must be an array");
  invariant(ledger.cases.length === evals.length, "actual ledger case count differs from evals.json");
  const byCase = new Map(ledger.cases.map((item) => [item.case_id, item]));
  invariant(byCase.size === ledger.cases.length, "actual ledger case_id values must be unique");
  const usedEvidencePaths = [];
  let executedVariants = 0;
  let gradedCases = 0;

  for (const evalCase of evals) {
    const actual = byCase.get(evalCase.case_id);
    const mapping = mappingByCase.get(evalCase.case_id);
    invariant(actual, `actual ledger is missing case_id ${evalCase.case_id}`);
    invariant(mapping, `actual ledger case has no expected mapping: ${evalCase.case_id}`);
    invariant(actual.eval_id === evalCase.id, `actual ledger eval_id mismatch for ${evalCase.case_id}`);
    invariant(actual.eval_name === evalCase.name && actual.eval_name === mapping.eval_name, `actual ledger eval_name mismatch for ${evalCase.case_id}`);
    let caseExecutedVariants = 0;
    for (const variant of ["with_skill", "baseline"]) {
      invariant(["not_executed", "executed"].includes(actual[variant]?.status), `${variant} status is invalid for ${evalCase.case_id}`);
      invariant(Array.isArray(actual[variant].evidence_paths), `${variant}.evidence_paths must be an array for ${evalCase.case_id}`);
      unique(actual[variant].evidence_paths, `${variant}.evidence_paths for ${evalCase.case_id}`);
      if (actual[variant].status === "not_executed") {
        assertExactArray(actual[variant].evidence_paths, [], `${variant}.evidence_paths for ${evalCase.case_id}`);
      } else {
        invariant(actual[variant].evidence_paths.length > 0, `${variant} executed without evidence for ${evalCase.case_id}`);
        for (const evidencePath of actual[variant].evidence_paths) {
          evidenceFilePath(ledgerDirectory, ledger, evalCase, variant, evidencePath);
          usedEvidencePaths.push(evidencePath);
        }
        executedVariants += 1;
        caseExecutedVariants += 1;
      }
    }
    invariant(actual.grade !== null && typeof actual.grade === "object" && !Array.isArray(actual.grade), `grade is required for ${evalCase.case_id}`);
    if (caseExecutedVariants === 0) {
      invariant(actual.grade.status === "not_executed" && actual.grade.delta === null, `unexecuted case cannot be graded: ${evalCase.case_id}`);
    } else if (caseExecutedVariants === 1) {
      invariant(actual.grade.status === "pending" && actual.grade.delta === null, `partially executed case must remain pending: ${evalCase.case_id}`);
    } else {
      invariant(["pending", "graded"].includes(actual.grade.status), `fully executed case has an invalid grade status: ${evalCase.case_id}`);
      if (actual.grade.status === "pending") {
        invariant(actual.grade.delta === null, `pending grade must have a null delta: ${evalCase.case_id}`);
      } else {
        invariant(typeof actual.grade.delta === "number" && Number.isFinite(actual.grade.delta), `graded case must have a finite delta: ${evalCase.case_id}`);
        gradedCases += 1;
      }
    }
  }
  unique(usedEvidencePaths, "actual ledger evidence paths");
  const summary = deriveLedgerExecution(executedVariants, evals.length * 2, gradedCases, evals.length);
  invariant(ledger.model_execution.performed === summary.performed, "actual ledger model_execution.performed differs from evidence");
  invariant(ledger.model_execution.status === summary.status, "actual ledger model_execution.status differs from evidence");
  return summary;
}

function expectActualLedgerRejected(ledger, evals, mappingByCase, ledgerDirectory, label) {
  let rejected = false;
  try {
    verifyActualLedger(ledger, evals, mappingByCase, ledgerDirectory);
  } catch {
    rejected = true;
  }
  invariant(rejected, `actual ledger mutation was not rejected: ${label}`);
}

function verifyActualLedgerStates(actualLedger, evals, mappingByCase) {
  const current = verifyActualLedger(actualLedger, evals, mappingByCase, evalDir);
  const temporaryDirectory = realpathSync(mkdtempSync(resolve(tmpdir(), "dynamic-workflow-ledgers-")));
  try {
    const evidenceRoot = resolve(temporaryDirectory, "evidence");
    mkdirSync(evidenceRoot, { recursive: true });
    const writeEvidence = (evalCase, variant) => {
      const evidencePath = `${evalCase.case_id}/${variant}/trace.json`;
      const absolutePath = resolve(evidenceRoot, evidencePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeJson(absolutePath, { case_id: evalCase.case_id, eval_name: evalCase.name, variant, model_trace: "synthetic-ledger-contract-only" });
      return evidencePath;
    };
    const persistAndVerify = (name, ledger) => {
      const path = resolve(temporaryDirectory, `${name}.json`);
      writeJson(path, ledger);
      return verifyActualLedger(readJson(path), evals, mappingByCase, temporaryDirectory);
    };

    const notExecuted = structuredClone(actualLedger);
    invariant(persistAndVerify("valid-not-executed", notExecuted).status === "not_executed", "valid not_executed ledger did not validate");

    const partial = structuredClone(actualLedger);
    partial.model_execution = { performed: true, status: "partial", reason: "Synthetic partial ledger used only by deterministic preflight." };
    partial.cases[0].with_skill = { status: "executed", evidence_paths: [writeEvidence(evals[0], "with_skill")] };
    partial.cases[0].grade = { status: "pending", delta: null };
    invariant(persistAndVerify("valid-partial", partial).status === "partial", "valid partial ledger did not validate");

    const completed = structuredClone(actualLedger);
    completed.model_execution = { performed: true, status: "completed", reason: "Synthetic completed ledger used only by deterministic preflight." };
    for (const [index, evalCase] of evals.entries()) {
      completed.cases[index].with_skill = { status: "executed", evidence_paths: [writeEvidence(evalCase, "with_skill")] };
      completed.cases[index].baseline = { status: "executed", evidence_paths: [writeEvidence(evalCase, "baseline")] };
      completed.cases[index].grade = { status: "graded", delta: 0 };
    }
    invariant(persistAndVerify("valid-completed", completed).status === "completed", "valid completed ledger did not validate");

    const missingEvidence = structuredClone(partial);
    missingEvidence.cases[0].with_skill.evidence_paths = [];
    expectActualLedgerRejected(missingEvidence, evals, mappingByCase, temporaryDirectory, "executed without evidence");

    const crosswiredEvidence = structuredClone(completed);
    crosswiredEvidence.cases[0].with_skill.evidence_paths = [completed.cases[1].with_skill.evidence_paths[0]];
    expectActualLedgerRejected(crosswiredEvidence, evals, mappingByCase, temporaryDirectory, "crosswired evidence path");

    const nameMismatch = structuredClone(actualLedger);
    nameMismatch.cases[0].eval_name = evals[1].name;
    expectActualLedgerRejected(nameMismatch, evals, mappingByCase, temporaryDirectory, "eval_name mismatch");
    return { valid_states_checked: 3, invalid_mutations_rejected: 3, committed: current };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function verifyDirectMaterialization(mapping, workflowSchema) {
  if (mapping.expected_translation_mode !== "direct") return;
  invariant(typeof mapping.input === "string", `direct case ${mapping.case_id} must identify its template input`);
  const templateRef = `evals/fixtures/${mapping.input}`;
  const sourceRefs = Object.keys(mapping.fixture_sha256).filter((fileRef) => fileRef !== templateRef);
  invariant(sourceRefs.length === 1, `direct case ${mapping.case_id} must hash exactly one companion source`);

  const templatePath = safeSkillPath(templateRef);
  const sourcePath = safeSkillPath(sourceRefs[0]);
  const template = readFileSync(templatePath, "utf8");
  const sourceHash = sha256(readFileSync(sourcePath));
  invariant(template.split("{{SOURCE_PATH}}").length === 2, `direct template ${templateRef} must contain SOURCE_PATH exactly once`);
  invariant(template.split("{{SOURCE_SHA256}}").length === 2, `direct template ${templateRef} must contain SOURCE_SHA256 exactly once`);

  const materializedText = template
    .replace("{{SOURCE_PATH}}", sourcePath)
    .replace("{{SOURCE_SHA256}}", sourceHash);
  const materialized = JSON.parse(materializedText);
  invariant(materialized.source?.path === sourcePath, `materialized source path mismatch for ${mapping.case_id}`);
  invariant(materialized.source?.sha256 === sourceHash, `materialized source hash mismatch for ${mapping.case_id}`);
  invariant(!materializedText.includes("{{SOURCE_"), `unresolved direct template placeholder for ${mapping.case_id}`);
  assertSchemaValid(workflowSchema, materialized, `materialized direct manifest for ${mapping.case_id}`);
  const withoutNativeCollaboration = structuredClone(materialized);
  withoutNativeCollaboration.required_capabilities = withoutNativeCollaboration.required_capabilities.filter((item) => item !== "native_collaboration");
  invariant(schemaErrors(workflowSchema, withoutNativeCollaboration).length > 0, "workflow schema must reject a direct manifest without native_collaboration");
}

function verifyRunReviewActionPackage(runReviewSchema) {
  const path = safeSkillPath("evals/fixtures/run-review-action-package.input.json");
  const input = readJson(path);
  assertSchemaValid(runReviewSchema, input, "controller-shaped final review input with action package");
  const incompleteBinding = structuredClone(input);
  delete incompleteBinding.gates[0].action_package.scopes;
  invariant(schemaErrors(runReviewSchema, incompleteBinding).length > 0, "run review schema must reject an incomplete action package binding");
}

function main() {
  const evalDocument = readJson(resolve(evalDir, "evals.json"));
  const mappings = readJson(resolve(evalDir, "fixtures/expected-mappings.json"));
  const actualLedger = readJson(resolve(evalDir, "actual-results.json"));
  const workflowSchema = readJson(resolve(skillDir, "schemas/workflow-manifest.schema.json"));
  const runReviewSchema = readJson(resolve(skillDir, "schemas/run-review-input-manifest.schema.json"));
  const workflowCallSchema = readJson(resolve(skillDir, "schemas/workflow-call.schema.json"));
  const workflowReturnSchema = readJson(resolve(skillDir, "schemas/workflow-return.schema.json"));
  const translationInputSchema = readJson(resolve(skillDir, "schemas/translation-review-input.schema.json"));
  const translationReceiptSchema = readJson(resolve(skillDir, "schemas/translation-review-receipt.schema.json"));
  const workflowCallFixtures = readJson(resolve(evalDir, "fixtures/workflow-call.cases.json"));
  const workflowReturnFixtures = readJson(resolve(evalDir, "fixtures/workflow-return.cases.json"));

  invariant(evalDocument.skill_name === "dynamic-workflow-runner", "unexpected skill_name in evals.json");
  invariant(Array.isArray(evalDocument.evals), "evals.json must contain evals[]");
  invariant(mappings.schema_version === "dynamic-workflow-eval-expectations/v2", "unexpected expected-mappings schema_version");
  invariant(Array.isArray(mappings.cases), "expected-mappings must contain cases[]");
  invariant(mappings.cases.length === evalDocument.evals.length, "expected-mappings must cover every eval exactly once");

  unique(evalDocument.evals.map((item) => item.id), "eval ids");
  unique(evalDocument.evals.map((item) => item.case_id), "eval case_id values");
  unique(mappings.cases.map((item) => item.case_id), "mapping case_id values");
  const mappingByCase = new Map(mappings.cases.map((item) => [item.case_id, item]));
  let referencedFiles = 0;
  let hashedFixtures = 0;

  for (const evalCase of evalDocument.evals) {
    invariant(Number.isInteger(evalCase.id) && evalCase.id > 0, "eval id must be a positive integer");
    invariant(typeof evalCase.case_id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(evalCase.case_id), `invalid case_id ${evalCase.case_id}`);
    invariant(typeof evalCase.name === "string" && evalCase.name.length > 0, `missing eval name for ${evalCase.case_id}`);
    invariant(Array.isArray(evalCase.files), `files must be an array for ${evalCase.case_id}`);
    invariant(Array.isArray(evalCase.assertions) && evalCase.assertions.length > 0, `assertions must be non-empty for ${evalCase.case_id}`);
    unique(evalCase.files, `file references for ${evalCase.case_id}`);

    const mapping = mappingByCase.get(evalCase.case_id);
    invariant(mapping, `missing expected mapping for ${evalCase.case_id}`);
    invariant(mapping.eval_id === evalCase.id, `eval_id mismatch for ${evalCase.case_id}`);
    invariant(mapping.eval_name === evalCase.name, `eval_name mismatch for ${evalCase.case_id}`);
    assertExactArray(mapping.files, evalCase.files, `mapping.files for ${evalCase.case_id}`);
    invariant(typeof mapping.expected_trigger === "boolean", `expected_trigger must be boolean for ${evalCase.case_id}`);
    invariant(["bridge", "native", "not_applicable", "reject"].includes(mapping.expected_route), `invalid expected_route for ${evalCase.case_id}`);
    invariant(Number.isInteger(mapping.expected_bridge_executions) && mapping.expected_bridge_executions >= 0, `expected_bridge_executions must be a non-negative integer for ${evalCase.case_id}`);
    invariant(Number.isInteger(mapping.expected_native_executions) && mapping.expected_native_executions >= 0, `expected_native_executions must be a non-negative integer for ${evalCase.case_id}`);
    invariant(typeof mapping.expected_caller_continuation === "boolean", `expected_caller_continuation must be boolean for ${evalCase.case_id}`);
    invariant(typeof mapping.expected_return_status === "string" && mapping.expected_return_status.length > 0, `expected_return_status is required for ${evalCase.case_id}`);
    if (mapping.expected_route === "native") invariant(mapping.expected_bridge_executions === 0 && mapping.expected_native_executions === 1, `native route counts are invalid for ${evalCase.case_id}`);
    if (mapping.expected_route === "not_applicable") invariant(mapping.expected_bridge_executions === 0 && mapping.expected_native_executions === 0, `not_applicable route counts are invalid for ${evalCase.case_id}`);
    if (mapping.expected_route === "reject") {
      invariant(mapping.expected_bridge_executions === 0 && [0, 1].includes(mapping.expected_native_executions), `reject route counts are invalid for ${evalCase.case_id}`);
      if (mapping.expected_native_executions === 1) invariant(mapping.case_id === "native-workflow-attempted-no-fallback", `only an attempted native route may reject after one native execution: ${evalCase.case_id}`);
    }
    if (mapping.expected_route === "bridge") invariant(mapping.expected_bridge_executions >= 1 && mapping.expected_native_executions === 0, `bridge route counts are invalid for ${evalCase.case_id}`);
    invariant(typeof mapping.expected_terminal === "string" && mapping.expected_terminal.length > 0, `expected_terminal is required for ${evalCase.case_id}`);
    invariant(Array.isArray(mapping.runtime_events), `runtime_events must be an array for ${evalCase.case_id}`);
    invariant(Array.isArray(mapping.required_observations) && mapping.required_observations.length > 0, `required_observations must be non-empty for ${evalCase.case_id}`);
    invariant(Array.isArray(mapping.forbidden_observations) && mapping.forbidden_observations.length > 0, `forbidden_observations must be non-empty for ${evalCase.case_id}`);
    invariant(mapping.fixture_sha256 && typeof mapping.fixture_sha256 === "object" && !Array.isArray(mapping.fixture_sha256), `fixture_sha256 must be an object for ${evalCase.case_id}`);

    for (const fileRef of evalCase.files) {
      const path = safeSkillPath(fileRef);
      referencedFiles += 1;
      if (extname(path) === ".json") readJson(path);
    }
    if (mapping.input !== null) {
      invariant(typeof mapping.input === "string" && mapping.input.length > 0, `input must be null or a fixture basename for ${evalCase.case_id}`);
      invariant(evalCase.files.includes(`evals/fixtures/${mapping.input}`), `input fixture is not listed in eval files for ${evalCase.case_id}`);
    }
    for (const [fileRef, expectedHash] of Object.entries(mapping.fixture_sha256)) {
      invariant(evalCase.files.includes(fileRef), `hashed fixture is not listed in eval files for ${evalCase.case_id}: ${fileRef}`);
      invariant(/^[a-f0-9]{64}$/.test(expectedHash), `invalid SHA-256 for ${fileRef}`);
      const path = safeSkillPath(fileRef);
      invariant(sha256(readFileSync(path)) === expectedHash, `fixture SHA-256 mismatch for ${fileRef}`);
      hashedFixtures += 1;
      if (fileRef.endsWith(".case.json")) {
        const fixture = readJson(path);
        invariant(fixture.case_id === evalCase.case_id, `fixture case_id mismatch in ${fileRef}`);
      }
    }
    verifyDirectMaterialization(mapping, workflowSchema);
  }

  const bridgeFixtureSummary = verifyWorkflowBridgeFixtures(workflowCallFixtures, workflowReturnFixtures, workflowCallSchema, workflowReturnSchema, workflowSchema, translationInputSchema, translationReceiptSchema, mappingByCase);
  verifyRunReviewActionPackage(runReviewSchema);
  const actualLedgerSummary = verifyActualLedgerStates(actualLedger, evalDocument.evals, mappingByCase);
  process.stdout.write(`${JSON.stringify({
    status: "fixture_preflight_passed",
    eval_cases: evalDocument.evals.length,
    mappings: mappings.cases.length,
    referenced_files_checked: referencedFiles,
    fixture_hashes_checked: hashedFixtures,
    direct_templates_materialized_in_memory: mappings.cases.filter((item) => item.expected_translation_mode === "direct").length,
    workflow_bridge: bridgeFixtureSummary,
    controller_shaped_review_inputs_schema_validated: 1,
    actual_ledger: {
      valid_states_checked: actualLedgerSummary.valid_states_checked,
      invalid_mutations_rejected: actualLedgerSummary.invalid_mutations_rejected
    },
    model_execution: actualLedgerSummary.committed
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`fixture preflight failed: ${error.message}\n`);
  process.exitCode = 1;
}
