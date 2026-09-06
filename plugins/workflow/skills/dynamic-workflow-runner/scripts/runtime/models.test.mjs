import test from 'node:test';
import assert from 'node:assert/strict';
import { modelResolver } from './models.mjs';

test('model selection is explicit, immutable, and records unresolved host defaults honestly', () => {
  const modelMap = { sonnet: { model: 'chosen-target', modelReasoningEffort: 'high' } };
  const resolve = modelResolver({ modelMap, model: 'default-target', modelReasoningEffort: 'low' });
  modelMap.sonnet.model = 'mutated';
  assert.deepEqual(resolve('sonnet'), { requested: 'sonnet', origin: 'explicit', model: 'chosen-target', modelReasoningEffort: 'high' });
  assert.equal(resolve().model, 'default-target');
  assert.throws(() => resolve('unknown'), /mapping/);
  assert.deepEqual(modelResolver()(), { requested: null, origin: 'host-default' });
});

test('invalid mapping policy is rejected before inference', () => {
  for (const modelMap of [[], null, { sonnet: '' }, { opus: { model: 'target', modelReasoningEffort: 'guess' } },
    { haiku: { model: 'target', tools: true } }]) {
    assert.throws(() => modelResolver({ modelMap }), /invalid/);
  }
  assert.throws(() => modelResolver({ modelReasoningEffort: 'high' }), /explicit default/);
});
