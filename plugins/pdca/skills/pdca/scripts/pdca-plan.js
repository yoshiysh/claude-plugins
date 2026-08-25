export const meta = {
  name: 'pdca-plan',
  description:
    'PDCA の Plan 区間（intake → 事実収集 → 立案 → 敵対的検証 → 改稿ループ）を決定的に実行する',
  phases: [
    { title: 'Intake', detail: '起点モード判定と不足入力の検出' },
    { title: 'Evidence', detail: '出典付き事実の収集（research:search 委譲）' },
    { title: 'Plan', detail: '立案 → plan-verifier の反証 → 改稿の until-pass ループ' },
  ],
}

// MAX_PLAN_REVISIONS: planner が verifier の findings を受けて改稿できる回数。2 で pass しない
// Plan は要件・予算側の問題である可能性が高く、改稿の積み重ねでは直らないため境界で人間に返す。
const MAX_PLAN_REVISIONS = 2

const INTAKE_SCHEMA = {
  type: 'object',
  required: ['origin_mode', 'statement', 'questions'],
  properties: {
    origin_mode: { type: 'string', enum: ['problem', 'motivation', 'claim_check'] },
    statement: { type: 'string' },
    has_environment: {},
    user_success_definition: {},
    budget: {},
    questions: { type: 'array', items: { type: 'string' } },
    materials: { type: 'array', items: { type: 'string' } },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'revise'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['lens', 'severity', 'claim', 'why_it_breaks_measurement'],
        properties: {
          lens: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          claim: { type: 'string' },
          why_it_breaks_measurement: { type: 'string' },
          what_would_make_it_testable: { type: 'string' },
        },
      },
    },
    non_findings: { type: 'array', items: { type: 'string' } },
  },
}

const PLANNER_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['ok', 'unverifiable'] },
    plan: {},
    reason: { type: 'string' },
    what_is_needed: { type: 'string' },
    needs_deliberation: { type: 'boolean' },
  },
}

const parsedArgs = (typeof args === 'string' ? JSON.parse(args) : args) || {}
const SKILL_DIR = parsedArgs.skillDir
if (!SKILL_DIR) throw new Error('args.skillDir が未指定です。')
const userInput = parsedArgs.input
if (!userInput || !String(userInput).trim()) {
  throw new Error('args.input が空です。起点の文（問題 / 動機 / 主張）を渡してください。')
}
const materials = parsedArgs.materials || '(追加資料なし)'
const budget = parsedArgs.budget ? JSON.stringify(parsedArgs.budget) : '(予算未指定 — intake が既定値を提案する)'

function roleAgent(file, body, opts) {
  return agent(
    [
      `Read ${SKILL_DIR}/agents/${file} for your full role instructions before doing anything else.`,
      '以下の入力を、その役割定義に従って処理すること。',
      '',
      body,
    ].join('\n'),
    opts
  )
}

// ------------------------------------------------------------------ Intake

phase('Intake')

const intake = await roleAgent(
  'intake.md',
  [`[USER_INPUT]:\n${userInput}`, `[MATERIALS]:\n${materials}`, `[BUDGET]:\n${budget}`].join('\n\n'),
  { phase: 'Intake', label: 'intake', schema: INTAKE_SCHEMA }
)

if (!intake) {
  return { status: 'BLOCKED', reason: 'intake が結果を返しませんでした。' }
}

// 不足入力はユーザーにしか埋められない。ここは自動化の対象外で、workflow の境界に返す。
if (intake.questions.length) {
  return {
    status: 'NEEDS_INPUT',
    reason: 'Plan に進むための入力が不足しています。',
    questions: intake.questions,
    intake,
  }
}

log(`起点モード: ${intake.origin_mode}`)

// ------------------------------------------------------------------ Evidence

phase('Evidence')

const evidence = await roleAgent(
  'evidence-collector.md',
  [
    `[INTAKE]:\n${JSON.stringify(intake, null, 2)}`,
    '事実確認には research:search スキルへのパイプライン委譲を使うこと。対象がローカルシステムの' +
      '場合は read-only のファイル調査で代替し、読んだパスを source に記録すること。',
  ].join('\n\n'),
  { phase: 'Evidence', label: 'evidence-collector' }
)

// ------------------------------------------------------------------ Plan (until-pass)

phase('Plan')

let plan = null
let review = null
let attempts = []
for (let attempt = 0; attempt <= MAX_PLAN_REVISIONS; attempt++) {
  const planText = await roleAgent(
    'planner.md',
    [
      `[INTAKE]:\n${JSON.stringify(intake, null, 2)}`,
      `[EVIDENCE]:\n${typeof evidence === 'string' ? evidence : JSON.stringify(evidence, null, 2)}`,
      review
        ? `[VERIFIER_FINDINGS]（前回の Plan への反証。blocker/major は全件、what_would_make_it_testable に沿って解消すること）:\n${JSON.stringify(review.findings, null, 2)}`
        : '',
      '返り値は schema に従うこと: 立案できたら { status: "ok", plan: <完全な Plan JSON> }、' +
        '検証不能なら { status: "unverifiable", reason, what_is_needed }。successCriteria に書く検証は' +
        'すべて記録済み成果物から機械的に再実行できるものに限る（verifier への契約になる）。',
    ]
      .filter(Boolean)
      .join('\n\n'),
    { model: 'opus', phase: 'Plan', label: `planner#${attempt + 1}`, schema: PLANNER_SCHEMA }
  )

  if (!planText) return { status: 'BLOCKED', reason: 'planner が結果を返しませんでした。', attempts }
  if (planText.status === 'unverifiable') {
    return {
      status: 'UNVERIFIABLE',
      reason: planText.reason || 'planner が検証不能と判定しました。',
      what_is_needed: planText.what_is_needed || null,
      attempts,
    }
  }
  plan = planText.plan

  review = await roleAgent(
    'plan-verifier.md',
    [
      `[PLAN_UNDER_REVIEW]:\n${typeof plan === 'string' ? plan : JSON.stringify(plan, null, 2)}`,
      '反証すること。合格の理由探しをしないこと。',
    ].join('\n\n'),
    { model: 'opus', phase: 'Plan', label: `plan-verify#${attempt + 1}`, schema: VERIFY_SCHEMA }
  )

  if (!review) return { status: 'BLOCKED', reason: 'plan-verifier が結果を返しませんでした。', plan, attempts }

  const hard = review.findings.filter((f) => f.severity !== 'minor')
  attempts.push({ attempt: attempt + 1, verdict: review.verdict, blockers_majors: hard.length })
  log(`Plan 検証 ${attempt + 1} 回目: ${review.verdict}（blocker/major ${hard.length} 件）`)

  if (review.verdict === 'pass' && hard.length === 0) {
    return {
      status: 'ok',
      origin_mode: intake.origin_mode,
      intake,
      evidence,
      plan,
      plan_review: review,
      attempts,
    }
  }
}

// 改稿上限まで pass しなかった。差し戻しは自動で続けても収束しない可能性が高い。
return {
  status: 'BLOCKED',
  reason: `Plan が ${MAX_PLAN_REVISIONS + 1} 回の検証で pass しませんでした。要件・予算・環境側の見直しが必要です。`,
  plan,
  plan_review: review,
  attempts,
}
