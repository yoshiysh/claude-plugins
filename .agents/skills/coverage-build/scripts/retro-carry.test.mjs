// P11: 振り返りで、起動の枠に入らない意図を落とさず次の呼び出しへ回す。
// 計画役の mock が枠を超える数の意図を返し、実行役・検証役は意図の仮説（R<巡>仮説<番号>）で結果を決める。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { C } from './build-core.mjs'
import { auditStatus, drive, mockAgent, runWorkflow, setup } from './test-harness.mjs'

const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8'))
// 計画役の呼び出しでは、計画役の 1 体を引いた残りの 1/3、carry の呼び出しでは起動数の 1/3 が意図の枠。
const FRAME_PLAN = Math.floor((C.LIMITS.maxAgents - 1) / 3)
const FRAME_CARRY = Math.floor(C.LIMITS.maxAgents / 3)
const TERMINAL = ['accepted', 'refuted', 'unclear', 'rejected']
const hyp = (r, j) => `R${r}仮説${j}`
// 実行役・検証役の prompt が指す意図の仮説。計画役の呼び出しでは prompt に意図の本文がある。carry の呼び出しでは prompt は意図を id で名指しし、
// 本文は束の「流す意図」の節の `- I<n>: {...}` の行にあるので、本物の担当と同じく束を Read して引く。
function hypothesisOf(prompt) {
  const direct = /R\d+仮説\d+/.exec(prompt)
  if (direct) return direct[0]
  const brief = /Read で (\S+) を全て読む/.exec(prompt)
  const id = /「流す意図」の節の (I\d+) を読む/.exec(prompt)
  if (!brief || !id) return null
  const line = readFileSync(brief[1], 'utf8').split('\n').find((l) => l.startsWith(`- ${id[1]}: `))
  const m = line && /R\d+仮説\d+/.exec(line)
  return m ? m[0] : null
}
const ids = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `I${from + i}`)

// 実行役・検証役の偽物。spec.n(巡) は計画役が返す意図の数、spec.kind(巡, 番号) は実行役の結果の種類。
// ラベルの付け方に依らないよう、役は label の頭で見分け、意図は prompt の仮説で見分ける。
function retroAgent(state, log, spec) {
  const base = mockAgent({}, log)
  let round = 0
  let last = { intents: [] }
  const evidence = [{ path: path.join(state, 'design', 'U1.md'), quote: '入力を受け取り、決まった値を返す。' }]
  return async (prompt, opts) => {
    const head = opts.label.split('（')[0]
    const retry = opts.label.includes('やり直し')
    if (head.startsWith('retro-plan')) {
      log.push({ label: opts.label, model: opts.model, effort: opts.effort, prompt })
      if (retry) return last
      round += 1
      const n = spec.n ? spec.n(round) : 0
      last = { intents: Array.from({ length: n }, (_, j) => ({ basis: spec.basis || ['E1'], hypothesis: hyp(round, j), layer: '設計', look_at: [path.join(state, 'design', 'U1.md')] })) }
      return last
    }
    if (head.startsWith('retro-exam')) {
      log.push({ label: opts.label, model: opts.model, effort: opts.effort, prompt })
      const m = /R(\d+)仮説(\d+)/.exec(hypothesisOf(prompt) || '')
      const kind = m ? spec.kind(Number(m[1]), Number(m[2])) : 'unclear'
      if (kind === 'accepted') return { verdict: 'supported', cause: '設計が値を決めていない', layer: '設計', evidence }
      if (kind === 'rejected') return { verdict: 'supported', cause: '偽', layer: '設計', evidence: [{ path: evidence[0].path, quote: 'この文は設計のどこにも無い文である' }] }
      return { verdict: kind, cause: '', layer: '実装', evidence: [] }
    }
    if (head.startsWith('retro-judge')) {
      log.push({ label: opts.label, model: opts.model, effort: opts.effort, prompt })
      return { accept: true, reason: '記録が支える' }
    }
    return base(prompt, opts)
  }
}

// 設計の欠陥でなく実装の検査の指摘（1 度だけ）から出来事を作る。E1 は src/a.mjs、E2 は test/a.test.mjs。
const implOnce = (files) => (s) => {
  let n = 0
  return (phase) => (phase === 'impl' && n++ === 0 ? auditStatus({ phase, confirmed: files.map((f) => ({ path: path.join(s.repo, f), quote: 'export const value = 2', layer: '実装' })) }) : auditStatus({ phase }))
}
const ONE = implOnce(['src/a.mjs'])
const TWO = implOnce(['src/a.mjs', 'test/a.test.mjs'])

// 1 手ずつ流し、各呼び出しの取り込み後の台帳・args・起動の記録を残す。
async function trace(t, { audit = ONE, spec, until = null, run = null }) {
  const s = setup(t)
  const log = []
  const agent = retroAgent(s.state, log, spec)
  const au = audit(s)
  const calls = []
  for (let i = 0; i < 80; i++) {
    const from = log.length
    const r = await drive(s.state, agent, { audit: au, maxSteps: 1, ...(run ? { run } : {}) })
    if (r.stop) return { ...s, calls, stop: r.stop, log }
    const st = r.steps[0]
    assert.equal(st.ingest.code, 0, JSON.stringify(st.ingest))
    const made = log.slice(from)
    calls.push({ step: st.step, phase: st.phase, args: st.args, L: ledger(s.state), plans: made.filter((x) => x.label.startsWith('retro-plan') && !x.label.includes('やり直し')), exams: made.filter((x) => x.label.startsWith('retro-exam') && !x.label.includes('やり直し')) })
    if (until && until(calls[calls.length - 1])) return { ...s, calls, stop: null, log }
  }
  throw new Error('止まらない')
}
const retros = (calls) => calls.filter((c) => c.step === 'retro')
const statusOf = (L, h) => L.intents.find((i) => i.hypothesis === h).status
const briefOf = (args) => readFileSync(path.join(args.snapDir, args.brief.path), 'utf8')

test('枠を超える意図は queued で残り、次の呼び出しの carry で流し切る。巡は計画役の 1 回だけ（枠 + 5 件）', async (t) => {
  const N = FRAME_PLAN + 5
  const carried = ['refuted', 'rejected', 'accepted', 'unclear', 'refuted']
  const kind = (r, j) => (j < FRAME_PLAN ? 'unclear' : carried[j - FRAME_PLAN])
  const x = await trace(t, { spec: { n: () => N, kind } })
  const rs = retros(x.calls)
  assert.equal(rs.length, 2, '振り返りの呼び出しは 2 回')
  const [first, second] = rs
  const planLabels = x.log.filter((l) => l.label.startsWith('retro-plan') && !l.label.includes('やり直し'))
  assert.equal(planLabels.length, 1, '計画役の起動は 1 回')
  assert.ok(!first.args.carry || first.args.carry.length === 0, '計画役の呼び出しの args に carry は無い')
  assert.equal(first.plans.length, 1)

  // 1 回目の後: 枠に入った分は結果の status、入らなかった 5 件は queued。not_run は残らない。
  assert.equal(first.L.intents.length, N)
  assert.deepEqual(first.L.intents.filter((i) => i.status === 'queued').map((i) => i.id), ids(FRAME_PLAN + 1, N))
  assert.ok(first.L.intents.every((i) => i.status !== 'not_run'), 'not_run で終わらせない')
  assert.equal(first.L.retro.rounds, 1)

  // 2 回目: carry は 1 回目に入らなかった 5 件の id を意図の順に持つ。計画役は起動せず、その 5 件だけを実行役に流す。
  assert.deepEqual(second.args.carry, ids(FRAME_PLAN + 1, N))
  assert.equal(second.plans.length, 0, 'carry の呼び出しは計画役を起動しない')
  assert.equal(second.exams.length, 5)
  const sent = second.exams.map((e) => hypothesisOf(e.prompt)).sort()
  assert.deepEqual(sent, carried.map((_, k) => hyp(1, FRAME_PLAN + k)).sort(), '実行役に流すのは carry の意図だけ')
  const text = briefOf(second.args)
  for (let k = 0; k < 5; k++) assert.ok(text.includes(hyp(1, FRAME_PLAN + k)), '意図の本文は束に入る')
  assert.ok(!JSON.stringify(second.args).includes('仮説'), 'args に意図の本文を載せない')

  // 2 回目の後: 全ての意図が実行役の結果の status。巡は増えず、新しい意図も足されず、受理があれば dry は 0。
  const L = second.L
  assert.equal(L.intents.length, N, '新しい意図を足さない')
  assert.ok(L.intents.every((i) => TERMINAL.includes(i.status)), JSON.stringify(L.intents.map((i) => i.status)))
  carried.forEach((k, m) => assert.equal(statusOf(L, hyp(1, FRAME_PLAN + m)), k, `carry の意図 ${m} の結果`))
  for (let j = 0; j < FRAME_PLAN; j++) assert.equal(statusOf(L, hyp(1, j)), 'unclear', '1 回目の結果は書き換えない')
  assert.equal(L.retro.rounds, 1, 'carry の呼び出しは巡を増やさない')
  assert.equal(L.retro.dry, 0, 'carry に受理があれば dry は 0')
  assert.equal(L.facts.length, 1)
})

test('queued が残る間は、原因が辿れた後でも巡の上限の後でも carry の呼び出しを続け、尽きてから route へ進む。carry は枠の件数まで', async (t) => {
  const N = FRAME_PLAN + FRAME_CARRY + 3
  const first = FRAME_PLAN // 最初に carry へ回る意図が受理される（E1 が覆われる）
  const x = await trace(t, { spec: { n: () => N, kind: (r, j) => (j === first ? 'accepted' : 'unclear') } })
  const rs = retros(x.calls)
  assert.equal(rs.length, 3, '計画役 → carry → carry')
  assert.deepEqual(rs[1].args.carry, ids(FRAME_PLAN + 1, FRAME_PLAN + FRAME_CARRY), '枠の件数まで')
  assert.deepEqual(rs[2].args.carry, ids(FRAME_PLAN + FRAME_CARRY + 1, N), '入らなかった残りは次の呼び出しへ')
  assert.deepEqual(rs[1].L.intents.filter((i) => i.status === 'queued').map((i) => i.id), ids(FRAME_PLAN + FRAME_CARRY + 1, N), '残りは queued のまま')
  assert.equal(rs[1].L.facts.length, 1, 'この時点で E1 は覆われている（それでも振り返りを終えない）')
  assert.equal(rs[2].exams.length, 3)
  assert.ok(rs[2].L.intents.every((i) => TERMINAL.includes(i.status)))
  assert.equal(rs[2].L.retro.rounds, 1)
  assert.equal(x.log.filter((l) => l.label.startsWith('retro-plan') && !l.label.includes('やり直し')).length, 1)
  const at = x.calls.indexOf(rs[2])
  assert.notEqual(x.calls[at + 1].step, 'retro', 'queued が尽きたら次は route を経て retro 以外へ')
})

test('巡の上限（2 巡目）の計画役が枠を超えても流し切り、3 巡目の計画役を起動せずに route へ進む', async (t) => {
  const N = FRAME_PLAN + 5
  // 各巡で E1 だけを覆う原因が受理される（E2 は覆われない）ので、dry の上限でなく巡の上限で止まる。
  const kind = (r, j) => (j === FRAME_PLAN + 2 ? 'accepted' : 'unclear')
  const x = await trace(t, { audit: TWO, spec: { n: () => N, kind } })
  const rs = retros(x.calls)
  assert.deepEqual(rs.map((c) => !!(c.args.carry && c.args.carry.length)), [false, true, false, true], '計画役 → carry → 計画役 → carry')
  assert.equal(x.log.filter((l) => l.label.startsWith('retro-plan') && !l.label.includes('やり直し')).length, 2, '計画役は 2 回だけ')
  assert.equal(rs[0].L.retro.rounds, 1)
  assert.equal(rs[1].L.retro.rounds, 1, 'carry は巡を増やさない')
  assert.equal(rs[2].L.retro.rounds, 2)
  assert.equal(rs[3].L.retro.rounds, 2, '巡の上限に達した後の carry も巡を増やさない')
  assert.equal(rs[2].L.intents.filter((i) => i.status === 'queued').length, 5, '巡の上限の巡も、枠を超えた分は queued で残る')
  assert.deepEqual(rs[3].args.carry, ids(N + FRAME_PLAN + 1, 2 * N))
  assert.ok(rs[3].L.intents.every((i) => TERMINAL.includes(i.status)), '2 巡目の意図も流し切る')
  assert.equal(rs[3].L.intents.length, 2 * N)
  assert.equal(rs[3].L.retro.dry, 0, '受理があったので dry の上限ではなく、巡の上限だけで止まった')
  assert.ok(rs[3].L.events.some((e) => !e.retro) && rs[3].L.facts.every((f) => f.basis.includes('E1')), 'E2 は覆われないまま（被覆でも止まっていない）')
  const at = x.calls.indexOf(rs[3])
  assert.notEqual(x.calls[at + 1].step, 'retro', '3 巡目を始めずに route へ進む')
})

test('dry は carry の呼び出しで二重に数えない: 受理が無い巡は 1 回だけ数え、dry の上限は次の巡の判断にだけ効く', async (t) => {
  const N = FRAME_PLAN + 5
  const x = await trace(t, { spec: { n: () => N, kind: () => 'unclear' } })
  const rs = retros(x.calls)
  assert.deepEqual(rs.map((c) => !!(c.args.carry && c.args.carry.length)), [false, true, false, true])
  assert.equal(rs[1].L.retro.dry, 1, '受理が無い巡の後の dry は 1（carry で増やさない）')
  assert.equal(rs[1].L.retro.rounds, 1)
  assert.equal(x.log.filter((l) => l.label.startsWith('retro-plan') && !l.label.includes('やり直し')).length, 2, 'dry が 1 なので 2 巡目の計画役は起動する')
  assert.equal(rs[3].L.retro.dry, 2)
  assert.ok(rs[3].L.intents.every((i) => TERMINAL.includes(i.status)))
})

test('枠ちょうどの件数なら queued も carry の呼び出しも要らない', async (t) => {
  const x = await trace(t, { spec: { n: (r) => (r === 1 ? FRAME_PLAN : 0), kind: () => 'unclear' } })
  const rs = retros(x.calls)
  assert.ok(rs.every((c) => !(c.args.carry && c.args.carry.length)), 'carry の呼び出しを挟まない')
  assert.ok(x.calls.every((c) => c.L.intents.every((i) => i.status !== 'queued' && i.status !== 'not_run')))
  assert.equal(rs[0].L.intents.length, FRAME_PLAN)
  assert.ok(rs[0].L.intents.every((i) => i.status === 'unclear'))
})

test('retro の args は knownIds でなく known（出来事の番号の範囲・事実の件数・群の id）を持つ', async (t) => {
  const N = FRAME_PLAN + 5
  const x = await trace(t, { audit: TWO, spec: { n: () => N, kind: (r, j) => (j === FRAME_PLAN + 2 ? 'accepted' : 'unclear') } })
  const rs = retros(x.calls)
  assert.deepEqual(rs[0].args.known, { events: [1, 2], facts: 0, groups: [] })
  assert.equal(rs[0].args.knownIds, undefined, '個別の id の一覧は載せない')
  assert.equal(rs[2].args.known.facts, rs[1].L.facts.length, '事実は件数で渡す')
  assert.deepEqual(rs[2].args.known.events, [1, 2])
  assert.deepEqual(rs[2].args.known.groups, [])
  assert.ok(!JSON.stringify(rs[0].args).includes('"E1"'), '出来事の id を並べない')
})

test('Workflow の checkIntents は範囲で照らす: 範囲内の出来事・件数内の事実だけを根拠にでき、範囲の外・群の無い id は intent_problems になる', async (t) => {
  const N = FRAME_PLAN + 5
  const x = await trace(t, { audit: TWO, spec: { n: () => N, kind: (r, j) => (j === FRAME_PLAN + 2 ? 'accepted' : 'unclear') } })
  const rs = retros(x.calls)
  const probe = async (args, b) => {
    const agent = mockAgent({ 'retro-plan': () => ({ intents: [{ basis: [b], hypothesis: '照らす', layer: '設計', look_at: ['x'] }] }) })
    return (await runWorkflow(args, agent)).intent_problems
  }
  // 1 回目: 出来事 [1, 2]、事実 0 件
  for (const b of ['E1', 'E2']) assert.deepEqual(await probe(rs[0].args, b), [], `${b} は範囲内`)
  for (const b of ['E0', 'E3', 'E99', 'F1', 'c1:design:G1']) assert.ok((await probe(rs[0].args, b)).length > 0, `${b} は範囲の外か、群に無い`)
  // 3 回目（2 巡目の計画役）: 事実 1 件
  assert.deepEqual(rs[2].args.known.facts, 1)
  assert.deepEqual(await probe(rs[2].args, 'F1'), [], 'F1 は件数内')
  assert.ok((await probe(rs[2].args, 'F2')).length > 0, 'F2 は件数の外')
})

test('CLI の ingestRetro は台帳の出来事・事実の id で照らす: 実在しない根拠の意図は受理せず、意図を残さない', async (t) => {
  let hit = false
  const run = async (args, agentFn) => {
    const res = await runWorkflow(args, agentFn)
    if (args.stage === 'retro' && !args.carry && !hit && res.intents && res.intents.intents.length) {
      hit = true
      res.intents.intents[0].basis = ['E99']
      res.intent_problems = []
    }
    return res
  }
  const x = await trace(t, { spec: { n: (r) => (r === 1 ? 2 : 0), kind: () => 'unclear' }, run })
  assert.ok(hit)
  const first = retros(x.calls)[0]
  assert.equal(first.L.intents.length, 0, '拒否した計画の意図は台帳に残さない')
  assert.equal(first.L.attempts.retro, 1)
  assert.ok(first.L.events.some((e) => e.stage === 'retro' && e.kind === 'rejected_output'))
})
