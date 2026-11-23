// 結合: 対象の集まり（AC-15・SP-FORMALMETHOD-001・004）。受け付けた依頼の範囲を結果の verified_scope と request.json で観測する。
// 担当は抽出役で進めない（cannot_proceed）ので、run は洗い出しの段で止まる。集まりは受付の段で決まるので、それで足りる。
// 正本: artifact-formats.md「共通の型」の対象・テキストかどうか・版と指紋、「依頼」の開いている object。
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runScenario, setupWorkspace } from './test-fixtures/pipeline.mjs';
import { resultInvariants } from './test-fixtures/result-schema.mjs';
import { drive, cliEnv, removeTree, skipIfRoot } from './test-fixtures/cli-runner.mjs';
import { makeHarness, defaultScenario } from './test-fixtures/agent-harness.mjs';
import { SPEC_TEXT } from './test-fixtures/pipeline.mjs';
import { SM, PART_SCENARIO } from './test-fixtures/pipeline-cases.mjs';

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

describe('cli-scope', { concurrency: 4 }, () => {
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

test('SP-FORMALMETHOD-001・014 AC-15 対象の固定: 受付は対象の写しを作らず、manifest にファイルごとの元の絶対パス・作業ツリーからの相対パス・指紋を残す。対象の秘密値の型で保存の失敗にならない', async (t) => {
  const secret = 'AKIAABCDEFGHIJKLMNOP';
  const { result, status } = await runScenario(t, { files: { 'target/spec.md': `R1\nkey=${secret}\n` }, request: req('target'), scenario: stop });
  assert.ok(!result.stop_report.reasons.some((r) => r.code === '保存の失敗'), JSON.stringify(result.stop_report.reasons));
  assert.ok(!existsSync(join(status.run_dir, 'targets', 'T1', 'files')), '写しのディレクトリが無い');
  const manifest = JSON.parse(readFileSync(join(status.run_dir, 'targets', 'T1', 'manifest.json'), 'utf8'));
  const f = manifest.files.find((x) => x.path === 'spec.md');
  assert.ok(isAbsolute(f.abs_path) && f.abs_path.endsWith(join('target', 'spec.md')), JSON.stringify(f));
  assert.equal(f.workspace_path, 'target/spec.md');
  assert.equal(f.content_hash, sha(readFileSync(f.abs_path)));
  const saved = result.records.saved.filter((x) => x.kind === 'target_snapshot').map((x) => x.ref);
  assert.deepEqual(saved, ['targets/T1/manifest.json'], '台帳の target_snapshot は manifest だけ');
  const fixed = JSON.parse(readFileSync(join(status.run_dir, 'request.json'), 'utf8')).targets[0].fixed;
  assert.equal(fixed.files.find((x) => x.path === 'spec.md').abs_path, f.abs_path);
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

test('SP-FORMALMETHOD-001 AC-15: revision を添えた依頼は、作業ツリーのファイルがその版の内容（checkout と同じ変換を通した git cat-file --filters の出力）と一致するときだけ受け付け、版の tree の内容を取る（版に無い作業ツリーのファイルは入れない）', async (t) => {
  const prepare = (ws) => {
    const git = (...a) => execFileSync('git', ['-C', ws, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'c');
    writeFileSync(join(ws, 'target', 'new.md'), 'not committed\n');
  };
  const { result } = await runPrepared(t, { 'target/spec.md': 'committed\n' }, prepare, req('target', { revision: 'HEAD' }));
  const tt = target(result);
  assert.ok(tt.revision, 'revision を示す');
  assert.deepEqual(tt.files, [{ path: 'spec.md', content_hash: sha('committed\n'), text: true }]);
});

test('SP-FORMALMETHOD-001 AC-15: revision を添えた依頼は、.gitattributes の eol で checkout の変換（LF → CRLF）を通った作業ツリーも、その版として受け付ける', async (t) => {
  const prepare = (ws) => {
    const git = (...a) => execFileSync('git', ['-C', ws, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8' });
    writeFileSync(join(ws, '.gitattributes'), '*.md text eol=crlf\n');
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'c');
    // checkout し直して、作業ツリーを eol=crlf の変換を通した形にする（blob は LF のまま）
    rmSync(join(ws, 'target', 'spec.md'));
    git('checkout', '--', 'target/spec.md');
  };
  const { result, ws } = await runPrepared(t, { 'target/spec.md': 'committed\nline2\n' }, prepare, req('target', { revision: 'HEAD' }));
  const worktree = readFileSync(join(ws, 'target', 'spec.md'));
  assert.equal(worktree.toString('utf8'), 'committed\r\nline2\r\n', '作業ツリーは CRLF（変換を通った checkout）');
  assert.ok(!result.stop_report?.reasons.some((x) => x.request_code === 'revision_mismatch' || x.request_code === 'target_unavailable'), JSON.stringify(result.stop_report?.reasons));
  assert.deepEqual(target(result).files, [{ path: 'spec.md', content_hash: sha(worktree), text: true }], '指紋は checkout と同じ変換を通した版の内容（作業ツリーと同じ）');
  assert.ok(!result.stop_report.reasons.some((x) => x.code === '対象の変化'), '集約の段の照合も同じ求め方なので、変わったとしない');
});

test('SP-FORMALMETHOD-001 AC-15: revision を添えた依頼で、版の tree にあるファイルの blob を読めなければ、受付で target_unavailable として拒む', async (t) => {
  const prepare = (ws) => {
    const git = (...a) => execFileSync('git', ['-C', ws, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'c');
    // 版の tree は残したまま、spec.md の blob（loose object）だけを消す
    const blob = git('rev-parse', 'HEAD:target/spec.md').trim();
    rmSync(join(ws, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), { force: true });
  };
  const { result } = await runPrepared(t, { 'target/spec.md': 'committed\n' }, prepare, req('target', { revision: 'HEAD' }));
  assert.equal(result.status, '停止');
  const r = result.stop_report.reasons.find((x) => x.request_code === 'target_unavailable');
  assert.ok(r, JSON.stringify(result.stop_report.reasons));
  assert.match(r.detail, /revision の版のファイル target\/spec\.md（blob [0-9a-f]+）を読めない/);
});

test('SP-FORMALMETHOD-001 AC-15: revision を添えた依頼で、作業ツリーのファイルがその版と違えば、写しを作らないので受付で revision_mismatch として拒む', async (t) => {
  const prepare = (ws) => {
    const git = (...a) => execFileSync('git', ['-C', ws, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'c');
    writeFileSync(join(ws, 'target', 'spec.md'), 'changed after commit\n');
  };
  const { result } = await runPrepared(t, { 'target/spec.md': 'committed\n' }, prepare, req('target', { revision: 'HEAD' }));
  assert.equal(result.status, '停止');
  const r = result.stop_report.reasons.find((x) => x.request_code === 'revision_mismatch');
  assert.ok(r, JSON.stringify(result.stop_report.reasons));
  assert.match(r.detail, /作業ツリーのファイル .*spec\.md の内容が revision の版と一致しない/);
});

test('SP-FORMALMETHOD-001 AC-15 境界: 時間の上限 1 秒（最小の値）は受け付ける', async (t) => {
  const { result } = await runScenario(t, { request: { ...req('target'), time_limit_seconds: 1 }, scenario: stop });
  assert.ok(!result.stop_report.reasons.some((r) => r.request_code === 'time_limit_invalid'));
});

test('SP-FORMALMETHOD-001・015 対象の固定: run の途中で対象のファイルを書き換えると、集約の段で 1 度だけ照らした指紋が受付と違い、停止の理由 対象の変化 で停止する', async (t) => {
  let done = false;
  const beforeSubmit = (status) => {
    if (done) return;
    done = true;
    const fixed = JSON.parse(readFileSync(join(status.run_dir, 'request.json'), 'utf8')).targets[0].fixed;
    writeFileSync(fixed.files.find((f) => f.path === 'spec.md').abs_path, 'R1: 途中で書き換えた。\n');
  };
  const { result } = await runScenario(t, { hooks: { beforeSubmit } });
  assert.deepEqual(resultInvariants(result), []);
  assert.equal(result.status, '停止');
  const r = result.stop_report.reasons.find((x) => x.code === '対象の変化');
  assert.ok(r, JSON.stringify(result.stop_report.reasons));
  assert.equal(r.stage, '集約');
  assert.match(r.detail, /対象 T1 のファイル spec\.md が受付の後に変わった/);
  assert.equal(result.stop_report.reasons.filter((x) => x.code === '対象の変化').length, 1);
  // 変わったファイルは検証済みの範囲に入れず、理由つきで未検証に載り、そのファイルを出所に持つ性質は検証の成功にならない（SP-001）
  assert.deepEqual(target(result).files.map((f) => f.path), [], JSON.stringify(target(result)));
  const u = result.unverified.find((x) => x.item === '対象の変化: T1 の spec.md');
  assert.ok(u, JSON.stringify(result.unverified));
  assert.match(u.reason, /指紋が受付の指紋と違う/);
  assert.equal(result.verified_scope.extraction_coverage.complete, false);
  assert.match(result.verified_scope.extraction_coverage.reason, /受付の後に変わった/);
  const p1 = result.properties.find((p) => p.id === 'P1');
  assert.deepEqual(p1.verdict, ['未確認']);
  assert.match(p1.reason, /出所のファイル（T1 の spec\.md）が受付の後に変わった/);
  assert.ok(!result.stop_report.confirmed_scope.includes('P1') && result.stop_report.unconfirmed_scope.includes('P1'), JSON.stringify(result.stop_report));
});

test('SP-FORMALMETHOD-001・015 対象の固定: 受付で読めたファイルが run の途中で読めなくなると、集約の段の照合で 対象の変化 になる', async (t) => {
  if (skipIfRoot(t)) return;
  let done = false;
  let abs = null;
  const beforeSubmit = (status) => {
    if (done) return;
    done = true;
    abs = JSON.parse(readFileSync(join(status.run_dir, 'request.json'), 'utf8')).targets[0].fixed.files.find((f) => f.path === 'spec.md').abs_path;
    chmodSync(abs, 0o000);
  };
  t.after(() => { if (abs) chmodSync(abs, 0o644); });
  const { result } = await runScenario(t, { hooks: { beforeSubmit } });
  assert.deepEqual(resultInvariants(result), []);
  const r = result.stop_report.reasons.find((x) => x.code === '対象の変化');
  assert.ok(r, JSON.stringify(result.stop_report.reasons));
  assert.match(r.detail, /spec\.md/);
  assert.ok(result.unverified.some((x) => x.item === '対象の変化: T1 の spec.md'));
  assert.ok(!result.stop_report.reasons.some((x) => x.code === '内部の誤り'), '読めない資料の指紋で内部の誤りにならない');
});

test('SP-FORMALMETHOD-001 対象の固定: 親の性質の出所のファイルが変わると、契約も検証済みにならない', async (t) => {
  let done = false;
  const beforeSubmit = (status) => {
    if (done) return;
    done = true;
    const fixed = JSON.parse(readFileSync(join(status.run_dir, 'request.json'), 'utf8')).targets[0].fixed;
    const f = fixed.files.find((x) => x.text);
    writeFileSync(f.abs_path, `${readFileSync(f.abs_path, 'utf8')}追記\n`);
  };
  const { result } = await runScenario(t, { scenario: PART_SCENARIO(), hooks: { beforeSubmit } });
  assert.deepEqual(resultInvariants(result), []);
  const k = result.decomposition.contracts.find((x) => x.id === 'K-a');
  assert.ok(k, JSON.stringify(result.decomposition.reason));
  assert.deepEqual(k.verdict, ['未確認'], k.reason);
  assert.match(k.reason, /受付の後に変わったので、検証の成功として出さない/);
});

test('SP-FORMALMETHOD-001 対象の固定: 節の出所のファイルだけが変わっても、その節を持つ性質は検証済みにならない', async (t) => {
  const files = { 'target/spec.md': SPEC_TEXT, 'target/other.md': 'R9: z は 0 でない。\n' };
  const p1 = { ...defaultScenario().properties[0], clauseSources: ['E-P1', 'E-P2'] };
  const p2 = { ...defaultScenario().properties[0], id: 'P2', file: 'other.md', line: 1, statement: 'z は 0 でない' };
  let done = false;
  const beforeSubmit = (status) => {
    if (done) return;
    done = true;
    const fixed = JSON.parse(readFileSync(join(status.run_dir, 'request.json'), 'utf8')).targets[0].fixed;
    writeFileSync(fixed.files.find((f) => f.path === 'other.md').abs_path, 'R9: 途中で書き換えた。\n');
  };
  const { result } = await runScenario(t, { files, request: req('target'), scenario: { properties: [p1, p2] }, hooks: { beforeSubmit } });
  assert.deepEqual(resultInvariants(result), []);
  const r1 = result.properties.find((p) => p.id === 'P1');
  assert.deepEqual(r1.verdict, ['未確認'], r1.reason);
  assert.match(r1.reason, /T1 の other\.md/);
  assert.ok(!/T1 の spec\.md/.test(r1.reason), '変わっていない spec.md は理由に出ない');
  assert.deepEqual(target(result).files.map((f) => f.path), ['spec.md']);
});

test('SP-FORMALMETHOD-001 対象の固定: 固定の前提の確かめ方の限界を、結果の unverified に載せる', async (t) => {
  const { result } = await runScenario(t, {});
  const u = result.unverified.find((x) => x.item === '対象の固定');
  assert.ok(u, JSON.stringify(result.unverified));
  assert.match(u.reason, /途中で変わって元に戻り、その間に query が無ければ見つけられない/);
});

test('SP-FORMALMETHOD-001・015 対象の固定: 対象を書き換えない run には 対象の変化 の理由が無い', async (t) => {
  const { result } = await runScenario(t, {});
  assert.equal(result.status, '完了', JSON.stringify(result.stop_report?.reasons));
});

// ---- 担当に渡す資料（範囲だけ） ----
const lineHash = (text, span) => { const [, a, b] = span.match(/^L(\d+)-L(\d+)$/).map(Number); const ls = text.split('\n'); if (ls.at(-1) === '') ls.pop(); return sha(ls.slice(a - 1, b).join('\n')); };
test('SP-FORMALMETHOD-001・012 担当に渡す資料: 抽出役とモデル作成役の資料に対象の元のファイルがあり、query の path は元の絶対パス', async (t) => {
  const { harness, status, ws } = await runScenario(t, {});
  const fixed = JSON.parse(readFileSync(join(status.run_dir, 'request.json'), 'utf8')).targets[0].fixed;
  const abs = fixed.files.find((f) => f.path === 'spec.md').abs_path;
  for (const role of ['extractor', 'model-author']) {
    const task = harness.memory.tasks.find((x) => x.role === role);
    const r = task.context.input_refs.find((x) => x.ref === 'target:T1/spec.md');
    assert.ok(r, `${role}: ${JSON.stringify(task.context.input_refs)}`);
    assert.equal(r.spans, undefined, `${role}: 依頼の範囲が対象の全体なのでファイルの全体`);
    // query の応答の path は、受付で控えた元のファイルの絶対パス（写しの path でない）
    const q = task.query_inputs.find((x) => x.ref === 'target:T1/spec.md');
    assert.equal(q.path, abs, `${role}: ${JSON.stringify(task.query_inputs)}`);
    assert.ok(!q.path.startsWith(status.run_dir), 'run の領域の下の写しでない');
  }
  assert.ok(isAbsolute(abs) && existsSync(abs));
  assert.equal(realpathSync(abs), realpathSync(join(ws, 'target', 'spec.md')), '依頼の location の元のファイル');
});

test('SP-FORMALMETHOD-005・012 担当に渡す資料: 忠実さの確認役の対象の資料は対応表の行と節の出所の範囲だけで、inventory の全体と manifest を渡さず、範囲ごとの指紋が記録される', async (t) => {
  const { harness, result, status } = await runScenario(t, {});
  const task = harness.memory.tasks.find((x) => x.context.perspective === 'fidelity');
  const refs = task.context.input_refs;
  const tr = refs.filter((x) => x.ref.startsWith('target:'));
  assert.deepEqual(tr.map((x) => x.ref), ['target:T1/spec.md']);
  const mapping = JSON.parse(readFileSync(join(status.run_dir, refs.find((x) => x.name.startsWith('mapping-')).ref), 'utf8'));
  const spans = [...new Set(mapping.rows.filter((r) => r.source.kind === 'location').map((r) => r.source.span))].sort();
  assert.deepEqual(tr[0].spans, spans, '対応表の行の範囲（節の出所の要素は同じ行）');
  assert.ok(!refs.some((x) => x.ref.endsWith('inventory.json') || x.ref.endsWith('manifest.json')), JSON.stringify(refs.map((x) => x.ref)));
  const view = JSON.parse(readFileSync(join(status.run_dir, 'views', 'fidelity-M1.json'), 'utf8'));
  assert.deepEqual(view.properties.map((p) => p.id), ['P1']);
  assert.ok([...view.bound_elements, ...view.unbound_elements].every((e) => !('text' in e) && e.source.span), '要素の一覧は id と範囲だけ');
  assert.deepEqual(view.bound_elements.map((e) => e.id), ['E-P1']);
  // モデルの性質ごとに、節（rule・premise・goal）と保証の抜粋と、その性質の query のファイルの絶対パス（モデルの全体を切り出させない）
  const model = JSON.parse(readFileSync(join(status.run_dir, refs.find((x) => x.name.startsWith('model-')).ref), 'utf8'));
  assert.deepEqual(view.model_properties, model.properties.map((p) => ({ id: p.id, inventory_property_ids: p.inventory_property_ids, expected: p.expected, assurance: p.assurance,
    clauses: p.clauses, query_path: join(status.run_dir, p.query_ref) })));
  assert.ok(view.model_properties.every((p) => existsSync(p.query_path) && refs.some((x) => join(status.run_dir, x.ref) === p.query_path)), 'query は渡した資料のファイル');
  // 範囲ごとの指紋（quote_hash と同じ求め方）とファイル全体の指紋
  const conf = result.confirmations.meaning.find((c) => c.checker === task.task_id && c.kind === 'fidelity');
  const m = conf.materials.find((x) => x.ref === 'target:T1/spec.md');
  const abs = JSON.parse(readFileSync(join(status.run_dir, 'request.json'), 'utf8')).targets[0].fixed.files.find((f) => f.path === 'spec.md').abs_path;
  const text = readFileSync(abs, 'utf8');
  assert.equal(m.hash, sha(text));
  assert.deepEqual(m.spans, spans.map((span) => ({ span, hash: lineHash(text, span) })));
});

test('SP-FORMALMETHOD-005・012 担当に渡す資料: 性質の出所が節にも対応表にも無くても、忠実さの確認役にはその性質の出所の範囲を渡し、要素の一覧はそのモデルの inventory の要素だけ', async (t) => {
  const p2 = { id: 'P2', file: 'spec.md', line: 3, statement: 'y は x より大きい', query: { result: 'unsat' }, sanity: { result: 'sat' }, mutation: { result: 'sat' }, clauseSources: ['E-P1'], mappingLocation: false };
  const { harness, status } = await runScenario(t, { scenario: { properties: [...defaultScenario().properties, p2] } });
  const task = harness.memory.tasks.find((x) => x.context.perspective === 'fidelity');
  assert.ok(task, 'fidelity の担当が出る');
  const tr = task.context.input_refs.find((x) => x.ref === 'target:T1/spec.md');
  assert.ok(tr?.spans?.includes('L3-L3') || tr?.spans?.some((sp) => { const [, a, b] = sp.match(/^L(\d+)-L(\d+)$/).map(Number); return a <= 3 && 3 <= b; }), `P2 の出所の行 L3 が範囲に入る: ${JSON.stringify(tr)}`);
  const view = JSON.parse(readFileSync(join(status.run_dir, 'views', `${task.context.unit_id}.json`), 'utf8'));
  assert.deepEqual(view.properties.map((p) => p.id).sort(), ['P1', 'P2']);
  assert.deepEqual(view.bound_elements.map((e) => e.id).sort(), ['E-P1', 'E-P2'], 'このモデルの性質に結ばれた要素');
});

test('SP-FORMALMETHOD-005・012 担当に渡す資料: 忠実さの確認役の view は、結ばれた要素・どの性質にも結ばれない要素・外部の依存を分けて持ち、その出所の範囲を渡す', async (t) => {
  const externalDependencies = [{ id: 'X1', text: 'w は外部の計器が与える', source: { target_id: 'T1', file: 'spec.md', span: 'L5-L5' } }];
  const { harness, status } = await runScenario(t, { scenario: { extraElements: [{ file: 'spec.md', line: 4 }], externalDependencies } });
  const task = harness.memory.tasks.find((x) => x.context.perspective === 'fidelity');
  const view = JSON.parse(readFileSync(join(status.run_dir, 'views', `${task.context.unit_id}.json`), 'utf8'));
  assert.deepEqual(view.bound_elements.map((e) => e.id), ['E-P1']);
  assert.deepEqual(view.unbound_elements.map((e) => e.id), ['E-X4'], 'どの性質にも結ばれない要素');
  assert.deepEqual(view.external_dependencies, externalDependencies, '外部の依存の文と出所');
  const tr = task.context.input_refs.find((x) => x.ref === 'target:T1/spec.md');
  const has = (n) => tr.spans.some((sp) => { const [, a, b] = sp.match(/^L(\d+)-L(\d+)$/).map(Number); return a <= n && n <= b; });
  assert.ok(has(2) && has(4) && has(5), `結ばれた要素（L2）・結ばれない要素（L4）・外部の依存（L5）の行が範囲に入る: ${JSON.stringify(tr.spans)}`);
});

test('SP-FORMALMETHOD-011・012 担当に渡す資料: 原因の分類役には、主題から辿れる範囲に依頼の範囲の全体を足して渡す（反例・組合せ・問い）', async (t) => {
  const request = { ...req('target'), scope: { include: [{ kind: 'location', target_id: 'T1', file: 'spec.md', span: 'L1-L4' }], exclude: [] } };
  const q = { id: 'Q9', missing_decision: 'R2 の y が x と等しいときの扱い', affected: ['P2'], options: ['許す', '許さない'] };
  const scenarios = {
    counterexample: { properties: [{ ...defaultScenario().properties[0], id: 'P1', line: 3, query: { result: 'sat' } }] },
    combination: { stateMachine: SM },
    question: { properties: [defaultScenario().properties[0], { ...defaultScenario().properties[0], id: 'P2', line: 3 }], questionsBy: { extractor: [q] }, cause: { cause: '要求の不足', grounds: 'R2 は等しい場合を定めない', questions: [q] } },
  };
  for (const [kind, scenario] of Object.entries(scenarios)) {
    const { harness } = await runScenario(t, { request, scenario });
    const task = harness.memory.tasks.find((x) => x.role === 'cause-analyst' && x.context.subject?.kind === kind);
    assert.ok(task, `${kind} の原因の分類役が出る`);
    const tr = task.context.input_refs.find((x) => x.ref === 'target:T1/spec.md');
    assert.deepEqual(tr?.spans, ['L1-L4'], `${kind}: 依頼の範囲の全体（主題の出所はその中）: ${JSON.stringify(task.context.input_refs)}`);
  }
});

test('SP-FORMALMETHOD-001・004 担当に渡す資料: 依頼の範囲が location の span なら、抽出役と抽出の確認役にはその範囲だけを渡し、抽出役は範囲だけを覆って網羅の照合を通る', async (t) => {
  const request = { ...req('target'), scope: { include: [{ kind: 'location', target_id: 'T1', file: 'spec.md', span: 'L1-L2' }], exclude: [] } };
  const { harness, result } = await runScenario(t, { request });
  assert.deepEqual(resultInvariants(result), []);
  const tasks = harness.memory.tasks.filter((x) => x.role === 'extractor' || x.context.perspective === 'extraction');
  assert.deepEqual(tasks.map((x) => x.role).sort(), ['extraction-reviewer', 'extractor'], '抽出の確認役まで進む');
  for (const task of tasks) {
    const r = task.context.input_refs.find((x) => x.ref === 'target:T1/spec.md');
    assert.deepEqual(r?.spans, ['L1-L2'], `${task.task_id}: ${JSON.stringify(task.context.input_refs)}`);
  }
  const subs = harness.memory.submits.filter((x) => x.role === 'extractor');
  assert.deepEqual(subs.map((x) => [x.result.ok, x.result.problems]), [[true, []]], '範囲（L1-L2）だけを覆えば 1 回目で受理');
  assert.deepEqual(result.verified_scope.unread, [], '範囲の外の行（L3-L5）は読めない箇所にしない');
  assert.ok(!result.unverified.some((u) => u.item.startsWith('読めない箇所')), JSON.stringify(result.unverified));
});

test('SP-FORMALMETHOD-004 網羅の照合: 依頼の範囲の行を scanned で覆わない inventory は、範囲の行を覆わない欠陥で落ちる', async (t) => {
  const request = { ...req('target'), scope: { include: [{ kind: 'location', target_id: 'T1', file: 'spec.md', span: 'L1-L2' }], exclude: [] } };
  const { harness } = await runScenario(t, { request, scenario: { scanDropLast: true } });
  const subs = harness.memory.submits.filter((x) => x.role === 'extractor');
  assert.ok(subs.length >= 1);
  assert.equal(subs[0].result.ok, false);
  assert.ok(subs[0].result.problems.some((x) => /spec\.md の依頼の範囲（L1-L2）の全ての行を覆わない/.test(x)), JSON.stringify(subs[0].result));
});
});

