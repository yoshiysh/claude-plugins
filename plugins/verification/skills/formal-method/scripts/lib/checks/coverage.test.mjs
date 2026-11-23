// unit: 洗い出しの照合（coverageCheck）のうち、確認の段の抽出の確認で見つかる型の前倒し（どの性質にも結ばれない要素と、
// 本文の ID の参照が external_dependencies に無いもの）。作成役が検査の前に直す機会を足すだけで、抽出の確認役の観点は残す。
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Bytes } from '../canonical.mjs';
import { coverageCheck, definedIdsOf } from './coverage.mjs';

const sha = (s) => sha256Bytes(Buffer.from(s, 'utf8'));
const H = sha('target');
// 1 行目は見出し（この対象で定義する ID）、2 行目以降は本文
const SPEC = '#### SP-DEMO-001 受付\nSP-DEMO-001 は SP-BASE-002 に従う。\n文字コードは UTF-8、指紋は SHA-256 で、ISO-8601 の時刻を使う。\n| SP-DEMO-003 | 表で定義する |\n';
const target = (text = SPEC) => ({ id: 'T1', content_hash: H, files: [{ path: 'spec.md', text: true, bytes: Buffer.from(text, 'utf8') }] });
const line = (text, n) => text.split('\n')[n - 1];
const element = (text, id, n) => ({ id, kind: 'requirement', source: { target_id: 'T1', file: 'spec.md', span: `L${n}-L${n}`, quote_hash: sha(line(text, n)) }, text: line(text, n) });
const property = (id, sourceIds) => ({ id, source_ids: sourceIds, statement: id, formalizable: true, nonformal_reason: null, nonformal_method: null, assumptions: [], scope: '全体', blocked_by_question: [] });
function inventory({ text = SPEC, elements = null, properties = null, deps = [] } = {}) {
  const n = text.split('\n').length - 1;
  return {
    schema: 'formal-method.inventory/1', target_id: 'T1', content_hash: H,
    scanned: [{ file: 'spec.md', span: `L1-L${n}`, status: 'read', reason: null }],
    elements: elements ?? [element(text, 'E1', 2), element(text, 'E2', 3)],
    properties: properties ?? [property('P1', ['E1', 'E2'])],
    external_dependencies: deps,
  };
}
const DEP = [{ id: 'X1', text: 'SP-BASE-002（別の仕様書）', source: { target_id: 'T1', file: 'spec.md', span: 'L2-L2' } }];
const keys = (defects) => defects.map((d) => `${d.kind} ${d.key}`);
const run = (inv, tgt = target(), opts = {}) => coverageCheck('/nonexistent', inv, tgt, opts);

test('SP-FORMALMETHOD-004: 正しい inventory（要素は全てどれかの性質に結ばれ、外の ID の参照は external_dependencies にある）には欠陥が無い', () => {
  assert.deepEqual(keys(run(inventory({ deps: DEP }))), []);
});

test('SP-FORMALMETHOD-004: どの性質の source_ids にも出てこない要素は、洗い出しの照合の欠陥（other）', () => {
  const d = run(inventory({ deps: DEP, properties: [property('P1', ['E1'])] }));
  assert.deepEqual(keys(d), ['other element-unbound:E2']);
});

test('SP-FORMALMETHOD-004: 本文の ID の参照のうち、この対象で定義されず external_dependencies にも無いものは、洗い出しの照合の欠陥（other）', () => {
  const d = run(inventory());
  assert.deepEqual(keys(d), ['other external-reference:SP-BASE-002']);
  assert.match(d[0].text, /spec\.md:L2/);
});

test('SP-FORMALMETHOD-004 偽の陽性: 形の違う語（UTF-8・SHA-256・ISO-8601）、この対象で定義する ID、inventory の id、依頼の id、他の対象で定義する ID は参照に数えない', () => {
  assert.deepEqual(definedIdsOf(target()), new Set(['SP-DEMO-001', 'SP-DEMO-003']), '見出しと表の最初の列が定義');
  // 依頼の id・他の対象の定義・inventory の id（性質・要素・外部の依存）
  assert.deepEqual(keys(run(inventory(), target(), { requestIds: new Set(['SP-BASE-002']) })), []);
  assert.deepEqual(keys(run(inventory(), target(), { otherDefinedIds: new Set(['SP-BASE-002']) })), []);
  assert.deepEqual(keys(run(inventory({ properties: [property('SP-BASE-002', ['E1', 'E2'])] }))), []);
  assert.deepEqual(keys(run(inventory({ deps: [{ id: 'SP-BASE-002', text: '要求文書', source: null }] }))), []);
});

test('SP-FORMALMETHOD-004 偽の陽性: この対象が ID を定義しなければ ID の形を拾えないので、参照に数えない', () => {
  const text = '# 対象\nこれは PR-DEMO-002 に従う。\n';
  assert.deepEqual(keys(run(inventory({ text, elements: [element(text, 'E1', 2)], properties: [property('P1', ['E1'])] }), target(text))), []);
});

test('SP-FORMALMETHOD-004 偽の陽性: 2 つの区切りの ID は、定義した ID と頭の語が同じときだけ参照に数える（AC-04 を定義しても SHA-256 は数えない）', () => {
  const text = '| AC-01 | 受け入れ |\nAC-01 は AC-02 と SHA-256 を使う。\n';
  const d = run(inventory({ text, elements: [element(text, 'E1', 2)], properties: [property('P1', ['E1'])] }), target(text));
  assert.deepEqual(keys(d), ['other external-reference:AC-02']);
});

test('SP-FORMALMETHOD-001・004 偽の陽性: 依頼の範囲の外の行の参照は数えない', () => {
  const text = '#### SP-DEMO-001 受付\nSP-DEMO-001 は受け付ける。\nSP-BASE-002 に従う。\n';
  const inv = inventory({ text, elements: [element(text, 'E1', 2)], properties: [property('P1', ['E1'])] });
  inv.scanned = [{ file: 'spec.md', span: 'L1-L2', status: 'read', reason: null }];
  assert.deepEqual(keys(run(inv, target(text), { scope: new Map([['spec.md', ['L1-L2']]]) })), []);
  inv.scanned = [{ file: 'spec.md', span: 'L1-L3', status: 'read', reason: null }];
  assert.deepEqual(keys(run(inv, target(text))), ['other external-reference:SP-BASE-002']);
});

test('SP-FORMALMETHOD-004 偽の陽性: 語の数によらず、頭の語が対象の定義する ID の頭の語と同じ参照だけを数える（3 語の HMAC-SHA-256・ECDSA-P-256・RSA-OAEP-256、頭の違う PR-DEMO-002 は数えない）', () => {
  const text = '#### SP-FORMALMETHOD-012 署名\n署名は HMAC-SHA-256・ECDSA-P-256・RSA-OAEP-256 のどれかで、PR-DEMO-002 に従う。\nSP-FORMALMETHOD-099 を参照する。\n';
  const inv = inventory({ text, elements: [element(text, 'E1', 2), element(text, 'E2', 3)], properties: [property('P1', ['E1', 'E2'])] });
  assert.deepEqual(keys(run(inv, target(text))), ['other external-reference:SP-FORMALMETHOD-099']);
});

test('SP-FORMALMETHOD-001・004 偽の陽性: 依頼元が除外した location の行の参照は数えない（走査範囲の網羅は include だけで決める）', () => {
  const text = '#### SP-DEMO-001 受付\nSP-DEMO-001 は受け付ける。\nSP-BASE-002 に従う。\n';
  const inv = inventory({ text, elements: [element(text, 'E1', 2)], properties: [property('P1', ['E1'])] });
  assert.deepEqual(keys(run(inv, target(text))), ['other external-reference:SP-BASE-002']);
  assert.deepEqual(keys(run(inv, target(text), { excluded: new Map([['spec.md', ['L3-L3']]]) })), [], '除外した行');
  assert.deepEqual(keys(run(inv, target(text), { excluded: new Map([['spec.md', null]]) })), [], '除外したファイルの全体');
  assert.deepEqual(keys(run(inv, target(text), { excluded: new Map([['other.md', null]]) })), ['other external-reference:SP-BASE-002'], '他のファイルの除外は効かない');
  // 除外は走査範囲の網羅を緩めない（覆うべきものは include の範囲のまま）
  const short = { ...inv, scanned: [{ file: 'spec.md', span: 'L1-L2', status: 'read', reason: null }] };
  assert.deepEqual(keys(run(short, target(text), { excluded: new Map([['spec.md', ['L3-L3']]]) })), ['other scan-lines:spec.md']);
});

test('SP-FORMALMETHOD-004 偽の陽性: 箇条書きの先頭の ID と太字の ID も定義とみなす', () => {
  const text = '- SP-DEMO-005 箇条書きで定義する\n* SP-DEMO-006: 箇条書きで定義する\n本文の **SP-DEMO-007** は太字で定義する。\n- 先頭でない SP-DEMO-008 は定義でない\n';
  assert.deepEqual(definedIdsOf(target(text)), new Set(['SP-DEMO-005', 'SP-DEMO-006', 'SP-DEMO-007']));
  const ref = `${text}SP-DEMO-005・SP-DEMO-006・SP-DEMO-007 に従う。\n`;
  const inv = inventory({ text: ref, elements: [element(ref, 'E1', 5)], properties: [property('P1', ['E1'])] });
  assert.deepEqual(keys(run(inv, target(ref))), ['other external-reference:SP-DEMO-008']);
});
