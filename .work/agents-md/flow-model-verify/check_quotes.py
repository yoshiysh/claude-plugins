import csv
from pathlib import Path
O = Path(__file__).resolve().parent
R = O.parents[2]
bad = 0
for r in csv.DictReader(open(O / "rev.tsv"), delimiter="\t"):
    path, _, ln = r["evidence_ref"].rpartition(":")
    lines = (R / path).read_text().split("\n")
    lo, _, hi = ln.partition("-")
    seg = "".join(lines[int(lo) - 1:int(hi or lo)])
    if r["evidence_quote"] not in seg:
        bad += 1; print("NG", r["action"], r["evidence_ref"])
print("checked", "bad", bad)
