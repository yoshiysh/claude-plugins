import { readFileSync } from 'node:fs';

const TITLE = /\btest\(\s*([`'"])((?:(?!\1).)*)\1/g;

export function testTitles(file) {
  return [...readFileSync(file, 'utf8').matchAll(TITLE)].map((m) => m[2]);
}

export function cells(line) {
  return line.split('|').slice(1, -1).map((c) => c.trim());
}

// 見出しの行の次の区切りの行を飛ばし、表の終わり（| で始まらない行）までを返す。表が無ければ落とす（黙って 0 行と読まない）。
export function tableAfter(text, header) {
  const lines = text.split('\n');
  const at = lines.indexOf(header);
  if (at < 0) throw new Error(`表が無い: ${header}`);
  const rows = [];
  for (const l of lines.slice(at + 2)) {
    if (!l.startsWith('|')) break;
    rows.push(cells(l));
  }
  return rows;
}
