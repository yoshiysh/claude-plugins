---------------------------- MODULE Flow ----------------------------
(***************************************************************************)
(* #207 の作業の流れの模型。1 つの変更（作業）の生涯を表す。                *)
(* 段: 目的の固定 -> 設計 -> 設計レビュー -> 実装 -> 実装レビュー -> PR     *)
(*     -> 人間ゲート -> マージ。除けない失敗は報告して停止。               *)
(* TLC の結果は欠陥の証拠であって証明ではない（有限の定数での網羅だけ）。    *)
(*                                                                         *)
(* 定数                                                                    *)
(*   Model        "decided" = 利用者の決定どおり / "v4" = 設計 v4 どおり    *)
(*   Mut          "none" か変異の名前（性質が空虚でないことの確認用）      *)
(*   DraftForTypo typo 級で目的の固定時に draft PR を作る（問い FQ1 の案）  *)
(*   HoldLow      PR が無い間の LOW を保留し、PR を作る時に本文へ載せる     *)
(*                （問い FQ2 の案）                                         *)
(*   EnvBudget    環境の失敗（除ける・除けない）の回数の上限                *)
(*                                                                         *)
(* 抽象化                                                                  *)
(*   欠陥は固定の有限スロット Defects。真の重大度 Kind は定数。レビューは  *)
(*   未修正の欠陥の任意の部分集合を報告する（見逃しも、PR 本文に載せ済みの *)
(*   LOW の再報告も起きる）。重大度は MEDIUM 以上を "MED" に畳む。          *)
(*   ds[d]: latent=残っている / held=PR 待ちの LOW / logged=PR 本文に載った *)
(*          LOW / fixed=設計に戻って直す対象になった                        *)
(*   ev:    直前の遷移の名前と担い手（担い手の性質を不変式で書くため）      *)
(*                                                                         *)
(* 公平性の仮定（P14 の前提）                                               *)
(*   F1 欠陥は有限個で、直した欠陥は戻らない（Defects が有限）              *)
(*   F2 環境の失敗は有限回（EnvBudget）                                     *)
(*   F3 人は同じ欠陥を二度指摘しない（hc）                                  *)
(*   F4 担い手の行動全体に弱公平性 WF_vars(NonDone)。人もゲートでいずれ動く *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Model, Mut, DraftForTypo, HoldLow, EnvBudget

Defects == {1, 2, 3}
Kind == [d \in Defects |-> IF d = 2 THEN "LOW" ELSE "MED"]
Actors == {"maker", "reviewer", "orch", "bot", "human"}
Agents == {"maker", "reviewer", "orch", "bot"}
TriageStages == {"dtriage", "itriage", "ptriage", "htriage"}
AfterDR == {"impl", "ireview", "itriage", "pubgate", "prbot", "ptriage",
            "gate", "htriage", "merged"}
PRStages == {"prbot", "ptriage", "gate", "htriage", "merged"}
Terminal == {"merged", "reported"}
AllowedStop == {"gate", "merged", "reported"}
StopStages == {"gate", "pubgate", "ask", "merged", "reported"}
NextActor(s) == IF s \in {"gate", "pubgate", "ask"} THEN {"human"} ELSE {}

VARIABLES stage, scale, place, pr, ds, logCnt, pend,
          drOK, irOK, irEver, envLeft, chk, chkD, ev, hc

vars == <<stage, scale, place, pr, ds, logCnt, pend,
          drOK, irOK, irEver, envLeft, chk, chkD, ev, hc>>

PlaceFor(s) == IF s = "typo" THEN "prBody" ELSE "commit"
Latent == {d \in Defects : ds[d] = "latent"}
Open == {d \in Defects : ds[d] \in {"latent", "held", "logged"}}
Mk(S, src) == {[d |-> x, src |-> src, sev |-> "none", by |-> "none"] : x \in S}
SetEv(a, who) == ev' = [act |-> a, actor |-> who]
LowState == IF HoldLow /\ pr = "none" THEN "held" ELSE "logged"
Inc(c) == IF c < 2 THEN c + 1 ELSE c

Init ==
  /\ stage = "purpose"
  /\ scale \in {"typo", "other"}
  /\ place = "unset"
  /\ pr = "none"
  /\ ds = [d \in Defects |-> "latent"]
  /\ logCnt = [d \in Defects |-> 0]
  /\ pend = {}
  /\ drOK = FALSE /\ irOK = FALSE /\ irEver = FALSE
  /\ envLeft = EnvBudget
  /\ chk = "idle" /\ chkD = 0
  /\ ev = [act |-> "Init", actor |-> "none"]
  /\ hc = {}

\* 目的の固定。書くのは作り手（司令塔は書かない: 作業ルール (11)。誰が書くかは FQ5）
FixPurpose ==
  /\ stage = "purpose"
  /\ IF Model = "v4" \/ Mut = "PlaceAny"
       THEN place' \in {"prBody", "commit"}
       ELSE place' = PlaceFor(scale)
  /\ pr' = IF DraftForTypo /\ scale = "typo" THEN "draft" ELSE pr
  /\ stage' = "design"
  /\ SetEv("FixPurpose", "maker")
  /\ UNCHANGED <<scale, ds, logCnt, pend, drOK, irOK, irEver, envLeft, chk, chkD, hc>>

\* 生成者の作業と自己検査が成功した場合
Work ==
  /\ stage \in {"design", "impl"} /\ chk = "idle"
  /\ \/ /\ stage = "design"
        /\ stage' = IF Mut = "SkipDR" THEN "impl" ELSE "dreview"
        /\ UNCHANGED pr
     \/ /\ stage = "impl"
        /\ IF Mut = "SkipIR"
             THEN stage' = "prbot" /\ pr' = "ready"
             ELSE stage' = "ireview" /\ pr' = pr
  /\ SetEv("Work", "maker")
  /\ UNCHANGED <<scale, place, ds, logCnt, pend, drOK, irOK, irEver, envLeft, chk, chkD, hc>>

\* 自己検査の失敗: 成果物の欠陥 / 除ける環境の原因 / 除けない環境の原因
\* 分類するのは作り手（FQ4）
SelfCheckFail ==
  /\ stage \in {"design", "impl"} /\ chk = "idle"
  /\ \/ \E d \in Latent : chk' = "defect" /\ chkD' = d
     \/ envLeft > 0 /\ chk' \in {"envR", "envU"} /\ chkD' = 0
  /\ SetEv("SelfCheck", "maker")
  /\ UNCHANGED <<stage, scale, place, pr, ds, logCnt, pend, drOK, irOK, irEver, envLeft, hc>>

HandleDefect ==
  /\ chk = "defect"
  /\ \/ /\ Mut # "SelfDefInPlace"
        /\ stage' = "design" /\ ds' = [ds EXCEPT ![chkD] = "fixed"]
        /\ drOK' = FALSE /\ irOK' = FALSE /\ UNCHANGED logCnt
        /\ SetEv("HandleCheck", "orch")
     \/ /\ Mut = "SelfDefInPlace"
        /\ stage' = stage /\ ds' = [ds EXCEPT ![chkD] = "fixed"]
        /\ UNCHANGED <<drOK, irOK, logCnt>>
        /\ SetEv("HandleCheck", "maker")
     \* v4: 自己検査の失敗も重大度で振り分けるが、make test は重大度を出さない。
     \*     LOW と読まれた場合は直さず PR 本文に載せて先へ進む（未定ゆえ非決定）
     \/ /\ Model = "v4"
        /\ stage' = stage /\ ds' = [ds EXCEPT ![chkD] = LowState]
        /\ logCnt' = IF LowState = "logged"
                       THEN [logCnt EXCEPT ![chkD] = Inc(@)] ELSE logCnt
        /\ UNCHANGED <<drOK, irOK>>
        /\ SetEv("HandleCheck", "orch")
  /\ chk' = "idle" /\ chkD' = 0
  /\ UNCHANGED <<scale, place, pr, pend, irEver, envLeft, hc>>

HandleEnvR ==
  /\ chk = "envR"
  /\ envLeft' = envLeft - 1 /\ chk' = "idle"
  /\ IF Mut = "EnvRToDesign"
       THEN stage' = "design" /\ drOK' = FALSE /\ irOK' = FALSE
       ELSE stage' = stage /\ UNCHANGED <<drOK, irOK>>
  /\ SetEv("HandleCheck", "maker")
  /\ UNCHANGED <<scale, place, pr, ds, logCnt, pend, irEver, chkD, hc>>

HandleEnvU ==
  /\ chk = "envU"
  /\ chk' = "idle"
  /\ IF Mut = "EnvURetry"
       THEN stage' = stage /\ envLeft' = envLeft /\ SetEv("HandleCheck", "maker")
       ELSE stage' = "reported" /\ envLeft' = envLeft - 1 /\ SetEv("HandleCheck", "orch")
  /\ UNCHANGED <<scale, place, pr, ds, logCnt, pend, drOK, irOK, irEver, chkD, hc>>

HandleCheck == HandleDefect \/ HandleEnvR \/ HandleEnvU

\* レビュー役の指摘（重大度はまだ無い）
Review ==
  /\ stage \in {"dreview", "ireview"}
  /\ \E S \in SUBSET Open : pend' = Mk(S, "agent")
  /\ stage' = IF stage = "dreview" THEN "dtriage" ELSE "itriage"
  /\ SetEv("Review", IF Mut = "SelfReview" THEN "maker" ELSE "reviewer")
  /\ UNCHANGED <<scale, place, pr, ds, logCnt, drOK, irOK, irEver, envLeft, chk, chkD, hc>>

BotReview ==
  /\ stage = "prbot"
  /\ \E S \in SUBSET Open : pend' = Mk(S, "bot")
  /\ stage' = "ptriage"
  /\ SetEv("BotReview", "bot")
  /\ UNCHANGED <<scale, place, pr, ds, logCnt, drOK, irOK, irEver, envLeft, chk, chkD, hc>>

\* 重大度を付ける者。決定どおりでは指摘を出したレビュー役の側（FQ3・FQ6）。
\* v4: 設計段の 6 体の出力に重大度が無く、付ける者も決めていない（V1）。
\*     残る担い手は司令塔だけなので、付けるなら司令塔（未定ゆえ非決定）
Assigners(s, src) ==
  IF Mut = "OrchSev" THEN {"orch"}
  ELSE IF Model = "v4" /\ (s = "dtriage" \/ src = "human") THEN {"orch"}
  ELSE {"reviewer"}

AssignSev ==
  /\ stage \in TriageStages
  /\ \E f \in pend :
       /\ f.sev = "none"
       /\ \E who \in Assigners(stage, f.src) :
            /\ pend' = (pend \ {f}) \cup {[f EXCEPT !.sev = Kind[f.d], !.by = who]}
            /\ SetEv("AssignSev", who)
  /\ UNCHANGED <<stage, scale, place, pr, ds, logCnt, drOK, irOK, irEver, envLeft, chk, chkD, hc>>

TriageGuard ==
  IF Mut = "TriageNoSev" THEN TRUE
  ELSE IF Model = "v4" /\ stage \in {"dtriage", "htriage"} THEN TRUE
  ELSE \A f \in pend : f.sev # "none"

\* 設計に戻す指摘か
Back(f, g) ==
  CASE Mut = "MedPass" -> f.src = "human"
    [] Mut = "HumanLowNotFixed" \/ Model = "v4" -> g[f] = "MED"
    [] OTHER -> f.src = "human" \/ g[f] = "MED"

PassTargets(s) ==
  CASE s = "dtriage" -> IF Mut = "AskStop" THEN {"impl", "ask"} ELSE {"impl"}
    [] s = "itriage" -> IF Model = "v4" THEN {"prbot", "pubgate"} ELSE {"prbot"}
    [] OTHER -> {"gate"}

\* 重大度による振り分け（司令塔: 閾値による機械的な経路の選択で、採点ではない）
Triage ==
  /\ stage \in TriageStages
  /\ TriageGuard
  /\ \E g \in [pend -> {"MED", "LOW"}] :
       /\ \A f \in pend : f.sev # "none" => g[f] = f.sev
       /\ LET back == {f \in pend : Back(f, g)}
              fixS == {f.d : f \in back}
              lowS == {f.d : f \in pend \ back}
              isBack == fixS # {}
              opens == ~isBack /\ stage = "itriage"
              newSt(d) == IF opens THEN "logged" ELSE LowState
              ds1 == [d \in Defects |->
                        IF d \in fixS THEN "fixed"
                        ELSE IF d \in lowS /\ ds[d] = "latent" THEN newSt(d)
                        ELSE IF opens /\ ds[d] = "held" THEN "logged"
                        ELSE ds[d]]
              bump(d) == \/ d \in lowS /\ ds[d] = "latent" /\ newSt(d) = "logged"
                         \/ opens /\ ds[d] = "held"
                         \/ Mut = "Relog" /\ d \in lowS /\ ds[d] = "logged"
          IN /\ ds' = ds1
             /\ logCnt' = [d \in Defects |-> IF bump(d) THEN Inc(logCnt[d]) ELSE logCnt[d]]
             /\ IF isBack
                  THEN /\ stage' = "design" /\ drOK' = FALSE /\ irOK' = FALSE
                       /\ UNCHANGED <<pr, irEver>>
                  ELSE /\ stage' \in PassTargets(stage)
                       /\ drOK' = (drOK \/ stage = "dtriage")
                       /\ irOK' = (irOK \/ stage = "itriage")
                       /\ irEver' = (irEver \/ stage = "itriage")
                       /\ pr' = IF stage = "itriage" THEN "ready" ELSE pr
  /\ pend' = {}
  /\ SetEv("Triage", "orch")
  /\ UNCHANGED <<scale, place, envLeft, chk, chkD, hc>>

\* v4: 作業ルール (7) の「人間ゲート（マージ・公開）」の公開が登録の実行と読める（V16）
PubApprove ==
  /\ stage = "pubgate"
  /\ stage' = "prbot"
  /\ SetEv("PubApprove", "human")
  /\ UNCHANGED <<scale, place, pr, ds, logCnt, pend, drOK, irOK, irEver, envLeft, chk, chkD, hc>>

AskAnswer ==
  /\ stage = "ask"
  /\ stage' = "impl"
  /\ SetEv("AskAnswer", "human")
  /\ UNCHANGED <<scale, place, pr, ds, logCnt, pend, drOK, irOK, irEver, envLeft, chk, chkD, hc>>

HumanComment ==
  /\ stage = "gate"
  /\ \E d \in Open \ hc : pend' = Mk({d}, "human") /\ hc' = hc \cup {d}
  /\ stage' = "htriage"
  /\ SetEv("HumanComment", "human")
  /\ UNCHANGED <<scale, place, pr, ds, logCnt, drOK, irOK, irEver, envLeft, chk, chkD>>

HumanMerge ==
  /\ stage = "gate"
  /\ stage' = "merged"
  /\ SetEv("HumanMerge", "human")
  /\ UNCHANGED <<scale, place, pr, ds, logCnt, pend, drOK, irOK, irEver, envLeft, chk, chkD, hc>>

ResumeAfterReport ==
  /\ Mut = "ResumeAfterReport"
  /\ stage = "reported"
  /\ stage' = "impl"
  /\ SetEv("Resume", "orch")
  /\ UNCHANGED <<scale, place, pr, ds, logCnt, pend, drOK, irOK, irEver, envLeft, chk, chkD, hc>>

NonDone ==
  \/ FixPurpose \/ Work \/ SelfCheckFail \/ HandleCheck
  \/ Review \/ BotReview \/ AssignSev \/ Triage
  \/ PubApprove \/ AskAnswer \/ HumanComment \/ HumanMerge \/ ResumeAfterReport

\* 停止してよい終端でだけ足踏みを許す。これ以外で行動が尽きれば TLC が deadlock を出す
Done == stage \in Terminal /\ UNCHANGED vars

Next == NonDone \/ Done

Spec == Init /\ [][Next]_vars /\ WF_vars(NonDone)

-----------------------------------------------------------------------------
EnabledActors == {a \in Actors : ENABLED (NonDone /\ ev'.actor = a)}
AgentsIdle == ~ENABLED (NonDone /\ ev'.actor \in Agents)
IsTriage == ev'.act = "Triage"

\* P1 振り分ける前に、全ての指摘に重大度が付いている
P1 == [][IsTriage => \A f \in pend : f.sev # "none"]_vars
\* P2 重大度を付けるのは司令塔でない
P2 == \A f \in pend : f.by # "orch"
\* P3 設計レビューを通らずに実装へ進まない
P3 == stage \in AfterDR => drOK
\* P4 実装レビューを通らずに PR を出さない（PR 段は ready の PR）
P4 == stage \in PRStages => irOK
\* P4D draft を含め、実装レビューを一度も通らずに PR が存在しない
P4D == pr # "none" => irEver
\* P5 MEDIUM 以上の agent・bot の指摘は設計に戻る
P5 == [][IsTriage => \A f \in pend :
           (f.src \in {"agent", "bot"} /\ Kind[f.d] = "MED")
             => (stage' = "design" /\ ds'[f.d] = "fixed")]_vars
\* P6 agent・bot の LOW は直さず、PR 本文に載り直さない
P6inv == \A d \in Defects : logCnt[d] <= 1
P6act == [][IsTriage => \A f \in pend :
              (f.src \in {"agent", "bot"} /\ Kind[f.d] = "LOW") => ds'[f.d] # "fixed"]_vars
\* P7 人の指摘は重大度を問わず直る（X3）
P7 == [][IsTriage => \A f \in pend :
           f.src = "human" => (stage' = "design" /\ ds'[f.d] = "fixed")]_vars
\* P8 自己検査の成果物の欠陥は設計に戻る（Q5）
P8 == [][(ev'.act = "HandleCheck" /\ chk = "defect")
           => (stage' = "design" /\ ds'[chkD] = "fixed")]_vars
\* P9 除ける環境の原因はその場でやり直す（Q10）
P9 == [][(ev'.act = "HandleCheck" /\ chk = "envR")
           => (stage' = stage /\ chk' = "idle")]_vars
\* P10 除けない環境の原因は報告して止まる（Q9）
P10 == [][(ev'.act = "HandleCheck" /\ chk = "envU") => stage' = "reported"]_vars
\* P11 agent が止まってよいのは人間ゲート（マージ）と報告後の停止だけ（X2・Q9）
P11 == AgentsIdle => stage \in AllowedStop
\* P12 止まった状態ごとに次の行動の担い手が 1 つに決まる
P12 == stage \in StopStages => EnabledActors \subseteq NextActor(stage)
\* P13 生成者が自分の成果物の合否を決める遷移が無い
P13 == ev.act \in {"Review", "AssignSev"} => ev.actor # "maker"
\* P14 終端（マージ、または報告して停止）に到達する（F1〜F4 の下で）
P14 == <>(stage \in Terminal)
\* P15 成果物の置き場は規模で決まる（X1）
P15 == stage \notin {"purpose"} => place = PlaceFor(scale)
\* P16 PR 本文を置き場にするとき、その時点で PR が存在する（X1 と V7）
P16 == (stage # "purpose" /\ place = "prBody") => pr # "none"
\* P17 LOW を PR 本文に載せるとき、その時点で PR が存在する（W4 と V7）
P17 == \A d \in Defects : ds[d] = "logged" => pr # "none"
=============================================================================
