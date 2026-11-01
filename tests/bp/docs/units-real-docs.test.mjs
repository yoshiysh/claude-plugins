import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicability, specItemIds } from '../../../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/units.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DOCS = path.join(ROOT, 'docs');

test('SP-BPCONFORMANCE-003・SP-BPAUTHORING-017: 実際の docs/ から、適用の判定表の全ての行が空でない判定の単位の集合に解決する', () => {
  const text = readFileSync(path.join(DOCS, 'specifications', 'bp-conformance.md'), 'utf8');
  const section = text.slice(text.indexOf('#### SP-BPCONFORMANCE-003'), text.indexOf('#### SP-BPCONFORMANCE-004'));
  const specRows = section.split('\n').filter((l) => /^\| (ターンごとの指揮|固定パイプライン型|固定集合の反復型|探索グラフ型) \|/.test(l));
  const rows = applicability(DOCS);
  assert.equal(rows.length, specRows.length);
  for (const r of rows) {
    assert.ok(r.units.length > 0, `行 ${r.row}`);
    for (const always of ['001', '002', '006', '014', '015', '046', '051', '028', '036', '038', '040', '042']) assert.ok(r.requirements.includes(`PR-BPDESIGNEDSKILL-${always}`), `行 ${r.row}: ${always}`);
    assert.equal(r.requirements.includes('PR-BPDESIGNEDSKILL-048'), r.form !== 'ターンごとの指揮', `行 ${r.row}: 048`);
    assert.ok(!r.units.some((u) => u.value === 'SP-BPCONFORMANCE-041'), `行 ${r.row}: SP-BPCONFORMANCE-041 は検証役に渡さない`);
  }
  const RUN_RECORD = ['028', '029', '030', '031', '032', '033', '034', '035', '036', '038', '039', '040', '042'];
  assert.deepEqual(rows[3].requirements.map((x) => x.slice(-3)), [...new Set(['001', '002', '004', '005', '006', '007', '008', '009', '010', '014', '015', '018', '046', '048', '051', ...RUN_RECORD])].sort());
});

test('SP-BPAUTHORING-017・SP-BPCONFORMANCE-019・SP-BPCONFORMANCE-014: 強いられた未検査の 2 つの出所（Claude Code の PR-BPDESIGNEDSKILL-014・「権限」の表の最後の行）だけが、実際の docs/ の判定の単位に解決する', () => {
  const rows = applicability(DOCS);
  const turn = rows.find((r) => r.form === 'ターンごとの指揮');
  const graph = rows.find((r) => r.form === '探索グラフ型' && r.ledger === '有' && r.fanout === '有');
  assert.deepEqual(turn.forced, ['SP-BPCONFORMANCE-019'], 'ターンごとの指揮の行は PR-BPDESIGNEDSKILL-002 を強いられた未検査にしない（SP-BPCONFORMANCE-006）');
  assert.ok(graph.forced.includes('SP-BPCONFORMANCE-019'), 'Claude Code の PR-BPDESIGNEDSKILL-014');
  assert.ok(graph.forced.some((u) => u.startsWith('SP-BPCONFORMANCE-014/権限/t1/r')), '「権限」の表の最後の行');
  assert.equal(graph.forced.length, 2, '実行役の時間の上限の行は強いられた未検査にしない（SP-BPCONFORMANCE-034）');
  const last = graph.units.filter((u) => u.value.startsWith('SP-BPCONFORMANCE-014/権限/t1/r')).at(-1).value;
  assert.ok(graph.forced.includes(last));
  for (const r of rows) for (const f of r.forced) assert.ok(r.units.some((u) => u.value === f), `行 ${r.row}: ${f}`);
});

test('SP-BPAUTHORING-038・SP-BPAUTHORING-039: 仕様項目 ID の閉集合が bp-conformance の全ての仕様項目の見出しと一致する', () => {
  const text = readFileSync(path.join(DOCS, 'specifications', 'bp-conformance.md'), 'utf8');
  const headings = [...text.matchAll(/^#### (SP-BPCONFORMANCE-\d{3})/gm)].map((m) => m[1]).sort();
  assert.deepEqual(specItemIds(DOCS), headings);
});
