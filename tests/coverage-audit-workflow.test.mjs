// coverage-audit の Workflow source（coverage-audit.js）を、本物の CLI と偽の役で流して確かめる。
// 役の偽物は blackboard-fixture.mjs（計画の段は plan-roles.mjs）で、prompt の claim の命令から台帳と読み書きする。
// Codex の runner（dynamic-workflow-runner の runtime）でも流す。偽の役は担当の写しを読むが、実際の Codex の worker が stateDir の写しを読めるかは確かめていない。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { Workflow } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs'
import { readSourceMetadata } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs'
import { C } from '../.agents/skills/coverage-audit/scripts/ledger-core.mjs'
import { LAUNCHER } from '../.agents/skills/coverage-audit/scripts/ledger-cli.mjs'
import { CLI, ROLES, WF, argOf, behave, cli, cliArgvOf, driveScript, project, runScript, scriptAgent, shellWords, tmp } from '../.agents/skills/coverage-audit/scripts/blackboard-fixture.mjs'
import { planAct } from '../.agents/skills/coverage-audit/scripts/plan-roles.mjs'

const META = readSourceMetadata(readFileSync(WF, 'utf8'))
const backend = (agentFn) => ({ capabilities: ['read-only', 'fresh-thread', 'workspace-write'], run: (prompt, options) => agentFn(prompt, options) })
const viaRunner = (t) => (args, agentFn) => Workflow({ scriptPath: WF, args }, { backend: backend(agentFn), runDir: path.join(tmp(t), 'run'), trustedSource: true, ...META.limits })

const DOC = '# 文書\n\n## 一つ目の節\nこの節は一つ目の主張を述べる本文の行である。\n\n## 二つ目の節\nこの節は二つ目の主張を述べる本文の行である。\n'
const Q2 = 'この節は二つ目の主張を述べる本文の行である。'
const ledgerOf = (state) => JSON.parse(readFileSync(path.join(state, 'ledger.json'), 'utf8'))
// 束ねの意図（確認役が取る）の偽物: 確定した指摘の事実（basis）の全件を 1 つの群に入れる。
const GROUPING = {
  group: (task, ctx) => { const q = ctx.query(task); return { groups: [{ id: 'g1', root_cause: '根の原因', layer: '実装', keys: q.basis.map((f) => f.id) }], unassigned: [] } },
}
// doc.md に 1 件の指摘を書くファイルの段（layer は原因の層）。
const oneFinding = (layer = '実装') => ({ facts: (p) => (path.basename(p) === 'doc.md' ? { findings: [{ claim: '主張に根拠が無い', quote: Q2, severity: 'LOW', layer }] } : {}) })

test('meta: limits の写しが本体と一致し、runner の要件は今のまま。段は CLI の段の名前', () => {
  assert.deepEqual({ ...META.limits }, { ...C.LIMITS })
  assert.deepEqual([...META.requirements], ['fresh-thread', 'workspace-write'])
  assert.equal(C.PER_CELL, undefined, '枡ごとの起動数 PER_CELL は無い（1 回の起動数は workers の行の数）')
  assert.deepEqual(META.phases.map((p) => p.title), ['plan', 'unit_verify', 'full_review', 'file', 'global', 'retro'], '目標の照合・統合・束ね・反証の段は無い（照合は計画役、束ねは全体の段の意図）。全文レビューは計画の段の後・ファイルの段の前')
  for (const gone of ['argsSum', 'checkRead', 'checkVerify', 'settleVerdict', 'checkLensReview', 'LENS_QUESTIONS', 'checkAppliesTo']) assert.equal(C[gone], undefined, `${gone} は無い`)
})

test('roles: 計画役・観点の検証役・全文レビューの役・読む役・判定役・確認役だけがあり、判断を出す役と確かめる役は別のモデル（計画役と観点の検証役、判定役と確認役）', () => {
  for (const role of ['planner', 'unit_verifier', 'full_reviewer', 'file_reader', 'global_judge', 'confirmer']) {
    assert.ok(ROLES[role] && ROLES[role].model && ROLES[role].effort && ROLES[role].why, `roles.json に ${role} の model・effort・理由がある`)
  }
  for (const gone of ['lens_reviewer', 'goal_checker', 'planner_a', 'planner_b', 'integrator', 'alias_judge', 'grouper', 'refuter_a', 'refuter_b']) assert.equal(ROLES[gone], undefined, `${gone} は無い`)
  assert.notEqual(ROLES.unit_verifier.model, ROLES.planner.model, '観点の検証役は計画役と別のモデル')
  assert.notEqual(ROLES.confirmer.model, ROLES.global_judge.model, '確認役は判定役と別のモデル')
})

// ---- CLI の入口（args で CLI の置き場を運ばないので、stateDir に CLI が書く）----

test('入口: init と next が stateDir/ledger-cli.mjs に、本物の CLI を絶対パスで import して流すだけの入口を書き直し、prompt の claim はそれを指す', async (t) => {
  const { state } = project(t, { 'doc.md': DOC })
  const file = path.join(state, LAUNCHER)
  const want = `// 生成物: ${LAUNCHER} が init・next のたびに書き直す。本物の CLI を流すだけ。\nimport { runMain } from ${JSON.stringify(pathToFileURL(CLI).href)}\nrunMain(process.argv.slice(2))\n`
  assert.equal(readFileSync(file, 'utf8'), want, 'init が書く')
  // 古い置き場の path が残っていても、next が書き直す。
  writeFileSync(file, 'import "/old/place/ledger-cli.mjs"\n')
  const n = cli('next', '--state', state)
  assert.equal(n.code, 0, JSON.stringify(n))
  assert.equal(readFileSync(file, 'utf8'), want, 'next が書き直す')
  // 入口を子プロセスで流すと、本物の CLI と同じ出力になる。
  const viaLauncher = spawnSync(process.execPath, [file, 'status', '--state', state], { encoding: 'utf8' })
  const direct = spawnSync(process.execPath, [CLI, 'status', '--state', state], { encoding: 'utf8' })
  assert.equal(viaLauncher.status, 0, viaLauncher.stderr)
  assert.equal(viaLauncher.stdout, direct.stdout)
  // Workflow の prompt の claim の命令は、この入口を指す。
  const log = []
  const args = JSON.parse(readFileSync(n.args_path, 'utf8'))
  await runScript(args, scriptAgent(behave(), log))
  assert.ok(log.length > 0)
  for (const x of log) {
    const line = x.prompt.split('\n').find((l) => l.includes(' claim --state '))
    assert.equal(shellWords(line)[1], file, `claim は stateDir の入口を流す: ${line}`)
    assert.equal(argOf(x.claim, 'state'), state)
  }
})

// ---- runner（Codex）でも流れる ----

test('runner: ファイルの段と全体の段が最後まで回り、全ての単位を読んで完了する。1 回の起動数は workers の行の数', async (t) => {
  const { state } = project(t, { 'doc.md': DOC })
  const { stop, steps } = await driveScript(state, scriptAgent(behave()), { runWf: viaRunner(t) })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.equal(stop.coverage.seen, stop.coverage.units)
  for (const s of steps) {
    assert.equal(s.res.agents.length, s.args.workers.length)
    assert.ok(s.args.workers.length <= C.LIMITS.maxAgents)
  }
})

test('runner: 照合に落ちる提出は拒否され、出し直しても落ちれば試行の上限で開示に倒す', async (t) => {
  const { state, paths } = project(t, { 'doc.md': DOC, 'other.md': '# 別\n\nこの文書は別の単位の本文として置く行である。\n' })
  const bad = behave({ file: (task) => (task.unit.path === paths['doc.md'] ? { seen: [] } : undefined) })
  const { stop } = await driveScript(state, scriptAgent(bad), { runWf: viaRunner(t) })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.deepEqual(stop.coverage.disclosed, [paths['doc.md']])
  assert.ok(ledgerOf(state).events.some((e) => e.kind === 'rejected_file'))
})

test('runner: 計画・観点の検証・ファイル・全体（束ねを含む）が回り、上の層の欠陥は needs_input で返す。tokens は null', async (t) => {
  const { state } = project(t, { 'doc.md': DOC }, { lenses: null })
  const { stop, steps } = await driveScript(state, scriptAgent(planAct({ ...oneFinding('要求'), ...GROUPING })), { runWf: viaRunner(t) })
  assert.equal(stop.stop, 'needs_input', JSON.stringify(stop))
  assert.equal(stop.upper.length, 1, '要求の層の欠陥は利用者に返す')
  const stages = new Set(steps.map((s) => s.args.stage))
  for (const k of ['plan', 'unit_verify', 'file', 'global']) assert.ok(stages.has(k), `${k} が回る: ${[...stages]}`)
  assert.ok(ledgerOf(state).groups.some((g) => g.root_cause === '根の原因'), '束ねは全体の段の意図として回る')
  assert.ok(steps.every((s) => s.res.tokens === null), 'runner では消費量を読めないので null')
})

// ---- 本文を引く役に、引用の規則を伝える ----
// 規則の文の正本は <checks> 区間の QUOTE_RULE の 1 か所。quoteProblem で照らす引用を返す役の prompt だけが埋め込む。
// 目標の照合役には <goalmap> 区間の CITE_RULE だけが載り、食い違う規則が 2 つ並ばない。

const AUDIT_SRC = readFileSync(WF, 'utf8')
const CHECKS = (src) => src.slice(src.indexOf('// <checks>'), src.indexOf('// </checks>'))
const quoteRuleOf = (src = AUDIT_SRC) => new Function(`${CHECKS(src)}\nreturn { QUOTE_RULE, QUOTE_MIN }`)()

test('QUOTE_RULE: <checks> 区間にあり、引用は 12 字以上・短い引用は全体か 1 行の全体・見出しだけは証拠にならない・1 つでも合わなければ提出ごと拒まれる、を伝える', () => {
  const { QUOTE_RULE, QUOTE_MIN } = quoteRuleOf()
  assert.equal(typeof QUOTE_RULE, 'string')
  assert.equal(QUOTE_MIN, 12)
  assert.match(QUOTE_RULE, /12 字以上/, '引用は 12 字以上')
  assert.match(QUOTE_RULE, /短い引用[^。]*本文の全体[^。]*本文の空でない 1 行の全体[^。]*だけ/, '短い引用は、本文の全体か、本文の空でない 1 行の全体を引くときだけ')
  assert.match(QUOTE_RULE, /見出し[^。]*だけ[^。]*証拠にならない/, '見出しの行だけの引用は証拠にならない')
  assert.match(QUOTE_RULE, /引用の 1 つでも[^。]*提出ごと[^。]*拒/, '引用の 1 つでも合わなければ提出ごと拒まれる')
})

test('QUOTE_RULE: 字数は QUOTE_MIN から作る（QUOTE_MIN を変えると規則の字数が変わる）', () => {
  assert.ok(AUDIT_SRC.includes('const QUOTE_MIN = 12'))
  const changed = AUDIT_SRC.replace('const QUOTE_MIN = 12', 'const QUOTE_MIN = 15')
  const { QUOTE_RULE } = quoteRuleOf(changed)
  assert.match(QUOTE_RULE, /15 字以上/)
  assert.doesNotMatch(QUOTE_RULE, /12 字/, '規則の文に字数を直に書かない')
  assert.ok(!AUDIT_SRC.replace(CHECKS(AUDIT_SRC), '').replace(/\/\/.*$/gm, '').match(/12 字以上/), '区間の外に規則の文の写しが無い')
})

test('QUOTE_RULE: COMMON には入れず、CLI（ledger-core）の読み込みの一覧にも足さない', () => {
  const common = AUDIT_SRC.slice(AUDIT_SRC.indexOf('const COMMON = '), AUDIT_SRC.indexOf('const loop = '))
  assert.ok(common.includes('## 共通の前提'))
  assert.ok(!common.includes('QUOTE_RULE'), 'COMMON は全ての役に載るので規則を入れない')
  assert.equal(C.QUOTE_RULE, undefined, 'CLI は QUOTE_RULE を使わない')
  const core = readFileSync(path.join(path.dirname(WF), 'ledger-core.mjs'), 'utf8')
  assert.ok(!core.includes('QUOTE_RULE'), 'ledger-core の return の一覧に足さない')
})

test('quoteProblem の判定は変わらない（短い引用は全体か 1 行の全体だけ・見出しだけは拒む）', () => {
  const text = '# 文書\n\n## 一つ目の節についての長い見出しの行\n短い行\nこの節は一つ目の主張を述べる本文の行である。\n'
  assert.equal(C.quoteProblem('この節は一つ目の主張を述べる本文の行である。', text), null)
  assert.equal(C.quoteProblem('短い行', text), null, '空でない 1 行の全体は受け付ける')
  assert.match(C.quoteProblem('一つ目', text), /字未満/, '行の一部の短い引用は拒む')
  assert.match(C.quoteProblem('## 一つ目の節についての長い見出しの行', text), /見出し/, '見出しだけの引用は拒む')
  assert.equal(C.quoteProblem('# 文書', '# 文書'), null, '本文の全体なら見出しでも短くても受け付ける')
})

// 計画（目標の照合を含む）・観点の検証・ファイルの段・全体の段（名寄せ・主語の照合・確認・束ねを含む）・振り返りが回る run を流し、役ごとの prompt を集める。
const QA = 'この文書は台帳の lock を取ってから書き込むことを保証する。'
const QB = 'この文書は lock が書き込みを直列にすることを前提にする。'
async function promptsByRole(t) {
  const { state } = project(t, { 'a.md': `# A\n\n## 保証\n${QA}\n`, 'b.md': `# B\n\n## 前提\n${QB}\n` }, {
    lenses: null, goalChecked: false, criteria: null, goal: '- G1: 対象の文書を観点ごとに確かめた指摘の一覧 〔request: 対象の文書を観点ごとにレビューしてほしい〕\n',
  })
  const facts = (p) => (path.basename(p) === 'a.md'
    ? { guarantees: [{ subject: '台帳の lock', quote: QA, confidence: 'high' }], findings: [{ claim: '指摘', quote: QA, severity: 'HIGH' }] }
    : { premises: [{ subject: 'lock', quote: QB, confidence: 'high' }] })
  const subject = (task, ctx) => {
    const locs = ctx.query(task).basis.filter((f) => f.quote).map((f) => ({ unit: f.unit, quote: f.quote }))
    return { verdict: 'conflict', quote: locs[0].quote, findings: [{ claim: '主語の照合が足した矛盾', locations: locs, obligation: 'G1', confidence: 'high', severity: 'HIGH', layer: '方式設計' }] }
  }
  const log = []
  const { stop } = await driveScript(state, scriptAgent(planAct({ facts, subject, ...GROUPING }), log), { maxSteps: 60 })
  assert.ok(['complete', 'needs_input'].includes(stop.stop), JSON.stringify(stop))
  const by = (...roles) => log.filter((x) => roles.some((r) => x.label.startsWith(`${r}-`))).map((x) => x.prompt)
  return {
    quoting: { 観点の検証役: by('unit_verifier'), 読む役: by('file_reader'), 判定役: by('global_judge'), 確認役: by('confirmer') },
    others: { 計画役: by('planner') },
  }
}

test('prompt: quoteProblem で引用を照らす役（観点の検証役・読む役と振り返り・判定役・確認役）に QUOTE_RULE が 1 回ずつ載る', async (t) => {
  const { quoting } = await promptsByRole(t)
  const { QUOTE_RULE } = quoteRuleOf()
  for (const [who, prompts] of Object.entries(quoting)) {
    assert.ok(prompts.length > 0, `${who} が起動していない`)
    for (const p of prompts) assert.equal(p.split(QUOTE_RULE).length - 1, 1, `${who} の prompt に QUOTE_RULE が 1 回載らない`)
  }
})

test('prompt: 本文の引用を照らさない役（目標の照合も担う計画役）には QUOTE_RULE が載らず、CITE_RULE だけが載る', async (t) => {
  const { others } = await promptsByRole(t)
  const { QUOTE_RULE } = quoteRuleOf()
  for (const [who, prompts] of Object.entries(others)) {
    assert.ok(prompts.length > 0, `${who} が起動していない`)
    for (const p of prompts) assert.ok(!p.includes(QUOTE_RULE), `${who} の prompt に QUOTE_RULE が載っている`)
  }
  for (const p of others['計画役']) {
    assert.match(p, /引用元の 1 件の全体/, '計画役には引用元の規則（CITE_RULE）が載る')
    assert.doesNotMatch(p, /見出し[^。]*だけ[^。]*証拠にならない/, '見出しの規則は引用元には当てはまらず、2 つの規則が並ばない')
  }
})

test('prompt: 読む役の結果の形に見出しの規則の写しを置かず、見出しの規則は QUOTE_RULE の 1 か所にする。読む役には query を流させない', async (t) => {
  const { quoting } = await promptsByRole(t)
  const { QUOTE_RULE } = quoteRuleOf()
  const reads = quoting['読む役']
  assert.ok(reads.length > 0)
  for (const p of reads) {
    assert.equal((p.match(/証拠にならない/g) || []).length, (QUOTE_RULE.match(/証拠にならない/g) || []).length, '見出しの規則を述べる文が QUOTE_RULE の外にある')
    assert.match(p, /seen/, '結果の形の seen の指示がある')
    assert.equal(cliArgvOf(p, 'query'), null, 'ファイルの段の役の prompt に query の命令を置かない')
  }
  assert.ok(!AUDIT_SRC.includes('見出しの行だけは証拠にならない'), 'source に括弧書きが残っていない')
})

// ---- 呼び出しごとの消費量を、差で記録する ----
// native は budget.spent()（run 全体の累計）を注入する。source は本体の始めと返す直前に読み、tokens にその差を入れる。
const BASE = 10_000_000
const COST = 100
const DIFF_NOTE = 'この呼び出しの budget.spent() の差'
// 読んでも進まず、担当の起動ごとに COST だけ進む計器。
function metered() {
  const m = { v: BASE, spent: () => m.v }
  m.agent = (fn) => (...a) => { m.v += COST; return fn(...a) }
  return m
}
function ticking(step = 1000) {
  const m = { v: BASE, spent: () => { m.v += step; return m.v } }
  return m
}
function sequence(...vals) {
  let i = 0
  return { spent: () => vals[Math.min(i++, vals.length - 1)] }
}
const auditRun = (budget) => (args, fn) => runScript(args, fn, { budget })

test('tokens: 呼び出しごとの tokens は担当の起動で増えた分の差で、累計を入れず、台帳の calls と tokens_note に同じ差が残る', async (t) => {
  const { state } = project(t, { 'doc.md': DOC })
  const m = metered()
  const consumed = []
  const runWf = async (args, fn) => {
    const before = m.v
    const res = await auditRun(m)(args, m.agent(fn))
    consumed.push(m.v - before)
    return res
  }
  const { stop, steps } = await driveScript(state, scriptAgent(behave()), { runWf })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.equal(consumed.length, steps.length)
  assert.deepEqual(steps.map((s) => s.res.tokens), consumed, 'tokens は呼び出しの中で増えた分')
  assert.ok(consumed.some((c) => c > 0))
  assert.ok(steps.every((s) => s.res.tokens < BASE), '累計（run の始めからの総量）を入れない')
  const L = ledgerOf(state)
  assert.deepEqual(L.calls.map((c) => c.tokens), consumed, '台帳の calls[].tokens も差')
  assert.ok(L.calls.every((c) => c.tokens_note === DIFF_NOTE), `tokens_note は「${DIFF_NOTE}」`)
})

test('tokens: 読むたびに進む計器でも、始めと返す直前の 2 回の読みの差になる', async (t) => {
  const { state } = project(t, { 'doc.md': DOC })
  const { stop, steps } = await driveScript(state, scriptAgent(behave()), { runWf: auditRun(ticking(1000)) })
  assert.equal(stop.stop, 'complete', JSON.stringify(stop))
  assert.ok(steps.length >= 2)
  assert.ok(steps.every((s) => s.res.tokens === 1000), JSON.stringify(steps.map((s) => s.res.tokens)))
  assert.ok(ledgerOf(state).calls.every((c) => c.tokens === 1000 && c.tokens_note === DIFF_NOTE))
})

test('tokens: 束ねの意図を取る全体の段の呼び出しも差で返す', async (t) => {
  const { state } = project(t, { 'doc.md': DOC })
  const { steps } = await driveScript(state, scriptAgent(behave({ ...oneFinding(), ...GROUPING })), { runWf: auditRun(ticking(1000)) })
  assert.ok(steps.some((s) => s.args.stage === 'global' && s.args.workers.some((w) => w.role === 'confirmer')), JSON.stringify(steps.map((s) => s.args.stage)))
  assert.ok(ledgerOf(state).groups.length >= 1, '束ねの群がある')
  assert.ok(steps.every((s) => s.res.tokens === 1000))
  assert.ok(ledgerOf(state).calls.every((c) => c.tokens === 1000 && c.tokens_note === DIFF_NOTE))
})

for (const [name, budget] of [
  ['budget が無い', undefined],
  ['spent が無い', {}],
  ['始めに読めない', sequence(undefined, BASE)],
  ['返す直前に読めない', sequence(BASE, undefined)],
]) {
  test(`tokens: ${name}ときは null で、台帳の tokens_note は読めない経路のまま`, async (t) => {
    const { state } = project(t, { 'doc.md': DOC })
    const { steps } = await driveScript(state, scriptAgent(behave()), { runWf: auditRun(budget), maxSteps: 1 })
    assert.equal(steps.length, 1)
    assert.equal(steps[0].res.tokens, null, '片方でも読めなければ、累計を差として入れず null')
    const c = ledgerOf(state).calls[0]
    assert.equal(c.tokens, null)
    assert.match(c.tokens_note, /読めない/)
  })
}

test('args の検査: 段・workers の形が壊れた args では役を起動せず、返り値は {agents: [], tokens} だけ', async () => {
  const started = []
  const fn = async (p, o) => { started.push(o.label); return { notes: [] } }
  for (const a of [{ state: '/s', callId: 'c', stage: 'review', workers: [] }, { state: '/s', callId: 'c', stage: 'file', workers: [{ id: 'f1' }] }]) {
    const r = await runScript(a, fn)
    assert.deepEqual(Object.keys(r).sort(), ['agents', 'tokens'])
    assert.deepEqual(r.agents, [])
  }
  assert.deepEqual(started, [])
})
