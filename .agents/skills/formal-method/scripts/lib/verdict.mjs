// 判定の 3 関数（artifact-formats.md「判定の 3 関数」、SP-FORMALMETHOD-011・015）。全て純粋関数で、入力を変えない。
import { CHECK_VERDICT_PRIORITY, VERDICTS, UNMET_ORDER, End, conforms } from './schemas.mjs';

export class InvalidEndError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidEndError';
    this.code = 'invalid_end';
  }
}

// artifact-formats.md「検査の終わり方」の起こらない組。語彙に写せない組と、網羅表の除外・unsat の行を、規則の表で持つ。
const IMPOSSIBLE = [
  [(e) => !e.started && (e.tool_result !== 'なし' || e.abnormal_exit || e.unreadable_output || e.stopped_by !== null || e.time_limit_hit !== null), '始めていない実行は全ての欄が既定'],
  [(e) => e.started && e.tool_result !== 'なし' && (e.abnormal_exit || e.unreadable_output), '道具の返りがあるなら異常終了・読めない出力は false'],
  [(e) => e.started && e.abnormal_exit && e.unreadable_output, '異常終了と読めない出力は同時に立たない'],
  [(e) => e.started && e.stopped_by !== null && e.tool_result !== 'なし', '止めた実行は道具の返りを持たない（期限と終わりが重なったときは先の出来事で決める）'],
  [(e) => e.started && e.stopped_by === null && e.tool_result === 'なし' && !e.abnormal_exit && !e.unreadable_output, '止めずに終わった実行は、返り・異常終了・読めない出力のどれかを持つ'],
  [(e) => e.started && e.stopped_by === '時間' && e.time_limit_hit !== '依頼元', '時間で止めるのは依頼元の上限に達したときだけ'],
  [(e) => e.started && e.time_limit_hit === '依頼元' && e.stopped_by === null, '依頼元の上限に達したら実行中の検査を止める'],
];

// 入力の形の正本は schemas.mjs の End。
const wellTyped = (e) => conforms(End, e);

// SP-011 の表の「使う条件」。各値の述語を別々に持ち、成り立つ値のうち CHECK_VERDICT_PRIORITY の先のものを返す。
const USES = {
  反例: (e) => e.tool_result === '反する',
  時間切れ: (e) => e.started && e.time_limit_hit !== null,
  未実行: (e) => !e.started || (e.stopped_by !== null && e.tool_result === 'なし'),
  unknown: (e) => e.tool_result === '判定できない',
};
const failed = (e) => {
  if (e.tool_result === '判定以外のエラー') return true;
  if (e.stopped_by === null && (e.abnormal_exit || e.unreadable_output)) return true;
  // 受け皿: 始めた後、どの返りも無く、他の値の条件にも当たらない
  return e.started && e.tool_result === 'なし' && !Object.values(USES).some((u) => u(e));
};

export function classifyCheck(end) {
  if (!wellTyped(end)) throw new InvalidEndError('End の形に合わない');
  const hit = IMPOSSIBLE.find(([when]) => when(end));
  if (hit) throw new InvalidEndError(hit[1]);
  const holding = new Set(Object.entries(USES).filter(([, u]) => u(end)).map(([v]) => v));
  if (failed(end)) holding.add('実行失敗');
  const first = CHECK_VERDICT_PRIORITY.find((v) => holding.has(v));
  if (first) return first;
  if (end.tool_result === '満たす') return '成功';
  throw new InvalidEndError('どの判定の条件も成り立たない');
}

const byVerdictOrder = (a, b) => VERDICTS.indexOf(a) - VERDICTS.indexOf(b);

export function aggregateProperty(facts) {
  const cvs = facts.check_verdicts;
  // 段 1
  const nonSuccess = [...new Set(cvs.filter((v) => v !== '成功'))].sort(byVerdictOrder);
  if (nonSuccess.length > 0) return nonSuccess;
  // 段 2
  if (cvs.length > 0 && facts.formalizable) {
    const composition = !facts.composition_applies || facts.composition_confirmed;
    const detection = !facts.detection_performed || facts.detection_confirmed;
    const verified = !facts.depends_on_question && facts.correspondence && facts.meaning_confirmed && facts.deterministic_confirmed && composition && detection;
    return verified ? ['検証済み'] : ['未確認'];
  }
  // 段 3
  if (!facts.formalizable) {
    if (!facts.depends_on_question && facts.alternative_confirmed) return ['別手段で確認済み'];
    return ['未確認'];
  }
  // 段 4
  if (cvs.length === 0 && facts.no_suitable_tool) return ['未実行'];
  // 段 5
  return ['未確認'];
}

// SP-015 の「検証の成功」の正本（decideStatus と結果の組立てが使う）。
export const isSuccess = (vs) => vs.length === 1 && (vs[0] === '検証済み' || vs[0] === '別手段で確認済み');

export function decideStatus(global) {
  const holds = {
    必要な性質が検証の成功でない: global.required_verdicts.every(isSuccess),
    確認が終わっていない: !global.confirmations_unresolved,
    対応できていない組合せ: global.uncovered_combinations === 0,
    回答を待つ問い: global.pending_questions === 0,
    記録の未保存: global.all_records_saved,
    '必要な性質が 0 件': global.required_verdicts.length > 0,
    検出能力未確認: global.detection_unconfirmed === 0,
    反例: !global.has_counterexample,
    実行できない検査: !global.has_unrunnable,
  };
  const unmet = UNMET_ORDER.filter((code) => !holds[code]);
  return { status: unmet.length === 0 ? '完了' : '停止', unmet };
}
