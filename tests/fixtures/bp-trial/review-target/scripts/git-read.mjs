#!/usr/bin/env node
// 調べるリポジトリを git で読むだけの CLI。git の生の許可は前方一致なので、--output や -O を足すと書き込みやコマンドの実行に化ける。
// 許可はこの CLI だけに出し、書き込み・外部のコマンドの実行に当たる引数を拒否する。
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUBCOMMANDS = ['log', 'show', 'diff', 'blame', 'ls-files', 'grep'];
// 書き込み・外部のコマンドの実行・リポジトリの外の読み出しに当たる引数。git は長い引数の省略形を受け付けるので、名前の頭が一致するものも同じに扱う。
// ただし、それ自体が引数の名前と正確に一致するもの（EXACT）は省略形でない。
const DENIED = ['--output', '--output-directory', '--open-files-in-pager', '--ext-diff', '--textconv', '--exec', '--show-signature', '--no-index', '--git-dir', '--work-tree'];
// ファイルを読む引数は、その値のパスがリポジトリの外に解決するときだけ拒否する（Read の許可の外を読ませない）。
const FILE_LONG = ['--contents', '--orderfile', '--ignore-revs-file', '--pathspec-from-file', '--exclude-from', '--file'];
const EXACT = ['--text', '--exclude'];
// 短い引数はまとめて書ける（-nO）ので 1 文字ずつ読み、値を取る短い引数の後ろはその値として読む（-SOldName の O は値で、引数でない）。
// grep の -O は外部のコマンドの実行なので拒否する。ファイルを読む短い引数（-O<file>・-f・-S・-X）は値のパスを照らす。
const DENIED_SHORT = { log: '', show: '', diff: '', grep: 'O', blame: '', 'ls-files': '' };
const FILE_SHORT = { log: 'O', show: 'O', diff: 'O', grep: 'f', blame: 'S', 'ls-files': 'X' };
const VALUED_SHORT = { log: 'nSGLO', show: 'SGO', diff: 'SGO', grep: 'efABCm', blame: 'LS', 'ls-files': 'xX' };
const NO_EXTERNAL = { log: ['--no-ext-diff', '--no-textconv'], show: ['--no-ext-diff', '--no-textconv'], diff: ['--no-ext-diff', '--no-textconv'], blame: ['--no-textconv'], grep: ['--no-textconv'], 'ls-files': [] };
const MAX_OUTPUT = 1 << 28;
// 読むだけの操作でも、索引の更新（.git/index の書き換え）や、リポジトリの設定による外部のコマンド（fsmonitor・署名の確かめ）が起きるので止める。
const SAFE_CONFIG = ['core.fsmonitor=false', 'diff.autoRefreshIndex=false', 'core.untrackedCache=false', 'log.showSignature=false', 'gpg.program=false', 'gpg.ssh.program=false', 'gpg.x509.program=false'];

const DENY = (arg) => `書き込み・外部のコマンドの実行・リポジトリの外の読み出しに当たる: ${arg}`;
const within = (root, p) => { const rel = path.relative(root, p); return !rel.startsWith('..') && !path.isAbsolute(rel); };

// 引数を git の文法どおりに読み、拒否する理由を返す。位置の引数（パスや版）とファイルを読む引数の値は、在るパスに解決して
// リポジトリの外を指せば拒否する（diff は作業ツリーの外のパスを渡されると、暗黙に --no-index で外のファイルを読む）。
function refusal(sub, root, args) {
  const outside = (p) => {
    let real = null;
    try { real = realpathSync(path.resolve(root, p)); } catch {}
    return real !== null && !within(root, real);
  };
  let next = null;
  for (const arg of args) {
    if (typeof arg !== 'string') return '引数は文字列に限る';
    if (next !== null) {
      if (next === 'file' && outside(arg)) return `リポジトリの外のパスに当たる: ${arg}`;
      next = null;
      continue;
    }
    if (arg === '--') continue;
    if (arg.startsWith('--')) {
      const [name, ...rest] = arg.split('=');
      const of = (list) => name.length > 2 && !EXACT.includes(name) && list.some((d) => d.startsWith(name));
      if (of(DENIED)) return DENY(arg);
      if (of(FILE_LONG)) {
        if (!rest.length) next = 'file';
        else if (outside(rest.join('='))) return `リポジトリの外のパスに当たる: ${arg}`;
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let k = 1; k < arg.length; k += 1) {
        if (DENIED_SHORT[sub].includes(arg[k])) return DENY(arg);
        if (!VALUED_SHORT[sub].includes(arg[k])) continue;
        const kind = FILE_SHORT[sub].includes(arg[k]) ? 'file' : 'value';
        if (k === arg.length - 1) next = kind;
        else if (kind === 'file' && outside(arg.slice(k + 1))) return `リポジトリの外のパスに当たる: ${arg}`;
        break;
      }
      continue;
    }
    if (outside(arg)) return `リポジトリの外のパスに当たる: ${arg}`;
  }
  return null;
}

export function read(sub, { repo, args = [] }) {
  if (!SUBCOMMANDS.includes(sub)) throw new Error(`読むだけの git の操作は ${SUBCOMMANDS.join('・')}: ${sub}`);
  if (typeof repo !== 'string' || !Array.isArray(args)) throw new Error('repo と args（並び）が要る');
  const why = refusal(sub, realpathSync(repo), args);
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
