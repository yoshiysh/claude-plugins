// 波のテスト（計画 effervescent-kindling-corbato の「中心の仕組み」と「coverage-build」の 1〜4、設計レビュー 1 回目の 1〜4・7、2 回目の E）。
// build の CLI が coverage-audit の関数を同じ process で流し、検査の段も build の段として 1 回の Workflow の波に並ぶ。役が運ぶのは制御の印（next_wave・halt）だけ。
// 外から見える口だけに依る: next の出力と args、claim の命令と出力、役の返り値、ingest、status、台帳のファイル（build.json と stateDir/audit/state）。
// 時刻の差し替えは環境変数 COVERAGE_BUILD_NOW_MS（ミリ秒。build-cli の next・claim が読む今の時刻）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { C, UNIT_MAX_BYTES } from './build-core.mjs'
import {
  AUDIT_ROLES, AUDIT_ROLE_NAMES, ROLES, act, archResult, argOf, auditStateOf, claimArgv, cli, cliArgvOf, driveScript, goalResult, isAuditStage, runScript, runsOf, setup, stageGroup, wavesOf, workerLoop,
} from './board-fixture.mjs'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build-cli.mjs')
const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8'))
const ledgerBytes = (state) => readFileSync(path.join(state, 'build.json'), 'utf8')
const auditLedgerBytes = (state) => { const f = path.join(auditStateOf(state), 'ledger.json'); return existsSync(f) ? readFileSync(f, 'utf8') : null }
const status = (state) => cli('status', '--state', state)
const argsOf = (n) => JSON.parse(readFileSync(n.args_path, 'utf8'))
const NOW = 'COVERAGE_BUILD_NOW_MS'
// 呼び出しの区切りの時間（経過がこれを超えたら halt）。build-step.js の LIMITS から。
const CALL_BUDGET_MS = C.LIMITS.timeoutMs - C.LIMITS.agentTimeoutMs
const setNow = (t, ms) => {
  const prev = process.env[NOW]
  if (!t.__nowRestore) { t.__nowRestore = true; t.after(() => { if (prev === undefined) delete process.env[NOW]; else process.env[NOW] = prev }) }
  process.env[NOW] = String(ms)
}
// next を流して最初の波の args を返す（波の形でなければ assertion で落とす）。
function openWave(state) {
  const n = cli('next', '--state', state)
  assert.equal(n.code, 0, JSON.stringify(n))
  assert.ok(n.args_path, `next が Workflow の呼び出しを開かない: ${JSON.stringify(n)}`)
  const args = argsOf(n)
  assert.ok(args.wave && Array.isArray(args.wave.rows), `args に wave {id, rows} が無い: ${JSON.stringify(args)}`)
  return { n, args }
}
// 最初の波の行（目標の照合役）を偽の役で流し、最後の claim の next_wave を返す。
async function passFirstWave(state, a = act()) {
  const { args } = openWave(state)
  const row = args.wave.rows[0]
  assert.equal(row.role, 'goal_checker', JSON.stringify(args.wave))
  const rec = await workerLoop({ state, call: args.callId, worker: row.id, role: row.role, argv: claimArgv(state, args.callId, row, args.wave.id) }, a)
  return { args, row, rec, nw: rec.next_wave }
}
const lastClaim = (l) => (l.rec && l.rec.claims.length ? (l.rec.claims.at(-1).out || l.rec.claims.at(-1)) : null)

// ---------------- 1. 検査の取り込み・2. build の波 ----------------

test('取り込み: next は step: audit を返さず、検査の役（行の stage が audit:…、役は coverage-audit の roles.json）が同じ Workflow の波に並び、claim・submit の口は build-cli.mjs。create は 1 回の呼び出しで complete', async (t) => {
  const { state } = setup(t)
  const r = await driveScript(state, act(), { maxSteps: 3 })
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  assert.ok(r.steps.every((s) => s.step !== 'audit'), `main session の取り込み（step: audit）が無い: ${r.steps.map((s) => s.step)}`)
  assert.equal(r.steps.length, 1, `Workflow の呼び出しは 1 回: ${r.steps.map((s) => s.step)}`)
  const audits = r.launches.filter((x) => isAuditStage(x.stage))
  assert.ok(audits.length >= 2, `検査の役が波に並ぶ: ${r.launches.map((x) => x.stage)}`)
  for (const x of audits) {
    assert.ok(AUDIT_ROLE_NAMES.includes(x.role), `検査の役は coverage-audit の roles.json の key: ${x.role}`)
    assert.deepEqual([x.model, x.effort], [AUDIT_ROLES[x.role].model, AUDIT_ROLES[x.role].effort], x.role)
    assert.ok(x.prompt.split('\n').some((l) => l.includes('build-cli.mjs') && /\sclaim\s/.test(l)), '検査の役の claim の口は build-cli.mjs')
    assert.ok(!x.prompt.includes('ledger-cli.mjs'), '検査の役の prompt に coverage-audit の CLI を直接流させない')
    for (const s of x.rec.submits) assert.equal(s.out.code, 0, JSON.stringify(s.out))
  }
  assert.ok(audits.some((x) => x.rec.submits.some((s) => (s.out.results || []).some((y) => y.ok))), '検査の役の提出を build-cli.mjs の submit が受理した')
  // 検査の台帳は stateDir/audit/state の 1 つ。
  const ledgers = readdirSync(state, { recursive: true }).map(String).filter((f) => path.basename(f) === 'ledger.json')
  assert.deepEqual(ledgers, [path.join('audit', 'state', 'ledger.json')])
  const s = status(state)
  assert.ok(s.audits && s.audits.design && s.audits.impl, `設計レビューと実装レビューを取り込んだ: ${JSON.stringify(s.audits)}`)
  // 段の順（振り返りを除く）: 設計 → 設計レビュー → テスト → 実装 → 実装レビュー。
  assert.deepEqual(runsOf(wavesOf(r.launches).map((w) => stageGroup(w.stage)).filter((g) => g !== 'retro')), ['design', 'audit', 'tests', 'implement', 'audit'])
})

test('build の波: 方式設計の受理の時点で設計の写しを書き、詳細設計の行は方式設計の役の最後の claim の next_wave で遅れて作る（同じ呼び出し）', async (t) => {
  const { state } = setup(t)
  const seen = []
  const r = await driveScript(state, act(), {
    maxSteps: 1,
    onLaunch: (x) => { if (x.role === 'unit_designer') seen.push({ call: x.call, arch: existsSync(path.join(state, 'design', '_architecture.md')), units: ['U1', 'U2', 'U3'].map((u) => existsSync(path.join(state, 'design', `${u}.md`))) }) },
  })
  assert.ok(r.steps.length >= 1, JSON.stringify(r.stop))
  const first = r.steps[0].args
  assert.ok(first.wave, `args に wave が無い: ${JSON.stringify(first)}`)
  assert.deepEqual(first.wave.rows.map((w) => w.role), ['goal_checker'], '最初の波は目標の照合役だけ（詳細設計の行を先に作らない）')
  const arch = r.launches.find((x) => x.role === 'architect')
  const spec = r.launches.filter((x) => x.role === 'unit_designer')
  assert.ok(arch && spec.length, `方式設計と詳細設計の役が同じ呼び出しで起動する: ${r.launches.map((x) => x.role)}`)
  assert.ok(spec.every((x) => x.call === arch.call), '同じ呼び出し')
  const nw = arch.rec.next_wave
  assert.ok(nw && spec.every((x) => nw.rows.some((w) => w.id === x.worker && w.role === 'unit_designer' && w.stage === 'design')), `詳細設計の行は方式設計の役の next_wave の行: ${JSON.stringify(nw)}`)
  assert.ok(seen.length && seen.every((x) => x.arch && x.units.every(Boolean)), `詳細設計の役が起動する時点で _architecture.md と単位の写しがある: ${JSON.stringify(seen)}`)
})

test('build の波: テスト → 実装と、振り返りの計画役 → 実行役 → 検証役が、それぞれ同じ呼び出しの中で順に流れる', async (t) => {
  const { state } = setup(t)
  // 実装の担当の最初の提出は受け持ちの外を申告して拒まれる（出来事が振り返りを起こす）。2 回目は既定の結果。
  const a = act({ implementer: (q, task, ctx) => (ctx.attempt === 1 && q.unit.id === 'U1' ? { unit_id: q.unit.id, written: ['src/zzz.mjs'], notes: '', unresolved: [] } : undefined) })
  const r = await driveScript(state, a, { maxSteps: 3 })
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  const by = (role) => r.launches.filter((x) => x.role === role)
  const callOf = (role) => [...new Set(by(role).map((x) => x.call))]
  assert.ok(by('test_writer').length && by('implementer').length, r.launches.map((x) => x.role).join(','))
  assert.equal(callOf('test_writer')[0], callOf('implementer')[0], 'テストの波と実装の波は同じ呼び出し')
  const idx = (role) => r.launches.findIndex((x) => x.role === role)
  assert.ok(idx('test_writer') < idx('implementer'), 'テストの波が先')
  for (const role of ['retro_planner', 'retro_examiner', 'retro_verifier']) assert.ok(by(role).length, `${role} が起動する: ${r.launches.map((x) => x.role)}`)
  assert.equal(new Set(['retro_planner', 'retro_examiner', 'retro_verifier'].flatMap(callOf)).size, 1, '振り返りの 3 つの役は同じ呼び出し')
  assert.ok(idx('retro_planner') < idx('retro_examiner') && idx('retro_examiner') < idx('retro_verifier'), '計画役 → 実行役 → 検証役の順')
})

test('順序の門: 記録した波の役が、その時の decide の担当と合わなくなったら、claim は担当を渡さず、今の担当の次の波を返す', async (t) => {
  const { d, state } = setup(t)
  const { nw } = await passFirstWave(state)
  assert.ok(nw && nw.rows.length === 1 && nw.rows[0].role === 'architect', `目標の照合の後の波は方式設計: ${JSON.stringify(nw)}`)
  // 目標を直す（目標の照合からやり直し、decide は目標の照合に戻る）。
  writeFileSync(path.join(d, 'goal-2.md'), '- G1: 値を計算する関数と、その使い方の文書 〔request: 値を計算する関数を作り、使い方を書いてほしい〕\n- G2: 値を計算する関数 〔request: 値を計算する関数を作り、使い方を書いてほしい〕\n')
  assert.equal(cli('answer', '--state', state, '--id', 'goal', '--file', path.join(d, 'goal-2.md')).code, 0)
  const c = cli(...claimArgv(state, argsOfPending(state), nw.rows[0], nw.id))
  assert.equal(c.code, 0, JSON.stringify(c))
  assert.ok(!c.tasks, `担当の合わない行に方式設計の担当を渡さない: ${JSON.stringify(c.tasks)}`)
  assert.equal(c.done, true)
  assert.ok(c.next_wave && Number(c.next_wave.id) > Number(nw.id), JSON.stringify(c))
  assert.deepEqual(c.next_wave.rows.map((w) => w.role), ['goal_checker'])
})
// 開いている呼び出しの id（台帳の pending）。
function argsOfPending(state) { const P = ledger(state).pending; assert.ok(P && P.call_id, JSON.stringify(P)); return P.call_id }

// ---------------- 3. 書く段の検査（波ごとの開始の hash と許す paths） ----------------

test('書く段: テストの波と実装の波が同じ呼び出しで流れても、実装の波はテストの波が書いたテストのファイルを受け持ちの外の変更に数えない（波ごとに開始の hash を持つ）', async (t) => {
  const { state } = setup(t)
  const r = await driveScript(state, act(), { maxSteps: 3 })
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  const calls = new Set(r.launches.filter((x) => ['test_writer', 'implementer'].includes(x.role)).map((x) => x.call))
  assert.equal(calls.size, 1, 'テストと実装は同じ呼び出し')
  const L = ledger(state)
  assert.ok(!L.events.some((e) => e.kind === 'write_outside'), `受け持ちの外の変更は無い: ${JSON.stringify(L.events.filter((e) => e.kind === 'write_outside'))}`)
  assert.ok(status(state).units.every((u) => u.implemented), JSON.stringify(status(state).units))
})

test('書く段: テストの波でテストの担当が実装の paths を書くと、同じ呼び出しの中で受け持ちの外の変更として受け付けない', async (t) => {
  const { state } = setup(t)
  const a = act({
    test_writer: (q) => {
      if (q.unit.id !== 'U1') return undefined
      mkdirSync(path.join(q.repo, 'src'), { recursive: true })
      writeFileSync(path.join(q.repo, 'src', 'a.mjs'), 'export const value = 2 // テストの担当が書いた実装の行\n')
      return undefined
    },
  })
  const r = await driveScript(state, a, { maxSteps: 1 })
  const tw = r.launches.filter((x) => x.role === 'test_writer')
  assert.ok(tw.length, r.launches.map((x) => x.role).join(','))
  assert.ok(r.steps[0] && r.steps[0].args.wave, '波の形の呼び出し')
  const L = ledger(state)
  assert.ok(L.events.some((e) => e.kind === 'write_outside' && e.text.includes('src/a.mjs')), JSON.stringify(L.events.map((e) => [e.kind, e.text])))
  assert.notEqual(L.units.U1.tests_for, L.units.U1.design_hash, 'U1 のテストを受け付けない')
  assert.equal(new Set(r.launches.filter((x) => ['unit_designer', 'test_writer'].includes(x.role)).map((x) => x.call)).size, 1, '詳細設計とテストは同じ呼び出し')
})

test('書く段: 実装の波で実装の担当がテストの paths を書き換えると、同じ呼び出しの中で受け付けない', async (t) => {
  const { state } = setup(t)
  const a = act({
    implementer: (q) => {
      if (q.unit.id !== 'U1') return undefined
      writeFileSync(path.join(q.repo, 'test', 'a.test.mjs'), '// 実装の担当が書き換えたテストの行\n')
      return undefined
    },
  })
  const r = await driveScript(state, a, { maxSteps: 1 })
  const L = ledger(state)
  assert.ok(L.events.some((e) => ['write_outside', 'rejected_output'].includes(e.kind) && e.text.includes('test/a.test.mjs')), JSON.stringify(L.events.map((e) => [e.kind, e.text])))
  assert.notEqual(L.units.U1.impl_for, L.units.U1.design_hash, 'U1 の実装を受け付けない')
  const calls = new Set(r.launches.filter((x) => ['test_writer', 'implementer'].includes(x.role)).map((x) => x.call))
  assert.equal(calls.size, 1, 'テストと実装は同じ呼び出し')
})

// ---------------- 4. check で止まる ----------------

test('check: decide が checks になったら claim の done は halt を返し、next は step: checks を返す。小さい update（2 単位・check 1 つ）は check の前後の 2 回の Workflow で complete', async (t) => {
  const { state } = setup(t, { mode: 'update', checks: [[process.execPath, '-e', '0']] })
  const r = await driveScript(state, act({ arch: { units: 'chain' } }), { maxSteps: 6 })
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  assert.deepEqual(r.steps.map((s) => (s.step === 'checks' ? 'checks' : 'workflow')), ['workflow', 'checks', 'workflow'], r.steps.map((s) => s.step).join(','))
  for (const s of r.steps.filter((x) => x.step !== 'checks')) assert.ok(s.launches.length <= C.LIMITS.maxAgents, `今の LIMITS の中: ${s.launches.length}`)
  const first = r.steps[0].launches
  const ends = first.map(lastClaim).filter((c) => c && c.done && c.halt)
  assert.ok(ends.length >= 1, `check の前の最後の波の claim は halt: ${JSON.stringify(first.map(lastClaim).slice(-2))}`)
  assert.ok(ends.every((c) => /check/.test(String(c.reason)) && !c.next_wave), JSON.stringify(ends))
  assert.ok(status(state).checks && status(state).checks.results.every((x) => x.code === 0), JSON.stringify(status(state).checks))
  // 1 回目に baseline・design、2 回目に impl の検査を流す。
  const auditCalls = (s) => s.launches.filter((x) => isAuditStage(x.stage)).length
  assert.ok(auditCalls(r.steps[0]) > 0 && auditCalls(r.steps[2]) > 0, '検査の役は両方の呼び出しに並ぶ')
})

// ---------------- 8. model・effort の照合 ----------------

test('claim の照合: wave・worker・model・effort・stage のどれかが台帳の波の記録と違えば（--wave が無いときも）終了状態 2 で拒み、台帳を変えない', async (t) => {
  const { state } = setup(t)
  const { args } = openWave(state)
  const row = args.wave.rows[0]
  const ok = claimArgv(state, args.callId, row, args.wave.id)
  const swap = (k, v) => { const a = [...ok]; a[a.indexOf(`--${k}`) + 1] = v; return a }
  const before = ledgerBytes(state)
  for (const [name, argv] of [
    ['違う波', swap('wave', String(Number(args.wave.id) + 100))],
    ['違う worker', swap('worker', 'no-such-row')],
    ['違う model', swap('model', row.model === 'haiku' ? 'opus' : 'haiku')],
    ['違う effort', swap('effort', row.effort === 'low' ? 'high' : 'low')],
    ['違う段', swap('stage', row.stage === 'tests' ? 'implement' : 'tests')],
    ['--wave が無い', ['claim', '--state', state, '--call', args.callId, '--worker', row.id]],
  ]) {
    const c = cli(...argv)
    assert.equal(c.code, 2, `${name}: ${JSON.stringify(c)}`)
    assert.equal(ledgerBytes(state), before, `${name}: 台帳を変えない`)
  }
  const c = cli(...ok)
  assert.equal(c.code, 0, JSON.stringify(c))
  assert.ok(Array.isArray(c.tasks) && c.tasks.length === 1 && c.tasks[0].kind === 'goal', JSON.stringify(c))
})

test('claim の照合（検査の役）: 検査の行の model が波の記録と違えば終了状態 2 で拒み、build の台帳も検査の台帳も変えない', async (t) => {
  const { state } = setup(t, { mode: 'update' })
  const { nw } = await passFirstWave(state)
  assert.ok(nw && nw.rows.length && nw.rows.every((w) => isAuditStage(w.stage)), `update の目標の照合の後の波は現状の検査: ${JSON.stringify(nw)}`)
  const row = nw.rows[0]
  assert.equal(row.stage, 'audit:plan')
  assert.deepEqual([row.role, row.model, row.effort], ['planner', AUDIT_ROLES.planner.model, AUDIT_ROLES.planner.effort])
  const call = argsOfPending(state)
  const bad = claimArgv(state, call, { ...row, model: row.model === 'haiku' ? 'opus' : 'haiku' }, nw.id)
  const before = [ledgerBytes(state), auditLedgerBytes(state)]
  const c = cli(...bad)
  assert.equal(c.code, 2, JSON.stringify(c))
  assert.deepEqual([ledgerBytes(state), auditLedgerBytes(state)], before, '台帳を変えない')
  const good = cli(...claimArgv(state, call, row, nw.id))
  assert.equal(good.code, 0, JSON.stringify(good))
  assert.ok(good.tasks && good.tasks[0].kind === 'plan', JSON.stringify(good))
})

test('ingest: 起動の記録の model・effort が台帳の波の記録と違う起動を、出来事（launch_mismatch）に残す。合っている起動は残さない', async (t) => {
  for (const mismatch of [true, false]) {
    const { state } = setup(t)
    const { args } = openWave(state)
    const row = args.wave.rows[0]
    const f = path.join(state, `res-${mismatch}.json`)
    const model = mismatch ? (row.model === 'haiku' ? 'opus' : 'haiku') : row.model
    writeFileSync(f, JSON.stringify({ agents: [{ role: row.role, label: `${row.role}-${row.id}`, model, effort: row.effort, ok: true, stage: row.stage, wave: args.wave.id }], tokens: null }))
    const g = cli('ingest', '--state', state, '--call', args.callId, '--result', f)
    assert.equal(g.code, 0, JSON.stringify(g))
    const kinds = ledger(state).events.map((e) => e.kind)
    assert.equal(kinds.includes('launch_mismatch'), mismatch, JSON.stringify(kinds))
    const a = ledger(state).agents.at(-1)
    assert.deepEqual([a.stage, String(a.wave)], [row.stage, String(args.wave.id)], `起動の記録の段と波を取り込む: ${JSON.stringify(a)}`)
  }
})

test('書き換えた next_wave を拒む: 役が返り値の波の id を書き換えると、その波の役の claim は終了状態 2 で拒まれ、台帳は壊れず、次の呼び出しから complete まで進む', async (t) => {
  const { state } = setup(t)
  let tampered = 0
  const tamper = (ret) => { if (ret.next_wave_id == null || tampered) return ret; tampered++; return { ...ret, next_wave_id: Number(ret.next_wave_id) + 100 } }
  const r = await driveScript(state, act(), { maxSteps: 4, tamper })
  assert.equal(tampered, 1)
  const rejected = r.launches.filter((x) => x.rec && x.rec.claims[0] && (x.rec.claims[0].out || x.rec.claims[0]).code === 2)
  assert.ok(rejected.length >= 1, `書き換えた波の役の claim が拒まれる: ${JSON.stringify(r.launches.map((x) => x.wave))}`)
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  assert.equal(r.steps.length, 2, '書き換えで止まった呼び出しの続きは、次の呼び出しが同じ台帳から進める')
})

test('検査の役の起動の記録: model・effort・stage・ok を、build の台帳に加えて coverage-audit の台帳の agents にも入れ、coverage-audit の calls の起動数も少なく数えない', async (t) => {
  const { state } = setup(t)
  const r = await driveScript(state, act(), { maxSteps: 3 })
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  const launched = r.launches.filter((x) => isAuditStage(x.stage))
  assert.ok(launched.length > 0)
  const AL = JSON.parse(readFileSync(path.join(auditStateOf(state), 'ledger.json'), 'utf8'))
  // coverage-audit の台帳の段は、coverage-audit の段の名前（audit: の前置きを除く）。
  const key = (role, model, effort, stage, ok) => `${role}|${model}|${effort}|${stage}|${ok}`
  const want = launched.map((x) => key(x.role, x.model, x.effort, String(x.stage).slice('audit:'.length), true)).sort()
  const got = (AL.agents || []).map((a) => key(a.role, a.model, a.effort, a.stage, !!a.ok)).sort()
  assert.deepEqual(got, want, `coverage-audit の台帳の起動の記録: ${JSON.stringify(AL.agents)}`)
  const counted = (AL.calls || []).reduce((n, c) => n + (c.agents || 0), 0)
  assert.equal(counted, launched.length, `coverage-audit の calls の起動数: ${JSON.stringify(AL.calls)}`)
})

// ---------------- 9. 会計と区切り ----------------

test('起動されなかった波は会計に数えない: 記録した次の波を起動せずに呼び出しを閉じても、試行・失敗の連続・出来事は増えず、次の next が同じ担当の波を新しい id で作り直す', async (t) => {
  const { state } = setup(t)
  const tamper = (ret, entry) => (entry.role === 'goal_checker' ? { notes: [] } : ret)
  const r = await driveScript(state, act(), { maxSteps: 1, tamper })
  assert.deepEqual(r.launches.map((x) => x.role), ['goal_checker'], '目標の照合の波だけを流して閉じた')
  const recorded = r.launches[0].rec.next_wave
  assert.ok(recorded && recorded.rows[0].role === 'architect', JSON.stringify(lastClaim(r.launches[0])))
  const L = ledger(state)
  assert.equal(L.fail_streak, 0)
  assert.deepEqual(L.attempts, {})
  assert.ok(!L.events.some((e) => /missing/.test(e.kind)), JSON.stringify(L.events))
  const { args } = openWave(state)
  assert.ok(Number(args.wave.id) > Number(recorded.id), `作り直した波は新しい id: ${recorded.id} → ${args.wave.id}`)
  assert.deepEqual(args.wave.rows.map((w) => w.role), ['architect'])
})

test('環境の失敗の印は波ごと、fail_streak は呼び出し全体: 前の波に受理があれば、後の波で取ったまま出さなかった担当は環境の失敗の試行に数え、fail_streak には数えない', async (t) => {
  const { state } = setup(t)
  const r = await driveScript(state, act({ architect: () => null }), { maxSteps: 1 })
  assert.deepEqual(r.launches.map((x) => x.role), ['goal_checker', 'architect'], '同じ呼び出しで目標の照合の後に方式設計の波')
  const L = ledger(state)
  assert.equal(L.goal.checked, true)
  assert.equal(L.fail_streak, 0, '呼び出しの中に受理があるので失敗の連続に数えない')
  assert.equal(L.attempts.arch, 1, '方式設計の担当を 1 回の試行に数える')
  assert.equal((L.env_attempts || {}).arch, 1, '方式設計の波には提出が無いので、その試行は環境の失敗の印を持つ')
})

test(`時間の区切り: 呼び出しを開いてからの経過が timeoutMs − agentTimeoutMs（${CALL_BUDGET_MS}ms）を超えたら、claim の done は halt を返し、新しい波を起動しない。続きは次の呼び出しが進める`, async (t) => {
  const { state } = setup(t)
  const T0 = 1_800_000_000_000
  setNow(t, T0)
  let bumped = false
  const a = act({ goal_checker: (q) => { if (!bumped) { bumped = true; setNow(t, T0 + CALL_BUDGET_MS + 1) } return goalResult(q) } })
  const r = await driveScript(state, a, { maxSteps: 2 })
  assert.ok(bumped)
  assert.ok(r.steps.length >= 2, JSON.stringify(r.stop))
  assert.deepEqual(r.steps[0].launches.map((x) => x.role), ['goal_checker'], '区切りの後は新しい波を起動しない')
  const end = lastClaim(r.steps[0].launches[0])
  assert.equal(end.done, true)
  assert.equal(end.halt, true, JSON.stringify(end))
  assert.match(String(end.reason), /時間|経過|timeoutMs/)
  assert.equal(r.steps[1].launches[0].role, 'architect', '次の呼び出しは止まった所の次の担当から')
})

// fixture の大きさは線の既定（UNIT_MAX_BYTES）に比例させる（100KB の線で作った大きさの倍率）。
const S = UNIT_MAX_BYTES / 100000
test(`行の数の区切り: 呼び出しで出した行の和は maxAgents（${C.LIMITS.maxAgents}）以下に収め、超えるときは halt。続きは次の呼び出しが進める`, async (t) => {
  const { repo, state } = setup(t)
  const N = C.LIMITS.maxAgents + 5
  // 1 体に 1 単位しか詰められない大きさの doc の単位を N 個（詳細設計の詰め合わせが N 行になる）。
  const big = `${'大きい文書の本文の行です。'.repeat(20)}\n`.repeat(200 * S)
  mkdirSync(path.join(repo, 'docs'), { recursive: true })
  for (let i = 1; i <= N; i++) writeFileSync(path.join(repo, 'docs', `big-${i}.md`), big)
  const units = (cover) => Array.from({ length: N }, (_, i) => ({ id: `U${i + 1}`, kind: 'doc', title: `文書 ${i + 1}`, responsibility: '使い方を書く', paths: [`docs/big-${i + 1}.md`], tests: [], test_uses: [], depends_on: [], covers: cover }))
  const a = act({ architect: (q) => archResult(q, { patch: () => units(q.cover_ids || []) }) })
  // 2 回目の呼び出しは最初の波の後で止める。
  let firstCall = null
  const tamper = (ret, entry) => { firstCall = firstCall ?? entry.call; return entry.call !== firstCall ? { notes: [], halt: true } : ret }
  const r = await driveScript(state, a, { maxSteps: 2, tamper })
  assert.ok(r.steps.length >= 2, JSON.stringify(r.stop))
  const c1 = r.steps[0].launches
  assert.equal(c1.length, C.LIMITS.maxAgents, `1 回目の呼び出しの行の和: ${wavesOf(c1).map((w) => `${w.stage}:${w.rows.length}`)}`)
  const spec1 = c1.filter((x) => x.role === 'unit_designer')
  assert.equal(spec1.length, C.LIMITS.maxAgents - 2, '次の波の行は maxAgents − 出した行（目標の照合と方式設計の 2 行）に収める')
  const ends = spec1.map(lastClaim).filter((c) => c && c.done && (c.halt || c.next_wave))
  assert.ok(ends.length >= 1 && ends.every((c) => c.halt), `行の和が上限に達したら halt: ${JSON.stringify(ends.slice(0, 2))}`)
  const c2 = wavesOf(r.steps[1].launches)
  assert.equal(c2[0].rows[0].role, 'unit_designer', '次の呼び出しは残りの単位の詳細設計から')
  assert.equal(c2[0].rows.length, N - spec1.length)
})

// ---------------- 1. lock の順 ----------------

function spawnCli(argv) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...argv])
    let out = ''
    p.stdout.on('data', (b) => { out += b })
    p.on('close', (code) => { let j = {}; try { j = JSON.parse(out) } catch { j = { raw: out } } resolve({ code, ...j }) })
  })
}
test('lock の順: 検査の段の claim は build の lock を取ってから検査の台帳の lock を取る（検査の lock を待つ間も build の lock を持つ）。終われば両方を残さない', async (t) => {
  const { state } = setup(t, { mode: 'update' })
  const { nw } = await passFirstWave(state)
  assert.ok(nw && isAuditStage(nw.rows[0].stage), JSON.stringify(nw))
  const call = argsOfPending(state)
  const auditLock = path.join(auditStateOf(state), 'ledger.lock')
  const buildLock = path.join(state, 'build.lock')
  mkdirSync(auditStateOf(state), { recursive: true })
  writeFileSync(auditLock, 'other-process-token')
  const p = spawnCli(claimArgv(state, call, nw.rows[0], nw.id))
  // 子の process の起動の遅れに依らないよう、子が build の lock を取ったこと（build.lock が現れること）を合図に待つ。
  // 検査の台帳の lock は持ったままなので、子はそこで待つ（待ちの上限 10 秒より前に合図が来る）。
  const deadline = Date.now() + 8000
  while (!existsSync(buildLock) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  const heldBuild = existsSync(buildLock)
  rmSync(auditLock)
  const c = await p
  assert.ok(heldBuild, '検査の台帳の lock を待つ間、build の lock を持っている（build → audit の順）')
  assert.equal(c.code, 0, JSON.stringify(c))
  assert.ok(c.tasks && c.tasks.length, JSON.stringify(c))
  assert.ok(!existsSync(buildLock) && !existsSync(auditLock), 'lock を残さない')
})

// ---------------- 道具（auditAct を本物の coverage-audit の CLI で確かめる。実装の前でも通る） ----------------

test('道具: auditAct は status の confirmed を、その path の単位のファイルの段の指摘にし、本物の coverage-audit が確定した指摘として持つ', async (t) => {
  const { tmp: auditTmp, cli: auditCli, driveScript: auditDrive, scriptAgent } = await import('../../coverage-audit/scripts/blackboard-fixture.mjs')
  const { auditAct } = await import('./board-fixture.mjs')
  const { auditStatus } = await import('./test-harness.mjs')
  const root = auditTmp(t)
  const dir = auditStateOf(root)
  const target = path.join(root, 'design', 'U1.md')
  mkdirSync(path.dirname(target), { recursive: true })
  const quote = '入力を受け取り、決まった値を返す。'
  writeFileSync(target, `# U1\n\n${quote}\n`)
  writeFileSync(path.join(root, 'goal.md'), '- G1: 値を計算する関数と、その使い方の文書\n')
  writeFileSync(path.join(root, 'request.md'), '値を計算する関数を作り、使い方を書いてほしい')
  writeFileSync(path.join(root, 'lenses.json'), JSON.stringify([{ id: 'design-fit', name: '設計の充足', procedure: '設計の決定を列挙し、目標と照らす' }]))
  const init = auditCli('init', '--state', dir, '--goal', path.join(root, 'goal.md'), '--request', path.join(root, 'request.md'), '--lenses', path.join(root, 'lenses.json'), '--target', target, '--phase', 'design', '--goal-checked', 'coverage-build')
  assert.equal(init.code, 0, JSON.stringify(init))
  let called = 0
  const audit = (phase) => { called++; return auditStatus({ phase, confirmed: [{ path: target, quote, layer: '詳細設計', claim: '値の決め方が基準に照らせない' }] }) }
  const r = await auditDrive(dir, scriptAgent(auditAct(root, audit)), { maxSteps: 4 })
  assert.ok(['complete', 'needs_input'].includes(r.stop && r.stop.stop), JSON.stringify(r.stop))
  assert.equal(called, 1, '段の始まりごとに 1 回だけ呼ぶ')
  const st = auditCli('status', '--state', dir)
  const confirmed = (st.findings && st.findings.confirmed) || []
  assert.ok(confirmed.some((f) => f.layer === '詳細設計' && /値の決め方/.test(f.claim)), JSON.stringify(confirmed))
})

// 本物の coverage-audit の台帳を root/audit/state に作る（build の置き場と同じ形。auditAct は root の段の位置を読む）。
async function standaloneAudit(t, phase, body, extra = {}) {
  const { tmp: auditTmp, cli: auditCli } = await import('../../coverage-audit/scripts/blackboard-fixture.mjs')
  const root = auditTmp(t)
  const dir = auditStateOf(root)
  const target = path.join(root, 'design', 'U1.md')
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, body)
  const more = Object.entries(extra).map(([name, text]) => { const f = path.join(root, 'design', name); writeFileSync(f, text); return f })
  writeFileSync(path.join(root, 'goal.md'), '- G1: 値を計算する関数と、その使い方の文書\n')
  writeFileSync(path.join(root, 'request.md'), '値を計算する関数を作り、使い方を書いてほしい')
  writeFileSync(path.join(root, 'lenses.json'), JSON.stringify([{ id: 'design-fit', name: '設計の充足', procedure: '設計の決定を列挙し、目標と照らす' }]))
  const init = auditCli('init', '--state', dir, '--goal', path.join(root, 'goal.md'), '--request', path.join(root, 'request.md'), '--lenses', path.join(root, 'lenses.json'), '--target', target, ...more.flatMap((f) => ['--target', f]), '--phase', phase, '--goal-checked', 'coverage-build')
  assert.equal(init.code, 0, JSON.stringify(init))
  return { root, dir, target, auditCli }
}

test('道具: auditAct は status の群（groups）を束ねに写し（1 つの指摘は 1 つの群）、本物の coverage-audit の群の id は周 1 で G1-<id>、指摘ごとの群も status のとおり', async (t) => {
  const { driveScript: auditDrive, scriptAgent } = await import('../../coverage-audit/scripts/blackboard-fixture.mjs')
  const { auditAct } = await import('./board-fixture.mjs')
  const { auditStatus } = await import('./test-harness.mjs')
  const quote = '入力を受け取り、決まった値を返す。'
  const { root, dir, target, auditCli } = await standaloneAudit(t, 'design', `# U1\n\n${quote}\n`)
  const fs = [{ claim: '指摘A', groups: ['G1-GS'] }, { claim: '指摘B', groups: ['G1-XX'] }, { claim: '指摘C' }]
  const audit = (phase) => {
    const st = auditStatus({ phase, confirmed: fs.map((f) => ({ path: target, quote, layer: '詳細設計', claim: f.claim })) })
    fs.forEach((f, i) => { if (f.groups) st.findings.confirmed[i].groups = f.groups })
    st.groups = [{ id: 'G1-GS', layer: '詳細設計', root_cause: '根の原因 GS', keys: [] }, { id: 'G1-XX', layer: '詳細設計', root_cause: '根の原因 XX', keys: [] }]
    return st
  }
  const r = await auditDrive(dir, scriptAgent(auditAct(root, audit)), { maxSteps: 4 })
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  const st = auditCli('status', '--state', dir)
  const by = Object.fromEntries(st.findings.confirmed.map((f) => [f.claim, [...(f.groups || [])].sort()]))
  assert.deepEqual(Object.keys(by).sort(), ['指摘A', '指摘B', '指摘C'], '同じ引用で claim の違う 3 件は別の指摘')
  assert.deepEqual(by, { 指摘A: ['G1-GS'], 指摘B: ['G1-XX'], 指摘C: [] })
  assert.deepEqual(st.groups.map((g) => g.id).sort(), ['G1-GS', 'G1-XX'])
})

test('道具: auditRejectOnce は実装レビューのファイルの段の最初の提出を照合に落とし、coverage-audit の出来事を残したまま complete まで進む', async (t) => {
  const { driveScript: auditDrive, scriptAgent } = await import('../../coverage-audit/scripts/blackboard-fixture.mjs')
  const { auditAct, auditRejectOnce } = await import('./board-fixture.mjs')
  const { root, dir, auditCli } = await standaloneAudit(t, 'impl', '# U1\n\n入力を受け取り、決まった値を返す。\n')
  const r = await auditDrive(dir, scriptAgent(auditAct(root, null, auditRejectOnce(root))), { maxSteps: 4 })
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  const st = auditCli('status', '--state', dir)
  assert.ok((st.events || []).length >= 1, `出来事が残る: ${JSON.stringify(st.events)}`)
})

test('道具: ファイルの段の提出が照合に落ち続ける単位は（ほかの単位を受理していれば）試行の上限で開示（skip）され、検査は complete で止まる', async (t) => {
  const { driveScript: auditDrive, scriptAgent } = await import('../../coverage-audit/scripts/blackboard-fixture.mjs')
  const { auditAct } = await import('./board-fixture.mjs')
  const { root, dir, target, auditCli } = await standaloneAudit(t, 'baseline', '# U1\n\n入力を受け取り、決まった値を返す。\n', { 'U2.md': '# U2\n\n使い方を書いた文書の本文の行です。\n' })
  const bad = { seen: [], findings: [], references: [], guarantees: [], premises: [] }
  const r = await auditDrive(dir, scriptAgent(auditAct(root, null, { file: (task) => (path.resolve(task.unit.path) === target ? bad : undefined) })), { maxSteps: 6 })
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  const st = auditCli('status', '--state', dir)
  assert.ok((st.skip || []).length >= 1, `開示した単位: ${JSON.stringify(st.skip)}`)
})

// ---------------- Workflow script（偽の agent だけで流す。台帳は使わない） ----------------
// coverage-audit の waves.test.mjs の「script:」の 4 つの振る舞い（最大の id の波を選ぶ・halt を兄弟の next_wave より優先する・行を切り詰めない・
// 壊れた rows を拒む）を、build-step.js でも確かめる。build の行は build の段と役、検査の行は audit:<coverage-audit の段> と coverage-audit の役。
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build-step.js')
const BROW = (id, role = 'architect', stage = 'design') => ({ id, role, model: ROLES[role].model, effort: ROLES[role].effort, stage })
const AROW = (id, stage = 'file') => {
  const role = { plan: 'planner', file: 'file_reader', global: 'global_judge', full_review: 'full_reviewer' }[stage]
  return { id, role, model: AUDIT_ROLES[role].model, effort: AUDIT_ROLES[role].effort, stage: `audit:${stage}` }
}
const scriptArgs = (id, rows) => ({ state: '/tmp/coverage-build-waves-x', callId: 'c1', wave: { id, rows } })
// prompt の build-cli.mjs の claim の命令の --wave・--worker で、返す値を決める偽の agent。
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
async function runBuildScript(args, fn) {
  const res = await runScript(SCRIPT, args, fn)
  assert.ok(res && !res.error, `script が throw した: ${JSON.stringify(res)}`)
  return res
}

test('script: 返ってきた中で最大の next_wave_id の行で次の波を起動し（build の行と検査の行が混ざってよい）、返り値が次の波を持たなくなったら終える', async () => {
  const fn = fakeAgent({
    '3/w1': { notes: [], next_wave_id: 4, rows: [BROW('w3', 'unit_designer')] },
    '3/w2': { notes: [], next_wave_id: 5, rows: [AROW('q1', 'plan'), BROW('w4', 'unit_designer')] },
  })
  const res = await runBuildScript(scriptArgs(3, [BROW('w1'), BROW('w2')]), fn)
  assert.deepEqual(fn.seen.map((x) => x.key).sort(), ['3/w1', '3/w2', '5/q1', '5/w4'], '小さい id（4）の波は起動しない')
  assert.deepEqual(Object.keys(res).sort(), ['agents', 'tokens'])
  assert.equal(res.agents.length, 4)
  assert.deepEqual(res.agents.filter((a) => String(a.wave) === '5').map((a) => a.stage).sort(), ['audit:plan', 'design'], '起動の記録は段と波を持つ')
})

test('script: 波の役のどれかが halt を返したら、ほかの役が next_wave を返しても新しい波を起動しない', async () => {
  const fn = fakeAgent({
    '2/w1': { notes: [], halt: true },
    '2/w2': { notes: [], next_wave_id: 3, rows: [BROW('w3', 'unit_designer')] },
  })
  const res = await runBuildScript(scriptArgs(2, [BROW('w1'), BROW('w2')]), fn)
  assert.deepEqual(fn.seen.map((x) => x.key).sort(), ['2/w1', '2/w2'])
  assert.equal(res.agents.length, 2)
})

test('script: 行を切り詰めない（maxAgents を超える行も全て起動する。行の数を収めるのは CLI）', async () => {
  const rows = Array.from({ length: C.LIMITS.maxAgents + 1 }, (_, i) => (i % 2 ? AROW(`q${i + 1}`) : BROW(`w${i + 1}`, 'unit_designer')))
  const fn = fakeAgent()
  const res = await runBuildScript(scriptArgs(1, rows), fn)
  assert.equal(fn.seen.length, rows.length)
  assert.equal(res.agents.length, rows.length)
})

test('script: 返ってきた次の波の行が壊れているか、id が今の波より大きくなければ、その波を起動しない', async () => {
  for (const [name, reply] of [
    ['行が欠けた欄を持つ', { notes: [], next_wave_id: 2, rows: [{ id: 'w2', role: 'unit_designer' }] }],
    ['rows が配列でない', { notes: [], next_wave_id: 2, rows: 'w2' }],
    ['rows が空', { notes: [], next_wave_id: 2, rows: [] }],
    ['id が今の波と同じ', { notes: [], next_wave_id: 1, rows: [BROW('w2', 'unit_designer')] }],
    ['行の id が重なる', { notes: [], next_wave_id: 2, rows: [BROW('w2', 'unit_designer'), BROW('w2', 'unit_designer')] }],
    ['知らない段', { notes: [], next_wave_id: 2, rows: [{ ...BROW('w2', 'unit_designer'), stage: 'review' }] }],
    ['build の段に検査の役', { notes: [], next_wave_id: 2, rows: [{ ...AROW('w2'), stage: 'design' }] }],
    ['知らない検査の段', { notes: [], next_wave_id: 2, rows: [{ ...AROW('q2'), stage: 'audit:xyz' }] }],
  ]) {
    const fn = fakeAgent({ '1/w1': reply })
    const res = await runBuildScript(scriptArgs(1, [BROW('w1')]), fn)
    assert.deepEqual(fn.seen.map((x) => x.key), ['1/w1'], `${name}: 起動した: ${JSON.stringify(reply)}`)
    assert.equal(res.agents.length, 1, name)
  }
})

// ---------------- claim の行の照合（今の波・記録した次の波・締めた前の波） ----------------
// 波の印（current・next・old）ごとに、行の引き当てと値の照合、拒むときの文言（終了状態 2、台帳を変えない）を確かめる。
test('claim の照合（波の印ごと）: 記録した次の波の行の値の違い・記録の無い波・行に無い worker は理由つきの終了状態 2 で台帳を変えず、締めた前の波の行の claim は担当も次の波も返さずに done', async (t) => {
  const { state } = setup(t)
  const { args, row: goalRow, nw } = await passFirstWave(state)
  assert.ok(nw && nw.rows.length === 1 && nw.rows[0].role === 'architect', JSON.stringify(nw))
  const arch = nw.rows[0]
  const other = (v, xs) => xs.find((x) => x !== v)
  const before = ledgerBytes(state)
  for (const [name, argv, want] of [
    ['次の波の行の effort が違う', claimArgv(state, args.callId, { ...arch, effort: other(arch.effort, ['low', 'high']) }, nw.id),
      [`--effort ${other(arch.effort, ['low', 'high'])}（記録は ${arch.effort}）`]],
    ['次の波の行の model と段が違う', claimArgv(state, args.callId, { ...arch, model: other(arch.model, ['haiku', 'opus']), stage: 'tests' }, nw.id),
      [`--model ${other(arch.model, ['haiku', 'opus'])}（記録は ${arch.model}）・--stage tests（記録は ${arch.stage}）`]],
    ['記録の無い波', claimArgv(state, args.callId, arch, Number(nw.id) + 100), ['記録の無い波', String(Number(nw.id) + 100)]],
    ['次の波の行に無い worker', claimArgv(state, args.callId, { ...arch, id: 'no-such-row' }, nw.id), ['行に無い worker', 'no-such-row']],
  ]) {
    const c = cli(...argv)
    assert.equal(c.code, 2, `${name}: ${JSON.stringify(c)}`)
    assert.equal(c.ok, false, name)
    for (const w of want) assert.ok(String(c.error).includes(w), `${name}: 理由に「${w}」: ${c.error}`)
    assert.equal(ledgerBytes(state), before, `${name}: 台帳を変えない`)
  }
  // 記録した次の波の行の正しい claim は、その波を今の波にして担当を渡す。
  const got = cli(...claimArgv(state, args.callId, arch, nw.id))
  assert.equal(got.code, 0, JSON.stringify(got))
  assert.ok(got.tasks && got.tasks.length === 1 && got.tasks[0].kind === 'arch', JSON.stringify(got))
  // 締めた前の波（目標の照合の波）の行: 値が合えば done だけ（担当・次の波・止まる印を持たない）で台帳を変えない。値が違えば終了状態 2。
  const promoted = ledgerBytes(state)
  const old = cli(...claimArgv(state, args.callId, goalRow, args.wave.id))
  assert.equal(old.code, 0, JSON.stringify(old))
  assert.equal(old.done, true, JSON.stringify(old))
  for (const k of ['tasks', 'next_wave', 'halt']) assert.ok(!(k in old), `前の波の行の done は ${k} を持たない: ${JSON.stringify(old)}`)
  assert.equal(ledgerBytes(state), promoted, '前の波の行の claim は台帳を変えない')
  const oldBad = cli(...claimArgv(state, args.callId, { ...goalRow, model: other(goalRow.model, ['haiku', 'opus']) }, args.wave.id))
  assert.equal(oldBad.code, 2, JSON.stringify(oldBad))
  assert.ok(String(oldBad.error).includes(`（記録は ${goalRow.model}）`), oldBad.error)
  assert.equal(ledgerBytes(state), promoted)
})

// ---------------- 起動の記録の照合（ingest の launch_mismatch） ----------------
// 起動の記録の 1 件ごとに、台帳の起動した波の行と照らす。行は label（役-行の id）で引き、無ければ役で引く。波を持たない記録は照らさない。
const MISMATCH_CASES = [
  { name: '全て合う', patch: () => ({}), event: null },
  { name: 'effort が違う', patch: (r) => ({ effort: r.effort === 'low' ? 'high' : 'low' }), event: '起動の記録' },
  { name: '段が違う', patch: () => ({ stage: 'tests' }), event: '起動の記録' },
  { name: '段を持たない（照らさない）', patch: () => ({ stage: null }), event: null },
  { name: 'label が違うが役で行を引ける', patch: (r) => ({ label: `${r.role}-other` }), event: null },
  { name: '台帳の起動した波に無い波', patch: (r, w) => ({ wave: Number(w) + 100 }), event: '起動した波の記録に無い' },
  { name: '波を持たない（照らさない）', patch: () => ({ wave: null }), event: null },
]
test('ingest の launch_mismatch: 起動の記録を台帳の起動した波の行と照らし、effort・段の違いと記録に無い波の起動だけを出来事に残す', async (t) => {
  for (const c of MISMATCH_CASES) {
    const { state } = setup(t)
    const { args } = openWave(state)
    const row = args.wave.rows[0]
    const rec = { role: row.role, label: `${row.role}-${row.id}`, model: row.model, effort: row.effort, ok: true, stage: row.stage, wave: args.wave.id }
    const f = path.join(state, 'res-mismatch.json')
    writeFileSync(f, JSON.stringify({ agents: [{ ...rec, ...c.patch(row, args.wave.id) }], tokens: null }))
    const g = cli('ingest', '--state', state, '--call', args.callId, '--result', f)
    assert.equal(g.code, 0, `${c.name}: ${JSON.stringify(g)}`)
    const ms = ledger(state).events.filter((e) => e.kind === 'launch_mismatch')
    if (c.event == null) assert.equal(ms.length, 0, `${c.name}: ${JSON.stringify(ms)}`)
    else {
      assert.equal(ms.length, 1, `${c.name}: ${JSON.stringify(ms)}`)
      assert.ok(ms[0].text.includes(c.event), `${c.name}: ${ms[0].text}`)
    }
  }
})
