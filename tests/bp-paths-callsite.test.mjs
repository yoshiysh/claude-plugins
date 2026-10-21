import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSourceMetadata } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs';
import { extractCallsites, pluginOf, resolveCallsites, workflowMetaName } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/callsites.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS = path.join(ROOT, 'plugins');

function skills() {
  return readdirSync(PLUGINS).flatMap((p) => {
    const dir = path.join(PLUGINS, p, 'skills');
    return existsSync(dir) ? readdirSync(dir).map((s) => path.join(dir, s)).filter((s) => existsSync(path.join(s, 'SKILL.md'))) : [];
  });
}

test('SP-BPENTRY-022: 実際の plugin の SKILL.md の名前の callsite が、runner の readSourceMetadata と同じ meta.name の workflow script に解決する', () => {
  let named = 0;
  for (const skill of skills()) {
    const plugin = pluginOf(skill);
    const { files, unresolved } = resolveCallsites(skill);
    const calls = extractCallsites(readFileSync(path.join(skill, 'SKILL.md'), 'utf8')).filter((c) => c.kind === 'name' && c.value.startsWith(`${plugin.name}:`));
    for (const call of calls) {
      const local = call.value.split(':')[1];
      const file = files.find((f) => readSourceMetadata(readFileSync(f, 'utf8')).name === local);
      assert.ok(file || unresolved.some((u) => u.line === call.line), `${skill}: ${call.value}`);
      if (file) {
        assert.equal(workflowMetaName(readFileSync(file, 'utf8')), local);
        named += 1;
      }
    }
  }
  assert.ok(named > 0, '名前の callsite を 1 つも照らしていない');
});
