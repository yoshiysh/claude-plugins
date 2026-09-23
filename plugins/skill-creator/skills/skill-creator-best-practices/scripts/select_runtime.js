#!/usr/bin/env node
// Workflow 呼び出し前の経路選択。native `Workflow` を使うのか、Codex 互換層
// （workflow:dynamic-workflow-runner）を使うのか、どちらも使わず停止するのかを決める。
//
// なぜ script なのか: この判定は「試行済みか」「native があるか」「mode が runner で
// 意味保存できるか」という状態と集合の突き合わせで、判断の余地が無い。散文の分岐条件として
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
//   node scripts/select_runtime.js --mode review --no-native --runner-installed
//   node scripts/select_runtime.js --mode update --no-native --runner-installed
//
// 出力（JSON 1 行）:
//   { "selected_runtime": "native" | "dynamic-workflow-runner" | null,
//     "rejected_reason": null | "<理由>", "halt": true|false }
// halt: true のとき execution agent を 1 体も起動しない。未実施と理由をユーザーへ伝えて止める。

// review inputs are not frozen and update's staging, manifest, reverify, and apply boundaries
// are incomplete. Capability declarations cannot prove those invariants, so both modes stop.
const RUNNER_REJECTED_MODES = ['review', 'update']

const MODES = ['create', 'review', 'update']

function parse(argv) {
  const out = { mode: null, nativeAvailable: null, nativeAttempted: false, runnerInstalled: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--mode') out.mode = argv[++i]
    else if (a === '--native-available') out.nativeAvailable = true
    else if (a === '--no-native') out.nativeAvailable = false
    else if (a === '--native-attempted') out.nativeAttempted = true
    else if (a === '--runner-installed') out.runnerInstalled = true
    else if (a === '--no-runner') out.runnerInstalled = false
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

function selectRuntime({ mode, nativeAvailable, nativeAttempted, runnerInstalled }) {
  if (nativeAvailable && !nativeAttempted) {
    return { selected_runtime: 'native', rejected_reason: null, halt: false }
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
  if (RUNNER_REJECTED_MODES.includes(mode)) {
    return {
      selected_runtime: null,
      rejected_reason: `rejected_source: mode=${mode} は runner では意味保存できない`,
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
  return { selected_runtime: 'dynamic-workflow-runner', rejected_reason: null, halt: false }
}

try {
  process.stdout.write(JSON.stringify(selectRuntime(parse(process.argv.slice(2)))) + '\n')
} catch (e) {
  process.stderr.write(`${e.message}\n`)
  process.exit(2)
}
