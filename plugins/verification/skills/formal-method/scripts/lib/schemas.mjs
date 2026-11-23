// 定数（cli-contract.md「定数」）・段（architecture.md「段と処理の順序」）・値の集合と、artifact-formats.md の形の検査器。
import {
  str, str0, bool, num, int, intGe, lit, nullable, re, arr, arr1, tuple, obj, oneOf, any, validate, conforms,
} from './check-shape.mjs';

// ---- 定数 ----
export const CALL_MAX_MS = 240000;
export const CALL_MARGIN_MS = 30000;
export const CLEANUP_BUDGET_MS = 30000;
export const START_WAIT_MS = CALL_MAX_MS - CLEANUP_BUDGET_MS;
export const START_STOP_WAIT_MS = 5000;
export const WAIT_LIMIT_MS = CALL_MAX_MS - CLEANUP_BUDGET_MS;
export const WAIT_POLL_MS = 2000;
export const SALVAGE_RETRY_MS = 10000;
export const SALVAGE_RETRY_MAX = 30;
export const LIVENESS_UNKNOWN_MAX = 30;
export const AGENT_BATCH_DEADLINE_MS = 1800000;
export const TOOL_TIME_LIMIT_MAX_S = 600;
export const REPORT_RESERVE_MS = 60000;
export const REVISE_ROUNDS_MAX = 2;
export const TOOL_OUTPUT_MAX_BYTES = 1048576;
export const MEMORY_SAMPLE_MS = 100;
export const ABLATION_PER_PROPERTY_MAX = 12;
// 役が claim・query・submit の応答を待つ上限（cli-contract.md「依頼と応答」）。担当の Bash の既定の timeout（120000）の半分
export const WORKER_CALL_MAX_MS = 60000;
// 1 体に詰める資料の和集合のバイト数の上限。値と根拠の正本は cli-contract.md「定数」の「UNIT_MAX_BYTES の根拠」
export const UNIT_MAX_BYTES = 120000;

export const STAGES = Object.freeze(['受付', '洗い出し', 'モデル化', '計画', '実行', '確認', '集約']);

// ---- 値の集合 ----
export const VERDICTS = Object.freeze(['検証済み', '別手段で確認済み', '反例', '未実行', 'unknown', '時間切れ', '実行失敗', '未確認']);
export const CHECK_VERDICTS = Object.freeze(['成功', '反例', '未実行', 'unknown', '時間切れ', '実行失敗']);
// 成功 以外の値が 2 つ以上成り立つときに先に選ぶ順（artifact-formats.md「classifyCheck」）
export const CHECK_VERDICT_PRIORITY = Object.freeze(['反例', '時間切れ', '実行失敗', '未実行', 'unknown']);
export const INTERRUPT_CODES = Object.freeze(['依頼の不備', '起動の失敗', '時間の上限', '保存の失敗', '内部の誤り', '処理の中断']);
// decideStatus の述語の順（artifact-formats.md「decideStatus」）
export const UNMET_ORDER = Object.freeze(['必要な性質が検証の成功でない', '確認が終わっていない', '対応できていない組合せ', '回答を待つ問い',
  '記録の未保存', '必要な性質が 0 件', '検出能力未確認', '反例', '実行できない検査']);
// 対象の変化: 受付の後に対象のファイルが変わった（固定の前提の破れ。集約の段で 1 度だけ照らす）
export const STOP_CODES = Object.freeze([...INTERRUPT_CODES, ...UNMET_ORDER, '担当の失敗', '対象の変化']);
// 誤りの code（cli-contract.md「誤りと終了コード」）
export const ERROR_CODES = Object.freeze(['E_CONTRACT', 'E_INPUT', 'E_BUSY', 'E_STALE', 'E_INTERNAL', 'E_RESULT_UNREADABLE', 'E_CALL']);
// E_CALL の detail.reason（cli-contract.md「依頼と応答」）
export const CALL_REFUSALS = Object.freeze(['call_closed', 'unknown_worker', 'outside_task', 'deadline_passed', 'no_response']);
export const REQUEST_CODES = Object.freeze(['target_missing', 'goal_missing', 'shape_invalid', 'duplicate_id', 'exclude_without_reason',
  'pointer_unresolved', 'time_limit_invalid', 'target_unavailable', 'revision_mismatch']);
export const RECORD_KINDS = Object.freeze(['request', 'target_snapshot', 'document_rules', 'inventory', 'model', 'mapping', 'partitions', 'material_view',
  'plan', 'mutations', 'query', 'execution_evidence', 'worklog', 'review_record', 'judgments', 'ledger', 'result', 'report', 'salvage_worklog', 'salvage_ledger']);
export const EXEC_KINDS = Object.freeze(['property', 'composition', 'contract', 'sanity', 'mutation', 'replay', 'ablation']);
// 確認役の観点（context.perspective）。性質ごとの保証の観点は無い（静的な確認と、忠実さの確認の節の役と保証の照合が担う。architecture.md「静的な確認」）
export const PERSPECTIVES = Object.freeze(['extraction', 'nonformal', 'fidelity', 'composition']);
// 意味の確認の kind: 観点ごとの確認と、判断を要する項目ごとの確認（judgment。忠実さの確認役が答える）
export const MEANING_KINDS = Object.freeze([...PERSPECTIVES, 'judgment']);
export const CAUSES = Object.freeze(['要求の不足', '形式モデルの欠陥', '分類処理の欠陥', '対象が性質を満たさない', '原因未確認']);
export const RESULT_SCHEMA = 'formal-method.result/2';
export const LEDGER_SCHEMA = 'formal-method.ledger/2';
export const WORKLOG_SCHEMA = 'formal-method.worklog/1';
export const STATUS_ACTIONS = Object.freeze(['run_agents', 'working', 'terminal']);
const RELATIONS = ['形式化', '形式検証でない確認', '範囲外', '対応なし'];
const GOAL_KINDS = ['目標', '完了', '停止', '再開先'];
const CONFIRMATION_RESULTS = ['成り立つ', '成り立たない', '確認できず'];
const CHECK_KINDS = ['property', 'composition', 'contract'];
// 静的な確認（SP-FORMALMETHOD-012 の表。architecture.md「静的な確認」）の kind と、そのうち判断を要する項目になりうるもの
export const STATIC_KINDS = Object.freeze(['goal_trivial', 'premise_only', 'premise_load', 'plan_coverage', 'scope_variables', 'mutation_scope']);
export const JUDGMENT_KINDS = Object.freeze(['goal_trivial', 'premise_only', 'premise_load']);
export const JUDGMENT_CAUSES = Object.freeze(['外部の依存', '効いている前提', '効いている前提の組', '上限を超えた', '道具が判定できない']);
export const CLAUSE_ROLES = Object.freeze(['rule', 'premise', 'goal']);
export const CLAUSE_BASES = Object.freeze(['出所の文', '外部の依存', '作成役の仮定']);
// 証人（モデル）を求める検査の kind（cli-contract.md「Z3 の adapter」の -model、反例と replay の対象）
export const MODEL_CHECK_KINDS = Object.freeze(['property', 'composition']);

// ---- 共通の型 ----
export const ID_RE = /^[A-Za-z0-9._-]+$/;
export const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
export const FILE_PATH_RE = /^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[^\0]+$/;
export const SPAN_RE = /^L(\d+)-L(\d+)$/;
export const Id = re(ID_RE, 'Id');
export const Sha256 = re(SHA256_RE, 'Sha256');
export const Ref = re(/^(?!\/)(?!.*(^|\/)\.\.(\/|$)).+$/, 'run の領域からの相対 path か target:<target_id>/<FilePath>');
// Span の読み方の正本: L<開始>-L<終了>、1 ≤ 開始 ≤ 終了。合わなければ null。
export function parseSpan(span) {
  const m = typeof span === 'string' ? span.match(SPAN_RE) : null;
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  return from >= 1 && from <= to ? { from, to } : null;
}
export const Span = Object.assign((v, p, e) => {
  if (!parseSpan(v)) { e.push(`${p}: Span を期待`); return false; }
  return true;
}, { json: { type: 'string', pattern: SPAN_RE.source } });
export const FilePath = re(FILE_PATH_RE, 'FilePath');
const FilePathOrDir = re(/^(?!\/)[^\0]+$/, 'FilePath');
// spans は範囲を渡した対象の ref だけが持つ（範囲ごとの指紋。artifact-formats.md「担当に渡す資料」）
// hash は読めないファイルなら 'unreadable'（artifact-formats.md「共通の型」の RefHash）
export const RefHash = obj({ ref: Ref, hash: oneOf(Sha256, lit('unreadable')), 'spans?': arr(obj({ span: Span, hash: Sha256 })) });
export const SourceRef = obj({ target_id: Id, file: FilePath, span: Span });
export const Stage = lit(...STAGES);
export const Measure = oneOf(
  obj({ value: num, unit: lit('ms', 'bytes', 'count', 'tokens') }),
  obj({ status: lit('取得できず'), reason: str }),
  obj({ status: lit('該当なし'), reason: str }),
);
export const RecordKind = lit(...RECORD_KINDS);
export const ExecKind = lit(...EXEC_KINDS);
export const Pointer = oneOf(
  obj({ kind: lit('target', 'goal', 'known_requirement'), id: Id }),
  obj({ kind: lit('location'), target_id: Id, file: FilePath, 'span?': Span }),
);
const LocationPointer = obj({ kind: lit('location'), target_id: Id, file: FilePathOrDir, 'span?': Span });
export const Verdict = lit(...VERDICTS);
export const CheckVerdict = lit(...CHECK_VERDICTS);
export const End = obj({
  started: bool,
  tool_result: lit('満たす', '反する', '判定できない', '判定以外のエラー', 'なし'),
  abnormal_exit: bool, unreadable_output: bool,
  stopped_by: lit('時間', 'その他', null), time_limit_hit: lit('依頼元', '道具', null),
});
export const Question = obj({ id: Id, missing_decision: str, affected: arr1(str), options: arr1(str) });

// ---- 結果 ----
const VerifiedScope = obj({
  targets: arr(obj({
    id: Id, location: str, resolved_location: nullable(str), revision: nullable(str), content_hash: Sha256,
    files: arr(obj({ path: FilePath, content_hash: oneOf(Sha256, lit('unreadable')), text: bool })),
  })),
  include: arr(Pointer),
  exclude: arr(obj({ item: oneOf(Pointer, LocationPointer), reason: str, origin: lit('依頼元', 'formal-method') })),
  external_assumptions: arr(obj({ id: Id, text: str, source: nullable(SourceRef) })),
  unread: arr(obj({ target_id: Id, file: FilePathOrDir, span: nullable(Span), reason: str })),
  internal_time_limits: obj({ agent_batch_deadline_ms: int, tool_time_limit_max_s: int, note: lit('内部の上限') }),
  extraction_coverage: obj({ complete: bool, reason: str }),
});
export const Assurance = oneOf(
  obj({ kind: lit('範囲を限った検査'), scope: str, bounds: arr1(obj({ item: str, bound: str })), scope_variables: arr(str), fairness_assumptions: arr(str) }),
  obj({ kind: lit('無界の証明'), proposition: str, open_obligations: arr(str), fairness_assumptions: arr(str) }),
  obj({ kind: lit('形式検証でない確認'), method: str }),
);
const Detection = obj({
  status: lit('検出を確認', '検出せず', '別の方法で確認', '検出能力未確認'),
  mutations: arr(obj({ id: Id, expected_violation: str, detected: bool, confirmation_id: Id })),
  reason: str,
});
export const Candidate = obj({
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
  id: Id, kind: lit(...CHECK_KINDS), model_id: Id, assumptions: arr(str), scope: str, unit: str,
  tool_time_limit: obj({ seconds: intGe(1), source: lit('計画（内部の上限 TOOL_TIME_LIMIT_MAX_S 以下）') }),
  state: lit('実行した', '実行していない'), verdict: CheckVerdict, end: End, reason: str, evidence_refs: arr(Ref),
  completed_scope: nullable(str), incomplete_scope: nullable(str),
});
export const Covers = obj({ targets: arr(Id), states: arr(str), events: arr(str), assumptions: arr(obj({ id: Id, text: str })), constraints: arr(str), excluded: arr(obj({ item: str, reason: str })) });
const Combinations = oneOf(
  obj({ applicable: lit(false), reason: str }),
  obj({ applicable: lit(true), cells: arr(obj({ state: str, event: str, class: lit('許される', '禁止された', '対応できていない'), grounds: str, transition_ids: arr(Id) })) }),
);
const Paths = oneOf(
  obj({ applicable: lit(false), reason: str }),
  obj({ applicable: lit(true), targets: arr(obj({ state: str, kind: lit(...GOAL_KINDS), property_id: Id })),
    verified: arr(obj({ path: str, property_id: Id })), excluded: arr(obj({ path: str, reason: str })), unverified: arr(obj({ target: str, reason: str })) }),
);
export const Behavior = oneOf(
  obj({ applicable: lit(false), reason: str }),
  obj({ applicable: lit(true), outcomes: obj({ success: arr(str), failure: arr(str), interruption: arr(str), stop: arr(str) }),
    human_inputs: arr(obj({ event: str, accepted_in: arr(str) })), resumptions: arr(obj({ transition_id: Id, resume_to: str })) }),
);
const Diagram = oneOf(
  obj({ derivable: lit(false), reason: str }),
  obj({ derivable: lit(true), format: lit('mermaid'), text: str, element_map: arr(obj({ diagram_element: str, model_element: str })),
    extra: arr(str), missing: arr(str), omitted_conditions: arr(str) }),
);
const MappingRow = obj({ source: Pointer, property_id: Id, model_element: str, check_ids: arr(Id), relation: lit(...RELATIONS), reason: nullable(str) });
const Model = obj({
  id: Id, ref: Ref, covers: Covers, mapping: arr(MappingRow),
  unmapped: obj({ requirements: arr(Pointer), properties: arr(Id), model_elements: arr(str) }),
  combinations: Combinations, paths: Paths, behavior: Behavior, diagram: Diagram,
});
const Location = obj({ file: Ref, pointer: str });
const AssumptionBasis = oneOf(
  obj({ kind: lit('他の部分の保証'), contract_id: Id }),
  obj({ kind: lit('依頼の要求・制約'), known_requirement_id: Id }),
  obj({ kind: lit('共同不変条件'), check_ids: arr1(Id) }),
  obj({ kind: lit('確認できない前提'), reason: str }),
);
export const Boundary = obj({
  edge_id: str, producer: Id, consumer: Id, shared_symbols: arr1(str), assumption: str, guarantee: str,
  assumption_basis: AssumptionBasis, responsible: arr1(Id),
});
const Part = obj({ id: Id, model_id: Id, owns_variables: arr(str), transitions: arr(str) });
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
  parts: arr(Part), boundaries: arr(Boundary), contracts: arr(Contract),
  composition_conditions: arr(obj({ id: Id, model_id: Id, derived_from: Id, statement: str, check_ids: arr(Id), depends_on: arr(Id) })),
  correspondence: obj({ matched: arr(obj({ element: str, to: arr1(str) })), unmatched: arr(str), excluded: arr(obj({ element: str, reason: str })) }),
});
const Counterexample = obj({
  id: Id, property_id: Id, sources: arr1(Pointer), check_id: Id, input_and_trace: str, violated_condition: str,
  replay: obj({ confirmation_id: Id, steps_ref: Ref }),
});
export const CauseSubject = oneOf(obj({ kind: lit('counterexample'), id: Id }), obj({ kind: lit('combination'), model_id: Id, state: str, event: str }), obj({ kind: lit('question'), id: Id }));
const Cause = obj({ subject: CauseSubject, cause: lit(...CAUSES), grounds: str, classified_by: str });
const DET_KINDS = ['syntax', 'reference', 'result_presence', 'output_format', 'replay', 'sanity', 'mutation', ...STATIC_KINDS];
const Confirmation = (kinds) => obj({
  id: Id, kind: lit(...kinds), property_ids: arr(Id), model_property_id: nullable(Id), plan_id: nullable(Id), item: str,
  result: lit(...CONFIRMATION_RESULTS), checker: str, materials: arr(RefHash), end: nullable(End), reason: str,
});
// 判断を要する項目（SP-FORMALMETHOD-012）。静的な確認が成り立たないと断定できない節の付け方で、意味の確認が読む。
const Judgment = obj({
  id: Id, kind: lit(...JUDGMENT_KINDS), cause: lit(...JUDGMENT_CAUSES), property_ids: arr(Id), model_property_id: Id, plan_id: Id,
  clause_names: arr(str), item: str, materials: arr(RefHash), end: nullable(End), reason: str,
});
const Records = obj({
  ledger_refs: arr1(Ref),
  saved: arr(obj({ kind: RecordKind, ref: Ref, hash: nullable(Sha256) })),
  unsaved: arr(obj({ kind: RecordKind, ref: nullable(Ref), reason: str })),
});
const StopReport = obj({
  stage: Stage,
  reasons: arr1(obj({ code: lit(...STOP_CODES), stage: Stage, request_code: nullable(lit(...REQUEST_CODES)), item: nullable(oneOf(Pointer, LocationPointer)), field: nullable(str), detail: str })),
  confirmed_scope: arr(str), unconfirmed_scope: arr(str),
  artifacts_created: arr(obj({ kind: RecordKind, ref: Ref })), artifacts_not_created: arr(obj({ kind: RecordKind, reason: str })),
  checks_running: arr(obj({ id: Id, kind: ExecKind })), checks_aborted: arr(obj({ id: Id, kind: ExecKind })),
  questions: arr(Id), unsaved: arr(RecordKind),
});
// 起動した担当の数と消費量（SP-FORMALMETHOD-013）。取れなかった値は Measure の 取得できず で示し、0 と区別する
const LaunchedAgent = obj({ role: str, label: str, model: str, effort: str, ok: bool });
const AgentCalls = obj({
  calls: arr(obj({ call_id: Id, stage: Stage, workers: intGe(0), tasks: intGe(0), closed_by: lit('close', 'timed_out', 'deadline'),
    agents: Measure, launched: arr(LaunchedAgent), tokens: Measure })),
  stages: arr(obj({ stage: Stage, calls: intGe(1), agents: Measure, tokens: Measure })),
  total: obj({ calls: intGe(0), agents: Measure, tokens: Measure }),
});
const Performance = obj({
  location: lit('ローカル', 'CI'),
  run: obj({ total_ms: Measure, preparation_ms: Measure, build_ms: Measure, checks_ms: Measure, confirmation_ms: Measure, storage_ms: Measure,
    cpu_time_ms: Measure, peak_rss_bytes: Measure, cost: Measure, human_interventions: Measure, retries: Measure }),
  executions: arr(obj({ id: Id, kind: ExecKind, elapsed_ms: Measure, cpu_time_ms: Measure, peak_rss_bytes: Measure })),
  findings: arr(obj({ id: Id, problem: str, evidence: str, candidates: arr(obj({ change: str, keeps_scope_and_assurance: str })),
    decision: lit('この run では採用しない'), reason: str })),
  agent_calls: AgentCalls,
});
export const Result = obj({
  schema: lit(RESULT_SCHEMA), status: lit('完了', '停止'), provisional: bool, verified_scope: VerifiedScope,
  properties: arr(PropertyResult), checks: arr(Check), models: arr(Model), decomposition: Decomposition,
  counterexamples: arr(Counterexample), causes: arr(Cause),
  confirmations: obj({ deterministic: arr(Confirmation(DET_KINDS)), meaning: arr(Confirmation(MEANING_KINDS)), judgments: arr(Judgment) }),
  unverified: arr(obj({ item: str, reason: str })), questions: arr(Question), records: Records,
  stop_report: nullable(StopReport), performance: Performance,
});

export const Identity = obj({ pid: int, started_at: str, nonce: str });
export const LockFile = obj({ pid: int, started_at: str, nonce: str, role: lit('run-daemon') });
export const Call = obj({ call_id: str, args_path: str, deadline_wall_ms: int, workflow_script: str });
// 公開して再読込で確かめた結果は、本文の代わりに result.json の参照で持つ（cli-contract.md「status.json」）
export const ResultRef = obj({ ref: lit('result.json'), path: str });
export const Status = obj({
  seq: intGe(0), run_dir: nullable(str), action: lit(...STATUS_ACTIONS),
  call: nullable(Call), result: nullable(oneOf(ResultRef, Result)), daemon: nullable(Identity),
});

// ---- 担当の成果物 ----
export const Inventory = obj({
  schema: lit('formal-method.inventory/1'), target_id: Id, content_hash: Sha256,
  scanned: arr1(obj({ file: FilePath, span: nullable(Span), status: lit('read', 'unread'), reason: nullable(str) })),
  elements: arr(obj({ id: Id, kind: lit('requirement', 'goal', 'state', 'input', 'output', 'constraint', 'event', 'result'),
    source: obj({ target_id: Id, file: FilePath, span: Span, quote_hash: Sha256 }), text: str })),
  properties: arr(obj({ id: Id, source_ids: arr1(Id), statement: str, formalizable: bool, nonformal_reason: nullable(str), nonformal_method: nullable(str),
    assumptions: arr(str), scope: str, blocked_by_question: arr(Id) })),
  external_dependencies: arr(obj({ id: Id, text: str, source: nullable(SourceRef) })),
});
const StateMachine = obj({
  states: arr1(str), events: arr1(str), initial: str,
  variables: arr(obj({ id: str, sort: str, domain: str, init: str })),
  transitions: arr(obj({ id: Id, from: str, event: str, to: str, guard: str, updates: arr(obj({ var: str, term: str })), unchanged: arr(str), source_ids: arr(Id) })),
  forbidden: arr(obj({ from: str, event: str, source_ids: arr1(Id) })),
  uncovered: arr(obj({ from: str, event: str, missing_info: str })),
  goals: arr(obj({ state: str, kind: lit(...GOAL_KINDS), property_id: Id })),
});
// 性質の query の節（:named の名前ごとに 1 つ）。rule は出所の規則、premise は前提、goal は性質の否定。
export const Clause = obj({
  name: Id, role: lit(...CLAUSE_ROLES), source_ids: arr(Id), basis: nullable(lit(...CLAUSE_BASES)), external_dependency_id: nullable(Id), note: str,
});
export const ModelFile = obj({
  schema: lit('formal-method.model/2'), model_id: Id, adapter_id: lit('z3'), covers: Covers,
  state_machine: nullable(StateMachine), no_state_machine_reason: nullable(str),
  io_contracts: arr(obj({ id: Id, pre: str, post: str, source_ids: arr(Id) })),
  properties: arr(obj({ id: Id, inventory_property_ids: arr1(Id), query_ref: Ref, expected: lit('unsat', 'sat'), assurance: Assurance, clauses: arr1(Clause),
    sanity: arr(obj({ kind: lit('assumptions_consistent', 'initial_exists', 'nontrivial_witness'), query_ref: Ref })) })),
  behavior: Behavior, source_diagrams: arr(obj({ source: SourceRef, format: lit('mermaid') })),
  omitted_edges: arr(obj({ from: str, event: str, condition: str })),
});
export const MappingFile = obj({
  schema: lit('formal-method.mapping/1'), model_id: Id,
  rows: arr(obj({ source: Pointer, property_id: Id, model_element: str, relation: lit(...RELATIONS), reason: nullable(str) })),
});
export const PartitionsFile = obj({
  schema: lit('formal-method.partitions/1'),
  decisions: arr1(obj({ candidate_id: Id, adopted: bool, reason: str })), adopted: bool, reason: str,
  parts: arr(Part), boundaries: arr(Boundary),
  contracts: arr(obj({ id: Id, model_id: Id, derived_from: Id, part_id: Id, statement: str, query_ref: Ref })),
  composition_conditions: arr(obj({ id: Id, model_id: Id, derived_from: Id, statement: str, query_ref: Ref, depends_on: arr(Id) })),
});
export const PlanFile = obj({
  schema: lit('formal-method.plan/1'),
  selection: arr(obj({ property_id: Id, candidates: arr1(Candidate), chosen: obj({ technique: str, tool: str }), reason: str })),
  checks: arr(obj({ id: Id, kind: lit(...CHECK_KINDS), target_id: Id, model_id: Id, input_refs: arr1(Ref), expected: lit('unsat', 'sat'),
    assumptions: arr(str), scope: str, tool_time_limit_seconds: intGe(1), depends_on: arr(Id) })),
  sanity: arr(obj({ id: Id, model_property_id: Id, input_refs: arr1(Ref), tool_time_limit_seconds: intGe(1) })),
});
export const MutationsFile = obj({
  schema: lit('formal-method.mutations/1'),
  mutations: arr(obj({ id: Id, property_id: Id, mutation_ref: Ref, expected_violation: lit('sat', 'unsat'), detector_check_id: Id })),
  unavailable: arr(obj({ property_id: Id, reason: str, alternative: nullable(str) })),
});

// ---- 担当の返り値・task・Workflow ----
export const AuthorReturn = obj({
  task_id: Id, status: lit('done', 'needs_answer', 'cannot_proceed'),
  outputs: arr(obj({ kind: lit('inventory', 'model', 'mapping', 'partitions', 'plan', 'mutations'), ref: Ref })),
  questions: arr(Question), blocked_by_question: arr(Id), reason: nullable(str), worklog_ref: Ref,
});
export const ReviewReturn = obj({
  task_id: Id, unit_id: Id, perspective: lit(...PERSPECTIVES), result: lit(...CONFIRMATION_RESULTS),
  findings: arr(obj({ ref: str, kind: lit('omission', 'addition', 'meaning_change', 'clause_role', 'assurance_overclaim', 'vacuity', 'mutation_invalid', 'boundary_gap', 'circular_assumption', 'other'), note: str })),
  // 判断を要する項目ごとの答え（忠実さの確認役だけが持つ。他の観点は []）。id は Judgment.id
  judgments: arr(obj({ id: Id, result: lit(...CONFIRMATION_RESULTS), note: str })),
  record_ref: Ref, worklog_ref: Ref,
});
export const CauseReturn = obj({
  task_id: Id, unit_id: Id, cause: lit(...CAUSES), grounds: str, questions: arr(Question), record_ref: Ref, worklog_ref: Ref,
});
// Workflow の返り値（artifact-formats.md「Workflow の返り値」）。close が記録するだけで、受理には使わない
export const WorkflowReturn = obj({
  agents: arr(obj({ role: str, label: str, model: str, effort: str, ok: bool })),
  tokens: (v, p, e) => v === null || (typeof v === 'number' && Number.isFinite(v)) || (e.push(`${p}: 数か null を期待`), false),
});
// 受け箱（close）の中身
export const CloseContent = oneOf(
  obj({ call_id: str, workflow_output_path: str }),
  obj({ call_id: str, timed_out: lit(true) }),
);
export const Worklog = obj({
  schema: lit(WORKLOG_SCHEMA), role: str, task_id: nullable(Id), stage: Stage, target: str, inputs: arr(RefHash),
  actions: str, results: str, grounds: str, failures: arr(str), unconfirmed: arr(str),
  unreadable_inputs: arr(obj({ ref: Ref, reason: str })), document_rules: obj({ ref: Ref, version: Sha256 }),
});
const LedgerEntry = obj({ kind: RecordKind, ref: Ref, hash: Sha256, stage: Stage, producer: str, model: nullable(str), effort: nullable(str), permissions: arr(str), input_refs: arr(RefHash) });
// run-daemon の台帳（ledger.json）は run の唯一の台帳で、salvage が保存済みの範囲を知るための段の確定・場所・文書規約も持つ。
// salvage の追補台帳（salvage-ledger.json）は entries と結果の指紋だけ（artifact-formats.md「記録台帳」）
export const Ledger = oneOf(
  obj({
    schema: lit(LEDGER_SCHEMA), run_id: Id, kind: lit('main'), stage_confirmed: Stage, location: lit('ローカル', 'CI'),
    document_rules: nullable(obj({ ref: Ref, version: Sha256 })),
    revisions: arr(obj({ task_id: Id, submit: intGe(1), stage: Stage, defects: arr1(obj({ key: str, text: str })) })),
    entries: arr(LedgerEntry), registered_result_hash: nullable(Sha256),
  }),
  obj({ schema: lit(LEDGER_SCHEMA), run_id: Id, kind: lit('salvage'), entries: arr(LedgerEntry), registered_result_hash: nullable(Sha256) }),
);

export { validate, conforms, any };
