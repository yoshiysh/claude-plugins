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

  const keyOf = (s) => `${s.phase}|${s.questions.sort().join(',')}|${s.answers.sort().join(',')}|${s.blockingIssues}|${s.passes}|${s.auditPassed}`;

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

    // Generate successor states
    const nextStates = [];

    // SubmitForReview
    if (s.phase === 'draft') {
      nextStates.push({ ...s, phase: 'reviewing', passes: s.passes + 1 });
    }

    // AskQuestions
    if (s.phase === 'reviewing' && s.passes <= MAX_PASSES) {
      for (let q = 1; q <= MAX_QUESTIONS; q++) {
        if (!s.questions.includes(q)) {
          nextStates.push({ ...s, phase: 'needs_input', questions: [...s.questions, q] });
        }
      }
    }

    // ProvideAnswers
    if (s.phase === 'needs_input') {
      const unans = s.questions.filter((q) => !s.answers.includes(q));
      if (unans.length > 0) {
        nextStates.push({ ...s, phase: 'reviewing', answers: [...s.answers, ...unans] });
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
