import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, NEXT_ARGS_KEYS, OPS, STAGES, VIEWPOINTS } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-run.md'), 'utf8');
const FINDINGS = readFileSync(path.join(ROOT, 'docs', 'specifications', 'bp-findings.md'), 'utf8');

function tableAfter(text, marker) {
  const start = text.indexOf(marker);
  assert.ok(start >= 0, marker);
  const lines = text.slice(start).split('\n');
  const first = lines.findIndex((l) => l.startsWith('|'));
  const rows = [];
  for (const line of lines.slice(first + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim()));
  }
  return rows;
}

test('SP-BPRUN-038: 仕様の段の slug の表と CLI の定数が一致する', () => {
  const rows = tableAfter(RUN, '段の slug は次の表とする。');
  const spec = new Map(rows.map(([name, slug]) => [slug.replace(/`/g, ''), name]));
  assert.deepEqual([...spec.keys()].sort(), Object.keys(STAGES).sort());
  for (const [slug, name] of Object.entries(STAGES)) assert.ok(spec.get(slug).split('・').includes(name), `${slug}: ${spec.get(slug)} / ${name}`);
});

test('SP-BPRUN-031: 仕様の符号の表と CLI の定数が一致する', () => {
  const rows = tableAfter(RUN, '| 符号 | 意味 | script の扱い |');
  const spec = rows.flatMap(([cell]) => cell.match(/E_[A-Z_]+/g));
  assert.deepEqual(spec.sort(), Object.values(CODES).sort());
});

test('SP-BPRUN-031: 仕様の操作の表と CLI の定数が一致する', () => {
  const rows = tableAfter(RUN, '| 操作 | 実現する項目 | 受け取るもの | 返すもの |');
  const spec = rows.map(([cell]) => cell.replace(/`/g, ''));
  assert.deepEqual(spec.sort(), Object.values(OPS).sort());
});

test('SP-BPRUN-033: 仕様の next_args の綴りと CLI の定数が一致する', () => {
  const m = /綴りは `(\{[^`]+\})` とする/.exec(RUN);
  assert.ok(m);
  const keys = [...m[1].matchAll(/"(\w+)":/g)].map((x) => x[1]);
  assert.deepEqual(keys.sort(), Object.values(NEXT_ARGS_KEYS).sort());
});

test('SP-BPFINDINGS-011: 仕様の観点の値と CLI の定数が一致する', () => {
  const m = /観点の値は (.+?)とする/.exec(FINDINGS);
  assert.ok(m);
  const values = [...m[1].matchAll(/`(\w+)`（([^）]+)）/g)].map((x) => [x[1], x[2]]);
  assert.deepEqual(Object.fromEntries(values), VIEWPOINTS);
});
