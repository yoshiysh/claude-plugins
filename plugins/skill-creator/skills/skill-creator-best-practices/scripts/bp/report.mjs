import { BASIS, FINDING_STATES, JUDGEMENTS, OUTCOMES, RECORDS, REVIEW_VALUES } from './constants.mjs';
import { keyString } from './ids.mjs';
import { currentAssets, currentRun } from './view.mjs';

export function liveAssets(v, finding) {
  return finding.assets.filter((id) => v.assets.get(id) && !v.assets.get(id).gone);
}

export function judgedOnCurrent(v, finding) {
  const d = finding.decisions.at(-1);
  if (!d) return false;
  const assets = liveAssets(v, finding);
  // 資産が全て消えた指摘は、消えた資産の照合が今の資産の一覧に照らして「該当なし」とした判定だけを今の内容での判定とする。
  if (assets.length === 0) return d.basis === BASIS.vanish && d.value === REVIEW_VALUES.absent;
  return assets.every((id) => d.fps[id] === v.assets.get(id).digest);
}

function seenOnCurrent(v, asset, viewpoint) {
  return v.seen.filter((s) => s.asset === asset.id && s.viewpoint === viewpoint && s.digest === asset.digest);
}

export function coverage(v, viewpoint) {
  const assets = currentAssets(v);
  const seen = assets.filter((a) => seenOnCurrent(v, a, viewpoint).length > 0).length;
  return { viewpoint, seen, total: assets.length, ratio: `${seen}/${assets.length}` };
}

export function skipList(v, viewpoint) {
  return currentAssets(v).filter((a) => seenOnCurrent(v, a, viewpoint).length === 0).map((a) => ({ id: a.id, path: a.path, loc: a.loc }));
}

function findingByKey(v, key) {
  const s = keyString(key);
  return [...v.findings.values()].find((f) => f.keys.includes(s)) ?? null;
}

export function outcome(v, asset, viewpoint) {
  const live = [...v.findings.values()].filter((f) => f.key.viewpoint === viewpoint && f.assets.includes(asset.id));
  if (live.some((f) => {
    const last = f.states.at(-1);
    return last && (last.state === FINDING_STATES.open || last.state === FINDING_STATES.regressed) && last.fps[asset.id] === asset.digest;
  })) return OUTCOMES.finding;
  const seen = seenOnCurrent(v, asset, viewpoint);
  const flagged = seen.filter((s) => s.value === JUDGEMENTS.candidate);
  if (flagged.length > 0) {
    const covered = flagged.every((s) => {
      const items = [...v.candidates, ...v.dups].filter((c) => c.item === s.item && c.key.asset === asset.id);
      return items.length > 0 && items.every((c) => {
        if (c.t === RECORDS.dup) return true;
        const f = findingByKey(v, c.key);
        return f && f.states.at(-1)?.state === FINDING_STATES.dismissed;
      });
    });
    if (covered) return OUTCOMES.dismissedOnly;
  }
  if (seen.some((s) => s.value === JUDGEMENTS.ok)) return OUTCOMES.ok;
  if (seen.length > 0) return OUTCOMES.seenOnly;
  return OUTCOMES.skip;
}

export function outcomes(v, viewpoints) {
  return currentAssets(v).flatMap((a) => viewpoints.map((vp) => ({ asset: a.id, viewpoint: vp, outcome: outcome(v, a, vp) })));
}

function textsOf(v, finding) {
  const cand = v.candidates.filter((c) => finding.keys.includes(keyString(c.key))).at(-1);
  return cand?.texts[0] ?? { quote: null, content: null, fix: null };
}

export function findingsForResult(v) {
  const run = currentRun(v);
  const rewriting = v.ledger?.rewriting;
  return [...v.findings.values()].sort((a, b) => a.order - b.order).map((f) => {
    const last = f.states.at(-1);
    const texts = textsOf(v, f);
    const out = {
      id: f.id,
      function: v.state.function,
      viewpoint: f.key.viewpoint,
      kind: f.key.kind,
      assets: f.assets.map((id) => { const a = v.assets.get(id); return { id, path: a.path, loc: a.loc }; }),
      quote: texts.quote,
      content: texts.content,
      fix: texts.fix,
      stateRun: last.run,
      judgedOnCurrent: judgedOnCurrent(v, f),
    };
    if (!rewriting || last.run === run.id) out.state = last.state;
    const j = f.judgements.filter((x) => x.run === run.id).at(-1);
    if (j && (!rewriting || last.run !== run.id)) out.judgement = j.value;
    if (out.state === FINDING_STATES.dismissed) out.dismissReason = [...f.states].reverse().find((s) => s.reason)?.reason ?? null;
    return out;
  });
}

export function unrefutedCandidates(v) {
  return v.unrefuted.filter((u) => !v.refutes.has(u.item)).map((u) => ({ item: u.item, key: v.items.get(u.item).key }))
    .filter((u, i, all) => all.findIndex((x) => x.item === u.item) === i);
}

export function rejectedResults(v) {
  return { count: v.rejected.length, by: v.rejected.map((r) => ({ scope: r.scope, attempt: r.attempt, assignment: r.assignment ?? null, reason: r.reason })) };
}

export function ledgerReport(v, viewpoints) {
  return {
    findings: findingsForResult(v),
    coverage: viewpoints.map((vp) => coverage(v, vp)),
    skip: viewpoints.map((vp) => ({ viewpoint: vp, assets: skipList(v, vp) })),
    outcomes: outcomes(v, viewpoints),
    unrefuted: unrefutedCandidates(v),
    rejected: rejectedResults(v),
  };
}
