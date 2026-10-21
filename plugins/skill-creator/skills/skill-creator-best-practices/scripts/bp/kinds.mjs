import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FUNCTION, CRITERIA_CHAPTERS, CRITERIA_FILES, PRINCIPLE_HEADER, UPDATE_ONLY_MARK } from './constants.mjs';
import { scanMarkdown } from './assets.mjs';
import { internal } from './errors.mjs';

const ROW_RULE = /設計方針文書「([^」]+)」の節の原則の表の全ての行/;
const BULLET_RULE = /同節の定義の箇条書き/;
const EACH_TABLE_RULE = /設計方針文書「([^」]+)」の節の、([^の]+(?:・[^の]+)*)の各表の全ての行/;

export function read(dir, key) {
  return readFileSync(path.join(dir, ...CRITERIA_FILES[key]), 'utf8');
}

export function parseDoc(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const { headings, fenced } = scanMarkdown(lines);
  const byStart = new Map(headings.map((h) => [h.start, h]));
  const nodes = [];
  const stack = [];
  let table = null;
  let current = { level: 0, text: '', chain: [], tables: [], bullets: [], body: [] };
  const root = current;
  nodes.push(root);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const h = byStart.get(i);
    if (h) {
      table = null;
      while (stack.length && stack.at(-1).level >= h.level) stack.pop();
      current = { level: h.level, text: h.text, chain: [...stack.map((x) => x.text), h.text], tables: [], bullets: [], body: [], parent: stack.at(-1) ?? root };
      stack.push(current);
      nodes.push(current);
      if (h.underline) i += 1;
      continue;
    }
    current.body.push(line);
    if (!fenced.has(i) && /^\|/.test(line)) {
      const cells = line.replace(/^\||\|\s*$/g, '').split('|').map((c) => c.trim());
      if (!table) { table = { header: cells, rows: [], sep: false }; current.tables.push(table); continue; }
      if (!table.sep && cells.every((c) => /^:?-+:?$/.test(c))) { table.sep = true; continue; }
      table.rows.push(cells);
      continue;
    }
    table = null;
  }
  return nodes;
}

export function descendants(nodes, node) {
  return nodes.filter((n) => n !== node && n.chain.length > node.chain.length && node.chain.every((t, i) => n.chain[i] === t));
}

function findSection(nodes, title) {
  const found = nodes.filter((n) => n.text === title && n.level === 2);
  if (found.length !== 1) internal(`設計方針文書の節が見つからない（${found.length} 件）: ${title}`);
  return found[0];
}

function rowUnits(sp, nodes, section, { onlyPrinciple, subsections }) {
  const scope = subsections ?? [section, ...descendants(nodes, section)];
  const units = [];
  for (const node of scope) {
    node.tables.forEach((table, ti) => {
      if (onlyPrinciple && table.header[0] !== PRINCIPLE_HEADER) return;
      table.rows.forEach((row, ri) => {
        units.push({ value: `${sp}/${node.chain.slice(section.chain.length - 1).join('/')}/t${ti + 1}/r${ri + 1}`, meaning: row[0] });
      });
    });
  }
  return units;
}

function bulletUnits(sp, section) {
  const start = section.body.findIndex((l) => /^\*\*定義\*\*/.test(l));
  if (start < 0) internal(`定義の箇条書きが見つからない: ${section.text}`);
  const units = [];
  for (let i = start + 1; i < section.body.length; i += 1) {
    const m = /^- (.*)$/.exec(section.body[i]);
    if (!m) { if (units.length) break; continue; }
    units.push({ value: `${sp}/${section.text}/b${units.length + 1}`, meaning: m[1] });
  }
  return units;
}

function specItems(nodes, chapterMatch) {
  const chapter = nodes.find((n) => n.level === 2 && chapterMatch(n.text));
  if (!chapter) internal('判定基準の写しに章が無い');
  return descendants(nodes, chapter).filter((n) => n.level === 4 && /^SP-BPCONFORMANCE-\d{3}\b/.test(n.text)).map((n) => ({
    id: /^(SP-BPCONFORMANCE-\d{3})/.exec(n.text)[1],
    title: n.text.replace(/^SP-BPCONFORMANCE-\d{3}\s*/, ''),
    body: n.body.join('\n'),
  }));
}

export function conformanceUnits(criteriaDir) {
  const spec = parseDoc(read(criteriaDir, 'conformance'));
  const design = parseDoc(read(criteriaDir, 'design'));
  const out = [];
  for (const item of specItems(spec, (t) => t === CRITERIA_CHAPTERS.functional)) {
    const units = [];
    const each = EACH_TABLE_RULE.exec(item.body);
    const rows = ROW_RULE.exec(item.body);
    if (each) {
      const section = findSection(design, each[1]);
      const subs = descendants(design, section).filter((n) => n.level === section.level + 1);
      const picked = [];
      let rest = each[2];
      while (rest.length) {
        const sub = subs.find((s) => rest === s.text || rest.startsWith(`${s.text}・`));
        if (!sub) internal(`「${each[1]}」の節に子の節が無い: ${rest}`);
        picked.push(sub, ...descendants(design, sub));
        rest = rest.slice(sub.text.length).replace(/^・/, '');
      }
      units.push(...rowUnits(item.id, design, section, { onlyPrinciple: false, subsections: picked }));
    } else if (rows) {
      const section = findSection(design, rows[1]);
      units.push(...rowUnits(item.id, design, section, { onlyPrinciple: true }));
      if (BULLET_RULE.test(item.body)) units.push(...bulletUnits(item.id, section));
    }
    if ((each || rows) && units.length === 0) internal(`判定の単位が 0 件: ${item.id}`);
    out.push({ sp: item.id, title: item.title, rowUnits: units.length > 0, units: units.length ? units : [{ value: item.id, meaning: item.title }] });
  }
  return out;
}

export function specUnits(criteriaDir) {
  const spec = parseDoc(read(criteriaDir, 'conformance'));
  return specItems(spec, (t) => t.startsWith(CRITERIA_CHAPTERS.capacityPrefix)).map((i) => ({ value: i.id, meaning: i.title }));
}

function tableAfter(nodes, headingPrefix, firstHeader) {
  const node = nodes.find((n) => n.level === 4 && n.text.startsWith(headingPrefix));
  if (!node) internal(`仕様項目が見つからない: ${headingPrefix}`);
  const table = node.tables.find((t) => t.header[0] === firstHeader);
  if (!table) internal(`${headingPrefix} に「${firstHeader}」の表が無い`);
  return table;
}

export function authoringUnits(criteriaDir, viewpointLabel, fn) {
  const table = tableAfter(parseDoc(read(criteriaDir, 'authoring')), 'SP-BPAUTHORING-016', '観点');
  const row = table.rows.find((r) => r[0] === viewpointLabel);
  if (!row) internal(`SP-BPAUTHORING-016 の表に観点が無い: ${viewpointLabel}`);
  return row[1].split('、').map((s) => s.trim()).filter((s) => fn === FUNCTION.update || !s.endsWith(UPDATE_ONLY_MARK))
    .map((s) => s.replace(UPDATE_ONLY_MARK, '')).map((s) => ({ value: `${viewpointLabel}:${s}`, meaning: s }));
}

export function auditUnits(criteriaDir) {
  const table = tableAfter(parseDoc(read(criteriaDir, 'inspection')), 'SP-BPINSPECTION-009', '識別子');
  return table.rows.map((r) => ({ value: r[0], meaning: r[1] }));
}

export function buildKinds(criteriaDir, fn) {
  return {
    flow: conformanceUnits(criteriaDir).flatMap((s) => s.units),
    conformance: conformanceUnits(criteriaDir).flatMap((s) => s.units),
    spec: specUnits(criteriaDir),
    goal: authoringUnits(criteriaDir, '目標', fn),
    contract: authoringUnits(criteriaDir, '契約', fn),
    audit: auditUnits(criteriaDir),
  };
}

export function kindsFor(criteriaDir, viewpoint, fn) {
  const all = buildKinds(criteriaDir, fn);
  if (!Object.hasOwn(all, viewpoint)) internal(`観点が無い: ${viewpoint}`);
  return all[viewpoint];
}
