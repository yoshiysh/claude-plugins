import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { bodyLiteral, bodyMetaReferences, workflowSources } from './helpers/workflow-source.mjs'

const repoRoot = resolve(import.meta.dirname, '..')

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
  const sources = workflowSources(repoRoot)
  for (const known of [
    'plugins/skill-creator/workflows/build_skill.js',
    'plugins/workflow/workflows/prd-spec.js',
    'plugins/research/skills/dispatch/scripts/orchestrate.js',
    'plugins/research/skills/search/scripts/investigate.js',
    'plugins/workflow/skills/review-document/scripts/review-document.js',
  ]) assert.ok(sources.includes(known), `${known} is not enumerated`)
  assert.equal(sources.includes('plugins/skill-creator/skills/skill-creator-best-practices/scripts/select_runtime.js'), false,
    'a scripts/ file whose first statement is not export const meta is not a Workflow source')
  assert.equal(new Set(sources).size, sources.length)
})

test('native Workflow does not bind meta in the body: no Workflow source body references meta', () => {
  const offenders = workflowSources(repoRoot)
    .map((path) => ({ path, refs: bodyMetaReferences(readFileSync(join(repoRoot, path), 'utf8')) }))
    .filter(({ refs }) => refs.length > 0)
    .map(({ path, refs }) => `${path} @ ${refs.join(',')}`)
  assert.deepEqual(offenders, [], 'a body reference to meta throws ReferenceError under native Workflow')
})

test('bodyLiteral reads only a top-level literal constant of the body', () => {
  const source = 'export const meta = { name: "x", description: "y", limits: { a: 1 } };\nconst A = { b: [1, -2, "c"] }\nconst B = f()\nfunction g() { const C = 1 }\n'
  assert.deepEqual(bodyLiteral(source, 'A'), { b: [1, -2, 'c'] })
  assert.throws(() => bodyLiteral(source, 'B'), /must be a literal/)
  assert.throws(() => bodyLiteral(source, 'C'), /is missing/)
  assert.throws(() => bodyLiteral(source, 'meta'), /is missing/, 'the meta declaration is not a body constant')
  assert.throws(() => bodyLiteral(source + 'const D = { A }\n', 'D'), /must be a literal/)
})
