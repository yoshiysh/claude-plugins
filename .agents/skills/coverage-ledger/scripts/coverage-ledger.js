export const meta = {
  name: 'coverage-ledger-step',
  description: '台帳の 1 段（plan・generate・review・group のどれか）を 1 回だけ流し、生の結果と起動の記録を返す。台帳を書くのは呼び出し側の CLI',
  requirements: ['read-only', 'fresh-thread'],
  phases: [
    { title: 'plan', detail: '目標の照合・独立な計画役 2 体・統合・入力の振り分け・単位ごとの検証' },
    { title: 'generate', detail: '依存の順に論点ごとの案を出し、書き手 1 体が文書を返す' },
    { title: 'review', detail: '枡ごとに読む役 → 引用の照合 → 別の枠組みの検証役' },
    { title: 'group', detail: '確かめた指摘・出来事を根本原因で束ね、別のモデル 2 体で反証する' },
  ],
  limits: { maxAgents: 60, concurrency: 3, timeoutMs: 12000000, agentTimeoutMs: 600000, maxOutputBytes: 4000000 },
}

// <checks> ここから </checks> までは CLI（ledger-core.mjs）が同じ文を読み込んで使う。静的な照合の正本はここだけ。
// native Workflow は本体に meta を渡さないので写しを置く（一致は tests/coverage-ledger-workflow.test.mjs が照らす）。
const LIMITS = { maxAgents: 60, concurrency: 3, timeoutMs: 12000000, agentTimeoutMs: 600000, maxOutputBytes: 4000000 }
// 1 枡の最悪の起動数（読む役 2 回 + 検証役 2 回）。CLI はこれで 1 回に渡す枡の数を決める。
const PER_CELL = 4
const QUOTE_MIN = 12
const LAYERS = ['方針', '要求', '方式設計', '詳細設計', '実装']
const SEVERITIES = ['HIGH', 'MEDIUM', 'LOW']
const VERDICTS = ['confirmed', 'refuted', 'unverifiable']
const DESTS = ['issue', 'lens', 'exclude', 'user', 'upper_layer', 'lower_layer', 'fixed']
const RESERVED_LENSES = ['purpose', 'layer']
const isStr = (s) => typeof s === 'string' && s.trim().length > 0
// args の写しの照合: 呼び出し側が args を手で運ぶので、key を並べた JSON の FNV-1a で写し違い・切り詰めを見つける。
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v))
function argsSum(a) {
  const s = canon(Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'argsSum')))
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}
const arr = (a) => (Array.isArray(a) ? a : [])
const stripNums = (s) => String(s ?? '').replace(/(^|\n)\s*\d+\| ?/g, '$1')
const norm = (s) => stripNums(s).replace(/\s+/g, ' ').trim()
function quoteProblem(q, text) {
  const n = norm(q)
  const body = norm(text)
  if (!n) return '引用が空'
  if (n.length < QUOTE_MIN && n !== body) return `引用が ${QUOTE_MIN} 字未満`
  if (!body.includes(n)) return '引用が本文に逐語で無い'
  const headings = String(text).split('\n').filter((l) => /^#{1,6}\s/.test(l)).map((l) => norm(l.replace(/^#{1,6}\s*/, '')))
  if (headings.includes(n.replace(/^#{1,6}\s*/, '')) && n !== body) return '見出しだけの引用は読んだ証拠にならない'
  return null
}
function blocksHit(quotes, asset) {
  const lines = String(asset.text).split('\n')
  const hit = new Set()
  for (const q of quotes) {
    if (quoteProblem(q, asset.text)) continue
    asset.blocks.forEach(([s, e], i) => { if (norm(lines.slice(s, e + 1).join('\n')).includes(norm(q))) hit.add(i) })
  }
  return hit
}
function checkRead(rep, asset) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  if (rep.cell_id !== asset.cell_id) p.push(`cell_id が違う: ${rep.cell_id}`)
  arr(rep.evidence).forEach((q, i) => { const e = quoteProblem(q, asset.text); if (e) p.push(`evidence[${i}]: ${e}`) })
  arr(rep.findings).forEach((f, i) => {
    if (!isStr(f && f.claim)) p.push(`findings[${i}]: claim が空`)
    const e = quoteProblem(f && f.quote, asset.text)
    if (e) p.push(`findings[${i}]: ${e}`)
    if (!SEVERITIES.includes(f && f.severity)) p.push(`findings[${i}]: severity が不正`)
    if (!LAYERS.includes(f && f.layer)) p.push(`findings[${i}]: layer が不正`)
  })
  if (!arr(rep.findings).length && !isStr(rep.none_reason)) p.push('指摘が無いのに none_reason が空')
  const hit = blocksHit([...arr(rep.evidence), ...arr(rep.findings).map((f) => f && f.quote)], asset)
  if (hit.size < asset.need) p.push(`読んだ証拠の引用が ${asset.need} 区画のうち ${hit.size} 区画にしか無い`)
  return p
}
function checkVerify(rep, n) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  const seen = new Set()
  for (const v of arr(rep.verdicts)) {
    if (!Number.isInteger(v && v.index) || v.index < 0 || v.index >= n) { p.push(`実在しない指摘への判定: ${v && v.index}`); continue }
    if (seen.has(v.index)) p.push(`判定の重複: ${v.index}`)
    seen.add(v.index)
    if (!VERDICTS.includes(v.verdict)) p.push(`判定 ${v.index} の verdict が不正`)
    if (!isStr(v.reason)) p.push(`判定 ${v.index} の理由が空`)
  }
  for (let i = 0; i < n; i++) if (!seen.has(i)) p.push(`判定の無い指摘: ${i}`)
  return p
}
// 確定・棄却は、検証役の引用が本文に逐語であるときだけ効く。偽の引用での棄却では指摘を消さない。
function settleVerdict(v, text) {
  if (!v || !VERDICTS.includes(v.verdict)) return 'unverifiable'
  if (v.verdict !== 'unverifiable' && quoteProblem(v.quote, text)) return 'unverifiable'
  return v.verdict
}
function hasCycle(units) {
  const by = new Map(units.map((u) => [u.id, u]))
  const st = {}
  const dfs = (v) => {
    if (st[v] === 1) return true
    if (st[v] === 2) return false
    st[v] = 1
    for (const d of arr(by.get(v) && by.get(v).depends_on)) if (by.has(d) && dfs(d)) return true
    st[v] = 2
    return false
  }
  return units.some((u) => dfs(u.id))
}
// 単位の同一性: 中身と送られた入力の集合。どちらかが変われば検証し直す。
function unitKey(u, routes) {
  const keys = Object.keys(u).sort()
  return JSON.stringify([JSON.stringify(u, keys), arr(routes).filter((r) => r.target === u.id).map((r) => r.input_id).sort()])
}
// 単位の検証役に渡す本文: 単位と、送られた入力の全文。CLI も同じ式で作り直して照合する。
function unitText(u, routes, itemTexts) {
  const mine = arr(routes).filter((r) => r.target === u.id).map((r) => r.input_id).sort()
  return `${JSON.stringify(u)}\n${mine.map((id) => `#### ${id}\n${(itemTexts || {})[id] || ''}`).join('\n\n')}`
}
function checkPlan(L, ctx) {
  if (!L || typeof L !== 'object') return ['返り値が無い']
  const p = []
  const ids = new Set()
  const add = (id, what) => { if (!isStr(id)) p.push(`${what} の id が空`); else if (ids.has(id)) p.push(`id の重複: ${id}`); ids.add(id) }
  for (const i of arr(L.issues)) { add(i.id, '論点'); if (!isStr(i.question)) p.push(`${i.id} の question が空`) }
  for (const l of arr(L.lenses)) {
    add(l.id, '観点')
    if (RESERVED_LENSES.includes(l.id) || arr(ctx.givenLensIds).includes(l.id)) p.push(`観点 ${l.id} は既にある観点で、計画役は定義し直せない`)
    if (!isStr(l.procedure)) p.push(`観点 ${l.id} の procedure が空`)
  }
  for (const q of arr(L.questions)) { add(q.id, '質問'); if (!isStr(q.why_value_judgment)) p.push(`質問 ${q.id} に価値判断の理由が無い`) }
  if (ctx.mode === 'create' && !arr(L.issues).length) p.push('論点が 0 件')
  if (!ctx.lensesGiven && !arr(L.lenses).length) p.push('観点が 0 件')
  const issueIds = new Set(arr(L.issues).map((i) => i.id))
  for (const i of arr(L.issues)) for (const d of arr(i.depends_on)) if (!issueIds.has(d)) p.push(`${i.id} の依存先が無い: ${d}`)
  if (hasCycle(arr(L.issues))) p.push('論点の依存が循環している')
  const units = new Set([...issueIds, ...arr(L.lenses).map((l) => l.id), ...RESERVED_LENSES, ...arr(ctx.givenLensIds)])
  const mapped = new Set()
  for (const m of arr(L.constraint_map)) {
    if (!ctx.constraintIds.includes(m.constraint_id)) { p.push(`実在しない制約: ${m.constraint_id}`); continue }
    mapped.add(m.constraint_id)
    const hs = arr(m.handled_by)
    if (!hs.length) p.push(`制約 ${m.constraint_id} の受け皿が空`)
    for (const h of hs) if (!units.has(h)) p.push(`制約 ${m.constraint_id} の受け皿が実在しない: ${h}`)
  }
  for (const c of ctx.constraintIds) if (!mapped.has(c)) p.push(`制約 ${c} の受け皿が無い`)
  if (ctx.sources) {
    const seen = new Set()
    for (const s of arr(L.source_map)) {
      if (!ctx.sources.includes(s.source)) p.push(`source_map に元に無い単位: ${s.source}`)
      seen.add(s.source)
      if (isStr(s.merged_into) === isStr(s.dropped_reason)) p.push(`${s.source} は統合先か落とす理由のどちらか 1 つだけを持つ`)
      if (isStr(s.merged_into) && !ids.has(s.merged_into)) p.push(`${s.source} の統合先が無い: ${s.merged_into}`)
    }
    for (const s of ctx.sources) if (!seen.has(s)) p.push(`source_map に無い元の単位: ${s}`)
  }
  if (ctx.defectCount) {
    const got = new Set()
    for (const d of arr(L.defect_responses)) {
      if (got.has(d.defect_index)) p.push(`欠陥 ${d.defect_index} への応答の重複`)
      got.add(d.defect_index)
      if (!['fixed', 'rejected'].includes(d.action) || !isStr(d.reason)) p.push(`欠陥 ${d.defect_index} への応答が不正`)
    }
    for (let i = 0; i < ctx.defectCount; i++) if (!got.has(i)) p.push(`欠陥 ${i} への応答が無い`)
  }
  return p
}
function checkRoutes(rep, items, ctx) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  const byId = new Map(items.map((i) => [i.id, i]))
  const count = new Map()
  for (const r of arr(rep.routes)) {
    const it = byId.get(r.input_id)
    if (!it) { p.push(`渡していない入力への行き先: ${r.input_id}`); continue }
    count.set(r.input_id, (count.get(r.input_id) || 0) + 1)
    if (!DESTS.includes(r.dest)) p.push(`${r.input_id} の行き先が不正: ${r.dest}`)
    if (r.dest === 'issue' && !ctx.issueIds.includes(r.target)) p.push(`${r.input_id} の論点が無い: ${r.target}`)
    if (r.dest === 'lens' && !ctx.lensIds.includes(r.target)) p.push(`${r.input_id} の観点が無い: ${r.target}`)
    if (['user', 'upper_layer'].includes(r.dest) && !ctx.questionIds.includes(r.target)) p.push(`${r.input_id} の質問が無い: ${r.target}`)
    if (r.dest === 'fixed' && !ctx.constraintIds.includes(r.target)) p.push(`${r.input_id} の行き先が制約の id でない: ${r.target}`)
    if (!['issue', 'lens'].includes(r.dest) && !isStr(r.reason)) p.push(`${r.input_id} の行き先（${r.dest}）に理由が無い`)
    const e = quoteProblem(r.quote, it.text)
    if (e) p.push(`${r.input_id} の引用: ${e}`)
  }
  for (const it of items) if (!count.has(it.id)) p.push(`行き先の無い入力: ${it.id}`)
  for (const [k, n] of count) if (n > 1) p.push(`行き先が 2 つ以上ある入力: ${k}`)
  return p
}
function checkUnitVerdict(rep, unitId, text) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  if (rep.unit_id !== unitId) p.push(`unit_id が違う: ${rep.unit_id}`)
  arr(rep.defects).forEach((d, i) => {
    if (!isStr(d && d.claim)) p.push(`defects[${i}]: claim が空`)
    const e = quoteProblem(d && d.quote, text)
    if (e) p.push(`defects[${i}]: ${e}`)
  })
  return p
}
function checkProposal(rep, issue, items) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  if (rep.issue_id !== issue.id) p.push(`issue_id が違う: ${rep.issue_id}`)
  if (!isStr(rep.decision)) p.push('decision が空')
  if (!isStr(rep.rationale)) p.push('rationale が空')
  const byId = new Map(items.map((i) => [i.id, i]))
  const read = new Map(arr(rep.read).map((r) => [r.input_id, r]))
  for (const it of items) {
    const r = read.get(it.id)
    if (!r) { p.push(`読んだ証拠の無い入力: ${it.id}`); continue }
    const e = quoteProblem(r.quote, it.text)
    if (e) p.push(`${it.id} の引用: ${e}`)
  }
  for (const k of read.keys()) if (!byId.has(k)) p.push(`渡していない入力の引用: ${k}`)
  return p
}
function checkWriter(rep, issueIds, maxSections, defectCount) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  if (!isStr(rep.markdown)) return ['markdown が空']
  const heads = new Set(rep.markdown.split('\n').filter((l) => /^#{1,6}\s/.test(l)).map((l) => norm(l.replace(/^#{1,6}\s*/, ''))))
  const secs = arr(rep.sections)
  if (secs.length > maxSections) p.push(`節が ${secs.length} 個で上限 ${maxSections} を超える`)
  const covered = new Set()
  for (const s of secs) {
    if (!heads.has(norm(s.heading))) p.push(`節「${s.heading}」が markdown の見出しに無い`)
    for (const i of arr(s.issue_ids)) { if (!issueIds.includes(i)) p.push(`節「${s.heading}」の論点が無い: ${i}`); covered.add(i) }
  }
  for (const i of issueIds) if (!covered.has(i)) p.push(`どの節にも入っていない論点: ${i}`)
  if (defectCount) {
    const got = new Set()
    for (const d of arr(rep.defect_responses)) {
      if (got.has(d.defect_index)) p.push(`欠陥 ${d.defect_index} への応答の重複`)
      got.add(d.defect_index)
      if (!['fixed', 'rejected'].includes(d.action) || !isStr(d.reason)) p.push(`欠陥 ${d.defect_index} への応答が不正`)
    }
    for (let i = 0; i < defectCount; i++) if (!got.has(i)) p.push(`欠陥 ${i} への応答が無い`)
  }
  return p
}
function checkGroups(rep, keys) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  const count = new Map()
  const gids = new Set()
  for (const g of arr(rep.groups)) {
    if (!isStr(g.id) || gids.has(g.id)) p.push(`群の id が空か重複: ${g.id}`)
    gids.add(g.id)
    if (!isStr(g.root_cause)) p.push(`群 ${g.id} の root_cause が空`)
    if (!LAYERS.includes(g.layer)) p.push(`群 ${g.id} の layer が不正`)
    for (const k of arr(g.keys)) count.set(k, (count.get(k) || 0) + 1)
  }
  for (const k of arr(rep.unassigned)) count.set(k, (count.get(k) || 0) + 1)
  for (const k of count.keys()) if (!keys.includes(k)) p.push(`実在しない key: ${k}`)
  for (const k of keys) if (!count.has(k)) p.push(`どの群にも無い key: ${k}`)
  for (const [k, n] of count) if (n > 1) p.push(`2 つ以上の群にある key: ${k}`)
  return p
}
// </checks>

const A = typeof args === 'string' ? JSON.parse(args) : args
const agents = []
// agent の失敗（throw）も null に揃え、起動の記録を残す（欠測を黙って落とさない）。
async function call(role, label, prompt, schema) {
  const r = A.roles[role]
  let out = null
  try { out = await agent(prompt, { label, phase: A.stage, schema, model: r.model, effort: r.effort }) } catch (e) { log(`${label}: agent が失敗した（${String((e && e.message) || e).slice(0, 160)}）`) }
  agents.push({ role, label, model: r.model, effort: r.effort, ok: out != null })
  return out
}
// 静的な検査に落ちたら、欠けを添えて 1 回だけやり直す（run 2a の形）。
async function checked(role, label, prompt, schema, check) {
  let r = await call(role, label, prompt, schema)
  let p = check(r)
  if (p.length) {
    const r2 = await call(role, `${label}（やり直し）`, `${prompt}\n\n## 前回の返り値と、静的な検査で見つかった欠け\n欠けを全て直した返り値の全体を返す。\n${p.map((x) => `- ${x}`).join('\n')}\n\n前回の返り値: ${JSON.stringify(r)}`, schema)
    const p2 = check(r2)
    if (r2) { r = r2; p = p2 }
  }
  return { result: r, problems: p }
}
const tokens = () => (typeof budget !== 'undefined' && budget && typeof budget.spent === 'function' ? budget.spent() : null)
const done = (body) => ({ stage: A.stage, call_id: A.callId, ...body, agents, tokens: tokens(), limits: LIMITS })

const argProblems = []
if (!A || typeof A !== 'object') argProblems.push('args が object でない')
else {
  if (!['plan', 'generate', 'review', 'group'].includes(A.stage)) argProblems.push(`stage が不正: ${A.stage}`)
  if (!A.roles || typeof A.roles !== 'object') argProblems.push('roles が無い')
  if (!isStr(A.goal)) argProblems.push('goal が無い')
  if (A.argsSum !== argsSum(A)) argProblems.push('args の写しが next の出力と違う（argsSum が合わない）')
}
if (argProblems.length) return { stage: A && A.stage, status: 'blocked', reason: 'args の検査に落ちた', problems: argProblems, agents: [] }

const HINTS = arr(A.hints).length ? `\n### 利用者のヒント（取り込む）\n${A.hints.map((h) => `- [${h.id}] ${h.text}`).join('\n')}\n` : ''
const COMMON = `
## 共通の前提
- 目的: 見落としを構造で減らす。1 体に任せる量を小さくし、見た範囲を台帳に残し、生成と検証を分ける。あなたはその中の 1 つの役で、受け持ち以外を読まない。
- 固定した目標（変えない）: ${A.goal}
- 固定した制約（変えない。id で指す）:
${arr(A.constraints).map((c) => `  - ${c.id}: ${c.text}`).join('\n') || '  - なし'}
- ファイルは変えない。結果は返り値だけで返す。読めなかったものは推測で埋めず、そう書く。
- 引用は渡した本文からの逐語の写しにする（行番号の「N| 」は含めない）。引用は script が機械で照合し、合わないものは受け付けない。${HINTS}`

// ---------------- plan（run 2a の形: 独立な 2 体 → 統合 → 振り分け → 単位ごとの検証） ----------------
const UNIT_PROPS = {
  issues: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, question: { type: 'string' }, why: { type: 'string' }, depends_on: { type: 'array', items: { type: 'string' } } }, required: ['id', 'title', 'question', 'why', 'depends_on'] } },
  lenses: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, procedure: { type: 'string' } }, required: ['id', 'name', 'procedure'] } },
  questions: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, question: { type: 'string' }, why_value_judgment: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['id', 'question', 'why_value_judgment', 'options'] } },
  constraint_map: { type: 'array', items: { type: 'object', properties: { constraint_id: { type: 'string' }, handled_by: { type: 'array', items: { type: 'string' } } }, required: ['constraint_id', 'handled_by'] } },
}
const PLAN_SCHEMA = { type: 'object', properties: UNIT_PROPS, required: Object.keys(UNIT_PROPS) }
const INTEGRATED_SCHEMA = {
  type: 'object',
  properties: {
    ...UNIT_PROPS,
    source_map: { type: 'array', items: { type: 'object', properties: { source: { type: 'string' }, merged_into: { type: 'string' }, dropped_reason: { type: 'string' } }, required: ['source', 'merged_into', 'dropped_reason'] } },
    defect_responses: { type: 'array', items: { type: 'object', properties: { defect_index: { type: 'integer' }, action: { type: 'string', enum: ['fixed', 'rejected'] }, reason: { type: 'string' } }, required: ['defect_index', 'action', 'reason'] } },
  },
  required: [...Object.keys(UNIT_PROPS), 'source_map', 'defect_responses'],
}
const GOAL_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' }, problems: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, quote: { type: 'string' } }, required: ['claim', 'quote'] } } }, required: ['ok', 'problems'] }
const ROUTE_SCHEMA = { type: 'object', properties: { routes: { type: 'array', items: { type: 'object', properties: { input_id: { type: 'string' }, dest: { type: 'string', enum: DESTS }, target: { type: 'string' }, reason: { type: 'string' }, quote: { type: 'string' } }, required: ['input_id', 'dest', 'target', 'reason', 'quote'] } } }, required: ['routes'] }
const UNIT_VERDICT_SCHEMA = { type: 'object', properties: { unit_id: { type: 'string' }, defects: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, claim: { type: 'string' }, quote: { type: 'string' } }, required: ['kind', 'claim', 'quote'] } } }, required: ['unit_id', 'defects'] }

async function planStage() {
  phase('plan')
  const ctx = { mode: A.mode, constraintIds: arr(A.constraints).map((c) => c.id), lensesGiven: arr(A.givenLenses).length > 0, givenLensIds: arr(A.givenLenses).map((l) => l.id) }
  const out = { goal_check: null, planners: null, plan: arr(A.prevPlan && A.prevPlan.issues).length || arr(A.prevPlan && A.prevPlan.lenses).length ? A.prevPlan : null, plan_problems: [], routes: [], route_problems: [], unit_checks: [] }
  // 固定した目標を、目標を書いていない役が依頼文に照らす（目標の固定）。
  if (!A.goalChecked) {
    out.goal_check = await call('goal_checker', 'goal-check', `${COMMON}
## あなたの役: 目標の照合役
下の依頼文から、範囲と禁止事項と成果物を抜き出し、固定した目標がそれに合うかを確かめる。依頼に無い目標・制約を足していないか、依頼の範囲を狭めていないか、手順を目標にしていないかを見る。合わない点ごとに、依頼文からの逐語の引用を付ける。
## 依頼文
${A.request}`, GOAL_SCHEMA)
  }
  const needUnits = A.mode === 'create' || !ctx.lensesGiven
  if (needUnits && (!out.plan || arr(A.planDefects).length || arr(A.answers).length)) {
    const RULES = `
### 単位の規則
- 単位の数・例・型枠は与えない。入力の中身と目標から切る。
- ${A.mode === 'create' ? '論点（issues）: 1 体が割り当てた入力を読んで 1 回で決められる大きさの問い。上流の結論が無いと決められないものだけ depends_on に書く。循環させない。\n- ' : ''}観点（lenses）: 成果物を節ごとに見るときの手続き（何を列挙し、何と照らすか）。観点 purpose（目的）と layer（層と範囲）はスキルが持つので作らない${ctx.lensesGiven ? `。利用者が渡した観点 ${ctx.givenLensIds.join('・')} も既にある` : ''}。
- 固定した制約の全てに、受け皿の単位を constraint_map で付ける。
- 利用者への質問（questions）: 価値判断が要り、制約で答えが出ていないものだけ。`
    const INDEX = `### 入力の索引（id・種類・冒頭。全文は振り分けの段で別の役が読む）\n${arr(A.index).map((i) => `- ${i.id} [${i.kind}] ${i.head}`).join('\n') || '（入力なし）'}`
    let integ
    if (!out.plan) {
      const planPrompt = (who) => `${COMMON}
## あなたの役: 計画役 ${who}
もう 1 体の計画役が同じ入力から独立に作る。相手の結果は見ない。後で script が差を取り、統合役が調停する。単位の一覧は、この作業を分担して決め・見るための分母になる。
${RULES}
${INDEX}`
      const check = (r) => checkPlan(r, ctx)
      const [pa, pb] = await parallel([
        () => checked('planner_a', 'plan-A', planPrompt('A'), PLAN_SCHEMA, check),
        () => checked('planner_b', 'plan-B', planPrompt('B'), PLAN_SCHEMA, check),
      ])
      out.planners = { A: pa, B: pb }
      const ok = [['A', pa], ['B', pb]].filter(([, x]) => x && x.result)
      if (!ok.length) return { ...out, status: 'blocked', reason: '計画役が 2 体とも返らなかった' }
      const sources = ok.flatMap(([w, x]) => [...arr(x.result.issues), ...arr(x.result.lenses)].map((u) => `${w}:${u.id}`))
      integ = await checked('integrator', 'integrate', `${COMMON}
## あなたの役: 統合役
互いを見ずに作った ${ok.map(([w]) => w).join(' と ')} を 1 つにする。どちらかを丸ごと採らず、目標と入力に照らして決める。全ての元の単位に、統合先（merged_into）か落とす理由（dropped_reason）を source_map で付ける。片方にしか無い単位を黙って落とさない。
${RULES}
${INDEX}
${ok.map(([w, x]) => `### ${w}（静的な検査の残り ${x.problems.length} 件${x.problems.length ? ': ' + x.problems.join(' / ') : ''}）\n${JSON.stringify(x.result)}`).join('\n')}
（defect_responses は空の配列にする）`, INTEGRATED_SCHEMA, (r) => checkPlan(r, { ...ctx, sources }))
    } else {
      const defects = arr(A.planDefects)
      integ = await checked('integrator', 'integrate-again', `${COMMON}
## あなたの役: 統合役（前の計画の見直し）
前の計画に、単位ごとの検証役が出した欠陥と、利用者の回答がある。欠陥の主張が正しいとは限らない。全ての欠陥について入力に照らし、直した（fixed）か根拠を挙げて退けた（rejected）かを defect_responses に返す。重さで選ばない。欠陥に関係しない単位は id も中身も変えない（変えた単位だけが検証し直される）。
${RULES}
${INDEX}
### 前の計画
${JSON.stringify(out.plan)}
### 欠陥（index は配列の位置）
${JSON.stringify(defects.map((d, i) => ({ index: i, ...d })))}
### 利用者の回答
${JSON.stringify(arr(A.answers))}
（source_map は前の計画の単位を「P:<id>」で全て挙げる）`, INTEGRATED_SCHEMA, (r) => checkPlan(r, { ...ctx, sources: [...arr(out.plan.issues), ...arr(out.plan.lenses)].map((u) => `P:${u.id}`), defectCount: defects.length }))
    }
    out.plan = integ.result
    out.plan_problems = integ.problems
    if (!integ.result) return { ...out, status: 'blocked', reason: '統合役が返らなかった' }
  }
  const plan = out.plan || { issues: [], lenses: [], questions: [], constraint_map: [] }
  const ids = { issueIds: arr(plan.issues).map((i) => i.id), lensIds: [...RESERVED_LENSES, ...ctx.givenLensIds, ...arr(plan.lenses).map((l) => l.id)], questionIds: arr(plan.questions).map((q) => q.id), constraintIds: ctx.constraintIds }
  // 入力は全文を小さい束で読む役に分け、1 項目 1 つの行き先と原文の引用を付けさせる（読みを自己申告に任せない）。
  const batches = arr(A.routeBatches)
  const routed = await pipeline(batches.map((items, bi) => ({ items, bi })), ({ items, bi }) => checked('router', `route-${bi + 1}`, `${COMMON}
## あなたの役: 振り分け役（下の入力 ${items.length} 件だけ）
各入力の全文を読み、行き先をちょうど 1 つ付ける。issue（論点で扱う。target は論点の id）・lens（観点で使う規準。target は観点の id）・exclude（扱わない）・user / upper_layer（利用者に返す。target は質問の id）・lower_layer（下の層で決める）・fixed（制約で決まっている。target は制約の id）。issue と lens 以外は理由を書く。読んだ証拠に、その入力からの逐語の引用を quote に付ける。
### 単位
${JSON.stringify({ issues: arr(plan.issues).map((i) => ({ id: i.id, title: i.title, question: i.question })), lenses: ids.lensIds, questions: arr(plan.questions).map((q) => ({ id: q.id, question: q.question })) })}
### 入力（全文）
${items.map((i) => `#### ${i.id} [${i.kind}]\n${i.text}`).join('\n\n')}`, ROUTE_SCHEMA, (r) => checkRoutes(r, items, ids)))
  routed.forEach((x, bi) => {
    const r = x || { result: null, problems: ['返り値が無い'] }
    out.routes.push(...arr(r.result && r.result.routes).filter((z) => batches[bi].some((i) => i.id === z.input_id)))
    out.route_problems.push(...r.problems.map((p) => `束 ${bi + 1}: ${p}`))
  })
  // 単位ごとに、新しい context の検証役が欠陥を探す（台帳の全体を 1 体に見せない。中身が変わった単位だけを見る）。
  const newIds = new Set(out.routes.map((r) => r.input_id))
  const allRoutes = [...arr(A.prevRoutes).filter((r) => !newIds.has(r.input_id)), ...out.routes]
  const verified = new Set(arr(A.verifiedKeys))
  const units = A.verifyUnits === false ? [] : [...arr(plan.issues).map((u) => ({ kind: 'issue', u })), ...arr(plan.lenses).map((u) => ({ kind: 'lens', u }))]
    .filter(({ u }) => !verified.has(unitKey(u, allRoutes)))
  const maxUnits = Math.max(0, Math.floor((LIMITS.maxAgents - agents.length) / 2))
  const toVerify = units.slice(0, maxUnits)
  const checks = await pipeline(toVerify, ({ kind, u }) => {
    const text = unitText(u, allRoutes, A.itemTexts)
    return checked('unit_verifier', `verify-unit-${u.id}`, `${COMMON}
## あなたの役: 単位の検証役（反証側。単位 ${u.id} だけを見る）
この単位には欠陥があるという前提で読む。作った者の説明を信じない。見るもの: 1 体で決められない大きさ・問いが 2 つ以上・依存の誤り・層の誤り（上の層の決め直し、下の層の細部）・制約との矛盾・送られた入力がこの単位で扱えないもの・目標に効かない単位。良い点は書かない。欠陥ごとに、下の本文からの逐語の引用を付ける。
### 種類: ${kind}
### 本文（単位と、送られた入力の全文）
${text}`, UNIT_VERDICT_SCHEMA, (r) => checkUnitVerdict(r, u.id, text)).then((x) => ({ unit_id: u.id, key: unitKey(u, allRoutes), ...x }))
  })
  out.unit_checks = checks.map((x, i) => x || { unit_id: toVerify[i].u.id, key: unitKey(toVerify[i].u, allRoutes), result: null, problems: ['pipeline が null を返した'] })
  out.units_not_verified = units.slice(maxUnits).map(({ u }) => u.id)
  return { ...out, status: 'ok' }
}

// ---------------- generate（1 周目の S2・S3: 論点ごとの案 → 書き手 1 体） ----------------
const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    issue_id: { type: 'string' }, decision: { type: 'string' }, rationale: { type: 'string' },
    alternatives: { type: 'array', items: { type: 'object', properties: { option: { type: 'string' }, why_rejected: { type: 'string' } }, required: ['option', 'why_rejected'] } },
    assumptions: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, how_to_verify: { type: 'string' } }, required: ['claim', 'how_to_verify'] } },
    read: { type: 'array', items: { type: 'object', properties: { input_id: { type: 'string' }, quote: { type: 'string' } }, required: ['input_id', 'quote'] } },
    open_questions_for_user: { type: 'array', items: { type: 'string' } },
  },
  required: ['issue_id', 'decision', 'rationale', 'alternatives', 'assumptions', 'read', 'open_questions_for_user'],
}
const WRITER_SCHEMA = {
  type: 'object',
  properties: {
    markdown: { type: 'string' },
    sections: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, issue_ids: { type: 'array', items: { type: 'string' } } }, required: ['heading', 'issue_ids'] } },
    conflicts_between_issues: { type: 'array', items: { type: 'string' } },
    defect_responses: { type: 'array', items: { type: 'object', properties: { defect_index: { type: 'integer' }, action: { type: 'string', enum: ['fixed', 'rejected'] }, reason: { type: 'string' } }, required: ['defect_index', 'action', 'reason'] } },
  },
  required: ['markdown', 'sections', 'conflicts_between_issues', 'defect_responses'],
}
function waves(issues, accepted) {
  const left = new Map(issues.map((i) => [i.id, i]))
  const out = []
  const ok = new Set(Object.keys(accepted || {}))
  while (left.size) {
    const w = [...left.values()].filter((i) => arr(i.depends_on).every((d) => ok.has(d) || !left.has(d)))
    if (!w.length) break
    out.push(w)
    for (const i of w) { left.delete(i.id); ok.add(i.id) }
  }
  return { waves: out, stuck: [...left.keys()] }
}
async function generateStage() {
  phase('generate')
  const accepted = { ...(A.accepted || {}) }
  const results = []
  const { waves: ws, stuck } = waves(arr(A.issues), accepted)
  for (const w of ws) {
    // 依存のある論点は前の波の後に走らせ、上流の案の中身を渡す（合議させずに受け渡す）。
    const got = await parallel(w.map((it) => () => {
      const items = arr(it.items)
      const upstream = arr(it.depends_on).map((d) => accepted[d]).filter(Boolean)
      const defects = arr(it.defects)
      return checked('proposer', `propose-${it.id}`, `${COMMON}
## あなたの役: 実行役（論点 ${it.id} だけ）
論点: ${it.title}
問い: ${it.question}
なぜ決めるか: ${it.why}
この論点の案を 1 つ決め、理由・退けた案・未確認の前提（確かめ方）を返す。利用者の価値判断が要るものだけを open_questions_for_user に挙げる。下の入力の全てについて、読んだ証拠に逐語の引用を read に付ける。
### 上流の論点の案（前提にする。決め直さない）
${JSON.stringify(upstream)}
${defects.length ? `### この論点に戻ってきた欠陥（直す）\n${JSON.stringify(defects)}\n### 前の案\n${JSON.stringify(it.prev || null)}` : ''}
### 入力（全文）
${items.map((i) => `#### ${i.id} [${i.kind}]\n${i.text}`).join('\n\n') || '（なし）'}`, PROPOSAL_SCHEMA, (r) => checkProposal(r, it, items)).then((x) => ({ issue_id: it.id, ...x }))
    }))
    for (const x of got) {
      results.push(x)
      if (x && x.result && !x.problems.length) accepted[x.issue_id] = x.result
    }
  }
  const missing = arr(A.allIssueIds).filter((id) => !accepted[id])
  let writer = null
  if (A.writeAfter && !missing.length) {
    const defects = arr(A.writerDefects)
    writer = await checked('writer', 'write', `${COMMON}
## あなたの役: 書き手（この段で唯一の書き手。成果物の全文を markdown で返す。script がファイルに書く）
下の論点ごとの案から成果物を書く。節は ${A.maxSections} 個まで。節ごとに、どの論点から来たか（issue_ids）を返し、全ての論点をどれかの節に入れる。論点どうしの食い違いは黙って寄せず、conflicts_between_issues に挙げ、本文では未決として書く。強調や例外の積み上げをしない。
### 書き方
${A.writing || ''}
### 論点と案
${JSON.stringify(arr(A.allIssueIds).map((id) => ({ issue: arr(A.issueTitles).find((t) => t.id === id) || { id }, proposal: accepted[id] })))}
${A.prevMarkdown ? `### 前の成果物（直す。欠陥に関係しない所は変えない）\n${A.prevMarkdown}` : ''}
${defects.length ? `### 成果物に戻ってきた欠陥（index は配列の位置。全てに fixed か rejected と理由を返す）\n${JSON.stringify(defects.map((d, i) => ({ index: i, ...d })))}` : '（defect_responses は空の配列にする）'}`, WRITER_SCHEMA, (r) => checkWriter(r, arr(A.allIssueIds), A.maxSections, defects.length))
  }
  return { status: 'ok', proposals: results.filter(Boolean), stuck, missing, writer }
}

// ---------------- review（1 周目の S4・S5 と、run 2a の学び: 枡ごとに検証する） ----------------
const READ_SCHEMA = {
  type: 'object',
  properties: {
    cell_id: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, quote: { type: 'string' }, severity: { type: 'string', enum: SEVERITIES }, layer: { type: 'string', enum: LAYERS } }, required: ['claim', 'quote', 'severity', 'layer'] } },
    outside_notes: { type: 'array', items: { type: 'string' } },
    none_reason: { type: 'string' },
  },
  required: ['cell_id', 'evidence', 'findings', 'outside_notes', 'none_reason'],
}
const VERIFY_SCHEMA = { type: 'object', properties: { verdicts: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, verdict: { type: 'string', enum: VERDICTS }, reason: { type: 'string' }, quote: { type: 'string' } }, required: ['index', 'verdict', 'reason', 'quote'] } } }, required: ['verdicts'] }
const numbered = (c) => String(c.text).split('\n').map((l, i) => `${c.start + i}| ${l}`).join('\n')
async function reviewStage() {
  phase('review')
  const cells = arr(A.cells).slice(0, Math.floor(LIMITS.maxAgents / PER_CELL))
  const rows = await pipeline(cells, async (c) => {
    const role = `reader_${c.pass}` in A.roles ? `reader_${c.pass}` : 'reader_1'
    const rd = await checked(role, `read-${c.cell_id}`, `${COMMON}
## あなたの役: 読む役（枡 ${c.cell_id} だけ。下の本文の外は読まない）
観点: ${c.lens.name}
手続き: ${c.lens.procedure}
${arr(c.lens.items).length ? `この観点の規準（入力の全文）:\n${c.lens.items.map((i) => `- ${i.id}: ${i.text}`).join('\n')}\n` : ''}- 手続きに沿って本文を全て読み、本文の各部分から逐語の引用を evidence に挙げる（読んだ範囲の証拠。script が本文の区画ごとに照合する）。
- 観点に当たる欠陥を、逐語の引用（quote）・重さ・原因の層（${LAYERS.join('・')}）と共に findings に返す。層は、直すべき層を選ぶ（本文の層とは限らない）。
- 観点の外で気づいたことは指摘にせず outside_notes に書く。
- 指摘が無ければ、確かめたことを none_reason に書く。
### 本文（${c.path} の ${c.start} 行目から）
${numbered(c)}`, READ_SCHEMA, (r) => checkRead(r, c))
    const fs = rd.result && !rd.problems.length ? arr(rd.result.findings) : []
    let vf = null
    if (fs.length) {
      // 検証役は生成と別の枠組み（反証側）で、新しい context で、同じ枡の本文だけを読む。
      vf = await checked('verifier', `verify-${c.cell_id}`, `${COMMON}
## あなたの役: 検証役（反証側。枡 ${c.cell_id} の指摘だけ）
下の指摘はどれも誤りかもしれないという前提で、本文に当たって確かめる。指摘ごとに confirmed（本文が主張を支える）・refuted（本文が主張を否定する）・unverifiable（本文だけでは決められない）を返す。confirmed と refuted には、決め手になった本文の逐語の引用を quote に付ける（引用が合わない判定は unverifiable として扱われる）。
観点: ${c.lens.name}
### 指摘（index は配列の位置）
${JSON.stringify(fs.map((f, i) => ({ index: i, claim: f.claim, quote: f.quote, severity: f.severity, layer: f.layer })))}
### 本文（${c.path} の ${c.start} 行目から）
${numbered(c)}`, VERIFY_SCHEMA, (r) => checkVerify(r, fs.length))
    }
    return { cell_id: c.cell_id, read: rd.result, read_problems: rd.problems, verify: vf && vf.result, verify_problems: vf ? vf.problems : [] }
  })
  const left = arr(A.cells).slice(cells.length).map((c) => c.cell_id)
  return { status: 'ok', cells: rows.map((r, i) => r || { cell_id: cells[i].cell_id, read: null, read_problems: ['pipeline が null を返した'], verify: null, verify_problems: [] }), not_run: left }
}

// ---------------- group（1 周目の S6 と振り返りの束ね・反証） ----------------
const GROUP_SCHEMA = {
  type: 'object',
  properties: {
    groups: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, root_cause: { type: 'string' }, layer: { type: 'string', enum: LAYERS }, keys: { type: 'array', items: { type: 'string' } }, pattern: { type: 'string' } }, required: ['id', 'root_cause', 'layer', 'keys', 'pattern'] } },
    unassigned: { type: 'array', items: { type: 'string' } },
  },
  required: ['groups', 'unassigned'],
}
const REFUTE_SCHEMA = { type: 'object', properties: { group_id: { type: 'string' }, refuted: { type: 'boolean' }, reason: { type: 'string' } }, required: ['group_id', 'refuted', 'reason'] }
async function groupStage() {
  phase('group')
  const items = arr(A.items)
  const keys = items.map((x) => x.key)
  const g = await checked('grouper', 'group', `${COMMON}
## あなたの役: 束ね役
下の全件（確かめた指摘と、悪かった出来事）を根本原因で束ねる。症状でなく原因で束ね、全ての key をちょうど 1 つの群に入れる（入れられないものは unassigned）。重さで絞らない。群ごとに、直すべき層（${LAYERS.join('・')}）を選び、同じ型の欠陥を全ての資産へ問い直すための手続き（何を列挙し、何と照らすか）を pattern に書く（型にならない群は空文字）。
### 全件
${JSON.stringify(items)}`, GROUP_SCHEMA, (r) => checkGroups(r, keys))
  if (!g.result) return { status: 'blocked', reason: '束ね役が返らなかった', problems: g.problems }
  const byKey = new Map(items.map((x) => [x.key, x]))
  const groups = arr(g.result.groups).slice(0, Math.floor((LIMITS.maxAgents - agents.length) / 2))
  const refPrompt = (gr) => `${COMMON}
## あなたの役: 反証役
下の根本原因の主張が誤りではないかを探す。記録の事実と合わない・原因でなく症状の言い換え・固定した制約の蒸し返し、のどれかなら refuted=true。確かめられなければ refuted=false とし、理由に「確かめられない」と書く。
### 群 ${gr.id}（層: ${gr.layer}）
根本原因: ${gr.root_cause}
含むもの:
${arr(gr.keys).map((k) => `- ${k}: ${JSON.stringify(byKey.get(k) || null)}`).join('\n')}`
  const judged = await pipeline(groups, (gr) => parallel([
    () => call('refuter_a', `refute-${gr.id}-a`, refPrompt(gr), REFUTE_SCHEMA),
    () => call('refuter_b', `refute-${gr.id}-b`, refPrompt(gr), REFUTE_SCHEMA),
  ]).then((vs) => {
    const v = vs.filter(Boolean)
    const n = v.filter((x) => x.refuted).length
    return { group: gr, votes: v, status: v.length < 2 ? 'unverified' : n === 2 ? 'refuted' : n === 1 ? 'split' : 'kept' }
  }))
  return { status: 'ok', grouping: g.result, grouping_problems: g.problems, judged: judged.filter(Boolean), not_refuted: arr(g.result.groups).slice(groups.length).map((x) => x.id) }
}

const body = A.stage === 'plan' ? await planStage() : A.stage === 'generate' ? await generateStage() : A.stage === 'review' ? await reviewStage() : await groupStage()
return done(body)
