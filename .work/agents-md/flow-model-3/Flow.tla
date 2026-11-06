---------------------------- MODULE Flow ----------------------------
(***************************************************************************)
(* #207 の作業の流れの模型（第 3 版）。1 つの変更の生涯を表す。            *)
(* 段: 目的の固定（draft PR: Y1）-> 設計 -> 設計レビュー -> 実装 -> 実装   *)
(*     レビュー -> ready -> bot -> 人間ゲート -> マージ。除けない失敗は    *)
(*     報告して停止（Q9）。TLC の結果は有限の定数での欠陥の証拠で、証明    *)
(*     ではない。                                                          *)
(*                                                                         *)
(* Model = "decided": 利用者の決定（D1〜Z3 と answers.txt の導けた答え）   *)
(* Model = "v5":      design-v5/rules.tsv どおり。decided との差は規模の    *)
(*   判定（rules.tsv:3。builder が判じ、設計レビューの decision-verifier が *)
(*   確かめて外れていれば指摘として出す）だけ。他の規則は decided と同じ   *)
(*   遷移に写る（rules.tsv の model_transition 列）。                       *)
(*                                                                         *)
(* 担い手: builder / reviewer（観点の agent。decision-verifier を含む）/    *)
(*   sevagent（severity-assigner: Y2）/ orch / bot / human。               *)
(*                                                                         *)
(* 誤りを表す（決定どおりの版でも有効にして、性質が守られるかを見る）      *)
(*   SevErr    sevagent・bot は真の重大度と違う値を付けうる（Z1 で受容）   *)
(*   MisBudget builder は自己検査の失敗の原因を誤分類しうる                 *)
(*   FpBudget  reviewer・bot は実在しない欠陥を指摘しうる（誤検出。id 9）  *)
(*   ReBudget  修正が直した欠陥を持ち込み直しうる                           *)
(*   SjBudget  （v5）builder は規模を誤って判じうる（規模の欠陥。id 0）     *)
(*   DraftBudget draft の間に来る人・bot の指摘の数（状態数を抑える抽象化）*)
(*                                                                         *)
(* 仮定（外した版を results.tsv で回す。Z2 によりリスクとして記録する）    *)
(*   F1 持ち込みは有限回（ReUnb で外す）                                    *)
(*   F2 環境の失敗は有限回（EnvUnb で外す）                                 *)
(*   F5 誤分類は有限回（MisUnb で外す）                                     *)
(*   F6 記録・規模の判定を読んだ reviewer は誤りを見落とさない              *)
(*      （RecCorrect=FALSE で外す）                                         *)
(*   F7 担い手の行動全体に弱公平性 WF_vars(NonDone)                         *)
(*   F8 誤検出は有限回（FpUnb で外す）                                      *)
(*   旧 F3（人は同じ欠陥を二度指摘しない）は要らない: 人の指摘は必ず直る   *)
(*   （X3）ので繰り返しの経路が無い（flow-model-2 の assume_F3off_P14）。  *)
(*                                                                         *)
(* 外した性質: 旧 P6inv（同じ LOW を PR 本文に載せ直さない）は W4 の「追わ *)
(*   ない」の読みで決定の文に無い（flow-model-verify/props.tsv）ので外した。*)
(*   旧 C4（ready の間は実装レビュー済み）は決定に無い（answers.txt:42:    *)
(*   ready の後に設計へ戻っても draft に戻さない）ので外した。             *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Model, Mut, SevErr, RecCorrect,
          EnvBudget, MisBudget, ReBudget, FpBudget, SjBudget, DraftBudget,
          EnvUnb, MisUnb, ReUnb, FpUnb

Real == {1, 2}
FP == 9
DD == Real \cup {0}
Kind == [d \in Real |-> IF d = 1 THEN "MED" ELSE "LOW"]
Actors == {"builder", "reviewer", "sevagent", "orch", "bot", "human"}
Agents == Actors \ {"human"}
TriageStages == {"dtriage", "itriage", "ptriage", "htriage"}
AfterDR == {"impl", "ireview", "itriage", "prbot", "ptriage", "gate", "htriage", "merged"}
PRStages == {"prbot", "ptriage", "gate", "htriage", "merged"}
WorkStages == {"design", "impl"}
Terminal == {"merged", "reported"}
AllowedStop == {"gate", "merged", "reported"}
StopStages == {"gate", "ask", "merged", "reported"}
NextActor(s) == IF s \in {"gate", "ask"} THEN {"human"} ELSE {}

VARIABLES stage, scale, sj, place, pr, ds, pend, inbox, drOK, irOK, irEver,
          envLeft, misLeft, reLeft, fpLeft, sjLeft, dLeft,
          chk, chkTrue, chkD, cls, rec, selfSeen, hc, bc, ev

vars == <<stage, scale, sj, place, pr, ds, pend, inbox, drOK, irOK, irEver,
          envLeft, misLeft, reLeft, fpLeft, sjLeft, dLeft,
          chk, chkTrue, chkD, cls, rec, selfSeen, hc, bc, ev>>

PlaceFor(s) == IF s = "typo" THEN "prBody" ELSE "commit"
OpenReal == {d \in Real : ds[d] \in {"latent", "logged"}}
OpenAll == {d \in DD : ds[d] \in {"latent", "logged"}}
Fixed == {d \in Real : ds[d] = "fixed"}
F(d, src, sev, by) == [d |-> d, src |-> src, sev |-> sev, by |-> by]
Mk(S, src) == {F(x, src, "none", "none") : x \in S}
SetEv(a, who) == ev' = [act |-> a, actor |-> who]
Dec(n, unb) == IF unb THEN n ELSE n - 1
SevVals(d) == IF d \in Real /\ ~SevErr THEN {Kind[d]} ELSE {"MED", "LOW"}
FpOpts(n) == IF n > 0 THEN {{}, {FP}} ELSE {{}}

Init ==
  /\ stage = "purpose"
  /\ scale \in {"typo", "other"} /\ sj = "unset"
  /\ place = "unset" /\ pr = "none"
  /\ ds = [d \in DD |-> IF d = 0 THEN "none" ELSE "latent"]
  /\ pend = {} /\ inbox = {}
  /\ drOK = FALSE /\ irOK = FALSE /\ irEver = FALSE
  /\ envLeft = EnvBudget /\ misLeft = MisBudget /\ reLeft = ReBudget
  /\ fpLeft = FpBudget /\ sjLeft = SjBudget /\ dLeft = DraftBudget
  /\ chk = "idle" /\ chkTrue = "none" /\ chkD = 0 /\ cls = "none"
  /\ rec = {} /\ selfSeen = {} /\ hc = {} /\ bc = {}
  /\ ev = [act |-> "Init", actor |-> "none"]

Back == stage' = "design" /\ drOK' = FALSE /\ irOK' = FALSE

\* 目的の固定（X1・Y1）。v5 では builder が規模を判じ、誤りうる（rules.tsv:3）
FixPurpose ==
  /\ stage = "purpose"
  /\ \E j \in IF Model = "v5" /\ sjLeft > 0 THEN {"typo", "other"} ELSE {scale} :
       /\ sj' = j
       /\ sjLeft' = IF j = scale THEN sjLeft ELSE sjLeft - 1
       /\ place' \in IF Mut = "PlaceAny" THEN {"prBody", "commit"} ELSE {PlaceFor(j)}
       /\ ds' = [ds EXCEPT ![0] = IF j = scale THEN "none" ELSE "latent"]
  /\ pr' = "draft" /\ stage' = "design"
  /\ SetEv("FixPurpose", "builder")
  /\ UNCHANGED <<scale, pend, inbox, drOK, irOK, irEver, envLeft, misLeft, reLeft, fpLeft, dLeft,
                 chk, chkTrue, chkD, cls, rec, selfSeen, hc, bc>>

\* 作業と自己検査の成功（D1）。直した欠陥を持ち込み直すことがある（F1）
Work ==
  /\ stage \in WorkStages /\ chk = "idle"
  /\ \E R \in IF reLeft > 0 THEN {{}} \cup {{d} : d \in Fixed} ELSE {{}} :
       /\ ds' = [d \in DD |-> IF d \in R THEN "latent" ELSE ds[d]]
       /\ reLeft' = IF R = {} THEN reLeft ELSE Dec(reLeft, ReUnb)
       /\ hc' = hc \ R /\ bc' = bc \ R /\ selfSeen' = selfSeen \ R
  /\ \/ /\ stage = "design" /\ stage' = (IF Mut = "SkipDR" THEN "impl" ELSE "dreview")
        /\ UNCHANGED <<pr, irOK, irEver>>
     \/ /\ stage = "impl"
        /\ IF Mut = "SkipIR"
                            THEN stage' = "prbot" /\ pr' = "ready" /\ UNCHANGED <<irOK, irEver>>
                            ELSE stage' = "ireview" /\ UNCHANGED <<pr, irOK, irEver>>
  /\ SetEv("Work", "builder")
  /\ UNCHANGED <<scale, sj, place, pend, inbox, drOK, envLeft, misLeft, fpLeft, sjLeft, dLeft,
                 chk, chkTrue, chkD, cls, rec>>

\* 自己検査（合否ゲート）の失敗。直していない欠陥は PR 本文に載っていても
\* 再び落ちる（flow-model-2-verify rev.tsv SelfCheckFail）
SelfCheckFail ==
  /\ stage \in WorkStages /\ chk = "idle"
  /\ \/ \E d \in OpenReal : chkTrue' = "defect" /\ chkD' = d /\ selfSeen' = selfSeen \cup {d}
                            /\ UNCHANGED envLeft
     \/ envLeft > 0 /\ chkTrue' \in {"envR", "envU"} /\ chkD' = 0
        /\ envLeft' = Dec(envLeft, EnvUnb) /\ UNCHANGED selfSeen
  /\ chk' = "fail"
  /\ SetEv("SelfCheck", "builder")
  /\ UNCHANGED <<stage, scale, sj, place, pr, ds, pend, inbox, drOK, irOK, irEver,
                 misLeft, reLeft, fpLeft, sjLeft, dLeft, cls, rec, hc, bc>>

\* 分類と記録（Y3）
Classify ==
  /\ chk = "fail"
  /\ \E c \in {"defect", "envR", "envU"} :
       /\ c = chkTrue \/ misLeft > 0
       /\ misLeft' = IF c = chkTrue THEN misLeft ELSE Dec(misLeft, MisUnb)
       /\ cls' = c
       /\ rec' = IF c \in {"envR", "envU"} /\ Mut # "NoRecord"
                   THEN rec \cup {[d |-> chkD, cls |-> c, tru |-> chkTrue]} ELSE rec
  /\ chk' = "cls"
  /\ SetEv("Classify", "builder")
  /\ UNCHANGED <<stage, scale, sj, place, pr, ds, pend, inbox, drOK, irOK, irEver,
                 envLeft, reLeft, fpLeft, sjLeft, dLeft, chkTrue, chkD, selfSeen, hc, bc>>

Reset == chk' = "idle" /\ cls' = "none" /\ chkTrue' = "none" /\ chkD' = 0
Retry == chk' = "fail" /\ cls' = "none" /\ UNCHANGED <<chkTrue, chkD>>

\* 欠陥と分類したもの: 重大度を付けずに設計へ戻る（Q5・answers.txt:42）
HandleDefect ==
  /\ chk = "cls" /\ cls = "defect"
  /\ IF chkTrue = "defect" /\ Mut # "SelfLowLog"
       THEN Back /\ ds' = [ds EXCEPT ![chkD] = "fixed"] /\ UNCHANGED pr
       ELSE IF chkTrue = "defect"
         THEN stage' = stage /\ ds' = [ds EXCEPT ![chkD] = "logged"] /\ UNCHANGED <<drOK, irOK, pr>>
         ELSE Back /\ UNCHANGED <<ds, pr>>
  /\ Reset
  /\ SetEv("HandleDefect", "orch")
  /\ UNCHANGED <<scale, sj, place, pend, inbox, irEver, envLeft, misLeft, reLeft, fpLeft, sjLeft, dLeft,
                 rec, selfSeen, hc, bc>>

\* 除ける環境と分類したもの: その場でやり直す（Q10）。真の原因が欠陥なら覆われて
\* 通るか再び落ち、除けない環境なら再び落ちる
HandleEnvR ==
  /\ chk = "cls" /\ cls = "envR"
  /\ IF Mut = "EnvRToDesign"
       THEN Back /\ Reset
       ELSE /\ stage' = stage /\ UNCHANGED <<drOK, irOK>>
            /\ CASE chkTrue = "envR" -> Reset
                 [] chkTrue = "defect" -> Reset \/ Retry
                 [] OTHER -> Retry
  /\ SetEv("HandleEnvR", "builder")
  /\ UNCHANGED <<scale, sj, place, pr, ds, pend, inbox, irEver, envLeft, misLeft, reLeft,
                 fpLeft, sjLeft, dLeft, rec, selfSeen, hc, bc>>

\* 除けない環境と分類したもの: 記録した分類と理由を報告して止まる（Q9・Y3）
HandleEnvU ==
  /\ chk = "cls" /\ cls = "envU"
  /\ IF Mut = "EnvURetry"
       THEN stage' = stage /\ Retry /\ SetEv("HandleEnvU", "builder")
       ELSE stage' = "reported" /\ Reset /\ SetEv("HandleEnvU", "orch")
  /\ UNCHANGED <<scale, sj, place, pr, ds, pend, inbox, drOK, irOK, irEver, envLeft, misLeft,
                 reLeft, fpLeft, sjLeft, dLeft, rec, selfSeen, hc, bc>>

\* レビュー。記録を読み、誤分類で残った欠陥を自己検査の指摘にする（Y3）。
\* v5 の設計レビューは規模の判定も確かめ、外れていれば agent の指摘にする
Review ==
  /\ stage \in {"dreview", "ireview"}
  /\ LET RF == {r.d : r \in {x \in rec : x.tru = "defect" /\ ds[x.d] \in {"latent", "logged"}}}
         SF == IF Model = "v5" /\ stage = "dreview" /\ ds[0] = "latent" THEN {0} ELSE {}
     IN \E RS \in IF Mut = "SkipRecReview" THEN {{}}
                  ELSE IF RecCorrect THEN {RF} ELSE SUBSET RF :
        \E SS \in IF RecCorrect THEN {SF} ELSE SUBSET SF :
        \E S \in SUBSET (OpenReal \ RS) :
        \E P \in FpOpts(fpLeft) :
          /\ pend' = Mk(S \cup SS \cup P, "agent") \cup Mk(RS, "self")
          /\ fpLeft' = IF P = {} THEN fpLeft ELSE Dec(fpLeft, FpUnb)
  /\ rec' = IF Mut = "SkipRecReview" THEN rec ELSE {}
  /\ stage' = IF stage = "dreview" THEN "dtriage" ELSE "itriage"
  /\ SetEv("Review", IF Mut = "SelfReview" THEN "builder" ELSE "reviewer")
  /\ UNCHANGED <<scale, sj, place, pr, ds, inbox, drOK, irOK, irEver, envLeft, misLeft,
                 reLeft, sjLeft, dLeft, chk, chkTrue, chkD, cls, selfSeen, hc, bc>>

\* bot は ready の PR に自分の重大度を付けて指摘する（Y4）
BotReview ==
  /\ stage = "prbot"
  /\ \E S \in SUBSET OpenReal : \E P \in FpOpts(fpLeft) :
     \E sv \in [S \cup P -> {"MED", "LOW"}] :
       /\ \A d \in S \cup P : sv[d] \in SevVals(d)
       /\ pend' = {F(x, "bot", sv[x], "bot") : x \in S \cup P}
       /\ fpLeft' = IF P = {} THEN fpLeft ELSE Dec(fpLeft, FpUnb)
  /\ stage' = "ptriage"
  /\ SetEv("BotReview", "bot")
  /\ UNCHANGED <<scale, sj, place, pr, ds, inbox, drOK, irOK, irEver, envLeft, misLeft,
                 reLeft, sjLeft, dLeft, chk, chkTrue, chkD, cls, rec, selfSeen, hc, bc>>

\* draft の間に来た人・bot の指摘（Z3）: 受け箱に入り、その段のレビューの後の
\* 振り分けに加わる
DraftHuman ==
  /\ pr = "draft" /\ stage \notin {"purpose"} \cup Terminal /\ dLeft > 0 /\ dLeft' = dLeft - 1
  /\ \E d \in OpenAll \ hc : inbox' = inbox \cup {F(d, "human", "none", "none")} /\ hc' = hc \cup {d}
  /\ SetEv("DraftHuman", "human")
  /\ UNCHANGED <<stage, scale, sj, place, pr, ds, pend, drOK, irOK, irEver, envLeft, misLeft,
                 reLeft, fpLeft, sjLeft, chk, chkTrue, chkD, cls, rec, selfSeen, bc>>

DraftBot ==
  /\ pr = "draft" /\ stage \notin {"purpose"} \cup Terminal /\ dLeft > 0 /\ dLeft' = dLeft - 1
  /\ \E d \in OpenReal \ bc : \E v \in SevVals(d) :
       inbox' = inbox \cup {F(d, "bot", v, "bot")} /\ bc' = bc \cup {d}
  /\ SetEv("DraftBot", "bot")
  /\ UNCHANGED <<stage, scale, sj, place, pr, ds, pend, drOK, irOK, irEver, envLeft, misLeft,
                 reLeft, fpLeft, sjLeft, chk, chkTrue, chkD, cls, rec, selfSeen, hc>>

\* 重大度は agent の指摘にだけ sevagent が付ける（Y2・answers.txt:42）
AssignSev ==
  /\ stage \in TriageStages
  /\ \E f \in pend :
       /\ f.sev = "none"
       /\ f.src = "agent" \/ (Mut = "SevOnHuman" /\ f.src = "human")
       /\ \E v \in SevVals(f.d) :
            LET who == IF Mut = "OrchSev" THEN "orch" ELSE "sevagent"
            IN pend' = (pend \ {f}) \cup {[f EXCEPT !.sev = v, !.by = who]}
               /\ SetEv("AssignSev", who)
  /\ UNCHANGED <<stage, scale, sj, place, pr, ds, inbox, drOK, irOK, irEver, envLeft, misLeft,
                 reLeft, fpLeft, sjLeft, dLeft, chk, chkTrue, chkD, cls, rec, selfSeen, hc, bc>>

Absorbs == stage \in {"dtriage", "itriage"} /\ Mut # "InboxIgnored"
All == pend \cup (IF Absorbs THEN inbox ELSE {})

TriageGuard ==
  Mut = "TriageNoSev" \/ \A f \in All : f.src = "agent" => f.sev # "none"

\* 設計に戻す指摘か（D1・W4・X3・Q5）
IsBack(f) ==
  CASE f.src = "human" -> Mut # "HumanLowNotFixed"
    [] f.src = "self" -> Mut # "SelfLowLog"
    [] Mut = "MedPass" -> FALSE
    [] Mut = "LowFix" -> TRUE
    [] OTHER -> f.sev = "MED"

PassTargets(s) ==
  CASE s = "dtriage" -> IF Mut = "AskStop" THEN {"impl", "ask"} ELSE {"impl"}
    [] s = "itriage" -> {"prbot"}
    [] OTHER -> {"gate"}

\* 振り分け（司令塔: 閾値による段の選択）。ready の後に戻っても draft に
\* 戻さない（answers.txt:42）
Triage ==
  /\ stage \in TriageStages
  /\ TriageGuard
  /\ LET back == {f \in All : IsBack(f)}
         fixS == {f.d : f \in back} \cap DD
         lowS == ({f.d : f \in All \ back} \cap DD) \ fixS
     IN /\ ds' = [d \in DD |-> IF d \in fixS THEN "fixed"
                               ELSE IF d \in lowS /\ ds[d] \in {"latent", "logged"} THEN "logged"
                               ELSE ds[d]]
        /\ sj' = IF 0 \in fixS THEN scale ELSE sj
        /\ place' = IF 0 \in fixS THEN PlaceFor(scale) ELSE place
        /\ IF back # {}
             THEN Back /\ UNCHANGED <<pr, irEver>>
             ELSE /\ stage' \in PassTargets(stage)
                  /\ drOK' = (drOK \/ stage = "dtriage")
                  /\ irOK' = (irOK \/ stage = "itriage")
                  /\ irEver' = (irEver \/ stage = "itriage")
                  /\ pr' = IF stage = "itriage" THEN "ready" ELSE pr
  /\ pend' = {}
  /\ inbox' = IF Absorbs THEN {} ELSE inbox
  /\ SetEv("Triage", "orch")
  /\ UNCHANGED <<scale, envLeft, misLeft, reLeft, fpLeft, sjLeft, dLeft, chk, chkTrue, chkD, cls,
                 rec, selfSeen, hc, bc>>

Static == <<scale, sj, place, pr, ds, pend, inbox, drOK, irOK, irEver, envLeft, misLeft,
            reLeft, fpLeft, sjLeft, dLeft, chk, chkTrue, chkD, cls, rec, selfSeen, hc, bc>>

HumanComment ==
  /\ stage = "gate"
  /\ \E d \in OpenAll \ hc : pend' = Mk({d}, "human") /\ hc' = hc \cup {d}
  /\ stage' \in IF Mut = "GateAmbiguous" THEN {"htriage", "gate"} ELSE {"htriage"}
  /\ SetEv("HumanComment", "human")
  /\ UNCHANGED <<scale, sj, place, pr, ds, inbox, drOK, irOK, irEver, envLeft, misLeft,
                 reLeft, fpLeft, sjLeft, dLeft, chk, chkTrue, chkD, cls, rec, selfSeen, bc>>

HumanMerge ==
  /\ stage = "gate" /\ stage' = "merged"
  /\ SetEv("HumanMerge", "human") /\ UNCHANGED Static

AskAnswer ==
  /\ stage = "ask" /\ stage' = "impl"
  /\ SetEv("AskAnswer", "human") /\ UNCHANGED Static

ResumeAfterReport ==
  /\ Mut = "ResumeAfterReport" /\ stage = "reported" /\ stage' = "impl"
  /\ SetEv("Resume", "orch") /\ UNCHANGED Static

NonDone ==
  \/ FixPurpose \/ Work \/ SelfCheckFail \/ Classify
  \/ HandleDefect \/ HandleEnvR \/ HandleEnvU
  \/ Review \/ BotReview \/ DraftHuman \/ DraftBot \/ AssignSev \/ Triage
  \/ HumanComment \/ HumanMerge \/ AskAnswer \/ ResumeAfterReport

Done == stage \in Terminal /\ UNCHANGED vars
Next == NonDone \/ Done
Spec == Init /\ [][Next]_vars /\ WF_vars(NonDone)

-----------------------------------------------------------------------------
EnabledActors == {a \in Actors : ENABLED (NonDone /\ ev'.actor = a)}
AgentsIdle == ~ENABLED (NonDone /\ ev'.actor \in Agents)
IsTriage == ev'.act = "Triage"
Tr == All

\* ---- 決定に結びつく性質 ----
\* P1（W4・Y2・answers.txt:42）振り分けの前に agent の指摘には重大度が付き、
\*   自己検査と人の指摘には付かない
P1 == [][IsTriage => \A f \in Tr :
           /\ f.src = "agent" => f.sev # "none"
           /\ f.src \in {"self", "human"} => f.sev = "none"]_vars
\* P2（Y2・Y4）重大度を付けるのは sevagent、bot の指摘は bot
P2 == \A f \in pend \cup inbox : f.sev # "none" =>
        (IF f.src = "bot" THEN f.by = "bot" ELSE f.by = "sevagent")
\* P3（D1）設計レビューを通らずに実装へ進まない
P3 == stage \in AfterDR => drOK
\* P4（D1・Y1）実装レビューを通らずに ready にしない
P4 == /\ stage \in PRStages => irOK
      /\ pr = "ready" => irEver
\* P5（W4）MEDIUM と付いた agent・bot の指摘は設計に戻る
P5 == [][IsTriage => \A f \in Tr :
           (f.src \in {"agent", "bot"} /\ f.sev = "MED")
             => (stage' = "design" /\ (f.d \in DD => ds'[f.d] = "fixed"))]_vars
\* P6（W4）LOW と付いた agent・bot の指摘は直さず PR 本文に載り、LOW だけでは
\*   設計に戻らない（同じ欠陥に設計に戻す別の指摘があればそちらが優先）
DecBack(g) == g.src \in {"human", "self"} \/ g.sev = "MED"
P6 == [][IsTriage =>
          /\ \A f \in Tr :
               (/\ f.src \in {"agent", "bot"} /\ f.sev = "LOW" /\ f.d \in DD
                /\ ds[f.d] # "fixed"
                /\ ~\E g \in Tr : g.d = f.d /\ DecBack(g))
                 => ds'[f.d] = "logged"
          /\ (\A f \in Tr : ~DecBack(f)) => stage' # "design"]_vars
\* P7（X3・D1）人の指摘は重大度を問わず設計に戻る
P7 == [][IsTriage => \A f \in Tr :
           f.src = "human" => (stage' = "design" /\ ds'[f.d] = "fixed")]_vars
\* P8（Q5・Y3・answers.txt:42）自己検査で出た欠陥は、誤分類されていても、
\*   ready の段に入る前に直る
P8 == stage \in PRStages => \A d \in selfSeen : ds[d] = "fixed"
\* P8a（Q5・answers.txt:42）自己検査の指摘は重大度に依らず設計に戻る
P8a == [][/\ IsTriage => \A f \in Tr : f.src = "self" => (stage' = "design" /\ ds'[f.d] = "fixed")
          /\ (ev'.act = "HandleDefect" /\ chkTrue = "defect")
               => (stage' = "design" /\ ds'[chkD] = "fixed")]_vars
\* P9（Q10）除ける環境と分類したら段を変えずにやり直す
P9 == [][ev'.act = "HandleEnvR" => stage' = stage]_vars
\* P10（Q9・Y3）除けない環境と分類したら、分類を記録して止まる
P10 == [][ev'.act = "HandleEnvU" =>
            (stage' = "reported" /\ \E r \in rec : r.cls = "envU")]_vars
\* P11（X2・Q9・AGENTS.md:70）agent が止まるのはマージの人間ゲートと報告だけ
P11 == AgentsIdle => stage \in AllowedStop
\* P13（AGENTS.md:76・Y3）レビューと重大度は builder 以外が行い、builder の
\*   分類の記録は、段のレビューを通る前に builder 以外が読む
P13 == /\ ev.act \in {"Review", "AssignSev"} => ev.actor # "builder"
       /\ (stage \in {"impl", "prbot"} /\ ev.act = "Triage") => rec = {}
\* P14（D1・Q9・X2）終端に到達する（F1・F2・F5・F6・F7・F8 の下）
P14 == <>(stage \in Terminal)
\* P15（X1）ready の段では、成果物の置き場が真の規模で決まっている
P15 == /\ stage \in PRStages => place = PlaceFor(scale)
\* P16（Z3）draft の間に来た指摘は、その段のレビューの後の振り分けで扱われる
P16 == /\ stage \in PRStages => inbox = {}
P16a == [][(IsTriage /\ stage \in {"dtriage", "itriage"}) => inbox' = {}]_vars

\* ---- 実行可能性の制約（決定ではない） ----
\* C1（X1・Y1）PR 本文を置き場にするとき PR がある
C1 == (stage # "purpose" /\ place = "prBody") => pr # "none"
\* C2（W4・Y1）LOW を PR 本文に載せるとき PR がある
C2 == \A d \in DD : ds[d] = "logged" => pr # "none"
\* C3（brief 由来。AGENTS.md:70 の理由）止まった状態では人だけが動け、人の
\*   行動ごとに次の段が 1 つに決まる
NextStage(s, a) ==
  (CASE s = "gate" /\ a = "HumanComment" -> "htriage"
     [] s = "gate" /\ a = "HumanMerge" -> "merged"
     [] s = "ask" /\ a = "AskAnswer" -> "impl"
     [] OTHER -> s)
C3 == stage \in StopStages => EnabledActors \subseteq NextActor(stage)
C3b == [][(stage \in StopStages) => (stage' = NextStage(stage, ev'.act))]_vars

\* ---- 残るリスクの測定（性質ではない） ----
\* I1（Z1）真の MEDIUM が LOW として PR 本文に載ったままマージされない
I1 == stage = "merged" => \A d \in Real : ~(Kind[d] = "MED" /\ ds[d] = "logged")
\* I2 報告して止まるのは真の原因が除けない環境のときだけ
I2 == [][ev'.act = "HandleEnvU" => chkTrue = "envU"]_vars
\* I4 見逃された真の MEDIUM がマージに届かない（レビューの見逃しの測定）
I4 == stage = "merged" => \A d \in Real : ~(Kind[d] = "MED" /\ ds[d] = "latent")
=============================================================================
