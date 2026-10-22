import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs, lstatSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRITERIA_DIR, CRITERIA_FILES } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { OUTSIDE_COPY, check, closure, outside } from '../tools/sync-bp-criteria.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'sync-bp-criteria.mjs');
const COPY = path.join('plugins', 'skill-creator', 'skills', 'skill-creator-best-practices', CRITERIA_DIR);
const CONFORMANCE = 'specifications/bp-conformance.md';

async function tmpRoot(t, { copies = true } = {}) {
  const dir = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'bp-copy-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const rel of closure(ROOT).files) {
    for (const base of copies ? ['docs', COPY] : ['docs']) {
      const dest = path.join(dir, base, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(path.join(ROOT, 'docs', rel), dest);
    }
  }
  return dir;
}

function tool(root, ...args) {
  const r = spawnSync(process.execPath, [TOOL, ...args, '--root', root], { encoding: 'utf8' });
  return { code: r.status, lines: r.stdout.split('\n').filter(Boolean) };
}

// bp-conformance を変える変異は、写しも同じに変えて、狙った種類だけが出るようにする。
async function editConformance(root, extra) {
  for (const base of ['docs', COPY]) await fs.appendFile(path.join(root, base, CONFORMANCE), `\n${extra}\n`);
}

test('SP-BPRUN-036: 配布する判定基準の写しが正本と一致し、閉包の全てを持つ（make test の合否）', () => {
  const found = check(ROOT);
  assert.deepEqual(found, [], `判定基準の写しが正本と食い違う。node tools/sync-bp-criteria.mjs で写し直す:\n${found.map((p) => `${p.kind} ${p.path}`).join('\n')}`);
});

const MUTATIONS = [
  ['正本を 1 字変える', async (r) => fs.appendFile(path.join(r, 'docs', 'design', 'skill-design-patterns.md'), 'x'), ['differ design/skill-design-patterns.md']],
  ['写しを 1 字変える', async (r) => fs.appendFile(path.join(r, COPY, 'specifications', 'bp-run.md'), 'x'), ['differ specifications/bp-run.md']],
  ['写しを 1 つ消す', async (r) => fs.rm(path.join(r, COPY, 'requirements', 'bp-operations.md')), ['missing requirements/bp-operations.md']],
  ['置き場に余計なファイルを足す', async (r) => fs.writeFile(path.join(r, COPY, 'specifications', 'stray.md'), 'x'), ['extra specifications/stray.md']],
  ['写しを symlink に置き換える', async (r) => {
    const p = path.join(r, COPY, 'specifications', 'bp-entry.md');
    await fs.rm(p);
    await fs.symlink(path.join(r, 'docs', 'specifications', 'bp-entry.md'), p);
  }, ['symlink specifications/bp-entry.md']],
  ['bp-conformance に docs/ のパスの参照を足し、文書も置く', async (r) => {
    await fs.writeFile(path.join(r, 'docs', 'specifications', 'bp-zz.md'), 'zz');
    await editConformance(r, '`docs/specifications/bp-zz.md`');
  }, ['missing specifications/bp-zz.md']],
  ['bp-conformance に docs/ のパスの参照を足し、文書を置かない', async (r) => editConformance(r, '`docs/specifications/bp-zz.md`'), [`unclosed ${CONFORMANCE} docs/specifications/bp-zz.md`]],
  ['bp-conformance に glob の参照を足す', async (r) => editConformance(r, '`docs/specifications/bp-*.md`'), [`unparsed ${CONFORMANCE} docs/specifications/bp-*.md`]],
  ['bp-conformance に相対リンクを足し、文書も置く', async (r) => {
    await fs.writeFile(path.join(r, 'docs', 'requirements', 'bp-zz.md'), 'zz');
    await editConformance(r, '[zz](../requirements/bp-zz.md)');
  }, ['missing requirements/bp-zz.md']],
  ['bp-conformance に前置きの無いファイル名を足し、文書を置かない', async (r) => editConformance(r, 'bp-zz.md'), [`unclosed ${CONFORMANCE} bp-zz.md`]],
];

for (const [label, mutate, expected] of MUTATIONS) {
  test(`SP-BPRUN-036: ${label}と、make test の検査の入口（sync-bp-criteria --check）が終了符号 1 と食い違いの種類を返す`, async (t) => {
    const root = await tmpRoot(t);
    await mutate(root);
    assert.deepEqual(tool(root, '--check'), { code: 1, lines: expected });
  });
}

test('SP-BPRUN-036: 変異の無い作業コピーでは sync-bp-criteria --check が終了符号 0 で何も出さない', async (t) => {
  assert.deepEqual(tool(await tmpRoot(t), '--check'), { code: 0, lines: [] });
});

test('SP-BPRUN-036: 写しの無い作業コピーに書き込みの mode を走らせると --check が 0 になり、写しは全て通常のファイルである', async (t) => {
  const root = await tmpRoot(t, { copies: false });
  assert.equal(tool(root, '--check').code, 1);
  assert.deepEqual(tool(root), { code: 0, lines: [] });
  assert.deepEqual(tool(root, '--check'), { code: 0, lines: [] });
  for (const rel of closure(root).files) assert.ok(lstatSync(path.join(root, COPY, rel)).isFile(), rel);
});

test('SP-BPRUN-036: 写しの集合は bp-conformance とその直接の参照先の 9 ファイルで、CLI が読む CRITERIA_FILES を全て含む', () => {
  const { files, problems } = closure(ROOT);
  assert.deepEqual(problems, []);
  assert.equal(files.length, 9);
  for (const parts of Object.values(CRITERIA_FILES)) assert.ok(files.includes(parts.join('/')), parts.join('/'));
});

test('SP-BPRUN-036: URL の中の docs/ は閉包の参照に数えない', async (t) => {
  const root = await tmpRoot(t);
  const before = closure(root).files;
  await editConformance(root, 'https://code.claude.com/docs/en/sub-agents と code.claude.com/docs/specifications/bp-zz.md');
  assert.deepEqual(closure(root), { files: before, problems: [] });
});

test('SP-BPRUN-036: 写しの一致の検査が make test の Node のテストに入っている', () => {
  const plan = execFileSync('make', ['-n', 'test'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(plan, /tests\/bp-criteria-copy\.test\.mjs/);
});

function keyed(list) {
  return list.map((r) => `${r.file} ${r.token}`).sort();
}

test('SP-BPRUN-036: 写しの中の、写しの外を指す docs/ の参照は全て除外一覧 OUTSIDE_COPY にあり、一覧の全てが写しの中に現れる', async (t) => {
  assert.deepEqual(keyed(outside(ROOT)), keyed(OUTSIDE_COPY));
  for (const r of OUTSIDE_COPY) assert.ok(r.reason, `${r.file} ${r.token}: 理由が無い`);
  const root = await tmpRoot(t);
  await fs.appendFile(path.join(root, COPY, 'specifications', 'bp-findings.md'), '\n`docs/design/zz.md`\n');
  assert.deepEqual(keyed(outside(root)), keyed([...OUTSIDE_COPY, { file: 'specifications/bp-findings.md', token: 'docs/design/zz.md' }]));
});
