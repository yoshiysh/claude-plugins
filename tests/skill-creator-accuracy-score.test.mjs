import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { LINE_TOLERANCE, MAX_LOCATION_SPAN, MIN_QUOTE_CHARS, extractQuotes, extractRanges, normalizeFile, score, unwrapResult } from './fixtures/skill-creator-accuracy/score.mjs';

const fixtureDir = new URL('./fixtures/skill-creator-accuracy/', import.meta.url);
const truth = JSON.parse(await readFile(new URL('truth.json', fixtureDir), 'utf8'));
const targetDir = new URL(`target/${truth.skill}/`, fixtureDir);
const workflowSource = await readFile(new URL('../plugins/skill-creator/workflows/review_skill.js', import.meta.url), 'utf8');

function finderCategories() {
  const auditCategory = workflowSource.match(/const AUDIT_CATEGORY = '([^']+)'/)[1];
  const block = workflowSource.slice(workflowSource.indexOf('const FINDERS = ['), workflowSource.indexOf('const ACTIVE_FINDERS'));
  return [...block.matchAll(/^ {4}id: ('([^']+)'|AUDIT_CATEGORY),$/gm)].map((m) => m[2] || auditCategory);
}

function sites(entry) {
  return [{ file: entry.file, lines: entry.lines }, ...(entry.also || [])];
}

test('truth.json の defects / decoys は実在するファイルの範囲内の行を指す', async () => {
  for (const entry of [...truth.defects, ...truth.decoys]) {
    for (const site of sites(entry)) {
      const path = new URL(site.file, targetDir);
      assert.ok((await stat(path)).isFile(), `${entry.id}: ${site.file}`);
      const lineCount = (await readFile(path, 'utf8')).replace(/\n$/, '').split('\n').length;
      const [start, end] = site.lines;
      assert.ok(Number.isInteger(start) && Number.isInteger(end) && start >= 1 && start <= end && end <= lineCount,
        `${entry.id}: ${site.file} ${start}-${end} / ${lineCount} 行`);
    }
  }
});

test('truth.json は FINDERS の全観点に 2 件ずつ defects を持ち、id は重複しない', () => {
  const categories = finderCategories();
  assert.ok(categories.length > 0);
  for (const category of categories) {
    assert.equal(truth.defects.filter((d) => d.category === category).length, 2, category);
  }
  assert.deepEqual(truth.defects.filter((d) => !categories.includes(d.category)), []);
  assert.equal(truth.decoys.length, 6);
  const ids = [...truth.defects, ...truth.decoys].map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('同じファイルの正解範囲どうしは許容幅を足しても重ならない', () => {
  const byFile = new Map();
  for (const entry of [...truth.defects, ...truth.decoys]) {
    for (const site of sites(entry)) {
      if (!byFile.has(site.file)) byFile.set(site.file, []);
      byFile.get(site.file).push({ id: entry.id, lines: site.lines });
    }
  }
  for (const [file, list] of byFile) {
    list.sort((a, b) => a.lines[0] - b.lines[0]);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const next = list[i];
      assert.ok(prev.lines[1] + LINE_TOLERANCE < next.lines[0] - LINE_TOLERANCE,
        `${file}: ${prev.id} ${prev.lines} と ${next.id} ${next.lines}`);
    }
  }
});

test('location の行番号は明示的な書式だけを拾う', () => {
  assert.deepEqual(extractRanges('L12'), [[12, 12]]);
  assert.deepEqual(extractRanges('L12-18'), [[12, 18]]);
  assert.deepEqual(extractRanges('L12–L18'), [[12, 18]]);
  assert.deepEqual(extractRanges('12〜18行'), [[12, 18]]);
  assert.deepEqual(extractRanges('１２～１８行'), [[12, 18]]);
  assert.deepEqual(extractRanges('40行目'), [[40, 40]]);
  assert.deepEqual(extractRanges('line 7'), [[7, 7]]);
  assert.deepEqual(extractRanges('Lines 7-9'), [[7, 9]]);
  assert.deepEqual(extractRanges('SKILL.md:30-31'), [[30, 31]]);
  assert.deepEqual(extractRanges('L5 と L40'), [[5, 5], [40, 40]]);
  assert.deepEqual(extractRanges('§3 手順2 の 3件'), []);
  assert.deepEqual(extractRanges('## 出力'), []);
});

// 「N 行」は位置でなく数にも使う。数を行番号と取ると、無関係な行の仕込みや囮に当たる。
test('location の行数の表現（全N行・N 行以上）だけを除き、位置を表す N 行は拾う', () => {
  assert.deepEqual(extractRanges('全160行のうち'), []);
  assert.deepEqual(extractRanges('3 行以上の説明'), []);
  assert.deepEqual(extractRanges('2-3 行程度'), []);
  assert.deepEqual(extractRanges('SKILL.md 118 行'), [[118, 118]]);
  for (const count of ['全 160 行のうち', '約 3 行で書く', '3 行に分けて', '20 行超', '2 行ずつ', '- SKILL.md: 元 118 行 / pack 9-127']) {
    assert.deepEqual(extractRanges(count), [], count);
  }
  assert.deepEqual(extractRanges('42 行付近'), [[42, 42]]);
  assert.deepEqual(extractRanges('12-18行目'), [[12, 18]]);
  assert.deepEqual(extractRanges('全体の 40 行目'), [[40, 40]]);
});

test('file は ./ と snapshot の接頭辞と :行 の接尾辞を外して照合する', () => {
  assert.equal(normalizeFile('./references/a.md'), 'references/a.md');
  assert.equal(normalizeFile('/snap/tree/SKILL.md', '/snap/tree'), 'SKILL.md');
  assert.equal(normalizeFile('SKILL.md:12-14'), 'SKILL.md');
});

const SYNTH_TRUTH = {
  defects: [
    { id: 'A1', category: 'why-driven', file: 'SKILL.md', lines: [20, 21] },
    { id: 'A2', category: 'why-driven', file: 'references/r.md', lines: [10, 10] },
    { id: 'B1', category: 'prompt-audit', file: 'SKILL.md', lines: [50, 52], also: [{ file: 'references/r.md', lines: [40, 41] }] },
    { id: 'B2', category: 'prompt-audit', file: 'SKILL.md', lines: [80, 80] },
  ],
  decoys: [
    { id: 'D1', file: 'SKILL.md', lines: [100, 102] },
    { id: 'D2', file: 'references/r.md', lines: [70, 72] },
  ],
};

function finding(category, file, location) {
  return { category, file, location, claim: 'c', evidence: 'e', severity: 'major', suggested_fix: 'f' };
}

function reviewResult(confirmed, extra = {}) {
  return {
    mode: 'review',
    source_snapshot: { snapshot_dir: '/snap/tree' },
    findings: { confirmed, rejected: [], unverified: extra.unverified || [], reported_minor: extra.reported_minor || [] },
    declared_only: { before: extra.declared || [], after: null },
  };
}

test('±許容の内側は当たり、外側・別ファイルは仕込み外、行番号の無い指摘は位置不明に数える', () => {
  const edge = 20 - LINE_TOLERANCE;
  const report = score(SYNTH_TRUTH, reviewResult([
    finding('why-driven', './SKILL.md', `L${edge}`),
    finding('loopholes', 'references/r.md', `${10 + LINE_TOLERANCE}行目`),
    finding('why-driven', 'SKILL.md', `L${80 + LINE_TOLERANCE + 1}`),
    finding('why-driven', 'references/other.md', 'L50'),
    finding('prompt-audit', 'SKILL.md', '## 出力'),
    finding('loopholes', '/snap/tree/SKILL.md', 'line 101'),
  ]));
  assert.deepEqual(report.defects.filter((d) => d.detected).map((d) => d.id), ['A1', 'A2']);
  assert.deepEqual({ hit: report.detection.hit, total: report.detection.total }, { hit: 2, total: 4 });
  assert.deepEqual(report.detection.by_category['why-driven'], { hit: 2, total: 2, rate: 1 });
  assert.deepEqual(report.detection.by_category['prompt-audit'], { hit: 0, total: 2, rate: 0 });
  assert.equal(report.category_matched.hit, 1);
  assert.deepEqual({ hit: report.false_positive.hit, total: report.false_positive.total }, { hit: 1, total: 2 });
  assert.deepEqual(report.confirmed, {
    total: 6, on_defect: 2, on_out_of_scope_defect: 0, on_decoy: 1, outside: 2, unlocated: 1,
    matched_by: { location: 3, evidence: 0, both: 0 },
  });
  assert.equal(report.evidence_lookup, false);
});

test('also の範囲も同じ仕込みとして当たり、unverified・reported_minor・declared_only は参考列にだけ入る', () => {
  const report = score(SYNTH_TRUTH, reviewResult(
    [finding('prompt-audit', 'references/r.md', 'L40-41')],
    {
      unverified: [finding('why-driven', 'SKILL.md', 'L20')],
      reported_minor: [finding('why-driven', 'SKILL.md', 'L80'), finding('why-driven', 'SKILL.md', 'L101')],
      declared: [{ file: 'SKILL.md', location: '', claim: 'c' }],
    },
  ));
  assert.equal(report.detection.hit, 1);
  assert.equal(report.category_matched.hit, 1);
  assert.deepEqual(report.reference.unverified, { findings: 1, defects_hit: 1, decoys_hit: 0, unlocated: 0 });
  assert.deepEqual(report.reference.reported_minor, { findings: 2, defects_hit: 1, decoys_hit: 1, unlocated: 0 });
  assert.deepEqual(report.reference.declared_only_before, { findings: 1, defects_hit: 0, decoys_hit: 0, unlocated: 1 });
  assert.equal(report.false_positive.hit, 0);
});

test('--category は defects の分母だけを絞り、分母外の仕込みに当たった指摘は仕込み外に数えない', () => {
  const report = score(SYNTH_TRUTH, { ...reviewResult([
    finding('prompt-audit', 'SKILL.md', 'L51'),
    finding('prompt-audit', 'SKILL.md', 'L21'),
    finding('prompt-audit', 'references/r.md', 'L71'),
  ]), mode: 'audit' }, { category: 'prompt-audit' });
  assert.equal(report.category_filter, 'prompt-audit');
  assert.deepEqual({ hit: report.detection.hit, total: report.detection.total }, { hit: 1, total: 2 });
  assert.deepEqual(Object.keys(report.detection.by_category), ['prompt-audit']);
  assert.equal(report.false_positive.total, 2);
  assert.equal(report.false_positive.hit, 1);
  assert.equal(report.confirmed.on_defect, 2);
  assert.equal(report.confirmed.on_out_of_scope_defect, 1);
  assert.equal(report.confirmed.outside, 0);
});

test('location が挙げる別ファイルの行は、そのファイルの範囲として照合する', () => {
  const report = score(SYNTH_TRUTH, reviewResult([
    finding('duplicate-claims', 'SKILL.md', 'L50-52 と references/r.md L70'),
    finding('duplicate-claims', 'references/r.md', 'SKILL.md:101 / r.md L10'),
  ]));
  assert.deepEqual(report.defects.filter((d) => d.detected).map((d) => d.id), ['A2', 'B1']);
  assert.deepEqual(report.decoys.filter((d) => d.hit).map((d) => d.id), ['D1', 'D2']);
  const cross = score(SYNTH_TRUTH, reviewResult([finding('duplicate-claims', 'SKILL.md', 'L51 と references/r.md L100')]));
  assert.equal(cross.false_positive.hit, 0);
  assert.equal(cross.detection.hit, 1);
  const ownFile = score(SYNTH_TRUTH, reviewResult([finding('loopholes', 'SKILL.md', 'L40')]));
  assert.equal(ownFile.confirmed.outside, 1);
});

const SYNTH_SOURCES = {
  'SKILL.md': Array.from({ length: 110 }, (_, i) => {
    if (i + 1 === 20) return '- 複数の記録は連結して';
    if (i + 1 === 21) return '  1 つの記録として扱う。';
    if (i + 1 === 23) return '連結しない場合の扱いは書かない。';
    if (i + 1 === 80) return '担当者欄に「未定」と書く。';
    if (i + 1 === 101) return '囮の本文はここにある。';
    return `filler ${i + 1}`;
  }).join('\n'),
  'references/r.md': Array.from({ length: 80 }, (_, i) => {
    if (i + 1 === 10) return '話者不明の発言は除外する。';
    if (i + 1 === 40) return '担当者が空の項目は出力しない。';
    return `filler ${i + 1}`;
  }).join('\n'),
};

test('evidence の引用は入れ子の鉤括弧を外側で取り、短すぎる引用は数えない', () => {
  assert.deepEqual(extractQuotes('「各議題を「その他」に統合する」と `x.md`').map((q) => q.text), ['各議題を「その他」に統合する', 'x.md']);
  const short = 'あ'.repeat(MIN_QUOTE_CHARS - 1);
  const report = score(SYNTH_TRUTH, reviewResult([
    { ...finding('why-driven', 'SKILL.md', '## 本文'), evidence: `「${short}」` },
  ]), { sources: { 'SKILL.md': `${short}\n`.repeat(30) } });
  assert.equal(report.confirmed.unlocated, 1);
});

test('節名だけの location は evidence の引用を本文から探して行へ直し、経路を列に残す', () => {
  const report = score(SYNTH_TRUTH, reviewResult([
    { ...finding('why-driven', 'SKILL.md', '## 入力の確認'), evidence: '「複数の記録は 連結して　1 つの記録として扱う。」（理由が無い）' },
    { ...finding('prompt-audit', 'SKILL.md', '「担当者」節 / SKILL.md 6'), evidence: 'r.md: 「担当者が空の項目は出力しない。」 / SKILL.md: 「担当者欄に「未定」と書く。」' },
    { ...finding('why-driven', 'references/r.md', 'L10'), evidence: '「話者不明の発言は除外する。」' },
    { ...finding('loopholes', 'SKILL.md', '注意事項'), evidence: '本文に無い言い換えだけの説明' },
    { ...finding('loopholes', 'SKILL.md', '## 区分'), evidence: '「連結しない場合の扱いは書かない。」' },
    { ...finding('loopholes', 'SKILL.md', '## 囮'), evidence: '「…囮の本文はここにある。」' },
  ]), { sources: SYNTH_SOURCES });
  assert.equal(report.evidence_lookup, true);
  assert.deepEqual(report.findings.map((f) => [f.bucket, f.route, [...f.defects, ...f.decoys]]), [
    ['defect', 'evidence', ['A1']],
    ['defect', 'evidence', ['B1', 'B2']],
    ['defect', 'both', ['A2']],
    ['unlocated', null, []],
    ['outside', null, []],
    ['decoy', 'evidence', ['D1']],
  ]);
  assert.deepEqual(report.confirmed.matched_by, { location: 0, evidence: 3, both: 1 });
});

test('evidence が挙げたファイルに引用が無ければ finding の file で探す', () => {
  const report = score(SYNTH_TRUTH, reviewResult([
    { ...finding('prompt-audit', 'SKILL.md', '6.'), evidence: 'r.md: 「担当者欄に「未定」と書く。」' },
  ]), { sources: SYNTH_SOURCES });
  assert.deepEqual(report.findings[0].defects, ['B2']);
});

test('Workflow の保存形式（result の入れ子・文字列化）を剥がして mode を持つ object を得る', () => {
  const inner = reviewResult([]);
  assert.equal(unwrapResult({ result: inner }).mode, 'review');
  assert.equal(unwrapResult({ result: JSON.stringify(inner) }).mode, 'review');
  assert.equal(unwrapResult(JSON.stringify({ result: JSON.stringify(inner) })).mode, 'review');
  assert.throws(() => unwrapResult({ result: { nothing: true } }));
});

test('CLI は --json で機械可読な採点を返す', async () => {
  const resultJson = JSON.stringify({ result: JSON.stringify(reviewResult([
    finding('why-driven', truth.defects[0].file, `L${truth.defects[0].lines[0]}`),
  ])) });
  const dir = await mkdtemp(join(tmpdir(), 'accuracy-score-'));
  try {
    const resultPath = join(dir, 'result.json');
    await writeFile(resultPath, resultJson);
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('score.mjs', fixtureDir)), fileURLToPath(new URL('truth.json', fixtureDir)), resultPath, '--json',
    ]);
    const report = JSON.parse(stdout);
    assert.equal(report.detection.hit, 1);
    assert.equal(report.detection.total, truth.defects.length);
    assert.equal(report.false_positive.total, truth.decoys.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('location の行範囲が MAX_LOCATION_SPAN を超えたら位置不明に数える', () => {
  const report = score(SYNTH_TRUTH, reviewResult([
    finding('why-driven', 'SKILL.md', 'L1-L160'),
    finding('why-driven', 'SKILL.md', `L20-L${20 + MAX_LOCATION_SPAN - 1}`),
  ]));
  assert.deepEqual(report.findings.map((f) => f.bucket), ['unlocated', 'defect']);
  assert.equal(report.false_positive.hit, 0);
});

test('evidence の断片が対象ファイルに 2 回以上出るときは当たりにしない', () => {
  const sources = {
    'SKILL.md': SYNTH_SOURCES['SKILL.md'].split('\n').map((line, i) => (i + 1 === 21 || i + 1 === 101 ? 'run the script here' : line)).join('\n'),
  };
  const report = score(SYNTH_TRUTH, reviewResult([
    { ...finding('why-driven', 'SKILL.md', '## 本文'), evidence: '「run the script here」' },
    { ...finding('why-driven', 'SKILL.md', '## 本文'), evidence: '「担当者欄に「未定」と書く。」' },
  ]), { sources });
  assert.deepEqual(report.findings.map((f) => [f.bucket, [...f.defects, ...f.decoys]]), [['unlocated', []], ['defect', ['B2']]]);
});
