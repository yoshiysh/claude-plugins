import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'plugins', 'skill-creator', 'skills', 'skill-creator-best-practices', 'scripts');
const acorn = createRequire(path.join(ROOT, 'plugins', 'workflow', 'skills', 'dynamic-workflow-runner', 'scripts', 'runtime', 'package.json'))('acorn');

// 2 本の script は import できないので部品を字面で写し合う。直しを片方にだけ入れると、運搬役・冪等・起動数の契約が機能ごとに分かれる。
const SHARED = [
  'canonical', 'fnvSum', 'Stop', 'makeBudget', 'early', 'checkHostArgs', 'track', 'markItem', 'request', 'write', 'read', 'command', 'launch',
  'carrierPrompt', 'carry', 'mustCarry', 'launchReason', 'pool', 'itemLoop', 'fanOut', 'stageStart', 'writeResult', 'failureNote', 'failures',
  'CARRIER_SCHEMA', 'REFUTE_SCHEMA', 'VANISH_SCHEMA', 'ROLE_MODELS', 'LIMITS', 'CONCURRENCY', 'PAYLOAD_MODE', 'RESERVE',
];

// 同じ名前で中身が違ってよいもの。段の並び・入力・返り値・prompt は機能ごとに違う。
const DIFFERENT = {
  meta: 'meta.name と段の並びが機能ごとに違う',
  STAGE_TITLES: '段の名前が機能の文書の段の表ごとに違う（観点ごとの検証・照合と停止は review・audit だけ）',
  WORST: '段の組み方が違う。同じ鍵の値は下のテストで照らす',
  minimalLaunches: '最も大きくなる経路が機能ごとに違う（SP-BPRUN-021）',
  verifySchema: 'review・audit は未検査の観点の候補、create・update は観点ごとの足した欄を持つ',
  validateArgs: '受け付ける機能と入力の項目が違う（SP-BPENTRY-013）',
  run: 'script の手元の値の欄が違う',
  memo: '書き手に渡す入力は create・update だけ',
  startRun: 'create・update は依頼文か修正の根拠を開始に渡す',
  verifierPrompt: '観点と照らす先の渡し方が違う',
  verifyItem: 'schema が観点によるか（create・update）、観点によらないか（review・audit）',
  verifyStage: 'review・audit は担当の組ごとに項目を持つ',
  closeVerify: '段の回の有無が違う',
  verifyExtraStage: 'review・audit の再開は止まった部分を破棄せずに処理する（SP-BPINSPECTION-030）',
  refuterPrompt: 'review・audit は資産の束と候補の観点の照らす先を渡す（SP-BPINSPECTION-018）',
  refuteStage: '段の回の有無と反証役の prompt が違う',
  vanishStage: 'review・audit は資産の束と照らす先を共通の部分として渡す',
  resumePlan: '再開の段の表が機能の文書ごとに違う（SP-BPAUTHORING-035・SP-BPINSPECTION-030）',
  finish: 'review・audit は全ての停止で onTargetChanged を付け、完了の前に段の終わりを書く',
  main: '段の並びが違う',
};

function declarations(file) {
  const source = readFileSync(path.join(DIR, file), 'utf8');
  const prefix = 'async function __s() {\n';
  const offset = prefix.length - 'export '.length;
  const ast = acorn.parse(`${prefix}${source.replace(/^export const meta =/, 'const meta =')}\n}`, { ecmaVersion: 'latest' });
  const out = new Map();
  for (const n of ast.body[0].body.body) {
    const name = n.type === 'VariableDeclaration' ? n.declarations[0].id.name : n.id?.name;
    if (name) out.set(name, { text: source.slice(n.start - offset, n.end - offset).replace(/\s+/g, ' '), node: n, source, offset });
  }
  return out;
}

const AUTHOR = declarations('bp_author.js');
const INSPECT = declarations('bp_inspect.js');

test('§6.9 の 1(d): 2 本の script に同じ名前で現れる最上位の関数・定数は、許可したものを除き字面（空白を正規化）が同じ', () => {
  for (const name of SHARED) {
    assert.ok(AUTHOR.has(name) && INSPECT.has(name), `共通の部品が片方に無い: ${name}`);
  }
  const both = [...AUTHOR.keys()].filter((k) => INSPECT.has(k));
  for (const name of both) {
    if (Object.hasOwn(DIFFERENT, name)) continue;
    assert.equal(INSPECT.get(name).text, AUTHOR.get(name).text, `字面が違う: ${name}`);
  }
  for (const name of Object.keys(DIFFERENT)) assert.ok(both.includes(name), `許可した名前が片方に無い: ${name}`);
  for (const name of Object.keys(DIFFERENT)) assert.notEqual(INSPECT.get(name).text, AUTHOR.get(name).text, `許可したのに字面が同じ（許可を外す）: ${name}`);
});

test('§6.9 の 1(d)・SP-BPRUN-021: 2 本の WORST で鍵の名前が同じものは値も同じ', () => {
  const value = (decl) => {
    const init = decl.node.declarations[0].init;
    const text = decl.source.slice(init.start - decl.offset, init.end - decl.offset);
    return Function('LIMITS', `return (${text});`)({ attempts: 3 });
  };
  const a = value(AUTHOR.get('WORST'));
  const b = value(INSPECT.get('WORST'));
  const common = Object.keys(a).filter((k) => Object.hasOwn(b, k));
  assert.deepEqual(common.sort(), ['carrier', 'item', 'start']);
  for (const k of common) assert.equal(b[k], a[k], k);
});
