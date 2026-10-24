import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Workflow } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs'
import { readSourceMetadata } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs'
import { main } from '../.agents/skills/repo-review/scripts/review-cli.mjs'
import { VERDICTS, canonical, fnvSum } from '../.agents/skills/repo-review/scripts/review-core.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_DIR = path.join(ROOT, '.agents', 'skills', 'repo-review')
const SOURCE = path.join(SKILL_DIR, 'scripts', 'review.js')
const META = readSourceMetadata(readFileSync(SOURCE, 'utf8'))
const acorn = createRequire(path.join(ROOT, 'plugins', 'workflow', 'skills', 'dynamic-workflow-runner', 'scripts', 'runtime', 'package.json'))('acorn')
const COMMAND = /node '([^']+)' (\S+) <<'(RR_[0-9a-f]{8})'\n(.*)\n\3/g
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
}

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { env: GIT_ENV }).toString('utf8').trim()
}

function write(repo, file, text) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  writeFileSync(path.join(repo, file), text)
}

function fixture(t) {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'repo-review-wf-')))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'commit.gpgsign', 'false')
  write(repo, '.github/workflows/claude_review.yml', `jobs:\n  review:\n    with:\n      exclude-paths: '["**/*.lock"]'\n`)
  write(repo, 'plugins/p/skills/s/scripts/bp/constants.mjs', "export const CRITERIA_DIR = 'references/criteria';\n")
  write(repo, 'docs/a.md', 'a\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  write(repo, 'docs/a.md', 'a2\n')
  write(repo, 'docs/b.md', 'b\n')
  write(repo, 'deps.lock', 'x\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'head')
  return { repo, base, head: git(repo, 'rev-parse', 'HEAD') }
}

const REVIEWERS = [
  { id: 'correctness', focus: 'バグ', files: ['docs/a.md', 'docs/b.md'] },
  { id: 'docs', focus: '文書', files: ['docs/a.md'] },
]

function planFor(request) {
  const out = JSON.parse(main(['plan'], JSON.stringify(request)).output)
  assert.equal(out.ok, true, out.reason)
  return { plan: out.plan, planSum: out.plan_sum }
}

const finding = (patch) => ({ severity: 'MEDIUM', path: 'docs/a.md', line: 1, summary: 's', condition: 'c', impact: 'i', evidence: 'e', rule: 'r', ...patch })
const reviewOk = (head, patch = {}) => ({ head_sha: head, coverage: [], supporting_files: ['REVIEW.md'], findings: [], limitations: [], ...patch })

// 運搬役は prompt のコマンドを本物の CLI でそのまま流す。tamper は応答の行を書き換える（写し間違いの模擬）。
function backend(scenario) {
  const calls = []
  return {
    calls,
    capabilities: ['read-only', 'fresh-thread'],
    async run(prompt, options) {
      calls.push({ prompt, options })
      const { label } = options
      if (label.startsWith('carrier:')) {
        const n = calls.filter((c) => c.options.label.startsWith('carrier:')).length
        if (scenario.carrier) {
          const forced = scenario.carrier(n, prompt)
          if (forced !== undefined) return forced
        }
        const responses = []
        for (const m of prompt.matchAll(COMMAND)) {
          assert.equal(m[1], path.join(SKILL_DIR, 'scripts', 'review-cli.mjs'))
          const { output } = main([m[2]], m[4])
          responses.push(output)
          if (!JSON.parse(output).ok) break
        }
        return { responses }
      }
      if (label.startsWith('review:')) return scenario.review(label.slice('review:'.length), prompt)
      if (label.startsWith('verify:')) return scenario.verify(label.slice('verify:'.length), prompt)
      throw new Error(`unexpected label ${label}`)
    },
  }
}

async function runWorkflow(t, args, b) {
  const runRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'repo-review-run-')))
  t.after(() => rmSync(runRoot, { recursive: true, force: true }))
  return Workflow({ scriptPath: SOURCE, args }, { backend: b, runDir: path.join(runRoot, 'run'), trustedSource: true, ...META.limits })
}

function diffArgs(t) {
  const fx = fixture(t)
  const planned = planFor({ repo: fx.repo, mode: 'diff', baseRef: fx.base, headSha: fx.head, policyRef: fx.base, reviewers: REVIEWERS })
  return { fx, args: { skillDir: SKILL_DIR, ...planned } }
}

test('正常: 観点ごとの reviewer と、重なった指摘を受けた観点の検証役が走り、成り立つ主張だけが確定する', async (t) => {
  const { fx, args } = diffArgs(t)
  const b = backend({
    review: (id) => id === 'correctness'
      ? reviewOk(fx.head, { coverage: ['docs/a.md', 'docs/b.md'], findings: [finding({ line: 1, end_line: 2, summary: 'A' })] })
      : reviewOk(fx.head, { coverage: ['docs/a.md'], findings: [finding({ line: 2, summary: 'B' })] }),
    verify: () => ({ head_sha: fx.head, results: [{ cluster: 0, verdict: 'confirmed', confirmed_members: [1], reason: 'B だけ成り立つ', evidence: [{ path: 'docs/a.md', line: 2, claim: 'x' }] }] }),
  })
  const result = await runWorkflow(t, args, b)
  assert.equal(result.status, 'completed', JSON.stringify(result.reasons))
  assert.equal(result.findings.length, 1)
  assert.deepEqual(result.findings[0].claims.map((c) => [c.summary, c.reported_by]), [['B', 'docs']])
  assert.deepEqual(result.refuted.map((r) => r.claim.summary), ['A'])
  assert.deepEqual(result.excluded, ['deps.lock'])
  assert.deepEqual(result.launches, { reviewers: 2, verifiers: 1, carriers: 2 }, "網羅の照合と統合・判定の集計の運搬役が 1 回ずつ")
  const verifyCalls = b.calls.filter((c) => c.options.label.startsWith('verify:'))
  assert.deepEqual(verifyCalls.map((c) => c.options.label), ['verify:correctness'], '候補は最初に挙げた観点の検証役 1 体に回る')
})

test('全ての agent 呼び出しが model と effort を明示し、運搬役は小さい model・低 effort、共通部分は prompt の先頭にそろう', async (t) => {
  const { fx, args } = diffArgs(t)
  const b = backend({
    review: (id) => reviewOk(fx.head, { coverage: id === 'correctness' ? ['docs/a.md', 'docs/b.md'] : ['docs/a.md'], findings: id === 'docs' ? [finding({ path: 'docs/b.md' })] : [finding()] }),
    verify: (lens, prompt) => {
      const ids = [...prompt.matchAll(/^候補 (\d+):/gm)].map((m) => Number(m[1]))
      return { head_sha: fx.head, results: ids.map((k) => ({ cluster: k, verdict: 'refuted', confirmed_members: [], reason: 'r', evidence: [] })) }
    },
  })
  const result = await runWorkflow(t, args, b)
  assert.equal(result.status, 'completed', JSON.stringify(result.reasons))
  for (const c of b.calls) {
    assert.equal(typeof c.options.model, 'string', c.options.label)
    assert.equal(typeof c.options.effort, 'string', c.options.label)
  }
  for (const c of b.calls.filter((x) => x.options.label.startsWith('carrier:'))) assert.deepEqual([c.options.model, c.options.effort], ['haiku', 'low'])
  const verifiers = b.calls.filter((c) => c.options.label.startsWith('verify:'))
  assert.equal(verifiers.length, 2, '観点ごとに検証役を立てる')
  for (const [role, marker] of [['review:', '--- この reviewer の担当 ---'], ['verify:', '--- この検証役の担当 ---']]) {
    const prefixes = b.calls.filter((c) => c.options.label.startsWith(role)).map((c) => c.prompt.slice(0, c.prompt.indexOf(marker)))
    assert.ok(prefixes[0].length > 0)
    assert.ok(prefixes.every((p) => p === prefixes[0]), `${role} の共通部分が同じ`)
  }
})

test('準正常: reviewer が 1 人返らなくても、他の reviewer の指摘は検証して返し、review_incomplete と明示する', async (t) => {
  const { fx, args } = diffArgs(t)
  const b = backend({
    review: (id) => (id === 'correctness' ? null : reviewOk(fx.head, { coverage: ['docs/a.md'], findings: [finding()] })),
    verify: () => ({ head_sha: fx.head, results: [{ cluster: 0, verdict: 'confirmed', confirmed_members: [0], reason: 'ok', evidence: [{ path: 'docs/a.md', line: 1, claim: 'x' }] }] }),
  })
  const result = await runWorkflow(t, args, b)
  assert.equal(result.status, 'review_incomplete')
  assert.deepEqual(result.reasons, ['coverage_or_limitations'])
  assert.deepEqual(result.missing_coverage, ['docs/b.md'])
  assert.equal(result.findings.length, 1, '検証済みの結果は捨てない')
})

test('準正常: 運搬役の応答の写し間違いは sum で検出し、1 回だけ送り直す', async (t) => {
  const { fx, args } = diffArgs(t)
  const b = backend({
    carrier: (n) => (n === 1 ? { responses: ['{"ok":true,"op":"pin","sum":"00000000"}'] } : undefined),
    review: (id) => reviewOk(fx.head, { coverage: id === 'correctness' ? ['docs/a.md', 'docs/b.md'] : ['docs/a.md'] }),
  })
  const result = await runWorkflow(t, args, b)
  assert.equal(result.status, 'completed')
  assert.equal(result.launches.carriers, 2)
})

test('異常: 運搬役が上限まで失敗したら、候補を未検証として返し review_incomplete で止まる', async (t) => {
  const { fx, args } = diffArgs(t)
  const b = backend({
    carrier: () => null,
    review: (id) => reviewOk(fx.head, { coverage: id === 'correctness' ? ['docs/a.md', 'docs/b.md'] : ['docs/a.md'], findings: [finding()] }),
  })
  const result = await runWorkflow(t, args, b)
  assert.equal(result.status, 'review_incomplete')
  assert.deepEqual(result.reasons, ['carrier_failed'])
  assert.equal(result.unverified_candidates.length, 2)
  assert.equal(result.launches.carriers, META.caps.carrierTries)
  assert.equal(b.calls.filter((c) => c.options.label.startsWith('verify:')).length, 0)
})

test('異常: レビュー中に対象の内容が変わったら検証に回さず pin_changed で止まる', async (t) => {
  const fx = fixture(t)
  write(fx.repo, 'docs/a.md', 'working\n')
  const planned = planFor({ repo: fx.repo, mode: 'working_tree', baseRef: fx.head, headSha: fx.head, policyRef: fx.head, reviewers: [
    { id: 'correctness', focus: 'バグ', files: ['docs/a.md'] }, { id: 'docs', focus: '文書', files: ['docs/a.md'] },
  ] })
  const b = backend({
    review: (id) => {
      if (id === 'docs') write(fx.repo, 'docs/a.md', 'edited during review\n')
      return reviewOk(fx.head, { coverage: ['docs/a.md'], findings: [finding()] })
    },
    verify: () => assert.fail('pin が崩れた後に検証役を起動しない'),
  })
  const result = await runWorkflow(t, { skillDir: SKILL_DIR, ...planned }, b)
  assert.equal(result.status, 'review_incomplete')
  assert.deepEqual(result.reasons, ['pin_changed'])
  assert.deepEqual(result.pin.changed, ['docs/a.md'])
})

test('境界: 指摘が 0 件なら検証役も 2 回目の運搬役も起動しない', async (t) => {
  const { fx, args } = diffArgs(t)
  const b = backend({ review: (id) => reviewOk(fx.head, { coverage: id === 'correctness' ? ['docs/a.md', 'docs/b.md'] : ['docs/a.md'] }) })
  const result = await runWorkflow(t, args, b)
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.findings, [])
  assert.deepEqual(result.launches, { reviewers: 2, verifiers: 0, carriers: 1 })
})

test('異常: plan と planSum が合わない args は agent を起動する前に拒否する', async (t) => {
  const { args } = diffArgs(t)
  const b = backend({ review: () => assert.fail('起動しない') })
  for (const bad of [{ ...args, planSum: '00000000' }, { ...args, plan: { ...args.plan, headSha: 'e'.repeat(40) } }, { ...args, skillDir: 'relative' }]) {
    await assert.rejects(runWorkflow(t, bad, b))
  }
  assert.equal(b.calls.length, 0)
})

function declarations(source, prefix = 'async function __s() {\n') {
  const body = source.replace(/^export const meta =/, 'const meta =').replace(/^export /gm, '')
  const ast = acorn.parse(`${prefix}${body}\n}`, { ecmaVersion: 'latest', sourceType: 'module' })
  const out = new Map()
  for (const n of ast.body[0].body.body) {
    const name = n.type === 'VariableDeclaration' ? n.declarations[0].id.name : n.id?.name
    if (name) out.set(name, `${prefix}${body}`.slice(n.start, n.end))
  }
  return out
}

test('Workflow source の canonical・fnvSum は CLI の部品と字面が同じ（import できない source の写し）', () => {
  const source = declarations(readFileSync(SOURCE, 'utf8'))
  assert.equal(source.get('canonical'), canonical.toString())
  assert.equal(source.get('fnvSum'), fnvSum.toString())
})

test('Workflow source の重大度の名前は REVIEW.md「重大度」の表と一致する', () => {
  const review = readFileSync(path.join(ROOT, 'REVIEW.md'), 'utf8')
  const section = review.split(/^## /m).find((s) => s.startsWith('重大度'))
  const names = [...section.matchAll(/^\| ([A-Z]+) \|/gm)].map((m) => m[1])
  assert.ok(names.length > 0)
  const literal = /const SEVERITIES = (\[[^\]]*\])/.exec(readFileSync(SOURCE, 'utf8'))[1]
  assert.deepEqual(JSON.parse(literal.replace(/'/g, '"')), names)
})

test('Workflow source の判定の名前は review-core.mjs の VERDICTS と一致する', () => {
  const literal = /const VERDICTS = (\[[^\]]*\])/.exec(readFileSync(SOURCE, 'utf8'))[1]
  assert.deepEqual(JSON.parse(literal.replace(/'/g, '"')), [...VERDICTS])
})
