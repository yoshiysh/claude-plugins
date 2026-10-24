import { readFileSync } from 'node:fs';
import path from 'node:path';

export const TRACE_STATUS = Object.freeze({ notStarted: '未着手', inProgress: '作成中', done: '完了' });
export const TRACE_STATUSES = Object.freeze(Object.values(TRACE_STATUS));

const TRACE_HEADER = '| 要求 ID | 仕様項目 ID | 検証方法 | ステータス |';

// エスケープした \| はセルの区切りでない。
export function cells(line) {
  return line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
}

// フェンスの中の行は空行に置き換えて返す。行番号を保つため行を消さない。
export function outsideFences(markdown) {
  let fence;
  return markdown.split('\n').map((line) => {
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = undefined;
      return '';
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = open[1];
      return '';
    }
    return line;
  });
}

// marker は表の見出しの行か、表の直前の文。表の途中に空行などが挟まると、残りの行が全ての検査から黙って消えるので、表の後に（見出しと区切りの行を持つ別の表でない）表の行が続けば落とす。
function tableLines(text, marker) {
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`表が無い: ${marker}`);
  const offset = text.slice(0, start).split('\n').length;
  const lines = text.slice(start).split('\n');
  const head = lines.findIndex((l) => l.startsWith('|'));
  if (head < 0) throw new Error(`表が無い: ${marker}`);
  const rows = [];
  let i = head + 2;
  for (; i < lines.length && lines[i].startsWith('|'); i += 1) rows.push({ line: offset + i, cells: cells(lines[i]) });
  for (; i < lines.length && !lines[i].startsWith('#'); i += 1) {
    if (!lines[i].startsWith('|')) continue;
    if (/^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) break;
    throw new Error(`表の途中に表の行でない行がある: ${marker}`);
  }
  return rows;
}

export function tableAfter(text, marker) {
  return tableLines(text, marker).map((r) => r.cells);
}

const SPEC_PREFIX = 'SP-[A-Z][A-Z0-9]*';
const SPEC_ID = new RegExp(`^${SPEC_PREFIX}-\\d+$`);
const SPEC_HEADING = new RegExp(`^#{1,6}\\s+(${SPEC_PREFIX}-\\d+)\\b`);
const SPEC_RANGE = new RegExp(`(${SPEC_PREFIX})-(\\d+)(?:〜(?:(${SPEC_PREFIX})-)?(\\d+))?`, 'g');

export function specHeading(line) {
  return SPEC_HEADING.exec(line)?.[1] ?? null;
}

// トレーサビリティ表を読む唯一の関数。行の字面の正規表現で拾うと書式の崩れた行が黙って消えるので、表として読み、列の数・状態の語彙・仕様項目 ID の形が崩れれば投げる（崩れた ID を範囲外として捨てると、未完了の行が見えなくなる）。
export function traceTable(text) {
  return tableLines(outsideFences(text).join('\n'), TRACE_HEADER).map(({ line, cells: row }) => {
    const [req, spec, method, status] = row;
    const ids = (spec ?? '').split(',').map((x) => x.trim());
    if (row.length !== 4) throw new Error(`トレーサビリティ表の行が 4 列でない: ${line} 行目`);
    if (!TRACE_STATUSES.includes(status)) throw new Error(`トレーサビリティ表のステータスが語彙に無い: ${line} 行目: ${JSON.stringify(status)}`);
    const bad = ids.filter((id) => !SPEC_ID.test(id));
    if (bad.length) throw new Error(`トレーサビリティ表の仕様項目 ID の形が崩れている: ${line} 行目: ${bad.join(', ')}`);
    return { line, req, spec, ids, method, status };
  });
}

export function traceRows(file, specsDir) {
  try {
    return traceTable(readFileSync(path.join(specsDir, file), 'utf8')).map((row) => ({ file, ...row }));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`, { cause: error });
  }
}

// 「SP-X-027〜031」「SP-X-011〜SP-X-013」は範囲の全ての ID を名指す（端だけを拾うと間の ID が漏れる）。
export function specIds(text) {
  const ids = new Set();
  for (const m of text.matchAll(SPEC_RANGE)) {
    if (m[3] && m[3] !== m[1]) throw new Error(`範囲の両端の接頭辞が違う: ${m[0]}`);
    const first = Number(m[2]);
    const last = Number(m[4] ?? m[2]);
    if (last < first) throw new Error(`範囲の終わりが始まりより前: ${m[0]}`);
    for (let i = first; i <= last; i += 1) ids.add(`${m[1]}-${String(i).padStart(m[2].length, '0')}`);
  }
  return [...ids];
}
