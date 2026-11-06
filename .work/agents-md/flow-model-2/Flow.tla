---------------------------- MODULE Flow ----------------------------
(***************************************************************************)
(* #207 の作業の流れの模型（第 2 版）。1 つの変更の生涯を表す。            *)
(* 段: 目的の固定（draft PR を作る: Y1）-> 設計 -> 設計レビュー -> 実装    *)
(*     -> 実装レビュー -> ready -> bot -> 人間ゲート -> マージ。            *)
(*     除けない失敗は報告して停止（Q9）。                                  *)
(* TLC の結果は有限の定数での欠陥の証拠で、証明ではない。                  *)
(*                                                                         *)
(* 担い手: builder（作り手。目的・設計・実装を書く。FQ5 は main            *)
(*   AGENTS.md:95-99 から導ける）/ reviewer（設計・実装のレビュー役）/     *)
(*   sevagent（重大度を付ける専用の agent 1 体: Y2）/ orch（司令塔: 段の    *)
(*   選択と relay だけ）/ bot / human。                                     *)
(*                                                                         *)
(* 誤りを表す定数（決定どおりの版では TRUE にして、それでも性質が守られる   *)
(* かを見る）                                                               *)
(*   SevErr    重大度の付け手（sevagent・bot）は真の重大度と違う値を付けうる *)
(*   MisBudget builder は自己検査の失敗の原因を誤って分類しうる（回数）    *)
(* 誤りを抑える仕組み                                                       *)
(*   Y3: builder は環境の原因と判じた分類と理由を記録（rec）し、次のレビュー *)
(*       （reviewer）が記録を読み、誤分類で残った欠陥を指摘にする。        *)
(*   Y2: 重大度は sevagent が付ける（生成者・司令塔・指摘した者と別）。     *)
(*   W4: LOW は PR 本文に載る（logged）。付け間違えた MEDIUM も PR 本文に  *)
(*       見え、人の指摘（X3）で直る経路が残る。                             *)
(*                                                                         *)
(* 仮定（P8・P14 の前提。外した版も results.tsv で回す）                    *)
(*   F1 修正が欠陥を持ち込むのは有限回（ReBudget。ReUnb=TRUE で外す）       *)
(*   F2 環境の失敗は有限回（EnvBudget。EnvUnb=TRUE で外す）                 *)
(*   F3 人は同じ欠陥を二度指摘しない（HumanRepeat=TRUE で外す）             *)
(*   F5 誤分類は有限回（MisBudget。MisUnb=TRUE で外す）                     *)
(*   F6 記録を読んだレビュー役は誤分類を見落とさない（RecCorrect=FALSE で  *)
(*      外す）                                                              *)
(*   F7 担い手の行動全体に弱公平性 WF_vars(NonDone)                         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Model, Mut, SelfLow, SevErr, RecCorrect, Redraft,
          EnvBudget, MisBudget, ReBudget, EnvUnb, MisUnb, ReUnb, HumanRepeat

Defects == {1, 2}
Kind == [d \in Defects |-> IF d = 1 THEN "MED" ELSE "LOW"]
Actors == {"builder", "reviewer", "sevagent", "orch", "bot", "human"}
Agents == Actors \ {"human"}
TriageStages == {"dtriage", "itriage", "ptriage", "htriage", "striage"}
AfterDR == {"impl", "ireview", "itriage", "pubgate", "prbot", "ptriage",
            "gate", "htriage", "merged"}
PRStages == {"prbot", "ptriage", "gate", "htriage", "merged"}
Terminal == {"merged", "reported"}
AllowedStop == {"gate", "merged", "reported"}
StopStages == {"gate", "pubgate", "ask", "merged", "reported"}
NextActor(s) == IF s \in {"gate", "pubgate", "ask"} THEN {"human"} ELSE {}

VARIABLES stage, scale, place, pr, ds, pend, drOK, irOK, irEver,
          envLeft, misLeft, reLeft, chk, chkTrue, chkD, cls, wst,
          rec, selfSeen, hc, ev

vars == <<stage, scale, place, pr, ds, pend, drOK, irOK, irEver,
          envLeft, misLeft, reLeft, chk, chkTrue, chkD, cls, wst,
          rec, selfSeen, hc, ev>>

PlaceFor(s) == IF s = "typo" THEN "prBody" ELSE "commit"
Latent == {d \in Defects : ds[d] = "latent"}
Open == {d \in Defects : ds[d] \in {"latent", "logged"}}
Mk(S, src) == {[d |-> x, src |-> src, sev |-> "none", by |-> "none"] : x \in S}
SetEv(a, who) == ev' = [act |-> a, actor |-> who]
Dec(n, unb) == IF unb THEN n ELSE n - 1
SevVals(d) == IF SevErr THEN {"MED", "LOW"} ELSE {Kind[d]}

\* Y2 を FQ3・FQ7・FQ8 を束ねた問いへの答えと読み、bot 以外の全ての指摘に
\* sevagent が重大度を付ける（bot は自分の重大度をそのまま使う: Y4）
NeedSev(src) == src \in {"agent", "self", "human"}

Init ==
  /\ stage = "purpose"
  /\ scale \in {"typo", "other"}
  /\ place = "unset"
  /\ pr = "none"
  /\ ds = [d \in Defects |-> "latent"]
  /\ pend = {}
  /\ drOK = FALSE /\ irOK = FALSE /\ irEver = FALSE
  /\ envLeft = EnvBudget /\ misLeft = MisBudget /\ reLeft = ReBudget
  /\ chk = "idle" /\ chkTrue = "none" /\ chkD = 0 /\ cls = "none"
  /\ wst = "none"
  /\ rec = {} /\ selfSeen = {} /\ hc = {}
  /\ ev = [act |-> "Init", actor |-> "none"]

BackFlags == drOK' = FALSE /\ irOK' = FALSE
             /\ pr' = IF Redraft /\ pr = "ready" THEN "draft" ELSE pr

\* 目的の固定（X1・Y1）
FixPurpose ==
  /\ stage = "purpose"
  /\ IF Model = "v4" \/ Mut = "PlaceAny"
       THEN place' \in {"prBody", "commit"}
       ELSE place' = PlaceFor(scale)
  /\ pr' = IF Model = "v4" THEN "none" ELSE "draft"
  /\ stage' = "design"
  /\ SetEv("FixPurpose", "builder")
  /\ UNCHANGED <<scale, ds, pend, drOK, irOK, irEver, envLeft, misLeft, reLeft,
                 chk, chkTrue, chkD, cls, wst, rec, selfSeen, hc>>

\* 作業と自己検査の成功。直した欠陥を持ち込み直すことがある（F1 は有限回）
Work ==
  /\ stage \in {"design", "impl"} /\ chk = "idle"
  /\ \E R \in IF reLeft > 0 THEN {{}} \cup {{d} : d \in Defects \ (Latent \cup {x \in Defects : ds[x] = "logged"})}
                            ELSE {{}} :
       /\ ds' = [d \in Defects |-> IF d \in R THEN "latent" ELSE ds[d]]
       /\ reLeft' = IF R = {} THEN reLeft ELSE Dec(reLeft, ReUnb)
       /\ hc' = hc \ R
       /\ selfSeen' = selfSeen \ R
  /\ \/ /\ stage = "design"
        /\ stage' = IF Mut = "SkipDR" THEN "impl" ELSE "dreview"
        /\ UNCHANGED <<pr, irOK, irEver>>
     \/ /\ stage = "impl"
        /\ IF Mut = "SkipIR"
             THEN stage' = "prbot" /\ pr' = "ready" /\ UNCHANGED <<irOK, irEver>>
             ELSE stage' = "ireview" /\ UNCHANGED <<pr, irOK, irEver>>
  /\ SetEv("Work", "builder")
  /\ UNCHANGED <<scale, place, pend, drOK, envLeft, misLeft, chk, chkTrue, chkD, cls, wst, rec>>

\* 自己検査の失敗（真の原因は builder に見えない）
SelfCheckFail ==
  /\ stage \in {"design", "impl"} /\ chk = "idle"
  /\ \/ \E d \in Latent : chkTrue' = "defect" /\ chkD' = d /\ selfSeen' = selfSeen \cup {d}
                          /\ UNCHANGED envLeft
     \/ /\ envLeft > 0 /\ chkTrue' \in {"envR", "envU"} /\ chkD' = 0
        /\ envLeft' = Dec(envLeft, EnvUnb) /\ UNCHANGED selfSeen
  /\ chk' = "fail"
  /\ SetEv("SelfCheck", "builder")
  /\ UNCHANGED <<stage, scale, place, pr, ds, pend, drOK, irOK, irEver, misLeft, reLeft,
                 cls, wst, rec, hc>>

\* builder が原因を分類し、環境と判じたものは分類と理由を記録する（Y3）
Classify ==
  /\ chk = "fail"
  /\ \E c \in {"defect", "envR", "envU"} :
       /\ c = chkTrue \/ misLeft > 0
       /\ misLeft' = IF c = chkTrue THEN misLeft ELSE Dec(misLeft, MisUnb)
       /\ cls' = c
       /\ rec' = IF c \in {"envR", "envU"} /\ Model = "decided" /\ Mut # "NoRecord"
                   THEN rec \cup {[d |-> chkD, cls |-> c, tru |-> chkTrue]}
                   ELSE rec
  /\ chk' = "cls"
  /\ SetEv("Classify", "builder")
  /\ UNCHANGED <<stage, scale, place, pr, ds, pend, drOK, irOK, irEver, envLeft, reLeft,
                 chkTrue, chkD, wst, selfSeen, hc>>

Reset == chk' = "idle" /\ cls' = "none" /\ chkTrue' = "none" /\ chkD' = 0

\* 成果物の欠陥と分類したもの（Q5: 設計に戻る規則に含める。W4 の閾値は
\* sevagent の重大度で当てる: SelfLow="log"。SelfLow="design" は全て戻す読み）
HandleDefect ==
  /\ chk = "cls" /\ cls = "defect"
  /\ IF chkTrue # "defect"
       THEN /\ stage' = "design" /\ BackFlags /\ UNCHANGED <<ds, pend, wst>>
       ELSE \/ /\ Model = "decided" /\ SelfLow = "design"
               /\ stage' = "design" /\ ds' = [ds EXCEPT ![chkD] = "fixed"] /\ BackFlags
               /\ UNCHANGED <<pend, wst>>
            \/ /\ Model = "decided" /\ SelfLow = "log"
               /\ pend' = Mk({chkD}, "self") /\ wst' = stage /\ stage' = "striage"
               /\ UNCHANGED <<ds, drOK, irOK, pr>>
            \* v4: 自己検査も重大度で振り分けるが付ける者が無い（files.tsv:12 (4)）
            \/ /\ Model = "v4"
               /\ pend' = Mk({chkD}, "self") /\ wst' = stage /\ stage' = "striage"
               /\ UNCHANGED <<ds, drOK, irOK, pr>>
  /\ Reset
  /\ SetEv("HandleDefect", "orch")
  /\ UNCHANGED <<scale, place, irEver, envLeft, misLeft, reLeft, rec, selfSeen, hc>>

\* 除ける環境の原因と分類したもの: 原因を除いて同じ検査をやり直す（Q10）
\* 真の原因が欠陥なら、やり直しで欠陥が覆われて通ることがある（V7）
HandleEnvR ==
  /\ chk = "cls" /\ cls = "envR"
  /\ IF Mut = "EnvRToDesign"
       THEN stage' = "design" /\ BackFlags /\ Reset
       ELSE /\ stage' = stage /\ UNCHANGED <<drOK, irOK, pr>>
            /\ CASE chkTrue = "envR" -> Reset
                 [] chkTrue = "defect" ->
                      \/ Reset
                      \/ chk' = "fail" /\ cls' = "none" /\ UNCHANGED <<chkTrue, chkD>>
                 [] OTHER -> chk' = "fail" /\ cls' = "none" /\ UNCHANGED <<chkTrue, chkD>>
  /\ SetEv("HandleEnvR", "builder")
  /\ UNCHANGED <<scale, place, ds, pend, irEver, envLeft, misLeft, reLeft, wst, rec, selfSeen, hc>>

\* 除けない環境の原因と分類したもの: 報告して止まる（Q9）
HandleEnvU ==
  /\ chk = "cls" /\ cls = "envU"
  /\ IF Mut = "EnvURetry"
       THEN stage' = stage /\ chk' = "fail" /\ cls' = "none" /\ UNCHANGED <<chkTrue, chkD>>
            /\ SetEv("HandleEnvU", "builder")
       ELSE stage' = "reported" /\ Reset /\ SetEv("HandleEnvU", "orch")
  /\ UNCHANGED <<scale, place, pr, ds, pend, drOK, irOK, irEver, envLeft, misLeft, reLeft,
                 wst, rec, selfSeen, hc>>

\* レビュー役の指摘。記録を読み、誤分類で残った欠陥を自己検査の指摘にする（Y3）
Review ==
  /\ stage \in {"dreview", "ireview"}
  /\ LET RF == {r.d : r \in {x \in rec : x.tru = "defect" /\ ds[x.d] = "latent"}}
     IN \E RS \in IF Mut = "SkipRecReview" THEN {{}}
                  ELSE IF RecCorrect THEN {RF} ELSE SUBSET RF :
          \E S \in SUBSET (Open \ RS) :
            pend' = Mk(S, "agent") \cup Mk(RS, "self")
  /\ rec' = IF Mut = "SkipRecReview" THEN rec ELSE {}
  /\ stage' = IF stage = "dreview" THEN "dtriage" ELSE "itriage"
  /\ SetEv("Review", IF Mut = "SelfReview" THEN "builder" ELSE "reviewer")
  /\ UNCHANGED <<scale, place, pr, ds, drOK, irOK, irEver, envLeft, misLeft, reLeft,
                 chk, chkTrue, chkD, cls, wst, selfSeen, hc>>

\* bot は自分の重大度を付けて指摘する（Y4）。v4 には bot の段が無い
BotReview ==
  /\ stage = "prbot"
  /\ \E S \in SUBSET Open :
       \E sv \in [S -> {"MED", "LOW"}] :
         /\ \A d \in S : sv[d] \in SevVals(d)
         /\ pend' = {[d |-> x, src |-> "bot", sev |-> sv[x], by |-> "bot"] : x \in S}
  /\ stage' = "ptriage"
  /\ SetEv("BotReview", "bot")
  /\ UNCHANGED <<scale, place, pr, ds, drOK, irOK, irEver, envLeft, misLeft, reLeft,
                 chk, chkTrue, chkD, cls, wst, rec, selfSeen, hc>>

\* 重大度を付ける。決定どおりでは sevagent（Y2）。v4 は設計段・自己検査・人の
\* 指摘で付ける者を決めておらず、付けるなら残る司令塔（未定ゆえ非決定。V1）
Assigner(s, src) ==
  IF Mut = "OrchSev" THEN "orch"
  ELSE IF Model = "decided" THEN "sevagent"
  ELSE IF s = "itriage" /\ src = "agent" THEN "reviewer"
  ELSE "orch"

AssignSev ==
  /\ stage \in TriageStages
  /\ \E f \in pend :
       /\ f.sev = "none" /\ NeedSev(f.src)
       /\ \E v \in SevVals(f.d) :
            /\ pend' = (pend \ {f}) \cup {[f EXCEPT !.sev = v, !.by = Assigner(stage, f.src)]}
            /\ SetEv("AssignSev", Assigner(stage, f.src))
  /\ UNCHANGED <<stage, scale, place, pr, ds, drOK, irOK, irEver, envLeft, misLeft, reLeft,
                 chk, chkTrue, chkD, cls, wst, rec, selfSeen, hc>>

TriageGuard ==
  IF Mut = "TriageNoSev" THEN TRUE
  ELSE IF Model = "v4" THEN stage = "itriage" => \A f \in pend : f.sev # "none"
  ELSE \A f \in pend : NeedSev(f.src) => f.sev # "none"

\* 設計に戻す指摘か（W4・X3・D1）。g は付いた重大度（無ければ v4 の非決定）
Back(f, g) ==
  CASE Model = "v4" -> g[f] = "MED"
    [] Mut = "MedPass" -> f.src = "human"
    [] Mut = "LowFix" -> TRUE
    [] Mut = "HumanLowNotFixed" -> g[f] = "MED"
    [] OTHER -> f.src = "human" \/ g[f] = "MED"
                \/ (f.src = "self" /\ SelfLow = "design")

PassTargets(s) ==
  CASE s = "dtriage" -> IF Mut = "AskStop" THEN {"impl", "ask"} ELSE {"impl"}
    [] s = "itriage" -> IF Model = "v4" THEN {"gate", "pubgate"} ELSE {"prbot"}
    [] s = "striage" -> {wst}
    [] OTHER -> {"gate"}

\* 重大度による振り分け（司令塔: 閾値による段の選択で、採点ではない）
Triage ==
  /\ stage \in TriageStages
  /\ TriageGuard
  /\ \E g \in [pend -> {"MED", "LOW"}] :
       /\ \A f \in pend : f.sev # "none" => g[f] = f.sev
       /\ LET back == {f \in pend : Back(f, g)}
              fixS == {f.d : f \in back}
              lowS == {f.d : f \in pend \ back}
          IN /\ ds' = [d \in Defects |->
                         IF d \in fixS THEN "fixed"
                         ELSE IF d \in lowS THEN "logged" ELSE ds[d]]
             /\ IF fixS # {}
                  THEN /\ stage' = "design" /\ BackFlags
                       /\ UNCHANGED <<irEver, wst>>
                  ELSE /\ stage' \in PassTargets(stage)
                       /\ drOK' = (drOK \/ stage = "dtriage")
                       /\ irOK' = (irOK \/ stage = "itriage")
                       /\ irEver' = (irEver \/ stage = "itriage")
                       /\ pr' = IF stage = "itriage" THEN "ready" ELSE pr
                       /\ wst' = IF stage = "striage" THEN "none" ELSE wst
  /\ pend' = {}
  /\ SetEv(IF stage = "striage" THEN "TriageSelf" ELSE "Triage", "orch")
  /\ UNCHANGED <<scale, place, envLeft, misLeft, reLeft, chk, chkTrue, chkD, cls,
                 rec, selfSeen, hc>>

Static == <<scale, place, pr, ds, pend, drOK, irOK, irEver, envLeft, misLeft, reLeft,
            chk, chkTrue, chkD, cls, wst, rec, selfSeen, hc>>

\* v4: (7) の「人間ゲート（マージ・公開）」の公開を登録と読む場合の停止点（V16）
PubApprove ==
  /\ stage = "pubgate" /\ stage' = "gate"
  /\ SetEv("PubApprove", "human") /\ UNCHANGED Static

AskAnswer ==
  /\ stage = "ask" /\ stage' = "impl"
  /\ SetEv("AskAnswer", "human") /\ UNCHANGED Static

HumanComment ==
  /\ stage = "gate"
  /\ \E d \in IF HumanRepeat THEN Open ELSE Open \ hc :
       pend' = Mk({d}, "human") /\ hc' = hc \cup {d}
  /\ stage' = "htriage"
  /\ SetEv("HumanComment", "human")
  /\ UNCHANGED <<scale, place, pr, ds, drOK, irOK, irEver, envLeft, misLeft, reLeft,
                 chk, chkTrue, chkD, cls, wst, rec, selfSeen>>

HumanMerge ==
  /\ stage = "gate" /\ stage' = "merged"
  /\ SetEv("HumanMerge", "human") /\ UNCHANGED Static

ResumeAfterReport ==
  /\ Mut = "ResumeAfterReport" /\ stage = "reported" /\ stage' = "impl"
  /\ SetEv("Resume", "orch") /\ UNCHANGED Static

NonDone ==
  \/ FixPurpose \/ Work \/ SelfCheckFail \/ Classify
  \/ HandleDefect \/ HandleEnvR \/ HandleEnvU
  \/ Review \/ BotReview \/ AssignSev \/ Triage
  \/ PubApprove \/ AskAnswer \/ HumanComment \/ HumanMerge \/ ResumeAfterReport

\* 停止してよい終端でだけ足踏みを許す（それ以外で行動が尽きれば deadlock）
Done == stage \in Terminal /\ UNCHANGED vars

Next == NonDone \/ Done

Spec == Init /\ [][Next]_vars /\ WF_vars(NonDone)

-----------------------------------------------------------------------------
EnabledActors == {a \in Actors : ENABLED (NonDone /\ ev'.actor = a)}
AgentsIdle == ~ENABLED (NonDone /\ ev'.actor \in Agents)
IsTriage == ev'.act \in {"Triage", "TriageSelf"}

\* ---- 決定に結びつく性質 ----
\* P1（W4・Y2）振り分ける前に、bot 以外の全ての指摘に重大度が付いている
P1 == [][IsTriage => \A f \in pend : NeedSev(f.src) => f.sev # "none"]_vars
\* P2（Y2・AGENTS.md:85-87）重大度を付けるのは専用の agent（bot の指摘は bot: Y4）
P2 == \A f \in pend : f.sev # "none" =>
        (IF f.src = "bot" THEN f.by = "bot" ELSE f.by = "sevagent")
\* P3（D1）設計レビューを通らずに実装へ進まない
P3 == stage \in AfterDR => drOK
\* P4（D1・Y1）実装レビューを通らずに PR を ready にしない
P4 == /\ stage \in PRStages => irOK
      /\ pr = "ready" => irEver
\* P5（W4）MEDIUM 以上と付いた agent・bot の指摘は設計に戻る
P5 == [][IsTriage => \A f \in pend :
           (f.src \in {"agent", "bot"} /\ f.sev = "MED")
             => (stage' = "design" /\ ds'[f.d] = "fixed")]_vars
\* P6（W4）LOW と付いた agent・bot の指摘は直さず PR 本文に載る
P6 == [][IsTriage => \A f \in pend :
           (f.src \in {"agent", "bot"} /\ f.sev = "LOW") => ds'[f.d] = "logged"]_vars
\* P7（X3・D1）人の指摘は重大度を問わず設計に戻る
P7 == [][IsTriage => \A f \in pend :
           f.src = "human" => (stage' = "design" /\ ds'[f.d] = "fixed")]_vars
\* P8（Q5・W4・Y3）自己検査で出た欠陥は、ready の PR の段に入る前に、
\*   設計に戻って直るか、LOW として PR 本文に載る（誤分類されていても）
P8 == stage \in PRStages =>
        \A d \in selfSeen : ds[d] = "fixed" \/ (SelfLow = "log" /\ ds[d] = "logged")
\* P9（Q10）除ける環境の原因と分類したら、段を変えずにやり直す
P9 == [][ev'.act = "HandleEnvR" => stage' = stage]_vars
\* P10（Q9・Y3）除けない環境の原因と分類したら、分類と理由を記録して止まる
P10 == [][ev'.act = "HandleEnvU" =>
            (stage' = "reported" /\ \E r \in rec : r.cls = "envU")]_vars
\* P11（X2・Q9・AGENTS.md:70）agent が止まるのはマージの人間ゲートと報告だけ
P11 == AgentsIdle => stage \in AllowedStop
\* P13（AGENTS.md:76・Y3）生成者が自分の成果物の合否を決めない:
\*   レビューと重大度は builder 以外が行い、builder の環境の分類は、段の
\*   レビューを通る前に builder 以外が読む
P13 == /\ ev.act \in {"Review", "AssignSev"} => ev.actor # "builder"
       /\ (stage \in {"impl", "prbot"} /\ ev.act = "Triage") => rec = {}
\* P14（D1・Q9・X2）終端（マージ、または報告して停止）に到達する（F1〜F7 の下）
P14 == <>(stage \in Terminal)
\* P15（X1）成果物の置き場は規模で決まる
P15 == stage # "purpose" => place = PlaceFor(scale)

\* ---- 実行可能性の制約（決定そのものではなく、決定を実行できるための整合） ----
\* C1（X1・Y1）PR 本文を置き場にするとき、PR が存在する
C1 == (stage # "purpose" /\ place = "prBody") => pr # "none"
\* C2（W4・Y1）LOW を PR 本文に載せるとき、PR が存在する
C2 == \A d \in Defects : ds[d] = "logged" => pr # "none"
\* C3（brief 由来。AGENTS.md:70 の理由から）止まった状態の次の担い手が 1 つ
C3 == stage \in StopStages => EnabledActors \subseteq NextActor(stage)
\* C4（Y1「出す」は ready）設計に戻って直している間、PR は ready でない
C4 == pr = "ready" => irOK

\* ---- 残るリスクの測定（性質ではない。破れる経路が残ることを示す） ----
\* I1 真の重大度が MEDIUM の欠陥が、LOW として PR 本文に載ったままマージされない
I1 == stage = "merged" => \A d \in Defects : ~(Kind[d] = "MED" /\ ds[d] = "logged")
\* I2 報告して止まるのは、真の原因が除けない環境のときだけ
I2 == [][ev'.act = "HandleEnvU" => chkTrue = "envU"]_vars
=============================================================================
