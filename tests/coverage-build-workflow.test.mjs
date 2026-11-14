// coverage-build の 2 つの Workflow source が Codex の runner（dynamic-workflow-runner の runtime）でも動くことを、偽の backend で確かめる。
// 偽の backend は担当と同じく束（brief）の写しを読む。実際の Codex の worker が stateDir を読めるかは、このテストでは確かめていない。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Workflow } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs'
import { readSourceMetadata } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs'
import { C, WRITE_LIMITS } from '../.agents/skills/coverage-build/scripts/build-core.mjs'
import { SOURCES, drive, mockAgent, setup, tmp } from '../.agents/skills/coverage-build/scripts/test-harness.mjs'
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
