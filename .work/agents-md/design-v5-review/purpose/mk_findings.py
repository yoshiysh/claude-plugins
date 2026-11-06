import csv, sys, os
R = "/Users/yoshi/github/yoshiysh/claude-plugins/.claude/worktrees/skill-update-generic-design-720616"
V = R + "/.work/agents-md/design-v5-review/views/"
PU = ".work/agents-md/design-v3/purpose.txt"
AN = ".work/agents-md/design-review-1/answers.txt"
VW = ".work/agents-md/design-v5-review/views/"
pu = open(R+"/"+PU).read().splitlines()
an = open(R+"/"+AN).read().splitlines()
E = {
 "F1": (4, "作業が目的を見失って膨らむこと"),
 "F2": (5, "検証が同じ観点に偏ること"),
 "F3": (6, "深い規範・経緯の実測・人が行う install の手順・重複が混ざっている"),
 "A1": (9, "作業の流れを規範にする"),
 "A1r": (9, "設計と設計レビューは「根本原因の除去」を規範とする"),
 "A1f": (9, "形式検証は要求・仕様・実装の全てに掛ける"),
 "A2": (10, "AGENTS.md を約 100 行の地図にする"),
 "A2c": (10, "正本は docs/ の構造化した文書・スキル・script・agent 定義に置く"),
 "A2p": (10, "何を AGENTS.md に置くかの基準も、それ自体を正本の 1 つとして置く"),
 "A3": (11, "多角的なレビュー観点を agent として定義する"),
 "A3m": (11, "どの段でどの観点を当てるかを 1 か所に置く"),
}
A = {
 "D1": (2, "検証で欠陥が出たら、指摘を直接直さず設計に戻ってから実装する"),
 "D2": (3, "解決は常に根本原因の除去を目指す"),
 "Q5": (11, "まだレビューに出していないものの欠陥も「設計に戻る」に含める"),
 "Q8": (14, "Codex の hooks をいったん削除し"),
 "Q9": (15, "報告して止める"),
 "Q10": (16, "作り手が原因を除いて同じ検査をその場でやり直す"),
 "V2": (19, "「現在の実体」「作業ルール」の見出しの名前を残す"),
 "V3": (20, "そのまま残し、段の対応表に ready 後の差分の役として載せる"),
 "V5": (22, "正本が docs 側にあって重複しても AGENTS.md に含める"),
 "W1": (24, "review-lenses.md に Codex での立て方を 1 行だけ"),
 "W4": (26, "重大度の閾値だけ置く"),
 "W5": (27, "免除せず規模に比例させる"),
 "X1": (29, "規模で分ける"),
 "X2": (30, "マージが公開"),
 "X3": (31, "人の指摘は重大度を問わず直す"),
 "Y1": (33, "目的を固定した時点で draft PR を作り"),
 "Y2": (34, "重大度を付ける専用の agent を 1 体置く"),
 "Y3": (35, "作り手が分類と理由を成果物の置き場に記録し"),
 "Y4": (36, "bot が付けた重大度をそのまま使う"),
 "Z1": (39, "リスクとして受け入れる"),
 "Z2": (40, "仮定とリスクを PR 本文の範囲と限界に記録する"),
 "Z3": (41, "その段のレビューの後の振り分けに加え、同じ規則で扱う"),
}
def ev(k):
    if k in E:
        ln, q = E[k]; assert q in pu[ln-1], k; return f"{PU}:{ln}", q
    ln, q = A[k]; assert q in an[ln-1], k; return f"{AN}:{ln}", q
def rows(fn):
    with open(V+fn) as f:
        r = list(csv.reader(f, delimiter="\t"))
    return r
out = []
def ok(ref, keys, why):
    refs, qs = zip(*[ev(k) for k in keys])
    out.append([ref, "ok", "-", f"keep（{'・'.join(keys)}）: {why}", " / ".join(refs), " / ".join(qs)])
def ng(ref, sev, why, eref, q):
    out.append([ref, "ng", sev, why, eref, q])

F = rows("files.decisions.tsv")
fmap = {
 2: (["A2c","F3"], "新しい本文に作業用の参照を持ち込まず、規則に壊れるものを添える書き方。入口を重くしない条件"),
 3: (["A2","F3"], "235 行を約 72 行の地図にする本体"),
 4: (["A2","A2p"], "地図であることと置き場の基準への入口"),
 5: (["A2"], "逐語のまま残す（追加なし）"),
 6: (["A2","F3","V2"], "既存の規則を残して縮め、テストの置き場を docs へ出す（追加でなく移動）"),
 7: (["A2","F3"], "既存の下位節を 1 文に縮める"),
 8: (["A1","A1r","A1f","V5","A2"], "抜粋 A〜C は V5 の 3 項目（目的の固定・生成後のレビュー・形式検証）で、(1)〜(15) は既存の規則の持ち越しと Q9 の止まってよい場所・観点の規則"),
 9: (["A2","A2c"], "場面から正本を引く地図そのもの"),
 10: (["A2","F3","Q8"], "検証の節を縮め、hook の記述を外す"),
 11: (["A2"], "既存のまま"),
 12: (["F3","A2"], "install の手順・重複を入口から外す"),
 13: (["A1","A1r","A1f","D1","W4","W5","X1","Y1","Y3","Z3"], "作業の流れの正本。各節は利用者の決定に対応する"),
 14: (["A3","A3m","F2","V3","W1"], "段と観点の対応を 1 か所に置く"),
 15: (["A2p"], "置き場の基準を正本として置く"),
 16: (["A2c"], "ガイドラインの一覧に新しい正本を載せる"),
 17: (["F3","A2c"], "AGENTS.md から出す検証コマンド・テストの置き場の受け皿"),
 18: (["A2c"], "変更なしの確認"),
 19: (["A2c"], "変更なしの確認"),
 21: (["A2c"], "REVIEW.md の表の変更に追従する期待値（593 の §3 は別行で扱う）"),
 22: (["V5","F3"], "V5 で生じる写しが古くならないことの照合（古い写しが残る失敗への対処）"),
 23: (["F3","A2c"], "人が行う install と開発環境の手順の受け皿"),
 24: (["A3","F2"], "「目的に要るか」の死角を埋める観点"),
 25: (["A3","F2"], "「変更自体が要るか」の死角を埋める観点"),
 26: (["A3","F2"], "「AGENTS.md に置くべきか」の死角を埋める観点"),
 27: (["A3","F1"], "費用対効果で膨らみを抑える観点"),
 28: (["A3","A1f","Y3","W5"], "形式検証・作り手の記録・typo 級の判定を見る観点"),
 29: (["A3"], "多角的な観点の 1 つ（初見の読み手）"),
 31: (["V3"], "変更なしの確認"),
 32: (["Q8"], "hook の削除"),
 33: (["A2c"], "移動に伴う参照の付け替え"),
 34: (["A2c"], "変更なしの確認"),
 35: (["A2c"], "変更なしの確認"),
}
for i, row in enumerate(F, start=1):
    if i == 1: continue
    ref = f"files.tsv:{row[0]}"
    if i in fmap:
        ok(ref, *fmap[i])
    elif i == 20:
        ok(ref+"（(1)〜(4)・(6)〜(8)）", ["A2c","A2p","Y2","W4"], "参照の付け替え・placement.md の適用・設計段の重大度（severity-assigner が設計段で使う尺度）")
        ng(ref+"（(5)）", "低", "shrink: .claude/agents/*.md の行を足すことはどの目的の項目も求めていない。段と観点の対応の 1 か所は review-lenses.md で足り（A3）、この行の追加が tests/repo-review-workflow.test.mjs の 593 行の §3 の追加を連れてくる", f"{VW}files.decisions.tsv:20", "(5)行を足す:.claude/agents/*.md→docs/guidelines/review-lenses.mdとbest-practices.md§3「Sub-agent設計」")
    elif i == 30:
        ok(ref+"（agent 自体）", ["Y2"], "重大度を付ける専用の agent")
        ng(ref+"（本文の「指摘」の節）", "低", "shrink: 共通の書式をそのまま当て、severity-assigner 自身に severity-assigner への入力となる「指摘」の節を持たせている。この agent は指摘を足さず重大度を付けるだけなので、この節はどの目的にも対応しない", f"{VW}files.decisions.tsv:30", "出力の末尾の「指摘」の節（file:line・何が誤りか。重大度を付けない）をseverity-assignerへの入力の形として固定する")
    else:
        print("unmapped files row", i, row[0], file=sys.stderr); sys.exit(1)
ng("files.tsv:tests/repo-review-workflow.test.mjs（593 行の §3）", "低", "shrink: REVIEW.md (5) の行の追加に連れて来る期待値の変更。(5) を外せばこの部分も要らない", f"{VW}files.decisions.tsv:21", "593:best-practices.mdの節番号の集合に§3を1つ足す（.claude/agentsの行が§3を挙げる）")

G = rows("agents.decisions.tsv")
gmap = {
 "purpose-auditor": (["F2","A3"], "「目的に要るか」の死角"),
 "alternatives-auditor": (["F2","A3"], "「変更自体が要るか」の死角"),
 "placement-auditor": (["F2","A3","A2p"], "「AGENTS.md に置くべきか」の死角"),
 "risk-auditor": (["A3","F1"], "費用対効果と fail-open の観点"),
 "decision-verifier": (["A3","A1f","Y3"], "決定への適合・形式検証・作り手の記録"),
 "reader": (["A3"], "多角的な観点の 1 つ（初見の読み手）"),
 "diff-verifier": (["V3"], "既存のまま対応表に載せる"),
 "severity-assigner": (["Y2"], "重大度を付ける専用の agent"),
 "make test": (["A3m"], "agent にしない検査を表に置くだけ"),
}
for row in G[1:]:
    k = next(k for k in gmap if row[0].startswith(k))
    ok(f"agents.tsv:{row[0]}", *gmap[k])

Rr = rows("rules.decisions.tsv")
rmap = {
 2: ["A1","F1","Y1"], 3: ["W5","X1"], 4: ["A1"], 5: ["A1","A1f"], 6: ["Q5"], 7: ["Y3"], 8: ["Q5","D1"],
 9: ["Q10"], 10: ["Q9"], 11: ["A1","A3","A3m","Y3"], 12: ["A1","V3"], 13: ["Y2"], 14: ["W4","D1"],
 15: ["W4","Y1"], 16: ["Y4"], 17: ["Y4","W4"], 18: ["X3"], 19: ["X2"], 20: ["X3","D1"], 21: ["Q5"],
 22: ["Z3"], 23: ["Q9","X2"], 24: ["Q9"], 25: ["A1","Y3"], 26: ["A1","F3"], 27: ["W5"], 28: ["F2","A3m"],
 29: ["F2","A3"], 30: ["A1f","F1"], 31: ["A1r","D2"], 32: ["Z1","Z2","W4"], 33: ["A2p"], 34: ["V5","F3"],
 35: ["V5","F3"],
}
why = {
 21: "作り手の検査の指摘を重大度の段に通さないことの明示（足す規則ではない）",
 26: "既存の規則の持ち越しで、模型の振り分けの担い手",
 30: "形式検証の範囲と、表に無い遷移を規則に足さないこと（膨らみの抑止）",
 35: "既存の規則に、V5 の写しのための一致の照合を加える",
}
for i, row in enumerate(Rr, start=1):
    if i == 1: continue
    head = row[0].split("：")[0].split(":")[0][:40]
    ref = f"rules.tsv:{head}"
    if i in rmap:
        ok(ref, rmap[i], why.get(i, "利用者の決定・目的の項目に対応する流れの規則"))
    elif 36 <= i <= 51:
        keys = ["W1"] if i == 51 else ["A2","F3"]
        ok(ref, keys, "Codex での立て方の 1 行" if i == 51 else "既存の規則の持ち越し・移動（新たな追加ではない）")
    else:
        print("unmapped rule", i, file=sys.stderr); sys.exit(1)

with open(os.path.dirname(os.path.abspath(__file__)) + "/findings.tsv", "w") as f:
    w = csv.writer(f, delimiter="\t", lineterminator="\n", quoting=csv.QUOTE_NONE, escapechar="\\")
    w.writerow(["ref","verdict","severity","reason","evidence_ref","evidence_quote"])
    w.writerows(out)
print(len(out), sum(1 for o in out if o[1]=="ok"), sum(1 for o in out if o[1]=="ng"))
