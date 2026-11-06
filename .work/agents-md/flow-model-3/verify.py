import re
from pathlib import Path

OUT = Path(__file__).resolve().parent
BASE = OUT.parent
REPO = BASE.parent.parent
tla = (OUT / "Flow.tla").read_text()
defined = set(re.findall(r"^(\w+)\s*==", tla, re.M))


def names(cell):
    for part in re.split(r"[,・]", cell):
        n = re.sub(r"\[.*?\]|（.*?）", "", part).strip()
        if n:
            yield n


bad = 0
for i, line in enumerate((OUT / "trace.tsv").read_text().splitlines()[1:], 2):
    action, source, quote = line.split("\t")
    path, ln = re.search(r"(\S+):(\d+)$", source).groups()
    src = REPO / path if path == "AGENTS.md" else BASE / path
    text = src.read_text().splitlines()[int(ln) - 1]
    if quote not in text:
        print(f"trace.tsv:{i} quote not in {path}:{ln}")
        bad += 1
    for n in names(action):
        if n not in defined:
            print(f"trace.tsv:{i} action {n} not in Flow.tla")
            bad += 1
for i, line in enumerate((OUT / "table.tsv").read_text().splitlines()[1:], 2):
    cols = line.split("\t")
    event = cols[1]
    if cols[2] == "?":
        continue
    for n in names(event):
        if n not in defined:
            print(f"table.tsv:{i} event {n} not in Flow.tla")
            bad += 1
print("bad", bad)
