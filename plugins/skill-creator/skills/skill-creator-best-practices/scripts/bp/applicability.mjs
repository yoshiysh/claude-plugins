import { APPLICABILITY_ANSWERS, APPLICABILITY_QUESTIONS, PRESENCE, PRESENCE_QUESTIONS, SHAPES } from './constants.mjs';

const { yes, no, unreached } = APPLICABILITY_ANSWERS;

// 設計方針文書「形の判定」の図の道だけを受理する。答えた問いを飛ばした並び（SP-BPCONFORMANCE-004）で形を決めないため。
export const PATHS = Object.freeze([
  { answers: [no, unreached, unreached, unreached], shape: SHAPES.turn },
  { answers: [yes, yes, unreached, unreached], shape: SHAPES.pipeline },
  { answers: [yes, no, yes, unreached], shape: SHAPES.iterative },
  { answers: [yes, no, no, yes], shape: SHAPES.explore },
  { answers: [yes, no, no, no], shape: SHAPES.turn },
]);

export function shapeOf(answers) {
  const found = PATHS.find((p) => p.answers.every((a, i) => a === answers[i]));
  return found?.shape ?? null;
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

function cellMatches(cell, value) {
  return cell === '*' || cell === value;
}

// 行の単位をフローの観点の閉集合（allowed）に絞るのは、仕様の観点の単位と除く単位をフローの観点の検証役に判定させないため（SP-BPINSPECTION-007。両方が判定すると同じ違反が 2 件の指摘になる）。
export function judgeApplicability(result, { assetIds, rows, allowed }) {
  if (result === null || typeof result !== 'object' || !result.answers || typeof result.answers !== 'object') return { error: '結果に answers が無い' };
  const answers = [];
  for (const q of APPLICABILITY_QUESTIONS) {
    const a = result.answers[q];
    if (!a || !Object.values(APPLICABILITY_ANSWERS).includes(a.answer)) return { error: `問い ${q} の答えが選択肢に無い: ${JSON.stringify(a?.answer)}` };
    const bad = checkQuotes(a.quotes, assetIds, `問い ${q} `);
    if (bad) return { error: bad };
    answers.push(a.answer);
  }
  for (const field of PRESENCE_QUESTIONS) {
    const a = result[field];
    if (!a || !Object.values(PRESENCE).includes(a.answer)) return { error: `${field} の答えが選択肢に無い: ${JSON.stringify(a?.answer)}` };
    const bad = checkQuotes(a.quotes, assetIds, `${field} `);
    if (bad) return { error: bad };
  }
  const shape = shapeOf(answers);
  if (!shape) return { error: `答えの並びが形の判定の図の道に無い: ${APPLICABILITY_QUESTIONS.map((q, i) => `${q}=${answers[i]}`).join(' ')}` };
  const row = rows.find((r) => r.form === shape && cellMatches(r.ledger, result.ledger.answer) && cellMatches(r.fanout, result.fanout.answer));
  if (!row) return { error: `適用の判定表に当たる行が無い: ${shape}・${result.ledger.answer}・${result.fanout.answer}` };
  return {
    shape,
    row: row.row,
    units: row.units.filter((u) => allowed.has(u.value)),
    forced: row.forced.filter((u) => allowed.has(u)),
  };
}
