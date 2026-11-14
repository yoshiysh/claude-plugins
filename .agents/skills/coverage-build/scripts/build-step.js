export const meta = {
  name: 'coverage-build-step',
  description: '書き込まない段（design・retro のどれか）を 1 回だけ流し、生の結果と起動の記録を返す。状態を書くのは呼び出し側の CLI',
  requirements: ['read-only', 'fresh-thread'],
  phases: [
    { title: 'design', detail: '目標の照合・方式設計（単位への分割）・単位ごとの詳細設計' },
    { title: 'retro', detail: '悪かった出来事から原因の意図を出し、意図ごとに確かめ、別のモデルが受理を決める' },
  ],
  limits: { maxAgents: 40, concurrency: 3, timeoutMs: 7200000, agentTimeoutMs: 900000, maxOutputBytes: 4000000 },
}

// <checks> ここから </checks> までは CLI（build-core.mjs）が同じ文を読み込んで使う。静的な照合の正本はここだけ。
// native Workflow は本体に meta を渡さないので写しを置く（一致は tests/coverage-build-workflow.test.mjs が照らす）。
const LIMITS = { maxAgents: 40, concurrency: 3, timeoutMs: 7200000, agentTimeoutMs: 900000, maxOutputBytes: 4000000 }
const QUOTE_MIN = 12
const MAX_UNIT_PATHS = 3 // 1 単位が持つファイル（成果物・テストそれぞれ）の上限。1 体に任せる量を小さくする
const MAX_SPEC_LINES = 80 // 1 単位の詳細設計の行数の上限。coverage-audit の 1 体が 1 回で読める大きさに収める
const AUDIT_LAYERS = ['方針', '要求', '方式設計', '詳細設計', '実装']
const LAYERS = ['目標', '設計', '実装', '進め方']
// coverage-audit の層を、戻す先の層に写す。全数は tests で照らす。
const LAYER_MAP = { 方針: '目標', 要求: '目標', 方式設計: '設計', 詳細設計: '設計', 実装: '実装' }
const VERDICTS = ['supported', 'refuted', 'unclear']
const isStr = (s) => typeof s === 'string' && s.trim().length > 0
const arr = (a) => (Array.isArray(a) ? a : [])
// <sum> 値を key の順に並べた JSON の FNV-1a。args の写し違いの検出に使う（build-step.js と build-write.js に同じ文がある）。
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v))
function fnv(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}
const argsSum = (a) => fnv(canon(Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'argsSum'))))
// </sum>
const stripNums = (s) => String(s ?? '').replace(/(^|\n)[ \t]*\d+(\| ?|\t)/g, '$1')
const norm = (s) => stripNums(s).replace(/\s+/g, ' ').trim()
function quoteProblem(q, text) {
  const n = norm(q)
  if (!n) return '引用が空'
  if (n.length < QUOTE_MIN && n !== norm(text)) return `引用が ${QUOTE_MIN} 字未満`
  if (!norm(text).includes(n)) return '引用が本文に逐語で無い'
  return null
}
const isRel = (p) => isStr(p) && !p.startsWith('/') && !p.includes('\\') && !p.split('/').some((s) => s === '..' || s === '.' || s === '')
// 依存の順（波）。循環か実在しない依存があれば null。
function waves(units) {
  const ids = new Set(units.map((u) => u.id))
  if (units.some((u) => arr(u.depends_on).some((d) => !ids.has(d) || d === u.id))) return null
  const out = []
  const done = new Set()
  while (done.size < units.length) {
    const w = units.filter((u) => !done.has(u.id) && arr(u.depends_on).every((d) => done.has(d))).map((u) => u.id)
    if (!w.length) return null
    w.forEach((id) => done.add(id))
    out.push(w)
  }
  return out
}
// 方式設計の形: 単位の id・種類・持つファイルの重なり・依存の循環・基準と制約の受け皿・入力を読んだかの申告。
function checkArch(a, ctx) {
  if (!a || typeof a !== 'object') return ['返り値が無い']
  const p = []
  const units = arr(a.units)
  if (!units.length) p.push('単位が 0 件')
  const ids = new Set()
  const owned = new Map()
  for (const u of units) {
    if (!/^U[1-9]\d*$/.test(String(u && u.id))) { p.push(`単位の id が U<数> でない: ${u && u.id}`); continue }
    if (ids.has(u.id)) p.push(`単位の id の重複: ${u.id}`)
    ids.add(u.id)
    if (!['doc', 'code'].includes(u.kind)) p.push(`${u.id}: kind は doc か code`)
    if (!isStr(u.title) || !isStr(u.responsibility)) p.push(`${u.id}: title か responsibility が空`)
    const ps = arr(u.paths)
    const ts = arr(u.tests)
    if (!ps.length || ps.length > MAX_UNIT_PATHS) p.push(`${u.id}: paths は 1〜${MAX_UNIT_PATHS} 件`)
    if (u.kind === 'code' && (!ts.length || ts.length > MAX_UNIT_PATHS)) p.push(`${u.id}: code の単位の tests は 1〜${MAX_UNIT_PATHS} 件（テストは別の担当が先に書く）`)
    if (u.kind === 'doc' && ts.length) p.push(`${u.id}: doc の単位は tests を持たない`)
    for (const f of [...ps, ...ts]) {
      if (!isRel(f)) p.push(`${u.id}: repo からの相対 path でない: ${f}`)
      else if (owned.has(f)) p.push(`${f} を ${owned.get(f)} と ${u.id} の 2 つが持つ`)
      else owned.set(f, u.id)
    }
    if (!arr(u.covers).length) p.push(`${u.id}: covers が空（どの基準・制約に効くかが無い）`)
    for (const c of arr(u.covers)) if (!ctx.coverIds.includes(c)) p.push(`${u.id}: 実在しない基準・制約: ${c}`)
  }
  if (units.length && !p.length && !waves(units)) p.push('depends_on に循環か実在しない単位がある')
  for (const c of ctx.coverIds) if (!units.some((u) => arr(u.covers).includes(c))) p.push(`基準・制約 ${c} の受け皿の単位が無い`)
  const seen = new Map()
  for (const r of arr(a.inputs_read)) { seen.set(r.path, (seen.get(r.path) || 0) + 1); if (!arr(r.quotes).length) p.push(`入力 ${r.path} を読んだ証拠の引用が無い`) }
  for (const r of arr(a.inputs_not_read)) { seen.set(r.path, (seen.get(r.path) || 0) + 1); if (!isStr(r.reason)) p.push(`入力 ${r.path} を読まない理由が空`) }
  for (const [k, n] of seen) if (!ctx.inputs.includes(k)) p.push(`入力に無い path: ${k}`); else if (n > 1) p.push(`入力 ${k} が 2 回以上ある`)
  for (const f of ctx.inputs) if (!seen.has(f)) p.push(`入力 ${f} を読んだか読まないかの申告が無い`)
  const qids = new Set()
  for (const q of arr(a.questions)) { if (!isStr(q.id) || qids.has(q.id)) p.push(`質問の id が空か重複: ${q.id}`); qids.add(q.id); if (!isStr(q.why_value_judgment)) p.push(`質問 ${q.id} に価値判断の理由が無い`) }
  return p
}
function checkSpec(rep, unit) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  if (rep.unit_id !== unit.id) p.push(`unit_id が違う: ${rep.unit_id}`)
  if (!isStr(rep.spec)) p.push('spec が空')
  else if (String(rep.spec).split('\n').length > MAX_SPEC_LINES) p.push(`spec が ${MAX_SPEC_LINES} 行を超える（単位を分けるのは方式設計の仕事。ここでは詰める）`)
  if (!arr(rep.acceptance).length || arr(rep.acceptance).some((x) => !isStr(x))) p.push('acceptance が空か空の行を含む')
  if (unit.kind === 'code' && !arr(rep.cases).length) p.push('code の単位なのに cases が空（テストの担当が書くケース）')
  arr(rep.cases).forEach((c, i) => { if (!isStr(c && c.condition) || !isStr(c && c.expect)) p.push(`cases[${i}]: condition か expect が空`) })
  return p
}
function checkIntents(rep, knownIds) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  arr(rep.intents).forEach((it, i) => {
    if (!arr(it && it.basis).length) p.push(`intents[${i}]: basis が空`)
    for (const b of arr(it && it.basis)) if (!knownIds.includes(b)) p.push(`intents[${i}]: 実在しない事実: ${b}`)
    if (!isStr(it && it.hypothesis)) p.push(`intents[${i}]: hypothesis が空`)
    if (!LAYERS.includes(it && it.layer)) p.push(`intents[${i}]: layer が不正`)
    if (!arr(it && it.look_at).length) p.push(`intents[${i}]: look_at が空`)
  })
  return p
}
function checkExam(rep) {
  if (!rep || typeof rep !== 'object') return ['返り値が無い']
  const p = []
  if (!VERDICTS.includes(rep.verdict)) p.push('verdict が不正')
  if (rep.verdict === 'supported') {
    if (!isStr(rep.cause)) p.push('cause が空')
    if (!LAYERS.includes(rep.layer)) p.push('layer が不正')
    if (!arr(rep.evidence).length) p.push('支持したのに evidence が空')
    arr(rep.evidence).forEach((e, i) => { if (!isStr(e && e.path) || !isStr(e && e.quote)) p.push(`evidence[${i}]: path か quote が空`) })
  }
  return p
}
const checkJudge = (rep) => (!rep || typeof rep.accept !== 'boolean' || !isStr(rep.reason) ? ['accept か reason が無い'] : [])
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
    if (r2) { r = r2; p = check(r2) }
  }
  return { result: r, problems: p }
}
const tokens = () => (typeof budget !== 'undefined' && budget && typeof budget.spent === 'function' ? budget.spent() : null)
const left = () => LIMITS.maxAgents - agents.length

const argProblems = []
if (!A || typeof A !== 'object') argProblems.push('args が object でない')
else {
  if (!['design', 'retro'].includes(A.stage)) argProblems.push(`stage が不正: ${A.stage}`)
  if (!A.roles || typeof A.roles !== 'object') argProblems.push('roles が無い')
  if (A.argsSum !== argsSum(A)) argProblems.push('args の写しが next の出力と違う（argsSum が合わない）')
}
if (argProblems.length) return { stage: A && A.stage, call_id: A && A.callId, status: 'blocked', reason: 'args の検査に落ちた', problems: argProblems, agents: [] }

// 束（brief）は CLI が stateDir に書いた写し。args には path と hash だけが載る。
const readBrief = (b) => `## 依頼の束\nまず Read で ${b.path} を全て読む（hash ${b.hash}）。目的・固定した目標と基準と制約・読むファイル・受け持ちはそこにある。束に無いことを推測で埋めず、読めなかったものはそう書く。ファイルは変えない。結果は返り値だけで返す。`

const ARCH_SCHEMA = {
  type: 'object',
  properties: {
    units: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['doc', 'code'] }, title: { type: 'string' }, responsibility: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, tests: { type: 'array', items: { type: 'string' } }, depends_on: { type: 'array', items: { type: 'string' } }, covers: { type: 'array', items: { type: 'string' } } }, required: ['id', 'kind', 'title', 'responsibility', 'paths', 'tests', 'depends_on', 'covers'] } },
    inputs_read: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, quotes: { type: 'array', items: { type: 'string' } } }, required: ['path', 'quotes'] } },
    inputs_not_read: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, reason: { type: 'string' } }, required: ['path', 'reason'] } },
    questions: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, question: { type: 'string' }, why_value_judgment: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['id', 'question', 'why_value_judgment', 'options'] } },
  },
  required: ['units', 'inputs_read', 'inputs_not_read', 'questions'],
}
const SPEC_SCHEMA = { type: 'object', properties: { unit_id: { type: 'string' }, spec: { type: 'string' }, acceptance: { type: 'array', items: { type: 'string' } }, cases: { type: 'array', items: { type: 'object', properties: { condition: { type: 'string' }, expect: { type: 'string' } }, required: ['condition', 'expect'] } } }, required: ['unit_id', 'spec', 'acceptance', 'cases'] }
const GOAL_SCHEMA = { type: 'object', properties: { outcomes: { type: 'array', items: { type: 'object', properties: { outcome: { type: 'string' }, quotes: { type: 'array', items: { type: 'object', properties: { source: { type: 'string', enum: ['request', 'decisions'] }, quote: { type: 'string' } }, required: ['source', 'quote'] } }, items: { type: 'array', items: { type: 'string' } } }, required: ['outcome', 'quotes', 'items'] } } }, required: ['outcomes'] }

async function designStage() {
  phase('design')
  const out = { goal_check: null, arch: null, specs: [], not_run: [] }
  if (A.goalBrief) {
    out.goal_check = (await checked('goal_checker', 'goal-check', `${readBrief(A.goalBrief)}
## あなたの役: 目標の照合役
束の依頼文と利用者の決定の記録から、利用者が求めている成果を全て挙げる（件数は決めない。同じ成果を重ねない）。成果ごとに、根拠の逐語の引用（quotes。source は依頼文なら request、決定の記録なら decisions）と、その成果を受け止めている目標・受け入れ基準・制約の項目の id（items）を返す。受け止めている項目が無ければ items を空にする。
項目が依頼に無いものを足したか・範囲を狭めたか・手順かは判定しない（項目ごとの引用は script が照らし済み）。
### 項目の id（items に使う）
${JSON.stringify(A.goalIds)}`, GOAL_SCHEMA, (r) => checkGoalMap(r, A.goalIds))).result
  }
  let units = arr(A.units)
  if (A.arch) {
    const a = await checked('architect', 'architect', `${readBrief(A.arch.brief)}
## あなたの役: 方式設計の役
目標を、1 体が 1 回で設計・実装・検査できる大きさの単位に分ける。単位の数・例・型枠は与えない。目標・基準・制約と入力の中身から切る。
- 単位ごとに、持つファイル（paths。repo からの相対 path）、code の単位ならテストのファイル（tests。実装とは別の担当が先に書く）、依存（depends_on）、効く基準・制約の id（covers）を決める。1 つのファイルは 1 つの単位だけが持つ。
- 複数の単位にまたがる決定は、それを決める単位を 1 つ置き、使う単位はそれに depends_on で依存する。
- 全ての基準と制約に受け皿の単位を付ける。
- 入力は全て、読んだなら逐語の引用（inputs_read）、読まないなら理由（inputs_not_read）を返す。引用は script が照らす。
- 利用者への質問（questions）は、価値判断が要り、基準・制約で答えが出ていないものだけ。`, ARCH_SCHEMA, (r) => checkArch(r, A.arch.ctx))
    out.arch = a
    if (!a.result || a.problems.length) return { ...out, status: 'ok' }
    units = arr(a.result.units).map((u) => ({ unit_id: u.id, unit: u, brief: A.arch.unitBrief, arch: a.result.units }))
  }
  const cap = Math.max(0, Math.floor(left() / 2))
  const run = units.slice(0, cap)
  out.not_run = units.slice(cap).map((u) => u.unit_id)
  const rows = await pipeline(run, (u) => checked('unit_designer', `design-${u.unit_id}`, `${readBrief(u.brief)}
## あなたの役: 詳細設計の役（単位 ${u.unit_id} だけ）
${u.arch ? `### 方式設計（この run で決まったもの。全ての単位）\n${JSON.stringify(u.arch)}\n` : ''}受け持ちの単位の振る舞い・入出力・境界の条件を spec に書く（${MAX_SPEC_LINES} 行まで）。受け入れの条件（acceptance）は外から確かめられる文で 1 行 1 件。code の単位なら、テストの担当が書くケース（cases: 条件と期待）を、条件ごとに漏れなく挙げる。ケースの期待値は実装から取らず、基準と spec から決める。受け持ちの外の単位は決め直さない。`, SPEC_SCHEMA, (r) => checkSpec(r, u.unit || A.unitDefs[u.unit_id])).then((x) => ({ unit_id: u.unit_id, ...x })))
  out.specs = rows.map((r, i) => r || { unit_id: run[i].unit_id, result: null, problems: ['pipeline が null を返した'] })
  return { ...out, status: 'ok' }
}

const INTENTS_SCHEMA = { type: 'object', properties: { intents: { type: 'array', items: { type: 'object', properties: { basis: { type: 'array', items: { type: 'string' } }, hypothesis: { type: 'string' }, layer: { type: 'string', enum: LAYERS }, look_at: { type: 'array', items: { type: 'string' } } }, required: ['basis', 'hypothesis', 'layer', 'look_at'] } } }, required: ['intents'] }
const EXAM_SCHEMA = { type: 'object', properties: { verdict: { type: 'string', enum: VERDICTS }, cause: { type: 'string' }, layer: { type: 'string', enum: LAYERS }, evidence: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, quote: { type: 'string' } }, required: ['path', 'quote'] } } }, required: ['verdict', 'cause', 'layer', 'evidence'] }
const JUDGE_SCHEMA = { type: 'object', properties: { accept: { type: 'boolean' }, reason: { type: 'string' } }, required: ['accept', 'reason'] }

async function retroStage() {
  phase('retro')
  const pl = await checked('retro_planner', 'retro-plan', `${readBrief(A.brief)}
## あなたの役: 振り返りの計画役
束にある悪かった出来事と、受理済みの原因（事実）を読み、「原因はこれか」という意図を返す。意図ごとに、根拠にした事実の id（basis）、仮説（hypothesis）、原因と考える層（${LAYERS.join('・')}）、確かめるのに読むファイル（look_at。束の「読めるファイル」から選ぶ）を付ける。
- 前提が満たされ、互いに重ならない意図を全て出す。件数は決めない。
- 受理済みの原因から、さらに上流の原因（その原因の原因）を問う意図も出してよい。層は目標 → 設計 → 実装 の順に上流。進め方はこのスキルの段の構成・役・検査の欠け。
- 既に退けられた意図を同じ根拠で繰り返さない。試すものが無ければ intents を空にする。`, INTENTS_SCHEMA, (r) => checkIntents(r, A.knownIds))
  const intents = pl.result && !pl.problems.length ? arr(pl.result.intents) : []
  const cap = Math.max(0, Math.floor(left() / 3))
  const run = intents.slice(0, cap)
  const rows = await pipeline(run, async (it, i) => {
    const ex = await checked('retro_examiner', `retro-exam-${i}`, `${readBrief(A.brief)}
## あなたの役: 振り返りの実行役（意図 1 件だけ）
### 意図
${JSON.stringify(it)}
look_at のファイルを読み、仮説が記録で支えられるか（supported）、記録が否定するか（refuted）、決められないか（unclear）を返す。supported なら、原因（cause）と層と、決め手になった本文の逐語の引用を path つきで evidence に返す（script が照らす）。`, EXAM_SCHEMA, checkExam)
    let judge = null
    if (ex.result && !ex.problems.length && ex.result.verdict === 'supported') {
      judge = await call('retro_verifier', `retro-judge-${i}`, `${readBrief(A.brief)}
## あなたの役: 振り返りの検証役（反証側。意図 1 件の結論だけ）
下の結論は誤りかもしれないという前提で、evidence の path を読み直して確かめる。原因でなく症状の言い換え、記録と合わない、層の取り違え、固定した目標・制約の蒸し返し、のどれかなら accept=false。
### 意図
${JSON.stringify(it)}
### 結論
${JSON.stringify(ex.result)}`, JUDGE_SCHEMA)
    }
    return { index: i, exam: ex.result, exam_problems: ex.problems, judge, judge_problems: judge ? checkJudge(judge) : [] }
  })
  return { status: 'ok', intents: pl.result, intent_problems: pl.problems, exams: rows.map((r, i) => r || { index: i, exam: null, exam_problems: ['pipeline が null を返した'], judge: null, judge_problems: [] }), not_run: intents.slice(cap).map((_, i) => cap + i) }
}

const body = A.stage === 'design' ? await designStage() : await retroStage()
return { stage: A.stage, call_id: A.callId, ...body, agents, tokens: tokens(), limits: LIMITS }
