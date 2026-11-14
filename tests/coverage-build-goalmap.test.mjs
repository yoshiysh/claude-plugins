// 目標・基準・制約の引用と目標の照合の静的な照合（<goalmap> 区間）が、coverage-build と coverage-audit の Workflow source で同じ文であることを照らす。
// 2 つのスキルのファイルを読むので、配布物に入らないリポジトリ直下の tests/ に置く。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

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
