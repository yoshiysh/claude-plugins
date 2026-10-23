import { readFileSync } from 'node:fs';
import path from 'node:path';

// エスケープした \| はセルの区切りでない。
export function cells(line) {
  return line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
}

// marker は表の見出しの行か、表の直前の文。表の途中に空行などが挟まると、残りの行が全ての検査から黙って消えるので、表の後に（見出しと区切りの行を持つ別の表でない）表の行が続けば落とす。
export function tableAfter(text, marker) {
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`表が無い: ${marker}`);
  const lines = text.slice(start).split('\n');
  const head = lines.findIndex((l) => l.startsWith('|'));
  if (head < 0) throw new Error(`表が無い: ${marker}`);
  const rows = [];
  let i = head + 2;
  for (; i < lines.length && lines[i].startsWith('|'); i += 1) rows.push(cells(lines[i]));
  for (; i < lines.length && !lines[i].startsWith('#'); i += 1) {
    if (!lines[i].startsWith('|')) continue;
    if (/^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) break;
    throw new Error(`表の途中に表の行でない行がある: ${marker}`);
  }
  return rows;
}

const TRACE_HEADER = '| 要求 ID | 仕様項目 ID | 検証方法 | ステータス |';

// トレーサビリティ表を読む唯一の関数。行の字面の正規表現で拾うと書式の崩れた行が黙って消えるので、表として読み、崩れれば投げる。
export function traceRows(file, specsDir) {
  return tableAfter(readFileSync(path.join(specsDir, file), 'utf8'), TRACE_HEADER).map(([req, spec, method, status, ...rest]) => (
    { file, req, spec, ids: (spec ?? '').split(',').map((x) => x.trim()), method, status, extra: rest.length }
  ));
}
