import {
  CODES, FINDING_STATES, JUDGEMENTS, REFUTATION_VERDICTS, REVIEW_VALUES, REWRITING_FUNCTIONS, STAGES, VANISH_NONE,
  VERIFY_STAGES, VIEWPOINTS,
} from './constants.mjs';
import { internal, reject } from './errors.mjs';
import { assignmentId, canonical, findingId, fingerprintSet, keyString } from './ids.mjs';
import { kindsFor } from './kinds.mjs';
import { createLedgerRecords, enumerateAssets, retakeRecords } from './ledger.mjs';
import { nextState, reviewJudgement } from './judge.mjs';
import { ledgerReport, liveAssets, skipList } from './report.mjs';
import { mutate, readState } from './store.mjs';
import { currentAssets, currentRun } from './view.mjs';

const { exists, absent, unknown, skip } = REVIEW_VALUES;

function needLedger(view) {
  if (!view.ledger) reject(CODES.unknownId, '状態に台帳が無い');
}

function checkViewpoint(viewpoint) {
  if (!Object.hasOwn(VIEWPOINTS, viewpoint)) reject(CODES.unknownId, `観点が無い: ${JSON.stringify(viewpoint)}`);
}

function itemIn(view, id, stages) {
  const item = view.items.get(id);
  if (!item || !stages.includes(item.stage)) reject(CODES.unknownId, `状態に無い${stages.map((s) => STAGES[s]).join('・')}の段の項目の ID: ${JSON.stringify(id)}`);
  if (item.aborted || item.discarded) reject(CODES.conflict, `打ち切りか破棄の記録がある項目に結果を書けない: ${id}`);
  return item;
}

function fpsOf(view, assetIds) {
  const fps = {};
  for (const id of assetIds) fps[id] = view.assets.get(id).digest;
  return fps;
}

// 結果の値が台帳・閉集合・選択肢に無いときは、拒否の件数と担当を記録して E_RESULT を返す（SP-BPFINDINGS-034）。
function rejected(scope, attempt, assignment, reason) {
  return {
    records: [{ t: 'rejected', scope, attempt, assignment, reason }],
    error: { code: CODES.result, reason },
  };
}

export function ledgerCreate(ctx, req) {
  return mutate(ctx, req, 'ledger-create', async (view) => {
    const assets = await enumerateAssets(view.paths.at(-1));
    if (assets.length === 0) reject(CODES.input, `対象スキルの資産が 0 件なので台帳を作らない: ${view.paths.at(-1).root}`);
    return {
      records: createLedgerRecords(view, assets, { ledgerId: view.state.id, rewriting: REWRITING_FUNCTIONS.has(view.state.function) }),
      output: (after) => ({ ledger: after.ledger.id, assets: currentAssets(after).map((a) => ({ id: a.id, path: a.path, loc: a.loc, digest: a.digest })) }),
    };
  });
}

export function ledgerRetake(ctx, req) {
  return mutate(ctx, req, 'ledger-retake', async (view) => {
    needLedger(view);
    const r = retakeRecords(view, await enumerateAssets(view.paths.at(-1)));
    return { records: r.records, output: { counts: r.counts, gone: r.gone, retake: r.records.length ? r.retake : null } };
  });
}

export function assignments(ctx, req) {
  return mutate(ctx, req, 'assignments', (view) => {
    needLedger(view);
    if (!Object.hasOwn(STAGES, req.stage)) reject(CODES.unknownId, `段の名前が無い: ${JSON.stringify(req.stage)}`);
    let groups;
    if (req.rule === 'all') groups = [currentAssets(view).map((a) => a.id)];
    else if (req.rule === 'skip') {
      checkViewpoint(req.viewpoint);
      const list = skipList(view, req.viewpoint).map((a) => a.id);
      groups = list.length ? [list] : [];
    } else if (Array.isArray(req.groups)) {
      const attempt = req.attempt ?? (view.repeats.get(req.stage) ?? 0) + 1;
      for (const group of req.groups) {
        const bad = !Array.isArray(group) || group.length === 0 ? ['（空か並びでない組）'] : group.filter((id) => !view.assets.get(id) || view.assets.get(id).gone);
        if (bad.length) return rejected(`assign:${req.stage}`, attempt, null, `担当の組に台帳の今の資産に無い ID がある: ${bad.join(', ')}`);
      }
      groups = req.groups;
    } else reject(CODES.input, 'groups か rule（all・skip）が要る');
    const records = [];
    const out = [];
    let n = [...view.assignments.values()].filter((a) => a.stage === req.stage).length;
    for (const group of groups) {
      const assets = [...new Set(group)];
      const fps = fpsOf(view, assets);
      const fpset = fingerprintSet(fps);
      const known = [...view.assignments.values()].find((a) => a.stage === req.stage && canonical(a.assets) === canonical(assets) && a.fpset === fpset);
      const id = known?.id ?? assignmentId(req.stage, (n += 1));
      if (!known) records.push({ t: 'assignment', id, stage: req.stage, assets, fps, fpset });
      out.push({ id, assets, fpset });
    }
    return { records, output: { assignments: out } };
  });
}

function lastDecision(finding) {
  return finding.decisions.at(-1) ?? null;
}

function findingWithKey(view, keyStr) {
  return [...view.findings.values()].find((f) => f.keys.includes(keyStr)) ?? null;
}

function checkVerdictResult(result, assignment, viewpoint, kinds) {
  if (result === null || typeof result !== 'object' || !Array.isArray(result.judgements)) return '結果に judgements の並びが無い';
  const judged = new Map();
  for (const j of result.judgements) {
    if (!j || !assignment.assets.includes(j.asset)) return `担当に無い資産 ID の判定: ${JSON.stringify(j?.asset)}`;
    if (!Object.values(JUDGEMENTS).includes(j.judgement)) return `判定が選択肢に無い: ${JSON.stringify(j.judgement)}`;
    if (judged.has(j.asset)) return `同じ資産の判定が 2 つある: ${j.asset}`;
    judged.set(j.asset, j.judgement);
  }
  const candidates = result.candidates ?? [];
  if (!Array.isArray(candidates)) return 'candidates が並びでない';
  for (const c of candidates) {
    if (!c || judged.get(c.asset) !== JUDGEMENTS.candidate) return `判定が「候補あり」でない資産の候補: ${JSON.stringify(c?.asset)}`;
    if (c.viewpoint !== viewpoint) return `候補の観点が担当の観点と違う: ${JSON.stringify(c.viewpoint)}`;
    if (!kinds.has(c.kind)) return `観点の閉集合に無い指摘の種類: ${JSON.stringify(c.kind)}`;
    for (const field of ['quote', 'content', 'fix']) if (typeof c[field] !== 'string') return `候補の ${field} が文字列でない`;
  }
  for (const [asset, value] of judged) {
    if (value === JUDGEMENTS.candidate && !candidates.some((c) => c.asset === asset)) return `「候補あり」の資産に候補が無い: ${asset}`;
  }
  return null;
}

export function verdicts(ctx, req) {
  return mutate(ctx, req, 'verdicts', (view) => {
    needLedger(view);
    const item = itemIn(view, req.item, [...VERIFY_STAGES]);
    const assignment = view.assignments.get(req.assignment);
    if (!assignment) reject(CODES.unknownId, `状態に無い担当 ID: ${JSON.stringify(req.assignment)}`);
    checkViewpoint(req.viewpoint);
    const kinds = new Set(kindsFor(ctx.criteriaDir, req.viewpoint, view.state.function).map((k) => k.value));
    const bad = checkVerdictResult(req.result, assignment, req.viewpoint, kinds);
    if (bad) return rejected(`item:${req.item}`, item.fails.length + 1, req.assignment, bad);
    const records = [{ t: 'result', item: req.item, result: { kind: 'verdicts', assignment: req.assignment, viewpoint: req.viewpoint } }];
    const counts = { seen: 0, ok: 0, unsure: 0, duplicates: 0 };
    for (const j of req.result.judgements) {
      records.push({ t: 'seen', item: req.item, asset: j.asset, viewpoint: req.viewpoint, assignment: assignment.id, fpset: assignment.fpset, digest: assignment.fps[j.asset], value: j.judgement });
      counts.seen += 1;
      if (j.judgement === JUDGEMENTS.ok) counts.ok += 1;
      if (j.judgement === JUDGEMENTS.unsure) counts.unsure += 1;
    }
    const grouped = new Map();
    for (const c of req.result.candidates ?? []) {
      const key = { asset: c.asset, viewpoint: c.viewpoint, kind: c.kind };
      const ks = keyString(key);
      if (!grouped.has(ks)) grouped.set(ks, { key, texts: [] });
      grouped.get(ks).texts.push({ quote: c.quote, content: c.content, fix: c.fix });
    }
    const refutationKeys = [];
    for (const [ks, g] of grouped) {
      const f = findingWithKey(view, ks);
      const d = f ? lastDecision(f) : null;
      if (d && (d.value === exists || d.basis === 'rejected') && d.fps[g.key.asset] === assignment.fps[g.key.asset]) {
        records.push({ t: 'dup', item: req.item, key: g.key, finding: f.id });
        counts.duplicates += 1;
      } else {
        records.push({ t: 'candidate', item: req.item, key: g.key, texts: g.texts, assignment: assignment.id, fpset: assignment.fpset, digest: assignment.fps[g.key.asset] });
        refutationKeys.push(g.key);
      }
    }
    return { records, output: { ...counts, refutationKeys } };
  });
}

function stageRefs(req) {
  const refs = req.stages;
  if (!Array.isArray(refs) || refs.length === 0) reject(CODES.input, 'stages は 1 つ以上の {stage, round} の並び');
  return refs.map((r) => ({ stage: r.stage, round: r.round ?? null }));
}

function inStages(item, refs) {
  return refs.some((r) => r.stage === item.stage && r.round === item.round);
}

export async function refutationItems(ctx, req) {
  const { view } = await readState(ctx, req.state);
  const refs = stageRefs(req);
  const keys = [];
  const seenKeys = new Set();
  for (const c of view.candidates) {
    if (!inStages(view.items.get(c.item), refs)) continue;
    const ks = keyString(c.key);
    if (seenKeys.has(ks)) continue;
    seenKeys.add(ks);
    keys.push(c.key);
  }
  return { keys };
}

function candidatesOfRefuteItem(view, item) {
  const ks = keyString(item.key);
  return view.candidates.filter((c) => {
    const ci = view.items.get(c.item);
    return keyString(c.key) === ks && VERIFY_STAGES.has(ci.stage) && ci.round === item.round;
  });
}

export function refutation(ctx, req) {
  return mutate(ctx, req, 'refutation', (view) => {
    needLedger(view);
    const item = itemIn(view, req.item, ['refute']);
    const cands = candidatesOfRefuteItem(view, item);
    if (cands.length === 0) reject(CODES.unknownId, `反証の項目に候補が無い: ${req.item}`);
    const attempt = item.fails.length + 1;
    if (req.verdict == null) {
      return { records: [{ t: 'unrefuted', item: req.item, attempt }], output: { unrefuted: true, finding: null, created: false, state: null } };
    }
    if (!Object.values(REFUTATION_VERDICTS).includes(req.verdict)) return rejected(`item:${req.item}`, attempt, null, `反証の結果が選択肢に無い: ${JSON.stringify(req.verdict)}`);
    if (typeof req.reason !== 'string') return rejected(`item:${req.item}`, attempt, null, '反証の理由が文字列でない');
    const records = [
      { t: 'refute', item: req.item, key: item.key, verdict: req.verdict, reason: req.reason },
      { t: 'result', item: req.item, result: { kind: 'refutation', verdict: req.verdict } },
    ];
    const ks = keyString(item.key);
    let f = findingWithKey(view, ks);
    let state = null;
    const created = !f;
    if (!f) {
      const id = findingId(view.ledger.id, item.key);
      if (view.findings.has(id)) internal(`指摘 ID が衝突した: ${id}`);
      const first = view.assignments.get(cands[0].assignment);
      const upheld = req.verdict === REFUTATION_VERDICTS.uphold;
      state = upheld ? FINDING_STATES.open : FINDING_STATES.dismissed;
      records.push(
        { t: 'finding', id, key: item.key, run: req.run },
        {
          t: 'fstate', finding: id, run: req.run, round: `refute:${req.item}`, state,
          value: upheld ? exists : absent, basis: upheld ? 'upheld' : 'rejected', fps: first.fps, fpset: first.fpset,
          ...(upheld ? {} : { reason: req.reason }),
        },
      );
      f = { id };
    }
    return { records, output: { unrefuted: false, finding: f.id, created, state } };
  });
}

function refuteVerdictOf(view, cand) {
  const ci = view.items.get(cand.item);
  const ks = keyString(cand.key);
  const refuteItem = [...view.items.values()].find((i) => i.stage === 'refute' && i.round === ci.round && keyString(i.key) === ks);
  return refuteItem ? view.refutes.get(refuteItem.id)?.verdict ?? null : null;
}

// 見直しの判定の入力（SP-BPFINDINGS-018 の 4 つの値）を、段の結果から作る。
export function reviewInput(view, finding, refs) {
  const d = lastDecision(finding);
  if (!d) internal(`判定の記録の無い指摘: ${finding.id}`);
  const assets = liveAssets(view, finding);
  const R = view.seen.filter((s) => s.viewpoint === finding.key.viewpoint && assets.includes(s.asset) && s.fpset !== d.fpset && inStages(view.items.get(s.item), refs));
  const content = assets.some((id) => d.fps[id] !== view.assets.get(id).digest) ? 'changed' : 'same';
  const items = new Set(R.map((s) => s.item));
  const cands = view.candidates.filter((c) => items.has(c.item) && finding.keys.includes(keyString(c.key)));
  const dups = view.dups.filter((c) => items.has(c.item) && finding.keys.includes(keyString(c.key)));
  let candidates = 'none';
  if (cands.length && dups.length) candidates = 'mixed_dup';
  else if (dups.length) candidates = 'dup';
  else if (cands.length) {
    const verdictsOf = cands.map((c) => refuteVerdictOf(view, c));
    if (verdictsOf.includes(REFUTATION_VERDICTS.uphold)) candidates = 'upheld';
    else if (verdictsOf.includes(null)) candidates = 'unrefuted';
    else candidates = 'rejected';
  }
  let judged = 'none';
  if (R.length) judged = R.some((s) => s.value !== JUDGEMENTS.unsure) ? 'decided' : 'unsure';
  const latest = R.at(-1);
  const fps = latest ? { ...d.fps, ...view.assignments.get(latest.assignment).fps } : d.fps;
  return { input: { r: R.length ? 'present' : 'empty', content, candidates, judged }, decision: d, fps };
}

const BASIS_BY_ROW = { 3: 'upheld', 6: 'rejected', 7: 'no-candidate' };

function decisionRecords(view, finding, { run, round, value, basis, fps }) {
  const last = finding.states.at(-1);
  const fpset = fingerprintSet(Object.fromEntries(Object.entries(fps).filter(([id]) => view.assets.get(id) && !view.assets.get(id).gone)));
  if (last.run === run) {
    const state = nextState(last.state, value);
    if (!view.ledger.rewriting && (state === FINDING_STATES.resolved || state === FINDING_STATES.regressed)) {
      reject(CODES.conflict, `書き換えない run の台帳に ${state} を記録できない: ${finding.id}`);
    }
    return { records: [{ t: 'fstate', finding: finding.id, run, round, state, value, basis, fps, fpset }], recorded: 'state', state };
  }
  return { records: [{ t: 'judgement', finding: finding.id, run, round, value, basis, fps, fpset }], recorded: 'judgement', state: null };
}

export function reviewJudge(ctx, req) {
  return mutate(ctx, req, 'review-judge', (view) => {
    needLedger(view);
    if (!view.ledger.rewriting) reject(CODES.conflict, '見直しは書き換える run の台帳だけで行う（書き換えない run では resolved・regressed を記録しない）');
    const refs = stageRefs(req);
    const round = `judge:${req.round ?? ''}`;
    const records = [];
    const results = [];
    for (const f of [...view.findings.values()].sort((a, b) => a.order - b.order)) {
      if (liveAssets(view, f).length === 0) { results.push({ finding: f.id, value: null, recorded: 'none', vanished: true }); continue; }
      const { input, decision, fps } = reviewInput(view, f, refs);
      const { row, value } = reviewJudgement(input, decision.value);
      if (value === skip) { results.push({ finding: f.id, value, row, recorded: 'none' }); continue; }
      const basis = value === unknown ? 'unknown' : row === 5 ? decision.basis : BASIS_BY_ROW[row];
      const out = decisionRecords(view, f, { run: req.run, round, value, basis, fps: value === unknown ? decision.fps : fps });
      records.push(...out.records);
      results.push({ finding: f.id, value, row, recorded: out.recorded, state: out.state });
    }
    return { records, output: { judgements: results } };
  });
}

export function vanishMatch(ctx, req) {
  return mutate(ctx, req, 'vanish-match', (view) => {
    needLedger(view);
    const item = itemIn(view, req.item, ['vanish']);
    const finding = view.findings.get(item.key?.finding);
    if (!finding) reject(CODES.unknownId, `消えた資産の照合の項目が台帳に無い指摘を指す: ${JSON.stringify(item.key?.finding)}`);
    const d = lastDecision(finding);
    let value;
    let fps = d.fps;
    const records = [{ t: 'result', item: req.item, result: { kind: 'vanish', choice: req.choice ?? null } }];
    if (req.choice == null) value = unknown;
    else if (req.choice === VANISH_NONE) value = absent;
    else {
      const asset = view.assets.get(req.choice);
      if (!asset || asset.gone) return rejected(`item:${req.item}`, item.fails.length + 1, null, `台帳の今の資産に無い ID を選んだ: ${JSON.stringify(req.choice)}`);
      value = exists;
      fps = { ...d.fps, [asset.id]: asset.digest };
      if (!finding.assets.includes(asset.id)) records.push({ t: 'addAsset', finding: finding.id, asset: asset.id });
    }
    const out = decisionRecords(view, finding, { run: req.run, round: `vanish:${req.item}`, value, basis: value === unknown ? 'unknown' : 'vanish', fps });
    records.push(...out.records);
    return { records, output: { finding: finding.id, value, recorded: out.recorded, state: out.state } };
  });
}

export async function report(ctx, req) {
  const { view } = await readState(ctx, req.state);
  needLedger(view);
  if (!Array.isArray(req.viewpoints)) reject(CODES.input, 'viewpoints は観点の並び');
  req.viewpoints.forEach(checkViewpoint);
  return { run: currentRun(view).id, ...ledgerReport(view, req.viewpoints) };
}

export async function kinds(ctx, req) {
  const { view } = await readState(ctx, req.state);
  checkViewpoint(req.viewpoint);
  return { viewpoint: req.viewpoint, kinds: kindsFor(ctx.criteriaDir, req.viewpoint, view.state.function) };
}
