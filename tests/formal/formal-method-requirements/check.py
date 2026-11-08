# Formal checks of docs/requirements/formal-method.md (the requirements, not the specification).
# Run from the repository root:  Z3=/absolute/path/to/z3 python3 -I tests/formal/formal-method-requirements/check.py
# One requirement sentence -> one named assert; the name carries the PR id and the sentence (PRnnn_<bullet><letter>).
# Readings that the text does not state literally are prefixed I_ and listed in README.md.
# Per query: A = inputs + WF sat (the inputs are possible), B = + requirement rules sat (no contradiction),
# C = + target, compared with the expectation, M = C without the load-bearing rules (the check can fail: the
# expectation must flip). Output: one JSON line per case, then a summary line. Exit 1 on any mismatch.
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
REQ = "docs/requirements/formal-method.md"
SPEC = "docs/specifications/formal-method.md"
Z3 = os.environ.get("Z3")

P = ["p1", "p2"]          # two required properties
C = ["c1", "c2"]          # two state x event combinations of a closed set
K = ["k1", "k2"]          # two planned checks
REMAIN = ["unmapped", "notrun", "unk", "to", "fail", "unconf"]   # PR-015: 未対応・未実行・unknown・時間切れ・実行失敗・未確認

decls = ["(declare-const complete Bool)", "(declare-const stopped Bool)", "(declare-const saved Bool)",
         "(declare-const target_ok Bool)", "(declare-const goal_ok Bool)", "(declare-const qpend Bool)",
         "(declare-const meaning_unconf Bool)", "(declare-const canrun Bool)", "(declare-const allsat Bool)",
         "(declare-const run_stopped_mid Bool)",
         "(declare-const parts_ok Bool)", "(declare-const comp_cond_verified Bool)", "(declare-const prem_confirmed Bool)",
         "(declare-const mutual_only Bool)", "(declare-const mapping_checked Bool)", "(declare-const whole_verified Bool)"]
for p in P:
    for v in ["succ", "cex", "formal", "unverified", "altok", "nfrec", "qdep"] + REMAIN:
        decls.append(f"(declare-const {p}_{v} Bool)")
for c in C:
    for v in ["allowed", "forbidden", "unhandled", "reported_unverified"]:
        decls.append(f"(declare-const {c}_{v} Bool)")
for k in K:
    for v in ["started", "finished", "done", "incomplete", "notrun"]:
        decls.append(f"(declare-const {k}_{v} Bool)")

OR = lambda xs: "(or false " + " ".join(xs) + ")"
AND = lambda xs: "(and true " + " ".join(xs) + ")"

WF = [
    # 表記と用語: run は完了又は停止するまでの処理。終わった run はちょうど一方。
    ("WF_run_ends_once", "(xor complete stopped)"),
]
RULES = [
    # PR-001 2 bullet: 対象又は目標を特定できないならば、不足を報告して止まらなければならない。
    ("PR001_2a_missing_stops", "(=> (or (not target_ok) (not goal_ok)) stopped)"),
    # PR-010 2 bullet: 未実行、unknown、時間切れ又は実行失敗を、検証の成功として扱ってはならない。
    *[(f"PR010_2b_not_success_{p}", f"(=> (or {p}_notrun {p}_unk {p}_to {p}_fail) (not {p}_succ))") for p in P],
    # PR-010 4 bullet: 必要な検証を実行できないか、必要な性質を満たさないならば、run を停止しなければならない。
    ("PR010_4a_stop", "(=> (or (not canrun) (not allsat)) stopped)"),
    # PR-015 2 bullet: 必要な検証又は独立した意味の確認に、未対応・未実行・unknown・時間切れ・実行失敗又は未確認が残るか、
    # 必要な記録を保存できないならば、完了と報告してはならない。
    ("PR015_2b_no_complete", "(=> " + OR([f"{p}_{r}" for p in P for r in REMAIN] + ["meaning_unconf", "(not saved)"]) + " (not complete))"),
    # PR-009 2 bullet: 回答が必要な検証は止め、完了の判定も PR-015 に従う。
    *[(f"I_PR009_2b_answer_blocks_{p}", f"(=> (and qpend {p}_qdep) (and (not {p}_succ) (or {p}_notrun {p}_unconf)))") for p in P],
    # PR-010 の「必要な性質を満たさない」は反例、「実行できない」は未実行・実行失敗。
    *[(f"I_PR010_cex_unsat_{p}", f"(=> {p}_cex (not allsat))") for p in P],
    *[(f"I_PR010_notrun_cannot_{p}", f"(=> (or {p}_notrun {p}_fail) (not canrun))") for p in P],
    # PR-003 1 bullet: 各組合せを、許される遷移・明示的に禁止された遷移・対応できていない組合せに照らし、対応できていない組合せは未検証。
    *[(f"I_PR003_1b_unhandled_def_{c}", f"(= {c}_unhandled (and (not {c}_allowed) (not {c}_forbidden)))") for c in C],
    *[(f"PR003_1c_unhandled_unverified_{c}", f"(=> {c}_unhandled {c}_reported_unverified)") for c in C],
    # PR-012 3 bullet: 計画した各検査の結果と実行されていない検査を区別し、途中で停止したら完了した範囲と未完了の範囲を報告する。
    *[(f"I_PR012_3a_done_{k}", f"(= {k}_done (and {k}_started {k}_finished))") for k in K],
    *[(f"I_PR012_3a_incomplete_{k}", f"(= {k}_incomplete (and {k}_started (not {k}_finished)))") for k in K],
    *[(f"I_PR012_3a_notrun_{k}", f"(= {k}_notrun (not {k}_started))") for k in K],
    # PR-004 1 bullet: 検証が必要な項目に対応がない場合、形式化できる性質は未検証、形式化できない性質は PR-002 に従う。
    *[(f"PR004_1c_formal_unverified_{p}", f"(=> (and {p}_unmapped {p}_formal) {p}_unverified)") for p in P],
    # PR-002 2 bullet: 形式化できない性質は、理由を記録し、別の方法の確認か未確認と理由を記録する。
    *[(f"PR002_2a_nonformal_{p}", f"(=> (and {p}_unmapped (not {p}_formal)) (and {p}_nfrec (or {p}_altok {p}_unconf)))") for p in P],
    # 「未検証」は検証の成功でない（語の意味）。
    *[(f"I_PR004_unverified_not_success_{p}", f"(=> {p}_unverified (not {p}_succ))") for p in P],
    # PR-008 2 bullet: 部分の結果から全体が成り立つ条件を明示して検証する。前提を確認できない、相互の前提だけで支える場合は全体を検証済みとしない。
    ("PR008_2a_comp_condition", "(=> whole_verified comp_cond_verified)"),
    ("PR008_2b_premises", "(=> (or (not prem_confirmed) mutual_only) (not whole_verified))"),
    # PR-008 3 bullet: 分割前後の対応を照合し、部分の検証成功だけで全体を検証済みとしてはならない。
    ("PR008_3a_mapping", "(=> whole_verified mapping_checked)"),
]


def fact(name, value):
    return (f"IN_{name}", f"(= {name} {'true' if value else 'false'})")


def good_run():
    """All inputs that the requirements name as conditions are favourable."""
    f = [fact(x, True) for x in ["target_ok", "goal_ok", "saved", "canrun", "allsat"]]
    f += [fact(x, False) for x in ["qpend", "meaning_unconf"]]
    f += [fact(f"{p}_{r}", False) for p in P for r in REMAIN + ["cex"]]
    f += [fact(f"{p}_succ", True) for p in P]
    return f


Q = []


def q(qid, prs, inputs, target, expect, load, note="", spec=None):
    """spec: 要求でなく仕様で決める点なら、その理由（依頼者の決定）。結果を記録するが、一致・不一致に数えない。"""
    Q.append(dict(id=qid, prs=prs, inputs=inputs, target=target, expect=expect, load=load, note=note, spec=spec))


# --- PR-001・009・010・011・015: 完了・停止・報告の条件 ---
q("R1_complete_reachable", ["PR-001", "PR-010", "PR-015"], good_run(), "complete", "sat", [],
  "条件どうしが矛盾せず、完了に到達できる入力がある")
for s_name, s_inputs in [("target_missing", [fact("target_ok", False)]), ("goal_missing", [fact("goal_ok", False)]),
                         ("cex", [fact("p1_cex", True)]), ("notrun", [fact("p1_notrun", True)]), ("fail", [fact("p1_fail", True)])]:
    load = {"target_missing": ["PR001_2a_missing_stops"], "goal_missing": ["PR001_2a_missing_stops"],
            "cex": ["PR010_4a_stop", "I_PR010_cex_unsat_p1"],
            "notrun": ["PR010_4a_stop", "I_PR010_notrun_cannot_p1", "PR015_2b_no_complete"],
            "fail": ["PR010_4a_stop", "I_PR010_notrun_cannot_p1", "PR015_2b_no_complete"]}[s_name]
    q(f"R2_stop_excludes_complete_{s_name}", ["PR-001", "PR-010", "PR-015"], s_inputs, "complete", "unsat", load,
      "停止の条件と完了の条件が重ならない")
for r in REMAIN:
    # 未実行・実行失敗は、PR-015 と PR-010 の停止（実行できない）の 2 つの経路で完了を拒む。片方だけ外しても検出されないので両方を外す。
    load = ["PR015_2b_no_complete"] + (["PR010_4a_stop"] if r in ("notrun", "fail") else [])
    q(f"R3_remaining_{r}_not_complete", ["PR-010", "PR-015"], [fact(f"p1_{r}", True)], "complete", "unsat", load,
      "未対応・未実行・unknown・時間切れ・実行失敗・未確認のどれかが残れば完了と報告しない")
q("R3_meaning_unconfirmed_not_complete", ["PR-011", "PR-015"], [fact("meaning_unconf", True)], "complete", "unsat", ["PR015_2b_no_complete"])
q("R3_unsaved_not_complete", ["PR-015"], [fact("saved", False)], "complete", "unsat", ["PR015_2b_no_complete"])
q("R3_question_not_complete", ["PR-009", "PR-015"], [fact("qpend", True), fact("p1_qdep", True)], "complete", "unsat",
  ["I_PR009_2b_answer_blocks_p1", "PR015_2b_no_complete"])
for r in ["notrun", "unk", "to", "fail"]:
    q(f"R3_{r}_not_success", ["PR-010"], [fact(f"p1_{r}", True)], "p1_succ", "unsat", ["PR010_2b_not_success_p1"])

# --- PR-003: 組合せの 3 区分 ---
c = "c1"
q("R4_partition_cover", ["PR-003"], [], f"(not (or {c}_allowed {c}_forbidden {c}_unhandled))", "unsat", [f"I_PR003_1b_unhandled_def_{c}"],
  "3 区分が漏れない")
q("R4_partition_allowed_unhandled", ["PR-003"], [], f"(and {c}_allowed {c}_unhandled)", "unsat", [f"I_PR003_1b_unhandled_def_{c}"])
q("R4_partition_forbidden_unhandled", ["PR-003"], [], f"(and {c}_forbidden {c}_unhandled)", "unsat", [f"I_PR003_1b_unhandled_def_{c}"])
q("R4_partition_allowed_forbidden", ["PR-003"], [], f"(and {c}_allowed {c}_forbidden)", "unsat", [],
  "許される遷移と明示的に禁止された遷移が重ならない（要求の文はこれを定めない）",
  spec="仕様 SP-FORMALMETHOD-006 で決める（依頼者の決定。要求に書かない）")
q("R4_unhandled_reported_unverified", ["PR-003"], [fact(f"{c}_unhandled", True)], f"(not {c}_reported_unverified)", "unsat",
  [f"PR003_1c_unhandled_unverified_{c}"])
q("R4_unhandled_not_complete", ["PR-003", "PR-015"], [fact(f"{c}_unhandled", True)], "complete", "unsat", [],
  "未検証（対応できていない組合せ）が残る run は完了にならない（PR-015 の列挙に未検証が無い）",
  spec="仕様 SP-FORMALMETHOD-015 で決める（依頼者の決定。要求に書かない）")

# --- PR-012: 途中で止まったときの検査の区分 ---
k = "k1"
cats = [f"{k}_done", f"{k}_incomplete", f"{k}_notrun"]
q("R5_check_in_some_category", ["PR-012"], [fact("run_stopped_mid", True)], f"(not (or {' '.join(cats)}))", "unsat",
  [f"I_PR012_3a_done_{k}", f"I_PR012_3a_incomplete_{k}", f"I_PR012_3a_notrun_{k}"], "計画した検査が完了・未完了・未実行のどれかに入る")
q("R5_check_in_one_category", ["PR-012"], [fact("run_stopped_mid", True)], f"((_ at-least 2) {' '.join(cats)})", "unsat",
  [f"I_PR012_3a_done_{k}", f"I_PR012_3a_incomplete_{k}", f"I_PR012_3a_notrun_{k}"], "どれか 1 つだけに入る")

# --- PR-004: 対応の無い項目 ---
p = "p1"
q("R6_unmapped_formal_unverified", ["PR-004"], [fact(f"{p}_unmapped", True), fact(f"{p}_formal", True)], f"(not {p}_unverified)", "unsat",
  [f"PR004_1c_formal_unverified_{p}"])
q("R6_unmapped_formal_not_success", ["PR-004", "PR-010"], [fact(f"{p}_unmapped", True), fact(f"{p}_formal", True)], f"{p}_succ", "unsat",
  [f"I_PR004_unverified_not_success_{p}"])
q("R6_unmapped_nonformal_pr002", ["PR-004", "PR-002"], [fact(f"{p}_unmapped", True), fact(f"{p}_formal", False)],
  f"(not (and {p}_nfrec (or {p}_altok {p}_unconf)))", "unsat", [f"PR002_2a_nonformal_{p}"])
q("R6_unmapped_two_treatments_disjoint", ["PR-004"], [fact(f"{p}_unmapped", True)],
  f"(and {p}_formal (not {p}_formal))", "unsat", [], "2 つの扱いは形式化できるかで分かれ、重ならない")

# --- PR-008: 合成の条件 ---
whole = [fact("whole_verified", True)]
q("R7_whole_reachable", ["PR-008"], [fact(x, True) for x in ["parts_ok", "comp_cond_verified", "prem_confirmed", "mapping_checked"]] + [fact("mutual_only", False)],
  "whole_verified", "sat", [], "全体を検証済みにできる入力がある")
q("R7_premise_unconfirmed", ["PR-008"], [fact("prem_confirmed", False)], "whole_verified", "unsat", ["PR008_2b_premises"])
q("R7_mutual_only", ["PR-008"], [fact("mutual_only", True)], "whole_verified", "unsat", ["PR008_2b_premises"])
q("R7_parts_only", ["PR-008"], [fact("parts_ok", True), fact("comp_cond_verified", False)], "whole_verified", "unsat", ["PR008_2a_comp_condition"],
  "部分の成功だけでは全体が検証済みにならない")
q("R7_parts_only_unmapped", ["PR-008"], [fact("parts_ok", True), fact("mapping_checked", False)], "whole_verified", "unsat", ["PR008_3a_mapping"])


def smt(rules, inputs, target):
    lines = ["(set-option :produce-unsat-cores true)"] + decls
    asserts = list(WF) + list(rules) + list(inputs) + ([("Q_target", target)] if target else [])
    lines += [f"(assert (! {f} :named {n}))" for n, f in asserts]
    lines += ["(check-sat)", "(get-unsat-core)"]
    return "\n".join(lines) + "\n"


def solve(text, tmpdir, name):
    path = os.path.join(tmpdir, name + ".smt2")
    with open(path, "w") as fh:
        fh.write(text)
    p = subprocess.run([Z3, "-T:20", "-smt2", path], capture_output=True, text=True)
    first = (p.stdout.strip().split("\n") or [""])[0].strip()
    core = p.stdout.strip().split("\n")[1].strip() if first == "unsat" and len(p.stdout.strip().split("\n")) > 1 else None
    return first, p.returncode, core


def sha(path):
    return hashlib.sha256(open(os.path.join(ROOT, path), "rb").read()).hexdigest()


def pins():
    out = []
    for line in open(os.path.join(HERE, "PRD.sha256")):
        if line.strip():
            h, path = line.split()
            out.append((path, h, sha(path)))
    return out


def traceability():
    """Deterministic: every PR has >= 1 SP and >= 1 AC in the spec table, and no reference to a missing number."""
    req = open(os.path.join(ROOT, REQ)).read()
    spec = open(os.path.join(ROOT, SPEC)).read()
    prs = sorted(set(re.findall(r"^#### (PR-FORMALMETHOD-\d{3})", req, re.M)))
    sps = set(re.findall(r"^#### (SP-FORMALMETHOD-\d{3})", spec, re.M))
    acs = set(re.findall(r"^\| (AC-\d{2}) \|", spec, re.M))
    gaps_pr = set(re.findall(r"PR-FORMALMETHOD-\d{3}", re.search(r"欠番: ([^\n]*)", req).group(1)))
    gaps_sp = set(re.findall(r"SP-FORMALMETHOD-\d{3}", re.search(r"欠番: (SP-[^\n]*)", spec).group(1)))
    gaps_ac = set(re.findall(r"AC-\d{2}", re.search(r"欠番: (AC-[^\n]*)", spec).group(1)))
    table = spec.split("## トレーサビリティ表", 1)[1]
    rows = {}
    for line in table.split("\n"):
        m = re.match(r"^\| (PR-FORMALMETHOD-\d{3}) \| ([^|]*) \| ([^|]*) \|", line)
        if m:
            sp_refs = set(re.findall(r"SP-FORMALMETHOD-\d{3}", m.group(2)))
            ac_text = m.group(3)
            ac_refs = set()
            for grp in re.findall(r"AC-[\d・]+", ac_text):
                for n in re.findall(r"\d+", grp):
                    ac_refs.add(f"AC-{int(n):02d}")
            rows[m.group(1)] = (sp_refs, ac_refs)
    problems = []
    for pr in prs:
        if pr not in rows:
            problems.append(f"{pr}: トレーサビリティ表に行が無い")
            continue
        sp_refs, ac_refs = rows[pr]
        if not sp_refs:
            problems.append(f"{pr}: SP が無い")
        if not ac_refs:
            problems.append(f"{pr}: AC が無い")
        for s in sp_refs - sps:
            problems.append(f"{pr}: {s} が仕様に無い" + ("（欠番）" if s in gaps_sp else ""))
        for a in ac_refs - acs:
            problems.append(f"{pr}: {a} が仕様に無い" + ("（欠番）" if a in gaps_ac else ""))
    for pr in set(rows) - set(prs):
        problems.append(f"{pr}: 要求文書に無い" + ("（欠番）" if pr in gaps_pr else ""))
    return dict(prs=len(prs), rows=len(rows), problems=problems)


def main():
    results, mismatched = [], 0
    if not Z3 or not os.path.isabs(Z3) or not os.access(Z3, os.X_OK):
        print(json.dumps({"id": "env", "match": False, "reason": "Set Z3 to the absolute path of the z3 executable"}, ensure_ascii=False))
        return 1
    for path, want, got in pins():
        ok = want == got
        mismatched += 0 if ok else 1
        print(json.dumps({"id": f"pin:{path}", "kind": "pin", "expect": want, "observed": got, "match": ok}, ensure_ascii=False))
    if mismatched:
        print(json.dumps({"summary": True, "total": mismatched, "mismatched": mismatched,
                          "reason": "要求・仕様の指紋が PRD.sha256 と違う。模型・性質・対応を確かめてから更新する"}, ensure_ascii=False))
        return 1
    tr = traceability()
    ok = not tr["problems"]
    mismatched += 0 if ok else 1
    print(json.dumps({"id": "traceability", "kind": "deterministic", "match": ok, **tr}, ensure_ascii=False))
    total = 2
    with tempfile.TemporaryDirectory() as tmp:
        for qd in Q:
            total += 1
            a = solve(smt([], qd["inputs"], None), tmp, qd["id"] + "_A")
            b = solve(smt(RULES, qd["inputs"], None), tmp, qd["id"] + "_B")
            c = solve(smt(RULES, qd["inputs"], qd["target"]), tmp, qd["id"] + "_C")
            rec = dict(id=qd["id"], kind="query", prs=qd["prs"], note=qd["note"], expect=qd["expect"],
                       A=a[0], B=b[0], C=c[0], core=c[2])
            if c[0] == "unsat" and c[2] is not None:
                # 要求の文（PR の規則）を 1 つも使わずに導けた結論は、解釈（I_）と定義だけに依る
                rec["rests_on_interpretation_only"] = not re.search(r"\bPR\d{3}_", c[2])
            ok = a[0] == "sat" and b[0] == "sat" and c[0] == qd["expect"]
            if qd["load"]:
                rules = [r for r in RULES if r[0] not in qd["load"]]
                m = solve(smt(rules, qd["inputs"], qd["target"]), tmp, qd["id"] + "_M")
                flipped = {"sat": "unsat", "unsat": "sat"}[qd["expect"]]
                rec["mutation"] = dict(removed=qd["load"], observed=m[0], detected=m[0] == flipped)
                ok = ok and m[0] == flipped
            elif qd["expect"] == "unsat":
                rec["mutation"] = dict(removed=[], observed=None, detected=None, reason="外す規則が無い（定義だけから成る）")
            if qd["spec"]:
                rec.update(kind="spec_decides", match=None, reason=qd["spec"])
                rec.pop("mutation", None)
            else:
                rec["match"] = ok
                mismatched += 0 if ok else 1
            results.append(rec)
            print(json.dumps(rec, ensure_ascii=False))
    print(json.dumps({"summary": True, "total": total, "mismatched": mismatched}, ensure_ascii=False))
    return 1 if mismatched else 0


if __name__ == "__main__":
    sys.exit(main())
