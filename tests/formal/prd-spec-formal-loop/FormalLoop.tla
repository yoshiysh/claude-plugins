----------------------------- MODULE FormalLoop -----------------------------
EXTENDS Integers, FiniteSets

CONSTANTS Mutation, Passes, ReworkLimit, MaxStops, StdoutLoss

Docs == {"d1", "d2"}
Keys == {"d1a", "d1b", "d2c"}
DocOf(k) == IF k = "d2c" THEN "d2" ELSE "d1"
KeysOf(d) == {k \in Keys : DocOf(k) = d}
\* d1 に項目を 2 つ置くのは、正直な直しが違反の項目の隣に入る形（q1）を作るため。
Faith(d) == IF d = "d1" THEN {"d1a"} ELSE {"d2c"}

NoFormal == [at |-> 0, open |-> {}, tried |-> {}, unconf |-> {}, redef |-> {}]

VARIABLES
  phase, stage, inF, att, prev,
  auditN, fm, passes, deferred,
  formal, entryFormal, touched, bad,
  next, cls, rerunStop, resumeTo, stops, reported,
  pend, lost, live, redefEv, faithful, everViol, stale, lastV,
  revG, roundV, falseDefect, droppedSeen, lastDrop, redrafted

impl == <<phase, stage, inF, att, prev, auditN, fm, passes, deferred, formal, entryFormal, touched, bad>>
ret == <<next, cls, rerunStop, resumeTo, stops, reported>>
ghost == <<pend, lost, live, redefEv, faithful, everViol, stale, lastV, revG, roundV, falseDefect, droppedSeen, lastDrop, redrafted>>
vars == <<impl, ret, ghost>>

Round == auditN + 1

Init ==
  /\ phase = "run" /\ stage = "5" /\ inF = FALSE /\ att = 0 /\ prev = 0
  /\ auditN = 0 /\ fm = -1 /\ passes = 0 /\ deferred \in BOOLEAN
  /\ formal = NoFormal /\ entryFormal = NoFormal /\ touched = {}
  /\ bad \in [Docs -> BOOLEAN]
  /\ next = FALSE /\ cls = "none" /\ rerunStop = FALSE /\ resumeTo = "5" /\ stops = 0 /\ reported = {}
  /\ pend = {} /\ lost = {} /\ live = {} /\ redefEv = {} /\ faithful = TRUE /\ everViol = FALSE
  /\ stale = TRUE /\ lastV = {}
  /\ revG = {} /\ roundV = {} /\ falseDefect = FALSE /\ droppedSeen = FALSE /\ lastDrop = FALSE /\ redrafted = FALSE

Continuable(isRerun) ==
  \E big \in BOOLEAN :
    /\ next' = ~(big /\ Mutation = "omit_big")
    /\ cls' = "resumable" /\ rerunStop' = isRerun /\ resumeTo' = stage

Terminal == next' = FALSE /\ cls' = "terminal" /\ UNCHANGED <<rerunStop, resumeTo>>

Begin ==
  /\ phase = "run" /\ stage \in {"5", "8"} /\ ~inF
  /\ inF' = TRUE /\ att' = 0 /\ prev' = 0
  /\ formal' = IF formal.at # Round \/ Mutation = "reset_on_rerun"
                 THEN [formal EXCEPT !.open = formal.tried, !.tried = {}, !.at = Round]
                 ELSE formal
  /\ UNCHANGED <<phase, stage, auditN, fm, passes, deferred, entryFormal, touched, bad, ret, ghost>>

VanishedOpen ==
  {t \in formal.open :
     CASE Mutation = "item_level" -> t \notin touched
       [] Mutation = "any_doc" -> touched = {}
       [] Mutation = "open_not_counted" -> FALSE
       [] OTHER -> KeysOf(DocOf(t)) \cap touched = {}}

Finalize(V, tried, redef) ==
  LET triedAll == IF Mutation = "tried_not_counted" THEN {} ELSE tried
      unconf == formal.unconf \cup ((VanishedOpen \cup triedAll) \ V)
      f == [formal EXCEPT !.tried = V, !.unconf = unconf, !.redef = redef]
      blockingF == V # {} /\ Mutation # "fm_not_blocking"
  IN /\ inF' = FALSE /\ att' = 0 /\ prev' = 0
     /\ formal' = f /\ entryFormal' = f
     /\ fm' = Cardinality(V)
     /\ pend' = V /\ lost' = lost \cup (pend \ V) /\ live' = V
     /\ stale' = FALSE /\ lastV' = V
     /\ auditN' = auditN + 1
     /\ IF stage = "5"
          THEN /\ stage' = "7" /\ phase' = "run" /\ passes' = 0
               /\ UNCHANGED <<touched, next, cls, rerunStop, resumeTo>>
          ELSE /\ touched' = {}
               /\ \E other \in BOOLEAN :
                    IF ~(blockingF \/ other)
                      THEN /\ stage' = "9" /\ phase' = "run"
                           /\ UNCHANGED <<passes, next, cls, rerunStop, resumeTo>>
                      ELSE IF passes >= Passes
                        THEN /\ phase' = "blocked" /\ Terminal /\ UNCHANGED <<stage, passes>>
                        ELSE /\ passes' = passes + 1 /\ stage' = "7" /\ phase' = "run"
                             /\ UNCHANGED <<next, cls, rerunStop, resumeTo>>

\* drop[d]: modeler が文書 d の違反の項目を性質から外す（excluded へ移す）。外せるのは writer が改稿した項目だけに丸めた
\* （改稿していない項目を外すのは違反を隠すのと同じ効き目で、hide が受ける）。
Attempt ==
  /\ phase = "run" /\ inF
  /\ \E def \in [Docs -> {"s", "w"}], hide \in [Docs -> BOOLEAN], shape \in BOOLEAN,
        mdef \in {0, 1}, und \in BOOLEAN, lose \in BOOLEAN, drop \in [Docs -> BOOLEAN] :
     LET V == IF shape THEN {}
              ELSE UNION {IF def[d] = "s" /\ ~hide[d] /\ ~drop[d] /\ bad[d] THEN Faith(d) ELSE {} : d \in Docs}
         revisedOf(t) == IF Mutation = "tried_strict"
                           THEN t \in touched /\ t \notin formal.tried
                           ELSE t \in formal.open /\ t \in touched
         strict == {t \in formal.open \cup formal.tried : ~revisedOf(t)}
         vdrop == \E d \in Docs : drop[d] /\ Faith(d) \cap strict # {}
         defects == IF shape THEN 1 ELSE mdef + (IF vdrop THEN 1 ELSE 0)
         cnt == defects + (IF V # {} /\ defects = 0 /\ und THEN 1 ELSE 0)
         prior(d) == {t \in formal.open \cup formal.tried :
                        DocOf(t) = d /\ (Mutation = "prior_strict_only" => ~revisedOf(t))}
         redef == formal.redef \cup {d \in Docs : ~shape /\ def[d] = "w" /\ prior(d) # {}}
         seenRedef == {d \in Docs : ~shape /\ def[d] = "w" /\ \E t \in live : DocOf(t) = d}
         tried == formal.tried \cup V
         honest == shape \/ \A d \in Docs : def[d] = "s" /\ ~hide[d] /\ (drop[d] => Faith(d) \subseteq revG)
     IN /\ (lose => StdoutLoss)
        /\ \A d \in Docs : drop[d] => d = "d1" /\ ~shape /\ def[d] = "s" /\ ~hide[d] /\ Faith(d) \subseteq touched
        /\ faithful' = (faithful /\ honest)
        /\ everViol' = (everViol \/ V # {})
        /\ falseDefect' = (falseDefect \/ (honest /\ ~shape /\ mdef = 0 /\ defects > 0))
        /\ lastDrop' = \E d \in Docs : drop[d] /\ Faith(d) \subseteq roundV
        /\ droppedSeen' = (droppedSeen \/ lastDrop')
        /\ roundV' = roundV \cup V
        /\ IF lose
             THEN /\ phase' = "blocked" /\ Continuable(TRUE) /\ pend' = pend \cup V /\ live' = live \cup V
                  /\ UNCHANGED <<stage, inF, att, prev, auditN, fm, passes, formal, entryFormal, touched,
                                 lost, redefEv, stale, lastV>>
             ELSE /\ redefEv' = redefEv \cup seenRedef
                  /\ IF cnt = 0
                       THEN Finalize(V, tried, redef)
                       ELSE /\ formal' = [formal EXCEPT !.tried = tried, !.redef = redef]
                            /\ live' = live \cup V /\ pend' = pend \cup V
                            /\ UNCHANGED <<stage, auditN, fm, passes, entryFormal, touched, lost, stale, lastV>>
                            /\ IF att >= ReworkLimit \/ (prev # 0 /\ cnt >= prev)
                                 THEN /\ phase' = "blocked" /\ Continuable(TRUE)
                                      /\ UNCHANGED <<inF, att, prev>>
                                 ELSE /\ phase' = "run" /\ att' = att + 1 /\ prev' = cnt
                                      /\ UNCHANGED <<inF, next, cls, rerunStop, resumeTo>>
  /\ UNCHANGED <<bad, stops, reported, deferred, revG, redrafted>>

Revise ==
  /\ phase = "run" /\ stage = "7"
  /\ \E S \in (SUBSET Keys) \ {{}}, nb \in [Docs -> BOOLEAN] :
       LET hit == {d \in Docs : KeysOf(d) \cap S # {}}
       IN /\ touched' = touched \cup S
          /\ bad' = [d \in Docs |-> IF d \in hit THEN nb[d] ELSE bad[d]]
          /\ pend' = {t \in pend : DocOf(t) \notin hit}
          /\ revG' = lastV \cap (touched \cup S)
  /\ stage' = "8" /\ stale' = TRUE /\ entryFormal' = formal /\ deferred' = FALSE /\ roundV' = {}
  /\ UNCHANGED <<phase, inF, att, prev, auditN, fm, passes, formal, ret,
                 lost, live, redefEv, faithful, everViol, lastV, falseDefect, droppedSeen, lastDrop, redrafted>>

NoTargets ==
  /\ phase = "run" /\ stage = "7"
  /\ deferred' = FALSE
  /\ IF fm # 0 /\ Mutation # "no_formal_gate"
       THEN /\ phase' = "blocked" /\ Terminal /\ UNCHANGED stage
       ELSE /\ stage' = "9" /\ UNCHANGED <<phase, next, cls, rerunStop, resumeTo>>
  /\ UNCHANGED <<inF, att, prev, auditN, fm, passes, formal, entryFormal, touched, bad, stops, reported, ghost>>

NeedsAnswers ==
  /\ phase = "run" /\ stage = "7"
  /\ phase' = "needs" /\ Continuable(FALSE) /\ deferred' = FALSE
  /\ UNCHANGED <<stage, inF, att, prev, auditN, fm, passes, formal, entryFormal, touched, bad, stops, reported, ghost>>

\* 段 3 までの問いを持ち越した run の最初のゲート（段 6 の needsAnswers が from を 3a にする）。回答の後は 3a から段 4 で初稿を書き直す。
DeferredGate ==
  /\ phase = "run" /\ stage = "7" /\ deferred
  /\ phase' = "needs" /\ stage' = "4" /\ deferred' = FALSE
  /\ next' = TRUE /\ cls' = "resumable" /\ rerunStop' = FALSE /\ resumeTo' = "4"
  /\ UNCHANGED <<inF, att, prev, auditN, fm, passes, formal, entryFormal, touched, bad, stops, reported, ghost>>

\* 書き直した初稿の項目は前の違反の項目と別物なので、前の違反（open・tried）は照合に持ち越さない。未確認と定義の変更は、この run で
\* 起きた事実として done まで運ぶ。
Redraft ==
  /\ phase = "run" /\ stage = "4"
  /\ bad' \in [Docs -> BOOLEAN]
  /\ formal' = IF Mutation = "redraft_clears" THEN NoFormal
               ELSE [NoFormal EXCEPT !.unconf = formal.unconf, !.redef = formal.redef]
  /\ entryFormal' = formal'
  /\ stage' = "5" /\ touched' = {}
  /\ pend' = {} /\ live' = {} /\ revG' = {} /\ roundV' = {} /\ stale' = TRUE /\ redrafted' = TRUE
  /\ UNCHANGED <<phase, inF, att, prev, auditN, fm, passes, deferred, ret,
                 lost, redefEv, faithful, everViol, lastV, falseDefect, droppedSeen, lastDrop>>

Report ==
  /\ phase = "run" /\ stage = "9"
  /\ IF fm = 0 \/ Mutation = "no_formal_gate"
       THEN /\ phase' = "done" /\ reported' = formal.unconf /\ UNCHANGED <<next, cls, rerunStop, resumeTo>>
       ELSE /\ phase' = "blocked" /\ Terminal /\ UNCHANGED reported
  /\ UNCHANGED <<stage, inF, att, prev, auditN, fm, passes, deferred, formal, entryFormal, touched, bad, stops, ghost>>

AgentFail ==
  /\ phase = "run" /\ stage \in {"4", "5", "7", "8"}
  /\ phase' = "blocked" /\ Continuable(TRUE)
  /\ UNCHANGED <<stage, inF, att, prev, auditN, fm, passes, deferred, formal, entryFormal, touched, bad, stops, reported, ghost>>

Resume ==
  /\ phase \in {"blocked", "needs"} /\ cls = "resumable" /\ next /\ stops < MaxStops
  /\ phase' = "run" /\ stops' = stops + 1 /\ stage' = resumeTo /\ inF' = FALSE /\ att' = 0 /\ prev' = 0
  /\ formal' = IF rerunStop /\ Mutation = "rerun_entry_formal" THEN entryFormal ELSE formal
  /\ entryFormal' = formal'
  /\ next' = FALSE /\ cls' = "none"
  /\ UNCHANGED <<auditN, fm, passes, deferred, touched, bad, rerunStop, resumeTo, reported, ghost>>

Next == Begin \/ Attempt \/ Revise \/ NoTargets \/ NeedsAnswers \/ DeferredGate \/ Redraft \/ Report \/ AgentFail \/ Resume

Spec == Init /\ [][Next]_vars

GateSound == phase = "done" => ~stale /\ lastV = {}
CompleteSound == phase = "done" => lost \subseteq reported
HonestDone == phase = "done" /\ faithful /\ ~droppedSeen => reported = {}
HonestNoDefect == ~falseDefect
ReportNeverBlocks == ~(phase = "blocked" /\ stage = "9")
RedefRecorded == redefEv \subseteq formal.redef
NoDeadEnd == phase \in {"needs", "blocked"} /\ cls = "resumable" => next

WitnessFixDone == ~(phase = "done" /\ everViol /\ faithful /\ reported = {})
WitnessBlockedViol == ~(phase = "blocked" /\ formal.tried # {})
WitnessHonestDrop == ~(phase = "done" /\ faithful /\ lastDrop)
WitnessRedraftDone == ~(phase = "done" /\ redrafted /\ reported # {})
=============================================================================
