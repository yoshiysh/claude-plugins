// 決定的な確認の記録と、確認の段の unit の組立て（artifact-formats.md「確認」「task の一覧」の役と context）。
import { classifyCheck } from '../verdict.mjs';

export const TRUNCATED = '標準出力を TOOL_OUTPUT_MAX_BYTES で切り詰めた';

// 道具を実行した確認の result: classifyCheck の 成功 → 成り立つ、反例 → 成り立たない、他 → 確認できず。
export function confirmationResult(end) {
  let v;
  try { v = classifyCheck(end); } catch { return '確認できず'; }
  if (v === '成功') return '成り立つ';
  if (v === '反例') return '成り立たない';
  return '確認できず';
}

export function verdictOf(end) {
  try { return classifyCheck(end); } catch { return null; }
}

export class ConfirmationIds {
  constructor() { this.n = new Map(); }
  next(kind) { const v = (this.n.get(kind) ?? 0) + 1; this.n.set(kind, v); return `confirm-${kind}-${v}`; }
}

// 確認の段の unit（artifact-formats.md「役と context」の unit_id の作り方）。性質ごとの保証の unit は無い。
// 忠実さの unit はモデルごとで、そのモデルの性質の判断を要する項目（judgments の id）を答える（judgment_ids）。
export function reviewUnits({ inventories, nonformal, models, partitionsAdopted, judgments = [] }) {
  const units = [];
  for (const inv of inventories) units.push({ role: 'extraction-reviewer', perspective: 'extraction', unit_id: `extraction-${inv.target_id}`, target_id: inv.target_id, property_ids: [], model_id: null, judgment_ids: [] });
  for (const p of nonformal) units.push({ role: 'assurance-reviewer', perspective: 'nonformal', unit_id: `nonformal-${p.id}`, target_id: null, property_ids: [p.id], model_id: null, judgment_ids: [] });
  for (const m of models) {
    const mps = new Set(m.data.properties.map((p) => p.id));
    units.push({ role: 'fidelity-reviewer', perspective: 'fidelity', unit_id: `fidelity-${m.id}`, target_id: null, property_ids: [], model_id: m.id,
      judgment_ids: judgments.filter((j) => mps.has(j.model_property_id)).map((j) => j.id) });
  }
  if (partitionsAdopted) units.push({ role: 'composition-reviewer', perspective: 'composition', unit_id: 'composition', target_id: null, property_ids: [], model_id: null, judgment_ids: [] });
  return units;
}

// 忠実さの確認役の返り値の judgments が、その unit の判断を要する項目（ids）にちょうど 1 つずつ答えているか。違えば理由の文、合えば null。
export function judgmentAnswers(ids = []) {
  return (ret) => {
    const got = ret.judgments.map((j) => j.id);
    const missing = ids.filter((id) => !got.includes(id));
    const extra = got.filter((id) => !ids.includes(id));
    const dup = got.filter((id, i) => got.indexOf(id) !== i);
    const bad = [...(missing.length ? [`判断を要する項目 ${missing.join(', ')} の答えが無い`] : []), ...(extra.length ? [`この担当の判断を要する項目に無い ${[...new Set(extra)].join(', ')} に答えた`] : []),
      ...(dup.length ? [`判断を要する項目 ${[...new Set(dup)].join(', ')} に 2 度答えた`] : [])];
    return bad.length ? bad.join('。') : null;
  };
}

// 組合せは cause-combination-<model_id>-<n>（n はその組の Combinations.cells の中の 0 から数えた位置）。状態と出来事の名前は
// Id の文字に合うとは限らないので入れない（artifact-formats.md「役と context」）。combinations: [{ model: { id }, combinations }]
export function causeUnitId(subject, combinations = []) {
  if (subject.kind === 'combination') {
    const cells = combinations.find((x) => x.model.id === subject.model_id)?.combinations.cells ?? [];
    const n = cells.findIndex((c) => c.state === subject.state && c.event === subject.event);
    if (n < 0) throw new Error(`組合せ ${subject.model_id} の位置が cells に無い`);
    return `cause-combination-${subject.model_id}-${n}`;
  }
  return `cause-${subject.kind}-${subject.id}`;
}
