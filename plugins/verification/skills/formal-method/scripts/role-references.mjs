// 役ごとの義務と型の抜粋を、正本から決定的に作る（生成物。直さずに正本を直して流し直す）。
//   node scripts/role-references.mjs          生成物を書く
//   node scripts/role-references.mjs --check  生成物が正本から作ったものと違えば 1 で終える（書かない）
// 正本: 義務は references/agent-obligations.md、型は references/artifact-formats.md。生成物は claim の Task の instructions が指す
// references/obligations/<author|confirmer>.md と references/types/<role>.md。一致は role-references.test.mjs が照らす（make check）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTHOR_ROLES, CONFIRMER_ROLES, OBLIGATIONS_SOURCE, OBLIGATION_FILES, TYPES_DIR } from './lib/roles.mjs';

export { OBLIGATION_FILES, TYPES_DIR };
const TYPES_SOURCE = 'references/artifact-formats.md';

// ---- 型の抜粋の選び方 ----
// 役ごとの入口の型（その役が書く型と読む型）だけを手で挙げ、残りは正本から導く。
//   定義: artifact-formats.md の ```text の塊の、行頭の「<名前> =」から、次の行頭の定義か塊の終わりまで。
//   参照: 定義の行の、注釈（// の後）と文字列（"..."）を除いた部分に現れる、定義のある名前。入口から推移的に辿った全ての型の定義を入れる。
//   節: 書く型（writes）を定義する節は、文も含めて全て入れる（その中の型の塊は、辿った型の定義だけに絞る）。読む型（reads）と辿った型は、
//       定義だけを、その定義のある節の見出しの下に入れる。全て入れた節の上位の節（文書の題を除く）で、見出しの直下に型の定義を持たないもの
//       （担当の成果物の前置き）は、下の節の前置きとして入れる。
//   作業記録は全ての役が書くので書く型、claim の Task と受け付けた依頼（request.json）は全ての役が読むので読む型に入れる。
// 入口の型の名前が正本に無ければ生成を止める（正本の改名を見落とさない）。
const COMMON_ENTRY = { writes: ['Worklog'], reads: ['Task', 'Request', 'fixed'] };
export const ROLE_ENTRY_TYPES = Object.freeze({
  extractor: { writes: ['AuthorReturn', 'Inventory'], reads: ['Manifest'] },
  'model-author': { writes: ['AuthorReturn', 'ModelFile', 'MappingFile'], reads: ['Inventory', 'Manifest'] },
  'partition-author': { writes: ['AuthorReturn', 'PartitionsFile', 'Decomposition'], reads: ['ModelFile', 'MappingFile'] },
  'plan-author': { writes: ['AuthorReturn', 'PlanFile', 'MutationsFile'], reads: ['ModelFile', 'MappingFile', 'PartitionsFile', 'Inventory'] },
  'extraction-reviewer': { writes: ['ReviewReturn'], reads: ['Inventory', 'Manifest'] },
  'fidelity-reviewer': { writes: ['ReviewReturn'], reads: ['ModelFile', 'MappingFile', 'Judgment', 'End'] },
  'assurance-reviewer': { writes: ['ReviewReturn'], reads: ['Inventory'] },
  'composition-reviewer': { writes: ['ReviewReturn'], reads: ['PartitionsFile', 'Decomposition', 'ModelFile', 'End'] },
  'cause-analyst': { writes: ['CauseReturn'], reads: ['Cause', 'ModelFile', 'MappingFile', 'End'] },
});
export const entryTypesOf = (role) => {
  const r = ROLE_ENTRY_TYPES[role];
  return { writes: [...COMMON_ENTRY.writes, ...r.writes], reads: [...COMMON_ENTRY.reads, ...r.reads] };
};

// ---- 義務の分け方 ----
// agent-obligations.md の ## の節は、見出しの次の行が <!-- 対象: author --> か <!-- 対象: confirmer --> ならその分だけに入れ、無ければ両方に入れる。
// 目次は入れない（短いファイルなので要らず、外した節を指すリンクが残る）。
const AUDIENCE_RE = /^<!-- 対象: (author|confirmer) -->$/;
const TITLES = { author: '担当の義務（作成役）', confirmer: '担当の義務（確認役・原因の分類役）' };
const ROLES_OF = { author: AUTHOR_ROLES, confirmer: CONFIRMER_ROLES };

const headingOf = (line) => { const m = /^(#{1,6}) (.+)$/.exec(line); return m ? { level: m[1].length, text: m[2] } : null; };

// 置き場が 1 つ深くなるので、相対のリンクを生成物の置き場から解ける形に直す。#だけのリンクは正本の見出しを指す
function relink(text, source) {
  const base = source.split('/').pop();
  return text.replace(/\]\(([^)\s]+)\)/g, (all, target) => {
    if (/^[a-z]+:/i.test(target) || target.startsWith('/')) return all;
    if (target.startsWith('#')) return `](../${base}${target})`;
    return `](../${target})`;
  });
}

// 行の並びを、コードの塊の中を見出しと取り違えずに、見出しの位置と階層に分ける
function headings(lines) {
  const out = [];
  let fence = false;
  lines.forEach((line, i) => {
    if (line.startsWith('```')) fence = !fence;
    if (fence) return;
    const h = headingOf(line);
    if (h) out.push({ ...h, i });
  });
  return out;
}

const trimEnd = (ls) => { const out = [...ls]; while (out.length && out[out.length - 1].trim() === '') out.pop(); return out; };
const header = (source) => `<!-- 生成物: scripts/role-references.mjs が ${source} から作る。ここを直さずに正本を直して、node scripts/role-references.mjs を流す -->`;

// 正本を節（見出しから、どの階層でも次の見出しの前まで）に分け、節ごとに ```text の塊と型の定義を持つ。
// 戻り値: { sections: [{ text, level, i, end, parent, blocks: [{ from, to, defs }] }], defs: Map(名前 → { name, from, to, section, refs }) }
function parseTypes(lines) {
  const hs = headings(lines);
  const sections = hs.map((h, k) => ({ text: h.text, level: h.level, i: h.i, end: hs[k + 1]?.i ?? lines.length, parent: null, blocks: [] }));
  const defs = new Map();
  sections.forEach((sec, k) => {
    for (let j = k - 1; j >= 0; j -= 1) if (sections[j].level < sec.level) { sec.parent = j; break; }
    let block = null;
    for (let i = sec.i + 1; i < sec.end; i += 1) {
      const line = lines[i];
      if (line.startsWith('```')) {
        if (block) { block.to = i; const last = block.defs[block.defs.length - 1]; if (last) last.to = i; sec.blocks.push(block); block = null; }
        else if (line === '```text') block = { from: i, to: null, defs: [] };
        else { const close = lines.indexOf('```', i + 1); i = close < 0 ? sec.end : close; }
        continue;
      }
      if (!block) continue;
      const m = /^([A-Za-z][A-Za-z0-9_]*)\s*=/.exec(line);
      if (!m) continue;
      const last = block.defs[block.defs.length - 1];
      if (last) last.to = i;
      if (defs.has(m[1])) throw new Error(`${TYPES_SOURCE} に型 ${m[1]} の定義が 2 つある`);
      const d = { name: m[1], from: i, to: null, section: k };
      block.defs.push(d);
      defs.set(m[1], d);
    }
    if (block) throw new Error(`${TYPES_SOURCE} の「${sec.text}」の型の塊が閉じていない`);
  });
  for (const d of defs.values()) d.refs = refsOf(lines.slice(d.from, d.to), (n) => defs.has(n), d.name);
  return { sections, defs };
}

// 定義の行が参照する型の名前（注釈と文字列を除いた部分に現れる、isType が真の名前。self を除く）
export function refsOf(defLines, isType, self = null) {
  const out = new Set();
  for (const line of defLines) {
    const code = line.replace(/"[^"]*"/g, '""').replace(/\/\/.*$/, '');
    for (const m of code.matchAll(/[A-Za-z][A-Za-z0-9_]*/g)) if (m[0] !== self && isType(m[0])) out.add(m[0]);
  }
  return [...out];
}

// 入口の型から推移的に辿った型の名前の集合
function closureOf(entries, defs) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    if (!defs.has(n)) throw new Error(`${TYPES_SOURCE} に入口の型 ${n} の定義が無い`);
    seen.add(n);
    stack.push(...defs.get(n).refs);
  }
  return seen;
}

// 役の型の抜粋の節の並び（各要素は見出しから始まる文字列）
function typeExcerpt(lines, { sections, defs }, role) {
  const { writes, reads } = entryTypesOf(role);
  const keep = closureOf([...writes, ...reads], defs);
  const full = new Set(writes.map((n) => defs.get(n).section));
  for (const k of [...full]) {
    for (let p = sections[k].parent; p !== null && sections[p].level >= 2; p = sections[p].parent) if (sections[p].blocks.every((b) => b.defs.length === 0)) full.add(p);
  }
  const blockLines = (b) => {
    const ds = b.defs.filter((d) => keep.has(d.name));
    return ds.length ? ['```text', ...ds.flatMap((d) => lines.slice(d.from, d.to)), '```'] : null;
  };
  const out = [];
  sections.forEach((sec, k) => {
    const mine = sec.blocks.filter((b) => b.defs.some((d) => keep.has(d.name)));
    if (!full.has(k) && !mine.length) return;
    const body = [`## ${sec.text}`];
    if (full.has(k)) {
      for (let i = sec.i + 1; i < sec.end; i += 1) {
        const b = sec.blocks.find((x) => x.from === i);
        if (!b) { body.push(lines[i]); continue; }
        const bl = blockLines(b);
        if (bl) body.push(...bl);
        i = bl || lines[b.to + 1] !== '' ? b.to : b.to + 1;   // 塊を落としたら、その後の空行も落とす
      }
    } else {
      for (const b of mine) body.push('', ...blockLines(b));
    }
    out.push(trimEnd(body).join('\n'));
  });
  return out;
}

function buildTypes(skillDir) {
  const lines = readFileSync(join(skillDir, TYPES_SOURCE), 'utf8').split('\n');
  const parsed = parseTypes(lines);
  return Object.keys(ROLE_ENTRY_TYPES).map((role) => {
    const parts = typeExcerpt(lines, parsed, role).map((part) => relink(part, TYPES_SOURCE));
    const { writes, reads } = entryTypesOf(role);
    const q = (ns) => ns.map((n) => `\`${n}\``).join('・');
    const text = [header(TYPES_SOURCE), '', `# 型の抜粋（${role}）`, '',
      `この役が書く型（${q(writes)}）の節と、読む型（${q(reads)}）と、それらの定義が参照する全ての型の定義を [成果物の形式](../artifact-formats.md) から抜き出したもの。形と値の正本は成果物の形式で、CLI はそれで照合する。`, '',
      parts.join('\n\n'), ''].join('\n');
    return { path: `${TYPES_DIR}/${role}.md`, text };
  });
}

function buildObligations(skillDir) {
  const lines = readFileSync(join(skillDir, OBLIGATIONS_SOURCE), 'utf8').split('\n');
  const hs = headings(lines).filter((h) => h.level === 2);
  // 正本の HTML の注記（生成の規則）は担当に渡さない
  const intro = trimEnd(lines.slice(1, hs[0].i).join('\n').replace(/<!--[\s\S]*?-->\n?/g, '').split('\n'));
  const sections = hs.filter((h) => h.text !== '目次').map((h) => {
    const end = hs[hs.indexOf(h) + 1]?.i ?? lines.length;
    const body = lines.slice(h.i, end);
    const m = AUDIENCE_RE.exec(body[1] ?? '');
    return { audience: m ? m[1] : null, body: trimEnd(m ? [body[0], ...body.slice(2)] : body) };
  });
  return Object.entries(OBLIGATION_FILES).map(([cls, path]) => {
    const mine = sections.filter((s) => s.audience === null || s.audience === cls).map((s) => s.body.join('\n'));
    const body = [header(OBLIGATIONS_SOURCE), '', `# ${TITLES[cls]}`, '', `対象: ${ROLES_OF[cls].map((r) => `\`${r}\``).join('・')}。`, ...intro, '', mine.join('\n\n'), ''].join('\n');
    return { path, text: relink(body, OBLIGATIONS_SOURCE) };
  });
}

// 生成物の並び: [{ path（skill の根からの相対）, text }]。同じ正本から同じ並びと中身になる
export function buildRoleReferences(skillDir) {
  return [...buildObligations(skillDir), ...buildTypes(skillDir)];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const skillDir = fileURLToPath(new URL('..', import.meta.url));
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const f of buildRoleReferences(skillDir)) {
    const p = join(skillDir, f.path);
    let now = null;
    try { now = readFileSync(p, 'utf8'); } catch { /* 無ければ書く */ }
    if (now === f.text) continue;
    stale += 1;
    if (check) { process.stderr.write(`古い生成物: ${f.path}\n`); continue; }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.text);
    process.stdout.write(`書いた: ${f.path}\n`);
  }
  if (check && stale) process.exit(1);
}
