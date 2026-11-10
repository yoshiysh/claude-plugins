// 分割の照合（architecture.md「依存グラフと合成」、artifact-formats.md「分割と合成」）: 全ての候補への判断、跨ぐ辺ごとの境界、
// 前提の出どころ、known_requirement の実在、前提の循環、derived_from が同じ model_id のモデルの性質を指すこと、分割前後の対応。
import { PartitionsFile, validate } from '../schemas.mjs';
import { smtViolations } from '../adapters/z3.mjs';
import { defect, readRunText } from './common.mjs';

const asId = (prefix, modelId, x) => (x.startsWith(`${prefix}:`) ? x : `${prefix}:${modelId}/${x}`);

export function ownerMap(parts) {
  const owner = new Map();
  for (const p of parts) {
    for (const v of p.owns_variables) owner.set(asId('var', p.model_id, v), p.id);
    for (const t of p.transitions) owner.set(asId('tr', p.model_id, t), p.id);
  }
  return owner;
}

export function crossingEdges(graph, parts) {
  const owner = ownerMap(parts);
  return graph.edges.filter((e) => owner.has(e.from) && owner.has(e.to) && owner.get(e.from) !== owner.get(e.to));
}

// 分割前の変数・遷移の要素は、対応・対応なし・除外のちょうど 1 つに入る。
export function correspondence(graph, parts) {
  const owner = ownerMap(parts);
  const matched = [];
  const unmatched = [];
  for (const n of graph.nodes) {
    if (n.kind !== 'variable' && n.kind !== 'transition') continue;
    if (owner.has(n.id)) matched.push({ element: n.id, to: [owner.get(n.id)] });
    else unmatched.push(n.id);
  }
  return { matched, unmatched, excluded: [] };
}

export function partitionCheck(runDir, data, { candidates, graph, models, prefix, knownRequirementIds }) {
  const errs = validate(PartitionsFile, data);
  if (errs.length) return { defects: [defect('syntax', 'partitions-shape', `partitions の形が違う: ${errs.slice(0, 3).join('; ')}`)], smtBad: new Map(), valid: false };
  const out = [];
  const smtBad = new Map();
  const candIds = candidates.map((c) => c.id);
  const decided = data.decisions.map((d) => d.candidate_id);
  for (const id of candIds) if (decided.filter((x) => x === id).length !== 1) out.push(defect('other', `decision:${id}`, `候補 ${id} の判断がちょうど 1 つでない`));
  for (const id of decided) if (!candIds.includes(id)) out.push(defect('reference', `decision-unknown:${id}`, `判断が候補に無い ${id} を指す`));
  if (!data.adopted) return { defects: out, smtBad, valid: true };
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const modelProps = new Map(models.map((m) => [m.id, new Set(m.data.properties.map((p) => p.id))]));
  const partIds = new Set();
  const ownedBy = new Map();
  for (const p of data.parts) {
    if (partIds.has(p.id)) out.push(defect('other', `part-dup:${p.id}`, `部分の id ${p.id} が重なる`));
    partIds.add(p.id);
    if (!modelProps.has(p.model_id)) out.push(defect('reference', `part-model:${p.id}`, `部分 ${p.id} の model_id ${p.model_id} のモデルが無い`));
    const elements = [...p.owns_variables.map((v) => ['var', v]), ...p.transitions.map((t) => ['tr', t])];
    for (const [prefix, x] of elements) {
      const id = asId(prefix, p.model_id, x);
      const what = prefix === 'var' ? '変数' : '遷移';
      if (!nodeIds.has(id)) out.push(defect('reference', `part-${prefix}:${p.id}:${x}`, `部分 ${p.id} の${what} ${x} が graph に無い`));
      // 1 つの部分の要素は全て model_id のモデルのもの（完全な id は <prefix>:<model_id>/<名前>）
      if (!id.startsWith(`${prefix}:${p.model_id}/`)) out.push(defect('reference', `part-foreign:${p.id}:${x}`, `部分 ${p.id} の${what} ${x} が model_id ${p.model_id} のモデルの要素でない`));
      // 同じ要素を 2 つの部分が持たない
      if (ownedBy.has(id) && ownedBy.get(id) !== p.id) out.push(defect('other', `part-overlap:${id}`, `${what} ${id} を部分 ${ownedBy.get(id)} と ${p.id} が持つ`));
      else ownedBy.set(id, p.id);
    }
  }
  const contractIds = new Set(data.contracts.map((k) => k.id));
  const crossing = crossingEdges(graph, data.parts).map((e) => e.id);
  const bounded = data.boundaries.map((b) => b.edge_id);
  for (const id of crossing) if (!bounded.includes(id)) out.push(defect('other', `boundary-missing:${id}`, `部分を跨ぐ辺 ${id} に境界が無い`));
  for (const b of data.boundaries) {
    if (!crossing.includes(b.edge_id)) out.push(defect('reference', `boundary-edge:${b.edge_id}`, `境界の edge_id ${b.edge_id} が部分を跨ぐ辺でない`));
    if (!partIds.has(b.producer) || !partIds.has(b.consumer)) out.push(defect('reference', `boundary-part:${b.edge_id}`, `境界 ${b.edge_id} の producer・consumer が部分に無い`));
    const basis = b.assumption_basis;
    if (basis.kind === '他の部分の保証' && !contractIds.has(basis.contract_id)) out.push(defect('reference', `basis-contract:${b.edge_id}`, `境界 ${b.edge_id} の前提の出どころの契約 ${basis.contract_id} が無い`));
    if (basis.kind === '依頼の要求・制約' && !knownRequirementIds.has(basis.known_requirement_id)) out.push(defect('reference', `basis-known:${b.edge_id}`, `境界 ${b.edge_id} の known_requirement ${basis.known_requirement_id} が依頼に無い`));
    // 分割の照合の境界（artifact-formats.md「分割の照合の境界」）: 保証を確かめる責任は、保証する側（producer）の部分の契約が負う
    for (const r of b.responsible) {
      const k = data.contracts.find((x) => x.id === r);
      if (!k) out.push(defect('reference', `responsible:${b.edge_id}:${r}`, `境界 ${b.edge_id} の responsible ${r} が同じ分割の契約に無い`));
      else if (k.part_id !== b.producer) out.push(defect('reference', `responsible-part:${b.edge_id}:${r}`, `境界 ${b.edge_id} の responsible の契約 ${r} の part_id ${k.part_id} が producer ${b.producer} と違う`));
    }
    // 共同不変条件は、今の版では検査の作り手と id を決める経路が無いので受け付けない
    if (basis.kind === '共同不変条件') out.push(defect('other', `basis-joint:${b.edge_id}`, `境界 ${b.edge_id} の前提の出どころが 共同不変条件（今の版では受け付けない）`));
  }
  const queryOf = (x, kind) => {
    if (!x.query_ref.startsWith(prefix)) { out.push(defect('reference', `${kind}-ref:${x.id}`, `${x.id} の query ${x.query_ref} が attempt の領域の外`, { element: x.id })); return; }
    const text = readRunText(runDir, x.query_ref);
    if (text === null) { out.push(defect('reference', `${kind}-query:${x.id}`, `${x.id} の query ${x.query_ref} が無い`, { element: x.id })); smtBad.set(x.query_ref, ['ファイルが無い']); return; }
    const v = smtViolations(text);
    if (v.length) { smtBad.set(x.query_ref, v); for (const s of v) out.push(defect('syntax', `smt:${x.query_ref}:${s}`, `${x.query_ref}: ${s}`, { element: x.id })); }
  };
  for (const k of data.contracts) {
    if (!partIds.has(k.part_id)) out.push(defect('reference', `contract-part:${k.id}`, `契約 ${k.id} の部分 ${k.part_id} が無い`));
    const part = data.parts.find((p) => p.id === k.part_id);
    if (part && part.model_id !== k.model_id) out.push(defect('reference', `contract-model:${k.id}`, `契約 ${k.id} の model_id が部分と違う`));
    if (!(modelProps.get(k.model_id)?.has(k.derived_from))) out.push(defect('reference', `contract-derived:${k.id}`, `契約 ${k.id} の derived_from ${k.derived_from} が ${k.model_id} のモデルの性質でない`));
    queryOf(k, 'contract');
  }
  for (const c of data.composition_conditions) {
    if (!(modelProps.get(c.model_id)?.has(c.derived_from))) out.push(defect('reference', `cond-derived:${c.id}`, `合成の条件 ${c.id} の derived_from ${c.derived_from} が ${c.model_id} のモデルの性質でない`));
    for (const d of c.depends_on) {
      const k = data.contracts.find((x) => x.id === d);
      if (!k) out.push(defect('reference', `cond-dep:${c.id}:${d}`, `合成の条件 ${c.id} の depends_on ${d} が契約に無い`));
      else if (k.model_id !== c.model_id) out.push(defect('reference', `cond-dep-model:${c.id}:${d}`, `合成の条件 ${c.id} の契約 ${d} が別のモデル`));
    }
    queryOf(c, 'cond');
  }
  // 前提の循環（他の部分の保証の辺で、契約の部分から部分へ）
  const dep = new Map();
  for (const b of data.boundaries) {
    if (b.assumption_basis.kind !== '他の部分の保証') continue;
    const k = data.contracts.find((x) => x.id === b.assumption_basis.contract_id);
    if (!k) continue;
    if (!dep.has(b.consumer)) dep.set(b.consumer, new Set());
    dep.get(b.consumer).add(k.part_id);
  }
  const visiting = new Set();
  const done = new Set();
  const cyclic = (p) => {
    if (done.has(p)) return false;
    if (visiting.has(p)) return true;
    visiting.add(p);
    for (const q of dep.get(p) ?? []) if (cyclic(q)) return true;
    visiting.delete(p);
    done.add(p);
    return false;
  };
  for (const p of dep.keys()) if (cyclic(p)) { out.push(defect('other', 'assumption-cycle', '前提の出どころが循環する')); break; }
  return { defects: out, smtBad, valid: true };
}
