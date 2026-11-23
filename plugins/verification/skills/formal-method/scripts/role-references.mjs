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
// h は artifact-formats.md の見出しの文（# を除く）。mode: section = 見出しから同じか上の階層の次の見出しの前まで、
// intro = 次の見出し（どの階層でも）の前まで、code = その節の最初の ```text の塊だけ。見出しが無ければ生成を止める（正本の改名を見落とさない）。
const S = (h) => ({ h, mode: 'section' });
const INTRO = (h) => ({ h, mode: 'intro' });
const CODE = (h) => ({ h, mode: 'code' });
const T = {
  common: CODE('共通の型'), outputs: INTRO('担当の成果物'), inventory: S('inventory（抽出役。対象 1 つにつき 1 つ）'),
  model: S('model（モデル作成役）'), mapping: S('mapping（モデル作成役）'), partitions: S('partitions（分割作成役。候補が 2 つ以上のときだけ）'),
  plan: S('plan と mutations（計画作成役）'), composition: S('分割と合成（SP-008・009）'), check: S('検査（SP-010）'), cause: S('反例と原因（SP-011）'),
  confirmation: CODE('確認（SP-004・005・012）'), returns: S('担当の返り値'), task: CODE('claim の Task'), worklog: S('作業記録'),
};
const tail = [T.returns, T.task, T.worklog];
export const ROLE_TYPES = Object.freeze({
  extractor: [T.common, T.outputs, T.inventory, T.cause, ...tail],
  'model-author': [T.common, T.outputs, T.inventory, T.model, T.mapping, T.cause, ...tail],
  'partition-author': [T.common, T.outputs, T.model, T.partitions, T.composition, T.cause, ...tail],
  'plan-author': [T.common, T.outputs, T.model, T.partitions, T.plan, T.check, T.cause, ...tail],
  'extraction-reviewer': [T.common, T.inventory, ...tail],
  'fidelity-reviewer': [T.common, T.inventory, T.model, T.mapping, T.confirmation, ...tail],
  'assurance-reviewer': [T.common, T.inventory, ...tail],
  'composition-reviewer': [T.common, T.model, T.partitions, T.composition, T.check, ...tail],
  'cause-analyst': [T.common, T.model, T.mapping, T.check, T.cause, ...tail],
});

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

function pick(lines, hs, sel, source) {
  const at = hs.findIndex((h) => h.text === sel.h);
  if (at < 0) throw new Error(`${source} に見出し「${sel.h}」が無い`);
  const h = hs[at];
  const next = sel.mode === 'intro' ? hs[at + 1] : hs.slice(at + 1).find((x) => x.level <= h.level);
  const body = lines.slice(h.i, next ? next.i : lines.length);
  if (sel.mode !== 'code') return body;
  const from = body.indexOf('```text');
  const to = from < 0 ? -1 : body.indexOf('```', from + 1);
  if (to < 0) throw new Error(`${source} の「${sel.h}」に型の塊（\`\`\`text）が無い`);
  return [body[0], '', ...body.slice(from, to + 1), ''];
}

// 抜き出した節の見出しの階層を、生成物の ## に揃える（下の見出しは同じだけ上げる）
function shift(block) {
  const top = headingOf(block[0]).level;
  let fence = false;
  return block.map((line) => {
    if (line.startsWith('```')) fence = !fence;
    const h = fence ? null : headingOf(line);
    return h ? `${'#'.repeat(Math.max(2, h.level - top + 2))} ${h.text}` : line;
  });
}

const trimEnd = (ls) => { const out = [...ls]; while (out.length && out[out.length - 1].trim() === '') out.pop(); return out; };
const header = (source) => `<!-- 生成物: scripts/role-references.mjs が ${source} から作る。ここを直さずに正本を直して、node scripts/role-references.mjs を流す -->`;

function buildTypes(skillDir) {
  const text = readFileSync(join(skillDir, TYPES_SOURCE), 'utf8');
  const lines = text.split('\n');
  const hs = headings(lines);
  return Object.entries(ROLE_TYPES).map(([role, sels]) => {
    const parts = sels.map((sel) => relink(trimEnd(shift(pick(lines, hs, sel, TYPES_SOURCE))).join('\n'), TYPES_SOURCE));
    const text = [header(TYPES_SOURCE), '', `# 型の抜粋（${role}）`, '',
      'この役が読み書きする型だけを [成果物の形式](../artifact-formats.md) から抜き出したもの。形と値の正本は成果物の形式で、CLI はそれで照合する。', '',
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
