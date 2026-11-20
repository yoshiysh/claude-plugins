// 単位 1 のテスト: 台帳の単位をファイルにする。1 体の文脈に収まらないファイルだけを構造の境目（見出し・宣言）で分けて同格の単位にし、
// 規模による分岐や調整した数値の線を置かない（設計「段の構成」の「単位をファイルにする」、決定 8・9・11）。単位の hash と、init・reframe が書く phase.json
// （設計「既存のスキルへの組み込み」の coverage-build との受け渡し）。coverage-build が phase.json を読む側は tests/coverage-build-audit-phase-file.test.mjs。
// 「収まらない」の判じ方は ledger-core の定数 UNIT_MAX_BYTES（単位の本文のバイト数の上限）で決める。テストは値を写さず、定数から fixture の大きさを作る。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as core from './ledger-core.mjs'
import { cli, project, run, status } from './blackboard-fixture.mjs'

const MAX = Number.isInteger(core.UNIT_MAX_BYTES) && core.UNIT_MAX_BYTES > 0 ? core.UNIT_MAX_BYTES : 16000
const bytes = (s) => Buffer.byteLength(s, 'utf8')
// next を 1 回流して対象を台帳に合わせ、status の units を返す。
function unitsOf(state) {
  cli('next', '--state', state)
  const s = status(state)
  assert.equal(s.code, 0, JSON.stringify(s))
  assert.ok(Array.isArray(s.units), `status に units（単位の一覧）が無い: ${Object.keys(s).join(', ')}`)
  return s.units
}
const textOf = (file, u) => readFileSync(file, 'utf8').split('\n').slice(u.start - 1, u.end).join('\n')

// 1 体に収まる小さい文書（見出しが多くても分けない）。
const SMALL_MD = ['# 小さい文書', '', ...Array.from({ length: 12 }, (_, i) => [`## 節 ${i}`, '', `節 ${i} の本文の行は、この節が述べる主張を一つだけ書く。`, '- 箇条書きの項目の行も含む', '']).flat()].join('\n')
const SMALL_JS = ['// 小さいモジュール', ...Array.from({ length: 8 }, (_, i) => `export function f${i}(x) {\n  return x + ${i}\n}\n`)].join('\n')

// UNIT_MAX_BYTES のおよそ 3 倍の Markdown。## の節が 15、うち S0 はおよそ 1.5 倍で ### の小節に分かれる。
function bigMd() {
  const per = Math.max(2, Math.ceil(MAX / 10 / 100))
  const para = (tag) => Array.from({ length: per }, (_, i) => `${tag} の本文の行 ${i} は、この節が述べる主張を順に書き連ねたものである。`).join('\n')
  const out = ['# 大きい文書', '', '導入の段落の本文の行は、この文書の全体の目的を述べる。', '', '## S0 大きい節', '']
  for (let k = 0; k < 15; k++) out.push(`### S0-${k} 小節`, '', para(`S0-${k}`), '')
  for (let i = 1; i < 15; i++) out.push(`## S${i} 節`, '', para(`S${i}`), '')
  return out.join('\n')
}
// UNIT_MAX_BYTES のおよそ 3 倍の JS。トップレベルの関数の宣言が 30。
function bigJs() {
  const per = Math.max(2, Math.ceil(MAX / 10 / 70))
  const out = []
  for (let i = 0; i < 30; i++) {
    out.push(`export function part${i}(x) {`, '  const rows = [')
    for (let k = 0; k < per; k++) out.push(`    'part${i} の行 ${k} は、宣言の中身を埋めるための文字列である',`)
    out.push('  ]', '  return rows.length + x', '}', '')
  }
  return out.join('\n')
}

test('UNIT_MAX_BYTES: 「1 体の文脈に収まらない」を判じる上限は ledger-core の 1 つの定数（正の整数）にある', () => {
  assert.ok(Number.isInteger(core.UNIT_MAX_BYTES) && core.UNIT_MAX_BYTES > 0, `ledger-core に UNIT_MAX_BYTES が無い: ${core.UNIT_MAX_BYTES}`)
  assert.equal(core.MAX_ASSET_LINES, undefined, '資産を行数で切る上限（MAX_ASSET_LINES）は無い')
  assert.equal(core.MAX_BLOCKS, undefined, '読んだ証拠の区画（MAX_BLOCKS）は無い')
})

test('単位: 収まるファイルは見出しが多くても分けず、1 ファイル 1 単位。id はファイルの path、範囲は 1 行目から最終行まで', (t) => {
  const { state, paths } = project(t, { 'a.md': SMALL_MD, 'b.mjs': SMALL_JS })
  const units = unitsOf(state)
  assert.deepEqual(units.map((u) => u.id).sort(), [paths['a.md'], paths['b.mjs']].sort(), JSON.stringify(units.map((u) => u.id)))
  for (const u of units) {
    const n = readFileSync(u.path, 'utf8').split('\n').length
    assert.equal(u.start, 1, u.id)
    assert.equal(u.end, n, u.id)
    assert.equal(u.state, 'unseen', `まだ読んでいない単位は unseen: ${u.id}`)
    assert.equal(typeof u.hash, 'string')
  }
})

test('単位の hash: 中身が同じなら同じ、中身が変われば変わる。変わったファイルだけが unseen に戻る（他の単位の hash は変わらない）', (t) => {
  const { state, paths } = project(t, { 'a.md': SMALL_MD, 'b.mjs': SMALL_JS })
  const before = Object.fromEntries(unitsOf(state).map((u) => [u.id, u.hash]))
  assert.deepEqual(Object.fromEntries(unitsOf(state).map((u) => [u.id, u.hash])), before, '変えなければ同じ hash')
  writeFileSync(paths['a.md'], SMALL_MD.replace('節 3 の本文の行', '節 3 の書き換えた本文の行'))
  const after = Object.fromEntries(unitsOf(state).map((u) => [u.id, u.hash]))
  assert.notEqual(after[paths['a.md']], before[paths['a.md']])
  assert.equal(after[paths['b.mjs']], before[paths['b.mjs']])
})

test('分ける（Markdown）: 収まらないファイルだけを見出しの境目で分け、各単位は UNIT_MAX_BYTES 以下・見出しの行から始まり・ファイルを隙間なく覆う', (t) => {
  const text = bigMd()
  assert.ok(bytes(text) > 2 * MAX, 'fixture は上限より十分に大きい')
  const { state, paths } = project(t, { 'big.md': text, 'small.md': SMALL_MD })
  const units = unitsOf(state)
  const big = units.filter((u) => u.path === paths['big.md']).sort((a, b) => a.start - b.start)
  assert.ok(big.length > 1, '収まらないファイルは分ける')
  assert.deepEqual(units.filter((u) => u.path === paths['small.md']).map((u) => u.id), [paths['small.md']], '同じ run の収まるファイルは分けない（規模で全体の形を変えない）')
  const lines = text.split('\n')
  const headings = lines.filter((l) => /^#{1,6}\s/.test(l)).length
  assert.ok(big.length < headings, `見出しごとに 1 単位まで細かく切らない（単位 ${big.length}・見出し ${headings}）`)
  assert.equal(big[0].start, 1)
  for (let i = 1; i < big.length; i++) assert.equal(big[i].start, big[i - 1].end + 1, `単位の間に隙間も重なりも無い: ${big[i - 1].id} → ${big[i].id}`)
  assert.equal(big[big.length - 1].end, lines.length, '最後の単位はファイルの終わり（最終行）まで')
  for (const u of big) {
    const t2 = textOf(paths['big.md'], u)
    assert.ok(bytes(t2) <= MAX, `${u.id} は ${bytes(t2)} バイトで上限 ${MAX} を超える`)
    assert.match(lines[u.start - 1], /^#{1,6}\s/, `${u.id} は見出しの行から始まる: ${lines[u.start - 1]}`)
    assert.ok(u.id.startsWith(`${paths['big.md']}#`), `分けた単位の id は <path>#<位置>: ${u.id}`)
  }
  assert.ok(big.some((u) => /^### S0-/.test(lines[u.start - 1])), '上の見出しの節がそれだけで収まらなければ、下の見出し（###）の境目で分ける')
  assert.equal(new Set(big.map((u) => u.id)).size, big.length, 'id は重ならない')
})

test('分ける（JS）: 収まらないファイルをトップレベルの宣言の境目で分け、各単位は UNIT_MAX_BYTES 以下・宣言の行から始まる', (t) => {
  const text = bigJs()
  assert.ok(bytes(text) > 2 * MAX)
  const { state, paths } = project(t, { 'big.mjs': text })
  const big = unitsOf(state).sort((a, b) => a.start - b.start)
  const lines = text.split('\n')
  assert.ok(big.length > 1 && big.length < 30, `宣言ごとに 1 単位まで細かく切らない: ${big.length}`)
  assert.equal(big[0].start, 1)
  for (let i = 1; i < big.length; i++) assert.equal(big[i].start, big[i - 1].end + 1)
  for (const u of big) {
    assert.ok(bytes(textOf(paths['big.mjs'], u)) <= MAX, u.id)
    assert.match(lines[u.start - 1], /^export function part\d+\(/, `${u.id} は宣言の行から始まる`)
  }
})

test('分けた単位の id と hash: 1 つの節を書き換えても、他の単位は同じ id と hash のまま。書き換えた節を含む単位だけ hash が変わる', (t) => {
  const text = bigMd()
  const { state, paths } = project(t, { 'big.md': text })
  const before = unitsOf(state)
  writeFileSync(paths['big.md'], text.replace('S7 の本文の行 0 は、', 'S7 の本文の行 0 が、'))
  const after = unitsOf(state)
  assert.deepEqual(after.map((u) => u.id), before.map((u) => u.id), '同じ大きさの書き換えで境目は動かない')
  const lines = readFileSync(paths['big.md'], 'utf8').split('\n')
  const changed = after.filter((u) => before.find((b) => b.id === u.id).hash !== u.hash)
  assert.equal(changed.length, 1, JSON.stringify(changed.map((u) => u.id)))
  assert.ok(lines.slice(changed[0].start - 1, changed[0].end).some((l) => l.startsWith('S7 の本文の行 0 が、')), '変わったのは書き換えた節を含む単位')
})

test('k（重ね）は無い: init の --k は受け付けない引数として終了状態 2 で拒否し、台帳を作らない', (t) => {
  const { d } = project(t, { 'a.md': SMALL_MD })
  const state = path.join(d, 'state-k')
  const r = run('init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'src', 'a.md'), '--goal-checked', 'coverage-build', '--k', '2')
  assert.equal(r.code, 2, JSON.stringify(r))
  assert.equal(run('status', '--state', state).code, 2, '台帳を作っていない')
})

// ---------------- phase.json ----------------
const phaseFile = (state) => path.join(state, 'phase.json')
function readPhase(state) {
  assert.ok(existsSync(phaseFile(state)), `stateDir/phase.json が無い: ${phaseFile(state)}`)
  return JSON.parse(readFileSync(phaseFile(state), 'utf8'))
}

test('phase.json: init は段（phase）と段の始まり（phase_start）を stateDir/phase.json に書く', (t) => {
  const { state } = project(t, { 'a.md': SMALL_MD }, { phase: 'design' })
  const p = readPhase(state)
  assert.equal(p.phase, 'design')
  assert.ok(p.phase_start && typeof p.phase_start === 'object' && !Array.isArray(p.phase_start), JSON.stringify(p))
})

test('phase.json: reframe は段と段の始まりを書き換える（段の始まりは reframe ごとに変わる）', (t) => {
  const { d, state, paths } = project(t, { 'a.md': SMALL_MD }, { phase: 'design' })
  const p1 = readPhase(state)
  const reframe = (phase) => run('reframe', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--criteria', path.join(d, 'criteria.md'), '--target', paths['a.md'], '--phase', phase)
  assert.equal(reframe('impl').code, 0)
  const p2 = readPhase(state)
  assert.equal(p2.phase, 'impl')
  assert.notDeepEqual(p2.phase_start, p1.phase_start)
  assert.equal(reframe('impl').code, 0, '同じ段を続けて reframe する')
  const p3 = readPhase(state)
  assert.equal(p3.phase, 'impl')
  assert.notDeepEqual(p3.phase_start, p2.phase_start, '同じ段の reframe でも段の始まりは変わる（coverage-build が二重の reframe を見分ける）')
})

test('phase.json: 拒否した reframe（--phase が無い）は phase.json を変えない', (t) => {
  const { d, state, paths } = project(t, { 'a.md': SMALL_MD }, { phase: 'design' })
  readPhase(state)
  const before = readFileSync(phaseFile(state), 'utf8')
  const r = run('reframe', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', paths['a.md'])
  assert.equal(r.code, 2)
  assert.equal(readFileSync(phaseFile(state), 'utf8'), before)
})
