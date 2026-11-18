// 判定の期待値を、仕様 SP-FORMALMETHOD-010・011・015 と artifact-formats.md の End の意味だけから導く。
// 実装（scripts/lib/verdict.mjs）を読まずに書いた独立の導出で、実装とオラクルの両方をこれと照らす。

export const TOOL_RESULTS = ['満たす', '反する', '判定できない', '判定以外のエラー', 'なし'];
export const STOPPED_BY = ['時間', 'その他', null];
export const TIME_LIMIT_HIT = [null, '依頼元', '道具'];
export const CHECK_VERDICTS = ['成功', '反例', '未実行', 'unknown', '時間切れ', '実行失敗'];
export const VERDICTS = ['検証済み', '別手段で確認済み', '反例', '未実行', 'unknown', '時間切れ', '実行失敗', '未確認'];
export const UNMET_ORDER = [
  '必要な性質が検証の成功でない', '確認が終わっていない', '対応できていない組合せ', '回答を待つ問い',
  '記録の未保存', '必要な性質が 0 件', '検出能力未確認', '反例', '実行できない検査',
];

export const NOT_STARTED = Object.freeze({
  started: false, tool_result: 'なし', abnormal_exit: false, unreadable_output: false, stopped_by: null, time_limit_hit: null,
});

export function allEnds() {
  const out = [];
  for (const started of [true, false])
    for (const tool_result of TOOL_RESULTS)
      for (const abnormal_exit of [false, true])
        for (const unreadable_output of [false, true])
          for (const stopped_by of STOPPED_BY)
            for (const time_limit_hit of TIME_LIMIT_HIT)
              out.push({ started, tool_result, abnormal_exit, unreadable_output, stopped_by, time_limit_hit });
  return out;
}

// 起こらない End なら理由を、起こりうるなら null を返す。
export function invalidReason(e) {
  if (!e.started) {
    const d = NOT_STARTED;
    if (e.tool_result !== d.tool_result || e.abnormal_exit || e.unreadable_output || e.stopped_by !== null || e.time_limit_hit !== null)
      return 'vocab: 始めていない検査が既定でない欄を持つ';
    return null;
  }
  if (e.tool_result !== 'なし' && (e.abnormal_exit || e.unreadable_output)) return 'vocab: 道具の返りと異常終了・読めない出力が重なる';
  if (e.abnormal_exit && e.unreadable_output) return 'vocab: 異常終了と読めない出力が重なる';
  // 期限・停止が先なら tool_result は なし（artifact-formats「期限と道具の終わりが重なったとき」）
  if (e.stopped_by !== null && e.tool_result !== 'なし') return 'run: 道具が返りを報告した後に止めている';
  // 道具が自分で終わったなら、読む順（cli-contract「Z3 の adapter」）で返り・異常終了・読めない出力のどれかになる
  if (e.stopped_by === null && e.tool_result === 'なし' && !e.abnormal_exit && !e.unreadable_output) return 'run: 止めずに返りが無い';
  // stopped_by 時間 は依頼元の時間の上限で止めたときだけ（cli-contract「依頼の時間の上限に達したら…group を止める」）
  if (e.stopped_by === '時間' && e.time_limit_hit !== '依頼元') return 'run: 時間で止めたのに依頼元の上限に達していない';
  // SP-010: 依頼元の時間の上限に達したら実行中の検査を止める
  if (e.time_limit_hit === '依頼元' && e.stopped_by === null) return 'run: 依頼元の上限に達したのに止めていない';
  return null;
}

// SP-011 の検査の判定の表と優先の順。
export function specCheckVerdict(e) {
  const r = invalidReason(e);
  if (r) throw new Error(`invalid End for spec derivation: ${r}`);
  const stopped = e.stopped_by !== null;
  const c = {
    反例: e.tool_result === '反する',
    時間切れ: e.started && e.time_limit_hit !== null,
    未実行: !e.started || (stopped && e.tool_result === 'なし'),
    unknown: e.tool_result === '判定できない',
  };
  const others = c.反例 || c.時間切れ || c.未実行 || c.unknown;
  c.実行失敗 = (!stopped && (e.abnormal_exit || e.unreadable_output))
    || e.tool_result === '判定以外のエラー'
    || (e.started && (e.tool_result === 'なし' || e.tool_result === '判定以外のエラー') && !others);
  for (const k of ['反例', '時間切れ', '実行失敗', '未実行', 'unknown']) if (c[k]) return k;
  if (e.tool_result === '満たす') return '成功';
  throw new Error('spec derivation: no verdict applies');
}

const byVerdictOrder = (a, b) => VERDICTS.indexOf(a) - VERDICTS.indexOf(b);

// SP-011 の性質の判定（検査が 1 件以上なら集約、0 件なら SP-007 の場合だけ 未実行）。
export function specAggregate(f) {
  const nonSucc = [...new Set(f.check_verdicts.filter((v) => v !== '成功'))].sort(byVerdictOrder);
  if (nonSucc.length > 0) return nonSucc;
  if (f.check_verdicts.length > 0 && f.formalizable) {
    const ok = !f.depends_on_question && f.correspondence && f.meaning_confirmed && f.deterministic_confirmed
      && (!f.composition_applies || f.composition_confirmed)
      && (!f.detection_performed || f.detection_confirmed);
    return ok ? ['検証済み'] : ['未確認'];
  }
  if (!f.formalizable) return (!f.depends_on_question && f.alternative_confirmed) ? ['別手段で確認済み'] : ['未確認'];
  if (f.no_suitable_tool) return ['未実行'];
  return ['未確認'];
}

// SP-015 の完了の条件と 2 つの保持規則、停止の規則。
export function specDecide(g) {
  const success = (vs) => vs.length === 1 && (vs[0] === '検証済み' || vs[0] === '別手段で確認済み');
  const preds = [
    g.required_verdicts.every(success),
    !g.confirmations_unresolved,
    g.uncovered_combinations === 0,
    g.pending_questions === 0,
    g.all_records_saved,
    g.required_verdicts.length > 0,
    g.detection_unconfirmed === 0,
    !g.has_counterexample,
    !g.has_unrunnable,
  ];
  const unmet = UNMET_ORDER.filter((_, i) => !preds[i]);
  return { status: unmet.length === 0 ? '完了' : '停止', unmet };
}

export const DEFAULT_FACTS = Object.freeze({
  formalizable: true, check_verdicts: [], no_suitable_tool: false, depends_on_question: false,
  correspondence: true, meaning_confirmed: true, deterministic_confirmed: true,
  composition_applies: false, composition_confirmed: false,
  detection_performed: false, detection_confirmed: false, alternative_confirmed: false,
});

export const DEFAULT_GLOBAL = Object.freeze({
  required_verdicts: [['検証済み']], confirmations_unresolved: false, uncovered_combinations: 0, pending_questions: 0,
  all_records_saved: true, detection_unconfirmed: 0, has_counterexample: false, has_unrunnable: false,
});

// required_verdicts から has_counterexample・has_unrunnable を導く（GlobalFacts の定義どおり）。
export function globalFrom(required_verdicts, rest = {}) {
  const flat = required_verdicts.flat();
  return {
    ...DEFAULT_GLOBAL, ...rest, required_verdicts,
    has_counterexample: flat.includes('反例'),
    has_unrunnable: flat.includes('未実行') || flat.includes('実行失敗'),
  };
}

// artifact-formats「classifyCheck」: 例外は name InvalidEndError・code invalid_end の Error。code で照合し message は見ない。
export function isInvalidEndError(err) {
  return err instanceof Error && err.code === 'invalid_end' && err.name === 'InvalidEndError';
}
