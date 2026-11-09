// 状態遷移を持ち、書き手の違う 2 組（a と b）に分けられるモデル SM2 と、その分割（部分・境界・部分の契約・合成の条件）。
// 分割作成役の代わりに agent-harness.mjs の scenario.partition に渡す（artifact-formats「partitions（分割作成役）」の形）。
export const SM2 = {
  states: ['s0'], events: ['ea', 'eb'], initial: 's0',
  variables: [{ id: 'a', sort: 'Int', domain: '0..3', init: '0' }, { id: 'b', sort: 'Int', domain: '0..3', init: '0' }],
  transitions: [
    { id: 'ta', from: 's0', event: 'ea', to: 's0', guard: '(< a 3)', updates: [{ var: 'a', term: '(+ a 1)' }], unchanged: ['b'], source_ids: ['E-P1'] },
    { id: 'tb', from: 's0', event: 'eb', to: 's0', guard: '(and (>= a 0) (< b 3))', updates: [{ var: 'b', term: '(+ b 1)' }], unchanged: ['a'], source_ids: ['E-P1'] },
  ],
  forbidden: [], uncovered: [], goals: [],
};
export const SM2_SMT = '(declare-const a Int)\n(declare-const b Int)\n(assert (and (>= a 0) (>= b 0)))\n(assert (not (>= (+ a b) 0)))';
export const SM2_PROPS = [{ id: 'P1', file: 'spec.md', line: 2, statement: 'a と b の和は 0 以上', query: { result: 'unsat' }, sanity: { result: 'sat' }, mutation: { result: 'sat' }, smt: SM2_SMT }];

// 部分を跨ぐ辺ごとに境界を 1 つ置き、その前提を 確認できない前提 にする（edge_id は規則の辺の id）。
// parts の要素は graph の要素の id で書き、1 つの部分は 1 つのモデル（model_id）に属する
export const PARTS = [{ id: 'part-a', model_id: 'M1', owns_variables: ['var:M1/a'], transitions: ['tr:M1/ta'] }, { id: 'part-b', model_id: 'M1', owns_variables: ['var:M1/b'], transitions: ['tr:M1/tb'] }];
// 契約と合成の条件の query。注釈の印（; contract K-a など）で偽の z3 の呼出しを見分ける
export const partQuery = (label, d = {}) => `${Object.entries({ result: 'unsat', ...d }).map(([k, v]) => `; fake-${k}: ${v}`).join('\n')}\n; ${label}\n(declare-const a Int)\n(assert (< a 0))\n(check-sat)\n`;
// basis: 'unconfirmed'（確認できない前提）| 'guarantee'（他の部分の保証 K-a）。conds: 合成の条件（CC1 は K-a に依る、CC2 は契約に依らない）
// derivedFrom: 契約と合成の条件の derived_from（巡の番号の関数も可）
export const partitionFixture = ({ basis = 'unconfirmed', conds = ['CC1'], derivedFrom = 'P1', contract = {}, cond = {} } = {}) => (_cands, put, { crossing, round }) => {
  const from = typeof derivedFrom === 'function' ? derivedFrom(round) : derivedFrom;
  return {
    parts: PARTS,
    boundaries: crossing(PARTS, 'M1').map((e) => ({
      edge_id: e.id, producer: 'part-a', consumer: 'part-b', shared_symbols: [e.to.replace(/^var:M1\//, '')], assumption: 'a は 0 以上', guarantee: 'a は 0 以上',
      assumption_basis: basis === 'guarantee' ? { kind: '他の部分の保証', contract_id: 'K-a' } : { kind: '確認できない前提', reason: '環境が a を 0 以上に保つという前提が依頼に無い' },
      responsible: ['K-a'],
    })),
    contracts: [{ id: 'K-a', model_id: 'M1', derived_from: from, part_id: 'part-a', statement: 'a は 0 以上', query_ref: put('K-a.smt2', partQuery('contract K-a', contract)) }],
    composition_conditions: conds.map((id) => ({ id, model_id: 'M1', derived_from: from, statement: id === 'CC1' ? 'K-a ならば P1' : 'a と b の和は 0 以上（契約に依らない）',
      query_ref: put(`${id}.smt2`, partQuery(`composition ${id}`, cond[id] ?? {})), depends_on: id === 'CC1' ? ['K-a'] : [] })),
  };
};
