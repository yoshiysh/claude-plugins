// coverage-build の references/writing.md が、prd-spec の document-structure.md の「2.7 表・図・散文の使い分け」の写しであることを照らす。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')
// 節の見出しから次の同じ深さの見出しまで（### の小節は含む）。
function section(text, heading) {
  const lines = text.split('\n')
  const i = lines.findIndex((l) => l.startsWith('## ') && l.replace(/^## (\d+(\.\d+)*\s+)?/, '') === heading)
  assert.ok(i >= 0, `見出しが無い: ${heading}`)
  const rest = lines.slice(i + 1)
  const end = rest.findIndex((l) => l.startsWith('## ') || l.startsWith('# '))
  return rest.slice(0, end < 0 ? rest.length : end).join('\n')
}
// 節番号の参照（§6・§2.8）と前後の空白だけを正規化する。
const normalize = (s) => s.replace(/§\s*\d+(\.\d+)*/g, '§N').replace(/\s+/g, ' ').trim()

test('writing.md の本文は、正本の 2.7 節と一致する', () => {
  const src = section(read('plugins/workflow/skills/prd-spec/references/document-structure.md'), '表・図・散文の使い分け')
  const copy = section(read('.agents/skills/coverage-build/references/writing.md'), '表・図・散文の使い分け')
  assert.ok(src.includes('### 表と図は出せる欠陥が違う') && src.includes('### 図は Mermaid で書く'), '小節も写しの範囲に入る')
  assert.equal(normalize(copy), normalize(src))
})

test('writing.md の冒頭に、どこの写しかが書いてある', () => {
  const head = read('.agents/skills/coverage-build/references/writing.md').split('\n## ')[0]
  assert.match(head, /plugins\/workflow\/skills\/prd-spec\/references\/document-structure\.md/)
  assert.match(head, /2\.7 表・図・散文の使い分け/)
})
