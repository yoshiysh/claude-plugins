#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cpSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRITERIA_DIR } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { flowUnits } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/kinds.mjs';
import { applicability, forcedReason, forcedSources } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/units.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CRITERIA = path.join(REPO_ROOT, 'plugins', 'skill-creator', 'skills', 'skill-creator-best-practices', CRITERIA_DIR);
export const FIXTURE_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'bp-trial', 'review-target');
export const EXPECTED_FILE = path.join(REPO_ROOT, 'tests', 'fixtures', 'bp-trial', 'review-target.expected.json');
export const MEASURES = Object.freeze({ injection: 'injection', forced: 'forced', whole: 'whole', none: 'none' });
const EXIT = Object.freeze({ ok: 0, usage: 2 });

export function belongs(unit, sp) {
  return unit === sp || unit.startsWith(`${sp}/`);
}

// 仕込む単位は人が選ばず、種と仕様項目から決める（選ばなかった単位は確かめていないと宣言する）。
export function pick(seed, sp, candidates) {
  if (candidates.length === 0) throw new Error(`仕込める単位が無い: ${sp}`);
  const n = Number.parseInt(createHash('sha256').update(`${seed}\0${sp}`).digest('hex').slice(0, 8), 16);
  return candidates[n % candidates.length];
}

// 除く単位と強いられた未検査は指摘にならないので、そこに仕込むと外れとしか読めない。
export function injectable(criteriaDir, row, sp) {
  const r = applicability(criteriaDir).find((x) => x.row === row);
  const flow = new Set(flowUnits(criteriaDir).map((u) => u.value));
  return r.units.map((u) => u.value).filter((v) => belongs(v, sp) && flow.has(v) && !r.forced.includes(v));
}

export function forcedBy(criteriaDir, row, sp) {
  const r = applicability(criteriaDir).find((x) => x.row === row);
  const sources = forcedSources(criteriaDir);
  return r.forced.filter((u) => forcedReason(sources, u) === sp);
}

// 未検査の観点の理由は強いられた未検査の出所の仕様項目 ID（SP-BPINSPECTION-025）なので、読み取りは理由まで照らす。
export function forcedReasons(criteriaDir, row) {
  const r = applicability(criteriaDir).find((x) => x.row === row);
  const sources = forcedSources(criteriaDir);
  return r.forced.map((unit) => ({ unit, reason: forcedReason(sources, unit) }));
}

export function inject(expected, outDir, fixtureDir = FIXTURE_DIR) {
  cpSync(fixtureDir, outDir, { recursive: true });
  for (const i of expected.injections) {
    const file = path.join(outDir, i.file);
    const text = readFileSync(file, 'utf8');
    const at = text.indexOf(i.from);
    if (at < 0 || text.indexOf(i.from, at + 1) >= 0) throw new Error(`置き換え元がちょうど 1 回現れない: ${i.file} ${JSON.stringify(i.from)}`);
    writeFileSync(file, text.slice(0, at) + i.to + text.slice(at + i.from.length));
  }
}

function describe(f) {
  return `${f.id ?? ''} ${f.viewpoint} ${f.kind} ${f.assets.map((a) => `${a.path}${a.loc?.k === 'sec' ? `#${a.loc.h.map((x) => x[1]).join('/')}` : ''}`).join(',')}`.trim();
}

function open(result) {
  return (result.findings ?? []).filter((f) => f.state !== 'dismissed');
}

function sameAsset(asset, i) {
  if (asset.path !== i.file) return false;
  if (i.section === null) return asset.loc?.k === 'file';
  return asset.loc?.k === 'sec' && JSON.stringify(asset.loc.h.map((x) => x[1])) === JSON.stringify(i.section);
}

function matches(f, i) {
  return f.viewpoint === i.viewpoint && f.kind === i.unit && f.assets.some((a) => sameAsset(a, i));
}

// 読みが崩れる条件と行ごとの規則は bp-conformance の「検証方法」を正とする。
export function read({ baseline, injected, expected }) {
  const findings = open(injected);
  const shape = [
    ...(Array.isArray(baseline.findings) ? [] : ['基準の run の返り値に findings が無い']),
    ...(Array.isArray(injected.findings) ? [] : ['仕込んだ版の返り値に findings が無い']),
    ...(Array.isArray(injected.uncheckedViewpoints) ? [] : ['仕込んだ版の返り値に uncheckedViewpoints が無い']),
  ];
  const hits = expected.injections.map((i) => findings.some((f) => matches(f, i)));
  const falsePositives = findings.filter((f) => !expected.injections.some((i) => matches(f, i)));
  const interference = falsePositives.filter((f) => expected.injections.some((i) => f.viewpoint === i.viewpoint && f.assets.some((a) => sameAsset(a, i))));
  const unchecked = new Set((injected.uncheckedViewpoints ?? []).map((u) => `${u.viewpoint}|${u.scope}|${u.value}|${u.reason}`));
  const reasonOf = new Map(expected.forced.map((f) => [f.unit, f.reason]));
  const reachedRow = injected.applicability?.row ?? null;
  const baselineRow = baseline.applicability?.row ?? null;
  const baselineFindings = open(baseline).length;
  const broken = [
    ...shape,
    ...(baseline.stopKind === 'complete' ? [] : [`基準の run が完了していない（${baseline.stopKind ?? '停止の種類が無い'}）`]),
    ...(baselineFindings === 0 ? [] : [`基準の run に open の指摘が ${baselineFindings} 件ある`]),
    ...(baselineRow === expected.row ? [] : [`基準の run が判定表の ${expected.row} 行目に着かない（${baselineRow}）`]),
    ...(injected.stopKind === 'complete' ? [] : [`仕込んだ版の run が完了していない（${injected.stopKind ?? '停止の種類が無い'}）`]),
    ...(reachedRow === expected.row ? [] : [`仕込んだ版の run が判定表の ${expected.row} 行目に着かない（${reachedRow}）`]),
    ...(interference.length === 0 ? [] : [`干渉 ${interference.length} 件`]),
  ];
  const forcedSeen = (units) => units.every((u) => unchecked.has(`flow|unit|${u}|${reasonOf.get(u)}`));
  const forcedUnits = expected.forced.map((f) => f.unit);
  const whole = falsePositives.length === 0 && hits.every(Boolean) && forcedSeen(forcedUnits);
  const rows = expected.rows.map((row) => {
    const sps = Object.keys(row.measures);
    const parts = Object.entries(row.measures).map(([sp, m]) => {
      if (m.by === MEASURES.none) return { sp, ok: null, note: m.reason };
      if (m.by === MEASURES.forced) return { sp, ok: forcedSeen(m.units), note: '強いられた未検査' };
      if (m.by === MEASURES.whole) return { sp, ok: whole, note: '全ての仕込みの指摘・強いられた未検査・偽陽性 0' };
      const own = expected.injections.map((i, n) => [i, hits[n]]).filter(([i]) => belongs(i.unit, sp));
      return { sp, ok: own.length > 0 && own.every(([, h]) => h), note: own.map(([i, h]) => `${i.unit}:${h ? '当たり' : '外れ'}`).join(' ') };
    });
    const ownForced = forcedUnits.filter((u) => sps.some((sp) => belongs(u, sp)));
    if (ownForced.length) parts.push({ sp: '強いられた未検査', ok: forcedSeen(ownForced), note: ownForced.join(' ') });
    const ownFalse = falsePositives.filter((f) => sps.some((sp) => belongs(f.kind, sp)));
    const unmeasured = row.unmeasured ?? [];
    const status = broken.length || unmeasured.length || ownFalse.length || parts.some((p) => p.ok === null) || !parts.every((p) => p.ok) ? '作成中' : '完了';
    return { req: row.req, spec: row.spec, parts, unmeasured, falsePositives: ownFalse.map(describe), status };
  });
  const unseen = expected.injections.filter((i) => i.unseen?.length).map((i) => ({ sp: i.unit.split('/')[0], picked: i.unit, units: i.unseen }));
  return { baselineFindings, reachedRow, broken, valid: broken.length === 0, hits: hits.filter(Boolean).length, injections: hits.length, falsePositives: falsePositives.map(describe), interference: interference.length, rows, unseen };
}

export function render(r) {
  const lines = [
    `基準の run の open の指摘: ${r.baselineFindings}`,
    `到達した判定表の行: ${r.reachedRow}`,
    `仕込んだ違反の当たり: ${r.hits}/${r.injections}`,
    `偽陽性: ${r.falsePositives.length}（うち干渉 ${r.interference}）`,
    `読みが成り立つ: ${r.valid ? 'はい' : `いいえ（全ての行を作成中のままにする。${r.broken.join('、')}）`}`,
    '',
    '| 要求 ID | 仕様項目 ID | 句ごとの読み | 判定 |',
    '|---|---|---|---|',
    ...r.rows.map((x) => `| ${x.req} | ${x.spec} | ${[
      ...x.parts.map((p) => `${p.sp}: ${p.ok === null ? `測らない（${p.note}）` : `${p.ok ? '当たり' : '外れ'}（${p.note}）`}`),
      ...x.unmeasured.map((u) => `試走で測らない句: ${u.clause}（${u.reason}）`),
      ...x.falsePositives.map((f) => `この行の仕様項目の偽陽性: ${f}`),
    ].join('<br>')} | ${x.status} |`),
    '',
    '確かめていない単位（原則の表の単位から種で 1 つだけ仕込み、残りは仕込んでいない）:',
    ...r.unseen.map((u) => `- ${u.sp}（仕込んだ単位 ${u.picked}）: ${u.units.join(' ')}`),
    ...r.falsePositives.map((f) => `偽陽性: ${f}`),
  ];
  return lines.join('\n');
}

function json(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function main(argv) {
  const expected = json(EXPECTED_FILE);
  if (argv[0] === 'inject' && argv.length === 2) {
    inject(expected, path.resolve(argv[1]));
    return { exitCode: EXIT.ok, text: `仕込んだ版を ${path.resolve(argv[1])} に書いた（${expected.injections.length} 件）` };
  }
  const b = argv.indexOf('--baseline');
  const i = argv.indexOf('--injected');
  if (argv[0] === 'read' && b > 0 && i > 0 && argv[b + 1] && argv[i + 1]) {
    return { exitCode: EXIT.ok, text: render(read({ baseline: json(argv[b + 1]), injected: json(argv[i + 1]), expected })) };
  }
  return { exitCode: EXIT.usage, text: '使い方: node tools/read-bp-trial.mjs inject <出力先> | read --baseline <基準の review の返り値.json> --injected <仕込んだ版の review の返り値.json>' };
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const { exitCode, text } = main(process.argv.slice(2));
  process.stdout.write(`${text}\n`);
  process.exitCode = exitCode;
}
