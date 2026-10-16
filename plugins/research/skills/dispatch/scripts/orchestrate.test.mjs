import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workflow } from '../../../../workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs';
import { readSourceMetadata } from '../../../../workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs';

const skillDir = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(skillDir, 'scripts', 'orchestrate.js');

function fakeBackend(profile, calls) {
  const plan = profile === 'codex_host_default'
    ? { round_goal: 'Check the behavior.', subagents: [{ label: 'inspect', role: 'inspector', prompt: 'Inspect evidence.', needs_verification: true, verification_reason: 'The conclusion will inform synthesis.' }] }
    : { round_goal: 'Check the behavior.', subagents: [{ label: 'inspect', role: 'inspector', model: 'sonnet', effort: 'medium', prompt: 'Inspect evidence.', needs_verification: true, verification_reason: 'The conclusion will inform synthesis.', verifier_model: 'haiku' }] };
  return {
    async run(prompt, options) {
      calls.push({ prompt, options });
      switch (options.phase) {
        case 'Plan': return plan;
        case 'Execute': return 'The inspected evidence supports the claim.';
        case 'Verify': return { verdict: 'CONFIRMED', concerns: [], notes: 'Checked the evidence.' };
        case 'Evaluate': return { status: 'converged', round_summary: 'Evidence checked.', new_findings: ['Evidence checked.'], open_questions: [], justification: 'The supplied evidence supports the answer.' };
        case 'Synthesize': return 'The evidence supports the claim.';
        default: throw new Error(`unexpected phase ${options.phase}`);
      }
    },
  };
}

function requestLimits(meta, args) {
  const rounds = args.maxRounds ?? meta.defaults.maxRounds;
  const subagentCap = args.subagentsPerRoundCap ?? meta.defaults.subagentsPerRoundCap;
  const maxAgents = rounds *
    (meta.callBudget.fixedCallsPerRound + subagentCap * meta.callBudget.callsPerSubagent) +
    meta.callBudget.finalCalls;
  return {
    ...meta.limits,
    maxAgents,
    concurrency: Math.min(meta.limits.concurrency, subagentCap),
    timeoutMs: (rounds * meta.callBudget.parallelPhasesPerRound + meta.callBudget.finalCalls) *
      meta.limits.agentTimeoutMs + meta.callBudget.timeoutMarginMs,
    maxOutputBytes: maxAgents * meta.callBudget.expectedOutputBytesPerCall + meta.callBudget.outputBufferBytes,
  };
}

async function runProfile(executionProfile) {
  const testRoot = await mkdtemp(join(tmpdir(), 'dispatch-profile-test-'));
  const runDir = join(testRoot, 'run');
  const calls = [];
  try {
    const sourceMeta = readSourceMetadata(await readFile(sourcePath, 'utf8'));
    const args = { skillDir, topic: 'Check the behavior.', ...(executionProfile === 'codex_host_default' ? { executionProfile } : {}), maxRounds: 1, subagentsPerRoundCap: 1 };
    const limits = requestLimits(sourceMeta, args);
    const result = await Workflow({
      scriptPath: sourcePath,
      args,
    }, {
      backend: fakeBackend(executionProfile, calls),
      runDir,
      trustedSource: true,
      ...limits,
    });
    return { result, calls, limits };
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}

test('Claude native profile preserves explicit model and effort selection', async () => {
  const { result, calls } = await runProfile('claude_native');
  assert.equal(result.execution_profile, 'claude_native');
  assert.equal(result.model_map_disclosure.provider, 'native Claude Workflow');
  assert.deepEqual(calls.map(({ options }) => [options.phase, options.model, options.effort]), [
    ['Plan', 'fable', 'high'],
    ['Execute', 'sonnet', 'medium'],
    ['Verify', 'haiku', undefined],
    ['Evaluate', 'fable', 'high'],
    ['Synthesize', 'fable', 'high'],
  ]);
});

test('Codex host-default profile keeps separate roles, omits model/effort, and derives top-level limits from meta', async () => {
  const { result, calls, limits } = await runProfile('codex_host_default');
  assert.equal(result.execution_profile, 'codex_host_default');
  assert.deepEqual(Object.values(result.model_map_disclosure.roles), Array(5).fill('Codex host-default'));
  assert.equal(result.model_map_disclosure.model_equivalence_claimed, false);
  assert.match(result.model_map_disclosure.model_id_visibility, /not exposed/);
  assert.match(result.model_map_disclosure.selection_evidence, /origin=host-default/);
  assert.deepEqual(limits, {
    maxAgents: 5,
    concurrency: 1,
    timeoutMs: 1_800_000,
    agentTimeoutMs: 240_000,
    maxOutputBytes: 1_500_000,
  });
  assert.deepEqual(result.model_map_disclosure.required_runner_limits, limits);
  assert.deepEqual(calls.map(({ options }) => options.phase), ['Plan', 'Execute', 'Verify', 'Evaluate', 'Synthesize']);
  for (const { options } of calls) {
    assert.equal(Object.hasOwn(options, 'model'), false);
    assert.equal(Object.hasOwn(options, 'effort'), false);
  }
  assert.match(calls.find(({ options }) => options.phase === 'Execute').prompt, /Do not identify yourself as Claude Fable 5/);
});
