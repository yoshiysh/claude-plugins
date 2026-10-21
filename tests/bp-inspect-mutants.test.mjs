import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  INSPECT_SCRIPT, MIN_LAUNCHES, candidateVerifier, commands, inspectArgs, resumeArgs, runInspect, setupInspect, variant, viewpointOf,
} from './helpers/bp-harness.mjs';
import { OPS } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';

const agents = (calls) => calls.filter((c) => c.role !== 'carrier');

async function editFile(file, edit) {
  await fs.writeFile(file, edit(await fs.readFile(file, 'utf8')));
}

function loseItem(op) {
  let lost = null;
  return async (prompt) => {
    if (!prompt.includes(` ${op} <<`)) return undefined;
    const item = /"item":"([^"]+)"/.exec(prompt)[1];
    lost = lost ?? item;
    return item === lost ? null : undefined;
  };
}

// bp_inspect.js に欠陥を入れた写しで、決めておいた場合が必ず落ちることを照らす（テストが壊れた実装で落ちるかの確かめ）。
// 各場合は「正しい script なら true」を返す。元の script で true、欠陥を入れた写しで false でなければならない。
const CASES = [
  {
    name: '起動数の上限の確かめを外すと、最小の起動数の上限を超えて起動する（SP-BPRUN-021・SP-BPRUN-037）',
    from: '      if (limit === undefined) return true\n', to: '      return true\n',
    async check(t, scriptPath) {
      const s = await setupInspect(t);
      const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs('review', s.target, { maxLaunches: MIN_LAUNCHES.review }), scriptPath });
      return result.stopKind === 'iteration_limit' && calls.length <= MIN_LAUNCHES.review;
    },
  },
  {
    name: '照らす先の決定の blocked を見ずに進むと、照らせない review が検証役を起動する（SP-BPINSPECTION-027・SP-BPINSPECTION-028）',
    from: '  if (t.blocked) throw new Stop(', to: '  if (false) throw new Stop(',
    async check(t, scriptPath) {
      const s = await setupInspect(t);
      await editFile(path.join(s.criteriaDir, 'specifications', 'bp-conformance.md'), (x) => x.replace('## 機能仕様', '## 機能'));
      const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs('review', s.target), scriptPath });
      return result.stopKind === 'blocked' && agents(calls).length === 0;
    },
  },
  {
    name: '観点の集合を照らす先の決定の出力でなく機能の上限の集合にすると、仕様の観点を読めない review が仕様の観点の検証役を起動する（SP-BPINSPECTION-005）',
    from: '  run.viewpoints = t.viewpoints\n', to: '  run.viewpoints = RUN_VIEWPOINTS[fn]\n',
    async check(t, scriptPath) {
      const s = await setupInspect(t);
      await editFile(path.join(s.criteriaDir, 'specifications', 'bp-conformance.md'), (x) => x.replace('## 性能・容量（対象スキルに課す確定値）', '## 容量'));
      const { calls } = await runInspect(t, { env: s.env, args: inspectArgs('review', s.target), scriptPath });
      return !calls.some((c) => c.role === 'verify' && viewpointOf(c.prompt) === 'spec');
    },
  },
  {
    name: '停止の onTargetChanged を外すと、run の中で対象を変えても完了を返す（SP-BPRUN-026）',
    from: '    onTargetChanged: STOP_KINDS.blocked,\n', to: '',
    async check(t, scriptPath) {
      const s = await setupInspect(t);
      const verify = async (prompt, options, env, call, calls) => {
        await fs.appendFile(path.join(s.target.root, 'SKILL.md'), '\n足した行\n');
        return candidateVerifier({ viewpoint: 'none' })(prompt, options, env, call, calls);
      };
      const { result } = await runInspect(t, { env: s.env, args: inspectArgs('audit', s.target), scenario: { verify }, scriptPath });
      return result.stopKind === 'blocked' && /対象スキルが変わった/.test(result.reason);
    },
  },
  {
    name: '検証の項目の鍵を担当の順・観点の順で入れ替えると、未着手の項目が観点の順・担当の順で残らない（SP-BPINSPECTION-016）',
    from: 'return run.viewpoints.flatMap((viewpoint) => run.groups.map((g) => ({ viewpoint, assignment: g.id })))',
    to: 'return run.groups.flatMap((g) => run.viewpoints.map((viewpoint) => ({ viewpoint, assignment: g.id })))',
    async check(t, scriptPath) {
      const s = await setupInspect(t);
      const { result, calls } = await runInspect(t, { env: s.env, args: inspectArgs('review', s.target, { maxLaunches: MIN_LAUNCHES.review }), scriptPath });
      const start = calls.flatMap((c) => commands(c.prompt)).find((x) => x.op === OPS.stageStart && x.text.includes('"stage":"verify"'));
      const keys = JSON.parse(start.text).keys;
      return result.stopKind === 'iteration_limit' && JSON.stringify(keys.map((k) => k.viewpoint)) === JSON.stringify(['flow', 'flow', 'spec', 'spec']);
    },
  },
  {
    name: '担当の作成の繰り返しの番号を 1 ずらすと、CLI が拒否して担当の作成で BLOCKED になる（SP-BPINSPECTION-015）',
    from: 'write(OPS.stageRepeat, { stage: STAGE.assign, n, limitKey: LIMIT_KEYS.attempts })', to: 'write(OPS.stageRepeat, { stage: STAGE.assign, n: n + 1, limitKey: LIMIT_KEYS.attempts })',
    async check(t, scriptPath) {
      const s = await setupInspect(t);
      const { result } = await runInspect(t, { env: s.env, args: inspectArgs('audit', s.target), scriptPath });
      return result.stopKind === 'complete';
    },
  },
  {
    name: '再開で消えた資産の照合を照らす先の照合の前に置くと、照らす先を書き換え節を消した再開で検証役が起動される（SP-BPINSPECTION-029）',
    from: '  await targetsStage()\n  await bundleStage(before(STAGE.assign) && !vanishing)\n  await vanishStage(plan.vanish)\n  await vanishStage(retake)\n',
    to: '  await vanishStage(plan.vanish)\n  await vanishStage(retake)\n  await targetsStage()\n  await bundleStage(before(STAGE.assign) && !vanishing)\n',
    async check(t, scriptPath) {
      const s = await setupInspect(t);
      const verify = candidateVerifier({ viewpoint: 'audit', asset: (ids) => ids.at(-1) });
      const first = await runInspect(t, { env: s.env, args: inspectArgs('audit', s.target), scenario: { verify, carrier: async (p) => (p.includes(' stop <<') ? null : undefined) }, scriptPath });
      await fs.rm(path.join(s.target.root, 'scripts', 'x.js'));
      await fs.appendFile(path.join(s.criteriaDir, 'requirements', 'bp-designed-skill.md'), '\n追記\n');
      const second = await runInspect(t, { env: s.env, args: resumeArgs(first.result), scriptPath });
      return second.result.stopKind === 'blocked' && agents(second.calls).length === 0;
    },
  },
  {
    name: '状態に担当の組がある再開で抽出役を起動し直すと、応答を捨てた run の再開で抽出役が起動される（SP-BPINSPECTION-030）',
    from: '  if (insp.assignments.length) {', to: '  if (false) {',
    async check(t, scriptPath) {
      const s = await setupInspect(t);
      let done = false;
      const carrier = async (prompt, options, env) => {
        if (done || !prompt.includes(' assignments <<') || !prompt.includes('"groups"')) return undefined;
        done = true;
        for (const c of commands(prompt).slice(0, 2)) await env.call(c.op, c.text);
        return null;
      };
      const first = await runInspect(t, { env: s.env, args: inspectArgs('audit', s.target), scenario: { carrier }, scriptPath });
      const second = await runInspect(t, { env: s.env, args: resumeArgs(first.result), scriptPath });
      return second.result.stopKind === 'complete' && !second.calls.some((c) => c.role === 'extract');
    },
  },
  {
    name: '停止の要求に script が並べた pending を入れると、CLI が状態から導いた並びと食い違って停止を書けない（A3）',
    from: '    launches: budget.used() + 1,\n    // どの停止でも', to: '    launches: budget.used() + 1,\n    pending: [],\n    // どの停止でも',
    async check(t, scriptPath) {
      const s = await setupInspect(t);
      const { result } = await runInspect(t, { env: s.env, args: inspectArgs('review', s.target), scenario: { carrier: loseItem(OPS.verdicts) }, scriptPath });
      return result.stopKind === 'blocked' && !/停止の記録を書けなかった/.test(result.reason);
    },
  },
];

for (const c of CASES) {
  test(`壊した bp_inspect.js で落ちる: ${c.name}`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    assert.equal(await c.check(t, INSPECT_SCRIPT), true, '元の script で場合が通らない');
    const mutant = await variant(t, [[c.from, c.to]], INSPECT_SCRIPT);
    assert.equal(await c.check(t, mutant), false, '欠陥を入れた script でも場合が通る');
  });
}
