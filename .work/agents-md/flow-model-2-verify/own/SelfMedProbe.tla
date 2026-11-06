---------------------------- MODULE SelfMedProbe ----------------------------
EXTENDS FlowSelfMed
R9 == [][~(IsTriage /\ \E f \in pend : f.src = "self" /\ f.sev = "MED" /\ ds'[f.d] = "logged")]_vars
=============================================================================
