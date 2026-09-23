import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { compileSource } from '../../../../workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs';

const source = await readFile(new URL('./review_skill.js', import.meta.url), 'utf8');
const { body } = compileSource(source, []);

async function run(mode) {
  const phases = [];
  const context = createContext({
    args: {
      skillDir: '/mock/skill-creator',
      mode,
      target: { skillPath: '/mock/target', scope: 'full' },
      uncheckedItems: [],
      ...(mode === 'update' ? { intent: 'exercise missing-finder path' } : {}),
      stagingDir: '/mock/target-workspace/staging',
    },
    agent: async () => null,
    parallel: tasks => Promise.all(tasks.map(task => task())),
    phase: value => phases.push(value),
    log() {},
  }, { codeGeneration: { strings: false, wasm: false } });
  const result = await new Script(`(async () => { "use strict"; ${body}\n})()`)
    .runInContext(context, { timeout: 1000 });
  return { result, phases };
}

for (const mode of ['review', 'update']) {
  test(`${mode} returns initial missing-finder result before reverify state is used`, async () => {
    const { result, phases } = await run(mode);
    assert.equal(result.verdict, 'review_incomplete');
    assert.deepEqual(Array.from(result.reverify_missing), []);
    assert.deepEqual(phases, ['Find', 'Verify']);
  });
}
