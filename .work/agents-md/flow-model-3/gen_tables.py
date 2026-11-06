from pathlib import Path

OUT = Path(__file__).resolve().parent

A = "design-review-1/answers.txt"
M = "AGENTS.md"
V = "design-v5/rules.tsv"

TRACE = [
    ("Work,Review,Triage", f"D1 {A}:2", "検証で欠陥が出たら、指摘を直接直さず設計に戻ってから実装する"),
    ("FixPurpose", f"X1 {A}:29", "規模で分ける（typo 級は PR 本文、それ以外は commit。docs/design/ など）"),
    ("FixPurpose", f"Y1 {A}:33", "目的を固定した時点で draft PR を作り、その本文に置く"),
    ("Triage", f"Y1 {A}:33", "「実装レビューを通ってから PR を出す」の「出す」は ready にすることと定義する"),
    ("FixPurpose,Work", f"{A}:37", "FQ5 目的と設計を書く担い手は builder 役の agent"),
    ("FixPurpose,Work", f"{M}:99", "生成は builder 役の agent へ dispatch し"),
    ("SelfCheckFail,HandleDefect", f"Q5 {A}:11", "作り手が作業中に走らせる検査（hook の make test・作業段階の中の形式検証）で出た、まだレビューに出していないものの欠陥も「設計に戻る」に含める"),
    ("HandleDefect,SelfCheckFail", f"{A}:42", "自己検査の失敗には重大度を付けず、全て設計に戻す（LOW として載せると合否ゲートで同じ欠陥が再び落ちて往復が終わらない。Q5）"),
    ("Classify,Review", f"Y3 {A}:35", "作り手が分類と理由を成果物の置き場に記録し、次のレビュー（作り手と別の者）が見る"),
    ("HandleEnvR", f"Q10 {A}:16", "作り手が原因を除いて同じ検査をその場でやり直す（設計に戻らない）"),
    ("HandleEnvU", f"Q9 {A}:15", "報告して止める（失敗と理由を利用者に報告して止める。人間ゲート以外では止めないの止まってよい場所にこの場合を含める）"),
    ("Review,AssignSev", f"{M}:76", "自分が書いた成果物・修正に自分で合格判定を出さず"),
    ("AssignSev", f"Y2 {A}:34", "重大度を付ける専用の agent を 1 体置く（推奨のレビュー役ではない）"),
    ("AssignSev,HumanComment", f"{A}:42", "人の指摘には重大度を付けない（X3 で経路に効かない）"),
    ("BotReview,DraftBot", f"Y4 {A}:36", "bot が付けた重大度をそのまま使う（順序は bot の振り分けの後に人間ゲート）"),
    ("DraftHuman,DraftBot,Triage", f"Z3 {A}:41", "その段のレビューの後の振り分けに加え、同じ規則で扱う"),
    ("Triage", f"W4 {A}:26", "MEDIUM 以上は設計に戻し、LOW は直さず PR 本文に載せて追わない。回数の上限は置かない"),
    ("Triage,HumanComment", f"X3 {A}:31", "人の指摘は重大度を問わず直す（LOW を追わないのは agent と bot の指摘に限る）"),
    ("Triage", f"{A}:42", "FQ1 ready の後に設計へ戻るとき PR を draft に戻さない"),
    ("Triage", f"{M}:90", "どの段を次に走らせるか（段の選択）は司令塔の仕事に含む（内容の生成・修正・採点ではない）"),
    ("HumanMerge,Done", f"X2 {A}:30", "マージが公開（登録まで進めて PR を出し、マージを人間が行う）"),
    ("Done", f"{M}:70", "人間ゲート（マージ・公開）以外では止めない。"),
    ("HumanComment", f"Z1 {A}:39", "PR 本文の LOW をマージの前に人が読むことで拾う。読み落とせば届く"),
    ("Work,Review", f"Z2 {A}:40", "回数の上限を置かず、仮定とリスクを PR 本文の範囲と限界に記録する（W4 を維持）"),
    ("FixPurpose[v5],Review[v5]", f"{V}:3", "作り手の判定は、設計レビューで decision-verifier が当たるかを確かめ、外れていれば指摘として出す"),
    ("AssignSev[v5]", f"{V}:13", "観点の agent の返り値の「指摘」の節にだけ、専用の severity-assigner が REVIEW.md「重大度」の尺度で重大度を付ける"),
]

T = [
    ("purpose", "FixPurpose", "-", "design（draft PR を作る。置き場は typo 級が PR 本文、それ以外は commit）", "builder", "X1・Y1・answers.txt:37"),
    ("design", "Work", "chk=idle", "dreview（直した欠陥を持ち込み直すことがある: F1）", "builder", "D1"),
    ("impl", "Work", "chk=idle", "ireview（同上）", "builder", "D1"),
    ("design|impl", "SelfCheckFail", "chk=idle", "同じ段（chk=fail）。直していない欠陥は PR 本文に載っていても再び落ちる", "builder", "Q5"),
    ("design|impl", "Classify", "chk=fail", "同じ段（欠陥・除ける環境・除けない環境に分類。誤りうる: F5。環境と判じたら分類と理由を記録）", "builder", "Y3"),
    ("design|impl", "HandleDefect", "分類=欠陥", "design（重大度を付けない。真の原因が欠陥ならその欠陥を直す）", "orch", "Q5・answers.txt:42"),
    ("design|impl", "HandleEnvR", "分類=除ける環境", "同じ段（同じ検査をやり直す。真の原因が欠陥なら覆われて通るか再び落ちる）", "builder", "Q10"),
    ("design|impl", "HandleEnvU", "分類=除けない環境", "reported（記録した分類と理由を利用者に報告）", "orch", "Q9・Y3"),
    ("design〜itriage（draft の間）", "DraftHuman", "PR が draft", "同じ段（受け箱に入る）", "human", "Z3"),
    ("design〜itriage（draft の間）", "DraftBot", "PR が draft", "同じ段（bot の重大度つきで受け箱に入る）", "bot", "Z3・Y4"),
    ("dreview", "Review", "-", "dtriage（記録を読み、誤分類で残った欠陥を自己検査の指摘にして記録を空にする。誤検出もありうる: F8）", "reviewer", "AGENTS.md:76・Y3"),
    ("ireview", "Review", "-", "itriage（同上）", "reviewer", "AGENTS.md:76・Y3"),
    ("dtriage|itriage|ptriage|htriage", "AssignSev", "重大度の無い agent の指摘がある", "同じ段（その指摘に重大度。付け間違いうる: Z1）", "sevagent", "Y2・answers.txt:42"),
    ("dtriage", "Triage", "agent の指摘に重大度", "受け箱も加え、MEDIUM の agent・bot の指摘、自己検査の指摘、人の指摘のどれかがあれば design。無ければ impl。LOW は PR 本文", "orch", "D1・W4・X3・Q5・Z3"),
    ("itriage", "Triage", "同上", "戻りは design（PR は draft に戻さない）。無ければ prbot（PR を ready に）", "orch", "D1・W4・Y1・answers.txt:42・Z3"),
    ("prbot", "BotReview", "-", "ptriage（bot が重大度を付ける）", "bot", "Y4"),
    ("ptriage", "Triage", "-", "MEDIUM の bot の指摘があれば design。無ければ gate。LOW は PR 本文", "orch", "W4・Y4"),
    ("gate", "HumanComment", "未修正の欠陥がある（PR 本文の LOW を含む: Z1）", "htriage", "human", "X3・Z1"),
    ("gate", "HumanMerge", "-", "merged", "human", "X2"),
    ("htriage", "Triage", "-", "design（重大度を付けず、問わず）", "orch", "X3・D1・answers.txt:42"),
    ("design〜itriage（ready の後の戻り）", "人・bot の指摘", "?", "?（FQ1）", "human・bot", "Z3（draft の間だけを決める）"),
    ("merged|reported", "Done", "-", "同じ（終端）", "-", "X2・Q9"),
]

Q = [
    ("FQ1", "design〜itriage（ready の後に設計へ戻った間）", "人・bot の指摘", "ready の後に設計へ戻っても PR は draft に戻らない（answers.txt:42）。その作業中に来た人・bot の指摘の扱いは Z3（draft の間）の外で、決まっていない。模型はこの間の指摘を持たない",
     "(a) Z3 と同じに、その段のレビューの後の振り分けに加える / (b) 次の人間ゲート・bot の段まで待たせる",
     "(a)。規則が 1 つで済み、PR の状態（draft か ready か）に依らず作業中の指摘を同じに扱える"),
]

NOTES = {
    "decided_I1": "残るリスク（Z1 で受容）: 付け間違えた真の MEDIUM が LOW として PR 本文に載ったままマージされうる",
    "decidedNoSevErr_I1": "付け間違いが無ければ通る（I1 の原因は付け間違いだけ）",
    "decided_I2": "残るリスク: 欠陥を除けない環境と誤分類すると止まる。分類と理由は報告に載る（Y3）",
    "decidedNoMis_I2": "誤分類が無ければ通る",
    "decided_I4": "残るリスク: レビュー・bot・人が見逃した真の MEDIUM はマージに届く（見なかったもの）",
    "assume_F1off_P14": "残るリスク（Z2）: 修正が欠陥を持ち込み続けると終わらない",
    "assume_F2off_P14": "残るリスク（Z2）: 環境の失敗が続くと終わらない",
    "assume_F5off_P14": "残るリスク（Z2）: 誤分類が続くと終わらない",
    "assume_F8off_P14": "残るリスク（Z2）: 誤検出が続くと終わらない（誤検出の MEDIUM は設計に戻すので）",
    "assume_F6off_P8": "残るリスク（Z2）: 記録を読んだレビュー役が誤分類を見落とすと、自己検査の欠陥が ready まで残る",
    "v5NoSevErr_P15": "",
    "v5_assume_F6off_P15": "decision-verifier が規模の判定の誤りを見落とすと、置き場が規模に合わないまま ready になる",
}

KIND = {"P": "性質（決定）", "C": "実行可能性の制約", "I": "残るリスクの測定"}


def w(name, header, rows):
    with open(OUT / name, "w") as f:
        f.write("\t".join(header) + "\n")
        for r in rows:
            f.write("\t".join(r) + "\n")


def main():
    extra = {}
    p = OUT / "notes.extra"
    if p.exists():
        for line in p.read_text().splitlines():
            k, v = line.split("\t", 1)
            extra[k] = v
    w("trace.tsv", ["action", "source", "quote"], TRACE)
    w("table.tsv", ["state", "event", "guard", "next", "actor", "source"], T)
    qs = list(Q)
    qf = OUT / "questions.extra"
    if qf.exists():
        qs += [tuple(l.split("\t")) for l in qf.read_text().splitlines() if l]
    w("questions.tsv", ["qid", "state", "event", "problem", "options", "recommend"], qs)
    rows = []
    for line in (OUT / "results.raw.tsv").read_text().splitlines():
        check, cfg, states, result, cex, what = (line.split("\t") + [""] * 6)[:6]
        prop = check.rsplit("_", 1)[1]
        note = extra.get(check) or NOTES.get(check, "")
        if check.startswith("mut_"):
            note = "変異を検出（狙いの性質で破れた）" if result == "fail" and "NOT TARGET" not in what else "変異を検出できず"
        if check.startswith("assume_") or check.startswith("v5_assume"):
            kind = "仮定を外した版"
        else:
            kind = KIND[prop[0]]
        note = "; ".join(x for x in [kind, what, note] if x)
        rows.append((check, cfg, states, result, cex, note))
    w("results.tsv", ["check", "cfg", "states", "result", "cex", "note"], rows)


main()
