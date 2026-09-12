export const meta = {
  name: 'pdca-do-check',
  description:
    'PDCA の Do/Check 区間（成果物の作成 → 対制御条件で反復実行 → 独立検証 → 機序分析 → 較正）を決定的に実行する',
  phases: [
    { title: 'Build', detail: 'Plan の実行計画どおりに作り、測定点を埋め込む（作った物は別 agent が measurement 契約と照合する）' },
    { title: 'Measure', detail: '条件×反復ごとに実行し、視点の異なる複数の検証者が自己申告を使わず検証する' },
    { title: 'Analyze', detail: '結果差の機序を独立した 2 名が出し、突き合わせの帰結を script が決める' },
  ],
}

// MIN_RUNS_FOR_MECHANISM: 機序を「特定した」と言うために条件あたり最低限必要な反復数。
// 実行の非決定性がある以上、1〜2 回の差は揺らぎと区別できない。3 は最小の再現確認
// （1 回目=観測 / 2 回目=再現 / 3 回目=揺らぎ幅の把握）に対応する下限。
const MIN_RUNS_FOR_MECHANISM = 3

// MIN_RUNS_FOR_SUGGESTIVE: 「示唆的」と言える下限。同条件を 2 回引いて同じ向きに出て
// いなければ、単発の観測と区別できない。
const MIN_RUNS_FOR_SUGGESTIVE = 2

// MAX_RUNS_PER_CONDITION: 1 回の Do/Check で条件あたりに許す反復上限。これを超える精度が
// 要るなら 1 周のコストではなく Plan（測定設計）の問題なので、境界で人間に返す。
const MAX_RUNS_PER_CONDITION = 10

// MAX_CONDITIONS: 対制御は「何を固定し何を変えるか」を保てる範囲でしか成立しない。
// 条件が増えるほど固定側が崩れるため、上限で止めて Plan に差し戻す。
const MAX_CONDITIONS = 6

// DEFAULT_MAX_CYCLES: 周回の backstop。較正された停止条件ではない — 正常なループは
// 乾き（新 identified 機序ゼロ）・前提崩れ・予算のどれかで先に止まり、ここには当たらない。
// 当たった場合は「backstop 停止」であって「十分に回した」ではない。args.maxCycles で上書き可。
const DEFAULT_MAX_CYCLES = 5

// MAX_BUILD_REVISIONS: build-verifier の findings を受けて builder が作り直せる回数。
// 2 回直して契約を満たさない harness は、Plan の measurement 自体が作れない要求に
// なっている可能性が高く、run を発行しても測れない。境界で止めて Plan に戻す。
const MAX_BUILD_REVISIONS = 2

// VERIFY_LENSES: 1 run に当てる検証の視点。1 人に全部見せると、その 1 人が持っていない
// 失敗様式が素通りする。criteria=基準充足、authenticity=run が主張どおり実行されたか、
// contract=書かれた検証が実施されたか。score を返すのは criteria だけ（3 者が別々に点を
// 付けると、どれを成績に使うかという裁量が生まれる）。
const VERIFY_LENSES = ['criteria', 'authenticity', 'contract']

// FULL_LENS_RUN_BUDGET: 全 run に 3 レンズを当てるのは run 数 × 3 の agent になる。
// 発行 run がこれを超えたら、authenticity / contract は各条件の先頭 run だけに絞る
// （条件ごとに最低 1 本は真正性と契約実施が見られる状態を保ちつつ、総数を線形に抑える）。
// 6 は「2 条件 × 3 反復」= 機序を主張できる最小構成がちょうど収まる値。
const FULL_LENS_RUN_BUDGET = 6

// MECHANISM_ANALYSTS: 独立に機序を出す分析者の数。**2 で固定**で、可変にしていない
// （下の突き合わせは A/B の 1 対 1 対応として定義されており、3 以上では未定義）。2 なのは、
// 片方だけが言った機序を「単独出所」として区別できる最小構成だから。3 以上にすると多数決を
// 持ち込むことになり、「2 人が見落とした欠陥を 1 人が見つけた」場合を捨てる規則が要る。
const MECHANISM_ANALYSTS = 2
const ANALYST_SEATS = ['A', 'B']

const RUN_RECORD_SCHEMA = {
  type: 'object',
  required: ['condition_id', 'run_index', 'executed', 'observations'],
  properties: {
    condition_id: { type: 'string' },
    run_index: { type: 'number' },
    executed: { type: 'boolean' },
    observations: { type: 'string' },
    raw_measurements: { type: 'string' },
    cost: { type: 'string' },
    anomalies: { type: 'array', items: { type: 'string' } },
  },
}

// verifier は「測れたか」を明示的に返す。測れなかった run を 0 点として混ぜると、欠測が
// 実測の劣位に化ける。score は measured=true のときだけ意味を持つ契約。
const VERIFY_SCHEMA = {
  type: 'object',
  required: ['condition_id', 'run_index', 'measured', 'criteria_checks'],
  properties: {
    condition_id: { type: 'string' },
    run_index: { type: 'number' },
    lens: { type: 'string' },
    measured: { type: 'boolean' },
    refs: { type: 'array', items: { type: 'number' } },
    why_resolution_insufficient: { type: 'string' },
    unmeasured_reason: { type: 'string' },
    score: { type: 'number' },
    criteria_checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['criterion', 'met', 'evidence'],
        properties: {
          criterion: { type: 'string' },
          met: { type: 'boolean' },
          evidence: { type: 'string' },
        },
      },
    },
    failure_mechanism_hint: { type: 'string' },
    self_report_used: { type: 'boolean' },
  },
}

const MECHANISM_SCHEMA = {
  type: 'object',
  required: ['mechanisms', 'criteria_validity', 'unmeasured', 'gap'],
  properties: {
    mechanisms: {
      type: 'array',
      items: {
        type: 'object',
        required: ['statement', 'evidence', 'alternative_explanations', 'identified'],
        properties: {
          statement: { type: 'string' },
          evidence: { type: 'string' },
          alternative_explanations: { type: 'array', items: { type: 'string' } },
          identified: { type: 'boolean' },
          new: { type: 'boolean' },
          premise_defect: { type: 'boolean' },
        },
      },
    },
    criteria_validity: { type: 'string' },
    unmeasured: { type: 'array', items: { type: 'string' } },
    gap: { type: 'string' },
  },
}

const BUILD_SCHEMA = {
  type: 'object',
  required: ['artifacts', 'measurement_points'],
  properties: {
    artifacts: { type: 'array', items: { type: 'string' } },
    measurement_points: { type: 'array', items: { type: 'string' } },
    shared_state_warnings: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const BUILD_REVIEW_SCHEMA = {
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
          what_would_make_it_measurable: { type: 'string' },
          refs: { type: 'array', items: { type: 'number' } },
          why_resolution_insufficient: { type: 'string' },
        },
      },
    },
    non_findings: { type: 'array', items: { type: 'string' } },
  },
}

// arbiter が返せるのは index の対応だけ。文言を返せるようにすると、統合の過程で
// どちらの analyst も観測していない機序が生まれる経路ができる。
const ARBITER_SCHEMA = {
  type: 'object',
  required: ['pairs'],
  properties: {
    pairs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['a', 'b'],
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
          why_same: { type: 'string' },
        },
      },
    },
    unpaired_a: { type: 'array', items: { type: 'number' } },
    unpaired_b: { type: 'array', items: { type: 'number' } },
  },
}

const parsedArgs = (typeof args === 'string' ? JSON.parse(args) : args) || {}

// workflow script は自身の位置を解決できないので、agents/*.md を Read させる基準パスは
// 呼び出し側から受け取るしかない。
const SKILL_DIR = parsedArgs.skillDir
if (!SKILL_DIR) {
  throw new Error('args.skillDir が未指定です。SKILL.md の Workflow 呼び出し例に従ってください。')
}

const plan = parsedArgs.plan
if (!plan || !String(plan).trim()) {
  throw new Error('args.plan が空です。pdca-plan.js の返り値 `plan` の全文を渡してください。')
}

// 成功基準を Plan と別フィールドで受け取るのは、verifier に「基準だけ」を見せるため。
// Plan 全体を渡すと、採用案の期待や機序の記述が採点に混入する。
const sc = parsedArgs.successCriteria
if (
  !sc ||
  typeof sc !== 'object' ||
  !String(sc.text || '').trim() ||
  !String(sc.metric || '').trim() ||
  typeof sc.higher_is_better !== 'boolean'
) {
  throw new Error(
    'args.successCriteria は { text, metric, higher_is_better } の形で渡してください。' +
      'text = 実行前に固定した成功基準、metric = verifier が score に入れる指標名、' +
      'higher_is_better = その指標は大きいほど良いか。向きが無いと delta の符号から優劣を読めません。'
  )
}
const successCriteria = `${sc.text}\n[METRIC]: ${sc.metric}（${sc.higher_is_better ? '大きいほど良い' : '小さいほど良い'}）`

const rawConditions = Array.isArray(parsedArgs.conditions) ? parsedArgs.conditions : []
const conditions = rawConditions.length
  ? rawConditions
  : [{ id: 'single', label: '単一条件', spec: '対制御なし（Plan の実行計画そのまま）' }]

if (conditions.length > MAX_CONDITIONS) {
  return {
    status: 'BLOCKED',
    reason: `条件が ${conditions.length} 本あり上限 ${MAX_CONDITIONS} を超えています。`,
    evidence:
      '条件が増えるほど「何を固定しているか」が保てなくなり、差の帰属先が特定できません。' +
      'Plan の測定設計に戻り、比べたい差を絞ってください。',
  }
}

const runsPerCondition = Math.min(
  Math.max(Number(parsedArgs.runsPerCondition) || 1, 1),
  MAX_RUNS_PER_CONDITION
)

const fixed = parsedArgs.fixed || '(固定条件の指定なし)'
const budget = parsedArgs.budget || null
const budgetText = budget ? (typeof budget === 'string' ? budget : JSON.stringify(budget)) : '(予算の指定なし)'
const revisionDiffs = Array.isArray(parsedArgs.revisionDiffs) ? parsedArgs.revisionDiffs : []
const cycle = Math.max(Number(parsedArgs.cycle) || 1, 1)
const MAX_CYCLES = Math.max(Number(parsedArgs.maxCycles) || DEFAULT_MAX_CYCLES, 1)
// previous は「前周の返り値をそのまま」受け取り、script 側でパスを解決する。呼び出し側に
// 平坦化を要求すると、片方だけ合わせた部分適用で mechanisms が silent drop する。
const previousRaw = parsedArgs.previous || null
const previous = previousRaw
  ? {
      artifacts: previousRaw.artifacts ?? (previousRaw.do && previousRaw.do.artifacts) ?? null,
      mechanisms:
        previousRaw.mechanisms ?? (previousRaw.check && previousRaw.check.mechanisms) ?? null,
      cycle: previousRaw.cycle ?? null,
    }
  : null

if (cycle > MAX_CYCLES) {
  return {
    status: 'BLOCKED',
    reason: `周回 ${cycle} は backstop（maxCycles=${MAX_CYCLES}）を超えています。`,
    evidence: '差分の積み重ねで届かない段階です。Plan の目標・基準に戻って決め直してください。',
  }
}

// revise は「前周の成果物と結果を土台に差分だけ変えて再測定する」こと。前周が渡されていなければ
// builder はゼロから作り直すことになり、差分の効果を測ったことにならない。
if (previous && previous.cycle !== null && cycle !== previous.cycle + 1) {
  return {
    status: 'BLOCKED',
    reason: `args.cycle=${cycle} が previous.cycle=${previous.cycle} と整合しません（期待値 ${previous.cycle + 1}）。`,
    evidence: '周回の申告ミスは上限判定と較正表示を狂わせます。cycle を前周の返り値 +1 にしてください。',
  }
}

if (revisionDiffs.length && (!previous || !Array.isArray(previous.artifacts))) {
  return {
    status: 'BLOCKED',
    reason: 'revisionDiffs が指定されていますが previous（前周の返り値）がありません。',
    evidence: '前周の artifacts / runs / mechanisms を args.previous に渡してください。無ければ revise ではなく新規の周です。',
  }
}
if (revisionDiffs.length > 3) {
  return {
    status: 'BLOCKED',
    reason: `revisionDiffs が ${revisionDiffs.length} 点あります（上限 3）。`,
    evidence: '差分が多いと次の Check でどれが効いたか分離できません。機序に対応する 3 点以内に絞ってください。',
  }
}

const requestedRuns = Number(parsedArgs.runsPerCondition) || 1
const truncations = []
if (requestedRuns > MAX_RUNS_PER_CONDITION) {
  truncations.push(`runsPerCondition ${requestedRuns} → ${MAX_RUNS_PER_CONDITION} に切り詰め`)
}
const maxRuns = budget && typeof budget === 'object' ? Number(budget.maxRuns) || null : null

// ledger は「この run で今までに何が決まったか」。省略時は空（初周・既存 caller の互換）。
// 中身は scripts/ledger.py read の出力をそのまま渡す。書くのはこの script で、agent は読むだけ。
const ledger = Array.isArray(parsedArgs.ledger) ? parsedArgs.ledger : []
const ledgerEntries = []
const resolvedSeqs = ledger.filter((e) => e.type === 'resolution').map((e) => e.seq)

// verifier には裁定と findings だけを見せ、do_run / check（前周の score）は渡さない。
const VERIFIER_LEDGER_TYPES = ['resolution', 'review_v']

function ledgerText(types) {
  const visible = types ? ledger.filter((e) => types.includes(e.type)) : ledger
  if (!visible.length) return '[LEDGER]: (この run ではまだ記録がありません)'
  return `[LEDGER]（読んでから書くこと。裁定済み（type: resolution）の論点を再提起するなら、その seq を refs に入れ、why_resolution_insufficient を書く）:\n${JSON.stringify(visible, null, 2)}`
}

function record(type, phaseName, summary, payload, refs) {
  ledgerEntries.push({ type, phase: phaseName, summary, payload: payload || {}, refs: refs || [] })
}

// 参照の無い再提起はラベルを付けるだけで、落とさず severity も下げない。自動で消す経路は
// 「生成物への異論を生成側の都合で消せる」構図になり、生成と検証の不変条件に反する。
function labelRelitigation(findings) {
  return (findings || []).map((f) => ({
    ...f,
    relitigated_without_reference:
      resolvedSeqs.length > 0 &&
      !(Array.isArray(f.refs) && f.refs.some((r) => resolvedSeqs.includes(r))) &&
      !String(f.why_resolution_insufficient || '').trim(),
  }))
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

// ------------------------------------------------------------------ Build

phase('Build')

// builder → build-verifier の until-pass ループ。run は 1 本ごとに予算を食うので、
// 測定点が Plan の契約を満たしていない harness で全 run を回すのが最も高くつく失敗になる。
// 作った本人が「測れる」と宣言して先へ進む経路をここで塞ぐ。
let build = null
let buildReview = null
const buildAttempts = []

for (let attempt = 0; attempt <= MAX_BUILD_REVISIONS; attempt++) {
  build = await roleAgent(
    'builder.md',
    [
      `[PLAN]:\n${plan}`,
      `[FIXED_ACROSS_CONDITIONS]:\n${fixed}`,
      `[CONDITIONS]:\n${JSON.stringify(conditions, null, 2)}`,
      ledgerText(),
      revisionDiffs.length
        ? `[REVISION_DIFFS]（前周の機序に対応する差分。これ以外を変更しないこと）:\n${revisionDiffs
            .map((d, i) => `${i + 1}. ${d}`)
            .join('\n')}`
        : '',
      previous
        ? `[PREVIOUS_ARTIFACTS]（前周の成果物。これを土台にし、REVISION_DIFFS 以外は変えない）:\n${previous.artifacts.join('\n')}`
        : '',
      previous && previous.mechanisms
        ? `[PREVIOUS_MECHANISMS]:\n${JSON.stringify(previous.mechanisms, null, 2)}`
        : '',
      buildReview
        ? `[BUILD_FINDINGS]（前回の成果物への照合結果。blocker/major は全件解消すること）:\n${JSON.stringify(buildReview.findings, null, 2)}`
        : '',
      '成果物を作り、Plan の測定方法が測れるよう測定点を埋め込むこと。' +
        '採点はしない（採点は別 agent の仕事で、作った本人の自己申告は使わない）。',
    ]
      .filter(Boolean)
      .join('\n\n'),
    { model: 'opus', phase: 'Build', label: `builder#${attempt + 1}`, schema: BUILD_SCHEMA }
  )

  if (!build) {
    return {
      status: 'BLOCKED',
      reason: 'builder が結果を返しませんでした。',
      evidence: '停止または API エラーの可能性があります。成果物が無い状態で測定へ進めません。',
      ledger_entries: ledgerEntries,
    }
  }

  log(`成果物 ${build.artifacts.length} 件 / 測定点 ${build.measurement_points.length} 件`)
  if (build.shared_state_warnings && build.shared_state_warnings.length) {
    log(`条件間で共有される恐れのある状態: ${build.shared_state_warnings.join(' / ')}`)
  }
  record('build', 'Build', `成果物 ${build.artifacts.length} 件 / 測定点 ${build.measurement_points.length} 件（${attempt + 1} 回目）`, {
    attempt: attempt + 1,
    artifacts: build.artifacts,
    measurement_points: build.measurement_points,
    shared_state_warnings: build.shared_state_warnings || [],
  })

  buildReview = await roleAgent(
    'build-verifier.md',
    [
      `[PLAN_MEASUREMENT]:\n${plan}`,
      `[SUCCESS_CRITERIA]:\n${successCriteria}`,
      `[CONDITIONS]:\n${JSON.stringify(conditions, null, 2)}`,
      `[ARTIFACTS]:\n${build.artifacts.join('\n')}`,
      `[MEASUREMENT_POINTS]:\n${build.measurement_points.join('\n')}`,
      `[SHARED_STATE_WARNINGS]:\n${(build.shared_state_warnings || []).join('\n') || '(申告なし)'}`,
      revisionDiffs.length
        ? `[REVISION_DIFFS]:\n${revisionDiffs.map((d, i) => `${i + 1}. ${d}`).join('\n')}`
        : '',
      ledgerText(),
      '成果物を自分で開いて、この harness で successCriteria が測れるかを照合すること。直さないこと。',
    ]
      .filter(Boolean)
      .join('\n\n'),
    { model: 'opus', phase: 'Build', label: `build-verify#${attempt + 1}`, schema: BUILD_REVIEW_SCHEMA }
  )

  if (!buildReview) {
    return {
      status: 'BLOCKED',
      reason: 'build-verifier が結果を返しませんでした。',
      evidence:
        '成果物が measurement 契約を満たすか未確認のまま run を発行すると、測れない harness で予算を使い切ります。',
      ledger_entries: ledgerEntries,
    }
  }

  buildReview.findings = labelRelitigation(buildReview.findings)
  const hardBuild = buildReview.findings.filter((f) => f.severity !== 'minor')
  buildAttempts.push({ attempt: attempt + 1, verdict: buildReview.verdict, blockers_majors: hardBuild.length })
  log(`成果物の照合 ${attempt + 1} 回目: ${buildReview.verdict}（blocker/major ${hardBuild.length} 件）`)
  record('build_review', 'Build', `build-verifier ${attempt + 1} 回目: ${buildReview.verdict}（blocker/major ${hardBuild.length} 件）`, {
    verdict: buildReview.verdict,
    findings: buildReview.findings,
  })

  if (buildReview.verdict === 'pass' && hardBuild.length === 0) break

  if (attempt === MAX_BUILD_REVISIONS) {
    return {
      status: 'BLOCKED',
      reason: `成果物が ${MAX_BUILD_REVISIONS + 1} 回の照合で measurement 契約を満たしませんでした。`,
      evidence: JSON.stringify(buildReview.findings.filter((f) => f.severity !== 'minor'), null, 2),
      build_attempts: buildAttempts,
      ledger_entries: ledgerEntries,
    }
  }
}

// ------------------------------------------------------------------ Measure

phase('Measure')

// run 単位に展開してから 1 本の pipeline に流す。runner→verifier は run ごとに独立で、
// 次のステージが他 run を横断して見る必要が無いので barrier は要らない。
// 小さい agent への fan-out にしてあるのは、中断時に完了済みの run が残るため。
const runUnits = []
for (const cond of conditions) {
  for (let i = 1; i <= runsPerCondition; i++) {
    runUnits.push({ cond, index: i })
  }
}

for (const t of truncations) log(`上限により切り詰め: ${t}`)
if (maxRuns !== null && runUnits.length > maxRuns) {
  return {
    status: 'BLOCKED',
    reason: `発行予定 ${runUnits.length} run が budget.maxRuns=${maxRuns} を超えています。`,
    evidence: 'Plan の停止条件（予算）に当たります。条件数か反復数を減らすか、予算を更新して再実行してください。',
  }
}
log(`周回 ${cycle}/${MAX_CYCLES} / 条件 ${conditions.length} × 反復 ${runsPerCondition} = ${runUnits.length} run を実行します`)

// レンズの縮退: 全 run に 3 レンズを当てると agent 数が run × 3 になる。発行 run が
// FULL_LENS_RUN_BUDGET を超えたら、authenticity / contract は各条件の先頭 run だけに絞る。
// 条件ごとに最低 1 本は真正性と契約実施が見られる状態は保つ。落としたことは黙らせない。
const lensDegraded = runUnits.length > FULL_LENS_RUN_BUDGET
function lensesFor(unit) {
  if (!lensDegraded || unit.index === 1) return VERIFY_LENSES
  return ['criteria']
}
if (lensDegraded) {
  const note = `発行 ${runUnits.length} run が ${FULL_LENS_RUN_BUDGET} を超えたため、authenticity / contract レンズは各条件の 1 run 目のみに縮退`
  truncations.push(note)
  log(`上限により縮退: ${note}`)
}

const measured = await pipeline(runUnits, async (unit) => {
  const tag = `${unit.cond.id}#${unit.index}`

  const record = await roleAgent(
    'runner.md',
    [
      `[PLAN]:\n${plan}`,
      `[FIXED_ACROSS_CONDITIONS]:\n${fixed}`,
      `[CONDITION]:\n${JSON.stringify(unit.cond, null, 2)}`,
      `[ARTIFACTS]:\n${build.artifacts.join('\n')}`,
      `[MEASUREMENT_POINTS]:\n${build.measurement_points.join('\n')}`,
      `[RUN_INDEX]: ${unit.index}`,
      `[BUDGET]: ${budgetText}`,
      'この条件だけを実行し、観測した事実を記録すること。' +
        '他の条件の実行結果・session・cache・作業ディレクトリを参照しないこと。' +
        '条件間で状態が漏れると、測っている差が条件の差ではなくなる。' +
        '成否の判定は書かない（判定は別 agent が行う）。',
    ].join('\n\n'),
    // 条件間の状態遮断は文言でなく worktree で切る。run ごとに独立した作業ツリーを持つので、
    // 条件 A が書き換えたファイルを条件 B が読む経路が構造上無い（リポジトリ外の状態は対象外。
    // その場合 builder の shared_state_warnings で可視化する）。
    { model: 'sonnet', phase: 'Measure', label: `run ${tag}`, schema: RUN_RECORD_SCHEMA, isolation: 'worktree' }
  )

  if (!record) return null

  // verifier には Plan ではなく successCriteria と観測記録だけを渡す。採用案への期待が
  // 見えていると、期待に沿う読み方で採点できてしまう。レンズごとに別の agent が立つので、
  // 1 人が持っていない失敗様式（実行の真正性・契約検証の未実施）が素通りしない。
  const lenses = lensesFor(unit)
  const lensPrompt = {
    criteria: '成功基準を満たしたかを判定し、[METRIC] の実測値を score に入れること。',
    authenticity:
      'この run が主張どおりに実行されたかだけを判定すること。成果物・ログ・生の測定値・条件 id の' +
      '辻褄が合わない、別条件の産物が混ざっている、実行の痕跡が無い場合は measured=false。score は返さない。',
    contract:
      '[SUCCESS_CRITERIA] に宣言された検証（突合・照合・再取得）が実施されたかだけを判定すること。' +
      '実施の痕跡が無い検査を met=true にしない。score は返さない。',
  }

  const rawVerdicts = await parallel(
    lenses.map((lens) => () =>
      roleAgent(
          'verifier.md',
          [
            `[SUCCESS_CRITERIA]:\n${successCriteria}`,
            `[LENS]: ${lens}`,
            `[CONDITION_ID]: ${unit.cond.id}`,
            `[RUN_INDEX]: ${unit.index}`,
            `[ARTIFACTS]:\n${build.artifacts.join('\n')}`,
            `[RUN_OBSERVATIONS]:\n${record.observations}`,
            `[RAW_MEASUREMENTS]:\n${record.raw_measurements || '(なし)'}`,
            `[ANOMALIES]:\n${(record.anomalies || []).join('\n') || '(なし)'}`,
            // verifier に見せる ledger は resolution / review_v だけ。do_run / check には
            // 前周の score が載っており、見えていると期待に沿う読み方で採点できてしまう
            // （verifier に Plan を見せないのと同じ理由を、別経路で塞ぐ）。
            ledgerText(VERIFIER_LEDGER_TYPES),
            lensPrompt[lens],
            '成果物と測定点を自分で確かめること。実行側の「できた」という申告は根拠にしない。' +
              '確かめられなかった場合は measured=false と理由を返し、score を推定で埋めないこと。' +
              '欠測を 0 点として混ぜると、測れなかったことが実測の劣位に化ける。',
          ].join('\n\n'),
        { model: 'sonnet', phase: 'Measure', label: `verify ${tag} [${lens}]`, schema: VERIFY_SCHEMA }
      )
    )
  )

  // レンズの帰属は dispatch 側が持つ。agent の自己申告（返り値の lens）に任せると、
  // 申告漏れや取り違えで authenticity の返り値が criteria として扱われ、score の無い判定が
  // 成績の位置に入る（結果は「measured だが score 欠落」という、正直な欠測に見える消え方）。
  // filter の前に zip するのは、1 本が null を返した時点で位置の対応が壊れるため。
  const verdicts = lenses
    .map((lens, i) => (rawVerdicts[i] ? { ...rawVerdicts[i], lens } : null))
    .filter(Boolean)

  if (!verdicts.length) return null

  // 集計は script の算術。measured は適用した全レンズの一致（過半数ではない —
  // レンズは別々の失敗様式を見ているので、多数決は「2 人が見ていない欠陥を 1 人が
  // 見つけた」ケースを捨てる）。score は criteria レンズの値だけを使う。
  const byLens = {}
  for (const v of verdicts) byLens[v.lens] = v
  // criteria レンズが落ちた run は「測れた」と言えない。他レンズの返り値を代わりに使うと、
  // score を返さない契約の判定が成績の位置に入る。
  const criteriaVerdict = byLens.criteria || null
  const appliedLenses = verdicts.map((v) => v.lens)
  const dissenting = verdicts.filter((v) => v.measured !== true)
  const measuredAll = !!criteriaVerdict && verdicts.every((v) => v.measured === true)

  const verdict = {
    condition_id: unit.cond.id,
    run_index: unit.index,
    measured: measuredAll,
    unmeasured_reason: measuredAll
      ? undefined
      : [
          criteriaVerdict ? '' : 'criteria: このレンズの検証が返らなかった（score の出所が無い）',
          ...dissenting.map(
            (v) => `${v.lens}: ${v.unmeasured_reason || '(理由の記載なし)'}`
          ),
        ]
          .filter(Boolean)
          .join(' / '),
    score: measuredAll ? criteriaVerdict.score : undefined,
    criteria_checks: verdicts.flatMap((v) =>
      (v.criteria_checks || []).map((c) => ({ ...c, lens: v.lens }))
    ),
    failure_mechanism_hint: verdicts
      .map((v) => v.failure_mechanism_hint)
      .filter(Boolean)
      .join(' / '),
    self_report_used: verdicts.some((v) => v.self_report_used === true),
    lenses_applied: appliedLenses,
    // レンズ間で判定が割れた事実は、平均に丸めず残す。割れたこと自体が測定設計の情報。
    lens_disagreement:
      dissenting.length > 0 && dissenting.length < verdicts.length
        ? verdicts.map((v) => ({ lens: v.lens, measured: v.measured === true }))
        : null,
    relitigated_without_reference: labelRelitigation(verdicts).some(
      (v) => v.relitigated_without_reference
    ),
  }

  return { condition: unit.cond, index: unit.index, record, verdict, lens_verdicts: verdicts }
})

const results = measured.filter(Boolean)

if (!results.length) {
  return {
    status: 'BLOCKED',
    reason: '検証済みの run が 1 件もありません。',
    evidence: `発行 ${runUnits.length} run。停止・API エラー・実行不能のいずれかです。`,
    ledger_entries: ledgerEntries,
  }
}

// ------------------------------------------------------------------ 集計（script の算術）

function mean(nums) {
  if (!nums.length) return null
  let sum = 0
  for (const n of nums) sum += n
  return sum / nums.length
}

function spread(nums) {
  if (nums.length < 2) return null
  let min = nums[0]
  let max = nums[0]
  for (const n of nums) {
    if (n < min) min = n
    if (n > max) max = n
  }
  return max - min
}

const perCondition = conditions.map((cond) => {
  const mine = results.filter((r) => r.condition.id === cond.id)
  const ok = mine.filter((r) => r.verdict.measured === true && typeof r.verdict.score === 'number')
  // measured=true なのに score が無い run は「測れた」とも「測れなかった」とも言えない。
  // どちらにも入れず消すと n が黙って減るので、別枠で数えて理由を出す。
  const unscored = mine.filter((r) => r.verdict.measured === true && typeof r.verdict.score !== 'number')
  const scores = ok.map((r) => r.verdict.score)
  return {
    condition_id: cond.id,
    label: cond.label || cond.id,
    issued: runsPerCondition,
    returned: mine.length,
    measured_n: ok.length,
    // 欠測は成績に混ぜず別カウントで持つ。
    unmeasured: mine.filter((r) => r.verdict.measured !== true).map((r) => ({
      run_index: r.index,
      reason: r.verdict.unmeasured_reason || '(理由の記載なし)',
    })),
    unscored: unscored.map((r) => ({ run_index: r.index, reason: 'measured=true だが score が数値で返っていない' })),
    mean_score: mean(scores),
    spread: spread(scores),
    self_report_used: ok.some((r) => r.verdict.self_report_used === true),
    // レンズ間で measured が割れた run。成績には出ないが、割れたこと自体が測定設計の情報。
    lens_disagreements: mine
      .filter((r) => r.verdict.lens_disagreement)
      .map((r) => ({ run_index: r.index, lenses: r.verdict.lens_disagreement })),
  }
})

for (const r of results) {
  record('do_run', 'Measure', `${r.condition.id}#${r.index}: ${r.verdict.measured ? `score=${r.verdict.score}` : '未測定'}`, {
    condition_id: r.condition.id,
    run_index: r.index,
    measured: r.verdict.measured,
    score: r.verdict.score ?? null,
    lenses_applied: r.verdict.lenses_applied,
    lens_disagreement: r.verdict.lens_disagreement,
    unmeasured_reason: r.verdict.unmeasured_reason || null,
  })
}

for (const c of perCondition) {
  if (c.returned < c.issued) {
    log(`${c.condition_id}: ${c.issued} run 発行のうち ${c.returned} run のみ完走`)
  }
  if (c.unmeasured.length) {
    log(`${c.condition_id}: 測定できなかった run ${c.unmeasured.length} 件（成績に混ぜていません）`)
  }
  if (c.unscored.length) {
    log(`${c.condition_id}: 測定済みだが score 欠落の run ${c.unscored.length} 件（成績に混ぜていません）`)
  }
  if (c.lens_disagreements.length) {
    log(`${c.condition_id}: 検証レンズ間で判定が割れた run ${c.lens_disagreements.length} 件`)
  }
}

// delta は 2 条件かつ両側に実測がある場合だけ数値になる。片側が欠測なら 0 ではなく null。
// 0 は「実測で引き分け」を意味する値なので、測れていない状態に使うと嘘になる。
let delta = null
let favored = null
let deltaBasis = '対制御なし（単一条件）'
if (perCondition.length === 2) {
  const [a, b] = perCondition
  if (a.measured_n > 0 && b.measured_n > 0) {
    delta = b.mean_score - a.mean_score
    // 符号の解釈は successCriteria.higher_is_better から機械的に決める。
    if (delta === 0) favored = 'tie'
    else favored = (delta > 0) === sc.higher_is_better ? b.condition_id : a.condition_id
    deltaBasis = `${b.condition_id} - ${a.condition_id}（metric=${sc.metric}、${sc.higher_is_better ? '大きいほど良い' : '小さいほど良い'}、n=${a.measured_n} / ${b.measured_n}）`
  } else {
    deltaBasis = '片側以上が未測定のため delta は null（引き分けではない）'
  }
} else if (perCondition.length > 2) {
  deltaBasis = '3 条件以上のため 1 つの delta には縮約していない（条件ごとの mean_score を見る）'
}

// ------------------------------------------------------------------ Analyze

phase('Analyze')

// 機序分析は builder と別 agent・別モデル系統で行う。作った本人は自分の設計意図を
// 機序として書きやすく、実際に起きたことと区別がつかなくなる。
// さらに MECHANISM_ANALYSTS 名が互いの出力を見ないまま独立に立つ。1 人だけが言った機序を
// 「単独出所」として区別できないと、1 人の思い込みが identified として次の周の差分を決める。
const analystPrompt = (seat) =>
  [
    `[SUCCESS_CRITERIA]:\n${successCriteria}`,
    `[PER_CONDITION_STATS]:\n${JSON.stringify(perCondition, null, 2)}`,
    `[DELTA]: ${delta === null ? 'null' : delta} （${deltaBasis}。favored=${favored}）`,
    `[RUN_DETAILS]:\n${JSON.stringify(
      results.map((r) => ({
        condition_id: r.condition.id,
        run_index: r.index,
        observations: r.record.observations,
        anomalies: r.record.anomalies || [],
        measured: r.verdict.measured,
        criteria_checks: r.verdict.criteria_checks,
        lenses_applied: r.verdict.lenses_applied,
        lens_disagreement: r.verdict.lens_disagreement,
        failure_mechanism_hint: r.verdict.failure_mechanism_hint || null,
      })),
      null,
      2
    )}`,
    previous && previous.mechanisms
      ? `[PREVIOUS_MECHANISMS]（前周までに挙がった機序。novelty 判定に使う）:\n${JSON.stringify(previous.mechanisms, null, 2)}`
      : '[PREVIOUS_MECHANISMS]: (初周のため無し。全機序が new: true)',
    ledgerText(),
    `[SEAT]: ${seat}（同じ入力で別の分析者が独立に立っている。相手の出力は渡らないし、` +
      'あなたの出力も相手には渡らない。相手に寄せず、観測から独立に組み立てること）',
    '点数の要約ではなく、なぜその差が出たのかを述べること。' +
      '各機序に対して、それが外れる場合の別説明を必ず併記すること。' +
      '別説明を潰せていない機序は identified=false とすること。' +
      'さらに、測定指標がそもそも Plan の主張を捉えていたか（criteria_validity）と、' +
      '測れていないもの（unmeasured）を分けて返すこと。' +
      '各機序に new（この周で初めて立ったか）と、前提の不成立を示す場合は premise_defect を付けること。',
  ]
    .filter(Boolean)
    .join('\n\n')

const analyses = (
  await parallel(
    Array.from({ length: MECHANISM_ANALYSTS }, (_, i) => () =>
      roleAgent('mechanism-analyst.md', analystPrompt(ANALYST_SEATS[i]), {
        model: 'opus',
        phase: 'Analyze',
        label: `mechanism-analyst ${ANALYST_SEATS[i]}`,
        schema: MECHANISM_SCHEMA,
      })
    )
  )
).filter(Boolean)

if (!analyses.length) {
  return {
    status: 'BLOCKED',
    reason: '機序分析が返りませんでした。',
    evidence: `検証済み run は ${results.length} 件あります。点数だけで Act を決めると、` +
      '次の周の差分が機序に紐づかなくなります。',
    ledger_entries: ledgerEntries,
  }
}

// 突き合わせ: 対応付けは arbiter の判断（文の同一性を閾値で決めると、未較正の数値が
// 採否を左右する）。その帰結（identified を維持するか単独出所に落とすか）は script の規則。
// arbiter は index しか返せないので、どちらの analyst も出していない機序は入り込まない。
const primary = analyses[0]
const secondary = analyses.length > 1 ? analyses[1] : null
let mechanisms
let corroborationNote

if (!secondary) {
  // 片方が落ちた場合。独立の確認が取れていないので、identified は維持しない。
  mechanisms = (primary.mechanisms || []).map((m) => ({
    ...m,
    identified: false,
    corroboration: 'single_source',
  }))
  corroborationNote = '機序分析が 1 名しか返らなかったため、全機序を単独出所として identified: false に落としています'
} else {
  const pairing = await roleAgent(
    'mechanism-arbiter.md',
    [
      `[ANALYST_A_MECHANISMS]:\n${JSON.stringify(
        (primary.mechanisms || []).map((m, i) => ({ index: i, ...m })),
        null,
        2
      )}`,
      `[ANALYST_B_MECHANISMS]:\n${JSON.stringify(
        (secondary.mechanisms || []).map((m, i) => ({ index: i, ...m })),
        null,
        2
      )}`,
      '同じ因果を主張している組だけを index の対応として返すこと。迷ったら組にしないこと。',
    ].join('\n\n'),
    { model: 'opus', phase: 'Analyze', label: 'mechanism-arbiter', schema: ARBITER_SCHEMA }
  )

  const pairs = pairing ? pairing.pairs || [] : []
  const pairedA = new Map()
  const usedB = new Set()
  for (const p of pairs) {
    const a = (primary.mechanisms || [])[p.a]
    const b = (secondary.mechanisms || [])[p.b]
    // 範囲外の index と 1 対多の対応は採らない（対応が壊れると単独出所が格上げされる）。
    if (!a || !b || pairedA.has(p.a) || usedB.has(p.b)) continue
    pairedA.set(p.a, { b, why_same: p.why_same || '' })
    usedB.add(p.b)
  }

  mechanisms = []
  for (let i = 0; i < (primary.mechanisms || []).length; i++) {
    const m = primary.mechanisms[i]
    const match = pairedA.get(i)
    if (match) {
      mechanisms.push({
        ...m,
        // 両者が独立に同定したときだけ identified を維持する。
        identified: m.identified === true && match.b.identified === true,
        corroboration: 'corroborated',
        corroborated_by: match.b.statement,
        // new は片方でも「前周にあった」と言えば false（水増しを避ける方向に倒す）。
        new: m.new !== false && match.b.new !== false,
        premise_defect: m.premise_defect === true || match.b.premise_defect === true,
      })
    } else {
      mechanisms.push({ ...m, identified: false, corroboration: 'single_source' })
    }
  }
  for (let j = 0; j < (secondary.mechanisms || []).length; j++) {
    if (usedB.has(j)) continue
    mechanisms.push({ ...secondary.mechanisms[j], identified: false, corroboration: 'single_source' })
  }
  const corroborated = mechanisms.filter((m) => m.corroboration === 'corroborated').length
  corroborationNote = `機序 ${mechanisms.length} 件のうち ${corroborated} 件が 2 名の独立同定、残りは単独出所（identified: false に落としています）`
  if (!pairing) {
    corroborationNote += '。arbiter が返らなかったため対応は 0 件として扱っています'
  }
  log(corroborationNote)
}

// criteria_validity / unmeasured / gap は primary の判断を正とし、secondary の指摘は
// 捨てずに unmeasured へ足す（測れていないものの申告は、少ない方に合わせると見落とす）。
const analysis = {
  mechanisms,
  criteria_validity: secondary
    ? `${primary.criteria_validity}\n[別の分析者の判断]: ${secondary.criteria_validity}`
    : primary.criteria_validity,
  unmeasured: Array.from(
    new Set([...(primary.unmeasured || []), ...((secondary && secondary.unmeasured) || [])])
  ),
  gap: primary.gap || '',
}

// ------------------------------------------------------------------ 較正（script の算術）

const minMeasuredN = perCondition.reduce(
  (acc, c) => (acc === null ? c.measured_n : Math.min(acc, c.measured_n)),
  null
)
const identified = (analysis.mechanisms || []).some((m) => m.identified === true)
const selfReportContaminated = perCondition.some((c) => c.self_report_used)

let confidence
if (minMeasuredN === null || minMeasuredN < MIN_RUNS_FOR_SUGGESTIVE) {
  confidence = 'inconclusive'
} else if (
  identified &&
  minMeasuredN >= MIN_RUNS_FOR_MECHANISM &&
  !selfReportContaminated
) {
  confidence = 'mechanism_identified'
} else {
  confidence = 'suggestive'
}

const calibrationNotes = []
calibrationNotes.push(`各条件の実測 n の最小値: ${minMeasuredN}`)
if (minMeasuredN !== null && minMeasuredN < MIN_RUNS_FOR_MECHANISM) {
  calibrationNotes.push(
    `n < ${MIN_RUNS_FOR_MECHANISM} のため、機序が示されていても mechanism_identified には上げていません`
  )
}
if (selfReportContaminated) {
  calibrationNotes.push('verifier が自己申告を使ったと申告した run があるため確信度を下げています')
}
if (delta === null) {
  calibrationNotes.push('delta は null（測れていない）。0（引き分け）ではありません')
}
for (const t of truncations) calibrationNotes.push(`上限により切り詰め: ${t}`)
for (const c of perCondition) {
  if (c.unscored.length) calibrationNotes.push(`${c.condition_id}: score 欠落 ${c.unscored.length} 件は成績に含めていません`)
}
calibrationNotes.push(corroborationNote)
for (const c of perCondition) {
  if (c.lens_disagreements.length) {
    calibrationNotes.push(
      `${c.condition_id}: 検証レンズ間で判定が割れた run ${c.lens_disagreements.length} 件（measured は全レンズ一致のときのみ true）`
    )
  }
}
calibrationNotes.push(`周回 ${cycle}/${MAX_CYCLES}`)
for (const c of perCondition) {
  if (c.spread !== null) calibrationNotes.push(`${c.condition_id}: 実測のばらつき幅 ${c.spread}`)
}

const runTable = results.map((r) => ({
  condition: `${r.condition.id}: ${r.condition.label || ''}`.trim(),
  run: r.index,
  result: !r.verdict.measured
    ? `未測定（${r.verdict.unmeasured_reason || '理由の記載なし'}）`
    : typeof r.verdict.score === 'number'
      ? `score=${r.verdict.score}`
      : 'score 欠落（成績に含めていません）',
  cost: r.record.cost || '(記録なし)',
  failure_mechanism: r.verdict.failure_mechanism_hint || '(なし)',
}))

const newIdentified = (analysis.mechanisms || []).filter(
  (m) => m.identified === true && m.new !== false
).length

record('check', 'Analyze', `delta=${delta === null ? 'null' : delta} / confidence=${confidence} / 新しい identified 機序 ${newIdentified} 件`, {
  per_condition: perCondition,
  delta,
  delta_basis: deltaBasis,
  favored,
  mechanisms: analysis.mechanisms,
  criteria_validity: analysis.criteria_validity,
  confidence,
  new_identified_mechanisms: newIdentified,
})

return {
  status: 'ok',
  do: {
    artifacts: build.artifacts,
    measurement_points: build.measurement_points,
    runs: results.map((r) => ({
      condition_id: r.condition.id,
      run_index: r.index,
      observations: r.record.observations,
      cost: r.record.cost || null,
      anomalies: r.record.anomalies || [],
    })),
  },
  check: {
    results: { per_condition: perCondition, metric: sc.metric, higher_is_better: sc.higher_is_better, delta, delta_basis: deltaBasis, favored },
    gap: analysis.gap || '',
    mechanisms: analysis.mechanisms || [],
    criteria_validity: analysis.criteria_validity,
    unmeasured: analysis.unmeasured || [],
  },
  confidence,
  calibration_notes: calibrationNotes,
  runTable,
  cycle,
  max_cycles: MAX_CYCLES,
  build_review: buildReview,
  build_attempts: buildAttempts,
  // 台帳へ積む entry。司令塔が編集せず scripts/ledger.py append へ流す（agent には書かせない）。
  ledger_entries: ledgerEntries,
  // 乾き判定の材料（act-judge が使う）: この周で新しく特定された機序の数。
  // 単独出所の機序は identified: false なのでここに入らない（1 名しか言っていない機序を
  // 根拠に周回を重ねない）。
  new_identified_mechanisms: newIdentified,
  premise_defect_mechanisms: (analysis.mechanisms || []).filter(
    (m) => m.premise_defect === true
  ).length,
  truncations,
  revision_diffs_applied: revisionDiffs,
}