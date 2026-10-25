import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { THREADS_QUERY } from './address-cli.mjs'

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]))
}

// 名前を組み立てるのは、このテスト自身が検出の対象に当たらないため。
const THREAD_MUTATIONS = ['resolve', 'unresolve'].map((verb) => `${verb}ReviewThread`)
const GRAPHQL_MUTATION = /\bmutation\s*(\w+\s*)?[({]/
const MUTATION = ['muta', 'tion'].join('')

test('スキルのどのファイルにも thread を resolve する経路が無い', () => {
  const all = files(SKILL_DIR)
  assert.ok(all.some((f) => f.endsWith('SKILL.md')) && all.some((f) => f.endsWith('address-cli.mjs')), '走査の対象にスキルのファイルが入っていない')
  const offenders = all.flatMap((file) => {
    const text = readFileSync(file, 'utf8')
    return [...THREAD_MUTATIONS.filter((name) => text.includes(name)), ...(GRAPHQL_MUTATION.test(text) ? ['graphql mutation'] : [])]
      .map((hit) => `${path.relative(SKILL_DIR, file)}: ${hit}`)
  })
  assert.deepEqual(offenders, [])
})

test('検出は mutation の呼び出しに当たり、文中の語には当たらない', () => {
  assert.ok(GRAPHQL_MUTATION.test(`${MUTATION} { ${THREAD_MUTATIONS[0]}(input: {threadId: "x"}) { thread { id } } }`))
  assert.ok(GRAPHQL_MUTATION.test(`${MUTATION} Resolve($id: ID!) { x }`))
  assert.equal(GRAPHQL_MUTATION.test('resolve の mutation が無いことを照らす'), false)
  assert.equal(GRAPHQL_MUTATION.test('thread を resolve しない'), false)
})

test('CLI が送る GraphQL は読み取りの query だけ', () => {
  assert.match(THREADS_QUERY.trimStart(), /^query\b/)
  assert.equal(GRAPHQL_MUTATION.test(THREADS_QUERY), false)
})
