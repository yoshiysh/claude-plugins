#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CODES, ImplementError, MAIN_BRANCH, PHASES, admitPlan, argvOf, baselineVerdict, checkKey, checkPolicy, checkProblem, checkRecord, fnvSum,
  implementationProblem, inventoryProblems, isSha, newLedger, parsePorcelain, planProblem, recordRound, requireAdmitted, reviewProblem, reviewRecord,
  sha256, snapshotOf, stateProblem, tail, verifyProblems,
} from './implement-core.mjs'

const STATE_FILE = 'repo-implement-state.json'
const LEDGER_FILE = 'repo-implement-ledger.json'
const CHECK_TIMEOUT_MS = 1_800_000
const CHECK_MAX_BUFFER = 64 * 1024 * 1024
const EXIT = Object.freeze({ ok: 0, rejected: 1, usage: 2 })

export function defaultIo() {
  return {
    git(repo, args, { allowFailure = false } = {}) {
      try {
        // optional lock を取らせないのは、読むだけの git が index を書き換えて snapshot を動かさないため。
        return execFileSync('git', ['-C', repo, ...args], {
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' },
          maxBuffer: CHECK_MAX_BUFFER,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        if (allowFailure) return null
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
      const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, maxBuffer: CHECK_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] })
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

function preservedDigest(io, repo, file) {
  const digest = digestOf(io, repo, file)
  if (digest !== 'absent') return digest
  const blob = io.git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `HEAD:${file}`], { allowFailure: true })
  return blob ? `deleted:${blob.toString('utf8').trim()}` : 'absent'
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
  const preservedNow = Object.fromEntries(state.preserved.map((p) => [p.path, preservedDigest(io, state.repo, p.path)]))
  return { head, snapshot, actual, preservedNow }
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

const OPS = {
  start(body, io) {
    const { repo, stateDir, policyRef } = body
    if (typeof repo !== 'string' || !repo.startsWith('/')) throw new ImplementError(CODES.input, 'repo は作業ツリーの絶対パス')
    if (typeof stateDir !== 'string' || !stateDir.startsWith('/') || !io.lstat(stateDir)?.isDirectory()) {
      throw new ImplementError(CODES.input, 'stateDir は既にあるディレクトリの絶対パス（mktemp -d で作る）')
    }
    if (typeof policyRef !== 'string' || !policyRef) throw new ImplementError(CODES.input, 'policyRef（主ブランチの先端。例: origin/main）が要る')
    const root = io.realpath(repo)
    if (gitText(io, root, ['rev-parse', '--show-toplevel']).trim() !== root) throw new ImplementError(CODES.input, 'repo が作業ツリーの root でない')
    if (insideRepo(root, stateDir, io)) throw new ImplementError(CODES.input, 'stateDir が repo の中にある（記録が未追跡の変更として数えられる）')
    const dir = io.realpath(stateDir)
    if (io.lstat(path.join(dir, STATE_FILE))) throw new ImplementError(CODES.state, 'stateDir に前の state がある（新しい stateDir を作る）')
    const branch = io.git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true })?.toString('utf8').trim() ?? null
    if (branch === MAIN_BRANCH) throw new ImplementError(CODES.pin, `${MAIN_BRANCH} の上では始めない（作業 branch を用意する）`)
    const resolved = io.git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${policyRef}^{commit}`], { allowFailure: true })
    const policySha = resolved?.toString('utf8').trim()
    if (!isSha(policySha)) throw new ImplementError(CODES.pin, `policyRef を commit に解決できない: ${policyRef}`)
    const { head, snapshot, paths } = takeSnapshot(io, root)
    const preserved = paths.map((p) => ({ path: p, digest: preservedDigest(io, root, p) }))
    const state = { repo: root, branch, head, policyRef: policySha, preserved, snapshot, checkPolicy: checkPolicy(), ledgerPath: path.join(dir, LEDGER_FILE) }
    const stateSum = fnvSum(state)
    const statePath = path.join(dir, STATE_FILE)
    io.writeFile(statePath, JSON.stringify(state))
    io.writeFile(state.ledgerPath, JSON.stringify(newLedger(stateSum)))
    return { state, state_sum: stateSum, state_path: statePath, preservedPaths: preserved.map((p) => p.path) }
  },
  snapshot(body, io) {
    const { state } = loadState(body, io)
    const { head, snapshot } = takeSnapshot(io, state.repo)
    return { head, snapshot }
  },
  inventory(body, io) {
    const { state, ledger } = loadState(body, io)
    const plan = loadPlan(body, state, body.stateSum)
    const now = observe(io, state)
    if (body.implementation === undefined || body.implementation === null) {
      const symlinks = symlinkedPaths(io, state.repo, plan.affected_paths)
      const problems = inventoryProblems({ state, plan, ...now, touched: null })
      if (symlinks.length) problems.push({ cause: 'symlink_path', message: 'plan.affected_paths に symlink を通る path・通常のファイルでない path がある（実体の path で計画し直す）', paths: symlinks })
      const badChecks = plan.checks.map((c) => checkProblem(c, plan.affected_paths)).filter(Boolean)
      if (badChecks.length) problems.push({ cause: 'check_not_allowed', message: 'plan.checks に許可リストに無い check がある（実行しない）', paths: badChecks })
      if (problems.length === 0) saveLedger(io, state, admitPlan(ledger, body.planSum))
      return { admitted: problems.length === 0, problems, actual: now.actual }
    }
    requireAdmitted(ledger, body.planSum)
    const problem = implementationProblem(body.implementation)
    if (problem) throw new ImplementError(CODES.input, problem)
    const next = recordRound(ledger, body.implementation)
    saveLedger(io, state, next)
    const touched = next.rounds.flatMap((r) => r.touched)
    const problems = inventoryProblems({ state, plan, ...now, touched })
    return { passed: problems.length === 0, round: body.implementation.repairRound, problems, actual: now.actual }
  },
  'run-checks'(body, io) {
    const { state, ledger } = loadState(body, io)
    const plan = loadPlan(body, state, body.stateSum)
    requireAdmitted(ledger, body.planSum)
    if (!PHASES.includes(body.phase)) throw new ImplementError(CODES.input, `phase は ${PHASES.join('・')} のどれか`)
    if (body.phase === 'baseline' && (ledger.baseline || ledger.rounds.length)) throw new ImplementError(CODES.state, 'baseline は実装の前に 1 回だけ取る')
    if (body.phase === 'after' && ledger.rounds.length === 0) throw new ImplementError(CODES.state, 'after は実装の round の後に取る')
    const bad = plan.checks.map((c) => checkProblem(c, plan.affected_paths)).filter(Boolean)
    if (bad.length) throw new ImplementError(CODES.check, bad.join('; '), { problems: bad })
    const before = takeSnapshot(io, state.repo)
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
    return { run, run_sum: fnvSum(run), passed: results.every((r) => r.exit_code === 0) && !run.tree_changed }
  },
  'record-review'(body, io) {
    const { state, ledger } = loadState(body, io)
    if (ledger.rounds.length === 0) throw new ImplementError(CODES.state, 'review は実装の round の後に記録する')
    const problem = reviewProblem(body.review, state)
    if (problem) throw new ImplementError(CODES.input, problem)
    const { snapshot } = takeSnapshot(io, state.repo)
    const record = reviewRecord(body.review, ledger.rounds.length - 1, snapshot)
    saveLedger(io, state, { ...ledger, reviews: [...ledger.reviews, record] })
    return { review: record }
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
