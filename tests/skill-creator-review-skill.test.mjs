import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { compileSource } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs';

const source = await readFile(new URL('../plugins/skill-creator/workflows/review_skill.js', import.meta.url), 'utf8');
const finderRole = await readFile(new URL('../plugins/skill-creator/skills/skill-creator-best-practices/agents/finder.md', import.meta.url), 'utf8');
const refuterRole = await readFile(new URL('../plugins/skill-creator/skills/skill-creator-best-practices/agents/refuter.md', import.meta.url), 'utf8');
const { body, meta } = compileSource(source, []);
const INTENT = 'exercise missing-finder path';
const AUDIT_HEADER = 'Scope: /mock/target\nTarget model: current flagship';

// refuter は指摘の束を [FINDINGS] で受け取り、id ごとの票を返す。null の票は返答から外す（欠測）。
function batchIds(prompt) {
  return JSON.parse(prompt.slice(prompt.indexOf('[FINDINGS]:\n') + '[FINDINGS]:\n'.length)).map(f => f.id);
}

function batchReply(prompt, verdictFor) {
  const verdicts = [];
  for (const id of batchIds(prompt)) {
    const verdict = verdictFor(id);
    if (verdict !== null) verdicts.push({ id, verdict, reason: 'r' });
  }
  return { verdicts };
}

// native host は agent() / parallel() の境界で値を JSON 往復させる（Map などは空の object に化ける）。
// 模擬側でも同じ往復をかけ、境界を越える値が JSON で表せない形になっていれば全テストで落ちるようにする。
const roundTrip = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

async function run(mode, agent = async () => null, target = { scope: 'full' }, globals = {}, extraArgs = {}) {
  const phases = [];
  const scope = target.scope || 'full';
  const diffRef = target.diffRef || null;
  const context = createContext({
    args: {
      skillDir: '/mock/skill-creator',
      mode,
      target: { skillPath: '/mock/target', ...target },
      snapshot: {
        version: 1,
        status: 'ready',
        scope,
        targetRoot: '/mock/target',
        snapshotRoot: '/mock/snapshot',
        snapshotDir: '/mock/snapshot/tree',
        manifestPath: '/mock/snapshot/manifest.json',
        manifestSha256: 'a'.repeat(64),
        evidencePackPath: '/mock/snapshot/evidence-pack.txt',
        evidencePackSha256: 'c'.repeat(64),
        receiptPath: '/mock/snapshot/receipt.json',
        diffRef,
        diffPath: scope === 'diff' ? '/mock/snapshot/diff.patch' : null,
        changedPathsPath: scope === 'diff' ? '/mock/snapshot/changed-paths.json' : null,
        diffSha256: scope === 'diff' ? 'b'.repeat(64) : null,
        changedPaths: scope === 'diff' ? ['SKILL.md', 'references/untouched.md'] : [],
      },
      ...(mode === 'audit' ? {} : { uncheckedItems: [] }),
      ...(mode === 'update' ? { intent: INTENT } : {}),
      stagingDir: '/mock/target-workspace/staging',
      promptAuditExpected: false,
      ...extraArgs,
    },
    agent: async (prompt, opts) => roundTrip(await agent(prompt, opts)),
    parallel: tasks => Promise.all(tasks.map(task => Promise.resolve(task()).then(roundTrip))),
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

function respondingAgent(updaterResult = {
  changed_files: [{ path: 'SKILL.md', reason: 'intent', findings_addressed: [] }], out_of_scope_changes: [], summary: 'updated',
}) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, label: opts.label });
    if (opts.label.startsWith('update-')) return updaterResult;
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

test('updater paths are normalized once so reverify and the returned changed_files agree', async () => {
  const { agent } = respondingAgent({
    changed_files: [{ path: './SKILL.md', reason: 'intent', findings_addressed: ['intent'] }],
    out_of_scope_changes: [], summary: 'updated',
  });
  const { result } = await run('update', agent);
  assert.equal(result.staging.changed_files[0].path, 'SKILL.md');
  assert.deepEqual(Array.from(result.staging.reverify_scope.changed_files), ['SKILL.md']);
});

test('updater out_of_scope_changes reach the returned staging', async () => {
  const outOfScope = [{ kind: 'outside_skill', path: 'plugins/skill-creator/workflows/review_skill.js', change: 'add a field' }];
  const { agent } = respondingAgent({
    changed_files: [{ path: 'SKILL.md', reason: 'intent', findings_addressed: ['intent'] }],
    out_of_scope_changes: outOfScope, summary: 'updated',
  });
  const { result } = await run('update', agent);
  assert.deepEqual(JSON.parse(JSON.stringify(result.staging.out_of_scope_changes)), outOfScope);
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
      return { changed_files: [{ path: 'SKILL.md', reason: 'intent', findings_addressed: [] }], out_of_scope_changes: [], summary: 'updated' };
    }
    if (opts.label.startsWith('refute-')) return batchReply(prompt, () => 'not_refuted');
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

test('diff review fails closed when a finder reports a file outside the frozen changed-path list', async () => {
  const findingOutsideDiff = finding({ file: 'references/not-changed.md', claim: 'outside frozen diff' });
  const { agent } = optsRecordingAgent({ 'find-why-driven-p1': { findings: [findingOutsideDiff], scanned_files: [], unreadable: false } });
  const { result } = await run('review', agent, { scope: 'diff', diffRef: 'main...HEAD' });
  assert.equal(result.verdict, 'review_incomplete');
  assert.equal(result.by_category.before['why-driven'], null);
});

test('source Find and Verify agents receive only the frozen snapshot target', async () => {
  const { agent, calls } = reverifyFindingAgent({
    file: 'SKILL.md', location: 'L1', claim: 'specific issue', evidence: 'quoted', severity: 'major', suggested_fix: 'fix',
  }, ['find-why-driven-p1']);
  await run('review', agent);
  const sourceCalls = calls.filter(c => c.phase === 'Find' || c.phase === 'Verify');
  assert.ok(sourceCalls.length > 0);
  for (const c of sourceCalls) {
    assert.ok(c.prompt.includes('[TARGET_DIR]: /mock/snapshot/tree'), c.label);
    assert.ok(c.prompt.includes('frozen, read-only review snapshot'), c.label);
    assert.ok(!c.prompt.includes('[TARGET_DIR]: /mock/target\n'), c.label);
  }
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

function scriptedAgent({ findingsByLabel = {}, scannedByLabel = {}, votes = () => 'not_refuted', outOfScopeByLabel = {} }) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, label: opts.label, phase: opts.phase });
    if (opts.label.startsWith('update-')) {
      if (outOfScopeByLabel[opts.label] === null) return null;
      return { changed_files: [{ path: 'SKILL.md', reason: 'intent', findings_addressed: [] }],
        out_of_scope_changes: outOfScopeByLabel[opts.label] || [], summary: 'updated' };
    }
    if (opts.label.startsWith('refute-')) {
      const verdict = votes(opts.label, opts.phase);
      return verdict === null ? null : batchReply(prompt, () => verdict);
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
  const refuted = new Set(calls.filter(c => c.label.startsWith('refute-')).flatMap(c => batchIds(c.prompt)));
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

// 段: major 以下は materiality の 1 体で始め、not_refuted なら確定。それ以外は existence と alternative を足して
// 全観点の過半数で決める。blocker は materiality と existence の 2 体で始め、一致しなければ alternative を足す。
for (const [name, severity, votes, expected, calls, expectedMissing = []] of [
  ['major settled by one not_refuted vote', 'major', { materiality: 'not_refuted' }, 'confirmed', ['materiality']],
  ['major refuted once then by majority', 'major', { materiality: 'refuted', existence: 'refuted', alternative: 'not_refuted' }, 'rejected', ['materiality', 'existence', 'alternative']],
  ['major refuted once but upheld by the others', 'major', { materiality: 'refuted', existence: 'not_refuted', alternative: 'not_refuted' }, 'confirmed', ['materiality', 'existence', 'alternative']],
  ['major with unreadable first vote upheld by the others', 'major', { materiality: 'unreadable', existence: 'not_refuted', alternative: 'not_refuted' }, 'confirmed', ['materiality', 'existence', 'alternative'], ['materiality']],
  ['major with missing first vote refuted by the others', 'major', { materiality: null, existence: 'refuted', alternative: 'refuted' }, 'rejected', ['materiality', 'existence', 'alternative'], ['materiality']],
  ['major split with an unreadable third stays unverified', 'major', { materiality: 'refuted', existence: 'not_refuted', alternative: 'unreadable' }, 'unverified', ['materiality', 'existence', 'alternative'], ['alternative']],
  ['major refuted once with the rest missing stays unverified', 'major', { materiality: 'refuted', existence: null, alternative: null }, 'unverified', ['materiality', 'existence', 'alternative'], ['existence', 'alternative']],
  ['blocker settled by an agreeing not_refuted pair', 'blocker', { materiality: 'not_refuted', existence: 'not_refuted' }, 'confirmed', ['materiality', 'existence']],
  ['blocker settled by an agreeing refuted pair', 'blocker', { materiality: 'refuted', existence: 'refuted' }, 'rejected', ['materiality', 'existence']],
  ['blocker split pair resolved by a refuting third', 'blocker', { materiality: 'not_refuted', existence: 'refuted', alternative: 'refuted' }, 'rejected', ['materiality', 'existence', 'alternative']],
  ['blocker with unreadable second vote upheld by the third', 'blocker', { materiality: 'not_refuted', existence: 'unreadable', alternative: 'not_refuted' }, 'confirmed', ['materiality', 'existence', 'alternative'], ['existence']],
  ['blocker with unreadable first vote upheld by the others', 'blocker', { materiality: 'unreadable', existence: 'not_refuted', alternative: 'not_refuted' }, 'confirmed', ['materiality', 'existence', 'alternative'], ['materiality']],
  ['blocker with missing first vote refuted by the others', 'blocker', { materiality: null, existence: 'refuted', alternative: 'refuted' }, 'rejected', ['materiality', 'existence', 'alternative'], ['materiality']],
  ['blocker split pair with a missing third stays unverified', 'blocker', { materiality: 'not_refuted', existence: 'refuted', alternative: null }, 'unverified', ['materiality', 'existence', 'alternative'], ['alternative']],
]) {
  test(`staged refutation: ${name}`, async () => {
    const { agent, calls: made } = scriptedAgent({
      findingsByLabel: { 'find-why-driven-p1': [finding({ severity })] },
      votes: label => votes[label.split('-').at(-1)] ?? null,
    });
    const { result } = await run('review', agent);
    const perspectives = made.filter(c => c.label.startsWith('refute-')).map(c => c.label.split('-').at(-1));
    assert.deepEqual(perspectives, calls);
    for (const bucket of ['confirmed', 'rejected', 'unverified']) {
      assert.equal(result.findings[bucket].length, bucket === expected ? 1 : 0, bucket);
    }
    const entry = result.findings[expected][0];
    assert.deepEqual(Array.from(entry.skipped_perspectives), ['materiality', 'existence', 'alternative'].filter(p => !calls.includes(p)));
    assert.deepEqual(Array.from(entry.missing_perspectives), expectedMissing);
    const firstStage = severity === 'blocker' ? 2 : 1;
    assert.deepEqual(Array.from(result.refuter_dispatch.before.stage_agents), [firstStage, calls.length - firstStage]);
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

function perRoundAgent(countsByRound, outOfScopeByLabel = {}) {
  const findingsByLabel = {};
  countsByRound.forEach((count, i) => {
    findingsByLabel[`find-why-driven-p2r${i + 1}`] = Array.from({ length: count }, (_, j) =>
      finding({ claim: `round ${i + 1} finding ${j + 1}`, present_in_original: false }));
  });
  return scriptedAgent({ findingsByLabel, outOfScopeByLabel });
}

test('out_of_scope_changes keep the same path under different kinds as separate entries', async () => {
  const outside = { kind: 'outside_skill', path: 'references/old.md', change: 'a' };
  const rename = { kind: 'delete_or_rename', path: 'references/old.md', change: 'b' };
  const { agent } = perRoundAgent([0], { 'update-r1': [outside, rename] });
  const { result } = await run('update', agent);
  assert.deepEqual(JSON.parse(JSON.stringify(result.staging.out_of_scope_changes)), [outside, rename]);
});

test('an updater failing in the first round leaves out_of_scope_changes unknown', async () => {
  const { agent } = perRoundAgent([0], { 'update-r1': null });
  const { result } = await run('update', agent);
  assert.equal(result.verdict, 'update_failed');
  assert.equal(result.staging.out_of_scope_changes, null);
});

test('an updater failing in a later round keeps the earlier rounds out_of_scope_changes', async () => {
  const outside = { kind: 'outside_skill', path: 'workflows/review_skill.js', change: 'a' };
  const { agent } = perRoundAgent([1], { 'update-r1': [outside], 'update-r2': null });
  const { result } = await run('update', agent);
  assert.equal(result.verdict, 'update_failed');
  assert.deepEqual(JSON.parse(JSON.stringify(result.staging.out_of_scope_changes)), [outside]);
});

test('out_of_scope_changes accumulate across update rounds and collapse the same kind and path', async () => {
  const workflowChange = { kind: 'outside_skill', path: 'workflows/review_skill.js', change: 'add a field' };
  const rename = { kind: 'delete_or_rename', path: 'references/old.md', change: 'rename' };
  const { agent } = perRoundAgent([1, 0], {
    'update-r1': [workflowChange],
    'update-r2': [rename, { ...workflowChange, path: './workflows/review_skill.js', change: 'repeated' }],
  });
  const { result } = await run('update', agent);
  assert.equal(result.revisions_used, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.staging.out_of_scope_changes)), [workflowChange, rename]);
});

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

test('update round safety limit returns the last verified staging result with unresolved findings', async () => {
  const { agent, calls } = perRoundAgent([5, 4, 3, 2, 1]);
  const { result } = await run('update', agent);
  assert.deepEqual(calls.filter(c => c.label.startsWith('update-')).map(c => c.label),
    ['update-r1', 'update-r2', 'update-r3', 'update-r4']);
  assert.equal(result.verdict, 'needs_human_decision');
  assert.equal(result.stop_reason, 'update_round_limit');
  assert.equal(result.revisions_used, 3);
  assert.ok(result.staging.new.length > 0);
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
      return { changed_files: [{ path: 'SKILL.md', reason: 'intent', findings_addressed: [] }], out_of_scope_changes: [], summary: 'updated' };
    }
    if (opts.label.startsWith('refute-')) return batchReply(prompt, () => 'not_refuted');
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
    'find-why-driven-p1': { findings: [finding(), finding({ file: 'references/a.md' })], scanned_files: ['SKILL.md'], unreadable: false },
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

test('review runs the shared prompt-audit lens and keeps unavailable distinct from no findings', async () => {
  const { agent, calls } = optsRecordingAgent({
    'find-prompt-audit-p1': { findings: [], scanned_files: [], unreadable: false, unavailable: true, note: 'shared criteria unavailable' },
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
  const refuted = new Set(calls.filter(c => c.opts.label.startsWith('refute-')).flatMap(c => batchIds(c.prompt)));
  assert.deepEqual([...refuted], ['p1-prompt-audit-1']);
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
  assert.equal(result.source_snapshot.validation, 'required_after_workflow_before_result_is_trusted');
  assert.ok(calls[0].prompt.includes('/mock/skill-creator/references/prompt-audit.md'));
  assert.ok(!calls[0].prompt.includes('claude-api'));
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

test('finder and refuter roles avoid combined bulk reads and keep blocked coverage incomplete', () => {
  for (const [role, body] of [['finder', finderRole], ['refuter', refuterRole]]) {
    assert.match(body, /1 つずつ/, `${role} must read files individually`);
    assert.match(body, /`cat` \/ `head` \/ `tail`/, `${role} must avoid bulk shell reads`);
    assert.match(body, /bounded line range/, `${role} needs a bounded-read fallback`);
    assert.match(body, /unreadable/, `${role} must report blocked input as incomplete`);
  }
  assert.match(finderRole, /unreadable: true/);
  assert.match(finderRole, /`scanned_files`/);
});

test('update with audit criteria unavailable still completes only an explicit skip receipt when caller permits it', async () => {
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
    uncheckedItems: [{ id: 'verifier-path', item: 'a', requires_measurement: false },
      { id: 'description-triggers', item: 'b', requires_measurement: true }],
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

// ---------------------------------------------------------------- 反証の束（refuter 1 体に複数の指摘）

const MAX_PER_REFUTER = Number(source.match(/const MAX_FINDINGS_PER_REFUTER = (\d+)/)[1]);

test('refuters judge findings on the same file in one batch per perspective and split at the cap', async () => {
  const sameFile = Array.from({ length: MAX_PER_REFUTER + 1 }, (_, i) => finding({ claim: `same file ${i}` }));
  const { agent, calls } = scriptedAgent({
    findingsByLabel: {
      'find-why-driven-p1': sameFile.slice(0, 4),
      'find-loopholes-p1': [...sameFile.slice(4), finding({ file: 'references/a.md', claim: 'other file' })],
    },
  });
  const { result } = await run('review', agent);
  const refuters = calls.filter(c => c.label.startsWith('refute-'));
  const batches = refuters.filter(c => c.label.endsWith('-materiality')).map(c => batchIds(c.prompt));
  assert.equal(batches.length, 3);
  assert.ok(batches.every(ids => ids.length <= MAX_PER_REFUTER));
  assert.deepEqual(batches.map(ids => ids.length).sort(), [1, 1, MAX_PER_REFUTER].sort());
  assert.equal(refuters.length, batches.length);
  assert.deepEqual(JSON.parse(JSON.stringify(result.refuter_dispatch.before)), { batches: 3, stage_agents: [3, 0], lost_batches: 0 });
  assert.equal(result.findings.confirmed.length, MAX_PER_REFUTER + 2);
  for (const ids of batches) {
    const files = new Set(ids.map(id => result.findings.confirmed.find(f => f.id === id).file));
    assert.equal(files.size, 1);
  }
});

test('a batch reply that omits an id or repeats it leaves that finding without a vote, never not_refuted', async () => {
  const findings = [finding({ claim: 'answered' }), finding({ claim: 'omitted' }), finding({ claim: 'duplicated' })];
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, label: opts.label });
    if (opts.label.startsWith('refute-')) {
      const ids = batchIds(prompt);
      const verdicts = [];
      for (const id of ids) {
        if (id.endsWith('-2')) continue;
        verdicts.push({ id, verdict: 'not_refuted', reason: 'r' });
        if (id.endsWith('-3')) verdicts.push({ id, verdict: 'not_refuted', reason: 'again' });
      }
      return { verdicts: [...verdicts, { id: 'not-in-batch', verdict: 'refuted', reason: 'stray' }] };
    }
    return { findings: opts.label === 'find-why-driven-p1' ? findings : [], scanned_files: ['SKILL.md'],
      unreadable: false, unchecked_judgments: [], audit_header: AUDIT_HEADER };
  };
  const { result } = await run('review', agent);
  assert.deepEqual(Array.from(result.findings.confirmed, f => f.claim), ['answered']);
  assert.deepEqual(Array.from(result.findings.unverified, f => f.claim).sort(), ['duplicated', 'omitted']);
  for (const f of result.findings.unverified) {
    assert.deepEqual(Array.from(f.missing_perspectives), ['materiality', 'existence', 'alternative']);
  }
  const second = calls.filter(c => c.label.includes('-s2-')).map(c => [c.label.split('-').at(-1), batchIds(c.prompt).length]);
  assert.deepEqual(second, [['existence', 2], ['alternative', 2]]);
});

test('early settlement stays per finding inside a batch: only the refuted finding goes to the second stage', async () => {
  const findings = [finding({ claim: 'agreed' }), finding({ claim: 'split' })];
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, label: opts.label });
    if (opts.label.startsWith('refute-')) {
      const perspective = opts.label.split('-').at(-1);
      return batchReply(prompt, id => (id.endsWith('-2') && perspective === 'materiality' ? 'refuted' : 'not_refuted'));
    }
    return { findings: opts.label === 'find-why-driven-p1' ? findings : [], scanned_files: ['SKILL.md'],
      unreadable: false, unchecked_judgments: [], audit_header: AUDIT_HEADER };
  };
  const { result } = await run('review', agent);
  const second = calls.filter(c => c.label.includes('-s2-')).map(c => [c.label.split('-').at(-1), batchIds(c.prompt)]);
  assert.deepEqual(second, [['existence', ['p1-why-driven-2']], ['alternative', ['p1-why-driven-2']]]);
  const agreed = result.findings.confirmed.find(f => f.claim === 'agreed');
  const split = result.findings.confirmed.find(f => f.claim === 'split');
  assert.deepEqual(Array.from(agreed.skipped_perspectives), ['existence', 'alternative']);
  assert.deepEqual(Array.from(split.skipped_perspectives), []);
  assert.equal(split.refuted_votes, 1);
  assert.deepEqual(Array.from(result.refuter_dispatch.before.stage_agents), [1, 2]);
});

test('refuter labels stay unique across update rounds', async () => {
  const { agent, calls } = perRoundAgent([2, 1, 0]);
  await run('update', agent);
  const labels = calls.filter(c => c.label.startsWith('refute-')).map(c => c.label);
  assert.ok(labels.length > 0);
  assert.equal(new Set(labels).size, labels.length);
});

// ---------------------------------------------------- 改稿では満たせない委譲項目（requires_measurement）

const MEASURED = [
  { id: 'verifier-path', item: 'a', requires_measurement: false },
  { id: 'description-triggers', item: 'b', requires_measurement: true },
];

function uncheckedAgent(judgmentsFor) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, label: opts.label });
    if (opts.label.startsWith('update-')) {
      return { changed_files: [{ path: 'SKILL.md', reason: 'intent', findings_addressed: [] }], out_of_scope_changes: [], summary: 'u' };
    }
    if (opts.label.startsWith('refute-')) return batchReply(prompt, () => 'not_refuted');
    return { findings: [], scanned_files: ['SKILL.md'], unreadable: false, audit_header: AUDIT_HEADER,
      unchecked_judgments: opts.label.startsWith('find-best-practices-') ? judgmentsFor(opts.label) : [] };
  };
  return { agent, calls };
}

test('a delegated item that needs measurement does not keep the update loop going', async () => {
  const { agent, calls } = uncheckedAgent(() => [
    { id: 'verifier-path', verdict: 'pass', evidence: 'e' },
    { id: 'description-triggers', verdict: 'unknown', evidence: 'needs evals' },
  ]);
  const { result } = await run('update', agent, { scope: 'full' }, {}, { uncheckedItems: MEASURED });
  assert.deepEqual(calls.filter(c => c.label.startsWith('update-')).map(c => c.label), ['update-r1']);
  assert.equal(result.verdict, 'applied_to_staging');
  assert.equal(result.stop_reason, 'resolved');
  assert.deepEqual(JSON.parse(JSON.stringify(result.unchecked_failures.map(f => [f.location, f.requires_measurement]))),
    [['機械判定できない項目: description-triggers', true]]);
});

function uncheckedSentToUpdater(prompt) {
  const start = prompt.indexOf('[UNCHECKED_FAILURES]:\n') + '[UNCHECKED_FAILURES]:\n'.length;
  return JSON.parse(prompt.slice(start, prompt.indexOf('\n\n[', start))).map(f => f.location.split(': ')[1]);
}

// 改稿で満たせる委譲項目は updater に渡す。この模擬 updater は直さないので、渡したうえで動かなければ dried で止まる。
test('an unjudged measurement item is also excluded from the loop, while a revisable item still loops', async () => {
  const { agent, calls } = uncheckedAgent(() => [{ id: 'verifier-path', verdict: 'fail', evidence: 'no verifier' }]);
  const { result } = await run('update', agent, { scope: 'full' }, {}, { uncheckedItems: MEASURED });
  const updaters = calls.filter(c => c.label.startsWith('update-'));
  assert.deepEqual(updaters.map(c => c.label), ['update-r1', 'update-r2']);
  for (const c of updaters) assert.deepEqual(uncheckedSentToUpdater(c.prompt), ['verifier-path'], c.label);
  assert.equal(result.stop_reason, 'dried');
  const byId = Object.fromEntries(result.unchecked_failures.map(f => [f.location.split(': ')[1], f.requires_measurement]));
  assert.deepEqual(byId, { 'verifier-path': false, 'description-triggers': true });
});

test('review stays non-clean when only a measurement item is unmet', async () => {
  const { agent } = uncheckedAgent(() => [
    { id: 'verifier-path', verdict: 'pass', evidence: 'e' },
    { id: 'description-triggers', verdict: 'unknown', evidence: 'needs evals' },
  ]);
  const { result } = await run('review', agent, { scope: 'full' }, {}, { uncheckedItems: MEASURED });
  assert.equal(result.verdict, 'findings');
  assert.equal(result.unchecked_failures.length, 1);
});

test('uncheckedItems without a boolean requires_measurement are rejected', async () => {
  await assert.rejects(run('review', async () => null, { scope: 'full' }, {}, { uncheckedItems: [{ id: 'x', item: 'y' }] }),
    /requires_measurement/);
  await assert.rejects(run('review', async () => null, { scope: 'full' }, {},
    { uncheckedItems: [{ id: 'x', item: 'y', requires_measurement: 'yes' }] }), /requires_measurement/);
});

// --------------------------------------------------------------------------- seedFindings

function seed(overrides = {}) {
  return { id: 'p1-why-driven-1', category: 'why-driven', file: 'SKILL.md', location: 'L1', claim: 'seeded claim',
    evidence: 'quoted', severity: 'major', suggested_fix: 'fix', votes: [{ perspective: 'existence' }], ...overrides };
}

const seeds = (...findings) => ({ seedFindings: { source_run_id: 'wf_audit-1', findings } });

// refuter の票を指摘 id ごとに決め、finder は label ごとの返り値を使う模擬 agent。
function seedAgent({ votesFor = () => 'not_refuted', findingsByLabel = {}, scannedByLabel = {}, updater } = {}) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, label: opts.label, phase: opts.phase });
    if (opts.label.startsWith('update-')) {
      if (updater) return updater(opts.label);
      return { changed_files: [{ path: 'SKILL.md', reason: 'intent', findings_addressed: [] }], out_of_scope_changes: [], summary: 'u' };
    }
    if (opts.label.startsWith('refute-')) return batchReply(prompt, id => votesFor(id, opts.phase));
    return { findings: findingsByLabel[opts.label] || [], scanned_files: scannedByLabel[opts.label] || ['SKILL.md'],
      unreadable: false, unchecked_judgments: [], audit_header: AUDIT_HEADER };
  };
  return { agent, calls };
}

function confirmedSentToUpdater(prompt) {
  const start = prompt.indexOf('[CONFIRMED_FINDINGS]:\n') + '[CONFIRMED_FINDINGS]:\n'.length;
  return JSON.parse(prompt.slice(start, prompt.indexOf('\n\n[', start))).map(f => f.id);
}

test('seedFindings skip Find but every seed, minor included, goes through Verify; only survivors reach the updater', async () => {
  const { agent, calls } = seedAgent({ votesFor: id => (id === 'p1-why-driven-3' ? 'refuted' : 'not_refuted') });
  const { result, phases } = await run('update', agent, { scope: 'full' }, {}, seeds(
    seed(),
    seed({ id: 'p1-why-driven-2', claim: 'minor seed', severity: 'minor' }),
    seed({ id: 'p1-why-driven-3', claim: 'gone since the audit' }),
  ));
  assert.ok(!phases.includes('Find'));
  assert.ok(phases.includes('Verify'));
  assert.equal(calls.filter(c => c.phase === 'Find').length, 0);
  const verified = new Set(calls.filter(c => c.phase === 'Verify').flatMap(c => batchIds(c.prompt)));
  assert.deepEqual([...verified].sort(), ['p1-why-driven-1', 'p1-why-driven-2', 'p1-why-driven-3']);
  const updater = calls.find(c => c.label === 'update-r1').prompt;
  assert.deepEqual(confirmedSentToUpdater(updater), ['p1-why-driven-1', 'p1-why-driven-2']);
  assert.ok(!updater.includes('"votes"'));
  assert.deepEqual(Array.from(result.findings_before.rejected, f => f.id), ['p1-why-driven-3']);
  assert.deepEqual(Array.from(result.findings_before.reported_minor), []);
  assert.deepEqual(JSON.parse(JSON.stringify(result.seed)), { source_run_id: 'wf_audit-1', count: 3 });
  assert.equal(result.by_category.before, null);
  assert.equal(result.skipped_unavailable.before, null);
  assert.equal(result.declared_only.before, null);
});

test('an unverified seed is not a confirmed target, and update_failed never reports unrefuted seeds as confirmed', async () => {
  const { agent, calls } = seedAgent({
    votesFor: id => (id === 'p1-why-driven-2' ? 'unreadable' : 'not_refuted'),
    updater: () => { throw new Error('structured output retries exhausted'); },
  });
  const { result } = await run('update', agent, { scope: 'full' }, {}, seeds(seed(), seed({ id: 'p1-why-driven-2', claim: 'unreadable seed' })));
  assert.equal(result.verdict, 'update_failed');
  assert.deepEqual(Array.from(result.findings.confirmed, f => f.id), ['p1-why-driven-1']);
  assert.deepEqual(Array.from(result.findings.unverified, f => f.id), ['p1-why-driven-2']);
  const updater = calls.find(c => c.label === 'update-r1').prompt;
  assert.deepEqual(confirmedSentToUpdater(updater), ['p1-why-driven-1']);
  assert.match(updater, /\[UNVERIFIED_FINDINGS\]:[\s\S]*p1-why-driven-2/);
});

test('seed reconciliation: re-reported seeds stay remaining, minor ones do not loop, unseen ones are unobserved, new ones split by origin', async () => {
  const reverify = [
    finding({ claim: 'major seed', present_in_original: true }),
    finding({ claim: 'minor seed', severity: 'minor', present_in_original: true }),
    finding({ claim: 'already there', present_in_original: true }),
    finding({ claim: 'introduced', present_in_original: false }),
  ];
  const { agent, calls } = seedAgent({
    findingsByLabel: { 'find-why-driven-p2r1': reverify, 'find-why-driven-p2r2': reverify },
  });
  const { result } = await run('update', agent, { scope: 'full' }, {}, seeds(
    seed({ id: 's-major', claim: 'major seed' }),
    seed({ id: 's-minor', claim: 'minor seed', severity: 'minor' }),
    seed({ id: 's-unseen', file: 'references/x.md', claim: 'unseen seed' }),
    seed({ id: 's-fixed', claim: 'fixed seed' }),
  ));
  const claims = bucket => Array.from(result.staging[bucket], f => f.claim).sort();
  assert.deepEqual(claims('remaining'), ['major seed', 'minor seed']);
  assert.deepEqual(claims('resolved'), ['fixed seed']);
  assert.deepEqual(claims('unobserved'), ['unseen seed']);
  assert.deepEqual(claims('preexisting'), ['already there']);
  assert.deepEqual(claims('new'), ['introduced']);
  assert.deepEqual(calls.filter(c => c.label.startsWith('update-')).map(c => c.label), ['update-r1', 'update-r2']);
  const note = calls.find(c => c.label === 'update-r2').prompt;
  const unresolved = JSON.parse(note.slice(note.indexOf('[REVISE_NOTE]')).match(/(\{[\s\S]*\})\s*$/)[1]).unresolved.map(f => f.claim).sort();
  assert.deepEqual(unresolved, ['introduced', 'major seed']);
  assert.equal(result.stop_reason, 'dried');
});

test('a seed refuted on recheck lands in refuted_on_recheck, and one refuted in Verify never becomes a baseline', async () => {
  const { agent } = seedAgent({
    votesFor: (id, phase) => (phase === 'Reverify' ? 'refuted' : id === 's-gone' ? 'refuted' : 'not_refuted'),
    findingsByLabel: { 'find-why-driven-p2r1': [finding({ claim: 'kept seed', present_in_original: true })] },
  });
  const { result } = await run('update', agent, { scope: 'full' }, {}, seeds(
    seed({ id: 's-kept', claim: 'kept seed' }),
    seed({ id: 's-gone', claim: 'gone seed' }),
  ));
  assert.deepEqual(Array.from(result.staging.refuted_on_recheck, f => f.claim), ['kept seed']);
  assert.deepEqual(Array.from(result.findings_before.rejected, f => f.id), ['s-gone']);
  assert.ok(![...result.staging.resolved, ...result.staging.unobserved].some(f => f.claim === 'gone seed'));
  assert.equal(result.verdict, 'applied_to_staging');
});

test('a seeded run stopped before the first updater reports delegated items as not judged', async () => {
  const { agent } = seedAgent();
  const { result } = await run('update', agent, { scope: 'full' }, { budget: { total: 1, spent: () => 1, remaining: () => 0 } },
    seeds(seed()));
  assert.equal(result.stop_reason, 'budget');
  assert.equal(result.unchecked_failures, null);
});

test('a seeded run accepts prompt-audit unavailable in Reverify when the caller permits it', async () => {
  const unavailable = { findings: [], scanned_files: [], unreadable: false, unavailable: true };
  const { agent } = optsRecordingAgent({ 'find-prompt-audit-p2r1': unavailable });
  const { result } = await run('update', agent, { scope: 'full' }, {}, seeds(seed()));
  assert.equal(result.verdict, 'applied_to_staging');
  assert.deepEqual(Array.from(result.skipped_unavailable.after), ['prompt-audit']);
});

for (const [name, extra, pattern, target = { scope: 'full' }, mode = 'update'] of [
  ['outside update', seeds(seed()), /seedFindings/, { scope: 'full' }, 'review'],
  ['from several runs', { seedFindings: [{ source_run_id: 'a', findings: [seed()] }] }, /1 つの run/],
  ['without a source run id', { seedFindings: { findings: [seed()] } }, /source_run_id/],
  ['with no findings', { seedFindings: { source_run_id: 'a', findings: [] } }, /findings が空/],
  ['with an unknown category', seeds(seed({ category: 'style' })), /FINDERS/],
  ['with a missing evidence', seeds(seed({ evidence: '' })), /evidence/],
  ['with a non-string location', seeds(seed({ location: 3 })), /location/],
  ['with a bad severity', seeds(seed({ severity: 'high' })), /severity/],
  ['with an absolute file', seeds(seed({ file: '/etc/x' })), /相対パス/],
  ['with a duplicate id', seeds(seed(), seed({ claim: 'other' })), /重複/],
  ['with a duplicate finding', seeds(seed(), seed({ id: 'other-id' })), /重複/],
  ['above the per-lens cap', seeds(...Array.from({ length: 9 }, (_, i) => seed({ id: `s${i}`, claim: `c${i}` }))), /超えて/],
  ['outside the frozen diff', seeds(seed({ file: 'references/other.md' })), /changed paths/, { scope: 'diff', diffRef: 'main...HEAD' }],
  ['containing a delegated-item failure',
    seeds(seed({ id: 'p1-unchecked-verifier-path', category: 'best-practices', requires_measurement: false })), /委譲項目/],
  ['together with intentScope', seeds(seed()), /同時に/, { scope: 'full', intentScope: { categories: ['why-driven'] } }],
]) {
  test(`seedFindings ${name} are rejected before any agent runs`, async () => {
    let dispatched = 0;
    await assert.rejects(run(mode, async () => { dispatched++; return null; }, target, {}, extra), pattern);
    assert.equal(dispatched, 0);
  });
}

// --------------------------------------------------------------------------- intentScope

test('intentScope narrows Find to the chosen lenses and files, declares the rest, and Reverify keeps every lens', async () => {
  const { agent, calls } = scriptedAgent({
    findingsByLabel: { 'find-why-driven-p1': [finding({ file: 'references/a.md', claim: 'scoped' })] },
    scannedByLabel: { 'find-why-driven-p1': ['references/a.md'], 'find-loopholes-p1': ['references/a.md'] },
  });
  const intentScope = { categories: ['why-driven', 'loopholes'], files: ['references/a.md'] };
  const { result } = await run('update', agent, { scope: 'full', intentScope });
  const find = calls.filter(c => c.phase === 'Find').map(c => c.label);
  assert.deepEqual(find.sort(), ['find-loopholes-p1', 'find-why-driven-p1']);
  for (const c of calls.filter(c => c.phase === 'Find')) {
    assert.match(c.prompt, /\[INTENT_SCOPE_FILES\]:\n\[\n  "references\/a\.md"\n\]/);
  }
  const reverify = new Set(calls.filter(c => c.phase === 'Reverify' && c.label.startsWith('find-')).map(c => c.label.split('-p2r')[0]));
  assert.equal(reverify.size, Object.keys(result.by_category.after).length);
  assert.ok(reverify.size > 2);
  for (const [lens, value] of Object.entries(result.by_category.before)) {
    assert.equal(value, ['why-driven', 'loopholes'].includes(lens) ? (lens === 'why-driven' ? 1 : 0) : 'out_of_intent_scope', lens);
  }
  assert.deepEqual(Object.keys(result.by_category.before).sort(), Object.keys(result.by_category.after).sort());
  assert.deepEqual(Array.from(result.unscanned_intent_files), []);
  assert.deepEqual(JSON.parse(JSON.stringify(result.target.intentScope)), { categories: ['why-driven', 'loopholes'], files: ['references/a.md'] });
  assert.match(calls.find(c => c.label === 'update-r1').prompt, /\[INTENT_SCOPE_FILES\]/);
});

test('intentScope files that no Find lens read stop the run instead of passing with nothing seen', async () => {
  const { agent, calls } = scriptedAgent({ scannedByLabel: {} });
  const { result } = await run('update', agent, { scope: 'full', intentScope: { files: ['references/missing.md'] } });
  assert.equal(result.verdict, 'review_incomplete');
  assert.deepEqual(Array.from(result.unscanned_intent_files), ['references/missing.md']);
  assert.equal(calls.filter(c => c.label.startsWith('update-')).length, 0);
});

test('a Find finding outside intentScope.files makes that lens missing', async () => {
  const { agent } = scriptedAgent({ findingsByLabel: { 'find-why-driven-p1': [finding({ file: 'SKILL.md' })] } });
  const { result } = await run('update', agent, { scope: 'full', intentScope: { files: ['references/a.md'] } });
  assert.equal(result.verdict, 'review_incomplete');
  assert.equal(result.by_category.before['why-driven'], null);
});

test('intentScope without the delegated-item lens leaves unchecked_failures unjudged until Reverify', async () => {
  const { agent } = scriptedAgent({});
  const { result } = await run('update', agent, { scope: 'full', intentScope: { categories: ['why-driven'] } },
    { budget: { total: 1, spent: () => 1, remaining: () => 0 } });
  assert.equal(result.stop_reason, 'budget');
  assert.equal(result.unchecked_failures, null);
});

for (const [name, intentScope, pattern, mode = 'update'] of [
  ['in review', { categories: ['why-driven'] }, /intentScope/, 'review'],
  ['with an unknown lens', { categories: ['style'] }, /categories/],
  ['with a repeated lens', { categories: ['why-driven', 'why-driven'] }, /categories/],
  ['with no keys', {}, /categories か files/],
  ['with a parent path', { files: ['../other/SKILL.md'] }, /相対パス/],
  ['with an empty file list', { files: [] }, /files/],
  ['with a repeated file', { files: ['SKILL.md', './SKILL.md'] }, /重複/],
]) {
  test(`intentScope ${name} is rejected`, async () => {
    await assert.rejects(run(mode, async () => null, { scope: 'full', intentScope }), pattern);
  });
}

// native の parallel は落ちた thunk を null で返す。束の行が丸ごと返らなくても、反証に回した指摘を消さない。
test('a refutation batch whose thunk fails keeps its findings as unverified instead of dropping them', async () => {
  const dropBatchRows = tasks => Promise.all(tasks.map(task => Promise.resolve(task()).then(roundTrip)))
    .then(results => results.map(r => (r && Array.isArray(r.rows) ? null : r)));
  const { agent } = scriptedAgent({
    findingsByLabel: { 'find-why-driven-p1': [finding({ claim: 'a' }), finding({ claim: 'b', file: 'references/a.md' })] },
  });
  const { result } = await run('review', agent, { scope: 'full' }, { parallel: dropBatchRows });
  assert.equal(result.findings.confirmed.length, 0);
  assert.deepEqual(Array.from(result.findings.unverified, f => f.claim).sort(), ['a', 'b']);
  for (const f of result.findings.unverified) {
    assert.deepEqual(Array.from(f.missing_perspectives), ['materiality', 'existence', 'alternative']);
    assert.equal(f.valid_votes, 0);
  }
  assert.equal(result.verdict, 'findings');
  assert.equal(result.refuter_dispatch.before.lost_batches, 2);
});

test('a revisable delegated failure that the revision fixes resolves the loop', async () => {
  const { agent, calls } = uncheckedAgent(label => [
    { id: 'verifier-path', verdict: label.endsWith('-p1') ? 'fail' : 'pass', evidence: 'e' },
    { id: 'description-triggers', verdict: 'unknown', evidence: 'needs evals' },
  ]);
  const { result } = await run('update', agent, { scope: 'full' }, {}, { uncheckedItems: MEASURED });
  assert.deepEqual(uncheckedSentToUpdater(calls.find(c => c.label === 'update-r1').prompt), ['verifier-path']);
  assert.equal(result.stop_reason, 'resolved');
  assert.deepEqual(Array.from(result.unchecked_failures, f => f.requires_measurement), [true]);
});

test('seeds that are all refuted stop before the updater with seeds_refuted', async () => {
  const { agent, calls } = seedAgent({ votesFor: () => 'refuted' });
  const { result } = await run('update', agent, { scope: 'full' }, {}, seeds(seed(), seed({ id: 's2', claim: 'other' })));
  assert.equal(calls.filter(c => c.label.startsWith('update-')).length, 0);
  assert.equal(result.verdict, 'needs_human_decision');
  assert.equal(result.stop_reason, 'seeds_refuted');
  assert.equal(result.staging, null);
  assert.equal(result.findings_before.rejected.length, 2);
});

test('a blocker gate stop still returns the delegated-item judgments of the Reverify that ran', async () => {
  const blocker = finding({ file: 'references/x.md', claim: 'blocker claim', severity: 'blocker' });
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push(opts.label);
    if (opts.label.startsWith('update-')) {
      return { changed_files: [{ path: 'SKILL.md', reason: 'u', findings_addressed: [] }], out_of_scope_changes: [], summary: 'u' };
    }
    if (opts.label.startsWith('refute-')) return batchReply(prompt, () => 'not_refuted');
    return {
      findings: opts.label === 'find-why-driven-p1' ? [blocker] : [],
      scanned_files: ['SKILL.md'], unreadable: false, audit_header: AUDIT_HEADER,
      unchecked_judgments: opts.label.startsWith('find-best-practices-')
        ? [{ id: 'verifier-path', verdict: opts.label.endsWith('-p1') ? 'pass' : 'fail', evidence: 'e' },
          { id: 'description-triggers', verdict: 'pass', evidence: 'e' }]
        : [],
    };
  };
  const { result } = await run('update', agent, { scope: 'full' }, {}, { uncheckedItems: MEASURED });
  assert.equal(result.stop_reason, 'unverified_blocker');
  assert.deepEqual(Array.from(result.unchecked_failures, f => f.location), ['機械判定できない項目: verifier-path']);
});

test('Find and Verify agents get the evidence pack; Reverify finders get it only as the original for comparison', async () => {
  const { agent, calls } = intentMismatchAgent(false, ['find-why-driven-p1', 'find-why-driven-p2r1']);
  await run('update', agent);
  const pack = '[EVIDENCE_PACK]: /mock/snapshot/evidence-pack.txt';
  for (const c of calls.filter(c => c.phase === 'Find' || c.phase === 'Verify')) assert.ok(c.prompt.includes(pack), c.label);
  for (const c of calls.filter(c => c.phase === 'Reverify')) assert.ok(!c.prompt.includes(pack), c.label);
  for (const c of calls.filter(c => c.phase === 'Reverify' && c.label.startsWith('find-'))) {
    assert.ok(c.prompt.includes('[ORIGINAL_EVIDENCE_PACK]: /mock/snapshot/evidence-pack.txt'), c.label);
  }
});

test('a snapshot without an evidence pack is rejected before any agent runs', async () => {
  let dispatched = 0;
  const snapshot = {
    version: 1, status: 'ready', scope: 'full', targetRoot: '/mock/target', snapshotRoot: '/mock/snapshot',
    snapshotDir: '/mock/snapshot/tree', manifestPath: '/mock/snapshot/manifest.json', manifestSha256: 'a'.repeat(64),
    receiptPath: '/mock/snapshot/receipt.json', diffRef: null, diffPath: null, changedPathsPath: null, diffSha256: null, changedPaths: [],
  };
  await assert.rejects(run('review', async () => { dispatched++; return null; }, { scope: 'full' }, {}, { snapshot }), /evidence pack/);
  assert.equal(dispatched, 0);
});

test('a minor seed is refuted through the default first stage (materiality alone)', async () => {
  const { agent, calls } = seedAgent();
  const { result } = await run('update', agent, { scope: 'full' }, {}, seeds(seed({ id: 's-minor', severity: 'minor' })));
  const verify = calls.filter(c => c.phase === 'Verify').map(c => [c.label.split('-').at(-1), batchIds(c.prompt)]);
  assert.deepEqual(verify, [['materiality', ['s-minor']]]);
  assert.deepEqual(Array.from(result.findings_before.confirmed, f => f.id), ['s-minor']);
  assert.deepEqual(Array.from(result.refuter_dispatch.before.stage_agents), [1, 0]);
});

test('a batch mixing a blocker and a major keeps each stage membership and vote with its own finding', async () => {
  const blocker = finding({ claim: 'blocker one', severity: 'blocker' });
  const major = finding({ claim: 'major one' });
  const calls = [];
  const verdictFor = { 'p1-why-driven-1': { materiality: 'not_refuted', existence: 'not_refuted' },
    'p1-why-driven-2': { materiality: 'refuted', existence: 'refuted', alternative: 'not_refuted' } };
  const agent = async (prompt, opts) => {
    calls.push({ prompt, label: opts.label });
    if (opts.label.startsWith('refute-')) return batchReply(prompt, id => verdictFor[id][opts.label.split('-').at(-1)]);
    return { findings: opts.label === 'find-why-driven-p1' ? [blocker, major] : [], scanned_files: ['SKILL.md'],
      unreadable: false, unchecked_judgments: [], audit_header: AUDIT_HEADER };
  };
  const { result } = await run('review', agent);
  const members = calls.filter(c => c.label.startsWith('refute-')).map(c => [c.label.split('-').slice(-2).join('-'), batchIds(c.prompt)]);
  assert.deepEqual(members, [
    ['s1-materiality', ['p1-why-driven-1', 'p1-why-driven-2']],
    ['s1-existence', ['p1-why-driven-1']],
    ['s2-existence', ['p1-why-driven-2']],
    ['s2-alternative', ['p1-why-driven-2']],
  ]);
  const confirmed = Object.fromEntries(result.findings.confirmed.map(f => [f.claim, f]));
  assert.deepEqual(confirmed['blocker one'].votes.map(v => [v.perspective, v.verdict]), [['materiality', 'not_refuted'], ['existence', 'not_refuted']]);
  assert.deepEqual(Array.from(result.findings.rejected, f => f.claim), ['major one']);
  assert.deepEqual(result.findings.rejected[0].votes.map(v => [v.perspective, v.verdict]),
    [['materiality', 'refuted'], ['existence', 'refuted'], ['alternative', 'not_refuted']]);
  assert.deepEqual(Array.from(result.refuter_dispatch.before.stage_agents), [2, 2]);
});

test('refuter_dispatch.after keeps one record per Reverify round, and review leaves it null', async () => {
  const { agent } = perRoundAgent([1, 0]);
  const { result } = await run('update', agent);
  assert.deepEqual(Array.from(result.refuter_dispatch.after, r => r.pass), ['p2r1', 'p2r2']);
  assert.deepEqual(Array.from(result.refuter_dispatch.after[0].stage_agents), [1, 0]);
  assert.deepEqual(Array.from(result.refuter_dispatch.after[1].stage_agents), [0, 0]);
  const review = await run('review', scriptedAgent({}).agent);
  assert.equal(review.result.refuter_dispatch.after, null);
});

test('an evidence pack path outside the snapshot layout is rejected before any agent runs', async () => {
  let dispatched = 0;
  const snapshot = {
    version: 1, status: 'ready', scope: 'full', targetRoot: '/mock/target', snapshotRoot: '/mock/snapshot',
    snapshotDir: '/mock/snapshot/tree', manifestPath: '/mock/snapshot/manifest.json', manifestSha256: 'a'.repeat(64),
    receiptPath: '/mock/snapshot/receipt.json', diffRef: null, diffPath: null, changedPathsPath: null, diffSha256: null, changedPaths: [],
    evidencePackPath: '/elsewhere/evidence-pack.txt', evidencePackSha256: 'c'.repeat(64),
  };
  await assert.rejects(run('review', async () => { dispatched++; return null; }, { scope: 'full' }, {}, { snapshot }), /evidence pack/);
  assert.equal(dispatched, 0);
});
