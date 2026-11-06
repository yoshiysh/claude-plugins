from pathlib import Path
O = Path(__file__).resolve().parent
def w(name, H, R):
    with open(O / name, "w") as f:
        f.write("\t".join(H) + "\n")
        for r in R:
            assert len(r) == len(H), r
            f.write("\t".join(r) + "\n")

w("props.tsv", ["property", "decision", "verdict", "reason"], [
("P1", "W4・Y2", "強すぎ（無害）", "bot 以外の全ての指摘に重大度を求め、人の指摘を含む。X3 で人の指摘は重大度を問わず戻るので経路は変わらないが、人の指摘に重大度が要るとする決定は無い（Y2 は付ける者だけ）"),
("P2", "Y2・Y4・AGENTS.md:85-87", "過不足なし", "bot 以外は sevagent、bot は bot。指摘した者と付ける者が別であることも by の欄で足りる"),
("P3", "D1", "過不足なし", "戻りで drOK が FALSE。mut_SkipDR で空虚でない"),
("P4", "D1・Y1", "過不足なし", "PR の段で irOK、ready なら irEver。Y1 の「出す＝ready」をそのまま表す"),
("P5", "W4", "弱すぎ（自己検査が抜けた）", "src ∈ {agent, bot} に限る。自己検査の指摘（HandleDefect 由来と、Review が記録から拾う RS）は src=self で対象外。Q5 は自己検査の欠陥を設計に戻す規則に含め、W4 は MEDIUM 以上を戻すので、self の MEDIUM も戻るはず。own_FlowSelfMed（self の MEDIUM を LOW として載せる変異）で P1〜P15 の全てが通った＝この規則を見る性質が無い。P8 は SelfLow=log で logged を許すので拾わない"),
("P6", "W4「LOW は直さず PR 本文」", "過不足なし（「追わない」は落とした）", "agent・bot の LOW が logged になる。旧 P6inv（載せ直さない）は落とした。旧検証が強すぎとしたので妥当だが、落とした記録が無い"),
("P7", "X3・D1", "過不足なし", ""),
("P8", "Q5・W4・Y3", "弱すぎ（SelfLow=log の下で）", "自己検査の欠陥が fixed か logged であれば通り、重大度との対応を見ない（P5 の穴と同じ）。誤分類で覆われた欠陥を見ることは強くなった（mut_NoRecord・F6off で検出）。SelfLow=log 自体が解釈（rev）"),
("P9", "Q10", "過不足なし", "やり直しは段を変えない。覆われる経路にも到達する（probe_R2）"),
("P10", "Q9・Y3", "過不足なし", "止まるとき envU の記録がある。「理由」は抽象化で落ちる"),
("P11", "X2・Q9・AGENTS.md:70", "過不足なし", ""),
("P13", "AGENTS.md:76・Y3", "過不足なし（範囲つき）", "レビューと重大度は builder 以外、記録はレビューの前に読まれる（空にされる）。読み手の見落としは F6 として外で測る。v4 では空虚"),
("P14", "D1・Q9・X2", "過不足なし（仮定つき）", "F1・F2・F5・F7 の下で通る。誤検出が無いことも暗黙の仮定（assumptions.tsv）"),
("P15", "X1", "過不足なし", ""),
("C1", "X1・Y1", "過不足なし（実行可能性）", "変異が無い（v4_C1 の破れで空虚でないことは示される）"),
("C2", "W4・Y1", "過不足なし（実行可能性）", "同上（v4_C2）"),
("C3", "brief（AGENTS.md:70 の理由）", "決定に無い・式は弱い（旧 P12 のまま）", "担い手の包含で、行動の数は見ない。brief 由来と明記した点は正しい"),
("C4", "Y1 の読み", "決定に無い（決定と食い違う側）", "ready の間は irOK を求める。Y1 は「出す」の時点を定義しただけで、ready のまま差分を足す経路は V3（answers.txt:20「ready 後の差分の役」）と AGENTS.md:176 が前提にする。C4 は FQ1 (a) を性質に焼いている（qcheck FQ1）"),
("I1", "残るリスクの測定", "妥当", "付け間違いだけで破れ（decidedNoSevErr で通る）、性質でなく測定と分けたのは正しい。範囲は「logged のままマージ」だけで、レビューの見逃し（latent のままマージ）は測らない"),
("I2", "残るリスクの測定", "妥当", "誤分類だけで破れる（decidedNoMis で通る）"),
])

w("rev.tsv", ["action", "verdict", "reason", "evidence_ref", "evidence_quote"], [
("FixPurpose", "決定どおり", "draft PR を作り、置き場は規模で決める", "design-review-1/answers.txt:33", "目的を固定した時点で draft PR を作り、その本文に置く"),
("Work", "決定どおり", "直した欠陥を持ち込み直す（F1）", "AGENTS.md:77-78", "修正が持ち込む欠陥と"),
("SelfCheckFail", "抽象化が楽観側に偏る", "欠陥は Latent からだけ選ぶ（Flow.tla:123）。logged の欠陥（agent・bot の LOW を含む）は、合否ゲートの検査でも二度と捉えられない。make test は合否ゲートで、直さない欠陥は次の検査でも落ちる。own_FlowOpenChk（Open から選ぶ写し）で SelfLow=log の P14 が破れ（反例: dtriage で agent の LOW として logged になった欠陥を impl の自己検査が捉え、striage で LOW→impl→再び失敗を繰り返す）、SelfLow=design では通る", "AGENTS.md:151", "合否ゲート"),
("Classify", "決定どおり", "作り手が分類し、環境と判じたら記録（Y3）", "design-review-1/answers.txt:35", "作り手が分類と理由を成果物の置き場に記録し"),
("HandleDefect（SelfLow=log）", "決定に無い（解釈）", "自己検査の欠陥に sevagent の重大度を付け W4 を当てる。Y2 は付ける者を決めたが、自己検査の失敗に重大度を付けるかは記録に無い（旧 FQ8 の推奨は付けない側）。上の SelfCheckFail の通り、合否ゲートの検査では LOW の経路が成り立たない", "design-review-1/answers.txt:11", "まだレビューに出していないものの欠陥も「設計に戻る」に含める"),
("HandleEnvR", "決定どおり", "段を変えずやり直す。真の欠陥なら覆われうる（probe_R2 で到達）", "design-review-1/answers.txt:16", "作り手が原因を除いて同じ検査をその場でやり直す（設計に戻らない）"),
("HandleEnvU", "決定どおり", "記録を持って reported", "design-review-1/answers.txt:15", "失敗と理由を利用者に報告して止める"),
("Review", "決定どおり（誤検出を表さない）", "記録を読み RF を self として出す（probe_R3 で到達）。指摘は Open（実在の欠陥）からだけで誤検出が無い", "design-review-1/answers.txt:35", "次のレビュー（作り手と別の者）が見る"),
("BotReview", "決定どおり", "", "design-review-1/answers.txt:36", "bot が付けた重大度をそのまま使う"),
("AssignSev（人の指摘）", "決定に無い制約（無害）", "NeedSev に human を入れ、htriage が重大度を待つ", "design-review-1/answers.txt:31", "人の指摘は重大度を問わず直す"),
("Triage（戻り・LOW）", "決定どおり", "", "design-review-1/answers.txt:26", "MEDIUM 以上は設計に戻し、LOW は直さず PR 本文に載せて追わない"),
("Triage（ready の後の戻り）", "決定どおり（C4 は決定外）", "PR を ready のまま戻る。V3・AGENTS.md:176 が前提にする経路で、C4 の破れは決定の欠陥ではない", "design-review-1/answers.txt:20", "段の対応表に ready 後の差分の役として載せる"),
("Triage（ready の後の検証役）", "欠落（軽微）", "ready の後の差分を diff-verifier が見る段（V3）が無く、ireview の reviewer に畳まれている。経路の判定は変わらない", "AGENTS.md:176", "PR を ready にした後に足した差分は、push した後に"),
("HumanComment", "決定に無い制約（問いにした）", "gate だけ。FQ2", "design-review-1/answers.txt:36", "順序は bot の振り分けの後に人間ゲート"),
("HumanMerge・Done", "決定どおり", "", "design-review-1/answers.txt:30", "マージを人間が行う"),
("PubApprove・AskAnswer・ResumeAfterReport", "決定どおり（decided では無効）", "", "design-review-1/answers.txt:30", "マージが公開"),
("BackFlags（Redraft）", "案として分離", "FQ1 (a)。decided は FALSE。往復に到達する（probe_R4）", "flow-model-2/Flow.tla:87", "pr' = IF Redraft /\\ pr = \"ready\" THEN \"draft\" ELSE pr"),
("欠落の確認", "上の 2 件以外は見つからない", "answers.txt の D1〜Y4 の全行と AGENTS.md:70-100 を遷移表に照らした範囲で。D3 は自己検査に、W5 は流れの差なしに畳まれる", "design-review-1/answers.txt:4", "形式検証をルールにする"),
("trace.tsv", "正しい", "25 行全て逐語で一致（check_trace.py）。main の AGENTS.md と作業ツリーの AGENTS.md は cmp で同一", "flow-model-2/trace.tsv", "-"),
])

w("assumptions.tsv", ["assumption", "off_result", "off_correct", "holds_in_practice", "reason"], [
("F1 修正が欠陥を持ち込むのは有限回", "P14 fail（72194）", "正しい", "言えない", "AGENTS.md:77-78（修正が持ち込む欠陥は修正者に見えない）・:86（手修正 3/3 欠陥）・:93-94（16 件が監査 2 回を素通り）は持ち込みが常にありうることを示す。W4 は回数の上限を置かない（answers.txt:26）。終了は決定でなく、収束する現実に依る。残るリスクとして示すべき"),
("F2 環境の失敗は有限回", "P14 fail（86056）", "正しい", "おおむね言える", "Q6 は往復が終わらない原因を hook の時機とし、Q8 で hook を消した（answers.txt:12-14）。原因を除いてやり直すので同じ失敗は続きにくい。除いたつもりで除けていない場合は F5 側"),
("F3 人は同じ欠陥を二度指摘しない", "decided P14 pass／v4 P14 fail", "正しい", "決定どおりでは不要", "X3 で人の指摘は必ず直るので繰り返しの経路が無い"),
("F4", "-", "-", "-", "番号が無い。旧版の F4（弱公平性）が F7 に改番されただけで、落とした仮定は無い（flow-model/Flow.tla:28）"),
("F5 誤分類は有限回", "P14 fail（82676）", "正しい", "記録とレビューがあれば言える寄り（実測なし）", "Y3 の記録はレビューで読まれるが、段の中の再分類の繰り返し（HandleEnvR の OTHER 枝）はレビュー前に起きる。実測は AGENTS.md に無い"),
("F6 記録を読んだレビュー役は誤分類を見落とさない", "P8 fail（2332〜2621）", "正しい", "言えない", "AGENTS.md:79-81（検証は単一視点にしない）・:93-94（検証に落ちた 16 件が監査 2 回を通った）はレビュー役の見落としを示す。Y3 の効き目は確率的。I1 と同じく残るリスクとして示すべき"),
("F7 弱公平性 WF_vars(NonDone)", "外していない", "-", "言える", "外すと足踏みで自明に破れる。終了は予算から構造上決まり、WF は足踏みを除くだけ"),
("暗黙: 指摘は実在の欠陥だけ（誤検出なし）", "own_FlowFP（Review が直した欠陥も指摘できる写し）で P14 fail（261304）", "-", "言えない", "Review・BotReview・HumanComment は Open からだけ選ぶ。反例の循環（状態 37 へ戻る）は、直した欠陥を Review が MEDIUM と誤検出して設計へ戻すことの繰り返し。W4 に上限が無いので終わらない。レビュー役の誤検出の実測は AGENTS.md に無い（:158 の false positive は検出器 check_portability.py の話）ので「言えない」は実測でなく、誤検出が起きないと言える根拠も無いという意味。F 一覧に無い"),
("暗黙: logged の欠陥（agent・bot・自己検査の LOW）は合否ゲートの検査で再び捉えられない", "own_FlowOpenChk で SelfLow=log の P14 fail（106798）、SelfLow=design は pass", "-", "合否ゲートでは言えない", "AGENTS.md:151 で make test は合否ゲート。直さない欠陥は次の検査で再び落ちる。反例は dtriage で agent の LOW として logged になった欠陥を impl の自己検査が捉える循環。SelfLow=log の既定はこの仮定に依る"),
])

w("qcheck.tsv", ["qid", "verdict", "reason", "options_ok", "recommend_ok"], [
("FQ1", "導ける: (b)", "(a) では設計に戻るたびに draft に戻り、ready にした後は人間ゲートとマージしか無いので、ready の後に足す差分が存在しない。これは V3（answers.txt:20 diff-verifier を「ready 後の差分の役」として残す）と AGENTS.md:176（ready にした後に足した差分は push した後に検証役へ）の対象を空にする。Y1 は「出す」の時点を定義しただけで、V3 を改めていない。よって決定と規範から (b)（ready のまま直し、出すは最初の ready）が導ける。(a) を採るには V3 の改めが要る", "おおむね正しい。(a) を選ぶなら V3 と AGENTS.md:176 の改め（ready 後の差分が無くなる）が要ると書くべき", "誤り。推奨 (a) は V3・AGENTS.md:176 と食い違う。C4 は (a) を性質に焼いた制約で決定ではない"),
("FQ2", "問いとして成り立つ", "X3・D1 は人の指摘の経路を、Y4 は bot と人間ゲートの順序を決めるが、draft の間に来た指摘の時機は決めない。人の指摘を止める手段は無いので (c) は人には当てられない", "(c) は人には実行できない（bot だけに当たる）と書くべき", "妥当。(a) は振り分けの規則が 1 つで、AGENTS.md:70（途中で止めず）にも触れない"),
("FQ3 候補（問いに無い）", "問いか導出が要る", "自己検査の失敗に重大度を付けて LOW を載せるか（SelfLow）、人の指摘に重大度を付けるか（NeedSev）は答えの記録に無い（Y2 は付ける者だけ）。模型は付ける側に読んだ。自己検査については、合否ゲート（AGENTS.md:151）の失敗は直さないと次も落ちるので LOW の経路が成り立たず（own_FlowOpenChk）、全て設計へ（SelfLow=design）が導ける寄り", "-", "自己検査は design を既定にし、人の指摘は重大度を付けない（旧 FQ7 の推奨）のが筋"),
("I1", "利用者に示すべき（今の決定では除けない）", "付け間違いは Y2（1 体）と W4（LOW は追わない）の組から生まれる。構造で除くには新しい決定が要る: 例 LOW の付けを別の 1 体が確かめる（Y2 の 1 体を改める）。人間ゲートで PR 本文の LOW 一覧を読むよう求める案は人の注意力に頼る防御で構造では除けない（AGENTS.md:101-107）。今は PR 本文に見えるので X3 で直る経路が残るだけ。欠陥がマージに届くリスクで重い", "-", "-"),
("I2", "利用者に示すべき（軽い）", "誤って止まるだけで欠陥はマージに届かない。止まった後は報告（分類と理由）を読む利用者が Y3 の「別の者」に当たる。除くなら止まる前に builder 以外が分類を確かめる決定が要る（体数が増える）", "-", "-"),
("F1・F6・誤検出", "利用者に示すべき", "終了（P14）と P8 は実測が否定する仮定の下でだけ通る（assumptions.tsv）。W4 に上限が無いので、往復が終わらない・誤分類の欠陥が残るリスクは決定に残る", "-", "-"),
])
