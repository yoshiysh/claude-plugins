import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INSPECT_SCRIPT, MIN_LAUNCHES, SCRIPT, assetIds, candidateOf, createArgs, firstUnforcedKind, defaults, inspectArgs, inspectDefaults, runAuthor, runInspect, setup, setupInspect, updateArgs, variant, viewOf, viewpointOf, writePayload,
} from './helpers/bp-harness.mjs';
import { sealResponse } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/transport.mjs';

// 予約分（2）を両方使い切る経路は 2 つある。試行を使い切った項目の後の停止で停止の運搬役が応答を失って送り直す経路（4 機能）と、
// 反証の試行を使い切った後に完了で止まり、停止の前の書き込み（照合と停止の段）と停止を運ぶ経路（review・audit）。
function worstCarrier() {
  const seen = new Set();
  return async (prompt, options, env) => {
    if (prompt.includes(' stop <<') && !seen.has(prompt)) { seen.add(prompt); return null; }
    const out = await env.carry(prompt);
    if ([' start <<', ' verdicts <<', ' item-fail <<'].some((op) => prompt.includes(op)) && !seen.has(prompt)) { seen.add(prompt); return null; }
    return out;
  };
}

function authorWorst() {
  const bad = { goal: { deliverables: [{ text: 'x', sources: [{ kind: 'request', quote: '依頼文に無い文' }] }], scope: [], prohibitions: [], numeric: [], deixis: [] } };
  let goals = 0;
  return {
    goal: async (prompt) => ((goals += 1) < 3 ? bad : defaults.goal(prompt)),
    verify: async (prompt, options) => {
      const out = options.label === 'verifier:conformance'
        ? { judgements: [{ asset: 'ANOPE', judgement: 'ok' }], candidates: [], applicability: { row: 1 }, units: [], residualRisks: [] }
        : { judgements: [{ asset: 'ANOPE', judgement: 'ok' }], candidates: [], basisConstraints: [], ...(options.label === 'verifier:contract' ? { contractChanges: [] } : {}) };
      await writePayload(prompt, out);
      return out;
    },
    carrier: worstCarrier(),
  };
}

function inspectWorst() {
  let extracts = 0;
  let applies = 0;
  return {
    extract: async (prompt) => ((extracts += 1) < 3 ? { groups: [['ANOPE']] } : inspectDefaults.extract(prompt)),
    applicability: async (prompt) => {
      applies += 1;
      const r = await inspectDefaults.applicability(prompt);
      if (applies < 3) r.answers.Q2.answer = 'はい';
      return r;
    },
    verify: async (prompt) => {
      const bad = { judgements: [{ asset: 'ANOPE', judgement: 'ok' }], candidates: [], unchecked: [] };
      await writePayload(prompt, bad);
      return bad;
    },
    carrier: worstCarrier(),
  };
}

const NO_RESERVE = ['return used + rest + worst + RESERVE <= limit', 'return used + rest + worst <= limit'];
const RESERVE_MINUS_1 = ['return used + rest + worst + RESERVE <= limit', 'return used + rest + worst + RESERVE - 1 <= limit'];

async function runOnce(t, fn, limit, concurrency, scriptPath) {
  const author = fn === 'create' || fn === 'update';
  const s = author ? await setup(t, { fn }) : await setupInspect(t);
  if (!s) return null;
  const args = author ? (fn === 'create' ? createArgs : updateArgs)(s.target, { maxLaunches: limit }) : inspectArgs(fn, s.target, { maxLaunches: limit });
  const { result, calls } = await (author ? runAuthor : runInspect)(t, {
    env: s.env, args, scenario: author ? authorWorst() : inspectWorst(), concurrency, maxAgents: 1000, ...(scriptPath ? { scriptPath } : {}),
  });
  const stop = result.state ? (await viewOf(s.env, result.state)).stops.get('r1') : undefined;
  return { calls: calls.length, stop };
}

// 帯を書き写さず、上限を最小から上げて、最初の fan-out の項目を始められる最小の上限（起動数が跳ねる点）を測る。予約分はその手前の上限で効く。
async function firstItemExtra(t, fn) {
  const base = await runOnce(t, fn, MIN_LAUNCHES[fn], 3);
  if (!base) return null;
  for (let extra = 1; extra <= 40; extra += 1) {
    if ((await runOnce(t, fn, MIN_LAUNCHES[fn] + extra, 3)).calls > base.calls) return extra;
  }
  throw new Error(`${fn}: 上限を 40 上げても最初の項目を始めない`);
}

for (const fn of ['create', 'update', 'review', 'audit']) {
  test(`SP-BPRUN-020・SP-BPRUN-021・SP-BPCONFORMANCE-022: 試行を使い切った項目の後で停止の運搬役が応答を失っても、同時実行 1・2・3 のどれでも起動数が上限を超えず停止の記録が残り、予約分を除くと上限を超え、予約分を 1 減らすと停止の記録が残らない（予約分の大きさ 2）［${fn}］`, async (t) => {
    const edge = await firstItemExtra(t, fn);
    if (edge === null) return;
    const window = [edge - 2, edge - 1, edge, edge + 1];
    for (const concurrency of [1, 2, 3]) {
      for (const extra of window) {
        const limit = MIN_LAUNCHES[fn] + extra;
        const got = await runOnce(t, fn, limit, concurrency);
        assert.ok(got.calls <= limit, `同時実行 ${concurrency}・上限 ${limit}: ${got.calls} 体`);
        assert.ok(got.stop, `同時実行 ${concurrency}・上限 ${limit}: 停止の記録が無い`);
        assert.ok(got.stop.launches <= limit, `同時実行 ${concurrency}・上限 ${limit}: 記録 ${got.stop.launches}`);
      }
    }
    const scriptOf = (cut) => variant(t, [cut], fn === 'create' || fn === 'update' ? SCRIPT : INSPECT_SCRIPT);
    const none = await scriptOf(NO_RESERVE);
    const minus1 = await scriptOf(RESERVE_MINUS_1);
    const over = [];
    const lost = [];
    for (const extra of window) {
      const limit = MIN_LAUNCHES[fn] + extra;
      if ((await runOnce(t, fn, limit, 3, none)).calls > limit) over.push(limit);
      if (!(await runOnce(t, fn, limit, 3, minus1)).stop) lost.push(limit);
    }
    assert.ok(over.length > 0, '予約分を除いた script でも上限を超えない（この経路は予約分を測っていない）');
    assert.ok(lost.length > 0, '予約分を 1 減らした script でも停止の記録が残る（この経路は予約分の大きさを測っていない）');
  });
}

const VIEWPOINT = { review: 'flow', audit: 'audit' };

// 反証 4 件のうち 1 件は維持で終わり、3 件は 1 試行で 5 起動（反証役 → 結果の運搬役が応答を失う → 送り直しが E_LOCK → item-fail が応答を失う → 送り直し）して試行を使い切る。
function refuteWorst(fn) {
  let good = null;
  const counts = new Map();
  return {
    verify: async (prompt, options, env) => {
      const base = await inspectDefaults.verify(prompt);
      if (viewpointOf(prompt) !== VIEWPOINT[fn] || options.label.endsWith(':extra')) return base;
      const ids = assetIds(prompt);
      const kind = await firstUnforcedKind(prompt, env);
      const result = { ...base, judgements: ids.map((id) => ({ asset: id, judgement: 'candidate' })), candidates: ids.map((id) => candidateOf(id, VIEWPOINT[fn], kind)) };
      await writePayload(prompt, result);
      return result;
    },
    refute: async (prompt) => {
      const key = /指摘の鍵: (.+)/.exec(prompt)[1];
      if (good === null) good = key;
      return { verdict: 'uphold', reason: key === good ? '維持' : 'BAD' };
    },
    carrier: async (prompt, options, env) => {
      if (![' refutation <<', ' item-fail <<'].some((op) => prompt.includes(op))) return env.carry(prompt);
      const n = (counts.get(prompt) ?? 0) + 1;
      counts.set(prompt, n);
      if (prompt.includes(' refutation <<') && !prompt.includes(' item-fail <<') && prompt.includes('"reason":"BAD"')) {
        return n % 2 === 1 ? null : { responses: [JSON.stringify(sealResponse({ ok: false, code: 'E_LOCK', reason: 'lock held' }))] };
      }
      const out = await env.carry(prompt);
      return n % 2 === 1 ? null : out;
    },
  };
}

async function runRefute(t, fn, limit, concurrency, scriptPath) {
  const s = await setupInspect(t);
  if (!s) return null;
  const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target, limit === undefined ? {} : { maxLaunches: limit }), scenario: refuteWorst(fn), concurrency, maxAgents: 1000, ...(scriptPath ? { scriptPath } : {}) });
  const stop = result.state ? (await viewOf(s.env, result.state)).stops.get('r1') : undefined;
  const closed = calls.some((c) => c.role === 'carrier' && c.prompt.includes(' stage-start <<') && c.prompt.includes('"close"'));
  return { calls: calls.length, stop, kind: result.stopKind, closed };
}

for (const fn of ['review', 'audit']) {
  test(`SP-BPRUN-020・SP-BPRUN-021・SP-BPCONFORMANCE-022: 反証の試行を使い切った後に完了で止まる run は、停止の前の書き込みと停止の運搬役で予約分 2 をちょうど使い（同時実行 1）、同時実行 1・2・3 のどれでも上限を超えず、予約分を 1 減らすと上限を超える［${fn}］`, async (t) => {
    const free = await runRefute(t, fn, undefined, 1);
    if (!free) return;
    assert.equal(free.kind, 'complete');
    assert.ok(free.closed, '照合と停止の段の運搬役（停止の前の書き込み）が起動されていない');
    const exact = free.calls;
    for (const concurrency of [1, 2, 3]) {
      for (const limit of [exact - 1, exact]) {
        const got = await runRefute(t, fn, limit, concurrency);
        assert.ok(got.calls <= limit, `同時実行 ${concurrency}・上限 ${limit}: ${got.calls} 体`);
        assert.ok(got.stop && got.stop.launches <= limit, `同時実行 ${concurrency}・上限 ${limit}: 停止の記録`);
      }
    }
    // 同時実行 2 以上では走っている項目の最悪の回数を確保するので、上限ちょうどでは完了まで届かないことがある（上限は超えない）。ちょうど使い切ることは同時実行 1 で照らす。
    const atExact = await runRefute(t, fn, exact, 1);
    assert.deepEqual([atExact.kind, atExact.closed, atExact.calls], ['complete', true, exact], '上限ちょうどで完了し、予約分の 2 つを使い切る');
    const minus1 = await variant(t, [RESERVE_MINUS_1], INSPECT_SCRIPT);
    const over = await runRefute(t, fn, exact - 1, 1, minus1);
    assert.ok(over.calls > exact - 1, `予約分を 1 減らした script が上限 ${exact - 1} を超えない（${over.calls} 体）`);
  });
}
