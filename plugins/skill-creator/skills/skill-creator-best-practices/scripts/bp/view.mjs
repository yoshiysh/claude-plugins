import { canonical, keyString } from './ids.mjs';
import { identity } from './records.mjs';
import { REVIEW_VALUES, STOP_KINDS } from './constants.mjs';

function stageKey(stage, round) {
  return `${stage}|${round ?? ''}`;
}

export function buildView(lines) {
  const v = {
    lastSeq: 0,
    byKey: new Map(),
    state: null,
    grounds: [],
    premises: [],
    runs: [],
    stops: new Map(),
    paths: [],
    fingerprints: [],
    stages: new Map(),
    stageOrder: [],
    items: new Map(),
    iterations: 0,
    repeats: new Map(),
    files: [],
    verified: [],
    ledger: null,
    assets: new Map(),
    retakes: 0,
    gones: [],
    assignments: new Map(),
    seen: [],
    candidates: [],
    dups: [],
    rejected: [],
    refutes: new Map(),
    unrefuted: [],
    findings: new Map(),
  };
  let n = 0;
  for (const line of lines) {
    v.lastSeq = line.seq;
    for (const record of line.records) {
      n += 1;
      const r = { ...record, seq: n, line: line.seq };
      v.byKey.set(identity(record), canonical(record));
      apply(v, r);
    }
  }
  return v;
}

function apply(v, r) {
  switch (r.t) {
    case 'state': v.state = r; break;
    case 'ground': v.grounds.push(r); break;
    case 'premise': v.premises.push(r); break;
    case 'run': v.runs.push(r); break;
    case 'stop': v.stops.set(r.run, r); break;
    case 'paths': v.paths.push(r); break;
    case 'fingerprint': v.fingerprints.push(r); break;
    case 'stage': {
      const key = stageKey(r.stage, r.round);
      v.stages.set(key, { stage: r.stage, round: r.round ?? null, items: r.items.map((i) => i.id), seq: r.seq, ended: false });
      v.stageOrder.push(key);
      for (const item of r.items) {
        if (!v.items.has(item.id)) {
          v.items.set(item.id, { id: item.id, key: item.key, stage: r.stage, round: r.round ?? null, result: undefined, fails: [], aborted: null, discarded: null });
        }
      }
      break;
    }
    case 'stageEnd': {
      const s = v.stages.get(stageKey(r.stage, r.round));
      if (s) { s.ended = true; s.endSeq = r.seq; }
      break;
    }
    case 'result': {
      v.items.get(r.item).result = r;
      if (r.iteration != null) v.iterations = Math.max(v.iterations, r.iteration);
      break;
    }
    case 'fail': v.items.get(r.item).fails.push(r); break;
    case 'abort': v.items.get(r.item).aborted = r; break;
    case 'discard': v.items.get(r.item).discarded = r; break;
    case 'repeat': v.repeats.set(r.stage, Math.max(v.repeats.get(r.stage) ?? 0, r.n)); break;
    case 'file': v.files.push(r); break;
    case 'verified': v.verified.push(r); break;
    case 'ledger': v.ledger = r; break;
    case 'asset': v.assets.set(r.id, { id: r.id, path: r.path, loc: r.loc, order: v.assets.size, digest: null, gone: false, history: [] }); break;
    case 'digest': {
      const a = v.assets.get(r.id);
      a.digest = r.digest; a.gone = false; a.history.push(r);
      v.retakes = Math.max(v.retakes, r.retake);
      break;
    }
    case 'gone': {
      const a = v.assets.get(r.id);
      a.gone = true; a.history.push(r);
      v.gones.push(r);
      v.retakes = Math.max(v.retakes, r.retake);
      break;
    }
    case 'assignment': v.assignments.set(r.id, r); break;
    case 'seen': v.seen.push(r); break;
    case 'candidate': v.candidates.push(r); break;
    case 'dup': v.dups.push(r); break;
    case 'rejected': v.rejected.push(r); break;
    case 'refute': v.refutes.set(r.item, r); break;
    case 'unrefuted': v.unrefuted.push(r); break;
    case 'finding': v.findings.set(r.id, { ...r, order: v.findings.size, assets: [r.key.asset], keys: [keyString(r.key)], states: [], decisions: [], judgements: [] }); break;
    case 'fstate': {
      const f = v.findings.get(r.finding);
      f.states.push(r);
      if (r.value !== REVIEW_VALUES.unknown) f.decisions.push(r);
      break;
    }
    case 'judgement': {
      const f = v.findings.get(r.finding);
      f.judgements.push(r);
      if (r.value !== REVIEW_VALUES.unknown) f.decisions.push(r);
      break;
    }
    case 'addAsset': {
      const f = v.findings.get(r.finding);
      f.assets.push(r.asset);
      f.keys.push(keyString({ asset: r.asset, viewpoint: f.key.viewpoint, kind: f.key.kind }));
      break;
    }
    default: throw new Error(`未知の記録の種類: ${r.t}`);
  }
}

export function currentRun(v) {
  return v.runs.at(-1) ?? null;
}

export function isCompleted(v) {
  const run = currentRun(v);
  return Boolean(run && v.stops.get(run.id)?.kind === STOP_KINDS.complete);
}

export function attempts(item) {
  return item.fails.length;
}

export function stageEntry(v, stage, round) {
  return v.stages.get(stageKey(stage, round)) ?? null;
}

function openOrLastStage(v) {
  const open = [...v.stageOrder].reverse().map((k) => v.stages.get(k)).find((s) => !s.ended);
  if (open) return { stage: open.stage, round: open.round, status: 'open' };
  const finished = [...v.stages.values()].filter((s) => s.ended).sort((a, b) => a.endSeq - b.endSeq).at(-1);
  if (finished) return { stage: finished.stage, round: finished.round, status: 'finished' };
  return { stage: null, round: null, status: 'none' };
}

// 止まった段の決め方（SP-BPRUN-018）。1: 現在でない最後の run の停止の記録、2: 終わりの無い最後の段、3: 最後に終えた段、4: 未開始。
export function stoppedStage(v, { includeCurrentRun = false } = {}) {
  const runs = includeCurrentRun ? v.runs : v.runs.slice(0, -1);
  const last = runs.at(-1);
  const stop = last ? v.stops.get(last.id) : null;
  if (stop && stop.stage) return { ...stop.stage, status: 'stopped' };
  return openOrLastStage(v);
}

export function pendingItems(v, ref) {
  if (!ref || ref.stage == null) return [];
  const entry = stageEntry(v, ref.stage, ref.round);
  if (!entry) return [];
  return entry.items.filter((id) => {
    const item = v.items.get(id);
    return item.result === undefined && !item.aborted && !item.discarded;
  });
}

export function runBase(v) {
  return currentRun(v)?.base ?? { iterations: 0, repeats: {} };
}

export function currentAssets(v) {
  return [...v.assets.values()].filter((a) => !a.gone).sort((a, b) => a.order - b.order);
}

export function lastFingerprint(v, { beforeRun } = {}) {
  const list = beforeRun ? v.fingerprints.filter((f) => f.run !== beforeRun) : v.fingerprints;
  return list.at(-1) ?? null;
}
