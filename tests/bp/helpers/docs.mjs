import { readFileSync } from 'node:fs';

const TITLE = /\btest\(\s*([`'"])((?:(?!\1).)*)\1/g;

export function testTitles(file) {
  return [...readFileSync(file, 'utf8').matchAll(TITLE)].map((m) => m[2]);
}

export { cells, tableAfter } from '../../../tools/lib/bp-docs.mjs';
