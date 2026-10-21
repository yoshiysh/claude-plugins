import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  candidateVerifier, commands, inspectArgs, runAuthor, runInspect, setup, setupInspect, updateArgs, createArgs, viewOf,
} from './helpers/bp-harness.mjs';

// 停止の運搬役を、要求の先頭の k 個だけ実行して 1 回だけ応答を失わせる（k は 0 から全要求まで）。
// between は応答を失った後、送り直しの前に行うこと（対象スキルが変わる場合を作る）。
function loseStopOnce(k, seen, between = async () => {}) {
  let done = false;
  return async (prompt, options, env) => {
    if (done || options.label !== 'carrier' || !prompt.includes(' stop <<')) return undefined;
    done = true;
    const list = commands(prompt);
    seen.count = list.length;
    seen.ops = list.map((c) => c.op);
    for (const c of list.slice(0, k)) await env.call(c.op, c.text);
    seen.lost = true;
    await between();
    return null;
  };
}

// 状態と返り値のうち、起動数と状態に固有の ID を除いた中身。送り直しは停止の記録の起動数に入らない（SP-BPRUN-034）。
async function digest(env, result) {
  const view = await viewOf(env, result.state);
  const stop = view.stops.get(result.run);
  const ids = [result.state, view.ledger?.id].filter(Boolean);
  const scrub = (v) => JSON.parse(ids.reduce((text, id) => text.split(id).join('<ID>'), JSON.stringify(v ?? null)).replace(/"F[0-9A-Z]{10}"/g, '"<F>"'));
  return scrub({
    stopKind: result.stopKind,
    reason: result.reason,
    stoppedStage: result.stoppedStage,
    writtenFiles: result.writtenFiles,
    unverified: result.unverified,
    findings: result.findings?.map((f) => [f.viewpoint, f.kind, f.state]),
    stop: { kind: stop.kind, stage: stop.stage, pending: stop.pending.length, unverified: stop.unverified },
    ended: [...view.stages.values()].filter((x) => x.ended).map((x) => `${x.stage}|${x.round ?? ''}`).sort(),
    files: view.files.map((f) => [f.path, f.action, f.iteration]),
  });
}

function writerNull(s) {
  return async () => {
    await fs.appendFile(path.join(s.target.root, 'SKILL.md'), '\n書き手が書いた\n');
    await fs.writeFile(path.join(s.target.root, 'extra.md'), 'x\n');
    return null;
  };
}

// ops は停止の運搬役の要求の並びの期待値。送り直しを停止と返り値だけに縮めると、先頭の要求が落ちて k=0 で食い違う。
const CASES = [
  {
    name: '書き手が結果を返さず書いたファイルの照らし合わせを停止と同じ運搬役で運ぶ update',
    ops: ['files-scan', 'stop', 'outcome'],
    async run(t, carrier) {
      const s = await setup(t, { fn: 'update' });
      if (!s) return null;
      const out = await runAuthor(t, { env: s.env, args: updateArgs(s.target), scenario: { write: writerNull(s), ...(carrier ? { carrier: carrier(s) } : {}) } });
      return { env: s.env, ...out };
    },
  },
  {
    name: '書き手が結果を返さず書いたファイルの照らし合わせを停止と同じ運搬役で運ぶ create',
    ops: ['files-scan', 'stop', 'outcome'],
    async run(t, carrier) {
      const s = await setup(t);
      if (!s) return null;
      const write = async (prompt) => {
        const root = /根 (\S+) の配下/.exec(prompt)[1];
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(path.join(root, 'SKILL.md'), '---\nname: made\n---\n# Made\n');
        return null;
      };
      const out = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: { write, ...(carrier ? { carrier: carrier(s) } : {}) } });
      return { env: s.env, ...out };
    },
  },
  {
    name: '完了する create',
    ops: ['stop', 'outcome'],
    async run(t, carrier) {
      const s = await setup(t);
      if (!s) return null;
      const out = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: carrier ? { carrier: carrier(s) } : {} });
      return { env: s.env, ...out };
    },
  },
  ...['review', 'audit'].map((fn) => ({
    name: `反証の段の終わりと照合と停止の段の開始を停止と同じ運搬役で運ぶ ${fn}`,
    ops: ['stage-finish', 'stage-start', 'stop', 'outcome'],
    async run(t, carrier) {
      const s = await setupInspect(t);
      if (!s) return null;
      const verify = candidateVerifier({ viewpoint: fn === 'review' ? 'flow' : 'audit' });
      const out = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { verify, ...(carrier ? { carrier: carrier(s) } : {}) } });
      return { env: s.env, ...out };
    },
  })),
];

for (const c of CASES) {
  test(`SP-BPRUN-027・SP-BPAUTHORING-015・SP-BPRUN-038: 停止の運搬役が要求の各位置まで実行して 1 回だけ応答を失っても、失わない run と同じ状態と返り値になる（${c.name}）`, async (t) => {
    const base = await c.run(t, null);
    if (!base) return;
    const want = await digest(base.env, base.result);
    for (let k = 0; k <= c.ops.length; k += 1) {
      const seen = {};
      const got = await c.run(t, () => loseStopOnce(k, seen));
      assert.equal(seen.lost, true, `k=${k} で応答を失っていない`);
      assert.deepEqual(seen.ops, c.ops, `k=${k}`);
      assert.equal(got.calls.filter((x) => x.prompt.includes(' stop <<')).length, 2, `k=${k}`);
      assert.deepEqual(await digest(got.env, got.result), want, `k=${k}`);
    }
  });
}

test('SP-BPRUN-027・SP-BPRUN-017・SP-BPAUTHORING-015: 停止の運搬役が全ての要求を実行した後に応答を失い、送り直しの前に対象スキルが変わっても、送り直しは最初の応答を返し、書いたファイルの記録と返り値が失わない run と同じになる［update］', async (t) => {
  const c = CASES[0];
  const base = await c.run(t, null);
  if (!base) return;
  const want = await digest(base.env, base.result);
  const seen = {};
  const got = await c.run(t, (s) => loseStopOnce(c.ops.length, seen, () => fs.writeFile(path.join(s.target.root, 'later.md'), 'y\n')));
  assert.equal(seen.lost, true);
  assert.equal(got.result.stopKind, 'blocked');
  assert.doesNotMatch(got.result.reason, /停止の記録を書けなかった/);
  assert.deepEqual(await digest(got.env, got.result), want);
});
