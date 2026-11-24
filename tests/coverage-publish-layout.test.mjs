// coverage-audit と coverage-build の Workflow source の置き場が公開の前後で変わっても、CLI の core が解けることを照らす。
// 2 つのスキルと公開の操作のファイルを読むので、配布物に入らないリポジトリ直下の tests/ に置く。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { WORKFLOW_SOURCE as AUDIT_WF } from '../.agents/skills/coverage-audit/scripts/ledger-core.mjs'
import { WORKFLOW_SOURCE as BUILD_WF } from '../.agents/skills/coverage-build/scripts/build-core.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const SKILLS = { 'coverage-audit': { source: AUDIT_WF, core: 'ledger-core.mjs' }, 'coverage-build': { source: BUILD_WF, core: 'build-core.mjs' } }

for (const [name, { source }] of Object.entries(SKILLS)) {
  test(`初めての公開の操作が ${name} の Workflow script を移せる（SKILL.md の callsite 以外に移動前のパスが無い）`, () => {
    const code = [
      'import json, sys',
      'from pathlib import Path',
      'sys.path.insert(0, sys.argv[1])',
      'import register_plugin as r',
      'print(json.dumps(r.inspect_workflow_scripts(Path(sys.argv[2]), sys.argv[3], set(), set(), set())))',
    ].join('\n')
    const skillDir = path.join(ROOT, '.agents', 'skills', name)
    const out = spawnSync('python3', ['-I', '-c', code, path.join(ROOT, '.agents', 'skills', 'manage-marketplace-plugin', 'scripts'), skillDir, name], { encoding: 'utf8' })
    assert.equal(out.status, 0, out.stderr)
    const found = JSON.parse(out.stdout)
    if (lstatSync(skillDir).isSymbolicLink()) {
      assert.deepEqual(found, [], '公開の後は移す script が残っていない')
    } else {
      assert.equal(found.length, 1)
      assert.deepEqual(found[0].reasons, [])
      assert.equal(found[0].file, path.basename(source))
    }
  })
}

// 公開の後の配置（plugins/<p>/skills/<name>/scripts/ と plugins/<p>/workflows/）を一時ディレクトリに作り、core を読み込む。
// where: Workflow source を置く所（'workflows'・'both'・'none'）。
function layout(t, where) {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), 'coverage-publish-')))
  t.after(() => rmSync(d, { recursive: true, force: true }))
  const plugin = path.join(d, 'plugins', 'x')
  mkdirSync(path.join(plugin, 'workflows'), { recursive: true })
  for (const [name, { source }] of Object.entries(SKILLS)) {
    const scripts = path.join(plugin, 'skills', name, 'scripts')
    cpSync(realpathSync(path.join(ROOT, '.agents', 'skills', name, 'scripts')), scripts, { recursive: true, filter: (p) => !p.endsWith(path.sep + path.basename(source)) })
    if (where === 'workflows' || where === 'both') cpSync(source, path.join(plugin, 'workflows', path.basename(source)))
    if (where === 'both') cpSync(source, path.join(scripts, path.basename(source)))
  }
  return plugin
}
const load = (plugin, name) => import(pathToFileURL(path.join(plugin, 'skills', name, 'scripts', SKILLS[name].core)).href)

test('公開の後の配置: 両方の core は plugin の workflows/ の Workflow source を読む', async (t) => {
  const plugin = layout(t, 'workflows')
  for (const name of Object.keys(SKILLS)) {
    const m = await load(plugin, name)
    assert.equal(m.WORKFLOW_SOURCE, path.join(plugin, 'workflows', path.basename(SKILLS[name].source)))
    assert.equal(typeof m.C.norm, 'function', `${name} の <checks> 区間を読み込める`)
  }
})

test('隣と workflows/ の両方にあれば、隣を読む', async (t) => {
  const plugin = layout(t, 'both')
  for (const name of Object.keys(SKILLS)) {
    const m = await load(plugin, name)
    assert.equal(m.WORKFLOW_SOURCE, path.join(plugin, 'skills', name, 'scripts', path.basename(SKILLS[name].source)))
  }
})

test('どちらにも無ければ、探した 2 つの path を出して読み込みで止まる', async (t) => {
  const plugin = layout(t, 'none')
  const file = path.basename(AUDIT_WF)
  await assert.rejects(load(plugin, 'coverage-audit'), (e) => e.message.includes(path.join(plugin, 'skills', 'coverage-audit', 'scripts', file)) && e.message.includes(path.join(plugin, 'workflows', file)))
})
