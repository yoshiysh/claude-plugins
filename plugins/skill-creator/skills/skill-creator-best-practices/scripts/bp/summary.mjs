import { SUMMARY_MAX_CHARS } from './constants.mjs';
import { currentAssets, currentRun, pendingItems, stoppedStage } from './view.mjs';

function clip(text, n) {
  const s = String(text).replace(/\s+/g, ' ');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function sections(v) {
  const run = currentRun(v);
  const stopped = stoppedStage(v);
  const pending = pendingItems(v, stopped);
  const out = [];
  out.push({ kind: '基本', lines: [
    `状態: ${v.state.id} 機能: ${v.state.function} 対象: ${v.paths.at(-1)?.root}`,
    `現在の run: ${run?.id} run の数: ${v.runs.length} 停止: ${[...v.stops.values()].map((s) => `${s.run}=${s.kind}`).join(' ') || 'なし'}`,
    `止まった段: ${stopped.stage ?? '未開始'}${stopped.round != null ? `.${stopped.round}` : ''}（${stopped.status}） 反復の回数: ${v.iterations}`,
  ] });
  if (v.state.request !== undefined) out.push({ kind: '依頼文', lines: [`依頼文: ${clip(v.state.request, 1500)}`] });
  out.push({ kind: '修正の根拠', lines: v.grounds.map((g) => `${g.id}: ${clip(JSON.stringify(g.ground), 300)}`) });
  out.push({ kind: '前提', lines: v.premises.map((p) => `${p.id} ${p.kind} (${p.run}): ${clip(p.text, 400)}`) });
  out.push({ kind: '未着手の項目', lines: pending.map((id) => `未着手: ${id}`) });
  out.push({ kind: '段', lines: v.stageOrder.map((k) => {
    const s = v.stages.get(k);
    const done = s.items.filter((id) => v.items.get(id).result !== undefined).length;
    return `段 ${s.stage}${s.round != null ? `.${s.round}` : ''}: ${s.ended ? '終了' : '途中'} 項目 ${s.items.length} 結果 ${done}`;
  }) });
  out.push({ kind: '打ち切った項目', lines: [...v.items.values()].filter((i) => i.aborted).map((i) => `打ち切り: ${i.id}（試行 ${i.fails.length}）`) });
  if (v.ledger) {
    const assets = currentAssets(v);
    const byState = {};
    for (const f of v.findings.values()) {
      const s = f.states.at(-1)?.state ?? 'none';
      byState[s] = (byState[s] ?? 0) + 1;
    }
    out.push({ kind: '台帳', lines: [`資産: ${assets.length} 指摘: ${v.findings.size} ${Object.entries(byState).map(([k, n]) => `${k}=${n}`).join(' ')}`] });
    out.push({ kind: '指摘', lines: [...v.findings.values()].map((f) => `${f.id} ${f.key.viewpoint} ${f.key.kind} ${f.key.asset} ${f.states.at(-1)?.state ?? ''}`) });
  }
  return out;
}

// 8,000 字以下に収め、載せなかったものは件数と種類を宣言する（SP-BPCONFORMANCE-033）。
export function summarize(v, budget = SUMMARY_MAX_CHARS) {
  const parts = sections(v);
  const reserve = 600;
  const kept = [];
  const omitted = [];
  let used = 0;
  for (const part of parts) {
    let dropped = 0;
    for (const line of part.lines) {
      if (used + line.length + 1 <= budget - reserve) {
        kept.push(line);
        used += line.length + 1;
      } else {
        dropped += 1;
      }
    }
    if (dropped > 0) omitted.push({ kind: part.kind, count: dropped });
  }
  if (omitted.length > 0) kept.push(clip(`省略: ${omitted.map((o) => `${o.kind} ${o.count} 件`).join('、')}`, reserve - 10));
  const text = kept.join('\n');
  return { text, chars: text.length, omitted };
}
