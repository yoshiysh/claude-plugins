import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT, SKILL_DIR, candidateVerifier, defaults, logOf, newKey, runAuthor, runInspect, setup, setupInspect, viewOf,
} from './helpers/bp-harness.mjs';
import { canonical } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/ids.mjs';
import { STATES_DIR } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';

const INSTRUCTION = '手順の節を短くする';
const AUTHORING = readFileSync(path.join(REPO_ROOT, 'docs', 'specifications', 'bp-authoring.md'), 'utf8');
const AUTHORING_029 = AUTHORING.slice(AUTHORING.indexOf('#### SP-BPAUTHORING-029'), AUTHORING.indexOf('#### SP-BPAUTHORING-030'));
const PLUGIN = 'p';

// 入口（SKILL.md）の手順を模す: 機能の列を CLI に確かめさせ、起動ごとに key と args を CLI から得て、前の run の状態から次の入力を作らせ、
// 最後に返り値を状態から組み立てさせる。入口は CLI の出力を書き換えずに渡すだけなので、この関数も値を作らない。
async function entry(env, { functions, first, instructions = [], route = 'native', scenarios = [], unmatched, maxAgents }) {
  const cli = async (op, body) => {
    const out = await env.request(op, body);
    assert.equal(out.ok, true, `${op}: ${out.code} ${out.reason}`);
    const { ok, op: _, sum, ...rest } = out;
    return rest;
  };
  const check = await cli('chain-check', { functions });
  if (!check.buildable) return { check, runs: [], launches: [] };
  const runs = [];
  const launches = [];
  const nexts = [];
  let input = first;
  for (const [i, fn] of functions.entries()) {
    if (i > 0) {
      // 状態を作らずに止まった run は次へ進む手がかりを持たない（入口は chain-report で入力を直すことを返す）。
      if (!runs.at(-1).state) break;
      const n = await cli('chain-next', { state: runs.at(-1).state, next: fn, instructions });
      nexts.push(n);
      if (!n.proceed) break;
      input = n.input;
    }
    const { key } = await cli('key', {});
    const launch = await cli('launch-args', { route, launch: 'new', key, input });
    launches.push(launch);
    const runner = launch.source === 'best-practices-author' ? runAuthor : runInspect;
    const { result, calls } = await runner(env.t, { env, args: launch.args, scenario: scenarios[i] ?? {}, ...(maxAgents ? { maxAgents } : {}) });
    runs.push({ function: fn, state: result.state ?? null, result, calls });
  }
  const report = await cli('chain-report', {
    functions,
    runs: runs.map((r) => (r.state ? { state: r.state } : { function: r.function, result: strip(r.result) })),
    ...(unmatched ? { unmatched } : {}),
  });
  return { check, runs, launches, nexts, report };
}

function strip(result) {
  const { ok, op, sum, ...rest } = result;
  return rest;
}

// create の書き手は、plugin の workflow script を名前で起動する callsite と、解決できない callsite を持つ SKILL.md を書く。
function pluginWriter(extra = '') {
  return async (prompt) => {
    const root = /根 (\S+) の配下/.exec(prompt)[1];
    await fs.mkdir(root, { recursive: true });
    const file = path.join(root, 'SKILL.md');
    await fs.writeFile(file, `---\nname: made\ndescription: d\n---\n# Made\n本文\nWorkflow({ name: "${PLUGIN}:flow", args })\nWorkflow({ name: "${PLUGIN}:missing", args })\n${extra}## 設計の説明\nA: はい。Q1: いいえ。\n`);
    return { written: [{ path: file, action: 'write' }], designNote: { path: 'SKILL.md', heading: '設計の説明' } };
  };
}

async function pluginBase(base) {
  const plugin = path.join(base, '.agents');
  await fs.mkdir(path.join(plugin, '.claude-plugin'), { recursive: true });
  await fs.writeFile(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN }));
  await fs.mkdir(path.join(plugin, 'workflows'), { recursive: true });
  await fs.writeFile(path.join(plugin, 'workflows', 'flow.js'), 'export const meta = {\n  name: "flow",\n}\n');
  return plugin;
}

async function createChain(t, functions, { scenarios = [], instructions } = {}) {
  const s = await setup(t, { fn: 'create' });
  if (!s) return null;
  s.env.t = t;
  const plugin = await pluginBase(s.base);
  const first = { function: 'create', request: '設定ファイルを整形するスキルを作る。対象は YAML だけ。', target: s.target };
  const write = pluginWriter();
  const out = await entry(s.env, { functions, first, instructions, scenarios: [{ write }, ...scenarios] });
  return { ...s, plugin, ...out };
}

test('SP-BPENTRY-009・SP-BPENTRY-006・SP-BPENTRY-022・SP-BPENTRY-023: create → review で、review の対象スキルのディレクトリが create の返り値の作ったスキルのディレクトリになり、自分の plugin の workflow script が一覧に入り、解決できない callsite が行番号とともに外したものとして返り値に載る', async (t) => {
  const c = await createChain(t, ['create', 'review']);
  if (!c) return;
  const [create, review] = c.runs;
  assert.equal(create.result.stopKind, 'complete', create.result.reason);
  assert.equal(review.result.stopKind, 'complete', review.result.reason);
  const made = create.result.skill.root;
  assert.equal(c.launches[1].args.target.root, made);
  assert.ok(!Object.hasOwn(c.launches[1].args, 'grounds'));
  assert.deepEqual(c.launches[1].args.target.files, [path.join(await fs.realpath(c.plugin), 'workflows', 'flow.js')]);
  assert.equal((await viewOf(c.env, review.state)).paths[0].root, made);
  const skillMd = await fs.readFile(path.join(made, 'SKILL.md'), 'utf8');
  const line = skillMd.split('\n').findIndex((l) => l.includes(`${PLUGIN}:missing`)) + 1;
  assert.deepEqual(c.report.excludedCallsites.filter((e) => e.run === 2).map((e) => [e.line, e.file]), [[line, path.join(made, 'SKILL.md')]]);
  assert.match(c.report.excludedCallsites.find((e) => e.run === 2).text, /p:missing/);
});

test('SP-BPENTRY-009: create → audit と create → update で、次の run の対象スキルのディレクトリが作ったスキルのディレクトリになり、update の修正の根拠は依頼の中の利用者の修正の指示だけになる', async (t) => {
  for (const next of ['audit', 'update']) {
    const c = await createChain(t, ['create', next], { instructions: [INSTRUCTION] });
    if (!c) return;
    const made = c.runs[0].result.skill.root;
    const args = c.launches[1].args;
    assert.equal(args.target.root, made, next);
    if (next === 'update') assert.deepEqual(args.grounds, [{ kind: '利用者の指示', text: INSTRUCTION }]);
    else assert.ok(!Object.hasOwn(args, 'grounds'));
    assert.equal(c.runs[1].result.stopKind, 'complete', c.runs[1].result.reason);
  }
});

// 判定表の create 以外の 9 行（create を次に置く行は chain-check が断る）を 1 本の連鎖で全て通す。update は対象スキルを書き換え、plugin に workflow script を足す。
test('SP-BPENTRY-009・SP-BPENTRY-006・SP-BPENTRY-007・SP-BPENTRY-021: review・audit・update を前と次に置く判定表の行ごとに、次の run の対象スキルの根が対象スキルのディレクトリで、次の run の対象スキルと修正の根拠が表と一致し、update の後に足された workflow script が次の一覧に入り、前の run の返り値より前に次の run が起動されず、返り値に各 run の返り値が列の順に変えずに載る', async (t) => {
  const functions = ['review', 'review', 'audit', 'audit', 'update', 'update', 'review', 'update', 'audit', 'review'];
  const s = await setupInspect(t);
  if (!s) return;
  s.env.t = t;
  const pluginRoot = path.join(s.base, 'plug');
  const skill = path.join(pluginRoot, 'skills', 'x');
  await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  await fs.writeFile(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN }));
  await fs.cp(s.target.root, skill, { recursive: true });
  let added = 0;
  // 2 回目の update の書き手だけが plugin に workflow script を足し、SKILL.md にその callsite を書く。
  const write = async (prompt) => {
    const file = path.join(skill, 'SKILL.md');
    added += 1;
    if (added === 2) {
      await fs.mkdir(path.join(pluginRoot, 'workflows'), { recursive: true });
      await fs.writeFile(path.join(pluginRoot, 'workflows', 'added.js'), 'export const meta = {\n  name: "added",\n}\n');
      await fs.appendFile(file, `\nWorkflow({ name: "${PLUGIN}:added", args })\n`);
    } else {
      await fs.appendFile(file, `\n追記 ${added}\n`);
    }
    return { written: [{ path: file, action: 'write' }], designNote: { path: 'SKILL.md' } };
  };
  const scenarios = functions.map((fn) => (fn === 'update' ? { write } : {}));
  const realSkill = await fs.realpath(skill);
  const first = { function: 'review', target: { root: realSkill, files: [] } };
  const c = await entry(s.env, { functions, first, instructions: [INSTRUCTION], scenarios });
  assert.equal(c.runs.length, functions.length);
  for (const r of c.runs) assert.equal(r.result.stopKind, 'complete', `${r.function}: ${r.result.reason}`);
  const addedFile = path.join(await fs.realpath(pluginRoot), 'workflows', 'added.js');
  for (const [i, n] of c.nexts.entries()) {
    const prev = functions[i];
    const next = functions[i + 1];
    const args = c.launches[i + 1].args;
    assert.equal(n.proceed, true, `${prev} → ${next}`);
    assert.equal(args.target.root, realSkill, `${prev} → ${next}`);
    if (prev === 'review' || prev === 'audit') {
      assert.deepEqual(args.target, c.launches[i].args.target, `${prev} → ${next}: 一覧を引き継ぐ`);
    }
    const expectGrounds = next !== 'update' ? undefined
      : prev === 'update' ? [{ kind: '利用者の指示', text: INSTRUCTION }]
        : [{ from: c.runs[i].state }, { kind: '利用者の指示', text: INSTRUCTION }];
    assert.deepEqual(args.grounds, expectGrounds, `${prev} → ${next}`);
  }
  // 2 回目の update（列の 6 番目）の後の review（7 番目）の一覧に、足した workflow script が入る。
  assert.ok(!c.launches[5].args.target.files.includes(addedFile));
  assert.ok(c.launches[6].args.target.files.includes(addedFile));
  // 次の run の入力は、停止の記録を持つ前の状態から chain-next が作ったものだけ（止まっていない状態では進まない：ops-entry.test）。
  for (let i = 1; i < c.runs.length; i += 1) {
    assert.ok((await logOf(s.env, c.runs[i - 1].state)).some((l) => l.records.some((r) => r.t === 'stop')));
  }
  assert.deepEqual(c.report.results, c.runs.map((r) => strip(r.result)));
  assert.ok(!Object.hasOwn(c.report, 'unexecuted'));
  assert.ok(!Object.hasOwn(c.report, 'resume'));
});

for (const fn of ['review', 'audit']) {
  test(`SP-BPENTRY-010・SP-BPENTRY-009・SP-BPFINDINGS-031: ${fn} → update で、open と dismissed の指摘を含む返り値の指摘の一覧が、入口に書き写されずに参照で渡り、update の修正の根拠に同じバイト列で記録され、update の受け手で dismissed が除かれる［${fn}］`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    s.env.t = t;
    let refutes = 0;
    const viewpoint = fn === 'review' ? 'flow' : 'audit';
    const inspectScenario = {
      verify: candidateVerifier({ viewpoint }),
      refute: async () => ((refutes += 1) === 1 ? { verdict: 'uphold', reason: '維持' } : { verdict: 'reject', reason: '基準に反しない' }),
    };
    const write = async () => {
      const file = path.join(s.target.root, 'SKILL.md');
      await fs.appendFile(file, '\n追記した行\n');
      return { written: [{ path: file, action: 'write' }], designNote: { path: 'SKILL.md' } };
    };
    const first = { function: fn, target: { root: await fs.realpath(s.target.root), files: [] } };
    const c = await entry(s.env, { functions: [fn, 'update'], first, instructions: [INSTRUCTION], scenarios: [inspectScenario, { write }] });
    const [inspected, updated] = c.runs;
    assert.equal(inspected.result.stopKind, 'complete', inspected.result.reason);
    const findings = inspected.result.findings;
    assert.ok(findings.length >= 1);
    assert.deepEqual(c.launches[1].args.grounds, [{ from: inspected.state }, { kind: '利用者の指示', text: INSTRUCTION }]);
    assert.ok(!JSON.stringify(c.launches[1].args).includes(findings[0].id), '指摘の中身が入口の args に書き写されている');
    const view = await viewOf(s.env, updated.state);
    const recorded = view.grounds.map((g) => g.ground);
    assert.equal(canonical(recorded.slice(0, findings.length)), canonical(findings));
    assert.deepEqual(recorded.slice(findings.length), [{ kind: '利用者の指示', text: INSTRUCTION }]);
    assert.ok(view.grounds.slice(0, findings.length).every((g) => g.from === inspected.state));
    if (updated.result.stopKind === 'complete') {
      assert.deepEqual(updated.result.receivedGrounds.filter((g) => g.finding).map((g) => g.finding), findings.map((f) => f.id));
    }
    const goal = updated.calls.find((x) => x.role === 'goal').prompt;
    const passed = JSON.parse(/修正の根拠（記録 ID と中身）:\n(.+)/.exec(goal)[1]).map((g) => g.ground);
    assert.deepEqual(passed, [...findings.filter((f) => f.state === 'open'), { kind: '利用者の指示', text: INSTRUCTION }]);
  });
}

const ASK = async () => ({ missing: [{ question: '対象の形式は?', reason: '依頼文に無い' }] });

for (const fn of ['create', 'update']) {
  test(`SP-BPENTRY-008・SP-BPENTRY-021: 前の ${fn} の run が needs_input で止まると次の run を起動せず、返り値に止まった run の返り値と未実行の機能と next_args と回答を足す手順が載る［${fn}］`, async (t) => {
    const s = await setup(t, { fn });
    if (!s) return;
    s.env.t = t;
    const first = fn === 'create'
      ? { function: 'create', request: '設定ファイルを整形するスキルを作る。', target: s.target }
      : { function: 'update', target: { root: await fs.realpath(s.target.root), files: [] }, grounds: [{ kind: '利用者の指示', text: INSTRUCTION }] };
    const out = await entry(s.env, { functions: [fn, 'review', 'update'], first, instructions: [INSTRUCTION], scenarios: [{ goal: ASK }] });
    assert.equal(out.runs.length, 1);
    assert.equal(out.runs[0].result.stopKind, 'needs_input', out.runs[0].result.reason);
    assert.equal(out.nexts[0].proceed, false);
    assert.equal(out.nexts[0].stopKind, 'needs_input');
    assert.deepEqual(out.report.unexecuted, ['review', 'update']);
    assert.deepEqual(out.report.resume.nextArgs, out.runs[0].result.nextArgs);
    assert.match(out.report.resume.todo, /回答/);
    assert.deepEqual(out.report.results, [strip(out.runs[0].result)]);
  });
}

for (const fn of ['review', 'audit']) {
  test(`SP-BPENTRY-008: 前の ${fn} の run が BLOCKED で止まると次の run を起動せず、原因を直して再開する手順と未実行の機能が載る［${fn}］`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    s.env.t = t;
    // 照らす先の決定の運搬役が送り直しを含めて応答を失うと、fan-out の外の書き込みなので BLOCKED で止まる（状態は開始で作られている）。
    const scenario = { carrier: async (prompt) => (prompt.includes(' targets <<') ? null : undefined) };
    const first = { function: fn, target: { root: await fs.realpath(s.target.root), files: [] } };
    const out = await entry(s.env, { functions: [fn, 'update'], first, instructions: [INSTRUCTION], scenarios: [scenario] });
    assert.equal(out.runs[0].result.stopKind, 'blocked', out.runs[0].result.reason);
    assert.equal(out.runs.length, 1);
    assert.equal(out.nexts[0].proceed, false);
    assert.equal(out.nexts[0].stopKind, 'blocked');
    assert.deepEqual(out.report.unexecuted, ['update']);
    assert.deepEqual(out.report.resume.nextArgs, out.runs[0].result.nextArgs);
    assert.match(out.report.resume.todo, /原因を直して/);
  });
}

test('SP-BPENTRY-021: 状態を作らずに止まった run の返り値で、再開の仕方に next_args が無く、入力を直して新しく起動することが載り、未実行の機能が残る', async (t) => {
  const s = await setupInspect(t);
  if (!s) return;
  s.env.t = t;
  const first = { function: 'update', target: { root: path.join(s.base, 'nothere'), files: [] }, grounds: [{ kind: '利用者の指示', text: INSTRUCTION }] };
  const out = await entry(s.env, { functions: ['update', 'review'], first });
  assert.equal(out.runs.length, 1);
  assert.equal(out.runs[0].state, null);
  assert.equal(out.runs[0].result.stopKind, 'blocked');
  assert.equal(out.report.resume.nextArgs, null);
  assert.match(out.report.resume.todo, /入力を直して新しく起動する/);
  assert.deepEqual(out.report.unexecuted, ['review']);
});

test('SP-BPENTRY-020: 完了した review の返り値の指摘が SP-BPFINDINGS-029 の項目を欠くと、update の run を起動せず、欠けた項目を返す', async (t) => {
  const s = await setupInspect(t);
  if (!s) return;
  s.env.t = t;
  const first = { function: 'review', target: { root: await fs.realpath(s.target.root), files: [] } };
  const reviewed = await entry(s.env, { functions: ['review'], first, scenarios: [{ verify: candidateVerifier({ viewpoint: 'flow' }) }] });
  const state = reviewed.runs[0].state;
  assert.ok(reviewed.runs[0].result.findings.length > 0);
  // 状態の候補の記録から引用を消し、返り値の指摘が「引用」を欠く状態にする。
  const log = path.join(s.env.root, STATES_DIR, state, 'log.jsonl');
  const lines = (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const l of lines) for (const r of l.records) if (r.t === 'candidate') r.texts = r.texts.map(({ quote, ...rest }) => rest);
  await fs.writeFile(log, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const out = await s.env.request('chain-next', { state, next: 'update', instructions: [INSTRUCTION] });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.proceed, false);
  assert.ok(out.missing.length > 0);
  assert.ok(out.missing.every((m) => m.fields.includes('quote')));
  assert.ok(!Object.hasOwn(out, 'input'));
});

test('SP-BPENTRY-015: Codex runner の経路では最初の起動と再開の起動の両方に limits.maxAgents と同じ上限が渡り、native の経路ではどちらにも上限が渡らない', async (t) => {
  for (const route of ['codex', 'native']) {
    const s = await setup(t, { fn: 'create' });
    if (!s) return;
    s.env.t = t;
    const first = { function: 'create', request: '設定ファイルを整形するスキルを作る。対象は YAML だけ。', target: s.target };
    let asked = 0;
    const goal = async (prompt, ...rest) => ((asked += 1) === 1 ? { missing: [{ question: '形式は?', reason: '無い' }] } : defaults.goal(prompt, ...rest));
    const out = await entry(s.env, { functions: ['create'], first, route, scenarios: [{ goal }] });
    assert.equal(out.runs[0].result.stopKind, 'needs_input');
    const key = (await s.env.request('key', {})).key;
    const resume = await s.env.request('launch-args', { route, launch: 'resume', key, input: { nextArgs: out.report.resume.nextArgs, answer: 'YAML だけ' } });
    assert.equal(resume.ok, true, resume.reason);
    if (route === 'codex') {
      assert.equal(out.launches[0].args.maxLaunches, out.launches[0].request.limits.maxAgents);
      assert.equal(resume.args.maxLaunches, resume.request.limits.maxAgents);
    } else {
      assert.ok(!Object.hasOwn(out.launches[0].args, 'maxLaunches'));
      assert.ok(!Object.hasOwn(resume.args, 'maxLaunches'));
    }
    const resumed = await runAuthor(t, { env: s.env, args: resume.args, scenario: { goal } });
    assert.equal(resumed.result.stopKind, 'complete', resumed.result.reason);
  }
});

test('SP-BPENTRY-017: native の起動が失敗したとき、runner に切り替えずに、host の失敗の文言・未実行の機能・CLI が列挙した未完了の状態の next_args を返す', async (t) => {
  const s = await setupInspect(t);
  if (!s) return;
  s.env.t = t;
  const target = { root: await fs.realpath(s.target.root), files: [] };
  const { key } = await s.env.request('key', {});
  const launch = await s.env.request('launch-args', { route: 'native', launch: 'new', key, input: { function: 'review', target } });
  // host の上限で Workflow そのものが失敗する（状態を書いた後に失敗した run を作る）。
  let failure = null;
  try {
    await runInspect(t, { env: s.env, args: launch.args, maxAgents: 3 });
  } catch (error) {
    failure = String(error?.message ?? error);
  }
  assert.ok(failure, 'Workflow が失敗しなかった');
  const calls = s.env.cliCalls.length;
  const report = await s.env.request('chain-report', { functions: ['review', 'update'], runs: [], hostFailure: failure, target });
  assert.equal(report.ok, true, report.reason);
  assert.equal(report.hostFailure.failure, failure);
  assert.equal(report.hostFailure.function, 'review');
  assert.deepEqual(report.unexecuted, ['update']);
  assert.equal(report.hostFailure.resumable.length, 1);
  assert.deepEqual(report.hostFailure.resumable[0].nextArgs.function, 'review');
  assert.ok(!Object.hasOwn(report, 'resume'));
  assert.equal(s.env.cliCalls.length, calls + 1);
});

test('SP-BPENTRY-019: create を列の先頭以外に置く依頼では chain-check が組めないと答え、入口は run を 1 つも起動しない', async (t) => {
  const s = await setupInspect(t);
  if (!s) return;
  s.env.t = t;
  const out = await entry(s.env, { functions: ['review', 'create'], first: { function: 'review', target: { root: s.target.root, files: [] } } });
  assert.equal(out.check.buildable, false);
  assert.equal(out.runs.length, 0);
});

// 参照の形の修正の根拠は script から中身が見えないので、展開した後の 0 件は開始の操作が拒否し、script が needs_input に直す。
test('SP-BPAUTHORING-029・SP-BPFINDINGS-031: 参照だけの修正の根拠で、前の review の指摘が 0 件か全て dismissed なら update は状態を作らずに needs_input と件数の理由を返し、完了していない review を指す参照では BLOCKED を返す', async (t) => {
  const s = await setupInspect(t);
  if (!s) return;
  s.env.t = t;
  const target = { root: await fs.realpath(s.target.root), files: [] };
  const update = async (state) => (await runAuthor(t, { env: s.env, args: { function: 'update', target, grounds: [{ from: state }], skillDir: SKILL_DIR, key: newKey() } })).result;
  const clean = await entry(s.env, { functions: ['review'], first: { function: 'review', target } });
  assert.deepEqual(clean.runs[0].result.findings, []);
  const empty = await update(clean.runs[0].state);
  assert.equal(empty.stopKind, 'needs_input', empty.reason);
  assert.match(empty.reason, /扱う根拠が 0 件/);
  // SP-BPAUTHORING-029 は、受け取った件数と扱わなかった件数の両方を理由に載せる。参照先に指摘が無いときは、件数の 0 だけでは読めないので分けて書く。
  assert.match(AUTHORING_029, /受け取った修正の根拠の件数と、SP-BPFINDINGS-031 で扱わなかった件数/);
  assert.match(empty.reason, /受け取った 0 件、扱わなかった 0 件/);
  assert.match(empty.reason, /参照先に指摘が無かった/);
  assert.ok(!Object.hasOwn(empty, 'state'));
  assert.equal(empty.launches, 1);
  const dismissedOnly = await entry(s.env, {
    functions: ['review'], first: { function: 'review', target },
    scenarios: [{ verify: candidateVerifier({ viewpoint: 'flow' }), refute: async () => ({ verdict: 'reject', reason: '基準に反しない' }) }],
  });
  assert.ok(dismissedOnly.runs[0].result.findings.length > 0);
  assert.ok(dismissedOnly.runs[0].result.findings.every((f) => f.state === 'dismissed'));
  const none = await update(dismissedOnly.runs[0].state);
  assert.equal(none.stopKind, 'needs_input', none.reason);
  const n = dismissedOnly.runs[0].result.findings.length;
  assert.match(none.reason, new RegExp(`受け取った ${n} 件、扱わなかった ${n} 件`));
  assert.doesNotMatch(none.reason, /参照先に指摘が無かった/);
  const blocked = await entry(s.env, { functions: ['review'], first: { function: 'review', target }, scenarios: [{ carrier: async (prompt) => (prompt.includes(' targets <<') ? null : undefined) }] });
  assert.equal(blocked.runs[0].result.stopKind, 'blocked');
  const wrong = await update(blocked.runs[0].state);
  assert.equal(wrong.stopKind, 'blocked');
  assert.match(wrong.reason, /開始の操作が失敗した.*完了で止まっていない/);
});

test('SP-BPENTRY-023・SP-BPRUN-032: chain-report の review の外した callsite の行番号は review の開始の時点の状態から作り、後の update が SKILL.md の行をずらしても変わらない', async (t) => {
  const s = await setupInspect(t, { files: { 'SKILL.md': '---\nname: x\ndescription: d\n---\n# X\n本文\nWorkflow({ name: "p:missing", args })\n## 手順\n手順の本文\n' } });
  if (!s) return;
  s.env.t = t;
  const target = { root: await fs.realpath(s.target.root), files: [] };
  const write = async () => {
    const f = path.join(target.root, 'SKILL.md');
    await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace('# X\n', '# X\n挿入1\n挿入2\n挿入3\n'));
    return { written: [{ path: f, action: 'write' }], designNote: { path: 'SKILL.md' } };
  };
  const c = await entry(s.env, { functions: ['review', 'update'], first: { function: 'review', target }, instructions: [INSTRUCTION], scenarios: [{}, { write }] });
  assert.equal(c.runs[1].result.stopKind, 'complete', c.runs[1].result.reason);
  assert.deepEqual(c.report.excludedCallsites.filter((e) => e.run === 1).map((e) => e.line), [7]);
});

test('SP-BPENTRY-008・SP-BPENTRY-021・SP-BPRUN-032: chain-report は完了以外で止まった run の後の run、状態の無い完了の run、完了以外で止まった run の後の host の失敗を、起こりえない並びとして拒否する', async (t) => {
  const s = await setupInspect(t);
  if (!s) return;
  s.env.t = t;
  const target = { root: await fs.realpath(s.target.root), files: [] };
  const blocked = await entry(s.env, { functions: ['review'], first: { function: 'review', target }, scenarios: [{ carrier: async (prompt) => (prompt.includes(' targets <<') ? null : undefined) }] });
  const done = await entry(s.env, { functions: ['review'], first: { function: 'review', target } });
  const report = (body) => s.env.request('chain-report', body);
  const after = await report({ functions: ['review', 'review'], runs: [{ state: blocked.runs[0].state }, { state: done.runs[0].state }] });
  assert.equal(after.ok, false);
  assert.equal(after.code, 'E_INPUT');
  const fake = await report({ functions: ['review', 'update'], runs: [{ function: 'review', result: { stopKind: 'complete', findings: [] } }] });
  assert.equal(fake.ok, false);
  const hf = await report({ functions: ['review', 'update'], runs: [{ state: blocked.runs[0].state }], hostFailure: 'boom', target });
  assert.equal(hf.ok, false);
  const ok = await report({ functions: ['review', 'update'], runs: [{ state: done.runs[0].state }], hostFailure: 'boom', target });
  assert.equal(ok.ok, true, ok.reason);
});
