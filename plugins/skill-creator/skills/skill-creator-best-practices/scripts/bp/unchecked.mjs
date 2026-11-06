import { CONFORMANCE_SP, FIXED_AUDIT_UNCHECKED, UNCHECKED_SCOPES, UNIT_RESULTS, VERIFY_STAGES, VIEWPOINT } from './constants.mjs';
import { validTarget } from './view.mjs';

// SP-BPINSPECTION-025 の 7 つの場合を状態から導く。照らす先の全体の未検査と PA-3 の固定の 1 件は有効な照らす先の記録から導くので、
// 照らせずに止まった前の run の未検査が、直した後の結果に残らない。
// 強いられた未検査は無視される設定の一覧を読めないときだけ付く（SP-BPCONFORMANCE-019）ので、理由はその仕様項目 ID と一覧を読めないこと（SP-BPINSPECTION-025）。
const FORCED_REASON = '無視される設定の一覧を読めない';

export function uncheckedViewpoints(v) {
  const target = validTarget(v);
  if (!target) return [];
  const out = [];
  for (const t of target.targets) {
    if (!t.readable && t.viewpoint === VIEWPOINT.spec) {
      out.push({ viewpoint: t.viewpoint, scope: UNCHECKED_SCOPES.whole, value: t.viewpoint, reason: `${t.files.map((f) => f.path).join(', ')}（${t.reason}）`, run: target.run });
    }
  }
  const forcedBy = new Map(Object.entries(v.applicability?.forcedBy ?? {}));
  for (const extra of v.extras.values()) {
    const item = v.items.get(extra.item);
    if (!VERIFY_STAGES.has(item.stage) || !Array.isArray(extra.data?.unchecked)) continue;
    for (const u of extra.data.unchecked) {
      const fixed = u.viewpoint === VIEWPOINT.flow && u.scope === UNCHECKED_SCOPES.unit ? forcedBy.get(u.value) : undefined;
      out.push({ viewpoint: u.viewpoint, scope: u.scope, value: u.value, reason: fixed ? `${fixed}: ${FORCED_REASON}` : u.reason, run: v.lineRuns.get(extra.line) });
    }
  }
  if (target.viewpoints.includes(VIEWPOINT.flow)) {
    const placement = v.placements.at(-1);
    if (placement?.result === UNIT_RESULTS.unchecked) out.push({ viewpoint: VIEWPOINT.flow, scope: UNCHECKED_SCOPES.unit, value: CONFORMANCE_SP.placement, reason: placement.reason, run: placement.run });
    if (target.coverage) out.push({ viewpoint: VIEWPOINT.flow, scope: UNCHECKED_SCOPES.unit, value: CONFORMANCE_SP.placement, reason: target.coverage, run: target.run });
  }
  if (target.viewpoints.includes(VIEWPOINT.audit)) {
    out.push({ viewpoint: VIEWPOINT.audit, scope: UNCHECKED_SCOPES.pa, value: FIXED_AUDIT_UNCHECKED.value, reason: FIXED_AUDIT_UNCHECKED.reason, run: target.run });
  }
  for (const viewpoint of target.viewpoints) {
    const items = [...v.items.values()].filter((i) => VERIFY_STAGES.has(i.stage) && i.key?.viewpoint === viewpoint);
    if (items.length && items.every((i) => i.aborted)) {
      const reasons = [...new Set(items.map((i) => i.aborted.reason))];
      out.push({ viewpoint, scope: UNCHECKED_SCOPES.whole, value: viewpoint, reason: reasons.join(' / '), run: v.lineRuns.get(items.at(-1).aborted.line) });
    }
  }
  const seen = new Set();
  return out.filter((u) => {
    const k = JSON.stringify([u.viewpoint, u.scope, u.value, u.reason]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
