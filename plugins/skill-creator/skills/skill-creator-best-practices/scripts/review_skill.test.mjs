import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { compileSource } from '../../../../workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs';

const source = await readFile(new URL('./review_skill.js', import.meta.url), 'utf8');
const { body } = compileSource(source, []);
const INTENT = 'exercise missing-finder path';

async function run(mode, agent = async () => null, target = { scope: 'full' }) {
  const phases = [];
  const context = createContext({
    args: {
      skillDir: '/mock/skill-creator',
      mode,
      target: { skillPath: '/mock/target', ...target },
      uncheckedItems: [],
      ...(mode === 'update' ? { intent: INTENT } : {}),
      stagingDir: '/mock/target-workspace/staging',
    },
    agent,
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

function respondingAgent() {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, label: opts.label });
    if (opts.label.startsWith('update-')) {
      return { changed_files: [{ path: 'SKILL.md', reason: 'intent', findings_addressed: [] }], summary: 'updated' };
    }
    return { findings: [], scanned_files: ['SKILL.md'], unreadable: false, unchecked_judgments: [] };
  };
  return { agent, calls };
}

test('update reverify finders receive intent verbatim', async () => {
  const { agent, calls } = respondingAgent();
  const { result } = await run('update', agent);
  const reverify = calls.filter(c => c.label.startsWith('find-') && /-p2r\d+(-retry)?$/.test(c.label));
  assert.ok(reverify.length > 0);
  for (const c of reverify) assert.ok(c.prompt.includes(`[INTENT]:\n${INTENT}`), c.label);
  assert.equal(result.verdict, 'applied_to_staging');
});

function intentMismatchAgent(presentInOriginal, findingLabels = ['find-why-driven-p2r1'], file = 'SKILL.md') {
  return reverifyFindingAgent({
    file,
    location: 'L1',
    claim: 'revision does not satisfy intent',
    evidence: 'quoted',
    severity: 'major',
    suggested_fix: 'rewrite to satisfy intent',
    present_in_original: presentInOriginal,
  }, findingLabels);
}

function reverifyFindingAgent(finding, findingLabels) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, label: opts.label, phase: opts.phase });
    if (opts.label.startsWith('update-')) {
      return { changed_files: [{ path: 'SKILL.md', reason: 'intent', findings_addressed: [] }], summary: 'updated' };
    }
    if (opts.label.startsWith('refute-')) return { verdict: 'not_refuted', reason: 'holds' };
    const findings = findingLabels.includes(opts.label) ? [finding] : [];
    return { findings, scanned_files: ['SKILL.md'], unreadable: false, unchecked_judgments: [] };
  };
  return { agent, calls };
}

test('intent mismatch with present_in_original false re-enters the update loop', async () => {
  const { agent, calls } = intentMismatchAgent(false);
  const { result } = await run('update', agent);
  const updaters = calls.filter(c => c.label.startsWith('update-')).map(c => c.label);
  assert.deepEqual(updaters, ['update-r1', 'update-r2']);
  assert.ok(calls.find(c => c.label === 'update-r2').prompt.includes('revision does not satisfy intent'));
  assert.equal(result.verdict, 'applied_to_staging');
  assert.equal(result.revisions_used, 1);
});

test('diff scope keeps an intent mismatch on an unchanged, unscanned file unresolved', async () => {
  const labels = ['find-why-driven-p2r1', 'find-why-driven-p2r2'];
  const { agent, calls } = intentMismatchAgent(false, labels, 'references/untouched.md');
  const { result } = await run('update', agent, { scope: 'diff', diffRef: 'main...HEAD' });
  const updaters = calls.filter(c => c.label.startsWith('update-')).map(c => c.label);
  assert.deepEqual(updaters, ['update-r1', 'update-r2']);
  assert.equal(result.staging.out_of_scope.length, 0);
  assert.equal(result.staging.new.length, 1);
  assert.equal(result.verdict, 'needs_human_decision');
});

test('diff scope keeps a finding with present_in_original omitted on an unchanged, unscanned file unresolved', async () => {
  const labels = ['find-why-driven-p2r1', 'find-why-driven-p2r2'];
  const { agent, calls } = intentMismatchAgent(undefined, labels, 'references/untouched.md');
  const { result } = await run('update', agent, { scope: 'diff', diffRef: 'main...HEAD' });
  const updaters = calls.filter(c => c.label.startsWith('update-')).map(c => c.label);
  assert.deepEqual(updaters, ['update-r1', 'update-r2']);
  assert.equal(result.staging.out_of_scope.length, 0);
  assert.equal(result.staging.new.length, 1);
  assert.equal(result.verdict, 'needs_human_decision');
});

test('diff scope treats an unchanged, unscanned file finding as out of scope', async () => {
  const { agent, calls } = reverifyFindingAgent({
    file: 'references/untouched.md',
    location: 'L1',
    claim: 'comment restates what the code does',
    evidence: 'quoted',
    severity: 'major',
    suggested_fix: 'drop the comment',
    present_in_original: true,
  }, ['find-why-driven-p2r1']);
  const { result } = await run('update', agent, { scope: 'diff', diffRef: 'main...HEAD' });
  const updaters = calls.filter(c => c.label.startsWith('update-')).map(c => c.label);
  assert.deepEqual(updaters, ['update-r1']);
  assert.equal(result.staging.out_of_scope.length, 1);
  assert.equal(result.staging.new.length, 0);
  assert.equal(result.verdict, 'applied_to_staging');
});

test('diff scope treats the same finding on a changed file as preexisting', async () => {
  const { agent, calls } = reverifyFindingAgent({
    file: 'SKILL.md',
    location: 'L1',
    claim: 'comment restates what the code does',
    evidence: 'quoted',
    severity: 'major',
    suggested_fix: 'drop the comment',
    present_in_original: true,
  }, ['find-why-driven-p2r1']);
  const { result } = await run('update', agent, { scope: 'diff', diffRef: 'main...HEAD' });
  const updaters = calls.filter(c => c.label.startsWith('update-')).map(c => c.label);
  assert.deepEqual(updaters, ['update-r1']);
  assert.equal(result.staging.preexisting.length, 1);
  assert.equal(result.staging.out_of_scope.length, 0);
  assert.equal(result.verdict, 'applied_to_staging');
});

test('reverify finding already present in the original is preexisting and does not re-enter the loop', async () => {
  const { agent, calls } = reverifyFindingAgent({
    file: 'SKILL.md',
    location: 'L3',
    claim: 'comment restates what the code does',
    evidence: 'quoted',
    severity: 'major',
    suggested_fix: 'drop the comment',
    present_in_original: true,
  }, ['find-why-driven-p2r1']);
  const { result } = await run('update', agent);
  const updaters = calls.filter(c => c.label.startsWith('update-')).map(c => c.label);
  assert.deepEqual(updaters, ['update-r1']);
  assert.equal(result.staging.preexisting.length, 1);
  assert.equal(result.staging.new.length, 0);
  assert.equal(result.verdict, 'applied_to_staging');
});

test('intent is absent from update Find and from every review prompt', async () => {
  const update = respondingAgent();
  await run('update', update.agent);
  const find = update.calls.filter(c => c.label.startsWith('find-') && c.label.endsWith('-p1'));
  assert.ok(find.length > 0);
  for (const c of find) assert.ok(!c.prompt.includes('[INTENT]'), c.label);

  const review = intentMismatchAgent(false, ['find-why-driven-p1']);
  await run('review', review.agent);
  assert.ok(review.calls.some(c => c.label.startsWith('refute-')));
  for (const c of review.calls) assert.ok(!c.prompt.includes('[INTENT]'), c.label);
});

test('update refuters receive intent only in Reverify', async () => {
  const { agent, calls } = intentMismatchAgent(false, ['find-why-driven-p1', 'find-why-driven-p2r1']);
  await run('update', agent);
  const refuters = calls.filter(c => c.label.startsWith('refute-'));
  const verify = refuters.filter(c => c.phase === 'Verify');
  const reverify = refuters.filter(c => c.phase === 'Reverify');
  assert.ok(verify.length > 0);
  assert.ok(reverify.length > 0);
  for (const c of verify) assert.ok(!c.prompt.includes('[INTENT]'), c.label);
  for (const c of reverify) assert.ok(c.prompt.includes(`[INTENT]:\n${INTENT}`), c.label);
});
