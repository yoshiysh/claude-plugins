import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { exactObject } from './inputs.mjs';
import { readRegularFileBounded } from './safe-update-read.mjs';

export const MAX_UPDATE_TREE_BYTES = 32 * 1024 * 1024;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value);
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

function equalEntries(left, right, keys) {
  return left.length === right.length && left.every((entry, index) =>
    keys.every(key => entry[key] === right[index][key]));
}

function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !isAbsolute(value) &&
    !value.includes('\\') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function changedPaths(before, after) {
  const original = new Map(before.map(file => [file.path, file]));
  const staged = new Map(after.map(file => [file.path, file]));
  return [...new Set([...original.keys(), ...staged.keys()])].sort((a, b) => a.localeCompare(b))
    .flatMap(path => {
      const source = original.get(path);
      const draft = staged.get(path);
      if (!source) return [{ operation: 'add', path, before: null, after: draft }];
      if (!draft) return [{ operation: 'delete', path, before: source, after: null }];
      if (source.sha256 !== draft.sha256 || source.bytes !== draft.bytes || source.mode !== draft.mode)
        return [{ operation: 'update', path, before: source, after: draft }];
      return [];
    });
}

async function directory(path, name) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw Error(`${name} must be an absolute path`);
  const resolved = await realpath(path);
  if (!(await stat(resolved)).isDirectory()) throw Error(`${name} must be a directory`);
  return resolved;
}

async function canonicalDirectory(path, name) {
  const resolved = await directory(path, name);
  if (resolve(path) !== resolved) throw Error(`${name} changed identity`);
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
  const directories = [];
  let totalBytes = 0;
  async function walk(current, prefix = '') {
    const directoryMetadata = await lstat(current);
    const directoryMode = directoryMetadata.mode & 0o777;
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() ||
        (directoryMode & 0o500) !== 0o500)
      throw Error(`update directories must be real and owner-readable/searchable: ${prefix || '.'}`);
    directories.push(Object.freeze({ path: prefix, mode: directoryMode }));
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = `${current}/${entry.name}`;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw Error(`update tree must not contain symlinks: ${relativePath}`);
      if (metadata.isDirectory()) await walk(path, relativePath);
      else if (metadata.isFile()) {
        totalBytes += metadata.size;
        if (totalBytes > MAX_UPDATE_TREE_BYTES) throw Error('update tree exceeds its size limit');
        const contents = await readRegularFileBounded(path, metadata, MAX_UPDATE_TREE_BYTES);
        files.push(Object.freeze({ path: relativePath, bytes: contents.byteLength,
          mode: metadata.mode & 0o777, sha256: sha256(contents) }));
      } else {
        throw Error(`update tree must contain only regular files and directories: ${relativePath}`);
      }
    }
  }
  await walk(root);
  directories.sort((left, right) => left.path.localeCompare(right.path));
  files.sort((left, right) => left.path.localeCompare(right.path));
  const frozenFiles = Object.freeze(files);
  const frozenDirectories = Object.freeze(directories);
  return Object.freeze({ directories: frozenDirectories, files: frozenFiles,
    sha256: sha256(canonical({ directories: frozenDirectories, files: frozenFiles })) });
}

function changedDirectories(before, after) {
  const original = new Map(before.map(directory => [directory.path, directory]));
  const staged = new Map(after.map(directory => [directory.path, directory]));
  return [...new Set([...original.keys(), ...staged.keys()])].sort((a, b) => a.localeCompare(b))
    .flatMap(path => {
      const source = original.get(path), draft = staged.get(path);
      if (!source) return [{ operation: 'add', path, before_mode: null, after_mode: draft.mode }];
      if (!draft) return [{ operation: 'delete', path, before_mode: source.mode, after_mode: null }];
      if (source.mode !== draft.mode)
        return [{ operation: 'mode', path, before_mode: source.mode, after_mode: draft.mode }];
      return [];
    });
}

export async function prepareUpdateContract(input) {
  exactObject(input, ['targetRoot', 'stagingRoot', 'targetDir', 'stagingDir'], 'updateContract');
  const targetRoot = await canonicalDirectory(input.targetRoot, 'updateContract.targetRoot');
  const stagingRoot = await canonicalDirectory(input.stagingRoot, 'updateContract.stagingRoot');
  const targetDir = await canonicalDirectory(input.targetDir, 'updateContract.targetDir');
  if (targetRoot === stagingRoot || inside(targetRoot, stagingRoot) || inside(stagingRoot, targetRoot))
    throw Error('updateContract roots must be separate');
  if (!inside(targetRoot, targetDir) || targetRoot === targetDir)
    throw Error('updateContract.targetDir must be inside targetRoot');
  if (dirname(resolve(input.stagingDir)) !== stagingRoot)
    throw Error('updateContract.stagingDir must be a direct child of stagingRoot');
  const requestedStaging = resolve(input.stagingDir);
  if (inside(targetDir, requestedStaging) || inside(requestedStaging, targetDir))
    throw Error('updateContract stagingDir must be separate from targetDir');
  const stagingDir = await absent(input.stagingDir, 'updateContract.stagingDir');
  if (!inside(stagingRoot, stagingDir) || stagingRoot === stagingDir ||
      inside(targetDir, stagingDir) || inside(stagingDir, targetDir))
    throw Error('updateContract stagingDir must be separate from targetDir');
  const sourceManifest = await snapshotTree(targetDir);
  await mkdir(stagingDir);
  const canonicalStagingDir = await canonicalDirectory(stagingDir, 'updateContract.stagingDir');
  if (!inside(stagingRoot, canonicalStagingDir)) throw Error('updateContract stagingDir escaped stagingRoot');
  return Object.freeze({ targetRoot, stagingRoot, targetDir, stagingDir: canonicalStagingDir, sourceManifest });
}

export async function verifyUpdateTarget(contract) {
  const targetRoot = await canonicalDirectory(contract.targetRoot, 'updateContract.targetRoot');
  const stagingRoot = await canonicalDirectory(contract.stagingRoot, 'updateContract.stagingRoot');
  const targetDir = await canonicalDirectory(contract.targetDir, 'updateContract.targetDir');
  const stagingDir = await canonicalDirectory(contract.stagingDir, 'updateContract.stagingDir');
  if (targetRoot !== contract.targetRoot || stagingRoot !== contract.stagingRoot ||
      targetDir !== contract.targetDir || stagingDir !== contract.stagingDir ||
      !inside(targetRoot, targetDir) || targetRoot === targetDir ||
      !inside(stagingRoot, stagingDir) || stagingRoot === stagingDir ||
      targetRoot === stagingRoot || inside(targetRoot, stagingRoot) || inside(stagingRoot, targetRoot) ||
      inside(targetDir, stagingDir) || inside(stagingDir, targetDir))
    throw Error('update contract violation: update roots or directory identities changed');
  const current = await snapshotTree(contract.targetDir);
  if (!equalEntries(contract.sourceManifest.files, current.files, ['path', 'sha256', 'bytes', 'mode']) ||
      !equalEntries(contract.sourceManifest.directories, current.directories, ['path', 'mode']))
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
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !safeRelativePath(entry.path) || byPath.has(entry.path))
      throw Error('update contract violation: changed_files must contain unique relative paths');
    byPath.set(entry.path, entry);
  }
  const actual = changedPaths(source.files, staging.files);
  if (actual.length !== byPath.size || actual.some(file => !byPath.has(file.path)))
    throw Error('update contract violation: changed_files does not match staging manifest');
  return actual.map(change => Object.freeze({
    ...byPath.get(change.path), operation: change.operation,
    before_sha256: change.before?.sha256 ?? null, after_sha256: change.after?.sha256 ?? null,
    before_mode: change.before?.mode ?? null, after_mode: change.after?.mode ?? null,
  }));
}

export async function finalizeUpdateContract(contract, result, observedLabels = []) {
  await verifyUpdateTarget(contract);
  if (result?.verdict !== 'applied_to_staging') return null;
  for (const [path, missing] of [
    ['result.reverify_missing', result.reverify_missing],
    ['result.staging.reverify_missing', result.staging?.reverify_missing],
  ]) {
    if (missing !== undefined && (!Array.isArray(missing) || missing.length > 0))
      throw Error(`update contract violation: ${path} must be empty`);
  }
  const resultStagingDir = await directory(result?.staging?.dir, 'result.staging.dir');
  if (resultStagingDir !== contract.stagingDir)
    throw Error('update contract violation: result staging directory does not match contract');
  const stagingDir = await directory(contract.stagingDir, 'updateContract.stagingDir');
  const stagingManifest = await snapshotTree(stagingDir);
  if (contract.stagingDir !== stagingDir) throw Error('update contract violation: staging directory identity changed');
  const stagedPaths = new Map(stagingManifest.files.map(file => [file.path, file]));
  const originalPaths = new Map(contract.sourceManifest.files.map(file => [file.path, file]));
  const reportedPaths = new Set(result?.staging?.changed_files?.map(entry => entry?.path));
  for (const [path, original] of originalPaths) {
    const draft = stagedPaths.get(path);
    if (!draft && !reportedPaths.has(path))
      throw Error(`update contract violation: staging mirror omitted unchanged path ${path}`);
    if (draft && (draft.sha256 !== original.sha256 || draft.bytes !== original.bytes || draft.mode !== original.mode) && !reportedPaths.has(path))
      throw Error(`update contract violation: unreported staging change at ${path}`);
  }
  for (const path of stagedPaths.keys()) {
    if (!originalPaths.has(path) && !reportedPaths.has(path))
      throw Error(`update contract violation: unreported staging addition at ${path}`);
  }
  const changedFiles = reportedChanges(result, contract.sourceManifest, stagingManifest);
  const changedDirs = changedDirectories(contract.sourceManifest.directories, stagingManifest.directories);
  const receipt = await reverifyReceipt(result, contract.stagingDir, new Set(observedLabels));
  return Object.freeze({
    schema_version: 'dynamic-workflow-runner-update/v1',
    source_manifest: contract.sourceManifest,
    staging_manifest: stagingManifest,
    changed_files: changedFiles,
    changed_directories: changedDirs,
    reverify_receipt: receipt,
    apply: Object.freeze({
      owner: 'caller',
      authorization: 'required_after_review',
      source_root: contract.targetRoot,
      staging_root: contract.stagingRoot,
      source_dir: contract.targetDir,
      staging_dir: contract.stagingDir,
      operation: 'apply_listed_add_update_delete_after_hash_verification',
    }),
  });
}
