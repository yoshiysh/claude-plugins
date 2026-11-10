// モデル化の照合（architecture.md「段と処理の順序」のモデル化）: 形・対応表・query の構文の検査（shapeCheck・mappingCheck）、
// 状態×出来事の組合せの分類（matrixGen）、経路（pathsCheck）、図の導出と突き合わせ（deriveDiagram・diagramDiff）。
import { MappingFile, ModelFile, validate } from '../schemas.mjs';
import { smtViolations } from '../adapters/z3.mjs';
import { defect, readRunJson, readRunText } from './common.mjs';

// モデル作成役の返り値の outputs を照らす。prefix は attempt の領域の Ref の接頭辞、eligible は対象にした inventory の性質の id。
// refs は id と参照の一覧がモデル化の照合とする参照の実在の集合: { elementIds（inventory の要素）, propertyIds（inventory の性質）,
// goalIds・knownRequirementIds・targetIds（依頼） }。
export function modelCheck(runDir, outputs, { prefix, eligible, refs = null }) {
  const defects = [];
  const models = [];
  const mappings = [];
  for (const o of outputs) {
    if (o.kind !== 'model' && o.kind !== 'mapping') continue;
    const data = readRunJson(runDir, o.ref);
    if (data === null) { defects.push(defect('syntax', `read:${o.ref}`, `${o.ref} を JSON として読めない`)); continue; }
    const errs = validate(o.kind === 'model' ? ModelFile : MappingFile, data);
    if (errs.length) { defects.push(defect('syntax', `shape:${o.ref}`, `${o.ref} の形が違う: ${errs.slice(0, 3).join('; ')}`)); continue; }
    (o.kind === 'model' ? models : mappings).push({ ref: o.ref, data });
  }
  if (models.length === 0 && defects.length === 0) defects.push(defect('other', 'model-missing', 'モデルが 1 つも無い'));
  const pairs = [];
  const modelIds = new Set();
  const mpIds = new Set();
  const queryRefs = new Map(); // ref → { kind: 'property' | 'sanity', mp, model_id }
  for (const m of models) {
    const id = m.data.model_id;
    if (modelIds.has(id)) { defects.push(defect('other', `model-dup:${id}`, `model_id ${id} が重なる`)); continue; }
    modelIds.add(id);
    const maps = mappings.filter((x) => x.data.model_id === id);
    if (maps.length !== 1) { defects.push(defect('other', `mapping-count:${id}`, `モデル ${id} の MappingFile が ${maps.length} 個（ちょうど 1 つ）`)); continue; }
    const sm = m.data.state_machine;
    if ((sm === null) !== (m.data.no_state_machine_reason !== null)) defects.push(defect('other', `no-sm-reason:${id}`, `モデル ${id} の no_state_machine_reason は state_machine が null のときだけ非 null`));
    if (sm) defects.push(...stateMachineDefects(id, sm, refs, new Set(m.data.properties.map((p) => p.id))));
    if (refs) for (const c of m.data.io_contracts) for (const sid of c.source_ids) if (!refs.elementIds.has(sid)) defects.push(defect('reference', `io-source:${id}:${c.id}:${sid}`, `モデル ${id} の入出力の契約 ${c.id} の出所 ${sid} が inventory の要素に無い`));
    if (refs) defects.push(...mappingDefects(id, maps[0].data.rows, refs));
    for (const p of m.data.properties) {
      if (mpIds.has(p.id)) defects.push(defect('other', `mp-dup:${p.id}`, `モデルの性質の id ${p.id} が重なる`));
      mpIds.add(p.id);
      for (const ip of p.inventory_property_ids) if (!eligible.has(ip)) defects.push(defect('reference', `mp-inv:${p.id}:${ip}`, `モデルの性質 ${p.id} の inventory_property_ids ${ip} が対象にした性質に無い`));
      const refs = [{ ref: p.query_ref, kind: 'property' }, ...p.sanity.map((s) => ({ ref: s.query_ref, kind: 'sanity' }))];
      for (const r of refs) {
        if (!r.ref.startsWith(prefix)) { defects.push(defect('reference', `ref-outside:${r.ref}`, `query ${r.ref} が attempt の領域の外`)); continue; }
        queryRefs.set(r.ref, { kind: r.kind, mp: p.id, model_id: id });
      }
    }
    pairs.push({ id, ref: m.ref, data: m.data, mapping: maps[0] });
  }
  for (const x of mappings) if (!modelIds.has(x.data.model_id)) defects.push(defect('reference', `mapping-orphan:${x.data.model_id}`, `MappingFile の model_id ${x.data.model_id} のモデルが無い`));
  const smtBad = new Map();
  const texts = new Map();
  for (const [ref] of queryRefs) {
    const text = readRunText(runDir, ref);
    if (text === null) { defects.push(defect('reference', `query-missing:${ref}`, `query ${ref} が無い`)); smtBad.set(ref, ['ファイルが無い']); continue; }
    texts.set(ref, text);
    const v = smtViolations(text);
    if (v.length) { smtBad.set(ref, v); for (const x of v) defects.push(defect('syntax', `smt:${ref}:${x}`, `${ref}: ${x}`)); }
  }
  return { models: pairs, defects, queryRefs, smtBad, texts };
}

// 状態遷移の中の名前の一意と、状態・出来事・inventory の要素への参照の実在（artifact-formats.md「id と参照の一覧」のモデル化の照合）。
function stateMachineDefects(id, sm, refs, modelPropertyIds) {
  const out = [];
  const dup = (xs, what, key) => {
    const seen = new Set();
    for (const x of xs) { if (seen.has(x)) out.push(defect('other', `${key}-dup:${id}:${x}`, `モデル ${id} の${what} ${x} が重なる`)); seen.add(x); }
  };
  dup(sm.states, '状態', 'state');
  dup(sm.events, '出来事', 'event');
  dup(sm.transitions.map((t) => t.id), '遷移の id', 'transition');
  const states = new Set(sm.states);
  const events = new Set(sm.events);
  const need = (ok, key, text) => { if (!ok) out.push(defect('reference', `${key}`, `モデル ${id} の${text}`)); };
  need(states.has(sm.initial), `initial:${id}`, `初期状態 ${sm.initial} が states に無い`);
  for (const t of sm.transitions) {
    need(states.has(t.from), `tr-from:${id}:${t.id}`, `遷移 ${t.id} の from ${t.from} が states に無い`);
    need(states.has(t.to), `tr-to:${id}:${t.id}`, `遷移 ${t.id} の to ${t.to} が states に無い`);
    need(events.has(t.event), `tr-event:${id}:${t.id}`, `遷移 ${t.id} の event ${t.event} が events に無い`);
    if (refs) for (const sid of t.source_ids) need(refs.elementIds.has(sid), `tr-source:${id}:${t.id}:${sid}`, `遷移 ${t.id} の出所 ${sid} が inventory の要素に無い`);
  }
  for (const [i, f] of sm.forbidden.entries()) {
    need(states.has(f.from), `fb-from:${id}:${i}`, `禁止の ${f.from} × ${f.event} の from が states に無い`);
    need(events.has(f.event), `fb-event:${id}:${i}`, `禁止の ${f.from} × ${f.event} の event が events に無い`);
    if (refs) for (const sid of f.source_ids) need(refs.elementIds.has(sid), `fb-source:${id}:${i}:${sid}`, `禁止の ${f.from} × ${f.event} の出所 ${sid} が inventory の要素に無い`);
  }
  for (const [i, u] of sm.uncovered.entries()) {
    need(states.has(u.from) && events.has(u.event), `uncovered:${id}:${i}`, `対応できていない組 ${u.from} × ${u.event} が states・events に無い`);
  }
  // 目標の property_id は、同じ ModelFile の properties[].id に実在する参照（artifact-formats.md「形式モデル」の goals）
  for (const [i, g] of sm.goals.entries()) {
    need(states.has(g.state), `goal-state:${id}:${i}`, `目標 ${g.state} が states に無い`);
    if (!modelPropertyIds.has(g.property_id)) out.push(defect('reference', `goal-property:${id}:${i}`, `モデル ${id} の目標 ${g.state} の性質 ${g.property_id} が properties に無い`));
  }
  return out;
}

// 対応表の行の性質の id と出所の実在。
function mappingDefects(id, rows, refs) {
  const out = [];
  for (const [i, r] of rows.entries()) {
    if (!refs.propertyIds.has(r.property_id)) out.push(defect('reference', `map-property:${id}:${i}`, `対応表 ${id} の行 ${i} の property_id ${r.property_id} が inventory の性質に無い`));
    const s = r.source;
    const ok = s.kind === 'goal' ? refs.goalIds.has(s.id) : s.kind === 'known_requirement' ? refs.knownRequirementIds.has(s.id) : refs.targetIds.has(s.kind === 'target' ? s.id : s.target_id);
    if (!ok) out.push(defect('reference', `map-source:${id}:${i}`, `対応表 ${id} の行 ${i} の出所（${s.kind}）が依頼に無い`));
  }
  return out;
}

// 状態×出来事の全ての組を、許される・禁止された・対応できていない に分ける。遷移が書かれていないことだけを禁止の根拠にしない。
export function matrixGen(model) {
  const sm = model.state_machine;
  if (!sm) return { applicable: false, reason: model.no_state_machine_reason ?? '状態遷移を持たない' };
  const cells = [];
  // 重なった名前（モデル化の照合の欠陥）は 1 つの組として数える
  for (const state of new Set(sm.states)) for (const event of new Set(sm.events)) {
    const trs = sm.transitions.filter((t) => t.from === state && t.event === event);
    if (trs.length) { cells.push({ state, event, class: '許される', grounds: `遷移 ${trs.map((t) => `${t.id}（条件 ${t.guard}）`).join('・')}`, transition_ids: trs.map((t) => t.id) }); continue; }
    const fb = sm.forbidden.filter((f) => f.from === state && f.event === event);
    if (fb.length) { cells.push({ state, event, class: '禁止された', grounds: `禁止の出所 ${[...new Set(fb.flatMap((f) => f.source_ids))].join('・')}`, transition_ids: [] }); continue; }
    const un = sm.uncovered.find((u) => u.from === state && u.event === event);
    cells.push({ state, event, class: '対応できていない', grounds: un ? `不足する情報: ${un.missing_info}` : '不足する情報: 許される遷移も禁止の出所も定められていない', transition_ids: [] });
  }
  return { applicable: true, cells };
}

export function pathsCheck(model) {
  const sm = model.state_machine;
  if (!sm) return { applicable: false, reason: model.no_state_machine_reason ?? '状態遷移を持たない' };
  const mpIds = new Set(model.properties.map((p) => p.id));
  // 性質の無い目標（修正の巡の後も残ったモデル化の照合の欠陥）は、対象外にせず targets から外して unverified に載せる
  const targets = sm.goals.filter((g) => mpIds.has(g.property_id)).map((g) => ({ state: g.state, kind: g.kind, property_id: g.property_id }));
  const missing = sm.goals.filter((g) => !mpIds.has(g.property_id)).map((g) => ({ target: g.state, reason: '目標の性質が無い' }));
  return {
    applicable: true, targets, verified: [], excluded: [],
    unverified: [...targets.map((t) => ({ target: t.state, reason: `${t.state} への到達可能性は、性質 ${t.property_id} の検査の判定で示す（経路ごとの到達の検査は計画していない）` })), ...missing],
  };
}

// モデルから図（mermaid の stateDiagram）を導き、図の要素とモデルの要素を突き合わせる。
export function deriveDiagram(model) {
  const sm = model.state_machine;
  if (!sm) return { derivable: false, reason: model.no_state_machine_reason ?? '状態遷移を持たないので図を導出できない' };
  const lines = ['stateDiagram-v2', `  [*] --> ${sm.initial}`];
  const elementMap = [];
  for (const t of sm.transitions) {
    lines.push(`  ${t.from} --> ${t.to} : ${t.event}`);
    elementMap.push({ diagram_element: `${t.from} --> ${t.to} : ${t.event}`, model_element: `transition ${t.id}` });
  }
  // 遷移にも初期状態にも現れない状態は、状態だけの行で描く（element_map の要素は全て図に描かれている）
  const drawn = new Set([sm.initial, ...sm.transitions.flatMap((t) => [t.from, t.to])]);
  for (const s of sm.states) if (!drawn.has(s)) lines.push(`  ${s}`);
  for (const s of sm.states) elementMap.push({ diagram_element: `state ${s}`, model_element: `state ${s}` });
  const diff = diagramDiff(lines.join('\n'), sm);
  const omitted = [
    ...sm.transitions.filter((t) => t.guard !== 'true').map((t) => `遷移 ${t.id} の条件 ${t.guard}`),
    ...sm.transitions.filter((t) => t.updates.length).map((t) => `遷移 ${t.id} の更新 ${t.updates.map((u) => `${u.var} := ${u.term}`).join(', ')}`),
    ...(model.omitted_edges ?? []).map((e) => `${e.from} の ${e.event}（${e.condition}）`),
  ];
  return { derivable: true, format: 'mermaid', text: lines.join('\n'), element_map: elementMap, extra: diff.extra, missing: diff.missing, omitted_conditions: omitted };
}

// 図の遷移の行（「<from> --> <to> : <event>」）と状態だけの行を読み、モデルの遷移（from→to）と状態に突き合わせる。開始の [*] は数えない。
export function diagramDiff(text, sm) {
  const drawn = new Set();
  const drawnStates = new Set();
  for (const raw of text.split('\n').slice(1)) {
    const arrow = raw.indexOf('-->');
    if (arrow < 0) { const name = raw.trim(); if (name) drawnStates.add(name); continue; }
    const from = raw.slice(0, arrow).trim();
    const to = raw.slice(arrow + 3).split(':')[0].trim();
    for (const x of [from, to]) if (x && x !== '[*]') drawnStates.add(x);
    if (from && to && from !== '[*]' && to !== '[*]') drawn.add(`${from}->${to}`);
  }
  const modelled = new Set(sm.transitions.map((t) => `${t.from}->${t.to}`));
  const states = new Set(sm.states);
  return {
    extra: [...[...drawn].filter((e) => !modelled.has(e)), ...[...drawnStates].filter((x) => !states.has(x)).map((x) => `state ${x}`)],
    missing: [...[...modelled].filter((e) => !drawn.has(e)), ...[...states].filter((x) => !drawnStates.has(x)).map((x) => `state ${x}`)],
  };
}
