#!/usr/bin/env node
// 試行ごとの写しを作り直し（make）、開始で状態に記録した再現手順のコマンドを写しの中で実行する（exec）。
// 写しは作業ツリーの今の内容から、ファイルを読むだけで作る（git worktree や git stash create は対象の .git に書く）。
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_ID, commandsOf, workRootOf } from './state.mjs';

const COPY_NAME = /^I\d+\.\d+(\.verify)?$/;
const RUN_NAME = /^r\d+$/;
const MAX_OUTPUT = 1 << 28;

// 写し先は <作業ファイルの置き場>/<状態 ID>/<run>/<意図 ID>.<試行>[.verify] に限り、途中に symlink を挟ませない
// （写しは消してから作るので、それ以外を受け付けると、置き場の外や他の意図の記録まで消しうる）。
function target(repo, to) {
  if (typeof repo !== 'string' || typeof to !== 'string') throw new Error('repo と to が要る');
  const root = workRootOf(repo);
  const parts = path.relative(root, path.resolve(to)).split(path.sep);
  if (parts.length !== 3 || !STATE_ID.test(parts[0]) || !RUN_NAME.test(parts[1]) || !COPY_NAME.test(parts[2])) {
    throw new Error(`写し先は ${root}/<状態 ID>/<run>/<意図 ID>.<試行>[.verify] に限る: ${to}`);
  }
  const commands = commandsOf(repo, parts[0]);
  const runDir = path.join(root, parts[0], parts[1]);
  mkdirSync(runDir, { recursive: true });
  if (realpathSync(runDir) !== path.join(realpathSync(root), parts[0], parts[1])) throw new Error(`写し先の途中に symlink がある: ${runDir}`);
  return { dest: path.join(runDir, parts[2]), commands };
}

const within = (outer, inner) => { const rel = path.relative(outer, inner); return !rel.startsWith('..') && !path.isAbsolute(rel); };
const realOr = (p) => { try { return realpathSync(p); } catch { return null; } };

// リポジトリの中を指す symlink は、写しの中の同じ場所を指すリンクにする。外を指すもの（絶対パスと、解決先が根の外に出る相対パス）は
// リンク先の中身を写す（リンクのまま写すと、写しの中の書き込みがリンクを通って対象のリポジトリや外へ届き、写しが隔離されない）。
// 写さないリンクは dropped に写しの中のパスで載せる: リポジトリを含む祖先を指すもの（祖先ごと写すと、リポジトリと置き場を丸ごと深く写し、
// 置き場が祖先の下にあると写しが自分の中へ写る）、外の中身を写す途中で写しを指すものや、辿ってきたディレクトリを指すもの（輪になって終わらない）、解決できないもの。
function linkInto(root, from, at, dest, dropped) {
  const real = realOr(from);
  if (real === null || (within(real, root) && real !== root)) return dropped.push(path.relative(dest, at));
  if (within(root, real)) return symlinkSync(path.relative(path.dirname(at), path.join(dest, path.relative(root, real))) || '.', at);
  copyOut(real, at, { root, dest, dropped, chain: [] });
}

function copyOut(real, at, ctx) {
  if (within(real, ctx.root) || within(ctx.dest, real) || within(real, ctx.dest) || ctx.chain.some((c) => within(real, c))) return ctx.dropped.push(path.relative(ctx.dest, at));
  if (!statSync(real).isDirectory()) return copyFileSync(real, at);
  mkdirSync(at);
  for (const name of readdirSync(real)) {
    const r = realOr(path.join(real, name));
    if (r === null) ctx.dropped.push(path.relative(ctx.dest, path.join(at, name)));
    else copyOut(r, path.join(at, name), { ...ctx, chain: [...ctx.chain, real] });
  }
}

export function make({ repo, to }) {
  const { dest } = target(repo, to);
  let old = null;
  try { old = lstatSync(dest); } catch {}
  if (old?.isSymbolicLink()) unlinkSync(dest);
  else if (old) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest);
  const files = execFileSync('git', ['-C', repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: MAX_OUTPUT }).split('\0').filter(Boolean);
  const root = realpathSync(repo);
  const dropped = [];
  for (const file of new Set(files)) {
    const from = path.join(repo, file);
    let st;
    try { st = lstatSync(from); } catch { continue; }
    if (!st.isFile() && !st.isSymbolicLink()) continue;
    const at = path.join(dest, file);
    mkdirSync(path.dirname(at), { recursive: true });
    if (st.isSymbolicLink()) linkInto(root, from, at, dest, dropped);
    else copyFileSync(from, at);
  }
  // 写しを独立した git のリポジトリにする（.git が無いと、写しの中の git が置き場の上にあるリポジトリを見つけて、そこを書き換える）。
  execFileSync('git', ['init', '-q'], { cwd: dest });
  return { path: dest, dropped };
}

export function exec({ repo, to, command }) {
  const { dest, commands } = target(repo, to);
  if (!existsSync(dest)) throw new Error(`写しが無い（先に make で作る）: ${dest}`);
  if (!Number.isInteger(command) || command < 1 || command > commands.length) throw new Error(`command は再現手順のコマンドの番号（1〜${commands.length}）: ${JSON.stringify(command)}`);
  const line = commands[command - 1];
  const r = spawnSync('/bin/sh', ['-c', line], { cwd: dest, encoding: 'utf8', maxBuffer: MAX_OUTPUT });
  return { path: dest, command: line, code: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

const OPS = { make, exec };

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try {
    const op = OPS[process.argv[2]] ?? (() => { throw new Error(`操作が無い（${Object.keys(OPS).join('・')}）: ${process.argv[2]}`); })();
    process.stdout.write(`${JSON.stringify({ ok: true, ...op(JSON.parse(Buffer.concat(chunks).toString('utf8'))) })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: error.message })}\n`);
    process.exitCode = 2;
  }
}
