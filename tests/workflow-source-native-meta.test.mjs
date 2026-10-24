import assert from 'node:assert/strict'
import { globSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { bodyMetaReferences, isMetaDeclaration, parseModule } from './helpers/workflow-source.mjs'

const repoRoot = resolve(import.meta.dirname, '..')

// 置き場は best-practices.md §13「script の置き場」の 2 段。scripts/ の .js は Workflow source でないものも混ざるので
// 先頭の文で選び、workflows/ の .js は全てを Workflow source として扱う（runner が全てを source として読むため）。
const SCRIPT_GLOBS = ['plugins/*/skills/*/scripts/*.js', '.agents/skills/*/scripts/*.js']
const WORKFLOW_GLOBS = ['plugins/*/workflows/*.js']

function workflowSources() {
  const found = new Map()
  const add = (path) => {
    const real = realpathSync(join(repoRoot, path))
    if (real.split(sep).join('/').includes('/tests/fixtures/')) return
    if (!found.has(real)) found.set(real, relative(repoRoot, real))
  }
  for (const path of SCRIPT_GLOBS.flatMap((pattern) => globSync(pattern, { cwd: repoRoot }))) {
    let first
    try {
      first = parseModule(readFileSync(join(repoRoot, path), 'utf8')).body[0]
    } catch (error) {
      throw new Error(`${path}: cannot parse (${error.message})`)
    }
    if (isMetaDeclaration(first)) add(path)
  }
  for (const path of WORKFLOW_GLOBS.flatMap((pattern) => globSync(pattern, { cwd: repoRoot }))) add(path)
  return [...found.values()].sort()
}

test('the body meta detector counts every reference form and ignores property names', () => {
  const definition = 'export const meta = { name: "x", description: "y" };\n'
  const reads = ['meta.x', 'meta?.x', 'meta["x"]', 'const { a } = meta', 'f(meta)', 'Object.keys(meta)', '`${meta.x}`',
    'const o = { meta }', 'const o = { [meta]: 1 }', 'obj[meta]', 'const m = meta']
  for (const read of reads) assert.equal(bodyMetaReferences(definition + read).length, 1, read)
  const quiet = ['/* meta.x */', 'x = 1 // meta.x', '"meta.json"', '`${W}.meta.json`', 'obj.meta.x', 'obj?.meta',
    'const o = { meta: 1 }', 'class A { meta() {} }', 'class B { meta = 1 }', 'const u = import.meta.url', 'meta: for (;;) break meta']
  for (const source of quiet) assert.equal(bodyMetaReferences(definition + source).length, 0, source)
  assert.equal(bodyMetaReferences(definition).length, 0, 'the export const meta declaration is not a body reference')
})

test('Workflow sources are enumerated from both placements without duplicates', () => {
  const sources = workflowSources()
  for (const known of [
    'plugins/skill-creator/workflows/build_skill.js',
    'plugins/workflow/workflows/prd-spec.js',
    'plugins/research/skills/dispatch/scripts/orchestrate.js',
    'plugins/workflow/skills/review-document/scripts/review-document.js',
  ]) assert.ok(sources.includes(known), `${known} is not enumerated`)
  assert.equal(new Set(sources).size, sources.length)
})

test('native Workflow does not bind meta in the body: no Workflow source body references meta', () => {
  const offenders = workflowSources()
    .map((path) => ({ path, refs: bodyMetaReferences(readFileSync(join(repoRoot, path), 'utf8')) }))
    .filter(({ refs }) => refs.length > 0)
    .map(({ path, refs }) => `${path} @ ${refs.join(',')}`)
  assert.deepEqual(offenders, [], 'a body reference to meta throws ReferenceError under native Workflow')
})
