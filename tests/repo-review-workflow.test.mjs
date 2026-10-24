import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Workflow } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs'
import { readSourceMetadata } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs'
import { main } from '../.agents/skills/repo-review/scripts/review-cli.mjs'
import { VERDICTS, VERIFY_ROUNDS, canonical, fnvSum, isWorkflowSource } from '../.agents/skills/repo-review/scripts/review-core.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_DIR = realpathSync(path.join(ROOT, '.agents', 'skills', 'repo-review'))
const META_NAME = 'repo-review-run'

// 公開の前は skill の scripts/、公開の後は plugin の workflows/ にある。どちらでも meta.name で 1 本に決める。
function workflowSource() {
  const dirs = [path.join(SKILL_DIR, 'scripts'), ...readdirSync(path.join(ROOT, 'plugins')).map((p) => path.join(ROOT, 'plugins', p, 'workflows'))]
  const hits = dirs.filter((d) => existsSync(d)).flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.js')).map((f) => path.join(d, f)))
    .filter((f) => isWorkflowSource(readFileSync(f, 'utf8')) && readSourceMetadata(readFileSync(f, 'utf8')).name === META_NAME)
  assert.equal(hits.length, 1, `meta.name ${META_NAME} の source がちょうど 1 本ない: ${hits}`)
  return hits[0]
}
const SOURCE = workflowSource()
const SOURCE_TEXT = readFileSync(SOURCE, 'utf8')
const META = readSourceMetadata(SOURCE_TEXT)
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

function tmp(t, prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function fixture(t) {
  const repo = tmp(t, 'repo-review-wf-')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'commit.gpgsign', 'false')
  write(repo, '.github/workflows/claude_review.yml', `jobs:\n  review:\n    with:\n      exclude-paths: '["**/*.lock"]'\n`)
  write(repo, 'docs/a.md', 'a\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  write(repo, 'docs/a.md', 'a2\n')
  write(repo, 'docs/b.md', 'b\n')
  write(repo, 'deps.lock', 'x\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'head')
  return { repo, base, head: git(repo, 'rev-parse', 'HEAD'), stateDir: tmp(t, 'repo-review-state-') }
}

const REVIEWERS = [
  { id: 'correctness', focus: 'バグ', files: ['docs/a.md', 'docs/b.md'] },
  { id: 'docs', focus: '文書', files: ['docs/a.md'] },
]

function planArgs(request, skillDir = SKILL_DIR) {
  const out = JSON.parse(main(['plan'], JSON.stringify(request)).output)
  assert.equal(out.ok, true, out.reason)
  return { skillDir, plan: out.plan, planSum: out.plan_sum, planPath: out.plan_path }
}

function diffArgs(t, skillDir) {
  const fx = fixture(t)
  return { fx, args: planArgs({ repo: fx.repo, mode: 'diff', baseRef: fx.base, headSha: fx.head, policyRef: fx.base, reviewers: REVIEWERS, stateDir: fx.stateDir }, skillDir) }
}

const finding = (patch) => ({ severity: 'MEDIUM', path: 'docs/a.md', line: 1, summary: 's', condition: 'c', impact: 'i', evidence: 'e', rule: 'r', ...patch })
const reviewOk = (head, id, patch = {}) => ({ head_sha: head, coverage: id === 'correctness' ? ['docs/a.md', 'docs/b.md'] : ['docs/a.md'], supporting_files: ['REVIEW.md'], findings: [], limitations: [], ...patch })

// prompt に並ぶ割り当て（候補 k の claims）を読み、主張ごとに decide(lens, round, summary) の判定で返す。
function verifyAll(head, decide) {
  return (lens, round, prompt) => {
    const results = []
    for (const m of prompt.matchAll(/^候補 (\d+): [^\n]*\nclaims: (.*)$/gm)) {
      for (const c of JSON.parse(m[2])) {
        const verdict = decide(lens, round, c.summary)
        results.push({ cluster: Number(m[1]), claim: c.claim, verdict, reason: `${lens}:${verdict}`, evidence: verdict === 'confirmed' ? [{ path: c.path, line: c.line, claim: 'x' }] : [] })
      }
    }
    return { head_sha: head, results }
  }
}

function runCommands(prompt, exec) {
  const responses = []
  for (const m of prompt.matchAll(COMMAND)) {
    const output = exec(m)
    responses.push(output)
    if (!JSON.parse(output).ok) break
  }
  return responses
}

const inProcess = (m) => main([m[2]], m[4]).output

// 運搬役は prompt のコマンドを本物の CLI でそのまま流す。scenario.carrier は n 回目の運搬の応答を差し替える。
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
        const responses = runCommands(prompt, scenario.exec ?? inProcess)
        const forced = scenario.carrier?.(n, responses)
        return forced === undefined ? { responses } : forced
      }
      if (label.startsWith('review:')) return scenario.review(label.slice('review:'.length), prompt)
      const m = /^verify(\d):(.+)$/.exec(label)
      if (m) return scenario.verify(m[2], Number(m[1]), prompt)
      throw new Error(`unexpected label ${label}`)
    },
  }
}

async function runWorkflow(t, args, b) {
  const runRoot = tmp(t, 'repo-review-run-')
  return Workflow({ scriptPath: SOURCE, args }, { backend: b, runDir: path.join(runRoot, 'run'), trustedSource: true, ...META.limits })
}

const labels = (b, prefix) => b.calls.filter((c) => c.options.label.startsWith(prefix)).map((c) => c.options.label)

test('正常: 1 段目で確定しなかった主張だけが残りの観点に回り、全観点が棄却した主張は refuted になる', async (t) => {
  const { fx, args } = diffArgs(t)
  const b = backend({
    review: (id) => (id === 'correctness'
      ? reviewOk(fx.head, id, { findings: [finding({ line: 1, end_line: 2, summary: 'A' })] })
      : reviewOk(fx.head, id, { findings: [finding({ line: 2, summary: 'B' })] })),
    verify: verifyAll(fx.head, (lens, round, summary) => (summary === 'B' ? 'confirmed' : 'refuted')),
  })
  const result = await runWorkflow(t, args, b)
  assert.equal(result.status, 'completed', JSON.stringify(result.reasons))
  assert.deepEqual(result.findings.map((f) => [f.claim.summary, f.claim.reported_by, f.votes.length]), [['B', 'docs', 1]])
  assert.deepEqual(result.refuted.map((r) => [r.claim.summary, r.votes.map((v) => [v.round, v.lens, v.vote])]), [['A', [[1, 'correctness', 'refuted'], [2, 'docs', 'refuted']]]])
  assert.deepEqual(result.excluded, ['deps.lock'])
  assert.deepEqual(labels(b, 'verify'), ['verify1:correctness', 'verify2:docs'], '候補は最初に挙げた観点に、決着しない主張だけが残りの観点に回る')
  assert.deepEqual(result.launches, { reviewers: 2, verifiers: [1, 1], carriers: 3 })
})

test('準正常: 2 観点のとき 1 票の refuted だけでは棄却せず unverified にし、review_incomplete と明示する', async (t) => {
  const { fx, args } = diffArgs(t)
  const b = backend({
    review: (id) => reviewOk(fx.head, id, { findings: id === 'correctness' ? [finding()] : [] }),
    verify: verifyAll(fx.head, (lens) => (lens === 'correctness' ? 'refuted' : 'unverified')),
  })
  const result = await runWorkflow(t, args, b)
  assert.equal(result.status, 'review_incomplete')
  assert.deepEqual(result.reasons, ['verification_incomplete'])
  assert.equal(result.unverified.length, 1)
  assert.deepEqual(result.findings, [])
})

test('境界: 2 観点で 1 段目の票が refuted でない主張には 2 段目の検証役を起動しない', async (t) => {
  const { fx, args } = diffArgs(t)
  const b = backend({
    review: (id) => reviewOk(fx.head, id, { findings: id === 'correctness' ? [finding()] : [] }),
    verify: verifyAll(fx.head, () => 'unverified'),
  })
  const result = await runWorkflow(t, args, b)
  assert.deepEqual(labels(b, 'verify'), ['verify1:correctness'])
  assert.deepEqual(result.reasons, ['verification_incomplete'])
  assert.equal(result.unverified.length, 1)
  assert.deepEqual(result.launches, { reviewers: 2, verifiers: [1, 0], carriers: 2 })
})

test('異常: diff で作業ツリーがレビュー中に head と違う内容になったら pin_changed で止まる', async (t) => {
  const { fx, args } = diffArgs(t)
  const b = backend({
    review: (id) => {
      if (id === 'docs') write(fx.repo, 'docs/a.md', 'edited in the working tree\n')
      return reviewOk(fx.head, id, { findings: [finding()] })
    },
    verify: () => assert.fail('pin が崩れた後に検証役を起動しない'),
  })
  const result = await runWorkflow(t, args, b)
  assert.deepEqual(result.reasons, ['pin_changed'])
  assert.match(result.pin.problems.join('\n'), /作業ツリー/)
})

test('全ての agent 呼び出しが model と effort を明示し、運搬役は小さい model・低 effort、共通部分は prompt の先頭にそろう', async (t) => {
  const { fx, args } = diffArgs(t)
  const b = backend({
    review: (id) => reviewOk(fx.head, id, { findings: id === 'docs' ? [finding({ path: 'docs/b.md' })] : [finding()] }),
    verify: verifyAll(fx.head, () => 'confirmed'),
  })
  const result = await runWorkflow(t, args, b)
  assert.equal(result.status, 'completed', JSON.stringify(result.reasons))
  for (const c of b.calls) {
    assert.equal(typeof c.options.model, 'string', c.options.label)
    assert.equal(typeof c.options.effort, 'string', c.options.label)
  }
  for (const c of b.calls.filter((x) => x.options.label.startsWith('carrier:'))) assert.deepEqual([c.options.model, c.options.effort], ['haiku', 'low'])
  assert.equal(labels(b, 'verify1:').length, 2, '観点ごとに検証役を立てる')
  for (const [role, marker] of [['review:', '--- この reviewer の担当 ---'], ['verify1:', '--- この検証役の担当 ---']]) {
    const prefixes = b.calls.filter((c) => c.options.label.startsWith(role)).map((c) => c.prompt.slice(0, c.prompt.indexOf(marker)))
    assert.ok(prefixes[0].length > 0)
    assert.ok(prefixes.every((p) => p === prefixes[0]), `${role} の共通部分が同じ`)
  }
  for (const c of b.calls.filter((x) => x.options.label.startsWith('carrier:'))) {
    assert.ok(!c.prompt.includes('"target"'), '運搬役は計画の本体を写さない')
  }
})

test('準正常: reviewer が 1 人返らなくても、他の reviewer の指摘は検証して返し、review_incomplete と明示する', async (t) => {
  const { fx, args } = diffArgs(t)
  const b = backend({
    review: (id) => (id === 'correctness' ? null : reviewOk(fx.head, id, { findings: [finding()] })),
    verify: verifyAll(fx.head, () => 'confirmed'),
  })
  const result = await runWorkflow(t, args, b)
  assert.equal(result.status, 'review_incomplete')
  assert.deepEqual(result.reasons, ['coverage_or_limitations'])
  assert.deepEqual(result.missing_coverage, ['docs/b.md'])
  assert.equal(result.findings.length, 1, '検証済みの結果は捨てない')
})

test('準正常: 運搬役が応答を書き換えたら sum で検出して送り直し、書き換えた値を使わない', async (t) => {
  const { fx, args } = diffArgs(t)
  const b = backend({
    carrier: (n, responses) => {
      if (n !== 1) return undefined
      const merged = JSON.parse(responses[1])
      merged.merge.clusters = []
      merged.merge.first = []
      return { responses: [responses[0], JSON.stringify(merged)] }
    },
    review: (id) => reviewOk(fx.head, id, { findings: id === 'correctness' ? [finding()] : [] }),
    verify: verifyAll(fx.head, () => 'confirmed'),
  })
  const result = await runWorkflow(t, args, b)
  assert.equal(result.status, 'completed')
  assert.equal(result.findings.length, 1)
  assert.equal(result.launches.carriers, 3, '写し間違いの 1 回・送り直し・一次の判定')
})

test('異常: 運搬役が上限まで応答を失ったら、候補を未検証として返し carrier_failed で止まる', async (t) => {
  const { fx, args } = diffArgs(t)
  const b = backend({ carrier: () => null, review: (id) => reviewOk(fx.head, id, { findings: [finding()] }) })
  const result = await runWorkflow(t, args, b)
  assert.equal(result.status, 'review_incomplete')
  assert.deepEqual(result.reasons, ['carrier_failed'])
  assert.equal(result.unverified_candidates.length, 2)
  assert.deepEqual(result.findings, [])
  assert.equal(result.launches.carriers, literalOf('CARRIER_TRIES'))
  assert.equal(labels(b, 'verify').length, 0)
})

test('異常: CLI が判定として拒否したら送り直さず cli_rejected で止まる', async (t) => {
  const { fx, args } = diffArgs(t)
  const b = backend({
    review: (id) => {
      rmSync(args.planPath, { force: true })
      return reviewOk(fx.head, id, { findings: [finding()] })
    },
  })
  const result = await runWorkflow(t, args, b)
  assert.deepEqual(result.reasons, ['cli_rejected'])
  assert.match(result.reason, /E_INPUT/)
  assert.equal(result.launches.carriers, 1)
})

function workingTreeArgs(t) {
  const fx = fixture(t)
  write(fx.repo, 'docs/a.md', 'working\n')
  const args = planArgs({ repo: fx.repo, mode: 'working_tree', baseRef: fx.head, headSha: fx.head, policyRef: fx.head, stateDir: fx.stateDir, reviewers: [
    { id: 'correctness', focus: 'バグ', files: ['docs/a.md'] }, { id: 'docs', focus: '文書', files: ['docs/a.md'] },
  ] })
  return { fx, args }
}

test('異常: レビュー中に対象の内容が変わったら検証に回さず pin_changed で止まる', async (t) => {
  const { fx, args } = workingTreeArgs(t)
  const b = backend({
    review: (id) => {
      if (id === 'docs') write(fx.repo, 'docs/a.md', 'edited during review\n')
      return { ...reviewOk(fx.head, id, { findings: [finding()] }), coverage: ['docs/a.md'] }
    },
    verify: () => assert.fail('pin が崩れた後に検証役を起動しない'),
  })
  const result = await runWorkflow(t, args, b)
  assert.deepEqual(result.reasons, ['pin_changed'])
  assert.deepEqual(result.pin.changed, ['docs/a.md'])
})

test('異常: 検証の段の間に対象の内容が変わったら、検証を通った指摘も確定として返さない', async (t) => {
  const { fx, args } = workingTreeArgs(t)
  const b = backend({
    review: (id) => ({ ...reviewOk(fx.head, id, { findings: [finding()] }), coverage: ['docs/a.md'] }),
    verify: (lens, round, prompt) => {
      write(fx.repo, 'docs/a.md', 'edited during verification\n')
      return verifyAll(fx.head, () => 'confirmed')(lens, round, prompt)
    },
  })
  const result = await runWorkflow(t, args, b)
  assert.equal(result.status, 'review_incomplete')
  assert.deepEqual(result.reasons, ['pin_changed'])
  assert.deepEqual(result.findings, [])
  assert.equal(result.unverified_candidates.length, 2)
})

test('異常: 2 段目の検証の間に対象の内容が変わったら、最終の判定でも pin_changed で止まる', async (t) => {
  const { fx, args } = workingTreeArgs(t)
  const b = backend({
    review: (id) => ({ ...reviewOk(fx.head, id, { findings: id === 'correctness' ? [finding()] : [] }), coverage: ['docs/a.md'] }),
    verify: (lens, round, prompt) => {
      if (round === 2) write(fx.repo, 'docs/a.md', 'edited during the second round\n')
      return verifyAll(fx.head, () => 'refuted')(lens, round, prompt)
    },
  })
  const result = await runWorkflow(t, args, b)
  assert.deepEqual(labels(b, 'verify'), ['verify1:correctness', 'verify2:docs'])
  assert.deepEqual(result.reasons, ['pin_changed'])
  assert.deepEqual(result.findings, [])
  assert.equal(result.step, undefined)
})

test('境界: 指摘が 0 件なら検証役も 2 回目以降の運搬役も起動しない', async (t) => {
  const { fx, args } = diffArgs(t)
  const b = backend({ review: (id) => reviewOk(fx.head, id) })
  const result = await runWorkflow(t, args, b)
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.findings, [])
  assert.deepEqual(result.launches, { reviewers: 2, verifiers: [0, 0], carriers: 1 })
})

test('異常: plan・planSum・planPath・skillDir が不正な args は agent を起動する前に拒否する', async (t) => {
  const { args } = diffArgs(t)
  const b = backend({ review: () => assert.fail('起動しない') })
  for (const bad of [
    { ...args, planSum: '00000000' },
    { ...args, plan: { ...args.plan, headSha: 'e'.repeat(40) } },
    { ...args, skillDir: 'relative' },
    { ...args, planPath: undefined },
  ]) await assert.rejects(runWorkflow(t, bad, b))
  assert.equal(b.calls.length, 0)
})

test('運搬役のコマンドは、空白を含む skillDir でも本物の bash でそのまま動く', async (t) => {
  const copy = path.join(tmp(t, 'repo review skill '), 'repo-review')
  cpSync(SKILL_DIR, copy, { recursive: true })
  // 単一引用符・$・backtick を含むパスを運搬役の heredoc に通す（区切りの引用が外れると shell が展開して sum が合わなくなる）。
  const odd = "docs/$HOME`id`'q'.md"
  const fx = fixture(t)
  write(fx.repo, odd, 'odd\n')
  git(fx.repo, 'add', '-A')
  git(fx.repo, 'commit', '-q', '-m', 'odd')
  const head = git(fx.repo, 'rev-parse', 'HEAD')
  const reviewers = [{ id: 'correctness', focus: 'バグ', files: ['docs/a.md', 'docs/b.md', odd] }, { id: 'docs', focus: '文書', files: ['docs/a.md'] }]
  const args = planArgs({ repo: fx.repo, mode: 'diff', baseRef: fx.base, headSha: head, policyRef: fx.base, reviewers, stateDir: fx.stateDir }, copy)
  fx.head = head
  const shell = (m) => {
    assert.equal(m[1], path.join(copy, 'scripts', 'review-cli.mjs'))
    const r = spawnSync('bash', ['-c', m[0]], { encoding: 'utf8' })
    return r.stdout.trim()
  }
  const b = backend({
    exec: shell,
    review: (id) => (id === 'correctness'
      ? { ...reviewOk(fx.head, id, { findings: [finding({ path: odd })] }), coverage: ['docs/a.md', 'docs/b.md', odd] }
      : reviewOk(fx.head, id)),
    verify: verifyAll(fx.head, () => 'confirmed'),
  })
  const result = await runWorkflow(t, args, b)
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.deepEqual(result.findings.map((f) => f.path), [odd])
  assert.ok(b.calls.some((c) => c.options.label.startsWith('carrier:') && c.prompt.includes(odd)), 'そのパスが heredoc の本文に入っている')
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

test('Workflow source の判定は、置き方を変えた例でも runner の readSourceMetadata と一致する（meta の中身が literal かは見ない）', () => {
  for (const text of [
    "// c\nexport const meta = { name: 'a', description: 'b' }\nreturn 1",
    "/* c */\n\nexport const meta = { name: 'a', description: 'b' }",
    'export const meta = 1',
    "const x = 1\nexport const meta = { name: 'a', description: 'b' }",
    "import a from 'b'\nexport const meta = { name: 'a', description: 'b' }",
  ]) {
    let runner = true
    try {
      readSourceMetadata(text)
    } catch {
      runner = false
    }
    assert.equal(isWorkflowSource(text), runner, text)
  }
  // 既知の差: meta の中身が literal でない source を、runner は拒否するがこの判定は Workflow source とみなす（skill-design の担当が増える側に倒れる）。
  assert.equal(isWorkflowSource("export const meta = { name: x, description: 'b' }"), true)
})

const literalOf = (name) => JSON.parse(new RegExp(`^const ${name} = (.+)$`, 'm').exec(SOURCE_TEXT)[1].replace(/'/g, '"'))

test('Workflow source の写し（canonical・fnvSum・VERDICTS・VERIFY_ROUNDS）は CLI の部品と一致する', () => {
  const source = declarations(SOURCE_TEXT)
  assert.equal(source.get('canonical'), canonical.toString())
  assert.equal(source.get('fnvSum'), fnvSum.toString())
  assert.deepEqual(literalOf('VERDICTS'), [...VERDICTS])
  assert.equal(literalOf('VERIFY_ROUNDS'), VERIFY_ROUNDS)
})

test('meta.limits は本体の定数から決まる最悪の起動数・所要時間と一致する（本体は meta を読めないので式をテストで照らす）', () => {
  const rounds = literalOf('VERIFY_ROUNDS')
  const steps = literalOf('CARRIER_STEPS').length
  const tries = literalOf('CARRIER_TRIES')
  assert.equal(META.limits.maxAgents, (1 + rounds) * literalOf('MAX_REVIEWERS') + steps * tries)
  assert.equal(META.limits.timeoutMs, (1 + rounds + steps * tries) * META.limits.agentTimeoutMs)
  assert.equal(META.caps, undefined, '本体が使う値を meta に二重に持たない')
})

test('native Workflow は本体に meta を渡さない: 本体（export const meta の外）が識別子 meta を参照しない', () => {
  const ast = acorn.parse(`async function __s() {\n${SOURCE_TEXT.replace(/^export const meta =/, 'const __meta =')}\n}`, { ecmaVersion: 'latest', sourceType: 'module' })
  const refs = []
  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string') return
    const isProperty = parent && ((parent.type === 'MemberExpression' && parent.property === node && !parent.computed)
      || (parent.type === 'Property' && parent.key === node && !parent.computed))
    if (node.type === 'Identifier' && node.name === 'meta' && !isProperty) refs.push(node.start)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child) => visit(child, node))
      else if (value && typeof value === 'object') visit(value, node)
    }
  }
  visit(ast)
  assert.deepEqual(refs, [], '本体の meta の参照は native Workflow で ReferenceError になる')
})

test('Workflow source の重大度の名前は REVIEW.md「重大度」の表と一致する', () => {
  const review = readFileSync(path.join(ROOT, 'REVIEW.md'), 'utf8')
  const section = review.split(/^## /m).find((s) => s.startsWith('重大度'))
  const names = [...section.matchAll(/^\| ([A-Z]+) \|/gm)].map((m) => m[1])
  assert.ok(names.length > 0)
  assert.deepEqual(literalOf('SEVERITIES'), names)
})

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.name === 'node_modules' || e.isSymbolicLink()) return []
    if (e.isDirectory()) return jsFiles(full)
    return e.name.endsWith('.js') && statSync(full).isFile() ? [full] : []
  })
}

test('Workflow source の判定（isWorkflowSource）は、リポジトリの全ての .js で runner の readSourceMetadata と一致する', () => {
  const files = [...jsFiles(path.join(ROOT, 'plugins')), ...jsFiles(path.join(ROOT, '.agents', 'skills'))]
  assert.ok(files.length > 0)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    let runner = true
    try {
      readSourceMetadata(text)
    } catch {
      runner = false
    }
    assert.equal(isWorkflowSource(text), runner, path.relative(ROOT, file))
  }
})

test('初めての公開の操作が Workflow script を移せる（SKILL.md の callsite 以外に移動前のパスが無い）', () => {
  const code = [
    'import json, sys',
    'from pathlib import Path',
    "sys.path.insert(0, sys.argv[1])",
    'import register_plugin as r',
    "print(json.dumps(r.inspect_workflow_scripts(Path(sys.argv[2]), 'repo-review', set(), set(), set())))",
  ].join('\n')
  const out = spawnSync('python3', ['-I', '-c', code, path.join(ROOT, '.agents', 'skills', 'manage-marketplace-plugin', 'scripts'), SKILL_DIR], { encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
  const found = JSON.parse(out.stdout)
  if (SOURCE.startsWith(path.join(SKILL_DIR, 'scripts'))) {
    assert.equal(found.length, 1)
    assert.deepEqual(found[0].reasons, [])
  } else {
    // 公開の後は移す script が残っておらず、callsite は名前の呼び出しに書き換わっている。
    assert.deepEqual(found, [])
    assert.match(readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8'), new RegExp(`name: "[a-z][a-z0-9-]*:${META_NAME}"`))
  }
})
