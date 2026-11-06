import csv, random, re, subprocess, sys, shutil
from pathlib import Path

O = Path(__file__).resolve().parent
JAR = "/Users/yoshi/.local/share/tla/tla2tools.jar"
BASE = dict(Model='"decided"', Mut='"none"', SelfLow='"log"', SevErr="TRUE", RecCorrect="TRUE",
            Redraft="FALSE", EnvBudget="1", MisBudget="1", ReBudget="1", EnvUnb="FALSE",
            MisUnb="FALSE", ReUnb="FALSE", HumanRepeat="FALSE")


def write_cfg(name, prop_kind, prop, **over):
    c = dict(BASE, **over)
    body = "SPECIFICATION Spec\nCONSTANTS\n" + "".join(f"  {k} = {v}\n" for k, v in c.items())
    body += f"{prop_kind} {prop}\n"
    p = O / "own" / f"{name}.cfg"
    p.write_text(body)
    return p


def run(check, module, cfg, cwd):
    md = O / "states" / check
    if md.exists():
        shutil.rmtree(md)
    cmd = ["java", "-XX:+UseParallelGC", f"-Djava.io.tmpdir={O/'tmp'}", "-cp", JAR, "tlc2.TLC",
           "-metadir", str(md), "-workers", "4", "-config", str(cfg), module]
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=300)
    out = p.stdout + p.stderr
    (O / "logs" / f"{check}.txt").write_text(out)
    m = re.findall(r"(\d+) states generated, (\d+) distinct states found", out)
    states = m[-1][1] if m else "?"
    viol = re.search(r"Error: (.*violated.*)", out)
    if "No error has been found" in out:
        res, prop = "pass", "-"
    elif viol:
        res, prop = "fail", viol.group(1).rstrip(".")
    else:
        res, prop = "error", (re.search(r"Error: (.*)", out) or [None, "?"])[1] if re.search(r"Error: (.*)", out) else "?"
    return states, res, prop


def main():
    rows = list(csv.DictReader(open(O.parent / "flow-model-2" / "results.tsv"), delimiter="\t"))
    exp = {r["check"]: r for r in rows}
    muts = sorted(r["check"] for r in rows if r["check"].startswith("mut_"))
    picked = random.Random(8383).sample(muts, 3)
    jobs = []
    for r in rows:
        c = r["check"]
        if c.startswith(("decided_", "v4_", "assume_")) or c in picked:
            jobs.append((c, "rerun", "Flow.tla", O / "cfg" / f"{c}.cfg", O))
    for c in picked:
        prop = c.rsplit("_", 1)[1]
        kind = "INVARIANT" if prop in ("P2", "P3", "P4", "P8", "P11", "P13", "P15", "C1", "C2", "C3", "C4") else "PROPERTY"
        jobs.append((f"control_{c}", "control", "Flow.tla", write_cfg(f"control_{c}", kind, prop), O))
    own = [
        ("probe_R1_logged_self_in_PR", "INVARIANT", "R1", {}),
        ("probe_R2_envR_masks_defect", "PROPERTY", "R2", {}),
        ("probe_R3_review_reads_record", "PROPERTY", "R3", {}),
        ("probe_R4_redraft", "PROPERTY", "R4", {"Redraft": "TRUE"}),
        ("probe_R5_merged_with_logged", "INVARIANT", "R5", {}),
        ("probe_R6_merged", "INVARIANT", "R6", {}),
        ("probe_R7_reported", "INVARIANT", "R7", {}),
        ("probe_R8_human_on_logged", "PROPERTY", "R8", {}),
    ]
    for name, kind, prop, over in own:
        jobs.append((name, "probe", "FlowProbe.tla", write_cfg(name, kind, prop, **over), O))
    for mod in ("FlowSelfMed", "FlowOpenChk", "FlowFP"):
        props = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11", "P13", "P14", "P15"]
        if mod != "FlowSelfMed":
            props = ["P8", "P14"]
        for p in props:
            kind = "INVARIANT" if p in ("P2", "P3", "P4", "P8", "P11", "P13", "P15") else "PROPERTY"
            name = f"own_{mod}_{p}"
            jobs.append((name, "own", f"{mod}.tla", write_cfg(name, kind, p), O / "own"))
        if mod == "FlowOpenChk":
            name = f"own_{mod}_SelfDesign_P14"
            jobs.append((name, "own", f"{mod}.tla", write_cfg(name, "PROPERTY", "P14", SelfLow='"design"'), O / "own"))
    with open(O / "rerun.raw.tsv", "w") as f:
        f.write("check\tkind\tstates\tresult\tproperty\texp_states\texp_result\texp_note\n")
        for c, kind, mod, cfg, cwd in jobs:
            s, r, p = run(c, mod, cfg, cwd)
            e = exp.get(c, {})
            f.write(f"{c}\t{kind}\t{s}\t{r}\t{p}\t{e.get('states','')}\t{e.get('result','')}\t{e.get('note','')[:80]}\n")
            f.flush()
            print(c, s, r, p, e.get("states", ""), e.get("result", ""), flush=True)
    print("picked", picked)


main()
