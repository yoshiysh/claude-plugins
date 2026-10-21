import { promises as fs } from 'node:fs';
import { withLock } from '../journal.mjs';

const [dir, label, holdMs] = process.argv.slice(2);
await withLock(dir, async () => {
  await fs.appendFile(`${dir}/trace`, `enter ${label}\n`);
  await new Promise((r) => setTimeout(r, Number(holdMs)));
  await fs.appendFile(`${dir}/trace`, `exit ${label}\n`);
});
