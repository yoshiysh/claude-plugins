#!/usr/bin/env node
// 調べるリポジトリを git で読むだけの CLI。git の生の許可は前方一致なので、--output や -O を足すと書き込みやコマンドの実行に化ける。
// 許可はこの CLI だけに出し、書き込み・外部のコマンドの実行に当たる引数を拒否する。
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUBCOMMANDS = ['log', 'show', 'diff', 'blame', 'ls-files', 'grep'];
// git は長い引数の省略形を受け付けるので、名前の頭が一致するものも拒否する。
const WRITES = ['--output', '--output-directory', '--open-files-in-pager', '--ext-diff', '--textconv', '--exec'];
const NO_EXTERNAL = { log: ['--no-ext-diff', '--no-textconv'], show: ['--no-ext-diff', '--no-textconv'], diff: ['--no-ext-diff', '--no-textconv'], blame: ['--no-textconv'], grep: ['--no-textconv'], 'ls-files': [] };
const MAX_OUTPUT = 1 << 28;

function refused(sub, arg) {
  if (typeof arg !== 'string') return '引数は文字列に限る';
  if (arg === '--') return null;
  const name = arg.split('=')[0];
  if (name.startsWith('--') && name.length > 2 && WRITES.some((w) => w.startsWith(name))) return `書き込みか外部のコマンドの実行に当たる: ${arg}`;
  if (sub === 'grep' && /^-[^-]*O/.test(arg)) return `外部のコマンドの実行に当たる: ${arg}`;
  return null;
}

export function read(sub, { repo, args = [] }) {
  if (!SUBCOMMANDS.includes(sub)) throw new Error(`読むだけの git の操作は ${SUBCOMMANDS.join('・')}: ${sub}`);
  if (typeof repo !== 'string' || !Array.isArray(args)) throw new Error('repo と args（並び）が要る');
  const why = args.map((a) => refused(sub, a)).find(Boolean);
  if (why) throw new Error(why);
  const r = spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', repo, sub, ...NO_EXTERNAL[sub], ...args], { encoding: 'utf8', maxBuffer: MAX_OUTPUT });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try {
    process.stdout.write(`${JSON.stringify({ ok: true, ...read(process.argv[2], JSON.parse(Buffer.concat(chunks).toString('utf8'))) })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: error.message })}\n`);
    process.exitCode = 2;
  }
}
