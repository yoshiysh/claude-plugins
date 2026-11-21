// coverage-build が coverage-audit から写した関数・定数（lock、役の入口、結果の path と submit の命令、詰め合わせ）が、正本と同じ本文であることを照らす。
// 2 つのスキルは実行時に互いのファイルを読まない（値を import しない）ので、写しの一致はこのテストだけが照らす。2 つのスキルのファイルを読むので、
// 配布物に入らないリポジトリ直下の tests/ に置く。形は coverage-build-goalmap.test.mjs（<goalmap> 区間の一致）に合わせる。
//
// 照らす本文: 宣言の行から、const は 1 行、function は列 0 の「}」の行まで。行全体の // の注釈と /* */ の注釈は除く（注釈は各スキルの言葉で書いてよい）。
// export の有無は違ってよい（行頭の「export 」を除く）。正本と違ってよいのは次の名前の置き換えだけで、ほかの違いは全て落ちる。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const AUDIT_CLI = '.agents/skills/coverage-audit/scripts/ledger-cli.mjs'
const BUILD_CLI = '.agents/skills/coverage-build/scripts/build-cli.mjs'
const AUDIT_CORE = '.agents/skills/coverage-audit/scripts/ledger-core.mjs'
const BUILD_CORE = '.agents/skills/coverage-build/scripts/build-core.mjs'
// 正本の文字列 → 写しの文字列。スキルごとの lock のファイル名と、stateDir に置く入口の名前だけ。
const RENAMES = [["'ledger.lock'", "'build.lock'"], ["'ledger-cli.mjs'", "'build-cli.mjs'"]]

const COPIES = [
  ...['LOCK_WAIT_MS', 'LOCK_STALE_MS', 'LOCK_SLEEP_MS', 'nap', 'withLock', 'LAUNCHER', 'launcherText', 'writeLauncher', 'sq', 'CLI_PATH', 'resultPath', 'submitCmd'].map((name) => [name, AUDIT_CLI, BUILD_CLI]),
  ...['UNIT_MAX_BYTES', 'packUnits'].map((name) => [name, AUDIT_CORE, BUILD_CORE]),
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
const rename = (text) => RENAMES.reduce((t, [a, b]) => t.split(a).join(b), text)

for (const [name, canon, copy] of COPIES) {
  test(`写しの一致: ${path.basename(copy)} の ${name} は ${path.basename(canon)} の正本と同じ本文（名前の置き換えを除く）`, () => {
    assert.equal(decl(copy, name), rename(decl(canon, name)))
  })
}
