import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { STAGES } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { stoppedStage } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/view.mjs';
import {
  MIN_LAUNCHES, candidateVerifier, commands, createArgs, inspectArgs, resumeArgs, runAuthor, runInspect, setup, setupInspect, updateArgs, viewOf,
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
    name: '書き手が結果を返さず、停止の前に書いたファイルを照らし合わせる update',
    pre: ['files-scan'],
    async run(t, carrier, extra = {}) {
      const s = await setup(t, { fn: 'update' });
      if (!s) return null;
      const out = await runAuthor(t, { env: s.env, args: updateArgs(s.target, extra), scenario: { write: writerNull(s), ...(carrier ? { carrier: carrier(s) } : {}) } });
      return { env: s.env, ...out };
    },
  },
  {
    name: '書き手が結果を返さず、停止の前に書いたファイルを照らし合わせる create',
    pre: ['files-scan'],
    async run(t, carrier, extra = {}) {
      const s = await setup(t);
      if (!s) return null;
      const write = async (prompt) => {
        const root = /根 (\S+) の配下/.exec(prompt)[1];
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(path.join(root, 'SKILL.md'), '---\nname: made\n---\n# Made\n');
        return null;
      };
      const out = await runAuthor(t, { env: s.env, args: createArgs(s.target, extra), scenario: { write, ...(carrier ? { carrier: carrier(s) } : {}) } });
      return { env: s.env, ...out };
    },
  },
  {
    name: '完了する create',
    pre: [],
    async run(t, carrier, extra = {}) {
      const s = await setup(t);
      if (!s) return null;
      const out = await runAuthor(t, { env: s.env, args: createArgs(s.target, extra), scenario: carrier ? { carrier: carrier(s) } : {} });
      return { env: s.env, ...out };
    },
  },
  ...['review', 'audit'].map((fn) => ({
    name: `停止の前に反証の段の終わりと照合と停止の段の開始を書く ${fn}`,
    pre: ['stage-finish', 'stage-start'],
    async run(t, carrier, extra = {}) {
      const s = await setupInspect(t);
      if (!s) return null;
      const verify = candidateVerifier({ viewpoint: fn === 'review' ? 'flow' : 'audit' });
      const out = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target, extra), scenario: { verify, ...(carrier ? { carrier: carrier(s) } : {}) } });
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

const FN_OF = ['update', 'create', 'create', 'review', 'audit'];

// 停止の記録を書けなかったときの理由の段は、CLI が停止の記録に書くはずだった段（SP-BPRUN-018・SP-BPRUN-027）。状態から同じ規則で導いて照らす。
async function cliStage(env, state) {
  const view = await viewOf(env, state);
  const live = stoppedStage(view, { includeCurrentRun: true });
  return live.stage == null ? null : STAGES[live.stage];
}

for (const [n, c] of CASES.entries()) {
  test(`SP-BPRUN-027・SP-BPRUN-017・SP-BPAUTHORING-015: 停止の前の書き込みの運搬役と停止の運搬役の間に対象スキルが変わっても、書いたファイルの記録と返り値が変わらない run と同じになり、偽の「停止の記録を書けなかった」を返さない［${FN_OF[n]}］（${c.name}）`, async (t) => {
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
      assert.doesNotMatch(got.result.reason ?? '', /停止の記録を書けなかった/);
      const d = await digest(got.env, got.result);
      // review・audit は run の中で対象が変わると BLOCKED になる（SP-BPRUN-026）ので、停止の種類と理由を除いて比べる。
      if (FN_OF[n] === 'review' || FN_OF[n] === 'audit') {
        assert.equal(got.result.stopKind, 'blocked');
        assert.match(got.result.reason, /run の中で対象スキルが変わった: later\.md/);
        for (const key of ['stopKind', 'reason']) { delete d[key]; delete want[key]; }
        delete d.stop.kind; delete want.stop.kind;
        delete d.stoppedStage; delete want.stoppedStage;
        delete d.findings; delete want.findings;
      }
      assert.deepEqual(d, want, `lose=${lose}`);
    }
  });

  test(`SP-BPRUN-027・SP-BPRUN-018・SP-BPRUN-030・SP-BPRUN-032: 停止の前の書き込みの運搬役か停止の運搬役が送り直しでも応答を失うと、停止の記録を書かずに、CLI が導いた段・失敗した運搬役・止めようとした停止を理由に持ち、状態にある書いたファイルの一覧を持つ BLOCKED と next_args を返す［${FN_OF[n]}］（${c.name}）`, async (t) => {
    const base = await c.run(t, null);
    if (!base) return;
    const kinds = [['停止', IS_STOP], ...(c.pre.length ? [['停止の前の書き込み', IS_PRE]] : [])];
    for (const [label, match] of kinds) {
      let lost = 0;
      const got = await c.run(t, () => async (prompt, options) => (options.label === 'carrier' && match(prompt) && (lost += 1) <= 2 ? null : undefined));
      assert.equal(got.result.stopKind, 'blocked', label);
      const stage = await cliStage(got.env, got.result.state);
      assert.ok(stage, label);
      assert.ok(got.result.reason.includes(`（段「${stage}」の${label}の運搬役。止めようとした停止: ${base.result.stopKind}`), got.result.reason);
      assert.deepEqual(got.result.nextArgs, { function: FN_OF[n], state: got.result.state });
      assert.equal((await viewOf(got.env, got.result.state)).stops.size, 0, label);
      // 返り値の書いたファイルの一覧は、状態にある記録と同じで、停止の記録を書けなかったので検証を通っていない（完了の停止だけが検証を通った記録を足す）。
      const recorded = [...new Map((await viewOf(got.env, got.result.state)).files.map((f) => [f.path, f])).values()].map((f) => ({ path: f.path, action: f.action, verified: false }));
      assert.deepEqual(got.result.writtenFiles, recorded.length ? recorded : undefined, label);
      if (label === '停止' && base.result.writtenFiles) assert.deepEqual(recorded.map((f) => f.path), base.result.writtenFiles.map((f) => f.path), label);
    }
  });
}

// 観点ごとの検証の項目を、結果を書くまでに最悪の 15 回の起動を使わせる（応答の喪失と sum の崩れで試行を 3 回使い、3 回目で結果を書く）。
// こうすると、上限ちょうどの run は停止の前の書き込みと停止の運搬役の予約分だけを残して照合と停止の段に着く。
function worstItems() {
  const st = new Map();
  const broken = async (env, c) => {
    const body = JSON.parse(c.text);
    body.sum = '00000000';
    return { responses: [JSON.stringify(await env.call(c.op, JSON.stringify(body)))] };
  };
  return async (prompt, options, env) => {
    if (options.label !== 'carrier:verify') return undefined;
    const [c] = commands(prompt);
    const item = JSON.parse(c.text).item;
    const s = st.get(item) ?? { attempt: 1, step: 0 };
    st.set(item, s);
    const last = s.attempt === 3;
    s.step += 1;
    if (c.op === 'verdicts') {
      if (s.step === 1) { if (last) await env.carry(prompt); return null; }
      return broken(env, c);
    }
    if (c.op === 'item-fail') {
      if (s.step === 3) { if (!last) await env.carry(prompt); return null; }
      s.attempt += 1;
      s.step = 0;
    }
    return undefined;
  };
}

for (const fn of ['review', 'audit']) {
  test(`SP-BPRUN-027・SP-BPRUN-021・SP-BPRUN-040: 起動数の上限ちょうどの run で停止の前の書き込みの運搬役が応答を失うと、停止の運搬役の分を残せないので送り直さず、起動数が上限を超えずに停止の記録の無い BLOCKED になる［${fn}］`, async (t) => {
    const run = async (limit, lose) => {
      const s = await setupInspect(t);
      if (!s) return null;
      const items = worstItems();
      let lost = false;
      const carrier = async (prompt, options, env) => {
        if (lose && !lost && options.label === 'carrier' && IS_PRE(prompt)) { lost = true; return null; }
        return items(prompt, options, env);
      };
      const out = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target, limit ? { maxLaunches: limit } : {}), scenario: { carrier }, ...(limit ? { maxAgents: limit } : {}) });
      return { env: s.env, ...out };
    };
    const base = await run(null, false);
    if (!base) return;
    assert.equal(base.result.stopKind, 'complete', base.result.reason);
    const limit = base.calls.length;
    assert.ok(limit >= MIN_LAUNCHES[fn]);
    const tight = await run(limit, false);
    assert.equal(tight.result.stopKind, 'complete', tight.result.reason);
    const got = await run(limit, true);
    assert.ok(got.calls.length <= limit, `${got.calls.length} > ${limit}`);
    assert.equal(got.calls.filter((x) => x.role === 'carrier' && IS_PRE(x.prompt)).length, 1);
    assert.equal(got.result.stopKind, 'blocked');
    assert.match(got.result.reason, /停止の前の書き込みの運搬役/);
    assert.equal((await viewOf(got.env, got.result.state)).stops.size, 0);
    const again = await runInspect(t, { env: got.env, args: resumeArgs(got.result) });
    assert.equal(again.result.stopKind, 'complete', again.result.reason);
    // 停止の運搬役を失うと、上限に当たっているので停止も段の読み出しも送らず、段を読めなかったことを理由に書く。
    const s3 = await setupInspect(t);
    const items = worstItems();
    let lost = false;
    const carrier = async (prompt, options, env) => {
      if (!lost && options.label === 'carrier' && IS_STOP(prompt)) { lost = true; return null; }
      return items(prompt, options, env);
    };
    const stopLost = await runInspect(t, { env: s3.env, args: inspectArgs(fn, s3.target, { maxLaunches: limit }), scenario: { carrier }, maxAgents: limit });
    assert.ok(stopLost.calls.length <= limit);
    assert.equal(stopLost.calls.filter((x) => IS_STOP(x.prompt)).length, 1);
    assert.ok(!stopLost.calls.some((x) => x.prompt.includes(' stop-draft <<')));
    assert.match(stopLost.result.reason, /^停止の記録を書けなかった（段は読めなかった。停止の運搬役。止めようとした停止: complete）/);
  });
}

// create・update の停止の前の書き込み（files-scan）は書く段で止まったときだけ起き、書く段の起動の前に WORST.write を確保しているので、
// 最小の上限でも停止の前の書き込みの送り直しと停止の運搬役の分の余りがある（following を外しても同じ結果になる。上限との噛み合いは review・audit のテストが照らす）。
test('SP-BPRUN-027・SP-BPRUN-040: 最小の起動数の上限の create・update で停止の前の書き込みの運搬役が応答を失うと、余りがあるので送り直して停止の記録を書き、起動数が上限を超えない［create］［update］', async (t) => {
  for (const [n, c] of CASES.entries()) {
    if (!c.pre.includes('files-scan')) continue;
    const limit = MIN_LAUNCHES[FN_OF[n]];
    const seen = {};
    const got = await c.run(t, () => loseOnce(IS_PRE, 0, seen), { maxLaunches: limit });
    if (!got) return;
    assert.equal(seen.lost, true, c.name);
    assert.equal(got.calls.filter((x) => x.role === 'carrier' && IS_PRE(x.prompt)).length, 2, c.name);
    assert.equal((await viewOf(got.env, got.result.state)).stops.size, 1, c.name);
    assert.ok(got.calls.length <= limit, `${c.name}: ${got.calls.length} > ${limit}`);
  }
});

test('SP-BPRUN-027・SP-BPRUN-032: 停止の記録を書けなかった update で段と書いたファイルの一覧の読み出しも失うと、段を読めなかったことを理由に書き、一覧を載せない［update］', async (t) => {
  const c = CASES[0];
  let lost = 0;
  const got = await c.run(t, () => async (prompt, options) => {
    if (options.label !== 'carrier') return undefined;
    if (IS_STOP(prompt) && (lost += 1) <= 2) return null;
    return prompt.includes(' stop-draft <<') ? null : undefined;
  });
  if (!got) return;
  assert.equal(got.result.stopKind, 'blocked');
  assert.match(got.result.reason, /^停止の記録を書けなかった（段は読めなかった。停止の運搬役。止めようとした停止: blocked: /);
  assert.equal(got.result.writtenFiles, undefined);
  assert.equal(got.calls.filter((x) => x.prompt.includes(' stop-draft <<')).length, 1);
  assert.ok((await viewOf(got.env, got.result.state)).files.length > 0);
});

// 再開した run では、停止の記録に書くはずだった段に前の run の終えていない段が入る（SP-BPRUN-018）。script の手元の値では分からない段を CLI から読む。
for (const fn of ['create', 'update', 'review', 'audit']) {
  test(`SP-BPRUN-027・SP-BPRUN-018・SP-BPRUN-030: 再開した run が最初の段の書き込みで止まり停止の記録も書けないと、理由の段は CLI が状態から導いた止まった段になる［${fn}］`, async (t) => {
    const inspect = fn === 'review' || fn === 'audit';
    const s = inspect ? await setupInspect(t) : await setup(t, { fn });
    if (!s) return;
    const run = inspect ? runInspect : runAuthor;
    const args = inspect ? inspectArgs(fn, s.target) : fn === 'create' ? createArgs(s.target) : updateArgs(s.target);
    const scenario = inspect ? { extract: async () => null } : { goal: async () => null };
    const r1 = await run(t, { env: s.env, args, scenario });
    assert.equal(r1.result.stopKind, 'blocked');
    let started = false;
    const carrier = async (prompt, options, env) => {
      if (options.label !== 'carrier') return undefined;
      if (!started) { started = true; return undefined; }
      return prompt.includes(' stop-draft <<') ? undefined : null;
    };
    const r2 = await run(t, { env: s.env, args: resumeArgs(r1.result), scenario: { carrier } });
    assert.equal(r2.result.stopKind, 'blocked');
    const stage = await cliStage(s.env, r1.result.state);
    assert.ok(stage);
    assert.match(r2.result.reason, new RegExp(`^停止の記録を書けなかった（段「${stage}」の停止の運搬役`));
    assert.equal((await viewOf(s.env, r1.result.state)).stops.get(r2.result.run), undefined);
  });
}

test('SP-BPRUN-027: 段の記録が 1 つも無いまま停止の記録も書けないと、段の記録が無いことを理由に書く［review］', async (t) => {
  const s = await setupInspect(t);
  if (!s) return;
  let started = false;
  const carrier = async (prompt, options) => {
    if (options.label !== 'carrier') return undefined;
    if (!started) { started = true; return undefined; }
    return prompt.includes(' stop-draft <<') ? undefined : null;
  };
  const { result } = await runInspect(t, { env: s.env, args: inspectArgs('review', s.target), scenario: { carrier } });
  assert.match(result.reason, /^停止の記録を書けなかった（段の記録は無い。停止の運搬役。止めようとした停止: blocked: /);
});
