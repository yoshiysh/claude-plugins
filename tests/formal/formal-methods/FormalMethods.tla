------------------------------ MODULE FormalMethods ------------------------------
EXTENDS Naturals, Sequences

CONSTANTS MaxSteps

VARIABLES state, stepCount

vars == <<state, stepCount>>

States == { "反復上限停止", "失敗停止", "完了", "実行中", "欠け停止" }

TypeOK ==
    /\ state \in States
    /\ stepCount \in 0..MaxSteps

Init ==
    /\ state = "実行中"
    /\ stepCount = 0

Trans_1 ==
    /\ state = "実行中"
    /\ stepCount < MaxSteps
    /\ state' = "完了"
    /\ stepCount' = stepCount + 1

Trans_2 ==
    /\ state = "実行中"
    /\ stepCount < MaxSteps
    /\ state' = "欠け停止"
    /\ stepCount' = stepCount + 1

Trans_3 ==
    /\ state = "実行中"
    /\ stepCount < MaxSteps
    /\ state' = "失敗停止"
    /\ stepCount' = stepCount + 1

Trans_4 ==
    /\ state = "実行中"
    /\ stepCount < MaxSteps
    /\ state' = "反復上限停止"
    /\ stepCount' = stepCount + 1

Trans_5 ==
    /\ state = "反復上限停止"
    /\ stepCount < MaxSteps
    /\ state' = "実行中"
    /\ stepCount' = stepCount + 1

Trans_6 ==
    /\ state = "失敗停止"
    /\ stepCount < MaxSteps
    /\ state' = "実行中"
    /\ stepCount' = stepCount + 1

Trans_7 ==
    /\ state = "欠け停止"
    /\ stepCount < MaxSteps
    /\ state' = "欠け停止"
    /\ stepCount' = stepCount + 1

Trans_8 ==
    /\ state = "完了"
    /\ stepCount < MaxSteps
    /\ state' = "完了"
    /\ stepCount' = stepCount + 1

Next ==
    \/ Trans_1
    \/ Trans_2
    \/ Trans_3
    \/ Trans_4
    \/ Trans_5
    \/ Trans_6
    \/ Trans_7
    \/ Trans_8

Spec == Init /\ [][Next]_vars

DeadlockFree ==
    (state \notin { "欠け停止", "完了" }) => (stepCount < MaxSteps => ENABLED Next)

ValidTerminal ==
    (state \in { "欠け停止", "完了" }) => (stepCount <= MaxSteps)

=============================================================================
