import re
import shutil
import subprocess
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent
JAR = "/Users/yoshi/.local/share/tla/tla2tools.jar"

ACTION = {"P1", "P5", "P6", "P7", "P9", "P10", "P14", "I2"}
DECISION = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10",
            "P11", "P13", "P14", "P15"]
CONSTRAINT = ["C1", "C2", "C3", "C4"]
INFO = ["I1", "I2"]

BASE = dict(Model="decided", Mut="none", SelfLow="log", SevErr=True, RecCorrect=True,
            Redraft=False, EnvBudget=1, MisBudget=1, ReBudget=1, EnvUnb=False,
            MisUnb=False, ReUnb=False, HumanRepeat=False)

MUTS = [
    ("TriageNoSev", "P1"), ("OrchSev", "P2"), ("SkipDR", "P3"), ("SkipIR", "P4"),
    ("MedPass", "P5"), ("LowFix", "P6"), ("HumanLowNotFixed", "P7"),
    ("NoRecord", "P8"), ("EnvRToDesign", "P9"), ("NoRecord", "P10"),
    ("EnvURetry", "P10"), ("AskStop", "P11"), ("SelfReview", "P13"),
    ("SkipRecReview", "P13"), ("PlaceAny", "P15"), ("ResumeAfterReport", "C3"),
]

ASSUME = [
    ("F1off", dict(ReUnb=True), "P14"), ("F2off", dict(EnvUnb=True), "P14"),
    ("F3off", dict(HumanRepeat=True), "P14"), ("F5off", dict(MisUnb=True), "P14"),
    ("F6off", dict(RecCorrect=False), "P8"),
]


def checks():
    for p in DECISION + CONSTRAINT + INFO:
        yield f"decided_{p}", {}, p
    for p in DECISION + CONSTRAINT:
        yield f"decidedSelfDesign_{p}", dict(SelfLow="design"), p
    for p in ["C4", "P4", "P14"]:
        yield f"decidedRedraft_{p}", dict(Redraft=True), p
    for name, over, p in ASSUME:
        yield f"assume_{name}_{p}", over, p
    yield "decidedNoSevErr_I1", dict(SevErr=False), "I1"
    yield "decidedNoMis_I2", dict(MisBudget=0), "I2"
    yield "v4_assume_F3off_P14", dict(Model="v4", HumanRepeat=True), "P14"
    for p in DECISION + CONSTRAINT:
        yield f"v4_{p}", dict(Model="v4"), p
    for m, p in MUTS:
        yield f"mut_{m}_{p}", dict(Mut=m), p


def val(v):
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, int):
        return str(v)
    return f'"{v}"'


def cfg_text(over, prop):
    c = dict(BASE, **over)
    lines = ["SPECIFICATION Spec", "CONSTANTS"] + [f"  {k} = {val(v)}" for k, v in c.items()]
    lines.append(("PROPERTY " if prop in ACTION else "INVARIANT ") + prop)
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
    hit = (what.startswith("Temporal") and prop == "P14") or f" {prop} " in f" {what} "
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
