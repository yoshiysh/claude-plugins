# Measures how z3 reports an answer, its own time limit, a syntax error and memory exhaustion:
# which stream carries what, and the exit code. Compares with the table in
# .agents/skills/formal-method/references/cli-contract.md (Z3 の adapter).
# Usage: Z3=/absolute/path/to/z3 python3 -I tests/formal/formal-method-skill/z3_streams.py
# Prints one JSON line per case and a summary line; exit 1 if a case differs from the contract table.
# The adapter itself uses only -in and -T. -memory is used here only to make memory exhaustion reproducible.
import hashlib
import json
import os
import platform
import subprocess
import sys

Z3 = os.environ.get("Z3")
if not Z3 or not os.path.isabs(Z3):
    print(json.dumps({"error": "Set Z3 to the absolute path of the z3 executable"}))
    sys.exit(1)


def hard(n=40):
    lines = ["(set-logic QF_NIA)"] + [f"(declare-const x{i} Int)" for i in range(n)]
    lines += [f"(assert (and (>= x{i} 0) (<= x{i} 1000000)))" for i in range(n)]
    lines += [f"(assert (distinct (* x{i} x{i + 1}) (+ x{(i + 2) % n} 7)))" for i in range(n - 1)]
    return "\n".join(lines + ["(check-sat)"]) + "\n"


def pigeonhole(n=14):
    """n + 1 pigeons in n holes: unsat and exponentially hard for resolution, so -T:1 stops it."""
    v = lambda i, j: f"p{i}_{j}"
    lines = [f"(declare-const {v(i, j)} Bool)" for i in range(n + 1) for j in range(n)]
    lines += ["(assert (or " + " ".join(v(i, j) for j in range(n)) + "))" for i in range(n + 1)]
    lines += [f"(assert (not (and {v(i, j)} {v(k, j)})))" for j in range(n) for i in range(n + 1) for k in range(i + 1, n + 1)]
    return "\n".join(lines + ["(check-sat)"]) + "\n"


CASES = [
    # id, args, query, contract row: (stdout predicate, stderr predicate, exit code)
    ("answer", ["-in", "-T:10"], "(declare-const x Int)\n(assert (> x 1))\n(check-sat)\n",
     "答え", lambda o: o == ["sat"], lambda e: e == "", 0),
    ("syntax_error", ["-in", "-T:10"], "(declare-const x Int)\n(assert (foo x))\n(check-sat)\n",
     "構文の誤り", lambda o: any(line.startswith("(error") for line in o), lambda e: e == "", 1),
    ("out_of_memory", ["-in", "-T:20", "-memory:20"], hard(),
     "メモリ不足", lambda o: not any(line in ("sat", "unsat", "unknown") for line in o), lambda e: '(error "out of memory")' in e, 101),
    ("tool_time_limit", ["-in", "-T:1"], pigeonhole(),
     "道具自身の時間の上限", lambda o: o == ["timeout"], lambda e: e == "", 0),
]

version = subprocess.run([Z3, "-version"], capture_output=True, text=True).stdout.strip()
digest = hashlib.sha256(open(Z3, "rb").read()).hexdigest()
print(json.dumps({"z3": Z3, "version": version, "sha256": digest, "platform": platform.platform(), "machine": platform.machine()}, ensure_ascii=False))
bad = 0
for cid, args, query, row, out_ok, err_ok, code in CASES:
    p = subprocess.run([Z3] + args, input=query, capture_output=True, text=True, timeout=120)
    out = [line for line in p.stdout.split("\n") if line.strip()]
    match = out_ok(out) and err_ok(p.stderr.strip()) and p.returncode == code
    bad += 0 if match else 1
    print(json.dumps({"id": cid, "contract_row": row, "args": args, "stdout_lines": out, "stderr": p.stderr.strip(),
                      "exit": p.returncode, "expected_exit": code, "match": match}, ensure_ascii=False))
print(json.dumps({"summary": True, "total": len(CASES), "mismatched": bad}))
sys.exit(1 if bad else 0)
