import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'check.sh');
const cases = path.join(here, 'tlc_cases.sh');
const sections = path.join(here, 'prd_sections.sh');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-prd-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sh(args, options = {}) {
  return spawnSync('sh', args, { encoding: 'utf8', ...options, env: { ...process.env, ...options.env } });
}

test('relative TLC_DOT is rejected before loading TLC', () => {
  const result = sh([script], { env: { TLC_DOT: path.join('relative', 'graph.dot'), TLA2TOOLS: '/nonexistent/tla2tools.jar' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TLC_DOT must be an absolute path/);
  assert.doesNotMatch(result.stderr, /Unexpected TLC jar SHA-256/);
});

test('TLC_JOBS other than a positive integer is rejected before loading TLC', () => {
  for (const jobs of ['', '0', '00', '-1', 'abc', '1.5', ' 2']) {
    const result = sh([script], { env: { TLC_JOBS: jobs, TLA2TOOLS: '/nonexistent/tla2tools.jar' } });
    assert.equal(result.status, 1, `TLC_JOBS=${JSON.stringify(jobs)}`);
    assert.match(result.stderr, /TLC_JOBS must be a positive integer/);
    assert.doesNotMatch(result.stderr, /Unexpected TLC jar SHA-256/);
  }
});

test('TLC_JOBS defaults to the CPU count and accepts an explicit count', () => {
  const env = { ...process.env };
  delete env.TLC_JOBS;
  const fallback = spawnSync('sh', [cases, 'jobs'], { encoding: 'utf8', env });
  assert.equal(fallback.status, 0);
  const cpus = spawnSync('getconf', ['_NPROCESSORS_ONLN'], { encoding: 'utf8' });
  assert.equal(cpus.status, 0);
  assert.equal(fallback.stdout, `${Number(cpus.stdout.trim())}\n`);
  const explicit = sh([cases, 'jobs'], { env: { TLC_JOBS: '3' } });
  assert.equal(explicit.stdout, '3\n');
  const padded = sh([cases, 'jobs'], { env: { TLC_JOBS: '08' } });
  assert.equal(padded.stdout, '8\n');
});

const fakeJava = `#!/bin/sh
set -eu
config= dump= tmpdir=
while [ "$#" -gt 0 ]; do
  case $1 in
    -Djava.io.tmpdir=*) tmpdir=\${1#-Djava.io.tmpdir=}; shift ;;
    -config) config=$2; shift 2 ;;
    -dump) dump=$3; shift 3 ;;
    *) shift ;;
  esac
done
await= delay=0
. "$config"
echo "$name" > "own-$name"
echo "$name" > "$tmpdir/own-$name"
: > "$MARKERS/started-$name"
if [ -n "$await" ]; then
  i=0
  while [ ! -e "$MARKERS/started-$await" ]; do
    i=$((i + 1))
    [ "$i" -le 40 ] || { echo "never saw $await"; exit 98; }
    sleep 0.05
  done
fi
sleep "$delay"
[ -z "$dump" ] || echo dumped > "$dump"
echo "cwd=$(pwd)"
echo "tmp=$tmpdir"
echo "seen=$(ls -a . "$tmpdir" | grep '^own-' | sort | tr '\n' ' ')"
echo "$out"
exit "$code"
`;

function caseDir(t, specs) {
  const dir = tempDir(t);
  const java = path.join(dir, 'fake-java');
  fs.writeFileSync(java, fakeJava, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'BP.tla'), '---- MODULE BP ----\n====\n');
  for (const spec of specs) {
    const lines = [`name=${spec.id}`, `out='${spec.out}'`, `code=${spec.exit}`];
    if (spec.await) lines.push(`await=${spec.await}`);
    if (spec.delay) lines.push(`delay=${spec.delay}`);
    fs.writeFileSync(path.join(dir, `${spec.id}.cfg`), `${lines.join('\n')}\n`);
    const meta = ['BP', spec.expectCode, spec.expectMessage, `label ${spec.id}`, spec.okline ?? '', spec.dump ?? ''];
    fs.writeFileSync(path.join(dir, `${spec.id}.case`), `${meta.join('\n')}\n`);
  }
  fs.writeFileSync(path.join(dir, 'all.list'), specs.map((spec) => `${spec.id}\n`).join(''));
  return { dir, env: { JAVA: java, TLA2TOOLS: path.join(dir, 'unused.jar'), TLC_JOBS: '2', MARKERS: dir } };
}

test('parallel cases report in declaration order regardless of finish order', (t) => {
  const { dir, env } = caseDir(t, [
    { id: 'first', out: 'Invariant A is violated', exit: 12, await: 'second', delay: 0.3, expectCode: 12, expectMessage: 'Invariant A is violated', okline: 'first ok' },
    { id: 'second', out: 'Model checking completed.', exit: 0, expectCode: 0, expectMessage: 'Model checking completed.', okline: 'second ok', dump: 'graph.dot' },
    { id: 'quiet', out: 'Action property P is violated', exit: 13, expectCode: 13, expectMessage: 'Action property P is violated' },
  ]);
  const run = sh([cases, 'run', dir, path.join(dir, 'all.list')], { env });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fs.statSync(path.join(dir, 'second.status')).mtimeMs <= fs.statSync(path.join(dir, 'first.status')).mtimeMs);
  assert.equal(fs.readFileSync(path.join(dir, 'graph.dot'), 'utf8'), 'dumped\n');
  const verify = sh([cases, 'verify', dir, path.join(dir, 'all.list')], { env });
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(verify.stdout, 'first ok\nsecond ok\n');
});

test('concurrent cases do not share a working directory or java.io.tmpdir', (t) => {
  const ids = ['alpha', 'beta', 'gamma', 'delta'];
  const { dir, env } = caseDir(t, ids.map((id, index) => ({
    id, out: 'done', exit: 0, expectCode: 0, expectMessage: 'done', await: ids[(index + 1) % ids.length], delay: 0.2,
  })));
  const run = sh([cases, 'run', dir, path.join(dir, 'all.list')], { env: { ...env, TLC_JOBS: '4' } });
  assert.equal(run.status, 0, run.stderr);
  const seen = ids.map((id) => {
    const log = fs.readFileSync(path.join(dir, `${id}.log`), 'utf8');
    assert.equal(fs.readFileSync(path.join(dir, `${id}.status`), 'utf8'), '0\n', log);
    const field = (key) => log.match(new RegExp(`^${key}=(.*)$`, 'm'))[1];
    assert.equal(field('seen').trim(), `own-${id} own-${id}`);
    assert.ok(fs.existsSync(path.join(field('cwd'), 'BP.tla')));
    assert.ok(fs.existsSync(path.join(field('cwd'), `${id}.cfg`)));
    return [fs.realpathSync(field('cwd')), fs.realpathSync(field('tmp'))];
  });
  const dirs = seen.flat();
  assert.equal(new Set(dirs).size, dirs.length);
  assert.ok(dirs.every((entry) => entry !== fs.realpathSync(dir)));
});

test('a case list whose last line has no newline still runs and verifies that case', (t) => {
  const { dir, env } = caseDir(t, [
    { id: 'head', out: 'done', exit: 0, expectCode: 0, expectMessage: 'done', okline: 'head ok' },
    { id: 'tail', out: 'Invariant T is violated', exit: 12, expectCode: 12, expectMessage: 'Invariant T is violated', okline: 'tail ok' },
  ]);
  fs.writeFileSync(path.join(dir, 'all.list'), 'head\ntail');
  assert.equal(sh([cases, 'run', dir, path.join(dir, 'all.list')], { env }).status, 0);
  const verify = sh([cases, 'verify', dir, path.join(dir, 'all.list')], { env });
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(verify.stdout, 'head ok\ntail ok\n');
  fs.writeFileSync(path.join(dir, 'tail.status'), '0\n');
  const broken = sh([cases, 'verify', dir, path.join(dir, 'all.list')], { env });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /^label tail; exit=0\n/);
});

test('a single job serializes the cases', (t) => {
  const { dir, env } = caseDir(t, [
    { id: 'first', out: 'done', exit: 0, await: 'second', expectCode: 0, expectMessage: 'done' },
    { id: 'second', out: 'done', exit: 0, expectCode: 0, expectMessage: 'done' },
  ]);
  const run = sh([cases, 'run', dir, path.join(dir, 'all.list')], { env: { ...env, TLC_JOBS: '1' } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'first.status'), 'utf8'), '98\n');
});

test('the first unexpected case stops verification with its log', (t) => {
  const { dir, env } = caseDir(t, [
    { id: 'good', out: 'Model checking completed.', exit: 0, expectCode: 0, expectMessage: 'Model checking completed.', okline: 'good ok' },
    { id: 'wrongexit', out: 'log of wrongexit', exit: 255, expectCode: 12, expectMessage: 'log of wrongexit', okline: 'wrongexit ok' },
    { id: 'wrongmessage', out: 'Invariant B is violated', exit: 12, expectCode: 12, expectMessage: 'Invariant C is violated', okline: 'wrongmessage ok' },
    { id: 'after', out: 'Model checking completed.', exit: 0, expectCode: 0, expectMessage: 'Model checking completed.', okline: 'after ok' },
  ]);
  const run = sh([cases, 'run', dir, path.join(dir, 'all.list')], { env });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'after.status'), 'utf8'), '0\n');
  const verify = sh([cases, 'verify', dir, path.join(dir, 'all.list')], { env });
  assert.equal(verify.status, 1);
  assert.equal(verify.stdout, 'good ok\n');
  assert.match(verify.stderr, /^label wrongexit; exit=255\ncwd=.*\ntmp=.*\nseen=.*\nlog of wrongexit\n$/);

  fs.writeFileSync(path.join(dir, 'rest.list'), 'wrongmessage\nafter\n');
  const message = sh([cases, 'verify', dir, path.join(dir, 'rest.list')], { env });
  assert.equal(message.status, 1);
  assert.equal(message.stdout, '');
  assert.match(message.stderr, /^label wrongmessage; exit=12\ncwd=.*\ntmp=.*\nseen=.*\nInvariant B is violated\n$/);

  fs.writeFileSync(path.join(dir, 'unrun.list'), 'good\n');
  fs.rmSync(path.join(dir, 'good.status'));
  const unrun = sh([cases, 'verify', dir, path.join(dir, 'unrun.list')], { env });
  assert.equal(unrun.status, 1);
  assert.match(unrun.stderr, /^label good; exit=missing\n/);
});

test('a duplicated case id is rejected before any TLC starts', (t) => {
  const { dir, env } = caseDir(t, [
    { id: 'twice', out: 'done', exit: 0, expectCode: 0, expectMessage: 'done' },
    { id: 'other', out: 'done', exit: 0, expectCode: 0, expectMessage: 'done' },
  ]);
  fs.writeFileSync(path.join(dir, 'all.list'), 'twice\nother\ntwice\n');
  const run = sh([cases, 'run', dir, path.join(dir, 'all.list')], { env });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Duplicate TLC case id: twice/);
  assert.equal(fs.existsSync(path.join(dir, 'started-twice')), false);
  assert.equal(fs.existsSync(path.join(dir, 'started-other')), false);
});

const designDoc = `# Doc

## Terms

- term

## Stop

text
\`\`\`
## Stop
## Other
\`\`\`

### Child

child text

## Unrelated

unrelated text
`;

function sectionRoot(t) {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'design.md'), designDoc);
  const scratch = path.join(root, 'tmp');
  fs.mkdirSync(scratch);
  const manifest = path.join(root, 'sections');
  const zero = '0'.repeat(64);
  fs.writeFileSync(manifest, `${zero}\tdocs/design.md\t## Stop\n${zero}\tdocs/design.md\t## Terms\n`);
  const env = { TMPDIR: scratch };
  const printed = sh([sections, 'print', root, manifest], { env });
  assert.equal(printed.status, 0, printed.stderr);
  fs.writeFileSync(manifest, printed.stdout);
  return { root, manifest, env, scratch, printed: printed.stdout };
}

test('pinned sections are cut out deterministically by heading', (t) => {
  const { root, manifest, env, scratch, printed } = sectionRoot(t);
  const stop = '## Stop\n\ntext\n```\n## Stop\n## Other\n```\n\n### Child\n\nchild text\n\n';
  const expected = spawnSync('shasum', ['-a', '256'], { input: stop, encoding: 'utf8' }).stdout.split(' ')[0];
  assert.equal(printed.split('\n')[0], `${expected}\tdocs/design.md\t## Stop`);
  assert.equal(sh([sections, 'print', root, manifest], { env }).stdout, printed);
  const check = sh([sections, 'check', root, manifest], { env });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout, 'docs/design.md: ## Stop: OK\ndocs/design.md: ## Terms: OK\n');
  assert.deepEqual(fs.readdirSync(scratch), []);
});

test('a change outside the pinned sections does not stop the check', (t) => {
  const { root, manifest, env } = sectionRoot(t);
  const doc = path.join(root, 'docs', 'design.md');
  fs.writeFileSync(doc, designDoc.replace('unrelated text', 'rewritten text'));
  assert.equal(sh([sections, 'check', root, manifest], { env }).status, 0);
});

test('a changed pinned section names the section and the re-verification steps', (t) => {
  const { root, manifest, env, scratch } = sectionRoot(t);
  const doc = path.join(root, 'docs', 'design.md');
  fs.writeFileSync(doc, designDoc.replace('child text', 'changed child'));
  const result = sh([sections, 'check', '.', path.basename(manifest)], { env, cwd: root });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'docs/design.md: ## Terms: OK\n');
  assert.match(result.stderr, /docs\/design\.md: ## Stop: CHANGED/);
  assert.match(result.stderr, /Re-verify the model before updating the pins/);
  assert.match(result.stderr, /run check\.sh until it passes/);
  assert.deepEqual(fs.readdirSync(scratch), []);

  const command = result.stderr.match(/^ {5}(sh .*)$/m)[1];
  const elsewhere = tempDir(t);
  const regenerate = spawnSync('sh', ['-c', command], { cwd: elsewhere, encoding: 'utf8' });
  assert.equal(regenerate.status, 0, regenerate.stderr);
  assert.equal(fs.readFileSync(manifest, 'utf8'), sh([sections, 'print', root, manifest], { env }).stdout);
  assert.equal(fs.existsSync(`${manifest}.new`), false);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  const recheck = sh([sections, 'check', root, manifest], { env });
  assert.equal(recheck.status, 0, recheck.stderr);
});

test('the regeneration command survives spaces and quotes in the paths', (t) => {
  const root = path.join(tempDir(t), "pins with 'quote'");
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'design.md'), designDoc);
  const manifest = path.join(root, 'pinned sections');
  fs.writeFileSync(manifest, `${'0'.repeat(64)}\tdocs/design.md\t## Stop\n`);
  const result = sh([sections, 'check', root, manifest]);
  assert.equal(result.status, 1);
  const command = result.stderr.match(/^ {5}(sh .*)$/m)[1];
  assert.equal(spawnSync('sh', ['-c', command], { cwd: tempDir(t) }).status, 0);
  assert.equal(sh([sections, 'check', root, manifest]).status, 0);
});

test('a last manifest line without a newline is still checked', (t) => {
  const { root, manifest, env } = sectionRoot(t);
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace(/\n$/, ''));
  assert.equal(sh([sections, 'check', root, manifest], { env }).stdout, 'docs/design.md: ## Stop: OK\ndocs/design.md: ## Terms: OK\n');
  fs.writeFileSync(path.join(root, 'docs', 'design.md'), designDoc.replace('- term', '- changed term'));
  const result = sh([sections, 'check', root, manifest], { env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/design\.md: ## Terms: CHANGED/);
});

test('a missing, duplicated, or malformed pin stops the check', (t) => {
  const { root, manifest, env, scratch } = sectionRoot(t);
  const doc = path.join(root, 'docs', 'design.md');
  fs.writeFileSync(doc, designDoc.replace('## Terms', '## Glossary'));
  const missing = sh([sections, 'check', root, manifest], { env });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /docs\/design\.md: heading not found: ## Terms/);
  assert.match(missing.stderr, /cannot be resolved/);

  fs.writeFileSync(doc, `${designDoc}\n## Stop\n\nagain\n`);
  const duplicated = sh([sections, 'check', root, manifest], { env });
  assert.equal(duplicated.status, 1);
  assert.match(duplicated.stderr, /docs\/design\.md: heading appears more than once: ## Stop/);

  fs.writeFileSync(doc, designDoc);
  fs.writeFileSync(manifest, `${'0'.repeat(64)}\tdocs/design.md\tStop\n`);
  const malformed = sh([sections, 'check', root, manifest], { env });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /:1: expected SHA-256<TAB>path<TAB>heading/);
  assert.deepEqual(fs.readdirSync(scratch), []);
});

test('the formal job runs only when the model, a pinned document, or a named path changed', (t) => {
  const { manifest } = sectionRoot(t);
  const affected = (files) =>
    sh([sections, 'affected', manifest, 'tests/formal/bp-prd/', '.github/workflows/verification.yml'], { input: files }).stdout;
  assert.equal(affected('docs/design.md\n'), 'true\n');
  assert.equal(affected('README.md\ntests/formal/bp-prd/BP.tla\n'), 'true\n');
  assert.equal(affected('.github/workflows/verification.yml\n'), 'true\n');
  assert.equal(affected('docs/design.md.bak\ntests/formal/other/x\nREADME.md\n'), 'false\n');
  assert.equal(affected(''), 'false\n');
  assert.equal(affected('README.md\ndocs/design.md'), 'true\n');
});
