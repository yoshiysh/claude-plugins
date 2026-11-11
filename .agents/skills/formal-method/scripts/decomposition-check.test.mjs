// 自己検査: T の writer-merge-scc/1 の実装と、停止の段の規則の当て直しが、契約の手順の手計算と一致する（AC-06・AC-19 の照合の道具）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { writerMergeScc, stopStageViolations, deriveGraph, crossingEdges, parseSexprs, symbolsOf } from './test-fixtures/decomposition-check.mjs';

const L = { file: 'attempts/a/model.json', pointer: '' };
const n = (id, kind) => ({ id, kind, location: L });
const e = (from, to, kind) => ({ from, to, kind, location: L });
const NODES = [n('v:a', 'variable'), n('v:b', 'variable'), n('t:ta', 'transition'), n('t:tb', 'transition'), n('p:P1', 'property')];

const CASES = [
  ['書き手の違う 2 組と一方向の読み（2 候補・強さ 1）',
    { nodes: NODES, edges: [e('t:ta', 'v:a', 'write'), e('t:tb', 'v:b', 'write'), e('t:ta', 'v:a', 'read'), e('t:tb', 'v:a', 'read'), e('p:P1', 'v:a', 'property')], unconfirmed: [] },
    [{ id: 'C1', nodes: ['t:ta', 'v:a'], strength_to: [{ candidate_id: 'C2', edges: 1 }] }, { id: 'C2', nodes: ['t:tb', 'v:b'], strength_to: [{ candidate_id: 'C1', edges: 1 }] }]],
  ['相互の読みは強連結で 1 候補',
    { nodes: NODES, edges: [e('t:ta', 'v:a', 'write'), e('t:tb', 'v:b', 'write'), e('t:tb', 'v:a', 'read'), e('t:ta', 'v:b', 'read')], unconfirmed: [] },
    [{ id: 'C1', nodes: ['t:ta', 't:tb', 'v:a', 'v:b'], strength_to: [] }]],
  ['変数・遷移の要素が無ければ候補は無い', { nodes: [n('p:P1', 'property'), n('d:x', 'smt_declaration')], edges: [e('p:P1', 'd:x', 'reference')], unconfirmed: [] }, []],
  ['読みも書きも無い要素は 1 つずつの候補', { nodes: [n('v:b', 'variable'), n('v:a', 'variable')], edges: [], unconfirmed: [] },
    [{ id: 'C1', nodes: ['v:a'], strength_to: [] }, { id: 'C2', nodes: ['v:b'], strength_to: [] }]],
];
for (const [name, graph, expected] of CASES) {
  test(`SP-FORMALMETHOD-008 AC-06 writer-merge-scc/1 の自己検査: ${name}`, () => {
    assert.deepEqual(writerMergeScc(graph), expected);
  });
}

const sr = (stage, reasons) => ({ stop_report: { stage, reasons: reasons.map(([code, st]) => ({ code, stage: st, request_code: null, item: null, field: null, detail: 'x' })) } });
const STAGE_RULE = [
  ['中断の理由が無ければ最も上流の段', sr('実行', [['反例', '実行'], ['必要な性質が検証の成功でない', '集約']]), []],
  ['中断の理由があれば最初の中断の段', sr('計画', [['保存の失敗', '計画'], ['記録の未保存', '集約']]), []],
  ['中断の理由より上流の段があっても中断の段', sr('確認', [['時間の上限', '確認'], ['対応できていない組合せ', 'モデル化']]), []],
  ['担当の失敗は中断の理由でなく、最も上流の段（失敗した task の段）になる', sr('洗い出し', [['担当の失敗', '洗い出し'], ['必要な性質が 0 件', '集約']]), []],
  ['規則に合わない stage を見つける', sr('集約', [['反例', '実行'], ['必要な性質が検証の成功でない', '集約']]), ['stop_report.stage']],
  ['code の表に合わない stage を見つける', sr('確認', [['反例', '確認']]), ['反例 の stage']],
];
for (const [name, r, expected] of STAGE_RULE) {
  test(`SP-FORMALMETHOD-015 AC-19 停止の段の規則の自己検査: ${name}`, () => {
    const vs = stopStageViolations(r);
    assert.equal(vs.length > 0, expected.length > 0, vs.join('; '));
    for (const x of expected) assert.ok(vs.some((v) => v.includes(x)), vs.join('; '));
  });
}

// ---- 依存グラフの導出の規則の自己検査（手で導いた期待値） ----
test('SP-FORMALMETHOD-008 AC-06 依存グラフの導出の規則の自己検査: S 式の form の位置と、束縛・予約語・literal を除いた記号', () => {
  const text = '; c\n(declare-const a Int)\n(assert (let ((k 1)) (forall ((q Int)) (> (+ a k q) #x0F))))\n';
  const forms = parseSexprs(text);
  assert.equal(forms.length, 2);
  assert.equal(text.slice(forms[0].start, forms[0].end), '(declare-const a Int)');
  assert.deepEqual(symbolsOf(forms[1].node), ['a']);
  assert.deepEqual(symbolsOf(parseSexprs('(and (>= a 0) (< b 3) (f c))')[0].node), ['a', 'b', 'f', 'c']);
});

test('SP-FORMALMETHOD-008 AC-06 依存グラフの導出の規則の自己検査: 小さなモデルの要素・辺・location・未確認・並び', () => {
  const q = '(declare-const a Int)\n(define-fun g ((y Int)) Bool (> y a))\n(assert (g a))\n(assert (< z 0))\n(check-sat)\n';
  const model = {
    state_machine: {
      variables: [{ id: 'b', sort: 'Int', domain: '', init: '0' }, { id: 'a', sort: 'Int', domain: '', init: '0' }],
      transitions: [{ id: 't1', from: 's', event: 'e', to: 's', guard: '(and (< a 3) (> u 0))', updates: [{ var: 'b', term: '(+ a 1)' }, { var: 'nope', term: 'b' }], unchanged: [], source_ids: [] }],
    },
    model_id: 'M1',
    properties: [{ id: 'MP1', query_ref: 'attempts/m/q.smt2', sanity: [] }],
  };
  const g = deriveGraph([{ model, ref: 'attempts/m/model.json' }], (ref) => (ref === 'attempts/m/q.smt2' ? q : null));
  const pos = (s) => `form:${['(declare-const a Int)', '(define-fun g ((y Int)) Bool (> y a))', '(assert (g a))', '(assert (< z 0))'].indexOf(s)}:${q.indexOf(s)}-${q.indexOf(s) + s.length}`;
  const M = 'attempts/m/model.json';
  const Q = 'attempts/m/q.smt2';
  assert.deepEqual(g.nodes.map((x) => [x.id, x.kind, x.location.pointer]), [
    ['prop:M1/MP1', 'property', '/properties/0'],
    [`smt:${Q}#a`, 'smt_declaration', pos('(declare-const a Int)')],
    [`smt:${Q}#assert-2`, 'smt_assertion', pos('(assert (g a))')],
    [`smt:${Q}#assert-3`, 'smt_assertion', pos('(assert (< z 0))')],
    [`smt:${Q}#g`, 'smt_definition', pos('(define-fun g ((y Int)) Bool (> y a))')],
    ['tr:M1/t1', 'transition', '/state_machine/transitions/0'],
    ['var:M1/a', 'variable', '/state_machine/variables/1'],
    ['var:M1/b', 'variable', '/state_machine/variables/0'],
  ]);
  assert.deepEqual(g.edges.map((x) => [x.id, x.location.file, x.location.pointer]), [
    ['property:prop:M1/MP1->var:M1/a', Q, pos('(declare-const a Int)')],
    ['read:tr:M1/t1->var:M1/a', M, '/state_machine/transitions/0/guard'],
    ['read:tr:M1/t1->var:M1/b', M, '/state_machine/transitions/0/updates/1/term'],
    [`reference:smt:${Q}#assert-2->smt:${Q}#a`, Q, pos('(assert (g a))')],
    [`reference:smt:${Q}#assert-2->smt:${Q}#g`, Q, pos('(assert (g a))')],
    [`reference:smt:${Q}#g->smt:${Q}#a`, Q, pos('(define-fun g ((y Int)) Bool (> y a))')],
    ['write:tr:M1/t1->var:M1/b', M, '/state_machine/transitions/0/updates/0/var'],
  ]);
  assert.deepEqual(g.unconfirmed.map((x) => x.relation), [`smt:${Q}#assert-3->z`, 'tr:M1/t1->nope', 'tr:M1/t1->u']);
  for (const e of g.edges) assert.equal(e.id, `${e.kind}:${e.from}->${e.to}`);
  const cross = crossingEdges(g, [{ id: 'p1', owns_variables: ['a'], transitions: [] }, { id: 'p2', owns_variables: ['b'], transitions: ['t1'] }], 'M1');
  assert.deepEqual(cross.map((x) => x.id), ['read:tr:M1/t1->var:M1/a']);
});

test('SP-FORMALMETHOD-008 AC-06 依存グラフの導出の規則の自己検査: :named の名前は smt_definition の要素になり、参照しても未確認にならない', () => {
  const q = '(declare-const a Int)\n(assert (! (> a 0) :named pos))\n(assert (=> pos (>= a 0)))\n';
  const model = { model_id: 'M1', state_machine: null, properties: [{ id: 'MP1', query_ref: 'q.smt2', sanity: [] }] };
  const g = deriveGraph([{ model, ref: 'm.json' }], () => q);
  const named = g.nodes.find((n) => n.id === 'smt:q.smt2#pos');
  assert.equal(named.kind, 'smt_definition');
  assert.equal(named.location.pointer, `form:1:${q.indexOf('(assert (!')}-${q.indexOf('(assert (!') + '(assert (! (> a 0) :named pos))'.length}`);
  assert.ok(g.edges.some((e) => e.id === 'reference:smt:q.smt2#assert-2->smt:q.smt2#pos'));
  assert.deepEqual(g.unconfirmed, []);
});

test('SP-FORMALMETHOD-008 AC-06 依存グラフの導出の規則の自己検査: 2 つのモデルは 1 つの graph になり、同じ名前の変数を model_id で分け、property の辺は同じモデルの変数にだけ引く', () => {
  const sm = { variables: [{ id: 'a', sort: 'Int', domain: '', init: '0' }], transitions: [] };
  const files = { 'q1.smt2': '(declare-const a Int)\n(assert (> a 0))\n', 'q2.smt2': '(declare-const a Int)\n(assert (< a 0))\n' };
  const m1 = { model_id: 'M1', state_machine: sm, properties: [{ id: 'X1', query_ref: 'q1.smt2', sanity: [] }] };
  const m2 = { model_id: 'M2', state_machine: sm, properties: [{ id: 'X2', query_ref: 'q2.smt2', sanity: [] }] };
  const g = deriveGraph([{ model: m1, ref: 'm1.json' }, { model: m2, ref: 'm2.json' }], (r) => files[r] ?? null);
  assert.deepEqual(g.nodes.filter((n) => n.kind === 'variable').map((n) => [n.id, n.location.file]), [['var:M1/a', 'm1.json'], ['var:M2/a', 'm2.json']]);
  assert.deepEqual(g.edges.filter((e) => e.kind === 'property').map((e) => e.id), ['property:prop:M1/X1->var:M1/a', 'property:prop:M2/X2->var:M2/a']);
});
