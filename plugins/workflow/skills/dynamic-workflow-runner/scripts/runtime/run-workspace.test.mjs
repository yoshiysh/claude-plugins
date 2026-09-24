import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, promises as fsPromises } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createRunWorkspace, reuseRunWorkspace, snapshotRunWorkspace } from './run-workspace.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workflow-run-workspace-')));
  const runs = join(root, 'runs');
  await mkdir(runs);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, runDir: join(runs, 'run-1') };
}

test('creates a retained per-run directory with a safe workflow slug and unique run id', async t => {
  const { root, runDir } = await fixture(t);
  const first = await createRunWorkspace({ projectRoot: root, workflowName: '../../evidence review', runDir });
  const second = await createRunWorkspace({ projectRoot: root, workflowName: '../../evidence review', runDir });
  assert.equal(relative(root, first.path).startsWith('dynamic-workflows/workspace/evidence-review/'), true);
  assert.notEqual(first.path, second.path);
  assert.equal((await reuseRunWorkspace({ projectRoot: root, workflowName: '../../evidence review', workspace: first, runDir })).path, first.path);
});

test('rejects workspace paths outside the workflow root, overlapping journals and symlinked roots', async t => {
  const { root, runDir } = await fixture(t);
  const valid = await createRunWorkspace({ projectRoot: root, workflowName: 'review', runDir });
  await assert.rejects(reuseRunWorkspace({ projectRoot: root, workflowName: 'other', workspace: valid, runDir }), /outside its workflow root/);
  await assert.rejects(createRunWorkspace({ projectRoot: root, workflowName: 'review',
    runDir: join(root, 'dynamic-workflows', 'workspace', 'review') }), /must be separate/);

  const external = await mkdtemp(join(tmpdir(), 'workflow-run-workspace-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  const otherRoot = join(external, 'dynamic-workflows');
  await mkdir(otherRoot);
  await rm(join(root, 'dynamic-workflows'), { recursive: true });
  await symlink(otherRoot, join(root, 'dynamic-workflows'));
  await assert.rejects(createRunWorkspace({ projectRoot: root, workflowName: 'review', runDir }), /must be a real directory/);
});

test('snapshots nested and empty directories, their modes, and regular-file hashes; rejects symlinks', async t => {
  const { root, runDir } = await fixture(t);
  const workspace = await createRunWorkspace({ projectRoot: root, workflowName: 'review', runDir });
  await mkdir(join(workspace.path, 'nested', 'empty'), { recursive: true });
  await fsPromises.chmod(join(workspace.path, 'nested'), 0o710);
  await writeFile(join(workspace.path, 'nested', 'evidence.md'), 'evidence');
  const snapshot = await snapshotRunWorkspace(workspace.path);
  assert.deepEqual(snapshot.map(entry => [entry.path, entry.type]), [
    ['.', 'directory'], ['nested', 'directory'], ['nested/empty', 'directory'], ['nested/evidence.md', 'file'],
  ]);
  assert.equal(snapshot[0].mode, 0o700);
  assert.equal(snapshot[1].mode, 0o710);
  assert.equal(snapshot[3].size, 8);
  assert.match(snapshot[3].sha256, /^[a-f0-9]{64}$/);
  await symlink(join(workspace.path, 'nested', 'evidence.md'), join(workspace.path, 'evidence-link'));
  await assert.rejects(snapshotRunWorkspace(workspace.path), /symlink is not allowed/);
});

test('oversized flat workspaces stop at the manifest entry limit', async t => {
  const { root, runDir } = await fixture(t);
  const workspace = await createRunWorkspace({ projectRoot: root, workflowName: 'review', runDir });
  for (let index = 0; index < 10000; index++)
    await writeFile(join(workspace.path, `entry-${String(index).padStart(5, '0')}`), '');
  await assert.rejects(snapshotRunWorkspace(workspace.path), /manifest exceeds its entry limit/);
});

test('bounds names retained across nested directory scans before manifest traversal', async t => {
  const { root, runDir } = await fixture(t);
  const workspace = await createRunWorkspace({ projectRoot: root, workflowName: 'review', runDir });
  const first = join(workspace.path, '0-next');
  const second = join(first, '0-next');
  await mkdir(second, { recursive: true });
  for (const directory of [workspace.path, first, second]) {
    for (let index = 0; index < 7000; index++)
      await writeFile(join(directory, `entry-${String(index).padStart(5, '0')}`), '');
  }
  await assert.rejects(snapshotRunWorkspace(workspace.path), /manifest exceeds its pending-name limit/);
});

test('bounded reads reject file growth and short reads during snapshotting', async t => {
  for (const change of ['grow', 'shrink']) {
    await t.test(change, async t => {
      const { root, runDir } = await fixture(t);
      const workspace = await createRunWorkspace({ projectRoot: root, workflowName: 'review', runDir });
      const file = join(workspace.path, 'evidence.md');
      await writeFile(file, 'sealed');
      const originalOpen = fsPromises.open;
      const capturedSize = 6;
      let requested = 0, changed = false, readFileUsed = false;
      t.mock.method(fsPromises, 'open', async function(path, flags, ...args) {
        const handle = await originalOpen(path, flags, ...args);
        if (path !== file) return handle;
        const originalRead = handle.read.bind(handle);
        handle.read = async (buffer, offset, length, position) => {
          requested += length;
          if (!changed) {
            changed = true;
            await fsPromises.truncate(file, change === 'grow' ? capturedSize + 64 * 1024 * 1024 : 0);
          }
          return originalRead(buffer, offset, length, position);
        };
        const originalReadFile = handle.readFile.bind(handle);
        handle.readFile = async (...readArgs) => {
          readFileUsed = true;
          return originalReadFile(...readArgs);
        };
        return handle;
      });
      await assert.rejects(snapshotRunWorkspace(workspace.path), /workspace file changed while snapshotting/);
      assert.equal(changed, true);
      assert.ok(requested <= capturedSize);
      assert.equal(readFileUsed, false);
    });
  }
});

test('a FIFO swapped in before open cannot block a file snapshot', {
  skip: !existsSync('/usr/bin/mkfifo') || typeof constants.O_NONBLOCK !== 'number', timeout: 5000,
}, async t => {
  const { root, runDir } = await fixture(t);
  const workspace = await createRunWorkspace({ projectRoot: root, workflowName: 'review', runDir });
  const file = join(workspace.path, 'evidence.md');
  await writeFile(file, 'regular');
  const originalOpen = fsPromises.open;
  let swapped = false;
  t.mock.method(fsPromises, 'open', async function(path, flags, ...args) {
    if (path === file) {
      await fsPromises.unlink(file);
      execFileSync('/usr/bin/mkfifo', [file]);
      swapped = true;
      assert.notEqual(flags & constants.O_NONBLOCK, 0);
    }
    return originalOpen(path, flags, ...args);
  });
  await assert.rejects(snapshotRunWorkspace(workspace.path), /workspace file changed identity/);
  assert.equal(swapped, true);
});
