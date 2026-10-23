export const meta = {
  name: 'trace',
  description: '再現する失敗の根本原因を、検証した事実の連なりとして特定する探索グラフ',
  phases: [{ title: '目標の固定' }, { title: '計画' }, { title: '実行と検証' }, { title: '追加の実行' }, { title: '完了の照合' }, { title: '停止' }],
}

const CONCURRENCY = 3
const MAX_ROUNDS = 5
const MAX_ATTEMPTS = 3
const DRY_ROUNDS = 2
const RECHECKS = 1
const ROLE_MODELS = {
  goal: { model: 'fable', effort: 'high' },
  planner: { model: 'fable', effort: 'high' },
  executor: { model: 'sonnet', effort: 'medium' },
  collector: { model: 'haiku', effort: 'low' },
  verifier: { model: 'opus', effort: 'medium' },
  completion: { model: 'opus', effort: 'medium' },
  carrier: { model: 'haiku', effort: 'low' },
}
// 起動の単位ごとの最悪の起動数（references/design.md の「起動数の上限」）。
// 1 試行は、工程の agent 3（実行役・回収役・検証役）と、見た資産・事実・終わりか試行の失敗を 1 回で書く運搬役 1。
const WORST = {
  start: 1,
  goal: 2,
  plan: 5,
  item: MAX_ATTEMPTS * (3 + 1),
  extra: 2,
  scan: 1,
  round: 1,
}
// 止まるときに必ず起動する停止の運搬役 1（停止の記録と、返り値の skip 一覧・カバレッジを 1 回で運ぶ）。
const RESERVE = 1
const MIN_LAUNCHES = WORST.start + WORST.goal + WORST.plan + WORST.item + RESERVE
// SKILL.md の「役ごとの制限」の行ごとに、配布先ごとに載せる（確かめられなかった制限の全て）。agent を起動した後のどの返り値にも載せる。
const RESTRICTIONS = [
  { role: '運搬役', restriction: 'CLI を通した状態だけに書く' },
  { role: '実行役・回収役', restriction: '作業ファイルだけに書く（リポジトリには書かない）' },
  { role: '検証役・完了の照合の検証役・計画役・目標の固定役', restriction: '作業ファイルだけに書く' },
]
const HOSTS = [
  { host: 'Claude Code', reason: 'plugin から読み込む agent では設定の一部が無視され、効くかを確かめられない' },
  { host: 'Codex runner', reason: 'runner は agent ごとの道具の許可を持たず、権限は全ての呼び出しに一律に効く' },
]
const RESIDUAL_RISKS = HOSTS.flatMap((h) => RESTRICTIONS.map((r) => ({ role: r.role, restriction: r.restriction, host: h.host, reason: h.reason })))

const STR = { type: 'string' }
const LIST = { type: 'array' }
const IDS = { type: 'array', items: STR }
const SCHEMAS = {
  carrier: { type: 'object', properties: { responses: { type: 'array', items: STR } }, required: ['responses'] },
  goal: { type: 'object', properties: { goal: STR, scope: IDS, prohibitions: IDS, numeric: LIST, origin: STR, missing: IDS }, required: ['goal', 'scope', 'prohibitions', 'numeric', 'origin', 'missing'] },
  planner: {
    type: 'object',
    properties: {
      kind: { enum: ['intents', 'claim', 'needs_input'] },
      intents: { type: 'array', items: { type: 'object', properties: { key: STR, text: STR, basis: IDS, rank: { type: 'integer' }, recheck: STR }, required: ['key', 'text', 'basis', 'rank'] } },
      rerank: { type: 'array', items: { type: 'object', properties: { intent: STR, rank: { type: 'integer' } }, required: ['intent', 'rank'] } },
      claim: { type: 'object', properties: { cause: STR, facts: IDS, numeric: { type: 'array', items: { type: 'object', properties: { condition: { type: 'integer' }, fact: STR }, required: ['condition', 'fact'] } }, answers: STR }, required: ['cause', 'facts', 'numeric'] },
      question: STR,
    },
    required: ['kind'],
  },
  verifier: { type: 'object', properties: { verdicts: { type: 'array', items: { type: 'object', properties: { candidate: { type: 'integer' }, verdict: { enum: ['accept', 'reject', 'unverifiable'] }, reason: STR }, required: ['candidate', 'verdict', 'reason'] } } }, required: ['verdicts'] },
  completion: { type: 'object', properties: { verdict: { enum: ['accept', 'reject'] }, reason: STR }, required: ['verdict', 'reason'] },
}

class Stop {
  constructor(kind, reason, extra = {}) {
    this.kind = kind
    this.reason = reason
    this.extra = extra
  }
}

// 入力の項目の正本は SKILL.md の「起動」の表。最初の起動も再開も、state・repo・skillDir・resumeKey を受ける。
function validate(a) {
  const missing = ['state', 'repo', 'skillDir', 'resumeKey'].filter((k) => typeof a?.[k] !== 'string' || a[k] === '')
  if (missing.length) return { error: `起動に要る項目が無い: ${missing.join(', ')}` }
  return { state: a.state, repo: a.repo, skillDir: a.skillDir, resumeKey: a.resumeKey, limit: a.maxLaunches }
}

// 上限の確かめを他の項目の確かめより先に行う（docs/specifications/bp-run.md の SP-BPRUN-037。同時に当たる入力でも上限の理由を返す）。
// 上限の誤りは利用者が直してから同じ状態で起動し直すので、再開の入力なら渡された nextArgs の項目を返す。
const limit = args?.maxLaunches
const retry = typeof args?.state === 'string' ? { nextArgs: { state: args.state, repo: args.repo, skillDir: args.skillDir, resumeKey: args.resumeKey } } : {}
if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1)) {
  return { stopKind: 'blocked', reason: `起動数の上限 ${JSON.stringify(limit)} は 1 以上の整数でなければならない`, ...retry, launches: 0 }
}
if (limit !== undefined && limit < MIN_LAUNCHES) {
  return { stopKind: 'blocked', reason: `起動数の上限 ${limit} が最小の起動数 ${MIN_LAUNCHES} に満たない。上限が 1 件の意図にも足りない`, ...retry, launches: 0 }
}
const input = validate(args)
if (input.error) return { stopKind: 'blocked', reason: input.error, launches: 0 }
const SKILL = input.skillDir
const ROLES = `${SKILL}/references/roles`
const run = { state: input.state, run: null, repo: input.repo, workDir: null, writeKey: null, resumeKey: input.resumeKey, methods: null, premises: '', commands: [], round: null, roundLaunches: 0 }

// 検証方式の綴りは CLI が再開の応答で渡す（CLI の受け付ける綴りと、実行役に書かせる綴りを 1 つにする）。
function factSchemas() {
  const facts = { type: 'array', items: { type: 'object', properties: { text: STR, method: { enum: Object.keys(run.methods) }, evidence: STR }, required: ['text', 'method', 'evidence'] } }
  return {
    executor: { type: 'object', properties: { facts, blank: { type: 'boolean' }, seen: IDS }, required: ['facts', 'blank', 'seen'] },
    collector: { type: 'object', properties: { facts }, required: ['facts'] },
  }
}
// agent に渡す CLI のコマンドは全てここで作る。SKILL.md の「必要な許可」の Bash の許可はこの字面（パスを ' で囲む）との前方一致で効くので、形を変えるときは許可の文も合わせる。
const command = (script, op, body) => `node '${SKILL}/scripts/${script}' ${op} <<'EOF'\n${typeof body === 'string' ? body : JSON.stringify(body)}\nEOF`
// 写しは CLI と同じ置き場の下に、対象のリポジトリに書かない形で作る（scripts/copy.mjs）。写しの中で実行できるのは、開始で記録した再現手順のコマンドだけ。
const copyLines = (to) => [
  `写しを作り直すコマンド（同じパスにあれば消して作り直す）: ${command('copy.mjs', 'make', { repo: run.repo, to })}`,
  `写しの中で再現手順のコマンドを実行するコマンド（command に下の番号を書く）: ${command('copy.mjs', 'exec', { repo: run.repo, to, command: 1 })}`,
  `再現手順のコマンド:\n${run.commands.map((c, n) => `${n + 1}: ${c}`).join('\n') || '（無い）'}`,
]
const gitLine = () => `リポジトリを git で読む CLI（log・show・diff・blame・ls-files・grep。git を直接は実行しない）: ${command('git-read.mjs', 'log', { repo: run.repo, args: ['-1', '--oneline'] })}`
const knownLine = () => `既知の事実を引く CLI（読み出しだけ）: ${command('state.mjs', 'get', { repo: run.repo, state: run.state, kind: '事実' })}`
const methodsLine = () => `検証方式の綴り（method に書く）: ${Object.entries(run.methods).map(([k, name]) => `${k}（${name}）`).join('・')}`

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

// agent() の失敗（throw）も結果の欠けとして返す。工程の中では試行の失敗に、工程の外では BLOCKED の停止になり、どちらも理由が状態に残る。
async function launch(u, role, lines, schema, label) {
  budget.charge(u)
  run.roundLaunches += 1
  // 運搬役の出力は CLI の標準出力で、状態に残る。他の役の出力は run のディレクトリに写しを残す。
  const copy = role === 'carrier' ? [] : [`出力の写し: ${run.workDir}/${String(budget.used()).padStart(4, '0')}-${label.replace(/[^\w.-]/g, '_')}.json`]
  try {
    return await agent([...lines, ...copy].join('\n'), { ...ROLE_MODELS[role], label, schema })
  } catch {
    return null
  }
}

// 1 回の運搬役で、渡した順に CLI のコマンドを実行させる。書き込みの鍵は運搬役の prompt にだけ入れる。
async function cli(u, ops) {
  const names = ops.map(([op]) => op).join(',')
  const commands = ops.map(([op, body]) => {
    const req = JSON.stringify({ repo: run.repo, state: run.state, run: run.run, writeKey: run.writeKey, ...body })
    return command('state.mjs', op, req)
  })
  const out = await launch(u, 'carrier', [`役の指示: ${ROLES}/carrier.md を読む。`, `次のコマンドを順に実行し、各コマンドの標準出力を 1 行ずつ逐語で返す:\n${commands.join('\n')}`], SCHEMAS.carrier, `carrier:${names}`)
  let responses
  try {
    responses = (out?.responses ?? []).map((line) => JSON.parse(line))
  } catch {
    throw new Stop('blocked', `運搬役が ${names} の応答を CLI の出力の行のまま返さなかった`)
  }
  if (responses.length !== ops.length) throw new Stop('blocked', `運搬役が ${names} の応答を返さなかった`)
  const bad = responses.find((r) => !r?.ok)
  if (bad) throw new Stop('blocked', `CLI が ${bad.op ?? names} を拒否した: ${bad.code} ${bad.reason}`)
  return responses
}

// 意図ごとに pipeline() の 1 item として流す。item は CONCURRENCY の枠を順位の順に取り、枠を取ったときに起動数の上限で確かめる
// （収まらなければ、その item と後の item を始めずに未着手で残す）。1 件が止まったら、まだ始めていない item は始めずに終わる。
// pipeline() は item の失敗を null にして残りを続けるので、停止は item の中で受け止めて、全ての item の終わりの後に投げ直す。
async function flow(items, work) {
  let free = CONCURRENCY
  const waiting = []
  const take = () => (free > 0 ? ((free -= 1), Promise.resolve()) : new Promise((resolve) => waiting.push(resolve)))
  const give = () => { const next = waiting.shift(); if (next) next(); else free += 1 }
  const errors = []
  let full = false
  let notStarted = 0
  const out = await pipeline(items, async (intent) => {
    await take()
    try {
      if (errors.length) return undefined
      if (full || !budget.fits(WORST.item)) {
        full = true
        notStarted += 1
        return undefined
      }
      return await work(intent)
    } catch (e) {
      errors.push(e)
      return undefined
    } finally {
      give()
    }
  })
  if (errors.length) throw errors[0]
  return { out: out.filter((r) => r !== undefined && r !== null), notStarted }
}

// 足りない入力で止まった後の再開では、止まっていた間に足されたヒント（問いへの答え）も渡す。読んだと数えるのは計画役に渡した要約に載ったヒントだけなので、ここでは数えない。
async function fixGoal(request, hints) {
  await unit(WORST.goal, async (u) => {
    const g = await launch(u, 'goal', [
      `役の指示: ${ROLES}/goal.md を読む。`,
      `依頼文:\n${request}`,
      ...(hints.length ? [`利用者が足したヒント（足りない入力への答え）:\n${hints.map((h) => `${h.id}: ${h.text}`).join('\n')}`] : []),
      `リポジトリ: ${run.repo}`,
    ], SCHEMAS.goal, 'goal')
    if (!g) throw new Stop('blocked', '目標の固定役が結果を返さなかった')
    if (g.missing.length) throw new Stop('needs_input', `目標の固定に要る入力が無い: ${g.missing.join(' / ')}`)
    await cli(u, [['goal', { goal: JSON.stringify({ goal: g.goal, scope: g.scope, prohibitions: g.prohibitions, numeric: g.numeric }), origin: g.origin, scope: g.scope }]])
  })
}

// 計画の単位: 要約・計画役・（意図の書き込み、または完了の主張の照合 2 回と完了の照合の検証役）。最悪は完了の主張の 5。
// 読んだヒントは要約に載ったヒント（計画役の申告でなく、渡したものを CLI に返す）。
async function plan(round) {
  return unit(WORST.plan, async (u) => {
    const [s] = await cli(u, [['summary', {}]])
    run.premises = s.premises
    run.commands = s.commands
    const p = await launch(u, 'planner', [
      `役の指示: ${ROLES}/planner.md を読む。`,
      `周: ${round}`,
      `同じ方向の再確認の意図の上限: 1 つの方向につき ${RECHECKS} 回`,
      `細部を引く CLI（読み出しだけ）: ${command('state.mjs', 'get', { repo: run.repo, state: run.state, id: '<ID>' })}`,
      `状態の要約:\n${s.summary}`,
    ], SCHEMAS.planner, 'planner')
    if (!p) throw new Stop('blocked', '計画役が結果を返さなかった')
    if (p.kind === 'needs_input') throw new Stop('needs_input', p.question ?? '計画役が人間の入力が要ると返した')
    if (p.kind !== 'claim') {
      const [planned] = await cli(u, [['plan', { round, intents: p.intents ?? [], rerank: p.rerank ?? [], hintsRead: s.hints }]])
      return { pending: planned.pending, claimed: false }
    }
    const claim = { round, facts: p.claim.facts, numeric: p.claim.numeric, hintsRead: s.hints }
    const [c] = await cli(u, [['claim', claim]])
    if (c.verdict === 'reject') return { pending: c.pending, claimed: true, reason: c.reason }
    const j = await launch(u, 'completion', [
      `役の指示: ${ROLES}/completion.md を読む。`,
      `固定した目標:\n${c.goal}`,
      `完了の主張:\n${JSON.stringify(p.claim)}`,
      `主張が挙げた受理済みの事実:\n${c.cited.map((f) => `${f.id}: ${f.text}`).join('\n')}`,
    ], SCHEMAS.completion, 'completion')
    if (!j) throw new Stop('blocked', '完了の照合の検証役が結果を返さなかった')
    const [judged] = await cli(u, [['claim', { ...claim, verdict: j.verdict, reason: j.reason }]])
    if (j.verdict === 'accept') throw new Stop('complete', j.reason, { cause: { explanation: p.claim.cause, reason: j.reason, facts: p.claim.facts } })
    return { pending: judged.pending, claimed: true, reason: j.reason }
  })
}

// 工程の欠けは、実行の工程が欠け、回収でも受理が 1 件も出なかった試行（事実を書かず、試行の失敗だけを書く）。
async function item(intent, round) {
  return unit(WORST.item, async (u) => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const x = await launch(u, 'executor', [
        `役の指示: ${ROLES}/executor.md を読む。`,
        `リポジトリ: ${run.repo}`,
        `作業ファイルの置き場: ${run.workDir}`,
        `試行: ${attempt}`,
        ...copyLines(`${run.workDir}/${intent.id}.${attempt}`),
        knownLine(),
        gitLine(),
        `前提（目標・範囲・禁止事項と出発点。範囲の外へ広げない）:\n${run.premises}`,
        `意図 ${intent.id}: ${intent.text}`,
        ...(intent.recheck ? [`確かめ直す事実（意図の間で判定が食い違った。本文を変えずに確かめる）: ${intent.recheck.fact}: ${intent.recheck.text}`] : []),
        methodsLine(),
      ], factSchemas().executor, `executor:${intent.id}`)
      const seen = x?.seen?.length ? [['seen', { round, attempt, intent: intent.id, paths: x.seen }]] : []
      const failed = async (reason) => (await cli(u, [...seen, ['attempt', { round, attempt, intent: intent.id, reason }]])).at(-1)
      if (x && (x.blank || !x.facts.length) && !intent.recheck) {
        await cli(u, [...seen, ['done', { intent: intent.id, blank: true }]])
        return { facts: 0 }
      }
      const found = x ? x.facts : (await launch(u, 'collector', [
        `役の指示: ${ROLES}/collector.md を読む。`,
        `記録ファイル: ${run.workDir}/${intent.id}.log`,
        methodsLine(),
      ], factSchemas().collector, `collector:${intent.id}`))?.facts ?? []
      // 確かめ直しの意図は、食い違った事実を必ず検証役の候補に入れる（実行役が返さないか言い換えると、同じ事実の判定にならない）。
      // 実行役が本文のまま返したら、その候補だけを使う（2 つ載せると、同じ事実に 2 つの判定が付いて、確かめ直しの中で食い違う）。
      const recheck = intent.recheck && !found.some((f) => f.text === intent.recheck.text) ? [{ text: intent.recheck.text, method: intent.recheck.method, evidence: intent.recheck.evidence }] : []
      const candidates = [...found, ...recheck]
      if (!candidates.length) {
        if ((await failed('実行役が結果を返さず、回収役も事実の候補を返さなかった')).aborted) break
        continue
      }
      const v = await launch(u, 'verifier', [
        `役の指示: ${ROLES}/verifier.md を読む。`,
        `リポジトリ: ${run.repo}`,
        `作業ファイルの置き場: ${run.workDir}`,
        `意図 ${intent.id}・試行 ${attempt}`,
        ...copyLines(`${run.workDir}/${intent.id}.${attempt}.verify`),
        gitLine(),
        `前提:\n${run.premises}`,
        `事実の候補（行頭が候補の番号）:\n${candidates.map((f, n) => `${n}: ${JSON.stringify(f)}`).join('\n')}`,
      ], SCHEMAS.verifier, `verifier:${intent.id}`)
      const verdicts = candidates.map((_, n) => v?.verdicts?.find((d) => d.candidate === n)?.verdict)
      if (verdicts.some((d) => d === undefined)) {
        if ((await failed('検証役が全ての候補に判定を返さなかった')).aborted) break
        continue
      }
      const facts = candidates.map((f, n) => ({ text: f.text, method: f.method, evidence: f.evidence, verdict: verdicts[n] }))
      if (!x && !facts.some((f) => f.verdict === 'accept')) {
        if ((await failed('実行役が結果を返さず、回収した候補が 1 件も受理されなかった')).aborted) break
        continue
      }
      const written = (await cli(u, [...seen, ['facts', { intent: intent.id, facts }]])).at(-1)
      if (written.disputes.length) throw new Stop('blocked', `同じ事実の判定が意図の間で食い違った: ${written.disputes.join(', ')}（最初の判定を残し、食い違いは要約に載る。再開すると、計画役が食い違った事実を確かめ直す意図を出せる）`)
      return { facts: facts.length }
    }
    return { facts: 0, failed: true }
  })
}

async function extraSeen(round) {
  let [{ skip }] = await unit(WORST.scan, (u) => cli(u, [['skip', {}]]))
  for (let pass = 1; skip.length; pass += 1) {
    const before = skip.length
    skip = await unit(WORST.extra, async (u) => {
      const x = await launch(u, 'executor', [
        `役の指示: ${ROLES}/executor.md を読む。`,
        `リポジトリ: ${run.repo}`,
        `作業ファイルの置き場: ${run.workDir}`,
        gitLine(),
        `前提:\n${run.premises}`,
        `意図: 台帳で誰も見ていない次のファイルを読み、読んだファイルを seen に返す。facts は空にする（この起動は見ていないファイルを無くすためのもので、事実は計画役の意図で確かめる）: ${skip.join(' ')}`,
        methodsLine(),
      ], factSchemas().executor, 'executor:extra')
      if (!x) throw new Stop('blocked', '追加の実行役が結果を返さなかった')
      const [seen] = await cli(u, [['seen', { round, pass, extra: true, paths: x.seen }]])
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
    run.round = round
    run.roundLaunches = 0
    // 意図は周の中で終わるか打ち切られるので、周の終わりの未着手は 0 件になる。毎周の計画役の呼び出しは「未着手の意図が無くなったとき」に当たる。
    const p = await plan(round)
    if (p.claimed) {
      rejections += 1
      lastRejection = p.reason
    }
    const { out, notStarted } = await flow(p.pending, (intent) => item(intent, round))
    if (notStarted) throw launchStop()
    await extraSeen(round)
    const [r] = await unit(WORST.round, (u) => cli(u, [['round', { round, launches: run.roundLaunches + 1, allFailed: out.length > 0 && out.every((x) => x.failed) }]]))
    run.round = null
    run.roundLaunches = 0
    if (r.failed >= 2) throw new Stop('blocked', '方向を選び直しても全ての意図が失敗した')
    if (r.newFacts > 0) rejections = 0
    if (rejections >= 2 && r.unreadHints === 0) throw new Stop('needs_input', `完了の主張が新しい事実を挟まずに却下され続けた（最後の却下の理由: ${lastRejection}）`)
    if (r.dry >= DRY_ROUNDS && r.unreadHints === 0) throw new Stop('dry', `${DRY_ROUNDS} 周続けて新しい事実が無かった`)
  }
  throw new Stop('iteration_limit', `周の上限 ${MAX_ROUNDS} に達した`, { limitHit: 'rounds' })
}

function begin(r) {
  run.state = r.state
  run.run = r.run
  run.workDir = r.workDir
  run.writeKey = r.writeKey
  run.methods = r.methods
}

// 状態は呼び出し元が run の前に CLI の start で作る（SKILL.md の「起動」）。script は最初の起動も再開として始める。
async function main() {
  const [r] = await unit(WORST.start, (u) => cli(u, [['resume', { resumeKey: run.resumeKey, limits: { rounds: MAX_ROUNDS, attempts: MAX_ATTEMPTS } }]]))
  if (r.completed) throw new Stop('complete', r.reason, { cause: r.cause, written: r })
  begin(r)
  if (r.request !== undefined) await fixGoal(r.request, r.hints)
  return rounds(r.rounds)
}

function nextArgs() {
  return { state: run.state, repo: run.repo, skillDir: SKILL, resumeKey: run.resumeKey }
}

let stop
try {
  await main()
} catch (e) {
  stop = e instanceof Stop ? e : new Stop('blocked', `script が止まった: ${e?.message ?? String(e)}`)
}
// 停止の記録と、完了が書かれた状態の再開は、同じ返り値の項目を返す（SKILL.md の「返り値」）。
const result = (written) => ({
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
  roundLaunches: written.rounds,
  residualRisks: RESIDUAL_RISKS,
})
if (stop.extra.written) return result(stop.extra.written)
if (!run.run) {
  return { stopKind: stop.kind, reason: stop.reason, nextArgs: nextArgs(), launches: budget.used(), residualRisks: RESIDUAL_RISKS }
}
const final = budget.open(RESERVE)
let written = null
try {
  // 周の途中で止まったときは、停止の運搬役をその周の起動に数える。周の記録の後に止まったときは、どの周にも数えない。
  ;[written] = await cli(final, [['stop', { kind: stop.kind, reason: stop.reason, limitHit: stop.extra.limitHit, cause: stop.extra.cause, launches: budget.used() + 1, ...(run.round ? { round: run.round, roundLaunches: run.roundLaunches + 1 } : {}) }]])
} catch (e) {
  const why = e instanceof Stop ? e.reason : String(e)
  return {
    stopKind: 'blocked',
    reason: `停止の記録を書けたかが分からない（止めようとした停止: ${stop.kind}: ${stop.reason}）: ${why}。nextArgs で再開すると、CLI が状態に書かれた停止を読む（完了が書かれていれば完了を返し、停止が書かれていなければ BLOCKED の停止を足してから続ける）`,
    nextArgs: nextArgs(),
    launches: budget.used(),
    residualRisks: RESIDUAL_RISKS,
  }
}
return result(written)
