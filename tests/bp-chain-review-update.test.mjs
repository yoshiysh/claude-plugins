import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT, assetIds, candidateVerifier, defaults, inspectArgs, runAuthor, runInspect, setupInspect, updateArgs, viewOf, writePayload,
} from './helpers/bp-harness.mjs';

const RUN = readFileSync(path.join(REPO_ROOT, 'docs', 'specifications', 'bp-run.md'), 'utf8');
// SP-BPFINDINGS-029 の表は項目の名前だけを持ち、綴りは SP-BPRUN-031 の report の行の findings が持つ（その綴りで照らす）。
const FINDING_FIELDS = (() => {
  const row = RUN.split('\n').find((l) => l.startsWith('| `report` |'));
  const m = /`findings`（SP-BPFINDINGS-029 の項目: ([^）]+)）/.exec(row);
  return [...m[1].matchAll(/`(\w+)`/g)].map((x) => x[1]);
})();
const VIEWPOINT = { review: 'flow', audit: 'audit' };
const INSTRUCTION = { kind: '利用者の指示', text: '手順の節を短くする' };

for (const fn of ['review', 'audit']) {
  test(`SP-BPFINDINGS-027・SP-BPFINDINGS-029・SP-BPFINDINGS-031・PR-BPOPERATIONS-036・PR-BPOPERATIONS-038: ${fn} の結果の指摘を 1 字も変えずに update の修正の根拠に渡すと受け付けられ、open の指摘と利用者の指示だけが修正の根拠になり、update の台帳に ${fn} の指摘 ID が無く、同じ資産・種類の update の指摘は別の ID になる［${fn}］`, async (t) => {
    const s = await setupInspect(t);
    if (!s) return;
    let refutes = 0;
    const inspected = await runInspect(t, {
      env: s.env,
      args: inspectArgs(fn, s.target),
      scenario: {
        verify: candidateVerifier({ viewpoint: VIEWPOINT[fn] }),
        refute: async () => ((refutes += 1) === 1 ? { verdict: 'uphold', reason: '維持' } : { verdict: 'reject', reason: '基準に反しない' }),
      },
    });
    assert.equal(inspected.result.stopKind, 'complete', inspected.result.reason);
    const findings = inspected.result.findings;
    assert.deepEqual(findings.map((f) => f.state).sort(), ['dismissed', 'open']);
    const keys = new Set(findings.flatMap((f) => Object.keys(f)));
    for (const k of keys) assert.ok(FINDING_FIELDS.includes(k), `report の綴りに無い項目: ${k}`);
    for (const k of FINDING_FIELDS.filter((x) => x !== 'judgement')) assert.ok(keys.has(k), `渡す指摘に無い項目: ${k}`);
    const open = findings.find((f) => f.state === 'open');
    const dismissed = findings.find((f) => f.state === 'dismissed');

    const grounds = JSON.parse(JSON.stringify([...findings, INSTRUCTION]));
    // 書き手は対象スキルを作り直さず 1 行足すだけにする（資産 ID が変わらないので、同じ資産の update の指摘を作れる）。
    const write = async (prompt) => {
      const file = path.join(s.target.root, 'SKILL.md');
      await fs.appendFile(file, '\n追記した行\n');
      return { written: [{ path: file, action: 'write' }], designNote: { path: 'SKILL.md' } };
    };
    const verify = async (prompt, options, env, call, calls) => {
      const result = await defaults.verify(prompt, options, env);
      const iteration = calls.slice(0, call.n).filter((c) => c.role === 'write').length;
      if (options.label !== 'verifier:conformance' || iteration !== 1 || !assetIds(prompt).includes(open.assets[0].id)) return result;
      const unit = result.units.find((u) => u.unit === open.kind && u.result === 'conform') ?? result.units.find((u) => u.result === 'conform');
      const key = { asset: open.assets[0].id, viewpoint: 'conformance', kind: unit.unit };
      result.judgements.find((j) => j.asset === key.asset).judgement = 'candidate';
      result.candidates = [{ ...key, quote: 'L1: 本文', content: 'c', fix: 'f' }];
      Object.assign(unit, { result: 'nonconform', keys: [key] });
      await writePayload(prompt, result);
      return result;
    };
    const updated = await runAuthor(t, { env: s.env, args: updateArgs(s.target, { grounds }), scenario: { write, verify } });
    assert.equal(updated.result.stopKind, 'complete', updated.result.reason);
    const goal = updated.calls.find((c) => c.role === 'goal').prompt;
    const passed = JSON.parse(/修正の根拠（記録 ID と中身）:\n(.+)/.exec(goal)[1]);
    assert.deepEqual(passed.map((g) => g.ground), [open, INSTRUCTION]);
    assert.ok(!goal.includes(dismissed.id));
    const view = await viewOf(s.env, updated.result.state);
    const before = await viewOf(s.env, inspected.result.state);
    // update の台帳の指摘は、update の検証役が返した候補（資産 1 つ・反復 1 だけ）から作った 1 件だけで、前の機能の台帳とは別の台帳 ID を持つ。
    assert.deepEqual([...view.findings.values()].map((f) => [f.key.asset, f.key.viewpoint]), [[open.assets[0].id, 'conformance']]);
    assert.notEqual(view.ledger.id, before.ledger.id);
    const ids = [...view.findings.values()].map((f) => f.id);
    for (const f of findings) assert.ok(!ids.includes(f.id), f.id);
    const same = [...view.findings.values()][0];
    if (fn === 'review') assert.equal(same.key.kind, open.kind);
    assert.notEqual(same.id, open.id);
    assert.equal((await viewOf(s.env, inspected.result.state)).findings.size, findings.length);
    assert.deepEqual(updated.result.receivedGrounds.filter((g) => g.finding).map((g) => g.finding), findings.map((f) => f.id));
  });
}
