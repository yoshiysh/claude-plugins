import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  CODES, CONTRACT_NONE, FILE_ACTIONS, FINDING_GATE, FINGERPRINT_AT, FUNCTION, GOAL_KEYS, GROUND_INSTRUCTION, GROUND_REF_KEY,
  INSPECTING_FUNCTIONS, LIMIT_KEYS, OPS, RECORDS, RESULT_KEYS, REWRITING_FUNCTIONS, ROLE_WRITE_LIMITS, SNAPSHOT_DIR, SNAPSHOT_PARTS,
  SOURCE_KINDS, STAGE, STOP_KINDS, UNCHECKED_KINDS, UNIT_RESULTS, VERIFICATION_KEYS, WORK_DIR,
} from './constants.mjs';
import { checkWritableItem, needPosInt } from './checks.mjs';
import { reject } from './errors.mjs';
import { resolveCallsites } from './callsites.mjs';
import { diffFingerprints, homelessReason, targetFiles, targetFingerprint } from './fingerprint.mjs';
import { KEYS_VERDICT, NO_JUDGEMENT, RECORDED_RUN, findingGate, INCREMENT, iterationDecision, nextStep, unitGate } from './gate.mjs';
import { canonical, keyString, premiseId, sha256Hex } from './ids.mjs';
import { checkRepeatNumber, limitState, stopOutcome, unverifiedFiles } from './ops-run.mjs';
import { findingsForResult, judgedOnCurrent, ledgerReport, skipList, unrefutedCandidates } from './report.mjs';
import { mutate, readState } from './store.mjs';
import { applicability, contractKind } from './units.mjs';
import { currentRun, itemStatus, lastFingerprint, runBase, runViewpoints, stageEntry, stoppedStage } from './view.mjs';
import { inspectOutcome, inspectProgress } from './ops-inspect.mjs';
import { needCriteria } from './ops-ledger.mjs';
import { realpathLoose } from './workspace.mjs';
import { readOrNull } from './journal.mjs';
import { identity, strip } from './records.mjs';


function needRewriting(view) {
  if (!REWRITING_FUNCTIONS.has(view.state.function)) reject(CODES.input, `create・update だけの操作: ${view.state.function}`);
}

export function isTreatedGround(ground) {
  if (ground === null || typeof ground !== 'object' || Array.isArray(ground)) return false;
  if (Object.hasOwn(ground, GROUND_REF_KEY)) return typeof ground[GROUND_REF_KEY] === 'string' && Object.keys(ground).length === 1;
  if (Object.hasOwn(ground, 'state')) return ground.state === 'open';
  return ground[GROUND_INSTRUCTION.kindKey] === GROUND_INSTRUCTION.kind && typeof ground[GROUND_INSTRUCTION.textKey] === 'string';
}

export function treatedGroundIds(view) {
  return view.grounds.filter((g) => isTreatedGround(g.ground)).map((g) => g.id);
}

export async function key() {
  return { key: `k-${randomBytes(8).toString('hex')}` };
}

export async function paths(ctx, req) {
  if (typeof req.root !== 'string' || !path.isAbsolute(req.root)) reject(CODES.input, 'root は絶対パスでなければならない');
  const st = await fs.stat(req.root).catch(() => null);
  if (!st?.isDirectory()) reject(CODES.input, `対象スキルのディレクトリが無い: ${req.root}`);
  return resolveCallsites(req.root);
}

export function pathsRetake(ctx, req) {
  return mutate(ctx, req, OPS.pathsRetake, async (view) => {
    needPosInt(req.iteration, 'iteration は');
    const known = view.paths.find((p) => p.run === req.run && p.iteration === req.iteration);
    const output = (after) => {
      const rec = after.paths.find((p) => p.run === req.run && p.iteration === req.iteration);
      return { n: rec.n, files: rec.files, unresolved: rec.unresolved };
    };
    if (known) {
      const fp = view.fingerprints.find((f) => f.run === req.run && f.at === FINGERPRINT_AT.retake && f.paths === known.n);
      return { records: [strip(known), ...(fp ? [strip(fp)] : [])], output };
    }
    const base = view.paths.at(-1);
    const r = resolveCallsites(base.root);
    const record = { t: RECORDS.paths, n: view.paths.length + 1, root: base.root, files: r.files, unresolved: r.unresolved, run: req.run, iteration: req.iteration };
    const fp = await targetFingerprint(record);
    if (fp.homeless.length) reject(CODES.input, homelessReason(fp.homeless));
    const n = view.fingerprints.filter((f) => f.run === req.run && f.at === FINGERPRINT_AT.retake).length + 1;
    return { records: [record, { t: RECORDS.fingerprint, run: req.run, at: FINGERPRINT_AT.retake, n, paths: record.n, files: fp.digests }], output };
  });
}

function snapshotPath(dir, key) {
  const plugin = key.startsWith('plugin:');
  return path.join(dir, WORK_DIR, SNAPSHOT_DIR, plugin ? SNAPSHOT_PARTS.plugin : SNAPSHOT_PARTS.root, plugin ? key.slice('plugin:'.length) : key);
}

async function verifySnapshot(dir, record) {
  const bad = [];
  for (const [key, digest] of Object.entries(record.files)) {
    const bytes = await fs.readFile(snapshotPath(dir, key)).catch(() => null);
    if (!bytes || sha256Hex(bytes) !== digest) bad.push(key);
  }
  return bad;
}

export function snapshot(ctx, req) {
  return mutate(ctx, req, OPS.snapshot, async (view, dir) => {
    if (view.state.function !== FUNCTION.update) reject(CODES.input, '作り直す前の写しは update だけの段');
    const output = (after) => ({ dir: path.join(dir, WORK_DIR, SNAPSHOT_DIR), files: after.snapshot.files, verified: true });
    if (view.snapshot) {
      const bad = await verifySnapshot(dir, view.snapshot);
      if (bad.length) reject(CODES.conflict, `作り直す前の写しが記録の指紋と食い違う: ${bad.join(', ')}`, { mismatched: bad });
      return { records: [strip(view.snapshot)], output };
    }
    const { entries, homeless } = await targetFiles(view.paths.at(-1));
    if (homeless.length) reject(CODES.input, homelessReason(homeless));
    const target = path.join(dir, WORK_DIR, SNAPSHOT_DIR);
    const staging = path.join(dir, WORK_DIR, `.${SNAPSHOT_DIR}-${randomBytes(6).toString('hex')}`);
    await fs.rm(target, { recursive: true, force: true });
    const files = {};
    try {
      for (const { file, key: k } of entries) {
        const bytes = await fs.readFile(file);
        const dest = snapshotPath(dir, k).replace(target, staging);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, bytes);
        files[k] = sha256Hex(bytes);
      }
      await fs.mkdir(staging, { recursive: true });
      await fs.rename(staging, target);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
    return { records: [{ t: RECORDS.snapshot, dir: SNAPSHOT_DIR, files }], output };
  });
}

async function checkSource(view, dir, source, answers) {
  const fn = view.state.function;
  const quote = typeof source?.quote === 'string' ? source.quote : '';
  switch (source?.kind) {
    case SOURCE_KINDS.request:
      if (fn !== FUNCTION.create) return 'update の出所に依頼文は使えない';
      if (!quote) return '引用が空';
      return view.state.request.includes(quote) ? null : `依頼文に無い引用: ${quote}`;
    case SOURCE_KINDS.answer:
      if (!quote) return '引用が空';
      return answers.some((a) => a.includes(quote)) ? null : `利用者の回答に無い引用: ${quote}`;
    case SOURCE_KINDS.snapshot: {
      if (fn !== FUNCTION.update) return 'create の出所に写しは使えない';
      if (!view.snapshot || !Object.hasOwn(view.snapshot.files, source.path)) return `作り直す前の写しに無いパス: ${JSON.stringify(source.path)}`;
      if (!quote) return '引用が空';
      const text = await readOrNull(snapshotPath(dir, source.path));
      return text?.includes(quote) ? null : `写しの ${source.path} に無い引用: ${quote}`;
    }
    case SOURCE_KINDS.ground:
      if (fn !== FUNCTION.update) return 'create の出所に修正の根拠は使えない';
      if (!view.grounds.some((g) => g.id === source.ground)) return `前提に無い修正の根拠の記録 ID: ${JSON.stringify(source.ground)}`;
      return treatedGroundIds(view).includes(source.ground) ? null : `修正の根拠として扱わない根拠の記録 ID: ${source.ground}`;
    default:
      return `出所の種類が ${Object.values(SOURCE_KINDS).join('・')} のどれでもない: ${JSON.stringify(source?.kind)}`;
  }
}

export async function checkGoal(view, dir, goal) {
  const failures = [];
  if (goal === null || typeof goal !== 'object' || Array.isArray(goal)) return [{ element: null, index: null, reason: 'goal はオブジェクトでなければならない' }];
  const answers = view.premises.filter((p) => p.kind === 'answer').map((p) => p.text);
  const pointed = new Set();
  for (const element of Object.values(GOAL_KEYS)) {
    const list = goal[element];
    if (!Array.isArray(list)) { failures.push({ element, index: null, reason: `${element} が並びでない（値が無い欄は空の並び）` }); continue; }
    if (element === GOAL_KEYS.deliverables && list.length === 0) failures.push({ element, index: null, reason: '成果物が 1 つも無い' });
    for (const [index, entry] of list.entries()) {
      if (typeof entry?.text !== 'string' || !Array.isArray(entry.sources) || entry.sources.length === 0) {
        failures.push({ element, index, reason: '要素は text と 1 つ以上の sources を持たなければならない' });
        continue;
      }
      const reasons = [];
      for (const source of entry.sources) {
        const bad = await checkSource(view, dir, source, answers);
        if (bad) reasons.push(bad);
        else if (source.kind === SOURCE_KINDS.ground && (element === GOAL_KEYS.deliverables || element === GOAL_KEYS.scope)) pointed.add(source.ground);
      }
      if (reasons.length === entry.sources.length) failures.push({ element, index, reason: reasons.join(' / ') });
    }
  }
  if (view.state.function === FUNCTION.update) {
    for (const id of treatedGroundIds(view)) {
      if (!pointed.has(id)) failures.push({ element: 'grounds', index: null, reason: `修正の根拠 ${id} を成果物か範囲の出所として指していない` });
    }
  }
  return failures;
}

export function goalCheck(ctx, req) {
  return mutate(ctx, req, OPS.goalCheck, async (view, dir) => {
    needRewriting(view);
    const item = view.items.get(req.item);
    if (!item || item.stage !== STAGE.goal) reject(CODES.unknownId, `状態に無い目標の固定の段の項目の ID: ${JSON.stringify(req.item)}`);
    checkWritableItem(item);
    checkRepeatNumber(view, STAGE.goal, req.n);
    if (item.result !== undefined && !view.byKey.has(identity({ t: RECORDS.repeat, stage: STAGE.goal, n: req.n }))) {
      reject(CODES.conflict, `固定した目標が既にある項目に別の繰り返しの番号の照合が届いた: ${req.item}（${req.n}）`);
    }
    const failures = await checkGoal(view, dir, req.goal);
    // 同じ番号に違う目標が届いたら食い違いとして拒否するため、繰り返しの記録に目標の sha256 を持たせる。
    const records = [{ t: RECORDS.repeat, stage: STAGE.goal, n: req.n, goal: sha256Hex(canonical(req.goal ?? null)) }];
    let id = null;
    if (failures.length === 0) {
      const text = canonical(req.goal);
      const hash = sha256Hex(text);
      id = view.premises.find((p) => p.run === req.run && p.kind === 'goal' && p.hash === hash)?.id ?? premiseId(view.premises.length + 1);
      records.push(
        { t: RECORDS.premise, id, run: req.run, kind: 'goal', hash, text },
        { t: RECORDS.result, item: req.item, result: { premise: id } },
        { t: RECORDS.stageEnd, stage: STAGE.goal, round: item.round },
      );
    }
    return {
      records,
      output: (after) => ({
        passed: failures.length === 0,
        failures,
        premise: id,
        untilPass: limitState(after, LIMIT_KEYS.untilPass, after.repeats.get(STAGE.goal) ?? 0, runBase(after).repeats[STAGE.goal] ?? 0),
      }),
    };
  });
}

export function filesScan(ctx, req) {
  return mutate(ctx, req, OPS.filesScan, async (view) => {
    needRewriting(view);
    needPosInt(req.iteration, 'iteration は');
    const last = lastFingerprint(view);
    const now = await targetFingerprint(view.paths.at(-1));
    const changed = diffFingerprints(last?.files, now.digests);
    const records = changed.map((p) => ({ t: RECORDS.file, run: req.run, path: p, iteration: req.iteration, action: Object.hasOwn(now.digests, p) ? FILE_ACTIONS.write : FILE_ACTIONS.delete }));
    return { records, output: { recorded: changed, excluded: now.homeless } };
  });
}

export async function units(ctx) {
  needCriteria(ctx);
  return { rows: applicability(ctx.criteriaDir) };
}

function itemsOf(view, stage, round) {
  return (stageEntry(view, stage, round)?.items ?? []).map((id) => view.items.get(id));
}

function findingGates(view) {
  const run = currentRun(view).id;
  return [...view.findings.values()].sort((a, b) => a.order - b.order).map((f) => {
    const last = f.states.at(-1);
    const j = f.judgements.filter((x) => x.run === run).at(-1);
    const input = {
      run: last.run === run ? RECORDED_RUN.current : RECORDED_RUN.previous,
      state: last.state,
      judgement: j ? j.value : NO_JUDGEMENT,
      onCurrent: judgedOnCurrent(view, f),
    };
    return { finding: f, input, result: findingGate(input) };
  });
}

function keysVerdict(keys, byKey) {
  const results = keys.map((k) => byKey.get(keyString(k)) ?? null);
  if (results.includes(FINDING_GATE.fail)) return KEYS_VERDICT.fail;
  if (results.every((r) => r === FINDING_GATE.ok)) return KEYS_VERDICT.allOk;
  return KEYS_VERDICT.other;
}

export function computeGate(view, number) {
  const fn = view.state.function;
  const gates = findingGates(view);
  const byKey = new Map();
  for (const g of gates) for (const k of g.finding.keys) byKey.set(k, g.result);
  const verify = itemsOf(view, STAGE.verify, number);
  const conf = verify.find((i) => i.key?.viewpoint === 'conformance');
  const extra = conf ? view.extras.get(conf.id)?.data : null;
  const aborted = conf && conf.result === undefined ? [conf.id] : [];
  const unitResults = (aborted.length || !extra ? [] : extra.units).map((u) => {
    const keys = u.keys ?? [];
    const verdict = u.result === UNIT_RESULTS.nonconform ? keysVerdict(keys, byKey) : KEYS_VERDICT.other;
    const g = unitGate({ given: u.result, keys: verdict, unchecked: u.unchecked });
    const ids = keys.map((k) => gates.find((x) => x.finding.keys.includes(keyString(k)))?.finding.id).filter(Boolean);
    const reason = g.result === UNIT_RESULTS.conform && u.result === UNIT_RESULTS.nonconform ? `${u.reason}（反証で退けられたか直った: ${ids.join(', ')}）` : u.reason;
    return { unit: u.unit, result: g.result, ...(g.unchecked ? { unchecked: g.unchecked } : {}), reason, ...(ids.length ? { findings: ids } : {}) };
  });
  const refuteItems = new Set(itemsOf(view, STAGE.refute, number).map((i) => i.id));
  const unverifiable = {
    findings: gates.filter((g) => g.result === FINDING_GATE.unverifiable).map((g) => g.finding.id),
    unrefuted: unrefutedCandidates(view).filter((u) => refuteItems.has(u.item)).map((u) => u.key),
    skip: runViewpoints(view).map((vp) => ({ viewpoint: vp, assets: skipList(view, vp).map((a) => a.id) })).filter((s) => s.assets.length > 0),
    aborted: conf ? aborted : ['conformance'],
  };
  const failingUnits = unitResults.filter((u) => u.result === UNIT_RESULTS.nonconform || (u.result === UNIT_RESULTS.unchecked && u.unchecked === UNCHECKED_KINDS.unforced));
  const failing = { findings: gates.filter((g) => g.result === FINDING_GATE.fail).map((g) => g.finding.id), units: failingUnits.map((u) => u.unit) };
  const decision = iterationDecision({ unverifiable, failing });
  const failingSet = new Set(failing.findings);
  return {
    decision,
    findings: gates.map((g) => ({ id: g.finding.id, ...g.input, result: g.result })),
    units: unitResults,
    forced: unitResults.filter((u) => u.unchecked === UNCHECKED_KINDS.forced).map((u) => ({ unit: u.unit, sp: u.unit.split('/')[0] })),
    unverifiable,
    failing,
    rewrite: {
      findings: findingsForResult(view).filter((f) => failingSet.has(f.id)),
      units: failingUnits.map((u) => ({ unit: u.unit, result: u.result, reason: u.reason })),
    },
  };
}

// 合否の項目の結果と反復の回数の + 1 を分けて書くと、その間で止まった run の再開で数えが抜ける（SP-BPAUTHORING-024）。
export function gate(ctx, req) {
  return mutate(ctx, req, OPS.gate, (view) => {
    needRewriting(view);
    needPosInt(req.number, 'number は');
    const entry = stageEntry(view, STAGE.gate, req.number);
    if (!entry || entry.items.length !== 1) reject(CODES.unknownId, `反復 ${req.number} の合否の段の項目が無い`);
    const item = view.items.get(entry.items[0]);
    checkWritableItem(item);
    const output = (after) => {
      const rec = after.items.get(item.id).result;
      return { item: item.id, ...rec.result, iterations: limitState(after, LIMIT_KEYS.iterations, after.iterations, runBase(after).iterations) };
    };
    if (item.result !== undefined) return { records: [strip(item.result)], output };
    const count = view.iterations + 1;
    const g = computeGate(view, req.number);
    const reached = count - runBase(view).iterations >= view.state.limits[LIMIT_KEYS.iterations];
    const next = nextStep({ decision: g.decision, increment: reached ? INCREMENT.reached : INCREMENT.below });
    return { records: [{ t: RECORDS.result, item: item.id, result: { number: req.number, ...g, next }, iteration: count }], output };
  });
}

export function lastGate(view) {
  return [...view.items.values()].filter((i) => i.stage === STAGE.gate && i.result !== undefined).sort((a, b) => a.result.iteration - b.result.iteration).at(-1) ?? null;
}

function sectionText(text, heading) {
  if (!heading) return text;
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^ {0,3}#{1,6}[ \t]/.test(l) && l.replace(/^ {0,3}#{1,6}[ \t]+/, '').trim() === heading);
  if (start < 0) return null;
  const level = /^ {0,3}(#{1,6})/.exec(lines[start])[1].length;
  const end = lines.findIndex((l, i) => i > start && /^ {0,3}(#{1,6})[ \t]/.test(l) && /^ {0,3}(#{1,6})/.exec(l)[1].length <= level);
  return lines.slice(start, end < 0 ? lines.length : end).join('\n');
}

async function designNote(view) {
  const write = [...view.items.values()].filter((i) => i.stage === STAGE.write && i.result?.result?.designNote).at(-1);
  if (!write) return null;
  const note = write.result.result.designNote;
  const root = view.paths.at(-1).root;
  const text = await readOrNull(path.join(root, note.path));
  return { path: note.path, heading: note.heading ?? null, text: text === null ? null : sectionText(text, note.heading) };
}

async function skillOf(view) {
  const now = await targetFingerprint(view.paths.at(-1));
  const files = Object.entries(now.digests).map(([p, digest]) => ({ path: p, digest }));
  const deleted = [...new Set(view.files.filter((f) => f.action === FILE_ACTIONS.delete && !Object.hasOwn(now.digests, f.path)).map((f) => f.path))];
  return view.state.function === FUNCTION.create
    ? { root: realpathLoose(view.paths.at(-1).root), files }
    : { files, deleted };
}

export function writtenFiles(view) {
  const open = new Set(unverifiedFiles(view).map((f) => f.path));
  const latest = new Map();
  for (const f of view.files) latest.set(f.path, f);
  return [...latest.values()].map((f) => ({ path: f.path, action: f.action, verified: !open.has(f.path) }));
}

function extraOf(view, number, viewpoint) {
  const item = itemsOf(view, STAGE.verify, number).find((i) => i.key?.viewpoint === viewpoint);
  return item ? view.extras.get(item.id)?.data ?? null : null;
}

function verification(view, gateItem) {
  const g = gateItem.result.result;
  const out = {
    [VERIFICATION_KEYS.decision]: { value: g.decision, findings: [...g.failing.findings, ...g.unverifiable.findings], units: g.failing.units, unverifiable: g.unverifiable },
    [VERIFICATION_KEYS.iterations]: { total: view.iterations, run: view.iterations - runBase(view).iterations },
    [VERIFICATION_KEYS.units]: g.units,
    [VERIFICATION_KEYS.forcedUnchecked]: g.forced,
    [VERIFICATION_KEYS.basisConstraints]: extraOf(view, g.number, 'goal')?.basisConstraints ?? [],
    [VERIFICATION_KEYS.ledger]: ledgerReport(view, runViewpoints(view)),
  };
  if (view.state.function === FUNCTION.update) {
    const changes = extraOf(view, g.number, 'contract')?.contractChanges ?? [];
    out[VERIFICATION_KEYS.contract] = changes.map((c) => ({
      ...c,
      ...(c.choice === CONTRACT_NONE ? { findings: [...view.findings.values()].filter((f) => f.key.viewpoint === 'contract' && f.key.kind === contractKind(c.element)).map((f) => f.id) } : {}),
    }));
  }
  return out;
}

// SP-BPRUN-032、SP-BPAUTHORING-032〜034: 返り値は状態だけから作る（書いた run と完了した run が別でも同じ返り値になる）。
export async function outcome(ctx, req) {
  const { view } = await readState(ctx, req.state);
  if (INSPECTING_FUNCTIONS.has(view.state.function)) return inspectOutcome(ctx, req);
  const { stop, out } = stopOutcome(view);
  const complete = stop.kind === STOP_KINDS.complete;
  const gateItem = lastGate(view);
  const written = writtenFiles(view);
  if (written.length) out[RESULT_KEYS.writtenFiles] = written;
  out[RESULT_KEYS.unverifiedRoleLimits] = ROLE_WRITE_LIMITS;
  const unresolved = view.paths.at(-1).unresolved ?? [];
  if (unresolved.length) out[RESULT_KEYS.excludedCallsites] = unresolved.map((u) => ({ ...u, file: path.join(view.paths.at(-1).root, 'SKILL.md') }));
  if (gateItem) {
    out[RESULT_KEYS.verification] = verification(view, gateItem);
    out[RESULT_KEYS.residualRisks] = extraOf(view, gateItem.result.result.number, 'conformance')?.residualRisks ?? [];
  }
  if (complete) {
    const report = ledgerReport(view, runViewpoints(view));
    out[RESULT_KEYS.skill] = await skillOf(view);
    out[RESULT_KEYS.designNote] = await designNote(view);
    out[RESULT_KEYS.findings] = report.findings;
    out[RESULT_KEYS.skip] = report.skip;
    if (view.state.function === FUNCTION.update) {
      out[RESULT_KEYS.receivedGrounds] = view.grounds.map((g) => ({ ground: g.id, ...(typeof g.ground?.id === 'string' ? { finding: g.ground.id } : {}) }));
    }
  } else {
    out[RESULT_KEYS.unverified] = [...stop.unverified.map((f) => ({ path: f.path, action: f.action })), ...stop.outside.map((p) => ({ path: p, outside: true }))];
  }
  return out;
}

function stoppedDetail(view) {
  const s = stoppedStage(view);
  const entry = s.stage == null ? null : stageEntry(view, s.stage, s.round);
  if (!entry) return { stage: null, round: null, status: s.status, parts: 0, items: [] };
  return {
    stage: s.stage, round: s.round, status: s.status, parts: entry.parts,
    items: entry.items.map((id) => ({ ...itemStatus(view.items.get(id)), key: view.items.get(id).key })),
  };
}

export function progress(view) {
  const rounds = (stage) => [...view.stages.values()].filter((s) => s.stage === stage).map((s) => s.round ?? 0);
  const number = Math.max(0, ...[STAGE.write, STAGE.verify, STAGE.gate].flatMap(rounds));
  const prior = view.runs.length > 1 ? view.stops.get(view.runs.at(-2).id) ?? null : null;
  const g = lastGate(view);
  return {
    function: view.state.function,
    iterations: view.iterations,
    number,
    goal: view.premises.some((p) => p.kind === 'goal'),
    goalRound: Math.max(0, ...rounds(STAGE.goal)),
    goalRepeats: view.repeats.get(STAGE.goal) ?? 0,
    snapshot: Boolean(view.snapshot),
    ledger: Boolean(view.ledger),
    lastStop: prior ? { kind: prior.kind, limitHit: prior.limitHit ?? null, stage: prior.stage, cause: prior.cause ?? null } : null,
    lastGate: g ? { number: g.result.result.number, decision: g.result.result.decision, next: g.result.result.next, rewrite: g.result.result.rewrite } : null,
    target: { root: view.paths.at(-1).root, files: view.paths.at(-1).files },
    goalText: view.premises.filter((p) => p.kind === 'goal').at(-1)?.text ?? null,
    request: view.state.request ?? null,
    grounds: view.grounds.filter((g) => isTreatedGround(g.ground)).map((g) => ({ id: g.id, ground: g.ground })),
    groundCount: view.grounds.length,
    answers: view.premises.filter((p) => p.kind === 'answer').map((p) => ({ id: p.id, text: p.text })),
    stopped: stoppedDetail(view),
    ...(INSPECTING_FUNCTIONS.has(view.state.function) ? { inspection: inspectProgress(view) } : {}),
  };
}

