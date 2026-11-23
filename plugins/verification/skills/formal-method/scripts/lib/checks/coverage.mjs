// 洗い出しの照合（architecture.md「段と処理の順序」の洗い出し）: 走査範囲の網羅・出所・引用の指紋。
import { sha256Bytes } from '../canonical.mjs';
import { Inventory, parseSpan, validate } from '../schemas.mjs';
import { defect, linesOf } from './common.mjs';

// otherPropertyIds・otherElementIds: 他の対象の inventory の性質・要素の id → その対象の id（どちらも run の全ての inventory を通して一意）
// scope: 依頼の範囲（Map<FilePath, Span[] | null>。null はファイルの全体。run.mjs の requestScopeOf）。覆うべきものは依頼の範囲だけで、
// 範囲の外のファイル・行は求めない（抽出役には範囲だけを渡すので、範囲の外を unread にさせない）。null なら全てのファイルの全体
// requestIds: 依頼の目標・既知の要求の id。otherDefinedIds: run の他の対象で定義された ID（definedIdsOf）。どちらも外の ID の参照に数えない
export function coverageCheck(runDir, inv, target, { otherPropertyIds = new Map(), otherElementIds = new Map(), scope = null, requestIds = new Set(), otherDefinedIds = new Set() } = {}) {
  const shapeErrs = validate(Inventory, inv);
  if (shapeErrs.length) return [defect('syntax', 'inventory-shape', `inventory の形に合わない: ${shapeErrs.slice(0, 3).join('; ')}`)];
  const out = [];
  if (inv.target_id !== target.id) out.push(defect('reference', 'inventory-target', `target_id ${inv.target_id} が task の対象 ${target.id} と違う`));
  if (inv.content_hash !== target.content_hash) out.push(defect('other', 'inventory-hash', 'content_hash が集まりの指紋と違う'));
  // 受付で読んだバイト列で照らす（写しは作らない。対象は run の間固定している前提で、集約の段で 1 度だけ読み直して照らす）
  const text = (file) => { const f = target.files.find((x) => x.path === file); return f && f.bytes ? Buffer.from(f.bytes).toString('utf8') : null; };
  for (const f of target.files) {
    if (scope && !scope.has(f.path)) continue;
    const want = scope ? scope.get(f.path) : null;
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
    const need = scopeLines(want, n);
    if (need.some((i) => !covered.has(i))) out.push(defect('other', `scan-lines:${f.path}`, want ? `${f.path} の依頼の範囲（${want.join(', ')}）の全ての行を覆わない` : `${f.path} の全ての行を覆わない`));
  }
  const ids = new Set();
  for (const e of inv.elements) {
    if (ids.has(e.id)) out.push(defect('other', `element-dup:${e.id}`, `要素の id ${e.id} が重なる`));
    else if (otherElementIds.has(e.id)) out.push(defect('other', `element-dup:${e.id}`, `要素の id ${e.id} が対象 ${otherElementIds.get(e.id)} の inventory の要素と重なる`));
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
  // 確認の段の抽出の確認で見つかる型を、抽出役が検査の前に直せるよう照合でも返す（抽出の確認役の観点は残す）
  const bound = new Set(inv.properties.flatMap((p) => p.source_ids));
  for (const e of inv.elements) if (!bound.has(e.id)) out.push(defect('other', `element-unbound:${e.id}`, `要素 ${e.id} がどの性質の source_ids にも無い（要素から性質を作るか、形式化できない性質として結ぶ）`));
  const own = new Set([...ids, ...propIds, ...inv.external_dependencies.map((d) => d.id), ...otherPropertyIds.keys(), ...otherElementIds.keys(), ...requestIds, ...otherDefinedIds]);
  for (const r of externalReferences(target, text, scope, own)) {
    if (inv.external_dependencies.some((d) => mentions(d.text, r.id))) continue;
    out.push(defect('other', `external-reference:${r.id}`, `本文 ${r.file}:L${r.line} の ID の参照 ${r.id} が、この対象で定義されず、external_dependencies にも無い（外の文書・要求への依存なら external_dependencies に書く）`));
  }
  return out;
}

// 覆うべき行: 依頼の範囲の span の行（行数を超える部分は無い行として切る）。範囲が無ければファイルの全ての行
function scopeLines(want, n) {
  const need = [];
  if (want) for (const sp of want) { const s = parseSpan(sp); if (s) for (let i = s.from; i <= Math.min(s.to, n); i += 1) need.push(i); }
  else for (let i = 1; i <= n; i += 1) need.push(i);
  return need;
}

// ---- 本文の ID の参照（外の依存の書き漏らし） ----
// ID の形: 大文字で始まる語を - でつなぎ（2 つ以上の区切り）、最後の区切りに数字を含む（SP-FORMALMETHOD-012・PR-LOOP-021・AC-04）。
// 偽の陽性を避けるため、規則は狭くとる:
// - 対象が定義する ID（見出しの行の先頭の語、表の行の最初の列）から ID の形（区切りごとの 字・数・混じり の並び）を拾い、同じ形の参照だけを数える。
//   区切りが 2 つの形は、定義した ID と頭の語も同じときだけ数える（AC-04 を定義しても UTF-8・SHA-256 を数えない）。対象が ID を定義しなければ数えない
// - 対象・run の他の対象が定義する ID、inventory の id（要素・性質・外部の依存、他の対象の分を含む）、依頼の id は数えない
// - 依頼の範囲の行だけを読み、external_dependencies の id か文がその ID を含めば書いてあるとする
const ID_RE = /(?<![A-Za-z0-9_./-])[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+(?![A-Za-z0-9_-])/g;
const idsIn = (line) => (line.match(ID_RE) ?? []).filter((id) => /\d/.test(id.slice(id.lastIndexOf('-') + 1)));
const DEFINITION_RES = [/^#{1,6}\s+([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)(?![A-Za-z0-9_-])/, /^\|\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\s*\|/];
const shapeOf = (id) => id.split('-').map((x) => (/^[A-Z]+$/.test(x) ? 'L' : /^\d+$/.test(x) ? 'D' : 'M')).join('-');
const mentions = (text, id) => idsIn(text).includes(id) || text.split(/[^A-Za-z0-9_-]+/).includes(id);
const fileText = (f) => (f.text && f.bytes ? Buffer.from(f.bytes).toString('utf8') : null);

// 対象のテキストのファイルの全ての行で、定義の位置（見出し・表の最初の列）にある ID
export function definedIdsOf(target) {
  const out = new Set();
  for (const f of target.files) {
    const t = fileText(f);
    if (t === null) continue;
    for (const l of linesOf(t)) for (const re of DEFINITION_RES) { const m = l.match(re); if (m && idsIn(m[1]).length) out.add(m[1]); }
  }
  return out;
}

function externalReferences(target, text, scope, exclude) {
  const defined = definedIdsOf(target);
  const shapes = [...defined].map((d) => ({ shape: shapeOf(d), head: d.split('-')[0], parts: d.split('-').length }));
  if (!shapes.length) return [];
  const looksLike = (id) => { const sh = shapeOf(id); const head = id.split('-')[0]; return shapes.some((x) => x.shape === sh && (x.parts >= 3 || x.head === head)); };
  const out = [];
  const seen = new Set();
  for (const f of target.files) {
    if (scope && !scope.has(f.path)) continue;
    const t = text(f.path);
    if (t === null || !f.text) continue;
    const lines = linesOf(t);
    for (const n of scopeLines(scope ? scope.get(f.path) : null, lines.length)) for (const id of idsIn(lines[n - 1])) {
      if (seen.has(id) || defined.has(id) || exclude.has(id) || !looksLike(id)) continue;
      seen.add(id);
      out.push({ id, file: f.path, line: n });
    }
  }
  return out;
}
