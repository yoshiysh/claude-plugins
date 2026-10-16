import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createSnapshot } from './review-snapshot.mjs';

const execute = promisify(execFile);
const selector = fileURLToPath(new URL('./select_runtime.js', import.meta.url));
const run = async (...args) => JSON.parse((await execute(process.execPath, [selector, ...args])).stdout);
const RUNNER_LIMITS = { maxAgents: 1000, concurrency: 8, timeoutMs: 3600000, agentTimeoutMs: 300000, maxOutputBytes: 20000000 };
const reviewSource = await fs.readFile(new URL('../../../workflows/review_skill.js', import.meta.url), 'utf8');
const callerContract = await fs.readFile(new URL('../references/codex-workflow-compatibility.md', import.meta.url), 'utf8');

async function makeSnapshot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'selector-snapshot-test-'));
  const target = path.join(root, 'skill');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'SKILL.md'), 'target\n');
  const snapshot = await createSnapshot({ target, scope: 'full' });
  t.after(async () => {
    await fs.chmod(snapshot.snapshotDir, 0o700).catch(() => {});
    await fs.chmod(path.join(snapshot.snapshotDir, 'SKILL.md'), 0o600).catch(() => {});
    await fs.rm(snapshot.snapshotRoot, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, target: snapshot.targetRoot, snapshot };
}

function proofArgs(snapshot) {
  return [
    '--snapshot-receipt', snapshot.receiptPath,
    '--snapshot-target', snapshot.targetRoot,
    '--snapshot-scope', snapshot.scope,
  ];
}

test('review and audit route through the runner only when the prepared snapshot proof matches', async (t) => {
  const { target, snapshot } = await makeSnapshot(t);
  for (const mode of ['review', 'audit']) {
    const routed = await run('--mode', mode, '--no-native', '--runner-installed', ...proofArgs(snapshot));
    assert.deepEqual(routed, {
      selected_runtime: 'dynamic-workflow-runner', rejected_reason: null, halt: false,
      runner_limits: RUNNER_LIMITS,
      snapshot_manifest_sha256: snapshot.manifestSha256, snapshot_dir: snapshot.snapshotDir,
      snapshot_receipt_path: snapshot.receiptPath,
    });
  }

  const missing = await run('--mode', 'review', '--no-native', '--runner-installed');
  assert.equal(missing.selected_runtime, null);
  assert.match(missing.rejected_reason, /snapshot proof failed/);
  assert.equal(missing.halt, true);

  const wrongTarget = await run('--mode', 'review', '--no-native', '--runner-installed',
    ...proofArgs(snapshot).map((value, index) => index === 3 ? path.join(target, '..') : value));
  assert.equal(wrongTarget.selected_runtime, null);
  assert.match(wrongTarget.rejected_reason, /canonical target/);
});

test('selector runner limits cover the source maximum single review fan-out', async () => {
  const findingCap = Number(reviewSource.match(/const MAX_FINDINGS_PER_FINDER = (\d+)/)?.[1]);
  const finderBlock = reviewSource.match(/const FINDERS = \[([\s\S]*?)\n\]\n\nconst ACTIVE_FINDERS/)?.[1];
  const perspectiveBlock = reviewSource.match(/const PERSPECTIVES = \[([\s\S]*?)\n\]\n\n\/\/ agentType/)?.[1];
  assert.ok(Number.isSafeInteger(findingCap) && findingCap > 0);
  assert.ok(finderBlock && perspectiveBlock);
  const finderCount = [...finderBlock.matchAll(/^\s+id: '/gm)].length;
  const perspectiveCount = [...perspectiveBlock.matchAll(/^\s+id: '/gm)].length;
  const oneReviewWorstCase = finderCount * 2 + finderCount * findingCap * perspectiveCount;
  assert.ok(oneReviewWorstCase <= RUNNER_LIMITS.maxAgents,
    `source can dispatch ${oneReviewWorstCase} agents before runner cap ${RUNNER_LIMITS.maxAgents}`);
});

test('Codex caller places selector runner_limits on the runner request, outside workflow args', () => {
  assert.match(callerContract, /name: "skill-creator:skill-creator-review"[\s\S]*args: \{ \.\.\.workflowArgs, snapshot:[\s\S]*modelMap:[\s\S]*limits: <select_runtime\.js output\.runner_limits, unchanged>/);
});

test('update remains native when available and runner use still requires host-bound policy and snapshot proof', async (t) => {
  const { snapshot } = await makeSnapshot(t);
  const unboundWithoutSnapshot = await run('--mode', 'update', '--no-native', '--runner-installed');
  assert.equal(unboundWithoutSnapshot.selected_runtime, null);
  assert.match(unboundWithoutSnapshot.rejected_reason, /host-bound updatePolicy/);
  assert.equal(unboundWithoutSnapshot.halt, true);
  assert.deepEqual(await run('--mode', 'update', '--native-available', '--runner-installed', ...proofArgs(snapshot)), {
    selected_runtime: 'native', rejected_reason: null, halt: false,
    snapshot_manifest_sha256: snapshot.manifestSha256, snapshot_dir: snapshot.snapshotDir,
    snapshot_receipt_path: snapshot.receiptPath,
  });
  const rejected = await run('--mode', 'update', '--no-native', '--runner-installed', ...proofArgs(snapshot));
  assert.equal(rejected.selected_runtime, null);
  assert.match(rejected.rejected_reason, /host-bound updatePolicy/);
  assert.equal(rejected.halt, true);
  const missingSnapshot = await run('--mode', 'update', '--no-native', '--runner-installed', '--update-policy-bound');
  assert.equal(missingSnapshot.selected_runtime, null);
  assert.match(missingSnapshot.rejected_reason, /snapshot proof failed/);
  assert.equal(missingSnapshot.halt, true);
  assert.equal((await run('--mode', 'update', '--no-native', '--runner-installed', '--update-policy-bound', ...proofArgs(snapshot))).selected_runtime,
    'dynamic-workflow-runner');
  assert.equal((await run('--mode', 'update', '--no-native', '--no-runner', '--update-policy-bound', ...proofArgs(snapshot))).halt, true);
});

test('native attempt still forbids fallback after a snapshot has been verified', async (t) => {
  const { snapshot } = await makeSnapshot(t);
  const result = await run('--mode', 'review', '--native-available', '--native-attempted', '--runner-installed', ...proofArgs(snapshot));
  assert.equal(result.selected_runtime, null);
  assert.match(result.rejected_reason, /native Workflow を試行済み/);
  assert.equal(result.halt, true);
});

test('create mode does not require a review snapshot', async () => {
  assert.deepEqual(await run('--mode', 'create', '--no-native', '--runner-installed'), {
    selected_runtime: 'dynamic-workflow-runner', rejected_reason: null, halt: false, runner_limits: RUNNER_LIMITS,
  });
});
