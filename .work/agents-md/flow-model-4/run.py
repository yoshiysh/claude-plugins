import re
import shutil
import subprocess
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent
JAR = "/Users/yoshi/.local/share/tla/tla2tools.jar"

FORMULAS = {
    "P1": ["P1"], "P2": ["P2"], "P3": ["P3"], "P4": ["P4"], "P5": ["P5"], "P6": ["P6"],
    "P7": ["P7"], "P8": ["P8", "P8a"], "P9": ["P9"], "P10": ["P10"], "P11": ["P11"],
    "P13": ["P13"], "P14": ["P14"], "P15": ["P15"], "P16": ["P16", "P16a"], "P17": ["P17"],
    "C1": ["C1"], "C2": ["C2"], "C3": ["C3", "C3b"],
    "I1": ["I1"], "I2": ["I2"], "I4": ["I4"],
}
TEMPORAL = {"P1", "P5", "P6", "P7", "P8a", "P9", "P10", "P14", "P16a", "C3b", "I2"}
DECISION = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10",
            "P11", "P13", "P14", "P15", "P16", "P17"]
CONSTRAINT = ["C1", "C2", "C3"]
INFO = ["I1", "I2", "I4"]

BASE = dict(Model="decided", Mut="none", WF19=True, SevErr=True, RecCorrect=True,
            EnvBudget=1, MisBudget=1, ReBudget=1, FpBudget=1, SjBudget=1, DraftBudget=1, BadBudget=0,
            EnvUnb=False, MisUnb=False, ReUnb=False, FpUnb=False, BadUnb=False)

V6 = dict(Model="v6", BadBudget=1)

MUTS = [
    ("TriageNoSev", "P1", {}), ("SevOnHuman", "P1", {}), ("NoCount", "P1", V6),
    ("OrchSev", "P2", {}), ("SkipDR", "P3", {}),
    ("SkipIR", "P4", {}), ("MedPass", "P5", {}), ("LowFix", "P6", {}),
    ("HumanLowNotFixed", "P7", {}), ("SelfLowLog", "P8", {}), ("NoRecord", "P8", {}),
    ("EnvRToDesign", "P9", {}), ("NoRecord", "P10", {}), ("EnvURetry", "P10", {}),
    ("StuckAfterReview", "P11", {}), ("SelfReview", "P13", {}), ("SkipRecReview", "P13", {}),
    ("PlaceAny", "P15", {}), ("ScaleSev", "P15", {}), ("InboxIgnored", "P16", {}),
    ("NoWake", "P17", {}), ("NoWait", "P17", {}), ("GateAmbiguous", "C3", {}),
]

ASSUME = [
    ("F1off", dict(ReUnb=True), "P14"), ("F2off", dict(EnvUnb=True), "P14"),
    ("F5off", dict(MisUnb=True), "P14"), ("F8off", dict(FpUnb=True), "P14"),
    ("F6off", dict(RecCorrect=False), "P8"),
]


def checks():
    for p in DECISION + CONSTRAINT + INFO:
        yield f"decided_{p}", {}, p
    yield "decidedNoSevErr_I1", dict(SevErr=False), "I1"
    yield "decidedNoMis_I2", dict(MisBudget=0), "I2"
    yield "decidedBadSev_P11", dict(BadBudget=1), "P11"
    for name, over, p in ASSUME:
        yield f"assume_{name}_{p}", over, p
    for p in DECISION + CONSTRAINT + INFO:
        yield f"v6_{p}", V6, p
    yield "v6NoWF19_P16", dict(V6, WF19=False), "P16"
    yield "v6_assume_F9off_P14", dict(V6, BadUnb=True), "P14"
    for m, p, base in MUTS:
        yield f"mut_{m}_{p}", dict(base, Mut=m), p


def val(v):
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, int):
        return str(v)
    return f'"{v}"'


def cfg_text(over, prop):
    c = dict(BASE, **over)
    lines = ["SPECIFICATION Spec", "CONSTANTS"] + [f"  {k} = {val(v)}" for k, v in c.items()]
    for f in FORMULAS[prop]:
        lines.append(("PROPERTY " if f in TEMPORAL else "INVARIANT ") + f)
    return "\n".join(lines) + "\n"


def run(name, over, prop):
    cfg = OUT / "cfg" / f"{name}.cfg"
    cfg.write_text(cfg_text(over, prop))
    cmd = ["java", "-XX:+UseParallelGC", f"-Djava.io.tmpdir={OUT}/tmp", "-cp", JAR,
           "tlc2.TLC", "-metadir", str(OUT / "states"), "-workers", "4",
           "-config", str(cfg.relative_to(OUT)), "Flow.tla"]
    p = subprocess.run(cmd, cwd=OUT, capture_output=True, text=True, timeout=120)
    out = p.stdout + p.stderr
    (OUT / "logs" / f"{name}.txt").write_text(out)
    m = re.findall(r"(\d+) distinct states found", out)
    states = m[-1] if m else "?"
    if "Model checking completed. No error has been found." in out:
        return states, "pass", "", ""
    err = re.search(r"Error: (Invariant \S+ is violated|Action property \S+ is violated"
                    r"|Temporal properties were violated|Deadlock reached)", out)
    what = err.group(1) if err else "error(see log)"
    hit = (what.startswith("Temporal") and prop == "P14") or any(
        f" {f} " in f" {what} " for f in FORMULAS[prop])
    cex = f"cex/{name}.txt"
    shutil.copy(OUT / "logs" / f"{name}.txt", OUT / cex)
    return states, "fail", cex, what + ("" if hit else " [NOT TARGET]")


def main():
    only = sys.argv[1:]
    rows = []
    for name, over, prop in checks():
        if only and not any(name.startswith(o) for o in only):
            continue
        states, res, cex, what = run(name, over, prop)
        rows.append((name, f"cfg/{name}.cfg", states, res, cex, what))
        print("\t".join(rows[-1]), flush=True)
    if not only:
        with open(OUT / "results.raw.tsv", "w") as f:
            for r in rows:
                f.write("\t".join(r) + "\n")


main()
