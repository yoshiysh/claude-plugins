#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRITERIA_DIR, CRITERIA_FILES } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = path.join('plugins', 'skill-creator', 'skills', 'skill-creator-best-practices');
const DOCS = 'docs';
const ROOT_DOC = 'specifications/bp-conformance.md';

const DOCS_PATH = /(?<![\w./-])docs\/[\w./*-]*/g;
const RELATIVE_LINK = /\]\(([^)\s]+)\)/g;
const BARE_NAME = /(?<![\w./-])((?:bp-[a-z-]+|skill-design-patterns)\.md)/g;

// 写しの中に残る、写しの外を指す docs/ の参照。ここに無い参照が写しに現れると、配布先で開けない基準を指すことになる。
export const OUTSIDE_COPY = Object.freeze([
  { file: 'specifications/bp-run.md', token: 'docs/', reason: '正本の置き場そのものを指す散文で、判定基準の文書を指さない' },
  { file: 'requirements/bp-operations.md', token: 'docs/specifications/bp-*.md', reason: 'bp の仕様書の全体を指す glob で、展開した先は全て写しにある' },
]);

const EXIT = Object.freeze({ ok: 0, mismatch: 1, usage: 2 });

function docsFiles(root) {
  const base = path.join(root, DOCS);
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(path.join(base, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  if (existsSync(base)) walk('');
  return out;
}

function inside(rel) {
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 本文の参照を 3 つの形で抜き、docs/ からの相対パスに解く。解けない形は呼び出し側が失敗か範囲の外として扱う。
function references(text, fromRel, names) {
  const out = [];
  for (const m of text.matchAll(DOCS_PATH)) {
    const token = m[0].replace(/\.+$/, '');
    const unparsed = token.includes('*') || token.endsWith('/');
    out.push({ token, rel: unparsed ? null : token.slice(DOCS.length + 1), unparsed });
  }
  for (const m of text.matchAll(RELATIVE_LINK)) {
    const target = m[1].split('#')[0];
    if (target === '' || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue;
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), target));
    out.push({ token: `](${m[1]})`, rel: inside(rel) ? rel : null, unparsed: target.includes('*') || target.endsWith('/') });
  }
  for (const m of text.matchAll(BARE_NAME)) {
    const hits = names.get(m[1]) ?? [];
    out.push({ token: m[1], rel: hits.length === 1 ? hits[0] : null, unparsed: false });
  }
  return out;
}

function nameIndex(files) {
  const names = new Map();
  for (const f of files) names.set(path.posix.basename(f), [...(names.get(path.posix.basename(f)) ?? []), f]);
  return names;
}

// SP-BPRUN-036 は「bp-conformance が docs/ のパスで参照する全ての文書」なので、直接の参照で閉じる（推移的に辿らない）。
export function closure(root = REPO_ROOT) {
  const files = docsFiles(root);
  const present = new Set(files);
  const problems = [];
  const set = new Set([ROOT_DOC, ...Object.values(CRITERIA_FILES).map((parts) => parts.join('/'))]);
  const text = readFileSync(path.join(root, DOCS, ROOT_DOC), 'utf8');
  for (const r of references(text, ROOT_DOC, nameIndex(files))) {
    if (r.unparsed) problems.push({ kind: 'unparsed', path: ROOT_DOC, detail: r.token });
    else if (r.rel === null || !present.has(r.rel)) problems.push({ kind: 'unclosed', path: ROOT_DOC, detail: r.token });
    else set.add(r.rel);
  }
  return { files: [...set].sort(), problems };
}

function copyRoot(root) {
  return path.join(root, SKILL, CRITERIA_DIR);
}

function sha(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function copyEntries(root) {
  const base = copyRoot(root);
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(path.join(base, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  if (lstatOrNull(base)?.isDirectory()) walk('');
  return out;
}

export function check(root = REPO_ROOT) {
  const { files, problems } = closure(root);
  const out = [...problems];
  const wanted = new Set(files);
  for (const rel of files) {
    const dest = path.join(copyRoot(root), rel);
    const st = lstatOrNull(dest);
    if (st === null) out.push({ kind: 'missing', path: rel });
    else if (!st.isFile()) out.push({ kind: 'symlink', path: rel });
    else if (sha(dest) !== sha(path.join(root, DOCS, rel))) out.push({ kind: 'differ', path: rel });
  }
  for (const rel of copyEntries(root)) if (!wanted.has(rel)) out.push({ kind: 'extra', path: rel });
  return out;
}

// 写しの中で、写しの集合の外を指す docs/ の参照を全て返す（写しを読んだ agent がそこへ届けない参照）。
export function outside(root = REPO_ROOT) {
  const { files } = closure(root);
  const copied = new Set(files);
  const names = nameIndex(docsFiles(root));
  const seen = new Map();
  for (const rel of files) {
    const dest = path.join(copyRoot(root), rel);
    if (!lstatOrNull(dest)?.isFile()) continue;
    for (const r of references(readFileSync(dest, 'utf8'), rel, names)) {
      if (r.rel !== null && !r.unparsed && copied.has(r.rel)) continue;
      seen.set(`${rel}\0${r.token}`, { file: rel, token: r.token });
    }
  }
  return [...seen.values()];
}

function removeEmptyDirs(dir, stop) {
  if (dir === stop || !lstatOrNull(dir)?.isDirectory()) return;
  if (readdirSync(dir).length === 0) {
    rmdirSync(dir);
    removeEmptyDirs(path.dirname(dir), stop);
  }
}

function write(root) {
  const { files, problems } = closure(root);
  if (problems.length) return problems;
  const base = copyRoot(root);
  const wanted = new Set(files);
  for (const rel of copyEntries(root)) {
    if (wanted.has(rel)) continue;
    unlinkSync(path.join(base, rel));
    removeEmptyDirs(path.dirname(path.join(base, rel)), base);
  }
  for (const rel of files) {
    const dest = path.join(base, rel);
    if (lstatOrNull(dest) && !lstatOrNull(dest).isFile()) unlinkSync(dest);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(root, DOCS, rel), dest);
  }
  return [];
}

function line(p) {
  return `${p.kind} ${p.path}${p.detail ? ` ${p.detail}` : ''}`;
}

export function main(argv, { root: given } = {}) {
  let root = given ?? REPO_ROOT;
  let mode = 'write';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check') mode = 'check';
    else if (argv[i] === '--root' && argv[i + 1]) root = path.resolve(argv[(i += 1)]);
    else return { exitCode: EXIT.usage, lines: [`使い方: node tools/sync-bp-criteria.mjs [--check] [--root <dir>]（不明な引数: ${argv[i]}）`] };
  }
  const found = mode === 'check' ? check(root) : write(root);
  return { exitCode: found.length ? EXIT.mismatch : EXIT.ok, lines: found.map(line) };
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const { exitCode, lines } = main(process.argv.slice(2));
  for (const l of lines) process.stdout.write(`${l}\n`);
  process.exitCode = exitCode;
}
