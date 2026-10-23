#!/usr/bin/env node
// 調べるリポジトリを git で読むだけの CLI。git の生の許可は前方一致なので、--output や -O を足すと書き込みやコマンドの実行に化ける。
// 許可はこの CLI だけに出し、書き込み・外部のコマンドの実行に当たる引数を拒否する。
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUBCOMMANDS = ['log', 'show', 'diff', 'blame', 'ls-files', 'grep'];
// 書き込み・外部のコマンドの実行と、リポジトリの外のファイルを読む引数（Read の許可の外を読ませない）。
// git は長い引数の省略形を受け付けるので、名前の頭が一致するものも拒否する。ただし、それ自体が引数の名前と正確に一致するもの（EXACT）は省略形でない。
const DENIED = ['--output', '--output-directory', '--open-files-in-pager', '--ext-diff', '--textconv', '--exec', '--show-signature',
  '--no-index', '--contents', '--orderfile', '--ignore-revs-file', '--pathspec-from-file', '--exclude-from', '--git-dir', '--work-tree'];
const EXACT = ['--text', '--exclude'];
// 短い引数で同じことをするもの（diff・log・show の -O<file>、grep の -O<cmd> と -f <file>、blame の -S <file>、ls-files の -X <file>）。まとめた形（-nO）も拒否する。
const DENIED_SHORT = { log: 'O', show: 'O', diff: 'O', grep: 'Of', blame: 'S', 'ls-files': 'X' };
const NO_EXTERNAL = { log: ['--no-ext-diff', '--no-textconv'], show: ['--no-ext-diff', '--no-textconv'], diff: ['--no-ext-diff', '--no-textconv'], blame: ['--no-textconv'], grep: ['--no-textconv'], 'ls-files': [] };
const MAX_OUTPUT = 1 << 28;
// 読むだけの操作でも、索引の更新（.git/index の書き換え）や、リポジトリの設定による外部のコマンド（fsmonitor・署名の確かめ）が起きるので止める。
const SAFE_CONFIG = ['core.fsmonitor=false', 'diff.autoRefreshIndex=false', 'core.untrackedCache=false', 'log.showSignature=false', 'gpg.program=false', 'gpg.ssh.program=false', 'gpg.x509.program=false'];

function refused(sub, arg) {
  if (typeof arg !== 'string') return '引数は文字列に限る';
  if (arg === '--') return null;
  const name = arg.split('=')[0];
  if (name.startsWith('--') && name.length > 2 && !EXACT.includes(name) && DENIED.some((d) => d.startsWith(name))) return `書き込み・外部のコマンドの実行・リポジトリの外の読み出しに当たる: ${arg}`;
  if (/^-[^-]/.test(arg) && [...DENIED_SHORT[sub]].some((c) => arg.slice(1).includes(c))) return `書き込み・外部のコマンドの実行・リポジトリの外の読み出しに当たる: ${arg}`;
  return null;
}

export function read(sub, { repo, args = [] }) {
  if (!SUBCOMMANDS.includes(sub)) throw new Error(`読むだけの git の操作は ${SUBCOMMANDS.join('・')}: ${sub}`);
  if (typeof repo !== 'string' || !Array.isArray(args)) throw new Error('repo と args（並び）が要る');
  const why = args.map((a) => refused(sub, a)).find(Boolean);
  if (why) throw new Error(why);
  const r = spawnSync('git', [...SAFE_CONFIG.flatMap((c) => ['-c', c]), '-C', repo, sub, ...NO_EXTERNAL[sub], ...args], { encoding: 'utf8', maxBuffer: MAX_OUTPUT, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
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
