// 洗い出しの照合（architecture.md「段と処理の順序」の洗い出し）: 走査範囲の網羅・出所・引用の指紋。
import { join } from 'node:path';
import { sha256Bytes } from '../canonical.mjs';
import { Inventory, parseSpan, validate } from '../schemas.mjs';
import { defect, linesOf, readRunText } from './common.mjs';

// otherPropertyIds: 他の対象の inventory の性質の id → その対象の id（性質の id は run の全ての inventory を通して一意）
export function coverageCheck(runDir, inv, target, { otherPropertyIds = new Map() } = {}) {
  const shapeErrs = validate(Inventory, inv);
  if (shapeErrs.length) return [defect('syntax', 'inventory-shape', `inventory の形に合わない: ${shapeErrs.slice(0, 3).join('; ')}`)];
  const out = [];
  if (inv.target_id !== target.id) out.push(defect('reference', 'inventory-target', `target_id ${inv.target_id} が task の対象 ${target.id} と違う`));
  if (inv.content_hash !== target.content_hash) out.push(defect('other', 'inventory-hash', 'content_hash が集まりの指紋と違う'));
  const text = (file) => readRunText(runDir, join('targets', target.id, 'files', file));
  for (const f of target.files) {
    const entries = inv.scanned.filter((s) => s.file === f.path);
    if (entries.length === 0) { out.push(defect('other', `scan-missing:${f.path}`, `scanned が ${f.path} を覆わない`)); continue; }
    if (!f.text) continue;
    const t = text(f.path);
    const n = t === null ? 0 : linesOf(t).length;
    const covered = new Set();
    for (const e of entries) {
      // unread も span の範囲だけを覆う（読めなかった箇所は結果の verified_scope.unread に載る）
      if (e.status === 'unread' && e.reason === null) out.push(defect('other', `scan-reason:${f.path}`, `${f.path} の unread に理由が無い`));
      if (e.span === null) { for (let i = 1; i <= n; i += 1) covered.add(i); continue; }
      const s = parseSpan(e.span);
      if (!s || s.to > n) { out.push(defect('other', `scan-span:${f.path}:${e.span}`, `${f.path} の span ${e.span} が行数 ${n} を超える`)); continue; }
      for (let i = s.from; i <= s.to; i += 1) covered.add(i);
    }
    if (covered.size < n) out.push(defect('other', `scan-lines:${f.path}`, `${f.path} の全ての行を覆わない`));
  }
  const ids = new Set();
  for (const e of inv.elements) {
    if (ids.has(e.id)) out.push(defect('other', `element-dup:${e.id}`, `要素の id ${e.id} が重なる`));
    ids.add(e.id);
    if (e.source.target_id !== target.id) { out.push(defect('reference', `element-target:${e.id}`, `要素 ${e.id} の出所の target_id ${e.source.target_id} がこの inventory の対象 ${target.id} でない`)); continue; }
    const f = target.files.find((x) => x.path === e.source.file);
    const t = f && f.text ? text(f.path) : null;
    const s = parseSpan(e.source.span);
    if (t === null || !s) { out.push(defect('reference', `element-source:${e.id}`, `要素 ${e.id} の出所が対象に無い`)); continue; }
    const lines = linesOf(t);
    if (s.to > lines.length) { out.push(defect('reference', `element-source:${e.id}`, `要素 ${e.id} の出所の行が範囲の外`)); continue; }
    const quote = lines.slice(s.from - 1, s.to).join('\n');
    if (sha256Bytes(Buffer.from(quote, 'utf8')) !== e.source.quote_hash) out.push(defect('other', `element-quote:${e.id}`, `要素 ${e.id} の quote_hash が出所の行と一致しない`));
  }
  // 外の依存の出所も、この対象の中の実在する行を指す
  for (const d of inv.external_dependencies) {
    if (d.source === null) continue;
    const f = d.source.target_id === target.id ? target.files.find((x) => x.path === d.source.file) : null;
    const t = f && f.text ? text(f.path) : null;
    const s = parseSpan(d.source.span);
    if (t === null || !s || s.to > linesOf(t).length) out.push(defect('reference', `external-source:${d.id}`, `外の依存 ${d.id} の出所が対象 ${target.id} の行に無い`));
  }
  const propIds = new Set();
  for (const p of inv.properties) {
    if (propIds.has(p.id)) out.push(defect('other', `property-dup:${p.id}`, `性質の id ${p.id} が重なる`));
    else if (otherPropertyIds.has(p.id)) out.push(defect('other', `property-dup:${p.id}`, `性質の id ${p.id} が対象 ${otherPropertyIds.get(p.id)} の inventory の性質と重なる`));
    propIds.add(p.id);
    for (const s of p.source_ids) if (!ids.has(s)) out.push(defect('reference', `property-source:${p.id}:${s}`, `性質 ${p.id} の出所 ${s} が要素に無い`));
    if (!p.formalizable && p.nonformal_reason === null) out.push(defect('other', `property-nonformal:${p.id}`, `形式化できない性質 ${p.id} に理由が無い`));
  }
  return out;
}
