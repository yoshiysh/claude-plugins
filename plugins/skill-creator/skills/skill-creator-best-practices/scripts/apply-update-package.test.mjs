import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyApprovedUpdatePackage, MAX_ACTION_PACKAGE_BYTES, MAX_APPLY_TREE_BYTES } from './apply-update-package.mjs';
import { replaceDirectoryTransactional } from './transactional-replace.mjs';
import { finalizeUpdateContract, prepareUpdateContract } from '../../../../workflow/skills/dynamic-workflow-runner/scripts/runtime/update-contract.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const provenance = ['update-r1', 'reverify-r1'];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'skill-update-apply-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalRoot = await realpath(root);
  const targetRoot = join(canonicalRoot, 'targets'), stagingRoot = join(canonicalRoot, 'staging-root');
  const target = join(targetRoot, 'target'), staging = join(stagingRoot, 'staging-update');
  await mkdir(target, { recursive: true }); await mkdir(stagingRoot);
  await writeFile(join(target, 'run.sh'), '#!/bin/sh\necho before\n');
  await chmod(join(target, 'run.sh'), 0o755);
  await writeFile(join(target, 'remove.md'), 'remove me\n');
  await mkdir(join(target, 'empty-remove'));
  await chmod(join(target, 'empty-remove'), 0o750);
  await chmod(target, 0o755);
  const contract = await prepareUpdateContract({ targetRoot, stagingRoot, targetDir: target, stagingDir: staging });
  await cp(target, staging, { recursive: true });
  await chmod(staging, 0o750);
  await writeFile(join(staging, 'run.sh'), '#!/bin/sh\necho after\n');
  await chmod(join(staging, 'run.sh'), 0o755);
  await unlink(join(staging, 'remove.md'));
  await rm(join(staging, 'empty-remove'), { recursive: true });
  await mkdir(join(staging, 'nested'));
  await chmod(join(staging, 'nested'), 0o700);
  await writeFile(join(staging, 'nested', 'new.md'), 'new file\n');
  await mkdir(join(staging, 'empty-added'), { mode: 0o750 });
  const changed_files = [
    { path: 'run.sh', reason: 'update', findings_addressed: ['f1'] },
    { path: 'remove.md', reason: 'remove', findings_addressed: ['f2'] },
    { path: 'nested/new.md', reason: 'add', findings_addressed: ['f3'] },
  ];
  const sourceResult = {
    verdict: 'applied_to_staging',
    reverify_missing: [],
    staging: { dir: staging, changed_files, reverify_missing: [] },
    reverify_receipt: {
      phase: 'Reverify', staging_dir: staging, fresh_thread: true, completed: true,
      by_category: { quality: 0 }, updater_thread_id: provenance[0], fresh_thread_id: provenance[1],
    },
  };
  const action = await finalizeUpdateContract(contract, sourceResult, provenance);
  const packagePath = join(root, 'action-package.json');
  const packageBytes = Buffer.from(JSON.stringify(action, null, 2));
  await writeFile(packagePath, packageBytes);
  return { root, targetRoot, stagingRoot, target, staging, packagePath, packageBytes, action, approvedHash: sha256(packageBytes) };
}

test('an oversized package is rejected before target mutation', async t => {
  const f = await fixture(t);
  await writeFile(f.packagePath, Buffer.alloc(MAX_ACTION_PACKAGE_BYTES + 1));
  await assert.rejects(applyApprovedUpdatePackage(f.packagePath, f.approvedHash), /size limit/);
  assert.equal(await readFile(join(f.target, 'run.sh'), 'utf8'), '#!/bin/sh\necho before\n');
});

test('an oversized staging tree is rejected before target mutation', async t => {
  const f = await fixture(t);
  await writeFile(join(f.staging, 'large.bin'), Buffer.alloc(MAX_APPLY_TREE_BYTES + 1));
  await assert.rejects(applyApprovedUpdatePackage(f.packagePath, f.approvedHash), /size limit/);
  assert.equal(await readFile(join(f.target, 'run.sh'), 'utf8'), '#!/bin/sh\necho before\n');
});

test('approved package applies add, update and delete while preserving executable mode', async t => {
  const f = await fixture(t);
  const result = await applyApprovedUpdatePackage(f.packagePath, f.approvedHash);
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.operations.map(operation => operation.operation), ['add', 'delete', 'update']);
  assert.equal(await readFile(join(f.target, 'run.sh'), 'utf8'), '#!/bin/sh\necho after\n');
  assert.equal((await stat(join(f.target, 'run.sh'))).mode & 0o777, 0o755);
  assert.equal(await readFile(join(f.target, 'nested', 'new.md'), 'utf8'), 'new file\n');
  await assert.rejects(readFile(join(f.target, 'remove.md')), { code: 'ENOENT' });
  assert.equal((await stat(f.target)).mode & 0o777, 0o750);
  assert.equal((await stat(join(f.target, 'nested'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.target, 'empty-added'))).mode & 0o777, 0o750);
  await assert.rejects(stat(join(f.target, 'empty-remove')), { code: 'ENOENT' });
  assert.ok(result.directory_operations.some(operation => operation.path === '' && operation.operation === 'mode'));
});

test('a changed package is rejected before target mutation', async t => {
  const f = await fixture(t);
  await writeFile(f.packagePath, Buffer.concat([f.packageBytes, Buffer.from(' ')]));
  await assert.rejects(applyApprovedUpdatePackage(f.packagePath, f.approvedHash), /package hash differs/);
  assert.equal(await readFile(join(f.target, 'run.sh'), 'utf8'), '#!/bin/sh\necho before\n');
  await assert.rejects(readFile(join(f.target, 'nested', 'new.md')), { code: 'ENOENT' });
});

test('target drift is rejected before the first listed operation is applied', async t => {
  const f = await fixture(t);
  await writeFile(join(f.target, 'remove.md'), 'concurrent change\n');
  await assert.rejects(applyApprovedUpdatePackage(f.packagePath, f.approvedHash), /source tree no longer matches/);
  assert.equal(await readFile(join(f.target, 'run.sh'), 'utf8'), '#!/bin/sh\necho before\n');
  await assert.rejects(readFile(join(f.target, 'nested', 'new.md')), { code: 'ENOENT' });
});

test('staging drift is rejected before target mutation', async t => {
  const f = await fixture(t);
  await writeFile(join(f.staging, 'nested', 'new.md'), 'changed after approval\n');
  await assert.rejects(applyApprovedUpdatePackage(f.packagePath, f.approvedHash), /staging tree no longer matches/);
  assert.equal(await readFile(join(f.target, 'run.sh'), 'utf8'), '#!/bin/sh\necho before\n');
  assert.equal(await readFile(join(f.target, 'remove.md'), 'utf8'), 'remove me\n');
});

test('an install rename failure restores the complete original directory', async t => {
  const f = await fixture(t);
  const replacement = join(f.targetRoot, '.replacement');
  await cp(f.staging, replacement, { recursive: true });
  let renames = 0;
  await assert.rejects(replaceDirectoryTransactional(f.target, replacement, {
    renamePath: async (source, destination) => {
      if (++renames === 2) throw Error('injected install failure');
      return rename(source, destination);
    },
  }), /injected install failure/);
  assert.equal(renames, 3);
  assert.equal(await readFile(join(f.target, 'run.sh'), 'utf8'), '#!/bin/sh\necho before\n');
  assert.equal(await readFile(join(f.target, 'remove.md'), 'utf8'), 'remove me\n');
});

test('a post-swap verification failure rolls back to the original tree', async t => {
  const f = await fixture(t);
  const replacement = join(f.targetRoot, '.replacement');
  await cp(f.staging, replacement, { recursive: true });
  await assert.rejects(replaceDirectoryTransactional(f.target, replacement, {
    onInstalled: async () => { throw Error('injected post-swap verification failure'); },
  }), /injected post-swap verification failure/);
  assert.equal(await readFile(join(f.target, 'run.sh'), 'utf8'), '#!/bin/sh\necho before\n');
  assert.equal(await readFile(join(f.target, 'remove.md'), 'utf8'), 'remove me\n');
});

test('a replaced target path symlink is rejected without writing through it', async t => {
  const f = await fixture(t);
  const moved = join(f.targetRoot, 'target-original');
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'sentinel'), 'untouched');
  await rename(f.target, moved);
  await symlink(outside, f.target);
  await assert.rejects(applyApprovedUpdatePackage(f.packagePath, f.approvedHash), /real directory|changed identity/);
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'untouched');
  assert.equal(await readFile(join(moved, 'run.sh'), 'utf8'), '#!/bin/sh\necho before\n');
});

test('a replaced target parent is detected before the first rename', async t => {
  const f = await fixture(t);
  const replacement = join(f.targetRoot, '.replacement');
  const movedParent = join(f.root, 'targets-original');
  const outside = join(f.root, 'outside');
  await cp(f.staging, replacement, { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, 'sentinel'), 'untouched');
  await assert.rejects(replaceDirectoryTransactional(f.target, replacement, {
    onBeforeSwap: async () => {
      await rename(f.targetRoot, movedParent);
      await symlink(outside, f.targetRoot);
    },
  }), /target parent.*real directory|target parent changed identity/);
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'untouched');
  assert.equal(await readFile(join(movedParent, 'target', 'run.sh'), 'utf8'), '#!/bin/sh\necho before\n');
});

test('backup cleanup failure reports an applied target with a retained backup', async t => {
  const f = await fixture(t);
  const replacement = join(f.targetRoot, '.replacement');
  await cp(f.staging, replacement, { recursive: true });
  const result = await replaceDirectoryTransactional(f.target, replacement, {
    removePath: async () => { throw Error('injected backup cleanup failure'); },
  });
  assert.equal(result.status, 'applied_with_backup_remains');
  assert.match(result.cleanupError, /injected backup cleanup failure/);
  assert.equal(await readFile(join(f.target, 'run.sh'), 'utf8'), '#!/bin/sh\necho after\n');
  assert.equal(await readFile(join(result.backupPath, 'run.sh'), 'utf8'), '#!/bin/sh\necho before\n');
});
