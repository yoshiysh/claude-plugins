import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const tlaPath = path.join(here, 'FormalMethods.tla');
const cfgPath = path.join(here, 'FormalMethods.cfg');
const readmePath = path.join(here, 'README.md');

test('Formal model files exist and match structure', () => {
  assert.ok(fs.existsSync(tlaPath));
  assert.ok(fs.existsSync(cfgPath));
  assert.ok(fs.existsSync(readmePath));
  const tla = fs.readFileSync(tlaPath, 'utf8');
  assert.match(tla, /MODULE FormalMethods/);
  assert.match(tla, /TypeOK/);
  assert.match(tla, /DeadlockFree/);
});

test('Bounded Model Checking: explore state space and reachability', () => {
  const states = ["反復上限停止","失敗停止","完了","実行中","欠け停止"];
  const initial = "実行中";
  const terminals = new Set(["欠け停止","完了"]);
  const transitions = [{"from":"実行中","to":"完了"},{"from":"実行中","to":"欠け停止"},{"from":"実行中","to":"失敗停止"},{"from":"実行中","to":"反復上限停止"},{"from":"反復上限停止","to":"実行中"},{"from":"失敗停止","to":"実行中"},{"from":"欠け停止","to":"欠け停止"},{"from":"完了","to":"完了"}];

  const transMap = new Map();
  for (const t of transitions) {
    if (!transMap.has(t.from)) transMap.set(t.from, []);
    transMap.get(t.from).push(t.to);
  }

  const visited = new Set();
  const queue = initial ? [initial] : [...states];
  let reachedTerminal = terminals.size === 0;

  while (queue.length > 0) {
    const curr = queue.shift();
    if (visited.has(curr)) continue;
    visited.add(curr);
    assert.ok(states.includes(curr), `State ${curr} must be in declared states`);
    if (terminals.has(curr)) reachedTerminal = true;
    const nexts = transMap.get(curr) || [];
    if (!terminals.has(curr)) {
      assert.ok(nexts.length > 0, `Non-terminal state ${curr} must have outgoing transitions`);
    }
    for (const n of nexts) {
      if (!visited.has(n)) queue.push(n);
    }
  }
  assert.ok(visited.size > 0, 'Explored non-empty state space');
  assert.ok(reachedTerminal, 'Must be able to reach terminal state');
});
