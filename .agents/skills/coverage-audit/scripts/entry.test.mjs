// CLI を symlink 経由（.claude/skills -> .agents/skills の形）で流しても、直接流したときと同じく出力して終わること。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmp } from './test-harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

test('symlink 経由の CLI も使い方の誤りを JSON で返し、終了状態 2 で終わる', (t) => {
  const link = path.join(tmp(t), 'scripts')
  symlinkSync(HERE, link, 'dir')
  for (const cli of [path.join(HERE, 'ledger-cli.mjs'), path.join(link, 'ledger-cli.mjs')]) {
    const r = spawnSync(process.execPath, [cli], { encoding: 'utf8' })
    assert.equal(r.status, 2, cli)
    assert.equal(JSON.parse(r.stdout).ok, false, cli)
  }
})
