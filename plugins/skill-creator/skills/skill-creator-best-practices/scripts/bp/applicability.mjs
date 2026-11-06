import { APPLICABILITY_ANSWERS, APPLICABILITY_QUESTIONS, PRESENCE, PRESENCE_QUESTIONS, RUN_SEQUENCE, SHAPE_QUESTIONS, SHAPES } from './constants.mjs';
import { internal } from './errors.mjs';

const { yes, no, unreached } = APPLICABILITY_ANSWERS;
const TOP_QUESTIONS = APPLICABILITY_QUESTIONS.filter((q) => !SHAPE_QUESTIONS.includes(q));

// 問い A が「はい」の後の Q1・Q2・Q3 の並びと到達した形（SP-BPINSPECTION-006 の表。設計方針文書「形の判定」の図の道）。
export const PATHS = Object.freeze([
  { answers: [yes, unreached, unreached], shape: SHAPES.pipeline },
  { answers: [no, yes, unreached], shape: SHAPES.iterative },
  { answers: [no, no, yes], shape: SHAPES.explore },
  { answers: [no, no, no], shape: SHAPES.turn },
]);
const TURN_BY_A = Object.freeze([unreached, unreached, unreached]);
// 受理する問い A・W の答えの組（SP-BPINSPECTION-006 の A と W の表）。
const ACCEPTED_TOP = Object.freeze([[no, unreached], [yes, no], [yes, yes]]);

export function shapeOf(answers) {
  return PATHS.find((p) => p.answers.every((a, i) => a === answers[i]))?.shape ?? null;
}

function checkQuotes(quotes, assetIds, what) {
  if (!Array.isArray(quotes) || quotes.length === 0) return `${what}の引用が 1 件も無い`;
  for (const q of quotes) {
    if (!q || !assetIds.has(q.asset)) return `${what}の引用の資産 ID が台帳の今の資産に無い: ${JSON.stringify(q?.asset)}`;
    if (!Number.isInteger(q.line) || q.line < 1) return `${what}の引用の行番号が 1 以上の整数でない: ${JSON.stringify(q.line)}`;
    if (typeof q.text !== 'string' || q.text === '') return `${what}の引用の本文が空`;
  }
  return null;
}

function checkAnswer(a, choices, assetIds, what) {
  if (!a || !choices.includes(a.answer)) return `${what}の答えが選択肢に無い: ${JSON.stringify(a?.answer)}`;
  return checkQuotes(a.quotes, assetIds, `${what} `);
}

const has = (o, k) => o !== null && typeof o === 'object' && Object.hasOwn(o, k);

function readPlace(answers, presence, assetIds, where) {
  const seq = [];
  for (const q of SHAPE_QUESTIONS) {
    const bad = checkAnswer(answers?.[q], Object.values(APPLICABILITY_ANSWERS), assetIds, `${where}問い ${q} `);
    if (bad) return { error: bad };
    seq.push(answers[q].answer);
  }
  for (const f of PRESENCE_QUESTIONS) {
    const bad = checkAnswer(presence?.[f], Object.values(PRESENCE), assetIds, `${where}${f} `);
    if (bad) return { error: bad };
  }
  return { seq, ledger: presence.ledger.answer, fanout: presence.fanout.answer };
}

function cellMatches(cell, value) {
  return cell === '*' || cell === value;
}

function rowOf(rows, shape, ledger, fanout) {
  return rows.find((r) => r.form === shape && cellMatches(r.ledger, ledger) && cellMatches(r.fanout, fanout)) ?? null;
}

// 受理するか拒否するかの裁定が下るまで、どちらにも確定させない（SP-BPINSPECTION-006・SP-BPAUTHORING-017 の保持規則）。
function holdUnsettledAssets(assets) {
  if (!Array.isArray(assets) || assets.length === 0 || new Set(assets).size !== assets.length) {
    internal('runs の要素の assets が欠けている・並びでない・空・重複するときの扱いは裁定待ち（SP-BPINSPECTION-006 の保持規則）');
  }
}

function judgeRuns(result, assetIds, rows) {
  const { runs } = result;
  if (!Array.isArray(runs) || runs.length < 3) return { error: `問い W がはいなのに runs の要素が 3 つ未満: ${Array.isArray(runs) ? runs.length : JSON.stringify(runs)}` };
  if (runs[0]?.run !== RUN_SEQUENCE) return { error: `runs の 1 つ目の要素の run が ${RUN_SEQUENCE} でない: ${JSON.stringify(runs[0]?.run)}` };
  const names = new Set([RUN_SEQUENCE]);
  const out = [];
  for (const [i, r] of runs.entries()) {
    if (i > 0) {
      if (typeof r?.run !== 'string' || r.run === '' || names.has(r.run)) return { error: `runs の ${i + 1} つ目の要素の run が空か重複するか ${RUN_SEQUENCE}: ${JSON.stringify(r?.run)}` };
      names.add(r.run);
    }
    holdUnsettledAssets(r.assets);
    const stray = r.assets.find((a) => !assetIds.has(a));
    if (stray !== undefined) return { error: `runs の ${r.run} の assets の資産 ID が台帳の今の資産に無い: ${JSON.stringify(stray)}` };
    const place = readPlace(r.answers, r, assetIds, `runs の ${r.run} の`);
    if (place.error) return place;
    const shape = shapeOf(place.seq);
    if (!shape) return { error: `runs の ${r.run} の答えの並びが形の判定の図の道に無い: ${SHAPE_QUESTIONS.map((q, k) => `${q}=${place.seq[k]}`).join(' ')}` };
    const row = rowOf(rows, shape, place.ledger, place.fanout);
    if (!row) return { error: `適用の判定表に当たる行が無い: ${r.run} ${shape}・${place.ledger}・${place.fanout}` };
    out.push({ run: r.run, shape, row, assets: r.assets });
  }
  return { runs: out };
}

function judgeSingle(result, A, assetIds, rows) {
  if (has(result, 'runs')) return { error: '問い W がはいでないのに runs がある' };
  const place = readPlace(result.answers, result, assetIds, '');
  if (place.error) return place;
  const shape = A === no ? (place.seq.every((a, i) => a === TURN_BY_A[i]) ? SHAPES.turn : null) : shapeOf(place.seq);
  if (!shape) return { error: `答えの並びが形の判定の図の道に無い: A=${A} ${SHAPE_QUESTIONS.map((q, i) => `${q}=${place.seq[i]}`).join(' ')}` };
  const row = rowOf(rows, shape, place.ledger, place.fanout);
  if (!row) return { error: `適用の判定表に当たる行が無い: ${shape}・${place.ledger}・${place.fanout}` };
  return { shape, row };
}

// 検証役は行を選ばず、CLI が答えの並びから形と行を導く（SP-BPINSPECTION-006・SP-BPAUTHORING-017）。
// 行の単位を観点の閉集合（allowed）に絞るのは、仕様の観点の単位と除く単位をフローの観点の検証役に判定させないため（SP-BPINSPECTION-007）。
export function judgeApplicability(result, { assetIds, rows, allowed }) {
  if (result === null || typeof result !== 'object' || !result.answers || typeof result.answers !== 'object') return { error: '結果に answers が無い' };
  const top = [];
  for (const q of TOP_QUESTIONS) {
    const bad = checkAnswer(result.answers[q], Object.values(APPLICABILITY_ANSWERS), assetIds, `問い ${q} `);
    if (bad) return { error: bad };
    top.push(result.answers[q].answer);
  }
  if (!ACCEPTED_TOP.some((t) => t.every((a, i) => a === top[i]))) return { error: `答えの並びが形の判定の図の道に無い: ${TOP_QUESTIONS.map((q, i) => `${q}=${top[i]}`).join(' ')}` };
  const split = top[1] === yes;
  if (split) {
    const misplaced = [...SHAPE_QUESTIONS.filter((q) => has(result.answers, q)), ...PRESENCE_QUESTIONS.filter((f) => has(result, f))];
    if (misplaced.length) return { error: `問い W がはいなのに runs の外にある: ${misplaced.join('・')}` };
  }
  const judged = split ? judgeRuns(result, assetIds, rows) : judgeSingle(result, top[0], assetIds, rows);
  if (judged.error) return judged;
  const picked = split ? judged.runs.map((r) => r.row) : [judged.row];
  const units = new Map();
  for (const r of picked) for (const u of r.units) if (allowed.has(u.value) && !units.has(u.value)) units.set(u.value, u);
  const forced = [...new Set(picked.flatMap((r) => r.forced))].filter((u) => allowed.has(u));
  const placed = split
    ? { runs: judged.runs.map((r) => ({ run: r.run, shape: r.shape, row: r.row.row, assets: r.assets })) }
    : { shape: judged.shape, row: judged.row.row };
  return { ...placed, units: [...units.values()], forced };
}
