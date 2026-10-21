import { FIXED_AUDIT_UNCHECKED, UNCHECKED_SCOPES, VERIFY_STAGES } from './constants.mjs';
import { validTarget } from './view.mjs';

// SP-BPINSPECTION-025 の 5 つの場合を状態から導く。照らす先の全体の未検査と PA-3 の固定の 1 件は有効な照らす先の記録から導くので、
// 照らせずに止まった前の run の未検査が、直した後の結果に残らない。
export function uncheckedViewpoints(v) {
  const target = validTarget(v);
  if (!target) return [];
  const out = [];
  for (const t of target.targets) {
    if (!t.readable && t.viewpoint === 'spec') {
      out.push({ viewpoint: t.viewpoint, scope: UNCHECKED_SCOPES.whole, value: t.viewpoint, reason: `${t.files.map((f) => f.path).join(', ')}（${t.reason}）`, run: target.run });
    }
  }
  const forcedBy = new Map(Object.entries(v.applicability?.forcedBy ?? {}));
  if (v.applicability && target.viewpoints.includes('flow')) {
    for (const unit of v.applicability.forced) {
      out.push({ viewpoint: 'flow', scope: UNCHECKED_SCOPES.unit, value: unit, reason: forcedBy.get(unit), run: v.applicability.run });
    }
  }
  for (const extra of v.extras.values()) {
    const item = v.items.get(extra.item);
    if (!VERIFY_STAGES.has(item.stage) || !Array.isArray(extra.data?.unchecked)) continue;
    for (const u of extra.data.unchecked) {
      const fixed = u.viewpoint === 'flow' && u.scope === UNCHECKED_SCOPES.unit ? forcedBy.get(u.value) : undefined;
      out.push({ viewpoint: u.viewpoint, scope: u.scope, value: u.value, reason: fixed ?? u.reason, run: v.lineRuns.get(extra.line) });
    }
  }
  if (target.viewpoints.includes('audit')) {
    out.push({ viewpoint: 'audit', scope: UNCHECKED_SCOPES.pa, value: FIXED_AUDIT_UNCHECKED.value, reason: FIXED_AUDIT_UNCHECKED.reason, run: target.run });
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
