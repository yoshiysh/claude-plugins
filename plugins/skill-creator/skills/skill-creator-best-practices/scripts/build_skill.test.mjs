import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { compileSource } from '../../../../workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs';

const source = await readFile(new URL('../../../workflows/build_skill.js', import.meta.url), 'utf8');
const { body, meta } = compileSource(source, []);

const DRAFT = '---\nname: example\ndescription: Use when testing.\n---\n# Example\n';
const CASES = ['normal', 'edge', 'should-not-trigger'].map((kind, i) =>
  ({ id: `t${i + 1}`, kind, prompt: `prompt ${i + 1}`, assertions: ['a'] }));

function respond(label) {
  if (label.startsWith('write-')) return DRAFT;
  if (label === 'generate-tests') return { cases: CASES };
  if (label.startsWith('grade-')) {
    const side = { assertions: [{ result: 'pass', evidence: 'e' }] };
    return { with_skill: side, baseline: { assertions: [{ result: 'fail', evidence: 'e' }] } };
  }
  if (label.startsWith('review-')) return { criteria_checks: [], trigger_checks: [], unchecked_judgments: [], failed: [], report: 'r' };
  return `${label} output`;
}

// parallel は Promise.all（runner と同じく throw を catch しない）。throw が run を落とさないことをここで確かめる。
async function run(agent) {
  const context = createContext({
    args: { skillDir: '/mock/skill-creator', requirements: 'req', taskType: 'procedure', uncheckedItems: [] },
    agent,
    meta,
    parallel: tasks => Promise.all(tasks.map(task => task())),
    phase() {},
    log() {},
  }, { codeGeneration: { strings: false, wasm: false } });
  return new Script(`(async () => { "use strict"; ${body}\n})()`).runInContext(context, { timeout: 1000 });
}

test('a grader that throws degrades to an ungraded case and evaluation_incomplete', async () => {
  const result = await run(async (prompt, opts) => {
    if (opts.label.startsWith('grade-t1-')) throw new Error('structured output retries exhausted');
    return respond(opts.label);
  });
  assert.equal(result.verdict, 'evaluation_incomplete');
  assert.equal(result.iterations[0].evaluation_complete, false);
});

test('evaluation executors, reviewer, comparator and analyzer that throw do not abort the run', async () => {
  const result = await run(async (prompt, opts) => {
    if (/^(with_skill-t2-|review-|compare-|analyze-)/.test(opts.label)) throw new Error('budget exhausted');
    return respond(opts.label);
  });
  assert.equal(result.verdict, 'evaluation_incomplete');
});
