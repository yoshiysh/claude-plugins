// 実行体の版の検査（#264 SP-264-002）と、実行体の呼び出しの口 callCore（SP-264-004）を確かめる。
// start は保存先の確認と run の領域を作るより前に、実行体を --version で起動する。合わなければ run を始めず、
// 受付の停止（code 起動の失敗、detail に理由と install のコマンド）を action: terminal で返す。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, cliEnv, expectOk, makeWorkspace, removeTree, RUNS } from './test-fixtures/cli-runner.mjs';

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const SCHEMA = JSON.parse(readFileSync(join(SCRIPTS, '..', 'references', 'core.schema.json'), 'utf8'));
const X = SCHEMA['x-core'];
const INSTALL = `cargo install --locked --git https://github.com/yoshiysh/claude-plugins.git --tag formal-method-core-v${X.version} formal-method-core`;

test('SP-264-002: x-core の版・tag の接頭辞・repository・時間の上限は install のコマンドの値と合う', () => {
  assert.equal(X.binary, 'formal-method-core');
  assert.equal(X.tag_prefix, 'formal-method-core-v');
  assert.equal(X.repository, 'https://github.com/yoshiysh/claude-plugins.git');
  assert.equal(X.version_timeout_ms, 5000);
  assert.equal(X.call_timeout_ms, 60000);
  assert.match(X.version, /^\d+\.\d+\.\d+$/);
});

test('SP-264-004: 実行体の呼び出しは scripts/lib/core.mjs の callCore にまとめる', () => {
  // core-wiring.test.mjs の U2 の検査は core.mjs が在るときだけ当たる。ここで在ることを確かめ、その条件で検査が外れたままにしない
  assert.ok(existsSync(join(SCRIPTS, 'lib', 'core.mjs')), 'scripts/lib/core.mjs が無い');
});

function workspace() {
  const ws = makeWorkspace();
  mkdirSync(join(ws, 'target'));
  writeFileSync(join(ws, 'target', 'spec.md'), '# 対象\nR1: x は常に 0 以上である。\n');
  return ws;
}
const request = () => ({ targets: [{ id: 'T1', location: 'target' }], goals: [{ id: 'G1', text: 'R1 が成り立つ' }] });

// 偽の実行体（sh の script）。body は --version の起動の振る舞い
function fakeCore(dir, body) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'formal-method-core');
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
// runs/index/ は run-daemon が作る run の索引（scripts/lib/daemon.mjs、cli-contract.md / architecture.md の PR-034）で、run の領域ではない
const RUN_INDEX = 'index';
const runDirs = (ws) => (existsSync(join(ws, RUNS)) ? readdirSync(join(ws, RUNS)).filter((e) => !e.startsWith('.') && e !== RUN_INDEX) : []);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function assertVersionStop(status, ws) {
  assert.equal(status.action, 'terminal', JSON.stringify(status).slice(0, 500));
  assert.equal(status.run_dir, null);
  assert.equal(status.daemon, null, 'run-daemon を起動しない');
  const r = status.result;
  assert.equal(r.status, '停止');
  assert.equal(r.stop_report.reasons[0].code, '起動の失敗', JSON.stringify(r.stop_report.reasons));
  assert.ok(r.stop_report.reasons[0].detail.includes(INSTALL), `detail に install のコマンド: ${r.stop_report.reasons[0].detail}`);
  assert.deepEqual(runDirs(ws), [], '.formal-method/runs/ に run の領域ができない');
}

const CASES = [
  ['実行体が無い（FORMAL_METHOD_CORE_BIN の path が無い）', (dir) => join(dir, 'missing', 'formal-method-core')],
  ['版が違う', (dir) => fakeCore(dir, `echo 'formal-method-core 0.0.0-other'`)],
  ['0 でない終了コード', (dir) => fakeCore(dir, `echo 'formal-method-core ${X.version}'\nexit 1`)],
];
for (const [name, make] of CASES) {
  test(`SP-264-002: ${name} なら run を始めず 起動の失敗 の停止を返す`, async (t) => {
    const ws = workspace();
    t.after(() => removeTree(ws));
    const bin = make(join(ws, '..', `${ws.split('/').pop()}-core`));
    t.after(() => removeTree(join(ws, '..', `${ws.split('/').pop()}-core`)));
    const env = cliEnv({ extra: { FORMAL_METHOD_CORE_BIN: bin } });
    const r = await cli('start', { request: request() }, { cwd: ws, env });
    assertVersionStop(expectOk(r, 'start').status, ws);
  });
}

test('SP-264-002: --version が上限（version_timeout_ms）までに終わらなければ、子を止めてから 起動の失敗 の停止を返す', async (t) => {
  const ws = workspace();
  const dir = join(ws, '..', `${ws.split('/').pop()}-core`);
  t.after(() => { removeTree(ws); removeTree(dir); });
  const pidFile = join(dir, 'pid');
  const bin = fakeCore(dir, `echo $$ > '${pidFile}'\nexec sleep 60`);
  const env = cliEnv({ extra: { FORMAL_METHOD_CORE_BIN: bin } });
  const t0 = Date.now();
  const r = await cli('start', { request: request() }, { cwd: ws, env });
  const took = Date.now() - t0;
  assertVersionStop(expectOk(r, 'start').status, ws);
  assert.ok(took >= X.version_timeout_ms - 500, `上限まで待つ（${took}ms）`);
  assert.ok(took < X.version_timeout_ms + 20000, `上限を大きく超えて待たない（${took}ms）`);
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.equal(alive(pid), false, '時間切れの子が残っていない');
});

test('SP-264-002: 版の合う実行体なら従来どおり run が始まる', async (t) => {
  const ws = workspace();
  const dir = join(ws, '..', `${ws.split('/').pop()}-core`);
  t.after(() => { removeTree(ws); removeTree(dir); });
  const bin = fakeCore(dir, `echo 'formal-method-core ${X.version}'`);
  const env = cliEnv({ extra: { FORMAL_METHOD_CORE_BIN: bin } });
  const r = await cli('start', { request: request() }, { cwd: ws, env });
  const status = expectOk(r, 'start').status;
  t.after(() => { if (status.daemon?.pid) { try { process.kill(status.daemon.pid, 'SIGKILL'); } catch { /* 既に終わった */ } } });
  assert.notEqual(status.run_dir, null, JSON.stringify(status).slice(0, 500));
  assert.equal(runDirs(ws).length, 1, 'run の領域ができる');
});

// ---- callCore（SP-264-004） ----
async function withBin(t, body) {
  const dir = makeWorkspace('fm-core-bin-');
  t.after(() => removeTree(dir));
  const prev = process.env.FORMAL_METHOD_CORE_BIN;
  process.env.FORMAL_METHOD_CORE_BIN = fakeCore(dir, body);
  t.after(() => { if (prev === undefined) delete process.env.FORMAL_METHOD_CORE_BIN; else process.env.FORMAL_METHOD_CORE_BIN = prev; });
  return import('./lib/core.mjs');
}

test('SP-264-004: callCore は入力の JSON を標準入力に書き、標準出力の 1 行を JSON として読む', async (t) => {
  // 標準入力をそのまま {"sub": <引数>, "input": <入力>} に包んで返す偽の実行体
  const { callCore } = await withBin(t, `printf '{"sub":"%s","input":' "$1"; cat; printf '}\\n'`);
  assert.deepEqual(callCore('review-tally', { findings: [], items: [] }), { sub: 'review-tally', input: { findings: [], items: [] } });
});

test('SP-264-004: callCore は 0 でない終了コードで CoreError（subcommand・exit_code・stderr の先頭 4096 バイト）を投げる', async (t) => {
  const { callCore, CoreError } = await withBin(t, `cat > /dev/null; head -c 10000 /dev/zero | tr '\\0' 'e' >&2; exit 2`);
  assert.throws(() => callCore('mapping-rows', {}), (e) => {
    assert.ok(e instanceof CoreError, String(e));
    assert.equal(e.subcommand, 'mapping-rows');
    assert.equal(e.exit_code, 2);
    assert.equal(Buffer.byteLength(e.stderr), 4096);
    return true;
  });
});

test('SP-264-004: callCore は出力が JSON でなければ CoreError を投げる', async (t) => {
  const { callCore, CoreError } = await withBin(t, `cat > /dev/null; echo 'not json'`);
  assert.throws(() => callCore('review-tally', {}), (e) => e instanceof CoreError && e.subcommand === 'review-tally');
});
