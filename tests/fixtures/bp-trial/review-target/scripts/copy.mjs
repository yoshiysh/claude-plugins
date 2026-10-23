#!/usr/bin/env node
// 試行ごとの写しを作り直す。git archive で取り出すので、対象のリポジトリの作業ツリーにも .git にも書かない（git worktree は .git に写しの管理情報を書く）。
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workRootOf } from './state.mjs';

export function copy({ repo, to }) {
  if (typeof repo !== 'string' || typeof to !== 'string') throw new Error('repo と to が要る');
  const root = workRootOf(repo);
  const dest = path.resolve(to);
  // 消してから作るので、作業ファイルの置き場の外を消さない。
  if (!dest.startsWith(`${root}${path.sep}`)) throw new Error(`写しは作業ファイルの置き場（${root}）の下に作る: ${dest}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const tar = execFileSync('git', ['-C', repo, 'archive', '--format=tar', 'HEAD'], { maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', dest], { input: tar });
  return { path: dest };
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try {
    process.stdout.write(`${JSON.stringify({ ok: true, ...copy(JSON.parse(Buffer.concat(chunks).toString('utf8'))) })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: error.message })}\n`);
    process.exitCode = 2;
  }
}
