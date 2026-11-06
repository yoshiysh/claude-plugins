import { cliOps, expandIds, tableIn, topLevelTokens, workflowInputs } from './extract.mjs';

// 段の表の「定める仕様項目」と操作の表の「実現する項目」が共有する仕様項目 ID で、操作を段に結び付ける。
export function stageOfOps(fn) {
  const stages = fn === 'create' || fn === 'update'
    ? tableIn('bp-authoring.md', 'SP-BPAUTHORING-005', (x) => x.header[0] === '段')[0].rows.map((r, i) => ({ name: r.cells[0], order: i, ids: expandIds(r.cells[3]), line: r.line }))
    : tableIn('bp-inspection.md', 'SP-BPINSPECTION-001', (x) => x.header[1] === '段')[0].rows
      .filter((r) => r.cells[4].includes(fn))
      .map((r, i) => ({ name: r.cells[1], order: i, ids: expandIds(r.cells[6]), line: r.line }));
  const ops = cliOps();
  return ops.map((op) => {
    const hits = stages.filter((s) => s.ids.some((id) => op.realizes.includes(id)));
    return { ...op, stages: hits };
  });
}

const ERROR_CODE = /^E_[A-Z_]+$/;

// 操作ごとに受け取る欄の作り手（前の操作の返すもの、Workflow の入力）を探す。
export function flow(fn) {
  const ops = stageOfOps(fn);
  const inputs = new Set(workflowInputs().map((x) => x.name));
  const producers = new Map();
  for (const op of ops) for (const tok of topLevelTokens(op.gives)) {
    if (!producers.has(tok)) producers.set(tok, []);
    producers.get(tok).push(op);
  }
  const results = [];
  for (const op of ops) {
    for (const field of topLevelTokens(op.takes).filter((f) => !ERROR_CODE.test(f))) {
      const by = (producers.get(field) ?? []).filter((p) => p.name !== op.name);
      const fromInput = inputs.has(field);
      let verdict;
      if (fromInput) verdict = 'input';
      else if (by.length === 0) verdict = 'unresolved';
      else if (op.stages.length === 0 || by.some((p) => p.stages.length === 0)) verdict = 'unordered';
      else if (by.some((p) => Math.min(...p.stages.map((s) => s.order)) <= Math.max(...op.stages.map((s) => s.order)))) verdict = 'ordered';
      else verdict = 'later';
      results.push({ op: op.name, line: op.line, field, verdict, producers: by.map((p) => p.name), opStages: op.stages.map((s) => s.name) });
    }
  }
  return { ops, results };
}

// 操作の行が「`<操作>` の記録が無ければ」で名指す前の操作（読む記録の作り手が表から決まる唯一の形）。
export function preconditions(fn) {
  const ops = stageOfOps(fn);
  const byName = new Map(ops.map((o) => [o.name, o]));
  const edges = [];
  for (const op of ops) {
    for (const m of op.gives.matchAll(/`([\w-]+)`(?:（[^）]*）)? の記録が無ければ/g)) {
      const dep = byName.get(m[1]);
      if (dep) edges.push({ op: op.name, dep: dep.name, line: op.line, opStages: op.stages.map((s) => s.order), depStages: dep.stages.map((s) => s.order) });
    }
  }
  return edges;
}

export function gapSnapshot() {
  const out = {};
  for (const fn of ['create', 'update', 'review', 'audit']) {
    const f = flow(fn);
    out[fn] = {
      unmappedOps: f.ops.filter((o) => o.stages.length === 0).map((o) => o.name),
      noNamedProducer: f.results.filter((r) => r.verdict === 'unresolved').map((r) => `${r.op}.${r.field}`),
      producerAtLaterStageOnly: f.results.filter((r) => r.verdict === 'later').map((r) => `${r.op}.${r.field}<-${r.producers.join('|')}`),
    };
  }
  return out;
}

if (process.argv[2] === '--print') console.log(JSON.stringify(gapSnapshot(), null, 2));
