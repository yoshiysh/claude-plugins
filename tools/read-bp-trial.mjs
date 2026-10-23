#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRITERIA_DIR } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs';
import { flowUnits } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/kinds.mjs';
import { applicability, forcedReason, forcedSources } from '../plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/units.mjs';
import { RECORDS_DIR, RUNS_FILE, TRIAL_DIR, fingerprint, readRuns, sameFingerprint } from './bp-trial.mjs';

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
  applyInjections(expected.injections, outDir);
}

// 単独の仕込みの run は、全ての仕込みと同じ正解表から仕様項目で選ぶ（置き換えの文字列を 2 箇所に書かない）。
export function injectUnits(dir, sps, expected = json(EXPECTED_FILE)) {
  const chosen = sps === null ? expected.injections : expected.injections.filter((i) => sps.some((sp) => belongs(i.unit, sp)));
  if (sps !== null && sps.some((sp) => !chosen.some((i) => belongs(i.unit, sp)))) throw new Error(`正解表に仕込みが無い仕様項目がある: ${sps.join(', ')}`);
  applyInjections(chosen, dir);
}

function applyInjections(injections, outDir) {
  for (const i of injections) {
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
  const hitList = expected.injections.map((i, n) => ({ unit: i.unit, viewpoint: i.viewpoint, hit: hits[n] }));
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
  return { baselineFindings, reachedRow, broken, valid: broken.length === 0, hitList, hits: hits.filter(Boolean).length, injections: hits.length, falsePositives: falsePositives.map(describe), interference: interference.length, rows, unseen };
}

// ---- 試走の記録から、行ごとに当たり・外れ・測れない句・崩れを読む（「完了」にしてよい行の集合はここからだけ計算する）

const SPECS = path.join(REPO_ROOT, 'docs', 'specifications');
const TRACE_HEADING = '## トレーサビリティ表';

// 同じ要求 ID と仕様項目 ID の行が 1 つの表に 2 つあるので、検証方法の列の文言まで含めて行を見分ける。
export function rowKey(r) {
  return `${r.file}|${r.req}|${r.spec}|${r.method}`;
}

export function traceRows(file, specsDir = SPECS) {
  const lines = readFileSync(path.join(specsDir, file), 'utf8').split('\n');
  const at = lines.indexOf(TRACE_HEADING);
  if (at < 0) throw new Error(`${file} にトレーサビリティ表が無い`);
  const rows = [];
  for (const line of lines.slice(at + 1).filter((l) => l.startsWith('| PR-'))) {
    const [req, spec, method, status] = line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
    rows.push({ file, req, spec, method, status });
  }
  return rows;
}

function at(obj, p) {
  return p.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

function sectionOf(asset) {
  return asset.loc?.k === 'sec' ? asset.loc.h.map((x) => x[1]) : null;
}

function findingMatches(f, m) {
  const state = m.state ?? 'open';
  if (state !== 'any' && f.state !== state) return false;
  if (m.viewpoint !== undefined && f.viewpoint !== m.viewpoint) return false;
  if (m.kind !== undefined && f.kind !== m.kind) return false;
  if (m.kindPrefix !== undefined && !String(f.kind).startsWith(m.kindPrefix)) return false;
  if (m.path === undefined && m.section === undefined) return true;
  return f.assets.some((a) => (m.path === undefined || a.path === m.path) && (m.section === undefined || JSON.stringify(sectionOf(a)) === JSON.stringify(m.section)));
}

function uncheckedMatches(u, m) {
  return (m.viewpoint === undefined || u.viewpoint === m.viewpoint) && (m.scope === undefined || u.scope === m.scope)
    && (m.value === undefined || u.value === m.value) && (m.valuePrefix === undefined || String(u.value).startsWith(m.valuePrefix))
    && (m.reason === undefined || u.reason === m.reason) && (m.reasonIncludes === undefined || String(u.reason).includes(m.reasonIncludes));
}

function inRange(n, { min, max }) {
  const lo = min ?? (max === undefined ? 1 : 0);
  return n >= lo && (max === undefined || n <= max);
}

function hasKeys(v, keys) {
  return v !== null && typeof v === 'object' && keys.every((k) => Object.hasOwn(v, k));
}

function nonEmpty(v) {
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return v !== null && typeof v === 'object' && Object.keys(v).length > 0;
}

const FIELD_TESTS = Object.freeze({
  nonEmpty: (v) => nonEmpty(v),
  equals: (v, x) => JSON.stringify(v) === JSON.stringify(x),
  matches: (v, x) => v !== undefined && new RegExp(x).test(typeof v === 'string' ? v : JSON.stringify(v)),
  keys: (v, x) => hasKeys(v, x),
  every: (v, x) => Array.isArray(v) && v.every((e) => hasKeys(e, x)),
  some: (v, x) => Array.isArray(v) && v.some((e) => hasKeys(e, x)),
  someMatches: (v, x) => Array.isArray(v) && v.some((e) => new RegExp(x).test(JSON.stringify(e))),
});

// 句の読みの種類の閉集合。正解表に知らない種類があれば、読まずに落とす（黙って外れにすると、正解表の誤りが行の作成中に隠れる）。
export const CHECKS = Object.freeze({
  stop: (c, r) => r.stopKind === c.kind,
  row: (c, r) => r.applicability?.row === c.row,
  findings: (c, r) => Array.isArray(r.findings) && inRange(r.findings.filter((f) => findingMatches(f, c.match ?? {})).length, c),
  onlyFindings: (c, r) => {
    const open = (r.findings ?? []).filter((f) => f.state === 'open');
    return open.length > 0 && open.every((f) => findingMatches(f, { ...c.match, state: 'open' }));
  },
  unchecked: (c, r) => Array.isArray(r.uncheckedViewpoints) && inRange(r.uncheckedViewpoints.filter((u) => uncheckedMatches(u, c.match ?? {})).length, c),
  units: (c, r) => {
    const units = (r.verification?.units ?? []).filter((u) => (c.match.unit === undefined || u.unit === c.match.unit) && (c.match.unitPrefix === undefined || u.unit.startsWith(c.match.unitPrefix)));
    return units.length >= (c.min ?? 1) && units.every((u) => c.results.includes(u.result));
  },
  field: (c, r) => {
    const test = FIELD_TESTS[c.test];
    if (!test) throw new Error(`field の test を知らない: ${c.test}`);
    return test(at(r, c.path), c.value);
  },
  written: (c, r) => (r.writtenFiles ?? []).filter((f) => f.action === c.action).length >= (c.min ?? 1),
  coverage: (c, r) => {
    const cov = r.ledger?.coverage ?? r.verification?.ledger?.coverage ?? [];
    return cov.length > 0 && cov.every((x) => x.seen === x.total);
  },
  contract: (c, r) => {
    const list = r.verification?.contract ?? [];
    if (c.elements) return c.elements.every((e) => list.some((x) => x.element === e));
    return list.filter((x) => String(x.choice).startsWith(c.choicePrefix)).length >= (c.min ?? 1);
  },
  injections: (c, r, ctx) => {
    if (!ctx.injected?.valid) return false;
    const own = ctx.injected.hitList.filter((h) => (c.viewpoint === undefined || h.viewpoint === c.viewpoint) && (c.sp === undefined || belongs(h.unit, c.sp)));
    return own.length > 0 && own.every((h) => h.hit);
  },
});

export function evaluate(check, result, ctx = {}) {
  const fn = CHECKS[check.by];
  if (!fn) throw new Error(`句の読みの種類を知らない: ${check.by}`);
  return fn(check, result, ctx);
}

function loadRecords(dir) {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => [n.slice(0, -'.json'.length), json(path.join(dir, n))]));
}

function recordProblems(name, rec, current, def) {
  if (!rec) return [`${name} の記録が無い`];
  if (rec.function !== def.function) return [`${name} の記録の機能 ${rec.function} が ${def.function} と違う`];
  if (!sameFingerprint(rec.fingerprint, current)) return [`${name} の記録の指紋が今の script・CLI・prompt-audit・判定基準の写しと違う（走らせ直すまで完了にしない）`];
  return [];
}

// 行ごとの判定。記録が無い・古い・崩れた run の行と、測れない句を持つ行は作成中にする。同じ行を 2 つの run が測るときは、どちらかの完了で足りる。
export function readRecords({ recordsDir = RECORDS_DIR, runs = readRuns(RUNS_FILE), current = fingerprint(), specsDir = SPECS, trialDir = TRIAL_DIR } = {}) {
  const records = loadRecords(recordsDir);
  const out = [];
  for (const [name, def] of Object.entries(runs)) {
    const rec = records[name] ?? null;
    const problems = recordProblems(name, rec, current, def);
    let injected = null;
    if (def.baseline) {
      const base = records[def.baseline] ?? null;
      problems.push(...recordProblems(def.baseline, base, current, runs[def.baseline]));
      if (rec && base) injected = read({ baseline: base.result, injected: rec.result, expected: json(path.join(trialDir, def.expected[0])) });
    }
    for (const file of def.expected) {
      const exp = json(path.join(trialDir, file));
      if (exp.injections) {
        const methods = new Map(traceRows('bp-conformance.md', specsDir).map((t) => [`${t.req}|${t.spec}`, t.method]));
        for (const row of exp.rows) {
          const r = injected?.rows.find((x) => x.req === row.req && x.spec === row.spec);
          const status = problems.length === 0 && r ? r.status : '作成中';
          const notes = problems.length ? problems : r ? [...(injected.valid ? [] : injected.broken), ...r.parts.map((p) => `${p.sp}: ${p.ok === null ? '測らない' : p.ok ? '当たり' : '外れ'}`)] : ['読めない'];
          out.push({ file: 'bp-conformance.md', req: row.req, spec: row.spec, method: methods.get(`${row.req}|${row.spec}`) ?? null, run: name, status, notes });
        }
        continue;
      }
      for (const row of exp.rows) {
        const parts = problems.length ? [] : row.checks.map((c) => ({ clause: c.clause, by: c.by, ok: evaluate(c, rec.result, { injected }) }));
        const unmeasured = row.unmeasured ?? [];
        const ok = problems.length === 0 && parts.every((p) => p.ok) && unmeasured.length === 0;
        out.push({ file: row.file, req: row.req, spec: row.spec, method: row.method, run: name, status: ok ? '完了' : '作成中', parts, unmeasured, notes: problems });
      }
    }
  }
  return out;
}

export function confirmedKeys(rows) {
  return new Set(rows.filter((r) => r.status === '完了').map(rowKey));
}

export function renderRecords(rows) {
  return [
    '| 仕様書 | 要求 ID | 仕様項目 ID | 検証方法 | run | 句ごとの読み | 判定 |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.file} | ${r.req} | ${r.spec} | ${r.method} | ${r.run} | ${[
      ...(r.parts ?? []).map((p) => `${p.clause}（${p.by}）: ${p.ok ? '当たり' : '外れ'}`),
      ...(r.unmeasured ?? []).map((u) => `試走で測らない句: ${u.clause}（${u.reason}）`),
      ...r.notes,
    ].join('<br>')} | ${r.status} |`),
  ].join('\n');
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
  const rd = argv.indexOf('--records');
  if (argv[0] === 'read' && rd > 0) {
    return { exitCode: EXIT.ok, text: renderRecords(readRecords({ recordsDir: path.resolve(argv[rd + 1] ?? RECORDS_DIR) })) };
  }
  const b = argv.indexOf('--baseline');
  const i = argv.indexOf('--injected');
  if (argv[0] === 'read' && b > 0 && i > 0 && argv[b + 1] && argv[i + 1]) {
    return { exitCode: EXIT.ok, text: render(read({ baseline: json(argv[b + 1]), injected: json(argv[i + 1]), expected })) };
  }
  return { exitCode: EXIT.usage, text: '使い方: node tools/read-bp-trial.mjs inject <出力先> | read --baseline <基準の review の返り値.json> --injected <仕込んだ版の review の返り値.json> | read --records [<記録のディレクトリ>]' };
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const { exitCode, text } = main(process.argv.slice(2));
  process.stdout.write(`${text}\n`);
  process.exitCode = exitCode;
}
