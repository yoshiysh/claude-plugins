#!/usr/bin/env node

// claim-gate の適合検査。
//
// 算術と一致判定はすべてここが持つ。agent 側で集計させると台帳の判定が決定的でなくなり、
// 再現可能なテストにならない（集計を agent に委ねない契約。README「適合検査の実行」参照）。
//
// 検査は fixture の再現性を見るものであって、ゲートの効果（検出率・誤ブロック率）の
// 測定ではない。この出力から効果を読まないこと。
//
// 使い方:
//   node scripts/run_conformance.mjs                     # 全 fixture を通す（B2 を呼ぶ）
//   node scripts/run_conformance.mjs --b1-only           # 決定的部分だけ（LLM 呼び出しなし）
//   node scripts/run_conformance.mjs --message "<文面>"   # 単件モード
//   node scripts/run_conformance.mjs --fixtures <dir>     # fixture ディレクトリの指定
//   node scripts/run_conformance.mjs --toggle off         # off 区分だけを見る
//
// 利用者の実 state file は読み書きしない。検査は毎回一時ディレクトリに state を作り、
// `CLAIM_GATE_STATE_FILE` で hook に渡す。したがって off 区分が示すのは
// **コード経路が no-op であること**で、利用者の環境が現に off であることではない。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const HOOK_PATH = path.join(SCRIPT_DIR, "stop-claim-gate-hook.mjs");
const DEFAULT_FIXTURES = path.join(PLUGIN_ROOT, "tests", "fixtures");

// 1 件あたりの上限。hook 側の JUDGE_TIMEOUT_MS（stop-claim-gate-hook.mjs）に node 起動分を
// 足した値より大きく取る。小さくすると検査側の kill が unreachable と見分けられなくなる。
const CASE_TIMEOUT_MS = 180 * 1000;

function parseArgs(argv) {
  const options = { fixtures: DEFAULT_FIXTURES, message: null, toggle: "on", b1Only: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fixtures") {
      options.fixtures = argv[++i];
    } else if (arg === "--message") {
      options.message = argv[++i];
    } else if (arg === "--toggle") {
      options.toggle = argv[++i];
    } else if (arg === "--b1-only") {
      options.b1Only = true;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  if (options.toggle !== "on" && options.toggle !== "off") {
    return { error: `--toggle must be "on" or "off"` };
  }
  return { options };
}

function makeWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claim-gate-conformance-"));
}

function loadFixtures(dir) {
  if (!fs.existsSync(dir)) {
    return { error: `fixture ディレクトリがありません: ${dir}` };
  }
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  if (files.length === 0) {
    return { error: `fixture が 1 件もありません: ${dir}` };
  }
  const fixtures = [];
  const malformed = [];
  for (const name of files) {
    const full = path.join(dir, name);
    try {
      const fixture = JSON.parse(fs.readFileSync(full, "utf8"));
      if (!fixture.id || !fixture.expect || !fixture.source || typeof fixture.message !== "string") {
        malformed.push({ file: name, reason: "id / expect / source / message のいずれかが欠けています" });
        continue;
      }
      fixtures.push(fixture);
    } catch (error) {
      malformed.push({ file: name, reason: String(error.message || error).slice(0, 200) });
    }
  }
  return { fixtures, malformed };
}

// hook を 1 回動かし、stdout（block の有無）と telemetry（B1 / 判定器の観測）を返す。
function runHook({ stdinRaw, stateFile, telemetryFile, judgeReachable }) {
  const env = { ...process.env, CLAIM_GATE_STATE_FILE: stateFile, CLAIM_GATE_TELEMETRY: telemetryFile };
  delete env.CLAIM_GATE_IN_JUDGE;
  if (!judgeReachable) {
    // 判定器を呼ばずに B1 の観測だけを取るための手当て。production 側へ
    // fault injection の経路を作らずに、子プロセスから `claude` を見えなくする。
    env.PATH = path.join(os.tmpdir(), "claim-gate-no-claude");
  }

  const before = fs.existsSync(telemetryFile) ? fs.readFileSync(telemetryFile, "utf8").split("\n").filter(Boolean).length : 0;
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: stdinRaw,
    encoding: "utf8",
    timeout: CASE_TIMEOUT_MS,
    env,
    cwd: PLUGIN_ROOT
  });

  const lines = fs.existsSync(telemetryFile)
    ? fs.readFileSync(telemetryFile, "utf8").split("\n").filter(Boolean).slice(before)
    : [];
  const records = lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { stage: "telemetry_unparsable" };
    }
  });

  let stdoutDecision = "pass";
  let reason = null;
  const stdout = String(result.stdout || "").trim();
  if (stdout) {
    try {
      const payload = JSON.parse(stdout);
      if (payload?.decision === "block") {
        stdoutDecision = "block";
        reason = String(payload.reason || "");
      }
    } catch {
      stdoutDecision = "unparsable_stdout";
    }
  }

  return {
    actual: stdoutDecision,
    reason,
    exitStatus: result.status,
    timedOut: result.error?.code === "ETIMEDOUT",
    records
  };
}

function summarizeRecords(records) {
  const last = records.length ? records[records.length - 1] : null;
  const failures = records.map((record) => record.failure).filter(Boolean);
  return {
    stage: last?.stage ?? null,
    b1_hit: last?.b1_hit ?? null,
    llm_calls: last?.llm_calls ?? 0,
    truncated: Boolean(last?.truncated),
    failure: failures.length ? failures[failures.length - 1] : null,
    detail: last?.detail ?? null
  };
}

function scoreCase(fixture, run, observed, b1Only) {
  // 判定に一度も到達していない故障（ハンドラ例外）は合否に効かせる。
  if (observed.failure === "handler_error") {
    return { ok: false, scored: true, bucket: "handler_error" };
  }
  if (observed.failure === "input_invalid") {
    return { ok: null, scored: false, bucket: "input_invalid" };
  }
  if (run.actual === "unparsable_stdout") {
    return { ok: false, scored: true, bucket: "failed" };
  }

  if (fixture.expect === "no_op") {
    const ok = run.actual === "pass" && observed.b1_hit === false && observed.llm_calls === 0 && observed.stage === "toggle_off";
    return { ok, scored: true, bucket: ok ? "ok" : "failed" };
  }

  if (fixture.expect === "pass_without_llm") {
    const ok = run.actual === "pass" && observed.b1_hit === false && observed.llm_calls === 0;
    return { ok, scored: true, bucket: ok ? "ok" : "failed" };
  }

  // B1 だけの検査: 判定器に届いたかどうか（= B1 がその主張を拾えたか）までを見る。
  if (b1Only) {
    if (fixture.expect === "block") {
      const ok = observed.b1_hit === true;
      return { ok, scored: true, bucket: ok ? "ok" : "failed", partial: "b1_hit のみ判定（B2 未実行）" };
    }
    // 台帳の真主張は B2 を通らないと合否が決まらないので、このモードでは採点しない。
    return { ok: null, scored: false, bucket: "not_scored", partial: "B2 を要するため --b1-only では未採点" };
  }

  if (observed.failure === "unreachable") {
    return { ok: null, scored: false, bucket: "unreachable" };
  }

  const ok = run.actual === fixture.expect;
  return { ok, scored: true, bucket: ok ? "ok" : "failed" };
}


// 同梱物の実在検査（旧 install-check agent の吸収）。hooks.json の Stop 登録が欠けると
// 判定器一式が揃っていても hook は一度も起動しないため、存在だけでなく登録内容まで見る。
// enable 状態（/plugin の user レベル enable）はここからは観測できないので測らない。
function checkArtifacts() {
  const items = [];
  const add = (name, present, detail) => items.push({ name, present, detail: detail ?? null });

  add("scripts/stop-claim-gate-hook.mjs", fs.existsSync(HOOK_PATH));
  add("scripts/run_conformance.mjs", true, "実行中の本体");
  add("tests/fixtures/", fs.existsSync(DEFAULT_FIXTURES));
  add("agents/claim-judge.md", fs.existsSync(path.join(PLUGIN_ROOT, "agents", "claim-judge.md")));

  const hooksJson = path.join(PLUGIN_ROOT, "hooks", "hooks.json");
  if (!fs.existsSync(hooksJson)) {
    add("hooks/hooks.json (Stop 登録)", false, "ファイルが無い");
  } else {
    try {
      const d = JSON.parse(fs.readFileSync(hooksJson, "utf8"));
      const stops = (d.hooks?.Stop ?? []).flatMap((e) => e.hooks ?? []);
      const registered = stops.some((h) => h.type === "command" && String(h.command).includes("stop-claim-gate-hook.mjs"));
      add("hooks/hooks.json (Stop 登録)", registered, registered ? null : "Stop に hook スクリプトを起動するエントリが無い");
    } catch (e) {
      add("hooks/hooks.json (Stop 登録)", false, `JSON parse 失敗: ${e.message}`);
    }
  }
  return items;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stdout.write(`${JSON.stringify({ error: parsed.error, verdict: null }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  const options = parsed.options;

  if (!fs.existsSync(HOOK_PATH)) {
    process.stdout.write(`${JSON.stringify({ error: `hook script がありません: ${HOOK_PATH}`, verdict: null }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  const workDir = makeWorkDir();
  const stateOn = path.join(workDir, "state-on.json");
  const stateOff = path.join(workDir, "state-off.json");
  const telemetryFile = path.join(workDir, "telemetry.jsonl");
  fs.writeFileSync(stateOn, JSON.stringify({ enabled: true }), "utf8");
  fs.writeFileSync(stateOff, JSON.stringify({ enabled: false }), "utf8");

  let cases = [];
  let malformed = [];

  if (options.message !== null) {
    cases = [{ id: "single", expect: "unspecified", source: "single", message: options.message }];
  } else if (options.toggle === "off") {
    cases = [];
  } else {
    const loaded = loadFixtures(options.fixtures);
    if (loaded.error) {
      process.stdout.write(`${JSON.stringify({ error: loaded.error, verdict: null }, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }
    cases = loaded.fixtures;
    malformed = loaded.malformed;
  }

  const results = [];
  const runOne = (fixture, { stateFile, judgeReachable, stdinRaw }) => {
    const run = runHook({
      stdinRaw: stdinRaw ?? JSON.stringify({
        session_id: `conformance-${fixture.id}`,
        last_assistant_message: fixture.message,
        cwd: PLUGIN_ROOT
      }),
      stateFile,
      telemetryFile,
      judgeReachable
    });
    const observed = summarizeRecords(run.records);
    const scored = scoreCase(fixture, run, observed, options.b1Only);
    results.push({
      id: fixture.id,
      source: fixture.source,
      expect: fixture.expect,
      actual: run.actual,
      b1_hit: observed.b1_hit,
      llm_calls: observed.llm_calls,
      stage: observed.stage,
      failure: observed.failure,
      detail: observed.detail,
      truncated: observed.truncated,
      reason: run.reason,
      ok: scored.ok,
      bucket: scored.bucket,
      partial: scored.partial ?? null,
      note: fixture.note ?? null
    });
  };

  // トグル off の区分。fixture の 1 件（block されるべき文面）を off の state で通し、
  // B1 も判定器も走らないことを確認する。判定器が到達可能である必要はない。
  const offProbeMessage = cases.find((c) => c.expect === "block")?.message
    ?? "この設定はどこにも定義されていません。";
  runOne(
    { id: "toggle-off", source: "control", expect: "no_op", message: offProbeMessage, note: "off の区分。state を off にしたときに完全 no-op であることだけを見る" },
    { stateFile: stateOff, judgeReachable: false }
  );

  // stdin 不正の区分。判定材料が無いときに block しないこと（fail-open）を確認する。
  runOne(
    { id: "input-invalid", source: "control", expect: "pass", message: "", note: "stdin が JSON でないときの経路。合否には数えない（input_invalid）" },
    { stateFile: stateOn, judgeReachable: false, stdinRaw: "{ this is not json" }
  );

  if (options.toggle === "on") {
    for (const fixture of cases) {
      runOne(fixture, { stateFile: stateOn, judgeReachable: !options.b1Only });
    }
  }

  const summary = {
    total: results.filter((r) => r.bucket === "ok" || r.bucket === "failed" || r.bucket === "handler_error").length,
    ok: results.filter((r) => r.bucket === "ok").length,
    failed: results.filter((r) => r.bucket === "failed").length,
    unreachable: results.filter((r) => r.bucket === "unreachable").length,
    input_invalid: results.filter((r) => r.bucket === "input_invalid").length,
    handler_error: results.filter((r) => r.bucket === "handler_error").length,
    not_scored: results.filter((r) => r.bucket === "not_scored").length
  };

  // 採点できたケースが 0 件なら verdict は null（0 は実測の一致を意味する値なので
  // 欠測と混ぜない）。
  let verdict = null;
  if (summary.total > 0) {
    verdict = summary.failed === 0 && summary.handler_error === 0 && malformed.length === 0 ? "pass" : "fail";
  }

  // 同梱物の欠落は「検査が走った範囲」の外で起きる故障なので、採点結果に関わらず fail に倒す。
  const artifacts = checkArtifacts();
  if (artifacts.some((a) => !a.present)) {
    verdict = "fail";
  }

  const output = {
    mode: options.b1Only ? "b1_only" : options.message !== null ? "single" : "full",
    toggle_state: options.toggle,
    fixtures_dir: options.fixtures,
    state_file: "検査用の一時ファイル（利用者の state file は読み書きしていない）",
    artifacts,
    cases: results,
    malformed_fixtures: malformed,
    truncated: results.filter((r) => r.truncated).map((r) => r.id),
    summary,
    verdict
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = verdict === "fail" ? 1 : 0;
}

main();
