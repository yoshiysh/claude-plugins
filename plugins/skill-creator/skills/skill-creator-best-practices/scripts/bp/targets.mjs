import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CRITERIA_CHAPTERS, CRITERIA_FILES, FUNCTION, PROMPT_AUDIT_SECTION, RUN_VIEWPOINTS, TARGET_FILES, VIEWPOINT } from './constants.mjs';
import { BpError } from './errors.mjs';
import { canonical, sha256Hex } from './ids.mjs';
import { auditUnits, flowUnits, parseDoc, specUnits } from './kinds.mjs';

const ITEM = /^(\d+)\. \*\*(.+?)\*\*/;

function fileOf(name, p) {
  try {
    return { name, path: p, sha256: sha256Hex(readFileSync(p)) };
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'EISDIR' && error.code !== 'ENOTDIR') throw error;
    return { name, path: p, sha256: null };
  }
}

function criteriaFile(ctx, key) {
  return fileOf(TARGET_FILES[key], path.join(ctx.criteriaDir, ...CRITERIA_FILES[key]));
}

// 判定の単位の読み出しは章や表が無いと内部の失敗にするので、その失敗とファイルの欠けだけを「読めない」理由に変える（ほかの失敗は CLI の失敗として返す）。
function attempt(fn) {
  try {
    const n = fn();
    return n > 0 ? null : '判定の単位か監査の観点が 1 件も無い';
  } catch (error) {
    if (error instanceof BpError || error?.code === 'ENOENT') return String(error.reason ?? error.message);
    throw error;
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

// 除く単位の表（SP-BPINSPECTION-007）と監査の観点の一覧（SP-BPINSPECTION-009）の出所なので、bp-inspection の写しも指紋に入れる。
function flowTarget(ctx) {
  const files = [criteriaFile(ctx, 'conformance'), criteriaFile(ctx, 'design'), criteriaFile(ctx, 'inspection')];
  return { files, section: CRITERIA_CHAPTERS.functional, reason: attempt(() => flowUnits(ctx.criteriaDir).length) };
}

function specTarget(ctx) {
  return { files: [criteriaFile(ctx, 'conformance')], section: CRITERIA_CHAPTERS.capacityPrefix, reason: attempt(() => specUnits(ctx.criteriaDir).length) };
}

// bp-designed-skill の写しも指紋に入れる。監査の観点はその要求を優先する（SP-BPINSPECTION-012）ので、変わると付けた指摘の基準が変わる。
function auditTarget(ctx) {
  const files = [fileOf(TARGET_FILES.promptAudit, ctx.promptAudit), criteriaFile(ctx, 'designedSkill'), criteriaFile(ctx, 'inspection')];
  const section = PROMPT_AUDIT_SECTION;
  if (files[0].sha256 === null) return { files, section, reason: 'ファイルを読めない' };
  const items = auditItems(readFileSync(ctx.promptAudit, 'utf8'));
  if (items === null) return { files, section, reason: `見出し「${PROMPT_AUDIT_SECTION}」の節が無い` };
  if (items.length === 0) return { files, section, reason: `「${PROMPT_AUDIT_SECTION}」の節に番号付きの項目が無い` };
  let table;
  try {
    table = auditUnits(ctx.criteriaDir);
  } catch (error) {
    if (!(error instanceof BpError) && error?.code !== 'ENOENT') throw error;
    return { files, section, reason: null, mismatch: [`写しの SP-BPINSPECTION-009 の表を読めない: ${error.reason ?? error.message}`] };
  }
  const diff = compareAudit(items, table);
  return { files, section, reason: null, mismatch: diff.length ? diff : null };
}

const READERS = { [VIEWPOINT.flow]: flowTarget, [VIEWPOINT.spec]: specTarget, [VIEWPOINT.audit]: auditTarget };

// 照らす先の指紋はファイルの名前と内容だけから作る（置き場のパスが変わっても内容が同じなら同じ指紋：用語定義「照らす先の指紋」）。
function fingerprintOf(files) {
  return sha256Hex(canonical(files.map((f) => ({ name: f.name, sha256: f.sha256 }))));
}

// 読めない理由は、欠けたファイルがあればそのパスを、無ければ観点の最初のファイルのパスを指す。
function culprit(target) {
  return (target.files.find((f) => f.sha256 === null) ?? target.files[0]).path;
}

export function readTargets(ctx, fn) {
  const targets = RUN_VIEWPOINTS[fn].map((viewpoint) => {
    const r = READERS[viewpoint](ctx);
    return { viewpoint, files: r.files, section: r.section, fingerprint: fingerprintOf(r.files), readable: r.reason === null, reason: r.reason, ...(r.mismatch ? { mismatch: r.mismatch } : {}) };
  });
  const viewpoints = targets.filter((t) => t.readable).map((t) => t.viewpoint);
  const main = targets.find((t) => t.viewpoint === (fn === FUNCTION.review ? VIEWPOINT.flow : VIEWPOINT.audit));
  let blocked = null;
  if (!main.readable) blocked = { reason: `照らす先を読めない（${main.reason}）: ${culprit(main)}`, paths: [culprit(main)] };
  else if (main.mismatch) blocked = { reason: `監査の観点の一覧が出所と食い違う: ${main.mismatch.join(' / ')}`, paths: [main.files[0].path] };
  return { viewpoints, targets, blocked };
}

export function changedTargets(recorded, now) {
  return recorded.flatMap((t) => {
    const cur = now.find((x) => x.viewpoint === t.viewpoint);
    return t.files.filter((f) => cur?.files.find((x) => x.name === f.name)?.sha256 !== f.sha256).map((f) => f.path);
  });
}
