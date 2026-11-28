// 分割の決定的な欄（#264 SP-264-023）: 分割作成役の下書き（PartitionsDraft）と partition-assemble の出力から組み立てた PartitionsFile に、
// 今の partitionCheck が欠陥を出さないことを、start から terminal までの結合で確かめる（分割作成役に修正の巡が出ず、分割を採る）。
// 担当に辺を先に見せること（context.candidates[].edges）と、下書きの欠け・余りが今の境界の欠陥になることも確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runScenario } from '../../test-fixtures/pipeline.mjs';
import { resultInvariants } from '../../test-fixtures/result-schema.mjs';
import { PART_SCENARIO, tasksOf, assertRevised, prop } from '../../test-fixtures/pipeline-cases.mjs';
import { partitionFixture } from '../../test-fixtures/partition.mjs';
import { M1 } from '../../test-fixtures/core-ids.mjs';

const ledgerOf = (status) => JSON.parse(readFileSync(join(status.run_dir, 'ledger.json'), 'utf8'));
const revisionKeys = (status) => ledgerOf(status).revisions.flatMap((r) => r.defects.map((d) => d.key));
const A = `var:${M1}/a`;
const TB = `tr:${M1}/tb`;

test('SP-264-023: 分割作成役の task の候補は他の候補への辺（edge_id・to_candidate・producer_candidate・consumer_candidate・shared_symbols）を持つ', async (t) => {
  const { harness } = await runScenario(t, { scenario: PART_SCENARIO() });
  const [task] = tasksOf(harness, 'partition-author');
  const cands = task.context.candidates;
  const candOf = (node) => cands.find((c) => c.nodes.includes(node)).id;
  const edges = cands.flatMap((c) => c.edges.map((e) => ({ from_candidate: c.id, ...e })));
  for (const e of edges) assert.deepEqual(Object.keys(e).filter((k) => k !== 'from_candidate').sort(), ['consumer_candidate', 'edge_id', 'producer_candidate', 'shared_symbols', 'to_candidate']);
  // tb は a を読む（辺は from が to に依る向き）: producer は a の候補、consumer は tb の候補、共有する記号は a
  const e = edges.find((x) => x.edge_id === `read:${TB}->${A}`);
  assert.ok(e, JSON.stringify(edges));
  assert.deepEqual([e.producer_candidate, e.consumer_candidate, e.shared_symbols], [candOf(A), candOf(TB), ['a']]);
});

test('SP-264-023: 下書きから組み立てた PartitionsFile は今の partitionCheck を通り（分割作成役の修正の巡が出ない）、adopted・parts・境界の producer・consumer・shared_symbols を CLI が決める', async (t) => {
  const { result, harness, status } = await runScenario(t, { scenario: PART_SCENARIO() });
  assert.deepEqual(resultInvariants(result), []);
  const [task] = tasksOf(harness, 'partition-author');
  assert.equal(harness.memory.submits.filter((x) => x.task_id === task.task_id).length, 1, '欠陥が無いので 1 回の提出で閉じる');
  const draft = JSON.parse(readFileSync(join(task.attempt_dir, 'partitions.json'), 'utf8'));
  assert.equal(draft.schema, 'formal-method.partitions-draft/1');
  for (const k of ['adopted', 'parts']) assert.ok(!(k in draft), `担当は ${k} を書かない`);
  for (const b of draft.boundaries) for (const k of ['producer', 'consumer', 'shared_symbols']) assert.ok(!(k in b), `担当は境界の ${k} を書かない`);
  const ref = `assembled/${task.task_id}/partitions.json`;
  assert.ok(existsSync(join(status.run_dir, ref)), ref);
  assert.ok(ledgerOf(status).entries.some((e) => e.kind === 'partitions' && e.ref === ref && e.producer === task.task_id), '台帳に組み立てた分割');
  const d = result.decomposition;
  assert.equal(d.adopted, true, d.reason);
  const candOf = (node) => d.candidates.find((c) => c.nodes.includes(node)).id;
  assert.deepEqual(d.parts.map((p) => p.id).sort(), [candOf(A), candOf(TB)].sort(), '部分の id は採った候補の id');
  for (const p of d.parts) {
    assert.equal(p.model_id, M1);
    assert.deepEqual(p.owns_variables, [...p.owns_variables].sort());
    assert.ok([...p.owns_variables, ...p.transitions].every((n) => d.candidates.find((c) => c.id === p.id).nodes.includes(n)), '部分は候補の節点だけを持つ');
  }
  const b = d.boundaries.find((x) => x.edge_id === `read:${TB}->${A}`);
  assert.deepEqual([b.producer, b.consumer, b.shared_symbols], [candOf(A), candOf(TB), ['a']]);
  assert.deepEqual(prop(result, 'P1').verdict, ['検証済み']);
});

test('SP-264-023: 下書きの境界が跨ぐ辺に欠ければ boundary-missing、跨がない辺を指せば boundary-edge の欠陥で、分割作成役に修正の巡が出る', async (t) => {
  for (const [name, key, edit] of [
    ['欠け', 'boundary-missing', (base) => ({ ...base, boundaries: [] })],
    ['余り', 'boundary-edge', (base) => ({ ...base, boundaries: [...base.boundaries, { ...base.boundaries[0], edge_id: 'read:no-such-edge' }] })],
  ]) {
    const partition = (cands, put, ctx) => { const base = partitionFixture({ basis: 'guarantee', conds: ['CC1', 'CC2'] })(cands, put, ctx); return ctx.round === 1 ? edit(base) : base; };
    const { result, harness, status } = await runScenario(t, { scenario: PART_SCENARIO({ partition }) });
    assert.deepEqual(resultInvariants(result), [], name);
    assertRevised(harness, 'partition-author', '計画');
    assert.ok(revisionKeys(status).some((k) => k.startsWith(key)), `${name}: ${revisionKeys(status).join()}`);
    assert.equal(result.decomposition.adopted, true, `${name}: 直した分割を採る`);
  }
});

test('SP-264-023: 候補を 1 つも採らない下書きでは adopted は false で、部分も境界も無い', async (t) => {
  const { result } = await runScenario(t, { scenario: PART_SCENARIO({ partition: null }) });
  assert.deepEqual(resultInvariants(result), []);
  const d = result.decomposition;
  assert.equal(d.adopted, false);
  assert.deepEqual([d.parts, d.boundaries], [[], []]);
  assert.ok(d.decisions.every((x) => x.adopted === false));
});
