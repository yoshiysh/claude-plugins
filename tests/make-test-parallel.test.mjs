import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/run_make_targets.sh');

// fixture の Makefile と、スクリプトが一時ディレクトリを作る TMPDIR を用意する。
// 本物の Makefile のテスト一式は入れ子で走らせない（npm ci や再帰を起こさないため）。
function fixture(t, makefile) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mtp-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp);
  fs.writeFileSync(path.join(dir, 'Makefile'), makefile.replace(/^ {2}/gm, '\t'));
  const env = { ...process.env, TMPDIR: tmp };
  for (const k of ['MAKEFLAGS', 'MAKELEVEL', 'MFLAGS', 'MAKEFILES']) delete env[k];
  return { dir, tmp, env };
}

function run(fx, targets) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', [SCRIPT, 'make', ...targets], { cwd: fx.dir, env: fx.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('全て成功: target の順にログを出し、要約を最後に置き、0 で終わる。所要時間はジョブごとに測る', async (t) => {
  const fx = fixture(t, `
slow:
  @sleep 4; echo SLOW-OUT
fast:
  @echo FAST-OUT
`);
  const started = Date.now();
  const r = await run(fx, ['slow', 'fast']);
  const wall = (Date.now() - started) / 1000;
  assert.equal(r.code, 0, r.out + r.err);
  const lines = r.out.trimEnd().split('\n');
  const head = (name) => lines.findIndex((l) => l.startsWith(`==== ${name}: `));
  assert.ok(head('slow') >= 0 && head('slow') < lines.indexOf('SLOW-OUT'));
  assert.ok(lines.indexOf('SLOW-OUT') < head('fast') && head('fast') < lines.indexOf('FAST-OUT'));
  assert.equal(lines.at(-3), '==== make test summary ====');
  assert.match(lines.at(-2), /^PASS {2}slow {2}\d+s$/);
  assert.match(lines.at(-1), /^PASS {2}fast {2}\d+s$/);
  const sec = (name) => Number(new RegExp(`^PASS  ${name}  (\\d+)s$`, 'm').exec(r.out)[1]);
  assert.ok(sec('slow') >= 3, r.out);
  // 親が順に wait して時刻を取る実装だと fast にも slow の時間が付く。
  assert.ok(sec('fast') <= 2, r.out);
  assert.ok(wall < 10, `wall=${wall}`);
  assert.deepEqual(fs.readdirSync(fx.tmp), []);
});

test('同時に走る: 2 つの 3 秒の target が、合計より短い時間で終わる', async (t) => {
  const fx = fixture(t, `
a:
  @sleep 3
b:
  @sleep 3
`);
  const started = Date.now();
  const r = await run(fx, ['a', 'b']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok((Date.now() - started) / 1000 < 5.5);
});

test('先頭の target が失敗: 他の target は最後まで走り、失敗のログ末尾を要約の直前に出し直し、非 0 で終わる', async (t) => {
  const fx = fixture(t, `
bad:
  @echo BAD-DETAIL; exit 3
good:
  @sleep 1; echo GOOD-DONE; touch good.done
`);
  const r = await run(fx, ['bad', 'good']);
  assert.notEqual(r.code, 0);
  assert.ok(fs.existsSync(path.join(fx.dir, 'good.done')));
  assert.match(r.out, /^==== bad: FAIL \(\d+s\) ====$/m);
  const lines = r.out.trimEnd().split('\n');
  const redo = lines.indexOf('==== FAIL bad (last 30 lines) ====');
  const sum = lines.indexOf('==== make test summary ====');
  assert.ok(redo > lines.indexOf('GOOD-DONE') && redo < sum, r.out);
  assert.ok(lines.slice(redo, sum).includes('BAD-DETAIL'), r.out);
  assert.equal(lines.length, sum + 3, r.out);
  assert.match(lines[sum + 1], /^FAIL {2}bad {2}\d+s$/);
  assert.match(lines[sum + 2], /^PASS {2}good {2}\d+s$/);
  assert.deepEqual(fs.readdirSync(fx.tmp), []);
});

test('失敗ログの出し直しは末尾 30 行だけ', async (t) => {
  const fx = fixture(t, `
bad:
  @i=1; while [ $$i -le 35 ]; do echo "L$$i"; i=$$((i + 1)); done; exit 1
`);
  const r = await run(fx, ['bad']);
  assert.notEqual(r.code, 0);
  const lines = r.out.trimEnd().split('\n');
  const redo = lines.indexOf('==== FAIL bad (last 30 lines) ====');
  const sum = lines.indexOf('==== make test summary ====');
  const tail = lines.slice(redo + 1, sum);
  assert.equal(tail.length, 30, r.out);
  // ログの最後は make の Error の行なので、L35 までの 29 行と Error の 1 行が入る。
  assert.equal(tail[0], 'L7');
  assert.equal(tail[28], 'L35');
});

// pid ファイルが書き終わるまで待つ（書きかけの '' を 0 と読むと、kill(0) がプロセスグループ全体に届く）。
async function readPid(file) {
  for (let i = 0; i < 200; i += 1) {
    const pid = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8').trim()) : 0;
    if (Number.isInteger(pid) && pid > 0) return pid;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`pid が書かれない: ${file}`);
}

for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  test(`${signal} で中断: 走っている target の子孫をすぐ止め、一時ディレクトリを消して ${code} で終わる`, async (t) => {
    const fx = fixture(t, `
done:
  @echo DONE
long:
  @sleep 60 & echo $$! > long.pid; wait
`);
    const child = spawn('/bin/sh', [SCRIPT, 'make', 'done', 'long'], { cwd: fx.dir, env: fx.env, stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', (c) => resolve(c)));
    const grandchild = await readPid(path.join(fx.dir, 'long.pid'));
    t.after(() => { if (alive(grandchild)) process.kill(grandchild, 'SIGKILL'); });
    assert.ok(alive(grandchild));
    const sent = Date.now();
    child.kill(signal);
    assert.equal(await exited, code);
    // stop が子孫を止めないと、wait は sleep 60 の終わりまで戻らない。
    assert.ok(Date.now() - sent < 10000, `${Date.now() - sent}ms`);
    for (let i = 0; i < 40 && alive(grandchild); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(grandchild), false);
    assert.deepEqual(fs.readdirSync(fx.tmp), []);
  });
}

test('本物の Makefile: make -n test は 3 つの target の recipe を表示し、0 で終わる', (t) => {
  const env = { ...process.env };
  for (const k of ['MAKEFLAGS', 'MAKELEVEL', 'MFLAGS', 'MAKEFILES']) delete env[k];
  try {
    execFileSync('make', ['-q', 'runtime-deps'], { cwd: ROOT, env, stdio: 'ignore' });
  } catch {
    t.skip('runtime-deps の stamp が古い（make runtime-deps を先に流す）');
    return;
  }
  const out = execFileSync('make', ['-n', 'test', 'NPM=false'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.match(out, /quick_validate\.py/);
  assert.match(out, /scripts\/traceability\/cli\.mjs/);
  assert.match(out, /scripts\/run_node_tests\.mjs/);
  assert.match(out, /^==== make test summary ====$/m);
});
