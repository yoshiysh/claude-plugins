import csv
from pathlib import Path
OUT = Path(__file__).resolve().parent
res = {r[0]: r for r in csv.reader(open(OUT.parent / "flow-model-4" / "results.tsv"), delimiter="\t")}
rows = [l.split("\t") for l in (OUT / "rerun.raw.tsv").read_text().splitlines()]
ALL = ["P1","P2","P3","P4","P5","P6","P7","P8","P9","P10","P11","P13","P14","P15","P16","P17","C1","C2","C3"]
out = [["check", "props", "mine_states", "mine_result", "mine_violated", "theirs_states", "theirs_result", "theirs_violated", "match", "note"]]
def cmp(name, mine, theirs_key, note=""):
    t = res.get(theirs_key)
    if not t:
        out.append([name, mine[1], mine[2], mine[3], mine[4], "-", "-", "-", "-", note]); return
    tv = t[5].split(";")[1].strip() if t[3] == "fail" and ";" in t[5] else ""
    if mine[3] == "pass":
        ok = t[3] == "pass" and t[2] == mine[2]
    else:
        ok = t[3] == "fail" and mine[4] == tv
    out.append([name, mine[1], mine[2], mine[3], mine[4], t[2], t[3], tv, "yes" if ok else "NO", note])
for r in rows:
    while len(r) < 5: r.append("")
    n = r[0]
    if n in ("decided_all", "v6_all"):
        pre = n.split("_")[0]
        for p in ALL:
            cmp(f"{pre}_{p}", r, f"{pre}_{p}", "全 P・C を 1 回の実行で確かめ、状態数で照合")
    elif n.startswith("own_"):
        cmp(n, r, None, "自作の確かめ（模型 4 の結果には無い）")
    else:
        cmp(n, r, n, "seed 9494 の選択" if n.startswith("mut_") else "fail は破れた式の名前で照合（workers 4 で違反時の状態数は揺れる）" if r[3] == "fail" else "")
with open(OUT / "rerun.tsv", "w") as f:
    f.write("# mut の選択: results.tsv の mut_ の 23 行をその順に並べたリスト MUTS（rerun.py）から random.Random(9494).sample(range(23), 3) = [19, 9, 14]\n")
    for r in out: f.write("\t".join(r) + "\n")
print(sum(1 for r in out[1:] if r[8] == "NO"), "mismatches;", len(out) - 1, "rows")
