------------------------------- MODULE Issue -------------------------------
(* 論点の生涯。書き手は resolver（裁定・回答の反映）と依頼者（回答）。依頼者は非決定的な環境。
   ver は問いの中身の版、sameAsk は今の版で聞いた回数、lost は回答の記録が失われた回数。
   未決の遷移は OPT_* で切り替える（questions.tsv の qid と対応）。
   @row の行は tools/extract.py が table.tsv に、@trace の行は trace.tsv に写す。 *)
EXTENDS Naturals

CONSTANTS Issues, MAX_VERIFY_REWORK, MAX_LOSS,
          OPT_EMPTY, OPT_STILL, OPT_UNMAPPED, OPT_VFAIL, OPT_FILE, MUT

VARIABLES ist, ver, sameAsk, lost, vfail, filing
ivars == <<ist, ver, sameAsk, lost, vfail, filing>>

Kinds   == {"a_content", "a_empty", "a_undecided", "a_conflict", "a_unmapped", "a_insufficient"}
States  == {"none", "question", "asked", "deferred", "confirmed", "hold"} \cup Kinds
Settled == {"none", "confirmed", "hold"}
Filings == {"na", "approved", "filed", "manual", "failed"}

ITypeOK ==
  /\ ist \in [Issues -> States]
  /\ ver \in [Issues -> Nat] /\ sameAsk \in [Issues -> Nat] /\ lost \in [Issues -> Nat]
  /\ vfail \in [Issues -> 0..MAX_VERIFY_REWORK] /\ filing \in [Issues -> Filings]

IInit ==
  /\ ist = [i \in Issues |-> "none"] /\ ver = [i \in Issues |-> 0]
  /\ sameAsk = [i \in Issues |-> 0] /\ lost = [i \in Issues |-> 0]
  /\ vfail = [i \in Issues |-> 0] /\ filing = [i \in Issues |-> "na"]

AnyPending  == \E i \in Issues : ist[i] = "question"
AnyAsked    == \E i \in Issues : ist[i] = "asked"
AnyAnswered == \E i \in Issues : ist[i] \in Kinds
AllSettled  == \A i \in Issues : ist[i] \in Settled

RuleOpts(canAsk) == {"none", "confirmed"} \cup (IF canAsk THEN {"question"} ELSE {"hold"})

\* @row Issue|none|resolver が論点を見つけて裁定する|canAsk|confirmed / question|-|impl:prd-spec.js:2433
\* @row Issue|none|resolver が論点を見つけて裁定する|~canAsk|confirmed / hold|保持規則と Issue の文案|impl:prd-spec.js:2124
\* @trace Issue!AriseAndRule|plugins/workflow/workflows/prd-spec.js:2413|const ASKS = { 3: canAsk, '3a': canAsk, '3b': canAsk, 6: canAsk, "3a'": canAsk }|聞ける段で価値の論点は question、上限の後は hold
AriseAndRule(canAsk) ==
  /\ \E f \in [Issues -> RuleOpts(canAsk)] :
        ist' = [i \in Issues |-> IF ist[i] = "none" THEN f[i] ELSE ist[i]]
  /\ UNCHANGED <<ver, sameAsk, lost, vfail, filing>>

\* @row Issue|none|迷った判定を問いにする（D-006 の defer・pregate）|-|question / asked|-|open:QM-06
\* @trace Issue!Force|decision:Q7|-|判定に迷った点を推測で決めずに問いにする
Force(s) ==
  /\ \E j \in Issues : ist[j] = "none" /\ ist' = [ist EXCEPT ![j] = s]
                    /\ sameAsk' = [sameAsk EXCEPT ![j] = IF s = "asked" THEN 1 ELSE 0]
  /\ UNCHANGED <<ver, lost, vfail, filing>>

\* @row Issue|question|ゲートを開く|-|asked|questions.json（同じ版なら sameAsk+1）|impl:prd-spec.js:2223
\* @trace Issue!AskAll|plugins/workflow/workflows/prd-spec.js:2221|const ids = pendingQuestions(state)|ゲートで回答待ちの問いをまとめて聞く
AskAll ==
  /\ AnyPending
  /\ ist' = [i \in Issues |-> IF ist[i] = "question" THEN "asked" ELSE ist[i]]
  /\ sameAsk' = [i \in Issues |-> IF ist[i] = "question" THEN sameAsk[i] + 1 ELSE sameAsk[i]]
  /\ UNCHANGED <<ver, lost, vfail, filing>>

\* @row Issue|asked|依頼者が回答する（中身あり・空・決まっていない・確定値と異なる・対応づけられない・なお着手できない）|-|a_*|answers/gN.md|impl:SKILL.md:110
\* @trace Issue!RespondAll|plugins/workflow/skills/prd-spec/SKILL.md:110|依頼者が答えなかった問いも `<ID>:` の行を書き、`:` の後を空にする|回答の種類は依頼者が非決定的に選ぶ
RespondAll ==
  /\ \E f \in [Issues -> Kinds] :
        ist' = [i \in Issues |-> IF ist[i] = "asked" THEN f[i] ELSE ist[i]]
  /\ UNCHANGED <<ver, sameAsk, lost, vfail, filing>>

CanLose == AnyAsked /\ \A i \in Issues : ist[i] = "asked" => lost[i] < MAX_LOSS

\* @row Issue|asked|回答の記録が失われる|canAsk か 数えない|asked（同じ版で再び聞く）|needs_answers（resumable: false）|impl:prd-spec.js:2282
\* @trace Issue!LoseReask|plugins/workflow/workflows/prd-spec.js:2282|問いを聞き直して回答を書き、next_args で呼び直してください|記録の消失だけが同じ中身の再質問を許す（Q8）
LoseReask ==
  /\ CanLose
  /\ lost' = [i \in Issues |-> IF ist[i] = "asked" /\ MUT # "Q8" THEN lost[i] + 1 ELSE lost[i]]
  /\ sameAsk' = [i \in Issues |-> IF ist[i] = "asked" THEN sameAsk[i] + 1 ELSE sameAsk[i]]
  /\ UNCHANGED <<ist, ver, vfail, filing>>

\* @row Issue|asked|回答の記録が失われる|~canAsk かつ 数える|hold|保持規則と Issue の文案|open:QM-03
\* @trace Issue!LoseHold|decision:Q3|-|D-035 の「数える」: 上限の後に失われた回答の論点は保持規則にする
LoseHold ==
  /\ CanLose
  /\ lost' = [i \in Issues |-> IF ist[i] = "asked" THEN lost[i] + 1 ELSE lost[i]]
  /\ ist' = [i \in Issues |-> IF ist[i] = "asked" THEN "hold" ELSE ist[i]]
  /\ UNCHANGED <<ver, sameAsk, vfail, filing>>

R(s, v, a, f) == [s |-> s, v |-> v, a |-> a, f |-> f]

NextOf(i, canAsk) ==
  LET s == ist[i]  v == ver[i]  a == sameAsk[i]  f == vfail[i]
      ReQ(changed) == IF ~canAsk THEN R("hold", v, a, 0)
                      ELSE IF changed THEN R("question", v + 1, 0, 0) ELSE R("question", v, a, 0)
      Alt(o) == CASE o = "changed" -> {ReQ(TRUE)}
                  [] o = "same"    -> {ReQ(FALSE)}
                  [] OTHER         -> {R("hold", v, a, 0)}
  IN CASE s = "a_content" ->
            {R("confirmed", v, a, 0)} \cup
            (IF f < MAX_VERIFY_REWORK THEN {R("a_content", v, a, f + 1)} ELSE Alt(OPT_VFAIL))
       [] s = "a_empty" ->
            CASE OPT_EMPTY = "noask" -> {R("deferred", v, a, 0)}
              [] OPT_EMPTY = "reask" -> {ReQ(FALSE)}
              [] OTHER -> IF a < 2 THEN {ReQ(FALSE)} ELSE {R("hold", v, a, 0)}
       [] s = "a_undecided"    -> {R("hold", v, a, 0)}
       [] s = "a_conflict"     -> {ReQ(TRUE)}
       [] s = "a_unmapped"     -> Alt(OPT_UNMAPPED)
       [] s = "a_insufficient" -> Alt(OPT_STILL)
       [] OTHER -> {R(s, v, a, f)}

\* @row Issue|a_content|回答を当て verifier が合格|-|confirmed|-|impl:prd-spec.js:2462
\* @row Issue|a_content|verifier が不合格（差し戻し 1 回）|vfail<MAX_VERIFY_REWORK|a_content（vfail+1）|-|decision:Q8
\* @row Issue|a_content|差し戻し後も不合格|canAsk|question（OPT_VFAIL: 版を変える / 同じ版）または hold|-|open:QM-10
\* @row Issue|a_empty|回答を当てる（空の回答行）|-|deferred / question（同じ版）/ 2 回目で hold|-|open:QM-07
\* @row Issue|a_undecided|回答を当てる（決まっていない）|-|hold|保持規則と Issue の文案|decision:Q2
\* @row Issue|a_conflict|回答を当てる（確定値と異なる）|canAsk|question（版を変える: どちらを採るかの確認）|-|decision:Q7
\* @row Issue|a_conflict|回答を当てる（確定値と異なる）|~canAsk|hold|-|decision:Q2
\* @row Issue|a_unmapped|回答を当てる（対応づけられない）|canAsk|question（OPT_UNMAPPED）または hold|-|open:QM-09
\* @row Issue|a_insufficient|回答を当てる（なお着手できない）|canAsk|question（OPT_STILL）または hold|-|open:QM-08
\* @trace Issue!ApplyStep|plugins/workflow/workflows/prd-spec.js:2470|の回答を、問い ${list(pending)} に当てる（resolver.md の「回答の反映」）|回答の種類ごとの遷移は NextOf
ApplyStep(canAsk) ==
  \E i \in Issues :
    /\ ist[i] \in Kinds
    /\ \E r \in NextOf(i, canAsk) :
         /\ ist' = [ist EXCEPT ![i] = r.s] /\ ver' = [ver EXCEPT ![i] = r.v]
         /\ sameAsk' = [sameAsk EXCEPT ![i] = r.a] /\ vfail' = [vfail EXCEPT ![i] = r.f]
    /\ UNCHANGED <<lost, filing>>

\* @row Issue|question / deferred|聞かずに段を出る（上限の後・改稿の輪の出口・run の終わり）|-|hold|保持規則と Issue の文案|impl:prd-spec.js:2127
\* @trace Issue!HoldLeft|plugins/workflow/workflows/prd-spec.js:2127|hold（保持規則・Issue の文案・触れる項目 ID）に書き換える|聞かない問いを保持規則に変える
HoldLeft ==
  /\ ist' = [i \in Issues |-> IF ist[i] \in {"question", "deferred"} THEN "hold" ELSE ist[i]]
  /\ UNCHANGED <<ver, sameAsk, lost, vfail, filing>>

HoldLeftIf(b) == IF b THEN HoldLeft ELSE UNCHANGED ivars

SettleDeferred ==
  /\ ist' = [i \in Issues |-> IF ist[i] = "deferred" THEN "hold" ELSE ist[i]]
  /\ UNCHANGED <<ver, sameAsk, lost, vfail, filing>>

\* @row Issue|hold（filing=na）|依頼者が Issue の文案を承認する|保存の後|approved|-|impl:SKILL.md:180
\* @trace Issue!Approve|plugins/workflow/skills/prd-spec/SKILL.md:180|文案は、依頼者の承認を得てから `gh issue create` で起票し、番号を報告する。|承認は依頼者の非決定的な行動
Approve(i) == ist[i] = "hold" /\ filing[i] = "na" /\ filing' = [filing EXCEPT ![i] = "approved"]
              /\ UNCHANGED <<ist, ver, sameAsk, lost, vfail>>
\* @row Issue|approved|起票に成功する|-|filed|Issue 番号|impl:SKILL.md:180
FileOk(i) == filing[i] = "approved" /\ filing' = [filing EXCEPT ![i] = "filed"]
             /\ UNCHANGED <<ist, ver, sameAsk, lost, vfail>>
\* @row Issue|approved|起票に失敗する（権限・ネットワーク・gh が無い）|-|manual（OPT_FILE=manual）/ failed（retry）|文案|open:QM-14
\* @trace Issue!FileFail|decision:Q2|-|D-017: 起票の失敗の後の遷移は実装にも決定にも無い
FileFail(i) == filing[i] = "approved"
               /\ filing' = [filing EXCEPT ![i] = IF OPT_FILE = "manual" THEN "manual" ELSE "failed"]
               /\ UNCHANGED <<ist, ver, sameAsk, lost, vfail>>
\* @row Issue|failed|起票をやり直す|OPT_FILE=retry|approved|-|open:QM-14
Retry(i) == filing[i] = "failed" /\ filing' = [filing EXCEPT ![i] = "approved"]
            /\ UNCHANGED <<ist, ver, sameAsk, lost, vfail>>

(* 単位の性質 *)
Q8 == \A i \in Issues : sameAsk[i] <= 1 + lost[i]
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
