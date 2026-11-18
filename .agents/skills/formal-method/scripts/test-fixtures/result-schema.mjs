// artifact-formats.md の Result とその部品の形を、文書の記法どおりに書き写した検査（実装の schemas.mjs は使わない）。
// 記法: object は閉じている、キーは全て必須（key? は任意）、string は空でない、[T] は空を許し [T]+ は許さない。
const fail = (errs, path, msg) => { errs.push(`${path || '/'}: ${msg}`); };

export const T = {
  str: (v, p, e) => (typeof v === 'string' && v.length > 0) || fail(e, p, `空でない string を期待: ${JSON.stringify(v)}`),
  str0: (v, p, e) => typeof v === 'string' || fail(e, p, 'string を期待'),
  bool: (v, p, e) => typeof v === 'boolean' || fail(e, p, 'boolean を期待'),
  num: (v, p, e) => (typeof v === 'number' && Number.isFinite(v)) || fail(e, p, 'number を期待'),
  int: (v, p, e) => Number.isSafeInteger(v) || fail(e, p, '整数を期待'),
  intGe: (n) => (v, p, e) => (Number.isSafeInteger(v) && v >= n) || fail(e, p, `${n} 以上の整数を期待: ${v}`),
  lit: (...vals) => (v, p, e) => vals.includes(v) || fail(e, p, `${JSON.stringify(vals)} のどれかを期待: ${JSON.stringify(v)}`),
  nullable: (t) => (v, p, e) => v === null || t(v, p, e),
  arr: (t, min = 0) => (v, p, e) => {
    if (!Array.isArray(v)) return fail(e, p, '配列を期待');
    if (v.length < min) fail(e, p, `${min} 個以上を期待`);
    v.forEach((x, i) => t(x, `${p}/${i}`, e));
    return true;
  },
  tuple: (...ts) => (v, p, e) => {
    if (!Array.isArray(v) || v.length !== ts.length) return fail(e, p, `長さ ${ts.length} の配列を期待`);
    ts.forEach((t, i) => t(v[i], `${p}/${i}`, e));
    return true;
  },
  obj: (shape) => (v, p, e) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return fail(e, p, 'object を期待');
    const keys = Object.keys(shape);
    for (const k of keys) {
      const opt = k.endsWith('?');
      const name = opt ? k.slice(0, -1) : k;
      if (!(name in v)) { if (!opt) fail(e, `${p}/${name}`, '必須のキーが無い'); continue; }
      shape[k](v[name], `${p}/${name}`, e);
    }
    const allowed = new Set(keys.map((k) => k.replace(/\?$/, '')));
    for (const k of Object.keys(v)) if (!allowed.has(k)) fail(e, `${p}/${k}`, '書いていないキー（閉じた object）');
    return true;
  },
  oneOf: (...ts) => (v, p, e) => {
    const tries = ts.map((t) => { const sub = []; t(v, p, sub); return sub; });
    if (tries.some((s) => s.length === 0)) return true;
    const best = tries.reduce((a, b) => (a.length <= b.length ? a : b));
    return fail(e, p, `どの形にも合わない（最も近い形の違い: ${best.slice(0, 3).join('; ')}）`);
  },
  re: (rx, what) => (v, p, e) => (typeof v === 'string' && rx.test(v)) || fail(e, p, `${what} を期待: ${JSON.stringify(v)}`),
};

const { str, str0, bool, num, int, intGe, lit, nullable, arr, tuple, obj, oneOf, re } = T;
const arr1 = (t) => arr(t, 1);

export const Id = re(/^[A-Za-z0-9._-]+$/, 'Id');
export const Sha256 = re(/^sha256:[0-9a-f]{64}$/, 'Sha256');
export const Ref = re(/^(?!\/)(?!.*(^|\/)\.\.(\/|$)).+$/, 'run の領域からの相対 path');
export const Span = (v, p, e) => {
  const m = typeof v === 'string' && v.match(/^L(\d+)-L(\d+)$/);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) return fail(e, p, `Span を期待: ${JSON.stringify(v)}`);
  return true;
};
export const FilePath = re(/^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[^\0]+$/, 'FilePath');
export const RefHash = obj({ ref: Ref, hash: Sha256 });
export const SourceRef = obj({ target_id: Id, file: FilePath, span: Span });
export const Stage = lit('受付', '洗い出し', 'モデル化', '計画', '実行', '確認', '集約');
export const Measure = oneOf(
  obj({ value: num, unit: lit('ms', 'bytes', 'count') }),
  obj({ status: lit('取得できず'), reason: str }),
  obj({ status: lit('該当なし'), reason: str }),
);
export const RecordKind = lit('request', 'target_snapshot', 'document_rules', 'inventory', 'model', 'mapping', 'partitions',
  'plan', 'mutations', 'query', 'execution_evidence', 'worklog', 'review_record', 'ledger',
  'result', 'report', 'salvage_worklog', 'salvage_ledger');
export const ExecKind = lit('property', 'composition', 'contract', 'sanity', 'mutation', 'replay');
export const Pointer = oneOf(
  obj({ kind: lit('target', 'goal', 'known_requirement'), id: Id }),
  obj({ kind: lit('location'), target_id: Id, file: FilePath, 'span?': Span }),
);

export const VERDICT = ['検証済み', '別手段で確認済み', '反例', '未実行', 'unknown', '時間切れ', '実行失敗', '未確認'];
export const Verdict = lit(...VERDICT);
export const CheckVerdict = lit('成功', '反例', '未実行', 'unknown', '時間切れ', '実行失敗');
export const End = obj({
  started: bool,
  tool_result: lit('満たす', '反する', '判定できない', '判定以外のエラー', 'なし'),
  abnormal_exit: bool, unreadable_output: bool,
  stopped_by: lit('時間', 'その他', null), time_limit_hit: lit('依頼元', '道具', null),
});

const VerifiedScope = obj({
  targets: arr(obj({
    id: Id, location: str, resolved_location: nullable(str), revision: nullable(str), content_hash: Sha256,
    files: arr(obj({ path: FilePath, content_hash: oneOf(Sha256, lit('unreadable')), text: bool })),
  })),
  include: arr(Pointer),
  exclude: arr(obj({ item: Pointer, reason: str, origin: lit('依頼元', 'formal-method') })),
  external_assumptions: arr(obj({ id: Id, text: str, source: nullable(SourceRef) })),
  unread: arr(obj({ target_id: Id, file: re(/^(?!\/).+$/, 'FilePath（ディレクトリは末尾 /）'), span: nullable(Span), reason: str })),
  internal_time_limits: obj({ agent_batch_deadline_ms: int, tool_time_limit_max_s: int, note: lit('内部の上限') }),
  extraction_coverage: obj({ complete: bool, reason: str }),
});

const Assurance = oneOf(
  obj({ kind: lit('範囲を限った検査'), scope: str, bounds: arr1(obj({ item: str, bound: str })), fairness_assumptions: arr(str) }),
  obj({ kind: lit('無界の証明'), proposition: str, open_obligations: arr(str), fairness_assumptions: arr(str) }),
  obj({ kind: lit('形式検証でない確認'), method: str }),
);
const Detection = obj({
  status: lit('検出を確認', '検出せず', '別の方法で確認', '検出能力未確認'),
  mutations: arr(obj({ id: Id, expected_violation: str, detected: bool, confirmation_id: Id })),
  reason: str,
});
const Candidate = obj({
  role: lit('実行基盤', '検証器'), name: str, handles: str, assurance: str, environment: str, checkable_scope: str,
  estimates: obj({ setup: Measure, execution: Measure, resources: Measure }), available: bool, reason: str,
  comparison_basis: obj({ property_ids: arr(Id), assumptions: arr(str), scope: str, assurance: str, judgment_rules: str }),
  performance_claim: nullable(obj({ better_than: str, metric: lit('setup', 'execution', 'resources') })),
});
const ComparisonCondition = obj({
  compared: tuple(str, str),
  matches: obj({ property: bool, assumptions: bool, scope: bool, assurance: bool, judgment_rules: bool }),
  result: lit('一致を確認', '一致を確認できず'), reason: str,
});
const Method = obj({ chosen: obj({ technique: str, tool: str }), candidates: arr1(Candidate), reason: str, comparison_conditions: arr(ComparisonCondition) });
const PropertyResult = obj({
  id: Id, statement: str,
  sources: arr1(obj({ kind: lit('goal', 'known_requirement', 'location'), id: nullable(Id), source: nullable(SourceRef) })),
  formalizable: bool, nonformal_reason: nullable(str), verdict: arr1(Verdict), assurance: nullable(Assurance), detection: Detection,
  method: nullable(Method), check_ids: arr(Id), confirmation_ids: arr(Id), evidence_refs: arr(Ref), reason: str, depends_on_questions: arr(Id),
});
const Check = obj({
  id: Id, kind: lit('property', 'composition', 'contract'), model_id: Id, assumptions: arr(str), scope: str, unit: str,
  tool_time_limit: obj({ seconds: intGe(1), source: lit('計画（内部の上限 TOOL_TIME_LIMIT_MAX_S 以下）') }),
  state: lit('実行した', '実行していない'), verdict: CheckVerdict, end: End, reason: str, evidence_refs: arr(Ref),
  completed_scope: nullable(str), incomplete_scope: nullable(str),
});
const Combinations = oneOf(
  obj({ applicable: lit(false), reason: str }),
  obj({ applicable: lit(true), cells: arr(obj({ state: str, event: str, class: lit('許される', '禁止された', '対応できていない'), grounds: str, transition_ids: arr(Id) })) }),
);
const Paths = oneOf(
  obj({ applicable: lit(false), reason: str }),
  obj({ applicable: lit(true), targets: arr(obj({ state: str, kind: lit('目標', '完了', '停止', '再開先'), property_id: Id })),
    verified: arr(obj({ path: str, property_id: Id })), excluded: arr(obj({ path: str, reason: str })), unverified: arr(obj({ target: str, reason: str })) }),
);
const Behavior = oneOf(
  obj({ applicable: lit(false), reason: str }),
  obj({ applicable: lit(true), outcomes: obj({ success: arr(str), failure: arr(str), interruption: arr(str), stop: arr(str) }),
    human_inputs: arr(obj({ event: str, accepted_in: arr(str) })), resumptions: arr(obj({ transition_id: Id, resume_to: str })) }),
);
const Diagram = oneOf(
  obj({ derivable: lit(false), reason: str }),
  obj({ derivable: lit(true), format: lit('mermaid'), text: str, element_map: arr(obj({ diagram_element: str, model_element: str })),
    extra: arr(str), missing: arr(str), omitted_conditions: arr(str) }),
);
export const Covers = obj({ targets: arr(Id), states: arr(str), events: arr(str), assumptions: arr(obj({ id: Id, text: str })), constraints: arr(str), excluded: arr(obj({ item: str, reason: str })) });
const Model = obj({
  id: Id, ref: Ref, covers: Covers,
  mapping: arr(obj({ source: Pointer, property_id: Id, model_element: str, check_ids: arr(Id), relation: lit('形式化', '形式検証でない確認', '範囲外', '対応なし'), reason: nullable(str) })),
  unmapped: obj({ requirements: arr(Pointer), properties: arr(Id), model_elements: arr(str) }),
  combinations: Combinations, paths: Paths, behavior: Behavior, diagram: Diagram,
});
const Location = obj({ file: Ref, pointer: str });
const Boundary = obj({
  edge_id: str, producer: Id, consumer: Id, shared_symbols: arr1(str), assumption: str, guarantee: str,
  assumption_basis: oneOf(
    obj({ kind: lit('他の部分の保証'), contract_id: Id }),
    obj({ kind: lit('依頼の要求・制約'), known_requirement_id: Id }),
    obj({ kind: lit('共同不変条件'), check_ids: arr1(Id) }),
    obj({ kind: lit('確認できない前提'), reason: str }),
  ),
  responsible: arr1(Id),
});
const Contract = obj({ id: Id, model_id: Id, derived_from: Id, part_id: Id, statement: str, verdict: arr1(Verdict), check_ids: arr(Id), reason: str });
const Decomposition = obj({
  graph: obj({
    nodes: arr(obj({ id: str, kind: lit('variable', 'transition', 'property', 'smt_declaration', 'smt_definition', 'smt_assertion'), location: Location })),
    edges: arr(obj({ id: str, from: str, to: str, kind: lit('write', 'read', 'reference', 'property'), location: Location })),
    unconfirmed: arr(obj({ relation: str, reason: str })),
  }),
  criteria: obj({ algorithm: lit('writer-merge-scc/1') }),
  candidates: arr(obj({ id: Id, nodes: arr1(str), strength_to: arr(obj({ candidate_id: Id, edges: intGe(1) })) })),
  decisions: arr(obj({ candidate_id: Id, adopted: bool, reason: str })),
  adopted: bool, reason: str,
  parts: arr(obj({ id: Id, model_id: Id, owns_variables: arr(str), transitions: arr(str) })),
  boundaries: arr(Boundary), contracts: arr(Contract),
  // check_ids は空を許す（artifact-formats「plan と mutations」の検査の欠け）。derived_from は親の性質（モデルの性質の id）
  composition_conditions: arr(obj({ id: Id, model_id: Id, derived_from: Id, statement: str, check_ids: arr(Id), depends_on: arr(Id) })),
  correspondence: obj({ matched: arr(obj({ element: str, to: arr1(str) })), unmatched: arr(str), excluded: arr(obj({ element: str, reason: str })) }),
});
export const Question = obj({ id: Id, missing_decision: str, affected: arr1(str), options: arr1(str) });
const Counterexample = obj({
  id: Id, property_id: Id, sources: arr1(Pointer), check_id: Id, input_and_trace: str, violated_condition: str,
  replay: obj({ confirmation_id: Id, steps_ref: Ref }),
});
const Cause = obj({
  subject: oneOf(obj({ kind: lit('counterexample'), id: Id }), obj({ kind: lit('combination'), model_id: Id, state: str, event: str }), obj({ kind: lit('question'), id: Id })),
  cause: lit('要求の不足', '形式モデルの欠陥', '分類処理の欠陥', '対象が性質を満たさない', '原因未確認'), grounds: str, classified_by: str,
});
const DET_KINDS = ['syntax', 'reference', 'result_presence', 'output_format', 'replay', 'sanity', 'mutation'];
const MEAN_KINDS = ['extraction', 'nonformal', 'fidelity', 'assurance', 'composition'];
const Confirmation = (kinds) => obj({
  id: Id, kind: lit(...kinds), property_ids: arr(Id), model_property_id: nullable(Id), plan_id: nullable(Id), item: str, result: lit('成り立つ', '成り立たない', '確認できず'),
  checker: str, materials: arr(RefHash), end: nullable(End), reason: str,
});
const Records = obj({
  ledger_refs: arr1(Ref),
  saved: arr(obj({ kind: RecordKind, ref: Ref, hash: nullable(Sha256) })),
  unsaved: arr(obj({ kind: RecordKind, ref: nullable(Ref), reason: str })),
});
export const StopCode = lit('依頼の不備', '起動の失敗', '処理の中断', '時間の上限', '保存の失敗', '内部の誤り',
  '必要な性質が検証の成功でない', '確認が終わっていない', '対応できていない組合せ', '回答を待つ問い', '記録の未保存',
  '必要な性質が 0 件', '検出能力未確認', '反例', '実行できない検査', '担当の失敗');
export const RequestCode = lit('target_missing', 'goal_missing', 'shape_invalid', 'duplicate_id', 'exclude_without_reason',
  'pointer_unresolved', 'time_limit_invalid', 'target_unavailable', 'revision_mismatch');
const StopReport = obj({
  stage: Stage,
  reasons: arr1(obj({ code: StopCode, stage: Stage, request_code: nullable(RequestCode), item: nullable(Pointer), field: nullable(str), detail: str })),
  confirmed_scope: arr(str), unconfirmed_scope: arr(str),
  artifacts_created: arr(obj({ kind: RecordKind, ref: Ref })), artifacts_not_created: arr(obj({ kind: RecordKind, reason: str })),
  checks_running: arr(obj({ id: Id, kind: ExecKind })), checks_aborted: arr(obj({ id: Id, kind: ExecKind })),
  questions: arr(Id), unsaved: arr(RecordKind),
});
const Performance = obj({
  location: lit('ローカル', 'CI'),
  run: obj({ total_ms: Measure, preparation_ms: Measure, build_ms: Measure, checks_ms: Measure, confirmation_ms: Measure, storage_ms: Measure,
    cpu_time_ms: Measure, peak_rss_bytes: Measure, cost: Measure, human_interventions: Measure, retries: Measure }),
  executions: arr(obj({ id: Id, kind: ExecKind, elapsed_ms: Measure, cpu_time_ms: Measure, peak_rss_bytes: Measure })),
  findings: arr(obj({ id: Id, problem: str, evidence: str, candidates: arr(obj({ change: str, keeps_scope_and_assurance: str })),
    decision: lit('この run では採用しない'), reason: str })),
});

export const RESULT_KEYS = ['schema', 'status', 'provisional', 'verified_scope', 'properties', 'checks', 'models', 'decomposition', 'counterexamples',
  'causes', 'confirmations', 'unverified', 'questions', 'records', 'stop_report', 'performance'];

export const Result = obj({
  schema: lit('formal-method.result/1'), status: lit('完了', '停止'), provisional: bool, verified_scope: VerifiedScope,
  properties: arr(PropertyResult), checks: arr(Check), models: arr(Model), decomposition: Decomposition,
  counterexamples: arr(Counterexample), causes: arr(Cause),
  confirmations: obj({ deterministic: arr(Confirmation(DET_KINDS)), meaning: arr(Confirmation(MEAN_KINDS)) }),
  unverified: arr(obj({ item: str, reason: str })), questions: arr(Question), records: Records,
  stop_report: nullable(StopReport), performance: Performance,
});

export const Identity = obj({ pid: int, started_at: str, nonce: str });
export const Status = obj({
  seq: intGe(0), run_dir: nullable(str), action: lit('run_agents', 'working', 'terminal'),
  batch: nullable(obj({ batch_id: str, tasks_path: str, deadline_wall_ms: int, workflow_script: str })),
  result: nullable(Result), daemon: nullable(Identity),
});

export function validate(type, value) {
  const errs = [];
  type(value, '', errs);
  return errs;
}

// 形に加えて、文書が文で書いた不変（AC-21・SP-003・011・015）を確かめる。違反の一覧を返す。
export function resultInvariants(r) {
  const errs = validate(Result, r);
  if (errs.length) return errs;
  if (r.status === '停止' && r.stop_report === null) errs.push('停止なのに stop_report が null');
  // 仮の結果: provisional が true であるのは records.unsaved に kind result があるときだけで、そのとき 停止
  const resultUnsaved = r.records.unsaved.some((u) => u.kind === 'result');
  if (r.provisional !== resultUnsaved) errs.push(`provisional ${r.provisional} と records.unsaved の result（${resultUnsaved}）が合わない`);
  if (r.provisional && r.status !== '停止') errs.push('仮の結果の状態が 停止 でない');
  if (r.status === '完了' && r.stop_report !== null) errs.push('完了なのに stop_report を持つ');
  for (const p of r.properties) {
    const v = p.verdict;
    if (new Set(v).size !== v.length) errs.push(`${p.id}: verdict に重複`);
    if ([...v].sort((a, b) => VERDICT.indexOf(a) - VERDICT.indexOf(b)).join() !== v.join()) errs.push(`${p.id}: verdict の順が Verdict の並びでない`);
    if ((v.includes('検証済み') || v.includes('別手段で確認済み')) && v.length !== 1) errs.push(`${p.id}: 成功の値が単独でない`);
    if (p.formalizable === (p.nonformal_reason !== null)) errs.push(`${p.id}: nonformal_reason は形式化できないときだけ非 null`);
    for (const s of p.sources) if ((s.kind === 'location') !== (s.id === null)) errs.push(`${p.id}: sources の location は id が null`);
    for (const id of p.check_ids) if (!r.checks.some((c) => c.id === id)) errs.push(`${p.id}: check_ids の ${id} が checks に無い`);
    // 性質と検査の結び付きに入るのは kind property・composition だけ（部分の契約の検査は入らない）
    for (const c of r.checks) if (p.check_ids.includes(c.id) && !PROPERTY_CHECK_KINDS.includes(c.kind)) errs.push(`${p.id}: check_ids の ${c.id} が kind ${c.kind}（property・composition だけ）`);
  }
  for (const c of r.checks) {
    if (c.state === '実行していない' && (c.verdict !== '未実行' || c.end.started !== false)) errs.push(`${c.id}: 実行していない検査は 未実行 で end.started false`);
  }
  for (const m of r.models) for (const row of m.mapping) {
    if (row.relation === '対応なし' && row.reason === null) errs.push(`${m.id}: 対応なし の行の reason が null`);
    // 形式化 の行は、check_ids が空でないか、空で reason（計画にその性質の検査が無い理由）が非 null
    if (row.relation === '形式化' && row.check_ids.length === 0 && row.reason === null) errs.push(`${m.id}: 形式化 の行の check_ids が空で reason が null`);
  }
  for (const x of r.counterexamples) if (!r.causes.some((c) => c.subject.kind === 'counterexample' && c.subject.id === x.id)) errs.push(`${x.id}: 反例に原因が無い`);
  if (r.stop_report) {
    const unsavedKinds = [...new Set(r.records.unsaved.map((u) => u.kind))].sort();
    if ([...new Set(r.stop_report.unsaved)].sort().join() !== unsavedKinds.join()) errs.push('stop_report.unsaved が records.unsaved の kind と一致しない');
    for (const q of r.stop_report.questions) if (!r.questions.some((x) => x.id === q)) errs.push(`stop_report.questions の ${q} が questions に無い`);
    for (const reason of r.stop_report.reasons) if ((reason.code === '依頼の不備') !== (reason.request_code !== null)) errs.push('request_code は 依頼の不備 のときだけ非 null');
  }
  const vs = r.verified_scope;
  if (vs.extraction_coverage.complete && vs.unread.length > 0) errs.push('unread が空でないのに extraction_coverage.complete が true');
  for (const ex of vs.exclude) {
    if (ex.origin === 'formal-method' && ex.reason !== 'formal-method が除く') errs.push('formal-method の除外の reason');
  }
  for (const u of vs.unread) if (u.reason === 'formal-method が除く') errs.push(`${u.file}: formal-method が除いたものを unread に載せている`);
  for (const p of r.properties) {
    if (!p.method) continue;
    for (const c of p.method.candidates) {
      if (!c.performance_claim) continue;
      const ok = p.method.comparison_conditions.some((cc) => cc.compared.includes(c.name) && cc.compared.includes(c.performance_claim.better_than) && cc.result === '一致を確認');
      if (!ok) errs.push(`${p.id}: 一致を確認していない候補 ${c.name} が performance_claim を持つ`);
    }
    for (const cc of p.method.comparison_conditions) {
      const all = Object.values(cc.matches).every(Boolean);
      if ((cc.result === '一致を確認') !== all) errs.push(`${p.id}: comparison_conditions の result と matches が合わない`);
    }
  }
  const g = r.decomposition.graph;
  for (const e of g.edges) if (e.id !== `${e.kind}:${e.from}->${e.to}`) errs.push(`辺の id ${e.id} が <kind>:<from>-><to> でない`);
  if (new Set(g.edges.map((e) => e.id)).size !== g.edges.length) errs.push('辺の id が重なる');
  for (const b of r.decomposition.boundaries) if (!g.edges.some((e) => e.id === b.edge_id)) errs.push(`境界の edge_id ${b.edge_id} が graph.edges に無い`);
  errs.push(...idInvariants(r));
  // 欠陥が残った計画の要素は実行せず、checks[]・confirmations（plan_id）・それを指す欄に載せない
  const defects = planDefectIds(r);
  const confsAll = [...r.confirmations.deterministic, ...r.confirmations.meaning];
  for (const id of defects) {
    if (r.checks.some((c) => c.id === id)) errs.push(`計画の欠陥 ${id} が checks[] にある`);
    if (confsAll.some((c) => c.plan_id === id)) errs.push(`計画の欠陥 ${id} から作った確認が confirmations にある`);
    const refs = [...r.properties.flatMap((p) => p.check_ids), ...r.models.flatMap((m) => m.mapping.flatMap((x) => x.check_ids)),
      ...r.decomposition.contracts.flatMap((k) => k.check_ids), ...r.decomposition.composition_conditions.flatMap((c) => c.check_ids),
      ...(r.stop_report ? [...r.stop_report.checks_running, ...r.stop_report.checks_aborted].map((x) => x.id) : []), ...r.performance.executions.map((x) => x.id)];
    if (refs.includes(id)) errs.push(`計画の欠陥 ${id} を指す欄がある`);
  }
  const savedRefs = r.records.saved.map((s) => s.ref);
  for (const u of r.records.unsaved) if (u.ref && savedRefs.includes(u.ref)) errs.push(`${u.ref} が saved と unsaved の両方にある`);
  return errs;
}

export { arr1, str0, num };

// 欠陥が残った計画の要素（検査・sanity・変異）の id。unverified[] の item がちょうど「計画の欠陥: <計画の id>」の項目から読む（artifact-formats「検査」）
export function planDefectIds(r) {
  return new Set(r.unverified.map((u) => u.item.match(/^計画の欠陥: ([A-Za-z0-9._-]+)$/)?.[1]).filter(Boolean));
}

// 性質と検査の結び付き（PropertyResult.check_ids・Model.mapping[].check_ids）に入る検査の kind
export const PROPERTY_CHECK_KINDS = ['property', 'composition'];

// artifact-formats「id と参照の一覧」の、結果の中で確かめられる「一意の範囲」と「実在を確かめる所（集約の照合）」。
// 結果の中の参照が欠けていれば、集約の照合で 内部の誤り で止めるはずの壊れた結果である。
export function idInvariants(r) {
  const errs = [];
  const uniq = (name, ids) => { const seen = new Set(); for (const id of ids) { if (seen.has(id)) errs.push(`${name} の id ${id} が重なる`); seen.add(id); } };
  const exists = (name, ids, pool) => { for (const id of ids) if (!pool.has(id)) errs.push(`${name} の ${id} が実在しない`); };
  const d = r.decomposition;
  const confs = [...r.confirmations.deterministic, ...r.confirmations.meaning];
  // 一意の範囲
  uniq('性質（inventory の性質）', r.properties.map((p) => p.id));
  // 検査・sanity・変異・確認の id は 1 つの名前空間で、run の中で一意（check_ids などはこの中にちょうど 1 つ実在する）
  uniq('実行と確認', [...r.checks.map((c) => c.id), ...confs.map((c) => c.id)]);
  // 計画作成役の id（検査・変異）は confirm- で始まらない。CLI の作る確認の id は confirm-<kind>-<n>
  for (const id of [...r.checks.map((c) => c.id), ...r.properties.flatMap((p) => p.detection.mutations.map((m) => m.id))]) {
    if (id.startsWith('confirm-')) errs.push(`計画の id ${id} が confirm- で始まる`);
  }
  const mutationPlanIds = new Set(r.properties.flatMap((p) => p.detection.mutations.map((m) => m.id)));
  for (const c of confs) {
    // 確認の id は種類を問わず CLI が confirm-<kind>-<n> で作る
    if (!new RegExp(`^confirm-${c.kind}-\\d+$`).test(c.id)) errs.push(`確認の id ${c.id} が confirm-${c.kind}-<n> の形でない`);
    // plan_id: 計画の sanity・変異から作った確認（kind sanity・mutation）だけ計画の id、他は null
    const fromPlan = c.kind === 'sanity' || c.kind === 'mutation';
    if (fromPlan && c.plan_id === null) errs.push(`確認 ${c.id}（${c.kind}）の plan_id が null`);
    if (!fromPlan && c.plan_id !== null) errs.push(`確認 ${c.id}（${c.kind}）の plan_id は null`);
    if (c.plan_id !== null && c.plan_id.startsWith('confirm-')) errs.push(`確認 ${c.id} の plan_id ${c.plan_id} が計画の id でない`);
    if (c.kind === 'mutation' && c.plan_id !== null && !mutationPlanIds.has(c.plan_id)) errs.push(`確認 ${c.id} の plan_id ${c.plan_id} が Detection.mutations[].id に無い`);
  }
  // Detection.mutations[]: id は計画の変異の id、confirmation_id はその変異から作った mutation の確認
  for (const p of r.properties) for (const m of p.detection.mutations) {
    const c = confs.find((x) => x.id === m.confirmation_id);
    if (c && (c.kind !== 'mutation' || c.plan_id !== m.id)) errs.push(`${p.id} の変異 ${m.id} の confirmation_id ${m.confirmation_id} が、plan_id ${m.id} の mutation の確認でない`);
  }
  uniq('反例', r.counterexamples.map((c) => c.id));
  uniq('問い', r.questions.map((q) => q.id));
  uniq('モデル', r.models.map((m) => m.id));
  uniq('graph の要素', d.graph.nodes.map((n) => n.id));
  uniq('graph の辺', d.graph.edges.map((e) => e.id));
  uniq('候補', d.candidates.map((c) => c.id));
  uniq('部分・契約・合成の条件', [...d.parts.map((x) => x.id), ...d.contracts.map((x) => x.id), ...d.composition_conditions.map((x) => x.id)]);
  uniq('対象', r.verified_scope.targets.map((t) => t.id));
  uniq('性能の findings', r.performance.findings.map((f) => f.id));
  for (const t of r.verified_scope.targets) uniq(`対象 ${t.id} の FilePath`, t.files.map((f) => f.path));
  // 実在（結果の中）
  const props = new Set(r.properties.map((p) => p.id));
  const checks = new Set(r.checks.map((c) => c.id));
  const confIds = new Set(confs.map((c) => c.id));
  const execs = new Set([...checks, ...confIds]);
  const cex = new Set(r.counterexamples.map((c) => c.id));
  const qs = new Set(r.questions.map((q) => q.id));
  const models = new Set(r.models.map((m) => m.id));
  const nodes = new Set(d.graph.nodes.map((n) => n.id));
  const cands = new Set(d.candidates.map((c) => c.id));
  const parts = new Set(d.parts.map((x) => x.id));
  const contracts = new Set(d.contracts.map((x) => x.id));
  // 検査を指す欄は checks[] に、その欄の kind で実在する（artifact-formats「検査」「反例と原因」、id と参照の一覧）
  const checksOfKind = (...kinds) => new Set(r.checks.filter((c) => kinds.includes(c.kind)).map((c) => c.id));
  const propChecks = checksOfKind(...PROPERTY_CHECK_KINDS);
  for (const p of r.properties) {
    exists(`${p.id}.check_ids`, p.check_ids, propChecks);
    exists(`${p.id}.confirmation_ids`, p.confirmation_ids, confIds);
    exists(`${p.id}.detection.mutations[].confirmation_id`, p.detection.mutations.map((m) => m.confirmation_id), confIds);
    exists(`${p.id}.depends_on_questions`, p.depends_on_questions, qs);
  }
  for (const c of confs) exists(`確認 ${c.id}.property_ids`, c.property_ids, props);
  for (const x of r.counterexamples) {
    exists(`反例 ${x.id}.check_id（kind property・composition）`, [x.check_id], propChecks);
    const c = r.checks.find((y) => y.id === x.check_id);
    if (c && c.verdict !== '反例') errs.push(`反例 ${x.id}.check_id の ${c.id} の verdict が ${c.verdict}（反例 の検査だけ）`);
    exists(`反例 ${x.id}.property_id`, [x.property_id], props);
    exists(`反例 ${x.id}.replay.confirmation_id`, [x.replay.confirmation_id], confIds);
  }
  for (const c of r.causes) {
    if (c.subject.kind === 'counterexample') exists('原因の反例', [c.subject.id], cex);
    // 問いは、原因の分類が 要求の不足 のときだけ questions[] に入る（architecture「段と処理の順序」、artifact-formats「担当の返り値」）
    if (c.subject.kind === 'question') {
      if (c.cause === '要求の不足') exists('原因の問い', [c.subject.id], qs);
      else if (qs.has(c.subject.id)) errs.push(`原因の問い ${c.subject.id} は ${c.cause} なので questions[] に入らない`);
    }
    if (c.subject.kind === 'combination') {
      exists('原因の model_id', [c.subject.model_id], models);
      const m = r.models.find((x) => x.id === c.subject.model_id);
      if (m && (!m.covers.states.includes(c.subject.state) || !m.covers.events.includes(c.subject.event))) errs.push(`原因の組合せ ${c.subject.state}/${c.subject.event} が ${m.id} の状態・出来事に無い`);
    }
  }
  exists('Check.model_id', r.checks.map((c) => c.model_id), models);
  for (const m of r.models) {
    for (const row of m.mapping) exists(`${m.id}.mapping[].check_ids（kind property・composition）`, row.check_ids, propChecks);
    if (m.combinations.applicable) for (const cell of m.combinations.cells) {
      if (!m.covers.states.includes(cell.state) || !m.covers.events.includes(cell.event)) errs.push(`${m.id} の組合せ ${cell.state}/${cell.event} が covers に無い`);
    }
  }
  for (const e of d.graph.edges) exists(`辺 ${e.id} の端`, [e.from, e.to], nodes);
  for (const c of d.candidates) { exists(`候補 ${c.id}.nodes`, c.nodes, nodes); exists(`候補 ${c.id}.strength_to`, c.strength_to.map((x) => x.candidate_id), cands); }
  exists('decisions[].candidate_id', d.decisions.map((x) => x.candidate_id), cands);
  for (const p of d.parts) {
    exists(`部分 ${p.id}.model_id`, [p.model_id], models);
    exists(`部分 ${p.id} の要素`, [...p.owns_variables, ...p.transitions], nodes);
    for (const v of p.owns_variables) if (!v.startsWith(`var:${p.model_id}/`)) errs.push(`部分 ${p.id} の ${v} は ${p.model_id} の変数でない`);
    for (const t of p.transitions) if (!t.startsWith(`tr:${p.model_id}/`)) errs.push(`部分 ${p.id} の ${t} は ${p.model_id} の遷移でない`);
  }
  const partModel = new Map(d.parts.map((p) => [p.id, p.model_id]));
  for (const k of d.contracts) {
    exists(`契約 ${k.id}.part_id`, [k.part_id], parts);
    exists(`契約 ${k.id}.check_ids（kind contract）`, k.check_ids, checksOfKind('contract'));
    if (partModel.has(k.part_id) && partModel.get(k.part_id) !== k.model_id) errs.push(`契約 ${k.id} の model_id が部分と違う`);
  }
  for (const c of d.composition_conditions) {
    exists(`合成の条件 ${c.id}.model_id`, [c.model_id], models);
    exists(`合成の条件 ${c.id}.check_ids（kind composition）`, c.check_ids, checksOfKind('composition'));
    for (const dep of c.depends_on) {
      const k = d.contracts.find((x) => x.id === dep);
      if (k && k.model_id !== c.model_id) errs.push(`合成の条件 ${c.id} の契約 ${dep} が別のモデル`);
    }
  }
  for (const b of d.boundaries) {
    exists(`境界 ${b.edge_id} の producer・consumer`, [b.producer, b.consumer], parts);
    exists(`境界 ${b.edge_id}.responsible`, b.responsible, new Set([...contracts, ...execs]));
    if (b.assumption_basis.kind === '他の部分の保証') exists('assumption_basis.contract_id', [b.assumption_basis.contract_id], contracts);
    if (b.assumption_basis.kind === '共同不変条件') exists('assumption_basis.check_ids', b.assumption_basis.check_ids, checks);
  }
  for (const el of [...d.correspondence.matched.map((m) => m.element), ...d.correspondence.unmatched, ...d.correspondence.excluded.map((e) => e.element)]) {
    if (d.graph.nodes.length && !nodes.has(el)) errs.push(`correspondence の要素 ${el} が graph に無い`);
  }
  if (r.stop_report) {
    exists('stop_report.checks_running・checks_aborted', [...r.stop_report.checks_running, ...r.stop_report.checks_aborted].map((x) => x.id), execs);
    exists('stop_report.questions', r.stop_report.questions, qs);
  }
  exists('performance.executions[].id', r.performance.executions.map((x) => x.id), execs);
  // kind contract の検査は、ちょうど 1 つの Contract.check_ids に現れる
  for (const c of r.checks.filter((x) => x.kind === 'contract')) {
    const n = d.contracts.filter((k) => k.check_ids.includes(c.id)).length;
    if (n !== 1) errs.push(`kind contract の検査 ${c.id} が ${n} 個の Contract.check_ids に現れる（ちょうど 1 つ）`);
  }
  // モデルの性質の id（graph の prop:<model_id>/<id> で引ける範囲）
  const modelProps = new Set(d.graph.nodes.filter((n) => n.kind === 'property').map((n) => n.id.replace(/^prop:[^/]+\//, '')));
  if (modelProps.size) {
    exists('Confirmation.model_property_id', confs.map((c) => c.model_property_id).filter((x) => x !== null), modelProps);
    // 契約と合成の条件の derived_from は、同じ model_id のモデルの性質を指す（分割の照合）
    const propNodes = new Set(d.graph.nodes.filter((n) => n.kind === 'property').map((n) => n.id));
    for (const k of d.contracts) if (!propNodes.has(`prop:${k.model_id}/${k.derived_from}`)) errs.push(`Contract.derived_from の ${k.derived_from} が ${k.model_id} のモデルの性質に実在しない`);
    for (const c of d.composition_conditions) if (!propNodes.has(`prop:${c.model_id}/${c.derived_from}`)) errs.push(`composition_conditions[].derived_from の ${c.derived_from} が ${c.model_id} のモデルの性質に実在しない`);
  }
  return errs;
}

// 起点が run の領域の Ref の実在（fs を読む）。readRun(ref) は文字列か null を返す。
// adopted: 採った計画の Ref（{ plan, mutations }。最後の計画作成役の成果物）。渡さなければ、保存された plan・mutations が 1 つずつのときだけ当てる
export function refInvariants(r, readRun, adopted = null) {
  const errs = [];
  const need = (name, ref) => { if (readRun(ref) === null) errs.push(`${name} の Ref ${ref} が run の領域に無い`); };
  for (const m of r.models) need(`Model ${m.id}.ref`, m.ref);
  for (const x of [...r.decomposition.graph.nodes, ...r.decomposition.graph.edges]) need(`${x.id}.location.file`, x.location.file);
  for (const p of r.properties) for (const ref of p.evidence_refs) need(`${p.id}.evidence_refs`, ref);
  for (const c of r.checks) for (const ref of c.evidence_refs) need(`${c.id}.evidence_refs`, ref);
  for (const x of r.counterexamples) need(`反例 ${x.id}.steps_ref`, x.replay.steps_ref);
  for (const c of [...r.confirmations.deterministic, ...r.confirmations.meaning]) for (const m of c.materials) need(`確認 ${c.id}.materials`, m.ref);
  for (const s of r.records.saved) need('records.saved', s.ref);
  // plan_id は計画の中に実在する（保存された plan・mutations の記録で照らす）
  const confs = [...r.confirmations.deterministic, ...r.confirmations.meaning];
  const planIds = { sanity: null, mutation: null };
  for (const s of r.records.saved) {
    const text = readRun(s.ref);
    if (text === null) continue;
    if (s.kind === 'plan') planIds.sanity = new Set([...(planIds.sanity ?? []), ...JSON.parse(text).sanity.map((x) => x.id)]);
    if (s.kind === 'mutations') planIds.mutation = new Set([...(planIds.mutation ?? []), ...JSON.parse(text).mutations.map((x) => x.id)]);
  }
  for (const c of confs) {
    if (c.plan_id === null || !planIds[c.kind]) continue;
    if (!planIds[c.kind].has(c.plan_id)) errs.push(`確認 ${c.id} の plan_id ${c.plan_id} が計画（${c.kind === 'sanity' ? 'PlanFile.sanity' : 'MutationsFile.mutations'}）に無い`);
  }
  // 計画との照合（artifact-formats「検査」「plan と mutations」）。保存された plan・mutations の記録が 1 つずつのときだけ当てる
  // （修正の巡で複数の計画が保存されると、どれを採ったかは結果から決まらない）。
  const onlyRecord = (kind) => {
    const texts = r.records.saved.filter((s) => s.kind === kind).map((s) => readRun(s.ref)).filter((t) => t !== null);
    return texts.length === 1 ? JSON.parse(texts[0]) : null;
  };
  const fromRef = (ref) => { const t = ref ? readRun(ref) : null; return t === null ? null : JSON.parse(t); };
  let plan = adopted ? fromRef(adopted.plan) : onlyRecord('plan');
  const mutationsFile = adopted ? fromRef(adopted.mutations) : onlyRecord('mutations');
  const d = r.decomposition;
  const defects = planDefectIds(r);
  if (plan) {
    // checks は PlanFile.checks の要素のうち、欠陥が残らなかったもの（unverified[] の「計画の欠陥」に無いもの）ごとに 1 つ、同じ id と kind で持つ
    plan = { ...plan, checks: plan.checks.filter((c) => !defects.has(c.id)) };
    const key = (c) => `${c.id}\0${c.kind}`;
    if (plan.checks.map(key).sort().join('\n') !== r.checks.map(key).sort().join('\n')) errs.push('checks が、欠陥の残らなかった PlanFile.checks の要素ごとに 1 つ（同じ id と kind）でない');
    // Contract.check_ids は、kind contract で target_id がその契約の id の検査を、計画の順に持つ
    for (const k of d.contracts) {
      const want = plan.checks.filter((c) => c.kind === 'contract' && c.target_id === k.id).map((c) => c.id);
      if (k.check_ids.join('\n') !== want.join('\n')) errs.push(`契約 ${k.id}.check_ids が計画の順の kind contract の検査（${want.join(',')}）でない`);
    }
    // PropertyResult.check_ids は、その性質を inventory_property_ids に含むモデルの性質の kind property の検査と、
    // そのモデルの性質を derived_from に持つ合成の条件の kind composition の検査（集合として比べる）
    const modelProps = r.models.flatMap((m) => { const t = readRun(m.ref); return t === null ? [] : (JSON.parse(t).properties ?? []); });
    for (const p of r.properties) {
      const mps = modelProps.filter((mp) => (mp.inventory_property_ids ?? []).includes(p.id)).map((mp) => mp.id);
      const conds = d.composition_conditions.filter((c) => mps.includes(c.derived_from)).map((c) => c.id);
      const want = plan.checks.filter((c) => (c.kind === 'property' && mps.includes(c.target_id)) || (c.kind === 'composition' && conds.includes(c.target_id))).map((c) => c.id).sort();
      if ([...p.check_ids].sort().join('\n') !== want.join('\n')) errs.push(`${p.id}.check_ids が、モデルの性質の検査と合成の条件の検査の集合（${want.join(',')}）でない`);
    }
  }
  // MutationsFile.mutations[].detector_check_id は kind property の検査で、その target_id は同じ要素の property_id
  if (plan && mutationsFile) {
    for (const m of mutationsFile.mutations.filter((x) => !defects.has(x.id))) {
      const c = plan.checks.find((x) => x.id === m.detector_check_id);
      if (!c || c.kind !== 'property' || c.target_id !== m.property_id) errs.push(`変異 ${m.id} の detector_check_id ${m.detector_check_id} が、target_id ${m.property_id} の kind property の検査でない`);
    }
  }
  // モデルの中の名前は、そのモデルのファイルと組で確かめる
  for (const m of r.models) {
    const text = readRun(m.ref);
    if (text === null) continue;
    const mf = JSON.parse(text);
    if (mf.model_id !== m.id) errs.push(`Model ${m.id} の ref のファイルの model_id が ${mf.model_id}`);
    const trs = new Set((mf.state_machine?.transitions ?? []).map((t) => t.id));
    const mps = new Set(mf.properties.map((p) => p.id));
    if (m.combinations.applicable) for (const cell of m.combinations.cells) for (const id of cell.transition_ids) if (!trs.has(id)) errs.push(`${m.id} の組合せの transition_ids ${id} がモデルに無い`);
    if (m.paths.applicable) for (const x of [...m.paths.targets, ...m.paths.verified]) if (!mps.has(x.property_id)) errs.push(`${m.id} の paths の property_id ${x.property_id} がモデルの性質に無い`);
    if (m.behavior.applicable) for (const x of m.behavior.resumptions) if (!trs.has(x.transition_id)) errs.push(`${m.id} の resumptions ${x.transition_id} がモデルに無い`);
  }
  return errs;
}
