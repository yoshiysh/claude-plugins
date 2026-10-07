import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { compileSource } from '../../../../workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs';

const source = await readFile(new URL('../../../workflows/review_skill.js', import.meta.url), 'utf8');
const { body, meta } = compileSource(source, []);
const INTENT = 'exercise missing-finder path';
const AUDIT_HEADER = 'Scope: /mock/target\nTarget model: current flagship';

async function run(mode, agent = async () => null, target = { scope: 'full' }, globals = {}, extraArgs = {}) {
  const phases = [];
  const context = createContext({
    args: {
      skillDir: '/mock/skill-creator',
      mode,
      target: { skillPath: '/mock/target', ...target },
      ...(mode === 'audit' ? {} : { uncheckedItems: [] }),
      ...(mode === 'update' ? { intent: INTENT } : {}),
      stagingDir: '/mock/target-workspace/staging',
      promptAuditExpected: false,
      ...extraArgs,
    },
    agent,
    parallel: tasks => Promise.all(tasks.map(task => task())),
    phase: value => phases.push(value),
    log() {},
    ...globals,
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
    return { findings: [], scanned_files: ['SKILL.md'], unreadable: false, unchecked_judgments: [], audit_header: AUDIT_HEADER };
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
    return { findings, scanned_files: ['SKILL.md'], unreadable: false, unchecked_judgments: [], audit_header: AUDIT_HEADER };
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
  assert.equal(result.staging.reverify_scope.excluded_findings.length, 0);
  assert.equal(result.staging.new.length, 1);
  assert.equal(result.verdict, 'needs_human_decision');
  assert.equal(result.stop_reason, 'dried');
});

test('diff scope keeps a finding with present_in_original omitted on an unchanged, unscanned file unresolved', async () => {
  const labels = ['find-why-driven-p2r1', 'find-why-driven-p2r2'];
  const { agent, calls } = intentMismatchAgent(undefined, labels, 'references/untouched.md');
  const { result } = await run('update', agent, { scope: 'diff', diffRef: 'main...HEAD' });
  const updaters = calls.filter(c => c.label.startsWith('update-')).map(c => c.label);
  assert.deepEqual(updaters, ['update-r1', 'update-r2']);
  assert.equal(result.staging.reverify_scope.excluded_findings.length, 0);
  assert.equal(result.staging.new.length, 1);
  assert.equal(result.verdict, 'needs_human_decision');
  assert.equal(result.stop_reason, 'dried');
});

for (const target of [{ scope: 'full' }, { scope: 'diff', diffRef: 'main...HEAD' }]) {
  test(`${target.scope} scope keeps a present-in-original finding on an unchanged file out of refutation and declares it`, async () => {
    const { agent, calls } = reverifyFindingAgent({
      file: 'references/untouched.md',
      location: 'L1',
      claim: 'comment restates what the code does',
      evidence: 'quoted',
      severity: 'major',
      suggested_fix: 'drop the comment',
      present_in_original: true,
    }, ['find-why-driven-p2r1']);
    const { result } = await run('update', agent, target);
    const updaters = calls.filter(c => c.label.startsWith('update-')).map(c => c.label);
    assert.deepEqual(updaters, ['update-r1']);
    assert.equal(calls.filter(c => c.label.startsWith('refute-')).length, 0);
    assert.equal(result.staging.reverify_scope.excluded_findings.length, 1);
    assert.equal(result.staging.new.length, 0);
    assert.equal(result.staging.preexisting.length, 0);
    assert.equal(result.verdict, 'applied_to_staging');
    assert.equal(result.stop_reason, 'resolved');
  });
}

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

function finding(overrides = {}) {
  return {
    file: 'SKILL.md',
    location: 'L1',
    claim: 'claim',
    evidence: 'quoted',
    severity: 'major',
    suggested_fix: 'fix',
    ...overrides,
  };
}

function scriptedAgent({ findingsByLabel = {}, scannedByLabel = {}, votes = () => 'not_refuted' }) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, label: opts.label, phase: opts.phase });
    if (opts.label.startsWith('update-')) {
      return { changed_files: [{ path: 'SKILL.md', reason: 'intent', findings_addressed: [] }], summary: 'updated' };
    }
    if (opts.label.startsWith('refute-')) {
      const verdict = votes(opts.label, opts.phase);
      return verdict === null ? null : { verdict, reason: 'r' };
    }
    return {
      findings: findingsByLabel[opts.label] || [],
      scanned_files: scannedByLabel[opts.label] || ['SKILL.md'],
      unreadable: false,
      unchecked_judgments: [],
      audit_header: AUDIT_HEADER,
    };
  };
  return { agent, calls };
}

test('review sends only REVISE_SEVERITIES findings to refuters and reports minor ones unverified', async () => {
  const { agent, calls } = scriptedAgent({
    findingsByLabel: {
      'find-why-driven-p1': [finding({ claim: 'major one' }), finding({ claim: 'minor one', severity: 'minor' })],
    },
  });
  const { result } = await run('review', agent);
  const refuted = new Set(calls.filter(c => c.label.startsWith('refute-')).map(c => c.label.split('-').slice(1, -1).join('-')));
  assert.deepEqual([...refuted], ['p1-why-driven-1']);
  assert.equal(result.findings.confirmed.length, 1);
  assert.equal(result.findings.reported_minor.length, 1);
  assert.equal(result.findings.reported_minor[0].claim, 'minor one');
  assert.equal(result.findings.reported_minor[0].__dir, undefined);
});

test('review with only minor findings is not clean', async () => {
  const { agent, calls } = scriptedAgent({
    findingsByLabel: { 'find-why-driven-p1': [finding({ severity: 'minor' })] },
  });
  const { result } = await run('review', agent);
  assert.equal(calls.filter(c => c.label.startsWith('refute-')).length, 0);
  assert.equal(result.verdict, 'findings');
  assert.equal(result.stop_reason, null);
});

for (const [name, lead, third, expected, calls3] of [
  ['agreeing not_refuted pair', ['not_refuted', 'not_refuted'], 'refuted', 'confirmed', false],
  ['agreeing refuted pair', ['refuted', 'refuted'], 'not_refuted', 'rejected', false],
  ['split pair resolved by refuting third', ['refuted', 'not_refuted'], 'refuted', 'rejected', true],
  ['split pair resolved by not_refuted third', ['not_refuted', 'refuted'], 'not_refuted', 'confirmed', true],
  ['refuted and unreadable pair', ['refuted', 'unreadable'], 'not_refuted', 'confirmed', true],
  ['refuted and missing pair', ['refuted', null], 'refuted', 'rejected', true],
  ['unreadable and not_refuted pair with unreadable third', ['unreadable', 'not_refuted'], 'unreadable', 'unverified', true],
]) {
  test(`staged refutation: ${name}`, async () => {
    const byPerspective = { existence: lead[0], materiality: lead[1], alternative: third };
    const { agent, calls } = scriptedAgent({
      findingsByLabel: { 'find-why-driven-p1': [finding()] },
      votes: label => byPerspective[label.split('-').at(-1)],
    });
    const { result } = await run('review', agent);
    const perspectives = calls.filter(c => c.label.startsWith('refute-')).map(c => c.label.split('-').at(-1));
    assert.deepEqual(perspectives, calls3 ? ['existence', 'materiality', 'alternative'] : ['existence', 'materiality']);
    for (const bucket of ['confirmed', 'rejected', 'unverified']) {
      assert.equal(result.findings[bucket].length, bucket === expected ? 1 : 0, bucket);
    }
    const entry = result.findings[expected][0];
    assert.deepEqual(Array.from(entry.skipped_perspectives), calls3 ? [] : ['alternative']);
  });
}

test('reverify scope tells each finder its report files and the findings to recheck verbatim', async () => {
  const original = finding({ file: 'references/a.md', claim: 'original claim' });
  const { agent, calls } = scriptedAgent({ findingsByLabel: { 'find-why-driven-p1': [original] } });
  const { result } = await run('update', agent);
  const why = calls.find(c => c.label === 'find-why-driven-p2r1').prompt;
  const loopholes = calls.find(c => c.label === 'find-loopholes-p2r1').prompt;
  assert.match(why, /\[REVERIFY_SCOPE\]:\n\[\n  "SKILL\.md",\n  "references\/a\.md"\n\]/);
  assert.match(why, /\[RECHECK_FINDINGS\]:[\s\S]*"claim": "original claim"/);
  assert.match(loopholes, /\[REVERIFY_SCOPE\]:\n\[\n  "SKILL\.md"\n\]/);
  assert.deepEqual(Array.from(result.staging.reverify_scope.recheck_ids), ['p1-why-driven-1']);
  assert.deepEqual(Array.from(result.staging.reverify_scope.report_files['why-driven']), ['SKILL.md', 'references/a.md']);
});

for (const [scanned, bucket] of [[['SKILL.md'], 'unobserved'], [['SKILL.md', 'references/a.md'], 'resolved']]) {
  test(`original finding absent after reverify is ${bucket} when its file was ${bucket === 'resolved' ? '' : 'not '}scanned`, async () => {
    const { agent } = scriptedAgent({
      findingsByLabel: { 'find-why-driven-p1': [finding({ file: 'references/a.md' })] },
      scannedByLabel: { 'find-why-driven-p2r1': scanned },
    });
    const { result } = await run('update', agent);
    assert.equal(result.staging.unobserved.length, bucket === 'unobserved' ? 1 : 0);
    assert.equal(result.staging.resolved.length, bucket === 'resolved' ? 1 : 0);
  });
}

test('update keeps the Verify-pass minor findings in the result even when Reverify never re-reports them', async () => {
  const { agent } = scriptedAgent({
    findingsByLabel: { 'find-why-driven-p1': [finding({ file: 'references/untouched.md', severity: 'minor' })] },
  });
  const { result } = await run('update', agent);
  assert.equal(result.findings_source, 'after');
  assert.equal(result.findings.reported_minor.length, 0);
  assert.equal(result.findings_before.reported_minor.length, 1);
  assert.equal(result.findings_before.reported_minor[0].file, 'references/untouched.md');
});

test('review leaves findings_before null', async () => {
  const { result } = await run('review', scriptedAgent({}).agent);
  assert.equal(result.findings_before, null);
});

test('original finding re-reported as minor stays remaining instead of resolved', async () => {
  const { agent } = scriptedAgent({
    findingsByLabel: {
      'find-why-driven-p1': [finding({ claim: 'same claim' })],
      'find-why-driven-p2r1': [finding({ claim: 'same claim', severity: 'minor', present_in_original: true })],
    },
  });
  const { result } = await run('update', agent);
  assert.equal(result.staging.resolved.length, 0);
  assert.equal(result.staging.remaining.length, 1);
  assert.equal(result.verdict, 'applied_to_staging');
});

function perRoundAgent(countsByRound, globals) {
  const findingsByLabel = {};
  countsByRound.forEach((count, i) => {
    findingsByLabel[`find-why-driven-p2r${i + 1}`] = Array.from({ length: count }, (_, j) =>
      finding({ claim: `round ${i + 1} finding ${j + 1}`, present_in_original: false }));
  });
  return scriptedAgent({ findingsByLabel });
}

test('stalled: unresolved count not below the best for STALL_ROUNDS rounds stops even when keys keep changing', async () => {
  const { agent, calls } = perRoundAgent([1, 1, 1, 1, 1]);
  const { result } = await run('update', agent);
  const updaters = calls.filter(c => c.label.startsWith('update-')).map(c => c.label);
  assert.deepEqual(updaters, ['update-r1', 'update-r2', 'update-r3']);
  assert.equal(result.verdict, 'needs_human_decision');
  assert.equal(result.stop_reason, 'stalled');
  assert.equal(result.revisions_used, 2);
});

test('stalled: oscillation back to the best count is not progress', async () => {
  const { agent, calls } = perRoundAgent([2, 3, 2, 1, 0]);
  const { result } = await run('update', agent);
  const updaters = calls.filter(c => c.label.startsWith('update-')).map(c => c.label);
  assert.deepEqual(updaters, ['update-r1', 'update-r2', 'update-r3']);
  assert.equal(result.stop_reason, 'stalled');
});

test('strictly decreasing unresolved count keeps revising until resolved', async () => {
  const { agent } = perRoundAgent([3, 2, 1, 0]);
  const { result } = await run('update', agent);
  assert.equal(result.verdict, 'applied_to_staging');
  assert.equal(result.stop_reason, 'resolved');
  assert.equal(result.revisions_used, 3);
});

test('budget below the round threshold stops before the next updater', async () => {
  const { agent, calls } = perRoundAgent([2, 1, 0]);
  const remaining = () => (calls.some(c => c.label === 'update-r1') ? 0 : 1_000_000_000);
  const { result } = await run('update', agent, { scope: 'full' }, { budget: { total: 1_000_000_000, spent: () => 0, remaining } });
  const updaters = calls.filter(c => c.label.startsWith('update-')).map(c => c.label);
  assert.deepEqual(updaters, ['update-r1']);
  assert.equal(result.verdict, 'needs_human_decision');
  assert.equal(result.stop_reason, 'budget');
  assert.equal(result.revisions_used, 0);
  assert.ok(result.staging.new.length > 0);
});

test('budget without a total does not stop the loop', async () => {
  const { agent } = perRoundAgent([2, 1, 0]);
  const { result } = await run('update', agent, { scope: 'full' }, { budget: { total: null, spent: () => 0, remaining: () => Infinity } });
  assert.equal(result.stop_reason, 'resolved');
});

function untouched(overrides = {}) {
  return finding({ file: 'references/x.md', claim: 'x claim', ...overrides });
}

test('a Verify-unverified blocker in an unchanged file is rechecked and refuted again instead of vanishing', async () => {
  const { agent, calls } = scriptedAgent({
    findingsByLabel: {
      'find-why-driven-p1': [untouched({ severity: 'blocker' })],
      'find-why-driven-p2r1': [untouched({ severity: 'blocker', present_in_original: true })],
    },
    scannedByLabel: { 'find-why-driven-p2r1': ['SKILL.md', 'references/x.md'] },
    votes: () => 'unreadable',
  });
  const { result } = await run('update', agent);
  assert.ok(calls.some(c => c.label.startsWith('refute-') && c.phase === 'Reverify'));
  assert.deepEqual(Array.from(result.staging.reverify_scope.recheck_ids), ['p1-why-driven-1']);
  assert.ok(result.staging.reverify_scope.report_files['why-driven'].includes('references/x.md'));
  assert.equal(result.staging.reverify_scope.excluded_findings.length, 0);
  assert.equal(result.findings_before.unverified.length, 1);
  assert.equal(result.verdict, 'needs_human_decision');
  assert.equal(result.stop_reason, 'unverified_blocker');
});

test('a Verify-unverified finding confirmed on recheck is reclassified and re-enters the loop', async () => {
  const { agent, calls } = scriptedAgent({
    findingsByLabel: {
      'find-why-driven-p1': [untouched()],
      'find-why-driven-p2r1': [untouched({ present_in_original: true })],
    },
    votes: (label, phase) => (phase === 'Verify' ? 'unreadable' : 'not_refuted'),
  });
  const { result } = await run('update', agent);
  const updaters = calls.filter(c => c.label.startsWith('update-')).map(c => c.label);
  assert.deepEqual(updaters, ['update-r1', 'update-r2']);
  assert.match(calls.find(c => c.label === 'update-r2').prompt, /\[REVISE_NOTE\][\s\S]*x claim/);
  assert.equal(result.findings_before.unverified.length, 1);
  assert.equal(result.stop_reason, 'resolved');
});

test('a confirmed blocker in an unchanged file stays remaining because its file is in the report scope', async () => {
  const { agent, calls } = scriptedAgent({
    findingsByLabel: {
      'find-why-driven-p1': [untouched({ severity: 'blocker' })],
      'find-why-driven-p2r1': [untouched({ severity: 'blocker', present_in_original: true })],
    },
    scannedByLabel: { 'find-why-driven-p2r2': ['SKILL.md', 'references/x.md'] },
  });
  const { result } = await run('update', agent);
  const updaters = calls.filter(c => c.label.startsWith('update-')).map(c => c.label);
  assert.deepEqual(updaters, ['update-r1', 'update-r2']);
  assert.match(calls.find(c => c.label === 'update-r2').prompt, /\[REVISE_NOTE\][\s\S]*x claim/);
  assert.equal(result.staging.resolved.length, 1);
  assert.equal(result.stop_reason, 'resolved');
});

test('an original finding re-reported but unverified on recheck is still_unverified, unresolved and never resolved', async () => {
  const { agent, calls } = scriptedAgent({
    findingsByLabel: {
      'find-why-driven-p1': [finding()],
      'find-why-driven-p2r1': [finding()],
      'find-why-driven-p2r2': [finding()],
    },
    votes: (label, phase) => (phase === 'Verify' ? 'not_refuted' : 'unreadable'),
  });
  const { result } = await run('update', agent);
  const updaters = calls.filter(c => c.label.startsWith('update-')).map(c => c.label);
  assert.deepEqual(updaters, ['update-r1', 'update-r2']);
  assert.equal(result.staging.resolved.length, 0);
  assert.equal(result.staging.still_unverified.length, 1);
  assert.equal(result.verdict, 'needs_human_decision');
  assert.equal(result.stop_reason, 'dried');
});

test('an original finding re-reported but rejected on recheck is refuted_on_recheck, not resolved', async () => {
  const { agent } = scriptedAgent({
    findingsByLabel: { 'find-why-driven-p1': [finding()], 'find-why-driven-p2r1': [finding()] },
    votes: (label, phase) => (phase === 'Verify' ? 'not_refuted' : 'refuted'),
  });
  const { result } = await run('update', agent);
  assert.equal(result.staging.resolved.length, 0);
  assert.equal(result.staging.refuted_on_recheck.length, 1);
  assert.equal(result.verdict, 'applied_to_staging');
});

test('budget below the round threshold stops before the first updater', async () => {
  const { agent, calls } = perRoundAgent([1]);
  const { result } = await run('update', agent, { scope: 'full' }, { budget: { total: 1000, spent: () => 1000, remaining: () => 0 } });
  assert.equal(calls.filter(c => c.label.startsWith('update-')).length, 0);
  assert.equal(result.stop_reason, 'budget');
  assert.equal(result.revisions_used, 0);
  assert.equal(result.staging, null);
  assert.equal(result.findings_source, 'before');
});

test('budget stop after two rounds counts one re-revision', async () => {
  const { agent, calls } = perRoundAgent([3, 2, 1, 0]);
  const remaining = () => (calls.some(c => c.label === 'update-r2') ? 0 : 1_000_000_000);
  const { result } = await run('update', agent, { scope: 'full' }, { budget: { total: 1_000_000_000, spent: () => 0, remaining } });
  assert.deepEqual(calls.filter(c => c.label.startsWith('update-')).map(c => c.label), ['update-r1', 'update-r2']);
  assert.equal(result.stop_reason, 'budget');
  assert.equal(result.revisions_used, 1);
});

for (const [scanned, bucket, verdict, stop] of [
  [['SKILL.md'], 'unverified_unobserved', 'needs_human_decision', 'unverified_blocker'],
  [['SKILL.md', 'references/x.md'], 'unverified_absent', 'applied_to_staging', 'resolved'],
]) {
  test(`a Verify-unverified blocker not re-reported in Reverify lands in ${bucket}`, async () => {
    const { agent } = scriptedAgent({
      findingsByLabel: { 'find-why-driven-p1': [untouched({ severity: 'blocker' })] },
      scannedByLabel: { 'find-why-driven-p2r1': scanned },
      votes: (label, phase) => (phase === 'Verify' ? 'unreadable' : 'not_refuted'),
    });
    const { result } = await run('update', agent);
    for (const b of ['unverified_unobserved', 'unverified_absent']) {
      assert.equal(result.staging[b].length, b === bucket ? 1 : 0, b);
    }
    assert.equal(result.verdict, verdict);
    assert.equal(result.stop_reason, stop);
  });
}

for (const [file, presentInOriginal, verdict, stop] of [
  ['references/x.md', true, 'needs_human_decision', 'contested_blocker'],
  ['SKILL.md', true, 'needs_human_decision', 'contested_blocker'],
  ['SKILL.md', false, 'applied_to_staging', 'resolved'],
]) {
  test(`an original blocker refuted on recheck in ${file} (present_in_original ${presentInOriginal}) ends ${stop}`, async () => {
    const original = finding({ file, claim: 'blocker claim', severity: 'blocker' });
    const { agent } = scriptedAgent({
      findingsByLabel: {
        'find-why-driven-p1': [original],
        'find-why-driven-p2r1': [{ ...original, present_in_original: presentInOriginal }],
      },
      votes: (label, phase) => (phase === 'Verify' ? 'not_refuted' : 'refuted'),
    });
    const { result } = await run('update', agent);
    assert.equal(result.staging.refuted_on_recheck.length, 1);
    assert.equal(result.verdict, verdict);
    assert.equal(result.stop_reason, stop);
  });
}

test('REVISE_NOTE carries only the fields the updater needs', async () => {
  const { agent, calls } = perRoundAgent([1, 0]);
  await run('update', agent);
  const prompt = calls.find(c => c.label === 'update-r2').prompt;
  const note = prompt.slice(prompt.indexOf('[REVISE_NOTE]'));
  assert.match(note, /"suggested_fix"/);
  assert.doesNotMatch(note, /"votes"|"valid_votes"|"skipped_perspectives"/);
});

for (const [file, presentInOriginal, verdict, stop] of [
  ['references/x.md', true, 'needs_human_decision', 'contested_blocker'],
  ['SKILL.md', true, 'needs_human_decision', 'contested_blocker'],
  ['SKILL.md', false, 'applied_to_staging', 'resolved'],
]) {
  test(`an original blocker downgraded to minor on recheck in ${file} (present_in_original ${presentInOriginal}) ends ${stop}`, async () => {
    const original = finding({ file, claim: 'blocker claim', severity: 'blocker' });
    const { agent, calls } = scriptedAgent({
      findingsByLabel: {
        'find-why-driven-p1': [original],
        'find-why-driven-p2r1': [{ ...original, severity: 'minor', present_in_original: presentInOriginal }],
      },
    });
    const { result } = await run('update', agent);
    assert.equal(calls.filter(c => c.label.startsWith('refute-') && c.phase === 'Reverify').length, 0);
    assert.equal(result.staging.remaining.length, 1);
    assert.equal(result.verdict, verdict);
    assert.equal(result.stop_reason, stop);
  });
}

test('an original major re-reported as blocker and refuted in an unchanged file is not contested by its recheck severity', async () => {
  const original = finding({ file: 'references/x.md', claim: 'major claim', severity: 'major' });
  const { agent } = scriptedAgent({
    findingsByLabel: {
      'find-why-driven-p1': [original],
      'find-why-driven-p2r1': [{ ...original, severity: 'blocker', present_in_original: true }],
    },
    votes: (label, phase) => (phase === 'Verify' ? 'not_refuted' : 'refuted'),
  });
  const { result } = await run('update', agent);
  assert.equal(result.staging.refuted_on_recheck.length, 1);
  assert.equal(result.stop_reason, 'resolved');
});

function optsRecordingAgent(byLabel = {}) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, opts });
    if (byLabel[opts.label]) return byLabel[opts.label];
    if (opts.label.startsWith('update-')) {
      return { changed_files: [{ path: 'SKILL.md', reason: 'intent', findings_addressed: [] }], summary: 'updated' };
    }
    if (opts.label.startsWith('refute-')) return { verdict: 'not_refuted', reason: 'holds' };
    return { findings: [], scanned_files: ['SKILL.md'], unreadable: false, audit_header: AUDIT_HEADER };
  };
  return { agent, calls };
}

test('every agent call sets model and effort, and the meta phase model matches the callsites', async () => {
  const { agent, calls } = optsRecordingAgent({
    'find-why-driven-p1': {
      findings: [finding()], scanned_files: ['SKILL.md'], unreadable: false,
    },
  });
  await run('update', agent);
  const declared = Object.fromEntries(meta.phases.filter(p => p.model).map(p => [p.title, p.model]));
  const used = {};
  for (const { opts } of calls) {
    assert.ok(opts.model && opts.effort, `${opts.label}: model and effort must be explicit`);
    (used[opts.phase] ??= new Set()).add(opts.model);
  }
  for (const [title, models] of Object.entries(used)) {
    assert.deepEqual([...models], [declared[title]], `${title}: meta.phases model differs from the callsites`);
  }
});

test('fan-out siblings share model, effort and schema so they can share the prompt cache prefix', async () => {
  const { agent, calls } = optsRecordingAgent({
    'find-why-driven-p1': { findings: [finding()], scanned_files: ['SKILL.md'], unreadable: false },
  });
  await run('review', agent);
  for (const prefix of ['find-', 'refute-']) {
    const siblings = calls.filter(c => c.opts.label.startsWith(prefix)).map(c => c.opts);
    assert.ok(siblings.length > 1, prefix);
    for (const o of siblings) {
      assert.equal(o.model, siblings[0].model);
      assert.equal(o.effort, siblings[0].effort);
      assert.equal(o.schema, siblings[0].schema);
    }
  }
});

test('review runs the prompt-audit lens and declares it skipped when the skill is unavailable', async () => {
  const { agent, calls } = optsRecordingAgent({
    'find-prompt-audit-p1': { findings: [], scanned_files: [], unreadable: false, unavailable: true, note: 'no Skill tool' },
  });
  const { result } = await run('review', agent);
  assert.ok(calls.some(c => c.opts.label === 'find-prompt-audit-p1'));
  assert.equal(result.verdict, 'clean_except_unavailable');
  assert.equal(result.by_category.before['prompt-audit'], 'unavailable');
  assert.deepEqual(Array.from(result.skipped_unavailable.before), ['prompt-audit']);
  assert.equal(result.skipped_unavailable.after, null);
});

test('only the prompt-audit lens may report unavailable; any other lens doing so is missing', async () => {
  const { agent } = optsRecordingAgent({
    'find-why-driven-p1': { findings: [], scanned_files: ['SKILL.md'], unreadable: false, unavailable: true },
  });
  const { result } = await run('review', agent);
  assert.equal(result.verdict, 'review_incomplete');
  assert.equal(result.by_category.before['why-driven'], null);
  assert.deepEqual(Array.from(result.skipped_unavailable.before), []);
});

test('a prompt-audit result without the audit header is treated as missing', async () => {
  const { agent } = optsRecordingAgent({
    'find-prompt-audit-p1': { findings: [], scanned_files: ['SKILL.md'], unreadable: false },
  });
  const { result } = await run('review', agent);
  assert.equal(result.verdict, 'review_incomplete');
  assert.equal(result.by_category.before['prompt-audit'], null);
});

test('prompt-audit confidence decides severity; Low and flag never become findings', async () => {
  const audit = (claim, audit_confidence, audit_action = 'rewrite') =>
    finding({ claim, severity: 'blocker', audit_confidence, audit_action });
  const { agent, calls } = optsRecordingAgent({
    'find-prompt-audit-p1': {
      findings: [audit('high one', 'High'), audit('medium one', 'Medium'), audit('low one', 'Low'),
        audit('flagged one', 'High', 'flag'), finding({ claim: 'no confidence' })],
      scanned_files: ['SKILL.md'], unreadable: false, audit_header: AUDIT_HEADER,
    },
  });
  const { result } = await run('review', agent);
  assert.deepEqual(JSON.parse(JSON.stringify(result.findings.confirmed.map(f => [f.claim, f.severity]))), [['high one', 'major']]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.findings.reported_minor.map(f => [f.claim, f.severity]))), [['medium one', 'minor']]);
  const refuted = calls.filter(c => c.opts.label.startsWith('refute-')).map(c => c.opts.label);
  assert.ok(refuted.every(l => l.startsWith('refute-p1-prompt-audit-1-')));
});

test('audit mode runs only the prompt-audit lens and never writes', async () => {
  const { agent, calls } = optsRecordingAgent();
  const { result, phases } = await run('audit', agent);
  assert.deepEqual(calls.map(c => c.opts.label), ['find-prompt-audit-p1']);
  assert.deepEqual(phases, ['Find', 'Verify']);
  assert.equal(result.verdict, 'clean');
  assert.equal(result.unchecked_failures, null);
  assert.equal(result.staging, null);
  assert.deepEqual(Object.keys(result.by_category.before), ['prompt-audit']);
});

test('audit mode reports findings, and a missing prompt-audit is review_incomplete when expected', async () => {
  const withFinding = optsRecordingAgent({
    'find-prompt-audit-p1': {
      findings: [finding({ audit_confidence: 'High', audit_action: 'remove' })],
      scanned_files: ['SKILL.md'], unreadable: false, audit_header: AUDIT_HEADER,
    },
  });
  assert.equal((await run('audit', withFinding.agent)).result.verdict, 'findings');
  const missingSkill = optsRecordingAgent({
    'find-prompt-audit-p1': { findings: [], scanned_files: [], unreadable: false, unavailable: true },
  });
  assert.equal((await run('audit', missingSkill.agent, { scope: 'full' }, {}, { promptAuditExpected: true })).result.verdict,
    'review_incomplete');
});

test('audit mode rejects uncheckedItems instead of silently ignoring them', async () => {
  await assert.rejects(run('audit', async () => null, { scope: 'full' }, {}, { uncheckedItems: [] }), /uncheckedItems/);
});

test('update with the prompt-audit skill unavailable still completes a receipt that declares the skip', async () => {
  const unavailable = { findings: [], scanned_files: [], unreadable: false, unavailable: true };
  const { agent } = optsRecordingAgent({
    'find-prompt-audit-p1': unavailable,
    'find-prompt-audit-p2r1': unavailable,
  });
  const { result } = await run('update', agent);
  assert.equal(result.verdict, 'applied_to_staging');
  assert.deepEqual(Array.from(result.reverify_missing), []);
  assert.equal(result.by_category.after['prompt-audit'], 'unavailable');
  assert.equal(result.reverify_receipt.completed, true);
  assert.equal(result.reverify_receipt.by_category['prompt-audit'], undefined);
  assert.ok(Object.values(result.reverify_receipt.by_category).every(Number.isSafeInteger));
  assert.deepEqual(Array.from(result.reverify_receipt.skipped_unavailable), ['prompt-audit']);
  assert.deepEqual(Array.from(result.skipped_unavailable.after), ['prompt-audit']);
});

test('an owner that omits unchecked_judgments turns every delegated id into a failure', async () => {
  const { agent } = optsRecordingAgent();
  const { result } = await run('review', agent, { scope: 'full' }, {}, {
    uncheckedItems: [{ id: 'verifier-path', item: 'a' }, { id: 'description-triggers', item: 'b' }],
  });
  assert.deepEqual(Array.from(result.unchecked_failures, f => f.id).sort(),
    ['p1-unchecked-description-triggers', 'p1-unchecked-verifier-path']);
  assert.equal(result.verdict, 'findings');
});

for (const [name, reReport] of [
  ['without a confidence', {}],
  ['at Low confidence', { audit_confidence: 'Low', audit_action: 'rewrite' }],
]) {
  test(`a prompt-audit finding re-reported on recheck ${name} stays unresolved`, async () => {
    const original = finding({ file: 'references/x.md', claim: 'dated emphasis', audit_confidence: 'High', audit_action: 'rewrite' });
    const again = { ...finding({ file: 'references/x.md', claim: 'dated emphasis' }), ...reReport };
    const scanned = { findings: [again], scanned_files: ['SKILL.md', 'references/x.md'], unreadable: false, audit_header: AUDIT_HEADER };
    const { agent } = optsRecordingAgent({
      'find-prompt-audit-p1': { findings: [original], scanned_files: ['references/x.md'], unreadable: false, audit_header: AUDIT_HEADER },
      'find-prompt-audit-p2r1': scanned,
      'find-prompt-audit-p2r2': scanned,
    });
    const { result } = await run('update', agent);
    assert.equal(result.staging.resolved.length, 0);
    assert.deepEqual(Array.from(result.staging.remaining, f => f.claim), ['dated emphasis']);
    assert.notEqual(result.verdict, 'applied_to_staging');
  });
}

const auditFound = (findings, extra = {}) =>
  ({ findings, scanned_files: ['SKILL.md', 'references/x.md'], unreadable: false, audit_header: AUDIT_HEADER, ...extra });
const auditUnavailable = { findings: [], scanned_files: [], unreadable: false, unavailable: true };
const highAudit = () => finding({ file: 'references/x.md', claim: 'dated emphasis', audit_confidence: 'High', audit_action: 'rewrite' });

test('prompt-audit that ran in Find but reports unavailable in Reverify is missing, not skipped', async () => {
  const { agent } = optsRecordingAgent({
    'find-prompt-audit-p1': auditFound([highAudit()]),
    'find-prompt-audit-p2r1': auditUnavailable,
    'find-prompt-audit-p2r1-retry': auditUnavailable,
  });
  const { result } = await run('update', agent);
  assert.equal(result.verdict, 'reverify_incomplete');
  assert.deepEqual(Array.from(result.reverify_missing), ['prompt-audit']);
  assert.equal(result.reverify_receipt.completed, false);
});

test('prompt-audit that is missing in Reverify and unavailable on retry is still missing', async () => {
  const calls = [];
  const base = optsRecordingAgent({ 'find-prompt-audit-p1': auditFound([]), 'find-prompt-audit-p2r1-retry': auditUnavailable });
  const agent = async (prompt, opts) => {
    calls.push(opts.label);
    if (opts.label === 'find-prompt-audit-p2r1') return null;
    return base.agent(prompt, opts);
  };
  const { result } = await run('update', agent);
  assert.ok(calls.includes('find-prompt-audit-p2r1-retry'));
  assert.equal(result.verdict, 'reverify_incomplete');
  assert.deepEqual(Array.from(result.reverify_missing), ['prompt-audit']);
});

test('when prompt-audit is expected, unavailable is missing in every mode', async () => {
  const { agent } = optsRecordingAgent({ 'find-prompt-audit-p1': auditUnavailable });
  const expected = { promptAuditExpected: true };
  assert.equal((await run('review', agent, { scope: 'full' }, {}, expected)).result.verdict, 'review_incomplete');
  assert.equal((await run('audit', agent, { scope: 'full' }, {}, expected)).result.verdict, 'review_incomplete');
  assert.equal((await run('update', agent, { scope: 'full' }, {}, expected)).result.verdict, 'review_incomplete');
});

test('promptAuditExpected must be passed explicitly', async () => {
  await assert.rejects(run('review', async () => null, { scope: 'full' }, {}, { promptAuditExpected: undefined }),
    /promptAuditExpected/);
});

for (const [name, reverify] of [
  ['only in the free-text note', auditFound([], { note: 'flag/Low: references/x.md:L1 — dated emphasis' })],
  ['in declared_only at Low', auditFound([], { declared_only: [{ file: 'references/x.md', claim: 'dated emphasis', audit_confidence: 'Low', audit_action: 'rewrite' }] })],
  ['at Medium confidence', auditFound([{ ...highAudit(), audit_confidence: 'Medium' }])],
]) {
  test(`an unedited prompt-audit finding re-reported ${name} is not resolved`, async () => {
    const { agent } = optsRecordingAgent({
      'find-prompt-audit-p1': auditFound([highAudit()]),
      'find-prompt-audit-p2r1': reverify,
      'find-prompt-audit-p2r2': reverify,
    });
    const { result } = await run('update', agent);
    assert.equal(result.staging.resolved.length, 0);
    assert.deepEqual(Array.from(result.staging.remaining, f => f.claim), ['dated emphasis']);
    assert.ok(Array.from(result.staging.remaining).every(f => f.severity === 'major'));
    assert.notEqual(result.verdict, 'applied_to_staging');
  });
}

test('prompt-audit items outside the mapping are returned in declared_only and findings keep their confidence', async () => {
  const { agent } = optsRecordingAgent({
    'find-prompt-audit-p1': auditFound(
      [highAudit(), finding({ claim: 'low in findings', audit_confidence: 'Low', audit_action: 'rewrite' })],
      { declared_only: [{ file: 'SKILL.md', location: 'L9', claim: 'flagged', audit_confidence: 'High', audit_action: 'flag' }] },
    ),
  });
  const { result } = await run('review', agent);
  assert.deepEqual(JSON.parse(JSON.stringify(result.declared_only.before)), [
    { file: 'SKILL.md', location: 'L1', claim: 'low in findings', audit_confidence: 'Low', audit_action: 'rewrite' },
    { file: 'SKILL.md', location: 'L9', claim: 'flagged', audit_confidence: 'High', audit_action: 'flag' },
  ]);
  assert.equal(result.declared_only.after, null);
  assert.equal(result.findings.confirmed[0].audit_confidence, 'High');
  assert.equal(result.findings.confirmed[0].audit_action, 'rewrite');
});

test('an updater that throws ends update_failed instead of aborting the run', async () => {
  const base = optsRecordingAgent();
  const agent = async (prompt, opts) => {
    if (opts.label.startsWith('update-')) throw new Error('structured output retries exhausted');
    return base.agent(prompt, opts);
  };
  const { result } = await run('update', agent);
  assert.equal(result.verdict, 'update_failed');
  assert.equal(result.staging.dir, '/mock/target-workspace/staging');
});

// 単体テストの parallel は Promise.all（runner と同じく catch しない）なので、throw が run を落とさないことを確かめられる。
test('a finder that throws in Reverify degrades to missing and keeps the report', async () => {
  const base = optsRecordingAgent();
  const agent = async (prompt, opts) => {
    if (opts.label.startsWith('find-why-driven-p2r1')) throw new Error('structured output retries exhausted');
    return base.agent(prompt, opts);
  };
  const { result } = await run('update', agent);
  assert.equal(result.verdict, 'reverify_incomplete');
  assert.deepEqual(Array.from(result.reverify_missing), ['why-driven']);
  assert.equal(result.staging.dir, '/mock/target-workspace/staging');
});

test('a refuter that throws degrades to an unverified finding', async () => {
  const base = optsRecordingAgent({ 'find-why-driven-p1': auditFound([finding()]) });
  const agent = async (prompt, opts) => {
    if (opts.label.startsWith('refute-')) throw new Error('budget exhausted');
    return base.agent(prompt, opts);
  };
  const { result } = await run('review', agent);
  assert.equal(result.findings.unverified.length, 1);
  assert.equal(result.findings.confirmed.length, 0);
  assert.equal(result.verdict, 'findings');
});
