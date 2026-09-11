#!/usr/bin/env node

// claim-gate の Stop hook 本体。
//
// 排出を止めるのは 1 か所だけ（emitBlock）。他のどこからも stdout へ書かない。
// 「通す」は常に「stdout に何も出さず exit 0」であり、fail-open も同じ経路を通る。
//
// 判定の順序（この順序自体が契約）:
//   0. 判定器として起動された子プロセスなら即 exit（再帰の遮断）
//   1. stdin の JSON（不正・欠損なら pass）
//   2. トグル（off なら以降の一切の処理を行わない = 完全 no-op）
//   3. B1 決定的パターン（ヒット無しなら LLM 呼び出しゼロで pass）
//   4. B2 判定器 spawn（block / pass）
//
// トグルを B1 より前に置くのは、off の契約が「判定しない」ではなく
// 「コストゼロ（読み書きも LLM 呼び出しも走らない）」だからである。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const JUDGE_AGENT_PATH = path.join(PLUGIN_ROOT, "agents", "claim-judge.md");
const SCHEMAS_PATH = path.join(PLUGIN_ROOT, "skills", "claim-gate", "references", "schemas.md");

// 判定器として起動された子プロセスに立てる env マーカー。
// 子は env を継承するので、判定器の応答（"absence" / "none" 等を含む JSON）が
// 子セッションの Stop で再び B1 に当たって判定器を起動する経路を塞げる。
// 入力フィールドによる再入判別（挙動が未確認）には依存しない。
const JUDGE_MARKER_ENV = "CLAIM_GATE_IN_JUDGE";

// 検査時だけ立つ env。production では存在しないので、off の完全 no-op を壊さない。
const STATE_FILE_ENV = "CLAIM_GATE_STATE_FILE";
const TELEMETRY_ENV = "CLAIM_GATE_TELEMETRY";

// B2 は「1 応答を 1 回判定させる」だけで、ツール使用もファイル探索もしない単発呼び出し。
// 上限を大きく取る意味が無い一方、これは利用者が応答を受け取る前に待つ時間そのものなので、
// 先例（codex の stop gate: 900 秒）のような長さは opt-in の前提と合わない。
// hooks.json の Stop エントリの timeout より小さいことが要件で、その差分が node 起動と
// state 読みの余裕にあたる（順序の正本は hooks.json の description）。
const JUDGE_TIMEOUT_MS = 120 * 1000;

// 判定器へ渡す本文の上限。超えた場合は切り落とさず flagged 周辺へ絞り込み、
// 絞り込んだ事実を telemetry に残す（黙った打ち切りは「全文を見て裏付けが無いと
// 判定した」と読まれる）。
const RESPONSE_TEXT_LIMIT = 60000;
const FOCUS_RADIUS = 4000;

// B1: 決定的パターン前段。LLM を呼ばずに「不在・網羅型の断定」らしさだけを見る。
// 過検出は判定器 1 回分のコストで済み、block にはならない（B2 が裏付けを見て通す）。
// 一方 B1 の取りこぼしは判定器に一度も届かないので、precision より recall に寄せている。
// パターンの追加・削除は運用操作ではなく設計変更（skill 層の対象外）。
const B1_PATTERNS = [
  { id: "ja-absence-exist", re: /存在しない|存在しません|存在せず|存在していない/g },
  { id: "ja-absence-nai", re: /(?:は|が|も|に)[^。！？\n]{0,24}(?:無い|ないです|ありません|ございません)(?=[。、！？\n）」]|$)/g },
  { id: "ja-absence-not-found", re: /見当たらない|見当たりません|見つからない|見つかりません|皆無/g },
  { id: "ja-absence-neg-verb", re: /(?:定義|実装|使用|利用|参照|記載|登録|設定|考慮|実行|検証|認証|接続|呼(?:び|)出)され(?:て)?(?:いない|いません|ておらず|ず)/g },
  { id: "ja-exhaustive-only", re: /のみ(?:で|が|を|に|だ|である|です)|だけ(?:で|が|を|だ|である|です)|しかない|しか無い|に限られ(?:る|ます)/g },
  { id: "ja-exhaustive-all", re: /すべて|全て|全件|全ての|例外なく|一切|どこにも|一度も|1\s?つも|一つも|ひとつも|いずれも/g },
  { id: "en-absence", re: /\bthere (?:is|are) no\b|\bdoes not exist\b|\b(?:is|are) not defined\b|\bno such\b|\bnone\b|\bnowhere\b|\bnever\b/gi },
  { id: "en-exhaustive", re: /\bonly\b|\ball of\b|\bevery single\b|\bwithout exception\b|\bin every case\b/gi }
];

let telemetryWritten = false;

function telemetryPath() {
  const raw = process.env[TELEMETRY_ENV];
  return raw && raw.trim() ? raw.trim() : null;
}

// telemetry は検査の観測窓であり、判定には一切関与しない。
// 書けなかった場合も判定を変えない（観測の失敗でゲートの挙動が変わるのは本末転倒）。
function recordTelemetry(record) {
  const target = telemetryPath();
  if (!target) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${JSON.stringify(record)}\n`, "utf8");
    telemetryWritten = true;
  } catch {
    // 観測の失敗は無視する。
  }
}

function emitBlock(reason) {
  process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
}

function stateFilePath() {
  const override = process.env[STATE_FILE_ENV];
  if (override && override.trim()) {
    return override.trim();
  }
  // プロジェクトの作業ツリーには書かない（リポジトリに他人の環境設定が混入する）。
  // user レベル 1 ファイルなので、全プロジェクトで同じ状態を読む。
  return path.join(os.homedir(), ".claude", "claim-gate", "state.json");
}

// ファイル欠如・パース失敗・想定外の値はすべて off。
// truthy 判定にすると「想定外の値は off」という契約を破るので厳密一致で見る。
function isGateEnabled() {
  try {
    const raw = fs.readFileSync(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.enabled === true;
  } catch {
    return false;
  }
}

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) {
      return { ok: false };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { ok: false };
    }
    const message = parsed.last_assistant_message;
    if (typeof message !== "string" || !message.trim()) {
      return { ok: false };
    }
    return { ok: true, message, sessionId: parsed.session_id ?? null, cwd: parsed.cwd ?? null };
  } catch {
    return { ok: false };
  }
}

function sentenceAround(text, index) {
  const delimiters = /[。！？\n]/;
  let start = index;
  while (start > 0 && !delimiters.test(text[start - 1])) {
    start -= 1;
  }
  let end = index;
  while (end < text.length && !delimiters.test(text[end])) {
    end += 1;
  }
  return text.slice(start, Math.min(end + 1, text.length)).trim();
}

function runB1(text) {
  const flagged = [];
  const seen = new Set();
  for (const pattern of B1_PATTERNS) {
    pattern.re.lastIndex = 0;
    let match = pattern.re.exec(text);
    while (match) {
      const quote = sentenceAround(text, match.index);
      const key = `${pattern.id}:${quote}`;
      if (quote && !seen.has(key)) {
        seen.add(key);
        flagged.push({ quote, pattern_id: pattern.id, offset: match.index });
      }
      if (match.index === pattern.re.lastIndex) {
        pattern.re.lastIndex += 1;
      }
      match = pattern.re.exec(text);
    }
  }
  return flagged.sort((a, b) => a.offset - b.offset);
}

function focusText(text, flagged) {
  if (text.length <= RESPONSE_TEXT_LIMIT) {
    return { text, truncated: false };
  }
  const first = flagged.length ? flagged[0].offset : 0;
  const last = flagged.length ? flagged[flagged.length - 1].offset : text.length;
  const start = Math.max(0, first - FOCUS_RADIUS);
  const end = Math.min(text.length, last + FOCUS_RADIUS);
  return { text: text.slice(start, end), truncated: true };
}

// JSON のみを返す約束でも、前後に散文が付くことはある。
// 最初の JSON オブジェクトだけを取り出し、取れなければ unreachable（= pass）。
function extractJsonObject(raw) {
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }
  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // 次の候補へ。
    }
  }
  return null;
}

// 役割定義の frontmatter は agent ファイルのメタデータ（model / subagent_type）であって
// 役割そのものではない。system prompt に混ぜると、判定器が spawn 側の設定を指示として
// 読もうとするので落とす。
function stripFrontmatter(text) {
  if (!text.startsWith("---")) {
    return text;
  }
  const end = text.indexOf("\n---", 3);
  return end < 0 ? text : text.slice(end + 4).replace(/^\s*\n/, "");
}

function runJudge(payload, cwd) {
  let judgeRole;
  try {
    judgeRole = stripFrontmatter(fs.readFileSync(JUDGE_AGENT_PATH, "utf8"));
  } catch {
    // 役割定義が読めないなら判定していない。通す。
    return { status: "unreachable", detail: `judge role definition unreadable: ${JUDGE_AGENT_PATH}` };
  }

  // 役割定義は入出力の形を schemas.md に委ねている。--safe-mode の子セッションは
  // ファイルを読みに行けないので、正本の中身を spawn 側で読んで system prompt に添える。
  // 契約を写し取らず同じファイルを渡すことで、schemas.md が正本のままになる。
  try {
    judgeRole += `\n\n---\n\n# データ契約（schemas.md の写しではなく、その全文）\n\n${fs.readFileSync(SCHEMAS_PATH, "utf8")}`;
  } catch {
    // 契約が読めなくても役割定義だけで判定は成り立つ。判定を止めない。
  }

  // --safe-mode: 子セッションで hooks / skills / CLAUDE.md / plugins を無効にする。
  //   fresh context の前提（司令塔の文脈を混ぜない）を満たし、かつ子の Stop で
  //   このフックが再び走る経路を env マーカーとあわせて二重に塞ぐ。認証は通常どおり。
  // 役割定義は --append-system-prompt で渡し、判定対象は stdin の JSON で渡す。
  //   応答本文をプロンプト文字列へ連結しないのは、コードフェンスを含む本文が
  //   命令の切れ目を作らないようにするため（エスケープは JSON シリアライズに任せる）。
  const args = [
    "-p",
    "--safe-mode",
    "--model",
    "sonnet",
    "--append-system-prompt",
    judgeRole,
    "stdin から JSON 1 オブジェクトを受け取り、役割定義に従って判定し、JSON 1 オブジェクトだけを返せ。"
  ];

  const result = spawnSync("claude", args, {
    cwd: cwd && fs.existsSync(cwd) ? cwd : PLUGIN_ROOT,
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: JUDGE_TIMEOUT_MS,
    env: { ...process.env, [JUDGE_MARKER_ENV]: "1" },
    maxBuffer: 8 * 1024 * 1024
  });

  if (result.error || result.status !== 0) {
    const detail = result.error?.code === "ETIMEDOUT"
      ? `judge timed out after ${JUDGE_TIMEOUT_MS} ms`
      : String(result.error?.message || result.stderr || `exit ${result.status}`).trim().slice(0, 400);
    return { status: "unreachable", detail };
  }

  const parsed = extractJsonObject(result.stdout);
  if (!parsed || (parsed.decision !== "block" && parsed.decision !== "pass")) {
    return { status: "unreachable", detail: "judge output was not a parsable decision object" };
  }
  // block は reason を伴ってはじめて契約を満たす（どの主張が・何の裏付けを欠き・出口は 2 つ）。
  // reason の無い block は差し戻し文を作れないので、自前の定型文で埋めずに通す。
  // 埋めてしまうと「判定器がそう言った」ように読める文面を spawn 側が捏造することになる。
  if (parsed.decision === "block" && !String(parsed.reason || "").trim()) {
    return { status: "unreachable", detail: "judge returned block without a reason" };
  }
  return { status: "ok", verdict: parsed };
}

function main() {
  if (process.env[JUDGE_MARKER_ENV] === "1") {
    return;
  }

  const input = readHookInput();
  if (!input.ok) {
    recordTelemetry({ stage: "input_invalid", failure: "input_invalid", b1_hit: false, llm_calls: 0, decision: "pass" });
    return;
  }

  if (!isGateEnabled()) {
    recordTelemetry({ stage: "toggle_off", b1_hit: false, llm_calls: 0, decision: "pass" });
    return;
  }

  const flagged = runB1(input.message);
  if (flagged.length === 0) {
    recordTelemetry({ stage: "b1_miss", b1_hit: false, llm_calls: 0, decision: "pass" });
    return;
  }

  const focus = focusText(input.message, flagged);
  const payload = {
    flagged,
    response_text: focus.text,
    judge_agent_path: JUDGE_AGENT_PATH
  };

  const judged = runJudge(payload, input.cwd);
  if (judged.status !== "ok") {
    recordTelemetry({
      stage: "judge_unreachable",
      failure: "unreachable",
      detail: judged.detail,
      b1_hit: true,
      llm_calls: 1,
      decision: "pass",
      truncated: focus.truncated
    });
    return;
  }

  const verdict = judged.verdict;
  recordTelemetry({
    stage: "judged",
    b1_hit: true,
    llm_calls: 1,
    decision: verdict.decision,
    claim_type: verdict.claim_type ?? null,
    support: verdict.support ?? null,
    truncated: focus.truncated
  });

  if (verdict.decision === "block") {
    emitBlock(String(verdict.reason).trim());
  }
}

// handler_error の契約: ハンドラ自身の例外は自分で捕まえ、stdout を空にして exit 0（= pass）。
// 先例（codex の stop gate）は最下部で exitCode = 1 にしているが、claim-gate は逆に倒す。
// 例外で非ゼロ終了すると、排出側の挙動が harness 依存（未観測）になり、
// 「全経路 fail-open」が成り立たなくなる。例外が起きた事実は telemetry から読める。
try {
  main();
  process.exitCode = 0;
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  try {
    process.stderr.write(`claim-gate handler error: ${message}\n`);
  } catch {
    // stderr も書けないなら何もしない。
  }
  if (!telemetryWritten) {
    recordTelemetry({ stage: "handler_error", failure: "handler_error", detail: String(message).slice(0, 400), b1_hit: null, llm_calls: null, decision: "pass" });
  } else {
    recordTelemetry({ stage: "handler_error", failure: "handler_error", detail: String(message).slice(0, 400), decision: "pass" });
  }
  process.exitCode = 0;
}
