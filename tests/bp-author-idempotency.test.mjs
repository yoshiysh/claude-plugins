import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  Env, VANISH_FILES, assetIds, candidateVerifier, createArgs, defaults, inspectArgs, resumeArgs, runAuthor, runInspect, setup, setupInspect, updateArgs, vanishScenario, writePayload,
} from './helpers/bp-harness.mjs';
import { LOG_FILE, OPS, STATES_DIR, WRITE_OPS } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';

// 全ての要求を 2 回ずつ届け、2 回目が記録を足さず同じ受理か同じ拒否になることを照らす（送り直しで記録が増えないことの確かめ）。
class TwiceEnv extends Env {
  constructor(base, seen, violations) {
    super({ root: base.root, criteriaDir: base.criteriaDir, promptAudit: base.promptAudit });
    this.seen = seen;
    this.violations = violations;
  }

  async logText(state) {
    if (!state) return null;
    return fs.readFile(path.join(this.root, STATES_DIR, state, LOG_FILE), 'utf8').catch(() => null);
  }

  // 並行の項目の書き込みが 2 回の間に入ると記録の差が他の要求のものになるので、2 回の組を直列にする。
  call(op, text) {
    const run = (this.queue ?? Promise.resolve()).then(() => this.twice(op, text));
    this.queue = run.catch(() => null);
    return run;
  }

  async twice(op, text) {
    const body = JSON.parse(text);
    const first = await super.call(op, text);
    const state = body.state ?? first.state;
    const before = await this.logText(state);
    const second = await super.call(op, text);
    const after = await this.logText(state);
    if (after !== before) this.violations.push(`${op} の 2 回目が記録を足した`);
    if (second.ok !== first.ok || second.code !== first.code) this.violations.push(`${op} の 2 回目の応答が 1 回目と違う: ${second.code ?? 'ok'} ${second.reason ?? ''}`);
    this.seen.add(op);
    return first;
  }
}

function conformanceCandidate() {
  return async (prompt, options, env, call, calls) => {
    const result = await defaults.verify(prompt, options, env);
    if (options.label !== 'verifier:conformance' || calls.filter((c) => c.role === 'write').length !== 1) return result;
    const asset = assetIds(prompt)[0];
    const { kinds } = await env.readFromPrompt(prompt, 'kinds');
    const unit = result.units.find((u) => u.result === 'conform');
    const key = { asset, viewpoint: 'conformance', kind: kinds[0].value };
    result.judgements[0].judgement = 'candidate';
    result.candidates = [{ ...key, quote: 'L1', content: 'c', fix: 'f' }];
    Object.assign(unit, { result: 'nonconform', keys: [key] });
    await writePayload(prompt, result);
    return result;
  };
}

// review の段の書き込み（照らす先・資産の束・適用の判定）を、受理と拒否の両方で 2 回ずつ届ける。
async function inspectWrites(t, env) {
  const s = await setup(t, { fn: 'update' });
  const started = await env.request(OPS.start, { key: `k-inspect-${Date.now()}`, function: 'review', target: s.target, limits: { attempts: 3, iterations: 3, untilPass: 3 } });
  const req = { state: started.state, run: started.run };
  const w = (op, b = {}) => env.request(op, { ...req, ...b });
  await w(OPS.stageStart, { stage: 'targets', keys: [] });
  await w(OPS.targets);
  await w(OPS.stageStart, { stage: 'bundle', keys: [] });
  const ledger = await w(OPS.ledgerCreate);
  await w(OPS.bundle);
  await w(OPS.stageStart, { stage: 'applicability', keys: [] });
  const quote = [{ asset: ledger.assets[0].id, line: 1, text: '---' }];
  const answer = (a) => ({ answer: a, quotes: quote });
  const bad = await w(OPS.applicability, { n: 1, result: { answers: { A: answer('いいえ'), Q1: answer('はい'), Q2: answer('問いに到達しない'), Q3: answer('問いに到達しない') }, ledger: answer('無'), fanout: answer('無') } });
  const good = await w(OPS.applicability, { n: 2, result: { answers: { A: answer('いいえ'), Q1: answer('問いに到達しない'), Q2: answer('問いに到達しない'), Q3: answer('問いに到達しない') }, ledger: answer('無'), fanout: answer('無') } });
  assert.equal(bad.code, 'E_RESULT');
  assert.equal(good.shape, 'ターンごとの指揮', good.reason);
}

test('SP-BPRUN-006・SP-BPRUN-031: 書き込みの操作の全てが、同じ要求の 2 回目を記録を足さずに受け、読み出しの操作は記録を変えない', async (t) => {
  const seen = new Set();
  const violations = [];
  const scenarios = [
    { fn: 'create', scenario: {} },
    { fn: 'update', scenario: { verify: conformanceCandidate() } },
    { fn: 'update', scenario: { write: async () => null } },
    { fn: 'create', scenario: { refute: async () => null, verify: conformanceCandidate() } },
    {
      fn: 'create',
      scenario: {
        verify: async (prompt, options, env, call, calls) => {
          const bad = { judgements: [{ asset: 'ANOPE', judgement: 'ok' }], candidates: [], basisConstraints: [] };
          if (options.label === 'verifier:goal' && calls.filter((c) => c.label === 'verifier:goal').length === 1) {
            await writePayload(prompt, bad);
            return bad;
          }
          return defaults.verify(prompt, options, env);
        },
      },
    },
  ];
  scenarios.push({ fn: 'update', files: VANISH_FILES, vanish: true });
  for (const { fn, scenario: given, files, vanish } of scenarios) {
    const s = await setup(t, { fn, files });
    if (!s) return;
    const scenario = vanish ? vanishScenario(s.target.root) : given;
    const env = new TwiceEnv(s.env, seen, violations);
    const args = fn === 'create' ? createArgs(s.target) : updateArgs(s.target);
    await runAuthor(t, { env, args, scenario });
  }
  const s = await setup(t);
  const env = new TwiceEnv(s.env, seen, violations);
  const first = await runAuthor(t, { env, args: createArgs(s.target), scenario: { goal: async () => ({ missing: [{ question: 'q', reason: 'r' }] }) } });
  await runAuthor(t, { env, args: resumeArgs(first.result, { answer: 'a' }) });
  const req = { state: first.result.state, run: 'r2' };
  await env.request(OPS.stop, { ...req, kind: 'blocked', reason: 'x', pending: [], launches: 1 }).catch(() => null);
  const third = await env.request(OPS.start, { key: 'k-direct', state: first.result.state });
  await env.request(OPS.premise, { state: third.state, run: third.run, kind: 'answer', text: '直接' });
  await env.request(OPS.stageRepeat, { state: third.state, run: third.run, stage: 'goal', n: 1, limitKey: 'untilPass' });
  await inspectWrites(t, env);
  for (const [fn, viewpoint] of [['review', 'flow'], ['audit', 'audit']]) {
    const i = await setupInspect(t);
    const twice = new TwiceEnv(i.env, seen, violations);
    const { result } = await runInspect(t, { env: twice, args: inspectArgs(fn, i.target), scenario: { verify: candidateVerifier({ viewpoint }) } });
    assert.equal(result.stopKind, 'complete', `${fn}: ${result.reason}`);
  }
  assert.deepEqual([...new Set(violations)], []);
  const missing = WRITE_OPS.filter((op) => !seen.has(op));
  assert.deepEqual(missing, [], `書き込みの操作のうち 2 回届けて照らしていないもの: ${missing.join(', ')}`);
  const readOps = Object.values(OPS).filter((op) => !WRITE_OPS.includes(op));
  const log = await env.logText(third.state);
  for (const op of readOps) {
    const body = { state: third.state, function: 'create', target: { root: s.target.root }, viewpoint: 'goal', viewpoints: ['goal'], stages: [{ stage: 'verify', round: 1 }], root: s.target.root };
    await env.request(op, body);
    assert.equal(await env.logText(third.state), log, `読み出しの操作 ${op} が記録を変えた`);
  }
  assert.deepEqual([...readOps, ...WRITE_OPS].sort(), Object.values(OPS).sort());
});

test('SP-BPRUN-006: 鍵が同じで中身が違う書き込みを E_CONFLICT（停止は E_STALE_RUN）で拒否する', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const { result } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { goal: async () => ({ missing: [{ question: 'q', reason: 'r' }] }) } });
  const start = await s.env.request(OPS.start, { key: 'k-conflict', state: result.state });
  const req = { state: start.state, run: start.run };
  const w = (op, b) => s.env.request(op, { ...req, ...b });
  const st = await w(OPS.stageStart, { stage: 'goal', round: 9, keys: [{ goal: 9 }] });
  const item = st.items[0];
  const table = [
    [OPS.stageStart, { stage: 'goal', round: 9, keys: [{ goal: 9 }] }, { stage: 'goal', round: 9, keys: [{ goal: 8 }] }, 'E_CONFLICT'],
    [OPS.itemFail, { item, attempt: 1, reason: 'a' }, { item, attempt: 1, reason: 'b' }, 'E_CONFLICT'],
    [OPS.itemResult, { item, result: { a: 1 } }, { item, result: { a: 2 } }, 'E_CONFLICT'],
    [OPS.files, { entries: [] }, { entries: [] }, null],
    [OPS.stop, { kind: 'blocked', reason: 'a', pending: [], launches: 1 }, { kind: 'blocked', reason: 'b', pending: [], launches: 1 }, 'E_STALE_RUN'],
  ];
  for (const [op, first, second, code] of table) {
    assert.equal((await w(op, first)).ok, true, op);
    const out = await w(op, second);
    if (code) assert.equal(out.code, code, op);
  }
});
