export const meta = {
  name: 'skill-creator-build',
  description:
    'スキル生成の Phase 2–4（基準生成 → 構成設計/検証 → 執筆 → with_skill vs baseline 評価 → 改稿）を決定的に実行する',
  phases: [
    { title: 'Criteria' },
    { title: 'Structure' },
    { title: 'Write' },
    { title: 'Test' },
    { title: 'Evaluate' },
    { title: 'Grade' },
    { title: 'Analyze' },
  ],
}

// DELTA_THRESHOLD: with_skill と baseline の pass_rate 差がこの値未満なら「スキルが効いて
// いない」と判定して改稿へ回す。SKILL.md の判定基準（delta >= 0.2 で合格）をそのまま定数化。
const DELTA_THRESHOLD = 0.2

// MAX_REVISIONS: 改稿の上限。1 回改稿しても閾値に届かないなら実装レベルではなく計画レベル
// （要件・基準）の問題である可能性が高く、script 内で回し続けても収束しない。上限に達したら
// 判断材料を添えて呼び出し元（司令塔）へ返し、Phase 1/2 へ遡るかを人間が決める。
const MAX_REVISIONS = 1

// MAX_STRUCTURE_ATTEMPTS: 構成設計の再試行上限。designer → reviewer で ❌ が出たら差し戻すが、
// 2 回目でも残るなら構成ではなく要件側の問題。未解決のまま返して人間の判断を仰ぐ。
const MAX_STRUCTURE_ATTEMPTS = 2

// 検証結果は自由記述の ✅/⚠️/❌ ではなく schema で構造化して受け取る。markdown 中の絵文字を
// script が数える形にすると、書式のゆらぎで合否が変わる代理指標ゲートになる（§12）。
// 判定そのものを契約フィールドとして受け取り、script はその値だけを見る。
const VERDICT = { type: 'string', enum: ['ok', 'warn', 'fail'] }

const STRUCTURE_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          result: VERDICT,
          rationale: { type: 'string' },
        },
        required: ['name', 'result', 'rationale'],
      },
    },
    failed: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    priority_fixes: { type: 'array', items: { type: 'string' } },
    report: { type: 'string' },
  },
  required: ['checks', 'failed', 'report'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    criteria_checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          result: VERDICT,
          rationale: { type: 'string' },
        },
        required: ['name', 'result', 'rationale'],
      },
    },
    trigger_checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          test_id: { type: 'string' },
          expectation_met: { type: 'boolean' },
          rationale: { type: 'string' },
        },
        required: ['test_id', 'expectation_met', 'rationale'],
      },
    },
    failed: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    priority_improvements: { type: 'array', items: { type: 'string' } },
    report: { type: 'string' },
  },
  required: ['criteria_checks', 'failed', 'report'],
}

// TEST_CASES_SCHEMA: tester.md の出力形式はプロンプト 3 本のみだが、grader は
// assertions を必要とする（SKILL.md Step 4-3 の [TEST_CASE] は「プロンプト + assertions」）。
// schema で assertions を必須にして、この受け渡しのギャップを塞ぐ。
const TEST_CASES_SCHEMA = {
  type: 'object',
  properties: {
    cases: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['normal', 'edge', 'should-not-trigger'] },
          prompt: { type: 'string' },
          expected_output: { type: 'string' },
          assertions: { type: 'array', minItems: 1, items: { type: 'string' } },
        },
        required: ['id', 'kind', 'prompt', 'assertions'],
      },
    },
  },
  required: ['cases'],
}

const SUMMARY_SIDE = {
  type: 'object',
  properties: {
    pass: { type: 'number' },
    partial: { type: 'number' },
    fail: { type: 'number' },
    pass_rate: { type: 'number' },
  },
  required: ['pass_rate'],
}

const GRADING_SCHEMA = {
  type: 'object',
  properties: {
    eval_id: { type: 'string' },
    assertions: { type: 'array' },
    summary: {
      type: 'object',
      properties: {
        with_skill: SUMMARY_SIDE,
        baseline: SUMMARY_SIDE,
        delta: { type: 'number' },
      },
      required: ['with_skill', 'baseline', 'delta'],
    },
  },
  required: ['eval_id', 'summary'],
}

const parsedArgs = (typeof args === 'string' ? JSON.parse(args) : args) || {}

// スキルの実ディレクトリ。workflow スクリプトは自身の位置を解決できないので呼び出し側が渡す。
const SKILL_DIR = parsedArgs.skillDir
if (!SKILL_DIR) {
  throw new Error('args.skillDir が未指定です。SKILL.md の Workflow 呼び出し例に従ってください。')
}

const requirements = parsedArgs.requirements
if (!requirements || typeof requirements !== 'string' || !requirements.trim()) {
  throw new Error('args.requirements が空です。Phase 1 で構造化した要件全体を渡してください。')
}

const taskType = parsedArgs.taskType || 'document'
const personas = parsedArgs.personas || {}
const maxRevisions = parsedArgs.maxRevisions ?? MAX_REVISIONS

// agentType は指定しない。agents/*.md の frontmatter には subagent_type（analyzer / architect /
// qa / reviewer）が書かれているが、これらは Agent ツールのレジストリに登録された型ではなく、
// 指定すると解決に失敗する。役割はプロンプト本文（各 agents/*.md）が担っているので、
// model だけを渡して既定の subagent で実行する。
function roleAgent(file, body, opts) {
  return agent(
    [`Read ${SKILL_DIR}/agents/${file} for your full role instructions before doing anything else.`,
      '以下の入力を、その役割定義に従って処理すること。',
      '',
      body,
    ].join('\n'),
    opts
  )
}

const persona = (key) => personas[key] || '(ペルソナ指定なし。要件から適切な専門家像を自分で置くこと)'

// ---------------------------------------------------------------- Phase 2: 基準生成

phase('Criteria')
const criteriaGen = await roleAgent(
  'criteria-gen.md',
  [
    `[SKILL_DIR] = ${SKILL_DIR}`,
    `[PERSONA_CRITERIA_GEN]:\n${persona('criteriaGen')}`,
    `[TASK_TYPE]: ${taskType}`,
    `[REQUIREMENTS]:\n${requirements}`,
  ].join('\n\n'),
  { model: 'sonnet', phase: 'Criteria', label: 'criteria-gen' }
)

// comp は gen の出力を入力に取るため直列。ここは並列にできない依存関係。
const criteriaComp = await roleAgent(
  'criteria-comp.md',
  [
    `[PERSONA_CRITERIA_COMP]:\n${persona('criteriaComp')}`,
    `[TASK_TYPE]: ${taskType}`,
    `[REQUIREMENTS]:\n${requirements}`,
    `[EXISTING_CRITERIA]:\n${criteriaGen}`,
  ].join('\n\n'),
  { model: 'sonnet', phase: 'Criteria', label: 'criteria-comp' }
)

// criteria-comp は「統合後の完全リスト」を返す契約なので、これを確定版として扱う。
const criteria = criteriaComp || criteriaGen
log('検証基準を確定しました')

// ------------------------------------------------- Phase 2.5: 構成設計・検証（document のみ）

let structurePlan = '該当なし'
let structureReview = null
let structureAttempts = 0
let structureUnresolved = []

if (taskType === 'document') {
  phase('Structure')
  let feedback = null

  while (structureAttempts < MAX_STRUCTURE_ATTEMPTS) {
    structureAttempts++
    const plan = await roleAgent(
      'structure-designer.md',
      [
        `[PERSONA_STRUCTURE_DESIGNER]:\n${persona('structureDesigner')}`,
        `[REQUIREMENTS]:\n${requirements}`,
        `[CRITERIA]:\n${criteria}`,
        feedback
          ? `# 前回の構成案に対する指摘（これを解消した構成に作り直すこと）\n${feedback}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      { model: 'sonnet', phase: 'Structure', label: `structure-design-${structureAttempts}` }
    )

    // Generator と Verifier は別 agent（自分の出力を自分で検証させない）。
    const review = await roleAgent(
      'structure-reviewer.md',
      [
        `[PERSONA_STRUCTURE_REVIEWER]:\n${persona('structureReviewer')}`,
        `[REQUIREMENTS]:\n${requirements}`,
        `[CRITERIA]:\n${criteria}`,
        `[STRUCTURE_PLAN]:\n${plan}`,
      ].join('\n\n'),
      {
        model: 'sonnet',
        schema: STRUCTURE_REVIEW_SCHEMA,
        phase: 'Structure',
        label: `structure-review-${structureAttempts}`,
      }
    )

    structurePlan = plan
    structureReview = review

    const failed = review?.failed || []
    if (!failed.length) {
      log(`構成案が検証を通過しました（${structureAttempts} 回目）`)
      break
    }

    log(`構成案に未解決の指摘 ${failed.length} 件（${structureAttempts}/${MAX_STRUCTURE_ATTEMPTS}）`)
    structureUnresolved = failed
    feedback = [...failed, ...(review?.priority_fixes || [])].join('\n')
  }
}

// ---------------------------------------------------------------- Phase 3: 初稿執筆

phase('Write')
let skillDraft = await roleAgent(
  'writer.md',
  [
    `[SKILL_DIR] = ${SKILL_DIR}`,
    '[MODE]: initial',
    `[PERSONA_WRITER]:\n${persona('writer')}`,
    `[TASK_TYPE]: ${taskType}`,
    `[REQUIREMENTS]:\n${requirements}`,
    `[STRUCTURE_PLAN]:\n${structurePlan}`,
  ].join('\n\n'),
  { model: 'opus', phase: 'Write', label: 'write-initial' }
)

if (!skillDraft) {
  throw new Error('writer が初稿を返しませんでした。生成物を捏造せずここで打ち切ります。')
}

// ---------------------------------------------------------------- Phase 4: テスト生成

phase('Test')
// テストケースは改稿を跨いで固定する。改稿のたびに作り直すと、pass_rate の変化が
// 「スキルが良くなった」のか「テストが変わった」のか切り分けられなくなる。
const testCases = await roleAgent(
  'tester.md',
  [
    `[PERSONA_TESTER]:\n${persona('tester')}`,
    `[SKILL_NAME]: ${extractFrontmatter(skillDraft, 'name') || '(name 未取得)'}`,
    `[SKILL_DESCRIPTION]: ${extractFrontmatter(skillDraft, 'description') || '(description 未取得)'}`,
    `[REQUIREMENTS_SUMMARY]:\n${parsedArgs.requirementsSummary || requirements}`,
    '',
    '各テストケースには、そのテストで満たされるべき検証可能な assertions を必ず付けること。',
    'assertions は後段の採点者が with_skill / baseline 双方の出力に対して pass/fail を' +
      '判定するための基準になるため、「〜している」と観測可能な形で書くこと。',
  ].join('\n'),
  { model: 'haiku', schema: TEST_CASES_SCHEMA, phase: 'Test', label: 'generate-tests' }
)

const cases = testCases?.cases || []
if (!cases.length) {
  throw new Error('tester がテストケースを返しませんでした。評価なしで先に進めません。')
}

// ------------------------------------------- Phase 4: 評価ループ（改稿は MAX_REVISIONS 回まで）

const iterations = []
let revision = 0
let verdict = null

while (true) {
  const iterLabel = `i${revision + 1}`

  phase('Evaluate')
  // with_skill / baseline を全テストケース分まとめて起動する。ここが構造的保証の中核 ——
  // 「同一ターンで並列に」を散文で指示するのではなく parallel() で表現しているので、
  // 直列化も片側だけの実行も起こりえない。
  const runs = await parallel(
    cases.flatMap((tc) => [
      () =>
        agent(
          [
            '以下のスキル定義があなたのシステムプロンプトに含まれているものとして振る舞い、',
            '続くプロンプトにそのまま回答してください。',
            '',
            '# 境界（この評価実行に限った制約）',
            'これはスキル定義の品質を測るための評価実行であり、スキルの実装ではない。',
            'ファイルの作成・編集・削除を一切行わないこと。スキル定義が参照している',
            'スクリプトや補助ファイルがまだ存在しなくても、それを作らない。',
            '定義に書かれた手順を実行できない場合は、実行せずに「定義に従えばこう動く」を',
            '記述で答えること。読み取り専用の調査（Read / Grep / 状態を変えないコマンド）は',
            '通常どおり行ってよい。',
            '',
            'この制約がある理由: 評価対象は「定義がどれだけ的確に振る舞いを導くか」であって',
            '「不足を自力で補える agent かどうか」ではない。不足を補ってしまうと、',
            'baseline との差がスキル定義の質ではなく補完能力を測ってしまい、',
            '同時にリポジトリへ意図しない書き込みが残る。',
            '',
            '# スキル定義',
            skillDraft,
            '',
            '# プロンプト',
            tc.prompt,
          ].join('\n'),
          { phase: 'Evaluate', label: `with_skill-${tc.id}-${iterLabel}` }
        ).then((output) => ({ id: tc.id, side: 'with_skill', output })),
      () =>
        agent(`以下のプロンプトに対してそのまま回答してください。\n\n${tc.prompt}`, {
          phase: 'Evaluate',
          label: `baseline-${tc.id}-${iterLabel}`,
        }).then((output) => ({ id: tc.id, side: 'baseline', output })),
    ])
  )

  const byCase = new Map()
  for (const r of runs.filter(Boolean)) {
    if (!byCase.has(r.id)) byCase.set(r.id, {})
    byCase.get(r.id)[r.side] = r.output
  }

  phase('Grade')
  // 採点とレビューは互いに独立なので同時に走らせる。Promise.all ではなく parallel() を使う
  // のは、agent が落ちたときに全体を reject させず null に落として続行するため。
  const [gradings, review] = await parallel([
    () => parallel(
      cases.map((tc) => () => {
        const pair = byCase.get(tc.id) || {}
        // 片側でも出力が欠けているペアは採点しない。欠損を採点者に渡すと
        // 「出力が無い＝fail」として実態と違う delta が出る。
        if (!pair.with_skill || !pair.baseline) return Promise.resolve(null)
        return roleAgent(
          'grader.md',
          [
            `[SKILL_NAME]: ${extractFrontmatter(skillDraft, 'name') || '(不明)'}`,
            `[TEST_CASE_ID]: ${tc.id}`,
            `[TEST_CASE]:\n${JSON.stringify({ prompt: tc.prompt, assertions: tc.assertions }, null, 2)}`,
            `[WITH_SKILL_OUTPUT]:\n${pair.with_skill}`,
            `[BASELINE_OUTPUT]:\n${pair.baseline}`,
          ].join('\n\n'),
          { model: 'sonnet', schema: GRADING_SCHEMA, phase: 'Grade', label: `grade-${tc.id}-${iterLabel}` }
        )
      })
    ),
    () =>
      roleAgent(
        'reviewer.md',
        [
          `[PERSONA_REVIEWER]:\n${persona('reviewer')}`,
          `[SKILL_DRAFT]:\n${skillDraft}`,
          `[CRITERIA]:\n${criteria}`,
          `[TEST_CASES]:\n${JSON.stringify(cases, null, 2)}`,
        ].join('\n\n'),
        { model: 'opus', schema: REVIEW_SCHEMA, phase: 'Grade', label: `review-${iterLabel}` }
      ),
  ])

  const graded = gradings.filter(Boolean)
  // pass_rate の集計は script が行う。LLM に平均を出させない（§5 確定的処理はスクリプトへ）。
  const mean = (nums) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0)
  const withSkillRate = mean(graded.map((g) => g.summary.with_skill.pass_rate))
  const baselineRate = mean(graded.map((g) => g.summary.baseline.pass_rate))
  const delta = withSkillRate - baselineRate

  const reviewFailures = review?.failed || []
  const ungraded = cases.length - graded.length

  phase('Analyze')
  const winner = delta > 0.05 ? 'with_skill' : delta < -0.05 ? 'without_skill' : 'tie'
  const firstCase = cases[0]
  const firstPair = byCase.get(firstCase.id) || {}
  // comparator → analyzer は直列。analyzer の入力 [COMPARATOR_RESULT] は comparator の出力
  // そのものなので、並列化すると analyzer に「未取得」を渡すことになる（実際に何を渡すかが
  // 決まらないまま「並列に呼ぶ」とだけ書かれていた元の手順の穴）。1 回の await で解消する。
  const comparison =
    firstPair.with_skill && firstPair.baseline
      ? await roleAgent(
          'comparator.md',
          [
            `[TEST_PROMPT]:\n${firstCase.prompt}`,
            `[OUTPUT_A]:\n${firstPair.with_skill}`,
            `[OUTPUT_B]:\n${firstPair.baseline}`,
            `[ASSERTION_RATES]:\n${JSON.stringify({ with_skill: withSkillRate, baseline: baselineRate, delta }, null, 2)}`,
          ].join('\n\n'),
          { model: 'sonnet', phase: 'Analyze', label: `compare-${iterLabel}` }
        )
      : null

  const analysis = await roleAgent(
    'analyzer.md',
    [
      '[MODE]: post-hoc',
      `[WINNER]: ${winner}`,
      `[GRADING_RESULTS]:\n${JSON.stringify(graded, null, 2)}`,
      `[COMPARATOR_RESULT]:\n${comparison || '(テスト1の出力ペアが揃わず比較を実施できなかった)'}`,
    ].join('\n\n'),
    { model: 'sonnet', phase: 'Analyze', label: `analyze-${iterLabel}` }
  )

  const passed = delta >= DELTA_THRESHOLD && reviewFailures.length === 0
  log(
    `評価 ${revision + 1} 回目: delta ${delta.toFixed(2)}（with_skill ${withSkillRate.toFixed(2)} / baseline ${baselineRate.toFixed(2)}）` +
      ` / reviewer ❌ ${reviewFailures.length} 件 / ${passed ? '合格' : '不合格'}`
  )

  iterations.push({
    revision,
    pass_rates: { with_skill: withSkillRate, baseline: baselineRate, delta },
    ungraded_cases: ungraded,
    gradings: graded,
    review,
    comparison,
    analysis,
    passed,
  })

  if (passed) {
    verdict = 'passed'
    break
  }

  if (revision >= maxRevisions) {
    // 上限到達。ここから先は実装レベルではなく計画レベル（要件・基準）の問題である
    // 可能性が高いため、script では回さず司令塔へ返して人間の判断を仰ぐ。
    verdict = 'needs_human_decision'
    break
  }

  phase('Write')
  revision++
  const revised = await roleAgent(
    'writer.md',
    [
      `[SKILL_DIR] = ${SKILL_DIR}`,
      '[MODE]: revise',
      `[PERSONA_WRITER]:\n${persona('writer')}`,
      `[TASK_TYPE]: ${taskType}`,
      `[REQUIREMENTS]:\n${requirements}`,
      `[STRUCTURE_PLAN]:\n${structurePlan}`,
      `[PREVIOUS_DRAFT]:\n${skillDraft}`,
      `[REVIEW_REPORT]:\n${JSON.stringify(
        {
          pass_rates: { with_skill: withSkillRate, baseline: baselineRate, delta },
          reviewer_failures: reviewFailures,
          reviewer_warnings: review?.warnings || [],
          priority_improvements: review?.priority_improvements || [],
          analyzer_suggestions: analysis,
        },
        null,
        2
      )}`,
    ].join('\n\n'),
    { model: 'opus', phase: 'Write', label: `write-revise-${revision}` }
  )

  // 改稿に失敗したら前の稿を保持したまま打ち切る（草稿を失わない）。
  if (!revised) {
    verdict = 'revision_failed'
    break
  }
  skillDraft = revised
}

// frontmatter から 1 フィールドを取り出す。tester/grader へ渡す name・description の抽出用。
// 複数行 description（`>` や `|` の折り畳み）も拾えるよう、次のトップレベルキーまでを読む。
function extractFrontmatter(text, key) {
  const fm = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return null
  const lines = fm[1].split(/\r?\n/)
  const start = lines.findIndex((l) => l.startsWith(`${key}:`))
  if (start === -1) return null
  const first = lines[start].slice(key.length + 1).trim()
  const rest = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break
    rest.push(lines[i].trim())
  }
  const folded = (first === '>' || first === '|' ? '' : first) + ' ' + rest.join(' ')
  return folded.trim() || null
}

return {
  task_type: taskType,
  criteria,
  structure: {
    plan: structurePlan,
    attempts: structureAttempts,
    unresolved: structureUnresolved,
    review: structureReview,
  },
  skill_draft: skillDraft,
  test_cases: cases,
  iterations,
  final: iterations[iterations.length - 1] || null,
  revisions_used: revision,
  verdict,
}
