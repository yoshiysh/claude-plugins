import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const docCheck = path.join(root, 'plugins/workflow/skills/prd-spec/scripts/doc_check.mjs');
const MODULE = 'FormalLoop';
const baseCfg = fs.readFileSync(path.join(here, `${MODULE}.cfg`), 'utf8');
const INVARIANT_VIOLATION = 12;

const MUTANTS = [
  ['item_level', 'HonestDone'],
  ['any_doc', 'CompleteSound'],
  ['open_not_counted', 'CompleteSound'],
  ['tried_not_counted', 'CompleteSound'],
  ['rerun_entry_formal', 'CompleteSound'],
  ['reset_on_rerun', 'CompleteSound'],
  ['prior_strict_only', 'RedefRecorded'],
  ['omit_big', 'NoDeadEnd'],
  ['no_formal_gate', 'GateSound'],
  ['fm_not_blocking', 'ReportNeverBlocks'],
  ['redraft_clears', 'CompleteSound'],
  ['tried_strict', 'HonestNoDefect'],
];
const WITNESSES = ['WitnessFixDone', 'WitnessBlockedViol', 'WitnessHonestDrop', 'WitnessRedraftDone'];

// jar が無い・版が違うときに skip すると、モデルを検査しないまま make test が通る（tests/formal/bp-prd/check.sh と同じく落とす）。
function tools() {
  const r = spawnSync(process.execPath, [docCheck, 'formal-tools'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const t = JSON.parse(r.stdout);
  if (t.fault) assert.fail(`TLC is unavailable: ${t.fault}`);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(t.jar)).digest('hex');
  assert.equal(sha, t.sha256, `Unexpected TLC jar SHA-256 at ${t.jar}`);
  return t;
}

function cfgFor(mutation, invariant) {
  const out = baseCfg.replace(/^ {2}Mutation = "none"$/m, `  Mutation = "${mutation}"`).replace(/^INVARIANTS .*$/m, `INVARIANTS ${invariant}`);
  assert.match(out, new RegExp(`Mutation = "${mutation}"`));
  assert.match(out, new RegExp(`^INVARIANTS ${invariant}$`, 'm'));
  return out;
}

function tlc(t, jar, cfg, java = process.env.JAVA || 'java') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prd-spec-formal-loop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(here, `${MODULE}.tla`), path.join(dir, `${MODULE}.tla`));
  fs.writeFileSync(path.join(dir, 'case.cfg'), cfg);
  // TLC は標準 module を java.io.tmpdir に展開して終了時に消すので、共有すると並列の起動が互いの写しを消す。
  fs.mkdirSync(path.join(dir, 'tmp'));
  const r = spawnSync(java, [`-Djava.io.tmpdir=${path.join(dir, 'tmp')}`, '-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', 'auto', '-metadir', path.join(dir, 'meta'), '-config', 'case.cfg', MODULE], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout}${r.stderr}`;
  return { status: r.status, out, trace: (out.match(/^State \d+:/gm) || []).length, dir };
}

function expectViolated(r, invariant) {
  assert.equal(r.status, INVARIANT_VIOLATION, r.out.slice(-4000));
  assert.match(r.out, new RegExp(`Invariant ${invariant} is violated`));
  assert.ok(r.trace >= 2, `counterexample for ${invariant} must leave the initial state (${r.trace} states)`);
}

const { jar } = tools();

test('the model passes every property', (t) => {
  const r = tlc(t, jar, baseCfg);
  assert.equal(r.status, 0, r.out.slice(-4000));
  assert.match(r.out, /Model checking completed\. No error has been found\./);
});

for (const [mutation, invariant] of MUTANTS) {
  test(`mutant ${mutation} is killed by ${invariant}`, (t) => {
    expectViolated(tlc(t, jar, cfgFor(mutation, invariant)), invariant);
  });
}

for (const witness of WITNESSES) {
  test(`witness ${witness} is reachable`, (t) => {
    expectViolated(tlc(t, jar, cfgFor('none', witness)), witness);
  });
}

const fakeJava = `#!/bin/sh
set -eu
tmpdir=
for arg; do
  case $arg in -Djava.io.tmpdir=*) tmpdir=\${arg#-Djava.io.tmpdir=} ;; esac
done
[ -n "$tmpdir" ] || { echo "no java.io.tmpdir"; exit 97; }
[ -d "$tmpdir" ] || { echo "missing $tmpdir"; exit 96; }
id=$$
: > "$tmpdir/own-$id"
echo "tmp=$tmpdir"
echo "seen=$(ls -a "$tmpdir" | grep '^own-' | tr '\\n' ' ')"
echo "own=own-$id"
`;

test('each TLC launch gets its own java.io.tmpdir', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prd-spec-formal-loop-java-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const java = path.join(dir, 'fake-java');
  fs.writeFileSync(java, fakeJava, { mode: 0o755 });
  const seen = [1, 2].map(() => {
    const r = tlc(t, jar, baseCfg, java);
    assert.equal(r.status, 0, r.out);
    const field = (key) => r.out.match(new RegExp(`^${key}=(.*)$`, 'm'))[1];
    assert.equal(field('seen').trim(), field('own'));
    const tmp = fs.realpathSync(field('tmp'));
    assert.ok(tmp.startsWith(`${fs.realpathSync(r.dir)}${path.sep}`), tmp);
    return tmp;
  });
  assert.equal(new Set(seen).size, seen.length);
  assert.ok(seen.every((entry) => entry !== fs.realpathSync(os.tmpdir())));
});
