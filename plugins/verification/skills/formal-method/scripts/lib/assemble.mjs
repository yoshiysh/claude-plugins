// 担当の下書きと実行体 formal-method-core の骨組みから、今の型のファイルを組み立てる純粋な関数（#264。spec §2.4 の冒頭）。
// ファイルの読み書きはしない。欠陥の key は今の照合の key の形に合わせ、修正の巡（REVISE_ROUNDS_MAX）に乗せる。
import { defect } from './checks/common.mjs';

// 対応表（SP-264-025）。draft は MappingDraft（形を照らした後）、skeleton は mapping-rows の出力、
// ctx は { model_id（context.model_id）, property_ids（そのモデルの性質。extra_rows の property_id の照合） }。
// 戻り値 { mapping: MappingFile, defects }。欠陥の行は組み立てに入れない（行の欠けは modelCheck の落としの照合にも当たる）
export function assembleMapping(draft, skeleton, { model_id, property_ids }) {
  const defects = [];
  const byRow = new Map();
  for (const r of draft.rows) {
    if (byRow.has(r.row_id)) { defects.push(defect('reference', `map-row-dup:${r.row_id}`, `対応表の下書きの rows に row_id ${r.row_id} が重なる`)); continue; }
    byRow.set(r.row_id, r);
  }
  const known = new Set(skeleton.rows.map((r) => r.row_id));
  for (const id of byRow.keys()) {
    if (!known.has(id)) defects.push(defect('reference', `map-row-unknown:${id}`, `対応表の下書きの rows の row_id ${id} が骨組み（mapping-rows）の行に無い`));
  }
  const rows = [];
  for (const s of skeleton.rows) {
    const d = byRow.get(s.row_id);
    if (!d) { defects.push(defect('reference', `map-row-missing:${s.row_id}`, `骨組みの行 ${s.row_id}（性質 ${s.property_id} の出所）の書き込みが対応表の下書きの rows に無い`)); continue; }
    // 骨組みが関係を決めた行（形式化できない性質）は骨組みの関係と理由を使う。他は作成役の関係と理由
    const fixed = s.relation !== null;
    if (!fixed && d.relation === undefined) { defects.push(defect('reference', `map-row-relation:${s.row_id}`, `形式化できる性質の行 ${s.row_id} に relation が無い`)); continue; }
    rows.push({ source: s.source, property_id: s.property_id, model_element: d.model_element, relation: fixed ? s.relation : d.relation, reason: fixed ? s.reason : d.reason });
  }
  const props = new Set(property_ids);
  for (const [i, x] of draft.extra_rows.entries()) {
    if (x.source.kind === 'location') { defects.push(defect('reference', `map-extra-location:${i}`, `対応表の下書きの extra_rows の行 ${i} の出所が location（location の行は骨組みが決める）`)); continue; }
    if (!props.has(x.property_id)) { defects.push(defect('reference', `map-extra-property:${i}:${x.property_id}`, `対応表の下書きの extra_rows の行 ${i} の property_id ${x.property_id} がモデル ${model_id} の性質に無い`)); continue; }
    rows.push({ source: x.source, property_id: x.property_id, model_element: x.model_element, relation: x.relation, reason: x.reason });
  }
  return { mapping: { schema: 'formal-method.mapping/1', model_id, rows }, defects };
}

// 分割作成役の task の候補（SP-264-023）: 今の id・nodes に、他の候補への辺を足す。辺は from が to に依る向きで、producer は to の節点の候補、
// consumer は from の節点の候補、共有する記号は to の節点の / の後の名前（partition-assemble の境界と同じ定め）。辺は両端の候補のどちらにも載せ、
// to_candidate はその候補から見た他方の候補。採った 2 つの候補の間の辺だけが境界になる
export function candidatesWithEdges(candidates, graphEdges) {
  const ownerOf = new Map();
  for (const c of candidates) for (const n of c.nodes) ownerOf.set(n, c.id);
  const edges = new Map(candidates.map((c) => [c.id, []]));
  for (const e of graphEdges) {
    const consumer = ownerOf.get(e.from);
    const producer = ownerOf.get(e.to);
    if (!consumer || !producer || consumer === producer) continue;
    const base = { edge_id: e.id, producer_candidate: producer, consumer_candidate: consumer, shared_symbols: [e.to.slice(e.to.indexOf('/') + 1)] };
    edges.get(consumer).push({ ...base, to_candidate: producer });
    edges.get(producer).push({ ...base, to_candidate: consumer });
  }
  return candidates.map((c) => ({ id: c.id, nodes: c.nodes, edges: edges.get(c.id) }));
}

// 分割（SP-264-023）。draft は PartitionsDraft（形を照らした後）、out は partition-assemble の出力。戻り値 { partitions: PartitionsFile, defects }。
// 下書きの境界の欠けは今の boundary-missing、跨がない辺を指す要素は boundary-edge と同じ欠陥にする（採らない分割では境界を照らさない。partitionCheck と同じ）
export function assemblePartitions(draft, out) {
  const defects = [];
  if (out.adopted) {
    for (const id of out.missing_boundaries) defects.push(defect('other', `boundary-missing:${id}`, `部分を跨ぐ辺 ${id} に境界が無い`));
    for (const id of new Set(out.extra_boundaries)) defects.push(defect('reference', `boundary-edge:${id}`, `境界の edge_id ${id} が部分を跨ぐ辺でない`));
    const seen = new Set();
    for (const b of draft.boundaries) {
      if (seen.has(b.edge_id)) defects.push(defect('other', `boundary-dup:${b.edge_id}`, `分割の下書きの境界に edge_id ${b.edge_id} が重なる`));
      seen.add(b.edge_id);
    }
  }
  const partitions = {
    schema: 'formal-method.partitions/1', decisions: draft.decisions, adopted: out.adopted, reason: draft.reason,
    parts: out.parts, boundaries: out.boundaries, contracts: draft.contracts, composition_conditions: draft.composition_conditions,
  };
  return { partitions, defects };
}

// 性質の selection の要素（今の planCheck と同じ定め。checks/plan.mjs）: property_id ごとにちょうど 1 つの要素ならそれ、他は null
export function selectionSingle(selection) {
  const sel = new Map();
  for (const s of selection) { if (!sel.has(s.property_id)) sel.set(s.property_id, []); sel.get(s.property_id).push(s); }
  return (pid) => { const xs = sel.get(pid) ?? []; return xs.length === 1 ? xs[0] : null; };
}

// 計画（SP-264-020・021）。draft は PlanDraft、mutDraft は MutationsDraft（どちらも形を照らした後）、skeleton は plan-skeleton の出力、
// target_ids はその task の context.target_ids。戻り値 { plan: PlanFile, mutations: MutationsFile, defects }。
// targets の欠け（骨組みが検査を出さなかった target）は other、target_ids に無い target_id は reference、重なりは other の欠陥にする。
// 変異の detector_check_id は prop-<property_id> で埋める（kind: property の検査の id の決め方。SP-264-020）
export function assemblePlan(draft, mutDraft, skeleton, { target_ids }) {
  const defects = [];
  for (const id of skeleton.missing_targets) defects.push(defect('other', `target-missing:${id}`, `target_id ${id} の時間の上限・前提・範囲が計画の下書きの targets に無いので、その検査を出せない`));
  const known = new Set(target_ids);
  const seen = new Set();
  for (const t of draft.targets) {
    if (!known.has(t.target_id)) defects.push(defect('reference', `target-unknown:${t.target_id}`, `計画の下書きの targets の target_id ${t.target_id} が task の context.target_ids に無い`));
    else if (seen.has(t.target_id)) defects.push(defect('other', `target-dup:${t.target_id}`, `計画の下書きの targets に target_id ${t.target_id} が重なる`));
    seen.add(t.target_id);
  }
  const plan = { schema: 'formal-method.plan/1', selection: draft.selection, checks: skeleton.checks, sanity: skeleton.sanity };
  const mutations = {
    schema: 'formal-method.mutations/1',
    mutations: mutDraft.mutations.map((m) => ({ ...m, detector_check_id: `prop-${m.property_id}` })),
    unavailable: mutDraft.unavailable,
  };
  return { plan, mutations, defects };
}

// モデルごとの計画をモデルの順につなぐ（SP-264-012）。parts: [{ plan, mutations }]（モデルの順）。戻り値 { plan: PlanFile, mutations: MutationsFile }
export function concatPlans(parts) {
  return {
    plan: { schema: 'formal-method.plan/1', selection: parts.flatMap((x) => x.plan.selection), checks: parts.flatMap((x) => x.plan.checks), sanity: parts.flatMap((x) => x.plan.sanity) },
    mutations: { schema: 'formal-method.mutations/1', mutations: parts.flatMap((x) => x.mutations.mutations), unavailable: parts.flatMap((x) => x.mutations.unavailable) },
  };
}

// inventory（SP-264-026）。draft は InventoryDraft（形を照らした後）、skeleton は extract-skeleton の出力（references には、担当の
// external_dependencies が既に挙げた ID を入れずに渡す）。scanned は骨組みで埋め（担当は書かない）、骨組みの外部の依存の下書きは
// 担当の要素の後ろに足す。戻り値は今の Inventory の形（照らすのは coverageCheck）
export function assembleInventory(draft, skeleton) {
  const own = new Set(draft.external_dependencies.map((d) => d.id));
  const added = skeleton.external_dependencies.filter((d) => !own.has(d.id));
  return { ...draft, scanned: skeleton.scanned, external_dependencies: [...draft.external_dependencies, ...added] };
}
