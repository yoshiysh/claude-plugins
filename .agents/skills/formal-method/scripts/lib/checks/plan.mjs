// 計画の照合（artifact-formats.md「plan と mutations」、cli-contract.md「Z3 の adapter」の道具に渡す query）。
// 欠陥は、計画の要素（検査・sanity・変異）に結び付くもの（element）と、性質の selection に結び付くもの（property）と、
// 要素の無い欠け（検査の欠け）に分ける。欠陥が残った要素は実行せず、unverified に「計画の欠陥: <id>」で載せる。
import { MutationsFile, PlanFile, TOOL_TIME_LIMIT_MAX_S, validate } from '../schemas.mjs';
import { hasCheckSat, smtViolations, ID as Z3_ID } from '../adapters/z3.mjs';
import { noSuitableTool, RUNNABLE_TOOLS } from '../adapters/index.mjs';
import { defect, readRunText } from './common.mjs';

// ctx: { runDir, prefix（計画作成役の attempt の Ref の接頭辞）, models: [{ id, data }], partitions（採った PartitionsFile か null）,
//        eligible: Set（形式化できる必要な性質で問いに依存しないもの）, blocked: Set（問いに依存する性質）, prepare（道具の準備の結果か null）, authorQueries: Set, smtBad: Map,
//        propertyIds: Set（inventory の性質の id。selection・unavailable の実在を照らす） }
export function planCheck(plan, mutations, ctx) {
  const pe = validate(PlanFile, plan);
  const me = validate(MutationsFile, mutations);
  if (pe.length || me.length) return { defects: [defect('syntax', 'plan-shape', `計画の形が違う: ${[...pe, ...me].slice(0, 3).join('; ')}`)], valid: false };
  const out = [];
  const mps = new Map();
  for (const m of ctx.models) for (const p of m.data.properties) mps.set(p.id, { model_id: m.id, inv: p.inventory_property_ids, p });
  const contracts = new Map((ctx.partitions?.contracts ?? []).map((k) => [k.id, k]));
  const conds = new Map((ctx.partitions?.composition_conditions ?? []).map((c) => [c.id, c]));
  // selection
  const sel = new Map();
  for (const s of plan.selection) { if (!sel.has(s.property_id)) sel.set(s.property_id, []); sel.get(s.property_id).push(s); }
  for (const pid of ctx.eligible) {
    const n = (sel.get(pid) ?? []).length;
    if (n !== 1) out.push(defect('other', `selection-count:${pid}`, `性質 ${pid} の selection の要素が ${n} 個（ちょうど 1 つ）`, { property: pid }));
  }
  for (const s of plan.selection) {
    if (ctx.propertyIds && !ctx.propertyIds.has(s.property_id)) out.push(defect('reference', `selection-property:${s.property_id}`, `selection の property_id ${s.property_id} が inventory の性質に無い`));
    if (!s.candidates.some((c) => c.role === '検証器' && c.name === Z3_ID)) out.push(defect('other', `selection-z3:${s.property_id}`, `性質 ${s.property_id} の候補に 検証器 の ${Z3_ID} が無い`, { property: s.property_id }));
    if (!s.candidates.some((c) => c.name === s.chosen.tool)) out.push(defect('reference', `selection-chosen:${s.property_id}`, `性質 ${s.property_id} の chosen.tool ${s.chosen.tool} が候補の name に無い`, { property: s.property_id }));
  }
  const single = (pid) => { const xs = sel.get(pid) ?? []; return xs.length === 1 ? xs[0] : null; };
  const noTool = (pid) => noSuitableTool(ctx.prepare, single(pid));
  const notZ3 = (pid) => single(pid) !== null && !RUNNABLE_TOOLS.includes(single(pid).chosen.tool);
  const parentsOf = (mpId) => mps.get(mpId)?.inv ?? [];
  // id の名前空間
  const ids = [...plan.checks.map((c) => c.id), ...plan.sanity.map((s) => s.id), ...mutations.mutations.map((m) => m.id)];
  const seen = new Set();
  for (const id of ids) {
    if (id.startsWith('confirm-')) out.push(defect('other', `id-confirm:${id}`, `計画の id ${id} が confirm- で始まる`, { element: id }));
    if (seen.has(id)) out.push(defect('other', `id-dup:${id}`, `計画の id ${id} が重なる`, { element: id }));
    seen.add(id);
  }
  // input_refs のつなぎ方: 担当の query だけを指し、(check-sat) を持つ input は最後の 1 つだけ
  const inputDefects = (refs, id, what) => {
    const v = [];
    for (const r of refs) {
      if (!ctx.authorQueries.has(r)) v.push(defect('reference', `input-ref:${id}:${r}`, `${what} ${id} の input ${r} が担当の query でない`, { element: id }));
      else if (ctx.smtBad.has(r)) v.push(defect('syntax', `input-smt:${id}:${r}`, `${what} ${id} の input ${r} が .smt2 の規則に反する（${ctx.smtBad.get(r).join('・')}）`, { element: id }));
    }
    const texts = refs.map((r) => readRunText(ctx.runDir, r));
    if (texts.some((t) => t === null)) v.push(defect('reference', `input-missing:${id}`, `${what} ${id} の input が無い`, { element: id }));
    else {
      const withCs = texts.map((t) => hasCheckSat(t));
      if (!withCs[withCs.length - 1] || withCs.slice(0, -1).some(Boolean)) v.push(defect('syntax', `input-checksat:${id}`, `${what} ${id} で (check-sat) を持つ input が最後の 1 つだけでない`, { element: id }));
    }
    return v;
  };
  const checkIds = new Set(plan.checks.map((c) => c.id));
  for (const c of plan.checks) {
    const what = `検査`;
    if (c.kind === 'property') {
      const mp = mps.get(c.target_id);
      if (!mp) out.push(defect('reference', `target:${c.id}`, `検査 ${c.id} の target_id ${c.target_id} がモデルの性質でない`, { element: c.id }));
      else {
        if (mp.model_id !== c.model_id) out.push(defect('reference', `model:${c.id}`, `検査 ${c.id} の model_id ${c.model_id} が target のモデル ${mp.model_id} と違う`, { element: c.id }));
        if (mp.inv.some(notZ3)) out.push(defect('other', `not-z3:${c.id}`, `検査 ${c.id} の性質の chosen.tool が z3 でない`, { element: c.id }));
      }
    } else {
      const x = c.kind === 'contract' ? contracts.get(c.target_id) : conds.get(c.target_id);
      if (!x) out.push(defect('reference', `target:${c.id}`, `検査 ${c.id}（${c.kind}）の target_id ${c.target_id} が${c.kind === 'contract' ? '契約' : '合成の条件'}でない`, { element: c.id }));
      else {
        if (x.model_id !== c.model_id) out.push(defect('reference', `model:${c.id}`, `検査 ${c.id} の model_id ${c.model_id} が ${x.model_id} と違う`, { element: c.id }));
        if (parentsOf(x.derived_from).some(notZ3)) out.push(defect('other', `not-z3:${c.id}`, `検査 ${c.id} の親の性質の chosen.tool が z3 でない`, { element: c.id }));
      }
    }
    if (c.expected !== 'unsat') out.push(defect('other', `expected:${c.id}`, `検査 ${c.id} の expected が unsat でない`, { element: c.id }));
    if (c.tool_time_limit_seconds > TOOL_TIME_LIMIT_MAX_S) out.push(defect('other', `limit:${c.id}`, `検査 ${c.id} の tool_time_limit_seconds が ${TOOL_TIME_LIMIT_MAX_S} を超える`, { element: c.id }));
    for (const d of c.depends_on) if (!checkIds.has(d)) out.push(defect('reference', `depends:${c.id}:${d}`, `検査 ${c.id} の depends_on ${d} が計画に無い`, { element: c.id }));
    out.push(...inputDefects(c.input_refs, c.id, what));
  }
  for (const id of dependencyCycleMembers(plan.checks)) out.push(defect('other', `depends-cycle:${id}`, `検査 ${id} の depends_on が循環する（自分自身への依存を含む）`, { element: id }));
  for (const s of plan.sanity) {
    if (!mps.has(s.model_property_id)) out.push(defect('reference', `sanity-target:${s.id}`, `sanity ${s.id} の model_property_id ${s.model_property_id} がモデルの性質でない`, { element: s.id }));
    if (s.tool_time_limit_seconds > TOOL_TIME_LIMIT_MAX_S) out.push(defect('other', `limit:${s.id}`, `sanity ${s.id} の tool_time_limit_seconds が上限を超える`, { element: s.id }));
    out.push(...inputDefects(s.input_refs, s.id, 'sanity'));
  }
  for (const m of mutations.mutations) {
    const det = plan.checks.find((c) => c.id === m.detector_check_id);
    if (!mps.has(m.property_id)) out.push(defect('reference', `mutation-target:${m.id}`, `変異 ${m.id} の property_id ${m.property_id} がモデルの性質でない`, { element: m.id }));
    if (!det || det.kind !== 'property' || det.target_id !== m.property_id) { out.push(defect('reference', `mutation-detector:${m.id}`, `変異 ${m.id} の detector_check_id ${m.detector_check_id} が target_id ${m.property_id} の kind property の検査でない`, { element: m.id })); continue; }
    if (!m.mutation_ref.startsWith(ctx.prefix)) { out.push(defect('reference', `mutation-ref:${m.id}`, `変異 ${m.id} の mutation_ref ${m.mutation_ref} が計画作成役自身の attempt（${ctx.prefix}）の外`, { element: m.id })); continue; }
    const text = readRunText(ctx.runDir, m.mutation_ref);
    if (text === null) { out.push(defect('reference', `mutation-missing:${m.id}`, `変異 ${m.id} の mutation_ref が無い`, { element: m.id })); continue; }
    for (const v of smtViolations(text)) out.push(defect('syntax', `mutation-smt:${m.id}:${v}`, `変異 ${m.id} の ${m.mutation_ref}: ${v}`, { element: m.id }));
    const refs = [...det.input_refs.slice(0, -1)];
    const prev = refs.map((r) => readRunText(ctx.runDir, r));
    if (prev.some((t) => t === null || hasCheckSat(t))) out.push(defect('syntax', `mutation-checksat:${m.id}`, `変異 ${m.id} で (check-sat) を持つ input が最後の 1 つだけでない`, { element: m.id }));
  }
  for (const [i, u] of mutations.unavailable.entries()) {
    if (ctx.propertyIds && !ctx.propertyIds.has(u.property_id)) out.push(defect('reference', `unavailable-property:${i}`, `unavailable の property_id ${u.property_id} が inventory の性質に無い`));
  }
  // 必要な性質ごとに、変異か unavailable の要素が 1 つ以上ある
  for (const pid of ctx.eligible) {
    const has = mutations.mutations.some((m) => parentsOf(m.property_id).includes(pid)) || mutations.unavailable.some((u) => u.property_id === pid);
    if (!has) out.push(defect('other', `mutation-missing:${pid}`, `性質 ${pid} に変異も unavailable も無い`, { property: null }));
  }
  // 検査の欠け
  const excludedMp = (mpId) => { const inv = parentsOf(mpId); return inv.length > 0 && inv.every((pid) => ctx.blocked.has(pid) || noTool(pid)); };
  for (const [mpId] of mps) {
    if (excludedMp(mpId)) continue;
    if (!plan.checks.some((c) => c.kind === 'property' && c.target_id === mpId)) out.push(defect('other', `missing-check:${mpId}`, `モデルの性質 ${mpId} の検査が計画に無い`));
    if (!plan.sanity.some((s) => s.model_property_id === mpId)) out.push(defect('other', `missing-sanity:${mpId}`, `モデルの性質 ${mpId} の sanity が計画に無い`));
  }
  for (const [id, x] of [...contracts, ...conds]) {
    const inv = parentsOf(x.derived_from);
    if (inv.length > 0 && inv.every(noTool)) continue;
    const kind = contracts.has(id) ? 'contract' : 'composition';
    if (!plan.checks.some((c) => c.kind === kind && c.target_id === id)) out.push(defect('other', `missing-check:${id}`, `${kind === 'contract' ? '契約' : '合成の条件'} ${id} の検査が計画に無い`));
  }
  return { defects: out, valid: true, noTool, single };
}

// depends_on の循環に乗る検査の id（計画にある依存先だけを辿る。自己依存を含む）。強連結成分で求め、計画の順に返す。
export function dependencyCycleMembers(checks) {
  const ids = new Set(checks.map((c) => c.id));
  const next = new Map(checks.map((c) => [c.id, c.depends_on.filter((d) => ids.has(d))]));
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const members = new Set();
  let n = 0;
  const visit = (v) => {
    index.set(v, n); low.set(v, n); n += 1;
    stack.push(v); onStack.add(v);
    for (const w of next.get(v) ?? []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) !== index.get(v)) return;
    const comp = [];
    for (;;) { const w = stack.pop(); onStack.delete(w); comp.push(w); if (w === v) break; }
    if (comp.length > 1 || (next.get(v) ?? []).includes(v)) for (const w of comp) members.add(w);
  };
  for (const c of checks) if (!index.has(c.id)) visit(c.id);
  return checks.map((c) => c.id).filter((id) => members.has(id));
}

// 修正の巡の後に残った欠陥から、実行しない計画の要素を決める（selection の欠陥はその性質の検査に、検出役の検査の欠陥は変異に及ぶ）。
export function defectiveElements(plan, mutations, defects, models, partitions) {
  const out = new Map();
  const add = (id, text) => { if (!out.has(id)) out.set(id, []); out.get(id).push(text); };
  for (const d of defects) if (d.element) add(d.element, d.text);
  const mps = new Map();
  for (const m of models) for (const p of m.data.properties) mps.set(p.id, p.inventory_property_ids);
  const selBad = new Set(defects.filter((d) => d.property).map((d) => d.property));
  const parentOf = new Map([...(partitions?.contracts ?? []), ...(partitions?.composition_conditions ?? [])].map((x) => [x.id, x.derived_from]));
  for (const c of plan.checks) {
    const mp = c.kind === 'property' ? c.target_id : parentOf.get(c.target_id);
    const inv = mps.get(mp) ?? [];
    const bad = inv.filter((pid) => selBad.has(pid));
    if (bad.length) add(c.id, `性質 ${bad.join('・')} の selection の欠陥が残った`);
  }
  for (const m of mutations.mutations) if (out.has(m.detector_check_id)) add(m.id, `検出役の検査 ${m.detector_check_id} の欠陥が残った`);
  return new Map([...out].map(([k, v]) => [k, v.join('。')]));
}
