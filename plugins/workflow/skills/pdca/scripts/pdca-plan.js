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

// ledger は「この run で今までに何が決まったか」。省略時は空（初周・既存 caller の互換）。
// 中身は scripts/ledger.py read の出力をそのまま渡す。
const ledger = Array.isArray(parsedArgs.ledger) ? parsedArgs.ledger : []
// planner には Plan 系の entry だけを見せる。Do/Check の中間結果が見えていると、
// 出た結果に通る基準を書けてしまう（このスキルが最初に禁じている経路）。文言ではなく
// 入力の絞り込みで守る。
const PLANNER_LEDGER_TYPES = ['plan_v', 'review_v', 'resolution']
const ledgerEntries = []

function ledgerText(types) {
  const visible = types ? ledger.filter((e) => types.includes(e.type)) : ledger
  if (!visible.length) return '[LEDGER]: (この run ではまだ記録がありません)'
  return `[LEDGER]（読んでから書くこと。裁定済み（type: resolution）の論点を再提起するなら、その seq を refs に入れ、why_resolution_insufficient を書く）:\n${JSON.stringify(visible, null, 2)}`
}

// entry を構成するのはこの script。agent には読ませるだけにしてある（自筆の追記は
// 欠落と後からの書き換えを検出できなくする）。返り値の ledger_entries を、司令塔が
// 編集せずに scripts/ledger.py append へ流す。
function record(type, phase, summary, payload, refs) {
  ledgerEntries.push({ type, phase, summary, payload: payload || {}, refs: refs || [] })
}

// 直前の BLOCKED に対する自己解決が申告されているかを、ledger と args の両方で見る。
// 司令塔が「試したことにして」再立案するのを構造で止めるのが目的（SKILL.md の
// 「BLOCKED の自己解決」が散文の指示だけだと、省略しても何も検知されない）。
const blockedSeqs = ledger
  .filter((e) => e.type === 'review_v' && e.payload && e.payload.plan_status === 'BLOCKED')
  .map((e) => e.seq)
const lastBlockedSeq = blockedSeqs.length ? Math.max(...blockedSeqs) : null
const priorPlanBlocked = lastBlockedSeq !== null
// 直近の BLOCKED **より後**の resolution だけを数える。前の行き詰まりに対する裁定は、
// 今回の行き詰まりを解いたことにならない。
const resolvedAfterBlock = ledger.some((e) => e.type === 'resolution' && e.seq > lastBlockedSeq)
const selfResolution = parsedArgs.self_resolution || null
function selfResolutionIsComplete(sr) {
  return (
    sr &&
    typeof sr === 'object' &&
    String(sr.method || '').trim() &&
    String(sr.reason || '').trim() &&
    Array.isArray(sr.rejected_alternatives)
  )
}

if (priorPlanBlocked && !resolvedAfterBlock && !selfResolutionIsComplete(selfResolution)) {
  return {
    status: 'BLOCKED',
    reason:
      'この run の ledger には Plan の BLOCKED があり、それに対する自己解決の記録がありません。',
    evidence:
      'SKILL.md「BLOCKED の自己解決」の 3 手（測定方法の class 変更 / descope / findings を materials に渡して再立案）の' +
      'どれを実行し、なぜそれを選び、どの手を棄却したかを args.self_resolution = ' +
      '{ method, reason, rejected_alternatives[] } で渡してください。' +
      '自己解決を経ずに再立案すると、同じ行き詰まりを別の言い方で再提出するか、' +
      '一度棄却した class を無自覚に再試行します。',
    ledger_entries: ledgerEntries,
  }
}
if (selfResolutionIsComplete(selfResolution)) {
  record(
    'resolution',
    'Plan',
    `BLOCKED の自己解決: ${selfResolution.method}`,
    {
      method: selfResolution.method,
      reason: selfResolution.reason,
      rejected_alternatives: selfResolution.rejected_alternatives,
    },
    []
  )
  log(`自己解決を記録: ${selfResolution.method}`)
}

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
  [`[USER_INPUT]:\n${userInput}`, `[MATERIALS]:\n${materials}`, `[BUDGET]:\n${budget}`, ledgerText(null)].join('\n\n'),
  { phase: 'Intake', label: 'intake', schema: INTAKE_SCHEMA }
)

if (!intake) {
  return { status: 'BLOCKED', reason: 'intake が結果を返しませんでした。', ledger_entries: ledgerEntries }
}

// 不足入力はユーザーにしか埋められない。ここは自動化の対象外で、workflow の境界に返す。
if (intake.questions.length) {
  return {
    status: 'NEEDS_INPUT',
    reason: 'Plan に進むための入力が不足しています。',
    questions: intake.questions,
    intake,
    ledger_entries: ledgerEntries,
  }
}

log(`起点モード: ${intake.origin_mode}`)

// ------------------------------------------------------------------ Evidence

phase('Evidence')

const evidence = await roleAgent(
  'evidence-collector.md',
  [
    `[INTAKE]:\n${JSON.stringify(intake, null, 2)}`,
    ledgerText(PLANNER_LEDGER_TYPES),
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
      ledgerText(PLANNER_LEDGER_TYPES),
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

  if (!planText)
    return { status: 'BLOCKED', reason: 'planner が結果を返しませんでした。', attempts, ledger_entries: ledgerEntries }
  if (planText.status === 'unverifiable') {
    return {
      status: 'UNVERIFIABLE',
      reason: planText.reason || 'planner が検証不能と判定しました。',
      what_is_needed: planText.what_is_needed || null,
      attempts,
      ledger_entries: ledgerEntries,
    }
  }
  plan = planText.plan
  record('plan_v', 'Plan', `Plan v${attempt + 1} を立案`, {
    version: attempt + 1,
    success_criteria: (plan && plan.success_criteria) || null,
    chosen: (plan && plan.chosen) || null,
    rejected: (plan && plan.rejected) || [],
  })

  review = await roleAgent(
    'plan-verifier.md',
    [
      `[PLAN_UNDER_REVIEW]:\n${typeof plan === 'string' ? plan : JSON.stringify(plan, null, 2)}`,
      ledgerText(null),
      '反証すること。合格の理由探しをしないこと。',
    ].join('\n\n'),
    { model: 'opus', phase: 'Plan', label: `plan-verify#${attempt + 1}`, schema: VERIFY_SCHEMA }
  )

  if (!review)
    return { status: 'BLOCKED', reason: 'plan-verifier が結果を返しませんでした。', plan, attempts, ledger_entries: ledgerEntries }

  // 裁定済みの論点の再提起に参照が無いものはラベルを付けるだけで、落とさず severity も下げない。
  // 自動で消す経路を作ると、生成物への異論を生成側の都合で消せることになり、このスキルの
  // 生成と検証の不変条件に反する。差し戻すかどうかは司令塔が決める。
  const resolvedSeqs = ledger.filter((e) => e.type === 'resolution').map((e) => e.seq)
  review.findings = review.findings.map((f) => ({
    ...f,
    relitigated_without_reference:
      resolvedSeqs.length > 0 &&
      !(Array.isArray(f.refs) && f.refs.some((r) => resolvedSeqs.includes(r))) &&
      !String(f.why_resolution_insufficient || '').trim(),
  }))

  const hard = review.findings.filter((f) => f.severity !== 'minor')
  attempts.push({ attempt: attempt + 1, verdict: review.verdict, blockers_majors: hard.length })
  log(`Plan 検証 ${attempt + 1} 回目: ${review.verdict}（blocker/major ${hard.length} 件）`)
  record(
    'review_v',
    'Plan',
    `plan-verifier ${attempt + 1} 回目: ${review.verdict}（blocker/major ${hard.length} 件）`,
    {
      verdict: review.verdict,
      findings: review.findings,
      plan_status: review.verdict === 'pass' && hard.length === 0 ? 'ok' : 'pending',
    }
  )

  if (review.verdict === 'pass' && hard.length === 0) {
    return {
      status: 'ok',
      origin_mode: intake.origin_mode,
      intake,
      evidence,
      plan,
      plan_review: review,
      attempts,
      ledger_entries: ledgerEntries,
    }
  }
}

// 改稿上限まで pass しなかった。差し戻しは自動で続けても収束しない可能性が高い。
// BLOCKED であることを ledger に残すのは、次の再立案で「自己解決を経たか」を機械的に
// 見るため（記録が無ければ、試したことにして再提出する経路が開く）。
record('review_v', 'Plan', `Plan が ${MAX_PLAN_REVISIONS + 1} 回の検証で pass せず BLOCKED`, {
  plan_status: 'BLOCKED',
  last_findings: review ? review.findings : [],
})
return {
  status: 'BLOCKED',
  reason: `Plan が ${MAX_PLAN_REVISIONS + 1} 回の検証で pass しませんでした。要件・予算・環境側の見直しが必要です。`,
  next_step:
    'SKILL.md「BLOCKED の自己解決」の 3 手を順に試し、実行した手を args.self_resolution = ' +
    '{ method, reason, rejected_alternatives[] } に入れて再実行してください（この記録が無い再立案は script が止めます）。',
  plan,
  plan_review: review,
  attempts,
  ledger_entries: ledgerEntries,
}
