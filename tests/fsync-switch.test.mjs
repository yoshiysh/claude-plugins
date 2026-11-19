// 本番コードの fsync は既定で行い、環境変数 CLAUDE_PLUGINS_SKIP_FSYNC が '1' のときだけ省く（make test が立てる）。
// make test の中ではこの変数が立っているので、各ケースで値を明示して既定の経路も通す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../.agents/skills/formal-method/scripts/lib/storage.mjs';
import { append } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/journal.mjs';
import { createStateDir } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/workspace.mjs';
import { syncHandle as runtimeSync } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/resume.mjs';

const NAME = 'CLAUDE_PLUGINS_SKIP_FSYNC';
// 既定（未設定）と、'1' 以外の値は fsync する。
const CASES = [[undefined, true], ['1', false], ['0', true], ['true', true]];

function withSwitch(t, value) {
  const saved = process.env[NAME];
  if (value === undefined) delete process.env[NAME]; else process.env[NAME] = value;
  t.after(() => { if (saved === undefined) delete process.env[NAME]; else process.env[NAME] = saved; });
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fsync-switch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// FileHandle の sync を数える（bp と runtime は FileHandle.sync で fsync する）。
async function countHandleSync(t, dir) {
  const probe = await open(path.join(dir, 'probe'), 'w');
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const sync = t.mock.method(proto, 'sync');
  return () => sync.mock.callCount();
}

for (const [value, durable] of CASES) {
  const label = value === undefined ? '未設定' : `'${value}'`;

  test(`formal-method の atomicWrite: ${label} なら fsync ${durable ? 'する' : 'しない'}`, async t => {
    withSwitch(t, value);
    const dir = await tempDir(t);
    // storage.mjs は fsyncSync を名前で import するので、組み込みの ESM の束縛へ mock を写す。
    const fsync = t.mock.method(fs, 'fsyncSync');
    syncBuiltinESMExports();
    t.after(() => { fsync.mock.restore(); syncBuiltinESMExports(); });
    atomicWrite(path.join(dir, 'x.json'), '{}');
    // 一時ファイルとディレクトリの 2 回。
    assert.equal(fsync.mock.callCount(), durable ? 2 : 0);
    assert.equal(fs.readFileSync(path.join(dir, 'x.json'), 'utf8'), '{}');
  });

  test(`bp の append と createStateDir: ${label} なら fsync ${durable ? 'する' : 'しない'}`, async t => {
    withSwitch(t, value);
    const dir = await tempDir(t);
    const calls = await countHandleSync(t, dir);
    const state = await createStateDir(dir, 'run-1', { op: 'first' });
    assert.equal(calls(), durable ? 1 : 0);
    await append(state, { op: 'second' });
    assert.equal(calls(), durable ? 2 : 0);
  });

  test(`runtime の syncHandle: ${label} なら fsync ${durable ? 'する' : 'しない'}`, async t => {
    withSwitch(t, value);
    let count = 0;
    await runtimeSync({ async sync() { count += 1; } });
    assert.equal(count, durable ? 1 : 0);
  });
}
