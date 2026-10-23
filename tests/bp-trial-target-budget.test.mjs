import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, promises as fs, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workflow } from '../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs';
import { FIXTURE_DIR } from '../tools/read-bp-trial.mjs';
import { main as cli, logOf as logPath, workRootOf } from './fixtures/bp-trial/review-target/scripts/state.mjs';
import { exec, make } from './fixtures/bp-trial/review-target/scripts/copy.mjs';

// 題材の状態の置き場は利用者のホームの下が既定なので、テストの間は一時ディレクトリに向ける。
const HOME = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bp-trial-home-')));
process.env.TRACE_CAUSE_HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));

// 試走の題材は、仕込む前に判定表の 15 行目の全ての単位に適合していなければならない（基準の run を 0 件にする前提）。
// 判断でなく数と記録で決まる単位は、題材の script を模擬の runner で走らせ、状態の CLI を直接呼んで照らす。
const COMMAND = /node '[^']+' (\S+) <<'EOF'\n(.*)\nEOF/g;
const FILES = ['src/a.js', 'src/b.js', 'test/a.test.js'];

const repos = new WeakMap();

// 状態は状態 ID ごとに分かれるので、1 本のテストの run は同じリポジトリを使う（毎回 git init すると総当たりが遅い）。
async function repo(t) {
  if (repos.has(t)) return repos.get(t);
  const dir = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'bp-trial-repo-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const f of FILES) {
    await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await fs.writeFile(path.join(dir, f), 'x\n');
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  repos.set(t, dir);
  return dir;
}

const carry = (prompt) => ({ responses: [...prompt.matchAll(COMMAND)].map(([, op, text]) => JSON.stringify(cli(op, text).out)) });

// 題材の役の答え方の組。どれも、起動が増える方向（試行の失敗・回収・却下・追加の実行）を含む。
const SCENARIOS = {
  素直に完了: { fail: () => false, facts: 2, claimAt: 2, accept: () => true },
  実行役が全て失敗: { fail: () => true, collect: false, facts: 1, claimAt: 99, accept: () => true },
  回収役が拾う: { fail: (n) => n % 2 === 0, collect: true, facts: 3, claimAt: 3, accept: () => true },
  検証役が欠ける: { fail: () => false, verifierFails: (n) => n % 3 === 0, facts: 2, claimAt: 3, accept: () => true },
  完了の主張の却下: { fail: () => false, facts: 1, claimAt: 2, accept: () => false },
  意図1件が最悪を使い切る: { intents: 1, fail: () => true, collect: true, verifierFails: () => true, facts: 1, claimAt: 99, accept: () => true },
};

function backend(sc, rec) {
  const n = { plans: 0, executors: 0, verifiers: 0, completions: 0 };
  return {
    capabilities: ['read-only', 'fresh-thread', 'workspace-write'],
    async run(prompt, options) {
      const label = options.label;
      rec.calls.push(label);
      rec.prompts.push(prompt);
      rec.options.push(options);
      if (sc.agent) {
        const r = await sc.agent(label, prompt, rec);
        if (r !== undefined) return r;
      }
      if (label.startsWith('carrier:')) return carry(prompt);
      if (label === 'goal') return { goal: '原因の説明', scope: ['src', 'test'], prohibitions: [], numeric: sc.numeric ?? [], origin: '再現手順', missing: [] };
      if (label === 'planner') {
        n.plans += 1;
        const facts = [...prompt.matchAll(/^事実 (F[0-9a-f]+):/gm)].map((m) => m[1]);
        if (n.plans >= sc.claimAt && facts.length) return { kind: 'claim', claim: { cause: '原因', facts: facts.slice(0, 1), numeric: (sc.numeric ?? []).map((_, k) => ({ condition: k + 1, fact: facts[0] })) } };
        return { kind: 'intents', intents: Array.from({ length: sc.intents ?? 4 }, (_, k) => ({ key: `p${n.plans}-${k}`, text: `方向 ${n.plans}-${k}`, basis: ['P1'], rank: k + 1 })), rerank: [] };
      }
      if (label === 'executor:extra') return { facts: [], blank: true, seen: FILES };
      if (label.startsWith('executor:')) {
        n.executors += 1;
        if (sc.fail(n.executors)) return null;
        return { facts: Array.from({ length: sc.facts }, (_, k) => ({ text: `事実 ${n.executors}-${k}`, method: 'refetch', evidence: 'src/a.js:1' })), blank: false, seen: ['src/a.js', 'src/b.js'] };
      }
      if (label.startsWith('collector:')) return sc.collect ? { facts: [{ text: `回収 ${n.executors}`, method: 'refetch', evidence: 'src/a.js:1' }] } : null;
      if (label.startsWith('verifier:')) {
        n.verifiers += 1;
        if (sc.verifierFails?.(n.verifiers)) return null;
        return { verdicts: [...prompt.matchAll(/^(\d+): \{/gm)].map(([, k]) => ({ candidate: Number(k), verdict: sc.verdict ?? 'accept', reason: 'r' })) };
      }
      if (label === 'completion') {
        n.completions += 1;
        const accept = sc.accept(n.completions);
        return { verdict: accept ? 'accept' : 'reject', reason: accept ? '足りる' : '段が欠ける' };
      }
      throw new Error(`題材に無い役: ${label}`);
    },
  };
}

async function runArgs(t, sc, args, { concurrency = 3, root = FIXTURE_DIR } = {}) {
  const dir = await repo(t);
  const rec = { calls: [], prompts: [], options: [] };
  const runDir = path.join(await fs.mkdtemp(path.join(dir, '.workflow-run-')), 'run');
  const result = await Workflow({ scriptPath: path.join(root, 'scripts', 'trace.js'), args }, {
    backend: backend(sc, rec), trustedSource: true, runDir, maxAgents: 1000, concurrency, timeoutMs: 120000, maxOutputBytes: 100_000_000, requirements: ['workspace-write'],
  });
  return { result, ...rec };
}

// 状態は SKILL.md の「起動」のとおり、呼び出し元が run の前に CLI の start で作る。
function started(dir, request = 'テスト a が落ちる原因を調べる', commands = ['cat src/a.js']) {
  const { out } = cli('start', JSON.stringify({ repo: dir, request, commands }));
  assert.equal(out.ok, true, JSON.stringify(out));
  return out;
}

async function runTarget(t, sc, { limit, concurrency = 3, root = FIXTURE_DIR, request } = {}) {
  const dir = await repo(t);
  const s = started(dir, request);
  const args = { state: s.state, repo: dir, skillDir: root, resumeKey: s.resumeKey, ...(limit === undefined ? {} : { maxLaunches: limit }) };
  return runArgs(t, sc, args, { concurrency, root });
}

const logFile = (dir, state) => logPath(dir, state);
const logOf = (dir, state) => readFileSync(logFile(dir, state), 'utf8').split('\n').filter(Boolean).flatMap((l) => JSON.parse(l));

function worstOf(root) {
  const text = readFileSync(path.join(root, 'scripts', 'trace.js'), 'utf8');
  const constant = (name) => /const (\w+) = (\{[^}]*\}|\d+)\n/g;
  const values = {};
  for (const [, name, body] of text.matchAll(constant())) values[name] = body;
  const attempts = Number(values.MAX_ATTEMPTS);
  return { worst: new Function('MAX_ATTEMPTS', `return ${values.WORST}`)(attempts), reserve: Number(values.RESERVE) };
}

// 同時実行 1 では、上限を渡した run の起動は上限の無い run の起動の頭と同じ並びになる。起動の単位はその先頭の起動で分かる。
const UNIT_OF = [
  [/^carrier:resume$/, 'start'],
  [/^goal$/, 'goal'],
  [/^carrier:summary$/, 'plan'],
  [/^executor:I/, 'item'],
  [/^executor:extra$/, 'extra'],
  [/^carrier:skip$/, 'scan'],
  [/^carrier:round$/, 'round'],
  [/^carrier:stop$/, 'stop'],
];

function segments(calls) {
  const out = [];
  for (const label of calls) {
    const kind = UNIT_OF.find(([re]) => re.test(label))?.[1];
    const sameItem = kind === 'item' && out.at(-1)?.kind === 'item' && out.at(-1).labels[0] === label;
    if (kind && !sameItem) out.push({ kind, labels: [label] });
    else out.at(-1).labels.push(label);
  }
  return out;
}

const minOf = async (t, sc, root) => Number(/最小の起動数 (\d+)/.exec((await runTarget(t, sc, { limit: 1, concurrency: 1, root })).result.reason)[1]);

// 上限を最小の起動数から上限の無い run の起動数まで総当たりで渡し、上限・停止の記録・理由の契約に反した run を返す。
async function sweep(t, root, { concurrencies = [1, 3], first = false, refused } = {}) {
  const bad = [];
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    for (const concurrency of concurrencies) {
      const free = await runTarget(t, sc, { concurrency, root });
      const min = await minOf(t, sc, root);
      for (let limit = min; limit <= free.calls.length + 1; limit += 1) {
        const { result, calls } = await runTarget(t, sc, { limit, concurrency, root });
        const label = `${name}・同時実行 ${concurrency}・上限 ${limit}`;
        if (calls.length > limit) bad.push(`${label}: ${calls.length} 体`);
        else if (result.launches !== calls.length) bad.push(`${label}: launches ${result.launches} と起動 ${calls.length} が違う`);
        else if (!calls.at(-1)?.startsWith('carrier:stop')) bad.push(`${label}: 最後の起動が停止の運搬役でない（${calls.at(-1)}）`);
        else if (result.stopKind === 'iteration_limit' && /起動数の上限/.test(result.reason)
          && !(new RegExp(`起動数の上限 ${limit} で止まった（その時点の起動数 \\d+）。残した意図 \\d+ 件`).test(result.reason) && JSON.stringify(Object.keys(result.nextArgs).sort()) === '["repo","resumeKey","skillDir","state"]')) bad.push(`${label}: 理由か nextArgs が契約と違う（${result.reason}）`);
        if (refused && concurrency === 1 && calls.length <= free.calls.length) {
          const next = segments(free.calls.slice(0, calls.length)).at(-1);
          if (next && free.calls[calls.length - 1] === next.labels[0] && next.labels.length === 1) refused.add(`${next.kind}${free.calls.slice(0, calls.length - 1).includes('carrier:round') ? '（2 周目以降）' : ''}`);
        }
        if (first && bad.length) return bad;
      }
    }
  }
  return bad;
}

// 上限の無い run の起動を単位に分け、単位の種類ごとの実測の最悪を返す。
async function measured(t, root) {
  const max = {};
  for (const sc of Object.values(SCENARIOS)) {
    for (const s of segments((await runTarget(t, sc, { concurrency: 1, root })).calls)) max[s.kind] = Math.max(max[s.kind] ?? 0, s.labels.length);
  }
  return max;
}

const sequential = (t, root = FIXTURE_DIR) => mutant(t, (s) => s.replace('const CONCURRENCY = 3\n', 'const CONCURRENCY = 1\n'), root);

// 単位への切り分けは起動の並びで行うので、意図を 1 件ずつ走らせる写しで測る（最悪の数は同時実行の数によらない）。
async function tightness(t, root) {
  const { worst, reserve } = worstOf(root);
  const max = await measured(t, root);
  const bad = Object.entries(worst).filter(([k, w]) => max[k] !== w).map(([k, w]) => `${k}: 定数 ${w}・実測の最悪 ${max[k]}`);
  if (max.stop !== reserve) bad.push(`予約分: 定数 ${reserve}・実測 ${max.stop}`);
  return bad;
}

async function mutant(t, edit, from = FIXTURE_DIR) {
  const root = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'bp-trial-mutant-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(from, root, { recursive: true });
  const file = path.join(root, 'scripts', 'trace.js');
  const text = readFileSync(file, 'utf8');
  const changed = edit(text);
  assert.notEqual(changed, text);
  await fs.writeFile(file, changed);
  return root;
}

test('SP-BPCONFORMANCE-021・SP-BPCONFORMANCE-037: 試走の題材は、不正な上限と最小の起動数に満たない上限で agent を 1 体も起動せず BLOCKED を返し、再開の入力なら状態 ID を持つ nextArgs を返す', async (t) => {
  const sc = SCENARIOS.素直に完了;
  const dir = await repo(t);
  for (const bad of [0, 1, 1.5, '10']) {
    const r = await runArgs(t, sc, { state: 'tc-x', repo: dir, skillDir: FIXTURE_DIR, resumeKey: 'k', maxLaunches: bad });
    assert.deepEqual([r.result.stopKind, r.calls.length, r.result.nextArgs], ['blocked', 0, { state: 'tc-x', repo: dir, skillDir: FIXTURE_DIR, resumeKey: 'k' }], JSON.stringify(bad));
  }
  const both = await runArgs(t, sc, { state: 'tc-x', maxLaunches: 0 });
  assert.match(both.result.reason, /起動数の上限 0 は 1 以上の整数/);
  assert.equal(both.result.nextArgs.state, 'tc-x');
  const free = await runTarget(t, sc);
  assert.equal(free.result.stopKind, 'complete', free.result.reason);
  for (const bad of [0, 1.5, '10']) {
    const r = await runTarget(t, sc, { limit: bad });
    assert.deepEqual([r.result.stopKind, r.calls.length], ['blocked', 0], JSON.stringify(bad));
  }
  const tooSmall = await runTarget(t, sc, { limit: 1 });
  assert.deepEqual([tooSmall.result.stopKind, tooSmall.calls.length], ['blocked', 0]);
  assert.match(tooSmall.result.reason, /最小の起動数/);
});

test('SP-BPCONFORMANCE-022・SP-BPCONFORMANCE-023・SP-BPCONFORMANCE-025: 試走の題材は、上限を最小の起動数から上限の無い run の起動数まで総当たりで渡しても、同時実行 1・3 のどれでも上限を超えず、停止の記録を書き、上限で止まった理由に上限・その時点の起動数・残した件数を載せ、後の段の単位も境界で止める', async (t) => {
  assert.deepEqual(await sweep(t, FIXTURE_DIR), []);
  const refused = new Set();
  assert.deepEqual(await sweep(t, await sequential(t), { concurrencies: [1], refused }), []);
  for (const kind of ['plan（2 周目以降）', 'item', 'extra', 'scan', 'round']) assert.ok([...refused].some((k) => k.startsWith(kind)), `境界で止めた単位に ${kind} が無い: ${[...refused].join(' / ')}`);
});

test('SP-BPCONFORMANCE-022: 試走の題材の最悪の起動数の定数は、単位ごとの実測の最悪と一致し、予約分を 0 にする変異と最悪を 1 減らす変異を総当たりか実測の照合が見つける', async (t) => {
  const one = await sequential(t);
  assert.deepEqual(await tightness(t, one), []);
  const reserve = await mutant(t, (s) => s.replace('const RESERVE = 1\n', 'const RESERVE = 0\n'));
  assert.ok((await sweep(t, reserve, { concurrencies: [1], first: true })).length, '予約分を 0 にした変異で上限を超える run が無い');
  const { worst } = worstOf(FIXTURE_DIR);
  for (const key of Object.keys(worst)) {
    const root = await mutant(t, (s) => s.replace(/const WORST = \{[^}]*\}/, (w) => w.replace(new RegExp(`(\\n  ${key}: )([^,\\n]+),`), '$1$2 - 1,')), one);
    assert.ok((await tightness(t, root)).length, `${key} を 1 減らした変異を実測の照合が見つけない`);
  }
  const item = await mutant(t, (s) => s.replace('item: MAX_ATTEMPTS * (3 + 1),', 'item: MAX_ATTEMPTS * (3 + 1) - 1,'));
  assert.ok((await sweep(t, item, { concurrencies: [1], first: true })).length, '意図の最悪を 1 減らした変異で上限を超える run が無い');
});

test('SP-BPCONFORMANCE-021・SP-BPCONFORMANCE-037: 試走の題材は、SKILL.md の表の必須の項目（state・repo・skillDir・resumeKey）が欠けると agent を 1 体も起動せず BLOCKED を返す', async (t) => {
  const dir = await repo(t);
  const sc = SCENARIOS.素直に完了;
  for (const args of [
    { repo: dir, skillDir: FIXTURE_DIR, resumeKey: 'k' },
    { request: 'r', repo: dir, skillDir: FIXTURE_DIR },
    { state: 'tc-x', skillDir: FIXTURE_DIR, resumeKey: 'k' },
    { state: 'tc-x', repo: dir, resumeKey: 'k' },
    { state: 'tc-x', repo: dir, skillDir: FIXTURE_DIR },
  ]) {
    const r = await runArgs(t, sc, args);
    assert.deepEqual([r.result.stopKind, r.calls.length], ['blocked', 0], JSON.stringify(Object.keys(args)));
  }
});

test('SP-BPCONFORMANCE-024・SP-BPCONFORMANCE-011: 試走の題材は、起動数の上限で止まった run を nextArgs だけで再開でき、再開した run は計画役から始めて、止まっている間に足したヒントを読み、残した意図を処理して完了する', async (t) => {
  const sc = SCENARIOS.素直に完了;
  const free = await runTarget(t, sc, { concurrency: 1 });
  const min = await minOf(t, sc, FIXTURE_DIR);
  let first = null;
  for (let limit = min; limit < free.calls.length; limit += 1) {
    const r = await runTarget(t, sc, { limit, concurrency: 1 });
    if (r.result.stopKind === 'iteration_limit' && r.result.pending?.length) { first = r; break; }
  }
  assert.ok(first, '起動数の上限で意図を残して止まる上限が無い');
  assert.deepEqual(Object.keys(first.result.nextArgs).sort(), ['repo', 'resumeKey', 'skillDir', 'state']);
  const hint = cli('hint', JSON.stringify({ repo: first.result.nextArgs.repo, state: first.result.nextArgs.state, resumeKey: first.result.nextArgs.resumeKey, text: '環境変数を疑う' }));
  assert.equal(hint.out.ok, true, JSON.stringify(hint.out));
  const second = await runArgs(t, sc, first.result.nextArgs, { concurrency: 1 });
  assert.equal(second.result.stopKind, 'complete', second.result.reason);
  assert.deepEqual(second.calls.slice(0, 3).map((l) => l.split(':')[0]), ['carrier', 'carrier', 'planner']);
  assert.match(second.prompts[2], /環境変数を疑う/);
  const executed = second.calls.filter((l) => l.startsWith('executor:I')).map((l) => l.slice('executor:'.length));
  for (const id of first.result.pending) assert.ok(executed.includes(id), `残した意図 ${id} を処理していない`);
  assert.equal(cli('hint', JSON.stringify({ repo: first.result.nextArgs.repo, state: first.result.nextArgs.state, resumeKey: first.result.nextArgs.resumeKey, text: 'x' })).out.code, 'E_INPUT');
});

// 確かめられなかった制限は、SKILL.md の「役ごとの制限」の表の行ごと・配布先ごとに、他の項目を参照せずに読める 4 つの項目で載る。
const RESTRICTED_ROLES = [...readFileSync(path.join(FIXTURE_DIR, 'SKILL.md'), 'utf8').split('## 役ごとの制限')[1].split('\n## ')[0].matchAll(/^\| ([^|]+) \| [^|]+ \|$/gm)].map(([, r]) => r.trim()).filter((r) => r !== '役');

function assertRisks(risks) {
  assert.ok(RESTRICTED_ROLES.length >= 3, RESTRICTED_ROLES.join(' / '));
  for (const host of ['Claude Code', 'Codex runner']) assert.deepEqual(risks.filter((x) => x.host === host).map((x) => x.role), RESTRICTED_ROLES, host);
  assert.equal(risks.length, RESTRICTED_ROLES.length * 2);
  for (const x of risks) assert.ok(x.restriction && x.reason && !/上の|全ての役/.test(`${x.role}${x.restriction}`), JSON.stringify(x));
}

function call(op, body) {
  const { out } = cli(op, JSON.stringify(body));
  assert.equal(out.ok, true, `${op}: ${JSON.stringify(out)}`);
  return out;
}

const code = (op, body) => cli(op, JSON.stringify(body)).out.code;

const LIMITS = { rounds: 5, attempts: 3 };

// run の前の開始と、run の始めの再開まで（目標はまだ固定しない）。
async function opened(t, limits = LIMITS) {
  const dir = await repo(t);
  const s = call('start', { repo: dir, request: 'r', commands: [] });
  const r = call('resume', { repo: dir, state: s.state, resumeKey: s.resumeKey, limits });
  return { dir, base: { repo: dir, state: s.state, run: r.run, writeKey: r.writeKey }, methods: r.methods, resumeKey: s.resumeKey };
}

async function begun(t, { numeric = [] } = {}) {
  const o = await opened(t);
  call('goal', { ...o.base, goal: JSON.stringify({ goal: 'g', scope: ['src'], prohibitions: [], numeric }), origin: 'o', scope: ['src'] });
  return o;
}

const planned = (base, round, keys) => call('plan', { ...base, round, intents: keys.map((key, k) => ({ key, text: key, basis: ['P1'], rank: k + 1 })), rerank: [], hintsRead: [] }).pending;

test('SP-BPCONFORMANCE-016・SP-BPCONFORMANCE-011: 試走の題材の状態の CLI は、再開の送り直しに同じ run と同じ書き込みの鍵を返して先に返した鍵を無効にせず、再開した run では乾きと全件失敗の連続を数え直し、周の上限を run ごとに数える', async (t) => {
  const { dir, base: first, resumeKey } = await opened(t, { rounds: 2, attempts: 3 });
  const twice = call('resume', { repo: dir, state: first.state, resumeKey, limits: { rounds: 2, attempts: 3 } });
  assert.deepEqual([twice.run, twice.writeKey], [first.run, first.writeKey]);
  const base = first;
  call('goal', { ...base, goal: '{}', origin: 'o', scope: ['src'] });
  const r1 = call('round', { ...base, round: 1, launches: 1, allFailed: false });
  const r2 = call('round', { ...base, round: 2, launches: 1, allFailed: false });
  assert.deepEqual([r1.dry, r2.dry, r2.limitHit], [1, 2, true]);
  call('stop', { ...base, kind: 'dry', reason: '乾き', launches: 3 });
  const resumed = call('resume', { repo: dir, state: base.state, resumeKey, limits: { rounds: 2, attempts: 3 } });
  const again = call('resume', { repo: dir, state: base.state, resumeKey, limits: { rounds: 2, attempts: 3 } });
  assert.deepEqual([again.run, again.writeKey], [resumed.run, resumed.writeKey]);
  const next = { repo: dir, state: base.state, run: again.run, writeKey: resumed.writeKey };
  const r3 = call('round', { ...next, round: 3, launches: 1, allFailed: true });
  const r4 = call('round', { ...next, round: 4, launches: 1, allFailed: true });
  assert.deepEqual([r3.dry, r3.failed, r4.failed, r3.limitHit], [0, 1, 2, false]);
});

test('SP-BPCONFORMANCE-016・SP-BPCONFORMANCE-011: 試走の題材の CLI は、書き込みのあった run が停止の記録なしに終わった状態を再開するとき、その run に BLOCKED の停止を足してから新しい run を始め、完了が書かれた状態の再開には完了を返す', async (t) => {
  const { dir, base, resumeKey } = await begun(t);
  const r = call('resume', { repo: dir, state: base.state, resumeKey, limits: LIMITS });
  assert.notEqual(r.run, base.run);
  assert.deepEqual(logOf(dir, base.state).filter((x) => x.t === 'stop').map((x) => [x.run, x.kind]), [[base.run, 'blocked']]);
  const next = { ...base, run: r.run, writeKey: r.writeKey };
  call('stop', { ...next, kind: 'complete', reason: '足りる', cause: { explanation: 'c' }, launches: 1 });
  const done = call('resume', { repo: dir, state: base.state, resumeKey, limits: LIMITS });
  assert.deepEqual([done.completed, done.reason, done.cause], [true, '足りる', { explanation: 'c' }]);
});

test('SP-BPCONFORMANCE-017・SP-BPCONFORMANCE-011: 試走の題材の台帳は、見た後に変わったファイルを見たと数えず、再開で範囲の今のファイルを足し直す', async (t) => {
  const { dir, base, resumeKey } = await begun(t);
  assert.deepEqual(call('skip', base).skip.sort(), ['src/a.js', 'src/b.js']);
  call('seen', { ...base, round: 1, pass: 1, extra: true, paths: ['src/a.js', 'src/b.js'] });
  assert.deepEqual(call('skip', base), { ok: true, op: 'skip', skip: [], coverage: '2/2' });
  await fs.writeFile(path.join(dir, 'src', 'a.js'), 'changed\n');
  assert.deepEqual(call('skip', base).skip, ['src/a.js']);
  call('stop', { ...base, kind: 'dry', reason: '乾き', launches: 1 });
  await fs.writeFile(path.join(dir, 'src', 'c.js'), 'new\n');
  execFileSync('git', ['add', 'src/c.js'], { cwd: dir });
  call('resume', { repo: dir, state: base.state, resumeKey, limits: LIMITS });
  assert.deepEqual(call('skip', base).skip.sort(), ['src/a.js', 'src/c.js']);
});

test('SP-BPCONFORMANCE-016: 試走の題材の CLI は、状態に無いヒント・意図を受け付けず、追加の実行の「見た」を意図として書かない', async (t) => {
  const { base } = await begun(t);
  const [i] = planned(base, 1, ['k1']);
  assert.equal(code('plan', { ...base, round: 2, intents: [], rerank: [], hintsRead: ['H99'] }), 'E_UNKNOWN_ID');
  assert.equal(code('claim', { ...base, round: 2, facts: ['P1'], numeric: [], hintsRead: ['H99'] }), 'E_UNKNOWN_ID');
  assert.equal(code('seen', { ...base, round: 1, intent: 'extra', paths: ['src/a.js'] }), 'E_UNKNOWN_ID');
  assert.equal(code('seen', { ...base, round: 1, extra: true, intent: i.id, paths: ['src/a.js'] }), 'E_INPUT');
  assert.equal(code('done', { ...base, intent: 'I99' }), 'E_UNKNOWN_ID');
});

test('SP-BPCONFORMANCE-011: 試走の題材は、計画役に渡した要約に載ったヒントを読まれたと数え、計画役の申告には頼らない', async (t) => {
  const { dir, base, resumeKey } = await begun(t);
  call('stop', { ...base, kind: 'dry', reason: '乾き', launches: 1 });
  call('hint', { repo: dir, state: base.state, resumeKey, text: '環境変数を疑う' });
  const sc = { ...SCENARIOS.素直に完了, claimAt: 99, intents: 0 };
  const r = await runArgs(t, sc, { state: base.state, repo: dir, skillDir: FIXTURE_DIR, resumeKey });
  assert.match(r.prompts[r.calls.indexOf('planner')], /読まれていないヒント H1: 環境変数を疑う/);
  assert.equal(r.result.stopKind, 'dry', r.result.reason);
  assert.ok(!/H1/.test(call('summary', base).summary));
});

test('SP-BPCONFORMANCE-011・SP-BPCONFORMANCE-031: 試走の題材は、工程の欠けが同じ理由で続いても試行を 1 回ずつ数え、試行の上限で意図を打ち切る', async (t) => {
  const r = await runTarget(t, { ...SCENARIOS.実行役が全て失敗, intents: 1 }, { concurrency: 1 });
  assert.equal(r.calls.filter((l) => l === 'executor:I1').length, 3);
  assert.deepEqual(r.result.aborted, ['I1', 'I2']);
  const { base } = await begun(t);
  const [i] = planned(base, 1, ['k1']);
  assert.equal(code('attempt', { ...base, intent: i.id, reason: '欠けた' }), 'E_INPUT');
  const got = [1, 2, 3].map((attempt) => call('attempt', { ...base, round: 1, attempt, intent: i.id, reason: '欠けた' }));
  assert.deepEqual(got.map((a) => [a.n, a.aborted]), [[1, false], [2, false], [3, true]]);
});

test('SP-BPCONFORMANCE-015: 試走の題材は、実行役が欠けて回収した候補が 1 件も受理されなかった試行を、事実を書かずに試行の失敗として数える', async (t) => {
  const sc = { ...SCENARIOS.意図1件が最悪を使い切る, verifierFails: () => false, verdict: 'reject' };
  const r = await runTarget(t, sc, { concurrency: 1 });
  const log = logOf(await repo(t), r.result.nextArgs.state);
  assert.equal(log.filter((x) => x.t === 'fact').length, 0);
  assert.equal(log.filter((x) => x.t === 'done').length, 0);
  assert.equal(log.filter((x) => x.t === 'attempt' && x.intent === 'I1').length, 3);
});

test('SP-BPCONFORMANCE-015: 試走の題材の実行役の結果の検証方式の綴りは CLI の受け付ける綴りと同じで、検証役には番号つきの候補と判定の番号の型を渡す', async (t) => {
  const r = await runTarget(t, SCENARIOS.回収役が拾う, { concurrency: 1 });
  const at = (prefix) => r.options[r.calls.findIndex((l) => l.startsWith(prefix))];
  assert.ok(Array.isArray(at('executor:I').schema.properties.facts.items.properties.method.enum), '実行役の schema が検証方式を選択肢で縛らない');
  const { base, methods: spelled } = await begun(t);
  const methods = Object.keys(spelled);
  for (const label of ['executor:I', 'collector:', 'executor:extra']) {
    assert.deepEqual(at(label).schema.properties.facts.items.properties.method.enum, methods, label);
    for (const m of methods) assert.ok(r.prompts[r.calls.findIndex((l) => l.startsWith(label))].includes(`${m}（${spelled[m]}）`), `${label}: ${m}`);
  }
  const [i] = planned(base, 1, ['k1']);
  for (const m of methods) call('facts', { ...base, intent: i.id, facts: [{ text: `t-${m}`, method: m, evidence: 'e', verdict: m === 'unverifiable' ? 'unverifiable' : 'accept' }] });
  assert.equal(code('facts', { ...base, intent: i.id, facts: [{ text: 't', method: '再取得', evidence: 'e', verdict: 'accept' }] }), 'E_INPUT');
  assert.equal(at('verifier:').schema.properties.verdicts.items.properties.candidate.type, 'integer');
  assert.match(r.prompts[r.calls.findIndex((l) => l.startsWith('verifier:'))], /^0: \{"text":/m);
});

test('SP-BPCONFORMANCE-010・SP-BPCONFORMANCE-011・SP-BPCONFORMANCE-016: 試走の題材の要約は、前提を ID つきで先頭に載せ、前の run の停止の種類と理由を載せる', async (t) => {
  const { dir, base, resumeKey } = await begun(t);
  const first = call('summary', base).summary.split('\n');
  assert.match(first[1], /^前提 P1（目標）: /);
  assert.match(first[2], /^前提 P2（出発点）: o$/);
  call('stop', { ...base, kind: 'needs_input', reason: 'どのテストか', launches: 1 });
  call('resume', { repo: dir, state: base.state, resumeKey, limits: LIMITS });
  assert.match(call('summary', base).summary, /前の run の停止 r1（needs_input）: どのテストか/);
});

test('SP-BPCONFORMANCE-010・SP-BPCONFORMANCE-014・SP-BPCONFORMANCE-015・SP-BPCONFORMANCE-017: 試走の題材は、実行役・追加の実行役・検証役に前提とリポジトリと作業ファイルの置き場を渡し、実行役に試行の番号を渡し、運搬役以外の役に出力の写しの置き場を渡す', async (t) => {
  const r = await runTarget(t, SCENARIOS.検証役が欠ける, { concurrency: 1 });
  const prompt = (label) => r.prompts[r.calls.indexOf(label)];
  const dir = await repo(t);
  for (const label of ['executor:I1', 'executor:extra', 'verifier:I1']) {
    assert.match(prompt(label), /前提 P1（目標）: /, label);
    assert.ok(prompt(label).includes(`リポジトリ: ${dir}`), label);
    assert.match(prompt(label), /作業ファイルの置き場: \S+\/runs\/[0-9a-f]+\/tc-\w+\/r1/, label);
  }
  assert.match(prompt('executor:I1'), /^試行: 1$/m);
  assert.match(r.prompts[r.calls.lastIndexOf('executor:I3')], /^試行: 2$/m);
  assert.match(prompt('verifier:I1'), /意図 I1・試行 1/);
  r.calls.forEach((label, k) => assert.equal(/出力の写し: \S+\/runs\/[0-9a-f]+\/tc-\w+\/r1\/\d{4}-/.test(r.prompts[k]), !label.startsWith('carrier:'), label));
});

test('SP-BPCONFORMANCE-016・SP-BPCONFORMANCE-032: 試走の題材は、既知の事実を別の意図が言い換えて書いても受理済みの事実を書き換えず、乾きを数え直さず、全件失敗の周を乾きに数えない', async (t) => {
  const { base } = await begun(t);
  const [a, b] = planned(base, 1, ['k1', 'k2']);
  call('facts', { ...base, intent: a.id, facts: [{ text: '設定は A を読む。', method: 'refetch', evidence: 'src/a.js:1', verdict: 'accept' }] });
  const r1 = call('round', { ...base, round: 1, launches: 1, allFailed: false });
  const r2 = call('round', { ...base, round: 2, launches: 1, allFailed: false });
  call('facts', { ...base, intent: b.id, facts: [{ text: '設定は A を読む', method: 'refetch', evidence: 'src/b.js:9', verdict: 'accept' }] });
  const r3 = call('round', { ...base, round: 3, launches: 1, allFailed: false });
  assert.deepEqual([r1.facts, r1.newFacts, r2.dry, r3.facts, r3.newFacts, r3.dry], [1, 1, 1, 1, 0, 2]);
  const [, id] = /事実 (F\w+)/.exec(call('summary', base).summary);
  const fact = call('get', { ...base, id }).record;
  assert.deepEqual([fact.intent, fact.evidence], [a.id, 'src/a.js:1']);
  const r4 = call('round', { ...base, round: 4, launches: 1, allFailed: true });
  assert.deepEqual([r4.dry, r4.failed], [0, 1]);
});

test('SP-BPCONFORMANCE-016: 試走の題材の CLI は、事実の ID を内容のキーから決め、同じ種類の前提と台帳の範囲が食い違う書き込みを拒否し、ID と種類で細部を引ける', async (t) => {
  const { base } = await begun(t);
  const [a, b] = planned(base, 1, ['k1', 'k2']);
  call('facts', { ...base, intent: a.id, facts: [{ text: '事実 x', method: 'refetch', evidence: 'e', verdict: 'accept' }] });
  call('facts', { ...base, intent: b.id, facts: [{ text: '事実 y', method: 'refetch', evidence: 'e', verdict: 'accept' }] });
  const ids = [...call('summary', base).summary.matchAll(/^事実 (F\w+): (.*)$/gm)].map(([, id, text]) => [id, text]);
  assert.equal(ids.length, 2);
  for (const [id, text] of ids) {
    assert.match(id, /^F[0-9a-f]{12}$/);
    assert.equal(call('get', { ...base, id }).record.text, text);
  }
  assert.deepEqual(call('get', { ...base, kind: '事実' }).lines.length, 2);
  const goal = JSON.stringify({ goal: 'g', scope: ['src'], prohibitions: [], numeric: [] });
  assert.equal(code('goal', { ...base, goal: '{"goal":"別"}', origin: 'o', scope: ['src'] }), 'E_CONFLICT');
  assert.equal(code('goal', { ...base, goal, origin: 'o', scope: ['test'] }), 'E_CONFLICT');
  assert.equal(call('goal', { ...base, goal, origin: 'o', scope: ['src'], again: true }).scope[0], 'src');
  assert.equal(code('get', { ...base, id: 'F0' }), 'E_UNKNOWN_ID');
});

test('SP-BPCONFORMANCE-033: 試走の題材の要約は 8,000 字以下で、載せなかった項目を種類ごとの件数で宣言する', async (t) => {
  const { base } = await begun(t);
  const [a] = planned(base, 1, ['k1']);
  call('facts', { ...base, intent: a.id, facts: Array.from({ length: 120 }, (_, k) => ({ text: `長い事実 ${k} ${'あ'.repeat(100)}`, method: 'refetch', evidence: 'e', verdict: 'accept' })) });
  const { summary } = call('summary', base);
  assert.ok(summary.length <= 8000, String(summary.length));
  assert.match(summary, /載せなかった項目（ヒントは次の周で渡す。他は CLI の get に種類を渡すと全件を引ける）: 事実 \d+ 件$/);
});

test('SP-BPCONFORMANCE-016・SP-BPCONFORMANCE-014: 試走の題材の CLI は、書き込みの鍵の無い状態の書き込みを拒否し、人間のヒントは書き込みの鍵でなく再開の鍵で受け付け、再開の鍵の無いヒントを拒否する', async (t) => {
  const { dir, base, resumeKey } = await begun(t);
  const { writeKey, ...noKey } = base;
  assert.equal(code('goal', { ...noKey, goal: '{}', origin: 'o', scope: ['src'] }), 'E_KEY');
  assert.equal(code('round', { ...noKey, round: 1, launches: 1, allFailed: false }), 'E_KEY');
  assert.equal(code('hint', { repo: dir, state: base.state, text: 'h' }), 'E_KEY');
  assert.equal(code('hint', { repo: dir, state: base.state, writeKey, text: 'h' }), 'E_KEY');
  assert.equal(call('hint', { repo: dir, state: base.state, resumeKey, text: 'h' }).id, 'H1');
  const log = readFileSync(logFile(dir, base.state), 'utf8');
  assert.ok(!log.includes(writeKey) && !log.includes(resumeKey));
});

test('SP-BPCONFORMANCE-011・SP-BPCONFORMANCE-014: 試走の題材は、run の前に開始した状態の ID と再開の鍵を利用者に返し、run の中の役が依頼文から開始を送り直しても、run の書き込みの鍵も再開の鍵も得られない', async (t) => {
  const dir = await repo(t);
  const request = 'テストが落ちる';
  const s = started(dir, request);
  assert.match(s.state, /^tc-[0-9a-f]{8}$/);
  assert.equal(code('active', { repo: dir }), 'E_INPUT');
  let stolen = null;
  const thief = { ...SCENARIOS.素直に完了, agent: (label) => { if (label === 'goal') stolen = cli('start', JSON.stringify({ repo: dir, request })).out; } };
  const r = await runArgs(t, thief, { state: s.state, repo: dir, skillDir: FIXTURE_DIR, resumeKey: s.resumeKey }, { concurrency: 1 });
  assert.equal(r.result.stopKind, 'complete', r.result.reason);
  assert.notEqual(stolen.state, s.state);
  assert.equal(code('resume', { repo: dir, state: s.state, resumeKey: stolen.resumeKey, limits: LIMITS }), 'E_KEY');
  assert.equal(code('goal', { repo: dir, state: s.state, run: 'r1', writeKey: stolen.resumeKey, goal: '{}', origin: 'o', scope: ['src'] }), 'E_KEY');
});

test('SP-BPCONFORMANCE-015: 試走の題材の CLI は、目標の数値条件の全てに受理済みの事実が当たらない完了の主張を却下し、周の違う同じ主張に前の却下を返さない', async (t) => {
  const { base } = await begun(t, { numeric: [{ text: '3 回中 3 回落ちる', value: 3 }] });
  const [a] = planned(base, 1, ['k1']);
  assert.equal(code('claim', { ...base, facts: ['P1'], numeric: [] }), 'E_INPUT');
  const before = call('claim', { ...base, round: 1, facts: ['P1'], numeric: [] });
  assert.equal(before.verdict, 'reject');
  assert.match(before.reason, /数値条件: 1/);
  call('facts', { ...base, intent: a.id, facts: [{ text: '3 回とも落ちた', method: 'rerun', evidence: 'npm test', verdict: 'accept' }] });
  const [, id] = /事実 (F\w+)/.exec(call('summary', base).summary);
  const after = call('claim', { ...base, round: 2, facts: [id], numeric: [{ condition: 1, fact: id }] });
  assert.equal(after.verdict, 'pending');
  assert.deepEqual(after.cited, [{ id, text: '3 回とも落ちた' }]);
  assert.match(after.goal, /3 回中 3 回落ちる/);
});

test('SP-BPCONFORMANCE-015: 試走の題材は、完了の照合の検証役に固定した目標と主張が挙げた事実の本文を渡す', async (t) => {
  const r = await runTarget(t, SCENARIOS.素直に完了, { concurrency: 1 });
  const prompt = r.prompts[r.calls.indexOf('completion')];
  assert.match(prompt, /固定した目標:\n\{"goal":"原因の説明"/);
  assert.match(prompt, /主張が挙げた受理済みの事実:\nF[0-9a-f]{12}: 事実 \d+-\d+/);
});

test('SP-BPCONFORMANCE-011・SP-BPCONFORMANCE-016: 試走の題材は、運搬役が CLI の出力でない行を返しても、agent() が失敗しても、BLOCKED の停止を状態に書いて止まる', async (t) => {
  const dir = await repo(t);
  const garbage = { ...SCENARIOS.素直に完了, agent: (label) => (/^carrier:.*\bfacts\b/.test(label) ? { responses: ['not json'] } : undefined) };
  const g = await runTarget(t, garbage, { concurrency: 1 });
  assert.equal(g.result.stopKind, 'blocked', g.result.reason);
  assert.equal(g.calls.at(-1), 'carrier:stop');
  assert.equal(logOf(dir, g.result.nextArgs.state).filter((x) => x.t === 'stop')[0].kind, 'blocked');
  const thrown = { ...SCENARIOS.素直に完了, agent: (label) => { if (label === 'planner') throw new Error('予算の超過'); } };
  const h = await runTarget(t, thrown, { concurrency: 1 });
  assert.deepEqual([h.result.stopKind, h.calls.at(-1)], ['blocked', 'carrier:stop']);
  assertRisks(h.result.residualRisks);
  const extraLost = { ...SCENARIOS.素直に完了, agent: (label) => (label === 'executor:extra' ? null : undefined) };
  const extraRun = await runTarget(t, { ...extraLost, fail: () => true, collect: false }, { concurrency: 1 });
  assert.deepEqual([extraRun.result.stopKind, extraRun.result.reason], ['blocked', '追加の実行役が結果を返さなかった']);
});

test('SP-BPCONFORMANCE-012・SP-BPCONFORMANCE-023: 試走の題材は、走っている意図の 1 件が停止を返したら新しい意図を始めず、走っている意図の終わりを待って止まる', async (t) => {
  const lost = { ...SCENARIOS.素直に完了, agent: (label) => (/^carrier:.*\bfacts\b/.test(label) ? { responses: [] } : undefined) };
  const r = await runTarget(t, lost, { concurrency: 1 });
  assert.ok(!r.calls.includes('executor:I4'), r.calls.join(' '));
  assert.equal(r.result.stopKind, 'blocked', r.result.reason);
  assert.equal(r.calls.at(-1), 'carrier:stop');
});

test('SP-BPCONFORMANCE-011・SP-BPCONFORMANCE-016: 試走の題材は、停止の運搬役の応答が失われても、nextArgs の再開で状態に書かれた完了を返し、書かれなかった停止を BLOCKED として足す', async (t) => {
  const dir = await repo(t);
  const written = { ...SCENARIOS.素直に完了, agent: (label, prompt) => { if (label === 'carrier:stop') { carry(prompt); return { responses: [] }; } } };
  const a = await runTarget(t, written, { concurrency: 1 });
  assert.equal(a.result.stopKind, 'blocked');
  const again = await runArgs(t, SCENARIOS.素直に完了, a.result.nextArgs);
  assert.deepEqual([again.result.stopKind, again.calls], ['complete', ['carrier:resume']], again.result.reason);
  assert.equal(again.result.cause.explanation, '原因');
  for (const k of ['coverage', 'skip', 'facts', 'pending', 'aborted', 'roundLaunches', 'residualRisks']) assert.ok(again.result[k] !== undefined, `完了を返す再開の返り値に ${k} が無い`);
  const log = logOf(dir, a.result.nextArgs.state);
  const stopped = log.find((x) => x.t === 'stop');
  assert.deepEqual(again.result.roundLaunches, [...log.filter((x) => x.t === 'round').map((x) => ({ round: x.n, launches: x.launches })), { round: stopped.round, launches: stopped.roundLaunches }]);
  assertRisks(a.result.residualRisks);
  const lost = { ...SCENARIOS.素直に完了, agent: (label) => (label === 'carrier:stop' ? null : undefined) };
  const b = await runTarget(t, lost, { concurrency: 1 });
  assert.equal(b.result.stopKind, 'blocked');
  const resumed = await runArgs(t, SCENARIOS.素直に完了, b.result.nextArgs);
  assert.equal(resumed.result.stopKind, 'complete', resumed.result.reason);
  assert.deepEqual(logOf(dir, b.result.nextArgs.state).filter((x) => x.t === 'stop').map((x) => [x.run, x.kind]), [['r1', 'blocked'], ['r2', 'complete']]);
});

test('SP-BPCONFORMANCE-012・SP-BPCONFORMANCE-020: 試走の題材は、返り値に周ごとの起動数を止まった周まで載せ、周の記録の後に止まった run に無い周を足さず、確かめられなかった制限を役ごと・配布先ごとに載せる', async (t) => {
  const outside = (r) => r.calls.findIndex((l) => l === 'carrier:summary');
  for (const [sc, stopKind, stopInRound] of [[SCENARIOS.回収役が拾う, 'complete', true], [{ ...SCENARIOS.素直に完了, claimAt: 99, intents: 0 }, 'dry', false]]) {
    const r = await runTarget(t, sc, { concurrency: 1 });
    assert.equal(r.result.stopKind, stopKind, r.result.reason);
    const rounds = r.result.roundLaunches;
    assert.equal(rounds.length, r.calls.filter((l) => l === 'planner').length, JSON.stringify(rounds));
    assert.deepEqual(rounds.map((x) => x.round), rounds.map((_, k) => k + 1));
    assert.equal(rounds.reduce((s, x) => s + x.launches, 0) + outside(r) + (stopInRound ? 0 : 1), r.result.launches, JSON.stringify(rounds));
    assertRisks(r.result.residualRisks);
  }
});

test('SP-BPCONFORMANCE-035: 試走の題材は、計画役とそれに当てた目標の固定役を最上位のモデルとその既定の effort で起動する', async (t) => {
  const r = await runTarget(t, SCENARIOS.素直に完了, { concurrency: 1 });
  for (const label of ['goal', 'planner']) {
    const o = r.options[r.calls.indexOf(label)];
    assert.deepEqual([o.model, o.effort], ['fable', 'high'], label);
  }
});

test('SP-BPCONFORMANCE-014・SP-BPCONFORMANCE-016: 試走の題材の CLI は、再開の鍵の無い再開を拒否し、走っている run を止めさせず書き込みの鍵も渡さない', async (t) => {
  const { dir, base, resumeKey } = await begun(t);
  assert.equal(code('resume', { repo: dir, state: base.state, limits: LIMITS }), 'E_KEY');
  assert.equal(code('resume', { repo: dir, state: base.state, resumeKey: 'x', limits: LIMITS }), 'E_KEY');
  assert.equal(logOf(dir, base.state).filter((x) => x.t === 'stop').length, 0);
  call('round', { ...base, round: 1, launches: 1, allFailed: false });
  assert.notEqual(call('resume', { repo: dir, state: base.state, resumeKey, limits: LIMITS }).run, base.run);
  const r = await runArgs(t, SCENARIOS.素直に完了, { state: base.state, repo: dir, skillDir: FIXTURE_DIR });
  assert.deepEqual([r.result.stopKind, r.calls.length], ['blocked', 0]);
});

test('SP-BPCONFORMANCE-011・SP-BPCONFORMANCE-010・SP-BPCONFORMANCE-017: 試走の題材は、目標・出発点・台帳を 1 回で書き、台帳の無い状態の再開では範囲の外の資産を足さずに目標の固定からやり直す', async (t) => {
  const { dir, base, resumeKey } = await opened(t);
  call('stop', { ...base, kind: 'needs_input', reason: '指示語', launches: 2 });
  const r = call('resume', { repo: dir, state: base.state, resumeKey, limits: LIMITS });
  assert.equal(r.request, 'r');
  const next = { ...base, run: r.run, writeKey: r.writeKey };
  assert.deepEqual(call('skip', next).skip, []);
  const g = call('goal', { ...next, goal: '{}', origin: 'o', scope: ['src'] });
  assert.equal(g.t, 'ledger');
  assert.deepEqual(call('skip', next).skip.sort(), ['src/a.js', 'src/b.js']);
  assert.deepEqual(logOf(dir, base.state).filter((x) => x.t === 'premise').map((x) => [x.id, x.kind]), [['P1', 'goal'], ['P2', 'origin']]);
  assert.equal(code('goal', { ...next, goal: '{}', origin: 'o', scope: [] }), 'E_INPUT');
  const asking = { ...SCENARIOS.素直に完了, agent: (label, _p, rec) => (label === 'goal' && !rec.asked ? (rec.asked = true, { goal: 'g', scope: ['src'], prohibitions: [], numeric: [], origin: 'o', missing: ['どのテストか'] }) : undefined) };
  const first = await runTarget(t, asking, { concurrency: 1 });
  assert.equal(first.result.stopKind, 'needs_input');
  const second = await runArgs(t, SCENARIOS.素直に完了, first.result.nextArgs, { concurrency: 1 });
  assert.deepEqual(second.calls.slice(0, 3), ['carrier:resume', 'goal', 'carrier:goal']);
  assert.equal(second.result.stopKind, 'complete', second.result.reason);
});

test('SP-BPCONFORMANCE-011・SP-BPCONFORMANCE-015: 試走の題材の CLI は、計画役に要約の外のヒントを get で引かせない', async (t) => {
  const { dir, base, resumeKey } = await begun(t);
  call('hint', { repo: dir, state: base.state, resumeKey, text: 'h' });
  assert.equal(code('get', { ...base, kind: '読まれていないヒント' }), 'E_INPUT');
  assert.equal(code('get', { ...base, id: 'H1' }), 'E_UNKNOWN_ID');
});

test('SP-BPCONFORMANCE-011: 試走の題材の CLI は、読まれた後に同じ本文のヒントを足すと新しいヒントとして未読に戻す', async (t) => {
  const { dir, base, resumeKey } = await begun(t);
  call('hint', { repo: dir, state: base.state, resumeKey, text: '同じ' });
  call('claim', { ...base, round: 1, facts: ['P1'], numeric: [], hintsRead: ['H1'] });
  const again = call('hint', { repo: dir, state: base.state, resumeKey, text: '同じ' });
  assert.equal(again.id, 'H2');
  assert.match(call('summary', base).summary, /読まれていないヒント H2: 同じ/);
});

// 調べるリポジトリを、コミットした内容・未コミットの変更・未追跡のファイル・無視するファイルを持つ形で作る。
async function dirtyRepo(t, extra = () => {}) {
  const src = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'bp-trial-copy-')));
  t.after(() => fs.rm(src, { recursive: true, force: true }));
  writeFileSync(path.join(src, 'a.txt'), 'committed\n');
  writeFileSync(path.join(src, '.gitignore'), 'ignored.txt\n');
  extra(src);
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'c']]) execFileSync('git', args, { cwd: src });
  writeFileSync(path.join(src, 'a.txt'), 'dirty\n');
  writeFileSync(path.join(src, 'new.txt'), 'untracked\n');
  writeFileSync(path.join(src, 'ignored.txt'), 'ignored\n');
  return src;
}

// 写しを作る状態を、再現手順のコマンドを記録して用意する。
function stateFor(src, commands) {
  const s = call('start', { repo: src, request: 'r', commands });
  const r = call('resume', { repo: src, state: s.state, resumeKey: s.resumeKey, limits: LIMITS });
  call('goal', { repo: src, state: s.state, run: r.run, writeKey: r.writeKey, goal: '{}', origin: 'o', scope: ['a.txt'] });
  return { state: s.state, workDir: r.workDir };
}

const status = (dir) => execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: dir, encoding: 'utf8' });

test('SP-BPCONFORMANCE-014・SP-BPCONFORMANCE-015: 試走の題材は、状態と作業ファイルと試行ごとの写しを対象のリポジトリの外に置き、写しを作業ツリーの今の内容から作り、作るときに対象の .git も作業ツリーも書かない', async (t) => {
  const r = await runTarget(t, SCENARIOS.素直に完了, { concurrency: 1 });
  const dir = await repo(t);
  assert.ok(!existsSync(path.join(dir, '.trace-cause')));
  const executor = r.prompts[r.calls.indexOf('executor:I1')];
  const [, workDir] = /作業ファイルの置き場: (\S+)/.exec(executor);
  assert.ok(!workDir.startsWith(dir), workDir);
  assert.ok(workDir.startsWith(workRootOf(dir)), workDir);
  assert.match(executor, /写しを作り直すコマンド（同じパスにあれば消して作り直す）: node '[^']+\/scripts\/copy\.mjs' make/);
  assert.match(executor, /写しの中で再現手順のコマンドを実行するコマンド（command に下の番号を書く）: node '[^']+\/scripts\/copy\.mjs' exec/);
  assert.match(executor, /^再現手順のコマンド:\n1: cat src\/a\.js$/m);
  assert.match(r.prompts[r.calls.indexOf('verifier:I1')], /"to":"[^"]+\/I1\.1\.verify"/);
  const src = await dirtyRepo(t);
  const before = status(src);
  const { workDir: runDir } = stateFor(src, ['cat a.txt']);
  const to = path.join(runDir, 'I1.1');
  make({ repo: src, to });
  writeFileSync(path.join(to, 'leftover.txt'), 'x\n');
  make({ repo: src, to });
  assert.deepEqual([readFileSync(path.join(to, 'a.txt'), 'utf8'), readFileSync(path.join(to, 'new.txt'), 'utf8')], ['dirty\n', 'untracked\n']);
  assert.deepEqual([existsSync(path.join(to, 'ignored.txt')), existsSync(path.join(to, 'leftover.txt'))], [false, false]);
  assert.ok(!existsSync(path.join(src, '.git', 'worktrees')));
  assert.equal(status(src), before);
});

test('SP-BPCONFORMANCE-015・SP-BPCONFORMANCE-014: 試走の題材の写しは、決まった形の写し先にだけ作り、途中の symlink や対象のリポジトリの symlink を通って置き場の外を消さない', async (t) => {
  const victim = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'bp-trial-victim-')));
  t.after(() => fs.rm(victim, { recursive: true, force: true }));
  await fs.mkdir(path.join(victim, 'important'));
  writeFileSync(path.join(victim, 'important', 'data.txt'), 'precious\n');
  const src = await dirtyRepo(t, (d) => symlinkSync(victim, path.join(d, 'out')));
  const { state, workDir } = stateFor(src, []);
  const to = path.join(workDir, 'I1.1');
  make({ repo: src, to });
  for (const bad of [path.join(to, 'out', 'important'), workDir, path.dirname(workDir), path.join(workDir, 'I1.1', '..', '..', 'r1'), path.join(workDir, 'notes'), path.join(src, 'copy'), path.join(workRootOf(src), 'tc-00000000', 'r1', 'I1.1')]) {
    assert.throws(() => make({ repo: src, to: bad }), /写し先|状態/, bad);
  }
  const linked = path.join(workRootOf(src), state, 'r9');
  symlinkSync(victim, linked);
  assert.throws(() => make({ repo: src, to: path.join(linked, 'important') }), /写し先/);
  assert.throws(() => make({ repo: src, to: path.join(linked, 'I1.1') }), /symlink/);
  assert.equal(readFileSync(path.join(victim, 'important', 'data.txt'), 'utf8'), 'precious\n');
});

test('SP-BPCONFORMANCE-014・SP-BPCONFORMANCE-015: 試走の題材は、run の前の開始で記録した再現手順のコマンドだけを写しの中で実行し、run の中では足させず、写しの中の git は置き場の上のリポジトリへ上がらない', async (t) => {
  const outer = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'bp-trial-outer-')));
  t.after(() => fs.rm(outer, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: outer });
  const saved = process.env.TRACE_CAUSE_HOME;
  process.env.TRACE_CAUSE_HOME = path.join(outer, 'home');
  t.after(() => { process.env.TRACE_CAUSE_HOME = saved; });
  const src = await dirtyRepo(t);
  const { workDir } = stateFor(src, ['pwd; cat a.txt', 'git rev-parse --show-toplevel']);
  const to = path.join(workDir, 'I1.1');
  make({ repo: src, to });
  const ran = exec({ repo: src, to, command: 1 });
  assert.deepEqual([ran.code, ran.stdout], [0, `${to}\ndirty\n`]);
  assert.equal(exec({ repo: src, to, command: 2 }).stdout.trim(), to);
  for (const bad of [0, 3, 'cat a.txt', '1']) assert.throws(() => exec({ repo: src, to, command: bad }), /command は再現手順のコマンドの番号/, String(bad));
  assert.throws(() => exec({ repo: src, to: path.join(workDir, 'I2.1'), command: 1 }), /写しが無い/);
  assert.equal(code('start', { repo: src, request: 'r' }), 'E_INPUT');
  const { base } = await begun(t);
  call('goal', { ...base, goal: JSON.stringify({ goal: 'g', scope: ['src'], prohibitions: [], numeric: [] }), origin: 'o', scope: ['src'], commands: ['touch x'] });
  assert.deepEqual(call('summary', base).commands, []);
  assert.ok(!logOf(base.repo, base.state).some((x) => x.t !== 'start' && 'commands' in x));
  const skill = readFileSync(path.join(FIXTURE_DIR, 'SKILL.md'), 'utf8').split('## 必要な許可')[1].split('\n## ')[0];
  assert.ok(!/^- 依頼文の再現手順のコマンド/m.test(skill), '再現手順のコマンドをそのまま実行する許可が残る');
});

test('SP-BPCONFORMANCE-014・SP-BPCONFORMANCE-016: 試走の題材の書き込みの許可は作業ファイルの置き場だけを覆い、状態のファイルはその外にあり、読み出しの許可は作業ファイル・リポジトリ・役の指示を覆う', async (t) => {
  const { dir, base } = await begun(t);
  const skill = readFileSync(path.join(FIXTURE_DIR, 'SKILL.md'), 'utf8').split('## 必要な許可')[1].split('\n## ')[0];
  const writes = [...skill.matchAll(/`Write\(<状態の置き場>\/([^)]*)\)`/g)].map(([, g]) => g);
  assert.deepEqual(writes, ['runs/**']);
  for (const g of ['<状態の置き場>/runs/**', '<リポジトリ>/**', '<このスキルのディレクトリ>/**']) assert.ok(skill.includes(`\`Read(${g})\``), g);
  const home = process.env.TRACE_CAUSE_HOME;
  assert.ok(workRootOf(dir).startsWith(path.join(home, 'runs') + path.sep), workRootOf(dir));
  assert.ok(!logFile(dir, base.state).startsWith(path.join(home, 'runs') + path.sep), logFile(dir, base.state));
});

test('SP-BPCONFORMANCE-015: 試走の題材の設計の説明は、意図の工程を pipeline() の 1 item と同じ性質で流すことを、設計方針文書の行の句ごとに示す', () => {
  const text = readFileSync(path.join(FIXTURE_DIR, 'references', 'design.md'), 'utf8');
  for (const clause of ['「意図ごとに 1 item として流し、工程の間で item を待たせない」', '「待つのは周の終わりだけ」', '「同時実行の上限で待つ item は、枠が空くたびに始める」']) assert.ok(text.includes(clause), clause);
});

test('SP-BPCONFORMANCE-016: 試走の題材の CLI の既知の事実のキーは、空白と文の区切りの違いを同じ事実と数え、数の中の小数点と桁の区切りと、数と数の間の区切りは区別する', async (t) => {
  const { base } = await begun(t);
  const [a, b] = planned(base, 1, ['k1', 'k2']);
  call('facts', { ...base, intent: a.id, facts: [{ text: '待ち時間は 1.5 秒。', method: 'rerun', evidence: 'e', verdict: 'accept' }, { text: '版は 1,200 件', method: 'rerun', evidence: 'e', verdict: 'reject' }, { text: '引数は 1, 2', method: 'rerun', evidence: 'e', verdict: 'accept' }, { text: 'ポートは 80 80', method: 'rerun', evidence: 'e', verdict: 'accept' }] });
  call('facts', { ...base, intent: b.id, facts: [{ text: '待ち時間は 15 秒', method: 'rerun', evidence: 'e', verdict: 'accept' }, { text: '待ち時間は1.5秒', method: 'rerun', evidence: 'e', verdict: 'accept' }, { text: '版は 1200 件', method: 'rerun', evidence: 'e', verdict: 'accept' }, { text: '引数は 12', method: 'rerun', evidence: 'e', verdict: 'reject' }, { text: 'ポートは 8080', method: 'rerun', evidence: 'e', verdict: 'reject' }] });
  const log = logOf(base.repo, base.state);
  assert.equal(log.filter((x) => x.t === 'fact').length, 8);
  assert.equal(log.filter((x) => x.t === 'known').length, 1);
  assert.equal(log.filter((x) => x.t === 'dispute').length, 0);
});

test('SP-BPCONFORMANCE-016: 試走の題材は、同じ事実の判定が意図の間で食い違っても最初の判定を残して食い違いを記録し、事実と意図の終わりを 1 回で書き、理由つきの BLOCKED で止まる', async (t) => {
  const { base } = await begun(t);
  const [a, b] = planned(base, 1, ['k1', 'k2']);
  call('facts', { ...base, intent: a.id, facts: [{ text: '同じ事実', method: 'refetch', evidence: 'e', verdict: 'accept' }] });
  const w = call('facts', { ...base, intent: b.id, facts: [{ text: '同じ事実', method: 'refetch', evidence: 'e2', verdict: 'reject' }] });
  assert.equal(w.disputes.length, 1);
  assert.match(call('summary', base).summary, /判定の食い違い F\w+: 受理と却下（意図 I2）/);
  assert.equal(logOf(base.repo, base.state).filter((x) => x.t === 'done').length, 2);
  let n = 0;
  const sc = { ...SCENARIOS.素直に完了, facts: 1, agent: (label, prompt) => {
    if (label.startsWith('executor:I')) return { facts: [{ text: '同じ事実', method: 'refetch', evidence: 'e' }], blank: false, seen: ['src/a.js'] };
    if (label.startsWith('verifier:')) { n += 1; return { verdicts: [{ candidate: 0, verdict: n === 1 ? 'accept' : 'reject', reason: 'r' }] }; }
  } };
  const r = await runTarget(t, sc, { concurrency: 1 });
  assert.equal(r.result.stopKind, 'blocked');
  assert.match(r.result.reason, /判定が意図の間で食い違った: F\w+/);
});

test('SP-BPCONFORMANCE-016: 試走の題材の CLI は、終わった CLI が残した排他と、中身が空のまま残った排他や持ち主の pid が使い回された古い排他を取り直す', async (t) => {
  const { base } = await begun(t);
  const lock = path.join(path.dirname(logFile(base.repo, base.state)), 'lock');
  const old = new Date(Date.now() - 3600_000);
  for (const [n, body, stale] of [[1, '2147483646', false], [2, '', true], [3, String(process.pid), true]]) {
    writeFileSync(lock, body);
    if (stale) utimesSync(lock, old, old);
    const t0 = process.hrtime.bigint();
    call('round', { ...base, round: n, launches: 1, allFailed: false });
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1000, `排他 ${JSON.stringify(body)} を取り直さない`);
    assert.ok(!existsSync(lock));
  }
});

test('SP-BPCONFORMANCE-023: 試走の題材は、最小の起動数の上限で 1 件の意図を始め、最小の起動数から意図の最悪を抜く変異を見つける', async (t) => {
  const startsAtMin = async (root) => {
    const r = await runTarget(t, SCENARIOS.意図1件が最悪を使い切る, { limit: await minOf(t, SCENARIOS.意図1件が最悪を使い切る, root), concurrency: 1, root });
    return r.calls.some((l) => l.startsWith('executor:I'));
  };
  assert.ok(await startsAtMin(FIXTURE_DIR));
  const root = await mutant(t, (s) => s.replace('const MIN_LAUNCHES = WORST.start + WORST.goal + WORST.plan + WORST.item + RESERVE', 'const MIN_LAUNCHES = WORST.start + WORST.goal + WORST.plan + RESERVE'));
  assert.ok(!(await startsAtMin(root)), '最小の起動数から意図の最悪を抜いた変異が 1 件の意図を始める');
});

test('SP-BPCONFORMANCE-011: 試走の題材は、目標の固定役が足りない入力を返して止まった状態を、足したヒントを目標の固定役に渡して再開し、同じ理由ですぐに止まらず、ヒントを計画役に読ませる', async (t) => {
  const answer = 'npm test の auth.test.js';
  const goal = (label, prompt) => (label === 'goal' ? { goal: 'g', scope: ['src'], prohibitions: [], numeric: [], origin: 'o', missing: prompt.includes(answer) ? [] : ['どのテストか'] } : undefined);
  const sc = { ...SCENARIOS.素直に完了, agent: goal };
  const first = await runTarget(t, sc, { concurrency: 1 });
  assert.equal(first.result.stopKind, 'needs_input', first.result.reason);
  call('hint', { repo: first.result.nextArgs.repo, state: first.result.nextArgs.state, resumeKey: first.result.nextArgs.resumeKey, text: answer });
  const second = await runArgs(t, sc, first.result.nextArgs, { concurrency: 1 });
  assert.match(second.prompts[second.calls.indexOf('goal')], /利用者が足したヒント（足りない入力への答え）:\nH1: npm test の auth\.test\.js/);
  assert.equal(second.result.stopKind, 'complete', second.result.reason);
  assert.match(second.prompts[second.calls.indexOf('planner')], /読まれていないヒント H1: npm test/);
});

test('SP-BPCONFORMANCE-016: 試走の題材の CLI は、1 回の書き込みの記録を 1 行で足し、途中で落ちた書き込みを丸ごと無かったことにして、目標を 1 組だけ持つ', async (t) => {
  const { dir, base, resumeKey } = await opened(t);
  const file = logFile(dir, base.state);
  const torn = JSON.stringify([{ t: 'premise', run: base.run, id: 'P1', kind: 'goal', text: '{"goal":"first"}' }, { t: 'premise', run: base.run, id: 'P2', kind: 'origin', text: 'o1' }, { t: 'ledger', run: base.run, scope: ['src'] }]);
  writeFileSync(file, readFileSync(file, 'utf8') + torn.slice(0, torn.indexOf('{"t":"ledger"')));
  call('stop', { ...base, kind: 'blocked', reason: '運搬役が落ちた', launches: 2 });
  const r = call('resume', { repo: dir, state: base.state, resumeKey, limits: LIMITS });
  assert.equal(r.request, 'r');
  const next = { ...base, run: r.run, writeKey: r.writeKey };
  call('goal', { ...next, goal: '{"goal":"second"}', origin: 'o2', scope: ['src'] });
  assert.deepEqual(logOf(dir, base.state).filter((x) => x.t === 'premise').map((x) => [x.id, x.text]), [['P1', '{"goal":"second"}'], ['P2', 'o2']]);
  assert.equal(call('claim', { ...next, round: 1, facts: ['P1'], numeric: [] }).goal, '{"goal":"second"}');
  const batches = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(batches.every(Array.isArray));
  assert.equal(batches.filter((b) => b.some((x) => x.t === 'premise')).length, 1);
  assert.ok(batches.some((b) => ['premise', 'asset', 'ledger'].every((t) => b.some((x) => x.t === t))), '目標の書き込みが 1 行にそろわない');
});

test('SP-BPCONFORMANCE-016: 試走の題材は、判定の食い違いで止まった状態を再開すると、計画役の確かめ直しの意図の検証役の判定で食い違いを解き、同じ食い違いで止まり続けない', async (t) => {
  let verdicts = 0;
  const fact = '設定は A を読む';
  const executor = (label) => (label.startsWith('executor:I') ? { facts: [{ text: fact, method: 'refetch', evidence: 'src/a.js:1' }], blank: false, seen: ['src/a.js'] } : undefined);
  const split = { ...SCENARIOS.素直に完了, claimAt: 99, agent: (label, prompt) => executor(label) ?? (label.startsWith('verifier:') ? { verdicts: [{ candidate: 0, verdict: (verdicts += 1) === 1 ? 'reject' : 'accept', reason: 'r' }] } : undefined) };
  const first = await runTarget(t, split, { concurrency: 1 });
  assert.equal(first.result.stopKind, 'blocked');
  assert.match(first.result.reason, /判定が意図の間で食い違った: (F\w+)/);
  const [, id] = /判定が意図の間で食い違った: (F\w+)/.exec(first.result.reason);
  const recheck = { ...SCENARIOS.素直に完了, agent: (label, prompt, rec) => {
    if (label === 'planner' && /判定の食い違い F/.test(prompt) && !rec.planned) { rec.planned = true; return { kind: 'intents', intents: [{ key: 'recheck', text: '確かめ直す', basis: ['P1'], rank: 1, recheck: id }], rerank: [] }; }
    if (label.startsWith('executor:I')) return { facts: [], blank: true, seen: ['src/a.js'] };
    if (label.startsWith('verifier:')) { assert.match(prompt, new RegExp(`^0: \\{"text":"${fact}"`, 'm')); return { verdicts: [{ candidate: 0, verdict: 'accept', reason: 'r' }] }; }
  } };
  const second = await runArgs(t, recheck, first.result.nextArgs, { concurrency: 1 });
  assert.match(second.prompts[second.calls.indexOf('executor:I3')] ?? second.prompts[second.calls.findIndex((l) => l.startsWith('executor:I'))], new RegExp(`確かめ直す事実.*${id}: ${fact}`));
  assert.equal(second.result.stopKind, 'complete', second.result.reason);
  assert.ok(second.result.facts.some((f) => f.id === id), JSON.stringify(second.result.facts));
  const { base } = await begun(t);
  assert.equal(code('plan', { ...base, round: 1, intents: [{ key: 'x', text: 'x', basis: ['P1'], rank: 1, recheck: id }], rerank: [], hintsRead: [] }), 'E_UNKNOWN_ID');
  verdicts = 0;
  const again = await runTarget(t, split, { concurrency: 1 });
  const [, id2] = /判定が意図の間で食い違った: (F\w+)/.exec(again.result.reason);
  const verbatim = { ...SCENARIOS.素直に完了, agent: (label, prompt, rec) => {
    if (label === 'planner' && /判定の食い違い F/.test(prompt) && !rec.planned) { rec.planned = true; return { kind: 'intents', intents: [{ key: 'recheck', text: '確かめ直す', basis: ['P1'], rank: 1, recheck: id2 }], rerank: [] }; }
    if (label.startsWith('executor:I')) return { facts: [{ text: fact, method: 'rerun', evidence: '新しい証拠' }], blank: false, seen: ['src/a.js'] };
    if (label.startsWith('verifier:')) {
      assert.equal([...prompt.matchAll(/^\d+: \{/gm)].length, 1, prompt);
      return { verdicts: [{ candidate: 0, verdict: 'accept', reason: 'r' }] };
    }
  } };
  const third = await runArgs(t, verbatim, again.result.nextArgs, { concurrency: 1 });
  assert.equal(third.result.stopKind, 'complete', third.result.reason);
});

test('SP-BPCONFORMANCE-015: 試走の題材の CLI は、検証不能の方式の事実を受理と書かれても受理せず、要約の検証不能に載せて根拠に使わせない', async (t) => {
  const { base } = await begun(t);
  const [a] = planned(base, 1, ['k1']);
  call('facts', { ...base, intent: a.id, facts: [{ text: '時間で変わる値', method: 'unverifiable', evidence: 'e', verdict: 'accept' }] });
  const { summary } = call('summary', base);
  const [, id] = /検証不能 (F\w+): 時間で変わる値/.exec(summary) ?? [];
  assert.ok(id, summary);
  assert.ok(!/^事実 F/m.test(summary), summary);
  assert.equal(code('plan', { ...base, round: 2, intents: [{ key: 'k2', text: 't', basis: [id], rank: 1 }], rerank: [], hintsRead: [] }), 'E_UNKNOWN_ID');
});

test('SP-BPCONFORMANCE-015: 試走の題材は、空振りの意図を要約と get の種類に載せ、実行役に既知の事実を引く読み出しの CLI を渡す', async (t) => {
  const { base } = await begun(t);
  const [a] = planned(base, 1, ['k1']);
  call('done', { ...base, intent: a.id, blank: true });
  assert.match(call('summary', base).summary, new RegExp(`^空振り ${a.id}: k1$`, 'm'));
  assert.deepEqual(call('get', { ...base, kind: '空振り' }).lines, [`空振り ${a.id}: k1`]);
  const r = await runTarget(t, SCENARIOS.素直に完了, { concurrency: 1 });
  const executor = r.prompts[r.calls.indexOf('executor:I1')];
  const [, req] = /既知の事実を引く CLI（読み出しだけ）: node '[^']+\/scripts\/state\.mjs' get <<'EOF'\n(.*)\nEOF/.exec(executor) ?? [];
  assert.ok(req, executor);
  assert.equal(JSON.parse(req).kind, '事実');
  assert.equal(cli('get', req).out.ok, true);
});

test('SP-BPCONFORMANCE-017: 試走の題材の CLI は、実行役が返すパスの書き方（./ の有無・絶対パス・symlink を通る綴り）によらず同じ資産に結び付け、リポジトリの外のパスを資産にしない', async (t) => {
  const { dir, base } = await begun(t);
  call('seen', { ...base, round: 1, pass: 1, extra: true, paths: ['./src/a.js', path.join(dir, 'src', 'b.js'), '../outside.js', '/etc/hosts'] });
  assert.deepEqual(call('skip', base), { ok: true, op: 'skip', skip: [], coverage: '2/2' });
  const alias = path.join(realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'bp-trial-alias-'))), 'repo');
  t.after(() => fs.rm(path.dirname(alias), { recursive: true, force: true }));
  symlinkSync(dir, alias);
  assert.deepEqual(call('summary', { repo: alias, state: base.state }).premises.split('\n')[0], '前提 P1（目標）: {"goal":"g","scope":["src"],"prohibitions":[],"numeric":[]}');
});
