export const meta = {
  name: 'dispatch-orchestrate',
  description:
    '複数ラウンドの subagent 委譲ループ（planner/executor/verifier 分離 + bounded loop-until-converged/stalled）',
  phases: [
    { title: 'Plan' },
    { title: 'Execute' },
    { title: 'Verify' },
    { title: 'Evaluate' },
    { title: 'Synthesize' },
  ],
  limits: {
    maxAgents: 109,
    concurrency: 8,
    timeoutMs: 6_600_000,
    agentTimeoutMs: 240_000,
    maxOutputBytes: 11_900_000,
  },
}

// DEFAULT_MAX_ROUNDS: 難問1件は Plan→Execute→Verify→Evaluate の1ラウンドで
// native Claude では Fable 呼び出し2回（Plan/Evaluate）+ 複数 subagent を消費する。
// Codex profile では同じ2つのroleがCodex host-defaultを使う。6ラウンドあれば
// 通常 3〜4ラウンドで収束する難問の大半をカバーしつつ、暴走時に打ち切れる。
// voodoo constant であることを認める初期値であり、固定値ではなく実績（収束までの
// 平均ラウンド数）を見て調整する対象。args.maxRounds はこの上限内だけ変更できる。
const DEFAULT_MAX_ROUNDS = 6
const HARD_MAX_ROUNDS = 6

// DEFAULT_SUBAGENTS_CAP: 1ラウンドの並列 fan-out が大きすぎるとレビュー困難・
// コスト超過を招くための上限。args.subagentsPerRoundCap はこの上限内だけ変更できる。
const DEFAULT_SUBAGENTS_CAP = 6
const HARD_SUBAGENTS_CAP = 8

// native Workflow は本体に meta を渡さないので、meta.limits（runner が読む）の写しを本体に置く。写しの一致と、
// limits が HARD_MAX_ROUNDS・HARD_SUBAGENTS_CAP の最悪の起動数・所要時間を覆うことは tests/dispatch-orchestrate.test.mjs が照らす。
const CODEX_RUNNER_LIMITS = {
  maxAgents: 109,
  concurrency: 8,
  timeoutMs: 6_600_000,
  agentTimeoutMs: 240_000,
  maxOutputBytes: 11_900_000,
}

const CLAUDE_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    round_goal: { type: 'string' },
    subagents: {
      type: 'array',
      maxItems: HARD_SUBAGENTS_CAP,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          role: { type: 'string' },
          model: { type: 'string', enum: ['sonnet', 'opus', 'haiku', 'fable'] },
          effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] },
          persona_commands: { type: 'array', items: { type: 'string' } },
          prompt: { type: 'string' },
          needs_verification: { type: 'boolean' },
          verification_reason: { type: 'string' },
          verifier_model: { type: 'string', enum: ['sonnet', 'opus', 'haiku', 'fable'] },
        },
        required: [
          'label',
          'role',
          'model',
          'effort',
          'prompt',
          'needs_verification',
          'verification_reason',
        ],
      },
    },
  },
  required: ['round_goal', 'subagents'],
}

// Codex host-default runs keep the same work roles and verification contract,
// but model tier selection is intentionally unavailable: every agent call lets
// the shared runner choose its configured default. Keep Claude's richer schema
// and explicit model selections unchanged.
const CODEX_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    round_goal: { type: 'string' },
    subagents: {
      type: 'array',
      maxItems: HARD_SUBAGENTS_CAP,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          role: { type: 'string' },
          prompt: { type: 'string' },
          needs_verification: { type: 'boolean' },
          verification_reason: { type: 'string' },
        },
        required: ['label', 'role', 'prompt', 'needs_verification', 'verification_reason'],
      },
    },
  },
  required: ['round_goal', 'subagents'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED', 'INSUFFICIENT'] },
    concerns: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['verdict', 'notes'],
}

const EVAL_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['converged', 'continue', 'stalled'] },
    round_summary: { type: 'string' },
    new_findings: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
    justification: { type: 'string' },
  },
  required: ['status', 'round_summary', 'justification'],
}

function roleReference(role, executionProfile) {
  const profileDir = executionProfile === 'codex_host_default' ? 'codex-host-default/' : ''
  return `${SKILL_DIR}/references/${profileDir}${role}-role.md`
}

function buildPlanPrompt(topic, history, cap, executionProfile) {
  const historyText = history.length
    ? history
        .map(
          (h) =>
            `Round ${h.round}: ${h.summary}\n新規発見: ${(h.findings || []).join('; ') || '(なし)'}\n未解決: ${(h.open_questions || []).join('; ') || '(なし)'}`
        )
        .join('\n\n')
    : '(初回ラウンド。まだ履歴なし)'
  return [
    `Execution profile: ${executionProfile}.`,
    executionProfile === 'codex_host_default'
      ? 'All agent calls use the Codex runner host-default model. Do not claim Claude Fable 5 or choose model tiers; plan only the task roles, prompts, and verification needs.'
      : 'Native Claude profile: follow the Fable 5 model-selection instructions in the planner role.',
    `Read ${roleReference('planner', executionProfile)} for your full role instructions before doing anything else.`,
    '',
    '# 元の難問',
    topic,
    '',
    '# これまでのラウンド履歴',
    historyText,
    '',
    '# このラウンドで計画すること',
    `最大 ${cap} 件の subagent を計画してください。各 subagent は互いに独立した並列タスク` +
      'として実行され、同一ラウンド内の他 subagent の出力は見えません。必要な前提情報は' +
      '各 subagent の prompt 本文に自己完結する形で埋め込んでください。',
  ].join('\n')
}

function buildVerifyPrompt(spec, output, executionProfile) {
  return [
    `Execution profile: ${executionProfile}.`,
    executionProfile === 'codex_host_default'
      ? 'You are a Codex-host-default verification worker. Do not claim Claude Fable 5 or any specific model identity.'
      : 'You are a Claude-native verification worker.',
    `Read ${roleReference('verifier', executionProfile)} for your full role instructions before doing anything else.`,
    '',
    '# 検証対象の subagent',
    `role: ${spec.role}`,
    `plan 側が検証を要求した理由: ${spec.verification_reason}`,
    '',
    '# 検証対象の出力',
    String(output),
  ].join('\n')
}

function buildExecutePrompt(spec, executionProfile) {
  if (executionProfile !== 'codex_host_default') return spec.prompt
  return [
    'Execution profile: codex_host_default.',
    'The shared runner chooses the model for this call. Do not identify yourself as Claude Fable 5 or claim model equivalence.',
    `Role: ${spec.role}`,
    '',
    spec.prompt,
  ].join('\n')
}

function buildEvalPrompt(topic, roundData, history, executionProfile) {
  return [
    `Execution profile: ${executionProfile}.`,
    executionProfile === 'codex_host_default'
      ? 'Evaluate as a Codex-host-default worker. Do not claim Claude Fable 5 or any specific model identity.'
      : 'Evaluate as a Claude Fable 5 worker under the native Claude profile.',
    `Read ${roleReference('evaluator', executionProfile)} for your full role instructions before doing anything else.`,
    '',
    '# 元の難問',
    topic,
    '',
    '# これまでのラウンド履歴（今回より前）',
    history.length ? JSON.stringify(history, null, 2) : '(初回ラウンド)',
    '',
    '# 今回のラウンドのデータ',
    JSON.stringify(roundData, null, 2),
  ].join('\n')
}

function buildSynthesisPrompt(topic, history, terminationReason, executionProfile) {
  return [
    `Execution profile: ${executionProfile}.`,
    executionProfile === 'codex_host_default'
      ? 'Synthesize as a Codex-host-default worker. Do not claim Claude Fable 5 or any specific model identity.'
      : 'Synthesize as a Claude Fable 5 worker under the native Claude profile.',
    `Read ${roleReference('synthesis', executionProfile)} for your full role instructions before doing anything else.`,
    '',
    '# 元の難問',
    topic,
    '',
    '# 終了理由',
    terminationReason,
    '',
    '# 全ラウンドの履歴',
    JSON.stringify(history, null, 2),
  ].join('\n')
}

// args はツール呼び出し側が JSON オブジェクトとして渡しても、この harness では
// 文字列（JSON テキストそのまま）で届くことが実測で確認されている。オブジェクトと
// 文字列の両方を受け付ける（Solve, don't punt — 実際に観測された挙動に合わせて
// 防御的に処理する。呼び出し側の実装を信用しすぎない）。
const parsedArgs = (typeof args === 'string' ? JSON.parse(args) : args) || {}

// スキルの実ディレクトリ。workflow スクリプトは自身の位置を解決できないので
// 呼び出し側（SKILL.md Step 2）が渡す。役割定義の Read パス組み立てに使う。
const SKILL_DIR = parsedArgs.skillDir
if (!SKILL_DIR) {
  return { error: 'args.skillDir が未指定です。SKILL.md Step 2 の呼び出し例に従ってください。' }
}
const topic = parsedArgs.topic
const executionProfile = parsedArgs.executionProfile ?? 'claude_native'
if (!['claude_native', 'codex_host_default'].includes(executionProfile)) {
  throw new Error('args.executionProfile must be claude_native or codex_host_default.')
}
const isCodexHostDefault = executionProfile === 'codex_host_default'
const maxRounds = parsedArgs.maxRounds ?? DEFAULT_MAX_ROUNDS
const subagentsCap = parsedArgs.subagentsPerRoundCap ?? DEFAULT_SUBAGENTS_CAP
if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > HARD_MAX_ROUNDS) {
  return { error: `args.maxRounds は 1..${HARD_MAX_ROUNDS} の整数で指定してください。` }
}
if (!Number.isInteger(subagentsCap) || subagentsCap < 1 || subagentsCap > HARD_SUBAGENTS_CAP) {
  return { error: `args.subagentsPerRoundCap は 1..${HARD_SUBAGENTS_CAP} の整数で指定してください。` }
}

// topic の空チェックを Plan ステップに進む前に行う。空のまま起動すると
// planner が「調査対象がない」ことに気づくまでに Plan+Evaluate+Synthesis の
// 3 agent 呼び出し分のコストがかかる（実際に発生した事故から追加）。
// args の文字列/オブジェクト両対応（上記）を経てもなお topic が空なら、
// 呼び出し側が本当に topic を渡し忘れている。
if (!topic || typeof topic !== 'string' || !topic.trim()) {
  throw new Error(
    'args.topic が空です。Workflow 呼び出し時に args.topic に調査対象の難問を渡しているか確認してください。'
  )
}

const history = []
let round = 0
let status = 'continue'

while (status === 'continue' && round < maxRounds) {
  round++
  const roundLabel = `r${round}`

  phase('Plan')
  const plan = await agent(buildPlanPrompt(topic, history, subagentsCap, executionProfile), {
    ...(isCodexHostDefault ? {} : { model: 'fable', effort: 'high' }),
    schema: isCodexHostDefault ? CODEX_PLAN_SCHEMA : CLAUDE_PLAN_SCHEMA,
    phase: 'Plan',
    label: `plan-${roundLabel}`,
  })
  const subagentSpecs = (plan?.subagents || []).slice(0, subagentsCap)

  phase('Execute')
  const executed = await parallel(
    subagentSpecs.map((spec) => () =>
      agent(buildExecutePrompt(spec, executionProfile), {
        ...(isCodexHostDefault ? {} : { model: spec.model, effort: spec.effort }),
        phase: 'Execute',
        label: `${spec.label}-${roundLabel}`,
      }).then((output) => ({ spec, output }))
    )
  )
  const results = executed.filter((r) => r && r.output)

  phase('Verify')
  const verifications = (
    await parallel(
      results.map(({ spec, output }) => () => {
        if (!spec.needs_verification) return Promise.resolve(null)
        return agent(buildVerifyPrompt(spec, output, executionProfile), {
          // Claude native profile では verifier_model は Plan ステップが subagent ごとに選ぶ。
          // 未指定時のみ sonnet にフォールバックする（verifier_model が省略された場合の
          // "solve, don't punt" 対応。既定を sonnet にする理由は SKILL.md 参照）。
          ...(isCodexHostDefault ? {} : { model: spec.verifier_model || 'sonnet' }),
          schema: VERIFY_SCHEMA,
          phase: 'Verify',
          label: `verify-${spec.label}-${roundLabel}`,
        }).then((v) => (v ? { label: spec.label, role: spec.role, ...v } : null))
      })
    )
  ).filter(Boolean)

  phase('Evaluate')
  const roundData = {
    round,
    goal: plan?.round_goal || '(plan 生成失敗)',
    results: results.map((r) => ({ label: r.spec.label, role: r.spec.role, output: r.output })),
    verifications,
  }
  const evaluation = await agent(buildEvalPrompt(topic, roundData, history, executionProfile), {
    ...(isCodexHostDefault ? {} : { model: 'fable', effort: 'high' }),
    schema: EVAL_SCHEMA,
    phase: 'Evaluate',
    label: `eval-${roundLabel}`,
  })

  log(`Round ${round}: ${evaluation.status} — ${evaluation.round_summary}`)
  history.push({
    round,
    goal: roundData.goal,
    summary: evaluation.round_summary,
    findings: evaluation.new_findings || [],
    open_questions: evaluation.open_questions || [],
  })
  status = evaluation.status
}

const terminationReason =
  status === 'converged'
    ? 'converged'
    : status === 'stalled'
      ? 'stalled'
      : 'max_rounds'

phase('Synthesize')
const synthesis = await agent(buildSynthesisPrompt(topic, history, terminationReason, executionProfile), {
  ...(isCodexHostDefault ? {} : { model: 'fable', effort: 'high' }),
  phase: 'Synthesize',
})

return {
  topic,
  execution_profile: executionProfile,
  model_map_disclosure: isCodexHostDefault
    ? {
        provider: 'Codex via dynamic-workflow-runner',
        roles: {
          planner: 'Codex host-default',
          executor: 'Codex host-default',
          verifier: 'Codex host-default',
          evaluator: 'Codex host-default',
          synthesis: 'Codex host-default',
        },
        model_equivalence_claimed: false,
        model_id_visibility: 'not exposed to the source result or host-default model.selected event',
        selection_evidence: 'runner model.selected event records origin=host-default',
        required_runner_limits: CODEX_RUNNER_LIMITS,
      }
    : {
        provider: 'native Claude Workflow',
        roles: {
          planner: 'Fable 5',
          evaluator: 'Fable 5',
          synthesis: 'Fable 5',
          executor: 'selected by planner from Sonnet/Opus/Haiku/Fable 5',
          verifier: 'selected by planner from Sonnet/Opus/Haiku/Fable 5',
        },
        model_equivalence_claimed: false,
      },
  rounds_run: round,
  termination_reason: terminationReason,
  synthesis,
  history,
}
