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
  const next = (text, line) => {
    if (text.startsWith('形式検証の段へ進む')) return 'formal';
    if (text.startsWith('次の反復の書く段へ戻る')) return 'rewrite';
    if (text.startsWith('反復の上限で止まる')) return 'iterationLimit';
    if (/BLOCKED で止まる/.test(text)) return 'blocked';
    throw new Error(`${where('bp-authoring.md', line)}: 進み方が読めない: ${text}`);
  };
  return { table: t, rows: t.rows.map((r) => ({ decision: idOf(DECISION, r.cells[0], r.line), limit: idOf(LIMIT, r.cells[1], r.line), next: next(r.cells[2], r.line), line: r.line })) };
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

// stop の操作が受ける cause の値（SP-BPRUN-031 の stop の行）。
export function stopCauses() {
  const t = only('bp-run.md', 'SP-BPRUN-031', (x) => x.header[0] === '操作');
  const row = t.rows.find((r) => r.cells[0] === '`stop`');
  const m = /BLOCKED だけ `cause`（(.*?)`cause` はこの (\d+) つの値だけを受ける/.exec(row.cells[2]);
  if (!m) throw new Error(`${where('bp-run.md', row.line)}: stop の cause の値が読めない`);
  const values = [...new Set([...m[1].matchAll(/`(\w+)`/g)].map((x) => x[1]))];
  if (values.length !== Number(m[2])) throw new Error(`${where('bp-run.md', row.line)}: cause の値の数が ${values.length} で、本文の ${m[2]} と合わない`);
  return { values, line: row.line };
}

export function authResumeTable() {
  const t = only('bp-authoring.md', 'SP-BPAUTHORING-035', (x) => x.header[1] === '止まった段' && x.header[2] === '始め方');
  const stages = authStages();
  const allStages = [...new Set(stages.map((s) => s.id))];
  const causes = ['none', ...stopCauses().values];
  const parsed = t.rows.map((r) => {
    const [stop, stageCell, how, pending] = r.cells;
    const at = where('bp-authoring.md', r.line);
    let kind;
    let limit = null;
    let cause = null;
    if (stop.startsWith('needs_input')) kind = 'needs_input';
    else if (stop === '反復の上限（反復の回数）') { kind = 'limit'; limit = 'iteration'; }
    else if (stop === '反復の上限（起動数の上限）') { kind = 'limit'; limit = 'launch'; }
    else if (stop.startsWith('停止の記録が無い')) kind = 'nostop';
    else if (stop === '完了') kind = 'done';
    else if (stop.startsWith('BLOCKED')) {
      kind = 'blocked';
      if (stop === 'BLOCKED') cause = 'any';
      else if (/`cause` なし/.test(stop)) cause = ['none'];
      else if (/それ以外/.test(stop)) cause = 'other';
      else {
        const named = [...stop.matchAll(/`(\w+)`/g)].map((x) => x[1]);
        if (named.length !== 1) throw new Error(`${at}: 停止の区分が読めない: ${stop}`);
        cause = named;
      }
    } else throw new Error(`${at}: 停止の種類が読めない: ${stop}`);
    // 段の名前の後の「（create）」「（update）」は、その段をその機能にだけ当てる印と読む。
    const fnStages = { create: [], update: [] };
    if (stageCell === '全て' || stageCell === 'SP-BPRUN-018 で決めた段') { fnStages.create = allStages; fnStages.update = allStages; }
    else if (stageCell !== '—') {
      for (const part of stageCell.split('・').map((x) => x.trim())) {
        const m = /^(.+?)（(create|update)）$/.exec(part);
        const id = idOf(AUTH_STAGE_IDS, m ? m[1] : part, at);
        for (const fn of m ? [m[2]] : ['create', 'update']) if (!fnStages[fn].includes(id)) fnStages[fn].push(id);
      }
    }
    const stageIds = [...new Set([...fnStages.create, ...fnStages.update])];
    let mode;
    let rewrite = 'none';
    if (/E_INPUT/.test(how)) mode = 'reject';
    else if (/形式検証の段の回を 1 増やして形式検証の段から/.test(how)) mode = 'formalNewRound';
    else if (/新しい反復の台帳の段から/.test(how)) mode = 'newIterLedger';
    else if (/同じ反復・同じ回の続き/.test(how) || /反復の上限（起動数の上限）の行と同じ/.test(how)) mode = 'continue';
    else if (/^回答を前提に書き/.test(how) && /目標の固定の回を 1 増やして始め直し/.test(how)) mode = 'goalRestart';
    else if (/^写しの段から/.test(how)) mode = 'fromSnapshot';
    else if (/^前提に目標があれば飛ばし/.test(how) || /^目標の固定の段から/.test(how)) mode = 'goalSkipOrRestart';
    else if (/^新しい反復の書く段から/.test(how)) {
      mode = 'newIterWrite';
      if (/成り立たなかった性質と理由/.test(how)) rewrite = 'formalFails';
      else if (/lastRewrite/.test(how)) rewrite = 'lastRewrite';
    } else throw new Error(`${at}: 始め方が読めない: ${how}`);
    const PENDING = { 破棄する: 'discard', 処理する: 'process', '処理する（追加の検証の段は破棄する）': 'process', '—': 'none' };
    return { kind, limit, cause, stages: stageIds, fnStages, mode, rewrite, pending: idOf(PENDING, pending, at), line: r.line, text: r.cells };
  });
  // 台帳〜見直しはモデルで 1 つの段 check に畳むので、行がそれらを全て持つか 1 つも持たないときだけ畳める。
  const grouped = Object.keys(AUTH_STAGE_IDS).filter((n) => AUTH_STAGE_IDS[n] === 'check');
  for (const row of parsed) {
    const named = row.text[1].split('・').map((x) => x.trim().replace(/（(create|update)）$/, ''));
    const hit = grouped.filter((n) => named.includes(n));
    if (hit.length > 0 && hit.length !== grouped.length) throw new Error(`${where('bp-authoring.md', row.line)}: 台帳〜見直しの段の一部だけを持つ行は、モデルの段 check に畳めない`);
  }
  // 「それ以外」は、同じ段を持つ BLOCKED の他の行が名指した区分を除いた残りとする。
  for (const row of parsed) {
    if (row.kind !== 'blocked') continue;
    if (row.cause === 'any') row.cause = causes;
    else if (row.cause === 'other') {
      const named = parsed.filter((o) => o !== row && o.kind === 'blocked' && Array.isArray(o.cause) && o.stages.some((s) => row.stages.includes(s))).flatMap((o) => o.cause);
      row.cause = causes.filter((c) => !named.includes(c));
    }
  }
  return { table: t, rows: parsed, causes, allStages };
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

export function inspResumeTable() {
  const t = only('bp-inspection.md', 'SP-BPINSPECTION-030', (x) => x.header[0] === '止まった段');
  const rows = t.rows.map((r) => {
    const at = where('bp-inspection.md', r.line);
    // 段の名前の後の括弧（「（review だけ）」「（段の表の 8 の、最初の流れの段）」）は段の説明で、名前に含めない。
    const stageIds = r.cells[0].replace(/（[^）]*）/g, '').split('・').map((s) => idOf(INSP_STAGE_IDS, s.trim(), at));
    let mode;
    if (/^担当の作成から/.test(r.cells[1])) mode = 'fromAssign';
    else if (/^この段を最初から（/.test(r.cells[1])) mode = 'redoClose';
    else if (/照合と停止から$/.test(r.cells[1])) mode = 'toClose';
    else if (/結果の無い項目だけ|結果が状態にあれば|担当の組が状態にあれば|止まった部分の結果の無い項目|結果の無い鍵だけ/.test(r.cells[1])) mode = 'sameStage';
    else throw new Error(`${at}: 始め方が読めない: ${r.cells[1]}`);
    // 照合と停止の段の始め直しで review が placement を送るか（表の文が名指すか）。
    const placement = mode === 'redoClose' && /review は `placement`/.test(r.cells[1]);
    return { stages: stageIds, mode, placement, line: r.line, text: r.cells[1] };
  });
  const prose = specText('bp-inspection.md').split('\n');
  const k = prose.findIndex((l) => l.startsWith('その後は、') && l.includes('段の並びは、'));
  const m = /段の並びは、(.*?)とする（消えた資産の照合は並びに入れない）/.exec(prose[k] ?? '');
  if (!m) throw new Error('bp-inspection.md: SP-BPINSPECTION-030 の段の並びの文が読めない');
  const sequence = m[1].split('・').map((s) => idOf(INSP_STAGE_IDS, s.trim(), where('bp-inspection.md', k + 1)));
  return { table: t, rows, sequence, sequenceLine: k + 1 };
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
