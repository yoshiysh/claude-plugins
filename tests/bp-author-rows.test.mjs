import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  MIN_LAUNCHES, SKILL_DIR, VANISH_FILES, assetIds, createArgs, defaults, editFile, inspectArgs, resumeArgs, runAuthor, runInspect, setup, setupInspect,
  updateArgs, vanishScenario, viewOf, writePayload,
} from './helpers/bp-harness.mjs';

const FNS = [['create', createArgs], ['update', updateArgs]];
const VIEWPOINT_ORDER = { create: ['conformance', 'goal'], update: ['conformance', 'goal', 'contract'] };
const mark = (fn) => `［${fn}］`;

function iterationOf(call, calls) {
  return calls.slice(0, call.n).filter((c) => c.role === 'write').length;
}

// 適合の観点の検証役が、when に当たる反復で担当の先頭の資産に候補を 1 件返す（判定の単位も不適合にして鍵を添える）。
function nonconformVerifier(when = () => true) {
  return async (prompt, options, env, call, calls) => {
    const result = await defaults.verify(prompt, options, env);
    if (options.label !== 'verifier:conformance' || !when(iterationOf(call, calls))) return result;
    const asset = assetIds(prompt)[0];
    const unit = result.units.find((u) => u.result === 'conform');
    const key = { asset, viewpoint: 'conformance', kind: unit.unit };
    result.judgements.find((j) => j.asset === asset).judgement = 'candidate';
    result.candidates = [{ ...key, quote: 'L1: 本文', content: '基準に反する', fix: '直す' }];
    Object.assign(unit, { result: 'nonconform', keys: [key] });
    await writePayload(prompt, result);
    return result;
  };
}

// 書き手は資産が 4 つ（ファイルと 3 つの節）になる SKILL.md を書く。担当の資産ごとに違う判定を返せるようにするため。
async function sectionsWrite(prompt) {
  const out = await defaults.write(prompt);
  const file = out.written[0].path;
  const number = /反復の番号: (\d+)/.exec(prompt)[1];
  await fs.writeFile(file, `---\nname: made\ndescription: d\n---\n# Made\n本文 ${number}\n## 設計の説明\nA: はい。Q1: いいえ。\n## 手順\n手順の本文\n## 例\n例の本文\n`);
  return out;
}

async function hashTree(dir) {
  const out = new Map();
  const walk = async (d) => {
    const entries = await fs.readdir(d, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.set(p, createHash('sha256').update(await fs.readFile(p)).digest('hex'));
    }
  };
  await walk(dir);
  return out;
}

function changedPaths(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p)).sort();
}

const inside = (p, root) => p === root || p.startsWith(`${root}${path.sep}`);

// 上限を最小から 1 ずつ上げ、同時実行 1 の run が stage で止まる最初の上限を探す（模擬の起動数は script の勘定で変わるので値を書き込まない）。
async function limitStoppingAt(t, fn, args, stage, scenario, extraSetup = {}) {
  for (let limit = MIN_LAUNCHES[fn]; limit <= MIN_LAUNCHES[fn] + 60; limit += 1) {
    const s = await setup(t, { fn, ...extraSetup });
    const run = await runAuthor(t, { env: s.env, args: args(s.target, { maxLaunches: limit }), maxAgents: limit, concurrency: 1, scenario: scenario(s) });
    if (run.result.stopKind !== 'iteration_limit') continue;
    const view = await viewOf(s.env, run.result.state);
    if (view.stops.get('r1').stage?.stage === stage) return { s, run, view, limit };
  }
  return null;
}

test('SP-BPRUN-010・SP-BPAUTHORING-029・SP-BPAUTHORING-008: create・update は入力の不足（空の依頼文・扱う根拠が 0 件・目標の固定で足りない入力）で needs_input で止まり、review・audit は入力の不足（対象スキルのディレクトリが無い）でも needs_input でなく BLOCKED で止まる［create］［update］［review］［audit］', async (t) => {
  const c = await setup(t, { fn: 'create' });
  if (!c) return;
  const emptyRequest = await runAuthor(t, { env: c.env, args: createArgs(c.target, { request: '' }) });
  assert.equal(emptyRequest.result.stopKind, 'needs_input');
  const u = await setup(t, { fn: 'update' });
  const noGround = await runAuthor(t, { env: u.env, args: updateArgs(u.target, { grounds: [{ id: 'F1', state: 'dismissed' }] }) });
  assert.equal(noGround.result.stopKind, 'needs_input');
  for (const [fn, args] of FNS) {
    const s = await setup(t, { fn });
    const missing = await runAuthor(t, { env: s.env, args: args(s.target), scenario: { goal: async () => ({ missing: [{ question: '対象の形式は？', reason: '指示語が指すものが無い' }] }) } });
    assert.equal(missing.result.stopKind, 'needs_input', fn);
    assert.deepEqual(missing.result.nextArgs, { function: fn, state: missing.result.state });
  }
  for (const fn of ['review', 'audit']) {
    const s = await setupInspect(t);
    const nowhere = await runInspect(t, { env: s.env, args: inspectArgs(fn, { root: path.join(s.base, 'none') }) });
    assert.equal(nowhere.result.stopKind, 'blocked', fn);
  }
});

for (const [fn, args] of FNS) {
  test(`SP-BPRUN-008: ${fn} の run が書き込むのは対象スキルと作業場所（状態の root）の中だけで、対象スキルの中身は書き手の起動の直後のまま他の役に変えられず、対象スキルの外・判定基準の写し・best-practices の配布物は変わらない${mark(fn)}`, async (t) => {
    const s = await setup(t, { fn });
    if (!s) return;
    const before = { base: await hashTree(s.base), criteria: await hashTree(s.env.criteriaDir), skill: await hashTree(SKILL_DIR) };
    const afterWriter = [];
    const write = async (prompt) => {
      const out = await defaults.write(prompt);
      afterWriter.push(await hashTree(s.target.root));
      return out;
    };
    const { result } = await runAuthor(t, { env: s.env, args: args(s.target), scenario: { write, verify: nonconformVerifier((n) => n === 1) } });
    assert.equal(result.stopKind, 'complete', result.reason);
    assert.equal(afterWriter.length, 2);
    const outsideTarget = changedPaths(before.base, await hashTree(s.base)).filter((p) => !inside(p, s.target.root));
    assert.deepEqual(outsideTarget, []);
    assert.deepEqual(changedPaths(before.criteria, await hashTree(s.env.criteriaDir)), []);
    assert.deepEqual(changedPaths(before.skill, await hashTree(SKILL_DIR)), []);
    assert.deepEqual([...(await hashTree(s.target.root)).entries()], [...afterWriter.at(-1).entries()]);
    const work = changedPaths(new Map(), await hashTree(s.env.root));
    assert.ok(work.some((p) => inside(p, path.join(s.env.root, 'states', result.state))));
  });
}

for (const [fn, args] of FNS) {
  test(`SP-BPRUN-012: 反復の上限と BLOCKED のどちらで完了の前に止まっても、書き手が書いたファイルが書いた内容のまま残り、消されず書く前の内容に戻されない${mark(fn)}`, async (t) => {
    const s = await setup(t, { fn });
    if (!s) return;
    const file = path.join(s.target.root, 'SKILL.md');
    const limited = await runAuthor(t, { env: s.env, args: args(s.target), scenario: { verify: nonconformVerifier() } });
    assert.equal(limited.result.stopKind, 'iteration_limit');
    assert.match(await fs.readFile(file, 'utf8'), /本文 3\n/);
    assert.ok(limited.result.writtenFiles.some((f) => f.path === 'SKILL.md' && !f.verified));
    const s2 = await setup(t, { fn });
    const file2 = path.join(s2.target.root, 'SKILL.md');
    const blocked = await runAuthor(t, { env: s2.env, args: args(s2.target), scenario: { verify: async () => null } });
    assert.equal(blocked.result.stopKind, 'blocked');
    assert.match(await fs.readFile(file2, 'utf8'), /本文 1\n/);
    assert.ok(blocked.result.writtenFiles.some((f) => f.path === 'SKILL.md' && !f.verified));
  });
}

for (const [fn, args] of FNS) {
  test(`SP-BPFINDINGS-007: 検証役が担当の資産ごとに「候補あり」「確認済みで問題なし」「判断できない」を返すと、資産ごとの判定がそのまま台帳に入り、候補ありの資産に候補が記録される${mark(fn)}`, async (t) => {
    const s = await setup(t, { fn });
    if (!s) return;
    const returned = new Map();
    const verify = async (prompt, options, env, call, calls) => {
      const result = await defaults.verify(prompt, options, env);
      if (options.label !== 'verifier:conformance' || iterationOf(call, calls) !== 1) return result;
      const ids = assetIds(prompt);
      assert.ok(ids.length >= 3, `担当の資産が 3 つ未満: ${ids}`);
      const values = ['candidate', 'ok', 'unsure'];
      result.judgements = ids.map((asset, i) => ({ asset, judgement: values[Math.min(i, 2)] }));
      const unit = result.units.find((u) => u.result === 'conform');
      const key = { asset: ids[0], viewpoint: 'conformance', kind: unit.unit };
      result.candidates = [{ ...key, quote: 'L1: 本文', content: '基準に反する', fix: '直す' }];
      Object.assign(unit, { result: 'nonconform', keys: [key] });
      for (const j of result.judgements) returned.set(j.asset, j.judgement);
      await writePayload(prompt, result);
      return result;
    };
    const { result } = await runAuthor(t, { env: s.env, args: args(s.target), scenario: { write: sectionsWrite, verify, refute: async () => ({ verdict: 'reject', reason: '当たらない' }) } });
    assert.equal(result.stopKind, 'complete', result.reason);
    const view = await viewOf(s.env, result.state);
    const item = view.stages.get('verify|1').items.find((id) => view.items.get(id).key.viewpoint === 'conformance');
    const seen = new Map(view.seen.filter((x) => x.item === item).map((x) => [x.asset, x.value]));
    assert.deepEqual(seen, returned);
    assert.deepEqual([...new Set(seen.values())].sort(), ['candidate', 'ok', 'unsure']);
    const candidate = view.candidates.filter((c) => c.item === item);
    assert.deepEqual(candidate.map((c) => c.key.asset), [...returned].filter(([, v]) => v === 'candidate').map(([a]) => a));
  });
}

for (const [fn, args] of FNS) {
  test(`SP-BPFINDINGS-013: 検証の段と追加の検証の段の重複でない全ての候補が、鍵ごとに 1 体の反証役の起動に渡り、反証役は候補を返した検証役と別の起動で、全ての検証役の後に起動される${mark(fn)}`, async (t) => {
    const s = await setup(t, { fn });
    if (!s) return;
    const verify = async (prompt, options, env, call, calls) => {
      const result = await defaults.verify(prompt, options, env);
      if (iterationOf(call, calls) !== 1 || !['verifier:conformance', 'verifier:goal', 'verifier:conformance:extra'].includes(options.label)) return result;
      const ids = assetIds(prompt);
      const { kinds } = await env.readFromPrompt(prompt, 'kinds');
      const viewpoint = options.label.split(':')[1];
      const asset = options.label === 'verifier:goal' ? ids.at(-1) : ids[0];
      if (options.label === 'verifier:conformance') result.judgements = result.judgements.filter((j) => j.asset !== ids.at(-1));
      result.judgements.find((j) => j.asset === asset).judgement = 'candidate';
      result.candidates = [{ asset, viewpoint, kind: kinds[0].value, quote: 'L1: 本文', content: 'c', fix: 'f' }];
      await writePayload(prompt, result);
      return result;
    };
    const { result, calls } = await runAuthor(t, { env: s.env, args: args(s.target), scenario: { write: sectionsWrite, verify, refute: async () => ({ verdict: 'reject', reason: '当たらない' }) } });
    assert.equal(result.stopKind, 'complete', result.reason);
    const view = await viewOf(s.env, result.state);
    const keyOf = (k) => JSON.stringify({ asset: k.asset, viewpoint: k.viewpoint, kind: k.kind });
    const round1 = (stage) => view.stages.get(`${stage}|1`)?.items ?? [];
    const firstItems = new Set([...round1('verify'), ...round1('verify-extra')]);
    const candidateKeys = [...new Set(view.candidates.filter((c) => firstItems.has(c.item)).map((c) => keyOf(c.key)))];
    assert.equal(candidateKeys.length, 3);
    assert.ok(view.candidates.some((c) => view.items.get(c.item).stage === 'verify-extra'));
    const refuters = calls.filter((c) => c.role === 'refute' && iterationOf(c, calls) === 1);
    const refutedKeys = refuters.map((c) => keyOf(JSON.parse(/指摘の鍵: (.+)/.exec(c.prompt)[1])));
    assert.deepEqual([...refutedKeys].sort(), [...candidateKeys].sort());
    const verifiersOf = calls.filter((c) => c.role === 'verify' && iterationOf(c, calls) === 1);
    for (const r of refuters) {
      assert.equal(r.label, 'refuter');
      assert.ok(!verifiersOf.some((v) => v.n === r.n));
      assert.ok(verifiersOf.every((v) => v.n < r.n));
    }
  });
}

for (const [fn, args] of FNS) {
  test(`SP-BPFINDINGS-005: 起動数の上限で検証の段の途中に止まった run の停止の間に対象スキルの節を 1 つ書き換えて再開すると、その節の資産が台帳で新しい内容の指紋になり、検証を終えた観点の skip 一覧に戻って追加の検証の担当になる${mark(fn)}`, async (t) => {
    const s = await setup(t, { fn });
    if (!s) return;
    const limit = MIN_LAUNCHES[fn];
    const first = await runAuthor(t, { env: s.env, args: args(s.target, { maxLaunches: limit }), maxAgents: limit, concurrency: 1, scenario: { write: sectionsWrite } });
    assert.equal(first.result.stopKind, 'iteration_limit');
    const v1 = await viewOf(s.env, first.result.state);
    const items = v1.stages.get('verify|1').items.map((id) => v1.items.get(id));
    const done = items.filter((i) => i.result !== undefined).map((i) => i.key.viewpoint);
    assert.ok(done.length > 0 && done.length < items.length, `${done}`);
    const changed = [...v1.assets.values()].find((a) => JSON.stringify(a.loc).includes('手順'));
    await editFile(path.join(s.target.root, 'SKILL.md'), (x) => x.replace('手順の本文', '手順の本文を書き換えた'));
    const second = await runAuthor(t, { env: s.env, args: resumeArgs(first.result) });
    assert.equal(second.result.stopKind, 'complete', second.result.reason);
    const v2 = await viewOf(s.env, first.result.state);
    assert.notEqual(v2.assets.get(changed.id).digest, changed.digest);
    const extras = second.calls.filter((c) => c.label.endsWith(':extra'));
    assert.deepEqual(extras.map((c) => c.label), done.map((v) => `verifier:${v}:extra`));
    for (const c of extras) assert.deepEqual(assetIds(c.prompt), [changed.id]);
  });
}

for (const [fn, args] of FNS) {
  test(`SP-BPAUTHORING-030・SP-BPAUTHORING-023: 未反証の候補・skip 一覧の残り・判定できない指摘のそれぞれで、反復の上限でなく BLOCKED で止まり、理由に当たった候補・資産・指摘 ID を書く${mark(fn)}`, async (t) => {
    const a = await setup(t, { fn });
    if (!a) return;
    // 反証の段の全ての項目が打ち切りになると反証の段で止まり合否に着かないので、目標の観点の候補だけを未反証にする。
    const both = async (prompt, options, env) => {
      const result = await defaults.verify(prompt, options, env);
      if (options.label.endsWith(':extra') || !['verifier:conformance', 'verifier:goal'].includes(options.label)) return result;
      const asset = assetIds(prompt)[0];
      const { kinds } = await env.readFromPrompt(prompt, 'kinds');
      result.judgements[0].judgement = 'candidate';
      result.candidates = [{ asset, viewpoint: options.label.split(':')[1], kind: kinds[0].value, quote: 'L1: 本文', content: 'c', fix: 'f' }];
      await writePayload(prompt, result);
      return result;
    };
    const refute = async (prompt) => (prompt.includes('"viewpoint":"goal"') ? null : { verdict: 'reject', reason: '当たらない' });
    const unrefuted = await runAuthor(t, { env: a.env, args: args(a.target), scenario: { verify: both, refute } });
    assert.equal(unrefuted.result.stopKind, 'blocked', unrefuted.result.reason);
    const left = unrefuted.result.verification.decision.unverifiable.unrefuted;
    assert.ok(left.length > 0);
    assert.match(unrefuted.result.reason, /未反証の候補: /);
    assert.deepEqual(left.map((k) => k.viewpoint), ['goal']);
    for (const k of left) assert.ok(unrefuted.result.reason.includes(`${k.asset}/${k.viewpoint}/${k.kind}`), JSON.stringify(k));

    const b = await setup(t, { fn });
    const blind = async (prompt, options, env) => {
      if (!options.label.startsWith('verifier:goal')) return defaults.verify(prompt, options, env);
      const empty = { judgements: [], candidates: [], basisConstraints: [] };
      await writePayload(prompt, empty);
      return empty;
    };
    const skipped = await runAuthor(t, { env: b.env, args: args(b.target), scenario: { verify: blind } });
    assert.equal(skipped.result.stopKind, 'blocked');
    const skipAssets = skipped.result.verification.ledger.skip.find((x) => x.viewpoint === 'goal').assets.map((x) => x.id ?? x);
    assert.ok(skipAssets.length > 0);
    assert.match(skipped.result.reason, /skip 一覧に残った資産: goal=/);
    for (const id of skipAssets) assert.ok(skipped.result.reason.includes(id), id);

    const c = await setup(t, { fn });
    const limited = await runAuthor(t, { env: c.env, args: args(c.target), scenario: { verify: nonconformVerifier() } });
    assert.equal(limited.result.stopKind, 'iteration_limit');
    const unsure = async (prompt, options, env) => {
      const result = await defaults.verify(prompt, options, env);
      if (options.label !== 'verifier:conformance') return result;
      result.judgements[0].judgement = 'unsure';
      await writePayload(prompt, result);
      return result;
    };
    const resumed = await runAuthor(t, { env: c.env, args: resumeArgs(limited.result), scenario: { verify: unsure } });
    assert.equal(resumed.result.stopKind, 'blocked');
    const unknown = resumed.result.verification.decision.unverifiable.findings;
    assert.equal(unknown.length, 1);
    const view = await viewOf(c.env, limited.result.state);
    assert.equal(view.findings.get(unknown[0]).judgements.at(-1).value, 'unknown');
    assert.match(resumed.result.reason, /検証が成り立たない指摘: /);
    assert.ok(resumed.result.reason.includes(unknown[0]));
    for (const r of [unrefuted, skipped, resumed]) assert.equal(r.result.verification.decision.value, 'unverifiable');
  });
}

// 候補を 3 件（適合の観点 2 件・目標の観点 1 件）返し、反証役は全て却下する。反証の項目が 2 つ以上あり、上限が途中の項目に当たる run を作るため。
function threeCandidates() {
  return async (prompt, options, env, call, calls) => {
    const result = await defaults.verify(prompt, options, env);
    const viewpoint = options.label.split(':')[1];
    if (options.label.endsWith(':extra') || iterationOf(call, calls) !== 1 || !['conformance', 'goal'].includes(viewpoint)) return result;
    const { kinds } = await env.readFromPrompt(prompt, 'kinds');
    const ids = assetIds(prompt);
    const take = viewpoint === 'conformance' ? ids.slice(0, 2) : ids.slice(-1);
    result.candidates = take.map((asset) => ({ asset, viewpoint, kind: kinds[0].value, quote: 'L1: 本文', content: 'c', fix: 'f' }));
    for (const j of result.judgements) if (take.includes(j.asset)) j.judgement = 'candidate';
    await writePayload(prompt, result);
    return result;
  };
}

// 検証の段の検証役が担当の先頭の資産だけを判定し、残りを全ての観点の skip 一覧に残す。
function judgeFirstOnly() {
  return async (prompt, options, env) => {
    const result = await defaults.verify(prompt, options, env);
    if (options.label.endsWith(':extra')) return result;
    result.judgements = result.judgements.slice(0, 1);
    await writePayload(prompt, result);
    return result;
  };
}

for (const [fn, args] of FNS) {
  test(`SP-BPAUTHORING-041・SP-BPRUN-020: 起動数の上限で止めた run の反証の段と追加の検証の段の未着手の項目が、表の段ごとの順位（反証は鍵の最初の候補を返した検証の項目の順と項目の中の候補の順、追加の検証は観点の順）の後ろの項目として残り、再開がその順に処理する。消えた資産の照合の段の項目は指摘を台帳に作った順に並ぶ${mark(fn)}`, async (t) => {
    const probe = await setup(t, { fn });
    if (!probe) return;
    const refuteRefuser = async () => ({ verdict: 'reject', reason: '当たらない' });
    const refute = await limitStoppingAt(t, fn, args, 'refute', () => ({ verify: threeCandidates(), refute: refuteRefuser }));
    assert.ok(refute, '反証の段で止まる上限が無い');
    const rv = refute.view;
    const keyOf = (k) => JSON.stringify({ asset: k.asset, viewpoint: k.viewpoint, kind: k.kind });
    const verifyOrder = rv.stages.get('verify|1').items;
    const expected = [];
    for (const item of verifyOrder) for (const c of rv.candidates.filter((x) => x.item === item)) if (!expected.includes(keyOf(c.key))) expected.push(keyOf(c.key));
    const refuteItems = rv.stages.get('refute|1').items;
    assert.deepEqual(refuteItems.map((id) => keyOf(rv.items.get(id).key)), expected);
    const rStop = rv.stops.get('r1');
    assert.ok(rStop.pending.length > 0);
    assert.deepEqual(rStop.pending, refuteItems.slice(refuteItems.length - rStop.pending.length));
    const rResumed = await runAuthor(t, { env: refute.s.env, args: resumeArgs(refute.run.result), scenario: { refute: refuteRefuser } });
    const relaunched = rResumed.calls.filter((c) => c.role === 'refute' && iterationOf(c, rResumed.calls) === 0).map((c) => keyOf(JSON.parse(/指摘の鍵: (.+)/.exec(c.prompt)[1])));
    assert.deepEqual(relaunched, rStop.pending.map((id) => keyOf(rv.items.get(id).key)));

    const extra = await limitStoppingAt(t, fn, args, 'verify-extra', () => ({ verify: judgeFirstOnly() }));
    assert.ok(extra, '追加の検証の段で止まる上限が無い');
    const ev = extra.view;
    const extraItems = ev.stages.get('verify-extra|1').items;
    assert.deepEqual(extraItems.map((id) => ev.items.get(id).key.viewpoint), VIEWPOINT_ORDER[fn].slice(0, extraItems.length));
    const eStop = ev.stops.get('r1');
    assert.ok(eStop.pending.length > 0);
    assert.deepEqual(eStop.pending, extraItems.slice(extraItems.length - eStop.pending.length));

    const v = await setup(t, { fn: 'update', files: VANISH_FILES });
    const two = async (prompt, options, env, call, calls) => {
      const result = await defaults.verify(prompt, options, env);
      const viewpoint = options.label.split(':')[1];
      if (iterationOf(call, calls) !== 1 || options.label.endsWith(':extra') || !['conformance', 'goal'].includes(viewpoint)) return result;
      const { assets } = await env.readFromPrompt(prompt, 'report');
      const gone = assets.find((x) => JSON.stringify(x.loc).includes('消す節')).id;
      const { kinds } = await env.readFromPrompt(prompt, 'kinds');
      result.judgements.find((j) => j.asset === gone).judgement = 'candidate';
      result.candidates = [{ asset: gone, viewpoint, kind: kinds[0].value, quote: 'L8: 中身', content: 'c', fix: 'f' }];
      await writePayload(prompt, result);
      return result;
    };
    const vanished = await runAuthor(t, { env: v.env, args: updateArgs(v.target), scenario: { write: vanishScenario(v.target.root).write, verify: two } });
    assert.equal(vanished.result.stopKind, 'complete', vanished.result.reason);
    const vv = await viewOf(v.env, vanished.result.state);
    const vanishItems = [...vv.stages.entries()].filter(([k]) => k.startsWith('vanish|')).flatMap(([, st]) => st.items);
    assert.equal(vanishItems.length, 2);
    const byOrder = [...vv.findings.values()].sort((x, y) => x.order - y.order).map((f) => f.id);
    assert.deepEqual(vanishItems.map((id) => vv.items.get(id).key.finding), byOrder);
  });
}
