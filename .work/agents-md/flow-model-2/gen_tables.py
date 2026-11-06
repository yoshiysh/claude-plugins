from pathlib import Path

OUT = Path(__file__).resolve().parent

A = "design-review-1/answers.txt"
F = "design-v4/files.tsv"
G = "design-v4/agents.tsv"
M = "AGENTS.md"

TRACE = [
    ("Work,Review,Triage", f"D1 {A}:2", "検証で欠陥が出たら、指摘を直接直さず設計に戻ってから実装する"),
    ("FixPurpose", f"X1 {A}:29", "規模で分ける（typo 級は PR 本文、それ以外は commit。docs/design/ など）"),
    ("FixPurpose", f"Y1 {A}:33", "目的を固定した時点で draft PR を作り、その本文に置く"),
    ("Triage", f"Y1 {A}:33", "「実装レビューを通ってから PR を出す」の「出す」は ready にすることと定義する"),
    ("FixPurpose,Work", f"{A}:37", "FQ5 目的と設計を書く担い手は builder 役の agent"),
    ("FixPurpose,Work", f"{M}:99", "生成は builder 役の agent へ dispatch し"),
    ("SelfCheckFail,HandleDefect", f"Q5 {A}:11", "作り手が作業中に走らせる検査（hook の make test・作業段階の中の形式検証）で出た、まだレビューに出していないものの欠陥も「設計に戻る」に含める"),
    ("Classify,Review", f"Y3 {A}:35", "作り手が分類と理由を成果物の置き場に記録し、次のレビュー（作り手と別の者）が見る"),
    ("HandleEnvR", f"Q10 {A}:16", "作り手が原因を除いて同じ検査をその場でやり直す（設計に戻らない）"),
    ("HandleEnvU", f"Q9 {A}:15", "報告して止める（失敗と理由を利用者に報告して止める。人間ゲート以外では止めないの止まってよい場所にこの場合を含める）"),
    ("Review,AssignSev", f"{M}:76", "自分が書いた成果物・修正に自分で合格判定を出さず"),
    ("AssignSev", f"Y2 {A}:34", "重大度を付ける専用の agent を 1 体置く（推奨のレビュー役ではない）"),
    ("BotReview", f"Y4 {A}:36", "bot が付けた重大度をそのまま使う（順序は bot の振り分けの後に人間ゲート）"),
    ("Triage", f"W4 {A}:26", "MEDIUM 以上は設計に戻し、LOW は直さず PR 本文に載せて追わない。回数の上限は置かない"),
    ("Triage,HumanComment", f"X3 {A}:31", "人の指摘は重大度を問わず直す（LOW を追わないのは agent と bot の指摘に限る）"),
    ("Triage", f"{A}:37", "FQ7 の経路: 人の指摘は設計に戻る（D1）"),
    ("Triage", f"{M}:90", "どの段を次に走らせるか（段の選択）は司令塔の仕事に含む（内容の生成・修正・採点ではない）"),
    ("HumanMerge,Done", f"X2 {A}:30", "マージが公開（登録まで進めて PR を出し、マージを人間が行う）"),
    ("Done", f"{M}:70", "人間ゲート（マージ・公開）以外では止めない。"),
    ("FixPurpose[v4]", f"{F}:12", "置き場は PR から辿れる場所（PR 本文か、PR 本文が指すファイル）"),
    ("HandleDefect[v4]", f"{F}:12", "見つかった段を問わず（作り手が作業中に走らせる検査を含む）同じに扱う。MEDIUM 以上は設計に戻り、LOW は直さず PR 本文に載せて追わない"),
    ("AssignSev[v4]", f"{G}:2", "要素ごとに keep / cut / shrink と、対応する目的の文（path:line）"),
    ("AssignSev[v4]", f"{G}:9", "問題を file:line・誤り・重大度で"),
    ("Triage[v4]", f"{F}:7", "MEDIUM 以上の欠陥は、見つかった段を問わず成果物を直接直さずに設計へ戻り、LOW は直さず PR 本文に載せる"),
    ("PubApprove[v4]", f"{F}:7", "止まってよいのは人間ゲート（マージ・公開）と、作り手が除けない失敗を理由とともに利用者へ報告するときだけ"),
]

T = [
    ("purpose", "FixPurpose", "-", "design（draft PR を作る。置き場は typo 級が PR 本文、それ以外は commit）", "builder", "X1・Y1・answers.txt:37"),
    ("design", "Work", "chk=idle", "dreview（直した欠陥を持ち込み直すことがある: F1）", "builder", "D1"),
    ("impl", "Work", "chk=idle", "ireview（同上）", "builder", "D1"),
    ("design|impl", "SelfCheckFail", "chk=idle", "同じ段（chk=fail。真の原因は欠陥・除ける環境・除けない環境のどれか）", "builder", "Q5・Q9・Q10"),
    ("design|impl", "Classify", "chk=fail", "同じ段（分類 cls。誤りうる: F5。環境と判じたら分類と理由を記録）", "builder", "Y3"),
    ("design|impl", "HandleDefect", "cls=defect・真の原因が欠陥", "striage（自己検査の指摘として振り分ける）", "orch", "Q5・W4・Y2"),
    ("design|impl", "HandleDefect", "cls=defect・真の原因が環境", "design（直すものが無い戻り）", "orch", "Q5"),
    ("design|impl", "HandleEnvR", "cls=envR", "同じ段（原因を除いて同じ検査をやり直す。真の原因が欠陥なら覆われて通ることがある）", "builder", "Q10"),
    ("design|impl", "HandleEnvU", "cls=envU", "reported（記録した分類と理由を利用者に報告）", "orch", "Q9・Y3"),
    ("dreview", "Review", "-", "dtriage（記録を読み、誤分類で残った欠陥を自己検査の指摘にする。記録を空にする）", "reviewer", "AGENTS.md:76・Y3"),
    ("ireview", "Review", "-", "itriage（同上）", "reviewer", "AGENTS.md:76・Y3"),
    ("dtriage|itriage|htriage|striage", "AssignSev", "重大度の無い agent・自己検査・人の指摘がある", "同じ段（その指摘に重大度。誤りうる: SevErr）", "sevagent", "Y2"),
    ("dtriage", "Triage", "bot 以外の全ての指摘に重大度", "MEDIUM の指摘か人の指摘があれば design。無ければ impl。LOW は PR 本文", "orch", "D1・W4・X3"),
    ("itriage", "Triage", "同上", "戻りは design（PR は ready のまま: FQ1）。無ければ prbot（PR を ready に）", "orch", "D1・W4・Y1"),
    ("prbot", "BotReview", "-", "ptriage（bot が重大度を付ける）", "bot", "Y4"),
    ("ptriage", "Triage", "-", "MEDIUM の bot の指摘があれば design。無ければ gate。LOW は PR 本文", "orch", "W4・Y4"),
    ("gate", "HumanComment", "未修正の欠陥がある", "htriage", "human", "X3"),
    ("gate", "HumanMerge", "-", "merged", "human", "X2"),
    ("htriage", "Triage", "重大度が付いている", "design（重大度を問わず）", "orch", "X3・D1"),
    ("striage", "Triage", "重大度が付いている", "MEDIUM なら design。LOW なら PR 本文に載せて元の段（design か impl）に戻る", "orch", "Q5・W4・Y2"),
    ("design〜gate（draft の間を含む）", "HumanComment・BotReview（ready の前）", "?", "?（FQ2）", "human・bot", "X3・Y4"),
    ("merged|reported", "Done", "-", "同じ（終端）", "-", "X2・Q9"),
]

Q = [
    ("FQ1", "design〜ireview（実装レビューの後の戻り）", "Triage（戻り）", "Y1 は「出す」を ready にすることと定義したが、ready の後に人・bot・実装レビューの指摘で設計に戻ったとき、PR を ready のまま直すか draft に戻すかが決まっていない。ready のままだと、実装レビューを通っていない変更が ready の PR に載る（decided_C4 が反例。Redraft=TRUE で通過）",
     "(a) 設計に戻るときに draft に戻し、実装レビューを通ってから ready にし直す / (b) ready のまま直し、「出す」は最初の ready の 1 回だけを指すと定義する",
     "(a)。Y1 の定義を戻りの後にも同じに当てられ、bot と人は実装レビュー済みのものだけを見る。反対側: draft と ready の往復の手間が増え、bot が ready のたびに走る"),
    ("FQ2", "design〜gate", "HumanComment・BotReview", "Y1 で draft PR が最初からあるので、人と bot は ready の前（作業中）にも指摘しうる。模型は人の指摘を gate、bot を ready の後だけに置いた。作業中に来た指摘をいつどう扱うかは決まっていない（X3・D1 は経路を決めるが時機を決めない）",
     "(a) 作業中に来た指摘は次の振り分け（その段のレビューの後）に加え、同じ規則で扱う / (b) 来た時点で今の段を止めて設計に戻る / (c) 人と bot には ready の後だけ指摘を求める",
     "(a)。段の途中で作り手の作業を割らず、振り分けの規則が 1 つで済む。反対側: 指摘への対応が遅れる"),
]

NOTES = {
    "decided_C4": "決定から一意に導けない: FQ1",
    "decidedSelfDesign_C4": "決定から一意に導けない: FQ1",
    "decidedRedraft_C4": "FQ1 (a)（Redraft=TRUE）で通過",
    "decidedRedraft_P4": "FQ1 (a) でも P4 は保たれる",
    "decidedRedraft_P14": "FQ1 (a) でも終端に到達",
    "decided_I1": "残るリスク: 重大度の付け間違い（SevErr）で真の MEDIUM が LOW として PR 本文に載ったままマージされうる。PR 本文に見えるので人の指摘（X3）で直る経路は残るが、強制はされない",
    "decidedNoSevErr_I1": "付け間違いが無ければ I1 は通る（I1 の破れの原因は SevErr だけ）",
    "decided_I2": "残るリスク: 欠陥を除けない環境と誤分類すると報告して止まる。分類と理由は報告に載り（Y3）、利用者が次の読み手になる",
    "decidedNoMis_I2": "誤分類が無ければ I2 は通る",
    "assume_F1off_P14": "F1（修正が欠陥を持ち込むのは有限回）を外すと終端に到達しない。W4 は回数の上限を置かないので、決定のもとでの終了はこの仮定に依る",
    "assume_F2off_P14": "F2（環境の失敗は有限回）を外すと終端に到達しない（除ける環境の失敗のやり直しが続く）",
    "assume_F3off_P14": "F3 は決定どおりの版では要らない: 人の指摘は必ず直る（X3）ので、同じ欠陥を繰り返し指摘する経路が無い",
    "v4_assume_F3off_P14": "v4 では F3 が要る: 人の LOW を直さず PR 本文に載せるので、同じ指摘が繰り返されうる",
    "assume_F5off_P14": "F5（誤分類は有限回）を外すと終端に到達しない（除けない原因や欠陥を除ける環境と判じ続ける）",
    "assume_F6off_P8": "F6（記録を読んだレビュー役が誤分類を見落とさない）を外すと P8 が破れる。Y3 の記録と次のレビューは、読み手が見落とさない限りでだけ効く",
    "v4_P1": "未定ゆえ非決定: 設計段・自己検査・人の指摘に重大度を付ける者が無い（agents.tsv:2-8・V1）",
    "v4_P2": "v4 より後の決定（Y2）。v4 は専用の agent を持たず、実装段は diff-verifier（reviewer）、他は付けるなら司令塔",
    "v4_P5": "通過: 性質は付いた重大度で書くので、重大度の無い指摘は対象外。v4 の欠陥は P1 に出る",
    "v4_P6": "通過: 同上",
    "v4_P7": "明示: files.tsv:7 (B) は人の指摘にも W4 を当てる。X3 は v4 より後の決定",
    "v4_P8": "未定ゆえ非決定: v4 は環境の判定の記録を持たない（V7）ので、誤分類で覆われた欠陥が ready まで残る",
    "v4_P10": "未定: 除けない失敗の報告に分類の記録が無い（Y3 は v4 より後の決定）",
    "v4_P11": "未定ゆえ非決定: (7) の「マージ・公開」で登録の前が停止点になりうる（V16）。X2 は v4 より後の決定",
    "v4_P13": "通過するが空虚な部分あり: v4 に記録が無いので、記録の読みの条件は常に成り立つ。誤分類の影響は P8 に出る",
    "v4_P15": "明示: files.tsv:12 (1) の置き場は規模で分かれない。X1 は v4 より後の決定",
    "v4_C1": "明示: 目的の置き場が PR から辿れる場所だが、作業の最初に PR が無い（V7）",
    "v4_C2": "明示: 設計段の LOW も PR 本文に載せるが PR が無い（V7）",
    "v4_C4": "決定どおりの版と同じ欠落（FQ1）",
}

DECIDED_PREFIX = ("decided_", "decidedSelfDesign_")
KIND = {"P": "性質（決定）", "C": "実行可能性の制約", "I": "残るリスクの測定"}


def w(name, header, rows):
    with open(OUT / name, "w") as f:
        f.write("\t".join(header) + "\n")
        for r in rows:
            f.write("\t".join(r) + "\n")


def main():
    w("trace.tsv", ["action", "source", "quote"], TRACE)
    w("table.tsv", ["state", "event", "guard", "next", "actor", "source"], T)
    w("questions.tsv", ["qid", "state", "event", "problem", "options", "recommend"], Q)
    rows = []
    for line in (OUT / "results.raw.tsv").read_text().splitlines():
        check, cfg, states, result, cex, what = (line.split("\t") + [""] * 6)[:6]
        prop = check.rsplit("_", 1)[1]
        note = NOTES.get(check, "")
        if check.startswith("mut_"):
            note = "変異を検出（狙いの性質で破れた）" if result == "fail" and "NOT TARGET" not in what else "変異を検出できず"
        if check.startswith("decidedSelfDesign_") and not note:
            note = "自己検査の LOW も全て設計に戻す読み（SelfLow=design）"
        note = "; ".join(x for x in [KIND[prop[0]], what, note] if x)
        rows.append((check, cfg, states, result, cex, note))
    w("results.tsv", ["check", "cfg", "states", "result", "cex", "note"], rows)


main()
