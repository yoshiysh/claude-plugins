// 結合: 対象の集まり（AC-15・SP-FORMALMETHOD-001・004）。受け付けた依頼の範囲を結果の verified_scope と request.json で観測する。
// 担当は抽出役で進めない（cannot_proceed）ので、run は洗い出しの段で止まる。集まりは受付の段で決まるので、それで足りる。
// 正本: artifact-formats.md「共通の型」の対象・テキストかどうか・版と指紋、「依頼」の開いている object。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runScenario, setupWorkspace } from './test-fixtures/pipeline.mjs';
import { resultInvariants } from './test-fixtures/result-schema.mjs';
import { drive, cliEnv, removeTree, skipIfRoot } from './test-fixtures/cli-runner.mjs';
import { makeHarness, defaultScenario } from './test-fixtures/agent-harness.mjs';

const stop = { returns: { extractor: 'cannot_proceed' } };
const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const target = (r, id = 'T1') => r.verified_scope.targets.find((x) => x.id === id);
const unreadOf = (r, file) => r.verified_scope.unread.filter((u) => u.file === file);
const fmExcluded = (r, file) => r.verified_scope.exclude.filter((e) => e.origin === 'formal-method' && e.item.kind === 'location' && e.item.file === file);
// 準備（symbolic link・権限・git）が要るケースの run。
async function runPrepared(t, files, prepare, request, ws0 = null) {
  const ws = ws0 ?? setupWorkspace(files);
  if (!ws0) t.after(() => removeTree(ws));
  if (prepare) prepare(ws);
  const h = makeHarness(defaultScenario(stop));
  const out = await drive(ws, request, { env: cliEnv(), onAgents: (st) => h.onAgents(st) });
  return { ...out, ws };
}
const req = (location, over = {}) => ({ targets: [{ id: 'T1', location, ...over }], goals: [{ id: 'G1', text: 'R1 が成り立つ' }] });

test('SP-FORMALMETHOD-001 AC-15: 作業ツリーの根を対象に 2 回続けて run すると、2 回目の集まりに .formal-method/ が入らず、指紋が同じで、除いたものは unread に載り exclude に入らない', async (t) => {
  const files = { 'spec.md': '# 対象\nR1: x は 0 以上。\n', 'docs/a.md': 'a\n' };
  const first = await runScenario(t, { files, request: req('.'), scenario: stop });
  const second = await runPrepared(t, null, null, req('.'), first.ws);
  for (const r of [first.result, second.result]) {
    assert.deepEqual(resultInvariants(r), []);
    const paths = target(r).files.map((f) => f.path);
    assert.ok(!paths.some((p) => p === '.formal-method' || p.startsWith('.formal-method/')), paths.join());
    assert.deepEqual(unreadOf(r, '.formal-method/'), [], 'unread に載せない（対象の定義から外れる）');
    assert.deepEqual(fmExcluded(r, '.formal-method/'), [{ item: { kind: 'location', target_id: 'T1', file: '.formal-method/' }, reason: 'formal-method が除く', origin: 'formal-method' }]);
    assert.ok(!r.verified_scope.exclude.some((e) => e.origin === '依頼元'), '依頼元の除外としては載せない');
  }
  assert.equal(target(second.result).content_hash, target(first.result).content_hash);
  assert.deepEqual(target(first.result).files.map((f) => f.path), ['docs/a.md', 'spec.md'], 'FilePath のバイト列の辞書順');
});

test('SP-FORMALMETHOD-001 AC-15: 名前が .git のものは、ディレクトリでもファイルでも、どの深さでも除かれ unread に載る', async (t) => {
  const files = { 'target/spec.md': 'R1\n', 'target/.git/config': '[core]\n', 'target/sub/.git': 'gitdir: ../x\n', 'target/sub/deep/.git/HEAD': 'ref\n', 'target/sub/keep.md': 'k\n' };
  const { result } = await runScenario(t, { files, request: req('target'), scenario: stop });
  const paths = target(result).files.map((f) => f.path);
  assert.deepEqual(paths, ['spec.md', 'sub/keep.md']);
  for (const f of ['.git/', 'sub/.git', 'sub/deep/.git/']) {
    assert.deepEqual(fmExcluded(result, f).map((e) => [e.reason, e.origin]), [['formal-method が除く', 'formal-method']], f);
    assert.deepEqual(unreadOf(result, f), [], `${f} は unread に載せない`);
  }
  assert.deepEqual(result.verified_scope.unread, [], '除いたもの以外に読めない箇所は無い');
});

test('SP-FORMALMETHOD-001 AC-15 境界: 深い場所に利用者が作った .formal-method/ は除かれずに集まりに入る', async (t) => {
  const files = { 'target/spec.md': 'R1\n', 'target/sub/.formal-method/note.md': 'n\n' };
  const { result } = await runScenario(t, { files, request: req('target'), scenario: stop });
  assert.deepEqual(target(result).files.map((f) => f.path), ['spec.md', 'sub/.formal-method/note.md']);
});

test('SP-FORMALMETHOD-001 AC-15: location が symbolic link なら 1 度解決して解決した先を読み、resolved_location に出す', async (t) => {
  const out = await runPrepared(t, { 'real/spec.md': 'R1\n' }, (ws) => symlinkSync(join(ws, 'real'), join(ws, 'link')), req('link'));
  const ws = out.ws;
  const tt = target(out.result);
  assert.equal(tt.location, 'link');
  assert.equal(tt.resolved_location, realpathSync(join(ws, 'real')));
  assert.deepEqual(tt.files.map((f) => f.path), ['spec.md']);
});

test('SP-FORMALMETHOD-004 AC-15: 集まりの中の symbolic link はたどらず unread に載る。symbolic link でない location の resolved_location は null', async (t) => {
  const { result } = await runPrepared(t, { 'target/spec.md': 'R1\n', 'outside/secret.md': 'o\n' }, (ws) => symlinkSync(join(ws, 'outside'), join(ws, 'target', 'out')), req('target'));
  assert.deepEqual(target(result).files.map((f) => f.path), ['spec.md']);
  assert.equal(target(result).resolved_location, null);
  const u = unreadOf(result, 'out').concat(unreadOf(result, 'out/'));
  assert.equal(u.length, 1);
  assert.equal(u[0].span, null);
  assert.equal(u[0].reason, 'symbolic link はたどらない');
});

const BINARY_CASES = [
  ['NUL を含む', Buffer.from('ab\0cd\n')],
  ['UTF-8 として読めない', Buffer.from([0xff, 0xfe, 0x41, 0x0a])],
];
for (const [name, bytes] of BINARY_CASES) {
  test(`SP-FORMALMETHOD-004 AC-15: バイナリのファイル（${name}）は受け付けない依頼にせず、ファイルの全体を unread に挙げ、指紋は集まりに含める`, async (t) => {
    const { result } = await runScenario(t, { files: { 'target/spec.md': 'R1\n', 'target/bin.dat': bytes }, request: req('target'), scenario: stop });
    assert.ok(!result.stop_report.reasons.some((r) => r.code === '依頼の不備'));
    const f = target(result).files.find((x) => x.path === 'bin.dat');
    assert.deepEqual(f, { path: 'bin.dat', content_hash: sha(bytes), text: false });
    const u = unreadOf(result, 'bin.dat');
    assert.equal(u.length, 1);
    assert.equal(u[0].span, null);
    assert.equal(result.verified_scope.extraction_coverage.complete, false, '読めない箇所が残れば網羅済みにしない');
  });
}

test('SP-FORMALMETHOD-004 AC-15: 集まりの中の読めないファイルは target_unavailable にせず、指紋 unreadable で集まりに含め unread に挙げる', async (t) => {
  if (skipIfRoot(t)) return;
  const { result } = await runPrepared(t, { 'target/spec.md': 'R1\n', 'target/locked.md': 'x\n' }, (ws) => chmodSync(join(ws, 'target', 'locked.md'), 0o000), req('target'));
  assert.ok(!result.stop_report.reasons.some((r) => r.request_code === 'target_unavailable'));
  const f = target(result).files.find((x) => x.path === 'locked.md');
  assert.equal(f.content_hash, 'unreadable');
  assert.equal(unreadOf(result, 'locked.md').length, 1);
  const joined = target(result).files.map((x) => `${x.path}\0${x.content_hash}\n`).join('');
  assert.equal(target(result).content_hash, sha(joined), '読めないファイルも "unreadable" として指紋に含める');
});

test('cli-contract 秘密値の走査 AC-15: 対象のファイルに秘密値の型があっても、対象の写しは保存され、保存の失敗で止まらない', async (t) => {
  const secret = 'AKIAABCDEFGHIJKLMNOP';
  const { result, status } = await runScenario(t, { files: { 'target/spec.md': `R1\nkey=${secret}\n` }, request: req('target'), scenario: stop });
  assert.ok(!result.stop_report.reasons.some((r) => r.code === '保存の失敗'), JSON.stringify(result.stop_report.reasons));
  const copy = join(status.run_dir, 'targets', 'T1', 'files', 'spec.md');
  assert.ok(existsSync(copy));
  assert.ok(readFileSync(copy, 'utf8').includes(secret));
});

test('SP-FORMALMETHOD-001 AC-15: 依頼の未知のキーは拒まず、使わずに unverified に「依頼の未知のキー: <JSON Pointer>」として載る', async (t) => {
  const request = { ...req('target'), extra_top: 1 };
  request.targets[0].note = 'x';
  request.goals[0].priority = 'high';
  const { result, status } = await runScenario(t, { request, scenario: stop });
  assert.ok(!result.stop_report.reasons.some((r) => r.code === '依頼の不備'));
  const items = result.unverified.map((u) => u.item);
  for (const p of ['/extra_top', '/targets/0/note', '/goals/0/priority']) assert.ok(items.includes(`依頼の未知のキー: ${p}`), `${p}: ${items.join(' | ')}`);
  const normal = JSON.parse(readFileSync(join(status.run_dir, 'request.json'), 'utf8'));
  assert.equal('extra_top' in normal, false, 'request.json は未知のキーを除く');
  assert.deepEqual(normal.known_requirements, [], '省略の既定値を埋める');
});

test('SP-FORMALMETHOD-001 AC-15: 単一のファイルの対象は、そのファイル名 1 つの集まりで、.gitignore に従わない', async (t) => {
  const files = { 'target/spec.md': 'R1\n', 'target/.gitignore': 'ignored.md\n', 'target/ignored.md': 'i\n' };
  const single = await runScenario(t, { files, request: req('target/spec.md'), scenario: stop });
  assert.deepEqual(target(single.result).files.map((f) => f.path), ['spec.md']);
  const dir = await runScenario(t, { files, request: req('target'), scenario: stop });
  assert.deepEqual(target(dir.result).files.map((f) => f.path), ['.gitignore', 'ignored.md', 'spec.md']);
});

test('SP-FORMALMETHOD-001 AC-15: 指紋を添えた依頼は、集まりの指紋と一致すれば受け付ける（境界: 一致する指紋）', async (t) => {
  const first = await runScenario(t, { request: req('target'), scenario: stop });
  const hash = target(first.result).content_hash;
  const second = await runScenario(t, { request: req('target', { content_hash: hash }), scenario: stop });
  assert.ok(!second.result.stop_report.reasons.some((r) => r.code === '依頼の不備'));
  assert.equal(target(second.result).content_hash, hash);
});

test('SP-FORMALMETHOD-001 AC-15: revision を添えた依頼は、git の作業ツリーからその版の tree の内容を取る', async (t) => {
  const prepare = (ws) => {
    const git = (...a) => execFileSync('git', ['-C', ws, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'c');
    writeFileSync(join(ws, 'target', 'spec.md'), 'changed after commit\n');
    writeFileSync(join(ws, 'target', 'new.md'), 'not committed\n');
  };
  const { result } = await runPrepared(t, { 'target/spec.md': 'committed\n' }, prepare, req('target', { revision: 'HEAD' }));
  const tt = target(result);
  assert.ok(tt.revision, 'revision を示す');
  assert.deepEqual(tt.files, [{ path: 'spec.md', content_hash: sha('committed\n'), text: true }]);
});

test('SP-FORMALMETHOD-001 AC-15 境界: 時間の上限 1 秒（最小の値）は受け付ける', async (t) => {
  const { result } = await runScenario(t, { request: { ...req('target'), time_limit_seconds: 1 }, scenario: stop });
  assert.ok(!result.stop_report.reasons.some((r) => r.request_code === 'time_limit_invalid'));
});

