import { promises as fs, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROMPT_AUDIT_FILE, STATE_DIR_NAME } from '../constants.mjs';
import { forbiddenReason } from '../workspace.mjs';

const HERE = path.dirname(realpathSync(fileURLToPath(import.meta.url)));
export const SKILL_DIR = path.resolve(HERE, '..', '..', '..');
export const REPO_ROOT = path.resolve(SKILL_DIR, '..', '..', '..', '..');
export const CRITERIA_FIXTURE = path.join(HERE, 'criteria');
export const PROMPT_AUDIT_FIXTURE = path.join(SKILL_DIR, PROMPT_AUDIT_FILE);
export const CLI = path.join(SKILL_DIR, 'scripts', 'bp-state.mjs');

export function newKey() {
  return `k-${randomBytes(6).toString('hex')}`;
}

export const LIMITS = Object.freeze({ attempts: 3, iterations: 3, untilPass: 3 });

// この checkout で end-to-end のテストを skip する理由（無ければ null）。トレーサビリティ検査の設定もこの関数を指し、skip を環境による未検証として許すかを同じ判定で決める。
export function environmentSkipReason() {
  return forbiddenReason(path.join(REPO_ROOT, STATE_DIR_NAME));
}

// 作業場所の判定は /tmp 系を拒否するので、状態の root はリポジトリの .gitignore 済みの場所に作る。
export function stateRoot(t) {
  const reason = environmentSkipReason();
  const root = path.join(REPO_ROOT, STATE_DIR_NAME, `test-${process.pid}-${randomBytes(4).toString('hex')}`);
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
  return { stateRoot: root, criteriaDir: CRITERIA_FIXTURE, promptAudit: PROMPT_AUDIT_FIXTURE, cwd: REPO_ROOT, env: {}, ...extra };
}

// 適用の判定表の行 row に CLI が導く答えの並び（SP-BPINSPECTION-006 の表）。検証役は行を選ばず答えだけを返す。
const SHAPE_PATHS = {
  ターンごとの指揮: ['いいえ', '問いに到達しない', '問いに到達しない', '問いに到達しない'],
  固定パイプライン型: ['はい', 'はい', '問いに到達しない', '問いに到達しない'],
  固定集合の反復型: ['はい', 'いいえ', 'はい', '問いに到達しない'],
  探索グラフ型: ['はい', 'いいえ', 'いいえ', 'はい'],
};
export function answersFor(row, asset) {
  const quotes = [{ asset, line: 1, text: '---' }];
  const [A, Q1, Q2, Q3] = SHAPE_PATHS[row.form];
  const ans = (answer) => ({ answer, quotes });
  const presence = (cell) => (cell === '*' ? '無' : cell);
  return {
    answers: { A: ans(A), W: ans(A === 'はい' ? 'いいえ' : '問いに到達しない'), Q1: ans(Q1), Q2: ans(Q2), Q3: ans(Q3) },
    ledger: ans(presence(row.ledger)),
    fanout: ans(presence(row.fanout)),
  };
}
