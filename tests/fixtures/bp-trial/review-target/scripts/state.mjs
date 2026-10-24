#!/usr/bin/env node
// trace-cause の状態の CLI。状態を書くのはこの CLI だけ（script はファイルに触れず、運搬役がこの CLI を呼ぶ）。
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, truncateSync, unlinkSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitOk } from './git-safe.mjs';

const SUMMARY_MAX_CHARS = 8000;
const SUMMARY_TRAILER_CHARS = 200;
// 検証不能の歯止めの暫定の閾値（件数）。状態の検証不能の事実がこれを超えたら、round の応答が needs_input の停止を指示する。
const UNVERIFIABLE_MAX = 3;
const STOP_KINDS = ['complete', 'dry', 'needs_input', 'iteration_limit', 'blocked'];
// 検証方式の綴りの正本。再開の応答で script に渡し、script が実行役の schema と prompt を作る。
const METHODS = { refetch: '再取得', rerun: '再実行', citation: '出典照合', unverifiable: '検証不能' };
const VERDICTS = ['accept', 'reject', 'unverifiable'];
// 書き込みは数十ミリ秒で終わる。持ち時間を過ぎた排他は、持ち主の pid が生きていても取り直す（pid は別のプロセスに使い回される）。
const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 25;
const PREMISE_NAMES = { goal: '目標', origin: '出発点' };
export const STATE_ID = /^tc-[0-9a-f]{8}$/;

class Rejected extends Error {
  constructor(code, reason) {
    super(reason);
    this.code = code;
  }
}

const reject = (code, reason) => { throw new Rejected(code, reason); };
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
// 既知の事実の照合は言い換えに強いキーで行う（空白と句読点の違いを同じ事実と数える）。
// 数の中の . と , と、数と数の間の空白は値の一部なので残す（「1.5 秒」と「15 秒」、「1, 2」と「12」、「80 80」と「8080」は別の事実）。
const factKey = (text) => digest(text.normalize('NFKC').toLowerCase().replace(/[、。]|(?<!\d)[.,]|[.,](?!\d)/g, ' ')
  .replace(/\s+/g, (s, at, all) => (/\d/.test(all[at - 1] ?? '') && /\d/.test(all[at + s.length] ?? '') ? ' ' : ''))).slice(0, 12);
const isRound = (n) => Number.isInteger(n) && n >= 1;

// 状態と作業ファイルは対象のリポジトリの外に置く（対象の作業ツリーにも .git にも書かない）。置き場は TRACE_CAUSE_HOME で変えられる。
const homeOf = () => process.env.TRACE_CAUSE_HOME || path.join(os.homedir(), '.local', 'state', 'trace-cause');
// 同じリポジトリを symlink を通る別の綴りで渡しても、同じ状態を引く。
const realOr = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
const repoId = (repo) => digest(realOr(repo)).slice(0, 16);
// 状態と作業ファイルを別の根に置く。書き込みの許可は作業ファイルの根にだけ出すので、状態のファイルは CLI を通さずには書けない。
const dirOf = (repo, state) => path.join(homeOf(), 'states', repoId(repo), state);
export const logOf = (repo, state) => path.join(dirOf(repo, state), 'log.jsonl');
export const workRootOf = (repo) => path.join(homeOf(), 'runs', repoId(repo));
const workDirOf = (repo, state, run) => path.join(workRootOf(repo), state, run);

// 1 回の書き込みの記録は 1 行にまとめる。改行で終わらない末尾は途中で落ちた書き込みなので、その書き込みごと無かったことにする。
function readLog(file) {
  const buf = readFileSync(file);
  const end = buf.lastIndexOf(0x0a) + 1;
  return { batches: buf.subarray(0, end).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)), end, size: buf.length };
}

function load(repo, state) {
  const file = logOf(repo, state);
  if (!existsSync(file)) reject('E_UNKNOWN_ID', `状態が無い: ${state}`);
  const v = { records: [], runs: [], keys: new Map(), resumeKey: null, premises: [], commands: null, hints: [], intents: new Map(), facts: new Map(), resolved: new Map(), disputes: [], assets: new Map(), seen: new Map(), scope: null, rounds: [], claims: [], stops: new Map(), asked: new Map(), limits: null, request: null };
  for (const batch of readLog(file).batches) {
    for (const r of batch) {
      v.records.push(r);
      if (r.asked) v.asked.set(r.asked, r);
      if (r.t === 'start') { v.request = r.request; v.commands = r.commands; v.resumeKey = r.resumeKey; }
      if (r.t === 'run') { v.runs.push(r.run); v.keys.set(r.run, r.key); v.limits = r.limits; }
      if (r.t === 'dispute') v.disputes.push(r);
      if (r.t === 'resolve') { v.resolved.set(r.fact, r.verdict); v.disputes = v.disputes.filter((d) => d.fact !== r.fact); }
      if (r.t === 'premise') v.premises.push(r);
      if (r.t === 'hint') v.hints.push(r);
      if (r.t === 'intent') v.intents.set(r.id, { ...r, attempts: 0, status: 'pending' });
      if (r.t === 'rank') for (const x of r.ranks) v.intents.get(x.intent).rank = x.rank;
      if (r.t === 'attempt') { const i = v.intents.get(r.intent); i.attempts += 1; if (r.aborted) i.status = 'aborted'; }
      if (r.t === 'done') v.intents.get(r.intent).status = r.blank ? 'blank' : 'done';
      // 事実は足すだけで書き換えない。同じ ID の後の記録は最初の記録を変えず、確かめ直しの判定は別の記録（resolve）として足す。
      if (r.t === 'fact' && !v.facts.has(r.id)) v.facts.set(r.id, r);
      if (r.t === 'asset') v.assets.set(r.id, r);
      if (r.t === 'ledger') v.scope = r.scope;
      if (r.t === 'seen') for (const a of r.assets) v.seen.set(a.id, a.sha);
      if (r.t === 'round') v.rounds.push(r);
      if (r.t === 'claim') v.claims.push(r);
      if (r.t === 'stop') v.stops.set(r.run, r);
    }
  }
  return v;
}

function append(repo, state, records) {
  const file = logOf(repo, state);
  const { end, size } = existsSync(file) ? readLog(file) : { end: 0, size: 0 };
  if (end < size) truncateSync(file, end);
  appendFileSync(file, `${JSON.stringify(records)}\n`);
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const holderOf = (lock) => { try { return Number.parseInt(readFileSync(lock, 'utf8'), 10); } catch { return Number.NaN; } };
// 持ち主が終わった排他と、持ち時間を過ぎた排他（中身が空のまま落ちた排他を含む）は取り直す。残ると以後の書き込みが全て止まる。
const staleLock = (lock) => {
  try {
    const st = statSync(lock);
    return (!alive(holderOf(lock)) || Date.now() - st.mtimeMs > LOCK_STALE_MS) ? st.ino : null;
  } catch {
    return null;
  }
};

// 同時に走る意図の運搬役が並んで書くので、読んでから足すまでを排他にする（排他が無いと、照合と追記の間に別の書き込みが入る）。
function locked(repo, state, fn) {
  if (!existsSync(logOf(repo, state))) reject('E_UNKNOWN_ID', `状態が無い: ${state}`);
  const lock = path.join(dirOf(repo, state), 'lock');
  const deadline = Date.now() + 2 * LOCK_STALE_MS;
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const ino = staleLock(lock);
      if (ino !== null) {
        // 取り直す直前に同じ排他かを確かめる（別の CLI が取り直した新しい排他を消さないため）。
        try { if (statSync(lock).ino === ino) unlinkSync(lock); } catch {}
        continue;
      }
      if (Date.now() > deadline) reject('E_BUSY', `状態の排他を持つ CLI（pid ${holderOf(lock)}）が終わらない`);
      pause(LOCK_WAIT_MS);
    }
  }
  try {
    return fn();
  } finally {
    unlinkSync(lock);
  }
}

// 書き込みの鍵は再開の鍵と run から決まる（同じ再開の送り直しに同じ鍵を返し、先に返した鍵を無効にしない）。状態には鍵の digest だけを残す。
const writeKeyOf = (resumeKey, state, run) => createHmac('sha256', String(resumeKey)).update(`${state}:${run}`).digest('hex').slice(0, 32);
const issued = (req, run) => ({ state: req.state, run, workDir: workDirOf(req.repo, req.state, run), writeKey: writeKeyOf(req.resumeKey, req.state, run), methods: METHODS });

// まだ何も書いていない run（再開の応答が運搬役から失われた送り直しのときだけ起きる）。
const SAME = Symbol('same');
const sameAs = (record) => ({ [SAME]: record });

const fresh = (v, run) => !v.records.some((r) => r.run === run && r.t !== 'run');

// 同じ要求の繰り返しは同じ記録を返す（runtime が agent を再起動して同じ書き込みを送り直しても状態が変わらない）。
// 人間のヒントは運搬役を通らず送り直しが起きないので、同じ本文でも足す（読まれた後に足し直したヒントを未読に戻す）。
function write(repo, state, req, make, { keyed = true, once = true } = {}) {
  return locked(repo, state, () => {
    const { writeKey, ...body } = req;
    const asked = digest(body);
    const v = load(repo, state);
    if (keyed && v.keys.get(v.runs.at(-1)) !== digest(String(writeKey))) reject('E_KEY', '書き込みの鍵が今の run のものでない（状態を書くのは運搬役だけ）');
    if (once && v.asked.has(asked)) return { ...v.asked.get(asked), same: true };
    if (req.run !== undefined && req.run !== v.runs.at(-1)) reject('E_STALE_RUN', `現在の run でない: ${req.run}`);
    if (req.run !== undefined && v.stops.has(req.run)) reject('E_STALE_RUN', `停止を書いた後の run: ${req.run}`);
    const made = make(v);
    if (made?.[SAME]) return { ...made[SAME], same: true };
    const records = [made].flat().map((r) => ({ ...r, asked }));
    append(repo, state, records);
    return records.at(-1);
  });
}

// 前の周の記録の後に、受理でなかった事実（未記録を含む）を受理へ移した記録の数。受理済みの数の差で数えると、確かめ直しで受理から外れた事実が新しい受理を打ち消す。
function acceptedSince(v, prev) {
  const now = new Map();
  let n = 0;
  let after = prev === undefined;
  for (const r of v.records) {
    if (r === prev) after = true;
    const verdict = r.t === 'fact' && !now.has(r.id) ? r.verdict : r.t === 'resolve' ? r.verdict : undefined;
    if (verdict === undefined) continue;
    const id = r.t === 'fact' ? r.id : r.fact;
    if (after && verdict === 'accept' && now.get(id) !== 'accept') n += 1;
    now.set(id, verdict);
  }
  return n;
}
const verdictOf = (v, id) => v.resolved.get(id) ?? v.facts.get(id)?.verdict;
const known = (v, id) => verdictOf(v, id) === 'accept' || v.premises.some((p) => p.id === id);
const hintsRead = (v) => new Set(v.records.filter((r) => r.t === 'rank' || r.t === 'claim').flatMap((r) => r.hintsRead ?? []));
const unreadHints = (v) => v.hints.filter((h) => !hintsRead(v).has(h.id));
// 台帳の結び付きとカバレッジは対象の今の内容に基づかせる（見た後に変わったファイルと、消えたファイルは見たと数えない）。
const fileSha = (repo, rel) => { try { return digest(readFileSync(path.join(repo, rel), 'utf8')); } catch { return null; } };
const liveAssets = (repo, v) => [...v.assets.values()].filter((a) => fileSha(repo, a.path) !== null);
const skipOf = (repo) => (v) => {
  const live = liveAssets(repo, v);
  const seen = live.filter((a) => v.seen.get(a.id) === fileSha(repo, a.path));
  return { skip: live.filter((a) => !seen.includes(a)).map((a) => a.path), coverage: `${seen.length}/${live.length}` };
};
const recheckOf = (v, i) => {
  if (!i.recheck) return {};
  const f = v.facts.get(i.recheck);
  return { recheck: { fact: f.id, text: f.text, method: f.method, evidence: f.evidence } };
};
const pendingOf = (v) => pending(v).map((i) => ({ id: i.id, text: i.text, rank: i.rank, ...recheckOf(v, i) }));
// 書き込みの応答に書いた後の状態の読み出しを添える（読み出しのためだけに運搬役を 1 回増やさない）。
const withAfter = (req, record, read) => ({ ...record, ...read(load(req.repo, req.state)) });
const assetId = (file) => `A${digest(file).slice(0, 10)}`;
// 実行役が返すパスの書き方（./ の有無・絶対パス）によらず、同じファイルを同じ資産にする。リポジトリの外のパスは資産にしない。
const relOf = (repo, p) => {
  if (typeof p !== 'string' || p === '') return null;
  const root = realOr(repo);
  const rel = path.relative(root, path.isAbsolute(p) ? realOr(p) : path.resolve(root, p));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null;
};
// 資産 ID はパスから決める（台帳を取り直しても、同じファイルは同じ ID）。再開では範囲の今のファイルを足し直す。
const newAssets = (repo, v, scope) => (scope.length === 0 ? [] : gitOk(repo, ['ls-files', '--', ...scope]).split('\n').filter(Boolean)
  .filter((f) => !v.assets.has(assetId(f))).map((f) => ({ t: 'asset', id: assetId(f), path: f })));
const pending = (v) => [...v.intents.values()].filter((i) => i.status === 'pending').sort((a, b) => a.rank - b.rank);
const accepted = (v) => [...v.facts.values()].filter((f) => verdictOf(v, f.id) === 'accept');
const goalOf = (v) => { try { return JSON.parse(v.premises.find((p) => p.kind === 'goal')?.text ?? '{}'); } catch { return {}; } };
const premiseLine = (p) => `前提 ${p.id}（${PREMISE_NAMES[p.kind] ?? p.kind}）: ${p.text}`;
const abortedOf = (v) => [...v.intents.values()].filter((i) => i.status === 'aborted').map((i) => i.id);
const verdictName = { accept: '受理', reject: '却下', unverifiable: '検証不能' };
const factsOut = (v) => accepted(v).map((f) => ({ id: f.id, text: f.text, method: f.method, evidence: f.evidence }));
// 停止の応答と、完了が書かれた状態の再開の応答は、同じ返り値の項目を運ぶ。周の途中で止まった run は、その周の起動数も載せる。
const stopView = (repo, v, record) => ({ ...skipOf(repo)(v), facts: factsOut(v), pending: record.pending, aborted: record.aborted,
  rounds: [...v.rounds.filter((r) => r.run === record.run).map((r) => ({ round: r.n, launches: r.launches })), ...(record.round ? [{ round: record.round, launches: record.roundLaunches }] : [])] });
const lastStop = (v) => (v.runs.length > 1 ? v.stops.get(v.runs.at(-2)) : undefined);

// 要約の項目の種類。載せなかった項目の宣言と、get の種類の引き方の両方がこの並びを使う（ヒントは get で引かせない。計画役が読むヒントを要約に載ったものに限るため）。
// 試行の回数は意図単位だけでなく方向（意図の key）でも数え、CLI が意図をまたいで合算する（上限の判定と計画役の判断に使う）。
const directionsOf = (v) => {
  const byKey = new Map();
  for (const i of v.intents.values()) {
    if (i.key === undefined) continue;
    byKey.set(i.key, (byKey.get(i.key) ?? 0) + i.attempts);
  }
  return [...byKey.entries()].filter(([, n]) => n > 0).map(([key, n]) => ({ id: key, line: `方向 ${key}: 試行 ${n} 回` }));
};

const KINDS = [
  ['前提', (v) => v.premises.map((p) => ({ id: p.id, line: premiseLine(p) }))],
  ['前の run の停止', (v) => [lastStop(v)].filter(Boolean).map((s) => ({ id: s.run, line: `前の run の停止 ${s.run}（${s.kind}）: ${s.reason}` }))],
  ['事実', (v) => accepted(v).map((f) => ({ id: f.id, line: `事実 ${f.id}: ${f.text}` }))],
  ['検証不能', (v) => [...v.facts.values()].filter((f) => verdictOf(v, f.id) === 'unverifiable').map((f) => ({ id: f.id, line: `検証不能 ${f.id}: ${f.text}` }))],
  ['未着手', (v) => pending(v).map((i) => ({ id: i.id, line: `未着手 ${i.id}（順位 ${i.rank}）: ${i.text}` }))],
  ['打ち切り', (v) => [...v.intents.values()].filter((i) => i.status === 'aborted').map((i) => ({ id: i.id, line: `打ち切り ${i.id}: ${i.text}` }))],
  ['空振り', (v) => [...v.intents.values()].filter((i) => i.status === 'blank').map((i) => ({ id: i.id, line: `空振り ${i.id}: ${i.text}` }))],
  ['判定の食い違い', (v) => v.disputes.map((d) => ({ id: d.fact, line: `判定の食い違い ${d.fact}: ${verdictName[verdictOf(v, d.fact)]}と${verdictName[d.verdict]}（意図 ${d.intent}）` }))],
  ['却下した完了の主張', (v) => v.claims.filter((c) => c.verdict === 'reject').map((c) => ({ id: c.id, line: `却下した完了の主張 ${c.id}: ${c.reason}` }))],
  ['読まれていないヒント', (v) => unreadHints(v).map((h) => ({ id: h.id, line: `読まれていないヒント ${h.id}: ${h.text}` }))],
  ['方向ごとの試行', directionsOf],
];

function summary(v) {
  let text = `周: ${v.rounds.length}`;
  const omitted = [];
  const hints = [];
  for (const [kind, items] of KINDS) {
    let left = 0;
    for (const item of items(v)) {
      if (text.length + item.line.length + 1 > SUMMARY_MAX_CHARS - SUMMARY_TRAILER_CHARS) left += 1;
      else {
        text += `\n${item.line}`;
        if (kind === HINT_KIND) hints.push(item.id);
      }
    }
    if (left) omitted.push(`${kind} ${left} 件`);
  }
  if (omitted.length) text += `\n載せなかった項目（ヒントは次の周で渡す。他は CLI の get に種類を渡すと全件を引ける）: ${omitted.join('・')}`;
  return { summary: text, hints };
}

const HINT_KIND = '読まれていないヒント';
const GET_KINDS = KINDS.filter(([k]) => k !== HINT_KIND);
const findById = (v, id) => v.premises.find((p) => p.id === id) ?? v.facts.get(id) ?? v.intents.get(id) ?? v.claims.find((c) => c.id === id);
const isLimits = (l) => isRound(l?.rounds) && isRound(l?.attempts);
const isCommands = (c) => Array.isArray(c) && c.every((x) => typeof x === 'string' && x !== '');
const resumeKeyOk = (v, req) => v.resumeKey === digest(String(req.resumeKey));

// 開始は run の外で呼び出し元が 1 回だけ、scripts/start.mjs から呼ぶ（この CLI の操作に入れないので、必要な許可にも入らない）。
// runtime が送り直す書き込みではないので、送り直しの照合を持たない（照合の鍵を run の中で作ると、依頼文を読める役が同じ鍵で送り直して、書き込みと再開の鍵を得られる）。
// 写しの中で実行してよいコマンドもここでだけ記録する（run の中の役が状態を作れると、その状態に記録した任意のコマンドを写しの中で実行できる）。
function start(req) {
  if (typeof req.request !== 'string' || req.request === '') reject('E_INPUT', 'request（依頼文）が要る');
  if (!isCommands(req.commands)) reject('E_INPUT', 'commands（依頼文の再現手順のコマンドの並び）が要る');
  const state = `tc-${randomBytes(4).toString('hex')}`;
  const resumeKey = randomBytes(16).toString('hex');
  mkdirSync(dirOf(req.repo, state), { recursive: true });
  append(req.repo, state, [{ t: 'start', request: req.request, commands: req.commands, resumeKey: digest(resumeKey) }]);
  return { state, resumeKey };
}

const OPS = {
  // run は全て再開で始める。停止の記録の応答が失われた run も、ここで状態に書かれた停止を読んで続ける。
  resume: (req) => locked(req.repo, req.state, () => {
    const v = load(req.repo, req.state);
    if (!resumeKeyOk(v, req)) reject('E_KEY', '再開の鍵が無いか違う（再開は開始の応答か nextArgs の resumeKey を要る）');
    if (!isLimits(req.limits)) reject('E_INPUT', 'limits（周の上限 rounds と試行の上限 attempts）が要る');
    const last = v.runs.at(-1);
    const stopped = last === undefined ? undefined : v.stops.get(last);
    if (stopped?.kind === 'complete') return { completed: true, reason: stopped.reason, cause: stopped.cause, ...stopView(req.repo, v, stopped) };
    // 目標・出発点・台帳は 1 回の書き込みでそろうので、台帳が無ければ目標の固定からやり直す。足りない入力への答えは読まれていないヒントにある。
    const needsGoal = v.scope === null;
    const read = { rounds: v.rounds.length, ...(needsGoal ? { request: v.request, hints: unreadHints(v).map((h) => ({ id: h.id, text: h.text })) } : {}) };
    if (last !== undefined && !stopped && fresh(v, last)) return { ...issued(req, last), ...read, same: true };
    const run = `r${v.runs.length + 1}`;
    const records = last === undefined || stopped ? [] : [{ t: 'stop', run: last, kind: 'blocked', reason: '停止の記録が無いまま終わった run', pending: pending(v).map((i) => i.id), aborted: abortedOf(v) }];
    append(req.repo, req.state, [...records, { t: 'run', run, limits: req.limits, key: digest(writeKeyOf(req.resumeKey, req.state, run)) }, ...newAssets(req.repo, v, v.scope ?? [])]);
    return { ...issued(req, run), ...read };
  }),
  // 目標・出発点・台帳と範囲の資産を 1 回の追記で書く（途中で切れると、範囲の無い台帳や出発点の無い状態が残る）。
  goal: (req) => write(req.repo, req.state, req, (v) => {
    if (typeof req.goal !== 'string' || typeof req.origin !== 'string' || !Array.isArray(req.scope) || req.scope.length === 0) reject('E_INPUT', 'goal・origin と 1 件以上の scope が要る');
    if (v.scope !== null) {
      const now = Object.fromEntries(v.premises.map((p) => [p.kind, p.text]));
      if (now.goal !== req.goal || now.origin !== req.origin || JSON.stringify(v.scope) !== JSON.stringify(req.scope)) reject('E_CONFLICT', '既にある目標・出発点・台帳の範囲と食い違う');
      return sameAs(v.records.find((r) => r.t === 'ledger'));
    }
    return [
      { t: 'premise', run: req.run, id: 'P1', kind: 'goal', text: req.goal },
      { t: 'premise', run: req.run, id: 'P2', kind: 'origin', text: req.origin },
      ...newAssets(req.repo, v, req.scope),
      { t: 'ledger', run: req.run, scope: req.scope },
    ];
  }),
  // ヒントを足せるのは再開の鍵を持つ者（開始した利用者）だけ。run の中で再開の鍵を見るのは運搬役だけなので、他の役はヒントを足せない。
  hint: (req) => write(req.repo, req.state, req, (v) => {
    if (!resumeKeyOk(v, req)) reject('E_KEY', '再開の鍵が無いか違う（ヒントは開始の応答の resumeKey を添えて足す）');
    if (typeof req.text !== 'string' || req.text === '') reject('E_INPUT', 'text（ヒントの本文）が要る');
    if ([...v.stops.values()].some((s) => s.kind === 'complete')) reject('E_INPUT', '完了した状態にはヒントを足せない');
    return { t: 'hint', id: `H${v.hints.length + 1}`, text: req.text };
  }, { keyed: false, once: false }),
  // 読んだヒントは、計画役に渡した要約に載ったヒント（script が要約の応答から写す）。停止の判定の「読まれていないヒント」と同じ集合にする。
  plan: (req) => withAfter(req, write(req.repo, req.state, req, (v) => {
    if (!isRound(req.round)) reject('E_INPUT', 'round（周の番号）が要る');
    const records = [];
    for (const i of req.intents ?? []) {
      if (!i.basis?.length || !i.basis.every((b) => known(v, b))) reject('E_UNKNOWN_ID', `受理済みでない根拠: ${i.key}`);
      if (i.recheck !== undefined && !v.disputes.some((d) => d.fact === i.recheck)) reject('E_UNKNOWN_ID', `判定の食い違いの無い事実の確かめ直し: ${i.recheck}`);
      records.push({ t: 'intent', run: req.run, round: req.round, id: `I${v.intents.size + records.length + 1}`, key: i.key, text: i.text, basis: i.basis, rank: i.rank, ...(i.recheck === undefined ? {} : { recheck: i.recheck }) });
    }
    const ranks = req.rerank ?? [];
    for (const r of ranks) if (!v.intents.has(r.intent)) reject('E_UNKNOWN_ID', `状態に無い意図: ${r.intent}`);
    for (const h of req.hintsRead ?? []) if (!v.hints.some((x) => x.id === h)) reject('E_UNKNOWN_ID', `状態に無いヒント: ${h}`);
    records.push({ t: 'rank', run: req.run, round: req.round, ranks, hintsRead: req.hintsRead ?? [] });
    return records;
  }), (v) => ({ pending: pendingOf(v) })),
  // 1 件の意図の事実と意図の終わりを 1 回で書く（件数で運搬役が増えると、意図の最悪の起動数が決まらない。分けると、事実を拒否された後に終わりだけが書かれうる）。
  // 既知の事実は受理済みの記録を変えず、別の記録として足す。判定が食い違えば最初の判定を残し、食い違いを記録して応答で返す（script が BLOCKED で止める）。
  // 食い違いを確かめ直す意図の判定は、その事実の判定として新しい記録（resolve）で足す（3 つ目の判定で決め、同じ食い違いで止まり続けないため）。
  facts: (req) => withAfter(req, write(req.repo, req.state, req, (v) => {
    const intent = v.intents.get(req.intent) ?? reject('E_UNKNOWN_ID', `状態に無い意図: ${req.intent}`);
    if (!Array.isArray(req.facts)) reject('E_INPUT', 'facts は並びでなければならない');
    const added = new Map();
    const records = req.facts.map((f) => {
      if (!Object.hasOwn(METHODS, f.method) || !VERDICTS.includes(f.verdict)) reject('E_INPUT', `検証方式か判定が選択肢に無い（方式は ${Object.keys(METHODS).join('・')}）`);
      // 検証不能の方式の事実は、判定によらず受理しない（確かめていない事実が意図の根拠になるため）。
      const verdict = f.method === 'unverifiable' ? 'unverifiable' : f.verdict;
      const key = factKey(f.text);
      const id = `F${key}`;
      if (intent.recheck === id && !added.has(id)) {
        added.set(id, { verdict });
        return { t: 'resolve', run: req.run, intent: req.intent, fact: id, verdict, text: f.text, evidence: f.evidence };
      }
      const before = added.get(id)?.verdict ?? verdictOf(v, id);
      if (before !== undefined && before !== verdict) return { t: 'dispute', run: req.run, intent: req.intent, fact: id, verdict, text: f.text, evidence: f.evidence };
      if (before !== undefined) return { t: 'known', run: req.run, intent: req.intent, fact: id };
      const record = { t: 'fact', run: req.run, id, key, intent: req.intent, text: f.text, method: f.method, evidence: f.evidence, verdict };
      added.set(id, record);
      return record;
    });
    return [...records, { t: 'done', run: req.run, intent: req.intent, blank: false, disputes: records.filter((r) => r.t === 'dispute').map((r) => r.fact) }];
  }), () => ({})),
  done: (req) => write(req.repo, req.state, req, (v) => {
    if (!v.intents.has(req.intent)) reject('E_UNKNOWN_ID', `状態に無い意図: ${req.intent}`);
    return { t: 'done', run: req.run, intent: req.intent, blank: Boolean(req.blank) };
  }),
  // 試行の失敗は周と試行の番号で区別する（同じ理由の失敗が続いても、送り直しと見分けて 1 回ずつ数える）。
  attempt: (req) => write(req.repo, req.state, req, (v) => {
    if (!isRound(req.round) || !isRound(req.attempt)) reject('E_INPUT', 'round（周の番号）と attempt（試行の番号）が要る');
    const i = v.intents.get(req.intent) ?? reject('E_UNKNOWN_ID', `状態に無い意図: ${req.intent}`);
    return { t: 'attempt', run: req.run, round: req.round, attempt: req.attempt, intent: req.intent, n: i.attempts + 1, aborted: i.attempts + 1 >= v.limits.attempts, reason: req.reason };
  }),
  // 追加の実行の「見た」は意図を持たない。意図を書くのは計画の書き込みだけ。
  seen: (req) => withAfter(req, write(req.repo, req.state, req, (v) => {
    if (!isRound(req.round)) reject('E_INPUT', 'round（周の番号）が要る');
    if (req.extra !== true && !v.intents.has(req.intent)) reject('E_UNKNOWN_ID', `状態に無い意図: ${req.intent}`);
    if (req.extra === true && req.intent !== undefined) reject('E_INPUT', '追加の実行の「見た」は意図を持たない');
    const assets = (req.paths ?? []).map((p) => relOf(req.repo, p)).filter(Boolean).map((p) => ({ id: assetId(p), sha: fileSha(req.repo, p) })).filter((a) => v.assets.has(a.id));
    return { t: 'seen', run: req.run, round: req.round, ...(req.extra === true ? { extra: true } : { intent: req.intent }), assets };
  }), skipOf(req.repo)),
  skip: (req) => skipOf(req.repo)(load(req.repo, req.state)),
  // 連続の数（乾き・全件失敗）は run の中だけで数える（再開した run が、人間の入力が効く前に前の run と同じ理由ですぐ止まらないため）。
  round: (req) => write(req.repo, req.state, req, (v) => {
    if (!isRound(req.round)) reject('E_INPUT', 'round（周の番号）が要る');
    const prev = v.rounds.at(-1);
    const same = prev?.run === req.run;
    const facts = accepted(v).length;
    const newFacts = acceptedSince(v, prev);
    const dry = newFacts === 0 && !req.allFailed ? (same ? prev.dry : 0) + 1 : 0;
    const failed = req.allFailed ? (same ? prev.failed : 0) + 1 : 0;
    const unverifiable = [...v.facts.values()].filter((f) => verdictOf(v, f.id) === 'unverifiable').length;
    return { t: 'round', run: req.run, n: v.rounds.length + 1, launches: req.launches, facts, newFacts, dry, failed, unreadHints: unreadHints(v).length, unverifiable, unverifiableOver: unverifiable > UNVERIFIABLE_MAX,
      limitHit: v.rounds.filter((r) => r.run === req.run).length + 1 >= v.limits.rounds };
  }),
  // 数値条件は目標の前提の numeric の全てに、受理済みの事実が当たっていなければ通さない。応答に目標と挙げた事実の本文を添え、完了の照合の検証役に渡す。
  claim: (req) => withAfter(req, write(req.repo, req.state, req, (v) => {
    if (!isRound(req.round)) reject('E_INPUT', 'round（周の番号）が要る');
    if (!Array.isArray(req.facts)) reject('E_INPUT', 'facts は並びでなければならない');
    for (const h of req.hintsRead ?? []) if (!v.hints.some((x) => x.id === h)) reject('E_UNKNOWN_ID', `状態に無いヒント: ${h}`);
    const missing = req.facts.filter((f) => !known(v, f));
    const conditions = goalOf(v).numeric ?? [];
    const unmet = conditions.map((_, n) => n + 1).filter((n) => !(req.numeric ?? []).some((x) => x.condition === n && known(v, x.fact)));
    const reasons = [missing.length ? `受理済みでない事実: ${missing.join(', ')}` : '', unmet.length ? `受理済みの事実が当たっていない数値条件: ${unmet.join(', ')}` : ''].filter(Boolean);
    const verdict = reasons.length ? 'reject' : req.verdict ?? 'pending';
    return { t: 'claim', run: req.run, round: req.round, id: `C${v.claims.length + 1}`, facts: req.facts, numeric: req.numeric ?? [], verdict, hintsRead: req.hintsRead ?? [], reason: reasons.length ? reasons.join('。') : req.reason ?? '' };
  }), (v) => ({ pending: pendingOf(v), goal: v.premises.find((p) => p.kind === 'goal')?.text ?? '', cited: req.facts.map((id) => ({ id, text: findById(v, id)?.text ?? '' })) })),
  summary: (req) => {
    const v = load(req.repo, req.state);
    return { ...summary(v), premises: v.premises.map(premiseLine).join('\n'), commands: v.commands ?? [], pending: pendingOf(v) };
  },
  // ID か種類（要約の種類の名前）で、要約に載らない細部を引く。読むだけ。
  get: (req) => {
    const v = load(req.repo, req.state);
    if (req.id !== undefined) return { record: findById(v, req.id) ?? reject('E_UNKNOWN_ID', `状態に無い ID: ${req.id}`) };
    const kind = GET_KINDS.find(([k]) => k === req.kind) ?? reject('E_INPUT', `種類が無い（${GET_KINDS.map(([k]) => k).join('・')}）`);
    return { lines: kind[1](v).map((x) => x.line) };
  },
  // 止まるときは停止の記録と返り値の skip 一覧を 1 回の運搬役で運ぶ（予約分を停止の運搬役 1 に保つ）。残した意図の件数の正本は状態から導いた並びなので、理由に CLI が足す。
  stop: (req) => withAfter(req, write(req.repo, req.state, req, (v) => {
    if (!STOP_KINDS.includes(req.kind)) reject('E_INPUT', `停止の種類が無い: ${req.kind}`);
    if (req.round !== undefined && !isRound(req.round)) reject('E_INPUT', 'round（止まった周の番号）は 1 以上の整数');
    const left = pending(v).map((i) => i.id);
    const reason = req.limitHit === 'launch' ? `${req.reason}。残した意図 ${left.length} 件` : req.reason;
    return { t: 'stop', run: req.run, kind: req.kind, reason, limitHit: req.limitHit, cause: req.cause, launches: req.launches, round: req.round, roundLaunches: req.roundLaunches, pending: left, aborted: abortedOf(v) };
  }), (v) => stopView(req.repo, v, v.stops.get(req.run))),
};

// 写しの中で実行してよいコマンドは、開始で状態に記録した再現手順のコマンドだけ（scripts/copy.mjs が読む）。
export function commandsOf(repo, state) {
  if (!STATE_ID.test(String(state))) reject('E_INPUT', `状態 ID の形でない: ${state}`);
  return load(repo, state).commands ?? [];
}

function handle(op, text, fn, needsState) {
  try {
    const req = JSON.parse(text);
    if (typeof req.repo !== 'string' || req.repo === '') reject('E_INPUT', 'repo（調べるリポジトリの絶対パス）が要る');
    if (needsState && !STATE_ID.test(String(req.state))) reject('E_INPUT', 'state（状態 ID）が要る');
    return { code: 0, out: { ok: true, op, ...fn(req) } };
  } catch (error) {
    if (error instanceof Rejected) return { code: 2, out: { ok: false, code: error.code, reason: error.message } };
    return { code: 1, out: { ok: false, code: 'E_INTERNAL', reason: String(error?.stack ?? error) } };
  }
}

export const main = (op, text) => (Object.hasOwn(OPS, op) ? handle(op, text, OPS[op], true) : { code: 2, out: { ok: false, code: 'E_INPUT', reason: `操作が無い: ${op}` } });
export const startMain = (text) => handle('start', text, start, false);

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const { code, out } = main(process.argv[2], Buffer.concat(chunks).toString('utf8'));
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = code;
}
