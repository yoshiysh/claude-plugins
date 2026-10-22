export const meta = {
  name: 'trace',
  description: '再現する失敗の根本原因を、検証した事実の連なりとして特定する探索グラフ',
  phases: [{ title: '目標の固定' }, { title: '計画' }, { title: '実行と検証' }, { title: '追加の実行' }, { title: '完了の照合' }, { title: '停止' }],
}

const CONCURRENCY = 3
const MAX_ROUNDS = 5
const MAX_ATTEMPTS = 3
const DRY_ROUNDS = 2
const ROLE_MODELS = {
  goal: { model: 'opus', effort: 'medium' },
  planner: { model: 'opus', effort: 'medium' },
  executor: { model: 'sonnet', effort: 'medium' },
  collector: { model: 'haiku', effort: 'low' },
  verifier: { model: 'opus', effort: 'medium' },
  completion: { model: 'opus', effort: 'medium' },
  carrier: { model: 'haiku', effort: 'low' },
}
// 起動の単位ごとの最悪の起動数（references/design.md の「起動数の上限」）。事実は 1 回の運搬役でまとめて書くので、件数で増えない。
// 意図は試行の上限 ×（工程の agent 3: 実行役・回収役・検証役 + 状態を書く呼び出し 2: 見た資産・事実と終わりか試行の失敗）。
const WORST = {
  start: 1,
  goal: 2,
  plan: 5,
  item: MAX_ATTEMPTS * (3 + 2),
  extra: 2,
  scan: 1,
  round: 1,
}
// 止まるときに必ず起動する停止の運搬役 1（停止の記録と、返り値の skip 一覧・カバレッジを 1 回で運ぶ）。
const RESERVE = 1
const MIN_LAUNCHES = WORST.start + WORST.goal + WORST.plan + WORST.item + RESERVE

const STR = { type: 'string' }
const LIST = { type: 'array' }
const FACTS = { type: 'array', items: { type: 'object', properties: { text: STR, method: STR, evidence: STR }, required: ['text', 'method', 'evidence'] } }
const SCHEMAS = {
  carrier: { type: 'object', properties: { responses: { type: 'array', items: STR } }, required: ['responses'] },
  goal: { type: 'object', properties: { goal: STR, scope: LIST, prohibitions: LIST, numeric: LIST, origin: STR, missing: LIST }, required: ['goal', 'scope', 'origin', 'missing'] },
  planner: { type: 'object', properties: { kind: { enum: ['intents', 'claim', 'needs_input'] }, intents: LIST, rerank: LIST, hintsRead: LIST, claim: { type: 'object' }, question: STR }, required: ['kind'] },
  executor: { type: 'object', properties: { facts: FACTS, blank: { type: 'boolean' }, seen: LIST }, required: ['facts', 'blank', 'seen'] },
  collector: { type: 'object', properties: { facts: FACTS }, required: ['facts'] },
  verifier: { type: 'object', properties: { verdicts: LIST }, required: ['verdicts'] },
  completion: { type: 'object', properties: { verdict: { enum: ['accept', 'reject'] }, reason: STR }, required: ['verdict', 'reason'] },
}

class Stop {
  constructor(kind, reason, extra = {}) {
    this.kind = kind
    this.reason = reason
    this.extra = extra
  }
}

// 入力の項目の正本は SKILL.md の「起動」の表。再開は nextArgs（state・repo・skillDir）をそのまま受ける。
function validate(a) {
  const missing = ['repo', 'skillDir'].filter((k) => typeof a?.[k] !== 'string' || a[k] === '')
  if (typeof a?.state === 'string') return missing.length ? { error: `再開に要る項目が無い: ${missing.join(', ')}` } : { state: a.state, repo: a.repo, skillDir: a.skillDir, limit: a.maxLaunches }
  if (typeof a?.request !== 'string' || a.request === '') missing.unshift('request')
  if (missing.length) return { error: `起動に要る項目が無い: ${missing.join(', ')}` }
  return { request: a.request, repo: a.repo, skillDir: a.skillDir, limit: a.maxLaunches }
}

const input = validate(args)
if (input.error) return { stopKind: 'blocked', reason: input.error, launches: 0 }
if (input.limit !== undefined && !(Number.isInteger(input.limit) && input.limit >= 1)) {
  return { stopKind: 'blocked', reason: `起動数の上限 ${JSON.stringify(input.limit)} は 1 以上の整数でなければならない`, launches: 0 }
}
if (input.limit !== undefined && input.limit < MIN_LAUNCHES) {
  return { stopKind: 'blocked', reason: `起動数の上限 ${input.limit} が最小の起動数 ${MIN_LAUNCHES} に満たない。上限が 1 件の意図にも足りない`, launches: 0 }
}
const SKILL = input.skillDir
const ROLES = `${SKILL}/references/roles`
const run = { state: input.state ?? null, run: null, repo: input.repo, workDir: null, roundLaunches: 0 }

// 走っている単位の残りの最悪の数も足して確かめる。呼び終えた数だけで確かめると、同時に走る意図の残りが合わさって上限を超える。
const budget = (() => {
  let used = 0
  let seq = 0
  const running = new Map()
  return {
    used: () => used,
    fits(worst) {
      if (input.limit === undefined) return true
      let rest = 0
      for (const u of running.values()) rest += Math.max(0, u.worst - u.used)
      return used + rest + worst + RESERVE <= input.limit
    },
    open(worst) {
      seq += 1
      running.set(seq, { worst, used: 0 })
      return seq
    },
    charge(unit) {
      used += 1
      const u = running.get(unit)
      if (u) u.used += 1
    },
    close(unit) {
      running.delete(unit)
    },
  }
})()

function launchStop() {
  return new Stop('iteration_limit', `起動数の上限 ${input.limit} で止まった（その時点の起動数 ${budget.used()}）`, { limitHit: 'launch' })
}

// 単位を始める前に最悪の数で確かめ、単位の中の起動はその単位に数える。
async function unit(worst, body) {
  if (!budget.fits(worst)) throw launchStop()
  const u = budget.open(worst)
  try {
    return await body(u)
  } finally {
    budget.close(u)
  }
}

async function launch(u, role, prompt, schema, label) {
  budget.charge(u)
  run.roundLaunches += 1
  return agent(prompt, { ...ROLE_MODELS[role], label, schema })
}

// 1 回の運搬役で、渡した順に CLI のコマンドを実行させる。
async function cli(u, ops) {
  const commands = ops.map(([op, body]) => {
    const req = JSON.stringify({ repo: run.repo, state: run.state, run: run.run, ...body })
    return `node '${SKILL}/scripts/state.mjs' ${op} <<'EOF'\n${req}\nEOF`
  })
  const prompt = [`役の指示: ${ROLES}/carrier.md を読む。`, `次のコマンドを順に実行し、各コマンドの標準出力を 1 行ずつ逐語で返す:\n${commands.join('\n')}`].join('\n')
  const out = await launch(u, 'carrier', prompt, SCHEMAS.carrier, `carrier:${ops.map(([op]) => op).join(',')}`)
  const responses = (out?.responses ?? []).map((line) => JSON.parse(line))
  if (responses.length !== ops.length) throw new Stop('blocked', `運搬役が ${ops.map(([op]) => op).join(',')} の応答を返さなかった`)
  const bad = responses.find((r) => !r.ok)
  if (bad) throw new Stop('blocked', `CLI が ${bad.op ?? ''} を拒否した: ${bad.code} ${bad.reason}`)
  return responses
}

// 1 件が止まっても走っている意図の終わりを待つ（待たずに返すと、走っている agent の呼び出しが run の終わりに残る）。
async function pool(items, work) {
  const queue = [...items]
  const running = new Set()
  const out = []
  const errors = []
  let full = false
  while ((queue.length && !full) || running.size) {
    while (queue.length && !full && running.size < CONCURRENCY) {
      const item = queue[0]
      if (!budget.fits(WORST.item)) {
        full = true
        break
      }
      queue.shift()
      const p = work(item).then((r) => { out.push(r) }, (e) => { errors.push(e) }).finally(() => running.delete(p))
      running.add(p)
    }
    if (running.size) await Promise.race(running)
  }
  if (errors.length) throw errors[0]
  return { out, notStarted: queue.length }
}

async function fixGoal() {
  await unit(WORST.goal, async (u) => {
    const g = await launch(u, 'goal', [
      `役の指示: ${ROLES}/goal.md を読む。`,
      `依頼文:\n${input.request}`,
      `リポジトリ: ${run.repo}`,
    ].join('\n'), SCHEMAS.goal, 'goal')
    if (!g) throw new Stop('blocked', '目標の固定役が結果を返さなかった')
    if (g.missing.length) throw new Stop('needs_input', `目標の固定に要る入力が無い: ${g.missing.join(' / ')}`)
    await cli(u, [
      ['premise', { kind: 'goal', text: JSON.stringify({ goal: g.goal, prohibitions: g.prohibitions, numeric: g.numeric }) }],
      ['premise', { kind: 'origin', text: g.origin }],
      ['ledger', { scope: g.scope }],
    ])
  })
}

// 計画の単位: 要約・計画役・（意図の書き込み、または完了の主張の照合 2 回と完了の照合の検証役）。最悪は完了の主張の 5。
async function plan(round) {
  return unit(WORST.plan, async (u) => {
    const [{ summary }] = await cli(u, [['summary', {}]])
    const p = await launch(u, 'planner', [
      `役の指示: ${ROLES}/planner.md を読む。`,
      `周: ${round}`,
      `状態の要約:\n${summary}`,
    ].join('\n'), SCHEMAS.planner, 'planner')
    if (!p) throw new Stop('blocked', '計画役が結果を返さなかった')
    if (p.kind === 'needs_input') throw new Stop('needs_input', p.question)
    if (p.kind !== 'claim') {
      const [planned] = await cli(u, [['plan', { round, intents: p.intents, rerank: p.rerank, hintsRead: p.hintsRead }]])
      return { pending: planned.pending, claimed: false }
    }
    const [c] = await cli(u, [['claim', { facts: p.claim.facts, numeric: p.claim.numeric, hintsRead: p.hintsRead }]])
    if (c.verdict === 'reject') return { pending: c.pending, claimed: true, reason: c.reason }
    const j = await launch(u, 'completion', [
      `役の指示: ${ROLES}/completion.md を読む。`,
      `完了の主張:\n${JSON.stringify(p.claim)}`,
    ].join('\n'), SCHEMAS.completion, 'completion')
    if (!j) throw new Stop('blocked', '完了の照合の検証役が結果を返さなかった')
    const [judged] = await cli(u, [['claim', { facts: p.claim.facts, numeric: p.claim.numeric, hintsRead: p.hintsRead, verdict: j.verdict, reason: j.reason }]])
    if (j.verdict === 'accept') throw new Stop('complete', j.reason, { cause: { reason: j.reason, facts: p.claim.facts } })
    return { pending: judged.pending, claimed: true, reason: j.reason }
  })
}

async function item(intent) {
  return unit(WORST.item, async (u) => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const x = await launch(u, 'executor', [
        `役の指示: ${ROLES}/executor.md を読む。`,
        `作業ファイルの置き場: ${run.workDir}`,
        `意図 ${intent.id}: ${intent.text}`,
      ].join('\n'), SCHEMAS.executor, `executor:${intent.id}`)
      const got = x ?? await launch(u, 'collector', [
        `役の指示: ${ROLES}/collector.md を読む。`,
        `記録ファイル: ${run.workDir}/${intent.id}.log`,
      ].join('\n'), SCHEMAS.collector, `collector:${intent.id}`)
      if (!got) {
        const [a] = await cli(u, [['attempt', { intent: intent.id, reason: '実行と回収のどちらも結果を返さなかった' }]])
        if (a.aborted) break
        continue
      }
      if (x?.seen?.length) await cli(u, [['seen', { intent: intent.id, paths: x.seen }]])
      if (x?.blank) {
        await cli(u, [['done', { intent: intent.id, blank: true }]])
        return { started: true, facts: 0 }
      }
      const v = await launch(u, 'verifier', [
        `役の指示: ${ROLES}/verifier.md を読む。`,
        `事実の候補:\n${JSON.stringify(got.facts)}`,
      ].join('\n'), SCHEMAS.verifier, `verifier:${intent.id}`)
      if (!v) {
        const [a] = await cli(u, [['attempt', { intent: intent.id, reason: '検証役が結果を返さなかった' }]])
        if (a.aborted) break
        continue
      }
      const facts = got.facts.map((f, n) => ({ text: f.text, method: f.method, evidence: f.evidence, verdict: v.verdicts.find((d) => d.candidate === n)?.verdict ?? 'reject' }))
      await cli(u, [['facts', { intent: intent.id, facts }], ['done', { intent: intent.id }]])
      return { started: true, facts: facts.length }
    }
    return { started: true, facts: 0, failed: true }
  })
}

async function extraSeen() {
  let [{ skip }] = await unit(WORST.scan, (u) => cli(u, [['skip', {}]]))
  while (skip.length) {
    const before = skip.length
    skip = await unit(WORST.extra, async (u) => {
      const x = await launch(u, 'executor', [
        `役の指示: ${ROLES}/executor.md を読む。`,
        `作業ファイルの置き場: ${run.workDir}`,
        `意図: 次のファイルを読み、目標に関わる事実があれば返す: ${skip.join(' ')}`,
      ].join('\n'), SCHEMAS.executor, 'executor:extra')
      const [seen] = await cli(u, [['seen', { intent: 'extra', paths: x?.seen ?? [] }]])
      return seen.skip
    })
    if (skip.length === before) return
  }
}

// 周の上限は 1 run の周の数に当てる（周の番号は状態で通しで数える）。却下の続きは新しい事実で数え直す。
async function rounds(startRound) {
  let rejections = 0
  let lastRejection = ''
  for (let i = 1; i <= MAX_ROUNDS; i += 1) {
    const round = startRound + i
    run.roundLaunches = 0
    const p = await plan(round)
    if (p.claimed) {
      rejections += 1
      lastRejection = p.reason
    }
    const { out, notStarted } = await pool(p.pending, item)
    if (notStarted) throw launchStop()
    await extraSeen()
    const [r] = await unit(WORST.round, (u) => cli(u, [['round', { round, launches: run.roundLaunches + 1, allFailed: out.length > 0 && out.every((x) => x.failed) }]]))
    if (r.failed >= 2) throw new Stop('blocked', '方向を選び直しても全ての意図が失敗した')
    if (r.newFacts > 0) rejections = 0
    if (rejections >= 2 && r.unreadHints === 0) throw new Stop('needs_input', `完了の主張が新しい事実を挟まずに却下され続けた（最後の却下の理由: ${lastRejection}）`)
    if (r.dry >= DRY_ROUNDS && r.unreadHints === 0) throw new Stop('dry', `${DRY_ROUNDS} 周続けて新しい事実が無かった`)
  }
  throw new Stop('iteration_limit', `周の上限 ${MAX_ROUNDS} に達した`, { limitHit: 'rounds' })
}

// 開始の送り直しを同じ状態に当てるための鍵（依頼文とリポジトリから決定的に作る。FNV-1a 32bit）。
function startKey() {
  let h = 0x811c9dc5
  for (const ch of `${input.repo}\n${input.request}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

async function main() {
  if (run.state) {
    const [r] = await unit(WORST.start, (u) => cli(u, [['resume', {}]]))
    run.run = r.run
    run.workDir = r.workDir
    return rounds(r.rounds)
  }
  const [r] = await unit(WORST.start, (u) => cli(u, [['start', { key: startKey(), request: input.request, limits: { rounds: MAX_ROUNDS, attempts: MAX_ATTEMPTS } }]]))
  run.state = r.state
  run.run = r.run
  run.workDir = r.workDir
  await fixGoal()
  return rounds(0)
}

function nextArgs() {
  return { state: run.state, repo: run.repo, skillDir: SKILL }
}

let stop
try {
  await main()
} catch (e) {
  if (!(e instanceof Stop)) throw e
  stop = e
}
if (!run.run) return { stopKind: stop.kind, reason: stop.reason, launches: budget.used() }
const final = budget.open(RESERVE)
let written = null
try {
  ;[written] = await cli(final, [['stop', { kind: stop.kind, reason: stop.reason, limitHit: stop.extra.limitHit, launches: budget.used() + 1, roundLaunches: run.roundLaunches + 1 }]])
} catch (e) {
  if (!(e instanceof Stop)) throw e
  return { stopKind: 'blocked', reason: `停止の記録を書けなかった（止めようとした停止: ${stop.kind}: ${stop.reason}）: ${e.reason}`, nextArgs: nextArgs(), launches: budget.used() }
}
return {
  stopKind: stop.kind,
  reason: written.reason,
  ...(stop.kind === 'complete' ? {} : { nextArgs: nextArgs() }),
  pending: written.pending,
  aborted: written.aborted,
  coverage: written.coverage,
  skip: written.skip,
  facts: written.facts,
  ...(stop.kind === 'complete' ? { cause: stop.extra.cause } : {}),
  launches: budget.used(),
  // SKILL.md の「役ごとの制限」の行ごとに載せる（確かめられなかった制限の全て）。
  residualRisks: [
    { role: '運搬役', restriction: 'CLI を通した状態だけに書く', host: 'Claude Code', reason: 'plugin から読み込む agent では設定の一部が無視され、効くかを確かめられない' },
    { role: '実行役・回収役', restriction: '作業ファイルだけに書く（リポジトリには書かない）', host: 'Claude Code', reason: 'plugin から読み込む agent では設定の一部が無視され、効くかを確かめられない' },
    { role: '検証役・完了の照合の検証役・計画役・目標の固定役', restriction: '作業ファイルだけに書く', host: 'Claude Code', reason: 'plugin から読み込む agent では設定の一部が無視され、効くかを確かめられない' },
    { role: '全ての役', restriction: '上の 3 行の役ごとの制限', host: 'Codex runner', reason: 'runner は agent ごとの道具の許可を持たず、権限は全ての呼び出しに一律に効く' },
  ],
}
