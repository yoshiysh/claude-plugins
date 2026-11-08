#!/usr/bin/env node
// テスト用の偽の z3。cli-contract.md「Z3 の adapter」の実測の表どおりに出力と終了コードを返す。
// CLI が渡す option は -in・-T:<秒>・-version だけ。振る舞いは query の中の指示か、PATH に置く wrapper の --fake-* で決める。
//   query の指示（行の形 `; fake-<名前>: <値>`。最初に現れた行を使う）
//     result: sat | unsat | unknown | timeout | その他の文字列（そのまま 1 行書く。読めない出力になる）
//     mode:   answer（既定） | syntax-error | oom | crash | empty | multi
//     sleep-ms: 応答までの遅延。-T の秒を超えると、その時点で `timeout` を返す（道具自身の時間の上限）
//     exit:   答えを返した後の終了コード（既定 0）
//   wrapper の引数（make-fake-bin.mjs が付ける。CLI は付けない）
//     --fake-mode=always-unsat  query の指示によらず unsat を返す（常に成功を返す道具）
//     --fake-log=<path>         呼出しごとに JSON の行を追記する（受け取った引数、環境変数の名前、時刻、query の指紋）
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const raw = process.argv.slice(2);
const own = Object.fromEntries(raw.filter((a) => a.startsWith('--fake-')).map((a) => {
  const i = a.indexOf('=');
  return [a.slice(7, i < 0 ? undefined : i), i < 0 ? true : a.slice(i + 1)];
}));
const args = raw.filter((a) => !a.startsWith('--fake-'));
const started = Date.now();

function log(extra) {
  if (!own.log) return;
  appendFileSync(own.log, `${JSON.stringify({
    pid: process.pid, ppid: process.ppid, args, env_keys: Object.keys(process.env).sort(),
    started_ms: started, at_ms: Date.now(), ...extra,
  })}\n`);
}

if (args.includes('-version')) {
  log({ kind: 'version' });
  process.stdout.write('Z3 version 5.3.3 - 64 bit\n');
  process.exit(0);
}

const tArg = args.find((a) => a.startsWith('-T:'));
const limitMs = tArg ? Number(tArg.slice(3)) * 1000 : Infinity;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const pick = (name) => {
    const m = input.match(new RegExp(`^\\s*; fake-${name}: (.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  const query_sha256 = createHash('sha256').update(input).digest('hex');
  const always = own.mode === 'always-unsat';
  const mode = always ? 'answer' : (pick('mode') ?? 'answer');
  const result = always ? 'unsat' : (pick('result') ?? 'unsat');
  const sleep = Number(pick('sleep-ms') ?? 0);
  const exitCode = Number(pick('exit') ?? 0);
  const timedOut = sleep > limitMs;
  log({ kind: 'query-start', query_sha256, mode, result, sleep_ms: sleep });
  setTimeout(() => {
    log({ kind: 'query-end', query_sha256, mode, result: timedOut ? 'timeout' : result });
    if (timedOut) { process.stdout.write('timeout\n'); process.exit(0); }
    switch (mode) {
      case 'syntax-error':
        process.stdout.write('(error "line 1 column 1: invalid command, symbol expected")\n');
        process.exit(1);
        break;
      case 'oom':
        process.stderr.write('(error "out of memory")\n');
        process.exit(101);
        break;
      case 'crash':
        process.exit(exitCode === 0 ? 3 : exitCode);
        break;
      case 'empty':
        process.exit(0);
        break;
      case 'multi':
        process.stdout.write('sat\nunsat\n');
        process.exit(0);
        break;
      default:
        process.stdout.write(`${result}\n`);
        process.exit(exitCode);
    }
  }, timedOut ? limitMs : sleep);
});
