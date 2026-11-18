// artifact-formats.md「候補の導出の手順」（writer-merge-scc/1）の、T の独立の実装。返された graph に当て直す（AC-06）。
// と、停止の報告の段の規則（「stop_report.stage の決め方」と code ごとの表）の当て直し（AC-19）。
const cmp = (a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b)));

export function writerMergeScc(graph) {
  const used = graph.nodes.filter((n) => n.kind === 'variable' || n.kind === 'transition').map((n) => n.id);
  const inUse = new Set(used);
  const parent = new Map(used.map((id) => [id, id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const e of graph.edges) if (e.kind === 'write' && inUse.has(e.from) && inUse.has(e.to)) parent.set(find(e.from), find(e.to));
  const groups = [...new Set(used.map(find))];
  const adj = new Map(groups.map((g) => [g, new Set()]));
  const kindOf = new Map(graph.nodes.map((n) => [n.id, n.kind]));
  for (const e of graph.edges) {
    if (e.kind !== 'read' || !inUse.has(e.from) || !inUse.has(e.to)) continue;
    // read の辺は from が遷移 t、to が変数 v。v の組から t の組へ引く
    if (kindOf.get(e.from) !== 'transition' || kindOf.get(e.to) !== 'variable') continue;
    const t = e.from; const v = e.to;
    const a = find(v); const b = find(t);
    if (a !== b) adj.get(a).add(b);
  }
  // Tarjan
  let index = 0; const idx = new Map(); const low = new Map(); const stack = []; const on = new Set(); const sccs = [];
  const strong = (g) => {
    idx.set(g, index); low.set(g, index); index += 1; stack.push(g); on.add(g);
    for (const h of adj.get(g)) {
      if (!idx.has(h)) { strong(h); low.set(g, Math.min(low.get(g), low.get(h))); } else if (on.has(h)) low.set(g, Math.min(low.get(g), idx.get(h)));
    }
    if (low.get(g) === idx.get(g)) { const comp = []; let x; do { x = stack.pop(); on.delete(x); comp.push(x); } while (x !== g); sccs.push(comp); }
  };
  for (const g of groups) if (!idx.has(g)) strong(g);
  const members = sccs.map((comp) => used.filter((id) => comp.includes(find(id))).sort(cmp));
  members.sort((a, b) => cmp(a[0], b[0]));
  const cands = members.map((nodes, i) => ({ id: `C${i + 1}`, nodes }));
  const owner = new Map(cands.flatMap((c) => c.nodes.map((n) => [n, c.id])));
  for (const c of cands) {
    const counts = new Map();
    for (const e of graph.edges) {
      const a = owner.get(e.from); const b = owner.get(e.to);
      if (!a || !b || a === b) continue;
      const other = a === c.id ? b : b === c.id ? a : null;
      if (other) counts.set(other, (counts.get(other) ?? 0) + 1);
    }
    c.strength_to = [...counts].sort((x, y) => cmp(x[0], y[0])).map(([candidate_id, edges]) => ({ candidate_id, edges }));
  }
  return cands;
}

const STAGES = ['受付', '洗い出し', 'モデル化', '計画', '実行', '確認', '集約'];
export const INTERRUPTS = ['依頼の不備', '起動の失敗', '時間の上限', '保存の失敗', '内部の誤り', '処理の中断'];
const FIXED = {
  依頼の不備: ['受付'], 起動の失敗: ['受付'], 対応できていない組合せ: ['モデル化'], 反例: ['実行'], 回答を待つ問い: ['確認'],
  実行できない検査: ['計画', '実行'],
  必要な性質が検証の成功でない: ['集約'], 確認が終わっていない: ['集約'], 記録の未保存: ['集約'], '必要な性質が 0 件': ['集約'], 検出能力未確認: ['集約'],
};

// stop_report の段の規則に合わない点を返す。
export function stopStageViolations(r) {
  const errs = [];
  const sr = r.stop_report;
  if (!sr) return errs;
  for (const x of sr.reasons) if (FIXED[x.code] && !FIXED[x.code].includes(x.stage)) errs.push(`${x.code} の stage ${x.stage}（表は ${FIXED[x.code].join('・')}）`);
  const intr = sr.reasons.filter((x) => INTERRUPTS.includes(x.code));
  const firstNon = sr.reasons.findIndex((x) => !INTERRUPTS.includes(x.code));
  if (intr.length && firstNon >= 0 && sr.reasons.slice(firstNon).some((x) => INTERRUPTS.includes(x.code))) errs.push('中断の理由が先に並んでいない');
  const expected = intr.length ? intr[0].stage : sr.reasons.map((x) => x.stage).sort((a, b) => STAGES.indexOf(a) - STAGES.indexOf(b))[0];
  if (sr.stage !== expected) errs.push(`stop_report.stage ${sr.stage}（規則では ${expected}）`);
  return errs;
}

// ---- 依存グラフの導出の規則（artifact-formats「依存グラフの導出の規則」）の、T の独立の実装 ----
const RESERVED = new Set(['assert', 'and', 'or', 'not', 'xor', '=>', '=', 'distinct', 'ite', 'let', 'forall', 'exists', 'true', 'false',
  '+', '-', '*', '/', 'div', 'mod', 'abs', '<', '<=', '>', '>=', 'to_real', 'to_int', 'is_int', 'select', 'store', 'Int', 'Real', 'Bool',
  'Array', '!', 'named', 'pattern', 'as', '_']);
const isLiteral = (t) => /^-?\d+(\.\d+)?$/.test(t) || t.startsWith(':') || /^#[xb]/.test(t) || t.startsWith('"');

// S 式を読む。atom は文字列、list は配列。form は { node, start, end }（文字の位置、0 始まり、end を含まない）。
export function parseSexprs(text) {
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i += 1;
      if (text[i] === ';') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
      return;
    }
  };
  const read = () => {
    skip();
    if (i >= text.length) throw new Error('S 式が途中で終わる');
    if (text[i] === '(') {
      i += 1;
      const list = [];
      for (;;) { skip(); if (text[i] === ')') { i += 1; return list; } list.push(read()); }
    }
    if (text[i] === ')') throw new Error('対応の無い )');
    if (text[i] === '"') { const s = i; i += 1; while (i < text.length && text[i] !== '"') i += 1; i += 1; return text.slice(s, i); }
    if (text[i] === '|') { const s = i; i += 1; while (i < text.length && text[i] !== '|') i += 1; i += 1; return text.slice(s + 1, i - 1); }
    const s = i;
    while (i < text.length && !/[\s();"]/.test(text[i])) i += 1;
    return text.slice(s, i);
  };
  const forms = [];
  for (;;) {
    skip();
    if (i >= text.length) break;
    const start = i;
    const node = read();
    forms.push({ node, start, end: i });
  }
  return forms;
}

// 項の中の記号（束縛された名前・予約語・literal を除く）を、現れた順に重複なく返す。
export function symbolsOf(term, bound = new Set(), out = []) {
  const add = (s) => { if (!RESERVED.has(s) && !isLiteral(s) && !bound.has(s) && !out.includes(s)) out.push(s); };
  if (typeof term === 'string') { add(term); return out; }
  if (term.length === 0) return out;
  const [h] = term;
  if (h === 'let' && Array.isArray(term[1])) {
    for (const b of term[1]) if (Array.isArray(b)) symbolsOf(b[1], bound, out);
    const inner = new Set([...bound, ...term[1].filter(Array.isArray).map((b) => b[0])]);
    for (const x of term.slice(2)) symbolsOf(x, inner, out);
    return out;
  }
  if ((h === 'forall' || h === 'exists') && Array.isArray(term[1])) {
    for (const b of term[1]) if (Array.isArray(b)) symbolsOf(b.slice(1), bound, out);
    const inner = new Set([...bound, ...term[1].filter(Array.isArray).map((b) => b[0])]);
    for (const x of term.slice(2)) symbolsOf(x, inner, out);
    return out;
  }
  for (const x of term) symbolsOf(x, bound, out);
  return out;
}

const byId = (a, b) => cmp(a.id, b.id);

// 名前付け (! t :named n) の n を、form の中から集める。
function namedIn(node, out = []) {
  if (!Array.isArray(node)) return out;
  if (node[0] === '!') for (let k = 1; k < node.length - 1; k += 1) if (node[k] === ':named' && typeof node[k + 1] === 'string') out.push(node[k + 1]);
  for (const x of node) namedIn(x, out);
  return out;
}

// models: [{ model: ModelFile, ref: モデルのファイルの Ref }]（1 つでもよい）、readRef(ref) → .smt2 の文字列（読めなければ null）。
// 2 つ以上のモデルは 1 つの graph にする。状態遷移と性質の id は <model_id>/ を持ち、property の辺は同じモデルの変数にだけ引く。
export function deriveGraph(models, readRef) {
  const list = Array.isArray(models) ? models : [models];
  const nodes = new Map();
  const edges = new Map();
  const unconfirmed = new Map();
  const addNode = (id, kind, location) => { if (!nodes.has(id)) nodes.set(id, { id, kind, location }); };
  const addEdge = (kind, from, to, location) => { const id = `${kind}:${from}->${to}`; if (!edges.has(id)) edges.set(id, { id, from, to, kind, location }); };
  const unconf = (relation, reason) => { if (!unconfirmed.has(relation)) unconfirmed.set(relation, { relation, reason }); };
  const varsOf = new Map();
  for (const { model, ref: modelRef } of list) {
    const mid = model.model_id;
    const sm = model.state_machine;
    const vars = new Set((sm?.variables ?? []).map((v) => v.id));
    varsOf.set(mid, vars);
    (sm?.variables ?? []).forEach((v, i) => addNode(`var:${mid}/${v.id}`, 'variable', { file: modelRef, pointer: `/state_machine/variables/${i}` }));
    (sm?.transitions ?? []).forEach((t, i) => {
      const tid = `tr:${mid}/${t.id}`;
      addNode(tid, 'transition', { file: modelRef, pointer: `/state_machine/transitions/${i}` });
      t.updates.forEach((u, j) => {
        if (vars.has(u.var)) addEdge('write', tid, `var:${mid}/${u.var}`, { file: modelRef, pointer: `/state_machine/transitions/${i}/updates/${j}/var` });
        else unconf(`${tid}->${u.var}`, '宣言の無い変数への更新');
      });
      const terms = [[t.guard, `/state_machine/transitions/${i}/guard`], ...t.updates.map((u, j) => [u.term, `/state_machine/transitions/${i}/updates/${j}/term`])];
      for (const [text, pointer] of terms) {
        let forms;
        try { forms = parseSexprs(text); } catch { unconf(`${tid}->${text}`, '項を S 式として読めない'); continue; }
        for (const f of forms) for (const sym of symbolsOf(f.node)) {
          if (vars.has(sym)) addEdge('read', tid, `var:${mid}/${sym}`, { file: modelRef, pointer });
          else unconf(`${tid}->${sym}`, '変数でも予約語でもない記号');
        }
      }
    });
    model.properties.forEach((p, i) => addNode(`prop:${mid}/${p.id}`, 'property', { file: modelRef, pointer: `/properties/${i}` }));
  }
  const refs = [...new Set(list.flatMap(({ model }) => model.properties.flatMap((p) => [p.query_ref, ...p.sanity.map((x) => x.query_ref)])))].sort(cmp);
  const declaredIn = new Map();
  for (const ref of refs) {
    const text = readRef(ref);
    if (text === null) continue;
    let forms;
    try { forms = parseSexprs(text); } catch { unconf(`smt:${ref}->${text}`, '項を S 式として読めない'); continue; }
    const declared = new Map();
    const loc = (n, f) => ({ file: ref, pointer: `form:${n}:${f.start}-${f.end}` });
    forms.forEach((f, n) => {
      const [h, name] = Array.isArray(f.node) ? f.node : [];
      if (['declare-const', 'declare-fun', 'declare-sort', 'define-sort'].includes(h)) { addNode(`smt:${ref}#${name}`, 'smt_declaration', loc(n, f)); declared.set(name, { n, f, decl: true }); }
      if (h === 'define-fun') { addNode(`smt:${ref}#${name}`, 'smt_definition', loc(n, f)); declared.set(name, { n, f, decl: false }); }
      for (const nm of namedIn(f.node)) { addNode(`smt:${ref}#${nm}`, 'smt_definition', loc(n, f)); if (!declared.has(nm)) declared.set(nm, { n, f, decl: false }); }
    });
    declaredIn.set(ref, declared);
    forms.forEach((f, n) => {
      if (!Array.isArray(f.node)) return;
      const [h, name] = f.node;
      let from; let syms;
      if (h === 'define-fun') {
        from = `smt:${ref}#${name}`;
        const params = Array.isArray(f.node[2]) ? f.node[2].filter(Array.isArray).map((x) => x[0]) : [];
        syms = symbolsOf(f.node.slice(3), new Set(params)).filter((x) => x !== name);
      } else if (h === 'assert') {
        from = `smt:${ref}#assert-${n}`;
        addNode(from, 'smt_assertion', loc(n, f));
        syms = symbolsOf(f.node.slice(1));
      } else return;
      for (const sym of syms) {
        if (declared.has(sym)) addEdge('reference', from, `smt:${ref}#${sym}`, loc(n, f));
        else unconf(`${from}->${sym}`, '.smt2 で宣言の無い記号');
      }
    });
  }
  for (const { model } of list) {
    const vars = varsOf.get(model.model_id);
    model.properties.forEach((p) => {
      const declared = declaredIn.get(p.query_ref);
      if (!declared) return;
      for (const [name, { n, f, decl }] of declared) if (decl && vars.has(name)) addEdge('property', `prop:${model.model_id}/${p.id}`, `var:${model.model_id}/${name}`, { file: p.query_ref, pointer: `form:${n}:${f.start}-${f.end}` });
    });
  }
  return {
    nodes: [...nodes.values()].sort(byId),
    edges: [...edges.values()].sort(byId),
    unconfirmed: [...unconfirmed.values()].sort((x, y) => cmp(x.relation, y.relation)),
  };
}

// 部分（parts）を跨ぐ辺。owns_variables・transitions は、規則の id（var:・tr: で始まる）ならそのまま、
// モデルの中の名前なら modelId を付けて規則の id にする（契約は parts の名前の形を定めていない）。
export function crossingEdges(graph, parts, modelId = null) {
  const owner = new Map();
  const asId = (prefix, x) => (x.startsWith(`${prefix}:`) ? x : `${prefix}:${modelId}/${x}`);
  for (const p of parts) {
    for (const v of p.owns_variables) owner.set(asId('var', v), p.id);
    for (const t of p.transitions) owner.set(asId('tr', t), p.id);
  }
  return graph.edges.filter((e) => owner.has(e.from) && owner.has(e.to) && owner.get(e.from) !== owner.get(e.to));
}
