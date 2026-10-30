--------------------------------- MODULE MC ---------------------------------
(* Model-checking entry: the composition and the yardstick. The yardstick is
   taken with an unnamed INSTANCE; the projection below is the trust
   boundary that SANY cannot check (README). *)
EXTENDS Develop, TLC

INSTANCE DevelopProps WITH out <- [st |-> sk.st, stage |-> sk.stage, kind |-> sk.kind, res |-> sk.res]

ASSUME PrintT(<<"ACTIONS", S!AllActs>>)

=============================================================================
