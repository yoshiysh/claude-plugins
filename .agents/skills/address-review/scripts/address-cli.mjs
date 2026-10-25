#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AddressError, CODES, DEFAULT_POLICY_REF, NEXT_BY_CODE, REPOSITORY, STOP_AFTER, buildItems, changedTargets, confirmNext, confirmPlacement, fixNext,
  fixRequest, fnvSum, isSha, newState, nextOfError, planReplies, readTriage, selectTargets, splitDecisions, stateProblem, triageNext,
} from './address-core.mjs'

const STATE_FILE = 'address-review-state.json'
const REPLIES_FILE = 'address-review-replies.json'
const TRIAGE_FILE = 'address-review-triage.json'
const MAX_BUFFER = 64 * 1024 * 1024
const EXIT = Object.freeze({ ok: 0, rejected: 1, usage: 2 })

// reviewThreads の 1 ページ。root の comment だけを取れば thread と inline comment を databaseId で結べる（返信は REST の in_reply_to_id で結ぶ）。
export const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved isOutdated comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}`

export function defaultIo() {
  const run = (cmd, args, cwd, allowFailure) => {
    try {
      // argv で渡し、shell を通さない（コメントの本文や branch 名が命令として解釈されないため）。
      return execFileSync(cmd, args, { cwd, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).toString('utf8')
    } catch (error) {
      if (allowFailure && error.status === 1) return null
      throw new AddressError(CODES.io, `${cmd} ${args.map((arg) => (arg.startsWith('query=') ? 'query=…' : arg)).join(' ')} が失敗した: ${String(error.stderr ?? error.message).trim()}`)
    }
  }
  return {
    git: (repo, args, { allowFailure = false } = {}) => run('git', ['-C', repo, ...args], undefined, allowFailure),
    gh: (repo, args) => run('gh', args, repo, false),
    realpath: (file) => realpathSync(file),
    exists: (file) => existsSync(file),
    readFile: (file) => readFileSync(file, 'utf8'),
    writeFile(file, text) {
      const tmp = `${file}.tmp`
      writeFileSync(tmp, text)
      renameSync(tmp, file)
    },
  }
}

function parseJson(text, what) {
  try {
    return JSON.parse(text)
  } catch {
    throw new AddressError(CODES.io, `${what} の応答が JSON として読めない`)
  }
}

const ghJson = (io, repo, args, what) => parseJson(io.gh(repo, args), what)
const pages = (io, repo, endpoint) => ghJson(io, repo, ['api', '--paginate', '--slurp', `${endpoint}?per_page=100`], endpoint).flat()

export function fetchDiscussion(io, repo, pr) {
  const base = `repos/${REPOSITORY}`
  const [owner, name] = REPOSITORY.split('/')
  const threadPages = ghJson(io, repo, ['api', 'graphql', '--paginate', '--slurp', '-f', `query=${THREADS_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${pr}`], 'reviewThreads')
  const threads = threadPages.flatMap((p) => {
    const connection = p?.data?.repository?.pullRequest?.reviewThreads
    if (!connection || !Array.isArray(connection.nodes)) throw new AddressError(CODES.io, 'reviewThreads の応答の形が違う')
    return connection.nodes
  })
  return {
    inline: pages(io, repo, `${base}/pulls/${pr}/comments`),
    issues: pages(io, repo, `${base}/issues/${pr}/comments`),
    reviews: pages(io, repo, `${base}/pulls/${pr}/reviews`),
    threads,
  }
}

function prView(io, repo, pr) {
  return ghJson(io, repo, ['pr', 'view', String(pr), '--repo', REPOSITORY, '--json', 'number,state,isCrossRepository,headRefName,headRefOid,baseRefOid'], 'gh pr view')
}

function requirePr(view) {
  if (view.state !== 'OPEN') throw new AddressError(CODES.pin, `PR #${view.number} は ${view.state}。開いている PR だけを扱う`)
  // fork の head は push 先が別のリポジトリで、書き込みの権限と配信先をこの情報からは決められない。
  if (view.isCrossRepository) throw new AddressError(CODES.pin, `PR #${view.number} の head は fork にある。push と返信をしない`)
}

const head = (io, repo) => io.git(repo, ['rev-parse', 'HEAD']).trim()

function readState(body, io) {
  if (typeof body.statePath !== 'string' || !io.exists(body.statePath)) throw new AddressError(CODES.input, 'statePath は collect の出力の state_path')
  const state = parseJson(io.readFile(body.statePath), 'state のファイル')
  const problem = stateProblem(state, body.stateSum)
  if (problem) throw new AddressError(CODES.input, problem)
  return state
}

// stateDir に CLI が書く記録（sum つき）。成功した op だけが書く。
const fileOf = (body, name) => path.join(path.dirname(body.statePath), name)

function readRecord(io, file, stateSum, what) {
  if (!io.exists(file)) return null
  const { sum, ...rest } = parseJson(io.readFile(file), what)
  if (fnvSum(rest) !== sum || rest.stateSum !== stateSum) throw new AddressError(CODES.state, `${what}が壊れているか、別の run のもの`)
  return rest
}

function writeRecord(io, file, record) {
  io.writeFile(file, JSON.stringify({ ...record, sum: fnvSum(record) }, null, 2))
}

function triageInput(body, io) {
  if (body.triage !== undefined && body.triagePath !== undefined) throw new AddressError(CODES.input, 'triage と triagePath のどちらか一方を渡す')
  if (body.triagePath !== undefined && (typeof body.triagePath !== 'string' || !io.exists(body.triagePath))) {
    throw new AddressError(CODES.input, 'triagePath は分類の Workflow の返り値を残したファイルの path')
  }
  if (typeof body.triagePath === 'string') return parseJson(io.readFile(body.triagePath), 'triagePath のファイル')
  if (body.triage === undefined) throw new AddressError(CODES.input, 'triage（分類の Workflow の返り値）か triagePath を渡す')
  return body.triage
}

function acceptedTriage(body, io, state) {
  const record = readRecord(io, fileOf(body, TRIAGE_FILE), body.stateSum, '分類の記録')
  if (!record?.accepted) throw new AddressError(CODES.state, '受け入れた分類が無い（triage-result が completed を受け入れた後に流す）')
  return record.accepted
}

function collect(body, io) {
  const { repo, pr, stateDir } = body
  if (typeof repo !== 'string' || !path.isAbsolute(repo)) throw new AddressError(CODES.input, 'repo は PR の head を checkout した作業ツリーの絶対パス')
  if (!Number.isSafeInteger(pr) || pr < 1) throw new AddressError(CODES.input, 'pr は PR の番号（整数）')
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir) || !io.exists(stateDir)) throw new AddressError(CODES.input, 'stateDir は repo の外に作った既存のディレクトリの絶対パス')
  const stopAfter = body.stopAfter ?? 'reply'
  if (!Object.hasOwn(STOP_AFTER, stopAfter)) throw new AddressError(CODES.input, `stopAfter は ${Object.keys(STOP_AFTER).join('・')} のどれか`)
  const root = io.realpath(io.git(repo, ['rev-parse', '--show-toplevel']).trim())
  const dir = io.realpath(stateDir)
  const rel = path.relative(root, dir)
  if (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) throw new AddressError(CODES.input, 'stateDir は repo の外に置く（中に置くと作業ツリーの変更として repo-implement の照合に混ざる）')
  const statePath = path.join(dir, STATE_FILE)
  // 1 つの stateDir は 1 周（収集 → 分類 → 修正 → 返信）だけに使う。次の周は新しい stateDir の collect から。
  if (io.exists(statePath)) throw new AddressError(CODES.state, 'この stateDir は前の run が使った。新しい stateDir で collect する', { next: 'fix_input' })

  const repository = ghJson(io, repo, ['repo', 'view', '--json', 'nameWithOwner'], 'gh repo view').nameWithOwner
  if (repository !== REPOSITORY) throw new AddressError(CODES.pin, `作業ツリーのリポジトリが ${repository}。このスキルは ${REPOSITORY} の PR だけを扱う`)
  const view = prView(io, repo, pr)
  requirePr(view)
  const now = head(io, repo)
  const branch = io.git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true })?.trim() ?? null
  if (now !== view.headRefOid || branch !== view.headRefName) {
    throw new AddressError(CODES.pin, `作業ツリー（branch ${branch ?? '(detached)'}・HEAD ${now}）が PR の head（branch ${view.headRefName}・${view.headRefOid}）と違う。PR の head branch を checkout した作業ツリーで始める`)
  }
  // 分類は作業ツリーを PR の head として読むので、head に無いローカルの変更を根拠にした返信が公開されないようにする。
  const dirty = io.git(repo, ['status', '--porcelain', '--untracked-files=all']).trim()
  if (dirty) throw new AddressError(CODES.pin, `作業ツリーに commit していない変更がある（${dirty.split('\n').length} 件）。commit するか片付けた clean な作業ツリーで始める`)
  const policyRef = io.git(repo, ['rev-parse', '--verify', '--quiet', `${DEFAULT_POLICY_REF}^{commit}`], { allowFailure: true })?.trim()
  if (!policyRef) throw new AddressError(CODES.pin, `方針の版 ${DEFAULT_POLICY_REF} が手元に無い`, { next: 'fetch_and_retry' })
  const viewer = ghJson(io, repo, ['api', 'user'], 'gh api user').login
  if (typeof viewer !== 'string' || !viewer) throw new AddressError(CODES.io, 'gh の認証ユーザーの login が取れない')
  const all = buildItems(fetchDiscussion(io, repo, pr))
  const { items, excluded } = selectTargets(all, { viewer, include: body.include, only: body.only })
  const { kept, dropped } = splitDecisions(body.decisions, items)
  const state = newState({ repo: root, pr, view, head: now, branch, policyRef, viewer, items, excluded, decisions: kept, stopAfter })
  const stateSum = fnvSum(state)
  io.writeFile(statePath, JSON.stringify(state, null, 2))
  return { next: items.length ? 'classify' : 'report', state, state_sum: stateSum, state_path: statePath, items: items.length, excluded, dropped_decisions: dropped }
}

function triageResult(body, io) {
  const state = readState(body, io)
  const file = fileOf(body, TRIAGE_FILE)
  const record = readRecord(io, file, body.stateSum, '分類の記録') ?? { stateSum: body.stateSum, retries: 0, accepted: null }
  if (record.accepted) throw new AddressError(CODES.state, 'この run の分類は既に受け入れた（分類は 1 周に 1 回）')
  const triage = readTriage(triageInput(body, io), state, body.stateSum)
  const route = triageNext(triage, state, record.retries)
  const { sum: _sum, stateSum: _stateSum, results, ...detail } = triage
  if (route.next === 'classify_again') writeRecord(io, file, { ...record, retries: record.retries + 1 })
  if (triage.status !== 'completed') return { ...route, ...detail, results: results ?? null }
  const fix = fixRequest(state, results)
  writeRecord(io, file, { ...record, accepted: { results, commit_message: fix.commit_message } })
  return { ...route, results, ...(route.next === 'implement' ? { request: fix.request, fix_ids: fix.fix_ids } : {}) }
}

function recordFix(body, io) {
  const state = readState(body, io)
  const accepted = acceptedTriage(body, io, state)
  if (!accepted.commit_message) throw new AddressError(CODES.state, 'fix の指摘が無い run に修正の結果は要らない')
  const hasVerify = Object.hasOwn(body, 'verify')
  if (hasVerify === Object.hasOwn(body, 'stopped')) throw new AddressError(CODES.input, 'verify（repo-implement の verify の出力）か stopped（止まった理由）のどちらか一方を渡す')
  if (hasVerify && (!body.verify || typeof body.verify.passed !== 'boolean' || !Array.isArray(body.verify.actual))) {
    throw new AddressError(CODES.input, 'verify は repo-implement の verify の出力をそのまま渡す（passed と actual を持つ）')
  }
  if (!hasVerify && (typeof body.stopped !== 'string' || !body.stopped.trim())) throw new AddressError(CODES.input, 'stopped は repo-implement が止まった理由の文')
  const route = fixNext(state, { verify: body.verify, stopped: body.stopped })
  return route.next === 'commit_push' ? { ...route, commit_message: accepted.commit_message, branch: state.branch } : route
}

function recheck(body, io) {
  const state = readState(body, io)
  const { results } = acceptedTriage(body, io, state)
  const repliesPath = fileOf(body, REPLIES_FILE)
  if (io.exists(repliesPath)) throw new AddressError(CODES.state, 'この run の返信は既に組んだ（返信は 1 周に 1 回。新しい指摘・やり直しは次の run）')
  if (!Object.hasOwn(body, 'fixCommit') || (body.fixCommit !== null && !isSha(body.fixCommit))) {
    throw new AddressError(CODES.input, 'fixCommit は push した修正の commit の完全な SHA か、修正を push していなければ null')
  }
  const hasFix = results.some((r) => r.classification === 'fix')
  if (body.fixCommit && !hasFix) throw new AddressError(CODES.input, 'fix の指摘が無いのに fixCommit がある')

  const view = prView(io, state.repo, state.pr)
  requirePr(view)
  let fix = null
  if (body.fixCommit) {
    // push した commit が PR の head で、その唯一の親が collect の head（この run の修正 1 つだけが足された）のときに限る。
    if (view.headRefOid === state.head) {
      throw new AddressError(CODES.state, `PR の head が collect の時のまま（${state.head}）で、push が GitHub に反映されていない`, { next: 'wait_and_retry' })
    }
    if (view.headRefOid !== body.fixCommit) throw new AddressError(CODES.state, `PR の head（${view.headRefOid}）が push した修正の commit（${body.fixCommit}）と違う。返信を止め、次の run で分類からやり直す`)
    const [, ...parents] = io.git(state.repo, ['rev-list', '--parents', '-n', '1', body.fixCommit]).trim().split(/\s+/)
    if (parents.length !== 1 || parents[0] !== state.head) throw new AddressError(CODES.state, `修正の commit の親（${parents.join(', ')}）が collect の head ${state.head} だけではない。返信を止め、次の run で分類からやり直す`)
    fix = { commit: body.fixCommit, paths: io.git(state.repo, ['diff', '--name-only', state.head, body.fixCommit]).trim().split('\n').filter(Boolean) }
  } else if (view.headRefOid !== state.head) {
    throw new AddressError(CODES.state, `PR の head が collect の後に動いた（${state.head} → ${view.headRefOid}）。返信を止め、次の run で分類からやり直す`)
  }
  if (state.stopAfter !== 'reply') return { next: 'report', pushed: fix?.commit ?? null }

  const planned = planReplies(state, results, fix)
  const all = buildItems(fetchDiscussion(io, state.repo, state.pr))
  const changed = changedTargets(state, all, planned.replies)
  const changedIds = new Set(changed.map((c) => c.comment_id))
  const postable = planned.replies.filter((r) => r.comment_ids.every((id) => !changedIds.has(id)))
  const blocked = planned.replies.filter((r) => !postable.includes(r)).map((r) => ({ comment_ids: r.comment_ids, changed: changed.filter((c) => r.comment_ids.includes(c.comment_id)) }))
  const known = new Set([...state.items.map((i) => i.comment_id), ...state.excluded.map((e) => e.comment_id)])
  const newItems = selectTargets(all, { viewer: state.viewer }).items.map((i) => i.comment_id).filter((id) => !known.has(id))

  const dir = path.dirname(body.statePath)
  const replies = postable.map((r, n) => {
    const inputPath = path.join(dir, `reply-${n + 1}.json`)
    io.writeFile(inputPath, JSON.stringify(r.payload))
    return { ...r, input_path: inputPath }
  })
  writeRecord(io, repliesPath, { stateSum: body.stateSum, replies, confirmations: 0 })
  return {
    next: replies.length ? 'post' : 'report',
    replies: replies.map((r) => ({ comment_ids: r.comment_ids, endpoint: r.endpoint, input_path: r.input_path })),
    skipped: planned.skipped,
    blocked,
    new_items: newItems,
  }
}

function confirmReplies(body, io) {
  const state = readState(body, io)
  const repliesPath = fileOf(body, REPLIES_FILE)
  const record = readRecord(io, repliesPath, body.stateSum, '返信の記録')
  if (!record) throw new AddressError(CODES.state, '返信の記録が無い（recheck の後に流す）')
  const { inline, issues } = fetchDiscussion(io, state.repo, state.pr)
  const placement = confirmPlacement(record.replies, inline, issues)
  const attempt = record.confirmations + 1
  writeRecord(io, repliesPath, { ...record, confirmations: attempt })
  return { ...confirmNext(placement, attempt), ...placement }
}

const OPS = { collect, 'triage-result': triageResult, 'record-fix': recordFix, recheck, 'confirm-replies': confirmReplies }

export function run(op, body, io) {
  if (!Object.hasOwn(OPS, op)) throw new AddressError(CODES.input, `使い方: address-cli.mjs <${Object.keys(OPS).join('|')}>（入力は stdin の JSON）`)
  return OPS[op](body, io)
}

function respond(payload, exitCode) {
  return { exitCode, output: JSON.stringify(payload) }
}

export function main(argv, input, io = defaultIo()) {
  const op = argv[0]
  if (!Object.hasOwn(OPS, op) || argv.length !== 1) {
    return respond({ ok: false, op: op ?? null, code: CODES.input, next: 'fix_input', reason: `使い方: address-cli.mjs <${Object.keys(OPS).join('|')}>（入力は stdin の JSON）` }, EXIT.usage)
  }
  let body
  try {
    body = JSON.parse(input)
  } catch {
    return respond({ ok: false, op, code: CODES.input, next: 'fix_input', reason: '入力が JSON として読めない' }, EXIT.usage)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return respond({ ok: false, op, code: CODES.input, next: 'fix_input', reason: '入力は JSON のオブジェクト' }, EXIT.usage)
  try {
    return respond({ ok: true, op, ...run(op, body, io) }, EXIT.ok)
  } catch (error) {
    if (error instanceof AddressError) return respond({ ok: false, op, code: error.code, next: nextOfError(error), reason: error.message }, EXIT.rejected)
    return respond({ ok: false, op, code: CODES.internal, next: NEXT_BY_CODE[CODES.internal], reason: String(error?.stack ?? error) }, EXIT.rejected)
  }
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const { exitCode, output } = main(process.argv.slice(2), readFileSync(0, 'utf8'))
  process.stdout.write(`${output}\n`)
  process.exitCode = exitCode
}
