export const meta = {
  name: 'best-practices-author',
  description: 'best-practices の create・update を 1 run として進め、状態を CLI に書かせて停止の種類と返り値を返す',
  phases: [
    { title: '開始' },
    { title: '作り直す前の写し' },
    { title: '目標の固定' },
    { title: '書く' },
    { title: '台帳' },
    { title: '検証' },
    { title: '追加の検証' },
    { title: '反証' },
    { title: '消えた資産の照合' },
    { title: '見直し' },
    { title: '合否' },
  ],
}

// 以下の定数は CLI の scripts/bp/constants.mjs と仕様の表の写し。script は import できないので写しを持ち、
// 一致は tests/bp-spelling.test.mjs が照らす（写しを 1 字でも変えるとテストが落ちる）。本文が閉集合の値をリテラルで書き直すと照合の外に出るので、
// 本文は定数から引く（同じテストが本文のリテラルと prompt の引用を照らす）。
const OPS = {
  start: 'start', premise: 'premise', stageStart: 'stage-start', itemResult: 'item-result', itemFail: 'item-fail',
  stageRepeat: 'stage-repeat', stageFinish: 'stage-finish', discard: 'discard', files: 'files', stop: 'stop',
  summary: 'summary', list: 'list', ledgerCreate: 'ledger-create', ledgerRetake: 'ledger-retake', assignments: 'assignments',
  verdicts: 'verdicts', refutationItems: 'refutation-items', refutation: 'refutation', reviewJudge: 'review-judge',
  vanishMatch: 'vanish-match', report: 'report', kinds: 'kinds', key: 'key', paths: 'paths', pathsRetake: 'paths-retake',
  snapshot: 'snapshot', goalCheck: 'goal-check', filesScan: 'files-scan', units: 'units', gate: 'gate', outcome: 'outcome',
  targets: 'targets', bundle: 'bundle', applicability: 'applicability', writtenFiles: 'written-files',
}
const STAGE = {
  start: 'start', snapshot: 'snapshot', goal: 'goal', write: 'write', ledger: 'ledger', targets: 'targets', bundle: 'bundle',
  assign: 'assign', applicability: 'applicability', verify: 'verify', verifyExtra: 'verify-extra', refute: 'refute',
  vanish: 'vanish', rejudge: 'rejudge', gate: 'gate', close: 'close',
}
const STAGE_TITLES = {
  start: '開始', snapshot: '作り直す前の写し', goal: '目標の固定', write: '書く', ledger: '台帳', verify: '検証',
  'verify-extra': '追加の検証', refute: '反証', vanish: '消えた資産の照合', rejudge: '見直し', gate: '合否',
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
const GOAL_KEYS = { deliverables: 'deliverables', scope: 'scope', prohibitions: 'prohibitions', numeric: 'numeric', deixis: 'deixis' }
const SOURCE_KINDS = { request: 'request', answer: 'answer', snapshot: 'snapshot', ground: 'ground' }
const GROUND_INSTRUCTION = { kindKey: 'kind', kind: '利用者の指示', textKey: 'text' }
const UNIT_RESULTS = { conform: 'conform', nonconform: 'nonconform', na: 'na', unchecked: 'unchecked' }
const UNCHECKED_KINDS = { forced: 'forced', unforced: 'unforced' }
const CONTRACT_ELEMENTS = ['発火する条件', '発火しない条件', '入力', '出力', '停止の種類']
const GATE_NEXT = { complete: 'complete', rewrite: 'rewrite', iterationLimit: 'iterationLimit', blocked: 'blocked' }
const LIMIT_HITS = { iteration: 'iteration', launch: 'launch' }
const FILE_ACTIONS = { write: 'write', delete: 'delete' }
const ASSIGN_RULES = { all: 'all', skip: 'skip' }
const STAGE_STATUS = { open: 'open', finished: 'finished', none: 'none', stopped: 'stopped' }
const CONTRACT_NONE = 'none'
const JUDGEMENTS = { candidate: 'candidate', ok: 'ok', unsure: 'unsure' }
const REFUTATION_VERDICTS = { uphold: 'uphold', reject: 'reject' }
const VANISH_NONE = 'none'
const STOP_CAUSES = { verifiers: 'verifiers' }
const ROLE_WRITE_LIMITS = [
  { role: '書き手', writes: '対象スキルと作業ファイル' },
  { role: '検証役・反証役・抽出役', writes: '作業ファイルだけ' },
  { role: '運搬役', writes: 'CLI を通した状態だけ' },
]
const CRITERIA_DIR = 'references/criteria'
const CRITERIA_FILES = {
  conformance: ['specifications', 'bp-conformance.md'],
  design: ['design', 'skill-design-patterns.md'],
  authoring: ['specifications', 'bp-authoring.md'],
  inspection: ['specifications', 'bp-inspection.md'],
  designedSkill: ['requirements', 'bp-designed-skill.md'],
}

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

// 起動数の勘定（SP-BPCONFORMANCE-022 の式。値の根拠は tests/bp-author-workflow.test.mjs の最悪の経路の計数）。
// RESERVE は停止の前の書き込みの運搬役 1 と停止の運搬役 1（SP-BPRUN-021 の予約分）。
const WORST = {
  start: 2,
  resumeDiscard: 1,
  carrier: 1,
  goalAttempt: 2,
  write: 3,
  item: LIMITS.attempts * 5,
}
const RESERVE = 2

function minimalLaunches(fn) {
  // その run で最初に始める fan-out の項目までの最悪を、全ての経路で最も大きいもので取る（再開も同じ値を使う）。最大は目標の固定より前で止まった run の再開。
  return WORST.start + WORST.resumeDiscard + (fn === FUNCTION.update ? WORST.carrier : 0) + WORST.carrier + LIMITS.untilPass * WORST.goalAttempt
    + WORST.carrier + WORST.write + WORST.item + RESERVE
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

function isTreatedGround(ground) {
  if (ground === null || typeof ground !== 'object' || Array.isArray(ground)) return false
  if (Object.hasOwn(ground, 'state')) return ground.state === 'open'
  return ground[GROUND_INSTRUCTION.kindKey] === GROUND_INSTRUCTION.kind && typeof ground[GROUND_INSTRUCTION.textKey] === 'string'
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

function sourceSchema() {
  return {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: Object.values(SOURCE_KINDS) },
      quote: { type: 'string' },
      path: { type: 'string' },
      ground: { type: 'string' },
    },
    required: ['kind'],
    additionalProperties: false,
  }
}

function goalSchema() {
  const entry = {
    type: 'object',
    properties: { text: { type: 'string' }, sources: { type: 'array', minItems: 1, items: sourceSchema() } },
    required: ['text', 'sources'],
    additionalProperties: false,
  }
  const goal = {
    type: 'object',
    properties: Object.fromEntries(Object.values(GOAL_KEYS).map((k) => [k, { type: 'array', items: entry }])),
    required: Object.values(GOAL_KEYS),
    additionalProperties: false,
  }
  const missing = {
    type: 'array',
    minItems: 1,
    items: { type: 'object', properties: { question: { type: 'string' }, reason: { type: 'string' } }, required: ['question', 'reason'], additionalProperties: false },
  }
  return { type: 'object', properties: { goal, missing }, minProperties: 1, maxProperties: 1, additionalProperties: false }
}

const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    written: {
      type: 'array',
      items: { type: 'object', properties: { path: { type: 'string' }, action: { type: 'string', enum: Object.values(FILE_ACTIONS) } }, required: ['path', 'action'], additionalProperties: false },
    },
    designNote: { type: 'object', properties: { path: { type: 'string' }, heading: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  required: ['written', 'designNote'],
  additionalProperties: false,
}

function keySchema() {
  return {
    type: 'object',
    properties: { asset: { type: 'string' }, viewpoint: { type: 'string' }, kind: { type: 'string' } },
    required: ['asset', 'viewpoint', 'kind'],
    additionalProperties: false,
  }
}

function verifySchema(viewpoint) {
  const properties = {
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
  }
  const required = ['judgements', 'candidates']
  if (viewpoint === 'conformance') {
    properties.applicability = { type: 'object', properties: { row: { type: 'integer' } }, required: ['row'], additionalProperties: false }
    properties.units = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          unit: { type: 'string' },
          result: { type: 'string', enum: Object.values(UNIT_RESULTS) },
          reason: { type: 'string' },
          keys: { type: 'array', items: keySchema() },
          unchecked: { type: 'string', enum: Object.values(UNCHECKED_KINDS) },
        },
        required: ['unit', 'result', 'reason'],
        additionalProperties: false,
      },
    }
    properties.residualRisks = {
      type: 'array',
      items: {
        type: 'object',
        properties: { role: { type: 'string' }, restriction: { type: 'string' }, host: { type: 'string' }, reason: { type: 'string' } },
        required: ['role', 'restriction', 'host', 'reason'],
        additionalProperties: false,
      },
    }
    required.push('applicability', 'units', 'residualRisks')
  }
  if (viewpoint === 'goal') {
    properties.basisConstraints = {
      type: 'array',
      items: { type: 'object', properties: { asset: { type: 'string' }, sp: { type: 'string' } }, required: ['asset', 'sp'], additionalProperties: false },
    }
    required.push('basisConstraints')
  }
  if (viewpoint === 'contract') {
    properties.contractChanges = {
      type: 'array',
      items: {
        type: 'object',
        properties: { element: { type: 'string', enum: CONTRACT_ELEMENTS }, change: { type: 'string' }, choice: { type: 'string' } },
        required: ['element', 'change', 'choice'],
        additionalProperties: false,
      },
    }
    required.push('contractChanges')
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

const REFUTE_SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: Object.values(REFUTATION_VERDICTS) }, reason: { type: 'string' } },
  required: ['verdict', 'reason'],
  additionalProperties: false,
}
const VANISH_SCHEMA = { type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'], additionalProperties: false }

// SP-BPRUN-037 を SP-BPAUTHORING-029 の「agent の起動の前」の行より先に当てる（同時に当たるときの順を仕様が定める）。

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
    : [INPUT_KEYS.answer].filter((k) => Object.hasOwn(a, k))
  if (forbidden.length) return { stop: early(STOP_KINDS.blocked, `${resume ? '再開' : '新しい状態での起動'}に渡してはならない項目がある: ${forbidden.join(', ')}（SP-BPENTRY-013）`, nextState) }
  if (resume && (!nextState || Object.keys(na).some((k) => !Object.values(NEXT_ARGS_KEYS).includes(k)))) {
    return { stop: early(STOP_KINDS.blocked, `nextArgs は ${Object.values(NEXT_ARGS_KEYS).join('・')} だけを持たなければならない: ${JSON.stringify(na)}`) }
  }
  if (fn !== FUNCTION.create && fn !== FUNCTION.update) return { stop: early(STOP_KINDS.blocked, `機能が create・update のどれでもない: ${JSON.stringify(fn)}`, nextState) }
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
  if (fn === FUNCTION.create) {
    const request = a[INPUT_KEYS.request]
    if (typeof request !== 'string' || request.trim() === '') return { stop: early(STOP_KINDS.needsInput, '依頼文が空。作るスキルの依頼文が要る（SP-BPAUTHORING-029）') }
    const parts = target.root.replace(/\/+$/, '').split('/')
    if (parts.at(-3) !== '.agents' || parts.at(-2) !== 'skills' || !parts.at(-1) || (target.files ?? []).length) {
      return { stop: early(STOP_KINDS.blocked, `create の対象スキルのパスの一覧は .agents/skills/<name>/ の 1 つだけでなければならない: ${JSON.stringify(target)}（SP-BPAUTHORING-001）`) }
    }
    return { fn, resume: false, skillDir, key: a[INPUT_KEYS.key], request, target, limit: a[INPUT_KEYS.maxLaunches] }
  }
  const grounds = a[INPUT_KEYS.grounds]
  if (!Array.isArray(grounds)) return { stop: early(STOP_KINDS.blocked, 'update の grounds は並びでなければならない') }
  const treated = grounds.filter(isTreatedGround).length
  if (treated === 0) {
    return { stop: early(STOP_KINDS.needsInput, `修正の根拠として扱う根拠が 0 件（受け取った ${grounds.length} 件、扱わなかった ${grounds.length} 件）。open の指摘か利用者の指示を 1 件以上渡す（SP-BPAUTHORING-029）`) }
  }
  return { fn, resume: false, skillDir, key: a[INPUT_KEYS.key], target, grounds, limit: a[INPUT_KEYS.maxLaunches] }
}

const input = validateArgs(args)
if (input.stop) return input.stop

const fn = input.fn
const budget = makeBudget(input.limit)
const run = { state: input.state ?? null, run: null, workDir: null, launched: 0 }
const VIEWPOINT_LIST = RUN_VIEWPOINTS[fn]
const CLI = `${input.skillDir}/scripts/bp-state.mjs`
const CRITERIA = Object.fromEntries(Object.entries(CRITERIA_FILES).map(([k, parts]) => [k, [input.skillDir, CRITERIA_DIR, ...parts].join('/')]))
let open = null
const failures = new Map()
const viewpointByItem = new Map()
const memo = { written: [], outside: [], target: input.target ?? null, goalText: null, request: input.request ?? null, answers: [], grounds: [] }

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

// host が投げた失敗はラベルごとに残し、BLOCKED の理由に載せる（SP-BPRUN-027。null を返すだけだと理由に失敗の内容が無い）。
async function launch(role, prompt, { unit, label, schema }) {
  budget.charge(unit)
  run.launched += 1
  failures.delete(label)
  try {
    return await agent(prompt, { ...ROLE_MODELS[role], label, schema })
  } catch (error) {
    failures.set(label, String(error?.message ?? error))
    return null
  }
}

function failureNote(label) {
  return failures.has(label) ? `（host の失敗: ${failures.get(label)}）` : ''
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
  const res = await launch('carrier', carrierPrompt(requests), { unit, label, schema: CARRIER_SCHEMA })
  if (!res || !Array.isArray(res.responses)) return { failed: true, lost: true, reason: `運搬役が結果を返さなかった${failureNote(label)}`, responses: [] }
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
    : {
        key: input.key, function: fn, target: input.target, limits: LIMITS,
        ...(fn === FUNCTION.create ? { request: input.request } : { grounds: input.grounds }),
      }
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

function goalPrompt(round, failures) {
  const update = fn === FUNCTION.update
  return [
    'あなたは best-practices の書き手（目標の固定）。生成した主張ではなく入力として目標を固定する（目標は検証役の受理を通さずに前提に書かれるので、入力に無いものを足すと検証で見つからない）。',
    `書いてよいのは作業ファイル（${run.workDir}）だけ。対象スキルには書かない。`,
    '返すもの: {"goal": {...}} か {"missing": [{"question", "reason"}]} のどちらか一方。',
    `goal は ${Object.values(GOAL_KEYS).join('・')} の 5 欄を持ち、各欄は {"text", "sources"} の並び（値が無い欄は空の並び）。成果物は最終的に検証できるものにし、調査・手段・検証の手順を入れない。`,
    `各要素の sources は 1 つ以上。出所は ${update ? '{"kind":"snapshot","path":<写しの中のパス>,"quote":<そのファイルからの逐語の引用>}、{"kind":"ground","ground":<修正の根拠の記録 ID>}、{"kind":"answer","quote":<回答からの逐語の引用>}' : '{"kind":"request","quote":<依頼文からの逐語の引用>}、{"kind":"answer","quote":<回答からの逐語の引用>}'}。引用は 1 字も変えない（CLI が原文に含まれるかを照らす）。`,
    update ? '修正の根拠として扱う根拠の全てを、成果物か範囲の要素の出所として 1 回以上指す。' : '',
    'missing を返すのは: 検証できる成果物を 1 つも特定できない、指示語を固有名に置き換えられない、成果物か範囲が違ってくる複数の読みがあり決める記述が無い、2 つ以上の記述が同時に満たせない、のどれかのとき。',
    '',
    `目標の固定の回: ${round}`,
    update ? `作り直す前の写し: ${run.workDir}/snapshot/root/（plugin の workflow script は ${run.workDir}/snapshot/plugin/）` : `依頼文:\n${memo.request}`,
    update ? `修正の根拠（記録 ID と中身）:\n${JSON.stringify(memo.grounds)}` : '',
    `利用者の回答:\n${JSON.stringify(memo.answers.map((a) => a.text))}`,
    failures.length ? `前の回の出所の照合で通らなかった要素:\n${JSON.stringify(failures)}` : '',
  ].filter((l) => l !== '').join('\n')
}

async function goalStage(plan) {
  phase(STAGE_TITLES.goal)
  const status = await stageStart(STAGE.goal, plan.goalRound, [{ goal: plan.goalRound }], {})
  const itemId = status[0].id
  if (status[0].result) return
  let n = plan.goalRepeats
  let failures = []
  while (true) {
    if (!budget.fits(WORST.goalAttempt)) throw new Stop(STOP_KINDS.iterationLimit, launchReason(), { limitHit: LIMIT_HITS.launch })
    const unit = budget.open(WORST.goalAttempt)
    try {
      const res = await launch('writer', goalPrompt(plan.goalRound, failures), { unit, label: 'writer:goal', schema: goalSchema() })
      if (!res) throw new Stop(STOP_KINDS.blocked, `段「目標の固定」の書き手が結果を返さなかった${failureNote('writer:goal')}`)
      if (res.missing) {
        throw new Stop(STOP_KINDS.needsInput, `目標を固定する入力が足りない。問い: ${res.missing.map((m) => `${m.question}（${m.reason}）`).join(' / ')}`)
      }
      n += 1
      const r = await carry([write(OPS.goalCheck, { item: itemId, n, goal: res.goal })], { unit })
      if (!r.ok) throw new Stop(STOP_KINDS.blocked, `段「目標の固定」の出所の照合の運搬役が失敗した: ${r.reason}`)
      const out = r.responses[0]
      if (out.passed) {
        markItem(itemId, 'done')
        open.finished = true
        memo.goalText = canonical(res.goal)
        return
      }
      failures = out.failures
      if (out.untilPass.hit) {
        throw new Stop(STOP_KINDS.needsInput, `until-pass の上限 ${out.untilPass.limit} 回でも出所の照合を通らなかった。出所の無い要素と、決めるのに要る回答: ${failures.map((f) => `${f.element}${f.index == null ? '' : `[${f.index}]`}: ${f.reason}`).join(' / ')}`)
      }
    } finally {
      budget.close(unit)
    }
  }
}

function writePrompt(number, rewrite) {
  const update = fn === FUNCTION.update
  return [
    'あなたは best-practices の書き手（書く）。書き込みを 1 本の流れに保つため、書き手はこの 1 体だけ。',
    `書いてよい先: 対象スキルのパスの一覧の中（根 ${memo.target.root} の配下と、一覧の根の外のファイル ${JSON.stringify(memo.target.files ?? [])}）と、作業ファイル（${run.workDir}）だけ。一覧の外に書くと run は BLOCKED で止まり、書いたものは戻されない。`,
    update ? '修正の根拠が触れない部分を含めて、対象スキルの全体を作り直してよい。ディレクトリの中でファイルを足しても消してもよい。新しい Workflow script が要るときはスキルのディレクトリの中に置く。' : 'Workflow script が要るときは、このディレクトリの中に置く（plugins/ の下へ置かない）。',
    '固定した目標に無い目標・制約を入れない。実行役の時間の上限の値を入れない。',
    `形は判定基準（${CRITERIA.conformance} の SP-BPCONFORMANCE-004 の順、Q3 は SP-BPCONFORMANCE-005）で問いに答えて決め、資産台帳の要否（SP-BPCONFORMANCE-009）と部品（SP-BPCONFORMANCE-008）を選ぶ。要求は ${CRITERIA.designedSkill}。`,
    '答えた問いと答え、重い形を強いた事実、段ごとの部品の名前を、対象スキルのディレクトリの中の 1 つのファイルに設計の説明として書く。形が変わらない反復でも今の対象スキルと食い違わないように保つ。',
    `返すもの: {"written": [{"path": <絶対パス>, "action": ${Object.values(FILE_ACTIONS).map((a) => JSON.stringify(a)).join('|')}}], "designNote": {"path": <根からの相対パス>, "heading": <節の見出し、ファイル全体なら省く>}}。説明の文は返さない（検証役に渡さないため）。`,
    '',
    `反復の番号: ${number}`,
    `固定した目標:\n${memo.goalText}`,
    update ? `作り直す前の写し: ${run.workDir}/snapshot/\n修正の根拠:\n${JSON.stringify(memo.grounds)}` : '',
    rewrite ? `書き直しの入力（直前の反復の合否が不合格とした指摘と判定の単位だけ）:\n${JSON.stringify(rewrite)}` : '',
  ].filter((l) => l !== '').join('\n')
}

async function writeStage(number, rewrite) {
  phase(STAGE_TITLES.write)
  const status = await stageStart(STAGE.write, number, [{ iteration: number }])
  const itemId = status[0].id
  if (!budget.fits(WORST.write)) throw new Stop(STOP_KINDS.iterationLimit, launchReason(), { limitHit: LIMIT_HITS.launch })
  const unit = budget.open(WORST.write)
  try {
    const res = await launch('writer', writePrompt(number, rewrite), { unit, label: 'writer:write', schema: WRITE_SCHEMA })
    if (!res) throw new Stop(STOP_KINDS.blocked, `段「書く」の書き手が結果を返さなかった${failureNote('writer:write')}。一覧の外は確かめていない`, { scan: number })
    memo.written = res.written
    const entries = res.written.map((w) => ({ path: w.path, iteration: number, action: w.action }))
    // 書いたファイルを先に記録する。結果が拒否されても、書いたファイルが一覧と返り値から漏れないようにするため。
    const r = await carry([
      write(OPS.files, { entries }),
      write(OPS.itemResult, { item: itemId, result: { written: res.written, designNote: res.designNote } }),
    ], { unit })
    if (r.responses[0]?.ok) memo.outside = r.responses[0].outside
    if (!r.ok) {
      const outsideReason = memo.outside.length ? `。書き手が対象スキルのパスの一覧の外のパスも返した（戻していない）: ${memo.outside.join(', ')}` : ''
      throw new Stop(STOP_KINDS.blocked, `段「書く」の運搬役（CLI）が失敗した: ${r.reason}${outsideReason}`)
    }
    markItem(itemId, 'done')
    const outside = r.responses[0].outside
    if (outside.length) {
      throw new Stop(STOP_KINDS.blocked, `書き手が対象スキルのパスの一覧の外のパスを返した（戻していない）: ${outside.join(', ')}`, { outside })
    }
    return await ledgerBatch(number, unit)
  } finally {
    budget.close(unit)
  }
}

async function ledgerBatch(number, unit, { retakePaths = true } = {}) {
  phase(STAGE_TITLES.ledger)
  const requests = [
    ...(retakePaths ? [write(OPS.pathsRetake, { iteration: number }), write(OPS.stageFinish, { stage: STAGE.write, round: number })] : []),
    write(OPS.stageStart, { stage: STAGE.ledger, round: number, keys: [] }),
    write(run.ledger ? OPS.ledgerRetake : OPS.ledgerCreate, {}),
    write(OPS.stageFinish, { stage: STAGE.ledger, round: number }),
    write(OPS.assignments, { stage: STAGE.verify, rule: ASSIGN_RULES.all }),
    write(OPS.stageStart, { stage: STAGE.verify, round: number, keys: VIEWPOINT_LIST.map((v) => ({ viewpoint: v })) }),
  ]
  if (!budget.fits(WORST.carrier) && unit === undefined) throw new Stop(STOP_KINDS.iterationLimit, launchReason(), { limitHit: LIMIT_HITS.launch })
  const r = await carry(requests, { unit })
  if (!r.ok) throw new Stop(STOP_KINDS.blocked, `段「台帳」の運搬役（CLI）が失敗した: ${r.reason}`)
  const out = r.responses
  const offset = retakePaths ? 2 : 0
  if (retakePaths) memo.unresolved = out[0].unresolved
  const ledgerOut = out[offset + 1]
  run.ledger = true
  const retake = ledgerOut.retake ? { round: ledgerOut.retake, affected: ledgerOut.affected ?? [] } : null
  const { id: assignment, assets } = out[offset + 3].assignments[0]
  const verify = out[offset + 4]
  verify.status.forEach((st, i) => viewpointByItem.set(st.id, VIEWPOINT_LIST[i]))
  track(STAGE.verify, number, verify.status)
  return { assignment, assets, verifyStatus: verify.status, retake }
}

function verifierPrompt({ viewpoint, assignment, assets, itemId, attempt, extra }) {
  const payloadFile = `${itemId}.a${attempt}.json`
  const kindsCmd = command(read(OPS.kinds, { viewpoint }))
  const unitsCmd = command(read(OPS.units))
  const reportCmd = command(read(OPS.report, { viewpoints: [viewpoint], fields: ['assets'] }))
  const lines = [
    `あなたは best-practices の検証役（${viewpoint} の観点）。書き手と別の context で、対象スキルの今の内容だけを判定基準の写しに照らす（生成した本人の説明は渡されない）。`,
    `書いてよいのは作業ファイル（${run.workDir}）だけ。対象スキルにも状態にも書かない。`,
    `判定基準は写しだけを読む: ${Object.values(CRITERIA).join(' ')}。記憶や写しの外の文書を判定基準にしない。`,
    `対象スキル: ${memo.target.root}（根の外のファイル ${JSON.stringify(memo.target.files ?? [])}）`,
    `資産の位置（パスと範囲）は次の読み出しで得る:\n${reportCmd}`,
    `指摘の種類は次の閉集合から選ぶ:\n${kindsCmd}`,
    `担当の資産ごとに judgement を ${Object.values(JUDGEMENTS).join('・')} のどれか 1 つ返す。${JUDGEMENTS.candidate} の資産には候補（asset・viewpoint・kind・quote（行番号つきの原文）・content・fix）を 1 件以上添える。`,
  ]
  if (viewpoint === 'conformance') {
    lines.push(
      `適用の判定表（SP-BPCONFORMANCE-003）の行と、行ごとの判定の単位の一覧は次の読み出しで得る:\n${unitsCmd}`,
      `applicability.row に、対象スキルに当たる行を 1 つ選ぶ。units には、その行の判定の単位の全てについて、一覧の unit の値をそのまま写して result（${Object.values(UNIT_RESULTS).join('・')}）と reason を付ける。${UNIT_RESULTS.nonconform} には同じ結果の中の候補の鍵を keys に添え、${UNIT_RESULTS.unchecked} には unchecked（${UNCHECKED_KINDS.forced} は一覧の forced の単位だけ）を添える。`,
      'residualRisks に、配布先で効くかを確かめられなかった役ごとの制限を {role, restriction, host, reason} で全て挙げる。',
    )
  }
  if (viewpoint === 'goal') {
    lines.push(
      `固定した目標:\n${memo.goalText}`,
      fn === FUNCTION.create ? `依頼文:\n${memo.request}` : `作り直す前の写し: ${run.workDir}/snapshot/\n修正の根拠:\n${JSON.stringify(memo.grounds)}`,
      `利用者の回答:\n${JSON.stringify(memo.answers.map((a) => a.text))}`,
      '「依頼に無い目標・制約」は固定した目標ではなく依頼文・写し・修正の根拠・回答の原文に照らす。判定基準が求める制約は候補にせず、basisConstraints に {asset, sp} で返す。',
    )
  }
  if (viewpoint === 'contract') {
    lines.push(
      `作り直す前の写し: ${run.workDir}/snapshot/`,
      `修正の根拠（記録 ID と中身）:\n${JSON.stringify(memo.grounds)}`,
      `契約の 5 つの要素（${CONTRACT_ELEMENTS.join('・')}）ごとに写しと今の対象スキルを照らし、変わったところを全て contractChanges に挙げる。choice は修正の根拠の記録 ID・判定基準の仕様項目 ID・${JSON.stringify(CONTRACT_NONE)} のどれか。${JSON.stringify(CONTRACT_NONE)} の変化はその要素の指摘の種類の候補にする。`,
    )
  }
  if (extra) lines.push(`この起動は追加の検証（skip 一覧の資産だけ）。`)
  lines.push(
    PAYLOAD_MODE === 'file' ? `返り値と同じ JSON を {"result": <返り値>} の形で ${run.workDir}/${payloadFile} にも書く（CLI が両者の一致を照らす）。` : '',
    '',
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
    const res = await launch('verifier', prompt, { unit, label: `verifier:${viewpoint}${extra ? ':extra' : ''}`, schema: verifySchema(viewpoint) })
    if (!res) return { reason: '検証役が結果を返さなかった' }
    const body = PAYLOAD_MODE === 'file'
      ? { item: itemId, assignment, viewpoint, payloadFile, payloadSum: fnvSum({ result: res }) }
      : { item: itemId, assignment, viewpoint, result: res }
    return writeResult(stage, write(OPS.verdicts, body), unit)
  }, stage)
}

async function verifyStage(number, { assignment, assets, verifyStatus }) {
  phase(STAGE_TITLES.verify)
  const entries = verifyStatus.filter((s) => !s.result && !s.aborted && !s.discarded).map((s) => ({ itemId: s.id, viewpoint: viewpointByItem.get(s.id), attempts: s.attempts }))
  await fanOut(STAGE.verify, entries, (e) => verifyItem({ ...e, assignment, assets, stage: STAGE.verify }))
}

function judgedStages(number) {
  return [{ stage: STAGE.verify, round: number }, { stage: STAGE.verifyExtra, round: number }]
}

async function closeVerify(number, { finishVerify = true } = {}) {
  const out = await mustCarry(STAGE.verify, [
    ...(finishVerify ? [write(OPS.stageFinish, { stage: STAGE.verify, round: number })] : []),
    read(OPS.report, { viewpoints: VIEWPOINT_LIST, fields: ['skip'] }),
    read(OPS.refutationItems, { stages: judgedStages(number) }),
  ])
  if (finishVerify) open.finished = true
  const [rep, items] = out.slice(-2)
  if (!(await verifyExtraStage(number, rep.skip))) return items.keys
  const [, again] = await mustCarry(STAGE.verifyExtra, [
    write(OPS.stageFinish, { stage: STAGE.verifyExtra, round: number }),
    read(OPS.refutationItems, { stages: judgedStages(number) }),
  ])
  open = { stage: STAGE.verifyExtra, round: number, items: open?.stage === STAGE.verifyExtra ? open.items : [], finished: true }
  return again.keys
}

async function verifyExtraStage(number, initialSkip) {
  let part = 0
  let active = [...VIEWPOINT_LIST]
  let skip = initialSkip
  while (true) {
    const skips = new Map(skip.map((s) => [s.viewpoint, s.assets.map((a) => a.id)]))
    active = active.filter((v) => (skips.get(v) ?? []).length > 0)
    if (!active.length) break
    if (part === 0) phase(STAGE_TITLES[STAGE.verifyExtra])
    part += 1
    const n = part + run.extraParts
    const reqs = active.map((v) => write(OPS.assignments, { stage: STAGE.verifyExtra, rule: ASSIGN_RULES.skip, viewpoint: v }))
    reqs.push(write(OPS.stageStart, { stage: STAGE.verifyExtra, round: number, part: n, keys: active.map((v) => ({ viewpoint: v, pass: n })) }))
    const out = await mustCarry(STAGE.verifyExtra, reqs)
    const started = out.at(-1)
    track(STAGE.verifyExtra, number, started.status, { append: true })
    const entries = started.status.map((s, i) => ({ itemId: s.id, viewpoint: active[i], attempts: s.attempts, assignment: out[i].assignments[0].id, assets: out[i].assignments[0].assets, done: s.result || s.aborted || s.discarded }))
    await fanOut(STAGE.verifyExtra, entries.filter((e) => !e.done), (e) => verifyItem({ ...e, extra: true, stage: STAGE.verifyExtra }))
    const [next] = await mustCarry(STAGE.verifyExtra, [read(OPS.report, { viewpoints: VIEWPOINT_LIST, fields: ['skip'] })])
    const after = new Map(next.skip.map((s) => [s.viewpoint, s.assets.length]))
    active = active.filter((v) => (after.get(v) ?? 0) < (skips.get(v) ?? []).length)
    skip = next.skip
  }
  return part > 0 || run.extraParts > 0
}

function refuterPrompt(key, readCmd) {
  return [
    'あなたは best-practices の反証役。候補を出した検証役と別の context で、指摘の候補が判定基準に照らして本当に成り立つかを確かめる（生成した本人には自分の誤りが見えない）。',
    `書いてよいのは作業ファイル（${run.workDir}）だけ。判定基準は写しだけを読む: ${Object.values(CRITERIA).join(' ')}`,
    `対象スキル: ${memo.target.root}`,
    `候補の引用・内容・直し方は次の読み出しで、指摘の鍵が下と同じものを読む（同じ鍵の候補は全て）:\n${readCmd}`,
    `鍵ごとに 1 つの判定として ${JSON.stringify(REFUTATION_VERDICTS.uphold)}（維持）か ${JSON.stringify(REFUTATION_VERDICTS.reject)}（却下）を選び、理由を添えて {"verdict", "reason"} で返す。`,
    '',
    `指摘の鍵: ${JSON.stringify(key)}`,
  ].join('\n')
}

async function refuteStage(number, keys) {
  if (!keys.length) return false
  phase(STAGE_TITLES.refute)
  const status = await stageStart(STAGE.refute, number, keys)
  const readCmd = command(read(OPS.refutationItems, { stages: judgedStages(number), texts: true }))
  const entries = status.map((s, i) => ({ ...s, key: keys[i] })).filter((s) => !s.result && !s.aborted && !s.discarded)
  await fanOut(STAGE.refute, entries, (e) => itemLoop(e.id, e.attempts, async (attempt, unit) => {
    const res = await launch('refuter', refuterPrompt(e.key, readCmd), { unit, label: 'refuter', schema: REFUTE_SCHEMA })
    if (!res) {
      // 未反証の記録と試行の失敗は、どちらも本文が起動の前に決まるので 1 回の運搬役で書く（SP-BPFINDINGS-015・SP-BPRUN-028）。
      return { reason: '反証役が結果を返さなかった', alsoWrite: write(OPS.refutation, { item: e.id, verdict: null, attempt }) }
    }
    return writeResult(STAGE.refute, write(OPS.refutation, { item: e.id, verdict: res.verdict, reason: res.reason }), unit)
  }, STAGE.refute))
  return true
}

function refuteBookends(number, started) {
  return [
    ...(started ? [] : [write(OPS.stageStart, { stage: STAGE.refute, round: number, keys: [] })]),
    write(OPS.stageFinish, { stage: STAGE.refute, round: number }),
  ]
}

async function vanishStage(retake) {
  if (!retake || !retake.affected.length) return
  phase(STAGE_TITLES.vanish)
  const keys = retake.affected.map((f) => ({ finding: f, gone: retake.round }))
  const status = await stageStart(STAGE.vanish, retake.round, keys)
  const listCmd = command(read(OPS.report, { viewpoints: VIEWPOINT_LIST, fields: ['findings', 'assets'] }))
  const entries = status.map((s, i) => ({ ...s, key: keys[i] })).filter((s) => !s.result && !s.aborted && !s.discarded)
  await fanOut(STAGE.vanish, entries, (e) => itemLoop(e.id, e.attempts, async (attempt, unit) => {
    const prompt = [
      `あなたは best-practices の検証役（消えた資産の照合）。指摘のあった資産が消えたので、今の資産 ID の一覧から同じ内容を持つ資産を 1 つ選ぶか ${JSON.stringify(VANISH_NONE)} を返す。`,
      `書いてよいのは作業ファイル（${run.workDir}）だけ。指摘の引用・内容と今の資産 ID の一覧は次の読み出しで得る:\n${listCmd}`,
      `返すもの: {"choice": <今の資産 ID か ${JSON.stringify(VANISH_NONE)}>}`,
      '',
      `指摘 ID: ${e.key.finding}`,
    ].join('\n')
    // 検証役が結果を返さなかったときは「判定できない」として記録する（SP-BPFINDINGS-037）。
    const res = await launch('verifier', prompt, { unit, label: 'verifier:vanish', schema: VANISH_SCHEMA })
    return writeResult(STAGE.vanish, write(OPS.vanishMatch, { item: e.id, choice: res ? res.choice : null }), unit)
  }, STAGE.vanish))
  await mustCarry(STAGE.vanish, [write(OPS.stageFinish, { stage: STAGE.vanish, round: retake.round })])
  open.finished = true
}

async function rejudgeAndGate(number, before = []) {
  phase(STAGE_TITLES.rejudge)
  const out = await mustCarry(STAGE.rejudge, [
    ...before,
    write(OPS.stageStart, { stage: STAGE.rejudge, round: number, keys: [] }),
    write(OPS.reviewJudge, { stages: judgedStages(number), round: number }),
    write(OPS.stageFinish, { stage: STAGE.rejudge, round: number }),
    write(OPS.stageStart, { stage: STAGE.gate, round: number, keys: [{ iteration: number }] }),
    write(OPS.gate, { number }),
    write(OPS.stageFinish, { stage: STAGE.gate, round: number }),
  ])
  phase(STAGE_TITLES.gate)
  const k = before.length
  track(STAGE.gate, number, out[k + 3].status)
  const g = out[k + 4]
  markItem(g.item, 'done')
  open.finished = true
  return g
}

function gateReason(g) {
  const u = g.unverifiable
  return [
    u.findings.length ? `検証が成り立たない指摘: ${u.findings.join(', ')}` : '',
    u.unrefuted.length ? `未反証の候補: ${u.unrefuted.map((k) => `${k.asset}/${k.viewpoint}/${k.kind}`).join(', ')}` : '',
    u.skip.length ? `skip 一覧に残った資産: ${u.skip.map((s) => `${s.viewpoint}=${s.assets.join(',')}`).join(' ')}` : '',
    u.aborted.length ? `打ち切りになった項目: ${u.aborted.join(', ')}` : '',
  ].filter(Boolean).join(' / ')
}

async function afterRefute(number, refuted, retake) {
  if (retake?.affected.length) {
    await mustCarry(STAGE.refute, refuteBookends(number, refuted))
    open = { stage: STAGE.refute, round: number, items: open?.stage === STAGE.refute ? open.items : [], finished: true }
    await vanishStage(retake)
    return rejudgeAndGate(number)
  }
  return rejudgeAndGate(number, refuteBookends(number, refuted))
}

async function iteration(number, rewrite, startAt, retakePaths = false) {
  let ctx
  if (startAt === STAGE.write) ctx = await writeStage(number, rewrite)
  else ctx = await ledgerBatch(number, undefined, { retakePaths })
  await verifyStage(number, ctx)
  const keys = await closeVerify(number)
  const refuted = await refuteStage(number, keys)
  return afterRefute(number, refuted, ctx.retake)
}

// 表は SP-BPAUTHORING-035 が正本。書かずに台帳の段から検証し直すのは、検証役・反証役が結果を返せない BLOCKED だけ（書き直す入力が無い）。

function resumePlan(p) {
  const stopped = p.stopped
  const last = p.lastStop
  const base = { goalRound: p.goalRound, goalRepeats: p.goalRepeats, number: p.number, rewrite: p.lastGate?.rewrite ?? null }
  const fresh = (stage) => ({ ...base, discard: stopped.items.filter((x) => !x.result && !x.aborted && !x.discarded).map((x) => x.id), finish: stopped.stage && stopped.status !== STAGE_STATUS.finished ? stopped : null, ...stage })
  const goalNext = p.goal ? null : { goal: true, goalRound: p.goalRound + 1 }
  if (!last && !stopped.stage) return { ...base, goal: !p.goal, goalRound: Math.max(1, p.goalRound), start: STAGE.write, number: p.number + 1 }
  const beforeWrite = [STAGE.start, STAGE.snapshot, STAGE.goal].includes(stopped.stage)
  const continueSame = () => ({
    ...base, continue: stopped, goal: !p.goal, goalRound: stopped.stage === STAGE.goal ? p.goalRound : p.goalRound + 1,
    start: stopped.stage, number: beforeWrite ? p.number + 1 : p.number,
    discard: stopped.stage === STAGE.verifyExtra ? stopped.items.filter((x) => !x.result && !x.aborted && !x.discarded).map((x) => x.id) : [],
  })
  if (!last) return continueSame()
  if (last.kind === STOP_KINDS.iterationLimit && last.limitHit === LIMIT_HITS.launch) return continueSame()
  if (last.kind === STOP_KINDS.needsInput) return fresh({ goal: true, goalRound: p.goalRound + 1, start: STAGE.write, number: p.number + 1 })
  if (last.kind === STOP_KINDS.iterationLimit) return fresh({ ...(goalNext ?? {}), start: STAGE.write, number: p.number + 1 })
  const at = last.stage?.stage ?? null
  if (at === STAGE.snapshot || at === STAGE.start || at === null) return fresh({ ...(goalNext ?? { goal: false }), start: STAGE.write, number: p.number + 1 })
  if (at === STAGE.goal) return fresh({ ...(goalNext ?? { goal: false }), start: STAGE.write, number: p.number + 1 })
  if (at === STAGE.write || last.cause !== STOP_CAUSES.verifiers) return fresh({ goal: false, start: STAGE.write, number: p.number + 1 })
  return fresh({ goal: false, start: STAGE.ledger, number: p.number + 1 })
}

// 理由は SP-BPRUN-027・SP-BPRUN-030 の段・役・失敗の内容を持つ（完了の停止は理由を持たないので、止めようとした停止の種類も書く）。
// 段は、照合と停止の段を持つ機能はその段、持たない機能は止まった段（停止の記録に書くはずだった段）とする。
function stopFailure(stop, carrier, r) {
  const stage = STAGE_TITLES.close ?? STAGE_TITLES[open?.stage ?? STAGE.start]
  return `停止の記録を書けなかった（段「${stage}」の${carrier}の運搬役。止めようとした停止: ${stop.kind}${stop.reason ? `: ${stop.reason}` : ''}）: ${r.reason}`
}

async function finish(stop) {
  const kind = stop.kind
  const before = stop.extra.scan ? [write(OPS.filesScan, { iteration: stop.extra.scan })] : []
  // 停止の記録が無くても書いたファイルの記録は状態にあるので、上限を超えないときは読んで返り値に載せる（SP-BPRUN-032 はどの停止でも書いたファイルを返す）。
  const unwritten = async (r, carrier) => {
    const out = {
      ...early(STOP_KINDS.blocked, stopFailure(stop, carrier, r), { [NEXT_ARGS_KEYS.function]: fn, [NEXT_ARGS_KEYS.state]: run.state }),
      [RESULT_KEYS.run]: run.run,
      [RESULT_KEYS.unverifiedRoleLimits]: ROLE_WRITE_LIMITS,
    }
    if (budget.limit === undefined || budget.used() < budget.limit) {
      const w = await carry([read(OPS.writtenFiles)])
      if (w.ok && w.responses[0].writtenFiles.length) out[RESULT_KEYS.writtenFiles] = w.responses[0].writtenFiles
    }
    out[RESULT_KEYS.launches] = budget.used()
    return out
  }
  // 停止の前の書き込みは停止と別の運搬役で先に書き、応答を確かめてから停止を送る。停止を書いた後の run への書き込みは CLI が拒否するので、
  // 同じ運搬役に積むと、停止の後に応答を失ったときに送り直せない（SP-BPRUN-027）。
  if (before.length) {
    const pre = await carryTwice(before, 1)
    if (!pre.ok) return unwritten(pre, '停止の前の書き込み')
  }
  const body = {
    kind,
    ...(kind === STOP_KINDS.complete ? {} : { reason: stop.reason }),
    ...(stop.extra.limitHit ? { limitHit: stop.extra.limitHit } : {}),
    ...(stop.extra.cause ? { cause: stop.extra.cause } : {}),
    launches: budget.used() + 1,
    outside: memo.outside,
  }
  // 停止は受け取った要求の sha256 で同じ停止として受け、返り値は読むだけなので、応答を失っても同じ 2 つの要求を送り直せる。送り直しは停止の記録の起動数に入らない（SP-BPRUN-034）。
  const r = await carryTwice([write(OPS.stop, body), read(OPS.outcome)])
  if (!r.ok) return unwritten(r, '停止')
  return r.responses.at(-1)
}

async function main() {
  const s = await startRun()
  if (s.early) return s.early
  const p = s.progress
  memo.request = p.request ?? memo.request
  memo.answers = p.answers
  memo.grounds = p.grounds
  memo.goalText = p.goalText
  run.ledger = p.ledger
  run.extraParts = 0
  memo.target = p.target
  const plan = input.resume ? resumePlan(p) : { goal: true, goalRound: 1, goalRepeats: 0, number: 1, start: STAGE.write, rewrite: null }
  if (plan.discard?.length || plan.finish) {
    const reqs = []
    if (plan.discard?.length) reqs.push(write(OPS.discard, { items: plan.discard }))
    if (plan.finish) reqs.push(write(OPS.stageFinish, { stage: plan.finish.stage, round: plan.finish.round }))
    await mustCarry(STAGE.start, reqs)
  }
  if (fn === FUNCTION.update) {
    phase(STAGE_TITLES.snapshot)
    await mustCarry(STAGE.snapshot, [
      write(OPS.stageStart, { stage: STAGE.snapshot, keys: [] }),
      write(OPS.snapshot, {}),
      write(OPS.stageFinish, { stage: STAGE.snapshot }),
    ])
    open = { stage: STAGE.snapshot, round: null, items: [], finished: true }
  }
  if (s.retake?.affected?.length) await vanishStage({ round: s.retake.retake, affected: s.retake.affected })
  if (plan.goal) await goalStage({ goalRound: plan.goalRound, goalRepeats: plan.goalRepeats })
  let number = plan.number
  let rewrite = plan.rewrite
  let startAt = plan.start === STAGE.write || plan.start === STAGE.goal || plan.start === STAGE.snapshot || plan.start === STAGE.start ? STAGE.write : STAGE.ledger
  if (plan.continue) {
    if (plan.continue.stage === STAGE.verifyExtra) run.extraParts = plan.continue.parts
    if (plan.continue.stage === STAGE.write && !plan.continue.items.some((x) => x.result)) startAt = STAGE.write
    else if (plan.continue.stage !== STAGE.goal && plan.continue.stage !== STAGE.snapshot && plan.continue.stage !== STAGE.start) startAt = STAGE.ledger
    if ([STAGE.verify, STAGE.verifyExtra, STAGE.refute, STAGE.vanish, STAGE.rejudge, STAGE.gate].includes(plan.continue.stage)) startAt = 'resume-verify'
  }
  while (true) {
    let g
    if (startAt === 'resume-verify') g = await continueIteration(number, plan.continue)
    else g = await iteration(number, rewrite, startAt, plan.continue?.stage === STAGE.write)
    if (g.next === GATE_NEXT.complete) throw new Stop(STOP_KINDS.complete, '')
    if (g.next === GATE_NEXT.blocked) throw new Stop(STOP_KINDS.blocked, `反復 ${number} の検証が成り立たない: ${gateReason(g)}`, { cause: STOP_CAUSES.verifiers })
    if (g.next === GATE_NEXT.iterationLimit) {
      throw new Stop(STOP_KINDS.iterationLimit, `反復の上限 ${g.iterations.limit} 回に達した。不合格の指摘: ${g.failing.findings.join(', ') || 'なし'}。不合格の判定の単位: ${g.failing.units.join(', ') || 'なし'}`, { limitHit: LIMIT_HITS.iteration })
    }
    number += 1
    rewrite = g.rewrite
    startAt = STAGE.write
  }
}

async function continueIteration(number, stopped) {
  const at = stopped.stage
  if (at === STAGE.verify) {
    const [asg] = await mustCarry(STAGE.verify, [write(OPS.assignments, { stage: STAGE.verify, rule: ASSIGN_RULES.all })])
    const { id: assignment, assets } = asg.assignments[0]
    const status = await stageStart(STAGE.verify, number, VIEWPOINT_LIST.map((v) => ({ viewpoint: v })))
    status.forEach((st, i) => viewpointByItem.set(st.id, VIEWPOINT_LIST[i]))
    await verifyStage(number, { assignment, assets, verifyStatus: status })
  }
  if (at === STAGE.verify || at === STAGE.verifyExtra) {
    const keys = await closeVerify(number, { finishVerify: at === STAGE.verify })
    return afterRefute(number, await refuteStage(number, keys), null)
  }
  if (at === STAGE.refute) {
    const [items] = await mustCarry(STAGE.refute, [read(OPS.refutationItems, { stages: judgedStages(number) })])
    return afterRefute(number, await refuteStage(number, items.keys), null)
  }
  if (at === STAGE.vanish) {
    await vanishStage({ round: stopped.round, affected: stopped.items.map((x) => x.key.finding) })
    return rejudgeAndGate(number)
  }
  return rejudgeAndGate(number)
}

let result
try {
  result = await main()
  if (result && result[RESULT_KEYS.stopKind]) return result
} catch (error) {
  if (!(error instanceof Stop)) {
    const stop = new Stop(STOP_KINDS.blocked, `script の内部の失敗: ${error?.message ?? String(error)}`)
    return run.run ? finish(stop) : early(STOP_KINDS.blocked, stop.reason)
  }
  if (!run.run) return { ...early(error.kind, error.reason), [RESULT_KEYS.launches]: budget.used() }
  return finish(error)
}
return result
