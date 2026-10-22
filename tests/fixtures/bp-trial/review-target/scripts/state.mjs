#!/usr/bin/env node
// trace-cause の状態の CLI。状態を書くのはこの CLI だけ（script はファイルに触れず、運搬役がこの CLI を呼ぶ）。
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
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
  const v = { runs: [], premises: [], hints: [], intents: new Map(), facts: new Map(), assets: new Map(), seen: new Set(), rounds: [], claims: [], stops: new Map(), asked: new Map(), limits: null, request: null };
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    v.asked.set(r.asked, r);
    if (r.t === 'start') { v.limits = r.limits; v.request = r.request; v.runs.push(r.run); }
    if (r.t === 'run') v.runs.push(r.run);
    if (r.t === 'premise') v.premises.push(r);
    if (r.t === 'hint') v.hints.push(r);
    if (r.t === 'intent') v.intents.set(r.id, { ...r, attempts: 0, status: 'pending' });
    if (r.t === 'rank') for (const x of r.ranks) v.intents.get(x.intent).rank = x.rank;
    if (r.t === 'attempt') { const i = v.intents.get(r.intent); i.attempts += 1; if (r.aborted) i.status = 'aborted'; }
    if (r.t === 'done') v.intents.get(r.intent).status = r.blank ? 'blank' : 'done';
    if (r.t === 'fact') v.facts.set(r.id, r);
    if (r.t === 'asset') v.assets.set(r.id, r);
    if (r.t === 'seen') for (const a of r.assets) v.seen.add(a);
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
const hintsRead = (v) => new Set([...v.asked.values()].filter((r) => r.t === 'rank').flatMap((r) => r.hintsRead ?? []));
const unreadHints = (v) => v.hints.filter((h) => !hintsRead(v).has(h.id));
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
  start(req) {
    if (!req.repo || !req.request) reject('E_INPUT', 'repo と request が要る');
    const state = `tc-${randomBytes(4).toString('hex')}`;
    mkdirSync(dirOf(req.repo, state), { recursive: true });
    appendFileSync(path.join(dirOf(req.repo, state), 'log.jsonl'), `${JSON.stringify({ t: 'start', run: 'r1', request: req.request, limits: req.limits, asked: digest(req) })}\n`);
    return { state, run: 'r1', workDir: path.join(req.repo, STATE_DIR, 'runs', state, 'r1') };
  },
  resume(req) {
    const v = load(req.repo, req.state);
    if (v.stops.get(v.runs.at(-1))?.kind === 'complete') reject('E_INPUT', '完了した状態は再開しない');
    const run = `r${v.runs.length + 1}`;
    write(req.repo, req.state, { op: 'resume', run: undefined, n: v.runs.length }, () => ({ t: 'run', run }));
    return { state: req.state, run, workDir: path.join(req.repo, STATE_DIR, 'runs', req.state, run), rounds: v.rounds.length };
  },
  premise: (req) => write(req.repo, req.state, req, (v) => ({ t: 'premise', run: req.run, id: `P${v.premises.length + 1}`, kind: req.kind, text: req.text })),
  hint(req) {
    const v = load(req.repo, req.state);
    if ([...v.stops.values()].some((s) => s.kind === 'complete')) reject('E_INPUT', '完了した状態にはヒントを足せない');
    return write(req.repo, req.state, req, () => ({ t: 'hint', id: `H${v.hints.length + 1}`, text: req.text }));
  },
  // 計画役が読んだヒントを記録し、停止の判定の「読まれていないヒント」と同じ集合にする。
  plan: (req) => write(req.repo, req.state, req, (v) => {
    const records = [];
    for (const i of req.intents) {
      if (!i.basis?.length || !i.basis.every((b) => known(v, b))) reject('E_UNKNOWN_ID', `受理済みでない根拠: ${i.key}`);
      records.push({ t: 'intent', run: req.run, round: req.round, id: `I${v.intents.size + records.length + 1}`, key: i.key, text: i.text, basis: i.basis, rank: i.rank });
    }
    const ranks = req.rerank ?? [];
    for (const r of ranks) if (!v.intents.has(r.intent)) reject('E_UNKNOWN_ID', `状態に無い意図: ${r.intent}`);
    records.push({ t: 'rank', run: req.run, ranks, hintsRead: req.hintsRead });
    return records;
  }),
  fact: (req) => write(req.repo, req.state, req, (v) => {
    if (!v.intents.has(req.intent)) reject('E_UNKNOWN_ID', `状態に無い意図: ${req.intent}`);
    if (!METHODS.includes(req.method) || !VERDICTS.includes(req.verdict)) reject('E_INPUT', '検証方式か判定が選択肢に無い');
    const key = factKey(req.text);
    const same = [...v.facts.values()].find((f) => f.key === key);
    if (same && same.verdict !== req.verdict) reject('E_CONFLICT', `既にある事実と判定が食い違う: ${same.id}`);
    return { t: 'fact', run: req.run, id: same?.id ?? `F${v.facts.size + 1}`, key, intent: req.intent, text: req.text, method: req.method, evidence: req.evidence, verdict: req.verdict, known: Boolean(same) };
  }),
  done: (req) => write(req.repo, req.state, req, () => ({ t: 'done', run: req.run, intent: req.intent, blank: Boolean(req.blank) })),
  attempt: (req) => write(req.repo, req.state, req, (v) => {
    const i = v.intents.get(req.intent) ?? reject('E_UNKNOWN_ID', `状態に無い意図: ${req.intent}`);
    return { t: 'attempt', run: req.run, intent: req.intent, n: i.attempts + 1, aborted: i.attempts + 1 >= v.limits.attempts, reason: req.reason };
  }),
  ledger: (req) => write(req.repo, req.state, req, (v) => {
    const files = execFileSync('git', ['-C', req.repo, 'ls-files', '--', ...req.scope], { encoding: 'utf8' }).split('\n').filter(Boolean);
    return files.filter((f) => !v.assets.has(`A${digest(f).slice(0, 10)}`)).map((f) => ({ t: 'asset', id: `A${digest(f).slice(0, 10)}`, path: f }));
  }),
  seen: (req) => write(req.repo, req.state, req, (v) => ({ t: 'seen', run: req.run, intent: req.intent, assets: req.paths.map((p) => `A${digest(p).slice(0, 10)}`).filter((a) => v.assets.has(a)) })),
  skip: (req) => { const v = load(req.repo, req.state); return { skip: [...v.assets.values()].filter((a) => !v.seen.has(a.id)).map((a) => a.path), coverage: `${v.seen.size}/${v.assets.size}` }; },
  round: (req) => write(req.repo, req.state, req, (v) => {
    const before = v.rounds.at(-1)?.facts ?? 0;
    const facts = [...v.facts.values()].filter((f) => f.verdict === 'accept' && !f.known).length;
    const dry = facts === before ? (v.rounds.at(-1)?.dry ?? 0) + 1 : 0;
    const failed = req.allFailed ? (v.rounds.at(-1)?.failed ?? 0) + 1 : 0;
    return { t: 'round', run: req.run, n: v.rounds.length + 1, launches: req.launches, facts, dry, failed, unreadHints: unreadHints(v).length, limitHit: v.rounds.length + 1 >= v.limits.rounds };
  }),
  claim: (req) => write(req.repo, req.state, req, (v) => {
    const missing = req.facts.filter((f) => !known(v, f));
    const numeric = (req.numeric ?? []).filter((n) => !known(v, n.fact));
    const verdict = missing.length || numeric.length ? 'reject' : req.verdict ?? 'pending';
    return { t: 'claim', run: req.run, id: `C${v.claims.length + 1}`, facts: req.facts, verdict, reason: missing.length ? `受理済みでない事実: ${missing.join(', ')}` : req.reason ?? '' };
  }),
  summary: (req) => { const v = load(req.repo, req.state); return { summary: summary(v), pending: pending(v).map((i) => ({ id: i.id, text: i.text, rank: i.rank })) }; },
  stop: (req) => write(req.repo, req.state, req, (v) => {
    if (!STOP_KINDS.includes(req.kind)) reject('E_INPUT', `停止の種類が無い: ${req.kind}`);
    return { t: 'stop', run: req.run, kind: req.kind, reason: req.reason, launches: req.launches, pending: pending(v).map((i) => i.id), aborted: [...v.intents.values()].filter((i) => i.status === 'aborted').map((i) => i.id) };
  }),
};

export function main(op, text) {
  try {
    if (!Object.hasOwn(OPS, op)) reject('E_INPUT', `操作が無い: ${op}`);
    return { code: 0, out: { ok: true, op, ...OPS[op](JSON.parse(text)) } };
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
