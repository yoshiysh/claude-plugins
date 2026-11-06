import path from 'node:path';
import { FORMAL_KEYS, FORMAL_OUTCOMES, PROPERTY_KEYS, READABLE_KEYS, STAGE, STOP_CAUSES } from './constants.mjs';

const FORMALIZED_OUTCOMES = Object.freeze([FORMAL_OUTCOMES.holds, FORMAL_OUTCOMES.fails, FORMAL_OUTCOMES.unrunnable]);
const INFORMAL_OUTCOMES = Object.freeze([FORMAL_OUTCOMES.confirmed, FORMAL_OUTCOMES.unconfirmed]);
const REASONED_OUTCOMES = Object.freeze([FORMAL_OUTCOMES.fails, FORMAL_OUTCOMES.unrunnable]);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v !== '';
const strayKeys = (o, allowed) => Object.keys(o).filter((k) => !allowed.includes(k));

function inWork(p) {
  if (typeof p !== 'string' || p === '' || path.isAbsolute(p)) return false;
  const n = path.posix.normalize(p);
  return n !== '.' && !n.startsWith('../') && n !== '..';
}

// 要らない reason は書き方を問わず受ける（形式検証の段の E_RESULT は BLOCKED で止まるので、要らない欄の違いで止めない：SP-BPRUN-031）。
export function formalProblem(result) {
  if (!isObject(result)) return '形式検証の段の result がオブジェクトでない';
  const stray = strayKeys(result, Object.values(FORMAL_KEYS));
  if (stray.length) return `形式検証の段の result が 3 欄以外の欄を持つ: ${stray.join('・')}`;
  if (!inWork(result.workRecord)) return `workRecord が作業場所の work/ の下のパスでない: ${JSON.stringify(result.workRecord)}`;
  const { readable, properties } = result;
  if (!isObject(readable) || !Object.hasOwn(readable, READABLE_KEYS.ok) || typeof readable.ok !== 'boolean') return 'readable は真偽値の ok を持つオブジェクトでなければならない';
  const strayReadable = strayKeys(readable, Object.values(READABLE_KEYS));
  if (strayReadable.length) return `readable が ok・reason 以外の欄を持つ: ${strayReadable.join('・')}`;
  if (!readable.ok && !isText(readable.reason)) return 'readable.ok が false なのに readable.reason が空でない文字列でない';
  if (!Array.isArray(properties)) return 'properties が並びでない';
  if (!readable.ok && properties.length) return 'readable.ok が false なのに properties が空でない';
  for (const [i, p] of properties.entries()) {
    if (!isObject(p)) return `properties の ${i + 1} つ目がオブジェクトでない`;
    const missing = [PROPERTY_KEYS.target, PROPERTY_KEYS.formalized, PROPERTY_KEYS.outcome].filter((k) => !Object.hasOwn(p, k));
    if (missing.length) return `properties の ${i + 1} つ目に欄が無い: ${missing.join('・')}`;
    const strayProp = strayKeys(p, Object.values(PROPERTY_KEYS));
    if (strayProp.length) return `properties の ${i + 1} つ目が 4 欄以外の欄を持つ: ${strayProp.join('・')}`;
    if (typeof p.target !== 'string') return `properties の ${i + 1} つ目の target が文字列でない`;
    if (typeof p.formalized !== 'boolean') return `properties の ${i + 1} つ目の formalized が真偽値でない`;
    if (!(p.formalized ? FORMALIZED_OUTCOMES : INFORMAL_OUTCOMES).includes(p.outcome)) return `properties の ${i + 1} つ目の outcome が formalized と合わない: ${JSON.stringify(p.outcome)}`;
    const needsReason = !p.formalized || REASONED_OUTCOMES.includes(p.outcome);
    if (needsReason && !isText(p.reason)) return `properties の ${i + 1} つ目に要る reason が空でない文字列でない`;
  }
  return null;
}

// SP-BPAUTHORING-044 の判定表。
export function formalVerdict(result) {
  if (!result.readable.ok) return { passed: false, cause: STOP_CAUSES.formalUnrunnable };
  const fails = result.properties.some((p) => p.outcome === FORMAL_OUTCOMES.fails);
  const unrunnable = result.properties.some((p) => p.outcome === FORMAL_OUTCOMES.unrunnable);
  if (fails) return { passed: false, cause: STOP_CAUSES.formalFailed };
  if (unrunnable) return { passed: false, cause: STOP_CAUSES.formalUnrunnable };
  return { passed: true, cause: null };
}

export function formalItems(view) {
  return [...view.items.values()].filter((i) => i.stage === STAGE.formal);
}

// 最後の合否の段の結果より後に始めた形式検証の段の回のうち、最後の回の項目の結果（SP-BPAUTHORING-032 の formalVerification）。
export function formalAfterGate(view, gateItem) {
  if (!gateItem) return null;
  const after = formalItems(view).filter((i) => i.result !== undefined && i.result.seq > gateItem.result.seq);
  return after.sort((a, b) => a.result.seq - b.result.seq).at(-1)?.result.result ?? null;
}

export function formalRound(view) {
  const rounds = [...view.stages.values()].filter((s) => s.stage === STAGE.formal).sort((a, b) => a.seq - b.seq);
  return rounds.at(-1)?.round ?? null;
}

export function formalFails(view) {
  const round = formalRound(view);
  if (round === null) return null;
  const item = formalItems(view).find((i) => i.round === round && i.result !== undefined);
  if (!item) return null;
  return item.result.result.properties.filter((p) => p.outcome === FORMAL_OUTCOMES.fails).map((p) => ({ target: p.target, reason: p.reason }));
}
