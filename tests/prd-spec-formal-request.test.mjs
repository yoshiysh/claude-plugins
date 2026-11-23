// prd-spec の doc_check が formal-method に渡す依頼と、formal-method の結果の取り込みを、formal-method 自身の検査と突き合わせる
// （workflow-io.md と agent-contracts.md「## 形式検証の事実」）。formal-method のファイルを読むので、prd-spec の配布物（plugins/workflow/skills/prd-spec/tests）
// には入れず、リポジトリ直下に置く。
//
// - 結果の fixture（plugins/workflow/skills/prd-spec/tests/fixtures/formal/results/）は、formal-method の result-schema.mjs の
//   resultInvariants で formal-method.result/2 の形と不変を確かめる。prd-spec の test_formal_request.py も同じ fixture を使う。
// - doc_check formal-request の request.json を、formal-method の checkRequestShape・checkPointers に通し、content_hash を collectionHash と突き合わせる。
// - 形を確かめた結果を doc_check formal-import（CLI）で取り込み、目標ごとの判定を照らす。
// - 本物の formal-method の CLI で、受付で止まらないことを確かめる（z3 が無ければ skip。担当は起動しないので、受付より後は確かめない）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resultInvariants } from '../.agents/skills/formal-method/scripts/test-fixtures/result-schema.mjs';
import { checkRequestShape, checkPointers } from '../.agents/skills/formal-method/scripts/lib/request.mjs';
import { collectionHash, fetchTarget, lineCount } from '../.agents/skills/formal-method/scripts/lib/intake.mjs';
import { cli, expectOk } from '../.agents/skills/formal-method/scripts/test-fixtures/cli-runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = path.join(ROOT, 'plugins/workflow/skills/prd-spec');
const DOC_CHECK = path.join(SKILL, 'scripts/doc_check.mjs');
const WS_FIXTURE = path.join(SKILL, 'tests/fixtures/workspace');
const FORMAL = path.join(SKILL, 'tests/fixtures/formal');
const RESULTS = path.join(FORMAL, 'results');
const DOC_FILE = 'specifications-auth.md';
const SPEC_MD = fs.readFileSync(path.join(FORMAL, DOC_FILE), 'utf8');

const VARIANTS = fs.readdirSync(RESULTS).filter((f) => f.endsWith('.json') && f !== 'base.json').map((f) => f.replace(/\.json$/, '')).sort();
const loadResult = (name) => ({ ...JSON.parse(fs.readFileSync(path.join(RESULTS, 'base.json'), 'utf8')), ...JSON.parse(fs.readFileSync(path.join(RESULTS, `${name}.json`), 'utf8')) });

const walk = (v, f) => (Array.isArray(v) ? v.map((x) => walk(x, f)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, f)])) : f(v));
const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

// 置き場所（@goal: など）を、形だけ合う値で埋める（DC の出力に依らずに fixture の形を確かめる）。
const dummyFill = (r) => walk(r, (v) => {
  if (typeof v !== 'string' || !v.startsWith('@')) return v;
  if (v.startsWith('@goal:')) return `${v.slice(6)}.1`;
  if (v === '@content_hash') return `sha256:${'0'.repeat(64)}`;
  if (v === '@location') return '/tmp/prd-w/fm/f1a/target';
  if (v.startsWith('@file:')) return DOC_FILE;
  return 'L1-L1';
});

// DC が書いた request.json・units.json の値で埋める（test_formal_request.py の fill と同じ規則）。
const fill = (r, request, units, targetText) => walk(r, (v) => {
  if (typeof v !== 'string' || !v.startsWith('@')) return v;
  const unit = (item) => {
    const u = units.units.find((x) => x.item_id === item);
    assert.ok(u, `units.json に ${item} の単位が無い`);
    return u;
  };
  if (v.startsWith('@goal:')) {
    const ids = request.goals.map((g) => g.id).filter((id) => id.startsWith(`${v.slice(6)}.`)).sort();
    assert.ok(ids.length, `request.json に ${v.slice(6)}.* の目標が無い`);
    return ids[0];
  }
  if (v === '@content_hash') return request.targets[0].content_hash;
  if (v === '@location') return request.targets[0].location;
  if (v.startsWith('@file:')) return unit(v.slice(6)).lines[0].file;
  if (v.startsWith('@span:')) return unit(v.slice(6)).lines[0].span;
  if (v.startsWith('@arrow:')) {
    const n = lineOf(targetText, `(${v.slice(7)})`);
    return `L${n}-L${n}`;
  }
  throw new Error(v);
});

function makeW() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prd-formal-')));
  const ws = path.join(tmp, 'W');
  fs.cpSync(WS_FIXTURE, ws, { recursive: true });
  fs.writeFileSync(path.join(ws, DOC_FILE), SPEC_MD);
  return { tmp, ws, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function docCheck(ws, mode, ...args) {
  const r = spawnSync(process.execPath, [DOC_CHECK, mode, ...args.map(String), '--workspace', ws], { encoding: 'utf8' });
  assert.equal(r.status, 0, `doc_check ${mode} が exit ${r.status}: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

function requested(ws, rid = 'f1a') {
  const out = docCheck(ws, 'formal-request', '--rid', rid, '--stage', '5', '--phase', 'a');
  const read = (name) => JSON.parse(fs.readFileSync(path.join(ws, 'fm', rid, name), 'utf8'));
  return { out, request: read('request.json'), units: read('units.json') };
}

test('結果の fixture は formal-method.result/2 の形と不変を満たす', () => {
  assert.ok(VARIANTS.length >= 6, `fixture の場合: ${VARIANTS.join(', ')}`);
  assert.deepEqual(resultInvariants(dummyFill(JSON.parse(fs.readFileSync(path.join(RESULTS, 'base.json'), 'utf8')))), [], 'base');
  for (const name of VARIANTS) assert.deepEqual(resultInvariants(dummyFill(loadResult(name))), [], name);
});

test('結果の fixture は §7.3 の場合を全て持つ', () => {
  const all = VARIANTS.map((n) => [n, loadResult(n)]);
  const has = (pred) => all.some(([, r]) => pred(r));
  assert.ok(has((r) => r.counterexamples.some((x) => x.sources.some((s) => s.kind === 'goal'))), 'mapping の goal の出所を持つ反例');
  assert.ok(has((r) => r.counterexamples.some((x) => x.sources.every((s) => s.kind === 'location'))), 'location だけの反例');
  assert.ok(has((r) => r.causes.some((c) => c.cause === '対象が性質を満たさない')), '原因 対象が性質を満たさない');
  assert.ok(has((r) => r.causes.some((c) => c.cause === '形式モデルの欠陥')), '原因 形式モデルの欠陥');
  assert.ok(has((r) => r.properties.some((p) => p.verdict.includes('検証済み') && p.detection.status === '検出能力未確認')), '変異の無い 検証済み');
  assert.ok(has((r) => r.decomposition.adopted), '分割を採った結果');
});

test('doc_check の request.json は formal-method の受付の検査に通り content_hash が集まりの指紋と合う', (t) => {
  const w = makeW();
  t.after(w.cleanup);
  const { out, request } = requested(w.ws);
  const shape = checkRequestShape(request);
  assert.deepEqual(shape.problems, []);
  assert.deepEqual(shape.unknownKeys, [], '依頼に未知のキーを入れない（入れると結果の unverified に載る）');
  const fetched = new Map();
  for (const t0 of request.targets) {
    const got = fetchTarget(t0, { workspace: out.cwd });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.target.content_hash, t0.content_hash, 'content_hash は formal-method の集まりの指紋と同じ');
    assert.equal(collectionHash(got.target.files), t0.content_hash);
    fetched.set(t0.id, { files: new Map(got.target.files.map((f) => [f.path, { text: f.text, lines: lineCount(f.bytes) }])) });
  }
  assert.deepEqual(checkPointers(request, fetched), [], 'Pointer と SourceRef が対象の行を指す');
  assert.equal(path.resolve(out.cwd), path.resolve(`${w.ws}.formal`));
});

// 場合ごとの、取り込んだ後の目標の判定（facts.json の units[].goals[]）。
const EXPECT = {
  cex_goal: [['SP-AUTH-011', 'bounds', (g) => g.verdict === '反例' && g.location.item_id === 'SP-AUTH-011'], ['SP-AUTH-012', 'guard', (g) => g.verdict === '検証済み']],
  cex_bounds: [['SP-AUTH-011', 'bounds', (g) => g.verdict === '反例' && g.location.item_id === 'SP-AUTH-011']],
  cex_span: [['SP-AUTH-012', 'guard', (g) => g.verdict === '反例'], ['SP-AUTH-013', 'guard', (g) => g.verdict === '未検証']],
  // 反例が 0 件なら落ちる（some は少なくとも 1 つの 反例 を求める）。
  cex_state: [['SP-AUTH-020', 'state', (g) => g.verdict === '反例' && g.location.item_id === 'SP-AUTH-022']],
  cex_model_defect: [['SP-AUTH-011', 'bounds', (g) => g.verdict === '未検証' && g.reason.includes('形式モデルの欠陥')]],
  verified_unmutated: [['SP-AUTH-010', 'domain', (g) => g.verdict === '検証済み' && g.detection === '検出能力未確認']],
  decomposed: [['SP-AUTH-010', 'domain', (g) => g.verdict === '検証済み']],
};

for (const name of VARIANTS) {
  test(`形を確かめた結果（${name}）を formal-import が取り込む`, (t) => {
    const w = makeW();
    t.after(w.cleanup);
    const { request, units } = requested(w.ws);
    const targetText = fs.readFileSync(path.join(request.targets[0].location, DOC_FILE), 'utf8');
    const result = fill(loadResult(name), request, units, targetText);
    assert.deepEqual(resultInvariants(result), [], '埋めた後も result/2 の形と不変を満たす');
    const runDir = path.join(`${w.ws}.formal`, '.formal-method', 'runs', `run-${name}`);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'request.json'), JSON.stringify(request));
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result));
    const out = docCheck(w.ws, 'formal-import', '--rid', 'f1a', '--run-dir', runDir);
    assert.equal(out.outcome, 'result');
    const facts = JSON.parse(fs.readFileSync(path.join(w.ws, 'fm', 'facts.json'), 'utf8'));
    assert.equal(facts.schema, 'prd-spec.formal-facts/1');
    for (const [item, kind, ok] of EXPECT[name] || []) {
      const goals = facts.units.filter((u) => u.item_id === item && u.kind === kind).flatMap((u) => u.goals);
      assert.ok(goals.length && goals.some(ok), `${name}: ${item} ${kind} の判定 ${JSON.stringify(goals)}`);
    }
  });
}

const hasZ3 = (() => {
  try { execFileSync('z3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

test('本物の formal-method の CLI は doc_check の依頼を受付で止めない', { skip: hasZ3 ? false : 'z3 が無い環境', timeout: 600000 }, async (t) => {
  const w = makeW();
  t.after(w.cleanup);
  const { out, request } = requested(w.ws);
  fs.mkdirSync(out.cwd, { recursive: true });
  const opts = { cwd: out.cwd };
  let status = expectOk(await cli('start', { request }, opts), 'start').status;
  try {
    const stoppedAtIntake = status.action === 'terminal' && status.result && status.result.stop_report && status.result.stop_report.stage === '受付';
    assert.ok(!stoppedAtIntake, `受付で止まった: ${JSON.stringify(status.result && status.result.stop_report)}`);
    assert.notEqual(status.run_dir, null);
  } finally {
    // 担当は起動しない。開いた呼び出しを期限切れで閉じて run を終わりまで進め、daemon を残さない。
    for (let step = 0; step < 100 && status.action !== 'terminal'; step += 1) {
      if (status.action === 'run_agents') await cli('close', { run_dir: status.run_dir, call_id: status.call.call_id, timed_out: true }, opts);
      const r = await cli('wait', { run_dir: status.run_dir, status_seq: status.seq }, opts);
      if (r.json && r.json.ok && r.json.status) status = r.json.status;
    }
    if (status.action !== 'terminal' && status.daemon && status.daemon.pid) {
      try { process.kill(status.daemon.pid); } catch { /* 既に終わった */ }
    }
  }
});
