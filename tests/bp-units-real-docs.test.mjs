import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicability, specItemIds } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/units.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');

test('SP-BPCONFORMANCE-003・SP-BPAUTHORING-017: 実際の docs/ から、適用の判定表の全ての行が空でない判定の単位の集合に解決する', () => {
  const text = readFileSync(path.join(DOCS, 'specifications', 'bp-conformance.md'), 'utf8');
  const section = text.slice(text.indexOf('#### SP-BPCONFORMANCE-003'), text.indexOf('#### SP-BPCONFORMANCE-004'));
  const specRows = section.split('\n').filter((l) => /^\| (ターンごとの指揮|固定パイプライン型|固定集合の反復型|探索グラフ型) \|/.test(l));
  const rows = applicability(DOCS);
  assert.equal(rows.length, specRows.length);
  for (const r of rows) {
    assert.ok(r.units.length > 0, `行 ${r.row}`);
    for (const always of ['001', '002', '006', '014', '015']) assert.ok(r.requirements.includes(`PR-BPDESIGNEDSKILL-${always}`), `行 ${r.row}: ${always}`);
  }
  assert.deepEqual(rows[3].requirements.map((x) => x.slice(-3)), ['001', '002', '004', '005', '006', '007', '008', '009', '010', '014', '015', '018', '046', '051']);
});

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
  for (const r of rows) for (const f of r.forced) assert.ok(r.units.some((u) => u.value === f), `行 ${r.row}: ${f}`);
});

test('SP-BPAUTHORING-038・SP-BPAUTHORING-039: 仕様項目 ID の閉集合が bp-conformance の全ての仕様項目の見出しと一致する', () => {
  const text = readFileSync(path.join(DOCS, 'specifications', 'bp-conformance.md'), 'utf8');
  const headings = [...text.matchAll(/^#### (SP-BPCONFORMANCE-\d{3})/gm)].map((m) => m[1]).sort();
  assert.deepEqual(specItemIds(DOCS), headings);
});
