#!/usr/bin/env node
// formal-method の決定的な CLI（cli-contract.md「呼び方と入力の口」「コマンド」「誤りと終了コード」）。
// 引数は 1 語、入力は標準入力の 1 つの JSON、出力は標準出力の 1 行の JSON。run-daemon は start が起動する内部のコマンド。
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { start } from './lib/start.mjs';
import { submit, wait } from './lib/client.mjs';
import { salvage } from './lib/store.mjs';
import { runDaemon } from './lib/daemon.mjs';
import { locationFromEnv } from './lib/performance.mjs';
import { ERROR_CODES, ID_RE } from './lib/schemas.mjs';

const COMMANDS = ['start', 'submit', 'wait', 'salvage'];

function emit(value, code) {
  process.stdout.write(`${JSON.stringify(value)}\n`, () => process.exit(code));
}

const contractError = (reason) => emit({ ok: false, code: 'E_CONTRACT', reason }, 2);
// 拒否の code は閉じた集合（ERROR_CODES）。集合に無い code は CLI の内部の誤りとして返す
const reject = (command, code, reasonText, detail = null) => (ERROR_CODES.includes(code)
  ? emit({ ok: false, command, code, reason: reasonText, detail }, 1)
  : emit({ ok: false, command, code: 'E_INTERNAL', reason: `未知の誤りの code ${code}: ${reasonText}`, detail: null }, 1));

function readStdin() {
  return new Promise((resolve, reject2) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject2);
  });
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (v, keys) => Object.keys(v).every((k) => keys.includes(k));
const nonEmptyString = (v) => typeof v === 'string' && v.length > 0;

// コマンドの入力の形。合わなければ false。
function shapeOk(command, input) {
  if (!isPlain(input)) return false;
  if (command === 'start') return Object.prototype.hasOwnProperty.call(input, 'request') && onlyKeys(input, ['request']);
  if (!nonEmptyString(input.run_dir)) return false;
  if (command === 'wait') return onlyKeys(input, ['run_dir', 'status_seq']) && Number.isSafeInteger(input.status_seq) && input.status_seq >= 0;
  if (command === 'salvage') return onlyKeys(input, ['run_dir']);
  if (command === 'submit') {
    // batch_id は run-daemon が作る Id の形（受け箱の名前に使うので path の成分を持たない）
    if (!nonEmptyString(input.batch_id) || !ID_RE.test(input.batch_id) || !onlyKeys(input, ['run_dir', 'batch_id', 'workflow_output_path', 'timed_out'])) return false;
    const hasPath = 'workflow_output_path' in input;
    const hasTimeout = 'timed_out' in input;
    if (hasPath === hasTimeout) return false;
    return hasPath ? nonEmptyString(input.workflow_output_path) : input.timed_out === true;
  }
  return false;
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'run-daemon') {
    if (argv.length !== 4) process.exit(2);
    await runDaemon({ runId: argv[1], nonce: argv[2], tmpDir: argv[3] });
    return;
  }
  if (argv.length !== 1) { contractError('引数はコマンドの 1 語だけ'); return; }
  const command = argv[0];
  if (!COMMANDS.includes(command)) { contractError(`未知のコマンド: ${command}`); return; }
  const text = await readStdin();
  let input;
  try { input = JSON.parse(text); } catch { contractError('標準入力が JSON でない'); return; }
  if (!shapeOk(command, input)) { reject(command, 'E_INPUT', 'コマンドの入力の形に合わない', { reason: 'shape' }); return; }
  if (command !== 'start' && (!isAbsolute(input.run_dir) || !isDir(input.run_dir))) {
    reject(command, 'E_INPUT', 'run_dir のディレクトリが無い', { reason: 'run_dir_not_found' });
    return;
  }
  let out;
  if (command === 'start') out = await start(input);
  else if (command === 'submit') out = { ok: true, ...submit(input) };
  else if (command === 'wait') out = await wait(input);
  else out = salvage(input.run_dir, { location: locationFromEnv() });
  if (!out.ok) { reject(command, out.code, out.reason, out.detail ?? null); return; }
  const { ok, ...rest } = out;
  emit({ ok: true, command, ...rest }, 0);
}

// 捕まえていない例外も、終了コード 1 と 1 つの JSON で返す（cli-contract.md「誤りと終了コード」の E_INTERNAL）。
main().catch((e) => {
  process.stderr.write(`formal-method-cli: ${e && e.stack ? e.stack : e}\n`);
  const command = COMMANDS.includes(process.argv[2]) && process.argv.length === 3 ? process.argv[2] : null;
  const text = String(e && e.message ? e.message : e).slice(0, 300) || '予期しない誤り';
  emit({ ok: false, command, code: 'E_INTERNAL', reason: `CLI の処理が予期しない誤りで続けられない: ${text}`, detail: null }, 1);
});
