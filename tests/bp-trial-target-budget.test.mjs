import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workflow } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs';
import { FIXTURE_DIR } from '../tools/read-bp-trial.mjs';
import { main as cli } from './fixtures/bp-trial/review-target/scripts/state.mjs';

// 試走の題材は、仕込む前に判定表の 15 行目の全ての単位に適合していなければならない（基準の run を 0 件にする前提）。
// 起動数の確かめ（SP-BPCONFORMANCE-021〜025・037）は判断でなく数で決まるので、題材の script を模擬の runner で総当たりに走らせて照らす。
const SCRIPT = path.join(FIXTURE_DIR, 'scripts', 'trace.js');
const COMMAND = /node '[^']+' (\S+) <<'EOF'\n(.*)\nEOF/g;

const repos = new WeakMap();

// 状態は状態 ID ごとに分かれるので、1 本のテストの run は同じリポジトリを使う（毎回 git init すると総当たりが遅い）。
async function repo(t) {
  if (repos.has(t)) return repos.get(t);
  const dir = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'bp-trial-repo-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const f of ['src/a.js', 'src/b.js', 'test/a.test.js']) {
    await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await fs.writeFile(path.join(dir, f), 'x\n');
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  repos.set(t, dir);
  return dir;
}

// 題材の役の答え方の組。どれも、起動が増える方向（試行の失敗・回収・却下・追加の実行）を含む。
const SCENARIOS = {
  素直に完了: { fail: () => false, facts: 2, claimAt: 2, accept: true },
  実行役が全て失敗: { fail: () => true, collect: false, facts: 1, claimAt: 99, accept: true },
  回収役が拾う: { fail: (n) => n % 2 === 0, collect: true, facts: 3, claimAt: 3, accept: true },
  検証役が欠ける: { fail: () => false, verifierFails: (n) => n % 3 === 0, facts: 2, claimAt: 3, accept: true },
  完了の主張の却下: { fail: () => false, facts: 1, claimAt: 2, accept: false },
};

function backend(sc, calls, prompts = []) {
  let plans = 0;
  let executors = 0;
  let verifiers = 0;
  return {
    capabilities: ['read-only', 'fresh-thread', 'workspace-write'],
    async run(prompt, options) {
      calls.push(options.label);
      prompts.push(prompt);
      const label = options.label;
      if (label.startsWith('carrier:')) {
        const responses = [...prompt.matchAll(COMMAND)].map(([, op, text]) => JSON.stringify(cli(op, text).out));
        return { responses };
      }
      if (label === 'goal') return { goal: '原因の説明', scope: ['src', 'test'], prohibitions: [], numeric: [], origin: '再現手順', missing: [] };
      if (label === 'planner') {
        plans += 1;
        if (plans >= sc.claimAt) return { kind: 'claim', claim: { facts: ['F1'], numeric: [] } };
        return { kind: 'intents', intents: [1, 2, 3, 4].map((k) => ({ key: `p${plans}-${k}`, text: `方向 ${plans}-${k}`, basis: ['P1'], rank: k })), rerank: [], hintsRead: [] };
      }
      if (label.startsWith('executor:')) {
        executors += 1;
        if (sc.fail(executors)) return null;
        return { facts: Array.from({ length: sc.facts }, (_, k) => ({ text: `事実 ${executors}-${k}`, method: 'refetch', evidence: 'src/a.js:1' })), blank: false, seen: ['src/a.js', 'src/b.js'] };
      }
      if (label.startsWith('collector:')) return sc.collect ? { facts: [{ text: `回収 ${executors}`, method: 'refetch', evidence: 'src/a.js:1' }] } : null;
      if (label.startsWith('verifier:')) {
        verifiers += 1;
        if (sc.verifierFails?.(verifiers)) return null;
        const n = (prompt.match(/"text":/g) ?? []).length;
        return { verdicts: Array.from({ length: n }, (_, k) => ({ candidate: k, verdict: 'accept', reason: 'r' })) };
      }
      if (label === 'completion') return { verdict: sc.accept ? 'accept' : 'reject', reason: sc.accept ? '足りる' : '段が欠ける' };
      throw new Error(`題材に無い役: ${label}`);
    },
  };
}

async function runTarget(t, sc, { limit, concurrency }) {
  const dir = await repo(t);
  const args = { request: 'テスト a が落ちる原因を調べる', repo: dir, skillDir: FIXTURE_DIR, ...(limit === undefined ? {} : { maxLaunches: limit }) };
  return runArgs(t, sc, args, concurrency);
}

async function runArgs(t, sc, args, concurrency = 3, prompts = []) {
  const dir = await repo(t);
  const calls = [];
  const runDir = path.join(await fs.mkdtemp(path.join(dir, '.workflow-run-')), 'run');
  const result = await Workflow({ scriptPath: SCRIPT, args }, {
    backend: backend(sc, calls, prompts), trustedSource: true, runDir, maxAgents: 1000, concurrency, timeoutMs: 120000, maxOutputBytes: 100_000_000, requirements: ['workspace-write'],
  });
  return { result, calls, prompts };
}

test('SP-BPCONFORMANCE-021・SP-BPCONFORMANCE-037: 試走の題材は、不正な上限と最小の起動数に満たない上限で agent を 1 体も起動せず BLOCKED を返す', async (t) => {
  const sc = SCENARIOS.素直に完了;
  const free = await runTarget(t, sc, { concurrency: 3 });
  assert.equal(free.result.stopKind, 'complete', free.result.reason);
  for (const bad of [0, 1.5, '10']) {
    const r = await runTarget(t, sc, { limit: bad, concurrency: 3 });
    assert.deepEqual([r.result.stopKind, r.calls.length], ['blocked', 0], JSON.stringify(bad));
  }
  const tooSmall = await runTarget(t, sc, { limit: 1, concurrency: 3 });
  assert.deepEqual([tooSmall.result.stopKind, tooSmall.calls.length], ['blocked', 0]);
  assert.match(tooSmall.result.reason, /最小の起動数/);
});

for (const [name, sc] of Object.entries(SCENARIOS)) {
  test(`SP-BPCONFORMANCE-022・SP-BPCONFORMANCE-023・SP-BPCONFORMANCE-025: 試走の題材は、上限を最小の起動数から上限の無い run の起動数まで総当たりで渡しても、同時実行 1・3 のどれでも上限を超えず、停止の記録を書き、上限で止まった理由に上限・その時点の起動数・残した件数を載せる［${name}］`, async (t) => {
    const free = await runTarget(t, sc, { concurrency: 3 });
    assert.ok(free.calls.length > 0);
    assert.equal(free.result.launches, free.calls.length);
    const min = Number(/最小の起動数 (\d+)/.exec((await runTarget(t, sc, { limit: 1, concurrency: 1 })).result.reason)[1]);
    for (const concurrency of [1, 3]) {
      for (let limit = min; limit <= free.calls.length + 1; limit += 1) {
        const { result, calls } = await runTarget(t, sc, { limit, concurrency });
        const label = `同時実行 ${concurrency}・上限 ${limit}`;
        assert.ok(calls.length <= limit, `${label}: ${calls.length} 体`);
        assert.equal(result.launches, calls.length, label);
        assert.ok(calls.at(-1).startsWith('carrier:stop'), `${label}: 最後の起動が停止の運搬役でない（${calls.at(-1)}）`);
        if (result.stopKind === 'iteration_limit' && /起動数の上限/.test(result.reason)) {
          assert.match(result.reason, new RegExp(`起動数の上限 ${limit} で止まった（その時点の起動数 \\d+）。残した意図 \\d+ 件`), label);
          assert.deepEqual(Object.keys(result.nextArgs).sort(), ['repo', 'skillDir', 'state'], label);
        }
      }
    }
  });
}

test('SP-BPCONFORMANCE-021・SP-BPCONFORMANCE-037: 試走の題材は、SKILL.md の表の必須の項目（request・repo・skillDir、再開は state・repo・skillDir）が欠けると agent を 1 体も起動せず BLOCKED を返す', async (t) => {
  const dir = await repo(t);
  const sc = SCENARIOS.素直に完了;
  for (const args of [
    { repo: dir, skillDir: FIXTURE_DIR },
    { request: 'r', skillDir: FIXTURE_DIR },
    { request: 'r', repo: dir },
    { state: 'tc-x', skillDir: FIXTURE_DIR },
    { state: 'tc-x', repo: dir },
  ]) {
    const r = await runArgs(t, sc, args);
    assert.deepEqual([r.result.stopKind, r.calls.length], ['blocked', 0], JSON.stringify(Object.keys(args)));
  }
});

test('SP-BPCONFORMANCE-024・SP-BPCONFORMANCE-011: 試走の題材は、起動数の上限で止まった run を nextArgs だけで再開でき、再開した run は計画役から始めて、止まっている間に足したヒントを読み、残した意図を処理して完了する', async (t) => {
  const sc = SCENARIOS.素直に完了;
  const free = await runTarget(t, sc, { concurrency: 1 });
  const min = Number(/最小の起動数 (\d+)/.exec((await runTarget(t, sc, { limit: 1, concurrency: 1 })).result.reason)[1]);
  let first = null;
  for (let limit = min; limit < free.calls.length; limit += 1) {
    const r = await runTarget(t, sc, { limit, concurrency: 1 });
    if (r.result.stopKind === 'iteration_limit' && r.result.pending?.length) { first = r; break; }
  }
  assert.ok(first, '起動数の上限で意図を残して止まる上限が無い');
  assert.deepEqual(Object.keys(first.result.nextArgs).sort(), ['repo', 'skillDir', 'state']);
  const hint = cli('hint', JSON.stringify({ repo: first.result.nextArgs.repo, state: first.result.nextArgs.state, text: '環境変数を疑う' }));
  assert.equal(hint.out.ok, true, JSON.stringify(hint.out));
  const second = await runArgs(t, sc, first.result.nextArgs, 1);
  assert.equal(second.result.stopKind, 'complete', second.result.reason);
  assert.deepEqual(second.calls.slice(0, 3).map((l) => l.split(':')[0]), ['carrier', 'carrier', 'planner']);
  assert.match(second.prompts[2], /環境変数を疑う/);
  const executed = second.calls.filter((l) => l.startsWith('executor:I')).map((l) => l.slice('executor:'.length));
  for (const id of first.result.pending) assert.ok(executed.includes(id), `残した意図 ${id} を処理していない`);
  assert.equal(cli('hint', JSON.stringify({ repo: first.result.nextArgs.repo, state: first.result.nextArgs.state, text: 'x' })).out.code, 'E_INPUT');
});

function call(op, body) {
  const { out } = cli(op, JSON.stringify(body));
  assert.equal(out.ok, true, `${op}: ${JSON.stringify(out)}`);
  return out;
}

async function begun(t) {
  const dir = await repo(t);
  const s = call('start', { repo: dir, key: `k-${Math.random()}`, request: 'r', limits: { rounds: 5, attempts: 3 } });
  const base = { repo: dir, state: s.state, run: s.run };
  call('premise', { ...base, kind: 'goal', text: 'g' });
  call('ledger', { ...base, scope: ['src'] });
  return { dir, base };
}

test('SP-BPCONFORMANCE-016・SP-BPCONFORMANCE-011: 試走の題材の状態の CLI は、同じ鍵の開始の送り直しで状態を 2 つ作らず、再開した run では乾きと全件失敗の連続を数え直し、周の上限を run ごとに数える', async (t) => {
  const dir = await repo(t);
  const a = call('start', { repo: dir, key: 'same', request: 'r', limits: { rounds: 2, attempts: 3 } });
  const b = call('start', { repo: dir, key: 'same', request: 'r', limits: { rounds: 2, attempts: 3 } });
  assert.equal(b.state, a.state);
  const base = { repo: dir, state: a.state, run: a.run };
  call('premise', { ...base, kind: 'goal', text: 'g' });
  const r1 = call('round', { ...base, round: 1, launches: 1, allFailed: true });
  const r2 = call('round', { ...base, round: 2, launches: 1, allFailed: true });
  assert.deepEqual([r1.dry, r2.dry, r2.failed, r2.limitHit], [1, 2, 2, true]);
  call('stop', { ...base, kind: 'dry', reason: '乾き', launches: 3 });
  const resumed = call('resume', { repo: dir, state: a.state });
  const r3 = call('round', { repo: dir, state: a.state, run: resumed.run, round: 3, launches: 1, allFailed: true });
  assert.deepEqual([r3.dry, r3.failed, r3.limitHit], [1, 1, false]);
});

test('SP-BPCONFORMANCE-017・SP-BPCONFORMANCE-011: 試走の題材の台帳は、見た後に変わったファイルを見たと数えず、再開で範囲の今のファイルを足し直す', async (t) => {
  const { dir, base } = await begun(t);
  assert.deepEqual(call('skip', base).skip.sort(), ['src/a.js', 'src/b.js']);
  call('seen', { ...base, intent: 'extra', paths: ['src/a.js', 'src/b.js'] });
  assert.deepEqual(call('skip', base), { ok: true, op: 'skip', skip: [], coverage: '2/2' });
  await fs.writeFile(path.join(dir, 'src', 'a.js'), 'changed\n');
  assert.deepEqual(call('skip', base).skip, ['src/a.js']);
  call('stop', { ...base, kind: 'dry', reason: '乾き', launches: 1 });
  await fs.writeFile(path.join(dir, 'src', 'c.js'), 'new\n');
  execFileSync('git', ['add', 'src/c.js'], { cwd: dir });
  call('resume', { repo: dir, state: base.state });
  assert.deepEqual(call('skip', base).skip.sort(), ['src/a.js', 'src/c.js']);
});

test('SP-BPCONFORMANCE-011: 試走の題材は、完了を主張した計画役が読んだヒントも読まれたと数え、状態に無い意図の終わりを拒否する', async (t) => {
  const { base } = await begun(t);
  call('hint', { repo: base.repo, state: base.state, text: 'h' });
  call('claim', { ...base, facts: ['P1'], numeric: [], hintsRead: ['H1'] });
  assert.equal(call('round', { ...base, round: 1, launches: 1, allFailed: false }).unreadHints, 0);
  assert.equal(cli('done', JSON.stringify({ ...base, intent: 'I99' })).out.code, 'E_UNKNOWN_ID');
});
