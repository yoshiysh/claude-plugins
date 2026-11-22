// formal-method が coverage-audit から写した定数・関数（単位の上限、shell の 1 語、完了通知の包みを外す unwrap、詰め合わせの packUnits）が、正本と同じ本文であることを照らす。
// 2 つのスキルは実行時に互いのファイルを読まない（値を import しない。docs/guidelines/repository-operations.md「plugin 間でスキルは共有できない」）ので、
// 写しの一致はこのテストだけが照らす。2 つのスキルのファイルを読むので、配布物に入らないリポジトリ直下の tests/ に置く。
// 形は tests/coverage-build-audit-copies.test.mjs に合わせる。
//
// 照らす本文: 宣言の行から、const は 1 行、function は列 0 の「}」の行まで。行全体の // の注釈と /* */ の注釈は除く（注釈は各スキルの言葉で書いてよい）。
// export の有無は違ってよい（行頭の「export 」を除く）。ほかの違いは全て落ちる。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const AUDIT_CLI = '.agents/skills/coverage-audit/scripts/ledger-cli.mjs'
const AUDIT_CORE = '.agents/skills/coverage-audit/scripts/ledger-core.mjs'
const FM_CALL = '.agents/skills/formal-method/scripts/lib/call.mjs'
const FM_SCHEMAS = '.agents/skills/formal-method/scripts/lib/schemas.mjs'

const COPIES = [
  ['UNIT_MAX_BYTES', AUDIT_CORE, FM_SCHEMAS],
  ['sq', AUDIT_CLI, FM_CALL],
  ['unwrap', AUDIT_CLI, FM_CALL],
  ['packUnits', AUDIT_CORE, FM_CALL],
]

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function decl(file, name) {
  const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n')
  const head = new RegExp(`^(export )?(const|function) ${esc(name)}\\b`)
  const at = lines.map((l, i) => (head.test(l) ? i : -1)).filter((i) => i >= 0)
  assert.equal(at.length, 1, `${file} に ${name} の宣言がちょうど 1 つある（${at.length} 個）`)
  const s = at[0]
  let e = s
  if (/^(export )?function /.test(lines[s])) {
    while (e < lines.length && lines[e] !== '}') e++
    assert.ok(e < lines.length, `${file} の ${name} の終わり（列 0 の「}」）が見つかる`)
  } else {
    assert.ok(!/[{([]\s*$/.test(lines[s]), `${file} の ${name} は 1 行の const（複数行なら、このテストの切り出しを直す）`)
  }
  return lines.slice(s, e + 1)
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/\/\*.*?\*\//g, '').replace(/\s+$/, ''))
    .join('\n')
    .replace(/^export /, '')
}

for (const [name, canon, copy] of COPIES) {
  test(`写しの一致: formal-method の ${path.basename(copy)} の ${name} は ${path.basename(canon)} の正本と同じ本文`, () => {
    assert.equal(decl(copy, name), decl(canon, name))
  })
}

// 照らし方そのものの自己検査: 本文が 1 字違えば落ちる。
test('写しの一致の照らし方: 正本と 1 字違う本文は一致しない', () => {
  const a = decl(AUDIT_CLI, 'unwrap')
  assert.notEqual(a.replace('agentCount', 'agentcount'), a)
})
