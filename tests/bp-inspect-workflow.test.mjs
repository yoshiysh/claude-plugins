import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  INSPECT_FILES, MIN_LAUNCHES, REPO_ROOT, SKILL_DIR, assetIds, bundleAssets, candidateVerifier, commands, failCarrier, inspectArgs, inspectDefaults,
  logOf, resumeArgs, runInspect, setupInspect, stagesIn, viewOf, viewpointOf, writePayload,
} from './helpers/bp-harness.mjs';
import { OPS, RESULT_KEYS, ROLE_WRITE_LIMITS } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { targetFingerprint } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/fingerprint.mjs';

const FNS = ['review', 'audit'];
const VIEWPOINTS = { review: ['flow', 'spec'], audit: ['audit'] };
const mark = (fn) => `［${fn}］`;
const agents = (calls) => calls.filter((c) => c.role !== 'carrier');
const itemOfPrompt = (prompt) => /\/([^/\s]+)\.a\d+\.json/.exec(prompt)[1];

function compose(...carriers) {
  return async (...a) => {
    for (const c of carriers) {
      const out = await c(...a);
      if (out !== undefined) return out;
    }
    return undefined;
  };
}
const verifiers = (calls) => calls.filter((c) => c.role === 'verify');

function opsOf(calls) {
  return calls.filter((c) => c.role === 'carrier').flatMap((c) => commands(c.prompt).map((x) => x.op));
}

async function editFile(file, edit) {
  await fs.writeFile(file, edit(await fs.readFile(file, 'utf8')));
}

for (const fn of FNS) {
  test(`SP-BPINSPECTION-001・SP-BPRUN-001・SP-BPFINDINGS-001・SP-BPRUN-024・SP-BPRUN-040: 段を表の順に 1 回ずつ進め、台帳を最初の検証の前に作り、1 つの機能だけを実行して完了する${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const verify = candidateVerifier({ viewpoint: VIEWPOINTS[fn][0], when: (p, calls) => verifiers(calls).length === 1 });
    const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { verify } });
    assert.equal(result.stopKind, 'complete', result.reason);
    const lines = await logOf(s.env, result.state);
    const want = fn === 'review' ? ['targets', 'bundle', 'assign', 'applicability', 'verify', 'refute', 'close'] : ['targets', 'bundle', 'assign', 'verify', 'refute', 'close'];
    assert.deepEqual(stagesIn(lines), want);
    assert.equal(lines[0].records[0].function, fn);
    assert.ok(lines.every((l) => l.run === 'r1'));
    const ledger = lines.findIndex((l) => l.op === OPS.ledgerCreate);
    const firstVerdict = lines.findIndex((l) => l.op === OPS.verdicts);
    assert.ok(ledger >= 0 && ledger < firstVerdict);
    const order = agents(calls).map((c) => c.role);
    assert.deepEqual([...new Set(order)], fn === 'review' ? ['extract', 'applicability', 'verify', 'refute'] : ['extract', 'verify', 'refute']);
    const refuter = calls.find((c) => c.role === 'refute');
    assert.ok(verifiers(calls).every((v) => v.n < refuter.n));
    assert.equal(verifiers(calls).length, VIEWPOINTS[fn].length * 2);
  });

  test(`SP-BPINSPECTION-001・SP-BPRUN-027・SP-BPRUN-030・SP-BPRUN-010: 抽出役が結果を返さないと BLOCKED になり、理由に段・役・失敗の内容がある${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { extract: async () => null } });
    assert.equal(result.stopKind, 'blocked');
    assert.match(result.reason, /段「担当の作成」の抽出役が結果を返さなかった/);
    assert.equal(verifiers(calls).length, 0);
    assert.deepEqual(result.nextArgs, { function: fn, state: result.state });
  });

  test(`SP-BPINSPECTION-001・SP-BPRUN-028・SP-BPRUN-029・SP-BPFINDINGS-034: 検証の項目の 1 件の欠けと台帳に無い資産 ID の結果では run が止まらず試行を繰り返し、試行の上限で打ち切る${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    let target = null;
    let n = 0;
    const verify = async (prompt) => {
      target = target ?? itemOfPrompt(prompt);
      if (itemOfPrompt(prompt) === target) n += 1;
      if (itemOfPrompt(prompt) === target && n === 1) return null;
      if (itemOfPrompt(prompt) === target && n === 2) {
        const bad = { judgements: [{ asset: 'ANOPE', judgement: 'ok' }], candidates: [], unchecked: [] };
        await writePayload(prompt, bad);
        return bad;
      }
      return inspectDefaults.verify(prompt);
    };
    const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { verify } });
    assert.equal(result.stopKind, 'complete', result.reason);
    const view = await viewOf(s.env, result.state);
    assert.equal(view.items.get(target).fails.length, 2);
    assert.ok(view.items.get(target).result);
    assert.equal(verifiers(calls).filter((c) => itemOfPrompt(c.prompt) === target).length, 3);
    assert.equal(result.ledger.rejected.count, 1);
    const s2 = await setupInspect(t);
    const aborted = await runInspect(t, { env: s2.env, args: inspectArgs(fn, s2.target), scenario: { verify: async () => null } });
    assert.equal(aborted.result.stopKind, 'blocked');
    assert.match(aborted.result.reason, /試行の上限で打ち切り/);
    const v2 = await viewOf(s2.env, aborted.result.state);
    assert.ok([...v2.items.values()].filter((i) => i.stage === 'verify').every((i) => i.aborted && i.fails.length === 3));
    assert.equal(v2.stops.get('r1').cause, 'verifiers');
  });

  test(`SP-BPINSPECTION-002: 候補のある結果を返しても、観点ごとの検証より前の段の起動が再び起きない${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const verify = candidateVerifier({ viewpoint: VIEWPOINTS[fn][0] });
    const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { verify } });
    assert.equal(result.stopKind, 'complete', result.reason);
    const rank = { extract: 0, applicability: 1, verify: 2, refute: 3 };
    const seq = agents(calls).map((c) => rank[c.role]);
    assert.deepEqual(seq, [...seq].sort((a, b) => a - b));
    assert.ok(result.findings.length > 0);
  });

  test(`SP-BPINSPECTION-003: 検証の項目の観点が機能の観点の集合だけである${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target) });
    assert.equal(result.stopKind, 'complete', result.reason);
    assert.deepEqual([...new Set(verifiers(calls).map((c) => viewpointOf(c.prompt)))], VIEWPOINTS[fn]);
    const view = await viewOf(s.env, result.state);
    assert.deepEqual([...new Set([...view.items.values()].filter((i) => i.stage === 'verify').map((i) => i.key.viewpoint))], VIEWPOINTS[fn]);
  });

  test(`SP-BPINSPECTION-019・SP-BPRUN-032: 結果の項目が CLI の outcome の出力と逐語で同じで、運搬役・抽出役・検証役・反証役の外の役を起動しない${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { verify: candidateVerifier({ viewpoint: VIEWPOINTS[fn][0] }) } });
    const again = await s.env.request(OPS.outcome, { state: result.state });
    assert.deepEqual(result, again);
    assert.deepEqual([...new Set(calls.map((c) => c.role))].sort(), (fn === 'review' ? ['applicability', 'carrier', 'extract', 'refute', 'verify'] : ['carrier', 'extract', 'refute', 'verify']).sort());
    for (const key of Object.keys(result)) assert.ok(['ok', 'op', 'sum', ...Object.values(RESULT_KEYS)].includes(key), key);
  });

  test(`SP-BPINSPECTION-022: 入口が渡したパスの一覧が逐語で開始の操作に渡り、run の中でパスの一覧の作成と取り直しが呼ばれない${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const target = { root: s.target.root, files: [] };
    const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs(fn, target) });
    assert.equal(result.stopKind, 'complete', result.reason);
    const start = commands(calls[0].prompt)[0];
    assert.deepEqual(JSON.parse(start.text).target, target);
    assert.ok(!opsOf(calls).some((op) => op === OPS.paths || op === OPS.pathsRetake));
  });

  test(`SP-BPINSPECTION-026・SP-BPRUN-011・SP-BPRUN-032: 存在しないパスと SKILL.md の無いディレクトリで、開始の運搬役の後に agent を起動せず、状態を作らず、BLOCKED と理由を返し next_args が無い${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const missing = path.join(s.base, 'none');
    const noSkill = path.join(s.base, 'empty');
    await fs.mkdir(noSkill);
    for (const [root, reason] of [[missing, /ディレクトリが無い/], [noSkill, /SKILL\.md が無い/]]) {
      const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs(fn, { root }) });
      assert.equal(result.stopKind, 'blocked');
      assert.match(result.reason, reason);
      assert.ok(result.reason.includes(root));
      assert.equal(result.nextArgs, undefined);
      assert.equal(result.state, undefined);
      assert.deepEqual(calls.map((c) => c.role), ['carrier']);
    }
    const states = await fs.readdir(path.join(s.env.root, 'states')).catch(() => []);
    assert.deepEqual(states.filter((d) => !d.startsWith('.')), []);
  });

  test(`SP-BPRUN-008・SP-BPINSPECTION-020: run が対象スキルに書き込まず、書いたファイルの記録の要求を送らない${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const before = await targetFingerprint({ root: s.target.root, files: [] });
    const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { verify: candidateVerifier({ viewpoint: VIEWPOINTS[fn][0] }) } });
    assert.equal(result.stopKind, 'complete', result.reason);
    assert.deepEqual(await targetFingerprint({ root: s.target.root, files: [] }), before);
    assert.ok(!opsOf(calls).some((op) => [OPS.files, OPS.filesScan, OPS.snapshot, OPS.goalCheck, OPS.gate, OPS.reviewJudge].includes(op)));
    assert.equal(result.writtenFiles, undefined);
  });

  test(`SP-BPRUN-025・SP-BPRUN-012・SP-BPRUN-032: 書き手を起動せず、確かめられなかった役ごとの制限に書き手以外の行が載り、書いたファイルの一覧を返さない${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const done = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target) });
    assert.deepEqual(done.result.unverifiedRoleLimits, ROLE_WRITE_LIMITS.filter((r) => r.role !== '書き手'));
    assert.ok(!done.calls.some((c) => c.label.startsWith('writer')));
    const s2 = await setupInspect(t);
    const blocked = await runInspect(t, { env: s2.env, args: inspectArgs(fn, s2.target), scenario: { extract: async () => null } });
    assert.deepEqual(blocked.result.unverifiedRoleLimits, done.result.unverifiedRoleLimits);
    assert.equal(blocked.result.writtenFiles, undefined);
    assert.equal(blocked.result.stoppedStage, '担当の作成');
  });

  test(`SP-BPRUN-026: run の中で対象スキルを変えると、BLOCKED と変わったパスを返し、完了を返さない${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const verify = async (prompt) => {
      await fs.appendFile(path.join(s.target.root, 'SKILL.md'), '\n足した行\n');
      return inspectDefaults.verify(prompt);
    };
    const { result } = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { verify } });
    assert.equal(result.stopKind, 'blocked');
    assert.match(result.reason, /run の中で対象スキルが変わった: SKILL\.md/);
    const view = await viewOf(s.env, result.state);
    assert.equal(view.stops.get('r1').requested.kind, 'complete');
  });

  test(`SP-BPRUN-034・SP-BPRUN-023: 停止の記録の起動数が backend の呼び出しの数と一致し、全ての起動が役の model と effort を持つ${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { verify: candidateVerifier({ viewpoint: VIEWPOINTS[fn][0] }) } });
    assert.equal(result.launches, calls.length);
    assert.equal((await viewOf(s.env, result.state)).stops.get('r1').launches, calls.length);
    const want = { carrier: ['haiku', 'low'], extract: ['sonnet', 'medium'], applicability: ['opus', 'high'], verify: ['opus', 'high'], refute: ['opus', 'high'] };
    for (const c of calls) assert.deepEqual([c.model, c.effort], want[c.role], c.label);
  });

  test(`SP-BPRUN-037・SP-BPRUN-021: 最小に 1 足りない上限では agent を 1 体も起動せず、最小と同じ上限では最初の検証の項目まで進む${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const short = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target, { maxLaunches: MIN_LAUNCHES[fn] - 1 }) });
    assert.equal(short.result.stopKind, 'blocked');
    assert.equal(short.calls.length, 0);
    assert.match(short.result.reason, new RegExp(`最小の起動数 ${MIN_LAUNCHES[fn]}`));
    const exact = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target, { maxLaunches: MIN_LAUNCHES[fn] }) });
    assert.ok(verifiers(exact.calls).length >= 1);
    assert.ok(exact.result.launches <= MIN_LAUNCHES[fn]);
  });

  test(`SP-BPRUN-037: 0・小数・文字列の上限で agent() を 0 回呼び、BLOCKED と渡された値を返し、状態が変わらない${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    for (const bad of [0, 1.5, '40']) {
      const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target, { maxLaunches: bad }) });
      assert.equal(result.stopKind, 'blocked');
      assert.equal(calls.length, 0);
      assert.ok(result.reason.includes(JSON.stringify(bad)));
    }
    assert.deepEqual((await fs.readdir(path.join(s.env.root, 'states')).catch(() => [])).filter((d) => !d.startsWith('.')), []);
  });

  test(`SP-BPRUN-021: 最悪の経路で、開始は 2 回、担当の作成と適用の判定は 1 回あたり 2 回・試行の上限まで、最初の fan-out の項目は 15 回起動し、最小の起動数ちょうどの上限で最初の検証の項目を始められる${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    let extracts = 0;
    let applies = 0;
    const scenario = {
      extract: async (prompt) => ((extracts += 1) < 3 ? { groups: [['ANOPE']] } : inspectDefaults.extract(prompt)),
      applicability: async (prompt) => {
        applies += 1;
        if (applies >= 3) return inspectDefaults.applicability(prompt);
        const r = await inspectDefaults.applicability(prompt);
        r.answers.Q2.answer = 'はい';
        return r;
      },
      verify: async (prompt) => {
        const bad = { judgements: [{ asset: 'ANOPE', judgement: 'ok' }], candidates: [], unchecked: [] };
        await writePayload(prompt, bad);
        return bad;
      },
      carrier: (() => {
        const seen = new Set();
        return async (prompt, options, env) => {
          const out = await env.carry(prompt);
          if ([' start <<', ' verdicts <<', ' item-fail <<'].some((op) => prompt.includes(op)) && !seen.has(prompt)) { seen.add(prompt); return null; }
          return out;
        };
      })(),
    };
    const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target, { maxLaunches: MIN_LAUNCHES[fn] }), scenario });
    assert.equal(calls.filter((c) => c.prompt.includes(' start <<')).length, 2);
    assert.equal(calls.filter((c) => c.role === 'extract').length, 3);
    assert.equal(calls.filter((c) => c.role === 'applicability').length, fn === 'review' ? 3 : 0);
    const first = calls.indexOf(verifiers(calls)[0]);
    assert.equal(first, MIN_LAUNCHES[fn] - 15 - 1);
    assert.equal(calls.slice(first, -1).length, 15);
    assert.equal(new Set(verifiers(calls).map((c) => itemOfPrompt(c.prompt))).size, 1);
    assert.equal(result.launches, MIN_LAUNCHES[fn]);
    assert.equal(result.stopKind, 'iteration_limit');
  });

  test(`SP-BPRUN-020・SP-BPRUN-040: 上限を渡さない run は項目を切らず、上限を渡した run の起動数は同時実行 3 でも上限以下で、予約分の停止の運搬役が起動できる${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const free = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target) });
    assert.equal(free.result.stopKind, 'complete');
    assert.equal(verifiers(free.calls).length, VIEWPOINTS[fn].length * 2);
    const limit = MIN_LAUNCHES[fn] + 3;
    const capped = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target, { maxLaunches: limit }) });
    assert.ok(capped.calls.length <= limit);
    assert.equal(capped.result.stopKind, 'iteration_limit');
    assert.match(capped.result.reason, /起動数の上限/);
    assert.ok(capped.calls.at(-1).prompt.includes(' stop <<'));
  });

  test(`SP-BPRUN-022・SP-BPRUN-014・SP-BPRUN-033・SP-BPRUN-003・SP-BPRUN-035・SP-BPINSPECTION-016・SP-BPFINDINGS-026: 起動数の上限で止めた run の未着手の項目が観点の順・担当の順で残り、next_args だけの再開が未着手の項目だけを順位の順に処理し、前の run の見たと指摘が結果に載る${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    const verify = candidateVerifier({ viewpoint: VIEWPOINTS[fn][0], when: (p, calls) => verifiers(calls).length === 1 });
    const first = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target, { maxLaunches: MIN_LAUNCHES[fn] }), scenario: { verify } });
    assert.equal(first.result.stopKind, 'iteration_limit');
    assert.deepEqual(first.result.nextArgs, { function: fn, state: first.result.state });
    const view = await viewOf(s.env, first.result.state);
    const entry = view.stages.get('verify|');
    const keys = entry.items.map((id) => view.items.get(id).key);
    assert.deepEqual(keys, VIEWPOINTS[fn].flatMap((viewpoint) => [1, 2].map((group) => ({ viewpoint, group }))));
    const pending = view.stops.get('r1').pending;
    assert.deepEqual(pending, entry.items.filter((id) => !view.items.get(id).result));
    assert.ok(pending.length >= 1);
    const second = await runInspect(t, { env: s.env, args: resumeArgs(first.result) });
    assert.equal(second.result.stopKind, 'complete', second.result.reason);
    assert.equal(second.result.run, 'r2');
    assert.equal(second.calls.filter((c) => c.role === 'extract' || c.role === 'applicability').length, 0);
    assert.deepEqual(verifiers(second.calls).map((c) => itemOfPrompt(c.prompt)), pending);
    const after = await viewOf(s.env, first.result.state);
    for (const id of pending) assert.ok(after.items.get(id).result, id);
    const seenRuns = new Set(after.seen.map((x) => after.lineRuns.get(x.line)));
    assert.deepEqual([...seenRuns].sort(), ['r1', 'r2']);
    const fromFirst = after.candidates.filter((c) => after.lineRuns.get(c.line) === 'r1').map((c) => JSON.stringify(c.key));
    assert.equal(fromFirst.length, 1);
    assert.ok(second.result.findings.some((f) => JSON.stringify({ asset: f.assets[0].id, viewpoint: f.viewpoint, kind: f.kind }) === fromFirst[0]));
    assert.equal(after.runs.at(-1).id, 'r2');
  });

  test(`SP-BPINSPECTION-018・SP-BPFINDINGS-013・SP-BPFINDINGS-025・SP-BPFINDINGS-007: どの組にも入らない資産が skip 一覧に残って追加の起動の担当になり、追加の起動の候補も含めて重複でない鍵ごとに反証役が 1 体、全ての検証の後に起動される${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    let left = null;
    const extract = async (prompt) => {
      const assets = await bundleAssets(prompt);
      left = assets.find((a) => a.path === 'SKILL.md' && assets.filter((b) => b.path === 'SKILL.md').indexOf(a) === 2).id;
      return { groups: [assets.filter((a) => a.id !== left && a.path === 'SKILL.md').map((a) => a.id), assets.filter((a) => a.path !== 'SKILL.md').map((a) => a.id)] };
    };
    const verify = async (prompt, options, env, call, calls) => {
      const ids = assetIds(prompt);
      const extra = options.label.endsWith(':extra');
      const fnVerify = candidateVerifier({ viewpoint: VIEWPOINTS[fn][0], asset: (x) => (extra ? left : x[0]), when: () => extra || /担当 ID: Sassign1/.test(prompt) });
      const out = await fnVerify(prompt, options, env, call, calls);
      if (!extra && ids.length > 1) {
        out.judgements[1].judgement = 'unsure';
        await writePayload(prompt, out);
      }
      return out;
    };
    const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { extract, verify } });
    assert.equal(result.stopKind, 'complete', result.reason);
    const extras = calls.filter((c) => c.label.endsWith(':extra'));
    assert.equal(extras.length, VIEWPOINTS[fn].length);
    for (const c of extras) assert.deepEqual(assetIds(c.prompt), [left]);
    const refuters = calls.filter((c) => c.role === 'refute');
    const keys = refuters.map((c) => /指摘の鍵: (.+)/.exec(c.prompt)[1]);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(refuters.length, 2);
    assert.ok(keys.some((k) => k.includes(left)));
    const lastVerify = verifiers(calls).at(-1);
    assert.ok(refuters.every((r) => r.n > lastVerify.n));
    const view = await viewOf(s.env, result.state);
    assert.deepEqual([...new Set(view.seen.map((x) => x.value))].sort(), ['candidate', 'ok', 'unsure']);
    assert.deepEqual(result.ledger.skip.map((x) => x.assets.length), VIEWPOINTS[fn].map(() => 0));
  });

  test(`SP-BPFINDINGS-012・SP-BPINSPECTION-015: 同じ資産を 2 つの組に入れ、2 体の検証役が同じ鍵の候補を返すと、反証役が 1 回だけ起動され、結果が 2 件の候補の両方に当たる${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    let shared = null;
    const extract = async (prompt) => {
      const assets = await bundleAssets(prompt);
      shared = assets[0].id;
      return { groups: [assets.map((a) => a.id), [shared]] };
    };
    const verify = candidateVerifier({ viewpoint: VIEWPOINTS[fn][0], asset: () => shared });
    const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { extract, verify } });
    assert.equal(result.stopKind, 'complete', result.reason);
    assert.equal(calls.filter((c) => c.role === 'refute').length, 1);
    const view = await viewOf(s.env, result.state);
    assert.equal(view.candidates.length, 2);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].state, 'open');
  });

  test(`SP-BPINSPECTION-015・SP-BPFINDINGS-034: 抽出役が一覧に無い資産 ID を返すと組が拒否されて起動し直し、途中の回で受理されると run が続き、試行の上限の回まで拒否されると BLOCKED になる${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    let n = 0;
    const extract = async (prompt) => ((n += 1) === 1 ? { groups: [['ANOPE']] } : inspectDefaults.extract(prompt));
    const ok = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { extract } });
    assert.equal(ok.result.stopKind, 'complete', ok.result.reason);
    const prompts = ok.calls.filter((c) => c.role === 'extract').map((c) => c.prompt);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /前の回に拒否された理由:\n.*ANOPE/);
    assert.equal(ok.result.ledger.rejected.count, 1);
    const s2 = await setupInspect(t);
    const bad = await runInspect(t, { env: s2.env, args: inspectArgs(fn, s2.target), scenario: { extract: async () => ({ groups: [['ANOPE']] }) } });
    assert.equal(bad.result.stopKind, 'blocked');
    assert.match(bad.result.reason, /試行の上限 3 回まで拒否された/);
    assert.equal(bad.calls.filter((c) => c.role === 'extract').length, 3);
    assert.equal(verifiers(bad.calls).length, 0);
  });

  test(`SP-BPRUN-018・SP-BPRUN-038・SP-BPRUN-015・SP-BPRUN-027: 段の途中で停止の記録を書かずに終わった run を再開すると、列挙した項目のうち結果の無いものだけが処理される${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    let lostItem = null;
    const items = [];
    const verdicts = async (prompt) => {
      if (!prompt.includes(' verdicts <<')) return undefined;
      const item = /"item":"([^"]+)"/.exec(prompt)[1];
      if (!items.includes(item)) items.push(item);
      lostItem = lostItem ?? (items.length === 2 ? item : null);
      return item === lostItem ? null : undefined;
    };
    const carrier = compose(verdicts, failCarrier(OPS.stop));
    const first = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario: { carrier } });
    assert.equal(first.result.stopKind, 'blocked');
    assert.match(first.result.reason, /停止の記録を書けなかった/);
    assert.deepEqual(first.result.nextArgs, { function: fn, state: first.result.state });
    const view = await viewOf(s.env, first.result.state);
    assert.equal(view.stops.size, 0);
    const entry = view.stages.get('verify|');
    const undone = entry.items.filter((id) => !view.items.get(id).result);
    assert.ok(undone.length >= 1);
    const second = await runInspect(t, { env: s.env, args: resumeArgs(first.result) });
    assert.equal(second.result.stopKind, 'complete', second.result.reason);
    assert.deepEqual(verifiers(second.calls).map((c) => itemOfPrompt(c.prompt)), undone);
  });

  test(`SP-BPFINDINGS-030・SP-BPINSPECTION-024: 完了の結果に表の項目が全て載り、dismissed の指摘も指摘の一覧にある${mark(fn)}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    let refutes = 0;
    const scenario = {
      verify: candidateVerifier({ viewpoint: VIEWPOINTS[fn][0] }),
      refute: async () => ((refutes += 1) === 1 ? { verdict: 'reject', reason: '基準に反しない' } : { verdict: 'uphold', reason: '維持' }),
    };
    const { result } = await runInspect(t, { env: s.env, args: inspectArgs(fn, s.target), scenario });
    assert.equal(result.stopKind, 'complete', result.reason);
    const RUN = readFileSync(path.join(REPO_ROOT, 'docs', 'specifications', 'bp-findings.md'), 'utf8');
    const table = RUN.slice(RUN.indexOf('| 項目 | review・audit の綴り | 中身 |')).split('\n').slice(2).filter((l) => l.startsWith('|'));
    for (const key of new Set(table.flatMap((l) => [...l.split('|')[2].matchAll(/`(\w+)`/g)].map((m) => m[1])))) assert.ok(Object.hasOwn(result, key), key);
    assert.deepEqual(Object.keys(result.ledger).sort(), ['coverage', 'outcomes', 'rejected', 'skip', 'unrefuted']);
    assert.ok(Array.isArray(result.uncheckedViewpoints));
    const states = result.findings.map((f) => f.state).sort();
    assert.deepEqual(states, ['dismissed', 'open']);
    assert.equal(result.findings.find((f) => f.state === 'dismissed').dismissReason, '基準に反しない');
    assert.deepEqual(result.targets.map((x) => x.viewpoint), VIEWPOINTS[fn]);
  });
}

test('SP-BPINSPECTION-005: 仕様の観点を読めない review で、仕様の観点の検証役が起動されず、未検査の観点に全体が 1 件載り、仕様の観点の skip 一覧と追加の起動が無い', async (t) => {
  const s = await setupInspect(t);
  if (!s) return;
  await editFile(path.join(s.criteriaDir, 'specifications', 'bp-conformance.md'), (x) => x.replace('## 性能・容量（対象スキルに課す確定値）', '## 容量'));
  const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs('review', s.target), scenario: { extract: async (p) => ({ groups: [(await bundleAssets(p)).slice(0, 1).map((a) => a.id)] }) } });
  assert.equal(result.stopKind, 'complete', result.reason);
  assert.ok(!verifiers(calls).some((c) => viewpointOf(c.prompt) === 'spec'));
  assert.equal(result.uncheckedViewpoints.filter((u) => u.viewpoint === 'spec').length, 1);
  assert.equal(result.uncheckedViewpoints.find((u) => u.viewpoint === 'spec').scope, 'whole');
  assert.deepEqual(result.ledger.skip.map((x) => x.viewpoint), ['flow']);
  assert.deepEqual(result.ledger.coverage.map((x) => x.viewpoint), ['flow']);
  assert.ok(calls.filter((c) => c.label.endsWith(':extra')).every((c) => viewpointOf(c.prompt) === 'flow'));
  assert.ok(calls.some((c) => c.label === 'verifier:flow:extra'));
});

// 選択肢の外の答えは host が schema（enum）で通さないので CLI まで届かない。CLI の拒否の経路は、schema を通る誤り（図の道と合わない並びと台帳に無い資産 ID）で確かめる。
test('SP-BPINSPECTION-006・SP-BPFINDINGS-034: 適用の判定の結果が CLI に拒否されると拒否の理由を足して起動し直し、フローの観点の全ての検証役に同じ形と行が渡る', async (t) => {
  const s = await setupInspect(t);
  if (!s) return;
  let n = 0;
  const applicability = async (prompt) => {
    const r = await inspectDefaults.applicability(prompt);
    n += 1;
    if (n === 1) r.answers.Q2.answer = 'はい';
    if (n === 2) r.ledger.quotes = [{ asset: 'ANOPE', line: 1, text: 'x' }];
    return r;
  };
  const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs('review', s.target), scenario: { applicability } });
  assert.equal(result.stopKind, 'complete', result.reason);
  const prompts = calls.filter((c) => c.role === 'applicability').map((c) => c.prompt);
  assert.equal(prompts.length, 3);
  assert.match(prompts[1], /前の回に拒否された理由:\n.*形の判定の図の道に無い/);
  assert.match(prompts[2], /台帳の今の資産に無い/);
  assert.equal(result.ledger.rejected.count, 2);
  const flow = verifiers(calls).filter((c) => viewpointOf(c.prompt) === 'flow').map((c) => /\n(\{"shape".*\})\n/.exec(c.prompt)[1]);
  assert.equal(flow.length, 2);
  assert.equal(new Set(flow).size, 1);
  assert.equal(JSON.parse(flow[0]).shape, '固定パイプライン型');
  assert.equal(result.applicability.shape, '固定パイプライン型');
  assert.equal(result.applicability.row, 4);
  assert.ok(!verifiers(calls).some((c) => viewpointOf(c.prompt) === 'spec' && c.prompt.includes('"shape"')));
});

test('SP-BPINSPECTION-014・SP-BPINSPECTION-024: audit の結果に確度・declared_only・audit_header の鍵が無く、prompt-audit のパスと指紋と、状態の今の対象スキルのパスの一覧が逐語で載る', async (t) => {
  const s = await setupInspect(t);
  if (!s) return;
  const { result } = await runInspect(t, { env: s.env, args: inspectArgs('audit', s.target), scenario: { verify: candidateVerifier({ viewpoint: 'audit' }) } });
  assert.equal(result.stopKind, 'complete', result.reason);
  const text = JSON.stringify(result);
  for (const k of ['confidence', 'declared_only', 'declaredOnly', 'audit_header', 'auditHeader', 'High', 'Medium']) assert.ok(!text.includes(`"${k}"`), k);
  const audit = result.targets.find((x) => x.viewpoint === 'audit');
  assert.equal(audit.files[0].path, s.env.promptAudit);
  assert.match(audit.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.match(audit.fingerprint, /^[0-9a-f]{64}$/);
  const view = await viewOf(s.env, result.state);
  const paths = view.paths.at(-1);
  assert.deepEqual(result.target, { root: paths.root, files: paths.files });
  assert.ok(result.uncheckedViewpoints.some((u) => u.value === 'PA-3' && u.scope === 'pa'));
});

test('SP-BPINSPECTION-024: 未検査の観点が空の review でも結果に項目がある', async (t) => {
  const s = await setupInspect(t);
  if (!s) return;
  // 強いられた未検査の出所（PR-BPDESIGNEDSKILL-014 と、PR-BPDESIGNEDSKILL-010 が当たる権限の表の最後の行）を写しのトレーサビリティ表から外す。
  await editFile(path.join(s.criteriaDir, 'specifications', 'bp-conformance.md'), (x) => x.split('\n').filter((l) => !/^\| PR-BPDESIGNEDSKILL-01[04] \|/.test(l)).join('\n'));
  const { result } = await runInspect(t, { env: s.env, args: inspectArgs('review', s.target) });
  assert.equal(result.stopKind, 'complete', result.reason);
  assert.deepEqual(result.uncheckedViewpoints, []);
});

test('SP-BPINSPECTION-027: フローの観点の照らす先を読めない review は、検証役を起動せずに指摘 0 件の完了ではなく BLOCKED と読めなかったパスを返す', async (t) => {
  const s = await setupInspect(t);
  if (!s) return;
  await editFile(path.join(s.criteriaDir, 'specifications', 'bp-conformance.md'), (x) => x.replace('## 機能仕様', '## 機能'));
  const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs('review', s.target) });
  assert.equal(result.stopKind, 'blocked');
  assert.ok(result.reason.includes(path.join(s.criteriaDir, 'specifications', 'bp-conformance.md')));
  assert.deepEqual(agents(calls), []);
});

test('SP-BPINSPECTION-027: prompt-audit を読めない audit は、検証役を起動せずに BLOCKED と読めなかったパスを返す', async (t) => {
  const missing = path.join(REPO_ROOT, '.best-practices', `none-${process.pid}.md`);
  const s = await setupInspect(t, { promptAudit: missing });
  if (!s) return;
  const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs('audit', s.target) });
  assert.equal(result.stopKind, 'blocked');
  assert.ok(result.reason.includes(missing));
  assert.deepEqual(agents(calls), []);
});

test('SP-BPINSPECTION-028: 一覧が食い違う prompt-audit の写しで、検証役が起動されず BLOCKED と食い違った番号と名前を返す', async (t) => {
  const base = await setupInspect(t);
  if (!base) return;
  const copy = path.join(base.base, 'prompt-audit.md');
  await fs.writeFile(copy, readFileSync(path.join(SKILL_DIR, 'references', 'prompt-audit.md'), 'utf8').replace('6. **Stale internal guidance**', '6. **Stale guidance**'));
  const s = await setupInspect(t, { promptAudit: copy });
  const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs('audit', s.target) });
  assert.equal(result.stopKind, 'blocked');
  assert.match(result.reason, /6\. Stale guidance/);
  assert.match(result.reason, /6\. Stale internal guidance/);
  assert.deepEqual(agents(calls), []);
});
