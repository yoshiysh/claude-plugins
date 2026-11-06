import re
import shutil
import subprocess
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent
JAR = "/Users/yoshi/.local/share/tla/tla2tools.jar"

INV = {"P2", "P3", "P4", "P4D", "P11", "P12", "P13", "P15", "P16", "P17"}
PROPS = {
    "P1": ["P1"], "P2": ["P2"], "P3": ["P3"], "P4": ["P4"], "P4D": ["P4D"],
    "P5": ["P5"], "P6": ["P6inv", "P6act"], "P7": ["P7"], "P8": ["P8"],
    "P9": ["P9"], "P10": ["P10"], "P11": ["P11"], "P12": ["P12"],
    "P13": ["P13"], "P14": ["P14"], "P15": ["P15"], "P16": ["P16"], "P17": ["P17"],
}
ALL = list(PROPS)

MUTS = [
    ("TriageNoSev", "P1"), ("OrchSev", "P2"), ("SkipDR", "P3"), ("SkipIR", "P4"),
    ("MedPass", "P5"), ("Relog", "P6"), ("HumanLowNotFixed", "P7"),
    ("SelfDefInPlace", "P8"), ("EnvRToDesign", "P9"), ("EnvURetry", "P10"),
    ("AskStop", "P11"), ("ResumeAfterReport", "P12"), ("SelfReview", "P13"),
    ("EnvURetry", "P14"), ("PlaceAny", "P15"),
]


def checks():
    for p in ALL:
        yield f"decided_{p}", "decided", "none", False, False, p
    for p in ["P16", "P17", "P4D", "P4", "P14"]:
        yield f"decidedOpt_{p}", "decided", "none", True, True, p
    for p in ALL:
        yield f"v4_{p}", "v4", "none", False, False, p
    for m, p in MUTS:
        yield f"mut_{m}_{p}", "decided", m, False, False, p


def cfg_text(model, mut, draft, hold, prop):
    lines = ["SPECIFICATION Spec", "CONSTANTS",
             f'  Model = "{model}"', f'  Mut = "{mut}"',
             f"  DraftForTypo = {'TRUE' if draft else 'FALSE'}",
             f"  HoldLow = {'TRUE' if hold else 'FALSE'}", "  EnvBudget = 2"]
    for f in PROPS[prop]:
        lines.append(("INVARIANT " if f in INV or f == "P6inv" else "PROPERTY ") + f)
    return "\n".join(lines) + "\n"


def run(name, model, mut, draft, hold, prop):
    cfg = OUT / "cfg" / f"{name}.cfg"
    cfg.write_text(cfg_text(model, mut, draft, hold, prop))
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
    target = PROPS[prop]
    hit = (what.startswith("Temporal") and prop == "P14") or any(
        f" {t} " in f" {what} " for t in target)
    cex = f"cex/{name}.txt"
    shutil.copy(OUT / "logs" / f"{name}.txt", OUT / cex)
    return states, "fail", cex, what + ("" if hit else " [NOT TARGET]")


def main():
    only = sys.argv[1:]
    rows = []
    for c in checks():
        if only and not any(c[0].startswith(o) for o in only):
            continue
        states, res, cex, what = run(*c)
        rows.append((c[0], f"cfg/{c[0]}.cfg", states, res, cex, what))
        print("\t".join(rows[-1]), flush=True)
    if not only:
        with open(OUT / "results.raw.tsv", "w") as f:
            for r in rows:
                f.write("\t".join(r) + "\n")


main()
