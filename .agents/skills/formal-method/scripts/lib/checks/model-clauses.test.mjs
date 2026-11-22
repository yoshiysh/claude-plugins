// unit: モデル化の照合の節の印（artifact-formats.md「model」の clauses と :named の規則）と、静的な確認の query の切り取り（ablate）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelCheck } from './model.mjs';
import { ablate, clauseShapeProblem, namedTerms, sharedDefinitions } from './ablation.mjs';

const PREFIX = 'attempts/t1/';
const QUERY = '(declare-const x Int)\n(declare-const y Int)\n(assert (! (>= x 0) :named R1))\n(assert (! (>= y 0) :named A1))\n(assert (! (not (>= (+ x y) 0)) :named G1))\n(check-sat)\n';
const CLAUSES = [
  { name: 'R1', role: 'rule', source_ids: ['E1'], basis: null, external_dependency_id: null, note: '出所の規則' },
  { name: 'A1', role: 'premise', source_ids: [], basis: '作成役の仮定', external_dependency_id: null, note: '前提' },
  { name: 'G1', role: 'goal', source_ids: ['E1'], basis: null, external_dependency_id: null, note: '性質の否定' },
];

function model({ clauses = CLAUSES, scopeVariables = ['x'] } = {}) {
  return {
    schema: 'formal-method.model/2', model_id: 'M1', adapter_id: 'z3',
    covers: { targets: ['T1'], states: [], events: [], assumptions: [], constraints: [], excluded: [] },
    state_machine: null, no_state_machine_reason: '状態遷移を持たない', io_contracts: [],
    properties: [{ id: 'P1', inventory_property_ids: ['P1'], query_ref: `${PREFIX}P1.smt2`, expected: 'unsat',
      assurance: { kind: '範囲を限った検査', scope: 'x と y', bounds: [{ item: 'x', bound: '0..' }], scope_variables: scopeVariables, fairness_assumptions: [] },
      clauses, sanity: [] }],
    behavior: { applicable: false, reason: '状態遷移を持たない' }, source_diagrams: [], omitted_edges: [],
  };
}

function check(t, { query = QUERY, ...over } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fm-clauses-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, PREFIX), { recursive: true });
  writeFileSync(join(dir, PREFIX, 'model.json'), JSON.stringify(model(over)));
  writeFileSync(join(dir, PREFIX, 'mapping.json'), JSON.stringify({ schema: 'formal-method.mapping/1', model_id: 'M1', rows: [] }));
  writeFileSync(join(dir, PREFIX, 'P1.smt2'), query);
  const refs = { elementIds: new Set(['E1']), propertyIds: new Set(['P1']), goalIds: new Set(), knownRequirementIds: new Set(), targetIds: new Set(['T1']), externalDependencyIds: new Set(['X1']) };
  const outputs = [{ kind: 'model', ref: `${PREFIX}model.json` }, { kind: 'mapping', ref: `${PREFIX}mapping.json` }];
  return modelCheck(dir, outputs, { prefix: PREFIX, eligible: new Set(['P1']), refs }).defects;
}
const keys = (defects) => defects.map((d) => `${d.kind} ${d.key}`);
const has = (defects, kind, keyPart) => assert.ok(defects.some((d) => d.kind === kind && d.key.includes(keyPart)), `${kind} ${keyPart}: ${keys(defects).join(' / ')}`);

test('SP-FORMALMETHOD-012 AC-22: 全ての assert が :named を持ち、名前の集合が節と一致するモデルには、節の印の欠陥が無い', (t) => {
  assert.deepEqual(keys(check(t)), []);
});

test('SP-FORMALMETHOD-012 AC-22: :named の無いトップレベルの assert は syntax、節の無い名前と assert の無い節は reference の欠陥', (t) => {
  const unnamed = QUERY.replace('(assert (! (>= y 0) :named A1))', '(assert (>= y 0))');
  const d = check(t, { query: unnamed });
  has(d, 'syntax', 'assert-unnamed:1');
  has(d, 'reference', 'clause-assert:A1');
  const extra = QUERY.replace('(check-sat)', '(assert (! (< x 9) :named R2))\n(check-sat)');
  has(check(t, { query: extra }), 'reference', 'assert-clause:R2');
});

test('SP-FORMALMETHOD-012 AC-22: 節の名前の重なりは other、query の assert の名前の重なりは syntax の欠陥', (t) => {
  has(check(t, { clauses: [...CLAUSES, { ...CLAUSES[0] }] }), 'other', 'clause-dup:R1');
  const dupQuery = QUERY.replace(':named A1', ':named R1');
  has(check(t, { query: dupQuery, clauses: CLAUSES.filter((c) => c.name !== 'A1') }), 'syntax', 'assert-dup:R1');
});

test('SP-FORMALMETHOD-012 AC-22: 出所の無い規則は syntax、inventory に無い出所は reference、性質の否定が無ければ syntax の欠陥（受理されても検証の成功にならない）', (t) => {
  const noSource = CLAUSES.map((c) => (c.name === 'R1' ? { ...c, source_ids: [] } : c));
  has(check(t, { clauses: noSource }), 'syntax', 'clause-rule-source:R1');
  const unknown = CLAUSES.map((c) => (c.name === 'R1' ? { ...c, source_ids: ['E9'] } : c));
  has(check(t, { clauses: unknown }), 'reference', 'clause-source:R1:E9');
  const noGoal = CLAUSES.map((c) => (c.name === 'G1' ? { ...c, role: 'rule' } : c));
  has(check(t, { clauses: noGoal }), 'syntax', 'clause-goal');
});

test('SP-FORMALMETHOD-012 AC-22: basis の無い前提と、外部の依存の id の有無が basis と合わない節は syntax、知らない外部の依存は reference の欠陥', (t) => {
  const noBasis = CLAUSES.map((c) => (c.name === 'A1' ? { ...c, basis: null } : c));
  has(check(t, { clauses: noBasis }), 'syntax', 'clause-premise-basis:A1');
  const noId = CLAUSES.map((c) => (c.name === 'A1' ? { ...c, basis: '外部の依存' } : c));
  has(check(t, { clauses: noId }), 'syntax', 'clause-external:A1');
  const strayId = CLAUSES.map((c) => (c.name === 'A1' ? { ...c, external_dependency_id: 'X1' } : c));
  has(check(t, { clauses: strayId }), 'syntax', 'clause-external:A1');
  const unknownDep = CLAUSES.map((c) => (c.name === 'A1' ? { ...c, basis: '外部の依存', external_dependency_id: 'X9' } : c));
  has(check(t, { clauses: unknownDep }), 'reference', 'clause-external-ref:A1');
  const knownDep = CLAUSES.map((c) => (c.name === 'A1' ? { ...c, basis: '外部の依存', external_dependency_id: 'X1' } : c));
  assert.deepEqual(keys(check(t, { clauses: knownDep })), []);
});

test('SP-FORMALMETHOD-005 SP-FORMALMETHOD-012 AC-22: 範囲として扱う変数が query で宣言されていなければ reference の欠陥', (t) => {
  has(check(t, { scopeVariables: ['x', 'z'] }), 'reference', 'scope-variable:z');
  assert.deepEqual(keys(check(t, { scopeVariables: [] })), []);
});

test('SP-FORMALMETHOD-012 AC-22: 古い形 model/1 と clauses の無いモデルは形の違い（syntax）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fm-clauses-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, PREFIX), { recursive: true });
  const old = model();
  old.schema = 'formal-method.model/1';
  delete old.properties[0].clauses;
  writeFileSync(join(dir, PREFIX, 'model.json'), JSON.stringify(old));
  const d = modelCheck(dir, [{ kind: 'model', ref: `${PREFIX}model.json` }], { prefix: PREFIX, eligible: new Set(['P1']) }).defects;
  has(d, 'syntax', 'shape:');
});

test('SP-FORMALMETHOD-012: ablate は残さない assert だけを切り取り、宣言・(check-sat)・残す assert のバイト列を変えない', () => {
  const goalOnly = ablate(QUERY, ['G1']);
  assert.equal(goalOnly, '(declare-const x Int)\n(declare-const y Int)\n\n\n(assert (! (not (>= (+ x y) 0)) :named G1))\n(check-sat)\n');
  assert.deepEqual([...namedTerms(goalOnly).keys()], ['G1']);
  assert.equal(ablate(QUERY, ['R1', 'A1', 'G1']), QUERY);
  const withDef = '(define-fun f ((a Int)) Bool (> a 0))\n(assert (! (f 1) :named R1))\n(assert (! (not true) :named G1))\n(check-sat)\n';
  assert.equal(ablate(withDef, ['G1']), '(define-fun f ((a Int)) Bool (> a 0))\n\n(assert (! (not true) :named G1))\n(check-sat)\n');
  assert.equal(ablate('(assert (', ['G1']), null);
});

test('SP-FORMALMETHOD-012: 検査の入力の名前が節と合わなければ、静的な確認の入力の形の問題として理由を返す', () => {
  assert.equal(clauseShapeProblem(QUERY, CLAUSES), null);
  assert.match(clauseShapeProblem(QUERY.replace('(assert (! (>= y 0) :named A1))', '(assert (>= y 0))'), CLAUSES), /:named の無い/);
  assert.match(clauseShapeProblem(QUERY, CLAUSES.filter((c) => c.name !== 'A1')), /一致しない/);
});

test('SP-FORMALMETHOD-012 AC-22: 性質の否定の節が無い性質は、静的な確認の道具の実行を組み立てない（空の否定で成り立つにしない）', () => {
  const noGoal = CLAUSES.map((c) => (c.name === 'G1' ? { ...c, role: 'rule' } : c));
  assert.match(clauseShapeProblem(QUERY, noGoal), /性質の否定（role goal）が無い/);
});

// define-fun の本体の制約は ablate で外れない。役の違う節が、宣言した記号を本体に含む define-fun を共有すれば、節を役ごとに切り取れない
const DEFS = '(declare-const x Int)\n(declare-const y Int)\n(define-fun c () Int 3)\n(define-fun ok ((a Int)) Bool (> a c))\n(define-fun pre () Bool (and (>= y 0) (< x 9)))\n(define-fun pre2 () Bool pre)\n';
const defQuery = (r, a, g) => `${DEFS}(assert (! ${r} :named R1))\n(assert (! ${a} :named A1))\n(assert (! ${g} :named G1))\n(check-sat)\n`;
test('SP-FORMALMETHOD-012 AC-22: 宣言した記号を本体に含む define-fun を役の違う節が（他の define-fun を通しても）参照すれば、静的な確認を組み立てず、モデル化の照合の欠陥にする', (t) => {
  const shared = defQuery('(ok x)', 'pre2', '(not (=> pre (ok x)))');
  assert.deepEqual(sharedDefinitions(shared, CLAUSES), [{ name: 'pre', roles: ['goal', 'premise'] }]);
  assert.match(clauseShapeProblem(shared, CLAUSES), /define-fun（pre: goal・premise）を役の違う節が参照する/);
  has(check(t, { query: shared }), 'other', 'clause-shared-definition:pre');
  // 宣言した記号を含まない本体（定数 c・引数だけの関数 ok）は、役の違う節が共有しても切り取りを妨げない
  const own = defQuery('(ok x)', 'pre2', '(not (ok x))');
  assert.deepEqual(sharedDefinitions(own, CLAUSES), []);
  assert.equal(clauseShapeProblem(own, CLAUSES), null);
  assert.ok(!check(t, { query: own }).some((d) => d.key.startsWith('clause-shared-definition')));
});

test('SP-FORMALMETHOD-012 AC-22: define-fun-rec・define-funs-rec の本体も、宣言した記号を含み役の違う節が参照すれば共有の定義として数える（z3 5.3.3 は 2 つとも受け付ける）', () => {
  const head = '(declare-const x Int)\n(define-fun-rec f ((n Int)) Bool (ite (<= n 0) (> x 0) (f (- n 1))))\n'
    + '(define-funs-rec ((g ((n Int)) Bool) (h ((n Int)) Bool)) ((ite (= n 0) (< x 9) (h (- n 1))) (ite (= n 0) false (g (- n 1)))))\n';
  const q = (r, a, gl) => `${head}(assert (! ${r} :named R1))\n(assert (! ${a} :named A1))\n(assert (! ${gl} :named G1))\n(check-sat)\n`;
  assert.deepEqual(sharedDefinitions(q('(f 2)', '(>= x 0)', '(not (f 1))'), CLAUSES), [{ name: 'f', roles: ['goal', 'rule'] }]);
  assert.deepEqual(sharedDefinitions(q('(g 2)', '(h 1)', '(not (>= x 0))'), CLAUSES).map((d) => d.name).sort(), ['g', 'h'], '相互再帰は互いを通して両方の役に届く');
  assert.deepEqual(sharedDefinitions(q('(f 2)', '(g 1)', '(not (>= x 0))'), CLAUSES), [], '1 つの役だけが参照する定義は数えない');
});
