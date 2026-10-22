import { canonical, keyString } from './ids.mjs';
import { identity } from './records.mjs';
import { INSPECT_PIPELINE, RECORDS, REVIEW_VALUES, REWRITING_FUNCTIONS, RUN_VIEWPOINTS, STAGE, STAGE_STATUS, STOP_KINDS, emptyRunBase } from './constants.mjs';

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
    snapshot: null,
    extras: new Map(),
    targets: [],
    bundles: [],
    applicability: null,
    lineRuns: new Map(),
  };
  let n = 0;
  for (const line of lines) {
    v.lastSeq = line.seq;
    v.lineRuns.set(line.seq, line.run);
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
    case RECORDS.state: v.state = r; break;
    case RECORDS.ground: v.grounds.push(r); break;
    case RECORDS.premise: v.premises.push(r); break;
    case RECORDS.run: v.runs.push(r); break;
    case RECORDS.stop: v.stops.set(r.run, r); break;
    case RECORDS.paths: v.paths.push(r); break;
    case RECORDS.fingerprint: v.fingerprints.push(r); break;
    case RECORDS.stage: {
      const key = stageKey(r.stage, r.round);
      const known = v.stages.get(key);
      if (known) {
        known.items.push(...r.items.map((i) => i.id).filter((id) => !known.items.includes(id)));
        known.parts = Math.max(known.parts, r.part ?? 1);
      } else {
        v.stages.set(key, { stage: r.stage, round: r.round ?? null, items: r.items.map((i) => i.id), seq: r.seq, ended: false, parts: r.part ?? 1 });
        v.stageOrder.push(key);
      }
      for (const item of r.items) {
        if (!v.items.has(item.id)) {
          v.items.set(item.id, { id: item.id, key: item.key, stage: r.stage, round: r.round ?? null, result: undefined, fails: [], aborted: null, discarded: null });
        }
      }
      break;
    }
    case RECORDS.stageEnd: {
      const s = v.stages.get(stageKey(r.stage, r.round));
      if (s) { s.ended = true; s.endSeq = r.seq; s.endLine = r.line; }
      break;
    }
    case RECORDS.result: {
      v.items.get(r.item).result = r;
      if (r.iteration != null) v.iterations = Math.max(v.iterations, r.iteration);
      break;
    }
    case RECORDS.fail: v.items.get(r.item).fails.push(r); break;
    case RECORDS.abort: v.items.get(r.item).aborted = r; break;
    case RECORDS.discard: v.items.get(r.item).discarded = r; break;
    case RECORDS.repeat: v.repeats.set(r.stage, Math.max(v.repeats.get(r.stage) ?? 0, r.n)); break;
    case RECORDS.file: v.files.push(r); break;
    case RECORDS.verified: v.verified.push(r); break;
    case RECORDS.ledger: v.ledger = r; break;
    case RECORDS.asset: v.assets.set(r.id, { id: r.id, path: r.path, loc: r.loc, order: v.assets.size, digest: null, gone: false, history: [] }); break;
    case RECORDS.digest: {
      const a = v.assets.get(r.id);
      a.digest = r.digest; a.gone = false; a.history.push(r);
      v.retakes = Math.max(v.retakes, r.retake);
      break;
    }
    case RECORDS.gone: {
      const a = v.assets.get(r.id);
      a.gone = true; a.history.push(r);
      v.gones.push(r);
      v.retakes = Math.max(v.retakes, r.retake);
      break;
    }
    case RECORDS.assignment: v.assignments.set(r.id, r); break;
    case RECORDS.seen: v.seen.push(r); break;
    case RECORDS.candidate: v.candidates.push(r); break;
    case RECORDS.dup: v.dups.push(r); break;
    case RECORDS.rejected: v.rejected.push(r); break;
    case RECORDS.refute: v.refutes.set(r.item, r); break;
    case RECORDS.unrefuted: v.unrefuted.push(r); break;
    case RECORDS.finding: v.findings.set(r.id, { ...r, order: v.findings.size, assets: [r.key.asset], keys: [keyString(r.key)], states: [], decisions: [], judgements: [] }); break;
    case RECORDS.fstate: {
      const f = v.findings.get(r.finding);
      f.states.push(r);
      if (r.value !== REVIEW_VALUES.unknown) f.decisions.push(r);
      break;
    }
    case RECORDS.judgement: {
      const f = v.findings.get(r.finding);
      f.judgements.push(r);
      if (r.value !== REVIEW_VALUES.unknown) f.decisions.push(r);
      break;
    }
    case RECORDS.addAsset: {
      const f = v.findings.get(r.finding);
      f.assets.push(r.asset);
      f.keys.push(keyString({ asset: r.asset, viewpoint: f.key.viewpoint, kind: f.key.kind }));
      break;
    }
    case RECORDS.snapshot: v.snapshot = r; break;
    case RECORDS.extra: v.extras.set(r.item, r); break;
    case RECORDS.target: v.targets.push(r); break;
    case RECORDS.bundle: v.bundles.push(r); break;
    case RECORDS.applicability: v.applicability = r; break;
    default: throw new Error(`未知の記録の種類: ${r.t}`);
  }
}

// script は stage-start と停止の段の項目の両方からこの形を同じ意味で読む。
export function itemStatus(item) {
  return { id: item.id, attempts: item.fails.length, result: item.result !== undefined, aborted: Boolean(item.aborted), discarded: Boolean(item.discarded) };
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
  if (open) return { stage: open.stage, round: open.round, status: STAGE_STATUS.open };
  const finished = [...v.stages.values()].filter((s) => s.ended).sort((a, b) => a.endSeq - b.endSeq).at(-1);
  if (finished) return { stage: finished.stage, round: finished.round, status: STAGE_STATUS.finished };
  return { stage: null, round: null, status: STAGE_STATUS.none };
}

export function stoppedStage(v, { includeCurrentRun = false } = {}) {
  const runs = includeCurrentRun ? v.runs : v.runs.slice(0, -1);
  const last = runs.at(-1);
  const stop = last ? v.stops.get(last.id) : null;
  if (stop && stop.stage) return { ...stop.stage, status: STAGE_STATUS.stopped };
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
  return currentRun(v)?.base ?? emptyRunBase();
}

export function currentAssets(v) {
  return [...v.assets.values()].filter((a) => !a.gone).sort((a, b) => a.order - b.order);
}

export function lastFingerprint(v, { beforeRun } = {}) {
  const list = beforeRun ? v.fingerprints.filter((f) => f.run !== beforeRun) : v.fingerprints;
  return list.at(-1) ?? null;
}

// 照らす先の段を終えた行より前の最後の記録だけを有効にする。照らせずに止まった前の run の記録が、直した後の観点の集合に残らないようにするため。
export function validTarget(v) {
  const s = stageEntry(v, STAGE.targets, null);
  if (!s?.ended) return null;
  return v.targets.filter((t) => t.line <= s.endLine).at(-1) ?? null;
}

export function runViewpoints(v) {
  const fn = v.state.function;
  if (REWRITING_FUNCTIONS.has(fn)) return RUN_VIEWPOINTS[fn];
  return validTarget(v)?.viewpoints ?? [];
}

// review・audit の再開が続ける段は、段の並びで最も後ろの始めた段（消えた資産の照合は並びの外）。
export function reachedStage(v) {
  const started = INSPECT_PIPELINE.filter((stage) => stageEntry(v, stage, null));
  const stage = started.at(-1);
  return stage ? { stage, finished: stageEntry(v, stage, null).ended } : null;
}
