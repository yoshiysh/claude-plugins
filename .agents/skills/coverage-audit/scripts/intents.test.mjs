// 単位 3 のテスト: 静的な検査（範囲参照の展開）と、事実からの意図の生成・主語の束ね（設計「全体の段と確認」「再レビューと持ち越し」「完了と止める条件」）。
// 意図は CLI が事実から決定的に作り（名寄せ・主語の照合・指摘の判定・前提の消化・目標の判定・確認）、役は claim で取り、query で根拠と関係する事実だけを引き、submit で事実を足す。
// 試行の上限（MAX_ATTEMPTS = 2）に達した意図は「判定できなかった意図」として開示して閉じ、needs_input で止めずに complete まで進む（今の段の stuck → needs_input と違う扱い）。
// 「名前が近い」の判じ方は設計が決めていない。ここでは、片方がもう片方を含む組は近い、字を 1 つも共有しない組は近くない、の 2 つだけを使う。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as core from './ledger-core.mjs'
import { INTENT_ID, behave, claimedTasks, cli, drive, project, run, status, submitResults } from './blackboard-fixture.mjs'
import { passPlan } from './plan-roles.mjs'

const QA = 'この文書は台帳の lock を取ってから書き込むことを保証する。'
const QB = 'この文書は lock が書き込みを直列にすることを前提にする。'
const QC = 'この文書は目標固定の手順を述べる本文の行である。'
const FILES = { 'a.md': `# A\n\n## 保証\n${QA}\n`, 'b.md': `# B\n\n## 前提\n${QB}\n`, 'c.md': `# C\n\n## 目標\n${QC}\n` }
// ファイルの段が書く保証と前提: a は「台帳の lock」を保証し、b は「lock」を前提にし（名前が近い組）、c は「目標固定」を保証する（どちらとも字を共有しない）。
const FACTS = {
  'a.md': () => ({ guarantees: [{ subject: '台帳の lock', quote: QA, confidence: 'high' }] }),
  'b.md': () => ({ guarantees: [], premises: [{ subject: 'lock', quote: QB, confidence: 'high' }] }),
  'c.md': () => ({ guarantees: [{ subject: '目標固定', quote: QC, confidence: 'high' }] }),
}
const factsOver = (table) => (p, lines, task) => (table[path.basename(p)] ? table[path.basename(p)](p, lines, task) : { guarantees: [] })
const act = (over = {}, table = FACTS) => behave({ facts: factsOver(table), ...over })

function st(state) {
  const s = status(state)
  assert.equal(s.code, 0, JSON.stringify(s))
  assert.ok(Array.isArray(s.intents), `status に intents（意図の一覧）が無い: ${Object.keys(s).join(', ')}`)
  assert.ok(Array.isArray(s.facts), 'status に facts（事実の一覧）が無い')
  return s
}
// 既定でファイルの段は義務ごとの保証も書くので、主語で選ぶ。
const SUBJ = { guarantee: { 'a.md': '台帳の lock', 'c.md': '目標固定' }, premise: { 'b.md': 'lock', 'e.md': '台帳の lock' } }
const factOf = (s, p, type) => s.facts.find((f) => f.path === p && f.type === type && f.subject === SUBJ[type][path.basename(p)])
const intents = (s, kind) => s.intents.filter((i) => i.kind === kind)
const hasAll = (xs, ys) => ys.every((y) => xs.includes(y))
// ファイルの段（最初の呼び出し）だけを流す。
// ファイルの段（最初の呼び出し）だけを流し、次の next で事実から意図を作らせる（意図を作る時機は submit・ingest・next のどれでもよい）。
async function fileStage(state, a) {
  const r = await drive(state, a, { maxSteps: 1 })
  cli('next', '--state', state)
  return r
}

test('意図の id と形: CLI が事実から作る意図は <種類>:<hex> の id・種類・根拠の事実の id（basis）・状態（open|closed|undecided）を持つ', async (t) => {
  const { state } = project(t, FILES)
  await passPlan(state)
  await fileStage(state, act())
  const s = st(state)
  assert.ok(s.intents.length > 0)
  for (const i of s.intents) {
    assert.match(i.id, INTENT_ID)
    assert.ok(Array.isArray(i.basis), JSON.stringify(i))
    assert.ok(['open', 'closed', 'undecided'].includes(i.state), JSON.stringify(i))
    for (const f of i.basis) assert.ok(s.facts.some((x) => x.id === f), `basis は実在する事実: ${f}`)
  }
})

test('意図の id は決定的: 同じ対象を別の台帳で同じように回すと、同じ意図の id の集合になる', async (t) => {
  const { d, state, paths } = project(t, FILES)
  await passPlan(state)
  const state2 = path.join(d, 'state2')
  assert.equal(run('init', '--state', state2, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--criteria', path.join(d, 'criteria.md'), '--lenses', path.join(d, 'lenses.json'), ...Object.values(paths).flatMap((p) => ['--target', p]), '--goal-checked', 'coverage-build').code, 0)
  await passPlan(state2)
  await drive(state, act())
  await drive(state2, act())
  assert.deepEqual(st(state).intents.map((i) => i.id).sort(), st(state2).intents.map((i) => i.id).sort())
})

test('目標の判定: 目標と受け入れ基準の項目ごとに 1 つの goal の意図を作る（item に項目の id）', async (t) => {
  const { state } = project(t, FILES)
  await passPlan(state)
  await fileStage(state, act())
  assert.deepEqual(intents(st(state), 'goal').map((i) => i.item).sort(), ['AC1', 'G1', 'G2'])
})

test('名寄せ: 名前の近い主語の組（「台帳の lock」と「lock」）に alias の意図を作り、字を共有しない主語（「目標固定」）とは組まない', async (t) => {
  const { state, paths } = project(t, FILES)
  await passPlan(state)
  await fileStage(state, act())
  const s = st(state)
  const fa = factOf(s, paths['a.md'], 'guarantee')
  const fb = factOf(s, paths['b.md'], 'premise')
  const fc = factOf(s, paths['c.md'], 'guarantee')
  assert.ok(fa && fb && fc, JSON.stringify(s.facts))
  const al = intents(s, 'alias')
  assert.ok(al.some((i) => hasAll(i.basis, [fa.id, fb.id]) && i.state === 'open'), JSON.stringify(al))
  assert.ok(!al.some((i) => i.basis.includes(fc.id)), '字を共有しない主語は名寄せにかけない')
})

test('順序: 主語の照合の意図は、その主語の名寄せが全て閉じるまで開かず、取られない。閉じた後に両方の主語を根拠に持つ subject の意図ができる', async (t) => {
  const { state, paths } = project(t, FILES)
  await passPlan(state)
  const snaps = []
  const atClaim = []
  const a = act({
    subject: (task, ctx) => {
      const q = ctx.query(task)
      const ids = q.basis.map((f) => f.id)
      const s = st(state)
      atClaim.push({ intent: task.intent.id, openAlias: intents(s, 'alias').filter((x) => x.state === 'open' && x.basis.some((f) => ids.includes(f))).map((x) => x.id) })
      return undefined
    },
  })
  const { stop } = await drive(state, a, { onCall: () => { snaps.push(st(state)) } })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const last = st(state)
  const fa = factOf(last, paths['a.md'], 'guarantee')
  const fb = factOf(last, paths['b.md'], 'premise')
  for (const s of snaps) {
    for (const sub of intents(s, 'subject').filter((i) => i.state === 'open')) {
      const touching = intents(s, 'alias').filter((x) => x.basis.some((f) => sub.basis.includes(f)))
      assert.ok(touching.every((x) => x.state !== 'open'), `名寄せが開いている間に主語の照合が開いた: ${sub.id}`)
    }
  }
  const sub = intents(last, 'subject').find((i) => hasAll(i.basis, [fa.id, fb.id]))
  assert.ok(sub, '不明の名寄せでも、その組の主語の照合の意図を作る')
  assert.ok(atClaim.some((x) => x.intent === sub.id), 'subject の意図は claim で取られる')
  for (const x of atClaim) assert.deepEqual(x.openAlias, [], `取った時点で、その主語の名寄せが開いている: ${x.intent}`)
})

test('不明の名寄せ（同じ単位の中の組）: 主語が 1 つの単位にしか無くても、組の主語の照合の意図を作る', async (t) => {
  const Q1 = 'この文書は lock を取ってから書き込みを始める本文の行である。'
  const Q2 = 'この文書は台帳の lock が他の書き込みを待たせると述べる行である。'
  const { state, paths } = project(t, { 'd.md': `# D\n\n## 一\n${Q1}\n\n## 二\n${Q2}\n` })
  await passPlan(state)
  const table = { 'd.md': () => ({ guarantees: [{ subject: 'lock', quote: Q1, confidence: 'high' }, { subject: '台帳の lock', quote: Q2, confidence: 'high' }] }) }
  const { stop } = await drive(state, act({}, table))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const s = st(state)
  const fs = s.facts.filter((f) => f.path === paths['d.md'] && f.type === 'guarantee' && ['lock', '台帳の lock'].includes(f.subject)).map((f) => f.id)
  assert.equal(fs.length, 2)
  assert.ok(intents(s, 'alias').some((i) => hasAll(i.basis, fs)), '同じ単位の組も名寄せにかける')
  assert.ok(intents(s, 'subject').some((i) => hasAll(i.basis, fs)), JSON.stringify(intents(s, 'subject')))
})

test('名寄せの判定の形: {same: yes|no|unsure, confidence, quote}。閉じた集合の外の same と、根拠の事実の本文に無い引用は拒む', async (t) => {
  const { state } = project(t, FILES)
  await passPlan(state)
  const bad = []
  const a = act({ alias: (task, ctx) => { if (bad.length) return undefined; bad.push(task.intent.id); const q = ctx.query(task); return { same: 'maybe', confidence: 'low', quote: q.basis[0].quote } } })
  const { calls } = await drive(state, a)
  assert.ok(bad.length === 1, 'alias の担当を取った')
  const res = calls.flatMap((c) => c.workers.flatMap((w) => w.submits.filter((x) => x.tasks.some((tk) => tk.kind === 'alias')).flatMap((x) => x.out.results || [])))
  assert.ok(res.some((r) => r.ok === false && r.problems.length), `閉じた集合の外の same は拒む: ${JSON.stringify(res.slice(0, 5))}`)
})

test(`試行の上限（名寄せ）: 名寄せの提出が MAX_ATTEMPTS 回落ちれば、その意図は判定できなかった意図（undecided）として理由つきで閉じ、不明と同じに扱って主語の照合の意図を必ず作る`, async (t) => {
  assert.equal(core.MAX_ATTEMPTS, 2)
  const { state, paths } = project(t, FILES)
  await passPlan(state)
  const seenBy = []
  const a = act({
    alias: () => ({ same: 'unsure', confidence: 'low', quote: '根拠の事実の本文に無い引用の文をここに書く' }),
    subject: (task, ctx) => { const q = ctx.query(task); seenBy.push([...q.basis, ...q.related].map((f) => f.id)); return undefined },
  })
  const { stop } = await drive(state, a)
  assert.equal(stop.stop, 'complete', `名寄せが判定できなくても complete まで進む: ${JSON.stringify(stop)}`)
  const s = st(state)
  const fa = factOf(s, paths['a.md'], 'guarantee')
  const fb = factOf(s, paths['b.md'], 'premise')
  const al = intents(s, 'alias').find((i) => hasAll(i.basis, [fa.id, fb.id]))
  assert.equal(al.state, 'undecided')
  assert.ok((s.undecided || []).some((u) => u.id === al.id && typeof u.reason === 'string' && u.reason.length), JSON.stringify(s.undecided))
  assert.ok(intents(s, 'subject').some((i) => hasAll(i.basis, [fa.id, fb.id])), '主語の照合の意図が作られずに終わることは無い')
  assert.ok(seenBy.some((ids) => hasAll(ids, [fa.id, fb.id])), '主語の照合の役は、不明の組の両方の主語を query で引ける')
})

test(`試行の上限（全体の段）: 意図の提出が MAX_ATTEMPTS 回落ちれば undecided で閉じ、開いた意図に数えず、needs_input でなく complete まで進む`, async (t) => {
  const { state } = project(t, FILES)
  await passPlan(state)
  const target = { id: null, tasks: new Set() }
  const a = act({
    goal: (task) => {
      if (task.intent.item !== 'G2') return undefined
      target.id = task.intent.id
      target.tasks.add(task.id)
      return { verdict: 'supported', support: ['実在しない事実'], quote: '根拠の事実の本文に無い引用の文をここに書く' }
    },
  })
  const { stop, calls } = await drive(state, a)
  assert.ok(target.id, 'G2 の goal の意図を取った')
  assert.equal(stop.stop, 'complete', `stuck・needs_input で止めない: ${JSON.stringify(stop)}`)
  const s = st(state)
  assert.equal(s.intents.find((i) => i.id === target.id).state, 'undecided')
  assert.ok(s.undecided.some((u) => u.id === target.id && u.reason), JSON.stringify(s.undecided))
  assert.ok((stop.undecided || []).some((u) => (u.id || u) === target.id), `停止の出力にも判定できなかった意図を開示する: ${JSON.stringify(stop)}`)
  assert.equal(s.intents.filter((i) => i.state === 'open').length, 0)
  const rejected = submitResults(calls).filter((r) => target.tasks.has(r.task) && r.ok === false)
  assert.equal(rejected.length, core.MAX_ATTEMPTS, `落ちた提出の数が試行の上限に達したら閉じ、それ以上出させない: ${rejected.length}`)
  assert.equal(rejected[rejected.length - 1].dropped, true)
})

test('試行の上限（提出しない役）: 取ったまま提出されない意図も試行に数え、MAX_ATTEMPTS 回で undecided にして complete まで進む', async (t) => {
  // 束で取るので、同じ呼び出しで他の意図を出した役の取り残しは試行に数えずに手放す（設計「完了と止める条件」）。数えるのは、その意図を取った役が 1 件も出さなかった呼び出しだけ。
  const { state } = project(t, FILES)
  await passPlan(state)
  const target = { id: null, calls: new Set() }
  const a = act({ goal: (task, ctx) => { if (task.intent.item !== 'AC1') return undefined; target.id = task.intent.id; target.calls.add(ctx.call); return null } })
  const { stop, calls } = await drive(state, a)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.equal(st(state).intents.find((i) => i.id === target.id).state, 'undecided')
  const heldIdle = calls.filter((c) => target.calls.has(c.args.callId) && c.workers.some((w) => w.claims.some((cl) => (cl.tasks || []).some((x) => x.intent && x.intent.id === target.id)) && !w.submits.some((s) => (s.out.results || []).length)))
  assert.equal(heldIdle.length, core.MAX_ATTEMPTS, `取ったまま 1 件も出さなかった呼び出しの数が上限に達したら、もう取らせない: ${heldIdle.length}（取った呼び出し ${target.calls.size}）`)
  const last = [...target.calls].at(-1)
  assert.ok(heldIdle.some((c) => c.args.callId === last), '最後に取った呼び出しは、1 件も出さなかった呼び出し（上限に達した後は取らせない）')
})

test('指摘の判定（残す）: ファイルの段の指摘ごとに finding の意図を作り、残すと確定する（確認に回さない）。確定した指摘は path・義務・確信度・原因の層・出どころを持つ', async (t) => {
  const MARK = 'MARKER-残す指摘: 書き込みの順序の根拠が無い'
  const table = { ...FACTS, 'a.md': () => ({ guarantees: [{ subject: '台帳の lock', quote: QA, confidence: 'high' }], findings: [{ claim: MARK, quote: QA, obligation: 'G1', confidence: 'medium', layer: '方式設計' }] }) }
  const { state, paths } = project(t, FILES)
  await passPlan(state)
  const { stop } = await drive(state, act({}, table))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const s = st(state)
  const ff = s.facts.find((f) => f.type === 'finding' && f.claim === MARK)
  assert.ok(intents(s, 'finding').some((i) => i.basis.includes(ff.id) && i.state === 'closed'))
  assert.ok(!intents(s, 'confirm').some((i) => i.basis.includes(ff.id)), '残した指摘は確認に回さない')
  const c = s.findings.confirmed.find((f) => f.claim === MARK)
  assert.ok(c, JSON.stringify(s.findings))
  assert.deepEqual(c.paths, [paths['a.md']])
  assert.deepEqual([c.obligation, c.confidence, c.layer, c.origin], ['G1', 'medium', '方式設計', 'file'])
})

for (const [verdict, restored] of [['disagree', true], ['agree', false]]) {
  test(`確認（落とした指摘）: 全体の段が落とした重い（HIGH）指摘は必ず confirm の意図になり、確認が ${verdict} なら${restored ? '復活して確定する' : '落ちたまま'}`, async (t) => {
    const MARK = 'MARKER-落とされる指摘: lock の解放の手順が無い'
    const table = { ...FACTS, 'a.md': () => ({ guarantees: [], findings: [{ claim: MARK, quote: QA, severity: 'HIGH' }] }) }
    const { state } = project(t, FILES)
    await passPlan(state)
    const a = act({
      finding: (task, ctx) => { const q = ctx.query(task); return q.basis.some((f) => f.claim === MARK) ? { verdict: 'drop', reason: '全体の文脈では問題にならない', quote: QA } : undefined },
      confirm: () => ({ verdict, reason: '本文で確かめた', quote: QA }),
    }, table)
    const { stop } = await drive(state, a)
    assert.equal(stop.stop, 'complete', JSON.stringify(stop))
    const s = st(state)
    const ff = s.facts.find((f) => f.type === 'finding' && f.claim === MARK)
    assert.ok(intents(s, 'confirm').some((i) => i.basis.includes(ff.id)), '落とした HIGH の指摘は確認にかける')
    assert.equal(s.findings.confirmed.some((f) => f.claim === MARK), restored)
    assert.equal((s.events || []).some((e) => e.kind === 'restored'), restored, '確認での復活を出来事に残す')
  })
}

for (const [verdict, kept] of [['agree', true], ['disagree', false]]) {
  test(`確認（全体の段が足した指摘）: 主語の照合が足した矛盾の指摘は確認を通るまで確定せず、確認が ${verdict} なら${kept ? '確定する（path は両方の単位）' : '確定しない'}`, async (t) => {
    const MARK = 'MARKER-足した指摘: lock の範囲が食い違う'
    const { state, paths } = project(t, FILES)
    await passPlan(state)
    const snaps = []
    const a = act({
      subject: (task, ctx) => {
        const q = ctx.query(task)
        const locs = q.basis.filter((f) => f.quote).map((f) => ({ unit: f.unit, quote: f.quote }))
        return { verdict: 'conflict', quote: locs[0].quote, findings: [{ claim: MARK, locations: locs, obligation: 'G1', confidence: 'high', severity: 'HIGH', layer: '方式設計' }] }
      },
      confirm: () => { snaps.push(st(state)); return { verdict, reason: '本文で確かめた', quote: QA } },
    })
    const { stop } = await drive(state, a)
    assert.equal(stop.stop, 'complete', JSON.stringify(stop))
    assert.ok(snaps.length > 0, '足した指摘は確認にかける')
    for (const s of snaps) {
      assert.ok(s.facts.some((f) => f.claim === MARK), '足した指摘は事実として台帳にある')
      assert.ok(!s.findings.confirmed.some((f) => f.claim === MARK), '確認の前は確定しない')
    }
    const s = st(state)
    const c = s.findings.confirmed.find((f) => f.claim === MARK)
    assert.equal(!!c, kept)
    if (c) { assert.deepEqual([...c.paths].sort(), [paths['a.md'], paths['b.md']].sort()); assert.equal(c.origin, 'subject') }
  })
}

test('全体の段の引用: 根拠と関係する事実の単位の本文に逐語で無い引用の判定は拒む（ok: false と理由）', async (t) => {
  const { state } = project(t, FILES)
  await passPlan(state)
  let once = false
  const a = act({ subject: () => { if (once) return undefined; once = true; return { verdict: 'consistent', quote: 'どの単位の本文にも無い引用の文をここに書く' } } })
  const { calls } = await drive(state, a)
  const sub = calls.flatMap((c) => c.workers.flatMap((w) => w.submits.filter((x) => x.tasks.some((tk) => tk.kind === 'subject')).flatMap((x) => x.out.results || [])))
  assert.ok(sub.some((r) => r.ok === false && r.problems.length), JSON.stringify(sub))
})

test('前提の消化: 他の単位に同じ主語の保証がある前提に premise の意図を作り、query の関係する事実にその保証が入る。同じ名前の主語は名寄せにかけない', async (t) => {
  const QE = 'この文書は台帳の lock があることを前提に書き込む本文の行である。'
  const table = { 'a.md': FACTS['a.md'], 'e.md': () => ({ guarantees: [], premises: [{ subject: '台帳の lock', quote: QE, confidence: 'high' }] }) }
  const { state, paths } = project(t, { 'a.md': FILES['a.md'], 'e.md': `# E\n\n## 前提\n${QE}\n` })
  await passPlan(state)
  const got = []
  const a = act({ premise: (task, ctx) => { const q = ctx.query(task); got.push([...q.basis, ...q.related].map((f) => f.id)); return undefined } }, table)
  const { stop } = await drive(state, a)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const s = st(state)
  const fe = factOf(s, paths['e.md'], 'premise')
  const fa = factOf(s, paths['a.md'], 'guarantee')
  assert.ok(intents(s, 'premise').some((i) => i.basis.includes(fe.id)))
  assert.ok(got.some((ids) => hasAll(ids, [fe.id, fa.id])), '前提を満たす候補の保証を関係する事実として引く')
  assert.ok(!intents(s, 'alias').some((i) => hasAll(i.basis, [fe.id, fa.id])), '同じ名前（正規化して同じ）の主語は名寄せにかけない')
})

test('query（全体の段）: 意図の根拠と関係する事実だけを返し、関係の無い単位の事実（字を共有しない主語の保証）は返さない', async (t) => {
  const { state, paths } = project(t, FILES)
  await passPlan(state)
  const got = []
  const a = act({ subject: (task, ctx) => { const q = ctx.query(task); got.push(q); return undefined } })
  await drive(state, a)
  const s = st(state)
  const fc = factOf(s, paths['c.md'], 'guarantee')
  assert.ok(got.length > 0)
  for (const q of got) {
    assert.ok(Array.isArray(q.basis) && Array.isArray(q.related), JSON.stringify(q))
    assert.ok(![...q.basis, ...q.related].some((f) => f.id === fc.id), '「lock」の照合に「目標固定」の保証を混ぜない')
  }
})

test('参考は判定にかけない: 義務に結べない参考（references）は finding の意図の根拠にも確定した指摘にもならず、status の references で別に開示する', async (t) => {
  const REF = 'MARKER-参考: 言い回しを揃えるとよい'
  const table = { ...FACTS, 'c.md': () => ({ guarantees: [], references: [{ claim: REF, quote: QC }] }) }
  const { state } = project(t, FILES)
  await passPlan(state)
  const { stop } = await drive(state, act({}, table))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const s = st(state)
  const rf = s.facts.find((f) => f.type === 'reference' && f.claim === REF)
  assert.ok(rf)
  assert.ok(!s.intents.some((i) => i.basis.includes(rf.id)))
  assert.ok(!s.findings.confirmed.some((f) => f.claim === REF))
  assert.ok((s.references || []).some((r) => r.claim === REF))
})

for (const [obligation, confirmed] of [['G1', true], [undefined, false]]) {
  test(`静的な検査: --link の id の形で範囲の参照（U1〜U3）を展開し、どこにも無い U3 だけを事実（static）にして指摘の判定にかける。keep に obligation が${confirmed ? '付けば確定（origin: static）' : '付かなければ参考（origin: static）'}`, async (t) => {
    const D1 = 'U1 は入力を受け取る単位の定義の本文である。'
    const D2 = 'U2 は出力を返す単位の定義の本文である。'
    const R = 'この節は U1〜U3 の全てを満たすことを求める本文である。'
    const { state } = project(t, { 'def.md': `# 定義\n\n## U1\n${D1}\n\n## U2\n${D2}\n`, 'ref.md': `# 参照\n\n## 範囲\n${R}\n` }, { link: 'U\\d+' })
    await passPlan(state)
    cli('next', '--state', state)
    const s0 = st(state)
    const statics = s0.facts.filter((f) => f.type === 'static')
    assert.deepEqual(statics.map((f) => f.ref), ['U3'], `範囲を展開して、無い id だけを拾う: ${JSON.stringify(statics)}`)
    assert.ok(!s0.findings.confirmed.length, '静的な検査の結果だけでは確定の指摘にしない')
    const a = behave({
      finding: (task, ctx) => {
        const q = ctx.query(task)
        if (!q.basis.some((f) => f.type === 'static')) return undefined
        return { verdict: 'keep', reason: '範囲の参照が実在しない id を含む', quote: R, ...(obligation ? { obligation, layer: '詳細設計' } : {}) }
      },
    })
    const { stop } = await drive(state, a)
    assert.equal(stop.stop, 'complete', JSON.stringify(stop))
    const s1 = st(state)
    assert.ok(intents(s1, 'finding').some((i) => i.basis.includes(statics[0].id)), '静的な検査の結果は指摘の判定の意図にかける')
    const inConfirmed = s1.findings.confirmed.filter((f) => JSON.stringify(f).includes('U3'))
    const inRefs = (s1.references || []).filter((f) => JSON.stringify(f).includes('U3'))
    if (confirmed) {
      assert.ok(inConfirmed.some((f) => f.origin === 'static' && f.obligation === 'G1'), JSON.stringify(s1.findings.confirmed))
      assert.ok(!inRefs.length)
    } else {
      assert.equal(inConfirmed.length, 0, '義務に結べない指摘は確定しない')
      assert.ok(inRefs.some((f) => f.origin === 'static'), `参考に入れ、出どころを残す: ${JSON.stringify(s1.references)}`)
    }
  })
}

test('目標の判定の query: related はその項目の id を obligation に持つ事実だけ。結ばれていない保証は返さず、その件数を omitted に宣言する', async (t) => {
  const table = {
    'a.md': () => ({ bind: false, guarantees: [{ subject: '台帳の lock', quote: QA, confidence: 'high' }] }),
    'b.md': () => ({ bind: false, guarantees: [], premises: [{ subject: 'lock', quote: QB, confidence: 'high', obligation: 'G2' }] }),
    'c.md': () => ({ bind: false, guarantees: [{ subject: '目標固定', quote: QC, confidence: 'high', obligation: 'G2' }, { subject: '目標固定', quote: QC, confidence: 'high', obligation: 'G1' }, { subject: '目標固定', quote: QC, confidence: 'high', obligation: 'AC1' }] }),
  }
  const { state } = project(t, FILES)
  await passPlan(state)
  const got = {}
  const a = act({ goal: (task, ctx) => { got[task.intent.item] = ctx.query(task); return undefined } }, table)
  const { stop } = await drive(state, a)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const s = st(state)
  const byId = new Map(s.facts.map((f) => [f.id, f]))
  for (const item of ['G1', 'G2', 'AC1']) {
    const q = got[item]
    assert.ok(q, `${item} の goal の意図を取った`)
    const ids = [...q.basis, ...q.related].map((f) => f.id)
    assert.ok(ids.length > 0)
    for (const id of q.related.map((f) => f.id)) assert.equal(byId.get(id).obligation, item, `${item} に結ばれていない事実を返した: ${JSON.stringify(byId.get(id))}`)
    const unbound = s.facts.filter((f) => f.type === 'guarantee' && f.obligation !== item).length
    assert.equal(typeof q.omitted, 'number', `omitted は載せなかった件数: ${JSON.stringify(q.omitted)}`)
    assert.equal(q.omitted, unbound, `${item}: 結ばれていない保証の件数`)
  }
  const fa = s.facts.find((f) => f.subject === '台帳の lock')
  assert.ok(!Object.values(got).some((q) => [...q.basis, ...q.related].some((f) => f.id === fa.id)), '義務に結ばれていない保証はどの目標の判定にも返さない')
  assert.ok([...got.G2.related].some((f) => f.type === 'premise'), '前提も obligation を持てば返す')
})

test('持ち越し: 単位が変われば、その単位の事実を根拠に持つ意図と、無いことの判定（目標の抜け）を開き直す。変わらない単位だけを支えにした判定は閉じたまま。開き直した意図の役は前の判定を引けない', async (t) => {
  const { state, paths } = project(t, FILES)
  await passPlan(state)
  // 義務に結ぶのは c の保証だけ（目標の判定の query は、その項目を obligation に持つ事実だけを返す）。
  const table = {
    'a.md': () => ({ bind: false, guarantees: [{ subject: '台帳の lock', quote: QA, confidence: 'high' }] }),
    // b の前提の引用は、今の本文（書き換えの前も後も）の前提の行から取る（逐語の照合を通す）。
    'b.md': (p, lines) => ({ bind: false, guarantees: [], premises: [{ subject: 'lock', quote: lines.find((l) => l.startsWith('この文書は lock が書き込みを直列にすることを前提')), confidence: 'high' }] }),
    'c.md': () => ({ bind: false, guarantees: ['G1', 'G2', 'AC1'].map((obligation) => ({ subject: '目標固定', quote: QC, confidence: 'high', obligation })) }),
  }
  const goalAct = (task, ctx) => {
    const q = ctx.query(task)
    const fc = [...q.basis, ...q.related].find((f) => f.path === paths['c.md'] && f.obligation === task.intent.item)
    if (task.intent.item === 'G1') return { verdict: 'supported', support: [fc.id], quote: fc.quote }
    if (task.intent.item === 'G2') return { verdict: 'gap', quote: fc.quote, findings: [{ claim: 'G2 を果たす記述が無い', locations: [{ unit: fc.unit, quote: fc.quote }], obligation: 'G2', confidence: 'medium', severity: 'MEDIUM', layer: '方式設計' }] }
    return undefined
  }
  const first = await drive(state, act({ goal: goalAct }, table))
  assert.equal(first.stop.stop, 'complete', JSON.stringify(first.stop))
  const s1 = st(state)
  const fb = factOf(s1, paths['b.md'], 'premise')
  const sub = intents(s1, 'subject').find((i) => i.basis.includes(fb.id))
  assert.equal(sub.state, 'closed')
  const oldJudgments = s1.facts.filter((f) => f.type === 'judgment' && f.intent === sub.id).map((f) => f.id)
  assert.ok(oldJudgments.length, `判定は事実として残る（intent に意図の id）: ${JSON.stringify(s1.facts.filter((f) => f.type === 'judgment').slice(0, 2))}`)
  const g1 = intents(s1, 'goal').find((i) => i.item === 'G1')
  const g2 = intents(s1, 'goal').find((i) => i.item === 'G2')
  assert.deepEqual([g1.state, g2.state], ['closed', 'closed'])

  writeFileSync(paths['b.md'], FILES['b.md'].replace('直列にすることを前提にする。', '直列にすることを前提に置く。'))
  cli('next', '--state', state)
  const s2 = st(state)
  assert.ok(!s2.intents.some((i) => i.state === 'closed' && i.basis.includes(fb.id)), '外した事実を根拠に持つ意図は閉じたままにしない')

  const peeks = []
  const second = await drive(state, act({
    goal: goalAct,
    subject: (task, ctx) => {
      const q = ctx.query(task)
      const byId = cli('query', '--state', ctx.state, '--call', ctx.call, '--worker', ctx.worker, '--task', task.id, ...oldJudgments.flatMap((f) => ['--fact', f]))
      peeks.push({ ids: [...q.basis, ...q.related].map((f) => f.id), byId: byId.code })
      return undefined
    },
  }, table))
  assert.equal(second.stop.stop, 'complete', JSON.stringify(second.stop))
  const taken = claimedTasks(second.calls)
  assert.deepEqual([...new Set(taken.filter((x) => x.kind === 'file').map((x) => x.unit.path))], [paths['b.md']])
  const goals = taken.filter((x) => x.kind === 'goal').map((x) => x.intent.item)
  assert.ok(goals.includes('G2'), '目標の抜け（無いことの判定）は、どの単位が変わっても開き直す')
  assert.ok(!goals.includes('G1'), '変わらない単位（c）だけを支えにした判定は開き直さない')
  assert.ok(peeks.length > 0, '変わった単位にまたがる主語の照合を開き直す')
  for (const p of peeks) {
    assert.ok(!oldJudgments.some((j) => p.ids.includes(j)), '開き直した意図の役に前の判定を見せない')
    assert.equal(p.byId, 2, '前の判定は今の根拠から外れているので --fact でも引けない')
  }
})

test('上限（起動数）: 予算の上限に達したら limit で止め、開いたままの意図の id を開示する（完了と取り違えない）', async (t) => {
  const { state } = project(t, FILES)
  await passPlan(state)
  // 計画の段で使った起動数に 1 を足した上限: ファイルの段は 1 回流れ、全体の段の前で止まる。
  const planned = st(state).agents_by_role ? Object.values(st(state).agents_by_role).reduce((n, r) => n + r.launched, 0) : 0
  assert.ok(planned > 0, '計画の段の起動を数える')
  assert.equal(run('config', '--state', state, '--max-agents-total', String(planned + 1)).code, 0)
  const { stop } = await drive(state, act())
  assert.equal(stop.stop, 'limit', JSON.stringify(stop))
  const s = st(state)
  const open = s.intents.filter((i) => i.state === 'open').map((i) => i.id)
  assert.ok(open.length > 0)
  assert.deepEqual([...(stop.open_intents || [])].map((x) => x.id || x).sort(), open.sort(), JSON.stringify(stop))
})

test('完了: 全ての単位が seen か理由つきの disclosed、開いた意図が 0 のときだけ complete。読めなかった単位があっても開示して complete', async (t) => {
  const { state, paths } = project(t, FILES)
  await passPlan(state)
  const a = act({ file: (task) => (task.unit.path === paths['c.md'] ? { seen: [] } : undefined) })
  const { stop } = await drive(state, a)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const s = st(state)
  assert.ok(s.units.every((u) => u.state === 'seen' || (u.state === 'disclosed' && u.reason)), JSON.stringify(s.units))
  assert.equal(s.units.find((u) => u.path === paths['c.md']).state, 'disclosed')
  assert.equal(s.intents.filter((i) => i.state === 'open').length, 0)
})

test('B4 callId（全体の段）: 閉じた呼び出しで取った意図の submit・query は終了状態 2 で拒み、台帳を変えない', async (t) => {
  const { state } = project(t, FILES)
  await passPlan(state)
  await fileStage(state, act())
  const n = cli('next', '--state', state)
  assert.ok(n.args_path, JSON.stringify(n))
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  let held = null
  for (const w of args.workers) {
    const c = cli('claim', '--state', state, '--call', args.callId, '--worker', w.id)
    if (c.tasks && c.tasks.length) { held = { c, w }; break }
  }
  assert.ok(held && held.c.tasks[0].intent, '意図の担当を取った')
  const f = path.join(state, 'late.json')
  writeFileSync(f, JSON.stringify({ agents: [], tokens: null }))
  assert.equal(cli('ingest', '--state', state, '--call', args.callId, '--result', f).code, 0)
  const before = JSON.stringify(st(state))
  const task = held.c.tasks[0]
  writeFileSync(task.result_path, JSON.stringify({ verdict: 'consistent', quote: QA }))
  assert.equal(run('query', '--state', state, '--call', args.callId, '--worker', held.w.id, '--task', task.id).code, 2)
  const words = held.c.submit_cmd
  assert.ok(words.includes('submit'))
  assert.equal(run('submit', '--state', state, '--call', args.callId, '--worker', held.w.id).code, 2)
  assert.equal(JSON.stringify(st(state)), before)
})
