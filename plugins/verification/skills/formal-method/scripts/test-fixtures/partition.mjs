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
// parts の要素は graph の要素の id で書き、1 つの部分は 1 つのモデル（model_id）に属する。
// model_id は CLI が決める（#264 SP-264-011）ので、候補の節点から引く。部分の id は候補の id（partition-assemble が候補の id を部分の id にする。SP-264-023）
const MODEL_OF = (cands) => cands.flatMap((c) => c.nodes).map((n) => n.match(/^(?:var|tr):([^/]+)\//)?.[1]).find(Boolean) ?? 'M1';
export const partsOf = (cands, mid = MODEL_OF(cands)) => {
  const of = (node) => cands.find((c) => c.nodes.includes(node))?.id ?? (node.includes('/a') || node.includes('/ta') ? 'part-a' : 'part-b');
  return [
    { id: of(`var:${mid}/a`), model_id: mid, owns_variables: [`var:${mid}/a`], transitions: [`tr:${mid}/ta`] },
    { id: of(`var:${mid}/b`), model_id: mid, owns_variables: [`var:${mid}/b`], transitions: [`tr:${mid}/tb`] },
  ];
};
// 候補が渡らない場面の既定（今のテストの読み手のため。M1 の部分 part-a・part-b）
export const PARTS = partsOf([], 'M1');
// 契約と合成の条件の query。注釈の印（; contract K-a など）で偽の z3 の呼出しを見分ける
export const partQuery = (label, d = {}) => `${Object.entries({ result: 'unsat', ...d }).map(([k, v]) => `; fake-${k}: ${v}`).join('\n')}\n; ${label}\n(declare-const a Int)\n(assert (< a 0))\n(check-sat)\n`;
// basis: 'unconfirmed'（確認できない前提）| 'guarantee'（他の部分の保証 K-a）。conds: 合成の条件（CC1 は K-a に依る、CC2 は契約に依らない）
// derivedFrom: 契約と合成の条件の derived_from の inventory の性質の id（巡の番号の関数も可）。harness の ctx.mp でモデルの性質の id にする
// （モデルの性質の id は <model_id>. で始まる。SP-264-012）。'MP-' で始まる値はモデルの性質の接頭辞つきの inventory の性質として扱う
export const partitionFixture = ({ basis = 'unconfirmed', conds = ['CC1'], derivedFrom = 'P1', contract = {}, cond = {} } = {}) => (cands, put, { crossing, round, modelId, mp = (x) => x } = {}) => {
  const mid = modelId ?? MODEL_OF(cands ?? []);
  const parts = partsOf(cands ?? [], mid);
  const [pa, pb] = parts.map((x) => x.id);
  const raw = typeof derivedFrom === 'function' ? derivedFrom(round) : derivedFrom;
  // モデルに無い性質（巡ごとに違えるケース）は、モデルの性質の id に直せないのでそのまま書く
  const pid = raw.replace(/^MP-/, '');
  const from = mp(pid) !== pid ? mp(pid) : raw;
  return {
    parts,
    boundaries: crossing(parts, mid).map((e) => ({
      edge_id: e.id, producer: pa, consumer: pb, shared_symbols: [e.to.replace(/^var:[^/]+\//, '')], assumption: 'a は 0 以上', guarantee: 'a は 0 以上',
      assumption_basis: basis === 'guarantee' ? { kind: '他の部分の保証', contract_id: 'K-a' } : { kind: '確認できない前提', reason: '環境が a を 0 以上に保つという前提が依頼に無い' },
      responsible: ['K-a'],
    })),
    contracts: [{ id: 'K-a', model_id: mid, derived_from: from, part_id: pa, statement: 'a は 0 以上', query_ref: put('K-a.smt2', partQuery('contract K-a', contract)) }],
    composition_conditions: conds.map((id) => ({ id, model_id: mid, derived_from: from, statement: id === 'CC1' ? 'K-a ならば P1' : 'a と b の和は 0 以上（契約に依らない）',
      query_ref: put(`${id}.smt2`, partQuery(`composition ${id}`, cond[id] ?? {})), depends_on: id === 'CC1' ? ['K-a'] : [] })),
  };
};
