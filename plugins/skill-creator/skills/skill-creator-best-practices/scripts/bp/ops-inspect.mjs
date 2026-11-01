import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CODES, FUNCTION, INSPECT_ROLE_WRITE_LIMITS, VIEWPOINT, INSPECTING_FUNCTIONS, OPS, RECORDS, REJECT_SCOPE, RESULT_KEYS, STAGE, STOP_KINDS, WORK_DIR,
} from './constants.mjs';
import { judgeApplicability } from './applicability.mjs';
import { assetTexts } from './assets.mjs';
import { needPosInt } from './checks.mjs';
import { internal, reject } from './errors.mjs';
import { targetFiles } from './fingerprint.mjs';
import { canonical, sha256Hex } from './ids.mjs';
import { readOrNull } from './journal.mjs';
import { coverageReason, flowUnits, ignoredSettingsReadable } from './kinds.mjs';
import { needCriteria, needLedger, rejected } from './ops-ledger.mjs';
import { stopOutcome } from './ops-run.mjs';
import { strip } from './records.mjs';
import { ledgerReport } from './report.mjs';
import { mutate, readState } from './store.mjs';
import { uncheckedViewpoints } from './unchecked.mjs';
import { applicability as applicabilityRows, forcedReason, forcedSources } from './units.mjs';
import { changedTargets, readTargets } from './targets.mjs';
import { currentAssets, itemStatus, reachedStage, runViewpoints, stageEntry, validTarget } from './view.mjs';


export function needInspecting(view) {
  if (!INSPECTING_FUNCTIONS.has(view.state.function)) reject(CODES.input, `review・audit だけの操作: ${view.state.function}`);
}

function needStage(view, stage) {
  if (!stageEntry(view, stage, null)) reject(CODES.unknownId, `始めていない段: ${stage}`);
}

function publicTargets(list) {
  return list.map(({ viewpoint, files, section, fingerprint, readable, reason }) => ({ viewpoint, files, section, fingerprint, readable, reason }));
}

// SP-BPINSPECTION-004・SP-BPINSPECTION-029: 段を終えていなければ読んで記録し、終えていれば読み直した指紋を記録と照らすだけにする。
export function targets(ctx, req) {
  return mutate(ctx, req, OPS.targets, (view) => {
    needInspecting(view);
    needCriteria(ctx, { files: false });
    needStage(view, STAGE.targets);
    const fn = view.state.function;
    const now = readTargets(ctx, fn);
    if (stageEntry(view, STAGE.targets, null).ended) {
      const valid = validTarget(view);
      const changed = changedTargets(valid.targets, now.targets);
      const blocked = changed.length ? { reason: `再開した run の照らす先が状態の指紋と食い違う: ${changed.join(', ')}`, paths: changed } : null;
      return { records: [], output: { viewpoints: valid.viewpoints, targets: publicTargets(valid.targets), criteriaDir: ctx.criteriaDir, blocked, compared: true } };
    }
    const coverage = now.viewpoints.includes(VIEWPOINT.flow) ? coverageReason(ctx.criteriaDir) : null;
    const record = { t: RECORDS.target, run: req.run, viewpoints: now.viewpoints, targets: publicTargets(now.targets), ...(coverage ? { coverage } : {}) };
    const records = [record];
    if (!now.blocked) records.push({ t: RECORDS.stageEnd, stage: STAGE.targets, round: null });
    return { records, output: { viewpoints: now.viewpoints, targets: record.targets, criteriaDir: ctx.criteriaDir, blocked: now.blocked, compared: false } };
  });
}

async function bundleText(view, generation) {
  const { entries } = await targetFiles(view.paths.at(-1));
  const texts = new Map();
  for (const { file, key } of entries) for (const a of assetTexts(key, await fs.readFile(file))) texts.set(a.id, a);
  const parts = [`# 資産の束（台帳 ${view.ledger.id}、世代 ${generation}）`, '', '各節の見出しは「資産 ID・パス・範囲」。本文の各行の先頭はファイルの中の行番号。', ''];
  for (const asset of currentAssets(view)) {
    const a = texts.get(asset.id);
    if (!a) internal(`台帳の資産が対象スキルに無い: ${asset.id}`);
    parts.push(`## ${asset.id} ${asset.path} ${JSON.stringify(asset.loc)}`);
    a.text.replace(/\n$/, '').split('\n').forEach((line, i) => parts.push(`L${a.firstLine + i}: ${line}`));
    parts.push('');
  }
  return parts.join('\n');
}

// SP-BPINSPECTION-017: 世代（台帳の取り直しの番号）ごとに 1 つ書く。台帳の世代が同じなら同じ中身になる。
export function bundle(ctx, req) {
  return mutate(ctx, req, OPS.bundle, async (view, dir) => {
    needInspecting(view);
    needLedger(view);
    const generation = view.retakes;
    const rel = `bundle.${generation}.md`;
    const file = path.join(dir, WORK_DIR, rel);
    const output = (after) => ({ path: file, generation, assets: currentAssets(after).length });
    const known = view.bundles.find((b) => b.generation === generation);
    const text = await bundleText(view, generation);
    const digest = sha256Hex(text);
    if (known) {
      const onDisk = await readOrNull(file);
      if (onDisk === null || sha256Hex(onDisk) !== known.sha256) {
        if (digest !== known.sha256) internal(`資産の束を書き直しても記録の sha256 と合わない（世代 ${generation}）`);
        await fs.writeFile(file, text);
      }
      return { records: [strip(known)], output };
    }
    await fs.writeFile(file, text);
    return { records: [{ t: RECORDS.bundle, generation, path: rel, sha256: digest }], output };
  });
}

export function placedShape(rec) {
  return rec.runs ? { runs: rec.runs } : { shape: rec.shape, row: rec.row };
}

function applicabilityOutput(rec) {
  return { ...placedShape(rec), units: rec.units, forced: rec.forced };
}

// 「性能・容量」の章を読めない写しでも、フローの観点の適用の判定は止めない（仕様の観点の全体を未検査として宣言する：SP-BPINSPECTION-005・025）。
const REVIEW_UNITS = Object.freeze({ tolerateNoCapacity: true });

// SP-BPINSPECTION-006・SP-BPFINDINGS-034: 受理した結果と段の終わりを同じ 1 行で書く。結果のある段への送り直しは最初の結果とだけ照らす。
export function applicability(ctx, req) {
  return mutate(ctx, req, OPS.applicability, (view) => {
    if (view.state.function !== FUNCTION.review) reject(CODES.input, `review だけの操作: ${view.state.function}`);
    needLedger(view);
    needCriteria(ctx);
    needStage(view, STAGE.applicability);
    const end = { t: RECORDS.stageEnd, stage: STAGE.applicability, round: null };
    const output = (after) => applicabilityOutput(after.applicability);
    if (view.applicability) {
      if (canonical(view.applicability.result) !== canonical(req.result ?? null)) reject(CODES.conflict, '適用の判定の結果が既にある記録と食い違う');
      return { records: [strip(view.applicability), end], output };
    }
    needPosInt(req.n, 'n は');
    const allowed = new Set(flowUnits(ctx.criteriaDir).map((u) => u.value));
    const judged = judgeApplicability(req.result, { assetIds: new Set(currentAssets(view).map((a) => a.id)), rows: applicabilityRows(ctx.criteriaDir, REVIEW_UNITS), allowed });
    if (judged.error) return rejected(REJECT_SCOPE.applicability, req.n, null, req.result, judged.error);
    const sources = forcedSources(ctx.criteriaDir, REVIEW_UNITS);
    // 一覧を読めたときの未検査は強いられていないので、検証役の理由のまま載せる（SP-BPINSPECTION-025）。
    const forcedBy = ignoredSettingsReadable(ctx.criteriaDir) ? {} : Object.fromEntries(judged.forced.map((u) => [u, forcedReason(sources, u)]));
    const record = { t: RECORDS.applicability, run: req.run, result: req.result, ...judged, forcedBy };
    return { records: [record, end], output };
  });
}

function reachedDetail(view) {
  const r = reachedStage(view);
  if (!r) return null;
  const entry = stageEntry(view, r.stage, null);
  return { ...r, parts: entry.parts, items: entry.items.map((id) => ({ ...itemStatus(view.items.get(id)), key: view.items.get(id).key })) };
}

export function inspectProgress(view) {
  const rec = view.applicability;
  const lastBundle = view.bundles.at(-1);
  return {
    targetsDone: Boolean(stageEntry(view, STAGE.targets, null)?.ended),
    viewpoints: runViewpoints(view),
    targets: validTarget(view)?.targets ?? null,
    bundle: lastBundle ? { generation: lastBundle.generation, path: lastBundle.path } : null,
    assignments: [...view.assignments.values()].filter((a) => a.stage === STAGE.assign).map((a) => ({ id: a.id, assets: a.assets })),
    applicability: rec ? applicabilityOutput(rec) : null,
    repeats: { [STAGE.assign]: view.repeats.get(STAGE.assign) ?? 0, [STAGE.applicability]: view.repeats.get(STAGE.applicability) ?? 0 },
    reached: reachedDetail(view),
  };
}

// SP-BPINSPECTION-024・SP-BPFINDINGS-030・SP-BPRUN-032: 返り値は状態だけから作り、確度・declared_only・audit_header に当たる鍵を持たない（SP-BPINSPECTION-014）。
export async function inspectOutcome(ctx, req) {
  const { view } = await readState(ctx, req.state);
  const { stop, out } = stopOutcome(view);
  out[RESULT_KEYS.unverifiedRoleLimits] = INSPECT_ROLE_WRITE_LIMITS;
  if (stop.kind !== STOP_KINDS.complete) return out;
  const report = ledgerReport(view, runViewpoints(view));
  const { findings, ...ledger } = report;
  out[RESULT_KEYS.findings] = findings;
  out[RESULT_KEYS.ledger] = ledger;
  out[RESULT_KEYS.targets] = validTarget(view).targets;
  out[RESULT_KEYS.uncheckedViewpoints] = uncheckedViewpoints(view);
  if (view.state.function === FUNCTION.review) {
    const a = view.applicability;
    out[RESULT_KEYS.applicability] = a.runs
      ? { ...a.result, runs: a.result.runs.map((r, i) => ({ ...r, shape: a.runs[i].shape, row: a.runs[i].row })) }
      : { ...a.result, shape: a.shape, row: a.row };
  } else {
    const paths = view.paths.at(-1);
    out[RESULT_KEYS.target] = { root: paths.root, files: paths.files };
  }
  return out;
}
