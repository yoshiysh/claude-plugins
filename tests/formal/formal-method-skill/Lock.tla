---------------------------- MODULE Lock ----------------------------
\* formal-method の排他と salvage の抽象。手順の正本は
\* .agents/skills/formal-method/references/cli-contract.md の「起動の手順」「受け箱」「生死の判定」
\* 「salvage の手順」「結果と台帳の保存の失敗」と、architecture.md の「保存と排他」。
\* ファイル操作 1 つ（作成・link・rename・再読込）と、run-daemon の「salvage.mark を確かめる」と「書く」を、
\* それぞれ別の動作にした。どの動作の間にも crash が入る。
\* 結果は 1 つの名前 result.json にだけ、run-daemon も salvage も link で公開する。link に負けた側は既にある結果を返す。
EXTENDS Naturals, FiniteSets

CONSTANTS
  Mutation,    \* "none" 又は変異の名前（README の表）
  Misjudge,    \* TRUE なら、生死の判定が生きている process を死んだと誤ることがある（計画の非決定の出来事）
  MaxRange,    \* run-daemon が rename で確定する state.json の範囲の最大（保存済みの範囲）
  Salvagers,   \* salvage を呼ぶ process の枠
  Clients,     \* submit を呼ぶ process の枠
  Corrupt_,    \* 起こしてよい「読めない」の集合: "result"（result.json が読めないか形に合わない）、"status"（status.json が読めない）
  UMax,        \* LIVENESS_UNKNOWN_MAX の抽象（判定できない応答が続いたら、司令塔は結果を作らずに終える）
  Track        \* TRUE なら到達の印（seen）を記録する。性質の検査では FALSE にして状態を増やさない

D == "D"
S == "S"
SV == Salvagers \cup {S}               \* S は、起動した process の終了を観測して run の領域があれば salvage と同じ規則を行う
Procs == {D, S} \cup Salvagers \cup Clients
None == "none"
NoBody == <<>>                         \* 結果のファイルが無い

VARIABLES
  alive, crashD, crashO, reuse, psOK, unk, gaveUp,    \* 環境と司令塔: 生死、crash の回数、pid の再利用、ps の可否、判定できない応答の数、諦めた
  dphase, dk, fstep, dchecked, dchk, dsaved, dcomp, dout,   \* run-daemon（dcomp は集約で決めた状態、dout は status.json に入れる結果）
  spc, runDirKnown,                                    \* start と、run_dir を呼出し元が知ったか
  tmp, lockAt, runDir, st, statusAct, statusBody, statusSaved, ledger, result,   \* run の領域
  mark, sledger, sresult, vpc, vbody, vsaved,          \* salvage（sresult は変異 two_names の 2 つ目の名前だけに使う）
  cpc, inbox, inboxPubs, dRead,                        \* 受け箱
  returned, seen, ghost,                               \* 呼出し元に返った結果、到達の印、検査用の印
  env2                                                 \* [rbad: result.json が読めないか形に合わない, sbad: status.json が読めない, errs: E_RESULT_UNREADABLE を返した呼出し]

envV == <<alive, crashD, crashO, reuse, psOK, unk, gaveUp>>
dV == <<dphase, dk, fstep, dchecked, dchk, dsaved, dcomp, dout>>
fileV == <<tmp, lockAt, runDir, st, statusAct, statusBody, statusSaved, ledger, result>>
salvV == <<mark, sledger, sresult, vpc, vbody, vsaved>>
inV == <<cpc, inbox, inboxPubs, dRead>>
vars == <<envV, dV, spc, runDirKnown, fileV, salvV, inV, returned, seen, ghost, env2>>

\* 結果の内容 <<作った者, 保存済みの範囲, 状態, provisional>>。状態は "C"（完了）、"S"（停止）、"X"（保存の失敗で作り直した停止 R'）。
\* provisional は、公開されずに返る R'（仮の結果）にだけ付ける。変異 no_provisional は付け忘れる。records（saved）は内容と別に持つ。
Prov == Mutation # "no_provisional"
DR == <<"D", st, dcomp, FALSE>>
DRp == <<"D", st, "X", Prov>>
VB(v) == IF Mutation = "creator_in_result" THEN <<"V", st, "S", FALSE, v>> ELSE <<"V", st, "S", FALSE>>
VBp == <<"V", st, "X", Prov>>
FBody == <<"F", 0, "S", FALSE>>        \* start が run の領域の無いまま返す受付の停止
FileSaved == {"ledger", "result"}      \* run-daemon の result.json が自分の中に持つ saved
SFileSaved == {"sledger", "result"}    \* salvage の result.json が自分の中に持つ saved
ResSaved(r) == IF r[1] = "D" THEN FileSaved ELSE SFileSaved   \* 公開された result.json が自分の中に持つ saved

Init ==
  /\ alive = [p \in Procs |-> p # D] /\ crashD = 0 /\ crashO = 0 /\ reuse = None /\ psOK = TRUE /\ unk = 0 /\ gaveUp = FALSE
  /\ dphase = "unspawned" /\ dk = 0 /\ fstep = None /\ dchecked = FALSE /\ dchk = None /\ dsaved = {} /\ dcomp = "S" /\ dout = NoBody
  /\ spc = "cap" /\ runDirKnown = FALSE
  /\ tmp = "absent" /\ lockAt = None /\ runDir = FALSE /\ st = 0 /\ statusAct = None /\ statusBody = NoBody /\ statusSaved = {}
  /\ ledger = NoBody /\ result = NoBody
  /\ mark = None /\ sledger = NoBody /\ sresult = NoBody /\ vpc = [v \in SV |-> "idle"] /\ vbody = [v \in SV |-> NoBody] /\ vsaved = [v \in SV |-> {}]
  /\ cpc = [c \in Clients |-> "idle"] /\ inbox = None /\ inboxPubs = 0 /\ dRead = None
  /\ returned = {} /\ seen = {} /\ env2 = [rbad |-> FALSE, sbad |-> FALSE, errs |-> {}]
  /\ ghost = [badWrite |-> FALSE, salvWrote |-> FALSE, foreignUnlock |-> FALSE, wroteAfterMark |-> FALSE, checkViol |-> FALSE,
              dirNoLock |-> FALSE, misjudged |-> FALSE, ioFail |-> FALSE]

\* ---- 生死の判定（cli-contract.md「生死の判定」の 4 段） ----
\* 生きている: ps の開始時刻が一致（ps が使えなければ判定できない）。Misjudge は生きている process を死んだと誤る出来事。
\* 死んでいる: pid が無ければ kill(pid, 0) で確定。pid が再利用されていれば、開始時刻の違いで死と分かる（ps が要る）。
\* 変異 pid_only は pid の有無だけで判定する。
Judge(p) ==
  IF alive[p]
  THEN (IF Mutation = "pid_only" THEN {"alive"} ELSE IF psOK THEN {"alive"} ELSE {"unknown"})
       \cup (IF Misjudge THEN {"dead"} ELSE {})
  ELSE IF reuse = p
       THEN (IF Mutation = "pid_only" THEN {"alive"} ELSE IF psOK THEN {"dead"} ELSE {"unknown"})
       ELSE {"dead"}
\* 誤判定を選んだかを記録する（性質 (4) の限界の条件）。
MisGhost(p, j) == ghost' = [ghost EXCEPT !.misjudged = ghost.misjudged \/ (j = "dead" /\ alive[p])]

Seen(t) == seen' = IF Track THEN seen \cup {t} ELSE seen

\* ---- 環境の出来事 ----
PsBreak == psOK /\ psOK' = FALSE
           /\ UNCHANGED <<alive, crashD, crashO, reuse, unk, gaveUp, dV, spc, runDirKnown, fileV, salvV, inV, returned, seen, ghost, env2>>
\* result.json が読めないか形に合わなくなる（1 回）。status.json が読めなくなる（1 回。以後ずっと読めない）。
Corrupt == /\ "result" \in Corrupt_ /\ ~env2.rbad /\ result # NoBody /\ env2' = [env2 EXCEPT !.rbad = TRUE]
           /\ UNCHANGED <<envV, dV, spc, runDirKnown, fileV, salvV, inV, returned, seen, ghost>>
StatusCorrupt == /\ "status" \in Corrupt_ /\ ~env2.sbad /\ statusAct # None /\ env2' = [env2 EXCEPT !.sbad = TRUE]
                 /\ UNCHANGED <<envV, dV, spc, runDirKnown, fileV, salvV, inV, returned, seen, ghost>>
Reuse == /\ reuse = None
         /\ \E p \in {D} \cup SV : ~alive[p] /\ (p = D => dphase # "unspawned") /\ (p # D => vpc[p] # "idle") /\ reuse' = p
         /\ UNCHANGED <<alive, crashD, crashO, psOK, unk, gaveUp, dV, spc, runDirKnown, fileV, salvV, inV, returned, seen, ghost, env2>>

\* ---- run-daemon ----
LiveD == alive[D] /\ dphase \in {"pre0", "pre1", "pre2", "loop", "final"}
DUnch == <<dk, fstep, dchecked, dchk, dsaved, dcomp, dout>>
\* 一時の領域に run.lock を排他作成し、最終の名前へ rename する。変異 dir_before_lock は rename を先にする。
DLock == /\ alive[D] /\ dphase = "pre0" /\ Mutation # "dir_before_lock" /\ lockAt' = "tmp" /\ dphase' = "pre1"
         /\ UNCHANGED <<envV, DUnch, spc, runDirKnown, tmp, runDir, st, statusAct, statusBody, statusSaved, ledger, result, salvV, inV, returned, seen, ghost, env2>>
DRename == /\ alive[D] /\ ((dphase = "pre1") \/ (dphase = "pre0" /\ Mutation = "dir_before_lock"))
           /\ runDir' = TRUE /\ tmp' = "renamed" /\ lockAt' = IF lockAt = "tmp" THEN "run" ELSE lockAt
           /\ ghost' = [ghost EXCEPT !.dirNoLock = ghost.dirNoLock \/ lockAt' # "run"]
           /\ dphase' = (IF dphase = "pre1" THEN "loop" ELSE "pre2") /\ dk' = 0
           /\ UNCHANGED <<envV, fstep, dchecked, dchk, dsaved, dcomp, dout, spc, runDirKnown, st, statusAct, statusBody, statusSaved, ledger, result, salvV, inV, returned, seen, env2>>
DLockLate == /\ alive[D] /\ dphase = "pre2" /\ lockAt' = "run" /\ dphase' = "loop"
             /\ UNCHANGED <<envV, DUnch, spc, runDirKnown, tmp, runDir, st, statusAct, statusBody, statusSaved, ledger, result, salvV, inV, returned, seen, ghost, env2>>

\* 書く直前に毎回 salvage.mark を確かめ、あれば何も書かずに終わる（lock も消さない）。変異 no_mark_check は確かめない。
NeedsCheck == ~dchecked /\ (dphase = "loop" \/ (dphase = "final" /\ fstep \in {"ledger", "result", "statusTerm"}))
DCheck == /\ alive[D] /\ NeedsCheck
          /\ IF Mutation = "no_mark_check" \/ mark = None
             THEN /\ dchecked' = TRUE /\ dchk' = mark /\ UNCHANGED <<alive, dphase, seen, env2>>
             ELSE /\ dphase' = "exited" /\ alive' = [alive EXCEPT ![D] = FALSE] /\ Seen("d_quit_on_mark") /\ UNCHANGED <<dchecked, dchk, env2>>
          /\ UNCHANGED <<crashD, crashO, reuse, psOK, unk, gaveUp, dk, fstep, dsaved, dcomp, dout, spc, runDirKnown, fileV, salvV, inV, returned, ghost, env2>>
WriteGhost == ghost' = [ghost EXCEPT !.wroteAfterMark = ghost.wroteAfterMark \/ mark # None,
                                     !.checkViol = ghost.checkViol \/ dchk # None,
                                     !.badWrite = ghost.badWrite \/ lockAt # "run"]
FirstFinal == IF Mutation = "result_before_ledger" THEN "result" ELSE "ledger"
\* 段の進行の書込み（最初の status.json と、state.json の範囲の確定）。失敗したら集約へ進む。
\* 集約は、公開が成功すると仮定して完了の条件を評価し、結果 R の状態（完了か停止）を決める。
DWriteLoop == /\ alive[D] /\ dphase = "loop" /\ dchecked /\ dchecked' = FALSE /\ dchk' = None /\ WriteGhost
              /\ \/ /\ IF dk = 0 THEN statusAct' = "working" /\ UNCHANGED st ELSE st' = dk /\ UNCHANGED statusAct
                    /\ IF dk = MaxRange THEN dphase' = "final" /\ fstep' = FirstFinal /\ UNCHANGED dk /\ dcomp' \in {"C", "S"}
                                        ELSE dk' = dk + 1 /\ UNCHANGED <<dphase, fstep, dcomp, env2>>
                    /\ UNCHANGED seen
                 \/ /\ dphase' = "final" /\ fstep' = FirstFinal /\ dcomp' = "S" /\ UNCHANGED <<dk, st, statusAct, env2>> /\ Seen("d_save_fail_loop")
              /\ UNCHANGED <<envV, dsaved, dout, spc, runDirKnown, tmp, lockAt, runDir, statusBody, statusSaved, ledger, result, salvV, inV, returned, env2>>
\* 台帳 → 結果（result.json への link）→ status.json の terminal → lock の解放。
\* 台帳か結果の公開に I/O で失敗したら、R を捨てて停止の R' を作り、status.json で返す（公開しない）。
\* 結果の link に負けたら、自分の結果を捨てて既にある結果を status.json に入れる。
\* 変異: result_despite_ledger_fail（台帳の失敗でも結果を公開）、complete_before_publish（結果の公開に失敗しても R を返す）、
\* loser_returns_own（負けても自分の結果を返す）、saved_without_reload（公開できなかった結果を saved に載せる）。
NextAfterLedger(ok) == IF Mutation = "result_before_ledger" THEN "statusTerm"
                       ELSE IF ok \/ Mutation = "result_despite_ledger_fail" THEN "result" ELSE "statusTerm"
NextAfterResult == IF Mutation = "result_before_ledger" THEN "ledger" ELSE "statusTerm"
DWriteFinal ==
  /\ alive[D] /\ dphase = "final" /\ dchecked /\ dchecked' = FALSE /\ dchk' = None
  /\ \/ /\ fstep = "ledger"
        /\ \/ /\ ledger = NoBody /\ ledger' = DR /\ dsaved' = dsaved \cup {"ledger"} /\ fstep' = NextAfterLedger(TRUE) /\ UNCHANGED <<seen, dout, env2>>
           \/ /\ ledger' = ledger /\ dsaved' = dsaved /\ fstep' = NextAfterLedger(FALSE) /\ Seen("d_ledger_fail")
              /\ dout' = IF Mutation = "result_despite_ledger_fail" THEN dout ELSE DRp
        /\ UNCHANGED <<result, statusAct, statusBody, statusSaved, env2>>
        /\ ghost' = [ghost EXCEPT !.wroteAfterMark = ghost.wroteAfterMark \/ mark # None,
                                  !.checkViol = ghost.checkViol \/ dchk # None, !.badWrite = ghost.badWrite \/ lockAt # "run",
                                  !.ioFail = ghost.ioFail \/ ledger' = NoBody]
     \* 負けて既にある result.json を読めなければ、status.json を書かずに終わる（E_RESULT_UNREADABLE と同じ扱い）。
     \/ /\ fstep = "result" /\ UNCHANGED <<ledger, statusAct, statusBody, statusSaved, env2>>
        /\ fstep' = IF result # NoBody /\ env2.rbad /\ Mutation # "loser_returns_own" THEN "release" ELSE NextAfterResult
        /\ IF result = NoBody
           THEN \/ /\ result' = DR /\ dsaved' = dsaved \cup {"result"} /\ dout' = DR /\ UNCHANGED seen /\ WriteGhost
                \/ /\ result' = result /\ Seen("d_result_fail")
                   /\ dsaved' = IF Mutation = "saved_without_reload" THEN dsaved \cup {"result"} ELSE dsaved
                   /\ dout' = IF Mutation = "complete_before_publish" THEN DR ELSE DRp
                   /\ ghost' = [ghost EXCEPT !.ioFail = TRUE, !.wroteAfterMark = ghost.wroteAfterMark \/ mark # None,
                                             !.checkViol = ghost.checkViol \/ dchk # None, !.badWrite = ghost.badWrite \/ lockAt # "run"]
           ELSE /\ UNCHANGED result /\ Seen("d_result_lost") /\ WriteGhost
                /\ dout' = IF Mutation = "loser_returns_own" THEN DR ELSE result
                /\ dsaved' = IF Mutation = "loser_returns_own" THEN dsaved ELSE ResSaved(result)
     \/ /\ fstep = "statusTerm" /\ fstep' = "release" /\ WriteGhost
        /\ LET out == IF dout = NoBody THEN DRp ELSE dout
           IN \/ statusAct' = "terminal" /\ statusBody' = out /\ statusSaved' = dsaved /\ UNCHANGED seen
              \/ UNCHANGED <<statusAct, statusBody, statusSaved, env2>> /\ Seen("d_status_fail")
        /\ UNCHANGED <<ledger, result, dsaved, dout, env2>>
  /\ UNCHANGED <<envV, dphase, dk, dcomp, spc, runDirKnown, tmp, lockAt, runDir, st, salvV, inV, returned, env2>>
\* releaseOwnLock: 自分の nonce を確かめてから消す。
DRelease == /\ alive[D] /\ dphase = "final" /\ fstep = "release"
            /\ lockAt' = IF lockAt = "run" THEN None ELSE lockAt
            /\ dphase' = "exited" /\ alive' = [alive EXCEPT ![D] = FALSE]
            /\ UNCHANGED <<crashD, crashO, reuse, psOK, unk, gaveUp, DUnch, spc, runDirKnown, tmp, runDir, st, statusAct, statusBody, statusSaved, ledger, result, salvV, inV, returned, seen, ghost, env2>>
\* 開いている batch の受け箱だけを読む（1 batch に 1 つ）。
DReadInbox == /\ alive[D] /\ dphase = "loop" /\ dRead = None /\ inbox # None /\ dRead' = inbox
              /\ UNCHANGED <<envV, dV, spc, runDirKnown, fileV, salvV, cpc, inbox, inboxPubs, returned, seen, ghost, env2>>
DCrash == /\ LiveD /\ crashD = 0 /\ crashD' = 1 /\ alive' = [alive EXCEPT ![D] = FALSE] /\ dphase' = "dead"
          /\ Seen(IF result # NoBody /\ statusAct # "terminal" THEN "d_crash_after_result" ELSE "d_crash")
          /\ UNCHANGED <<crashO, reuse, psOK, unk, gaveUp, DUnch, spc, runDirKnown, fileV, salvV, inV, returned, ghost, env2>>

\* ---- start ----
SRet(body, tag) == returned' = returned \cup {[who |-> S, body |-> body, saved |-> {}]} /\ Seen(tag)
SKeep == <<crashD, crashO, reuse, psOK, unk, gaveUp>>
\* 保存先の能力の確認か起動に失敗したら、run-daemon を起動せずに受付の停止を返す（保存しない）。
SCap == /\ spc = "cap"
        /\ \/ spc' = "spawn" /\ UNCHANGED <<returned, seen, alive, env2>>
           \/ spc' = "done" /\ SRet(FBody, "s_cap_fail") /\ alive' = [alive EXCEPT ![S] = FALSE]
        /\ UNCHANGED <<SKeep, dV, runDirKnown, fileV, salvV, inV, ghost, env2>>
SSpawn == /\ spc = "spawn"
          /\ \/ /\ tmp' = "created" /\ dphase' = "pre0" /\ alive' = [alive EXCEPT ![D] = TRUE] /\ spc' = "wait" /\ UNCHANGED <<returned, seen, env2>>
             \/ /\ spc' = "done" /\ SRet(FBody, "s_spawn_fail") /\ alive' = [alive EXCEPT ![S] = FALSE] /\ UNCHANGED <<tmp, dphase, env2>>
          /\ UNCHANGED <<SKeep, DUnch, runDirKnown, lockAt, runDir, st, statusAct, statusBody, statusSaved, ledger, result, salvV, inV, ghost, env2>>
\* 5-1: 起動した process の終了を親として観測した（正確）。run の領域があれば salvage と同じ規則、無ければ起動の失敗。
SExit == /\ spc \in {"wait", "rewait"} /\ ~alive[D]
         /\ IF runDir
            THEN spc' = "salv" /\ vpc' = [vpc EXCEPT ![S] = "r1"] /\ Seen("s_salvage_path") /\ UNCHANGED <<returned, tmp, alive, env2>>
            ELSE /\ spc' = "done" /\ SRet(FBody, "s_start_fail") /\ alive' = [alive EXCEPT ![S] = FALSE]
                 /\ tmp' = (IF tmp = "created" THEN "removed" ELSE tmp) /\ UNCHANGED vpc
         /\ UNCHANGED <<SKeep, dV, runDirKnown, lockAt, runDir, st, statusAct, statusBody, statusSaved, ledger, result, mark, sledger, sresult, vbody, vsaved, inV, ghost, env2>>
\* 5-2: 最終の名前の run の領域と status.json が現れたら、その Status を返す。
SStatus == /\ spc = "wait" /\ runDir /\ statusAct # None
           /\ spc' = "done" /\ runDirKnown' = TRUE /\ alive' = [alive EXCEPT ![S] = FALSE]
           /\ IF statusAct = "terminal"
              THEN returned' = returned \cup {[who |-> S, body |-> statusBody, saved |-> statusSaved]} /\ Seen("s_status_terminal")
              ELSE UNCHANGED returned /\ Seen("s_status")
           /\ UNCHANGED <<SKeep, dV, fileV, salvV, inV, ghost, env2>>
\* 5-3: START_WAIT_MS に達した。確認と停止は別の動作（間に rename が入りうる）。
STimeout == /\ spc = "wait" /\ spc' = "tcheck"
            /\ UNCHANGED <<envV, dV, runDirKnown, fileV, salvV, inV, returned, seen, ghost, env2>>
STCheck == /\ spc = "tcheck"
           /\ IF lockAt = "run"
              THEN spc' = "done" /\ runDirKnown' = TRUE /\ alive' = [alive EXCEPT ![S] = FALSE] /\ Seen("s_working0") /\ UNCHANGED returned
              ELSE IF Mutation = "slow_no_kill"
                   THEN spc' = "done" /\ SRet(FBody, "s_start_fail") /\ alive' = [alive EXCEPT ![S] = FALSE] /\ UNCHANGED runDirKnown
                   ELSE spc' = "kill" /\ UNCHANGED <<runDirKnown, returned, seen, alive, env2>>
           /\ UNCHANGED <<SKeep, dV, fileV, salvV, inV, ghost, env2>>
SKill == /\ spc = "kill" /\ spc' = "rewait"   \* 終了を観測してから 1 を評価し直す
         /\ IF LiveD THEN alive' = [alive EXCEPT ![D] = FALSE] /\ dphase' = "dead" ELSE UNCHANGED <<alive, dphase, env2>>
         /\ Seen(IF runDir THEN "s_kill_after_rename" ELSE "s_kill")
         /\ UNCHANGED <<SKeep, DUnch, runDirKnown, fileV, salvV, inV, returned, ghost, env2>>

\* ---- salvage（規則 1〜5） ----
\* salvage を呼べるのは、呼出し元が run_dir を受け取った後だけ（入力は CLI が前に返した値だけ）。
\* 判定できない応答が UMax 回続いたら、司令塔は結果を作らずに終え、以後 salvage を呼ばない。
Invoke(v) == /\ v \in Salvagers /\ vpc[v] = "idle" /\ runDirKnown /\ alive[v] /\ ~gaveUp
             /\ vpc' = [vpc EXCEPT ![v] = "r1"]
             /\ UNCHANGED <<envV, dV, spc, runDirKnown, fileV, mark, sledger, sresult, vbody, vsaved, inV, returned, seen, ghost, env2>>
Ret(v, body, saved, tag) ==
  /\ returned' = returned \cup {[who |-> v, body |-> body, saved |-> saved]} /\ Seen(tag)
  /\ vpc' = [vpc EXCEPT ![v] = "done"] /\ alive' = [alive EXCEPT ![v] = FALSE]
  /\ spc' = IF v = S THEN "done" ELSE spc
\* E_BUSY。start が当たった場合も E_BUSY（detail.run_dir 付き）を返し、司令塔は salvage の E_BUSY と同じに扱う。
Busy(v, tag, unknown) ==
  /\ Seen(tag)
  /\ unk' = (IF unknown /\ unk < UMax THEN unk + 1 ELSE unk) /\ gaveUp' = (gaveUp \/ (unknown /\ unk + 1 >= UMax))
  /\ IF v = S
     THEN vpc' = [vpc EXCEPT ![S] = "done"] /\ spc' = "done" /\ runDirKnown' = TRUE /\ alive' = [alive EXCEPT ![S] = FALSE]
     ELSE vpc' = [vpc EXCEPT ![v] = "idle"] /\ UNCHANGED <<spc, runDirKnown, alive, env2>>
\* E_RESULT_UNREADABLE: result.json はあるが読めないか形に合わない。結果を作らず、誤りとして終える。
Err(v) == /\ env2' = [env2 EXCEPT !.errs = @ \cup {v}] /\ Seen("result_unreadable")
          /\ vpc' = [vpc EXCEPT ![v] = "done"] /\ alive' = [alive EXCEPT ![v] = FALSE]
          /\ spc' = IF v = S THEN "done" ELSE spc
          /\ runDirKnown' = (runDirKnown \/ v = S) /\ UNCHANGED returned
VR1(v) == /\ vpc[v] = "r1" /\ alive[v]
          /\ \E j \in (IF lockAt = None THEN {"dead"} ELSE Judge(D)) :
               /\ (IF lockAt = None THEN UNCHANGED ghost ELSE MisGhost(D, j))
               /\ IF j \in {"alive", "unknown"} /\ Mutation # "no_holder_check"
                  THEN Busy(v, IF j = "alive" THEN "busy_daemon" ELSE "busy_unknown", j = "unknown") /\ UNCHANGED returned
                  ELSE vpc' = [vpc EXCEPT ![v] = "r2"] /\ Seen(IF lockAt # None /\ reuse = D THEN "r1_reuse_dead" ELSE IF lockAt # None /\ alive[D] THEN "r1_misjudged" ELSE "r1_pass")
                       /\ UNCHANGED <<spc, runDirKnown, alive, returned, unk, gaveUp, env2>>
          /\ UNCHANGED <<crashD, crashO, reuse, psOK, dV, fileV, mark, sledger, sresult, vbody, vsaved, inV, env2>>
\* 規則 2: result.json があり、形が合えばそれを返す（指紋の照合はしない）。変異 two_names は 2 つ目の名前も見る。
VR2(v) == /\ vpc[v] = "r2" /\ alive[v]
          /\ IF Mutation # "no_saved_check" /\ result # NoBody
             THEN IF env2.rbad
                  THEN IF Mutation = "unreadable_returns_new" THEN Ret(v, VB(v), {}, "rule2_unreadable_new") /\ UNCHANGED <<env2, runDirKnown>>
                       ELSE Err(v)
                  ELSE Ret(v, result, ResSaved(result), "rule2") /\ UNCHANGED <<env2, runDirKnown>>
             ELSE IF Mutation = "two_names" /\ sresult # NoBody
                  THEN Ret(v, sresult, {"sledger", "sresult"}, "rule2") /\ UNCHANGED <<env2, runDirKnown>>
                  ELSE vpc' = [vpc EXCEPT ![v] = "r3"] /\ UNCHANGED <<returned, seen, alive, spc, env2, runDirKnown>>
          /\ UNCHANGED <<crashD, crashO, reuse, psOK, unk, gaveUp, dV, fileV, mark, sledger, sresult, vbody, vsaved, inV, ghost>>
VR3(v) == /\ vpc[v] = "r3" /\ alive[v]
          /\ IF Mutation # "no_saved_check" /\ statusAct = "terminal" /\ ~env2.sbad
             THEN Ret(v, statusBody, statusSaved, "rule3")
             ELSE vpc' = [vpc EXCEPT ![v] = "r4"] /\ UNCHANGED <<returned, seen, alive, spc, env2>>
          /\ UNCHANGED <<crashD, crashO, reuse, psOK, unk, gaveUp, dV, runDirKnown, fileV, mark, sledger, sresult, vbody, vsaved, inV, ghost, env2>>
\* 規則 4: 識別を一時ファイルに書いて link で公開（勝者を決める。一意は守らず、重なりを減らす）。
\* 変異 mark_create_then_write は排他作成してから書く（間は識別の無い印）。
VR4(v) == /\ vpc[v] = "r4" /\ alive[v]
          /\ IF mark = None
             THEN \/ /\ IF Mutation = "mark_create_then_write"
                        THEN mark' = "empty" /\ vpc' = [vpc EXCEPT ![v] = "r4w"]
                        ELSE mark' = v /\ vpc' = [vpc EXCEPT ![v] = "r5a"]
                     /\ UNCHANGED <<seen, spc, runDirKnown, alive, unk, gaveUp, ghost, returned, env2>>
                  \* 印を I/O の誤りで書けない: 公開しない停止の R' を標準出力で返す（決定的に作る）。
                  \/ /\ UNCHANGED <<mark, unk, gaveUp, runDirKnown, env2>> /\ ghost' = [ghost EXCEPT !.ioFail = TRUE]
                     /\ Ret(v, VBp, {}, "s_mark_io")
             ELSE /\ UNCHANGED mark
                  /\ \E j \in (IF mark = "empty" THEN {"unknown"} ELSE Judge(mark)) :
                       /\ (IF mark = "empty" THEN UNCHANGED ghost ELSE MisGhost(mark, j))
                       /\ IF Mutation = "no_winner_check" \/ (j = "dead" /\ Mutation # "winner_always_busy")
                          THEN vpc' = [vpc EXCEPT ![v] = "r5a"] /\ Seen("r4_winner_dead") /\ UNCHANGED <<spc, runDirKnown, alive, unk, gaveUp, returned, env2>>
                          ELSE Busy(v, "busy_salvage", j = "unknown") /\ UNCHANGED returned
          /\ UNCHANGED <<crashD, crashO, reuse, psOK, dV, fileV, sledger, sresult, vbody, vsaved, inV, env2>>
VR4w(v) == /\ vpc[v] = "r4w" /\ alive[v] /\ mark' = v /\ vpc' = [vpc EXCEPT ![v] = "r5a"]
           /\ UNCHANGED <<envV, dV, spc, runDirKnown, fileV, sledger, sresult, vbody, vsaved, inV, returned, seen, ghost, env2>>
\* 規則 5-1・5-2: 子の process group を回収し、保存済みの範囲だけから停止の結果を決定的に作る。
\* 変異 foreign_unlock は残った run.lock を消す（旧 release-lock）。変異 salvage_writes_state は status.json を書く。
VR5a(v) == /\ vpc[v] = "r5a" /\ alive[v]
           /\ vbody' = [vbody EXCEPT ![v] = VB(v)]
           /\ vpc' = [vpc EXCEPT ![v] = IF Mutation = "result_before_ledger" THEN "r5r" ELSE "r5l"]
           /\ IF Mutation = "foreign_unlock" /\ lockAt # None
              THEN lockAt' = None /\ ghost' = [ghost EXCEPT !.foreignUnlock = TRUE] /\ UNCHANGED <<statusAct, statusBody, statusSaved, env2>>
              ELSE IF Mutation = "salvage_writes_state"
                   THEN statusAct' = "terminal" /\ statusBody' = VB(v) /\ statusSaved' = {} /\ UNCHANGED lockAt
                        /\ ghost' = [ghost EXCEPT !.salvWrote = TRUE, !.badWrite = TRUE]
                   ELSE UNCHANGED <<lockAt, statusAct, statusBody, statusSaved, ghost, env2>>
           /\ UNCHANGED <<envV, dV, spc, runDirKnown, tmp, runDir, st, ledger, result, mark, sledger, sresult, vsaved, inV, returned, seen, env2>>
\* 規則 5-3: 追補台帳を公開する。既にあって指紋が同じなら成功、違えば公開の失敗（result.json があればそれを返す）。
\* 台帳の公開に I/O で失敗したら、停止の R' を標準出力で返し、結果を公開しない。
VR5l(v) == /\ vpc[v] = "r5l" /\ alive[v]
           /\ LET b == vbody[v]
                  rev == Mutation = "result_before_ledger"
              IN \/ /\ sledger \in {NoBody, b} /\ sledger' = b /\ vsaved' = [vsaved EXCEPT ![v] = @ \cup {"sledger"}] /\ UNCHANGED ghost
                    /\ IF rev THEN Ret(v, b, vsaved'[v], "s_both_ok_rev")
                       ELSE vpc' = [vpc EXCEPT ![v] = "r5r"] /\ UNCHANGED <<returned, seen, alive, spc, env2>>
                 \/ /\ sledger = NoBody /\ UNCHANGED sledger /\ ghost' = [ghost EXCEPT !.ioFail = TRUE]     \* 保存先の I/O の失敗
                    /\ IF Mutation = "result_despite_ledger_fail" /\ ~rev
                       THEN vpc' = [vpc EXCEPT ![v] = "r5r"] /\ UNCHANGED <<returned, seen, alive, spc, vsaved, env2>>
                       ELSE /\ vsaved' = [vsaved EXCEPT ![v] = IF Mutation = "saved_without_reload" THEN @ \cup {"sledger"} ELSE @]
                            /\ Ret(v, VBp, vsaved'[v], "s_ledger_fail")
                 \/ /\ sledger \notin {NoBody, b} /\ UNCHANGED <<sledger, vsaved, ghost, env2>>
                    /\ IF result # NoBody THEN Ret(v, result, ResSaved(result), "s_ledger_differ_existing")
                       ELSE Ret(v, VBp, vsaved[v], "s_ledger_differ")
           /\ UNCHANGED <<crashD, crashO, reuse, psOK, unk, gaveUp, dV, runDirKnown, fileV, mark, sresult, vbody, inV, env2>>
\* 規則 5-4: 結果を result.json に link で公開する（run-daemon と同じ名前）。既にあれば負けで、既にある結果を返す。
\* I/O で失敗したら、停止の R' を標準出力で返す。変異 two_names は salvage だけ 2 つ目の名前に公開する（前の稿）。
VR5r(v) == /\ vpc[v] = "r5r" /\ alive[v]
           /\ LET b == vbody[v]
                  rev == Mutation = "result_before_ledger"
                  two == Mutation = "two_names"
                  cur == IF two THEN sresult ELSE result
                  okSaved == vsaved[v] \cup {"result"}
              IN \/ /\ cur = NoBody
                    /\ IF two THEN sresult' = b /\ UNCHANGED result ELSE result' = b /\ UNCHANGED sresult
                    /\ vsaved' = [vsaved EXCEPT ![v] = okSaved] /\ UNCHANGED <<ghost, env2, runDirKnown>>
                    /\ IF rev THEN vpc' = [vpc EXCEPT ![v] = "r5l"] /\ UNCHANGED <<returned, seen, alive, spc, env2>>
                       ELSE Ret(v, b, okSaved, IF "sledger" \in vsaved[v] THEN "s_both_ok" ELSE "s_result_only")
                 \/ /\ cur = NoBody /\ UNCHANGED <<result, sresult, env2>>
                    /\ vsaved' = [vsaved EXCEPT ![v] = IF Mutation = "saved_without_reload" THEN okSaved ELSE @]
                    /\ ghost' = [ghost EXCEPT !.ioFail = TRUE] /\ UNCHANGED <<env2, runDirKnown>>
                    /\ Ret(v, VBp, vsaved'[v], "s_result_fail")
                 \/ /\ cur # NoBody /\ UNCHANGED <<result, sresult, vsaved, ghost>>
                    /\ IF Mutation = "loser_returns_own" THEN Ret(v, b, vsaved[v], "s_result_lost") /\ UNCHANGED <<env2, runDirKnown>>
                       ELSE IF env2.rbad /\ ~two THEN Err(v)
                       ELSE Ret(v, cur, IF two THEN {"sledger", "sresult"} ELSE ResSaved(cur), "s_result_lost") /\ UNCHANGED <<env2, runDirKnown>>
           /\ UNCHANGED <<crashD, crashO, reuse, psOK, unk, gaveUp, dV, tmp, lockAt, runDir, st, statusAct, statusBody, statusSaved, ledger, mark, sledger, vbody, inV>>
\* start 自身の crash は扱わない（計画の出来事に無い。README の未検証）。
CrashO(p) == /\ crashO = 0 /\ alive[p]
             /\ \/ p \in Salvagers /\ vpc[p] \in {"r1", "r2", "r3", "r4", "r4w", "r5a", "r5l", "r5r"}
                \/ p \in Clients /\ cpc[p] \in {"tmp", "w"}
             /\ crashO' = 1 /\ alive' = [alive EXCEPT ![p] = FALSE]
             /\ vpc' = IF p \in SV THEN [vpc EXCEPT ![p] = "dead"] ELSE vpc
             /\ cpc' = IF p \in Clients THEN [cpc EXCEPT ![p] = "dead"] ELSE cpc
             /\ spc' = IF p = S THEN "done" ELSE spc
             /\ Seen(IF p \in SV /\ vpc[p] = "r5r" THEN "winner_crash_after_ledger" ELSE IF p \in SV /\ vpc[p] = "r4w" THEN "crash_mark_write" ELSE "crash_other")
             /\ UNCHANGED <<crashD, reuse, psOK, unk, gaveUp, dV, runDirKnown, fileV, mark, sledger, sresult, vbody, vsaved, inbox, inboxPubs, dRead, returned, ghost, env2>>

\* ---- 受け箱（submit） ----
\* 一時ファイルに書いて fsync し、inbox/<batch_id>.json へ link。既にあれば duplicate。変異 inbox_create_then_write は排他作成してから書く。
CStart(c) == /\ cpc[c] = "idle" /\ runDirKnown /\ alive[c]
             /\ IF Mutation = "inbox_create_then_write"
                THEN IF inbox = None THEN inbox' = "partial" /\ inboxPubs' = inboxPubs + 1 /\ cpc' = [cpc EXCEPT ![c] = "w"] /\ UNCHANGED seen
                     ELSE cpc' = [cpc EXCEPT ![c] = "done"] /\ Seen("duplicate") /\ UNCHANGED <<inbox, inboxPubs, env2>>
                ELSE cpc' = [cpc EXCEPT ![c] = "tmp"] /\ UNCHANGED <<inbox, inboxPubs, seen, env2>>
             /\ UNCHANGED <<envV, dV, spc, runDirKnown, fileV, salvV, dRead, returned, ghost, env2>>
CLink(c) == /\ cpc[c] = "tmp" /\ alive[c]
            /\ IF inbox = None THEN inbox' = "full" /\ inboxPubs' = inboxPubs + 1 /\ Seen("accepted")
               ELSE UNCHANGED <<inbox, inboxPubs, env2>> /\ Seen("duplicate")
            /\ cpc' = [cpc EXCEPT ![c] = "done"]
            /\ UNCHANGED <<envV, dV, spc, runDirKnown, fileV, salvV, dRead, returned, ghost, env2>>
CWrite(c) == /\ cpc[c] = "w" /\ alive[c] /\ inbox' = "full" /\ cpc' = [cpc EXCEPT ![c] = "done"]
             /\ UNCHANGED <<envV, dV, spc, runDirKnown, fileV, salvV, inboxPubs, dRead, returned, seen, ghost, env2>>

DNext == DLock \/ DRename \/ DLockLate \/ DCheck \/ DWriteLoop \/ DWriteFinal \/ DRelease \/ DReadInbox
SNext == SCap \/ SSpawn \/ SExit \/ SStatus \/ STimeout \/ STCheck \/ SKill
VStep(v) == VR1(v) \/ VR2(v) \/ VR3(v) \/ VR4(v) \/ VR4w(v) \/ VR5a(v) \/ VR5l(v) \/ VR5r(v)
Next == \/ DNext \/ SNext \/ DCrash \/ PsBreak \/ Reuse \/ Corrupt \/ StatusCorrupt
        \/ \E v \in SV : VStep(v) \/ Invoke(v)
        \/ \E p \in Procs : CrashO(p)
        \/ \E c \in Clients : CStart(c) \/ CLink(c) \/ CWrite(c)

\* 公平性: run-daemon・start・salvage の各動作と、呼出し元が salvage を呼び続けること（Invoke）。crash と環境の出来事には置かない。
Fairness == /\ WF_vars(DNext) /\ WF_vars(SNext) /\ \A v \in SV : WF_vars(VStep(v)) /\ WF_vars(Invoke(v))
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ Fairness

\* ---- 性質 ----
\* 呼出し元が受け取る結果: 呼出しに返った結果と、wait が返す status.json の terminal。
Received == {r.body : r \in returned} \cup (IF statusAct = "terminal" /\ ~env2.sbad THEN {statusBody} ELSE {})
PubFiles == {b \in {result, sresult} : b # NoBody}
PubNames == {n \in {"ledger", "result", "sledger", "sresult"} :
               CASE n = "ledger" -> ledger # NoBody [] n = "result" -> result # NoBody
                 [] n = "sledger" -> sledger # NoBody [] n = "sresult" -> sresult # NoBody}
R5 == {"r5a", "r5l", "r5r"}
\* (1) state.json・status.json・ledger.json を書くのは lock を持つ run-daemon だけ。
WritersOnlyDaemon == ~ghost.badWrite
\* (2) run の領域は lock を持った状態でだけ現れる。
RunDirAppearsWithLock == ~ghost.dirNoLock
\* lock を消すのは作った者だけ（releaseOwnLock）。
LockRemovedOnlyByOwner == ~ghost.foreignUnlock
\* (3) salvage は state.json・status.json・ledger.json を書かない。
SalvageWritesNoState == ~ghost.salvWrote
\* (4) 公開される結果のファイルは 1 つだけ（生死の誤判定を含めて）。
OneResultPublished == Cardinality(PubFiles) <= 1
\* (4b) 受け取った結果が仮の結果でないなら、公開された result.json と一致する（依頼者の決定: 公開された結果を正とする）。
\* 仮の結果は、あとで公開された結果と食い違ってよい。前の稿の Limit（誤判定と I/O の失敗の重なり）の除外は置かない。
ReceivedNonProvisionalMatches == \A b \in Received : (~b[4] /\ result # NoBody) => b = result
\* (4c) 仮の結果は records.unsaved に result を持ち（saved に result が無い）、状態は停止である。公開された結果は仮でない。
ProvisionalShape == /\ \A r \in returned : r.body[4] => (r.body[3] = "X" /\ "result" \notin r.saved)
                    /\ (statusAct = "terminal" /\ statusBody[4]) => (statusBody[3] = "X" /\ "result" \notin statusSaved)
                    /\ (result # NoBody => ~result[4])
\* (4) 勝者が生きている間（生死を正しく判定する限り）、他の salvage は規則 5 に入らない。
\* 勝者（salvage.mark の識別）が生きている間は、勝者でない salvage は規則 5 に居ない（勝者が死んだ後は何体でも続けてよい）。
ExclusiveSalvageWork == ~ghost.misjudged => \A v \in SV : (vpc[v] \in R5 /\ mark \in SV /\ mark # v) => ~alive[mark]
\* (4) salvage が作る結果は保存済みの範囲だけで決まり、勝者でも続けた者でも同じ内容（誤判定で範囲が動く場合を除く）。
DeterministicSalvageResult == ~ghost.misjudged => \A v, w \in SV : (vbody[v] # NoBody /\ vbody[w] # NoBody) => vbody[v] = vbody[w]
\* (5) 公開された結果は、それを登録した台帳を持つ（台帳 → 結果の順）。
ResultInLedger == result # NoBody => result \in {ledger, sledger}
\* (6) 完了が status.json か標準出力に出るのは、result.json に公開できた結果だけ。
CompleteOnlyIfPublished == \A b \in Received : b[3] = "C" => b = result
\* (6 旧) 印を確かめた時点で印が見えていた書込みが無い。
NoWriteAfterMarkSeen == ~ghost.checkViol
\* (8) 受け箱は書き終えた内容でだけ見え、1 batch に 1 つだけ公開される。
InboxComplete == inbox # "partial" /\ dRead # "partial" /\ inboxPubs <= 1
\* (9) 見える salvage.mark は常に識別を持つ。
MarkHasIdentity == mark # "empty"
\* (10) 返した結果の records.saved に、保存していない記録が載らない。
SavedOnlyPublished == \A r \in returned : r.saved \subseteq PubNames
\* (7) 生死を判定できる間は、crash の後も、salvage か start が結果を返す。判定できない状態が続けば、司令塔は終える。
Done == returned # {} \/ (statusAct = "terminal" /\ ~env2.sbad) \/ env2.errs # {}
TerminationIfDeterminable == ([]psOK) => <>Done
Termination == <>(Done \/ gaveUp)

\* (1) E_RESULT_UNREADABLE は、結果を 2 つにしない誤りの終わり方: 公開済みの result.json がある時だけ返り、
\* それを返した呼出しは結果を作らない（公開された結果は 1 つのまま）。
UnreadableOnlyWithPublished == env2.errs # {} => (result # NoBody /\ env2.rbad)
TypeOK == /\ st \in 0..MaxRange /\ lockAt \in {None, "tmp", "run"} /\ inbox \in {None, "partial", "full"}
          /\ mark \in {None, "empty"} \cup SV /\ crashD \in 0..1 /\ crashO \in 0..1 /\ unk \in 0..UMax

\* ---- 到達の証人（成り立たない＝その状態に届く） ----
Never(t) == t \notin seen
NeverSalvageResult == ~(\E r \in returned : r.body[1] = "V")
NeverDaemonResultFile == ~(result # NoBody /\ result[1] = "D")
NeverSalvageResultFile == ~(result # NoBody /\ result[1] = "V")
NeverTwoSalvageReturns == Cardinality({r \in returned : r.body[1] = "V"}) < 2
NeverInboxRead == dRead # "full"
NeverCompleteReceived == ~(\E b \in Received : b[3] = "C")
NeverRprimeReceived == ~(\E b \in Received : b[3] = "X")
NeverMisjudgeAndIO == ~(ghost.misjudged /\ ghost.ioFail)   \* 前の稿の限界の重なりに届く
NeverProvisionalSuperseded == ~(\E b \in Received : b[4] /\ result # NoBody /\ b # result)   \* 仮の結果が、あとの正の結果に置き換わる
NeverGaveUp == ~gaveUp
NeverUnreadable == env2.errs = {}
=============================================================================
