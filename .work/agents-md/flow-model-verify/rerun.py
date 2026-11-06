import csv, random, re, shutil, subprocess, sys
from pathlib import Path
O = Path(__file__).resolve().parent
M = O.parent / "flow-model"
JAR = "/Users/yoshi/.local/share/tla/tla2tools.jar"
shutil.copy(M / "Flow.tla", O / "Flow.tla")
rows = list(csv.DictReader(open(M / "results.tsv"), delimiter="\t"))
byname = {r["check"]: r for r in rows}
muts = sorted(r["check"] for r in rows if r["check"].startswith("mut_"))
picked = random.Random(7272).sample(muts, 3)
fixed = ["decided_P1", "decided_P8", "decided_P11", "decided_P14", "decided_P16",
         "v4_P1", "v4_P8", "v4_P11", "v4_P14"]
out = [("check", "kind", "expected_states", "expected_result", "states", "result", "match", "note")]
for name in fixed + picked:
    shutil.copy(M / "cfg" / f"{name}.cfg", O / f"{name}.cfg")
    p = subprocess.run(["java", "-XX:+UseParallelGC", f"-Djava.io.tmpdir={O/'tmp'}", "-cp", JAR,
                        "tlc2.TLC", "-metadir", str(O / "states" / name), "-workers", "4",
                        "-config", f"{name}.cfg", "Flow.tla"],
                       cwd=O, capture_output=True, text=True, timeout=300)
    log = p.stdout + p.stderr
    (O / "logs" / f"{name}.log").write_text(log)
    m = re.findall(r"([\d,]+) distinct states found", log)
    st = m[-1].replace(",", "") if m else "?"
    viol = re.search(r"(Invariant \S+ is violated|Action property \S+ is violated|Temporal properties were violated|Deadlock reached)", log)
    res = "fail" if viol else ("pass" if "No error has been found" in log else "error")
    e = byname[name]
    match = "yes" if (st == e["states"] and res == e["result"]) else "no"
    kind = "mutation(seed7272)" if name in picked else name.split("_")[0]
    out.append((name, kind, e["states"], e["result"], st, res, match, viol.group(1) if viol else ""))
    print(name, st, res, match, flush=True)
with open(O / "rerun.raw.tsv", "w") as f:
    for r in out:
        f.write("\t".join(r) + "\n")
