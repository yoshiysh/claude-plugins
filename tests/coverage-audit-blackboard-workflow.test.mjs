// 単位 4 のテスト: 役（ファイルの段・全体の段の判定役・確認役）と Workflow script（coverage-audit.js・roles.json）。
// 設計「台帳と見たの記録」の B3（返り値は agents と tokens だけ）・B4（args は {state, callId, wave} だけ。計画の「中心の仕組み」の波）・B5（集約は CLI）と、
// 「モデルと費用」の役の組（ファイルの段と全体の段は同じ組、名寄せは判定役が担う、確認は全体の段と別のモデルで effort を上げる）。
// 本物の source を native と同じ注入と、Codex の runner（dynamic-workflow-runner の runtime）の両方で流す。役は偽物で、prompt の claim の命令から台帳と読み書きする。
// tokens のテストだけは今の実装でも通る回帰の守り（呼び出しごとの差を返す仕組みを残す）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Workflow } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs'
import { readSourceMetadata } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs'
import { ROLES, WF, argOf, behave, driveScript, launchesOf, project, runScript, scriptAgent, status, tmp } from '../.agents/skills/coverage-audit/scripts/blackboard-fixture.mjs'

const META = readSourceMetadata(readFileSync(WF, 'utf8'))
const QA = 'この文書は台帳の lock を取ってから書き込むことを保証する。'
const QB = 'この文書は lock が書き込みを直列にすることを前提にする。'
const FILES = { 'a.md': `# A\n\n## 保証\n${QA}\n`, 'b.md': `# B\n\n## 前提\n${QB}\n` }
const MARK = 'MARKER-ファイルの段だけが書いた指摘の文'
const FACTS = (p) => (path.basename(p) === 'a.md'
  ? { guarantees: [{ subject: '台帳の lock', quote: QA, confidence: 'high' }], findings: [{ claim: MARK, quote: QA, severity: 'HIGH' }] }
  : { guarantees: [], premises: [{ subject: 'lock', quote: QB, confidence: 'high' }] })
const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max']
const backend = (agentFn) => ({ capabilities: ['read-only', 'fresh-thread', 'workspace-write'], run: (prompt, options) => agentFn(prompt, options) })
const viaRunner = (t) => (args, agentFn) => Workflow({ scriptPath: WF, args }, { backend: backend(agentFn), runDir: path.join(tmp(t), 'run'), trustedSource: true, ...META.limits })

async function fullRun(t, { runWf } = {}) {
  const { state } = project(t, FILES)
  const log = []
  // 主語の照合が矛盾の指摘を 1 件足す（確認の意図を作るため）。ファイルの段の指摘 MARK は既定のまま残す。
  const subject = (task, ctx) => {
    const q = ctx.query(task)
    const locs = q.basis.filter((f) => f.quote).map((f) => ({ unit: f.unit, quote: f.quote }))
    return { verdict: 'conflict', quote: locs[0].quote, findings: [{ claim: '主語の照合が足した矛盾の指摘', locations: locs, obligation: 'G1', confidence: 'high', severity: 'HIGH', layer: '方式設計' }] }
  }
  const r = await driveScript(state, scriptAgent(behave({ facts: FACTS, subject }), log), runWf ? { runWf: runWf(t) } : {})
  return { state, log, ...r }
}

test('roles.json: ファイルの段・全体の段の判定役・確認役がある。判定役はファイルの段と同じ組で名寄せも担い（名寄せの別の役は無い）、確認は判定役と別のモデルで effort が上', () => {
  for (const r of ['file_reader', 'global_judge', 'confirmer']) assert.ok(ROLES[r] && ROLES[r].model && ROLES[r].effort && ROLES[r].why, `roles.json に ${r} の model・effort・理由が無い`)
  assert.deepEqual([ROLES.global_judge.model, ROLES.global_judge.effort], [ROLES.file_reader.model, ROLES.file_reader.effort])
  assert.equal(ROLES.alias_judge, undefined, '名寄せは判定役が担い、別の小さいモデルの役を起動しない')
  assert.notEqual(ROLES.confirmer.model, ROLES.global_judge.model, '確認は全体の段と別のモデル（落とす判定の盲点を共有しない）')
  assert.ok(EFFORT.indexOf(ROLES.confirmer.effort) > EFFORT.indexOf(ROLES.global_judge.effort), '確認は effort を上げる（落とす側を厳しくする）')
  for (const gone of ['reader_1', 'reader_2', 'verifier', 'verifier_2']) assert.equal(ROLES[gone], undefined, `重ね（k）と枡ごとの検証役の役は無い: ${gone}`)
})

test('B3・B4: 全ての呼び出しで、args は {state, callId, wave} だけ、返り値は {agents, tokens} だけ。agents は起動した 1 体ごとに 1 件で、段・波・モデル・effort は起動した行の値', async (t) => {
  const { stop, steps, log } = await fullRun(t)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(steps.length >= 1)
  const launches = launchesOf(steps, log)
  for (const s of steps) {
    assert.deepEqual(Object.keys(s.args).sort(), ['callId', 'state', 'wave'], JSON.stringify(Object.keys(s.args)))
    assert.deepEqual(Object.keys(s.res).sort(), ['agents', 'tokens'], `返り値に役の出力や集約を載せない: ${Object.keys(s.res).join(', ')}`)
    const mine = launches.filter((x) => x.call === s.args.callId)
    assert.equal(s.res.agents.length, mine.length, '起動の記録は起動した 1 体ごとに 1 件（波をまたいで全て）')
    for (const x of mine) {
      const a = s.res.agents.find((r) => String(r.wave) === String(x.wave) && r.stage === x.stage && r.role === x.role && r.model === x.model && r.effort === x.effort)
      assert.ok(a, `起動の記録が起動した行と合う（stage・wave・model・effort）: ${JSON.stringify(x)} / ${JSON.stringify(s.res.agents)}`)
    }
  }
})

test('B1: Workflow が起動する全ての役の prompt は、その呼び出しの claim の命令（--state・--call・自分の --worker と、行の --wave・--model・--effort・--stage）を持ち、各波の行を 1 回ずつ起動する', async (t) => {
  const { stop, steps, log } = await fullRun(t)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(log.every((x) => x.claim), `claim の命令の無い役: ${log.filter((x) => !x.claim).map((x) => x.label)}`)
  const launches = launchesOf(steps, log)
  for (const s of steps) {
    const mine = log.filter((x) => argOf(x.claim, 'call') === s.args.callId)
    assert.ok(mine.every((x) => argOf(x.claim, 'state') === s.args.state))
    const first = mine.filter((x) => argOf(x.claim, 'wave') === String(s.args.wave.id))
    assert.deepEqual(first.map((x) => argOf(x.claim, 'worker')).sort(), s.args.wave.rows.map((w) => w.id).sort(), '最初の波は args の行ごとに 1 体')
    for (const x of first) {
      const w = s.args.wave.rows.find((r) => r.id === argOf(x.claim, 'worker'))
      assert.deepEqual([argOf(x.claim, 'model'), argOf(x.claim, 'effort'), argOf(x.claim, 'stage')], [w.model, w.effort, w.stage], 'claim の命令に行の値を埋める')
    }
  }
  const keys = launches.map((x) => `${x.call}|${x.wave}|${x.worker}`)
  assert.equal(new Set(keys).size, keys.length, `同じ波の同じ行を 2 回起動しない: ${keys}`)
  for (const x of log) assert.deepEqual([x.model, x.effort], [argOf(x.claim, 'model'), argOf(x.claim, 'effort')], 'agent の model・effort は claim の命令の値と同じ')
})

test('B1・B3: ファイルの段が書いた指摘の文は、どの役の prompt にも載らず、全体の段の役は query で台帳から引く（内容を prompt・返り値・args で運ばない）', async (t) => {
  const { stop, steps, log } = await fullRun(t)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  for (const x of log) assert.ok(!x.prompt.includes(MARK), `prompt に前の役の出力が載っている: ${x.label}`)
  for (const s of steps) assert.ok(!JSON.stringify(s.args).includes(MARK) && !JSON.stringify(s.res).includes(MARK))
  const queried = log.flatMap((x) => (x.rec ? x.rec.queries : []))
  assert.ok(queried.some((q) => JSON.stringify(q.out).includes(MARK)), '全体の段の役は query でファイルの段の指摘を引ける')
})

test('役と担当の種類: file は file_reader、alias・subject・finding・premise・goal は global_judge、confirm・group は confirmer の worker だけが取る', async (t) => {
  const { stop, steps, log } = await fullRun(t)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const want = { file: 'file_reader', alias: 'global_judge', subject: 'global_judge', finding: 'global_judge', premise: 'global_judge', goal: 'global_judge', confirm: 'confirmer', group: 'confirmer' }
  const seen = new Set()
  for (const x of launchesOf(steps, log)) {
    for (const c of x.claims) for (const task of c.tasks || []) {
      seen.add(task.kind)
      if (want[task.kind]) assert.equal(x.role, want[task.kind], `${task.kind} の担当を ${x.role} が取った`)
    }
  }
  for (const k of ['file', 'alias', 'subject', 'finding', 'goal', 'confirm', 'group']) assert.ok(seen.has(k), `${k} の担当が取られていない: ${[...seen]}`)
})

test('runner: Codex の runner でも同じ流れが complete まで回り、返り値は {agents, tokens} で tokens は null', async (t) => {
  const { stop, steps, state } = await fullRun(t, { runWf: viaRunner })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  for (const s of steps) {
    assert.deepEqual(Object.keys(s.res).sort(), ['agents', 'tokens'])
    assert.equal(s.res.tokens, null)
  }
  assert.ok(status(state).findings.confirmed.some((f) => f.claim === MARK))
})

test('tokens（回帰の守り。今の実装でも通る）: 返り値の tokens は本体の始めと返す直前の budget.spent() の差（累計を入れない）', async (t) => {
  const { state } = project(t, FILES)
  let v = 10_000_000
  const budget = { spent: () => { v += 1000; return v } }
  const { steps } = await driveScript(state, scriptAgent(behave({ facts: FACTS })), { runWf: (args, fn) => runScript(args, fn, { budget }), maxSteps: 2 })
  assert.ok(steps.length >= 1)
  for (const s of steps) assert.equal(s.res.tokens, 1000, JSON.stringify(s.res))
})

test('計画の段（利用者が観点を渡さない）: 目標の照合も担う計画役も、prompt で内容を受けず claim の命令で担当を取る', async (t) => {
  const { state } = project(t, FILES, { lenses: null, goalChecked: false, criteria: null, goal: '- G1: 対象の文書を観点ごとに確かめた指摘の一覧 〔request: 対象の文書を観点ごとにレビューしてほしい〕\n' })
  const log = []
  const { steps } = await driveScript(state, scriptAgent(() => null, log), { maxSteps: 1 })
  assert.equal(steps.length, 1, JSON.stringify(steps))
  assert.deepEqual(Object.keys(steps[0].args).sort(), ['callId', 'state', 'wave'])
  assert.ok(log.length > 0, '役を起動する')
  assert.ok(log.every((x) => x.claim && argOf(x.claim, 'call') === steps[0].args.callId), `claim の命令の無い役: ${log.filter((x) => !x.claim).map((x) => x.label)}`)
  for (const x of log) assert.ok(!x.prompt.includes('対象の文書を観点ごとにレビューしてほしい'), `依頼文を prompt に載せない（claim と query で引く）: ${x.label}`)
})
