import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  candidateVerifier, commands, inspectArgs, runAuthor, runInspect, setup, setupInspect, updateArgs, createArgs, viewOf,
} from './helpers/bp-harness.mjs';

const IS_STOP = (prompt) => prompt.includes(' stop <<');
// 停止の前の書き込みの運搬役は、停止の直前に起動する、停止を運ばない運搬役（files-scan か照合と停止の段の開始を運ぶ）。
const IS_PRE = (prompt) => !IS_STOP(prompt) && (prompt.includes(' files-scan <<') || prompt.includes('"stage":"close"'));

// match に当たる運搬役を、要求の先頭の k 個だけ実行して 1 回だけ応答を失わせる。between は応答を失った後、送り直しの前に行うこと。
function loseOnce(match, k, seen, between = async () => {}) {
  let done = false;
  return async (prompt, options, env) => {
    if (done || options.label !== 'carrier' || !match(prompt)) return undefined;
    done = true;
    const list = commands(prompt);
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

// pre は停止の前の書き込みの運搬役の要求の並びの期待値（無ければ空）。停止の運搬役は常に stop と outcome だけを運ぶ。
const CASES = [
  {
    name: '書き手が結果を返さず書いたファイルの照らし合わせを停止と同じ運搬役で運ぶ update',
    pre: ['files-scan'],
    async run(t, carrier) {
      const s = await setup(t, { fn: 'update' });
      if (!s) return null;
      const out = await runAuthor(t, { env: s.env, args: updateArgs(s.target), scenario: { write: writerNull(s), ...(carrier ? { carrier: carrier(s) } : {}) } });
      return { env: s.env, ...out };
    },
  },
  {
    name: '書き手が結果を返さず書いたファイルの照らし合わせを停止と同じ運搬役で運ぶ create',
    pre: ['files-scan'],
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
    pre: [],
    async run(t, carrier) {
      const s = await setup(t);
      if (!s) return null;
      const out = await runAuthor(t, { env: s.env, args: createArgs(s.target), scenario: carrier ? { carrier: carrier(s) } : {} });
      return { env: s.env, ...out };
    },
  },
  ...['review', 'audit'].map((fn) => ({
    name: `反証の段の終わりと照合と停止の段の開始を停止と同じ運搬役で運ぶ ${fn}`,
    pre: ['stage-finish', 'stage-start'],
    async run(t, carrier) {
      const s = await setupInspect(t);
      if (!s) return null;
      const verify = candidateVerifier({ viewpoint: fn === 'review' ? 'flow' : 'audit' });
      const out = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { verify, ...(carrier ? { carrier: carrier(s) } : {}) } });
      return { env: s.env, ...out };
    },
  })),
];

const STOP_OPS = ['stop', 'outcome'];

for (const c of CASES) {
  test(`SP-BPRUN-027・SP-BPRUN-034・SP-BPAUTHORING-015・SP-BPRUN-038: 停止の前の書き込みの運搬役と停止の運搬役のそれぞれが要求の各位置まで実行して 1 回だけ応答を失っても、失わない run と同じ状態と返り値になり、停止の記録の起動数は停止の運搬役の送り直しを除いた起動数になる（${c.name}）`, async (t) => {
    const base = await c.run(t, null);
    if (!base) return;
    const want = await digest(base.env, base.result);
    const baseView = await viewOf(base.env, base.result.state);
    assert.equal(baseView.stops.get(base.result.run).launches, base.calls.length);
    assert.equal(base.calls.filter((x) => x.role === 'carrier' && IS_PRE(x.prompt)).length, c.pre.length ? 1 : 0);
    assert.ok(base.calls.filter((x) => IS_STOP(x.prompt)).every((x) => commands(x.prompt).map((y) => y.op).join() === STOP_OPS.join()));
    const kinds = [['stop', IS_STOP, STOP_OPS], ...(c.pre.length ? [['pre', IS_PRE, c.pre]] : [])];
    for (const [kind, match, ops] of kinds) {
      for (let k = 0; k <= ops.length; k += 1) {
        const seen = {};
        const got = await c.run(t, () => loseOnce(match, k, seen));
        const at = `${kind} k=${k}`;
        assert.equal(seen.lost, true, `${at} で応答を失っていない`);
        assert.deepEqual(seen.ops, ops, at);
        assert.equal(got.calls.filter((x) => x.role === 'carrier' && match(x.prompt)).length, 2, at);
        assert.deepEqual(await digest(got.env, got.result), want, at);
        const view = await viewOf(got.env, got.result.state);
        assert.equal(view.stops.get(got.result.run).launches, got.calls.length - (kind === 'stop' ? 1 : 0), at);
      }
    }
  });
}

test('SP-BPRUN-027・SP-BPRUN-017・SP-BPAUTHORING-015: 停止の前の書き込みの運搬役と停止の運搬役の間に対象スキルが変わっても、書いたファイルの記録と返り値が変わらない run と同じになり、偽の「停止の記録を書けなかった」を返さない［update］', async (t) => {
  const c = CASES[0];
  const base = await c.run(t, null);
  if (!base) return;
  const want = await digest(base.env, base.result);
  for (const lose of [false, true]) {
    let done = false;
    const got = await c.run(t, (s) => async (prompt, options, env) => {
      if (done || !IS_STOP(prompt)) return undefined;
      done = true;
      await fs.writeFile(path.join(s.target.root, 'later.md'), 'y\n');
      if (!lose) return undefined;
      await env.carry(prompt);
      return null;
    });
    assert.equal(got.result.stopKind, 'blocked');
    assert.doesNotMatch(got.result.reason, /停止の記録を書けなかった/);
    assert.deepEqual(await digest(got.env, got.result), want, `lose=${lose}`);
  }
});
