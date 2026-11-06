#!/usr/bin/env node
// 状態を作る。run の前に呼び出し元だけが実行し、必要な許可には入れない（run の中の役が実行すると権限の確認が出る）。
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMain } from './state.mjs';

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const { code, out } = startMain(Buffer.concat(chunks).toString('utf8'));
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = code;
}
