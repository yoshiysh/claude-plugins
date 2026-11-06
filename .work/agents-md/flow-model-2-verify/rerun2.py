import csv, re, shutil, subprocess
from pathlib import Path
O = Path(__file__).resolve().parent
JAR = "/Users/yoshi/.local/share/tla/tla2tools.jar"
rows = list(csv.DictReader(open(O.parent / "flow-model-2" / "results.tsv"), delimiter="\t"))
todo = [r for r in rows if r["check"].startswith(("decidedSelfDesign_", "decidedRedraft_", "decidedNoSevErr_", "decidedNoMis_"))]
with open(O / "rerun2.raw.tsv", "w") as f:
    f.write("check\tkind\tstates\tresult\tproperty\texp_states\texp_result\texp_note\n")
    for r in todo:
        c = r["check"]; md = O / "states" / c
        if md.exists(): shutil.rmtree(md)
        cmd = ["java", "-XX:+UseParallelGC", f"-Djava.io.tmpdir={O/'tmp'}", "-cp", JAR, "tlc2.TLC",
               "-metadir", str(md), "-workers", "4", "-config", str(O / "cfg" / f"{c}.cfg"), "Flow.tla"]
        p = subprocess.run(cmd, cwd=O, capture_output=True, text=True, timeout=300)
        out = p.stdout + p.stderr
        (O / "logs" / f"{c}.txt").write_text(out)
        m = re.findall(r"(\d+) states generated, (\d+) distinct states found", out)
        s = m[-1][1] if m else "?"
        v = re.search(r"Error: (.*violated.*)", out)
        res, prop = ("pass", "-") if "No error has been found" in out else (("fail", v.group(1).rstrip(".")) if v else ("error", "?"))
        f.write(f"{c}\trerun2\t{s}\t{res}\t{prop}\t{r['states']}\t{r['result']}\t{r['note'][:80]}\n")
        print(c, s, res, prop, r["states"], r["result"], flush=True)
