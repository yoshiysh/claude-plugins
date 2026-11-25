// 方式設計の提出は、単位の paths・tests に repo で既にディレクトリとして在る path を持てない（ファイルを挙げる）。
// 受理すると台帳が通るが、次の next が単位のファイルの hash（readFileSync）で EISDIR になり、台帳が進まなくなる。
// 拒むのは submit（build-cli → build-core の submitArch → checkArch）。理由に単位の id と path を含め、拒んだ後も next が落ちない。
// まだ無い path（新しく作るファイル）と既存のファイルは今までどおり受理する。
// 加えて、単位の paths・tests の path が別の path の祖先（a と a/...）なら、両方がまだ無くても拒む（書き手が子を書くと祖先がディレクトリになるため）。
// これは checkArch（純粋な照合）の不変条件で、ARCH_INVARIANTS に載る。既存のファイルの下の path（src/old.mjs/x.md）は拒まない。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { C, MAX_ATTEMPTS } from './build-core.mjs'
import { archOf, cli, defaultUnits, drive, mockAgent, setup } from './test-harness.mjs'

const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8'))
const rejections = (state) => ledger(state).events.filter((e) => e.kind === 'rejected_output').map((e) => e.text)

const DIR = 'plugins/x/references/types'
// repo に、中にファイルのあるディレクトリ（DIR）と、既存のファイル（src/old.mjs。setup が作る）を用意する。
const prepare = (t) => {
  const s = setup(t)
  mkdirSync(path.join(s.repo, DIR), { recursive: true })
  writeFileSync(path.join(s.repo, DIR, 'a.md'), '# 型の一覧\n\nディレクトリの中にある既存のファイルの本文の行。\n')
  return s
}
// 方式設計の役の偽物。mutate(units, attempt) で既定の単位（U1 code: src/a.mjs・test/a.test.mjs、U2 doc: docs/a.md）を書き換える。attempt はその担当を書く何回目か。
const architect = (mutate, seen = []) => (p, o) => {
  seen.push({ attempt: o.attempt, problems: o.problems })
  const units = defaultUnits(['AC1', 'D1'])
  mutate(units, o.attempt)
  return archOf(o.inputs, units)
}

// 列挙できる条件: ディレクトリを持たせる欄と単位。id は拒む理由に載る単位。
const BAD = {
  'code の単位の paths': { id: 'U1', mutate: (us) => { us[0].paths = [DIR] } },
  'code の単位の paths（ファイルと並べて）': { id: 'U1', mutate: (us) => { us[0].paths = ['src/a.mjs', DIR] } },
  'code の単位の tests': { id: 'U1', mutate: (us) => { us[0].tests = [DIR] } },
  'doc の単位の paths': { id: 'U2', mutate: (us) => { us[1].paths = [DIR] } },
}

for (const [name, { id, mutate }] of Object.entries(BAD)) {
  test(`拒む: ${name}に既存のディレクトリを入れた方式設計は、理由に単位の id と path を載せて拒まれ、台帳に単位を作らない`, async (t) => {
    const s = prepare(t)
    const { stop } = await drive(s.state, mockAgent({ architect: architect(mutate) }))
    const L = ledger(s.state)
    const rs = rejections(s.state)
    assert.equal(rs.length, MAX_ATTEMPTS, `同じ体が上限まで出し直し、拒んだ提出ごとに理由が残る: ${JSON.stringify(rs)}`)
    for (const r of rs) {
      assert.ok(r.includes(`${id}:`), `理由に単位の id（${id}）が無い: ${r}`)
      assert.ok(r.includes(DIR), `理由に path（${DIR}）が無い: ${r}`)
      assert.match(r, /ディレクトリ/, `理由がディレクトリだと言っていない: ${r}`)
    }
    assert.deepEqual(Object.keys(L.units), [], '拒んだ方式設計の単位を台帳に作らない')
    assert.ok(stop && stop.code === 0 && !stop.error, `拒んだ後に next が落ちる（EISDIR など）: ${JSON.stringify(stop)}`)
    assert.equal(stop.stop, 'needs_input', '試行の上限で人間に返す')
    assert.deepEqual(stop.stuck, ['arch'], '試行の上限で方式設計が stuck として開示される')
  })
}

test('拒んだ後: 台帳は壊れず next が例外にならない（何度流しても同じ）', async (t) => {
  const s = prepare(t)
  await drive(s.state, mockAgent({ architect: architect(BAD['code の単位の paths'].mutate) }))
  for (let i = 0; i < 2; i++) {
    const { code, ...n } = cli('next', '--state', s.state)
    assert.equal(code, 0, `next が落ちた: ${JSON.stringify(n)}`)
    assert.ok(!/EISDIR/.test(JSON.stringify(n)), JSON.stringify(n))
  }
})

test('出し直し: 1 回目にディレクトリを挙げて拒まれても、前の理由を受けた 2 回目にファイルを挙げれば受理され、最後まで進む', async (t) => {
  const s = prepare(t)
  const seen = []
  const fix = (us, attempt) => { if (attempt === 1) us[0].paths = [DIR]; else us[0].paths = [`${DIR}/b.md`] }
  const { stop } = await drive(s.state, mockAgent({ architect: architect(fix, seen) }))
  assert.equal(stop && stop.stop, 'complete', JSON.stringify(stop))
  assert.equal(seen[0].attempt, 1)
  const again = seen.find((x) => x.attempt === 2)
  assert.ok(again, '拒まれた後に同じ体が出し直す')
  assert.ok(again.problems.some((x) => x.includes('U1:') && x.includes(DIR)), `出し直す体に渡る理由に単位の id と path が無い: ${JSON.stringify(again.problems)}`)
  const L = ledger(s.state)
  assert.deepEqual(L.units.U1.paths, [`${DIR}/b.md`])
  assert.equal(rejections(s.state).length, 1, '拒んだのは 1 回目の 1 件だけ')
})

// 受理（既存の振る舞いが変わらない）: 無い path（新しく作るファイル）、既存のファイル、ディレクトリの中の新しいファイル。
const GOOD = {
  'まだ無い新しいファイル': (us) => { us[0].paths = ['src/new.mjs'] },
  '既存のファイル（src/old.mjs）': (us) => { us[0].paths = ['src/old.mjs', 'src/a.mjs'] },
  '既存のディレクトリの中の既存のファイル': (us) => { us[1].paths = [`${DIR}/a.md`] },
  '既存のディレクトリの中の新しいファイル': (us) => { us[1].paths = [`${DIR}/new.md`] },
  'まだ無いディレクトリの下の新しいファイル（tests も）': (us) => { us[0].paths = ['lib/deep/a.mjs']; us[0].tests = ['lib/deep/a.test.mjs'] },
}
for (const [name, mutate] of Object.entries(GOOD)) {
  test(`受理する: ${name}を持つ方式設計は拒まれず、台帳に単位が作られ、最後まで進む`, async (t) => {
    const s = prepare(t)
    const { stop } = await drive(s.state, mockAgent({ architect: architect(mutate) }))
    assert.equal(stop && stop.stop, 'complete', JSON.stringify(stop))
    assert.deepEqual(rejections(s.state), [], '拒んだ提出が無い')
    const expected = defaultUnits(['AC1', 'D1'])
    mutate(expected)
    const L = ledger(s.state)
    for (const u of expected) {
      assert.deepEqual(L.units[u.id].paths, u.paths, `${u.id} の paths`)
      assert.deepEqual(L.units[u.id].tests, u.tests, `${u.id} の tests`)
    }
  })
}

// ---------------- 祖先と子（a と a/...）----------------
// 純粋な照合（checkArch）。まだ無い path どうしでも、一方が他方の祖先なら拒む。理由に両方の path と単位の id を含める。
const ctx = { coverIds: ['AC1'], inputs: [] }
const archOfUnits = (mutate) => { const us = defaultUnits(['AC1']); mutate(us); return archOf({ cover_ids: ['AC1'], input_paths: [] }, us) }
const problemsOf = (mutate) => C.checkArch(archOfUnits(mutate), ctx)

test('祖先: 基準の方式設計（祖先を持たない）は checkArch を通る', () => {
  assert.deepEqual(problemsOf(() => {}), [])
})

const ANCESTOR = {
  '同じ単位の paths の中': { ids: ['U1'], paths: ['src/a', 'src/a/b.mjs'], mutate: (us) => { us[0].paths = ['src/a', 'src/a/b.mjs'] } },
  '同じ単位の paths と tests': { ids: ['U1'], paths: ['test', 'test/a.test.mjs'], mutate: (us) => { us[0].paths = ['test/a.test.mjs']; us[0].tests = ['test'] } },
  '別の単位どうし（U1 が祖先、U2 が子）': { ids: ['U1', 'U2'], paths: ['lib', 'lib/x.md'], mutate: (us) => { us[0].paths = ['lib']; us[1].paths = ['lib/x.md'] } },
  '別の単位どうし（子を先に挙げる）': { ids: ['U1', 'U2'], paths: ['lib/x.md', 'lib'], mutate: (us) => { us[0].paths = ['lib/x.md', 'src/a.mjs']; us[1].paths = ['lib'] } },
  '孫（祖先と 2 段下）': { ids: ['U1'], paths: ['a', 'a/b/c.mjs'], mutate: (us) => { us[0].paths = ['a', 'a/b/c.mjs'] } },
}
for (const [name, { ids, paths, mutate }] of Object.entries(ANCESTOR)) {
  test(`祖先: ${name}は、両方がまだ無い path でも checkArch が拒み、理由に両方の path と単位の id を含める`, () => {
    const ps = problemsOf(mutate)
    assert.ok(ps.length > 0, '拒まれなかった')
    const hit = ps.find((x) => paths.every((q) => x.includes(q)) && ids.every((id) => x.includes(id)))
    assert.ok(hit, `両方の path（${paths.join(', ')}）と単位の id（${ids.join(', ')}）を含む理由が無い: ${JSON.stringify(ps)}`)
  })
}

const NOT_ANCESTOR = {
  '接頭辞が同じだけの path（a/b と a/bc）': (us) => { us[0].paths = ['a/b', 'a/bc'] },
  '拡張子の手前まで同じ path（src/a.mjs と src/a.test.mjs）': (us) => { us[0].paths = ['src/a.mjs', 'src/a.test.mjs'] },
  '別の単位の接頭辞だけ同じ path（lib/x と lib/xy.md）': (us) => { us[0].paths = ['lib/x']; us[1].paths = ['lib/xy.md'] },
  '同じ親の下の兄弟（lib/a と lib/b）': (us) => { us[0].paths = ['lib/a.mjs']; us[1].paths = ['lib/b.md'] },
}
for (const [name, mutate] of Object.entries(NOT_ANCESTOR)) {
  test(`祖先でない: ${name}は拒まない`, () => {
    assert.deepEqual(problemsOf(mutate), [])
  })
}

test('祖先: ARCH_INVARIANTS に、単位の path が別の path の祖先であってはならない旨の文が載る', () => {
  const hit = C.ARCH_INVARIANTS.filter((x) => /祖先/.test(x))
  assert.equal(hit.length, 1, `祖先を扱う不変条件が 1 つ載る: ${JSON.stringify(C.ARCH_INVARIANTS)}`)
  assert.ok(/paths/.test(hit[0]) && /tests/.test(hit[0]), `欄の語（paths・tests）を使う: ${hit[0]}`)
})

test('祖先: 提出（submit）でも、まだ無い lib と lib/x.md を別の単位が持つ方式設計は理由に両方の path と id を載せて拒まれ、方式設計が stuck になる', async (t) => {
  const s = prepare(t)
  const { stop } = await drive(s.state, mockAgent({ architect: architect((us) => { us[0].paths = ['lib']; us[1].paths = ['lib/x.md'] }) }))
  const rs = rejections(s.state)
  assert.equal(rs.length, MAX_ATTEMPTS, JSON.stringify(rs))
  for (const r of rs) for (const x of ['U1', 'U2', 'lib/x.md', 'lib']) assert.ok(r.includes(x), `理由に ${x} が無い: ${r}`)
  assert.deepEqual(Object.keys(ledger(s.state).units), [])
  assert.ok(stop && stop.code === 0 && stop.stop === 'needs_input' && JSON.stringify(stop.stuck) === '["arch"]', JSON.stringify(stop))
})

// ---------------- 既存のファイルの下の path ----------------
test('既存のファイルの下の path（src/old.mjs/x.mjs）は拒まない（ENOTDIR はディレクトリでない扱い）', async (t) => {
  const s = prepare(t)
  const { stop } = await drive(s.state, mockAgent({ architect: architect((us) => { us[1].paths = ['src/old.mjs/x.md'] }) }), { maxSteps: 2 })
  assert.ok(!stop || stop.code === 0, JSON.stringify(stop))
  assert.deepEqual(rejections(s.state), [], '拒んだ提出が無い')
  assert.deepEqual(ledger(s.state).units.U2.paths, ['src/old.mjs/x.md'], '方式設計が受理され、単位ができる')
})
