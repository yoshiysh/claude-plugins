// 方式設計の返り値の形（P3）: 境界の決定表（contracts）・正本と写し（copies）・単位のテストの前提（test_uses）と、
// checkArch が保証する不変条件（ARCH_INVARIANTS）・id の形（LINK_PATTERN）。checkArch は build-core.mjs の C を直接呼ぶ。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { C } from './build-core.mjs'
import { drive, mockAgent, setup, tmp } from './test-harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STEP_SRC = readFileSync(path.join(HERE, 'build-step.js'), 'utf8')
const CHECKS = STEP_SRC.slice(STEP_SRC.indexOf('// <checks>'), STEP_SRC.indexOf('// </checks>'))

const ctx = { coverIds: ['AC1'], inputs: [] }
const unit = (o) => ({ title: 't', responsibility: 'r', tests: [], test_uses: [], depends_on: [], covers: ['AC1'], ...o })
const row = (value, producer_does, units) => ({ value, producer_does, handling: units.map((u) => ({ unit: u, does: `${u} は ${value} を扱う` })) })
// 全ての不変条件を満たす基準の返り値。U1（code）が作り、U2（code）と U3（doc、U2 に依存。U1 へは推移的に依存）が使う。
const base = () => ({
  units: [
    unit({ id: 'U1', kind: 'code', paths: ['src/a.mjs'], tests: ['test/a.test.mjs'] }),
    unit({ id: 'U2', kind: 'code', paths: ['src/b.mjs'], tests: ['test/b.test.mjs'], test_uses: ['src/a.mjs', 'tools/run.mjs'], depends_on: ['U1'] }),
    unit({ id: 'U3', kind: 'doc', paths: ['docs/a.md'], depends_on: ['U2'] }),
  ],
  inputs_read: [],
  inputs_not_read: [],
  questions: [],
  contracts: [
    { id: 'X1', subject: '計算の結果', producer: 'U1', consumers: ['U2', 'U3'], rows: [row('正常', '値を返す', ['U2', 'U3']), row('失敗', 'null を返す', ['U2', 'U3'])] },
    { id: 'X2', subject: '設定', producer: 'U1', consumers: ['U2'], rows: [row('正常', '既定を返す', ['U2'])] },
  ],
  copies: [{ id: 'C1', rule: '上限は 3', canonical: 'src/a.mjs', copies: ['docs/a.md'], check: 'test/a.test.mjs' }],
})
const mutated = (mut) => { const a = base(); mut(a); return a }
const problems = (mut) => C.checkArch(mutated(mut), ctx)
const setConsumers = (c, ids) => { c.consumers = ids; c.rows.forEach((r) => { r.handling = ids.map((u) => ({ unit: u, does: `${u} の扱い` })) }) }

// 入力 1 つで 1 つの決まりを破る。基準の返り値は欠けが無いので、欠けが出れば破った決まりのせい。
function breaking(group, cases) {
  for (const [name, mut] of Object.entries(cases)) {
    test(`${group}: ${name}なら欠けを返す`, () => {
      const p = problems(mut)
      assert.ok(p.length > 0, `欠けが返らなかった: ${name}`)
    })
  }
}
function passing(group, cases) {
  for (const [name, mut] of Object.entries(cases)) {
    test(`${group}: ${name}は受け付ける`, () => {
      assert.deepEqual(problems(mut), [])
    })
  }
}

test('基準の返り値（contracts・copies・test_uses を持つ）は欠け無しで通る', () => {
  assert.deepEqual(C.checkArch(base(), ctx), [])
})

// ---------------- 1. 欄（ARCH_SCHEMA と必須の配列） ----------------
test('ARCH_SCHEMA: contracts・copies を必須の配列に、単位は test_uses を必須の配列に持つ。行の id は返り値に持たせない', async (t) => {
  const { state } = setup(t)
  let schema = null
  const over = { architect: (p, opts) => { schema = opts.schema; return undefined } }
  await drive(state, mockAgent(over), { maxSteps: 1 })
  assert.ok(schema, '方式設計の役に schema が渡る')
  for (const k of ['units', 'inputs_read', 'inputs_not_read', 'questions', 'contracts', 'copies']) assert.ok(schema.required.includes(k), `${k} が必須`)
  assert.equal(schema.properties.contracts.type, 'array')
  assert.equal(schema.properties.copies.type, 'array')
  const u = schema.properties.units.items
  assert.ok(u.required.includes('test_uses'), 'test_uses が必須')
  assert.equal(u.properties.test_uses.type, 'array')
  assert.equal(u.properties.test_uses.items.type, 'string')
  const c = schema.properties.contracts.items
  assert.deepEqual([...c.required].sort(), ['consumers', 'id', 'producer', 'rows', 'subject'])
  assert.equal(c.properties.consumers.type, 'array')
  const r = c.properties.rows.items
  assert.deepEqual([...r.required].sort(), ['handling', 'producer_does', 'value'])
  assert.ok(!('id' in r.properties), '行の id（X<n>-<k>）は位置から決め、返り値には持たせない')
  const h = r.properties.handling.items
  assert.deepEqual([...h.required].sort(), ['does', 'unit'])
  const cp = schema.properties.copies.items
  assert.deepEqual([...cp.required].sort(), ['canonical', 'check', 'copies', 'id', 'rule'])
  assert.equal(cp.properties.copies.type, 'array')
})

test('既定の mockAgent の方式設計は contracts・copies・各単位の test_uses を空の配列で返し、checkArch を通る', async (t) => {
  const d = tmp(t)
  const material = path.join(d, 'material.md')
  writeFileSync(material, '材料の本文の行。値は入力に 1 を足して返す。\n')
  const briefPath = path.join(d, 'brief.md')
  writeFileSync(briefPath, `## 受け入れ基準\n- AC1: 値を返す\n## 固定した制約\n- D1: 依存を足さない\n## 入力\n- ${material}\n`)
  const r = await mockAgent()(`まず Read で ${briefPath} を全て読む`, { label: 'architect' })
  assert.deepEqual(r.contracts, [])
  assert.deepEqual(r.copies, [])
  assert.ok(r.units.every((u) => Array.isArray(u.test_uses) && u.test_uses.length === 0))
  assert.deepEqual(C.checkArch(r, { coverIds: ['AC1', 'D1'], inputs: [material] }), [])
})

for (const key of ['contracts', 'copies']) {
  breaking(`欄（${key}）`, {
    [`${key} が無い`]: (a) => { delete a[key] },
    [`${key} が null`]: (a) => { a[key] = null },
    [`${key} が文字列`]: (a) => { a[key] = 'x' },
    [`${key} が配列でない object`]: (a) => { a[key] = {} },
  })
  passing(`欄（${key}）`, { [`${key} が空の配列`]: (a) => { a[key] = [] } })
}
for (const id of ['U1', 'U3']) {
  const i = id === 'U1' ? 0 : 2
  breaking(`欄（${id} の test_uses）`, {
    'test_uses が無い': (a) => { delete a.units[i].test_uses },
    'test_uses が null': (a) => { a.units[i].test_uses = null },
    'test_uses が文字列': (a) => { a.units[i].test_uses = 'x' },
    'test_uses が配列でない object': (a) => { a.units[i].test_uses = {} },
  })
}
passing('欄（test_uses）', { '全ての単位の test_uses が空の配列': (a) => { a.units.forEach((u) => { u.test_uses = [] }) } })

// ---------------- 2. contracts（境界の決定表） ----------------
breaking('contracts', {
  'id が X<数> でない（Y1）': (a) => { a.contracts[0].id = 'Y1' },
  'id が X だけ': (a) => { a.contracts[0].id = 'X' },
  'id が行の形（X1-1）': (a) => { a.contracts[0].id = 'X1-1' },
  'id が空': (a) => { a.contracts[0].id = '' },
  'id が重複': (a) => { a.contracts[1].id = 'X1' },
  'subject が空': (a) => { a.contracts[0].subject = '' },
  'subject が空白だけ': (a) => { a.contracts[0].subject = '  ' },
  'producer が実在しない単位': (a) => { a.contracts[0].producer = 'U9' },
  'producer が空': (a) => { a.contracts[0].producer = '' },
  'consumers が空': (a) => { setConsumers(a.contracts[0], []) },
  'consumers が実在しない単位を含む': (a) => { setConsumers(a.contracts[0], ['U2', 'U9']) },
  'consumers が producer を含む': (a) => { setConsumers(a.contracts[0], ['U1', 'U2']) },
  'consumers が重複を含む': (a) => { a.contracts[0].consumers = ['U2', 'U2', 'U3'] },
  'consumers の単位の依存の閉包に producer が無い（作る側 U2 を使う側 U1 が使う）': (a) => { a.contracts[1].producer = 'U2'; setConsumers(a.contracts[1], ['U1']) },
  'consumers の単位が producer へ逆向きに依存している（作る側 U3 を使う側 U2 が使う）': (a) => { a.contracts[1].producer = 'U3'; setConsumers(a.contracts[1], ['U2']) },
  'rows が空': (a) => { a.contracts[0].rows = [] },
  'rows が配列でない': (a) => { a.contracts[0].rows = null },
  '行の value が空': (a) => { a.contracts[0].rows[0].value = '' },
  '行の producer_does が空': (a) => { a.contracts[0].rows[1].producer_does = '' },
  '同じ contract の中で value が重複': (a) => { a.contracts[0].rows[1].value = '正常' },
  '行の handling が使う単位を 1 つ欠く': (a) => { a.contracts[0].rows[0].handling = a.contracts[0].rows[0].handling.filter((h) => h.unit !== 'U3') },
  '行の handling が全て空': (a) => { a.contracts[0].rows[1].handling = [] },
  '行の handling が同じ単位を 2 回持つ': (a) => { a.contracts[0].rows[0].handling.push({ unit: 'U2', does: '重ねた扱い' }) },
  '行の handling が同じ単位を 2 回持ち、別の単位を欠く': (a) => { a.contracts[0].rows[0].handling = [{ unit: 'U2', does: 'a' }, { unit: 'U2', does: 'b' }] },
  '行の handling が使う単位でない単位を持つ': (a) => { a.contracts[1].rows[0].handling.push({ unit: 'U3', does: '使わない単位の扱い' }) },
  '行の handling が実在しない単位を持つ': (a) => { a.contracts[1].rows[0].handling[0].unit = 'U9' },
  '行の handling の does が空': (a) => { a.contracts[0].rows[0].handling[1].does = '' },
  '行の handling が配列でない': (a) => { delete a.contracts[0].rows[0].handling },
})
passing('contracts', {
  '使う側が作る側へ推移的に依存する（U3 → U2 → U1）': () => {},
  '別の contract で同じ value を使う': () => {},
  'consumers の並びと handling の並びが違う': (a) => { a.contracts[0].rows[0].handling.reverse() },
  '使う側が doc の単位': (a) => { a.contracts[1].producer = 'U1'; setConsumers(a.contracts[1], ['U3']) },
  '3 件目の contract（作る側 U2、使う側 U3）': (a) => { a.contracts.push({ id: 'X3', subject: '二つ目', producer: 'U2', consumers: ['U3'], rows: [row('正常', '返す', ['U3'])] }) },
})

// ---------------- 3. copies（正本と写し） ----------------
breaking('copies', {
  'id が C<数> でない（X1）': (a) => { a.copies[0].id = 'X1' },
  'id が C だけ': (a) => { a.copies[0].id = 'C' },
  'id が空': (a) => { a.copies[0].id = '' },
  'id が重複': (a) => { a.copies.push({ ...a.copies[0], copies: ['src/b.mjs'] }) },
  'rule が空': (a) => { a.copies[0].rule = '' },
  'rule が空白だけ': (a) => { a.copies[0].rule = ' ' },
  'canonical が絶対 path': (a) => { a.copies[0].canonical = '/abs/a.mjs' },
  'canonical が .. を含む': (a) => { a.copies[0].canonical = 'a/../b.mjs' },
  'canonical が空': (a) => { a.copies[0].canonical = '' },
  'copies の要素が絶対 path': (a) => { a.copies[0].copies = ['/abs/a.md'] },
  'copies の要素が .. を含む': (a) => { a.copies[0].copies = ['docs/a.md', 'a/../b.md'] },
  'check が絶対 path': (a) => { a.copies[0].check = '/abs/t.test.mjs' },
  'check が .. を含む': (a) => { a.copies[0].check = 'a/../t.test.mjs' },
  'check が空': (a) => { a.copies[0].check = '' },
  'copies が空': (a) => { a.copies[0].copies = [] },
  'copies が canonical を含む': (a) => { a.copies[0].copies = ['docs/a.md', 'src/a.mjs'] },
  'check がどの単位の tests にも test_uses にも無い': (a) => { a.copies[0].check = 'test/zzz.test.mjs' },
  'check が単位の paths にだけある（テストでない）': (a) => { a.copies[0].check = 'src/b.mjs' },
})
passing('copies', {
  'check が単位の tests にある': (a) => { a.copies[0].check = 'test/b.test.mjs' },
  'check が既にあるテストで、それを前提にする単位の test_uses に挙げてある': (a) => { a.copies[0].check = 'tools/run.mjs' },
  '写しが 2 つ': (a) => { a.copies[0].copies = ['docs/a.md', 'src/b.mjs'] },
  '2 件目の写し（別の id）': (a) => { a.copies.push({ id: 'C2', rule: '別の規則', canonical: 'docs/a.md', copies: ['src/b.mjs'], check: 'test/b.test.mjs' }) },
})

// ---------------- 4. test_uses（テストの前提） ----------------
breaking('test_uses', {
  '他の単位の paths を挙げるが、その単位が自分の依存の閉包に無い（U1 が U2 の src/b.mjs）': (a) => { a.units[0].test_uses = ['src/b.mjs'] },
  '他の単位の tests を挙げるが、その単位が閉包に無い（U1 が U2 の test/b.test.mjs）': (a) => { a.units[0].test_uses = ['test/b.test.mjs'] },
  '逆向きの依存（U2 が、自分に依存する U3 の docs/a.md）': (a) => { a.units[1].test_uses = ['src/a.mjs', 'docs/a.md'] },
  'doc の単位の test_uses が空でない（既存の外のファイル）': (a) => { a.units[2].test_uses = ['tools/run.mjs'] },
  'doc の単位の test_uses が空でない（依存の閉包にある単位のファイル）': (a) => { a.units[2].test_uses = ['src/a.mjs'] },
})
passing('test_uses', {
  '依存の閉包にある単位の paths（U2 が U1 の src/a.mjs）': () => {},
  '依存の閉包にある単位の tests（U2 が U1 の test/a.test.mjs）': (a) => { a.units[1].test_uses.push('test/a.test.mjs') },
  '推移的な依存の単位の paths（U3 が閉包に持つ U1 を、code の単位 U4 が前提にする）': (a) => {
    a.units.push(unit({ id: 'U4', kind: 'code', paths: ['src/c.mjs'], tests: ['test/c.test.mjs'], test_uses: ['src/a.mjs'], depends_on: ['U3'] }))
  },
  'どの単位も持たない既存のファイル': (a) => { a.units[0].test_uses = ['tools/other.mjs'] },
})

// ---------------- 5. ARCH_INVARIANTS ----------------
// 不変条件の文ごとに、破る入力の組。文の並びや言い回しでなく、文が守る対象の語で結ぶ。
const OVER = (k) => Array.from({ length: C.MAX_UNIT_PATHS + 1 }, (_, i) => `gen/${k}${i}.mjs`)
const BREAKERS = [
  { name: 'kind は doc か code', re: /kind/, cases: { 'kind が doc でも code でもない': (a) => { a.units[0].kind = 'script' } } },
  { name: 'paths は 1〜MAX_UNIT_PATHS 件', re: /paths/, cases: {
    'paths が MAX_UNIT_PATHS + 1 件': (a) => { a.units[0].paths = OVER('p') },
    'paths が 0 件': (a) => { a.units[0].paths = [] },
  } },
  { name: 'code の tests は 1〜MAX_UNIT_PATHS 件', re: /code.*tests|tests.*code/, cases: {
    'code の tests が MAX_UNIT_PATHS + 1 件': (a) => { a.units[0].tests = OVER('t') },
    'code の tests が 0 件': (a) => { a.units[0].tests = [] },
  } },
  { name: 'doc は tests と test_uses を持たない', re: /doc.*test_uses|test_uses.*doc/, cases: {
    'doc の単位が tests を持つ': (a) => { a.units[2].tests = ['test/doc.test.mjs'] },
    'doc の単位が test_uses を持つ': (a) => { a.units[2].test_uses = ['tools/run.mjs'] },
  } },
  { name: '1 つのファイルは 1 つの単位だけが持つ', re: /ファイル/, cases: {
    '2 つの単位が同じ path を持つ': (a) => { a.units[1].paths = ['src/a.mjs'] },
    'ある単位の path が別の単位の tests と同じ': (a) => { a.units[1].tests = ['src/a.mjs'] },
  } },
  { name: '境界の行は使う単位ごとに扱いを 1 つ持つ', re: /境界|行/, cases: {
    '行の handling が使う単位を 1 つ欠く': (a) => { a.contracts[0].rows[0].handling.pop() },
    '行の handling が同じ単位を 2 回持つ': (a) => { a.contracts[1].rows[0].handling.push({ unit: 'U2', does: '重ねた' }) },
  } },
]

test('ARCH_INVARIANTS は C から使える。不変条件の文の配列で、6 つ（kind・paths・code の tests・doc・ファイルの持ち主・境界の行）', () => {
  assert.ok(Array.isArray(C.ARCH_INVARIANTS))
  assert.equal(C.ARCH_INVARIANTS.length, 6)
  assert.ok(C.ARCH_INVARIANTS.every((s) => typeof s === 'string' && s.trim()))
  assert.equal(new Set(C.ARCH_INVARIANTS).size, 6, '同じ文を重ねない')
})

test('ARCH_INVARIANTS の文は、kind・paths・tests・test_uses という欄の語を使う', () => {
  const all = C.ARCH_INVARIANTS.join('\n')
  for (const w of ['kind', 'paths', 'tests', 'test_uses']) assert.ok(all.includes(w), `${w} が文に出る`)
})

test('ARCH_INVARIANTS の文の中の数は MAX_UNIT_PATHS の値と一致する', () => {
  const all = C.ARCH_INVARIANTS.join('\n')
  const nums = new Set(all.match(/\d+/g) || [])
  for (const n of nums) assert.ok(n === '1' || n === String(C.MAX_UNIT_PATHS), `文の中の数 ${n} は 1 か MAX_UNIT_PATHS（${C.MAX_UNIT_PATHS}）のどちらか`)
  assert.ok(C.ARCH_INVARIANTS.filter((s) => /paths|tests/.test(s) && /\d/.test(s)).every((s) => s.includes(String(C.MAX_UNIT_PATHS))), 'paths と tests の文に上限の数が入る')
})

test('ARCH_INVARIANTS の文の中の数は定数から作る（MAX_UNIT_PATHS を変えると文も、照合も追随する）', () => {
  const body = (n) => new Function(`${CHECKS.replace(/const MAX_UNIT_PATHS = \d+/, `const MAX_UNIT_PATHS = ${n}`)}\nreturn { ARCH_INVARIANTS, checkArch, MAX_UNIT_PATHS }`)()
  const five = body(5)
  assert.equal(five.MAX_UNIT_PATHS, 5)
  const text = five.ARCH_INVARIANTS.join('\n')
  assert.ok(text.includes('5'), '上限 5 が文に出る')
  assert.ok(!text.includes('3'), '古い上限 3 が文に残らない')
  // 上限 5 の checkArch は paths 4 件を受け、6 件を拒む。
  const withPaths = (n) => { const a = base(); a.units[0].paths = Array.from({ length: n }, (_, i) => `gen/p${i}.mjs`); return a }
  assert.deepEqual(five.checkArch(withPaths(4), ctx), [])
  assert.ok(five.checkArch(withPaths(6), ctx).length > 0)
  assert.ok(C.checkArch(withPaths(4), ctx).length > 0, '上限 3 の checkArch は paths 4 件を拒む')
})

test('ARCH_INVARIANTS: どの文にも破る入力の組があり、どの組もどれかの文に結ばれる（文だけあって照合の無い不変条件を残さない）', () => {
  for (const s of C.ARCH_INVARIANTS) assert.ok(BREAKERS.some((b) => b.re.test(s)), `この文を破る入力が無い: ${s}`)
  for (const b of BREAKERS) assert.ok(C.ARCH_INVARIANTS.some((s) => b.re.test(s)), `この決まりを述べる文が無い: ${b.name}`)
  assert.equal(BREAKERS.length, C.ARCH_INVARIANTS.length)
})
for (const b of BREAKERS) breaking(`不変条件（${b.name}）`, b.cases)

// ---------------- 5a. id の形（LINK_PATTERN） ----------------
const linkSource = (p) => (p instanceof RegExp ? p.source : String(p))
test('LINK_PATTERN は C から使える。境界の行（X<n>-<k>）・受け入れ（U<n>A<k>）・振る舞い（U<n>S<k>）に当たる 1 つの正規表現で、約束の id（X<n>）・単位の id・ケースの id には当たらない', () => {
  assert.ok(C.LINK_PATTERN, 'C に LINK_PATTERN がある')
  const re = new RegExp(`^(?:${linkSource(C.LINK_PATTERN)})$`)
  for (const id of ['X1-1', 'X12-3', 'U1A1', 'U10A12', 'U1S1', 'U3S14']) assert.ok(re.test(id), `${id} に当たる`)
  for (const id of ['X1', 'X12', 'U1', 'U1C1', 'C1', 'Y1-1', 'U1A', 'X1-', 'A1']) assert.ok(!re.test(id), `${id} には当たらない`)
  const found = [...'行 X1-2 を U3A1 と U3S2 が受ける。X1 は約束、U3 は単位。'.matchAll(new RegExp(linkSource(C.LINK_PATTERN), 'g'))].map((m) => m[0])
  assert.deepEqual(found, ['X1-2', 'U3A1', 'U3S2'])
})

test('LINK_PATTERN と ARCH_INVARIANTS は <checks> 区間が正本で、CLI（build-core.mjs・build-cli.mjs）に id の形の写しを持たない', () => {
  const region = new Function(`${CHECKS}\nreturn { ARCH_INVARIANTS, LINK_PATTERN }`)()
  assert.deepEqual(C.ARCH_INVARIANTS, region.ARCH_INVARIANTS)
  assert.equal(linkSource(C.LINK_PATTERN), linkSource(region.LINK_PATTERN))
  for (const f of ['build-core.mjs', 'build-cli.mjs']) {
    const src = readFileSync(path.join(HERE, f), 'utf8')
    assert.ok(!/U\\d\+[AS]\\d\+/.test(src), `${f} に振る舞い・受け入れの id の正規表現の写しが無い`)
    assert.ok(!/X\\d\+-\\d\+/.test(src), `${f} に境界の行の id の正規表現の写しが無い`)
  }
})

test('checkArch は contracts の id に X<数> を求める（LINK_PATTERN の行 id の元の形と同じ）', () => {
  assert.deepEqual(problems((a) => { a.contracts[0].id = 'X10'; a.contracts[1].id = 'X11' }), [])
  assert.ok(problems((a) => { a.contracts[0].id = 'U1' }).length > 0)
})

// ---------------- 6. 方式設計の役の prompt ----------------
test('方式設計の役の prompt: contracts・copies・test_uses・粒度の 4 つを理由つきで書き、複数の単位にまたがる決定の旧い行は置き換える', async (t) => {
  const { state } = setup(t)
  let prompt = ''
  const over = { architect: (p) => { prompt = p; return undefined } }
  await drive(state, mockAgent(over), { maxSteps: 1 })
  assert.ok(prompt, '方式設計の役が呼ばれる')
  // 1. contracts: 作る側が返しうる全ての値を行にし、使う単位ごとの扱いを書く
  assert.ok(prompt.includes('contracts'))
  for (const w of ['正常', '失敗', '空', '上限', '呼び直し']) assert.ok(prompt.includes(w), `contracts の行にする値の例に「${w}」`)
  assert.match(prompt, /使う(側|単位)ごと/, '使う単位ごとの扱いを書く')
  assert.match(prompt, /片側だけの約束/, 'contracts の理由')
  assert.ok(!prompt.includes('それを決める単位を 1 つ置き'), '旧い行（複数の単位にまたがる決定は、それを決める単位を 1 つ置き…）は contracts の文に置き換える')
  // 2. copies: 写しを置くときだけ。参照で済むなら置かない
  assert.ok(prompt.includes('copies'))
  assert.match(prompt, /参照で済む/)
  assert.match(prompt, /一致を照らす/, 'copies の理由')
  // 3. test_uses と、変更で落ちうる既存のテストの持ち主
  assert.ok(prompt.includes('test_uses'))
  assert.match(prompt, /持ち主/, '落ちうる既存のテストの持ち主')
  // 4. 書く粒度: 単位・責務・境界まで。関数名・内部の印・prompt の文面は詳細設計に任せる
  for (const w of ['関数名', '内部の印', '文面', '詳細設計']) assert.ok(prompt.includes(w), `粒度の文に「${w}」`)
  // 既存の指示は残る
  assert.match(prompt, /depends_on/)
  assert.match(prompt, /受け皿/)
})
