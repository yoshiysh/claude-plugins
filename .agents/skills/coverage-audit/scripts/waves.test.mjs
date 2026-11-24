// 波のテスト（計画 effervescent-kindling-corbato の「中心の仕組み」「coverage-audit」1〜3 と、設計レビュー 1 回目の 1〜4・8、2 回目の E）。
// CLI が段を進め、1 回の Workflow は CLI が台帳に記録した次の波がある間、波を順に流す。役が運ぶのは制御の印（next_wave の id と行、halt）だけ。
// 外から見える口だけに依る: args の形、claim の命令と出力、役の返り値（WORKER_SCHEMA）、ingest の起動の記録、status。
// 時刻の差し替えは環境変数 COVERAGE_AUDIT_NOW_MS（ミリ秒。claim・next が読む今の時刻）を使う。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { C } from './ledger-core.mjs'
import {
  ROLES, argOf, behave, claimArgv, cli, cliArgvOf, driveScript, launchesOf, nextWaveOf, project, readArgs, rowsOf, runScript, scriptAgent, status, tmp, wavesOf, workerLoop,
} from './blackboard-fixture.mjs'
import { sizedDoc, standalone } from './launch-fixture.mjs'
import { noProposal, noProposalAct, planAct } from './plan-roles.mjs'

const QA = 'この文書は台帳の lock を取ってから書き込むことを保証する。'
const QB = 'この文書は lock が書き込みを直列にすることを前提にする。'
const FILES = { 'a.md': `# A\n\n## 保証\n${QA}\n`, 'b.md': `# B\n\n## 前提\n${QB}\n` }
const FACTS = (p) => (path.basename(p) === 'a.md' ? { guarantees: [{ subject: '台帳の lock', quote: QA, confidence: 'high' }] } : { premises: [{ subject: 'lock', quote: QB, confidence: 'high' }] })
const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))
const ledgerBytes = (state) => readFileSync(path.join(state, 'ledger.json'), 'utf8')
// 連続する同じ段を 1 つにまとめた段の並び。
const runsOf = (stages) => stages.filter((s, i) => s !== stages[i - 1])
const NOW = 'COVERAGE_AUDIT_NOW_MS'
// 呼び出しの区切りの時間（経過がこれを超えたら halt）。
const CALL_BUDGET_MS = C.LIMITS.timeoutMs - C.LIMITS.agentTimeoutMs
const setNow = (t, ms) => {
  const prev = process.env[NOW]
  if (!t.__nowRestore) { t.__nowRestore = true; t.after(() => { if (prev === undefined) delete process.env[NOW]; else process.env[NOW] = prev }) }
  process.env[NOW] = String(ms)
}
// 単位を読む役（file_reader・full_reviewer・global_judge・confirmer）の文脈の大きさを上書きした roles のファイル。
const READERS = ['file_reader', 'full_reviewer', 'global_judge', 'confirmer']
function rolesFile(d, tokens) {
  const f = path.join(d, `roles-${Object.values(tokens).join('-')}.json`)
  writeFileSync(f, JSON.stringify(Object.fromEntries(Object.entries(tokens).map(([r, n]) => [r, { ...ROLES[r], context_tokens: n }]))))
  return f
}

// ---------------- Workflow script（偽の agent だけで流す。台帳は使わない） ----------------

const ROW = (id, stage = 'file', extra = {}) => ({ id, role: stage === 'file' ? 'file_reader' : stage === 'plan' ? 'planner' : 'global_judge', model: 'opus', effort: 'medium', stage, ...extra })
const waveArgs = (id, rows) => ({ state: '/tmp/coverage-waves-x', callId: 'c1', wave: { id, rows } })
// prompt の claim の命令の --wave・--worker で、返す値を決める偽の agent。
function fakeAgent(replies = {}) {
  const seen = []
  const fn = async (prompt, opts) => {
    const argv = cliArgvOf(prompt, 'claim')
    const key = `${argOf(argv, 'wave')}/${argOf(argv, 'worker')}`
    seen.push({ key, argv, opts })
    return replies[key] || { notes: [] }
  }
  fn.seen = seen
  return fn
}

test('script: 役の prompt の claim の命令に、行の --wave・--model・--effort・--stage を埋め、agent の model・effort・phase も行の値', async () => {
  const fn = fakeAgent()
  const row = ROW('f1', 'file', { model: 'sonnet', effort: 'high' })
  await runScript(waveArgs(3, [row]), fn)
  assert.equal(fn.seen.length, 1)
  const { argv, opts } = fn.seen[0]
  assert.deepEqual(['state', 'call', 'worker', 'wave', 'model', 'effort', 'stage'].map((k) => argOf(argv, k)), ['/tmp/coverage-waves-x', 'c1', 'f1', '3', 'sonnet', 'high', 'file'])
  assert.deepEqual([opts.model, opts.effort, opts.phase], ['sonnet', 'high', 'file'])
})

test('script: WORKER_SCHEMA は notes に加えて next_wave_id・rows・halt を持つ（返り値で次の波の印を運ぶ）', async () => {
  const fn = fakeAgent()
  await runScript(waveArgs(1, [ROW('f1')]), fn)
  assert.equal(fn.seen.length, 1, '波の行の役を起動する')
  const schema = fn.seen[0].opts.schema
  assert.ok(schema && schema.properties, JSON.stringify(schema))
  for (const k of ['notes', 'next_wave_id', 'rows', 'halt']) assert.ok(k in schema.properties, `WORKER_SCHEMA に ${k} が無い: ${Object.keys(schema.properties)}`)
  assert.deepEqual(schema.required, ['notes'], 'next_wave_id・rows・halt は任意')
})

test('script: 返ってきた中で最大の next_wave_id の行で次の波を起動し、返り値が次の波を持たなくなったら終える。起動の記録は段と波を持つ', async () => {
  const fn = fakeAgent({
    '3/f1': { notes: [], next_wave_id: 4, rows: [ROW('g1', 'global')] },
    '3/f2': { notes: [], next_wave_id: 5, rows: [ROW('g2', 'global'), ROW('g3', 'global')] },
  })
  const res = await runScript(waveArgs(3, [ROW('f1'), ROW('f2')]), fn)
  assert.deepEqual(fn.seen.map((x) => x.key).sort(), ['3/f1', '3/f2', '5/g2', '5/g3'], '小さい id（4）の波は起動しない')
  assert.deepEqual(Object.keys(res).sort(), ['agents', 'tokens'])
  assert.equal(res.agents.length, 4)
  for (const a of res.agents) {
    assert.ok(['file', 'global'].includes(a.stage), `起動の記録に段: ${JSON.stringify(a)}`)
    assert.ok([3, 5, '3', '5'].includes(a.wave), `起動の記録に波の id: ${JSON.stringify(a)}`)
    assert.ok(a.model && a.effort && a.role && typeof a.ok === 'boolean', JSON.stringify(a))
  }
  assert.deepEqual(res.agents.filter((a) => a.stage === 'global').map((a) => String(a.wave)), ['5', '5'])
})

test('script: 波の役のどれかが halt を返したら、ほかの役が next_wave を返しても新しい波を起動しない', async () => {
  const fn = fakeAgent({
    '2/f1': { notes: [], halt: true },
    '2/f2': { notes: [], next_wave_id: 3, rows: [ROW('g1', 'global')] },
  })
  const res = await runScript(waveArgs(2, [ROW('f1'), ROW('f2')]), fn)
  assert.deepEqual(fn.seen.map((x) => x.key).sort(), ['2/f1', '2/f2'])
  assert.equal(res.agents.length, 2)
})

test('script: 行を切り詰めない（maxAgents を超える行も全て起動する。行の数を収めるのは CLI）', async () => {
  const rows = Array.from({ length: C.LIMITS.maxAgents + 1 }, (_, i) => ROW(`f${i + 1}`))
  const fn = fakeAgent()
  const res = await runScript(waveArgs(1, rows), fn)
  assert.equal(fn.seen.length, rows.length)
  assert.equal(res.agents.length, rows.length)
})

test('script: 返ってきた次の波の行が壊れているか、id が今の波より大きくなければ、その波を起動しない', async () => {
  for (const reply of [
    { notes: [], next_wave_id: 2, rows: [{ id: 'g1', role: 'global_judge' }] },
    { notes: [], next_wave_id: 2, rows: 'g1' },
    { notes: [], next_wave_id: 1, rows: [ROW('g1', 'global')] },
    { notes: [], next_wave_id: 2, rows: [{ ...ROW('g1', 'global'), stage: 'review' }] },
  ]) {
    const fn = fakeAgent({ '1/f1': reply })
    const res = await runScript(waveArgs(1, [ROW('f1')]), fn)
    assert.deepEqual(fn.seen.map((x) => x.key), ['1/f1'], `起動した: ${JSON.stringify(reply)}`)
    assert.equal(res.agents.length, 1)
  }
})

// ---------------- 単独の小さい検査は呼び出し 1 件 ----------------

const MODES = [
  { name: 'coverage-build から（観点を渡し、目標は照合済み）', make: (t) => project(t, FILES), act: () => noProposalAct({ facts: FACTS }), order: ['plan', 'full_review', 'file', 'global'] },
  { name: '単独（観点を渡さず、目標の照合を計画役が担う）', make: (t) => standalone(t, FILES, { lenses: null }), act: () => planAct({ facts: FACTS }), order: ['plan', 'unit_verify', 'full_review', 'file', 'global', 'retro'] },
]
for (const mode of MODES) {
  test(`1 回で complete（${mode.name}）: next → Workflow 1 回 → ingest → next で complete になり、台帳の calls は 1 件。段の順は今の next の順`, async (t) => {
    const { state } = mode.make(t)
    const log = []
    const r = await driveScript(state, scriptAgent(mode.act(), log), { maxSteps: 3 })
    assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
    assert.equal(r.steps.length, 1, `Workflow の呼び出しは 1 回: ${r.steps.length}`)
    assert.equal(status(state).calls.length, 1, JSON.stringify(status(state).calls))
    assert.deepEqual(runsOf(wavesOf(r.steps, log).map((w) => w.stage)), mode.order)
    const keys = launchesOf(r.steps, log).map((x) => x.worker)
    assert.equal(new Set(keys).size, keys.length, `行の id は呼び出しの中で一意: ${keys}`)
    // 最後の波の役のどれかの最後の claim は halt（止まる印）と理由を持ち、next_wave を持たない。
    const lastWave = wavesOf(r.steps, log).at(-1)
    const ends = lastWave.rows.map((x) => x.claims.at(-1)).filter((c) => c && c.done && c.halt)
    assert.ok(ends.length >= 1, `止まるときの claim の done は halt を持つ: ${JSON.stringify(lastWave.rows.map((x) => x.claims.at(-1)))}`)
    assert.ok(ends.every((c) => typeof c.reason === 'string' && c.reason.length > 0 && !c.next_wave), '止まる理由')
  })
}

// ---------------- claim の照合（順序の門・書き換えの拒否） ----------------

test('claim の照合: wave・worker・model・effort・stage のどれかが台帳の波の記録と違えば（--wave が無いときも）終了状態 2 で拒み、台帳を変えない', async (t) => {
  const { state } = standalone(t, FILES, { lenses: null })
  const n = cli('next', '--state', state)
  const args = readArgs(n)
  assert.ok(args.wave, `args に wave が無い: ${JSON.stringify(args)}`)
  const row = args.wave.rows[0]
  const ok = claimArgv(state, args.callId, row, args.wave.id)
  const swap = (k, v) => { const a = [...ok]; a[a.indexOf(`--${k}`) + 1] = v; return a }
  const before = ledgerBytes(state)
  for (const [name, argv] of [
    ['違う波', swap('wave', String(Number(args.wave.id) + 100))],
    ['違う worker', swap('worker', 'no-such-row')],
    ['違う model', swap('model', row.model === 'haiku' ? 'opus' : 'haiku')],
    ['違う effort', swap('effort', row.effort === 'low' ? 'high' : 'low')],
    ['違う段', swap('stage', row.stage === 'file' ? 'global' : 'file')],
    ['--wave が無い', ['claim', '--state', state, '--call', args.callId, '--worker', row.id]],
  ]) {
    const c = cli(...argv)
    assert.equal(c.code, 2, `${name}: ${JSON.stringify(c)}`)
    assert.equal(ledgerBytes(state), before, `${name}: 台帳を変えない`)
  }
  const c = cli(...ok)
  assert.equal(c.code, 0, JSON.stringify(c))
  assert.ok(Array.isArray(c.tasks) && c.tasks.length === 1 && c.tasks[0].kind === 'plan', JSON.stringify(c))
})

test('次の波: 担当が尽きた claim の done に next_wave {id, rows} が載り、id は今の波より大きい連番、行は次の段の役の roles.json の model・effort。その行の claim が次の段の担当を取る', async (t) => {
  const { state } = standalone(t, FILES, { lenses: null })
  const args = readArgs(cli('next', '--state', state))
  assert.ok(args.wave, `args に wave が無い: ${JSON.stringify(args)}`)
  const row = args.wave.rows[0]
  const rec = await workerLoop({ state, call: args.callId, worker: row.id, role: row.role, argv: claimArgv(state, args.callId, row, args.wave.id) }, planAct({ facts: FACTS }), [])
  const nw = rec.next_wave
  assert.ok(nw, `計画役の最後の claim に next_wave が無い: ${JSON.stringify(rec.claims.at(-1))}`)
  assert.ok(Number(nw.id) > Number(args.wave.id), `波の id は連番で大きくなる: ${args.wave.id} → ${nw.id}`)
  assert.ok(nw.rows.length >= 1)
  for (const r of nw.rows) {
    assert.deepEqual(Object.keys(r).sort(), ['effort', 'id', 'model', 'role', 'stage'], JSON.stringify(r))
    assert.equal(r.stage, 'unit_verify')
    assert.deepEqual([r.role, r.model, r.effort], ['unit_verifier', ROLES.unit_verifier.model, ROLES.unit_verifier.effort])
    assert.notEqual(r.id, row.id, '行の id は呼び出しの中で使い回さない')
  }
  const c = cli(...claimArgv(state, args.callId, nw.rows[0], nw.id))
  assert.equal(c.code, 0, JSON.stringify(c))
  assert.ok(c.tasks && c.tasks[0].kind === 'unit_verify', JSON.stringify(c))
  // 前の波の役がもう一度 claim しても、次の段の担当は取れない（done だけ）。
  const again = cli(...claimArgv(state, args.callId, row, args.wave.id))
  assert.equal(again.code, 0, JSON.stringify(again))
  assert.equal(again.done, true)
  assert.ok(!again.tasks, '前の波の行に次の段の担当を渡さない')
})

test('順序の門: 記録した波の段が、その時の decide の段と合わなくなったら、その行の claim は担当を渡さず、今の段の次の波を返す', async (t) => {
  const { d, state } = standalone(t, FILES, { lenses: null })
  const args = readArgs(cli('next', '--state', state))
  assert.ok(args.wave, `args に wave が無い: ${JSON.stringify(args)}`)
  const row = args.wave.rows[0]
  const rec = await workerLoop({ state, call: args.callId, worker: row.id, role: row.role, argv: claimArgv(state, args.callId, row, args.wave.id) }, planAct({ facts: FACTS }), [])
  const uv = rec.next_wave
  assert.ok(uv && uv.rows[0].stage === 'unit_verify', JSON.stringify(rec.claims.at(-1)))
  // 目標を直す（目標の照合からやり直し、decide は計画の段に戻る）。
  writeFileSync(path.join(d, 'goal-2.md'), '- G1: 対象の文書を観点ごとに確かめた指摘の一覧 〔request: 対象の文書を観点ごとにレビューしてほしい〕\n- G2: 対象の文書を観点ごとに 〔request: 対象の文書を観点ごとにレビューしてほしい〕\n')
  assert.equal(cli('answer', '--state', state, '--id', 'goal', '--file', path.join(d, 'goal-2.md')).code, 0)
  const c = cli(...claimArgv(state, args.callId, uv.rows[0], uv.id))
  assert.equal(c.code, 0, JSON.stringify(c))
  assert.ok(!c.tasks, `段の合わない行に担当を渡さない: ${JSON.stringify(c.tasks)}`)
  assert.equal(c.done, true)
  assert.ok(c.next_wave && Number(c.next_wave.id) > Number(uv.id), JSON.stringify(c))
  assert.deepEqual(c.next_wave.rows.map((r) => r.stage), ['plan'])
})

test('書き換えた next_wave を拒む: 役が返り値の波の id を書き換えると、その波の役の claim は終了状態 2 で拒まれ、台帳は壊れず、次の呼び出しの next から complete まで進む', async (t) => {
  const { state } = project(t, FILES)
  const log = []
  let tampered = 0
  const tamper = (ret) => { if (ret.next_wave_id != null && !tampered) { tampered++; return { ...ret, next_wave_id: Number(ret.next_wave_id) + 100 } } return ret }
  const r = await driveScript(state, scriptAgent(noProposalAct({ facts: FACTS }), log, { tamper }), { maxSteps: 4 })
  assert.equal(tampered, 1, '書き換えた')
  const rejected = log.filter((x) => x.rec.claims[0] && x.rec.claims[0].code === 2)
  assert.ok(rejected.length >= 1, `書き換えた波の役の claim が拒まれる: ${JSON.stringify(log.map((x) => x.rec.claims[0] && x.rec.claims[0].code))}`)
  const real = log[0].rec.next_wave
  assert.ok(real, '計画役の最後の claim は次の波を返した')
  assert.ok(rejected.every((x) => argOf(x.claim, 'wave') === String(Number(real.id) + 100)), '拒まれたのは書き換えた波の役だけ')
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  assert.equal(r.steps.length, 2, '書き換えで止まった呼び出しの続きは、次の呼び出しが同じ台帳から進める')
})

test('書き換えた行を拒む: 役が返り値の行の model を書き換えると、その行の claim は拒まれる', async (t) => {
  const { state } = project(t, FILES)
  const log = []
  let tampered = 0
  const tamper = (ret) => (ret.rows && !tampered++ ? { ...ret, rows: ret.rows.map((x) => ({ ...x, model: x.model === 'haiku' ? 'opus' : 'haiku' })) } : ret)
  await driveScript(state, scriptAgent(noProposalAct({ facts: FACTS }), log, { tamper }), { maxSteps: 1 })
  assert.equal(tampered, 1)
  const after = log.filter((x) => argOf(x.claim, 'model') === 'haiku' || (x.model === 'haiku'))
  assert.ok(after.length >= 1, '書き換えた行が起動された')
  assert.ok(after.every((x) => x.rec.claims[0].code === 2), JSON.stringify(after.map((x) => x.rec.claims[0])))
})

// ---------------- 段の会計（波の境目で締める） ----------------

test('会計は波の境目で締める: 取ったまま出さなかった単位は、同じ呼び出しの次の波の最初の claim の時点で試行に数えて出来事に残り、その単位を読み直す', async (t) => {
  const d = tmp(t)
  const roles = rolesFile(d, { file_reader: 4000 })
  const { state } = project(t, { 'a.md': sizedDoc('a', 1500), 'b.md': sizedDoc('b', 1500) }, { extra: ['--roles', roles] })
  const seenA = []
  const a = noProposalAct({
    file: (task) => {
      if (path.basename(task.unit.path) !== 'a.md') return undefined
      seenA.push({ status: status(state) })
      return seenA.length === 1 ? null : undefined
    },
  })
  const log = []
  const r = await driveScript(state, scriptAgent(a, log), { maxSteps: 1 })
  const fileWaves = wavesOf(r.steps, log).filter((w) => w.stage === 'file')
  assert.ok(fileWaves.length >= 2, `ファイルの段の波が 2 つ以上（取り残しを読み直す波がある）: ${wavesOf(r.steps, log).map((w) => w.stage)}`)
  assert.equal(fileWaves[0].rows.length, 2, '線（file_reader の context_tokens 4000 → 2000 バイト）で 2 つの詰め合わせ')
  assert.equal(seenA.length, 2, 'a.md は 2 回目の波で読み直す')
  const s2 = seenA[1].status
  assert.equal(s2.calls.length, 0, '同じ呼び出しの中（ingest の前）')
  assert.ok(s2.events.some((e) => e.kind === 'missing_read'), `次の波の最初の claim の時点で、取ったまま出さなかった出来事がある: ${JSON.stringify(s2.events.map((e) => e.kind))}`)
})

test('起動されなかった波は会計に数えない: 記録した次の波を起動せずに呼び出しを閉じても、試行・失敗の連続・出来事は増えず、次の next が同じ段の波を新しい id で作り直す', async (t) => {
  const { state } = project(t, FILES)
  const log = []
  const tamper = (ret) => (ret.next_wave_id != null ? { notes: [] } : ret)
  const r = await driveScript(state, scriptAgent(noProposalAct({ facts: FACTS }), log, { tamper }), { maxSteps: 1 })
  assert.deepEqual(wavesOf(r.steps, log).map((w) => w.stage), ['plan'], '計画の波だけを流して閉じた')
  const recorded = log[0].rec.next_wave
  assert.ok(recorded && recorded.rows[0].stage === 'full_review', JSON.stringify(log[0].rec.claims.at(-1)))
  const L = ledger(state)
  assert.equal(L.fail_streak, 0)
  assert.deepEqual(L.attempts, {})
  assert.equal(L.full_review.attempts || 0, 0, '全文レビューの試行に数えない')
  assert.ok(!status(state).events.some((e) => /^missing_|agent_missing/.test(e.kind)), JSON.stringify(status(state).events))
  const n = cli('next', '--state', state)
  assert.equal(n.step, 'full_review', JSON.stringify(n))
  const args = readArgs(n)
  assert.ok(Number(args.wave.id) > Number(recorded.id), `作り直した波は新しい id: ${recorded.id} → ${args.wave.id}`)
})

// ---------------- 呼び出しの区切り（LIMITS） ----------------

test(`時間の区切り: 呼び出しを開いてからの経過が timeoutMs − agentTimeoutMs（${CALL_BUDGET_MS}ms）を超えたら、claim の done は halt を返し、script は新しい波を起動しない。続きは次の呼び出しが進める`, async (t) => {
  const { state } = project(t, FILES)
  const T0 = 1_800_000_000_000
  setNow(t, T0)
  let bumped = false
  const a = noProposalAct({ facts: FACTS, plan: (q) => { if (!bumped) { bumped = true; setNow(t, T0 + CALL_BUDGET_MS + 1) } return noProposal(q) } })
  const log = []
  const r = await driveScript(state, scriptAgent(a, log), { maxSteps: 3 })
  assert.ok(bumped)
  const first = wavesOf([r.steps[0]], log)
  assert.deepEqual(first.map((w) => w.stage), ['plan'], '区切りの後は新しい波を起動しない')
  const end = log[0].rec.claims.at(-1)
  assert.equal(end.done, true)
  assert.equal(end.halt, true, JSON.stringify(end))
  assert.match(String(end.reason), /時間|経過|timeoutMs/)
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  assert.equal(r.steps.length, 2, '続きは次の呼び出し 1 回で complete まで')
  assert.equal(wavesOf([r.steps[1]], log)[0].stage, 'full_review', '次の呼び出しは止まった所の次の段から')
})

test(`行の数の区切り: 呼び出しで出した行の和は maxAgents（${C.LIMITS.maxAgents}）以下に収め、超えるときは halt。続きは次の呼び出しが読む`, async (t) => {
  const d = tmp(t)
  const roles = rolesFile(d, { file_reader: 4000 })
  const n = C.LIMITS.maxAgents + 2
  const files = Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${String(i).padStart(3, '0')}.md`, sizedDoc(`f${i}`, 1500)]))
  const { state } = project(t, files, { extra: ['--roles', roles] })
  const log = []
  // 2 回目の呼び出しは、残りの単位を読む最初の波の後で止める（全体の段まで流さない）。
  const tamper = (ret, entry) => (log.length && argOf(entry.claim, 'call') !== argOf(log[0].claim, 'call') ? { notes: [], halt: true } : ret)
  const r = await driveScript(state, scriptAgent(noProposalAct({ facts: () => ({ bind: false }) }), log, { tamper }), { maxSteps: 2 })
  const w1 = wavesOf([r.steps[0]], log)
  const rows1 = w1.reduce((k, w) => k + w.rows.length, 0)
  assert.equal(rows1, C.LIMITS.maxAgents, `1 回目の呼び出しの行の和: ${w1.map((w) => `${w.stage}:${w.rows.length}`)}`)
  assert.equal(r.steps[0].res.agents.length, C.LIMITS.maxAgents)
  const file1 = w1.filter((w) => w.stage === 'file')
  assert.equal(file1.length, 1)
  assert.equal(file1[0].rows.length, C.LIMITS.maxAgents - (rows1 - file1[0].rows.length), '次の波の行は maxAgents − 出した行に収める')
  const ends = file1[0].rows.map((x) => x.claims.at(-1)).filter((c) => c && c.done && (c.halt || c.next_wave))
  assert.ok(ends.length >= 1 && ends.every((c) => c.halt), `行の和が上限に達したら halt: ${JSON.stringify(ends.slice(0, 2))}`)
  assert.ok(r.steps.length >= 2, '続きの呼び出し')
  const w2 = wavesOf([r.steps[1]], log)
  assert.equal(w2[0].stage, 'file', '次の呼び出しは残りの単位を読む')
  assert.equal(w2[0].rows.length, n - file1[0].rows.length)
})

// halt の種類: claim の done の halt は、種類の欄 halt_kind を持つ（stop: 台帳が止まる条件、time: 時間の区切り、rows: 行の数の区切り、limit: 起動数の上限）。
// 呼ぶ側（coverage-build）は理由の文でなく、この欄で止まる条件かを判じる。
test('halt の種類: claim の done の halt は halt_kind（stop・time・rows・limit）を持ち、next_wave の done は持たない', async (t) => {
  const kindsOf = (log) => log.flatMap((x) => x.rec.claims).filter((c) => c && c.done && c.halt).map((c) => c.halt_kind)
  const nexts = (log) => log.flatMap((x) => x.rec.claims).filter((c) => c && c.done && c.next_wave)
  // stop: 1 回で complete まで流すと、最後の波の halt は止まる条件。
  {
    const { state } = project(t, FILES)
    const log = []
    await driveScript(state, scriptAgent(noProposalAct({ facts: FACTS }), log), { maxSteps: 3 })
    assert.ok(kindsOf(log).length && kindsOf(log).every((k) => k === 'stop'), JSON.stringify(kindsOf(log)))
    assert.ok(nexts(log).length && nexts(log).every((c) => !('halt_kind' in c)), 'next_wave の done は halt_kind を持たない')
  }
  // time: 計画役の波の後に経過を区切りの外にする。
  {
    const { state } = project(t, FILES)
    const T0 = 1_800_000_000_000
    setNow(t, T0)
    let bumped = false
    const a = noProposalAct({ facts: FACTS, plan: (q) => { if (!bumped) { bumped = true; setNow(t, T0 + CALL_BUDGET_MS + 1) } return noProposal(q) } })
    const log = []
    await driveScript(state, scriptAgent(a, log), { maxSteps: 1 })
    assert.deepEqual(kindsOf(log), ['time'])
    setNow(t, T0)
  }
  // limit: 今の段の起動数の上限が計画役の 1 体で尽きる。
  {
    const { state } = project(t, FILES)
    assert.equal(cli('config', '--state', state, '--max-agents-total', '1').code, 0)
    const log = []
    await driveScript(state, scriptAgent(noProposalAct({ facts: FACTS }), log), { maxSteps: 1 })
    assert.deepEqual(kindsOf(log), ['limit'])
  }
  // rows: 1 回の呼び出しで出した行の和が maxAgents に達する。
  {
    const d = tmp(t)
    const roles = rolesFile(d, { file_reader: 4000 })
    const n = C.LIMITS.maxAgents + 2
    const files = Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${String(i).padStart(3, '0')}.md`, sizedDoc(`f${i}`, 1500)]))
    const { state } = project(t, files, { extra: ['--roles', roles] })
    const log = []
    await driveScript(state, scriptAgent(noProposalAct({ facts: () => ({ bind: false }) }), log), { maxSteps: 1 })
    assert.ok(kindsOf(log).length && kindsOf(log).every((k) => k === 'rows'), JSON.stringify(kindsOf(log)))
  }
})

// lock の待ちが切れたとき: 終了状態 3 で返し、台帳を変えない（役は「呼び出しが閉じた」終了状態 2 と区別し、同じ命令を流し直す）。
test('lock の待ちが切れた命令は終了状態 3 で返し、台帳を変えない。lock が空いた後に同じ命令を流し直せば通る', async (t) => {
  const { state } = project(t, FILES)
  const lock = path.join(state, 'ledger.lock')
  writeFileSync(lock, 'other-process-token')
  const before = ledgerBytes(state)
  const r = cli('next', '--state', state)
  assert.equal(r.code, 3, JSON.stringify(r))
  assert.equal(ledgerBytes(state), before, '台帳を変えない')
  rmSync(lock)
  assert.equal(cli('next', '--state', state).code, 0)
})

// ---------------- ingest の起動の記録 ----------------

test('ingest: 起動の記録の stage・wave・model・effort を台帳に取り込み、model・effort が波の記録と違う起動は出来事に残す', async (t) => {
  const { state } = project(t, FILES)
  const args = readArgs(cli('next', '--state', state))
  assert.ok(args.wave, `args に wave が無い: ${JSON.stringify(args)}`)
  const row = args.wave.rows[0]
  const rec = (over = {}) => ({ role: row.role, label: `${row.role}-${row.id}`, model: row.model, effort: row.effort, ok: true, stage: row.stage, wave: args.wave.id, ...over })
  const f = path.join(state, 'res-mismatch.json')
  writeFileSync(f, JSON.stringify({ agents: [rec({ model: row.model === 'haiku' ? 'opus' : 'haiku' })], tokens: null }))
  const g = cli('ingest', '--state', state, '--call', args.callId, '--result', f)
  assert.equal(g.code, 0, JSON.stringify(g))
  const L = ledger(state)
  const a = L.agents.at(-1)
  assert.deepEqual([a.stage, String(a.wave)], [row.stage, String(args.wave.id)], `起動の記録の段と波: ${JSON.stringify(a)}`)
  assert.ok(status(state).events.some((e) => e.kind === 'launch_mismatch'), `model の食い違いが出来事に残る: ${JSON.stringify(status(state).events.map((e) => e.kind))}`)
  // 合っている起動は出来事にしない。
  const { state: s2 } = project(t, FILES)
  const args2 = readArgs(cli('next', '--state', s2))
  assert.ok(args2.wave, JSON.stringify(args2))
  const r2 = args2.wave.rows[0]
  const f2 = path.join(s2, 'res-ok.json')
  writeFileSync(f2, JSON.stringify({ agents: [{ role: r2.role, label: 'x', model: r2.model, effort: r2.effort, ok: true, stage: r2.stage, wave: args2.wave.id }], tokens: null }))
  assert.equal(cli('ingest', '--state', s2, '--call', args2.callId, '--result', f2).code, 0)
  assert.ok(!status(s2).events.some((e) => e.kind === 'launch_mismatch'))
})

// ---------------- 線（UNIT_MAX_BYTES）は役の文脈の大きさから ----------------

test('線: roles.json の単位を読む役は context_tokens を持ち、既定は 1000000（線は × 1/4 × 2 バイト = UNIT_MAX_BYTES の 500000）', async () => {
  const { UNIT_MAX_BYTES } = await import('./ledger-core.mjs')
  for (const r of READERS) assert.equal(ROLES[r].context_tokens, 1000000, `${r} の context_tokens`)
  assert.equal(Math.min(...READERS.map((r) => ROLES[r].context_tokens)) / 4 * 2, 500000)
  assert.equal(UNIT_MAX_BYTES, 500000, '既定の線')
})

// 計画の段と全文レビューを通し、ファイルの段の最初の波の行の数を返す。
async function fileRows(t, files, tokens) {
  const d = tmp(t)
  const extra = tokens ? ['--roles', rolesFile(d, tokens)] : []
  const { state } = project(t, files, { extra })
  const log = []
  const r = await driveScript(state, scriptAgent(noProposalAct(), log), { maxSteps: 1 })
  const file = wavesOf(r.steps, log).find((w) => w.stage === 'file')
  return { state, rows: file ? file.rows.length : 0 }
}
const TWO = { 'a.md': sizedDoc('a', 1500), 'b.md': sizedDoc('b', 1500) }
test('線: 単位を読む役の context_tokens の最小値から線が決まり、roles の上書きで詰め合わせの数が変わる（単位を読まない役の値は効かない）', async (t) => {
  assert.equal((await fileRows(t, TWO, null)).rows, 1, '既定の線（500000 バイト）なら 1 つの詰め合わせ')
  assert.equal((await fileRows(t, TWO, { file_reader: 4000 })).rows, 2, 'file_reader 4000 token → 2000 バイトの線で 2 つ')
  assert.equal((await fileRows(t, TWO, { confirmer: 4000 })).rows, 2, '確認役が最小なら確認役の値で決まる（線は 1 本）')
  assert.equal((await fileRows(t, TWO, { planner: 4000 })).rows, 1, '計画役は単位を読まないので線に効かない')
})

test('線: 大きいファイルを分ける処理も同じ線を使う（線を超える 1 つのファイルは複数の単位になる）', async (t) => {
  const d = tmp(t)
  const sections = Array.from({ length: 4 }, (_, i) => `## 節${i}\n\n${sizedDoc(`s${i}`, 1200).split('\n').slice(2).join('\n')}`).join('\n')
  const { state, paths } = project(t, { 'big.md': `# 大きい文書\n\n${sections}` }, { extra: ['--roles', rolesFile(d, { full_reviewer: 4000 })] })
  cli('next', '--state', state)
  const units = status(state).units.filter((u) => u.path === paths['big.md'])
  assert.ok(units.length >= 2, `線（2000 バイト）を超える 1 つのファイルを分ける: ${units.length}`)
  const { state: s2, paths: p2 } = project(t, { 'big.md': `# 大きい文書\n\n${sections}` })
  cli('next', '--state', s2)
  assert.equal(status(s2).units.filter((u) => u.path === p2['big.md']).length, 1, '既定の線なら分けない')
})

// nextWaveOf（道具）の選び方が script と同じであることの確かめ（道具の自己点検）。
test('道具: nextWaveOf は halt があれば null、無ければ最大の id の next_wave', () => {
  assert.equal(nextWaveOf([{ next_wave: { id: 2 } }, { halt: true }]), null)
  assert.equal(nextWaveOf([{ next_wave: { id: 2 } }, { next_wave: { id: 7 } }, {}]).id, 7)
  assert.equal(nextWaveOf([{}, { next_wave: null }]), null)
  assert.deepEqual(rowsOf({ wave: { id: 1, rows: [{ id: 'a' }] } }), [{ id: 'a' }])
  assert.throws(() => rowsOf({ workers: [{ id: 'b' }] }), /波の形/)
  assert.equal(behave()({ kind: 'unknown' }, {}), null)
})
