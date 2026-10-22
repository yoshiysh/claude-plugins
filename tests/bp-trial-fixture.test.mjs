import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetTexts } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/assets.mjs';
import { specUnits } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/kinds.mjs';
import { applicability } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/units.mjs';
import { CRITERIA, EXPECTED_FILE, FIXTURE_DIR, MEASURES, belongs, forcedBy, inject, injectable, pick, read } from '../tools/read-bp-trial.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED = JSON.parse(readFileSync(EXPECTED_FILE, 'utf8'));
const ROW = applicability(CRITERIA).find((r) => r.row === EXPECTED.row);
const spOf = (unit) => unit.split('/')[0];

async function tmp(t) {
  const dir = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'bp-trial-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// 試走の表（bp-conformance の「検証方法」）のうち、review の試走で測る行。
function reviewTrialRows() {
  const lines = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-conformance.md'), 'utf8').split('\n');
  const at = lines.indexOf('| 要求 ID | 仕様項目 ID | 測る試走 |');
  const rows = [];
  for (const l of lines.slice(at + 2)) {
    if (!l.startsWith('|')) break;
    const [req, spec, how] = l.split('|').slice(1, -1).map((c) => c.trim());
    if (how.startsWith('review の試走')) rows.push({ req, spec });
  }
  return rows;
}

test('検証方法（bp-conformance）: 試走の題材の正解表の単位が全て、判定基準の写しから作った閉集合と、題材が到達する判定表の行の単位にあり、強いられた未検査を含まない', () => {
  assert.equal(ROW.form, '探索グラフ型');
  assert.deepEqual([ROW.ledger, ROW.fanout], ['有', '有']);
  const spec = new Set(specUnits(CRITERIA).map((u) => u.value));
  for (const i of EXPECTED.injections) {
    if (i.viewpoint === 'spec') assert.ok(spec.has(i.unit), i.unit);
    else {
      assert.equal(i.viewpoint, 'flow');
      assert.ok(injectable(CRITERIA, EXPECTED.row, spOf(i.unit)).includes(i.unit), `フローの観点が指摘にできない単位: ${i.unit}`);
    }
    assert.ok(!ROW.forced.includes(i.unit), i.unit);
  }
});

test('検証方法（bp-conformance）: フローの観点の仕込む単位は、種と仕様項目から決まる単位で、人が選んでいない', () => {
  for (const i of EXPECTED.injections.filter((x) => x.viewpoint === 'flow')) {
    assert.equal(i.unit, pick(EXPECTED.seed, spOf(i.unit), injectable(CRITERIA, EXPECTED.row, spOf(i.unit))));
  }
});

test('検証方法（bp-conformance）: 同じ単位を 2 回仕込まず、フローの観点の違反は資産 1 つに 1 つだけで、仕込んだ後の版で各違反が申告した資産に入る', async (t) => {
  const units = EXPECTED.injections.map((i) => `${i.viewpoint}|${i.unit}`);
  assert.equal(new Set(units).size, units.length);
  const places = EXPECTED.injections.filter((i) => i.viewpoint === 'flow').map((i) => `${i.file}|${JSON.stringify(i.section)}`);
  assert.equal(new Set(places).size, places.length);
  for (const i of EXPECTED.injections) {
    const text = readFileSync(path.join(FIXTURE_DIR, i.file), 'utf8');
    assert.equal(text.split(i.from).length, 2, `仕込む前の版で置き換え元がちょうど 1 回現れない: ${i.unit}`);
    assert.ok(!text.includes(i.to), `仕込む前の版に違反が既にある: ${i.unit}`);
  }
  const out = await tmp(t);
  inject(EXPECTED, out);
  for (const i of EXPECTED.injections) {
    const assets = assetTexts(i.file, readFileSync(path.join(out, i.file)));
    const holder = assets.filter((a) => a.text.includes(i.to));
    assert.equal(holder.length, 1, i.unit);
    const loc = holder[0].loc;
    if (i.section === null) assert.equal(loc.k, 'file', i.unit);
    else assert.deepEqual([loc.k, loc.h.map((x) => x[1])], ['sec', i.section], i.unit);
  }
});

test('検証方法（bp-conformance）: 置き換え元が仕込む前の版にちょうど 1 回現れない正解表では、仕込みが落ちる', async (t) => {
  const out = await tmp(t);
  const broken = { ...EXPECTED, injections: [{ ...EXPECTED.injections[0], from: '題材に無い文' }] };
  assert.throws(() => inject(broken, out), /ちょうど 1 回現れない/);
  const twice = { ...EXPECTED, injections: [EXPECTED.injections[0], EXPECTED.injections[0]] };
  const again = await tmp(t);
  assert.throws(() => inject(twice, again), /ちょうど 1 回現れない/);
});

test('検証方法（bp-conformance）: 試走の表で review の試走が測る行の全ての仕様項目 ID に、仕込み・強いられた未検査・run 全体・測らないのどれかの読み方があり、強いられた未検査は写しの出所と一致する', () => {
  assert.deepEqual(EXPECTED.rows.map((r) => `${r.req}|${r.spec}`), reviewTrialRows().map((r) => `${r.req}|${r.spec}`));
  for (const row of EXPECTED.rows) {
    assert.deepEqual(Object.keys(row.measures), row.spec.split(',').map((s) => s.trim()), row.req);
    for (const [sp, m] of Object.entries(row.measures)) {
      assert.ok(Object.values(MEASURES).includes(m.by), `${row.req} ${sp}`);
      if (m.by === MEASURES.injection) assert.ok(EXPECTED.injections.some((i) => belongs(i.unit, sp)), `${row.req}: 仕込みが無い ${sp}`);
      if (m.by === MEASURES.forced) assert.deepEqual(m.units, forcedBy(CRITERIA, EXPECTED.row, sp), `${row.req} ${sp}`);
      if (m.by === MEASURES.forced) assert.ok(!EXPECTED.injections.some((i) => belongs(i.unit, sp) || m.units.includes(i.unit)), `${row.req}: 強いられた未検査に仕込んだ ${sp}`);
      if (m.by === MEASURES.none) assert.ok(m.reason, `${row.req} ${sp}`);
    }
  }
});

function finding(i, extra = {}) {
  const loc = i.section === null ? { k: 'file' } : { k: 'sec', h: i.section.map((t, n) => [n + 1, t]), n: 1 };
  return { viewpoint: i.viewpoint, kind: i.unit, state: 'open', assets: [{ id: 'A', path: i.file, loc }], ...extra };
}

function injectedResult(findings) {
  const forced = EXPECTED.rows.flatMap((r) => Object.values(r.measures)).filter((m) => m.by === MEASURES.forced).flatMap((m) => m.units);
  return { findings, applicability: { row: EXPECTED.row }, uncheckedViewpoints: forced.map((value) => ({ viewpoint: 'flow', scope: 'unit', value, reason: 'x' })) };
}

test('検証方法（bp-conformance）: 試走の読み取りが、全て当たった run では測らない句の無い行だけを完了にし、基準の run の指摘か干渉があれば全ての行を作成中にする', () => {
  const clean = { findings: [] };
  const all = read({ baseline: clean, injected: injectedResult(EXPECTED.injections.map((i) => finding(i))), expected: EXPECTED });
  assert.equal(all.valid, true);
  assert.equal(all.hits, EXPECTED.injections.length);
  for (const r of all.rows) {
    const unmeasured = Object.values(EXPECTED.rows.find((x) => x.req === r.req).measures).some((m) => m.by === MEASURES.none);
    assert.equal(r.status, unmeasured ? '作成中' : '完了', r.req);
  }

  const [first, ...rest] = EXPECTED.injections;
  const swapped = read({ baseline: clean, injected: injectedResult([finding(first, { kind: rest.find((i) => i.viewpoint === first.viewpoint).unit }), ...rest.map((i) => finding(i))]), expected: EXPECTED });
  assert.equal(swapped.interference, 1);
  assert.equal(swapped.valid, false);
  assert.ok(swapped.rows.every((r) => r.status === '作成中'));

  const dirty = read({ baseline: { findings: [finding(first)] }, injected: injectedResult(EXPECTED.injections.map((i) => finding(i))), expected: EXPECTED });
  assert.equal(dirty.baselineFindings, 1);
  assert.ok(dirty.rows.every((r) => r.status === '作成中'));

  const missed = read({ baseline: clean, injected: injectedResult(rest.map((i) => finding(i))), expected: EXPECTED });
  assert.equal(missed.valid, true);
  const own = EXPECTED.rows.filter((r) => Object.keys(r.measures).some((sp) => belongs(first.unit, sp)));
  for (const r of missed.rows.filter((x) => own.some((o) => o.req === x.req))) assert.equal(r.status, '作成中', r.req);
});
