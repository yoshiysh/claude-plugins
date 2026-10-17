import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workflow } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs';
import { readSourceMetadata } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const skillDir = join(repoRoot, 'plugins', 'research', 'skills', 'dispatch');
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

async function runProfile(executionProfile) {
  const testRoot = await mkdtemp(join(tmpdir(), 'dispatch-profile-test-'));
  const runDir = join(testRoot, 'run');
  const calls = [];
  try {
    const sourceMeta = readSourceMetadata(await readFile(sourcePath, 'utf8'));
    const args = { skillDir, topic: 'Check the behavior.', ...(executionProfile === 'codex_host_default' ? { executionProfile } : {}), maxRounds: 1, subagentsPerRoundCap: 1 };
    const limits = sourceMeta.limits;
    const result = await Workflow({
      scriptPath: sourcePath,
      args,
    }, {
      backend: fakeBackend(executionProfile, calls),
      runDir,
      trustedSource: true,
      ...limits,
    });
    return { result, calls, limits, args, hardSubagentsCap: sourceMeta.caps.subagentsPerRoundCap };
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}

test('Claude native profile preserves explicit model and effort selection', async () => {
  const { result, calls, args, hardSubagentsCap } = await runProfile('claude_native');
  assert.equal(result.execution_profile, 'claude_native');
  assert.equal(result.model_map_disclosure.provider, 'native Claude Workflow');
  assert.equal(Object.hasOwn(args, 'executionProfile'), false);
  const planSchemaMaxItems = calls.find(({ options }) => options.phase === 'Plan').options.schema.properties.subagents.maxItems;
  assert.equal(planSchemaMaxItems, hardSubagentsCap);
  assert.deepEqual(calls.map(({ options }) => [options.phase, options.model, options.effort]), [
    ['Plan', 'fable', 'high'],
    ['Execute', 'sonnet', 'medium'],
    ['Verify', 'haiku', undefined],
    ['Evaluate', 'fable', 'high'],
    ['Synthesize', 'fable', 'high'],
  ]);
});

test('Codex host-default profile keeps separate roles, omits model/effort, and exposes canonical meta limits', async () => {
  const { result, calls, limits, hardSubagentsCap } = await runProfile('codex_host_default');
  assert.equal(result.execution_profile, 'codex_host_default');
  assert.deepEqual(Object.values(result.model_map_disclosure.roles), Array(5).fill('Codex host-default'));
  assert.equal(result.model_map_disclosure.model_equivalence_claimed, false);
  assert.match(result.model_map_disclosure.model_id_visibility, /not exposed/);
  assert.match(result.model_map_disclosure.selection_evidence, /origin=host-default/);
  const planSchemaMaxItems = calls.find(({ options }) => options.phase === 'Plan').options.schema.properties.subagents.maxItems;
  assert.equal(planSchemaMaxItems, hardSubagentsCap);
  const routedRoles = [
    ['Plan', 'planner'],
    ['Verify', 'verifier'],
    ['Evaluate', 'evaluator'],
    ['Synthesize', 'synthesis'],
  ];
  for (const [phase, role] of routedRoles) {
    const prompt = calls.find(({ options }) => options.phase === phase).prompt;
    assert.match(prompt, new RegExp(`references/codex-host-default/${role}-role\\.md`));
  }
  assert.deepEqual(result.model_map_disclosure.required_runner_limits, { ...limits });
  assert.deepEqual(calls.map(({ options }) => options.phase), ['Plan', 'Execute', 'Verify', 'Evaluate', 'Synthesize']);
  for (const { options } of calls) {
    assert.equal(Object.hasOwn(options, 'model'), false);
    assert.equal(Object.hasOwn(options, 'effort'), false);
  }
  assert.match(calls.find(({ options }) => options.phase === 'Execute').prompt, /Do not identify yourself as Claude Fable 5/);
});
