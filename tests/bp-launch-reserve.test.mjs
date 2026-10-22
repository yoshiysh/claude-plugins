import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INSPECT_SCRIPT, MIN_LAUNCHES, SCRIPT, createArgs, defaults, inspectArgs, inspectDefaults, runAuthor, runInspect, setup, setupInspect, updateArgs, variant, viewOf, writePayload,
} from './helpers/bp-harness.mjs';

// 予約分（2）を両方使い切るのは、試行を使い切った項目の後の停止で、停止の運搬役が応答を失って送り直す経路（停止は実行されないまま失う）。
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
