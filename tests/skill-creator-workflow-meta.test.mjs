import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readSourceMetadata } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/source.mjs';

const pluginRoot = resolve(import.meta.dirname, '..', 'plugins', 'skill-creator');
const workflowsDir = join(pluginRoot, 'workflows');
const skillDir = join(pluginRoot, 'skills', 'skill-creator-best-practices');

// 名前で呼べるのは meta が pure literal のときだけ（readSourceMetadata は AST で検査する）。
// skill の呼び出し名と同じ meta.name は、/skill-creator:<name> の解決が本家で定まっていない。
test('workflow sources keep pure-literal metadata with names distinct from the skill', () => {
  const skillName = readFileSync(join(skillDir, 'SKILL.md'), 'utf8').match(/^name:\s*(\S+)\s*$/m)[1];
  const names = Object.fromEntries(readdirSync(workflowsDir).filter((file) => file.endsWith('.js')).map((file) =>
    [file, readSourceMetadata(readFileSync(join(workflowsDir, file), 'utf8')).name]));
  assert.deepEqual(names, { 'build_skill.js': 'skill-creator-build', 'review_skill.js': 'skill-creator-review' });
  for (const name of Object.values(names)) {
    assert.match(name, /^[a-z][a-z0-9-]*$/); // named.mjs の localNameShape と同じ形
    assert.notEqual(name, skillName);
  }
});

test('quick_validate resolves every name-form callsite of the skill', () => {
  const output = execFileSync('python3', [join(skillDir, 'scripts', 'quick_validate.py'), skillDir], { encoding: 'utf8' });
  assert.match(output, /バリデーション通過/);
  const source = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  assert.doesNotMatch(source, /scriptPath\s*:\s*['"]/);
  const called = new Set([...source.matchAll(/^\s*name:\s*"(skill-creator:[a-z0-9-]+)"/gm)].map((m) => m[1]));
  assert.deepEqual(called, new Set(['skill-creator:skill-creator-build', 'skill-creator:skill-creator-review']));
});
