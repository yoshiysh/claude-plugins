// 担当の代わりの harness。Workflow の代わりに、tasks.json の各 task の attempt の領域へ、
// artifact-formats.md の「担当の成果物」「担当の返り値」「task の一覧」「作業記録」の形だけで返り値を書き、submit する。
// task から読むのは Task と TaskContext の欄だけ（unit_id・perspective・candidates・stage・run_dir・target_id）。
// 受け取った task が契約の形（task.md の 4 つの見出し、役ごとの context）に合わなければ、その違反で失敗する。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, chmodSync, linkSync, unlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { cli, expectOk } from './cli-runner.mjs';
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

// ---- 受け取った task の契約の検査（task.md の形と、役と context の表） ----
const HEADINGS = ['ROLE', 'TASK', 'RETURN_SCHEMA', 'WRITE'];
const ROLE_PERSPECTIVE = {
  extractor: [null], 'model-author': [null], 'plan-author': [null], 'partition-author': [null], 'cause-analyst': [null],
  'extraction-reviewer': ['extraction'], 'assurance-reviewer': ['nonformal', 'assurance'], 'fidelity-reviewer': ['fidelity'], 'composition-reviewer': ['composition'],
};
export function taskViolations(task, runDir, memory = null) {
  const v = [];
  const c = task.context;
  if (!c) return [`${task.task_id}: context が無い`];
  if (c.run_dir !== runDir) v.push(`${task.task_id}: context.run_dir が run の領域と違う`);
  const md = readFileSync(join(task.attempt_dir, 'task.md'), 'utf8');
  const heads = [...md.matchAll(/^## (\S+)\s*$/gm)].map((m) => ({ name: m[1], at: m.index, end: m.index + m[0].length }));
  if (heads.map((h) => h.name).join() !== HEADINGS.join()) v.push(`${task.task_id}: task.md の見出し ${heads.map((h) => h.name).join()}`);
  else {
    const bodies = heads.map((h, i) => md.slice(h.end, i + 1 < heads.length ? heads[i + 1].at : md.length).trim());
    bodies.forEach((b, i) => { if (!b) v.push(`${task.task_id}: task.md の ${HEADINGS[i]} の本文が空`); });
    try {
      const { prompt, ...rest } = task;
      assert.deepEqual(JSON.parse(bodies[1]), rest);
    } catch { v.push(`${task.task_id}: task.md の TASK が Task から prompt を除いた JSON と一致しない`); }
  }
  if (!(ROLE_PERSPECTIVE[task.role] ?? []).includes(c.perspective)) v.push(`${task.task_id}: ${task.role} の perspective ${c.perspective}`);
  const expectUnit = {
    extraction: () => `extraction-${c.target_id}`, nonformal: () => `nonformal-${c.property_ids[0]}`,
    // assurance-<モデルの性質の id>。context.property_ids はそのモデルの性質の inventory_property_ids
    assurance: () => {
      const ms = (memory?.models ?? []).filter((m) => m.id === c.model_id).map((m) => readJson(join(m.task.attempt_dir, m.file)));
      const mp = ms.flatMap((m) => m.properties).find((p) => [...p.inventory_property_ids].sort().join() === [...c.property_ids].sort().join());
      return mp ? `assurance-${mp.id}` : '<モデルの性質が見つからない>';
    },
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
    ...over,
  };
}

function directives(d = {}) {
  return Object.entries(d).map(([k, v]) => `; fake-${k === 'sleepMs' ? 'sleep-ms' : k}: ${v}`).join('\n');
}
export function smtQuery(label, d, body = null) {
  return `${directives(d)}\n; ${label}\n${body ?? '(declare-const x Int)\n(assert (and (>= x (- 8)) (<= x 8)))\n(assert (not (>= (* x x) 0)))'}\n(check-sat)\n`;
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
    const snap = (f) => join(task.context.run_dir, target.fixed.snapshot_ref, 'files', f);
    const scanned = target.fixed.files.map((f) => {
      if (!f.text || f.content_hash === 'unreadable') return { file: f.path, span: null, status: 'unread', reason: 'テキストでない' };
      const n = linesOf(readFileSync(snap(f.path), 'utf8')).length;
      return n === 0 ? { file: f.path, span: null, status: 'read', reason: null } : { file: f.path, span: `L1-L${n}`, status: 'read', reason: null };
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
    write(task, 'inventory.json', { schema: 'formal-method.inventory/1', target_id: target.id, content_hash: target.fixed.content_hash, scanned, elements, properties, external_dependencies: [] });
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
        write(task, `${mp}.smt2`, q(smtQuery(`property ${mp}`, p.query, p.smt), mp, 'property'));
        write(task, `${mp}-sanity.smt2`, q(smtQuery(`sanity ${mp}`, p.sanity ?? { result: 'sat' }, p.smt), mp, 'sanity'));
      }
      const file = `model-${m.id}.json`;
      write(task, file, {
        schema: 'formal-method.model/1', model_id: m.id, adapter_id: 'z3',
        covers: { targets: ['T1'], states: m.stateMachine?.states ?? [], events: m.stateMachine?.events ?? [], assumptions: [{ id: 'A1', text: 'x は -8 以上 8 以下の整数' }], constraints: [], excluded: [] },
        state_machine: m.stateMachine ? (s.editStateMachine ? s.editStateMachine(structuredClone(m.stateMachine), { round, model_id: m.id }) : m.stateMachine) : null, no_state_machine_reason: m.stateMachine ? null : '対象は状態遷移を持たない', io_contracts: [],
        properties: m.props.map((p) => ({ id: mpid(s, p), inventory_property_ids: [p.id], query_ref: runRef(task, `${mpid(s, p)}.smt2`), expected: 'unsat',
          assurance: { kind: '範囲を限った検査', scope: 'x は -8 以上 8 以下の整数', bounds: [{ item: 'x', bound: '-8..8' }], fairness_assumptions: [] },
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
          { source: { kind: 'location', target_id: 'T1', file: p.file, span: `L${p.line}-L${p.line}` }, property_id: p.id, model_element: el, relation, reason },
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
    // targetRef: 対象の写しの中のファイル（run の領域からの Ref。担当が書いたものでない資料）
    const targetRef = (file) => { const req = readJson(join(task.context.run_dir, 'request.json')); return join(req.targets[0].fixed.snapshot_ref, 'files', file); };
    const ctx = { round: memory.rounds[task.role], pairs, mref, targetRef, put: (name, body) => { write(task, name, body); return runRef(task, name); } };
    // 変異の .smt2 は計画作成役自身の attempt に書き、mutation_ref はそこを指す（artifact-formats「変異のファイル」、agents/plan-author.md）
    for (const { p, mp } of pairs.filter(({ p }) => p.mutation)) write(task, `${mp}-mut.smt2`, smtQuery(`mutation ${mp}`, p.mutation, p.smt));
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

function reviewReturn(task, s) {
  const perspective = task.context.perspective;
  const result = s.reviews[perspective] ?? '成り立つ';
  write(task, 'review.json', { perspective, note: 'harness の確認の記録' });
  return {
    task_id: task.task_id, unit_id: task.context.unit_id, perspective, result,
    findings: result === '成り立たない' ? [{ ref: task.context.property_ids[0] ?? 'P1', kind: 'meaning_change', note: '否定が逆になっている' }] : [],
    record_ref: runRef(task, 'review.json'), worklog_ref: runRef(task, 'worklog.json'),
  };
}

function causeReturn(task, s) {
  write(task, 'cause.json', { note: 'harness の分類の記録' });
  return { task_id: task.task_id, unit_id: task.context.unit_id, cause: s.cause.cause, grounds: s.cause.grounds, questions: s.cause.questions,
    record_ref: runRef(task, 'cause.json'), worklog_ref: runRef(task, 'worklog.json') };
}

// hooks.reject(status, list) → null | 拒否の型。型ごとに cli-contract「受け箱」の batch の拒否の条件の 1 つに当たる。
//   wf_batch_id: Workflow の返り値の batch_id が開いている batch と違う。received: received の値が tasks.json と違う。
//   set_missing・set_extra: results の task の集合が tasks と違う（欠ける・余分）。timed_out: 受け箱が timed_out: true。
//   late: 期限の後に公開する。no_submit: 公開しない（run-daemon が期限で batch を閉じる）。
//   wf_shape: Workflow の返り値が形に合わない（results が配列でない。submit は中身を読まないので submit で公開する）。
//   受け箱そのものの不備は submit の入力の検査（cli-intake の shape）を通らないので、harness が submit と同じ手順
//   （inbox/.tmp-* に書いて inbox/<batch_id>.json へ link）で直接公開する:
//   inbox_unreadable: 読めれば受け付ける中身の、権限 000 のファイル（root では読めてしまうので、使うテストは root で skip する）。inbox_not_json: JSON でない。
//   inbox_shape: workflow_output_path も timed_out も無い。inbox_batch_id: 中身の batch_id が違う。
//   wf_unreadable: workflow_output_path が存在しないファイルを指す。
export const REJECT_MODES = ['wf_batch_id', 'received', 'set_missing', 'set_extra', 'timed_out', 'late', 'no_submit',
  'wf_shape', 'inbox_unreadable', 'inbox_not_json', 'inbox_shape', 'inbox_batch_id', 'wf_unreadable'];
// submit と同じ手順で受け箱を公開する（一時ファイルに書いてから link するので、書きかけは見えない）
function publishInbox(runDir, batchId, text, mode = 0o644) {
  const inbox = join(runDir, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const tmp = join(inbox, `.tmp-harness-${randomBytes(8).toString('hex')}`);
  writeFileSync(tmp, text);
  chmodSync(tmp, mode);
  linkSync(tmp, join(inbox, `${batchId}.json`));
  unlinkSync(tmp);
}
const LATE_MARGIN_MS = 1000;
export function makeHarness(scenario, hooks = {}) {
  const memory = { byRole: {}, rounds: {}, tasks: [], batches: [], violations: [], partition: null, models: [], rejected: [], authorReturns: [] };
  // Workflow の返り値は、run の workspace の保存先の root（<ws>/.formal-method/。runs/<run_id> の 2 つ上）の下に置く。
  // 呼び手は workspace を消すので tmpdir() の直下に残らず、.formal-method/ は対象の集まりから除かれるので、対象の指紋も変えない
  let wfDir = null;
  async function onAgents(status, opts = {}) {
    if (!wfDir) wfDir = mkdtempSync(join(dirname(dirname(status.run_dir)), '.fm-harness-wf-'));
    const list = readJson(status.batch.tasks_path);
    assert.equal(list.batch_id, status.batch.batch_id);
    memory.batches.push(list);
    const results = [];
    for (const task of list.tasks) {
      memory.tasks.push(task);
      memory.byRole[task.role] = task;
      memory.rounds[task.role] = (memory.rounds[task.role] ?? 0) + 1;
      memory.violations.push(...taskViolations(task, status.run_dir, memory));
      // 観点ごとの失敗（assurance-reviewer は nonformal と assurance の 2 観点を持つので、役でなく観点で選べるようにする）
      const mode = (task.context.perspective && scenario.returnsByPerspective[task.context.perspective]) || scenario.returns[task.role];
      const received = { task_id: task.task_id, prompt: task.prompt, model: task.model, effort: task.effort, output_schema: task.output_schema };
      write(task, 'worklog.json', worklog(task));
      if (mode === 'missing') { results.push({ task_id: task.task_id, status: 'missing', received }); continue; }
      if (mode === 'error') { results.push({ task_id: task.task_id, status: 'error', received, error: 'harness の失敗' }); continue; }
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
      writeFileSync(task.return_path, JSON.stringify(ret, null, 2));
      results.push({ task_id: task.task_id, status: 'returned', received });
    }
    assert.deepEqual(memory.violations, [], 'run-daemon が出した task が契約（task.md の形・役と context）に合う');
    if (hooks.beforeSubmit) await hooks.beforeSubmit(status, list);
    // batch の拒否（cli-contract「受け箱」）を起こす口。返り値は上のとおり全て書いたうえで、受け箱か Workflow の返り値だけを崩す。
    const reject = hooks.reject ? hooks.reject(status, list) : null;
    if (reject) {
      assert.ok(REJECT_MODES.includes(reject), `harness の拒否の型 ${reject}`);
      memory.rejected.push({ mode: reject, list });
    }
    if (reject === 'no_submit') return;
    if (reject === 'late') {
      // 期限（deadline_wall_ms）を過ぎてから公開する。待つ間に run-daemon が期限で batch を閉じても、どちらも batch の拒否である
      while (Date.now() < list.deadline_wall_ms + LATE_MARGIN_MS) await new Promise((r) => setTimeout(r, 100));
    }
    if (reject === 'timed_out') {
      expectOk(await cli('submit', { run_dir: status.run_dir, batch_id: list.batch_id, timed_out: true }, opts), 'submit');
      return;
    }
    const wf = join(wfDir, `${list.batch_id}.json`);
    const inboxModes = {
      // 読めれば受け付ける中身にして、読めないことだけを拒否の原因にする
      inbox_unreadable: () => {
        writeFileSync(wf, JSON.stringify({ batch_id: list.batch_id, results }));
        publishInbox(status.run_dir, list.batch_id, JSON.stringify({ batch_id: list.batch_id, workflow_output_path: wf }), 0o000);
      },
      inbox_not_json: () => publishInbox(status.run_dir, list.batch_id, '{"batch_id": '),
      inbox_shape: () => publishInbox(status.run_dir, list.batch_id, JSON.stringify({ batch_id: list.batch_id })),
      inbox_batch_id: () => {
        writeFileSync(wf, JSON.stringify({ batch_id: list.batch_id, results }));
        publishInbox(status.run_dir, list.batch_id, JSON.stringify({ batch_id: `${list.batch_id}-other`, workflow_output_path: wf }));
      },
      wf_unreadable: () => publishInbox(status.run_dir, list.batch_id, JSON.stringify({ batch_id: list.batch_id, workflow_output_path: join(wfDir, `${list.batch_id}-missing.json`) })),
    };
    if (inboxModes[reject]) { inboxModes[reject](); return; }
    let output = { batch_id: list.batch_id, results };
    if (reject === 'wf_shape') output = { batch_id: list.batch_id, results: 'not-an-array' };
    if (reject === 'wf_batch_id') output = { ...output, batch_id: `${list.batch_id}-other` };
    if (reject === 'received') output = { ...output, results: results.map((r, i) => (i === 0 ? { ...r, received: { ...r.received, effort: `${r.received.effort}-changed` } } : r)) };
    if (reject === 'set_missing') output = { ...output, results: results.slice(1) };
    if (reject === 'set_extra') {
      const extra = { ...results[0], task_id: `${results[0].task_id}-extra`, received: { ...results[0].received, task_id: `${results[0].task_id}-extra` } };
      output = { ...output, results: [...results, extra] };
    }
    writeFileSync(wf, JSON.stringify(output));
    expectOk(await cli('submit', { run_dir: status.run_dir, batch_id: list.batch_id, workflow_output_path: wf }, opts), 'submit');
  }
  return { onAgents, memory };
}
