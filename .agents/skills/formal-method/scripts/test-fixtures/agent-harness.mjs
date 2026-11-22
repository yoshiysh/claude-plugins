// 担当の代わりの harness。Workflow の代わりに、call.args_path の workers の行ごとに役として振る舞う:
// 入口（<run_dir>/formal-method-cli.mjs）で claim → query_cmd → attempt の領域に成果物と返り値を書く → submit_cmd → 落ちたら直して同じ submit → done まで。
// 書く形は artifact-formats.md の「担当の成果物」「担当の返り値」「claim の Task」「作業記録」だけ。task から読むのは Task と TaskContext の欄と、
// query が返した資料（input_refs）だけ。最後に司令塔の代わりに close を呼ぶ（Workflow の返り値は {agents, tokens}）。
// 受け取った task が契約の形（claim の Task の欄、役ごとの context）に合わなければ、その違反で失敗する。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, chmodSync, linkSync, unlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { cli, expectOk, runShell } from './cli-runner.mjs';
import { close as closeInProcess, workerCall } from '../lib/client.mjs';
import { deriveGraph, crossingEdges } from './decomposition-check.mjs';

const sha = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// Ref は全て run の領域からの相対 path（artifact-formats「共通の型」）。
export const runRef = (task, name) => relative(task.context.run_dir, join(task.attempt_dir, name));

// 行: 末尾の \n の後の空の要素は数えない。空のファイルは 0 行（artifact-formats「共通の型」）。
export function linesOf(text) {
  if (text === '') return [];
  const ls = text.split('\n');
  if (ls[ls.length - 1] === '') ls.pop();
  return ls;
}

// ---- 受け取った task の契約の検査（claim の Task の欄と、役と context の表） ----
const TASK_KEYS = ['attempt_dir', 'context', 'effort', 'instructions', 'model', 'query_cmd', 'result_path', 'return_schema', 'role', 'submit_cmd', 'task_id'];
const ROLE_PERSPECTIVE = {
  extractor: [null], 'model-author': [null], 'plan-author': [null], 'partition-author': [null], 'cause-analyst': [null],
  'extraction-reviewer': ['extraction'], 'assurance-reviewer': ['nonformal'], 'fidelity-reviewer': ['fidelity'], 'composition-reviewer': ['composition'],
};
export function taskViolations(task, runDir, memory = null, worker = null) {
  const v = [];
  const c = task.context;
  if (!c) return [`${task.task_id}: context が無い`];
  if (c.run_dir !== runDir) v.push(`${task.task_id}: context.run_dir が run の領域と違う`);
  const keys = Object.keys(task).sort();
  if (keys.join() !== TASK_KEYS.join()) v.push(`${task.task_id}: claim の Task の欄 ${keys.join()}`);
  const CONTEXT_KEYS = ['candidates', 'model_id', 'perspective', 'property_ids', 'run_dir', 'stage', 'subject', 'target_id', 'unit_id'];
  if (Object.keys(c).sort().join() !== CONTEXT_KEYS.join()) v.push(`${task.task_id}: context の欄 ${Object.keys(c).sort().join()}（資料は query で引く）`);
  const ins = task.instructions ?? [];
  if (ins.length !== 2 || !ins[0].endsWith(`/agents/${task.role}.md`) || !ins[1].endsWith('/references/agent-obligations.md') || !ins.every((x) => existsSync(x))) v.push(`${task.task_id}: instructions ${JSON.stringify(ins)}`);
  if (task.attempt_dir !== join(runDir, 'attempts', task.task_id) || task.result_path !== join(task.attempt_dir, 'return.json')) v.push(`${task.task_id}: attempt_dir・result_path`);
  if (!existsSync(task.attempt_dir)) v.push(`${task.task_id}: attempt の領域が無い`);
  if (!task.return_schema || task.return_schema.type !== 'object') v.push(`${task.task_id}: return_schema`);
  if (!String(task.submit_cmd).includes(' submit') || !String(task.query_cmd).includes(' query')) v.push(`${task.task_id}: submit_cmd・query_cmd`);
  // workers の行の role は、その worker が持つ担当の役を出てくる順に + でつないだもの（分割と計画を 1 体が担うとき 2 つ）
  if (worker && (!worker.role.split('+').includes(task.role) || worker.model !== task.model || worker.effort !== task.effort)) v.push(`${task.task_id}: workers の行と role・model・effort が違う`);
  if (!(ROLE_PERSPECTIVE[task.role] ?? []).includes(c.perspective)) v.push(`${task.task_id}: ${task.role} の perspective ${c.perspective}`);
  const expectUnit = {
    extraction: () => `extraction-${c.target_id}`, nonformal: () => `nonformal-${c.property_ids[0]}`,
    fidelity: () => `fidelity-${c.model_id}`, composition: () => 'composition',
  };
  if (c.perspective) { if (c.unit_id !== expectUnit[c.perspective]()) v.push(`${task.task_id}: unit_id ${c.unit_id}`); }
  else if (task.role === 'cause-analyst') {
    const s = c.subject;
    // 組合せは cause-combination-<model_id>-<n>（n はその組の Combinations.cells の中の 0 から数えた位置。artifact-formats「役と context」）。
    // cells は状態×出来事の宣言順（状態ごとに出来事の順）なので、harness が書いたモデルの state_machine から位置を導く
    let u = null;
    if (s?.kind === 'combination') {
      const sm = (memory?.models ?? []).filter((m) => m.id === s.model_id).map((m) => readJson(join(m.task.attempt_dir, m.file)).state_machine).at(-1);
      const n = sm ? sm.states.indexOf(s.state) * sm.events.length + sm.events.indexOf(s.event) : -1;
      u = sm && sm.states.includes(s.state) && sm.events.includes(s.event) ? `cause-combination-${s.model_id}-${n}` : '<組合せがモデルに無い>';
    } else if (s) u = `cause-${s.kind}-${s.id}`;
    if (!s || c.unit_id !== u) v.push(`${task.task_id}: cause-analyst の subject・unit_id ${c.unit_id}（規則では ${u}）`);
  } else if (c.unit_id !== null) v.push(`${task.task_id}: ${task.role} の unit_id は null`);
  if (task.role === 'extractor' && !c.target_id) v.push(`${task.task_id}: extractor の target_id`);
  if ((task.role === 'partition-author') !== (c.candidates.length > 0)) v.push(`${task.task_id}: candidates は partition-author だけ空でない`);
  if (!['受付', '洗い出し', 'モデル化', '計画', '実行', '確認', '集約'].includes(c.stage)) v.push(`${task.task_id}: context.stage`);
  return v;
}

// ---- 正準のシナリオ（1 ファイル・1 目標・性質ごとに 1 検査・1 sanity・1 変異） ----
export function defaultScenario(over = {}) {
  return {
    goalIds: ['G1'],
    properties: [{ id: 'P1', file: 'spec.md', line: 2, statement: 'x は常に 0 以上である', query: { result: 'unsat' }, sanity: { result: 'sat' }, mutation: { result: 'sat' } }],
    toolTimeLimit: 30,
    reviews: {},            // perspective → '成り立つ' | '成り立たない' | '確認できず'
    judgmentAnswers: {},    // 判断を要する項目の id か kind → '成り立つ' | '成り立たない' | '確認できず' | null（答えない）。既定 成り立つ。忠実さの確認役が答える
    holdCalls: {},          // role → n。その役の worker は、最初の n 回の呼び出しで担当（束）を取って資料を引いたまま提出しない
    cause: { cause: '対象が性質を満たさない', grounds: 'モデルは出所を正しく表し、対象が性質に反する', questions: [] },
    returns: {},            // role → 'missing' | 'cannot_proceed' | 'bad_shape' | 'error'
    returnsByPerspective: {}, // perspective → 'missing' | 'bad_shape'（returns より先に見る）
    mapping: {},            // property id → relation（既定 形式化）
    claim: null,            // null | 'match' | 'mismatch'（AC-12: z3 が Rust より速いという主張と、比べる条件）
    partition: null,        // (context.candidates, put, { graph, crossing, round }) → PartitionsFile の部分（AC-07）
    // 作成役の成果物を巡（同じ役の何回目の task か。1 から）ごとに変える口。計画の欠陥・修正の巡のケースに使う
    editModelQuery: null,   // (text, { round, mp, kind: 'property' | 'sanity' }) → .smt2 の文字列（変異の .smt2 は計画作成役が書く）
    editPlan: null,         // (plan, { round, pairs, mref, put, targetRef }) → PlanFile
    editMutations: null,    // (mutations, { round, pairs, mref, put }) → MutationsFile
    editStateMachine: null, // (state_machine, { round, model_id }) → ModelFile.state_machine（モデル作成役の巡ごと）
    // 作成役が返す問い（役 → [Question]）。あればその役は needs_answer で返し、AuthorReturn.blocked_by_question に依存する性質の id を挙げる
    // （artifact-formats「AuthorReturn.blocked_by_question」: 抽出役は inventory の blocked_by_question が空でない性質、
    // モデル作成役・計画作成役は Question.affected のうち context.property_ids にあるもの）。
    // 問いに依存する性質（Question.affected の inventory の性質）は、挙げた段より後の段から外す（architecture「段と処理の順序」）:
    // 抽出役なら inventory の blocked_by_question に載せ、モデルと計画に入れない。モデル作成役・計画作成役なら計画に入れない
    questionsBy: {},
    blockedAs: {},          // 役 → 'question_ids'（契約に反して問いの id を blocked_by_question に入れる。形の違いのケース）
    allowDuplicatePlanIds: false, // true なら計画の id の重複を許す（一意の違反のケース）
    modelPropPrefix: '',    // モデルの性質の id = 接頭辞 + inventory の性質の id
    models: null,           // [{ id, propertyIds, stateMachine? }]（モデルを 2 つ以上にするとき）
    stopAfterSubmits: {},   // 役 → n: その役の提出が n 回になったら、done でなくても流し直さずに worker を終える（閉じた時点の受理の経路）
    scanDropLast: false,    // true なら抽出役は依頼の範囲の最後の行を scanned で覆わない（網羅の照合が落ちるケース）
    extraElements: [],      // [{ file, line }]: どの性質にも結ばれない要素（id は E-X<line>）を inventory に足す
    ...over,
  };
}

function directives(d = {}) {
  return Object.entries(d).map(([k, v]) => `; fake-${k === 'sleepMs' ? 'sleep-ms' : k}: ${v}`).join('\n');
}
export function smtQuery(label, d, body = null) {
  return `${directives(d)}\n; ${label}\n${body ?? '(declare-const x Int)\n(assert (and (>= x (- 8)) (<= x 8)))\n(assert (not (>= (* x x) 0)))'}\n(check-sat)\n`;
}

// 性質の query の節（artifact-formats「model」の clauses と :named の規則）。1 行に 1 つのトップレベルの assert を、現れた順に
// p.roles（既定: 最後を goal、他を rule）の役で名付ける。名前は <mp>-<役の頭文字><番号>。rule と goal の source_ids は p.clauseSources（既定 [E-<p.id>]）。
// 偽の z3 の指示 fake-core（既定: rule と goal の名前。p.fakeCore で変える）を先頭に置き、静的な確認の query（節を切り取ったもの）の答えを決める。
// mutate なら最初の rule の項を (not …) に変える（変異は名前を保ち、規則の節を変える。agents/plan-author.md）。
export function namedClauses(text, mp, p, { mutate = false } = {}) {
  const lines = text.split('\n');
  const at = lines.map((l, i) => (/^\(assert .*\)$/.test(l) && !l.includes(':named') ? i : -1)).filter((i) => i >= 0);
  const roles = p.roles ?? at.map((_, k) => (k === at.length - 1 ? 'goal' : 'rule'));
  const clauses = [];
  let mutated = false;
  at.forEach((i, k) => {
    const role = roles[k] ?? 'rule';
    const name = `${mp}-${role[0]}${k + 1}`;
    let term = lines[i].slice('(assert '.length, -1);
    if (mutate && role === 'rule' && !mutated) { term = `(not ${term})`; mutated = true; }
    lines[i] = `(assert (! ${term} :named ${name}))`;
    const basis = role === 'premise' ? (p.premiseBasis?.[name] ?? '作成役の仮定') : null;
    clauses.push({ name, role, source_ids: role === 'premise' ? [] : (p.clauseSources ?? [`E-${p.id}`]), basis, external_dependency_id: basis === '外部の依存' ? (p.externalDependencyId ?? 'X1') : null, note: `harness の ${role} の節` });
  });
  const core = p.fakeCore ? p.fakeCore(clauses) : clauses.filter((c) => c.role !== 'premise').map((c) => c.name);
  // p.fakeAnswers(clauses) → [[残す節の名前の並び, 答え]]: 切り取った実行ごとの答え（偽の z3 の fake-answers。core より先に見る）
  const answers = p.fakeAnswers && !mutate ? Object.fromEntries(p.fakeAnswers(clauses).map(([ns, a]) => [[...ns].sort().join(' '), a])) : null;
  const head = (core === null ? '' : `; fake-core: ${core.join(' ')}\n`) + (answers ? `; fake-answers: ${JSON.stringify(answers)}\n` : '');
  return { text: head + lines.join('\n'), clauses };
}

function worklog(task) {
  const run = task.context.run_dir;
  const rulesDir = join(run, 'document-rules');
  const rules = existsSync(rulesDir) ? readdirSync(rulesDir).filter((n) => n.endsWith('.md')).sort()[0] : null;
  return {
    schema: 'formal-method.worklog/1', role: task.role, task_id: task.task_id, stage: task.context.stage,
    target: task.context.target_id ?? 'T1', inputs: [], actions: `${task.role} として与えられた資料を読んだ。`, results: '返り値を書いた。',
    grounds: 'テストの harness が決めた値である。', failures: [], unconfirmed: [], unreadable_inputs: [],
    document_rules: rules ? { ref: relative(run, join(rulesDir, rules)), version: sha(readFileSync(join(rulesDir, rules))) } : { ref: 'document-rules/missing.md', version: `sha256:${'0'.repeat(64)}` },
  };
}

const write = (task, name, value) => {
  mkdirSync(task.attempt_dir, { recursive: true });
  writeFileSync(join(task.attempt_dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

const unk = { status: '取得できず', reason: 'harness は見積りを持たない' };
const basis = (p, over = {}) => ({ property_ids: [p.id], assumptions: ['x は -8 以上 8 以下'], scope: 'x ∈ [-8, 8]', assurance: '範囲を限った検査', judgment_rules: 'SP-FORMALMETHOD-011', ...over });
function candidate(role, name, p, s) {
  const c = { role, name, handles: '整数の算術の性質', assurance: '範囲を限った検査', environment: 'ローカル', checkable_scope: 'x の有限の領域',
    estimates: { setup: unk, execution: unk, resources: unk }, available: true, reason: '比較の候補', comparison_basis: basis(p), performance_claim: null };
  if (name === 'z3' && s.claim) {
    c.performance_claim = { better_than: 'Rust', metric: 'execution' };
    if (s.claim === 'mismatch') c.comparison_basis = basis(p, { scope: 'x ∈ [-2, 2]（範囲を減らした）', assurance: '範囲を限った検査（境界を狭めた）' });
  }
  return c;
}

// モデルの性質の id（inventory の id と違えられる。run の全てのモデルを通して一意になるよう、inventory の id から作る）
const mpid = (s, p) => `${s.modelPropPrefix}${p.id}`;
// モデルの並び。scenario.models が無ければ、形式化できる性質を全て持つ 1 つのモデル M1。
// roles のどれかが返した問いが、性質 pid に依存するか（Question.affected で結び付ける）
const questionsOf = (s, roles, pid) => roles.flatMap((r) => s.questionsBy[r] ?? []).filter((q) => q.affected.includes(pid)).map((q) => q.id);
function modelsOf(s) {
  const inModel = s.properties.filter((p) => questionsOf(s, ['extractor'], p.id).length === 0);
  const formal = inModel.filter((p) => p.formalizable !== false);
  if (!s.models) return [{ id: 'M1', props: formal, stateMachine: s.stateMachine, behavior: s.behavior, omittedEdges: s.omittedEdges, mappingProps: inModel }];
  return s.models.map((m, i) => ({ ...m, props: formal.filter((p) => m.propertyIds.includes(p.id)), mappingProps: i === 0 ? inModel.filter((p) => p.formalizable === false || m.propertyIds.includes(p.id)) : formal.filter((p) => m.propertyIds.includes(p.id)) }));
}

const ROLE = {
  extractor(task, s) {
    const req = readJson(join(task.context.run_dir, 'request.json'));
    const target = req.targets.find((t) => t.id === task.context.target_id);
    // 写しは作らないので、元のファイル（fixed.files の abs_path）を読む
    const snap = (f) => target.fixed.files.find((x) => x.path === f).abs_path;
    // 覆うのは依頼の範囲（scope.include）だけ（run.mjs の requestScopeOf と同じ決め方）。範囲の外のファイル・行は scanned に入れない
    const include = req.scope?.include ?? [];
    const locs = include.filter((p) => p.kind === 'location' && p.target_id === target.id);
    const whole = include.some((p) => p.kind === 'target' && p.id === target.id) || locs.length === 0;
    const scopeOf = (file) => {
      if (whole) return null;
      const mine = locs.filter((p) => p.file === file);
      if (!mine.length) return undefined;
      return mine.some((p) => !p.span) ? null : mine.map((p) => p.span);
    };
    const scanned = target.fixed.files.filter((f) => scopeOf(f.path) !== undefined).flatMap((f) => {
      if (!f.text || f.content_hash === 'unreadable') return [{ file: f.path, span: null, status: 'unread', reason: 'テキストでない' }];
      const n = linesOf(readFileSync(snap(f.path), 'utf8')).length;
      const spans = scopeOf(f.path) ?? (n === 0 ? [] : [`L1-L${n}`]);
      if (spans.length === 0) return [{ file: f.path, span: null, status: 'read', reason: null }];
      const out = spans.map((span) => ({ file: f.path, span, status: 'read', reason: null }));
      if (s.scanDropLast) {
        const last = out[out.length - 1];
        const [, a, b] = last.span.match(/^L(\d+)-L(\d+)$/).map(Number);
        if (a === b) out.pop(); else last.span = `L${a}-L${b - 1}`;
      }
      return out;
    });
    const elements = [];
    const properties = [];
    for (const p of s.properties) {
      const line = linesOf(readFileSync(snap(p.file), 'utf8'))[p.line - 1];
      elements.push({ id: `E-${p.id}`, kind: 'requirement', source: { target_id: target.id, file: p.file, span: `L${p.line}-L${p.line}`, quote_hash: sha(line) }, text: line });
      properties.push({ id: p.id, source_ids: [`E-${p.id}`], statement: p.statement, formalizable: p.formalizable !== false,
        nonformal_reason: p.formalizable === false ? '数で表せない' : null, nonformal_method: p.formalizable === false ? '文書の読み合わせ' : null,
        assumptions: [], scope: '対象の全体', blocked_by_question: [...(p.blocked_by_question ?? []), ...questionsOf(s, ['extractor'], p.id)] });
    }
    for (const x of s.extraElements ?? []) {
      const line = linesOf(readFileSync(snap(x.file), 'utf8'))[x.line - 1];
      elements.push({ id: `E-X${x.line}`, kind: 'requirement', source: { target_id: target.id, file: x.file, span: `L${x.line}-L${x.line}`, quote_hash: sha(line) }, text: line });
    }
    write(task, 'inventory.json', { schema: 'formal-method.inventory/1', target_id: target.id, content_hash: target.fixed.content_hash, scanned, elements, properties, external_dependencies: s.externalDependencies ?? [] });
    return [{ kind: 'inventory', ref: runRef(task, 'inventory.json') }];
  },
  'model-author'(task, s, memory) {
    const outputs = [];
    memory.models = [];
    const round = memory.rounds[task.role];
    const q = (text, mp, kind) => (s.editModelQuery ? s.editModelQuery(text, { round, mp, kind }) : text);
    for (const m of modelsOf(s)) {
      for (const p of m.props) {
        const mp = mpid(s, p);
        write(task, `${mp}.smt2`, q(namedClauses(smtQuery(`property ${mp}`, p.query, p.smt), mp, p).text, mp, 'property'));
        write(task, `${mp}-sanity.smt2`, q(smtQuery(`sanity ${mp}`, p.sanity ?? { result: 'sat' }, p.smt), mp, 'sanity'));
      }
      const file = `model-${m.id}.json`;
      write(task, file, {
        schema: 'formal-method.model/2', model_id: m.id, adapter_id: 'z3',
        covers: { targets: ['T1'], states: m.stateMachine?.states ?? [], events: m.stateMachine?.events ?? [], assumptions: [{ id: 'A1', text: 'x は -8 以上 8 以下の整数' }], constraints: [], excluded: [] },
        state_machine: m.stateMachine ? (s.editStateMachine ? s.editStateMachine(structuredClone(m.stateMachine), { round, model_id: m.id }) : m.stateMachine) : null, no_state_machine_reason: m.stateMachine ? null : '対象は状態遷移を持たない', io_contracts: [],
        properties: m.props.map((p) => ({ id: mpid(s, p), inventory_property_ids: [p.id], query_ref: runRef(task, `${mpid(s, p)}.smt2`), expected: 'unsat',
          assurance: { kind: '範囲を限った検査', scope: 'x は -8 以上 8 以下の整数', bounds: [{ item: 'x', bound: '-8..8' }], scope_variables: p.scopeVariables ?? (p.smt ? [] : ['x']), fairness_assumptions: [] },
          clauses: p.clauses ?? namedClauses(smtQuery('', p.query, p.smt), mpid(s, p), p).clauses,
          sanity: [{ kind: 'assumptions_consistent', query_ref: runRef(task, `${mpid(s, p)}-sanity.smt2`) }] })),
        behavior: m.behavior ?? { applicable: false, reason: '状態遷移を持たない' }, source_diagrams: [], omitted_edges: m.omittedEdges ?? [],
      });
      const mapFile = `mapping-${m.id}.json`;
      write(task, mapFile, { schema: 'formal-method.mapping/1', model_id: m.id, rows: (m.mappingProps ?? m.props).flatMap((p) => {
        const relation = s.mapping[p.id] ?? (p.formalizable === false ? '形式検証でない確認' : '形式化');
        const reason = relation === '対応なし' || relation === '範囲外' ? 'harness が対応を付けなかった' : null;
        const el = p.formalizable === false ? p.id : mpid(s, p);
        return [
          ...s.goalIds.map((g) => ({ source: { kind: 'goal', id: g }, property_id: p.id, model_element: el, relation, reason })),
          // p.mappingLocation === false なら、出所の行の対応を書かない（性質の出所が対応表にも節にも無い場面）
          ...(p.mappingLocation === false ? [] : [{ source: { kind: 'location', target_id: 'T1', file: p.file, span: `L${p.line}-L${p.line}` }, property_id: p.id, model_element: el, relation, reason }]),
        ];
      }) });
      memory.models.push({ id: m.id, file, task });
      outputs.push({ kind: 'model', ref: runRef(task, file) }, { kind: 'mapping', ref: runRef(task, mapFile) });
    }
    return outputs;
  },
  'partition-author'(task, s, memory) {
    const cands = task.context.candidates;
    // 部分を跨ぐ辺は、自分の書いたモデルから依存グラフの導出の規則で求める（Boundary.edge_id はその辺の id）
    const run = task.context.run_dir;
    const models = memory.models.map((m) => { const ref = relative(run, join(m.task.attempt_dir, m.file)); return { model: readJson(join(run, ref)), ref }; });
    const graph = deriveGraph(models, (ref) => (existsSync(join(run, ref)) ? readFileSync(join(run, ref), 'utf8') : null));
    const put = (name, body) => { write(task, name, body); return runRef(task, name); };
    const extra = s.partition ? s.partition(cands, put, { graph, crossing: (parts, modelId) => crossingEdges(graph, parts, modelId), round: memory.rounds[task.role] }) : null;
    memory.partition = extra;
    write(task, 'partitions.json', {
      schema: 'formal-method.partitions/1',
      decisions: cands.map((c) => ({ candidate_id: c.id, adopted: Boolean(extra), reason: extra ? '依存の弱い境界で分ける' : '分けない' })),
      adopted: Boolean(extra), reason: extra ? '部分ごとに検証する' : '分けずに検証する',
      parts: extra?.parts ?? [], boundaries: extra?.boundaries ?? [], contracts: extra?.contracts ?? [], composition_conditions: extra?.composition_conditions ?? [],
    });
    return [{ kind: 'partitions', ref: runRef(task, 'partitions.json') }];
  },
  'plan-author'(task, s, memory) {
    const modelTask = memory.byRole['model-author'];
    assert.ok(modelTask, 'plan-author の前に model-author の task がある');
    const mref = (name) => relative(task.context.run_dir, join(modelTask.attempt_dir, name));
    // 分割から契約・合成の条件の検査を作るのは、CLI が分割を採って計画作成役の入力に PartitionsFile を渡したときだけ
    // （欠陥の残った分割は採らず、計画作成役には分割の無いモデルだけを渡す。artifact-formats「欠陥の残った分割」）
    const pt = memory.byRole['partition-author'];
    const partRef = pt ? relative(task.context.run_dir, join(pt.attempt_dir, 'partitions.json')) : null;
    const part = partRef && task.context.input_refs.some((r) => r.ref === partRef) ? memory.partition : null;
    // モデル作成役・計画作成役が問いに依存すると挙げた性質は、計画に入れない（変異は unavailable に理由を書く）
    const all = modelsOf(s).flatMap((m) => m.props.map((p) => ({ m, p, mp: mpid(s, p) })));
    const blocked = all.filter(({ p }) => questionsOf(s, ['model-author', 'plan-author'], p.id).length > 0);
    const pairs = all.filter((x) => !blocked.includes(x));
    // targetRef: 対象のファイルの ref（target:<target_id>/<FilePath>。担当が書いたものでない資料）
    const targetRef = (file) => { const req = readJson(join(task.context.run_dir, 'request.json')); return `target:${req.targets[0].id}/${file}`; };
    const ctx = { round: memory.rounds[task.role], pairs, mref, targetRef, put: (name, body) => { write(task, name, body); return runRef(task, name); } };
    // 変異の .smt2 は計画作成役自身の attempt に書き、mutation_ref はそこを指す（artifact-formats「変異のファイル」、agents/plan-author.md）
    for (const { p, mp } of pairs.filter(({ p }) => p.mutation)) write(task, `${mp}-mut.smt2`, namedClauses(smtQuery(`mutation ${mp}`, p.mutation, p.smt), mp, p, { mutate: true }).text);
    const plan = {
      schema: 'formal-method.plan/1',
      // selection は inventory の性質の id。CLI が実行できる道具の名前は adapter の id（z3）で書く（artifact-formats「plan と mutations」の道具の名前）
      selection: pairs.map(({ p }) => ({ property_id: p.id, candidates: [candidate('実行基盤', 'Rust', p, s), candidate('検証器', 'z3', p, s)], chosen: { technique: 'SMT', tool: 'z3' }, reason: '整数の制約を直接書ける' })),
      checks: [
        // kind: property の target_id はモデルの性質の id
        ...pairs.map(({ m, p, mp }) => ({ id: `C-${mp}`, kind: 'property', target_id: mp, model_id: m.id, input_refs: [mref(`${mp}.smt2`)], expected: 'unsat', assumptions: ['x は -8 以上 8 以下'], scope: 'x ∈ [-8, 8]', tool_time_limit_seconds: p.toolTimeLimit ?? s.toolTimeLimit, depends_on: [] })),
        ...(part?.contracts ?? []).map((k) => ({ id: `C-${k.id}`, kind: 'contract', target_id: k.id, model_id: k.model_id, input_refs: [k.query_ref], expected: 'unsat', assumptions: [], scope: '部分', tool_time_limit_seconds: s.toolTimeLimit, depends_on: [] })),
        ...(part?.composition_conditions ?? []).map((k) => ({ id: `C-${k.id}`, kind: 'composition', target_id: k.id, model_id: k.model_id, input_refs: [k.query_ref], expected: 'unsat', assumptions: [], scope: '全体', tool_time_limit_seconds: s.toolTimeLimit, depends_on: (part.contracts ?? []).map((x) => `C-${x.id}`) })),
      ],
      sanity: pairs.map(({ mp }) => ({ id: `S-${mp}`, model_property_id: mp, input_refs: [mref(`${mp}-sanity.smt2`)], tool_time_limit_seconds: s.toolTimeLimit })),
    };
    write(task, 'plan.json', s.editPlan ? s.editPlan(plan, ctx) : plan);
    const mutations = {
      schema: 'formal-method.mutations/1',
      // mutations の property_id はモデルの性質の id、unavailable は inventory の性質の id
      mutations: pairs.filter(({ p }) => p.mutation).map(({ p, mp }) => ({ id: `MU-${mp}`, property_id: mp, mutation_ref: runRef(task, `${mp}-mut.smt2`), expected_violation: 'sat', detector_check_id: `C-${mp}` })),
      unavailable: [...pairs.filter(({ p }) => !p.mutation).map(({ p }) => ({ property_id: p.id, reason: '変異を作れない', alternative: null })),
        ...blocked.map(({ p }) => ({ property_id: p.id, reason: '問いに依存する', alternative: null }))],
    };
    write(task, 'mutations.json', s.editMutations ? s.editMutations(mutations, ctx) : mutations);
    // 計画の 3 つの id（検査・sanity・変異）は、確認の id（confirm-<kind>-<n>）と重ならないよう confirm- で始めない
    const planIds = [...readJson(join(task.attempt_dir, 'plan.json')).checks.map((x) => x.id), ...readJson(join(task.attempt_dir, 'plan.json')).sanity.map((x) => x.id), ...readJson(join(task.attempt_dir, 'mutations.json')).mutations.map((x) => x.id)];
    assert.ok(planIds.every((id) => !id.startsWith('confirm-')), 'harness の計画の id は confirm- で始まらない');
    if (!s.allowDuplicatePlanIds) assert.ok(new Set(planIds).size === planIds.length, 'harness の計画の id は一意');
    return [{ kind: 'plan', ref: runRef(task, 'plan.json') }, { kind: 'mutations', ref: runRef(task, 'mutations.json') }];
  },
};

// 忠実さの確認役は、query が渡した判断を要する項目の記録（judgments/<model_id>.json）の項目ごとに答える
function judgmentsOf(task) {
  const r = (task.context.input_refs ?? []).find((x) => x.name === `judgments-${task.context.model_id}`);
  return r ? readJson(join(task.context.run_dir, r.ref)).judgments : [];
}
function reviewReturn(task, s) {
  const perspective = task.context.perspective;
  const result = s.reviews[perspective] ?? '成り立つ';
  write(task, 'review.json', { perspective, note: 'harness の確認の記録' });
  // 答えが null の項目は答えない（返り値の形の違いのケース）
  const answer = (j) => (j.id in s.judgmentAnswers ? s.judgmentAnswers[j.id] : j.kind in s.judgmentAnswers ? s.judgmentAnswers[j.kind] : '成り立つ');
  const judgments = perspective === 'fidelity' ? judgmentsOf(task).filter((j) => answer(j) !== null).map((j) => ({ id: j.id, result: answer(j), note: `harness の答え（${j.cause}）` })) : [];
  return {
    task_id: task.task_id, unit_id: task.context.unit_id, perspective, result,
    findings: result === '成り立たない' ? [{ ref: task.context.property_ids[0] ?? 'P1', kind: 'meaning_change', note: '否定が逆になっている' }] : [],
    judgments, record_ref: runRef(task, 'review.json'), worklog_ref: runRef(task, 'worklog.json'),
  };
}

function causeReturn(task, s) {
  write(task, 'cause.json', { note: 'harness の分類の記録' });
  return { task_id: task.task_id, unit_id: task.context.unit_id, cause: s.cause.cause, grounds: s.cause.grounds, questions: s.cause.questions,
    record_ref: runRef(task, 'cause.json'), worklog_ref: runRef(task, 'worklog.json') };
}

// hooks:
//   via: 'process'（既定）| 'shell'。担当の claim・query・submit と司令塔の close を、client の関数で同じ process から流すか、
//     担当と同じく Bash の命令（入口の claim・query_cmd・submit_cmd、CLI の close）で流すか。どちらも同じ依頼・応答・受け箱のファイルを通る。
//     既定を process にするのは、node の起動の数を減らし、時間の上限のケースの担当の進みを並列の負荷に左右させないため。
//     入口と命令の文字列そのものは、shell で流すケース（call.test.mjs）が確かめる。
//   beforeSubmit(status, { tasks: [task] }): 担当が成果物と返り値を書いた後、submit の前に呼ぶ（担当ごと・提出ごと）。
//   close(status, call) → null | 閉じ方。司令塔の close の型（artifact-formats「Workflow の返り値」、SKILL.md「担当の起動」）:
//     null・'plain': {agents, tokens} を書いたファイルで close。'wrapped': ホストの完了通知の包み {summary, agentCount, logs, result} で close。
//     'timed_out': timed_out: true で close。'late': 期限（deadline_wall_ms）を過ぎてから close。'none': close しない（run-daemon が期限で閉じる）。
//     'inbox_not_json'・'inbox_shape'・'inbox_call_id': 受け箱そのものを崩す（close の入力の検査を通らないので、close と同じ手順で直接公開する）。
//     'wf_unreadable'・'wf_shape': Workflow の返り値のファイルを崩す。
//   tokens(call) → number | null: close に渡す Workflow の返り値の tokens。
export const CLOSE_MODES = ['plain', 'wrapped', 'timed_out', 'late', 'none', 'inbox_not_json', 'inbox_shape', 'inbox_call_id', 'wf_unreadable', 'wf_shape'];
// close と同じ手順で受け箱を公開する（一時ファイルに書いてから link するので、書きかけは見えない）
function publishInbox(runDir, callId, text) {
  const inbox = join(runDir, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const tmp = join(inbox, `.tmp-harness-${randomBytes(8).toString('hex')}`);
  writeFileSync(tmp, text);
  linkSync(tmp, join(inbox, `${callId}.json`));
  unlinkSync(tmp);
}
const LATE_MARGIN_MS = 1000;
const json1 = (r) => r.json ?? { ok: false, code: 'E_HARNESS', reason: `出力が 1 行の JSON でない: ${r.stdout.slice(0, 300)} ${r.stderr.slice(0, 300)}` };

// 返り値（artifact-formats「担当の返り値」）を役ごとに書く。round はその役の提出の何回目か（1 から）。
function writeReturn(task, scenario, memory, mode) {
  write(task, 'worklog.json', worklog(task));
  let ret;
  if (task.context.perspective) ret = reviewReturn(task, scenario);
  else if (task.role === 'cause-analyst') ret = causeReturn(task, scenario);
  else if (mode === 'cannot_proceed') ret = { task_id: task.task_id, status: 'cannot_proceed', outputs: [], questions: [], blocked_by_question: [], reason: 'harness が進めない', worklog_ref: runRef(task, 'worklog.json') };
  else {
    const qs = scenario.questionsBy[task.role] ?? [];
    const outputs = ROLE[task.role](task, scenario, memory);
    let blocked;
    if (scenario.blockedAs[task.role] === 'question_ids') blocked = qs.map((q) => q.id);
    else if (task.role === 'extractor') blocked = readJson(join(task.attempt_dir, 'inventory.json')).properties.filter((p) => p.blocked_by_question.length > 0).map((p) => p.id);
    else blocked = [...new Set(qs.flatMap((q) => q.affected))].filter((id) => task.context.property_ids.includes(id));
    ret = { task_id: task.task_id, status: qs.length ? 'needs_answer' : 'done', outputs, questions: qs, blocked_by_question: blocked, reason: null, worklog_ref: runRef(task, 'worklog.json') };
    memory.authorReturns.push({ task, ret });
  }
  if (mode === 'bad_shape') ret = { ...ret, unexpected: true };
  writeFileSync(task.result_path, JSON.stringify(ret, null, 2));
}

export function makeHarness(scenario, hooks = {}) {
  const memory = { byRole: {}, rounds: {}, tasks: [], calls: [], submits: [], violations: [], partition: null, models: [], closes: [], authorReturns: [], held: {} };
  // Workflow の返り値は、run の workspace の保存先の root（<ws>/.formal-method/。runs/<run_id> の 2 つ上）の下に置く。
  // 呼び手は workspace を消すので tmpdir() の直下に残らず、.formal-method/ は対象の集まりから除かれるので、対象の指紋も変えない
  let wfDir = null;
  // 役の 1 体: claim が done を返すまで、取った担当（1 回の claim で 1 つ以上）を果たす。戻り値は Workflow の起動の記録の 1 行。
  async function worker(status, args, w, call, opts) {
    const rec = { role: w.role, label: `${w.role}-${w.id}`, model: w.model, effort: w.effort, ok: true };
    const roles = w.role.split('+');
    // 'error' は、担当が起動に失敗した（claim を流さない）
    if (roles.some((r) => scenario.returns[r] === 'error')) return { ...rec, ok: false };
    const launcher = join(args.state, 'formal-method-cli.mjs');
    const base = { run_dir: args.state, call_id: args.callId, worker: w.id };
    const claimCmd = `printf '%s' '${JSON.stringify(base)}' | '${process.execPath}' '${launcher}' claim`;
    const shell = hooks.via === 'shell';
    const run = async (command, cmd, input) => (shell ? json1(await runShell(cmd, opts)) : workerCall(command, input));
    // holdCalls: この呼び出しで束を取ったまま出さないか
    const holdRole = roles.find((r) => (scenario.holdCalls[r] ?? 0) > (memory.held[r] ?? 0));
    if (holdRole) memory.held[holdRole] = (memory.held[holdRole] ?? 0) + 1;
    for (let guard = 0; guard < 40; guard += 1) {
      const c = await run('claim', claimCmd, base);
      if (!c.ok || c.done) { call.claims.push({ worker: w.id, ...c }); break; }
      call.claims.push({ worker: w.id, done: false, task_ids: c.tasks.map((x) => x.task_id) });
      const got = [];
      for (const raw of c.tasks) {
        let task = memory.tasks.find((x) => x.task_id === raw.task_id);
        if (!task) {
          memory.violations.push(...taskViolations(raw, status.run_dir, memory, w));
          const q = await run('query', raw.query_cmd, { ...base, task_id: raw.task_id });
          // 呼び出しが閉じた・期限を過ぎた（時間の上限のケース）なら、担当を終える
          if (!q.ok) { call.claims.push({ worker: w.id, query: q }); return { ...rec, ok: false }; }
          // query_inputs: query の応答の inputs をそのまま（path を見るテストのため）
          task = { ...raw, query_inputs: q.inputs, context: { ...raw.context, input_refs: q.inputs.map((x) => ({ name: x.name, ref: x.ref, ...(x.spans ? { spans: x.spans } : {}) })) } };
          memory.tasks.push(task);
          call.tasks.push(task);
          memory.byRole[task.role] = task;
        }
        got.push(task);
      }
      if (holdRole) return { ...rec, ok: false };
      for (const task of got) {
        const mode = (task.context.perspective && scenario.returnsByPerspective[task.context.perspective]) || scenario.returns[task.role];
        // 'missing' は、取って資料を引いたまま提出しない（返らなかった担当）
        if (mode === 'missing') return { ...rec, ok: false };
        let done = false;
        for (let n = 0; n < 10 && !done; n += 1) {
          memory.rounds[task.role] = (memory.rounds[task.role] ?? 0) + 1;
          const round = memory.rounds[task.role];
          writeReturn(task, scenario, memory, mode);
          if (hooks.beforeSubmit) await hooks.beforeSubmit(status, { tasks: [task] });
          const r = await run('submit', task.submit_cmd, base);
          if (!r.ok) { memory.submits.push({ task_id: task.task_id, role: task.role, round, refused: r }); return rec; }
          const res = r.results.find((x) => x.task_id === task.task_id);
          memory.submits.push({ task_id: task.task_id, role: task.role, round, result: res });
          done = res.done;
          if (!done && (scenario.stopAfterSubmits[task.role] ?? Infinity) <= round) return rec;
        }
      }
    }
    return rec;
  }
  async function onAgents(status, opts = {}) {
    if (!wfDir) wfDir = mkdtempSync(join(dirname(dirname(status.run_dir)), '.fm-harness-wf-'));
    assert.ok(status.call, `run_agents は call を持つ: ${JSON.stringify(status)}`);
    const args = readJson(status.call.args_path);
    assert.deepEqual(Object.keys(args).sort(), ['callId', 'stage', 'state', 'workers'], 'args は {state, callId, stage, workers} だけ');
    assert.equal(args.callId, status.call.call_id);
    assert.equal(args.state, status.run_dir);
    const call = { ...args, deadline_wall_ms: status.call.deadline_wall_ms, tasks: [], claims: [] };
    memory.calls.push(call);
    const agents = await Promise.all(args.workers.map((w) => worker(status, args, w, call, opts)));
    assert.deepEqual(memory.violations, [], 'run-daemon が出した task が契約（claim の Task の欄・役と context）に合う');
    const mode = (hooks.close ? hooks.close(status, call) : null) ?? 'plain';
    assert.ok(CLOSE_MODES.includes(mode), `harness の閉じ方 ${mode}`);
    memory.closes.push({ call_id: args.callId, mode });
    if (mode === 'none') return;
    if (mode === 'late') while (Date.now() < status.call.deadline_wall_ms + LATE_MARGIN_MS) await new Promise((r) => setTimeout(r, 100));
    const doClose = async (input) => {
      if (hooks.via === 'shell') expectOk(await cli('close', input, opts), 'close');
      else assert.ok(['accepted', 'duplicate'].includes(closeInProcess(input).outcome));
    };
    if (mode === 'timed_out') { await doClose({ run_dir: status.run_dir, call_id: args.callId, timed_out: true }); return; }
    const wf = join(wfDir, `${args.callId}.json`);
    // tokens: hooks.tokens(call) が数を返せばその値（Workflow の budget.spent() の差の代わり）、無ければ null
    const out = { agents, tokens: hooks.tokens ? hooks.tokens(call) : null };
    const inboxModes = {
      inbox_not_json: () => publishInbox(status.run_dir, args.callId, '{"call_id": '),
      inbox_shape: () => publishInbox(status.run_dir, args.callId, JSON.stringify({ call_id: args.callId })),
      inbox_call_id: () => { writeFileSync(wf, JSON.stringify(out)); publishInbox(status.run_dir, args.callId, JSON.stringify({ call_id: `${args.callId}-other`, workflow_output_path: wf })); },
    };
    if (inboxModes[mode]) { inboxModes[mode](); return; }
    if (mode === 'wrapped') writeFileSync(wf, JSON.stringify({ summary: `${agents.length} 体の担当が終わった`, agentCount: agents.length, logs: [], result: out }));
    else if (mode === 'wf_shape') writeFileSync(wf, JSON.stringify({ agents: 'not-an-array', tokens: null }));
    else if (mode !== 'wf_unreadable') writeFileSync(wf, JSON.stringify(out));
    await doClose({ run_dir: status.run_dir, call_id: args.callId, workflow_output_path: mode === 'wf_unreadable' ? join(wfDir, `${args.callId}-missing.json`) : wf });
  }
  return { onAgents, memory };
}
