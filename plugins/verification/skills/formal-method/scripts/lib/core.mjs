// 実行体 formal-method-core の呼び出しの口（#264 SP-264-002・004）。
// 実行体の path は FORMAL_METHOD_CORE_BIN、無ければ PATH の x-core.binary。呼び出しは callCore にまとめる。
import { spawnSync } from 'node:child_process';
import { CORE, CORE_SCHEMA } from './core-schema.mjs';

export { CORE_SCHEMA };

const STDERR_MAX_BYTES = 4096;
const MAX_BUFFER = 256 * 1024 * 1024;

export const coreBin = () => process.env.FORMAL_METHOD_CORE_BIN || CORE.binary;

// install のコマンド（spec §1）を schema の版で埋める
export const installCommand = () => `cargo install --locked --git ${CORE.repository} --tag ${CORE.tag_prefix}${CORE.version} ${CORE.binary}`;

// 実行体の誤り。run-daemon は捕まえず、段の例外として 内部の誤り で中断する（daemon.mjs）
export class CoreError extends Error {
  constructor(subcommand, { exit_code = null, signal = null, stderr = '', reason }) {
    super(`formal-method-core ${subcommand}: ${reason}${stderr ? `: ${stderr.split('\n')[0]}` : ''}`);
    this.name = 'CoreError';
    this.subcommand = subcommand;
    this.exit_code = exit_code;
    this.signal = signal;
    this.stderr = stderr;
  }
}

// 標準エラーの先頭 STDERR_MAX_BYTES バイト。切れ目で割れた UTF-8 の文字は落とす（置換の文字で上限を超えないため）
const headBytes = (buf) => {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? '');
  if (b.length <= STDERR_MAX_BYTES) return b.toString('utf8');
  return b.subarray(0, STDERR_MAX_BYTES).toString('utf8').replace(/\uFFFD+$/, '');
};

// 版の検査。戻り値 { ok: true } | { ok: false, why }（SP-264-002 の 4 つの場合）
export function checkCoreVersion() {
  const bin = coreBin();
  const want = `${CORE.binary} ${CORE.version}`;
  const r = spawnSync(bin, ['--version'], { timeout: CORE.version_timeout_ms, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER });
  if (r.error?.code === 'ENOENT') return { ok: false, why: `実行体 ${bin} が見つからない` };
  if (r.error?.code === 'ETIMEDOUT') return { ok: false, why: `実行体 ${bin} の --version が上限 ${CORE.version_timeout_ms}ms までに終わらない` };
  if (r.error) return { ok: false, why: `実行体 ${bin} を起動できない（${r.error.code ?? r.error.message}）` };
  if (r.signal) return { ok: false, why: `実行体 ${bin} の --version が signal ${r.signal} で終わった` };
  if (r.status !== 0) return { ok: false, why: `実行体 ${bin} の --version が終了コード ${r.status} で終わった` };
  const line = r.stdout.toString('utf8').replace(/\r?\n$/, '');
  if (line !== want) return { ok: false, why: `実行体 ${bin} の版が合わない（${JSON.stringify(line.slice(0, 200))}、要るのは ${JSON.stringify(want)}）` };
  return { ok: true };
}

// サブコマンドを 1 回呼ぶ。入力の JSON を標準入力に書き、標準出力の 1 行を JSON として読む
export function callCore(subcommand, input) {
  const r = spawnSync(coreBin(), [subcommand], {
    input: JSON.stringify(input), timeout: CORE.call_timeout_ms, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = headBytes(r.stderr);
  if (r.error) {
    const reason = r.error.code === 'ETIMEDOUT' ? `上限 ${CORE.call_timeout_ms}ms までに終わらない` : `起動できない（${r.error.code ?? r.error.message}）`;
    throw new CoreError(subcommand, { exit_code: r.status, signal: r.signal, stderr, reason });
  }
  if (r.signal) throw new CoreError(subcommand, { signal: r.signal, stderr, reason: `signal ${r.signal} で終わった` });
  if (r.status !== 0) throw new CoreError(subcommand, { exit_code: r.status, stderr, reason: `終了コード ${r.status}` });
  const lines = r.stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
  if (lines.length !== 1) throw new CoreError(subcommand, { exit_code: 0, stderr, reason: `標準出力が 1 行でない（${lines.length} 行）` });
  try { return JSON.parse(lines[0]); } catch { throw new CoreError(subcommand, { exit_code: 0, stderr, reason: '標準出力が JSON でない' }); }
}
