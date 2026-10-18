import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EVIDENCE_PACK_EXTENSIONS, MAX_FILE_BYTES, createSnapshot, verifySnapshot } from './review-snapshot.mjs';

const run = promisify(execFile);

async function tempDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-snapshot-test-'));
  t.after(async () => {
    await fs.chmod(root, 0o700).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

async function removeSnapshot(snapshot) {
  const chmodTree = async (dir) => {
    await fs.chmod(dir, 0o700).catch(() => {});
    for (const name of await fs.readdir(dir)) {
      const child = path.join(dir, name);
      const info = await fs.lstat(child);
      if (info.isDirectory()) await chmodTree(child);
      else await fs.chmod(child, 0o600).catch(() => {});
    }
  };
  await chmodTree(snapshot.snapshotRoot);
  await fs.rm(snapshot.snapshotRoot, { recursive: true, force: true });
}

test('full snapshot contains a sorted, bounded regular-file inventory and verifies source and copy', async (t) => {
  const root = await tempDir(t);
  const target = path.join(root, 'skill');
  await fs.mkdir(path.join(target, 'references'), { recursive: true });
  await fs.writeFile(path.join(target, 'SKILL.md'), 'read-only skill\n');
  await fs.writeFile(path.join(target, 'references', 'guide.md'), 'guide\n');
  const snapshot = await createSnapshot({ target, scope: 'full' });
  t.after(() => removeSnapshot(snapshot));

  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.targetRoot, await fs.realpath(target));
  assert.equal(snapshot.fileCount, 2);
  assert.equal(snapshot.byteCount, Buffer.byteLength('read-only skill\nguide\n'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(snapshot.snapshotRoot, 'manifest.json'), 'utf8')).files.map(({ path: name }) => name),
    ['SKILL.md', 'references/guide.md']);
  assert.equal((await fs.stat(path.join(snapshot.snapshotDir, 'SKILL.md'))).mode & 0o222, 0);
  assert.deepEqual(await verifySnapshot(snapshot.receiptPath), {
    status: 'verified', scope: 'full', targetRoot: snapshot.targetRoot, snapshotDir: snapshot.snapshotDir,
    manifestSha256: snapshot.manifestSha256, fileCount: 2, byteCount: snapshot.byteCount, changedPathCount: 0,
  });
});

test('diff snapshot freezes actual commit diff bytes and changed paths under a nested target', async (t) => {
  const root = await tempDir(t);
  await run('git', ['init', '-q', root]);
  await run('git', ['-C', root, 'config', 'user.email', 'review@example.invalid']);
  await run('git', ['-C', root, 'config', 'user.name', 'Review Test']);
  const target = path.join(root, 'plugins', 'demo', 'skills', 'sample');
  await fs.mkdir(path.join(target, 'references'), { recursive: true });
  await fs.writeFile(path.join(target, 'SKILL.md'), 'before\n');
  await fs.writeFile(path.join(target, 'references', 'kept.md'), 'context\n');
  await run('git', ['-C', root, 'add', '.']);
  await run('git', ['-C', root, 'commit', '-qm', 'base']);
  const base = (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  await fs.writeFile(path.join(target, 'SKILL.md'), 'after\n');
  await fs.writeFile(path.join(target, 'new.md'), 'added\n');
  await run('git', ['-C', root, 'add', '.']);
  await run('git', ['-C', root, 'commit', '-qm', 'change']);

  const snapshot = await createSnapshot({ target, scope: 'diff', diffRef: `${base}...HEAD` });
  t.after(() => removeSnapshot(snapshot));
  const manifest = JSON.parse(await fs.readFile(path.join(snapshot.snapshotRoot, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.changedPaths, ['SKILL.md', 'new.md']);
  assert.match(await fs.readFile(manifest.diffPath, 'utf8'), /before[\s\S]*after/);
  assert.equal((await verifySnapshot(snapshot.receiptPath)).changedPathCount, 2);
});

test('verification rejects source edits and modified frozen bytes', async (t) => {
  const root = await tempDir(t);
  const target = path.join(root, 'skill');
  await fs.mkdir(target);
  const source = path.join(target, 'SKILL.md');
  await fs.writeFile(source, 'original\n');
  const snapshot = await createSnapshot({ target, scope: 'full' });
  t.after(() => removeSnapshot(snapshot));

  await fs.writeFile(source, 'changed\n');
  await assert.rejects(verifySnapshot(snapshot.receiptPath), /live target changed/);
  await fs.writeFile(source, 'original\n');
  await fs.chmod(snapshot.snapshotDir, 0o700);
  await fs.chmod(path.join(snapshot.snapshotDir, 'SKILL.md'), 0o600);
  await fs.writeFile(path.join(snapshot.snapshotDir, 'SKILL.md'), 'tampered\n');
  await assert.rejects(verifySnapshot(snapshot.receiptPath), /snapshot drifted/);
});

test('snapshot preparation rejects symlinks and special files', async (t) => {
  const root = await tempDir(t);
  const target = path.join(root, 'skill');
  await fs.mkdir(target);
  await fs.writeFile(path.join(root, 'outside.md'), 'outside');
  await fs.symlink(path.join(root, 'outside.md'), path.join(target, 'escape.md'));
  await assert.rejects(createSnapshot({ target, scope: 'full' }), /symlink is not allowed/);
  await fs.unlink(path.join(target, 'escape.md'));
  if (typeof constants.O_NONBLOCK === 'number' && process.platform !== 'win32') {
    await run('mkfifo', [path.join(target, 'pipe')]);
    await assert.rejects(createSnapshot({ target, scope: 'full' }), /special file is not allowed/);
  }
});

test('snapshot preparation enforces the per-file byte cap before copying', async (t) => {
  const root = await tempDir(t);
  const target = path.join(root, 'skill');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'large.md'), Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
  await assert.rejects(createSnapshot({ target, scope: 'full' }), new RegExp(`exceeds ${MAX_FILE_BYTES} bytes`));
});

test('diff scope requires a literal two-endpoint revision range and full scope rejects a range', async (t) => {
  const root = await tempDir(t);
  const target = path.join(root, 'skill');
  await fs.mkdir(target);
  await assert.rejects(createSnapshot({ target, scope: 'diff', diffRef: '--output=/tmp/attack' }), /revision range/);
  await assert.rejects(createSnapshot({ target, scope: 'full', diffRef: 'main...HEAD' }), /cannot use --diff-ref/);
});

test('prepare writes a hash-bound evidence pack with original line numbers and declares the files it left out', async (t) => {
  const root = await tempDir(t);
  const target = path.join(root, 'skill');
  await fs.mkdir(path.join(target, 'references'), { recursive: true });
  await fs.mkdir(path.join(target, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(target, 'SKILL.md'), 'first line\nsecond line\n');
  await fs.writeFile(path.join(target, 'references', 'guide.md'), 'guide\n');
  await fs.writeFile(path.join(target, 'scripts', 'run.py'), 'print(1)\n');
  const snapshot = await createSnapshot({ target, scope: 'full' });
  t.after(() => removeSnapshot(snapshot));
  assert.deepEqual(EVIDENCE_PACK_EXTENSIONS, ['.md']);
  assert.equal(snapshot.evidencePackPath, path.join(snapshot.snapshotRoot, 'evidence-pack.txt'));
  const pack = await fs.readFile(snapshot.evidencePackPath, 'utf8');
  assert.match(pack, /===== FILE: SKILL\.md =====\n1\| first line\n2\| second line/);
  assert.match(pack, /===== FILE: references\/guide\.md =====\n1\| guide/);
  assert.match(pack, /## 入れなかったファイル（1 件[^\n]*\n- scripts\/run\.py/);
  assert.doesNotMatch(pack, /print\(1\)/);
  const manifest = JSON.parse(await fs.readFile(snapshot.manifestPath, 'utf8'));
  assert.equal(manifest.evidencePack.sha256, snapshot.evidencePackSha256);
  assert.deepEqual(manifest.evidencePack.excludedFiles, ['scripts/run.py']);
  assert.equal((await verifySnapshot(snapshot.receiptPath)).status, 'verified');
  await fs.chmod(snapshot.evidencePackPath, 0o600);
  await fs.appendFile(snapshot.evidencePackPath, 'tampered\n');
  await assert.rejects(verifySnapshot(snapshot.receiptPath), /evidence pack drifted/);
});
