// A. 役の claim・query・submit の lock の取り直しの待ちを、役の Bash のコマンドが流れられる時間（Claude Code の既定の上限 2 分）に収める。
// - 1 回の待ちは 100 秒以内（build-cli.mjs が export する WORKER_LOCK_WAIT_MS）。環境変数 COVERAGE_BUILD_LOCK_WAIT_MS（ミリ秒）で短くできる（テスト用の口）。
// - 待ちが切れたら終了状態 3（「lock の待ちが切れた。同じ命令を流し直す」）で返し、台帳を変えず、取った担当も失わない。流し直せば続きから進む。
// - 役の prompt の手順に「終了状態 3 なら同じ命令を流し直す（担当は失われない）」が載る。
// 待ちの上限を短くした子の process で流す（今の実装は 1 時間待つので、15 秒で打ち切って落とす）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as buildCli from './build-cli.mjs'
import { act, claimArgv, cli, setup, workerLoop } from './board-fixture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, 'build-cli.mjs')
const ledgerBytes = (state) => readFileSync(path.join(state, 'build.json'), 'utf8')
const WAIT = '300'
function runShort(argv) {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', timeout: 15000, env: { ...process.env, COVERAGE_BUILD_LOCK_WAIT_MS: WAIT } })
  let out = {}
  try { out = JSON.parse(r.stdout) } catch { out = { raw: r.stdout, stderr: r.stderr } }
  return { code: r.status, signal: r.signal, took: Date.now() - t0, ...out }
}
const holdLock = (state) => { writeFileSync(path.join(state, 'build.lock'), 'other-process-token'); return () => rmSync(path.join(state, 'build.lock'), { force: true }) }
async function openGoalWave(state) {
  const n = cli('next', '--state', state)
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  assert.ok(args.wave, JSON.stringify(args))
  return { call: args.callId, row: args.wave.rows[0], wave: args.wave.id }
}
const expire = (r) => {
  assert.notEqual(r.signal, 'SIGTERM', `待ちが切れずに 15 秒で打ち切った（${r.took} ms）`)
  assert.equal(r.code, 3, JSON.stringify(r))
  assert.match(String(r.error), /lock の待ちが切れた/)
  assert.match(String(r.error), /同じ命令を流し直す/)
  assert.ok(r.took < 10000, `短くした待ちの上限で切れる: ${r.took} ms`)
}

test('A. 待ちの上限: 役のコマンドの lock の 1 回の待ちは 100 秒以内', () => {
  assert.equal(typeof buildCli.WORKER_LOCK_WAIT_MS, 'number', 'build-cli.mjs が WORKER_LOCK_WAIT_MS を export する')
  assert.ok(buildCli.WORKER_LOCK_WAIT_MS > 0 && buildCli.WORKER_LOCK_WAIT_MS <= 100000, `${buildCli.WORKER_LOCK_WAIT_MS} ms`)
})

test('A. claim: lock の待ちが切れたら終了状態 3 で返し、台帳を変えない。lock が空いた後に同じ命令を流し直せば担当を取る', async (t) => {
  const { state } = setup(t)
  const { call, row, wave } = await openGoalWave(state)
  const argv = claimArgv(state, call, row, wave)
  const before = ledgerBytes(state)
  const release = holdLock(state)
  const r = runShort(argv)
  release()
  expire(r)
  assert.equal(ledgerBytes(state), before, '台帳を変えない')
  const again = cli(...argv)
  assert.equal(again.code, 0, JSON.stringify(again))
  assert.ok(again.tasks && again.tasks.length, '流し直すと担当を取る')
})

test('A. query・submit: lock の待ちが切れたら終了状態 3 で、取った担当を失わない。流し直せば提出が受理されて続きから進む', async (t) => {
  const { state } = setup(t)
  const { call, row, wave } = await openGoalWave(state)
  const c = cli(...claimArgv(state, call, row, wave))
  const task = c.tasks[0]
  const who = ['--state', state, '--call', call, '--worker', row.id]
  // query
  let release = holdLock(state)
  const q = runShort(['query', ...who, '--task', task.id])
  release()
  expire(q)
  const inputs = cli('query', ...who, '--task', task.id).inputs
  mkdirSync(path.dirname(task.result_path), { recursive: true })
  writeFileSync(task.result_path, JSON.stringify({ outcomes: [{ outcome: '依頼の全体', quotes: [{ source: 'request', quote: inputs.request }], items: inputs.item_ids }] }))
  // submit
  const before = ledgerBytes(state)
  release = holdLock(state)
  const s = runShort(['submit', ...who])
  release()
  expire(s)
  assert.equal(ledgerBytes(state), before, '台帳を変えない')
  const s2 = cli('submit', ...who)
  assert.equal(s2.code, 0, JSON.stringify(s2))
  assert.ok(s2.results.length === 1 && s2.results[0].ok, `取った担当は失われず、流し直した提出が受理される: ${JSON.stringify(s2)}`)
  // 続きから進む（同じ行の claim は done と次の波）。
  const done = cli(...claimArgv(state, call, row, wave))
  assert.equal(done.done, true)
  assert.ok(done.next_wave && done.next_wave.rows[0].role === 'architect', JSON.stringify(done))
})

// 役の prompt の手順に、終了状態 3 の扱いを載せる。
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const BUILD_ROLES = JSON.parse(readFileSync(path.join(HERE, 'roles.json'), 'utf8'))
const STAGE = { goal_checker: 'design', architect: 'design', unit_designer: 'design', test_writer: 'tests', implementer: 'implement', retro_planner: 'retro', retro_examiner: 'retro', retro_verifier: 'retro' }
test('A. prompt: build の役の手順に「終了状態 3 なら同じ命令を流し直す（担当は失われない）」が載る', async () => {
  const body = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', readFileSync(path.join(HERE, 'build-step.js'), 'utf8').replace(/^export const meta = /, 'const meta = '))
  const rows = Object.keys(STAGE).map((role, i) => ({ id: `w${i}`, role, model: BUILD_ROLES[role].model, effort: BUILD_ROLES[role].effort, stage: STAGE[role] }))
  const prompts = []
  const parallel = (ts) => Promise.all(ts.map((x) => Promise.resolve().then(x).catch(() => null)))
  for (const row of rows) await body(async (p) => { prompts.push(p); return { notes: [] } }, parallel, parallel, () => {}, () => {}, { state: '/x/state', callId: 'c1', wave: { id: 1, rows: [row] } }, undefined)
  assert.equal(prompts.length, rows.length)
  for (const [i, p] of prompts.entries()) {
    const line = p.split('\n').find((l) => l.includes('終了状態 3'))
    assert.ok(line, `${rows[i].role}: 終了状態 3 の扱いが無い`)
    assert.match(line, /同じ命令を流し直す/, line)
    assert.match(line, /担当は失われない/, line)
  }
})

// B. 古い lock（mtime が LOCK_STALE_MS = 60 秒より前）は、落ちた process の残りかもしれず、流し直しても空かない。終了状態 3（流し直す）にせず、
// busy を付けない終了状態 2 で、lock の path と手で消す案内を返す（役は 2 を受けて notes に書いて終える）。lock は消さず、台帳を変えない。
// 生きた lock（新しい mtime）は今のとおり待って終了状態 3。待ちきる前に 2 を返すか、待ちの上限で 2 を返すかは問わない（時間の下限を見ない）。
const STALE_SEC = 120
const backdate = (file) => { const old = (Date.now() - STALE_SEC * 1000) / 1000; utimesSync(file, old, old) }
const holdStaleLock = (state) => { const f = path.join(state, 'build.lock'); writeFileSync(f, 'dead-process-token'); backdate(f); return f }
const staleRefusal = (r, lock, name) => {
  assert.notEqual(r.signal, 'SIGTERM', `${name}: 打ち切った（${r.took} ms）`)
  assert.equal(r.code, 2, `${name}: 古い lock は終了状態 2: ${JSON.stringify(r)}`)
  assert.equal(r.ok, false, name)
  assert.ok(!r.busy, `${name}: busy を付けない: ${JSON.stringify(r)}`)
  assert.ok(String(r.error).includes(lock), `${name}: lock の path を示す: ${r.error}`)
  assert.ok(String(r.error).includes('手で消'), `${name}: 手で消す案内: ${r.error}`)
  assert.ok(existsSync(lock), `${name}: lock を消さない`)
}

test('B. 役のコマンド（claim・query・submit）: build の台帳の古い lock は終了状態 2 で手で消す案内を返し、lock を消さず台帳を変えない。lock を消せば流し直して進む', async (t) => {
  const { state } = setup(t)
  const { call, row, wave } = await openGoalWave(state)
  const who = ['--state', state, '--call', call, '--worker', row.id]
  const before = ledgerBytes(state)
  const lock = holdStaleLock(state)
  for (const [name, argv] of [['claim', claimArgv(state, call, row, wave)], ['query', ['query', ...who, '--task', 'no-such-task']], ['submit', ['submit', ...who]]]) {
    const r = runShort(argv)
    staleRefusal(r, lock, name)
    assert.equal(readFileSync(lock, 'utf8'), 'dead-process-token', `${name}: lock を取り直さない`)
    assert.equal(ledgerBytes(state), before, `${name}: 台帳を変えない`)
  }
  rmSync(lock)
  const again = cli(...claimArgv(state, call, row, wave))
  assert.equal(again.code, 0, JSON.stringify(again))
  assert.ok(again.tasks && again.tasks.length, '手で消した後に流し直すと担当を取る')
})

// 子の process で流す（待ちは 10 秒のままの口を、並べて同時に流す）。
function spawnCli(argv, env = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const p = spawn(process.execPath, [CLI, ...argv], { env: { ...process.env, ...env } })
    let out = ''
    p.stdout.on('data', (b) => { out += b })
    const timer = setTimeout(() => p.kill('SIGTERM'), 40000)
    p.on('close', (code, signal) => {
      clearTimeout(timer)
      let j = {}
      try { j = JSON.parse(out) } catch { j = { raw: out } }
      resolve({ code, signal, took: Date.now() - t0, ...j })
    })
  })
}
test('B. 待ちの上限が固定の口（next）と検査の台帳の lock（検査の段の claim）: 古い lock は終了状態 2 で手で消す案内、生きた lock の next は上限まで待って終了状態 3', { timeout: 90000 }, async (t) => {
  // next: 古い lock と生きた lock。
  const stale = setup(t)
  const live = setup(t)
  const staleLock = holdStaleLock(stale.state)
  const liveLock = path.join(live.state, 'build.lock')
  writeFileSync(liveLock, 'other-process-token')
  // 検査の段の claim: update の目標の照合の後の波（現状の検査の計画役）の行で、検査の台帳（stateDir/audit/state/ledger.lock）が古い lock。
  const up = setup(t, { mode: 'update' })
  const { call, row, wave } = await openGoalWave(up.state)
  const rec = await workerLoop({ state: up.state, call, worker: row.id, role: row.role, argv: claimArgv(up.state, call, row, wave) }, act())
  const nw = rec.next_wave
  assert.ok(nw && nw.rows[0].stage.startsWith('audit:'), `目標の照合の後は検査の波: ${JSON.stringify(rec.claims.at(-1))}`)
  const auditLock = path.join(up.state, 'audit', 'state', 'ledger.lock')
  writeFileSync(auditLock, 'dead-process-token')
  backdate(auditLock)
  const before = { stale: ledgerBytes(stale.state), live: ledgerBytes(live.state), up: ledgerBytes(up.state), upAudit: readFileSync(path.join(up.state, 'audit', 'state', 'ledger.json'), 'utf8') }
  const [rs, rl, ra] = await Promise.all([
    spawnCli(['next', '--state', stale.state]),
    spawnCli(['next', '--state', live.state]),
    spawnCli(claimArgv(up.state, call, nw.rows[0], nw.id), { COVERAGE_BUILD_LOCK_WAIT_MS: WAIT }),
  ])
  staleRefusal(rs, staleLock, 'next（古い lock）')
  assert.equal(ledgerBytes(stale.state), before.stale, 'next（古い lock）: 台帳を変えない')
  assert.equal(rl.code, 3, `next（生きた lock）: ${JSON.stringify(rl)}`)
  assert.ok(rl.took >= 9000, `next（生きた lock）: 上限まで待つ（${rl.took} ms）`)
  assert.ok(String(rl.error).includes(liveLock) && !String(rl.error).includes('手で消'), `next（生きた lock）: ${rl.error}`)
  assert.equal(readFileSync(liveLock, 'utf8'), 'other-process-token')
  assert.equal(ledgerBytes(live.state), before.live, 'next（生きた lock）: 台帳を変えない')
  staleRefusal(ra, auditLock, '検査の段の claim（検査の台帳の古い lock）')
  assert.equal(ledgerBytes(up.state), before.up, '検査の段の claim: build の台帳を変えない')
  assert.equal(readFileSync(path.join(up.state, 'audit', 'state', 'ledger.json'), 'utf8'), before.upAudit, '検査の段の claim: 検査の台帳を変えない')
})
