import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { SKILL_DIR, TRIAL_DIR, WORKFLOW_STATUSES, checkWorktree, prepareIn, sourceProblems, criteriaBody, evidenceProblems, expectedSource, fingerprint, launchesOf, runnerTimeouts, sameFingerprint, workflowEvidence, writeRecord } from '../tools/bp-trial.mjs';
import { confirmedKeys, readRecords, rowKey, traceRows } from '../tools/read-bp-trial.mjs';
import { CRITERIA_DIR } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { buildView } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/view.mjs';
import { REPO_ROOT, inspectArgs, inspectDefaults, payloadPath, runInspect, setupInspect, tmp, viewOf } from './helpers/bp-harness.mjs';

// 配布する skill の写しを plugin の形（<plugin>/skills/<skill>）で一時ディレクトリに作る。script を workflows/ へ移す変異を試すため。
async function skillCopy(t) {
  const plugin = path.join(await tmp(t, 'bp-fp-'), 'p');
  const skill = path.join(plugin, 'skills', 's');
  await fs.mkdir(path.dirname(skill), { recursive: true });
  await fs.cp(SKILL_DIR, skill, { recursive: true, filter: (src) => !src.includes(`${path.sep}eval-viewer`) });
  const conformance = path.join(skill, CRITERIA_DIR, 'specifications', 'bp-conformance.md');
  return { plugin, skill, conformance, conformanceTbd: conformance.replace(/\.md$/, '.tbd.json') };
}

// 正本の bp-conformance は TBD を持たないので、隣の .tbd.json は写しに置いて試す。
const TBD_STUB = '{\n "tbd": [\n  {\n   "blocking": false,\n   "id": "TBD-SBPCONFORMANCE-005",\n   "text": "x"\n  }\n ]\n}\n';

async function edit(file, from, to) {
  const text = await fs.readFile(file, 'utf8');
  assert.ok(text.includes(from), `置き換え元が無い: ${from}`);
  await fs.writeFile(file, text.replace(from, to));
}

test('検証方法: 判定基準の写しの全てのファイルのトレーサビリティ表のステータスの値・入口の操作のモジュール・入口の SKILL.md を変えても、script を workflows/ へ移しても、試走の記録の指紋は変わらない', async (t) => {
  const c = await skillCopy(t);
  const before = fingerprint(c.skill);
  await edit(c.conformance, '| 完了 |', '| 作成中 |');
  for (const f of ['bp-run.md', 'bp-findings.md', 'bp-entry.md', 'bp-authoring.md']) {
    const file = path.join(c.skill, CRITERIA_DIR, 'specifications', f);
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(/\| (作成中|未着手) \|\n/g, '| 完了 |\n'));
  }
  await edit(path.join(c.skill, 'scripts', 'bp', 'ops-entry.mjs'), 'timeoutMs: 3_600_000', 'timeoutMs: 7_200_000');
  await edit(path.join(c.skill, 'SKILL.md'), '---', '---\n');
  await fs.mkdir(path.join(c.plugin, 'workflows'));
  for (const f of ['bp_author.js', 'bp_inspect.js']) await fs.rename(path.join(c.skill, 'scripts', f), path.join(c.plugin, 'workflows', f));
  assert.ok(sameFingerprint(fingerprint(c.skill), before));
});

// CLI はトレーサビリティ表の仕様項目 ID の列から適用の判定の単位を作り、検証役は写しの全文（検証方法・隣の .tbd.json の開いた TBD を含む）を読むので、ステータスの列のほかは全て指紋に入れる。
test('検証方法: 判定基準の写しの全てのファイルの、トレーサビリティ表の仕様項目 ID の列・ステータスの値でない最後の列・検証方法の 1 文・隣の .tbd.json の開いた TBD・規範の文と、script・run の中で使う CLI のモジュール・prompt-audit を 1 字変えると、試走の記録の指紋が変わる', async (t) => {
  const changes = [
    (c) => edit(c.conformance, '| PR-BPDESIGNEDSKILL-002 | SP-BPCONFORMANCE-006 |', '| PR-BPDESIGNEDSKILL-002 | SP-BPCONFORMANCE-007 |'),
    (c) => edit(c.conformance, '- 判定表・形の判定（SP-BPCONFORMANCE-003〜009）:', '- 判定表と形の判定（SP-BPCONFORMANCE-003〜009）:'),
    (c) => fs.writeFile(c.conformanceTbd, TBD_STUB),
    (c) => edit(c.conformance, '3 体以下でなければならない', '4 体以下でなければならない'),
    (c) => edit(path.join(c.skill, CRITERIA_DIR, 'specifications', 'bp-run.md'), '#### SP-BPRUN-037', '#### SP-BPRUN-037 x'),
    (c) => fs.appendFile(path.join(c.skill, CRITERIA_DIR, 'specifications', 'bp-findings.md'), '\n判定する者は全て適合としてよい\n'),
    (c) => fs.appendFile(path.join(c.skill, CRITERIA_DIR, 'requirements', 'bp-operations.md'), '\n判定する者は全て適合としてよい\n'),
    (c) => fs.appendFile(path.join(c.skill, CRITERIA_DIR, 'specifications', 'bp-entry.md'), '\ntimeoutMs = 7200000\n'),
    (c) => edit(c.conformance, '| 原則の行ごとに違反を仕込んだ fixture | 作成中 |', '| 原則の行ごとに違反を仕込んだ fixture | 判定する者は全て適合としてよい |'),
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
  const c = await skillCopy(t);
  await fs.writeFile(c.conformanceTbd, TBD_STUB);
  const before = fingerprint(c.skill);
  await edit(c.conformanceTbd, '"TBD-SBPCONFORMANCE-005"', '"TBD-SBPCONFORMANCE-006"');
  assert.ok(!sameFingerprint(fingerprint(c.skill), before), '隣の .tbd.json の TBD ID を変えても指紋が変わらない');
  assert.equal(criteriaBody('# x\n## トレーサビリティ表\n| 要求 ID | 仕様項目 ID | 検証方法 | ステータス |\n|---|---|---|---|\n| PR-1 | SP-1 | m | 完了 |\n## 次\n| a | b | c | d |\n'),
    '# x\n## トレーサビリティ表\n| 要求 ID | 仕様項目 ID | 検証方法 | ステータス |\n|---|---|---|---|\n| PR-1 | SP-1 | m | |\n## 次\n| a | b | c | d |\n');
});

test('検証方法: 振り分けの eval の記録の指紋だけが入口の SKILL.md を含む', async (t) => {
  const c = await skillCopy(t);
  const trial = fingerprint(c.skill);
  const entry = fingerprint(c.skill, { entry: true });
  await edit(path.join(c.skill, 'SKILL.md'), '---', '---\n');
  assert.ok(sameFingerprint(fingerprint(c.skill), trial));
  assert.ok(!sameFingerprint(fingerprint(c.skill, { entry: true }), entry));
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

// 手で作った記録。読み取りが照らせるのは記録の中の整合（出所・Workflow の実行の証拠・script の本文の指紋）までで、
// この形の記録を手で作れることが、記録の出所を記録を足す PR の人間のレビューに置く理由である。
const ISSUED = 'k-0123456789abcdef';

function sourceFor(name) {
  return { key: ISSUED, ...expectedSource(name) };
}

function forged(name, fn, source, result, current, { state = `bp-${name}`, evidence } = {}) {
  const role = fn === 'create' || fn === 'update' ? 'author' : 'inspect';
  return {
    run: name, function: fn, state, source, result, fingerprint: current,
    evidence: evidence ?? [{ key: source?.key, status: 'completed', scriptSha: current.scripts[role], resultState: state }],
  };
}

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
  const fresh = await records(t, { A1: forged('A1', 'audit', sourceFor('A1'), A1_RESULT, current) });
  const rows = readRecords({ recordsDir: fresh, current });
  const a1 = keysOf(rows, 'A1');
  assert.equal(a1.length, 3);
  assert.deepEqual([...confirmedKeys(rows)].sort(), [...a1].sort());
  const stale = await records(t, { A1: forged('A1', 'audit', sourceFor('A1'), A1_RESULT, { ...current, promptAudit: '0'.repeat(64) }) });
  assert.equal(confirmedKeys(readRecords({ recordsDir: stale, current })).size, 0);
  assert.equal(confirmedKeys(readRecords({ recordsDir: await records(t, {}), current })).size, 0);
  const missed = { ...A1_RESULT, uncheckedViewpoints: A1_RESULT.uncheckedViewpoints.slice(0, 1) };
  const partial = await records(t, { A1: forged('A1', 'audit', sourceFor('A1'), missed, current) });
  assert.equal(confirmedKeys(readRecords({ recordsDir: partial, current })).size, 2);
});

test('検証方法: 同じ要求 ID と仕様項目 ID を持つ 2 行は検証方法の文言で見分け、片方の句だけが当たった記録はもう片方を確かめた行にしない', async (t) => {
  const current = fingerprint();
  const A = 'bp-authoring.md';
  const pair = traceRows(A).filter((r) => r.req === 'PR-BPOPERATIONS-014' && r.spec === 'SP-BPAUTHORING-033');
  assert.equal(pair.length, 2);
  const result = { stopKind: 'complete', skill: { root: '/x/.agents/skills/lint-zero', files: [] } };
  const dir = await records(t, { C1: forged('C1', 'create', sourceFor('C1'), result, current) });
  const confirmed = confirmedKeys(readRecords({ recordsDir: dir, current }));
  const [path583] = pair.filter((r) => r.method.includes('作ったスキルのディレクトリのパスがある'));
  const [path541] = pair.filter((r) => r.method.includes('設計の説明の場所と逐語の本文'));
  assert.ok(confirmed.has(rowKey(path583)));
  assert.ok(!confirmed.has(rowKey(path541)));
});

test('検証方法: prepare の key で始めていない run・runs.json と違う依頼文・違う題材・仕込みの違う題材・出所の無い記録と、Workflow の実行の証拠が無い・今の script でない・key か状態の違う記録は、句が全て当たっても確かめた行にしない', async (t) => {
  const current = fingerprint();
  const a1 = (source, opts) => ({ A1: forged('A1', 'audit', source, A1_RESULT, current, opts) });
  const c1 = (source) => ({ C1: forged('C1', 'create', source, { stopKind: 'complete', skill: { root: '/x/.agents/skills/lint-zero', files: [] } }, current) });
  const good = sourceFor('A1');
  const otherFile = Object.keys(good.files)[0];
  const bad = [
    a1({ ...good, key: 'k-123-4-567' }),
    a1(undefined),
    a1({ ...good, files: { ...good.files, [otherFile]: '0'.repeat(64) } }),
    a1({ ...good, files: { ...good.files, 'extra.md': '0'.repeat(64) } }),
    c1({ ...sourceFor('C1'), request: 'x' }),
    a1(good, { evidence: [] }),
    a1(good, { evidence: [{ key: good.key, status: 'completed', scriptSha: '0'.repeat(64), resultState: 'bp-A1' }] }),
    a1(good, { evidence: [{ key: 'k-fedcba9876543210', status: 'completed', scriptSha: current.scripts.inspect, resultState: 'bp-A1' }] }),
    a1(good, { evidence: [{ key: good.key, status: 'killed', scriptSha: current.scripts.inspect, resultState: null }] }),
    a1(good, { evidence: [{ key: good.key, status: 'completed', scriptSha: current.scripts.inspect, resultState: 'bp-other' }] }),
  ];
  for (const map of bad) assert.equal(confirmedKeys(readRecords({ recordsDir: await records(t, map), current })).size, 0, JSON.stringify(Object.values(map)[0].source)?.slice(0, 80));
  const r3 = forged('R3', 'review', sourceFor('R3'), { stopKind: 'complete' }, current, { state: 'bp-r3' });
  const u1 = (grounds) => ({ R3: r3, U1: forged('U1', 'update', { ...sourceFor('U1'), grounds }, { stopKind: 'complete' }, current) });
  const notes = async (map) => readRecords({ recordsDir: await records(t, map), current }).filter((r) => r.run === 'U1').flatMap((r) => r.notes);
  const expected = expectedSource('U1', undefined, 'bp-r3').grounds;
  assert.deepEqual(await notes(u1({ instructions: expected.instructions, from: ['bp-r3'] })), []);
  assert.ok((await notes(u1({ instructions: expected.instructions.slice(1), from: ['bp-r3'] }))).some((n) => /利用者の指示/.test(n)));
  assert.ok((await notes(u1({ instructions: expected.instructions, from: ['bp-other'] }))).some((n) => /参照の形/.test(n)));
  assert.ok((await notes(u1({ instructions: expected.instructions, from: [] }))).some((n) => /参照の形/.test(n)));
  assert.ok((await notes(u1({ instructions: expected.instructions, from: ['bp-r3', 'bp-other'] }))).some((n) => /参照の形/.test(n)));
  assert.notDeepEqual(expectedSource('R4').files, expectedSource('R1').files);
  assert.notDeepEqual(expectedSource('R2').files, expectedSource('R4').files);
});

test('検証方法: R2 の行は基準の run の記録が無ければ、仕込んだ版の記録があっても確かめた行にしない', async (t) => {
  const current = fingerprint();
  const injected = { stopKind: 'complete', findings: [], uncheckedViewpoints: [], applicability: { row: 15 } };
  const dir = await records(t, { R2: forged('R2', 'review', sourceFor('R2'), injected, current) });
  const rows = readRecords({ recordsDir: dir, current }).filter((r) => r.run === 'R2');
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.status === '作成中'));
  assert.ok(rows.some((r) => r.notes.some((n) => /R1 の記録が無い/.test(n))));
});

test('検証方法: 試走の道具は本物の checkout では走らず、worktree でだけ走る', () => {
  assert.throws(() => checkWorktree({ gitDir: '/r/.git', commonDir: '/r/.git' }), /worktree/);
  assert.doesNotThrow(() => checkWorktree({ gitDir: '/r/.git/worktrees/x', commonDir: '/r/.git' }));
});

test('検証方法: 記録の役ごとの起動数は、停止の記録の起動数から項目の試行（review・audit では担当の作成と適用の判定の繰り返しの番号も）を役ごとに引いて運搬役の数を出し、E_TRANSPORT の試行の失敗を役ごとに数える', () => {
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
  const review = buildView([{
    seq: 1, run: 'r1', op: 'start', records: [
      { t: 'state', id: 'bp-2', key: 'k', function: 'review', limits: { attempts: 3, iterations: 3, untilPass: 3 } },
      { t: 'run', id: 'r1', key: 'k', base: { iterations: 0, repeats: {} } },
      { t: 'paths', n: 1, root: '/x', files: [], unresolved: [] },
      { t: 'repeat', stage: 'assign', n: 2 },
      { t: 'repeat', stage: 'applicability', n: 1 },
      { t: 'stop', run: 'r1', kind: 'complete', launches: 9 },
    ],
  }]);
  const r = launchesOf(review, path.join(SKILL_DIR, CRITERIA_DIR));
  assert.deepEqual([r.byRole['抽出役'].n, r.byRole['検証役'].n, r.byRole['運搬役'].n], [2, 1, 6]);
});

// 記録の E_TRANSPORT の率は、検証役が返り値と作業ファイルに同じ JSON を書けなかった試行を、模擬でなく script の本物の経路で数える。
test('検証方法: 検証役の作業ファイルが返り値と食い違うと、script が書く試行の失敗の理由に E_TRANSPORT が入り、記録の役ごとの E_TRANSPORT の件数に数えられる', async (t) => {
  const s = await setupInspect(t);
  if (!s) return;
  let n = 0;
  const verify = async (prompt) => {
    const r = await inspectDefaults.verify(prompt);
    if ((n += 1) === 1) await fs.writeFile(payloadPath(prompt), JSON.stringify({ result: { ...r, candidates: [{ x: 1 }] } }));
    return r;
  };
  const { result } = await runInspect(t, { env: s.env, args: inspectArgs('review', s.target), scenario: { verify } });
  assert.equal(result.stopKind, 'complete', result.reason);
  const out = launchesOf(await viewOf(s.env, result.state), path.join(SKILL_DIR, CRITERIA_DIR));
  assert.deepEqual(out.transport.byRole, { 検証役: 1 });
  assert.ok(out.transport.rate > 0);
});

// record は模擬の backend の run を、Workflow の実行の記録が見つからないことで拒否する。見つかれば書く（ファイルの偽造は区別できない）。
test('検証方法: record は prepare の key でない run・題材の違う run・Workflow の実行の記録の無い run の記録を書かず、key と script の本文の合う実行の記録があるときだけ書く', async (t) => {
  const s = await setupInspect(t);
  if (!s) return;
  const root = path.join(s.base, 'audit-target');
  await fs.cp(path.join(TRIAL_DIR, 'audit-target'), root, { recursive: true });
  const target = { root: await fs.realpath(root), files: [] };
  const run = async (key) => (await runInspect(t, { env: s.env, args: { ...inspectArgs('audit', target), key } })).result;
  const opts = async () => ({ top: REPO_ROOT, env: { BP_STATE_ROOT: s.env.root }, recordsDir: await tmp(t, 'bp-rec-'), configDir: await tmp(t, 'bp-cc-') });
  const harnessKey = await run(inspectArgs('audit', target).key);
  await assert.rejects(writeRecord('A1', harnessKey.state, await opts()), /key の操作で得た形でない/);
  const issued = (await s.env.request('key', {})).key;
  const mock = await run(issued);
  await assert.rejects(writeRecord('A1', mock.state, await opts()), /completed の Workflow の実行の記録が無い（0 件/);
  const o = await opts();
  const wf = path.join(o.configDir, 'projects', 'p', 's', 'workflows');
  await fs.mkdir(wf, { recursive: true });
  const script = await fs.readFile(path.join(SKILL_DIR, 'scripts', 'bp_inspect.js'), 'utf8');
  await fs.writeFile(path.join(wf, 'wf_x.json'), JSON.stringify({ runId: 'wf_x', status: 'completed', agentCount: 15, args: { key: issued }, script: `${script}\n`, result: { state: mock.state } }));
  await assert.rejects(writeRecord('A1', mock.state, o), /script の本文が今の script と違う/);
  await fs.writeFile(path.join(wf, 'wf_x.json'), JSON.stringify({ runId: 'wf_x', status: 'completed', args: { key: issued }, script, result: { state: mock.state }, agentCount: 15 }));
  const rec = await writeRecord('A1', mock.state, o);
  assert.equal(rec.evidence[0].runId, 'wf_x');
  const other = path.join(s.base, 'other');
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'SKILL.md'), '---\nname: o\n---\n# O\n');
  const otherKey = (await s.env.request('key', {})).key;
  const otherRun = (await runInspect(t, { env: s.env, args: { ...inspectArgs('audit', { root: await fs.realpath(other), files: [] }), key: otherKey } })).result;
  await assert.rejects(writeRecord('A1', otherRun.state, await opts()), /runs.json の題材/);
});

const INSPECT_SCRIPT = readFileSync(path.join(SKILL_DIR, 'scripts', 'bp_inspect.js'), 'utf8');

// 本物の native Workflow の run の記録の形（~/.claude/projects/*/*/workflows/wf_*.json の鍵）。値は試験用に作る。
function wfRun(runId, { key, state, status = 'completed', agentCount = 3, args, agents = [], script = INSPECT_SCRIPT }) {
  return {
    runId, timestamp: '2026-10-23T00:00:00.000Z', taskId: 't', script, scriptPath: '/x/bp_inspect.js', args: args ?? { key },
    result: state === undefined ? null : state === null ? { stopKind: 'blocked', reason: 'x', launches: 0 } : { stopKind: 'complete', state }, agentCount,
    logs: [], durationMs: 1000, summary: '', workflowName: 'best-practices-inspect', status, startTime: 0, phases: [], defaultModel: 'x',
    workflowProgress: agents.map((a, i) => ({ type: 'workflow_agent', index: i + 1, label: a.label, model: a.model, state: 'done', attempt: 1, ...(a.ms === undefined ? { cached: true } : { durationMs: a.ms }) })), totalTokens: 10, totalToolCalls: 1,
  };
}

async function configWith(t, runs) {
  const dir = await tmp(t, 'bp-cc-');
  const wf = path.join(dir, 'projects', 'p', 's', 'workflows');
  await fs.mkdir(wf, { recursive: true });
  for (const [i, r] of runs.entries()) await fs.writeFile(path.join(wf, `wf_${i}.json`), JSON.stringify(r));
  return dir;
}

const viewOfRuns = (keys) => ({ runs: keys.map((key, i) => ({ id: `r${i + 1}`, key })) });

test('検証方法: Workflow の実行の証拠は、最後の run が completed で返り値の状態が記録の状態と同じで agent を 1 体以上起動したときだけ受け、状態の無い返り値・killed・状態の違う返り値・同じ key の completed の 2 つを拒否する', async (t) => {
  const K = 'k-0123456789abcdef';
  const bad = [
    [wfRun('a', { key: K, state: null })],
    [wfRun('a', { key: K, status: 'killed' })],
    [wfRun('a', { key: K, state: 'bp-other' })],
    [wfRun('a', { key: K, state: 'bp-s', agentCount: 0 })],
    [wfRun('a', { key: K, state: 'bp-s' }), wfRun('b', { key: K, state: 'bp-s' })],
    [],
  ];
  for (const runs of bad) {
    const dir = await configWith(t, runs);
    assert.throws(() => workflowEvidence(viewOfRuns([K]), 'bp-s', dir), /Workflow の実行の記録/, JSON.stringify(runs.map((r) => [r.status, r.result, r.agentCount])));
  }
  const ok = await configWith(t, [wfRun('a', { key: K, state: 'bp-s' })]);
  assert.equal(workflowEvidence(viewOfRuns([K]), 'bp-s', ok).length, 1);
  const asString = await configWith(t, [wfRun('a', { key: K, state: 'bp-s', args: JSON.stringify({ key: K }) })]);
  assert.equal(workflowEvidence(viewOfRuns([K]), 'bp-s', asString).length, 1);
});

// 再開は next_args と新しい key で別の Workflow を起動する（SP-BPRUN-014）ので、状態の run ごとに key の違う記録が 1 つずつできる。
// host の失敗で止まった run は killed・failed の記録を残し、同じ状態を別の key で再開する。
test('検証方法: 再開した状態は run ごとの key の記録を 1 つずつ受け、host の失敗で止まった前の run の killed・failed の記録と、同じ key の送り直しで残った killed の記録を誤って拒否しない', async (t) => {
  const [K1, K2, K3] = ['k-1111111111111111', 'k-2222222222222222', 'k-3333333333333333'];
  const dir = await configWith(t, [
    wfRun('a', { key: K1, state: 'bp-s', status: 'completed' }),
    wfRun('b', { key: K2, status: 'killed' }),
    wfRun('c', { key: K3, status: 'killed' }),
    wfRun('d', { key: K3, state: 'bp-s' }),
  ]);
  const ev = workflowEvidence(viewOfRuns([K1, K2, K3]), 'bp-s', dir);
  assert.deepEqual(ev.map((e) => [e.key, e.status]), [[K1, 'completed'], [K2, 'killed'], [K3, 'completed']]);
  const lastKilled = await configWith(t, [wfRun('a', { key: K1, state: 'bp-s' }), wfRun('b', { key: K2, status: 'killed' })]);
  assert.throws(() => workflowEvidence(viewOfRuns([K1, K2]), 'bp-s', lastKilled), /最後の run/);
});

test('検証方法: 証拠は 1 体ごとの所要時間を持ち、runner の timeoutMs と agentTimeoutMs を記録から計算できる（最長の run の 2 倍を時間の単位で切り上げ、最長の 1 体の 2 倍）', async (t) => {
  const K = 'k-0123456789abcdef';
  const dir = await configWith(t, [{ ...wfRun('a', { key: K, state: 'bp-s', agents: [{ label: 'carrier', model: 'haiku', ms: 1200 }, { label: 'verifier:flow', model: 'opus', ms: 95000 }] }), durationMs: 5_400_000 }]);
  const ev = workflowEvidence(viewOfRuns([K]), 'bp-s', dir);
  assert.deepEqual(ev[0].agents, [{ label: 'carrier', model: 'haiku', state: 'done', attempt: 1, durationMs: 1200 }, { label: 'verifier:flow', model: 'opus', state: 'done', attempt: 1, durationMs: 95000 }]);
  assert.deepEqual(runnerTimeouts([{ evidence: ev }, { evidence: [{ durationMs: 60_000, agents: [{ durationMs: 10 }] }] }]), { timeoutMs: 3 * 3_600_000, agentTimeoutMs: 190000 });
  assert.deepEqual(runnerTimeouts([{ evidence: [{ durationMs: 5_400_001, agents: [] }] }]), { timeoutMs: 4 * 3_600_000, agentTimeoutMs: 0 });
  // 同じ key の止まった記録の後に native が同じ run を続けると、続きの記録の agent は cached で所要時間を持たないので、止まった記録の agent も数える。
  const resumed = await configWith(t, [
    wfRun('k', { key: K, status: 'killed', agents: [{ label: 'verifier:flow', model: 'opus', ms: 3_000_000 }] }),
    wfRun('c', { key: K, state: 'bp-s', agents: [{ label: 'verifier:flow', model: 'opus' }, { label: 'carrier', model: 'haiku', ms: 1000 }] }),
  ]);
  assert.equal(runnerTimeouts([{ evidence: workflowEvidence(viewOfRuns([K]), 'bp-s', resumed) }]).agentTimeoutMs, 6_000_000);
});

test('検証方法: 最後でない run の証拠は killed・failed で、返り値の状態があれば記録の状態と同じで、script の本文が今の script と同じものだけを受ける（状態の無い記録・running・別の状態・別の script の囮を拒否する）。同じ key の合う completed と合わない completed は拒否する', async (t) => {
  const [K1, K2] = ['k-1111111111111111', 'k-2222222222222222'];
  const current = fingerprint();
  const last = wfRun('z', { key: K2, state: 'bp-s' });
  const decoys = [
    wfRun('a', { key: K1, status: 'killed', agentCount: 0, script: 'export const meta = {}' }),
    { ...wfRun('a', { key: K1 }), status: undefined },
    wfRun('a', { key: K1, status: 'running', agentCount: 0 }),
    wfRun('a', { key: K1, status: 'killed', state: 'bp-other' }),
  ];
  for (const d of decoys) {
    const dir = await configWith(t, [d, last]);
    let problems;
    try {
      const ev = workflowEvidence(viewOfRuns([K1, K2]), 'bp-s', dir);
      problems = evidenceProblems({ function: 'review', state: 'bp-s', source: { key: K1 }, evidence: ev }, current);
    } catch (error) {
      problems = [error.message];
    }
    assert.ok(problems.length > 0, JSON.stringify([d.status, d.result, d.script.slice(0, 20)]));
  }
  const failed = await configWith(t, [wfRun('a', { key: K1, status: 'failed', agentCount: 0 }), last]);
  const ev = workflowEvidence(viewOfRuns([K1, K2]), 'bp-s', failed);
  assert.deepEqual(evidenceProblems({ function: 'review', state: 'bp-s', source: { key: K1 }, evidence: ev }, current), []);
  const mixed = await configWith(t, [wfRun('a', { key: K2, state: 'bp-s' }), wfRun('b', { key: K2, state: 'bp-other' })]);
  assert.throws(() => workflowEvidence(viewOfRuns([K2]), 'bp-s', mixed), /completed の Workflow の実行の記録が 2 件/);
});

test('検証方法: 同じ key の completed の記録の横にある記録は、completed・killed・failed 以外の状態か別の状態を持てば拒否し、止まった記録（sibling）も script の本文と状態を読み取りで照らしてから agent の所要時間に畳み込む', async (t) => {
  const [K1, K2] = ['k-1111111111111111', 'k-2222222222222222'];
  const current = fingerprint();
  const ok = wfRun('z', { key: K2, state: 'bp-s' });
  for (const side of [wfRun('r', { key: K2, status: 'running' }), wfRun('f', { key: K2, status: 'killed', state: 'bp-other' })]) {
    const dir = await configWith(t, [side, ok]);
    assert.throws(() => workflowEvidence(viewOfRuns([K2]), 'bp-s', dir), /どれでもない|別の状態/);
  }
  const alien = await configWith(t, [wfRun('s', { key: K2, status: 'killed', script: 'export const meta = {}', agents: [{ label: 'x', model: 'opus', ms: 180_000_000 }] }), ok]);
  const ev = workflowEvidence(viewOfRuns([K2]), 'bp-s', alien);
  assert.ok(evidenceProblems({ function: 'review', state: 'bp-s', source: { key: K2 }, evidence: ev }, current).some((p) => /script の本文/.test(p)));
  const twoStopped = await configWith(t, [
    wfRun('a', { key: K1, status: 'killed', agents: [{ label: 'verifier:flow', model: 'opus', ms: 7_000 }] }),
    wfRun('b', { key: K1, status: 'failed', agentCount: 0 }),
    wfRun('c', { key: K2, state: 'bp-s' }),
  ]);
  assert.equal(runnerTimeouts([{ evidence: workflowEvidence(viewOfRuns([K1, K2]), 'bp-s', twoStopped) }]).agentTimeoutMs, 14_000);
  const base = { key: K1, scriptSha: current.scripts.inspect, agents: [] };
  const read = (e) => evidenceProblems({ function: 'review', state: 'bp-s', source: { key: K1 }, evidence: [e, { key: K2, status: 'completed', scriptSha: current.scripts.inspect, resultState: 'bp-s', agents: [] }] }, current);
  assert.deepEqual(read({ ...base, status: 'killed', resultState: null, siblings: [] }), []);
  assert.ok(read({ ...base, status: 'running', resultState: null, siblings: [] }).length > 0);
  assert.ok(read({ ...base, status: 'killed', resultState: 'bp-other', siblings: [] }).length > 0);
  assert.ok(read({ ...base, status: 'killed', resultState: null, siblings: [{ status: 'killed', scriptSha: '0'.repeat(64), resultState: null }] }).length > 0);
  assert.ok(read({ ...base, status: 'killed', resultState: null, siblings: [{ status: 'killed', scriptSha: current.scripts.inspect, resultState: 'bp-other' }] }).length > 0);
  assert.ok(read({ ...base, status: 'killed', resultState: null, siblings: [{ status: 'running', scriptSha: current.scripts.inspect, resultState: null }] }).length > 0);
});

// 照合を厳しくしても、本物の試走が残す正当な組を誤って拒否しないことを、収集から読み取りの照合まで通して照らす。
test('検証方法: 同じ script の止まった記録と completed の組・2 run の再開の組・args が JSON の文字列の組は、証拠の収集から読み取りの照合まで通って問題が 0 件になる', async (t) => {
  const [K1, K2] = ['k-1111111111111111', 'k-2222222222222222'];
  const current = fingerprint();
  const cases = [
    [[K2], [wfRun('a', { key: K2, status: 'killed', agents: [{ label: 'verifier:flow', model: 'opus', ms: 500 }] }), wfRun('b', { key: K2, state: 'bp-s' })]],
    [[K2], [wfRun('a', { key: K2, status: 'failed', agentCount: 0 }), wfRun('b', { key: K2, state: 'bp-s' })]],
    [[K1, K2], [wfRun('a', { key: K1, status: 'killed' }), wfRun('b', { key: K1, status: 'failed', agentCount: 0 }), wfRun('c', { key: K2, state: 'bp-s' })]],
    [[K1, K2], [wfRun('a', { key: K1, status: 'killed', args: JSON.stringify({ key: K1 }) }), wfRun('b', { key: K2, state: 'bp-s', args: JSON.stringify({ key: K2 }) })]],
  ];
  for (const [keys, runs] of cases) {
    const ev = workflowEvidence(viewOfRuns(keys), 'bp-s', await configWith(t, runs));
    assert.ok(ev.some((e) => e.siblings.length > 0) || keys.length > 1);
    assert.deepEqual(evidenceProblems({ function: 'review', state: 'bp-s', source: { key: keys[0] }, evidence: ev }, current), [], JSON.stringify(runs.map((r) => [r.args, r.status])));
  }
});

// 試走の args は入口と同じ chain-next・launch-args で作る（skillDir と項目の表は CLI の 1 箇所から出る）。
test('検証方法: prepare は入口の launch-args で args を作り（skillDir は CLI の位置、key は CLI の key）、前の run を参照する update は chain-next の input を使い、前の run が完了していなければ進まない', async (t) => {
  const s = await setupInspect(t);
  if (!s) return;
  const top = await tmp(t, 'bp-top-');
  const opts = { top, env: { BP_STATE_ROOT: s.env.root }, recordsDir: await tmp(t, 'bp-rec-') };
  const a1 = await prepareIn('A1', opts);
  assert.deepEqual(Object.keys(a1).sort(), ['function', 'key', 'skillDir', 'target']);
  assert.equal(a1.skillDir, SKILL_DIR);
  assert.match(a1.key, /^k-[0-9a-f]{16}$/);
  assert.equal(a1.target.root, await fs.realpath(path.join(top, '.bp-trial', 'A1', 'audit-target')));
  const r3 = await prepareIn('R3', opts);
  const done = (await runInspect(t, { env: s.env, args: r3 })).result;
  assert.equal(done.stopKind, 'complete', done.reason);
  await fs.writeFile(path.join(opts.recordsDir, 'R3.json'), JSON.stringify({ state: done.state, target: r3.target.root }));
  const u1 = await prepareIn('U1', opts);
  const instructions = JSON.parse(readFileSync(path.join(TRIAL_DIR, 'update-grounds.json'), 'utf8'));
  assert.deepEqual(u1.grounds, [{ from: done.state }, ...instructions.map((text) => ({ kind: '利用者の指示', text }))]);
  assert.deepEqual(u1.target, r3.target);
  assert.equal(u1.skillDir, SKILL_DIR);
  const blocked = (await runInspect(t, { env: s.env, args: { ...r3, key: (await s.env.request('key', {})).key }, scenario: { carrier: async (p) => (p.includes(' targets <<') ? null : undefined) } })).result;
  await fs.writeFile(path.join(opts.recordsDir, 'R3.json'), JSON.stringify({ state: blocked.state, target: r3.target.root }));
  await assert.rejects(prepareIn('U1', opts), /R3 の状態から U1 へ進めない/);
});

test('検証方法: 参照を持たずに始めるはずの run の出所が参照を持てば拒否し、持たなければ受ける', () => {
  const expected = { files: { 'SKILL.md': 'x' }, grounds: { instructions: [{ kind: '利用者の指示', text: 'a' }], from: null } };
  const base = { key: ISSUED, files: expected.files, grounds: { instructions: expected.grounds.instructions, from: [] } };
  assert.deepEqual(sourceProblems(base, expected), []);
  assert.ok(sourceProblems({ ...base, grounds: { ...base.grounds, from: ['bp-x'] } }, expected).some((p) => /参照の形/.test(p)));
});

test('検証方法: bp-run の検証方法の記録を受ける条件が、照合の受ける Workflow の実行の状態を全て名指す', () => {
  const run = readFileSync(path.join(SKILL_DIR, '..', '..', '..', '..', 'docs', 'specifications', 'bp-run.md'), 'utf8');
  const para = run.split('\n').find((l) => l.startsWith('- 記録は次の全てを持つときだけ受ける。'));
  assert.ok(para);
  for (const status of WORKFLOW_STATUSES) assert.ok(para.includes(status), status);
  assert.match(para, /completed の記録は、返り値の状態が記録の状態と同じで、agent を 1 体以上起動した/);
  assert.match(para, /最後でない run の key[^。]*completed の記録か[^。]*killed・failed の記録でよい/);
});
