// tests/bp-trial-target-budget*.test.mjs が共有する、試走の題材を模擬の runner で走らせる道具。
// 読み込んだテストファイルの process ごとに、状態の置き場（TRACE_CAUSE_HOME）を一時ディレクトリに向ける。
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, promises as fs, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workflow } from '../../plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs';
import { FIXTURE_DIR } from '../../tools/read-bp-trial.mjs';
import { main as cli, logOf as logPath, startMain, workRootOf } from '../fixtures/bp-trial/review-target/scripts/state.mjs';
import { read as gitRead } from '../fixtures/bp-trial/review-target/scripts/git-read.mjs';
import { exec, make } from '../fixtures/bp-trial/review-target/scripts/copy.mjs';

// 題材の状態の置き場は利用者のホームの下が既定なので、テストの間は一時ディレクトリに向ける。
export const HOME = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bp-trial-home-')));
process.env.TRACE_CAUSE_HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));

// 試走の題材は、仕込む前に判定表の 15 行目の全ての単位に適合していなければならない（基準の run を 0 件にする前提）。
// 判断でなく数と記録で決まる単位は、題材の script を模擬の runner で走らせ、状態の CLI を直接呼んで照らす。
export const COMMAND = /node '[^']+' (\S+) <<'EOF'\n(.*)\nEOF/g;
export const FILES = ['src/a.js', 'src/b.js', 'test/a.test.js'];

const repos = new WeakMap();

// 状態は状態 ID ごとに分かれるので、1 本のテストの run は同じリポジトリを使う（毎回 git init すると総当たりが遅い）。
export function repo(t) {
  // 同時に走る run が初回に揃って git init しないよう、作りかけの Promise を覚える。
  if (!repos.has(t)) repos.set(t, makeRepo(t));
  return repos.get(t);
}

async function makeRepo(t) {
  const dir = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'bp-trial-repo-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const f of FILES) {
    await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await fs.writeFile(path.join(dir, f), 'x\n');
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  return dir;
}

export const carry = (prompt) => ({ responses: [...prompt.matchAll(COMMAND)].map(([, op, text]) => JSON.stringify(cli(op, text).out)) });

// 題材の役の答え方の組。どれも、起動が増える方向（試行の失敗・回収・却下・追加の実行）を含む。
export const SCENARIOS = {
  素直に完了: { fail: () => false, facts: 2, claimAt: 2, accept: () => true },
  実行役が全て失敗: { fail: () => true, collect: false, facts: 1, claimAt: 99, accept: () => true },
  回収役が拾う: { fail: (n) => n % 2 === 0, collect: true, facts: 3, claimAt: 3, accept: () => true },
  検証役が欠ける: { fail: () => false, verifierFails: (n) => n % 3 === 0, facts: 2, claimAt: 3, accept: () => true },
  完了の主張の却下: { fail: () => false, facts: 1, claimAt: 2, accept: () => false },
  意図1件が最悪を使い切る: { intents: 1, fail: () => true, collect: true, verifierFails: () => true, facts: 1, claimAt: 99, accept: () => true },
};

export function backend(sc, rec) {
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

export async function runArgs(t, sc, args, { concurrency = 3, root = FIXTURE_DIR } = {}) {
  const dir = await repo(t);
  const rec = { calls: [], prompts: [], options: [] };
  const runDir = path.join(await fs.mkdtemp(path.join(dir, '.workflow-run-')), 'run');
  const result = await Workflow({ scriptPath: path.join(root, 'scripts', 'trace.js'), args }, {
    backend: backend(sc, rec), trustedSource: true, runDir, maxAgents: 1000, concurrency, timeoutMs: 120000, maxOutputBytes: 100_000_000, requirements: ['workspace-write'],
  });
  return { result, ...rec };
}

// 状態は SKILL.md の「起動」のとおり、呼び出し元が run の前に CLI の start で作る。
export function started(dir, request = 'テスト a が落ちる原因を調べる', commands = ['cat src/a.js']) {
  const { out } = startMain(JSON.stringify({ repo: dir, request, commands }));
  assert.equal(out.ok, true, JSON.stringify(out));
  return out;
}

export async function runTarget(t, sc, { limit, concurrency = 3, root = FIXTURE_DIR, request } = {}) {
  const dir = await repo(t);
  const s = started(dir, request);
  const args = { state: s.state, repo: dir, skillDir: root, resumeKey: s.resumeKey, ...(limit === undefined ? {} : { maxLaunches: limit }) };
  return runArgs(t, sc, args, { concurrency, root });
}

export const logFile = (dir, state) => logPath(dir, state);
export const logOf = (dir, state) => readFileSync(logFile(dir, state), 'utf8').split('\n').filter(Boolean).flatMap((l) => JSON.parse(l));

export function worstOf(root) {
  const text = readFileSync(path.join(root, 'scripts', 'trace.js'), 'utf8');
  const constant = (name) => /const (\w+) = (\{[^}]*\}|\d+)\n/g;
  const values = {};
  for (const [, name, body] of text.matchAll(constant())) values[name] = body;
  const attempts = Number(values.MAX_ATTEMPTS);
  return { worst: new Function('MAX_ATTEMPTS', `return ${values.WORST}`)(attempts), reserve: Number(values.RESERVE) };
}

// 同時実行 1 では、上限を渡した run の起動は上限の無い run の起動の頭と同じ並びになる。起動の単位はその先頭の起動で分かる。
export const UNIT_OF = [
  [/^carrier:resume$/, 'start'],
  [/^goal$/, 'goal'],
  [/^carrier:summary$/, 'plan'],
  [/^executor:I/, 'item'],
  [/^executor:extra$/, 'extra'],
  [/^carrier:skip$/, 'scan'],
  [/^carrier:round$/, 'round'],
  [/^carrier:stop$/, 'stop'],
];

export function segments(calls) {
  const out = [];
  for (const label of calls) {
    const kind = UNIT_OF.find(([re]) => re.test(label))?.[1];
    const sameItem = kind === 'item' && out.at(-1)?.kind === 'item' && out.at(-1).labels[0] === label;
    if (kind && !sameItem) out.push({ kind, labels: [label] });
    else out.at(-1).labels.push(label);
  }
  return out;
}

export const minOf = async (t, sc, root) => Number(/最小の起動数 (\d+)/.exec((await runTarget(t, sc, { limit: 1, concurrency: 1, root })).result.reason)[1]);

// 総当たりの run は互いに独立（run ごとに状態 ID と runDir を新しく作り、役の答えは run ごとの backend が数える）なので、
// SWEEP_POOL 本ずつ同時に回す。1 本ずつ回すと、時間の大半は worker の起動と git の待ちになる。
export const SWEEP_POOL = 4;

// items を size 本ずつ同時に fn へ渡し、結果を items の順に返す。stop() が true になったら新しく始めない。
// fn が throw したら新しく始めず、走っている分の終わりを待ってから最初の誤りを投げる（後始末が走りかけの run の
// 作業ディレクトリを消さないため）。
export async function pool(items, size, fn, stop = () => false) {
  const out = new Array(items.length);
  let next = 0;
  let failed = false;
  const settled = await Promise.allSettled(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length && !failed && !stop()) {
      const i = next++;
      try { out[i] = await fn(items[i]); } catch (error) { failed = true; throw error; }
    }
  }));
  const rejected = settled.find((r) => r.status === 'rejected');
  if (rejected) throw rejected.reason;
  return out;
}

// 上限を最小の起動数から上限の無い run の起動数まで総当たりで渡し、上限・停止の記録・理由の契約に反した run を返す。
// first なら、反した run が見つかった後は新しい run を始めない（返すのは見つかった分）。
export async function sweep(t, root, { concurrencies = [1, 3], first = false, refused } = {}) {
  const groups = Object.entries(SCENARIOS).flatMap(([name, sc]) => concurrencies.map((concurrency) => ({ name, sc, concurrency })));
  await pool(groups, SWEEP_POOL, async (g) => {
    g.free = await runTarget(t, g.sc, { concurrency: g.concurrency, root });
    g.min = await minOf(t, g.sc, root);
  });
  const runs = groups.flatMap((g) => Array.from({ length: Math.max(0, g.free.calls.length + 2 - g.min) }, (_, k) => ({ ...g, limit: g.min + k })));
  let found = false;
  const problems = await pool(runs, SWEEP_POOL, async ({ name, sc, concurrency, free, limit }) => {
    const { result, calls } = await runTarget(t, sc, { limit, concurrency, root });
    const label = `${name}・同時実行 ${concurrency}・上限 ${limit}`;
    let problem = null;
    if (calls.length > limit) problem = `${label}: ${calls.length} 体`;
    else if (result.launches !== calls.length) problem = `${label}: launches ${result.launches} と起動 ${calls.length} が違う`;
    else if (!calls.at(-1)?.startsWith('carrier:stop')) problem = `${label}: 最後の起動が停止の運搬役でない（${calls.at(-1)}）`;
    else if (result.stopKind === 'iteration_limit' && /起動数の上限/.test(result.reason)
      && !(new RegExp(`起動数の上限 ${limit} で止まった（その時点の起動数 \\d+）。残した意図 \\d+ 件`).test(result.reason) && JSON.stringify(Object.keys(result.nextArgs).sort()) === '["repo","resumeKey","skillDir","state"]')) problem = `${label}: 理由か nextArgs が契約と違う（${result.reason}）`;
    if (refused && concurrency === 1 && calls.length <= free.calls.length) {
      const next = segments(free.calls.slice(0, calls.length)).at(-1);
      if (next && free.calls[calls.length - 1] === next.labels[0] && next.labels.length === 1) refused.add(`${next.kind}${free.calls.slice(0, calls.length - 1).includes('carrier:round') ? '（2 周目以降）' : ''}`);
    }
    if (problem) found = true;
    return problem;
  }, () => first && found);
  return problems.filter(Boolean);
}

// 上限の無い run の起動を単位に分け、単位の種類ごとの実測の最悪を返す。
export async function measured(t, root) {
  const max = {};
  const runs = await pool(Object.values(SCENARIOS), SWEEP_POOL, (sc) => runTarget(t, sc, { concurrency: 1, root }));
  for (const { calls } of runs) {
    for (const s of segments(calls)) max[s.kind] = Math.max(max[s.kind] ?? 0, s.labels.length);
  }
  return max;
}

export const sequential = (t, root = FIXTURE_DIR) => mutant(t, (s) => s.replace('const CONCURRENCY = 3\n', 'const CONCURRENCY = 1\n'), root);

// 単位への切り分けは起動の並びで行うので、意図を 1 件ずつ走らせる写しで測る（最悪の数は同時実行の数によらない）。
// max を渡すと測り直さない。上限の無い run は WORST・RESERVE を読まない（trace.js の launchBudget.fits は上限が無ければ
// 即座に通し、MIN_LAUNCHES の照合も上限があるときだけ行う）ので、定数だけを変えた写しの実測は元の写しの実測と同じになる。
export async function tightness(t, root, max) {
  const { worst, reserve } = worstOf(root);
  max ??= await measured(t, root);
  const bad = Object.entries(worst).filter(([k, w]) => max[k] !== w).map(([k, w]) => `${k}: 定数 ${w}・実測の最悪 ${max[k]}`);
  if (max.stop !== reserve) bad.push(`予約分: 定数 ${reserve}・実測 ${max.stop}`);
  return bad;
}

export async function mutant(t, edit, from = FIXTURE_DIR) {
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
