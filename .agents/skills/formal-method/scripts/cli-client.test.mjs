// 結合: client（wait・salvage・submit）の規則を、作った run の領域と実際の process の生死で確かめる。
// 正本: cli-contract.md「コマンド」「受け箱」「生死の判定」「salvage の手順」「誤りと終了コード」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cli, cliEnv, expectOk, expectRejected, makeWorkspace, removeTree } from './test-fixtures/cli-runner.mjs';
import {
  deadIdentity, liveIdentity, reusedIdentity, makeRunDir, writeLock, writeStatus, statusOf, snapshotTree,
  sampleResult, ledgerFor,
} from './test-fixtures/fabricate.mjs';
import { pathWithout } from './test-fixtures/make-fake-bin.mjs';
import { validate, Status } from './test-fixtures/result-schema.mjs';

const noPsEnv = () => cliEnv({ path: pathWithout(['ps']) });

async function fixture(t, { holder = 'dead' } = {}) {
  const ws = makeWorkspace();
  const { runId, dir } = makeRunDir(ws);
  let stop = () => {};
  let id;
  if (holder === 'dead') id = await deadIdentity();
  else if (holder === 'live') ({ id, stop } = await liveIdentity());
  else if (holder === 'reused') ({ id, stop } = await reusedIdentity());
  writeLock(dir, id);
  t.after(() => { stop(); removeTree(ws); });
  return { ws, runId, dir, id };
}

// ---- wait ----
test('cli-contract wait 生死の判定: 保持者が終わり status.json が terminal でなければ E_STALE で、何も書かない', async (t) => {
  const { ws, dir, id } = await fixture(t, { holder: 'dead' });
  writeStatus(dir, statusOf(dir, { seq: 1, daemon: id }));
  const before = snapshotTree(dir);
  const r = await cli('wait', { run_dir: dir, status_seq: 1 }, { cwd: ws });
  expectRejected(r, 'E_STALE');
  assert.deepEqual(snapshotTree(dir), before);
});

test('cli-contract wait 生死の判定 境界: pid が生きていても開始時刻が違えば（pid の再利用）終わったとみなし E_STALE', async (t) => {
  const { ws, dir, id } = await fixture(t, { holder: 'reused' });
  writeStatus(dir, statusOf(dir, { seq: 1, daemon: id }));
  const r = await cli('wait', { run_dir: dir, status_seq: 1 }, { cwd: ws });
  expectRejected(r, 'E_STALE');
});

test('cli-contract wait: status.json の seq が入力より大きければ、その Status を返す', async (t) => {
  const { ws, dir, id } = await fixture(t, { holder: 'live' });
  const s = statusOf(dir, { seq: 1, daemon: id });
  writeStatus(dir, s);
  const r = await cli('wait', { run_dir: dir, status_seq: 0 }, { cwd: ws });
  const j = expectOk(r, 'wait');
  assert.deepEqual(j.status, s);
});

test('cli-contract wait 準正常: 待つ間に seq が増えたら、新しい Status を返す（WAIT_POLL_MS の間隔で見る）', async (t) => {
  const { ws, dir, id } = await fixture(t, { holder: 'live' });
  writeStatus(dir, statusOf(dir, { seq: 1, daemon: id }));
  const next = statusOf(dir, { seq: 2, daemon: id, action: 'terminal', result: sampleResult('wait') });
  setTimeout(() => writeStatus(dir, next), 1000);
  const r = await cli('wait', { run_dir: dir, status_seq: 1 }, { cwd: ws });
  const j = expectOk(r, 'wait');
  assert.deepEqual(j.status, next);
  assert.ok(r.elapsedMs < 20000, `WAIT_POLL_MS 程度で返る: ${r.elapsedMs}ms`);
});

test('cli-contract wait: 保持者が終わっていても、terminal の Status が入力より新しければそれを返す', async (t) => {
  const { ws, dir, id } = await fixture(t, { holder: 'dead' });
  const s = statusOf(dir, { seq: 3, daemon: id, action: 'terminal', result: sampleResult('terminal') });
  writeStatus(dir, s);
  const j = expectOk(await cli('wait', { run_dir: dir, status_seq: 2 }, { cwd: ws }), 'wait');
  assert.deepEqual(j.status, s);
});

test('cli-contract wait: status.json が terminal なら、seq が入力と同じでもすぐその Status を返す（保持者が生きていても）', async (t) => {
  const { ws, dir, id } = await fixture(t, { holder: 'live' });
  const s = statusOf(dir, { seq: 4, daemon: id, action: 'terminal', result: sampleResult('terminal-now') });
  writeStatus(dir, s);
  const r = await cli('wait', { run_dir: dir, status_seq: 4 }, { cwd: ws });
  assert.deepEqual(expectOk(r, 'wait').status, s);
  assert.ok(r.elapsedMs < 10000, `すぐ返る: ${r.elapsedMs}ms`);
});

const BROKEN_STATUS = [
  ['status.json が無い', () => {}],
  ['JSON でない', (dir) => writeFileSync(join(dir, 'status.json'), 'not json')],
  ['Status の形に合わない', (dir) => writeFileSync(join(dir, 'status.json'), JSON.stringify({ seq: 99, action: 'terminal' }))],
  ['ファイルでない', (dir) => mkdirSync(join(dir, 'status.json'))],
];
for (const [name, breakIt] of BROKEN_STATUS) {
  test(`cli-contract wait: ${name}とき、保持者が終わっていれば E_STALE で何も書かない`, async (t) => {
    const { ws, dir } = await fixture(t, { holder: 'dead' });
    breakIt(dir);
    const before = snapshotTree(dir);
    expectRejected(await cli('wait', { run_dir: dir, status_seq: 0 }, { cwd: ws }), 'E_STALE');
    assert.deepEqual(snapshotTree(dir), before);
  });
  test(`cli-contract wait: ${name}とき、保持者が生きていれば seq が増えていないものとして待ち、正しい status.json が現れたらそれを返す`, async (t) => {
    const { ws, dir, id } = await fixture(t, { holder: 'live' });
    breakIt(dir);
    const next = statusOf(dir, { seq: 1, daemon: id });
    setTimeout(() => { rmSync(join(dir, 'status.json'), { recursive: true, force: true }); writeStatus(dir, next); }, 1500);
    const r = await cli('wait', { run_dir: dir, status_seq: 0 }, { cwd: ws });
    assert.deepEqual(expectOk(r, 'wait').status, next);
    assert.ok(r.elapsedMs >= 1000, '壊れた status.json では返らない');
  });
}

// ---- salvage ----
test('cli-contract salvage 1: run.lock の保持者が生きていれば E_BUSY（holder_role run-daemon・liveness alive）で、何も書かない', async (t) => {
  const { ws, dir, id } = await fixture(t, { holder: 'live' });
  writeStatus(dir, statusOf(dir, { seq: 1, daemon: id }));
  const before = snapshotTree(dir);
  const j = expectRejected(await cli('salvage', { run_dir: dir }, { cwd: ws }), 'E_BUSY');
  assert.deepEqual(j.detail, { holder_role: 'run-daemon', liveness: 'alive', run_dir: dir });
  assert.deepEqual(snapshotTree(dir), before);
});

test('cli-contract salvage 1 status.json の started_at: run.lock の started_at の前後に空白があっても、空白を除いて比べ、生きていると判定する', async (t) => {
  const { ws, dir, id } = await fixture(t, { holder: 'live' });
  writeLock(dir, { ...id, started_at: `  ${id.started_at}  ` });
  writeStatus(dir, statusOf(dir, { seq: 1, daemon: id }));
  const j = expectRejected(await cli('salvage', { run_dir: dir }, { cwd: ws }), 'E_BUSY');
  assert.deepEqual(j.detail, { holder_role: 'run-daemon', liveness: 'alive', run_dir: dir });
});

test('cli-contract salvage 1 生死の判定 4: ps を使えなければ生死は判定できず、E_BUSY（liveness unknown）で何も書かない', async (t) => {
  const { ws, dir, id } = await fixture(t, { holder: 'live' });
  writeStatus(dir, statusOf(dir, { seq: 1, daemon: id }));
  const before = snapshotTree(dir);
  const j = expectRejected(await cli('salvage', { run_dir: dir }, { cwd: ws, env: noPsEnv() }), 'E_BUSY');
  assert.deepEqual(j.detail, { holder_role: 'run-daemon', liveness: 'unknown', run_dir: dir });
  assert.deepEqual(snapshotTree(dir), before);
});

test('cli-contract salvage 生死の判定 1: ps を使えなくても kill(pid,0) が ESRCH なら死んでいると確定し、E_BUSY にしない', async (t) => {
  const { ws, dir, runId, id } = await fixture(t, { holder: 'dead' });
  const res = sampleResult('dead-no-ps');
  writeStatus(dir, statusOf(dir, { seq: 2, daemon: id, action: 'terminal', result: res }));
  const j = expectOk(await cli('salvage', { run_dir: dir }, { cwd: ws, env: noPsEnv() }), 'salvage');
  assert.equal(j.status.action, 'terminal');
  assert.deepEqual(j.status.result, res);
  assert.ok(runId);
});

test('cli-contract salvage 2: result.json があり結果の形に合えば、台帳の指紋・state.json・status.json によらずそれを返し、何も書かない', async (t) => {
  const { ws, dir, runId, id } = await fixture(t, { holder: 'dead' });
  writeStatus(dir, statusOf(dir, { seq: 4, daemon: id, action: 'working' }));
  const res = sampleResult('published');
  writeFileSync(join(dir, 'result.json'), JSON.stringify(res));
  writeFileSync(join(dir, 'ledger.json'), JSON.stringify(ledgerFor(runId, 'other bytes')));
  const before = snapshotTree(dir);
  const j = expectOk(await cli('salvage', { run_dir: dir }, { cwd: ws }), 'salvage');
  assert.deepEqual(validate(Status, j.status), []);
  assert.equal(j.status.action, 'terminal');
  assert.deepEqual(j.status.result, res, '台帳の指紋は照合しない');
  assert.deepEqual(snapshotTree(dir), before, 'salvage.mark を作らない');
});

const UNREADABLE_RESULT = [
  ['結果の形に合わない', (dir) => writeFileSync(join(dir, 'result.json'), JSON.stringify({ schema: 'formal-method.result/1', broken: true }))],
  ['JSON でない', (dir) => writeFileSync(join(dir, 'result.json'), '{"schema": "formal-')],
  ['ファイルでない', (dir) => mkdirSync(join(dir, 'result.json'))],
];
for (const [name, breakIt] of UNREADABLE_RESULT) {
  test(`cli-contract salvage 2: result.json があるのに${name}なら、status.json が terminal でも E_RESULT_UNREADABLE（detail は run_dir と path）を返し、別の結果を作らず何も書かない`, async (t) => {
    const { ws, dir, id } = await fixture(t, { holder: 'dead' });
    writeStatus(dir, statusOf(dir, { seq: 5, daemon: id, action: 'terminal', result: sampleResult('status-terminal') }));
    breakIt(dir);
    const before = snapshotTree(dir);
    const j = expectRejected(await cli('salvage', { run_dir: dir }, { cwd: ws }), 'E_RESULT_UNREADABLE');
    assert.deepEqual(j.detail, { run_dir: dir, path: join(dir, 'result.json') });
    assert.deepEqual(snapshotTree(dir), before);
  });
}

test('cli-contract salvage 3: 結果を公開できなかった run（status.json だけが terminal）では、その result を返し result.json を作らない', async (t) => {
  const { ws, dir, runId, id } = await fixture(t, { holder: 'dead' });
  const terminal = sampleResult('only-in-status');
  writeStatus(dir, statusOf(dir, { seq: 6, daemon: id, action: 'terminal', result: terminal }));
  writeFileSync(join(dir, 'ledger.json'), JSON.stringify(ledgerFor(runId, JSON.stringify(terminal))));
  const j = expectOk(await cli('salvage', { run_dir: dir }, { cwd: ws }), 'salvage');
  assert.deepEqual(j.status.result, terminal);
  assert.equal(existsSync(join(dir, 'result.json')), false);
  assert.equal(existsSync(join(dir, 'salvage.mark')), false);
});

test('cli-contract salvage 4: salvage.mark の勝者が生きていれば E_BUSY（holder_role salvage）で、何も書かない', async (t) => {
  const { ws, dir, id } = await fixture(t, { holder: 'dead' });
  writeStatus(dir, statusOf(dir, { seq: 2, daemon: id }));
  const winner = await liveIdentity();
  t.after(winner.stop);
  writeFileSync(join(dir, 'salvage.mark'), JSON.stringify(winner.id));
  const before = snapshotTree(dir);
  const j = expectRejected(await cli('salvage', { run_dir: dir }, { cwd: ws }), 'E_BUSY');
  assert.deepEqual(j.detail, { holder_role: 'salvage', liveness: 'alive', run_dir: dir });
  assert.deepEqual(snapshotTree(dir), before);
});

test('cli-contract salvage 4 生死の判定 4: 勝者の生死を判定できなければ E_BUSY（holder_role salvage・liveness unknown）', async (t) => {
  const { ws, dir, id } = await fixture(t, { holder: 'dead' });
  writeStatus(dir, statusOf(dir, { seq: 2, daemon: id }));
  const winner = await liveIdentity();
  t.after(winner.stop);
  writeFileSync(join(dir, 'salvage.mark'), JSON.stringify(winner.id));
  const j = expectRejected(await cli('salvage', { run_dir: dir }, { cwd: ws, env: noPsEnv() }), 'E_BUSY');
  assert.deepEqual(j.detail, { holder_role: 'salvage', liveness: 'unknown', run_dir: dir });
});

// ---- submit と受け箱 ----
const INBOX_FORMS = [
  ['workflow_output_path の形', (dir) => ({ run_dir: dir, batch_id: 'b1', workflow_output_path: join(dir, 'wf.json') }), (dir) => ({ batch_id: 'b1', workflow_output_path: join(dir, 'wf.json') })],
  ['timed_out の形', (dir) => ({ run_dir: dir, batch_id: 'b1', timed_out: true }), () => ({ batch_id: 'b1', timed_out: true })],
];
for (const [name, input, content] of INBOX_FORMS) {
  test(`cli-contract 受け箱 submit（${name}）: 受け箱を公開して accepted を返し、一時ファイルを残さない`, async (t) => {
    const ws = makeWorkspace();
    t.after(() => removeTree(ws));
    const { dir } = makeRunDir(ws);
    const j = expectOk(await cli('submit', input(dir), { cwd: ws }), 'submit');
    assert.equal(j.outcome, 'accepted');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'inbox', 'b1.json'), 'utf8')), content(dir));
    assert.deepEqual(readdirSync(join(dir, 'inbox')), ['b1.json']);
    assert.deepEqual(readdirSync(dir).sort(), ['inbox'], '受け箱の外を書かない（status.json が無くても公開する）');
  });
}

test('cli-contract 受け箱 準正常: 同じ batch の 2 回目の submit は、内容が違っても何も変えずに duplicate を返す', async (t) => {
  const ws = makeWorkspace();
  t.after(() => removeTree(ws));
  const { dir } = makeRunDir(ws);
  expectOk(await cli('submit', { run_dir: dir, batch_id: 'b1', workflow_output_path: '/a.json' }, { cwd: ws }), 'submit');
  const before = snapshotTree(dir);
  const j = expectOk(await cli('submit', { run_dir: dir, batch_id: 'b1', timed_out: true }, { cwd: ws }), 'submit');
  assert.equal(j.outcome, 'duplicate');
  assert.deepEqual(snapshotTree(dir), before);
});

test('cli-contract 受け箱 境界: status.json の開いている batch と違う batch_id でも公開する（読むかは run-daemon が決める）', async (t) => {
  const { ws, dir, id } = await fixture(t, { holder: 'live' });
  writeStatus(dir, statusOf(dir, { seq: 1, daemon: id, action: 'run_agents', batch: { batch_id: 'b-open', tasks_path: join(dir, 'batches', 'b-open', 'tasks.json'), deadline_wall_ms: Date.now() + 60000, workflow_script: '/x.js' } }));
  const j = expectOk(await cli('submit', { run_dir: dir, batch_id: 'b-other', timed_out: true }, { cwd: ws }), 'submit');
  assert.equal(j.outcome, 'accepted');
  assert.ok(existsSync(join(dir, 'inbox', 'b-other.json')));
});

test('cli-contract 受け箱 準正常: 並行に 2 つの submit を呼んでも、公開は 1 つだけで、一方が accepted・他方が duplicate', async (t) => {
  const ws = makeWorkspace();
  t.after(() => removeTree(ws));
  const { dir } = makeRunDir(ws);
  mkdirSync(join(dir, 'inbox'));
  const [a, b] = await Promise.all([
    cli('submit', { run_dir: dir, batch_id: 'b1', workflow_output_path: '/a.json' }, { cwd: ws }),
    cli('submit', { run_dir: dir, batch_id: 'b1', workflow_output_path: '/b.json' }, { cwd: ws }),
  ]);
  const outcomes = [expectOk(a, 'submit').outcome, expectOk(b, 'submit').outcome].sort();
  assert.deepEqual(outcomes, ['accepted', 'duplicate']);
  const content = JSON.parse(readFileSync(join(dir, 'inbox', 'b1.json'), 'utf8'));
  assert.ok(['/a.json', '/b.json'].includes(content.workflow_output_path), '書き終えた内容だけが見える');
  assert.deepEqual(readdirSync(join(dir, 'inbox')), ['b1.json']);
});

