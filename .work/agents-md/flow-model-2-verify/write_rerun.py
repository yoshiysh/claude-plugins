import csv
from pathlib import Path
O = Path(__file__).resolve().parent
exp = {r["check"]: r for r in csv.DictReader(open(O.parent / "flow-model-2" / "results.tsv"), delimiter="\t")}
H = ["check", "kind", "expected_states", "expected_result", "expected_property", "states", "result", "property", "match", "note"]
with open(O / "rerun.tsv", "w") as f:
    f.write("\t".join(H) + "\n")
    for r in [x for n in ("rerun.raw.tsv", "rerun2.raw.tsv") for x in csv.DictReader(open(O / n), delimiter="\t")]:
        c = r["check"]; e = exp.get(c)
        if e:
            ep = next((s.strip().rstrip(".") for s in e["note"].split(";") if "violated" in s), "-")
            if e["result"] == "pass":
                m = "yes" if (r["result"], r["states"]) == ("pass", e["states"]) else "NO"
                note = ""
            else:
                m = "yes" if (r["result"] == "fail" and r["property"] == ep) else "NO"
                note = "" if r["states"] == e["states"] else "fail の状態数は -workers 4 の並列探索で違反時点が揺れる"
            if c.startswith("mut_"):
                note = ("random.Random(8383).sample(整列した mut_* 16 本, 3) で選んだ; " + note).rstrip("; ")
            f.write("\t".join([c, r["kind"], e["states"], e["result"], ep, r["states"], r["result"], r["property"], m, note]) + "\n")
        else:
            f.write("\t".join([c, r["kind"], "-", "-", "-", r["states"], r["result"], r["property"], "-", "自分の検査（control は Mut=none の対照、probe は到達の確認で fail が到達、own は自分の写し）"]) + "\n")
