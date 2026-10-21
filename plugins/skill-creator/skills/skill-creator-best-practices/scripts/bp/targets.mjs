import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CRITERIA_FILES, FUNCTION, PROMPT_AUDIT_SECTION, RUN_VIEWPOINTS } from './constants.mjs';
import { canonical, sha256Hex } from './ids.mjs';
import { auditUnits, flowUnits, parseDoc, specUnits } from './kinds.mjs';

const ITEM = /^(\d+)\. \*\*(.+?)\*\*/;

function fileOf(p) {
  try {
    return { path: p, sha256: sha256Hex(readFileSync(p)) };
  } catch {
    return { path: p, sha256: null };
  }
}

function criteriaPath(ctx, key) {
  return path.join(ctx.criteriaDir, ...CRITERIA_FILES[key]);
}

// 判定の単位の読み出しは章が無いと内部の失敗にするので、読めないことを理由つきで返す形に包む（同じ読み取りを 2 つ書かない）。
function attempt(fn) {
  try {
    const n = fn();
    return n > 0 ? null : '判定の単位か監査の観点が 1 件も無い';
  } catch (error) {
    return String(error?.reason ?? error?.message ?? error);
  }
}

export function auditItems(text) {
  const node = parseDoc(text).find((n) => n.level === 2 && n.text === PROMPT_AUDIT_SECTION);
  if (!node) return null;
  return node.body.map((l) => ITEM.exec(l)).filter(Boolean).map((m) => `${m[1]}. ${m[2]}`);
}

// SP-BPINSPECTION-010: 出所の番号付きの項目と、写しの SP-BPINSPECTION-009 の表の 2 列目を、件数・順・字面の全てで比べる。
export function compareAudit(items, table) {
  const want = table.map((u) => u.meaning);
  const diff = [];
  for (let i = 0; i < Math.max(items.length, want.length); i += 1) {
    if (items[i] !== want[i]) diff.push(`出所 ${JSON.stringify(items[i] ?? null)} / 一覧 ${JSON.stringify(want[i] ?? null)}`);
  }
  return diff;
}

function flowTarget(ctx) {
  const files = [fileOf(criteriaPath(ctx, 'conformance')), fileOf(criteriaPath(ctx, 'design'))];
  return { files, reason: attempt(() => flowUnits(ctx.criteriaDir).length) };
}

function specTarget(ctx) {
  return { files: [fileOf(criteriaPath(ctx, 'conformance'))], reason: attempt(() => specUnits(ctx.criteriaDir).length) };
}

// bp-designed-skill の写しも併せて指紋に入れる。監査の観点はその要求を優先する（SP-BPINSPECTION-012）ので、変わると付けた指摘の基準が変わる。
function auditTarget(ctx) {
  const files = [fileOf(ctx.promptAudit), fileOf(criteriaPath(ctx, 'designedSkill'))];
  let text;
  try {
    text = readFileSync(ctx.promptAudit, 'utf8');
  } catch {
    return { files, reason: 'ファイルを読めない' };
  }
  const items = auditItems(text);
  if (items === null) return { files, reason: `見出し「${PROMPT_AUDIT_SECTION}」の節が無い` };
  if (items.length === 0) return { files, reason: `「${PROMPT_AUDIT_SECTION}」の節に番号付きの項目が無い` };
  let table;
  try {
    table = auditUnits(ctx.criteriaDir);
  } catch (error) {
    return { files, reason: null, mismatch: [`写しの SP-BPINSPECTION-009 の表を読めない: ${error?.reason ?? error}`] };
  }
  const diff = compareAudit(items, table);
  return { files, reason: null, mismatch: diff.length ? diff : null };
}

const READERS = { flow: flowTarget, spec: specTarget, audit: auditTarget };

export function readTargets(ctx, fn) {
  const targets = RUN_VIEWPOINTS[fn].map((viewpoint) => {
    const r = READERS[viewpoint](ctx);
    return { viewpoint, files: r.files, fingerprint: sha256Hex(canonical(r.files)), readable: r.reason === null, reason: r.reason, ...(r.mismatch ? { mismatch: r.mismatch } : {}) };
  });
  const viewpoints = targets.filter((t) => t.readable).map((t) => t.viewpoint);
  const must = fn === FUNCTION.review ? 'flow' : 'audit';
  const main = targets.find((t) => t.viewpoint === must);
  let blocked = null;
  if (!main.readable) blocked = { reason: `照らす先を読めない（${main.reason}）: ${main.files[0].path}`, paths: [main.files[0].path] };
  else if (main.mismatch) blocked = { reason: `監査の観点の一覧が出所と食い違う: ${main.mismatch.join(' / ')}`, paths: [main.files[0].path] };
  return { viewpoints, targets, blocked };
}

export function changedTargets(recorded, now) {
  return recorded.flatMap((t) => {
    const cur = now.find((x) => x.viewpoint === t.viewpoint);
    return t.files.filter((f) => cur?.files.find((x) => x.path === f.path)?.sha256 !== f.sha256).map((f) => f.path);
  });
}
