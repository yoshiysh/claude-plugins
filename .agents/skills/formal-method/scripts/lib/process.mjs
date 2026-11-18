// 子 process の起動と制御（architecture.md「時計と資源」「保存と排他」のホストに殺されたとき）。
// 道具は解決した絶対 path と空の環境で、新しい process group として起動し、children/<pgid>.json に記録してから待つ。
// 常駐メモリと CPU 時間は記録のためだけに標本を取り、標本では止めない。
import { spawn, execFile, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MEMORY_SAMPLE_MS } from './schemas.mjs';
import { findExecutable } from './adapters/z3.mjs';
import { atomicWrite } from './storage.mjs';

// 開始時刻を読めなかったときに識別へ記録する値。生死の判定では比べずに「判定できない」とする。
export const UNKNOWN_START_TIME = 'unknown';

// process の開始時刻（ps -o lstart= を LC_ALL=C で読み、前後の空白を除いた値）。ps を使えないか読めなければ null。
export function startTimeOf(pid) {
  const ps = findExecutable('ps');
  if (!ps) return null;
  try {
    const out = execFileSync(ps, ['-o', 'lstart=', '-p', String(pid)], { env: { LC_ALL: 'C' }, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out.length > 0 ? out : null;
  } catch { return null; }
}

// 生死の判定（cli-contract.md「生死の判定」）。pid だけでは判定しない。
export function livenessOf(identity) {
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0) return 'dead';
  try { process.kill(identity.pid, 0); } catch (e) { if (e.code === 'ESRCH') return 'dead'; }
  const recorded = String(identity.started_at ?? '').trim();
  // 記録した側が開始時刻を読めなかった識別は、今読めても比べられないので判定できない（生きている側）
  if (recorded === '' || recorded === UNKNOWN_START_TIME) return 'unknown';
  const started = startTimeOf(identity.pid);
  if (started === null) return 'unknown';
  return started === recorded ? 'alive' : 'dead';
}

export function killGroup(pgid, signal = 'SIGKILL') {
  try { process.kill(-pgid, signal); return true; } catch { return false; }
}

// ps -o rss=,time= の 1 回の標本。読めなければ null。
function sample(pid) {
  const ps = findExecutable('ps');
  if (!ps) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(ps, ['-o', 'rss=,time=', '-p', String(pid)], { env: { LC_ALL: 'C' }, timeout: 2000 }, (err, out) => {
      const m = !err && String(out).trim().match(/^(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
      if (!m) { resolve(null); return; }
      const cpuMs = Math.round((((Number(m[2] ?? 0) * 24 + Number(m[3] ?? 0)) * 60 + Number(m[4])) * 60 + Number(m[5])) * 1000);
      resolve({ rss: Number(m[1]) * 1024, cpu_ms: cpuMs });
    });
  });
}

// 道具を起動して ProcessHandle を返す（architecture.md「scheduler の unit の入口」）。stats は終わった後に読む資源の記録。
// 道具（z3 -in）は標準入力の query を読むまで何もしないので、children/<pgid>.json を記録してから標準入力を渡す。記録できなければ
// 入力を渡さずに group を止め、起動の失敗とする。起動そのものの失敗（spawn の error）も起動の失敗で、startFailure に原因を持つ。
export function spawnTool({ executable, args, stdin, runDir }) {
  const child = spawn(executable, args, { env: {}, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pgid = child.pid;
  const stats = { peak_rss_bytes: null, cpu_time_ms: null, sampled: false, started_hr: process.hrtime.bigint(), elapsed_ms: null };
  const closeCbs = [];
  let closed = false;
  let startFailure = null;
  if (pgid) {
    const startedAt = startTimeOf(pgid) ?? UNKNOWN_START_TIME;
    try {
      mkdirSync(join(runDir, 'children'), { recursive: true });
      atomicWrite(join(runDir, 'children', `${pgid}.json`), JSON.stringify({ pgid, started_at: startedAt }));
    } catch (e) {
      startFailure = `道具の process group を children/ に記録できない（${e.code ?? e.message}）`;
      killGroup(pgid, 'SIGKILL');
    }
  }
  let sampling = Boolean(pgid) && startFailure === null;
  (async () => {
    while (sampling) {
      const s = await sample(pgid);
      if (s && sampling) {
        stats.sampled = true;
        stats.peak_rss_bytes = Math.max(stats.peak_rss_bytes ?? 0, s.rss);
        stats.cpu_time_ms = s.cpu_ms;
      }
      await new Promise((r) => { const t = setTimeout(r, MEMORY_SAMPLE_MS); t.unref?.(); });
    }
  })();
  child.stdin.on('error', () => { /* 道具が入力を読まずに終わった */ });
  if (startFailure === null) child.stdin.end(stdin); else child.stdin.destroy();
  child.on('error', (e) => {
    if (startFailure === null) startFailure = `道具を起動できない（${e.code ?? e.message}）`;
    if (!pgid) finish(null);
  });
  const finish = (code) => {
    if (closed) return;
    closed = true;
    sampling = false;
    stats.elapsed_ms = Number((process.hrtime.bigint() - stats.started_hr) / 1000000n);
    if (pgid) killGroup(pgid, 'SIGKILL');
    for (const cb of closeCbs) cb(code);
  };
  child.on('close', (code) => finish(code));
  return {
    stats,
    get startFailure() { return startFailure; },
    onStdout: (cb) => child.stdout.on('data', (c) => cb(new Uint8Array(c))),
    onStderr: (cb) => child.stderr.on('data', (c) => cb(new Uint8Array(c))),
    onClose: (cb) => { closeCbs.push(cb); },
    killGroup: () => { if (pgid) killGroup(pgid, 'SIGKILL'); else child.kill('SIGKILL'); },
  };
}
