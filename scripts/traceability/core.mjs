import { categories } from './specs.mjs';
import { TRACE_STATUS, specIds } from '../../tools/lib/bp-docs.mjs';

function tree(events) {
  const nodes = new Map();
  const active = new Map();
  let sequence = 0;
  for (const event of events) {
    const d = event.data;
    if (!['test:enqueue','test:start','test:pass','test:fail'].includes(event.type)) continue;
    const modern = d.testId !== undefined;
    if (!modern && event.type === 'test:enqueue') continue;
    const namespace = `${d.entryFile ?? d.file}:${d.entryFile ? 'test':'outer'}`;
    const stack = modern ? namespace : 'legacy';
    const level = `${stack}:${d.nesting}`;
    const key = modern ? `${namespace}:${d.testId}` : event.type === 'test:start' ? `legacy:${++sequence}` : active.get(level)?.key ?? `legacy:${++sequence}`;
    let node = nodes.get(key);
    if (!node) {
      const parent = modern ? nodes.get(`${namespace}:${d.parentId}`) : active.get(`${stack}:${d.nesting - 1}`);
      node = {key,parent,name:d.name,file:d.file,entry:parent ? parent.entry : d.entryFile ?? d.file,nesting:d.nesting,children:0};
      nodes.set(key,node);
      if (parent) parent.children++;
    }
    if (event.type === 'test:start') {
      active.set(level,node);
      continue;
    }
    if (event.type === 'test:enqueue') continue;
    node.status = d.skip ? 'skip' : d.todo ? 'todo' : event.type === 'test:pass' ? 'pass' : d.details?.error?.failureType === 'cancelledByParent' ? 'cancelled' : 'fail';
    if (['fail','cancelled'].includes(node.status)) node.error = d.details?.error;
    if (node.status === 'skip') node.skipReason = d.skip;
    if (active.get(level) === node) active.delete(level);
  }
  return [...nodes.values()].filter(node => node.status);
}

function chainOf(node) {
  const chain = [];
  for (let current=node; current; current=current.parent) chain.unshift(current.name);
  return chain;
}

export function normalize(events) {
  return tree(events).filter(node => node.children === 0).map(node => {
    const chain = chainOf(node);
    let ids = [], scenarios = [];
    const problems = [];
    const declarations = chain.map(name => {
      let ownIds = [];
      try { ownIds = specIds(name); } catch (error) { problems.push(error.message); }
      if (ownIds.length) ids = ownIds;
      const ownScenarios = [...name.matchAll(/@([a-z-]+):([\w.-]+)/g)].map(x => ({category:x[1],id:x[2]}));
      if (ownScenarios.length) scenarios = ownScenarios;
      return {name,ids:[...ids],scenarios:ownScenarios};
    });
    return {name:chain.join(' > '),file:node.entry,status:node.status,ids,scenarios,declarations,problems,...(node.status === 'skip' && {skipReason:node.skipReason})};
  });
}

// 失敗を 1 回ずつ数える。子の失敗だけで落ちた親（subtestsFailed）は子が説明する。続けて取り消された列は最上位の 1 件で数え、
// それを説明するのは列の直上の取り消されていない祖先だけ（より上の祖先の失敗は、途中の親が子を待たずに終わったことを説明しない）。
// 直上の祖先が載らない pass・subtestsFailed のとき、または親を決められないときは、取り消しそのものが原因なので載せる。
function reported(node) {
  if (node.status === 'fail') return node.error?.failureType !== 'subtestsFailed';
  if (node.status !== 'cancelled' || node.parent?.status === 'cancelled') return false;
  return !(node.parent && reported(node.parent));
}

export function failedTests(events) {
  return tree(events).filter(reported).map(node => ({name:chainOf(node).join(' > '),file:node.file,error:node.error}));
}

function caseStatus(cases) {
  if (cases.every(item => item.status === 'pass')) return 'pass';
  return cases.some(item => item.status === 'missing') ? 'incomplete' : 'skipped';
}

export function evaluate(specs, tests, config, complete = false, executionSuccess = true) {
  const errors = [];
  if (!Object.keys(specs).length) errors.push('No specifications in configured scope');
  if (!executionSuccess) errors.push('Test execution failed, cancelled, or incomplete');
  const ignoredIds = new Set();
  const untraced = [];
  const scopedTests = new Map(Object.keys(specs).map(id => [id,[]]));
  const inScope = id => config.scopePrefixes.some(prefix => id.startsWith(prefix));
  for (const test of tests) {
    if (!config.tracedTestFiles.has(test.file)) {
      if (test.ids.some(inScope)) untraced.push(test.name);
      continue;
    }
    for (const problem of test.problems ?? []) errors.push(`Invalid specification reference (${problem}): ${test.name}`);
    const declarations = [...(test.declarations ?? []),test];
    for (const declaration of declarations) {
      const known = [];
      for (const id of declaration.ids.length ? declaration.ids : test.ids) {
        if (!inScope(id)) { ignoredIds.add(id); continue; }
        if (!specs[id]) { errors.push(`Unknown specification ${id}: ${test.name}`); continue; }
        known.push(id);
      }
      // 実行を複製せずに 1 つのテストを複数の仕様へ結び付けるため、注釈は計画のある ID だけと照合する。
      const planned = known.filter(id => config.scenarios[id]);
      for (const scenario of declaration.scenarios) {
        for (const id of planned.length ? planned : known) {
          const plan = config.scenarios[id]?.[scenario.category];
          if (!categories.includes(scenario.category) || !Array.isArray(plan) || !plan.some(x => x.id === scenario.id)) errors.push(`Unknown scenario ${id}/${scenario.category}:${scenario.id}: ${test.name}`);
        }
      }
    }
    for (const id of test.ids) if (specs[id]) scopedTests.get(id).push(test);
  }
  // 許すのは、ゲートが今返した理由をそのまま理由に含む skip だけ（同じ判定で skip した印になる）。理由の無い skip や別の理由の skip は許さない。
  const reason = config.environmentSkipReason;
  const environmental = test => Boolean(reason) && typeof test.skipReason === 'string' && test.skipReason.includes(reason);
  const results = Object.values(specs).map(spec => {
    const linked = scopedTests.get(spec.id);
    const passed = linked.filter(test => test.status === 'pass');
    const skipped = linked.filter(test => test.status === 'skip');
    const plan = config.scenarios[spec.id];
    const scenarios = Object.fromEntries(categories.map(category => {
      const entry = plan?.[category];
      if (!entry) return [category,{status:'unplanned',cases:[]}];
      if (!Array.isArray(entry)) return [category,{status:'not-applicable',reason:entry.notApplicable,cases:[]}];
      const cases = entry.map(item => {
        const covers = test => test.scenarios.some(s => s.category === category && s.id === item.id);
        const status = passed.some(covers) ? 'pass' : skipped.some(covers) ? 'skipped' : 'missing';
        return {...item,status};
      });
      return [category,{status:caseStatus(cases),cases}];
    }));
    const categoryStates = Object.values(scenarios).map(x => x.status);
    const scenarioStatus = !plan ? 'unplanned' : categoryStates.includes('incomplete') ? 'incomplete' : categoryStates.includes('skipped') ? 'skipped' : 'pass';
    const traceStatus = passed.length ? 'pass' : linked.length && skipped.length === linked.length ? 'skipped' : 'missing';
    const completedRows = spec.rows.filter(row => row.status === TRACE_STATUS.done);
    // 成功した兄弟があっても、環境の判定を通らない skip は未実装を隠す skip と見分けられないので、行とケースの別なく失敗にする。
    const unexplained = skipped.filter(test => !environmental(test));
    if (completedRows.length && traceStatus === 'missing') errors.push(`Completed verification rows lack passing tests: ${spec.id}`);
    if (completedRows.length && unexplained.length) errors.push(`Completed verification rows have skipped tests without the environment gate reason: ${spec.id}: ${unexplained.map(test => test.name).join('; ')}`);
    if (plan && completedRows.length && categoryStates.includes('incomplete')) errors.push(`Completed verification rows lack planned scenarios: ${spec.id}`);
    if (complete && skipped.length) errors.push(`Completion gate rejects skipped tests: ${spec.id}`);
    if (complete && (spec.status !== 'complete' || traceStatus !== 'pass' || scenarioStatus !== 'pass')) errors.push(`Completion gate incomplete: ${spec.id}`);
    return {...spec,tests:linked,passingLeaves:passed.length,skippedLeaves:skipped.length,environmentalSkips:skipped.filter(environmental).length,scenarios,traceStatus,scenarioStatus,
      rows:spec.rows.map(row => ({...row,traceStatus,semanticMatch:'review-required'}))};
  });
  const unverified = results.filter(spec => spec.skippedLeaves).map(spec => ({id:spec.id,skippedLeaves:spec.skippedLeaves,environmentalSkips:spec.environmentalSkips,passingLeaves:spec.passingLeaves,traceStatus:spec.traceStatus,scenarioStatus:spec.scenarioStatus}));
  const planned = results.filter(spec => config.scenarios[spec.id]);
  const cases = planned.flatMap(spec => Object.values(spec.scenarios).flatMap(category => category.cases));
  const summary = {specifications:results.length,specificationsMarkedDone:results.filter(spec => spec.status === 'complete').length,
    planned:planned.length,plannedPassing:planned.filter(spec => spec.scenarioStatus === 'pass').length,
    cases:{total:cases.length,passed:cases.filter(item => item.status === 'pass').length,skipped:cases.filter(item => item.status === 'skipped').length},
    unverified:unverified.length,untracedTests:untraced.length};
  return {specifications:results,errors:[...new Set(errors)],unverified,environmentSkipReason:config.environmentSkipReason ?? null,untracedTests:untraced,summary,ignoredIds:[...ignoredIds].sort(),ignoredIdCount:ignoredIds.size,
    note:'Passing trace proves an ID association; correspondence to each verification row requires review. Skipped tests are unverified, never passing.',
    complete:errors.length === 0 && !unverified.length && results.every(x => x.status === 'complete' && x.traceStatus === 'pass' && x.scenarioStatus === 'pass')};
}
