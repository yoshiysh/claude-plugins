import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeUpdateContract, prepareUpdateContract, MAX_UPDATE_TREE_BYTES } from './update-contract.mjs';

const observedLabels = ['update-r1', 'p2r1'];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-update-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalRoot = await realpath(root);
  const targetRoot = join(canonicalRoot, 'targets');
  const stagingRoot = join(canonicalRoot, 'staging-root');
  const target = join(targetRoot, 'target');
  const staging = join(stagingRoot, 'staging-update');
  await mkdir(targetRoot); await mkdir(stagingRoot);
  await mkdir(join(target, 'nested'), { recursive: true });
  await writeFile(join(target, 'SKILL.md'), 'before\n');
  await writeFile(join(target, 'nested', 'reference.md'), 'unchanged\n');
  const contract = await prepareUpdateContract({ targetRoot, stagingRoot, targetDir: target, stagingDir: staging });
  return { targetRoot, stagingRoot, target, staging, contract };
}

async function staged(t) {
  const value = await fixture(t);
  await cp(value.target, value.contract.stagingDir, { recursive: true, force: true });
  await writeFile(join(value.contract.stagingDir, 'SKILL.md'), 'after\n');
  return { ...value, staging: value.contract.stagingDir };
}

function sourceResult(staging, receipt = {
  phase: 'Reverify', staging_dir: staging, fresh_thread: true, completed: true, by_category: { quality: 0 },
  updater_thread_id: 'update-r1', fresh_thread_id: 'p2r1',
}) {
  return {
    verdict: 'applied_to_staging',
    reverify_missing: [],
    staging: { dir: staging, changed_files: [{ path: 'SKILL.md', reason: 'intent', findings_addressed: ['intent'] }], reverify_missing: [] },
    reverify_receipt: receipt,
  };
}

test('an oversized target tree fails before update package creation', async t => {
  const { target, contract } = await fixture(t);
  await writeFile(join(target, 'large.bin'), Buffer.alloc(MAX_UPDATE_TREE_BYTES + 1));
  await assert.rejects(finalizeUpdateContract(contract, { verdict: 'needs_human_decision' }), /size limit/);
});

test('target hash drift rejects an update before an action package can be emitted', async t => {
  const { target, contract } = await fixture(t);
  await writeFile(join(target, 'SKILL.md'), 'tampered\n');
  await assert.rejects(finalizeUpdateContract(contract, { verdict: 'needs_human_decision' }), /target tree changed/);
});

test('non-empty top-level or staging reverify missing lists prevent package emission', async t => {
  const { staging, contract } = await staged(t);
  const topLevelMissing = sourceResult(staging);
  topLevelMissing.reverify_missing = ['quality'];
  await assert.rejects(finalizeUpdateContract(contract, topLevelMissing), /result\.reverify_missing must be empty/);

  const stagingMissing = sourceResult(staging);
  stagingMissing.staging.reverify_missing = ['quality'];
  await assert.rejects(finalizeUpdateContract(contract, stagingMissing), /result\.staging\.reverify_missing must be empty/);
});

test('an incomplete reverify receipt cannot produce an action package', async t => {
  const { staging, contract } = await staged(t);
  const receipt = { phase: 'Reverify', staging_dir: staging, fresh_thread: true, completed: false, by_category: { quality: 0 }, updater_thread_id: 'update-r1', fresh_thread_id: 'p2r1' };
  await assert.rejects(finalizeUpdateContract(contract, sourceResult(staging, receipt)), /complete fresh reverify receipt/);
});

test('an empty receipt or missing distinct provenance cannot produce an action package', async t => {
  const { staging, contract } = await staged(t);
  await assert.rejects(
    finalizeUpdateContract(contract, sourceResult(staging, { phase: 'Reverify', staging_dir: staging, fresh_thread: true, completed: true, by_category: {}, updater_thread_id: 'update-r1', fresh_thread_id: 'p2r1' })),
    /complete fresh reverify receipt/
  );
  await assert.rejects(
    finalizeUpdateContract(contract, sourceResult(staging, { phase: 'Reverify', staging_dir: staging, fresh_thread: true, completed: true, by_category: { quality: 0 } })),
    /complete fresh reverify receipt/
  );
});

test('macOS /var receipt aliases resolve to the canonical staging directory', async t => {
  const { staging, contract } = await staged(t);
  if (!staging.startsWith('/private/var/')) return t.skip('requires a macOS /private/var staging path');
  const alias = staging.replace('/private/var/', '/var/');
  const actionPackage = await finalizeUpdateContract(contract, sourceResult(alias, {
    phase: 'Reverify', staging_dir: alias, fresh_thread: true, completed: true, by_category: { quality: 0 },
    updater_thread_id: 'update-r1', fresh_thread_id: 'p2r1',
  }), observedLabels);
  assert.equal(actionPackage.reverify_receipt.staging_dir, contract.stagingDir);
  assert.equal(actionPackage.apply.staging_dir, contract.stagingDir);
});

test('a complete staging mirror yields a hash-bound caller-owned action package', async t => {
  const { staging, contract } = await staged(t);
  const actionPackage = await finalizeUpdateContract(contract, sourceResult(staging), observedLabels);
  assert.equal(actionPackage.schema_version, 'dynamic-workflow-runner-update/v1');
  assert.equal(actionPackage.changed_files.length, 1);
  assert.equal(actionPackage.changed_files[0].path, 'SKILL.md');
  assert.notEqual(actionPackage.changed_files[0].before_sha256, actionPackage.changed_files[0].after_sha256);
  assert.equal(actionPackage.changed_files[0].before_mode, 0o644);
  assert.equal(actionPackage.changed_files[0].after_mode, 0o644);
  assert.equal(actionPackage.apply.owner, 'caller');
  assert.equal(actionPackage.apply.authorization, 'required_after_review');
});

test('reported changes must exactly match the staging manifest', async t => {
  const { staging, contract } = await staged(t);
  const result = sourceResult(staging);
  result.staging.changed_files[0].path = 'nested/reference.md';
  await assert.rejects(finalizeUpdateContract(contract, result), /unreported staging change/);
});

test('receipt provenance must be labels observed by the runtime', async t => {
  const { staging, contract } = await staged(t);
  await assert.rejects(
    finalizeUpdateContract(contract, sourceResult(staging), ['update-r1', 'unrelated-label']),
    /provenance was not observed by runtime/
  );
});
