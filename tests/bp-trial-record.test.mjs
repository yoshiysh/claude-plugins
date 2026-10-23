import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SKILL_DIR, checkWorktree, criteriaBody, fingerprint, launchesOf, sameFingerprint } from '../tools/bp-trial.mjs';
import { confirmedKeys, readRecords, rowKey, traceRows } from '../tools/read-bp-trial.mjs';
import { CRITERIA_DIR } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { buildView } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/view.mjs';
import { tmp } from './helpers/bp-harness.mjs';

// 配布する skill の写しを plugin の形（<plugin>/skills/<skill>）で一時ディレクトリに作る。script を workflows/ へ移す変異を試すため。
async function skillCopy(t) {
  const plugin = path.join(await tmp(t, 'bp-fp-'), 'p');
  const skill = path.join(plugin, 'skills', 's');
  await fs.mkdir(path.dirname(skill), { recursive: true });
  await fs.cp(SKILL_DIR, skill, { recursive: true, filter: (src) => !src.includes(`${path.sep}eval-viewer`) });
  return { plugin, skill, conformance: path.join(skill, CRITERIA_DIR, 'specifications', 'bp-conformance.md') };
}

async function edit(file, from, to) {
  const text = await fs.readFile(file, 'utf8');
  assert.ok(text.includes(from), `置き換え元が無い: ${from}`);
  await fs.writeFile(file, text.replace(from, to));
}

test('検証方法: 判定基準の写しのトレーサビリティ表のステータス・検証方法の 1 文・TBD の行・入口の操作のモジュールを変えても、script を workflows/ へ移しても、試走の記録の指紋は変わらない', async (t) => {
  const c = await skillCopy(t);
  const before = fingerprint(c.skill);
  await edit(c.conformance, '| 完了 |', '| 作成中 |');
  await edit(c.conformance, '- 判定表・形の判定（SP-BPCONFORMANCE-003〜009）:', '- 判定表と形の判定（SP-BPCONFORMANCE-003〜009）:');
  await edit(c.conformance, '| TBD-SBPCONFORMANCE-', '| TBD-SBPCONFORMANCEX-');
  await edit(path.join(c.skill, 'scripts', 'bp', 'ops-entry.mjs'), 'timeoutMs: 3_600_000', 'timeoutMs: 7_200_000');
  await fs.mkdir(path.join(c.plugin, 'workflows'));
  for (const f of ['bp_author.js', 'bp_inspect.js']) await fs.rename(path.join(c.skill, 'scripts', f), path.join(c.plugin, 'workflows', f));
  assert.ok(sameFingerprint(fingerprint(c.skill), before));
});

test('検証方法: 判定基準の写しの規範の文・script・run の中で使う CLI のモジュール・prompt-audit を 1 字変えると、試走の記録の指紋が変わる', async (t) => {
  const changes = [
    (c) => edit(c.conformance, '3 体以下でなければならない', '4 体以下でなければならない'),
    (c) => edit(path.join(c.skill, 'scripts', 'bp_author.js'), "const PAYLOAD_MODE = 'file'", "const PAYLOAD_MODE = 'inline'"),
    (c) => edit(path.join(c.skill, 'scripts', 'bp', 'ops-run.mjs'), 'export function nextArgs(view) {', 'export function nextArgs(view)  {'),
    (c) => edit(path.join(c.skill, 'references', 'prompt-audit.md'), '# Prompt audit criteria', '# Prompt audit criteria.'),
  ];
  for (const change of changes) {
    const c = await skillCopy(t);
    const before = fingerprint(c.skill);
    await change(c);
    assert.ok(!sameFingerprint(fingerprint(c.skill), before), change.toString());
  }
  assert.equal(criteriaBody('# x\n本文\n## トレーサビリティ表\n| a |\n## 機能仕様\n規範\n'), '# x\n本文\n## 機能仕様\n規範\n');
});

const A1_RESULT = {
  stopKind: 'complete',
  findings: [],
  ledger: { coverage: [{ viewpoint: 'audit', seen: 7, total: 7, ratio: '7/7' }] },
  uncheckedViewpoints: [
    { viewpoint: 'audit', scope: 'pa', value: 'PA-3', reason: 'x', run: 'r1' },
    { viewpoint: 'audit', scope: 'pa', value: 'PA-4', reason: 'y', run: 'r1' },
  ],
};

async function records(t, map) {
  const dir = await tmp(t, 'bp-records-');
  for (const [name, rec] of Object.entries(map)) await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(rec));
  return dir;
}

function keysOf(rows, run) {
  return rows.filter((r) => r.run === run).map(rowKey);
}

test('検証方法: 今の指紋の記録で全ての句が当たった行だけが確かめた行の集合に入り、記録が無いか指紋の古い記録の行は入らない', async (t) => {
  const current = fingerprint();
  const fresh = await records(t, { A1: { run: 'A1', function: 'audit', result: A1_RESULT, fingerprint: current } });
  const rows = readRecords({ recordsDir: fresh, current });
  const a1 = keysOf(rows, 'A1');
  assert.equal(a1.length, 3);
  assert.deepEqual([...confirmedKeys(rows)].sort(), [...a1].sort());
  const stale = await records(t, { A1: { run: 'A1', function: 'audit', result: A1_RESULT, fingerprint: { ...current, promptAudit: '0'.repeat(64) } } });
  assert.equal(confirmedKeys(readRecords({ recordsDir: stale, current })).size, 0);
  assert.equal(confirmedKeys(readRecords({ recordsDir: await records(t, {}), current })).size, 0);
  const missed = { ...A1_RESULT, uncheckedViewpoints: A1_RESULT.uncheckedViewpoints.slice(0, 1) };
  const partial = await records(t, { A1: { run: 'A1', function: 'audit', result: missed, fingerprint: current } });
  assert.equal(confirmedKeys(readRecords({ recordsDir: partial, current })).size, 2);
});

test('検証方法: 同じ要求 ID と仕様項目 ID を持つ 2 行は検証方法の文言で見分け、片方の句だけが当たった記録はもう片方を確かめた行にしない', async (t) => {
  const current = fingerprint();
  const A = 'bp-authoring.md';
  const pair = traceRows(A).filter((r) => r.req === 'PR-BPOPERATIONS-014' && r.spec === 'SP-BPAUTHORING-033');
  assert.equal(pair.length, 2);
  const result = { stopKind: 'complete', skill: { root: '/x/.agents/skills/lint-zero', files: [] } };
  const dir = await records(t, { C1: { run: 'C1', function: 'create', result, fingerprint: current } });
  const confirmed = confirmedKeys(readRecords({ recordsDir: dir, current }));
  const [path583] = pair.filter((r) => r.method.includes('作ったスキルのディレクトリのパスがある'));
  const [path541] = pair.filter((r) => r.method.includes('設計の説明の場所と逐語の本文'));
  assert.ok(confirmed.has(rowKey(path583)));
  assert.ok(!confirmed.has(rowKey(path541)));
});

test('検証方法: R2 の行は基準の run の記録が無ければ、仕込んだ版の記録があっても確かめた行にしない', async (t) => {
  const current = fingerprint();
  const injected = { stopKind: 'complete', findings: [], uncheckedViewpoints: [], applicability: { row: 15 } };
  const dir = await records(t, { R2: { run: 'R2', function: 'review', result: injected, fingerprint: current } });
  const rows = readRecords({ recordsDir: dir, current }).filter((r) => r.run === 'R2');
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.status === '作成中'));
  assert.ok(rows.some((r) => r.notes.some((n) => /R1 の記録が無い/.test(n))));
});

test('検証方法: 試走の道具は本物の checkout では走らず、worktree でだけ走る', () => {
  assert.throws(() => checkWorktree({ gitDir: '/r/.git', commonDir: '/r/.git' }), /worktree/);
  assert.doesNotThrow(() => checkWorktree({ gitDir: '/r/.git/worktrees/x', commonDir: '/r/.git' }));
});

test('検証方法: 記録の役ごとの起動数は、停止の記録の起動数から項目の試行を役ごとに引いて運搬役の数を出し、E_TRANSPORT の試行の失敗を役ごとに数える', () => {
  const lines = [{
    seq: 1, run: 'r1', op: 'start', records: [
      { t: 'state', id: 'bp-1', key: 'k', function: 'update', limits: { attempts: 3, iterations: 3, untilPass: 3 } },
      { t: 'run', id: 'r1', key: 'k', base: { iterations: 0, repeats: {} } },
      { t: 'paths', n: 1, root: '/x', files: [], unresolved: [] },
      { t: 'stage', stage: 'write', round: 1, items: [{ id: 'I1', key: { iteration: 1 } }] },
      { t: 'result', item: 'I1', result: {} },
      { t: 'stage', stage: 'verify', round: 1, items: [{ id: 'I2', key: { viewpoint: 'conformance' } }] },
      { t: 'fail', item: 'I2', attempt: 1, reason: 'verdicts: E_TRANSPORT 要求の sum が合わない' },
      { t: 'result', item: 'I2', result: {} },
      { t: 'stop', run: 'r1', kind: 'complete', launches: 10 },
    ],
  }];
  const view = buildView(lines);
  const out = launchesOf(view, path.join(SKILL_DIR, CRITERIA_DIR));
  assert.equal(out.total, 10);
  assert.deepEqual(out.byRole['書き手'], { n: 1, model: 'opus', effort: 'high' });
  assert.equal(out.byRole['検証役'].n, 2);
  assert.equal(out.byRole['運搬役'].n, 7);
  assert.deepEqual(out.transport.byRole, { 検証役: 1 });
});
