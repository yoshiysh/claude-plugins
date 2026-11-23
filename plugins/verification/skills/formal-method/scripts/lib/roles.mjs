// 役ごとの model・effort・指示ファイルの正本（architecture.md「担当の起動」の起動の理由）。
// 作成役は上位のモデルの中程度の effort、確認役（原因の分類役を含む）は作成役と別のモデルで effort を上げる（作る役と確かめる役を分ける）。
// 原因の分類役は、反例と対応できていない組を作成役の成果物（モデル・分類）の欠陥かを含めて分けるので、作成役を確かめる役に数える。
const AUTHOR = Object.freeze({ model: 'opus', effort: 'medium' });
const CONFIRMER = Object.freeze({ model: 'sonnet', effort: 'high' });

const role = (base, instructions) => Object.freeze({ ...base, instructions });

// 作る役（AUTHOR の組）と確かめる役（CONFIRMER の組）。roles.test.mjs が、両者の model が違うことを照らす
export const AUTHOR_ROLES = Object.freeze(['extractor', 'model-author', 'partition-author', 'plan-author']);
export const CONFIRMER_ROLES = Object.freeze(['extraction-reviewer', 'fidelity-reviewer', 'assurance-reviewer', 'composition-reviewer', 'cause-analyst']);

export const ROLES = Object.freeze({
  extractor: role(AUTHOR, 'agents/extractor.md'),
  'model-author': role(AUTHOR, 'agents/model-author.md'),
  'partition-author': role(AUTHOR, 'agents/partition-author.md'),
  'plan-author': role(AUTHOR, 'agents/plan-author.md'),
  'extraction-reviewer': role(CONFIRMER, 'agents/extraction-reviewer.md'),
  'fidelity-reviewer': role(CONFIRMER, 'agents/fidelity-reviewer.md'),
  'assurance-reviewer': role(CONFIRMER, 'agents/assurance-reviewer.md'),
  'composition-reviewer': role(CONFIRMER, 'agents/composition-reviewer.md'),
  'cause-analyst': role(CONFIRMER, 'agents/cause-analyst.md'),
});

// 担当に与える権限。Workflow script（plugin の workflows/formal-method-agents.js。置き場は agents.mjs の WORKFLOW_SCRIPT）の meta.requirements と同じ値（roles.test.mjs が照らす）。
export const AGENT_PERMISSIONS = Object.freeze(['fresh-thread', 'workspace-write']);

// 担当の義務の正本は references/agent-obligations.md。担当には、作る役と確かめる役の分ごとに生成したファイル（scripts/role-references.mjs）だけを
// 渡す。型の抜粋も同じ script が references/artifact-formats.md から役ごとに作る（role-references.test.mjs が正本との一致を照らす）
export const OBLIGATIONS_SOURCE = 'references/agent-obligations.md';
export const OBLIGATION_FILES = Object.freeze({ author: 'references/obligations/author.md', confirmer: 'references/obligations/confirmer.md' });
export const TYPES_DIR = 'references/types';
export const obligationClassOf = (name) => (AUTHOR_ROLES.includes(name) ? 'author' : 'confirmer');
// task の instructions のうち skill の中の 3 つ（skill の根からの相対 path）: 役の指示、その役の分の義務、その役の型の抜粋。4 つ目の文書の一般規約は run の領域の写しで、agents.mjs の makeTask が足す
export const instructionsOf = (name) => [roleOf(name).instructions, OBLIGATION_FILES[obligationClassOf(name)], `${TYPES_DIR}/${name}.md`];

export function roleOf(name) {
  if (!Object.prototype.hasOwnProperty.call(ROLES, name)) throw new Error(`未知の役: ${name}`);
  return ROLES[name];
}
