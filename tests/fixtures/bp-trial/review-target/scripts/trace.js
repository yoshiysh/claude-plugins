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
// 1 件の意図の最悪の起動数（実行・回収・検証・書き込みの運搬役）と、停止の運搬役の予約分。
const WORST_ITEM = MAX_ATTEMPTS * 2 + 2
const RESERVE = 1

class Stop {
  constructor(kind, reason) {
    this.kind = kind
    this.reason = reason
  }
}

function validate(a) {
  if (typeof a?.state === 'string') return { state: a.state, limit: a.maxLaunches }
  if (typeof a?.request !== 'string' || a.request === '' || typeof a?.repo !== 'string') return { error: 'request と repo が要る' }
  return { request: a.request, repo: a.repo, limit: a.maxLaunches }
}

const input = validate(args)
if (input.error) return { stopKind: 'blocked', reason: input.error, launches: 0 }
if (input.limit !== undefined && !(Number.isInteger(input.limit) && input.limit >= 1)) {
  return { stopKind: 'blocked', reason: `起動数の上限 ${JSON.stringify(input.limit)} は 1 以上の整数でなければならない`, launches: 0 }
}
const SKILL = args.skillDir
const ROLES = `${SKILL}/references/roles`
const run = { state: input.state ?? null, run: null, repo: input.repo ?? args.repo, workDir: null, launched: 0, roundLaunches: 0, pending: 0 }

function fits(n) {
  return input.limit === undefined || run.launched + n + RESERVE <= input.limit
}

async function launch(role, prompt, schema, label) {
  run.launched += 1
  run.roundLaunches += 1
  return agent(prompt, { ...ROLE_MODELS[role], label, schema })
}

async function cli(op, body) {
  const req = JSON.stringify({ repo: run.repo, state: run.state, run: run.run, ...body })
  const prompt = [
    `役の指示: ${ROLES}/carrier.md を読む。`,
    `次のコマンドを実行し、標準出力を逐語で返す:\nnode '${SKILL}/scripts/state.mjs' ${op} <<'EOF'\n${req}\nEOF`,
  ].join('\n')
  const out = await launch('carrier', prompt, { type: 'object', required: ['responses'] }, `carrier:${op}`)
  const res = out?.responses?.[0] ? JSON.parse(out.responses[0]) : null
  if (!res) throw new Stop('blocked', `運搬役が ${op} の応答を返さなかった`)
  if (!res.ok) throw new Stop('blocked', `CLI が ${op} を拒否した: ${res.code} ${res.reason}`)
  return res
}

async function pool(items, work) {
  const queue = [...items]
  const running = new Set()
  const out = []
  while (queue.length || running.size) {
    while (queue.length && running.size < CONCURRENCY) {
      const item = queue.shift()
      const p = work(item).then((r) => { out.push(r); running.delete(p) })
      running.add(p)
    }
    if (running.size) await Promise.race(running)
  }
  return out
}

async function fixGoal() {
  const g = await launch('goal', [
    `役の指示: ${ROLES}/goal.md を読む。`,
    `依頼文:\n${input.request}`,
    `リポジトリ: ${run.repo}`,
  ].join('\n'), { type: 'object', required: ['goal', 'scope', 'origin', 'missing'] }, 'goal')
  if (!g) throw new Stop('blocked', '目標の固定役が結果を返さなかった')
  if (g.missing.length) throw new Stop('needs_input', `目標の固定に要る入力が無い: ${g.missing.join(' / ')}`)
  await cli('premise', { kind: 'goal', text: JSON.stringify({ goal: g.goal, prohibitions: g.prohibitions, numeric: g.numeric }) })
  await cli('premise', { kind: 'origin', text: g.origin })
  await cli('ledger', { scope: g.scope })
}

async function plan(round) {
  const { summary, pending } = await cli('summary', {})
  run.pending = pending.length
  const p = await launch('planner', [
    `役の指示: ${ROLES}/planner.md を読む。`,
    `周: ${round}`,
    `状態の要約:\n${summary}`,
  ].join('\n'), { type: 'object', required: ['kind'] }, 'planner')
  if (!p) throw new Stop('blocked', '計画役が結果を返さなかった')
  return p
}

async function item(intent) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (!fits(WORST_ITEM)) return { intent, started: false }
    const x = await launch('executor', [
      `役の指示: ${ROLES}/executor.md を読む。`,
      `作業ファイルの置き場: ${run.workDir}`,
      `意図 ${intent.id}: ${intent.text}`,
    ].join('\n'), { type: 'object', required: ['facts', 'blank', 'seen'] }, `executor:${intent.id}`)
    const got = x ?? await launch('collector', [
      `役の指示: ${ROLES}/collector.md を読む。`,
      `記録ファイル: ${run.workDir}/${intent.id}.log`,
    ].join('\n'), { type: 'object', required: ['facts'] }, `collector:${intent.id}`)
    if (!got) {
      await cli('attempt', { intent: intent.id, reason: '実行と回収のどちらも結果を返さなかった' })
      continue
    }
    if (x?.seen?.length) await cli('seen', { intent: intent.id, paths: x.seen })
    if (x?.blank) {
      await cli('done', { intent: intent.id, blank: true })
      return { intent, started: true, facts: 0 }
    }
    const v = await launch('verifier', [
      `役の指示: ${ROLES}/verifier.md を読む。`,
      `事実の候補:\n${JSON.stringify(got.facts)}`,
    ].join('\n'), { type: 'object', required: ['verdicts'] }, `verifier:${intent.id}`)
    if (!v) {
      await cli('attempt', { intent: intent.id, reason: '検証役が結果を返さなかった' })
      continue
    }
    for (const [n, f] of got.facts.entries()) {
      const verdict = v.verdicts.find((d) => d.candidate === n)?.verdict ?? 'reject'
      await cli('fact', { intent: intent.id, text: f.text, method: f.method, evidence: f.evidence, verdict })
    }
    await cli('done', { intent: intent.id })
    return { intent, started: true, facts: got.facts.length }
  }
  return { intent, started: true, facts: 0, failed: true }
}

async function extraSeen() {
  for (;;) {
    const { skip } = await cli('skip', {})
    if (!skip.length || !fits(1)) return skip
    const x = await launch('executor', [
      `役の指示: ${ROLES}/executor.md を読む。`,
      `作業ファイルの置き場: ${run.workDir}`,
      `意図: 次のファイルを読み、目標に関わる事実があれば返す: ${skip.join(' ')}`,
    ].join('\n'), { type: 'object', required: ['facts', 'blank', 'seen'] }, 'executor:extra')
    const before = skip.length
    if (x?.seen?.length) await cli('seen', { intent: 'extra', paths: x.seen })
    if ((await cli('skip', {})).skip.length === before) return skip
  }
}

async function complete(claim) {
  const c = await cli('claim', { facts: claim.facts, numeric: claim.numeric })
  if (c.verdict === 'reject') return { ok: false, reason: c.reason }
  const j = await launch('completion', [
    `役の指示: ${ROLES}/completion.md を読む。`,
    `完了の主張:\n${JSON.stringify(claim)}`,
  ].join('\n'), { type: 'object', required: ['verdict', 'reason'] }, 'completion')
  if (!j) throw new Stop('blocked', '完了の照合の検証役が結果を返さなかった')
  await cli('claim', { facts: claim.facts, numeric: claim.numeric, verdict: j.verdict, reason: j.reason })
  return { ok: j.verdict === 'accept', reason: j.reason }
}

async function rounds(startRound) {
  let rejections = 0
  for (let round = startRound + 1; round <= MAX_ROUNDS; round += 1) {
    run.roundLaunches = 0
    if (!fits(2)) throw new Stop('iteration_limit', `起動数の上限 ${input.limit} で止まった（その時点の起動数 ${run.launched}、残した意図 ${run.pending} 件）`)
    const p = await plan(round)
    if (p.kind === 'needs_input') throw new Stop('needs_input', p.question)
    if (p.kind === 'claim') {
      const c = await complete(p.claim)
      if (c.ok) throw new Stop('complete', c.reason)
      rejections += 1
    } else {
      await cli('plan', { round, intents: p.intents, rerank: p.rerank, hintsRead: p.hintsRead })
    }
    const { pending } = await cli('summary', {})
    const results = await pool(pending, item)
    run.pending = results.filter((r) => !r.started).length
    const notStarted = results.filter((r) => !r.started)
    await extraSeen()
    const r = await cli('round', { round, launches: run.roundLaunches, allFailed: results.length > 0 && results.every((x) => x.failed) })
    if (notStarted.length) throw new Stop('iteration_limit', `起動数の上限 ${input.limit} で止まった（その時点の起動数 ${run.launched}、残した意図 ${notStarted.length} 件）`)
    if (r.failed >= 2) throw new Stop('blocked', '方向を選び直しても全ての意図が失敗した')
    if (rejections >= 2 && r.facts === 0 && r.unreadHints === 0) throw new Stop('needs_input', '完了の主張が新しい事実を挟まずに却下され続けた')
    if (r.dry >= DRY_ROUNDS && r.unreadHints === 0) throw new Stop('dry', `${DRY_ROUNDS} 周続けて新しい事実が無かった`)
  }
  throw new Stop('iteration_limit', `周の上限 ${MAX_ROUNDS} に達した`)
}

async function main() {
  let startRound = 0
  if (run.state) {
    const r = await cli('resume', {})
    run.run = r.run
    run.workDir = r.workDir
    startRound = r.rounds
  } else {
    const r = await cli('start', { request: input.request, limits: { rounds: MAX_ROUNDS, attempts: MAX_ATTEMPTS } })
    run.state = r.state
    run.run = r.run
    run.workDir = r.workDir
    await fixGoal()
  }
  await rounds(startRound)
}

let stop
try {
  await main()
} catch (e) {
  if (!(e instanceof Stop)) throw e
  stop = e
}
const written = await cli('stop', { kind: stop.kind, reason: stop.reason, launches: run.launched + 1 })
const { skip, coverage } = await cli('skip', {})
return {
  stopKind: stop.kind,
  reason: stop.reason,
  ...(stop.kind === 'complete' ? {} : { nextArgs: { state: run.state } }),
  pending: written.pending,
  aborted: written.aborted,
  coverage,
  skip,
  launches: run.launched,
  residualRisks: [
    { role: '実行役・回収役', restriction: '作業ファイルだけに書く', host: 'Claude Code', reason: 'plugin から読み込む agent では設定の一部が無視され、効くかを確かめられない' },
    { role: '検証役・計画役', restriction: '作業ファイルだけに書く', host: 'Claude Code', reason: '同上' },
  ],
}
