// cli-contract.md「定数」の値と関係を、scripts/lib/schemas.mjs の名前付きの export で確かめる。
// 期待値は契約の表の値で、関係は表の「関係・理由」の列の式。
import test from 'node:test';
import assert from 'node:assert/strict';

const loadSchemas = () => import('./schemas.mjs');

const VALUES = {
  CALL_MAX_MS: 240000, CALL_MARGIN_MS: 30000, CLEANUP_BUDGET_MS: 30000, START_WAIT_MS: 210000, WAIT_LIMIT_MS: 210000,
  WAIT_POLL_MS: 2000, SALVAGE_RETRY_MS: 10000, SALVAGE_RETRY_MAX: 30, LIVENESS_UNKNOWN_MAX: 30, AGENT_BATCH_MAX: 4,
  AGENT_BATCH_DEADLINE_MS: 1800000, TOOL_TIME_LIMIT_MAX_S: 600, REPORT_RESERVE_MS: 60000, REVISE_ROUNDS_MAX: 2,
  TOOL_OUTPUT_MAX_BYTES: 1048576, MEMORY_SAMPLE_MS: 100,
};
const HOST_LIMIT_MS = 600000; // Claude Code の Bash の上限（契約の表の理由の列）

for (const [name, value] of Object.entries(VALUES)) {
  test(`cli-contract 定数 ${name} は ${value}`, async () => {
    const s = await loadSchemas();
    assert.equal(s[name], value);
  });
}

const RELATIONS = [
  ['CALL_MAX_MS は Bash の上限の半分以下', (c) => c.CALL_MAX_MS * 2 <= HOST_LIMIT_MS],
  ['CALL_MAX_MS + CALL_MARGIN_MS ≤ ホストの上限（司令塔の timeout が取れる）', (c) => c.CALL_MAX_MS + c.CALL_MARGIN_MS <= HOST_LIMIT_MS],
  ['CLEANUP_BUDGET_MS < CALL_MAX_MS', (c) => c.CLEANUP_BUDGET_MS < c.CALL_MAX_MS],
  ['START_WAIT_MS = CALL_MAX_MS − CLEANUP_BUDGET_MS', (c) => c.START_WAIT_MS === c.CALL_MAX_MS - c.CLEANUP_BUDGET_MS],
  ['WAIT_LIMIT_MS = CALL_MAX_MS − CLEANUP_BUDGET_MS', (c) => c.WAIT_LIMIT_MS === c.CALL_MAX_MS - c.CLEANUP_BUDGET_MS],
  ['WAIT_POLL_MS < WAIT_LIMIT_MS', (c) => c.WAIT_POLL_MS < c.WAIT_LIMIT_MS],
  ['WAIT_POLL_MS < CALL_MAX_MS', (c) => c.WAIT_POLL_MS < c.CALL_MAX_MS],
  ['SALVAGE_RETRY_MAX × SALVAGE_RETRY_MS > CALL_MAX_MS', (c) => c.SALVAGE_RETRY_MAX * c.SALVAGE_RETRY_MS > c.CALL_MAX_MS],
  ['TOOL_TIME_LIMIT_MAX_S × 1000 < AGENT_BATCH_DEADLINE_MS', (c) => c.TOOL_TIME_LIMIT_MAX_S * 1000 < c.AGENT_BATCH_DEADLINE_MS],
  ['REPORT_RESERVE_MS < AGENT_BATCH_DEADLINE_MS（担当の batch の期限が正になる）', (c) => c.REPORT_RESERVE_MS < c.AGENT_BATCH_DEADLINE_MS],
  ['正の整数', (c) => Object.keys(VALUES).every((k) => Number.isSafeInteger(c[k]) && c[k] > 0)],
];

test('cli-contract 定数 の関係の検査は、契約の値で全て成り立つ（期待値の自己検査）', () => {
  for (const [name, rel] of RELATIONS) assert.ok(rel(VALUES), name);
});

test('cli-contract 定数 の関係の検査は、関係を壊した値を拒む（負例）', () => {
  const broken = [
    ['CALL_MAX_MS を上限の半分より大きく', { CALL_MAX_MS: 300001 }],
    ['CLEANUP_BUDGET_MS を CALL_MAX_MS 以上に', { CLEANUP_BUDGET_MS: 240000 }],
    ['START_WAIT_MS をずらす', { START_WAIT_MS: 210001 }],
    ['WAIT_POLL_MS を WAIT_LIMIT_MS 以上に', { WAIT_POLL_MS: 210000 }],
    ['SALVAGE_RETRY_MAX を減らす', { SALVAGE_RETRY_MAX: 24 }],
    ['TOOL_TIME_LIMIT_MAX_S を増やす', { TOOL_TIME_LIMIT_MAX_S: 1800 }],
  ];
  for (const [name, over] of broken) assert.ok(RELATIONS.some(([, rel]) => !rel({ ...VALUES, ...over })), name);
});

for (const [name, rel] of RELATIONS) {
  test(`cli-contract 定数 の関係: ${name}`, async () => {
    const s = await loadSchemas();
    assert.ok(rel(s), name);
  });
}
