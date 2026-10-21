import { promises as fs, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR_NAME } from '../constants.mjs';
import { forbiddenReason } from '../workspace.mjs';

const HERE = path.dirname(realpathSync(fileURLToPath(import.meta.url)));
export const SKILL_DIR = path.resolve(HERE, '..', '..', '..');
export const REPO_ROOT = path.resolve(SKILL_DIR, '..', '..', '..', '..');
export const CRITERIA_FIXTURE = path.join(HERE, 'criteria');
export const CLI = path.join(SKILL_DIR, 'scripts', 'bp-state.mjs');

export function newKey() {
  return `k-${randomBytes(6).toString('hex')}`;
}

export const LIMITS = Object.freeze({ attempts: 3, iterations: 3, untilPass: 3 });

// 作業場所の判定は /tmp 系を拒否するので、状態の root はリポジトリの .gitignore 済みの場所に作る。
export function stateRoot(t) {
  const root = path.join(REPO_ROOT, STATE_DIR_NAME, `test-${process.pid}-${randomBytes(4).toString('hex')}`);
  const reason = forbiddenReason(root);
  if (reason) {
    t.skip(`checkout が /tmp 系にあり、作業場所の判定が end-to-end の root を拒否するため: ${reason}`);
    return null;
  }
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

export async function tmpDir(t, prefix = 'bp-target-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return realpathSync(dir);
}

export async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

export async function skillDir(t, files = { 'SKILL.md': '---\nname: x\n---\n# X\n本文\n' }) {
  const base = await tmpDir(t);
  const root = path.join(base, 'skill');
  await fs.mkdir(root);
  await writeTree(root, files);
  return root;
}

export function context(t, extra = {}) {
  const root = stateRoot(t);
  if (!root) return null;
  return { stateRoot: root, criteriaDir: CRITERIA_FIXTURE, cwd: REPO_ROOT, env: {}, ...extra };
}
