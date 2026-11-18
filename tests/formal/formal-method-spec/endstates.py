# Enumerate the end-states of one check and decide whether the check verdict (L148-152, L157, L138) is unique.
# Run: python3 -I endstates.py  (writes enum_table.txt)
import itertools, json, os, subprocess, sys

Z3 = os.environ.get("Z3")


def z3_path():
    # check.py・z3_streams.py と同じく、Z3 が未設定か絶対 path でなければ止める（作者の環境の path を既定にしない）
    if not Z3 or not os.path.isabs(Z3):
        print(json.dumps({"error": "Set Z3 to the absolute path of the z3 executable"}))
        sys.exit(1)
    return Z3
HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "out", "enum")
RET = ["Ok", "Cex", "Undec", "Err", "Crash", "Unread", "NotStarted", "NoReturn"]  # what the tool returned
STOP = ["Time", "Abort", "NoStop"]                                                # how formal-method stopped it
TL = ["None", "Req", "Tool"]   # time limit reached while running: none / requester's / the tool's own
CV = ["Succ", "Cex", "NotRun", "Unk", "TO", "Fail"]


def wf(ret, stop, tl):
    if stop != "NoStop" and ret in ("Ok", "Cex", "Undec", "Err"):
        return "WF1: 道具が返りを報告した後は止める対象が無い"
    if ret == "NoReturn" and stop == "NoStop":
        return "WF2: 止めずに返りが無いことは無い"
    if ret == "NotStarted" and (stop != "NoStop" or tl != "None"):
        return "WF3: 未開始の検査は止められず、上限にも達しない"
    if stop == "Time" and tl != "Req":
        return "WF4: 時間で止めるのは依頼元の時間の上限に達したとき"
    return None


def smt(ret, stop, tl, extra):
    b = lambda x: "true" if x else "false"
    L = ["(set-option :produce-unsat-cores true)", "(declare-datatypes () ((CV " + " ".join(CV) + ")))", "(declare-const cv CV)"]
    L += [f"(declare-const r_{r} Bool)" for r in RET] + [f"(declare-const s_{s} Bool)" for s in STOP] + [f"(declare-const t_{t} Bool)" for t in TL]
    A = [(f"IN_ret_{r}", f"(= r_{r} {b(r == ret)})") for r in RET]
    A += [(f"IN_stop_{s}", f"(= s_{s} {b(s == stop)})") for s in STOP]
    A += [(f"IN_tl_{t}", f"(= t_{t} {b(t == tl)})") for t in TL]
    started = "(not r_NotStarted)"
    stopped = "(or s_Time s_Abort)"
    c = {
        "Cex": "r_Cex",                                                                   # L148
        "TO": f"(and {started} (or t_Req t_Tool))",                                       # L151
        "NotRun": f"(or r_NotStarted (and {stopped} (or r_NoReturn r_Crash r_Unread)))",  # L149
        "Unk": "r_Undec",                                                                 # L150
    }
    others = "(or " + " ".join(c.values()) + ")"
    noreport = "(or r_Crash r_Unread r_Err r_NoReturn)"
    c["Fail"] = f"(or (and s_NoStop (or r_Crash r_Unread)) r_Err (and {started} {noreport} (not {others})))"  # L152
    order = ["Cex", "TO", "Fail", "NotRun", "Unk"]
    anyc = "(or " + " ".join(c[k] for k in order) + ")"
    A.append(("L157_succ", f"(=> (= cv Succ) (and r_Ok (not {anyc})))"))
    A += [(f"L157_cond_{k}", f"(=> (= cv {k}) {c[k]})") for k in order]
    n2 = "((_ at-least 2) " + " ".join(c[k] for k in order) + ")"
    for i, k in enumerate(order):
        hi = "(or false " + " ".join(c[h] for h in order[:i]) + ")"
        A.append((f"L157_prio_{k}", f"(=> (and {n2} {c[k]} (not {hi})) (= cv {k}))"))
    A.append(("L138_stop", f"(=> (and t_Req {started}) {stopped})"))  # running checks are stopped at the requester's limit
    A += extra
    L += [f"(assert (! {f} :named {n}))" for n, f in A]
    L += ["(check-sat)", '(echo "--")', "(get-unsat-core)", '(echo "--")', "(get-value (cv))"]
    return "\n".join(L) + "\n"


def z(text, fn):
    open(fn, "w").write(text)
    p = subprocess.run([z3_path(), "-T:20", "-smt2", fn], capture_output=True, text=True)
    open(fn[:-5] + ".out", "w").write(p.stdout + p.stderr)
    return p.stdout


def main():
    os.makedirs(D, exist_ok=True)
    rows = []
    for ret, stop, tl in itertools.product(RET, STOP, TL):
        tag = f"{ret}_{stop}_t{tl}"
        w = wf(ret, stop, tl)
        if w:
            rows.append((tag, "除外", w)); continue
        out = z(smt(ret, stop, tl, []), f"{D}/{tag}_B.smt2")
        head = out.split("\n")[0]
        if head != "sat":
            rows.append((tag, head, "core=" + out.split("--")[1].strip())); continue
        v = out.split("--")[2].split("(cv ")[1].split(")")[0].strip()
        h2 = z(smt(ret, stop, tl, [("Q_neq", f"(not (= cv {v}))")]), f"{D}/{tag}_C.smt2").split("\n")[0]
        rows.append((tag, v, {"unsat": "一意", "sat": "未確定"}.get(h2, h2)))
    with open(os.path.join(HERE, "enum_table.txt"), "w") as f:
        for r in rows:
            f.write(" | ".join(r) + "\n")
    for r in rows:
        if r[1] != "除外":
            print(" | ".join(r))
    print("excluded:", sum(r[1] == "除外" for r in rows), "of", len(rows))


if __name__ == "__main__":
    main()
