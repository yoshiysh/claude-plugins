#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalDirectory, inside, MAX_APPLY_TREE_BYTES, safeRelativePath, snapshotTree } from './apply-update-package.mjs';
import { readRegularFileBounded } from './safe-update-read.mjs';

export const FINGERPRINT_DIGITS = 12;

const USAGE = 'usage: node apply-staging.mjs fingerprint --staging DIR --out BASELINE_PATH | ' +
  'apply --staging DIR --target DIR --baseline BASELINE_PATH --changed-files CHANGED_FILES_JSON_PATH';

const sha256 = value => createHash('sha256').update(value).digest('hex');

class Rejection extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.detail = detail;
  }
}

function outsideOf(root, path, name) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Rejection(`${name} must be absolute`);
  if (inside(root, resolve(path))) throw new Rejection(`${name} must be outside the staging directory`);
  return resolve(path);
}

function diffManifests(before, after) {
  const key = file => `${file.sha256}:${file.mode}:${file.bytes}`;
  const original = new Map(before.files.map(file => [file.path, key(file)]));
  const current = new Map(after.files.map(file => [file.path, key(file)]));
  return [...new Set([...original.keys(), ...current.keys()])].sort()
    .filter(path => original.get(path) !== current.get(path));
}

export async function fingerprintStaging({ staging, out }) {
  const stagingDir = await canonicalDirectory(staging, 'staging');
  const baselinePath = outsideOf(stagingDir, out, 'baseline');
  const manifest = await snapshotTree(stagingDir);
  await writeFile(baselinePath, `${JSON.stringify({ staging_dir: stagingDir, ...manifest })}\n`, { flag: 'wx', mode: 0o600 });
  return { status: 'fingerprinted', staging_dir: stagingDir, baseline_path: baselinePath,
    sha256: manifest.sha256, fingerprint: manifest.sha256.slice(0, FINGERPRINT_DIGITS) };
}

async function readJson(path, name) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Rejection(`${name} is not readable JSON: ${error.message}`);
  }
}

function changedPathsFrom(value, manifest) {
  if (!Array.isArray(value) || value.length === 0)
    throw new Rejection('changed files must be the non-empty staging.changed_files array');
  const files = new Map(manifest.files.map(file => [file.path, file]));
  const paths = [...new Set(value.map(item => item?.path))];
  for (const path of paths) {
    if (!safeRelativePath(path)) throw new Rejection('changed file path is not a safe relative path', { path });
    if (!files.has(path)) throw new Rejection('changed file is not a regular file in staging', { path });
  }
  return paths.map(path => files.get(path));
}

async function assertWritableDestination(targetDir, relativePath) {
  const parts = relativePath.split('/');
  let current = targetDir;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const metadata = await lstat(current).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (metadata === null) return;
    const last = index === parts.length - 1;
    if (metadata.isSymbolicLink() || (last ? !metadata.isFile() : !metadata.isDirectory()))
      throw new Rejection('destination path crosses a symlink or a non-regular entry', { path: relativePath });
  }
}

export async function applyStaging({ staging, target, baseline, changedFiles }) {
  const stagingDir = await canonicalDirectory(staging, 'staging');
  const targetDir = await canonicalDirectory(target, 'target');
  if (inside(stagingDir, targetDir) || inside(targetDir, stagingDir))
    throw new Rejection('staging and target must not contain each other');
  const baselinePath = outsideOf(stagingDir, baseline, 'baseline');
  const changedFilesPath = outsideOf(stagingDir, changedFiles, 'changed files');
  const recorded = await readJson(baselinePath, 'baseline');
  if (recorded?.staging_dir !== stagingDir || !Array.isArray(recorded?.files))
    throw new Rejection('baseline was not taken for this staging directory');
  const current = await snapshotTree(stagingDir);
  if (current.sha256 !== recorded.sha256)
    throw new Rejection('staging changed after the baseline fingerprint', {
      baseline_fingerprint: String(recorded.sha256).slice(0, FINGERPRINT_DIGITS),
      current_fingerprint: current.sha256.slice(0, FINGERPRINT_DIGITS),
      changed_paths: diffManifests(recorded, current),
    });
  const files = changedPathsFrom(await readJson(changedFilesPath, 'changed files'), current);
  for (const file of files) await assertWritableDestination(targetDir, file.path);
  const copied = [];
  for (const file of files) {
    const source = join(stagingDir, ...file.path.split('/'));
    const contents = await readRegularFileBounded(source, await lstat(source), MAX_APPLY_TREE_BYTES);
    if (sha256(contents) !== file.sha256)
      throw new Rejection('staged file changed during apply', { path: file.path, copied });
    const destination = join(targetDir, ...file.path.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await assertWritableDestination(targetDir, file.path);
    const temporary = join(dirname(destination), `.apply-staging-${randomUUID()}`);
    try {
      await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
      await chmod(temporary, file.mode);
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw new Rejection(`copy failed: ${error.message}`, { path: file.path, copied });
    }
    copied.push(file.path);
  }
  return { status: 'applied', target_dir: targetDir, copied,
    fingerprint: current.sha256.slice(0, FINGERPRINT_DIGITS) };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!flag?.startsWith('--') || rest[index + 1] === undefined) throw new Rejection(USAGE);
    options[flag.slice(2)] = rest[index + 1];
  }
  const keys = Object.keys(options).sort().join(',');
  if (command === 'fingerprint' && keys === 'out,staging') return { command, options };
  if (command === 'apply' && keys === 'baseline,changed-files,staging,target') return { command, options };
  throw new Rejection(USAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    const result = command === 'fingerprint'
      ? await fingerprintStaging(options)
      : await applyStaging({ staging: options.staging, target: options.target, baseline: options.baseline,
        changedFiles: options['changed-files'] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'rejected', reason: error.message, ...(error.detail || {}) })}\n`);
    process.exitCode = 1;
  }
}
