import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  SKILL_DIR, assetIds, createArgs, defaults, newKey, resumeArgs, runAuthor, setup, updateArgs, writePayload,
} from './helpers/bp-harness.mjs';
import { readAll } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/journal.mjs';
import { buildView } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/view.mjs';
import { RESULT_KEYS, STATES_DIR } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';

async function logOf(env, state) {
  return readAll(path.join(env.root, STATES_DIR, state));
}

async function viewOf(env, state) {
  return buildView(await logOf(env, state));
}

function roles(calls) {
  return calls.map((c) => c.label);
}

function stageOrder(lines) {
  return lines.flatMap((l) => l.records.filter((r) => r.t === 'stage').map((r) => `${r.stage}${r.round == null ? '' : `.${r.round}`}`));
}

const MIN = { create: 22, update: 23 };

// 候補を 1 件だけ返す適合の観点の検証役（不適合の単位に鍵を添える）。
function nonconformVerifier({ when = () => true } = {}) {
  return async (prompt, options, env, call, calls) => {
    const viewpoint = options.label.split(':')[1];
    if (viewpoint !== 'conformance' || !when(calls)) return defaults.verify(prompt, options, env);
    const result = await defaults.verify(prompt, options, env);
    const asset = assetIds(prompt)[0];
    const { kinds } = await env.readFromPrompt(prompt, 'kinds');
    const unit = result.units.find((u) => u.result === 'conform');
    const key = { asset, viewpoint: 'conformance', kind: kinds.find((k) => k.value === unit.unit)?.value ?? kinds[0].value };
    result.judgements[0].judgement = 'candidate';
    result.candidates = [{ ...key, quote: 'L1: 本文', content: '基準に反する', fix: '直す' }];
    unit.result = 'nonconform';
    unit.keys = [key];
    await writePayload(prompt, result);
    return result;
  };
}

test('SP-BPRUN-001・SP-BPAUTHORING-005・SP-BPAUTHORING-020: create の 1 run が段を表の順に進め、1 つの機能だけを実行して完了する', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { result, calls } = await runAuthor(t, { env: s.env, args: createArgs(s.target) });
  assert.equal(result.stopKind, 'complete', result.reason);
  const lines = await logOf(s.env, result.state);
  assert.deepEqual(stageOrder(lines), ['goal.1', 'write.1', 'ledger.1', 'verify.1', 'refute.1', 'rejudge.1', 'gate.1']);
  assert.equal(lines[0].records[0].function, 'create');
  assert.ok(lines.every((l) => l.run === 'r1'));
  assert.deepEqual([...new Set(calls.filter((c) => c.role === 'verify').map((c) => c.label))], ['verifier:conformance', 'verifier:goal']);
});

test('SP-BPRUN-003: 最初の起動が開始の運搬役で、再開の run に新しい run ID が登録されて現在の run になる', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const first = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { goal: async () => ({ missing: [{ question: '対象の形式は？', reason: '依頼文に無い' }] }) } });
  assert.equal(first.calls[0].role, 'carrier');
  assert.match(first.calls[0].prompt, / start <</);
  const second = await runAuthor(t, { env: s.env, args: resumeArgs(first.result, { answer: 'YAML だけ' }) });
  assert.equal(second.calls[0].role, 'carrier');
  assert.equal(second.result.run, 'r2');
  const view = await viewOf(s.env, first.result.state);
  assert.equal(view.runs.at(-1).id, 'r2');
});

test('SP-BPRUN-034・SP-BPRUN-023: 停止の記録の起動数が backend の呼び出しの数と一致し、全ての起動が役の model と effort を持つ', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { result, calls } = await runAuthor(t, { env: s.env, args: createArgs(s.target) });
  assert.equal(result.launches, calls.length);
  const view = await viewOf(s.env, result.state);
  assert.equal(view.stops.get('r1').launches, calls.length);
  const expect = { carrier: ['haiku', 'low'], goal: ['opus', 'high'], write: ['opus', 'high'], verify: ['opus', 'high'], refute: ['opus', 'high'], vanish: ['opus', 'high'] };
  for (const c of calls) assert.deepEqual([c.model, c.effort], expect[c.role], c.label);
});

test('SP-BPAUTHORING-009・SP-BPRUN-024: 固定した目標が書く段より前に前提として書かれ、検証役は書き手と別の起動である', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { result, calls } = await runAuthor(t, { env: s.env, args: createArgs(s.target) });
  const lines = await logOf(s.env, result.state);
  const goalLine = lines.findIndex((l) => l.records.some((r) => r.t === 'premise' && r.kind === 'goal'));
  const writeLine = lines.findIndex((l) => l.records.some((r) => r.t === 'stage' && r.stage === 'write'));
  assert.ok(goalLine >= 0 && goalLine < writeLine);
  const firstVerifier = calls.findIndex((c) => c.role === 'verify');
  assert.ok(calls.findIndex((c) => c.role === 'write') < firstVerifier);
  assert.ok(calls.filter((c) => c.role === 'verify').every((c) => c.role !== 'write'));
});

test('SP-BPAUTHORING-001: create の対象スキルのパスの一覧が .agents/skills/<name>/ だけで、書き手の置いた script がその中にある', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const write = async (prompt) => {
    const out = await defaults.write(prompt);
    const file = path.join(s.target.root, 'scripts', 'flow.js');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "export const meta = { name: 'flow', description: 'd' }\n");
    return { ...out, written: [...out.written, { path: file, action: 'write' }] };
  };
  const { result } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { write } });
  assert.equal(result.stopKind, 'complete', result.reason);
  const view = await viewOf(s.env, result.state);
  assert.equal(view.paths[0].root, s.target.root);
  assert.deepEqual(view.paths[0].files, []);
  assert.deepEqual(result.skill.files.map((f) => f.path).sort(), ['SKILL.md', 'scripts/flow.js']);
  assert.equal(result.skill.root, s.target.root);
});

test('SP-BPAUTHORING-029・SP-BPRUN-003・SP-BPRUN-011: 空の依頼文の create は agent を起動せず needs_input を返し、停止の記録も next_args も無い', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { result, calls } = await runAuthor(t, { env: s.env, args: createArgs(s.target, { request: '  ' }) });
  assert.deepEqual(calls, []);
  assert.equal(result.stopKind, 'needs_input');
  assert.match(result.reason, /依頼文が空/);
  assert.equal(result.nextArgs, undefined);
  assert.equal(result.state, undefined);
});

test('SP-BPAUTHORING-029: dismissed の指摘だけの修正の根拠の update は agent を起動せず needs_input と件数を返す', async (t) => {
  const s = await setup(t, { fn: 'update' });
  if (!s) return;
  const grounds = [{ id: 'F1', state: 'dismissed' }, { id: 'F2', state: 'dismissed' }];
  const { result, calls } = await runAuthor(t, { env: s.env, args: updateArgs(s.target, { grounds }) });
  assert.deepEqual(calls, []);
  assert.equal(result.stopKind, 'needs_input');
  assert.match(result.reason, /受け取った 2 件、扱わなかった 2 件/);
});

test('SP-BPRUN-037: 0・小数・文字列の上限で agent() を 0 回呼び、BLOCKED と渡された値を返す', async (t) => {
  const s = await setup(t);
  if (!s) return;
  for (const bad of [0, 1.5, '30']) {
    const { result, calls } = await runAuthor(t, { env: s.env, args: createArgs(s.target, { maxLaunches: bad }) });
    assert.deepEqual(calls, []);
    assert.equal(result.stopKind, 'blocked');
    assert.ok(result.reason.includes(JSON.stringify(bad)), result.reason);
  }
});

test('SP-BPRUN-037・SP-BPRUN-021: create と update のそれぞれで、最小に 1 足りない上限では agent を 1 体も起動せず、最小と同じ上限では最初の検証の項目まで進む', async (t) => {
  for (const fn of ['create', 'update']) {
    const s = await setup(t, { fn });
    if (!s) return;
    const args = fn === 'create' ? createArgs : updateArgs;
    const short = await runAuthor(t, { env: s.env, args: args(s.target, { maxLaunches: MIN[fn] - 1 }) });
    assert.deepEqual(short.calls, [], fn);
    assert.equal(short.result.stopKind, 'blocked');
    assert.match(short.result.reason, new RegExp(`最小の起動数 ${MIN[fn]}`));
    const exact = await runAuthor(t, { env: s.env, args: args(s.target, { maxLaunches: MIN[fn] }), maxAgents: MIN[fn] });
    assert.ok(exact.calls.some((c) => c.role === 'verify'), fn);
    assert.ok(exact.result.launches <= MIN[fn]);
  }
});

test('SP-BPAUTHORING-005・SP-BPRUN-004・SP-BPAUTHORING-006: update が写しの段と契約の観点だけを足して進み、修正の根拠が開始で書かれ目標の書き手に写しのパスと根拠が渡る', async (t) => {
  const s = await setup(t, { fn: 'update' });
  if (!s) return;
  const grounds = [{ kind: '利用者の指示', text: '説明を短くする' }, { id: 'F9', state: 'open', viewpoint: 'conformance' }, { id: 'F8', state: 'dismissed' }];
  const { result, calls } = await runAuthor(t, { env: s.env, args: updateArgs(s.target, { grounds }) });
  assert.equal(result.stopKind, 'complete', result.reason);
  const lines = await logOf(s.env, result.state);
  assert.deepEqual(lines[0].records.filter((r) => r.t === 'ground').map((r) => r.id), ['G1', 'G2', 'G3']);
  assert.deepEqual(stageOrder(lines), ['snapshot', 'goal.1', 'write.1', 'ledger.1', 'verify.1', 'refute.1', 'rejudge.1', 'gate.1']);
  assert.deepEqual([...new Set(calls.filter((c) => c.role === 'verify').map((c) => c.label))], ['verifier:conformance', 'verifier:goal', 'verifier:contract']);
  const goal = calls.find((c) => c.role === 'goal').prompt;
  assert.match(goal, /作り直す前の写し: .*snapshot\/root\//);
  assert.match(goal, /"id":"G1"/);
  assert.match(goal, /"id":"G2"/);
  assert.doesNotMatch(goal, /"id":"G3"/);
  assert.deepEqual(result.receivedGrounds, [{ ground: 'G1' }, { ground: 'G2', finding: 'F9' }, { ground: 'G3', finding: 'F8' }]);
});

test('SP-BPAUTHORING-029: 無いディレクトリを指す update は開始の運搬役の後に agent を起動せず BLOCKED を返す', async (t) => {
  const s = await setup(t, { fn: 'update' });
  if (!s) return;
  const { result, calls } = await runAuthor(t, { env: s.env, args: updateArgs({ root: path.join(s.base, 'nothing') }) });
  assert.deepEqual(roles(calls), ['carrier']);
  assert.equal(result.stopKind, 'blocked');
  assert.match(result.reason, /対象スキルのディレクトリが無い/);
  assert.equal(result.nextArgs, undefined);
});

test('SP-BPENTRY-013: 表に無い項目と、再開に渡してはならない項目を BLOCKED にする', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const stray = await runAuthor(t, { env: s.env, args: createArgs(s.target, { extra: 1 }) });
  assert.deepEqual(stray.calls, []);
  assert.match(stray.result.reason, /表に無い項目.*extra/);
  const resume = await runAuthor(t, { env: s.env, args: { nextArgs: { function: 'create', state: 'bp-x' }, request: 'x', skillDir: SKILL_DIR, key: newKey() } });
  assert.deepEqual(resume.calls, []);
  assert.match(resume.result.reason, /再開に渡してはならない項目.*request/);
  assert.deepEqual(resume.result.nextArgs, { function: 'create', state: 'bp-x' });
});

test('SP-BPAUTHORING-033・SP-BPAUTHORING-032: create の完了の返り値にパスと指紋・設計の説明の逐語の本文・検証の結果・skip 一覧・残る危険がある', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { result } = await runAuthor(t, { env: s.env, args: createArgs(s.target) });
  assert.equal(result.stopKind, 'complete');
  const text = await fs.readFile(path.join(s.target.root, 'SKILL.md'), 'utf8');
  assert.equal(result.designNote.text, text.slice(text.indexOf('## 設計の説明')));
  assert.match(result.skill.files[0].digest, /^[0-9a-f]{64}$/);
  for (const key of ['decision', 'iterations', 'units', 'forcedUnchecked', 'basisConstraints', 'ledger']) assert.ok(Object.hasOwn(result.verification, key), key);
  assert.equal(result.verification.contract, undefined);
  assert.deepEqual(result.skip.map((x) => x.viewpoint), ['conformance', 'goal']);
  assert.deepEqual(Object.keys(result.residualRisks[0]).sort(), ['host', 'reason', 'restriction', 'role']);
  assert.ok(result.verification.forcedUnchecked.length > 0);
  assert.equal(result.receivedGrounds, undefined);
  for (const key of Object.keys(result)) assert.ok(['ok', 'op', 'sum', ...Object.values(RESULT_KEYS)].includes(key), key);
});

test('SP-BPAUTHORING-026: 完了で止まると書いたファイルに検証を通ったことが追記され、完了以外の停止では追記されない', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const done = await runAuthor(t, { env: s.env, args: createArgs(s.target) });
  assert.ok(done.result.writtenFiles.every((f) => f.verified));
  const s2 = await setup(t);
  const limited = await runAuthor(t, { env: s2.env, args: createArgs(s2.target), scenario: { verify: nonconformVerifier() } });
  assert.equal(limited.result.stopKind, 'iteration_limit');
  const view = await viewOf(s2.env, limited.result.state);
  assert.deepEqual(view.verified, []);
  assert.ok(limited.result.writtenFiles.every((f) => !f.verified));
});

test('SP-BPAUTHORING-025・SP-BPAUTHORING-034・SP-BPRUN-010・SP-BPAUTHORING-024: 不合格が続くと反復の上限で止まり、理由に指摘 ID と判定の単位があり、返り値に検証の結果と止まった段がある', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { result, calls } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { verify: nonconformVerifier() } });
  assert.equal(result.stopKind, 'iteration_limit');
  assert.equal(calls.filter((c) => c.role === 'write').length, 3);
  const finding = result.verification.decision.findings[0];
  assert.match(finding, /^F/);
  assert.ok(result.reason.includes(finding));
  assert.ok(result.reason.includes(result.verification.decision.units[0]));
  assert.equal(result.stoppedStage, '合否');
  assert.deepEqual(result.verification.iterations, { total: 3, run: 3 });
  const view = await viewOf(s.env, result.state);
  assert.equal(view.stops.get('r1').limitHit, 'iteration');
  assert.ok(result.unverified.length > 0);
});

test('SP-BPAUTHORING-014: 2 回目の書く段に不合格の指摘と判定の単位だけが渡る', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { calls } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { verify: nonconformVerifier({ when: (all) => all.filter((c) => c.role === 'write').length === 1 }) } });
  const writes = calls.filter((c) => c.role === 'write');
  assert.equal(writes.length, 2);
  assert.doesNotMatch(writes[0].prompt, /書き直しの入力/);
  const rewrite = JSON.parse(/書き直しの入力（[^）]+）:\n(.+)/.exec(writes[1].prompt)[1]);
  assert.deepEqual(Object.keys(rewrite).sort(), ['findings', 'units']);
  assert.equal(rewrite.findings.length, 1);
  assert.equal(rewrite.units.length, 1);
  assert.equal(rewrite.units[0].result, 'nonconform');
});

test('SP-BPRUN-013・SP-BPAUTHORING-010・SP-BPAUTHORING-035: 反復の上限で止まった run を再開すると、目標の固定を飛ばし、増分で数えてすぐには止まらない', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const first = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { verify: nonconformVerifier() } });
  assert.equal(first.result.stopKind, 'iteration_limit');
  const second = await runAuthor(t, { env: s.env, args: resumeArgs(first.result) });
  assert.equal(second.result.stopKind, 'complete', second.result.reason);
  assert.equal(second.calls.filter((c) => c.role === 'goal').length, 0);
  assert.equal(second.calls.filter((c) => c.role === 'write').length, 1);
  assert.deepEqual(second.result.verification.iterations, { total: 4, run: 1 });
  const view = await viewOf(s.env, first.result.state);
  assert.ok([...view.stages.keys()].includes('write|4'));
});
