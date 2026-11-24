// 詳細設計の返り値の形（P4）: 振る舞い（behaviors）と受け入れ・ケースの双方向の結び、分け方（partitions）、
// 前提の引用（premises）と未確認（unverified）、決めきらない語（VAGUE_WORDS）と許す箇所（allowed_optional）。
// checkSpec は build-core.mjs の C を直接呼ぶ。Workflow の中の checkSpec は runWorkflow で流して照らす。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { C, WORKFLOW_SOURCE } from './build-core.mjs'
import { defaultResult, drive, mockAgent, setup } from './test-harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STEP_SRC = readFileSync(WORKFLOW_SOURCE, 'utf8')
const CHECKS = STEP_SRC.slice(STEP_SRC.indexOf('// <checks>'), STEP_SRC.indexOf('// </checks>'))
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor

const WORDS = ['してよい', 'してもよい', 'しても良い', '必要に応じて', '適切に', '場合によっては', 'なるべく', '可能なら', 'できれば']
const MAT = '/abs/dir/material.md'
const CTX = { rowIds: ['X1-1', 'X1-2'], readable: [MAT, 'src/a.mjs', 'src/b.mjs'] }
const CODE = { id: 'U1', kind: 'code' }
const DOC = { id: 'U2', kind: 'doc' }

// 全ての決まりを満たす code の単位の返り値。境界の行 X1-1・X1-2 を 2 つの振る舞いが 1 つずつ受け、受け入れ 2 件を 2 つのケースが 1 つずつ確かめる。
const base = () => ({
  unit_id: 'U1',
  spec: '入力を受け取り、結果を返す。',
  acceptance: ['入力が 1 なら 2 を返す', '入力が空なら null を返す'],
  behaviors: [
    { text: '入力が 1 なら 2 を返す', accepts: [1], rows: ['X1-1'] },
    { text: '入力が空なら null を返す', accepts: [2], rows: ['X1-2'] },
  ],
  partitions: [{ name: '入力の件数', values: ['0', '1'] }],
  cases: [
    { condition: '入力が 1', expect: '2 を返す', accepts: [1], covers: ['入力の件数=1'] },
    { condition: '入力が空', expect: 'null を返す', accepts: [2], covers: ['入力の件数=0'] },
  ],
  premises: [{ claim: '材料は値に 1 を足すと述べる', path: MAT, quote: '値は入力に 1 を足して返す' }],
  unverified: [{ claim: '外の部品は同期で返る', if_broken: '待つ処理を足す' }],
  allowed_optional: [],
})
// 全ての決まりを満たす doc の単位の返り値（受け入れ 1 件・境界の行 X1-1 を受ける）。cases は無くてよい。
const docBase = () => ({
  unit_id: 'U2',
  spec: '使い方を書く。',
  acceptance: ['使い方の節がある'],
  behaviors: [{ text: '使い方の節を持つ', accepts: [1], rows: ['X1-1'] }],
  partitions: [],
  cases: [],
  premises: [],
  unverified: [],
  allowed_optional: [],
})
const mutated = (mut, b = base) => { const r = b(); mut(r); return r }
const problems = (mut, { unit = CODE, ctx = CTX, b = base } = {}) => C.checkSpec(mutated(mut, b), unit, ctx)
const docProblems = (mut, ctx = { rowIds: ['X1-1'], readable: [MAT] }) => C.checkSpec(mutated(mut, docBase), DOC, ctx)

function breaking(group, cases, opts) {
  for (const [name, mut] of Object.entries(cases)) {
    test(`${group}: ${name}なら欠けを返す`, () => {
      const p = problems(mut, opts)
      assert.ok(p.length > 0, `欠けが返らなかった: ${name}`)
    })
  }
}
function passing(group, cases, opts) {
  for (const [name, mut] of Object.entries(cases)) {
    test(`${group}: ${name}は受け付ける`, () => {
      assert.deepEqual(problems(mut, opts), [])
    })
  }
}

test('基準の返り値（code の単位）は欠け無しで通る', () => {
  assert.deepEqual(C.checkSpec(base(), CODE, CTX), [])
})
test('基準の返り値（doc の単位。cases が空）は欠け無しで通る', () => {
  assert.deepEqual(C.checkSpec(docBase(), DOC, { rowIds: ['X1-1'], readable: [MAT] }), [])
})
test('今の照らし（unit_id・spec・acceptance・cases の空）は残る', () => {
  assert.ok(problems((r) => { r.unit_id = 'U9' }).length > 0, 'unit_id が違う')
  assert.ok(problems((r) => { r.spec = '' }).length > 0, 'spec が空')
  assert.ok(problems((r) => { r.spec = Array.from({ length: C.MAX_SPEC_LINES + 1 }, (_, i) => `行${i}`).join('\n') }).length > 0, 'spec が行数の上限を超える')
  assert.ok(problems((r) => { r.acceptance = [] }).length > 0, 'acceptance が空')
  assert.ok(problems((r) => { r.acceptance[1] = ' ' }).length > 0, 'acceptance に空の行')
  assert.ok(problems((r) => { r.cases = []; r.partitions = [] }).length > 0, 'code の単位なのに cases が空')
  assert.ok(problems((r) => { r.cases[0].condition = '' }).length > 0, 'case の condition が空')
  assert.ok(problems((r) => { r.cases[1].expect = ' ' }).length > 0, 'case の expect が空')
})

// ---------------- 1. 欄（SPEC_SCHEMA と必須の配列） ----------------
test('SPEC_SCHEMA: behaviors・partitions・premises・unverified・allowed_optional を必須の配列に、cases に accepts・covers を持つ', async (t) => {
  const { state } = setup(t)
  let schema = null
  const over = { design: (p, opts) => { schema = schema || opts.schema; return undefined } }
  await drive(state, mockAgent(over), { maxSteps: 3 })
  assert.ok(schema, '詳細設計の役の結果の形がある')
  assert.equal(schema, C.SPEC_SCHEMA, '詳細設計の役の結果の形は <checks> 区間の SPEC_SCHEMA（prompt に載り、submit が照らす）')
  for (const k of ['unit_id', 'spec', 'acceptance', 'cases', 'behaviors', 'partitions', 'premises', 'unverified', 'allowed_optional']) {
    assert.ok(schema.required.includes(k), `${k} が必須`)
  }
  for (const k of ['behaviors', 'partitions', 'premises', 'unverified', 'allowed_optional']) assert.equal(schema.properties[k].type, 'array', `${k} は配列`)
  const b = schema.properties.behaviors.items
  assert.deepEqual([...b.required].sort(), ['accepts', 'rows', 'text'])
  assert.equal(b.properties.accepts.type, 'array')
  assert.equal(b.properties.accepts.items.type, 'integer')
  assert.equal(b.properties.rows.type, 'array')
  assert.equal(b.properties.rows.items.type, 'string')
  assert.ok(!('id' in b.properties), '振る舞いの id（U<n>S<k>）は位置から決め、返り値には持たせない')
  const c = schema.properties.cases.items
  for (const k of ['condition', 'expect', 'accepts', 'covers']) assert.ok(c.required.includes(k), `cases の ${k} が必須`)
  assert.equal(c.properties.accepts.items.type, 'integer')
  assert.equal(c.properties.covers.items.type, 'string')
  assert.ok(!('id' in c.properties), 'ケースの id（U<n>C<k>）は位置から決め、返り値には持たせない')
  const pa = schema.properties.partitions.items
  assert.deepEqual([...pa.required].sort(), ['name', 'values'])
  assert.equal(pa.properties.values.items.type, 'string')
  assert.deepEqual([...schema.properties.premises.items.required].sort(), ['claim', 'path', 'quote'])
  assert.deepEqual([...schema.properties.unverified.items.required].sort(), ['claim', 'if_broken'])
  assert.deepEqual([...schema.properties.allowed_optional.items.required].sort(), ['quote', 'why'])
})

test('既定の mockAgent の詳細設計は新しい欄を空に近い形で返し、checkSpec を通る（rowIds が空の単位）', async () => {
  for (const [id, unit] of [['U1', CODE], ['U2', DOC]]) {
    const r = defaultResult('unit_designer', { unit: { id } })
    assert.deepEqual(r.behaviors, [{ text: '値を返す', accepts: [1], rows: [] }])
    for (const k of ['partitions', 'premises', 'unverified', 'allowed_optional']) assert.deepEqual(r[k], [], k)
    assert.deepEqual(r.cases[0].accepts, [1])
    assert.deepEqual(r.cases[0].covers, [])
    assert.deepEqual(C.checkSpec(r, unit, { rowIds: [], readable: [] }), [])
  }
})

for (const key of ['behaviors', 'partitions', 'premises', 'unverified', 'allowed_optional']) {
  breaking(`欄（${key}）`, {
    [`${key} が無い`]: (r) => { delete r[key] },
    [`${key} が null`]: (r) => { r[key] = null },
    [`${key} が文字列`]: (r) => { r[key] = 'x' },
    [`${key} が配列でない object`]: (r) => { r[key] = {} },
  })
}
for (const key of ['partitions', 'premises', 'unverified', 'allowed_optional']) {
  test(`欄（${key}）: 空の配列は受け付ける（doc の単位）`, () => {
    assert.deepEqual(docProblems((r) => { r[key] = [] }), [])
  })
}
breaking('欄（cases の accepts・covers）', {
  'accepts が無い': (r) => { delete r.cases[0].accepts },
  'covers が無い': (r) => { delete r.cases[0].covers },
})

// ---------------- 2. behaviors と受け入れの結び ----------------
breaking('behaviors', {
  'behaviors が空': (r) => { r.behaviors = [] },
  'text が空': (r) => { r.behaviors[0].text = '' },
  'text が空白だけ': (r) => { r.behaviors[1].text = '  ' },
  'accepts が空': (r) => { r.behaviors[0].accepts = [] },
  'accepts が受け入れの位置に無い値（3。受け入れは 2 件）': (r) => { r.behaviors[0].accepts = [1, 3] },
  'accepts が 0（位置は 1 から）': (r) => { r.behaviors[0].accepts = [0] },
  'accepts が負の値': (r) => { r.behaviors[0].accepts = [-1, 1] },
  'accepts が整数でない値（1.5）': (r) => { r.behaviors[0].accepts = [1.5] },
  'accepts が文字列（"1"）': (r) => { r.behaviors[0].accepts = ['1'] },
  'rows に rowIds に無い id（X9-9）': (r) => { r.behaviors[0].rows = ['X1-1', 'X9-9'] },
  'rows が約束の id（X1。行の id でない）': (r) => { r.behaviors[0].rows = ['X1'] },
  '境界の行 X1-2 を受ける振る舞いが無い': (r) => { r.behaviors[1].rows = [] },
  '境界の行 X1-1 を受ける振る舞いが無い（別の行を重ねても欠ける）': (r) => { r.behaviors[0].rows = ['X1-2'] },
  '受け入れ 2 がどの振る舞いの accepts にも無い（振る舞いに結ばれない受け入れ）': (r) => { r.behaviors[1].accepts = [1] },
  '受け入れ 1 がどの振る舞いの accepts にも無い': (r) => { r.behaviors[0].accepts = [2] },
  '受け入れを増やしたのに振る舞いが追随しない': (r) => { r.acceptance.push('入力が 2 なら 3 を返す'); r.cases.push({ condition: '入力が 2', expect: '3 を返す', accepts: [3], covers: [] }) },
})
passing('behaviors', {
  '1 つの振る舞いが複数の受け入れを受ける': (r) => { r.behaviors = [{ text: '値を返す', accepts: [1, 2], rows: ['X1-1', 'X1-2'] }] },
  '複数の振る舞いが同じ受け入れを受ける': (r) => { r.behaviors.push({ text: '別の見方でも 2 を返す', accepts: [1], rows: [] }) },
  '複数の振る舞いが同じ行を受ける': (r) => { r.behaviors.push({ text: '行 X1-1 を別の面から受ける', accepts: [1], rows: ['X1-1'] }) },
  '行を受けない振る舞い（rows が空）': (r) => { r.behaviors.push({ text: '行に結ばれない振る舞い', accepts: [2], rows: [] }) },
})
test('behaviors: rowIds が空の単位は、rows が空の振る舞いだけで通る', () => {
  assert.deepEqual(C.checkSpec(mutated((r) => { r.behaviors.forEach((b) => { b.rows = [] }) }), CODE, { rowIds: [], readable: CTX.readable }), [])
})
test('behaviors: rowIds が空の単位が、行を挙げる振る舞いを持つと欠け（実在しない行）', () => {
  assert.ok(C.checkSpec(base(), CODE, { rowIds: [], readable: CTX.readable }).length > 0)
})
test('behaviors: ctx を渡さない呼び出しは例外にならず、rowIds を空として扱う（取り込みが ctx を渡す前の呼び出し口）', () => {
  assert.deepEqual(C.checkSpec(mutated((r) => { r.behaviors.forEach((b) => { b.rows = [] }) }), CODE), [])
})
test('behaviors（doc の単位）: 境界の行を受ける振る舞いが無いと欠け、受ける振る舞いがあれば通る', () => {
  assert.ok(docProblems((r) => { r.behaviors[0].rows = [] }).length > 0)
  assert.ok(docProblems((r) => { r.behaviors[0].rows = ['X9-1'] }).length > 0)
  assert.ok(docProblems((r) => { r.behaviors[0].accepts = [2] }).length > 0, '受け入れの位置に無い値')
  assert.ok(docProblems((r) => { r.behaviors = [] }).length > 0, 'doc の単位も behaviors が空なら欠け')
  assert.deepEqual(docProblems(() => {}), [])
})

// ---------------- 3. cases と受け入れの結び（code の単位） ----------------
breaking('cases', {
  '受け入れ 2 がどのケースの accepts にも無い': (r) => { r.cases[1].accepts = [1] },
  '受け入れ 1 がどのケースの accepts にも無い': (r) => { r.cases[0].accepts = [2] },
  'ケースの accepts が空': (r) => { r.cases[0].accepts = [] },
  'ケースの accepts が受け入れの位置に無い値（3）': (r) => { r.cases[0].accepts = [1, 3] },
  'ケースの accepts が 0': (r) => { r.cases[0].accepts = [0] },
  'ケースの accepts が整数でない値': (r) => { r.cases[0].accepts = [1.5] },
})
passing('cases', {
  '1 つのケースが複数の受け入れを確かめる': (r) => { r.cases = [{ condition: '入力が 1 と空', expect: '2 と null を返す', accepts: [1, 2], covers: ['入力の件数=0', '入力の件数=1'] }] },
  '複数のケースが同じ受け入れを確かめる': (r) => { r.cases.push({ condition: '入力が 1（再呼び出し）', expect: '2 を返す', accepts: [1], covers: [] }) },
  'covers が空のケース（分け方に結ばれないケース）': (r) => { r.cases.push({ condition: '入力が 1（別の経路）', expect: '2 を返す', accepts: [1], covers: [] }) },
})

// ---------------- 4. partitions（分け方） ----------------
breaking('partitions', {
  'name が空': (r) => { r.partitions[0].name = '' },
  'name が空白だけ': (r) => { r.partitions[0].name = ' ' },
  'name が重複': (r) => { r.partitions.push({ name: '入力の件数', values: ['a', 'b'] }) },
  'values が空': (r) => { r.partitions[0].values = [] },
  'values が 1 件': (r) => { r.partitions[0].values = ['1']; r.cases[1].covers = [] },
  'values に空の値': (r) => { r.partitions[0].values = ['0', '1', ''] },
  'values が配列でない': (r) => { r.partitions[0].values = null },
  '分け方の値がどのケースの covers にも無い': (r) => { r.partitions[0].values = ['0', '1', '上限ちょうど'] },
  '分け方の値の 1 つ（0）がどのケースの covers にも無い': (r) => { r.cases[1].covers = [] },
  'covers が partitions に無い名前': (r) => { r.cases[0].covers = ['入力の件数=1', '未知の軸=1'] },
  'covers が partitions に無い値': (r) => { r.cases[0].covers = ['入力の件数=1', '入力の件数=99'] },
  'covers が <name>=<value> の形でない': (r) => { r.cases[0].covers = ['入力の件数=1', '入力の件数'] },
  'partitions が無いのに covers がある（分け方に無い名前）': (r) => { r.partitions = []; r.cases[0].covers = ['入力の件数=1'] },
})
passing('partitions', {
  '分け方が 2 つ（互いの値を別々のケースが覆う）': (r) => {
    r.partitions.push({ name: 'mode', values: ['strict', 'loose'] })
    r.cases[0].covers.push('mode=strict')
    r.cases[1].covers.push('mode=loose')
  },
  '1 つのケースが複数の値を覆う': (r) => { r.cases = [{ condition: '入力が 1 と空', expect: '2 と null を返す', accepts: [1, 2], covers: ['入力の件数=0', '入力の件数=1'] }] },
  '同じ値を複数のケースが覆う': (r) => { r.cases[1].covers.push('入力の件数=1') },
  '値に空白や記号を含む': (r) => { r.partitions = [{ name: '上限の扱い', values: ['上限ちょうど（3 件）', '上限 + 1'] }]; r.cases[0].covers = ['上限の扱い=上限ちょうど（3 件）']; r.cases[1].covers = ['上限の扱い=上限 + 1'] },
  'partitions が空の配列（covers も空）': (r) => { r.partitions = []; r.cases.forEach((c) => { c.covers = [] }) },
})
test('partitions（doc の単位）: partitions があるのに cases が空だと欠け。cases が全ての値を覆えば通る', () => {
  const withPart = (r) => { r.partitions = [{ name: '節', values: ['概要', '使い方'] }] }
  assert.ok(docProblems(withPart).length > 0, 'partitions があれば doc の単位も cases が要る')
  assert.deepEqual(docProblems((r) => { withPart(r); r.cases = [{ condition: '概要の節', expect: '1 行目に概要がある', accepts: [1], covers: ['節=概要'] }, { condition: '使い方の節', expect: '使い方の見出しがある', accepts: [1], covers: ['節=使い方'] }] }), [])
  assert.ok(docProblems((r) => { withPart(r); r.cases = [{ condition: '概要の節', expect: '1 行目に概要がある', accepts: [1], covers: ['節=概要'] }] }).length > 0, '値（使い方）を覆うケースが無い')
  assert.ok(docProblems((r) => { r.cases = [{ condition: '概要の節', expect: '1 行目に概要がある', accepts: [1], covers: ['節=概要'] }] }).length > 0, 'partitions が無いのに covers がある')
})
test('cases（doc の単位）: partitions が無ければ cases は空でよく、acceptance を全て確かめることも求めない', () => {
  assert.deepEqual(docProblems((r) => { r.acceptance.push('用語集がある'); r.behaviors.push({ text: '用語集を持つ', accepts: [2], rows: [] }) }), [])
  assert.deepEqual(docProblems((r) => { r.acceptance.push('用語集がある'); r.behaviors.push({ text: '用語集を持つ', accepts: [2], rows: [] }); r.partitions = [{ name: '節', values: ['概要', '用語'] }]; r.cases = [{ condition: '概要', expect: '概要がある', accepts: [1], covers: ['節=概要', '節=用語'] }] }), [])
})

// ---------------- 5. premises・unverified（前提） ----------------
breaking('premises', {
  'claim が空': (r) => { r.premises[0].claim = '' },
  'path が空': (r) => { r.premises[0].path = '' },
  'quote が空': (r) => { r.premises[0].quote = '' },
  'quote が空白だけ': (r) => { r.premises[0].quote = '  ' },
  'claim が空白だけ': (r) => { r.premises[0].claim = ' ' },
  'readable があり、path がその中に無い': (r) => { r.premises[0].path = '/abs/dir/other.md' },
  'readable があり、相対 path が単位の持つファイルの一覧に無い': (r) => { r.premises[0].path = 'src/zzz.mjs' },
  '2 件目の path が readable に無い': (r) => { r.premises.push({ claim: '別の前提', path: 'src/zzz.mjs', quote: 'export const x = 1' }) },
})
passing('premises', {
  '束の入力の絶対 path': () => {},
  '単位が持つファイルの相対 path': (r) => { r.premises = [{ claim: '既存の関数は 1 を返す', path: 'src/a.mjs', quote: 'export const value = 1' }] },
  '前提が 2 件（絶対 path と相対 path）': (r) => { r.premises.push({ claim: '既存の関数は 1 を返す', path: 'src/b.mjs', quote: 'export const value = 1' }) },
  '前提が空の配列': (r) => { r.premises = [] },
})
test('premises: ctx.readable を渡さなければ path を照らさない（claim・path・quote の空だけを見る）', () => {
  const free = (mut) => C.checkSpec(mutated(mut), CODE, { rowIds: CTX.rowIds })
  assert.deepEqual(free((r) => { r.premises[0].path = '/どこにも無い/file.md' }), [])
  assert.ok(free((r) => { r.premises[0].path = '' }).length > 0)
  assert.ok(free((r) => { r.premises[0].quote = '' }).length > 0)
  assert.ok(free((r) => { r.premises[0].claim = '' }).length > 0)
})
test('premises: readable が空の配列なら、どの path も readable に無いので欠け（渡さないこととは別）', () => {
  assert.ok(C.checkSpec(base(), CODE, { rowIds: CTX.rowIds, readable: [] }).length > 0)
})
breaking('unverified', {
  'claim が空': (r) => { r.unverified[0].claim = '' },
  'if_broken が空': (r) => { r.unverified[0].if_broken = '' },
  'if_broken が空白だけ': (r) => { r.unverified[0].if_broken = ' ' },
  '2 件目の if_broken が空': (r) => { r.unverified.push({ claim: '別の前提', if_broken: '' }) },
})
passing('unverified', {
  '確かめていない前提が無い（空の配列）': (r) => { r.unverified = [] },
  '確かめていない前提が 2 件': (r) => { r.unverified.push({ claim: '呼び出しは直列', if_broken: '順序の検査を足す' }) },
})

// ---------------- 6. 決めきらない語（VAGUE_WORDS・allowed_optional） ----------------
test('VAGUE_WORDS は C から使える。初期の一覧は 9 語で、「など」と「場合は」を含まない', () => {
  assert.ok(Array.isArray(C.VAGUE_WORDS))
  assert.deepEqual([...C.VAGUE_WORDS].sort(), [...WORDS].sort())
  assert.ok(C.VAGUE_WORDS.every((w) => typeof w === 'string' && w.trim()))
  for (const w of ['など', '場合は', '書いてよい']) assert.ok(!C.VAGUE_WORDS.includes(w), `${w} は一覧に入れない`)
})
test('VAGUE_WORDS の正本は <checks> 区間の 1 か所で、CLI（build-core.mjs・build-cli.mjs）に語の写しを持たない', () => {
  const region = new Function(`${CHECKS}\nreturn { VAGUE_WORDS }`)()
  assert.deepEqual(C.VAGUE_WORDS, region.VAGUE_WORDS)
  assert.equal((CHECKS.match(/const VAGUE_WORDS/g) || []).length, 1)
  for (const f of ['build-core.mjs', 'build-cli.mjs']) {
    const src = readFileSync(path.join(HERE, f), 'utf8')
    for (const w of WORDS) assert.ok(!src.includes(w), `${f} に決めきらない語「${w}」の写しが無い`)
  }
})

// 語が現れる本文の置き場所。どの場所でも同じ語を拾う。
const PLACES = {
  spec: (r, t) => { r.spec = t },
  acceptance: (r, t) => { r.acceptance[0] = t },
  'behaviors の text': (r, t) => { r.behaviors[0].text = t },
  'cases の condition': (r, t) => { r.cases[0].condition = t },
  'cases の expect': (r, t) => { r.cases[0].expect = t },
}
for (const w of WORDS) {
  breaking(`決めきらない語（${w}）`, { [`spec に「${w}」が現れ、allowed_optional に挙げていない`]: (r) => { r.spec = `入力を受け取り、結果を返す。結果は${w}。` } })
}
for (const [place, set] of Object.entries(PLACES)) {
  breaking(`決めきらない語の置き場所（${place}）`, { [`「してよい」が現れ、allowed_optional に挙げていない`]: (r) => set(r, '値を保存してよい') })
}
passing('決めきらない語でない書き方', {
  '役の権限を定める「書いてよい」': (r) => { r.spec = '担当は設計の文書を書いてよいファイルを受け取る。' },
  '列挙の省略の「など」': (r) => { r.spec = '入力は数値や文字列などを受ける。' },
  '条件の書き出しの「場合は」': (r) => { r.spec = '入力が空の場合は null を返す。' },
  '語を含まない断定': (r) => { r.spec = '入力が空なら null を返す。ちょうど 1 件を返す。' },
})

const OPT = '値を保存してよい'
const withOpt = (extra) => (r) => { r.spec = `入力を受け取り、結果を返す。${OPT}。`; r.allowed_optional = [{ quote: OPT, why: '役の権限を定める文のため' }]; if (extra) extra(r) }
passing('allowed_optional', {
  'spec の語を、spec に逐語である引用と理由で挙げる': withOpt(),
  'acceptance の語を挙げる': (r) => { r.acceptance[0] = `入力が 1 なら 2 を返す。${OPT}`; r.allowed_optional = [{ quote: OPT, why: '権限の文' }] },
  'behaviors の text の語を挙げる': (r) => { r.behaviors[0].text = `入力が 1 なら 2 を返す。${OPT}`; r.allowed_optional = [{ quote: OPT, why: '権限の文' }] },
  'cases の condition の語を挙げる': (r) => { r.cases[0].condition = `入力が 1 で${OPT}`; r.allowed_optional = [{ quote: OPT, why: '権限の文' }] },
  'cases の expect の語を挙げる': (r) => { r.cases[0].expect = `2 を返し、${OPT}`; r.allowed_optional = [{ quote: OPT, why: '権限の文' }] },
  '同じ語が 2 か所にあり、1 つの引用が両方を含む': (r) => { r.spec = `入力を受け取る。${OPT}。結果を返す。${OPT}。`; r.allowed_optional = [{ quote: OPT, why: '権限の文' }] },
  '同じ語が別の本文 2 か所にあり、2 つの引用が 1 つずつ覆う': (r) => {
    r.spec = '入力を受け取る。値を保存してよい。'
    r.acceptance[0] = '入力が 1 なら 2 を返し、結果を消してよい'
    r.allowed_optional = [{ quote: '値を保存してよい', why: '権限の文' }, { quote: '結果を消してよい', why: '権限の文' }]
  },
  '引用が語の前後の文字を含む（語を含む長い引用）': (r) => { r.spec = '入力を受け取り、結果を返す。担当は値を保存してよい。'; r.allowed_optional = [{ quote: '担当は値を保存してよい', why: '権限の文' }] },
  '1 つの引用が複数の語を含む': (r) => { r.spec = '必要に応じて値を保存してよい。'; r.allowed_optional = [{ quote: '必要に応じて値を保存してよい', why: '権限の文' }] },
})
breaking('allowed_optional', {
  '語が現れる本文が allowed_optional の引用と別の場所（spec の語を覆わない引用）': (r) => {
    r.spec = '入力を受け取り、結果を返す。AA を保存してよい。'
    r.acceptance[0] = 'BB を保存してよい'
    r.allowed_optional = [{ quote: 'BB を保存してよい', why: '権限の文' }]
  },
  '同じ語が 2 か所あり、1 か所だけ引用で覆う': (r) => { r.spec = '入力を受け取り、AA を保存してよい。BB を消してよい。'; r.allowed_optional = [{ quote: 'AA を保存してよい', why: '権限の文' }] },
  '引用がどの本文にも逐語で無い': (r) => { r.spec = `入力を受け取り、結果を返す。${OPT}。`; r.allowed_optional = [{ quote: '値を保存しても構わない', why: '権限の文' }] },
  '引用が語を含まない（語を覆う別の引用はある）': withOpt((r) => { r.allowed_optional.push({ quote: '入力を受け取り、結果を返す', why: '語を含まない引用' }) }),
  '引用が語を含まない（語は別にある）': (r) => { r.spec = `入力を受け取り、結果を返す。${OPT}。`; r.allowed_optional = [{ quote: '入力を受け取り、結果を返す', why: '権限の文' }] },
  'why が空': (r) => { r.spec = `入力を受け取り、結果を返す。${OPT}。`; r.allowed_optional = [{ quote: OPT, why: '' }] },
  'why が空白だけ': (r) => { r.spec = `入力を受け取り、結果を返す。${OPT}。`; r.allowed_optional = [{ quote: OPT, why: ' ' }] },
  'quote が空': (r) => { r.spec = `入力を受け取り、結果を返す。${OPT}。`; r.allowed_optional = [{ quote: '', why: '権限の文' }] },
  '語の無い本文に対する、語を含まない引用だけを挙げる（語が無いのに許しを挙げる）': (r) => { r.allowed_optional = [{ quote: '入力を受け取り', why: '不要な許し' }] },
  '語を含む引用が premises の quote にだけ逐語である（照合の対象の本文でない）': (r) => { r.premises[0].quote = '値を保存してよい'; r.allowed_optional = [{ quote: '値を保存してよい', why: '権限の文' }] },
})
test('allowed_optional: 語が premises や unverified の文にだけ現れても、決めきらない語としては照らさない（照らす本文は spec・acceptance・behaviors の text・cases の condition と expect）', () => {
  assert.deepEqual(problems((r) => { r.unverified[0].if_broken = '必要に応じて待つ処理を足す' }), [])
})
test('allowed_optional: 許した引用の理由と引用は返り値に残り、台帳が描ける（checkSpec は文の意味を判定しない）', () => {
  const r = mutated(withOpt())
  assert.deepEqual(C.checkSpec(r, CODE, CTX), [])
  assert.deepEqual(r.allowed_optional, [{ quote: OPT, why: '役の権限を定める文のため' }])
})

// ---------------- 7. 詳細設計の役の prompt ----------------
const designPrompt = async (t) => {
  const { state } = setup(t)
  const log = []
  await drive(state, mockAgent({}, log), { maxSteps: 3 })
  const hit = log.find((x) => x.role === 'unit_designer')
  assert.ok(hit, '詳細設計の役が呼ばれる')
  return hit.prompt
}
test('詳細設計の役の prompt: behaviors・partitions と cases・premises と unverified・決めきらない語の 4 つを理由つきで書く', async (t) => {
  const prompt = await designPrompt(t)
  // 1. behaviors: 振る舞いを 1 件ずつ、確かめる受け入れの位置と受ける境界の行 id を付ける
  assert.ok(prompt.includes('behaviors'))
  assert.match(prompt, /受け入れ/)
  assert.match(prompt, /境界の行/, '受ける境界の行 id')
  assert.match(prompt, /受け入れから落ちる/, 'behaviors の理由（spec の文だけの振る舞いは受け入れから落ちる）')
  // 2. partitions と cases: 件数の 0・1・上限ちょうど・上限 + 1、未設定、mode や引数の組。ケースで全ての値を覆う
  assert.ok(prompt.includes('partitions'))
  for (const w of ['上限ちょうど', '未設定', 'mode', '引数の組']) assert.ok(prompt.includes(w), `分け方の例に「${w}」`)
  assert.match(prompt, /上限\s*\+\s*1/)
  assert.match(prompt, /全ての値/, 'ケースで全ての値を覆う')
  assert.match(prompt, /観測/, '期待は比べる対象を持つ観測できる文')
  // 3. premises と unverified: 逐語の引用。確かめていない前提は崩れたときの扱いと共に。「要らない」と判断した入力に頼る前提も同じ
  assert.ok(prompt.includes('premises'))
  assert.ok(prompt.includes('unverified'))
  assert.match(prompt, /逐語/)
  assert.match(prompt, /崩れたとき/)
  assert.match(prompt, /要らない/)
  // 4. 決めきらない語: 選択を実装の担当に残さない。役の権限を定めるときだけ allowed_optional に挙げる
  assert.ok(prompt.includes('allowed_optional'))
  assert.match(prompt, /実装の担当/)
  assert.match(prompt, /権限/)
  // 既存の指示は残る
  assert.match(prompt, /acceptance/)
  assert.match(prompt, /cases/)
  assert.match(prompt, /決め直さない/)
})
test('詳細設計の役の prompt: 決めきらない語の一覧は VAGUE_WORDS の全ての語を載せる', async (t) => {
  const prompt = await designPrompt(t)
  for (const w of C.VAGUE_WORDS) assert.ok(prompt.includes(w), `prompt に「${w}」が載る`)
})
test('詳細設計の役の prompt: 語の一覧は <checks> 区間の VAGUE_WORDS から作る（区間の語を差し替えると prompt も変わる）', async () => {
  const start = STEP_SRC.indexOf('// <checks>')
  const end = STEP_SRC.indexOf('// </checks>')
  const region = STEP_SRC.slice(start, end)
  assert.ok(region.includes('なるべく'), '区間に語がある')
  const edited = `${STEP_SRC.slice(0, start)}${region.replaceAll('なるべく', 'ほどほどに')}${STEP_SRC.slice(end)}`
  const body = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', edited.replace(/^export const meta = /, 'const meta = '))
  // args は最初の波だけを持つ { state, callId, wave: { id, rows } }。
  const args = { state: '/x/state', callId: 'c1', wave: { id: 1, rows: [{ id: 'd1', role: 'unit_designer', model: 'm', effort: 'low', stage: 'design' }] } }
  const prompts = []
  const agent = async (prompt) => { prompts.push(prompt); return null }
  const parallel = (ts) => Promise.all(ts.map((x) => Promise.resolve().then(x).catch(() => null)))
  const pipeline = (items, fn) => Promise.all(items.map((x, i) => Promise.resolve().then(() => fn(x, i)).catch(() => null)))
  await body(agent, parallel, pipeline, () => {}, () => {}, args, undefined)
  const p = prompts.find((x) => x.includes('詳細設計の役'))
  assert.ok(p, '詳細設計の役の prompt が作られる')
  assert.ok(p.includes('ほどほどに'), '差し替えた語が prompt に載る')
  assert.ok(!p.includes('なるべく'), '古い語が prompt に残らない')
})
