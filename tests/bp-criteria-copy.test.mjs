import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs, lstatSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRITERIA_DIR, CRITERIA_FILES } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { OUTSIDE_COPY, check, closure, outside, repoPaths } from '../tools/sync-bp-criteria.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'sync-bp-criteria.mjs');
const COPY = path.join('plugins', 'skill-creator', 'skills', 'skill-creator-best-practices', CRITERIA_DIR);
const CONFORMANCE = 'specifications/bp-conformance.md';
const CONFORMANCE_TBD = 'specifications/bp-conformance.tbd.json';

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

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}

// TBD の text は bp-conformance の一部なので、本文と同じく写しも同じに変え、prd-spec の書式のまま書き直す。
async function editConformanceTbd(root, extra) {
  for (const base of ['docs', COPY]) {
    const file = path.join(root, base, CONFORMANCE_TBD);
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    data.tbd[0].text += extra;
    await fs.writeFile(file, `${JSON.stringify(sortDeep(data), null, 1)}\n`);
  }
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
  ['写しの .tbd.json を消す', async (r) => fs.rm(path.join(r, COPY, CONFORMANCE_TBD)), [`missing ${CONFORMANCE_TBD}`]],
  ['正本の .tbd.json を 1 字変える', async (r) => fs.appendFile(path.join(r, 'docs', CONFORMANCE_TBD), 'x'), [`differ ${CONFORMANCE_TBD}`]],
  ['写しの集合に入る別の文書の隣に .tbd.json を足す', async (r) => fs.writeFile(path.join(r, 'docs', 'specifications', 'bp-run.tbd.json'), '{}\n'), ['missing specifications/bp-run.tbd.json']],
  ['bp-conformance の隣の .tbd.json の text に写しの外の docs/ のパスを足す', async (r) => editConformanceTbd(r, '（`docs/specifications/bp-zz.md`）'), [`unclosed ${CONFORMANCE_TBD} docs/specifications/bp-zz.md`]],
  ['bp-conformance の隣の .tbd.json の text に docs/ のパスの参照を足し、文書も置く', async (r) => {
    await fs.writeFile(path.join(r, 'docs', 'specifications', 'bp-zz.md'), 'zz');
    await editConformanceTbd(r, '（`docs/specifications/bp-zz.md`）');
  }, ['missing specifications/bp-zz.md']],
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
  ['bp-conformance に数字を含む前置きの無いファイル名を足し、文書も置く', async (r) => {
    await fs.writeFile(path.join(r, 'docs', 'specifications', 'bp-v2.md'), 'v2');
    await editConformance(r, 'bp-v2.md');
  }, ['missing specifications/bp-v2.md']],
  ...[
    ['title 付きの相対リンク', '[zz](../requirements/bp-zz.md "題")'],
    ['山括弧の相対リンク', '[zz](<../requirements/bp-zz.md>)'],
    ['参照形式のリンクの定義', '[zz]: ../requirements/bp-zz.md'],
    ['HTML のリンク', '<a href="../requirements/bp-zz.md">zz</a>'],
  ].map(([label, ref]) => [`bp-conformance に${label}を足し、文書も置く`, async (r) => {
    await fs.writeFile(path.join(r, 'docs', 'requirements', 'bp-zz.md'), 'zz');
    await editConformance(r, ref);
  }, ['missing requirements/bp-zz.md']]),
  ['bp-conformance に %20 を含む相対リンクを足し、文書も置く', async (r) => {
    await fs.writeFile(path.join(r, 'docs', 'requirements', 'bp z.md'), 'zz');
    await editConformance(r, '[zz](../requirements/bp%20z.md)');
  }, ['missing requirements/bp z.md']],
  ['写しの置き場を正本への symlink に置き換える', async (r) => {
    await fs.rm(path.join(r, COPY), { recursive: true });
    await fs.symlink(path.join(r, 'docs'), path.join(r, COPY));
  }, [`symlink ${COPY}`]],
  ['写しの置き場の親（references）を symlink に置き換える', async (r) => {
    const refs = path.dirname(path.join(r, COPY));
    await fs.rename(refs, path.join(r, 'refs-real'));
    await fs.symlink(path.join(r, 'refs-real'), refs);
  }, [`symlink ${path.dirname(COPY)}`]],
  ['写しの中のディレクトリを正本への symlink に置き換える', async (r) => {
    await fs.rm(path.join(r, COPY, 'specifications'), { recursive: true });
    await fs.symlink(path.join(r, 'docs', 'specifications'), path.join(r, COPY, 'specifications'));
  }, ['symlink specifications']],
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

test('SP-BPRUN-036: 写しの集合に入らない文書の隣の .tbd.json は集合に入らず、--check は 0 で終わる', async (t) => {
  const root = await tmpRoot(t);
  const before = closure(root).files;
  await fs.writeFile(path.join(root, 'docs', 'specifications', 'zz.md'), 'zz');
  await fs.writeFile(path.join(root, 'docs', 'specifications', 'zz.tbd.json'), '{}\n');
  assert.deepEqual(closure(root), { files: before, problems: [] });
  assert.deepEqual(tool(root, '--check'), { code: 0, lines: [] });
});

test('SP-BPRUN-036: 空白の無い前置き（「正本:」）の後の docs/ のパスは参照に数え、写しが無ければ落とす', async (t) => {
  const root = await tmpRoot(t);
  await editConformance(root, '正本:docs/specifications/bp-zz.md');
  assert.deepEqual(tool(root, '--check'), { code: 1, lines: [`unclosed ${CONFORMANCE} docs/specifications/bp-zz.md`] });
});

test('SP-BPRUN-036: 写しの置き場が通常のファイルのとき、--check は symlink を返し、書き込みはディレクトリに作り直す', async (t) => {
  const root = await tmpRoot(t);
  await fs.rm(path.join(root, COPY), { recursive: true });
  await fs.writeFile(path.join(root, COPY), 'x');
  assert.deepEqual(tool(root, '--check'), { code: 1, lines: [`symlink ${COPY}`] });
  assert.deepEqual(tool(root), { code: 0, lines: [] });
  assert.deepEqual(tool(root, '--check'), { code: 0, lines: [] });
});

test('SP-BPRUN-036: URL の直後に空白なしで続く日本語の本文の docs/ のパスは参照に数え、写しが無ければ落とす', async (t) => {
  const root = await tmpRoot(t);
  await editConformance(root, '出所は https://x.example/a、正本は（docs/specifications/bp-zz.md）');
  assert.deepEqual(tool(root, '--check'), { code: 1, lines: [`unclosed ${CONFORMANCE} docs/specifications/bp-zz.md`] });
});

test('SP-BPRUN-036: URL の中の ( に続く docs/ は URL の一部で、参照に数えない', async (t) => {
  const root = await tmpRoot(t);
  await editConformance(root, 'https://x.example/a(docs/specifications/bp-absent.md)');
  assert.deepEqual(tool(root, '--check'), { code: 0, lines: [] });
});

test('SP-BPRUN-036: URL の問い合わせの中の docs/ は参照に数えない', async (t) => {
  const root = await tmpRoot(t);
  await editConformance(root, 'https://x.example/?p=docs/specifications/bp-zz.md');
  assert.deepEqual(tool(root, '--check'), { code: 0, lines: [] });
});

test('SP-BPRUN-036: 書き込みの mode は、写しの置き場とその中の symlink とディレクトリを通常のファイルに作り直し、置き場より上の symlink では書かずに 1 で終わる', async (t) => {
  const linkedRoot = await tmpRoot(t);
  await fs.rm(path.join(linkedRoot, COPY), { recursive: true });
  await fs.symlink(path.join(linkedRoot, 'docs'), path.join(linkedRoot, COPY));
  assert.deepEqual(tool(linkedRoot), { code: 0, lines: [] });
  assert.deepEqual(tool(linkedRoot, '--check'), { code: 0, lines: [] });
  assert.ok(lstatSync(path.join(linkedRoot, COPY)).isDirectory() && lstatSync(path.join(linkedRoot, 'docs', CONFORMANCE)).isFile());

  const inner = await tmpRoot(t);
  await fs.rm(path.join(inner, COPY, 'specifications'), { recursive: true });
  await fs.symlink(path.join(inner, 'docs', 'specifications'), path.join(inner, COPY, 'specifications'));
  await fs.rm(path.join(inner, COPY, 'requirements', 'bp-operations.md'));
  await fs.mkdir(path.join(inner, COPY, 'requirements', 'bp-operations.md'));
  assert.deepEqual(tool(inner), { code: 0, lines: [] });
  assert.deepEqual(tool(inner, '--check'), { code: 0, lines: [] });
  assert.ok(lstatSync(path.join(inner, 'docs', 'specifications', 'bp-run.md')).isFile(), '正本を消していない');

  const above = await tmpRoot(t);
  const refs = path.dirname(path.join(above, COPY));
  await fs.rename(refs, path.join(above, 'refs-real'));
  await fs.symlink(path.join(above, 'refs-real'), refs);
  assert.deepEqual(tool(above), { code: 1, lines: [`symlink ${path.dirname(COPY)}`] });
});

test('SP-BPRUN-036: 写しの無い作業コピーに書き込みの mode を走らせると --check が 0 になり、写しは全て通常のファイルである', async (t) => {
  const root = await tmpRoot(t, { copies: false });
  assert.equal(tool(root, '--check').code, 1);
  assert.deepEqual(tool(root), { code: 0, lines: [] });
  assert.deepEqual(tool(root, '--check'), { code: 0, lines: [] });
  for (const rel of closure(root).files) assert.ok(lstatSync(path.join(root, COPY, rel)).isFile(), rel);
});

test('SP-BPRUN-036: 写しの集合は bp-conformance・その隣の .tbd.json・CLI が読む CRITERIA_FILES を全て含み、ほかは bp-conformance が名指す文書と、集合の文書の隣の .tbd.json だけである', () => {
  const { files, problems } = closure(ROOT);
  assert.deepEqual(problems, []);
  const cli = Object.values(CRITERIA_FILES).map((parts) => parts.join('/'));
  for (const f of [CONFORMANCE, CONFORMANCE_TBD, ...cli]) assert.ok(files.includes(f), f);
  const text = [CONFORMANCE, CONFORMANCE_TBD].map((rel) => readFileSync(path.join(ROOT, 'docs', rel), 'utf8')).join('\n');
  for (const f of files.filter((x) => x !== CONFORMANCE && !cli.includes(x))) {
    if (f.endsWith('.tbd.json')) assert.ok(files.includes(f.replace(/\.tbd\.json$/, '.md')), f);
    else assert.ok(text.includes(`docs/${f}`) || text.includes(path.basename(f)), f);
  }
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

// 扱いを決めた最上位のディレクトリと根のファイルの列挙は SP-BPRUN-036 を正本にし、tool の数えた結果と criteriaNote を照らす。
function listedRepoPaths() {
  const run = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-run.md'), 'utf8');
  const rule = /写しの中の `docs\/` 以外のリポジトリやほかのスキルからの相対パス（([^。]*)。/.exec(run);
  assert.ok(rule, 'SP-BPRUN-036 に docs/ 以外のリポジトリの相対パスの扱いが無い');
  return [...rule[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

test('SP-BPRUN-036: 写しの中の docs/ 以外のリポジトリの相対パスと根のファイルの名指しは、全て SP-BPRUN-036 が列挙したものから始まる', () => {
  const listed = new Set(listedRepoPaths());
  const found = repoPaths(ROOT);
  assert.ok(found.some((r) => r.top.endsWith('/')) && found.some((r) => !r.top.endsWith('/')), 'ディレクトリのパスと根のファイルの両方を数えていない');
  assert.deepEqual([...new Set(found.map((r) => r.top))].filter((top) => !listed.has(top)), [], '扱いを決めていないパスが写しにある');
});

test('SP-BPRUN-036: docs/ 以外のパスの数え方は、./ と ../ で始まる相対の書き方の根のファイルとディレクトリも拾う', async (t) => {
  const root = await tmpRoot(t);
  await fs.writeFile(path.join(root, 'REVIEW.md'), 'x');
  await fs.mkdir(path.join(root, 'tools'));
  await fs.appendFile(path.join(root, COPY, 'specifications', 'bp-run.md'), '\n./REVIEW.md と [r](../../../REVIEW.md) と ./tools/x.mjs\n');
  const tops = repoPaths(root).filter((r) => r.file === 'specifications/bp-run.md').map((r) => `${r.top} ${r.token}`);
  for (const want of ['REVIEW.md ./REVIEW.md', 'REVIEW.md ../../../REVIEW.md', 'tools/ ./tools/x.mjs']) assert.ok(tops.includes(want), `${want}: ${tops.join(' / ')}`);
});

test('SP-BPRUN-036: 2 本の script の読み替えの文が、docs/ 以外のリポジトリの相対パスとして SP-BPRUN-036 と同じ列挙を挙げる', () => {
  for (const file of ['bp_author.js', 'bp_inspect.js']) {
    const source = readFileSync(path.join(ROOT, 'plugins', 'skill-creator', 'skills', 'skill-creator-best-practices', 'scripts', file), 'utf8');
    const m = /写しの中のそれ以外のリポジトリの相対パス（([^）]*)）/.exec(source);
    assert.ok(m, file);
    assert.deepEqual(m[1].split('・').sort(), listedRepoPaths().sort(), file);
  }
});
