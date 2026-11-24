// 段の位置のファイル（stateDir/audit/state/phase.json）が coverage-audit の init・reframe で書かれ、検査の段ごとに今の段を指すことを確かめる
// （build の外から検査の段を読む口）。
// 2 つのスキルのファイルを使うので tests/ に置く。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as cb from '../.agents/skills/coverage-build/scripts/test-harness.mjs'

test('段の位置: 検査の役が担当を取る時点で、stateDir/audit/state/phase.json はその検査の段（設計レビュー → 実装レビュー）を指し、段が変わると phase_start も変わる', async (t) => {
  const { state } = cb.setup(t)
  const file = path.join(state, 'audit', 'state', 'phase.json')
  const seen = []
  const plan = () => { const p = JSON.parse(readFileSync(file, 'utf8')); if (!seen.some((x) => JSON.stringify(x) === JSON.stringify(p))) seen.push(p); return undefined }
  const { stop } = await cb.drive(state, cb.mockAgent(), { auditOver: { plan } })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(existsSync(file), 'coverage-audit の init が phase.json を書く')
  assert.deepEqual(seen.map((x) => x.phase), ['design', 'impl'])
  assert.notDeepEqual(seen[0].phase_start, seen[1].phase_start, 'reframe で段の始まりが変わる')
})
