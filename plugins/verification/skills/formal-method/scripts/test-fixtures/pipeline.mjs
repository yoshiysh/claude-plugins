// 結合のケースの共通の準備: 対象の作業ツリー、PATH の偽の z3、担当の harness、start から terminal まで。
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
export async function runScenario(t, { files, request = canonicalRequest(), scenario = {}, tool = 'fake', ci = false, hooks = {}, onStatus = null, tag = null } = {}) {
  const ws = setupWorkspace(files);
  const bin = join(ws, '..', `${ws.split('/').pop()}-bin`);
  const log = join(bin, 'calls.jsonl');
  let path;
  if (tool === 'absent') path = pathWithout(['z3']);
  else path = pathWithFake(makeFakeBin(bin, { mode: tool === 'always-unsat' ? 'always-unsat' : null, log, tag }));
  const env = cliEnv({ path, ci, extra: { FM_TEST_MARKER: 'must-not-reach-tool' } });
  const harness = makeHarness(defaultScenario(scenario), hooks);
  if (t) t.after(() => { removeTree(ws); removeTree(bin); });
  const out = await drive(ws, request, { env, onAgents: (s) => harness.onAgents(s, {}), onStatus });
  return { ...out, ws, env, harness, logPath: log, log: () => readFakeLog(log) };
}
