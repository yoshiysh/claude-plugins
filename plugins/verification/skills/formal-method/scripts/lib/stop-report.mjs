// 停止の報告の組み立て（artifact-formats.md「停止の報告」「stop_report.stage の決め方」）。結果の組立て（result.mjs）と
// 公開できなかった R' の作り直し（publish.mjs）の両方が使う。依存の循環を作らないよう、schemas.mjs だけに依る。
import { INTERRUPT_CODES, STAGES } from './schemas.mjs';

export const reason = (code, stage, detail, extra = {}) => ({ code, stage, request_code: extra.request_code ?? null, item: extra.item ?? null, field: extra.field ?? null, detail });

// 中断の理由があれば最初の中断の理由の段、無ければ段の並びで最も上流の段。
const stopStageOf = (reasons) => {
  const firstInterrupt = reasons.find((x) => INTERRUPT_CODES.includes(x.code));
  if (firstInterrupt) return firstInterrupt.stage;
  return [...reasons].sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage))[0].stage;
};

// 中断の理由を記録の順に先に並べる。
export function orderReasons(reasons) {
  return [...reasons.filter((x) => INTERRUPT_CODES.includes(x.code)), ...reasons.filter((x) => !INTERRUPT_CODES.includes(x.code))];
}

export function stopReport({ reasons, confirmed = [], unconfirmed = [], created = [], notCreated = [], running = [], aborted = [], questions = [], unsaved = [] }) {
  const ordered = orderReasons(reasons);
  return {
    stage: stopStageOf(ordered), reasons: ordered,
    confirmed_scope: confirmed, unconfirmed_scope: unconfirmed,
    artifacts_created: created, artifacts_not_created: notCreated,
    checks_running: running, checks_aborted: aborted,
    questions, unsaved: [...new Set(unsaved.map((u) => u.kind))],
  };
}
