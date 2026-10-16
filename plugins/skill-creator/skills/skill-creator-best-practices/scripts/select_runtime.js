#!/usr/bin/env node
// Workflow 呼び出し前の経路選択。native `Workflow` を使うのか、Codex 互換層
// （workflow:dynamic-workflow-runner）を使うのか、どちらも使わず停止するのかを決める。
//
// なぜ script なのか: この判定は「試行済みか」「native があるか」「snapshot proof があるか」
// という状態と集合の突き合わせで、判断の余地が無い。散文の分岐条件として
// 置くと、司令塔が自分の記憶で状態を追うことになり、同じ呼び出しでも実行のたびに経路が
// ブレる（fallback 禁止のような「1 回だけ」規則は、回数を覚えている主体が必要）。
//
// なぜ workflow script の中に置けないのか: これは workflow を起動する前の判定で、
// 起動してからでは経路はもう選ばれている。workflow script 内に置くと、選ばれなかった経路の
// 判定をその経路の中で行うことになる。だから呼び出し前のヘルパー CLI にしてある
// （quick_validate.py --emit-unchecked と同じ形。司令塔は出力をそのまま使う）。
//
// 使い方:
//   node scripts/select_runtime.js --mode create --native-available --runner-installed
//   node scripts/select_runtime.js --mode review --no-native --runner-installed --snapshot-receipt <receipt>
//     --snapshot-target <canonical-target> --snapshot-scope full
//   node scripts/select_runtime.js --mode audit --no-native --runner-installed --snapshot-receipt <receipt>
//     --snapshot-target <canonical-target> --snapshot-scope diff --snapshot-diff-ref main...HEAD
//   node scripts/select_runtime.js --mode update --no-native --runner-installed --update-policy-bound --snapshot-receipt <receipt>
//     --snapshot-target <canonical-target> --snapshot-scope full|diff [--snapshot-diff-ref <range>]
//
// 出力（JSON 1 行）:
//   { "selected_runtime": "native" | "dynamic-workflow-runner" | null,
//     "rejected_reason": null | "<理由>", "halt": true|false,
//     "runner_limits": <dynamic-workflow-runner request の top-level limits> }
// halt: true のとき execution agent を 1 体も起動しない。未実施と理由をユーザーへ伝えて止める。

const { createHash } = require('node:crypto')
const { readFileSync, lstatSync, realpathSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// update still requires a host-bound policy; the runtime validates that policy against its staging-only SDK backend before dispatch.

const MODES = ['create', 'review', 'update', 'audit']
const RUNNER_LIMITS = { maxAgents: 1000, concurrency: 8, timeoutMs: 3600000, agentTimeoutMs: 300000, maxOutputBytes: 20000000 }

function parse(argv) {
  const out = {
    mode: null,
    nativeAvailable: null,
    nativeAttempted: false,
    runnerInstalled: null,
    updatePolicyBound: false,
    snapshotReceipt: null,
    snapshotTarget: null,
    snapshotScope: null,
    snapshotDiffRef: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--mode') out.mode = argv[++i]
    else if (a === '--native-available') out.nativeAvailable = true
    else if (a === '--no-native') out.nativeAvailable = false
    else if (a === '--native-attempted') out.nativeAttempted = true
    else if (a === '--runner-installed') out.runnerInstalled = true
    else if (a === '--no-runner') out.runnerInstalled = false
    else if (a === '--update-policy-bound') out.updatePolicyBound = true
    else if (a === '--snapshot-receipt') out.snapshotReceipt = argv[++i]
    else if (a === '--snapshot-target') out.snapshotTarget = argv[++i]
    else if (a === '--snapshot-scope') out.snapshotScope = argv[++i]
    else if (a === '--snapshot-diff-ref') out.snapshotDiffRef = argv[++i]
    else throw new Error(`未知の引数: ${a}`)
  }
  if (!MODES.includes(out.mode)) {
    throw new Error(`--mode は ${MODES.join(' | ')} のいずれかです（受領: ${out.mode}）`)
  }
  // 三値（未指定）を黙って false に丸めない。inventory を確認していない状態で
  // 「native は無い」と決めると、あるのに runner へ倒す経路ができる。
  if (out.nativeAvailable === null) throw new Error('--native-available か --no-native が必要です')
  if (out.runnerInstalled === null) throw new Error('--runner-installed か --no-runner が必要です')
  return out
}

async function snapshotProof({ mode, snapshotReceipt, snapshotTarget, snapshotScope, snapshotDiffRef }) {
  if (!['review', 'audit', 'update'].includes(mode)) return { required: false, valid: true }
  try {
    const { VERSION, SNAPSHOT_LAYOUT, SNAPSHOT_PREFIX } = await import('./review-snapshot.mjs')
    if (!snapshotReceipt || !path.isAbsolute(snapshotReceipt)) throw Error('absolute --snapshot-receipt is required')
    if (!snapshotTarget || !path.isAbsolute(snapshotTarget)) throw Error('absolute --snapshot-target is required')
    if (!['full', 'diff'].includes(snapshotScope)) throw Error('--snapshot-scope must be full or diff')
    if (snapshotScope === 'diff' && !snapshotDiffRef) throw Error('--snapshot-diff-ref is required for diff scope')
    if (snapshotScope === 'full' && snapshotDiffRef) throw Error('--snapshot-diff-ref is not valid for full scope')
    const receiptInfo = lstatSync(snapshotReceipt)
    if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink()) throw Error('snapshot receipt is not a regular file')
    const receiptPath = realpathSync(snapshotReceipt)
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    if (receipt.version !== VERSION || receipt.status !== 'ready' || receipt.scope !== snapshotScope) throw Error('snapshot receipt is not ready for the requested scope')
    if (!/^[a-f0-9]{64}$/.test(receipt.manifestSha256 || '')) throw Error('snapshot receipt has an invalid manifest SHA-256')
    const canonicalTarget = realpathSync(snapshotTarget)
    if (canonicalTarget !== snapshotTarget || receipt.targetRoot !== canonicalTarget) throw Error('snapshot receipt target does not match the canonical target')
    if (receipt.diffRef !== (snapshotDiffRef || null)) throw Error('snapshot receipt diff range does not match the request')
    const tmpRoot = realpathSync(os.tmpdir())
    const snapshotRoot = realpathSync(receipt.snapshotRoot)
    if (snapshotRoot !== receipt.snapshotRoot || path.dirname(snapshotRoot) !== tmpRoot || !path.basename(snapshotRoot).startsWith(SNAPSHOT_PREFIX))
      throw Error('snapshot receipt is outside the managed temporary directory')
    if (receiptPath !== path.join(snapshotRoot, SNAPSHOT_LAYOUT.receipt) ||
        receipt.manifestPath !== path.join(snapshotRoot, SNAPSHOT_LAYOUT.manifest) ||
        receipt.snapshotDir !== path.join(snapshotRoot, SNAPSHOT_LAYOUT.tree))
      throw Error('snapshot receipt paths are inconsistent')
    const snapshotInfo = lstatSync(receipt.snapshotDir)
    if (!snapshotInfo.isDirectory() || snapshotInfo.isSymbolicLink()) throw Error('frozen target snapshot is missing or invalid')
    const manifestInfo = lstatSync(receipt.manifestPath)
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw Error('snapshot manifest is not a regular file')
    const manifestBytes = readFileSync(receipt.manifestPath)
    const digest = createHash('sha256').update(manifestBytes).digest('hex')
    if (digest !== receipt.manifestSha256) throw Error('snapshot manifest hash does not match the receipt')
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    if (manifest.version !== VERSION || manifest.targetRoot !== canonicalTarget || manifest.scope !== snapshotScope || manifest.snapshotDir !== receipt.snapshotDir)
      throw Error('snapshot manifest does not match the receipt')
    if (!Array.isArray(manifest.files) || !Array.isArray(manifest.directories) || !Number.isSafeInteger(manifest.totalBytes) ||
        !manifest.limits || !Number.isSafeInteger(manifest.limits.maxFiles) || !Number.isSafeInteger(manifest.limits.maxFileBytes) ||
        !Number.isSafeInteger(manifest.limits.maxTotalBytes) || !Number.isSafeInteger(manifest.limits.maxDiffBytes))
      throw Error('snapshot manifest has no valid file inventory')
    let totalBytes = 0
    for (const entry of manifest.files) {
      if (!entry || typeof entry.path !== 'string' || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes('..') ||
          !Number.isSafeInteger(entry.size) || !/^[a-f0-9]{64}$/.test(entry.sha256 || ''))
        throw Error('snapshot manifest contains an invalid file entry')
      if (entry.size > manifest.limits.maxFileBytes) throw Error(`snapshot file exceeds its manifest cap: ${entry.path}`)
      const filePath = path.resolve(receipt.snapshotDir, entry.path)
      const relative = path.relative(receipt.snapshotDir, filePath)
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`))
        throw Error(`snapshot manifest path escapes target: ${entry.path}`)
      const fileInfo = lstatSync(filePath)
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size !== entry.size)
        throw Error(`frozen target file is missing or invalid: ${entry.path}`)
      const bytes = readFileSync(filePath)
      if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
        throw Error(`frozen target file hash mismatch: ${entry.path}`)
      totalBytes += bytes.length
    }
    if (totalBytes !== manifest.totalBytes || manifest.files.length > manifest.limits.maxFiles || totalBytes > manifest.limits.maxTotalBytes)
      throw Error('snapshot file inventory exceeds its declared bounds')
    if (snapshotScope === 'diff') {
      if (manifest.diffRef !== snapshotDiffRef || !Array.isArray(manifest.changedPaths) ||
          !/^[a-f0-9]{64}$/.test(manifest.diffSha256 || '') || manifest.diffPath !== path.join(snapshotRoot, SNAPSHOT_LAYOUT.diff) ||
          manifest.changedPathsPath !== path.join(snapshotRoot, SNAPSHOT_LAYOUT.changedPaths) ||
          receipt.diffPath !== manifest.diffPath || receipt.changedPathsPath !== manifest.changedPathsPath || receipt.diffSha256 !== manifest.diffSha256 ||
          JSON.stringify(receipt.changedPaths) !== JSON.stringify(manifest.changedPaths))
        throw Error('snapshot manifest is missing its frozen diff')
      const diffInfo = lstatSync(manifest.diffPath)
      const pathsInfo = lstatSync(manifest.changedPathsPath)
      if (!diffInfo.isFile() || diffInfo.isSymbolicLink() || !pathsInfo.isFile() || pathsInfo.isSymbolicLink())
        throw Error('frozen diff artifacts are not regular files')
      const diffBytes = readFileSync(manifest.diffPath)
      const pathBytes = readFileSync(manifest.changedPathsPath)
      if (diffBytes.length !== manifest.diffBytes || diffBytes.length > manifest.limits.maxDiffBytes ||
          createHash('sha256').update(diffBytes).digest('hex') !== manifest.diffSha256 ||
          JSON.stringify(JSON.parse(pathBytes.toString('utf8'))) !== JSON.stringify(manifest.changedPaths))
        throw Error('frozen diff bytes or changed paths failed validation')
    } else if (manifest.diffRef !== null || manifest.diffPath !== null || manifest.changedPathsPath !== null || manifest.diffSha256 !== null ||
        !Array.isArray(manifest.changedPaths) || manifest.changedPaths.length !== 0 || receipt.diffPath !== null ||
        receipt.changedPathsPath !== null || receipt.diffSha256 !== null || !Array.isArray(receipt.changedPaths) || receipt.changedPaths.length !== 0) {
      throw Error('full snapshot contains unexpected diff metadata')
    }
    return { required: true, valid: true, manifestSha256: digest, snapshotDir: receipt.snapshotDir, manifestPath: receipt.manifestPath }
  } catch (error) {
    return { required: true, valid: false, error: error?.message || String(error) }
  }
}

async function selectRuntime({ mode, nativeAvailable, nativeAttempted, runnerInstalled, updatePolicyBound, ...snapshotArgs }) {
  const withProof = (result, proof) => proof.required
    ? {
      ...result,
      snapshot_manifest_sha256: proof.manifestSha256,
      snapshot_dir: proof.snapshotDir,
      snapshot_receipt_path: snapshotArgs.snapshotReceipt,
    }
    : result

  if (nativeAvailable && !nativeAttempted) {
    const proof = await snapshotProof({ mode, ...snapshotArgs })
    if (!proof.valid) {
      return {
        selected_runtime: null,
        rejected_reason: `rejected_source: review snapshot proof failed: ${proof.error}`,
        halt: true,
      }
    }
    return withProof({ selected_runtime: 'native', rejected_reason: null, halt: false }, proof)
  }
  if (nativeAttempted) {
    // native を試した後の error / timeout / invalid result で runner へ落とすと、
    // native 側がどこまで進んだか（どの phase の副作用が残っているか）が分からないまま
    // 同じ call を二重に実行することになり、human gate の所有も両者に分かれる。
    return {
      selected_runtime: null,
      rejected_reason:
        'native Workflow を試行済みのため fallback しない（部分実行後の二重実行と gate 所有の混線を避ける）',
      halt: true,
    }
  }
  if (mode === 'update' && !updatePolicyBound) {
    return {
      selected_runtime: null,
      rejected_reason: 'rejected_source: mode=update には host-bound updatePolicy が必要',
      halt: true,
    }
  }

  const proof = await snapshotProof({ mode, ...snapshotArgs })
  if (!proof.valid) {
    return {
      selected_runtime: null,
      rejected_reason: `rejected_source: review snapshot proof failed: ${proof.error}`,
      halt: true,
    }
  }
  if (!runnerInstalled) {
    return {
      selected_runtime: null,
      rejected_reason: 'dynamic-workflow-runner が未 install',
      halt: true,
    }
  }
  return withProof({
    selected_runtime: 'dynamic-workflow-runner', rejected_reason: null, halt: false,
    runner_limits: RUNNER_LIMITS,
  }, proof)
}

async function main() {
  const result = await selectRuntime(parse(process.argv.slice(2)))
  process.stdout.write(JSON.stringify(result) + '\n')
}

main().catch((e) => {
  process.stderr.write(`${e.message}\n`)
  process.exitCode = 2
})
