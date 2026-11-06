import re, shutil, subprocess
from pathlib import Path
O = Path(__file__).resolve().parent
M = O.parent / "flow-model"
JAR = "/Users/yoshi/.local/share/tla/tla2tools.jar"
def run(name, tag):
    shutil.copy(M / "cfg" / f"{name}.cfg", O / f"{name}.cfg")
    p = subprocess.run(["java", "-XX:+UseParallelGC", f"-Djava.io.tmpdir={O/'tmp'}", "-cp", JAR,
                        "tlc2.TLC", "-metadir", str(O / "states" / f"{name}-{tag}"), "-workers", "4",
                        "-config", f"{name}.cfg", "Flow.tla"], cwd=O, capture_output=True, text=True, timeout=300)
    log = p.stdout + p.stderr
    (O / "logs" / f"{name}-{tag}.log").write_text(log)
    m = re.findall(r"([\d,]+) distinct states found", log)
    v = re.search(r"(Invariant \S+ is violated|Action property \S+ is violated|Temporal properties were violated)", log)
    return (m[-1].replace(",", "") if m else "?"), ("fail" if v else ("pass" if "No error has been found" in log else "error")), (v.group(1) if v else "")
with open(O / "rerun2.raw.tsv", "w") as f:
    for name, tag in [("decided_P16", "r2"), ("decided_P16", "r3"), ("mut_SelfReview_P13", "r2"), ("mut_SelfReview_P13", "r3"),
                      ("decided_P2", "ctl"), ("decided_P9", "ctl"), ("decided_P13", "ctl")]:
        r = run(name, tag)
        f.write("\t".join((name, tag) + r) + "\n"); print(name, tag, *r, flush=True)
