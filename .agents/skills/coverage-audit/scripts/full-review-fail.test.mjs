// 全文レビューの失敗の経路と再開（設計 docs/design/coverage-ledger-method.md の段の構成「全文レビュー」の失敗、完了と止める条件の再開の規則）。
// - 役が返らなかった（lost）失敗は環境の失敗なので、blocked（failure）からの再開と、止まった後の新しい回の始まりに読み直しにする。
// - 照合に落ち続けた失敗（rejected）と、返ったが提出の無いまま試行の上限に達した失敗（unsubmitted）は戻さない。
// 役の偽物と全文レビューの結果の形は full-review-fixture.mjs のものを使う（期待値の形を足さない）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { MAX_ATTEMPTS, UNIT_MAX_BYTES } from './ledger-core.mjs'
import { agentStages, driveScript, project, scriptAgent, status } from './blackboard-fixture.mjs'
import { sizedDoc } from './launch-fixture.mjs'
import { FR_STAGE, frAct, frFacts, frFinding, frStatus, loc } from './full-review-fixture.mjs'

const plain = (n) => `# ${n}\n\n## 節\n${n} の節は主張を一つだけ述べる本文の行である。\n`
const QA = '文書A の節は主張を一つだけ述べる本文の行である。'
const SMALL = { 'a.md': plain('文書A'), 'b.md': plain('文書B') }
// fixture の大きさは線の既定（UNIT_MAX_BYTES）に比例させる（100KB の線で作った大きさの倍率）。
const S = UNIT_MAX_BYTES / 100000
// 読む範囲は a.md だけ（a+b が UNIT_MAX_BYTES を超える）。d.md は範囲の外。
const BIG = { 'a.md': sizedDoc('a', 60000 * S), 'b.md': sizedDoc('b', 50000 * S), 'd.md': sizedDoc('d', 5000 * S) }
const FR_A = 'FR-再開で読んだ指摘'
// 読む範囲の最初の単位（a.md）の、見出しでも空でもない最初の本文の行を引く指摘。
const bodyLine = (u) => readFileSync(u.file, 'utf8').split('\n').slice(u.start - 1, u.end).find((l) => l.trim() && !/^#/.test(l))
const oneFinding = (units) => [frFinding(FR_A, [loc(units, 'a.md', bodyLine(units[0]))])]
// phases の段で役を落とす（throw）か、返すだけで何もしない（noop）偽の agent。
const failing = (inner, { throwIn = [], noopIn = [] } = {}) => async (prompt, opts) => {
  if (throwIn.includes(opts.phase)) throw new Error('時間の上限に当たった')
  if (noopIn.includes(opts.phase)) return { notes: [] }
  return inner(prompt, opts)
}
const run = (state, agent) => driveScript(state, agent, { maxSteps: 40 })
// 全文レビューの起動の数（返らない役・何もしない役も、Workflow の起動の記録の stage で数える。1 つの呼び出しが段をまたぐので呼び出しでは数えない）。
const frSteps = (r) => agentStages(r.steps).filter((x) => x === FR_STAGE)
const good = () => scriptAgent(frAct({ frFindings: oneFinding }), [])

test('lost: 役が返らない全文レビューは cause lost で失敗し、blocked（failure）から再開すると読み直して complete まで行く', async (t) => {
  const { state } = project(t, SMALL)
  const r1 = await run(state, failing(good(), { throwIn: [FR_STAGE, 'file'] }))
  assert.equal(r1.stop.stop, 'blocked', JSON.stringify(r1.stop))
  assert.equal(r1.stop.cause, 'failure')
  assert.equal(frSteps(r1).length, 1, '返らない全文レビューは 1 回で失敗にする')
  const s1 = frStatus(status(state))
  assert.equal(s1.state, 'failed')
  assert.equal(s1.cause, 'lost')
  const r2 = await run(state, good())
  assert.equal(r2.stop.stop, 'complete', JSON.stringify(r2.stop))
  assert.equal(frSteps(r2).length, 1, `再開で全文レビューを読み直す: ${agentStages(r2.steps)}`)
  const s = status(state)
  assert.equal(frStatus(s).state, 'read')
  assert.ok(frFacts(s).some((f) => f.claim === FR_A), '読み直しの指摘が今の根拠に入る')
  assert.ok(s.events.some((e) => e.stage === FR_STAGE && e.kind === 'full_review_reopened'), '読み直しにしたことを出来事に残す')
})

test('lost: complete で止まった後に範囲の外の単位だけが変わった新しい回でも、返らなかった全文レビューを読み直す', async (t) => {
  const { state, paths } = project(t, BIG)
  const r1 = await run(state, failing(good(), { throwIn: [FR_STAGE] }))
  assert.equal(r1.stop.stop, 'complete', JSON.stringify(r1.stop))
  assert.equal(frStatus(status(state)).cause, 'lost')
  writeFileSync(paths['d.md'], sizedDoc('d', 5000 * S).replace('line 000001:', 'line 00000X:'))
  const r2 = await run(state, good())
  assert.equal(r2.stop.stop, 'complete', JSON.stringify(r2.stop))
  assert.equal(frSteps(r2).length, 1, `新しい回で全文レビューを読み直す: ${agentStages(r2.steps)}`)
  assert.equal(frStatus(status(state)).state, 'read')
})

test('rejected: 照合に落ち続けた全文レビューは、blocked（failure）からの再開でも新しい回でも読み直さない', async (t) => {
  const { state, paths } = project(t, BIG)
  const bad = scriptAgent(frAct({ full_review: (task, ctx, q) => ({ findings: [frFinding(FR_A, [loc(q.inputs.units, 'a.md', '本文に無い引用の文で照合に落ちる')])], references: [] }) }), [])
  const r1 = await run(state, failing(bad, { throwIn: ['file'] }))
  assert.equal(r1.stop.stop, 'blocked', JSON.stringify(r1.stop))
  const s1 = frStatus(status(state))
  assert.equal(s1.state, 'failed')
  assert.equal(s1.cause, 'rejected')
  const r2 = await run(state, good())
  assert.equal(r2.stop.stop, 'complete', JSON.stringify(r2.stop))
  assert.equal(frSteps(r2).length, 0, `照合の失敗は再開で戻さない: ${agentStages(r2.steps)}`)
  writeFileSync(paths['d.md'], sizedDoc('d', 5000 * S).replace('line 000001:', 'line 00000X:'))
  const r3 = await run(state, good())
  assert.equal(r3.stop.stop, 'complete', JSON.stringify(r3.stop))
  assert.equal(frSteps(r3).length, 0, '範囲の外の単位だけが変わった新しい回でも戻さない')
  assert.equal(frStatus(status(state)).cause, 'rejected')
})

test(`unsubmitted: 返ったが提出の無い全文レビューは試行 ${MAX_ATTEMPTS} 回で失敗し、blocked（failure）からの再開でも読み直さない`, async (t) => {
  const { state } = project(t, SMALL)
  const r1 = await run(state, failing(good(), { noopIn: [FR_STAGE], throwIn: ['file'] }))
  assert.equal(frSteps(r1).length, MAX_ATTEMPTS, `提出の無い全文レビューは試行の上限まで流す: ${agentStages(r1.steps)}`)
  assert.equal(r1.stop.stop, 'blocked', JSON.stringify(r1.stop))
  const s1 = frStatus(status(state))
  assert.equal(s1.state, 'failed')
  assert.equal(s1.cause, 'unsubmitted')
  const r2 = await run(state, good())
  assert.equal(r2.stop.stop, 'complete', JSON.stringify(r2.stop))
  assert.equal(frSteps(r2).length, 0, `提出の無い失敗は再開で戻さない: ${agentStages(r2.steps)}`)
})

// ---------------- 較正 ----------------
// 較正（seeds の再現率）はファイルの段の指摘だけで数える（references/ledger.md）。全文レビューの指摘は観点を持たないので入れない。
// seeds は init の --seeds で渡す形だが、対象の path は project が作るので、init の後に台帳の seeds を直に置く（status-dedupe.test と同じ作り）。
test('較正: 仕込みの欠陥はファイルの段の指摘だけで数え、全文レビューの指摘（観点を持たない）は数えない', async (t) => {
  const QB = '文書B の節は主張を一つだけ述べる本文の行である。'
  const { state, paths } = project(t, SMALL)
  const lf = path.join(state, 'ledger.json')
  const L = JSON.parse(readFileSync(lf, 'utf8'))
  L.seeds = [{ path: paths['a.md'], quote: QA }, { path: paths['b.md'], quote: QB }]
  writeFileSync(lf, JSON.stringify(L))
  // ファイルの段は a.md の仕込みだけを拾い、全文レビューは a.md と b.md の両方を拾う。
  const facts = (p) => (path.basename(p) === 'a.md' ? { findings: [{ claim: 'ファイルの段が拾った仕込み', quote: QA }] } : {})
  const both = (units) => [frFinding('FR-a の仕込み', [loc(units, 'a.md', QA)]), frFinding('FR-b の仕込み', [loc(units, 'b.md', QB)])]
  const r = await run(state, scriptAgent(frAct({ facts, frFindings: both }), []))
  assert.equal(r.stop.stop, 'complete', JSON.stringify(r.stop))
  const s = status(state)
  assert.equal(frFacts(s).length, 2, '全文レビューの指摘は今の根拠にある')
  const cal = s.calibration
  assert.ok(cal && Object.keys(cal).length, JSON.stringify(cal))
  assert.ok(Object.keys(cal).every((k) => k !== 'undefined'), `観点の無い行がある: ${JSON.stringify(cal)}`)
  const found = Object.values(cal).reduce((n, x) => n + x.found, 0)
  assert.equal(found, 1, `ファイルの段が拾った a.md の 1 件だけを数える（b.md は全文レビューだけが拾った）: ${JSON.stringify(cal)}`)
})
