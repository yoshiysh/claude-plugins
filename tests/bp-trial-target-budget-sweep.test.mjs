// 試走の題材の起動数の上限の総当たり（tests/bp-trial-target-budget.test.mjs から並列に走らせるために分けた）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_DIR } from '../tools/read-bp-trial.mjs';
import { sweep, sequential } from './helpers/bp-trial-target.mjs';

test('SP-BPCONFORMANCE-022・SP-BPCONFORMANCE-023・SP-BPCONFORMANCE-025: 試走の題材は、上限を最小の起動数から上限の無い run の起動数まで総当たりで渡しても、同時実行 1・3 のどれでも上限を超えず、停止の記録を書き、上限で止まった理由に上限・その時点の起動数・残した件数を載せ、後の段の単位も境界で止める', async (t) => {
  assert.deepEqual(await sweep(t, FIXTURE_DIR), []);
  const refused = new Set();
  assert.deepEqual(await sweep(t, await sequential(t), { concurrencies: [1], refused }), []);
  for (const kind of ['plan（2 周目以降）', 'item', 'extra', 'scan', 'round']) assert.ok([...refused].some((k) => k.startsWith(kind)), `境界で止めた単位に ${kind} が無い: ${[...refused].join(' / ')}`);
});
