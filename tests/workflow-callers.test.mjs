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
      /fallback しない|runner で再実行しない/,
      `${caller.skillMd}: native-attempt failure boundary is missing`
    )
    assert.match(
      caller.source,
      /runner\s*内\s*gate\s*に移さない|human gate は無し|caller の\s*(?:承認境界|human gate)\s*は維持/,
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
    // workflow plugin 自身が caller を含む構成（pdca / prd-spec / review-document を収録）では
    // 自己依存は宣言できないので免除する。runner は同 plugin 内に同梱されている。
    if (pluginName === 'workflow') continue
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


test('research workflow source is bounded and independent of hidden host state', () => {
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
    assert.doesNotMatch(source, forbidden, `${sourcePath}: workflow source depends on hidden or executable host state`)
  }
  assert.match(source, /const HARD_MAX_ROUNDS = \d+/)
  assert.match(source, /const MAX_CLAIMS_PER_ROUND = \d+/)
  assert.match(source, /evidence\/round-\$\{round\}\/slot-\$\{claimIndex\}\.md/)
  assert.doesNotMatch(source, /evidence\/\$\{claim\.id\}/)
})



test('the compatibility runner remains internal-only', () => {
  const skillMd = join(pluginsRoot, 'workflow', 'skills', 'dynamic-workflow-runner', 'SKILL.md')
  const source = readFileSync(skillMd, 'utf8')
  assert.match(source, /^user-invocable:\s*false$/m)
  assert.match(source, /direct mode.*保守・検証用/)
})
