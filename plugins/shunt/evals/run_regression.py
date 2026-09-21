"""Regression harness: upstream の hook eval 2 系（check-bash-read 17 件 / check-file-size 17 件）を
fork の hook に通し、上流ラベル（= 上流実装の挙動）と fork の判定を並記した回帰表を出す。

閾値判定はしない。上流ラベルの生成元は置換対象の行数規則そのものなので、一致率は
判定品質を測れない（一致 = 上流互換、差分 = 挙動変更の候補として ID と理由で列挙し、
良否は読み手が判断する）。model 判定か code 確定かの分類は、遅延や文言の推測ではなく
SHUNT_TRACE_FILE への応答由来メタデータ（usage token counts / responseId）の追記で証明する。

実行: CLAUDE_PLUGINS_GEMINI_API_KEY を設定した上で
  python3 evals/run_regression.py
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

SUITES = [
    {"hook": "check-bash-read", "evals": "bash-hook-evals.json",
     "payload_key": "command", "fixture_name": lambda lines: "large.txt" if lines >= 350 else "small.txt"},
    {"hook": "check-file-size", "evals": "hook-evals.json",
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

    "dir name/large.txt" はスペース入りパスの word-split バグ（check-bash-read
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


def run_suite(suite) -> list:
    hook = os.path.join(HERE, "..", "hooks", suite["hook"])
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
        before = os.path.getsize(TRACE) if os.path.exists(TRACE) else 0
        t0 = time.time()
        out = subprocess.run(["bash", hook], input=json.dumps({"tool_input": tool_input}),
                             capture_output=True, text=True, env=env)
        ms = int((time.time() - t0) * 1000)
        trace_grew = (os.path.getsize(TRACE) if os.path.exists(TRACE) else 0) > before
        try:
            verdict = json.loads(out.stdout)
        except json.JSONDecodeError:
            verdict = {"decision": "INVALID", "reason": out.stdout[:120]}
        reason = verdict.get("reason", "")
        # gemini.sh's shunt_decide appends to SHUNT_TRACE_FILE on every HTTP 200
        # response, even one whose body fails the responseSchema/enum check
        # (empty or malformed decision) — in that case shunt_decide still
        # returns 1, and the hook falls back to the line rule. So trace growth
        # alone does not prove the model's verdict was used: a fallback case
        # can grow the trace too. The hook's own "fallback line rule" reason
        # text is the authoritative signal for which path was taken and must
        # be checked first.
        if "fallback line rule" in reason:
            resolved_by = "fallback"
        elif trace_grew:
            resolved_by = "model"
        else:
            resolved_by = "code"
        rows.append({
            "suite": suite["hook"], "id": e["id"], "name": e["name"],
            "upstream": e["expected_decision"], "fork": verdict.get("decision"),
            "resolved_by": resolved_by, "latency_ms": ms,
            "diff": verdict.get("decision") != e["expected_decision"],
            "upstream_reason": e.get("reason", ""),
        })
    return rows


def main() -> int:
    make_named_fixtures()
    rows = []
    for suite in SUITES:
        rows += run_suite(suite)

    json.dump(rows, open(os.path.join(HERE, "regression.json"), "w"), ensure_ascii=False, indent=1)
    diffs = [r for r in rows if r["diff"]]
    with open(os.path.join(HERE, "regression.md"), "w") as f:
        f.write("# 回帰表（上流ラベル vs fork 判定）\n\n")
        f.write("上流ラベルは 350 行規則の実装挙動そのもの。一致率で品質は測らない（NOTICE 参照）。\n")
        f.write("resolved_by=model は trace（API 応答由来の usage/responseId）で証明された判定。\n\n")
        f.write("| suite | id | name | upstream | fork | resolved_by | ms |\n|---|---|---|---|---|---|---|\n")
        for r in rows:
            mark = " **≠**" if r["diff"] else ""
            f.write(f"| {r['suite']} | {r['id']} | {r['name']} | {r['upstream']} | {r['fork']}{mark} | {r['resolved_by']} | {r['latency_ms']} |\n")
        f.write(f"\n差分 {len(diffs)} 件:\n")
        for r in diffs:
            f.write(f"- {r['suite']} case {r['id']} ({r['name']}): upstream={r['upstream']} → fork={r['fork']} [{r['resolved_by']}] — 上流の意図: {r['upstream_reason']}\n")
    print(json.dumps({"total": len(rows), "diffs": [(r["suite"], r["id"]) for r in diffs],
                      "by": {k: sum(1 for r in rows if r["resolved_by"] == k) for k in {r["resolved_by"] for r in rows}}}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
