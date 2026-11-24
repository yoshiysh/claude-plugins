// 書き換え（波の形）: 以前は coverage-build の next が coverage-audit の段の位置（stateDir/phase.json）を読み、同じ段の reframe を二重に発行しない（framed）ことを確かめた。
// 検査を CLI が同じ process で流す形では argv を返す経路（framed・init_argv・reframe_argv）が無いので、段の位置のファイルが今も coverage-audit の
// init・reframe で書かれ、検査の段ごとに今の段を指すことを確かめる（build の外から検査の段を読む口として残す）。
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
