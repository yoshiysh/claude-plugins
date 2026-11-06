from pathlib import Path

OUT = Path(__file__).resolve().parent

A = "design-review-1/answers.txt"
F = "design-v4/files.tsv"
G = "design-v4/agents.tsv"
M = "AGENTS.md"

TRACE = [
    ("FixPurpose,Work,Review", f"{F}:7", "変更は規模を問わず「目的の固定 → 設計 → 設計レビュー → 実装 → 実装レビュー」を通し"),
    ("FixPurpose", f"X1 {A}:24", "規模で分ける（typo 級は PR 本文、それ以外は commit。docs/design/ など）"),
    ("FixPurpose[v4]", f"{F}:12", "置き場は PR から辿れる場所（PR 本文か、PR 本文が指すファイル）"),
    ("FixPurpose,Work", f"{M}:86", "内容の生成・修正・採点を"),
    ("Work", f"W5 {A}:22", "免除せず規模に比例させる（typo なら目的 1 行・設計 1 行・fresh なレビュー 1 体"),
    ("SelfCheckFail,HandleDefect", f"Q5 {A}:6", "作り手が作業中に走らせる検査（hook の make test・作業段階の中の形式検証）で出た、まだレビューに出していないものの欠陥も「設計に戻る」に含める"),
    ("HandleDefect[v4]", f"{F}:12", "見つかった段を問わず（作り手が作業中に走らせる検査を含む）同じに扱う。MEDIUM 以上は設計に戻り、LOW は直さず PR 本文に載せて追わない"),
    ("HandleEnvR", f"Q10 {A}:11", "作り手が原因を除いて同じ検査をその場でやり直す（設計に戻らない）"),
    ("HandleEnvU", f"Q9 {A}:10", "報告して止める（失敗と理由を利用者に報告して止める。人間ゲート以外では止めないの止まってよい場所にこの場合を含める）"),
    ("Review,AssignSev", f"{M}:76", "自分が書いた成果物・修正に自分で合格判定を出さず"),
    ("AssignSev[v4]", f"{G}:2", "要素ごとに keep / cut / shrink と、対応する目的の文（path:line）"),
    ("AssignSev", f"{G}:9", "問題を file:line・誤り・重大度で"),
    ("Triage", f"W4 {A}:21", "MEDIUM 以上は設計に戻し、LOW は直さず PR 本文に載せて追わない。回数の上限は置かない"),
    ("Triage,BotReview,HumanComment", f"X3 {A}:26", "人の指摘は重大度を問わず直す（LOW を追わないのは agent と bot の指摘に限る）"),
    ("Triage[v4]", f"{F}:7", "MEDIUM 以上の欠陥は、見つかった段を問わず成果物を直接直さずに設計へ戻り、LOW は直さず PR 本文に載せる"),
    ("Triage", f"{M}:90", "どの段を次に走らせるか（段の選択）は司令塔の仕事に含む（内容の生成・修正・採点ではない）"),
    ("HumanMerge,Done", f"X2 {A}:25", "マージが公開（登録まで進めて PR を出し、マージを人間が行う）"),
    ("PubApprove[v4],HandleEnvU[v4]", f"{F}:7", "止まってよいのは人間ゲート（マージ・公開）と、作り手が除けない失敗を理由とともに利用者へ報告するときだけ"),
    ("Done", f"{M}:70", "人間ゲート（マージ・公開）以外では止めない。"),
]

T = [
    ("purpose", "FixPurpose", "-", "design（place=規模で決まる置き場）", "maker", "X1・files.tsv:7・AGENTS.md:86"),
    ("design", "Work（作業と自己検査が成功）", "chk=idle", "dreview", "maker", "files.tsv:7"),
    ("design", "SelfCheckFail", "chk=idle・欠陥 latent か envLeft>0", "design（chk=defect/envR/envU）", "maker", "Q5・Q9・Q10"),
    ("impl", "Work", "chk=idle", "ireview", "maker", "files.tsv:7"),
    ("impl", "SelfCheckFail", "chk=idle・欠陥 latent か envLeft>0", "impl（chk=defect/envR/envU）", "maker", "Q5・Q9・Q10"),
    ("design|impl", "HandleDefect", "chk=defect", "design（欠陥を fixed）", "orch", "Q5"),
    ("design|impl", "HandleDefect[v4]", "chk=defect", "同じ段（LOW として PR 本文へ）か design（非決定）", "orch", "files.tsv:12（4）"),
    ("design|impl", "HandleEnvR", "chk=envR", "同じ段（同じ検査をやり直す）", "maker", "Q10"),
    ("design|impl", "HandleEnvU", "chk=envU", "reported", "orch", "Q9"),
    ("dreview", "Review", "-", "dtriage（指摘は重大度なし）", "reviewer", "AGENTS.md:76"),
    ("ireview", "Review", "-", "itriage", "reviewer", "AGENTS.md:76"),
    ("*triage", "AssignSev", "重大度の無い指摘がある", "同じ段（その指摘に重大度）", "reviewer（v4 の dtriage・htriage は未定で orch）", "agents.tsv:2-9・V1"),
    ("*triage", "Triage", "全ての指摘に重大度（v4 の dtriage・htriage は無くても可）", "MED（agent・bot）か人の指摘があれば design、無ければ次の段。LOW は PR 本文（PR が無ければ held: HoldLow）", "orch", "W4・X3・AGENTS.md:90"),
    ("dtriage", "Triage（通過）", "直す指摘が無い", "impl（drOK）", "orch", "W4"),
    ("itriage", "Triage（通過）", "直す指摘が無い", "prbot（irOK・PR を ready に）。v4 は pubgate も", "orch", "W4・X2・files.tsv:7（7）"),
    ("ptriage", "Triage（通過）", "直す指摘が無い", "gate", "orch", "W4"),
    ("htriage", "Triage", "-", "design（決定）。v4 は LOW なら gate", "orch", "X3・files.tsv:7（B）"),
    ("prbot", "BotReview", "-", "ptriage", "bot", "X3"),
    ("pubgate", "PubApprove[v4]", "-", "prbot", "human", "files.tsv:7（7）・V16"),
    ("gate", "HumanComment", "未指摘の未修正の欠陥がある", "htriage", "human", "X3"),
    ("gate", "HumanMerge", "-", "merged", "human", "X2"),
    ("merged|reported", "Done", "-", "同じ（終端）", "-", "X2・Q9"),
]

Q = [
    ("FQ1", "purpose", "FixPurpose", "X1 は typo 級の成果物を PR 本文に置くが、目的の固定の時点で PR が無い（decided_P16 が反例）。draft PR を最初に作ると P16 は通るが、「実装レビューを通らずに PR を出さない」を draft を含めて読むと破れる（decidedOpt_P4D が反例）",
     "(a) typo 級は目的の固定で draft PR を作り、「PR を出す」を ready にすることと定義する / (b) PR を作るまで作業ツリー外の下書きに持ち、PR 作成時に本文へ写す / (c) typo 級も commit に置く（X1 の変更）",
     "(a)。X1 を変えずに置き場が最初からあり、P4 は ready で読めば保たれる。定義の 1 行が要る"),
    ("FQ2", "dtriage", "Triage（LOW）", "W4 は LOW を PR 本文に載せるが、設計レビューの LOW は PR より前に出る（decided_P17 が反例）",
     "(a) PR を作るまで保留し、PR 作成時に本文へ載せる（HoldLow。decidedOpt_P17 は通過） / (b) 設計文書（commit）に載せる / (c) 最初に draft PR を作る（FQ1 (a) と組）",
     "(a)。W4 の「PR 本文」を変えずに済む。保留の置き場は FQ1 と同じ決め方にする"),
    ("FQ3", "*triage", "AssignSev", "決定は「司令塔でない」までで、重大度を付ける者と、設計段の指摘に当てる尺度（REVIEW.md「重大度」は PR の欠陥の表）が決まっていない（V1）。模型では指摘を出したレビュー役が付けると仮定した",
     "(a) 指摘を出したレビュー役が出力に重大度を付ける（設計段の尺度を REVIEW.md に足す） / (b) 重大度を付ける専用の agent を 1 体置く / (c) 尺度だけ決め、付けるのは決定的な規則（script）",
     "(a)。体数が増えず、P1・P2・P13 が保たれる"),
    ("FQ4", "design|impl", "SelfCheckFail", "自己検査の失敗を成果物の欠陥／除ける環境／除けない環境に分けるのは作り手で、記録もレビューも無い（V7）。誤分類すると Q5 の設計への戻りを Q10 のやり直しで迂回できる。模型は分類を合否と扱っていない（やり直しの検査が合否を決める）",
     "(a) 作り手が分類し、分類と理由を成果物の置き場（X1）に記録して次のレビューが見る / (b) 分類を別の agent に振る / (c) 環境の原因の閉集合を script で判定する",
     "(a)。止まらずに済み、生成者の判定が次のレビューで検証される"),
    ("FQ5", "purpose|design", "FixPurpose・Work", "目的と設計を書く担い手（builder 役か、既存スキルが段を兼ねるか、typo で司令塔が直してよいか）が決まっていない（V8）。模型は作り手（maker）と仮定した",
     "(a) 規模を問わず builder 役の agent が書く / (b) 既存の multi-agent スキルが段を兼ねるときはそのスキルの生成役が書く / (c) typo 級は司令塔が書く",
     "(a)。(c) は作業ルール (11) に反し、P13 の前提（生成者とレビュー役が別）を崩す"),
    ("FQ6", "prbot|gate", "BotReview・HumanComment", "bot の指摘の重大度の出どころと、bot のレビューと人間ゲートの順序が決まっていない。模型は bot の後に人間ゲート、bot の指摘の重大度はレビュー役が付けると仮定した（並行にすると P12 の担い手が 1 つに決まらない）",
     "(a) bot のレビューの振り分けが済んでから人間ゲートに入る。重大度はレビュー役が付け直す / (b) bot が付けた重大度をそのまま使う / (c) bot と人を並行に扱う",
     "(a)。止まった状態の次の担い手が人だけに決まる"),
    ("FQ7", "htriage", "Triage（人の指摘）", "X3 は人の指摘を直すと決めたが、経路（設計に戻るか、その場で直すか）と、人の指摘にも重大度を付けるか（P1 の対象か）が決まっていない。模型は設計に戻り、重大度はレビュー役が付けると仮定した",
     "(a) 重大度を問わず設計に戻る。重大度は記録のためにだけ付ける / (b) 重大度を付けず設計に戻る（P1 の対象から人の指摘を外すと明記） / (c) LOW 相当はその場で直す",
     "(b)。X3 で重大度は経路に効かず、付ける手間に得るものが無い。(c) は「成果物を直接直さない」に反する"),
    ("FQ8", "design|impl", "HandleDefect", "自己検査の結果は重大度を持たない（make test は合否だけ）。Q5 で設計に戻ると決めたが、「全ての指摘に重大度」の対象かが決まっていない。模型は対象外とした（v4 はここを重大度で振り分けて P8 が破れる）",
     "(a) 自己検査の失敗は指摘ではなく、重大度を問わず設計に戻すと明記する / (b) 自己検査の失敗にも重大度を付けて W4 を当てる",
     "(a)。Q5 の決定と一致し、付ける者の問題（FQ3）を持ち込まない"),
]

NOTES = {
    "decided_P16": "決定から一意に導けない: FQ1",
    "decided_P17": "決定から一意に導けない: FQ2",
    "decidedOpt_P16": "DraftForTypo=TRUE（FQ1 (a)）で通過",
    "decidedOpt_P17": "HoldLow=TRUE（FQ2 (a)）で通過",
    "decidedOpt_P4D": "FQ1 (a) の draft PR は実装レビュー前に PR を作る。「出す」を ready と定義する必要（FQ1）",
    "decidedOpt_P4": "FQ1 (a) でも ready の PR は実装レビューの後だけ",
    "decidedOpt_P14": "両案を入れても終端に到達",
    "v4_P1": "未定ゆえ非決定: 設計段の 6 体の出力に重大度が無い（agents.tsv:2-8・V1）",
    "v4_P2": "未定ゆえ非決定: 付ける者が無く、付けるなら残る担い手は司令塔（V1）",
    "v4_P5": "未定ゆえ非決定: 重大度の無い MEDIUM が LOW として通る（V1）",
    "v4_P6": "未定ゆえ非決定: 重大度の無い LOW が MEDIUM として設計に戻される（V1）",
    "v4_P7": "明示: files.tsv:7 (B) は人の指摘にも W4 を当てる。X3 は v4 より後の決定で予期どおり",
    "v4_P8": "明示と未定: files.tsv:12 (4) は自己検査も重大度で振り分けるが make test は重大度を出さない（FQ8）",
    "v4_P11": "未定ゆえ非決定: files.tsv:7 (7) の「マージ・公開」で登録の前が停止点になりうる（V16）。X2 は v4 より後の決定で予期どおり",
    "v4_P15": "明示: files.tsv:12 (1) の置き場は規模で分かれない。X1 は v4 より後の決定で予期どおり",
    "v4_P16": "明示: 目的の置き場が PR から辿れる場所だが作業の最初に PR が無い（V7）",
    "v4_P17": "明示: 設計段の LOW も PR 本文に載せるが PR が無い（V7・FQ2）",
}


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
        note = NOTES.get(check, "")
        if check.startswith("mut_"):
            note = "変異を検出（狙いの性質で破れた）" if result == "fail" and "NOT TARGET" not in what else "変異を検出できず"
        note = "; ".join(x for x in [what, note] if x)
        rows.append((check, cfg, states, result, cex, note))
    w("results.tsv", ["check", "cfg", "states", "result", "cex", "note"], rows)


main()
