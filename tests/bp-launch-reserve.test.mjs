import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INSPECT_SCRIPT, MIN_LAUNCHES, SCRIPT, createArgs, defaults, inspectArgs, inspectDefaults, runAuthor, runInspect, setup, setupInspect, updateArgs, variant, viewOf, writePayload,
} from './helpers/bp-harness.mjs';

// 予約分を食うのは、検証の結果の拒否で試行を使い切り、運搬役が応答を失って送り直す経路だけ。他の経路では予約分を除いても上限を超えない。
function dropFirst(ops) {
  const seen = new Set();
  return async (prompt, options, env) => {
    const out = await env.carry(prompt);
    if (ops.some((op) => prompt.includes(` ${op} <<`)) && !seen.has(prompt)) { seen.add(prompt); return null; }
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
    carrier: dropFirst(['start', 'verdicts', 'item-fail']),
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
    carrier: dropFirst(['start', 'verdicts', 'item-fail']),
  };
}

const NO_RESERVE = ['return used + rest + worst + RESERVE <= limit', 'return used + rest + worst <= limit'];
// 予約分を除いた script が上限を超え始める帯（最小の起動数からの差。実測で 4 機能とも 12〜13）。帯の外では予約分を測れない。
const EXTRA = [10, 11, 12, 13, 14, 15];

async function runOnce(t, fn, limit, concurrency, scriptPath) {
  const author = fn === 'create' || fn === 'update';
  const s = author ? await setup(t, { fn }) : await setupInspect(t);
  if (!s) return null;
  const args = author ? (fn === 'create' ? createArgs : updateArgs)(s.target, { maxLaunches: limit }) : inspectArgs(fn, s.target, { maxLaunches: limit });
  const { result, calls } = await (author ? runAuthor : runInspect)(t, {
    env: s.env, args, scenario: author ? authorWorst() : inspectWorst(), concurrency, maxAgents: 1000, ...(scriptPath ? { scriptPath } : {}),
  });
  const recorded = result.state ? (await viewOf(s.env, result.state)).stops.get('r1')?.launches : undefined;
  return { calls: calls.length, recorded };
}

for (const fn of ['create', 'update', 'review', 'audit']) {
  test(`SP-BPRUN-020・SP-BPRUN-021・SP-BPCONFORMANCE-022: 試行と送り直しで起動が最も多くなる経路でも、同時実行 1・2・3 のどれでも起動数と停止の記録の起動数が上限を超えず、予約分を除いた script では上限を超える［${fn}］`, async (t) => {
    for (const concurrency of [1, 2, 3]) {
      for (const extra of EXTRA) {
        const limit = MIN_LAUNCHES[fn] + extra;
        const got = await runOnce(t, fn, limit, concurrency);
        if (!got) return;
        assert.ok(got.calls <= limit, `同時実行 ${concurrency}・上限 ${limit}: ${got.calls} 体`);
        if (got.recorded !== undefined) assert.ok(got.recorded <= limit, `同時実行 ${concurrency}・上限 ${limit}: 記録 ${got.recorded}`);
      }
    }
    const mutant = await variant(t, [NO_RESERVE], fn === 'create' || fn === 'update' ? SCRIPT : INSPECT_SCRIPT);
    const over = [];
    for (const extra of EXTRA) {
      const limit = MIN_LAUNCHES[fn] + extra;
      const got = await runOnce(t, fn, limit, 3, mutant);
      if (got.calls > limit) over.push(limit);
    }
    assert.ok(over.length > 0, '予約分を除いた script でも上限を超えない（この経路は予約分を測っていない）');
  });
}
