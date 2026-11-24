// 目標・基準・制約の引用と目標の照合の静的な照合（<goalmap> 区間）が、coverage-build と coverage-audit の Workflow source で同じ文であることを照らす。
// 2 つのスキルのファイルを読むので、配布物に入らないリポジトリ直下の tests/ に置く。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { cli as buildCli, mockAgent as buildAgent, setup as buildSetup } from '../.agents/skills/coverage-build/scripts/test-harness.mjs'
import * as auditHarness from '../.agents/skills/coverage-audit/scripts/test-harness.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const block = (p) => {
  const t = readFileSync(path.join(ROOT, p), 'utf8')
  const s = t.indexOf('// <goalmap>')
  const e = t.indexOf('// </goalmap>')
  assert.ok(s >= 0 && e > s && t.indexOf('// <checks>') < s && e < t.indexOf('// </checks>'), `${p} の <checks> の中に <goalmap> 区間がある`)
  return t.slice(s, e)
}

test('<goalmap> 区間は 2 つのスキルで同じ文', () => {
  assert.equal(block('.agents/skills/coverage-build/scripts/build-step.js'), block('.agents/skills/coverage-audit/scripts/coverage-audit.js'))
})

// ---- 目標の照合役への指示に、引用の規則を載せる（単位 P1）----
// 規則の文の正本は <goalmap> 区間の 1 か所。区間は CITE_MIN から字数を作り、coverage-build の goal_checker と、目標の照合も担う coverage-audit の planner の prompt が埋め込む。

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const BUILD_STEP = '.agents/skills/coverage-build/scripts/build-step.js'
const AUDIT_WF = '.agents/skills/coverage-audit/scripts/coverage-audit.js'
const src = (p) => readFileSync(path.join(ROOT, p), 'utf8')
const bodyOf = (text) => new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', text.replace(/^export const meta = /, 'const meta = '))
const parallel = (ts) => Promise.all(ts.map((t) => Promise.resolve().then(t).catch(() => null)))
const pipeline = (items, fn) => Promise.all(items.map((x, i) => Promise.resolve().then(() => fn(x, i)).catch(() => null)))

// 目標の照合役（goal-check）に渡る prompt を、1 回目の呼び出しの args で取り出す。text を差し替えると、差し替えた source で流す。
async function buildGoalPrompt(t, text = src(BUILD_STEP)) {
  const { state } = buildSetup(t)
  const n = buildCli('next', '--state', state)
  assert.equal(n.step, 'design', JSON.stringify(n))
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  const log = []
  await bodyOf(text)(buildAgent({}, log), parallel, pipeline, () => {}, () => {}, args, undefined)
  const hit = log.filter((x) => x.label === 'goal-check')
  assert.equal(hit.length, 1, '目標の照合役は 1 体')
  return hit[0].prompt
}
async function auditGoalPrompt(t, text = src(AUDIT_WF)) {
  const d = auditHarness.tmp(t)
  writeFileSync(path.join(d, 'doc.md'), '# 文書\n\n## 一つ目の節\nこの節は一つ目の主張を述べる本文の行である。\n')
  writeFileSync(path.join(d, 'goal.md'), '- G1: 文書の見落としを確かめた指摘の一覧 〔request: 文書をレビューしてほしい〕\n')
  writeFileSync(path.join(d, 'request.md'), '文書をレビューしてほしい')
  const state = path.join(d, 'state')
  const r = auditHarness.cli('init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md'))
  assert.equal(r.code, 0, JSON.stringify(r))
  // 照合済みの印が無い台帳の最初の呼び出しは、計画の段（目標の照合も担う計画役の行が 1 つ）。
  const n = auditHarness.cli('next', '--state', state)
  assert.equal(n.step, 'plan', JSON.stringify(n))
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  // 最初の波の行（args.wave.rows。実装の前の形は args.workers）。
  assert.deepEqual((args.wave ? args.wave.rows : args.workers).map((w) => w.role), ['planner'])
  const log = []
  // 役は起動の prompt を残すだけ（台帳と読み書きしない）。prompt に載る規則の文だけを見る。
  const agentFn = async (prompt, opts) => { log.push({ label: opts.label, prompt }); return { notes: [] } }
  await bodyOf(text)(agentFn, parallel, pipeline, () => {}, () => {}, args, undefined)
  const hit = log.filter((x) => x.label.startsWith('planner-'))
  assert.equal(hit.length, 1, '目標の照合も担う計画役は 1 体')
  return hit[0].prompt
}

// 規則が伝えること（合格条件 1）。語句は計画の文（unit-goalcheck-quote.md）のとおり。
const RULE_PARTS = [
  [/12 字以上/, '引用は 12 字以上'],
  [/(短い|12 字未満)[^。]*全体/, '短い引用は引用元の 1 件の全体を引くときだけ'],
  [/依頼文の全体/, '1 件: 依頼文の全体'],
  [/依頼文の空でない 1 行/, '1 件: 依頼文の空でない 1 行'],
  [/決定の記録の 1 行/, '1 件: 決定の記録の 1 行'],
  [/行頭の「- 」を除/, '決定の記録では行頭の「- 」を除く'],
]
// 規則の各部を述べる文（句点か改行で区切った 1 文）を並べる。2 つの prompt で同じ並びになる。
const ruleSentence = (prompt) => RULE_PARTS.map(([re]) => prompt.split(/[。\n]/).find((x) => re.test(x)) || '').join('\n')

for (const [name, get, file] of [['coverage-build の designStage の goal_checker', buildGoalPrompt, BUILD_STEP], ['coverage-audit の plan の段の planner', auditGoalPrompt, AUDIT_WF]]) {
  test(`${name} の prompt に、引用の規則（12 字以上・短い引用は 1 件の全体だけ・1 件の定義）が載る`, async (t) => {
    const prompt = await get(t)
    for (const [re, what] of RULE_PARTS) assert.match(prompt, re, `規則の文に「${what}」が無い`)
    assert.match(prompt, /決定の記録の短い行[^。]*全体/, '決定の記録の短い行は、その行の全体を引く')
  })
  test(`${name} の規則の文は <goalmap> 区間の 1 か所から作られ、CITE_MIN を変えると prompt の字数が変わる`, async (t) => {
    const text = src(file)
    // 規則の文は区間の中にだけある（prompt の側に写しを書かない）。
    // 区間の外の別の規則（coverage-audit の QUOTE_RULE。本文を引く役向け）は「字以上」を含んでよいので、この規則に固有の語で照らす。
    const own = ['引用元の 1 件', '決定の記録の 1 行']
    for (const w of own) assert.ok(block(file).includes(w), `区間に規則の文（または文を作る関数）がある: ${w}`)
    for (const w of own) assert.ok(!text.replace(block(file), '').includes(w), `区間の外に規則の文の写しが無い: ${w}`)
    const changed = text.replace('const CITE_MIN = 12', 'const CITE_MIN = 15')
    assert.notEqual(changed, text)
    const prompt = await get(t, changed)
    assert.match(prompt, /15 字以上/, '字数は CITE_MIN から作る')
    assert.doesNotMatch(prompt, /12 字以上/)
  })
}

test('coverage-build の goal_checker と coverage-audit の planner の prompt の規則の文は同じ', async (t) => {
  const a = ruleSentence(await buildGoalPrompt(t))
  const b = ruleSentence(await auditGoalPrompt(t))
  assert.ok(!a.split('\n').includes('') && a === b, `規則の文が食い違う:\n${a}\n${b}`)
})

// 合格条件 3: 静的な照合（citeProblem）は変えない。規則の文を足しても、受け付ける引用・拒否する引用は今のまま。
test('citeProblem: 12 字未満の引用は、引用元の 1 件の全体を引くときだけ受け付ける（照合は変わらない）', () => {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
  const { citeProblem, citeSources } = new Function('norm', 'isStr', 'arr', `${block(BUILD_STEP)}\nreturn { citeProblem, citeSources }`)(norm, (s) => typeof s === 'string' && s.trim().length > 0, (a) => (Array.isArray(a) ? a : []))
  const request = '値を計算する関数を作り、使い方を書いてほしい\n短い依頼の行'
  const decisions = '- Q1 への利用者の回答: 実装レビューの前だけ\n- 入力が 1 なら 2 を返す'
  const s = citeSources({ request, decisions })
  const q = (source, quote) => citeProblem({ source, quote }, s)
  assert.equal(q('decisions', 'Q1 への利用者の回答: 実装レビューの前だけ'), null, '決定の記録の短い行は、行の全体なら受け付ける（行頭の「- 」は除く）')
  assert.match(q('decisions', '実装レビューの前だけ'), /字未満/, '行の一部の短い引用は拒否する（cb-goal3 で 4 回続けて落ちた引用）')
  assert.equal(q('decisions', '入力が 1 なら 2 を返す'), null, '12 字以上なら行の一部でも受け付ける')
  assert.equal(q('request', '短い依頼の行'), null, '依頼文の空でない 1 行の全体は受け付ける')
  assert.match(q('request', '短い依頼'), /字未満/, '依頼文の行の一部の短い引用は拒否する')
  assert.match(q('decisions', 'この文は無い引用の文です'), /逐語で無い/)
})
