---------------------------- MODULE FlowProbe ----------------------------
EXTENDS Flow
R1 == ~(stage \in PRStages /\ \E d \in selfSeen : ds[d] = "logged")
R2 == [][~(ev'.act = "HandleEnvR" /\ chkTrue = "defect" /\ chk' = "idle")]_vars
R3 == [][~(ev'.act = "Review" /\ \E f \in pend' : f.src = "self")]_vars
R4 == [][~(pr = "ready" /\ pr' = "draft")]_vars
R5 == ~(stage = "merged" /\ \E d \in Defects : ds[d] = "logged")
R6 == ~(stage = "merged")
R7 == ~(stage = "reported")
R8 == [][~(ev'.act = "HumanComment" /\ \E d \in Defects : ds[d] = "logged" /\ pend'= Mk({d}, "human"))]_vars
=============================================================================
