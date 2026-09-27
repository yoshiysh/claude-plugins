import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_UPDATE_TREE_BYTES } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/update-contract.mjs'
import { MAX_APPLY_TREE_BYTES } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/apply-update-package.mjs'

test('separately installed workflow and skill-creator plugins keep the same 32 MiB update tree cap', () => {
  assert.equal(MAX_UPDATE_TREE_BYTES, 32 * 1024 * 1024)
  assert.equal(MAX_APPLY_TREE_BYTES, MAX_UPDATE_TREE_BYTES)
})
