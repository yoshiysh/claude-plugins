// 性能の記録・候補の比較の条件の照合・改善の候補（architecture.md「性能の記録・比較・改善」、artifact-formats.md「性能の記録」）。
// 取れなかった値は 0 にせず 取得できず・該当なし で示す。
export const locationFromEnv = () => (process.env.CI !== undefined && process.env.CI !== '' ? 'CI' : 'ローカル');

export const ms = (value) => (Number.isFinite(value) ? { value: Math.max(0, Math.round(value)), unit: 'ms' } : unavailable('時間を測れなかった'));
export const bytes = (value) => (Number.isFinite(value) ? { value: Math.max(0, Math.round(value)), unit: 'bytes' } : unavailable('常駐メモリの標本を取れなかった'));
export const unavailable = (reason) => ({ status: '取得できず', reason });
export const notApplicable = (reason) => ({ status: '該当なし', reason });
export const RETRIES = Object.freeze({ value: 0, unit: 'count' });
export const COST = unavailable('費用は CLI から観測できない');
export const BUILD = notApplicable('Z3 はビルドを持たない');
export const HUMAN = unavailable('人の介入の回数は CLI から観測できない');

export const SALVAGE_TIME_REASON = 'salvage の結果は作った者と時刻によらない内容にするため、時刻を記録しない';

export function salvagePerformance(location) {
  const u = unavailable(SALVAGE_TIME_REASON);
  return {
    location,
    run: {
      total_ms: u, preparation_ms: u, build_ms: BUILD, checks_ms: u, confirmation_ms: u, storage_ms: u,
      cpu_time_ms: unavailable('salvage は道具の CPU 時間を測らない'), peak_rss_bytes: unavailable('salvage は常駐メモリを測らない'),
      cost: COST, human_interventions: HUMAN, retries: RETRIES,
    },
    executions: [], findings: [],
  };
}

export function emptyPerformance(location, reason) {
  const u = unavailable(reason);
  return {
    location,
    run: { total_ms: u, preparation_ms: u, build_ms: BUILD, checks_ms: u, confirmation_ms: u, storage_ms: u, cpu_time_ms: u, peak_rss_bytes: u, cost: COST, human_interventions: HUMAN, retries: RETRIES },
    executions: [], findings: [],
  };
}

const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// performance_claim を書いた候補ごとに、比べる 2 つの候補の comparison_basis の 5 つを決定的に照合する。
// 一致を確かめられない組の主張は null にする（結果に優劣を残さない）。
export function compareCandidates(candidates) {
  const conditions = [];
  const out = candidates.map((c) => ({ ...c }));
  for (const c of out) {
    if (!c.performance_claim) continue;
    const other = out.find((x) => x.name === c.performance_claim.better_than);
    const a = c.comparison_basis;
    const b = other ? other.comparison_basis : null;
    const matches = {
      property: Boolean(b) && sameSet(a.property_ids, b.property_ids),
      assumptions: Boolean(b) && sameSet(a.assumptions, b.assumptions),
      scope: Boolean(b) && a.scope === b.scope,
      assurance: Boolean(b) && a.assurance === b.assurance,
      judgment_rules: Boolean(b) && a.judgment_rules === b.judgment_rules,
    };
    const all = Object.values(matches).every(Boolean);
    const differ = Object.entries(matches).filter(([, v]) => !v).map(([k]) => k);
    conditions.push({
      compared: [c.name, c.performance_claim.better_than], matches, result: all ? '一致を確認' : '一致を確認できず',
      reason: all ? '比べる実行の性質・前提・範囲・保証・判定の規則が一致した'
        : `${b ? `一致しない項目（${differ.join('・')}）があるので性能の優劣を示さない` : '比べる相手の候補が無い'}。主張: ${c.name} は ${c.performance_claim.better_than} より ${c.performance_claim.metric} が良い`,
    });
    if (!all) c.performance_claim = null;
  }
  return { candidates: out, comparison_conditions: conditions };
}

// 改善の候補。性能の記録から測定上の問題を決定的に挙げ、この run では採用しない。
export function findings(executionsSummary) {
  const out = [];
  const toolTime = executionsSummary.filter((x) => x.time_limit_hit === '道具').map((x) => x.id);
  if (toolTime.length) out.push({ id: 'finding-tool-time-limit', problem: '道具自身の時間の上限に達した実行がある', evidence: `実行: ${toolTime.join(', ')}`,
    candidates: [{ change: '検査の範囲を分ける', keeps_scope_and_assurance: '分けた範囲の和が元の範囲と同じなら保つ' }, { change: '道具の時間の上限を上げる', keeps_scope_and_assurance: '範囲と保証は変わらない' }],
    decision: 'この run では採用しない', reason: 'run の中で計画を変えない' });
  const unknown = executionsSummary.filter((x) => x.tool_result === '判定できない' && x.time_limit_hit === null).map((x) => x.id);
  if (unknown.length) out.push({ id: 'finding-unknown', problem: '道具が判定できないと返した実行がある', evidence: `実行: ${unknown.join(', ')}`,
    candidates: [{ change: '検査を単独で動かす', keeps_scope_and_assurance: '範囲と保証は変わらない' }],
    decision: 'この run では採用しない', reason: 'run の中で計画を変えない' });
  const requester = executionsSummary.filter((x) => x.time_limit_hit === '依頼元').map((x) => x.id);
  if (requester.length) out.push({ id: 'finding-request-time-limit', problem: '依頼元の時間の上限に達した実行がある', evidence: `実行: ${requester.join(', ')}`,
    candidates: [{ change: '時間の上限を大きくして依頼し直す', keeps_scope_and_assurance: '範囲と保証は変わらない' }],
    decision: 'この run では採用しない', reason: '改善の採用は run の外の判断' });
  return out;
}
