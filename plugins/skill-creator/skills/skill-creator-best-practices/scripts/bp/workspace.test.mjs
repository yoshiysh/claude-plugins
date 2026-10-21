import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CODES, LOCK_BREAK_DELAY_ENV } from './constants.mjs';
import { append, readAll, withLock } from './journal.mjs';
import { assertAllowedRoot, createStateDir, forbiddenReason } from './workspace.mjs';
import { LOCK_CHILD, REPO_ROOT, skillDir, stateRoot, tmpDir } from './fixtures/harness.mjs';

test('SP-BPRUN-039: 作業場所を /tmp 系と Codex runner の run ごとの workspace に作らない', (t) => {
  for (const root of [
    '/tmp/x', '/private/tmp/x', '/var/tmp/x', path.join(os.tmpdir(), 'x'), '/var/folders/ab/cd/T/x', '/private/var/folders/ab/x',
    path.join(REPO_ROOT, 'dynamic-workflows', 'workspace', 'slug', 'run-1', 'states'),
  ]) {
    assert.throws(() => assertAllowedRoot(root), (e) => e.code === CODES.place, root);
  }
  if (stateRoot(t)) assert.equal(forbiddenReason(path.join(REPO_ROOT, '.best-practices')), null);
});

test('SP-BPRUN-007: 作業場所を対象スキルの中に作らない', async (t) => {
  const target = await skillDir(t);
  assert.match(forbiddenReason('/Users/someone/repo/skill/.best-practices', { targetRoots: ['/Users/someone/repo/skill'] }), /対象スキルの中/);
  assert.ok(forbiddenReason(path.join(target, 'state'), { targetRoots: [target] }));
});

test('SP-BPRUN-007: 既にある状態のディレクトリを作業場所に使わない', async (t) => {
  const root = stateRoot(t);
  if (!root) return;
  const line = { seq: 1, run: 'r1', op: 'start', records: [] };
  await createStateDir(root, 'bp-x', line);
  await fs.writeFile(path.join(root, 'states', 'bp-x', 'mark'), 'kept');
  await assert.rejects(createStateDir(root, 'bp-x', line), (e) => e.code === CODES.conflict);
  assert.equal(await fs.readFile(path.join(root, 'states', 'bp-x', 'mark'), 'utf8'), 'kept');
});

test('記録の末尾の書きかけの行は読むときに捨て、次の書き込みが切り詰める', async (t) => {
  const dir = await tmpDir(t, 'bp-journal-');
  await fs.writeFile(path.join(dir, 'log.jsonl'), '{"seq":1,"records":[]}\n{"seq":2,"rec');
  assert.deepEqual((await readAll(dir)).map((l) => l.seq), [1]);
  await append(dir, { seq: 2, records: [] });
  assert.equal(await fs.readFile(path.join(dir, 'log.jsonl'), 'utf8'), '{"seq":1,"records":[]}\n{"seq":2,"records":[]}\n');
});

test('ロックは生きていない pid の古いロックを壊し、待ちが上限を超えると E_LOCK を返す', async (t) => {
  const dir = await tmpDir(t, 'bp-lock-');
  await fs.writeFile(path.join(dir, 'lock'), JSON.stringify({ pid: 999999, host: os.hostname() }));
  assert.equal(await withLock(dir, async () => 'ran'), 'ran');
  await fs.writeFile(path.join(dir, 'lock'), JSON.stringify({ pid: process.pid, host: os.hostname() }));
  await assert.rejects(withLock(dir, async () => 'never', { waitMs: 50 }), (e) => e.code === CODES.lock);
});

test('中身の読めない古いロックは mtime で古さを判定して壊す', async (t) => {
  const dir = await tmpDir(t, 'bp-lock-');
  const lock = path.join(dir, 'lock');
  await fs.writeFile(lock, '');
  const old = new Date(Date.now() - 60000);
  await fs.utimes(lock, old, old);
  assert.equal(await withLock(dir, async () => 'ran', { waitMs: 1000 }), 'ran');
  await fs.writeFile(lock, '');
  await assert.rejects(withLock(dir, async () => 'never', { waitMs: 50 }), (e) => e.code === CODES.lock);
});

test('古いロックを並行して壊しても、排他の区間に同時に入るのは 1 つだけ', async (t) => {
  const dir = await tmpDir(t, 'bp-lock-');
  await fs.writeFile(path.join(dir, 'lock'), JSON.stringify({ pid: 999999, host: os.hostname() }));
  let inside = 0;
  let max = 0;
  await Promise.all(Array.from({ length: 12 }, () => withLock(dir, async () => {
    inside += 1;
    max = Math.max(max, inside);
    await new Promise((r) => setTimeout(r, 5));
    inside -= 1;
  })));
  assert.equal(max, 1);
  assert.deepEqual((await fs.readdir(dir)).filter((n) => n.startsWith('lock')), []);
});

test('古いロックを破る 2 体の間に第三者が取っても、排他の区間に同時に入るのは 1 体だけ（子プロセスで遅延を差し込む）', async (t) => {
  const dir = await tmpDir(t, 'bp-lock-');
  await fs.writeFile(path.join(dir, 'lock'), JSON.stringify({ pid: 999999, host: os.hostname() }));
  const child = (label, env) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [LOCK_CHILD, dir, label, '600'], { env: { ...process.env, ...env }, stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', resolve);
  });
  const breakers = [child('slow', { [LOCK_BREAK_DELAY_ENV]: '200' }), child('fast', {})];
  await new Promise((r) => setTimeout(r, 250));
  const third = child('third', {});
  assert.deepEqual(await Promise.all([...breakers, third]), [0, 0, 0]);
  const trace = (await fs.readFile(path.join(dir, 'trace'), 'utf8')).trim().split('\n');
  assert.equal(trace.length, 6);
  for (let i = 0; i < trace.length; i += 2) {
    assert.match(trace[i], /^enter /);
    assert.equal(trace[i + 1], trace[i].replace('enter', 'exit'), trace.join(' / '));
  }
});

test('解放は自分の nonce のロックだけを消す', async (t) => {
  const dir = await tmpDir(t, 'bp-lock-');
  const other = JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: 'someone-else' });
  await withLock(dir, async () => {
    await fs.rm(path.join(dir, 'lock'));
    await fs.writeFile(path.join(dir, 'lock'), other);
  });
  assert.equal(await fs.readFile(path.join(dir, 'lock'), 'utf8'), other);
});
