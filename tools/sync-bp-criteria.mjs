#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRITERIA_DIR, CRITERIA_FILES } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { CARRY_SUFFIX, carryPathOf, carryShapeOk } from '../plugins/workflow/skills/prd-spec/scripts/doc_check.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = path.join('plugins', 'skill-creator', 'skills', 'skill-creator-best-practices');
const DOCS = 'docs';
const ROOT_DOC = 'specifications/bp-conformance.md';

const DOCS_PATH = /(?<![\w./-])docs\/[\w./*-]*/g;
// URL の中の docs/ は外部のページで、リポジトリの文書ではない。URL を先に除き、前置きの字で見分けない（見分けると「正本:docs/…」を落とす）。
// URL は ASCII の URL の字で終わる（日本語の本文が空白なしで続いても、そこから先を URL に飲み込まない）。
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[\w\-.~:/?#@!$&*+,;=%(]+/gi;
const INLINE_LINK = /\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const LINK_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/gm;
const HTML_LINK = /\bhref\s*=\s*"([^"]+)"/g;
const BARE_NAME = /(?<![\w./-])((?:bp-[\w-]+|skill-design-patterns)\.md)/g;

// 写しの中に残る、写しの外を指す docs/ の参照。ここに無い参照が写しに現れると、配布先で開けない基準を指すことになる。
export const OUTSIDE_COPY = Object.freeze([
  { file: 'specifications/bp-run.md', token: 'docs/', reason: '正本の置き場そのものを指す散文で、判定基準の文書を指さない' },
  { file: 'specifications/bp-run.md', token: 'docs/X', reason: '写しの中の docs/ の読み替えの規則の変数で、文書を指さない' },
  { file: 'requirements/bp-operations.md', token: 'docs/specifications/bp-*.md', reason: 'bp の仕様書の全体を指す glob で、展開した先は全て写しにある' },
  { file: 'design/skill-design-patterns.md', token: 'docs/', reason: '未決事項の検索範囲を述べる散文で、置き場そのものを指し、判定基準の文書を指さない' },
  { file: 'design/skill-design-patterns.md', token: 'docs/specifications', reason: '未決事項の検索範囲を述べる散文で、仕様書の置き場そのものを指す。具体的な文書の名指しは全て写しの中に解ける' },
  { file: 'design/skill-design-patterns.md', token: 'docs/guidelines/testing.md', reason: 'make test の運用手順を持つ文書の名指しで、guidelines は判定基準の写しの集合に入らない' },
  { file: 'specifications/bp-run.md', token: 'docs/guidelines/documentation.md', reason: 'SP-BPRUN-043 の未実装の仕様項目が名指す文書で、実装追従前のため除外' },
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

function linkTarget(raw) {
  const bare = raw.startsWith('<') ? raw.slice(1, -1) : raw;
  try {
    return decodeURI(bare.split('#')[0]);
  } catch {
    return bare.split('#')[0];
  }
}

function references(text, fromRel, names) {
  const out = [];
  const plain = text.replace(URL, ' ');
  for (const m of plain.matchAll(DOCS_PATH)) {
    const token = m[0].replace(/\.+$/, '');
    const unparsed = token.includes('*') || token.endsWith('/');
    out.push({ token, rel: unparsed ? null : token.slice(DOCS.length + 1), unparsed });
  }
  const links = [INLINE_LINK, LINK_DEFINITION, HTML_LINK].flatMap((re) => [...text.matchAll(re)].map((m) => ({ token: m[0].trim(), target: linkTarget(m[1]) })));
  for (const { token, target } of links) {
    if (target === '' || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue;
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), target));
    out.push({ token, rel: inside(rel) ? rel : null, unparsed: target.includes('*') || target.endsWith('/') });
  }
  for (const m of plain.matchAll(BARE_NAME)) {
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

// .tbd.json の字面は JSON の escape（\" と \n）を含むので、Markdown の参照の形で読むには text と candidates を復元した本文で走査する。
// 読めないか形の違う JSON は null を返し、closure が malformed として返す（空の本文として扱うと、text だけが指す文書を黙って落とす）。
function body(file) {
  const raw = readFileSync(file, 'utf8');
  if (!file.endsWith(CARRY_SUFFIX)) return raw;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  return carryShapeOk(data) ? data.tbd.flatMap((t) => [t.text, ...(t.candidates ?? [])]).join('\n') : null;
}

// SP-BPRUN-036 は「bp-conformance が docs/ のパスで参照する全ての文書」なので、直接の参照で閉じる（推移的に辿らない）。
// TBD の text も bp-conformance の一部なので、隣の .tbd.json の参照も同じに数える。
export function closure(root = REPO_ROOT) {
  const files = docsFiles(root);
  const present = new Set(files);
  const names = nameIndex(files);
  const problems = [];
  const set = new Set([ROOT_DOC, ...Object.values(CRITERIA_FILES).map((parts) => parts.join('/'))]);
  for (const from of [ROOT_DOC, carryPathOf(ROOT_DOC)]) {
    if (from !== ROOT_DOC && !present.has(from)) continue;
    const text = body(path.join(root, DOCS, from));
    if (text === null) continue;
    for (const r of references(text, from, names)) {
      if (r.unparsed) problems.push({ kind: 'unparsed', path: from, detail: r.token });
      else if (r.rel === null || !present.has(r.rel)) problems.push({ kind: 'unclosed', path: from, detail: r.token });
      else set.add(r.rel);
    }
  }
  // 開いた TBD の正本は文書の隣にある（prd-spec の規約）。写しに無いと、配布先で本文の TBD ID の定義を読めない。
  for (const rel of [...set]) if (rel.endsWith('.md') && present.has(carryPathOf(rel))) set.add(carryPathOf(rel));
  for (const rel of set) if (rel.endsWith(CARRY_SUFFIX) && body(path.join(root, DOCS, rel)) === null) problems.push({ kind: 'malformed', path: rel });
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

// 写しの置き場までの途中に symlink か通常のファイルがあると、配布先（Codex は symlink を落とす）で写しが空になる。リポジトリからの相対パスで返す。
function linkedAncestors(root) {
  const parts = path.relative(root, copyRoot(root)).split(path.sep);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/')).filter((rel) => {
    const st = lstatOrNull(path.join(root, rel));
    return st !== null && !st.isDirectory();
  });
}

// 置き場の中を辿る。symlink は辿らずに別に返す（辿ると、symlink の先の正本を写しと読む）。
function copyEntries(root) {
  const base = copyRoot(root);
  const files = [];
  const links = [];
  const walk = (rel) => {
    for (const e of readdirSync(path.join(base, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) links.push(r);
      else if (e.isDirectory()) walk(r);
      else files.push(r);
    }
  };
  if (lstatOrNull(base)?.isDirectory()) walk('');
  return { files, links };
}

export function check(root = REPO_ROOT) {
  const { files, problems } = closure(root);
  const above = linkedAncestors(root);
  if (above.length) return [...problems, ...above.map((rel) => ({ kind: 'symlink', path: rel }))];
  const out = [...problems];
  const wanted = new Set(files);
  const entries = copyEntries(root);
  const linkedDirs = entries.links.filter((l) => files.some((f) => f.startsWith(`${l}/`)));
  for (const l of entries.links) out.push({ kind: 'symlink', path: l });
  for (const rel of files) {
    if (linkedDirs.some((l) => rel.startsWith(`${l}/`))) continue;
    const dest = path.join(copyRoot(root), rel);
    const st = lstatOrNull(dest);
    if (st === null) out.push({ kind: 'missing', path: rel });
    else if (st.isSymbolicLink()) continue;
    else if (!st.isFile()) out.push({ kind: 'symlink', path: rel });
    else if (sha(dest) !== sha(path.join(root, DOCS, rel))) out.push({ kind: 'differ', path: rel });
  }
  for (const rel of entries.files) if (!wanted.has(rel)) out.push({ kind: 'extra', path: rel });
  return out;
}

export function outside(root = REPO_ROOT) {
  const { files } = closure(root);
  const copied = new Set(files);
  const names = nameIndex(docsFiles(root));
  const seen = new Map();
  for (const rel of files) {
    const dest = path.join(copyRoot(root), rel);
    const text = lstatOrNull(dest)?.isFile() ? body(dest) : null;
    if (text === null) continue;
    for (const r of references(text, rel, names)) {
      if (r.rel !== null && !r.unparsed && copied.has(r.rel)) continue;
      seen.set(`${rel}\0${r.token}`, { file: rel, token: r.token });
    }
  }
  return [...seen.values()];
}

// 写しの中の、docs/ 以外のリポジトリの最上位のディレクトリから始まる相対パスと、根のファイルの名指し（配布先では開けない出所の引用）。
// top はディレクトリなら末尾に / を付けた名前、根のファイルならファイル名。
export function repoPaths(root = REPO_ROOT) {
  const entries = readdirSync(root, { withFileTypes: true }).filter((d) => ![DOCS, '.git', 'node_modules'].includes(d.name));
  const escape = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dirs = entries.filter((d) => d.isDirectory()).map((d) => escape(d.name));
  const files = entries.filter((d) => d.isFile()).map((d) => escape(d.name));
  // ./ と ../ で始まる相対の書き方も、根から数えたパスとして拾う。
  const lead = '(?<![\\w./-])(?:\\.{1,2}/)*';
  const dirRe = new RegExp(`${lead}(${dirs.join('|')})/[\\w./<>*-]*`, 'g');
  const fileRe = new RegExp(`${lead}(${files.join('|')})(?![\\w/-])`, 'g');
  const out = [];
  for (const rel of closure(root).files) {
    const dest = path.join(copyRoot(root), rel);
    const raw = lstatOrNull(dest)?.isFile() ? body(dest) : null;
    if (raw === null) continue;
    const text = raw.replace(URL, ' ');
    for (const m of text.matchAll(dirRe)) out.push({ file: rel, token: m[0], top: `${m[1]}/` });
    for (const m of text.matchAll(fileRe)) out.push({ file: rel, token: m[0], top: m[1] });
  }
  return out;
}

function removeEmptyDirs(dir, stop) {
  if (dir === stop || !lstatOrNull(dir)?.isDirectory()) return;
  if (readdirSync(dir).length === 0) {
    rmdirSync(dir);
    removeEmptyDirs(path.dirname(dir), stop);
  }
}

// 置き場より上の symlink は置き場の外のファイル（references の他の文書など）を巻き込むので、書かずに知らせる。置き場とその中の symlink は消して作り直す。
function write(root) {
  const { files, problems } = closure(root);
  if (problems.length) return problems;
  const base = copyRoot(root);
  const above = linkedAncestors(root).filter((rel) => path.join(root, rel) !== base);
  if (above.length) return above.map((rel) => ({ kind: 'symlink', path: rel }));
  if (lstatOrNull(base) && !lstatOrNull(base).isDirectory()) unlinkSync(base);
  const wanted = new Set(files);
  const entries = copyEntries(root);
  for (const rel of entries.links) unlinkSync(path.join(base, rel));
  for (const rel of entries.files) {
    if (wanted.has(rel)) continue;
    rmSync(path.join(base, rel));
    removeEmptyDirs(path.dirname(path.join(base, rel)), base);
  }
  for (const rel of files) {
    const dest = path.join(base, rel);
    if (lstatOrNull(dest) && !lstatOrNull(dest).isFile()) rmSync(dest, { recursive: true });
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(root, DOCS, rel), dest);
  }
  return [];
}

function line(p) {
  return `${p.kind} ${p.path}${p.detail ? ` ${p.detail}` : ''}`;
}

export function main(argv) {
  let root = REPO_ROOT;
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
