import { statSync } from 'node:fs';
import path from 'node:path';
import {
  ASSIGN_RULES, BASIS, CRITERIA_FILES, RECORDED, REJECT_SCOPE, CODES, FINDING_STATES, INSPECTING_FUNCTIONS, JUDGEMENTS, OPS, RECORDS, REFUTATION_VERDICTS, RESULT_KINDS, REVIEW_INPUT,
  REVIEW_VALUES, REWRITING_FUNCTIONS, ROUND_PREFIX, STAGE, STAGES, VANISH_NONE, VERIFY_STAGES, VIEWPOINTS,
} from './constants.mjs';
import { checkAttempt, checkStage, checkWritableItem } from './checks.mjs';
import { internal, reject } from './errors.mjs';
import { assignmentId, canonical, findingId, fingerprintSet, keyString, sum } from './ids.mjs';
import { kindsFor } from './kinds.mjs';
import { createLedgerRecords, enumerateAssets, retakeRecords } from './ledger.mjs';
import { nextState, reviewJudgement } from './judge.mjs';
import { ledgerReport, liveAssets, skipList } from './report.mjs';
import { mutate, readState } from './store.mjs';
import { checkExtra, checkInspectExtra, extraFields, inspectExtraFields } from './units.mjs';
import { treatedGroundIds } from './ops-author.mjs';
import { currentAssets, currentRun, runViewpoints, stageEntry } from './view.mjs';

const { exists, absent, unknown, skip } = REVIEW_VALUES;
const { r: R_IN, content: C_IN, candidates: K_IN, judged: J_IN } = REVIEW_INPUT;
const FOLD_ORDER = [exists, unknown, absent, skip];

export function needLedger(view) {
  if (!view.ledger) reject(CODES.unknownId, '状態に台帳が無い');
}

function checkViewpoint(viewpoint) {
  if (!Object.hasOwn(VIEWPOINTS, viewpoint)) reject(CODES.unknownId, `観点が無い: ${JSON.stringify(viewpoint)}`);
}

// 写しの欠けは配布物の欠けなので、閉集合を作らずに理由つきで拒否する（空の閉集合で判定すると、照らしていない基準を照らしたと返す：SP-BPRUN-036）。
function isKind(p, kind) {
  try {
    return statSync(p)[kind]();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

// 照らす先の決定（targets）は欠けた写しを「読めない」照らす先として返す（SP-BPINSPECTION-027）ので、置き場だけを求める。
export function needCriteria(ctx, { files = true } = {}) {
  if (!isKind(ctx.criteriaDir, 'isDirectory')) reject(CODES.input, `判定基準の写しが無いので観点の閉集合を作れない: ${ctx.criteriaDir}`);
  if (!files) return;
  const missing = Object.values(CRITERIA_FILES).map((parts) => path.join(ctx.criteriaDir, ...parts)).filter((p) => !isKind(p, 'isFile'));
  if (missing.length) reject(CODES.input, `判定基準の写しが欠けているので観点の閉集合を作れない: ${missing.join(', ')}`);
}

function itemIn(view, id, stages, { writable = true } = {}) {
  const item = view.items.get(id);
  if (!item || !stages.includes(item.stage)) reject(CODES.unknownId, `状態に無い${stages.map((s) => STAGES[s]).join('・')}の段の項目の ID: ${JSON.stringify(id)}`);
  if (writable) checkWritableItem(item);
  return item;
}

function liveFps(view, fps) {
  return Object.fromEntries(Object.entries(fps).filter(([id]) => view.assets.get(id) && !view.assets.get(id).gone));
}

function fpsOf(view, assetIds) {
  const fps = {};
  for (const id of assetIds) fps[id] = view.assets.get(id).digest;
  return fps;
}

export function rejected(scope, attempt, assignment, payload, reason) {
  return {
    records: [{ t: RECORDS.rejected, scope, attempt, sum: sum(payload ?? null), assignment, reason }],
    error: { code: CODES.result, reason },
  };
}

// 結果のある項目への送り直しは、後の書き込みで変わった台帳から分類し直すと記録が増えるので、最初の結果の記録とだけ照らす。
function resent(item, resultRecord, output) {
  if (item.result === undefined) return null;
  return { records: [resultRecord], output };
}

export function affectedFindings(view, gone) {
  const ids = new Set(gone.map((g) => g.id));
  return [...view.findings.values()].sort((a, b) => a.order - b.order).filter((f) => f.assets.some((a) => ids.has(a))).map((f) => f.id);
}

export function ledgerCreate(ctx, req) {
  return mutate(ctx, req, OPS.ledgerCreate, async (view) => {
    const assets = await enumerateAssets(view.paths.at(-1));
    if (assets.length === 0) reject(CODES.input, `対象スキルの資産が 0 件なので台帳を作らない: ${view.paths.at(-1).root}`);
    return {
      records: createLedgerRecords(view, assets, { ledgerId: view.state.id, rewriting: REWRITING_FUNCTIONS.has(view.state.function) }),
      output: (after) => ({ ledger: after.ledger.id, assets: currentAssets(after).map((a) => ({ id: a.id, path: a.path, loc: a.loc, digest: a.digest })) }),
    };
  });
}

export function ledgerRetake(ctx, req) {
  return mutate(ctx, req, OPS.ledgerRetake, async (view) => {
    needLedger(view);
    const r = retakeRecords(view, await enumerateAssets(view.paths.at(-1)));
    return { records: r.records, output: { counts: r.counts, gone: r.gone, retake: r.records.length ? r.retake : null, affected: affectedFindings(view, r.gone) } };
  });
}

export function assignments(ctx, req) {
  return mutate(ctx, req, OPS.assignments, (view) => {
    needLedger(view);
    checkStage(req.stage);
    let groups;
    if (req.rule === ASSIGN_RULES.all) groups = [currentAssets(view).map((a) => a.id)];
    else if (req.rule === ASSIGN_RULES.skip) {
      checkViewpoint(req.viewpoint);
      const list = skipList(view, req.viewpoint).map((a) => a.id);
      groups = list.length ? [list] : [];
    } else if (Array.isArray(req.groups)) {
      const attempt = req.attempt ?? (view.repeats.get(req.stage) ?? 0) + 1;
      for (const group of req.groups) {
        const bad = !Array.isArray(group) || group.length === 0 ? ['（空か並びでない組）'] : group.filter((id) => !view.assets.get(id) || view.assets.get(id).gone);
        if (bad.length) return rejected(`${REJECT_SCOPE.assign}${req.stage}`, attempt, null, req.groups, `担当の組に台帳の今の資産に無い ID がある: ${bad.join(', ')}`);
      }
      groups = req.groups;
    } else reject(CODES.input, `groups か rule（${Object.values(ASSIGN_RULES).join('・')}）が要る`);
    const records = [];
    const out = [];
    let n = [...view.assignments.values()].filter((a) => a.stage === req.stage).length;
    for (const group of groups) {
      const assets = [...new Set(group)];
      const fps = fpsOf(view, assets);
      const fpset = fingerprintSet(fps);
      const known = [...view.assignments.values()].find((a) => a.stage === req.stage && canonical(a.assets) === canonical(assets) && a.fpset === fpset);
      const id = known?.id ?? assignmentId(req.stage, (n += 1));
      if (!known) records.push({ t: RECORDS.assignment, id, stage: req.stage, assets, fps, fpset });
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

function verdictsOutput(view, itemId) {
  const seen = view.seen.filter((s) => s.item === itemId);
  return {
    seen: seen.length,
    judgedOk: seen.filter((s) => s.value === JUDGEMENTS.ok).length,
    judgedUnsure: seen.filter((s) => s.value === JUDGEMENTS.unsure).length,
    duplicates: view.dups.filter((d) => d.item === itemId).length,
    refutationKeys: view.candidates.filter((c) => c.item === itemId).map((c) => c.key),
  };
}

export function verdicts(ctx, req) {
  return mutate(ctx, req, OPS.verdicts, (view) => {
    needLedger(view);
    const item = itemIn(view, req.item, [...VERIFY_STAGES]);
    const assignment = view.assignments.get(req.assignment);
    if (!assignment) reject(CODES.unknownId, `状態に無い担当 ID: ${JSON.stringify(req.assignment)}`);
    // 項目の鍵が担当を持つ（review・audit の観点ごとの検証）ときは、その担当の結果だけを受ける。別の担当の結果を書くと、見ていない資産を見たと数える。
    if (item.key?.assignment !== undefined && item.key.assignment !== req.assignment) reject(CODES.conflict, `項目の鍵の担当と違う担当の結果: ${req.item}（鍵 ${item.key.assignment}、結果 ${req.assignment}）`);
    checkViewpoint(req.viewpoint);
    const resultRecord = { t: RECORDS.result, item: req.item, result: { kind: RESULT_KINDS.verdicts, assignment: req.assignment, viewpoint: req.viewpoint, sum: sum(req.result ?? null) } };
    const output = (after) => verdictsOutput(after, req.item);
    const again = resent(item, resultRecord, output);
    if (again) return again;
    needCriteria(ctx);
    const kinds = new Set(kindsFor(ctx.criteriaDir, req.viewpoint, view.state.function).map((k) => k.value));
    const fn = view.state.function;
    const inspecting = INSPECTING_FUNCTIONS.has(fn);
    const bad = checkVerdictResult(req.result, assignment, req.viewpoint, kinds)
      ?? (REWRITING_FUNCTIONS.has(fn) ? checkExtra(req.viewpoint, req.result, { criteriaDir: ctx.criteriaDir, assignment, groundIds: treatedGroundIds(view) }) : null)
      ?? (inspecting ? checkInspectExtra(req.viewpoint, req.result, { criteriaDir: ctx.criteriaDir, fn, viewpoints: runViewpoints(view), forced: view.applicability?.forced ?? [] }) : null);
    if (bad) return rejected(`${REJECT_SCOPE.item}${req.item}`, item.fails.length + 1, req.assignment, req.result, bad);
    const records = [resultRecord];
    const extra = REWRITING_FUNCTIONS.has(fn) ? extraFields(req.viewpoint, req.result) : inspecting ? inspectExtraFields(req.result) : null;
    if (extra) records.push({ t: RECORDS.extra, item: req.item, viewpoint: req.viewpoint, data: extra });
    for (const j of req.result.judgements) {
      records.push({ t: RECORDS.seen, item: req.item, asset: j.asset, viewpoint: req.viewpoint, assignment: assignment.id, fpset: assignment.fpset, digest: assignment.fps[j.asset], value: j.judgement });
    }
    const grouped = new Map();
    for (const c of req.result.candidates ?? []) {
      const key = { asset: c.asset, viewpoint: c.viewpoint, kind: c.kind };
      const ks = keyString(key);
      if (!grouped.has(ks)) grouped.set(ks, { key, texts: [] });
      grouped.get(ks).texts.push({ quote: c.quote, content: c.content, fix: c.fix });
    }
    for (const [ks, g] of grouped) {
      const f = findingWithKey(view, ks);
      const d = f ? lastDecision(f) : null;
      if (d && (d.value === exists || d.basis === BASIS.rejected) && d.fps[g.key.asset] === assignment.fps[g.key.asset]) {
        records.push({ t: RECORDS.dup, item: req.item, key: g.key, finding: f.id });
      } else {
        records.push({ t: RECORDS.candidate, item: req.item, key: g.key, texts: g.texts, assignment: assignment.id, fpset: assignment.fpset, digest: assignment.fps[g.key.asset] });
      }
    }
    return { records, output };
  });
}

function stageRefs(req) {
  const refs = req.stages;
  if (!Array.isArray(refs) || refs.length === 0) reject(CODES.input, 'stages は 1 つ以上の {stage, round} の並び');
  return refs.map((r) => {
    if (r === null || typeof r !== 'object' || typeof r.stage !== 'string') reject(CODES.input, `stages の要素は {stage, round} でなければならない: ${JSON.stringify(r)}`);
    return { stage: r.stage, round: r.round ?? null };
  });
}

function inStages(item, refs) {
  return refs.some((r) => r.stage === item.stage && r.round === item.round);
}

export async function refutationItems(ctx, req) {
  const { view } = await readState(ctx, req.state);
  const refs = stageRefs(req);
  const keys = [];
  const texts = new Map();
  // 鍵の順位は、鍵の最初の候補を返した検証の項目の列挙の順（段は stages の順）、同じ項目の中では候補が返った順（SP-BPINSPECTION-018）。
  // 書き込みの順で並べると、同時に走る検証役の終わった順が順位になる。
  const rank = (c) => {
    const item = view.items.get(c.item);
    return [refs.findIndex((r) => r.stage === item.stage && r.round === item.round), stageEntry(view, item.stage, item.round).items.indexOf(c.item), c.seq];
  };
  const ordered = view.candidates.filter((c) => inStages(view.items.get(c.item), refs)).map((c) => ({ c, k: rank(c) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2]).map((x) => x.c);
  for (const c of ordered) {
    const ks = keyString(c.key);
    if (!texts.has(ks)) { texts.set(ks, []); keys.push(c.key); }
    texts.get(ks).push(...c.texts);
  }
  return req.texts ? { keys, candidates: keys.map((k) => ({ key: k, texts: texts.get(keyString(k)) })) } : { keys };
}

function candidatesOfRefuteItem(view, item) {
  const ks = keyString(item.key);
  return view.candidates.filter((c) => {
    const ci = view.items.get(c.item);
    return keyString(c.key) === ks && VERIFY_STAGES.has(ci.stage) && ci.round === item.round;
  });
}

function refutationOutput(view, item) {
  const f = findingWithKey(view, keyString(item.key));
  const createdHere = f?.states.find((s) => s.round === `${ROUND_PREFIX.refute}${item.id}`);
  return {
    unrefuted: !view.refutes.has(item.id),
    finding: view.refutes.has(item.id) ? f?.id ?? null : null,
    created: Boolean(createdHere),
    state: createdHere?.state ?? null,
  };
}

export function refutation(ctx, req) {
  return mutate(ctx, req, OPS.refutation, (view) => {
    needLedger(view);
    // 未反証の記録は試行の失敗と組で送られるので、打ち切りを足した組の送り直しも受けられるよう、書けるかは試行の番号で決める。
    const item = itemIn(view, req.item, [STAGE.refute], { writable: req.verdict != null });
    const cands = candidatesOfRefuteItem(view, item);
    if (cands.length === 0) reject(CODES.unknownId, `反証の項目に候補が無い: ${req.item}`);
    const output = (after) => refutationOutput(after, after.items.get(req.item));
    const resultRecord = { t: RECORDS.result, item: req.item, result: { kind: RESULT_KINDS.refutation, verdict: req.verdict ?? null, reason: req.reason ?? null } };
    const again = resent(item, resultRecord, output);
    if (again) return again;
    if (req.verdict == null) {
      if (item.discarded) reject(CODES.conflict, `破棄した項目に未反証の記録を書けない: ${req.item}`);
      checkAttempt(item, req.attempt, '未反証の記録');
      return { records: [{ t: RECORDS.unrefuted, item: req.item, attempt: req.attempt }], output };
    }
    const attempt = item.fails.length + 1;
    const payload = { verdict: req.verdict, reason: req.reason };
    if (!Object.values(REFUTATION_VERDICTS).includes(req.verdict)) return rejected(`${REJECT_SCOPE.item}${req.item}`, attempt, null, payload, `反証の結果が選択肢に無い: ${JSON.stringify(req.verdict)}`);
    if (typeof req.reason !== 'string') return rejected(`${REJECT_SCOPE.item}${req.item}`, attempt, null, payload, '反証の理由が文字列でない');
    const records = [resultRecord, { t: RECORDS.refute, item: req.item, key: item.key, verdict: req.verdict, reason: req.reason }];
    if (!findingWithKey(view, keyString(item.key))) {
      const id = findingId(view.ledger.id, item.key);
      if (view.findings.has(id)) internal(`指摘 ID が衝突した: ${id}`);
      const first = view.assignments.get(cands[0].assignment);
      const upheld = req.verdict === REFUTATION_VERDICTS.uphold;
      records.push(
        { t: RECORDS.finding, id, key: item.key, run: req.run },
        {
          t: RECORDS.fstate, finding: id, run: req.run, round: `${ROUND_PREFIX.refute}${req.item}`,
          state: upheld ? FINDING_STATES.open : FINDING_STATES.dismissed,
          value: upheld ? exists : absent, basis: upheld ? BASIS.upheld : BASIS.rejected, fps: first.fps, fpset: first.fpset,
          ...(upheld ? {} : { reason: req.reason }),
        },
      );
    }
    return { records, output };
  });
}

function refuteVerdictOf(view, cand) {
  const ci = view.items.get(cand.item);
  const ks = keyString(cand.key);
  const refuteItem = [...view.items.values()].find((i) => i.stage === STAGE.refute && i.round === ci.round && keyString(i.key) === ks);
  return refuteItem ? view.refutes.get(refuteItem.id)?.verdict ?? null : null;
}

// 資産が 2 つ以上ある指摘は、資産ごとにその資産の鍵だけで条件の値を決める（SP-BPFINDINGS-018）。
export function reviewInputForAsset(view, finding, asset, refs) {
  const d = lastDecision(finding);
  if (!d) internal(`判定の記録の無い指摘: ${finding.id}`);
  const ks = keyString({ asset, viewpoint: finding.key.viewpoint, kind: finding.key.kind });
  const R = view.seen.filter((s) => s.viewpoint === finding.key.viewpoint && s.asset === asset && s.fpset !== d.fpset && inStages(view.items.get(s.item), refs));
  const content = d.fps[asset] !== view.assets.get(asset).digest ? C_IN.changed : C_IN.same;
  const items = new Set(R.map((s) => s.item));
  const cands = view.candidates.filter((c) => items.has(c.item) && keyString(c.key) === ks);
  const dups = view.dups.filter((c) => items.has(c.item) && keyString(c.key) === ks);
  let candidates = K_IN.none;
  if (cands.length && dups.length) candidates = K_IN.mixedDup;
  else if (dups.length) candidates = K_IN.dup;
  else if (cands.length) {
    const verdictsOf = cands.map((c) => refuteVerdictOf(view, c));
    if (verdictsOf.includes(REFUTATION_VERDICTS.uphold)) candidates = K_IN.upheld;
    else if (verdictsOf.includes(null)) candidates = K_IN.unrefuted;
    else candidates = K_IN.rejected;
  }
  let judged = J_IN.none;
  if (R.length) judged = R.some((s) => s.value !== JUDGEMENTS.unsure) ? J_IN.decided : J_IN.unsure;
  return { input: { r: R.length ? R_IN.present : R_IN.empty, content, candidates, judged }, decision: d, latest: R.at(-1) ?? null };
}

function decisionRecords(view, finding, { run, round, value, basis, fps, fpset }) {
  const last = finding.states.at(-1);
  if (last.run === run && view.ledger.rewriting) {
    const state = nextState(last.state, value);
    return { records: [{ t: RECORDS.fstate, finding: finding.id, run, round, state, value, basis, fps, fpset }], recorded: RECORDED.state, state };
  }
  return { records: [{ t: RECORDS.judgement, finding: finding.id, run, round, value, basis, fps, fpset }], recorded: RECORDED.judgement, state: null };
}

export function reviewJudge(ctx, req) {
  return mutate(ctx, req, OPS.reviewJudge, (view) => {
    needLedger(view);
    if (!view.ledger.rewriting) reject(CODES.conflict, '見直しは書き換える run の台帳だけで行う（書き換えない run では resolved・regressed を記録しない）');
    const refs = stageRefs(req);
    const round = `${ROUND_PREFIX.judge}${req.round ?? ''}`;
    const records = [];
    const results = [];
    for (const f of [...view.findings.values()].sort((a, b) => a.order - b.order)) {
      const assets = liveAssets(view, f);
      if (assets.length === 0) { results.push({ finding: f.id, value: null, recorded: RECORDED.none, vanished: true }); continue; }
      const perAsset = assets.map((asset) => {
        const r = reviewInputForAsset(view, f, asset, refs);
        return { ...r, ...reviewJudgement(r.input, r.decision) };
      });
      const chosen = FOLD_ORDER.map((v) => perAsset.find((p) => p.value === v)).find(Boolean);
      const { row, value, basis, decision, latest } = chosen;
      if (value === skip) { results.push({ finding: f.id, value, row, recorded: RECORDED.none }); continue; }
      const assignment = value !== unknown && latest ? view.assignments.get(latest.assignment) : null;
      const out = decisionRecords(view, f, {
        run: req.run, round, value, basis,
        fps: assignment ? { ...decision.fps, ...assignment.fps } : decision.fps,
        fpset: assignment ? assignment.fpset : decision.fpset,
      });
      records.push(...out.records);
      results.push({ finding: f.id, value, row, recorded: out.recorded, state: out.state });
    }
    return { records, output: { judgements: results } };
  });
}

function vanishOutput(view, item) {
  const finding = view.findings.get(item.key.finding);
  const round = `${ROUND_PREFIX.vanish}${item.id}`;
  const rec = [...finding.states, ...finding.judgements].find((r) => r.round === round);
  return { finding: finding.id, value: rec?.value ?? null, recorded: rec ? (rec.t === RECORDS.fstate ? RECORDED.state : RECORDED.judgement) : RECORDED.none, state: rec?.t === RECORDS.fstate ? rec.state : null };
}

export function vanishMatch(ctx, req) {
  return mutate(ctx, req, OPS.vanishMatch, (view) => {
    needLedger(view);
    const item = itemIn(view, req.item, [STAGE.vanish]);
    const finding = view.findings.get(item.key?.finding);
    if (!finding) reject(CODES.unknownId, `消えた資産の照合の項目が台帳に無い指摘を指す: ${JSON.stringify(item.key?.finding)}`);
    if (!view.gones.some((g) => g.retake === item.key.gone && finding.assets.includes(g.id))) {
      reject(CODES.conflict, `消えた資産の照合の項目の指摘に、取り直し ${item.key.gone} で消えた資産が無い: ${finding.id}`);
    }
    const output = (after) => vanishOutput(after, after.items.get(req.item));
    const resultRecord = { t: RECORDS.result, item: req.item, result: { kind: RESULT_KINDS.vanish, choice: req.choice ?? null } };
    const again = resent(item, resultRecord, output);
    if (again) return again;
    const d = lastDecision(finding);
    let value;
    let fps = d.fps;
    const records = [resultRecord];
    if (req.choice == null) value = unknown;
    else if (req.choice === VANISH_NONE) value = absent;
    else {
      const asset = view.assets.get(req.choice);
      if (!asset || asset.gone) return rejected(`${REJECT_SCOPE.item}${req.item}`, item.fails.length + 1, null, req.choice, `台帳の今の資産に無い ID を選んだ: ${JSON.stringify(req.choice)}`);
      value = exists;
      fps = { ...d.fps, [asset.id]: asset.digest };
      if (!finding.assets.includes(asset.id)) records.push({ t: RECORDS.addAsset, finding: finding.id, asset: asset.id });
    }
    const out = decisionRecords(view, finding, {
      run: req.run, round: `${ROUND_PREFIX.vanish}${req.item}`, value, basis: value === unknown ? BASIS.unknown : BASIS.vanish, fps, fpset: fingerprintSet(liveFps(view, fps)),
    });
    records.push(...out.records);
    return { records, output };
  });
}

export async function report(ctx, req) {
  const { view } = await readState(ctx, req.state);
  needLedger(view);
  if (!Array.isArray(req.viewpoints)) reject(CODES.input, 'viewpoints は観点の並び');
  req.viewpoints.forEach(checkViewpoint);
  const full = { run: currentRun(view).id, ...ledgerReport(view, req.viewpoints), assets: currentAssets(view).map((a) => ({ id: a.id, path: a.path, loc: a.loc })) };
  if (req.fields === undefined) return full;
  if (!Array.isArray(req.fields) || req.fields.some((f) => !Object.hasOwn(full, f))) reject(CODES.input, `fields は ${Object.keys(full).join('・')} の並び`);
  return Object.fromEntries(req.fields.map((f) => [f, full[f]]));
}

export async function kinds(ctx, req) {
  const { view } = await readState(ctx, req.state);
  checkViewpoint(req.viewpoint);
  needCriteria(ctx);
  return { viewpoint: req.viewpoint, kinds: kindsFor(ctx.criteriaDir, req.viewpoint, view.state.function) };
}
