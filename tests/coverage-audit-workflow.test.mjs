// coverage-audit の Workflow source が Codex の runner（dynamic-workflow-runner の runtime）でも動くことを、偽の backend で確かめる。
// 偽の backend は担当と同じく写しのファイルを読む。実際の Codex の worker が stateDir の写しを読めるかは、このテストでは確かめていない。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Workflow } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs'
import { readSourceMetadata } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs'
import { C } from '../.agents/skills/coverage-audit/scripts/ledger-core.mjs'
import { WF, cli, drive, evidenceOf, mockAgent, runWorkflow, tmp } from '../.agents/skills/coverage-audit/scripts/test-harness.mjs'

const META = readSourceMetadata(readFileSync(WF, 'utf8'))
const ROLES = JSON.parse(readFileSync(path.join(path.dirname(WF), 'roles.json'), 'utf8'))

const backend = (agentFn) => ({ capabilities: ['read-only', 'fresh-thread', 'workspace-write'], run: (prompt, options) => agentFn(prompt, options) })
const viaRunner = (t) => (args, agentFn) => Workflow({ scriptPath: WF, args }, { backend: backend(agentFn), runDir: path.join(tmp(t), 'run'), trustedSource: true, ...META.limits })

function reviewSetup(t) {
  const d = tmp(t)
  writeFileSync(path.join(d, 'doc.md'), '# 文書\n\n## 一つ目の節\nこの節は一つ目の主張を述べる本文の行である。\n\n## 二つ目の節\nこの節は二つ目の主張を述べる本文の行である。\n')
  writeFileSync(path.join(d, 'goal.md'), '- G1: 文書を観点ごとに確かめた指摘の一覧 〔request: 文書を観点ごとにレビューしてほしい〕\n')
  writeFileSync(path.join(d, 'request.md'), '文書を観点ごとにレビューしてほしい')
  writeFileSync(path.join(d, 'lenses.json'), JSON.stringify([{ id: 'L1', name: '主張と根拠', procedure: '主張ごとに根拠を対応づける' }]))
  const state = path.join(d, 'state')
  assert.equal(cli('init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md'), '--lenses', path.join(d, 'lenses.json')).code, 0)
  return state
}

test('meta: limits の写しが本体と一致し、最悪の起動数が maxAgents に収まる', () => {
  assert.deepEqual({ ...META.limits }, { ...C.LIMITS })
  assert.deepEqual([...META.requirements], ['fresh-thread', 'workspace-write'])
  assert.equal(C.PER_CELL, undefined, '枡ごとの起動数 PER_CELL は無い（review の起動数は workers の行の数）')
  assert.ok(1 + 4 + 2 <= C.LIMITS.maxAgents, 'plan の固定部分（目標・計画役 2 体とやり直し・統合とやり直し）が収まる')
  for (const role of ['goal_checker', 'planner_a', 'planner_b', 'integrator', 'unit_verifier', 'reader_1', 'verifier', 'grouper', 'refuter_a', 'refuter_b']) {
    assert.ok(ROLES[role] && ROLES[role].model && ROLES[role].effort, `roles.json に ${role} の model と effort がある`)
  }
  assert.notEqual(ROLES.planner_a.model, ROLES.planner_b.model, '独立な計画役は別のモデル')
  // p 回目の読む役（reader_p、無ければ reader_1）と検証役（verifier_p、無ければ verifier）は別のモデル。
  for (const p of [1, 2, 3].filter((n) => n === 1 || ROLES[`reader_${n}`])) {
    const r = ROLES[`reader_${p}`] || ROLES.reader_1
    const v = ROLES[`verifier_${p}`] || ROLES.verifier
    assert.notEqual(r.model, v.model, `${p} 回目の読む役と検証役は別のモデル`)
  }
})

test('roles: 観点の精査役 lens_reviewer は opus、unit_verifier は sonnet で統合役と別のモデル、refuter_a は sonnet・refuter_b は opus', () => {
  assert.ok(ROLES.lens_reviewer && ROLES.lens_reviewer.effort && ROLES.lens_reviewer.why, 'roles.json に lens_reviewer の model・effort・理由がある')
  assert.equal(ROLES.lens_reviewer.model, 'opus')
  assert.equal(ROLES.unit_verifier.model, 'sonnet')
  assert.notEqual(ROLES.unit_verifier.model, ROLES.integrator.model, '観点の検証役は統合役と別のモデル')
  assert.equal(ROLES.refuter_a.model, 'sonnet')
  assert.equal(ROLES.refuter_b.model, 'opus')
  assert.notEqual(ROLES.refuter_a.model, ROLES.grouper.model, 'refuter_a は束ね役と別のモデル')
})

test('runner: review の流れが最後まで回り、全ての枡を確かめて完了する', async (t) => {
  const state = reviewSetup(t)
  const { stop, steps } = await drive(state, mockAgent(), { run: viaRunner(t) })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.equal(stop.coverage.settled, 2) // 2 資産 × 利用者の観点 L1 × k=1
  // review の 1 回の起動数は workers の行の数（2 × k × N）で、maxAgents に収まる。
  for (const s of steps.filter((x) => x.step === 'review')) {
    assert.equal(s.res.agents.length, s.args.workers.length)
    assert.ok(s.args.workers.length <= C.LIMITS.maxAgents)
  }
})

test('runner: 照合に落ちる枡の提出は拒否され、出し直しても落ちれば試行の上限で開示に倒す', async (t) => {
  const state = reviewSetup(t)
  const bad = mockAgent({ read: (p, o) => (o.label.includes('一つ目の節/p1|L1') ? { cell_id: 1 } : undefined) })
  const { stop } = await drive(state, bad, { run: viaRunner(t) })
  assert.equal(stop.stop, 'complete')
  assert.equal(stop.disclosed.length, 1)
  assert.ok(stop.disclosed[0].includes('一つ目の節/p1|L1'))
})

test('runner: 計画・読み・振り返り・束ねが回り、上の層の欠陥は needs_input で返す', async (t) => {
  const state = reviewSetup(t)
  const once = { done: false }
  const agentFn = mockAgent({
    read: (p, o) => {
      if (once.done || !o.label.includes('二つ目の節/p1|L1')) return undefined
      once.done = true
      return { cell_id: o.label.slice(5).split('（')[0], evidence: evidenceOf(p), findings: [{ claim: '目標に効かない', quote: 'この節は二つ目の主張を述べる本文の行である。', severity: 'LOW', layer: '要求' }], outside_notes: ['観点の外の気づき'], none_reason: '' }
    },
  })
  const { stop, steps } = await drive(state, agentFn, { run: viaRunner(t) })
  assert.equal(stop.stop, 'needs_input', '要求の層の欠陥は利用者に返す')
  assert.equal(stop.upper.length, 1)
  assert.deepEqual([...new Set(steps.map((s) => s.step))], ['plan', 'review', 'group'])
  assert.ok(steps.every((s) => s.res.tokens === null), 'runner では消費量を読めないので null')
  const status = cli('status', '--state', state)
  assert.equal(status.outside_notes.length, 1)
})

// ---- 本文を引く役に、引用の規則を伝える（単位 P8）----
// 規則の文の正本は <checks> 区間の QUOTE_RULE の 1 か所。quoteProblem で照らす引用を返す役の prompt だけが埋め込む。
// 目標の照合役（goal-check）には <goalmap> 区間の CITE_RULE だけが載り、食い違う規則が 2 つ並ばない。

const AUDIT_SRC = readFileSync(WF, 'utf8')
const CHECKS = (src) => src.slice(src.indexOf('// <checks>'), src.indexOf('// </checks>'))
const quoteRuleOf = (src = AUDIT_SRC) => new Function(`${CHECKS(src)}\nreturn { QUOTE_RULE, QUOTE_MIN }`)()

test('QUOTE_RULE: <checks> 区間にあり、引用は 12 字以上・短い引用は全体か 1 行の全体・見出しだけは証拠にならない・1 要素でも合わなければ提出ごと拒まれる、を伝える', () => {
  const { QUOTE_RULE, QUOTE_MIN } = quoteRuleOf()
  assert.equal(typeof QUOTE_RULE, 'string')
  assert.equal(QUOTE_MIN, 12)
  assert.match(QUOTE_RULE, /12 字以上/, '引用は 12 字以上')
  assert.match(QUOTE_RULE, /短い引用[^。]*本文の全体[^。]*本文の空でない 1 行の全体[^。]*だけ/, '短い引用は、本文の全体か、本文の空でない 1 行の全体を引くときだけ')
  assert.match(QUOTE_RULE, /見出し[^。]*だけ[^。]*証拠にならない/, '見出しの行だけの引用は証拠にならない')
  assert.match(QUOTE_RULE, /evidence の 1 要素でも[^。]*提出ごと[^。]*拒/, 'evidence の 1 要素でも合わなければ提出ごと拒まれる')
})

test('QUOTE_RULE: 字数は QUOTE_MIN から作る（QUOTE_MIN を変えると規則の字数が変わる）', () => {
  assert.ok(AUDIT_SRC.includes('const QUOTE_MIN = 12'))
  const changed = AUDIT_SRC.replace('const QUOTE_MIN = 12', 'const QUOTE_MIN = 15')
  const { QUOTE_RULE } = quoteRuleOf(changed)
  assert.match(QUOTE_RULE, /15 字以上/)
  assert.doesNotMatch(QUOTE_RULE, /12 字/, '規則の文に字数を直に書かない')
  // 規則の字数の文は <checks> 区間の外に写しを持たない（prompt の側に「12 字以上」を書かない）。
  assert.ok(!AUDIT_SRC.replace(CHECKS(AUDIT_SRC), '').replace(/\/\/.*$/gm, '').match(/12 字以上/), '区間の外に規則の文の写しが無い')
})

test('QUOTE_RULE: COMMON には入れず、CLI（ledger-core）の読み込みの一覧にも足さない', () => {
  const common = AUDIT_SRC.slice(AUDIT_SRC.indexOf('const COMMON = '), AUDIT_SRC.indexOf('// ---------------- plan'))
  assert.ok(common.includes('## 共通の前提'))
  assert.ok(!common.includes('QUOTE_RULE'), 'COMMON は全ての役に載るので規則を入れない')
  assert.equal(C.QUOTE_RULE, undefined, 'CLI は QUOTE_RULE を使わない')
  const core = readFileSync(path.join(path.dirname(WF), 'ledger-core.mjs'), 'utf8')
  assert.ok(!core.includes('QUOTE_RULE'), 'ledger-core の return の一覧に足さない')
})

test('quoteProblem の判定は変わらない（短い引用は全体か 1 行の全体だけ・見出しだけは拒む・1 要素でも落ちれば読みの照合に落ちる）', () => {
  const text = '# 文書\n\n## 一つ目の節についての長い見出しの行\n短い行\nこの節は一つ目の主張を述べる本文の行である。\n'
  assert.equal(C.quoteProblem('この節は一つ目の主張を述べる本文の行である。', text), null)
  assert.equal(C.quoteProblem('短い行', text), null, '空でない 1 行の全体は受け付ける')
  assert.match(C.quoteProblem('一つ目', text), /字未満/, '行の一部の短い引用は拒む')
  assert.match(C.quoteProblem('## 一つ目の節についての長い見出しの行', text), /見出し/, '見出しだけの引用は拒む')
  assert.equal(C.quoteProblem('# 文書', '# 文書'), null, '本文の全体なら見出しでも短くても受け付ける')
  const asset = { text, blocks: [[0, 4]], need: 1 }
  const ok = { evidence: ['この節は一つ目の主張を述べる本文の行である。'], findings: [], none_reason: 'x' }
  assert.deepEqual(C.checkRead(ok, asset), [])
  const bad = { ...ok, evidence: [...ok.evidence, '一つ目'] }
  assert.ok(C.checkRead(bad, asset).some((x) => /evidence\[1\]/.test(x)), '1 要素でも合わなければ照合に落ちる')
})

// 計画・観点の精査・観点の検証・読む役・検証役・束ね・反証が回る run を流し、役ごとの prompt（Workflow が渡した文）を集める。
async function promptsByLabel(t) {
  const d = tmp(t)
  writeFileSync(path.join(d, 'doc.md'), '# 文書\n\n## 一つ目の節\nこの節は一つ目の主張を述べる本文の行である。\n\n## 二つ目の節\nこの節は二つ目の主張を述べる本文の行である。\n')
  writeFileSync(path.join(d, 'goal.md'), '- G1: 文書を観点ごとに確かめた指摘の一覧 〔request: 文書を観点ごとにレビューしてほしい〕\n')
  writeFileSync(path.join(d, 'request.md'), '文書を観点ごとにレビューしてほしい')
  const state = path.join(d, 'state')
  assert.equal(cli('init', '--state', state, '--goal', path.join(d, 'goal.md'), '--request', path.join(d, 'request.md'), '--target', path.join(d, 'doc.md')).code, 0)
  const log = []
  const once = { done: false }
  const agentFn = mockAgent({
    read: (p, o) => {
      if (once.done || !o.label.includes('二つ目の節/p1|')) return undefined
      once.done = true
      return { cell_id: o.label.slice(5).split('（')[0], evidence: evidenceOf(p), findings: [{ claim: '主張に根拠が無い', quote: 'この節は二つ目の主張を述べる本文の行である。', severity: 'LOW', layer: '実装' }], outside_notes: [], none_reason: '' }
    },
  }, log)
  const { stop } = await drive(state, agentFn, { maxSteps: 40 })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  const pick = (re) => log.filter((x) => re.test(x.label)).map((x) => x.raw)
  return {
    quoting: { 'review の読む役の worker': pick(/^worker-read-/), 'review の検証役の worker': pick(/^worker-verify-/), '観点の精査役（N1・N2）': pick(/^lens-review-/), '観点の検証役（Q1〜Q3）': pick(/^verify-unit-/) },
    others: { '目標の照合役': pick(/^goal-check/), '計画役': pick(/^plan-[AB]/), '統合役': pick(/^integrate/), '束ね役': pick(/^group/), '反証役': pick(/^refute-/) },
  }
}

test('prompt: quoteProblem で引用を照らす 4 つの役（読む役・検証役の worker、観点の精査役、観点の検証役）に QUOTE_RULE が 1 回ずつ載る', async (t) => {
  const { quoting } = await promptsByLabel(t)
  const { QUOTE_RULE } = quoteRuleOf()
  for (const [who, prompts] of Object.entries(quoting)) {
    assert.ok(prompts.length > 0, `${who} が起動していない`)
    for (const p of prompts) assert.equal(p.split(QUOTE_RULE).length - 1, 1, `${who} の prompt に QUOTE_RULE が 1 回載らない`)
  }
})

test('prompt: 引用を照らさない役（目標の照合役・計画役・統合役・束ね役・反証役）には QUOTE_RULE が載らず、目標の照合役には CITE_RULE だけが載る', async (t) => {
  const { others } = await promptsByLabel(t)
  const { QUOTE_RULE } = quoteRuleOf()
  for (const [who, prompts] of Object.entries(others)) {
    assert.ok(prompts.length > 0, `${who} が起動していない`)
    for (const p of prompts) assert.ok(!p.includes(QUOTE_RULE), `${who} の prompt に QUOTE_RULE が載っている`)
  }
  for (const p of others['目標の照合役']) {
    assert.match(p, /引用元の 1 件の全体/, '目標の照合役には引用元の規則（CITE_RULE）が載る')
    assert.doesNotMatch(p, /見出し[^。]*だけ[^。]*証拠にならない/, '見出しの規則は引用元には当てはまらず、2 つの規則が並ばない')
  }
})

test('prompt: 読む役の結果の形から「見出しの行だけは証拠にならない」の括弧書きを外し、見出しの規則は QUOTE_RULE の 1 か所にする', async (t) => {
  const { quoting } = await promptsByLabel(t)
  const { QUOTE_RULE } = quoteRuleOf()
  const reads = quoting['review の読む役の worker']
  assert.ok(reads.length > 0)
  for (const p of reads) {
    assert.ok(!p.includes('見出しの行だけは証拠にならない'), '結果の形に QUOTE_RULE と重なる括弧書きが残っている')
    assert.equal((p.match(/証拠にならない/g) || []).length, (QUOTE_RULE.match(/証拠にならない/g) || []).length, '見出しの規則を述べる文が QUOTE_RULE の外にある')
    assert.match(p, /evidence/, '結果の形の evidence の指示は残る')
    assert.match(p, /区画名・行番号・説明・括弧を付けない/, '括弧書きだけを外し、evidence の書き方の指示は残す')
  }
  assert.ok(!AUDIT_SRC.includes('見出しの行だけは証拠にならない'), 'source に括弧書きが残っていない')
})

// ---- 呼び出しごとの消費量を、差で記録する（単位 P12）----
// native は budget.spent()（run 全体の累計）を注入する。各 source は本体の始めと返す直前に読み、tokens にその差を入れる。
// 累計をそのまま入れると、呼び出しごとの費用が読めず、呼び出し間の比べ方が成り立たない。
// budget.spent() が何を数えるか（司令塔・担当の入力・出力のどれか）は確かめていない。ここでは同じ量の差どうしだけを比べる。
const BASE = 10_000_000
const COST = 100
const DIFF_NOTE = 'この呼び出しの budget.spent() の差'

// 読んでも進まず、担当の起動ごとに COST だけ進む計器。1 回の呼び出しの消費量は担当の起動数 × COST になる。
function metered() {
  const m = { v: BASE, spent: () => m.v }
  m.agent = (fn) => (...a) => { m.v += COST; return fn(...a) }
  return m
}
// 読むたびに step だけ進む計器。始めと返す直前の 2 回の読みの差は step になる。
function ticking(step = 1000) {
  const m = { v: BASE, spent: () => { m.v += step; return m.v } }
  return m
}
// 読むたびに列の次の値を返す計器（最後の値は繰り返す）。
function sequence(...vals) {
  let i = 0
  return { spent: () => vals[Math.min(i++, vals.length - 1)] }
}
const ledgerOf = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))

const auditRun = (budget) => (args, fn) => runWorkflow(args, fn, { budget })

test('tokens: 呼び出しごとの tokens は担当の起動で増えた分の差で、累計を入れず、台帳の calls と tokens_note に同じ差が残る', async (t) => {
  const state = reviewSetup(t)
  const m = metered()
  const consumed = []
  const run = async (args, fn) => {
    const before = m.v
    const res = await auditRun(m)(args, m.agent(fn))
    consumed.push(m.v - before)
    return res
  }
  const { stop, steps } = await drive(state, mockAgent(), { run })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(['plan', 'review'].every((k) => steps.some((s) => s.step === k)))
  assert.equal(consumed.length, steps.length)
  assert.deepEqual(steps.map((s) => s.res.tokens), consumed, 'tokens は呼び出しの中で増えた分')
  assert.ok(consumed.some((c) => c > 0))
  assert.ok(steps.every((s) => s.res.tokens < BASE), '累計（run の始めからの総量）を入れない')
  const L = ledgerOf(state)
  assert.deepEqual(L.calls.map((c) => c.tokens), consumed, '台帳の calls[].tokens も差')
  assert.ok(L.calls.every((c) => c.tokens_note === DIFF_NOTE), `tokens_note は「${DIFF_NOTE}」`)
})

test('tokens: 読むたびに進む計器でも、始めと返す直前の 2 回の読みの差になる', async (t) => {
  const state = reviewSetup(t)
  const m = ticking(1000)
  const { stop, steps } = await drive(state, mockAgent(), { run: auditRun(m) })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(steps.length >= 2)
  assert.ok(steps.every((s) => s.res.tokens === 1000), JSON.stringify(steps.map((s) => s.res.tokens)))
  assert.ok(ledgerOf(state).calls.every((c) => c.tokens === 1000 && c.tokens_note === DIFF_NOTE))
})

test('tokens: 束ねの段（group）も差で返す', async (t) => {
  const state = reviewSetup(t)
  const once = { done: false }
  const agentFn = mockAgent({
    read: (p, o) => {
      if (once.done || !o.label.includes('二つ目の節/p1|L1')) return undefined
      once.done = true
      return { cell_id: o.label.slice(5).split('（')[0], evidence: evidenceOf(p), findings: [{ claim: '目標に効かない', quote: 'この節は二つ目の主張を述べる本文の行である。', severity: 'LOW', layer: '要求' }], outside_notes: [], none_reason: '' }
    },
  })
  const m = ticking(1000)
  const { steps } = await drive(state, agentFn, { run: auditRun(m) })
  const group = steps.filter((s) => s.step === 'group')
  assert.ok(group.length >= 1, JSON.stringify(steps.map((s) => s.step)))
  assert.ok(group.every((s) => s.res.tokens === 1000))
})

for (const [name, budget] of [
  ['budget が無い', undefined],
  ['spent が無い', {}],
  ['始めに読めない', sequence(undefined, BASE)],
  ['返す直前に読めない', sequence(BASE, undefined)],
]) {
  test(`tokens: ${name}ときは null で、台帳の tokens_note は読めない経路のまま`, async (t) => {
    const state = reviewSetup(t)
    const { steps } = await drive(state, mockAgent(), { run: auditRun(budget), maxSteps: 1 })
    assert.equal(steps.length, 1)
    assert.equal(steps[0].res.tokens, null, '片方でも読めなければ、累計を差として入れず null')
    const c = ledgerOf(state).calls[0]
    assert.equal(c.tokens, null)
    assert.match(c.tokens_note, /読めない/)
  })
}
