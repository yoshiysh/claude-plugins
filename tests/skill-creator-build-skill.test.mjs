import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { compileSource } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs';

const source = await readFile(new URL('../plugins/skill-creator/workflows/build_skill.js', import.meta.url), 'utf8');
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
// native host は agent() / parallel() の境界で値を JSON 往復させる（Map などは空の object に化ける）。
// 模擬側でも同じ往復をかけ、境界を越える値が JSON で表せない形になっていれば全テストで落ちるようにする。
const roundTrip = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

async function run(agent, extraArgs = {}) {
  const context = createContext({
    args: { skillDir: '/mock/skill-creator', requirements: 'req', taskType: 'procedure', uncheckedItems: [], ...extraArgs },
    agent: async (prompt, opts) => roundTrip(await agent(prompt, opts)),
    parallel: tasks => Promise.all(tasks.map(task => Promise.resolve(task()).then(roundTrip))),
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

const UNCHECKED = [
  { id: 'verifier-path', item: 'a', requires_measurement: false },
  { id: 'description-triggers', item: 'b', requires_measurement: true },
];

const WIN = { assertions: [{ text: 'a', with_skill: { result: 'pass', evidence: 'e' }, baseline: { result: 'fail', evidence: 'e' } }] };

function withReview(review, grade = WIN) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, label: opts.label });
    if (opts.label.startsWith('review-')) return { criteria_checks: [], trigger_checks: [], failed: [], report: 'r', ...review };
    if (opts.label.startsWith('grade-')) return { eval_id: opts.label, ...grade };
    return respond(opts.label);
  };
  return { agent, calls };
}

for (const [name, judgments] of [
  ['judged unknown', [{ id: 'verifier-path', verdict: 'pass', evidence: 'e' }, { id: 'description-triggers', verdict: 'unknown', evidence: 'needs evals' }]],
  ['not judged at all', [{ id: 'verifier-path', verdict: 'pass', evidence: 'e' }]],
]) {
  test(`a measurement-only item ${name} ends pending_measurement without starting a revision`, async () => {
    const { agent, calls } = withReview({ unchecked_judgments: judgments });
    const result = await run(agent, { uncheckedItems: UNCHECKED });
    assert.equal(result.verdict, 'pending_measurement');
    assert.deepEqual(Array.from(result.pending_measurement), ['description-triggers']);
    assert.equal(result.final.passed, false);
    assert.deepEqual(Array.from(result.final.review_failures), []);
    assert.equal(calls.filter(c => c.label.startsWith('write-revise-')).length, 0);
  });
}

test('a revisable delegated failure still revises, and the writer is not asked to fix the measurement item', async () => {
  const { agent, calls } = withReview({ unchecked_judgments: [
    { id: 'verifier-path', verdict: 'fail', evidence: 'no verifier' },
    { id: 'description-triggers', verdict: 'unknown', evidence: 'needs evals' },
  ] });
  const result = await run(agent, { uncheckedItems: UNCHECKED });
  const revise = calls.find(c => c.label === 'write-revise-1');
  assert.ok(revise);
  assert.match(revise.prompt, /verifier-path/);
  assert.doesNotMatch(revise.prompt, /description-triggers/);
  assert.equal(result.verdict, 'needs_human_decision');
});

test('a delta below the threshold revises even when only a measurement item is otherwise unmet', async () => {
  const tie = { assertions: [{ text: 'a', with_skill: { result: 'pass', evidence: 'e' }, baseline: { result: 'pass', evidence: 'e' } }] };
  const { agent, calls } = withReview({ unchecked_judgments: [
    { id: 'verifier-path', verdict: 'pass', evidence: 'e' },
    { id: 'description-triggers', verdict: 'unknown', evidence: 'needs evals' },
  ] }, tie);
  const result = await run(agent, { uncheckedItems: UNCHECKED });
  assert.ok(calls.some(c => c.label === 'write-revise-1'));
  assert.equal(result.verdict, 'needs_human_decision');
});

test('uncheckedItems without a boolean requires_measurement are rejected', async () => {
  await assert.rejects(run(async (p, o) => respond(o.label), { uncheckedItems: [{ id: 'x', item: 'y' }] }), /requires_measurement/);
});

// 片側だけが環境を探索すると delta が定義の差ではなく探索量の差を測るので、両側に同じ境界を渡す。
test('with_skill and baseline executors receive the same boundary that forbids exploring the environment', async () => {
  const calls = [];
  await run(async (prompt, opts) => { calls.push({ prompt, label: opts.label }); return respond(opts.label); });
  const boundary = (prompt) => prompt.slice(prompt.indexOf('# 境界'), prompt.indexOf('比べる両方の回答に同じ文面でかけてある。'));
  const executors = calls.filter(c => /^(with_skill|baseline)-.*-i1$/.test(c.label));
  assert.equal(executors.length, CASES.length * 2);
  const blocks = new Set(executors.map(c => boundary(c.prompt)));
  assert.equal(blocks.size, 1);
  const [block] = blocks;
  assert.match(block, /Read・Grep・Glob・コマンドの実行/);
  assert.doesNotMatch(block, /通常どおり行ってよい/);
});

test('passed still needs every delegated item, including measurement ones, to pass', async () => {
  const { agent } = withReview({ unchecked_judgments: UNCHECKED.map(({ id }) => ({ id, verdict: 'pass', evidence: 'e' })) });
  const result = await run(agent, { uncheckedItems: UNCHECKED });
  assert.equal(result.verdict, 'passed');
  assert.deepEqual(Array.from(result.pending_measurement), []);
});

test('a round without a reviewer reports pending_measurement as not judged (null), not as nothing pending', async () => {
  const result = await run(async (prompt, opts) => (opts.label.startsWith('review-') ? null : respond(opts.label)),
    { uncheckedItems: UNCHECKED });
  assert.equal(result.verdict, 'evaluation_incomplete');
  assert.equal(result.final.pending_measurement, null);
  assert.equal(result.pending_measurement, null);
});

// 評価の回答者は環境を読まないので、環境の状態を要する assertion は両側で落ちて delta を縮める。
test('the tester is told to write assertions judged from the response text alone, and executors not to run what the definition orders', async () => {
  const calls = [];
  await run(async (prompt, opts) => { calls.push({ prompt, label: opts.label }); return respond(opts.label); });
  assert.match(calls.find(c => c.label === 'generate-tests').prompt, /応答の文面だけから判定できる/);
  for (const c of calls.filter(c => /^(with_skill|baseline)-/.test(c.label))) {
    assert.match(c.prompt, /スキル定義が Read・コマンド・ツールの実行を指示していても実行せず/, c.label);
  }
});
