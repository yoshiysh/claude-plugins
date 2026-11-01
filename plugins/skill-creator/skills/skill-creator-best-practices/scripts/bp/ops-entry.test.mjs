import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as run from './ops-run.mjs';
import { FINDING_REQUIRED, chainCheck, chainNext, chainReport, launchArgs, missingFields, modelNames, RUNNER_REQUEST } from './ops-entry.mjs';
import { CODES, CRITERIA_DIR, FUNCTIONS, INPUT_KEYS, LAUNCH_KINDS, ROUTES, STOP_KINDS, WORKFLOW_SOURCES } from './constants.mjs';
import { conformanceValue } from './kinds.mjs';
import { LIMITS, SKILL_DIR, context, newKey, skillDir } from './fixtures/harness.mjs';

const CRITERIA = path.join(SKILL_DIR, CRITERIA_DIR);

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.reason);
    return true;
  });
}

function entryCtx(t) {
  return context(t, { criteriaDir: CRITERIA, skillDir: SKILL_DIR });
}

const ROOT = '/x/skill';
const NEW_INPUT = {
  create: { function: 'create', request: '依頼文', target: { root: '/x/.agents/skills/made' } },
  review: { function: 'review', target: { root: ROOT, files: [] } },
  audit: { function: 'audit', target: { root: ROOT, files: [] } },
  update: { function: 'update', target: { root: ROOT, files: [] }, grounds: [{ from: 'bp-1' }] },
};
const RESUME_INPUT = { nextArgs: { function: 'update', state: 'bp-1' } };

test('SP-BPENTRY-019: chain-check は create を先頭以外に置く列を組めないと理由つきで答え、先頭の create と create の無い列は組める', async () => {
  for (const fns of [['create'], ['create', 'review', 'update'], ['review', 'update', 'review'], ['audit']]) {
    assert.deepEqual(await chainCheck({}, { functions: fns }), { functions: fns, buildable: true });
  }
  for (const fns of [['review', 'create'], ['create', 'update', 'create']]) {
    const out = await chainCheck({}, { functions: fns });
    assert.equal(out.buildable, false);
    assert.match(out.reason, /SP-BPENTRY-019/);
    assert.match(out.reason, /前の機能の結果を渡す形が無い/);
  }
  await rejects(chainCheck({}, { functions: [] }), CODES.input);
  await rejects(chainCheck({}, { functions: ['publish'] }), CODES.input);
});

test('SP-BPENTRY-013: launch-args は起動の種類 × 項目の表のとおりの args を作り、表で渡さない項目を持つ入力を拒否する', async () => {
  const ctx = { skillDir: SKILL_DIR, criteriaDir: CRITERIA };
  for (const fn of FUNCTIONS) {
    const out = await launchArgs(ctx, { route: ROUTES.native, launch: LAUNCH_KINDS.new, key: 'k1', input: NEW_INPUT[fn] });
    assert.deepEqual(out.args, { ...NEW_INPUT[fn], skillDir: SKILL_DIR, key: 'k1', host: ROUTES.native });
    assert.equal(out.source, fn === 'create' || fn === 'update' ? WORKFLOW_SOURCES.author : WORKFLOW_SOURCES.inspect);
    const missing = Object.keys(NEW_INPUT[fn]).filter((k) => k !== 'function');
    for (const k of missing) {
      const { [k]: _, ...rest } = NEW_INPUT[fn];
      await rejects(launchArgs(ctx, { route: ROUTES.native, launch: LAUNCH_KINDS.new, key: 'k1', input: rest }), CODES.input);
    }
    const forbidden = [INPUT_KEYS.nextArgs, INPUT_KEYS.answer, ...(fn === 'create' ? [INPUT_KEYS.grounds] : [INPUT_KEYS.request]), ...(fn === 'update' ? [] : [INPUT_KEYS.grounds])];
    for (const k of new Set(forbidden.filter((x) => !Object.hasOwn(NEW_INPUT[fn], x)))) {
      await rejects(launchArgs(ctx, { route: ROUTES.native, launch: LAUNCH_KINDS.new, key: 'k1', input: { ...NEW_INPUT[fn], [k]: 'x' } }), CODES.input);
    }
  }
  const resumed = await launchArgs(ctx, { route: ROUTES.native, launch: LAUNCH_KINDS.resume, key: 'k2', input: { ...RESUME_INPUT, answer: '回答' } });
  assert.deepEqual(resumed.args, { ...RESUME_INPUT, answer: '回答', skillDir: SKILL_DIR, key: 'k2', host: ROUTES.native });
  assert.equal(resumed.source, WORKFLOW_SOURCES.author);
  for (const k of [INPUT_KEYS.function, INPUT_KEYS.request, INPUT_KEYS.target, INPUT_KEYS.grounds, INPUT_KEYS.maxLaunches, INPUT_KEYS.skillDir]) {
    await rejects(launchArgs(ctx, { route: ROUTES.native, launch: LAUNCH_KINDS.resume, key: 'k2', input: { ...RESUME_INPUT, [k]: 'x' } }), CODES.input);
  }
  await rejects(launchArgs(ctx, { route: ROUTES.native, launch: LAUNCH_KINDS.resume, key: 'k2', input: {} }), CODES.input);
  await rejects(launchArgs(ctx, { route: 'other', launch: LAUNCH_KINDS.new, key: 'k', input: NEW_INPUT.review }), CODES.input);
  await rejects(launchArgs(ctx, { route: ROUTES.native, launch: LAUNCH_KINDS.new, input: NEW_INPUT.review }), CODES.input);
});

test('SP-BPENTRY-013・SP-BPENTRY-016: launch-args が Codex runner の経路で出す request の limits.concurrency が 3 で、どちらの経路でも args が route と同じ値の host を持ち、入力の host を拒否する', async () => {
  const ctx = { skillDir: SKILL_DIR, criteriaDir: CRITERIA };
  for (const route of Object.values(ROUTES)) {
    for (const [launch, input] of [[LAUNCH_KINDS.new, NEW_INPUT.review], [LAUNCH_KINDS.resume, RESUME_INPUT]]) {
      const out = await launchArgs(ctx, { route, launch, key: 'k', input });
      assert.equal(out.args.host, route);
      if (route === ROUTES.codex) assert.equal(out.request.limits.concurrency, 3);
      await rejects(launchArgs(ctx, { route, launch, key: 'k', input: { ...input, host: route } }), CODES.input);
    }
  }
});

test('SP-BPENTRY-015・SP-BPENTRY-016: launch-args は native の起動に上限と request を付けず、codex の起動には新規・再開とも limits.maxAgents と同じ上限と、limits・modelMap の全ての鍵・書き込みのできる mode・requirements を持つ request を付ける', async () => {
  const ctx = { skillDir: SKILL_DIR, criteriaDir: CRITERIA };
  const models = modelNames(CRITERIA);
  assert.deepEqual([...models].sort(), ['haiku', 'opus', 'sonnet']);
  for (const [launch, input] of [[LAUNCH_KINDS.new, NEW_INPUT.update], [LAUNCH_KINDS.resume, RESUME_INPUT]]) {
    const native = await launchArgs(ctx, { route: ROUTES.native, launch, key: 'k', input });
    assert.ok(!Object.hasOwn(native.args, INPUT_KEYS.maxLaunches));
    assert.ok(!Object.hasOwn(native, 'request'));
    const codex = await launchArgs(ctx, { route: ROUTES.codex, launch, key: 'k', input });
    assert.equal(codex.args.maxLaunches, codex.request.limits.maxAgents);
    assert.equal(codex.request.limits.maxAgents, RUNNER_REQUEST.maxAgents);
    assert.ok(Number.isInteger(codex.request.limits.timeoutMs) && codex.request.limits.timeoutMs > 60_000);
    assert.equal(codex.request.limits.concurrency, conformanceValue(CRITERIA, 'SP-BPCONFORMANCE-027', '体'));
    assert.deepEqual(Object.keys(codex.request.modelMap).sort(), [...models].sort());
    assert.deepEqual(codex.request.workspace, { mode: 'workspace-write' });
    assert.deepEqual(codex.request.requirements, ['workspace-write']);
  }
});

test('SP-BPENTRY-007・SP-BPENTRY-008: chain-next は止まっていない前の run と完了以外で止まった前の run で次へ進まず、create を次に置く要求を拒否する', async (t) => {
  const ctx = entryCtx(t);
  if (!ctx) return;
  const root = await skillDir(t);
  const started = await run.start(ctx, { host: 'native', key: newKey(), function: 'review', target: { root }, limits: LIMITS });
  const running = await chainNext(ctx, { state: started.state, next: 'update' });
  assert.equal(running.proceed, false);
  assert.equal(running.stopKind, null);
  assert.match(running.reason, /SP-BPENTRY-007/);
  await run.stop(ctx, { state: started.state, run: started.run, kind: STOP_KINDS.blocked, reason: '止めた', launches: 3 });
  const blocked = await chainNext(ctx, { state: started.state, next: 'update' });
  assert.equal(blocked.proceed, false);
  assert.equal(blocked.stopKind, STOP_KINDS.blocked);
  assert.ok(!Object.hasOwn(blocked, 'input'));
  await rejects(chainNext(ctx, { state: started.state, next: 'create' }), CODES.input);
  await rejects(chainNext(ctx, { state: started.state, next: 'update', instructions: [''] }), CODES.input);
});

test('SP-BPFINDINGS-031・SP-BPAUTHORING-029: 開始の操作は、完了で止まっていない状態・review と audit でない状態・別の対象スキルの状態を指す参照の形の修正の根拠を拒否する', async (t) => {
  const ctx = entryCtx(t);
  if (!ctx) return;
  const root = await skillDir(t);
  const review = await run.start(ctx, { host: 'native', key: newKey(), function: 'review', target: { root }, limits: LIMITS });
  const update = (grounds, r = root) => run.start(ctx, { host: 'native', key: newKey(), function: 'update', target: { root: r }, limits: LIMITS, grounds });
  await rejects(update([{ from: review.state }]), CODES.input);
  await run.stop(ctx, { state: review.state, run: review.run, kind: STOP_KINDS.blocked, reason: '止めた', launches: 3 });
  await rejects(update([{ from: review.state }]), CODES.input);
  const prior = await update([{ kind: '利用者の指示', text: 'a' }]);
  await rejects(update([{ from: prior.state }]), CODES.input);
  await rejects(update([{ from: review.state }], await skillDir(t)), CODES.input);
  await rejects(update([{ from: review.state, state: 'open' }]), CODES.input);
  await rejects(update([{ from: 'bp-00000000000000-nothere0' }]), CODES.unknownId);
});

test('SP-BPENTRY-021: chain-report は状態を作らずに止まった run に next_args の代わりに新しく起動することを添え、未実行の機能を列の順に載せ、機能の列と食い違う run を拒否する', async (t) => {
  const ctx = entryCtx(t);
  if (!ctx) return;
  const early = { stopKind: STOP_KINDS.needsInput, reason: '依頼文が空', launches: 0 };
  const out = await chainReport(ctx, { functions: ['create', 'review', 'update'], runs: [{ function: 'create', result: early }], unmatched: ['公開して'] });
  assert.deepEqual(out.results, [early]);
  assert.deepEqual(out.unexecuted, ['review', 'update']);
  assert.equal(out.resume.nextArgs, null);
  assert.match(out.resume.todo, /新しく起動する/);
  assert.deepEqual(out.unmatched, ['公開して']);
  await rejects(chainReport(ctx, { functions: ['review'], runs: [{ function: 'create', result: early }] }), CODES.input);
  await rejects(chainReport(ctx, { functions: ['review'], runs: [{ function: 'review', result: { ...early, state: 'bp-1' } }] }), CODES.input);
  await rejects(chainReport(ctx, { functions: ['review'], runs: [{}, {}] }), CODES.input);
});

test('SP-BPENTRY-020: どの指摘にも載る SP-BPFINDINGS-029 の欄を 1 つでも欠く指摘は、その欄を欠けた項目として返し、欠けの無い指摘の一覧は空を返す', () => {
  const full = (id) => Object.fromEntries(FINDING_REQUIRED.map((k) => [k, k === 'id' ? id : k === 'assets' ? [] : 'x']));
  assert.deepEqual(missingFields([full('F1')]), []);
  for (const k of FINDING_REQUIRED) {
    const { [k]: _, ...rest } = full('F2');
    assert.deepEqual(missingFields([full('F1'), rest]), [{ finding: k === 'id' ? 1 : 'F2', fields: [k] }], k);
  }
  assert.deepEqual(missingFields(undefined), [{ finding: null, fields: ['findings'] }]);
});
