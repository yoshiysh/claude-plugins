// 全文レビューの段のテスト（設計 docs/design/coverage-ledger-method.md の決定 17）。
// 設計の箇所: 段の構成の「全文レビュー（ファイルの段より先に読む）」、台帳と見たの記録の B1、全体の段と確認（意図の表・確認・独立）、
// 再レビューと持ち越し（持ち越せる条件・指摘の出どころの分類）、完了と止める条件、モデルと費用（起動の原則・初期値の決め方）。
// 役の偽物と全文レビューの結果の形は full-review-fixture.mjs の 1 か所に置く。起動の数は本物の Workflow source（coverage-audit.js）が起動した役の記録で数える。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { MAX_ATTEMPTS, STANDARD_LENSES, UNIT_MAX_BYTES } from './ledger-core.mjs'
import { LENSES, ROLES, cli, driveScript, project, scriptAgent, status, wavesOf, agentStages } from './blackboard-fixture.mjs'
import { NEW_ROLES, driveUntil, launchesOf, sizedDoc, standalone, workersOf } from './launch-fixture.mjs'
import { LENS_PROC } from './plan-roles.mjs'
import { FR_KIND, FR_ORIGIN, FR_QUERY_KEYS, FR_QUERY_REQUIRED, FR_ROLE, FR_STAGE, confirmedIds, frAct, frFacts, frFinding, frStatus, loc } from './full-review-fixture.mjs'

const QA = 'この文書は台帳の lock を取ってから書き込むことを保証する。'
const QB = 'この文書は lock が書き込みを直列にすることを前提にする。'
const plain = (n) => `# ${n}\n\n## 節\n${n} の節は主張を一つだけ述べる本文の行である。\n`
const QC = '文書C の節は主張を一つだけ述べる本文の行である。'
// 小さい対象（4 ファイル。全体で UNIT_MAX_BYTES 以下）。launch.test.mjs と同じ。
const FILES4 = { 'a.md': `# A\n\n## 保証\n${QA}\n`, 'b.md': `# B\n\n## 前提\n${QB}\n`, 'c.md': plain('文書C'), 'd.md': plain('文書D') }
const MARK = 'MARKER-ファイルの段の指摘'
const FACTS = (p) => (path.basename(p) === 'a.md'
  ? { guarantees: [{ subject: '台帳の lock', quote: QA, confidence: 'high' }], findings: [{ claim: MARK, quote: QA, severity: 'HIGH' }] }
  : path.basename(p) === 'b.md' ? { premises: [{ subject: 'lock', quote: QB, confidence: 'high' }] } : {})
// 全文レビューの既定の指摘: a と b の 2 つの単位を引用する 1 件。
const FR_A = 'FR-全文レビューがまたいで拾った指摘'
const twoUnit = (claim = FR_A, extra = {}) => (units) => [frFinding(claim, [loc(units, 'a.md', QA), loc(units, 'b.md', QB)], extra)]
const smallAct = (over = {}) => frAct({ facts: FACTS, frFindings: twoUnit(), ...over })
const MODES = [
  { name: 'coverage-build から（観点を渡し、目標は照合済み）', make: (t, files = FILES4, opts = {}) => project(t, files, opts) },
  { name: '単独（観点を渡さず、目標の照合を計画役が担う）', make: (t, files = FILES4, opts = {}) => standalone(t, files, { lenses: null, ...opts }) },
]
async function fullRun(t, mode, over = {}, { files = FILES4, agentWrap = (f) => f, state: given = null } = {}) {
  const state = given || mode.make(t, files).state
  const log = []
  const r = await driveScript(state, agentWrap(scriptAgent(smallAct(over), log)), { maxSteps: 40 })
  return { state, log, ...r, launches: launchesOf(r.steps, log), waves: wavesOf(r.steps, log) }
}
const sorted = (xs) => [...xs].sort()
const count = (xs) => xs.reduce((m, x) => ({ ...m, [x]: (m[x] || 0) + 1 }), {})
const stagesOf = (waves) => waves.map((s) => s.stage)
const frSteps = (waves) => waves.filter((s) => s.stage === FR_STAGE)
const frCalls = (calls) => calls.filter((c) => c.stage === FR_STAGE)
const isComplete = (stop) => { assert.ok(stop, '止まるまで進まなかった（stop が null）'); assert.equal(stop.stop, 'complete', JSON.stringify(stop)) }
const baseName = (s, id) => { const u = (s.units || []).find((x) => x.id === id); return path.basename(String((u && u.path) || id)) }
const allIds = (s) => (s.units || []).map((u) => u.id)
// 全文レビューの呼び出しまで回す（その呼び出しの ingest の後で止まる）。
const untilFR = (state, a, maxSteps = 12) => driveUntil(state, a, { until: (c) => c.stage === FR_STAGE, maxSteps })
const frWorker = (calls) => workersOf(frCalls(calls))[0]
const frSubmitResults = (w) => (w ? w.submits.flatMap((s) => s.out.results || []) : [])
// 対象の観点の手続きの文（全文レビューに渡らないはずの文）。
const LENS_TEXTS = [LENSES[0].procedure, LENS_PROC.X1, ...STANDARD_LENSES.map((l) => l.procedure)]

// ---------------- 1. 置き場と体数 ----------------

for (const mode of MODES) {
  test(`1. 置き場と体数（${mode.name}）: 全文レビューは計画の段（と観点の検証）の後・ファイルの段の前に 1 回だけ 1 体で流れ、振り返りを除く起動は 6 体`, async (t) => {
    const { stop, waves, state, launches } = await fullRun(t, mode)
    isComplete(stop)
    const stages = stagesOf(waves)
    const fr = frSteps(waves)
    assert.equal(fr.length, 1, `全文レビューの呼び出しは 1 回: ${stages}`)
    assert.deepEqual(fr[0].rows.map((w) => w.role), [FR_ROLE], '全文レビューは 1 体')
    const at = stages.indexOf(FR_STAGE)
    const planLast = Math.max(stages.lastIndexOf('plan'), stages.lastIndexOf('unit_verify'))
    assert.ok(planLast >= 0 && planLast < at, `計画の段（と観点の検証）の後: ${stages}`)
    assert.ok(stages.indexOf('file') > at, `ファイルの段の前: ${stages}`)
    const target = launches.filter((x) => x.stage !== 'retro')
    assert.deepEqual(sorted(target.map((x) => x.role)), sorted([...NEW_ROLES, FR_ROLE]), `段ごとの起動: ${JSON.stringify(count(target.map((x) => `${x.stage}/${x.role}`)))}`)
    // 1 つの呼び出しが段をまたぐので、台帳の起動の記録は段で分けずに全体で、起動した数と照らす。
    const recorded = status(state).calls.reduce((n, c) => n + c.agents, 0)
    assert.equal(recorded, launches.length, JSON.stringify(status(state).calls.map((c) => [c.step, c.agents])))
  })
}

test('1. いつも 1 体: config --workers 2 でも全文レビューの workers は 1 行', async (t) => {
  const { state } = project(t, FILES4)
  assert.equal(cli('config', '--state', state, '--workers', '2').code, 0)
  const r = await untilFR(state, smallAct())
  const fr = frCalls(r.calls)
  assert.equal(fr.length, 1, `全文レビューまで進む: ${r.calls.map((c) => c.stage)}`)
  assert.deepEqual(fr[0].rows.map((w) => w.role), [FR_ROLE])
})

// ---------------- 2. 入力 ----------------

test('2. 入力: 全文レビューの担当は観点を持たず、query で引けるのは目標と読む範囲の単位の一覧（写しの file と範囲）だけ', async (t) => {
  const { state } = project(t, FILES4)
  const r = await untilFR(state, smallAct())
  const w = frWorker(r.calls)
  assert.ok(w, `全文レビューの worker が起動した: ${r.calls.map((c) => c.stage)}`)
  assert.ok(w.tasks.length >= 1 && w.tasks.every((k) => k.kind === FR_KIND), `担当の種類: ${w.tasks.map((k) => k.kind)}`)
  assert.ok(w.tasks.every((k) => !k.lenses || !k.lenses.length), '担当に観点を載せない')
  const claimText = JSON.stringify(w.tasks)
  for (const x of LENS_TEXTS) assert.ok(!claimText.includes(x), `担当に観点の手続きが載った: ${x}`)
  const q = w.queries[0] && w.queries[0].out
  assert.ok(q && q.code === 0, `全文レビューの担当は query できる: ${JSON.stringify(q)}`)
  const inputs = q.inputs || {}
  const keys = Object.keys(inputs)
  for (const k of keys) assert.ok(FR_QUERY_KEYS.includes(k), `query の inputs に目標と単位の一覧の外の欄がある: ${k}`)
  for (const k of FR_QUERY_REQUIRED) assert.ok(keys.includes(k), `query の inputs に ${k} が無い`)
  for (const k of ['basis', 'related', 'facts', 'lenses', 'given_lenses', 'index', 'hints']) assert.ok(!(k in q) && !(k in inputs), `query が ${k} を返した`)
  const s = status(state)
  assert.deepEqual(sorted(inputs.units.map((u) => u.id)), sorted(allIds(s)), '小さい対象は全ての単位を読む範囲にする')
  const snap = path.join(state, 'snap') + path.sep
  for (const u of inputs.units) {
    assert.ok(typeof u.file === 'string' && u.file.startsWith(snap) && existsSync(u.file), `単位の写しの file: ${u.id} ${u.file}`)
    assert.ok(Number.isInteger(u.start) && Number.isInteger(u.end) && u.start >= 1 && u.end >= u.start, `単位の範囲: ${u.id}`)
  }
  const out = JSON.stringify(q)
  for (const x of LENS_TEXTS) assert.ok(!out.includes(x), `query に観点の手続きが載った: ${x}`)
})

// ---------------- 3. 指摘 ----------------

test('3. 指摘: 複数の単位を引用した指摘を、各単位の本文で照らして受け、義務に結べない気づきは参考（origin: full_review）として受ける', async (t) => {
  const { state } = project(t, FILES4)
  const REF = 'FR-義務に結べない気づき'
  const r = await untilFR(state, smallAct({ frReferences: (units) => [{ claim: REF, locations: [loc(units, 'c.md', QC)] }] }))
  const res = frSubmitResults(frWorker(r.calls))
  assert.ok(res.length >= 1 && res.every((x) => x.ok), `提出が受理された: ${JSON.stringify(res)}`)
  const s = status(state)
  const f = frFacts(s).find((x) => x.claim === FR_A)
  assert.ok(f, `全文レビューの指摘が事実になった: ${JSON.stringify(s.facts.map((x) => [x.type, x.origin, x.claim]))}`)
  assert.deepEqual(sorted((f.locations || []).map((l) => baseName(s, l.unit))), ['a.md', 'b.md'], '2 つの単位の引用を持つ')
  assert.deepEqual(sorted((f.paths || []).map((p) => path.basename(p))), ['a.md', 'b.md'])
  assert.ok(s.references.some((x) => x.claim === REF && x.origin === FR_ORIGIN), `参考に入った: ${JSON.stringify(s.references)}`)
  assert.ok(!s.intents.some((i) => i.kind === 'finding' && s.facts.some((x) => x.claim === REF && i.basis.includes(x.id))), '参考は指摘の判定にかけない')
})

// 落ちる提出 1 回 → 正しい提出 1 回（試行の上限 MAX_ATTEMPTS の中で受理される）。
const BAD = [
  { name: '他の単位の本文を引いた場所', bad: (u) => ({ findings: [frFinding(FR_A, [loc(u, 'a.md', QB)])], references: [] }), problem: null },
  { name: '読む範囲に無い単位', bad: (u) => ({ findings: [frFinding(FR_A, [{ unit: 'missing:z.md', quote: QA }])], references: [] }), problem: null },
  { name: '義務でない obligation', bad: (u) => ({ findings: [frFinding(FR_A, [loc(u, 'a.md', QA)], { obligation: 'NOPE' })], references: [] }), problem: /obligation/ },
  { name: '原因の層が無い', bad: (u) => ({ findings: [frFinding(FR_A, [loc(u, 'a.md', QA)], { layer: undefined })], references: [] }), problem: /layer/ },
  { name: '保証を書いた', bad: (u) => ({ findings: [], references: [], guarantees: [{ subject: '台帳の lock', quote: QA, confidence: 'high' }] }), problem: /guarantees/ },
  { name: '前提を書いた', bad: (u) => ({ findings: [], references: [], premises: [{ subject: 'lock', quote: QB, confidence: 'high' }] }), problem: /premises/ },
]
for (const b of BAD) {
  test(`3. 指摘の照合（${b.name}）: その提出は拒み（ok: false）、直した提出は受ける。保証・前提の事実は足さない`, async (t) => {
    const { state } = project(t, FILES4)
    let n = 0
    const a = smallAct({ full_review: (task, ctx, q) => { n += 1; const units = (q && q.inputs && q.inputs.units) || []; return n === 1 ? b.bad(units) : undefined } })
    const r = await untilFR(state, a)
    const res = frSubmitResults(frWorker(r.calls))
    assert.ok(res.length >= 2, `出し直した: ${JSON.stringify(res)}`)
    assert.equal(res[0].ok, false, `落ちる提出を受けた: ${JSON.stringify(res[0])}`)
    if (b.problem) assert.ok(res[0].problems.some((p) => b.problem.test(p)), JSON.stringify(res[0].problems))
    assert.equal(res.at(-1).ok, true, `直した提出を受けない: ${JSON.stringify(res.at(-1))}`)
    const s = status(state)
    assert.ok(!s.facts.some((f) => f.origin === FR_ORIGIN && ['guarantee', 'premise'].includes(f.type)), '全文レビューの保証・前提の事実がある')
  })
}

// ---------------- 4. 判定と確認・10. 出どころ ----------------

test('4・10. 判定と確認: 全文レビューの指摘は 1 件ずつ指摘の判定の意図になり、残したものも落としたものも重さによらず全件が確認の意図になる。確定は確認を通ったものだけで、origin は full_review', async (t) => {
  const C4 = { K1: ['keep', 'agree'], K2: ['keep', 'disagree'], D1: ['drop', 'agree'], D2: ['drop', 'disagree'] }
  const claimOf = (k) => `FR-LOW-${k}`
  const keyOf = (f) => Object.keys(C4).find((k) => f.claim === claimOf(k))
  const findings = (units) => Object.keys(C4).map((k) => frFinding(claimOf(k), [loc(units, 'c.md', QC)], { severity: 'LOW' }))
  const { stop, state } = await fullRun(t, MODES[0], { frFindings: findings, frJudge: (f) => C4[keyOf(f)][0], frConfirm: (f) => C4[keyOf(f)][1] })
  isComplete(stop)
  const s = status(state)
  const fr = frFacts(s).filter((f) => keyOf(f))
  assert.equal(fr.length, 4, `全文レビューの指摘が 4 件の事実になる: ${JSON.stringify(s.facts.map((f) => [f.origin, f.claim]))}`)
  for (const f of fr) {
    const judged = s.intents.filter((i) => i.kind === 'finding' && i.basis.length === 1 && i.basis[0] === f.id)
    assert.equal(judged.length, 1, `${f.claim}: 指摘の判定の意図が 1 つ`)
    assert.equal(judged[0].state, 'closed')
    const conf = s.intents.filter((i) => i.kind === 'confirm' && i.basis.includes(f.id))
    assert.equal(conf.length, 1, `${f.claim}（${C4[keyOf(f)][0]}・LOW）: 確認の意図が 1 つ: ${JSON.stringify(s.intents.map((i) => [i.kind, i.basis]))}`)
    assert.equal(conf[0].state, 'closed')
  }
  const ok = confirmedIds(s)
  const want = { K1: true, K2: false, D1: false, D2: true }
  for (const f of fr) assert.equal(ok.includes(f.id), want[keyOf(f)], `${f.claim} の確定（判定 ${C4[keyOf(f)][0]}・確認 ${C4[keyOf(f)][1]}）`)
  const k1 = s.findings.confirmed.find((x) => (x.ids || [x.id]).includes(fr.find((f) => keyOf(f) === 'K1').id))
  assert.equal(k1.origin, FR_ORIGIN, `確定した指摘の出どころ: ${JSON.stringify(k1)}`)
  const file = s.findings.confirmed.find((x) => x.claim === MARK)
  assert.ok(file && file.origin === 'file', 'ファイルの段の指摘の出どころは file のまま')
})

test('4. 確認を通らずに確定する経路が無い: 判定役が残した全文レビューの指摘でも、確認が試行の上限で判定できなければ確定しない', async (t) => {
  const { stop, state } = await fullRun(t, MODES[0], { frConfirm: () => 'bad' })
  isComplete(stop)
  const s = status(state)
  const f = frFacts(s).find((x) => x.claim === FR_A)
  assert.ok(f, '全文レビューの指摘が事実になった')
  assert.ok(s.intents.some((i) => i.kind === 'finding' && i.basis[0] === f.id && i.state === 'closed'), '判定役は残した（keep）')
  const conf = s.intents.filter((i) => i.kind === 'confirm' && i.basis.includes(f.id))
  assert.ok(conf.length === 1 && conf[0].state === 'undecided', `確認の意図は判定できずに閉じた: ${JSON.stringify(conf)}`)
  assert.ok(!confirmedIds(s).includes(f.id), '確認を通らずに確定した')
})

// ---------------- 5. 重なり ----------------

test('5. 重なり: ファイルの段と同じ欠陥を挙げた全文レビューの指摘も、ファイルの段の指摘も、重複として落とさず両方を確定して束ねに渡す', async (t) => {
  const same = (units) => [frFinding(MARK, [loc(units, 'a.md', QA)])]
  const { stop, state } = await fullRun(t, MODES[0], { frFindings: same })
  isComplete(stop)
  const s = status(state)
  const fileF = s.facts.find((f) => f.type === 'finding' && f.origin === 'file' && f.claim === MARK)
  const frF = frFacts(s).find((f) => f.claim === MARK)
  assert.ok(fileF && frF && fileF.id !== frF.id, `両方の事実がある: ${JSON.stringify(s.facts.map((f) => [f.origin, f.claim, f.id]))}`)
  for (const f of [fileF, frF]) assert.ok(s.intents.some((i) => i.kind === 'finding' && i.basis[0] === f.id && i.state === 'closed'), `${f.origin} の指摘の判定の意図`)
  const ok = confirmedIds(s)
  assert.ok(ok.includes(fileF.id) && ok.includes(frF.id), `どちらも確定する: ${JSON.stringify(s.findings.confirmed)}`)
  const g = s.intents.find((i) => i.kind === 'group')
  assert.ok(g && g.basis.includes(fileF.id) && g.basis.includes(frF.id), `束ねの根拠に両方が入る: ${JSON.stringify(g)}`)
})

// ---------------- 6. 独立 ----------------

test('6. 独立（ファイルの段）: 全文レビューが書いた後も、ファイルの段の担当の query は拒まれ、担当に全文レビューの指摘が載らない', async (t) => {
  const { state } = project(t, FILES4)
  const a = smallAct({ file: (task, ctx) => { ctx.query(task); return undefined } })
  const r = await driveUntil(state, a, { until: (c) => c.stage === 'file', maxSteps: 12 })
  const stages = r.calls.map((c) => c.stage)
  assert.ok(stages.indexOf(FR_STAGE) >= 0 && stages.indexOf(FR_STAGE) < stages.indexOf('file'), `全文レビューの後にファイルの段: ${stages}`)
  assert.ok(frFacts(status(state)).some((f) => f.claim === FR_A), '全文レビューが台帳に書いた')
  const fw = workersOf(r.calls.filter((c) => c.stage === 'file'))
  const qs = fw.flatMap((w) => w.queries)
  assert.ok(qs.length >= 1, 'ファイルの段が query を試した')
  for (const q of qs) assert.notEqual(q.out.code, 0, `ファイルの段の query が通った: ${JSON.stringify(q.out).slice(0, 200)}`)
  assert.ok(!JSON.stringify(fw.map((w) => w.tasks)).includes(FR_A), 'ファイルの段の担当に全文レビューの指摘が載った')
})

test('6. 独立（全文レビュー）: 次の run の全文レビューは、前の run の指摘・判定と他の役の書き込みを query で引けず、--fact も拒まれる', async (t) => {
  const { state, paths } = project(t, FILES4)
  const first = await fullRun(t, MODES[0], {}, { state })
  isComplete(first.stop)
  const s1 = status(state)
  const known = s1.facts.find((f) => f.origin === 'file' && path.basename(f.path) === 'a.md')
  assert.ok(known, 'a.md の事実がある（変えないので次の run でも今の根拠に残る）')
  writeFileSync(paths['c.md'], `${FILES4['c.md']}\n文書C に足した二つ目の本文の行である。\n`)
  let factTry = null
  const a = smallAct({ full_review: (task, ctx) => { factTry = ctx.query(task, [known.id]); return undefined } })
  const log = []
  const r = await driveScript(state, scriptAgent(a, log), { maxSteps: 40 })
  isComplete(r.stop)
  const fr = launchesOf(r.steps, log).filter((x) => x.stage === FR_STAGE)
  assert.equal(fr.length, 1, `次の run の全文レビュー: ${stagesOf(wavesOf(r.steps, log))}`)
  const plainQ = fr[0].queries.find((q) => q.out && q.out.code === 0)
  assert.ok(plainQ, `全文レビューの query: ${JSON.stringify(fr[0].queries.map((q) => q.out && q.out.code))}`)
  const out = JSON.stringify([plainQ.out, fr[0].claims.flatMap((c) => c.tasks || [])])
  for (const x of [MARK, FR_A, '本文が主張を支える', '本文が判定を支える', '全文レビューの指摘を本文で確かめた', known.id, ...LENS_TEXTS]) assert.ok(!out.includes(x), `全文レビューの担当か query に他の役の書き込みが載った: ${x}`)
  const withFact = fr[0].queries.find((q) => q.out && (q.out.code !== 0 || 'facts' in q.out))
  assert.ok(withFact && withFact.out.code !== 0, `--fact を付けた query が拒まれない: ${JSON.stringify(factTry)}`)
})

// ---------------- 7. 大きい対象 ----------------

// 並びの順で前から詰める（next-fit）。a+b は収まり、c を足すと超える。前に戻って詰める first-fit なら d も最初の組に入る（a+b+d も収まる）。
// fixture の大きさは線の既定（UNIT_MAX_BYTES）に比例させる（100KB の線で作った大きさの倍率）。
const S = UNIT_MAX_BYTES / 100000
const SIZES = { 'a.md': 40000 * S, 'b.md': 50000 * S, 'c.md': 30000 * S, 'd.md': 5000 * S }
const BIG = Object.fromEntries(Object.entries(SIZES).map(([n, b]) => [n, sizedDoc(n.replace('.md', ''), b)]))
const bigLine = (n) => BIG[n].split('\n')[2]

test('7. 大きい対象: 全文レビューは並びの順で前から UNIT_MAX_BYTES までを読み、読まなかった単位は status で開示し、網羅とカバレッジに数えない', async (t) => {
  assert.ok(SIZES['a.md'] + SIZES['b.md'] < UNIT_MAX_BYTES - 5000 * S && SIZES['a.md'] + SIZES['b.md'] + SIZES['c.md'] > UNIT_MAX_BYTES && SIZES['a.md'] + SIZES['b.md'] + SIZES['d.md'] < UNIT_MAX_BYTES)
  const { state } = project(t, BIG)
  let n = 0
  const a = frAct({
    facts: () => ({}),
    full_review: (task, ctx, q) => {
      n += 1
      const u = (q && q.inputs && q.inputs.units) || []
      // 1 回目は読む範囲の外の単位（c.md）を引用して落ちる。2 回目は範囲の 2 つの単位を引く。
      const cId = status(state).units.find((x) => path.basename(x.path) === 'c.md').id
      return n === 1 ? { findings: [frFinding('FR-範囲外', [loc(u, 'a.md', bigLine('a.md')), { unit: cId, quote: bigLine('c.md') }])], references: [] }
        : { findings: [frFinding('FR-範囲内', [loc(u, 'a.md', bigLine('a.md')), loc(u, 'b.md', bigLine('b.md'))])], references: [] }
    },
  })
  const r = await untilFR(state, a)
  const w = frWorker(r.calls)
  assert.ok(w, `全文レビューまで進む: ${r.calls.map((c) => c.stage)}`)
  assert.equal(frCalls(r.calls)[0].rows.length, 1, '大きい対象でも 1 体')
  const s = status(state)
  const q = w.queries[0] && w.queries[0].out
  assert.deepEqual(sorted(((q && q.inputs && q.inputs.units) || []).map((u) => baseName(s, u.id))), ['a.md', 'b.md'], '読む範囲は並びの順で前から上限まで（next-fit）')
  const res = frSubmitResults(w)
  assert.equal(res[0] && res[0].ok, false, `読む範囲の外の単位を引用した提出を受けた: ${JSON.stringify(res[0])}`)
  assert.equal(res.at(-1) && res.at(-1).ok, true, JSON.stringify(res.at(-1)))
  const fs = frStatus(s)
  assert.deepEqual(sorted((fs.read || []).map((id) => baseName(s, id))), ['a.md', 'b.md'], `status.full_review.read: ${JSON.stringify(fs)}`)
  assert.deepEqual(sorted((fs.unread || []).map((id) => baseName(s, id))), ['c.md', 'd.md'], `status.full_review.unread: ${JSON.stringify(fs)}`)
  // 網羅に数えない: 全文レビューの読みで単位を seen にせず、読まなかった単位を網羅の開示（skip・disclosed）に入れない。
  assert.equal(s.coverage.seen, 0, '全文レビューの読みをカバレッジに数えた')
  assert.deepEqual(s.coverage.disclosed, [])
  assert.deepEqual(s.skip, [])
  assert.equal(cli('next', '--state', state).step, 'file', '次はファイルの段')
  // complete まで: 網羅はファイルの段が持つ。
  const rest = await driveUntil(state, a, { maxSteps: 30 })
  isComplete(rest.stop)
  const s2 = status(state)
  assert.equal(s2.coverage.seen, 4)
  assert.deepEqual(sorted((frStatus(s2).unread || []).map((id) => baseName(s2, id))), ['c.md', 'd.md'], 'complete の status にも読まなかった範囲が残る')
  assert.ok(!frCalls(rest.calls).length, '全文レビューは 1 回だけ')
})

// ---------------- 8. 失敗 ----------------

const FAILS = [
  { name: '返らない（agent が throw）', over: {}, wrap: (f) => async (prompt, opts) => { if (opts.phase === FR_STAGE) throw new Error('時間の上限に当たった'); return f(prompt, opts) } },
  { name: '提出が試行の上限に達する', over: { full_review: (task, ctx, q) => { const u = (q && q.inputs && q.inputs.units) || []; return { findings: [frFinding(FR_A, [loc(u, 'a.md', '本文に無い引用の文で照合に落ちる')])], references: [] } } }, wrap: (f) => f },
]
for (const x of FAILS) {
  test(`8. 失敗（${x.name}）: 出来事として記録し、読まなかったとして開示して先へ進み、complete まで行く`, async (t) => {
    const { stop, steps, state } = await fullRun(t, MODES[0], x.over, { agentWrap: x.wrap })
    isComplete(stop)
    // 返らない役は prompt を受ける前に落ちるので、起動の記録（agents の stage）で数える。
    const fr = agentStages(steps).filter((x) => x === FR_STAGE)
    assert.ok(fr.length >= 1 && fr.length <= MAX_ATTEMPTS, `全文レビューの起動は 1〜${MAX_ATTEMPTS} 回: ${agentStages(steps)}`)
    const s = status(state)
    assert.ok(s.events.some((e) => e.stage === FR_STAGE), `全文レビューの出来事: ${JSON.stringify(s.events.map((e) => [e.stage, e.kind]))}`)
    assert.deepEqual(sorted(frStatus(s).unread || []), sorted(allIds(s)), `読まなかったとして開示: ${JSON.stringify(frStatus(s))}`)
    assert.deepEqual(frFacts(s), [])
    assert.equal(s.coverage.seen, 4, '網羅はファイルの段が持つ')
  })
}

// ---------------- 9. 持ち越し ----------------

test('9. 持ち越し（同じ範囲・指紋・目標）: 上の層の指摘で止まって回答した後の再開では、全文レビューを読み直さない', async (t) => {
  const { state } = project(t, FILES4)
  const first = await fullRun(t, MODES[0], { frFindings: twoUnit(FR_A, { layer: '要求' }) }, { state })
  assert.ok(first.stop, '止まるまで進まなかった')
  assert.equal(frSteps(first.waves).length, 1, `最初の run の全文レビュー: ${stagesOf(first.waves)}`)
  assert.equal(first.stop.stop, 'needs_input', JSON.stringify(first.stop))
  const f = frFacts(status(state)).find((x) => x.claim === FR_A)
  assert.ok(f && (first.stop.upper || []).includes(f.id), `上の層の全文レビューの指摘で止まる: ${JSON.stringify(first.stop)}`)
  assert.equal(cli('answer', '--state', state, '--id', f.id, '--text', '方針として受け入れる').code, 0)
  const again = await fullRun(t, MODES[0], { frFindings: twoUnit(FR_A, { layer: '要求' }) }, { state })
  isComplete(again.stop)
  assert.equal(frSteps(again.waves).length, 0, `読み直した: ${stagesOf(again.waves)}`)
  assert.ok(confirmedIds(status(state)).includes(f.id), '前の読みの指摘は今の根拠に残る')
})

test('9. 持ち越し（単位の指紋が変わる）: 新しい 1 体が読み直し、前の全文レビューの事実を今の根拠から外す', async (t) => {
  const { state, paths } = project(t, FILES4)
  let round = 1
  const over = { frFindings: (units) => twoUnit(`FR-run${round}`)(units) }
  const first = await fullRun(t, MODES[0], over, { state })
  isComplete(first.stop)
  assert.equal(frSteps(first.waves).length, 1)
  writeFileSync(paths['c.md'], `${FILES4['c.md']}\n文書C に足した二つ目の本文の行である。\n`)
  round = 2
  const second = await fullRun(t, MODES[0], over, { state })
  isComplete(second.stop)
  const fr = frSteps(second.waves)
  assert.equal(fr.length, 1, `読み直しの全文レビュー: ${stagesOf(second.waves)}`)
  assert.equal(fr[0].rows.length, 1)
  const fileTasks = second.launches.filter((x) => x.stage === 'file').flatMap((x) => x.claims.flatMap((c) => c.tasks || []))
  assert.deepEqual([...new Set(fileTasks.map((k) => path.basename(k.unit.path)))], ['c.md'], 'ファイルの段は変わった単位だけ')
  const s = status(state)
  assert.deepEqual(frFacts(s).map((f) => f.claim), ['FR-run2'], `今の根拠の全文レビューの事実: ${JSON.stringify(frFacts(s).map((f) => f.claim))}`)
  const claims = s.findings.confirmed.map((f) => f.claim)
  assert.ok(claims.includes('FR-run2') && !claims.includes('FR-run1'), JSON.stringify(claims))
})

test('9. 持ち越し（目標の版が変わる）: 同じ段の reframe で目標が変われば、新しい 1 体が読み直し、新しい目標を引く', async (t) => {
  const { state, d, paths } = project(t, FILES4, { phase: 'review' })
  const first = await fullRun(t, MODES[0], {}, { state })
  isComplete(first.stop)
  assert.equal(frSteps(first.waves).length, 1)
  const g2 = path.join(d, 'goal2.md')
  writeFileSync(g2, '- G1: 対象の文書を観点ごとに確かめた指摘の一覧（改めた目標）\n- G2: 目標の抜けを確かめた結果\n')
  const rf = cli('reframe', '--state', state, '--goal', g2, '--request', path.join(d, 'request.md'), '--criteria', path.join(d, 'criteria.md'), '--lenses', path.join(d, 'lenses.json'), ...Object.values(paths).flatMap((p) => ['--target', p]), '--phase', 'review')
  assert.equal(rf.code, 0, JSON.stringify(rf))
  const second = await fullRun(t, MODES[0], {}, { state })
  isComplete(second.stop)
  const fr = second.launches.filter((x) => x.stage === FR_STAGE)
  assert.equal(fr.length, 1, `読み直しの全文レビュー: ${stagesOf(second.waves)}`)
  assert.ok(fr[0].queries.some((q) => JSON.stringify(q.out).includes('改めた目標')), '新しい目標を引く')
})

for (const [changed, want] of [['b.md', 'fix'], ['c.md', 'missed']]) {
  test(`9. 指摘は引用した全ての単位を根拠に持つ: ${changed} だけを変えて読み直すと、a と b を引用した全文レビューの指摘の出どころは ${want}`, async (t) => {
    const { state, paths } = project(t, FILES4)
    // 1 回目は指摘を書かず、読み直しで初めて a と b を引用した指摘を書く（前は見た・指摘なし）。
    const first = await fullRun(t, MODES[0], { frFindings: () => [] }, { state })
    isComplete(first.stop)
    writeFileSync(paths[changed], `${FILES4[changed]}\n${changed} に足した二つ目の本文の行である。\n`)
    const NEW = 'FR-読み直しで初めて拾った指摘'
    const second = await fullRun(t, MODES[0], { frFindings: twoUnit(NEW) }, { state })
    isComplete(second.stop)
    assert.equal(frSteps(second.waves).length, 1, `読み直しの全文レビュー: ${stagesOf(second.waves)}`)
    const s = status(state)
    const f = s.findings.confirmed.find((x) => x.claim === NEW)
    assert.ok(f, `全文レビューの指摘が確定した: ${JSON.stringify(s.findings.confirmed.map((x) => [x.origin, x.claim]))}`)
    assert.equal(f.origin, FR_ORIGIN)
    assert.deepEqual(sorted(f.paths.map((p) => path.basename(p))), ['a.md', 'b.md'])
    assert.equal(f.provenance, want, `出どころ（関わる単位のどれかが変われば fix、どれも変わらなければ missed）: ${JSON.stringify(f)}`)
  })
}

// ---------------- 11. roles.json ----------------

test('11. roles.json: 全文レビューの役が file_reader と別の key で、Opus / medium', () => {
  const r = ROLES[FR_ROLE]
  assert.ok(r && r.model && r.effort && r.why, `roles.json に ${FR_ROLE} が無い`)
  assert.notEqual(FR_ROLE, 'file_reader')
  assert.equal(r.model, 'opus')
  assert.equal(r.effort, 'medium')
})
