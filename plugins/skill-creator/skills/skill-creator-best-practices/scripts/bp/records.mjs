import { canonical, keyString } from './ids.mjs';
import { CODES } from './constants.mjs';
import { reject } from './errors.mjs';

// 記録の種類ごとの同一性の鍵。同じ鍵で同じ内容なら足さず、違う内容なら拒否する（SP-BPRUN-006）。
export const IDENTITY = Object.freeze({
  state: () => 'state',
  ground: (r) => `ground|${r.id}`,
  run: (r) => `run|${r.id}`,
  premise: (r) => `premise|${r.run}|${r.kind}|${r.hash}`,
  paths: (r) => `paths|${r.n}`,
  fingerprint: (r) => `fingerprint|${r.run}|${r.at}|${r.n}`,
  stage: (r) => `stage|${r.stage}|${r.round ?? ''}`,
  result: (r) => `result|${r.item}`,
  fail: (r) => `fail|${r.item}|${r.attempt}`,
  abort: (r) => `abort|${r.item}`,
  discard: (r) => `discard|${r.item}`,
  stageEnd: (r) => `stageEnd|${r.stage}|${r.round ?? ''}`,
  repeat: (r) => `repeat|${r.stage}|${r.n}`,
  file: (r) => `file|${r.run}|${r.path}|${r.action}`,
  verified: (r) => `verified|${r.run}|${r.path}|${r.iteration}`,
  stop: (r) => `stop|${r.run}`,
  ledger: () => 'ledger',
  asset: (r) => `asset|${r.id}`,
  digest: (r) => `digest|${r.id}|${r.retake}`,
  gone: (r) => `gone|${r.id}|${r.retake}`,
  assignment: (r) => `assignment|${r.id}`,
  seen: (r) => `seen|${r.item}|${r.asset}`,
  candidate: (r) => `candidate|${r.item}|${keyString(r.key)}`,
  dup: (r) => `dup|${r.item}|${keyString(r.key)}`,
  rejected: (r) => `rejected|${r.scope}|${r.attempt}`,
  refute: (r) => `refute|${r.item}`,
  unrefuted: (r) => `unrefuted|${r.item}|${r.attempt}`,
  finding: (r) => `finding|${r.id}`,
  fstate: (r) => `fstate|${r.finding}|${r.run}|${r.round}`,
  judgement: (r) => `judgement|${r.finding}|${r.run}|${r.round}`,
  addAsset: (r) => `addAsset|${r.finding}|${r.asset}`,
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
