// 設計の取り込み・写し・設計レビューへの渡し方（P5）: P3・P4 の欄を台帳に取り込み、設計の写し（_architecture.md・U<n>.md）に描き、
// 設計レビューの argv に --link を渡す。CLI の init → next → ingest を harness で流し、design/ の写し・台帳・audit の argv を見る。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { C, MAX_ATTEMPTS } from './build-core.mjs'
import { auditStatus, cli, drive, mockAgent, setup } from './test-harness.mjs'

const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8'))
const firstLine = (f) => readFileSync(f, 'utf8').split('\n').find((l) => l.trim().length >= 14) || readFileSync(f, 'utf8').trim()
const pairOf = (argv, k) => argv.slice(argv.indexOf(k), argv.indexOf(k) + 2)

const row = (value, producer_does, units) => ({ value, producer_does, handling: units.map((u) => ({ unit: u, does: `${u} は ${value} を${u === 'U2' ? '使う側として' : ''}扱う` })) })
// 方式設計の既定: U1（code）が作り、U2（code）が使う境界の約束が 2 つ。U3（doc）は U1 に依存するが、境界には関わらない。
function arch(mut = () => {}) {
  return (p, o) => {
    const a = {
      units: [
        { id: 'U1', kind: 'code', title: '計算', responsibility: '値を計算する', paths: ['src/a.mjs', 'src/old.mjs'], tests: ['test/a.test.mjs'], test_uses: [], depends_on: [], covers: ['AC1', 'D1'] },
        { id: 'U2', kind: 'code', title: '利用', responsibility: '計算の結果を使う', paths: ['src/b.mjs'], tests: ['test/b.test.mjs'], test_uses: ['src/a.mjs'], depends_on: ['U1'], covers: ['AC1', 'D1'] },
        { id: 'U3', kind: 'doc', title: '説明', responsibility: '使い方を書く', paths: ['docs/a.md'], tests: [], test_uses: [], depends_on: ['U1'], covers: ['AC1', 'D1'] },
      ],
      inputs_read: o.inputs.input_paths.map((f) => ({ path: f, quotes: [firstLine(f)] })),
      inputs_not_read: [],
      questions: [],
      contracts: [
        { id: 'X1', subject: '計算の結果', producer: 'U1', consumers: ['U2'], rows: [row('正常', '値を返す', ['U2']), row('失敗', 'null を返す', ['U2'])] },
        { id: 'X2', subject: '設定の既定', producer: 'U1', consumers: ['U2'], rows: [row('未設定', '既定を返す', ['U2'])] },
      ],
      copies: [{ id: 'C1', rule: '上限は 3', canonical: 'src/a.mjs', copies: ['docs/a.md'], check: 'test/a.test.mjs' }],
    }
    mut(a)
    return a
  }
}

// 詳細設計の既定: 全ての受け入れが振る舞いに結ばれ、境界の行は全てどれかの振る舞いが受け、ケースが分け方の全ての値を覆う。
const SPECS = {
  U1: () => ({
    unit_id: 'U1', spec: '入力を受け取り、決まった値を返す。', acceptance: ['値を返す', '失敗では null を返す'],
    behaviors: [{ text: '正常な入力では値を返す', accepts: [1], rows: ['X1-1', 'X2-1'] }, { text: '失敗では null を返す', accepts: [2], rows: ['X1-2'] }],
    partitions: [{ name: 'モード', values: ['fast', 'slow'] }],
    premises: [{ claim: '既存のファイルは 1 を持つ', path: 'src/old.mjs', quote: '既にあるファイルの本文の行' }],
    unverified: [{ claim: '外の部品が空を返す', if_broken: 'null として扱う' }],
    allowed_optional: [],
    cases: [{ condition: 'モードが fast で入力が 1', expect: '2 を返す', accepts: [1], covers: ['モード=fast'] }, { condition: 'モードが slow で入力が 0', expect: 'null を返す', accepts: [2], covers: ['モード=slow'] }],
  }),
  U2: () => ({
    unit_id: 'U2', spec: '計算の結果を使う側の扱いを決める。', acceptance: ['正常を使う', '失敗を使う'],
    behaviors: [{ text: '正常な値を使う', accepts: [1, 2], rows: ['X1-1', 'X2-1'] }, { text: '失敗は null として扱う', accepts: [2], rows: ['X1-2'] }],
    partitions: [], premises: [], unverified: [], allowed_optional: [],
    cases: [{ condition: 'U1 が値を返す', expect: '値を使う', accepts: [1], covers: [] }, { condition: 'U1 が null を返す', expect: 'null として扱う', accepts: [2], covers: [] }],
  }),
  U3: () => ({
    unit_id: 'U3', spec: '使い方を書く。担当は節を足してよい。', acceptance: ['使い方がある'],
    behaviors: [{ text: '使い方を書く', accepts: [1], rows: [] }],
    partitions: [], premises: [], unverified: [], allowed_optional: [{ quote: '担当は節を足してよい。', why: '役の権限を定める文' }],
    cases: [],
  }),
}
const designOf = (tweak = {}) => (p, opts) => {
  const id = /^design-(U\d+)/.exec(opts.label)[1]
  const r = SPECS[id]()
  if (tweak[id]) tweak[id](r)
  return r
}
const agentOf = ({ archMut, tweak } = {}) => mockAgent({ architect: arch(archMut), design: designOf(tweak) })
// 設計だけ流して台帳を返す（目標の照合 → 方式設計 → 詳細設計の 3 つの呼び出し）。ingest は詳細設計の呼び出しを閉じた出力。
async function designOnly(t, opts = {}) {
  const s = setup(t)
  const { steps } = await drive(s.state, agentOf(opts), { maxSteps: 3 })
  const spec = steps.find((x) => x.task === 'spec') || steps.at(-1)
  return { ...s, steps, L: ledger(s.state), ingest: spec.ingest }
}
// 設計の写しを書かせる（next は設計の写しを台帳から書いてから、設計レビューの段を返す）。
async function rendered(t) {
  const r = await designOnly(t)
  assert.equal(r.ingest.code, 0, JSON.stringify(r.ingest))
  assert.ok(!r.ingest.rejected, JSON.stringify(r.ingest.rejected))
  const n = cli('next', '--state', r.state)
  assert.equal(n.code, 0, JSON.stringify(n))
  const read = (f) => readFileSync(path.join(r.state, 'design', f), 'utf8')
  return { ...r, next: n, arch: read('_architecture.md'), unit: (id) => read(`${id}.md`) }
}
const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim())
const isSep = (l) => /^\|[-| :]+\|$/.test(l.trim())

// ---------------- 1. 取り込み ----------------
test('取り込み: contracts・copies を L.arch に、test_uses を単位に持つ', async (t) => {
  const { L, ingest } = await designOnly(t)
  assert.equal(ingest.code, 0, JSON.stringify(ingest))
  assert.ok(!ingest.rejected, JSON.stringify(ingest.rejected))
  assert.deepEqual(L.arch.contracts.map((c) => [c.id, c.subject, c.producer, c.consumers]), [['X1', '計算の結果', 'U1', ['U2']], ['X2', '設定の既定', 'U1', ['U2']]])
  assert.deepEqual(L.arch.contracts[0].rows.map((r) => [r.value, r.producer_does, r.handling]), [
    ['正常', '値を返す', [{ unit: 'U2', does: 'U2 は 正常 を使う側として扱う' }]],
    ['失敗', 'null を返す', [{ unit: 'U2', does: 'U2 は 失敗 を使う側として扱う' }]],
  ])
  assert.deepEqual(L.arch.copies.map((c) => [c.id, c.rule, c.canonical, c.copies, c.check]), [['C1', '上限は 3', 'src/a.mjs', ['docs/a.md'], 'test/a.test.mjs']])
  assert.deepEqual([L.units.U1.test_uses, L.units.U2.test_uses, L.units.U3.test_uses], [[], ['src/a.mjs'], []])
})

test('取り込み: 詳細設計の behaviors・partitions・premises・unverified・allowed_optional と、cases の accepts・covers を単位に持つ', async (t) => {
  const { L } = await designOnly(t)
  const u1 = L.units.U1
  assert.deepEqual(u1.behaviors, SPECS.U1().behaviors)
  assert.deepEqual(u1.partitions, SPECS.U1().partitions)
  assert.deepEqual(u1.premises, SPECS.U1().premises)
  assert.deepEqual(u1.unverified, SPECS.U1().unverified)
  assert.deepEqual(u1.cases.map((c) => [c.condition, c.expect, c.accepts, c.covers]), SPECS.U1().cases.map((c) => [c.condition, c.expect, c.accepts, c.covers]))
  assert.deepEqual(L.units.U3.allowed_optional, SPECS.U3().allowed_optional)
  assert.deepEqual(L.units.U2.behaviors.map((b) => b.accepts), [[1, 2], [2]])
  assert.ok(Object.values(L.units).every((u) => u.design_hash && !u.need_design))
})

test('取り込み: 境界の行を受ける振る舞いが無い・自分の行でない行を指す・受け入れが振る舞いに結ばれない詳細設計は受け付けない（行 id は台帳の contracts から作る）', async (t) => {
  const cases = {
    '作る側が行 X1-2 を受ける振る舞いを持たない': { U1: (r) => { r.behaviors[1].rows = [] } },
    '使う側が存在しない行 X1-9 を指す': { U2: (r) => { r.behaviors[0].rows = ['X1-1', 'X2-1', 'X1-9'] } },
    '境界に関わらない単位が他の約束の行を指す': { U3: (r) => { r.behaviors[0].rows = ['X1-1'] } },
    '振る舞いに結ばれない受け入れがある': { U1: (r) => { r.behaviors[1].accepts = [1] } },
  }
  for (const [name, tweak] of Object.entries(cases)) {
    const { L, ingest } = await designOnly(t, { tweak })
    const id = Object.keys(tweak)[0]
    assert.equal(ingest.code, 0, name)
    assert.equal(ingest.rejected.length, MAX_ATTEMPTS, `${name}: 同じ体が上限まで出し直し、どれも拒む: ${JSON.stringify(ingest.rejected)}`)
    assert.equal(L.units[id].need_design, true, `${name}: 受け付けない`)
    assert.equal(L.attempts[`design:${id}`], MAX_ATTEMPTS, `${name}: 試行に数える`)
    const others = Object.keys(L.units).filter((x) => x !== id)
    assert.ok(others.every((x) => L.units[x].need_design === false), `${name}: ほかの単位は受け付ける`)
  }
})

test('取り込み: premises の path が読めないか、引用が本文に合わなければ rejected_output にして試行に数える', async (t) => {
  const bad = {
    '入力・対象・単位のファイルのどれでもない絶対 path': { path: '/etc/hosts', quote: 'localhost の行を引く文' },
    '単位が持つがまだ無いファイル': { path: 'src/a.mjs', quote: 'export const value = 2' },
    '本文に逐語で無い引用': { path: 'src/old.mjs', quote: 'このファイルに無い文である。ほげほげ' },
  }
  for (const [name, prem] of Object.entries(bad)) {
    const tweak = { U1: (r) => { r.premises = [{ claim: '前提', ...prem }] } }
    const { L, ingest } = await designOnly(t, { tweak })
    assert.equal(ingest.code, 0, name)
    assert.equal(ingest.rejected.length, MAX_ATTEMPTS, `${name}: ${JSON.stringify(ingest.rejected)}`)
    assert.equal(L.units.U1.need_design, true, name)
    assert.equal(L.attempts['design:U1'], MAX_ATTEMPTS, name)
    assert.ok(L.events.some((e) => e.kind === 'rejected_output' && e.unit === 'U1'), name)
    assert.ok(L.units.U2.design_hash && L.units.U3.design_hash, `${name}: ほかの単位は受け付ける`)
  }
})

test('取り込み: premises は入力（絶対 path）と、単位が持つ既にあるファイル（repo からの相対 path）の逐語の引用なら受け付ける', async (t) => {
  const s = setup(t)
  const material = path.join(s.d, 'material.md')
  const tweak = { U1: (r) => { r.premises = [...r.premises, { claim: '材料は 1 を足す', path: material, quote: '値は入力に 1 を足して返す。' }] } }
  const { steps } = await drive(s.state, agentOf({ tweak }), { maxSteps: 3 })
  for (const x of steps) assert.equal(x.ingest.code, 0, JSON.stringify(x.ingest))
  for (const x of steps) assert.ok(!x.ingest.rejected, JSON.stringify(x.ingest.rejected))
  const L = ledger(s.state)
  assert.equal(L.units.U1.premises.length, 2)
  assert.equal(L.units.U1.need_design, false)
})

// ---------------- 2. designHash ----------------
async function hashes(t, opts) {
  const { L, ingest } = await designOnly(t, opts)
  assert.ok(ingest.code === 0 && !ingest.rejected, JSON.stringify(ingest))
  return Object.fromEntries(Object.entries(L.units).map(([id, u]) => [id, u.design_hash]))
}

test('designHash: 同じ設計は同じ、behaviors・partitions・premises・unverified・allowed_optional のどれが変わっても変わる', async (t) => {
  const base = await hashes(t)
  assert.ok(Object.values(base).every(Boolean))
  assert.deepEqual(await hashes(t), base, '同じ設計なら hash は同じ')
  const diff = {
    behaviors: { U1: (r) => { r.behaviors[0].text = '正常な入力では別の値を返す' } },
    partitions: { U1: (r) => { r.partitions[0].values = ['slow', 'fast'] } },
    premises: { U1: (r) => { r.premises[0].claim = '既存のファイルは別のことを前提にする' } },
    unverified: { U1: (r) => { r.unverified[0].if_broken = '例外として扱う' } },
    allowed_optional: { U3: (r) => { r.allowed_optional[0].why = '別の理由' } },
  }
  for (const [k, tweak] of Object.entries(diff)) {
    const id = Object.keys(tweak)[0]
    const h = await hashes(t, { tweak })
    assert.notEqual(h[id], base[id], `${k} が変わったら ${id} の hash が変わる`)
    for (const o of Object.keys(base).filter((x) => x !== id)) assert.equal(h[o], base[o], `${k}: ${o} の hash は変わらない`)
  }
})

test('designHash: その単位が producer か consumer の境界の行が変われば変わり、関わらない単位は変わらない', async (t) => {
  const base = await hashes(t)
  const producer = await hashes(t, { archMut: (a) => { a.contracts[0].rows[0].producer_does = '別の値を返す' } })
  assert.notEqual(producer.U1, base.U1, '作る側')
  assert.notEqual(producer.U2, base.U2, '使う側')
  assert.equal(producer.U3, base.U3, '境界に関わらない単位')
  const handling = await hashes(t, { archMut: (a) => { a.contracts[1].rows[0].handling[0].does = 'U2 は 未設定 を無視する' } })
  assert.notEqual(handling.U1, base.U1)
  assert.notEqual(handling.U2, base.U2)
  assert.equal(handling.U3, base.U3)
})

// ---------------- 3. _architecture.md ----------------
test('_architecture.md: 単位の表に「テストが前提にするもの」の列を持ち、test_uses を描く', async (t) => {
  const { arch } = await rendered(t)
  const lines = arch.split('\n')
  const head = lines.find((l) => l.startsWith('| 単位 |'))
  assert.ok(head, '単位の表')
  const col = cells(head).findIndex((c) => c.includes('テストが前提にするもの'))
  assert.ok(col >= 0, `列が無い: ${head}`)
  const u2 = lines.find((l) => l.startsWith('| U2 '))
  assert.ok(cells(u2)[col].includes('src/a.mjs'), `U2 のテストが前提にするもの: ${u2}`)
  assert.ok(lines.some((l) => l.startsWith('| U1 計算 | code | 値を計算する |')), '既存の列は今のまま')
})

test('_architecture.md: 単位の表に続けて、照合の不変条件を 1 行 1 件で描く', async (t) => {
  const { arch } = await rendered(t)
  const lines = arch.split('\n')
  const at = lines.findIndex((l) => l.includes('方式設計の照合が保証すること'))
  assert.ok(at > lines.findIndex((l) => l.startsWith('| 単位 |')), '単位の表の後')
  assert.equal(C.ARCH_INVARIANTS.length, 6)
  for (const inv of C.ARCH_INVARIANTS) {
    const i = lines.findIndex((l) => l.replace(/^\s*[-*]\s+/, '').trim() === inv)
    assert.ok(i > at, `不変条件が 1 行で無い: ${inv}`)
  }
})

test('_architecture.md: contracts を 1 件ごとに見出しと表 1 つで描く（行 id・値・作る側・使う単位ごとの扱い）', async (t) => {
  const { arch } = await rendered(t)
  const lines = arch.split('\n')
  const tableAt = lines.findIndex((l) => l.startsWith('| 単位 |'))
  const blockOf = (head) => {
    const i = lines.findIndex((l) => /^#+\s/.test(l) && l.includes(head))
    assert.ok(i > tableAt, `見出しが単位の表の後に無い: ${head}`)
    const rest = lines.slice(i + 1)
    const end = rest.findIndex((l) => /^#/.test(l))
    return end < 0 ? rest : rest.slice(0, end)
  }
  // 見出しの下の最初の表（続く '|' の行）。
  const tableOf = (block) => { const i = block.findIndex((l) => l.startsWith('|')); assert.ok(i >= 0, '表が無い'); const rest = block.slice(i); const e = rest.findIndex((l) => !l.startsWith('|')); return e < 0 ? rest : rest.slice(0, e) }
  const b1 = blockOf('X1: 計算の結果（U1 → U2）')
  const b2 = tableOf(blockOf('X2: 設定の既定（U1 → U2）'))
  const t1 = tableOf(b1)
  assert.equal(t1.filter(isSep).length, 1, '表は 1 つ')
  assert.equal(b2.filter(isSep).length, 1, '表は 1 つ')
  assert.ok(!b1.slice(b1.indexOf(t1[0]) + t1.length).some((l) => l.startsWith('|')), '1 つの約束に表は 1 つだけ')
  const header = cells(t1[0])
  assert.equal(header.length, 4, JSON.stringify(header))
  assert.ok(header[0].includes('id') && header[1].includes('値') && header[2].includes('作る側') && header[3].includes('扱い'), JSON.stringify(header))
  const r = (b, id) => { const l = b.filter((x) => x.startsWith(`| ${id} `)); assert.equal(l.length, 1, `行 ${id}`); return cells(l[0]) }
  const x11 = r(t1, 'X1-1')
  assert.ok(x11[1].includes('正常') && x11[2].includes('値を返す') && x11[3].includes('U2') && x11[3].includes('U2 は 正常 を使う側として扱う'), JSON.stringify(x11))
  const x12 = r(t1, 'X1-2')
  assert.ok(x12[1].includes('失敗') && x12[2].includes('null を返す') && x12[3].includes('U2 は 失敗 を使う側として扱う'), JSON.stringify(x12))
  const x21 = r(b2, 'X2-1')
  assert.ok(x21[1].includes('未設定') && x21[2].includes('既定を返す'), JSON.stringify(x21))
})

test('_architecture.md: copies を表 1 つで描く（id・規則・正本・写し・一致を照らすテスト）', async (t) => {
  const { arch } = await rendered(t)
  const lines = arch.split('\n')
  const head = lines.find((l) => l.startsWith('|') && l.includes('正本') && l.includes('写し'))
  assert.ok(head, '写しの表')
  const h = cells(head)
  assert.equal(h.length, 5, JSON.stringify(h))
  assert.ok(h[0].includes('id') && h[1].includes('規則') && h[2].includes('正本') && h[3].includes('写し') && h[4].includes('テスト'), JSON.stringify(h))
  assert.ok(lines.indexOf(head) > lines.findIndex((l) => l.startsWith('| 単位 |')), '単位の表の後')
  const c = lines.filter((l) => l.startsWith('| C1 '))
  assert.equal(c.length, 1)
  const x = cells(c[0])
  assert.deepEqual([x[1], x[2], x[3], x[4]], ['上限は 3', 'src/a.mjs', 'docs/a.md', 'test/a.test.mjs'])
})

// ---------------- 4. U<n>.md ----------------
test('U<n>.md: 仕様の後に、振る舞いを id・受け入れ・境界の行つきで 1 行ずつ描く', async (t) => {
  const { unit } = await rendered(t)
  const u1 = unit('U1')
  assert.ok(u1.includes('- U1S1: 正常な入力では値を返す（受け入れ: U1A1／境界: X1-1, X2-1）'), u1)
  assert.ok(u1.includes('- U1S2: 失敗では null を返す（受け入れ: U1A2／境界: X1-2）'), u1)
  assert.ok(u1.indexOf('入力を受け取り、決まった値を返す。') < u1.indexOf('- U1S1:'), '仕様の後')
  const u2 = unit('U2')
  assert.ok(u2.includes('- U2S1: 正常な値を使う（受け入れ: U2A1, U2A2／境界: X1-1, X2-1）'), u2)
  assert.ok(unit('U3').includes('- U3S1: 使い方を書く（受け入れ: U3A1'), unit('U3'))
  assert.match(u1, /- U1A1: 値を返す/, '受け入れの行は今のまま')
})

test('U<n>.md: ケースの表は id・条件・期待・受け入れ・分け方の列を持つ', async (t) => {
  const { unit } = await rendered(t)
  const lines = unit('U1').split('\n')
  const head = lines.find((l) => l.startsWith('|') && l.includes('条件') && l.includes('期待'))
  assert.ok(head, 'ケースの表')
  const h = cells(head)
  assert.equal(h.length, 5, JSON.stringify(h))
  assert.ok(/id/i.test(h[0]) && h[1].includes('条件') && h[2].includes('期待') && h[3].includes('受け入れ') && h[4].includes('分け方'), JSON.stringify(h))
  const c1 = cells(lines.find((l) => l.startsWith('| U1C1 ')))
  assert.deepEqual([c1[1], c1[2]], ['モードが fast で入力が 1', '2 を返す'])
  assert.ok(c1[3].includes('U1A1') && !c1[3].includes('U1A2'), JSON.stringify(c1))
  assert.ok(c1[4].includes('モード') && c1[4].includes('fast') && !c1[4].includes('slow'), JSON.stringify(c1))
  const c2 = cells(lines.find((l) => l.startsWith('| U1C2 ')))
  assert.ok(c2[3].includes('U1A2') && c2[4].includes('slow'), JSON.stringify(c2))
})

test('U<n>.md: 分け方・前提・確かめていない前提・決めきらない語を残した箇所を描く', async (t) => {
  const { unit } = await rendered(t)
  const u1 = unit('U1')
  assert.ok(u1.includes('- モード: fast / slow'), u1)
  assert.ok(u1.includes('- 既存のファイルは 1 を持つ（src/old.mjs: 「既にあるファイルの本文の行」）'), u1)
  assert.ok(u1.includes('- 外の部品が空を返す → 崩れたとき: null として扱う'), u1)
  assert.ok(unit('U3').includes('- 「担当は節を足してよい。」: 役の権限を定める文'), unit('U3'))
})

// ---------------- 5. 詳細設計だけのやり直しの rows ----------------
test('詳細設計だけをやり直す担当の query の inputs.rows に、その単位が関わる境界の行 id の配列を載せ、args には文も rows も載せない', async (t) => {
  const { state } = setup(t)
  let n = 0
  const audit = (phase) => (phase === 'design' && n++ === 0 ? auditStatus({ phase, confirmed: [{ path: path.join(state, 'design', 'U1.md'), quote: '入力を受け取り、決まった値を返す。', layer: '詳細設計' }] }) : auditStatus({ phase }))
  const log = []
  const { stop, steps } = await drive(state, mockAgent({ architect: arch(), design: designOf() }, log), { audit })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.equal(steps.filter((s) => s.task === 'arch').length, 1, '方式設計はやり直さない')
  const specs = steps.filter((s) => s.task === 'spec')
  assert.equal(specs.length, 2)
  const redo = log.filter((x) => x.role === 'unit_designer').slice(3)
  assert.deepEqual(redo.map((x) => x.inputs.unit.id), ['U1', 'U2', 'U3'])
  const rowsOf = (id) => [...redo.find((x) => x.inputs.unit.id === id).inputs.rows].sort()
  assert.deepEqual(rowsOf('U1'), ['X1-1', 'X1-2', 'X2-1'])
  assert.deepEqual(rowsOf('U2'), ['X1-1', 'X1-2', 'X2-1'])
  assert.deepEqual(rowsOf('U3'), [], '境界に関わらない単位は空の配列')
  const text = JSON.stringify(specs[1].args)
  for (const w of ['計算の結果', '設定の既定', '使う側として扱う', '値を返す', 'X1-1']) assert.ok(!text.includes(w), `args に文と行 id を載せない: ${w}`)
  assert.equal(ledger(state).units.U1.rounds, 1)
})

// ---------------- 6. load の拒否 ----------------
test('台帳に L.arch があって L.arch.contracts が配列でなければ、台帳の形式が古いとして拒否する', async (t) => {
  const { state } = await designOnly(t)
  const file = path.join(state, 'build.json')
  const L = ledger(state)
  assert.ok(Array.isArray(L.arch.contracts))
  delete L.arch.contracts
  writeFileSync(file, JSON.stringify(L))
  for (const argv of [['next', '--state', state], ['status', '--state', state]]) {
    const r = cli(...argv)
    assert.equal(r.code, 2, `${argv[0]}: ${JSON.stringify(r)}`)
    assert.match(r.error, /台帳の形式が古い（方式設計が境界の約束を持たない）/)
    assert.match(r.error, /新しい stateDir で init からやり直す/)
  }
})

test('L.arch が無い台帳（方式設計の前）は拒否しない', (t) => {
  const { state } = setup(t)
  assert.equal(ledger(state).arch, null)
  assert.equal(cli('status', '--state', state).code, 0)
  assert.equal(cli('next', '--state', state).code, 0)
})

// ---------------- 7. 設計レビューへの --link と frame ----------------
// 書き換え（波の形）: 検査の入力は argv で返さず、CLI が同じ process で coverage-audit の台帳を init・reframe する。
// 偽の検査の計画役が担当を取るたびに（検査の 1 回ごとに）、検査の台帳の段・link・目標の冒頭の文を残す。findingOnce なら最初の設計レビューで U1.md に指摘を 1 件出す。
function recorder(state, seen, { findingOnce = false } = {}) {
  let n = 0
  const key = new Set()
  const auditOver = {
    plan: () => {
      const AL = JSON.parse(readFileSync(path.join(state, 'audit', 'state', 'ledger.json'), 'utf8'))
      const k = JSON.stringify([AL.phase, AL.phase_start])
      if (!key.has(k)) { key.add(k); seen.push({ phase: AL.phase, link: AL.link ?? null, goal: AL.goal.text }) }
      return undefined
    },
  }
  const audit = (phase) => (findingOnce && phase === 'design' && n++ === 0
    ? auditStatus({ phase, confirmed: [{ path: path.join(state, 'design', 'U1.md'), quote: '入力を受け取り、決まった値を返す。', layer: '詳細設計' }] })
    : auditStatus({ phase }))
  return { audit, auditOver }
}

test('設計レビュー: init と reframe で link に C.LINK_PATTERN を置き、実装レビューでは置かない', async (t) => {
  const { state } = setup(t)
  const seen = []
  const { stop } = await drive(state, agentOf(), recorder(state, seen, { findingOnce: true }))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(seen.map((x) => x.phase), ['design', 'design', 'impl'])
  for (const x of seen.filter((s) => s.phase === 'design')) assert.equal(x.link, C.LINK_PATTERN)
  assert.equal(seen.find((x) => x.phase === 'impl').link, null, '実装レビューの reframe は link を持たない（link は枠の一部で null に戻る）')
  assert.equal(typeof C.LINK_PATTERN, 'string')
  const re = new RegExp(C.LINK_PATTERN, 'g')
  assert.deepEqual('X1-2 と U1A3 と U2S1 と X1'.match(re), ['X1-2', 'U1A3', 'U2S1'])
})

test('現状の検査・review の台帳には link を置かない', async (t) => {
  for (const [mode, phase] of [['update', 'baseline'], ['review', 'review']]) {
    const { state } = setup(t, { mode })
    const seen = []
    await drive(state, mockAgent(), { ...recorder(state, seen), maxSteps: 3 })
    assert.equal(seen[0] && seen[0].phase, phase, JSON.stringify(seen))
    assert.equal(seen[0].link, null, phase)
  }
})

test('設計レビューの frame に、境界の表と行 id・照らし済みの 2 文を足す。ほかの段には足さない', async (t) => {
  const { state } = setup(t)
  const seen = []
  const { stop } = await drive(state, agentOf(), recorder(state, seen))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const S1 = '単位をまたぐ扱いは `_architecture.md` の境界の表にあり、設計の文書は行 id（`X<n>-<k>`）でそれを指す。'
  const S2 = '前提の引用と照合の不変条件は script が照らし済みである。'
  assert.ok(seen.some((x) => x.phase === 'design') && seen.some((x) => x.phase === 'impl'), `設計レビューと実装レビューの検査の台帳を見た: ${JSON.stringify(seen.map((x) => x.phase))}`)
  const design = seen.find((x) => x.phase === 'design').goal
  assert.ok(design.includes(S1), design)
  assert.ok(design.includes(S2), design)
  const impl = seen.find((x) => x.phase === 'impl').goal
  assert.ok(!impl.includes(S1) && !impl.includes(S2), impl)
})
