import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const repo = new URL('../../../../../../', import.meta.url);
// Cross-plugin documentation checks require the source repository, not an installed plugin subtree.
const repositoryPresent = await access(new URL('.claude-plugin/marketplace.json', repo)).then(() => true, () => false);
const callers = [
  'research/skills/search', 'research/skills/dispatch',
  'skill-creator/skills/skill-creator-best-practices',
  'workflow/skills/pdca', 'workflow/skills/prd-spec', 'workflow/skills/review-document',
];

test('active callers route absent native Workflow to JavaScript runtime without legacy classification gates', { skip: !repositoryPresent }, async () => {
  for (const caller of callers) {
    const body = await readFile(new URL(`plugins/${caller}/SKILL.md`, repo), 'utf8');
    assert.match(body, /workflow:dynamic-workflow-runner/, caller);
    assert.match(body, /JavaScript runtime/, caller);
    assert.doesNotMatch(body, /rejected_source_v1|portable_v1|runner v1|Codex v1/, caller);
    assert.doesNotMatch(body, /call receipt|translator|verified return/, caller);
    assert.match(body, /native.*(?:試行後|試行済み)/, caller);
  }
});

test('active entry docs do not impose legacy caller bans or receipt prerequisites', { skip: !repositoryPresent }, async () => {
  const paths = ['AGENTS.md', 'CLAUDE.md', 'plugins/research/README.md',
    'plugins/skill-creator/README.md', 'plugins/workflow/README.md',
    'plugins/workflow/skills/dynamic-workflow-runner/SKILL.md',
    'plugins/skill-creator/skills/skill-creator-best-practices/references/codex-workflow-compatibility.md',
    'plugins/skill-creator/skills/skill-creator-best-practices/references/orchestrator-review.md',
    'plugins/skill-creator/skills/skill-creator-best-practices/references/orchestrator-output.md'];
  for (const path of paths) {
    const body = await readFile(new URL(path, repo), 'utf8');
    assert.doesNotMatch(body, /rejected_source_v1|portable_v1|runner v1|Codex v1|workflow_complete|verified return receipt|移行前は自動切替しない/, path);
  }
});
