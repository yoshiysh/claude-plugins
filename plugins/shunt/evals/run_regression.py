"""Regression harness: upstream の hook eval 2 系（bash-read-gate 17 件 / read-gate 17 件）を
fork の hook に通し、上流ラベル（= 上流実装の挙動）と fork の判定を並記した回帰表を出す。

閾値判定はしない。上流ラベルの生成元は置換対象の行数規則そのものなので、一致率は
判定品質を測れない（一致 = 上流互換、差分 = 挙動変更の候補として ID と理由で列挙し、
良否は読み手が判断する）。model 判定か code 確定かの分類は、遅延や文言の推測ではなく
SHUNT_TRACE_FILE に API 試行ごとに 1 行追記される outcome / http / error_status で証明する。

実行: CLAUDE_PLUGINS_GEMINI_API_KEY を設定した上で
  python3 evals/run_regression.py
API を叩きうるケースの間隔は SHUNT_REGRESSION_MIN_INTERVAL_SECONDS（既定 4.5 秒）で空ける。
出力: evals/regression.json / evals/regression.md
"""
import json
import os
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, ".fixtures")
# Real, hand-written fixture files (evals/fixtures/) used by the two-axis
# (cost x fidelity) eval cases below. Unlike FIXTURES (.fixtures/), these are
# never synthetically overwritten — the whole point is that the gate samples
# their real content to judge complexity, not a generic "line N" filler.
REAL_FIXTURES = os.path.join(HERE, "fixtures")
TRACE = os.path.join(FIXTURES, "trace.jsonl")

# Proactive pacing between cases that may consult the gate model. In a
# sequential run the 429s began after ~14 decide calls within about a minute,
# consistent with a ~15 requests/minute quota; 4.5 s caps the run at ~13
# requests/minute with headroom. The exact quota is not documented here, so it
# stays configurable. The hook itself never retries (its 8 s PreToolUse budget
# does not allow it), so pacing has to happen in the harness.
MIN_INTERVAL = float(os.environ.get("SHUNT_REGRESSION_MIN_INTERVAL_SECONDS", "4.5"))

SUITES = [
    {"hook": "bash-read-gate", "evals": "bash-hook-evals.json",
     "payload_key": "command", "fixture_name": lambda lines: "large.txt" if lines >= 350 else "small.txt"},
    {"hook": "read-gate", "evals": "hook-evals.json",
     "payload_key": None, "fixture_name": None},
]


def fixture_path(lines: int) -> str:
    path = os.path.join(FIXTURES, f"lines-{lines}.txt")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write("".join(f"line {i}\n" for i in range(1, lines + 1)))
    return path


def make_named_fixtures():
    """bash-hook-evals はコマンド文字列内の {{FIXTURES}}/large.txt 等を名前で参照する。

    "dir name/large.txt" はスペース入りパスの word-split バグ（bash-read-gate
    の quoted-path 引数パース）の回帰用フィクスチャ — サブディレクトリ名自体に
    スペースを含める。
    """
    os.makedirs(FIXTURES, exist_ok=True)
    for name, lines in (("large.txt", 800), ("small.txt", 100), ("medium.txt", 250), ("over.txt", 351),
                        ("dir name/large.txt", 800)):
        p = os.path.join(FIXTURES, name)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write("".join(f"line {i}\n" for i in range(1, lines + 1)))


def new_trace_lines(offset: int) -> list:
    """Trace entries appended since `offset`; non-JSON lines are skipped."""
    if not os.path.exists(TRACE):
        return []
    with open(TRACE, "rb") as f:
        f.seek(offset)
        chunk = f.read().decode("utf-8", errors="replace")
    entries = []
    for line in chunk.splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(entry, dict):
            entries.append(entry)
    return entries


def pace(pacing: dict) -> None:
    """Wait until MIN_INTERVAL has passed since the last case that hit the API."""
    if pacing["last_api_at"] is None:
        return
    wait = MIN_INTERVAL - (time.monotonic() - pacing["last_api_at"])
    if wait > 0:
        time.sleep(wait)
        pacing["waited_seconds"] += wait


def run_suite(suite, pacing: dict) -> list:
    hook = os.path.join(HERE, "..", "hooks", suite["hook"], "run")
    evals = json.load(open(os.path.join(HERE, suite["evals"])))["evals"]
    rows = []
    for e in evals:
        tool_input = {}
        for k, v in e["input"]["tool_input"].items():
            if isinstance(v, str):
                v = v.replace("{{FIXTURES}}", FIXTURES).replace("{{REAL_FIXTURES}}", REAL_FIXTURES)
            tool_input[k] = v
        fixture = e.get("fixture")
        if fixture and "file_path" in tool_input and "{{FIXTURES}}" not in e["input"]["tool_input"].get("file_path", ""):
            pass
        if fixture and "file_path" in e["input"]["tool_input"]:
            named = e["input"]["tool_input"]["file_path"].replace("{{FIXTURES}}/", "")
            p = os.path.join(FIXTURES, named)
            with open(p, "w") as f:
                f.write("".join(f"line {i}\n" for i in range(1, fixture["lines"] + 1)))
            tool_input["file_path"] = p
        env = {**os.environ, "SHUNT_TRACE_FILE": TRACE, **e.get("env", {})}
        pace(pacing)
        before = os.path.getsize(TRACE) if os.path.exists(TRACE) else 0
        t0 = time.time()
        out = subprocess.run(["bash", hook], input=json.dumps({"tool_input": tool_input}),
                             capture_output=True, text=True, env=env)
        ms = int((time.time() - t0) * 1000)
        added = new_trace_lines(before)
        if added:
            pacing["last_api_at"] = time.monotonic()
        attempt = added[-1] if added else {}
        try:
            verdict = json.loads(out.stdout) if out.stdout.strip() else {"decision": "allow"}
        except json.JSONDecodeError:
            verdict = {"decision": "INVALID", "reason": out.stdout[:120]}
        reason = verdict.get("reason", "")
        # gemini.sh's shunt_decide appends one trace line per API attempt,
        # including failed ones (429, timeout, schema-invalid body), so a trace
        # line alone does not prove the model's verdict was used. The hook's
        # own "fallback line rule" reason text is the authoritative signal for
        # the fallback path and is checked first; `model` additionally needs
        # the attempt's outcome to be `decided`.
        if "fallback line rule" in reason:
            resolved_by = "fallback"
        elif attempt.get("outcome") == "decided":
            resolved_by = "model"
        elif not added:
            resolved_by = "code"
        else:
            resolved_by = "unexplained"
        rows.append({
            "suite": suite["hook"], "id": e["id"], "name": e["name"],
            "upstream": e["expected_decision"], "fork": verdict.get("decision"),
            "resolved_by": resolved_by, "latency_ms": ms,
            "http": attempt.get("http") if added else None,
            "error_status": attempt.get("error_status") if added else None,
            "diff": verdict.get("decision") != e["expected_decision"],
            "upstream_reason": e.get("reason", ""),
        })
    return rows


def main() -> int:
    make_named_fixtures()
    rows = []
    pacing = {"last_api_at": None, "waited_seconds": 0.0}
    for suite in SUITES:
        rows += run_suite(suite, pacing)

    json.dump(rows, open(os.path.join(HERE, "regression.json"), "w"), ensure_ascii=False, indent=1)
    diffs = [r for r in rows if r["diff"]]
    with open(os.path.join(HERE, "regression.md"), "w") as f:
        f.write("# 回帰表（上流ラベル vs fork 判定）\n\n")
        f.write("上流ラベルは 350 行規則の実装挙動そのもの。一致率で品質は測らない（NOTICE 参照）。\n")
        f.write("resolved_by=model は、そのケースで trace に追記された API 試行の outcome が decided だった判定。\n")
        f.write("fallback はモデルに問えず行数規則で決まった判定で、http / error_status にその API 試行の失敗理由"
                "（例: 429 RESOURCE_EXHAUSTED）が出る。API 試行が無ければ空欄（preflight 失敗 or code 確定）。\n")
        f.write(f"API を叩きうるケースの間は {MIN_INTERVAL:g} 秒空けて実行した（SHUNT_REGRESSION_MIN_INTERVAL_SECONDS）。\n\n")
        f.write("| suite | id | name | upstream | fork | resolved_by | http | error_status | ms |\n"
                "|---|---|---|---|---|---|---|---|---|\n")
        for r in rows:
            mark = " **≠**" if r["diff"] else ""
            f.write(f"| {r['suite']} | {r['id']} | {r['name']} | {r['upstream']} | {r['fork']}{mark} | {r['resolved_by']} "
                    f"| {r['http'] or ''} | {r['error_status'] or ''} | {r['latency_ms']} |\n")
        f.write(f"\n差分 {len(diffs)} 件:\n")
        for r in diffs:
            f.write(f"- {r['suite']} case {r['id']} ({r['name']}): upstream={r['upstream']} → fork={r['fork']} [{r['resolved_by']}] — 上流の意図: {r['upstream_reason']}\n")
    print(json.dumps({"total": len(rows), "diffs": [(r["suite"], r["id"]) for r in diffs],
                      "by": {k: sum(1 for r in rows if r["resolved_by"] == k) for k in {r["resolved_by"] for r in rows}},
                      "min_interval_seconds": MIN_INTERVAL,
                      "pacing_wait_seconds": round(pacing["waited_seconds"], 1)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
