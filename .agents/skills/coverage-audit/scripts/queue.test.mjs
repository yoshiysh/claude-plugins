// review の待ち行列（claim・submit）と、資産ごとに長く動く worker の契約。
// CLI は child_process で並べて流し、lock で直列になることも確かめる。期待値は承認済みの計画の 5 と単位 D の仕様から取る。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { C, MAX_ATTEMPTS } from './ledger-core.mjs'
import { cli, cliArgvOf, drive, evidenceOf, mockAgent, tmp } from './test-harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, 'ledger-cli.mjs')

const DOC = `# 対象の文書

## 一つ目の節
この節は一つ目の主張を述べる本文の行である。
二行目もこの節の主張を補う本文の行として置く。

## 二つ目の節
この節は二つ目の主張を述べる本文の行である。
二行目もこの節の主張を補う本文の行として置く。
`
const manyDoc = (n) => `# 文書\n${Array.from({ length: n }, (_, i) => `\n## 節${i}\nこの節 ${i} は本文の行として十分な長さを持っている。\n二行目も節 ${i} の主張を補う本文の行として置く。`).join('\n')}\n`
const L1 = { id: 'L1', name: '主張と根拠', procedure: '主張ごとに根拠の文を対応づけ、根拠の無い主張を探す' }
const L2 = { id: 'L2', name: '用語の一貫', procedure: '用語ごとに使われ方を並べ、意味の揺れを探す' }
const L3 = { id: 'L3', name: '数の一致', procedure: '数を挙げた文ごとに、同じ数を述べる別の文と照らし、食い違いを探す' }

// 利用者の観点を渡し、目標を照合済みにした台帳は計画の段を通らないので、最初の next が review になる。
function qsetup(t, { doc = DOC, lenses = [L1], extra = [], workers = 3 } = {}) {
  const d = tmp(t)
  writeFileSync(path.join(d, 'doc.md'), doc)
  writeFileSync(path.join(d, 'goal.md'), '- G1: 対象の文書の見落としを観点ごとに確かめた指摘の一覧\n')
  writeFileSync(path.join(d, 'request.md'), '対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい')
  writeFileSync(path.join(d, 'lenses.json'), JSON.stringify(lenses))
  const state = path.join(d, 'state')
  const r = cli('init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md'), '--lenses', path.join(d, 'lenses.json'), '--goal-checked', 'coverage-build', ...extra)
  assert.equal(r.code, 0, JSON.stringify(r))
  if (workers != null) { const c = cli('config', '--state', state, '--workers', String(workers)); assert.equal(c.code, 0, JSON.stringify(c)) }
  return { d, state, doc: path.join(d, 'doc.md') }
}
const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))
const bytes = (state) => readFileSync(path.join(state, 'ledger.json'), 'utf8')
function review(state) {
  const n = cli('next', '--state', state)
  assert.equal(n.code, 0, JSON.stringify(n))
  assert.equal(n.step, 'review', JSON.stringify(n))
  return { n, args: JSON.parse(readFileSync(n.args_path, 'utf8')) }
}
const rows = (args, queue, pass = 1) => args.workers.filter((w) => w.queue === queue && w.pass === pass)
const claim = (state, call, worker) => cli('claim', '--state', state, '--call', call, '--worker', worker)
// worker を省いたときは、その枡を今取っている worker（台帳の c.claim.worker）で出す。
const claimer = (state, cell) => { const c = ledger(state).cells[cell]; return (c && c.claim && c.claim.worker) || 'no-claim' }
const submit = (state, call, cell, file, worker = claimer(state, cell)) => cli('submit', '--state', state, '--call', call, '--cell', cell, '--worker', worker, '--result', file)
let seq = 0
const put = (d, obj) => { const f = path.join(d, `res-${++seq}.json`); writeFileSync(f, JSON.stringify(obj)); return f }
// 取った資産の写しの範囲から、区画ごとの逐語の引用を作る（担当が Read するのと同じ範囲）。
const evidence = (asset) => evidenceOf(`写し: ${asset.file}\n行: ${asset.start}-${asset.end}`)
const goodRead = (asset, findings = []) => ({ evidence: evidence(asset), findings, outside_notes: [], none_reason: findings.length ? '' : '手続きに沿って読み、該当が無かった' })
const badRead = () => ({ evidence: ['本文に無い引用をここに書いている文字列'], findings: [], outside_notes: [], none_reason: 'x' })
const finding = (claimText, quote) => ({ claim: claimText, quote, severity: 'MEDIUM', layer: '実装' })
const okResult = (n, ok = true) => ({ stage: 'review', call_id: n.call_id, status: 'ok', agents: [{ role: 'reader_1', label: 'reader-w', model: 'sonnet', effort: 'medium', ok }], tokens: null })
function ingest(state, d, n, res = okResult(n)) {
  const g = cli('ingest', '--state', state, '--result', put(d, res))
  assert.equal(g.code, 0, JSON.stringify(g))
  return g
}
// 読む役の worker が 1 体 1 回ずつ claim する（何も出さない）。未提出の claim を持つ worker の claim し直しは同じ枡を返すので、
// 1 体で取り続けずに体を分ける。全ての資産を取り切ったこと（最後に空が返ること）も照らす。
function claimAll(state, call, args) {
  const out = []
  for (const w of rows(args, 'read')) {
    const c = claim(state, call, w.id)
    assert.equal(c.code, 0, JSON.stringify(c))
    if (!c.done) out.push(c)
  }
  assert.ok(rows(args, 'read').length > out.length, '資産の数より多い worker で、全ての資産を取り切る')
  return out
}
// 枡の観点は台帳から引く（claim の出力の lens の欄には頼らない）。
const lensOf = (state, cellId) => ledger(state).cells[cellId].lens
const missedBy = (L, kind, id) => L.events.some((e) => e.kind === kind && (e.ref === id || String(e.text).includes(id)))
// cells[] の要素は submit_cmd を持たない。出す命令は asset ごとに 1 つ（asset.submit_cmd。--cell と --result を持たない submit）。
const READ_CELL_KEYS = ['cell_id', 'lens', 'brief', 'result_path']
// asset.submit_cmd の submit を in-process で流す（--cell を持たない形）。
function batchSubmit(c) {
  const a = cliArgvOf(c.asset.submit_cmd, 'submit')
  assert.ok(a, `asset.submit_cmd に submit の命令がある: ${JSON.stringify(c.asset)}`)
  return cli(...a)
}
function writeResult(x, obj) { mkdirSync(path.dirname(x.result_path), { recursive: true }); writeFileSync(x.result_path, JSON.stringify(obj)) }
const resultOf = (s, cellId) => (s.results || []).find((r) => r.cell === cellId)

// 別の node の process で CLI を流す（並べて流すときは Promise.all で同時に走らせる）。
function run(argv, { shell = null } = {}) {
  return new Promise((resolve) => {
    const p = shell ? spawn('sh', ['-c', shell]) : spawn(process.execPath, [CLI, ...argv])
    let out = ''
    let err = ''
    p.stdout.on('data', (b) => { out += b })
    p.stderr.on('data', (b) => { err += b })
    p.on('close', (code) => {
      let j = {}
      try { j = JSON.parse(out) } catch { j = { raw: out, stderr: err } }
      resolve({ code, ...j })
    })
  })
}

// ---------------- workers の行と config --workers ----------------

test('workers: review の args は、回 × 待ち行列（read・verify）× workers 体の行（id・role・pass・queue）を持ち、p 回目の役は reader_p・verifier_p（無ければ reader_1・verifier）', (t) => {
  const { state } = qsetup(t, { workers: 3 })
  const { args } = review(state)
  assert.ok(Array.isArray(args.workers), JSON.stringify(Object.keys(args)))
  assert.equal(args.workers.length, 2 * 1 * 3, 'k=1・workers 3 で 6 行')
  assert.equal(new Set(args.workers.map((w) => w.id)).size, args.workers.length, 'worker の id は一意')
  for (const w of args.workers) assert.deepEqual(Object.keys(w).sort(), ['id', 'pass', 'queue', 'role'], JSON.stringify(w))
  assert.equal(rows(args, 'read').length, 3)
  assert.equal(rows(args, 'verify').length, 3)
  assert.ok(rows(args, 'read').every((w) => w.role === 'reader_1'))
  assert.ok(rows(args, 'verify').every((w) => w.role === 'verifier'))
})

test('workers: k=2 では 2 回目の行の役が reader_2・verifier_2 になり、各回の読む役の worker はその回の枡だけを取る', (t) => {
  const { state } = qsetup(t, { extra: ['--k', '2'], workers: 2 })
  const { n, args } = review(state)
  assert.equal(args.workers.length, 2 * 2 * 2, 'N は回ごとの数で、行は 2 × k × N 件')
  for (const p of [1, 2]) {
    assert.equal(rows(args, 'read', p).length, 2)
    assert.equal(rows(args, 'verify', p).length, 2)
    assert.ok(rows(args, 'read', p).length >= 1 && rows(args, 'verify', p).length >= 1, `${p} 回目の行がある`)
    assert.ok(rows(args, 'read', p).every((w) => w.role === (p === 1 ? 'reader_1' : 'reader_2')))
    assert.ok(rows(args, 'verify', p).every((w) => w.role === (p === 1 ? 'verifier' : 'verifier_2')))
    const c = claim(state, n.call_id, rows(args, 'read', p)[0].id)
    assert.equal(c.code, 0, JSON.stringify(c))
    assert.ok(c.cells.length && c.cells.every((x) => x.cell_id.endsWith(`|p${p}`)), `${p} 回目の worker は |p${p} の枡だけ: ${c.cells.map((x) => x.cell_id)}`)
  }
})

test('config --workers: 正の整数で worker の数を変え、次の review の行の数に効く。正の整数でない値は Fail（終了状態 2）で台帳を変えない', (t) => {
  const { state } = qsetup(t, { workers: null })
  const before = bytes(state)
  for (const v of ['0', 'abc', '1.5', '-1', '1e2']) assert.equal(cli('config', '--state', state, '--workers', v).code, 2, `--workers ${v}`)
  assert.equal(bytes(state), before)
  const c = cli('config', '--state', state, '--workers', '2')
  assert.equal(c.code, 0, JSON.stringify(c))
  assert.equal(c.config.workers, 2)
  assert.equal(ledger(state).config.workers, 2)
  const { args } = review(state)
  assert.equal(args.workers.length, 2 * 1 * 2)
})

test('workers の既定値: config を流さない台帳は workers 4 で、k=1 の review の行は 8 件', (t) => {
  const { state } = qsetup(t, { workers: null })
  assert.equal(ledger(state).config.workers, 4)
  const { args } = review(state)
  assert.equal(args.workers.length, 2 * 1 * 4)
})

test('config --workers: 2 × k × N が maxAgents を超える値は終了状態 2 で拒否し、台帳を変えない（k=1・k=2）', (t) => {
  for (const k of [1, 2]) {
    const { state } = qsetup(t, { extra: k === 2 ? ['--k', '2'] : [], workers: null })
    const max = Math.floor(C.LIMITS.maxAgents / (2 * k))
    const before = bytes(state)
    const over = cli('config', '--state', state, '--workers', String(max + 1))
    assert.equal(over.code, 2, `k=${k} N=${max + 1}: ${JSON.stringify(over)}`)
    assert.equal(bytes(state), before, '台帳を変えない')
    const ok = cli('config', '--state', state, '--workers', String(max))
    assert.equal(ok.code, 0, `k=${k} N=${max}: ${JSON.stringify(ok)}`)
    assert.equal(ledger(state).config.workers, max)
    assert.equal(review(state).args.workers.length, 2 * k * max)
  }
})

// ---------------- claim ----------------

test('claim（読む役の待ち行列）: まだ読んでいない資産を 1 つ取り、写しの範囲とその回の観点ごとの枡を返し、枡に claim {call, worker} を記録する。本文は返さない', (t) => {
  const { state } = qsetup(t, { lenses: [L1, L2] })
  const { n, args } = review(state)
  const [w1, w2, w3] = rows(args, 'read')
  const c1 = claim(state, n.call_id, w1.id)
  assert.equal(c1.code, 0, JSON.stringify(c1))
  assert.equal(c1.ok, true)
  assert.ok(!c1.done)
  const a = c1.asset
  assert.ok(a && typeof a.id === 'string' && path.isAbsolute(a.file) && existsSync(a.file), JSON.stringify(a))
  assert.ok(Number.isInteger(a.start) && Number.isInteger(a.end) && a.start <= a.end)
  const L = ledger(state)
  assert.ok(L.assets[a.id], '資産の id は台帳の id')
  // 当たる観点（L1・L2）の枡を、全て 1 回で返す。
  assert.deepEqual(c1.cells.map((x) => L.cells[x.cell_id].lens).sort(), ['L1', 'L2'])
  for (const x of c1.cells) {
    for (const k of ['cell_id', 'brief', 'result_path']) assert.ok(k in x, `${k} がある: ${JSON.stringify(x)}`)
    assert.ok(!('submit_cmd' in x), `cells[] の要素は submit_cmd を持たない: ${JSON.stringify(x)}`)
    assert.ok(Object.keys(x).every((k) => READ_CELL_KEYS.includes(k)), `読む役の枡の要素は ${READ_CELL_KEYS} だけ: ${Object.keys(x)}`)
    assert.ok(existsSync(x.brief), '観点の束のファイルがある')
    const lens = L.cells[x.cell_id] && L.cells[x.cell_id].lens
    assert.match(readFileSync(x.brief, 'utf8'), new RegExp(lens === 'L1' ? '根拠の無い主張を探す' : lens === 'L2' ? '意味の揺れを探す' : '.'), '束に観点の手続きがある')
    assert.ok(path.resolve(x.result_path).startsWith(state + path.sep), 'result_path は stateDir の中')
    const c = L.cells[x.cell_id]
    assert.ok(c, `cell_id は台帳の枡の id: ${x.cell_id}`)
    assert.equal(c.asset, a.id)
    assert.deepEqual(c.claim, { call: n.call_id, worker: w1.id })
  }
  assert.match(a.submit_cmd, /submit/, '資産ごとに submit_cmd を 1 つ持つ')
  assert.ok(!JSON.stringify(c1).includes('主張を述べる'), '対象の本文を返さない（worker が写しを読む）')
  // 取った資産は二重に渡さない。資産が尽きたら空を返す。
  const c2 = claim(state, n.call_id, w2.id)
  assert.equal(c2.code, 0, JSON.stringify(c2))
  assert.ok(!c2.done)
  assert.notEqual(c2.asset.id, a.id, '取られた資産は他の worker に渡さない')
  const c3 = claim(state, n.call_id, w3.id)
  assert.equal(c3.code, 0, JSON.stringify(c3))
  assert.equal(c3.done, true, '資産が尽きたら空を返す')
})

test('claim: 同じ状態からは同じ資産を返す（取る順が決まっている）', (t) => {
  const pick = () => {
    const { state, d } = qsetup(t)
    const { n, args } = review(state)
    const c = claim(state, n.call_id, rows(args, 'read')[0].id)
    return c.asset.id.slice(d.length)
  }
  assert.equal(pick(), pick())
})

test('claim（検証の待ち行列）: 指摘のある枡を 1 つずつ取り、その枡の指摘だけを返す。他の観点の読みと指摘は返さない', (t) => {
  // L3 は指摘を返さない観点（指摘の無い枡は検証の待ち行列に入らない）。
  const { state, d } = qsetup(t, { lenses: [L1, L2, L3] })
  const { n, args } = review(state)
  const c = claim(state, n.call_id, rows(args, 'read')[0].id)
  const [q1, q2] = evidence(c.asset)
  const own = { L1: '根拠が無い主張（L1 の指摘）', L2: '用語が揺れている（L2 の指摘）' }
  for (const x of c.cells) {
    const lens = lensOf(state, x.cell_id)
    const fs = own[lens] ? [finding(own[lens], lens === 'L1' ? q1 : q2)] : []
    const s = submit(state, n.call_id, x.cell_id, put(d, goodRead(c.asset, fs)))
    assert.equal(s.code, 0, JSON.stringify(s))
    assert.equal(s.ok, true, JSON.stringify(s))
  }
  let L = ledger(state)
  const byLens = Object.fromEntries(c.cells.map((x) => [L.cells[x.cell_id].lens, x.cell_id]))
  for (const lens of ['L3']) {
    assert.equal(L.cells[byLens[lens]].status, 'settled')
    assert.equal(L.cells[byLens[lens]].verifier, false)
  }
  for (const lens of ['L1', 'L2']) {
    const cc = L.cells[byLens[lens]]
    assert.equal(cc.status, 'seen', '指摘のある枡は検証の待ち行列へ')
    assert.ok(cc.read, '受け付けた読みを保つ')
    assert.ok(!cc.claim, '読みの claim は外れる')
  }
  // 読む役の待ち行列には、まだ読んでいない資産だけが残る（読んだ資産の指摘は返さない）。
  const r2 = claim(state, n.call_id, rows(args, 'read')[1].id)
  assert.ok(!r2.done && r2.asset.id !== c.asset.id)
  assert.ok(!JSON.stringify(r2).includes('の指摘）'), '読む役に他の枡の指摘を渡さない')
  const vs = rows(args, 'verify')
  const v1 = claim(state, n.call_id, vs[0].id)
  const v2 = claim(state, n.call_id, vs[1].id)
  const v3 = claim(state, n.call_id, vs[2].id)
  for (const v of [v1, v2]) {
    assert.equal(v.code, 0, JSON.stringify(v))
    assert.ok(!v.done)
    assert.equal(v.cells.length, 1, '検証の待ち行列は枡を 1 つずつ取る')
    assert.equal(v.asset.id, c.asset.id)
    const x = v.cells[0]
    const lens = L.cells[x.cell_id].lens
    assert.ok(['L1', 'L2'].includes(lens))
    assert.ok(Array.isArray(x.findings) && x.findings.length === 1)
    assert.equal(x.findings[0].claim, own[lens], 'その枡の指摘だけ')
    assert.ok(Object.keys(x).every((k) => [...READ_CELL_KEYS, 'findings'].includes(k)), `検証の枡の要素: ${Object.keys(x)}`)
    const other = own[lens === 'L1' ? 'L2' : 'L1']
    assert.ok(!JSON.stringify(v).includes(other), '同じ資産の他の観点の指摘を返さない')
  }
  assert.notEqual(v1.cells[0].cell_id, v2.cells[0].cell_id, '同じ枡を 2 体に渡さない')
  assert.equal(v3.code, 0, JSON.stringify(v3))
  assert.equal(v3.done, true)
  L = ledger(state)
  assert.deepEqual(L.cells[v1.cells[0].cell_id].claim, { call: n.call_id, worker: vs[0].id })
  // 検証を出すと、指摘が確かめられ、枡は検証役を通った settled になる。
  const x = v1.cells[0]
  const s = submit(state, n.call_id, x.cell_id, put(d, { verdicts: [{ index: 0, verdict: 'confirmed', reason: '本文が支える', quote: x.findings[0].quote }] }))
  assert.equal(s.code, 0, JSON.stringify(s))
  assert.equal(s.ok, true, JSON.stringify(s))
  L = ledger(state)
  assert.equal(L.cells[x.cell_id].status, 'settled')
  assert.equal(L.cells[x.cell_id].verifier, true)
  assert.ok(!L.cells[x.cell_id].claim)
  assert.ok(Object.values(L.findings).some((f) => f.cell === x.cell_id && f.status === 'current' && f.verdict === 'confirmed' && f.claim === x.findings[0].claim))
})

test('claim と submit の拒否: pending と違う --call・pending の無い台帳・ingest の後の古い call・pending が plan・args の workers に無い worker は終了状態 2 で、台帳を変えない', (t) => {
  // pending の無い台帳（init の直後）。
  const { state, d } = qsetup(t)
  let before = bytes(state)
  assert.equal(claim(state, 'deadbeef0000', 'w').code, 2)
  assert.equal(bytes(state), before)
  const { n, args } = review(state)
  const r = rows(args, 'read')[0]
  before = bytes(state)
  for (const [name, out] of [
    ['違う call の claim', claim(state, 'deadbeef0000', r.id)],
    ['workers に無い worker', claim(state, n.call_id, 'no-such-worker')],
  ]) {
    assert.equal(out.code, 2, `${name}: ${JSON.stringify(out)}`)
    assert.equal(bytes(state), before, `${name} は台帳を変えない`)
  }
  const c = claim(state, n.call_id, r.id)
  const x = c.cells[0]
  const f = put(d, goodRead(c.asset))
  before = bytes(state)
  const wrong = submit(state, 'deadbeef0000', x.cell_id, f, r.id)
  assert.equal(wrong.code, 2, JSON.stringify(wrong))
  assert.equal(bytes(state), before, '違う call の submit は台帳を変えない')
  // claim の無い枡（まだ誰も取っていない資産の枡）への submit。
  const unclaimed = Object.entries(ledger(state).cells).find(([, cc]) => cc.asset !== c.asset.id && !cc.claim)[0]
  before = bytes(state)
  const u = submit(state, n.call_id, unclaimed, put(d, goodRead(c.asset)), r.id)
  assert.equal(u.code, 2, `claim の無い枡の submit: ${JSON.stringify(u)}`)
  assert.equal(bytes(state), before, 'claim の無い枡の submit は台帳を変えない')
  for (const y of c.cells) assert.equal(submit(state, n.call_id, y.cell_id, put(d, goodRead(c.asset))).ok, true)
  ingest(state, d, n)
  // ingest が pending を消した後に来た、同じ call の遅い claim と submit。
  before = bytes(state)
  for (const [name, out] of [['ingest の後の claim', claim(state, n.call_id, r.id)], ['ingest の後の submit', submit(state, n.call_id, x.cell_id, f, r.id)]]) {
    assert.equal(out.code, 2, `${name}: ${JSON.stringify(out)}`)
    assert.equal(bytes(state), before, `${name} は台帳を変えない`)
  }
  // pending の段が plan の台帳（目標を照合していない・観点を渡さない）。
  const d2 = tmp(t)
  writeFileSync(path.join(d2, 'doc.md'), DOC)
  writeFileSync(path.join(d2, 'goal.md'), '- G1: 対象の文書の見落としを観点ごとに確かめた指摘の一覧 〔request: 対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい〕\n')
  writeFileSync(path.join(d2, 'request.md'), '対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい')
  const s2 = path.join(d2, 'state')
  assert.equal(cli('init', '--state', s2, '--goal', path.join(d2, 'goal.md'), '--request', path.join(d2, 'request.md'), '--target', path.join(d2, 'doc.md')).code, 0)
  const p = cli('next', '--state', s2)
  assert.equal(p.step, 'plan')
  before = bytes(s2)
  const pc = claim(s2, p.call_id, r.id)
  assert.equal(pc.code, 2, JSON.stringify(pc))
  assert.equal(bytes(s2), before)
})

// ---------------- submit ----------------

test('submit の worker: 枡を取った worker（c.claim.worker）と違う worker からの submit と、claim の無い枡への submit は終了状態 2 で、台帳を変えない', (t) => {
  const { state, d } = qsetup(t)
  const { n, args } = review(state)
  const [w1, w2] = rows(args, 'read')
  const c = claim(state, n.call_id, w1.id)
  const x = c.cells[0]
  let before = bytes(state)
  const other = submit(state, n.call_id, x.cell_id, put(d, goodRead(c.asset)), w2.id)
  assert.equal(other.code, 2, `別の worker の submit: ${JSON.stringify(other)}`)
  assert.equal(bytes(state), before, '別の worker の submit は台帳を変えない')
  const vOther = submit(state, n.call_id, x.cell_id, put(d, goodRead(c.asset)), rows(args, 'verify')[0].id)
  assert.equal(vOther.code, 2, `検証の worker が読む役の枡を出す: ${JSON.stringify(vOther)}`)
  assert.equal(bytes(state), before)
  const unclaimed = Object.entries(ledger(state).cells).find(([, cc]) => cc.asset !== c.asset.id && !cc.claim)[0]
  for (const w of [w1.id, w2.id]) {
    const u = submit(state, n.call_id, unclaimed, put(d, goodRead(c.asset)), w)
    assert.equal(u.code, 2, `claim の無い枡の submit（${w}）: ${JSON.stringify(u)}`)
    assert.equal(bytes(state), before)
  }
  // 取った worker からなら受け付ける。
  const ok = submit(state, n.call_id, x.cell_id, put(d, goodRead(c.asset)), w1.id)
  assert.equal(ok.code, 0, JSON.stringify(ok))
  assert.equal(ok.ok, true, JSON.stringify(ok))
  // 受理の後は claim が外れるので、同じ worker の出し直しも claim の無い枡への submit として拒否する。
  before = bytes(state)
  assert.equal(submit(state, n.call_id, x.cell_id, put(d, goodRead(c.asset)), w1.id).code, 2)
  assert.equal(bytes(state), before)
})

test('submit（読み）: 偽の引用は理由（problems）を返して試行に数え、claim を保つので同じ枡を出し直せる。上限まで拒否された枡は disclosed にし dropped: true を返す', (t) => {
  const { state, d } = qsetup(t, { lenses: [L1, L2] })
  const { n, args } = review(state)
  const w = rows(args, 'read')[0]
  const c = claim(state, n.call_id, w.id)
  const [x, y] = c.cells
  const s1 = submit(state, n.call_id, x.cell_id, put(d, badRead()))
  assert.equal(s1.code, 0, JSON.stringify(s1))
  assert.equal(s1.ok, false)
  assert.ok(Array.isArray(s1.problems) && s1.problems.length, JSON.stringify(s1))
  assert.ok(!s1.dropped, '上限の前の拒否は落とさない')
  let L = ledger(state)
  assert.equal(L.cells[x.cell_id].attempts, 1)
  assert.deepEqual(L.cells[x.cell_id].claim, { call: n.call_id, worker: w.id }, '拒否の後も claim を保つ（出し直せる）')
  assert.ok(missedBy(L, 'rejected_read', x.cell_id))
  const s2 = submit(state, n.call_id, x.cell_id, put(d, goodRead(c.asset)))
  assert.equal(s2.ok, true, JSON.stringify(s2))
  L = ledger(state)
  assert.equal(L.cells[x.cell_id].status, 'settled')
  assert.equal(L.cells[x.cell_id].attempts, 1)
  // 別の枡は上限まで拒否される。
  let last = null
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    last = submit(state, n.call_id, y.cell_id, put(d, badRead()))
    assert.equal(last.code, 0, JSON.stringify(last))
    assert.equal(last.ok, false)
    if (i === MAX_ATTEMPTS - 1) assert.equal(last.dropped, true, '上限に達した拒否は dropped')
    else assert.ok(!last.dropped, `${i + 1} 回目は落とさない`)
  }
  L = ledger(state)
  assert.equal(L.cells[y.cell_id].status, 'disclosed')
  assert.equal(L.cells[y.cell_id].attempts, MAX_ATTEMPTS)
})

test('submit（検証）: verdicts の欠けた検証は理由を返して試行に数え、出し直しで settled（verifier）になる。上限まで欠ければ disclosed と dropped: true', (t) => {
  const { state, d } = qsetup(t, { lenses: [L1, L2] })
  const { n, args } = review(state)
  const c = claim(state, n.call_id, rows(args, 'read')[0].id)
  const [q1, q2] = evidence(c.asset)
  for (const x of c.cells) {
    const lens = lensOf(state, x.cell_id)
    const fs = lens === 'L1' ? [finding('L1 の指摘', q1)] : lens === 'L2' ? [finding('L2 の指摘', q2)] : []
    assert.equal(submit(state, n.call_id, x.cell_id, put(d, goodRead(c.asset, fs))).ok, true)
  }
  const [va, vb] = rows(args, 'verify')
  const a = claim(state, n.call_id, va.id).cells[0]
  const b = claim(state, n.call_id, vb.id).cells[0]
  const s1 = submit(state, n.call_id, a.cell_id, put(d, { verdicts: [] }))
  assert.equal(s1.code, 0, JSON.stringify(s1))
  assert.equal(s1.ok, false)
  assert.ok(s1.problems.length)
  assert.ok(!s1.dropped, '上限の前の拒否は落とさない')
  let L = ledger(state)
  assert.ok(missedBy(L, 'rejected_verify', a.cell_id))
  assert.deepEqual(L.cells[a.cell_id].claim, { call: n.call_id, worker: va.id })
  assert.ok(L.cells[a.cell_id].read, '検証の拒否で読みを捨てない')
  const s2 = submit(state, n.call_id, a.cell_id, put(d, { verdicts: [{ index: 0, verdict: 'confirmed', reason: '本文が支える', quote: a.findings[0].quote }] }))
  assert.equal(s2.ok, true, JSON.stringify(s2))
  L = ledger(state)
  assert.equal(L.cells[a.cell_id].status, 'settled')
  assert.equal(L.cells[a.cell_id].verifier, true)
  let last = null
  for (let i = 0; i < MAX_ATTEMPTS; i++) last = submit(state, n.call_id, b.cell_id, put(d, { verdicts: [] }))
  assert.equal(last.ok, false)
  assert.equal(last.dropped, true)
  assert.equal(ledger(state).cells[b.cell_id].status, 'disclosed')
})

test('submit: 取った後に写しが書き換わったら、終了状態 2 で台帳を変えずに拒否する（偽の引用の拒否と違い、試行に数えない）', (t) => {
  const { state, d } = qsetup(t)
  const { n, args } = review(state)
  const c = claim(state, n.call_id, rows(args, 'read')[0].id)
  const f = put(d, goodRead(c.asset))
  writeFileSync(c.asset.file, readFileSync(c.asset.file, 'utf8').replaceAll('主張', '書き換えた主張'))
  const before = bytes(state)
  const s = submit(state, n.call_id, c.cells[0].cell_id, f)
  assert.equal(s.code, 2, JSON.stringify(s))
  assert.match(s.error, /hash/)
  assert.equal(bytes(state), before)
})

test('submit_cmd: asset の submit_cmd を shell でそのまま流すと、その資産の枡の結果を全て受け付ける（--cell を持たない）', { skip: process.platform === 'win32' }, async (t) => {
  const { state } = qsetup(t, { lenses: [L1, L2] })
  const { n, args } = review(state)
  const w = rows(args, 'read')[0]
  const c = claim(state, n.call_id, w.id)
  assert.equal(c.cells.length, 2)
  const sa = cliArgvOf(c.asset.submit_cmd, 'submit')
  assert.ok(sa, c.asset.submit_cmd)
  assert.equal(sa[sa.indexOf('--worker') + 1], w.id, 'submit_cmd は取った worker の --worker を持つ')
  assert.equal(sa[sa.indexOf('--call') + 1], n.call_id)
  assert.ok(!sa.includes('--cell') && !sa.includes('--result'), `asset の submit_cmd は --cell も --result も持たない: ${sa}`)
  for (const x of c.cells) writeResult(x, goodRead(c.asset))
  const r = await run(null, { shell: c.asset.submit_cmd })
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.deepEqual((r.results || []).map((x) => x.cell).sort(), c.cells.map((x) => x.cell_id).sort(), '取った全ての枡の結果を返す')
  assert.ok(r.results.every((x) => x.ok === true), JSON.stringify(r))
  assert.deepEqual(r.missing, [])
  for (const x of c.cells) assert.equal(ledger(state).cells[x.cell_id].status, 'settled')
})

// ---------------- asset ごとの submit（--cell を持たない） ----------------

test('claim（検証の待ち行列）も asset.submit_cmd を持ち、cells[] の要素は submit_cmd を持たない。命令は --cell と --result を持たず、取った worker の --worker を持つ', (t) => {
  const { state, d } = qsetup(t, { lenses: [L1, L2] })
  const { n, args } = review(state)
  const r = claim(state, n.call_id, rows(args, 'read')[0].id)
  const [q1] = evidence(r.asset)
  for (const x of r.cells) assert.equal(submit(state, n.call_id, x.cell_id, put(d, goodRead(r.asset, lensOf(state, x.cell_id) === 'L1' ? [finding('L1 の指摘', q1)] : []))).ok, true)
  const vw = rows(args, 'verify')[0]
  const v = claim(state, n.call_id, vw.id)
  assert.ok(!v.done, JSON.stringify(v))
  assert.ok(v.asset && typeof v.asset.submit_cmd === 'string', JSON.stringify(v.asset))
  const sa = cliArgvOf(v.asset.submit_cmd, 'submit')
  assert.ok(sa && !sa.includes('--cell') && !sa.includes('--result'), `${sa}`)
  assert.equal(sa[sa.indexOf('--worker') + 1], vw.id)
  for (const x of v.cells) assert.ok(!('submit_cmd' in x), JSON.stringify(x))
  for (const x of r.cells) {
    assert.deepEqual(Object.keys(x).sort(), ['brief', 'cell_id', 'lens', 'result_path'], '読む役の枡の要素は cell_id・lens・brief・result_path だけ')
  }
  for (const x of v.cells) assert.deepEqual(Object.keys(x).sort(), ['brief', 'cell_id', 'findings', 'lens', 'result_path'])
})

test('submit（--cell なし）: 取って出していない全ての枡のうち result_path にファイルがある枡を全て出し、枡ごとの {cell, ok, problems, dropped} の配列（results）と、ファイルの無い枡の missing（id の配列）を返す', (t) => {
  const { state } = qsetup(t, { lenses: [L1, L2] })
  const { n, args } = review(state)
  const c = claim(state, n.call_id, rows(args, 'read')[0].id)
  assert.equal(c.cells.length, 2)
  for (const x of c.cells) writeResult(x, goodRead(c.asset))
  const s = batchSubmit(c)
  assert.equal(s.code, 0, JSON.stringify(s))
  assert.ok(Array.isArray(s.results) && Array.isArray(s.missing), JSON.stringify(s))
  assert.deepEqual(s.results.map((r) => r.cell).sort(), c.cells.map((x) => x.cell_id).sort())
  assert.deepEqual(s.missing, [])
  for (const r of s.results) {
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.ok(!r.dropped, '受け付けた枡は dropped でない')
  }
  const L = ledger(state)
  for (const x of c.cells) {
    assert.equal(L.cells[x.cell_id].status, 'settled', x.cell_id)
    assert.ok(!L.cells[x.cell_id].claim, '受け付けた枡の claim は外れる')
  }
})

test('submit（--cell なし）: ファイルの無い枡は missing に挙げ、試行に数えず、取ったままにする。後でファイルを書いて同じ命令を流すと受け付ける', (t) => {
  const { state } = qsetup(t, { lenses: [L1, L2] })
  const { n, args } = review(state)
  const w = rows(args, 'read')[0]
  const c = claim(state, n.call_id, w.id)
  const [a, b] = c.cells
  writeResult(a, goodRead(c.asset))
  const s1 = batchSubmit(c)
  assert.equal(s1.code, 0, JSON.stringify(s1))
  assert.deepEqual(s1.results.map((r) => r.cell), [a.cell_id], 'ファイルのある枡だけを出す')
  assert.equal(s1.results[0].ok, true)
  assert.deepEqual(s1.missing, [b.cell_id])
  let L = ledger(state)
  assert.equal(L.cells[a.cell_id].status, 'settled')
  assert.equal(L.cells[b.cell_id].status, 'unseen', 'missing の枡は読まれていない')
  assert.equal(L.cells[b.cell_id].attempts, 0, 'missing は試行に数えない')
  assert.deepEqual(L.cells[b.cell_id].claim, { call: n.call_id, worker: w.id }, '取ったままにする')
  assert.ok(!missedBy(L, 'missing_read', b.cell_id) && !missedBy(L, 'rejected_read', b.cell_id), 'missing は出来事を残さない')
  // 流し直しても同じ（何も出さず、試行も増えない）。
  const s2 = batchSubmit(c)
  assert.equal(s2.code, 0, JSON.stringify(s2))
  assert.deepEqual(s2.results, [])
  assert.deepEqual(s2.missing, [b.cell_id])
  assert.equal(ledger(state).cells[b.cell_id].attempts, 0)
  // 残りを書いて同じ命令で出す。
  writeResult(b, goodRead(c.asset))
  const s3 = batchSubmit(c)
  assert.deepEqual(s3.results.map((r) => r.cell), [b.cell_id])
  assert.equal(s3.results[0].ok, true, JSON.stringify(s3))
  assert.deepEqual(s3.missing, [])
  L = ledger(state)
  assert.equal(L.cells[b.cell_id].status, 'settled')
  assert.equal(L.cells[b.cell_id].attempts, 0)
})

test('submit（--cell なし）: 照合に落ちた枡は理由を返して試行に数え、claim を保ち、result_path のファイルを CLI が消す。直す前に流し直しても missing になり、2 回目の試行に数えない', (t) => {
  const { state } = qsetup(t, { lenses: [L1, L2] })
  const { n, args } = review(state)
  const w = rows(args, 'read')[0]
  const c = claim(state, n.call_id, w.id)
  const [bad, good] = c.cells
  writeResult(bad, badRead())
  writeResult(good, goodRead(c.asset))
  const s1 = batchSubmit(c)
  assert.equal(s1.code, 0, JSON.stringify(s1))
  const rb = resultOf(s1, bad.cell_id)
  const rg = resultOf(s1, good.cell_id)
  assert.equal(rb.ok, false, JSON.stringify(s1))
  assert.ok(Array.isArray(rb.problems) && rb.problems.length, '落ちた理由を返す')
  assert.ok(!rb.dropped, '上限の前は落とさない')
  assert.equal(rg.ok, true, '他の枡は落ちた枡に巻き込まれない')
  assert.deepEqual(s1.missing, [])
  let L = ledger(state)
  assert.equal(L.cells[bad.cell_id].attempts, 1, '落ちた枡は 1 回の試行に数える')
  assert.deepEqual(L.cells[bad.cell_id].claim, { call: n.call_id, worker: w.id }, '拒否の後も claim を保つ（出し直せる）')
  assert.ok(missedBy(L, 'rejected_read', bad.cell_id))
  assert.equal(L.cells[good.cell_id].status, 'settled')
  assert.ok(!existsSync(bad.result_path), '照合に落ちた枡の result_path のファイルは CLI が消す')
  // 直さずに流し直す: ファイルが無いので missing になり、同じ中身で 2 回目の試行に数えない。
  const before = ledger(state)
  const s2 = batchSubmit(c)
  assert.equal(s2.code, 0, JSON.stringify(s2))
  assert.deepEqual(s2.results, [], '落ちた枡は出し直されない')
  assert.deepEqual(s2.missing, [bad.cell_id])
  assert.equal(ledger(state).cells[bad.cell_id].attempts, 1, '試行は増えない')
  const after = ledger(state)
  assert.deepEqual(after.cells, before.cells, '枡は変わらない')
  assert.deepEqual(after.events, before.events, '出来事も増えない')
  // 直して書き直し、同じ命令を流し直すと受け付ける。
  writeResult(bad, goodRead(c.asset))
  const s3 = batchSubmit(c)
  assert.deepEqual(s3.results.map((r) => [r.cell, r.ok]), [[bad.cell_id, true]], JSON.stringify(s3))
  L = ledger(state)
  assert.equal(L.cells[bad.cell_id].status, 'settled')
  assert.equal(L.cells[bad.cell_id].attempts, 1)
})

test('submit（--cell なし）: 落ち続ける枡は MAX_ATTEMPTS 回目で disclosed にし、その枡の dropped を true にする（1 枡の submit と同じ数え方）', (t) => {
  const { state } = qsetup(t)
  const { n, args } = review(state)
  const c = claim(state, n.call_id, rows(args, 'read')[0].id)
  const x = c.cells[0]
  let last = null
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    writeResult(x, badRead())
    const s = batchSubmit(c)
    assert.equal(s.code, 0, JSON.stringify(s))
    last = resultOf(s, x.cell_id)
    assert.ok(last && last.ok === false, JSON.stringify(s))
    if (i < MAX_ATTEMPTS - 1) assert.ok(!last.dropped, `${i + 1} 回目は落とさない`)
  }
  assert.equal(last.dropped, true, '上限に達した拒否は dropped')
  const L = ledger(state)
  assert.equal(L.cells[x.cell_id].status, 'disclosed')
  assert.equal(L.cells[x.cell_id].attempts, MAX_ATTEMPTS)
})

test('submit（--cell なし）: その worker が取った枡だけを出す。別の worker が取った枡は、結果のファイルがあっても出さず、台帳を変えない', (t) => {
  const { state } = qsetup(t, { doc: manyDoc(3), lenses: [L1, L2] })
  const { n, args } = review(state)
  const [w1, w2] = rows(args, 'read')
  const c1 = claim(state, n.call_id, w1.id)
  const c2 = claim(state, n.call_id, w2.id)
  assert.notEqual(c1.asset.id, c2.asset.id)
  for (const x of c1.cells) writeResult(x, goodRead(c1.asset))
  for (const x of c2.cells) writeResult(x, goodRead(c2.asset))
  const s1 = batchSubmit(c1)
  assert.deepEqual(s1.results.map((r) => r.cell).sort(), c1.cells.map((x) => x.cell_id).sort(), '自分の枡だけ')
  assert.deepEqual(s1.missing, [])
  let L = ledger(state)
  for (const x of c2.cells) {
    assert.equal(L.cells[x.cell_id].status, 'unseen', '別の worker の枡は出されない')
    assert.deepEqual(L.cells[x.cell_id].claim, { call: n.call_id, worker: w2.id })
    assert.ok(existsSync(x.result_path), '別の worker の結果のファイルは消さない')
  }
  const s2 = batchSubmit(c2)
  assert.deepEqual(s2.results.map((r) => r.cell).sort(), c2.cells.map((x) => x.cell_id).sort())
  L = ledger(state)
  for (const x of c2.cells) assert.equal(L.cells[x.cell_id].status, 'settled')
})

test('submit（--cell なし）: 既に --cell で出した枡は対象にしない（残りの枡だけを出す）。--cell と --result を持つ submit も今のまま使える', (t) => {
  const { state, d } = qsetup(t, { lenses: [L1, L2] })
  const { n, args } = review(state)
  const c = claim(state, n.call_id, rows(args, 'read')[0].id)
  const [a, b] = c.cells
  assert.equal(submit(state, n.call_id, a.cell_id, put(d, goodRead(c.asset))).ok, true, '1 枡だけ出し直す口は残る')
  writeResult(b, goodRead(c.asset))
  const s = batchSubmit(c)
  assert.equal(s.code, 0, JSON.stringify(s))
  assert.deepEqual(s.results.map((r) => r.cell), [b.cell_id], '出した枡は results に入らない')
  assert.deepEqual(s.missing, [], '出した枡は missing にも入らない')
  assert.equal(ledger(state).cells[b.cell_id].status, 'settled')
})

test('submit（--cell なし・検証）: 検証役が取った枡の verdicts を asset.submit_cmd で出すと、枡は検証役を通った settled になる', (t) => {
  const { state, d } = qsetup(t)
  const { n, args } = review(state)
  const r = claim(state, n.call_id, rows(args, 'read')[0].id)
  const [q1] = evidence(r.asset)
  for (const x of r.cells) assert.equal(submit(state, n.call_id, x.cell_id, put(d, goodRead(r.asset, [finding('L1 の指摘', q1)]))).ok, true)
  const vw = rows(args, 'verify')[0]
  const v = claim(state, n.call_id, vw.id)
  const x = v.cells[0]
  assert.equal(v.cells.length, 1)
  writeResult(x, { verdicts: [{ index: 0, verdict: 'confirmed', reason: '本文が支える', quote: x.findings[0].quote }] })
  const s = batchSubmit(v)
  assert.equal(s.code, 0, JSON.stringify(s))
  assert.deepEqual(s.results.map((q) => [q.cell, q.ok]), [[x.cell_id, true]], JSON.stringify(s))
  assert.deepEqual(s.missing, [])
  const L = ledger(state)
  assert.equal(L.cells[x.cell_id].status, 'settled')
  assert.equal(L.cells[x.cell_id].verifier, true)
  assert.ok(!L.cells[x.cell_id].claim)
})

test('worker の prompt: 全ての枡の result_path に Write ツールで書いてから asset.submit_cmd を 1 回流す手順で、cells[].submit_cmd と shell のリダイレクトで書く案内を持たない', async (t) => {
  const { state } = qsetup(t, { workers: 2 })
  const log = []
  const { stop, steps } = await drive(state, mockAgent({}, log))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const call = steps[0].res.call_id
  const ws = log.filter((x) => { const a = cliArgvOf(x.prompt, 'claim'); return a && a[a.indexOf('--call') + 1] === call })
  assert.ok(ws.length >= 2, '読む役と検証役の worker の prompt')
  for (const x of ws) {
    assert.match(x.prompt, /asset\.submit_cmd/, `${x.label}: asset.submit_cmd を流す手順`)
    assert.ok(!x.prompt.includes('cells[].submit_cmd'), `${x.label}: cells[].submit_cmd は無い`)
    assert.match(x.prompt, /Write ツール/, `${x.label}: 結果は Write ツールで書く`)
    assert.ok(!x.prompt.includes('>|'), `${x.label}: shell のリダイレクトで書く案内を外す`)
    assert.match(x.prompt, /ok が false/, `${x.label}: ok が false の枡だけ直して流し直す`)
  }
})

// ---------------- 提出されなかった枡と call_seq ----------------

test('戻し（読む役の待ち行列・next）: 取られたまま提出されず ingest も無いまま next が来たら、unseen に戻し claim を外し試行に数え missing_read を残し、call_seq を進めて別の call_id を返す', (t) => {
  const { state, d } = qsetup(t)
  const { n, args } = review(state)
  const w = rows(args, 'read')[0]
  const c = claim(state, n.call_id, w.id)
  const ids = c.cells.map((x) => x.cell_id)
  const seq0 = ledger(state).call_seq
  assert.ok(Number.isInteger(seq0), '台帳に呼び出しの通し番号 call_seq がある')
  const n2 = review(state).n
  assert.notEqual(n2.call_id, n.call_id, '取りを戻した next は別の呼び出し')
  const L = ledger(state)
  assert.equal(L.call_seq, seq0 + 1)
  for (const id of ids) {
    assert.equal(L.cells[id].status, 'unseen')
    assert.ok(!L.cells[id].claim)
    assert.equal(L.cells[id].attempts, 1)
    assert.ok(missedBy(L, 'missing_read', id), `${id} の missing_read`)
  }
  // 前の呼び出しの遅い claim と submit は拒否される。
  const before = bytes(state)
  assert.equal(claim(state, n.call_id, w.id).code, 2)
  assert.equal(submit(state, n.call_id, ids[0], put(d, goodRead(c.asset)), w.id).code, 2)
  assert.equal(bytes(state), before)
  // 戻すものが無い next は、同じ呼び出しを返し、call_seq を進めない。
  const n3 = review(state).n
  assert.equal(n3.call_id, n2.call_id)
  assert.equal(ledger(state).call_seq, seq0 + 1)
})

test('戻し（読む役の待ち行列）: 試行に数えて MAX_ATTEMPTS に届いた枡は disclosed にする', (t) => {
  const { state } = qsetup(t)
  let ids = []
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const { n, args } = review(state)
    ids = claimAll(state, n.call_id, args).flatMap((c) => c.cells.map((x) => x.cell_id))
    assert.ok(ids.length)
  }
  cli('next', '--state', state)
  const L = ledger(state)
  for (const id of ids) {
    assert.equal(L.cells[id].status, 'disclosed', id)
    assert.equal(L.cells[id].attempts, MAX_ATTEMPTS)
  }
})

test('戻し（読む役の待ち行列・ingest）: その呼び出しの ingest が、提出されなかった枡を unseen に戻して試行に数える。提出を受けた呼び出しなので全件失敗には数えない', (t) => {
  const { state, d } = qsetup(t)
  const { n, args } = review(state)
  const [w1, w2] = rows(args, 'read')
  const a = claim(state, n.call_id, w1.id)
  const b = claim(state, n.call_id, w2.id)
  for (const x of a.cells) assert.equal(submit(state, n.call_id, x.cell_id, put(d, goodRead(a.asset))).ok, true)
  const seq0 = ledger(state).call_seq
  ingest(state, d, n)
  const L = ledger(state)
  assert.equal(L.call_seq, seq0 + 1, 'review の ingest は call_seq を 1 つ進める')
  assert.equal(L.pending, null)
  assert.equal(L.fail_streak, 0)
  for (const x of a.cells) assert.equal(L.cells[x.cell_id].status, 'settled')
  for (const x of b.cells) {
    const c = L.cells[x.cell_id]
    assert.equal(c.status, 'unseen')
    assert.ok(!c.claim)
    assert.equal(c.attempts, 1)
    assert.ok(!c.env_attempts, '提出を受けた呼び出しの欠けは環境の失敗に数えない')
    assert.ok(missedBy(L, 'missing_read', x.cell_id))
  }
  const n2 = review(state).n
  assert.notEqual(n2.call_id, n.call_id)
})

test('戻し（検証の待ち行列）: 検証役が取ったまま提出しなかった枡は、読み（c.read）を保ったまま claim だけを外し、試行に数えて missing_verify を残す。次の呼び出しでは検証の待ち行列から取られる', (t) => {
  const { state, d } = qsetup(t)
  const { n, args } = review(state)
  const c = claim(state, n.call_id, rows(args, 'read')[0].id)
  const [q1] = evidence(c.asset)
  let target = null
  for (const x of c.cells) {
    const fs = lensOf(state, x.cell_id) === 'L1' ? [finding('根拠が無い主張', q1)] : []
    if (fs.length) target = x.cell_id
    assert.equal(submit(state, n.call_id, x.cell_id, put(d, goodRead(c.asset, fs))).ok, true)
  }
  assert.ok(target, '指摘を返す L1 の枡がある')
  const v = claim(state, n.call_id, rows(args, 'verify')[0].id)
  assert.equal(v.cells[0].cell_id, target)
  ingest(state, d, n)
  let L = ledger(state)
  const cc = L.cells[target]
  assert.equal(cc.status, 'seen')
  assert.ok(cc.read, '受け付けた読みを捨てない')
  assert.ok(!cc.claim)
  assert.equal(cc.attempts, 1)
  assert.ok(missedBy(L, 'missing_verify', target))
  const { n: n2, args: a2 } = review(state)
  const reads = claimAll(state, n2.call_id, a2).flatMap((x) => x.cells.map((y) => y.cell_id))
  assert.ok(!reads.includes(target), '読む役の待ち行列に出さない')
  const v2 = claim(state, n2.call_id, rows(a2, 'verify')[0].id)
  assert.equal(v2.code, 0, JSON.stringify(v2))
  assert.equal(v2.cells[0].cell_id, target, '検証の待ち行列から取られる')
  L = ledger(state)
  assert.deepEqual(L.cells[target].claim, { call: n2.call_id, worker: rows(a2, 'verify')[0].id })
})

test('戻し（検証の待ち行列）: 試行に数えて MAX_ATTEMPTS に届いた枡は disclosed にする', (t) => {
  const { state, d } = qsetup(t)
  let { n, args } = review(state)
  const c = claim(state, n.call_id, rows(args, 'read')[0].id)
  const [q1] = evidence(c.asset)
  let target = null
  for (const x of c.cells) {
    const fs = lensOf(state, x.cell_id) === 'L1' ? [finding('根拠が無い主張', q1)] : []
    if (fs.length) target = x.cell_id
    submit(state, n.call_id, x.cell_id, put(d, goodRead(c.asset, fs)))
  }
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    if (i) ({ n, args } = review(state))
    const v = claim(state, n.call_id, rows(args, 'verify')[0].id)
    assert.equal(v.cells[0].cell_id, target)
    ingest(state, d, n)
  }
  const L = ledger(state)
  assert.equal(L.cells[target].status, 'disclosed')
  assert.equal(L.cells[target].attempts, MAX_ATTEMPTS)
})

test('call_seq: review の args に台帳の call_seq が入り、review の ingest ごとに 1 つ進んで call_id が変わる。状態を変えない next は同じ call_id を返す', (t) => {
  const { state, d } = qsetup(t, { doc: manyDoc(3) })
  const { n, args } = review(state)
  assert.equal(args.call_seq, ledger(state).call_seq)
  assert.equal(review(state).n.call_id, n.call_id, '同じ状態の next は同じ call_id')
  const seq0 = ledger(state).call_seq
  const c = claim(state, n.call_id, rows(args, 'read')[0].id)
  for (const x of c.cells) submit(state, n.call_id, x.cell_id, put(d, goodRead(c.asset)))
  ingest(state, d, n)
  assert.equal(ledger(state).call_seq, seq0 + 1)
  const { n: n2, args: a2 } = review(state)
  assert.notEqual(n2.call_id, n.call_id)
  assert.equal(a2.call_seq, seq0 + 1)
  assert.equal(review(state).n.call_id, n2.call_id)
})

test('提出が 1 件も無い呼び出し: 全ての役が欠けた呼び出しと同じく fail_streak と env_attempts に数え、続けば blocked（failure）。直して再開すれば試行が戻る', (t) => {
  const { state, d } = qsetup(t)
  let ids = []
  for (let i = 0; i < 2; i++) {
    const { n, args } = review(state)
    ids = claimAll(state, n.call_id, args).flatMap((c) => c.cells.map((x) => x.cell_id))
    // worker は返った（ok）が、提出は 1 件も無い。
    ingest(state, d, n, okResult(n, true))
    const L = ledger(state)
    assert.equal(L.fail_streak, i + 1, `${i + 1} 回目`)
    for (const id of ids) assert.equal(L.cells[id].env_attempts, i + 1, '提出の無い呼び出しの欠けは環境の失敗として数える')
  }
  const stop = cli('next', '--state', state)
  assert.equal(stop.stop, 'blocked', JSON.stringify(stop))
  assert.equal(stop.cause, 'failure')
  const again = review(state)
  assert.ok(again.n.call_id)
  const L = ledger(state)
  for (const id of ids) {
    assert.equal(L.cells[id].attempts, 0, '再開で環境の失敗の試行を戻す')
    assert.equal(L.cells[id].status, 'unseen')
  }
})

// ---------------- lock ----------------

test('lock: 並べて流した claim は互いに違う資産を返し、並べて流した submit は全て台帳に残る（失われた更新が無い）', async (t) => {
  const { state, d } = qsetup(t, { doc: manyDoc(6), workers: 6 })
  const { n, args } = review(state)
  const rs = rows(args, 'read')
  assert.equal(rs.length, 6)
  const outs = await Promise.all(rs.map((w) => run(['claim', '--state', state, '--call', n.call_id, '--worker', w.id])))
  for (const o of outs) assert.equal(o.code, 0, JSON.stringify(o))
  assert.ok(outs.every((o) => !o.done), JSON.stringify(outs.map((o) => o.done)))
  assert.equal(new Set(outs.map((o) => o.asset.id)).size, outs.length, '同じ資産を 2 体に渡さない')
  let L = ledger(state)
  outs.forEach((o, i) => { for (const x of o.cells) assert.deepEqual(L.cells[x.cell_id].claim, { call: n.call_id, worker: rs[i].id }, '他の worker の claim で上書きしない') })
  const jobs = outs.flatMap((o, i) => o.cells.map((x) => ['submit', '--state', state, '--call', n.call_id, '--cell', x.cell_id, '--worker', rs[i].id, '--result', put(d, goodRead(o.asset))]))
  const subs = await Promise.all(jobs.map((a) => run(a)))
  for (const s of subs) assert.equal(s.code, 0, JSON.stringify(s))
  const accepted = subs.filter((s) => s.ok).length
  assert.equal(accepted, jobs.length)
  L = ledger(state)
  const settled = Object.values(L.cells).filter((c) => !L.assets[c.asset]?.retro && c.status === 'settled').length
  assert.equal(settled, accepted, '受け付けた提出の数 = settled の枡の数')
  assert.ok(!existsSync(path.join(state, 'ledger.lock')), '終われば lock を残さない')
})

test('lock: 並べて流した hint は互いに違う id を受け取る', async (t) => {
  const { state } = qsetup(t)
  const outs = await Promise.all(Array.from({ length: 6 }, (_, i) => run(['hint', '--state', state, '--text', `ヒント ${i}`])))
  for (const o of outs) assert.equal(o.code, 0, JSON.stringify(o))
  assert.equal(new Set(outs.map((o) => o.id)).size, outs.length)
})

test('lock: 生きた lock（mtime が 60 秒より新しい）を待つ時間が上限（10 秒）を超えたら Fail（終了状態 2）で、台帳を変えず、他の process の lock を消さない', { timeout: 60000 }, async (t) => {
  const { state } = qsetup(t)
  const lock = path.join(state, 'ledger.lock')
  writeFileSync(lock, String(process.pid))
  const before = bytes(state)
  const t0 = Date.now()
  const r = await run(['config', '--state', state, '--max-cycles', '9'])
  const took = Date.now() - t0
  assert.equal(r.code, 2, JSON.stringify(r))
  assert.ok(took >= 9000, `上限まで待つ（${took} ms）`)
  assert.ok(took < 30000, `上限を超えて待たない（${took} ms）`)
  assert.equal(bytes(state), before)
  assert.ok(existsSync(lock), '生きた lock は消さない')
})

test('lock: mtime が 60 秒より前の lock は古いものとして消して取り直す', (t) => {
  const { state } = qsetup(t)
  const lock = path.join(state, 'ledger.lock')
  writeFileSync(lock, 'x')
  const old = (Date.now() - 120 * 1000) / 1000
  utimesSync(lock, old, old)
  const c = cli('config', '--state', state, '--max-cycles', '6')
  assert.equal(c.code, 0, JSON.stringify(c))
  assert.equal(ledger(state).config.max_cycles, 6)
  assert.ok(!existsSync(lock))
})

test('lock: 古い lock（stateDir/ledger.lock）は壊れたものとして消して取り直し、コマンドは成功しても失敗しても lock を残さない', (t) => {
  const { state } = qsetup(t)
  const lock = path.join(state, 'ledger.lock')
  writeFileSync(lock, 'x')
  utimesSync(lock, 0, 0)
  const c = cli('config', '--state', state, '--max-cycles', '5')
  assert.equal(c.code, 0, JSON.stringify(c))
  assert.equal(ledger(state).config.max_cycles, 5)
  assert.ok(!existsSync(lock), '成功の後に lock を残さない')
  const { n } = review(state)
  assert.ok(!existsSync(lock))
  assert.equal(claim(state, n.call_id, 'no-such-worker').code, 2)
  assert.ok(!existsSync(lock), 'Fail の後にも lock を残さない')
})

// ---------------- Workflow の review の段（偽の worker） ----------------

test('worker: workers の行ごとに 1 体を起動し、全ての読む役の worker が終わってから検証役の worker を起動する。1 回の呼び出しで読みと検証が済む', async (t) => {
  const { state } = qsetup(t, { workers: 2 })
  const log = []
  const agentFn = mockAgent({
    read: (p, o) => {
      const cell = o.label.slice('read-'.length).split('（')[0]
      if (!cell.endsWith('一つ目の節/p1|L1|p1')) return undefined
      return { cell_id: cell, evidence: evidenceOf(p), findings: [finding('根拠が無い主張', 'この節は一つ目の主張を述べる本文の行である。')], outside_notes: [], none_reason: '' }
    },
  }, log)
  const { stop, steps } = await drive(state, agentFn)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const s = steps[0]
  assert.equal(s.step, 'review')
  const byId = new Map(s.args.workers.map((w) => [w.id, w]))
  // 起動の記録: 行の数と同じだけ、行の役で起動する。
  assert.equal(s.res.agents.length, s.args.workers.length, JSON.stringify(s.res.agents))
  assert.deepEqual(s.res.agents.map((a) => a.role).sort(), s.args.workers.map((w) => w.role).sort())
  // worker の prompt は claim の命令を持ち、行の id を --worker に渡し、前の枡の結果を持ち込まないよう指示する。
  const callOf = (x) => { const a = cliArgvOf(x.prompt, 'claim'); return a && a[a.indexOf('--call') + 1] }
  const ws = log.filter((x) => callOf(x) === s.res.call_id)
  assert.equal(ws.length, s.args.workers.length)
  const named = ws.map((x) => { const a = cliArgvOf(x.prompt, 'claim'); return a[a.indexOf('--worker') + 1] })
  assert.deepEqual(named.sort(), [...byId.keys()].sort(), '行ごとに 1 体')
  for (const x of ws) {
    assert.match(x.prompt, /持ち込ま/, `${x.label} の prompt に前の枡の結果を持ち込まない指示がある`)
    assert.ok(!x.prompt.includes('主張を述べる'), 'worker の prompt に対象の本文を載せない')
  }
  const spans = log.workers.filter((w) => w.call === s.res.call_id)
  const readers = spans.filter((w) => byId.get(w.worker).queue === 'read')
  const verifiers = spans.filter((w) => byId.get(w.worker).queue === 'verify')
  assert.ok(readers.length && verifiers.length)
  const lastReaderEnd = Math.max(...readers.map((w) => w.end))
  assert.ok(verifiers.every((w) => w.start >= lastReaderEnd), '検証役の worker は全ての読む役の worker が終わってから起動する')
  assert.ok(readers.every((r) => verifiers.every((v) => r.model !== v.model)), '読む役と検証役は別のモデル')
  // 検証役は指摘のある枡だけを読み、1 回目の review の取り込みで全ての枡が確かめられている。
  const verified = log.filter((x) => x.label.startsWith('verify-') && !x.label.startsWith('verify-unit-'))
  assert.equal(verified.length, 1)
  assert.ok(verified[0].label.includes('一つ目の節/p1|L1|p1'))
  assert.equal(s.ingest.coverage.pending.length, 0, JSON.stringify(s.ingest.coverage))
  assert.equal(s.ingest.coverage.settled_with_verifier, 1)
  // 各 claim の出力は 1 資産分で、読む役の出力に他の枡の指摘が混ざらない。
  for (const c of log.claims.filter((x) => !x.out.done)) {
    if (byId.get(c.worker)?.queue === 'read') assert.ok(!JSON.stringify(c.out).includes('根拠が無い主張'))
  }
})

test('worker: 提出が 1 件も無い呼び出し（worker は返るが claim も submit もしない）が続けば blocked（failure）で、直した偽物で再開すれば完了する', async (t) => {
  const { state } = qsetup(t)
  const idle = mockAgent({ worker: () => ({ assets: 0, submitted: 0, rejected: 0, notes: ['Bash が使えない'] }) })
  const { stop, steps } = await drive(state, idle)
  assert.equal(stop.stop, 'blocked', JSON.stringify(stop))
  assert.equal(stop.cause, 'failure')
  assert.ok(steps.filter((s) => s.step === 'review').length >= 2)
  assert.ok(steps.every((s) => s.res.agents.every((a) => a.ok)), 'worker は返っている')
  const again = await drive(state, mockAgent())
  assert.equal(again.stop.stop, 'complete', JSON.stringify(again.stop))
  assert.deepEqual(again.stop.disclosed, [])
})

test('worker: 検証役が 1 度提出しなかった枡は、次の呼び出しで読み直さずに検証され、missing_verify が残る', async (t) => {
  const { state } = qsetup(t)
  const log = []
  let v = 0
  const target = '一つ目の節/p1|L1|p1'
  const agentFn = mockAgent({
    read: (p, o) => {
      const cell = o.label.slice('read-'.length).split('（')[0]
      if (!cell.endsWith(target)) return undefined
      return { cell_id: cell, evidence: evidenceOf(p), findings: [finding('根拠が無い主張', 'この節は一つ目の主張を述べる本文の行である。')], outside_notes: [], none_reason: '' }
    },
    verify: (p, o) => (o.label.startsWith('verify-unit-') ? undefined : v++ < 1 ? null : undefined),
  }, log)
  const { stop, steps } = await drive(state, agentFn)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(steps.filter((s) => s.step === 'review').length >= 2)
  const L = ledger(state)
  const id = Object.keys(L.cells).find((k) => k.endsWith(target))
  assert.equal(L.cells[id].status, 'settled')
  assert.equal(L.cells[id].verifier, true)
  assert.equal(L.cells[id].attempts, 1)
  assert.ok(missedBy(L, 'missing_verify', id))
  assert.equal(log.filter((x) => x.label.startsWith('read-') && x.label.includes(target)).length, 1, '受け付けた読みを読み直さない')
})

test('worker: k=2 でも、全ての回の読む役の worker が終わってから検証役の worker を起動し、2 回目の組は reader_2・verifier_2 で起動する', async (t) => {
  const { state } = qsetup(t, { extra: ['--k', '2'], workers: 1 })
  const log = []
  const agentFn = mockAgent({
    read: (p, o) => {
      const cell = o.label.slice('read-'.length).split('（')[0]
      if (!/一つ目の節\/p1\|L1\|p[12]$/.test(cell)) return undefined
      return { cell_id: cell, evidence: evidenceOf(p), findings: [finding('根拠が無い主張', 'この節は一つ目の主張を述べる本文の行である。')], outside_notes: [], none_reason: '' }
    },
  }, log)
  const { stop, steps } = await drive(state, agentFn)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const s = steps[0]
  assert.equal(s.step, 'review')
  const byId = new Map(s.args.workers.map((w) => [w.id, w]))
  const roles = s.res.agents.map((a) => a.role)
  for (const r of ['reader_1', 'reader_2', 'verifier', 'verifier_2']) assert.ok(roles.includes(r), `${r} で起動する: ${roles}`)
  const spans = log.workers.filter((w) => w.call === s.res.call_id)
  const readers = spans.filter((w) => byId.get(w.worker).queue === 'read')
  const verifiers = spans.filter((w) => byId.get(w.worker).queue === 'verify')
  assert.ok(readers.some((w) => byId.get(w.worker).pass === 2) && verifiers.some((w) => byId.get(w.worker).pass === 2))
  const lastReaderEnd = Math.max(...readers.map((w) => w.end))
  assert.ok(verifiers.every((w) => w.start >= lastReaderEnd), '検証役の worker は、全ての回の読む役の worker が終わってから起動する')
  assert.equal(s.ingest.coverage.pending.length, 0, JSON.stringify(s.ingest.coverage))
  assert.equal(s.ingest.coverage.settled_with_verifier, 2)
})

// ---------------- 結果の path と、未提出の claim の取り直し ----------------

test('result_path: 同じ呼び出しで、読む役が読んで指摘を出した枡を検証役が取ると、読む役の result_path と違う path を返す', (t) => {
  const { state, d } = qsetup(t)
  const { n, args } = review(state)
  const c = claim(state, n.call_id, rows(args, 'read')[0].id)
  const [q1] = evidence(c.asset)
  let target = null
  for (const x of c.cells) {
    const fs = lensOf(state, x.cell_id) === 'L1' ? [finding('根拠が無い主張', q1)] : []
    if (fs.length) target = x
    assert.equal(submit(state, n.call_id, x.cell_id, put(d, goodRead(c.asset, fs))).ok, true)
  }
  assert.ok(target, '指摘を返す L1 の枡がある')
  const v = claim(state, n.call_id, rows(args, 'verify')[0].id)
  assert.equal(v.cells[0].cell_id, target.cell_id)
  assert.notEqual(v.cells[0].result_path, target.result_path, '読む役と検証役の結果の path は違う')
  assert.ok(path.resolve(v.cells[0].result_path).startsWith(state + path.sep), 'result_path は stateDir の中')
})

test('result_path: claim は、返す path に既にあるファイルを消す（出し直しで同じ path を返すときも空にする）', (t) => {
  const { state } = qsetup(t)
  const { n, args } = review(state)
  const w = rows(args, 'read')[0]
  const c1 = claim(state, n.call_id, w.id)
  for (const x of c1.cells) { mkdirSync(path.dirname(x.result_path), { recursive: true }); writeFileSync(x.result_path, '{"古い":"中身"}') }
  const c2 = claim(state, n.call_id, w.id)
  assert.equal(c2.code, 0, JSON.stringify(c2))
  assert.deepEqual(c2.cells.map((x) => x.result_path).sort(), c1.cells.map((x) => x.result_path).sort(), '同じ枡には同じ path を返す')
  for (const x of c2.cells) assert.ok(!existsSync(x.result_path), `claim の後に古いファイルが残らない: ${x.result_path}`)
})

test('claim の取り直し: まだ提出していない claim を持つ worker が claim すると、新しい資産を取らずに、持っている枡を同じ形で返す', (t) => {
  const { state, d } = qsetup(t, { lenses: [L1, L2] })
  const { n, args } = review(state)
  const w = rows(args, 'read')[0]
  const c1 = claim(state, n.call_id, w.id)
  const before = JSON.stringify(ledger(state).cells)
  const c2 = claim(state, n.call_id, w.id)
  assert.equal(c2.code, 0, JSON.stringify(c2))
  assert.ok(!c2.done)
  assert.equal(c2.asset.id, c1.asset.id, '同じ資産を返す')
  assert.deepEqual(c2.cells.map((x) => x.cell_id).sort(), c1.cells.map((x) => x.cell_id).sort(), '同じ枡を返す')
  assert.deepEqual(c2.asset, c1.asset)
  assert.deepEqual(Object.keys(c2.cells[0]).sort(), Object.keys(c1.cells[0]).sort(), '同じ形で返す')
  const L = ledger(state)
  for (const [id, c] of Object.entries(L.cells)) if (c.asset !== c1.asset.id) assert.ok(!c.claim, `他の資産の枡は取らない: ${id}`)
  assert.equal(JSON.stringify(L.cells), before, '取り直しは枡を変えない')
  // 一部を出した後の取り直しは、残りの枡だけを返す。
  const [first, ...rest] = c1.cells
  assert.equal(submit(state, n.call_id, first.cell_id, put(d, goodRead(c1.asset))).ok, true)
  const c3 = claim(state, n.call_id, w.id)
  assert.equal(c3.asset.id, c1.asset.id)
  assert.deepEqual(c3.cells.map((x) => x.cell_id).sort(), rest.map((x) => x.cell_id).sort(), '提出していない枡だけを返す')
  // 全て出せば、次の資産を取る。
  for (const x of rest) assert.equal(submit(state, n.call_id, x.cell_id, put(d, goodRead(c1.asset))).ok, true)
  const c4 = claim(state, n.call_id, w.id)
  assert.ok(!c4.done)
  assert.notEqual(c4.asset.id, c1.asset.id, '出し終えたら次の資産を取る')
})
