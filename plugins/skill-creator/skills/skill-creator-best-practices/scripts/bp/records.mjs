import { canonical, keyString } from './ids.mjs';
import { CODES, RECORDS } from './constants.mjs';
import { reject } from './errors.mjs';

// 状態の行の位置（seq・line）を外した記録。送り直しに同じ記録を返すときの形。
export const strip = ({ seq, line, ...record }) => record;

export const IDENTITY = Object.freeze({
  [RECORDS.state]: () => RECORDS.state,
  [RECORDS.ground]: (r) => `${r.t}|${r.id}`,
  [RECORDS.run]: (r) => `${r.t}|${r.id}`,
  [RECORDS.premise]: (r) => `${r.t}|${r.run}|${r.kind}|${r.hash}`,
  [RECORDS.paths]: (r) => `${r.t}|${r.n}`,
  [RECORDS.fingerprint]: (r) => `${r.t}|${r.run}|${r.at}|${r.n}`,
  [RECORDS.stage]: (r) => `${r.t}|${r.stage}|${r.round ?? ''}${r.part == null ? '' : `|${r.part}`}`,
  [RECORDS.result]: (r) => `${r.t}|${r.item}`,
  [RECORDS.fail]: (r) => `${r.t}|${r.item}|${r.attempt}`,
  [RECORDS.abort]: (r) => `${r.t}|${r.item}`,
  [RECORDS.discard]: (r) => `${r.t}|${r.item}`,
  [RECORDS.stageEnd]: (r) => `${r.t}|${r.stage}|${r.round ?? ''}`,
  [RECORDS.repeat]: (r) => `${r.t}|${r.stage}|${r.n}`,
  [RECORDS.file]: (r) => `${r.t}|${r.run}|${r.path}|${r.iteration}|${r.action}`,
  [RECORDS.verified]: (r) => `${r.t}|${r.run}|${r.path}|${r.iteration}`,
  [RECORDS.stop]: (r) => `${r.t}|${r.run}`,
  [RECORDS.ledger]: () => RECORDS.ledger,
  [RECORDS.asset]: (r) => `${r.t}|${r.id}`,
  [RECORDS.digest]: (r) => `${r.t}|${r.id}|${r.retake}`,
  [RECORDS.gone]: (r) => `${r.t}|${r.id}|${r.retake}`,
  [RECORDS.assignment]: (r) => `${r.t}|${r.id}`,
  [RECORDS.seen]: (r) => `${r.t}|${r.item}|${r.asset}`,
  [RECORDS.candidate]: (r) => `${r.t}|${r.item}|${keyString(r.key)}`,
  [RECORDS.dup]: (r) => `${r.t}|${r.item}|${keyString(r.key)}`,
  [RECORDS.rejected]: (r) => `${r.t}|${r.scope}|${r.attempt}|${r.sum}`,
  [RECORDS.refute]: (r) => `${r.t}|${r.item}`,
  [RECORDS.unrefuted]: (r) => `${r.t}|${r.item}|${r.attempt}`,
  [RECORDS.finding]: (r) => `${r.t}|${r.id}`,
  [RECORDS.fstate]: (r) => `${r.t}|${r.finding}|${r.run}|${r.round}`,
  [RECORDS.judgement]: (r) => `${r.t}|${r.finding}|${r.run}|${r.round}`,
  [RECORDS.addAsset]: (r) => `${r.t}|${r.finding}|${r.asset}`,
  [RECORDS.snapshot]: () => RECORDS.snapshot,
  [RECORDS.extra]: (r) => `${r.t}|${r.item}`,
  [RECORDS.target]: (r) => `${r.t}|${r.run}`,
  [RECORDS.bundle]: (r) => `${r.t}|${r.generation}`,
  [RECORDS.applicability]: () => RECORDS.applicability,
});

export function identity(record) {
  const fn = IDENTITY[record.t];
  if (!fn) throw new Error(`未知の記録の種類: ${record.t}`);
  return fn(record);
}

export function classify(view, record) {
  const key = identity(record);
  const existing = view.byKey.get(key);
  if (existing === undefined) return 'new';
  if (existing === canonical(record)) return 'same';
  return { conflict: key };
}

export function freshRecords(view, records) {
  const fresh = [];
  const seen = new Map();
  for (const record of records) {
    const key = identity(record);
    const content = canonical(record);
    if (seen.has(key)) {
      if (seen.get(key) !== content) reject(CODES.conflict, `同じ書き込みの中で記録が食い違う: ${key}`);
      continue;
    }
    seen.set(key, content);
    const verdict = classify(view, record);
    if (verdict === 'same') continue;
    if (verdict !== 'new') reject(CODES.conflict, `既にある記録と食い違う: ${verdict.conflict}`, { key: verdict.conflict });
    fresh.push(record);
  }
  return fresh;
}
