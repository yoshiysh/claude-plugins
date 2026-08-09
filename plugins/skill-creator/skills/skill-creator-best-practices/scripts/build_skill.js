export const meta = {
  name: 'skill-creator-build',
  description:
    'スキル生成の Phase 2–4（基準生成 → 構成設計/検証 → 執筆 → with_skill vs baseline 評価 → 改稿）を決定的に実行する',
  phases: [
    { title: 'Criteria' },
    { title: 'Structure' },
    { title: 'Write' },
    { title: 'Review script', detail: 'architecture=workflow のときだけ走る' },
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

// Workflow 型スキルの script 検証。reviewer 系と同じく failed[] を構造化して受け取る
// （markdown 中の記号を script 側で数えると、書式の揺れが判定を左右する）。
const SCRIPT_REVIEW_SCHEMA = {
  type: 'object',
  // intended_behavior を必須にしているのは、reviewer に「要件だけから本来の挙動を先に導く」
  // 工程を踏ませるため。これが無いと、script に書かれた構造を所与として禁止構文を探すだけの
  // 検査になり、構造そのものが要件に対して間違っている場合を落とす。書かせることで、
  // 突き合わせた形跡が残る（script_summary と同じ理屈）。
  required: ['verdict', 'intended_behavior', 'failed', 'script_summary'],
  properties: {
    verdict: { type: 'string', enum: ['ok', 'mismatch'] },
    intended_behavior: { type: 'string' },
    failed: {
      type: 'array',
      items: {
        type: 'object',
        // should_be（本来どう動くべきか）と fix（どう直すか）を分けて必須にする。
        // 直し方だけだと、なぜその直し方が正しいのかが失われる。
        required: ['category', 'item', 'why_it_matters', 'should_be', 'fix'],
        properties: {
          category: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E'] },
          item: { type: 'string' },
          evidence: { type: 'string' },
          why_it_matters: { type: 'string' },
          should_be: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
    warnings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['item'],
        properties: { item: { type: 'string' }, note: { type: 'string' } },
      },
    },
    script_summary: { type: 'string' },
  },
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

// EVAL_BOUNDARY: with_skill / baseline の両方に必ず入れる境界ブロック。
// 片側だけに付けると、付いていない側がテストプロンプトを額面どおり実行する。
// 実際に baseline 側だけ抜けていた時期があり、「README が雛形のままなので直して」という
// テストプロンプトに対して baseline agent が追跡ファイルを書き換えた。スキル定義を
// 渡されない baseline の方がむしろ歯止めが無い。
const EVAL_BOUNDARY = [
  '# 境界（この評価実行に限った制約）',
  'これはプロンプトに対する応答の質を測るための評価実行であり、依頼の遂行ではない。',
  'ファイルの作成・編集・削除を一切行わないこと。プロンプトが変更・修正・作成を',
  '求めていても、実際には適用せず「こう変更する」という内容を回答として書くこと。',
  '参照されているスクリプトや補助ファイルが存在しなくても、それを作らない。',
  '読み取り専用の調査（Read / Grep / 状態を変えないコマンド）は通常どおり行ってよい。',
  '',
  'この制約がある理由: 評価対象は回答の内容であって、環境を変更する能力ではない。',
  '実際に適用してしまうと、評価のたびにリポジトリへ意図しない変更が残る。',
].join('\n')

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
// architecture は taskType（ドメイン分類）とは別軸。「誰が plan を握るか」を決める。
// coordinator = Claude がターンごとに指揮 / workflow = 実行順序を script が握る。
// 既定を coordinator にしているのは、workflow 型は writer が動く .js まで書く必要があり、
// Phase 1 が明示的に選んだときだけ入るべき経路だから。
const architecture = parsedArgs.architecture || 'coordinator'
if (!['coordinator', 'workflow'].includes(architecture)) {
  throw new Error(
    `args.architecture は 'coordinator' か 'workflow' のいずれかです（受領: ${architecture}）。` +
      'taskType（document / procedure / data）とは別軸なので取り違えていないか確認してください。'
  )
}
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

// Structure は document 系のセクション設計のために置かれたフェーズだが、Workflow 型は
// taskType に関わらず「phase 構成・fan-out 点・集約点・barrier の位置」を先に決める必要が
// ある。ここを通さないと writer が執筆と同じ 1 パスで設計まで背負うことになる。
if (taskType === 'document' || architecture === 'workflow') {
  phase('Structure')
  let feedback = null

  while (structureAttempts < MAX_STRUCTURE_ATTEMPTS) {
    structureAttempts++
    const plan = await roleAgent(
      'structure-designer.md',
      [
        `[PERSONA_STRUCTURE_DESIGNER]:\n${persona('structureDesigner')}`,
        `[ARCHITECTURE]: ${architecture}`,
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
    `[ARCHITECTURE]: ${architecture}`,
    `[REQUIREMENTS]:\n${requirements}`,
    `[STRUCTURE_PLAN]:\n${structurePlan}`,
  ].join('\n\n'),
  { model: 'opus', phase: 'Write', label: 'write-initial' }
)

if (!skillDraft) {
  throw new Error('writer が初稿を返しませんでした。生成物を捏造せずここで打ち切ります。')
}

// 戻り値が SKILL.md 本文を含んでいることを、評価に入る前に確認する。
// writer が成果物をファイルへ書き出して「書きました」という報告だけを返す run が実測で
// あった。その状態でも文字列は非空なので上の !skillDraft は通過し、評価 agent には
// スキル定義の代わりにパス案内が渡る。読み取りは許可されているので with_skill 側だけが
// そのファイルを読んで実質的に定義を得てしまい、delta は大きく出るが測っているものは
// 「定義の質」ではなくなる。数字が良い方向に壊れるため気づきにくい。
if (!extractFrontmatter(skillDraft, 'name') || !extractFrontmatter(skillDraft, 'description')) {
  throw new Error(
    'writer の戻り値から name / description を持つ frontmatter を取り出せませんでした。' +
      'SKILL.md 本文そのものではなく、ファイルへの参照や作業報告が返っている可能性があります。' +
      `戻り値の冒頭: ${String(skillDraft).slice(0, 200)}`
  )
}

// ------------------------------------------------ Phase 3b: workflow script の抽出と検証

// writer は SKILL.md と workflow script を 1 つの戻り値にまとめて返す。script は
// ```javascript フェンスで囲まれた `export const meta` から始まるブロックとして取り出す。
// 「meta で始まる」を条件にしているのは、SKILL.md 本文に説明用の JS 断片が混ざっても
// それを script 本体と取り違えないため。
function extractWorkflowScript(text) {
  const re = /```(?:javascript|js)\s*\n([\s\S]*?)```/g
  let m
  while ((m = re.exec(String(text))) !== null) {
    const body = m[1]
    if (/^\s*export\s+const\s+meta\s*=/.test(body)) return body.trim()
  }
  return null
}

let workflowScript = null
let scriptReview = null
if (architecture === 'workflow') {
  workflowScript = extractWorkflowScript(skillDraft)
  // 骨組みだけ・説明だけを返す run を通すと、「Workflow 型で作った」という報告だけが残って
  // 実体が無いスキルが保存される。frontmatter 検査と同じ理由でここで打ち切る。
  if (!workflowScript) {
    throw new Error(
      'architecture=workflow ですが、writer の戻り値から workflow script を取り出せませんでした。' +
        '```javascript フェンス内の `export const meta = {...}` で始まるブロックが必要です。'
    )
  }

  phase('Review script')
  scriptReview = await roleAgent(
    'script-reviewer.md',
    [
      `[SKILL_DIR] = ${SKILL_DIR}`,
      `[PERSONA_SCRIPT_REVIEWER]:\n${persona('scriptReviewer')}`,
      `[REQUIREMENTS]:\n${requirements}`,
      `[SKILL_DRAFT]:\n${skillDraft}`,
      `[WORKFLOW_SCRIPT]:\n${workflowScript}`,
    ].join('\n\n'),
    {
      model: 'opus',
      phase: 'Review script',
      label: 'script-review',
      schema: SCRIPT_REVIEW_SCHEMA,
    }
  )
  // reviewer が落ちた場合を「失格 0 件」と読むと、レビューされていないものが
  // レビューを通ったことになる。欠測は欠測として最終 verdict に残す。
  if (!scriptReview) {
    log('script-reviewer が応答しませんでした。script の検証は未実施として報告します。')
  } else {
    log(
      `script review: ${scriptReview.verdict} / 失格 ${scriptReview.failed.length} 件` +
        `（警告 ${(scriptReview.warnings || []).length} 件）`
    )
  }
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

// Workflow 型に with_skill / baseline の delta ゲートを適用しない。この測定の前提は
// 「with_skill は方法論を持ち、baseline は持たない」だが、Workflow 型の方法論は script 側に
// あり、評価時点の script はディスク上に存在せず、しかも評価 subagent には Workflow ツール
// 自体が無い（実測）。つまり with_skill は方法論を一度も手にできず、出る数字は方法論の差では
// なく「script が保存済みか」を測っている。測れない前提のまま数字を出すのは代理指標ゲート
// （§12）なので、走らせない。合否は reviewer（基準充足）と script-reviewer が担う。
// 空配列にするのは、fan-out・採点・集計が構造的に発生しない形にするため。
const evalCases = architecture === 'workflow' ? [] : cases

while (true) {
  const iterLabel = `i${revision + 1}`

  phase('Evaluate')
  // with_skill / baseline を全テストケース分まとめて起動する。ここが構造的保証の中核 ——
  // 「同一ターンで並列に」を散文で指示するのではなく parallel() で表現しているので、
  // 直列化も片側だけの実行も起こりえない。
  const runs = await parallel(
    evalCases.flatMap((tc) => [
      () =>
        agent(
          [
            '以下のスキル定義があなたのシステムプロンプトに含まれているものとして振る舞い、',
            '続くプロンプトにそのまま回答してください。',
            '',
            EVAL_BOUNDARY,
            '定義に書かれた手順を実行できない場合も、実行せずに「定義に従えばこう動く」を',
            '記述で答えること。ここで不足を自力で補うと、baseline との差がスキル定義の質では',
            'なく補完能力を測ってしまう。',
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
        agent(
          [
            '以下のプロンプトに対してそのまま回答してください。',
            '',
            EVAL_BOUNDARY,
            '',
            '# プロンプト',
            tc.prompt,
          ].join('\n'),
          { phase: 'Evaluate', label: `baseline-${tc.id}-${iterLabel}` }
        ).then((output) => ({ id: tc.id, side: 'baseline', output })),
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
      evalCases.map((tc) => () => {
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
  const ungraded = evalCases.length - graded.length

  // 評価が揃ったかを、合否を計算する前に判定する。agent が落ちた分を欠測として扱わず
  // 平均に含めると、生き残った少数の結果から出た数字が全体の成績に見える。
  // 極端な例: 3 件中 2 件が落ちて 1 件だけ delta 0.9 を返すと、平均も 0.9 になり
  // 閾値を通ってしまう。reviewer も同様で、null を「失格 0 件」と読むと
  // 「レビューされていない」が「レビューを通った」に化ける。
  const evaluationComplete = ungraded === 0 && !!review

  // pass_rate の集計は script が行う。LLM に平均を出させない（§5 確定的処理はスクリプトへ）。
  // 1 件も採点できなかった場合は 0 ではなく null を返す。0 は「measured tie」を意味する
  // 実データの値であり、欠測をそこに丸めると両者が区別できなくなる。
  const mean = (nums) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null)
  const withSkillRate = mean(graded.map((g) => g.summary.with_skill.pass_rate))
  const baselineRate = mean(graded.map((g) => g.summary.baseline.pass_rate))
  const delta = withSkillRate === null || baselineRate === null ? null : withSkillRate - baselineRate

  const reviewFailures = review?.failed || []

  // Analyze は with_skill / baseline の出力比較なので、評価を回さない Workflow 型では
  // 入力そのものが存在しない。comparator / analyzer を空入力で起動すると、比較していない
  // 内容の「分析結果」が返る。走らせない。
  if (evalCases.length > 0) phase('Analyze')
  const winner =
    delta === null ? 'undetermined' : delta > 0.05 ? 'with_skill' : delta < -0.05 ? 'without_skill' : 'tie'
  const firstCase = evalCases[0] || null
  const firstPair = firstCase ? byCase.get(firstCase.id) || {} : {}
  // comparator → analyzer は直列。analyzer の入力 [COMPARATOR_RESULT] は comparator の出力
  // そのものなので、並列化すると analyzer に「未取得」を渡すことになる（実際に何を渡すかが
  // 決まらないまま「並列に呼ぶ」とだけ書かれていた元の手順の穴）。1 回の await で解消する。
  const comparison =
    firstPair.with_skill && firstPair.baseline
      ? await roleAgent(
          'comparator.md',
          [
            `[TEST_PROMPT]:\n${firstCase ? firstCase.prompt : ''}`,
            `[OUTPUT_A]:\n${firstPair.with_skill}`,
            `[OUTPUT_B]:\n${firstPair.baseline}`,
            `[ASSERTION_RATES]:\n${JSON.stringify({ with_skill: withSkillRate, baseline: baselineRate, delta }, null, 2)}`,
          ].join('\n\n'),
          { model: 'sonnet', phase: 'Analyze', label: `compare-${iterLabel}` }
        )
      : null

  const analysis = evalCases.length === 0 ? null : await roleAgent(
    'analyzer.md',
    [
      '[MODE]: post-hoc',
      `[WINNER]: ${winner}`,
      `[GRADING_RESULTS]:\n${JSON.stringify(graded, null, 2)}`,
      `[COMPARATOR_RESULT]:\n${comparison || '(テスト1の出力ペアが揃わず比較を実施できなかった)'}`,
    ].join('\n\n'),
    { model: 'sonnet', phase: 'Analyze', label: `analyze-${iterLabel}` }
  )

  // 合格には「閾値を超えた」だけでなく「評価が揃った」ことを要求する。欠測を含む
  // 数字で合格を出すと、達成度を実態より良く見せることになる。
  // Workflow 型は delta を持たないので、基準充足（reviewer）だけを品質ゲートにする。
  // script の合否はこの後段で別に見る（評価が揃わなくても報告するため）。
  const passed =
    evaluationComplete &&
    (architecture === 'workflow' || delta >= DELTA_THRESHOLD) &&
    reviewFailures.length === 0
  const fmt = (n) => (n === null ? 'n/a' : n.toFixed(2))
  // delta が n/a と出るのは「測って揃わなかった」場合と「そもそも測らない設計」の 2 通りが
  // あり、同じ表示にすると後者が失敗に見える。文言を分ける。
  log(
    (architecture === 'workflow'
      ? `判定 ${revision + 1} 回目: delta 評価は Workflow 型のため適用外`
      : `評価 ${revision + 1} 回目: delta ${fmt(delta)}（with_skill ${fmt(withSkillRate)} / baseline ${fmt(baselineRate)}）`) +
      ` / reviewer ${review ? `❌ ${reviewFailures.length} 件` : '未実施'}` +
      (ungraded ? ` / 未採点 ${ungraded}/${evalCases.length} 件` : '') +
      (architecture === 'workflow'
        ? ` / script ${scriptReview ? `❌ ${scriptReview.failed.length} 件` : '未検証'}`
        : '') +
      ` / ${passed ? '合格' : evaluationComplete ? '不合格' : '判定不能（評価が揃っていない）'}`
  )

  iterations.push({
    revision,
    pass_rates: { with_skill: withSkillRate, baseline: baselineRate, delta },
    ungraded_cases: ungraded,
    evaluation_complete: evaluationComplete,
    gradings: graded,
    review,
    comparison,
    analysis,
    passed,
  })

  // Workflow 型は script の合否を最初に見る。配布される実体は script なので、
  // 「評価が揃わなかった」を理由に品質と無関係な verdict を返すと、失格を抱えた script が
  // 「再実行すれば直る」扱いで保存されうる。reviewer が落ちた場合も「失格 0 件」と
  // 読まず、未検証として別 verdict にする（レビューされていないものを通したことにしない）。
  // script の改稿はこのループでは行わない。script-reviewer は Write 直後に 1 回だけ
  // 走る設計で、再検証の経路が無いまま writer を回すと、直ったかどうかを確かめずに
  // 次へ進むことになる。指摘を添えて司令塔へ返し、人間が判断する。
  if (architecture === 'workflow') {
    if (!scriptReview) {
      verdict = 'script_review_incomplete'
      break
    }
    if (scriptReview.verdict !== 'ok' || scriptReview.failed.length > 0) {
      verdict = 'script_rejected'
      break
    }
  }

  if (passed) {
    verdict = 'passed'
    break
  }

  // 評価が揃っていないなら改稿しない。何を直すべきかの根拠が無いまま writer を回すと、
  // 稿を書き換えたうえで次ラウンドも同じ理由で判定不能になりうる。品質不足とは
  // 区別できる verdict で返し、再実行するかを人間が決める。
  if (!evaluationComplete) {
    verdict = 'evaluation_incomplete'
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
//
// 先頭固定で探さない理由: writer は「## SKILL.md の完全なテキスト」のような前置きを付けて
// ```markdown フェンスの中に本文を入れて返すことがある（実測）。先頭一致にすると、
// 本文が確かに含まれている戻り値でも抽出に失敗する。行頭の `---` を本文中から探し、
// name を持つ最初のブロックを frontmatter として採る。
function extractFrontmatter(text, key) {
  const all = String(text).split(/\r?\n/)
  // `---` の行番号を集め、隣り合う 2 本で挟まれたブロックを順に見る。区切りを 2 本ずつ
  // 消費すると、本文中の水平線が frontmatter の開始行と対になって食い違う（前置きに
  // `---` を書く writer の戻り値で実際に起きた）。1 本ずつ進めて name: を持つ最初の
  // ブロックを採る。
  const delims = []
  all.forEach((l, i) => {
    if (l.trim() === '---') delims.push(i)
  })
  let lines = null
  for (let a = 0; a < delims.length - 1 && !lines; a++) {
    const block = all.slice(delims[a] + 1, delims[a + 1])
    if (block.some((l) => /^name:/.test(l))) lines = block
  }
  if (!lines) return null
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
  architecture,
  workflow_script: workflowScript,
  script_review: scriptReview,
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
