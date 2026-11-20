// coverage-build の 2 つの Workflow source が Codex の runner（dynamic-workflow-runner の runtime）でも動くことを、偽の backend で確かめる。
// 偽の backend は担当と同じく束（brief）の写しを読む。実際の Codex の worker が stateDir を読めるかは、このテストでは確かめていない。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Workflow } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs'
import { readSourceMetadata } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs'
import { C, WRITE_LIMITS } from '../.agents/skills/coverage-build/scripts/build-core.mjs'
import { SOURCES, drive, mockAgent, runWorkflow, setup, tmp } from '../.agents/skills/coverage-build/scripts/test-harness.mjs'
import { bodyLiteral } from './helpers/workflow-source.mjs'

const TEXT = { step: readFileSync(SOURCES.step, 'utf8'), write: readFileSync(SOURCES.write, 'utf8') }
const META = { step: readSourceMetadata(TEXT.step), write: readSourceMetadata(TEXT.write) }
const ROLES = JSON.parse(readFileSync(path.join(path.dirname(SOURCES.step), 'roles.json'), 'utf8'))

test('meta: limits の写しが本体と一致し、書く source と書かない source の権限が分かれる', () => {
  assert.deepEqual({ ...META.step.limits }, bodyLiteral(TEXT.step, 'LIMITS'))
  assert.deepEqual({ ...META.step.limits }, { ...C.LIMITS })
  assert.deepEqual({ ...META.write.limits }, bodyLiteral(TEXT.write, 'LIMITS'))
  assert.deepEqual({ ...META.write.limits }, { ...WRITE_LIMITS })
  assert.deepEqual([...META.step.requirements], ['read-only', 'fresh-thread'])
  assert.deepEqual([...META.write.requirements], ['fresh-thread', 'workspace-write'])
  const sum = (t) => t.slice(t.indexOf('// <sum>'), t.indexOf('// </sum>'))
  assert.equal(sum(TEXT.write), sum(TEXT.step), 'args の照合の式は 2 つの source で同じ文')
  for (const role of ['goal_checker', 'architect', 'unit_designer', 'test_writer', 'implementer', 'retro_planner', 'retro_examiner', 'retro_verifier']) {
    assert.ok(ROLES[role] && ROLES[role].model && ROLES[role].effort && ROLES[role].why, `roles.json に ${role} の model・effort・理由がある`)
  }
  assert.notEqual(ROLES.test_writer.model, ROLES.implementer.model, 'テストと実装は別のモデル')
  assert.notEqual(ROLES.retro_examiner.model, ROLES.retro_verifier.model, '振り返りの実行役と検証役は別のモデル')
})

const backend = (agentFn, caps) => ({ capabilities: caps, run: (prompt, options) => agentFn(prompt, options) })
function viaRunner(t) {
  return (args, agentFn) => {
    const write = ['tests', 'implement'].includes(args.stage)
    const kind = write ? 'write' : 'step'
    const caps = write ? ['read-only', 'fresh-thread', 'workspace-write'] : ['read-only', 'fresh-thread']
    return Workflow({ scriptPath: SOURCES[kind], args }, { backend: backend(agentFn, caps), runDir: path.join(tmp(t), 'run'), trustedSource: true, ...META[kind].limits })
  }
}

test('runner: create の流れが 2 つの source で最後まで回る', async (t) => {
  const { state } = setup(t, { checks: [['node', '-e', 'process.exit(0)']] })
  const { stop, steps } = await drive(state, mockAgent(), { run: viaRunner(t) })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual([...new Set(steps.map((s) => s.step))], ['design', 'audit', 'tests', 'implement', 'checks'])
  assert.ok(steps.filter((s) => s.res).every((s) => s.res.tokens === null), 'runner では消費量を読めないので null')
})

test('runner: 書き込みの権限が無い backend では書く source を拒否する', async (t) => {
  const { state } = setup(t)
  const reject = (args, agentFn) => {
    if (!['tests', 'implement'].includes(args.stage)) return viaRunner(t)(args, agentFn)
    return Workflow({ scriptPath: SOURCES.write, args }, { backend: backend(agentFn, ['read-only', 'fresh-thread']), runDir: path.join(tmp(t), 'run'), trustedSource: true, ...META.write.limits })
  }
  await assert.rejects(drive(state, mockAgent(), { run: reject }), /workspace-write/)
})

// ---- 呼び出しごとの消費量を、差で記録する（単位 P12）----
// native は budget.spent()（run 全体の累計）を注入する。各 source は本体の始めと返す直前に読み、tokens にその差を入れる。
// 累計をそのまま入れると、呼び出しごとの費用が読めず、呼び出し間の比べ方が成り立たない。
// budget.spent() が何を数えるか（司令塔・担当の入力・出力のどれか）は確かめていない。ここでは同じ量の差どうしだけを比べる。
const BASE = 10_000_000
const COST = 100
const DIFF_NOTE = 'この呼び出しの budget.spent() の差'

// 読んでも進まず、担当の起動ごとに COST だけ進む計器。1 回の呼び出しの消費量は担当の起動数 × COST になる。
function metered() {
  const m = { v: BASE, spent: () => m.v }
  m.agent = (fn) => (...a) => { m.v += COST; return fn(...a) }
  return m
}
// 読むたびに step だけ進む計器。始めと返す直前の 2 回の読みの差は step になる。
function ticking(step = 1000) {
  const m = { v: BASE, spent: () => { m.v += step; return m.v } }
  return m
}
// 読むたびに列の次の値を返す計器（最後の値は繰り返す）。
function sequence(...vals) {
  let i = 0
  return { spent: () => vals[Math.min(i++, vals.length - 1)] }
}
const ledgerOf = (state) => JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8'))

const buildRun = (budget) => (args, fn) => runWorkflow(args, fn, { budget })

test('tokens: 呼び出しごとの tokens は担当の起動で増えた分の差で、累計を入れず、台帳の calls と tokens_note に同じ差が残る（書かない source と書く source の両方）', async (t) => {
  const { state } = setup(t, { checks: [['node', '-e', 'process.exit(0)']] })
  const m = metered()
  const consumed = []
  const run = async (args, fn) => {
    const before = m.v
    const res = await buildRun(m)(args, m.agent(fn))
    consumed.push(m.v - before)
    return res
  }
  const { stop, steps } = await drive(state, mockAgent(), { run })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const called = steps.filter((s) => s.res)
  assert.ok(called.length >= 4)
  assert.ok(['design', 'tests', 'implement'].every((k) => called.some((s) => s.step === k)), '書かない source と書く source の両方を通る')
  assert.equal(consumed.length, called.length)
  assert.deepEqual(called.map((s) => s.res.tokens), consumed, 'tokens は呼び出しの中で増えた分')
  assert.ok(consumed.some((c) => c > 0))
  assert.ok(called.every((s) => s.res.tokens < BASE), '累計（run の始めからの総量）を入れない')
  const L = ledgerOf(state)
  assert.deepEqual(L.calls.map((c) => c.tokens), consumed, '台帳の calls[].tokens も差')
  assert.ok(L.calls.every((c) => c.tokens_note === DIFF_NOTE), `tokens_note は「${DIFF_NOTE}」`)
})

test('tokens: 読むたびに進む計器でも、始めと返す直前の 2 回の読みの差になる', async (t) => {
  const { state } = setup(t, { checks: [['node', '-e', 'process.exit(0)']] })
  const m = ticking(1000)
  const { stop, steps } = await drive(state, mockAgent(), { run: buildRun(m) })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const called = steps.filter((s) => s.res)
  assert.ok(called.length >= 4)
  assert.ok(called.every((s) => s.res.tokens === 1000), JSON.stringify(called.map((s) => s.res.tokens)))
  assert.ok(ledgerOf(state).calls.every((c) => c.tokens === 1000 && c.tokens_note === DIFF_NOTE))
})

for (const [name, budget] of [
  ['budget が無い', undefined],
  ['spent が無い', {}],
  ['始めに読めない', sequence(undefined, BASE)],
  ['返す直前に読めない', sequence(BASE, undefined)],
]) {
  test(`tokens: ${name}ときは null で、台帳の tokens_note は読めない経路のまま`, async (t) => {
    const { state } = setup(t)
    const { steps } = await drive(state, mockAgent(), { run: buildRun(budget), maxSteps: 1 })
    assert.equal(steps.length, 1)
    assert.equal(steps[0].res.tokens, null, '片方でも読めなければ、累計を差として入れず null')
    const c = ledgerOf(state).calls[0]
    assert.equal(c.tokens, null)
    assert.match(c.tokens_note, /読めない/)
  })
}
