import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CODES, ENTRY_OPS, EXIT, OPS, STATE_ROOT_ENV } from './constants.mjs';
import { sum } from './ids.mjs';
import { acceptance, main } from '../bp-state.mjs';
import { CLI, CRITERIA_FIXTURE, LIMITS, REPO_ROOT, skillDir, stateRoot, tmpDir, newKey } from './fixtures/harness.mjs';

function call(root, op, body, { raw } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, op], { cwd: REPO_ROOT, env: { ...process.env, [STATE_ROOT_ENV]: root } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      const response = JSON.parse(out);
      const { sum: given, ...rest } = response;
      assert.equal(given, sum(rest), '応答の sum');
      resolve({ code, response });
    });
    child.stdin.end(raw ?? JSON.stringify({ ...body, sum: sum(body) }));
  });
}

test('CLI: 受理は 0、拒否は 2 で終わり、応答は sum を持つ。sum の合わない要求は状態を変えずに E_TRANSPORT', async (t) => {
  const root = stateRoot(t);
  if (!root) return;
  const target = await skillDir(t);
  const started = await call(root, 'start', { key: newKey(), function: 'review', target: { root: target }, limits: LIMITS });
  assert.equal(started.code, EXIT.ok);
  const req = { state: started.response.state, run: started.response.run };
  const body = { ...req, kind: 'goal', text: '目標' };
  const bad = await call(root, 'premise', null, { raw: JSON.stringify({ ...body, sum: '00000000' }) });
  assert.deepEqual([bad.code, bad.response.code], [EXIT.rejected, CODES.transport]);
  const summary = await call(root, 'summary', req);
  assert.doesNotMatch(summary.response.summary.text, /P1/);
  const ok = await call(root, 'premise', body);
  assert.deepEqual([ok.code, ok.response.id], [EXIT.ok, 'P1']);
  const unknown = await call(root, 'no-such-op', {});
  assert.deepEqual([unknown.code, unknown.response.code], [EXIT.rejected, CODES.input]);
});

test('SP-BPRUN-039: /tmp 配下を BP_STATE_ROOT に渡すと開始を拒否する', async (t) => {
  const target = await skillDir(t);
  const tmp = await tmpDir(t, 'bp-root-');
  const out = await call(tmp, 'start', { key: newKey(), function: 'review', target: { root: target }, limits: LIMITS });
  assert.deepEqual([out.code, out.response.code], [EXIT.rejected, CODES.place]);
  assert.deepEqual(await fs.readdir(tmp), []);
});

test('SP-BPRUN-006: 3 本の子 process の並行の書き込みで記録が欠けない', async (t) => {
  const root = stateRoot(t);
  if (!root) return;
  const target = await skillDir(t);
  const { response } = await call(root, 'start', { key: newKey(), function: 'review', target: { root: target }, limits: LIMITS });
  const req = { state: response.state, run: response.run };
  const staged = await call(root, 'stage-start', { ...req, stage: 'verify', keys: [{ i: 1 }, { i: 2 }, { i: 3 }] });
  const results = await Promise.all(staged.response.items.map((item, i) => call(root, 'item-result', { ...req, item, result: { i } })));
  assert.deepEqual(results.map((r) => r.code), [0, 0, 0]);
  const listed = await call(root, 'list', { function: 'review', target: { root: target } });
  assert.deepEqual(listed.response.states[0].pending, []);
  const lines = (await fs.readFile(path.join(root, 'states', req.state, 'log.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 5);
  assert.deepEqual(lines.map((l) => l.seq), [1, 2, 3, 4, 5]);
});

test('SP-BPRUN-036: 既定の置き場の判定基準の写しから、本物の CLI の process が閉集合を作る', async (t) => {
  const root = stateRoot(t);
  if (!root) return;
  const target = await skillDir(t);
  const { response } = await call(root, 'start', { key: newKey(), function: 'review', target: { root: target }, limits: LIMITS });
  const out = await call(root, 'kinds', { state: response.state, viewpoint: 'flow' });
  assert.equal(out.code, EXIT.ok, JSON.stringify(out.response));
  assert.ok(out.response.kinds.length > 0);
});

test('SP-BPRUN-036: 判定基準の写しが無い置き場では、閉集合を要する操作が理由つきの E_INPUT になる', async (t) => {
  const root = stateRoot(t);
  if (!root) return;
  const target = await skillDir(t);
  const { response } = await call(root, 'start', { key: newKey(), function: 'review', target: { root: target }, limits: LIMITS });
  const body = { state: response.state, viewpoint: 'flow' };
  const out = await main(['kinds'], JSON.stringify({ ...body, sum: sum(body) }), { cwd: REPO_ROOT, env: { [STATE_ROOT_ENV]: root }, criteriaDir: path.join(await tmpDir(t), 'none') });
  assert.deepEqual([out.exitCode, out.output.code], [EXIT.rejected, CODES.input]);
  assert.match(out.output.reason, /判定基準の写しが無い/);
});

test('payloadFile と payloadSum が文字列でない要求は E_TRANSPORT', async (t) => {
  const root = stateRoot(t);
  if (!root) return;
  const target = await skillDir(t);
  const { response } = await call(root, 'start', { key: newKey(), function: 'review', target: { root: target }, limits: LIMITS });
  const out = await call(root, 'premise', { state: response.state, run: response.run, payloadFile: 42, payloadSum: 'x' });
  assert.equal(out.response.code, CODES.transport);
});

test('運搬役が写さない大きい値は作業ファイルと sum で渡し、ファイルの中身が sum と合わなければ E_TRANSPORT', async (t) => {
  const root = stateRoot(t);
  if (!root) return;
  const target = await skillDir(t);
  const { response } = await call(root, 'start', { key: newKey(), function: 'review', target: { root: target }, limits: LIMITS });
  const req = { state: response.state, run: response.run };
  const staged = await call(root, 'stage-start', { ...req, stage: 'verify', keys: [{ i: 1 }] });
  const payload = { result: { big: 'x'.repeat(10000) } };
  const file = `${staged.response.items[0]}.attempt1.json`;
  await fs.writeFile(path.join(response.workDir, file), JSON.stringify(payload));
  const wrong = await call(root, 'item-result', { ...req, item: staged.response.items[0], payloadFile: file, payloadSum: '00000000' });
  assert.deepEqual([wrong.code, wrong.response.code], [EXIT.rejected, CODES.transport]);
  const outside = await call(root, 'item-result', { ...req, item: staged.response.items[0], payloadFile: '../log.jsonl', payloadSum: sum(payload) });
  assert.equal(outside.response.code, CODES.transport);
  const ok = await call(root, 'item-result', { ...req, item: staged.response.items[0], payloadFile: file, payloadSum: sum(payload) });
  assert.equal(ok.code, EXIT.ok);
});

test('SP-BPRUN-031: CLI 経由の verdicts の受理は ok === true で、件数は judgedOk に入る', async (t) => {
  const root = stateRoot(t);
  if (!root) return;
  const target = await skillDir(t);
  const env = { ...process.env, [STATE_ROOT_ENV]: root };
  const send = async (op, body) => (await main([op], JSON.stringify({ ...body, sum: sum(body) }), { cwd: REPO_ROOT, env, criteriaDir: CRITERIA_FIXTURE })).output;
  const s = await send('start', { key: newKey(), function: 'review', target: { root: target }, limits: LIMITS });
  const req = { state: s.state, run: s.run };
  const made = await send('ledger-create', req);
  const { assignments } = await send('assignments', { ...req, stage: 'verify', rule: 'all' });
  const { items } = await send('stage-start', { ...req, stage: 'verify', keys: [{ assignment: assignments[0].id }] });
  const out = await send('verdicts', { ...req, item: items[0], assignment: assignments[0].id, viewpoint: 'flow', result: { judgements: made.assets.map((a) => ({ asset: a.id, judgement: 'unsure' })), unchecked: [] } });
  assert.equal(out.ok, true);
  assert.equal(out.judgedOk, 0);
  assert.equal(out.judgedUnsure, made.assets.length);
});

test('操作の出力が応答の予約欄と衝突すると内部の失敗にする', () => {
  for (const key of ['ok', 'op', 'sum']) assert.throws(() => acceptance('x', { [key]: 1 }), (e) => e.code === CODES.internal, key);
  assert.equal(acceptance('x', { n: 1 }).ok, true);
});

test('CLI: 知らない操作の拒否の理由は、受け付ける全ての操作（run の中の操作と入口の操作）を挙げる', async () => {
  const { output } = await main(['no-such-op'], JSON.stringify({ sum: sum({}) }), { cwd: REPO_ROOT, env: {} });
  assert.equal(output.code, CODES.input);
  for (const op of [...Object.values(OPS), ...Object.values(ENTRY_OPS)]) assert.ok(output.reason.split(/[（ ）]/).includes(op), op);
});
