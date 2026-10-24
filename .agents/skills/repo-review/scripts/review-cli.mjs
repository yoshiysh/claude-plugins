#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CODES, ReviewError, buildPlan, checkPin, checkRequest, finalize, fnvSum, inventoryOf, merge, pinProblems } from './review-core.mjs'

// 内容を読まない path と生成物の置き場は、どちらも policyRef の時点の正本から読む（写しを持つと正本と食い違う）。
export const POLICY_SOURCES = Object.freeze({
  excludeWorkflow: '.github/workflows/claude_review.yml',
  excludeKey: 'exclude-paths',
  criteriaConstant: 'export const CRITERIA_DIR',
})
const CARRIER_OPS = Object.freeze(['pin', 'merge', 'finalize'])
const EXIT = Object.freeze({ ok: 0, rejected: 1, usage: 2 })

export function defaultIo() {
  return {
    git(repo, args, { allowFailure = false } = {}) {
      try {
        // optional lock を取らせないのは、読み取り専用の sandbox で index の更新に失敗させないため。
        return execFileSync('git', ['-C', repo, ...args], {
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' },
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        if (allowFailure && error.status === 1) return Buffer.alloc(0)
        throw new ReviewError(CODES.io, `git ${args.join(' ')} が失敗した: ${String(error.stderr ?? error.message).trim()}`)
      }
    },
    lstat(file) {
      try {
        return lstatSync(file)
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
        throw error
      }
    },
    readFile: (file) => readFileSync(file),
    readlink: (file) => readlinkSync(file),
  }
}

function lines(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean)
}

export function readExcludePaths(yml) {
  const found = [...yml.matchAll(new RegExp(`^\\s*${POLICY_SOURCES.excludeKey}:\\s*'(.*)'\\s*$`, 'gm'))]
  if (found.length !== 1) throw new ReviewError(CODES.io, `${POLICY_SOURCES.excludeWorkflow} に ${POLICY_SOURCES.excludeKey} が 1 行だけ無い（${found.length} 行）`)
  let list
  try {
    list = JSON.parse(found[0][1])
  } catch {
    throw new ReviewError(CODES.io, `${POLICY_SOURCES.excludeKey} が JSON の配列として読めない`)
  }
  if (!Array.isArray(list) || list.length === 0 || list.some((p) => typeof p !== 'string' || !p.trim())) {
    throw new ReviewError(CODES.io, `${POLICY_SOURCES.excludeKey} が空でない glob の配列でない`)
  }
  return list
}

export function readGeneratedPaths(grepOutput, policyRef) {
  const hits = grepOutput.split('\n').filter(Boolean)
  if (hits.length !== 1) throw new ReviewError(CODES.io, `${POLICY_SOURCES.criteriaConstant} が policyRef にちょうど 1 箇所ない（${hits.length} 箇所）`)
  const m = new RegExp(`^${policyRef}:(.+?):\\d+:${POLICY_SOURCES.criteriaConstant} = '([^']+)'`).exec(hits[0])
  const root = m && /^(.*?\/skills\/[^/]+)\//.exec(m[1])
  if (!m || !root) throw new ReviewError(CODES.io, `判定基準の写しの置き場を読めない: ${hits[0]}`)
  return [`${root[1]}/${m[2]}/**`]
}

export function collectState(request, io) {
  const { repo, mode, baseRef, headSha, policyRef } = request
  const git = (args, opts) => io.git(repo, args, opts)
  const head = git(['rev-parse', 'HEAD']).toString('utf8').trim()
  const excludePaths = readExcludePaths(git(['show', `${policyRef}:${POLICY_SOURCES.excludeWorkflow}`]).toString('utf8'))
  const grep = git(['grep', '-n', '-e', `^${POLICY_SOURCES.criteriaConstant} = `, policyRef], { allowFailure: true }).toString('utf8')
  const generatedPaths = readGeneratedPaths(grep, policyRef)
  const dirty = lines(git(['diff', '--name-only', '-z', '--no-renames', 'HEAD']))
  let paths
  if (mode === 'diff') {
    paths = lines(git(['diff', '--name-only', '-z', '--no-renames', baseRef, headSha]))
  } else if (mode === 'working_tree') {
    paths = [...lines(git(['diff', '--name-only', '-z', '--no-renames', baseRef])), ...lines(git(['ls-files', '-z', '--others', '--exclude-standard']))]
  } else {
    const whole = request.scope.length === 1 && request.scope[0] === '.'
    for (const entry of whole ? [] : request.scope) {
      const st = io.lstat(path.join(repo, entry))
      if (!st) throw new ReviewError(CODES.input, `scope のパスが作業ツリーに無い: ${entry}`)
      if (st.isSymbolicLink()) throw new ReviewError(CODES.input, `scope のパスが symlink（実体のパスを渡す）: ${entry}`)
    }
    const listed = lines(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...(whole ? [] : request.scope)]))
    paths = listed.filter((file) => io.lstat(path.join(repo, file)))
  }
  return { head, dirty, excludePaths, generatedPaths, paths: [...new Set(paths)].sort() }
}

export function digestsOf(repo, files, io) {
  const out = {}
  for (const file of files) {
    const full = path.join(repo, file)
    const st = io.lstat(full)
    const bytes = !st ? null : st.isSymbolicLink() ? Buffer.from(io.readlink(full)) : st.isFile() ? io.readFile(full) : Buffer.from('directory')
    out[file] = bytes === null ? null : createHash('sha256').update(bytes).digest('hex')
  }
  return out
}

function requirePlan(plan) {
  const ok = plan && typeof plan === 'object' && typeof plan.repo === 'string' && typeof plan.headSha === 'string'
    && Array.isArray(plan.target?.files) && Array.isArray(plan.excludePaths) && Array.isArray(plan.generatedPaths)
  if (!ok) throw new ReviewError(CODES.input, 'plan が plan 操作の出力の形でない')
  return plan
}

const OPS = {
  inventory(body, io) {
    const request = checkRequest(body, { requireReviewers: false })
    const state = collectState(request, io)
    return { inventory: inventoryOf(request, state), pin_problems: pinProblems(request, state) }
  },
  plan(body, io) {
    const request = checkRequest(body, { requireReviewers: true })
    const state = collectState(request, io)
    const inv = inventoryOf(request, state)
    const digests = request.mode === 'diff' ? null : digestsOf(request.repo, inv.reviewable, io)
    const plan = buildPlan(request, state, digests)
    return { plan, plan_sum: fnvSum(plan) }
  },
  pin(body, io) {
    const plan = requirePlan(body.plan)
    const state = collectState(plan, io)
    const digests = plan.digests ? digestsOf(plan.repo, plan.target.files, io) : null
    return { pin: checkPin(plan, state, digests) }
  },
  merge(body) {
    return { merge: merge(requirePlan(body.plan), body.results) }
  },
  finalize(body) {
    return { finalize: finalize(requirePlan(body.plan), body.merged ?? {}, body.verifications) }
  },
}

function respond(payload, exitCode) {
  return { exitCode, output: JSON.stringify({ ...payload, sum: fnvSum(payload) }) }
}

export function main(argv, input, io = defaultIo()) {
  const op = argv[0]
  if (!Object.hasOwn(OPS, op) || argv.length !== 1) {
    return respond({ ok: false, op: op ?? null, code: CODES.input, reason: `使い方: review-cli.mjs <${Object.keys(OPS).join('|')}>（入力は stdin の JSON）` }, EXIT.usage)
  }
  let body
  try {
    body = JSON.parse(input)
  } catch {
    return respond({ ok: false, op, code: CODES.transport, reason: '入力が JSON として読めない' }, EXIT.usage)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return respond({ ok: false, op, code: CODES.input, reason: '入力は JSON のオブジェクト' }, EXIT.usage)
  const { sum, ...rest } = body
  if ((CARRIER_OPS.includes(op) || sum !== undefined) && sum !== fnvSum(rest)) {
    return respond({ ok: false, op, code: CODES.transport, reason: '入力の sum が本文と合わない（写し間違い）' }, EXIT.rejected)
  }
  try {
    return respond({ ok: true, op, ...OPS[op](rest, io) }, EXIT.ok)
  } catch (error) {
    if (!(error instanceof ReviewError)) throw error
    return respond({ ok: false, op, code: error.code, reason: error.message, ...(error.detail.problems ? { problems: error.detail.problems } : {}) }, EXIT.rejected)
  }
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const { exitCode, output } = main(process.argv.slice(2), readFileSync(0, 'utf8'))
  process.stdout.write(`${output}\n`)
  process.exitCode = exitCode
}
