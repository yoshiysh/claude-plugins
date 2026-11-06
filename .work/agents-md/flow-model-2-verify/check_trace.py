import csv, re
from pathlib import Path
O = Path(__file__).resolve().parent
A = O.parent
REPO = A.parent.parent
def lines(rel):
    p = REPO / rel if rel == "AGENTS.md" else A / rel
    return p.read_text().splitlines()
for r in csv.DictReader(open(A / "flow-model-2" / "trace.tsv"), delimiter="\t"):
    m = re.search(r"([\w./-]+):(\d+)", r["source"])
    f, n = m.group(1), int(m.group(2))
    L = lines(f)
    exact = r["quote"] in L[n - 1]
    near = exact or r["quote"] in "".join(x.strip() for x in L[n - 1:n + 3])
    anywhere = [i + 1 for i, x in enumerate(L) if r["quote"] in x]
    print(f"{r['action']}\t{f}:{n}\t{'line' if exact else ('span' if near else 'NO')}\t{anywhere}")
