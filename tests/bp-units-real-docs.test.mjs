import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicability, specItemIds } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/units.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');

const COPY = path.join(ROOT, 'plugins/skill-creator/skills/skill-creator-best-practices/references/criteria');
const COMMON = ['004', '005', '006', '009', '010', '019', '020', '039', '040', '041'];
const WORKFLOW = ['008', '011', '012', '013', '014', '035'];
const FANOUT = ['021', '022', '023', '024', '025', '026', '037'];
const EXPECTED = [
  ['ターンごとの指揮', '無', '無', ['007']],
  ['ターンごとの指揮', '無', '有', ['007']],
  ['ターンごとの指揮', '有', '*', ['007']],
  ...['固定パイプライン型', '固定集合の反復型', '探索グラフ型'].flatMap((shape) =>
    [['無', '無'], ['無', '有'], ['有', '無'], ['有', '有']].map(([ledger, fanout]) => [shape, ledger, fanout, [
      ...WORKFLOW, ...(shape === '探索グラフ型' ? ['015', '016', '034'] : []),
      ...(ledger === '有' ? ['016', '017'] : []), ...(fanout === '有' ? FANOUT : []),
    ]])),
];

for (const [name, dir] of [['正本', DOCS], ['配布する写し', COPY]]) {
  test(`SP-BPCONFORMANCE-003・SP-BPAUTHORING-017: ${name}の15行の条件と適用単位が独立したSP集合と一致し、統合した要求で適用を広げない`, () => {
    const rows = applicability(dir);
    assert.equal(rows.length, 15);
    for (let i = 0; i < EXPECTED.length; i += 1) {
      const [shape, ledger, fanout, extra] = EXPECTED[i];
      assert.deepEqual([rows[i].form, rows[i].ledger, rows[i].fanout], [shape, ledger, fanout], `行 ${i + 1}`);
      const expected = [...new Set([...COMMON, ...extra])].map((n) => `SP-BPCONFORMANCE-${n}`).sort();
      const actual = [...new Set(rows[i].units.map((u) => u.value.split('/')[0]))].sort();
      assert.deepEqual(actual, expected, `行 ${i + 1}`);
      assert.equal(new Set(rows[i].units.map((u) => u.value)).size, rows[i].units.length);
      assert.ok(rows[i].units.every((u) => u.meaning.length > 0));
    }
    // 4形×台帳2値×fan-out2値の各入力にただ1行が当たる。
    for (const shape of [...new Set(EXPECTED.map((r) => r[0]))]) for (const ledger of ['無', '有']) for (const fanout of ['無', '有']) {
      assert.equal(rows.filter((r) => r.form === shape && (r.ledger === ledger || r.ledger === '*') && (r.fanout === fanout || r.fanout === '*')).length, 1);
    }
  });
}

test('SP-BPAUTHORING-017・SP-BPCONFORMANCE-006・SP-BPCONFORMANCE-014・SP-BPCONFORMANCE-019・SP-BPCONFORMANCE-034: 強いられた未検査の出所（Claude Code・「権限」の表の最後の行）が実際の docs/ の判定の単位に全て解決し、006 と 034 は強いられた未検査に含まれない', () => {
  const rows = applicability(DOCS);
  const turn = rows.find((r) => r.form === 'ターンごとの指揮');
  const graph = rows.find((r) => r.form === '探索グラフ型' && r.ledger === '有' && r.fanout === '有');
  assert.ok(!turn.forced.includes('SP-BPCONFORMANCE-006'), 'ターンごとの指揮の PR-BPDESIGNEDSKILL-002 は強いられた未検査に含まれない');
  assert.ok(graph.forced.includes('SP-BPCONFORMANCE-019'), 'Claude Code の PR-BPDESIGNEDSKILL-014');
  assert.ok(graph.forced.some((u) => u.startsWith('SP-BPCONFORMANCE-014/権限/t1/r')), '「権限」の表の最後の行');
  assert.ok(!graph.forced.some((u) => graph.units.find((x) => x.value === u).meaning.startsWith('実行役の時間に上限を置く')), '実行役の時間の上限の行は強いられた未検査に含まれない');
  const last = graph.units.filter((u) => u.value.startsWith('SP-BPCONFORMANCE-014/権限/t1/r')).at(-1).value;
  assert.ok(graph.forced.includes(last));
  for (const r of rows) {
    const permission = r.units.filter((u) => /^SP-BPCONFORMANCE-014\/権限\/t1\/r\d+$/.test(u.value)).at(-1)?.value;
    assert.deepEqual(r.forced.sort(), ['SP-BPCONFORMANCE-019', ...(permission ? [permission] : [])].sort(), `行 ${r.row}: forced以外を免除しない`);
  }
});

test('SP-BPAUTHORING-038・SP-BPAUTHORING-039: 仕様項目 ID の閉集合が bp-conformance の全ての仕様項目の見出しと一致する', () => {
  const text = readFileSync(path.join(DOCS, 'specifications', 'bp-conformance.md'), 'utf8');
  const headings = [...text.matchAll(/^#### (SP-BPCONFORMANCE-\d{3})/gm)].map((m) => m[1]).sort();
  assert.deepEqual(specItemIds(DOCS), headings);
});
