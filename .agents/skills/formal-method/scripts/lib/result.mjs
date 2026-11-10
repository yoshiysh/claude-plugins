// 結果（Result）の組立て（artifact-formats.md「結果」）。全ての欄を持つ閉じた object を作る。
// salvage の結果・作業記録は、時刻・pid・nonce を含まず、保存済みの範囲だけから決定的に作る。
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256Bytes } from './canonical.mjs';
import { scanSecrets } from './secrets.mjs';
import { AGENT_BATCH_DEADLINE_MS, TOOL_TIME_LIMIT_MAX_S, RESULT_SCHEMA, WORKLOG_SCHEMA, STAGES, INTERRUPT_CODES } from './schemas.mjs';
import { emptyPerformance, salvagePerformance } from './performance.mjs';
import { readState } from './store.mjs';
import { hashFile } from './storage.mjs';
import { ledgerEntry } from './worklog.mjs';

// 欠陥の残った分割を採らなかったときの decomposition.reason と decisions[].reason（artifact-formats.md「欠陥の残った分割」）
export const PARTITION_REJECTED = '分割の欠陥が残った';

export const INTERNAL_TIME_LIMITS = Object.freeze({ agent_batch_deadline_ms: AGENT_BATCH_DEADLINE_MS, tool_time_limit_max_s: TOOL_TIME_LIMIT_MAX_S, note: '内部の上限' });

export const reason = (code, stage, detail, extra = {}) => ({ code, stage, request_code: extra.request_code ?? null, item: extra.item ?? null, field: extra.field ?? null, detail });

export function emptyDecomposition(why) {
  return {
    graph: { nodes: [], edges: [], unconfirmed: [] }, criteria: { algorithm: 'writer-merge-scc/1' },
    candidates: [], decisions: [], adopted: false, reason: why,
    parts: [], boundaries: [], contracts: [], composition_conditions: [],
    correspondence: { matched: [], unmatched: [], excluded: [] },
  };
}

export function emptyScope(why) {
  return {
    targets: [], include: [], exclude: [], external_assumptions: [], unread: [],
    internal_time_limits: { ...INTERNAL_TIME_LIMITS }, extraction_coverage: { complete: false, reason: why },
  };
}

const stopStageOf = (reasons) => {
  const firstInterrupt = reasons.find((x) => INTERRUPT_CODES.includes(x.code));
  if (firstInterrupt) return firstInterrupt.stage;
  return [...reasons].sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage))[0].stage;
};

// 中断の理由を記録の順に先に並べる。
export function orderReasons(reasons) {
  return [...reasons.filter((x) => INTERRUPT_CODES.includes(x.code)), ...reasons.filter((x) => !INTERRUPT_CODES.includes(x.code))];
}

export function stopReport({ reasons, confirmed = [], unconfirmed = [], created = [], notCreated = [], running = [], aborted = [], questions = [], unsaved = [] }) {
  const ordered = orderReasons(reasons);
  return {
    stage: stopStageOf(ordered), reasons: ordered,
    confirmed_scope: confirmed, unconfirmed_scope: unconfirmed,
    artifacts_created: created, artifacts_not_created: notCreated,
    checks_running: running, checks_aborted: aborted,
    questions, unsaved: [...new Set(unsaved.map((u) => u.kind))],
  };
}

// run の領域の無いまま start が返す 受付 の停止（cli-contract.md「起動の手順」2・3・5-1）。保存しない仮の結果。
const ALL_KINDS_AT_ACCEPT = ['request', 'document_rules', 'worklog', 'ledger', 'result', 'report'];
export function acceptanceStopResult({ code, detail, location, requestUnsaved = false, unverified = [] }) {
  const why = code === '起動の失敗' ? 'run-daemon が run の領域を作らなかったので保存する者がいない' : '保存先に書けないので保存しない';
  const unsaved = ALL_KINDS_AT_ACCEPT.map((kind) => ({ kind, ref: null, reason: kind === 'request' && requestUnsaved ? `${detail}` : why }));
  const reasons = [reason(code, '受付', detail), reason('記録の未保存', '集約', '結果を含む全ての記録を保存していない')];
  return {
    schema: RESULT_SCHEMA, status: '停止', provisional: true,
    verified_scope: emptyScope('受付で止まったので対象を取得していない'),
    properties: [], checks: [], models: [], decomposition: emptyDecomposition('受付で止まった'),
    counterexamples: [], causes: [], confirmations: { deterministic: [], meaning: [] },
    unverified, questions: [],
    records: { ledger_refs: ['ledger.json'], saved: [], unsaved },
    stop_report: stopReport({ reasons, notCreated: [{ kind: 'request', reason: why }], unsaved }),
    performance: emptyPerformance(location, '受付で止まったので測っていない'),
  };
}

// 結果か台帳に秘密値の型があって公開しないときの R'（cli-contract.md「run の領域の配置」の秘密値の走査）。
// R の中身（性質・検査・理由の文など）を持たず、CLI が決めた ref と指紋と固定の理由だけで作る。値は診断にも残さない。
export function secretStopResult(result, { location, why }) {
  const unsavedOwn = [{ kind: 'ledger', ref: 'ledger.json', reason: why }, { kind: 'result', ref: 'result.json', reason: why }];
  const build = (saved, unsaved) => {
    const reasons = [reason('保存の失敗', '集約', why), reason('記録の未保存', '集約', '保存できなかった記録がある')];
    return {
      schema: RESULT_SCHEMA, status: '停止', provisional: true,
      verified_scope: emptyScope(why), properties: [], checks: [], models: [], decomposition: emptyDecomposition(why),
      counterexamples: [], causes: [], confirmations: { deterministic: [], meaning: [] },
      unverified: [{ item: '結果の内容', reason: why }], questions: [],
      records: { ledger_refs: ['ledger.json'], saved, unsaved },
      stop_report: stopReport({ reasons, created: saved.map((s) => ({ kind: s.kind, ref: s.ref })), unsaved }),
      performance: emptyPerformance(location, why),
    };
  };
  const saved = result.records.saved.filter((s) => s.hash !== null).map((s) => ({ kind: s.kind, ref: s.ref, hash: s.hash }));
  const unsaved = [...result.records.unsaved.filter((u) => u.kind !== 'ledger' && u.kind !== 'result').map((u) => ({ kind: u.kind, ref: u.ref, reason: '保存できなかった' })), ...unsavedOwn];
  const r = build(saved, unsaved);
  // ref にも型が当たるなら、記録の一覧も返さない
  return scanSecrets(canonicalJson(r)).length ? build([], unsavedOwn) : r;
}

// ---- salvage（cli-contract.md「salvage の手順」5） ----
const DOC_RULES = fileURLToPath(new URL('../../references/document-rules.md', import.meta.url));

// 適用した文書規約。state.json に無ければ今の規約の版で参照を作り、その写しが run の領域に無いことを unconfirmed で示す。
function docRulesOf(runDir, state) {
  if (state && state.document_rules) return { rules: state.document_rules, note: null };
  const version = sha256Bytes(readFileSync(DOC_RULES));
  const ref = `document-rules/${version.slice(7)}.md`;
  let present = false;
  try { present = hashFile(join(runDir, ref)) === version; } catch { present = false; }
  return { rules: { ref, version }, note: present ? null : `state.json に適用した文書規約が無く、今の規約の写し ${ref} も run の領域に無い` };
}

// state.json が数える範囲で、再読込の指紋が一致する記録だけを残す。
function verifiedEntries(runDir, state) {
  const saved = [];
  const lost = [];
  for (const e of (state && Array.isArray(state.entries) ? state.entries : [])) {
    let ok = false;
    try { ok = hashFile(join(runDir, e.ref)) === e.hash; } catch { ok = false; }
    if (ok) saved.push(e); else lost.push({ kind: e.kind, ref: e.ref, reason: '再読込の指紋が一致しない' });
  }
  return { saved, lost };
}

export function salvageWorklog(runDir) {
  const state = readState(runDir);
  const { saved } = verifiedEntries(runDir, state);
  const doc = docRulesOf(runDir, state);
  return {
    schema: WORKLOG_SCHEMA, role: 'salvage', task_id: null, stage: '集約', target: basename(runDir),
    inputs: saved.map((e) => ({ ref: e.ref, hash: e.hash })),
    actions: 'run.lock の保持者が終わった run について、rename まで終えた記録を再読込して指紋を照合し、停止 の結果を作った。',
    results: `保存済みの記録 ${saved.length} 件から、処理の中断 の結果を作った。`,
    grounds: 'state.json が数える範囲で再読込の指紋が一致した記録だけを使った。',
    failures: [], unconfirmed: ['run-daemon が保存する前に持っていた判定は失われた', ...(doc.note ? [doc.note] : [])], unreadable_inputs: [],
    document_rules: doc.rules,
  };
}

const savedRecord = (e) => ({ kind: e.kind, ref: e.ref, hash: e.hash });

// 保存済みの範囲だけから 処理の中断 の結果を作る。unpublished なら公開しない R'（規則 4 の I/O の誤り）。
// 戻り値: { result, ledgerEntries }（ledgerEntries は追補台帳の entry。unpublished なら null）
export function buildSalvageResult(runDir, { location, unpublished = false, worklog = null }) {
  const state = readState(runDir);
  const stage = state && STAGES.includes(state.stage_confirmed) ? state.stage_confirmed : '受付';
  const loc = state && (state.location === 'CI' || state.location === 'ローカル') ? state.location : location;
  const { saved, lost } = verifiedEntries(runDir, state);
  const unsaved = [...lost];
  const reasons = [reason('処理の中断', stage, 'run-daemon が結果を公開する前に終わったので、salvage が保存済みの範囲から結果を作った')];
  const records = { ledger_refs: ['salvage-ledger.json'], saved: saved.map(savedRecord), unsaved };
  const ledgerEntries = [...saved];
  if (unpublished) {
    const why = 'salvage.mark を書けない（I/O の誤り）ので、salvage の記録を公開しない';
    unsaved.push({ kind: 'salvage_worklog', ref: 'salvage-worklog.json', reason: why }, { kind: 'salvage_ledger', ref: 'salvage-ledger.json', reason: why }, { kind: 'result', ref: 'result.json', reason: why });
    reasons.push(reason('保存の失敗', '集約', why));
  } else {
    if (worklog && worklog.hash) {
      records.saved.push({ kind: 'salvage_worklog', ref: 'salvage-worklog.json', hash: worklog.hash });
      ledgerEntries.push(ledgerEntry({ kind: 'salvage_worklog', ref: 'salvage-worklog.json', hash: worklog.hash, stage: '集約', producer: 'salvage' }));
    } else {
      unsaved.push({ kind: 'salvage_worklog', ref: 'salvage-worklog.json', reason: `salvage の作業記録を公開できない（${worklog ? worklog.reason : '不明'}）` });
    }
    records.saved.push({ kind: 'salvage_ledger', ref: 'salvage-ledger.json', hash: null }, { kind: 'result', ref: 'result.json', hash: null });
  }
  if (unsaved.length > 0) reasons.push(reason('記録の未保存', '集約', '保存できなかった記録がある'));
  const r = {
    schema: RESULT_SCHEMA, status: '停止', provisional: unpublished,
    verified_scope: emptyScope('run-daemon が結果を公開する前に終わったので、抽出の網羅を確かめていない'),
    properties: [], checks: [], models: [], decomposition: emptyDecomposition('run-daemon が結果を公開する前に終わった'),
    counterexamples: [], causes: [], confirmations: { deterministic: [], meaning: [] },
    unverified: [{ item: 'run の全体', reason: 'run-daemon が保存する前に持っていた判定は失われた' }], questions: [],
    records,
    stop_report: stopReport({ reasons, created: saved.map((e) => ({ kind: e.kind, ref: e.ref })), unsaved }),
    performance: salvagePerformance(loc),
  };
  return { result: r, ledgerEntries: unpublished ? null : ledgerEntries };
}

// ---- run-daemon の集約の段の結果（artifact-formats.md「結果」「判定の 3 関数」「stop_report.stage の決め方」） ----
import { aggregateProperty, decideStatus, classifyCheck, isSuccess as SUCCESS } from './verdict.mjs';
import { NOT_STARTED_END } from './scheduler.mjs';
import { compareCandidates, findings, ms, bytes, unavailable, BUILD, COST, HUMAN, RETRIES } from './performance.mjs';
import { pathsCheck, deriveDiagram } from './checks/model.mjs';
import { correspondence as correspondenceOf } from './checks/compose.mjs';
import { TRUNCATED } from './checks/det.mjs';
import { noSuitableTool } from './adapters/index.mjs';

const allHold = (confs) => confs.length > 0 && confs.every((c) => c.result === '成り立つ');
const uniq = (xs) => [...new Set(xs)];
const sameRef = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 起こらない終わり方の組（CLI の不具合）は、実行の段で 内部の誤り として記録済み（run.mjs の runSpecs）。ここでは閉じた値の集合に置く。
function safeVerdict(end) { try { return classifyCheck(end); } catch { return '実行失敗'; } }

function checkReason(verdict, e, c) {
  if (e && e.invalidEnd) return `道具の終わり方が起こらない組（${e.invalidEnd}）で、判定を決められない（CLI の内部の誤り）`;
  if (!e || !e.outcome || !e.outcome.end.started) return `検査を始めなかった: ${e?.notStartedReason ?? '実行の段に届かなかった'}`;
  const end = e.outcome.end;
  const base = {
    成功: 'z3 が期待どおりの答え（unsat）を返した',
    反例: 'z3 が性質に反する例（sat）を返した',
    unknown: 'z3 が判定できないと返した',
    時間切れ: end.time_limit_hit === '道具' ? `道具自身の時間の上限（-T:${c.tool_time_limit_seconds}）に達した` : '依頼元の時間の上限（検査に使える期限）で止めた',
    実行失敗: end.tool_result === '判定以外のエラー' ? '道具が判定以外のエラーを報告した' : end.abnormal_exit ? 'formal-method が止めていない道具が 0 以外で終わった' : '道具の出力を読めない',
    未実行: '道具の結果を得る前に formal-method が止めた',
  }[verdict] ?? `判定 ${verdict}`;
  return e.outcome.model_cut === 'truncated' ? `${base}。${TRUNCATED}` : base;
}

export function buildResult(run) {
  const invProps = run.inventoryProperties();
  const excludedPointers = (run.request?.scope.exclude ?? []).map((x) => x.item);
  const isExcluded = (ptr) => excludedPointers.some((x) => sameRef(x, ptr));
  const props = invProps;
  const planChecks = run.planChecks();
  const conds = run.partitions?.data.composition_conditions ?? [];
  const contracts = run.partitions?.data.contracts ?? [];
  const mpsOf = (pid) => run.models.flatMap((m) => m.data.properties.filter((p) => p.inventory_property_ids.includes(pid)).map((p) => p.id));
  const checkIdsOf = (pid) => {
    const mps = mpsOf(pid);
    const cs = conds.filter((c) => mps.includes(c.derived_from)).map((c) => c.id);
    return planChecks.filter((c) => (c.kind === 'property' && mps.includes(c.target_id)) || (c.kind === 'composition' && cs.includes(c.target_id))).map((c) => c.id);
  };
  // 検査
  const checks = planChecks.map((c) => {
    const e = run.exec.get(c.id);
    const end = e && e.outcome ? e.outcome.end : { ...NOT_STARTED_END };
    const verdict = safeVerdict(end);
    const stopped = end.stopped_by !== null;
    return {
      id: c.id, kind: c.kind, model_id: c.model_id, assumptions: [...c.assumptions], scope: c.scope,
      unit: `z3 -in -T:${c.tool_time_limit_seconds}${c.kind === 'property' || c.kind === 'composition' ? ' -model' : ''} ← ${c.input_refs.join(' + ')}`,
      tool_time_limit: { seconds: c.tool_time_limit_seconds, source: '計画（内部の上限 TOOL_TIME_LIMIT_MAX_S 以下）' },
      state: end.started ? '実行した' : '実行していない', verdict, end, reason: checkReason(verdict, e, c),
      evidence_refs: [...(e?.inputRef ? [e.inputRef] : []), ...(e?.evidence ?? [])],
      completed_scope: stopped ? '止めるまでに道具は結果を返していない（完了した範囲は無い）' : null,
      incomplete_scope: stopped ? c.scope : null,
    };
  });
  const checkById = new Map(checks.map((c) => [c.id, c]));
  const confs = [...run.confirmations.deterministic, ...run.confirmations.meaning];
  const confsOf = (kind, pid) => confs.filter((c) => c.kind === kind && c.property_ids.includes(pid));
  const noTool = (pid) => noSuitableTool(run.prepare, run.selectionOf(pid));
  const questionIds = new Set(run.resultQuestions.map((q) => q.id));
  const qDeps = (pid) => uniq([...(run.blockedBy.get(pid) ?? []), ...run.resultQuestions.filter((q) => q.affected.includes(pid)).map((q) => q.id)]);
  const mappingRows = run.models.flatMap((m) => m.mapping.data.rows.map((r) => ({ ...r, model_id: m.id })));
  // 検出能力
  const detectionOf = (p) => {
    if (!p.formalizable) {
      const alt = allHold(confsOf('nonformal', p.id));
      return { status: alt ? '別の方法で確認' : '検出能力未確認', mutations: [], reason: alt ? '形式化できない性質なので、変異による検出の代わりに別の方法の独立した確認で確かめた' : '形式化できない性質で、別の方法の独立した確認が成り立たない' };
    }
    const mps = mpsOf(p.id);
    const all = (run.mutations?.data.mutations ?? []).filter((m) => mps.includes(m.property_id));
    const active = all.filter((m) => !run.planDefects.has(m.id));
    const removed = all.filter((m) => run.planDefects.has(m.id)).map((m) => m.id);
    if (active.length) {
      const rows = active.map((m) => {
        const c = run.confirmations.deterministic.find((x) => x.kind === 'mutation' && x.plan_id === m.id);
        return { m, c };
      }).filter((x) => x.c);
      const mutations = rows.map(({ m, c }) => ({ id: m.id, expected_violation: m.expected_violation, detected: c.result === '成り立つ', confirmation_id: c.id }));
      const status = rows.some((x) => x.c.result === '成り立たない') ? '検出せず' : rows.length && rows.every((x) => x.c.result === '成り立つ') ? '検出を確認' : '検出能力未確認';
      return { status, mutations, reason: { 検出を確認: '用意した変異を全て検査が検出した', 検出せず: '検査が検出しない変異がある', 検出能力未確認: '変異の確認ができなかった' }[status] };
    }
    // 欠陥の残らない変異を持たない性質は、alternative の有無によらず 検出能力未確認（artifact-formats.md「変異の無い性質の detection」）。
    // reason には alternative の文（あれば unavailable の順に）、「別の方法の確認の結果が無い」、除いた変異の計画の id を全て書く
    const un = (run.mutations?.data.unavailable ?? []).filter((u) => u.property_id === p.id);
    const alternatives = un.map((u) => u.alternative).filter((x) => x !== null);
    const parts = [
      ...(un.length ? [`変異を用意できない（${un.map((u) => u.reason).join('・')}）`] : []),
      ...(alternatives.length ? [`別の方法: ${alternatives.join('・')}`] : []),
      '別の方法の確認の結果が無い',
      ...(removed.length ? [`欠陥で除いた変異: ${removed.join(', ')}`] : []),
    ];
    return { status: '検出能力未確認', mutations: [], reason: parts.join('。') };
  };
  const detections = new Map(props.map((p) => [p.id, detectionOf(p)]));
  // PropertyFacts（合成の条件を除く）
  const baseFacts = new Map();
  for (const p of props) {
    const mps = mpsOf(p.id);
    const sanityAll = (run.plan?.data.sanity ?? []).filter((s) => mps.includes(s.model_property_id));
    const sanityRemoved = sanityAll.some((s) => run.planDefects.has(s.id));
    const sanityConfs = run.confirmations.deterministic.filter((c) => c.kind === 'sanity' && mps.includes(c.model_property_id));
    const det = detections.get(p.id);
    baseFacts.set(p.id, {
      formalizable: p.formalizable,
      check_verdicts: checkIdsOf(p.id).map((id) => checkById.get(id).verdict),
      no_suitable_tool: noTool(p.id),
      depends_on_question: qDeps(p.id).length > 0,
      correspondence: p.formalizable ? mappingRows.some((r) => r.property_id === p.id && r.relation === '形式化') : true,
      meaning_confirmed: allHold(confsOf('fidelity', p.id)) && allHold(confsOf('assurance', p.id)),
      deterministic_confirmed: allHold(sanityConfs) && !sanityRemoved,
      composition_applies: false, composition_confirmed: false,
      detection_performed: det.mutations.length > 0, detection_confirmed: det.mutations.length > 0 && det.mutations.every((m) => m.detected),
      alternative_confirmed: allHold(confsOf('nonformal', p.id)),
    });
  }
  // 契約の判定
  const compositionConfs = run.confirmations.meaning.filter((c) => c.kind === 'composition');
  const contractResults = contracts.map((k) => {
    const parents = run.parentsOf(k.derived_from).map((pid) => baseFacts.get(pid)).filter(Boolean);
    const ids = planChecks.filter((c) => c.kind === 'contract' && c.target_id === k.id).map((c) => c.id);
    const facts = {
      formalizable: true, check_verdicts: ids.map((id) => checkById.get(id).verdict),
      no_suitable_tool: parents.some((f) => f.no_suitable_tool), depends_on_question: parents.some((f) => f.depends_on_question),
      correspondence: parents.length > 0 && parents.every((f) => f.correspondence), deterministic_confirmed: parents.length > 0 && parents.every((f) => f.deterministic_confirmed),
      meaning_confirmed: allHold(compositionConfs), composition_applies: false, composition_confirmed: false,
      detection_performed: false, detection_confirmed: false, alternative_confirmed: false,
    };
    const verdict = aggregateProperty(facts);
    const reasonText = ids.length === 0 ? '計画にこの契約の検査が無い' : verdict.includes('反例') ? `契約の検査 ${ids.join(', ')} が反例を返した` : `契約の検査 ${ids.join(', ')} の判定と、親の性質の確認から判定した`;
    return { id: k.id, model_id: k.model_id, derived_from: k.derived_from, part_id: k.part_id, statement: k.statement, verdict, check_ids: ids, reason: reasonText };
  });
  const corr = run.partitions?.data.adopted ? correspondenceOf(run.graph, run.partitions.data.parts) : { matched: [], unmatched: [], excluded: [] };
  const boundaries = run.partitions?.data.adopted ? run.partitions.data.boundaries : [];
  for (const p of props) {
    const f = baseFacts.get(p.id);
    const mps = mpsOf(p.id);
    const myConds = conds.filter((c) => mps.includes(c.derived_from));
    const myContracts = contractResults.filter((k) => mps.includes(k.derived_from));
    f.composition_applies = Boolean(run.partitions?.data.adopted) && (myConds.length + myContracts.length) > 0;
    f.composition_confirmed = myConds.every((c) => { const ids = planChecks.filter((x) => x.kind === 'composition' && x.target_id === c.id).map((x) => x.id); return ids.length > 0 && ids.every((id) => checkById.get(id).verdict === '成功'); })
      && myContracts.every((k) => SUCCESS(k.verdict)) && !boundaries.some((b) => b.assumption_basis.kind === '確認できない前提') && corr.unmatched.length === 0;
  }
  // 性質ごとの結果
  const sourcesOf = (p) => {
    const inv = run.inventories.find((i) => i.target_id === p.target_id);
    const loc = p.source_ids.map((sid) => inv.data.elements.find((e) => e.id === sid)).filter(Boolean)
      .map((e) => ({ kind: 'location', id: null, source: { target_id: e.source.target_id, file: e.source.file, span: e.source.span } }));
    const req = mappingRows.filter((r) => r.property_id === p.id && (r.source.kind === 'goal' || r.source.kind === 'known_requirement') && !isExcluded(r.source))
      .map((r) => ({ kind: r.source.kind, id: r.source.id, source: null }));
    const all = [...req, ...loc];
    return all.filter((x, i) => all.findIndex((y) => sameRef(x, y)) === i);
  };
  const methodOf = (pid) => {
    const s = run.selectionOf(pid);
    if (!s) return null;
    const cmp = compareCandidates(s.candidates);
    return { chosen: { ...s.chosen }, candidates: cmp.candidates, reason: s.reason, comparison_conditions: cmp.comparison_conditions };
  };
  const properties = props.map((p) => {
    const f = baseFacts.get(p.id);
    const verdict = aggregateProperty(f);
    const ids = checkIdsOf(p.id);
    const mps = mpsOf(p.id);
    const firstMp = mps.length ? run.mpInfo(mps[0]).p : null;
    const why = [];
    if (verdict.includes('検証済み')) why.push('検査が全て成功し、対応・意味の確認・決定的な検査・検出能力の確認が成り立った');
    else if (verdict.includes('別手段で確認済み')) why.push('形式化できない性質で、別の方法による独立した確認が成り立った');
    else {
      if (f.check_verdicts.some((v) => v !== '成功')) why.push(`成功でない検査がある（${uniq(f.check_verdicts.filter((v) => v !== '成功')).join('・')}）`);
      if (p.formalizable && ids.length === 0) why.push(f.no_suitable_tool ? '適した道具が無いか準備できないので検査が無い' : f.depends_on_question ? `回答を待つ問い（${qDeps(p.id).join(', ')}）に依存するので検査を作らない` : run.plan ? '計画にこの性質の検査が無い' : '計画が無い');
      if (f.depends_on_question) why.push(`回答を待つ問い（${qDeps(p.id).join(', ')}）に依存する`);
      if (!f.correspondence) why.push('形式化 の対応が無い');
      if (p.formalizable && !f.meaning_confirmed) why.push('意味の確認（忠実さ・保証）が成り立たない');
      if (p.formalizable && !f.deterministic_confirmed) why.push('前提の整合の確認が成り立たない');
      if (f.composition_applies && !f.composition_confirmed) why.push('合成の条件が成り立たない');
      if (f.detection_performed && !f.detection_confirmed) why.push('変異の検出が成り立たない');
      if (!p.formalizable && !f.alternative_confirmed) why.push('別の方法による独立した確認が成り立たない');
      if (why.length === 0) why.push('検証の成功の条件が成り立たない');
    }
    return {
      id: p.id, statement: p.statement, sources: sourcesOf(p), formalizable: p.formalizable, nonformal_reason: p.formalizable ? null : (p.nonformal_reason ?? '形式化できない'),
      verdict,
      assurance: p.formalizable ? (firstMp ? structuredClone(firstMp.assurance) : null) : { kind: '形式検証でない確認', method: p.nonformal_method ?? '別の方法による独立した確認' },
      detection: detections.get(p.id),
      method: p.formalizable ? methodOf(p.id) : null,
      check_ids: ids,
      confirmation_ids: confs.filter((c) => c.property_ids.includes(p.id)).map((c) => c.id),
      evidence_refs: uniq(ids.flatMap((id) => checkById.get(id).evidence_refs)),
      reason: why.join('。'),
      depends_on_questions: qDeps(p.id).filter((q) => questionIds.has(q)),
    };
  });
  // モデル
  const firstModel = run.models[0]?.id;
  const mappedProps = new Set(mappingRows.map((r) => r.property_id));
  const mappedGoals = new Set(mappingRows.filter((r) => r.source.kind === 'goal').map((r) => r.source.id));
  const models = run.models.map((m) => {
    const combos = (run.combinations ?? []).find((x) => x.model.id === m.id)?.combinations ?? { applicable: false, reason: '組合せを分類していない' };
    return {
      id: m.id, ref: m.ref, covers: structuredClone(m.data.covers),
      mapping: m.mapping.data.rows.map((r) => {
        const ids = r.relation === '形式化' ? checkIdsOf(r.property_id).filter((id) => checkById.get(id).model_id === m.id) : [];
        let reasonText = r.reason;
        if (r.relation === '形式化' && ids.length === 0) {
          const qs = qDeps(r.property_id);
          reasonText = noTool(r.property_id) ? '適した道具が無いか準備できないので、計画にこの性質の検査が無い'
            : qs.length ? `回答を待つ問い ${qs.join(', ')} に依存するので、計画にこの性質の検査が無い`
              : run.plan ? '計画にこの性質の検査が無い（検査の欠けが修正の巡の後も残った）' : '計画作成役が計画を返さなかったので、計画が無い';
        }
        return { source: structuredClone(r.source), property_id: r.property_id, model_element: r.model_element, check_ids: ids, relation: r.relation, reason: reasonText };
      }),
      unmapped: {
        requirements: m.id === firstModel ? (run.request?.goals ?? []).filter((g) => !mappedGoals.has(g.id)).map((g) => ({ kind: 'goal', id: g.id })) : [],
        properties: m.id === firstModel ? invProps.filter((p) => !mappedProps.has(p.id) && !run.blockedBy.has(p.id)).map((p) => p.id) : [],
        model_elements: [],
      },
      combinations: combos, paths: pathsCheck(m.data), behavior: structuredClone(m.data.behavior), diagram: deriveDiagram(m.data),
    };
  });
  // 分割と合成
  const decomposition = {
    graph: run.graph, criteria: { algorithm: 'writer-merge-scc/1' }, candidates: run.candidates,
    decisions: run.decisions.length ? run.decisions.map((d) => ({ ...d })) : run.candidates.length >= 2 ? run.candidates.map((c) => ({ candidate_id: c.id, adopted: false, reason: '分割作成役の判断が無いので分割しない' })) : [],
    adopted: Boolean(run.partitions?.data.adopted),
    reason: run.partitions?.data.adopted ? run.partitions.data.reason : run.partitionRejected ? PARTITION_REJECTED : run.candidates.length >= 2 ? (run.decisions.length ? '分割作成役が分割しないと判断した' : '分割作成役の判断が無いので分割しない') : `分割の候補が ${run.candidates.length} 個なので分割しない`,
    parts: run.partitions?.data.adopted ? structuredClone(run.partitions.data.parts) : [],
    boundaries: structuredClone(boundaries),
    contracts: run.partitions?.data.adopted ? contractResults : [],
    composition_conditions: run.partitions?.data.adopted ? conds.map((c) => ({ id: c.id, model_id: c.model_id, derived_from: c.derived_from, statement: c.statement, check_ids: planChecks.filter((x) => x.kind === 'composition' && x.target_id === c.id).map((x) => x.id), depends_on: [...c.depends_on] })) : [],
    correspondence: corr,
  };
  // 反例と原因
  const counterexamples = run.counterexamples.map((x) => {
    const p = invProps.find((y) => y.id === x.property_id);
    const rows = mappingRows.filter((r) => r.property_id === x.property_id).map((r) => r.source);
    const ptrs = rows.length ? rows : (p ? sourcesOf(p).filter((s) => s.kind === 'location').map((s) => ({ kind: 'location', ...s.source })) : []);
    const r = run.exec.get(x.replayId);
    const e = run.exec.get(x.check_id);
    return {
      id: x.id, property_id: x.property_id, sources: ptrs.filter((s, i) => ptrs.findIndex((y) => sameRef(s, y)) === i), check_id: x.check_id,
      input_and_trace: `検査 ${x.check_id} の query（${e.inputRef}）に z3 が sat を返した。証人は ${e.evidence.find((ref) => ref.endsWith('stdout.txt')) ?? '保存できなかった標準出力'} にある`,
      violated_condition: p ? p.statement : `性質 ${x.property_id}`,
      replay: { confirmation_id: x.replayId, steps_ref: r && r.inputRef ? r.inputRef : e.inputRef },
    };
  });
  const subjects = run.causeSubjects();
  const causes = subjects.map((s) => run.causes.find((c) => sameRef(c.subject, s)) ?? { subject: s, cause: '原因未確認', grounds: '時間の上限か停止で原因の分類役を出さなかった', classified_by: 'cli' });
  // 未検証
  const unverified = [...run.unverified];
  for (const [id, text] of run.planDefects) unverified.push({ item: `計画の欠陥: ${id}`, reason: text });
  for (const { model, combinations } of run.combinations ?? []) if (combinations.applicable) for (const c of combinations.cells) if (c.class === '対応できていない') unverified.push({ item: `対応できていない組合せ: ${model.id} の ${c.state} × ${c.event}`, reason: c.grounds });
  // 読めない箇所: 取得で読めなかったものと、抽出役が scanned に unread と申告したもの（同じファイルの全体は 1 つにする）
  const unread = run.targets.flatMap((t) => t.unread.map((u) => ({ target_id: t.id, file: u.file, span: null, reason: u.reason })));
  for (const inv of run.inventories) {
    for (const s of inv.data.scanned) {
      if (s.status !== 'unread') continue;
      if (unread.some((u) => u.target_id === inv.target_id && u.file === s.file && (u.span === null || u.span === s.span))) continue;
      unread.push({ target_id: inv.target_id, file: s.file, span: s.span, reason: s.reason ?? '抽出役が読めなかったと申告した' });
    }
  }
  for (const u of unread) unverified.push({ item: `読めない箇所: ${u.target_id} の ${u.file}${u.span ? ` ${u.span}` : ''}`, reason: u.reason });
  // 範囲
  const extractionConfs = run.confirmations.meaning.filter((c) => c.kind === 'extraction');
  const coverageOk = unread.length === 0 && run.targets.length > 0 && extractionConfs.length === run.targets.length && allHold(extractionConfs);
  const verifiedScope = {
    targets: run.targets.map((t) => ({ id: t.id, location: t.location, resolved_location: t.resolved_location, revision: t.revision, content_hash: t.content_hash, files: t.files.map((f) => ({ path: f.path, content_hash: f.content_hash, text: f.text })) })),
    include: structuredClone(run.requestScope?.include ?? []),
    exclude: [
      ...(run.requestScope?.exclude ?? []).map((x) => ({ item: structuredClone(x.item), reason: x.reason, origin: '依頼元' })),
      ...run.targets.flatMap((t) => t.excluded.map((file) => ({ item: { kind: 'location', target_id: t.id, file }, reason: 'formal-method が除く', origin: 'formal-method' }))),
    ],
    external_assumptions: run.inventories.flatMap((i) => i.data.external_dependencies.map((d) => ({ id: d.id, text: d.text, source: d.source ? structuredClone(d.source) : null }))),
    unread,
    internal_time_limits: { ...INTERNAL_TIME_LIMITS },
    extraction_coverage: { complete: coverageOk, reason: coverageOk ? '読めなかった箇所が無く、抽出の独立した確認が全て成り立った' : unread.length ? '読めなかった箇所が残る' : extractionConfs.length < run.targets.length || run.targets.length === 0 ? '抽出の独立した確認が無い対象がある' : '抽出の独立した確認が成り立たない' },
  };
  // 性能
  const execs = [...run.exec.values()].map((e) => ({
    id: e.id, kind: e.kind,
    elapsed_ms: e.stats && Number.isFinite(e.stats.elapsed_ms) ? ms(e.stats.elapsed_ms) : unavailable(e.outcome && e.outcome.end.started ? '所要時間を測れなかった' : '実行していない'),
    cpu_time_ms: e.stats && e.stats.sampled && Number.isFinite(e.stats.cpu_time_ms) ? ms(e.stats.cpu_time_ms) : unavailable('CPU 時間の標本を取れなかった'),
    peak_rss_bytes: e.stats && e.stats.sampled ? bytes(e.stats.peak_rss_bytes) : unavailable('常駐メモリの標本を取れなかった'),
  }));
  const cpu = execs.filter((x) => 'value' in x.cpu_time_ms).map((x) => x.cpu_time_ms.value);
  const rss = execs.filter((x) => 'value' in x.peak_rss_bytes).map((x) => x.peak_rss_bytes.value);
  const performance = {
    location: run.location,
    run: {
      total_ms: ms(Number((process.hrtime.bigint() - run.startedHr) / 1000000n)),
      preparation_ms: Number.isFinite(run.prepareMs) ? ms(run.prepareMs) : unavailable('道具の準備まで届かなかった'),
      build_ms: BUILD,
      checks_ms: Number.isFinite(run.timing.checksMs) ? ms(run.timing.checksMs) : unavailable('実行の段まで届かなかった'),
      confirmation_ms: Number.isFinite(run.timing.confirmationMs) ? ms(run.timing.confirmationMs) : unavailable('確認の段まで届かなかった'),
      storage_ms: unavailable('保存の所要時間を記録の外で測っていない'),
      cpu_time_ms: cpu.length ? ms(cpu.reduce((a, b) => a + b, 0)) : unavailable('道具の CPU 時間の標本を取れなかった'),
      peak_rss_bytes: rss.length ? bytes(Math.max(...rss)) : unavailable('道具の常駐メモリの標本を取れなかった'),
      cost: COST, human_interventions: HUMAN, retries: RETRIES,
    },
    executions: execs,
    findings: findings(checks.filter((c) => c.end.started).map((c) => ({ id: c.id, time_limit_hit: c.end.time_limit_hit, tool_result: c.end.tool_result }))),
  };
  return { properties, checks, models, decomposition, counterexamples, causes, unverified, verifiedScope, performance, baseFacts };
}

// 完了の条件を当て、停止の報告を作って Result を閉じる。records は公開が成功すると仮定した記録。
export function finalizeResult(run, parts, records) {
  const { properties, checks, models, decomposition, counterexamples, causes, unverified, verifiedScope, performance } = parts;
  const confirmations = { deterministic: run.confirmations.deterministic, meaning: run.confirmations.meaning };
  const uncovered = models.reduce((n, m) => n + (m.combinations.applicable ? m.combinations.cells.filter((c) => c.class === '対応できていない').length : 0), 0);
  const global = {
    required_verdicts: properties.map((p) => p.verdict),
    confirmations_unresolved: [...confirmations.deterministic, ...confirmations.meaning].some((c) => c.result !== '成り立つ'),
    uncovered_combinations: uncovered,
    pending_questions: run.resultQuestions.length,
    all_records_saved: records.unsaved.length === 0,
    detection_unconfirmed: properties.filter((p) => p.detection.status === '検出能力未確認').length,
    has_counterexample: properties.some((p) => p.verdict.includes('反例')),
    has_unrunnable: properties.some((p) => p.verdict.includes('未実行') || p.verdict.includes('実行失敗')),
  };
  const decision = decideStatus(global);
  const toolMissingUnrun = properties.some((p) => p.verdict.includes('未実行') && parts.baseFacts.get(p.id)?.no_suitable_tool);
  const STAGE = { 対応できていない組合せ: 'モデル化', 回答を待つ問い: '確認', 反例: '実行', 実行できない検査: toolMissingUnrun ? '計画' : '実行' };
  const DETAIL = {
    必要な性質が検証の成功でない: `検証の成功でない必要な性質: ${properties.filter((p) => !SUCCESS(p.verdict)).map((p) => `${p.id}（${p.verdict.join('・')}）`).join('、') || 'なし'}`,
    確認が終わっていない: `成り立つ でない確認: ${[...confirmations.deterministic, ...confirmations.meaning].filter((c) => c.result !== '成り立つ').map((c) => `${c.id}（${c.result}）`).join('、')}`,
    対応できていない組合せ: `対応できていない組合せが ${uncovered} 個ある`,
    回答を待つ問い: `回答を待つ問い: ${run.resultQuestions.map((q) => q.id).join('、')}`,
    記録の未保存: `保存できなかった記録: ${records.unsaved.map((u) => u.ref ?? u.kind).join('、')}`,
    '必要な性質が 0 件': '必要な性質が 0 件なので完了にしない（保持規則）',
    検出能力未確認: `検出能力未確認の性質: ${properties.filter((p) => p.detection.status === '検出能力未確認').map((p) => p.id).join('、')}（保持規則）`,
    反例: `反例を持つ性質: ${properties.filter((p) => p.verdict.includes('反例')).map((p) => p.id).join('、')}`,
    実行できない検査: `検査を実行できない性質: ${properties.filter((p) => p.verdict.includes('未実行') || p.verdict.includes('実行失敗')).map((p) => p.id).join('、')}`,
  };
  const reasons = [...run.interrupts, ...run.agentFailures, ...decision.unmet.map((code) => reason(code, STAGE[code] ?? '集約', DETAIL[code]))];
  const stopped = decision.status === '停止' || reasons.length > 0;
  const execStopped = [...run.exec.values()].filter((e) => e.outcome && e.outcome.end.stopped_by !== null).map((e) => ({ id: e.id, kind: e.kind }));
  const execAborted = [...run.exec.values()].filter((e) => (!e.outcome || !e.outcome.end.started) && e.aborted).map((e) => ({ id: e.id, kind: e.kind }));
  const SUMMARY_KINDS = ['syntax', 'reference', 'output_format'];
  const unconfirmed = [...properties.filter((p) => !SUCCESS(p.verdict)).map((p) => p.id), ...confirmations.meaning.filter((c) => c.result === '確認できず').map((c) => c.item),
    ...confirmations.deterministic.filter((c) => SUMMARY_KINDS.includes(c.kind) && c.result !== '成り立つ').map((c) => c.item)];
  const result = {
    schema: RESULT_SCHEMA, status: stopped ? '停止' : '完了', provisional: false,
    verified_scope: verifiedScope, properties, checks, models, decomposition, counterexamples, causes, confirmations,
    unverified, questions: run.resultQuestions.map((q) => structuredClone(q)), records,
    stop_report: stopped ? stopReport({
      reasons, confirmed: properties.filter((p) => SUCCESS(p.verdict)).map((p) => p.id), unconfirmed: uniq(unconfirmed),
      created: records.saved.filter((s) => s.hash !== null).map((s) => ({ kind: s.kind, ref: s.ref })),
      notCreated: run.notCreated.filter((x, i) => run.notCreated.findIndex((y) => y.kind === x.kind && y.reason === x.reason) === i),
      running: execStopped, aborted: execAborted, questions: run.resultQuestions.map((q) => q.id), unsaved: records.unsaved,
    }) : null,
    performance,
  };
  return result;
}
