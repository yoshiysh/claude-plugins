---------------------------- MODULE Flow ----------------------------
(***************************************************************************)
(* #207 の作業の流れの模型（第 4 版）。1 つの変更の生涯を表す。            *)
(* 注釈は design-v6 の workflow.md の見出し（WF-nn）で引く。決定との対応は *)
(* results.tsv・table.tsv の source 列。                                    *)
(*                                                                         *)
(* Model = "decided": 利用者の決定（D1〜AA4 と answers.txt の導けた答え、   *)
(*   集約役が導いた「規模の判定の誤りは重大度なしで設計へ戻す」）           *)
(* Model = "v6":      design-v6/rules.tsv と files.tsv の workflow.md どおり *)
(*   decided との差: WF-13 の数の照合（重大度の返り値が壊れていれば同じ    *)
(*   入力でやり直す）。WF19=FALSE は rules.tsv の「WF-19 未決」の版。       *)
(*                                                                         *)
(* 担い手: builder / reviewer / sevagent（severity-assigner）/ orch / bot / *)
(*   human。TLC の結果は有限の定数での欠陥の証拠で、証明ではない。         *)
(*                                                                         *)
(* 誤りを表す（有効にしたまま性質を見る）                                    *)
(*   SevErr 付け間違い / MisBudget 誤分類 / FpBudget 誤検出（id 9）/        *)
(*   ReBudget 持ち込み / SjBudget 規模の誤判定（id 0）/ BadBudget 重大度の  *)
(*   返り値の破損（WF-13）/ DraftBudget 作業中に来る指摘の数（状態数を抑え  *)
(*   る抽象化）                                                             *)
(* 仮定（外した版を回す）: F1 持ち込みは有限回 / F2 環境の失敗は有限回 /   *)
(*   F5 誤分類は有限回 / F6 記録・規模の判定を読む reviewer は誤りを見落と  *)
(*   さない / F7 弱公平性 / F8 誤検出は有限回 / F9 返り値の破損は有限回     *)
(* 外した性質: 旧 P6inv（W4 の読みで決定に無い）、旧 C4（ready の後に戻って *)
(*   も draft に戻さない: AA2）。変異専用の行動（AskAnswer・Resume）は      *)
(*   NonDone を規則と 1 対 1 にするため外し、変異は既存の行動の中で表す。   *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Model, Mut, WF19, SevErr, RecCorrect,
          EnvBudget, MisBudget, ReBudget, FpBudget, SjBudget, DraftBudget, BadBudget,
          EnvUnb, MisUnb, ReUnb, FpUnb, BadUnb

Real == {1, 2}
FP == 9
DD == Real \cup {0}
Kind == [d \in Real |-> IF d = 1 THEN "MED" ELSE "LOW"]
Actors == {"builder", "reviewer", "sevagent", "orch", "bot", "human"}
Agents == Actors \ {"human"}
TriageStages == {"dtriage", "itriage", "ptriage", "htriage"}
AfterDR == {"impl", "ireview", "itriage", "wake", "prbot", "ptriage", "gate", "htriage", "merged"}
PRStages == {"wake", "prbot", "ptriage", "gate", "htriage", "merged"}
WorkStages == {"design", "impl"}
ReworkStages == {"design", "dreview", "dtriage", "impl", "ireview", "itriage"}
Terminal == {"merged", "reported"}
AllowedStop == {"gate", "merged", "reported"}
StopStages == {"gate", "ask", "merged", "reported"}
NextActor(s) == IF s = "gate" THEN {"human"} ELSE {}

VARIABLES stage, scale, sj, place, pr, ds, pend, inbox, inboxR, drOK, irOK, irEver,
          botOK, envLeft, misLeft, reLeft, fpLeft, sjLeft, dLeft, badLeft,
          chk, chkTrue, chkD, cls, rec, selfSeen, hc, bc, ev

vars == <<stage, scale, sj, place, pr, ds, pend, inbox, inboxR, drOK, irOK, irEver,
          botOK, envLeft, misLeft, reLeft, fpLeft, sjLeft, dLeft, badLeft,
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
Sev4 == {"MED", "LOW"}

Init ==
  /\ stage = "purpose"
  /\ scale \in {"typo", "other"} /\ sj = "unset"
  /\ place = "unset" /\ pr = "none"
  /\ ds = [d \in DD |-> IF d = 0 THEN "none" ELSE "latent"]
  /\ pend = {} /\ inbox = {} /\ inboxR = {}
  /\ drOK = FALSE /\ irOK = FALSE /\ irEver = FALSE /\ botOK = FALSE
  /\ envLeft = EnvBudget /\ misLeft = MisBudget /\ reLeft = ReBudget
  /\ fpLeft = FpBudget /\ sjLeft = SjBudget /\ dLeft = DraftBudget /\ badLeft = BadBudget
  /\ chk = "idle" /\ chkTrue = "none" /\ chkD = 0 /\ cls = "none"
  /\ rec = {} /\ selfSeen = {} /\ hc = {} /\ bc = {}
  /\ ev = [act |-> "Init", actor |-> "none"]

Back == stage' = "design" /\ drOK' = FALSE /\ irOK' = FALSE /\ botOK' = FALSE
Budgets == <<envLeft, misLeft, reLeft, fpLeft, sjLeft, dLeft, badLeft>>

\* WF-01 目的の固定・WF-02 規模の判定（builder は誤って判じうる）
FixPurpose ==
  /\ stage = "purpose"
  /\ \E j \in IF sjLeft > 0 THEN {"typo", "other"} ELSE {scale} :
       /\ sj' = j
       /\ sjLeft' = IF j = scale THEN sjLeft ELSE sjLeft - 1
       /\ place' \in IF Mut = "PlaceAny" THEN {"prBody", "commit"} ELSE {PlaceFor(j)}
       /\ ds' = [ds EXCEPT ![0] = IF j = scale THEN "none" ELSE "latent"]
  /\ pr' = "draft" /\ stage' = "design"
  /\ SetEv("FixPurpose", "builder")
  /\ UNCHANGED <<scale, pend, inbox, inboxR, drOK, irOK, irEver, botOK,
                 envLeft, misLeft, reLeft, fpLeft, dLeft, badLeft,
                 chk, chkTrue, chkD, cls, rec, selfSeen, hc, bc>>

\* WF-03 設計の作業・WF-04 実装の作業（修正が欠陥を持ち込みうる: F1）
Work ==
  /\ stage \in WorkStages /\ chk = "idle"
  /\ \E R \in IF reLeft > 0 THEN {{}} \cup {{d} : d \in Fixed} ELSE {{}} :
       /\ ds' = [d \in DD |-> IF d \in R THEN "latent" ELSE ds[d]]
       /\ reLeft' = IF R = {} THEN reLeft ELSE Dec(reLeft, ReUnb)
       /\ hc' = hc \ R /\ bc' = bc \ R /\ selfSeen' = selfSeen \ R
  /\ \/ /\ stage = "design"
        /\ stage' = (IF Mut = "SkipDR" THEN "impl" ELSE "dreview")
        /\ UNCHANGED <<pr, irOK, irEver>>
     \/ /\ stage = "impl"
        /\ IF Mut = "SkipIR"
             THEN stage' = "prbot" /\ pr' = "ready" /\ UNCHANGED <<irOK, irEver>>
             ELSE stage' = "ireview" /\ UNCHANGED <<pr, irOK, irEver>>
  /\ SetEv("Work", "builder")
  /\ UNCHANGED <<scale, sj, place, pend, inbox, inboxR, drOK, botOK,
                 envLeft, misLeft, fpLeft, sjLeft, dLeft, badLeft,
                 chk, chkTrue, chkD, cls, rec>>

\* WF-05 作り手の検査（直していない欠陥は PR 本文に載っていても再び落ちる）
SelfCheckFail ==
  /\ stage \in WorkStages /\ chk = "idle"
  /\ \/ \E d \in OpenReal : chkTrue' = "defect" /\ chkD' = d /\ selfSeen' = selfSeen \cup {d}
                            /\ UNCHANGED envLeft
     \/ envLeft > 0 /\ chkTrue' \in {"envR", "envU"} /\ chkD' = 0
        /\ envLeft' = Dec(envLeft, EnvUnb) /\ UNCHANGED selfSeen
  /\ chk' = "fail"
  /\ SetEv("SelfCheck", "builder")
  /\ UNCHANGED <<stage, scale, sj, place, pr, ds, pend, inbox, inboxR, drOK, irOK, irEver,
                 botOK, misLeft, reLeft, fpLeft, sjLeft, dLeft, badLeft, cls, rec, hc, bc>>

\* WF-06 分類と記録
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
  /\ UNCHANGED <<stage, scale, sj, place, pr, ds, pend, inbox, inboxR, drOK, irOK, irEver,
                 botOK, envLeft, reLeft, fpLeft, sjLeft, dLeft, badLeft,
                 chkTrue, chkD, selfSeen, hc, bc>>

Reset == chk' = "idle" /\ cls' = "none" /\ chkTrue' = "none" /\ chkD' = 0
Retry == chk' = "fail" /\ cls' = "none" /\ UNCHANGED <<chkTrue, chkD>>

\* WF-07 欠陥: 重大度を付けずに設計へ戻す
HandleDefect ==
  /\ chk = "cls" /\ cls = "defect"
  /\ IF chkTrue = "defect" /\ Mut # "SelfLowLog"
       THEN Back /\ ds' = [ds EXCEPT ![chkD] = "fixed"]
       ELSE IF chkTrue = "defect"
         THEN stage' = stage /\ ds' = [ds EXCEPT ![chkD] = "logged"] /\ UNCHANGED <<drOK, irOK, botOK>>
         ELSE Back /\ UNCHANGED ds
  /\ Reset
  /\ SetEv("HandleDefect", "orch")
  /\ UNCHANGED <<scale, sj, place, pr, pend, inbox, inboxR, irEver, Budgets,
                 rec, selfSeen, hc, bc>>

\* WF-08 除ける環境: その場でやり直す（真の原因が欠陥なら覆われうる）
HandleEnvR ==
  /\ chk = "cls" /\ cls = "envR"
  /\ IF Mut = "EnvRToDesign"
       THEN Back /\ Reset
       ELSE /\ stage' = stage /\ UNCHANGED <<drOK, irOK, botOK>>
            /\ CASE chkTrue = "envR" -> Reset
                 [] chkTrue = "defect" -> Reset \/ Retry
                 [] OTHER -> Retry
  /\ SetEv("HandleEnvR", "builder")
  /\ UNCHANGED <<scale, sj, place, pr, ds, pend, inbox, inboxR, irEver, Budgets,
                 rec, selfSeen, hc, bc>>

\* WF-09 除けない環境: 記録した分類と理由を報告して止まる
HandleEnvU ==
  /\ chk = "cls" /\ cls = "envU"
  /\ IF Mut = "EnvURetry"
       THEN stage' = stage /\ Retry /\ SetEv("HandleEnvU", "builder")
       ELSE stage' = "reported" /\ Reset /\ SetEv("HandleEnvU", "orch")
  /\ UNCHANGED <<scale, sj, place, pr, ds, pend, inbox, inboxR, drOK, irOK, irEver, botOK,
                 Budgets, rec, selfSeen, hc, bc>>

\* WF-11 設計レビュー・WF-12 実装レビュー。記録を読み誤分類で残った欠陥を
\* 自己検査の指摘にする。設計レビューは規模の判定も確かめる（WF-02）
Review ==
  /\ stage \in {"dreview", "ireview"}
  /\ LET RF == {r.d : r \in {x \in rec : x.tru = "defect" /\ ds[x.d] \in {"latent", "logged"}}}
         SF == IF stage = "dreview" /\ ds[0] = "latent" THEN {0} ELSE {}
     IN \E RS \in IF Mut = "SkipRecReview" THEN {{}}
                  ELSE IF RecCorrect THEN {RF} ELSE SUBSET RF :
        \E SS \in IF RecCorrect THEN {SF} ELSE SUBSET SF :
        \E S \in SUBSET (OpenReal \ RS) :
        \E P \in FpOpts(fpLeft) :
          /\ pend' = Mk(S \cup P, "agent") \cup Mk(RS, "self") \cup Mk(SS, "scale")
          /\ fpLeft' = IF P = {} THEN fpLeft ELSE Dec(fpLeft, FpUnb)
  /\ rec' = IF Mut = "SkipRecReview" THEN rec ELSE {}
  /\ stage' = IF stage = "dreview" THEN "dtriage" ELSE "itriage"
  /\ SetEv("Review", IF Mut = "SelfReview" THEN "builder" ELSE "reviewer")
  /\ UNCHANGED <<scale, sj, place, pr, ds, inbox, inboxR, drOK, irOK, irEver, botOK,
                 envLeft, misLeft, reLeft, sjLeft, dLeft, badLeft,
                 chk, chkTrue, chkD, cls, selfSeen, hc, bc>>

\* WF-15 bot の起こし直し: ready の後の作り直しの後、司令塔が close・reopen で
\* bot を起こし、run の完了を待つ（AA2）
Wake ==
  /\ stage = "wake"
  /\ stage' = IF Mut = "NoWait" THEN "ptriage" ELSE "prbot"
  /\ SetEv("Wake", "orch")
  /\ UNCHANGED <<scale, sj, place, pr, ds, pend, inbox, inboxR, drOK, irOK, irEver, botOK,
                 Budgets, chk, chkTrue, chkD, cls, rec, selfSeen, hc, bc>>

\* WF-15 bot: 自分の重大度を付けて指摘する
BotReview ==
  /\ stage = "prbot"
  /\ \E S \in SUBSET OpenReal : \E P \in FpOpts(fpLeft) :
     \E sv \in [S \cup P -> {"MED", "LOW"}] :
       /\ \A d \in S \cup P : sv[d] \in SevVals(d)
       /\ pend' = {F(x, "bot", sv[x], "bot") : x \in S \cup P}
       /\ fpLeft' = IF P = {} THEN fpLeft ELSE Dec(fpLeft, FpUnb)
  /\ stage' = "ptriage" /\ botOK' = TRUE
  /\ SetEv("BotReview", "bot")
  /\ UNCHANGED <<scale, sj, place, pr, ds, inbox, inboxR, drOK, irOK, irEver,
                 envLeft, misLeft, reLeft, sjLeft, dLeft, badLeft,
                 chk, chkTrue, chkD, cls, rec, selfSeen, hc, bc>>

\* WF-10 draft の間に来た人・bot の指摘: 受け箱に入れる
DraftHuman ==
  /\ pr = "draft" /\ stage \notin {"purpose"} \cup Terminal /\ dLeft > 0
  /\ \E d \in OpenAll \ hc : inbox' = inbox \cup {F(d, "human", "none", "none")} /\ hc' = hc \cup {d}
  /\ dLeft' = dLeft - 1
  /\ SetEv("DraftHuman", "human")
  /\ UNCHANGED <<stage, scale, sj, place, pr, ds, pend, inboxR, drOK, irOK, irEver, botOK,
                 envLeft, misLeft, reLeft, fpLeft, sjLeft, badLeft,
                 chk, chkTrue, chkD, cls, rec, selfSeen, bc>>

DraftBot ==
  /\ pr = "draft" /\ stage \notin {"purpose"} \cup Terminal /\ dLeft > 0
  /\ \E d \in OpenReal \ bc : \E v \in SevVals(d) :
       inbox' = inbox \cup {F(d, "bot", v, "bot")} /\ bc' = bc \cup {d}
  /\ dLeft' = dLeft - 1
  /\ SetEv("DraftBot", "bot")
  /\ UNCHANGED <<stage, scale, sj, place, pr, ds, pend, inboxR, drOK, irOK, irEver, botOK,
                 envLeft, misLeft, reLeft, fpLeft, sjLeft, badLeft,
                 chk, chkTrue, chkD, cls, rec, selfSeen, hc>>

\* WF-19 ready の後に戻った間に来た人の指摘（bot は push では走らない: WF-15）
ReworkHuman ==
  /\ pr = "ready" /\ stage \in ReworkStages /\ dLeft > 0
  /\ \E d \in OpenAll \ hc : inboxR' = inboxR \cup {F(d, "human", "none", "none")} /\ hc' = hc \cup {d}
  /\ dLeft' = dLeft - 1
  /\ SetEv("ReworkHuman", "human")
  /\ UNCHANGED <<stage, scale, sj, place, pr, ds, pend, inbox, drOK, irOK, irEver, botOK,
                 envLeft, misLeft, reLeft, fpLeft, sjLeft, badLeft,
                 chk, chkTrue, chkD, cls, rec, selfSeen, bc>>

\* WF-13 重大度: agent の指摘にだけ sevagent が付ける。返り値が壊れうる（F9）
AssignSev ==
  /\ stage \in TriageStages
  /\ \E f \in pend :
       /\ f.sev = "none"
       /\ f.src = "agent" \/ (Mut = "SevOnHuman" /\ f.src = "human")
                          \/ (Mut = "ScaleSev" /\ f.src = "scale")
       /\ \E v \in SevVals(f.d) \cup (IF badLeft > 0 THEN {"bad"} ELSE {}) :
            LET who == IF Mut = "OrchSev" THEN "orch" ELSE "sevagent"
            IN /\ pend' = (pend \ {f}) \cup {[f EXCEPT !.sev = v, !.by = who]}
               /\ badLeft' = IF v = "bad" THEN Dec(badLeft, BadUnb) ELSE badLeft
               /\ SetEv("AssignSev", who)
  /\ UNCHANGED <<stage, scale, sj, place, pr, ds, inbox, inboxR, drOK, irOK, irEver, botOK,
                 envLeft, misLeft, reLeft, fpLeft, sjLeft, dLeft,
                 chk, chkTrue, chkD, cls, rec, selfSeen, hc, bc>>

\* WF-13 数の照合: 壊れた重大度を見つけたら同じ入力でやり直す（v6 だけ）
Recount ==
  /\ Model = "v6" /\ Mut # "NoCount"
  /\ stage \in TriageStages
  /\ \E f \in pend :
       /\ f.src = "agent" /\ f.sev = "bad"
       /\ pend' = (pend \ {f}) \cup {[f EXCEPT !.sev = "none", !.by = "none"]}
  /\ SetEv("Recount", "orch")
  /\ UNCHANGED <<stage, scale, sj, place, pr, ds, inbox, inboxR, drOK, irOK, irEver, botOK,
                 Budgets, chk, chkTrue, chkD, cls, rec, selfSeen, hc, bc>>

Absorbs == stage \in {"dtriage", "itriage"} /\ Mut # "InboxIgnored"
AbsorbsR == Absorbs /\ (Model = "decided" \/ WF19)
All == pend \cup (IF Absorbs THEN inbox ELSE {}) \cup (IF AbsorbsR THEN inboxR ELSE {})

TriageGuard ==
  \/ Mut \in {"TriageNoSev", "NoCount"}
  \/ \A f \in All : f.src = "agent" => f.sev \in Sev4

\* 抜粋 B: 設計に戻す指摘か（WF-07・WF-14・WF-16・WF-18・WF-02）
IsBack(f) ==
  CASE f.src = "human" -> Mut # "HumanLowNotFixed"
    [] f.src = "self" -> Mut # "SelfLowLog"
    [] f.src = "scale" /\ f.sev = "none" -> TRUE
    [] Mut = "MedPass" -> FALSE
    [] Mut = "LowFix" -> TRUE
    [] OTHER -> f.sev = "MED"

PassTarget(s) ==
  CASE s = "dtriage" -> IF Mut = "StuckAfterReview" THEN "ask" ELSE "impl"
    [] s = "itriage" -> IF pr = "ready"
                          THEN (IF Mut = "NoWake" THEN "gate" ELSE "wake")
                          ELSE "prbot"
    [] OTHER -> "gate"

\* WF-14 振り分け・WF-16・WF-18。ready の後に戻っても draft に戻さない
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
             ELSE /\ stage' = PassTarget(stage)
                  /\ drOK' = (drOK \/ stage = "dtriage")
                  /\ irOK' = (irOK \/ stage = "itriage")
                  /\ irEver' = (irEver \/ stage = "itriage")
                  /\ pr' = IF stage = "itriage" THEN "ready" ELSE pr
                  /\ UNCHANGED botOK
  /\ pend' = {}
  /\ inbox' = IF Absorbs THEN {} ELSE inbox
  /\ inboxR' = IF AbsorbsR THEN {} ELSE inboxR
  /\ SetEv("Triage", "orch")
  /\ UNCHANGED <<scale, Budgets, chk, chkTrue, chkD, cls, rec, selfSeen, hc, bc>>

Static == <<scale, sj, place, pr, ds, pend, inbox, inboxR, drOK, irOK, irEver, botOK,
            Budgets, chk, chkTrue, chkD, cls, rec, selfSeen, hc, bc>>

\* WF-17 人間ゲート
HumanComment ==
  /\ stage = "gate"
  /\ \E d \in OpenAll \ hc : pend' = Mk({d}, "human") /\ hc' = hc \cup {d}
  /\ stage' \in IF Mut = "GateAmbiguous" THEN {"htriage", "gate"} ELSE {"htriage"}
  /\ SetEv("HumanComment", "human")
  /\ UNCHANGED <<scale, sj, place, pr, ds, inbox, inboxR, drOK, irOK, irEver, botOK,
                 Budgets, chk, chkTrue, chkD, cls, rec, selfSeen, bc>>

HumanMerge ==
  /\ stage = "gate" /\ stage' = "merged"
  /\ SetEv("HumanMerge", "human") /\ UNCHANGED Static

NonDone ==
  \/ FixPurpose \/ Work \/ SelfCheckFail \/ Classify
  \/ HandleDefect \/ HandleEnvR \/ HandleEnvU
  \/ Review \/ Wake \/ BotReview \/ DraftHuman \/ DraftBot \/ ReworkHuman
  \/ AssignSev \/ Recount \/ Triage
  \/ HumanComment \/ HumanMerge

\* WF-20 終わり
Done == stage \in Terminal /\ UNCHANGED vars
Next == NonDone \/ Done
Spec == Init /\ [][Next]_vars /\ WF_vars(NonDone)

-----------------------------------------------------------------------------
EnabledActors == {a \in Actors : ENABLED (NonDone /\ ev'.actor = a)}
AgentsIdle == ~ENABLED (NonDone /\ ev'.actor \in Agents)
IsTriage == ev'.act = "Triage"
Tr == All
NoSevSrc == {"self", "human", "scale"}

\* ---- 決定に結びつく性質 ----
\* P1（W4・Y2・answers.txt:42・規模の判定の誤り）振り分けで agent の指摘には
\*   4 値の重大度が付き、自己検査・人・規模の判定の指摘には付かない
P1 == [][IsTriage => \A f \in Tr :
           /\ f.src = "agent" => f.sev \in Sev4
           /\ f.src \in NoSevSrc => f.sev = "none"]_vars
\* P2（Y2・Y4）重大度を付けるのは sevagent、bot の指摘は bot
P2 == \A f \in pend \cup inbox \cup inboxR : f.sev # "none" =>
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
\*   設計に戻らない
DecBack(g) == g.src \in NoSevSrc \/ g.sev = "MED"
P6 == [][IsTriage =>
          /\ \A f \in Tr :
               (/\ f.src \in {"agent", "bot"} /\ f.sev = "LOW" /\ f.d \in DD
                /\ ds[f.d] # "fixed"
                /\ ~\E g \in Tr : g.d = f.d /\ DecBack(g))
                 => ds'[f.d] = "logged"
          /\ (\A f \in Tr : ~DecBack(f)) => stage' # "design"]_vars
\* P7（X3・D1・AA4）人の指摘は、来た時機を問わず、重大度を問わず設計に戻る
P7 == [][IsTriage => \A f \in Tr :
           f.src = "human" => (stage' = "design" /\ ds'[f.d] = "fixed")]_vars
\* P8（Q5・Y3・answers.txt:42）自己検査で出た欠陥は、誤分類されていても、
\*   ready の段に入る前に直る
P8 == stage \in PRStages => \A d \in selfSeen : ds[d] = "fixed"
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
\* P13（AGENTS.md:76・Y3）レビューと重大度は builder 以外、記録は段のレビュー
\*   を通る前に builder 以外が読む
P13 == /\ ev.act \in {"Review", "AssignSev"} => ev.actor # "builder"
       /\ (stage \in {"impl", "prbot", "wake"} /\ ev.act = "Triage") => rec = {}
\* P14（D1・Q9・X2）終端に到達する（F1・F2・F5・F6・F7・F8・F9 の下）
P14 == <>(stage \in Terminal)
\* P15（X1・規模の判定の誤り）ready の段では置き場が真の規模で決まっている
P15 == stage \in PRStages => place = PlaceFor(scale)
\* P16（Z3・AA4）作業中（draft の間と ready の後の戻りの間）に来た指摘は、その
\*   段のレビューの後の振り分けで扱われ、ready の段に持ち越さない
P16 == stage \in PRStages => inbox = {} /\ inboxR = {}
P16a == [][(IsTriage /\ stage \in {"dtriage", "itriage"}) => (inbox' = {} /\ inboxR' = {})]_vars
\* P17（Y4・AA2）人間ゲートに入るのは、今の版を bot が見た後だけ
P17 == stage \in {"gate", "htriage", "merged"} => botOK

\* ---- 実行可能性の制約（決定ではない） ----
C1 == (stage # "purpose" /\ place = "prBody") => pr # "none"
C2 == \A d \in DD : ds[d] = "logged" => pr # "none"
NextStage(s, a) ==
  (CASE s = "gate" /\ a = "HumanComment" -> "htriage"
     [] s = "gate" /\ a = "HumanMerge" -> "merged"
     [] OTHER -> s)
C3 == stage \in StopStages => EnabledActors \subseteq NextActor(stage)
C3b == [][(stage \in StopStages) => (stage' = NextStage(stage, ev'.act))]_vars

\* ---- 残るリスクの測定（性質ではない） ----
I1 == stage = "merged" => \A d \in Real : ~(Kind[d] = "MED" /\ ds[d] = "logged")
I2 == [][ev'.act = "HandleEnvU" => chkTrue = "envU"]_vars
I4 == stage = "merged" => \A d \in Real : ~(Kind[d] = "MED" /\ ds[d] = "latent")
=============================================================================
