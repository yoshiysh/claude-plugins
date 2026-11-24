// 詳細設計の役に、前提（premises）に引ける path を伝える（P15）。
// 詳細設計の役の query の inputs.premise_paths に、submit が premises を照らす集合（readable）と同じ path の一覧を載せ、役の prompt に使い方の 2 点を載せる。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { archOf, auditStatus, defaultUnits, drive, mockAgent, redoMark, setup } from './test-harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8'))
const firstLine = (f) => readFileSync(f, 'utf8').split('\n').find((l) => l.trim().length >= 14) || readFileSync(f, 'utf8').trim()

// U1 は既にある src/old.mjs と、まだ無い src/a.mjs を持つ。U2 は既にある src/other.mjs と、まだ無い docs/a.md を持つ。
const archWithExisting = (p, o) => {
  const [u1, u2] = defaultUnits(['AC1', 'D1'])
  return archOf(o.inputs, [{ ...u1, paths: ['src/a.mjs', 'src/old.mjs'] }, { ...u2, paths: ['docs/a.md', 'src/other.mjs'] }])
}
const prepare = (t, opts) => {
  const s = setup(t, opts)
  mkdirSync(path.join(s.repo, 'src'), { recursive: true })
  writeFileSync(path.join(s.repo, 'src', 'other.mjs'), 'export const other = 3 // 別の既にあるファイルの本文の行\n')
  return s
}
// 設計を流し、設計レビューが指摘を 1 件返して詳細設計をやり直させる。詳細設計の役の担当ごとの記録（最初の詳細設計 first と、やり直し redo）を返す。
async function runDesigns(t, { mode = 'create', over = {} } = {}) {
  const s = prepare(t, { mode })
  const log = []
  let n = 0
  const audit = (phase) => (phase === 'design' && n++ === 0
    ? auditStatus({ phase, confirmed: [{ path: path.join(s.state, 'design', 'U1.md'), quote: '入力を受け取り、決まった値を返す。', layer: '詳細設計' }] })
    : auditStatus({ phase }))
  const { steps, stop } = await drive(s.state, mockAgent({ architect: archWithExisting, ...over }, log), { audit })
  const specs = log.filter((x) => x.role === 'unit_designer')
  return { ...s, log, steps, stop, designs: steps.filter((x) => x.step === 'design'), first: specs.slice(0, 2), redo: specs.slice(2) }
}
const material = (s) => path.join(s.d, 'material.md')

test('query: 詳細設計をやり直す担当の inputs.premise_paths に、premises に引ける path の一覧を載せる（入力・既にある単位のファイル。まだ無いファイルは載せない）', async (t) => {
  const r = await runDesigns(t)
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  assert.deepEqual(r.redo.map((x) => x.inputs.unit.id), ['U1', 'U2'])
  for (const x of r.redo) {
    const list = x.inputs.premise_paths
    const id = x.inputs.unit.id
    assert.ok(list.includes(material(r)), `${id}: 入力は絶対 path で載せる: ${JSON.stringify(list)}`)
    for (const p of ['src/old.mjs', 'src/other.mjs']) assert.ok(list.includes(p), `${id}: 既にある単位のファイルは repo からの相対 path で載せる: ${p}`)
    for (const p of ['src/a.mjs', 'docs/a.md']) assert.ok(!list.some((y) => y.endsWith(p)), `${id}: まだ無いファイルは載せない: ${p}`)
    assert.ok(!list.includes(path.join(r.repo, 'src', 'old.mjs')), `${id}: 単位のファイルを絶対 path では載せない（別の path では照合に落ちる）`)
    assert.ok(list.every((p) => !p.startsWith(r.state)), `${id}: stateDir の中のファイルは載せない`)
  }
})

test('query: update では対象（絶対 path）も一覧に載せる', async (t) => {
  const r = await runDesigns(t, { mode: 'update' })
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  const target = path.join(r.repo, 'src', 'old.mjs')
  for (const x of r.redo) {
    const list = x.inputs.premise_paths
    assert.ok(list.includes(target), `${x.inputs.unit.id}: 対象は絶対 path で載せる: ${JSON.stringify(list)}`)
    assert.ok(list.includes(material(r)) && list.includes('src/other.mjs'), `${x.inputs.unit.id}: 入力と単位のファイルも載せる`)
  }
})

test('query: 方式設計の次の呼び出しの詳細設計（最初の詳細設計）も、単位が決まった後の一覧（既にある単位のファイルを相対 path で）を受ける', async (t) => {
  for (const mode of ['create', 'update']) {
    const r = await runDesigns(t, { mode })
    for (const x of r.first) {
      const list = x.inputs.premise_paths
      assert.ok(list.includes(material(r)), `${mode}: 入力を載せる`)
      assert.equal(list.includes(path.join(r.repo, 'src', 'old.mjs')), mode === 'update', `${mode}: 対象（絶対 path）は update のときだけ載せる`)
      assert.ok(list.includes('src/old.mjs') && list.includes('src/other.mjs'), `${mode}: 単位の既にあるファイルを相対 path で載せる: ${JSON.stringify(list)}`)
    }
  }
})

test('query: 一覧の path は submit が premises を照らす集合と同じで、一覧の全ての path を premises に引くと受理される', async (t) => {
  const pick = (p, o) => {
    const q = o.inputs
    const premises = q.premise_paths.map((x) => ({ claim: `${x} の本文`, path: x, quote: firstLine(path.isAbsolute(x) ? x : path.join(q.repo, x)) }))
    // やり直しの担当は中身を変える（本物の coverage-audit は中身の同じ単位の指摘を持ち越す）。
    return { unit_id: q.unit.id, spec: `入力を受け取り、決まった値を返す。${redoMark(q)}`, acceptance: ['値を返す'], behaviors: [{ text: '値を返す', accepts: [1], rows: [] }], partitions: [], premises, unverified: [], allowed_optional: [], cases: [{ condition: '入力が 1', expect: '2 を返す', accepts: [1], covers: [] }] }
  }
  const r = await runDesigns(t, { over: { design: pick } })
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  for (const d of r.designs) assert.ok(!d.ingest.rejected, JSON.stringify(d.ingest.rejected))
  const L = ledger(r.state)
  const redoList = r.redo[0].inputs.premise_paths
  assert.ok(redoList.length >= 3, `一覧が空に近い: ${JSON.stringify(redoList)}`)
  for (const id of ['U1', 'U2']) assert.deepEqual(L.units[id].premises.map((x) => x.path).sort(), [...redoList].sort(), `${id}: 一覧の全ての path が取り込まれる`)
})

test('prompt: 詳細設計の役に、前提の path は inputs の一覧のままに書くこと（別の path は照合に落ちる）と、一覧に無いものは unverified に崩れたときの扱いと書くことを載せる', async (t) => {
  const r = await runDesigns(t)
  const prompts = [...new Set(r.log.filter((x) => x.role === 'unit_designer').map((x) => x.prompt))]
  assert.equal(prompts.length, 2, '最初の詳細設計の 1 体と、やり直しの 1 体')
  for (const p of prompts) {
    const lines = p.split('\n')
    const same = lines.find((l) => /premises/.test(l) && /一覧/.test(l) && /そのまま/.test(l))
    assert.ok(same, `path を一覧のままに書く指示が無い: ${p.slice(0, 200)}`)
    assert.ok(/別の path|同じファイルでも|落ち/.test(same), `理由（別の path では照合に落ちる）が無い: ${same}`)
    const out = lines.find((l) => /一覧に無い/.test(l) && /unverified/.test(l))
    assert.ok(out, '一覧に無いものを unverified に書く指示が無い')
    assert.ok(/崩れ/.test(out), `崩れたときの扱いと一緒に書く指示が無い: ${out}`)
  }
})

test('文書: references/ledger.md に、詳細設計の役の query の入力へ premises に引ける path の一覧が入ることを書く', () => {
  const doc = readFileSync(path.join(HERE, '..', 'references', 'ledger.md'), 'utf8')
  const hit = doc.split('\n').filter((l) => /query/.test(l) && /premise_paths/.test(l) && /一覧/.test(l) && /前提/.test(l))
  assert.ok(hit.length >= 1, 'ledger.md に、query の入力（premise_paths）に前提へ引ける path の一覧が入ることを書いた行が無い')
  const limit = doc.split('\n').findIndex((l) => /詳細設計の前提に、入力・対象・単位が持つファイルのどれでもない/.test(l))
  const at = doc.split('\n').findIndex((l) => /query/.test(l) && /premise_paths/.test(l) && /一覧/.test(l) && /前提/.test(l))
  assert.ok(Math.abs(at - limit) <= 2, `前提の限界を書いた行（${limit + 1}）の近くに寄せる（今は ${at + 1} 行目）`)
})
