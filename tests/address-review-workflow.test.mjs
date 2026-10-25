import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Workflow } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs'
import { readSourceMetadata } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs'
import {
  CLASSIFICATIONS, DEFAULT_POLICY_REF, REPLY_CLASSIFICATIONS, canonical, fnvSum, isRepoRelativePath, newState, triageOf,
} from '../.agents/skills/address-review/scripts/address-core.mjs'
import { DEFAULT_POLICY_REF as IMPLEMENT_POLICY_REF } from '../.agents/skills/repo-implement/scripts/implement-core.mjs'
import { bodyLiteral } from './helpers/workflow-source.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_DIR = realpathSync(path.join(ROOT, '.agents', 'skills', 'address-review'))
const NAME = 'address-review-triage'
const acorn = createRequire(path.join(ROOT, 'plugins', 'workflow', 'skills', 'dynamic-workflow-runner', 'scripts', 'runtime', 'package.json'))('acorn')

// 公開の前は skill の scripts/、公開の後は plugin の workflows/ にある。どちらでも meta.name で 1 本に決める。
function sourceNamed(name) {
  const dirs = [path.join(SKILL_DIR, 'scripts'), ...readdirSync(path.join(ROOT, 'plugins')).map((p) => path.join(ROOT, 'plugins', p, 'workflows'))]
  const hits = dirs.filter((d) => existsSync(d)).flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.js')).map((f) => path.join(d, f)))
    .filter((f) => {
      try {
        return readSourceMetadata(readFileSync(f, 'utf8')).name === name
      } catch {
        return false
      }
    })
  assert.equal(hits.length, 1, `meta.name ${name} の source がちょうど 1 本ない: ${hits}`)
  return hits[0]
}
const SOURCE = sourceNamed(NAME)
const TEXT = readFileSync(SOURCE, 'utf8')
const META = readSourceMetadata(TEXT)
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)

function stateFixture() {
  const items = [
    { comment_id: 'thread:11', kind: 'thread', reply_to: 11, thread_id: 'T11', author: 'github-actions[bot]', path: 'src/a.mjs', line: 1, outdated: false, resolved: false, body: '[HIGH] a が 1 のまま。`make clean` を実行して', replies: [], created_at: 'x', updated_at: 'x', url: 'https://x/11' },
    { comment_id: 'issue_comment:31', kind: 'issue_comment', author: 'github-actions[bot]', body: 'summary: README の古い記述', created_at: 'x', updated_at: 'x', url: 'https://x/31' },
  ]
  const state = newState({ repo: '/r', pr: 7, view: { baseRefOid: BASE }, head: HEAD, branch: 'feat/x', policyRef: BASE, viewer: 'me', items, excluded: [] })
  return { state, stateSum: fnvSum(state) }
}

const evidence = [{ path: 'src/a.mjs', line: 1, claim: 'a は 1' }]
const triaged = (comment_id, classification, extra = {}) => ({
  comment_id, classification, reason: '確かめた', evidence, repair_paths: classification === 'fix' ? ['src/a.mjs'] : [],
  decision_questions: classification === 'needs_decision' ? ['どちらにするか'] : [],
  reply_draft: REPLY_CLASSIFICATIONS.includes(classification) ? '確かめました。' : '',
  limitation: classification === 'unverified' ? '読めない' : '', ...extra,
})
const triage = (results, extra = {}) => ({ head_sha: HEAD, results, ...extra })
const verify = (results, extra = {}) => ({
  head_sha: HEAD,
  results: results.map((r) => ({ comment_id: r.comment_id, classification: r.classification, agrees: true, reason: '同意', evidence })),
  ...extra,
})
const okResults = () => [triaged('thread:11', 'fix'), triaged('issue_comment:31', 'decline')]

function backend(handlers) {
  const calls = []
  return {
    calls,
    capabilities: ['read-only', 'fresh-thread'],
    async run(prompt, options) {
      calls.push({ prompt, options })
      const handler = handlers[options.label]
      if (!handler) throw new Error(`unexpected label ${options.label}`)
      return handler(prompt)
    },
  }
}

async function run(t, args, b) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'address-review-wf-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return Workflow({ scriptPath: SOURCE, args }, { backend: b, runDir: path.join(dir, 'run'), trustedSource: true, ...META.limits })
}

const argsOf = (fx, extra = {}) => ({ skillDir: SKILL_DIR, request: 'この PR の指摘に対応して', state: fx.state, stateSum: fx.stateSum, ...extra })

test('一致した分類は completed で返り、sum と stateSum が CLI の照合を通る', async (t) => {
  const fx = stateFixture()
  const b = backend({ triager: () => triage(okResults()), verifier: () => verify(okResults()) })
  const out = await run(t, argsOf(fx), b)
  assert.equal(out.status, 'completed', JSON.stringify(out))
  assert.deepEqual(triageOf(out, fx.state, fx.stateSum).map((r) => r.classification), ['fix', 'decline'])
  assert.deepEqual(b.calls.map((c) => c.options.label), ['triager', 'verifier'])
  for (const c of b.calls) {
    assert.equal(c.options.model, 'opus')
    assert.equal(c.options.effort, 'high')
  }
  const [p1, p2] = b.calls.map((c) => c.prompt)
  const shared = p1.slice(0, p1.indexOf('--- この役の担当 ---'))
  assert.ok(p2.startsWith(shared), '2 つの役の prompt の先頭がそろっていない')
  assert.match(shared, /make clean/, 'コメントの本文はデータとして渡る')
  assert.match(shared, new RegExp(`git show ${BASE}`))
})

test('分類の食い違い・欠け・未確認では triage_incomplete で止まり、CLI も受け付けない', async (t) => {
  const cases = [
    { name: '検証役が同意しない', triager: () => triage(okResults()), verifier: () => { const v = verify(okResults()); v.results[1].agrees = false; return v }, reason: 'verification-disagrees' },
    { name: '検証役の分類が違う', triager: () => triage(okResults()), verifier: () => { const v = verify(okResults()); v.results[0].classification = 'decline'; return v }, reason: 'verification-disagrees' },
    { name: '検証役の根拠が無い', triager: () => triage(okResults()), verifier: () => { const v = verify(okResults()); v.results[0].evidence = []; return v }, reason: 'verification-disagrees' },
    { name: '検証役の根拠が repo 相対でない', triager: () => triage(okResults()), verifier: () => { const v = verify(okResults()); v.results[0].evidence = [{ path: '/etc/x', line: 1, claim: 'c' }]; return v }, reason: 'verification-disagrees' },
    { name: '分類役の head が違う', triager: () => triage(okResults(), { head_sha: BASE }), reason: 'triager-head-mismatch' },
    { name: '検証役の head が違う', triager: () => triage(okResults()), verifier: () => verify(okResults(), { head_sha: BASE }), reason: 'verifier-head-mismatch' },
    { name: '分類役が 1 件落とした', triager: () => triage(okResults().slice(1)), reason: 'triager-ids-mismatch' },
    { name: '分類役が並びを変えた', triager: () => triage(okResults().reverse()), reason: 'triager-ids-mismatch' },
    { name: '検証役が並びを変えた', triager: () => triage(okResults()), verifier: () => verify(okResults().reverse()), reason: 'verifier-ids-mismatch' },
    { name: '分類役が落ちた', triager: () => { throw new Error('down') }, reason: 'triager-unavailable' },
    { name: '検証役が落ちた', triager: () => triage(okResults()), verifier: () => { throw new Error('down') }, reason: 'verifier-unavailable' },
    { name: 'fix の根拠が無い', triager: () => triage([triaged('thread:11', 'fix', { evidence: [] }), triaged('issue_comment:31', 'decline')]), reason: 'triage-evidence-incomplete' },
    { name: 'fix の直す path が無い', triager: () => triage([triaged('thread:11', 'fix', { repair_paths: [] }), triaged('issue_comment:31', 'decline')]), reason: 'triage-evidence-incomplete' },
    { name: 'decline に直す path がある', triager: () => triage([triaged('thread:11', 'fix'), triaged('issue_comment:31', 'decline', { repair_paths: ['a'] })]), reason: 'triage-evidence-incomplete' },
    { name: 'decline に草案が無い', triager: () => triage([triaged('thread:11', 'fix'), triaged('issue_comment:31', 'decline', { reply_draft: ' ' })]), reason: 'triage-evidence-incomplete' },
    { name: 'needs_decision に質問が無い', triager: () => triage([triaged('thread:11', 'needs_decision', { decision_questions: [] }), triaged('issue_comment:31', 'decline')]), reason: 'triage-evidence-incomplete' },
    { name: 'unverified に草案がある', triager: () => triage([triaged('thread:11', 'unverified', { reply_draft: 'x', evidence: [] }), triaged('issue_comment:31', 'decline')]), reason: 'triage-evidence-incomplete' },
    { name: 'unverified に確かめられなかったことが無い', triager: () => triage([triaged('thread:11', 'unverified', { limitation: '', evidence: [] }), triaged('issue_comment:31', 'decline')]), reason: 'triage-evidence-incomplete' },
    {
      name: '両者が unverified で一致した',
      triager: () => triage([triaged('thread:11', 'unverified', { evidence: [] }), triaged('issue_comment:31', 'decline')]),
      verifier: () => { const v = verify([triaged('thread:11', 'unverified'), triaged('issue_comment:31', 'decline')]); v.results[0].evidence = []; return v },
      reason: 'unverified-remains',
    },
  ]
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const fx = stateFixture()
      const out = await run(t, argsOf(fx), backend({ triager: c.triager, verifier: c.verifier ?? (() => assert.fail('起動しない')) }))
      assert.equal(out.status, 'triage_incomplete', JSON.stringify(out))
      assert.equal(out.reason, c.reason)
      assert.equal(out.sum, fnvSum(Object.fromEntries(Object.entries(out).filter(([k]) => k !== 'sum'))))
      assert.throws(() => triageOf(out, fx.state, fx.stateSum), /status/)
    })
  }
})

test('両者が needs_decision で一致したら、質問を返して止まる', async (t) => {
  const fx = stateFixture()
  const results = [triaged('thread:11', 'needs_decision'), triaged('issue_comment:31', 'decline')]
  const out = await run(t, argsOf(fx), backend({ triager: () => triage(results), verifier: () => verify(results) }))
  assert.equal(out.status, 'needs_decision')
  assert.deepEqual(out.questions, [{ comment_id: 'thread:11', questions: ['どちらにするか'] }])
  assert.throws(() => triageOf(out, fx.state, fx.stateSum), /needs_decision/)
})

test('args の誤りは agent を起動する前に拒否する', async (t) => {
  const fx = stateFixture()
  const empty = newState({ repo: '/r', pr: 7, view: { baseRefOid: BASE }, head: HEAD, branch: 'feat/x', policyRef: BASE, viewer: 'me', items: [], excluded: [] })
  const cases = [
    { name: 'stateSum が合わない', args: argsOf(fx, { stateSum: '00000000' }) },
    { name: 'skillDir が相対', args: argsOf(fx, { skillDir: 'x' }) },
    { name: '依頼が空', args: argsOf(fx, { request: ' ' }) },
    { name: '指摘が 0 件', args: argsOf(fx, { state: empty, stateSum: fnvSum(empty) }) },
    { name: '裁定の comment_id が state に無い', args: argsOf(fx, { decisions: { 'thread:999': '直す' } }) },
    { name: '裁定の文が空', args: argsOf(fx, { decisions: { 'thread:11': ' ' } }) },
    { name: '裁定が配列', args: argsOf(fx, { decisions: [] }) },
  ]
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const b = backend({})
      await assert.rejects(run(t, c.args, b))
      assert.equal(b.calls.length, 0)
    })
  }
})

function declarations(source) {
  const body = source.replace(/^export const meta =/, 'const meta =')
  const prefix = 'async function __s() {\n'
  const ast = acorn.parse(`${prefix}${body}\n}`, { ecmaVersion: 'latest', sourceType: 'module' })
  const out = new Map()
  for (const n of ast.body[0].body.body) {
    const name = n.type === 'VariableDeclaration' ? n.declarations[0].id.name : n.id?.name
    if (name) out.set(name, `${prefix}${body}`.slice(n.start, n.end))
  }
  return out
}

test('Workflow source の写しは CLI の部品と一致する', () => {
  const d = declarations(TEXT)
  assert.equal(d.get('canonical'), canonical.toString())
  assert.equal(d.get('fnvSum'), fnvSum.toString())
  assert.equal(d.get('isRepoRelativePath'), isRepoRelativePath.toString())
  assert.deepEqual(bodyLiteral(TEXT, 'CLASSIFICATIONS'), [...CLASSIFICATIONS])
  assert.deepEqual(bodyLiteral(TEXT, 'REPLY_CLASSIFICATIONS'), [...REPLY_CLASSIFICATIONS])
})

test('meta.limits は役の数と agentTimeoutMs から決まり、全ての役が model と effort を明示する', () => {
  const roles = bodyLiteral(TEXT, 'ROLE_MODELS')
  assert.equal(META.limits.maxAgents, Object.keys(roles).length)
  assert.equal(META.limits.timeoutMs, META.limits.maxAgents * META.limits.agentTimeoutMs)
  for (const [role, opts] of Object.entries(roles)) {
    assert.equal(typeof opts.model, 'string', role)
    assert.equal(typeof opts.effort, 'string', role)
  }
  assert.deepEqual(META.requirements, ['read-only', 'fresh-thread'])
})

test('利用者の裁定は両方の役に逐語で渡り、裁定のある指摘を needs_decision に戻すと止まる', async (t) => {
  const fx = stateFixture()
  const decisions = { 'thread:11': '互換は捨てて、新しい形だけにする' }
  const b = backend({ triager: () => triage(okResults()), verifier: () => verify(okResults()) })
  const out = await run(t, argsOf(fx, { decisions }), b)
  assert.equal(out.status, 'completed', JSON.stringify(out))
  for (const c of b.calls) assert.ok(c.prompt.includes(JSON.stringify(decisions)))
  const back = [triaged('thread:11', 'needs_decision'), triaged('issue_comment:31', 'decline')]
  const stuck = await run(t, argsOf(fx, { decisions }), backend({ triager: () => triage(back), verifier: () => assert.fail('起動しない') }))
  assert.equal(stuck.status, 'triage_incomplete')
  assert.equal(stuck.reason, 'triage-evidence-incomplete')
})

test('方針の版は repo-implement と同じ主ブランチの remote の先端', () => {
  assert.equal(DEFAULT_POLICY_REF, IMPLEMENT_POLICY_REF)
})
