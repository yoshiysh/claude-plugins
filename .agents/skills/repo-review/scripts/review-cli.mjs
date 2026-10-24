#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CODES, RETRY, ReviewError, WORKFLOW_SOURCE_PATHS, causesOf, failedPin, pinIssues, buildPlan, extractSections, parseReadingTable, renderPolicyPack, checkPin, checkRequest, fnvSum, inventoryOf, isWorkflowSource, judge, matcher, merge,
} from './review-core.mjs'

// 内容を読まない path と生成物の書き先は、どちらも policyRef の時点の正本から読む（写しを持つと正本と食い違う）。
export const POLICY_SOURCES = Object.freeze({
  excludeWorkflow: '.github/workflows/claude_review.yml',
  excludeKey: 'exclude-paths',
  criteriaTool: 'tools/sync-bp-criteria.mjs',
  review: 'REVIEW.md',
})
export const GENERATED_NOTE = '生成物（判定基準の写し）は内容を読まず、根拠にも指摘の場所にもしない。docs/ の正本と同じ指摘が二重に出るためで、正本との同期は make test の SP-BPRUN-036 の検査が持つ。'
const PLAN_FILE = (sum) => `repo-review-plan-${sum}.json`
const PACK_FILE = (sha) => `repo-review-policy-${sha.slice(0, 16)}.md`
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
  if (found.length !== 1) throw new ReviewError(CODES.policy, `${POLICY_SOURCES.excludeWorkflow} に ${POLICY_SOURCES.excludeKey} が 1 行だけ無い（${found.length} 行）`)
  let list
  try {
    list = JSON.parse(found[0][1])
  } catch {
    throw new ReviewError(CODES.policy, `${POLICY_SOURCES.excludeKey} が JSON の配列として読めない`)
  }
  if (!Array.isArray(list) || list.length === 0 || list.some((p) => typeof p !== 'string' || !p.trim())) {
    throw new ReviewError(CODES.policy, `${POLICY_SOURCES.excludeKey} が空でない glob の配列でない`)
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
    throw new ReviewError(CODES.policy, `${POLICY_SOURCES.criteriaTool} から写しの書き先（SKILL・CRITERIA_DIR）を読めない`)
  }
  const constants = path.posix.normalize(path.posix.join(path.posix.dirname(POLICY_SOURCES.criteriaTool), imported[1]))
  if (constants.startsWith('../')) throw new ReviewError(CODES.policy, `CRITERIA_DIR の import 先がリポジトリの外: ${imported[1]}`)
  return { skill: parts.join('/'), constants }
}

export function parseCriteriaDir(text) {
  const found = [...text.matchAll(/^export const CRITERIA_DIR = '([^']+)';?$/gm)]
  if (found.length !== 1) throw new ReviewError(CODES.policy, `CRITERIA_DIR の定義がちょうど 1 つない（${found.length} 個）`)
  return found[0][1]
}

function showAt(git, ref, file) {
  return git(['show', '--end-of-options', `${ref}:${file}`]).toString('utf8')
}

function existsAt(git, ref, file) {
  return git(['ls-tree', '-z', '--end-of-options', ref, '--', file]).length > 0
}

// tool が無い ref は写しを作る仕組みがまだ無い版で、生成物は無い。tool はあるのに読めない形・import 先が無いときは E_POLICY にする。
export function readGeneratedPaths(git, policyRef) {
  if (!existsAt(git, policyRef, POLICY_SOURCES.criteriaTool)) return []
  const { skill, constants } = parseCriteriaTool(showAt(git, policyRef, POLICY_SOURCES.criteriaTool))
  if (!existsAt(git, policyRef, constants)) throw new ReviewError(CODES.policy, `${POLICY_SOURCES.criteriaTool} が import する ${constants} が policyRef に無い`)
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
  // 未追跡も数えるのは、reviewer が作業ツリーを開いたときに head に無い内容を読まないようにするため（diff の判定にだけ使う）。
  const dirty = lines(git(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=normal'])).map((entry) => entry.slice(3))
  if (missingCommits.length) return { head, missingCommits, dirty, excludePaths: [], generatedPaths: [], generatedNote: GENERATED_NOTE, paths: [] }
  if (!existsAt(git, policyRef, POLICY_SOURCES.excludeWorkflow)) throw new ReviewError(CODES.policy, `policyRef に ${POLICY_SOURCES.excludeWorkflow} が無い`)
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
  return { head, missingCommits, dirty, excludePaths, generatedPaths, generatedNote: GENERATED_NOTE, paths: [...new Set(paths)].sort() }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function treeModes(git, ref) {
  return new Map(lines(git(['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', ref])).map((entry) => {
    const tab = entry.indexOf('\t')
    return [entry.slice(tab + 1), entry.slice(0, tab).split(' ')[0]]
  }))
}

const REGULAR = new Set(['100644', '100755'])

// 追跡中の symlink を、repo の中の実体の path へ解決した対応表。core はこれで symlink 経由の読み（.agents/skills/<skill>/... など）を実体の path に直して禁止判定する。
// repo の外を指す link と絶対パスの link は表に入れない（実体が repo の外なので、禁止 path の判定の対象にならない）。
export function collectSymlinkMap(git, ref) {
  const map = {}
  for (const entry of lines(git(['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', ref]))) {
    const tab = entry.indexOf('\t')
    const [mode, , oid] = entry.slice(0, tab).split(' ')
    if (mode !== '120000') continue
    const link = entry.slice(tab + 1)
    const target = git(['cat-file', 'blob', oid]).toString('utf8')
    if (target.startsWith('/')) continue
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(link), target))
    if (resolved === '..' || resolved.startsWith('../')) continue
    map[link] = resolved.replace(/\/+$/, '')
  }
  return map
}

// symlink はリンク先の文字列そのものを対象にする（辿ると別の path の実体を読むことになる）。digest は種類を前に付けて区別する。
// Workflow source は置き場（WORKFLOW_SOURCE_PATHS）の中だけを内容で判定し、変更後に無いファイルは base の版で判定する（削除も設計の変更）。
export function collectDetails(request, files, io) {
  const git = (args) => io.git(request.repo, args)
  const inPlace = matcher(WORKFLOW_SOURCE_PATHS)
  const symlinks = []
  const workflowSources = []
  const digests = request.mode === 'diff' ? null : {}
  const headModes = request.mode === 'diff' ? treeModes(git, request.headSha) : null
  let baseModes = null
  const atBase = (file) => {
    if (!request.baseRef) return false
    baseModes ??= treeModes(git, request.baseRef)
    return REGULAR.has(baseModes.get(file)) && isWorkflowSource(showAt(git, request.baseRef, file))
  }
  for (const file of files) {
    let present
    if (request.mode === 'diff') {
      const mode = headModes.get(file)
      present = mode !== undefined
      if (mode === '120000') symlinks.push(file)
      if (inPlace(file) && REGULAR.has(mode) && isWorkflowSource(showAt(git, request.headSha, file))) workflowSources.push(file)
    } else {
      const full = path.join(request.repo, file)
      const st = io.lstat(full)
      present = Boolean(st)
      if (!st) digests[file] = null
      else if (st.isSymbolicLink()) {
        symlinks.push(file)
        digests[file] = `symlink:${sha256(Buffer.from(io.readlink(full)))}`
      } else if (st.isFile()) {
        const bytes = io.readFile(full)
        digests[file] = `file:${sha256(bytes)}`
        if (inPlace(file) && isWorkflowSource(bytes.toString('utf8'))) workflowSources.push(file)
      } else digests[file] = 'other'
    }
    if (!present && inPlace(file) && atBase(file)) workflowSources.push(file)
  }
  return { symlinks, workflowSources, digests }
}

// reviewer・検証役が同じ方針の文書をそれぞれ読み直さないよう、policyRef の版から行番号つきの束を 1 回だけ作る。
export function buildPolicyPack(git, policyRef) {
  if (!existsAt(git, policyRef, POLICY_SOURCES.review)) throw new ReviewError(CODES.policy, `policyRef に ${POLICY_SOURCES.review} が無い`)
  const toLines = (text) => text.replace(/\n$/, '').split('\n')
  const review = showAt(git, policyRef, POLICY_SOURCES.review)
  const parts = [{ path: POLICY_SOURCES.review, title: null, lines: toLines(review) }]
  const table = parseReadingTable(review)
  const missing = table.unparsed.map((u) => ({ text: u.text, reason: u.reason }))
  for (const doc of table.docs) {
    if (doc.path === POLICY_SOURCES.review) continue
    if (!existsAt(git, policyRef, doc.path)) {
      missing.push({ path: doc.path, reason: 'policyRef に無い' })
      continue
    }
    const lines = toLines(showAt(git, policyRef, doc.path))
    if (doc.whole) {
      parts.push({ path: doc.path, title: null, lines })
      continue
    }
    const found = extractSections(lines.join('\n'), doc.titles)
    // 別の節にまるごと含まれる節は束に重ねない（同じ行を 2 回読ませない）。
    const inside = (a) => found.sections.some((b) => b !== a && b.start <= a.start && a.end <= b.end && (b.start < a.start || b.end > a.end))
    for (const sec of found.sections) if (!inside(sec)) parts.push({ path: doc.path, title: sec.title, lines, start: sec.start, end: sec.end })
    for (const title of found.missing) missing.push({ path: doc.path, title, reason: '節が無い' })
  }
  for (const p of parts) {
    p.start ??= 1
    p.end ??= p.lines.length
  }
  const token = randomBytes(6).toString('hex')
  const { text, index } = renderPolicyPack(policyRef, parts, missing, token)
  return { text, index, missing, token }
}

function insideRepo(repo, dir, io) {
  const r = io.realpath(repo)
  const d = io.realpath(dir)
  return d === r || d.startsWith(`${r}${path.sep}`)
}

function replanOnFailure(fn) {
  try {
    return fn()
  } catch (error) {
    if (error instanceof ReviewError) error.detail.retry = RETRY.replan
    throw error
  }
}

// plan は caller の Bash で 1 回だけ書く。運搬役は計画の本体でなく path と sum だけを写す（写す量を対象の大きさに依らせない）。
function loadPlan(body, io) {
  if (typeof body.planPath !== 'string' || !body.planPath.startsWith('/') || typeof body.planSum !== 'string') {
    throw new ReviewError(CODES.input, 'planPath（絶対パス）と planSum が要る', { retry: RETRY.replan })
  }
  let plan
  try {
    plan = JSON.parse(io.readFile(body.planPath).toString('utf8'))
  } catch (error) {
    throw new ReviewError(CODES.input, `plan のファイルを読めない: ${error.message}`, { retry: RETRY.replan })
  }
  if (fnvSum(plan) !== body.planSum) throw new ReviewError(CODES.input, 'plan のファイルが planSum と合わない', { retry: RETRY.replan })
  replanOnFailure(() => checkRequest({
    repo: plan.repo, mode: plan.mode, baseRef: plan.baseRef, headSha: plan.headSha, policyRef: plan.policyRef, scope: plan.scope,
    ...(plan.mode === 'working_tree' ? { preservedPaths: plan.preservedPaths } : {}), reviewers: plan.reviewers,
  }, { requireReviewers: true }))
  const lists = ['preservedPaths', 'excludePaths', 'generatedPaths', 'excluded', 'generated', 'preserved', 'symlinks', 'skillDesignTargets']
  const bad = lists.filter((key) => !Array.isArray(plan[key]) || plan[key].some((x) => typeof x !== 'string'))
  if (!Array.isArray(plan.target?.files) || plan.target.files.some((x) => typeof x !== 'string')) bad.push('target.files')
  if (typeof plan.generatedNote !== 'string') bad.push('generatedNote')
  const digestsOk = plan.mode === 'diff' ? plan.digests === null
    : plan.digests !== null && typeof plan.digests === 'object' && !Array.isArray(plan.digests)
  if (!digestsOk) bad.push('digests')
  if (!plan.symlinkMap || typeof plan.symlinkMap !== 'object' || Array.isArray(plan.symlinkMap) || Object.values(plan.symlinkMap).some((v) => typeof v !== 'string')) bad.push('symlinkMap')
  const pack = plan.policyPack
  if (!pack || typeof pack.path !== 'string' || typeof pack.sha256 !== 'string' || typeof pack.token !== 'string' || !Array.isArray(pack.index) || !Array.isArray(pack.missing)) bad.push('policyPack')
  if (bad.length) throw new ReviewError(CODES.input, `plan のファイルが plan 操作の出力の形でない: ${bad.join(', ')}`, { retry: RETRY.replan })
  return plan
}

const OPS = {
  inventory(body, io) {
    const request = checkRequest(body, { requireReviewers: false })
    const state = collectState(request, io)
    const issues = pinIssues(request, state)
    return { inventory: inventoryOf(request, state), generated_note: state.generatedNote, pin_problems: issues.map((x) => x.message), pin_causes: causesOf(issues, request.mode) }
  },
  plan(body, io) {
    const { stateDir, ...rest } = body
    const request = checkRequest(rest, { requireReviewers: true })
    if (typeof stateDir !== 'string' || !stateDir.startsWith('/') || !io.lstat(stateDir)?.isDirectory()) {
      throw new ReviewError(CODES.input, 'stateDir は既にあるディレクトリの絶対パスでなければならない')
    }
    if (insideRepo(request.repo, stateDir, io)) throw new ReviewError(CODES.input, 'stateDir が repo の中にある（plan のファイルが未追跡の変更として対象に混ざる）')
    const state = collectState(request, io)
    const issues = pinIssues(request, state)
    if (issues.length) throw new ReviewError(CODES.pin, issues.map((x) => x.message).join('; '), { problems: issues.map((x) => x.message), causes: causesOf(issues, request.mode) })
    const inv = inventoryOf(request, state)
    const pack = buildPolicyPack((args) => io.git(request.repo, args), request.policyRef)
    const packSha = sha256(Buffer.from(pack.text))
    const packPath = path.join(io.realpath(stateDir), PACK_FILE(packSha))
    io.writeFile(packPath, pack.text)
    const symlinkMap = collectSymlinkMap((args) => io.git(request.repo, args), request.headSha)
    const plan = { ...buildPlan(request, state, collectDetails(request, inv.reviewable, io)), symlinkMap, policyPack: { path: packPath, sha256: packSha, token: pack.token, index: pack.index, missing: pack.missing } }
    const planSum = fnvSum(plan)
    const planPath = path.join(io.realpath(stateDir), PLAN_FILE(planSum))
    io.writeFile(planPath, JSON.stringify(plan))
    return { plan, plan_sum: planSum, plan_path: planPath }
  },
  pin(body, io) {
    const plan = loadPlan(body, io)
    try {
      const state = collectState(plan, io)
      const pin = checkPin(plan, state, collectDetails(plan, plan.target.files, io))
      const packOk = io.lstat(plan.policyPack.path)?.isFile() && sha256(io.readFile(plan.policyPack.path)) === plan.policyPack.sha256
      if (!packOk) {
        const extra = { cause: 'pack', message: '方針の束が計画の後に変わったか消えた' }
        return { pin: { ...pin, ok: false, problems: [...pin.problems, extra.message], causes: causesOf([...pin.causes, extra], plan.mode) } }
      }
      return { pin }
    } catch (error) {
      // 対象を集め直せないこと（scope が消えた・symlink になった・git が読めない）は、固定が崩れたことと同じに扱う。
      if (!(error instanceof ReviewError)) throw error
      return { pin: failedPin([{ cause: 'collect', message: `${error.code}: ${error.message}` }], plan.mode) }
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
      return respond({
        ok: false, op, code: error.code, reason: error.message, retry: error.detail.retry ?? RETRY.none,
        ...(error.detail.problems ? { problems: error.detail.problems } : {}), ...(error.detail.causes ? { causes: error.detail.causes } : {}),
      }, EXIT.rejected)
    }
    return respond({ ok: false, op, code: CODES.internal, reason: String(error?.stack ?? error), retry: RETRY.none }, EXIT.rejected)
  }
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const { exitCode, output } = main(process.argv.slice(2), readFileSync(0, 'utf8'))
  process.stdout.write(`${output}\n`)
  process.exitCode = exitCode
}
