import test from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARY_MAX_CHARS } from './constants.mjs';
import { buildView } from './view.mjs';
import { summarize } from './summary.mjs';

function bigState() {
  const items = Array.from({ length: 400 }, (_, i) => ({ id: `verify-${String(i).padStart(8, '0')}`, key: { i } }));
  return buildView([
    { seq: 1, run: 'r1', op: 'start', records: [
      { t: 'state', id: 'bp-1', function: 'create', limits: {}, request: '依'.repeat(5000) },
      { t: 'run', id: 'r1', base: { iterations: 0, repeats: {} } },
      { t: 'paths', n: 1, root: '/x/skill', files: [], unresolved: [] },
      ...Array.from({ length: 50 }, (_, i) => ({ t: 'premise', id: `P${i + 1}`, run: 'r1', kind: 'answer', hash: String(i), text: '回答'.repeat(300) })),
      { t: 'stage', stage: 'verify', round: null, items },
    ] },
  ]);
}

test('SP-BPCONFORMANCE-033: 大きい状態の要約が 8,000 字以下になり、省いたものの件数と種類を宣言する', () => {
  const out = summarize(bigState());
  assert.ok(out.text.length <= SUMMARY_MAX_CHARS, String(out.text.length));
  assert.equal(out.chars, out.text.length);
  assert.ok(out.omitted.length > 0);
  for (const o of out.omitted) assert.ok(out.text.includes(`${o.kind} ${o.count} 件`), o.kind);
});

test('SP-BPCONFORMANCE-033: 小さい状態の要約は何も省かない', () => {
  const view = buildView([{ seq: 1, run: 'r1', op: 'start', records: [
    { t: 'state', id: 'bp-1', function: 'review', limits: {} },
    { t: 'run', id: 'r1', base: { iterations: 0, repeats: {} } },
    { t: 'paths', n: 1, root: '/x/skill', files: [], unresolved: [] },
  ] }]);
  const out = summarize(view);
  assert.deepEqual(out.omitted, []);
  assert.doesNotMatch(out.text, /省略/);
});
