import { CONTRACT_ELEMENTS, CONTRACT_NONE, CRITERIA_CHAPTERS, SHAPES, UNCHECKED_KINDS, UNCHECKED_SCOPES, UNIT_RESULTS, VIEWPOINT, VIEWPOINTS } from './constants.mjs';
import { internal } from './errors.mjs';
import { keyString } from './ids.mjs';
import { conformanceUnits, hasChapter, kindsFor, parseDoc, read, specUnits } from './kinds.mjs';

const PR = 'PR-BPDESIGNEDSKILL-';
const SP = /^SP-BPCONFORMANCE-\d{3}$/;
const ALWAYS = /PR-BPDESIGNEDSKILL-(\d{3}(?:・\d{3})*) はどの行でも当たる/;
const PERMISSION_SP = 'SP-BPCONFORMANCE-014';
const EXECUTOR_TIME_ROW = '実行役の時間に上限を置く';
// 強いられた未検査の出所（bp-authoring の用語「強いられた未検査」）と、未検査に固定した仕様項目（review の未検査の観点の理由：SP-BPINSPECTION-025）。
const FORCED_REQUIREMENTS = Object.freeze({ always: [`${PR}014`], turnForm: [`${PR}002`] });
const FORCED_BY = Object.freeze({ always: 'SP-BPCONFORMANCE-019', permission: 'SP-BPCONFORMANCE-019', executorTime: 'SP-BPCONFORMANCE-034', turnForm: 'SP-BPCONFORMANCE-006' });

function numbers(text) {
  const out = [];
  for (const m of text.matchAll(/(\d{3})(?:〜(\d{3}))?/g)) {
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    for (let n = from; n <= to; n += 1) out.push(`${PR}${String(n).padStart(3, '0')}`);
  }
  return out;
}

function traceability(nodes) {
  const node = nodes.find((n) => n.level === 2 && n.text === 'トレーサビリティ表');
  const table = node?.tables[0];
  if (!table) internal('判定基準の写しの bp-conformance にトレーサビリティ表が無い');
  const map = new Map();
  for (const [req, sps] of table.rows) {
    if (!req.startsWith(PR)) continue;
    map.set(req, [...(map.get(req) ?? []), ...sps.split(',').map((s) => s.trim()).filter((s) => SP.test(s))]);
  }
  return map;
}

function chapterOf(nodes) {
  const out = new Map();
  let chapter = null;
  for (const n of nodes) {
    if (n.level === 2) chapter = n.text;
    const id = n.level === 4 ? /^SP-BPCONFORMANCE-\d{3}/.exec(n.text)?.[0] : null;
    if (id) out.set(id, chapter);
  }
  return out;
}

function unitsBySpec(criteriaDir, capacity) {
  const map = new Map();
  for (const item of conformanceUnits(criteriaDir)) map.set(item.sp, item.units);
  if (capacity) for (const u of specUnits(criteriaDir)) map.set(u.value, [u]);
  return map;
}

// 基準が求めた制約と契約の変化に選べるのは、写しの bp-conformance の章を問わず全ての仕様項目 ID。
export function specItemIds(criteriaDir) {
  return parseDoc(read(criteriaDir, 'conformance')).filter((n) => n.level === 4).map((n) => /^SP-BPCONFORMANCE-\d{3}/.exec(n.text)?.[0]).filter(Boolean).sort();
}

// 「性能・容量」の章の無い写しを許すのは review の適用の判定だけ（仕様の観点を読めない review は止まらない：SP-BPINSPECTION-005）。
// create・update が許すと、その章にトレースされた単位が宣言なしに表から落ち、検証役が判定しないまま進む。
function sources(criteriaDir, { tolerateNoCapacity = false } = {}) {
  const nodes = parseDoc(read(criteriaDir, 'conformance'));
  const item = nodes.find((n) => n.level === 4 && n.text.startsWith('SP-BPCONFORMANCE-003'));
  const table = item?.tables.find((t) => t.header[0] === '条件: 形');
  const always = ALWAYS.exec(item?.body.join('\n') ?? '');
  if (!table || !always) internal('判定基準の写しに SP-BPCONFORMANCE-003 の適用の判定表が無い');
  const trace = traceability(nodes);
  const capacity = !tolerateNoCapacity || hasChapter(criteriaDir, (t) => t.startsWith(CRITERIA_CHAPTERS.capacityPrefix));
  const bySpec = unitsBySpec(criteriaDir, capacity);
  // 落としてよいのは、読める章のどれにも属さない仕様項目だけ。見出しの無い仕様項目と、読める章にあって単位を持たない仕様項目は写しの破損なので止まる。
  const chapters = chapterOf(nodes);
  const readable = new Set([CRITERIA_CHAPTERS.functional, ...CRITERIA_CHAPTERS.others]);
  const unitsOf = (req) => (trace.get(req) ?? []).flatMap((sp) => {
    const list = bySpec.get(sp);
    if (!list && (capacity || !chapters.has(sp) || readable.has(chapters.get(sp)))) internal(`トレーサビリティ表の仕様項目が判定基準の写しに無い: ${sp}`);
    return list ?? [];
  });
  return { table, always, bySpec, unitsOf };
}

// 強いられた未検査の単位ごとに、未検査に固定した仕様項目 ID を返す（always はどの形でも、turnForm はターンごとの指揮だけ）。
export function forcedSources(criteriaDir, options) {
  const { bySpec, unitsOf } = sources(criteriaDir, options);
  const always = new Map();
  const turnForm = new Map();
  for (const req of FORCED_REQUIREMENTS.always) unitsOf(req).forEach((u) => always.set(u.value, FORCED_BY.always));
  for (const req of FORCED_REQUIREMENTS.turnForm) unitsOf(req).forEach((u) => turnForm.set(u.value, FORCED_BY.turnForm));
  const permission = bySpec.get(PERMISSION_SP) ?? [];
  const lastPermission = permission.filter((u) => /\/t1\/r\d+$/.test(u.value)).at(-1);
  if (lastPermission) always.set(lastPermission.value, FORCED_BY.permission);
  for (const list of bySpec.values()) for (const u of list) if (u.meaning?.startsWith(EXECUTOR_TIME_ROW)) always.set(u.value, FORCED_BY.executorTime);
  return { always, turnForm };
}

export function applicability(criteriaDir, options) {
  const { table, always, unitsOf } = sources(criteriaDir, options);
  const forcedSet = forcedSources(criteriaDir, options);
  const forcedAlways = forcedSet.always;
  const forcedTurn = forcedSet.turnForm;
  const alwaysReqs = always[1].split('・').map((n) => `${PR}${n}`);
  return table.rows.map(([form, ledger, fanout, result], i) => {
    const reqs = [...new Set([...alwaysReqs, ...numbers(result.split('が当た')[0])])].sort();
    const seen = new Map();
    for (const u of reqs.flatMap(unitsOf)) if (!seen.has(u.value)) seen.set(u.value, u);
    const units = [...seen.values()];
    const forced = units.filter((u) => forcedAlways.has(u.value) || (form === SHAPES.turn && forcedTurn.has(u.value))).map((u) => u.value);
    return { row: i + 1, form, ledger, fanout, requirements: reqs, units: units.map((u) => ({ value: u.value, meaning: u.meaning })), forced };
  });
}

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isKey = (k) => k && isStr(k.asset) && isStr(k.viewpoint) && isStr(k.kind);

function checkConformance(result, rows) {
  const app = result.applicability;
  const row = rows.find((r) => r.row === app?.row);
  if (!row) return `applicability.row が適用の判定表の行ではない: ${JSON.stringify(app?.row)}`;
  if (!Array.isArray(result.units)) return 'units が並びでない';
  const want = new Set(row.units.map((u) => u.value));
  const forced = new Set(row.forced);
  const keys = new Set((result.candidates ?? []).map((c) => keyString(c)));
  const got = new Set();
  for (const u of result.units) {
    if (!u || !want.has(u.unit)) return `表の ${row.row} 行の判定の単位ではない: ${JSON.stringify(u?.unit)}`;
    if (got.has(u.unit)) return `同じ判定の単位の結果が 2 つある: ${u.unit}`;
    got.add(u.unit);
    if (!Object.values(UNIT_RESULTS).includes(u.result)) return `判定の結果が選択肢に無い: ${JSON.stringify(u.result)}`;
    if (typeof u.reason !== 'string') return `判定の単位の理由が文字列でない: ${u.unit}`;
    if (u.result === UNIT_RESULTS.nonconform) {
      if (!Array.isArray(u.keys) || u.keys.length === 0 || !u.keys.every(isKey)) return `不適合の単位に候補の鍵が無い: ${u.unit}`;
      const stray = u.keys.find((k) => !keys.has(keyString(k)));
      if (stray) return `不適合の単位に、同じ結果の中に無い候補の鍵を添えた: ${u.unit} ${JSON.stringify(stray)}`;
    }
    if (u.result === UNIT_RESULTS.unchecked) {
      if (!Object.values(UNCHECKED_KINDS).includes(u.unchecked)) return `未検査の区分が選択肢に無い: ${u.unit}`;
      if (u.unchecked === UNCHECKED_KINDS.forced && !forced.has(u.unit)) return `強いられた未検査を、強いられた未検査でない単位に付けた: ${u.unit}`;
    }
  }
  const missing = [...want].filter((v) => !got.has(v));
  if (missing.length) return `判定の結果を付けていない単位がある: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` ほか ${missing.length - 5} 件` : ''}`;
  if (!Array.isArray(result.residualRisks) || !result.residualRisks.every((r) => r && ['role', 'restriction', 'host', 'reason'].every((f) => isStr(r[f])))) {
    return 'residualRisks は {role, restriction, host, reason} の並びでなければならない';
  }
  return null;
}

function checkGoal(result, assignment, specIds) {
  if (!Array.isArray(result.basisConstraints)) return 'basisConstraints が並びでない';
  for (const b of result.basisConstraints) {
    if (!b || !assignment.assets.includes(b.asset)) return `基準が求めた制約の資産 ID が担当に無い: ${JSON.stringify(b?.asset)}`;
    if (!specIds.includes(b.sp)) return `基準が求めた制約の仕様項目 ID が bp-conformance の写しに無い: ${JSON.stringify(b.sp)}`;
  }
  return null;
}

export function contractKind(element) {
  return `契約:${element}の変化`;
}

function checkContract(result, groundIds, specIds) {
  if (!Array.isArray(result.contractChanges)) return 'contractChanges が並びでない';
  const kinds = new Set((result.candidates ?? []).map((c) => c.kind));
  for (const c of result.contractChanges) {
    if (!c || !CONTRACT_ELEMENTS.includes(c.element)) return `契約の要素が選択肢に無い: ${JSON.stringify(c?.element)}`;
    if (!isStr(c.change)) return `契約の変化の中身が文字列でない: ${c.element}`;
    if (c.choice === CONTRACT_NONE) {
      if (!kinds.has(contractKind(c.element))) return `「該当なし」の変化に、その要素の指摘の種類の候補が無い: ${c.element}`;
    } else if (!groundIds.includes(c.choice) && !specIds.includes(c.choice)) {
      return `契約の変化に選んだものが、渡した修正の根拠の記録 ID でも bp-conformance の写しの仕様項目 ID でもない: ${JSON.stringify(c.choice)}`;
    }
  }
  return null;
}

const EXTRA_FIELDS = Object.freeze({
  conformance: ['applicability', 'units', 'residualRisks'],
  goal: ['basisConstraints'],
  contract: ['contractChanges'],
});

export function extraFields(viewpoint, result) {
  const fields = EXTRA_FIELDS[viewpoint] ?? [];
  if (!fields.length) return null;
  return Object.fromEntries(fields.map((f) => [f, result[f]]));
}

// 欄が欠けた結果を受けると、合否の段で判定の単位を付けていない単位が残る（SP-BPCONFORMANCE-018）。
export function checkExtra(viewpoint, result, { criteriaDir, assignment, groundIds }) {
  if (!Object.hasOwn(VIEWPOINTS, viewpoint)) return null;
  const missing = (EXTRA_FIELDS[viewpoint] ?? []).filter((f) => !Object.hasOwn(result, f));
  if (missing.length) return `create・update の${VIEWPOINTS[viewpoint]}の結果に欄が無い: ${missing.join('・')}`;
  if (viewpoint === 'conformance') return checkConformance(result, applicability(criteriaDir));
  if (viewpoint === 'goal') return checkGoal(result, assignment, specItemIds(criteriaDir));
  if (viewpoint === 'contract') return checkContract(result, groundIds, specItemIds(criteriaDir));
  return null;
}

// review・audit の検証役の足した欄（SP-BPINSPECTION-017）。範囲は観点の全体・判定の単位・監査の観点の識別子だけで、値はその観点の閉集合から選ぶ。
export function checkInspectExtra(viewpoint, result, { criteriaDir, fn, viewpoints, forced }) {
  if (!Array.isArray(result.unchecked)) return 'review・audit の検証役の結果に未検査の観点の候補 unchecked の並びが無い';
  for (const u of result.unchecked) {
    if (!u || !Object.values(UNCHECKED_SCOPES).includes(u.scope)) return `未検査の観点の候補の範囲が ${Object.values(UNCHECKED_SCOPES).join('・')} のどれでもない: ${JSON.stringify(u?.scope)}`;
    if (!viewpoints.includes(u.viewpoint)) return `未検査の観点の候補の観点が run の観点の集合に無い: ${JSON.stringify(u.viewpoint)}`;
    if (!isStr(u.reason)) return `未検査の観点の候補の理由が文字列でない: ${JSON.stringify(u.value)}`;
    if (u.scope === UNCHECKED_SCOPES.whole) {
      if (u.value !== u.viewpoint) return `観点の全体の未検査の値は観点そのもの: ${JSON.stringify(u.value)}`;
      continue;
    }
    if ((u.scope === UNCHECKED_SCOPES.pa) !== (u.viewpoint === VIEWPOINT.audit)) return `監査の観点の識別子の範囲は監査の観点だけが持つ: ${u.viewpoint}/${u.scope}`;
    const kinds = new Set(kindsFor(criteriaDir, u.viewpoint, fn).map((k) => k.value));
    if (!kinds.has(u.value)) return `未検査の観点の候補の値がその観点の閉集合に無い: ${JSON.stringify(u.value)}`;
  }
  if (viewpoint === VIEWPOINT.flow) {
    const stray = (result.candidates ?? []).find((c) => forced.includes(c.kind));
    if (stray) return `強いられた未検査の判定の単位を指摘の種類にした候補: ${stray.kind}（未検査の観点として載る：SP-BPINSPECTION-025）`;
  }
  return null;
}

export function inspectExtraFields(result) {
  return { unchecked: result.unchecked };
}
