import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allDecisionTables, authResumeTable, authStages, coverage, decisionTable, formalTable, gateNextTable, inspResumeTable, inspStages,
  resultOf, rowsFor, specText, stateMachine, stopCauses, stopUseRows, tableIn, tables, where, cliOps,
} from './extract.mjs';
import { SPEC_FILES } from './extract.mjs';
import { outsideFences } from '../../../../tools/lib/bp-docs.mjs';


const label = (t) => `${where(t.file, t.line)}`;

test('「条件:」の列を持つ全ての判定表で、どの入力の組にも当たる行がちょうど 1 つある', async (t) => {
  const all = allDecisionTables();
  // 「| 条件:」で始まる行の数と表の数を照らす（読めずに落ちた表を「問題なし」にしない）。
  const headers = SPEC_FILES.reduce((n, file) => n + outsideFences(specText(file)).filter((l) => l.startsWith('| 条件:')).length, 0);
  assert.equal(all.length, headers, `判定表を ${all.length} 個読んだが、「| 条件:」の見出しの行は ${headers} 個`);
  for (const table of all) {
    await t.test(label(table), () => {
      const c = coverage(table);
      assert.deepEqual(c.unknownCells, [], `宣言に無い値のセル: ${JSON.stringify(c.unknownCells)}`);
      assert.deepEqual(c.gaps, [], `当たる行が 0 個の組: ${JSON.stringify(c.gaps)}`);
      assert.deepEqual(c.overlaps, [], `当たる行が 2 個以上の組: ${JSON.stringify(c.overlaps)}`);
    });
  }
});

function machineCovers(file, heading, initial) {
  const m = stateMachine(file, heading);
  const seen = new Map();
  const add = (from, event, line) => {
    const key = `${from} ${event}`;
    seen.set(key, [...(seen.get(key) ?? []), line]);
  };
  for (const d of m.diagram) {
    if (d.from === '[*]') {
      assert.ok(initial.includes(d.event), `${where(file, d.line)}: 初期の遷移 ${d.event} が ${initial.join('・')} でない`);
      continue;
    }
    assert.ok(m.states.includes(d.from) && m.states.includes(d.to), `${where(file, d.line)}: 図の状態が対象の状態に無い`);
    add(d.from, d.event, d.line);
  }
  for (const r of m.rows) add(r.from, r.event, r.line);
  const missing = [];
  const twice = [];
  for (const s of m.states) for (const e of m.events) {
    const lines = seen.get(`${s} ${e.id}`) ?? [];
    if (lines.length === 0) missing.push(`${s} × ${e.id}`);
    if (lines.length > 1) twice.push(`${s} × ${e.id}: ${lines.map((l) => where(file, l)).join(', ')}`);
  }
  return { m, missing, twice };
}

test('run の状態 × イベントは、図と表を合わせて全ての組をちょうど 1 回定める', () => {
  const { missing, twice } = machineCovers('bp-run.md', '## 状態とイベント', ['E1']);
  assert.deepEqual(missing, []);
  assert.deepEqual(twice, []);
});

test('指摘の状態 × イベントは、図と表を合わせて全ての組をちょうど 1 回定める', () => {
  const { missing, twice } = machineCovers('bp-findings.md', '## 状態とイベント', ['E1', 'E2']);
  assert.deepEqual(missing, []);
  assert.deepEqual(twice, []);
});

function transitionGrid() {
  const [t] = tableIn('bp-findings.md', 'SP-BPFINDINGS-019', (x) => x.header[0] === '現在の状態');
  const judgements = t.header.slice(1);
  const grid = {};
  for (const r of t.rows) grid[r.cells[0]] = Object.fromEntries(judgements.map((j, k) => [j, r.cells[k + 1]]));
  return { t, judgements, grid };
}

test('指摘の状態遷移の表は 4 状態 × 3 判定を全て持ち、行き先は状態の集合の中にある', () => {
  const { judgements, grid } = transitionGrid();
  assert.deepEqual(judgements, ['存在する', '存在しない', '判定できない']);
  const states = Object.keys(grid);
  assert.deepEqual(states, ['open', 'dismissed', 'resolved', 'regressed']);
  for (const s of states) for (const j of judgements) assert.ok(states.includes(grid[s][j]), `${s} × ${j} → ${grid[s][j]}`);
});

test('状態 × イベント表の見直しの遷移（E3〜E6）は、状態遷移の表と同じ行き先を持つ', () => {
  const { grid } = transitionGrid();
  const m = stateMachine('bp-findings.md', '## 状態とイベント');
  const judgementOf = Object.fromEntries(m.events.map((e) => [e.id, /「(存在する|存在しない|判定できない)」/.exec(e.text)?.[1]]));
  // 重複の候補（E6）は、最後の判定と同じ値の見直しになる（SP-BPFINDINGS-018 の 5 行目）。
  // 最後の判定は、その状態へ入る遷移の判定から決まる（反証の維持は「存在する」、却下は「存在しない」と同じ側）。
  const lastOf = {};
  for (const [from, row] of Object.entries(grid)) for (const [j, to] of Object.entries(row)) {
    if (j === '判定できない' || from === to && j === '判定できない') continue;
    (lastOf[to] ??= new Set()).add(j);
  }
  for (const d of m.diagram) if (d.from === '[*]') (lastOf[d.to] ??= new Set()).add(d.event === 'E1' ? '存在する' : '存在しない');
  const all = [...m.diagram.filter((d) => d.from !== '[*]'), ...m.rows.filter((r) => r.defined.startsWith('✅'))];
  for (const x of all) {
    const j = judgementOf[x.event];
    if (j) assert.equal(x.to, grid[x.from][j], `${where('bp-findings.md', x.line)}: ${x.from} × ${x.event}`);
    if (x.event === 'E6') {
      const last = [...(lastOf[x.from] ?? [])].filter((v) => grid[x.from][v] === x.from);
      assert.ok(last.length > 0, `${where('bp-findings.md', x.line)}: ${x.from} の重複の候補の行き先が最後の判定の値と合わない`);
    }
  }
});

// SP-BPFINDINGS-018 の表は上の行から順に当てる表。条件は文で書かれているので、文ごとに述語を対応させる。
// 対応に無い文は投げる（文が変われば、ここで止まる）。
const R018 = {
  'R が空で、内容の指紋が変化': (x) => x.r === 0 && x.fp === 'changed',
  'R が空で、内容の指紋が不変': (x) => x.r === 0 && x.fp === 'same',
  'R に、反証で維持された同じ鍵の候補がある': (x) => x.r > 0 && x.c.has('upheld'),
  'R に、未反証の同じ鍵の候補がある': (x) => x.r > 0 && x.c.has('unrefuted'),
  'R に同じ鍵の候補が 1 件以上あり、その全てが重複である': (x) => x.r > 0 && x.c.size === 1 && x.c.has('dup'),
  'R に同じ鍵の候補が 1 件以上あり、その全てが反証で却下された': (x) => x.r > 0 && x.c.size === 1 && x.c.has('rejected'),
  'R に同じ鍵の候補が無く、R がその資産を「候補あり」か「確認済みで問題なし」と判定した': (x) => x.r > 0 && x.c.size === 0 && x.a === 'judged',
  'R に同じ鍵の候補が無く、R の全てがその資産を「判断できない」と判定した': (x) => x.r > 0 && x.c.size === 0 && x.a === 'unsure',
};
const IMPOSSIBLE018 = {
  'R が空なのに、同じ鍵の候補か、その資産の判定がある。': (x) => x.r === 0 && (x.c.size > 0 || x.a !== 'none'),
  'R があるのに、その資産の判定が無い。': (x) => x.r > 0 && x.a === 'none',
  '同じ鍵の候補に、重複と重複でないものが混ざる（1 つの段の中では資産の内容は全ての結果で同じで、重複は最後の判定と同じ内容の指紋の候補だけを指すので、全てが重複か、重複が 1 件も無いかのどちらかになる）。': (x) => x.c.has('dup') && x.c.size > 1,
  '全てが重複なのに、内容の指紋が変化している。': (x) => x.c.has('dup') && x.fp === 'changed',
  '同じ鍵の候補があるのに、R の全てがその資産を「判断できない」と判定した。': (x) => x.c.size > 0 && x.a === 'unsure',
};

test('見直しの判定の表は、起こりえない組を除く全ての組に当たる行を持つ', () => {
  const [t] = tableIn('bp-findings.md', 'SP-BPFINDINGS-018', (x) => x.header[0] === '順');
  const rows = t.rows.map((r) => {
    const p = R018[r.cells[1]];
    if (!p) throw new Error(`${where('bp-findings.md', r.line)}: 条件の文が対応に無い: ${r.cells[1]}`);
    return { p, line: r.line, result: r.cells[2] };
  });
  const text = specText('bp-findings.md').split('\n');
  const start = text.findIndex((l) => l.startsWith('次の組は起こりえない。'));
  const bullets = [];
  for (let i = start + 2; text[i]?.startsWith('- '); i += 1) bullets.push({ text: text[i].slice(2), line: i + 1 });
  assert.equal(bullets.length, Object.keys(IMPOSSIBLE018).length, '起こりえない組の数が対応と合わない');
  const impossible = bullets.map((b) => {
    const p = IMPOSSIBLE018[b.text];
    if (!p) throw new Error(`${where('bp-findings.md', b.line)}: 起こりえない組の文が対応に無い: ${b.text}`);
    return p;
  });
  const flags = ['upheld', 'unrefuted', 'dup', 'rejected'];
  const gaps = [];
  let possible = 0;
  for (const r of [0, 1]) for (const fp of ['changed', 'same']) for (const a of ['judged', 'unsure', 'none'])
    for (let mask = 0; mask < 16; mask += 1) {
      const x = { r, fp, a, c: new Set(flags.filter((_, k) => mask & (1 << k))) };
      if (impossible.some((p) => p(x))) continue;
      possible += 1;
      if (!rows.some((row) => row.p(x))) gaps.push({ ...x, c: [...x.c] });
    }
  assert.ok(possible > 0);
  assert.deepEqual(gaps, []);
});

test('形の判定の問いの答えの表は、図の道（最初の「はい」で止まる並び）とちょうど同じ並びを受ける', () => {
  const [t] = tableIn('bp-inspection.md', 'SP-BPINSPECTION-006', (x) => x.header.join('|') === 'A|Q1|Q2|Q3|到達した形');
  const NO = '問いに到達しない';
  const accepted = new Set(t.rows.map((r) => r.cells.slice(0, 4).join('|')));
  const paths = new Set([`いいえ|${NO}|${NO}|${NO}`]);
  for (let k = 0; k < 3; k += 1) {
    const qs = [...Array(k).fill('いいえ'), 'はい', ...Array(2 - k).fill(NO)];
    paths.add(['はい', ...qs].join('|'));
  }
  paths.add('はい|いいえ|いいえ|いいえ');
  assert.deepEqual([...accepted].sort(), [...paths].sort());
  const shapes = new Set(t.rows.map((r) => r.cells[4]));
  const [c003] = tableIn('bp-conformance.md', 'SP-BPCONFORMANCE-003', (x) => x.header.includes('条件: 形'));
  assert.deepEqual([...shapes].sort(), [...decisionTable(c003).domains.find((d) => d.name === '形').values].sort(),
    '到達する形の集合が、適用の判定表の「形」の値と合わない');
});

test('問い A・W の答えの並びで、答えてはならない並び（bp-conformance）と受理しない並び（bp-inspection）が一致する', () => {
  const [c] = tableIn('bp-conformance.md', 'SP-BPCONFORMANCE-004', (x) => x.header.includes('条件: 問い A の答え'));
  const [i] = tableIn('bp-inspection.md', 'SP-BPINSPECTION-006', (x) => x.header.includes('条件: A の答え'));
  const dc = decisionTable(c);
  const di = decisionTable(i);
  for (const a of dc.domains[0].values) for (const w of dc.domains[1].values) {
    const forbidden = /答えてはならない/.test(resultOf(dc, { '問い A の答え': a, '問い W の答え': w }));
    const refused = resultOf(di, { 'A の答え': a, 'W の答え': w }) === '受理しない';
    assert.equal(forbidden, refused, `A=${a}, W=${w}`);
  }
});

test('形式検証の判定表の cause は stop が受ける値だけを使い、通らない行は必ず cause を持つ', () => {
  const { values } = stopCauses();
  for (const r of formalTable().rows) if (!r.passes) assert.ok(values.includes(r.cause), `${where('bp-authoring.md', r.line)}: ${r.cause}`);
  const text = specText('bp-authoring.md');
  const s045 = text.slice(text.indexOf('#### SP-BPAUTHORING-045'), text.indexOf('### 停止'));
  for (const m of s045.matchAll(/`(verifiers|formal\w+)`/g)) assert.ok(values.includes(m[1]), m[1]);
});

test('合否の後の進み方の表の行き先は、gate の出力の next の値と同じ数だけある', () => {
  const nexts = new Set(gateNextTable().rows.map((r) => r.next));
  const gate = cliOps().find((o) => o.name === 'gate');
  const m = /進み方 `next`（((?:`\w+`・?)+)/.exec(gate.gives);
  assert.ok(m, `${where('bp-run.md', gate.line)}: gate の next の値が読めない`);
  const values = [...m[1].matchAll(/`(\w+)`/g)].map((x) => x[1]);
  assert.deepEqual([...nexts].sort(), [...values].sort());
});

test('create・update の再開の表は、止まりうる停止と段の全ての組に当たる行をちょうど 1 つ持つ', () => {
  const { rows, causes, allStages } = authResumeTable();
  const stages = authStages();
  const uses = stopUseRows().filter((u) => u.fn === 'create' && u.use === 'yes').map((u) => u.kind);
  // needs_input で止まってよい段（SP-BPAUTHORING-027）。
  const s027 = /needs_input で止まってよいのは、(.+?)の段（/.exec(specText('bp-authoring.md'));
  assert.ok(s027, 'SP-BPAUTHORING-027 の段が読めない');
  const needsInputStages = stages.filter((s) => s027[1].includes(s.name)).map((s) => s.id);
  // 検証役・反証役が結果を返せないことによる BLOCKED は、それらを起動する段と、「検証が成り立たない」を出す合否の段（SP-BPAUTHORING-005 のただし書き）。
  const verifierStages = [...new Set([...stages.filter((s) => /検証役|反証役/.test(s.role)).map((s) => s.id), 'gate'])];
  // 再開の始め方の出所にならない SP-BPRUN-045 の停止（cause が guideline）は組に入れない（SP-BPRUN-018）。
  const combos = [];
  for (const fn of ['create', 'update']) for (const kind of uses) {
    if (kind === 'done') { combos.push({ fn, kind, stage: null }); continue; }
    for (const stage of allStages.filter((s) => fn === 'update' || s !== 'snapshot')) {
      if (kind === 'needs_input') { if (needsInputStages.includes(stage)) combos.push({ fn, kind, stage }); continue; }
      if (kind === 'limit') {
        combos.push({ fn, kind, stage, limit: 'launch' });
        if (stage === 'gate') combos.push({ fn, kind, stage, limit: 'iteration' });
        continue;
      }
      for (const cause of causes) {
        if (cause.startsWith('formal') && stage !== 'formal') continue;
        if (cause === 'verifiers' && !verifierStages.includes(stage)) continue;
        combos.push({ fn, kind, stage, cause });
      }
    }
  }
  for (const fn of ['create', 'update']) for (const stage of allStages) combos.push({ fn, kind: 'nostop', stage });
  const bad = [];
  for (const x of combos) {
    const hits = rows.filter((r) => r.kind === x.kind
      && (x.kind !== 'limit' || r.limit === x.limit)
      && (x.kind !== 'blocked' || r.cause.includes(x.cause))
      && (x.kind === 'done' || r.fnStages[x.fn].includes(x.stage)));
    if (hits.length !== 1) bad.push({ ...x, lines: hits.map((h) => h.line) });
  }
  assert.deepEqual(bad, []);
});

test('review・audit の再開の表は、段の並びの全ての段をちょうど 1 回持つ', () => {
  const { rows, sequence } = inspResumeTable();
  const counted = sequence.map((s) => ({ s, n: rows.filter((r) => r.stages.includes(s)).length }));
  assert.deepEqual(counted.filter((c) => c.n !== 1), []);
  // 並びの外の段は、段の表（SP-BPINSPECTION-001）にある段だけを許す（最初の流れの消えた資産の照合の行）。
  const flowStages = inspStages().map((s) => s.id);
  const extra = rows.flatMap((r) => r.stages).filter((s) => !sequence.includes(s) && !flowStages.includes(s));
  assert.deepEqual(extra, []);
});

test('review・audit の再開の段の並びは、段の表から開始と消えた資産の照合を除き、追加の起動の部品を足したもの', () => {
  const { sequence } = inspResumeTable();
  const flow = inspStages().filter((s) => s.fns.includes('review')).map((s) => s.id);
  const expected = flow.filter((s) => s !== 'start' && s !== 'vanish');
  expected.splice(expected.indexOf('verify') + 1, 0, 'extra');
  assert.deepEqual(sequence, expected);
});

test('停止の種類の表で、review・audit は needs_input を使わず、反復の上限は起動数の上限のときだけ使う', () => {
  const use = stopUseRows();
  for (const fn of ['review', 'audit']) {
    assert.equal(use.find((u) => u.fn === fn && u.kind === 'needs_input').use, 'no');
    assert.equal(use.find((u) => u.fn === fn && u.kind === 'limit').use, 'launchOnly');
  }
  for (const fn of ['create', 'update']) for (const kind of ['done', 'needs_input', 'limit', 'blocked']) {
    assert.equal(use.find((u) => u.fn === fn && u.kind === kind).use, 'yes', `${fn} ${kind}`);
  }
});

// ---- 申し送り（最初の検査で欠けとして見つけ、仕様が直したもの）。 ----

test('照らした制限 checkedRoleLimits は、効かない制限ごとの指摘の種類の設定の名前を持つ', () => {
  const text = specText('bp-authoring.md');
  const m = /照らした結果を `checkedRoleLimits` に、照らした制限ごとに(.+?)の (\d+) 項目で返し/.exec(text);
  assert.ok(m, 'SP-BPAUTHORING-046 の checkedRoleLimits の項目が読めない');
  const kindsForm = /`<単位の値>\/<役の名前>\/<設定の名前>`/.test(specText('bp-findings.md'));
  assert.ok(kindsForm, 'SP-BPFINDINGS-010 の効かない制限ごとの種類の形が読めない');
  assert.match(m[1], /設定の名前/, `checkedRoleLimits の項目（${m[1]}）に設定の名前が無く、効かない制限ごとの候補と照らせない`);
});

test('指摘の種類の値の全ての形に、meaning の作り方がある', () => {
  const [t] = tableIn('bp-findings.md', 'SP-BPFINDINGS-010', (x) => x.header.join('|') === '観点|指摘の種類の値の形|`meaning`');
  const empty = t.rows.filter((r) => !(r.cells[2] ?? '').trim()).map((r) => where('bp-findings.md', r.line));
  assert.deepEqual(empty, []);
  // フローの観点・適合の観点の単位の形（設計方針文書の表の行・定義の箇条・本文の表の行・要求・効かない制限・仕様項目そのもの）が全て行を持つ。
  const flow = t.rows.filter((r) => r.cells[0] === 'フローの観点・適合の観点').map((r) => r.cells[1]);
  for (const form of ['/t<表の順>/r<行の順>', '/b<箇条の順>', '/<要求 ID>', '/<役の名前>/<設定の名前>', '仕様項目そのもの']) {
    assert.ok(flow.some((f) => f.includes(form)), form);
  }
  assert.ok(flow.filter((f) => f.includes('/t<表の順>/r<行の順>')).length >= 2, '設計方針文書の表の行と本文の表の行の 2 つ');
});

// ---- 表の読み出しの自己検査。表が見つからないことを「問題なし」にしない。 ----

test('TLC のモデルに渡す表の module を、仕様の markdown から作れる', async () => {
  const { specTables } = await import('./gen_tables.mjs');
  const tla = specTables();
  for (const name of ['RunAllowed', 'RunNever', 'RunEvents', 'AuthStageSeq', 'GateNext', 'FormalRows', 'StopCauses', 'AuthResume', 'InspStageSeqReview', 'InspStageSeqAudit', 'InspResume', 'InspResumeSeq', 'InspClosePlacement', 'StartChecks', 'StopUse']) {
    assert.match(tla, new RegExp(`^${name} == `, 'm'), name);
  }
  assert.doesNotMatch(tla, /[^\x00-\x7f]/, 'TLC に渡す module は ASCII だけで書く');
});

test('検査に使う表は全て見つかり、行を持つ', () => {
  assert.ok(authStages().length >= 10);
  assert.ok(gateNextTable().rows.length >= 4);
  assert.ok(formalTable().rows.length >= 4);
  assert.ok(authResumeTable().rows.length >= 10);
  assert.ok(inspStages().length >= 8);
  assert.ok(inspResumeTable().rows.length >= 6);
  for (const file of ['bp-run.md', 'bp-authoring.md', 'bp-inspection.md', 'bp-conformance.md', 'bp-findings.md']) assert.ok(tables(file).length > 0, file);
  assert.equal(typeof rowsFor, 'function');
});
