# Uniqueness questions over docs/specifications/formal-method.md (290 lines). Run: python3 -I questions.py
# For each question: A = inputs + WF sat (vacuity), B = + spec sat (no contradiction),
# C = + 'output != expected' unsat (unique), E = + 'output == expected' sat (expected is allowed).
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen import Model, run, verdict, trues, VALS, CHK_INPUTS, PROP_INPUTS

T, F = "true", "false"


def chk(c, **kw):
    d = {i: F for i in CHK_INPUTS}
    d.update({k: (T if v else F) for k, v in kw.items()})
    return [(f"IN_{c}_{k}", f"(= {c}_{k} {v})") for k, v in d.items()]


def chk_partial(c, **kw):
    return [(f"IN_{c}_{k}", f"(= {c}_{k} {T if v else F})") for k, v in kw.items()]


def prop(p, **kw):
    d = dict(formal=T, corr=T, mean=T, det=T, dd=F, dok=F, altok=F, pq=F, notool=F)
    d.update({k: (T if v else F) for k, v in kw.items()})
    return [(f"IN_{p}_{k}", f"(= {p}_{k} {v})") for k, v in d.items()]


def glob(combos=False, saved=True, sp12=True, detunconf=False, pq_any=False):
    b = lambda x: T if x else F
    return [("IN_combos", f"(= combos_left {b(combos)})"), ("IN_saved", f"(= saved {b(saved)})"), ("IN_sp12", f"(= sp12_ok {b(sp12)})"),
            ("IN_detunconf", f"(= detunconf {b(detunconf)})"), ("IN_pq_any", f"(= pq_any {b(pq_any)})")]


def exp(props, sets, complete=None):
    e = {f"{p}_{v}": (T if v in sets[p] else F) for p in props for v in VALS}
    if complete is not None:
        e["complete"] = T if complete else F
    return e


Q = []


def q(qid, props, inputs, sets, complete=None, note=""):
    m = Model(props)
    Q.append((qid, m, inputs, exp(props, sets, complete) if sets is not None else {"complete": T if complete else F}, note))


ok = dict(started=1, finished=1, ok=1)
q("Q1_agg_mixed", {"P": ["c1", "c2"]}, chk("c1", started=1, finished=1, cex=1) + chk("c2", **ok) + prop("P") + glob(), {"P": {"CEX"}}, False)
q("Q2_allsucc_meaningfail", {"P": ["c1", "c2"]}, chk("c1", **ok) + chk("c2", **ok) + prop("P", mean=0) + glob(), {"P": {"UNCONF"}}, False)
q("Q3_timelimit", {"P": ["c1", "c2"]}, chk("c1", started=1, tl=1) + chk("c2") + prop("P") + glob(), {"P": {"TO", "NOTRUN"}}, False)
q("Q4_pending_allok", {"P": ["c1"]}, chk("c1", **ok) + prop("P", pq=1) + glob(pq_any=True), {"P": {"UNCONF"}}, False)
free2 = chk_partial("c2", cex=0, unk=0, unkt=0, err=0, crash=0, unread=0, tl=0)
q("Q5_L215_otherprop", {"P1": ["c1"], "P2": ["c2"]}, chk("c1", started=1, finished=1, cex=1) + free2 + prop("P1") + prop("P2") + glob(),
  {"P1": {"CEX"}, "P2": {"VER"}}, False, "未確定でよい（依頼者の方針）")
q("Q6_L176_independent", {"P1": ["c1"], "P2": ["c2"]}, chk("c1") + free2 + prop("P1", pq=1) + prop("P2") + glob(pq_any=True),
  {"P1": {"NOTRUN"}, "P2": {"VER"}}, False, "未確定でよい（明示の許容）")
q("Q7_aborted", {"P": ["c1"]}, chk("c1", started=1, abort=1) + prop("P") + glob(), {"P": {"NOTRUN"}}, False)
# Q8 (memory insufficient) removed: CPU/memory limits were removed from the spec.
q("Q9_zerochecks", {"P": []}, prop("P") + glob(), {"P": {"UNCONF"}}, False)
q("Q10a_zeroprops", {}, glob(), None, False)
q("Q10b_detunconf", {"P": ["c1"]}, chk("c1", **ok) + prop("P") + glob(detunconf=True), None, False)
q("Q10c_allok", {"P": ["c1"]}, chk("c1", **ok) + prop("P") + glob(), {"P": {"VER"}}, True)
q("Q11_alt_ok", {"P": []}, prop("P", formal=0, altok=1) + glob(), {"P": {"ALT"}}, True)
q("Q12_alt_fail", {"P": []}, prop("P", formal=0) + glob(), {"P": {"UNCONF"}}, False)
q("Q13a_nonformal_succcheck_altfail", {"P": ["c1"]}, chk("c1", **ok) + prop("P", formal=0) + glob(), {"P": {"UNCONF"}}, False)
q("Q13b_nonformal_succcheck_altok", {"P": ["c1"]}, chk("c1", **ok) + prop("P", formal=0, altok=1) + glob(), {"P": {"ALT"}}, True)
q("Q14_notool_zerochecks", {"P": []}, prop("P", notool=1) + glob(), {"P": {"NOTRUN"}}, False)
q("Q15_single_cex", {"P": ["c1"]}, chk("c1", started=1, finished=1, cex=1) + prop("P") + glob(), {"P": {"CEX"}}, False)
q("Q16_unknown_by_tooltime", {"P": ["c1"]}, chk("c1", started=1, finished=1, unk=1, unkt=1) + prop("P") + glob(), {"P": {"TO"}}, False)
q("Q17_unknown_other", {"P": ["c1"]}, chk("c1", started=1, finished=1, unk=1) + prop("P") + glob(), {"P": {"UNK"}}, False)
q("Q18_notool_nocorr", {"P": []}, prop("P", notool=1, corr=0) + glob(), {"P": {"NOTRUN"}}, False)
q("Q19a_tool_nocorr_nocheck", {"P": []}, prop("P", corr=0) + glob(), {"P": {"UNCONF"}}, False)
q("Q19b_tool_nocorr_succcheck", {"P": ["c1"]}, chk("c1", **ok) + prop("P", corr=0) + glob(), {"P": {"UNCONF"}}, False)
q("Q19c_tool_nocorr_cexcheck", {"P": ["c1"]}, chk("c1", started=1, finished=1, cex=1) + prop("P", corr=0) + glob(), {"P": {"CEX"}}, False)
# Q20 changed: 'cannot decide' citing a resource (e.g. memory) is now an ordinary 'cannot decide'.
q("Q20_unknown_citing_resource", {"P": ["c1"]}, chk("c1", started=1, finished=1, unk=1) + prop("P") + glob(), {"P": {"UNK"}}, False)
q("Q21a_nonformal_alt_tool", {"P": []}, prop("P", formal=0, altok=1) + glob(), {"P": {"ALT"}}, True)
q("Q21b_nonformal_alt_notool", {"P": []}, prop("P", formal=0, altok=1, notool=1) + glob(), {"P": {"ALT"}}, True)
q("Q22_tl_crash", {"P": ["c1"]}, chk("c1", started=1, tl=1, crash=1) + prop("P") + glob(), {"P": {"TO"}}, False)
q("Q23_abort_crash", {"P": ["c1"]}, chk("c1", started=1, abort=1, crash=1) + prop("P") + glob(), {"P": {"NOTRUN"}}, False)
q("Q24_crash_own", {"P": ["c1"]}, chk("c1", started=1, crash=1) + prop("P") + glob(), {"P": {"FAIL"}}, False)
q("Q25_unknown_by_tooltime", {"P": ["c1"]}, chk("c1", started=1, finished=1, unk=1, unkt=1) + prop("P") + glob(), {"P": {"TO"}}, False)
q("Q26_tl_unread", {"P": ["c1"]}, chk("c1", started=1, tl=1, unread=1) + prop("P") + glob(), {"P": {"TO"}}, False)
q("Q27_unread_own", {"P": ["c1"]}, chk("c1", started=1, unread=1) + prop("P") + glob(), {"P": {"FAIL"}}, False)
q("Q28_tool_error", {"P": ["c1"]}, chk("c1", started=1, err=1) + prop("P") + glob(), {"P": {"FAIL"}}, False)

if __name__ == "__main__":
    for qid, m, ins, e, note in Q:
        res = run(qid, m, ins, e)
        line = f"{qid}: A={res['A']} B={res['B']} C={res['C']} E={res['E']} -> {verdict(res)}"
        if res["C"] == "sat":
            line += f" | alt: {trues(res['C_out'])}"
        if res["C"] == "unsat":
            core = res["C_out"].split("--core--")[1].split("--model--")[0].strip()
            line += f" | I_ in core: {'yes' if 'I_' in core else 'no'}"
        print(line + (f" ({note})" if note else ""))
