#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CODES, ReviewError, buildPlan, checkPin, checkRequest, fnvSum, inventoryOf, isWorkflowSource, judge, merge, pinProblems,
} from './review-core.mjs'

// 内容を読まない path と生成物の書き先は、どちらも policyRef の時点の正本から読む（写しを持つと正本と食い違う）。
export const POLICY_SOURCES = Object.freeze({
  excludeWorkflow: '.github/workflows/claude_review.yml',
  excludeKey: 'exclude-paths',
  criteriaTool: 'tools/sync-bp-criteria.mjs',
})
export const GENERATED_NOTE = '生成物（判定基準の写し）は内容を読まず、根拠にも指摘の場所にもしない。docs/ の正本と同じ指摘が二重に出るためで、正本との同期は make test の SP-BPRUN-036 の検査が持つ。'
const PLAN_FILE = (sum) => `repo-review-plan-${sum}.json`
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
        if (allowFailure && error.status === 1) return null
        throw new ReviewError(CODES.io, `git ${args.join(' ')} が失敗した: ${String(error.stderr ?? error.message).trim()}`)
      }
    },
    lstat(file) {
      try {
        return lstatSync(file)
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
        throw new ReviewError(CODES.io, `${file} を調べられない: ${error.message}`)
      }
    },
    realpath: (file) => realpathSync(file),
    readFile: (file) => readFileSync(file),
    readlink: (file) => readlinkSync(file),
    writeFile: (file, text) => writeFileSync(file, text, { flag: 'w' }),
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

// 写しの書き先は tool の `path.join(root, SKILL, CRITERIA_DIR)`。SKILL は tool の中の定数、CRITERIA_DIR は tool が import する定数。
export function parseCriteriaTool(text) {
  const skill = /^const SKILL = path\.join\(([^)]*)\);?$/m.exec(text)
  const parts = skill ? [...skill[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []
  const imported = /^import \{[^}]*\bCRITERIA_DIR\b[^}]*\} from '([^']+)';?$/m.exec(text)
  const writes = /path\.join\(root, SKILL, CRITERIA_DIR\)/.test(text)
  if (!skill || parts.length === 0 || skill[1].replace(/'[^']+'/g, '').replace(/[\s,]/g, '') !== '' || !imported || !writes) {
    throw new ReviewError(CODES.io, `${POLICY_SOURCES.criteriaTool} から写しの書き先（SKILL・CRITERIA_DIR）を読めない`)
  }
  const constants = path.posix.normalize(path.posix.join(path.posix.dirname(POLICY_SOURCES.criteriaTool), imported[1]))
  if (constants.startsWith('../')) throw new ReviewError(CODES.io, `CRITERIA_DIR の import 先がリポジトリの外: ${imported[1]}`)
  return { skill: parts.join('/'), constants }
}

export function parseCriteriaDir(text) {
  const found = [...text.matchAll(/^export const CRITERIA_DIR = '([^']+)';?$/gm)]
  if (found.length !== 1) throw new ReviewError(CODES.io, `CRITERIA_DIR の定義がちょうど 1 つない（${found.length} 個）`)
  return found[0][1]
}

function showAt(git, ref, file) {
  return git(['show', '--end-of-options', `${ref}:${file}`]).toString('utf8')
}

function existsAt(git, ref, file) {
  return git(['ls-tree', '-z', '--end-of-options', ref, '--', file]).length > 0
}

// tool が無い ref は写しを作る仕組みがまだ無い版で、生成物は無い（読めない tool とは区別して E_IO にしない）。
export function readGeneratedPaths(git, policyRef) {
  if (!existsAt(git, policyRef, POLICY_SOURCES.criteriaTool)) return []
  const { skill, constants } = parseCriteriaTool(showAt(git, policyRef, POLICY_SOURCES.criteriaTool))
  return [`${skill}/${parseCriteriaDir(showAt(git, policyRef, constants))}/**`]
}

function checkScope(repo, scope, io) {
  for (const entry of scope) {
    const parts = entry.split('/')
    for (let i = 1; i <= parts.length; i += 1) {
      const sub = parts.slice(0, i).join('/')
      const st = io.lstat(path.join(repo, sub))
      if (!st) throw new ReviewError(CODES.input, `scope のパスが作業ツリーに無い: ${entry}`)
      if (st.isSymbolicLink()) throw new ReviewError(CODES.input, `scope のパスが symlink を通る（実体のパスを渡す）: ${entry}（${sub}）`)
    }
  }
}

export function collectState(request, io) {
  const { repo, mode, baseRef, headSha, policyRef } = request
  const git = (args, opts) => io.git(repo, args, opts)
  const head = git(['rev-parse', 'HEAD']).toString('utf8').trim()
  const missingCommits = [baseRef, headSha, policyRef].filter((sha) => sha !== undefined)
    .filter((sha) => git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${sha}^{commit}`], { allowFailure: true }) === null)
  if (missingCommits.length) return { head, missingCommits, excludePaths: [], generatedPaths: [], generatedNote: GENERATED_NOTE, paths: [] }
  const excludePaths = readExcludePaths(showAt(git, policyRef, POLICY_SOURCES.excludeWorkflow))
  const generatedPaths = readGeneratedPaths(git, policyRef)
  let paths
  if (mode === 'diff') {
    paths = lines(git(['diff', '--name-only', '-z', '--no-renames', '--end-of-options', baseRef, headSha]))
  } else if (mode === 'working_tree') {
    paths = [...lines(git(['diff', '--name-only', '-z', '--no-renames', '--end-of-options', baseRef])), ...lines(git(['ls-files', '-z', '--others', '--exclude-standard']))]
  } else {
    const whole = request.scope.length === 1 && request.scope[0] === '.'
    if (!whole) checkScope(repo, request.scope, io)
    const listed = lines(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...(whole ? [] : request.scope)]))
    paths = listed.filter((file) => io.lstat(path.join(repo, file)))
  }
  return { head, missingCommits, excludePaths, generatedPaths, generatedNote: GENERATED_NOTE, paths: [...new Set(paths)].sort() }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

// symlink はリンク先の文字列そのものを対象にする（辿ると別の path の実体を読むことになる）。digest は種類を前に付けて区別する。
export function collectDetails(request, files, io) {
  const symlinks = []
  const workflowSources = []
  const digests = {}
  if (request.mode === 'diff') {
    const git = (args) => io.git(request.repo, args)
    const modes = new Map(lines(git(['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', request.headSha]))
      .map((entry) => {
        const tab = entry.indexOf('\t')
        return [entry.slice(tab + 1), entry.slice(0, tab).split(' ')[0]]
      }))
    for (const file of files) {
      const mode = modes.get(file)
      if (mode === '120000') symlinks.push(file)
      else if ((mode === '100644' || mode === '100755') && file.endsWith('.js') && isWorkflowSource(showAt(git, request.headSha, file))) workflowSources.push(file)
    }
    return { symlinks, workflowSources, digests: null }
  }
  for (const file of files) {
    const full = path.join(request.repo, file)
    const st = io.lstat(full)
    if (!st) digests[file] = null
    else if (st.isSymbolicLink()) {
      symlinks.push(file)
      digests[file] = `symlink:${sha256(Buffer.from(io.readlink(full)))}`
    } else if (st.isFile()) {
      const bytes = io.readFile(full)
      digests[file] = `file:${sha256(bytes)}`
      if (file.endsWith('.js') && isWorkflowSource(bytes.toString('utf8'))) workflowSources.push(file)
    } else digests[file] = 'other'
  }
  return { symlinks, workflowSources, digests }
}

function insideRepo(repo, dir, io) {
  const r = io.realpath(repo)
  const d = io.realpath(dir)
  return d === r || d.startsWith(`${r}${path.sep}`)
}

// plan は caller の Bash で 1 回だけ書く。運搬役は計画の本体でなく path と sum だけを写す（写す量を対象の大きさに依らせない）。
function loadPlan(body, io) {
  if (typeof body.planPath !== 'string' || !body.planPath.startsWith('/') || typeof body.planSum !== 'string') {
    throw new ReviewError(CODES.input, 'planPath（絶対パス）と planSum が要る')
  }
  let plan
  try {
    plan = JSON.parse(io.readFile(body.planPath).toString('utf8'))
  } catch (error) {
    throw new ReviewError(CODES.input, `plan のファイルを読めない: ${error.message}`)
  }
  if (fnvSum(plan) !== body.planSum) throw new ReviewError(CODES.input, 'plan のファイルが planSum と合わない')
  checkRequest({
    repo: plan.repo, mode: plan.mode, baseRef: plan.baseRef, headSha: plan.headSha, policyRef: plan.policyRef, scope: plan.scope,
    ...(plan.mode === 'working_tree' ? { preservedPaths: plan.preservedPaths } : {}), reviewers: plan.reviewers,
  }, { requireReviewers: true })
  const lists = ['preservedPaths', 'excludePaths', 'generatedPaths', 'excluded', 'generated', 'preserved', 'symlinks', 'skillDesignTargets']
  const bad = lists.filter((key) => !Array.isArray(plan[key]) || plan[key].some((x) => typeof x !== 'string'))
  if (!Array.isArray(plan.target?.files) || plan.target.files.some((x) => typeof x !== 'string')) bad.push('target.files')
  if (typeof plan.generatedNote !== 'string') bad.push('generatedNote')
  const digestsOk = plan.mode === 'diff' ? plan.digests === null
    : plan.digests !== null && typeof plan.digests === 'object' && !Array.isArray(plan.digests)
  if (!digestsOk) bad.push('digests')
  if (bad.length) throw new ReviewError(CODES.input, `plan のファイルが plan 操作の出力の形でない: ${bad.join(', ')}`)
  return plan
}

const OPS = {
  inventory(body, io) {
    const request = checkRequest(body, { requireReviewers: false })
    const state = collectState(request, io)
    return { inventory: inventoryOf(request, state), generated_note: state.generatedNote, pin_problems: pinProblems(request, state) }
  },
  plan(body, io) {
    const { stateDir, ...rest } = body
    const request = checkRequest(rest, { requireReviewers: true })
    if (typeof stateDir !== 'string' || !stateDir.startsWith('/') || !io.lstat(stateDir)?.isDirectory()) {
      throw new ReviewError(CODES.input, 'stateDir は既にあるディレクトリの絶対パスでなければならない')
    }
    if (insideRepo(request.repo, stateDir, io)) throw new ReviewError(CODES.input, 'stateDir が repo の中にある（plan のファイルが未追跡の変更として対象に混ざる）')
    const state = collectState(request, io)
    const pin = pinProblems(request, state)
    if (pin.length) throw new ReviewError(CODES.pin, pin.join('; '), { problems: pin })
    const inv = inventoryOf(request, state)
    const plan = buildPlan(request, state, collectDetails(request, inv.reviewable, io))
    const planSum = fnvSum(plan)
    const planPath = path.join(io.realpath(stateDir), PLAN_FILE(planSum))
    io.writeFile(planPath, JSON.stringify(plan))
    return { plan, plan_sum: planSum, plan_path: planPath }
  },
  pin(body, io) {
    const plan = loadPlan(body, io)
    try {
      const state = collectState(plan, io)
      return { pin: checkPin(plan, state, collectDetails(plan, plan.target.files, io)) }
    } catch (error) {
      // 対象を集め直せないこと（scope が消えた・symlink になった・git が読めない）は、固定が崩れたことと同じに扱う。
      if (!(error instanceof ReviewError)) throw error
      return { pin: { ok: false, problems: [`${error.code}: ${error.message}`], changed: [] } }
    }
  },
  merge(body, io) {
    return { merge: merge(loadPlan(body, io), body.results) }
  },
  judge(body, io) {
    return { judge: judge(loadPlan(body, io), body.merged, body.rounds) }
  },
}
const CARRIER_OPS = Object.freeze(['pin', 'merge', 'judge'])

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
    if (error instanceof ReviewError) {
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
