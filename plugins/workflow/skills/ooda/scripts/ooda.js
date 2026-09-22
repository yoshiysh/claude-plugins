export const meta = {
  name: 'ooda',
  description:
    'OODA を 1 周（Observe → Orient → Decide → Act → 観測の独立検証）回し、ledger.py に渡す entry を返す',
  phases: [
    { title: 'Observe', detail: '目的と前周の検証済み観測から事実の基準線を作る' },
    { title: 'Orient', detail: '状況の読みと根拠付きの選択肢 3 つ' },
    { title: 'Decide', detail: '既試行の方針を踏まえて 1 つ選ぶ' },
    { title: 'Act', detail: '計画を実行し出所付きの新しい観測を返す' },
    { title: 'Verify', detail: 'Act を書いていない agent が出所から観測を確認する' },
  ],
  codex_workflow_compatibility: {
    schema_version: 'claude-workflow-model-portability/v1',
    classification: 'portable',
    model_identity_semantics: 'non_load_bearing_scheduling_hint',
    codex_translation: 'drop_declared_model_hint_preserve_role_and_result_contract',
    quality_parity: 'not_guaranteed',
    model_hints: {
      observer: { requested_model: 'sonnet', role: 'collect sourced facts for one cycle' },
      orienter: { requested_model: 'opus', role: 'interpret facts into exactly three evidenced options' },
      decider: { requested_model: 'opus', role: 'select one option against constraints and ledger state' },
      actor: { requested_model: 'sonnet', role: 'execute the plan and report sourced observations' },
      observation_verifier: { requested_model: 'sonnet', role: 'confirm each observation from its source' },
    },
  },
}

function modelHint(callsite) {
  const hint = meta.codex_workflow_compatibility.model_hints[callsite]
  if (!hint) throw new Error(`undeclared model hint callsite: ${callsite}`)
  return hint.requested_model
}

const SOURCED = {
  type: 'object',
  required: ['observation', 'source'],
  properties: { observation: { type: 'string' }, source: { type: 'string' } },
}
const OBSERVE_SCHEMA = {
  type: 'object',
  required: ['baseline_metrics', 'current_state', 'gaps_identified'],
  properties: {
    baseline_metrics: {
      type: 'array',
      items: { type: 'object', required: ['metric', 'value', 'source'], properties: { metric: { type: 'string' }, value: {}, source: { type: 'string' } } },
    },
    current_state: { type: 'string' },
    gaps_identified: { type: 'array', items: { type: 'string' } },
  },
}
const ORIENT_SCHEMA = {
  type: 'object',
  required: ['status', 'situation', 'interpretation', 'options', 'implicit_guidance_and_control'],
  properties: {
    status: { type: 'string', enum: ['ok', 'insufficient_data'] },
    situation: { type: 'string' },
    interpretation: { type: 'string' },
    options: {
      type: 'array',
      items: {
        type: 'object',
        required: ['option_id', 'description', 'mechanism', 'evidence', 'risk_score'],
        properties: {
          option_id: { type: 'string' },
          description: { type: 'string' },
          mechanism: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          risk_score: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    fallback_options: { type: 'array', items: { type: 'string' } },
    implicit_guidance_and_control: { type: 'string' },
    missing_data: { type: 'array', items: { type: 'string' } },
  },
}
const DECIDE_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['ok', 'BLOCKED'] },
    selected_option_id: { type: 'string' },
    rationale: { type: 'string' },
    plan_steps: {
      type: 'array',
      items: { type: 'object', required: ['who', 'what', 'how'], properties: { who: { type: 'string' }, what: { type: 'string' }, how: { type: 'string' } } },
    },
    observations_to_collect: { type: 'array', items: { type: 'string' } },
    blocked_reasons: { type: 'array', items: { type: 'string' } },
  },
}
const ACT_SCHEMA = {
  type: 'object',
  required: ['executed_steps', 'new_observations', 'outcome'],
  properties: {
    executed_steps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['step', 'status', 'detail'],
        properties: { step: { type: 'string' }, status: { type: 'string', enum: ['executed', 'not_executed', 'failed'] }, detail: { type: 'string' } },
      },
    },
    new_observations: { type: 'array', items: SOURCED },
    outcome: { type: 'string', enum: ['observed', 'inconclusive', 'not_executed'] },
  },
}
const VERIFY_SCHEMA = {
  type: 'object',
  required: ['verified', 'rejected'],
  properties: {
    verified: {
      type: 'array',
      items: { type: 'object', required: ['observation', 'source', 'evidence'], properties: { observation: { type: 'string' }, source: { type: 'string' }, evidence: { type: 'string' } } },
    },
    rejected: {
      type: 'array',
      items: { type: 'object', required: ['observation', 'source', 'reason'], properties: { observation: { type: 'string' }, source: { type: 'string' }, reason: { type: 'string' } } },
    },
  },
}

const parsedArgs = (typeof args === 'string' ? JSON.parse(args) : args) || {}
const SKILL_DIR = parsedArgs.skillDir
const objective = String(parsedArgs.objective || '').trim()
const context = parsedArgs.context || '(なし)'
const constraints = parsedArgs.constraints || '(なし)'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const ledgerIsArray =
  parsedArgs.ledger === undefined ||
  (Array.isArray(parsedArgs.ledger) && parsedArgs.ledger.every((e) => isObject(e) && isObject(e.payload) && Number.isInteger(e.iteration) && e.iteration >= 1))
const ledger = ledgerIsArray ? parsedArgs.ledger || [] : []
const iteration = ledgerIsArray ? ledger.reduce((max, e) => Math.max(max, e.iteration), 0) + 1 : null

if (!SKILL_DIR || !objective) {
  return { status: 'BLOCKED', iteration, reason: 'args.skillDir と args.objective は必須です。agent は起動していません。', ledger_entries: [] }
}
if (!ledgerIsArray) {
  return { status: 'BLOCKED', iteration, reason: 'args.ledger は ledger.py read の出力（{iteration, phase, payload} を持つ entry の配列）をそのまま渡してください。', ledger_entries: [] }
}

const byPhase = (phase) => ledger.filter((e) => e.phase === phase)
const latest = (phase) => byPhase(phase).reduce((last, e) => (!last || e.iteration >= last.iteration ? e : last), null)
const listOf = (entry, field) => (entry && entry.payload && Array.isArray(entry.payload[field]) ? entry.payload[field] : null)

const lastVerified = latest('act_verified')
const verifiedFeedback = listOf(lastVerified, 'verified') || []
const lastOrient = latest('orient')
const cycleStatus = (entries) => {
  const at = (phase) => entries.find((e) => e.phase === phase)
  if (at('act_verified')) return 'verified'
  if (at('decide') && at('decide').payload.status === 'BLOCKED') return 'blocked'
  if (at('orient') && at('orient').payload.status === 'insufficient_data') return 'insufficient_data'
  return 'stopped_before_verify'
}
const ledgerState = [...new Set(ledger.map((e) => e.iteration))]
  .sort((a, b) => a - b)
  .map((n) => {
    const entries = ledger.filter((e) => e.iteration === n)
    const d = entries.find((e) => e.phase === 'decide')
    const check = entries.find((e) => e.phase === 'act_verified')
    const checkVerified = listOf(check, 'verified')
    const checkRejected = listOf(check, 'rejected')
    return {
      iteration: n,
      cycle_status: cycleStatus(entries),
      selected_option_id: (d && d.payload.selected_option_id) || null,
      selected_option: (d && d.payload.selected_option) || null,
      verified_results: checkVerified ? checkVerified.map((v) => v.observation) : null,
      rejected_count: checkRejected ? checkRejected.length : null,
    }
  })

const ledgerEntries = []
const record = (phase, payload) => ledgerEntries.push({ iteration, phase, payload })
const json = (v) => JSON.stringify(v, null, 2)
const roleAgent = (file, sections, opts) =>
  agent(
    [`Read ${SKILL_DIR}/agents/${file} for your full role instructions before doing anything else.`, '以下の入力を、その役割定義に従って処理し、契約の JSON を返すこと。', '', ...sections].join('\n\n'),
    opts
  )
const result = (status, extra) => ({ status, iteration, ledger_entries: ledgerEntries, ...extra })

phase('Observe')
const observe = await roleAgent(
  'observe.md',
  [`[OBJECTIVE]:\n${objective}`, `[CONTEXT]:\n${context}`, `[CONSTRAINTS]:\n${constraints}`, `[VERIFIED_FEEDBACK]（前周の検証済み観測。${verifiedFeedback.length} 件）:\n${json(verifiedFeedback)}`],
  { model: modelHint('observer'), phase: 'Observe', label: `observe#${iteration}`, schema: OBSERVE_SCHEMA }
)
if (!observe) return result('BLOCKED', { reason: 'observe agent が結果を返しませんでした。' })
record('observe', observe)

phase('Orient')
const orient = await roleAgent(
  'orient.md',
  [
    `[OBJECTIVE]:\n${objective}`,
    `[OBSERVATIONS]:\n${json(observe)}`,
    `[CONTEXT]:\n${context}`,
    `[PRIOR_ORIENTATION]:\n${lastOrient ? json({ iteration: lastOrient.iteration, situation: lastOrient.payload.situation, interpretation: lastOrient.payload.interpretation }) : '(初周)'}`,
  ],
  { model: modelHint('orienter'), phase: 'Orient', label: `orient#${iteration}`, schema: ORIENT_SCHEMA }
)
if (!orient) return result('BLOCKED', { reason: 'orient agent が結果を返しませんでした。', observe })
record('orient', orient)
if (orient.status === 'insufficient_data') {
  return result('INSUFFICIENT_DATA', { reason: 'Orient が観測不足と判定しました。', missing_data: orient.missing_data || [], observe, orient })
}
if (orient.options.length !== 3) {
  return result('BLOCKED', { reason: `Orient の契約違反: options は 3 件のはずが ${orient.options.length} 件です。`, observe, orient })
}

phase('Decide')
const decided = await roleAgent(
  'decide.md',
  [`[OBJECTIVE]:\n${objective}`, `[OPTIONS]:\n${json(orient.options)}`, `[CONSTRAINTS]:\n${constraints}`, `[LEDGER_STATE]（過去の周で選んだ方針と、その検証済みの結果）:\n${json(ledgerState)}`],
  { model: modelHint('decider'), phase: 'Decide', label: `decide#${iteration}`, schema: DECIDE_SCHEMA }
)
if (!decided) return result('BLOCKED', { reason: 'decide agent が結果を返しませんでした。', observe, orient })
const chosen = orient.options.find((o) => o.option_id === decided.selected_option_id)
const decide = { ...decided, selected_option: chosen ? chosen.description : null }
record('decide', decide)
if (decide.status === 'BLOCKED') {
  return result('BLOCKED', { reason: 'Decide が制約を満たす選択肢は無いと判定しました。', blocked_reasons: decide.blocked_reasons || [], observe, orient, decide })
}
if (!chosen || !(decide.plan_steps || []).length) {
  return result('BLOCKED', { reason: 'Decide の契約違反: selected_option_id が Orient の選択肢に無いか、plan_steps が空です。', observe, orient, decide })
}

phase('Act')
const act = await roleAgent(
  'act.md',
  [`[PLAN]:\n${json({ option: chosen, plan_steps: decide.plan_steps, observations_to_collect: decide.observations_to_collect || [] })}`, `[CONTEXT]:\n${context}`, `[CONSTRAINTS]:\n${constraints}`],
  { model: modelHint('actor'), phase: 'Act', label: `act#${iteration}`, schema: ACT_SCHEMA }
)
if (!act) return result('BLOCKED', { reason: 'act agent が結果を返しませんでした。', observe, orient, decide })
record('act', act)

phase('Verify')
const key = (o) => `${o.observation} ${o.source}`
const sourced = act.new_observations.filter((o) => String(o.source || '').trim())
const rejected = act.new_observations.filter((o) => !String(o.source || '').trim()).map((o) => ({ ...o, reason: 'source が空' }))
let verified = []
if (sourced.length) {
  const check = await roleAgent(
    'observation-verifier.md',
    [`[OBSERVATIONS_TO_VERIFY]:\n${json(sourced)}`, `[CONSTRAINTS]:\n${constraints}`],
    { model: modelHint('observation_verifier'), phase: 'Verify', label: `verify#${iteration}`, schema: VERIFY_SCHEMA }
  )
  if (!check) return result('BLOCKED', { reason: '検証役が結果を返しませんでした。Act の観測は次の周に渡しません。', observe, orient, decide, act })
  const candidates = new Set(sourced.map(key))
  const rejectedKeys = new Set(check.rejected.map(key))
  verified = check.verified.filter((v) => candidates.has(key(v)) && !rejectedKeys.has(key(v)))
  const verifiedKeys = new Set(verified.map(key))
  rejected.push(...check.rejected.filter((r) => candidates.has(key(r))))
  rejected.push(...sourced.filter((o) => !verifiedKeys.has(key(o)) && !rejectedKeys.has(key(o))).map((o) => ({ ...o, reason: '検証役の判定が無い' })))
}
const verification = { verified, rejected }
record('act_verified', verification)
log(`周 ${iteration}: verified ${verified.length} 件 / rejected ${rejected.length} 件`)

return result('ok', { observe, orient, decide, act, verification })
