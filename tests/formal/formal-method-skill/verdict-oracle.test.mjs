// 判定の 3 関数（classifyCheck・aggregateProperty・decideStatus）を、オラクル tests/formal/formal-method-spec/ と照らす。
// 期待値は scripts/test-fixtures/spec-verdict.mjs が仕様から独立に導く。オラクルの表は照合の相手で、期待値に写さない。
// 照合 1: enum_table.txt（72 行）と End の全 360 通り。照合 2: questions.py の Q と summary.txt。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allEnds, invalidReason, specCheckVerdict, specAggregate, specDecide, globalFrom,
  DEFAULT_FACTS, NOT_STARTED, isInvalidEndError,
} from '../../../.agents/skills/formal-method/scripts/test-fixtures/spec-verdict.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORACLE = join(HERE, '..', 'formal-method-spec');
const VERDICT_MODULE = join(HERE, '..', '..', '..', '.agents', 'skills', 'formal-method', 'scripts', 'lib', 'verdict.mjs');
const loadVerdict = () => import(VERDICT_MODULE);

// ---- オラクルの語彙と End の対応（artifact-formats.md「オラクルの語彙との対応」） ----
const RET_END = {
  Ok: { tool_result: '満たす' }, Cex: { tool_result: '反する' }, Undec: { tool_result: '判定できない' },
  Err: { tool_result: '判定以外のエラー' }, Crash: { tool_result: 'なし', abnormal_exit: true },
  Unread: { tool_result: 'なし', unreadable_output: true }, NotStarted: { started: false }, NoReturn: { tool_result: 'なし' },
};
const STOP_END = { Time: '時間', Abort: 'その他', NoStop: null };
const TL_END = { None: null, Req: '依頼元', Tool: '道具' };
const CV_NAME = { Succ: '成功', Cex: '反例', NotRun: '未実行', Unk: 'unknown', TO: '時間切れ', Fail: '実行失敗' };

function rowToEnd(tag) {
  const [ret, stop, tl] = tag.split('_');
  return {
    started: true, tool_result: 'なし', abnormal_exit: false, unreadable_output: false,
    ...RET_END[ret], stopped_by: STOP_END[stop], time_limit_hit: TL_END[tl.replace(/^t/, '')],
  };
}

function readEnumTable() {
  return readFileSync(join(ORACLE, 'enum_table.txt'), 'utf8').trim().split('\n').map((line) => {
    const [tag, value, note] = line.split(' | ');
    return { tag, value, note };
  });
}

const endKey = (e) => JSON.stringify([e.started, e.tool_result, e.abnormal_exit, e.unreadable_output, e.stopped_by, e.time_limit_hit]);

test('照合1 前提: enum_table.txt は 8×3×3=72 行で、各行の語彙が End に写る', () => {
  const rows = readEnumTable();
  assert.equal(rows.length, 72);
  for (const r of rows) {
    const [ret, stop, tl] = r.tag.split('_');
    assert.ok(ret in RET_END && stop in STOP_END && tl.replace(/^t/, '') in TL_END, r.tag);
    assert.ok(['除外', 'unsat'].includes(r.value) || r.value in CV_NAME, `${r.tag}: ${r.value}`);
  }
});

test('照合1 SP-FORMALMETHOD-011 AC-09・AC-14: 仕様から独立に導いた検査の判定と、オラクルの網羅表 72 行が一致する', () => {
  const disagreements = [];
  for (const r of readEnumTable()) {
    const e = rowToEnd(r.tag);
    // NotStarted 行は End の started:false に写すと stop・tl を持てない。持つ行は語彙で表せない組（起こらない）。
    const reason = invalidReason(e);
    const oracleInvalid = r.value === '除外' || r.value === 'unsat';
    if (oracleInvalid !== Boolean(reason)) {
      disagreements.push(`${r.tag}: oracle=${r.value} spec=${reason ?? specCheckVerdict(e)}`);
      continue;
    }
    if (!oracleInvalid && specCheckVerdict(e) !== CV_NAME[r.value]) disagreements.push(`${r.tag}: oracle=${CV_NAME[r.value]} spec=${specCheckVerdict(e)}`);
    if (!oracleInvalid) assert.equal(r.note, '一意', `${r.tag} はオラクルで一意`);
  }
  assert.deepEqual(disagreements, [], '仕様からの導出とオラクルの食い違い（依頼者へ返す）');
});

test('照合1 SP-FORMALMETHOD-011 AC-09・AC-14: classifyCheck は 72 行のうち判定が一意の行でその値を返し、除外・unsat の行を invalid_end で拒む', async () => {
  const { classifyCheck } = await loadVerdict();
  for (const r of readEnumTable()) {
    const e = rowToEnd(r.tag);
    if (r.value === '除外' || r.value === 'unsat') {
      assert.throws(() => classifyCheck(structuredClone(e)), isInvalidEndError, `${r.tag} は invalid_end`);
    } else {
      assert.equal(classifyCheck(structuredClone(e)), CV_NAME[r.value], r.tag);
    }
  }
});

test('照合1 SP-FORMALMETHOD-011 AC-09: classifyCheck は End の全 360 通りで、起こらない組を invalid_end で拒み、他は仕様の導出と同じ値を返す', async () => {
  const { classifyCheck } = await loadVerdict();
  const ends = allEnds();
  assert.equal(ends.length, 360);
  const covered = new Set(readEnumTable().map((r) => endKey(rowToEnd(r.tag))));
  let valid = 0;
  for (const e of ends) {
    const reason = invalidReason(e);
    if (reason) {
      assert.throws(() => classifyCheck(structuredClone(e)), isInvalidEndError, `${endKey(e)}: ${reason}`);
    } else {
      valid += 1;
      assert.ok(covered.has(endKey(e)) || endKey(e) === endKey(NOT_STARTED), `${endKey(e)} は網羅表の行にある`);
      assert.equal(classifyCheck(structuredClone(e)), specCheckVerdict(e), endKey(e));
    }
  }
  // 起こりうる組の数は網羅表の「除外」「unsat」以外の行数と同じ
  assert.equal(valid, readEnumTable().filter((r) => r.value !== '除外' && r.value !== 'unsat').length);
});

test('照合1 SP-FORMALMETHOD-011: classifyCheck は入力の End を変えない', async () => {
  const { classifyCheck } = await loadVerdict();
  const e = { started: true, tool_result: '反する', abnormal_exit: false, unreadable_output: false, stopped_by: null, time_limit_hit: '道具' };
  const copy = structuredClone(e);
  assert.equal(classifyCheck(e), '反例');
  assert.deepEqual(e, copy);
});

// ---- 照合 2: questions.py の Q ----
// chk の入力（gen.py の CHK_INPUTS）を End に写す。写しは T が書く（verification-plan「照合 2」）。
function chkToEnd(c) {
  if (!c.started) return { ...NOT_STARTED };
  let tool_result = 'なし';
  if (c.ok) tool_result = '満たす';
  if (c.cex) tool_result = '反する';
  if (c.unk) tool_result = '判定できない';
  if (c.err) tool_result = '判定以外のエラー';
  return {
    started: true, tool_result, abnormal_exit: Boolean(c.crash), unreadable_output: Boolean(c.unread),
    stopped_by: c.tl ? '時間' : c.abort ? 'その他' : null,
    time_limit_hit: c.tl ? '依頼元' : c.unkt ? '道具' : null,
  };
}

// prop の入力（gen.py の PROP_INPUTS、既定は questions.py の prop()）を PropertyFacts に写す。
const PROP_DEFAULT = { formal: 1, corr: 1, mean: 1, det: 1, dd: 0, dok: 0, altok: 0, pq: 0, notool: 0 };
function propToFacts(p, checkVerdicts) {
  const x = { ...PROP_DEFAULT, ...p };
  return {
    ...DEFAULT_FACTS,
    formalizable: Boolean(x.formal), check_verdicts: checkVerdicts, no_suitable_tool: Boolean(x.notool),
    depends_on_question: Boolean(x.pq), correspondence: Boolean(x.corr), meaning_confirmed: Boolean(x.mean),
    deterministic_confirmed: Boolean(x.det), detection_performed: Boolean(x.dd), detection_confirmed: Boolean(x.dok),
    alternative_confirmed: Boolean(x.altok), composition_applies: false, composition_confirmed: false,
  };
}

const GLOB_DEFAULT = { combos: 0, saved: 1, sp12: 1, detunconf: 0, pq_any: 0 };
function globToGlobal(g, requiredVerdicts) {
  const x = { ...GLOB_DEFAULT, ...g };
  return globalFrom(requiredVerdicts, {
    confirmations_unresolved: !x.sp12, uncovered_combinations: x.combos ? 1 : 0, pending_questions: x.pq_any ? 1 : 0,
    all_records_saved: Boolean(x.saved), detection_unconfirmed: x.detunconf ? 1 : 0,
  });
}

const OK = { started: 1, finished: 1, ok: 1 };
const S = { VER: '検証済み', ALT: '別手段で確認済み', CEX: '反例', NOTRUN: '未実行', UNK: 'unknown', TO: '時間切れ', FAIL: '実行失敗', UNCONF: '未確認' };
// 入力は questions.py の q(...) の引数の写し。oracle は questions.py が期待とした値（照合の相手）。
// decision が付く Q は、オラクルが未確定とした点を依頼者の決定で 1 つに決めた入力（c2 の自由な欄を D1・D2 で埋めた）。
const QS = [
  { id: 'Q1_agg_mixed', props: { P: ['c1', 'c2'] }, chk: { c1: { started: 1, finished: 1, cex: 1 }, c2: OK }, prop: { P: {} }, glob: {}, oracle: { P: ['CEX'] }, complete: false },
  { id: 'Q2_allsucc_meaningfail', props: { P: ['c1', 'c2'] }, chk: { c1: OK, c2: OK }, prop: { P: { mean: 0 } }, glob: {}, oracle: { P: ['UNCONF'] }, complete: false },
  { id: 'Q3_timelimit', props: { P: ['c1', 'c2'] }, chk: { c1: { started: 1, tl: 1 }, c2: {} }, prop: { P: {} }, glob: {}, oracle: { P: ['TO', 'NOTRUN'] }, complete: false },
  { id: 'Q4_pending_allok', props: { P: ['c1'] }, chk: { c1: OK }, prop: { P: { pq: 1 } }, glob: { pq_any: 1 }, oracle: { P: ['UNCONF'] }, complete: false },
  { id: 'Q5_L215_otherprop', props: { P1: ['c1'], P2: ['c2'] }, chk: { c1: { started: 1, finished: 1, cex: 1 }, c2: OK }, prop: { P1: {}, P2: {} }, glob: {}, oracle: { P1: ['CEX'], P2: ['VER'] }, complete: false,
    decision: '依頼者の決定 D1（独立な検査を最後まで続ける）: c2 は最後まで動き、成功を返す' },
  { id: 'Q6_L176_independent', props: { P1: ['c1'], P2: ['c2'] }, chk: { c1: {}, c2: OK }, prop: { P1: { pq: 1 }, P2: {} }, glob: { pq_any: 1 }, oracle: { P1: ['NOTRUN'], P2: ['VER'] }, complete: false,
    decision: 'P1 は未実行に一意。P2 は依頼者の決定 D2（回答に依存しない検証も続ける）: c2 は最後まで動き、成功を返す' },
  { id: 'Q7_aborted', props: { P: ['c1'] }, chk: { c1: { started: 1, abort: 1 } }, prop: { P: {} }, glob: {}, oracle: { P: ['NOTRUN'] }, complete: false },
  { id: 'Q9_zerochecks', props: { P: [] }, chk: {}, prop: { P: {} }, glob: {}, oracle: { P: ['UNCONF'] }, complete: false },
  { id: 'Q10a_zeroprops', props: {}, chk: {}, prop: {}, glob: {}, oracle: null, complete: false },
  { id: 'Q10b_detunconf', props: { P: ['c1'] }, chk: { c1: OK }, prop: { P: {} }, glob: { detunconf: 1 }, oracle: null, complete: false },
  { id: 'Q10c_allok', props: { P: ['c1'] }, chk: { c1: OK }, prop: { P: {} }, glob: {}, oracle: { P: ['VER'] }, complete: true },
  { id: 'Q11_alt_ok', props: { P: [] }, chk: {}, prop: { P: { formal: 0, altok: 1 } }, glob: {}, oracle: { P: ['ALT'] }, complete: true },
  { id: 'Q12_alt_fail', props: { P: [] }, chk: {}, prop: { P: { formal: 0 } }, glob: {}, oracle: { P: ['UNCONF'] }, complete: false },
  { id: 'Q13a_nonformal_succcheck_altfail', props: { P: ['c1'] }, chk: { c1: OK }, prop: { P: { formal: 0 } }, glob: {}, oracle: { P: ['UNCONF'] }, complete: false },
  { id: 'Q13b_nonformal_succcheck_altok', props: { P: ['c1'] }, chk: { c1: OK }, prop: { P: { formal: 0, altok: 1 } }, glob: {}, oracle: { P: ['ALT'] }, complete: true },
  { id: 'Q14_notool_zerochecks', props: { P: [] }, chk: {}, prop: { P: { notool: 1 } }, glob: {}, oracle: { P: ['NOTRUN'] }, complete: false },
  { id: 'Q15_single_cex', props: { P: ['c1'] }, chk: { c1: { started: 1, finished: 1, cex: 1 } }, prop: { P: {} }, glob: {}, oracle: { P: ['CEX'] }, complete: false },
  { id: 'Q16_unknown_by_tooltime', props: { P: ['c1'] }, chk: { c1: { started: 1, finished: 1, unk: 1, unkt: 1 } }, prop: { P: {} }, glob: {}, oracle: { P: ['TO'] }, complete: false },
  { id: 'Q17_unknown_other', props: { P: ['c1'] }, chk: { c1: { started: 1, finished: 1, unk: 1 } }, prop: { P: {} }, glob: {}, oracle: { P: ['UNK'] }, complete: false },
  { id: 'Q18_notool_nocorr', props: { P: [] }, chk: {}, prop: { P: { notool: 1, corr: 0 } }, glob: {}, oracle: { P: ['NOTRUN'] }, complete: false },
  { id: 'Q19a_tool_nocorr_nocheck', props: { P: [] }, chk: {}, prop: { P: { corr: 0 } }, glob: {}, oracle: { P: ['UNCONF'] }, complete: false },
  { id: 'Q19b_tool_nocorr_succcheck', props: { P: ['c1'] }, chk: { c1: OK }, prop: { P: { corr: 0 } }, glob: {}, oracle: { P: ['UNCONF'] }, complete: false },
  { id: 'Q19c_tool_nocorr_cexcheck', props: { P: ['c1'] }, chk: { c1: { started: 1, finished: 1, cex: 1 } }, prop: { P: { corr: 0 } }, glob: {}, oracle: { P: ['CEX'] }, complete: false },
  { id: 'Q20_unknown_citing_resource', props: { P: ['c1'] }, chk: { c1: { started: 1, finished: 1, unk: 1 } }, prop: { P: {} }, glob: {}, oracle: { P: ['UNK'] }, complete: false },
  { id: 'Q21a_nonformal_alt_tool', props: { P: [] }, chk: {}, prop: { P: { formal: 0, altok: 1 } }, glob: {}, oracle: { P: ['ALT'] }, complete: true },
  { id: 'Q21b_nonformal_alt_notool', props: { P: [] }, chk: {}, prop: { P: { formal: 0, altok: 1, notool: 1 } }, glob: {}, oracle: { P: ['ALT'] }, complete: true },
  { id: 'Q22_tl_crash', props: { P: ['c1'] }, chk: { c1: { started: 1, tl: 1, crash: 1 } }, prop: { P: {} }, glob: {}, oracle: { P: ['TO'] }, complete: false },
  { id: 'Q23_abort_crash', props: { P: ['c1'] }, chk: { c1: { started: 1, abort: 1, crash: 1 } }, prop: { P: {} }, glob: {}, oracle: { P: ['NOTRUN'] }, complete: false },
  { id: 'Q24_crash_own', props: { P: ['c1'] }, chk: { c1: { started: 1, crash: 1 } }, prop: { P: {} }, glob: {}, oracle: { P: ['FAIL'] }, complete: false },
  { id: 'Q25_unknown_by_tooltime', props: { P: ['c1'] }, chk: { c1: { started: 1, finished: 1, unk: 1, unkt: 1 } }, prop: { P: {} }, glob: {}, oracle: { P: ['TO'] }, complete: false },
  { id: 'Q26_tl_unread', props: { P: ['c1'] }, chk: { c1: { started: 1, tl: 1, unread: 1 } }, prop: { P: {} }, glob: {}, oracle: { P: ['TO'] }, complete: false },
  { id: 'Q27_unread_own', props: { P: ['c1'] }, chk: { c1: { started: 1, unread: 1 } }, prop: { P: {} }, glob: {}, oracle: { P: ['FAIL'] }, complete: false },
  { id: 'Q28_tool_error', props: { P: ['c1'] }, chk: { c1: { started: 1, err: 1 } }, prop: { P: {} }, glob: {}, oracle: { P: ['FAIL'] }, complete: false },
];

function readSummary() {
  return Object.fromEntries(readFileSync(join(ORACLE, 'summary.txt'), 'utf8').trim().split('\n').map((l) => {
    const m = l.match(/^(\S+): .* -> (\S+)/);
    return [m[1], m[2]];
  }));
}

// 仕様から独立に導いた、各 Q の性質の判定と完了。
function deriveQ(q, classify, aggregate, decide) {
  const sets = {};
  for (const [p, cs] of Object.entries(q.props)) {
    const cvs = cs.map((c) => classify(chkToEnd(q.chk[c] ?? {})));
    sets[p] = aggregate(propToFacts(q.prop[p] ?? {}, cvs));
  }
  const decision = decide(globToGlobal(q.glob, Object.values(sets)));
  return { sets, decision };
}

test('照合2 前提: 写した Q の集合は summary.txt（r11: Q1〜Q7・Q9〜Q28、Q8 なし）と一致し、未確定は Q5・Q6 だけ', () => {
  const summary = readSummary();
  assert.deepEqual(QS.map((q) => q.id).sort(), Object.keys(summary).sort());
  assert.ok(!('Q8' in summary) && !Object.keys(summary).some((k) => k.startsWith('Q8_')));
  for (const q of QS) assert.equal(summary[q.id], q.decision ? '未確定' : '一意', q.id);
});

for (const q of QS) {
  test(`照合2 SP-FORMALMETHOD-011・015 AC-14 ${q.id}: 仕様から独立に導いた判定・完了がオラクルの期待と一致する${q.decision ? `（出所: ${q.decision}）` : ''}`, () => {
    const { sets, decision } = deriveQ(q, specCheckVerdict, specAggregate, specDecide);
    if (q.oracle) {
      for (const [p, vs] of Object.entries(q.oracle)) assert.deepEqual([...sets[p]].sort(), vs.map((v) => S[v]).sort(), `${q.id} ${p}`);
    }
    assert.equal(decision.status === '完了', q.complete, `${q.id} complete`);
  });

  test(`照合2 SP-FORMALMETHOD-011・015 AC-14 ${q.id}: classifyCheck→aggregateProperty→decideStatus が仕様からの導出と一致する`, async () => {
    const { classifyCheck, aggregateProperty, decideStatus } = await loadVerdict();
    const expected = deriveQ(q, specCheckVerdict, specAggregate, specDecide);
    const actual = deriveQ(q, (e) => classifyCheck(structuredClone(e)), (f) => aggregateProperty(structuredClone(f)), (g) => decideStatus(structuredClone(g)));
    assert.deepEqual(actual.sets, expected.sets, `${q.id} の性質の判定（順は Verdict の並び）`);
    assert.deepEqual(actual.decision, expected.decision, `${q.id} の status と unmet`);
  });
}
