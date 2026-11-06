import csv
from pathlib import Path

OUT = Path(__file__).resolve().parent
RULES = OUT.parent / "design-v6" / "rules.tsv"


def headings():
    with open(RULES) as f:
        rows = list(csv.reader(f, delimiter="\t"))
    return {r[0].split(":")[0].split(" ")[0]: r[0].split(":")[0] for r in rows[1:] if r[0].startswith("WF-")}


TRACE = {
    "WF-01": ("FixPurpose", ""),
    "WF-02": ("FixPurpose,Review,Triage", "判定は FixPurpose、確かめは設計レビューの Review、誤りは重大度なしで Triage が設計へ戻す"),
    "WF-03": ("Work", ""),
    "WF-04": ("Work", ""),
    "WF-05": ("SelfCheckFail", ""),
    "WF-06": ("Classify", ""),
    "WF-07": ("HandleDefect", ""),
    "WF-08": ("HandleEnvR", ""),
    "WF-09": ("HandleEnvU", "再開（新しい作業として目的の固定から）は模型の外。reported は終端"),
    "WF-10": ("DraftHuman,DraftBot,Triage", "受け箱は inbox。dtriage・itriage の Triage が加える"),
    "WF-11": ("Review", ""),
    "WF-12": ("Review", "ready の後の差分を diff-verifier が見ることは reviewer に畳む"),
    "WF-13": ("AssignSev,Recount", "数の照合は Recount（壊れた重大度を同じ入力でやり直す）"),
    "WF-14": ("Triage", "dtriage・itriage"),
    "WF-15": ("Wake,BotReview", "Wake は ready の後の作り直しの後の close・reopen。run の完了は BotReview の後に ptriage へ進むことで表す"),
    "WF-16": ("Triage", "ptriage"),
    "WF-17": ("HumanComment,HumanMerge", ""),
    "WF-18": ("Triage", "htriage"),
    "WF-19": ("ReworkHuman,Triage", "受け箱は inboxR。bot は push では走らない（WF-15）ので人だけ"),
    "WF-20": ("Done", "Done は NonDone の外の終端の足踏み"),
    "WF-21": ("Triage", "LOW の行き先（logged）だけ。reviews/ の保存と範囲と限界の記録は模型の外"),
    "WF-22": ("SelfCheckFail", "模型の実行は作り手の検査の中身。置き場・README・trace の照合は模型の外"),
}

T = [
    ("purpose", "FixPurpose", "-", "design（draft PR を作る。規模を判じ、置き場は typo 級が PR 本文、それ以外は commit。判定は誤りうる）", "builder", "X1・Y1・answers.txt:37"),
    ("design", "Work", "chk=idle", "dreview（直した欠陥を持ち込み直すことがある: F1）", "builder", "D1"),
    ("impl", "Work", "chk=idle", "ireview（同上）", "builder", "D1"),
    ("design|impl", "SelfCheckFail", "chk=idle", "同じ段（chk=fail）。直していない欠陥は PR 本文に載っていても再び落ちる", "builder", "Q5"),
    ("design|impl", "Classify", "chk=fail", "同じ段（欠陥・除ける環境・除けない環境に分類。誤りうる: F5。環境と判じたら分類と理由を記録）", "builder", "Y3"),
    ("design|impl", "HandleDefect", "分類=欠陥", "design（重大度を付けない）", "orch", "Q5・answers.txt:42"),
    ("design|impl", "HandleEnvR", "分類=除ける環境", "同じ段（同じ検査をやり直す。真の原因が欠陥なら覆われて通るか再び落ちる）", "builder", "Q10"),
    ("design|impl", "HandleEnvU", "分類=除けない環境", "reported（記録した分類と理由を利用者に報告）", "orch", "Q9・Y3"),
    ("design〜itriage（PR が draft）", "DraftHuman", "PR が draft", "同じ段（受け箱 inbox に入る）", "human", "Z3"),
    ("design〜itriage（PR が draft）", "DraftBot", "PR が draft", "同じ段（bot の重大度つきで inbox に入る）", "bot", "Z3・Y4"),
    ("design〜itriage（ready の後の戻り）", "ReworkHuman", "PR が ready", "同じ段（受け箱 inboxR に入る。bot は push では走らないので人だけ）", "human", "AA4"),
    ("dreview", "Review", "-", "dtriage（記録を読み誤分類で残った欠陥を自己検査の指摘にし、規模の判定の誤りを規模の指摘にする。誤検出もありうる: F8）", "reviewer", "AGENTS.md:76・Y3・集約役の導出"),
    ("ireview", "Review", "-", "itriage（記録を読む）", "reviewer", "AGENTS.md:76・Y3"),
    ("dtriage|itriage|ptriage|htriage", "AssignSev", "重大度の無い agent の指摘がある", "同じ段（その指摘に重大度。付け間違いうる: Z1）", "sevagent", "Y2・answers.txt:42"),
    ("dtriage", "Triage", "agent の指摘に 4 値の重大度", "受け箱 2 つも加え、MEDIUM の agent・bot の指摘、自己検査・人・規模の指摘のどれかがあれば design。無ければ impl。LOW は PR 本文", "orch", "D1・W4・X3・Q5・Z3・AA4"),
    ("itriage", "Triage", "同上", "戻りは design（draft に戻さない）。無ければ、初めてなら prbot（PR を ready に）、ready の後の戻りなら wake", "orch", "D1・W4・Y1・AA2・answers.txt:42"),
    ("wake", "Wake", "-", "prbot（close・reopen で bot を起こし、run の完了を待つ）", "orch", "AA2"),
    ("prbot", "BotReview", "-", "ptriage（bot が重大度を付ける）", "bot", "Y4"),
    ("ptriage", "Triage", "-", "MEDIUM の bot の指摘があれば design。無ければ gate。LOW は PR 本文", "orch", "W4・Y4"),
    ("gate", "HumanComment", "未修正の欠陥がある（PR 本文の LOW を含む: Z1）", "htriage", "human", "X3・Z1"),
    ("gate", "HumanMerge", "-", "merged", "human", "X2"),
    ("htriage", "Triage", "-", "design（重大度を付けず、問わず）", "orch", "X3・D1・answers.txt:42"),
    ("wake|prbot|ptriage（ready・bot の run の間）", "人の指摘", "?", "?（FQ1）", "human", "AA4 は戻りの間だけ、Z3 は draft の間だけを決める"),
    ("merged|reported", "Done", "-", "同じ（終端）", "-", "X2・Q9"),
]

Q = [
    ("FQ1", "wake|prbot|ptriage", "人の指摘", "PR が ready で、bot の run を待っている間（作り直しでも人間ゲートでもない）に来た人の指摘の扱いが決まっていない。Z3 は draft の間、AA4 は ready の後に設計へ戻った間だけを決める。模型はこの間の人の指摘を持たない",
     "(a) bot の指摘の振り分け（ptriage）に加え、同じ規則で扱う / (b) 人間ゲートまで待たせる",
     "(a)。作業中に来た指摘を次の振り分けに加える Z3・AA4 と同じ形になり、規則が 1 つで済む"),
]

NOTES = {
    "decided_I1": "残るリスク（Z1 で受容）: 付け間違えた真の MEDIUM が LOW として PR 本文に載ったままマージされうる",
    "decidedNoSevErr_I1": "付け間違いが無ければ通る",
    "decided_I2": "残るリスク: 欠陥を除けない環境と誤分類すると止まる。分類と理由は報告に載る（Y3）",
    "decidedNoMis_I2": "誤分類が無ければ通る",
    "decided_I4": "残るリスク: 見逃された真の MEDIUM はマージに届く（見なかったもの）",
    "decidedBadSev_P11": "決定には重大度の返り値が壊れたときの扱いが無く、振り分けが進めず止まる。v6 の WF-13 の数の照合（Recount）で除かれる（v6_P11・v6_P14 は BadBudget=1 で通過）",
    "assume_F1off_P14": "残るリスク（Z2）: 修正が欠陥を持ち込み続けると終わらない",
    "assume_F2off_P14": "残るリスク（Z2）: 環境の失敗が続くと終わらない",
    "assume_F5off_P14": "残るリスク（Z2）: 誤分類が続くと終わらない",
    "assume_F8off_P14": "残るリスク（Z2）: 誤検出が続くと終わらない",
    "assume_F6off_P8": "残るリスク（Z2）: 記録を読んだレビュー役が誤分類を見落とすと、自己検査の欠陥が ready まで残る",
    "v6_I1": "decided と同じ残るリスク（Z1）",
    "v6_I2": "decided と同じ残るリスク",
    "v6_I4": "decided と同じ残るリスク（見逃し）",
    "v6NoWF19_P16": "WF-19 が未決だった版の rules.tsv では、ready の後の戻りの間に来た人の指摘が振り分けられず PR の段に持ち越される。今の rules.tsv（WF-19 あり）では v6_P16 が通る",
    "v6_assume_F9off_P14": "残るリスク: 重大度の返り値が壊れ続けると WF-13 のやり直しが終わらない（合うまで振り分けない）",
}

KIND = {"P": "性質（決定）", "C": "実行可能性の制約", "I": "残るリスクの測定"}


def w(name, header, rows):
    with open(OUT / name, "w") as f:
        f.write("\t".join(header) + "\n")
        for r in rows:
            f.write("\t".join(r) + "\n")


def main():
    h = headings()
    w("trace.tsv", ["wf", "actions", "note"],
      [(h[k], a, n) for k, (a, n) in sorted(TRACE.items())])
    w("table.tsv", ["state", "event", "guard", "next", "actor", "source"], T)
    w("questions.tsv", ["qid", "state", "event", "problem", "options", "recommend"], Q)
    rows = []
    for line in (OUT / "results.raw.tsv").read_text().splitlines():
        check, cfg, states, result, cex, what = (line.split("\t") + [""] * 6)[:6]
        prop = check.rsplit("_", 1)[1]
        note = NOTES.get(check, "")
        if check.startswith("mut_"):
            note = "変異を検出（狙いの性質で破れた）" if result == "fail" and "NOT TARGET" not in what else "変異を検出できず"
        kind = "仮定を外した版" if "assume_" in check else KIND[prop[0]]
        note = "; ".join(x for x in [kind, what, note] if x)
        rows.append((check, cfg, states, result, cex, note))
    w("results.tsv", ["check", "cfg", "states", "result", "cex", "note"], rows)


main()
