# SMT-LIB generator for docs/specifications/formal-method.md (290-line version, after removal of CPU/memory limits).
# One spec sentence -> one named assert (name = line + topic). Interpretations not derivable from the text -> prefix I_.
# Input facts -> IN_, well-formedness of inputs -> WF_, the uniqueness probe -> Q_.
import os, subprocess

Z3 = os.environ.get("Z3", "/Users/yoshi/.codex/workflow-runs/claude-plugins/formal-method-prd/tools/z3-5.3.3-arm64-osx-13.3/bin/z3")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")

VALS = ["VER", "ALT", "CEX", "NOTRUN", "UNK", "TO", "FAIL", "UNCONF"]   # property verdict values (L142-153)
CVS = ["Succ", "Cex", "NotRun", "Unk", "TO", "Fail"]                    # check verdict values (L157)
# Check end-state inputs:
#   started; finished = tool returned ok / cex / unk; err = tool reported a non-verdict error;
#   crash / unread = tool ended abnormally / output unreadable;
#   tl = formal-method stopped it at the requester's time limit; abort = formal-method stopped it for another reason;
#   unkt = the 'cannot decide' answer was due to the tool's own time limit.
CHK_INPUTS = ["started", "finished", "ok", "cex", "unk", "unkt", "err", "crash", "unread", "tl", "abort"]
PROP_INPUTS = ["formal", "corr", "mean", "det", "dd", "dok", "altok", "pq", "notool"]


class Model:
    def __init__(self, props, opts=None):
        self.props = props            # {property: [check, ...]}
        self.opts = opts or {}
        self.decls, self.rules, self.ccond = [], [], {}
        self.build()

    def checks(self):
        return [c for cs in self.props.values() for c in cs]

    def r(self, name, f):
        self.rules.append((name, f))

    def build(self):
        self.decls.append("(declare-datatypes () ((CV " + " ".join(CVS) + ")))")
        for c in self.checks():
            for i in CHK_INPUTS:
                self.decls.append(f"(declare-const {c}_{i} Bool)")
            self.decls.append(f"(declare-const {c}_cv CV)")   # L157: exactly one of the six values
            self.r(f"WF_{c}_outcome", f"(=> {c}_finished ((_ pbeq 1 1 1 1) {c}_ok {c}_cex {c}_unk))")
            self.r(f"WF_{c}_noout", f"(=> (not {c}_finished) (not (or {c}_ok {c}_cex {c}_unk)))")
            ends = f"(or {c}_finished {c}_err {c}_crash {c}_unread {c}_tl {c}_abort)"
            self.r(f"WF_{c}_start", f"(=> {ends} {c}_started)")
            self.r(f"WF_{c}_end", f"(=> {c}_started {ends})")
            self.r(f"WF_{c}_excl", f"(and ((_ at-most 1) {c}_tl {c}_abort) (=> (or {c}_finished {c}_err) (not (or {c}_crash {c}_unread {c}_tl {c}_abort))) (not (and {c}_finished {c}_err)))")
            self.r(f"WF_{c}_unkt", f"(=> {c}_unkt (and {c}_finished {c}_unk))")
            stopped = f"(or {c}_tl {c}_abort)"
            cond = {
                "Cex": f"(and {c}_finished {c}_cex)",                                         # L148
                "TO": f"(or {c}_tl {c}_unkt)",                                                # L151
                "NotRun": f"(or (not {c}_started) (and {stopped} (not {c}_finished) (not {c}_err)))",  # L149
                "Unk": f"(and {c}_finished {c}_unk)",                                         # L150
            }
            others = "(or " + " ".join(cond.values()) + ")"
            cond["Fail"] = (f"(or (and (not {stopped}) (or {c}_crash {c}_unread)) {c}_err "        # L152
                            f"(and {c}_started (not {c}_finished) (not {others})))")
            self.ccond[c] = cond
            order = ["Cex", "TO", "Fail", "NotRun", "Unk"]
            anyc = "(or " + " ".join(cond[k] for k in order) + ")"
            self.r(f"L157_chk_cond_{c}_Succ", f"(=> (= {c}_cv Succ) (and {c}_finished {c}_ok (not {anyc})))")
            for k in order:
                self.r(f"L157_chk_cond_{c}_{k}", f"(=> (= {c}_cv {k}) {cond[k]})")
            n2 = "((_ at-least 2) " + " ".join(cond[k] for k in order) + ")"
            for i, k in enumerate(order):
                hi = "(or false " + " ".join(cond[h] for h in order[:i]) + ")"
                self.r(f"L157_prio_{c}_{k}", f"(=> (and {n2} {cond[k]} (not {hi})) (= {c}_cv {k}))")

        for p, cs in self.props.items():
            for v in VALS:
                self.decls.append(f"(declare-const {p}_{v} Bool)")
            for i in PROP_INPUTS:
                self.decls.append(f"(declare-const {p}_{i} Bool)")
            fany = lambda f: "(or false " + " ".join(f(c) for c in cs) + ")"
            anyv = lambda k: "(or false " + " ".join(f"(= {c}_cv {k})" for c in cs) + ")"
            allsucc = "(and true " + " ".join(f"(= {c}_cv Succ)" for c in cs) + ")"
            pc = {
                "VER": f"(and {p}_formal {'true' if cs else 'false'} {allsucc} (not {p}_pq) {p}_corr {p}_mean {p}_det (=> {p}_dd {p}_dok))",  # L146
                "ALT": f"(and (not {p}_formal) (not {p}_pq) {p}_altok)",                                                                   # L147
                # L148-152: property-level conditions are the same table conditions, on any of its checks
                "CEX": fany(lambda c: self.ccond[c]["Cex"]),
                "NOTRUN": fany(lambda c: self.ccond[c]["NotRun"]) if cs else f"(and {p}_formal {p}_notool)",  # L149 2nd sentence
                "UNK": fany(lambda c: self.ccond[c]["Unk"]),
                "TO": fany(lambda c: self.ccond[c]["TO"]),
                "FAIL": fany(lambda c: self.ccond[c]["Fail"]),
            }
            self.r(f"L142_nonempty_{p}", "(or " + " ".join(f"{p}_{v}" for v in VALS) + ")")
            self.r(f"L142_VERalone_{p}", f"(=> {p}_VER (not (or " + " ".join(f"{p}_{v}" for v in VALS if v != "VER") + ")))")
            self.r(f"L142_ALTalone_{p}", f"(=> {p}_ALT (not (or " + " ".join(f"{p}_{v}" for v in VALS if v != "ALT") + ")))")
            for v in VALS[:-1]:
                self.r(f"L155_cond_{p}_{v}", f"(=> {p}_{v} {pc[v]})")
            ns = "(or " + " ".join(f"{p}_{v}" for v in ["CEX", "NOTRUN", "UNK", "TO", "FAIL"]) + ")"
            self.r(f"L155_L153_unconf_{p}", f"(=> {p}_UNCONF (and (not {pc['VER']}) (not {pc['ALT']}) (not {ns})))")
            # L159-160: property with >=1 check and a non-success check -> set == non-success check verdicts
            if cs:
                m = {"CEX": "Cex", "NOTRUN": "NotRun", "UNK": "Unk", "TO": "TO", "FAIL": "Fail"}
                eqs = " ".join(f"(= {p}_{v} {anyv(m[v])})" for v in m) + f" (not {p}_UNCONF) (not {p}_VER) (not {p}_ALT)"
                nonsucc = "(or " + " ".join(f"(not (= {c}_cv Succ))" for c in cs) + ")"
                self.r(f"L159_agg_{p}", f"(=> {nonsucc} (and {eqs}))")
            self.r(f"L176_{p}", f"(=> {p}_pq (and (not {p}_VER) (not {p}_ALT)))")                     # L176
            self.r(f"L84_{p}", f"(=> (and {p}_formal (not {p}_corr)) (and (not {p}_VER) (not {p}_ALT)))")  # L84
            self.r(f"L110_notool_{p}", f"(=> (and {p}_formal {p}_notool) (and {p}_NOTRUN " +            # L110
                   " ".join(f"(not {p}_{v})" for v in VALS if v != "NOTRUN") + "))")

        # L202-L215 completion
        self.decls += ["(declare-const complete Bool)", "(declare-const nprops Int)", "(declare-const combos_left Bool)",
                       "(declare-const saved Bool)", "(declare-const sp12_ok Bool)", "(declare-const detunconf Bool)",
                       "(declare-const pq_any Bool)"]
        ps = list(self.props)
        allsuccess = "(and true " + " ".join(f"(or {p}_VER {p}_ALT)" for p in ps) + ")"
        self.r("WF_nprops", f"(= nprops {len(ps)})")
        self.r("WF_pq_any", "(=> (or false " + " ".join(f"{p}_pq" for p in ps) + ") pq_any)")
        conds = f"(and {allsuccess} sp12_ok (not combos_left) (not pq_any) saved (> nprops 0) (not detunconf))"
        self.r("L202_onlyif", f"(=> complete {conds})")
        self.r("L202_if", f"(=> {conds} complete)")
        self.r("L211_hold_zero", "(=> (= nprops 0) (not complete))")
        self.r("L213_hold_detunconf", "(=> detunconf (not complete))")
        self.r("L215_stop", "(=> (or false " + " ".join(f"{p}_CEX {p}_NOTRUN" for p in ps) + ") (not complete))")

    def outputs(self):
        return ["complete"] + [f"{p}_{v}" for p in self.props for v in VALS]


def smt(model, inputs, extra, mode):
    lines = ["(set-option :produce-unsat-cores true)", "(set-option :smt.core.minimize true)", "(set-option :produce-models true)"]
    lines += model.decls
    asserts = list(inputs) + (model.rules if mode in ("B", "C", "E") else [r for r in model.rules if r[0].startswith("WF_")])
    if mode in ("C", "E"):
        asserts += extra[mode]
    lines += [f"(assert (! {f} :named {n}))" for n, f in asserts]
    lines += ["(check-sat)", '(echo "--core--")', "(get-unsat-core)", '(echo "--model--")',
              "(get-value (" + " ".join(model.outputs()) + "))"]
    return "\n".join(lines) + "\n"


def run(qid, model, inputs, expected):
    os.makedirs(OUT, exist_ok=True)
    eq = "(and " + " ".join(f"(= {k} {v})" for k, v in expected.items()) + ")"
    extra = {"C": [("Q_neq_expected", f"(not {eq})")], "E": [("Q_eq_expected", eq)]}
    res = {}
    for mode in ("A", "B", "C", "E"):
        fn = os.path.join(OUT, f"{qid}_{mode}.smt2")
        open(fn, "w").write(smt(model, inputs, extra, mode))
        p = subprocess.run([Z3, "-T:20", "-smt2", fn], capture_output=True, text=True)
        out = p.stdout + p.stderr
        open(fn[:-5] + ".out", "w").write(out)
        res[mode] = out.strip().split("\n")[0]
        res[mode + "_out"] = out
    return res


def trues(out):
    m = out.split("--model--")[1]
    return [t.split()[0] for t in m.replace("(", " ( ").replace(")", " ) ").split("(") if t.strip().endswith("true )") or t.strip().endswith("true")]


def verdict(res):
    if any(res[m] not in ("sat", "unsat") for m in "ABCE"):
        return "unknown/timeout"
    if res["A"] != "sat":
        return "前提が unsat"
    if res["B"] == "unsat":
        return "矛盾"
    if res["C"] == "unsat":
        return "一意"
    return "未確定" if res["E"] == "sat" else "期待と異なる値で決まる"
