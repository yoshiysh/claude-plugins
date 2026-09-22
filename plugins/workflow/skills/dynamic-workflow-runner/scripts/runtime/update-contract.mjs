import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { exactObject } from './inputs.mjs';

export const UPDATE_REQUIREMENTS = Object.freeze([
  'staging-write',
  'artifact-manifest',
  'fresh-reverify',
  'hash-bound-action-package',
]);

const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value);
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('..'));
};

function equalFiles(left, right) {
  return left.length === right.length && left.every((file, index) =>
    file.path === right[index].path && file.sha256 === right[index].sha256 && file.bytes === right[index].bytes);
}

function changedPaths(before, after) {
  const original = new Map(before.map(file => [file.path, file]));
  return after.filter(file => {
    const source = original.get(file.path);
    return source.sha256 !== file.sha256 || source.bytes !== file.bytes;
  });
}

async function directory(path, name) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw Error(`${name} must be an absolute path`);
  const resolved = await realpath(path);
  if (!(await stat(resolved)).isDirectory()) throw Error(`${name} must be a directory`);
  return resolved;
}

async function absent(path, name) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw Error(`${name} must be an absolute path`);
  const canonical = join(await realpath(dirname(path)), basename(path));
  try {
    await lstat(canonical);
  } catch (error) {
    if (error.code === 'ENOENT') return canonical;
    throw error;
  }
  throw Error(`${name} must not exist before an update run`);
}

export async function snapshotTree(root) {
  const files = [];
  async function walk(current, prefix = '') {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = `${current}/${entry.name}`;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw Error(`update tree must not contain symlinks: ${relativePath}`);
      if (metadata.isDirectory()) await walk(path, relativePath);
      else if (metadata.isFile()) {
        const contents = await readFile(path);
        files.push(Object.freeze({ path: relativePath, bytes: contents.byteLength, sha256: sha256(contents) }));
      } else {
        throw Error(`update tree must contain only regular files and directories: ${relativePath}`);
      }
    }
  }
  await walk(root);
  const frozenFiles = Object.freeze(files);
  return Object.freeze({ files: frozenFiles, sha256: sha256(canonical(frozenFiles)) });
}

export async function prepareUpdateContract(input, capabilities) {
  exactObject(input, ['targetDir', 'stagingDir'], 'updateContract');
  for (const requirement of UPDATE_REQUIREMENTS) {
    if (!capabilities.includes(requirement)) throw Error(`unsupported runtime requirement: ${requirement}`);
  }
  const targetDir = await directory(input.targetDir, 'updateContract.targetDir');
  const stagingDir = await absent(input.stagingDir, 'updateContract.stagingDir');
  if (inside(targetDir, stagingDir) || inside(stagingDir, targetDir))
    throw Error('updateContract stagingDir must be separate from targetDir');
  return Object.freeze({ targetDir, stagingDir, sourceManifest: await snapshotTree(targetDir) });
}

export async function verifyUpdateTarget(contract) {
  const current = await snapshotTree(contract.targetDir);
  if (!equalFiles(contract.sourceManifest.files, current.files))
    throw Error('update contract violation: target tree changed during staging update');
}

const nonempty = value => typeof value === 'string' && value.trim() !== '';

async function reverifyReceipt(result, stagingDir, observedAgentLabels) {
  const receipt = result?.reverify_receipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
      receipt.phase !== 'Reverify' || receipt.fresh_thread !== true || receipt.completed !== true ||
      !receipt.by_category || typeof receipt.by_category !== 'object' || Array.isArray(receipt.by_category) ||
      Object.keys(receipt.by_category).length === 0 ||
      Object.values(receipt.by_category).some(value => !Number.isSafeInteger(value) || value < 0) ||
      !nonempty(receipt.fresh_thread_id) || !nonempty(receipt.updater_thread_id) ||
      receipt.fresh_thread_id === receipt.updater_thread_id)
    throw Error('update contract violation: complete fresh reverify receipt required');
  if (!(observedAgentLabels instanceof Set) ||
      !observedAgentLabels.has(receipt.fresh_thread_id) || !observedAgentLabels.has(receipt.updater_thread_id))
    throw Error('update contract violation: reverify receipt provenance was not observed by runtime');
  const receiptStagingDir = await directory(receipt.staging_dir, 'reverify_receipt.staging_dir');
  if (receiptStagingDir !== stagingDir)
    throw Error('update contract violation: reverify receipt staging directory does not match contract');
  return Object.freeze({ ...receipt, staging_dir: receiptStagingDir });
}

function reportedChanges(result, source, staging) {
  const entries = result?.staging?.changed_files;
  if (!Array.isArray(entries)) throw Error('update contract violation: changed_files required');
  const byPath = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.path !== 'string' ||
        !entry.path || entry.path.startsWith('/') || entry.path.includes('..') || byPath.has(entry.path))
      throw Error('update contract violation: changed_files must contain unique relative paths');
    byPath.set(entry.path, entry);
  }
  const actual = changedPaths(source.files, staging.files);
  if (actual.length !== byPath.size || actual.some(file => !byPath.has(file.path)))
    throw Error('update contract violation: changed_files does not match staging manifest');
  const original = new Map(source.files.map(file => [file.path, file]));
  return actual.map(file => Object.freeze({
    ...byPath.get(file.path), before_sha256: original.get(file.path).sha256, after_sha256: file.sha256,
  }));
}

export async function finalizeUpdateContract(contract, result, observedLabels = []) {
  await verifyUpdateTarget(contract);
  if (result?.verdict !== 'applied_to_staging') return null;
  const resultStagingDir = await directory(result?.staging?.dir, 'result.staging.dir');
  if (resultStagingDir !== contract.stagingDir)
    throw Error('update contract violation: result staging directory does not match contract');
  const stagingDir = await directory(contract.stagingDir, 'updateContract.stagingDir');
  const stagingManifest = await snapshotTree(stagingDir);
  if (contract.stagingDir !== stagingDir) throw Error('update contract violation: staging directory identity changed');
  if (contract.sourceManifest.files.length !== stagingManifest.files.length ||
      contract.sourceManifest.files.some((file, index) => file.path !== stagingManifest.files[index].path))
    throw Error('update contract violation: staging is not a complete target mirror');
  const changedFiles = reportedChanges(result, contract.sourceManifest, stagingManifest);
  const receipt = await reverifyReceipt(result, contract.stagingDir, new Set(observedLabels));
  return Object.freeze({
    schema_version: 'dynamic-workflow-runner-update/v1',
    source_manifest: contract.sourceManifest,
    staging_manifest: stagingManifest,
    changed_files: changedFiles,
    reverify_receipt: receipt,
    apply: Object.freeze({
      owner: 'caller',
      authorization: 'required_after_review',
      source_dir: contract.targetDir,
      staging_dir: contract.stagingDir,
      operation: 'copy_only_changed_files_after_hash_verification',
    }),
  });
}
