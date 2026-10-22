#!/usr/bin/env node
// trace-cause の状態の CLI。状態を書くのはこの CLI だけ（script はファイルに触れず、運搬役がこの CLI を呼ぶ）。
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE_DIR = '.trace-cause';
const SUMMARY_MAX_CHARS = 8000;
const STOP_KINDS = ['complete', 'dry', 'needs_input', 'iteration_limit', 'blocked'];
const METHODS = ['refetch', 'rerun', 'citation', 'unverifiable'];
const VERDICTS = ['accept', 'reject', 'unverifiable'];

class Rejected extends Error {
  constructor(code, reason) {
    super(reason);
    this.code = code;
  }
}

const reject = (code, reason) => { throw new Rejected(code, reason); };
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
// 既知の事実の照合は言い換えに強いキーで行う（空白と句読点の違いを同じ事実と数える）。
const factKey = (text) => digest(text.normalize('NFKC').replace(/[\s、。,.]/g, '').toLowerCase()).slice(0, 12);

function dirOf(repo, state) {
  return path.join(repo, STATE_DIR, 'states', state);
}

function load(repo, state) {
  const file = path.join(dirOf(repo, state), 'log.jsonl');
  if (!existsSync(file)) reject('E_UNKNOWN_ID', `状態が無い: ${state}`);
  const v = { runs: [], premises: [], hints: [], intents: new Map(), facts: new Map(), assets: new Map(), seen: new Map(), scope: null, rounds: [], claims: [], stops: new Map(), asked: new Map(), limits: null, request: null };
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    v.asked.set(r.asked, r);
    if (r.t === 'start') { v.limits = r.limits; v.request = r.request; v.key = r.key; v.runs.push(r.run); }
    if (r.t === 'run') v.runs.push(r.run);
    if (r.t === 'premise') v.premises.push(r);
    if (r.t === 'hint') v.hints.push(r);
    if (r.t === 'intent') v.intents.set(r.id, { ...r, attempts: 0, status: 'pending' });
    if (r.t === 'rank') for (const x of r.ranks) v.intents.get(x.intent).rank = x.rank;
    if (r.t === 'attempt') { const i = v.intents.get(r.intent); i.attempts += 1; if (r.aborted) i.status = 'aborted'; }
    if (r.t === 'done') v.intents.get(r.intent).status = r.blank ? 'blank' : 'done';
    if (r.t === 'fact') v.facts.set(r.id, r);
    if (r.t === 'asset') v.assets.set(r.id, r);
    if (r.t === 'ledger') v.scope = r.scope;
    if (r.t === 'seen') for (const a of r.assets) v.seen.set(a.id, a.sha);
    if (r.t === 'round') v.rounds.push(r);
    if (r.t === 'claim') v.claims.push(r);
    if (r.t === 'stop') v.stops.set(r.run, r);
  }
  return v;
}

// 同じ要求の繰り返しは同じ記録を返す（runtime が agent を再起動して同じ書き込みを送り直しても状態が変わらない）。
function write(repo, state, req, make) {
  const asked = digest(req);
  const v = load(repo, state);
  if (v.asked.has(asked)) return { ...v.asked.get(asked), same: true };
  if (req.run !== undefined && req.run !== v.runs.at(-1)) reject('E_STALE_RUN', `現在の run でない: ${req.run}`);
  if (req.run !== undefined && v.stops.has(req.run)) reject('E_STALE_RUN', `停止を書いた後の run: ${req.run}`);
  const records = [make(v)].flat().map((r) => ({ ...r, asked }));
  for (const r of records) appendFileSync(path.join(dirOf(repo, state), 'log.jsonl'), `${JSON.stringify(r)}\n`);
  return records.at(-1);
}

const known = (v, id) => v.facts.get(id)?.verdict === 'accept' || v.premises.some((p) => p.id === id);
// 計画役が読んだと返したヒント（意図を返したときも完了を主張したときも）だけを、停止の判定で読まれたと数える。
const hintsRead = (v) => new Set([...v.asked.values()].filter((r) => r.t === 'rank' || r.t === 'claim').flatMap((r) => r.hintsRead ?? []));
const unreadHints = (v) => v.hints.filter((h) => !hintsRead(v).has(h.id));
// 台帳の結び付きとカバレッジは対象の今の内容に基づかせる（見た後に変わったファイルと、消えたファイルは見たと数えない）。
const fileSha = (repo, rel) => { try { return digest(readFileSync(path.join(repo, rel), 'utf8')); } catch { return null; } };
const liveAssets = (repo, v) => [...v.assets.values()].filter((a) => fileSha(repo, a.path) !== null);
const skipOf = (repo) => (v) => {
  const live = liveAssets(repo, v);
  const seen = live.filter((a) => v.seen.get(a.id) === fileSha(repo, a.path));
  return { skip: live.filter((a) => !seen.includes(a)).map((a) => a.path), coverage: `${seen.length}/${live.length}` };
};
const pendingOf = (v) => pending(v).map((i) => ({ id: i.id, text: i.text, rank: i.rank }));
// 書き込みの応答に書いた後の状態の読み出しを添える（読み出しのためだけに運搬役を 1 回増やさない）。
const withAfter = (req, record, read) => ({ ...record, ...read(load(req.repo, req.state)) });
// 資産 ID はパスから決める（台帳を取り直しても、同じファイルは同じ ID）。再開では範囲の今のファイルを足し直す。
const newAssets = (repo, v, scope) => execFileSync('git', ['-C', repo, 'ls-files', '--', ...scope], { encoding: 'utf8' }).split('\n').filter(Boolean)
  .filter((f) => !v.assets.has(`A${digest(f).slice(0, 10)}`)).map((f) => ({ t: 'asset', id: `A${digest(f).slice(0, 10)}`, path: f }));
const pending = (v) => [...v.intents.values()].filter((i) => i.status === 'pending').sort((a, b) => a.rank - b.rank);

function summary(v) {
  const lines = [`目標: ${v.premises.find((p) => p.kind === 'goal')?.text ?? ''}`, `周: ${v.rounds.length}`];
  const parts = [
    ...[...v.facts.values()].filter((f) => f.verdict === 'accept').map((f) => `事実 ${f.id}: ${f.text}`),
    ...[...v.facts.values()].filter((f) => f.verdict === 'unverifiable').map((f) => `検証不能 ${f.id}: ${f.text}`),
    ...pending(v).map((i) => `未着手 ${i.id}（順位 ${i.rank}）: ${i.text}`),
    ...[...v.intents.values()].filter((i) => i.status === 'aborted').map((i) => `打ち切り ${i.id}: ${i.text}`),
    ...v.claims.filter((c) => c.verdict === 'reject').map((c) => `却下した完了の主張 ${c.id}: ${c.reason}`),
    ...unreadHints(v).map((h) => `読まれていないヒント ${h.id}: ${h.text}`),
  ];
  let text = lines.join('\n');
  let omitted = 0;
  for (const p of parts) {
    if (text.length + p.length + 1 > SUMMARY_MAX_CHARS - 80) omitted += 1;
    else text += `\n${p}`;
  }
  if (omitted) text += `\n載せなかった項目: ${omitted} 件（ID で引ける）`;
  return text;
}

const OPS = {
  // 同じ鍵の開始の送り直しは、停止の無い最初の run の状態を返す（runtime が運搬役を再起動しても状態を 2 つ作らない）。
  start(req) {
    if (!req.repo || !req.request || !req.key) reject('E_INPUT', 'repo と request と key が要る');
    const root = path.join(req.repo, STATE_DIR, 'states');
    for (const id of existsSync(root) ? readdirSync(root) : []) {
      const v = load(req.repo, id);
      if (v.key === req.key && v.runs.length === 1 && v.stops.size === 0) return { state: id, run: 'r1', workDir: path.join(req.repo, STATE_DIR, 'runs', id, 'r1'), same: true };
    }
    const state = `tc-${randomBytes(4).toString('hex')}`;
    mkdirSync(dirOf(req.repo, state), { recursive: true });
    appendFileSync(path.join(dirOf(req.repo, state), 'log.jsonl'), `${JSON.stringify({ t: 'start', run: 'r1', key: req.key, request: req.request, limits: req.limits, asked: digest(req) })}\n`);
    return { state, run: 'r1', workDir: path.join(req.repo, STATE_DIR, 'runs', state, 'r1') };
  },
  resume(req) {
    const v = load(req.repo, req.state);
    if (v.stops.get(v.runs.at(-1))?.kind === 'complete') reject('E_INPUT', '完了した状態は再開しない');
    const run = `r${v.runs.length + 1}`;
    write(req.repo, req.state, { op: 'resume', run: undefined, n: v.runs.length }, () => [{ t: 'run', run }, ...newAssets(req.repo, v, v.scope ?? [])]);
    return { state: req.state, run, workDir: path.join(req.repo, STATE_DIR, 'runs', req.state, run), rounds: v.rounds.length };
  },
  premise: (req) => write(req.repo, req.state, req, (v) => ({ t: 'premise', run: req.run, id: `P${v.premises.length + 1}`, kind: req.kind, text: req.text })),
  hint(req) {
    const v = load(req.repo, req.state);
    if ([...v.stops.values()].some((s) => s.kind === 'complete')) reject('E_INPUT', '完了した状態にはヒントを足せない');
    return write(req.repo, req.state, req, () => ({ t: 'hint', id: `H${v.hints.length + 1}`, text: req.text }));
  },
  // 計画役が読んだヒントを記録し、停止の判定の「読まれていないヒント」と同じ集合にする。
  plan: (req) => withAfter(req, write(req.repo, req.state, req, (v) => {
    const records = [];
    for (const i of req.intents) {
      if (!i.basis?.length || !i.basis.every((b) => known(v, b))) reject('E_UNKNOWN_ID', `受理済みでない根拠: ${i.key}`);
      records.push({ t: 'intent', run: req.run, round: req.round, id: `I${v.intents.size + records.length + 1}`, key: i.key, text: i.text, basis: i.basis, rank: i.rank });
    }
    const ranks = req.rerank ?? [];
    for (const r of ranks) if (!v.intents.has(r.intent)) reject('E_UNKNOWN_ID', `状態に無い意図: ${r.intent}`);
    records.push({ t: 'rank', run: req.run, ranks, hintsRead: req.hintsRead });
    return records;
  }), (v) => ({ pending: pendingOf(v) })),
  // 1 件の意図の事実をまとめて書く（件数で運搬役が増えると、意図の最悪の起動数が決まらない）。
  facts: (req) => withAfter(req, write(req.repo, req.state, req, (v) => {
    if (!v.intents.has(req.intent)) reject('E_UNKNOWN_ID', `状態に無い意図: ${req.intent}`);
    if (!Array.isArray(req.facts)) reject('E_INPUT', 'facts は並びでなければならない');
    const added = [];
    return req.facts.map((f) => {
      if (!METHODS.includes(f.method) || !VERDICTS.includes(f.verdict)) reject('E_INPUT', '検証方式か判定が選択肢に無い');
      const key = factKey(f.text);
      const same = [...v.facts.values(), ...added].find((x) => x.key === key);
      if (same && same.verdict !== f.verdict) reject('E_CONFLICT', `既にある事実と判定が食い違う: ${same.id}`);
      const record = { t: 'fact', run: req.run, id: same?.id ?? `F${v.facts.size + added.length + 1}`, key, intent: req.intent, text: f.text, method: f.method, evidence: f.evidence, verdict: f.verdict, known: Boolean(same) };
      if (!same) added.push(record);
      return record;
    });
  }), () => ({})),
  done: (req) => write(req.repo, req.state, req, (v) => {
    if (!v.intents.has(req.intent)) reject('E_UNKNOWN_ID', `状態に無い意図: ${req.intent}`);
    return { t: 'done', run: req.run, intent: req.intent, blank: Boolean(req.blank) };
  }),
  attempt: (req) => write(req.repo, req.state, req, (v) => {
    const i = v.intents.get(req.intent) ?? reject('E_UNKNOWN_ID', `状態に無い意図: ${req.intent}`);
    return { t: 'attempt', run: req.run, intent: req.intent, n: i.attempts + 1, aborted: i.attempts + 1 >= v.limits.attempts, reason: req.reason };
  }),
  ledger: (req) => write(req.repo, req.state, req, (v) => [{ t: 'ledger', run: req.run, scope: req.scope }, ...newAssets(req.repo, v, req.scope)]),
  seen: (req) => withAfter(req, write(req.repo, req.state, req, (v) => ({ t: 'seen', run: req.run, intent: req.intent, assets: req.paths.map((p) => ({ id: `A${digest(p).slice(0, 10)}`, sha: fileSha(req.repo, p) })).filter((a) => v.assets.has(a.id)) })), skipOf(req.repo)),
  skip: (req) => skipOf(req.repo)(load(req.repo, req.state)),
  // 連続の数（乾き・全件失敗）は run の中だけで数える（再開した run が、人間の入力が効く前に前の run と同じ理由ですぐ止まらないため）。
  round: (req) => write(req.repo, req.state, req, (v) => {
    const prev = v.rounds.at(-1);
    const same = prev?.run === req.run;
    const facts = [...v.facts.values()].filter((f) => f.verdict === 'accept' && !f.known).length;
    const newFacts = facts - (prev?.facts ?? 0);
    const dry = newFacts === 0 ? (same ? prev.dry : 0) + 1 : 0;
    const failed = req.allFailed ? (same ? prev.failed : 0) + 1 : 0;
    return { t: 'round', run: req.run, n: v.rounds.length + 1, launches: req.launches, facts, newFacts, dry, failed, unreadHints: unreadHints(v).length, limitHit: v.rounds.filter((r) => r.run === req.run).length + 1 >= v.limits.rounds };
  }),
  claim: (req) => withAfter(req, write(req.repo, req.state, req, (v) => {
    const missing = req.facts.filter((f) => !known(v, f));
    const numeric = (req.numeric ?? []).filter((n) => !known(v, n.fact));
    const verdict = missing.length || numeric.length ? 'reject' : req.verdict ?? 'pending';
    return { t: 'claim', run: req.run, id: `C${v.claims.length + 1}`, facts: req.facts, verdict, hintsRead: req.hintsRead, reason: missing.length ? `受理済みでない事実: ${missing.join(', ')}` : req.reason ?? '' };
  }), (v) => ({ pending: pendingOf(v) })),
  summary: (req) => { const v = load(req.repo, req.state); return { summary: summary(v), pending: pendingOf(v) }; },
  // 止まるときは停止の記録と返り値の skip 一覧を 1 回の運搬役で運ぶ（予約分を停止の運搬役 1 に保つ）。残した意図の件数の正本は状態から導いた並びなので、理由に CLI が足す。
  stop: (req) => withAfter(req, write(req.repo, req.state, req, (v) => {
    if (!STOP_KINDS.includes(req.kind)) reject('E_INPUT', `停止の種類が無い: ${req.kind}`);
    const left = pending(v).map((i) => i.id);
    const reason = req.limitHit === 'launch' ? `${req.reason}。残した意図 ${left.length} 件` : req.reason;
    return { t: 'stop', run: req.run, kind: req.kind, reason, limitHit: req.limitHit, launches: req.launches, roundLaunches: req.roundLaunches, pending: left, aborted: [...v.intents.values()].filter((i) => i.status === 'aborted').map((i) => i.id) };
  }), (v) => ({ ...skipOf(req.repo)(v), facts: [...v.facts.values()].filter((f) => f.verdict === 'accept').map((f) => ({ id: f.id, text: f.text, method: f.method, evidence: f.evidence })) })),
};

export function main(op, text) {
  try {
    if (!Object.hasOwn(OPS, op)) reject('E_INPUT', `操作が無い: ${op}`);
    const req = JSON.parse(text);
    if (typeof req.repo !== 'string' || req.repo === '') reject('E_INPUT', 'repo（調べるリポジトリの絶対パス）が要る');
    if (op !== 'start' && (typeof req.state !== 'string' || req.state === '')) reject('E_INPUT', 'state（状態 ID）が要る');
    return { code: 0, out: { ok: true, op, ...OPS[op](req) } };
  } catch (error) {
    if (error instanceof Rejected) return { code: 2, out: { ok: false, code: error.code, reason: error.message } };
    return { code: 1, out: { ok: false, code: 'E_INTERNAL', reason: String(error?.stack ?? error) } };
  }
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const { code, out } = main(process.argv[2], Buffer.concat(chunks).toString('utf8'));
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = code;
}
