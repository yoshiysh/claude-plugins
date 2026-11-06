import csv
import re
from pathlib import Path

OUT = Path(__file__).resolve().parent
tla = (OUT / "Flow.tla").read_text()
defined = set(re.findall(r"^(\w+)\s*==", tla, re.M))
nondone = set(re.findall(r"\\/\s*(\w+)", tla[tla.index("NonDone =="):tla.index("\\* WF-20")]))
with open(OUT.parent / "design-v6" / "rules.tsv") as f:
    heads = {r[0].split(":")[0] for r in list(csv.reader(f, delimiter="\t"))[1:] if r[0].startswith("WF-")}

bad = 0
trace = [l.split("\t") for l in (OUT / "trace.tsv").read_text().splitlines()[1:]]
tw = {r[0] for r in trace}
acts = {a for r in trace for a in r[1].split(",")}
for a in sorted(nondone - acts):
    print("NonDone action not in trace:", a); bad += 1
for a in sorted(acts - defined):
    print("trace action not in Flow.tla:", a); bad += 1
for h in sorted(tw - heads):
    print("trace WF not in rules.tsv:", h); bad += 1
for h in sorted(heads - tw):
    print("rules.tsv WF not in trace:", h); bad += 1


def names(cell):
    for part in re.split(r"[,・]", cell):
        n = re.sub(r"\[.*?\]|（.*?）", "", part).strip()
        if n:
            yield n


for i, line in enumerate((OUT / "table.tsv").read_text().splitlines()[1:], 2):
    cols = line.split("\t")
    if cols[2] == "?":
        continue
    for n in names(cols[1]):
        if n not in defined:
            print(f"table.tsv:{i} event {n} not in Flow.tla"); bad += 1
print("nondone", len(nondone), "wf", len(heads), "bad", bad)
