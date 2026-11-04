import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// テストが AddressError の全ての throw の箇所を通ったかを数えるための部品（本体からは使わない）。
// 箇所は source の `throw new AddressError` の行で、拒否の stack の最初の（constructor でない）frame の行と照らす。
export function throwSites(fileUrl) {
  return readFileSync(fileURLToPath(fileUrl), 'utf8').split('\n')
    .flatMap((line, n) => (line.includes('throw new AddressError') ? [n + 1] : []))
}

export function siteOf(error, fileUrl) {
  const frame = String(error.stack).split('\n').slice(1).find((l) => !l.includes('new AddressError'))
  const m = frame?.match(/\((.+):(\d+):\d+\)$/) ?? frame?.match(/at (.+):(\d+):\d+$/)
  return m && m[1] === fileUrl ? Number(m[2]) : null
}
