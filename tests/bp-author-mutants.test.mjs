import test from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPT, createArgs, defaults, runAuthor, setup, updateArgs, variant } from './helpers/bp-harness.mjs';

const MIN_UPDATE = 23;

// §5.9 の教訓 4: script に欠陥を入れた写しで、決めておいた場合が必ず落ちることを照らす。
// 各場合は「正しい script なら true」を返す。元の script で true、欠陥を入れた写しで false でなければならない。
const CASES = [
  {
    name: '起動数の上限の確かめを外すと、上限を超えて runner が run を失敗させる',
    from: '      if (limit === undefined) return true\n', to: '      return true\n',
    async check(t, scriptPath) {
      const s = await setup(t, { fn: 'update' });
      try {
        const { result } = await runAuthor(t, { env: s.env, args: updateArgs(s.target, { maxLaunches: MIN_UPDATE + 1 }), maxAgents: MIN_UPDATE + 1, scriptPath });
        return result.stopKind === 'iteration_limit' && result.launches <= MIN_UPDATE + 1;
      } catch {
        return false;
      }
    },
  },
  {
    name: '応答の sum の照合を外すと、運搬役が書き換えた応答を受理する',
    from: 'if (fnvSum(rest) !== sum)', to: 'if (false)',
    async check(t, scriptPath) {
      const s = await setup(t);
      const carrier = async (prompt, options, env) => {
        const out = await env.carry(prompt);
        if (prompt.includes(' goal-check <<')) out.responses = out.responses.map((r) => r.replace('"passed":true', '"passed":false'));
        return out;
      };
      const { result } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { carrier }, scriptPath });
      return result.stopKind === 'blocked' && /sum が合わない/.test(result.reason);
    },
  },
  {
    name: '未着手の項目を並べ替えると、停止の記録が拒否されて反復の上限で止まれない',
    from: '  return open.items.filter((x) => !x.done && !x.aborted && !x.discarded).map((x) => x.id)', to: '  return open.items.filter((x) => !x.done && !x.aborted && !x.discarded).map((x) => x.id).reverse()',
    async check(t, scriptPath) {
      const s = await setup(t, { fn: 'update' });
      const { result } = await runAuthor(t, { env: s.env, args: updateArgs(s.target, { maxLaunches: MIN_UPDATE }), maxAgents: MIN_UPDATE, scriptPath, concurrency: 1 });
      return result.stopKind === 'iteration_limit';
    },
  },
  {
    name: '反証役に書き手の返り値を渡すと、検証役・反証役の入力がパスの外を含む',
    from: "    `指摘の鍵: ${JSON.stringify(key)}`,", to: "    `指摘の鍵: ${JSON.stringify(key)}`,\n    JSON.stringify({ written: memo.written }),",
    async check(t, scriptPath) {
      const s = await setup(t);
      const verify = async (prompt, options, env) => {
        const result = await defaults.verify(prompt, options, env);
        if (options.label !== 'verifier:goal') return result;
        const { kinds } = await env.readFromPrompt(prompt, 'kinds');
        result.judgements[0].judgement = 'candidate';
        result.candidates = [{ asset: result.judgements[0].asset, viewpoint: 'goal', kind: kinds[0].value, quote: 'q', content: 'c', fix: 'f' }];
        const { writePayload } = await import('./helpers/bp-harness.mjs');
        await writePayload(prompt, result);
        return result;
      };
      const { calls } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { verify, refute: async () => ({ verdict: 'reject', reason: 'r' }) }, scriptPath });
      const judged = calls.filter((c) => c.role === 'refute' || c.role === 'verify');
      return judged.some((c) => c.role === 'refute') && judged.every((c) => !/"written"/.test(c.prompt));
    },
  },
  {
    name: '合否の前に完了で止まると、不合格のまま完了しようとして反復の上限で止まらない',
    from: '  const g = out[k + 4]\n', to: '  const g = { ...out[k + 4], next: GATE_NEXT.complete }\n',
    async check(t, scriptPath) {
      const s = await setup(t);
      const verify = async (prompt, options, env) => {
        const result = await defaults.verify(prompt, options, env);
        if (options.label !== 'verifier:conformance') return result;
        const unit = result.units.find((u) => u.result === 'conform');
        Object.assign(unit, { result: 'unchecked', unchecked: 'unforced' });
        const { writePayload } = await import('./helpers/bp-harness.mjs');
        await writePayload(prompt, result);
        return result;
      };
      const { result } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { verify }, scriptPath });
      return result.stopKind === 'iteration_limit';
    },
  },
  {
    name: '試行の失敗の番号を 1 ずらすと、CLI が拒否して 1 件の欠けで BLOCKED になる',
    from: 'write(OPS.itemFail, { item, attempt: current + 1, reason: outcome.reason })', to: 'write(OPS.itemFail, { item, attempt: current + 2, reason: outcome.reason })',
    async check(t, scriptPath) {
      const s = await setup(t);
      let n = 0;
      const verify = async (prompt, options, env) => (options.label === 'verifier:goal' && (n += 1) === 1 ? null : defaults.verify(prompt, options, env));
      const { result } = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { verify }, scriptPath });
      return result.stopKind === 'complete';
    },
  },
];

for (const c of CASES) {
  test(`教訓 4（壊した script で落ちる）: ${c.name}`, async (t) => {
    const s = await setup(t);
    if (!s) return;
    assert.equal(await c.check(t, SCRIPT), true, '元の script で場合が通らない');
    const mutant = await variant(t, [[c.from, c.to]]);
    assert.equal(await c.check(t, mutant), false, '欠陥を入れた script でも場合が通る');
  });
}
