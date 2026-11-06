import random
import re
import subprocess
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent
JAR = "/Users/yoshi/.local/share/tla/tla2tools.jar"
SRC = OUT / "Flow.tla"

BASE = dict(Model="decided", Mut="none", WF19=True, SevErr=True, RecCorrect=True,
            EnvBudget=1, MisBudget=1, ReBudget=1, FpBudget=1, SjBudget=1, DraftBudget=1, BadBudget=0,
            EnvUnb=False, MisUnb=False, ReUnb=False, FpUnb=False, BadUnb=False)
V6 = dict(Model="v6", BadBudget=1)
TEMPORAL = {"P1", "P5", "P6", "P7", "P8a", "P9", "P10", "P14", "P16a", "C3b", "I2", "P16xa", "P4R"}
ALLP = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P8a", "P9", "P10", "P11", "P13", "P14",
        "P15", "P16", "P16a", "P17", "C1", "C2", "C3", "C3b"]

MUTS = [
    ("TriageNoSev", ["P1"], {}), ("SevOnHuman", ["P1"], {}), ("NoCount", ["P1"], V6),
    ("OrchSev", ["P2"], {}), ("SkipDR", ["P3"], {}), ("SkipIR", ["P4"], {}),
    ("MedPass", ["P5"], {}), ("LowFix", ["P6"], {}), ("HumanLowNotFixed", ["P7"], {}),
    ("SelfLowLog", ["P8", "P8a"], {}), ("NoRecord", ["P8", "P8a"], {}),
    ("EnvRToDesign", ["P9"], {}), ("NoRecord", ["P10"], {}), ("EnvURetry", ["P10"], {}),
    ("StuckAfterReview", ["P11"], {}), ("SelfReview", ["P13"], {}), ("SkipRecReview", ["P13"], {}),
    ("PlaceAny", ["P15"], {}), ("ScaleSev", ["P15"], {}), ("InboxIgnored", ["P16", "P16a"], {}),
    ("NoWake", ["P17"], {}), ("NoWait", ["P17"], {}), ("GateAmbiguous", ["C3", "C3b"], {}),
]
PICK = random.Random(9494).sample(range(len(MUTS)), 3)

REDRAFT = ("             THEN Back /\\ UNCHANGED <<pr, irEver>>",
           "             THEN Back /\\ UNCHANGED irEver /\\ pr' = (IF Mut = \"ReDraft\" THEN \"draft\" ELSE pr)")
PRH_ACT = """
PRHuman ==
  /\\ pr = "ready" /\\ stage \\in {"wake", "prbot", "ptriage"} /\\ dLeft > 0
  /\\ \\E d \\in OpenAll \\ hc : inboxR' = inboxR \\cup {F(d, "human", "none", "none")} /\\ hc' = hc \\cup {d}
  /\\ dLeft' = dLeft - 1
  /\\ SetEv("PRHuman", "human")
  /\\ UNCHANGED <<stage, scale, sj, place, pr, ds, pend, inbox, drOK, irOK, irEver, botOK,
                 envLeft, misLeft, reLeft, fpLeft, sjLeft, badLeft,
                 chk, chkTrue, chkD, cls, rec, selfSeen, bc>>

\\* WF-14"""
PRH_PROPS = """
P16x == stage \\in {"gate", "htriage", "merged"} => inbox = {} /\\ inboxR = {}
P16xa == [][(IsTriage /\\ stage \\in {"dtriage", "itriage", "ptriage"}) => (inbox' = {} /\\ inboxR' = {})]_vars
P4R == [][(pr = "ready") => (pr' = "ready")]_vars
=============================================================================
"""


def variant(name):
    t = SRC.read_text()
    if name == "redraft":
        assert REDRAFT[0] in t
        t = t.replace(REDRAFT[0], REDRAFT[1])
    if name == "prhuman":
        t = t.replace("\n\\* WF-14", PRH_ACT, 1)
        t = t.replace('AbsorbsR == Absorbs /\\', 'AbsorbsR == (Absorbs \\/ stage = "ptriage") /\\', 1)
        t = t.replace("\\/ ReworkHuman\n", "\\/ ReworkHuman \\/ PRHuman\n", 1)
        assert "PRHuman" in t and 'stage = "ptriage") /\\' in t
    t = re.sub(r"\n=+\n?$", "\n", t.rstrip() + "\n")
    t += PRH_PROPS
    d = OUT / "own" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "Flow.tla").write_text(t)
    return d


def val(v):
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, int):
        return str(v)
    return f'"{v}"'


def run(name, over, props, spec_dir):
    c = dict(BASE, **over)
    lines = ["SPECIFICATION Spec", "CONSTANTS"] + [f"  {k} = {val(v)}" for k, v in c.items()]
    for f in props:
        lines.append(("PROPERTY " if f in TEMPORAL else "INVARIANT ") + f)
    cfg = OUT / "cfg" / f"{name}.cfg"
    cfg.write_text("\n".join(lines) + "\n")
    meta = OUT / "states" / name
    cmd = ["java", "-XX:+UseParallelGC", f"-Djava.io.tmpdir={OUT}/tmp", "-cp", JAR, "tlc2.TLC",
           "-metadir", str(meta), "-workers", "4", "-config", str(cfg), "Flow.tla"]
    p = subprocess.run(cmd, cwd=spec_dir, capture_output=True, text=True, timeout=1800)
    out = p.stdout + p.stderr
    (OUT / "logs" / f"{name}.txt").write_text(out)
    m = re.findall(r"([\d,]+) distinct states found", out)
    states = m[-1].replace(",", "") if m else "?"
    if "Model checking completed. No error has been found." in out:
        return states, "pass", ""
    err = re.search(r"Error: (Invariant \S+ is violated|Action property \S+ is violated"
                    r"|Temporal properties were violated|Deadlock reached)", out)
    return states, "fail", err.group(1) if err else "error(see log)"


def jobs():
    yield "decided_all", {}, ALLP, OUT
    yield "v6_all", V6, ALLP, OUT
    for n, over, p in [
        ("decided_I1", {}, ["I1"]), ("decided_I2", {}, ["I2"]), ("decided_I4", {}, ["I4"]),
        ("decidedNoSevErr_I1", dict(SevErr=False), ["I1"]), ("decidedNoMis_I2", dict(MisBudget=0), ["I2"]),
        ("decidedBadSev_P11", dict(BadBudget=1), ["P11"]),
        ("assume_F1off_P14", dict(ReUnb=True), ["P14"]), ("assume_F2off_P14", dict(EnvUnb=True), ["P14"]),
        ("assume_F5off_P14", dict(MisUnb=True), ["P14"]), ("assume_F8off_P14", dict(FpUnb=True), ["P14"]),
        ("assume_F6off_P8", dict(RecCorrect=False), ["P8", "P8a"]),
        ("v6_I1", V6, ["I1"]), ("v6_I2", V6, ["I2"]), ("v6_I4", V6, ["I4"]),
        ("v6NoWF19_P16", dict(V6, WF19=False), ["P16", "P16a"]),
        ("v6_assume_F9off_P14", dict(V6, BadUnb=True), ["P14"]),
    ]:
        yield n, over, p, OUT
    for i in PICK:
        m, p, base = MUTS[i]
        yield f"mut_{m}_{p[0]}", dict(base, Mut=m), p, OUT
    yield "own_F6off_P15", dict(RecCorrect=False), ["P15"], OUT
    rd = variant("redraft")
    yield "own_ReDraft_all", dict(Mut="ReDraft"), ALLP, rd
    yield "own_ReDraft_P4R", dict(Mut="ReDraft"), ["P4R"], rd
    ph = variant("prhuman")
    yield "own_PRHuman_dec", {}, ["P1", "P5", "P6", "P7", "P11", "P14", "P16x", "P16xa", "P17", "C3", "C3b"], ph
    yield "own_PRHuman_v6", V6, ["P1", "P5", "P6", "P7", "P11", "P14", "P16x", "P16xa", "P17", "C3", "C3b"], ph
    yield "own_PRHuman_P16", {}, ["P16"], ph


only = sys.argv[1:]
print("pick", PICK, [MUTS[i][0] + "_" + MUTS[i][1][0] for i in PICK], flush=True)
with open(OUT / "rerun.raw.tsv", "a") as f:
    for name, over, props, d in jobs():
        if only and name not in only:
            continue
        r = run(name, over, props, d)
        row = "\t".join([name, ",".join(props), *r])
        print(row, flush=True)
        f.write(row + "\n")
        f.flush()
