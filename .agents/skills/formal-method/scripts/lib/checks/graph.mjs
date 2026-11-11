// 依存グラフの導出と分割の候補（artifact-formats.md「依存グラフの導出の規則」「候補の導出の手順」writer-merge-scc/1）。
// グラフは形式モデルとそれが参照する .smt2 の構文から決定的に導く。推定の辺は作らない。
import { parseForms, symbolsOf, namedIn } from '../sexpr.mjs';
import { cmpBytes } from './common.mjs';

// 導出の途中の集まり。同じ id の要素・辺・未確認は最初のものだけを残す。
class GraphBuilder {
  constructor() { this.nodes = new Map(); this.edges = new Map(); this.unconfirmed = new Map(); }
  node(id, kind, location) { if (!this.nodes.has(id)) this.nodes.set(id, { id, kind, location }); }
  edge(kind, from, to, location) { const id = `${kind}:${from}->${to}`; if (!this.edges.has(id)) this.edges.set(id, { id, from, to, kind, location }); }
  unknown(relation, why) { if (!this.unconfirmed.has(relation)) this.unconfirmed.set(relation, { relation, reason: why }); }
  done() {
    const byId = (a, b) => cmpBytes(a.id, b.id);
    return { nodes: [...this.nodes.values()].sort(byId), edges: [...this.edges.values()].sort(byId), unconfirmed: [...this.unconfirmed.values()].sort((a, b) => cmpBytes(a.relation, b.relation)) };
  }
}

// 状態遷移の要素と辺（変数・遷移・write・read）と、性質の要素。
function addStateMachine(g, model, modelRef) {
  const mid = model.model_id;
  const sm = model.state_machine;
  const variables = sm ? sm.variables.map((v) => v.id) : [];
  const vars = new Set(variables);
  const varId = (name) => `var:${mid}/${name}`;
  variables.forEach((name, i) => g.node(varId(name), 'variable', { file: modelRef, pointer: `/state_machine/variables/${i}` }));
  (sm ? sm.transitions : []).forEach((tr, i) => {
    const at = `/state_machine/transitions/${i}`;
    const tid = `tr:${mid}/${tr.id}`;
    g.node(tid, 'transition', { file: modelRef, pointer: at });
    tr.updates.forEach((u, j) => (vars.has(u.var)
      ? g.edge('write', tid, varId(u.var), { file: modelRef, pointer: `${at}/updates/${j}/var` })
      : g.unknown(`${tid}->${u.var}`, '宣言の無い変数への更新')));
    // read の辺の箇所は、最初に現れた所（guard、次に updates の順）
    const terms = [{ text: tr.guard, pointer: `${at}/guard` }, ...tr.updates.map((u, j) => ({ text: u.term, pointer: `${at}/updates/${j}/term` }))];
    for (const { text, pointer } of terms) {
      let forms;
      try { forms = parseForms(text); } catch { g.unknown(`${tid}->${text}`, '項を S 式として読めない'); continue; }
      const syms = [];
      for (const f of forms) symbolsOf(f.node, new Set(), syms);
      for (const sym of syms) {
        if (vars.has(sym)) g.edge('read', tid, varId(sym), { file: modelRef, pointer });
        else g.unknown(`${tid}->${sym}`, '変数でも予約語でもない記号');
      }
    }
  });
  model.properties.forEach((p, i) => g.node(`prop:${mid}/${p.id}`, 'property', { file: modelRef, pointer: `/properties/${i}` }));
  return vars;
}

const DECLARING = new Set(['declare-const', 'declare-fun', 'declare-sort', 'define-sort']);

// 1 つの .smt2 の要素と reference の辺。戻り値は、そのファイルで宣言・定義された記号 → { form, decl }。
function addSmtFile(g, ref, text) {
  let forms;
  try { forms = parseForms(text); } catch { g.unknown(`smt:${ref}->${text}`, '項を S 式として読めない'); return null; }
  const at = (n) => ({ file: ref, pointer: `form:${n}:${forms[n].start}-${forms[n].end}` });
  const sym = (name) => `smt:${ref}#${name}`;
  const declared = new Map();
  forms.forEach((f, n) => {
    const head = Array.isArray(f.node) ? f.node[0] : null;
    const name = Array.isArray(f.node) ? f.node[1] : null;
    if (DECLARING.has(head)) { g.node(sym(name), 'smt_declaration', at(n)); declared.set(name, { n, decl: true }); } else if (head === 'define-fun') { g.node(sym(name), 'smt_definition', at(n)); declared.set(name, { n, decl: false }); }
    for (const label of namedIn(f.node)) { g.node(sym(label), 'smt_definition', at(n)); if (!declared.has(label)) declared.set(label, { n, decl: false }); }
  });
  forms.forEach((f, n) => {
    if (!Array.isArray(f.node)) return;
    let from;
    let refs;
    if (f.node[0] === 'define-fun') {
      from = sym(f.node[1]);
      const params = new Set((Array.isArray(f.node[2]) ? f.node[2] : []).filter(Array.isArray).map((x) => x[0]));
      refs = symbolsOf(f.node.slice(3), params).filter((x) => x !== f.node[1]);
    } else if (f.node[0] === 'assert') {
      from = sym(`assert-${n}`);
      g.node(from, 'smt_assertion', at(n));
      refs = symbolsOf(f.node.slice(1));
    } else return;
    for (const r of refs) (declared.has(r) ? g.edge('reference', from, sym(r), at(n)) : g.unknown(`${from}->${r}`, '.smt2 で宣言の無い記号'));
  });
  return { declared, at };
}

// models: [{ model: ModelFile, ref }]、readRef(ref) → 文字列か null
export function buildGraph(models, readRef) {
  const g = new GraphBuilder();
  const varsByModel = new Map(models.map(({ model, ref }) => [model.model_id, addStateMachine(g, model, ref)]));
  const queryRefs = new Set();
  for (const { model } of models) for (const p of model.properties) { queryRefs.add(p.query_ref); p.sanity.forEach((x) => queryRefs.add(x.query_ref)); }
  const files = new Map();
  for (const ref of [...queryRefs].sort(cmpBytes)) {
    const text = readRef(ref);
    if (text === null) continue;
    const f = addSmtFile(g, ref, text);
    if (f) files.set(ref, f);
  }
  // property の辺: 性質の query で宣言された記号のうち、同じモデルの変数と同じもの
  for (const { model } of models) {
    const vars = varsByModel.get(model.model_id);
    for (const p of model.properties) {
      const f = files.get(p.query_ref);
      if (!f) continue;
      for (const [name, { n, decl }] of f.declared) if (decl && vars.has(name)) g.edge('property', `prop:${model.model_id}/${p.id}`, `var:${model.model_id}/${name}`, f.at(n));
    }
  }
  return g.done();
}

// writer-merge-scc/1
export function deriveCandidates(graph) {
  const used = graph.nodes.filter((n) => n.kind === 'variable' || n.kind === 'transition').map((n) => n.id);
  const inUse = new Set(used);
  const parent = new Map(used.map((id) => [id, id]));
  const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); let y = x; while (parent.get(y) !== r) { const nx = parent.get(y); parent.set(y, r); y = nx; } return r; };
  for (const e of graph.edges) if (e.kind === 'write' && inUse.has(e.from) && inUse.has(e.to)) { const a = find(e.from); const b = find(e.to); if (a !== b) parent.set(a, b); }
  const groups = [...new Set(used.map(find))];
  const adj = new Map(groups.map((g) => [g, new Set()]));
  const kindOf = new Map(graph.nodes.map((n) => [n.id, n.kind]));
  for (const e of graph.edges) {
    if (e.kind !== 'read' || kindOf.get(e.from) !== 'transition' || kindOf.get(e.to) !== 'variable') continue;
    const a = find(e.to);
    const b = find(e.from);
    if (a !== b) adj.get(a).add(b);
  }
  // 強連結成分（Tarjan、再帰を使わない）
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const sccs = [];
  for (const root of groups) {
    if (idx.has(root)) continue;
    const work = [[root, [...adj.get(root)], 0]];
    idx.set(root, index); low.set(root, index); index += 1; stack.push(root); onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const [g, succ] = frame;
      if (frame[2] < succ.length) {
        const h = succ[frame[2]];
        frame[2] += 1;
        if (!idx.has(h)) {
          idx.set(h, index); low.set(h, index); index += 1; stack.push(h); onStack.add(h);
          work.push([h, [...adj.get(h)], 0]);
        } else if (onStack.has(h)) low.set(g, Math.min(low.get(g), idx.get(h)));
        continue;
      }
      work.pop();
      if (work.length) { const p = work[work.length - 1][0]; low.set(p, Math.min(low.get(p), low.get(g))); }
      if (low.get(g) === idx.get(g)) {
        const comp = [];
        let x;
        do { x = stack.pop(); onStack.delete(x); comp.push(x); } while (x !== g);
        sccs.push(new Set(comp));
      }
    }
  }
  const members = sccs.map((comp) => used.filter((id) => comp.has(find(id))).sort(cmpBytes));
  members.sort((a, b) => cmpBytes(a[0], b[0]));
  const cands = members.map((nodesOf, i) => ({ id: `C${i + 1}`, nodes: nodesOf }));
  const ownerOf = new Map();
  for (const c of cands) for (const n of c.nodes) ownerOf.set(n, c.id);
  const strength = new Map(cands.map((c) => [c.id, new Map()]));
  for (const e of graph.edges) {
    const a = ownerOf.get(e.from);
    const b = ownerOf.get(e.to);
    if (!a || !b || a === b) continue;
    for (const [x, y] of [[a, b], [b, a]]) strength.get(x).set(y, (strength.get(x).get(y) ?? 0) + 1);
  }
  for (const c of cands) c.strength_to = [...strength.get(c.id)].sort((x, y) => cmpBytes(x[0], y[0])).map(([candidate_id, n]) => ({ candidate_id, edges: n }));
  return cands;
}
