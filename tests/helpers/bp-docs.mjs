import { readFileSync } from 'node:fs';

const TITLE = /\btest\(\s*([`'"])((?:(?!\1).)*)\1/g;

export function testTitles(file) {
  return [...readFileSync(file, 'utf8').matchAll(TITLE)].map((m) => m[2]);
}

export function cells(line) {
  return line.split('|').slice(1, -1).map((c) => c.trim());
}

// 表の途中に空行などが挟まると、残りの行が全ての検査から黙って消えるので、表の後に表の行が続けば落とす。
export function tableAfter(text, header) {
  const lines = text.split('\n');
  const at = lines.indexOf(header);
  if (at < 0) throw new Error(`表が無い: ${header}`);
  const rows = [];
  let i = at + 2;
  for (; i < lines.length && lines[i].startsWith('|'); i += 1) rows.push(cells(lines[i]));
  for (; i < lines.length && !lines[i].startsWith('#'); i += 1) {
    if (lines[i].startsWith('|')) throw new Error(`表の途中に表の行でない行がある: ${header}（${i + 1} 行目の前）`);
  }
  return rows;
}
