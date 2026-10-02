#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replaceDirectoryTransactional } from './transactional-replace.mjs';
import { readRegularFileBounded } from './safe-update-read.mjs';

export const MAX_APPLY_TREE_BYTES = 32 * 1024 * 1024;
export const MAX_ACTION_PACKAGE_BYTES = 8 * 1024 * 1024;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value);
const isSafeMode = value => Number.isSafeInteger(value) && value >= 0 && value <= 0o777;
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const safeRelativePath = value => typeof value === 'string' && value.length > 0 &&
  !isAbsolute(value) && !value.includes('\\') &&
  value.split('/').every(part => part !== '' && part !== '.' && part !== '..');

function validateManifest(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'directories,files,sha256' ||
      !Array.isArray(value.directories) || !Array.isArray(value.files) ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256))
    throw Error(`${name} is malformed`);
  const directories = value.directories.map(directory => {
    if (!directory || typeof directory !== 'object' || Array.isArray(directory) ||
        Object.keys(directory).sort().join(',') !== 'mode,path' ||
        !(directory.path === '' || safeRelativePath(directory.path)) || !isSafeMode(directory.mode) ||
        (directory.mode & 0o500) !== 0o500)
      throw Error(`${name} contains a malformed directory`);
    return { path: directory.path, mode: directory.mode };
  });
  const files = value.files.map(file => {
    if (!file || typeof file !== 'object' || Array.isArray(file) ||
        Object.keys(file).sort().join(',') !== 'bytes,mode,path,sha256' || !safeRelativePath(file.path) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
        !isSafeMode(file.mode) ||
        typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256))
      throw Error(`${name} contains a malformed file`);
    return { path: file.path, bytes: file.bytes, mode: file.mode, sha256: file.sha256 };
  });
  const directoryPaths = new Set(directories.map(directory => directory.path));
  const filePaths = new Set(files.map(file => file.path));
  const parents = path => {
    const parts = path.split('/');
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
  };
  if (directories.length === 0 || directories[0].path !== '' ||
      new Set(directories.map(directory => directory.path)).size !== directories.length ||
      directories.some((directory, index) => index > 0 && directories[index - 1].path.localeCompare(directory.path) > 0) ||
      directories.some(directory => directory.path !== '' && !parents(directory.path).every(parent => directoryPaths.has(parent))) ||
      files.some(file => !parents(file.path).every(parent => directoryPaths.has(parent))) ||
      files.some(file => directoryPaths.has(file.path) || directories.some(directory =>
        directory.path.startsWith(`${file.path}/`))) ||
      new Set(files.map(file => file.path)).size !== files.length ||
      files.some((file, index) => index > 0 && files[index - 1].path.localeCompare(file.path) > 0) ||
      sha256(canonical({ directories, files })) !== value.sha256)
    throw Error(`${name} hash or ordering is invalid`);
  return Object.freeze({ directories: Object.freeze(directories), files: Object.freeze(files), sha256: value.sha256 });
}

function changedPaths(before, after) {
  const original = new Map(before.files.map(file => [file.path, file]));
  const staged = new Map(after.files.map(file => [file.path, file]));
  return [...new Set([...original.keys(), ...staged.keys()])].sort((a, b) => a.localeCompare(b)).flatMap(path => {
    const source = original.get(path), draft = staged.get(path);
    if (!source) return [{ operation: 'add', path, before_sha256: null, after_sha256: draft.sha256,
      before_mode: null, after_mode: draft.mode }];
    if (!draft) return [{ operation: 'delete', path, before_sha256: source.sha256, after_sha256: null,
      before_mode: source.mode, after_mode: null }];
    if (source.sha256 !== draft.sha256 || source.bytes !== draft.bytes || source.mode !== draft.mode)
      return [{ operation: 'update', path, before_sha256: source.sha256, after_sha256: draft.sha256,
        before_mode: source.mode, after_mode: draft.mode }];
    return [];
  });
}

function changedDirectories(before, after) {
  const original = new Map(before.directories.map(directory => [directory.path, directory]));
  const staged = new Map(after.directories.map(directory => [directory.path, directory]));
  return [...new Set([...original.keys(), ...staged.keys()])].sort((a, b) => a.localeCompare(b)).flatMap(path => {
    const source = original.get(path), draft = staged.get(path);
    if (!source) return [{ operation: 'add', path, before_mode: null, after_mode: draft.mode }];
    if (!draft) return [{ operation: 'delete', path, before_mode: source.mode, after_mode: null }];
    if (source.mode !== draft.mode)
      return [{ operation: 'mode', path, before_mode: source.mode, after_mode: draft.mode }];
    return [];
  });
}

async function snapshotTree(root) {
  const files = [];
  const directories = [];
  let totalBytes = 0;
  async function walk(current, prefix = '') {
    const directoryMetadata = await lstat(current);
    const directoryMode = directoryMetadata.mode & 0o777;
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() ||
        (directoryMode & 0o500) !== 0o500)
      throw Error(`tree directories must be real and owner-readable/searchable: ${prefix || '.'}`);
    directories.push({ path: prefix, mode: directoryMode });
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw Error(`tree must not contain symlinks: ${relativePath}`);
      if (metadata.isDirectory()) await walk(path, relativePath);
      else if (metadata.isFile()) {
        totalBytes += metadata.size;
        if (totalBytes > MAX_APPLY_TREE_BYTES) throw Error('apply tree exceeds its size limit');
        const contents = await readRegularFileBounded(path, metadata, MAX_APPLY_TREE_BYTES);
        files.push({ path: relativePath, bytes: contents.byteLength, mode: metadata.mode & 0o777,
          sha256: sha256(contents) });
      } else throw Error(`tree must contain only regular files and directories: ${relativePath}`);
    }
  }
  await walk(root);
  directories.sort((left, right) => left.path.localeCompare(right.path));
  files.sort((left, right) => left.path.localeCompare(right.path));
  const frozenDirectories = Object.freeze(directories);
  const frozenFiles = Object.freeze(files);
  return Object.freeze({ directories: frozenDirectories, files: frozenFiles,
    sha256: sha256(canonical({ directories: frozenDirectories, files: frozenFiles })) });
}

async function canonicalDirectory(path, name) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw Error(`${name} must be absolute`);
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw Error(`${name} must be a real directory`);
  const resolved = await realpath(path);
  if (resolved !== resolve(path)) throw Error(`${name} changed identity`);
  return resolved;
}

async function verifyManifest(tree, manifest, name) {
  const actual = await snapshotTree(tree);
  if (actual.sha256 !== manifest.sha256 || canonical(actual.directories) !== canonical(manifest.directories) ||
      canonical(actual.files) !== canonical(manifest.files))
    throw Error(`${name} no longer matches the approved manifest`);
}

async function prepareReplacement(staging, manifest, replacement) {
  await mkdir(replacement, { mode: 0o700 });
  try {
    const nestedDirectories = manifest.directories.filter(directory => directory.path !== '')
      .sort((left, right) => left.path.split('/').length - right.path.split('/').length || left.path.localeCompare(right.path));
    for (const directory of nestedDirectories)
      await mkdir(join(replacement, ...directory.path.split('/')), { mode: 0o700 });
    for (const file of manifest.files) {
      const source = join(staging, ...file.path.split('/'));
      const metadata = await lstat(source);
      const contents = await readRegularFileBounded(source, metadata, MAX_APPLY_TREE_BYTES);
      if (!metadata.isFile() || metadata.isSymbolicLink() || contents.byteLength !== file.bytes ||
          sha256(contents) !== file.sha256 || (metadata.mode & 0o777) !== file.mode)
        throw Error(`staged content or mode changed: ${file.path}`);
      const destination = join(replacement, ...file.path.split('/'));
      await writeFile(destination, contents, { flag: 'wx', mode: 0o600 });
      await chmod(destination, file.mode);
    }
    for (const directory of [...manifest.directories].sort((left, right) =>
      right.path.split('/').length - left.path.split('/').length || right.path.localeCompare(left.path)))
      await chmod(directory.path ? join(replacement, ...directory.path.split('/')) : replacement, directory.mode);
    await verifyManifest(replacement, manifest, 'prepared replacement tree');
  } catch (error) {
    await rm(replacement, { recursive: true, force: true });
    throw error;
  }
}

export async function applyApprovedUpdatePackage(packagePath, approvedPackageSha256) {
  if (typeof packagePath !== 'string' || !isAbsolute(packagePath) ||
      typeof approvedPackageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(approvedPackageSha256))
    throw Error('absolute package path and approved package SHA-256 are required');
  const packageMetadata = await lstat(packagePath);
  if (!packageMetadata.isFile() || packageMetadata.isSymbolicLink()) throw Error('package must be a regular file');
  const packageBytes = await readRegularFileBounded(packagePath, packageMetadata, MAX_ACTION_PACKAGE_BYTES);
  if (sha256(packageBytes) !== approvedPackageSha256) throw Error('package hash differs from the approved SHA-256');
  const action = JSON.parse(packageBytes.toString('utf8'));
  if (!action || typeof action !== 'object' || Array.isArray(action) ||
      Object.keys(action).sort().join(',') !== 'apply,changed_directories,changed_files,reverify_receipt,schema_version,source_manifest,staging_manifest' ||
      action.schema_version !== 'dynamic-workflow-runner-update/v1' || !Array.isArray(action.changed_files) ||
      !Array.isArray(action.changed_directories))
    throw Error('unsupported action package');
  if (!action.apply || typeof action.apply !== 'object' || Array.isArray(action.apply) ||
      Object.keys(action.apply).sort().join(',') !== 'authorization,operation,owner,source_dir,source_root,staging_dir,staging_root' ||
      action.apply.owner !== 'caller' || action.apply.authorization !== 'required_after_review' ||
      action.apply.operation !== 'apply_listed_add_update_delete_after_hash_verification')
    throw Error('package does not authorize caller-owned hash-verified operations');
  const sourceManifest = validateManifest(action.source_manifest, 'source_manifest');
  const stagingManifest = validateManifest(action.staging_manifest, 'staging_manifest');
  const sourceRoot = await canonicalDirectory(action.apply.source_root, 'source_root');
  const stagingRoot = await canonicalDirectory(action.apply.staging_root, 'staging_root');
  const target = await canonicalDirectory(action.apply.source_dir, 'source_dir');
  const staging = await canonicalDirectory(action.apply.staging_dir, 'staging_dir');
  if (sourceRoot !== action.apply.source_root || stagingRoot !== action.apply.staging_root ||
      target !== action.apply.source_dir || staging !== action.apply.staging_dir ||
      !inside(sourceRoot, target) || target === sourceRoot || !inside(stagingRoot, staging) ||
      dirname(staging) !== stagingRoot || sourceRoot === stagingRoot ||
      inside(sourceRoot, stagingRoot) || inside(stagingRoot, sourceRoot) ||
      inside(target, staging) || inside(staging, target))
    throw Error('source and staging roots or directories changed identity or containment');
  const receipt = action.reverify_receipt;
  if (!receipt || receipt.phase !== 'Reverify' || receipt.fresh_thread !== true || receipt.completed !== true ||
      !receipt.updater_thread_id || !receipt.fresh_thread_id || receipt.updater_thread_id === receipt.fresh_thread_id ||
      await canonicalDirectory(receipt.staging_dir, 'reverify staging_dir') !== staging)
    throw Error('complete matching Reverify receipt required');
  await verifyManifest(target, sourceManifest, 'source tree');
  await verifyManifest(staging, stagingManifest, 'staging tree');
  const expected = changedPaths(sourceManifest, stagingManifest);
  const operations = action.changed_files.map(file => ({
    operation: file?.operation, path: file?.path,
    before_sha256: file?.before_sha256 ?? null, after_sha256: file?.after_sha256 ?? null,
    before_mode: file?.before_mode ?? null, after_mode: file?.after_mode ?? null,
  }));
  if (canonical(operations) !== canonical(expected)) throw Error('package operations differ from full manifest delta');
  const directoryOperations = action.changed_directories.map(directory => {
    if (!directory || typeof directory !== 'object' || Array.isArray(directory) ||
        Object.keys(directory).sort().join(',') !== 'after_mode,before_mode,operation,path')
      throw Error('package contains a malformed directory operation');
    return { operation: directory.operation, path: directory.path,
      before_mode: directory.before_mode, after_mode: directory.after_mode };
  });
  const expectedDirectories = changedDirectories(sourceManifest, stagingManifest);
  if (canonical(directoryOperations) !== canonical(expectedDirectories))
    throw Error('package directory operations differ from full manifest delta');

  const prepared = join(dirname(target), `.${basename(target)}.replacement-${randomUUID()}`);
  await prepareReplacement(staging, stagingManifest, prepared);
  const verifyRoots = async () => {
    const [actualSourceRoot, actualStagingRoot, actualTarget, actualStaging] = await Promise.all([
      canonicalDirectory(action.apply.source_root, 'source_root'),
      canonicalDirectory(action.apply.staging_root, 'staging_root'),
      canonicalDirectory(action.apply.source_dir, 'source_dir'),
      canonicalDirectory(action.apply.staging_dir, 'staging_dir'),
    ]);
    if (actualSourceRoot !== sourceRoot || actualStagingRoot !== stagingRoot || actualTarget !== target ||
        actualStaging !== staging || !inside(sourceRoot, target) || !inside(stagingRoot, staging) ||
        dirname(staging) !== stagingRoot || inside(sourceRoot, stagingRoot) || inside(stagingRoot, sourceRoot))
      throw Error('source or staging root changed identity or containment during apply');
  };
  let replacementResult;
  try {
    replacementResult = await replaceDirectoryTransactional(target, prepared, {
      onBeforeSwap: async () => {
        await verifyRoots();
        await verifyManifest(target, sourceManifest, 'source tree');
        await verifyManifest(staging, stagingManifest, 'staging tree');
        await verifyManifest(prepared, stagingManifest, 'prepared replacement tree');
      },
      onInstalled: async () => {
        await verifyRoots();
        await verifyManifest(target, stagingManifest, 'applied target tree');
      },
    });
  } finally {
    await rm(prepared, { recursive: true, force: true });
  }
  return Object.freeze({ status: replacementResult.status, source_dir: target, operations: expected,
    directory_operations: expectedDirectories,
    ...(replacementResult.backupPath === undefined ? {} : { backup_path: replacementResult.backupPath }),
    ...(replacementResult.cleanupError === undefined ? {} : { cleanup_error: replacementResult.cleanupError }) });
}

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== '--package' || argv[2] !== '--approved-package-sha256')
    throw Error('usage: node apply-update-package.mjs --package ABSOLUTE_PATH --approved-package-sha256 SHA256');
  return { packagePath: argv[1], approvedSha256: argv[3] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { packagePath, approvedSha256 } = parseArgs(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(await applyApprovedUpdatePackage(packagePath, approvedSha256))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'failed', error: error.message })}\n`);
    process.exitCode = 1;
  }
}
