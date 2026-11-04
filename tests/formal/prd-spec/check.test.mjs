import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const tlaPath = path.join(here, 'PrdSpec.tla');
const cfgPath = path.join(here, 'PrdSpec.cfg');
const readmePath = path.join(here, 'README.md');

test('PrdSpec files exist and match structure', () => {
  assert.ok(fs.existsSync(tlaPath), 'PrdSpec.tla must exist');
  assert.ok(fs.existsSync(cfgPath), 'PrdSpec.cfg must exist');
  assert.ok(fs.existsSync(readmePath), 'README.md must exist');

  const tla = fs.readFileSync(tlaPath, 'utf8');
  const cfg = fs.readFileSync(cfgPath, 'utf8');
  const readme = fs.readFileSync(readmePath, 'utf8');

  // Verify invariants declared in tla are checked in cfg
  for (const inv of ['TypeOK', 'NoUnresolvedQuestionsOnApproval', 'NoBlockingOnCompletion', 'ValidTerminal']) {
    assert.match(tla, new RegExp(`\\b${inv}\\b`), `TLA must define ${inv}`);
    assert.match(cfg, new RegExp(`\\b${inv}\\b`), `CFG must declare ${inv}`);
    assert.match(readme, new RegExp(`\\b${inv}\\b`), `README must document ${inv}`);
  }

  // Verify Mermaid diagram in README matches transitions in TLA
  assert.match(readme, /stateDiagram-v2/);
  assert.match(readme, /draft --> reviewing:\s*SubmitForReview/);
  assert.match(readme, /reviewing --> needs_input:\s*AskQuestions/);
  assert.match(readme, /needs_input --> reviewing:\s*ProvideAnswers/);
  assert.match(readme, /reviewing --> approved:\s*PassAudit/);
  assert.match(readme, /approved --> done:\s*Complete/);
});

function nonEmptysubsets(arr) {
  const result = [];
  const n = arr.length;
  for (let i = 1; i < (1 << n); i++) {
    const sub = [];
    for (let j = 0; j < n; j++) {
      if (i & (1 << j)) sub.push(arr[j]);
    }
    result.push(sub);
  }
  return result;
}

test('Bounded Model Checking: state space satisfies invariants and reaches done', () => {
  // BFS model exploration of PrdSpec state space
  const initial = {
    phase: 'draft',
    questions: [],
    answers: [],
    blockingIssues: 0,
    passes: 0,
    auditPassed: false,
  };

  const keyOf = (s) => `${s.phase}|${[...s.questions].sort().join(',')}|${[...s.answers].sort().join(',')}|${s.blockingIssues}|${s.passes}|${s.auditPassed}`;

  const visited = new Set();
  const queue = [initial];
  let reachedDone = false;

  const MAX_QUESTIONS = 2;
  const MAX_PASSES = 2;

  while (queue.length > 0) {
    const s = queue.shift();
    const k = keyOf(s);
    if (visited.has(k)) continue;
    visited.add(k);

    // Invariant 1: TypeOK
    assert.ok(['draft', 'reviewing', 'needs_input', 'blocked', 'approved', 'done'].includes(s.phase));
    assert.ok(typeof s.blockingIssues === 'number' && s.blockingIssues >= 0, 'blockingIssues >= 0');
    assert.ok(typeof s.passes === 'number' && s.passes >= 0 && s.passes <= MAX_PASSES + 1, 'passes in bounds');
    assert.ok(s.questions.every((q) => q >= 1 && q <= MAX_QUESTIONS), 'questions within bounds');
    assert.ok(s.answers.every((a) => a >= 1 && a <= MAX_QUESTIONS), 'answers within bounds');

    // Invariant 2: NoUnresolvedQuestionsOnApproval
    if (s.phase === 'approved' || s.phase === 'done') {
      const qSet = new Set(s.questions);
      const aSet = new Set(s.answers);
      for (const q of qSet) {
        assert.ok(aSet.has(q), `All questions must be answered upon approval/completion, got q=${q}`);
      }
    }

    // Invariant 3: NoBlockingOnCompletion
    if (s.phase === 'done') {
      reachedDone = true;
      assert.equal(s.blockingIssues, 0);
      assert.equal(s.auditPassed, true);
    }

    // Invariant 4: ValidTerminal
    if (s.phase === 'done') {
      assert.ok(s.auditPassed, 'Valid terminal requires auditPassed');
    }

    // Generate successor states
    const nextStates = [];

    // SubmitForReview
    if (s.phase === 'draft') {
      nextStates.push({ ...s, phase: 'reviewing', passes: s.passes + 1 });
    }

    // AskQuestions: 1..MAX_QUESTIONS の空でない任意の部分集合
    if (s.phase === 'reviewing' && s.passes <= MAX_PASSES) {
      const allQs = Array.from({ length: MAX_QUESTIONS }, (_, i) => i + 1);
      for (const qs of nonEmptysubsets(allQs)) {
        nextStates.push({ ...s, phase: 'needs_input', questions: [...qs].sort() });
      }
    }

    // ProvideAnswers: 未回答の問いから空でない任意の部分集合を回答
    if (s.phase === 'needs_input') {
      const unans = s.questions.filter((q) => !s.answers.includes(q));
      if (unans.length > 0) {
        for (const ans of nonEmptysubsets(unans)) {
          const newAnswers = [...new Set([...s.answers, ...ans])].sort();
          nextStates.push({ ...s, phase: 'reviewing', answers: newAnswers });
        }
      }
    }

    // BlockOnDefect
    if (s.phase === 'reviewing' || s.phase === 'needs_input') {
      nextStates.push({ ...s, phase: 'blocked' });
    }

    // ResolveBlock
    if (s.phase === 'blocked' && s.passes < MAX_PASSES) {
      nextStates.push({ ...s, phase: 'reviewing' });
    }

    // PassAudit
    if (s.phase === 'reviewing') {
      const qSet = new Set(s.questions);
      const aSet = new Set(s.answers);
      const allAnswered = [...qSet].every((q) => aSet.has(q));
      if (allAnswered && s.blockingIssues === 0) {
        nextStates.push({ ...s, phase: 'approved', auditPassed: true });
      }
    }

    // Complete
    if (s.phase === 'approved' && s.auditPassed) {
      nextStates.push({ ...s, phase: 'done' });
    }

    for (const ns of nextStates) {
      if (!visited.has(keyOf(ns))) {
        queue.push(ns);
      }
    }
  }

  assert.ok(visited.size > 0, 'Explored non-empty state space');
  assert.ok(reachedDone, 'Terminal state "done" must be reachable');
});
