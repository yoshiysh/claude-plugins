// cli-contract.md「定数」の値と関係を、scripts/lib/schemas.mjs の名前付きの export で確かめる。
// 期待値は契約の表の値で、関係は表の「関係・理由」の列の式。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const loadSchemas = () => import('./schemas.mjs');

const VALUES = {
  CALL_MAX_MS: 240000, CALL_MARGIN_MS: 30000, CLEANUP_BUDGET_MS: 30000, START_WAIT_MS: 210000, WAIT_LIMIT_MS: 210000,
  WAIT_POLL_MS: 2000, SALVAGE_RETRY_MS: 10000, SALVAGE_RETRY_MAX: 30, LIVENESS_UNKNOWN_MAX: 30,
  AGENT_BATCH_DEADLINE_MS: 1800000, TOOL_TIME_LIMIT_MAX_S: 600, REPORT_RESERVE_MS: 60000, REVISE_ROUNDS_MAX: 2,
  TOOL_OUTPUT_MAX_BYTES: 1048576, MEMORY_SAMPLE_MS: 100, START_STOP_WAIT_MS: 5000, ABLATION_PER_PROPERTY_MAX: 12,
  WORKER_CALL_MAX_MS: 60000, UNIT_MAX_BYTES: 120000,
};
// 1 つの呼び出しで起動する体の数の上限は持たない（architecture.md「担当の起動」。同時実行の上限を超える分は runtime が待たせる）
test('cli-contract 定数 AGENT_BATCH_MAX は無い（1 つの段の担当は 1 回の呼び出しで起動する）', async () => {
  const s = await loadSchemas();
  assert.equal('AGENT_BATCH_MAX' in s, false);
});
const WORKER_BASH_TIMEOUT_MS = 120000; // 担当の Bash の既定の timeout（契約の表の理由の列）
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
  ['START_STOP_WAIT_MS < CLEANUP_BUDGET_MS（起動の手順 5-3 で止めた子を待っても後始末の時間に収まる）', (c) => c.START_STOP_WAIT_MS < c.CLEANUP_BUDGET_MS],
  ['START_WAIT_MS = CALL_MAX_MS − CLEANUP_BUDGET_MS', (c) => c.START_WAIT_MS === c.CALL_MAX_MS - c.CLEANUP_BUDGET_MS],
  ['WAIT_LIMIT_MS = CALL_MAX_MS − CLEANUP_BUDGET_MS', (c) => c.WAIT_LIMIT_MS === c.CALL_MAX_MS - c.CLEANUP_BUDGET_MS],
  ['WAIT_POLL_MS < WAIT_LIMIT_MS', (c) => c.WAIT_POLL_MS < c.WAIT_LIMIT_MS],
  ['WAIT_POLL_MS < CALL_MAX_MS', (c) => c.WAIT_POLL_MS < c.CALL_MAX_MS],
  ['SALVAGE_RETRY_MAX × SALVAGE_RETRY_MS > CALL_MAX_MS', (c) => c.SALVAGE_RETRY_MAX * c.SALVAGE_RETRY_MS > c.CALL_MAX_MS],
  ['TOOL_TIME_LIMIT_MAX_S × 1000 < AGENT_BATCH_DEADLINE_MS', (c) => c.TOOL_TIME_LIMIT_MAX_S * 1000 < c.AGENT_BATCH_DEADLINE_MS],
  ['REPORT_RESERVE_MS < AGENT_BATCH_DEADLINE_MS（担当の batch の期限が正になる）', (c) => c.REPORT_RESERVE_MS < c.AGENT_BATCH_DEADLINE_MS],
  ['ABLATION_PER_PROPERTY_MAX > 3（否定だけ・前提と否定だけ・規則と否定だけの 3 つの後に、前提を外す再検査の余地がある）', (c) => c.ABLATION_PER_PROPERTY_MAX > 3],
  ['WORKER_CALL_MAX_MS < CALL_MAX_MS − CLEANUP_BUDGET_MS（担当のコマンドも前景の 1 回の呼出しの上限に収まる）', (c) => c.WORKER_CALL_MAX_MS < c.CALL_MAX_MS - c.CLEANUP_BUDGET_MS],
  ['WORKER_CALL_MAX_MS × 2 ≤ 担当の Bash の既定の timeout（命令が殺される前に no_response を返す）', (c) => c.WORKER_CALL_MAX_MS * 2 <= WORKER_BASH_TIMEOUT_MS],
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
    ['START_STOP_WAIT_MS を CLEANUP_BUDGET_MS 以上に', { START_STOP_WAIT_MS: 30000 }],
    ['WORKER_CALL_MAX_MS を担当の Bash の timeout の半分より大きく', { WORKER_CALL_MAX_MS: 90000 }],
  ];
  for (const [name, over] of broken) assert.ok(RELATIONS.some(([, rel]) => !rel({ ...VALUES, ...over })), name);
});

for (const [name, rel] of RELATIONS) {
  test(`cli-contract 定数 の関係: ${name}`, async () => {
    const s = await loadSchemas();
    assert.ok(rel(s), name);
  });
}

// ---- 列挙の正本は core.schema.json（#264 SP-264-003）。schemas.mjs は実行時に schema を読んで作り、値を書き写さない ----
const SKILL_DIR = new URL('../../', import.meta.url);
const coreSchema = () => JSON.parse(readFileSync(new URL('references/core.schema.json', SKILL_DIR), 'utf8'));
// schemas.mjs の export の名前 → core.schema.json の $defs の列挙の名前
const ENUMS = { STAGES: 'Stage', CONFIRMATION_RESULTS: 'ConfirmationResult', ASSUMPTION_BASIS_KINDS: 'AssumptionBasisKind', RELATIONS: 'MappingRelation' };

for (const [name, def] of Object.entries(ENUMS)) {
  test(`SP-264-003: schemas.mjs の ${name} は core.schema.json の $defs/${def} の値と同じ`, async () => {
    const s = await loadSchemas();
    const e = coreSchema().$defs[def]?.enum;
    assert.ok(Array.isArray(e) && e.length > 0, `$defs/${def}.enum が無い`);
    assert.deepEqual([...s[name]], e);
  });
}

test('SP-264-003: schemas.mjs の本文に 4 つの列挙の値の文字列が無い（schema から読む）', () => {
  const src = readFileSync(new URL('./schemas.mjs', import.meta.url), 'utf8');
  const defs = coreSchema().$defs;
  const hits = [];
  for (const def of Object.values(ENUMS)) {
    for (const v of defs[def].enum) {
      const n = [...src.matchAll(/(['"`])([^'"`\n]*?)\1/g)].filter((x) => x[2] === v).length;
      // 形式検証でない確認 は対応表の relation の値であると同時に、別の列挙（性質の判定の kind。Verdict）の値でもある。後者は 1 つまで許す
      const allowed = v === '形式検証でない確認' ? 1 : 0;
      if (n > allowed) hits.push(`${def}: '${v}' が ${n} 個`);
    }
  }
  assert.deepEqual(hits, []);
});

test('SP-264-003: cli-contract.md の「実行体」の節は core.schema.json へのリンクを持ち、```text の型の塊を持たない', (t) => {
  const doc = readFileSync(new URL('references/cli-contract.md', SKILL_DIR), 'utf8');
  const m = doc.match(/^## 実行体\s*$([\s\S]*?)(?=^## )/m) ?? doc.match(/^## 実行体\s*$([\s\S]*)$/m);
  // 節は文書を合わせる単位（U6）で置く。U6 の前（plugin の版が 0.1.1 のまま）だけ節の無いことを許す。
  // U6 の後は節を要る。版を上げ忘れたまま節も無いことは core-wiring.test.mjs の「U6 の印は揃って現れる」が他の印（SKILL.md の install の行）で捉える
  const version = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', SKILL_DIR), 'utf8')).version;
  if (!m && version === '0.1.1') { t.skip('cli-contract.md に「実行体」の節がまだ無い（U6 の前）'); return; }
  assert.ok(m, `plugin の版が ${version} なのに cli-contract.md に「## 実行体」の節が無い`);
  assert.match(m[1], /\]\(\.?\/?core\.schema\.json(#[^)]*)?\)/, '節に core.schema.json へのリンクが無い');
  assert.ok(!/```text/.test(m[1]), '節に ```text の型の塊がある（型は core.schema.json にだけ書く）');
});
