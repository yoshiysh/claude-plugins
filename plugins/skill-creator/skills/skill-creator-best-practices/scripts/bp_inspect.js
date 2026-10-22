export const meta = {
  name: 'best-practices-inspect',
  description: 'best-practices の review・audit を 1 run として進め、対象スキルを書き換えずに状態を CLI に書かせて停止の種類と返り値を返す',
  phases: [
    { title: '開始' },
    { title: '照らす先の決定' },
    { title: '台帳の作成と資産の束' },
    { title: '担当の作成' },
    { title: '適用の判定' },
    { title: '観点ごとの検証' },
    { title: '反証' },
    { title: '消えた資産の照合' },
    { title: '照合と停止' },
  ],
}

// 以下の定数は CLI の scripts/bp/constants.mjs と仕様の表の写し。script は import できないので写しを持ち、
// 一致は tests/bp-spelling.test.mjs が照らす（写しを 1 字でも変えるとテストが落ちる）。本文が閉集合の値をリテラルで書き直すと照合の外に出るので、
// 本文は定数から引く（同じテストが本文のリテラルと prompt の引用を照らす）。照らす先のパスは写さず、CLI の照らす先の決定の出力から得る。
const OPS = {
  start: 'start', premise: 'premise', stageStart: 'stage-start', itemResult: 'item-result', itemFail: 'item-fail',
  stageRepeat: 'stage-repeat', stageFinish: 'stage-finish', discard: 'discard', files: 'files', stop: 'stop',
  summary: 'summary', list: 'list', ledgerCreate: 'ledger-create', ledgerRetake: 'ledger-retake', assignments: 'assignments',
  verdicts: 'verdicts', refutationItems: 'refutation-items', refutation: 'refutation', reviewJudge: 'review-judge',
  vanishMatch: 'vanish-match', report: 'report', kinds: 'kinds', key: 'key', paths: 'paths', pathsRetake: 'paths-retake',
  snapshot: 'snapshot', goalCheck: 'goal-check', filesScan: 'files-scan', units: 'units', gate: 'gate', outcome: 'outcome',
  targets: 'targets', bundle: 'bundle', applicability: 'applicability', stopDraft: 'stop-draft',
}
const STAGE = {
  start: 'start', snapshot: 'snapshot', goal: 'goal', write: 'write', ledger: 'ledger', targets: 'targets', bundle: 'bundle',
  assign: 'assign', applicability: 'applicability', verify: 'verify', verifyExtra: 'verify-extra', refute: 'refute',
  vanish: 'vanish', rejudge: 'rejudge', gate: 'gate', close: 'close',
}
const STAGE_TITLES = {
  start: '開始', targets: '照らす先の決定', bundle: '台帳の作成と資産の束', assign: '担当の作成', applicability: '適用の判定',
  verify: '観点ごとの検証', 'verify-extra': '追加の検証', refute: '反証', vanish: '消えた資産の照合', close: '照合と停止',
}
const CODES = {
  conflict: 'E_CONFLICT', unknownId: 'E_UNKNOWN_ID', staleRun: 'E_STALE_RUN', result: 'E_RESULT', input: 'E_INPUT',
  place: 'E_PLACE', transport: 'E_TRANSPORT', lock: 'E_LOCK', internal: 'E_INTERNAL',
}
const FUNCTION = { create: 'create', review: 'review', update: 'update', audit: 'audit' }
const STOP_KINDS = { complete: 'complete', needsInput: 'needs_input', iterationLimit: 'iteration_limit', blocked: 'blocked' }
const NEXT_ARGS_KEYS = { function: 'function', state: 'state' }
const LIMIT_KEYS = { attempts: 'attempts', iterations: 'iterations', untilPass: 'untilPass' }
const INPUT_KEYS = {
  function: 'function', request: 'request', target: 'target', grounds: 'grounds', nextArgs: 'nextArgs', answer: 'answer',
  maxLaunches: 'maxLaunches', skillDir: 'skillDir', key: 'key',
}
const RESULT_KEYS = {
  stopKind: 'stopKind', reason: 'reason', nextArgs: 'nextArgs', state: 'state', run: 'run', launches: 'launches',
  writtenFiles: 'writtenFiles', unverifiedRoleLimits: 'unverifiedRoleLimits', skill: 'skill', designNote: 'designNote',
  verification: 'verification', findings: 'findings', skip: 'skip', residualRisks: 'residualRisks', receivedGrounds: 'receivedGrounds',
  excludedCallsites: 'excludedCallsites', unverified: 'unverified', stoppedStage: 'stoppedStage', targets: 'targets',
  applicability: 'applicability', uncheckedViewpoints: 'uncheckedViewpoints', target: 'target', ledger: 'ledger',
}
const RUN_VIEWPOINTS = { create: ['conformance', 'goal'], update: ['conformance', 'goal', 'contract'], review: ['flow', 'spec'], audit: ['audit'] }
const INSPECT_PIPELINE = ['targets', 'bundle', 'assign', 'applicability', 'verify', 'verify-extra', 'refute', 'close']
const LIMIT_HITS = { iteration: 'iteration', launch: 'launch' }
const ASSIGN_RULES = { all: 'all', skip: 'skip' }
const JUDGEMENTS = { candidate: 'candidate', ok: 'ok', unsure: 'unsure' }
const REFUTATION_VERDICTS = { uphold: 'uphold', reject: 'reject' }
const VANISH_NONE = 'none'
const STOP_CAUSES = { verifiers: 'verifiers' }
const APPLICABILITY_QUESTIONS = ['A', 'Q1', 'Q2', 'Q3']
const APPLICABILITY_ANSWERS = { yes: 'はい', no: 'いいえ', unreached: '問いに到達しない' }
const PRESENCE = { present: '有', absent: '無' }
const PRESENCE_QUESTIONS = ['ledger', 'fanout']
const TARGET_FILES = { conformance: 'conformance', design: 'design', inspection: 'inspection', promptAudit: 'promptAudit', designedSkill: 'designedSkill' }
const UNCHECKED_SCOPES = { whole: 'whole', unit: 'unit', pa: 'pa' }
const INSPECT_ROLE_WRITE_LIMITS = [
  { role: '検証役・反証役・抽出役', writes: '作業ファイルだけ' },
  { role: '運搬役', writes: 'CLI を通した状態だけ' },
]

const ROLE_MODELS = {
  writer: { model: 'opus', effort: 'high' },
  verifier: { model: 'opus', effort: 'high' },
  refuter: { model: 'opus', effort: 'high' },
  extractor: { model: 'sonnet', effort: 'medium' },
  carrier: { model: 'haiku', effort: 'low' },
}
// SP-BPCONFORMANCE-031・029・028・027 の値。script が値の唯一の持ち主で、CLI は start で受け取って状態の limits から判定する。
const LIMITS = { attempts: 3, iterations: 3, untilPass: 3 }
const CONCURRENCY = 3
// 検証役の大きい結果を運搬役に写させないため作業ファイルで渡す。本物の agent での拒否の率は未実測（公開前の本物の agent での試走で測る）。
const PAYLOAD_MODE = 'file'

// 起動数の勘定（SP-BPCONFORMANCE-022 の式。値の根拠は tests/bp-inspect-workflow.test.mjs の最悪の経路の計数）。鍵が bp_author.js と同じものは同じ値にする。
// RESERVE は停止の前の書き込みの運搬役 1 と停止の運搬役 1（SP-BPRUN-021 の予約分）。
const WORST = {
  start: 2,
  carrier: 1,
  targets: 1,
  bundle: 1,
  attempt: 2,
  item: LIMITS.attempts * 5,
}
const RESERVE = 2

function minimalLaunches(fn) {
  // 最大は最初の run（照らす先の決定を終える前に止まった run の再開も同じ）。担当の作成と適用の判定は試行の上限の回数まで起動し直す（SP-BPFINDINGS-034）。
  // audit は担当 ID を得てから観点ごとの検証の段の開始を書く運搬役が 1 回多い（review は適用の判定の運搬役に含める）。
  return WORST.start + WORST.targets + WORST.bundle + LIMITS.attempts * WORST.attempt
    + (fn === FUNCTION.review ? LIMITS.attempts * WORST.attempt : WORST.carrier) + WORST.item + RESERVE
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonical(v))).join(',')}]`
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
}

function fnvSum(value) {
  const text = canonical(value)
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

class Stop {
  constructor(kind, reason, extra = {}) {
    this.kind = kind
    this.reason = reason
    this.extra = extra
  }
}

function makeBudget(limit) {
  let used = 0
  let seq = 0
  const running = new Map()
  return {
    used: () => used,
    limit,
    fits(worst) {
      if (limit === undefined) return true
      let rest = 0
      for (const u of running.values()) rest += Math.max(0, u.worst - u.used)
      return used + rest + worst + RESERVE <= limit
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
}

const CARRIER_SCHEMA = {
  type: 'object',
  properties: { responses: { type: 'array', items: { type: 'string' } } },
  required: ['responses'],
  additionalProperties: false,
}

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: { groups: { type: 'array', items: { type: 'array', minItems: 1, items: { type: 'string' } } } },
  required: ['groups'],
  additionalProperties: false,
}

function answerSchema(choices) {
  return {
    type: 'object',
    properties: {
      answer: { type: 'string', enum: choices },
      quotes: {
        type: 'array',
        minItems: 1,
        items: { type: 'object', properties: { asset: { type: 'string' }, line: { type: 'integer' }, text: { type: 'string' } }, required: ['asset', 'line', 'text'], additionalProperties: false },
      },
    },
    required: ['answer', 'quotes'],
    additionalProperties: false,
  }
}

function applicabilitySchema() {
  const answers = {
    type: 'object',
    properties: Object.fromEntries(APPLICABILITY_QUESTIONS.map((q) => [q, answerSchema(Object.values(APPLICABILITY_ANSWERS))])),
    required: APPLICABILITY_QUESTIONS,
    additionalProperties: false,
  }
  return {
    type: 'object',
    properties: { answers, ...Object.fromEntries(PRESENCE_QUESTIONS.map((q) => [q, answerSchema(Object.values(PRESENCE))])) },
    required: ['answers', ...PRESENCE_QUESTIONS],
    additionalProperties: false,
  }
}

function verifySchema() {
  return {
    type: 'object',
    properties: {
      judgements: {
        type: 'array',
        items: { type: 'object', properties: { asset: { type: 'string' }, judgement: { type: 'string', enum: Object.values(JUDGEMENTS) } }, required: ['asset', 'judgement'], additionalProperties: false },
      },
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: { asset: { type: 'string' }, viewpoint: { type: 'string' }, kind: { type: 'string' }, quote: { type: 'string' }, content: { type: 'string' }, fix: { type: 'string' } },
          required: ['asset', 'viewpoint', 'kind', 'quote', 'content', 'fix'],
          additionalProperties: false,
        },
      },
      unchecked: {
        type: 'array',
        items: {
          type: 'object',
          properties: { viewpoint: { type: 'string' }, scope: { type: 'string', enum: Object.values(UNCHECKED_SCOPES) }, value: { type: 'string' }, reason: { type: 'string' } },
          required: ['viewpoint', 'scope', 'value', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['judgements', 'candidates', 'unchecked'],
    additionalProperties: false,
  }
}

const REFUTE_SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: Object.values(REFUTATION_VERDICTS) }, reason: { type: 'string' } },
  required: ['verdict', 'reason'],
  additionalProperties: false,
}
const VANISH_SCHEMA = { type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'], additionalProperties: false }

function early(kind, reason, nextState) {
  const out = { [RESULT_KEYS.stopKind]: kind, [RESULT_KEYS.reason]: reason, [RESULT_KEYS.launches]: 0 }
  if (nextState) {
    out[RESULT_KEYS.nextArgs] = nextState
    out[RESULT_KEYS.state] = nextState[NEXT_ARGS_KEYS.state]
  }
  return out
}

function checkHostArgs(a, nextState) {
  const skillDir = a[INPUT_KEYS.skillDir]
  if (typeof skillDir !== 'string' || !skillDir.startsWith('/') || skillDir.includes("'")) {
    return early(STOP_KINDS.blocked, `skillDir は ' を含まない絶対パスでなければならない: ${JSON.stringify(skillDir)}`, nextState)
  }
  // key の形は CLI の開始の操作が照らす（写しを持たない）。ここでは要求の JSON に入れられる文字列であることだけを確かめる。
  if (typeof a[INPUT_KEYS.key] !== 'string' || a[INPUT_KEYS.key] === '') {
    return early(STOP_KINDS.blocked, `key は空でない文字列でなければならない: ${JSON.stringify(a[INPUT_KEYS.key])}`, nextState)
  }
  return null
}

function validateArgs(input) {
  const a = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const resume = Object.hasOwn(a, INPUT_KEYS.nextArgs)
  const na = resume ? a[INPUT_KEYS.nextArgs] : null
  const nextState = na && typeof na === 'object' && typeof na[NEXT_ARGS_KEYS.state] === 'string' ? na : null
  const fn = resume ? na?.[NEXT_ARGS_KEYS.function] : a[INPUT_KEYS.function]
  const stray = Object.keys(a).filter((k) => !Object.values(INPUT_KEYS).includes(k))
  if (stray.length) return { stop: early(STOP_KINDS.blocked, `入力に表に無い項目がある: ${stray.join(', ')}（SP-BPENTRY-013）`, nextState) }
  const forbidden = resume
    ? [INPUT_KEYS.function, INPUT_KEYS.request, INPUT_KEYS.target, INPUT_KEYS.grounds].filter((k) => Object.hasOwn(a, k))
    : [INPUT_KEYS.answer, INPUT_KEYS.request, INPUT_KEYS.grounds].filter((k) => Object.hasOwn(a, k))
  if (forbidden.length) return { stop: early(STOP_KINDS.blocked, `${resume ? '再開' : '新しい状態での起動'}に渡してはならない項目がある: ${forbidden.join(', ')}（SP-BPENTRY-013）`, nextState) }
  if (resume && (!nextState || Object.keys(na).some((k) => !Object.values(NEXT_ARGS_KEYS).includes(k)))) {
    return { stop: early(STOP_KINDS.blocked, `nextArgs は ${Object.values(NEXT_ARGS_KEYS).join('・')} だけを持たなければならない: ${JSON.stringify(na)}`) }
  }
  if (fn !== FUNCTION.review && fn !== FUNCTION.audit) return { stop: early(STOP_KINDS.blocked, `機能が review・audit のどれでもない: ${JSON.stringify(fn)}`, nextState) }
  if (a[INPUT_KEYS.maxLaunches] !== undefined) {
    const limit = a[INPUT_KEYS.maxLaunches]
    if (!Number.isInteger(limit) || limit < 1) {
      return { stop: early(STOP_KINDS.blocked, `起動数の上限 ${JSON.stringify(limit)} は 1 以上の整数でなければならない（受け付ける値: 1 以上の整数）`, nextState) }
    }
    const min = minimalLaunches(fn)
    if (limit < min) {
      return { stop: early(STOP_KINDS.blocked, `起動数の上限 ${limit} が最小の起動数 ${min} に満たない。上限が 1 件の項目にも足りない`, nextState) }
    }
  }
  const host = checkHostArgs(a, nextState)
  if (host) return { stop: host }
  const skillDir = a[INPUT_KEYS.skillDir]
  if (resume) {
    const answer = a[INPUT_KEYS.answer]
    if (answer !== undefined && (typeof answer !== 'string' || answer === '')) return { stop: early(STOP_KINDS.blocked, 'answer は空でない文字列でなければならない', nextState) }
    return { fn, resume: true, state: nextState[NEXT_ARGS_KEYS.state], skillDir, key: a[INPUT_KEYS.key], answer, limit: a[INPUT_KEYS.maxLaunches] }
  }
  const target = a[INPUT_KEYS.target]
  if (!target || typeof target.root !== 'string' || !target.root.startsWith('/')) return { stop: early(STOP_KINDS.blocked, 'target.root は絶対パスでなければならない') }
  return { fn, resume: false, skillDir, key: a[INPUT_KEYS.key], target, limit: a[INPUT_KEYS.maxLaunches] }
}

const input = validateArgs(args)
if (input.stop) return input.stop

const fn = input.fn
const budget = makeBudget(input.limit)
const run = { state: input.state ?? null, run: null, workDir: null, launched: 0, ledger: false, viewpoints: [], targets: [], bundle: null, groups: [], applicability: null }
const CLI = `${input.skillDir}/scripts/bp-state.mjs`
// review・audit の段は回を持たない（反復が無い：SP-BPINSPECTION-002）。
const JUDGED = [{ stage: STAGE.verify, round: null }, { stage: STAGE.verifyExtra, round: null }]
let open = null
const memo = { target: input.target ?? null }

function track(stage, round, status, { append = false } = {}) {
  // 列挙の時点で済んでいた項目（前の run の打ち切りを含む）は、この run の全件の打ち切りに数えない（数えると、原因を直した再開が同じ BLOCKED を返し続ける）。
  const items = status.map((s) => ({ id: s.id, done: s.result, aborted: s.aborted, discarded: s.discarded, prior: s.result || s.aborted || s.discarded }))
  if (append && open && open.stage === stage && open.round === round) {
    for (const it of items) if (!open.items.some((x) => x.id === it.id)) open.items.push(it)
    open.finished = false
  } else {
    open = { stage, round, items, finished: false }
  }
}

function markItem(id, field) {
  const it = open?.items.find((x) => x.id === id)
  if (it) it[field] = true
}

function request(op, body) {
  const b = JSON.parse(JSON.stringify(body))
  return { op, body: { ...b, sum: fnvSum(b) } }
}

function write(op, body) {
  return request(op, { state: run.state, run: run.run, ...body })
}

function read(op, body = {}) {
  return request(op, { state: run.state, ...body })
}

// JSON.stringify の出力は改行を含まない 1 行なので、heredoc の区切りの行（BP_<sum>）が本文の中に現れることは無い。
function command(req) {
  const text = JSON.stringify(req.body)
  const delim = `BP_${req.body.sum}`
  return `node '${CLI}' ${req.op} <<'${delim}'\n${text}\n${delim}`
}

// host が投げた失敗は呼び出しごとに返し、BLOCKED の理由に載せる（SP-BPRUN-027。null を返すだけだと理由に失敗の内容が無い）。
async function launch(role, prompt, { unit, label, schema }) {
  budget.charge(unit)
  run.launched += 1
  try {
    return { out: await agent(prompt, { ...ROLE_MODELS[role], label, schema }), failure: '' }
  } catch (error) {
    return { out: null, failure: `（host の失敗: ${String(error?.message ?? error)}）` }
  }
}

function carrierPrompt(requests) {
  return [
    'あなたは best-practices の運搬役。状態を書けるのは CLI だけで、何を書くかは script が決めている（SP-BPRUN-006）。',
    '下のコマンドを上から順に、そのまま Bash で 1 つずつ実行する。コマンドを書き換えない・要求の JSON を写し直さない（写し間違いは CLI が sum で拒否する）。',
    '各コマンドの stdout は 1 行の JSON。応答の "ok" が false になったら、そこで止めて残りを実行しない。',
    '返すもの: 実行した順の stdout の各行を、1 字も変えずに文字列として並べた {"responses": [...]}。要約・整形をしない。',
    'ファイルに書いてよいのは CLI を通した状態だけ。ほかのファイルを読み書きしない。',
    '',
    ...requests.map((r) => command(r)),
  ].join('\n')
}

async function carry(requests, { unit, label = 'carrier' } = {}) {
  const { out: res, failure } = await launch('carrier', carrierPrompt(requests), { unit, label, schema: CARRIER_SCHEMA })
  if (!res || !Array.isArray(res.responses)) return { failed: true, lost: true, reason: `運搬役が結果を返さなかった${failure}`, responses: [] }
  if (res.responses.length > requests.length) return { failed: true, lost: true, reason: '運搬役が要求より多い応答を返した', responses: [] }
  const parsed = []
  for (const [i, line] of res.responses.entries()) {
    let r
    try {
      r = JSON.parse(line)
    } catch {
      return { failed: true, lost: true, reason: `運搬役の応答 ${i + 1} が JSON ではない`, responses: parsed }
    }
    if (!r || typeof r !== 'object' || typeof r.sum !== 'string') return { failed: true, lost: true, reason: `運搬役の応答 ${i + 1} に sum が無い`, responses: parsed }
    const { sum, ...rest } = r
    if (fnvSum(rest) !== sum) return { failed: true, lost: true, reason: `運搬役の応答 ${i + 1} の sum が合わない`, responses: parsed }
    if (r.ok === true && r.op !== requests[i].op) return { failed: true, lost: true, reason: `運搬役の応答 ${i + 1} の操作が要求と違う`, responses: parsed }
    parsed.push(r)
  }
  const last = parsed.at(-1)
  if (parsed.length < requests.length && last?.ok !== false) return { failed: true, lost: true, reason: '運搬役が全ての要求を実行しなかった', responses: parsed }
  if (last?.ok === false) {
    const transport = last.code === CODES.transport || last.code === CODES.lock
    return { failed: transport, rejected: !transport, code: last.code, reason: `${requests[parsed.length - 1].op}: ${last.code} ${last.reason}`, response: last, responses: parsed }
  }
  return { ok: true, responses: parsed }
}

// 応答を失った運搬役は CLI が書いたかが分からないので、同じ要求を 1 回だけ送り直す（書き込みは冪等の鍵で同じ要求を same で受ける）。
// following はこの後に必ず起動する運搬役の数。それを残して上限を超えないときだけ送り直す（送り直しが後の停止の運搬役の予約分を食うと、上限を超える）。
async function carryTwice(requests, following = 0) {
  const first = await carry(requests)
  return first.lost && (budget.limit === undefined || budget.used() + following < budget.limit) ? carry(requests) : first
}
// fan-out の外の書き込みは試行を繰り返す項目を持たないので、失敗も拒否も BLOCKED にする（SP-BPRUN-027・029）。
async function mustCarry(stage, requests) {
  if (!budget.fits(WORST.carrier)) throw new Stop(STOP_KINDS.iterationLimit, launchReason(), { limitHit: LIMIT_HITS.launch })
  const r = await carry(requests)
  if (!r.ok) throw new Stop(STOP_KINDS.blocked, `段「${STAGE_TITLES[stage] ?? stage}」の運搬役（CLI）が失敗した: ${r.reason}`, { carrierFailed: r.failed })
  return r.responses
}

function launchReason() {
  return `起動数の上限 ${budget.limit} で止まった（その時点の起動数 ${budget.used()}。残した項目は停止の記録の未着手の項目）`
}

// 同時に走る agent を CONCURRENCY 体に抑える（SP-BPCONFORMANCE-027。best-practices 自身は host の設定に頼らず script が守る）。
// 1 件が失敗しても走っている項目の終わりを待つ。待たずに返すと、走っている agent の呼び出しが run の終わりに残る。
async function pool(items, worker) {
  const queue = [...items]
  let failure = null
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length && !failure) {
      const item = queue.shift()
      try {
        await worker(item)
      } catch (error) {
        failure = failure ?? error
      }
    }
  })
  await Promise.all(workers)
  if (failure) throw failure
}

// 1 回の試行の起動は、agent・結果を書く運搬役とその送り直し・試行の失敗を書く運搬役とその送り直しの 5 つまで（WORST.item の根拠）。
async function itemLoop(item, attempts, attemptFn, label) {
  let current = attempts
  const unit = budget.open(WORST.item)
  try {
    while (true) {
      const outcome = await attemptFn(current + 1, unit)
      if (outcome.done) { markItem(item, 'done'); return outcome }
      if (outcome.fatal) throw outcome.fatal
      const fail = [...(outcome.alsoWrite ? [outcome.alsoWrite] : []), write(OPS.itemFail, { item, attempt: current + 1, reason: outcome.reason, ...(outcome.ambiguous ? { ifNoResult: true } : {}) })]
      let r = await carry(fail, { unit, label: `carrier:${label}` })
      if (r.lost) r = await carry(fail, { unit, label: `carrier:${label}` })
      if (!r.ok) throw new Stop(STOP_KINDS.blocked, `段の項目 ${item} の試行の失敗を書く運搬役が失敗した: ${r.reason}`)
      current += 1
      if (r.responses.at(-1).resulted) { markItem(item, 'done'); return { done: true } }
      if (r.responses.at(-1).aborted) { markItem(item, 'aborted'); return { aborted: true } }
    }
  } finally {
    budget.close(unit)
  }
}

async function fanOut(stage, entries, worker) {
  let short = false
  await pool(entries, async (entry) => {
    if (short) return
    if (!budget.fits(WORST.item)) { short = true; return }
    await worker(entry)
  })
  if (short) throw new Stop(STOP_KINDS.iterationLimit, launchReason(), { limitHit: LIMIT_HITS.launch })
  const live = open.items.filter((x) => !x.prior)
  if (live.length && live.every((x) => x.aborted)) {
    throw new Stop(STOP_KINDS.blocked, `段「${STAGE_TITLES[stage]}」の全ての項目が試行の上限で打ち切りになった: ${live.map((x) => x.id).join(', ')}`, { cause: STOP_CAUSES.verifiers })
  }
}

async function stageStart(stage, round, keys, extra = {}) {
  const [res] = await mustCarry(stage, [write(OPS.stageStart, { stage, round, keys, ...extra })])
  track(stage, round, res.status, { append: extra.part !== undefined })
  return res.status
}

async function startRun() {
  phase(STAGE_TITLES.start)
  const body = input.resume
    ? { key: input.key, state: input.state, ...(input.answer !== undefined ? { answer: input.answer } : {}) }
    : { key: input.key, function: fn, target: input.target, limits: LIMITS }
  const first = await carry([request(OPS.start, body)])
  // 状態 ID は開始の応答でしか得られないので、応答を失ったら同じ key で 1 回だけ送り直す（同じ key の開始は同じ状態を返す）。
  const r = first.lost ? await carry([request(OPS.start, body)]) : first
  if (!r.ok) {
    const reason = `開始の操作が失敗した: ${r.reason}`
    return { early: { ...early(STOP_KINDS.blocked, reason, input.resume ? { [NEXT_ARGS_KEYS.function]: fn, [NEXT_ARGS_KEYS.state]: input.state } : null), [RESULT_KEYS.launches]: budget.used() } }
  }
  const res = r.responses[0]
  run.state = res.state
  run.run = res.run
  run.workDir = res.workDir
  return res
}

function targetPaths(viewpoints) {
  return [...new Set(run.targets.filter((t) => viewpoints.includes(t.viewpoint)).flatMap((t) => t.files.map((f) => f.path)))]
}

function targetOf(viewpoint) {
  return run.targets.find((t) => t.viewpoint === viewpoint)
}

function targetFile(viewpoint, name) {
  return targetOf(viewpoint).files.find((f) => f.name === name).path
}

// 照らす先を読めない run が台帳まで作らないよう、照らす先の決定は単独の運搬役で運ぶ（読めないことも受理なので、後ろに続けると止まらない）。
async function targetsStage() {
  phase(STAGE_TITLES.targets)
  const [, t] = await mustCarry(STAGE.targets, [write(OPS.stageStart, { stage: STAGE.targets, keys: [] }), write(OPS.targets, {})])
  if (t.blocked) throw new Stop(STOP_KINDS.blocked, `段「${STAGE_TITLES.targets}」で照らせない: ${t.blocked.reason}`)
  run.viewpoints = t.viewpoints
  run.targets = t.targets
}

async function bundleStage(startAssign) {
  phase(STAGE_TITLES.bundle)
  const out = await mustCarry(STAGE.bundle, [
    write(OPS.stageStart, { stage: STAGE.bundle, keys: [] }),
    ...(run.ledger ? [] : [write(OPS.ledgerCreate, {})]),
    write(OPS.bundle, {}),
    write(OPS.stageFinish, { stage: STAGE.bundle }),
    ...(startAssign ? [write(OPS.stageStart, { stage: STAGE.assign, keys: [] })] : []),
  ])
  run.ledger = true
  run.bundle = out.find((r) => r.op === OPS.bundle).path
}

function commonPart(role, reason) {
  return [
    `あなたは best-practices の${role}。${reason}`,
    `書いてよいのは作業ファイル（${run.workDir}）だけ。対象スキルにも状態にも書かない（review・audit は対象スキルを書き換えない。直し方は書き換えの内容を文で返す）。`,
    `照らす先（判定基準。この run で読んだファイルだけを当て、記憶やほかの文書を判定基準にしない）: ${targetPaths(run.viewpoints).join(' ')}`,
    `資産の束（資産 ID・パス・範囲の見出しと、ファイルの中の行番号を付けた本文）: ${run.bundle}`,
    `対象スキル: ${memo.target.root}（根の外のファイル ${JSON.stringify(memo.target.files ?? [])}）`,
  ]
}

const VERIFIER_REASON = '対象スキルの今の内容を照らす先に照らして判定する（同じ対象を多数の検証役が読むので、共通の部分を先頭に揃えて資産の束から読む）。'

function extractorPrompt(failures) {
  return [
    ...commonPart('抽出役', '一緒に読まないと判断できない資産の組を、検証役 1 体が一緒に読む担当の単位として作る（担当の単位をファイルではなく判断の範囲にするため）。'),
    '資産 ID は資産の束の見出しの ID から選び、作らない（一覧に無い ID を含む組は CLI が拒否する）。組はファイルをまたいでよく、1 つの資産が 2 つ以上の組に入ってもよい。どの組にも入れなかった資産は、後の追加の起動で見られる。',
    '返すもの: {"groups": [[<資産 ID>, ...], ...]}。組の順が担当の順になる。',
    failures.length ? `前の回に拒否された理由:\n${failures.join('\n')}` : '',
  ].filter((l) => l !== '').join('\n')
}

function applicabilityPrompt(failures) {
  const conformance = targetFile('flow', TARGET_FILES.conformance)
  return [
    ...commonPart('検証役（適用の判定）', 'フローの観点の検証役が全て同じ答えを判定表の条件として使うよう、対象スキルのフローに形の判定の問いを 1 回だけ答える（担当ごとに答えが割れると、当たる要求が担当ごとに変わる）。'),
    `問い ${APPLICABILITY_QUESTIONS.join('・')} の中身は ${conformance} の用語定義に従い、SP-BPCONFORMANCE-004 の順に答え、答えた問いを飛ばさない。Q3 は SP-BPCONFORMANCE-005 に従う（形の判定の図は同項が参照する ${targetFile('flow', TARGET_FILES.design)} の節）。`,
    `問いの答えは ${Object.values(APPLICABILITY_ANSWERS).join('・')} のどれか。形に到達した後の問いは ${APPLICABILITY_ANSWERS.unreached}。${PRESENCE_QUESTIONS.join('・')} は対象スキルが実際に資産台帳・fan-out を持つかを ${Object.values(PRESENCE).join('・')} で答える（SP-BPCONFORMANCE-003）。`,
    '答えごとに、その答えを示す箇所の引用を {"asset": <資産の束の資産 ID>, "line": <行番号>, "text": <その行の原文>} で 1 件以上添える。',
    `返すもの: {"answers": {${APPLICABILITY_QUESTIONS.map((q) => `"${q}": {"answer", "quotes"}`).join(', ')}}, ${PRESENCE_QUESTIONS.map((q) => `"${q}": {"answer", "quotes"}`).join(', ')}}`,
    failures.length ? `前の回に拒否された理由:\n${failures.join('\n')}` : '',
  ].filter((l) => l !== '').join('\n')
}

// 章・節の名前と当て方は照らす先の決定の出力と bp-inspection の写しから渡し、prompt に書き写さない（書き写すと写し元だけが変わったときに古いまま残る）。
function viewpointLines(viewpoint) {
  const t = targetOf(viewpoint)
  const inspection = targetFile(viewpoint === 'spec' ? 'flow' : viewpoint, TARGET_FILES.inspection)
  if (viewpoint === 'flow') {
    return [
      `観点: フローの観点。${targetFile('flow', TARGET_FILES.conformance)} の「${t.section}」の章と、そこが参照する ${targetFile('flow', TARGET_FILES.design)} の節に、${inspection} の SP-BPINSPECTION-007 のとおり当たる要求の判定の単位を照らす。`,
      '不適合の単位は、その単位の値を指摘の種類にした候補として、違反が現れている担当の資産に結び付けて返す。判定のために担当の外の資産を読んでよいが、判定を返すのは担当の資産だけ。',
      `判定の単位と強いられた未検査は、次の適用の判定の行に従う。形と資産台帳・fan-out の有無を答え直さない（SP-BPINSPECTION-006）。強いられた未検査の単位は候補にしない:\n${JSON.stringify(run.applicability)}`,
    ]
  }
  if (viewpoint === 'spec') {
    return [
      `観点: 仕様の観点。${targetFile('spec', TARGET_FILES.conformance)} の「${t.section}」で始まる章の仕様項目を 1 つずつ判定の単位にし、対象スキルの値と規則をその章に照らす（値は照らす先から読む。${inspection} の SP-BPINSPECTION-008）。`,
      '不適合の単位は、その仕様項目 ID を指摘の種類にした候補として返す。',
    ]
  }
  return [
    `観点: 監査の観点。${targetFile('audit', TARGET_FILES.promptAudit)} の「${t.section}」の節の番号付きの項目を、指摘の種類の識別子（下の閉集合）に当てる。`,
    `当て方は ${inspection} の SP-BPINSPECTION-011〜SP-BPINSPECTION-013 に従う（範囲は候補を絞るだけで担当の資産を減らさない。${targetFile('audit', TARGET_FILES.designedSkill)} の要求と食い違うときはその要求を優先し、優先と評価できない鮮度は未検査の観点の候補として返す。同項が固定した除外は CLI が毎回未検査の観点に載せるので返さない）。`,
  ]
}

function verifierPrompt({ viewpoint, assignment, assets, itemId, attempt, extra }) {
  const payloadFile = `${itemId}.a${attempt}.json`
  const kindsCmd = command(read(OPS.kinds, { viewpoint }))
  const lines = [
    ...commonPart('検証役', VERIFIER_REASON),
    `担当の資産ごとに judgement を ${Object.values(JUDGEMENTS).join('・')} のどれか 1 つ返す。${JUDGEMENTS.candidate} の資産には候補（asset・viewpoint・kind・quote（行番号つきの原文）・content・fix）を 1 件以上添える。`,
    `照らさずに終えた範囲は unchecked に {viewpoint, scope, value, reason} で必ず返す（無ければ空の並び）。scope は ${UNCHECKED_SCOPES.whole}（value は観点）・${UNCHECKED_SCOPES.unit}（value は判定の単位）・${UNCHECKED_SCOPES.pa}（value は監査の観点の識別子）のどれか。未検査にした範囲を「問題なし」として返さない。`,
    '',
    ...viewpointLines(viewpoint),
    `指摘の種類は次の閉集合から選ぶ:\n${kindsCmd}`,
  ]
  if (extra) lines.push('この起動は skip 一覧への追加の起動（担当は skip 一覧の資産だけ）。')
  lines.push(
    PAYLOAD_MODE === 'file' ? `返り値と同じ JSON を {"result": <返り値>} の形で ${run.workDir}/${payloadFile} にも書く（CLI が両者の一致を照らす）。` : '',
    `観点の値: ${viewpoint}`,
    `担当 ID: ${assignment}`,
    `担当の資産 ID: ${assets.join(', ')}`,
  )
  return { prompt: lines.filter((l) => l !== '').join('\n'), payloadFile }
}

// 応答を失った運搬役は CLI が書いたかが分からないので、同じ要求を 1 回だけ送り直す（全ての書き込みは同じ要求を same で受ける）。
// CLI が応答した E_TRANSPORT・E_LOCK は状態を変えていないので、試行の失敗として数える（SP-BPRUN-028）。
async function writeResult(stage, req, unit) {
  const label = `carrier:${stage}`
  const first = await carry([req], { unit, label })
  const r = first.lost ? await carry([req], { unit, label }) : first
  if (r.ok) return { done: true }
  if (r.code === CODES.result) return { reason: r.reason }
  if (r.failed && !r.lost) return { reason: r.reason, ambiguous: first.lost }
  if (r.lost) return { fatal: new Stop(STOP_KINDS.blocked, `段「${STAGE_TITLES[stage]}」の結果を書く運搬役が送り直しでも応答を返さなかった: ${first.reason} / ${r.reason}`) }
  return { fatal: new Stop(STOP_KINDS.blocked, `段「${STAGE_TITLES[stage]}」の CLI が結果の書き込みを拒否した: ${r.reason}`) }
}

async function verifyItem({ itemId, viewpoint, attempts, assignment, assets, extra, stage }) {
  return itemLoop(itemId, attempts, async (attempt, unit) => {
    const { prompt, payloadFile } = verifierPrompt({ viewpoint, assignment, assets, itemId, attempt, extra })
    const { out: res, failure } = await launch('verifier', prompt, { unit, label: `verifier:${viewpoint}${extra ? ':extra' : ''}`, schema: verifySchema() })
    if (!res) return { reason: `検証役が結果を返さなかった${failure}` }
    const body = PAYLOAD_MODE === 'file'
      ? { item: itemId, assignment, viewpoint, payloadFile, payloadSum: fnvSum({ result: res }) }
      : { item: itemId, assignment, viewpoint, result: res }
    return writeResult(stage, write(OPS.verdicts, body), unit)
  }, stage)
}

// 鍵は状態にある担当 ID で持つ（SP-BPRUN-038。CLI が担当の実在を照らす）。担当 ID は担当の組を書いた応答でしか分からないので、audit は観点ごとの検証の段の開始を別の運搬役で書く。
function verifyKeys() {
  return run.viewpoints.flatMap((viewpoint) => run.groups.map((g) => ({ viewpoint, assignment: g.id })))
}

function verifyStartRequest() {
  return write(OPS.stageStart, { stage: STAGE.verify, keys: verifyKeys() })
}

// 拒否の理由を次の起動の prompt に足すのは、同じ誤りの結果を試行の上限まで繰り返させないため（SP-BPFINDINGS-034）。1 回の起動の数は WORST.attempt。
async function retried(stage, repeats, attemptFn) {
  let n = repeats
  const failures = []
  while (true) {
    if (!budget.fits(WORST.attempt)) throw new Stop(STOP_KINDS.iterationLimit, launchReason(), { limitHit: LIMIT_HITS.launch })
    const unit = budget.open(WORST.attempt)
    try {
      n += 1
      const r = await attemptFn(n, failures, unit)
      if (r.ok) return r.responses
      if (!r.rejected || r.code !== CODES.result) throw new Stop(STOP_KINDS.blocked, `段「${STAGE_TITLES[stage]}」の運搬役（CLI）が失敗した: ${r.reason}`, { carrierFailed: r.failed })
      failures.push(r.reason)
      if (r.responses[0]?.hit) throw new Stop(STOP_KINDS.blocked, `段「${STAGE_TITLES[stage]}」の結果が試行の上限 ${r.responses[0].limit} 回まで拒否された: ${failures.join(' / ')}`)
    } finally {
      budget.close(unit)
    }
  }
}

async function assignStage(insp, started) {
  phase(STAGE_TITLES.assign)
  const next = fn === FUNCTION.review ? write(OPS.stageStart, { stage: STAGE.applicability, keys: [] }) : null
  const start = started ? [] : [write(OPS.stageStart, { stage: STAGE.assign, keys: [] })]
  if (insp.assignments.length) {
    // 結果を書いた運搬役が段の終わりの前に応答を失った run の再開。作り直すと別の担当 ID の組が増える（SP-BPINSPECTION-030）。
    run.groups = insp.assignments
    await mustCarry(STAGE.assign, [...start, write(OPS.stageFinish, { stage: STAGE.assign }), ...(next ? [next] : [])])
    return null
  }
  if (start.length) await mustCarry(STAGE.assign, start)
  const out = await retried(STAGE.assign, insp.repeats[STAGE.assign], async (n, failures, unit) => {
    const { out: res, failure } = await launch('extractor', extractorPrompt(failures), { unit, label: 'extractor', schema: EXTRACT_SCHEMA })
    if (!res) throw new Stop(STOP_KINDS.blocked, `段「${STAGE_TITLES.assign}」の抽出役が結果を返さなかった${failure}`)
    return carry([
      write(OPS.stageRepeat, { stage: STAGE.assign, n, limitKey: LIMIT_KEYS.attempts }),
      write(OPS.assignments, { stage: STAGE.assign, groups: res.groups, attempt: n }),
      write(OPS.stageFinish, { stage: STAGE.assign }),
      ...(next ? [next] : []),
    ], { unit })
  })
  run.groups = out[1].assignments.map((a) => ({ id: a.id, assets: a.assets }))
  return null
}

async function applicabilityStage(insp, started) {
  phase(STAGE_TITLES.applicability)
  // 担当の作成の段を終えた後、次の段の開始を書く前に止まった run の再開では、段の開始の記録が無い（無いまま結果を書くと CLI が E_UNKNOWN_ID で拒否し続ける）。
  if (!started && !insp.applicability) await mustCarry(STAGE.applicability, [write(OPS.stageStart, { stage: STAGE.applicability, keys: [] })])
  if (insp.applicability) {
    // 結果は段の終わりと同じ 1 行で書かれているので、起動し直さずに次の段を始める（起動し直すと最初の結果と食い違い E_CONFLICT になる）。
    run.applicability = insp.applicability
    const [res] = await mustCarry(STAGE.applicability, [verifyStartRequest()])
    return res.status
  }
  const out = await retried(STAGE.applicability, insp.repeats[STAGE.applicability], async (n, failures, unit) => {
    const { out: res, failure } = await launch('verifier', applicabilityPrompt(failures), { unit, label: 'verifier:applicability', schema: applicabilitySchema() })
    if (!res) throw new Stop(STOP_KINDS.blocked, `段「${STAGE_TITLES.applicability}」の検証役が結果を返さなかった${failure}`)
    return carry([
      write(OPS.stageRepeat, { stage: STAGE.applicability, n, limitKey: LIMIT_KEYS.attempts }),
      write(OPS.applicability, { n, result: res }),
      verifyStartRequest(),
    ], { unit })
  })
  const { shape, row, units, forced } = out[1]
  run.applicability = { shape, row, units, forced }
  return out[2].status
}

async function verifyStage(status) {
  phase(STAGE_TITLES.verify)
  const keys = verifyKeys()
  const st = status ?? (await mustCarry(STAGE.verify, [verifyStartRequest()]))[0].status
  track(STAGE.verify, null, st)
  const entries = st.map((s, i) => ({ s, key: keys[i] })).filter(({ s }) => !s.result && !s.aborted && !s.discarded)
    .map(({ s, key }) => ({ itemId: s.id, viewpoint: key.viewpoint, attempts: s.attempts, assignment: key.assignment, assets: run.groups.find((g) => g.id === key.assignment).assets }))
  await fanOut(STAGE.verify, entries, (e) => verifyItem({ ...e, stage: STAGE.verify }))
}

async function extraPart(n, viewpoints) {
  const reqs = viewpoints.map((v) => write(OPS.assignments, { stage: STAGE.verifyExtra, rule: ASSIGN_RULES.skip, viewpoint: v }))
  reqs.push(write(OPS.stageStart, { stage: STAGE.verifyExtra, part: n, keys: viewpoints.map((v) => ({ viewpoint: v, pass: n })) }))
  const out = await mustCarry(STAGE.verifyExtra, reqs)
  const started = out.at(-1)
  track(STAGE.verifyExtra, null, started.status, { append: true })
  const entries = started.status.map((s, i) => ({ s, asg: out[i].assignments[0], viewpoint: viewpoints[i] }))
    .filter(({ s, asg }) => asg && !s.result && !s.aborted && !s.discarded)
    .map(({ s, asg, viewpoint }) => ({ itemId: s.id, viewpoint, attempts: s.attempts, assignment: asg.id, assets: asg.assets }))
  await fanOut(STAGE.verifyExtra, entries, (e) => verifyItem({ ...e, extra: true, stage: STAGE.verifyExtra }))
}

async function skipNow() {
  const [rep] = await mustCarry(STAGE.verifyExtra, [read(OPS.report, { viewpoints: run.viewpoints, fields: ['skip'] })])
  return rep.skip
}

// skip 一覧への追加の起動は観点ごとの検証の段の中の部品なので phase を分けず、段の slug verify-extra で記録する（SP-BPINSPECTION-001・SP-BPRUN-038）。
// 再開では止まった部分の未着手を先に処理する（create・update の破棄を写さない：SP-BPINSPECTION-030）。
async function verifyExtraStage(initialSkip, resumed) {
  let part = 0
  let skip = initialSkip
  if (resumed) {
    part = resumed.parts
    await extraPart(part, resumed.items.filter((x) => x.key.pass === part).map((x) => x.key.viewpoint))
    skip = await skipNow()
  }
  let active = run.viewpoints.filter((v) => (skip.find((s) => s.viewpoint === v)?.assets.length ?? 0) > 0)
  while (active.length) {
    const before = new Map(skip.map((s) => [s.viewpoint, s.assets.length]))
    part += 1
    await extraPart(part, active)
    skip = await skipNow()
    const after = new Map(skip.map((s) => [s.viewpoint, s.assets.length]))
    active = active.filter((v) => (after.get(v) ?? 0) > 0 && (after.get(v) ?? 0) < (before.get(v) ?? 0))
  }
  return part > 0
}

async function closeVerify(finishVerify, resumed) {
  const out = await mustCarry(STAGE.verify, [
    ...(finishVerify ? [write(OPS.stageFinish, { stage: STAGE.verify })] : []),
    read(OPS.report, { viewpoints: run.viewpoints, fields: ['skip'] }),
    read(OPS.refutationItems, { stages: JUDGED }),
  ])
  const [rep, items] = out.slice(-2)
  if (!(await verifyExtraStage(rep.skip, resumed))) return items.keys
  const [, again] = await mustCarry(STAGE.verifyExtra, [
    write(OPS.stageFinish, { stage: STAGE.verifyExtra }),
    read(OPS.refutationItems, { stages: JUDGED }),
  ])
  return again.keys
}

function refuterPrompt(key, readCmd) {
  return [
    ...commonPart('反証役', '候補を出した検証役と別の context で、指摘の候補が照らす先に照らして本当に成り立つかを確かめる（生成した本人には自分の誤りが見えない）。'),
    `候補の観点の照らす先: ${targetPaths([key.viewpoint]).join(' ')}`,
    `候補の引用・内容・直し方は次の読み出しで、指摘の鍵が下と同じものを読む（同じ鍵の候補は全て）:\n${readCmd}`,
    `鍵ごとに 1 つの判定として ${JSON.stringify(REFUTATION_VERDICTS.uphold)}（維持）か ${JSON.stringify(REFUTATION_VERDICTS.reject)}（却下）を選び、理由を添えて {"verdict", "reason"} で返す。`,
    '',
    `指摘の鍵: ${JSON.stringify(key)}`,
  ].join('\n')
}

async function refuteStage(keys) {
  if (!keys.length) return false
  phase(STAGE_TITLES.refute)
  const status = await stageStart(STAGE.refute, null, keys)
  const readCmd = command(read(OPS.refutationItems, { stages: JUDGED, texts: true }))
  const entries = status.map((s, i) => ({ ...s, key: keys[i] })).filter((s) => !s.result && !s.aborted && !s.discarded)
  await fanOut(STAGE.refute, entries, (e) => itemLoop(e.id, e.attempts, async (attempt, unit) => {
    const { out: res, failure } = await launch('refuter', refuterPrompt(e.key, readCmd), { unit, label: 'refuter', schema: REFUTE_SCHEMA })
    if (!res) {
      // 未反証の記録と試行の失敗は、どちらも本文が起動の前に決まるので 1 回の運搬役で書く（SP-BPFINDINGS-015・SP-BPRUN-028）。
      return { reason: `反証役が結果を返さなかった${failure}`, alsoWrite: write(OPS.refutation, { item: e.id, verdict: null, attempt }) }
    }
    return writeResult(STAGE.refute, write(OPS.refutation, { item: e.id, verdict: res.verdict, reason: res.reason }), unit)
  }, STAGE.refute))
  return true
}

async function vanishStage(retake) {
  if (!retake || !retake.affected.length) return
  phase(STAGE_TITLES.vanish)
  const keys = retake.affected.map((f) => ({ finding: f, gone: retake.round }))
  // 指摘の観点の照らす先を渡すため、段の開始と同じ運搬役で指摘の一覧を読む（起動数を増やさない）。
  const [started, listed] = await mustCarry(STAGE.vanish, [
    write(OPS.stageStart, { stage: STAGE.vanish, round: retake.round, keys }),
    read(OPS.report, { viewpoints: run.viewpoints, fields: ['findings'] }),
  ])
  track(STAGE.vanish, retake.round, started.status)
  const viewpointOf = new Map(listed.findings.map((f) => [f.id, f.viewpoint]))
  const listCmd = command(read(OPS.report, { viewpoints: run.viewpoints, fields: ['findings'] }))
  const entries = started.status.map((s, i) => ({ ...s, key: keys[i] })).filter((s) => !s.result && !s.aborted && !s.discarded)
  await fanOut(STAGE.vanish, entries, (e) => itemLoop(e.id, e.attempts, async (attempt, unit) => {
    const prompt = [
      ...commonPart('検証役（消えた資産の照合）', '指摘のあった資産が消えたので、今の資産の中に同じ内容を持つ資産があるかを閉集合から選ぶ。'),
      `今の資産 ID の一覧は資産の束（書き直した束）の見出しから選ぶ。指摘の観点・引用・内容は次の読み出しで得る:\n${listCmd}`,
      `返すもの: {"choice": <今の資産 ID か ${JSON.stringify(VANISH_NONE)}>}`,
      '',
      `指摘の観点: ${viewpointOf.get(e.key.finding)}（照らす先: ${targetPaths([viewpointOf.get(e.key.finding)]).join(' ')}）`,
      `指摘 ID: ${e.key.finding}`,
    ].join('\n')
    // 結果の無い照合を試行の失敗にせず「判定できない」として書くのは、消えた資産の指摘を未判定のまま止めないため（SP-BPFINDINGS-037）。
    const { out: res } = await launch('verifier', prompt, { unit, label: 'verifier:vanish', schema: VANISH_SCHEMA })
    return writeResult(STAGE.vanish, write(OPS.vanishMatch, { item: e.id, choice: res ? res.choice : null }), unit)
  }, STAGE.vanish))
  await mustCarry(STAGE.vanish, [write(OPS.stageFinish, { stage: STAGE.vanish, round: retake.round })])
}

// 表は bp-inspection.md の SP-BPINSPECTION-030 が正本。止まった段を停止の記録でなく段の並びで決めるのは、消えた資産の照合の段で止まった run でも続ける段が分かるようにするため。
function resumePlan(p) {
  const order = INSPECT_PIPELINE.filter((s) => s !== STAGE.applicability || fn === FUNCTION.review)
  const r = p.inspection.reached
  const at = r ? order.indexOf(r.stage) + (r.finished ? 1 : 0) : 0
  const from = order[Math.max(at, order.indexOf(STAGE.assign))]
  const stopped = p.stopped
  return {
    from,
    reached: r?.stage ?? null,
    vanish: stopped.stage === STAGE.vanish ? { round: stopped.round, affected: stopped.items.map((x) => x.key.finding) } : null,
    extra: from === STAGE.verifyExtra && r?.stage === STAGE.verifyExtra ? { parts: r.parts, items: r.items } : null,
  }
}

// 段を CLI から読むのは、段の規則を CLI の 1 箇所に置くため（SP-BPRUN-018）。読めないときに推測で埋めると、再開した run で CLI の段と食い違う（SP-BPRUN-027）。
async function unwrittenStop(stop, carrier, r, roleLimits) {
  let draft = null
  if (budget.limit === undefined || budget.used() < budget.limit) {
    const d = await carry([read(OPS.stopDraft)])
    if (d.ok) draft = d.responses[0]
  }
  const stage = draft === null ? '段は読めなかった。' : draft.stage === null ? '段の記録は無い。' : `段「${draft.stage}」の`
  return {
    ...early(STOP_KINDS.blocked, `停止の記録を書けなかった（${stage}${carrier}の運搬役。止めようとした停止: ${stop.kind}${stop.reason ? `: ${stop.reason}` : ''}）: ${r.reason}`, { [NEXT_ARGS_KEYS.function]: fn, [NEXT_ARGS_KEYS.state]: run.state }),
    [RESULT_KEYS.run]: run.run,
    ...(draft?.writtenFiles.length ? { [RESULT_KEYS.writtenFiles]: draft.writtenFiles } : {}),
    [RESULT_KEYS.launches]: budget.used(),
    [RESULT_KEYS.unverifiedRoleLimits]: roleLimits,
  }
}

async function finish(stop, before = []) {
  const kind = stop.kind
  // 停止の前の書き込みは停止と別の運搬役で先に書き、応答を確かめてから停止を送る。停止を書いた後の run への書き込みは CLI が拒否するので、
  // 同じ運搬役に積むと、停止の後に応答を失ったときに送り直せない（SP-BPRUN-027）。
  if (before.length) {
    const pre = await carryTwice(before, 1)
    if (!pre.ok) return unwrittenStop(stop, '停止の前の書き込み', pre, INSPECT_ROLE_WRITE_LIMITS)
  }
  const body = {
    kind,
    ...(kind === STOP_KINDS.complete ? {} : { reason: stop.reason }),
    ...(stop.extra.limitHit ? { limitHit: stop.extra.limitHit } : {}),
    ...(stop.extra.cause ? { cause: stop.extra.cause } : {}),
    launches: budget.used() + 1,
    // どの停止でも対象スキルの指紋を照らさせる（SP-BPRUN-026 は停止の種類を限らない）。変わっていれば CLI が BLOCKED を書く。
    onTargetChanged: STOP_KINDS.blocked,
  }
  // 停止は受け取った要求の sha256 で同じ停止として受け、返り値は読むだけなので、応答を失っても同じ 2 つの要求を送り直せる。送り直しは停止の記録の起動数に入らない（SP-BPRUN-034）。
  const r = await carryTwice([write(OPS.stop, body), read(OPS.outcome)])
  if (!r.ok) return unwrittenStop(stop, '停止', r, INSPECT_ROLE_WRITE_LIMITS)
  return r.responses.at(-1)
}

async function main() {
  const s = await startRun()
  if (s.early) return s.early
  const p = s.progress
  const insp = p.inspection
  memo.target = p.target
  run.ledger = p.ledger
  const plan = input.resume ? resumePlan(p) : { from: STAGE.assign, reached: null, vanish: null, extra: null }
  const order = INSPECT_PIPELINE
  const before = (stage) => order.indexOf(plan.from) <= order.indexOf(stage)
  const retake = s.retake?.affected?.length ? { round: s.retake.retake, affected: s.retake.affected } : null
  const vanishing = Boolean(plan.vanish || retake)
  await targetsStage()
  await bundleStage(before(STAGE.assign) && !vanishing)
  await vanishStage(plan.vanish)
  await vanishStage(retake)
  run.groups = insp.assignments
  run.applicability = insp.applicability
  let status = null
  const assigned = before(STAGE.assign)
  if (assigned) status = await assignStage(insp, !vanishing)
  if (fn === FUNCTION.review && before(STAGE.applicability)) status = await applicabilityStage(insp, assigned || plan.reached === STAGE.applicability)
  if (before(STAGE.verify)) await verifyStage(status)
  let keys
  if (before(STAGE.verifyExtra)) keys = await closeVerify(before(STAGE.verify), plan.extra)
  else if (before(STAGE.refute)) keys = (await mustCarry(STAGE.refute, [read(OPS.refutationItems, { stages: JUDGED })]))[0].keys
  const refuted = before(STAGE.refute) ? await refuteStage(keys) : true
  phase(STAGE_TITLES.close)
  const close = [
    ...(before(STAGE.refute) && !refuted ? [write(OPS.stageStart, { stage: STAGE.refute, keys: [] })] : []),
    ...(before(STAGE.refute) ? [write(OPS.stageFinish, { stage: STAGE.refute })] : []),
    write(OPS.stageStart, { stage: STAGE.close, keys: [] }),
  ]
  return finish(new Stop(STOP_KINDS.complete, ''), close)
}

try {
  return await main()
} catch (error) {
  if (!(error instanceof Stop)) {
    const stop = new Stop(STOP_KINDS.blocked, `script の内部の失敗: ${error?.message ?? String(error)}`)
    return run.run ? finish(stop) : early(STOP_KINDS.blocked, stop.reason)
  }
  if (!run.run) return { ...early(error.kind, error.reason), [RESULT_KEYS.launches]: budget.used() }
  return finish(error)
}
