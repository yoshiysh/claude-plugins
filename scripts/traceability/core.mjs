import { categories, idPattern } from './specs.mjs';

export function normalize(events) {
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
      node = {key,parent,name:d.name,file:d.file,nesting:d.nesting,children:0};
      nodes.set(key,node);
      if (parent) parent.children++;
    }
    if (event.type === 'test:start') {
      active.set(level,node);
      continue;
    }
    if (event.type === 'test:enqueue') continue;
    node.status = d.skip ? 'skip' : d.todo ? 'todo' : event.type === 'test:pass' ? 'pass' : d.details?.error?.failureType === 'cancelledByParent' ? 'cancelled' : 'fail';
    if (active.get(level) === node) active.delete(level);
  }
  return [...nodes.values()].filter(node => node.status && node.children === 0).map(node => {
    const chain = [];
    for (let current=node; current; current=current.parent) chain.unshift(current.name);
    let ids = [], scenarios = [];
    const declarations = chain.map(name => {
      const ownIds = name.match(idPattern);
      if (ownIds) ids = [...new Set(ownIds)];
      const ownScenarios = [...name.matchAll(/@([a-z-]+):([\w.-]+)/g)].map(x => ({category:x[1],id:x[2]}));
      if (ownScenarios.length) scenarios = ownScenarios;
      return {name,ids:[...ids],scenarios:ownScenarios};
    });
    return {name:chain.join(' > '),file:node.file,status:node.status,ids,scenarios,declarations};
  });
}

export function evaluate(specs, tests, config, complete = false, executionSuccess = true) {
  const errors = [];
  if (!Object.keys(specs).length) errors.push('No specifications in configured scope');
  if (!executionSuccess) errors.push('Test execution failed, cancelled, or incomplete');
  const ignoredIds = new Set();
  const scopedTests = new Map(Object.keys(specs).map(id => [id,[]]));
  for (const test of tests) {
    const declarations = [...(test.declarations ?? []),test];
    for (const declaration of declarations) {
      const ids = declaration.ids.length ? declaration.ids : test.ids;
      for (const id of ids) {
        if (!config.scopePrefixes.some(prefix => id.startsWith(prefix))) { ignoredIds.add(id); continue; }
        if (!specs[id]) { errors.push(`Unknown specification ${id}: ${test.name}`); continue; }
        for (const scenario of declaration.scenarios) {
          const plan = config.scenarios[id]?.[scenario.category];
          if (!categories.includes(scenario.category) || !Array.isArray(plan) || !plan.some(x => x.id === scenario.id)) errors.push(`Unknown scenario ${id}/${scenario.category}:${scenario.id}: ${test.name}`);
        }
      }
    }
    for (const id of test.ids) if (specs[id]) scopedTests.get(id).push(test);
  }
  const results = Object.values(specs).map(spec => {
    const linked = scopedTests.get(spec.id);
    const passed = linked.filter(test => test.status === 'pass');
    const plan = config.scenarios[spec.id];
    const scenarios = Object.fromEntries(categories.map(category => {
      const entry = plan?.[category];
      if (!entry) return [category,{status:'unplanned',cases:[]}];
      if (!Array.isArray(entry)) return [category,{status:'not-applicable',reason:entry.notApplicable,cases:[]}];
      const cases = entry.map(item => ({...item,passed:passed.some(test => test.scenarios.some(s => s.category === category && s.id === item.id))}));
      return [category,{status:cases.every(item => item.passed) ? 'pass':'incomplete',cases}];
    }));
    const completedRows = spec.rows.filter(row => row.status === '完了');
    if (completedRows.length && !passed.length) errors.push(`Completed verification rows lack passing tests: ${spec.id}`);
    const scenarioIncomplete = Object.values(scenarios).some(x => !['pass','not-applicable'].includes(x.status));
    if (plan && completedRows.length && scenarioIncomplete) errors.push(`Completed verification rows lack planned scenarios: ${spec.id}`);
    if (complete && (spec.status !== 'complete' || !passed.length || scenarioIncomplete)) errors.push(`Completion gate incomplete: ${spec.id}`);
    return {...spec,tests:linked,passingLeaves:passed.length,scenarios,traceStatus:passed.length ? 'pass':'unverified',scenarioStatus:scenarioIncomplete ? 'incomplete':'pass',
      rows:spec.rows.map(row => ({...row,traceStatus:passed.length ? 'passing-trace-present':'unverified',semanticMatch:'review-required'}))};
  });
  return {specifications:results,errors:[...new Set(errors)],ignoredIds:[...ignoredIds].sort(),ignoredIdCount:ignoredIds.size,
    note:'Passing trace proves an ID association; correspondence to each verification row requires review.',
    complete:errors.length === 0 && results.every(x => x.status === 'complete' && x.traceStatus === 'pass' && x.scenarioStatus === 'pass')};
}
