// 単体: 生死の判定（lib/process.mjs の startTimeOf・livenessOf）。正本: cli-contract.md「生死の判定」、architecture.md「保持者の生死」。
// Issue #264 の残存失敗の原因の候補: WSL2 では procps の lstart（btime + starttime/HZ）が btime の揺れで 1 秒ずれ、
// 生きている保持者を pid の再利用（死んでいる）と誤る。ここでは読み方（ps か /proc か、比べ方）を決めずに、外から見える約束だけを確かめる:
//   - 同じ process の識別は、何度・どれだけの時間をまたいで判定しても 死んでいる にならない（開始時刻を読める環境では 生きている）
//   - 開始時刻の違う識別（pid の再利用）と、終わった process の識別は 死んでいる
//   - comm に空白や括弧を含む process でも同じ
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { startTimeOf, livenessOf } from './process.mjs';

// btime の揺れ（WSL2 で数秒のうちに 1〜3 秒跳ぶ）をまたぐため、判定を繰り返す時間
const SPAN_MS = 3500;
const hasProc = existsSync('/proc/self/stat');

function identityOf(pid) {
  return { pid, started_at: startTimeOf(pid), nonce: 'test-nonce' };
}

// SPAN_MS の間、識別の判定を繰り返し、出た判定の集合と回数を返す
async function judgeRepeatedly(identity) {
  const seen = new Map();
  const end = Date.now() + SPAN_MS;
  let n = 0;
  while (Date.now() < end) {
    const l = livenessOf(identity);
    seen.set(l, (seen.get(l) ?? 0) + 1);
    n += 1;
    if (n % 20 === 0) await new Promise((r) => { setTimeout(r, 10); });
  }
  return { seen, n };
}

async function spawnIdle(executable = process.execPath) {
  const child = spawn(executable, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  await new Promise((r, j) => { child.once('spawn', r); child.once('error', j); });
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await exited;
}

function assertNeverDead({ seen, n }, label, started) {
  assert.equal(seen.has('dead'), false, `${label}: ${n} 回の判定に 死んでいる が出ない（${JSON.stringify([...seen])}）`);
  // 開始時刻を読めた識別は、判定できない ではなく 生きている
  if (started !== null) assert.deepEqual([...seen.keys()], ['alive'], `${label}: 開始時刻を読めた識別は常に 生きている`);
}

test('cli-contract 生死の判定 3 #264: 自分の process の識別は、btime の揺れをまたぐ時間くり返し判定しても 死んでいる にならない', async () => {
  const id = identityOf(process.pid);
  assertNeverDead(await judgeRepeatedly(id), '自分の識別', id.started_at);
});

test('cli-contract 生死の判定 3 #264: 生きている子の識別は、くり返し判定しても 死んでいる にならず、終わった後は 死んでいる', async (t) => {
  const child = await spawnIdle();
  t.after(() => stopChild(child));
  const id = identityOf(child.pid);
  assertNeverDead(await judgeRepeatedly(id), '子の識別', id.started_at);
  await stopChild(child);
  assert.equal(livenessOf(id), 'dead', '終わった子の識別は 死んでいる（kill(pid,0) が ESRCH）');
});

test('cli-contract 生死の判定 2: 生きている pid に、数秒前に始まった別の process の開始時刻を付けた識別（pid の再利用）は 死んでいる', async (t) => {
  const own = startTimeOf(process.pid);
  // 自分の開始時刻と子の開始時刻を、比べ方の丸め（秒）を十分に超えて離す
  await new Promise((r) => { setTimeout(r, 2500); });
  const child = await spawnIdle();
  t.after(() => stopChild(child));
  const mine = startTimeOf(child.pid);
  if (own === null || mine === null) {
    // 開始時刻を読めない環境では 判定できない（生きている側）のまま
    assert.equal(livenessOf({ pid: child.pid, started_at: own ?? 'unknown', nonce: 'n' }), 'unknown');
    return;
  }
  assert.notEqual(mine, own, '2.5 秒離れて始まった 2 つの process の開始時刻は違う値で読める');
  assert.equal(livenessOf({ pid: child.pid, started_at: own, nonce: 'n' }), 'dead', '開始時刻の違う識別は 死んでいる');
  assert.equal(livenessOf({ pid: child.pid, started_at: mine, nonce: 'n' }), 'alive', '自分の開始時刻の識別は 生きている');
});

test('cli-contract 生死の判定 2・3 #264: comm に空白と括弧を含む 2 つの process（名前 "a) b (c"）は、各々の識別が 死んでいる にならず、2.5 秒離れて始まれば開始時刻が区別され、互いの開始時刻を付けた識別は 死んでいる', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fm-proc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const odd = join(dir, 'a) b (c');
  symlinkSync(process.execPath, odd);
  const first = await spawnIdle(odd);
  t.after(() => stopChild(first));
  if (hasProc) {
    const stat = readFileSync(`/proc/${first.pid}/stat`, 'utf8');
    assert.ok(stat.includes('(a) b (c)'), `comm が空白と括弧を含む: ${stat.slice(0, 60)}`);
  }
  const id1 = identityOf(first.pid);
  assertNeverDead(await judgeRepeatedly(id1), 'comm に括弧を含む 1 つ目の子の識別', id1.started_at);
  // 開始時刻の秒の丸め・±1 秒の許容を超えて離す。同じ名前・同じ形の 2 つの process は、開始時刻の欄以外（threads の数など）が揃うので、
  // 欄の数え違い（comm の空白で欄がずれる）なら 2 つの開始時刻が同じ値に読める
  await new Promise((r) => { setTimeout(r, 2500); });
  const second = await spawnIdle(odd);
  t.after(() => stopChild(second));
  const id2 = identityOf(second.pid);
  assertNeverDead(await judgeRepeatedly(id2), 'comm に括弧を含む 2 つ目の子の識別', id2.started_at);
  if (id1.started_at === null || id2.started_at === null) return;
  assert.notEqual(id2.started_at, id1.started_at, '2.5 秒離れて始まった 2 つの子の開始時刻は違う値で読める');
  assert.equal(livenessOf({ ...id2, started_at: id1.started_at }), 'dead', '2 つ目の子に 1 つ目の開始時刻を付けた識別は 死んでいる');
  assert.equal(livenessOf({ ...id1, started_at: id2.started_at }), 'dead', '1 つ目の子に 2 つ目の開始時刻を付けた識別は 死んでいる');
});

test('cli-contract 生死の判定 3 #264: ps -o lstart= が呼ぶたびに違う値を返す（btime の揺れを決定的に起こす）環境でも、/proc を読める Linux では生きている識別は 生きている で、開始時刻の違う識別は 死んでいる', async (t) => {
  if (!hasProc) return; // /proc の無い環境では lstart の値で比べるので、この揺れは防げない（cli-contract.md「生死の判定」）
  const dir = mkdtempSync(join(tmpdir(), 'fm-fakeps-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, 'ps');
  writeFileSync(fake, '#!/bin/sh\ndate +%s%N\n');
  chmodSync(fake, 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${saved ?? ''}`;
  t.after(() => { process.env.PATH = saved; });
  const a = startTimeOf(process.pid);
  const b = startTimeOf(process.pid);
  assert.ok(a !== null, '偽の ps の値を読めるので開始時刻は null でない');
  assert.equal(b, a, '同じ process の開始時刻は、ps の値が変わっても同じ値で読める');
  const id = identityOf(process.pid);
  assertNeverDead(await judgeRepeatedly(id), '偽の ps の下の自分の識別', id.started_at);
  const child = await spawnIdle();
  t.after(() => stopChild(child));
  assert.equal(livenessOf({ pid: child.pid, started_at: a, nonce: 'n' }), 'dead', '子の pid に自分の開始時刻を付けた識別は 死んでいる');
});
