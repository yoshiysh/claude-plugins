// 対象のリポジトリへの git の呼び出しは全てここを通す。読むだけの操作でも、索引の更新（.git/index の書き換え）や、
// リポジトリの設定による外部のコマンド（fsmonitor・署名の確かめ）が起きるので、設定で止め、任意の lock を取らせない。
import { spawnSync } from 'node:child_process';

const SAFE_CONFIG = ['core.fsmonitor=false', 'diff.autoRefreshIndex=false', 'core.untrackedCache=false', 'log.showSignature=false', 'gpg.program=false', 'gpg.ssh.program=false', 'gpg.x509.program=false'];
const MAX_OUTPUT = 1 << 28;

export function git(repo, args) {
  const r = spawnSync('git', [...SAFE_CONFIG.flatMap((c) => ['-c', c]), '-C', repo, ...args], { encoding: 'utf8', maxBuffer: MAX_OUTPUT, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// 失敗を例外にする形（状態の CLI と写しが使う）。
export function gitOk(repo, args) {
  const r = git(repo, args);
  if (r.code !== 0) throw new Error(`git ${args[0]} が失敗した: ${r.stderr.trim()}`);
  return r.stdout;
}
