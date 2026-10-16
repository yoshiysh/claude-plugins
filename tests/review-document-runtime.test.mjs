import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Workflow } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs';
import { readSourceMetadata } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs';

const sourcePath = new URL('../plugins/workflow/skills/review-document/scripts/review-document.js', import.meta.url).pathname;
const rubricPath = new URL('../plugins/workflow/skills/review-document/references/rubric.md', import.meta.url).pathname;

function score(label, file, suggestionCount = 0, worstSentenceCount = 0) {
  return {
    per_file: [{ file, score: 7, rationale: 'fixture score' }],
    worst_sentences: Array.from({ length: worstSentenceCount }, (_, index) => ({
      file, quote: `long sentence ${index + 1}`, rewrite: `short sentence ${index + 1}`,
    })),
    jargon: [], breakdown: [],
    suggestions: Array.from({ length: suggestionCount }, (_, index) => `suggestion ${index + 1}`),
    unreadable: false,
  };
}

async function fixture(t, {
  revisedContent = '改稿後の完全な本文\n', missingCoverage = false, inline = true,
  suggestionCount = 0, rescoreSuggestionCount = 0, worstSentenceCount = 0,
  rescoreWorstSentenceCount = 0, updateComplete = true, noChanges = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'review-document-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = inline ? join(root, 'source.md') : join(root, 'docs', 'source.md');
  const original = '元の文書本文\n';
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, original);
  const calls = [];
  const backend = {
    capabilities: ['read-only', 'fresh-thread'],
    ...(inline ? { async prepare() { return { cwd: root }; } } : {}),
    async run(prompt, options) {
      calls.push({ prompt, options });
      const { label, phase } = options;
      if (label === 'prepare') return {
        rubric_readable: true,
        readable_targets: missingCoverage ? [] : [target],
        unreadable_targets: [], skipped_targets: [],
      };
      if (label?.startsWith('score-')) return score(
        label,
        phase === 'Rescore' && !inline ? join(root, 'staging', 'source.md') : target,
        label === 'score-shortness-p2' ? rescoreSuggestionCount : label === 'score-shortness-p1' ? suggestionCount : 0,
        label === 'score-shortness-p2' ? rescoreWorstSentenceCount : label === 'score-shortness-p1' ? worstSentenceCount : 0,
      );
      if (label?.startsWith('refute-')) return { verdict: 'not_refuted', reason: 'fixture vote' };
      if (label === 'synthesize') return { suggestions: [], note: 'fixture synthesis' };
      if (label === 'update') {
        if (!inline) {
          const destination = prompt.match(new RegExp(`${target} → ([^\\n]+)`))?.[1];
          assert.ok(destination, 'native update prompt includes the exact staging destination');
          await mkdir(join(root, 'staging'), { recursive: true });
          await writeFile(destination, revisedContent);
          return { changed_files: [{ path: 'source.md', reason: 'fixture', addresses: ['focus'] }], summary: 'fixture update' };
        }
        if (noChanges) return { complete: true, changed_files: [], summary: 'fixture found no changes' };
        return { complete: updateComplete, changed_files: [{ path: target, reason: 'fixture', addresses: ['focus'], content: revisedContent }], summary: 'fixture update' };
      }
      if (label === 'constraint-check') return { violations: [], unchecked: [] };
      throw new Error(`unexpected agent label: ${label}`);
    },
  };
  return { root, target, original, calls, backend };
}

async function invoke(fixtureValue, args, runName, { maxAgents = 58 } = {}) {
  return Workflow({ scriptPath: sourcePath, args }, {
    backend: fixtureValue.backend,
    trustedSource: true,
    runDir: join(fixtureValue.root, runName),
    requirements: ['read-only'],
    maxAgents,
    concurrency: 8,
    timeoutMs: 1800000,
    agentTimeoutMs: 240000,
    maxOutputBytes: 1000000,
  });
}

test('Codex review remains read-only and reports exact target coverage', async t => {
  const f = await fixture(t);
  const result = await invoke(f, {
    rubricPath, executionMode: 'codex-runner', mode: 'review', targets: [f.target],
  }, 'review-run');

  assert.equal(result.verdict, 'clean');
  assert.deepEqual(result.coverage.requested, [f.target]);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.source_fingerprints.status, 'unavailable');
  assert.equal(f.calls.some(call => call.options.label === 'update'), false);
  assert.equal(await readFile(f.target, 'utf8'), f.original);
});

test('Codex revise returns and rescores exact inline content without write capability', async t => {
  const f = await fixture(t, { revisedContent: '完全な改稿本文\n' });
  const result = await invoke(f, {
    rubricPath, executionMode: 'codex-runner', mode: 'revise', targets: [f.target], constraints: '要求 ID を残す',
  }, 'revise-run');

  assert.equal(result.verdict, 'draft_ready');
  assert.equal(result.staging.storage, 'inline');
  assert.equal(result.staging.dir, null);
  assert.equal(result.staging.changed_files[0].content, '完全な改稿本文\n');
  assert.deepEqual(result.staging.scores_after[0], {
    file: f.target,
    draft_storage: 'inline',
    shortness: { score: 7, rationale: 'fixture score' },
    plainness: { score: 7, rationale: 'fixture score' },
    no_jargon: { score: 7, rationale: 'fixture score' },
  });
  const rescorePrompts = f.calls.filter(call => call.options.label?.endsWith('-p2')).map(call => call.prompt);
  assert.ok(rescorePrompts.length === 3);
  assert.ok(rescorePrompts.every(prompt => prompt.includes('完全な改稿本文')));
  const constraintPrompt = f.calls.find(call => call.options.label === 'constraint-check').prompt;
  assert.ok(constraintPrompt.includes('完全な改稿本文'));
  const updatePrompt = f.calls.find(call => call.options.label === 'update').prompt;
  assert.match(updatePrompt, /ファイルを書き換えず/);
  assert.equal(updatePrompt.includes('STAGING_DIR'), false);
  assert.equal(await readFile(f.target, 'utf8'), f.original);
});

test('incomplete target classification stops before scoring', async t => {
  const f = await fixture(t, { missingCoverage: true });
  const result = await invoke(f, {
    rubricPath, executionMode: 'codex-runner', mode: 'review', targets: [f.target],
  }, 'coverage-run');

  assert.equal(result.verdict, 'review_incomplete');
  assert.deepEqual(result.coverage.missing, [f.target]);
  assert.equal(f.calls.filter(call => call.options.phase === 'Score').length, 0);
});

test('duplicate requested target paths cannot pass coverage', async t => {
  const f = await fixture(t);
  const result = await invoke(f, {
    rubricPath, executionMode: 'codex-runner', mode: 'review', targets: [f.target, f.target],
  }, 'duplicate-target-run');

  assert.equal(result.verdict, 'review_incomplete');
  assert.deepEqual(result.coverage.duplicates, [f.target]);
  assert.equal(result.coverage.complete, false);
  assert.equal(f.calls.filter(call => call.options.phase === 'Score').length, 0);
});

test('refutation overflow is incomplete and stays within the declared call budget', async t => {
  const meta = readSourceMetadata(await readFile(sourcePath, 'utf8'));
  const f = await fixture(t, { suggestionCount: meta.caps.maxFindingsPerPass + 1 });
  const result = await invoke(f, {
    rubricPath, executionMode: 'codex-runner', mode: 'review', targets: [f.target],
  }, 'overflow-run');

  assert.equal(result.verdict, 'review_incomplete');
  assert.ok(result.unverified.some(row => row.note?.includes('反証上限')));
  assert.equal(f.calls.filter(call => call.options.label?.startsWith('refute-')).length, meta.caps.maxFindingsPerPass * 3);
  assert.equal(f.calls.some(call => call.options.label === 'update'), false);
});

test('oversized Codex draft fails closed without returning partial content', async t => {
  const cap = readSourceMetadata(await readFile(sourcePath, 'utf8')).caps.maxInlineDraftBytes;
  const f = await fixture(t, { revisedContent: 'x'.repeat(cap + 1) });
  const result = await invoke(f, {
    rubricPath, executionMode: 'codex-runner', mode: 'revise', targets: [f.target],
  }, 'oversized-run');

  assert.equal(result.verdict, 'update_failed');
  assert.equal(result.staging.storage, 'inline');
  assert.deepEqual(result.staging.changed_files, []);
  assert.match(result.staging.summary, /上限/);
  assert.equal(f.calls.some(call => call.options.phase === 'Rescore'), false);
  assert.equal(await readFile(f.target, 'utf8'), f.original);
});

test('incomplete inline draft response fails closed before rescore', async t => {
  const f = await fixture(t, { updateComplete: false });
  const result = await invoke(f, {
    rubricPath, executionMode: 'codex-runner', mode: 'revise', targets: [f.target],
  }, 'incomplete-draft-run');

  assert.equal(result.verdict, 'update_failed');
  assert.deepEqual(result.staging.changed_files, []);
  assert.equal(result.staging.constraint_unchecked.length, 1);
  assert.equal(f.calls.some(call => call.options.phase === 'Rescore'), false);
  assert.equal(await readFile(f.target, 'utf8'), f.original);
});

test('empty inline draft is not reported as ready', async t => {
  const f = await fixture(t, { noChanges: true });
  const result = await invoke(f, {
    rubricPath, executionMode: 'codex-runner', mode: 'revise', targets: [f.target],
  }, 'no-changes-run');

  assert.equal(result.verdict, 'no_changes');
  assert.deepEqual(result.staging.changed_files, []);
  assert.equal(result.staging.scores_after, null);
  assert.equal(result.staging.constraint_unchecked.length, 1);
  assert.equal(f.calls.some(call => call.options.phase === 'Rescore'), false);
  assert.equal(await readFile(f.target, 'utf8'), f.original);
});

test('native revise refutes all findings against staged files and keeps its file staging contract', async t => {
  const f = await fixture(t, {
    revisedContent: 'native draft\n', inline: false,
    suggestionCount: 8, rescoreSuggestionCount: 8,
    worstSentenceCount: 1, rescoreWorstSentenceCount: 1,
  });
  const result = await invoke(f, {
    rubricPath, mode: 'revise', targets: [f.target], constraints: 'keep ids', stagingDir: join(f.root, 'staging'),
  }, 'native-revise-run', { maxAgents: 100 });

  assert.equal(result.verdict, 'applied_to_staging');
  assert.equal(result.staging.storage, 'filesystem');
  assert.equal(result.staging.dir, join(f.root, 'staging'));
  assert.equal(await readFile(join(f.root, 'staging', 'source.md'), 'utf8'), 'native draft\n');
  assert.equal(await readFile(f.target, 'utf8'), f.original);
  const beforeRefutes = f.calls.filter(call => call.options.label?.startsWith('refute-p1-'));
  const afterRefutes = f.calls.filter(call => call.options.label?.startsWith('refute-p2-'));
  const stagedPath = join(f.root, 'staging', 'source.md');
  assert.equal(beforeRefutes.length, 9 * 3);
  assert.equal(afterRefutes.length, 9 * 3);
  assert.ok(afterRefutes.every(call => call.prompt.includes(`[TARGET_FILES]:\n${stagedPath}\n`)));
  assert.ok(afterRefutes.some(call => call.prompt.includes(`"file": "${stagedPath}"`)));
});
