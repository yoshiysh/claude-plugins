import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { cliOps } from './extract.mjs';
import { gapSnapshot, preconditions } from './flow.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// 検査の限界の一覧（node flow.mjs --print で作る）。操作の表と段の表の列だけでは、操作の段と欄の作り手が
// 決まらない範囲で、仕様の欠けではない（散文が段を決めている操作がある：README の「検査の限界」）。
// 一覧が今の仕様から作ったものと違えば落とす（見ていない範囲が黙って増減しない）。
const limits = JSON.parse(readFileSync(path.join(here, 'flow-limits.json'), 'utf8'));
const FUNCTIONS = ['create', 'update', 'review', 'audit'];

test('操作の表の全ての行が読め、受け取るものと返すものを持つ', () => {
  const ops = cliOps();
  assert.ok(ops.length >= 30, `操作が ${ops.length} 個しか読めない`);
  for (const op of ops) assert.ok(op.gives.length > 0, op.name);
});

test('表の列だけでは見られない範囲を宣言し、その一覧は今の仕様から作ったものと同じ', (t) => {
  const now = gapSnapshot();
  for (const fn of FUNCTIONS) {
    t.diagnostic(`${fn}: 段に結び付かず順を見ていない操作 ${now[fn].unmappedOps.length} 個: ${now[fn].unmappedOps.join(' ')}`);
    t.diagnostic(`${fn}: 作り手を表から決められず見ていない欄 ${now[fn].noNamedProducer.length} 個`);
    t.diagnostic(`${fn}: 名前だけが後ろの段の返すものと同じで、出所を見分けられない欄: ${now[fn].producerAtLaterStageOnly.join(' ') || 'なし'}`);
  }
  assert.deepEqual(now, limits);
});

for (const fn of FUNCTIONS) {
  test(`${fn}: 「の記録が無ければ」で名指した前の操作は、同じか前の段にある（段に結び付かない組は見ていないと宣言する）`, (t) => {
    const edges = preconditions(fn);
    assert.ok(edges.length > 0, '前提の組が 1 つも読めない');
    const unseen = edges.filter((e) => e.opStages.length === 0 || e.depStages.length === 0);
    for (const e of unseen) t.diagnostic(`見ていない: ${e.op} ← ${e.dep}（段に結び付かない操作を含む。bp-run.md:${e.line}）`);
    const checked = edges.filter((e) => !unseen.includes(e));
    for (const e of checked) assert.ok(Math.min(...e.depStages) <= Math.max(...e.opStages), `${e.op} が後ろの段の ${e.dep} を読む`);
    t.diagnostic(`見た組 ${checked.length} 個、見ていない組 ${unseen.length} 個`);
  });
}
