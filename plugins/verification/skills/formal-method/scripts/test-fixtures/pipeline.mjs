// 結合のケースの共通の準備: 対象の作業ツリー、PATH の偽の z3、担当の harness、start から terminal まで。
import { chmodSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cliEnv, drive, makeWorkspace, removeTree } from './cli-runner.mjs';
import { makeFakeBin, pathWithFake, pathWithout } from './make-fake-bin.mjs';
import { defaultScenario, makeHarness } from './agent-harness.mjs';

export const SPEC_TEXT = '# 対象\nR1: x の 2 乗は常に 0 以上である。\nR2: y は x より大きい。\nR3: z は 0 でない。\nR4: w は 10 未満である。\n';

export function setupWorkspace(files = { 'target/spec.md': SPEC_TEXT }) {
  const ws = makeWorkspace();
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(ws, p)), { recursive: true });
    writeFileSync(join(ws, p), content);
  }
  return ws;
}

export const canonicalRequest = (over = {}) => ({
  targets: [{ id: 'T1', location: 'target' }],
  goals: [{ id: 'G1', text: 'R1 が成り立つ' }],
  ...over,
});

export function readFakeLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// tool: 'fake'（既定）| 'always-unsat' | 'absent'
// tag: 偽の z3 の起動の引数に付ける印（ps の標本で、この run の道具だけを数える）
// env: 子に足す環境変数（実行体の差し替え FORMAL_METHOD_CORE_BIN など）
export async function runScenario(t, { files, request = canonicalRequest(), scenario = {}, tool = 'fake', ci = false, hooks = {}, onStatus = null, tag = null, env: extraEnv = {} } = {}) {
  const ws = setupWorkspace(files);
  const bin = join(ws, '..', `${ws.split('/').pop()}-bin`);
  const log = join(bin, 'calls.jsonl');
  let path;
  if (tool === 'absent') path = pathWithout(['z3']);
  else path = pathWithFake(makeFakeBin(bin, { mode: tool === 'always-unsat' ? 'always-unsat' : null, log, tag }));
  const env = cliEnv({ path, ci, extra: { FM_TEST_MARKER: 'must-not-reach-tool', ...extraEnv } });
  const harness = makeHarness(defaultScenario(scenario), hooks);
  if (t) t.after(() => { removeTree(ws); removeTree(bin); });
  const out = await drive(ws, request, { env, onAgents: (s) => harness.onAgents(s, {}), onStatus });
  return { ...out, ws, env, harness, logPath: log, log: () => readFakeLog(log) };
}

// 実行体を包む偽の実行体（#264 SP-264-004 の CoreError の経路）。fail のサブコマンドだけ exit 3 で終え、他は本物の実行体に渡す。
// 本物は FORMAL_METHOD_CORE_BIN（make の TEST_ENV が置く）か、PATH の formal-method-core
export function wrapCore(dir, { fail }) {
  const real = process.env.FORMAL_METHOD_CORE_BIN
    ?? (process.env.PATH ?? '').split(':').map((d) => join(d, 'formal-method-core')).find((p) => existsSync(p));
  if (!real) throw new Error('本物の formal-method-core が無い（make test が FORMAL_METHOD_CORE_BIN を置く）');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'formal-method-core');
  const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
  writeFileSync(p, `#!/bin/sh\nif [ "$1" = ${q(fail)} ]; then cat > /dev/null; echo 'wrapped failure' >&2; exit 3; fi\nexec ${q(real)} "$@"\n`);
  chmodSync(p, 0o755);
  return p;
}
