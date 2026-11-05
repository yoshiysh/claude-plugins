------------------------------- MODULE Launch -------------------------------
(* Unit "launch and continuation": launch identity, the entry decision order of
   PR-177 (043 reject, 192/231, 193/229), the previous-result state (term 82),
   input change during a launch (121/264/256) and next_args. One run at a time:
   the Lock unit's guarantee LockMutex is this unit's assumption. *)
EXTENDS Naturals
CONSTANTS Mutation, Fixes, Relax, MaxLaunches, MaxChanges

(* Rows of the PR-175 table this unit decides, with the IDs of their "when" column. *)
RowIds == [prev |-> {231}, reject |-> {43, 155}, hostend |-> {}]

Ids == {"A", "B"}
Fresh == [kind |-> "incomplete", pr |-> FALSE, s121 |-> FALSE, step |-> 1, item |-> 0,
          basis |-> {}, hint |-> "none"]
None == [kind |-> "none", pr |-> FALSE, s121 |-> FALSE, step |-> 1, item |-> 0,
         basis |-> {}, hint |-> "none"]

VARIABLES content, ws, active, rid, ret, na, launches, changes
vars == <<content, ws, active, rid, ret, na, launches, changes>>

Init == /\ content = "A" /\ ws = [x \in Ids |-> None] /\ active = FALSE /\ rid = "A"
        /\ ret = "none" /\ na = "none" /\ launches = 0 /\ changes = 0

Stop(kind, args, newWs) ==
  /\ active' = FALSE /\ ret' = kind /\ na' = args /\ ws' = newWs
  /\ UNCHANGED <<content, rid, launches, changes>>

(* PR-177 order: reject (043), then 192 and 231, then 155, then 193 and 229.
   short: the launch limit is below what the entry step needs to write the state. *)
Launch(arg, short) ==
  LET id == content
      s == ws[id]
      reject == arg # "none" /\ (ws[arg].kind = "none" \/ arg # id)
      prevFirst == Mutation # "m177_continue_before_prev"
  IN /\ ~active /\ launches < MaxLaunches
     /\ launches' = launches + 1 /\ rid' = id /\ UNCHANGED <<content, changes>>
     /\ CASE reject ->
               /\ ret' = "reject" /\ na' = "none" /\ UNCHANGED <<ws, active>>
          [] short /\ Mutation = "m177_limit_before_prev" ->
               /\ ret' = "reject155" /\ na' = "none" /\ UNCHANGED <<ws, active>>
          [] s.kind = "complete" /\ Mutation # "m192_skip_complete" ->
               /\ ret' = "complete" /\ na' = "none" /\ UNCHANGED <<ws, active>>
          [] s.pr /\ (prevFirst \/ s.kind # "incomplete") ->
               /\ ret' = "prev" /\ na' = "none" /\ UNCHANGED <<ws, active>>
          [] short ->
               /\ ret' = "reject155" /\ na' = "none" /\ UNCHANGED <<ws, active>>
          [] s.kind = "incomplete" /\ Mutation # "m193_restart" ->
               /\ active' = TRUE /\ ret' = "continue" /\ na' = "none"
               /\ ws' = [ws EXCEPT ![id] =
                           [s EXCEPT !.step = IF Mutation = "m250_rewind_on_hint" /\ s.hint = "unread" THEN 1 ELSE s.step,
                                     !.item = IF (s.s121 /\ Mutation # "m256_keep_items")
                                                 \/ (Mutation = "m250_rewind_on_hint" /\ s.hint = "unread") THEN 0 ELSE s.item,
                                     !.basis = IF s.s121 /\ Mutation # "m256_keep_items" THEN {} ELSE s.basis,
                                     !.hint = IF s.hint = "unread" THEN "read" ELSE s.hint]]
          [] OTHER ->
               /\ active' = TRUE /\ ret' = "new" /\ na' = "none"
               /\ ws' = [ws EXCEPT ![id] =
                           IF Mutation = "m249_inherit" /\ ws[IF id = "A" THEN "B" ELSE "A"].kind # "none"
                           THEN [ws[IF id = "A" THEN "B" ELSE "A"] EXCEPT !.kind = "incomplete", !.pr = FALSE]
                           ELSE Fresh]

Cur == ws[rid]
(* Added constraint: only the latest stop record counts, so a new stop clears the 121 mark. *)
ClearMark == IF "keep121mark" \in Relax THEN Cur.s121 ELSE FALSE
CheckEachItem == "F3" \in Fixes /\ Mutation # "m264_skip_item_check"
DoItem ==
  /\ active /\ Cur.item < 2
  /\ IF CheckEachItem /\ content # rid
     THEN Stop("failure", rid, [ws EXCEPT ![rid].s121 = TRUE])
     ELSE /\ ws' = [ws EXCEPT ![rid].item = Cur.item + 1, ![rid].basis = Cur.basis \cup {content}]
          /\ UNCHANGED <<content, active, rid, ret, na, launches, changes>>

(* PR-264: fingerprints are compared at least at each step boundary. 018: the role of the
   next step reads an unread hint, so StepEnd marks it read. *)
StepEnd ==
  /\ active /\ Cur.item = 2
  /\ content = rid \/ Mutation = "m121_ignore"
  /\ Cur.step = 1
  /\ ws' = [ws EXCEPT ![rid].step = 2, ![rid].item = 0, ![rid].basis = {},
                      ![rid].hint = IF Cur.hint = "unread" THEN "read" ELSE Cur.hint]
  /\ UNCHANGED <<content, active, rid, ret, na, launches, changes>>
Stop121 ==
  /\ active /\ Cur.item = 2 /\ content # rid /\ Mutation # "m121_ignore"
  /\ Stop("failure", rid, [ws EXCEPT ![rid].s121 = TRUE])
Stop121NoRecord ==
  /\ active /\ Cur.item = 2 /\ content # rid
  /\ Stop("stoprec", rid, ws)
Finish(outcome) ==
  /\ active /\ Cur.item = 2 /\ Cur.step = 2 /\ content = rid
  /\ CASE outcome = "complete" -> Stop("complete", "none", [ws EXCEPT ![rid].kind = "complete", ![rid].s121 = ClearMark,
                                       ![rid].hint = IF "F11" \in Fixes /\ Cur.hint = "unread" THEN "read" ELSE Cur.hint])
       [] outcome = "defect" -> Stop("defect", IF Mutation = "m175_defect_next_args" THEN rid ELSE "none",
                                     [ws EXCEPT ![rid].pr = TRUE, ![rid].s121 = ClearMark])
       [] outcome = "fail163" -> Stop("failure", rid,
                                      [ws EXCEPT ![rid].pr = ("F2" \notin Fixes), ![rid].s121 = ClearMark])
IterLimit == active /\ Stop("iterlimit", rid, [ws EXCEPT ![rid].s121 = ClearMark])
HostEnd == active /\ Stop("hostend", "none", ws)

Change == /\ changes < MaxChanges /\ content' = IF content = "A" THEN "B" ELSE "A"
          /\ changes' = changes + 1 /\ UNCHANGED <<ws, active, rid, ret, na, launches>>
AddHint(x) ==
  /\ ws[x].kind # "none"
  /\ IF ws[x].kind = "complete" \/ (ws[x].pr /\ Mutation # "m234_accept_hint")
     THEN UNCHANGED vars
     ELSE /\ ws' = [ws EXCEPT ![x].hint = "unread"] /\ UNCHANGED <<content, active, rid, ret, na, launches, changes>>

Next == \/ \E a \in Ids \cup {"none"}, short \in BOOLEAN : Launch(a, short)
        \/ DoItem \/ StepEnd \/ Stop121 \/ Stop121NoRecord
        \/ \E o \in {"complete", "defect", "fail163"} : Finish(o)
        \/ IterLimit \/ HostEnd \/ Change \/ \E x \in Ids : AddHint(x)
Spec == Init /\ [][Next]_vars

TypeOK == /\ content \in Ids /\ active \in BOOLEAN /\ rid \in Ids /\ na \in Ids \cup {"none"}
          /\ \A x \in Ids : ws[x].kind \in {"none", "incomplete", "complete"} /\ ws[x].basis \subseteq Ids

PrevResultClosed == [][\A x \in Ids : ws[x].pr => ws'[x] = ws[x]]_vars
PrevResultReturned == [][(launches' > launches /\ ret' # "reject" /\ ws[content].pr
                           /\ ws[content].kind # "complete") => ret' = "prev"]_vars
RedoStoppedStep == [][(launches' > launches /\ ret' = "continue" /\ ws[rid'].s121)
                       => ws'[rid'].item = 0 /\ ws'[rid'].basis = {}]_vars
CompletedReturnsCompleted == [][(launches' > launches /\ ret' # "reject" /\ ws[content].kind = "complete")
                                 => ret' = "complete" /\ ws' = ws]_vars
NewStateIsFresh == [][(launches' > launches /\ ret' = "new") => ws'[rid'] = Fresh]_vars
InputChangeStopsAtStepEnd == [][(active /\ Cur.step = 1 /\ ws'[rid].step = 2) => content = rid]_vars
ContinueKeepsProgress ==
  [][(launches' > launches /\ ret' \notin {"reject", "reject155"} /\ ws[content].kind = "incomplete" /\ ~ws[content].pr)
     => /\ ret' = "continue" /\ ws'[content].step = ws[content].step
        /\ (~ws[content].s121 => ws'[content].item = ws[content].item)]_vars
NoUnreadHintAtComplete == \A x \in Ids : ws[x].kind = "complete" => ws[x].hint # "unread"
ResultsOnIdentity ==
  [][/\ (active /\ ((~active' /\ ret' \in {"complete", "defect"}) \/ (Cur.step = 1 /\ ws'[rid].step = 2)))
        => Cur.basis \subseteq {rid}
     /\ (launches' > launches /\ ret' = "continue") => ws'[rid'].basis \subseteq {rid'}]_vars
NextArgsContinue == (na # "none" /\ ret # "stoprec" /\ ~active) => ~ws[na].pr

WitnessPrev == ret # "prev"
WitnessRedo == ~(active /\ ret = "continue" /\ Cur.s121)
WitnessComplete == ret # "complete"
WitnessHintThenComplete == ~(ret = "complete" /\ ws[rid].hint = "read")
WitnessContinueAfterHint == ~(active /\ ret = "continue" /\ Cur.hint = "read")
=============================================================================
