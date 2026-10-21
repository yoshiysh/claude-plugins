import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  SKILL_DIR, assetIds, createArgs, defaults, newKey, resumeArgs, runAuthor, setup, updateArgs, variant, writePayload,
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

test('SP-BPAUTHORING-008・SP-BPRUN-002・SP-BPRUN-032・SP-BPRUN-004: 書き手が足りない入力を返すと needs_input と問いの一覧と next_args を返し、回答を足した再開が回答を前提に書いて目標の固定から始める', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const first = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { goal: async () => ({ missing: [{ question: '対象の形式は？', reason: '指示語が指すものが無い' }] }) } });
  assert.equal(first.result.stopKind, 'needs_input');
  assert.match(first.result.reason, /対象の形式は？（指示語が指すものが無い）/);
  assert.deepEqual(first.result.nextArgs, { function: 'create', state: first.result.state });
  assert.equal(first.calls.filter((c) => c.role === 'write').length, 0);
  const second = await runAuthor(t, { env: s.env, args: resumeArgs(first.result, { answer: 'YAML だけ' }) });
  assert.equal(second.result.stopKind, 'complete', second.result.reason);
  const view = await viewOf(s.env, first.result.state);
  const answer = view.premises.find((p) => p.kind === 'answer');
  assert.equal(answer.text, 'YAML だけ');
  assert.equal(answer.run, 'r2');
  assert.match(second.calls.find((c) => c.role === 'goal').prompt, /YAML だけ/);
  assert.ok([...view.stages.keys()].includes('goal|2'));
  assert.ok(view.items.get([...view.stages.get('goal|1').items][0]).discarded);
});

test('SP-BPAUTHORING-003: 再開の run の目標の固定の書き手に、状態にある依頼文と同じ文字列が渡る', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const args = createArgs(s.target);
  const first = await runAuthor(t, { env: s.env, args, scenario: { goal: async () => ({ missing: [{ question: 'q', reason: 'r' }] }) } });
  const second = await runAuthor(t, { env: s.env, args: resumeArgs(first.result, { answer: 'a' }) });
  assert.ok(second.calls.find((c) => c.role === 'goal').prompt.includes(`依頼文:\n${args.request}`));
});

test('SP-BPAUTHORING-007: 出所の照合が上限の回まで通らないと、needs_input と出所の無い要素を返す', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const goal = async () => ({ goal: { deliverables: [{ text: 'x', sources: [{ kind: 'request', quote: '依頼文に無い文' }] }], scope: [], prohibitions: [], numeric: [], deixis: [] } });
  const { result, calls } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { goal } });
  assert.equal(result.stopKind, 'needs_input');
  assert.equal(calls.filter((c) => c.role === 'goal').length, 3);
  assert.match(result.reason, /deliverables\[0\]: 依頼文に無い引用: 依頼文に無い文/);
  assert.match(calls.filter((c) => c.role === 'goal')[1].prompt, /前の回の出所の照合で通らなかった要素/);
});

test('SP-BPAUTHORING-007: 目標の固定を BLOCKED から始め直しても繰り返しの回数の累計が引き継がれ、上限の回で needs_input になった run に回答を足して再開すると書き手が起動される', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const bad = { goal: { deliverables: [{ text: 'x', sources: [{ kind: 'request', quote: '無い文' }] }], scope: [], prohibitions: [], numeric: [], deixis: [] } };
  let n = 0;
  const first = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { goal: async () => { n += 1; return n === 1 ? bad : null; } } });
  assert.equal(first.result.stopKind, 'blocked');
  const second = await runAuthor(t, { env: s.env, args: resumeArgs(first.result), scenario: { goal: async () => bad } });
  assert.equal(second.result.stopKind, 'needs_input');
  const view = await viewOf(s.env, first.result.state);
  assert.equal(view.repeats.get('goal'), 4);
  const third = await runAuthor(t, { env: s.env, args: resumeArgs(second.result, { answer: '回答' }) });
  assert.ok(third.calls.some((c) => c.role === 'goal'));
  assert.equal(third.result.stopKind, 'complete', third.result.reason);
});

test('SP-BPAUTHORING-015・SP-BPAUTHORING-031・SP-BPAUTHORING-028: 一覧の中と外のパスを返す書き手で BLOCKED になり、中のパスが記録され、外のパスが検証を通っていないことに載り、外のファイルは戻されず台帳の段へ進まない', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const outside = path.join(s.base, 'outside.md');
  const write = async (prompt) => {
    const out = await defaults.write(prompt);
    await fs.writeFile(outside, '外');
    return { ...out, written: [...out.written, { path: outside, action: 'write' }] };
  };
  const { result } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { write } });
  assert.equal(result.stopKind, 'blocked');
  assert.ok(result.reason.includes(outside));
  assert.deepEqual(result.unverified, [{ path: 'SKILL.md', action: 'write' }, { path: outside, outside: true }]);
  assert.equal(await fs.readFile(outside, 'utf8'), '外');
  assert.ok(await fs.stat(path.join(s.target.root, 'SKILL.md')));
  const lines = await logOf(s.env, result.state);
  assert.ok(!stageOrder(lines).includes('ledger.1'));
  assert.equal(result.stoppedStage, '書く');
});

test('SP-BPAUTHORING-015・SP-BPAUTHORING-005: 結果を返さない書き手で BLOCKED になり、指紋の食い違う一覧の中のファイルが書いたファイルの一覧に記録される', async (t) => {
  const s = await setup(t, { fn: 'update' });
  if (!s) return;
  const write = async () => {
    await fs.writeFile(path.join(s.target.root, 'SKILL.md'), '---\nname: x\n---\n# 書きかけ\n');
    await fs.writeFile(path.join(s.target.root, 'extra.md'), '足した');
    return null;
  };
  const { result } = await runAuthor(t, { env: s.env, args: updateArgs(s.target), scenario: { write } });
  assert.equal(result.stopKind, 'blocked');
  assert.match(result.reason, /書き手が結果を返さなかった。一覧の外は確かめていない/);
  assert.deepEqual(result.writtenFiles.map((f) => [f.path, f.action, f.verified]).sort(), [['SKILL.md', 'write', false], ['extra.md', 'write', false]]);
});

test('SP-BPAUTHORING-002・SP-BPAUTHORING-015: update の書き手がディレクトリの中でファイルを足し・消しても BLOCKED にならず、足したファイルが取り直した一覧の台帳に入る', async (t) => {
  const s = await setup(t, { fn: 'update', files: { 'SKILL.md': '---\nname: x\n---\n# X\n## 設計の説明\nd\n', 'old.md': '# 古い\n' } });
  if (!s) return;
  const write = async () => {
    await fs.rm(path.join(s.target.root, 'old.md'));
    await fs.writeFile(path.join(s.target.root, 'new.md'), '# 新しい\n本文\n');
    return { written: [{ path: path.join(s.target.root, 'old.md'), action: 'delete' }, { path: path.join(s.target.root, 'new.md'), action: 'write' }], designNote: { path: 'SKILL.md', heading: '設計の説明' } };
  };
  const { result } = await runAuthor(t, { env: s.env, args: updateArgs(s.target), scenario: { write } });
  assert.equal(result.stopKind, 'complete', result.reason);
  assert.deepEqual(result.skill.deleted, ['old.md']);
  const view = await viewOf(s.env, result.state);
  assert.ok([...view.assets.values()].some((a) => a.path === 'new.md' && !a.gone));
});

test('SP-BPAUTHORING-015・SP-BPENTRY-023: 解決できない callsite を足した書き手の後に callsite が行番号とともに状態に書かれ、直さなければ返り値に載り、次の反復で直すと載らない', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const broken = (number) => async (prompt) => {
    const out = await defaults.write(prompt);
    const root = s.target.root;
    const body = number(prompt) ? 'Workflow({ scriptPath: "scripts/none.js" })\n' : '';
    await fs.appendFile(path.join(root, 'SKILL.md'), body);
    return out;
  };
  const first = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { write: broken(() => true) } });
  assert.equal(first.result.stopKind, 'complete', first.result.reason);
  assert.equal(first.result.excludedCallsites.length, 1);
  assert.equal(first.result.excludedCallsites[0].line, 9);
  const s2 = await setup(t);
  const fixed = await runAuthor(t, {
    env: s2.env, args: createArgs(s2.target),
    scenario: {
      write: async (prompt) => {
        const out = await defaults.write(prompt);
        if (/反復の番号: 1\n/.test(prompt)) await fs.appendFile(path.join(s2.target.root, 'SKILL.md'), 'Workflow({ scriptPath: "scripts/none.js" })\n');
        return out;
      },
      verify: nonconformVerifier({ when: (all) => all.filter((c) => c.role === 'write').length === 1 }),
    },
  });
  assert.equal(fixed.result.stopKind, 'complete', fixed.result.reason);
  assert.equal(fixed.result.excludedCallsites, undefined);
  const view = await viewOf(s2.env, fixed.result.state);
  assert.equal(view.paths.find((p) => p.iteration === 1).unresolved.length, 1);
});

function candidateVerifier(viewpointWanted, kindOf = (kinds) => kinds[0].value) {
  return async (prompt, options, env) => {
    const viewpoint = options.label.split(':')[1];
    const result = await defaults.verify(prompt, options, env);
    if (viewpoint !== viewpointWanted || options.label.endsWith(':extra')) return result;
    const asset = assetIds(prompt)[0];
    const { kinds } = await env.readFromPrompt(prompt, 'kinds');
    result.judgements[0].judgement = 'candidate';
    result.candidates = [{ asset, viewpoint, kind: kindOf(kinds), quote: 'L1: x', content: 'c', fix: 'f' }];
    await writePayload(prompt, result);
    return result;
  };
}

test('SP-BPAUTHORING-030・SP-BPAUTHORING-023・SP-BPFINDINGS-015: 反証役が結果を返さないと未反証の候補が残り、BLOCKED と未反証の候補を理由に返す', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const both = async (prompt, options, env) => {
    const viewpoint = options.label.split(':')[1];
    return candidateVerifier(viewpoint)(prompt, options, env);
  };
  const refute = async (prompt) => (prompt.includes('"viewpoint":"goal"') ? null : { verdict: 'reject', reason: '当たらない' });
  const { result, calls } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { verify: both, refute } });
  assert.equal(result.stopKind, 'blocked');
  assert.match(result.reason, /未反証の候補: .*\/goal\//);
  assert.equal(calls.filter((c) => c.role === 'refute').length, 4);
  assert.equal(result.verification.decision.value, 'unverifiable');
  assert.deepEqual(result.verification.ledger.findings.map((f) => [f.viewpoint, f.state]), [['conformance', 'dismissed']]);
});

test('SP-BPAUTHORING-030・SP-BPAUTHORING-023・SP-BPFINDINGS-025: 検証役が結果を返さず追加の検証でも見られないと skip 一覧が残り、BLOCKED と skip 一覧の資産を理由に返す', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const verify = async (prompt, options, env) => {
    if (!options.label.startsWith('verifier:goal')) return defaults.verify(prompt, options, env);
    const empty = { judgements: [], candidates: [], basisConstraints: [] };
    await writePayload(prompt, empty);
    return empty;
  };
  const { result, calls } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { verify } });
  assert.equal(result.stopKind, 'blocked');
  assert.match(result.reason, /skip 一覧に残った資産: goal=/);
  assert.equal(calls.filter((c) => c.label === 'verifier:goal').length, 1);
  assert.equal(calls.filter((c) => c.label === 'verifier:goal:extra').length, 1);
  assert.ok(result.skip === undefined);
  assert.ok(result.verification.ledger.skip.find((x) => x.viewpoint === 'goal').assets.length > 0);
});

test('SP-BPFINDINGS-025: 1 回目の追加の起動で一部の資産が見られ、2 回目で 0 件になると追加の起動が止まり、追加の起動の担当は skip 一覧の資産だけになる', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const write = async (prompt) => {
    const out = await defaults.write(prompt);
    await fs.writeFile(path.join(s.target.root, 'a.md'), '# A\n');
    await fs.writeFile(path.join(s.target.root, 'b.md'), '# B\n');
    return out;
  };
  const verify = async (prompt, options, env) => {
    const result = await defaults.verify(prompt, options, env);
    if (!options.label.startsWith('verifier:goal')) return result;
    const ids = assetIds(prompt);
    const extra = options.label.endsWith(':extra');
    const keep = extra ? ids.slice(0, 1) : ids.slice(0, -2);
    const out = { ...result, judgements: result.judgements.filter((j) => keep.includes(j.asset)) };
    if (extra && ids.length === 1) return null;
    await writePayload(prompt, out);
    return out;
  };
  const { result, calls } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { write, verify } });
  const extras = calls.filter((c) => c.label === 'verifier:goal:extra');
  assert.equal(assetIds(extras[0].prompt).length, 2);
  assert.equal(assetIds(extras[1].prompt).length, 1);
  assert.equal(result.stopKind, 'blocked');
  assert.equal(result.verification.ledger.skip.find((x) => x.viewpoint === 'goal').assets.length, 1);
});

test('SP-BPAUTHORING-035・SP-BPRUN-015: 検証が成り立たない BLOCKED から再開すると、書き手を起動せず新しい反復の台帳の段から検証し直し、前の回の打ち切りを引き継がない（依頼者の裁定 Q6）', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const first = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { verify: async () => null } });
  assert.equal(first.result.stopKind, 'blocked');
  assert.match(first.result.reason, /全ての項目が試行の上限で打ち切りになった/);
  const second = await runAuthor(t, { env: s.env, args: resumeArgs(first.result) });
  assert.equal(second.result.stopKind, 'complete', second.result.reason);
  assert.equal(second.calls.filter((c) => c.role === 'write' || c.role === 'goal').length, 0);
  const view = await viewOf(s.env, first.result.state);
  const v1 = view.stages.get('verify|1').items;
  const v2 = view.stages.get('verify|2').items;
  assert.ok(v1.every((id) => view.items.get(id).aborted));
  assert.ok(v2.every((id) => !v1.includes(id) && view.items.get(id).result !== undefined));
  assert.ok(!view.stages.has('write|2'));
  assert.equal(second.result.verification.iterations.total, 1);
});

test('SP-BPRUN-028・SP-BPRUN-029: 1 件の欠けでは run が止まらず試行を繰り返し、検証役の結果の台帳に無い資産 ID は BLOCKED にならず試行の回数が増える', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const seen = new Map();
  const verify = async (prompt, options, env) => {
    const n = (seen.get(options.label) ?? 0) + 1;
    seen.set(options.label, n);
    if (options.label === 'verifier:conformance' && n === 1) return null;
    if (options.label === 'verifier:goal' && n === 1) {
      const bad = { judgements: [{ asset: 'ANOTINLEDGER', judgement: 'ok' }], candidates: [], basisConstraints: [] };
      await writePayload(prompt, bad);
      return bad;
    }
    return defaults.verify(prompt, options, env);
  };
  const { result } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { verify } });
  assert.equal(result.stopKind, 'complete', result.reason);
  const view = await viewOf(s.env, result.state);
  const items = view.stages.get('verify|1').items.map((id) => view.items.get(id));
  assert.deepEqual(items.map((i) => i.fails.length), [1, 1]);
  assert.equal(result.verification.ledger.rejected.count, 1);
});

test('SP-BPRUN-020・SP-BPAUTHORING-041・SP-BPRUN-010・SP-BPRUN-022・SP-BPRUN-035・SP-BPRUN-015: 同時実行 3 で上限に収まらない項目を起動せず表の順で未着手に残して反復の上限で止まり、再開が未着手の項目だけを処理し、next_args に上限が無い', async (t) => {
  const s = await setup(t, { fn: 'update' });
  if (!s) return;
  const limit = MIN.update + 1;
  const first = await runAuthor(t, { env: s.env, args: updateArgs(s.target, { maxLaunches: limit }), maxAgents: limit });
  assert.equal(first.result.stopKind, 'iteration_limit');
  assert.match(first.result.reason, new RegExp(`起動数の上限 ${limit}`));
  assert.ok(first.result.launches <= limit);
  assert.deepEqual(Object.keys(first.result.nextArgs).sort(), ['function', 'state']);
  const view = await viewOf(s.env, first.result.state);
  const stop = view.stops.get('r1');
  assert.equal(stop.limitHit, 'launch');
  const verifyItems = view.stages.get('verify|1').items;
  const done = verifyItems.filter((id) => view.items.get(id).result !== undefined);
  assert.deepEqual(stop.pending, verifyItems.filter((id) => !done.includes(id)));
  assert.deepEqual(verifyItems.map((id) => view.items.get(id).key.viewpoint), ['conformance', 'goal', 'contract']);
  const second = await runAuthor(t, { env: s.env, args: resumeArgs(first.result) });
  assert.equal(second.result.stopKind, 'complete', second.result.reason);
  const relaunched = second.calls.filter((c) => c.role === 'verify').map((c) => c.label);
  assert.deepEqual(relaunched, stop.pending.map((id) => `verifier:${view.items.get(id).key.viewpoint}`));
  assert.equal(second.calls.filter((c) => c.role === 'write').length, 0);
});

test('SP-BPRUN-020・SP-BPRUN-040: 上限を渡さない run は項目を切らず、上限を渡した run の起動数は同時実行 3 でも上限以下で、予約分の停止の運搬役が起動できる', async (t) => {
  for (const limit of [MIN.create, MIN.create + 4, MIN.create + 9]) {
    const s = await setup(t);
    if (!s) return;
    const { result, calls } = await runAuthor(t, { env: s.env, args: createArgs(s.target, { maxLaunches: limit }), maxAgents: limit, scenario: { verify: candidateVerifier('goal') } });
    assert.ok(calls.length <= limit, `${limit}: ${calls.length}`);
    assert.equal(result.launches, calls.length);
    assert.match(calls.at(-1).prompt, / stop <</);
  }
  const s = await setup(t);
  const { result, calls } = await runAuthor(t, { env: s.env, args: createArgs(s.target) });
  assert.equal(result.stopKind, 'complete', result.reason);
  assert.equal(calls.filter((c) => c.role === 'verify').length, 2);
});

test('SP-BPRUN-031・SP-BPRUN-006: 結果を書いた運搬役が応答を失っても、同じ要求の送り直しで記録が 1 回分のままになる', async (t) => {
  const s = await setup(t);
  if (!s) return;
  let dropped = 0;
  const carrier = async (prompt, options, env) => {
    const out = await env.carry(prompt);
    if (prompt.includes(' verdicts <<') && dropped === 0) { dropped += 1; return null; }
    return out;
  };
  const { result } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { carrier } });
  assert.equal(result.stopKind, 'complete', result.reason);
  const lines = await logOf(s.env, result.state);
  const verdictLines = lines.filter((l) => l.op === 'verdicts');
  assert.equal(verdictLines.length, 2);
  const view = buildView(lines);
  assert.ok(view.stages.get('verify|1').items.every((id) => view.items.get(id).fails.length === 0));
});

test('SP-BPRUN-027・SP-BPRUN-030: 運搬役の失敗で BLOCKED と段・役・失敗の内容を返し、停止の記録の運搬役の失敗では記録を書かずに返す', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const carrier = async (prompt, options, env) => (prompt.includes(' ledger-create <<') ? null : env.carry(prompt));
  const { result } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { carrier } });
  assert.equal(result.stopKind, 'blocked');
  assert.match(result.reason, /段「台帳」の運搬役（CLI）が失敗した: 運搬役が結果を返さなかった/);
  const s2 = await setup(t);
  const carrier2 = async (prompt, options, env) => (prompt.includes(' stop <<') || prompt.includes(' ledger-create <<') ? null : env.carry(prompt));
  const second = await runAuthor(t, { env: s2.env, args: createArgs(s2.target), scenario: { carrier: carrier2 } });
  assert.equal(second.result.stopKind, 'blocked');
  assert.match(second.result.reason, /停止の記録を書けなかった/);
  const view = await viewOf(s2.env, second.result.state);
  assert.equal(view.stops.size, 0);
  assert.deepEqual(second.result.nextArgs, { function: 'create', state: second.result.state });
});

test('SP-BPRUN-018・SP-BPRUN-038: 段の途中で停止の記録を書かずに終わった run を再開すると、列挙した項目のうち結果の無いものだけが処理される', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const verify = async (prompt, options, env) => (options.label === 'verifier:goal' ? null : defaults.verify(prompt, options, env));
  const carrier = async (prompt, options, env) => (prompt.includes(' item-fail <<') || prompt.includes(' stop <<') ? null : env.carry(prompt));
  const first = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { verify, carrier } });
  assert.equal(first.result.stopKind, 'blocked');
  const listed = await s.env.request('list', { function: 'create', target: { root: s.target.root } });
  assert.equal(listed.states[0].state, first.result.state);
  assert.equal(listed.states[0].stoppedStage.stage, 'verify');
  const second = await runAuthor(t, { env: s.env, args: resumeArgs({ nextArgs: listed.states[0].nextArgs }) });
  assert.equal(second.result.stopKind, 'complete', second.result.reason);
  assert.deepEqual(second.calls.filter((c) => c.role === 'verify').map((c) => c.label), ['verifier:goal']);
});

test('SP-BPRUN-031: 検証役の結果を要求に含めて運ぶ形（PAYLOAD_MODE inline）でも同じく完了する', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const scriptPath = await variant(t, [["const PAYLOAD_MODE = 'file'", "const PAYLOAD_MODE = 'inline'"]]);
  const { result, calls } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scriptPath });
  assert.equal(result.stopKind, 'complete', result.reason);
  assert.ok(calls.filter((c) => c.prompt.includes(' verdicts <<')).every((c) => !c.prompt.includes('payloadFile')));
});

test('SP-BPRUN-031: 作業ファイルに書いた結果が返り値と食い違うと E_TRANSPORT で試行の失敗として扱い、BLOCKED にしない', async (t) => {
  const s = await setup(t);
  if (!s) return;
  let n = 0;
  const verify = async (prompt, options, env) => {
    const result = await defaults.verify(prompt, options, env);
    if (options.label === 'verifier:goal' && (n += 1) === 1) await writePayload(prompt, { ...result, candidates: [{ asset: 'x' }] });
    return result;
  };
  const { result } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { verify } });
  assert.equal(result.stopKind, 'complete', result.reason);
  assert.ok(s.env.cliCalls.some((c) => c.code === 'E_TRANSPORT'));
});

test('SP-BPRUN-024・SP-BPAUTHORING-016: 検証役と反証役の入力に、書き手の返り値のうちパス以外（設計の説明の場所・見出し）が含まれない', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const write = async (prompt) => ({ ...(await defaults.write(prompt)), designNote: { path: 'SKILL.md', heading: '設計の説明' } });
  const { calls } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { write, verify: candidateVerifier('goal') } });
  const judged = calls.filter((c) => c.role === 'verify' || c.role === 'refute');
  assert.ok(judged.some((c) => c.role === 'refute'));
  for (const c of judged) {
    assert.doesNotMatch(c.prompt, /designNote|"written"/, c.label);
  }
});

test('SP-BPAUTHORING-020: 契約の観点の候補が反証の段に渡る', async (t) => {
  const s = await setup(t, { fn: 'update' });
  if (!s) return;
  const verify = async (prompt, options, env) => {
    const result = await defaults.verify(prompt, options, env);
    if (options.label !== 'verifier:contract') return result;
    const asset = assetIds(prompt)[0];
    result.judgements[0].judgement = 'candidate';
    result.candidates = [{ asset, viewpoint: 'contract', kind: '契約:出力の変化', quote: 'L1', content: 'c', fix: 'f' }];
    result.contractChanges = [{ element: '出力', change: '出力が変わった', choice: 'none' }];
    await writePayload(prompt, result);
    return result;
  };
  const { calls } = await runAuthor(t, { env: s.env, args: updateArgs(s.target), scenario: { verify, refute: async () => ({ verdict: 'reject', reason: '変わっていない' }) } });
  assert.ok(calls.some((c) => c.role === 'refute' && c.prompt.includes('"viewpoint":"contract"')));
});

test('SP-BPAUTHORING-022・SP-BPAUTHORING-040: 契約の指摘が open の反復が不合格になり、修正の根拠を選んだ契約の変化は契約の判定の結果に載る', async (t) => {
  const s = await setup(t, { fn: 'update' });
  if (!s) return;
  const verify = async (prompt, options, env, call, calls) => {
    const result = await defaults.verify(prompt, options, env);
    if (options.label !== 'verifier:contract') return result;
    const asset = assetIds(prompt)[0];
    const first = calls.filter((c) => c.role === 'write').length === 1;
    result.contractChanges = [{ element: '入力', change: '入力が変わった', choice: 'G1' }];
    if (first) {
      result.judgements[0].judgement = 'candidate';
      result.candidates = [{ asset, viewpoint: 'contract', kind: '契約:発火する条件の変化', quote: 'L1', content: 'c', fix: 'f' }];
      result.contractChanges.push({ element: '発火する条件', change: '発火の条件が変わった', choice: 'none' });
    }
    await writePayload(prompt, result);
    return result;
  };
  const { result, calls } = await runAuthor(t, { env: s.env, args: updateArgs(s.target), scenario: { verify } });
  assert.equal(calls.filter((c) => c.role === 'write').length, 2);
  assert.equal(result.stopKind, 'complete', result.reason);
  assert.deepEqual(result.verification.contract, [{ element: '入力', change: '入力が変わった', choice: 'G1' }]);
  const contract = result.findings.find((f) => f.viewpoint === 'contract');
  assert.equal(contract.state, 'resolved');
});

test('SP-BPFINDINGS-018・SP-BPFINDINGS-012: 反復 1 で反証に却下された候補と同じ鍵の候補が、別の資産だけを書き換えた反復 2 で重複になり、dismissed が今の担当の指紋の組で記録され BLOCKED にならない', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const write = async (prompt) => {
    const out = await defaults.write(prompt);
    await fs.writeFile(path.join(s.target.root, 'y.md'), '# Y\n変わらない\n');
    return out;
  };
  let yAsset = null;
  const verify = async (prompt, options, env, call, calls) => {
    const result = await defaults.verify(prompt, options, env);
    const iteration = calls.filter((c) => c.role === 'write').length;
    if (options.label === 'verifier:conformance' && iteration === 1) return nonconformVerifier()(prompt, options, env, call, calls);
    if (options.label !== 'verifier:goal') return result;
    const { assets } = await env.readFromPrompt(prompt, 'report');
    yAsset = assets.find((a) => a.path === 'y.md').id;
    result.judgements.find((j) => j.asset === yAsset).judgement = 'candidate';
    result.candidates = [{ asset: yAsset, viewpoint: 'goal', kind: '目標:範囲の逸脱', quote: 'L1: Y', content: 'c', fix: 'f' }];
    await writePayload(prompt, result);
    return result;
  };
  const refute = async (prompt) => (prompt.includes('"viewpoint":"goal"') ? { verdict: 'reject', reason: '範囲の中' } : { verdict: 'uphold', reason: '当たる' });
  const { result, calls } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { write, verify, refute } });
  assert.equal(result.stopKind, 'complete', result.reason);
  assert.equal(calls.filter((c) => c.role === 'refute' && c.prompt.includes('"viewpoint":"goal"')).length, 1);
  const goal = result.findings.find((f) => f.viewpoint === 'goal');
  assert.equal(goal.state, 'dismissed');
  assert.equal(goal.judgedOnCurrent, true);
  const view = await viewOf(s.env, result.state);
  assert.equal(view.dups.length, 1);
});

test('SP-BPFINDINGS-020・SP-BPFINDINGS-037: 指摘のある節を書き手が消すと、消えた資産の照合の段で検証役が起動され、「該当なし」で状態が記録される', async (t) => {
  const s = await setup(t, { fn: 'update', files: { 'SKILL.md': '---\nname: x\n---\n# X\n## 設計の説明\nd\n## 消す節\n中身\n' } });
  if (!s) return;
  const write = async (prompt) => {
    const file = path.join(s.target.root, 'SKILL.md');
    const n = /反復の番号: (\d+)/.exec(prompt)[1];
    await fs.writeFile(file, n === '1' ? '---\nname: x\n---\n# X\n## 設計の説明\nd1\n## 消す節\n中身\n' : '---\nname: x\n---\n# X\n## 設計の説明\nd2\n');
    return { written: [{ path: file, action: 'write' }], designNote: { path: 'SKILL.md', heading: '設計の説明' } };
  };
  const verify = async (prompt, options, env, call, calls) => {
    const iteration = calls.filter((c) => c.role === 'write').length;
    if (options.label !== 'verifier:conformance' || iteration !== 1) return defaults.verify(prompt, options, env);
    const result = await defaults.verify(prompt, options, env);
    const { assets } = await env.readFromPrompt(prompt, 'report');
    const target = assets.find((a) => JSON.stringify(a.loc).includes('消す節')).id;
    const { kinds } = await env.readFromPrompt(prompt, 'kinds');
    const unit = result.units.find((u) => u.result === 'conform');
    const key = { asset: target, viewpoint: 'conformance', kind: kinds[0].value };
    result.judgements.find((j) => j.asset === target).judgement = 'candidate';
    result.candidates = [{ ...key, quote: 'L8: 中身', content: 'c', fix: 'f' }];
    unit.result = 'nonconform';
    unit.keys = [key];
    await writePayload(prompt, result);
    return result;
  };
  const { result, calls } = await runAuthor(t, { env: s.env, args: updateArgs(s.target), scenario: { write, verify } });
  assert.equal(result.stopKind, 'complete', result.reason);
  const vanish = calls.filter((c) => c.role === 'vanish');
  assert.equal(vanish.length, 1);
  assert.match(vanish[0].prompt, /指摘 ID: F/);
  const f = result.findings.find((x) => x.viewpoint === 'conformance');
  assert.equal(f.state, 'resolved');
});

test('SP-BPFINDINGS-028・SP-BPAUTHORING-022: 再開した update の結果で、前の run が最後の状態を記録した指摘に状態が載らず、記録した run と見直しの判定が載る', async (t) => {
  const s = await setup(t, { fn: 'update' });
  if (!s) return;
  const first = await runAuthor(t, { env: s.env, args: updateArgs(s.target), scenario: { verify: nonconformVerifier() } });
  assert.equal(first.result.stopKind, 'iteration_limit');
  const second = await runAuthor(t, { env: s.env, args: resumeArgs(first.result) });
  assert.equal(second.result.stopKind, 'complete', second.result.reason);
  const f = second.result.findings.find((x) => x.viewpoint === 'conformance');
  assert.equal(f.state, undefined);
  assert.equal(f.stateRun, 'r1');
  assert.equal(f.judgement, 'absent');
  const gateFinding = second.result.verification.decision;
  assert.equal(gateFinding.value, 'pass');
});
