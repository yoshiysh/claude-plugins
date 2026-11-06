------------------------------- MODULE Issue -------------------------------
(* 論点の生涯。書き手は resolver（裁定・回答の反映）と依頼者（回答）。依頼者は非決定的な環境。
   ver は問いの中身の版、sameAsk は今の版で聞いた回数、lost は回答の記録が失われた回数、
   ansCur は今の版に中身のある回答を受け取ったか、reaskAns は回答を受け取った版のまま聞き直した回数。
   回答の種類ごとの遷移は決定から導いたもの（model-1-verify/qcheck.tsv の derivable: QM-07・08・09・10）。
   @row の行は tools/extract.py が table.tsv に、@trace の行は trace.tsv に写す。 *)
EXTENDS Naturals

CONSTANTS Issues, MAX_VERIFY_REWORK, MAX_LOSS, OPT_FILE, MUT

VARIABLES ist, ver, sameAsk, lost, vfail, filing, ansCur, reaskAns
ivars == <<ist, ver, sameAsk, lost, vfail, filing, ansCur, reaskAns>>

Kinds   == {"a_content", "a_empty", "a_undecided", "a_conflict", "a_unmapped", "a_insufficient"}
States  == {"none", "question", "asked", "confirmed", "hold"} \cup Kinds
Settled == {"none", "confirmed", "hold"}
Filings == {"na", "approved", "filed", "manual", "failed"}

ITypeOK ==
  /\ ist \in [Issues -> States]
  /\ ver \in [Issues -> Nat] /\ sameAsk \in [Issues -> Nat] /\ lost \in [Issues -> Nat]
  /\ vfail \in [Issues -> 0..MAX_VERIFY_REWORK] /\ filing \in [Issues -> Filings]
  /\ ansCur \in [Issues -> BOOLEAN] /\ reaskAns \in [Issues -> Nat]

IInit ==
  /\ ist = [i \in Issues |-> "none"] /\ ver = [i \in Issues |-> 0]
  /\ sameAsk = [i \in Issues |-> 0] /\ lost = [i \in Issues |-> 0]
  /\ vfail = [i \in Issues |-> 0] /\ filing = [i \in Issues |-> "na"]
  /\ ansCur = [i \in Issues |-> FALSE] /\ reaskAns = [i \in Issues |-> 0]

AnyPending  == \E i \in Issues : ist[i] = "question"
AnyAsked    == \E i \in Issues : ist[i] = "asked"
AnyAnswered == \E i \in Issues : ist[i] \in Kinds
AllSettled  == \A i \in Issues : ist[i] \in Settled

RuleOpts(canAsk) == {"none", "confirmed"} \cup (IF canAsk THEN {"question"} ELSE {"hold"})

\* @row Issue|none|resolver が論点を見つけて裁定する|canAsk|confirmed / question|-|impl
\* @row Issue|none|resolver が論点を見つけて裁定する|~canAsk|confirmed / hold|保持規則と Issue の文案|impl
\* @trace Issue!AriseAndRule|plugins/workflow/workflows/prd-spec.js:2413|const ASKS = { 3: canAsk, '3a': canAsk, '3b': canAsk, 6: canAsk, "3a'": canAsk }|聞ける段で価値の論点は question、上限の後は hold
AriseAndRule(canAsk) ==
  /\ \E f \in [Issues -> RuleOpts(canAsk)] :
        ist' = [i \in Issues |-> IF ist[i] = "none" THEN f[i] ELSE ist[i]]
  /\ UNCHANGED <<ver, sameAsk, lost, vfail, filing, ansCur, reaskAns>>

\* @row Issue|none|迷った判定を問いにする（D-006 の defer・pregate）|-|question / asked|-|open:QM-06
\* @trace Issue!Force|-|-|open:QM-06 の選択肢 2・3
Force(s) ==
  /\ \E j \in Issues : ist[j] = "none" /\ ist' = [ist EXCEPT ![j] = s]
                    /\ sameAsk' = [sameAsk EXCEPT ![j] = IF s = "asked" THEN 1 ELSE 0]
  /\ UNCHANGED <<ver, lost, vfail, filing, ansCur, reaskAns>>

\* @row Issue|question|ゲートを開く|-|asked（同じ版なら sameAsk+1、回答を受け取った版なら reaskAns+1）|questions.json|impl
\* @trace Issue!AskAll|plugins/workflow/workflows/prd-spec.js:2221|const ids = pendingQuestions(state)|ゲートで回答待ちの問いをまとめて聞く
AskAll ==
  /\ AnyPending
  /\ ist' = [i \in Issues |-> IF ist[i] = "question" THEN "asked" ELSE ist[i]]
  /\ sameAsk' = [i \in Issues |-> IF ist[i] = "question" THEN sameAsk[i] + 1 ELSE sameAsk[i]]
  /\ reaskAns' = [i \in Issues |-> IF ist[i] = "question" /\ ansCur[i] THEN reaskAns[i] + 1 ELSE reaskAns[i]]
  /\ UNCHANGED <<ver, lost, vfail, filing, ansCur>>

\* @row Issue|asked|依頼者が回答する（中身あり・空・決まっていない・確定値と異なる・対応づけられない・なお着手できない）|-|a_*|answers/gN.md|impl
\* @trace Issue!RespondAll|plugins/workflow/skills/prd-spec/SKILL.md:110|依頼者が答えなかった問いも `<ID>:` の行を書き、`:` の後を空にする|空の回答行は回答を受け取ったことにしない（ansCur を立てない）
RespondAll ==
  /\ \E f \in [Issues -> Kinds] :
        /\ ist' = [i \in Issues |-> IF ist[i] = "asked" THEN f[i] ELSE ist[i]]
        /\ ansCur' = [i \in Issues |-> IF ist[i] = "asked" THEN (ansCur[i] \/ f[i] # "a_empty") ELSE ansCur[i]]
  /\ UNCHANGED <<ver, sameAsk, lost, vfail, filing, reaskAns>>

CanLose == AnyAsked /\ \A i \in Issues : ist[i] = "asked" => lost[i] < MAX_LOSS

\* @row Issue|asked|回答の記録が失われる|canAsk か 数えない|asked（同じ版で再び聞く。記録の消失の例外）|needs_answers（resumable: false）|impl
\* @trace Issue!LoseReask|plugins/workflow/workflows/prd-spec.js:2282|問いを聞き直して回答を書き、next_args で呼び直してください|記録の消失だけが同じ中身の再質問を許す（Q8）
LoseReask ==
  /\ CanLose
  /\ lost' = [i \in Issues |-> IF ist[i] = "asked" THEN lost[i] + 1 ELSE lost[i]]
  /\ sameAsk' = [i \in Issues |-> IF ist[i] = "asked" THEN sameAsk[i] + 1 ELSE sameAsk[i]]
  /\ UNCHANGED <<ist, ver, vfail, filing, ansCur, reaskAns>>

\* @row Issue|asked|回答の記録が失われる|~canAsk かつ 数える|hold|保持規則と Issue の文案|open:QM-03
\* @trace Issue!LoseHold|-|-|open:QM-03: D-035 の「数える」で上限の後に失われた回答の論点は保持規則にする
LoseHold ==
  /\ CanLose
  /\ lost' = [i \in Issues |-> IF ist[i] = "asked" THEN lost[i] + 1 ELSE lost[i]]
  /\ ist' = [i \in Issues |-> IF ist[i] = "asked" THEN "hold" ELSE ist[i]]
  /\ UNCHANGED <<ver, sameAsk, vfail, filing, ansCur, reaskAns>>

R(s, v, a, f, c) == [s |-> s, v |-> v, a |-> a, f |-> f, c |-> c]

NextOf(i, canAsk) ==
  LET s == ist[i]  v == ver[i]  a == sameAsk[i]  f == vfail[i]  c == ansCur[i]
      ReQ(changed) == IF ~canAsk /\ MUT # "Q2" THEN R("hold", v, a, 0, c)
                      ELSE IF changed THEN R("question", v + 1, 0, 0, FALSE) ELSE R("question", v, a, 0, c)
  IN CASE s = "a_content" ->
            {R("confirmed", v, a, 0, c)} \cup
            (IF f < MAX_VERIFY_REWORK THEN {R("a_content", v, a, f + 1, c)} ELSE {ReQ(TRUE)})
       [] s = "a_empty"        -> {ReQ(FALSE)}
       [] s = "a_undecided"    -> {R("hold", v, a, 0, c)}
       [] s = "a_conflict"     -> {ReQ(TRUE)}
       [] s = "a_unmapped"     -> {ReQ(TRUE)}
       [] s = "a_insufficient" -> {ReQ(MUT # "Q8")}
       [] OTHER -> {R(s, v, a, f, c)}

\* @row Issue|a_content|回答を当て verifier が合格|-|confirmed|-|impl
\* @row Issue|a_content|verifier が不合格（差し戻し 1 回）|vfail<MAX_VERIFY_REWORK|a_content（vfail+1）|-|decision:Q8
\* @row Issue|a_content|差し戻し後も不合格|canAsk|question（版を変える）、~canAsk なら hold|-|decision:Q8
\* @row Issue|a_empty|回答を当てる（空の回答行。当てる回答が無い）|canAsk|question（同じ版のまま、回答待ちとして次のゲートで聞く）、~canAsk なら hold|-|decision:Q8
\* @row Issue|a_undecided|回答を当てる（決まっていない）|-|hold|保持規則と Issue の文案|decision:Q2
\* @row Issue|a_conflict|回答を当てる（確定値と異なる）|canAsk|question（版を変える: どちらを採るかの確認）、~canAsk なら hold|-|decision:Q7
\* @row Issue|a_unmapped|回答を当てる（対応づけられない・保留の事項への回答）|canAsk|question（版を変える）、~canAsk なら hold|-|decision:Q7・Q8
\* @row Issue|a_insufficient|回答を当てる（なお着手できない）|canAsk|question（回答で絞れた範囲の版に変える）、~canAsk なら hold|-|decision:Q6・Q8
\* @trace Issue!ApplyStep|plugins/workflow/workflows/prd-spec.js:2475|の回答を、問い ${list(pending)} に当てる（resolver.md の「回答の反映」）|rev.tsv の wrong への対応: 空の回答行は当てずに回答待ちに残る（resolver.md:101・prd-spec.js:283-285）
ApplyStep(canAsk) ==
  \E i \in Issues :
    /\ ist[i] \in Kinds
    /\ \E r \in NextOf(i, canAsk) :
         /\ ist' = [ist EXCEPT ![i] = r.s] /\ ver' = [ver EXCEPT ![i] = r.v]
         /\ sameAsk' = [sameAsk EXCEPT ![i] = r.a] /\ vfail' = [vfail EXCEPT ![i] = r.f]
         /\ ansCur' = [ansCur EXCEPT ![i] = r.c]
    /\ UNCHANGED <<lost, filing, reaskAns>>

\* @row Issue|question|聞かずに段を出る（上限の後・改稿の輪の出口）|-|hold|保持規則と Issue の文案|impl
\* @trace Issue!HoldLeft|plugins/workflow/workflows/prd-spec.js:2127|hold（保持規則・Issue の文案・触れる項目 ID）に書き換える|聞かない問いを保持規則に変える
HoldLeft ==
  /\ ist' = [i \in Issues |-> IF ist[i] = "question" THEN "hold" ELSE ist[i]]
  /\ UNCHANGED <<ver, sameAsk, lost, vfail, filing, ansCur, reaskAns>>

HoldLeftIf(b) == IF b THEN HoldLeft ELSE UNCHANGED ivars

\* @row Issue|hold（filing=na）|依頼者が Issue の文案を承認する|保存の後|approved|-|impl
\* @trace Issue!Approve|plugins/workflow/skills/prd-spec/SKILL.md:179|文案は、依頼者の承認を得てから `gh issue create` で起票し、番号を報告する。|承認は依頼者の非決定的な行動
Approve(i) == ist[i] = "hold" /\ filing[i] = "na" /\ filing' = [filing EXCEPT ![i] = "approved"]
              /\ UNCHANGED <<ist, ver, sameAsk, lost, vfail, ansCur, reaskAns>>
\* @row Issue|approved|起票に成功する|-|filed|Issue 番号|impl
\* @trace Issue!FileOk|plugins/workflow/skills/prd-spec/SKILL.md:179|文案は、依頼者の承認を得てから `gh issue create` で起票し、番号を報告する。|起票の成功
FileOk(i) == filing[i] = "approved" /\ filing' = [filing EXCEPT ![i] = "filed"]
             /\ UNCHANGED <<ist, ver, sameAsk, lost, vfail, ansCur, reaskAns>>
\* @row Issue|approved|起票に失敗する（権限・ネットワーク・gh が無い）|-|manual（OPT_FILE=manual）/ failed（retry）|文案|open:QM-14
\* @trace Issue!FileFail|-|-|open:QM-14: 起票の失敗の後の遷移は実装にも決定にも無い
FileFail(i) == filing[i] = "approved"
               /\ filing' = [filing EXCEPT ![i] = IF OPT_FILE = "manual" THEN "manual" ELSE "failed"]
               /\ UNCHANGED <<ist, ver, sameAsk, lost, vfail, ansCur, reaskAns>>
\* @row Issue|failed|起票をやり直す|OPT_FILE=retry|approved|-|open:QM-14
\* @trace Issue!Retry|-|-|open:QM-14 の選択肢 2（起票できるまで完了と扱わない）
Retry(i) == filing[i] = "failed" /\ filing' = [filing EXCEPT ![i] = "approved"]
            /\ UNCHANGED <<ist, ver, sameAsk, lost, vfail, ansCur, reaskAns>>

(* 単位の性質。Q8（と A-018・PR-REQUESTER-007）: 既に回答した論点の同じ中身の再質問は、記録の消失のときだけ。
   記録の消失の聞き直しは LoseReask で、reaskAns に数えない。 *)
Q8 == \A i \in Issues : reaskAns[i] = 0
IssueTracked == \A i \in Issues : filing[i] # "manual"

(* 単体の駆動: canAsk と依頼者を非決定的に置く。問いの版が無限に増えないよう、版の上限 ASK_BOUND で聞くのを止める。 *)
CONSTANT ASK_BOUND
IBounded == \A i \in Issues : ver[i] + sameAsk[i] < ASK_BOUND
INext ==
  \/ \E c \in BOOLEAN : AriseAndRule(c)
  \/ (IBounded /\ AskAll)
  \/ (AnyAsked /\ RespondAll)
  \/ LoseReask
  \/ \E c \in BOOLEAN : ApplyStep(c)
  \/ HoldLeft /\ ist' # ist
  \/ \E i \in Issues : Approve(i) \/ FileOk(i) \/ FileFail(i) \/ Retry(i)
ISpec == IInit /\ [][INext]_ivars
=============================================================================
