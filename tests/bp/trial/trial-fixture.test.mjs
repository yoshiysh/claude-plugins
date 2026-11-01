import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetTexts } from '../../../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/assets.mjs';
import { specUnits } from '../../../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/kinds.mjs';
import { applicability, forcedReason } from '../../../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/units.mjs';
import { CRITERIA, EXPECTED_FILE, FIXTURE_DIR, MEASURES, belongs, forcedBy, forcedReasons, inject, injectable, main, pick, read, render } from '../../../tools/read-bp-trial.mjs';
import { tableAfter, testTitles } from '../helpers/docs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXPECTED = JSON.parse(readFileSync(EXPECTED_FILE, 'utf8'));
const ROW = applicability(CRITERIA).find((r) => r.row === EXPECTED.row);
const spOf = (unit) => unit.split('/')[0];

async function tmp(t) {
  const dir = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'bp-trial-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function reviewTrialRows() {
  const text = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-conformance.md'), 'utf8');
  return tableAfter(text, '| 要求 ID | 仕様項目 ID | 測る試走 |').filter(([, , how]) => how.startsWith('review の試走')).map(([req, spec]) => ({ req, spec }));
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

test('検証方法（bp-conformance）: 試走の表で review の試走が測る行の全ての仕様項目 ID に、仕込み・強いられた未検査・run 全体・測らないのどれかの読み方があり、強いられた未検査は写しの出所と一致し、決定的なテストで測る句はそのテストがある', () => {
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
    for (const u of row.unmeasured ?? []) assert.ok(u.clause && u.reason, row.req);
    for (const d of row.deterministic ?? []) {
      const titles = testTitles(path.join(ROOT, d.test));
      assert.ok(titles.some((t) => t.includes(d.id)), `${row.req}: ${d.test} に ${d.id} のテストが無い（${d.clause}）`);
    }
  }
});

test('検証方法（bp-conformance）: 正解表の強いられた未検査は題材の行の強いられた未検査の全てで、フローの観点の仕込みごとに、選ばなかった単位を確かめていない単位として持つ', () => {
  assert.deepEqual(EXPECTED.forced, forcedReasons(CRITERIA, EXPECTED.row));
  assert.deepEqual(EXPECTED.forced.map((f) => f.unit), ROW.forced);
  for (const i of EXPECTED.injections) {
    if (i.viewpoint !== 'flow') assert.equal(i.unseen, undefined, i.unit);
    else assert.deepEqual(i.unseen, injectable(CRITERIA, EXPECTED.row, spOf(i.unit)).filter((u) => u !== i.unit), i.unit);
  }
});

function finding(i, extra = {}) {
  const loc = i.section === null ? { k: 'file' } : { k: 'sec', h: i.section.map((t, n) => [n + 1, t]), n: 1 };
  return { viewpoint: i.viewpoint, kind: i.unit, state: 'open', assets: [{ id: 'A', path: i.file, loc }], ...extra };
}

const CLEAN = { stopKind: 'complete', findings: [], applicability: { row: EXPECTED.row } };

function injectedResult(findings, extra = {}) {
  return { stopKind: 'complete', findings, applicability: { row: EXPECTED.row }, uncheckedViewpoints: EXPECTED.forced.map((f) => ({ viewpoint: 'flow', scope: 'unit', value: f.unit, reason: f.reason })), ...extra };
}

const ALL = () => EXPECTED.injections.map((i) => finding(i));
const allPending = (r) => r.rows.every((x) => x.status === '作成中');

test('検証方法（bp-conformance）: 試走の読み取りが、全て当たった run では試走で測らない句の無い行だけを完了にする', () => {
  const all = read({ baseline: CLEAN, injected: injectedResult(ALL()), expected: EXPECTED });
  assert.equal(all.valid, true);
  assert.equal(all.hits, EXPECTED.injections.length);
  for (const r of all.rows) {
    const row = EXPECTED.rows.find((x) => x.req === r.req);
    const unmeasured = Object.values(row.measures).some((m) => m.by === MEASURES.none) || (row.unmeasured ?? []).length > 0;
    assert.equal(r.status, unmeasured ? '作成中' : '完了', r.req);
  }
  assert.ok(all.rows.some((r) => r.status === '完了') && all.rows.some((r) => r.unmeasured.length && r.status === '作成中'));
});

test('検証方法（bp-conformance）: 基準の run の完了・指摘 0・行への到達、仕込んだ版の完了・行への到達、返り値の findings と未検査の観点の欄のどれかが欠けるか、干渉があれば、全ての行を作成中にする', () => {
  const [first, ...rest] = EXPECTED.injections;
  const cases = {
    基準の指摘: { baseline: { ...CLEAN, findings: [finding(first)] } },
    基準の未完了: { baseline: { stopKind: 'blocked', findings: [] } },
    基準の行違い: { baseline: { ...CLEAN, applicability: { row: EXPECTED.row - 1 } } },
    仕込みの未完了: { injected: injectedResult(ALL(), { stopKind: 'blocked' }) },
    仕込みの行違い: { injected: injectedResult(ALL(), { applicability: { row: EXPECTED.row - 1 } }) },
    仕込みの行無し: { injected: injectedResult(ALL(), { applicability: undefined }) },
    '基準の findings の欠け': { baseline: { stopKind: 'complete', applicability: { row: EXPECTED.row } } },
    '仕込みの findings の欠け': { injected: injectedResult(undefined) },
    仕込みの未検査の観点の欠け: { injected: injectedResult(ALL(), { uncheckedViewpoints: undefined }) },
    干渉: { injected: injectedResult([finding(first, { kind: rest.find((i) => i.viewpoint === first.viewpoint).unit }), ...rest.map((i) => finding(i))]) },
  };
  for (const [label, c] of Object.entries(cases)) {
    const r = read({ baseline: c.baseline ?? CLEAN, injected: c.injected ?? injectedResult(ALL()), expected: EXPECTED });
    assert.equal(r.valid, false, label);
    assert.ok(allPending(r), label);
  }
});

test('検証方法（bp-conformance）: 行の仕様項目の偽陽性（どの指摘かを出す）・外れ・強いられた未検査の欠けと範囲や理由の違いは、その行だけを作成中にする', () => {
  const [first, ...rest] = EXPECTED.injections;
  const ownRows = (unit) => EXPECTED.rows.filter((r) => Object.keys(r.measures).some((sp) => belongs(unit, sp))).map((r) => r.req);
  const missed = read({ baseline: CLEAN, injected: injectedResult(rest.map((i) => finding(i))), expected: EXPECTED });
  assert.equal(missed.valid, true);
  for (const r of missed.rows.filter((x) => ownRows(first.unit).includes(x.req))) assert.equal(r.status, '作成中', r.req);

  const spec = EXPECTED.injections.find((i) => i.viewpoint === 'spec');
  const elsewhere = finding({ ...spec, file: 'SKILL.md', section: ['trace-cause'] });
  const stray = read({ baseline: CLEAN, injected: injectedResult([...ALL(), elsewhere]), expected: EXPECTED });
  assert.equal(stray.valid, true);
  for (const r of stray.rows) {
    if (!ownRows(spec.unit).includes(r.req)) continue;
    assert.equal(r.status, '作成中', r.req);
    assert.ok(r.falsePositives.some((f) => f.includes(spec.unit) && f.includes('SKILL.md#trace-cause')), `${r.req}: どの偽陽性かを出さない`);
  }
  assert.ok(stray.rows.some((r) => r.status === '完了'), '偽陽性の無い行は完了のまま');

  const permission = EXPECTED.forced.find((f) => f.unit.startsWith('SP-BPCONFORMANCE-014/'));
  const listed = (edit) => injectedResult(ALL(), { uncheckedViewpoints: EXPECTED.forced.map((f) => ({ viewpoint: 'flow', scope: 'unit', value: f.unit, reason: f.reason, ...(f === permission ? edit : {}) })) });
  for (const [label, edit] of [['欠け', null], ['範囲の違い', { scope: 'whole' }], ['理由の違い', { reason: 'SP-BPCONFORMANCE-034' }]]) {
    const injected = edit === null ? injectedResult(ALL(), { uncheckedViewpoints: EXPECTED.forced.filter((f) => f !== permission).map((f) => ({ viewpoint: 'flow', scope: 'unit', value: f.unit, reason: f.reason })) }) : listed(edit);
    const r = read({ baseline: CLEAN, injected, expected: EXPECTED });
    assert.equal(r.rows.find((x) => x.req === 'PR-BPDESIGNEDSKILL-010').status, '作成中', label);
  }
});

test('検証方法（bp-conformance）: 読み取りの出力が、確かめていない単位を仕込みごとに宣言し、tool の入口が使い方の誤りを 2 で返す', async (t) => {
  const r = read({ baseline: CLEAN, injected: injectedResult(ALL()), expected: EXPECTED });
  const text = render(r);
  for (const i of EXPECTED.injections.filter((x) => x.viewpoint === 'flow' && x.unseen.length)) {
    assert.ok(text.includes(`（仕込んだ単位 ${i.unit}）: ${i.unseen.join(' ')}`), i.unit);
  }
  assert.ok(text.includes('| 要求 ID | 仕様項目 ID | 句ごとの読み | 判定 |'));
  assert.equal(main(['bogus']).exitCode, 2);
  const dir = await tmp(t);
  const b = path.join(dir, 'b.json');
  const i = path.join(dir, 'i.json');
  await fs.writeFile(b, JSON.stringify(CLEAN));
  await fs.writeFile(i, JSON.stringify(injectedResult(ALL())));
  const out = main(['read', '--baseline', b, '--injected', i]);
  assert.equal(out.exitCode, 0);
  assert.equal(out.text, text);
});

test('SP-BPINSPECTION-025: 強いられた未検査の理由は CLI の forcedReason 1 箇所で決め、読み取りの tool は理由を自分で計算しない', () => {
  const sources = { always: new Map([['u', 'SP-BPCONFORMANCE-019']]) };
  assert.equal(forcedReason(sources, 'u'), 'SP-BPCONFORMANCE-019');
  const tool = readFileSync(path.join(ROOT, 'tools', 'read-bp-trial.mjs'), 'utf8');
  assert.doesNotMatch(tool, /\b(always|turnForm)\.get\(/);
  const ops = readFileSync(path.join(ROOT, 'plugins', 'skill-creator', 'skills', 'skill-creator-best-practices', 'scripts', 'bp', 'ops-inspect.mjs'), 'utf8');
  assert.doesNotMatch(ops, /\b(always|turnForm)\.get\(/);
});
