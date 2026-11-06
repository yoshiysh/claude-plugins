------------------------------ MODULE Composed ------------------------------
(* 3 つの単位（Run・Issue・Seam）を継ぎ目で同期させた合成模型。継ぎ目の同期は次の 4 つ:
   (1) 段 1〜3・6 の裁定と、聞くか保持規則にするかの判定（Run の canAsk を Issue に渡す）
   (2) ゲートで問いを聞き、依頼者の回答を論点に当てる（Issue の状態で Run の分岐が決まる）
   (3) 監査役の返り値と doc_check の stdout（Seam の Verdict を Run の Audit・Reaudit に渡す）
   (4) 保存直前の tree digest（Seam の TreeCheck を Run の Save に渡す） *)
EXTENDS Naturals

CONSTANTS MAX_GATES, MAX_AUDIT_PASSES, MAX_CHECK_REWORK, MAX_RERUN, MAX_VERIFY_REWORK, MAX_LOSS, ASK_BOUND, Issues,
          IMPL_A024, OPT_NC, OPT_LOSTCOUNT, OPT_DIGEST, OPT_DOUBT, OPT_W, OPT_ARGS, OPT_FIXER, OPT_WLOST,
          OPT_FILE, MUT, VARY

ASSUME MAX_GATES = 2 + MAX_AUDIT_PASSES  \* 実装の定数の関係（prd-spec.js:61）

VARIABLES rs, status, stopReason, hasNext, cause, from,
          gates, pass, stops, reruns, rework,
          deferred, redraft, specOnly, audited,
          blk, docBlk, unchecked, notChecked,
          saved, saveWait, saveCond, ncRecorded,
          wExists, pluginUpd, argsBad,
          ist, ver, sameAsk, lost, vfail, filing, ansCur, reaskAns,
          aud, docOut, ncOut, tree

R == INSTANCE Run
I == INSTANCE Issue
S == INSTANCE Seam

rvars == <<rs, status, stopReason, hasNext, cause, from, gates, pass, stops, reruns, rework,
          deferred, redraft, specOnly, audited, blk, docBlk, unchecked, notChecked,
          saved, saveWait, saveCond, ncRecorded, wExists, pluginUpd, argsBad>>
ivars == <<ist, ver, sameAsk, lost, vfail, filing, ansCur, reaskAns>>
svars == <<aud, docOut, ncOut, tree>>
vars == <<rvars, ivars, svars>>

Init == R!RInit /\ I!IInit /\ S!SInit

PendingAfter == \E i \in Issues : ist'[i] = "question"
NoHold == MUT = "Q2"

RunOnly(A) == A /\ UNCHANGED <<ivars, svars>>

Internal ==
  \/ RunOnly(R!S0Go) \/ RunOnly(R!S0Unreadable) \/ RunOnly(R!S0DoubtEnd)
  \/ R!S0DoubtDefer /\ I!Force("question") /\ UNCHANGED svars
  \/ R!S0DoubtPregate /\ I!Force("asked") /\ UNCHANGED svars
  \/ I!AriseAndRule(R!CanAsk) /\ R!IntakeCarry(PendingAfter) /\ UNCHANGED svars
  \/ R!IntakeAskNow /\ I!AriseAndRule(R!CanAsk) /\ PendingAfter
       /\ UNCHANGED svars  \* 変異 Q6 だけが通る経路（問いを聞く状態への写しは省き、ゲートを開いた事実だけを見る）
  \/ RunOnly(R!Draft)
  \/ rs \in {"audit", "reaudit"} /\ R!Running /\ (S!Dispatch \/ S!Return \/ S!Recopy) /\ UNCHANGED <<rvars, ivars>>
  \/ S!Ready /\ R!Audit(S!Verdict, ncOut) /\ S!Consume /\ UNCHANGED ivars
  \/ S!Ready /\ R!Reaudit(S!Verdict, ncOut) /\ S!Consume /\ UNCHANGED ivars
  \/ R!Decide /\ I!AriseAndRule(R!CanAsk) /\ UNCHANGED svars
  \/ I!AnyPending /\ R!Decide2Ask /\ I!AskAll /\ UNCHANGED svars
  \/ I!AnyPending /\ RunOnly(R!Decide2Upstream)
  \/ (~I!AnyPending \/ ~R!CanAsk) /\ R!Decide2Go /\ I!HoldLeftIf(~R!CanAsk /\ ~NoHold) /\ UNCHANGED svars
  \/ I!AnyAnswered /\ R!Apply /\ I!ApplyStep(R!CanAsk) /\ UNCHANGED svars
  \/ ~I!AnyAnswered /\ RunOnly(R!ApplyDone)
  \/ RunOnly(R!ApplyRework) \/ RunOnly(R!ApplyReworkLimit) \/ RunOnly(R!ApplyFixerUnknown)
  \/ I!AnyPending /\ R!Apply2Ask /\ I!AskAll /\ UNCHANGED svars
  \/ (~I!AnyPending \/ ~R!CanAsk) /\ R!Apply2Go /\ I!HoldLeftIf(~R!CanAsk /\ ~NoHold) /\ UNCHANGED svars
  \/ RunOnly(R!ReviseReaudit) \/ RunOnly(R!ReviseReport) \/ RunOnly(R!FinalHoldFail)
  \/ R!ReviseFinal /\ I!HoldLeft /\ UNCHANGED svars
  \/ RunOnly(R!JudgeReport) \/ RunOnly(R!JudgeLoop)
  \/ R!JudgeNoProgress /\ I!HoldLeft /\ UNCHANGED svars
  \/ R!JudgeLimit /\ I!HoldLeft /\ UNCHANGED svars
  \/ RunOnly(R!Report)
  \/ S!TreeCheck /\ R!Save(tree' = "match") /\ UNCHANGED ivars
  \/ RunOnly(R!FailNotRun) \/ RunOnly(R!FailScript) \/ RunOnly(R!FailIntegrity) \/ RunOnly(R!FailBudget)
  \/ I!AnyAnswered /\ RunOnly(R!FailVerify)
  \/ RunOnly(R!FailVerifyHard)

Env ==
  \/ R!ReqAnswer /\ I!RespondAll /\ UNCHANGED svars
  \/ RunOnly(R!ReqWLost) \/ RunOnly(R!ReqBadArgs)
  \/ R!ReqLoseNoCount /\ I!LoseReask /\ UNCHANGED svars
  \/ R!ReqLoseCountAsk /\ I!LoseReask /\ UNCHANGED svars
  \/ R!ReqLoseCountHold /\ I!LoseHold /\ UNCHANGED svars
  \/ RunOnly(R!Rerun) \/ RunOnly(R!PluginUpdate)
  \/ RunOnly(R!SaveApprove) \/ RunOnly(R!SaveDecline)
  \/ rs = "end" /\ saved /\ \E i \in Issues : I!Approve(i) /\ UNCHANGED <<rvars, svars>>

Filing == \E i \in Issues : (I!FileOk(i) \/ I!FileFail(i) \/ I!Retry(i)) /\ UNCHANGED <<rvars, svars>>

Done == R!Terminal /\ UNCHANGED vars

Next == Internal \/ Env \/ Filing \/ Done
Spec == Init /\ [][Next]_vars /\ WF_vars(Internal) /\ WF_vars(Filing)

(* 性質。決定との対応は results.tsv の note（tools/run_checks.py の PROP_NOTE）が正。 *)
TypeOK == R!RTypeOK /\ I!ITypeOK /\ S!STypeOK
Q1 == R!Q1
Q1nc == R!Q1nc
Q2 == status = "done" => I!AllSettled
Q3a == R!Q3a /\ \A i \in Issues : vfail[i] <= MAX_VERIFY_REWORK
Q3b == R!Q3b
Q4 == R!Q4
Q5 == R!Q5
Q6 == R!Q6
Q7 == R!Q7
Q7W == R!Q7W
Q8 == I!Q8
Q9 == R!Q9
Q10 == R!Q10
IssueTracked == I!IssueTracked
\* 非終端の行き止まりは TLC の deadlock 検査が拾う（Done は終端でだけ有効）。
Term == (~R!Terminal) ~> R!Terminal
ReachSaved == R!ReachSaved
ReachDone == R!ReachDone
ReachUpstream == R!ReachUpstream
ReachPassLimit == R!ReachPassLimit
ReachNoProgress == R!ReachNoProgress
ReachGateMax == R!ReachGateMax
ReachPassMax == R!ReachPassMax
ReachRedraft == R!ReachRedraft
ReachException == R!ReachException
ReachVerifyHard == R!ReachVerifyHard
ReachHold == \A i \in Issues : ist[i] # "hold"
ReachReask == \A i \in Issues : sameAsk[i] < 2
ReachEmptyReask == \A i \in Issues : ~(ist[i] = "asked" /\ sameAsk[i] >= 2 /\ lost[i] = 0)
ReachFiled == \A i \in Issues : filing[i] # "filed"
FilingLive == \A i \in Issues : (filing[i] = "approved") ~> (filing[i] \in {"filed", "manual"})
=============================================================================
