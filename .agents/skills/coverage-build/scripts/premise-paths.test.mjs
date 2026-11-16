// 詳細設計の役に、前提（premises）に引ける path を伝える（P15）。
// 束（unit の brief）に、取り込みが premises を照らす集合（readable）と同じ path の一覧を載せ、役の prompt に使い方の 2 点を載せる。
// 一覧の節は、見出しに「premises」を含む節（`## ...premises...`）として探す。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditStatus, defaultUnits, drive, idsIn, inputsOf, mockAgent, repoOf, setup } from './test-harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'build.json'), 'utf8'))
const briefAt = (args, ref) => readFileSync(path.join(args.snapDir, ref.path), 'utf8')
const briefOfPrompt = (p) => readFileSync(/Read で (\S+) を全て読む/.exec(p)[1], 'utf8')
const firstLine = (f) => readFileSync(f, 'utf8').split('\n').find((l) => l.trim().length >= 14) || readFileSync(f, 'utf8').trim()

// 束の「premises に引ける path」の節（見出しに premises を含む `## ` の節）の本文と、その中の `- <path>` の行。
function premiseSection(brief) {
  const m = /^## [^\n]*premises[^\n]*\n/m.exec(brief)
  if (!m) return null
  const rest = brief.slice(m.index + m[0].length)
  const e = rest.indexOf('\n## ')
  const body = e < 0 ? rest : rest.slice(0, e)
  return { body, list: [...body.matchAll(/^- (.+)$/gm)].map((x) => x[1].trim()) }
}

// U1 は既にある src/old.mjs と、まだ無い src/a.mjs を持つ。U2 は既にある src/other.mjs と、まだ無い docs/a.md を持つ。
const archWithExisting = (p) => {
  const brief = briefOfPrompt(p)
  const [u1, u2] = defaultUnits(['AC1', 'D1'])
  return {
    units: [{ ...u1, paths: ['src/a.mjs', 'src/old.mjs'] }, { ...u2, paths: ['docs/a.md', 'src/other.mjs'] }],
    inputs_read: inputsOf(brief).map((f) => ({ path: f, quotes: [firstLine(f)] })), inputs_not_read: [], questions: [], contracts: [], copies: [],
  }
}
const prepare = (t, opts) => {
  const s = setup(t, opts)
  mkdirSync(path.join(s.repo, 'src'), { recursive: true })
  writeFileSync(path.join(s.repo, 'src', 'other.mjs'), 'export const other = 3 // 別の既にあるファイルの本文の行\n')
  return s
}
// 設計を流し、設計レビューが指摘を 1 件返して詳細設計をやり直させる。全ての設計の呼び出しの args と、役の prompt を返す。
async function runDesigns(t, { mode = 'create', over = {} } = {}) {
  const s = prepare(t, { mode })
  const log = []
  let n = 0
  const audit = (phase) => (phase === 'design' && n++ === 0
    ? auditStatus({ phase, confirmed: [{ path: path.join(s.state, 'design', 'U1.md'), quote: '入力を受け取り、決まった値を返す。', layer: '詳細設計' }] })
    : auditStatus({ phase }))
  const { steps, stop } = await drive(s.state, mockAgent({ architect: archWithExisting, ...over }, log), { audit })
  const designs = steps.filter((x) => x.step === 'design')
  return {
    ...s, log, steps, stop, designs,
    first: designs.find((x) => x.args.arch).args,
    redo: designs.find((x) => !x.args.arch && x.args.units.length).args,
  }
}
const material = (s) => path.join(s.d, 'material.md')

test('束: 詳細設計だけをやり直す呼び出しの unit の brief に、premises に引ける path の一覧を載せる（入力・既にある単位のファイル。まだ無いファイルは載せない）', async (t) => {
  const r = await runDesigns(t)
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  for (const u of r.redo.units) {
    const sec = premiseSection(briefAt(r.redo, u.brief))
    assert.ok(sec, `${u.unit_id}: 束に premises の path の節が無い`)
    assert.ok(sec.list.includes(material(r)), `${u.unit_id}: 入力は絶対 path で載せる: ${JSON.stringify(sec.list)}`)
    for (const p of ['src/old.mjs', 'src/other.mjs']) assert.ok(sec.list.includes(p), `${u.unit_id}: 既にある単位のファイルは repo からの相対 path で載せる: ${p}`)
    for (const p of ['src/a.mjs', 'docs/a.md']) assert.ok(!sec.body.includes(p), `${u.unit_id}: まだ無いファイルは載せない: ${p}`)
    assert.ok(!sec.list.includes(path.join(r.repo, 'src', 'old.mjs')), `${u.unit_id}: 単位のファイルを絶対 path では載せない（別の path では照合に落ちる）`)
    assert.ok(sec.list.every((p) => !p.startsWith(r.state)), `${u.unit_id}: stateDir の中のファイルは載せない`)
  }
})

test('束: update では対象（絶対 path）も一覧に載せる', async (t) => {
  const r = await runDesigns(t, { mode: 'update' })
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  const target = path.join(r.repo, 'src', 'old.mjs')
  for (const u of r.redo.units) {
    const sec = premiseSection(briefAt(r.redo, u.brief))
    assert.ok(sec, `${u.unit_id}: 節が無い`)
    assert.ok(sec.list.includes(target), `${u.unit_id}: 対象は絶対 path で載せる: ${JSON.stringify(sec.list)}`)
    assert.ok(sec.list.includes(material(r)) && sec.list.includes('src/other.mjs'), `${u.unit_id}: 入力と単位のファイルも載せる`)
  }
})

test('束: 方式設計と同じ呼び出しで作る詳細設計の束（unitBrief）は、入力と対象の絶対 path だけを載せ、単位のファイルは規則の文で伝える', async (t) => {
  for (const mode of ['create', 'update']) {
    const r = await runDesigns(t, { mode })
    const sec = premiseSection(briefAt(r.first, r.first.arch.unitBrief))
    assert.ok(sec, `${mode}: 束に premises の path の節が無い`)
    assert.ok(sec.list.includes(material(r)), `${mode}: 入力を載せる`)
    assert.equal(sec.list.includes(path.join(r.repo, 'src', 'old.mjs')), mode === 'update', `${mode}: 対象は update のときだけ載せる`)
    assert.ok(sec.list.every((p) => path.isAbsolute(p)), `${mode}: 単位が決まっていないので、相対 path は載せない: ${JSON.stringify(sec.list)}`)
    assert.ok(/paths/.test(sec.body) && /tests/.test(sec.body) && /既に/.test(sec.body), `${mode}: 単位の paths・tests のうち既にあるもの、と規則の文で伝える: ${sec.body}`)
  }
})

test('束: 一覧の path は取り込みが premises を照らす集合と同じで、一覧の全ての path を premises に引くと取り込める', async (t) => {
  const pick = (p, opts) => {
    const brief = briefOfPrompt(p)
    const sec = premiseSection(brief)
    const id = opts.label.slice('design-'.length)
    const premises = (sec ? sec.list : []).map((x) => ({ claim: `${x} の本文`, path: x, quote: firstLine(path.isAbsolute(x) ? x : path.join(repoOf(brief), x)) }))
    return { unit_id: id, spec: '入力を受け取り、決まった値を返す。', acceptance: ['値を返す'], behaviors: [{ text: '値を返す', accepts: [1], rows: [] }], partitions: [], premises, unverified: [], allowed_optional: [], cases: [{ condition: '入力が 1', expect: '2 を返す', accepts: [1], covers: [] }] }
  }
  const r = await runDesigns(t, { over: { design: pick } })
  assert.equal(r.stop && r.stop.stop, 'complete', JSON.stringify(r.stop))
  for (const d of r.designs) assert.ok(!d.ingest.rejected, JSON.stringify(d.ingest.rejected))
  const L = ledger(r.state)
  const redoList = premiseSection(briefAt(r.redo, r.redo.units[0].brief)).list
  assert.ok(redoList.length >= 3, `一覧が空に近い: ${JSON.stringify(redoList)}`)
  for (const id of ['U1', 'U2']) assert.deepEqual(L.units[id].premises.map((x) => x.path).sort(), [...redoList].sort(), `${id}: 一覧の全ての path が取り込まれる`)
})

test('prompt: 詳細設計の役に、前提の path は束の一覧のままに書くこと（別の path は照合に落ちる）と、一覧に無いものは unverified に崩れたときの扱いと書くことを載せる', async (t) => {
  const r = await runDesigns(t)
  const prompts = r.log.filter((x) => x.label.startsWith('design-')).map((x) => x.prompt)
  assert.ok(prompts.length >= 2 + 2, '方式設計と同じ呼び出しの 2 件と、やり直しの 2 件')
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

test('args: path の一覧を載せない（束に入れる）。unitDefs は id・kind・rows だけ', async (t) => {
  const r = await runDesigns(t)
  for (const [name, args] of [['方式設計と同じ呼び出し', r.first], ['やり直し', r.redo]]) {
    const text = JSON.stringify(args)
    for (const s of ['src/other.mjs', 'src/old.mjs']) assert.ok(!text.includes(s), `${name}: args に単位のファイルの path を載せない: ${s}`)
    assert.ok(!/premise|readable/i.test(text), `${name}: args に一覧の欄を持たない`)
  }
  for (const d of Object.values(r.redo.unitDefs)) assert.deepEqual(Object.keys(d).sort(), ['id', 'kind', 'rows'])
})

test('文書: references/ledger.md に、詳細設計の束へ premises に引ける path の一覧が入ることを書く', () => {
  const doc = readFileSync(path.join(HERE, '..', 'references', 'ledger.md'), 'utf8')
  const hit = doc.split('\n').filter((l) => /束/.test(l) && /一覧/.test(l) && /前提/.test(l))
  assert.ok(hit.length >= 1, 'ledger.md に、束に前提へ引ける path の一覧が入ることを書いた行が無い')
  const limit = doc.split('\n').findIndex((l) => /詳細設計の前提に、入力・対象・単位が持つファイルのどれでもない/.test(l))
  const at = doc.split('\n').findIndex((l) => /束/.test(l) && /一覧/.test(l) && /前提/.test(l))
  assert.ok(Math.abs(at - limit) <= 2, `前提の限界を書いた行（${limit + 1}）の近くに寄せる（今は ${at + 1} 行目）`)
})
