// client（wait・salvage・submit）の規則を確かめるために、run の領域を cli-contract.md「run の領域の配置」の形で作る。
// 作るのはテストの準備で、run-daemon の代わりではない。生死は実際の process（生きている・終わった・pid の再利用）で作る。
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';

export const sha256 = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;
export const fileHash = (p) => sha256(readFileSync(p));

export function lstartOf(pid) {
  return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8' }).trim();
}

// 生きている process の識別。stop() で終わらせる。
export async function liveIdentity() {
  const child = spawn('sleep', ['600'], { stdio: 'ignore', detached: true });
  await new Promise((r) => child.once('spawn', r));
  const id = { pid: child.pid, started_at: lstartOf(child.pid), nonce: randomBytes(8).toString('hex') };
  return { id, stop: () => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* 終了済み */ } } };
}

// 終わった process の識別（kill(pid,0) が ESRCH を返す）。
export async function deadIdentity() {
  const child = spawn('sleep', ['600'], { stdio: 'ignore' });
  await new Promise((r) => child.once('spawn', r));
  const started_at = lstartOf(child.pid);
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await exited;
  return { pid: child.pid, started_at, nonce: randomBytes(8).toString('hex') };
}

// 生きている pid に、違う開始時刻を付けた識別（pid の再利用）。
export async function reusedIdentity() {
  const live = await liveIdentity();
  return { id: { ...live.id, started_at: 'Mon Jan  1 00:00:00 2001' }, stop: live.stop };
}

export function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

export function makeRunDir(workspace, runId = `20260101T000000Z-${randomBytes(3).toString('hex')}`) {
  const dir = join(workspace, '.formal-method', 'runs', runId);
  mkdirSync(dir, { recursive: true });
  return { runId, dir };
}

export function writeLock(dir, identity, role = 'run-daemon') {
  writeFileSync(join(dir, 'run.lock'), JSON.stringify({ ...identity, role }));
}

export function writeStatus(dir, status) { writeJsonAtomic(join(dir, 'status.json'), status); }

export function statusOf(dir, { seq = 1, action = 'working', result = null, daemon = null, batch = null } = {}) {
  return { seq, run_dir: dir, action, batch, result, daemon };
}

// ディレクトリの全ての項目（path・種類・大きさ・mtime・内容の指紋）。何も書かないことの確かめに使う。
export function snapshotTree(root) {
  const out = {};
  const walk = (p) => {
    const st = lstatSync(p);
    const rel = relative(root, p) || '.';
    if (st.isDirectory()) {
      out[rel] = `dir:${st.mtimeMs}`;
      for (const e of readdirSync(p).sort()) walk(join(p, e));
    } else if (st.isSymbolicLink()) {
      out[rel] = 'link';
    } else {
      out[rel] = `file:${st.size}:${st.mtimeMs}:${fileHash(p)}`;
    }
  };
  walk(root);
  return out;
}

export function listTree(root) {
  const out = [];
  const walk = (p) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
    else out.push(relative(root, p));
  };
  walk(root);
  return out.sort();
}

const unk = (reason) => ({ status: '取得できず', reason });

// artifact-formats.md の Result の形を満たす、最小の 停止 の結果（受付の段・依頼の不備）。区別のため marker を detail に入れる。
export function sampleResult(marker = 'fixture') {
  return {
    schema: 'formal-method.result/1',
    status: '停止',
    provisional: false,
    verified_scope: {
      targets: [], include: [], exclude: [], external_assumptions: [], unread: [],
      internal_time_limits: { agent_batch_deadline_ms: 1800000, tool_time_limit_max_s: 600, note: '内部の上限' },
      extraction_coverage: { complete: false, reason: '受付で止まった' },
    },
    properties: [], checks: [], models: [],
    decomposition: {
      graph: { nodes: [], edges: [], unconfirmed: [] },
      criteria: { algorithm: 'writer-merge-scc/1' },
      candidates: [], decisions: [], adopted: false, reason: '受付で止まった',
      parts: [], boundaries: [], contracts: [], composition_conditions: [],
      correspondence: { matched: [], unmatched: [], excluded: [] },
    },
    counterexamples: [], causes: [], confirmations: { deterministic: [], meaning: [] },
    unverified: [], questions: [],
    records: { ledger_refs: ['ledger.json'], saved: [], unsaved: [] },
    stop_report: {
      stage: '受付',
      reasons: [{ code: '依頼の不備', stage: '受付', request_code: 'target_missing', item: null, field: '/targets', detail: marker }],
      confirmed_scope: [], unconfirmed_scope: [], artifacts_created: [], artifacts_not_created: [],
      checks_running: [], checks_aborted: [], questions: [], unsaved: [],
    },
    performance: {
      location: 'ローカル',
      run: {
        total_ms: unk('x'), preparation_ms: unk('x'), build_ms: { status: '該当なし', reason: 'x' }, checks_ms: unk('x'),
        confirmation_ms: unk('x'), storage_ms: unk('x'), cpu_time_ms: unk('x'), peak_rss_bytes: unk('x'),
        cost: unk('x'), human_interventions: unk('x'), retries: { value: 0, unit: 'count' },
      },
      executions: [], findings: [],
    },
  };
}

export function ledgerFor(runId, resultBytes, kind = 'main') {
  return { schema: 'formal-method.ledger/1', run_id: runId, kind, entries: [], registered_result_hash: sha256(resultBytes) };
}
