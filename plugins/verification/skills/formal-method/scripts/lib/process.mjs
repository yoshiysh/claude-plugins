// 子 process の起動と制御（architecture.md「時計と資源」「保存と排他」のホストに殺されたとき）。
// 道具は解決した絶対 path と空の環境で、新しい process group として起動し、children/<pgid>.json に記録してから待ち、終わったら記録を消す。
// 常駐メモリと CPU 時間は記録のためだけに標本を取り、標本では止めない。
import { spawn, execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { MEMORY_SAMPLE_MS } from './schemas.mjs';
import { findExecutable } from './adapters/z3.mjs';
import { atomicWrite } from './storage.mjs';

// 開始時刻を読めなかったときに識別へ記録する値。生死の判定では比べずに「判定できない」とする。
export const UNKNOWN_START_TIME = 'unknown';

// process の開始時刻の文字列（cli-contract.md「生死の判定」）。ps を使えないか ps -o lstart= の値を読めなければ null（判定できない）。
// 読めたとき、Linux で /proc/<pid>/stat と boot_id を読めれば `proc:<boot_id>:<starttime>`（starttime は boot からの clock tick）を返し、
// 読めなければ ps -o lstart= の値（LC_ALL=C、前後の空白を除く）を返す。理由: procps の lstart は btime + starttime/HZ から求めるので、
// btime が跳ぶ環境（WSL2 で数秒のうちに数秒跳ぶことを実測）では同じ process の値が変わり、生きている保持者を pid の再利用と誤る。
// starttime の tick は btime に依らず、boot_id で再起動の前の記録と区別する。
export function startTimeOf(pid) {
  const ps = findExecutable('ps');
  if (!ps) return null;
  let lstart;
  try {
    lstart = execFileSync(ps, ['-o', 'lstart=', '-p', String(pid)], { env: { LC_ALL: 'C' }, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
  if (lstart.length === 0) return null;
  return procStartTime(pid) ?? lstart;
}

// /proc/<pid>/stat の 22 番目の欄（starttime）と boot_id。comm（2 番目の欄）は空白や括弧を含みうるので、最後の ')' の後から数える。
function procStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    // rest[0] は 3 番目の欄（state）なので、22 番目の欄は rest[19]
    const ticks = rest[19];
    if (!/^\d+$/.test(ticks ?? '')) return null;
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (!/^[0-9a-f-]+$/i.test(bootId)) return null;
    return `proc:${bootId}:${ticks}`;
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
  let childRecorded = false;
  if (pgid) {
    const startedAt = startTimeOf(pgid) ?? UNKNOWN_START_TIME;
    try {
      mkdirSync(join(runDir, 'children'), { recursive: true });
      atomicWrite(join(runDir, 'children', `${pgid}.json`), JSON.stringify({ pgid, started_at: startedAt }));
      childRecorded = true;
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
    // 記録は salvage が生きている group を止めるためのもの。group を止めた後は要らないので消す（消せなくても実行の結果は変えない）
    if (childRecorded) { try { unlinkSync(join(runDir, 'children', `${pgid}.json`)); } catch { /* 残っても salvage は生きていない group を止めない */ } }
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
