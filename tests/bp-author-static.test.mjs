import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArgs, runAuthor, setup, updateArgs } from './helpers/bp-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'plugins', 'skill-creator', 'skills', 'skill-creator-best-practices', 'scripts', 'bp_author.js');
const SOURCE = readFileSync(SCRIPT, 'utf8');
const acorn = createRequire(path.join(ROOT, 'plugins', 'workflow', 'skills', 'dynamic-workflow-runner', 'scripts', 'runtime', 'package.json'))('acorn');
const PREFIX = 'async function __s() {\n';
const AST = acorn.parse(`${PREFIX}${SOURCE.replace(/^export const meta =/, 'const meta =')}\n}`, { ecmaVersion: 'latest', locations: true });
const BODY = AST.body[0].body.body;

function walk(node, visit, parents = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parents);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((v) => walk(v, visit, [...parents, node]));
    else if (value && typeof value.type === 'string') walk(value, visit, [...parents, node]);
  }
}

function enclosing(parents) {
  return parents.filter((p) => p.type === 'FunctionDeclaration').map((p) => p.id.name).at(-1) ?? '(top)';
}

function fnSource(name) {
  const d = BODY.find((s) => s.type === 'FunctionDeclaration' && s.id.name === name);
  assert.ok(d, name);
  const offset = PREFIX.length - 'export '.length;
  return SOURCE.slice(d.start - offset, d.end - offset);
}

test('SP-BPRUN-023: agent() を呼ぶのは launch の 1 箇所だけで、launch は役の model と effort を必ず付ける', () => {
  const calls = [];
  walk(AST, (n, parents) => { if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'agent') calls.push(enclosing(parents)); });
  assert.deepEqual(calls, ['launch']);
  assert.match(fnSource('launch'), /agent\(prompt, \{ \.\.\.ROLE_MODELS\[role\], label, schema \}\)/);
  const roles = [];
  walk(AST, (n) => { if (n.type === 'CallExpression' && n.callee.name === 'launch') roles.push(n.arguments[0].value); });
  assert.ok(roles.length > 0);
  for (const r of roles) assert.ok(['writer', 'verifier', 'refuter', 'carrier'].includes(r), r);
});

test('SP-BPRUN-002・SP-BPAUTHORING-027: 入力を待つ手順が無く、needs_input で止まる箇所は入力の確かめと目標の固定の段だけ', () => {
  const places = new Set();
  walk(AST, (n, parents) => {
    const stops = (n.type === 'NewExpression' && n.callee.name === 'Stop') || (n.type === 'CallExpression' && n.callee.name === 'early');
    const first = n.arguments?.[0];
    if (stops && first?.type === 'MemberExpression' && first.object.name === 'STOP_KINDS' && first.property.name === 'needsInput') places.add(enclosing(parents));
    if (n.type === 'Identifier' && n.name === 'checkpoint') places.add(`checkpoint in ${enclosing(parents)}`);
  });
  assert.deepEqual([...places].sort(), ['goalStage', 'validateArgs']);
});

test('script の制約: 本体が meta を読まず、Date.now・Math.random・引数の無い new Date・import() を使わない（native host で throw する）', () => {
  const body = SOURCE.slice(SOURCE.indexOf('\n}\n') + 3);
  assert.doesNotMatch(body, /\bmeta\b/);
  for (const bad of [/\bDate\.now\s*\(/, /\bMath\.random\s*\(/, /\bnew\s+Date\s*\(\s*\)/, /\bimport\s*\(/]) assert.doesNotMatch(SOURCE, bad);
});

test('SP-BPAUTHORING-002・SP-BPAUTHORING-011・SP-BPAUTHORING-013・SP-BPRUN-025: 書き手の prompt が書いてよい先を一覧の中と作業ファイルに限り、固定した目標に無い目標・制約と実行役の時間の上限を禁じ、update では全体の作り直しを許す', () => {
  const write = fnSource('writePrompt');
  assert.match(write, /書いてよい先: 対象スキルのパスの一覧の中/);
  assert.match(write, /作業ファイル（\$\{run\.workDir\}）だけ/);
  assert.match(write, /固定した目標に無い目標・制約を入れない/);
  assert.match(write, /実行役の時間の上限の値を入れない/);
  assert.match(write, /update \? '修正の根拠が触れない部分を含めて、対象スキルの全体を作り直してよい/);
  assert.match(fnSource('goalPrompt'), /書いてよいのは作業ファイル（\$\{run\.workDir\}）だけ。対象スキルには書かない/);
});

test('SP-BPAUTHORING-006: 書き手の目標の schema が 5 欄と出所を必ず持ち、update の出所は写し・修正の根拠・回答に限られる', () => {
  const goalKeys = Function(`return (${SOURCE.match(/const GOAL_KEYS = (\{[^}]+\})/)[1]})`)();
  const schema = Function('GOAL_KEYS', 'SOURCE_KINDS', `${fnSource('sourceSchema')}\n${fnSource('goalSchema')}\nreturn goalSchema();`)(goalKeys, { request: 'request', answer: 'answer', snapshot: 'snapshot', ground: 'ground' });
  assert.deepEqual(schema.properties.goal.required, Object.values(goalKeys));
  const entry = schema.properties.goal.properties.deliverables.items;
  assert.deepEqual(entry.required, ['text', 'sources']);
  assert.equal(entry.properties.sources.minItems, 1);
  const prompt = fnSource('goalPrompt');
  const update = /update \? '([^']+)' : '([^']+)'/.exec(prompt.slice(prompt.indexOf('各要素の sources')));
  assert.ok(update);
  assert.deepEqual([...update[1].matchAll(/"kind":"(\w+)"/g)].map((m) => m[1]), ['snapshot', 'ground', 'answer']);
  assert.deepEqual([...update[2].matchAll(/"kind":"(\w+)"/g)].map((m) => m[1]), ['request', 'answer']);
});

test('SP-BPRUN-019: Workflow が起動数の上限を省略できる入力 maxLaunches として受け取る', () => {
  const validate = fnSource('validateArgs');
  assert.match(validate, /if \(a\[INPUT_KEYS\.maxLaunches\] !== undefined\)/);
  assert.match(fnSource('makeBudget'), /if \(limit === undefined\) return true/);
});

test('SP-BPRUN-035: bp-conformance の判定基準が残した項目からの再開の手順として SP-BPRUN-035 を参照する', () => {
  const conformance = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-conformance.md'), 'utf8');
  const item = conformance.slice(conformance.indexOf('#### SP-BPCONFORMANCE-024'), conformance.indexOf('#### SP-BPCONFORMANCE-025'));
  assert.match(item, /SP-BPRUN-035 の手順に従わなければならない/);
});

test('SP-BPRUN-036: create・update の検証役と反証役と書き手の prompt が判定基準の写しのパスだけを渡し、docs/ のパスを渡さない', async (t) => {
  for (const [fn, args] of [['create', createArgs], ['update', updateArgs]]) {
    const s = await setup(t, { fn });
    if (!s) return;
    const { calls } = await runAuthor(t, { env: s.env, args: args(s.target) });
    const judged = calls.filter((x) => ['verify', 'refute', 'write'].includes(x.role));
    assert.ok(judged.some((c) => c.role === 'verify') && judged.some((c) => c.role === 'write'), fn);
    for (const c of judged) {
      assert.match(c.prompt, /references\/criteria\/specifications\/bp-conformance\.md/, c.label);
      assert.doesNotMatch(c.prompt, /(^|[\s/])docs\//, c.label);
    }
  }
});

// review・audit にだけある振る舞い（抽出役・対象を書き換えていないことの照合）は、create・update ではそれが無いことで確かめる（bp-run.md の「検証方法」のステータスの基準）。
test('SP-BPRUN-026・SP-BPFINDINGS-034: create・update の script は抽出役を起動せず onTargetChanged を送らず、CLI は create・update の停止の onTargetChanged を拒否する', async (t) => {
  const roles = new Set();
  walk(AST, (n) => { if (n.type === 'CallExpression' && n.callee.name === 'launch') roles.add(n.arguments[0].value); });
  assert.ok(!roles.has('extractor'));
  assert.ok(!SOURCE.includes('onTargetChanged'));
  const { context, newKey, skillDir, LIMITS } = await import('../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/fixtures/harness.mjs');
  const run = await import('../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/ops-run.mjs');
  const ctx = context(t);
  if (!ctx) return;
  for (const fn of ['create', 'update']) {
    const root = fn === 'create' ? path.join(await skillDir(t), 'new') : await skillDir(t);
    const s = await run.start(ctx, { key: newKey(), function: fn, target: { root }, limits: LIMITS, ...(fn === 'create' ? { request: 'r' } : { grounds: [{ text: 'a' }] }) });
    await assert.rejects(run.stop(ctx, { state: s.state, run: s.run, kind: 'blocked', reason: 'x', launches: 1, onTargetChanged: 'blocked' }), (e) => e.code === 'E_INPUT' && /review・audit/.test(e.reason));
  }
});
