from pathlib import Path

OUT = Path(__file__).resolve().parent
M = "flow-model-4/"


def w(name, header, rows):
    with open(OUT / name, "w") as f:
        f.write("\t".join(header) + "\n")
        for r in rows:
            assert len(r) == len(header), (name, r[0])
            f.write("\t".join(r) + "\n")


w("props.tsv", ["property", "decision", "verdict", "reason", "evidence"], [
    ["P1", "W4・Y2・answers.txt:42（自己検査・人に重大度を付けない）・WF-02", "過不足なし",
     "agent の指摘は 4 値、self・human・scale は none を求める。bot は Y4 で自分の値なので P1 の外で P2 が見る。前回の「人にも重大度を求める」強さは消えた",
     M + "Flow.tla:372-374・mut_SevOnHuman_P1"],
    ["P2", "Y2・Y4", "過不足なし", "bot 以外は sevagent、bot は bot", M + "Flow.tla:376-377・mut_OrchSev_P2"],
    ["P3", "D1", "過不足なし", "戻りで drOK=FALSE", M + "Flow.tla:379・mut_SkipDR_P3"],
    ["P4", "D1・Y1", "過不足なし（ただし AA2 の「draft に戻さない」を見る性質が無い）",
     "P4 は ready の前に実装レビューを通ることだけを見る。ready の後に戻るとき PR を draft に戻す変異（own_ReDraft）でも P1〜P17・C1〜C3 が全て通る。AA2・WF-14 の「draft に戻さない」は遷移の書き方だけが守り、性質も変異も無い。足すなら P4R（ready は ready のまま）で、own_ReDraft_P4R が検出する",
     "rerun.tsv:own_ReDraft_all・own_ReDraft_P4R"],
    ["P5", "W4", "過不足なし", "agent・bot の MEDIUM は design かつ fixed。自己検査は重大度を持たなくなったので前回の穴（self の MEDIUM）は P1・P8a に移った",
     M + "Flow.tla:384-386・mut_MedPass_P5"],
    ["P6", "W4", "過不足なし", "LOW は logged、LOW だけでは戻らない。旧 P6inv を外した理由が見出しに記録された",
     M + "Flow.tla:24・390-396・mut_LowFix_P6"],
    ["P7", "X3・D1・AA4・answers.txt:48", "式は過不足なし・注釈は言い過ぎ",
     "式は振り分けに来た人の指摘を見る。注釈「来た時機を問わず」は、模型が wake・prbot・ptriage の間に来る人の指摘を持たないので模型の範囲を超える（導けた答えの時点が欠けている）",
     M + "Flow.tla:397-399・rev.tsv:欠落"],
    ["P8・P8a", "Q5・Y3・answers.txt:42", "過不足なし", "自己検査の欠陥は誤分類されても ready の前に fixed。HandleDefect と self の振り分けは design・fixed",
     M + "Flow.tla:402-405・mut_SelfLowLog_P8・mut_NoRecord_P8"],
    ["P9", "Q10", "過不足なし", "", M + "Flow.tla:407・mut_EnvRToDesign_P9"],
    ["P10", "Q9・Y3", "過不足なし", "「理由」は抽象化で落ちる", M + "Flow.tla:409-410・mut_NoRecord_P10・mut_EnvURetry_P10"],
    ["P11", "X2・Q9・AGENTS.md:70", "過不足なし", "", M + "Flow.tla:411・mut_StuckAfterReview_P11"],
    ["P13", "AGENTS.md:76・Y3", "過不足なし（範囲つき）", "読み手の見落としは F6 で外で測る", M + "Flow.tla:415-416・mut_SelfReview_P13・mut_SkipRecReview_P13"],
    ["P14", "D1・Q9・X2", "過不足なし（仮定つき）",
     "F1・F2・F5・F7・F8・F9 の下で通る。加えて DraftBudget（作業中に来る指摘の数）も終了を支える有限の仮定だが、見出しでは「状態数を抑える抽象化」とだけ書かれ F 一覧に無い（assumptions.tsv）",
     M + "Flow.tla:16-23・418"],
    ["P15", "X1・WF-02", "過不足なし（F6 の規模の半分は測っていない）",
     "F6 の注釈は「記録・規模の判定を読む reviewer」で RecCorrect は SS も制御するが、作り役は F6off を P8 でしか回していない。own_F6off_P15 の結果は rerun.tsv",
     M + "Flow.tla:189-192・420・rerun.tsv:own_F6off_P15"],
    ["P16・P16a", "Z3・AA4（・answers.txt:48 と WF-19 の時点を問わない規則）", "範囲が古い（導けた原則と食い違う）",
     "P16 は PRStages（wake・prbot・ptriage を含む）で受け箱が空を求める。導けた答え・WF-19 は bot の run を待つ間の人の指摘も受け箱に入れ ptriage の振り分けに加えるので、それを入れた模型では P16 は定義から破れる（own_PRHuman_P16）。時点を問わない原則の形は「人間ゲート以降で受け箱が空」と「全ての振り分けが受け箱を空にする」（own の P16x・P16xa）",
     M + "Flow.tla:423-424・rerun.tsv:own_PRHuman_*"],
    ["P17", "Y4・AA2", "過不足なし", "", M + "Flow.tla:426・mut_NoWake_P17・mut_NoWait_P17"],
    ["C1・C2", "X1・Y1（実行可能性）", "過不足なし・空虚でないことは未確認",
     "どちらにも変異が無い。FixPurpose が置き場と draft PR を同時に決めるので構造上破れない。前回は v4 の版の破れで空虚でないことを示したが、模型 4 には v4 の版が無い",
     M + "results.tsv（C1・C2 の変異の行なし）"],
    ["C3・C3b", "AGENTS.md:70 の理由（実行可能性）", "一部直った",
     "C3b が止まる段で行動ごとに次の段が 1 つに決まることを見る（mut_GateAmbiguous で検出）。C3 は担い手の包含のままで、gate で人に行動が 2 つ（指摘・マージ）あることは見ない。これは人の選択なので制約として妥当",
     M + "Flow.tla:431-436"],
    ["I1・I2・I4", "残るリスクの測定（Z1・Q9・見逃し）", "妥当",
     "I1 は付け間違い、I2 は誤分類、I4 は見逃しで破れ、それぞれを外すと通る（I4 は外した版が無い: 見逃しは Review の S の選び方に組み込まれ外す定数が無い）。前回の「I1 は latent を測らない」は I4 で埋まった",
     M + "Flow.tla:439-441"],
])

w("rev.tsv", ["transition", "verdict", "reason", "evidence"], [
    ["FixPurpose", "決定どおり", "draft PR を作り（Y1）、置き場は規模（X1）、規模の判定は誤りうる（WF-02）", M + "Flow.tla:87-98"],
    ["Work", "決定どおり", "持ち込みは F1", M + "Flow.tla:101-117"],
    ["SelfCheckFail", "決定どおり", "OpenReal は logged を含むので PR 本文に載った欠陥も合否ゲートで再び落ちる", M + "Flow.tla:120-129"],
    ["Classify", "決定どおり", "誤分類は F5、環境と判じたら記録（Y3）", M + "Flow.tla:132-144"],
    ["HandleDefect", "決定どおり", "重大度なしで design（answers.txt:42 の導出）", M + "Flow.tla:150-160"],
    ["HandleEnvR", "決定どおり", "段を変えずやり直す（Q10）。envU を envR と誤分類すると Retry で再び落ちる", M + "Flow.tla:163-173"],
    ["HandleEnvU", "決定どおり", "reported で終わる（Q9）。再開は模型の外（WF-09）", M + "Flow.tla:176-182"],
    ["Review", "決定どおり", "記録を読み self の指摘に、規模の誤りは dreview だけで scale の指摘に（WF-02）。誤検出 F8", M + "Flow.tla:186-202"],
    ["Wake", "決定どおり", "AA2・WF-15", M + "Flow.tla:206-211"],
    ["BotReview", "決定どおり", "Y4", M + "Flow.tla:214-225"],
    ["DraftHuman・DraftBot", "決定どおり", "Z3。受け箱 inbox を dtriage・itriage が加える", M + "Flow.tla:228-245"],
    ["ReworkHuman", "決定どおり", "AA4。bot は push で走らない（WF-15）ので人だけ", M + "Flow.tla:248-255"],
    ["（欠落）wake・prbot・ptriage の間の人の指摘", "決定にあるのに無い",
     "answers.txt:48 の導けた答え（bot の run を待つ間の人の指摘も bot の指摘の振り分けに加える）と rules.tsv の WF-19（L24）に当たる遷移が decided・v6 のどちらにも無い。questions.tsv・table.tsv は ? のまま。own_PRHuman（受け箱に入れ ptriage で加える）では P1・P5・P6・P7・P11・P14・P17・C3 と書き直した P16x・P16xa が通り、元の P16 だけが破れる",
     M + "Flow.tla:248-255・285・table.tsv:24・questions.tsv・rerun.tsv:own_PRHuman_*"],
    ["AssignSev", "決定どおり", "agent の指摘にだけ sevagent（Y2）。付け間違い Z1、破損 F9", M + "Flow.tla:258-271"],
    ["Recount", "v6 どおり（粒度は導ける）", "壊れた 1 件だけを付け直す。WF-13 の「同じ入力でやり直す」が全件のやり直しでも、模型の結果（有限回で合うまで振り分けない）は同じ", M + "Flow.tla:274-282"],
    ["Triage", "決定どおり（ただし受け箱を加える段が dtriage・itriage だけ）",
     "抜粋 B の閾値・draft に戻さない（AA2）は正しい。Absorbs が dtriage・itriage に限られ、時点を問わない WF-19 の「次の振り分け」（ptriage を含む）を表さない。規模の誤りの訂正（sj・place）を振り分けで行うのは、作り手が設計で直すことの畳み込みで経路は変わらない",
     M + "Flow.tla:284-332"],
    ["HumanComment", "決定どおり（仮定が暗黙）", "人は開いた実在の欠陥にだけ、同じ欠陥に 1 度だけ指摘する（OpenAll \\ hc）。人の誤検出は表さず、F 一覧に無い", M + "Flow.tla:338-344"],
    ["HumanMerge・Done", "決定どおり", "X2・WF-20", M + "Flow.tla:346-358"],
    ["決定に無い制約", "無い（TriageGuard は W4・Y2 から）", "decided で重大度が壊れると振り分けが進まないのは決定に扱いが無いことの表れで、v6 の WF-13 で除かれる（decidedBadSev_P11）。DraftBudget は指摘の数の上限で、決定に無いが抽象化として明示されている", M + "Flow.tla:288-290・results.tsv:decidedBadSev_P11"],
])

w("fixcheck.tsv", ["item", "prior", "status", "reason", "evidence"], [
    ["自己検査の MEDIUM の経路", "P5 が self を対象外にし、self の MEDIUM を LOW に載せる変異が通った", "直った",
     "自己検査には重大度を付けず全て設計へ戻す（answers.txt:42）。P1 が self に重大度が無いことを、P8a が HandleDefect と self の振り分けが design・fixed であることを見る。mut_SelfLowLog を P8a が検出（再検査でも検出）",
     M + "Flow.tla:150-157・372-374・403-405・rerun.tsv:mut_SelfLowLog_P8"],
    ["合否ゲートの再失敗", "logged の欠陥が合否ゲートで再び捉えられない暗黙の仮定", "直った",
     "SelfCheckFail は logged を含む OpenReal から選び、再び落ちた欠陥は HandleDefect で fixed。この下で decided・v6 の P14 が通る",
     M + "Flow.tla:119-122・rerun.tsv:decided_all・v6_all"],
    ["誤検出の仮定", "暗黙（F 一覧に無い）", "直った（人の誤検出は残る・軽い）",
     "F8 として FpBudget を置き、Review・BotReview が id 9 を指摘できる。外した版で P14 が破れる（Z2 で受容）。人の指摘（HumanComment・DraftHuman・ReworkHuman）は実在の欠陥だけで、人の誤検出は表さない",
     M + "Flow.tla:22・67・194・216・rerun.tsv:assume_F8off_P14"],
    ["C3 の「次の行動が 1 つ」", "担い手の包含で行動の数を見ない", "一部直った",
     "C3b が止まる段の行動ごとの次の段の一意を見る（mut_GateAmbiguous で検出）。gate の行動の数（2）は見ないが、人の選択なので制約として妥当",
     M + "Flow.tla:431-436・results.tsv:mut_GateAmbiguous_C3"],
    ["P1 の範囲", "人の指摘にも重大度を求めて強すぎ", "直った",
     "P1 は agent に 4 値、self・human・scale に none を求める。mut_SevOnHuman を検出",
     M + "Flow.tla:372-374・results.tsv:mut_SevOnHuman_P1"],
    ["C4（ready の間は irOK）", "決定に無い", "直った（外した）",
     "AA2 で ready の後に戻っても draft に戻さない。ただし代わりの「draft に戻さない」性質が無い（props.tsv:P4）",
     M + "Flow.tla:24-25・rerun.tsv:own_ReDraft_all"],
    ["P6inv を落とした記録", "記録が無い", "直った", "見出しに理由つきで書かれた", M + "Flow.tla:24"],
    ["I1 の範囲（latent のままマージ）", "測らない", "直った", "I4 を足した", M + "Flow.tla:441"],
])

w("v6.tsv", ["item", "verdict", "reason", "evidence"], [
    ["WF-01〜WF-09・WF-11〜WF-18・WF-20〜WF-22 の遷移", "写している",
     "rules.tsv の model_transition の action と担い手に一致（WF-13 の数の照合は Recount、WF-02 の戻しは scale の指摘）",
     "rules.tsv・" + M + "Flow.tla"],
    ["WF-19（時点を問わない 1 つの規則）", "写していない",
     "模型は draft の間（DraftHuman・DraftBot→inbox）と ready の後の戻りの間（ReworkHuman→inboxR）の時点ごとの遷移で、bot の run を待つ間（rules.tsv L24）を持たない。Flow.tla:10-11 の「WF19=FALSE は rules.tsv の WF-19 未決の版」は今の rules.tsv に無い版を指す。模型は 22:38、rules.tsv は 22:52 で、WF-19 を 1 つにする前の rules.tsv に合わせて作られている",
     "rules.tsv:WF-19・" + M + "Flow.tla:10-11・248-255"],
    ["trace.tsv → rules.tsv", "不一致 2 件",
     "「WF-10 draft の間に来た人・bot の指摘」（v6 では欠番）と「WF-19 ready の後に設計へ戻って作り直している間（PR は ready のまま）に来た人・bot の指摘」（見出しが古い）が rules.tsv に無い",
     M + "trace.tsv:10・20"],
    ["rules.tsv → trace.tsv", "不一致 1 件", "「WF-19 人・bot の指摘」が trace.tsv に無い。WF-19 の actions は DraftHuman・DraftBot・ReworkHuman・（PR の段の人の指摘）・Triage になるはず",
     "rules.tsv:WF-19"],
    ["files.tsv の trace テスト（tests/workflow-flow-trace.test.mjs）", "今の trace.tsv では落ちる",
     "(2) trace.tsv の WF が全て workflow.md にある、が WF-10 と旧 WF-19 で破れ、(3) が「WF-19 人・bot の指摘」で破れる",
     "files.tsv:10"],
    ["v6NoWF19_P16 の行", "意味を失った", "比べる相手の「WF-19 未決」の rules.tsv はもう無い。今の v6 との差は WF-19 の時点の範囲（bot の run の間）で、この行は測っていない",
     M + "results.tsv:v6NoWF19_P16"],
    ["WF-13 の数の照合", "写している", "Recount は v6 だけ。decided との差として BadSev で示される", M + "Flow.tla:274-282"],
    ["files.tsv:9 の README の仮定の一覧（v6 の文書側）", "模型の仮定より少ない",
     "挙げるのは 4 つ（持ち込み・環境と誤分類・記録を読む reviewer・誤検出）。模型の F9（返り値の破損は有限回）・F6 の規模の判定の半分・F7・作業中の指摘の数（DraftBudget）が無い",
     "files.tsv:9・" + M + "Flow.tla:21-23"],
])

w("assumptions.tsv", ["assumption", "off_result", "holds_in_practice", "reason"], [
    ["F1 修正が欠陥を持ち込むのは有限回", "P14 fail（再検査で一致）", "言えない",
     "AGENTS.md:77-78（修正が持ち込む欠陥は修正者に見えない）・:87（手修正 3 回中 3 回）・:93-94（16 件が監査 2 回を素通り）。Z2 で受容"],
    ["F2 環境の失敗は有限回", "P14 fail（一致）", "おおむね言える", "Q6・Q8 で書きかけを検査する hook を消した（answers.txt:12-14）。除いたつもりの誤りは F5 側"],
    ["F5 誤分類は有限回", "P14 fail（一致）", "実測なし", "AGENTS.md に誤分類の実測は無い（grep「実測」の 8 行に該当なし）"],
    ["F6 記録・規模の判定を読む reviewer は誤りを見落とさない", "P8 fail（一致）・P15 は own_F6off_P15", "言えない",
     "AGENTS.md:79（単一視点にしない）・:93-94（検証に落ちたものが監査 2 回を通った）。規模の半分は作り役が外していない"],
    ["F7 弱公平性", "外していない", "言える", "足踏みを除くだけ"],
    ["F8 誤検出は有限回", "P14 fail（一致）", "実測なし（言えない寄り）", "AGENTS.md:158 の false positive は check_portability.py の話でレビュー役ではない。W4 に上限が無い"],
    ["F9 重大度の返り値の破損は有限回", "P14 fail（一致）", "実測なし", "同じ入力でのやり直しが同じ壊れ方を返し続ける可能性は AGENTS.md の実測に無い。決定的に壊れるなら終わらない"],
    ["暗黙: 作業中に来る指摘は有限回（DraftBudget）", "外していない", "言える寄り", "人と bot の指摘は人の数と bot の run（WF-15 で push では走らない）に縛られる。ただし F 一覧に無く「状態数を抑える抽象化」とだけ書かれている"],
    ["暗黙: 人は実在の欠陥だけを、同じ欠陥に 1 度だけ指摘する", "外していない", "言えない（軽い）", "人の誤検出も X3 で設計に戻る。往復が 1 回増えるだけで終了と安全に効かないが、F 一覧に無い"],
])

w("qcheck.tsv", ["qid", "verdict", "reason", "evidence"], [
    ["FQ1（wake・prbot・ptriage の間の人の指摘）", "答えは導けた・模型に反映されていない",
     "answers.txt:48 が (a) を導けた答えとする。questions.tsv・table.tsv は ? のまま、Flow.tla に遷移が無い。入れるときは受け箱に入れ ptriage の振り分けで加え、P16 を「人間ゲート以降で受け箱が空」に書き直す（own_PRHuman で整合を確認）",
     M + "questions.tsv・table.tsv:24・answers.txt:48"],
    ["Recount の粒度（壊れた 1 件か全件か）", "導ける", "WF-13 は「同じ入力でやり直す」で、どちらでも合うまで振り分けない結果は同じ。問いにしなくてよい", M + "Flow.tla:274-282"],
    ["ptriage の振り分けの後・gate の前に来た人の指摘", "導ける", "ptriage の次は gate で、そこで来た指摘は HumanComment（WF-17）。受け箱を経る遷移は要らない", M + "Flow.tla:338-344"],
    ["ready の後の戻りの間の bot の指摘", "導ける", "WF-15 で bot は push では走らない", "rules.tsv:WF-15"],
    ["その他の遷移", "一意（見た範囲で）", "table.tsv の ? 以外の 23 行と Flow.tla の NonDone の 18 action を全て読み、決定・規則から一意に決まらないものは上の FQ1 だけ", M + "table.tsv・Flow.tla:350-355"],
])
