// 本番と同じ入口（標準入力の JSON 1 つ、標準出力の 1 行の JSON）から formal-method-cli.mjs を呼ぶ。
// 入力の口は cli-contract.md「呼び方と入力の口」のとおり、各コマンドの標準入力と、PATH・CI・現在のディレクトリだけを使う。
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, chmodSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export const SKILL_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const CLI = join(SKILL_DIR, 'scripts', 'formal-method-cli.mjs');
export const RUNS = '.formal-method/runs';

// テストの workspace は repo の外（git の作業ツリーの外）に作る。macOS の /var → /private/var を解決した path で扱う。
export function makeWorkspace(prefix = 'fm-ws-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function removeTree(dir) {
  // 権限を変えたテストの後でも消せるよう、書込みを戻してから消す。
  const walk = (p) => {
    let st;
    try { st = lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) return;
    try { chmodSync(p, st.isDirectory() ? 0o755 : 0o644); } catch { /* 所有者でなければ戻せない */ }
    if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
  };
  walk(dir);
  rmSync(dir, { recursive: true, force: true });
}

// 子の環境。既定は親の環境を写し、CI を除く（CI の有無を明示するケースだけが CI を置く）。
export function cliEnv({ path, ci = false, extra = {} } = {}) {
  const env = { ...process.env, ...extra };
  delete env.CI;
  if (ci) env.CI = 'true';
  if (path !== undefined) env.PATH = path;
  return env;
}

// 権限で書込み不可を作るケースは、root では権限が効かないので環境の理由で skip する。
export function skipIfRoot(t) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) { t.skip('root では権限による書込み不可を作れない'); return true; }
  return false;
}

export function runCli(args, stdinText, { cwd, env, timeoutMs = 300000, onSpawn = null } = {}) {
  const argv = Array.isArray(args) ? args : [args];
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...argv], { cwd, env: env ?? cliEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    if (onSpawn) onSpawn(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let json = null;
      const lines = stdout.split('\n').filter((l) => l.length > 0);
      if (lines.length === 1) { try { json = JSON.parse(lines[0]); } catch { json = null; } }
      resolve({ code, signal, stdout, stderr, json, lines: lines.length, elapsedMs: Date.now() - started, pid: child.pid });
    });
    if (stdinText !== undefined && stdinText !== null) child.stdin.end(stdinText);
    else child.stdin.end();
  });
}

export async function cli(command, input, opts = {}) {
  const r = await runCli(command, typeof input === 'string' ? input : JSON.stringify(input), opts);
  return r;
}

// 成功の出力の形（cli-contract.md「コマンド」）を確かめて返す。
export function expectOk(r, command) {
  assert.equal(r.code, 0, `exit code 0 を期待（stderr: ${r.stderr.slice(0, 2000)}）`);
  assert.equal(r.lines, 1, '標準出力は 1 行');
  assert.ok(r.json, '標準出力は JSON');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.command, command);
  return r.json;
}

export function expectRejected(r, code, detailReason = undefined) {
  assert.equal(r.lines, 1, '標準出力は 1 行');
  assert.ok(r.json, '標準出力は JSON');
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, code);
  if (code === 'E_CONTRACT') {
    assert.equal(r.code, 2);
  } else {
    assert.equal(r.code, 1);
    assert.equal(typeof r.json.command, 'string');
    assert.ok('detail' in r.json, 'detail を持つ');
    if (code === 'E_INPUT') assert.ok(['shape', 'run_dir_not_found'].includes(r.json.detail?.reason), `E_INPUT の detail.reason: ${JSON.stringify(r.json.detail)}`);
    if (detailReason !== undefined) assert.equal(r.json.detail?.reason, detailReason);
    if (code === 'E_BUSY') {
      assert.ok(['run-daemon', 'salvage'].includes(r.json.detail?.holder_role) && ['alive', 'unknown'].includes(r.json.detail?.liveness), JSON.stringify(r.json.detail));
      assert.equal(typeof r.json.detail?.run_dir, 'string', 'E_BUSY の detail は run_dir を持つ');
    }
  }
  assert.equal(typeof r.json.reason, 'string');
  assert.ok(r.json.reason.length > 0);
  return r.json;
}

// start から terminal まで進める。run_agents が来たら onAgents(status) を呼ぶ（担当の代わり）。
// onAgents が無いのに run_agents が来たら失敗にする（受付で止まるはずのケース）。
export async function drive(workspace, request, { env, onAgents = null, maxSteps = 200, onStatus = null } = {}) {
  const opts = { cwd: workspace, env };
  const statuses = [];
  let r = await cli('start', { request }, opts);
  // start が E_BUSY を返したら、salvage の E_BUSY と同じに扱う（run-daemon なら wait、salvage なら salvage を呼び直す）
  for (let i = 0; r.json?.ok === false && r.json.code === 'E_BUSY' && i < 30; i += 1) {
    const d = expectRejected(r, 'E_BUSY').detail;
    if (d.holder_role === 'run-daemon') {
      const w = await cli('wait', { run_dir: d.run_dir, status_seq: 0 }, opts);
      if (w.json?.ok && w.json.status) { r = { ...w, json: { ...w.json, command: 'start' } }; break; }
    } else {
      await new Promise((res) => setTimeout(res, 1000));
      r = await cli('salvage', { run_dir: d.run_dir }, opts);
      if (r.json?.ok) { r = { ...r, json: { ...r.json, command: 'start' } }; break; }
    }
  }
  let status = expectOk(r, 'start').status;
  statuses.push(status);
  for (let step = 0; step < maxSteps; step += 1) {
    if (onStatus) await onStatus(status, statuses);
    if (status.action === 'terminal') return { status, result: status.result, statuses };
    if (status.action === 'run_agents') {
      assert.ok(onAgents, `担当の起動を求められた（受付で止まるはずのケース）: ${JSON.stringify(status.batch)}`);
      await onAgents(status);
      r = await cli('wait', { run_dir: status.run_dir, status_seq: status.seq }, opts);
    } else {
      r = await cli('wait', { run_dir: status.run_dir, status_seq: status.seq }, opts);
    }
    if (r.json && r.json.ok === false && r.json.code === 'E_STALE') {
      const s = await cli('salvage', { run_dir: status.run_dir }, opts);
      status = expectOk(s, 'salvage').status;
      statuses.push(status);
      continue;
    }
    const w = expectOk(r, 'wait');
    if (w.outcome === 'still_waiting') continue;
    status = w.status;
    statuses.push(status);
  }
  throw new Error('terminal に届かない');
}
