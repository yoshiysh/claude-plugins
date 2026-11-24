// 起動を減らした設計のテスト（計画 glimmering-squishing-moonbeam の「決めること」1〜8、設計 docs/design/coverage-ledger-method.md）。
// 設計の箇所: 結論の「段」「起動」、段の構成（詰め合わせと引用の規則）、台帳と見たの記録（B1）、観点の定義と持ち主、
// 全体の段と確認（意図の表・割り振り・完了と出来事・束ね）、完了と止める条件（試行の上限・飽和）、モデルと費用（起動の原則）。
// 役の偽物と新しい結果の形は launch-fixture.mjs の 1 か所に置く。起動の数は、本物の Workflow source（coverage-audit.js）が起動した役の記録で数える。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { C, MAX_ATTEMPTS, UNIT_MAX_BYTES } from './ledger-core.mjs'
import { ROLES, cli, driveScript, project, runScript, scriptAgent, status, wavesOf } from './blackboard-fixture.mjs'
import { proc, procQuote } from './plan-roles.mjs'
import { GONE_ROLES, GONE_STAGES, NEW_ROLES, act, driveUntil, launchesOf, sizedDoc, standalone, workersOf } from './launch-fixture.mjs'

const QA = 'この文書は台帳の lock を取ってから書き込むことを保証する。'
const QB = 'この文書は lock が書き込みを直列にすることを前提にする。'
const plain = (n) => `# ${n}\n\n## 節\n${n} の節は主張を一つだけ述べる本文の行である。\n`
// 小さい対象（4 ファイル。全体で UNIT_MAX_BYTES 以下）。
const FILES4 = { 'a.md': `# A\n\n## 保証\n${QA}\n`, 'b.md': `# B\n\n## 前提\n${QB}\n`, 'c.md': plain('文書C'), 'd.md': plain('文書D') }
const MARK = 'MARKER-ファイルの段の指摘'
const FACTS = (p) => (path.basename(p) === 'a.md'
  ? { guarantees: [{ subject: '台帳の lock', quote: QA, confidence: 'high' }], findings: [{ claim: MARK, quote: QA, severity: 'HIGH' }] }
  : path.basename(p) === 'b.md' ? { premises: [{ subject: 'lock', quote: QB, confidence: 'high' }] } : {})
// 主語の照合が矛盾の指摘を 1 件足す（確認の意図を作る）。
const SUBJECT = (layer = '方式設計') => (task, ctx) => {
  const q = ctx.query(task)
  const locs = q.basis.filter((f) => f.quote && f.unit).map((f) => ({ unit: f.unit, quote: f.quote }))
  return { verdict: 'conflict', quote: locs[0].quote, findings: [{ claim: '主語の照合が足した矛盾の指摘', locations: locs, obligation: task.obligations[0].id, confidence: 'high', severity: 'HIGH', layer }] }
}
const smallAct = (over = {}) => act({ facts: FACTS, subject: SUBJECT(), ...over })
const MODES = [
  { name: 'coverage-build から（観点を渡し、目標は照合済み）', make: (t, files = FILES4) => project(t, files), retro: false },
  { name: '単独（観点を渡さず、目標の照合を計画役が担う）', make: (t, files = FILES4) => standalone(t, files, { lenses: null }), retro: true },
]
async function fullRun(t, mode, over = {}) {
  const { state } = mode.make(t)
  const log = []
  const r = await driveScript(state, scriptAgent(smallAct(over), log), { maxSteps: 30 })
  return { state, log, ...r, launches: launchesOf(r.steps, log), waves: wavesOf(r.steps, log) }
}
const sorted = (xs) => [...xs].sort()
const count = (xs) => xs.reduce((m, x) => ({ ...m, [x]: (m[x] || 0) + 1 }), {})
const base = (u) => path.basename(String(u.path || u.id))

// ---------------- 全体の起動数（起動の原則） ----------------

for (const mode of MODES) {
  test(`起動数（${mode.name}）: 小さい対象（4 ファイル）を complete まで回すと、振り返りを除く起動は 6 体（計画 1・観点の検証 1・全文レビュー 1・ファイル 1・判定 1・確認と束ね 1）`, async (t) => {
    const { stop, state, launches } = await fullRun(t, mode)
    assert.equal(stop.stop, 'complete', JSON.stringify(stop))
    const target = launches.filter((x) => x.stage !== 'retro')
    assert.deepEqual(sorted(target.map((x) => x.role)), sorted([...NEW_ROLES, 'full_reviewer']), `段ごとの起動: ${JSON.stringify(count(target.map((x) => `${x.stage}/${x.role}`)))}`)
    // 起動の記録（台帳の calls）も、起動した数と同じ（1 つの呼び出しが段をまたぐので、段では分けずに全体で数える）。
    const recorded = status(state).calls.reduce((n, c) => n + c.agents, 0)
    assert.equal(recorded, launches.length, JSON.stringify(status(state).calls.map((c) => [c.step, c.agents])))
    const retro = launches.filter((x) => x.stage === 'retro')
    assert.equal(retro.length, mode.retro ? 1 : 0, `振り返りは単独で呼ばれたときだけ 1 体: ${retro.length}`)
    assert.ok(launches.every((x) => !GONE_STAGES.includes(x.stage)), `無くなった段: ${launches.map((x) => x.stage)}`)
  })
}

// ---------------- 1. 横展開をやめる ----------------

test('1. 横展開が無い: 確定した指摘があっても lateral の意図・lateral_types・lateral_groups が出ず、run の中の周は 1 のまま', async (t) => {
  const { stop, steps, state, launches } = await fullRun(t, MODES[0])
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const s = status(state)
  assert.ok(s.findings.confirmed.some((f) => f.claim === MARK), '確定した指摘がある（横展開を起こしうる条件）')
  assert.ok(!('lateral_types' in s), 'status に lateral_types が無い')
  assert.ok(!('lateral_groups' in stop), '停止に lateral_groups が無い')
  assert.ok(!s.intents.some((i) => i.kind === 'lateral'), '横展開の意図が無い')
  assert.ok(launches.every((x) => x.claims.every((c) => (c.tasks || []).every((k) => k.kind !== 'lateral'))))
  assert.equal(s.cycle, 1, '周は増えない')
  assert.ok(steps.every((x) => x.next.cycle === 1), `どの呼び出しも周 1: ${steps.map((x) => x.next.cycle)}`)
})

// ---------------- 2. 反証をやめ、束ねを全体の段の最後の意図にする ----------------

test('2. 束ね: 確認が全て閉じた後に CLI が group の意図を作り、確認役が同じ呼び出しで取る。pattern・applies_to・extends の無い結果を受け、反証の役は無い', async (t) => {
  const { stop, state, launches } = await fullRun(t, MODES[0])
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const s = status(state)
  assert.ok(s.intents.some((i) => i.kind === 'group' && i.state === 'closed'), `group の意図: ${JSON.stringify(s.intents.map((i) => [i.kind, i.state]))}`)
  assert.ok(s.groups.some((g) => g.root_cause === '確定した指摘に共通する原因'), '束ねの群が status に残る（pattern・applies_to なしで受理）')
  const grouper = launches.filter((x) => x.claims.some((c) => (c.tasks || []).some((k) => k.kind === 'group')))
  assert.equal(grouper.length, 1, '束ねを取ったのは 1 体')
  assert.equal(grouper[0].role, 'confirmer', '束ねは確認役が取る')
  const kinds = grouper[0].claims.flatMap((c) => (c.tasks || []).map((k) => k.kind))
  assert.ok(kinds.includes('confirm'), '同じ体（同じ呼び出し）が確認の意図も取った')
  assert.ok(kinds.lastIndexOf('confirm') < kinds.indexOf('group'), `確認が全て閉じてから束ね: ${kinds}`)
  assert.ok(launches.every((x) => !['grouper', 'refuter_a', 'refuter_b'].includes(x.role)), '束ね役・反証役は起動しない')
})

test('2. 上の層の群: 要求の層の群は needs_input の upper_groups に出る（反証は無い）。指摘そのものは上の層でない', async (t) => {
  const { stop, state, launches } = await fullRun(t, MODES[0], { groupOpts: { layer: '要求' } })
  assert.ok(launches.every((x) => !GONE_STAGES.includes(x.stage)), `束ね・反証の段を通らない: ${launches.map((x) => x.stage)}`)
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.ok(Array.isArray(stop.upper_groups) && stop.upper_groups.length >= 1, JSON.stringify(stop))
  assert.deepEqual(stop.upper || [], [], '確定した指摘の層は上の層でない')
  const s = status(state)
  for (const id of stop.upper_groups) assert.ok(s.groups.some((g) => g.id === id && g.layer === '要求'), `群 ${id} が status にある`)
})

test('2. 段: Workflow script は束ね・反証・統合・目標の照合の段を受けず、役を起動しない（args の検査で落ちる）', async () => {
  for (const stage of GONE_STAGES) {
    const launched = []
    const res = await runScript({ state: '/tmp/coverage-x', callId: 'c1', wave: { id: 1, rows: [{ id: 'w1', role: 'planner', model: 'sonnet', effort: 'medium', stage }] } }, async (p, o) => { launched.push(o.label); return { notes: [] } })
    assert.deepEqual(res.agents, [], `${stage} の段で役を起動した: ${launched}`)
  }
})

// ---------------- 3. 目標の照合と計画を 1 体にまとめる ----------------

for (const mode of MODES) {
  test(`3. 計画の段（${mode.name}）: planner 1 体の呼び出しが 1 回だけ流れ、目標の照合役・計画役 2 体・統合役は起動しない`, async (t) => {
    const { stop, waves, launches } = await fullRun(t, mode)
    assert.equal(stop.stop, 'complete', JSON.stringify(stop))
    const plan = waves.filter((s) => s.stage === 'plan')
    assert.equal(plan.length, 1, `計画の段の波: ${waves.map((s) => s.stage)}`)
    assert.deepEqual(plan[0].rows.map((w) => w.role), ['planner'])
    assert.ok(launches.every((x) => !GONE_ROLES.includes(x.role)), `無くなった役: ${launches.map((x) => x.role)}`)
  })
}

test('3. 目標の穴: 計画役の照合で受け止められていない成果があれば needs_input（goal_gaps）にし、その回の計画（質問を含む）は使わない', async (t) => {
  const { state } = standalone(t, FILES4, { lenses: null })
  const outcomes = (q) => [
    { outcome: '依頼の全体', quotes: [{ source: 'request', quote: q.request }], items: q.item_ids },
    { outcome: '受け止める項目の無い成果', quotes: [{ source: 'request', quote: q.request }], items: [] },
  ]
  const questions = [{ id: 'Q1', question: '範囲を広げるか', why_value_judgment: '範囲は利用者が決める', options: ['広げる', '広げない'] }]
  const log = []
  const r = await driveScript(state, scriptAgent(smallAct({ planOpts: { outcomes, questions } }), log), { maxSteps: 10 })
  assert.equal(r.stop.stop, 'needs_input', JSON.stringify(r.stop))
  assert.ok(Array.isArray(r.stop.goal_gaps) && r.stop.goal_gaps.some((g) => g.outcome === '受け止める項目の無い成果'), JSON.stringify(r.stop))
  assert.ok(!('questions' in r.stop), '計画の質問で止めない（その回の計画は使わない）')
  assert.deepEqual(status(state).questions, [], 'その回の計画の質問を status に出さない')
  assert.ok(wavesOf(r.steps, log).every((s) => s.stage === 'plan'), `計画の段の外に進まない: ${wavesOf(r.steps, log).map((s) => s.stage)}`)
  assert.deepEqual(launchesOf(r.steps, log).map((x) => x.role), ['planner'], '照合と計画を 1 体で担う')
})

// ---------------- 4. 観点の検証を 1 体にする ----------------

test('4. 観点の検証: 計画役が足した全ての観点を unit_verifier 1 体が 1 つの担当（計画の版）で確かめる', async (t) => {
  const { state } = project(t, FILES4)
  const r = await driveUntil(state, smallAct({ planOpts: { spec: { X1: {}, X2: {}, X3: {} } } }), { until: (c) => c.stage === 'unit_verify' })
  const uv = r.calls.filter((c) => c.stage === 'unit_verify')
  assert.equal(uv.length, 1, `観点の検証の呼び出し: ${r.calls.map((c) => c.stage)}`)
  assert.deepEqual(uv[0].rows.map((w) => w.role), ['unit_verifier'], '観点ごとに体を分けない')
  const tasks = workersOf(uv)[0].tasks
  assert.equal(tasks.length, 1, `担当は計画の版で 1 つ: ${tasks.map((x) => x.id)}`)
  assert.equal(tasks[0].kind, 'unit_verify')
  const q = workersOf(uv)[0].queries[0].out
  assert.deepEqual(sorted(((q.inputs || {}).lenses || []).map((l) => l.id)), ['X1', 'X2', 'X3'], '1 つの担当が全ての観点を渡す')
})

test('4. 観点の検証の欠陥: 計画の段（planner）に戻し、直した後は変わった観点だけを確かめ直す', async (t) => {
  const { state } = project(t, FILES4)
  const OLD = proc('用語ごとに定義の文を対応づけて列挙する', '列挙した用語を目標と照らし定義の無い用語を探す')
  const NEW = proc('用語の一覧を先に作り本文の定義の文と対応づけて列挙する', '列挙した用語を目標と照らし定義の無い用語を探す')
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  let round = 0
  // 1 回目の計画の X2 は OLD の手続き。2 回目（欠陥を受けた計画）は X2 の手続きだけを変え、X1 はそのまま。
  const a = act({
    plan: (q) => {
      round += 1
      const r = {
        lenses: [
          { id: 'X1', name: 'X1', procedure: proc('本文の主張と根拠を対応づけて列挙する', '列挙した組を目標と照らし食い違いを探す'), goals: [...q.items, ...q.criteria].map((g) => ({ id: g.id, part: g.text })) },
          { id: 'X2', name: 'X2', procedure: round === 1 ? OLD : NEW, goals: [...q.items, ...q.criteria].map((g) => ({ id: g.id, part: g.text })) },
        ],
        questions: [], constraint_map: [...q.criteria, ...q.constraints].map((c) => ({ constraint_id: c.id, handled_by: ['X2'] })),
        ...(Array.isArray(q.defects) ? { defect_responses: q.defects.map((d, i) => ({ defect_index: d.index ?? i, action: 'fixed', reason: '直した' })) } : {}),
        ...(Array.isArray(q.sources) ? { source_map: q.sources.map((s) => ({ source: s, merged_into: s.split(':')[1], dropped_reason: '' })) } : {}),
      }
      return r
    },
    unit_verify: (q) => {
      const ls = Array.isArray(q.lenses) ? q.lenses : [q.lens]
      const ans = ls.map((l) => ({
        unit_id: l.id,
        answers: [{ question: 'Q1' }, { question: 'Q2' }, ...l.goals.map((g, i) => ({ question: 'Q3', goal_index: i, goal_id: g.id }))]
          .map((x) => ({ ...x, answer: same(l.procedure, OLD) && x.question === 'Q1' ? 'no' : 'yes', quote: procQuote(l) })),
      }))
      return Array.isArray(q.lenses) ? { lenses: ans } : ans[0]
    },
  })
  const r = await driveUntil(state, a, { until: (c) => c.stage === 'file', maxSteps: 12 })
  const stages = r.calls.map((c) => c.stage)
  const uvAt = stages.map((s, i) => [s, i]).filter(([s]) => s === 'unit_verify').map(([, i]) => i)
  assert.equal(uvAt.length, 2, `観点の検証は 2 回（欠陥の前と後）: ${stages}`)
  assert.equal(stages[uvAt[0] + 1], 'plan', `欠陥の後は計画の段（planner）に戻る: ${stages}`)
  assert.deepEqual(r.calls[uvAt[0] + 1].rows.map((w) => w.role), ['planner'])
  const lensIds = (c) => sorted((((workersOf([c])[0].queries[0] || {}).out || {}).inputs || {}).lenses?.map((l) => l.id) || [])
  assert.deepEqual(lensIds(r.calls[uvAt[0]]), ['X1', 'X2'], '1 回目は全ての観点')
  assert.deepEqual(lensIds(r.calls[uvAt[1]]), ['X2'], '2 回目は変わった観点だけ')
})

// ---------------- 5. ファイルの段の詰め合わせ ----------------

// 並びの順に前から詰める（next-fit）。a+b は上限を超え、b+c+d は収まる。a+c+d も収まるので、前に戻って詰める first-fit とは結果が違う。
const SIZES = { 'a.md': 60000, 'b.md': 50000, 'c.md': 30000, 'd.md': 5000 }
const BIG = Object.fromEntries(Object.entries(SIZES).map(([n, b]) => [n, sizedDoc(n.replace('.md', ''), b)]))
const bundlesOf = (calls) => workersOf(calls.filter((c) => c.stage === 'file')).map((w) => sorted(w.tasks.filter((k) => k.kind === 'file').map((k) => base(k.unit)))).filter((b) => b.length).map((b) => [...new Set(b)]).sort((x, y) => (x[0] < y[0] ? -1 : 1))

test('5. 詰め合わせ: 並びの順で前から UNIT_MAX_BYTES まで決定的に詰め、詰め合わせ 1 つを 1 体が読む。別の台帳でも同じ組になる', async (t) => {
  for (const [n, b] of Object.entries(SIZES)) assert.ok(Math.abs(Buffer.byteLength(BIG[n]) - b) < 200, n)
  assert.ok(SIZES['a.md'] + SIZES['b.md'] > UNIT_MAX_BYTES && SIZES['b.md'] + SIZES['c.md'] + SIZES['d.md'] < UNIT_MAX_BYTES - 5000)
  const runOnce = async () => {
    const { state } = project(t, BIG)
    const r = await driveUntil(state, smallAct(), { until: (c) => c.stage === 'file' })
    const file = r.calls.filter((c) => c.stage === 'file')
    return { rows: file.flatMap((c) => c.rows), bundles: bundlesOf(r.calls) }
  }
  const one = await runOnce()
  assert.deepEqual(one.bundles, [['a.md'], ['b.md', 'c.md', 'd.md']], '並びの順で前から詰める')
  assert.equal(one.rows.length, 2, 'ファイルの段の体数は詰め合わせの数')
  assert.ok(one.rows.every((w) => w.role === 'file_reader'))
  const two = await runOnce()
  assert.deepEqual(two.bundles, one.bundles, '詰め方は決定的')
})

test('5. 小さい対象: 全体が UNIT_MAX_BYTES 以下なら、ファイルの段は 1 体で全ての単位を読む', async (t) => {
  const { state } = project(t, FILES4)
  const r = await driveUntil(state, smallAct(), { until: (c) => c.stage === 'file' })
  const file = r.calls.filter((c) => c.stage === 'file')
  assert.equal(file.length, 1)
  assert.deepEqual(file[0].rows.map((w) => w.role), ['file_reader'])
  assert.deepEqual(bundlesOf(r.calls), [['a.md', 'b.md', 'c.md', 'd.md']])
  assert.equal(status(state).coverage.seen, 4)
})

test('5. 引用は自分の単位だけ: 同じ詰め合わせの他の単位の本文を引いた保証の提出は拒み、他の単位の提出は受ける', async (t) => {
  const { state } = project(t, { 'a.md': FILES4['a.md'], 'b.md': FILES4['b.md'] })
  let first = true
  const a = smallAct({
    file: (task) => {
      if (base(task.unit) !== 'a.md' || !first) return undefined
      first = false
      return { seen: task.lenses.map((l) => ({ lens: l.id, answer: 'checked', quote: QA })), findings: [], references: [], premises: [], guarantees: [{ subject: 'lock', quote: QB, confidence: 'high' }] }
    },
  })
  const r = await driveUntil(state, a, { until: (c) => c.stage === 'file' })
  const w = workersOf(r.calls.filter((c) => c.stage === 'file'))
  assert.equal(w.length, 1, '2 つの単位は 1 体に詰める')
  const results = w[0].submits.flatMap((s) => s.out.results || [])
  const firstA = results.find((x) => x.unit && path.basename(x.unit) === 'a.md')
  const firstB = results.find((x) => x.unit && path.basename(x.unit) === 'b.md')
  assert.ok(firstA && firstA.ok === false && firstA.problems.some((p) => p.includes('guarantees')), JSON.stringify(results))
  assert.ok(firstB && firstB.ok === true, JSON.stringify(results))
})

test('5. 持ち越しは単位ごと: 別の詰め合わせにあった 2 つの単位だけが変われば、その 2 つだけを詰め直して 1 体が読む', async (t) => {
  const { state, paths } = project(t, BIG)
  const a = smallAct({ facts: () => ({}) }) // BIG の本文に QA・QB は無いので、FACTS の保証・前提を足さない
  const r1 = await driveUntil(state, a, { until: (c) => c.stage === 'file' })
  assert.deepEqual(bundlesOf(r1.calls), [['a.md'], ['b.md', 'c.md', 'd.md']])
  assert.equal(status(state).coverage.seen, 4)
  // a（60K）と c（30K）の中身だけを、大きさを変えずに書き換える。a+c は上限に収まる。
  for (const n of ['a.md', 'c.md']) writeFileSync(paths[n], readFileSync(paths[n], 'utf8').replace('line 000001:', 'line 00000X:'))
  const r2 = await driveUntil(state, a, { until: (c) => c.stage === 'file' })
  const file2 = r2.calls.filter((c) => c.stage === 'file')
  assert.equal(file2.length, 1, `読み直しのファイルの段: ${r2.calls.map((c) => c.stage)}`)
  assert.equal(file2[0].rows.length, 1, '読み直す単位だけを詰め直す（1 体）')
  assert.deepEqual(bundlesOf(r2.calls), [['a.md', 'c.md']], '変わった単位だけを読み直す')
  assert.equal(status(state).coverage.seen, 4)
})

// ---------------- 6. 全体の段を種類ごとに 1 体にする ----------------

test('6. 判定役 1 体: 名寄せ・主語の照合・指摘の判定・前提・目標の意図を global_judge が取り、alias_judge は無い。確認役も 1 体', async (t) => {
  const { stop, waves, launches } = await fullRun(t, MODES[0])
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const byKind = {}
  for (const x of launches) for (const c of x.claims) for (const k of c.tasks || []) (byKind[k.kind] = byKind[k.kind] || new Set()).add(x.role)
  for (const k of ['alias', 'subject', 'finding', 'goal']) assert.deepEqual([...(byKind[k] || [])], ['global_judge'], `${k} の担当を取った役: ${[...(byKind[k] || [])]}`)
  assert.deepEqual([...(byKind.confirm || [])], ['confirmer'])
  const global = waves.filter((s) => s.stage === 'global')
  for (const s of global) {
    const roles = count(s.rows.map((w) => w.role))
    assert.ok(Object.values(roles).every((n) => n === 1), `種類ごとに 1 体: ${JSON.stringify(roles)}`)
    assert.ok(Object.keys(roles).every((r) => ['global_judge', 'confirmer'].includes(r)), JSON.stringify(roles))
  }
  assert.equal(launches.filter((x) => x.role === 'global_judge').length, 1)
  assert.equal(launches.filter((x) => x.role === 'confirmer').length, 1)
})

test('6. workers: 既定は 1 で、開いた判定の意図が多くても判定役は 1 体。config --workers 2 で 2 体に上書きできる', async (t) => {
  const firstGlobal = async (workers) => {
    const { state } = project(t, FILES4)
    if (workers) assert.equal(cli('config', '--state', state, '--workers', String(workers)).code, 0)
    const r = await driveUntil(state, smallAct(), { until: (c) => c.stage === 'global' })
    const g = r.calls.find((c) => c.stage === 'global')
    assert.ok(g, `全体の段まで進む: ${r.calls.map((c) => c.stage)}`)
    return { state, judges: g.rows.filter((w) => w.role === 'global_judge').length, intents: status(state).intents }
  }
  const def = await firstGlobal(null)
  assert.equal(cli('config', '--state', def.state).config.workers, 1, '既定の workers は 1')
  assert.ok(def.intents.filter((i) => ['alias', 'finding', 'goal', 'subject', 'premise'].includes(i.kind)).length >= 2, '判定の意図が 2 つ以上ある')
  assert.equal(def.judges, 1)
  const two = await firstGlobal(2)
  assert.equal(two.judges, 2, '--workers で上書きできる')
})

// ---------------- 7. 振り返りを分ける ----------------

test('7. 振り返り（単独）: 1 体が全ての出来事を読み、結果は status.retro に出る。対象の指摘・事実・意図・群に入らず、上の層の振り返りの指摘でも complete', async (t) => {
  const { state } = standalone(t, FILES4, { lenses: null })
  const RETRO = 'RETRO-振り返りの指摘'
  let rejectOnce = true
  const a = smallAct({
    retroFindings: [{ claim: RETRO, layer: '要求' }],
    // 出来事を 2 つの段に作る: ファイルの段の拒否（rejected_file）と、全体の段の不明の名寄せ（alias_unsure。既定の判定）。
    file: (task) => { if (base(task.unit) === 'c.md' && rejectOnce) { rejectOnce = false; return { seen: [], findings: [], references: [], guarantees: [], premises: [] } } return undefined },
  })
  const log = []
  const r = await driveScript(state, scriptAgent(a, log), { maxSteps: 30 })
  assert.equal(r.stop.stop, 'complete', JSON.stringify(r.stop))
  const retro = launchesOf(r.steps, log).filter((x) => x.stage === 'retro')
  assert.equal(retro.length, 1, '振り返りは 1 体')
  assert.equal(wavesOf(r.steps, log).at(-1).stage, 'retro', `振り返りは最後に走る: ${wavesOf(r.steps, log).map((s) => s.stage)}`)
  const s = status(state)
  // 1 体が全ての出来事を読む: 振り返りの前の全ての出来事の id が、その 1 体の担当（写し）か query の出力にある。
  const seenText = retro.flatMap((x) => [
    ...x.claims.flatMap((c) => (c.tasks || []).map((k) => (k.unit && existsSync(k.unit.file) ? readFileSync(k.unit.file, 'utf8') : ''))),
    ...x.queries.map((q) => JSON.stringify(q.out)),
  ]).join('\n')
  const evs = s.events.filter((e) => e.stage !== 'retro')
  assert.ok(evs.some((e) => e.stage === 'file') && evs.some((e) => e.stage === 'global'), `出来事が 2 つの段にある: ${evs.map((e) => e.stage)}`)
  for (const e of evs) assert.ok(seenText.includes(e.id), `振り返りが読んでいない出来事: ${e.id}`)
  // 結果は status の別の欄。
  assert.ok(s.retro && Array.isArray(s.retro.findings) && s.retro.findings.some((f) => f.claim === RETRO), JSON.stringify(s.retro))
  const file = JSON.parse(readFileSync(r.stop.status_path, 'utf8'))
  assert.ok(file.retro && file.retro.findings.some((f) => f.claim === RETRO), 'complete の status のファイルにも振り返りの欄がある')
  // 対象の指摘・事実・参考・意図・群に入らない。
  const all = JSON.stringify([s.findings, s.facts, s.references, s.intents, s.groups])
  assert.ok(!all.includes(RETRO), '振り返りの指摘が対象の欄に入った')
  assert.equal(s.coverage.units, 4, '振り返りは対象の単位に数えない')
  assert.ok(!r.stop.upper_groups || !r.stop.upper_groups.length)
})

test('7. 振り返り（coverage-build から）: --goal-checked coverage-build の台帳は振り返りを起動せず、status.retro に結果を出さない', async (t) => {
  const { stop, launches, state } = await fullRun(t, MODES[0], { retroFindings: [{ claim: 'RETRO-出ない' }] })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(launches.every((x) => x.stage !== 'retro'))
  const s = status(state)
  assert.ok(!s.retro || !(s.retro.findings || []).length, JSON.stringify(s.retro))
  assert.ok(!JSON.stringify(s).includes('RETRO-出ない'))
})

// ---------------- 8. 全体の段の役は写しを開く ----------------

test('8. 写し: 全体の段の query が返す、単位を持つ事実は、写し（stateDir/snap/）の file と start・end を持ち、その範囲に引用がある。prompt は対象の本体を開かせない', async (t) => {
  const { stop, state, launches, log } = await fullRun(t, MODES[0])
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const snap = path.join(state, 'snap') + path.sep
  const facts = launches.filter((x) => x.stage === 'global').flatMap((x) => x.queries.flatMap((q) => [...(q.out.basis || []), ...(q.out.related || []), ...(q.out.facts || [])])).filter((f) => f && f.unit)
  assert.ok(facts.length >= 3, `単位を持つ事実を引いた: ${facts.length}`)
  // 全体の段の prompt は、原文を対象の本体（事実の path）でなく写し（事実の file と start〜end）で開かせる。
  for (const x of log.filter((l) => launches[log.indexOf(l)].stage === 'global')) {
    assert.ok(!x.prompt.includes('事実の path（対象のファイル）'), `全体の段の prompt が対象の本体を開かせる: ${x.label}`)
    assert.ok(/file/.test(x.prompt) && /start/.test(x.prompt) && /end/.test(x.prompt), `全体の段の prompt が写しの file と範囲を指さない: ${x.label}`)
  }
  for (const f of facts) {
    assert.ok(typeof f.file === 'string' && f.file.startsWith(snap) && existsSync(f.file), `写しの file が無い: ${f.id} ${f.file}`)
    assert.ok(Number.isInteger(f.start) && Number.isInteger(f.end) && f.start >= 1 && f.end >= f.start, `範囲が無い: ${f.id}`)
    const text = readFileSync(f.file, 'utf8').split('\n').slice(f.start - 1, f.end).join('\n')
    assert.ok(C.norm(text).includes(C.norm(f.quote)), `範囲に引用が無い: ${f.id}`)
  }
})

// ---------------- 試行の上限 ----------------

test(`試行の上限（判定役）: 1 つの意図の提出が MAX_ATTEMPTS（${MAX_ATTEMPTS}）回落ちれば undecided で閉じ、同じ 1 体が他の意図を進めて complete`, async (t) => {
  const { state } = project(t, FILES4)
  const log = []
  const r = await driveScript(state, scriptAgent(smallAct({ goal: (task) => (task.intent.item === 'G2' ? { verdict: 'supported', support: [], quote: '本文に無い引用の文で照合に落ちる' } : undefined) }), log), { maxSteps: 30 })
  assert.equal(r.stop.stop, 'complete', JSON.stringify(r.stop))
  const s = status(state)
  assert.ok(s.undecided.some((i) => i.kind === 'goal' && i.reason), JSON.stringify(s.undecided))
  assert.equal(s.intents.filter((i) => i.state === 'open').length, 0)
  const judges = launchesOf(r.steps, log).filter((x) => x.role === 'global_judge')
  assert.equal(judges.length, 1, '判定役は 1 体のまま')
})

test(`試行の上限（束ね）: 束ねの提出が MAX_ATTEMPTS 回落ちれば束ねの意図を undecided として開示し、群を作らずに complete まで進む。確定した指摘は残る`, async (t) => {
  const { state } = project(t, FILES4)
  const bad = () => ({ groups: [{ id: 'g1', root_cause: '原因', layer: '実装', keys: ['F-実在しない'] }], unassigned: [] })
  const r = await driveScript(state, scriptAgent(smallAct({ group: bad })), { maxSteps: 30 })
  assert.equal(r.stop.stop, 'complete', JSON.stringify(r.stop))
  const s = status(state)
  assert.ok(s.undecided.some((i) => i.kind === 'group' && i.reason), `束ねの意図が開示される: ${JSON.stringify(s.undecided)}`)
  assert.ok(s.findings.confirmed.some((f) => f.claim === MARK), '確定した指摘は残る')
  assert.ok(s.findings.confirmed.every((f) => Array.isArray(f.groups) && !f.groups.length))
})

// ---------------- roles.json ----------------

test('roles.json: 新しい役だけがあり、Opus の役は effort が medium 以下（Opus / high が無い）。判断を出す役と確かめる役は別のモデル（計画役と観点の検証役、判定役と確認役）', () => {
  for (const r of NEW_ROLES) assert.ok(ROLES[r] && ROLES[r].model && ROLES[r].effort && ROLES[r].why, `roles.json に ${r} が無い`)
  for (const r of GONE_ROLES) assert.equal(ROLES[r], undefined, `無くなった役が残る: ${r}`)
  for (const [k, v] of Object.entries(ROLES)) if (v.model === 'opus') assert.ok(['low', 'medium'].includes(v.effort), `Opus の役は medium 以下: ${k} ${v.effort}`)
  assert.notEqual(ROLES.planner.model, ROLES.unit_verifier.model)
  assert.notEqual(ROLES.global_judge.model, ROLES.confirmer.model)
})
