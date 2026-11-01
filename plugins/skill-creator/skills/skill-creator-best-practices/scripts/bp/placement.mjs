import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CODES, CONFORMANCE_SP, FINDING_STATES, FUNCTION, OPS, RECORDS, REVIEW_VALUES, REWRITING_FUNCTIONS, STAGE, UNIT_RESULTS, VIEWPOINT,
} from './constants.mjs';
import { assetTexts, scanMarkdown } from './assets.mjs';
import { needPosInt } from './checks.mjs';
import { internal, reject } from './errors.mjs';
import { targetFiles } from './fingerprint.mjs';
import { findingId, fingerprintSet, keyString } from './ids.mjs';
import { strip } from './records.mjs';
import { mutate } from './store.mjs';
import { currentAssets } from './view.mjs';

const HEADER = '| 判断点 | 硬い層へ置けない理由 |';
const SEPARATOR = /^[|\-:\s]+$/;
// 指摘の候補の直し方の文言（SP-BPINSPECTION-007 の表の「直し方」の行）。
export const PLACEMENT_FIX = '判断点の表を SP-BPCONFORMANCE-041 の判定表の適合の行に当たる形（見出し行 1 つ・区切り行・2 つの空でないセルを持つデータ行）に直す';

function cells(line) {
  const body = line.replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return body.split(/(?<!\\)\|/).map((c) => c.trim());
}

function linesOf(text) {
  return text.split('\n').map((l) => l.replace(/\r$/, '').trim());
}

// SP-BPCONFORMANCE-041 の判定表。ranges は {path, lines（行の文字列）, from（範囲の最初の行番号）, fenced（範囲の行の添字の集合）}。
export function judgePlacement(ranges) {
  const headers = [];
  for (const r of ranges) r.lines.forEach((l, i) => { if (l === HEADER && !r.fenced.has(i)) headers.push({ r, i }); });
  const at = (r, i) => ({ path: r.path, line: r.from + i });
  const fmt = (lines) => lines.map((l) => `${l.path}:${l.line}`).join(', ');
  if (headers.length === 0) return { result: UNIT_RESULTS.nonconform, lines: [], reason: '判断点の表の見出し行が無い（判断点の列挙も判断点が無いことの記述も無い）' };
  if (headers.length > 1) {
    const lines = headers.map((h) => at(h.r, h.i));
    return { result: UNIT_RESULTS.nonconform, lines, reason: `判断点の表の見出し行が 2 つ以上ある: ${fmt(lines)}` };
  }
  const { r, i } = headers[0];
  const sep = r.lines[i + 1];
  if (sep === undefined || !SEPARATOR.test(sep) || cells(sep).length !== 2) {
    const lines = [at(r, i)];
    return { result: UNIT_RESULTS.nonconform, lines, reason: `判断点の表の見出し行の次に区切り行が無い: ${fmt(lines)}` };
  }
  const bad = [];
  for (let k = i + 2; k < r.lines.length && r.lines[k].startsWith('|'); k += 1) {
    const c = cells(r.lines[k]);
    if (c.length !== 2 || c.some((x) => x === '')) bad.push(at(r, k));
  }
  if (bad.length) return { result: UNIT_RESULTS.nonconform, lines: bad, reason: `判断点の表にセルが 2 つでないか空のセルを持つデータ行がある: ${fmt(bad)}` };
  return { result: UNIT_RESULTS.conform, lines: [], reason: '判断点の表が 1 つあり、全てのデータ行がセルを 2 つ持ち、どちらも空でない' };
}

function rangeOf(relPath, text, start = 1, end = null) {
  const all = text.split('\n');
  const fencedAll = /\.(md|markdown)$/.test(relPath) ? scanMarkdown(all.map((l) => l.replace(/\r$/, ''))).fenced : new Set();
  const last = end ?? all.length;
  const fenced = new Set([...fencedAll].filter((i) => i >= start - 1 && i < last).map((i) => i - (start - 1)));
  return { path: relPath, lines: linesOf(all.slice(start - 1, last).join('\n')), from: start, fenced };
}

// create・update は反復の番号が iteration 以下で書く段の結果を持つ最後の反復の designNote を読む（検証役が結果を返せない BLOCKED からの反復は書く段を持たない）。
export function lastWriteNote(view, iteration) {
  const items = [...view.items.values()].filter((i) => i.stage === STAGE.write && i.result !== undefined && (i.round ?? 0) <= iteration);
  return items.sort((a, b) => (a.round ?? 0) - (b.round ?? 0) || a.result.seq - b.result.seq).at(-1)?.result.result.designNote ?? null;
}

async function authorRanges(view, iteration) {
  const note = lastWriteNote(view, iteration);
  if (!note) reject(CODES.input, `反復 ${iteration} 以下に書く段の結果を持つ反復が無いので placement を当てられない`);
  const text = await fs.readFile(path.join(view.paths.at(-1).root, note.path), 'utf8').catch(() => null);
  if (text === null) return { unreadable: [note.path] };
  return { ranges: [rangeOf(note.path, text, note.startLine, note.endLine)] };
}

async function reviewRanges(view) {
  const { entries } = await targetFiles(view.paths.at(-1));
  const ranges = [];
  const unreadable = [];
  for (const { file, key } of entries) {
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text === null) unreadable.push(key);
    else ranges.push(rangeOf(key, text));
  }
  return { ranges, unreadable, entries };
}

async function assetsByLine(view, entries) {
  const live = new Map(currentAssets(view).map((a) => [a.id, a]));
  const out = [];
  for (const { file, key } of entries) {
    const bytes = await fs.readFile(file).catch(() => null);
    if (bytes === null) continue;
    for (const a of assetTexts(key, bytes)) {
      if (!live.has(a.id)) continue;
      const n = a.text.replace(/\n$/, '').split('\n').length;
      out.push({ ...a, lastLine: a.firstLine + n - 1 });
    }
  }
  return out;
}

// 見出し行が 0 のときの置き場（SP-BPINSPECTION-007）：SKILL.md の frontmatter・最初の見出しより前・最初の節の順、無ければ資産 ID の昇順の最初。
function fallbackAsset(view, located) {
  const skill = located.filter((a) => a.path === 'SKILL.md');
  const pick = skill.find((a) => a.loc?.k === 'fm') ?? skill.find((a) => a.loc?.k === 'pre') ?? skill[0];
  if (pick) return pick;
  const first = currentAssets(view).map((a) => a.id).sort()[0];
  if (!first) internal('台帳の今の資産が無い');
  return { id: first, text: '', firstLine: 1, lastLine: 0 };
}

async function reviewFindings(view, run, placed, entries) {
  const located = await assetsByLine(view, entries);
  const groups = new Map();
  if (placed.lines.length === 0) groups.set(fallbackAsset(view, located).id, { asset: fallbackAsset(view, located), lines: [] });
  for (const l of placed.lines) {
    const a = located.find((x) => x.path === l.path && x.firstLine <= l.line && l.line <= x.lastLine);
    if (!a) continue;
    if (!groups.has(a.id)) groups.set(a.id, { asset: a, lines: [] });
    groups.get(a.id).lines.push(l.line);
  }
  const records = [];
  const ids = [];
  for (const { asset, lines } of groups.values()) {
    const key = { asset: asset.id, viewpoint: VIEWPOINT.flow, kind: CONFORMANCE_SP.placement };
    const known = [...view.findings.values()].find((f) => f.keys.includes(keyString(key)));
    if (known) { ids.push(known.id); continue; }
    const id = findingId(view.ledger.id, key);
    const rows = asset.text.split('\n');
    const quote = lines.map((n) => `L${n}: ${rows[n - asset.firstLine] ?? ''}`).join('\n');
    const fps = { [asset.id]: view.assets.get(asset.id).digest };
    records.push(
      { t: RECORDS.finding, id, key, run, texts: { quote, content: placed.reason, fix: PLACEMENT_FIX } },
      { t: RECORDS.fstate, finding: id, run, round: `${OPS.placement}:${run}`, state: FINDING_STATES.open, value: REVIEW_VALUES.exists, basis: OPS.placement, fps, fpset: fingerprintSet(fps) },
    );
    ids.push(id);
  }
  return { records, ids };
}

// SP-BPRUN-031 の placement：判断点の表の照合を CLI が決定的に行い、agent の結果を使わない。
export function placement(ctx, req) {
  return mutate(ctx, req, OPS.placement, async (view) => {
    const fn = view.state.function;
    const rewriting = REWRITING_FUNCTIONS.has(fn);
    if (!rewriting && fn !== FUNCTION.review) reject(CODES.input, `placement は create・update・review の操作: ${fn}`);
    if (rewriting) needPosInt(req.iteration, 'iteration は');
    const keyOf = rewriting ? { iteration: req.iteration } : { run: req.run };
    const known = view.placements.find((p) => (rewriting ? p.iteration === req.iteration : p.iteration === undefined && p.run === req.run));
    const output = (after) => {
      const rec = after.placements.find((p) => (rewriting ? p.iteration === req.iteration : p.iteration === undefined && p.run === req.run));
      return { result: rec.result, lines: rec.lines, reason: rec.reason, ...(rewriting ? {} : { findings: rec.findings }) };
    };
    if (known) return { records: [strip(known)], output };
    const read = rewriting ? await authorRanges(view, req.iteration) : await reviewRanges(view);
    const judged = read.ranges ? judgePlacement(read.ranges) : null;
    // 読めたファイルだけで不適合なら、読めないファイルの中身によらず不適合（見出し行が増えても 2 以上で不適合）。それ以外は決められない。
    const placed = !read.unreadable?.length || judged?.result === UNIT_RESULTS.nonconform
      ? judged
      : { result: UNIT_RESULTS.unchecked, lines: [], reason: `判断点の表を探す範囲のファイルを読めず結果を決められない（SP-BPCONFORMANCE-038）: ${read.unreadable.join(', ')}` };
    const found = !rewriting && placed.result === UNIT_RESULTS.nonconform ? await reviewFindings(view, req.run, placed, read.entries) : { records: [], ids: [] };
    const record = { t: RECORDS.placement, ...keyOf, run: req.run, ...placed, ...(rewriting ? {} : { findings: found.ids }) };
    return { records: [...found.records, record], output };
  });
}
