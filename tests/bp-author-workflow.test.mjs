import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  MIN_LAUNCHES, REPO_ROOT, SKILL_DIR, VANISH_FILES, assetIds, createArgs, defaults, newKey, resumeArgs, runAuthor, setup, updateArgs, vanishScenario, variant, writePayload,
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

const MIN = MIN_LAUNCHES;

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
  assert.equal((await viewOf(s.env, first.result.state)).iterations, 0);
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
  assert.deepEqual(result.verification.iterations, { total: 1, run: 1 });
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

test('SP-BPAUTHORING-035・SP-BPRUN-015: 検証が成り立たない BLOCKED から再開すると、書き手を起動せず新しい反復の台帳の段から検証し直し、前の回の打ち切りを引き継がない', async (t) => {
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
  const s = await setup(t, { fn: 'update', files: VANISH_FILES });
  if (!s) return;
  const { result, calls } = await runAuthor(t, { env: s.env, args: updateArgs(s.target), scenario: vanishScenario(s.target.root) });
  assert.equal(result.stopKind, 'complete', result.reason);
  const vanish = calls.filter((c) => c.role === 'vanish');
  assert.equal(vanish.length, 1);
  assert.match(vanish[0].prompt, /指摘 ID: F/);
  const f = result.findings.find((x) => x.viewpoint === 'conformance');
  assert.equal(f.state, 'resolved');
  assert.equal(f.judgedOnCurrent, true);
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

// SP-BPRUN-021 の段ごとの最悪の回数の根拠: 最悪の経路を強いて、単位ごとの起動を数える。
function dropFirstDelivery(ops) {
  const seen = new Set();
  return async (prompt, options, env) => {
    const out = await env.carry(prompt);
    if (ops.some((op) => prompt.includes(` ${op} <<`)) && !seen.has(prompt)) { seen.add(prompt); return null; }
    return out;
  };
}

test('SP-BPRUN-021: 最悪の経路で、開始は 2 回、fan-out の項目は試行ごとに 5 回・計 15 回、目標の固定は 1 回あたり 2 回・計 6 回、書く段は 3 回起動し、最小の起動数ちょうどの上限で最初の検証の項目を始められる', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const bad = { goal: { deliverables: [{ text: 'x', sources: [{ kind: 'request', quote: '無い文' }] }], scope: [], prohibitions: [], numeric: [], deixis: [] } };
  let goals = 0;
  const goal = async (prompt) => ((goals += 1) < 3 ? bad : defaults.goal(prompt));
  const verify = async (prompt, options, env) => {
    if (options.label !== 'verifier:conformance') return defaults.verify(prompt, options, env);
    const out = { judgements: [{ asset: 'ANOPE', judgement: 'ok' }], candidates: [], applicability: { row: 1 }, units: [], residualRisks: [] };
    await writePayload(prompt, out);
    return out;
  };
  const scenario = () => ({ goal, verify, carrier: dropFirstDelivery(['start', 'verdicts', 'item-fail']) });
  const { result, calls } = await runAuthor(t, { env: s.env, args: createArgs(s.target, { maxLaunches: MIN.create }), maxAgents: MIN.create, scenario: scenario() });
  assert.ok(calls.some((c) => c.label === 'verifier:conformance'));
  assert.ok(result.launches <= MIN.create);
  const s2 = await setup(t);
  goals = 0;
  const full = await runAuthor(t, { env: s2.env, args: createArgs(s2.target), scenario: scenario() });
  assert.equal(full.result.stopKind, 'blocked');
  assert.equal(full.result.verification.decision.unverifiable.aborted.length, 1);
  assert.deepEqual(full.result.verification.units, []);
  assert.equal(full.calls.filter((c) => c.prompt.includes(' start <<')).length, 2);
  const view = await viewOf(s2.env, full.result.state);
  const conf = view.stages.get('verify|1').items.find((id) => view.items.get(id).key.viewpoint === 'conformance');
  assert.equal(full.calls.filter((c) => c.label !== 'carrier' && c.prompt.includes(conf)).length, 15);
  const goalCalls = full.calls.filter((c) => c.role === 'goal' || c.prompt.includes(' goal-check <<'));
  assert.equal(goalCalls.length, 6);
  const w = full.calls.findIndex((c) => c.role === 'write');
  const v = full.calls.findIndex((c) => c.role === 'verify');
  assert.equal(v - w, 3);
});

test('SP-BPRUN-028・SP-BPRUN-031: 結果を書く運搬役が応答を失うと同じ要求を 1 回送り直し、送り直しの E_RESULT・E_TRANSPORT・E_LOCK は試行の失敗として数えて BLOCKED にしない', async (t) => {
  const { sum } = await import('../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/ids.mjs');
  const lost = await setup(t);
  if (!lost) return;
  let droppedItem = null;
  const carrier = async (prompt, options, env) => {
    const out = await env.carry(prompt);
    if (!droppedItem && prompt.includes(' verdicts <<')) { droppedItem = /"item":"([^"]+)"/.exec(prompt)[1]; return null; }
    return out;
  };
  const resent = await runAuthor(t, { env: lost.env, args: createArgs(lost.target), scenario: { carrier } });
  assert.equal(resent.result.stopKind, 'complete', resent.result.reason);
  assert.equal(resent.calls.filter((c) => c.label !== 'carrier' && c.prompt.includes(droppedItem)).length, 3);
  for (const code of ['E_RESULT', 'E_TRANSPORT', 'E_LOCK']) {
    const s = await setup(t);
    let n = 0;
    const carrier2 = async (prompt, options, env) => {
      if (prompt.includes(' verdicts <<') && prompt.includes('"viewpoint":"goal"') && n < 2) {
        n += 1;
        if (n === 1) return null;
        const body = { ok: false, code, reason: '送り直しへの拒否' };
        return { responses: [JSON.stringify({ ...body, sum: sum(body) })] };
      }
      return env.carry(prompt);
    };
    const { result } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { carrier: carrier2 } });
    assert.equal(result.stopKind, 'complete', `${code}: ${result.reason}`);
    const view = await viewOf(s.env, result.state);
    assert.equal(view.stages.get('verify|1').items.map((id) => view.items.get(id)).find((i) => i.key.viewpoint === 'goal').fails.length, 1, code);
  }
});

// §5.9 の教訓 5: 返り値の鍵の集合を、仕様の表の「返すとき」の列から機械的に照らす。
function returnRules() {
  const read = (file) => readFileSync(path.join(REPO_ROOT, 'docs', 'specifications', file), 'utf8');
  const table = (text, header) => {
    const lines = text.slice(text.indexOf(header)).split('\n');
    return lines.slice(2).filter((_, i, all) => all.slice(0, i + 1).every((l) => l.startsWith('|'))).map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  };
  const keys = (cell) => [...cell.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]);
  const common = table(read('bp-run.md'), '| 項目 | 綴り | 返すとき |').map(([, spell, when]) => ({ keys: keys(spell), when }));
  const complete = table(read('bp-authoring.md'), '| 条件: 機能 | 条件: 項目 | 綴り | 結果 |').map(([fn, , spell, body]) => ({ keys: keys(spell), when: `完了:${fn}:${body}` }));
  const stopped = table(read('bp-authoring.md'), '| 項目 | 綴り | 中身 |').map(([, spell, body]) => ({ keys: keys(spell), when: `完了以外:${body}` }));
  return [...common, ...complete, ...stopped];
}

function expectation(rule, ctx) {
  const w = rule.when;
  if (w === '常に') return true;
  if (w === '完了以外') return !ctx.complete;
  if (w.startsWith('完了以外。状態を作らずに')) return !ctx.complete && ctx.state;
  if (w === '状態が書かれたとき') return ctx.state;
  if (w.startsWith('create・update で、1 つ以上書いた')) return ctx.written;
  if (w.startsWith('SP-BPRUN-025 に当たるとき')) return ctx.state;
  if (w.startsWith('完了:')) {
    const [, fn, body] = w.split(':');
    if (!ctx.complete || (fn !== '*' && fn !== ctx.fn)) return 'absentOrOther';
    if (body.startsWith('載せない')) return 'absentOrOther';
    if (body.startsWith('最後の取り直しで')) return 'maybe';
    return true;
  }
  if (w.startsWith('完了以外:')) {
    const body = w.slice('完了以外:'.length);
    if (ctx.complete || !ctx.state) return 'absentOrOther';
    if (body.startsWith('合否を書いた反復が 1 回以上あるとき')) return ctx.gated;
    if (body.startsWith('最後の取り直しで')) return 'maybe';
    return true;
  }
  throw new Error(`返すときの列を読めない: ${w}`);
}

function checkShape(result, ctx) {
  const rules = returnRules();
  const allowed = new Set(['ok', 'op', 'sum', ...rules.flatMap((r) => r.keys)]);
  for (const key of Object.keys(result)) assert.ok(allowed.has(key), `表に無い返り値の鍵: ${key}`);
  const want = new Map();
  for (const rule of rules) {
    const e = expectation(rule, ctx);
    for (const key of rule.keys) {
      if (e === true) want.set(key, true);
      else if (e === false && !want.has(key)) want.set(key, false);
    }
  }
  for (const [key, present] of want) assert.equal(Object.hasOwn(result, key), present, `${ctx.label}: ${key}`);
}

test('SP-BPRUN-032・SP-BPAUTHORING-033・SP-BPAUTHORING-034・SP-BPAUTHORING-028: 停止の種類ごとの返り値の鍵が、仕様の表の「返すとき」の列のとおりである', async (t) => {
  const runs = [];
  const add = async (label, fn, args, scenario = {}, ctx = {}) => {
    const s = await setup(t, { fn });
    if (!s) return;
    const { result } = await runAuthor(t, { env: s.env, args: args(s.target), scenario });
    runs.push({ result, ctx: { label, fn, complete: result.stopKind === 'complete', state: Boolean(result.state && result.run), ...ctx } });
  };
  await add('create の完了', 'create', createArgs, {}, { written: true });
  await add('update の完了', 'update', updateArgs, {}, { written: true });
  await add('反復の上限', 'create', createArgs, { verify: nonconformVerifier() }, { written: true, gated: true });
  await add('needs_input', 'create', createArgs, { goal: async () => ({ missing: [{ question: 'q', reason: 'r' }] }) }, { written: false, gated: false });
  await add('書く段の BLOCKED', 'create', createArgs, { write: async () => null }, { written: false, gated: false });
  await add('状態を作らない停止', 'create', (target) => createArgs(target, { request: '' }), {}, { written: false, gated: false });
  for (const { result, ctx } of runs) checkShape(result, ctx);
  assert.equal(runs.length, 6);
});

test('SP-BPAUTHORING-015: update で一覧の外のパスを返す書き手で BLOCKED になる', async (t) => {
  const s = await setup(t, { fn: 'update' });
  if (!s) return;
  const outside = path.join(s.base, 'elsewhere.md');
  const write = async () => {
    await fs.writeFile(outside, 'x');
    return { written: [{ path: outside, action: 'write' }], designNote: { path: 'SKILL.md' } };
  };
  const { result } = await runAuthor(t, { env: s.env, args: updateArgs(s.target), scenario: { write } });
  assert.equal(result.stopKind, 'blocked');
  assert.deepEqual(result.unverified, [{ path: outside, outside: true }]);
});

test('SP-BPAUTHORING-035・SP-BPAUTHORING-004: 作り直す前の写しの段で BLOCKED になった update を再開すると、記録のある写しを作り直さない', async (t) => {
  const s = await setup(t, { fn: 'update' });
  if (!s) return;
  let dropped = false;
  const carrier = async (prompt, options, env) => {
    const out = await env.carry(prompt);
    if (!dropped && prompt.includes(' snapshot <<')) { dropped = true; return null; }
    return out;
  };
  const first = await runAuthor(t, { env: s.env, args: updateArgs(s.target), scenario: { carrier } });
  assert.equal(first.result.stopKind, 'blocked');
  assert.equal(first.result.stoppedStage, '作り直す前の写し');
  await fs.writeFile(path.join(s.target.root, 'SKILL.md'), '---\nname: x\n---\n# 再開の前に変えた\n');
  const second = await runAuthor(t, { env: s.env, args: resumeArgs(first.result) });
  assert.equal(second.result.stopKind, 'complete', second.result.reason);
  const lines = await logOf(s.env, first.result.state);
  assert.equal(lines.filter((l) => l.records.some((r) => r.t === 'snapshot')).length, 1);
  const goal = second.calls.find((c) => c.role === 'goal');
  assert.ok(goal);
});

test('SP-BPRUN-018: 段の開始の記録が 1 つも無い状態から再開すると、機能の最初の段から始める', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const carrier = async (prompt, options, env) => (prompt.includes(' stage-start <<') || prompt.includes(' stop <<') ? null : env.carry(prompt));
  const first = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { carrier } });
  assert.equal(first.result.stopKind, 'blocked');
  const view = await viewOf(s.env, first.result.state);
  assert.equal(view.stages.size, 0);
  const second = await runAuthor(t, { env: s.env, args: resumeArgs(first.result) });
  assert.equal(second.result.stopKind, 'complete', second.result.reason);
  assert.equal(second.calls.filter((c) => c.role === 'goal').length, 1);
});

test('SP-BPRUN-029: 状態の構造を指す ID の誤りとして CLI が書き込みを拒否すると、BLOCKED で止まる', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { sum } = await import('../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/ids.mjs');
  const carrier = async (prompt, options, env) => {
    if (!prompt.includes(' verdicts <<')) return env.carry(prompt);
    const body = { ok: false, code: 'E_UNKNOWN_ID', reason: '状態に無い項目の ID' };
    return { responses: [JSON.stringify({ ...body, sum: sum(body) })] };
  };
  const { result } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { carrier } });
  assert.equal(result.stopKind, 'blocked');
  assert.match(result.reason, /段「検証」の CLI が結果の書き込みを拒否した: verdicts: E_UNKNOWN_ID/);
});

test('§5.9 の教訓 3: 検証の段の並行の運搬役を子 process の CLI で走らせても、記録が欠けず E_LOCK が出ない', async (t) => {
  const s = await setup(t, { fn: 'update' });
  if (!s) return;
  const { spawn } = await import('node:child_process');
  const { commands } = await import('./helpers/bp-harness.mjs');
  // 判定基準の写しは 4 段目まで本番の置き場に無いので、子 process でも写しの場所を渡せる入口で CLI の main を呼ぶ。
  const wrapper = path.join(s.base, 'cli-wrapper.mjs');
  await fs.writeFile(wrapper, [
    `import { main } from ${JSON.stringify(path.join(SKILL_DIR, 'scripts', 'bp-state.mjs'))};`,
    'const chunks = []; for await (const c of process.stdin) chunks.push(c);',
    `const { exitCode, output } = await main(process.argv.slice(2), Buffer.concat(chunks).toString('utf8'), { criteriaDir: ${JSON.stringify(s.env.criteriaDir)} });`,
    "process.stdout.write(`${JSON.stringify(output)}\\n`); process.exitCode = exitCode;",
  ].join('\n'));
  const viaProcess = (c) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper, c.op], { env: { ...process.env, BP_STATE_ROOT: s.env.root }, cwd: REPO_ROOT });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', () => resolve(out.trim()));
    child.stdin.end(c.text);
  });
  const codes = [];
  const carrier = async (prompt, options, env) => {
    if (!options.label.startsWith('carrier:verify')) return env.carry(prompt);
    const responses = [];
    for (const c of commands(prompt)) {
      const line = await viaProcess(c);
      responses.push(line);
      const parsed = JSON.parse(line);
      codes.push(parsed.code ?? 'ok');
      if (!parsed.ok) break;
    }
    return { responses };
  };
  const verify = async (prompt, options, env) => {
    await new Promise((r) => setTimeout(r, 20));
    return defaults.verify(prompt, options, env);
  };
  const { result } = await runAuthor(t, { env: s.env, args: updateArgs(s.target), scenario: { carrier, verify } });
  assert.ok(codes.length >= 3);
  assert.ok(!codes.includes('E_LOCK'));
  assert.ok(!codes.includes('E_INPUT'), codes.join(','));
  assert.equal(result.stopKind, 'complete', result.reason);
});

test('SP-BPRUN-020・SP-BPRUN-031: 運搬役がまとめた要求の途中まで実行して応答を失っても、停止の記録は CLI が状態から導いた未着手の項目で書かれる', async (t) => {
  const { commands } = await import('./helpers/bp-harness.mjs');
  const s = await setup(t);
  if (!s) return;
  let once = false;
  const carrier = async (prompt, options, env) => {
    if (!once && prompt.includes(' gate <<')) {
      once = true;
      for (const c of commands(prompt)) { if (c.op === 'gate') break; await env.call(c.op, c.text); }
      return null;
    }
    return env.carry(prompt);
  };
  const first = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { carrier } });
  assert.equal(first.result.stopKind, 'blocked');
  assert.doesNotMatch(first.result.reason, /停止の記録を書けなかった/);
  const view = await viewOf(s.env, first.result.state);
  assert.deepEqual(view.stops.get('r1').pending, view.stages.get('gate|1').items);
  const second = await runAuthor(t, { env: s.env, args: resumeArgs(first.result) });
  assert.equal(second.result.stopKind, 'complete', second.result.reason);
  const s2 = await setup(t);
  let dropped = false;
  const carrier2 = async (prompt, options, env) => {
    if (!dropped && prompt.includes(' ledger-create <<')) {
      dropped = true;
      for (const c of commands(prompt)) await env.call(c.op, c.text);
      return null;
    }
    return env.carry(prompt);
  };
  const blocked = await runAuthor(t, { env: s2.env, args: createArgs(s2.target), scenario: { carrier: carrier2 } });
  assert.equal(blocked.result.stopKind, 'blocked');
  const v2 = await viewOf(s2.env, blocked.result.state);
  assert.deepEqual(v2.stops.get('r1').pending, v2.stages.get('verify|1').items);
});

test('SP-BPAUTHORING-013・SP-BPAUTHORING-033: 設計の説明のパスが根の外か無いファイルを指す書き手の結果を拒否し、外のファイルを返り値に写さない', async (t) => {
  for (const [bad, pattern] of [['../../../../../../../../../../etc/hosts', /根の外を指す/], ['/etc/hosts', /相対パスでなければならない/], ['none.md', /ファイルが無い/]]) {
    const s = await setup(t);
    if (!s) return;
    const write = async (prompt) => ({ ...(await defaults.write(prompt)), designNote: { path: bad } });
    const { result } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { write } });
    assert.equal(result.stopKind, 'blocked', bad);
    assert.match(result.reason, pattern);
    assert.equal(result.designNote, undefined);
    assert.deepEqual(result.writtenFiles, [{ path: 'SKILL.md', action: 'write', verified: false }]);
    assert.deepEqual(result.unverified, [{ path: 'SKILL.md', action: 'write' }]);
    const view = await viewOf(s.env, result.state);
    assert.equal(view.rejected.length, 1);
  }
});

test('SP-BPAUTHORING-035・SP-BPRUN-018: 停止の記録が無いまま目標の固定か作り直す前の写しで止まった run の再開は、目標の固定と新しい反復の書く段へ進む', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const noStop = async (prompt, options, env) => (prompt.includes(' stop <<') ? null : env.carry(prompt));
  const first = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { goal: async () => null, carrier: noStop } });
  assert.match(first.result.reason, /停止の記録を書けなかった/);
  const second = await runAuthor(t, { env: s.env, args: resumeArgs(first.result) });
  assert.equal(second.result.stopKind, 'complete', second.result.reason);
  assert.equal(second.calls.filter((c) => c.role === 'goal').length, 1);
  const view = await viewOf(s.env, first.result.state);
  assert.ok(view.stages.has('goal|1') && !view.stages.has('goal|2') && view.stages.has('write|1'));
  const u = await setup(t, { fn: 'update' });
  let drop = true;
  const snap = async (prompt, options, env) => {
    if (prompt.includes(' stop <<')) return null;
    const out = await env.carry(prompt);
    if (drop && prompt.includes(' snapshot <<')) { drop = false; return null; }
    return out;
  };
  const b1 = await runAuthor(t, { env: u.env, args: updateArgs(u.target), scenario: { carrier: snap } });
  const b2 = await runAuthor(t, { env: u.env, args: resumeArgs(b1.result) });
  assert.equal(b2.result.stopKind, 'complete', b2.result.reason);
  assert.ok((await viewOf(u.env, b1.result.state)).stages.has('goal|1'));
});

test('SP-BPRUN-035・SP-BPAUTHORING-035: 追加の検証の段で止まった run の再開は、前の部分の未着手を破棄し、skip 一覧から次の部分を作り直して段を終える', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const empty = async (prompt, options, env) => {
    if (options.label !== 'verifier:goal') return options.label === 'verifier:goal:extra' ? null : defaults.verify(prompt, options, env);
    const out = { judgements: [], candidates: [], basisConstraints: [] };
    await writePayload(prompt, out);
    return out;
  };
  const crash = async (prompt, options, env) => (prompt.includes(' item-fail <<') || prompt.includes(' stop <<') ? null : env.carry(prompt));
  const first = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { verify: empty, carrier: crash } });
  assert.match(first.result.reason, /停止の記録を書けなかった/);
  const before = await viewOf(s.env, first.result.state);
  const old = before.stages.get('verify-extra|1').items;
  const second = await runAuthor(t, { env: s.env, args: resumeArgs(first.result) });
  assert.equal(second.result.stopKind, 'complete', second.result.reason);
  const view = await viewOf(s.env, first.result.state);
  assert.ok(old.every((id) => view.items.get(id).discarded));
  assert.equal(view.stages.get('verify-extra|1').parts, 2);
  assert.ok(view.stages.get('verify-extra|1').ended);
});

test('SP-BPAUTHORING-005・SP-BPAUTHORING-035: 検証役・反証役によらない BLOCKED（運搬役の失敗）で台帳〜合否に止まった run の再開は、書かずに検証し直す例外に当たらず、書く段から始める', async (t) => {
  const s = await setup(t, { fn: 'update' });
  if (!s) return;
  let drop = true;
  const carrier = async (prompt, options, env) => {
    if (drop && prompt.includes(' review-judge <<')) { drop = false; return null; }
    return env.carry(prompt);
  };
  const first = await runAuthor(t, { env: s.env, args: updateArgs(s.target), scenario: { carrier } });
  assert.equal(first.result.stopKind, 'blocked');
  assert.match(first.result.reason, /段「見直し」の運搬役/);
  const second = await runAuthor(t, { env: s.env, args: resumeArgs(first.result) });
  assert.equal(second.result.stopKind, 'complete', second.result.reason);
  assert.equal(second.calls.filter((c) => c.role === 'write').length, 1);
  assert.ok((await viewOf(s.env, first.result.state)).stages.has('write|2'));
});

test('SP-BPRUN-035・SP-BPFINDINGS-025: 追加の検証の部分を終えた後に止まった run の再開で skip 一覧が空なら、次の部分を作らずに追加の検証の段を終える', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const verify = async (prompt, options, env) => {
    if (options.label !== 'verifier:goal') return defaults.verify(prompt, options, env);
    const out = { judgements: [], candidates: [], basisConstraints: [] };
    await writePayload(prompt, out);
    return out;
  };
  let extraRan = false;
  const crash = async (prompt, options, env) => {
    if (prompt.includes(' stop <<')) return null;
    if (extraRan && prompt.includes(' report <<') && prompt.includes('"fields":["skip"]')) return null;
    if (options.label === 'carrier:verify-extra') extraRan = true;
    return env.carry(prompt);
  };
  const first = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { verify, carrier: crash } });
  assert.match(first.result.reason, /停止の記録を書けなかった/);
  const second = await runAuthor(t, { env: s.env, args: resumeArgs(first.result) });
  assert.equal(second.result.stopKind, 'complete', second.result.reason);
  assert.equal(second.calls.filter((c) => c.label.endsWith(':extra')).length, 0);
  const view = await viewOf(s.env, first.result.state);
  assert.ok(view.stages.get('verify-extra|1').ended);
  assert.equal(view.stages.get('verify-extra|1').parts, 1);
});

test('SP-BPRUN-028: 1 回目の結果の書き込みを CLI が書いた後に応答を失い、送り直しが E_LOCK・E_TRANSPORT を返しても、結果のある項目として扱い BLOCKED にしない', async (t) => {
  const { sum } = await import('../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/ids.mjs');
  for (const code of ['E_LOCK', 'E_TRANSPORT']) {
    const s = await setup(t);
    if (!s) return;
    let n = 0;
    const carrier = async (prompt, options, env) => {
      if (prompt.includes(' verdicts <<') && prompt.includes('"viewpoint":"goal"') && n < 2) {
        n += 1;
        if (n === 1) { await env.carry(prompt); return null; }
        const body = { ok: false, code, reason: '送り直しへの拒否' };
        return { responses: [JSON.stringify({ ...body, sum: sum(body) })] };
      }
      return env.carry(prompt);
    };
    const { result, calls } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { carrier } });
    assert.equal(result.stopKind, 'complete', `${code}: ${result.reason}`);
    const view = await viewOf(s.env, result.state);
    const goal = view.stages.get('verify|1').items.map((id) => view.items.get(id)).find((i) => i.key.viewpoint === 'goal');
    assert.equal(goal.fails.length, 0, code);
    assert.ok(goal.result);
    assert.equal(calls.filter((c) => c.label === 'verifier:goal').length, 1);
  }
});

test('SP-BPAUTHORING-005・SP-BPAUTHORING-035: 検証役による BLOCKED から台帳の段で再開した run が運搬役の失敗で止まると、次の再開は書く段から始める', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const r1 = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { verify: async () => null } });
  assert.equal(r1.result.stopKind, 'blocked');
  let drop = true;
  const carrier = async (prompt, o, env) => {
    if (drop && (prompt.includes(' ledger-retake <<') || prompt.includes(' ledger-create <<'))) { drop = false; return null; }
    return env.carry(prompt);
  };
  const r2 = await runAuthor(t, { env: s.env, args: resumeArgs(r1.result), scenario: { carrier } });
  assert.equal(r2.result.stopKind, 'blocked');
  assert.equal(r2.calls.filter((c) => c.role === 'write').length, 0);
  const r3 = await runAuthor(t, { env: s.env, args: resumeArgs(r2.result) });
  assert.equal(r3.result.stopKind, 'complete', r3.result.reason);
  assert.equal(r3.calls.filter((c) => c.role === 'write').length, 1);
  const view = await viewOf(s.env, r1.result.state);
  assert.deepEqual([...view.stops.values()].map((x) => x.cause ?? null), ['verifiers', null, null]);
});

test('SP-BPAUTHORING-013・SP-BPAUTHORING-035: 全てのファイルを消す update は書く段で BLOCKED になり、再開は書く段から始める', async (t) => {
  const s = await setup(t, { fn: 'update' });
  if (!s) return;
  const file = path.join(s.target.root, 'SKILL.md');
  const wipe = async () => {
    await fs.rm(file);
    return { written: [{ path: file, action: 'delete' }], designNote: { path: 'SKILL.md' } };
  };
  const first = await runAuthor(t, { env: s.env, args: updateArgs(s.target), scenario: { write: wipe } });
  assert.equal(first.result.stopKind, 'blocked');
  assert.equal(first.result.stoppedStage, '書く');
  assert.deepEqual(first.result.unverified, [{ path: 'SKILL.md', action: 'delete' }]);
  const second = await runAuthor(t, { env: s.env, args: resumeArgs(first.result) });
  assert.equal(second.result.stopKind, 'complete', second.result.reason);
  assert.equal(second.calls.filter((c) => c.role === 'write').length, 1);
});

test('SP-BPRUN-021: 再開した run も、最小の起動数ちょうどの上限で、破棄の運搬役と目標の固定の最悪の後に最初の検証の項目を始められる', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const r1 = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { goal: async () => null } });
  assert.equal(r1.result.stopKind, 'blocked');
  const bad = { goal: { deliverables: [{ text: 'x', sources: [{ kind: 'request', quote: '無い文' }] }], scope: [], prohibitions: [], numeric: [], deixis: [] } };
  let g = 0;
  const goal = async (prompt) => (++g < 3 ? bad : defaults.goal(prompt));
  const verify = async (prompt, options, env) => (options.label === 'verifier:conformance' ? null : defaults.verify(prompt, options, env));
  const r2 = await runAuthor(t, { env: s.env, args: resumeArgs(r1.result, { maxLaunches: MIN.create }), maxAgents: MIN.create, scenario: { goal, verify, carrier: dropFirstDelivery(['start']) } });
  assert.ok(r2.calls.some((c) => c.label === 'verifier:conformance'), r2.result.reason);
  assert.ok(r2.calls.some((c) => c.prompt.includes(' discard <<')));
  assert.ok(r2.result.launches <= MIN.create);
});

test('SP-BPRUN-021・SP-BPRUN-022: 再開の開始で消えた資産が見つかる run は、上限がちょうど最小でも最初の fan-out の項目（消えた資産の照合）を始め、次の再開で検証の段へ進む', async (t) => {
  const { sum } = await import('../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/ids.mjs');
  const s = await setup(t, { fn: 'update', files: VANISH_FILES });
  if (!s) return;
  const sc = vanishScenario(s.target.root);
  const write = async (prompt, o, env) => { const r = await sc.write(prompt, o, env); return /反復の番号: 2/.test(prompt) ? null : r; };
  const r1 = await runAuthor(t, { env: s.env, args: updateArgs(s.target), scenario: { ...sc, write } });
  assert.equal(r1.result.stopKind, 'blocked');
  let n = 0;
  const carrier = async (prompt, o, env) => {
    if (prompt.includes(' vanish-match <<') && n < 4) {
      n += 1;
      if (n % 2 === 1) return null;
      const b = { ok: false, code: 'E_LOCK', reason: 'l' };
      return { responses: [JSON.stringify({ ...b, sum: sum(b) })] };
    }
    return env.carry(prompt);
  };
  const r2 = await runAuthor(t, { env: s.env, args: resumeArgs(r1.result, { maxLaunches: MIN.update }), maxAgents: MIN.update, scenario: { write: sc.write, carrier } });
  assert.ok(r2.calls.some((c) => c.label === 'verifier:vanish'));
  assert.ok(r2.result.launches <= MIN.update);
  assert.equal(r2.result.stopKind, 'iteration_limit', r2.result.reason);
  const r3 = await runAuthor(t, { env: s.env, args: resumeArgs(r2.result, { maxLaunches: MIN.update }), maxAgents: MIN.update, scenario: { write: sc.write } });
  assert.ok(r3.calls.some((c) => c.label === 'verifier:conformance'), r3.result.reason);
});

test('SP-BPAUTHORING-031・SP-BPAUTHORING-013: 設計の説明の拒否と一覧の外のパスが重なっても、理由に一覧の外のパスを全て書く', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const outside = path.join(s.base, 'outside.md');
  const write = async (prompt) => {
    const r = await defaults.write(prompt);
    await fs.writeFile(outside, 'x');
    return { ...r, designNote: { path: 'nope.md' }, written: [...r.written, { path: outside, action: 'write' }] };
  };
  const { result } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { write } });
  assert.equal(result.stopKind, 'blocked');
  assert.match(result.reason, /設計の説明のファイルが無い/);
  assert.ok(result.reason.includes(outside), result.reason);
  assert.deepEqual(result.unverified, [{ path: 'SKILL.md', action: 'write' }, { path: outside, outside: true }]);
});
