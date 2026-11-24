// 全体の段の受け渡しを意図の束にする設計のテスト（計画 glimmering-squishing-moonbeam の「決めること」1・2、設計 docs/design/coverage-ledger-method.md）。
// 設計の箇所: 決定 16（1 体の中の受け渡しも詰められる分をまとめる）、台帳と見たの記録の B1 読み・B2 書き、役と制御の境界の「全体の段と確認で、静的に決まるもの」、
// 全体の段と確認の割り振り、完了と止める条件の「取ったまま出さなかった意図の数え方」、モデルと費用の起動の原則。
// 束の形（claim・query・submit・same_location・束の量の測り方）は batch-fixture.mjs の 1 か所に置く。
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync } from 'node:fs'
import path from 'node:path'
import { MAX_ATTEMPTS, UNIT_MAX_BYTES } from './ledger-core.mjs'
import { behave, cli, driveScript, project, run, scriptAgent, status, rowsOf } from './blackboard-fixture.mjs'
import { act, launchesOf } from './launch-fixture.mjs'
import { confirmedIds, frAct, frFinding, loc } from './full-review-fixture.mjs'
import {
  C_KINDS, G_KINDS, argsOf, batchWorker, bigGuarantees, claimOf, ctxOf, entryBytes, goalBytes, ingestOk, intentIds, ledger, openOf, submitOf, toGlobal, writeResult,
} from './batch-fixture.mjs'

const QA = 'この文書は台帳の lock を取ってから書き込むことを保証する。'
const QB = 'この文書は lock が書き込みを直列にすることを前提にする。'
const plain = (n) => `# ${n}\n\n## 節\n${n} の節は主張を一つだけ述べる本文の行である。\n`
// 小さい対象（launch.test.mjs と同じ 4 ファイル）。a の「台帳の lock」と b の「lock」は名寄せの組になる。
const FILES4 = { 'a.md': `# A\n\n## 保証\n${QA}\n`, 'b.md': `# B\n\n## 前提\n${QB}\n`, 'c.md': plain('文書C'), 'd.md': plain('文書D') }
const MARK = 'MARKER-ファイルの段の指摘'
const FACTS = (p) => (path.basename(p) === 'a.md'
  ? { guarantees: [{ subject: '台帳の lock', quote: QA, confidence: 'high' }], findings: [{ claim: MARK, quote: QA, severity: 'HIGH' }] }
  : path.basename(p) === 'b.md' ? { premises: [{ subject: 'lock', quote: QB, confidence: 'high' }] } : {})
const smallAct = (over = {}) => act({ facts: FACTS, ...over })
const sorted = (xs) => [...xs].sort()
const rowOf = (args, role) => rowsOf(args).find((w) => w.role === role)
const unitIdOf = (state, name) => { const u = status(state).units.find((x) => path.basename(x.path) === name); assert.ok(u, `単位が無い: ${name}`); return u.id }

// 小さい対象の最初の全体の段を開く（worker はまだ起動しない）。判定役の種類の開いた意図が 2 件以上あることを前提として確かめる。
async function smallGlobal(t, over = {}) {
  const { state } = project(t, FILES4)
  const a = smallAct(over)
  const { n, args } = await toGlobal(state, a)
  const open = openOf(state, G_KINDS)
  assert.ok(open.length >= 2, `前提: 判定役の種類の開いた意図が 2 件以上: ${JSON.stringify(open.map((i) => i.kind))}`)
  return { state, a, n, args, open, w: rowOf(args, 'global_judge') }
}

// ---------------- 1. claim: 開いた意図をまとめて返す ----------------

test('1. claim（判定役）: g 行の claim は、判定役の種類の開いた意図をまとめて 1 回で返す（小さい対象は全てが 1 つの束）', async (t) => {
  const { state, args, open, w } = await smallGlobal(t)
  const c = claimOf(state, args, w)
  assert.equal(c.code, 0, JSON.stringify(c))
  assert.deepEqual(sorted(intentIds(c)), sorted(open.map((i) => i.id)), `1 回の claim で開いた判定の意図の全て: 取った ${JSON.stringify(c.tasks.map((x) => x.kind))}、開いた ${JSON.stringify(open.map((i) => i.kind))}`)
  assert.equal(new Set(c.tasks.map((x) => x.result_path)).size, c.tasks.length, '結果の path は意図ごとに違う')
  assert.ok(c.tasks.every((x) => G_KINDS.includes(x.kind)), '判定役の種類だけ')
})

test('1. claim（確認役）: c 行の claim は、開いた確認の意図をまとめて 1 回で返す', async (t) => {
  // 全文レビューの指摘 2 件は、判定の後にどちらも確認の意図になる。
  const two = (units) => [frFinding('FR-一つ目', [loc(units, 'a.md', QA)]), frFinding('FR-二つ目', [loc(units, 'b.md', QB)])]
  const { state } = project(t, FILES4)
  const a = frAct({ facts: FACTS, frFindings: two })
  const first = await toGlobal(state, a)
  for (const w of rowsOf(first.args)) await batchWorker(state, first.args, w, a)
  assert.equal(ingestOk(state, first.args).code, 0)
  const n = cli('next', '--state', state)
  assert.equal(n.step, 'global', JSON.stringify(n))
  const args = argsOf(n)
  const open = openOf(state, ['confirm'])
  assert.ok(open.length >= 2, `前提: 確認の意図が 2 件以上開く: ${open.length}`)
  const w = rowOf(args, 'confirmer')
  assert.ok(w, `確認役の行: ${JSON.stringify(rowsOf(args))}`)
  const c = claimOf(state, args, w)
  assert.deepEqual(sorted(intentIds(c)), sorted(open.map((i) => i.id)), `1 回の claim で開いた確認の意図の全て: ${JSON.stringify(intentIds(c))}`)
  assert.ok(c.tasks.every((x) => C_KINDS.includes(x.kind)))
})

// 量の上限の対象: 1 つの単位に、義務の項目ごとに大きい保証を書く。開くのは目標の判定の意図（G1・G2・AC1）だけ。
const QS = 'この文書は大きな保証の束を一つの行で述べる本文の行である。'
const PAD = 1500
async function sizedGlobal(t, counts) {
  const { state } = project(t, { 'a.md': `# A\n\n## 保証\n${QS}\n` })
  const a = act({ facts: () => ({ guarantees: bigGuarantees(QS, counts, PAD), bind: false }) })
  const { args } = await toGlobal(state, a)
  const open = openOf(state, G_KINDS)
  assert.deepEqual(open.map((i) => i.item), ['G1', 'G2', 'AC1'], `前提: 開くのは目標の判定の意図だけで、並びは G1・G2・AC1: ${JSON.stringify(open.map((i) => [i.kind, i.item]))}`)
  const bytes = Object.fromEntries(['G1', 'G2', 'AC1'].map((g) => [g, goalBytes(state, g)]))
  const itemOf = Object.fromEntries(open.map((i) => [i.id, i.item]))
  return { state, a, args, bytes, itemOf, w: rowOf(args, 'global_judge') }
}
const bundlesOf = (rec, itemOf) => rec.claims.map((c) => intentIds(c).map((id) => itemOf[id]))

test('1. claim の量: 束で query が返す量（basis・related・索引）の和が UNIT_MAX_BYTES に収まる所まで、意図の並びで前から詰める（next-fit）', async (t) => {
  const { state, a, args, bytes, itemOf, w } = await sizedGlobal(t, { G1: 20, G2: 20, AC1: 20 })
  // 前提: 2 件の和は上限の 9 割以下、3 件の和は上限の 1.1 倍以上（測り方の細部で境目が揺れない余白）。
  assert.ok(bytes.G1 + bytes.G2 <= UNIT_MAX_BYTES * 0.9 && bytes.G1 + bytes.G2 + bytes.AC1 >= UNIT_MAX_BYTES * 1.1, `前提の大きさ: ${JSON.stringify(bytes)}`)
  const rec = await batchWorker(state, args, w, a)
  assert.deepEqual(bundlesOf(rec, itemOf).slice(0, 2), [['G1', 'G2'], ['AC1']], `束の列: ${JSON.stringify(bundlesOf(rec, itemOf))}`)
})

test('1. claim の量: 1 件だけで UNIT_MAX_BYTES を超える意図は単独の束にし、次の意図から新しい束を詰める', async (t) => {
  const { state, a, args, bytes, itemOf, w } = await sizedGlobal(t, { G1: 60, G2: 15, AC1: 15 })
  assert.ok(bytes.G1 >= UNIT_MAX_BYTES * 1.1 && bytes.G2 + bytes.AC1 <= UNIT_MAX_BYTES * 0.9, `前提の大きさ: ${JSON.stringify(bytes)}`)
  const rec = await batchWorker(state, args, w, a)
  assert.deepEqual(bundlesOf(rec, itemOf).slice(0, 2), [['G1'], ['G2', 'AC1']], `束の列: ${JSON.stringify(bundlesOf(rec, itemOf))}`)
})

test('1. claim の量: 複数の意図の束では、固定した測り方の量の和が UNIT_MAX_BYTES 以下（束の query の出力で測る）', async (t) => {
  const { state, args, w } = await sizedGlobal(t, { G1: 20, G2: 20, AC1: 20 })
  const c = claimOf(state, args, w)
  assert.ok(c.tasks.length >= 2, `束で取る（2 件以上）: ${c.tasks.length}`)
  const q = cli('query', '--state', state, '--call', args.callId, '--worker', w.id, ...c.tasks.flatMap((x) => ['--task', x.id]))
  assert.equal(q.code, 0, JSON.stringify(q).slice(0, 300))
  assert.ok(Array.isArray(q.tasks), `束の query は tasks を返す: ${Object.keys(q)}`)
  const total = q.tasks.reduce((n, e) => n + entryBytes(e), 0)
  assert.ok(total <= UNIT_MAX_BYTES, `束の量: ${total}`)
})

test('1. claim の分け方は決定的: 同じ対象を別の台帳で回すと、同じ束の列（意図の id）になる。同じ台帳の写しでも同じ', async (t) => {
  const counts = { G1: 20, G2: 20, AC1: 20 }
  const x = await sizedGlobal(t, counts)
  const y = await sizedGlobal(t, counts)
  // 同じ台帳の写し（開いた呼び出しごと）。
  const z = path.join(path.dirname(x.state), 'state-copy')
  cpSync(x.state, z, { recursive: true })
  const ids = async (s, o) => (await batchWorker(s, o.args, o.w, o.a)).claims.map(intentIds)
  const rx = await ids(x.state, x)
  const ry = await ids(y.state, y)
  const rz = await ids(z, x)
  assert.ok(rx.some((b) => b.length >= 2), `束で取る（2 件以上の束がある）: ${JSON.stringify(rx)}`)
  assert.deepEqual(ry, rx)
  assert.deepEqual(rz, rx)
})

test('1. claim: 取って出し終えていない意図があれば、それを先に返す（新しい意図を混ぜない）。1 件だけ出した後の claim は残りだけを返す', async (t) => {
  const { state, a, args, w } = await smallGlobal(t)
  const c1 = claimOf(state, args, w)
  assert.ok(c1.tasks.length >= 2, `束で取る（2 件以上）: ${c1.tasks.length}`)
  const ctx = ctxOf(state, args, w)
  writeResult(c1.tasks[0], await a(c1.tasks[0], ctx))
  const s = submitOf(c1)
  assert.deepEqual(s.results.map((r) => [r.task, r.ok]), [[c1.tasks[0].id, true]], JSON.stringify(s.results))
  assert.deepEqual(sorted(s.missing), sorted(c1.tasks.slice(1).map((x) => x.id)), '残りは missing')
  const c2 = claimOf(state, args, w)
  assert.deepEqual(sorted(c2.tasks.map((x) => x.id)), sorted(c1.tasks.slice(1).map((x) => x.id)), `残りだけを返す: ${JSON.stringify(c2.tasks.map((x) => x.kind))}`)
})

// ---------------- 2. query: 束を 1 回で引く ----------------

test('2. query: 複数の --task を受け、束の全ての意図の根拠と関係する事実を 1 回で返す（--task の順に tasks の 1 件ずつ）', async (t) => {
  const { state, args, w } = await smallGlobal(t)
  const c = claimOf(state, args, w)
  assert.ok(c.tasks.length >= 2, `束で取る（2 件以上）: ${c.tasks.length}`)
  const q = cli('query', '--state', state, '--call', args.callId, '--worker', w.id, ...c.tasks.flatMap((x) => ['--task', x.id]))
  assert.equal(q.code, 0, JSON.stringify(q).slice(0, 300))
  assert.ok(Array.isArray(q.tasks), `束の query は tasks を返す: ${Object.keys(q)}`)
  assert.deepEqual(q.tasks.map((e) => e.task), c.tasks.map((x) => x.id))
  const byId = new Map(status(state).intents.map((i) => [i.id, i]))
  for (const e of q.tasks) {
    const it = byId.get(e.intent && e.intent.id)
    assert.ok(it, `意図: ${JSON.stringify(e.intent)}`)
    assert.equal(e.kind, it.kind)
    assert.deepEqual(sorted(e.basis.map((f) => f.id)), sorted(it.basis), `${it.kind} の根拠`)
    assert.ok(Array.isArray(e.related))
    if (it.kind === 'goal') assert.ok(Array.isArray(e.units) && e.units.length, '目標の判定は単位の索引を持つ')
  }
})

test('2. query: 束の --task のどれかがこの worker の担当に無ければ、終了状態 2 で拒む', async (t) => {
  const { state, args, w } = await smallGlobal(t)
  const c = claimOf(state, args, w)
  const r = run('query', '--state', state, '--call', args.callId, '--worker', w.id, '--task', 'goal:000000000000@nope', '--task', c.tasks[0].id)
  assert.equal(r.code, 2, JSON.stringify(r))
})

test('2. query（今も通る守り）: ファイルの段の担当は、--task を複数渡しても拒む', async (t) => {
  const { state } = project(t, FILES4)
  const a = smallAct()
  for (let i = 0; i < 10; i++) {
    const n = cli('next', '--state', state)
    const args = argsOf(n)
    if (args.stage === 'file') {
      const w = rowsOf(args)[0]
      const c = claimOf(state, args, w)
      assert.ok(c.tasks.length >= 2, `前提: ファイルの段の詰め合わせ: ${c.tasks.length}`)
      const r = run('query', '--state', state, '--call', args.callId, '--worker', w.id, ...c.tasks.flatMap((x) => ['--task', x.id]))
      assert.equal(r.code, 2, JSON.stringify(r))
      return
    }
    for (const w of rowsOf(args)) await batchWorker(state, args, w, a)
    ingestOk(state, args)
  }
  assert.fail('ファイルの段まで進まない')
})

// ---------------- 3. submit: 束をまとめて受ける ----------------

test('3. submit: 束の結果を 1 回で受けて意図ごとに受理か拒否を返し、拒否された意図だけが取られたまま残って出し直せる', async (t) => {
  const { state, a, args, w } = await smallGlobal(t)
  const c = claimOf(state, args, w)
  assert.ok(c.tasks.length >= 2, `束で取る（2 件以上）: ${c.tasks.length}`)
  const ctx = ctxOf(state, args, w)
  const bad = c.tasks.find((x) => x.kind === 'goal')
  assert.ok(bad, '前提: 束に目標の判定の意図がある')
  for (const task of c.tasks) writeResult(task, task === bad ? { verdict: 'supported', support: [], quote: '本文に無い引用の文で照合に落ちる提出' } : await a(task, ctx))
  const s = submitOf(c)
  assert.equal(s.code, 0, JSON.stringify(s))
  assert.deepEqual(sorted(s.results.map((r) => r.task)), sorted(c.tasks.map((x) => x.id)), '束の全てを 1 回で受ける')
  for (const r of s.results) assert.equal(r.ok, r.task !== bad.id, `${r.task}: ${JSON.stringify(r.problems)}`)
  const byId = new Map(status(state).intents.map((i) => [i.id, i]))
  for (const x of c.tasks) assert.equal(byId.get(x.intent.id).state, x === bad ? 'open' : 'closed', x.kind)
  const c2 = claimOf(state, args, w)
  assert.deepEqual(c2.tasks.map((x) => x.id), [bad.id], `拒否された意図だけを返す: ${JSON.stringify(c2.tasks.map((x) => x.kind))}`)
  writeResult(c2.tasks[0], await a(c2.tasks[0], ctx))
  const s2 = submitOf(c2)
  assert.deepEqual(s2.results.map((r) => [r.task, r.ok]), [[bad.id, true]], JSON.stringify(s2.results))
})

// ---------------- 4. 取ったまま出さなかった意図の数え方 ----------------

test('4. closeCall: その呼び出しで 1 件以上出した worker の取り残しは、試行を数えずに手放す。残りは開いたままで、次の呼び出しが取る', async (t) => {
  const { state, a, args, w } = await smallGlobal(t)
  const ctx = ctxOf(state, args, w)
  const c1 = claimOf(state, args, w)
  writeResult(c1.tasks[0], await a(c1.tasks[0], ctx))
  assert.ok(submitOf(c1).results.every((r) => r.ok), '1 件を受理させた')
  // 手元に残りが無ければ（1 件ずつの claim）、もう 1 回取って出さない。
  const held = c1.tasks.slice(1).map((x) => x.intent.id)
  if (!held.length) held.push(...intentIds(claimOf(state, args, w)))
  assert.ok(held.length, '前提: 取ったまま出さない意図がある')
  assert.equal(ingestOk(state, args).code, 0)
  const L = ledger(state)
  for (const id of held) assert.ok(!L.intent_attempts[id] || L.intent_attempts[id].n === 0, `${id} の試行を数えない: ${JSON.stringify(L.intent_attempts[id])}`)
  const open = new Set(openOf(state, G_KINDS).map((i) => i.id))
  assert.ok(held.every((id) => open.has(id)), '開いたまま')
  const n = cli('next', '--state', state)
  assert.equal(n.step, 'global', JSON.stringify(n))
  const args2 = argsOf(n)
  const taken = []
  for (let i = 0; i < 20; i++) {
    const c = claimOf(state, args2, rowOf(args2, 'global_judge'))
    if (c.done) break
    taken.push(...intentIds(c))
    for (const task of c.tasks) writeResult(task, await a(task, ctxOf(state, args2, rowOf(args2, 'global_judge'))))
    submitOf(c)
  }
  assert.ok(held.every((id) => taken.includes(id)), `次の呼び出しが取る: ${JSON.stringify({ held, taken })}`)
})

test('4. closeCall（今も通る守り）: 1 件の束を取って 1 件も出さなかった worker の取り残しは、試行を 1 つ足す', async (t) => {
  // G1 は 1 件で UNIT_MAX_BYTES を超えるので、最初の束は [G1] の 1 件になる。
  const { state, args, w, bytes, itemOf } = await sizedGlobal(t, { G1: 60, G2: 15, AC1: 15 })
  assert.ok(bytes.G1 >= UNIT_MAX_BYTES * 1.1, `前提の大きさ: ${JSON.stringify(bytes)}`)
  const held = intentIds(claimOf(state, args, w))
  assert.deepEqual(held.map((id) => itemOf[id]), ['G1'], '前提: 1 件の束')
  assert.equal(ingestOk(state, args).code, 0)
  const L = ledger(state)
  for (const id of held) assert.equal(L.intent_attempts[id] && L.intent_attempts[id].n, 1, `${id}: ${JSON.stringify(L.intent_attempts[id])}`)
})

// ---------------- 4'. 束を取って 0 件のまま閉じた呼び出し（時間切れ）: 束の上限を半分にして詰め直す ----------------
// 対象: 目標の判定の意図 3 件（各 約 21KB）。最初の束は 3 件（約 62KB）。半分（約 31KB）の上限では [G1] の 1 件、
// 戻した上限（UNIT_MAX_BYTES）では [G2, AC1]（約 41KB。半分の上限を超える）になる。
const SHRINK = { G1: 10, G2: 10, AC1: 10 }
async function shrinkGlobal(t) {
  const o = await sizedGlobal(t, SHRINK)
  const { G1, G2, AC1 } = o.bytes
  const half = (G1 + G2 + AC1) / 2
  assert.ok(G1 <= half * 0.9 && G1 + G2 >= half * 1.1 && G2 + AC1 >= half * 1.1 && G1 + G2 + AC1 <= UNIT_MAX_BYTES * 0.9, `前提の大きさ: ${JSON.stringify(o.bytes)}`)
  return o
}
// 判定役が束を取り、1 件も出さないまま呼び出しを閉じる（時間切れ）。取った束の項目の列を返す。1 回目の呼び出しは開いたものを使う。
function zeroClose(state, itemOf, opened = null) {
  const n = opened ? null : cli('next', '--state', state)
  if (n) assert.equal(n.step, 'global', JSON.stringify(n))
  const args = opened || argsOf(n)
  const w = rowOf(args, 'global_judge')
  assert.ok(w, `判定役の行: ${JSON.stringify(rowsOf(args))}`)
  const items = intentIds(claimOf(state, args, w)).map((id) => itemOf[id])
  assert.equal(ingestOk(state, args).code, 0)
  return items
}
const undecidedItems = (state) => status(state).intents.filter((i) => i.state === 'undecided').map((i) => i.item)

test("4'. 時間切れの束: 束（2 件以上）で取って 0 件のまま 2 回閉じても undecided にならず、束の試行も数えない", async (t) => {
  const { state, args, itemOf } = await shrinkGlobal(t)
  const b1 = zeroClose(state, itemOf, args)
  assert.ok(b1.length >= 2, `束で取る（2 件以上）: ${JSON.stringify(b1)}`)
  const L1 = ledger(state)
  for (const id of Object.keys(itemOf)) assert.ok(!L1.intent_attempts[id] || L1.intent_attempts[id].n === 0, `束の取り残しは試行に数えない: ${itemOf[id]} ${JSON.stringify(L1.intent_attempts[id])}`)
  zeroClose(state, itemOf)
  assert.deepEqual(undecidedItems(state), [], '2 回閉じても undecided にしない')
  assert.equal(openOf(state, G_KINDS).length, 3, '3 件とも開いたまま')
})

test("4'. 時間切れの束: 次の束は、前回の束の量の半分を上限にして詰め直す（前回より小さい）", async (t) => {
  const { state, args, itemOf } = await shrinkGlobal(t)
  const b1 = zeroClose(state, itemOf, args)
  assert.deepEqual(b1, ['G1', 'G2', 'AC1'], `最初の束: ${JSON.stringify(b1)}`)
  const b2 = zeroClose(state, itemOf)
  assert.deepEqual(b2, ['G1'], `半分の量で詰め直した束: ${JSON.stringify(b2)}`)
})

test("4'. 時間切れの束: 0 件のまま 2 回閉じた後でも、縮めた束を出せば閉じ、undecided 無しで complete まで進む", async (t) => {
  const { state, a, args, itemOf } = await shrinkGlobal(t)
  zeroClose(state, itemOf, args)
  zeroClose(state, itemOf)
  for (let i = 0; i < 10; i++) {
    const n = cli('next', '--state', state)
    if (n.stop) { assert.equal(n.stop, 'complete', JSON.stringify(n)); break }
    const args2 = argsOf(n)
    for (const w of rowsOf(args2)) await batchWorker(state, args2, w, a)
    assert.equal(ingestOk(state, args2).code, 0)
  }
  assert.equal(status(state).stopped && status(state).stopped.stop, 'complete', JSON.stringify(status(state).stopped))
  assert.deepEqual(undecidedItems(state), [])
  assert.equal(status(state).intents.filter((i) => i.state === 'open').length, 0)
})

test("4'. 時間切れの束: 束が 1 件まで縮んだ後、1 件の束で 0 件が MAX_ATTEMPTS 回続けば、その意図だけが undecided で閉じる", async (t) => {
  const { state, args, itemOf } = await shrinkGlobal(t)
  const bundles = [zeroClose(state, itemOf, args)]
  assert.ok(bundles[0].length >= 2, `束で取る（2 件以上）: ${JSON.stringify(bundles[0])}`)
  for (let i = 0; i < 8 && !undecidedItems(state).length; i++) bundles.push(zeroClose(state, itemOf))
  const singles = bundles.filter((b) => b.length === 1)
  assert.deepEqual(undecidedItems(state), ['G1'], `束の列: ${JSON.stringify(bundles)}`)
  assert.equal(singles.length, MAX_ATTEMPTS, `1 件の束で 0 件の呼び出しの数: ${JSON.stringify(bundles)}`)
  assert.ok(singles.every((b) => b[0] === 'G1'), JSON.stringify(bundles))
  assert.ok(bundles.indexOf(singles[0]) > 0 && bundles.slice(0, bundles.indexOf(singles[0])).every((b) => b.length >= 2), `縮めてから 1 件になる: ${JSON.stringify(bundles)}`)
  const L = ledger(state)
  for (const [id, item] of Object.entries(itemOf)) if (item !== 'G1') assert.ok(!L.intent_attempts[id] || L.intent_attempts[id].n === 0, `${item} は試行に数えない`)
})

test("4'. 時間切れの束: その種類で 1 件以上の提出があった呼び出しの後は、束の上限を UNIT_MAX_BYTES に戻す", async (t) => {
  const { state, a, args, itemOf } = await shrinkGlobal(t)
  zeroClose(state, itemOf, args)
  // 縮めた束（[G1]）を出して閉じる。
  const n = cli('next', '--state', state)
  const args2 = argsOf(n)
  const w = rowOf(args2, 'global_judge')
  const c = claimOf(state, args2, w)
  assert.deepEqual(intentIds(c).map((id) => itemOf[id]), ['G1'], `前提: 縮めた束: ${JSON.stringify(intentIds(c).map((id) => itemOf[id]))}`)
  writeResult(c.tasks[0], await a(c.tasks[0], ctxOf(state, args2, w)))
  assert.ok(submitOf(c).results.every((r) => r.ok), 'G1 を受理させた')
  assert.equal(ingestOk(state, args2).code, 0)
  const b3 = zeroClose(state, itemOf)
  assert.deepEqual(b3, ['G2', 'AC1'], `戻した上限で詰めた束（半分の上限なら 1 件）: ${JSON.stringify(b3)}`)
})

// ---------------- 5. 全体の段と確認の担当に観点の一覧を付けない ----------------

test('5. 観点の一覧: 全体の段（判定役）と確認・束ね（確認役）の担当に lenses を付けない', async (t) => {
  const { state } = project(t, FILES4)
  const log = []
  const subject = (task, ctx) => {
    const q = ctx.query(task)
    const locs = q.basis.filter((f) => f.quote && f.unit).map((f) => ({ unit: f.unit, quote: f.quote }))
    return { verdict: 'conflict', quote: locs[0].quote, findings: [{ claim: '主語の照合が足した矛盾の指摘', locations: locs, obligation: 'G1', confidence: 'high', severity: 'HIGH', layer: '方式設計' }] }
  }
  const r = await driveScript(state, scriptAgent(smallAct({ subject }), log), { maxSteps: 30 })
  assert.equal(r.stop.stop, 'complete', JSON.stringify(r.stop))
  const tasks = launchesOf(r.steps, log).filter((x) => x.stage === 'global').flatMap((x) => x.claims.flatMap((c) => c.tasks || []))
  const kinds = new Set(tasks.map((x) => x.kind))
  assert.ok(['finding', 'goal', 'confirm', 'group'].every((k) => kinds.has(k)), `前提: 判定・確認・束ねの担当を取った: ${[...kinds]}`)
  const withLenses = tasks.filter((x) => Object.hasOwn(x, 'lenses'))
  assert.deepEqual(withLenses.map((x) => x.kind), [], '観点の一覧の付いた担当')
})

// ---------------- 6. 指摘の場所の単位を CLI が引き当てる ----------------

const DUP = 'この行は二つの文書に同じ文言で書かれている共通の本文の行である。'
const FILES_DUP = { 'a.md': `# A\n\n## 保証\n${QA}\n${DUP}\n`, 'b.md': `# B\n\n## 前提\n${QB}\n${DUP}\n` }
// G2 の目標の判定を gap にし、findings を足す。ほかは既定。G2 の担当の submit の結果を results に集める。
function gapAct(findingsOf, results) {
  const base = behave()
  return async (task, ctx) => {
    if (task.kind === 'goal' && task.intent.item === 'G2') {
      results.ids.add(task.id)
      return { verdict: 'gap', quote: QA, findings: findingsOf(ctx.query(task)) }
    }
    return base(task, ctx)
  }
}
const g2Results = async (state, findingsOf) => {
  const results = { ids: new Set() }
  const log = []
  const r = await driveScript(state, scriptAgent(gapAct(findingsOf, results), log), { maxSteps: 30 })
  const subs = log.flatMap((x) => (x.rec ? x.rec.submits : [])).flatMap((s) => s.out.results || []).filter((x) => results.ids.has(x.task))
  assert.ok(subs.length, '前提: G2 の担当を出した')
  return { r, subs }
}

test('6. locations[].unit の省略: 引用が 1 つの単位にしか無ければ、CLI が単位を引き当てて受ける（目標の判定が足す指摘）', async (t) => {
  const { state } = project(t, FILES_DUP)
  const { r, subs } = await g2Results(state, () => [{ claim: 'M6-一意な引用の指摘', locations: [{ quote: QB }], obligation: 'G2', confidence: 'high', severity: 'HIGH', layer: '実装' }])
  assert.ok(subs[0].ok, `省いた unit を引き当てて受ける: ${JSON.stringify(subs[0].problems)}`)
  assert.equal(r.stop.stop, 'complete', JSON.stringify(r.stop))
  const f = status(state).facts.find((x) => x.type === 'finding' && x.claim === 'M6-一意な引用の指摘')
  assert.ok(f, '足した指摘の事実')
  assert.equal(f.unit, unitIdOf(state, 'b.md'))
  assert.equal(path.basename(f.path), 'b.md')
  assert.deepEqual(f.locations.map((l) => l.unit), [unitIdOf(state, 'b.md')])
})

test('6. locations[].unit の省略: 同じ引用が複数の単位にあれば、unit を求めて拒み、problems に候補の単位の id を全て挙げる', async (t) => {
  const { state } = project(t, FILES_DUP)
  const { subs } = await g2Results(state, () => [{ claim: 'M6-曖昧な引用の指摘', locations: [{ quote: DUP }], obligation: 'G2', confidence: 'high', severity: 'HIGH', layer: '実装' }])
  const [ua, ub] = [unitIdOf(state, 'a.md'), unitIdOf(state, 'b.md')]
  assert.equal(subs[0].ok, false)
  const text = subs[0].problems.join(' / ')
  assert.ok(/unit/.test(text) && text.includes(ua) && text.includes(ub), `unit を求め、候補を挙げる: ${text}`)
  assert.ok(!status(state).facts.some((x) => x.claim === 'M6-曖昧な引用の指摘'), '拒んだ指摘は事実にしない')
})

test('6. locations[].unit の省略: 全文レビューの指摘も、引用が読む範囲の 1 つの単位にしか無ければ CLI が単位を引き当てて受ける', async (t) => {
  const { state } = project(t, FILES_DUP)
  const a = frAct({ frFindings: () => [frFinding('M6-全文レビューの省いた指摘', [{ quote: QB }])] })
  await toGlobal(state, a)
  const f = status(state).facts.find((x) => x.type === 'finding' && x.claim === 'M6-全文レビューの省いた指摘')
  assert.ok(f, `全文レビューの指摘を受けた: ${JSON.stringify(status(state).events.filter((e) => e.stage === 'full_review'))}`)
  assert.deepEqual(f.locations.map((l) => l.unit), [unitIdOf(state, 'b.md')])
})

// ---------------- 7. 目標の判定が足す指摘の義務は意図の項目 ----------------

test('7. goal の意図が足す指摘の義務: 役が省いても別の義務を書いても、意図の item（G2）になる', async (t) => {
  const { state } = project(t, FILES4)
  const { r, subs } = await g2Results(state, (q) => {
    const u = q.units.find((x) => path.basename(x.path) === 'b.md')
    return [
      { claim: 'M7-義務を省いた指摘', locations: [{ unit: u.id, quote: QB }], confidence: 'high', severity: 'HIGH', layer: '実装' },
      { claim: 'M7-別の義務を書いた指摘', locations: [{ unit: u.id, quote: QB }], obligation: 'G1', confidence: 'high', severity: 'HIGH', layer: '実装' },
    ]
  })
  assert.ok(subs[0].ok, `義務を省いた指摘も受ける: ${JSON.stringify(subs[0].problems)}`)
  assert.equal(r.stop.stop, 'complete', JSON.stringify(r.stop))
  const facts = status(state).facts
  for (const claim of ['M7-義務を省いた指摘', 'M7-別の義務を書いた指摘']) {
    const f = facts.find((x) => x.type === 'finding' && x.claim === claim)
    assert.ok(f, claim)
    assert.equal(f.obligation, 'G2', `${claim}: ${f.obligation}`)
  }
})

// ---------------- 8. 同じ箇所の指摘の組 ----------------

// a の QA を全文レビューは行の全体で、ファイルの段は行の一部で引く（正規化して包含し合う）。a の QA2 を引く全文レビューの指摘は、ファイルの段の指摘と包含し合わない。
// b のファイルの段の指摘は、全文レビューの指摘と単位が違う。
const QA2 = 'この文書は書き込みの後に台帳の版を一つ進めることを保証する。'
const QA_PART = 'この文書は台帳の lock を取ってから書き込む'
const FILES_SAME = { 'a.md': `# A\n\n## 保証\n${QA}\n${QA2}\n`, 'b.md': `# B\n\n## 前提\n${QB}\n` }
const C_FR = 'M8-全文レビューの指摘（a の QA）'
const C_FR2 = 'M8-全文レビューの指摘（a の QA2）'
const C_FILE = 'M8-ファイルの段の指摘（a の QA の一部）'
const C_FILEB = 'M8-ファイルの段の指摘（b）'
const pairsOf = (q) => (q && Array.isArray(q.same_location) ? q.same_location : [])
const hasPair = (q, x, y) => pairsOf(q).some((p) => Array.isArray(p) && p.length === 2 && sorted(p).join() === sorted([x, y]).join())

test('8. 同じ箇所の指摘の組: 全文レビューとファイルの段で同じ単位の引用が包含し合う組を、判定・確認・束ねの担当に same_location で並べる。まとめず、出どころを残す', async (t) => {
  const { state } = project(t, FILES_SAME)
  const queries = []
  const base = frAct({
    facts: (p) => (path.basename(p) === 'a.md' ? { findings: [{ claim: C_FILE, quote: QA_PART }] } : { findings: [{ claim: C_FILEB, quote: QB }] }),
    frFindings: (units) => [frFinding(C_FR, [loc(units, 'a.md', QA)]), frFinding(C_FR2, [loc(units, 'a.md', QA2)])],
  })
  const rec = async (task, ctx) => { if (['finding', 'confirm', 'group'].includes(task.kind)) queries.push({ task, q: ctx.query(task) }); return base(task, ctx) }
  const r = await driveScript(state, scriptAgent(rec), { maxSteps: 30 })
  assert.equal(r.stop.stop, 'complete', JSON.stringify(r.stop))
  const s = status(state)
  const idOf = (claim) => { const f = s.facts.find((x) => x.type === 'finding' && x.claim === claim); assert.ok(f, claim); return f }
  const [fr, fr2, file, fileB] = [idOf(C_FR), idOf(C_FR2), idOf(C_FILE), idOf(C_FILEB)]
  assert.deepEqual([fr.origin, fr2.origin, file.origin, fileB.origin], ['full_review', 'full_review', 'file', 'file'], '出どころを残す')
  const target = (k) => (x) => x.task.kind === k
  const of = (kind, fid) => queries.filter(target(kind)).find((x) => x.q.basis[0] && x.q.basis[0].id === fid)
  const visible = (q, id) => [...(q.related || []), ...(q.facts || [])].some((f) => f && f.id === id && f.origin)
  for (const [kind, fid, other] of [['finding', fr.id, file.id], ['finding', file.id, fr.id], ['confirm', fr.id, file.id]]) {
    const x = of(kind, fid)
    assert.ok(x, `前提: ${kind} の担当（${fid}）`)
    assert.ok(hasPair(x.q, fr.id, file.id), `${kind}（${fid}）に組が並ぶ: ${JSON.stringify(x.q.same_location)}`)
    assert.ok(visible(x.q, other), `${kind}（${fid}）で組の相手の事実が出どころつきで見える`)
  }
  for (const [kind, fid] of [['finding', fr2.id], ['finding', fileB.id]]) {
    const x = of(kind, fid)
    assert.ok(x, `前提: ${kind} の担当（${fid}）`)
    assert.deepEqual(pairsOf(x.q), [], `包含しない・単位が違う指摘は組にしない: ${JSON.stringify(x.q.same_location)}`)
  }
  const g = queries.find(target('group'))
  assert.ok(g, '前提: 束ねの担当')
  assert.ok(hasPair(g.q, fr.id, file.id), `束ねに組が並ぶ: ${JSON.stringify(g.q.same_location)}`)
  assert.ok(pairsOf(g.q).every((p) => !p.includes(fr2.id) && !p.includes(fileB.id)), JSON.stringify(g.q.same_location))
  const ok = confirmedIds(s)
  assert.ok(ok.includes(fr.id) && ok.includes(file.id), `組の両方を別の指摘として確定する: ${JSON.stringify(ok)}`)
})

// ---------------- 9. 全体の流れ ----------------

test('9. 全体の流れ: 全体の段は判定役 1 体・確認役 1 体で、開いた意図が 0 になるまで進む。往復は意図の数より少ない（束で取る）', async (t) => {
  const { state } = project(t, FILES4)
  const two = (units) => [frFinding('FR-一つ目', [loc(units, 'a.md', QA)]), frFinding('FR-二つ目', [loc(units, 'b.md', QB)])]
  const log = []
  const r = await driveScript(state, scriptAgent(frAct({ facts: FACTS, frFindings: two }), log), { maxSteps: 30 })
  assert.equal(r.stop.stop, 'complete', JSON.stringify(r.stop))
  assert.equal(status(state).intents.filter((i) => i.state === 'open').length, 0)
  const launches = launchesOf(r.steps, log).filter((x) => x.stage === 'global')
  for (const role of ['global_judge', 'confirmer']) {
    const ls = launches.filter((x) => x.role === role)
    assert.equal(ls.length, 1, `${role} は 1 体`)
    const claims = ls[0].claims.filter((c) => Array.isArray(c.tasks) && c.tasks.length)
    const intents = new Set(claims.flatMap((c) => intentIds(c)))
    assert.ok(intents.size >= 2, `前提: ${role} は 2 件以上の意図を取った: ${intents.size}`)
    assert.ok(claims[0].tasks.length >= 2, `${role} の最初の claim は束: ${claims[0].tasks.length}`)
    assert.ok(claims.length < intents.size, `${role} の往復（${claims.length}）は意図の数（${intents.size}）より少ない`)
  }
})
