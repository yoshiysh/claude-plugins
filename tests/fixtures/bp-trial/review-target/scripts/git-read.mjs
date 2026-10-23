#!/usr/bin/env node
// 調べるリポジトリを git で読むだけの CLI。git の生の許可は前方一致なので、引数を足すと書き込み・コマンドの実行・リポジトリの外の読み出しに化ける。
// 許可はこの CLI だけに出し、操作ごとに受け付ける引数の一覧に無い引数は全て拒否する（拒否する引数の一覧では、載せ忘れた引数がすり抜ける）。
import { lstatSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './git-safe.mjs';

const DIFF_FLAGS = ['--patch', '--no-patch', '--raw', '--stat', '--numstat', '--shortstat', '--summary', '--name-only', '--name-status', '--text',
  '--ignore-all-space', '--ignore-space-change', '--ignore-blank-lines', '--no-renames', '--full-index', '--word-diff', '--minimal', '--patience',
  '--histogram', '--abbrev', '--no-abbrev', '--color', '--no-color', '--find-renames', '--find-copies', '--unified'];
const DIFF_VALUED = ['--diff-filter'];
const LOG_FLAGS = ['--oneline', '--graph', '--all', '--branches', '--tags', '--decorate', '--no-decorate', '--no-merges', '--merges', '--first-parent',
  '--reverse', '--follow', '--full-history', '--date-order', '--topo-order', '--left-right', '--boundary', '--source', '--regexp-ignore-case', '--all-match',
  '--extended-regexp', '--fixed-strings', '--format', '--pretty'];
const LOG_VALUED = ['--max-count', '--skip', '--since', '--after', '--until', '--before', '--author', '--committer', '--grep', '--date'];
// 長い引数は名前の正確な一致だけを受け付ける（git は省略形も受け付けるが、ここでは省略形を一覧の外として拒否する）。
// flags は値を取らないか、--name=値 の形でだけ値を取る（--unified・--format・--pretty・--stat など。git は次の引数を値に読まない）。
// valued は --name=値 か、次の引数を値として読む（git が次の引数を値に読むものだけ）。値は位置の引数として照らさない。
// 短い引数はまとめて書けるので 1 文字ずつ読む。value は次の文字以降か次の引数を値として取り、attached は続く文字だけを値として取る
// （値を省略できる -U・-M・-C・-B。-U の次の引数を値と読むと、git がパスとして読む引数を照らさずに通してしまう）。
// unbundled の操作（log・show・diff）は値を取る短い引数を束ねて読まないので、束ねた形（-pn）は拒否する（値と読むと、次の引数を照らさずに通す）。
const GRAMMAR = {
  log: { flags: [...DIFF_FLAGS, ...LOG_FLAGS], valued: [...DIFF_VALUED, ...LOG_VALUED], short: 'puswbRaziEF', value: 'nSGL', attached: 'UMC', count: true, unbundled: true },
  show: { flags: [...DIFF_FLAGS, '--oneline', '--format', '--pretty'], valued: [...DIFF_VALUED, '--date'], short: 'puswbRaz', value: 'SG', attached: 'UMC', unbundled: true },
  diff: { flags: [...DIFF_FLAGS, '--cached', '--staged'], valued: DIFF_VALUED, short: 'puswbRaz', value: 'SG', attached: 'UMCB', unbundled: true },
  blame: { flags: ['--porcelain', '--line-porcelain', '--root', '--show-email', '--show-name', '--show-number'], valued: ['--date'], short: 'wesltfnpc', value: 'L', attached: 'MC' },
  'ls-files': { flags: ['--cached', '--deleted', '--modified', '--others', '--ignored', '--stage', '--unmerged', '--killed', '--directory', '--no-empty-directory', '--exclude-standard', '--full-name', '--error-unmatch'],
    valued: ['--exclude'], short: 'cdmoisukzt', value: 'x', attached: '' },
  grep: { flags: ['--cached', '--untracked', '--and', '--or', '--not', '--all-match', '--heading', '--break', '--line-number', '--ignore-case', '--word-regexp',
    '--invert-match', '--files-with-matches', '--files-without-match', '--count', '--extended-regexp', '--fixed-strings', '--perl-regexp', '--only-matching',
    '--quiet', '--function-context', '--column', '--full-name'],
  valued: ['--max-depth', '--context', '--after-context', '--before-context', '--max-count'], short: 'niwvlLchHEFPGIoqWpz', value: 'eABCm', attached: '', count: true },
};
const NO_EXTERNAL = { log: ['--no-ext-diff', '--no-textconv'], show: ['--no-ext-diff', '--no-textconv'], diff: ['--no-ext-diff', '--no-textconv'], blame: ['--no-textconv'], grep: ['--no-textconv'], 'ls-files': [] };

const within = (root, p) => { const rel = path.relative(root, p); return !rel.startsWith('..') && !path.isAbsolute(rel); };
const realOr = (p) => { try { return realpathSync(p); } catch { return null; } };

// パスがリポジトリの外の在るものに当たるか。git はパスを字面で畳んでから扱うことがあり、OS は要素ごとに symlink を解決してから .. を辿るので、両方で照らす
// （字面だけで畳むと、中の外を指す symlink を lnk/../x と辿るパスがすり抜ける）。途中に無い要素があれば、OS ではその先を読めない。
function escapes(root, p) {
  const lexical = path.resolve(root, p);
  if (!within(root, lexical) && existsSync(lexical)) return true;
  let cur = path.isAbsolute(p) ? '/' : root;
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { cur = path.dirname(cur); continue; }
    const next = path.join(cur, part);
    let st;
    try { st = lstatSync(next); } catch { return false; }
    cur = st.isSymbolicLink() ? realOr(next) ?? next : next;
  }
  return !within(root, realOr(cur) ?? cur);
}

// 引数を操作の文法で読み、拒否する理由を返す。grep で -e が無いときの最初の位置の引数はパターンで、パスとして照らさない。
// ただし、パターンの式（--and・--or・--not・( ・)）があれば、git は位置の引数をパターンと読まないので、全てパスとして照らす。
function refusal(sub, root, args) {
  const g = GRAMMAR[sub];
  const notListed = (arg) => `受け付ける引数の一覧に無い（書き込み・外部のコマンドの実行・リポジトリの外の読み出しを防ぐため、一覧の引数だけを受け付ける）: ${arg}`;
  let value = false;
  let paths = false;
  let pattern = sub === 'grep' && !args.some((a) => a === '-e' || /^-[^-]*e/.test(a) || ['--and', '--or', '--not', '(', ')'].includes(a));
  for (const arg of args) {
    if (typeof arg !== 'string') return '引数は文字列に限る';
    if (value) { value = false; continue; }
    if (paths || !arg.startsWith('-') || arg === '-') {
      if (pattern && !paths) { pattern = false; continue; }
      if (escapes(root, arg)) return `リポジトリの外のパスに当たる: ${arg}`;
      continue;
    }
    if (arg === '--') { paths = true; continue; }
    if (arg.startsWith('--')) {
      const [name, ...rest] = arg.split('=');
      if (g.valued.includes(name)) { value = rest.length === 0; continue; }
      if (g.flags.includes(name)) continue;
      return notListed(arg);
    }
    if (g.count && /^-\d+$/.test(arg)) continue;
    for (let k = 1; k < arg.length; k += 1) {
      const c = arg[k];
      if (g.value.includes(c)) {
        if (g.unbundled && k > 1) return notListed(arg);
        value = k === arg.length - 1;
        break;
      }
      if (g.attached.includes(c)) break;
      if (!g.short.includes(c)) return notListed(arg);
    }
  }
  return null;
}

export function read(sub, { repo, args = [] }) {
  if (!Object.hasOwn(GRAMMAR, sub)) throw new Error(`読むだけの git の操作は ${Object.keys(GRAMMAR).join('・')}: ${sub}`);
  if (typeof repo !== 'string' || !Array.isArray(args)) throw new Error('repo と args（並び）が要る');
  const why = refusal(sub, realpathSync(repo), args);
  if (why) throw new Error(why);
  return git(repo, [sub, ...NO_EXTERNAL[sub], ...args]);
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
