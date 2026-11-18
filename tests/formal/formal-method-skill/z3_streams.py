# Measures how z3 reports an answer (with and without -model), its own time limit, a syntax error,
# a wrong form after (check-sat), and memory exhaustion:
# which stream carries what, and the exit code. Compares with the table in
# .agents/skills/formal-method/references/cli-contract.md (Z3 の adapter).
# Usage: Z3=/absolute/path/to/z3 python3 -I tests/formal/formal-method-skill/z3_streams.py
# Prints one JSON line per case and a summary line; exit 1 if a case differs from the contract table.
# The adapter itself uses only -in, -T and -model (-model only for property and composition checks).
# -memory is used here only to make memory exhaustion reproducible; set-option appears only in measurement queries
# (agent .smt2 files may not contain it).
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


def is_model(lines):
    # the model after the answer line: exactly one S-expression list (comments and string literals respected)
    text = "\n".join(lines)
    depth, i, closed = 0, 0, 0
    while i < len(text):
        c = text[i]
        if c == ";":
            while i < len(text) and text[i] != "\n":
                i += 1
            continue
        if c == '"':
            i += 1
            while i < len(text) and text[i] != '"':
                i += 1
        elif c == "(":
            if depth == 0 and closed:
                return False
            depth += 1
        elif c == ")":
            depth -= 1
            if depth < 0:
                return False
            if depth == 0:
                closed += 1
        elif not c.isspace() and depth == 0:
            return False
        i += 1
    return depth == 0 and closed == 1


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
    # -model: sat is followed by the model, unsat is not, unknown may be, timeout is one line
    ("answer_model_sat", ["-in", "-T:10", "-model"], "(declare-const x Int)\n(assert (> x 1))\n(check-sat)\n",
     "答え（-model を渡した）", lambda o: o[:1] == ["sat"] and is_model(o[1:]), lambda e: e == "", 0),
    ("answer_model_unsat", ["-in", "-T:10", "-model"], "(declare-const x Int)\n(assert (> x 1))\n(assert (< x 1))\n(check-sat)\n",
     "答え（-model を渡した）", lambda o: o == ["unsat"], lambda e: e == "", 0),
    ("answer_model_unknown", ["-in", "-T:10", "-model"], "(declare-const x Real)\n(assert (= (^ 2.0 x) 3.0))\n(check-sat)\n",
     "答え（-model を渡した）", lambda o: o[:1] == ["unknown"] and (len(o) == 1 or is_model(o[1:])), lambda e: e == "", 0),
    ("tool_time_limit_model", ["-in", "-T:1", "-model"], pigeonhole(),
     "道具自身の時間の上限", lambda o: o == ["timeout"], lambda e: e == "", 0),
    # a form after (check-sat) that errors: the answer is printed, then (error ...), and the exit code is 1.
    # With -model the model is printed at exit, after the (error ...) line.
    ("form_after_check_sat", ["-in", "-T:10"], "(declare-const x Int)\n(assert (> x 1))\n(check-sat)\n(assert (> y 1))\n",
     "構文の誤り", lambda o: o[:1] == ["sat"] and any(line.startswith("(error") for line in o[1:]), lambda e: e == "", 1),
    ("form_after_check_sat_model", ["-in", "-T:10", "-model"], "(declare-const x Int)\n(assert (> x 1))\n(check-sat)\n(assert (> y 1))\n",
     "構文の誤り", lambda o: o[:1] == ["sat"] and o[1:2] and o[1].startswith("(error") and is_model(o[2:]), lambda e: e == "", 1),
    ("get_model_after_unsat", ["-in", "-T:10"], "(declare-const x Int)\n(assert (> x 1))\n(assert (< x 1))\n(check-sat)\n(get-model)\n",
     "構文の誤り", lambda o: o[:1] == ["unsat"] and any(line.startswith("(error") for line in o[1:]), lambda e: e == "", 1),
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
