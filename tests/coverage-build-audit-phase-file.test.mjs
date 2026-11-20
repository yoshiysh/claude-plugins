// 単位 1 のテスト（coverage-build の側）: coverage-build の auditPosOf は coverage-audit の台帳（ledger.json）を直接読まず、
// coverage-audit が init・reframe で書く stateDir/phase.json（{ phase, phase_start }）を path で読んで、同じ段の reframe を二重に発行しない（framed）。
// 設計「既存のスキルへの組み込み」の coverage-build との受け渡し（段の位置）と「今の食い違い」。2 つのスキルのファイルを使うので tests/ に置く。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as cb from '../.agents/skills/coverage-build/scripts/test-harness.mjs'
import { cli as auditCli } from '../.agents/skills/coverage-audit/scripts/blackboard-fixture.mjs'

const START1 = { cycle: 1, agents: 0, events: 0 }
// coverage-build の next を、最初の audit（設計レビュー）を返すまで回す（Workflow の段は偽の役で流す）。
async function untilAudit(state) {
  for (let i = 0; i < 20; i++) {
    const n = cb.cli('next', '--state', state)
    assert.equal(n.code, 0, JSON.stringify(n))
    if (n.step === 'audit') return n
    assert.ok(!n.stop, JSON.stringify(n))
    const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
    const res = await cb.runWorkflow(args, cb.mockAgent())
    const f = path.join(state, `result-${n.call_id}.json`)
    writeFileSync(f, JSON.stringify(res))
    assert.equal(cb.cli('ingest', '--state', state, '--result', f).code, 0)
  }
  throw new Error('audit に届かない')
}
const keysOf = (a) => ['framed', 'init_argv', 'reframe_argv'].filter((k) => a[k] !== undefined)

test('framed: 台帳（ledger.json）が読めなくても、phase.json が init の段にあれば framed にする（coverage-build は ledger.json を読まない）', async (t) => {
  const { state } = cb.setup(t)
  const n = await untilAudit(state)
  assert.deepEqual(keysOf(n.audit), ['init_argv'])
  mkdirSync(n.audit.state, { recursive: true })
  writeFileSync(path.join(n.audit.state, 'phase.json'), JSON.stringify({ phase: 'design', phase_start: START1 }))
  writeFileSync(path.join(n.audit.state, 'ledger.json'), '{')
  const again = cb.cli('next', '--state', state)
  assert.equal(again.step, 'audit', JSON.stringify(again))
  assert.deepEqual(keysOf(again.audit), ['framed'], `phase.json から段の位置を読む: ${JSON.stringify(again.audit)}`)
})

test('framed: phase.json が無ければ、ledger.json が段と段の始まりを持っていても framed にしない（段の位置は phase.json だけから読む）', async (t) => {
  const { state } = cb.setup(t)
  const n = await untilAudit(state)
  mkdirSync(n.audit.state, { recursive: true })
  writeFileSync(path.join(n.audit.state, 'ledger.json'), JSON.stringify({ phase: 'design', phase_start: START1 }))
  const again = cb.cli('next', '--state', state)
  assert.equal(again.step, 'audit', JSON.stringify(again))
  assert.notEqual(again.audit.framed, true, `ledger.json だけで framed にしない: ${JSON.stringify(again.audit)}`)
})

test('framed: 本物の coverage-audit に init_argv を流した後、台帳の中身を壊しても phase.json から framed になり、phase.json は init の段を持つ', async (t) => {
  const { state } = cb.setup(t)
  const n = await untilAudit(state)
  const r = auditCli(...n.audit.init_argv)
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.ok(existsSync(path.join(n.audit.state, 'phase.json')), 'coverage-audit の init が phase.json を書く')
  const p = JSON.parse(readFileSync(path.join(n.audit.state, 'phase.json'), 'utf8'))
  assert.equal(p.phase, 'design')
  writeFileSync(path.join(n.audit.state, 'ledger.json'), '{')
  const again = cb.cli('next', '--state', state)
  assert.deepEqual(keysOf(again.audit), ['framed'], JSON.stringify(again.audit))
  rmSync(path.join(n.audit.state, 'phase.json'))
  const third = cb.cli('next', '--state', state)
  assert.notEqual(third.audit.framed, true, 'phase.json が消えれば段の位置が分からないので framed にしない')
})
