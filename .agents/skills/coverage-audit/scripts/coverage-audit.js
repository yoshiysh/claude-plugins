export const meta = {
  name: 'coverage-audit-step',
  description: '台帳の 1 段（plan・review・group のどれか）を 1 回だけ流し、生の結果と起動の記録を返す。台帳を書くのは呼び出し側の CLI',
  requirements: ['read-only', 'fresh-thread'],
  phases: [
    { title: 'plan', detail: '目標の照合・独立な計画役 2 体・統合・観点ごとの検証' },
    { title: 'review', detail: '枡ごとに読む役 → 形の照合 → 別のモデル・反証側の検証役' },
    { title: 'group', detail: '確かめた指摘を根本原因で束ね、別のモデル 2 体で反証する' },
  ],
  limits: { maxAgents: 60, concurrency: 3, timeoutMs: 12000000, agentTimeoutMs: 600000, maxOutputBytes: 4000000 },
}

// <checks> ここから </checks> までは CLI（ledger-core.mjs）が同じ文を読み込んで使う。静的な照合の正本はここだけ。
// native Workflow は本体に meta を渡さないので写しを置く（一致は tests/coverage-audit-workflow.test.mjs が照らす）。
const LIMITS = { maxAgents: 60, concurrency: 3, timeoutMs: 12000000, agentTimeoutMs: 600000, maxOutputBytes: 4000000 }
// 1 枡の最悪の起動数（読む役 2 回 + 検証役 2 回）。CLI はこれで 1 回に渡す枡の数を決める。
const PER_CELL = 4
const QUOTE_MIN = 12
const LAYERS = ['方針', '要求', '方式設計', '詳細設計', '実装']
const SEVERITIES = ['HIGH', 'MEDIUM', 'LOW']
const VERDICTS = ['confirmed', 'refuted', 'unverifiable']
const DEFECT_ACTIONS = ['fixed', 'rejected']
const RESERVED_LENSES = ['purpose', 'layer']
const isStr = (s) => typeof s === 'string' && s.trim().length > 0
const arr = (a) => (Array.isArray(a) ? a : [])
// 値を key の順に並べた JSON にして FNV-1a を取る。args の写し違いの検出と、観点の同一性に使う。
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v))
function fnv(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}
const argsSum = (a) => fnv(canon(Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'argsSum'))))
// 行番号は外して照らす（「N| 」の形と、Read の「   N\t」の形）。
const stripNums = (s) => String(s ?? '').replace(/(^|\n)[ \t]*\d+(\| ?|\t)/g, '$1')
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
// 読みの形だけの照合。Workflow は本文を持たないので、ここまでを Workflow の中で照らしてやり直させる。
function checkReadShape(rep, cellId) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  if (rep.cell_id !== cellId) p.push(`cell_id が違う: ${rep.cell_id}`)
  if (!arr(rep.evidence).length && !arr(rep.findings).length) p.push('読んだ証拠の引用が無い')
  arr(rep.findings).forEach((f, i) => {
    if (!isStr(f && f.claim)) p.push(`findings[${i}]: claim が空`)
    if (!isStr(f && f.quote)) p.push(`findings[${i}]: quote が空`)
    if (!SEVERITIES.includes(f && f.severity)) p.push(`findings[${i}]: severity が不正`)
    if (!LAYERS.includes(f && f.layer)) p.push(`findings[${i}]: layer が不正`)
  })
  if (!arr(rep.findings).length && !isStr(rep.none_reason)) p.push('指摘が無いのに none_reason が空')
  return p
}
// 読みの全ての照合。CLI の ingest が、args の hash と合う写しの本文に対して使う。
function checkRead(rep, asset) {
  const p = checkReadShape(rep, asset.cell_id)
  if (!rep || typeof rep !== 'object') return p
  arr(rep.evidence).forEach((q, i) => { const e = quoteProblem(q, asset.text); if (e) p.push(`evidence[${i}]: ${e}`) })
  arr(rep.findings).forEach((f, i) => { const e = quoteProblem(f && f.quote, asset.text); if (e) p.push(`findings[${i}]: ${e}`) })
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
// 観点の同一性: 中身が変われば検証し直す。
const unitKey = (u) => fnv(canon(u))
const unitText = (u) => JSON.stringify(u)
function checkPlan(L, ctx) {
  if (!L || typeof L !== 'object') return ['返り値が無い']
  const p = []
  const ids = new Set()
  const add = (id, what) => { if (!isStr(id)) p.push(`${what} の id が空`); else if (ids.has(id)) p.push(`id の重複: ${id}`); ids.add(id) }
  for (const l of arr(L.lenses)) {
    add(l.id, '観点')
    if (RESERVED_LENSES.includes(l.id) || arr(ctx.givenLensIds).includes(l.id)) p.push(`観点 ${l.id} は既にある観点で、計画役は定義し直せない`)
    if (!isStr(l.procedure)) p.push(`観点 ${l.id} の procedure が空`)
  }
  for (const q of arr(L.questions)) { add(q.id, '質問'); if (!isStr(q.why_value_judgment)) p.push(`質問 ${q.id} に価値判断の理由が無い`) }
  if (!ctx.lensesGiven && !arr(L.lenses).length) p.push('観点が 0 件')
  const units = new Set([...arr(L.lenses).map((l) => l.id), ...RESERVED_LENSES, ...arr(ctx.givenLensIds)])
  const mapped = new Set()
  for (const m of arr(L.constraint_map)) {
    if (!arr(ctx.constraintIds).includes(m.constraint_id)) { p.push(`実在しない制約: ${m.constraint_id}`); continue }
    mapped.add(m.constraint_id)
    const hs = arr(m.handled_by)
    if (!hs.length) p.push(`制約 ${m.constraint_id} の受け皿が空`)
    for (const h of hs) if (!units.has(h)) p.push(`制約 ${m.constraint_id} の受け皿が実在しない: ${h}`)
  }
  for (const c of arr(ctx.constraintIds)) if (!mapped.has(c)) p.push(`制約 ${c} の受け皿が無い`)
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
      if (!DEFECT_ACTIONS.includes(d.action) || !isStr(d.reason)) p.push(`欠陥 ${d.defect_index} への応答が不正`)
    }
    for (let i = 0; i < ctx.defectCount; i++) if (!got.has(i)) p.push(`欠陥 ${i} への応答が無い`)
  }
  return p
}
// text を渡さないと引用の形だけを照らす（Workflow が観点の本文を持たない束の渡し方。逐語かは CLI の ingest が照らす）。
function checkUnitVerdict(rep, unitId, text) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  if (rep.unit_id !== unitId) p.push(`unit_id が違う: ${rep.unit_id}`)
  arr(rep.defects).forEach((d, i) => {
    if (!isStr(d && d.claim)) p.push(`defects[${i}]: claim が空`)
    const e = text == null ? (isStr(d && d.quote) ? null : '引用が空') : quoteProblem(d && d.quote, text)
    if (e) p.push(`defects[${i}]: ${e}`)
  })
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
// 束ねに渡す指摘の key。指摘は写しのファイルで渡すので、args には件数だけを載せる。
const groupKeys = (n) => Array.from({ length: n }, (_, i) => `K${i + 1}`)
// <goalmap> 目標・基準・制約の引用と、目標の照合役の返り値の静的な照合。coverage-build と coverage-audit の Workflow source に同じ文がある
// （2 つのスキルは互いのファイルを読まないので写しを置く。一致は tests/coverage-build-goalmap.test.mjs が照らす）。norm・isStr・arr だけを使う。
const CITE_MIN = 12
const CITE_TAIL = /〔\s*([A-Za-z]+)\s*[:：]\s*([^〔〕]*?)\s*〕\s*$/
// 1 行 1 件:「- ID: 本文 〔request: 逐語の引用〕」。引用は行の末尾に 1 つ以上並べ、引用元は request（依頼文）か decisions（決定の記録）。
// 空行と見出しの行は読み飛ばし、それ以外の「- 」で始まらない行は prose に行番号を返す（受け付けるかは呼び出し側が決める）。
function parseCited(text, prefix) {
  const items = []
  const problems = []
  const prose = []
  String(text ?? '').split('\n').forEach((line, i) => {
    if (!line.trim() || /^#{1,6}\s/.test(line)) return
    const m = /^-\s+(.*)$/.exec(line)
    if (!m) { prose.push(i + 1); return }
    let body = m[1].trim()
    const cites = []
    for (let c; (c = CITE_TAIL.exec(body));) {
      cites.unshift({ source: c[1], quote: c[2] })
      body = body.slice(0, c.index).trim()
    }
    const idm = /^([A-Z][A-Z0-9]*\d)[:：]\s*(.*)$/.exec(body)
    items.push({ ...(idm ? { id: idm[1], text: idm[2] } : { id: `${prefix}${items.length + 1}`, text: body }), cites })
  })
  const ids = items.map((x) => x.id)
  for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) problems.push(`${prefix} の id が重複している: ${id}`)
  return { items, problems, prose }
}
// 引用元の本文。sources は { request: 文字列, decisions: 文字列 }（decisions は無ければ省く）。
// 短い引用は、引用元の 1 件（依頼文の全体か、依頼文の空でない 1 行、決定の記録の 1 行）の全体を引くときだけ受け付ける（前後の空白は除く）。
function citeSources(sources) {
  const out = {}
  for (const [k, t] of Object.entries(sources || {})) {
    if (typeof t !== 'string') continue
    const bullets = t.split('\n').map((l) => /^-\s+(.*)$/.exec(l)).filter(Boolean).map((m) => m[1].replace(/^[A-Z][A-Z0-9]*\d[:：]\s*/, ''))
    const rows = k === 'request' ? t.split('\n').filter((l) => l.trim()) : []
    out[k] = { text: norm(t), whole: [norm(t), ...[...bullets, ...rows].map(norm)] }
  }
  return out
}
function citeProblem(c, src) {
  const s = src[c && c.source]
  if (!s) return `引用元が ${Object.keys(src).join('・')} のどれでもない: ${c && c.source}`
  const n = norm(c.quote)
  if (!n) return '引用が空'
  if (!s.text.includes(n)) return `引用が ${c.source} に逐語で無い: ${n.slice(0, 40)}`
  if (n.length < CITE_MIN && !s.whole.includes(n)) return `引用が ${CITE_MIN} 字未満（引用元の 1 件の全体を引くときを除く。依頼文は空でない 1 行の全体も 1 件）: ${n}`
  return null
}
// 項目ごとに、引用が 1 つ以上あり、全ての引用が引用元に逐語であるか。
function checkCited(items, src) {
  const p = []
  for (const it of arr(items)) {
    if (!isStr(it.text)) p.push(`${it.id}: 本文が空`)
    if (!arr(it.cites).length) p.push(`${it.id}: 引用が無い（行の末尾に〔request: …〕か〔decisions: …〕を付ける）`)
    for (const c of arr(it.cites)) { const e = citeProblem(c, src); if (e) p.push(`${it.id}: ${e}`) }
  }
  return p
}
// 目標の照合役の返り値: 依頼文と決定の記録から求められている成果を引用つきで列挙し、受け止める項目の id を付ける。
// src を渡すと引用も照らす（Workflow は本文を持たないので形と id だけ、CLI が引用まで照らす）。
function checkGoalMap(rep, ids, src) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  const os = arr(rep.outcomes)
  if (!os.length) p.push('成果が 0 件（依頼文と決定の記録から、求められている成果を全て挙げる）')
  os.forEach((o, i) => {
    if (!isStr(o && o.outcome)) p.push(`outcomes[${i}]: outcome が空`)
    if (!arr(o && o.quotes).length) p.push(`outcomes[${i}]: 引用が無い`)
    if (src) arr(o && o.quotes).forEach((c, j) => { const e = citeProblem(c, src); if (e) p.push(`outcomes[${i}].quotes[${j}]: ${e}`) })
    for (const id of arr(o && o.items)) if (!arr(ids).includes(id)) p.push(`outcomes[${i}]: 実在しない項目の id: ${id}`)
  })
  return p
}
// どの項目にも受け止められていない成果（落とした要求）。
const goalGaps = (rep) => arr(rep && rep.outcomes).filter((o) => !arr(o.items).length).map((o) => ({ outcome: o.outcome, quotes: o.quotes }))
// 目標・基準・制約のファイルを読み、引用を照らす（init と answer が使う。problems が空でなければ台帳を変えない）。
// checkedBy（呼ぶ側のスキルが照合済み）のときは引用を照らさず、目標のファイルの「- 」で始まらない行を呼ぶ側の書いた検査の枠として受け付ける。
function readGoalFiles({ goal, criteria = '', constraints = '', request, decisions = null }, { checkedBy = null } = {}) {
  const g = parseCited(goal, 'G')
  const a = parseCited(criteria, 'AC')
  const d = parseCited(constraints, 'D')
  const files = [...(checkedBy ? [] : [['goal.md', g]]), ['criteria.md', a], ['constraints.md', d], ...(decisions != null && !checkedBy ? [['decisions.md', parseCited(decisions, 'K')]] : [])]
  const problems = [...g.problems, ...a.problems, ...d.problems, ...files.flatMap(([f, x]) => x.prose.map((n) => `${f} の ${n} 行目が「- 」で始まらない（1 行 1 件で書く）`))]
  const all = [...g.items, ...a.items, ...d.items]
  const ids = all.map((x) => x.id)
  for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) problems.push(`目標・基準・制約の id が重なる: ${id}`)
  if (!g.items.length) problems.push('goal.md に目標が 1 件も無い')
  if (!checkedBy) problems.push(...checkCited(all, citeSources({ request, ...(decisions != null ? { decisions } : {}) })))
  return { goal: g.items, criteria: a.items, constraints: d.items, problems }
}
// </goalmap>
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
// 静的な検査に落ちたら、欠けを添えて 1 回だけやり直す。
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
  if (!['plan', 'review', 'group'].includes(A.stage)) argProblems.push(`stage が不正: ${A.stage}`)
  if (!A.roles || typeof A.roles !== 'object') argProblems.push('roles が無い')
  if (A.argsSum !== argsSum(A)) argProblems.push('args の写しが next の出力と違う（argsSum が合わない）')
}
if (argProblems.length) return { stage: A && A.stage, call_id: A && A.callId, status: 'blocked', reason: 'args の検査に落ちた', problems: argProblems, agents: [] }

// 写しのファイルの読み方。本文は args に載らないので、担当が Read で自分の範囲だけを読む。
const rangeOf = (r) => `写し: ${r.snapshot}\n行: ${r.start}-${r.end}（Read の offset=${r.start}, limit=${r.end - r.start + 1}。この範囲の外は読まない）`
// 担当が読む文（目標・基準・制約・ヒント、段ごとの依頼文・前の計画・欠陥・回答・観点の手続き）は束（brief）の写しにあり、args には参照だけがある。
const COMMON = (b) => `
## 共通の前提
- 目的: 対象を資産 × 観点の枡に分けて網羅的に検査し、見落としと見ていない所を台帳に残す。検査だけをし、対象を直さない・書かない。あなたはその中の 1 つの役で、受け持ち以外を読まない。
- 依頼の束: まず Read で下のファイルを全て読む。固定した目標（変えない。constraint_map の対象ではない）・受け入れ基準と固定した制約（id で指す）・利用者のヒント（あれば取り込む）と、この役に要る文はそこにある。束に無いことを推測で埋めない。
束: ${b.snapshot}（hash ${b.hash}）
- ファイルは変えない。結果は返り値だけで返す。読めなかったものは推測で埋めず、そう書く。
- 引用は読んだ本文からの逐語の写しにする（行番号は含めない）。引用は script が機械で照合し、合わないものは受け付けない。
`

// ---------------- plan（独立な 2 体 → 統合 → 観点ごとの検証） ----------------
const UNIT_PROPS = {
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
    defect_responses: { type: 'array', items: { type: 'object', properties: { defect_index: { type: 'integer' }, action: { type: 'string', enum: DEFECT_ACTIONS }, reason: { type: 'string' } }, required: ['defect_index', 'action', 'reason'] } },
  },
  required: [...Object.keys(UNIT_PROPS), 'source_map', 'defect_responses'],
}
const GOAL_SCHEMA = { type: 'object', properties: { outcomes: { type: 'array', items: { type: 'object', properties: { outcome: { type: 'string' }, quotes: { type: 'array', items: { type: 'object', properties: { source: { type: 'string', enum: ['request', 'decisions'] }, quote: { type: 'string' } }, required: ['source', 'quote'] } }, items: { type: 'array', items: { type: 'string' } } }, required: ['outcome', 'quotes', 'items'] } } }, required: ['outcomes'] }
const UNIT_VERDICT_SCHEMA = { type: 'object', properties: { unit_id: { type: 'string' }, defects: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, claim: { type: 'string' }, quote: { type: 'string' } }, required: ['kind', 'claim', 'quote'] } } }, required: ['unit_id', 'defects'] }

async function planStage() {
  phase('plan')
  const ctx = { constraintIds: [...arr(A.criteriaIds), ...arr(A.constraintIds)], lensesGiven: arr(A.givenLensIds).length > 0, givenLensIds: arr(A.givenLensIds) }
  const out = { goal_check: null, planners: null, plan: null, plan_problems: [], unit_checks: [] }
  // 目標の照合: 依頼文と決定の記録が求める成果を挙げ、どの項目が受け止めるかを返す（呼ぶ側が照合済みなら goalChecked で流さない）。
  if (!A.goalChecked) {
    // 引用が依頼文・決定の記録に逐語かは、本文を持つ CLI の ingest が照らす（ここでは形と id だけ）。
    out.goal_check = (await checked('goal_checker', 'goal-check', `${COMMON(A.goalBrief)}
## あなたの役: 目標の照合役
束の「## 依頼文」と「## 決定の記録」から、利用者が求めている成果を全て挙げる（件数は決めない。同じ成果を重ねない）。成果ごとに、根拠の逐語の引用（quotes。source は依頼文なら request、決定の記録なら decisions）と、その成果を受け止めている目標・受け入れ基準・制約の項目の id（items）を返す。受け止めている項目が無ければ items を空にする。
項目が依頼に無いものを足したか・範囲を狭めたか・手順かは判定しない（項目ごとの引用は script が照らし済み）。
## 項目の id（items に使う）
${JSON.stringify(arr(A.goalIds))}`, GOAL_SCHEMA, (r) => checkGoalMap(r, arr(A.goalIds)))).result
  }
  // 統合するか（索引があるか）は CLI が決める。前の計画があれば見直し、無ければ独立な 2 体から作る。
  if (!ctx.lensesGiven && A.index) {
    const RULES = `
### 観点の規則
- 観点の数・例・型枠は与えない。目標と対象の中身から切る。
- 観点（lenses）: 対象を資産（節・行の塊）ごとに見るときの手続き（何を列挙し、何と照らすか）。観点 purpose（目的）と layer（層と範囲）はスキルが持つので作らない。
- 受け入れ基準と固定した制約の全てに、受け皿の観点を constraint_map で付ける（constraint_id に基準か制約の id）。
- 利用者への質問（questions）: 価値判断が要り、制約で答えが出ていないものだけ。`
    const INDEX = `### 対象の索引（資産の id・写しのファイル・行の範囲・見出し）\n${A.index ? `${rangeOf(A.index)}\n各行の写しと範囲を Read で開けば資産の本文を読める。観点を切るのに要る所だけを読む。` : '（無し）'}`
    let integ
    if (!arr(A.prevLensIds).length) {
      const planPrompt = (who) => `${COMMON(A.brief)}
## あなたの役: 計画役 ${who}
もう 1 体の計画役が同じ目標と対象から独立に作る。相手の結果は見ない。後で統合役が調停する。観点の一覧は、全ての資産に当てる検査の分母になる。
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
      const sources = ok.flatMap(([w, x]) => arr(x.result.lenses).map((u) => `${w}:${u.id}`))
      integ = await checked('integrator', 'integrate', `${COMMON(A.brief)}
## あなたの役: 統合役
互いを見ずに作った ${ok.map(([w]) => w).join(' と ')} を 1 つにする。どちらかを丸ごと採らず、目標と対象に照らして決める。全ての元の観点に、統合先（merged_into）か落とす理由（dropped_reason）を source_map で付ける。片方にしか無い観点を黙って落とさない。
${RULES}
${INDEX}
${ok.map(([w, x]) => `### ${w}（静的な検査の残り ${x.problems.length} 件${x.problems.length ? ': ' + x.problems.join(' / ') : ''}）\n${JSON.stringify(x.result)}`).join('\n')}
（defect_responses は空の配列にする）`, INTEGRATED_SCHEMA, (r) => checkPlan(r, { ...ctx, sources }))
    } else {
      const defectCount = Number(A.defectCount) || 0
      integ = await checked('integrator', 'integrate-again', `${COMMON(A.againBrief)}
## あなたの役: 統合役（前の計画の見直し）
前の計画（束の「### 前の計画」）に、観点ごとの検証役が出した欠陥（束の「### 欠陥」。${defectCount} 件）と、利用者の回答（束の「### 利用者の回答」。${arr(A.answerIds).length} 件）がある。欠陥の主張が正しいとは限らない。全ての欠陥について目標と対象に照らし、直した（fixed）か根拠を挙げて退けた（rejected）かを defect_responses に返す。重さで選ばない。欠陥に関係しない観点は id も中身も変えない（変えた観点だけが検証し直される）。
${RULES}
${INDEX}
（source_map は前の計画の観点を「P:<id>」で全て挙げる: ${arr(A.prevLensIds).map((id) => `P:${id}`).join(', ')}）`, INTEGRATED_SCHEMA, (r) => checkPlan(r, { ...ctx, sources: arr(A.prevLensIds).map((id) => `P:${id}`), defectCount }))
    }
    out.plan = integ.result
    out.plan_problems = integ.problems
    if (!integ.result) return { ...out, status: 'blocked', reason: '統合役が返らなかった' }
  }
  // 観点ごとに、新しい context の検証役が欠陥を探す（中身が変わった観点だけを見る）。
  // この呼び出しで統合した計画の観点は返り値の本文で渡し、前の計画の観点は CLI が書いた観点ごとの束（units）で渡す。
  const verified = new Set(arr(A.verifiedKeys))
  const units = out.plan
    ? arr(out.plan.lenses).filter((u) => !verified.has(unitKey(u))).map((u) => ({ unit_id: u.id, key: unitKey(u), text: unitText(u) }))
    : arr(A.units).map((u) => ({ unit_id: u.unit_id, key: u.key, brief: u.brief }))
  const maxUnits = Math.max(0, Math.floor((LIMITS.maxAgents - agents.length) / 2))
  const toVerify = units.slice(0, maxUnits)
  const checks = await pipeline(toVerify, (u) => checked('unit_verifier', `verify-unit-${u.unit_id}`, `${COMMON(u.brief || A.brief)}
## あなたの役: 観点の検証役（反証側。観点 ${u.unit_id} だけを見る）
この観点には欠陥があるという前提で読む。作った者の説明を信じない。見るもの: 1 体で 1 枡を読んで判定できない大きさ・問いが 2 つ以上・層の誤り（上の層の決め直し、下の層の細部）・制約との矛盾・目標に効かない観点・手続きが「何を列挙し、何と照らすか」になっていない。良い点は書かない。欠陥ごとに、観点の本文からの逐語の引用を付ける。
${u.text != null ? `### 本文（観点）\n${u.text}` : '観点の本文は束の「### 本文（観点）」にある。'}`, UNIT_VERDICT_SCHEMA, (r) => checkUnitVerdict(r, u.unit_id, u.text)).then((x) => ({ unit_id: u.unit_id, key: u.key, ...x })))
  out.unit_checks = checks.map((x, i) => x || { unit_id: toVerify[i].unit_id, key: toVerify[i].key, result: null, problems: ['pipeline が null を返した'] })
  out.units_not_verified = units.slice(maxUnits).map((u) => u.unit_id)
  return { ...out, status: 'ok' }
}

// ---------------- review（枡ごとに読む役と、別のモデル・反証側の検証役） ----------------
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
const roleFor = (base, pass) => (`${base}_${pass}` in A.roles ? `${base}_${pass}` : base in A.roles ? base : `${base}_1`)
async function reviewStage() {
  phase('review')
  const cells = arr(A.cells).slice(0, Math.floor(LIMITS.maxAgents / PER_CELL))
  const rows = await pipeline(cells, async (c) => {
    const rd = await checked(roleFor('reader', c.pass), `read-${c.cell_id}`, `${COMMON(c.brief)}
## あなたの役: 読む役（枡 ${c.cell_id} だけ。下の範囲の外は読まない）
観点 ${c.lens} の名前と手続きは束の「## 観点」にある。
- 下の範囲を Read で全て読み、手続きに沿って確かめる。区画（${arr(c.blocks).map(([s, e]) => `${s}-${e} 行`).join('・')}）のそれぞれから 1 つ以上、逐語の引用を evidence に挙げる（読んだ証拠。script が区画ごとに照合する）。
- 観点に当たる欠陥を、逐語の引用（quote）・重さ・原因の層（${LAYERS.join('・')}）と共に findings に返す。層は、直すべき層を選ぶ（本文の層とは限らない）。重さで絞らない。
- 観点の外で気づいたことは指摘にせず outside_notes に書く。
- 指摘が無ければ、確かめたことを none_reason に書く。
### 本文の範囲（元のファイル: ${c.path}）
${rangeOf(c)}`, READ_SCHEMA, (r) => checkReadShape(r, c.cell_id))
    const fs = rd.result && !rd.problems.length ? arr(rd.result.findings) : []
    let vf = null
    if (fs.length) {
      // 検証役は読む役と別のモデル・反証側の枠組みで、新しい context で、同じ枡の範囲だけを読む。
      vf = await checked(roleFor('verifier', c.pass), `verify-${c.cell_id}`, `${COMMON(c.brief)}
## あなたの役: 検証役（反証側。枡 ${c.cell_id} の指摘だけ）
下の指摘はどれも誤りかもしれないという前提で、本文に当たって確かめる。指摘ごとに confirmed（本文が主張を支える）・refuted（本文が主張を否定する）・unverifiable（本文だけでは決められない）を返す。confirmed と refuted には、決め手になった本文の逐語の引用を quote に付ける（引用が合わない判定は unverifiable として扱われる）。
観点 ${c.lens}（名前と手続きは束の「## 観点」にある）
### 指摘（index は配列の位置）
${JSON.stringify(fs.map((f, i) => ({ index: i, claim: f.claim, quote: f.quote, severity: f.severity, layer: f.layer })))}
### 本文の範囲（元のファイル: ${c.path}）
${rangeOf(c)}`, VERIFY_SCHEMA, (r) => checkVerify(r, fs.length))
    }
    return { cell_id: c.cell_id, read: rd.result, read_problems: rd.problems, verify: vf && vf.result, verify_problems: vf ? vf.problems : [] }
  })
  const left = arr(A.cells).slice(cells.length).map((c) => c.cell_id)
  return { status: 'ok', cells: rows.map((r, i) => r || { cell_id: cells[i].cell_id, read: null, read_problems: ['pipeline が null を返した'], verify: null, verify_problems: [] }), not_run: left }
}

// ---------------- group（根本原因で束ね、反証する） ----------------
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
  const keys = groupKeys(A.count)
  const g = await checked('grouper', 'group', `${COMMON(A.brief)}
## あなたの役: 束ね役
下の写しの全件（この周に確かめた指摘。振り返りで確かめた悪かった出来事を含む。1 行 1 件の JSON で key を持つ）を根本原因で束ねる。症状でなく原因で束ね、全ての key（K1〜K${A.count}）をちょうど 1 つの群に入れる（入れられないものは unassigned）。重さで絞らない。群ごとに、直すべき層（${LAYERS.join('・')}）を選び、同じ型の欠陥を全ての資産へ問い直すための手続き（何を列挙し、何と照らすか）を pattern に書く（型にならない群は空文字）。
### 全件
${rangeOf(A.items)}`, GROUP_SCHEMA, (r) => checkGroups(r, keys))
  if (!g.result) return { status: 'blocked', reason: '束ね役が返らなかった', problems: g.problems }
  const groups = arr(g.result.groups).slice(0, Math.floor((LIMITS.maxAgents - agents.length) / 2))
  const refPrompt = (gr) => `${COMMON(A.brief)}
## あなたの役: 反証役
下の根本原因の主張が誤りではないかを探す。記録の事実と合わない・原因でなく症状の言い換え・固定した制約の蒸し返し、のどれかなら refuted=true。確かめられなければ refuted=false とし、理由に「確かめられない」と書く。
### 群 ${gr.id}（層: ${gr.layer}）
根本原因: ${gr.root_cause}
含むもの（key）: ${arr(gr.keys).join(', ')}
### key の中身（写しの中のその key の行だけを見る）
${rangeOf(A.items)}`
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

const body = A.stage === 'plan' ? await planStage() : A.stage === 'review' ? await reviewStage() : await groupStage()
return done(body)
