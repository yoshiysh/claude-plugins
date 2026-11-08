// PATH に置く道具の差し替え（cli-contract.md「呼び方と入力の口」: 道具は PATH から探す）。
// CLI は子 process に環境変数を渡さないので、wrapper は node の絶対 path で fake-z3.mjs を起動する。
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_Z3 = fileURLToPath(new URL('./fake-z3.mjs', import.meta.url));

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function makeFakeBin(dir, { mode = null, log = null, tag = null } = {}) {
  mkdirSync(dir, { recursive: true });
  const extra = [mode ? `--fake-mode=${mode}` : null, log ? `--fake-log=${log}` : null, tag ? `--fake-tag=${tag}` : null].filter(Boolean).map(sh).join(' ');
  const file = join(dir, 'z3');
  writeFileSync(file, `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(FAKE_Z3)} ${extra} "$@"\n`);
  chmodSync(file, 0o755);
  return dir;
}

const hasExe = (d, name) => {
  try { const p = join(d, name); return existsSync(p) && (statSync(p).mode & 0o111) !== 0; } catch { return false; }
};

// 今の PATH から、名前の実行体を持つディレクトリを除く（実機の z3 や ps を見えなくする）。
export function pathWithout(names, base = process.env.PATH ?? '') {
  return base.split(delimiter).filter((d) => d && !names.some((n) => hasExe(d, n))).join(delimiter);
}

// 偽の z3 を先頭に置き、実機の z3 を除いた PATH。
export function pathWithFake(binDir, base = process.env.PATH ?? '') {
  return [binDir, pathWithout(['z3'], base)].join(delimiter);
}
