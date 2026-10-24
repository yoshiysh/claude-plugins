#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CODES, DEFAULT_POLICY_REF, ImplementError, MAIN_BRANCH, PHASES, argvOf, baselineVerdict, checkPolicy, checkRecord, fnvSum,
  implementationProblem, inventoryProblems, isSha, newLedger, parsePorcelain, planCheckProblems, planProblem, requireAdmitted, requireClosed,
  requireUnchanged, reviewProblems, reviewRecord, roundEffectProblems, roundTicket, sha256, snapshotOf, stateProblem, tail, verifyProblems,
} from './implement-core.mjs'

const STATE_FILE = 'repo-implement-state.json'
const LEDGER_FILE = 'repo-implement-ledger.json'
const CHECK_TIMEOUT_MS = 1_800_000
const CHECK_MAX_BUFFER = 64 * 1024 * 1024
const EXIT = Object.freeze({ ok: 0, rejected: 1, usage: 2 })

export function defaultIo() {
  return {
    git(repo, args, { allowFailure = false, literal = true } = {}) {
      try {
        // optional lock を取らせないのは、読むだけの git が index を書き換えて snapshot を動かさないため。
        const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: literal ? '1' : '0' }
        return execFileSync('git', ['-C', repo, ...args], {
          env,
          maxBuffer: CHECK_MAX_BUFFER,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        // exit 1 は「該当なし」の答え（symbolic-ref・rev-parse --verify・check-ignore）。それ以外の失敗は握りつぶさない。
        if (allowFailure && error.status === 1) return null
        throw new ImplementError(CODES.io, `git ${args.join(' ')} が失敗した: ${String(error.stderr ?? error.message).trim()}`)
      }
    },
    lstat(file) {
      try {
        return lstatSync(file)
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
        throw new ImplementError(CODES.io, `${file} を調べられない: ${error.message}`)
      }
    },
    realpath: (file) => realpathSync(file),
    readFile: (file) => readFileSync(file),
    readlink: (file) => readlinkSync(file),
    writeFile(file, text) {
      const tmp = `${file}.tmp`
      writeFileSync(tmp, text)
      renameSync(tmp, file)
    },
    run(argv, cwd) {
      // 親が node --test の下で動くと NODE_TEST_CONTEXT が引き継がれ、子の node --test が失敗を親へ報告して自分は exit 0 で終わる。
      const { NODE_TEST_CONTEXT, ...env } = process.env
      const r = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, maxBuffer: CHECK_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] })
      return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? String(r.error.message) : null }
    },
  }
}

function insideRepo(repo, dir, io) {
  const r = io.realpath(repo)
  const d = io.realpath(dir)
  return d === r || d.startsWith(`${r}${path.sep}`)
}

function gitText(io, repo, args) {
  return io.git(repo, args).toString('utf8')
}

function headOf(io, repo) {
  return gitText(io, repo, ['rev-parse', 'HEAD']).trim()
}

// symlink は辿らずリンク先の文字列を数える（辿ると repo の外や別の path の内容を数えることになる）。
function digestOf(io, repo, file) {
  const st = io.lstat(path.join(repo, file))
  if (!st) return 'absent'
  if (st.isSymbolicLink()) return `symlink:${sha256(Buffer.from(String(io.readlink(path.join(repo, file)))))}`
  if (st.isFile()) return `file:${sha256(io.readFile(path.join(repo, file)))}`
  return 'other'
}

function statusEntries(io, repo) {
  return parsePorcelain(gitText(io, repo, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']))
}

function takeSnapshot(io, repo) {
  const head = headOf(io, repo)
  const entries = statusEntries(io, repo).map((e) => ({ ...e, digest: digestOf(io, repo, e.path) }))
  return { head, snapshot: snapshotOf(head, entries), paths: entries.map((e) => e.path) }
}

// preserved は内容・有無に加えて、status の XY と index の entry まで記録する（implementer の git add・restore --staged も利用者の作業を変える）。
function preservedDigests(io, repo, files) {
  if (!files.length) return {}
  const xy = new Map(statusEntries(io, repo).map((e) => [e.path, e.xy]))
  const index = new Map(parsePorcelainIndex(gitText(io, repo, ['ls-files', '-s', '-z', '--', ...files])))
  return Object.fromEntries(files.map((file) => {
    let content = digestOf(io, repo, file)
    if (content === 'absent') {
      const blob = io.git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `HEAD:${file}`], { allowFailure: true })
      if (blob) content = `deleted:${blob.toString('utf8').trim()}`
    }
    return [file, `${content}|xy:${xy.get(file) ?? '--'}|index:${index.get(file) ?? 'none'}`]
  }))
}

// `git ls-files -s -z` の各項目は "<mode> <blob> <stage>\t<path>"。
function parsePorcelainIndex(text) {
  return text.split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t')
    return [entry.slice(tab + 1), entry.slice(0, tab)]
  })
}

function readJson(io, file, what) {
  try {
    return JSON.parse(io.readFile(file).toString('utf8'))
  } catch (error) {
    throw new ImplementError(CODES.input, `${what} を読めない: ${error.message}`)
  }
}

function loadState(body, io) {
  if (typeof body.statePath !== 'string' || !body.statePath.startsWith('/') || typeof body.stateSum !== 'string') {
    throw new ImplementError(CODES.input, 'statePath（絶対パス）と stateSum が要る（start の出力の state_path と state_sum）')
  }
  const state = readJson(io, body.statePath, 'state のファイル')
  if (fnvSum(state) !== body.stateSum) throw new ImplementError(CODES.input, 'state のファイルが stateSum と合わない')
  const problem = stateProblem(state)
  if (problem) throw new ImplementError(CODES.input, problem)
  const ledger = readJson(io, state.ledgerPath, 'ledger のファイル')
  if (ledger.state_sum !== body.stateSum) throw new ImplementError(CODES.state, 'ledger が別の state のもの')
  return { state, ledger }
}

function loadPlan(body, state, stateSum) {
  const problem = planProblem(body.plan, body.planSum, state, stateSum)
  if (problem) throw new ImplementError(CODES.input, problem)
  return body.plan
}

function saveLedger(io, state, ledger) {
  io.writeFile(state.ledgerPath, JSON.stringify(ledger))
}

function observe(io, state) {
  const { head, snapshot, paths } = takeSnapshot(io, state.repo)
  const preserved = new Set(state.preserved.map((p) => p.path))
  const actual = paths.filter((p) => !preserved.has(p)).sort()
  return { head, snapshot, actual, preservedNow: preservedDigests(io, state.repo, [...preserved]) }
}

// 書き込む path が symlink を通ると、git には symlink の先の実体の path（plan の外）として現れるか、repo の外へ書かれる。
function symlinkedPaths(io, repo, paths) {
  return paths.filter((file) => {
    const parts = file.split('/')
    for (let i = 1; i <= parts.length; i += 1) {
      const st = io.lstat(path.join(repo, ...parts.slice(0, i)))
      if (!st) return false
      if (st.isSymbolicLink() || (i === parts.length && !st.isFile())) return true
    }
    return false
  }).sort()
}

// ignore される path への書き込みは git status に現れず、inventory・snapshot の照合から漏れる。
function ignoredPaths(io, repo, paths) {
  if (!paths.length) return []
  // check-ignore は literal の pathspec を受け付けない。./ を前に付けて、: で始まる path が pathspec の magic に読まれないようにする。
  const out = io.git(repo, ['check-ignore', '--', ...paths.map((p) => `./${p}`)], { allowFailure: true, literal: false })
  return out ? out.toString('utf8').split('\n').filter(Boolean).map((p) => p.replace(/^\.\//, '')).sort() : []
}

const OPS = {
  start(body, io) {
    const { repo, stateDir } = body
    const policyRef = body.policyRef ?? DEFAULT_POLICY_REF
    if (typeof repo !== 'string' || !repo.startsWith('/')) throw new ImplementError(CODES.input, 'repo は作業ツリーの絶対パス')
    if (typeof stateDir !== 'string' || !stateDir.startsWith('/') || !io.lstat(stateDir)?.isDirectory()) {
      throw new ImplementError(CODES.input, 'stateDir は既にあるディレクトリの絶対パス（mktemp -d で作る）')
    }
    if (typeof policyRef !== 'string' || !policyRef) throw new ImplementError(CODES.input, 'policyRef は省くか ref の文字列')
    const root = io.realpath(repo)
    if (gitText(io, root, ['rev-parse', '--show-toplevel']).trim() !== root) throw new ImplementError(CODES.input, 'repo が作業ツリーの root でない')
    if (insideRepo(root, stateDir, io)) throw new ImplementError(CODES.input, 'stateDir が repo の中にある（記録が未追跡の変更として数えられる）')
    const dir = io.realpath(stateDir)
    if (io.lstat(path.join(dir, STATE_FILE))) throw new ImplementError(CODES.state, 'stateDir に前の state がある（新しい stateDir を作る）')
    // 変更は作業 branch の上に積む。主ブランチの上や branch の無い HEAD では、依頼の commit が主ブランチに直接入るか、どの branch にも残らない。
    const branch = io.git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true })?.toString('utf8').trim() ?? null
    if (branch === null) throw new ImplementError(CODES.pin, 'HEAD が branch を指していない（作業 branch を checkout する）')
    if (branch === MAIN_BRANCH) throw new ImplementError(CODES.pin, `${MAIN_BRANCH} の上では始めない（作業 branch を用意する）`)
    const resolved = io.git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${policyRef}^{commit}`], { allowFailure: true })
    const policySha = resolved?.toString('utf8').trim()
    if (!isSha(policySha)) throw new ImplementError(CODES.pin, `policyRef を commit に解決できない: ${policyRef}`)
    const { head, snapshot, paths } = takeSnapshot(io, root)
    const digests = preservedDigests(io, root, paths)
    const preserved = paths.map((p) => ({ path: p, digest: digests[p] }))
    const state = { repo: root, branch, head, policyRef: policySha, preserved, snapshot, checkPolicy: checkPolicy(), ledgerPath: path.join(dir, LEDGER_FILE) }
    const stateSum = fnvSum(state)
    const statePath = path.join(dir, STATE_FILE)
    io.writeFile(statePath, JSON.stringify(state))
    io.writeFile(state.ledgerPath, JSON.stringify(newLedger(stateSum, snapshot)))
    return { state, state_sum: stateSum, state_path: statePath, preservedPaths: preserved.map((p) => p.path) }
  },
  snapshot(body, io) {
    const { state, ledger } = loadState(body, io)
    const { head, snapshot } = takeSnapshot(io, state.repo)
    return { head, snapshot, recorded: ledger.snapshot, unchanged: snapshot === ledger.snapshot }
  },
  inventory(body, io) {
    const { state, ledger } = loadState(body, io)
    const plan = loadPlan(body, state, body.stateSum)
    const now = observe(io, state)
    if (body.implementation === undefined || body.implementation === null) {
      if (ledger.rounds.length || ledger.open) throw new ImplementError(CODES.state, '実装の round の後に plan を受け入れ直さない（計画の外が要るなら、この run を止めて報告する）')
      const problems = inventoryProblems({ state, plan, ...now, touched: null })
      if (now.snapshot !== ledger.snapshot) problems.push({ cause: 'changed_outside_steps', message: '計画の段で作業ツリーが変わった（開始時の snapshot と違う）', paths: now.actual })
      const symlinks = symlinkedPaths(io, state.repo, plan.affected_paths)
      if (symlinks.length) problems.push({ cause: 'symlink_path', message: 'plan.affected_paths に symlink を通る path・通常のファイルでない path がある（実体の path で計画し直す）', paths: symlinks })
      const ignored = ignoredPaths(io, state.repo, plan.affected_paths.filter((p) => !symlinks.includes(p)))
      if (ignored.length) problems.push({ cause: 'ignored_path', message: 'plan.affected_paths に .gitignore に当たる path がある（書き込みが git status に現れず、照合できない）', paths: ignored })
      const badChecks = planCheckProblems(plan)
      if (badChecks.length) problems.push({ cause: 'check_not_allowed', message: 'plan.checks が許可リストに収まらないか、必須の check を欠く（実行しない）', paths: badChecks })
      const admitted = problems.length === 0
      // 受け入れ直し（実装の前の計画し直し）では開始時の check も取り直す。check の集合が変わり得るため。
      if (admitted) saveLedger(io, state, { ...ledger, plan_sum: body.planSum, baseline: ledger.plan_sum === body.planSum ? ledger.baseline : null })
      return { admitted, problems, actual: now.actual }
    }
    requireAdmitted(ledger, body.planSum)
    const problem = implementationProblem(body.implementation, ledger.open)
    if (problem) throw new ImplementError(CODES.input, problem)
    const impl = body.implementation
    const record = { round: impl.repairRound, status: impl.status, touched: [...impl.touched_paths], snapshot_before: ledger.snapshot, snapshot_after: now.snapshot }
    saveLedger(io, state, { ...ledger, open: null, snapshot: now.snapshot, rounds: [...ledger.rounds, record] })
    const touched = [...ledger.rounds, record].flatMap((r) => r.touched)
    const problems = [...inventoryProblems({ state, plan, ...now, touched }), ...roundEffectProblems(impl.status, record.snapshot_before, record.snapshot_after)]
    return { passed: problems.length === 0, round: impl.repairRound, status: impl.status, problems, actual: now.actual }
  },
  'begin-round'(body, io) {
    const { state, ledger } = loadState(body, io)
    const plan = loadPlan(body, state, body.stateSum)
    requireAdmitted(ledger, body.planSum)
    requireClosed(ledger, 'begin-round')
    if (plan.status !== 'approved') throw new ImplementError(CODES.state, '変更不要の plan は実装しない')
    requireUnchanged(ledger, takeSnapshot(io, state.repo).snapshot, 'begin-round')
    const { ticket, needsReplan } = roundTicket(ledger, plan, body.planSum, body.repair ?? null)
    if (needsReplan) return { needs_replan: true, findingsOutsidePlan: needsReplan }
    const ticketSum = fnvSum(ticket)
    saveLedger(io, state, { ...ledger, open: { round: ticket.round, ticket_sum: ticketSum } })
    return { needs_replan: false, ticket, ticket_sum: ticketSum }
  },
  'run-checks'(body, io) {
    const { state, ledger } = loadState(body, io)
    const plan = loadPlan(body, state, body.stateSum)
    requireAdmitted(ledger, body.planSum)
    requireClosed(ledger, 'run-checks')
    if (!PHASES.includes(body.phase)) throw new ImplementError(CODES.input, `phase は ${PHASES.join('・')} のどれか`)
    if (body.phase === 'baseline' && (ledger.baseline || ledger.rounds.length)) throw new ImplementError(CODES.state, 'baseline は実装の前に 1 回だけ取る')
    if (body.phase === 'after' && ledger.rounds.length === 0) throw new ImplementError(CODES.state, 'after は実装の round の後に取る')
    const bad = planCheckProblems(plan)
    if (bad.length) throw new ImplementError(CODES.check, bad.join('; '), { problems: bad })
    const before = takeSnapshot(io, state.repo)
    requireUnchanged(ledger, before.snapshot, 'run-checks')
    const results = plan.checks.map((check) => {
      if (check.kind === 'node-test') {
        const [linked] = symlinkedPaths(io, state.repo, [check.value])
        const present = io.lstat(path.join(state.repo, check.value))?.isFile()
        if (linked || !present) {
          if (body.phase === 'baseline') return { check, argv: argvOf(check), not_run: 'baseline にまだ無いテスト' }
          throw new ImplementError(CODES.check, `node --test の path が symlink を通らない通常のファイルとして無い: ${check.value}`)
        }
      }
      const argv = argvOf(check)
      const r = io.run(argv, state.repo)
      const exit = r.status ?? null
      const failedAtBaseline = body.phase === 'after' ? baselineVerdict(ledger.baseline, check) : undefined
      return {
        check, argv, exit_code: exit, signal: r.signal ?? null, error: r.error ?? null,
        stdout_tail: tail(r.stdout), stderr_tail: tail(r.stderr),
        ...(body.phase === 'after' ? { failed_at_baseline: failedAtBaseline, repairable: exit !== 0 && failedAtBaseline === false } : {}),
      }
    })
    const after = takeSnapshot(io, state.repo)
    const run = checkRecord(body.phase, ledger.rounds.length - 1, before.snapshot, after.snapshot, after.head, results)
    const next = body.phase === 'baseline' ? { ...ledger, baseline: run } : { ...ledger, checks: [...ledger.checks, run] }
    saveLedger(io, state, next)
    return { run, passed: results.every((r) => r.exit_code === 0) && !run.tree_changed }
  },
  'record-review'(body, io) {
    const { state, ledger } = loadState(body, io)
    requireClosed(ledger, 'record-review')
    const round = ledger.rounds.length - 1
    if (round < 0) throw new ImplementError(CODES.state, 'review は実装の round の後に記録する')
    if (ledger.checks.at(-1)?.round !== round) throw new ImplementError(CODES.state, `round ${round} の後の run-checks の前にレビューしない`)
    if (typeof body.reviewPlanPath !== 'string' || !body.reviewPlanPath.startsWith('/') || typeof body.reviewPlanSum !== 'string') {
      throw new ImplementError(CODES.input, 'reviewPlanPath・reviewPlanSum が要る（repo-review の plan 操作の出力の plan_path と plan_sum）')
    }
    const reviewPlan = readJson(io, body.reviewPlanPath, 'repo-review の計画のファイル')
    if (fnvSum(reviewPlan) !== body.reviewPlanSum) throw new ImplementError(CODES.input, 'repo-review の計画のファイルが reviewPlanSum と合わない')
    const now = observe(io, state)
    requireUnchanged(ledger, now.snapshot, 'record-review')
    const digests = Object.fromEntries((body.review?.target?.files ?? []).map((f) => {
      const d = digestOf(io, state.repo, f)
      return [f, d === 'absent' ? null : d]
    }))
    const problems = reviewProblems({ review: body.review, reviewPlan, state, actual: now.actual, digests })
    if (problems.length) throw new ImplementError(CODES.input, problems.join('; '), { problems })
    const record = reviewRecord(body.review, round, now.snapshot)
    saveLedger(io, state, { ...ledger, reviews: [...ledger.reviews, record] })
    const { findingsDetail, ...summary } = record
    return { review: summary }
  },
  verify(body, io) {
    const { state, ledger } = loadState(body, io)
    const plan = loadPlan(body, state, body.stateSum)
    requireAdmitted(ledger, body.planSum)
    const now = observe(io, state)
    const problems = verifyProblems({ state, ledger, plan, ...now })
    return { passed: problems.length === 0, problems, snapshot: now.snapshot, actual: now.actual, rounds: ledger.rounds.length }
  },
}

function respond(payload, exitCode) {
  return { exitCode, output: JSON.stringify(payload) }
}

export function main(argv, input, io = defaultIo()) {
  const op = argv[0]
  if (!Object.hasOwn(OPS, op) || argv.length !== 1) {
    return respond({ ok: false, op: op ?? null, code: CODES.input, reason: `使い方: implement-cli.mjs <${Object.keys(OPS).join('|')}>（入力は stdin の JSON）` }, EXIT.usage)
  }
  let body
  try {
    body = JSON.parse(input)
  } catch {
    return respond({ ok: false, op, code: CODES.input, reason: '入力が JSON として読めない' }, EXIT.usage)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return respond({ ok: false, op, code: CODES.input, reason: '入力は JSON のオブジェクト' }, EXIT.usage)
  try {
    return respond({ ok: true, op, ...OPS[op](body, io) }, EXIT.ok)
  } catch (error) {
    if (error instanceof ImplementError) {
      return respond({ ok: false, op, code: error.code, reason: error.message, ...(error.detail.problems ? { problems: error.detail.problems } : {}) }, EXIT.rejected)
    }
    return respond({ ok: false, op, code: CODES.internal, reason: String(error?.stack ?? error) }, EXIT.rejected)
  }
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const { exitCode, output } = main(process.argv.slice(2), readFileSync(0, 'utf8'))
  process.stdout.write(`${output}\n`)
  process.exitCode = exitCode
}
