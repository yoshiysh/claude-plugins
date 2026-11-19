// 試走の題材の最悪の起動数の定数の実測との照合と変異（tests/bp-trial-target-budget.test.mjs から並列に走らせるために分けた）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_DIR } from '../tools/read-bp-trial.mjs';
import { worstOf, sweep, measured, sequential, tightness, mutant } from './helpers/bp-trial-target.mjs';

test('SP-BPCONFORMANCE-022: 試走の題材の最悪の起動数の定数は、単位ごとの実測の最悪と一致し、予約分を 0 にする変異と最悪を 1 減らす変異を総当たりか実測の照合が見つける', async (t) => {
  const one = await sequential(t);
  const max = await measured(t, one);
  assert.deepEqual(await tightness(t, one, max), []);
  const reserve = await mutant(t, (s) => s.replace('const RESERVE = 1\n', 'const RESERVE = 0\n'));
  assert.ok((await sweep(t, reserve, { concurrencies: [1], first: true })).length, '予約分を 0 にした変異で上限を超える run が無い');
  const keys = Object.keys(worstOf(FIXTURE_DIR).worst);
  const lower = (picked) => (s) => s.replace(/const WORST = \{[^}]*\}/, (w) => picked.reduce((acc, key) => acc.replace(new RegExp(`(\\n  ${key}: )([^,\\n]+),`), '$1$2 - 1,'), w));
  // 各キーの変異は定数だけを変えた写しなので、one の実測を使い回す（tightness の注記）。その前提は、全てのキーを
  // 同時に 1 減らした写しの上限の無い run が元と同じ実測になることで確かめる（どのキーに依っても実測が変わる）。
  const all = await mutant(t, lower(keys), one);
  const { worst } = worstOf(FIXTURE_DIR);
  assert.deepEqual(worstOf(all).worst, Object.fromEntries(keys.map((key) => [key, worst[key] - 1])), '全てのキーを 1 減らせていない');
  assert.deepEqual(await measured(t, all), max, 'WORST を変えた写しの上限の無い run の実測が元と違う');
  for (const key of keys) {
    const root = await mutant(t, lower([key]), one);
    assert.ok((await tightness(t, root, max)).length, `${key} を 1 減らした変異を実測の照合が見つけない`);
  }
  const item = await mutant(t, (s) => s.replace('item: MAX_ATTEMPTS * (3 + 1),', 'item: MAX_ATTEMPTS * (3 + 1) - 1,'));
  assert.ok((await sweep(t, item, { concurrencies: [1], first: true })).length, '意図の最悪を 1 減らした変異で上限を超える run が無い');
});
