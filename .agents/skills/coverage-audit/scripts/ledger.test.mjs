import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { C, MAX_ASSET_LINES, MAX_ATTEMPTS, MAX_BLOCKS, findingId, retroAssets, splitAssets } from './ledger-core.mjs'
import { WF, cli, constraintIdsOf, drive, evidenceOf, goalsOf, groupItems, indexIds, lensAnswers, lensIdOf, mockAgent, runWorkflow, tmp, unitAnswers } from './test-harness.mjs'

const DOC = `# 対象の文書

## 一つ目の節
この節は一つ目の主張を述べる本文の行である。
二行目もこの節の主張を補う本文の行として置く。

## 二つ目の節
この節は二つ目の主張を述べる本文の行である。
二行目もこの節の主張を補う本文の行として置く。
`

function setup(t, extra = [], doc = DOC) {
  const d = tmp(t)
  writeFileSync(path.join(d, 'doc.md'), doc)
  writeFileSync(path.join(d, 'goal.md'), '- G1: 対象の文書の見落としを観点ごとに確かめた指摘の一覧 〔request: 対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい〕\n')
  writeFileSync(path.join(d, 'request.md'), '対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい')
  writeFileSync(path.join(d, 'lenses.json'), JSON.stringify([{ id: 'L1', name: '主張と根拠', procedure: '主張ごとに根拠の文を対応づけ、根拠の無い主張を探す' }]))
  const state = path.join(d, 'state')
  const r = cli('init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md'), '--lenses', path.join(d, 'lenses.json'), ...extra)
  assert.equal(r.code, 0, JSON.stringify(r))
  return { d, state, doc: path.join(d, 'doc.md') }
}
const ledger = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))
// args の写しはファイル名、枡の id は対象の基準からの相対で載る。
const snapFile = (args, r) => `${args.snapDir}${r.snapshot}`
const finding = (claim, quote, layer = '実装') => ({ claim, quote, severity: 'MEDIUM', layer })
const readWith = (findingsFor) => (prompt, opts) => {
  const cell = opts.label.slice('read-'.length).split('（')[0]
  const fs = findingsFor(cell, prompt)
  if (fs === undefined) return undefined
  return { cell_id: cell, evidence: evidenceOf(prompt), findings: fs, outside_notes: [], none_reason: fs.length ? '' : '該当なし' }
}

test('資産: 見出しの経路とブロックの種類・序数が ID で、前に行が増えても変わらない節は同じ ID と hash', () => {
  const a = splitAssets('/x/doc.md', DOC)
  const b = splitAssets('/x/doc.md', `前置きの行を足した\n\n${DOC}`)
  const pick = (xs) => Object.fromEntries(xs.map((x) => [x.id, x.hash]))
  assert.deepEqual(Object.keys(pick(a)), ['/x/doc.md#対象の文書/一つ目の節/p1', '/x/doc.md#対象の文書/二つ目の節/p1'])
  for (const [id, h] of Object.entries(pick(a))) assert.equal(pick(b)[id], h, `${id} は前に行を足しても同じ hash`)
  const long = splitAssets('/x/a.txt', Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'))
  assert.deepEqual(long.map((x) => [x.id, x.start]), [['/x/a.txt#c1', 1], ['/x/a.txt#c2', 81], ['/x/a.txt#c3', 161]])
  assert.ok(long.every((x) => x.need === x.blocks.length && x.need >= 1))
})

// 資産の切り方（計画 3）。期待は計画から取る。範囲は 1 始まり・両端を含み、資産の本文はその範囲の行そのもの。
const rangeOk = (rel, text, xs) => {
  const lines = text.split('\n')
  for (const x of xs) assert.equal(x.text, lines.slice(x.start - 1, x.end).join('\n'), `${x.id} の本文は範囲の行`)
}
const MD_BLOCKS = [
  '---', //  1
  'title: 例の文書', //  2
  'tags: [a, b]', //  3
  '---', //  4
  '前置きの段落はここに十分な長さで書いておく。', //  5
  '', //  6
  '# 文書', //  7
  '', //  8
  '## 目次', //  9
  '- [一つ目](#一つ目)', // 10
  '- [二つ目](#二つ目)', // 11
  '', // 12
  '## 一つ目', // 13
  '最初の段落の一行目はここに書く。', // 14
  '最初の段落の二行目はここに続く。', // 15
  '', // 16
  '- 箇条書きの一つ目の項目である', // 17
  '- 箇条書きの二つ目の項目である', // 18
  '', // 19
  '| 列 | 値 |', // 20
  '|---|---|', // 21
  '| あ | い |', // 22
  '', // 23
  '```sh', // 24
  '# 注釈の行で見出しではない', // 25
  'echo hi', // 26
  '```', // 27
  '', // 28
  '二つ目の段落はコードの後に置く。', // 29
  '', // 30
  '## 見出しだけの節', // 31
  '', // 32
  '## 二つ目', // 33
  '二つ目の節の段落の本文である。', // 34
  '', // 35
  '## 混ざった節', // 36
  '説明の段落を先に置いてからリンクを並べる。', // 37
  '', // 38
  '- [外のリンク](https://example.com)', // 39
  '', // 40
  '## 混ざった箇条書き', // 41
  '- [一つ目](#一つ目)', // 42
  '- リンクでない普通の項目である', // 43
  '',
].join('\n')

test('資産（Markdown）: 節の中を段落・箇条書き・表・コードのブロックに切り、id は見出しの経路 + 種類と序数（種類ごとに数える）', () => {
  const xs = splitAssets('/x/doc.md', MD_BLOCKS)
  const P = '/x/doc.md#'
  assert.deepEqual(xs.map((x) => [x.id, x.start, x.end]), [
    [`${P}_frontmatter`, 1, 4],
    [`${P}_top/p1`, 5, 5],
    [`${P}文書/一つ目/p1`, 14, 15],
    [`${P}文書/一つ目/list1`, 17, 18],
    [`${P}文書/一つ目/table1`, 20, 22],
    [`${P}文書/一つ目/code1`, 24, 27],
    [`${P}文書/一つ目/p2`, 29, 29],
    [`${P}文書/二つ目/p1`, 34, 34],
    [`${P}文書/混ざった節/p1`, 37, 37],
    [`${P}文書/混ざった節/list1`, 39, 39],
    [`${P}文書/混ざった箇条書き/list1`, 42, 43],
  ], '目次（リンクだけの箇条書きの節）・見出しだけの節・本文の無い節は資産を作らない。リンクと段落・普通の項目が混ざる節は資産にする')
  rangeOk('/x/doc.md', MD_BLOCKS, xs)
  // 種類は id の接尾辞の語と同じ。frontmatter は frontmatter。
  const kind = Object.fromEntries(xs.map((x) => [x.id.slice(P.length), x.kind]))
  assert.equal(kind._frontmatter, 'frontmatter')
  assert.deepEqual([kind['文書/一つ目/p1'], kind['文書/一つ目/list1'], kind['文書/一つ目/table1'], kind['文書/一つ目/code1']], ['p', 'list', 'table', 'code'])
  assert.ok(xs.every((x) => x.need === x.blocks.length && x.need >= 1), '区画の式（withBlocks）はそのまま')
})

test('資産（Markdown）: code fence の中の # は見出しにせず、fence の後の本当の見出しは見出しにする', () => {
  const xs = splitAssets('/x/doc.md', MD_BLOCKS)
  assert.ok(xs.every((x) => !x.id.includes('注釈')), xs.map((x) => x.id).join('\n'))
  assert.ok(xs.some((x) => x.id === '/x/doc.md#文書/一つ目/p2'), 'fence の後の段落は同じ節に残る')
  assert.ok(xs.some((x) => x.id === '/x/doc.md#文書/二つ目/p1'), 'fence の後の本当の見出しは節を作る')
  const code = xs.find((x) => x.id === '/x/doc.md#文書/一つ目/code1')
  assert.ok(code.text.includes('# 注釈の行で見出しではない'), 'fence の中の # の行はコードの資産の本文')
})

test('資産（Markdown）: 前に段落を足しても、同じ節の同じブロックは同じ id と hash。節の中で前に別の種類を足しても序数は変わらない', () => {
  const pick = (xs) => Object.fromEntries(xs.map((x) => [x.id, x.hash]))
  const a = pick(splitAssets('/x/doc.md', MD_BLOCKS))
  const before = pick(splitAssets('/x/doc.md', MD_BLOCKS.replace('前置きの段落はここに', '足した段落の本文はここに置く。\n\n前置きの段落はここに')))
  for (const [id, h] of Object.entries(a)) if (id.includes('#文書/')) assert.equal(before[id], h, `${id} は _top に段落を足しても同じ`)
  assert.ok(before['/x/doc.md#_top/p2'], '_top の段落は序数で並ぶ')
  const list = pick(splitAssets('/x/doc.md', MD_BLOCKS.replace('## 一つ目\n', '## 一つ目\n- 前に足した箇条書きの項目である\n\n')))
  assert.equal(list['/x/doc.md#文書/一つ目/p1'], a['/x/doc.md#文書/一つ目/p1'], '箇条書きを前に足しても p1 は p1 のまま')
  assert.equal(list['/x/doc.md#文書/一つ目/p2'], a['/x/doc.md#文書/一つ目/p2'])
})

test('資産（Markdown）: 見出しの無い文書は _top の下でブロックに切り、frontmatter だけの文書は frontmatter の資産だけ', () => {
  const plain = ['見出しの無い文書の最初の段落である。', '', '- 見出しの無い文書の箇条書きの項目', '', '見出しの無い文書の二つ目の段落である。', ''].join('\n')
  const xs = splitAssets('/x/plain.md', plain)
  assert.deepEqual(xs.map((x) => [x.id, x.start, x.end]), [['/x/plain.md#_top/p1', 1, 1], ['/x/plain.md#_top/list1', 3, 3], ['/x/plain.md#_top/p2', 5, 5]])
  rangeOk('/x/plain.md', plain, xs)
  const fm = ['---', 'name: 例', 'description: frontmatter だけの文書', '---', ''].join('\n')
  const ys = splitAssets('/x/fm.md', fm)
  assert.deepEqual(ys.map((x) => [x.id, x.start, x.end, x.kind]), [['/x/fm.md#_frontmatter', 1, 4, 'frontmatter']])
  const fmBody = `${fm}frontmatter の後に見出しの無い本文の段落を置く。\n`
  assert.deepEqual(splitAssets('/x/fb.md', fmBody).map((x) => [x.id, x.start, x.end]), [['/x/fb.md#_frontmatter', 1, 4], ['/x/fb.md#_top/p1', 5, 5]])
})

test('引用の照合: code fence の中の # で始まる行は見出しと見なさず引用でき、fence の外の見出しだけの引用は今のまま拒否する', () => {
  const text = '## 外の見出しの文字列はここに十分な長さで\n```sh\n# 設定の例を示すコメントの行である\necho hi\n```\n本文の行はここに十分な長さで続いていく。'
  assert.equal(C.quoteProblem('# 設定の例を示すコメントの行である', text), null)
  assert.equal(C.quoteProblem('設定の例を示すコメントの行である', text), null)
  assert.match(C.quoteProblem('外の見出しの文字列はここに十分な長さで', text), /見出しだけ/)
})

const JS_DECLS = [
  "import { x } from './x.mjs'", //  1
  '', //  2
  'export const meta = {', //  3
  "  name: 'm',", //  4
  '}', //  5
  '', //  6
  'function alpha(a) {', //  7
  '  return a + 1', //  8
  '}', //  9
  '', // 10
  'class Beta {', // 11
  '  go() { return 1 }', // 12
  '}', // 13
  '', // 14
  'export function gamma() {', // 15
  '  return 2', // 16
  '}', // 17
  '', // 18
  'const delta = (v) => v * 2', // 19
  '',
].join('\n')
// 空でない行は、どれか 1 つの資産にちょうど 1 回入る（JS は宣言の境目で切るので、読む本文を落とさない）。
const coversOnce = (text, xs) => {
  text.split('\n').forEach((l, i) => {
    if (!l.trim()) return
    const n = xs.filter((x) => x.start <= i + 1 && i + 1 <= x.end).length
    assert.equal(n, 1, `${i + 1} 行目「${l}」は資産にちょうど 1 回入る（${n} 回）`)
  })
}

test('資産（JS・MJS）: トップレベルの宣言の境目で切り、id は宣言の名前。宣言の無い所は行の塊', () => {
  const xs = splitAssets('/x/m.mjs', JS_DECLS)
  const by = Object.fromEntries(xs.map((x) => [x.id, x]))
  assert.deepEqual(xs.map((x) => x.id), ['/x/m.mjs#c1', '/x/m.mjs#meta', '/x/m.mjs#alpha', '/x/m.mjs#Beta', '/x/m.mjs#gamma', '/x/m.mjs#delta'])
  assert.deepEqual(['c1', 'meta', 'alpha', 'Beta', 'gamma', 'delta'].map((k) => by[`/x/m.mjs#${k}`].start), [1, 3, 7, 11, 15, 19])
  for (const [k, last] of [['meta', 5], ['alpha', 9], ['Beta', 13], ['gamma', 17], ['delta', 19]]) assert.ok(by[`/x/m.mjs#${k}`].end >= last, `${k} の範囲は本体の最後の行まで届く`)
  coversOnce(JS_DECLS, xs)
  rangeOk('/x/m.mjs', JS_DECLS, xs)
  assert.ok(xs.every((x) => x.need === x.blocks.length && x.need >= 1))
  const js = splitAssets('/x/m.js', JS_DECLS).map((x) => x.id)
  assert.deepEqual(js, ['/x/m.js#c1', '/x/m.js#meta', '/x/m.js#alpha', '/x/m.js#Beta', '/x/m.js#gamma', '/x/m.js#delta'], '.js も同じ')
})

test('資産（JS・MJS）: 前に行が増えても、宣言の id と hash は変わらない', () => {
  const pick = (xs) => Object.fromEntries(xs.map((x) => [x.id, x.hash]))
  const a = pick(splitAssets('/x/m.mjs', JS_DECLS))
  const b = pick(splitAssets('/x/m.mjs', `import { y } from './y.mjs'\nimport { z } from './z.mjs'\n${JS_DECLS}`))
  for (const k of ['meta', 'alpha', 'Beta', 'gamma', 'delta']) {
    assert.ok(a[`/x/m.mjs#${k}`], `${k} がある`)
    assert.equal(b[`/x/m.mjs#${k}`], a[`/x/m.mjs#${k}`], `${k} は前に行が増えても同じ id と hash`)
  }
})

test('資産（JS・MJS）: テンプレート文字列とブロックコメントの中の、行頭から始まる function・export・const の行では切らない', () => {
  const src = [
    'const T = `', //  1
    'function notReal() {}', //  2
    'export const notX = 1', //  3
    'const notY = 2', //  4
    '`', //  5
    '', //  6
    '/*', //  7
    'export function notZ() {}', //  8
    'const notW = 3', //  9
    '*/', // 10
    '', // 11
    'function real() {', // 12
    '  return T', // 13
    '}', // 14
    '',
  ].join('\n')
  for (const rel of ['/x/t.js', '/x/t.mjs']) {
    const xs = splitAssets(rel, src)
    const ids = xs.map((x) => x.id.slice(rel.length + 1))
    for (const bad of ['notReal', 'notX', 'notY', 'notZ', 'notW']) assert.ok(!ids.includes(bad), `${rel}: ${bad} は宣言でない（${ids.join(',')}）`)
    const T = xs.find((x) => x.id === `${rel}#T`)
    assert.ok(T && T.start === 1 && T.end >= 5, `${rel}: T の範囲は閉じる \` の行まで届く`)
    const real = xs.find((x) => x.id === `${rel}#real`)
    assert.ok(real && real.text.includes('function real() {') && real.end >= 14, `${rel}: 本当の宣言 real は資産になる（${ids.join(',')}）`)
    coversOnce(src, xs)
    rangeOk(rel, src, xs)
  }
})

test('資産（JS）: この repo の coverage-audit.js は宣言の名前で切れ、行頭から始まる長いテンプレート文字列の中で切れない', () => {
  const text = readFileSync(WF, 'utf8')
  const xs = splitAssets(WF, text)
  const ids = xs.map((x) => x.id.slice(WF.length + 1))
  assert.equal(new Set(ids).size, ids.length, 'id は一意')
  coversOnce(text, xs)
  const has = (k) => ids.some((i) => i === k || i.startsWith(`${k}/c`))
  for (const k of ['meta', 'LIMITS', 'quoteProblem', 'COMMON', 'planStage', 'reviewStage']) assert.ok(has(k), `${k} の資産がある（${ids.slice(0, 12).join(',')}…）`)
  assert.equal(xs[0].id, `${WF}#meta`)
  assert.equal(xs[0].start, 1)
  // 行頭から始まるテンプレート文字列の中の行で切っていれば、宣言でない語が id になる。id は全て、本文の行頭の宣言の名前か行の塊。
  const declared = new Set([...text.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]))
  for (const i of ids) assert.ok(declared.has(i.split('/')[0].split('~')[0]) || /^c\d+$/.test(i), `${i} は宣言の名前か行の塊`)
})

test('資産（JS）: 宣言の無い .js は今の行数の塊', () => {
  const xs = splitAssets('/x/n.js', Array.from({ length: 200 }, (_, i) => `// line ${i}`).join('\n'))
  assert.deepEqual(xs.map((x) => [x.id, x.start]), [['/x/n.js#c1', 1], ['/x/n.js#c2', 81], ['/x/n.js#c3', 161]])
})

test('索引: 計画役の索引は 1 行 1 資産の 6 欄（id・写し・範囲・見出しの経路・種類・先頭の数語）で、タブ・短い資産・経路の無い資産でも欄が崩れない', (t) => {
  const d = tmp(t)
  const doc = path.join(d, 'doc.md')
  const code = path.join(d, 'code.mjs')
  const docText = ['---', 'title: 索引の例', '---', '前置きの段落はここに置く本文である。', '', '# 索引の文書', '', '## 節の一', 'タブを\t含む段落の本文はここに置いて欄を崩さない。', '', '## 節の二', '短い。', ''].join('\n')
  const codeText = ['export function alpha() {', '  return 1', '}', ''].join('\n')
  writeFileSync(doc, docText)
  writeFileSync(code, codeText)
  writeFileSync(path.join(d, 'goal.md'), '- G1: 対象の文書の見落としを観点ごとに確かめた指摘の一覧 〔request: 対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい〕\n')
  writeFileSync(path.join(d, 'request.md'), '対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい')
  const state = path.join(d, 'state')
  const r = cli('init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', doc, '--target', code)
  assert.equal(r.code, 0, JSON.stringify(r))
  const n = cli('next', '--state', state)
  assert.equal(n.step, 'plan', JSON.stringify(n))
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  assert.ok(args.index, '最初の plan は索引を持つ')
  const rows = readFileSync(snapFile(args, args.index), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'))
  for (const f of rows) assert.equal(f.length, 6, `欄は 6 つ: ${JSON.stringify(f)}`)
  const L = ledger(state)
  const ids = Object.keys(L.assets).filter((id) => !L.assets[id].retro)
  assert.deepEqual(rows.map((f) => f[0]).sort(), [...ids].sort(), '1 行 1 資産で、先頭の欄は資産の id')
  const row = (suffix) => { const f = rows.find((x) => x[0].endsWith(suffix)); assert.ok(f, `${suffix} の行がある（${rows.map((x) => x[0]).join(',')}）`); return f }
  const fm = row('doc.md#_frontmatter')
  const top = row('doc.md#_top/p1')
  const tab = row('doc.md#索引の文書/節の一/p1')
  const shortRow = row('doc.md#索引の文書/節の二/p1')
  const decl = row('code.mjs#alpha')
  // 写しと範囲の欄（今のまま）。
  assert.match(tab[1], /\.txt$/)
  assert.equal(tab[2], '9-9')
  assert.equal(shortRow[2], '12-12')
  // 見出しの経路の欄: 節のブロックは経路を持ち、_top・frontmatter・JS の宣言は空。
  assert.ok(tab[3].includes('索引の文書') && tab[3].includes('節の一'), tab[3])
  for (const f of [fm, top, decl]) assert.equal(f[3], '', `${f[0]} は見出しの経路を持たない`)
  // 種類の欄。
  assert.equal(tab[4], 'p')
  assert.equal(fm[4], 'frontmatter')
  assert.ok(decl[4].length > 0)
  // 先頭の数語の欄: norm した本文の一部で空でなく、短い資産は全文。タブは欄を崩さない（6 欄の照合）。
  const texts = Object.fromEntries([...splitAssets(ids.find((i) => i.includes('doc.md#')).split('#')[0], docText), ...splitAssets(ids.find((i) => i.includes('code.mjs#')).split('#')[0], codeText)].map((a) => [a.id, a.text]))
  for (const f of [fm, top, tab, shortRow, decl]) {
    assert.ok(f[5].length > 0, `${f[0]} の先頭の数語は空でない`)
    assert.ok(C.norm(texts[f[0]]).includes(f[5]), `${f[0]} の先頭の数語「${f[5]}」は本文から取る`)
  }
  assert.ok(C.norm(texts[tab[0]]).startsWith(tab[5]), '先頭から取る')
  assert.equal(shortRow[5], '短い。', '短い資産は全文')
})

test('振り返りの資産: 多数の出来事は 1 段でも本文の上限ごとに分け、引用を求める区画は通常の資産と同じ上限', () => {
  const events = Array.from({ length: 300 }, (_, i) => ({ id: `E1-${i + 1}`, cycle: 1, stage: 'review', kind: 'missing_read', text: i === 7 ? `二行に渡る出来事 ${i}\n続きの行` : `枡 ${i} の読みが返らなかった出来事` }))
  const ra = retroAssets({ cycle: 1, events })
  assert.equal(ra.length, Math.ceil(300 / MAX_ASSET_LINES))
  assert.equal(new Set(ra.map((a) => a.id)).size, ra.length)
  assert.ok(ra.every((a) => a.text.split('\n').length <= MAX_ASSET_LINES && a.need <= MAX_BLOCKS && a.need === a.blocks.length))
  assert.equal(ra.reduce((n, a) => n + a.text.split('\n').length, 0), 300, '1 出来事 1 行で、全ての出来事がどれかの資産にある')
  assert.ok(ra.some((a) => a.text.includes('二行に渡る出来事 7 / 続きの行')))
  assert.ok(events.every((e) => e.retro === 1))
  const one = retroAssets({ cycle: 2, events: [{ id: 'E2-1', cycle: 2, stage: 'plan', kind: 'blocked', text: '計画の段が止まった出来事' }] })
  assert.deepEqual(one.map((a) => [a.id, a.need]), [['retro:c2:plan', 1]])
})

test('引用の照合: 短い・無い・見出しだけは読んだ証拠にならず、行番号は外して照らす', () => {
  const text = '# 見出しの文字列はここに十分な長さで\n本文の一行目はこのように続いていく。'
  assert.match(C.quoteProblem('短い', text), /字未満/)
  assert.match(C.quoteProblem('本文に無い長い文字列をここに書く', text), /逐語で無い/)
  assert.match(C.quoteProblem('見出しの文字列はここに十分な長さで', text), /見出しだけ/)
  assert.equal(C.quoteProblem('2| 本文の一行目はこのように', text), null)
  assert.equal(C.quoteProblem('     2\t本文の一行目はこのように', text), null, 'Read の行番号の形も外す')
  const short = '前の行の本文はここまでの長さで続く。\n  記録と持ち越し  \n後の行の本文はここからの長さで続く。'
  assert.equal(C.quoteProblem('記録と持ち越し', short), null, '範囲の空でない 1 行の全体なら短くてよい')
  assert.equal(C.quoteProblem('82| 記録と持ち越し', short), null, '行番号を付けた 1 行の全体も同じ')
  assert.match(C.quoteProblem('記録と持ち', short), /字未満/, '行の一部の短い引用は拒否する')
  assert.match(C.quoteProblem('前の行の本文', short), /字未満/, '長い行の一部の短い引用も拒否する')
  const asset = { cell_id: 'c', text: Array.from({ length: 80 }, (_, i) => `これは ${i} 行目の本文の文字列です`).join('\n'), blocks: [[0, 39], [40, 79]], need: 2 }
  const half = { cell_id: 'c', evidence: ['これは 1 行目の本文の文字列です'], findings: [], outside_notes: [], none_reason: 'なし' }
  assert.match(C.checkRead(half, asset).join(), /2 区画のうち 1 区画/)
  assert.deepEqual(C.checkRead({ ...half, evidence: [...half.evidence, 'これは 70 行目の本文の文字列です'] }, asset), [])
})

test('検証不能: 偽の引用での棄却・確定は指摘を消さず unverifiable にする', () => {
  assert.equal(C.settleVerdict({ verdict: 'refuted', quote: '本文に無い偽の引用の文字列', reason: 'r' }, '本文の文字列はこれだけ'), 'unverifiable')
  assert.equal(C.settleVerdict({ verdict: 'refuted', quote: '本文の文字列はこれだけ', reason: 'r' }, '本文の文字列はこれだけ'), 'refuted')
})

test('正常: 目標の照合 → 全ての枡を読み確かめ → 振り返り → 完了。役ごとのモデル・effort を記録する', async (t) => {
  const { state } = setup(t)
  const log = []
  const { stop, steps } = await drive(state, mockAgent({}, log))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(steps.map((s) => s.step), ['plan', 'review'])
  const L = ledger(state)
  assert.equal(stop.coverage.cells, 6) // 2 資産 × 3 観点（purpose・layer・L1）× k=1。見出しだけの塊は資産にしない
  assert.equal(stop.coverage.settled, 6)
  assert.equal(stop.coverage.settled_with_verifier, 0, '指摘の無い枡は検証役を通っていないと数える')
  assert.ok(L.goal.checked)
  assert.ok(L.agents.every((a) => a.model && a.effort && a.role))
  assert.equal(L.calls[0].tokens, null)
  assert.match(L.calls[0].tokens_note, /読めない/)
  assert.ok(log.every((x) => !x.prompt.includes('一つ目の主張を述べる') && !x.prompt.includes('二つ目の主張を述べる')), 'prompt に対象の本文を載せない（担当が写しを読む）')
  assert.ok(steps.every((s) => !JSON.stringify(s.args).includes('主張を述べる')), 'args に対象の本文を載せない')
})

// 束ね役は、型の当たる資産を applies_to に返す（ここでは指摘の where。台帳の資産の id）。
test('横展開: 確かめた欠陥の型を、束ね役が返した型の当たる資産（applies_to）にだけ新しい観点として問い直す', async (t) => {
  const { state } = setup(t)
  const lateral = []
  let where = null
  const agentFn = mockAgent({
    read: readWith((cell) => (cell.endsWith('一つ目の節/p1|L1|p1') ? [finding('根拠が無い主張', 'この節は一つ目の主張を述べる本文の行である。')] : (cell.includes('|lat-') ? (lateral.push(cell), []) : undefined))),
    group: (prompt) => {
      const items = groupItems(prompt)
      where = items[0].where
      return { groups: [{ id: 'g1', root_cause: '根拠を書かない', layer: '実装', keys: items.map((x) => x.key), pattern: '主張ごとに根拠を対応づけ、根拠の無い主張を探す（横展開）', applies_to: [where] }], unassigned: [] }
    },
  })
  const { stop } = await drive(state, agentFn)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const L = ledger(state)
  assert.equal(L.groups[0].status, 'kept')
  const lat = L.lenses.find((l) => l.id === 'lat-G1-g1')
  assert.ok(lat, '横展開の観点を作る')
  assert.deepEqual(lat.applies_to, [where], '横展開の観点は束ね役が返した資産だけに当たる')
  assert.equal(lateral.length, 1, '横展開の観点は applies_to の資産だけを読む（全ての資産に一律には当てない）')
  assert.ok(lateral[0].includes('一つ目の節'))
  const latCells = Object.entries(L.cells).filter(([id, c]) => id.includes('|lat-') && c.status !== 'gone')
  assert.deepEqual(latCells.map(([, c]) => c.asset), [where])
  assert.equal(L.saturation[0].confirmed_new, 1)
})

test('横展開: pattern があるのに applies_to を返さない束ねは受け付けず（rejected_grouping）、横展開の観点を作らない', async (t) => {
  const { state } = setup(t)
  const agentFn = mockAgent({
    read: readWith((cell) => (cell.endsWith('一つ目の節/p1|L1|p1') ? [finding('根拠が無い主張', 'この節は一つ目の主張を述べる本文の行である。')] : undefined)),
    group: (prompt) => ({ groups: [{ id: 'g1', root_cause: '根拠を書かない', layer: '実装', keys: groupItems(prompt).map((x) => x.key), pattern: '主張ごとに根拠を対応づけ、根拠の無い主張を探す（横展開）' }], unassigned: [] }),
  })
  await drive(state, agentFn)
  const L = ledger(state)
  assert.ok(L.events.some((e) => e.kind === 'rejected_grouping'), JSON.stringify(L.events.map((e) => e.kind)))
  assert.ok(!L.lenses.some((l) => l.id.startsWith('lat-')), 'applies_to の無い型を全ての資産へ倒さない')
  assert.ok(!Object.keys(L.cells).some((id) => id.includes('|lat-')))
})

test('横展開の照合: pattern のある群は applies_to が空でなく実在する資産だけを挙げる。pattern の無い群の空の applies_to は受け付ける', () => {
  const keys = C.groupKeys(1)
  const rep = (g) => ({ groups: [{ id: 'g1', root_cause: '根の原因', layer: '実装', keys, ...g }], unassigned: [] })
  const assetIds = ['a#1', 'a#2']
  assert.deepEqual(C.checkGroups(rep({ pattern: '型の手続き', applies_to: ['a#1'] }), keys, assetIds), [])
  assert.deepEqual(C.checkGroups(rep({ pattern: '', applies_to: [] }), keys, assetIds), [])
  assert.ok(C.checkGroups(rep({ pattern: '型の手続き', applies_to: [] }), keys, assetIds).some((x) => x.includes('g1')), '型があるのに当てる資産が無い')
  assert.ok(C.checkGroups(rep({ pattern: '型の手続き' }), keys, assetIds).some((x) => x.includes('g1')), 'applies_to の欄が無い')
  assert.ok(C.checkGroups(rep({ pattern: '型の手続き', applies_to: ['a#9'] }), keys, assetIds).some((x) => x.includes('a#9') && /実在しない/.test(x)))
})

test('欠測: 返らない枡は試行を数え、上限で開示に倒し、他の枡は確かめて完了する', async (t) => {
  const { state } = setup(t)
  const target = '#対象の文書/二つ目の節/p1|L1|p1'
  const { stop } = await drive(state, mockAgent({ read: (p, o) => (o.label.includes(target) ? null : undefined) }))
  assert.equal(stop.stop, 'complete')
  assert.equal(stop.disclosed.length, 1)
  assert.ok(stop.disclosed[0].endsWith(target))
  const L = ledger(state)
  assert.equal(L.cells[stop.disclosed[0]].attempts, MAX_ATTEMPTS)
  assert.ok(L.events.some((e) => e.kind === 'missing_read'))
})

test('不正な出力: 偽の引用の読みは受け付けず、読み直す', async (t) => {
  const { state } = setup(t)
  let n = 0
  const { stop } = await drive(state, mockAgent({ read: (p, o) => (o.label.includes('一つ目の節/p1|purpose') && n++ < 1 ? { cell_id: o.label.slice(5).split('（')[0], evidence: ['本文に無い引用をここに書いている'], findings: [], outside_notes: [], none_reason: 'x' } : undefined) }))
  assert.equal(stop.stop, 'complete')
  const L = ledger(state)
  const c = Object.entries(L.cells).find(([id]) => id.includes('一つ目の節/p1|purpose'))[1]
  assert.equal(c.status, 'settled')
  assert.equal(c.attempts, 1, '偽の引用は ingest が写しに照らして落とし、試行に数えて次の呼び出しで読み直す')
  assert.ok(L.events.some((e) => e.kind === 'rejected_read'))
})

test('枡の id: 読む役が cell_id を切り詰めて返しても、script の持つ id で受け付ける', async (t) => {
  const { state } = setup(t)
  const { stop } = await drive(state, mockAgent({ read: (p, o) => {
    const cell = o.label.slice('read-'.length).split('（')[0]
    return { cell_id: cell.slice(-20), evidence: evidenceOf(p), findings: [], outside_notes: [], none_reason: '該当なし' }
  } }))
  assert.equal(stop.stop, 'complete')
  const L = ledger(state)
  assert.ok(Object.values(L.cells).every((c) => c.status === 'settled' && c.attempts === 0), JSON.stringify(Object.values(L.cells).map((c) => [c.status, c.attempts, c.problems])))
  assert.ok(!L.events.some((e) => e.kind === 'rejected_read'))
})

test('検証役の却下: 検証が揃わない枡は読みを保って検証の待ち行列に残り、次で確かめられる', async (t) => {
  const { state } = setup(t)
  let v = 0
  const agentFn = mockAgent({
    read: readWith((cell) => (cell.endsWith('一つ目の節/p1|L1|p1') ? [finding('根拠が無い主張', 'この節は一つ目の主張を述べる本文の行である。')] : undefined)),
    // 1 回目の検証役は提出しない（worker の形では、枡ごとの欠けが 1 回の試行）。
    verify: (p, o) => (o.label.startsWith('verify-unit-') ? undefined : v++ < 1 ? null : undefined),
  })
  const { stop, steps } = await drive(state, agentFn)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(steps.filter((s) => s.step === 'review').length >= 2)
  const L = ledger(state)
  const id = Object.keys(L.cells).find((k) => k.endsWith('一つ目の節/p1|L1|p1'))
  assert.equal(L.cells[id].status, 'settled')
  assert.equal(L.cells[id].verifier, true)
  assert.equal(Object.values(L.findings).filter((f) => f.status === 'current' && f.verdict === 'confirmed').length, 1)
})

test('全件失敗: 全ての役が欠けた呼び出しが続けば blocked で、complete にしない', async (t) => {
  const { state } = setup(t)
  const dead = async () => null
  const { stop } = await drive(state, dead)
  assert.equal(stop.stop, 'blocked')
  assert.equal(stop.cause, 'failure')
  const L = ledger(state)
  assert.ok(Object.entries(L.attempts).every(([k, n]) => L.env_attempts[k] === n), '環境の失敗による試行は区別して数える')
  assert.ok(Object.values(L.cells).every((c) => (c.env_attempts || 0) === c.attempts))
  const again = await drive(state, mockAgent())
  assert.equal(again.stop.stop, 'complete', '原因を直して再開した run は読み直して完了する')
  assert.deepEqual(again.stop.disclosed, [])
})

test('検証不能: 検証不能の指摘は消えず、完了にせず needs_input で返す', async (t) => {
  const { state } = setup(t)
  const agentFn = mockAgent({
    read: readWith((cell) => (cell.endsWith('二つ目の節/p1|purpose|p1') ? [finding('目標に効かない', 'この節は二つ目の主張を述べる本文の行である。')] : undefined)),
    verify: (p, o) => (o.label.startsWith('verify-unit-') ? undefined : { verdicts: [{ index: 0, verdict: 'refuted', reason: '違う', quote: '偽の引用で反証しようとしている文字列' }] }),
  })
  const { stop } = await drive(state, agentFn)
  assert.equal(stop.stop, 'needs_input')
  assert.equal(stop.unverifiable.length, 1)
  const a = cli('answer', '--state', state, '--id', stop.unverifiable[0], '--text', '費用をかけずに既知の未確認として残す')
  assert.equal(a.code, 0)
  assert.equal(cli('next', '--state', state).stop, 'complete')
})

test('同じ枡の複数の指摘: 種別が同じでも引用か主張が違えば別の指摘として残る', async (t) => {
  const { state } = setup(t)
  const two = [finding('一つ目の欠陥', 'この節は一つ目の主張を述べる本文の行である。'), finding('二つ目の欠陥', '二行目もこの節の主張を補う本文の行として置く。')]
  await drive(state, mockAgent({ read: readWith((cell) => (cell.endsWith('一つ目の節/p1|L1|p1') ? two : undefined)) }))
  const L = ledger(state)
  const ids = Object.keys(L.findings).filter((k) => k.includes('一つ目の節/p1|L1|p1'))
  assert.equal(ids.length, 2)
  assert.notEqual(findingId('c', two[0]), findingId('c', two[1]))
})

test('上の層: 方針・要求が原因の欠陥はcomplete にせず needs_input で返す（直すのは呼ぶ側）', async (t) => {
  const { state } = setup(t)
  const { stop } = await drive(state, mockAgent({ read: readWith((cell) => (cell.endsWith('一つ目の節/p1|purpose|p1') ? [finding('要求が足りない', 'この節は一つ目の主張を述べる本文の行である。', '要求')] : undefined)) }))
  assert.equal(stop.stop, 'needs_input')
  assert.equal(stop.upper.length, 1)
})

test('持ち越し: 変わった節の枡だけ古い印が付いて読み直され、消えた対象は blocked', async (t) => {
  const { state, doc } = setup(t)
  const log = []
  assert.equal((await drive(state, mockAgent({}, log))).stop.stop, 'complete')
  writeFileSync(doc, DOC.replace('二つ目の主張を述べる', '二つ目の主張を書き換えて述べる'))
  const before = log.length
  const { stop } = await drive(state, mockAgent({}, log))
  assert.equal(stop.stop, 'complete')
  const reread = log.slice(before).filter((x) => x.label.startsWith('read-')).map((x) => x.label)
  assert.equal(reread.length, 3, '変わった 1 節 × 3 観点だけ')
  assert.ok(reread.every((l) => l.includes('二つ目の節')))
  rmSync(doc)
  const n = cli('next', '--state', state)
  assert.equal(n.stop, 'blocked')
  assert.equal(n.cause, 'input')
})

test('数の引数: 正の整数でない --k・上限は init も config も Fail（終了状態 2）で、台帳を変えない', (t) => {
  const { d, state } = setup(t)
  const base = ['--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md')]
  for (const [k, v] of [['k', '0'], ['k', 'abc'], ['max-cycles', '1.5'], ['max-cycles', '-1'], ['max-agents-total', 'NaN'], ['k', '1e2'], ['k', '']]) {
    const s2 = path.join(d, `state-${k}-${v}`)
    const r = cli('init', '--state', s2, ...base, `--${k}`, v)
    assert.equal(r.code, 2, `${k}=${v}: ${JSON.stringify(r)}`)
    assert.ok(!existsSync(path.join(s2, 'ledger.json')), `${k}=${v} で台帳を作らない`)
  }
  const before = ledger(state).config
  for (const [k, v] of [['max-cycles', '0'], ['max-agents-total', 'NaN'], ['max-cycles', '2.5']]) assert.equal(cli('config', '--state', state, `--${k}`, v).code, 2, `${k}=${v}`)
  assert.deepEqual(ledger(state).config, before)
  assert.equal(cli('config', '--state', state, '--max-cycles', '7').config.max_cycles, 7)
})

test('受け取り: 待っている呼び出しと違う結果は受け付けない（古い run の遅れた書き込みを防ぐ）', async (t) => {
  const { state, d } = setup(t)
  const n = cli('next', '--state', state)
  writeFileSync(path.join(d, 'r.json'), JSON.stringify({ stage: n.step, call_id: 'deadbeef0000', agents: [] }))
  const g = cli('ingest', '--state', state, '--result', path.join(d, 'r.json'))
  assert.equal(g.code, 2)
  assert.match(g.error, /呼び出しが違う/)
  assert.equal(cli('next', '--state', state).call_id, n.call_id, '同じ状態からの next は同じ呼び出しを返す（運び直せる）')
})

test('ingest: native Workflow の出力ファイル（result に包んだ形）をそのまま受け付け、包みに似た形は包みとして外さない', async (t) => {
  const { state, d } = setup(t)
  const n = cli('next', '--state', state)
  const res = await runWorkflow(JSON.parse(readFileSync(n.args_path, 'utf8')), mockAgent())
  const before = readFileSync(path.join(state, 'ledger.json'), 'utf8')
  // 包みの印（summary が文字列・agentCount が数）が欠けた形は外さず、呼び出しが違うとして拒否し、台帳を変えない。
  for (const [name, near] of [['no-count', { summary: 'done', result: res }], ['str-count', { summary: 'done', agentCount: '3', result: res }], ['no-summary', { agentCount: 3, result: res }]]) {
    writeFileSync(path.join(d, `${name}.json`), JSON.stringify(near))
    const g = cli('ingest', '--state', state, '--result', path.join(d, `${name}.json`))
    assert.equal(g.code, 2, name)
    assert.match(g.error, /呼び出しが違う/, name)
  }
  assert.equal(readFileSync(path.join(state, 'ledger.json'), 'utf8'), before)
  writeFileSync(path.join(d, 'task.output'), JSON.stringify({ summary: 'coverage-audit-step を流した', agentCount: res.agents.length, logs: [], result: res }))
  const g = cli('ingest', '--state', state, '--result', path.join(d, 'task.output'))
  assert.equal(g.code, 0, JSON.stringify(g))
  // 包んでいない返り値も今どおり受け付ける。
  const n2 = cli('next', '--state', state)
  writeFileSync(path.join(d, 'plain.json'), JSON.stringify(await runWorkflow(JSON.parse(readFileSync(n2.args_path, 'utf8')), mockAgent())))
  assert.equal(cli('ingest', '--state', state, '--result', path.join(d, 'plain.json')).code, 0)
})

test('束の写し: 束が書き換わったら ingest は台帳を変えずに拒否する', async (t) => {
  const { state, d } = setup(t)
  const n = cli('next', '--state', state)
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  writeFileSync(path.join(d, 'r.json'), JSON.stringify(await runWorkflow(args, mockAgent())))
  writeFileSync(snapFile(args, args.brief), `${readFileSync(snapFile(args, args.brief), 'utf8')}書き足し\n`)
  const before = readFileSync(path.join(state, 'ledger.json'), 'utf8')
  const g = cli('ingest', '--state', state, '--result', path.join(d, 'r.json'))
  assert.equal(g.code, 2)
  assert.match(g.error, /hash が args と違う/)
  assert.equal(readFileSync(path.join(state, 'ledger.json'), 'utf8'), before)
})

test('args の写し: 運ぶ途中で書き換わった args は Workflow が役を起動せずに拒否する', async (t) => {
  const { state } = setup(t)
  const n = cli('next', '--state', state)
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  const log = []
  const res = await runWorkflow({ ...args, criteriaIds: [...args.criteriaIds, 'AC9'] }, mockAgent({}, log))
  assert.equal(res.status, 'blocked')
  assert.match(res.problems.join(), /argsSum/)
  assert.equal(log.length, 0)
})

test('ヒント: 次の呼び出しの全ての役に届き、受け取った後に既読になる', async (t) => {
  const { state } = setup(t)
  assert.equal(cli('hint', '--state', state, '--text', '二つ目の節は特に慎重に').code, 0)
  const log = []
  await drive(state, mockAgent({}, log))
  assert.ok(log[0].prompt.includes('二つ目の節は特に慎重に'))
  assert.deepEqual(ledger(state).hints_read, ['H1'])
  assert.ok(!log.at(-1).prompt.includes('二つ目の節は特に慎重に'))
})

test('上限: 1 回の呼び出しの起動数（workers の行の数）は LIMITS に収まり、枡を切り捨てずに全て確かめる', async (t) => {
  const many = `# 文書\n${Array.from({ length: 12 }, (_, i) => `\n## 節${i}\nこの節 ${i} は本文の行として十分な長さを持っている。`).join('\n')}\n`
  const { state } = setup(t, [], many)
  const { stop, steps } = await drive(state, mockAgent())
  assert.equal(stop.stop, 'complete')
  const reviews = steps.filter((s) => s.step === 'review')
  assert.ok(reviews.length >= 1)
  for (const s of reviews) assert.ok(s.args.workers.length <= C.LIMITS.maxAgents && s.res.agents.length <= C.LIMITS.maxAgents, `${s.args.workers.length} 行・${s.res.agents.length} 体`)
  assert.equal(stop.coverage.settled, stop.coverage.cells)
})


test('持ち越し: complete の後に対象が変わったら周を進め、新しい指摘も振り返りと束ねを通る', async (t) => {
  const { state, doc } = setup(t)
  assert.equal((await drive(state, mockAgent())).stop.stop, 'complete')
  const cycle = ledger(state).cycle
  writeFileSync(doc, DOC.replace('二つ目の主張を述べる', '二つ目の主張を書き換えて述べる'))
  let grouped = []
  const agentFn = mockAgent({
    read: readWith((cell) => (cell.endsWith('二つ目の節/p1|L1|p1') ? [finding('根拠が無い', 'この節は二つ目の主張を書き換えて述べる本文の行である。')] : undefined)),
    group: (p) => { grouped = groupItems(p); return undefined },
  })
  const { stop, steps } = await drive(state, agentFn)
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(steps.map((s) => s.step), ['review', 'group'], '変わった枡を読み、悪かった出来事が無いので振り返りは静的に済み、束ねる')
  assert.equal(grouped.length, 1)
  assert.match(grouped[0].claim, /根拠が無い/)
  const L = ledger(state)
  assert.ok(L.cycle > cycle + 1, '持ち越しの周を開き、束ねの後に次の周へ進む')
  assert.ok(L.retro_cycles.includes(cycle + 1) && L.group_cycles.includes(cycle + 1))
})

test('写し: 取った資産の写しの hash が台帳と違えば submit は台帳を変えずに拒否し、next からやり直すと写しを書き直して確かめられる', async (t) => {
  const { state } = setup(t)
  const first = await drive(state, mockAgent(), { maxSteps: 1 })
  assert.equal(first.steps[0].step, 'plan')
  const n = cli('next', '--state', state)
  assert.equal(n.step, 'review')
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  const w = args.workers.find((x) => x.queue === 'read')
  const c = cli('claim', '--state', state, '--call', n.call_id, '--worker', w.id)
  assert.equal(c.code, 0, JSON.stringify(c))
  const x = c.cells[0]
  mkdirSync(path.dirname(x.result_path), { recursive: true })
  writeFileSync(x.result_path, JSON.stringify({ evidence: evidenceOf(`写し: ${c.asset.file}\n行: ${c.asset.start}-${c.asset.end}`), findings: [], outside_notes: [], none_reason: '該当なし' }))
  writeFileSync(c.asset.file, readFileSync(c.asset.file, 'utf8').replaceAll('主張', '書き換えた主張'))
  const before = readFileSync(path.join(state, 'ledger.json'), 'utf8')
  const g = cli('submit', '--state', state, '--call', n.call_id, '--cell', x.cell_id, '--worker', w.id, '--result', x.result_path)
  assert.equal(g.code, 2)
  assert.match(g.error, /hash/)
  assert.equal(readFileSync(path.join(state, 'ledger.json'), 'utf8'), before)
  // next からやり直すと、書き換わった写しを書き直し、取りを戻した次の呼び出しで確かめられる。
  const again = cli('next', '--state', state)
  assert.equal(again.step, 'review')
  assert.match(readFileSync(c.asset.file, 'utf8'), /一つ目の主張/)
  const { stop } = await drive(state, mockAgent())
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.equal(ledger(state).cells[x.cell_id].status, 'settled')
})

test('args の path: 長い絶対 path の状態ディレクトリと対象でも、args に stateDir と対象の基準はそれぞれ 1 回だけ載る', async (t) => {
  const d = tmp(t)
  const long = (k) => path.join(d, ...Array.from({ length: 8 }, (_, i) => `${k}-${i}-とても長いディレクトリの名前-abcdefghij`))
  const tdir = long('targets')
  const state = long('state')
  assert.ok(tdir.length > 200 && state.length > 200)
  mkdirSync(tdir, { recursive: true })
  const targets = ['a.md', 'b.md'].map((f) => path.join(tdir, f))
  for (const f of targets) writeFileSync(f, DOC)
  writeFileSync(path.join(d, 'goal.md'), '- G1: 対象の文書の見落としを観点ごとに確かめた指摘の一覧 〔request: 対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい〕\n')
  writeFileSync(path.join(d, 'request.md'), '対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい')
  const r = cli('init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), ...targets.flatMap((f) => ['--target', f]))
  assert.equal(r.code, 0, JSON.stringify(r))
  // JSON の文の中の形で数える（Windows の区切り \\ は JSON で \\\\ になる）。
  const count = (s, x) => s.split(JSON.stringify(x).slice(1, -1)).length - 1
  const seen = new Set()
  for (let i = 0; i < 20; i++) {
    const n = cli('next', '--state', state)
    assert.equal(n.code, 0, JSON.stringify(n))
    if (n.stop) break
    seen.add(n.step)
    const raw = readFileSync(n.args_path, 'utf8')
    const args = JSON.parse(raw)
    assert.equal(count(raw, state), 1, `${n.step}: stateDir は 1 回`)
    assert.equal(count(raw, tdir), 1, `${n.step}: 対象の基準は 1 回`)
    for (const f of targets) assert.equal(count(raw, f), 0, `${n.step}: 対象の絶対 path は載らない`)
    if (n.step === 'review') assert.ok(Array.isArray(args.workers) && args.workers.length >= 2, JSON.stringify(args.workers))
    const res = await runWorkflow(args, mockAgent())
    // 資産の id を基準と結合し直せていれば、Workflow の中の applies_to の照合が通り、やり直しが起きない。
    if (n.step === 'plan' && args.index) assert.deepEqual(res.plan_problems, [])
    assert.ok(res.agents.every((a) => !a.label.includes('やり直し')), JSON.stringify(res.agents.map((a) => a.label)))
    const rp = path.join(d, `r-${n.call_id}.json`)
    writeFileSync(rp, JSON.stringify(res))
    const g = cli('ingest', '--state', state, '--result', rp)
    assert.equal(g.code, 0, JSON.stringify(g))
  }
  assert.ok(seen.has('plan') && seen.has('review'), [...seen].join(','))
  // 台帳の枡の id は絶対 path のまま（持ち越しの台帳を壊さない）で、読んだ枡に印が付く。
  const L = ledger(state)
  const ids = Object.keys(L.cells).filter((id) => !id.startsWith('retro:'))
  assert.ok(ids.length && ids.every((id) => targets.some((f) => id.startsWith(`${f}#`))))
  assert.ok(ids.some((id) => L.cells[id].status === 'settled'))
})

test('args の大きさ: 対象が大きくても args は本文を含まず ARGS_MAX_BYTES 以下', async (t) => {
  const ARGS_MAX_BYTES = 32 * 1024
  const MARK = 'ZQX本文の印ZQX'
  const big = `# 大きな文書\n${Array.from({ length: 60 }, (_, i) => `\n## 節${i}\n${Array.from({ length: 30 }, (_, j) => `${MARK} 節 ${i} の ${j} 行目は本文として十分な長さを持つ。`).join('\n')}`).join('\n')}\n`
  const { state } = setup(t, ['--max-agents-total', '5000'], big)
  const { stop, steps } = await drive(state, mockAgent({
    read: readWith((cell, p) => (cell.endsWith('節3/p1|L1|p1') ? [finding('根拠が無い', evidenceOf(p)[0])] : undefined)),
  }), { maxSteps: 200 })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual([...new Set(steps.map((s) => s.step))].sort(), ['group', 'plan', 'review'])
  for (const s of steps) {
    assert.ok(s.argsBytes <= ARGS_MAX_BYTES, `${s.step} の args が ${s.argsBytes} バイト`)
    assert.ok(!JSON.stringify(s.args).includes(MARK), `${s.step} の args に本文が載っている`)
  }
})

// 文の長さ・件数（ヒント・回答・計画の欠陥・指摘）を s 倍にした run を、同じ手順で流す。
// 最初の plan、計画の欠陥でやり直す plan、回答・ヒントの多い plan、目標を answer で直した後の plan、横展開の観点の review、多数の指摘の group を通る。
async function scaledRun(t, s) {
  const M = `ZQX${'利用者の長い文'.repeat(20 * s)}ZQX`
  const d = tmp(t)
  const req = `対象の文書をレビューしてほしい。${M}`
  writeFileSync(path.join(d, 'doc.md'), DOC)
  writeFileSync(path.join(d, 'request.md'), `${req}\n依頼文だけにある一文 RQONLY`)
  writeFileSync(path.join(d, 'goal.md'), `- G1: ${M}の指摘の一覧 〔request: ${req}〕\n`)
  // 受け入れ基準を s 件にし、観点の goals の要素ごとの閉じた問い（Q3）の no で計画の欠陥を s 件以上にする。
  // goals の part は目標・基準の本文（M を含む）なので、part を args に載せれば下の『args に ZQX が無い』の照合で落ちる。
  writeFileSync(path.join(d, 'criteria.md'), Array.from({ length: s }, (_, i) => `- AC${i + 1}: ${M}を満たす${i} 〔request: ${req}〕\n`).join(''))
  writeFileSync(path.join(d, 'decisions.md'), `- ${M}を守る\n`)
  writeFileSync(path.join(d, 'constraints.md'), `- D1: ${M}を守る 〔decisions: ${M}を守る〕\n`)
  const state = path.join(d, 'state')
  const inArgs = ['--goal', 'goal.md', '--request', 'request.md', '--criteria', 'criteria.md', '--decisions', 'decisions.md', '--constraints', 'constraints.md'].map((x, i) => (i % 2 ? path.join(d, x) : x))
  assert.equal(cli('init', '--state', state, ...inArgs, '--target', path.join(d, 'doc.md')).code, 0)
  for (let i = 0; i < s; i++) assert.equal(cli('hint', '--state', state, '--text', `${M}ヒント${i}`).code, 0)
  const proc = `${M}主張ごとに根拠の文を対応づける`
  const lenses = [{ id: 'X1', name: `${M}整合`, procedure: proc }]
  const cmap = (p) => constraintIdsOf(p).map((id) => ({ constraint_id: id, handled_by: ['X1'] }))
  const qs = Array.from({ length: s }, (_, i) => ({ id: `Q${i + 1}`, question: `${M}問${i}`, why_value_judgment: `${M}理由`, options: [`${M}案`] }))
  let unitDefects = true
  let manyFindings = true
  const log = []
  const agentFn = mockAgent({
    plan: (p) => ({ lenses: lenses.map((l) => ({ ...l, applies_to: indexIds(p), goals: goalsOf(p) })), excluded: [], questions: [], constraint_map: cmap(p) }),
    integrate: (p) => {
      const again = p.includes('### 前の計画')
      const defects = p.includes('### 欠陥（index') ? JSON.parse(p.split('### 欠陥（index は配列の位置）\n')[1].split('\n#')[0]) : []
      return { lenses: lenses.map((l) => ({ ...l, applies_to: indexIds(p), goals: goalsOf(p) })), excluded: [], questions: p.includes(`${M}回答`) ? [] : qs, constraint_map: cmap(p), source_map: (again ? ['P:X1'] : ['A:X1', 'B:X1']).map((x) => ({ source: x, merged_into: 'X1', dropped_reason: '' })), defect_responses: defects.map((x) => ({ defect_index: x.index, action: 'fixed', reason: '直した' })) }
    },
    verify: (p, o) => {
      if (!o.label.startsWith('verify-unit-') || !unitDefects) return undefined
      unitDefects = false
      return unitAnswers(p, (k) => k.startsWith('Q3:'))
    },
    read: readWith((cell, p) => {
      if (!manyFindings || !cell.endsWith('一つ目の節/p1|X1|p1')) return undefined
      manyFindings = false
      return Array.from({ length: 3 * s }, (_, i) => finding(`${M}指摘${i}`, evidenceOf(p)[0]))
    }),
    group: (p) => ({ groups: [{ id: 'g1', root_cause: `${M}原因`, layer: '実装', keys: groupItems(p).map((x) => x.key), pattern: `${M}横展開の手続き`, applies_to: [groupItems(p)[0].where] }], unassigned: [] }),
  }, log)
  const calls = []
  let goalFixed = false
  for (let i = 0; i < 40; i++) {
    const n = cli('next', '--state', state)
    assert.equal(n.code, 0, JSON.stringify(n))
    if (n.stop === 'needs_input' && n.questions) {
      for (const q of n.questions) assert.equal(cli('answer', '--state', state, '--id', q.id, '--text', `${M}回答`).code, 0)
      continue
    }
    if (n.stop) { calls.stop = n; break }
    const raw = readFileSync(n.args_path, 'utf8')
    const args = JSON.parse(raw)
    const logStart = log.length
    const res = await runWorkflow(args, agentFn)
    const rp = path.join(state, `result-${n.call_id}.json`)
    writeFileSync(rp, JSON.stringify(res))
    const g = cli('ingest', '--state', state, '--result', rp)
    assert.equal(g.code, 0, JSON.stringify(g))
    const L = ledger(state)
    // 横展開の観点の枡を、この呼び出しの worker が読んだか（枡の一覧は args に載らないので、読む役の label で見る）。
    const lateral = n.step === 'review' && log.slice(logStart).some((x) => /^read-.*\|lat-/.test(x.label))
    calls.push({ step: n.step, raw, bytes: Buffer.byteLength(raw), lateral, defects: L.plan_defects.length, answers: L.answers.length })
    // 回答を計画に取り込んだ後に、目標を answer で直す（目標の照合からやり直す plan を通す）。
    if (!goalFixed && L.answered.length >= s) {
      goalFixed = true
      writeFileSync(path.join(d, 'goal2.md'), `- G1: ${M}の指摘の一覧を直した 〔request: ${req}〕\n`)
      assert.equal(cli('answer', '--state', state, '--id', 'goal', '--file', path.join(d, 'goal2.md')).code, 0)
      calls.at(-1).goalAnswered = true
    }
  }
  return { M, calls, log, L: ledger(state) }
}

test('args の大きさ: 担当が読む文は全て束の写しに入り、args は文の長さ・件数・周の数に比例して増えない', async (t) => {
  const small = await scaledRun(t, 1)
  const big = await scaledRun(t, 20)
  assert.deepEqual(big.calls.map((c) => c.step), small.calls.map((c) => c.step), '同じ手順を通る')
  const steps = big.calls.map((c) => c.step)
  const plans = big.calls.filter((c) => c.step === 'plan').map((c) => ({ ...c, args: JSON.parse(c.raw) }))
  assert.ok(plans[0].args.index && !plans[0].args.prevLensIds.length && !plans[0].args.goalChecked, '最初の plan')
  assert.ok(plans.some((c) => c.args.defectCount >= 20), '計画の欠陥でやり直す plan')
  assert.ok(plans.some((c) => c.args.answerIds.length >= 20), '回答の多い plan')
  const afterGoal = big.calls.findIndex((c) => c.goalAnswered)
  assert.ok(afterGoal >= 0 && big.calls[afterGoal + 1].step === 'plan' && JSON.parse(big.calls[afterGoal + 1].raw).goalIds, '目標を answer で直した後の plan')
  assert.ok(big.calls.some((c) => c.lateral), '横展開の観点の review を通る')
  assert.ok(steps.includes('group'), '束ねを通る')
  assert.ok(big.L.answers.length >= 20 && big.L.groups.length >= 1)
  assert.ok(Object.values(big.L.findings).length >= 60, '多数の指摘を束ねる')
  // 役ごとの束: 計画役・観点の検証役は依頼文・前の欠陥を読まず、目標の照合役は前の計画を読まない。
  const by = (re) => big.log.filter((x) => re.test(x.label))
  assert.ok(by(/^integrate-again/).some((x) => x.prompt.includes('"kind":"Q3"')) && by(/^integrate-again/).some((x) => x.prompt.includes(`${big.M}回答`)), "見直しの統合役は欠陥と回答を読む")
  for (const x of [...by(/^plan-[AB]/), ...by(/^integrate$/), ...by(/^verify-unit-/)]) {
    assert.ok(!x.prompt.includes('RQONLY') && !x.prompt.includes('"kind":"Q3"') && !x.prompt.includes('### 前の計画'), `${x.label} が要らない文を読む`)
  }
  assert.ok(by(/^goal-check/).length >= 2 && by(/^goal-check/).every((x) => x.prompt.includes('RQONLY') && !x.prompt.includes('### 前の計画')))
  for (const [i, c] of big.calls.entries()) {
    assert.ok(!c.raw.includes('ZQX'), `${i}: ${c.step} の args に担当が読む文が載っている（${c.bytes} バイト）`)
    // 件数で増えるのは id と数だけ（文の長さは 20 倍）。
    assert.ok(c.bytes <= small.calls[i].bytes + 2048, `${i}: ${c.step} の args が ${small.calls[i].bytes} から ${c.bytes} バイトに増えた`)
  }
})

test('k=2: 各回の読む役と検証役は別のモデルで起動する', async (t) => {
  const { state } = setup(t, ['--k', '2'])
  const log = []
  const { stop } = await drive(state, mockAgent({ read: readWith((cell) => (cell.endsWith('一つ目の節/p1|L1|p1') || cell.endsWith('一つ目の節/p1|L1|p2') ? [finding('根拠が無い主張', 'この節は一つ目の主張を述べる本文の行である。')] : undefined)) }, log))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  for (const p of [1, 2]) {
    // label の枡の id は対象の基準からの相対。台帳の id の末尾と同じ。
    const id = Object.keys(ledger(state).cells).find((k) => k.endsWith(`一つ目の節/p1|L1|p${p}`))
    const r = log.find((x) => x.label.startsWith('read-') && id.endsWith(x.label.slice('read-'.length)))
    const v = log.find((x) => x.label.startsWith('verify-') && id.endsWith(x.label.slice('verify-'.length)))
    assert.ok(r && v, `p${p} の読みと検証が走る`)
    assert.notEqual(r.model, v.model, `p${p} の読む役と検証役のモデル`)
  }
})

test('init: 外した引数（--mode・--input など）と読めない対象は台帳を作らずに拒否する', (t) => {
  const { d } = setup(t)
  const base = ['--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md')]
  for (const extra of [['--mode', 'review'], ['--input', path.join(d, 'doc.md')], ['--artifact', path.join(d, 'x.md')]]) {
    const s2 = path.join(d, `state${extra[0]}`)
    assert.equal(cli('init', '--state', s2, ...base, ...extra).code, 2, extra[0])
    assert.ok(!existsSync(path.join(s2, 'ledger.json')))
  }
  const s3 = path.join(d, 'state-missing')
  const r = cli('init', '--state', s3, ...base, '--target', path.join(d, 'nothing.md'))
  assert.equal(r.code, 2)
  assert.equal(r.cause, 'input')
  assert.ok(!existsSync(path.join(s3, 'ledger.json')), 'init で読めなければ台帳は作られない')
})

test('計画: 観点の検証が欠陥を出し続けたら、統合のやり直しの上限で needs_input', async (t) => {
  const d = tmp(t)
  writeFileSync(path.join(d, 'doc.md'), DOC)
  writeFileSync(path.join(d, 'goal.md'), '- G1: 対象の文書の見落としを確かめた指摘の一覧 〔request: 対象の文書をレビューしてほしい〕\n')
  writeFileSync(path.join(d, 'request.md'), '対象の文書をレビューしてほしい')
  const state = path.join(d, 'state')
  assert.equal(cli('init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md')).code, 0)
  const log = []
  const { stop } = await drive(state, mockAgent({ verify: (p, o) => (o.label.startsWith('verify-unit-X1') ? unitAnswers(p, (k) => k === 'Q1') : undefined) }, log))
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.deepEqual(stop.plan_defects.map((x) => [x.unit_id, x.kind]), [['X1', 'Q1']], 'no の答えだけが欠陥')
  assert.ok(stop.plan_defects.every((x) => /^P\d+$/.test(x.id)), '計画の欠陥は P<n> の id を持つ')
  const labels = log.map((x) => x.label)
  assert.ok(labels.includes('plan-A') && labels.includes('plan-B') && labels.includes('integrate') && labels.includes('integrate-again'))
  const idx = log.find((x) => x.label === 'plan-A').prompt
  assert.match(idx, /^写し: .*snap/m, '計画役に渡す索引は写しのファイルの参照')
  assert.ok(!idx.includes('一つ目の主張を述べる'))
})

// ---------------- 目標の固定と照合 ----------------
test('init: 引用の無い項目と、依頼文・決定の記録に無い引用を拒否し、台帳を作らない', (t) => {
  const { d } = setup(t)
  const base = (s) => ['--state', path.join(d, s), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md')]
  writeFileSync(path.join(d, 'g-none.md'), '- G1: 対象の文書の見落としを観点ごとに確かめた指摘の一覧\n')
  writeFileSync(path.join(d, 'g-fake.md'), '- G1: 指摘の一覧 〔request: 依頼文のどこにも無い架空の一文である〕\n')
  writeFileSync(path.join(d, 'c-fake.md'), '- D1: 本文を直さない 〔decisions: 本文を直さない〕\n')
  for (const [s, extra, re] of [['none', ['--goal', path.join(d, 'g-none.md')], /G1: 引用が無い/], ['fake', ['--goal', path.join(d, 'g-fake.md')], /逐語で無い/], ['nodec', ['--goal', path.join(d, 'goal.md'), '--constraints', path.join(d, 'c-fake.md')], /D1: 引用元が/]]) {
    const r = cli('init', ...base(s), ...extra)
    assert.equal(r.code, 2, s)
    assert.match(JSON.stringify(r.problems), re, s)
    assert.ok(!existsSync(path.join(d, s, 'ledger.json')))
  }
  writeFileSync(path.join(d, 'decisions.md'), '- 本文を直さない\n')
  assert.equal(cli('init', ...base('dec'), '--goal', path.join(d, 'goal.md'), '--constraints', path.join(d, 'c-fake.md'), '--decisions', path.join(d, 'decisions.md')).code, 0, '決定の記録の 1 行の全体は短くても引ける')
})

test('目標の照合（単独）: 照合役が走り、受け止められていない成果は needs_input で成果と引用を返す。偽の引用は受け付けない', async (t) => {
  const { state } = setup(t)
  const log = []
  const quote = '対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい'
  const { stop } = await drive(state, mockAgent({ goal: () => ({ outcomes: [{ outcome: '確かめた指摘', quotes: [{ source: 'request', quote }], items: [] }] }) }, log))
  assert.ok(log.some((x) => x.label === 'goal-check'), '単独で呼んだときは照合する')
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.deepEqual(stop.goal_gaps, [{ outcome: '確かめた指摘', quotes: [{ source: 'request', quote }] }])
  const { state: s2 } = setup(t)
  const r = await drive(s2, mockAgent({ goal: () => ({ outcomes: [{ outcome: '架空', quotes: [{ source: 'request', quote: '依頼文に無い架空の成果を求める一文' }], items: ['G1'] }] }) }))
  assert.equal(r.stop.stop, 'needs_input')
  assert.deepEqual(r.stop.stuck, ['goal'])
  assert.equal(ledger(s2).goal.checked, false, '偽の引用の照合では合格にしない')
})

test('目標の照合（coverage-build から）: --goal-checked で照合を流さず、引用の無い項目も受け、基準を制約と別の欄に持つ', async (t) => {
  const { d } = setup(t)
  writeFileSync(path.join(d, 'g.md'), '設計が次の目標を満たすかを確かめる。\n\n- G1: 値を計算する関数\n')
  writeFileSync(path.join(d, 'ac.md'), '- AC1: 入力が 1 なら 2 を返す\n- U1A1: 値を返す\n')
  writeFileSync(path.join(d, 'c.md'), '- D1: 依存を足さない\n')
  const state = path.join(d, 'checked')
  const r = cli('init', '--state', state, '--goal', path.join(d, 'g.md'), '--request', path.join(d, 'request.md'), '--criteria', path.join(d, 'ac.md'), '--constraints', path.join(d, 'c.md'), '--target', path.join(d, 'doc.md'), '--goal-checked', 'coverage-build')
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.equal(cli('init', '--state', path.join(d, 'x'), '--goal', path.join(d, 'g.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md'), '--goal-checked', 'someone').code, 2, '印は coverage-build だけ')
  const log = []
  const { stop, steps } = await drive(state, mockAgent({}, log))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(!log.some((x) => x.label.startsWith('goal-check')), '照合を流さない')
  const L = ledger(state)
  assert.deepEqual(L.criteria.map((c) => c.id), ['AC1', 'U1A1'])
  assert.deepEqual(L.constraints.map((c) => c.id), ['D1'])
  const plan = log.find((x) => x.label === 'plan-A').prompt
  assert.match(plan, /受け入れ基準[^\n]*\n {2}- AC1: /)
  assert.ok(steps[0].res.plan.constraint_map.some((m) => m.constraint_id === 'AC1'), '基準にも受け皿の観点を付ける')
})

test('answer: 目標・基準・制約・決定の記録はファイルで直し、引用を照らしてから照合をやり直す', async (t) => {
  const { d, state } = setup(t)
  await drive(state, mockAgent())
  writeFileSync(path.join(d, 'g2.md'), '- G1: 指摘の一覧 〔request: 依頼文のどこにも無い架空の一文である〕\n')
  assert.equal(cli('answer', '--state', state, '--id', 'goal', '--file', path.join(d, 'g2.md')).code, 2)
  assert.equal(ledger(state).goal.checked, true, '拒否した直しは台帳を変えない')
  writeFileSync(path.join(d, 'g3.md'), '- G1: 確かめた指摘の一覧 〔request: 確かめた指摘を返してほしい〕\n')
  assert.equal(cli('answer', '--state', state, '--id', 'goal', '--file', path.join(d, 'g3.md')).code, 0)
  assert.equal(ledger(state).goal.checked, false)
  const log = []
  await drive(state, mockAgent({}, log))
  assert.ok(log.some((x) => x.label === 'goal-check'))
  assert.equal(ledger(state).goal.checked, true)
})

test('引用の短さ: 依頼文の空でない 1 行の全体は短くても引ける。行の一部は引けない', (t) => {
  const { d } = setup(t)
  writeFileSync(path.join(d, 'request.md'), '対象の文書を観点ごとにレビューして、確かめた指摘を返してほしい。\n\n  直してやり直す  \n')
  const src = C.citeSources({ request: readFileSync(path.join(d, 'request.md'), 'utf8') })
  const q = (quote) => C.checkGoalMap({ outcomes: [{ outcome: '成果', quotes: [{ source: 'request', quote }], items: ['G1'] }] }, ['G1'], src)
  assert.deepEqual(q('直してやり直す'), [])
  assert.match(q('直して')[0], /字未満/)
  writeFileSync(path.join(d, 'goal-short.md'), '- G1: 直してやり直す 〔request: 直してやり直す〕\n')
  const r = cli('init', '--state', path.join(d, 'short'), '--goal', path.join(d, 'goal-short.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md'))
  assert.equal(r.code, 0, JSON.stringify(r))
})

test('ingest: 受け付けなかった出力があれば、その理由を出力の rejected に載せる（受け付けたときは載せない）', async (t) => {
  const { state, d } = setup(t)
  const n = cli('next', '--state', state)
  const fake = { outcome: '架空', quotes: [{ source: 'request', quote: '依頼文に無い架空の成果を求める一文' }], items: ['G1'] }
  const res = await runWorkflow(JSON.parse(readFileSync(n.args_path, 'utf8')), mockAgent({ goal: () => ({ outcomes: [fake] }) }))
  writeFileSync(path.join(d, 'bad.json'), JSON.stringify(res))
  const g = cli('ingest', '--state', state, '--result', path.join(d, 'bad.json'))
  assert.equal(g.code, 0, JSON.stringify(g))
  assert.equal(g.ok, true)
  assert.ok(g.rejected.length >= 1 && /目標の照合.*逐語で無い/.test(g.rejected.join('\n')), JSON.stringify(g.rejected))
  const { state: s2, d: d2 } = setup(t)
  const n2 = cli('next', '--state', s2)
  writeFileSync(path.join(d2, 'ok.json'), JSON.stringify(await runWorkflow(JSON.parse(readFileSync(n2.args_path, 'utf8')), mockAgent())))
  const ok = cli('ingest', '--state', s2, '--result', path.join(d2, 'ok.json'))
  assert.equal(ok.code, 0)
  assert.equal(ok.rejected, undefined)
})

test('ingest: Workflow が args を拒否した結果は、呼び出しの違いでなく args の拒否として案内する', async (t) => {
  const { state, d } = setup(t)
  const n = cli('next', '--state', state)
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  const res = await runWorkflow({ ...args, criteriaIds: [...(args.criteriaIds || []), 'AC9'] }, mockAgent())
  assert.equal(res.status, 'blocked')
  writeFileSync(path.join(d, 'r.json'), JSON.stringify(res))
  const g = cli('ingest', '--state', state, '--result', path.join(d, 'r.json'))
  assert.equal(g.code, 2)
  assert.match(g.error, /args を拒否/)
})

test('answer: 質問への回答から作る制約の id は、既にある基準・制約の id と重ならない', async (t) => {
  const { d } = setup(t)
  writeFileSync(path.join(d, 'g.md'), '- G1: 値を計算する関数\n')
  writeFileSync(path.join(d, 'c.md'), '- D1: 依存を足さない\n- A1: coverage-build の回答から来た制約\n')
  const state = path.join(d, 'qa')
  assert.equal(cli('init', '--state', state, '--goal', path.join(d, 'g.md'), '--request', path.join(d, 'request.md'), '--constraints', path.join(d, 'c.md'), '--target', path.join(d, 'doc.md'), '--goal-checked', 'coverage-build').code, 0)
  const qs = [{ id: 'Q1', question: 'どちらにするか', why_value_judgment: '価値の判断', options: ['甲', '乙'] }]
  const base = mockAgent()
  const agentFn = async (prompt, opts) => {
    const r = await base(prompt, opts)
    if (opts.label.startsWith('integrate') && !ledger(state).answers.length) return { ...r, questions: qs }
    return r
  }
  const { stop } = await drive(state, agentFn)
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.deepEqual(stop.questions.map((q) => q.id), ['Q1'])
  assert.equal(cli('answer', '--state', state, '--id', 'Q1', '--text', '甲にする').code, 0)
  const ids = ledger(state).constraints.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length, JSON.stringify(ids))
  assert.deepEqual(ids, ['D1', 'A1', 'A2'])
})

// ---------------- 観点を当てる資産（applies_to） ----------------
// 計画役を走らせる台帳（利用者の観点を渡さない）。
// criteria を渡すと受け入れ基準のファイルを足す（1 行 1 項目。引用は依頼文の全体）。
function setupPlanned(t, doc = DOC, { criteria = [] } = {}) {
  const d = tmp(t)
  writeFileSync(path.join(d, 'doc.md'), doc)
  writeFileSync(path.join(d, 'goal.md'), '- G1: 対象の文書の見落としを確かめた指摘の一覧 〔request: 対象の文書をレビューしてほしい〕\n')
  writeFileSync(path.join(d, 'request.md'), '対象の文書をレビューしてほしい')
  const extra = []
  if (criteria.length) {
    writeFileSync(path.join(d, 'criteria.md'), criteria.map((c) => `- ${c} 〔request: 対象の文書をレビューしてほしい〕\n`).join(''))
    extra.push('--criteria', path.join(d, 'criteria.md'))
  }
  const state = path.join(d, 'state')
  assert.equal(cli('init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md'), ...extra).code, 0)
  return { d, state, doc: path.join(d, 'doc.md') }
}
// 計画役・統合役が、観点 X1 を 1 つ目の資産に、X2 を 2 つ目の資産に当てる計画を返す。どちらの観点も全ての目標・基準を本文の全体で受け持つ。
const splitPlan = (p) => {
  const [a, b] = indexIds(p)
  const goals = goalsOf(p)
  const lenses = [{ id: 'X1', name: '整合', procedure: '主張と根拠を対応づけて食い違いを探す', applies_to: [a], goals }, { id: 'X2', name: '用語', procedure: '用語ごとに定義の文を対応づけ、定義の無い用語を探す', applies_to: [b], goals }]
  const src = p.includes('### 前の計画') ? ['P:X1', 'P:X2'] : [...p.matchAll(/^### ([AB])（/gm)].flatMap((m) => [`${m[1]}:X1`, `${m[1]}:X2`])
  return { lenses, excluded: [], questions: [], constraint_map: constraintIdsOf(p).map((id) => ({ constraint_id: id, handled_by: ['X1'] })), source_map: src.map((s) => ({ source: s, merged_into: s.slice(-2), dropped_reason: '' })), defect_responses: [] }
}

test('applies_to: 枡は観点の数 × 資産の数でなく、当てた組の数（スキルの観点は全ての資産）', async (t) => {
  const { state } = setupPlanned(t)
  const log = []
  const { stop } = await drive(state, mockAgent({ plan: splitPlan, integrate: splitPlan }, log))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const L = ledger(state)
  const assets = Object.keys(L.assets).filter((id) => !L.assets[id].retro)
  assert.equal(assets.length, 2)
  // purpose・layer は 2 資産の全てに、X1・X2 は 1 資産ずつ: 2 × 2 + 1 + 1 = 6（全ての組なら 4 × 2 = 8）。
  assert.equal(stop.coverage.cells, 6)
  const live = Object.entries(L.cells).filter(([, c]) => c.status !== 'gone').map(([id]) => id)
  assert.ok(live.includes(`${assets[0]}|X1|p1`) && live.includes(`${assets[1]}|X2|p1`))
  assert.ok(!live.includes(`${assets[1]}|X1|p1`) && !live.includes(`${assets[0]}|X2|p1`), '当てていない組の枡を作らない')
  assert.ok(!log.some((x) => x.label === `read-${assets[1]}|X1|p1`), '当てていない組は読まない')
  assert.deepEqual(L.lenses.find((l) => l.id === 'X1').applies_to, [assets[0]], '台帳の観点が applies_to を持ち越す')
})

// 全ての資産は、計画の観点の applies_to を合わせたものか excluded の、どちらか一方にちょうど 1 回入る（applies_to には複数の観点から入ってよい）。
test('applies_to と excluded: 全ての資産がどちらか一方にちょうど 1 回入る計画だけを受け付け、重複・両方・どちらにも無い・reason が空・実在しない asset は計画の欠陥', () => {
  const ctx = { constraintIds: [], lensesGiven: false, givenLensIds: [], assetIds: ['a#1', 'a#2', 'a#3'] }
  const lens = (id, applies_to) => ({ id, name: id, procedure: '何かを列挙して照らす', applies_to, goals: [{ id: 'G1', part: '何か' }] })
  const ex = (asset, reason = '目標に関係しない') => ({ asset, reason })
  const plan = (lenses, excluded) => C.checkPlan({ lenses, excluded, questions: [], constraint_map: [] }, ctx)
  const has = (ps, ...res) => ps.some((x) => res.every((r) => (typeof r === 'string' ? x.includes(r) : r.test(x))))
  // 正: 2 つの観点が同じ資産に当たり、残りは excluded。
  assert.deepEqual(plan([lens('X1', ['a#1', 'a#2']), lens('X2', ['a#2'])], [ex('a#3')]), [])
  // 当たらない資産でも excluded にあれば問題にしない。
  assert.deepEqual(plan([lens('X1', ['a#1'])], [ex('a#2'), ex('a#3')]), [])
  const cases = [
    ['どちらにも無い', plan([lens('X1', ['a#1']), lens('X2', ['a#2'])], []), ['a#3', /excluded/]],
    ['両方に入る', plan([lens('X1', ['a#1']), lens('X2', ['a#2'])], [ex('a#3'), ex('a#2')]), ['a#2', /excluded/]],
    ['excluded の重複', plan([lens('X1', ['a#1', 'a#2'])], [ex('a#3'), ex('a#3')]), ['a#3', /excluded/]],
    ['reason が空', plan([lens('X1', ['a#1', 'a#2'])], [ex('a#3', '')]), ['a#3']],
    ['excluded の実在しない asset', plan([lens('X1', ['a#1', 'a#2'])], [ex('a#3'), ex('a#9')]), ['a#9', /実在しない/]],
  ]
  for (const [name, ps, want] of cases) assert.ok(has(ps, ...want), `${name}: ${JSON.stringify(ps)}`)
  // 旧い照合（どの観点も当たらない資産）は使わない。
  for (const [name, ps] of cases) assert.ok(!ps.some((x) => /^どの観点も当たらない資産: /.test(x)), `${name}: ${JSON.stringify(ps)}`)
  // applies_to の形と実在の照合は今のまま。
  assert.match(plan([lens('X1', ['a#1', 'a#9']), lens('X2', ['a#2'])], [ex('a#3')]).join(), /X1 の applies_to に実在しない資産: a#9/)
  assert.match(plan([lens('X1', ['a#1', 'a#2']), lens('X2', [])], [ex('a#3')]).join(), /観点 X2 がどの資産にも当たらない/)
  assert.match(plan([{ id: 'X1', name: 'X1', procedure: '何かを列挙して照らす', goals: [{ id: 'G1', part: '何か' }] }], [ex('a#1'), ex('a#2'), ex('a#3')]).join(), /観点 X1 の applies_to が/, 'applies_to の無い観点を全ての資産に倒さない')
})

test('applies_to: 照合に落ちる計画は受け付けず、統合のやり直しに戻し、消えなければ枡を読まずに needs_input', async (t) => {
  const { state } = setupPlanned(t)
  const log = []
  const bad = (p) => { const r = splitPlan(p); r.lenses[0].applies_to = ['/nowhere.md#無い節']; return r }
  const { stop } = await drive(state, mockAgent({ plan: bad, integrate: bad }, log))
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.ok(stop.plan_defects.some((x) => /実在しない資産/.test(x.claim)))
  // 1 つ目の資産は applies_to にも excluded にも無い。
  assert.ok(stop.plan_defects.some((x) => x.kind === 'static' && /excluded/.test(x.claim) && x.claim.includes('一つ目の節')), JSON.stringify(stop.plan_defects))
  assert.ok(log.some((x) => x.label === 'integrate-again'), '既存のやり直しの流れに乗る')
  assert.ok(!log.some((x) => x.label.startsWith('read-')), '受け付けない計画で枡を読まない')
})

test('applies_to: 持ち越しで足された節にどの観点も当たらなければ、枡を読む前に計画をやり直す', async (t) => {
  const { state, doc } = setupPlanned(t)
  assert.equal((await drive(state, mockAgent({ plan: splitPlan, integrate: splitPlan }))).stop.stop, 'complete')
  writeFileSync(doc, `${DOC}\n## 三つ目の節\nこの節は後から足した三つ目の主張を述べる本文の行である。\n`)
  const n = cli('next', '--state', state)
  assert.equal(n.step, 'plan', JSON.stringify(n))
  const ids = ledger(state).plan_defects.map((x) => x.id)
  assert.equal(cli('next', '--state', state).call_id, n.call_id, '同じ状態の next は同じ呼び出しを返す（欠陥を重ねない）')
  const L = ledger(state)
  assert.deepEqual(L.plan_defects.map((x) => x.id), ids, '同じ状態の next は欠陥の id を変えない')
  assert.ok(ids.length && ids.every((id) => /^P\d+$/.test(id)), JSON.stringify(ids))
  assert.ok(L.plan_defects.some((x) => x.kind === 'static' && /excluded/.test(x.claim) && x.claim.includes('三つ目の節')), JSON.stringify(L.plan_defects))
  const third = (p) => { const r = splitPlan(p); r.lenses[1].applies_to = indexIds(p).slice(1); return r }
  const { stop } = await drive(state, mockAgent({ plan: third, integrate: third }))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(Object.keys(ledger(state).cells).some((k) => k.endsWith('三つ目の節/p1|X2|p1')))
})

test('applies_to: 観点の当てる資産が変われば、外れた組の枡は gone になり、当てる組は版が変わるので読み直す', async (t) => {
  const { state } = setupPlanned(t)
  assert.equal((await drive(state, mockAgent({ plan: splitPlan, integrate: splitPlan }))).stop.stop, 'complete')
  const L = ledger(state)
  const [a, b] = Object.keys(L.assets).filter((id) => !L.assets[id].retro)
  // X1 を 2 つ目の資産へ移す（台帳の観点を直接書き換え、版の変化で持ち越しを確かめる）。
  L.lenses.find((l) => l.id === 'X1').applies_to = [b]
  L.plan.lenses.find((l) => l.id === 'X1').applies_to = [b]
  writeFileSync(path.join(state, 'ledger.json'), JSON.stringify(L))
  const n = cli('next', '--state', state)
  const L2 = ledger(state)
  assert.equal(L2.cells[`${a}|X1|p1`].status, 'gone')
  assert.equal(L2.cells[`${b}|X1|p1`].status, 'unseen')
  assert.equal(L2.cells[`${a}|X2|p1`], undefined)
  assert.ok(n.step === 'plan' || n.step === 'review', JSON.stringify(n))
})

test('applies_to: 持ち越しの欠陥は、前の run でやり直しの上限に達した台帳でも計画役に戻す（applies_to の無い前の計画を含む）', async (t) => {
  for (const kind of ['added-section', 'no-applies-to']) {
    const { state, doc } = setupPlanned(t)
    assert.equal((await drive(state, mockAgent({ plan: splitPlan, integrate: splitPlan }))).stop.stop, 'complete')
    const L = ledger(state)
    L.plan_rounds = 2
    if (kind === 'no-applies-to') for (const l of [...L.plan.lenses, ...L.lenses.filter((x) => x.origin === 'plan')]) delete l.applies_to
    writeFileSync(path.join(state, 'ledger.json'), JSON.stringify(L))
    if (kind === 'added-section') writeFileSync(doc, `${DOC}\n## 三つ目の節\nこの節は後から足した三つ目の主張を述べる本文の行である。\n`)
    const n = cli('next', '--state', state)
    assert.equal(n.step, 'plan', `${kind}: ${JSON.stringify(n)}`)
    assert.equal(ledger(state).plan_rounds, 0, kind)
  }
})


// ---------------- excluded（どの観点も関係しない資産）の枡 ----------------
// 1 つ目の資産だけに X1 を当て、2 つ目の資産を excluded に入れる計画。
const excludePlan = (p) => {
  const r = splitPlan(p)
  const [, b] = indexIds(p)
  r.lenses = r.lenses.filter((l) => l.id === 'X1')
  r.excluded = [{ asset: b, reason: '目標に関係しない節' }]
  r.source_map = r.source_map.map((s) => (s.merged_into === 'X2' ? { ...s, merged_into: '', dropped_reason: '当てる資産が無い' } : s))
  return r
}

test('excluded: 除いた資産には purpose・layer を含めどの枡も作らず、読まず、status で開示する', async (t) => {
  const { state } = setupPlanned(t)
  const log = []
  const { stop } = await drive(state, mockAgent({ plan: excludePlan, integrate: excludePlan }, log))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const L = ledger(state)
  const [a, b] = Object.keys(L.assets).filter((id) => !L.assets[id].retro)
  // 1 資産 × 3 観点（purpose・layer・X1）× k=1。除いた資産の purpose・layer の枡も数えない。
  assert.equal(stop.coverage.cells, 3)
  const live = Object.entries(L.cells).filter(([, c]) => c.status !== 'gone')
  assert.equal(live.filter(([, c]) => c.asset === b).length, 0, '除いた資産に生きた枡が無い')
  assert.ok(live.some(([, c]) => c.asset === a && c.lens === 'purpose'))
  assert.ok(!log.some((x) => x.label.startsWith('read-') && x.label.includes('二つ目の節')), '除いた資産は読まない')
  const st = cli('status', '--state', state)
  assert.deepEqual(st.excluded, [{ asset: b, reason: '目標に関係しない節' }], JSON.stringify(st.excluded))
})

test('excluded: 資産が excluded に移れば枡は gone になり、applies_to と excluded の両方にあれば excluded を優先して計画をやり直す', async (t) => {
  const { state } = setupPlanned(t)
  assert.equal((await drive(state, mockAgent({ plan: splitPlan, integrate: splitPlan }))).stop.stop, 'complete')
  const L = ledger(state)
  const [, b] = Object.keys(L.assets).filter((id) => !L.assets[id].retro)
  assert.ok(Object.values(L.cells).some((c) => c.asset === b && c.status === 'settled'))
  // X2 は b に当たったまま、b を excluded にも入れる（統合役が問題のある計画を返したのと同じ状態）。
  L.plan.excluded = [{ asset: b, reason: '目標に関係しない節' }]
  writeFileSync(path.join(state, 'ledger.json'), JSON.stringify(L))
  const n = cli('next', '--state', state)
  assert.equal(n.step, 'plan', JSON.stringify(n))
  const L2 = ledger(state)
  const ofB = Object.values(L2.cells).filter((c) => c.asset === b)
  assert.ok(ofB.length && ofB.every((c) => c.status === 'gone'), `excluded を優先して purpose・layer・X2 の枡を gone にする: ${JSON.stringify(ofB.map((c) => [c.lens, c.status]))}`)
  assert.ok(L2.plan_defects.some((x) => x.kind === 'static' && x.claim.includes('二つ目の節') && /excluded/.test(x.claim)), JSON.stringify(L2.plan_defects))
})

test('excluded: 束ね役が横展開の applies_to に除いた資産を挙げても、その資産には横展開の枡を作らない', async (t) => {
  const { state } = setupPlanned(t)
  let b = null
  const agentFn = mockAgent({
    plan: excludePlan,
    integrate: excludePlan,
    read: readWith((cell) => (cell.endsWith('一つ目の節/p1|X1|p1') ? [finding('根拠が無い主張', 'この節は一つ目の主張を述べる本文の行である。')] : undefined)),
    group: (prompt) => {
      const items = groupItems(prompt)
      const L = ledger(state)
      b = L.plan.excluded[0].asset
      return { groups: [{ id: 'g1', root_cause: '根拠を書かない', layer: '実装', keys: items.map((x) => x.key), pattern: '主張ごとに根拠を対応づけ、根拠の無い主張を探す（横展開）', applies_to: [items[0].where, b] }], unassigned: [] }
    },
  })
  await drive(state, agentFn)
  assert.ok(b, '束ねまで進む')
  const L = ledger(state)
  const ofB = Object.entries(L.cells).filter(([, c]) => c.asset === b && c.status !== 'gone')
  assert.deepEqual(ofB.map(([id]) => id), [], '除いた資産には横展開の観点の枡も作らない（束ねを拒否しても、excluded を優先してもよい）')
})

// ---------------- 観点が受け持つ目標の部分（goals）と、観点の検証役の閉じた問い ----------------
const GOAL_TEXTS = { G1: '対象の文書の見落としを確かめた指摘の一覧', AC1: '指摘ごとに本文の引用を付ける' }
const goalLens = (id, goals) => ({ id, name: id, procedure: '主張ごとに根拠の文を列挙し、目標と照らす', applies_to: ['a#1'], goals })

test('goals: {id, part} の part が本文に逐語で、全ての目標・基準がどれかの観点に入る計画だけを受け付ける', () => {
  const ids = Object.keys(GOAL_TEXTS)
  const has = (ps, ...res) => ps.some((x) => res.every((r) => (typeof r === 'string' ? x.includes(r) : r.test(x))))
  const ok = [goalLens('X1', [{ id: 'G1', part: '見落としを確かめた' }]), goalLens('X2', [{ id: 'AC1', part: '本文の引用' }])]
  assert.deepEqual(C.checkGoals(ok, ids, GOAL_TEXTS), [])
  // 複合の目標は、同じ目標の別の部分を別の要素で受け持てる。
  assert.deepEqual(C.checkGoals([goalLens('X1', [{ id: 'G1', part: '見落としを確かめた' }, { id: 'G1', part: '指摘の一覧' }, { id: 'AC1', part: '本文の引用' }])], ids, GOAL_TEXTS), [])
  const cases = [
    ['part が本文に逐語でない', C.checkGoals([goalLens('X1', [{ id: 'G1', part: '本文のどこにも無い部分' }, { id: 'AC1', part: '本文の引用' }])], ids, GOAL_TEXTS), ['X1', /逐語/]],
    ['実在しない目標', C.checkGoals([...ok, goalLens('X3', [{ id: 'G9', part: '何か' }])], ids, GOAL_TEXTS), ['G9', /実在しない/]],
    ['受け皿の無い目標', C.checkGoals([ok[0]], ids, GOAL_TEXTS), ['AC1', /どの観点の goals にも無い/]],
    ['goals が空', C.checkGoals([...ok, goalLens('X3', [])], ids, GOAL_TEXTS), ['X3', /空/]],
    ['part が空', C.checkGoals([goalLens('X1', [{ id: 'G1', part: '' }]), ok[1]], ids, GOAL_TEXTS), ['X1']],
    ['id の配列（前の形）', C.checkGoals([goalLens('X1', ['G1', 'AC1'])], ids, GOAL_TEXTS), ['X1', /goals/]],
    ['goals の欄が無い', C.checkGoals([{ id: 'X1', name: 'X1', procedure: '何かを列挙して照らす', applies_to: ['a#1'] }], ids, GOAL_TEXTS), ['X1', /goals/]],
  ]
  for (const [name, ps, want] of cases) assert.ok(has(ps, ...want), `${name}: ${JSON.stringify(ps)}`)
  // 本文を渡さないとき（Workflow の中）は、形・id・受け皿だけを照らす。逐語かは CLI の ingest が照らす。
  assert.deepEqual(C.checkGoals([goalLens('X1', [{ id: 'G1', part: '本文のどこにも無い部分' }, { id: 'AC1', part: '本文の引用' }])], ids), [])
  // checkPlan も ctx の goalItemIds・goalTexts で同じ照合をする。
  const ctx = { constraintIds: [], lensesGiven: false, givenLensIds: [], goalItemIds: ids, goalTexts: GOAL_TEXTS }
  assert.deepEqual(C.checkPlan({ lenses: ok, excluded: [], questions: [], constraint_map: [] }, ctx), [])
  assert.ok(C.checkPlan({ lenses: [ok[0]], excluded: [], questions: [], constraint_map: [] }, ctx).some((x) => x.includes('AC1')))
})

test('goals: 逐語でない part は ingest で計画の静的な欠陥（P<n>）にし、統合のやり直しに戻し、消えなければ枡を読まずに needs_input', async (t) => {
  const { state } = setupPlanned(t)
  const log = []
  const bad = (p) => { const r = splitPlan(p); for (const l of r.lenses) l.goals = [{ id: 'G1', part: '目標の本文のどこにも無い部分の文字列' }]; return r }
  const { stop, steps } = await drive(state, mockAgent({ plan: bad, integrate: bad }, log))
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.ok(stop.plan_defects.some((x) => x.kind === 'static' && /^P\d+$/.test(x.id) && /逐語/.test(x.claim)), JSON.stringify(stop.plan_defects))
  assert.ok(log.some((x) => x.label === 'integrate-again'), '既存のやり直しの流れに乗る')
  assert.ok(!log.some((x) => x.label.startsWith('read-')), '受け付けない計画で枡を読まない')
  const plans = steps.filter((s) => s.step === 'plan')
  assert.ok(plans.length >= 2 && plans.every((s) => JSON.stringify(s.args.goalItemIds) === '["G1"]'), 'plan の args に目標・基準の id が常に載る')
})

test('goals: どの観点の goals にも入らない受け入れ基準（受け皿の無い目標）は計画の静的な欠陥', async (t) => {
  const { state } = setupPlanned(t, DOC, { criteria: ['AC1: 指摘ごとに本文の引用を付ける'] })
  const onlyG1 = (p) => { const r = splitPlan(p); for (const l of r.lenses) l.goals = l.goals.filter((g) => g.id === 'G1'); return r }
  const { stop, steps } = await drive(state, mockAgent({ plan: onlyG1, integrate: onlyG1 }))
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.ok(stop.plan_defects.some((x) => x.kind === 'static' && x.claim.includes('AC1') && /どの観点の goals にも無い/.test(x.claim)), JSON.stringify(stop.plan_defects))
  assert.deepEqual(steps[0].args.goalItemIds, ['G1', 'AC1'])
})

test('閉じた問い: Q1・Q2 と goals の要素ごとの Q3 に過不足なく答えたものだけを受け付け、no の答えだけが欠陥になる', () => {
  const u = goalLens('X1', [{ id: 'G1', part: '見落としを確かめた' }, { id: 'G1', part: '指摘の一覧' }, { id: 'AC1', part: '本文の引用' }])
  const text = C.unitText(u)
  const p = `### 本文（観点）\n${text}\n`
  const yes = unitAnswers(p)
  assert.equal(yes.answers.filter((a) => a.question === 'Q3').length, 3, '同じ目標の別の部分も、要素ごとに問う')
  assert.deepEqual(C.checkUnitVerdict(yes, 'X1', u.goals, text), [])
  assert.deepEqual(C.unitDefects(yes, 'X1', u.goals), [])
  const no = unitAnswers(p, (k) => k === 'Q2' || k === 'Q3:1')
  assert.deepEqual(C.checkUnitVerdict(no, 'X1', u.goals, text), [])
  const ds = C.unitDefects(no, 'X1', u.goals)
  assert.deepEqual(ds.map((d) => [d.unit_id, d.kind, d.goal_id, d.part]), [['X1', 'Q2', undefined, undefined], ['X1', 'Q3', 'G1', '指摘の一覧']])
  assert.ok(ds.every((d) => d.quote === u.procedure && typeof d.claim === 'string' && d.claim.startsWith(d.kind)))
  const bad = (ans, extra = {}) => C.checkUnitVerdict({ ...yes, ...extra, answers: ans }, 'X1', u.goals, text).join(' / ')
  assert.match(bad(yes.answers, { defects: [{ kind: '大きすぎる', claim: '問いが 2 つある', quote: u.procedure }] }), /自由な欠陥/)
  assert.match(bad(yes.answers.filter((a) => a.goal_index !== 2)), /答えの無い問い: Q3/)
  assert.match(bad([...yes.answers, { question: 'Q3', goal_index: 5, goal_id: 'G9', answer: 'no', quote: u.procedure }]), /聞いていない問い: Q3/)
  assert.match(bad([...yes.answers, { question: 'Q4', answer: 'no', quote: u.procedure }]), /聞いていない問い: Q4/)
  assert.match(bad([...yes.answers, yes.answers[0]]), /答えの重複: Q1/)
  assert.match(bad([...yes.answers, yes.answers[3]]), /答えの重複: Q3/)
  assert.match(bad(yes.answers.map((a, i) => (i ? a : { ...a, answer: 'maybe' }))), /yes・no でない/)
  assert.match(bad(yes.answers.map((a, i) => (i ? a : { ...a, quote: '観点の本文に無い偽の引用の文字列' }))), /逐語で無い/)
})

test('閉じた問い: 自由な欠陥の返り値は受け付けず（rejected_unit_check）、計画の欠陥にしない', async (t) => {
  const { state } = setupPlanned(t)
  const free = (p, o) => (o.label.startsWith('verify-unit-X1') ? { ...unitAnswers(p), defects: [{ kind: '大きすぎる', claim: '問いが 2 つある', quote: '主張と根拠を対応づけて食い違いを探す' }] } : undefined)
  const { stop } = await drive(state, mockAgent({ plan: splitPlan, integrate: splitPlan, verify: free }))
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.ok(stop.stuck.includes('unit:X1'), JSON.stringify(stop))
  const L = ledger(state)
  assert.ok(!L.plan_defects.some((x) => /問いが 2 つある/.test(x.claim)), '自由な欠陥は計画の欠陥にならない')
  assert.ok(L.events.some((e) => e.kind === 'rejected_unit_check' && /自由な欠陥/.test(e.text)))
})

test('閉じた問い: 統合しない plan の呼び出しの args.units は goals の id の並びを持ち、正しい答えはやり直し無しで受理される', async (t) => {
  const { state } = setupPlanned(t, DOC, { criteria: ['AC1: 指摘ごとに本文の引用を付ける'] })
  let n = 0
  // 1 回目の呼び出しの観点の検証役（最初とやり直し）だけが返らない。次の plan は統合せず、CLI の束で観点を渡す。
  const { stop, steps } = await drive(state, mockAgent({ verify: (p, o) => (o.label.startsWith('verify-unit-') && n++ < 2 ? null : undefined) }))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const second = steps[1]
  assert.equal(second.step, 'plan')
  assert.deepEqual(second.args.units.map((u) => [u.unit_id, u.goals]), [['X1', ['G1', 'AC1']]], 'units に goals の id の並びを載せる')
  assert.ok(!JSON.stringify(second.args).includes('本文の引用を付ける'), 'part の本文は args に載せない（束に入れる）')
  assert.ok(second.res.agents.some((a) => a.label.startsWith('verify-unit-X1')))
  assert.ok(second.res.agents.every((a) => !a.label.includes('やり直し')), JSON.stringify(second.res.agents.map((a) => a.label)))
  assert.equal(ledger(state).verified_units.length, 1)
})

// ---------------- 統合役の rejected は閉じた問いの no を退けない（観点を検証し直すだけ） ----------------
test('integrator: 閉じた問い（Q1・Q2・Q3）の no から作った欠陥への rejected は静的な欠陥にしない（fixed と同じく受け付け、退けたかは次の検証で決まる）', () => {
  const lens = { id: 'X1', name: 'X1', procedure: '何かを列挙して照らす', applies_to: ['a#1'], goals: [{ id: 'G1', part: '何か' }] }
  const ctx = (defectKinds) => ({ constraintIds: [], lensesGiven: false, givenLensIds: [], sources: ['P:X1'], defectCount: defectKinds.length, defectKinds })
  const plan = (actions) => ({ lenses: [lens], excluded: [], questions: [], constraint_map: [], source_map: [{ source: 'P:X1', merged_into: 'X1', dropped_reason: '' }], defect_responses: actions.map((action, i) => ({ defect_index: i, action, reason: '理由' })) })
  for (const kind of ['Q1', 'Q2', 'Q3', 'static']) {
    assert.deepEqual(C.checkPlan(plan(['rejected']), ctx([kind])), [], `${kind} への rejected`)
    assert.deepEqual(C.checkPlan(plan(['fixed']), ctx([kind])), [], `${kind} への fixed`)
  }
  assert.deepEqual(C.checkPlan(plan(['rejected', 'fixed']), ctx(['Q1', 'Q3'])), [])
})

// 観点 X1 の最初の検証が Q1 に no と答え、見直しの統合役は全ての欠陥を rejected で退け、観点を変えない。
// later は 2 回目以降の X1 の検証の答え（yes か no）。
function rejectingRun(later) {
  let first = true
  const log = []
  const agentFn = mockAgent({
    plan: splitPlan,
    integrate: (p, o) => {
      const r = splitPlan(p)
      if (!o.label.startsWith('integrate-again')) return r
      const defects = JSON.parse(p.split('### 欠陥（index は配列の位置）\n')[1].split('\n#')[0])
      return { ...r, defect_responses: defects.map((d) => ({ defect_index: d.index, action: 'rejected', reason: '手続きは列挙するものを書いている' })) }
    },
    verify: (p, o) => {
      if (!o.label.startsWith('verify-unit-X1')) return undefined
      const no = first || later === 'no'
      first = false
      return unitAnswers(p, (k) => no && k === 'Q1')
    },
  }, log)
  return { agentFn, log }
}

test('integrator: rejected の後に観点を検証し直し、yes なら欠陥は消えて枡を読む段に進む', async (t) => {
  const { state } = setupPlanned(t)
  const { agentFn, log } = rejectingRun('yes')
  const { stop, rounds } = await driveRecording(state, agentFn)
  assert.deepEqual(rounds.slice(0, 2).map((r) => r.step), ['plan', 'plan'])
  assert.deepEqual(rounds[0].defects.map((d) => d.kind), ['Q1'])
  const again = log.findIndex((x) => x.label === 'integrate-again')
  assert.ok(again >= 0)
  assert.ok(!log.some((x) => x.label === 'integrate-again（やり直し）'), 'rejected は静的な問題にならず、統合役をやり直させない')
  assert.ok(log.slice(again).some((x) => x.label === 'verify-unit-X1'), '退けた欠陥の観点を、中身が変わらなくても検証し直す')
  assert.deepEqual(rounds[1].defects, [], '検証し直して yes なら欠陥は消える')
  assert.ok(rounds.some((r) => r.step === 'review'), '欠陥が消えたので枡を読む段に進む')
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
})

test('integrator: rejected の後に観点を検証し直し、no ならまた欠陥（新しい P<n>）になり、枡を読まずに needs_input', async (t) => {
  const { state } = setupPlanned(t)
  const { agentFn, log } = rejectingRun('no')
  const { stop, rounds } = await driveRecording(state, agentFn)
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  const again = log.findIndex((x) => x.label === 'integrate-again')
  assert.ok(log.slice(again).some((x) => x.label === 'verify-unit-X1'), '退けた欠陥の観点を検証し直す')
  assert.deepEqual(rounds[1].defects.map((d) => [d.unit_id, d.kind]), [['X1', 'Q1']], 'no ならまた欠陥になる')
  assert.notEqual(rounds[1].defects[0].id, rounds[0].defects[0].id, '新しい欠陥は新しい id')
  assert.ok(!log.some((x) => x.label.startsWith('read-')), '欠陥が残る計画で枡を読まない')
})

// ---------------- 計画の欠陥の id（P<n>）と、その回答 ----------------
// next → Workflow → ingest を止まるまで回し、ingest ごとの台帳の plan_defects を記録する。
async function driveRecording(state, agentFn, maxSteps = 30) {
  const rounds = []
  for (let i = 0; i < maxSteps; i++) {
    const n = cli('next', '--state', state)
    if (n.code !== 0 || n.stop) return { stop: n, rounds }
    const res = await runWorkflow(JSON.parse(readFileSync(n.args_path, 'utf8')), agentFn)
    const rp = path.join(state, `result-${n.call_id}.json`)
    writeFileSync(rp, JSON.stringify(res))
    assert.equal(cli('ingest', '--state', state, '--result', rp).code, 0)
    rounds.push({ step: n.step, defects: ledger(state).plan_defects })
  }
  return { stop: null, rounds }
}

test('plan_defects の id: P1 から連番で付き、統合のやり直しで欠陥を戻しても前の番号を使い回さない', async (t) => {
  const { state } = setupPlanned(t)
  // 観点 X1 の Q3（goals の 0 番目）に no と答え続ける。
  const { stop, rounds } = await driveRecording(state, mockAgent({ plan: splitPlan, integrate: splitPlan, verify: (p, o) => (o.label.startsWith('verify-unit-X1') ? unitAnswers(p, (k) => k === 'Q3:0') : undefined) }))
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  const plans = rounds.filter((r) => r.step === 'plan')
  assert.ok(plans.length >= 3, `統合・やり直し 2 回: ${plans.length}`)
  const all = plans.flatMap((r) => r.defects.map((d) => d.id))
  assert.ok(all.every((id) => /^P\d+$/.test(id)), JSON.stringify(all))
  assert.deepEqual(all.map((id) => Number(id.slice(1))), all.map((_, i) => i + 1), `呼び出しごとに新しい欠陥へ次の番号を付ける: ${JSON.stringify(all)}`)
  const q3 = plans[0].defects[0]
  assert.deepEqual([q3.unit_id, q3.kind, q3.goal_id, q3.part], ['X1', 'Q3', 'G1', '対象の文書の見落としを確かめた指摘の一覧'])
  assert.deepEqual(stop.plan_defects.map((d) => d.id), plans.at(-1).defects.map((d) => d.id), '停止の出力にも id を載せる')
})

test('answer --id P<n>: 計画の欠陥への回答は決定の記録と制約になり、停止を外して統合からやり直す。欠陥が残ればまた止まる', async (t) => {
  const { state } = setupPlanned(t)
  const log = []
  const agentFn = mockAgent({ plan: splitPlan, integrate: splitPlan, verify: (p, o) => (o.label.startsWith('verify-unit-X1') ? unitAnswers(p, (k) => k === 'Q1') : undefined) }, log)
  const { stop } = await drive(state, agentFn)
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  const pid = stop.plan_defects[0].id
  assert.match(pid, /^P\d+$/)
  assert.equal(cli('next', '--state', state).stop, 'needs_input', '回答の前は止まったまま')
  // 台帳に無い id と、前の統合で消えた id には答えられない。
  assert.equal(cli('answer', '--state', state, '--id', 'P999', '--text', '答え').code, 2)
  assert.ok(pid !== 'P1')
  assert.equal(cli('answer', '--state', state, '--id', 'P1', '--text', '答え').code, 2, '前の統合の欠陥の id は今の欠陥でない')
  const said = 'X1 の手続きに列挙するものを書き足して直す'
  assert.equal(cli('answer', '--state', state, '--id', pid, '--text', said).code, 0)
  const L = ledger(state)
  assert.ok(L.decisions.includes(said), '回答は決定の記録の 1 行になる')
  assert.ok(L.constraints.some((c) => /^A\d+$/.test(c.id) && c.text.includes(said)), '回答を引用する制約 A<n> を足す')
  const n = cli('next', '--state', state)
  assert.equal(n.step, 'plan', `回答で停止が外れる: ${JSON.stringify(n)}`)
  assert.ok(JSON.parse(readFileSync(n.args_path, 'utf8')).answerIds.includes(pid))
  const before = log.length
  const again = await drive(state, agentFn)
  assert.ok(log.slice(before).some((x) => x.label === 'integrate-again' && x.prompt.includes(said)), '見直しの統合役が回答を読む')
  assert.equal(again.stop.stop, 'needs_input', '欠陥が残れば、また止まる（止まること自体は変えない）')
  assert.ok(again.stop.plan_defects.every((d) => Number(d.id.slice(1)) > Number(pid.slice(1))), '新しい欠陥は新しい id')
})

// ---------------- 観点の精査役（lens_reviewer）: N1・N2 の閉じた問い（計画 4） ----------------
// 答えの形: { lens_id, n1: [{ asset, answer, quote }], n2: [{ lens, answer, quote_self?, quote_other? }] }。
// N1 は当てた資産ごと（引用は資産の本文に逐語）、N2 は他の計画の観点ごと（yes なら両方の手続きからの引用）。
const LENS_PROC = { X1: '主張と根拠を対応づけて食い違いを探す', X2: '用語ごとに定義の文を対応づけ、定義の無い用語を探す', X3: '手順ごとに前提の文を対応づけ、前提の無い手順を探す' }
const LENS_ASSET = { 'a#1': '一つ目の資産の本文で、主張と根拠を並べて書いている。', 'a#2': '二つ目の資産の本文で、用語とその定義を並べて書いている。' }

test('checkLensReview: N1 は当てた資産ごと、N2 は他の計画の観点ごとに過不足なく yes・no で答え、引用が逐語のものだけを受け付ける', () => {
  const lens = { id: 'X1', name: '整合', procedure: LENS_PROC.X1, applies_to: ['a#1', 'a#2'], goals: [{ id: 'G1', part: '見落とし' }] }
  const texts = { assets: LENS_ASSET, procedures: LENS_PROC }
  const others = ['X2', 'X3']
  const ok = {
    lens_id: 'X1',
    n1: [{ asset: 'a#1', answer: 'yes', quote: LENS_ASSET['a#1'] }, { asset: 'a#2', answer: 'no', quote: LENS_ASSET['a#2'] }],
    n2: [{ lens: 'X2', answer: 'yes', quote_self: LENS_PROC.X1, quote_other: LENS_PROC.X2 }, { lens: 'X3', answer: 'no' }],
  }
  assert.deepEqual(C.checkLensReview(ok, lens, others, texts), [])
  const n1 = (f) => ({ ...ok, n1: f(ok.n1) })
  const n2 = (f) => ({ ...ok, n2: f(ok.n2) })
  const cases = [
    ['返り値が無い', null],
    ['lens_id が違う', { ...ok, lens_id: 'X2' }],
    ['N1: 当てた資産の答えが欠ける', n1((xs) => xs.slice(0, 1))],
    ['N1: 当てていない資産への答え', n1((xs) => [...xs, { asset: 'a#9', answer: 'yes', quote: LENS_ASSET['a#1'] }])],
    ['N1: 同じ資産への答えの重複', n1((xs) => [...xs, xs[0]])],
    ['N1: yes・no 以外の答え', n1((xs) => xs.map((x, i) => (i ? x : { ...x, answer: 'maybe' })))],
    ['N1: 資産の本文に逐語でない引用', n1((xs) => xs.map((x, i) => (i ? x : { ...x, quote: 'どの資産の本文にも無い偽の引用の文字列である' })))],
    ['N1: 別の資産の本文からの引用', n1((xs) => xs.map((x, i) => (i ? x : { ...x, quote: LENS_ASSET['a#2'] })))],
    ['N1: 引用が空', n1((xs) => xs.map((x, i) => (i ? x : { ...x, quote: '' })))],
    ['N2: 他の観点の答えが欠ける', n2((xs) => xs.slice(0, 1))],
    ['N2: 計画に無い観点への答え', n2((xs) => [...xs, { lens: 'X9', answer: 'no' }])],
    ['N2: スキルの観点（purpose）への答え', n2((xs) => [...xs, { lens: 'purpose', answer: 'no' }])],
    ['N2: 自分自身への答え', n2((xs) => [...xs, { lens: 'X1', answer: 'no' }])],
    ['N2: 同じ観点への答えの重複', n2((xs) => [...xs, xs[1]])],
    ['N2: yes・no 以外の答え', n2((xs) => xs.map((x, i) => (i === 1 ? { ...x, answer: 'maybe' } : x)))],
    ['N2: yes で引用が 1 つだけ', n2((xs) => xs.map((x, i) => (i ? x : { lens: 'X2', answer: 'yes', quote_self: LENS_PROC.X1 })))],
    ['N2: yes の自分の引用が自分の手続きに逐語でない', n2((xs) => xs.map((x, i) => (i ? x : { ...x, quote_self: LENS_PROC.X2 })))],
    ['N2: yes の相手の引用が相手の手続きに逐語でない', n2((xs) => xs.map((x, i) => (i ? x : { ...x, quote_other: LENS_PROC.X3 })))],
  ]
  for (const [name, rep] of cases) assert.ok(C.checkLensReview(rep, lens, others, texts).length > 0, `${name} は問題になる`)
  // 本文を渡さないとき（Workflow の中）は、形・過不足・答えの値だけを照らし、逐語かは CLI の ingest が照らす。
  const fake = n1((xs) => xs.map((x, i) => (i ? x : { ...x, quote: 'どの資産の本文にも無い偽の引用の文字列である' })))
  assert.deepEqual(C.checkLensReview(fake, lens, others), [])
  assert.ok(C.checkLensReview(n1((xs) => xs.slice(0, 1)), lens, others).length > 0, '本文が無くても過不足は照らす')
})

// 観点 X1・X2 を位置で指した資産に当てる計画。spec の goals は goals の要素を選ぶ関数（無ければ全ての目標・基準）。
// handledBy は全ての基準・制約の受け皿。見直しの統合では、prompt が挙げる前の計画の観点を source_map に写し、欠陥を全て fixed にする。
const DOC3 = `${DOC}
## 三つ目の節
この節は三つ目の主張を述べる本文の行である。
二行目もこの節の主張を補う本文の行として置く。
`
const lensPlan = (spec, handledBy = ['purpose']) => (p) => {
  const ids = indexIds(p)
  const lenses = Object.entries(spec).map(([id, s]) => ({ id, name: id, procedure: LENS_PROC[id], applies_to: s.at.map((i) => ids[i]), goals: goalsOf(p).filter(s.goals || (() => true)) }))
  const prev = /source_map は前の計画の観点を「P:<id>」で全て挙げる: (.*)）/.exec(p)
  const src = prev ? prev[1].split(', ').filter(Boolean) : [...p.matchAll(/^### ([AB])（/gm)].flatMap((m) => lenses.map((l) => `${m[1]}:${l.id}`))
  const defects = p.includes('### 欠陥（index') ? JSON.parse(p.split('### 欠陥（index は配列の位置）\n')[1].split('\n#')[0]) : []
  return {
    lenses, excluded: [], questions: [], constraint_map: constraintIdsOf(p).map((id) => ({ constraint_id: id, handled_by: handledBy })),
    source_map: src.map((s) => { const id = s.split(':')[1]; return lenses.some((l) => l.id === id) ? { source: s, merged_into: id, dropped_reason: '' } : { source: s, merged_into: '', dropped_reason: '精査で落ちた観点' } }),
    defect_responses: defects.map((d) => ({ defect_index: d.index, action: 'fixed', reason: '直した' })),
  }
}
// 観点 lensId の精査役が、資産の id に where の文字列を含む資産へ N1 の no を返す（他は既定: N1 yes・N2 no）。
const n1NoFor = (lensId, ...where) => (p, o) => (lensIdOf(o) === lensId ? lensAnswers(p, o, { n1No: (a) => !where.length || where.some((w) => a.includes(w)) }) : undefined)
const targetIds = (L) => Object.keys(L.assets).filter((id) => !L.assets[id].retro)
const liveCells = (L) => Object.values(L.cells).filter((c) => c.status !== 'gone')

test('観点の精査: N1 の no の資産は applies_to から外れ、どの観点にも残らない資産だけが excluded に入る（理由は N1）。統合には戻さない', async (t) => {
  const { state } = setupPlanned(t, DOC3)
  const log = []
  const plan = lensPlan({ X1: { at: [0, 1, 2] }, X2: { at: [1, 2] } })
  const { stop } = await drive(state, mockAgent({ plan, integrate: plan, lens: n1NoFor('X1', '一つ目の節', '二つ目の節') }, log))
  assert.ok(log.some((x) => x.label === 'lens-review-X1') && log.some((x) => x.label === 'lens-review-X2'), '観点ごとに精査役が起動される')
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const L = ledger(state)
  const [a, b, c] = targetIds(L)
  const lensOf = (id) => L.lenses.find((l) => l.id === id)
  assert.deepEqual(lensOf('X1').applies_to, [c], 'N1 の no の資産は X1 の applies_to から外れる')
  assert.deepEqual(lensOf('X2').applies_to, [b, c], '他の観点の applies_to は変えない')
  const st = cli('status', '--state', state)
  assert.deepEqual(st.excluded.map((x) => x.asset), [a], `X2 に残る資産は excluded に入れない: ${JSON.stringify(st.excluded)}`)
  assert.match(st.excluded[0].reason, /N1/, 'excluded の理由に N1 の no を書く')
  assert.ok(!log.some((x) => x.label.startsWith('integrate-again')), 'N1 の no は統合に戻さない')
  assert.deepEqual(liveCells(L).filter((x) => x.asset === a), [], '除いた資産に枡を作らない')
  assert.deepEqual(liveCells(L).filter((x) => x.lens === 'X1').map((x) => x.asset), [c])
  assert.ok(!log.some((x) => x.label.startsWith('lens-review-') && x.label.includes('やり直し')), '正しい答えはやり直し無しで受理される')
})

test('観点の精査: applies_to が空になった観点は計画から落ち、枡を作らず、落としたことを status で開示する（受け皿が残れば欠陥にしない）', async (t) => {
  const { state } = setupPlanned(t)
  const log = []
  const plan = lensPlan({ X1: { at: [0] }, X2: { at: [1] } })
  const { stop } = await drive(state, mockAgent({ plan, integrate: plan, lens: n1NoFor('X1') }, log))
  assert.ok(log.some((x) => x.label === 'lens-review-X1'), '精査役が起動される')
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const L = ledger(state)
  const [a] = targetIds(L)
  assert.ok(!L.lenses.some((l) => l.id === 'X1'), '落ちた観点は台帳の観点に残らない')
  assert.deepEqual(liveCells(L).filter((x) => x.lens === 'X1'), [], '落ちた観点の枡を作らない')
  const st = cli('status', '--state', state)
  assert.ok(Array.isArray(st.dropped_lenses) && st.dropped_lenses.some((x) => JSON.stringify(x).includes('X1')), `落とした観点を開示する: ${JSON.stringify(st.dropped_lenses)}`)
  assert.ok(st.excluded.some((x) => x.asset === a && /N1/.test(x.reason)), '残らない資産は excluded に入る')
  assert.deepEqual(L.plan_defects, [], 'X2 と purpose が受け皿のまま残るので欠陥にしない')
  assert.ok(!log.some((x) => x.label.startsWith('integrate-again')))
})

test('観点の精査: 観点が落ちて、その観点だけが goals で受け持った目標・基準は受け皿を失い、計画の欠陥（P<n>）として統合に戻る', async (t) => {
  const { state } = setupPlanned(t, DOC, { criteria: ['AC1: 指摘ごとに本文の引用を付ける'] })
  const log = []
  // AC1 を goals に持つのは X1 だけ。constraint_map の受け皿は X2 にして、制約の側の受け皿は失わせない。
  const plan = lensPlan({ X1: { at: [0] }, X2: { at: [1], goals: (g) => g.id !== 'AC1' } }, ['X2'])
  const { stop, rounds } = await driveRecording(state, mockAgent({ plan, integrate: plan, lens: n1NoFor('X1') }, log))
  assert.ok(log.some((x) => x.label === 'lens-review-X1'), '精査役が起動される')
  const ds = rounds[0].defects
  assert.ok(ds.some((d) => /^P\d+$/.test(d.id) && JSON.stringify(d).includes('AC1')), `受け皿を失った AC1 が P<n> の欠陥になる: ${JSON.stringify(ds)}`)
  assert.ok(log.some((x) => x.label === 'integrate-again'), '統合に戻す')
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.ok(stop.plan_defects.some((d) => JSON.stringify(d).includes('AC1')))
  assert.ok(!log.some((x) => x.label.startsWith('read-')), '欠陥の残る計画で枡を読まない')
})

test('観点の精査: 観点が落ちて、その観点だけが constraint_map の handled_by だった基準・制約は受け皿を失い、計画の欠陥（P<n>）として統合に戻る', async (t) => {
  const { state } = setupPlanned(t, DOC, { criteria: ['AC1: 指摘ごとに本文の引用を付ける'] })
  const log = []
  // goals は両方の観点が全ての目標・基準を持つ。AC1 の constraint_map の受け皿だけが X1。
  const plan = lensPlan({ X1: { at: [0] }, X2: { at: [1] } }, ['X1'])
  const { stop, rounds } = await driveRecording(state, mockAgent({ plan, integrate: plan, lens: n1NoFor('X1') }, log))
  assert.ok(log.some((x) => x.label === 'lens-review-X1'), '精査役が起動される')
  const ds = rounds[0].defects
  assert.ok(ds.some((d) => /^P\d+$/.test(d.id) && JSON.stringify(d).includes('AC1')), `handled_by を失った AC1 が P<n> の欠陥になる: ${JSON.stringify(ds)}`)
  assert.ok(log.some((x) => x.label === 'integrate-again'), '統合に戻す')
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.ok(!log.some((x) => x.label.startsWith('read-')))
})

test('観点の精査: N2 の yes（同じものを列挙し同じものと照らす別の観点）は計画の欠陥（P<n>）として統合に戻り、直れば先に進む', async (t) => {
  const { state } = setupPlanned(t)
  const log = []
  const plan = lensPlan({ X1: { at: [0] }, X2: { at: [1] } })
  const lens = (p, o) => {
    if (lensIdOf(o) !== 'X1' || log.some((x) => x.label === 'integrate-again')) return undefined
    return lensAnswers(p, o, { n2Yes: (l) => (l === 'X2' ? { quote_self: LENS_PROC.X1, quote_other: LENS_PROC.X2 } : null) })
  }
  const { stop, rounds } = await driveRecording(state, mockAgent({ plan, integrate: plan, lens }, log))
  assert.ok(log.some((x) => x.label === 'lens-review-X1'), '精査役が起動される')
  const ds = rounds[0].defects
  const d = ds.find((x) => /^P\d+$/.test(x.id) && JSON.stringify(x).includes('X1') && JSON.stringify(x).includes('X2'))
  assert.ok(d, `N2 の yes が両方の観点を指す P<n> の欠陥になる: ${JSON.stringify(ds)}`)
  const again = log.find((x) => x.label === 'integrate-again')
  assert.ok(again && again.prompt.includes(`"id":"${d.id}"`), '見直しの統合役の束に、その欠陥が渡る')
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
})

test('観点の精査: 資産の本文に逐語でない引用の N1 の no は受け付けず（rejected_*）、資産を applies_to から外さない', async (t) => {
  const { state } = setupPlanned(t)
  const log = []
  const plan = lensPlan({ X1: { at: [0] }, X2: { at: [1] } })
  const lens = (p, o) => {
    if (lensIdOf(o) !== 'X1') return undefined
    const r = lensAnswers(p, o, { n1No: () => true })
    return { ...r, n1: r.n1.map((x) => ({ ...x, quote: 'どの資産の本文にも無い偽の引用の文字列である' })) }
  }
  await drive(state, mockAgent({ plan, integrate: plan, lens }, log))
  assert.ok(log.some((x) => x.label === 'lens-review-X1'), '精査役が起動される')
  const L = ledger(state)
  assert.ok(L.events.some((e) => e.kind.startsWith('rejected_') && e.text.includes('X1')), `X1 の精査を拒否した出来事を残す: ${JSON.stringify(L.events.map((e) => e.kind))}`)
  const [a] = targetIds(L)
  assert.deepEqual(L.lenses.find((l) => l.id === 'X1').applies_to, [a], '拒否した答えで資産を外さない')
  const st = cli('status', '--state', state)
  assert.ok(!st.excluded.some((x) => /N1/.test(x.reason)))
})

test('観点の精査: 統合しない plan の呼び出しの args.reviewUnits は観点の id・当てた資産の id・他の観点の id だけを持ち、本文を載せず、正しい答えはやり直し無しで受理される', async (t) => {
  const { state } = setupPlanned(t)
  let call = 0
  const plan = lensPlan({ X1: { at: [0] }, X2: { at: [1] } })
  // 1 回目の呼び出しの精査役（最初とやり直し）だけが返らない。次の plan は統合せず、CLI が精査の要る観点を args で渡す。
  const agentFn = mockAgent({ plan, integrate: plan, lens: () => (call === 1 ? null : undefined) })
  const { stop, steps } = await drive(state, agentFn, { run: (args, fn) => { call++; return runWorkflow(args, fn) } })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const second = steps[1]
  assert.equal(second.step, 'plan')
  assert.ok(!second.res.agents.some((x) => x.label.startsWith('integrate') || x.label.startsWith('plan-')), '2 回目は統合しない')
  const L = ledger(state)
  const [a, b] = targetIds(L)
  const tb = second.args.targetBase || ''
  const rel = (id) => (tb && id.startsWith(tb) ? id.slice(tb.length) : id)
  assert.ok(Array.isArray(second.args.reviewUnits), `args.reviewUnits がある: ${JSON.stringify(Object.keys(second.args))}`)
  const units = [...second.args.reviewUnits].sort((x, y) => x.unit_id.localeCompare(y.unit_id))
  assert.deepEqual(units.map((u) => [u.unit_id, (u.applies_to || []).map(rel), u.others]), [['X1', [rel(a)], ['X2']], ['X2', [rel(b)], ['X1']]], 'N1 の applies_to の id と N2 の他の観点の id を載せる')
  const s = JSON.stringify(second.args)
  for (const x of [LENS_PROC.X1, LENS_PROC.X2, '一つ目の主張を述べる', '二つ目の主張を述べる']) assert.ok(!s.includes(x), `args に本文を載せない（束に入れる）: ${x}`)
  const lensLabels = second.res.agents.filter((x) => x.label.startsWith('lens-review-')).map((x) => x.label).sort()
  assert.deepEqual(lensLabels, ['lens-review-X1', 'lens-review-X2'], '正しい答えはやり直し無しで受理される')
})

test('観点の精査役は統合の後・その観点の検証役の前に起動され（最初の統合と見直しの統合の両方）、lens_reviewer の役で記録される', async (t) => {
  const { state } = setupPlanned(t)
  const log = []
  const plan = lensPlan({ X1: { at: [0] }, X2: { at: [1] } })
  let first = true
  // X1 の最初の検証だけが Q1 に no と答え、見直しの統合を 1 回走らせる。
  const verify = (p, o) => {
    if (!o.label.startsWith('verify-unit-X1')) return undefined
    const no = first
    first = false
    return unitAnswers(p, (k) => no && k === 'Q1')
  }
  const { stop } = await drive(state, mockAgent({ plan, integrate: plan, verify }, log))
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const labels = log.map((x) => x.label)
  const starts = labels.map((l, i) => (l === 'integrate' || l === 'integrate-again' ? i : -1)).filter((i) => i >= 0)
  assert.equal(starts.length, 2, `最初の統合と見直しの統合: ${JSON.stringify(labels)}`)
  starts.forEach((s, k) => {
    const seg = labels.slice(s, k + 1 < starts.length ? starts[k + 1] : undefined)
    const lensAt = (id) => seg.findIndex((l) => l === `lens-review-${id}` || l.startsWith(`lens-review-${id}（`))
    assert.ok(seg.some((l) => l.startsWith('lens-review-')), `${seg[0]} の後に精査役が起動される: ${JSON.stringify(seg)}`)
    if (k === 0) for (const id of ['X1', 'X2']) assert.ok(lensAt(id) > 0, `最初の統合の後に ${id} を精査する`)
    for (const id of ['X1', 'X2']) {
      const v = seg.findIndex((l) => l.startsWith(`verify-unit-${id}`))
      if (v >= 0) assert.ok(lensAt(id) > 0 && lensAt(id) < v, `${seg[0]} の後、${id} の精査は ${id} の検証役より前: ${JSON.stringify(seg)}`)
    }
  })
  const L = ledger(state)
  assert.ok(L.agents.some((x) => x.role === 'lens_reviewer' && x.label.startsWith('lens-review-')), '起動の記録の役は lens_reviewer')
})
