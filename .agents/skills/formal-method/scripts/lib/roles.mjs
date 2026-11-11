// 役ごとの model・effort・指示ファイルの正本（architecture.md「担当の起動」）。
// 照合が主の役は中位のモデル、意味の判断が重い役は上位のモデルにする。
const UPPER = 'opus';
const MIDDLE = 'sonnet';

export const ROLES = Object.freeze({
  extractor: Object.freeze({ model: UPPER, effort: 'high', instructions: 'agents/extractor.md' }),
  'model-author': Object.freeze({ model: UPPER, effort: 'high', instructions: 'agents/model-author.md' }),
  'partition-author': Object.freeze({ model: UPPER, effort: 'high', instructions: 'agents/partition-author.md' }),
  'plan-author': Object.freeze({ model: UPPER, effort: 'high', instructions: 'agents/plan-author.md' }),
  'extraction-reviewer': Object.freeze({ model: MIDDLE, effort: 'medium', instructions: 'agents/extraction-reviewer.md' }),
  'fidelity-reviewer': Object.freeze({ model: UPPER, effort: 'high', instructions: 'agents/fidelity-reviewer.md' }),
  'assurance-reviewer': Object.freeze({ model: UPPER, effort: 'high', instructions: 'agents/assurance-reviewer.md' }),
  'composition-reviewer': Object.freeze({ model: MIDDLE, effort: 'medium', instructions: 'agents/composition-reviewer.md' }),
  'cause-analyst': Object.freeze({ model: UPPER, effort: 'high', instructions: 'agents/cause-analyst.md' }),
});

// 担当に与える権限。Workflow script（scripts/formal-method-agents.js）の meta.requirements と同じ値（roles.test.mjs が照らす）。
export const AGENT_PERMISSIONS = Object.freeze(['fresh-thread', 'workspace-write']);

export const OBLIGATIONS = 'references/agent-obligations.md';

export function roleOf(name) {
  if (!Object.prototype.hasOwnProperty.call(ROLES, name)) throw new Error(`未知の役: ${name}`);
  return ROLES[name];
}
