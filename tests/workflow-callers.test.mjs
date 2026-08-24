import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import test from 'node:test'

const repoRoot = resolve(import.meta.dirname, '..')
const pluginsRoot = join(repoRoot, 'plugins')

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function workflowCallers() {
  const callers = []
  for (const pluginName of readdirSync(pluginsRoot)) {
    const skillsRoot = join(pluginsRoot, pluginName, 'skills')
    if (!existsSync(skillsRoot)) continue
    for (const skillName of readdirSync(skillsRoot)) {
      const skillRoot = join(skillsRoot, skillName)
      const skillMd = join(skillRoot, 'SKILL.md')
      if (!existsSync(skillMd)) continue
      const source = readFileSync(skillMd, 'utf8')
      const callsites = [...source.matchAll(/Workflow\s*\(\s*\{[\s\S]*?scriptPath\s*:\s*['"]([^'"]+)['"][\s\S]*?\}\s*\)/g)]
      if (callsites.length) callers.push({ pluginName, skillName, skillRoot, skillMd, source, callsites })
    }
  }
  return callers
}

test('every Workflow caller declares the native-first transparent Codex route', () => {
  const callers = workflowCallers()
  assert.ok(callers.length > 0, 'expected at least one Workflow caller')

  for (const caller of callers) {
    assert.match(caller.source, /native `Workflow`/, `${caller.skillMd}: native-first route is missing`)
    assert.match(
      caller.source,
      /workflow:dynamic-workflow-runner/,
      `${caller.skillMd}: transparent runner route is missing`
    )
    assert.match(
      caller.source,
      /fallback しない/,
      `${caller.skillMd}: native-attempt failure boundary is missing`
    )
    assert.match(
      caller.source,
      /runner内gateに移さない|human gate は無し/,
      `${caller.skillMd}: caller gate ownership is missing`
    )

    for (const callsite of caller.callsites) {
      const declared = callsite[1]
      const placeholderSuffix = declared.match(/(?:\]|>|\})\/(.+)$/)
      const sourceRelative = normalize(placeholderSuffix ? placeholderSuffix[1] : declared.replace(/^\.\//, ''))
      assert.equal(
        isAbsolute(sourceRelative) || sourceRelative === '..' || sourceRelative.startsWith(`..${sep}`),
        false,
        `${caller.skillMd}: scriptPath must identify a skill-local source`
      )
      assert.ok(
        existsSync(join(caller.skillRoot, sourceRelative)),
        `${caller.skillMd}: declared workflow source does not exist: ${sourceRelative}`
      )
    }
  }
})

test('Workflow caller plugins declare Claude dependency without leaking it to Codex manifests', () => {
  const pluginNames = new Set(workflowCallers().map((caller) => caller.pluginName))
  for (const pluginName of pluginNames) {
    const pluginRoot = join(pluginsRoot, pluginName)
    const claude = json(join(pluginRoot, '.claude-plugin', 'plugin.json'))
    const codex = json(join(pluginRoot, '.codex-plugin', 'plugin.json'))
    assert.ok(
      Array.isArray(claude.dependencies) && claude.dependencies.includes('workflow'),
      `${pluginName}: Claude manifest must depend on workflow`
    )
    assert.equal(
      Object.hasOwn(codex, 'dependencies'),
      false,
      `${pluginName}: Codex manifest must not use the unsupported dependencies field`
    )
  }
})

test('every active Workflow callsite has an explicit semantic portability classification', () => {
  const expected = new Map([
    ['pdca/pdca/scripts/pdca.js', 'rejected_source_v1'],
    ['research/dispatch/scripts/orchestrate.js', 'rejected_source_v1'],
    ['research/search/scripts/investigate.js', 'portable_v1'],
    ['skill-creator/skill-creator-best-practices/scripts/build_skill.js', 'portable_v1'],
    ['skill-creator/skill-creator-best-practices/scripts/review_skill.js', 'rejected_source_v1'],
  ])
  const observed = new Set()

  for (const caller of workflowCallers()) {
    for (const callsite of caller.callsites) {
      const declared = callsite[1]
      const placeholderSuffix = declared.match(/(?:\]|>|\})\/(.+)$/)
      const sourceRelative = normalize(placeholderSuffix ? placeholderSuffix[1] : declared.replace(/^\.\//, ''))
      const key = `${caller.pluginName}/${caller.skillName}/${sourceRelative}`
      const classification = expected.get(key)
      assert.ok(classification, `${key}: add an explicit portability classification`)
      observed.add(key)
      assert.match(caller.source, new RegExp(`Codex v1 classification: .*${classification}`))
    }
  }
  assert.deepEqual(observed, new Set(expected.keys()), 'classification registry and discovered callsites must match exactly')
})

test('portable research source is bounded and independent of hidden host state', () => {
  const sourcePath = join(pluginsRoot, 'research', 'skills', 'search', 'scripts', 'investigate.js')
  const source = readFileSync(sourcePath, 'utf8')
  for (const forbidden of [
    /\bbudget\s*\./,
    /\bprocess\s*\./,
    /Math\.random\s*\(/,
    /Date\.now\s*\(/,
    /\beval\s*\(/,
    /new\s+Function\s*\(/,
    /import\s*\(/,
  ]) {
    assert.doesNotMatch(source, forbidden, `${sourcePath}: portable source depends on hidden or executable host state`)
  }
  assert.match(source, /const HARD_MAX_ROUNDS = \d+/)
  assert.match(source, /const MAX_CLAIMS_PER_ROUND = \d+/)
  assert.match(source, /evidence\/round-\$\{round\}\/slot-\$\{claimIndex\}\.md/)
  assert.doesNotMatch(source, /evidence\/\$\{claim\.id\}/)
})

test('portable sources declare every non-load-bearing model hint exactly once', () => {
  const sourcePaths = [
    join(pluginsRoot, 'research', 'skills', 'search', 'scripts', 'investigate.js'),
    join(pluginsRoot, 'skill-creator', 'skills', 'skill-creator-best-practices', 'scripts', 'build_skill.js'),
  ]
  for (const sourcePath of sourcePaths) {
    const source = readFileSync(sourcePath, 'utf8')
    assert.match(source, /schema_version: 'claude-workflow-model-portability\/v1'/)
    assert.match(source, /model_identity_semantics: 'non_load_bearing_scheduling_hint'/)
    assert.match(source, /quality_parity: 'not_guaranteed'/)
    assert.doesNotMatch(source, /(?<![A-Za-z0-9_])model:\s*['"]/, `${sourcePath}: raw model callsite bypasses the portability declaration`)
    const declared = [...source.matchAll(/^\s{6}([a-z][a-z0-9_]*)\s*:\s*\{ requested_model:/gm)].map((match) => match[1])
    const used = [...source.matchAll(/model:\s*modelHint\('([a-z][a-z0-9_]*)'\)/g)].map((match) => match[1])
    assert.equal(new Set(declared).size, declared.length, `${sourcePath}: duplicate model hint declaration`)
    assert.equal(new Set(used).size, used.length, `${sourcePath}: one model hint is reused by multiple source callsites`)
    assert.deepEqual(new Set(used), new Set(declared), `${sourcePath}: declared and used model callsites differ`)
  }
})

test('rejected sources document the load-bearing construct that v1 cannot preserve', () => {
  const dispatch = readFileSync(join(pluginsRoot, 'research', 'skills', 'dispatch', 'SKILL.md'), 'utf8')
  assert.match(dispatch, /rejected_source_v1[\s\S]*load-bearing exact model semantics/)

  const pdca = readFileSync(join(pluginsRoot, 'pdca', 'skills', 'pdca', 'SKILL.md'), 'utf8')
  assert.match(pdca, /rejected_source_v1[\s\S]*worktree isolation \/ runtime-generated artifacts/)

  const creator = readFileSync(
    join(pluginsRoot, 'skill-creator', 'skills', 'skill-creator-best-practices', 'references', 'codex-workflow-compatibility.md'),
    'utf8'
  )
  assert.match(creator, /mode: review[\s\S]*rejected_source[\s\S]*file inventory/)
  assert.match(creator, /mode: update[\s\S]*rejected_source[\s\S]*runtimeで決まる複数file/)
})

test('the compatibility runner remains internal-only', () => {
  const skillMd = join(pluginsRoot, 'workflow', 'skills', 'dynamic-workflow-runner', 'SKILL.md')
  const source = readFileSync(skillMd, 'utf8')
  assert.match(source, /^user-invocable:\s*false$/m)
  assert.match(source, /direct mode.*保守・移行検証用/)
})
