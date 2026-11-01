import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cells, outsideFences, specHeading } from '../../../../tools/lib/bp-docs.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const SPEC_DIR = 'docs/specifications';
export const SPEC_FILES = ['bp-entry.md', 'bp-run.md', 'bp-authoring.md', 'bp-inspection.md', 'bp-conformance.md', 'bp-findings.md'];

const cache = new Map();

export function specText(file) {
  if (!cache.has(file)) cache.set(file, readFileSync(path.join(ROOT, SPEC_DIR, file), 'utf8'));
  return cache.get(file);
}

const SEPARATOR = /^\|[\s:|-]+\|$/;
const DECLARATION = /^> 条件の値: (.+?) = (.+)$/;

// 表ごとに、見出しと行番号つきの本体と、直前の段落の「条件の値」の宣言を返す。行番号は 1 から数える。
export function tables(file) {
  const lines = outsideFences(specText(file));
  const out = [];
  let item = null;
  let heading = null;
  let declarations = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^#{1,6} /.test(line)) {
      heading = line;
      item = specHeading(line) ?? (/^#{1,3} /.test(line) ? null : item);
      declarations = [];
      continue;
    }
    const decl = DECLARATION.exec(line);
    if (decl) {
      declarations.push({ line: i + 1, name: decl[1].trim(), values: decl[2].split(' / ').map((v) => v.trim()) });
      continue;
    }
    if (line.startsWith('|') && SEPARATOR.test(lines[i + 1] ?? '')) {
      const header = cells(line);
      const rows = [];
      let j = i + 2;
      for (; j < lines.length && lines[j].startsWith('|'); j += 1) rows.push({ line: j + 1, cells: cells(lines[j]) });
      out.push({ file, item, heading, line: i + 1, header, rows, declarations });
      declarations = [];
      i = j - 1;
    }
  }
  return out;
}

export function tableIn(file, item, predicate = () => true) {
  const found = tables(file).filter((t) => t.item === item && predicate(t));
  if (found.length === 0) throw new Error(`${file}: ${item} に表が無い`);
  return found;
}

export function where(file, line) {
  return `${SPEC_DIR}/${file}:${line}`;
}

// 「条件:」の列を持つ判定表。条件の列ごとに宣言の値の集合を対応させる。宣言に無い列名は投げる（読めない表を黙って飛ばさない）。
export function decisionTable(table) {
  const conditions = table.header.map((h, index) => ({ h, index })).filter(({ h }) => h.startsWith('条件:'));
  if (conditions.length === 0) return null;
  const domains = conditions.map(({ h, index }) => {
    const name = h.replace(/^条件:\s*/, '');
    const decl = table.declarations.find((d) => d.name === name);
    if (!decl) throw new Error(`${where(table.file, table.line)}: 条件「${name}」の値の宣言が無い`);
    return { name, index, values: decl.values, line: decl.line };
  });
  const result = table.header.findIndex((h) => h === '結果');
  return { domains, result, rows: table.rows };
}

function* product(domains, prefix = []) {
  if (prefix.length === domains.length) {
    yield prefix;
    return;
  }
  for (const value of domains[prefix.length].values) yield* product(domains, [...prefix, value]);
}

const OTHERWISE = '上記以外';

// 宣言に無い「上記以外」は、それより上の行のどれにも当たらない組に当たる行と読む（宣言にあれば、条件の値の 1 つとして扱う）。
function isFallback(dt, row) {
  return dt.domains.some((d) => row.cells[d.index] === OTHERWISE && !d.values.includes(OTHERWISE));
}

function cellHits(dt, row, d, value) {
  const cell = row.cells[d.index];
  return cell === '*' || cell === value || (cell === OTHERWISE && !d.values.includes(OTHERWISE));
}

// input は条件の名前から値への対応。当たる行の並びを返す。
export function rowsFor(dt, input) {
  const hit = (row) => dt.domains.every((d) => cellHits(dt, row, d, input[d.name]));
  const plain = dt.rows.filter((row) => !isFallback(dt, row) && hit(row));
  if (plain.length > 0) return plain;
  return dt.rows.filter((row) => isFallback(dt, row) && hit(row)).slice(0, 1);
}

export function resultOf(dt, input) {
  const rows = rowsFor(dt, input);
  if (rows.length !== 1) throw new Error(`当たる行が ${rows.length} 個: ${JSON.stringify(input)}`);
  return rows[0].cells[dt.result];
}

// 入力の組ごとに当たる行を数え、0 行と 2 行以上の組と、宣言に無い値を持つセルを返す。
export function coverage(table) {
  const dt = decisionTable(table);
  const unknownCells = [];
  for (const row of dt.rows) {
    for (const d of dt.domains) {
      const cell = row.cells[d.index];
      if (cell !== '*' && !d.values.includes(cell) && cell !== OTHERWISE) unknownCells.push({ line: row.line, condition: d.name, cell });
    }
  }
  const gaps = [];
  const overlaps = [];
  let inputs = 0;
  for (const values of product(dt.domains)) {
    inputs += 1;
    const input = Object.fromEntries(dt.domains.map((d, k) => [d.name, values[k]]));
    const hits = rowsFor(dt, input);
    if (hits.length === 0) gaps.push(input);
    if (hits.length > 1) {
      const results = new Set(hits.map((h) => h.cells.slice(dt.domains.length).join(' | ')));
      overlaps.push({ input, lines: hits.map((h) => h.line), conflicting: results.size > 1 });
    }
  }
  return { inputs, gaps, overlaps, unknownCells, dt };
}

export function allDecisionTables() {
  return SPEC_FILES.flatMap((file) => tables(file).filter((t) => t.header.some((h) => h.startsWith('条件:'))));
}

// 「> 対象の状態」「> 対象のイベント」と、mermaid の図の遷移と、状態 × イベント表を読む。
export function stateMachine(file, sectionHeading) {
  const raw = specText(file).split('\n');
  const start = raw.indexOf(sectionHeading);
  if (start < 0) throw new Error(`${file}: 見出しが無い: ${sectionHeading}`);
  let end = raw.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = raw.length;
  const body = raw.slice(start, end);
  const statesLine = body.find((l) => l.startsWith('> 対象の状態: '));
  const eventsLine = body.find((l) => l.startsWith('> 対象のイベント: '));
  const states = statesLine.replace('> 対象の状態: ', '').split(' / ').map((s) => s.trim());
  const events = eventsLine.replace('> 対象のイベント: ', '').split(' / ').map((s) => {
    const m = /^(E\d+)\s+(.*)$/.exec(s.trim());
    return { id: m[1], text: m[2] };
  });
  const diagram = [];
  body.forEach((l, k) => {
    const m = /^\s+(\S+) --> (\S+) : (E\d+) /.exec(l);
    if (m) diagram.push({ from: m[1], to: m[2], event: m[3], line: start + k + 1 });
  });
  const table = tables(file).find((t) => t.line > start && t.line <= end && t.header[0] === '現在の状態');
  const rows = table.rows.map((r) => ({ from: r.cells[0], event: r.cells[1], kind: r.cells[2], to: r.cells[3], defined: r.cells[4], line: r.line }));
  return { states, events, diagram, rows, tableLine: table.line };
}

// 名前の対応は表の中身でなく段・状態の名前だけを ASCII に写す。対応に無い名前は投げる（仕様に段が増えたら、モデルが黙って古くならないようにする）。
export const RUN_STATE_IDS = { '[*]': 'none', 実行中: 'running', needs_input停止: 'needs_input', 反復上限停止: 'limit', BLOCKED停止: 'blocked', 完了: 'done' };
export const AUTH_STAGE_IDS = {
  開始: 'start', 作り直す前の写し: 'snapshot', 目標の固定: 'goal', 書く: 'write',
  台帳: 'check', 検証: 'check', 追加の検証: 'check', 反証: 'check', 消えた資産の照合: 'check', 見直し: 'check',
  合否: 'gate', 形式検証: 'formal',
};
export const INSP_STAGE_IDS = {
  開始: 'start', 照らす先の決定: 'targets', 台帳の作成と資産の束: 'ledger', 担当の作成: 'assign', 適用の判定: 'applic',
  観点ごとの検証: 'verify', 'skip 一覧への追加の起動': 'extra', 反証: 'refute', 消えた資産の照合: 'vanish', 照合と停止: 'close',
};

function idOf(map, name, at) {
  if (!(name in map)) throw new Error(`${at}: 対応の無い名前: ${name}`);
  return map[name];
}

export function runMachine() {
  const m = stateMachine('bp-run.md', '## 状態とイベント');
  const at = (line) => where('bp-run.md', line);
  const allowed = [];
  const never = [];
  for (const d of m.diagram) allowed.push({ from: idOf(RUN_STATE_IDS, d.from, at(d.line)), event: d.event, to: idOf(RUN_STATE_IDS, d.to, at(d.line)), line: d.line });
  for (const r of m.rows) {
    const from = idOf(RUN_STATE_IDS, r.from, at(r.line));
    if (r.defined.startsWith('発生しない')) never.push({ from, event: r.event, line: r.line });
    else if (r.defined.startsWith('✅')) allowed.push({ from, event: r.event, to: idOf(RUN_STATE_IDS, r.to, at(r.line)), line: r.line });
    else throw new Error(`${at(r.line)}: 定義済みかの列が読めない: ${r.defined}`);
  }
  return { ...m, allowed, never };
}

export function authStages() {
  const [t] = tableIn('bp-authoring.md', 'SP-BPAUTHORING-005', (x) => x.header[0] === '段');
  return t.rows.map((r) => ({ name: r.cells[0], id: idOf(AUTH_STAGE_IDS, r.cells[0], where('bp-authoring.md', r.line)), items: r.cells[1], role: r.cells[2], line: r.line }));
}

function only(file, item, predicate) {
  const found = tableIn(file, item, predicate);
  if (found.length !== 1) throw new Error(`${file}: ${item} の表が ${found.length} 個`);
  return found[0];
}

export function gateNextTable() {
  const t = only('bp-authoring.md', 'SP-BPAUTHORING-025', (x) => x.header.includes('条件: 合否'));
  const DECISION = { 合格: 'pass', 不合格: 'fail', 検証が成り立たない: 'unverifiable' };
  const LIMIT = { 反復の上限より小さい: 'below', 反復の上限に達した: 'reached', '*': '*' };
  const REASON = { 範囲の外の不適合だけ: 'outOfScope', それ以外: 'other', '*': '*' };
  const col = (name) => t.header.indexOf(name);
  const [cd, cl, cr, cres] = [col('条件: 合否'), col('条件: 増分'), col('条件: 不合格の理由'), col('結果')];
  if (cd < 0 || cl < 0 || cres < 0) throw new Error(`${where('bp-authoring.md', t.line)}: 合否の後の進み方の表の列が読めない`);
  const next = (text, line) => {
    if (text.startsWith('形式検証の段へ進む')) return 'formal';
    if (text.startsWith('次の反復の書く段へ戻る')) return 'rewrite';
    if (text.startsWith('反復の上限で止まる')) return 'iterationLimit';
    if (/BLOCKED で止まる/.test(text)) return 'blocked';
    throw new Error(`${where('bp-authoring.md', line)}: 進み方が読めない: ${text}`);
  };
  return {
    table: t,
    rows: t.rows.map((r) => ({
      decision: idOf(DECISION, r.cells[cd], r.line), limit: idOf(LIMIT, r.cells[cl], r.line),
      reason: cr < 0 ? '*' : idOf(REASON, r.cells[cr], r.line), next: next(r.cells[cres], r.line), line: r.line,
    })),
  };
}

export function formalTable() {
  const t = only('bp-authoring.md', 'SP-BPAUTHORING-044', (x) => x.header.includes('条件: 読めたか'));
  const READ = { '`readable.ok` が true': true, '`readable.ok` が false': false };
  const HAS = { 有: true, 無: false, '*': '*' };
  return {
    table: t,
    rows: t.rows.map((r) => {
      const passes = r.cells[3].startsWith('通る');
      const cause = /`cause` は `(\w+)`/.exec(r.cells[3])?.[1] ?? null;
      if (!passes && !cause) throw new Error(`${where('bp-authoring.md', r.line)}: 通らない行に cause が無い`);
      return { readable: idOf(READ, r.cells[0], r.line), fails: idOf(HAS, r.cells[1], r.line), unrunnable: idOf(HAS, r.cells[2], r.line), passes, cause, line: r.line };
    }),
  };
}

export function stopUse() {
  const t = only('bp-run.md', 'SP-BPRUN-010', (x) => x.header.includes('条件: 停止'));
  return { table: t, dt: decisionTable(t) };
}

export function inspStages() {
  const t = only('bp-inspection.md', 'SP-BPINSPECTION-001', (x) => x.header[1] === '段');
  return t.rows.map((r) => {
    const fns = r.cells[4] === 'review だけ' ? ['review'] : r.cells[4] === 'review・audit' ? ['review', 'audit'] : null;
    if (!fns) throw new Error(`${where('bp-inspection.md', r.line)}: 機能の列が読めない: ${r.cells[4]}`);
    return { order: Number(r.cells[0]), name: r.cells[1], id: idOf(INSP_STAGE_IDS, r.cells[1], where('bp-inspection.md', r.line)), items: r.cells[5], fns, line: r.line };
  });
}


export function stopUseRows() {
  const { table, dt } = stopUse();
  const KIND = { 完了: 'done', 乾き: 'dry', needs_input: 'needs_input', 反復の上限: 'limit', BLOCKED: 'blocked' };
  const fnDomain = dt.domains.find((d) => d.name === '機能');
  const kindDomain = dt.domains.find((d) => d.name === '停止');
  const out = [];
  const valueOf = (fn, kind) => {
    const rows = rowsFor(dt, { 機能: fn, 停止: kind });
    if (rows.length !== 1) throw new Error(`${where('bp-run.md', table.line)}: ${fn}/${kind} に当たる行が ${rows.length} 個`);
    const text = rows[0].cells[dt.result];
    const same = /^(\w+) と同じ$/.exec(text);
    if (same) return valueOf(same[1], kind);
    if (text.startsWith('使わない')) return 'no';
    if (text.startsWith('起動数の上限で止まるときだけ使う')) return 'launchOnly';
    if (text.startsWith('使う')) return 'yes';
    throw new Error(`${where('bp-run.md', rows[0].line)}: 結果が読めない: ${text}`);
  };
  for (const fn of fnDomain.values) for (const kind of kindDomain.values) out.push({ fn, kind: idOf(KIND, kind, where('bp-run.md', table.line)), use: valueOf(fn, kind) });
  return out;
}

// 「SP-X-006〜010」「SP-X-018・019」のように接頭辞を省いた続きも、同じ接頭辞の ID として展開する。
export function expandIds(text) {
  const ids = new Set();
  const re = /(SP-[A-Z][A-Z0-9]*)-(\d+)((?:(?:〜|・)(?:SP-[A-Z][A-Z0-9]*-)?\d+)*)/g;
  for (const m of text.matchAll(re)) {
    const prefix = m[1];
    const width = m[2].length;
    let last = Number(m[2]);
    ids.add(`${prefix}-${m[2]}`);
    for (const part of m[3].matchAll(/(〜|・)(?:(SP-[A-Z][A-Z0-9]*)-)?(\d+)/g)) {
      if (part[2] && part[2] !== prefix) break;
      const n = Number(part[3]);
      if (part[1] === '〜') for (let i = last + 1; i <= n; i += 1) ids.add(`${prefix}-${String(i).padStart(width, '0')}`);
      else ids.add(`${prefix}-${String(n).padStart(width, '0')}`);
      last = n;
    }
  }
  return [...ids];
}

const TOKEN = /`([A-Za-z][\w.-]*)`/g;

// 括弧の中を除いた最上位の欄の名前。括弧の中は欄の形の説明で、受け取る欄そのものでない。
export function topLevelTokens(text) {
  let depth = 0;
  let top = '';
  for (const ch of text) {
    if (ch === '（' || ch === '(') depth += 1;
    else if (ch === '）' || ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) top += ch;
  }
  return [...new Set([...top.matchAll(TOKEN)].map((m) => m[1]))];
}

export function allTokens(text) {
  return [...new Set([...text.matchAll(TOKEN)].map((m) => m[1]))];
}

export function cliOps() {
  const t = only('bp-run.md', 'SP-BPRUN-031', (x) => x.header[0] === '操作');
  return t.rows.map((r) => {
    const name = /^`([\w-]+)`$/.exec(r.cells[0])?.[1];
    if (!name) throw new Error(`${where('bp-run.md', r.line)}: 操作の名前が読めない: ${r.cells[0]}`);
    return { name, realizes: expandIds(r.cells[1]), takes: r.cells[2], gives: r.cells[3], line: r.line };
  });
}

export function workflowInputs() {
  const t = only('bp-entry.md', 'SP-BPENTRY-013', (x) => x.header[1] === '綴り');
  return t.rows.map((r) => ({ name: /^`(\w+)`/.exec(r.cells[1])?.[1], line: r.line })).filter((x) => x.name);
}


// SP-BPRUN-003 の開始の操作の確かめの順（番号つきの箇条）。番号・符号・新規だけか再開だけかを返す。
export function startChecks() {
  const lines = specText('bp-run.md').split('\n');
  const head = lines.findIndex((l) => l.startsWith('#### SP-BPRUN-003 '));
  const out = [];
  for (let i = head + 1; i < lines.length && !lines[i].startsWith('#'); i += 1) {
    const m = /^(\d+)\. (.+?): (.*)$/.exec(lines[i]);
    if (!m) continue;
    const at = where('bp-run.md', i + 1);
    const scope = /再開だけ）/.test(m[2]) ? 'resume' : /新規だけ）/.test(m[2]) ? 'new' : 'both';
    const codes = [...m[3].matchAll(/`(E_[A-Z_]+|same: true)`/g)].map((x) => x[1]);
    // 符号を書かない確かめは、機能の文書の行が拒否を定める（8 の機能ごとの入力の確かめ）。
    const byFunction = codes.length === 0 && /SP-BPAUTHORING-029|SP-BPINSPECTION-026/.test(m[3]);
    if (codes.length === 0 && !byFunction) throw new Error(`${at}: 確かめの符号が読めない: ${m[3]}`);
    out.push({ n: Number(m[1]), scope, code: codes.find((c) => c.startsWith('E_')) ?? 'byFunction', same: codes.includes('same: true'), line: i + 1 });
  }
  if (out.length === 0 || out.some((c, k) => c.n !== k + 1)) throw new Error('bp-run.md: SP-BPRUN-003 の確かめの順が 1 から続く番号で読めない');
  return out;
}

// SP-BPAUTHORING-035 の入口の段の表（上の行から順に当てる）。状態の文と入口の文を、閉じた語の集合で分類する。
const ENTRY_CONDITIONS = [
  [/^前提に固定した目標が無い$/, 'noGoal'],
  [/^反復が無い$/, 'noIter'],
  [/^最後の反復に合否が無く、.*始めたが終えていない段の項目が 1 件以上あり、その全てが打ち切りである/, 'allAborted'],
  [/^最後の反復に合否が無い$/, 'noGate'],
  [/^最後の反復の合否が不合格で、合否の段の項目の結果の進み方 `next` が `blocked`/, 'gateFailBlocked'],
  [/^最後の反復の合否が不合格$/, 'gateFail'],
  [/^最後の反復の合否が検証が成り立たない$/, 'gateUnverifiable'],
  [/^最後の反復の合否が合格で、(次のどれかに当たる: )?照合で状態を変えた指摘がある/, 'passChanged'],
  [/^最後の反復の合否が合格で、形式検証の最後の回に未着手の項目がある$/, 'formalPending'],
  [/^最後の反復の合否が合格で、.*段を通ったと導ける$/, 'formalPassed'],
  [/^最後の反復の合否が合格で、.*`formalFailed` が導ける$/, 'formalFailed'],
  [/^最後の反復の合否が合格で、上記以外/, 'passOther'],
];
const ENTRY_TARGETS = [
  [/^目標の固定の段。最後の回に未着手の項目があればその回、無ければ/, 'goal'],
  [/^反復の番号 1 の書く段/, 'write1'],
  [/^新しい反復の台帳の段/, 'newIterLedger'],
  [/^最後の反復の最初の段/, 'continueIter'],
  [/^新しい反復の書く段/, 'newIterWrite'],
  [/^形式検証の段の同じ回/, 'formalSame'],
  [/^段を行わずに完了で止まる/, 'complete'],
  [/^形式検証の段の新しい回/, 'formalNew'],
];

export function authEntryTable() {
  const t = only('bp-authoring.md', 'SP-BPAUTHORING-035', (x) => x.header.join('|') === '順|状態|入口の段');
  const pick = (table, text, at, what) => {
    const hit = table.filter(([re]) => re.test(text));
    if (hit.length !== 1) throw new Error(`${at}: ${what}が読めない（当たる語が ${hit.length} 個）: ${text}`);
    return hit[0][1];
  };
  const rows = t.rows.map((r) => {
    const at = where('bp-authoring.md', r.line);
    return { order: Number(r.cells[0]), cond: pick(ENTRY_CONDITIONS, r.cells[1], at, '状態'), entry: pick(ENTRY_TARGETS, r.cells[2], at, '入口の段'), line: r.line };
  });
  if (rows.some((r, k) => r.order !== k + 1)) throw new Error('bp-authoring.md: SP-BPAUTHORING-035 の順が 1 から続かない');
  // 入口の段より前に消えた資産の照合の段を行う行（「表の N〜M の行に当たり、照合を終えていない取り直しの回があるとき」）。
  const lines = specText('bp-authoring.md').split('\n');
  const pre = lines.map((l) => /^- 表の (\d+)〜(\d+) の行に当たり、照合を終えていない取り直しの回があるとき/.exec(l)).find(Boolean);
  if (!pre) throw new Error('bp-authoring.md: SP-BPAUTHORING-035 の、入口の段より前に照合する行の範囲が読めない');
  const preVanish = rows.filter((r) => r.order >= Number(pre[1]) && r.order <= Number(pre[2])).map((r) => r.order);
  // 8 の行（passChanged）の「次のどれか」の条件を、閉じた語の集合で読む。
  const changedRow = t.rows.find((r) => /照合で状態を変えた指摘がある/.test(r.cells[1]));
  const SUBS = [[/^照合で状態を変えた指摘がある$/, 'changed'], [/判定が「判定できない」のもの/, 'unsure'], [/^対象スキルの指紋.*合否の後に内容が変わった/, 'contentChanged']];
  const subText = changedRow.cells[1].replace(/^最後の反復の合否が合格で、(次のどれかに当たる: )?/, '');
  const changedSubs = subText.split(' / ').map((x) => pick(SUBS, x.trim(), where('bp-authoring.md', changedRow.line), '8 の行の条件'));
  return { table: t, rows, preVanish, changedSubs };
}

// SP-BPRUN-005 の記録の表の、記録の種類ごとの同一性の鍵（括弧の中は条件つきの鍵として別に返す）。
const KEY_TERMS = { 段: 'stage', 回: 'round', run: 'run', 'run ID': 'run', '項目の ID': 'item', 番号: 'number', 連番: 'seq', 部分の番号: 'part' };
export function recordKeys() {
  const t = only('bp-run.md', 'SP-BPRUN-005', (x) => x.header.join('|') === '記録|同一性の鍵|足し方');
  return t.rows.map((r) => {
    const at = where('bp-run.md', r.line);
    const cell = r.cells[1];
    const optional = [...cell.matchAll(/（([^）]*)）/g)].flatMap((m) => (/部分の番号/.test(m[1]) ? ['part'] : []));
    const base = cell.replace(/（[^）]*）/g, '').split('・').map((x) => x.trim()).filter(Boolean);
    const fields = base.map((x) => KEY_TERMS[x] ?? null);
    return { record: r.cells[0], cell, fields, optional, mapped: fields.every((f) => f !== null), line: r.line, add: r.cells[2], at };
  });
}
