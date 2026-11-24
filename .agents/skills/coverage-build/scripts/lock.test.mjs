// 台帳の lock（stateDir/build.lock）の契約: 台帳を書くコマンドを直列にし、取得ごとの token を書き、token を書けなかったときは自分が作った lock を消す。
// lock は coverage-audit の ledger-cli.mjs の withLock に lock の名前（build.lock）を渡して取る。build の lock の口として、lock を取るコマンド（next）を通して確かめる。token の書き込みは node:fs の writeSync を差し替えて観る・落とす。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs, { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cli, setup } from './test-harness.mjs'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build-cli.mjs')
const lockOf = (state) => path.join(state, 'build.lock')
const bytes = (state) => readFileSync(path.join(state, 'build.json'), 'utf8')

// build-cli.mjs が import した writeSync を差し替える（ESM の名前の import は syncBuiltinESMExports で差し替えた値に変わる）。
// on(fd, data) が値を返せばその値を返し、例外を投げればそのまま投げる。undefined なら元の writeSync を流す。
function patchWriteSync(t, on) {
  const orig = fs.writeSync
  const calls = []
  fs.writeSync = (fd, data, ...rest) => {
    calls.push(String(data))
    const r = on(fd, data, calls.length)
    return r === undefined ? orig(fd, data, ...rest) : r
  }
  syncBuiltinESMExports()
  const restore = () => { fs.writeSync = orig; syncBuiltinESMExports() }
  t.after(restore)
  return { calls, restore }
}

// ready を渡すと、子の process が起動して CLI を読み込む前にそのファイルを書く（--import の合図）。起動の遅れに依らずに待つため。
function run(argv, { ready = null } = {}) {
  return new Promise((resolve) => {
    const pre = ready ? ['--import', `data:text/javascript,${encodeURIComponent(`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(ready)}, '1')`)}`] : []
    const p = spawn(process.execPath, [...pre, CLI, ...argv])
    let out = ''
    p.stdout.on('data', (b) => { out += b })
    p.on('close', (code) => {
      let j = {}
      try { j = JSON.parse(out) } catch { j = { raw: out } }
      resolve({ code, ...j })
    })
  })
}

test('lock（直列化）: 他の process の lock があるあいだ next は台帳を変えずに待ち、lock が消えたら取って進み、終わると lock を残さない', async (t) => {
  const { state } = setup(t)
  const lock = lockOf(state)
  writeFileSync(lock, 'other-process-token')
  const before = bytes(state)
  const t0 = Date.now()
  // 子が起動した合図（ready）を待ってから、待つ時間を測る（子の起動の遅れを待ちの時間に数えない）。
  const ready = path.join(state, 'child-ready')
  const p = run(['next', '--state', state], { ready })
  const deadline = Date.now() + 8000
  while (!existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  assert.ok(existsSync(ready), '子の process が起動した')
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(bytes(state), before, '待つあいだ台帳を変えない')
  assert.equal(readFileSync(lock, 'utf8'), 'other-process-token', '他の process の lock を奪わない')
  rmSync(lock)
  const r = await p
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.ok(r.step, JSON.stringify(r))
  assert.ok(Date.now() - t0 >= 600, 'lock が消えるまで待った')
  assert.notEqual(bytes(state), before, 'lock を取ってから台帳を書いた')
  assert.ok(!existsSync(lock), '終わると lock を残さない')
})

test('lock（token）: 取得ごとに違う、空でない token を lock に書き、終わると消す', (t) => {
  const { state } = setup(t)
  const { calls, restore } = patchWriteSync(t, () => undefined)
  const a = cli('next', '--state', state)
  const b = cli('status', '--state', state)
  const c = cli('next', '--state', state)
  restore()
  assert.equal(a.code, 0, JSON.stringify(a))
  assert.equal(b.code, 0, JSON.stringify(b))
  assert.equal(c.code, 0, JSON.stringify(c))
  assert.equal(calls.length, 2, `lock を取った 2 回だけ writeSync で token を書く: ${JSON.stringify(calls)}`)
  for (const s of calls) assert.ok(s.length > 0, JSON.stringify(calls))
  assert.notEqual(calls[0], calls[1], '取得ごとに違う token')
  assert.ok(!existsSync(lockOf(state)), 'lock を残さない')
})

test('lock（後始末）: token の書き込みに失敗したら、自分が作った lock を消して失敗を返し、台帳を変えない。続くコマンドは待たずに通る', (t) => {
  const { state } = setup(t)
  const before = bytes(state)
  let hit = 0
  const { restore } = patchWriteSync(t, () => {
    hit += 1
    if (hit === 1) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    return undefined
  })
  const r = cli('next', '--state', state)
  restore()
  assert.equal(hit, 1, '差し替えた writeSync を通った（token の書き込みを落とした）')
  assert.notEqual(r.code, 0, `失敗を返す: ${JSON.stringify(r)}`)
  assert.equal(bytes(state), before, '台帳を変えない')
  assert.ok(!existsSync(lockOf(state)), '中身を照合できない空の lock を残さない（残ると以後のコマンドが待って Fail になる）')
  const t0 = Date.now()
  const n = cli('next', '--state', state)
  assert.equal(n.code, 0, JSON.stringify(n))
  assert.ok(Date.now() - t0 < 5000, '残った lock を待たない')
})
