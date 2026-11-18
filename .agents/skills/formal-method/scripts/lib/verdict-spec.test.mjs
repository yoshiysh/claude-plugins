// scripts/lib/verdict.mjs の判定の 3 関数の unit。期待値は仕様 SP-FORMALMETHOD-011・015 と
// artifact-formats.md「判定の 3 関数」から決める（test-fixtures/spec-verdict.mjs の独立の導出と、表に書いた値）。
// オラクルとの照合は tests/formal/formal-method-skill/verdict-oracle.test.mjs が持つ。
import test from 'node:test';
import assert from 'node:assert/strict';
import { specAggregate, specDecide, globalFrom, DEFAULT_FACTS, DEFAULT_GLOBAL, UNMET_ORDER, VERDICTS } from '../test-fixtures/spec-verdict.mjs';

const loadVerdict = () => import('./verdict.mjs');
const facts = (over) => ({ ...DEFAULT_FACTS, ...over });

// aggregateProperty: 段ごとの正常・境界と、段の境目。
const AGG_CASES = [
  // [名前, 入力の差分, 期待]
  ['段1 成功以外の値を全て、重複なく Verdict の順で返す', { check_verdicts: ['実行失敗', '成功', '反例', '実行失敗', '未実行'] }, ['反例', '未実行', '実行失敗']],
  ['段1 反例があっても他の成功でない値を落とさない', { check_verdicts: ['反例', '時間切れ', 'unknown'] }, ['反例', 'unknown', '時間切れ']],
  ['段1 形式化できない性質でも成功でない検査の値を返す', { formalizable: false, alternative_confirmed: true, check_verdicts: ['unknown'] }, ['unknown']],
  ['段1 問いに依存しても成功でない検査の値を返す', { depends_on_question: true, check_verdicts: ['未実行'] }, ['未実行']],
  ['段2 全ての条件が成り立てば検証済みだけ', { check_verdicts: ['成功', '成功'] }, ['検証済み']],
  ['段2 問いに依存すれば未確認', { check_verdicts: ['成功'], depends_on_question: true }, ['未確認']],
  ['段2 対応が無ければ未確認', { check_verdicts: ['成功'], correspondence: false }, ['未確認']],
  ['段2 意味の確認が無ければ未確認', { check_verdicts: ['成功'], meaning_confirmed: false }, ['未確認']],
  ['段2 決定的な検査が成り立たなければ未確認', { check_verdicts: ['成功'], deterministic_confirmed: false }, ['未確認']],
  ['段2 合成を適用し合成の条件が成り立たなければ未確認', { check_verdicts: ['成功'], composition_applies: true, composition_confirmed: false }, ['未確認']],
  ['段2 合成を適用し合成の条件が成り立てば検証済み', { check_verdicts: ['成功'], composition_applies: true, composition_confirmed: true }, ['検証済み']],
  ['段2 合成を適用しなければ composition_confirmed を見ない', { check_verdicts: ['成功'], composition_applies: false, composition_confirmed: false }, ['検証済み']],
  ['段2 検出を行い検出しなければ未確認', { check_verdicts: ['成功'], detection_performed: true, detection_confirmed: false }, ['未確認']],
  ['段2 検出を行い検出すれば検証済み', { check_verdicts: ['成功'], detection_performed: true, detection_confirmed: true }, ['検証済み']],
  ['段2 検出を行わなければ detection_confirmed を見ない', { check_verdicts: ['成功'], detection_performed: false, detection_confirmed: false }, ['検証済み']],
  ['段3 形式化できず別の方法の確認が成り立てば別手段で確認済み', { formalizable: false, alternative_confirmed: true }, ['別手段で確認済み']],
  ['段3 形式化できず別の方法の確認が無ければ未確認', { formalizable: false, alternative_confirmed: false }, ['未確認']],
  ['段3 形式化できず問いに依存すれば未確認', { formalizable: false, alternative_confirmed: true, depends_on_question: true }, ['未確認']],
  ['段3 形式化できない性質に道具が無くても未実行にしない', { formalizable: false, alternative_confirmed: true, no_suitable_tool: true }, ['別手段で確認済み']],
  ['段3 形式化できず成功した検査だけがあり別の方法の確認が無ければ未確認', { formalizable: false, check_verdicts: ['成功'] }, ['未確認']],
  ['段4 検査が 0 件で道具が無ければ未実行', { no_suitable_tool: true }, ['未実行']],
  ['段4 道具が無く対応も無くても未実行', { no_suitable_tool: true, correspondence: false }, ['未実行']],
  ['段5 検査が 0 件で道具はあるなら未確認（検査 0 件の性質に未実行を付けない）', {}, ['未確認']],
  ['段5 検査が 0 件で対応が無ければ未確認', { correspondence: false }, ['未確認']],
];

test('SP-FORMALMETHOD-011 AC-09・AC-14: 表の期待値は仕様からの独立の導出と一致する（期待値の自己検査）', () => {
  for (const [name, over, expected] of AGG_CASES) assert.deepEqual(specAggregate(facts(over)), expected, name);
});

for (const [name, over, expected] of AGG_CASES) {
  test(`SP-FORMALMETHOD-011 AC-09・AC-14 aggregateProperty ${name}`, async () => {
    const { aggregateProperty } = await loadVerdict();
    const input = facts(over);
    const before = structuredClone(input);
    const out = aggregateProperty(input);
    assert.deepEqual(out, expected);
    assert.deepEqual(input, before, '入力を変えない');
    assert.ok(out.length >= 1, '集合は 1 つ以上');
    assert.equal(new Set(out).size, out.length, '重複なし');
    assert.deepEqual([...out].sort((a, b) => VERDICTS.indexOf(a) - VERDICTS.indexOf(b)), out, 'Verdict の順');
    if (out.includes('検証済み') || out.includes('別手段で確認済み')) assert.equal(out.length, 1, '成功の値は単独');
  });
}

test('SP-FORMALMETHOD-011 AC-09: aggregateProperty は成功の値を他の値と同じ集合に入れない（全ての CheckVerdict の 2 個までの列）', async () => {
  const { aggregateProperty } = await loadVerdict();
  const cvs = ['成功', '反例', '未実行', 'unknown', '時間切れ', '実行失敗'];
  const lists = [[], ...cvs.map((a) => [a]), ...cvs.flatMap((a) => cvs.map((b) => [a, b]))];
  for (const list of lists) {
    for (const formalizable of [true, false]) {
      const f = facts({ check_verdicts: list, formalizable, alternative_confirmed: true });
      assert.deepEqual(aggregateProperty(structuredClone(f)), specAggregate(f), JSON.stringify(list) + formalizable);
    }
  }
});

// decideStatus: 9 つの述語を 1 つずつ崩す（AC-14 の「1 つずつ残す」）。
const ONE_BY_ONE = [
  ['未対応（成功でない判定 未確認 が残る）', globalFrom([['未確認']]), ['必要な性質が検証の成功でない']],
  ['未実行が残る', globalFrom([['未実行']]), ['必要な性質が検証の成功でない', '実行できない検査']],
  ['unknown が残る', globalFrom([['unknown']]), ['必要な性質が検証の成功でない']],
  ['時間切れが残る', globalFrom([['時間切れ']]), ['必要な性質が検証の成功でない']],
  ['実行失敗が残る', globalFrom([['実行失敗']]), ['必要な性質が検証の成功でない', '実行できない検査']],
  ['反例が残る', globalFrom([['反例']]), ['必要な性質が検証の成功でない', '反例']],
  ['確認が終わっていない', globalFrom([['検証済み']], { confirmations_unresolved: true }), ['確認が終わっていない']],
  ['対応できていない組合せが 1 つ', globalFrom([['検証済み']], { uncovered_combinations: 1 }), ['対応できていない組合せ']],
  ['回答を待つ問いが 1 つ', globalFrom([['検証済み']], { pending_questions: 1 }), ['回答を待つ問い']],
  ['未保存の記録がある', globalFrom([['検証済み']], { all_records_saved: false }), ['記録の未保存']],
  ['必要な性質が 0 件', globalFrom([]), ['必要な性質が 0 件']],
  ['検出能力未確認が 1 つ', globalFrom([['検証済み']], { detection_unconfirmed: 1 }), ['検出能力未確認']],
];

test('SP-FORMALMETHOD-015 AC-14: 1 つずつ崩した表の期待値は仕様からの導出と一致する（期待値の自己検査）', () => {
  for (const [name, g, unmet] of ONE_BY_ONE) assert.deepEqual(specDecide(g), { status: '停止', unmet }, name);
  assert.deepEqual(specDecide(DEFAULT_GLOBAL), { status: '完了', unmet: [] });
});

for (const [name, g, unmet] of ONE_BY_ONE) {
  test(`SP-FORMALMETHOD-015 AC-14 decideStatus ${name} は停止で、崩した述語が unmet に入る`, async () => {
    const { decideStatus } = await loadVerdict();
    assert.deepEqual(decideStatus(structuredClone(g)), { status: '停止', unmet });
  });
}

test('SP-FORMALMETHOD-015 AC-14 decideStatus 全てが成り立つときだけ完了し unmet は空', async () => {
  const { decideStatus } = await loadVerdict();
  assert.deepEqual(decideStatus(structuredClone(DEFAULT_GLOBAL)), { status: '完了', unmet: [] });
  assert.deepEqual(decideStatus(globalFrom([['検証済み'], ['別手段で確認済み']])), { status: '完了', unmet: [] });
});

test('SP-FORMALMETHOD-015 AC-14 decideStatus 成り立たない述語は全て unmet に、決めた順で入る', async () => {
  const { decideStatus } = await loadVerdict();
  const g = globalFrom([['反例', '実行失敗'], ['検証済み']], {
    confirmations_unresolved: true, uncovered_combinations: 2, pending_questions: 3, all_records_saved: false, detection_unconfirmed: 1,
  });
  const expected = UNMET_ORDER.filter((c) => c !== '必要な性質が 0 件');
  assert.deepEqual(specDecide(g).unmet, expected);
  assert.deepEqual(decideStatus(structuredClone(g)), { status: '停止', unmet: expected });
});

test('SP-FORMALMETHOD-015 AC-14 decideStatus 境界: 検証済みと他の値が同じ集合にある入力も成功に数えない', async () => {
  const { decideStatus } = await loadVerdict();
  // 起こらない集合でも、完了にしてはならない（述語 1 は要素が ["検証済み"] か ["別手段で確認済み"] のときだけ成り立つ）
  const g = globalFrom([['検証済み', '未確認']]);
  assert.equal(decideStatus(structuredClone(g)).status, '停止');
  assert.ok(decideStatus(structuredClone(g)).unmet.includes('必要な性質が検証の成功でない'));
});

test('SP-FORMALMETHOD-015 AC-14 decideStatus 2 つの性質の全ての判定の組で、仕様の導出と一致する', async () => {
  const { decideStatus } = await loadVerdict();
  const singles = VERDICTS.map((v) => [v]);
  for (const a of singles) for (const b of [null, ...singles]) {
    const g = globalFrom(b ? [a, b] : [a]);
    assert.deepEqual(decideStatus(structuredClone(g)), specDecide(g), JSON.stringify(g.required_verdicts));
  }
});
