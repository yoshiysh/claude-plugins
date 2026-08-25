export const meta = {
  name: 'pdca-do-check',
  description:
    'PDCA の Do/Check 区間（成果物の作成 → 対制御条件で反復実行 → 独立検証 → 機序分析 → 較正）を決定的に実行する',
  phases: [
    { title: 'Build', detail: 'Plan の実行計画どおりに作り、測定点を埋め込む' },
    { title: 'Measure', detail: '条件×反復ごとに実行し、別 agent が自己申告を使わず検証する' },
    { title: 'Analyze', detail: '結果差の機序を builder とは別 agent が分析する' },
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
    measured: { type: 'boolean' },
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

const build = await roleAgent(
  'builder.md',
  [
    `[PLAN]:\n${plan}`,
    `[FIXED_ACROSS_CONDITIONS]:\n${fixed}`,
    `[CONDITIONS]:\n${JSON.stringify(conditions, null, 2)}`,
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
    '成果物を作り、Plan の測定方法が測れるよう測定点を埋め込むこと。' +
      '採点はしない（採点は別 agent の仕事で、作った本人の自己申告は使わない）。',
  ]
    .filter(Boolean)
    .join('\n\n'),
  { model: 'opus', phase: 'Build', label: 'builder', schema: BUILD_SCHEMA }
)

if (!build) {
  return {
    status: 'BLOCKED',
    reason: 'builder が結果を返しませんでした。',
    evidence: '停止または API エラーの可能性があります。成果物が無い状態で測定へ進めません。',
  }
}

log(`成果物 ${build.artifacts.length} 件 / 測定点 ${build.measurement_points.length} 件`)
if (build.shared_state_warnings && build.shared_state_warnings.length) {
  log(`条件間で共有される恐れのある状態: ${build.shared_state_warnings.join(' / ')}`)
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
  // 見えていると、期待に沿う読み方で採点できてしまう。
  const verdict = await roleAgent(
    'verifier.md',
    [
      `[SUCCESS_CRITERIA]:\n${successCriteria}`,
      `[CONDITION_ID]: ${unit.cond.id}`,
      `[RUN_INDEX]: ${unit.index}`,
      `[ARTIFACTS]:\n${build.artifacts.join('\n')}`,
      `[RUN_OBSERVATIONS]:\n${record.observations}`,
      `[RAW_MEASUREMENTS]:\n${record.raw_measurements || '(なし)'}`,
      '成果物と測定点を自分で確かめて採点すること。実行側の「できた」という申告は根拠にしない。' +
        '確かめられなかった場合は measured=false と理由を返し、score を推定で埋めないこと。' +
        '欠測を 0 点として混ぜると、測れなかったことが実測の劣位に化ける。',
    ].join('\n\n'),
    { model: 'sonnet', phase: 'Measure', label: `verify ${tag}`, schema: VERIFY_SCHEMA }
  )

  if (!verdict) return null

  return { condition: unit.cond, index: unit.index, record, verdict }
})

const results = measured.filter(Boolean)

if (!results.length) {
  return {
    status: 'BLOCKED',
    reason: '検証済みの run が 1 件もありません。',
    evidence: `発行 ${runUnits.length} run。停止・API エラー・実行不能のいずれかです。`,
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
  }
})

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
const analysis = await roleAgent(
  'mechanism-analyst.md',
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
        failure_mechanism_hint: r.verdict.failure_mechanism_hint || null,
      })),
      null,
      2
    )}`,
    previous && previous.mechanisms
      ? `[PREVIOUS_MECHANISMS]（前周までに挙がった機序。novelty 判定に使う）:\n${JSON.stringify(previous.mechanisms, null, 2)}`
      : '[PREVIOUS_MECHANISMS]: (初周のため無し。全機序が new: true)',
    '点数の要約ではなく、なぜその差が出たのかを述べること。' +
      '各機序に対して、それが外れる場合の別説明を必ず併記すること。' +
      '別説明を潰せていない機序は identified=false とすること。' +
      'さらに、測定指標がそもそも Plan の主張を捉えていたか（criteria_validity）と、' +
      '測れていないもの（unmeasured）を分けて返すこと。' +
      '各機序に new（この周で初めて立ったか）と、前提の不成立を示す場合は premise_defect を付けること。',
  ].join('\n\n'),
  { model: 'opus', phase: 'Analyze', label: 'mechanism-analyst', schema: MECHANISM_SCHEMA }
)

if (!analysis) {
  return {
    status: 'BLOCKED',
    reason: '機序分析が返りませんでした。',
    evidence: `検証済み run は ${results.length} 件あります。点数だけで Act を決めると、` +
      '次の周の差分が機序に紐づかなくなります。',
  }
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
  // 乾き判定の材料（act-judge が使う）: この周で新しく特定された機序の数。
  new_identified_mechanisms: (analysis.mechanisms || []).filter(
    (m) => m.identified === true && m.new !== false
  ).length,
  premise_defect_mechanisms: (analysis.mechanisms || []).filter(
    (m) => m.premise_defect === true
  ).length,
  truncations,
  revision_diffs_applied: revisionDiffs,
}