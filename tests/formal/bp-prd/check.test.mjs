import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./check.sh', import.meta.url));

test('relative TLC_DOT is rejected before loading TLC', () => {
  const result = spawnSync('sh', [script], {
    encoding: 'utf8',
    env: { ...process.env, TLC_DOT: path.join('relative', 'graph.dot'), TLA2TOOLS: '/nonexistent/tla2tools.jar' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TLC_DOT must be an absolute path/);
  assert.doesNotMatch(result.stderr, /Unexpected TLC jar SHA-256/);
});
