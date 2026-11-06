import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKinds, conformanceUnits } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/kinds.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');

function functionalSpIds() {
  const text = readFileSync(path.join(DOCS, 'specifications', 'bp-conformance.md'), 'utf8');
  const chapter = text.split(/^## /m).find((c) => c.startsWith('機能仕様'));
  return [...chapter.matchAll(/^#### (SP-BPCONFORMANCE-\d{3})/gm)].map((m) => m[1]);
}

test('SP-BPFINDINGS-010: 実際の docs/ から、「機能仕様」の章の全ての仕様項目が 1 つ以上の判定の単位に解決する', () => {
  const units = conformanceUnits(DOCS);
  assert.deepEqual(units.map((u) => u.sp), functionalSpIds());
  for (const u of units) assert.ok(u.units.length > 0, u.sp);
});

test('SP-BPFINDINGS-010: 原則の表の行を判定の単位にする仕様項目は SP-BPCONFORMANCE-010〜017 だけで、参照した節の表が全て見つかる', () => {
  const units = conformanceUnits(DOCS);
  assert.deepEqual(units.filter((u) => u.rowUnits).map((u) => u.sp), [10, 11, 12, 13, 14, 15, 16, 17].map((n) => `SP-BPCONFORMANCE-0${n}`));
  const s015 = units.find((u) => u.sp === 'SP-BPCONFORMANCE-015').units.map((u) => u.value);
  for (const sub of ['探索グラフ/計画役/t1', '探索グラフ/実行役・回収役・検証役/t1', '探索グラフ/実行役・回収役・検証役/t2', '探索グラフ/停止/t1']) {
    assert.ok(s015.some((v) => v.includes(`/${sub}/`)), sub);
  }
  assert.ok(units.find((u) => u.sp === 'SP-BPCONFORMANCE-017').units.some((u) => /\/b1$/.test(u.value)));
  const values = units.flatMap((u) => u.units.map((x) => x.value));
  assert.equal(new Set(values).size, values.length);
});

test('SP-BPFINDINGS-010: 実際の docs/ から仕様・目標・契約・監査の観点の閉集合を作れる', () => {
  const kinds = buildKinds(DOCS, 'update');
  assert.deepEqual(kinds.spec.map((k) => k.value), [27, 28, 29, 30, 31, 32, 33, 35, 36].map((n) => `SP-BPCONFORMANCE-0${n}`));
  assert.ok(kinds.goal.some((k) => k.value === '目標:修正の根拠の未反映'));
  assert.ok(!buildKinds(DOCS, 'create').goal.some((k) => k.value === '目標:修正の根拠の未反映'));
  assert.equal(kinds.contract.length, 5);
  assert.deepEqual(kinds.audit.map((k) => k.value), ['PA-1', 'PA-2', 'PA-3', 'PA-4', 'PA-5', 'PA-6']);
});

// ---- review のフローの観点から除く単位（SP-BPINSPECTION-007）と prompt-audit

import { flowExclusions, flowUnits } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/kinds.mjs';

const SKILL = path.join(ROOT, 'plugins', 'skill-creator', 'skills', 'skill-creator-best-practices');
// 原則の表の行ではなく役ごとの表を指すので、除く単位を持たない文（bp-inspection の SP-BPINSPECTION-007 の表の前の段落）。
const NO_ROW = { 'SP-BPCONFORMANCE-013': '役ごとのモデルと effort は役ごとの表で判定する' };

test('SP-BPINSPECTION-007: 除く単位の表の全ての単位が実際の docs の判定の単位にあり、「性能・容量」の章の値で判定するとした文の全てが表の 1 行以上の出所である', () => {
  const text = readFileSync(path.join(DOCS, 'specifications', 'bp-conformance.md'), 'utf8');
  const capacity = text.slice(text.indexOf('## 性能・容量'));
  const capacityIds = new Set([...capacity.matchAll(/^#### (SP-BPCONFORMANCE-\d{3})/gm)].map((m) => m[1]));
  const functional = text.split(/^## /m).find((c) => c.startsWith('機能仕様'));
  const sources = [];
  for (const block of functional.split(/^#### /m).slice(1)) {
    const id = /^(SP-BPCONFORMANCE-\d{3})/.exec(block)[1];
    for (const m of block.matchAll(/SP-BPCONFORMANCE-(\d{3})(?:〜(\d+))? (?:の値)?で判定する/g)) {
      const from = Number(m[1]);
      const to = m[2] ? Number(m[2]) : from;
      const refs = Array.from({ length: to - from + 1 }, (_, i) => `SP-BPCONFORMANCE-${String(from + i).padStart(3, '0')}`);
      if (refs.every((r) => capacityIds.has(r))) sources.push({ id, refs });
    }
  }
  assert.deepEqual(sources.map((s) => s.id), ['SP-BPCONFORMANCE-012', 'SP-BPCONFORMANCE-013', 'SP-BPCONFORMANCE-015', 'SP-BPCONFORMANCE-016']);
  const table = flowExclusions(DOCS);
  const all = new Set(conformanceUnits(DOCS).flatMap((u) => u.units.map((x) => x.value)));
  for (const e of table) {
    assert.ok(all.has(e.unit), e.unit);
    assert.ok(capacityIds.has(e.by), e.by);
  }
  for (const s of sources) {
    const rows = table.filter((e) => e.unit.startsWith(`${s.id}/`));
    if (NO_ROW[s.id]) assert.deepEqual(rows, [], s.id);
    else {
      assert.ok(rows.length > 0, `${s.id} の文に当たる除く単位が無い`);
      for (const r of rows) assert.ok(s.refs.includes(r.by) || sources.filter((x) => x.id === s.id).some((x) => x.refs.includes(r.by)), `${r.unit} → ${r.by}`);
    }
  }
});

test('SP-BPINSPECTION-007: フローの観点の閉集合に除く単位が無く、create・update の適合の観点の閉集合には残る', () => {
  const excluded = flowExclusions(DOCS).map((e) => e.unit);
  const flow = new Set(flowUnits(DOCS).map((u) => u.value));
  const conformance = new Set(buildKinds(DOCS, 'create').conformance.map((u) => u.value));
  for (const u of excluded) {
    assert.ok(!flow.has(u), u);
    assert.ok(conformance.has(u), u);
  }
  assert.equal(conformance.size - flow.size, excluded.length);
});

import { auditUnits } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/kinds.mjs';
import { auditItems, compareAudit } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/targets.mjs';
import { applicability } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/units.mjs';
import { APPLICABILITY_ANSWERS, PRESENCE, SHAPES } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';

test('SP-BPINSPECTION-010: 今の prompt-audit の「Finding criteria」の番号付きの項目が、実際の docs の SP-BPINSPECTION-009 の表と件数・番号・名前で一致する', () => {
  const items = auditItems(readFileSync(path.join(SKILL, 'references', 'prompt-audit.md'), 'utf8'));
  assert.equal(items.length, 6);
  assert.deepEqual(compareAudit(items, auditUnits(DOCS)), []);
});

test('SP-BPINSPECTION-006: 適用の判定の選択肢と形の閉集合が、SP-BPINSPECTION-006 の表と SP-BPCONFORMANCE-003 の判定表の字面と一致し、判定表の全ての行に到達できる', () => {
  const inspection = readFileSync(path.join(DOCS, 'specifications', 'bp-inspection.md'), 'utf8');
  const choices = [...inspection.slice(inspection.indexOf('| 問い | 選択肢 | 判定基準 |')).split('\n').slice(2, 5).join('\n').matchAll(/^\|[^|]+\| ([^|]+) \|/gm)].map((m) => m[1].split(' / '));
  assert.deepEqual(choices, [Object.values(APPLICABILITY_ANSWERS), Object.values(PRESENCE), Object.values(PRESENCE)]);
  const rows = applicability(DOCS);
  assert.deepEqual([...new Set(rows.map((r) => r.form))].sort(), Object.values(SHAPES).sort());
  assert.ok(rows.every((r) => [...Object.values(PRESENCE), '*'].includes(r.ledger) && [...Object.values(PRESENCE), '*'].includes(r.fanout)));
});

test('SP-BPINSPECTION-005: 読める章の閉集合（CRITERIA_CHAPTERS）が、実際の docs の bp-conformance の章の見出しと一致する', async () => {
  const { CRITERIA_CHAPTERS } = await import('../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs');
  const titles = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-conformance.md'), 'utf8').split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
  const capacity = titles.filter((t) => t.startsWith(CRITERIA_CHAPTERS.capacityPrefix));
  assert.equal(capacity.length, 1);
  assert.deepEqual(titles.filter((t) => !capacity.includes(t) && t !== CRITERIA_CHAPTERS.functional).sort(), [...CRITERIA_CHAPTERS.others].sort());
});
