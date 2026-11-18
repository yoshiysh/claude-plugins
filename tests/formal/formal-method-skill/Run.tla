---------------------------- MODULE Run ----------------------------
\* formal-method の run の進行と停止の抽象（司令塔・start・run-daemon・client・担当・道具・時計）。
\* 正本は .agents/skills/formal-method/references/architecture.md の「段と処理の順序」「司令塔と CLI の分担」
\* 「停止の手順」「時計と資源」と、cli-contract.md の「コマンド」「誤りと終了コード」「起動の手順」「受け箱」「salvage の手順」。
\* ファイル操作の不可分性・lock・salvage の内部は Lock.tla が持つ。ここでは salvage を、規則 1〜4 の判定と、
\* 勝者が結果を作る（呼出しの中で終えるか、ホストの時間の上限で呼出しが返らないまま background で続く）として扱う。
EXTENDS Naturals, FiniteSets

CONSTANTS
  Mutation,     \* "none" 又は変異の名前（README の表）
  BatchStages,  \* 担当の batch を開く段（2 洗い出し、3 モデル化、4 計画、6 確認 の部分集合）
  UMax,         \* LIVENESS_UNKNOWN_MAX の抽象（生死を判定できない応答が続く回数の上限）
  Env,          \* 起こしてよい環境の出来事の集合（"crash" "save" "deadline" "ps" "stale" "garbled" "svcrash" "corrupt" "statusread"）。check.sh が組に分けて回す
  Track         \* TRUE なら到達の印（seen）を記録する。性質の検査では FALSE にして状態を増やさない

None == "none"
NoRes == [k |-> "none", st |-> "none"]   \* 結果が無い
Checks == {"K1", "K2", "M"}   \* K1・K2 は性質 P1・P2 の検査、M は K2 の検出能力の確認（変異。確認用の実行）
LastStage == 7
\* 結果の状態 st は "complete"（完了）か "stopped"（停止）。
RD(complete) == [k |-> "D", st |-> IF complete THEN "complete" ELSE "stopped"]
RS == [k |-> "V", st |-> "stopped"]   \* salvage の結果（保存済みの範囲から決定的に作る。Lock.tla で内容の一意を確かめる）
RF == [k |-> "F", st |-> "stopped"]   \* start が run の領域の無いまま返す受付の停止

VARIABLES
  hasLimit, deadline, psOK, envUsed,            \* 依頼の時間の上限の有無、期限、ps の可否、1 回限りの環境の出来事
  dalive, dph, stage, open, bdl, dRec, cst, dep, rejected, saveSeen, execDone,
  runDir, statusSeq, statusAct, statusBatch, statusRes, rpub, dres,
  sres, svw,                                    \* salvage の結果と、background で続く勝者
  sp,                                           \* start の手順
  cpc, cseq, cb, wf, ucnt, final,               \* 司令塔
  inbox, firstInbox,
  seen, ghost,
  bad                                           \* [r: result.json が読めないか形に合わない, s: status.json が読めない]

envV == <<hasLimit, deadline, psOK, envUsed>>
dV == <<dalive, dph, stage, open, bdl, dRec, cst, dep, rejected, saveSeen, execDone>>
fV == <<runDir, statusSeq, statusAct, statusBatch, statusRes, rpub, dres>>
cV == <<cpc, cseq, cb, wf, ucnt, final>>
vars == <<envV, dV, fV, sres, svw, sp, cV, inbox, firstInbox, seen, ghost, bad>>

Seen(t) == seen' = IF Track THEN seen \cup {t} ELSE seen
G(f) == ghost' = [ghost EXCEPT ![f] = TRUE]
HasResult == rpub \/ sres # NoRes   \* result.json がある（run-daemon か salvage が公開した）

Init ==
  /\ hasLimit \in (IF "deadline" \in Env THEN BOOLEAN ELSE {FALSE}) /\ deadline = FALSE /\ psOK = TRUE /\ envUsed = {}
  /\ dalive = FALSE /\ dph = "unspawned" /\ stage = 1 /\ open = FALSE /\ bdl = {} /\ dRec = [s \in BatchStages |-> None]
  /\ cst = [k \in Checks |-> "off"] /\ dep \in BOOLEAN /\ rejected = FALSE /\ saveSeen = FALSE /\ execDone = FALSE
  /\ runDir = FALSE /\ statusSeq = 0 /\ statusAct = None /\ statusBatch = 0 /\ statusRes = NoRes /\ rpub = FALSE /\ dres = NoRes
  /\ sres = NoRes /\ svw = None /\ sp = "call"
  /\ cpc = "start" /\ cseq = 0 /\ cb = 0 /\ wf = None /\ ucnt = 0 /\ final = NoRes
  /\ inbox = [s \in BatchStages |-> None] /\ firstInbox = [s \in BatchStages |-> None]
  /\ seen = {} /\ bad = [r |-> FALSE, s |-> FALSE]
  /\ ghost = [afterDeadline |-> FALSE, clientWrote |-> FALSE, waitEarly |-> FALSE, staleAlive |-> FALSE, wrongBusy |-> FALSE,
              saveFail |-> FALSE, startTwice |-> FALSE]

\* ---- 環境 ----
Once(e) == e \in Env /\ e \notin envUsed /\ envUsed' = envUsed \cup {e}
Deadline == hasLimit /\ ~deadline /\ deadline' = TRUE /\ Seen("deadline_hit")
            /\ UNCHANGED <<hasLimit, psOK, envUsed, dV, fV, sres, svw, sp, cV, inbox, firstInbox, ghost, bad>>
\* 開いた batch の期限（run の期限 − REPORT_RESERVE_MS と AGENT_BATCH_DEADLINE_MS の早い方）が過ぎる。
BatchClock == /\ \E b \in BatchStages : b \notin bdl /\ (b = cb \/ (open /\ b = stage)) /\ bdl' = bdl \cup {b}
              /\ UNCHANGED <<envV, dalive, dph, stage, open, dRec, cst, dep, rejected, saveSeen, execDone, fV, sres, svw, sp, cV, inbox, firstInbox, seen, ghost, bad>>
\* result.json が読めなくなる（"corrupt"）、status.json が読めなくなる（"statusread"）。どちらも 1 回で、以後ずっと読めない。
Corrupt == /\ HasResult /\ ~bad.r /\ Once("corrupt") /\ bad' = [bad EXCEPT !.r = TRUE]
           /\ UNCHANGED <<hasLimit, deadline, psOK, dV, fV, sres, svw, sp, cV, inbox, firstInbox, seen, ghost>>
StatusBad == /\ statusAct # None /\ ~bad.s /\ Once("statusread") /\ bad' = [bad EXCEPT !.s = TRUE]
             /\ UNCHANGED <<hasLimit, deadline, psOK, dV, fV, sres, svw, sp, cV, inbox, firstInbox, seen, ghost>>
PsBreak == "ps" \in Env /\ psOK /\ psOK' = FALSE /\ UNCHANGED <<hasLimit, deadline, envUsed, dV, fV, sres, svw, sp, cV, inbox, firstInbox, seen, ghost, bad>>

\* ---- run-daemon ----
Writable == dalive /\ dph \in {"post", "run"}
\* status.json の書込み（seq を 1 増やす）。
WriteStatus(act, b, res) == statusSeq' = statusSeq + 1 /\ statusAct' = act /\ statusBatch' = b /\ statusRes' = res
DRename == /\ dalive /\ dph = "pre" /\ runDir' = TRUE /\ dph' = "post"
           /\ UNCHANGED <<envV, dalive, stage, open, bdl, dRec, cst, dep, rejected, saveSeen, execDone, statusSeq, statusAct, statusBatch, statusRes, rpub, dres, sres, svw, sp, cV, inbox, firstInbox, seen, ghost, bad>>
DFirstStatus == /\ dalive /\ dph = "post" /\ WriteStatus("working", 0, NoRes) /\ dph' = "run"
                /\ UNCHANGED <<envV, dalive, stage, open, bdl, dRec, cst, dep, rejected, saveSeen, execDone, runDir, rpub, dres, sres, svw, sp, cV, inbox, firstInbox, seen, ghost, bad>>
\* 保存できない記録があった: 新しい書込みを始めず、集約の段で結果を作り、保存を 1 度だけ試す。
\* 変異 ignore_save_failure は失敗を無視して続ける。変異 hang_on_save_failure は止まったまま終わらない。
DSaveFail == /\ "save" \in Env /\ Writable /\ ~ghost.saveFail /\ Seen("save_fail")
             /\ IF Mutation = "ignore_save_failure"
                THEN ghost' = [ghost EXCEPT !.saveFail = TRUE] /\ UNCHANGED <<dph, saveSeen, open, bad>>
                ELSE /\ ghost' = [ghost EXCEPT !.saveFail = TRUE] /\ saveSeen' = TRUE /\ open' = FALSE
                     /\ dph' = IF Mutation = "hang_on_save_failure" THEN "hung" ELSE "agg"
             /\ UNCHANGED <<envV, dalive, stage, bdl, dRec, cst, dep, rejected, execDone, fV, sres, svw, sp, cV, inbox, firstInbox, bad>>
\* 受付: 依頼を受け付けるか、受け付けずに集約へ。
DAccept == /\ dalive /\ dph = "run" /\ stage = 1
           /\ \/ stage' = 2 /\ UNCHANGED <<rejected, dph, bad>>
              \/ rejected' = TRUE /\ dph' = "agg" /\ UNCHANGED stage
           /\ UNCHANGED <<envV, dalive, open, bdl, dRec, cst, dep, saveSeen, execDone, fV, sres, svw, sp, cV, inbox, firstInbox, seen, ghost, bad>>
NextStage(s) == IF s + 1 > 6 THEN LastStage ELSE s + 1
\* 担当のいない段（batch を開かない段）は、そのまま次へ進む。実行の段（5）は下の scheduler。
DSkipStage == /\ dalive /\ dph = "run" /\ stage \in 2..6 /\ stage # 5 /\ stage \notin BatchStages /\ ~open
              /\ stage' = NextStage(stage) /\ dph' = IF NextStage(stage) = LastStage THEN "agg" ELSE dph
              /\ UNCHANGED <<envV, dalive, open, bdl, dRec, cst, dep, rejected, saveSeen, execDone, fV, sres, svw, sp, cV, inbox, firstInbox, seen, ghost, bad>>
\* batch を開く（status.json の run_agents）。時間の上限の後は担当を始めない（変異 batch_after_deadline は始める）。
DOpen == /\ dalive /\ dph = "run" /\ stage \in BatchStages /\ ~open /\ dRec[stage] = None
         /\ (~deadline \/ Mutation = "batch_after_deadline")
         /\ WriteStatus("run_agents", stage, NoRes) /\ open' = TRUE
         /\ ghost' = [ghost EXCEPT !.afterDeadline = ghost.afterDeadline \/ deadline]
         /\ UNCHANGED <<envV, dalive, dph, stage, bdl, dRec, cst, dep, rejected, saveSeen, execDone, runDir, rpub, dres, sres, svw, sp, cV, inbox, firstInbox, seen, bad>>
CloseTo(s, rec) == /\ dRec' = [dRec EXCEPT ![s] = rec] /\ open' = FALSE
                   /\ stage' = NextStage(s) /\ dph' = IF NextStage(s) = LastStage THEN "agg" ELSE dph
\* 開いている batch の受け箱だけを読む（変異 read_any_batch は他の batch の受け箱も読む）。
DRead == /\ dalive /\ dph = "run" /\ open
         /\ \E s \in BatchStages :
              /\ inbox[s] # None /\ (s = stage \/ Mutation = "read_any_batch")
              /\ CloseTo(stage, IF inbox[s] = "timedout" THEN "missing" ELSE inbox[s])
         /\ UNCHANGED <<envV, dalive, bdl, cst, dep, rejected, saveSeen, execDone, fV, sres, svw, sp, cV, inbox, firstInbox, seen, ghost, bad>>
\* 期限までに受け箱が無ければ、batch を欠測で閉じる（担当には公平性を置かない）。
\* 変異 no_batch_deadline は batch の内部の期限を持たない（時間の上限の無い依頼で、返らない担当を待ち続ける）。
DBatchDeadline == /\ Mutation # "no_batch_deadline" /\ dalive /\ dph = "run" /\ open /\ stage \in bdl /\ inbox[stage] = None
                  /\ CloseTo(stage, "missing") /\ Seen("batch_timed_out")
                  /\ UNCHANGED <<envV, dalive, bdl, cst, dep, rejected, saveSeen, execDone, fV, sres, svw, sp, cV, inbox, firstInbox, ghost, bad>>
\* 時間の上限: 開いている batch を閉じ、始めていない担当を始めず、得た範囲で集約へ。
DRunDeadline == /\ dalive /\ dph = "run" /\ deadline /\ stage # 5
                /\ (open \/ (stage \in BatchStages /\ Mutation # "batch_after_deadline") \/ stage = 1)
                /\ dph' = "agg" /\ open' = FALSE
                /\ UNCHANGED <<envV, dalive, stage, bdl, dRec, cst, dep, rejected, saveSeen, execDone, fV, sres, svw, sp, cV, inbox, firstInbox, seen, ghost, bad>>

\* ---- 実行の段の scheduler ----
Bad(r) == r \in {"bad", "missing"}
Question == 3 \in BatchStages /\ dRec[3] = "question"
DEnterExec == /\ dalive /\ dph = "run" /\ stage = 5 /\ cst = [k \in Checks |-> "off"] /\ ~execDone
              /\ LET noModel == \E s \in BatchStages \ {6} : Bad(dRec[s])
                 IN cst' = [k \in Checks |-> IF noModel \/ (k = "K1" /\ Question) THEN "notplanned" ELSE "plan"]
              /\ UNCHANGED <<envV, dalive, dph, stage, open, bdl, dRec, dep, rejected, saveSeen, execDone, fV, sres, svw, sp, cV, inbox, firstInbox, seen, ghost, bad>>
\* 時間の上限の後は始めない。変異 check_after_deadline・confirm_after_deadline は、性質の検査・確認用の実行を期限の後も始める。
Exempt(k) == (Mutation = "check_after_deadline" /\ k # "M") \/ (Mutation = "confirm_after_deadline" /\ k = "M")
DepOK(k) == k # "K2" \/ ~dep \/ cst["K1"] = "ok"
DStartCheck == /\ dalive /\ dph = "run" /\ stage = 5
               /\ \E k \in Checks :
                    /\ cst[k] = "plan" /\ DepOK(k) /\ (~deadline \/ Exempt(k))
                    /\ cst' = [cst EXCEPT ![k] = "run"]
                    /\ ghost' = [ghost EXCEPT !.afterDeadline = ghost.afterDeadline \/ deadline]
               /\ UNCHANGED <<envV, dalive, dph, stage, open, bdl, dRec, dep, rejected, saveSeen, execDone, fV, sres, svw, sp, cV, inbox, firstInbox, seen, bad>>
\* 依存先が成功でなかった検査は始めず未実行とする。
DSkipDep == /\ dalive /\ dph = "run" /\ stage = 5 /\ dep /\ cst["K2"] = "plan" /\ cst["K1"] \in {"cex", "unk", "stopped", "notrun", "notplanned"}
            /\ cst' = [cst EXCEPT !["K2"] = "notrun"] /\ Seen("dependent_skipped")
            /\ UNCHANGED <<envV, dalive, dph, stage, open, bdl, dRec, dep, rejected, saveSeen, execDone, fV, sres, svw, sp, cV, inbox, firstInbox, ghost, bad>>
\* 道具は検査ごとの時間の上限で必ず終わる（公平性を置く）。M の ok は「検出を確認」、cex は「検出せず」。
\* 変異 stop_on_failure は、反例が出たら他の検査を全て止める（旧 scheduler）。
ToolEnd == /\ dalive /\ dph = "run" /\ stage = 5
           /\ \E k \in Checks, r \in {"ok", "cex", "unk"} :
                /\ cst[k] = "run"
                /\ cst' = IF Mutation = "stop_on_failure" /\ r = "cex"
                          THEN [j \in Checks |-> IF j = k THEN r ELSE IF cst[j] = "run" THEN "stopped" ELSE IF cst[j] = "plan" THEN "notrun" ELSE cst[j]]
                          ELSE [cst EXCEPT ![k] = r]
           /\ UNCHANGED <<envV, dalive, dph, stage, open, bdl, dRec, dep, rejected, saveSeen, execDone, fV, sres, svw, sp, cV, inbox, firstInbox, seen, ghost, bad>>
\* 時間の上限: 実行中の道具の実行（確認用も）を止め、始めていない実行を始めない。
DExecDeadline == /\ dalive /\ dph = "run" /\ stage = 5 /\ deadline
                 /\ \E k \in Checks : cst[k] \in {"plan", "run"} /\ ~Exempt(k)
                 /\ cst' = [k \in Checks |-> IF Exempt(k) THEN cst[k] ELSE IF cst[k] = "run" THEN "stopped" ELSE IF cst[k] = "plan" THEN "notrun" ELSE cst[k]]
                 /\ Seen(IF cst["M"] = "run" /\ ~Exempt("M") THEN "confirmation_stopped" ELSE "exec_deadline")
                 /\ UNCHANGED <<envV, dalive, dph, stage, open, bdl, dRec, dep, rejected, saveSeen, execDone, fV, sres, svw, sp, cV, inbox, firstInbox, ghost, bad>>
\* 変異 stop_on_question は、回答を待つ問いがあると実行の段の検査を始めない（D2 に反する）。
DQuestionStop == /\ Mutation = "stop_on_question" /\ dalive /\ dph = "run" /\ stage = 5 /\ Question
                 /\ \E k \in Checks : cst[k] = "plan"
                 /\ cst' = [k \in Checks |-> IF cst[k] = "plan" THEN "notrun" ELSE cst[k]]
                 /\ UNCHANGED <<envV, dalive, dph, stage, open, bdl, dRec, dep, rejected, saveSeen, execDone, fV, sres, svw, sp, cV, inbox, firstInbox, seen, ghost, bad>>
DExecDone == /\ dalive /\ dph = "run" /\ stage = 5 /\ cst # [k \in Checks |-> "off"]
             /\ \A k \in Checks : cst[k] \notin {"plan", "run"}
             /\ execDone' = TRUE /\ stage' = 6 /\ dph' = IF deadline \/ 6 \notin BatchStages THEN "agg" ELSE dph
             /\ Seen(IF ~dep /\ cst["K1"] = "cex" /\ cst["K2"] \in {"ok", "cex", "unk"} THEN "independent_after_cex" ELSE "exec_done")
             /\ UNCHANGED <<envV, dalive, open, bdl, dRec, cst, dep, rejected, saveSeen, fV, sres, svw, sp, cV, inbox, firstInbox, ghost, bad>>

\* ---- 集約 ----
\* 完了の条件（SP-015 の抽象）: 受け付けた、全ての性質の検査が成功、確認用の実行が検出を確認、全ての batch が回収済み、
\* 回答を待つ問いが無い、記録を全て保存した。変異 complete_ignores_confirmation は確認用の実行と確認の batch を見ない。
CondTrue == /\ ~rejected /\ execDone /\ ~ghost.saveFail
            /\ \A k \in Checks : cst[k] = "ok"
            /\ \A s \in BatchStages : dRec[s] = "ok"
DComplete == IF Mutation = "complete_ignores_confirmation"
             THEN ~rejected /\ execDone /\ ~saveSeen /\ cst["K1"] = "ok" /\ cst["K2"] = "ok" /\ \A s \in BatchStages \ {6} : dRec[s] = "ok"
             ELSE ~rejected /\ execDone /\ ~saveSeen /\ (\A k \in Checks : cst[k] = "ok") /\ \A s \in BatchStages : dRec[s] = "ok"
\* 結果を作り、結果のファイル（台帳 → 結果。Lock.tla）と status.json の terminal を 1 度ずつ試す。
DAgg == /\ dalive /\ dph = "agg" /\ dres' = RD(DComplete) /\ dph' = "pubR"
        /\ UNCHANGED <<envV, dalive, stage, open, bdl, dRec, cst, dep, rejected, saveSeen, execDone, runDir, statusSeq, statusAct, statusBatch, statusRes, rpub, sres, svw, sp, cV, inbox, firstInbox, seen, ghost, bad>>
\* 結果（台帳 → result.json）を公開できなければ、R を捨て、停止の R'（保存の失敗・記録の未保存）を status.json で返す
\* （cli-contract.md「状態を決める順序」）。変異 complete_before_publish は、公開の前に決めた状態のまま R を返す。
DPubResult == /\ dalive /\ dph = "pubR" /\ dph' = "pubS"
              /\ \/ rpub' = TRUE /\ UNCHANGED <<dres, ghost, bad>>
                 \/ /\ "save" \in Env /\ rpub' = FALSE /\ ghost' = [ghost EXCEPT !.saveFail = TRUE]
                    /\ dres' = IF Mutation = "complete_before_publish" THEN dres ELSE RD(FALSE)
              /\ UNCHANGED <<envV, dalive, stage, open, bdl, dRec, cst, dep, rejected, saveSeen, execDone, runDir, statusSeq, statusAct, statusBatch, statusRes, sres, svw, sp, cV, inbox, firstInbox, seen, bad>>
DPubStatus == /\ dalive /\ dph = "pubS" /\ dph' = "exit"
              /\ \/ WriteStatus("terminal", 0, dres) /\ UNCHANGED seen
                 \/ "save" \in Env /\ UNCHANGED <<statusSeq, statusAct, statusBatch, statusRes, bad>> /\ Seen("status_fail")
              /\ UNCHANGED <<envV, dalive, stage, open, bdl, dRec, cst, dep, rejected, saveSeen, execDone, runDir, rpub, dres, sres, svw, sp, cV, inbox, firstInbox, ghost, bad>>
DExit == /\ dalive /\ dph = "exit" /\ dalive' = FALSE /\ dph' = "exited"
         /\ UNCHANGED <<envV, stage, open, bdl, dRec, cst, dep, rejected, saveSeen, execDone, fV, sres, svw, sp, cV, inbox, firstInbox, seen, ghost, bad>>
DCrash == /\ dalive /\ Once("crash") /\ dalive' = FALSE /\ dph' = "dead"
          /\ Seen(CASE dph = "pre" -> "start_crash_before_rename" [] dph = "post" -> "start_crash_after_rename" [] OTHER -> "daemon_crash")
          /\ UNCHANGED <<hasLimit, deadline, psOK, stage, open, bdl, dRec, cst, dep, rejected, saveSeen, execDone, fV, sres, svw, sp, cV, inbox, firstInbox, ghost, bad>>

\* ---- salvage と start の、salvage と同じ規則 ----
\* 規則 2〜4: 公開済みの結果、status.json の terminal、salvage の結果。どれも無ければ規則 5・6。
\* 結果は 1 つの名前 result.json（run-daemon の rpub か salvage の sres）。status.json を読めなければ規則 3 は当たらない。
Saved == IF rpub THEN dres ELSE IF sres # NoRes THEN sres ELSE IF statusAct = "terminal" /\ ~bad.s THEN statusRes ELSE NoRes
\* E_RESULT_UNREADABLE: result.json はあるが読めないか形に合わない。結果を作らず、誤りとして終える。
Unreadable == cpc' = "unreadable" /\ UNCHANGED <<cseq, cb, wf, final>> /\ Seen("result_unreadable")

\* ---- 司令塔が状態を受けて動く ----
ActOn(seq, act, b, res) ==
  IF act = "terminal" THEN cpc' = "done" /\ final' = res /\ UNCHANGED <<cseq, cb, wf, bad>>
  ELSE IF act = "run_agents" THEN cpc' = "wf" /\ cb' = b /\ wf' = "running" /\ cseq' = seq /\ UNCHANGED final
  ELSE cpc' = "wait" /\ cseq' = seq /\ UNCHANGED <<cb, wf, final, bad>>
Finish(res) == cpc' = "done" /\ final' = res /\ UNCHANGED <<cseq, cb, wf, bad>>

\* ---- start（起動の手順 2・3・5） ----
StartRet == ghost' = [ghost EXCEPT !.startTwice = ghost.startTwice \/ sp = "done"]
SCall == /\ cpc = "start" /\ sp = "call"
         /\ \/ /\ dalive' = TRUE /\ dph' = "pre" /\ sp' = "wait" /\ UNCHANGED <<cV, seen, ghost, bad>>
            \/ /\ sp' = "done" /\ Finish(RF) /\ UNCHANGED ucnt /\ StartRet /\ Seen("start_spawn_fail") /\ UNCHANGED <<dalive, dph, bad>>
         /\ UNCHANGED <<envV, stage, open, bdl, dRec, cst, dep, rejected, saveSeen, execDone, fV, sres, svw, inbox, firstInbox, bad>>
\* 5-1: 起動した process の終了を観測した。run の領域があれば salvage と同じ規則、無ければ起動の失敗。
SExit == /\ cpc = "start" /\ sp \in {"wait", "rewait"} /\ ~dalive /\ sp' = "done" /\ StartRet /\ UNCHANGED ucnt
         /\ IF runDir
            THEN IF HasResult /\ bad.r THEN Unreadable /\ UNCHANGED sres
                 ELSE IF Saved # NoRes THEN Finish(Saved) /\ UNCHANGED sres /\ Seen("start_salvage_saved")
                 ELSE sres' = RS /\ Finish(RS) /\ Seen("start_salvage_new")
            ELSE Finish(RF) /\ UNCHANGED sres /\ Seen("start_fail_no_dir")
         /\ UNCHANGED <<envV, dV, fV, svw, inbox, firstInbox, bad>>
\* 5-2: status.json が現れたら、その Status を返す。
SStatus == /\ cpc = "start" /\ sp = "wait" /\ runDir /\ statusAct # None /\ ~bad.s /\ sp' = "done" /\ StartRet /\ UNCHANGED ucnt
           /\ ActOn(statusSeq, statusAct, statusBatch, statusRes) /\ Seen("start_status")
           /\ UNCHANGED <<envV, dV, fV, sres, svw, inbox, firstInbox, bad>>
\* 5-3: START_WAIT_MS に達した。lock があれば working（seq 0）、無ければ起動した process を止めて 1 を評価し直す。
\* 変異 slow_no_kill は、止めずに受付の停止を返す。
STimeout == /\ cpc = "start" /\ sp = "wait"
            /\ IF runDir
               THEN sp' = "done" /\ StartRet /\ ActOn(0, "working", 0, NoRes) /\ UNCHANGED ucnt /\ Seen("start_slow_working") /\ UNCHANGED <<dalive, dph, bad>>
               ELSE IF Mutation = "slow_no_kill"
                    THEN sp' = "done" /\ StartRet /\ Finish(RF) /\ UNCHANGED ucnt /\ Seen("start_slow_nokill") /\ UNCHANGED <<dalive, dph, bad>>
                    ELSE sp' = "kill" /\ UNCHANGED <<cV, seen, ghost, dalive, dph, bad>>
            /\ UNCHANGED <<envV, stage, open, bdl, dRec, cst, dep, rejected, saveSeen, execDone, fV, sres, svw, inbox, firstInbox, bad>>
SKill == /\ sp = "kill" /\ sp' = "rewait" /\ Seen(IF runDir THEN "start_kill_after_rename" ELSE "start_slow_killed")
         /\ IF dalive THEN dalive' = FALSE /\ dph' = "dead" ELSE UNCHANGED <<dalive, dph, bad>>
         /\ UNCHANGED <<envV, stage, open, bdl, dRec, cst, dep, rejected, saveSeen, execDone, fV, sres, svw, cV, inbox, firstInbox, ghost, bad>>

\* ---- 司令塔 ----
\* 担当の Workflow が返る（公平性を置かない。返らないこともある）。
WfReturn == /\ cpc = "wf" /\ wf = "running" /\ \E r \in {"ok", "bad", "question"} : wf' = r /\ (r = "question" => cb = 3)
            /\ UNCHANGED <<envV, dV, fV, sres, svw, sp, cpc, cseq, cb, ucnt, final, inbox, firstInbox, seen, ghost, bad>>
\* 受け箱の公開（一時ファイル → link）。既にあれば duplicate で何も変えない。変異 inbox_overwrite は置き換える。
\* 変異 client_writes_status は submit が status.json も書く。
Publish(b, content) ==
  IF inbox[b] = None THEN inbox' = [inbox EXCEPT ![b] = content] /\ firstInbox' = [firstInbox EXCEPT ![b] = content]
  ELSE IF Mutation = "inbox_overwrite" THEN inbox' = [inbox EXCEPT ![b] = content] /\ UNCHANGED firstInbox
  ELSE UNCHANGED <<inbox, firstInbox, bad>>
CSubmit == /\ cpc = "wf" /\ (wf # "running" \/ (cb \in bdl /\ Mutation # "no_batch_deadline"))
           /\ Publish(cb, IF wf = "running" THEN "timedout" ELSE wf)
           /\ cpc' = "wait" /\ Seen(IF inbox[cb] # None THEN "duplicate_submit" ELSE "submit")
           /\ IF Mutation = "client_writes_status"
              THEN WriteStatus("working", 0, NoRes) /\ G("clientWrote")
              ELSE UNCHANGED <<statusSeq, statusAct, statusBatch, statusRes, ghost, bad>>
           /\ UNCHANGED <<envV, dV, runDir, rpub, dres, sres, svw, sp, cseq, cb, wf, ucnt, final, bad>>
\* 古い・二重の submit（CLI の出力を受け取れずに呼び直した、前の batch の値を送った）。
StaleSubmit == /\ cpc \in {"wf", "wait"} /\ Once("stale") /\ cb # 0
               /\ \E b \in BatchStages, c \in {"ok", "bad", "timedout"} : b <= cb /\ Publish(b, c)
               /\ Seen("stale_submit")
               /\ UNCHANGED <<hasLimit, deadline, psOK, dV, fV, sres, svw, sp, cV, ghost, bad>>
\* wait: terminal なら seq によらず返す。seq が増えたら新しい Status、保持者が終わって terminal でなければ E_STALE、それ以外は待つ。
\* 判定できない応答（ps が使えない）が UMax 回続いたら、結果を作らずに終える。
\* 変異 wait_ignores_seq は seq が増えていなくても今の Status を返す。変異 stale_on_unknown は判定できないときに E_STALE を返す。
CWait == /\ cpc = "wait"
         /\ IF ~bad.s /\ (statusSeq > cseq \/ statusAct = "terminal" \/ (Mutation = "wait_ignores_seq" /\ statusAct \in {"run_agents", "working"} /\ statusSeq = cseq /\ cseq > 0))
            THEN /\ ActOn(statusSeq, statusAct, statusBatch, statusRes) /\ UNCHANGED ucnt
                 /\ ghost' = [ghost EXCEPT !.waitEarly = ghost.waitEarly \/ (statusSeq <= cseq /\ statusAct # "terminal")] /\ UNCHANGED seen
            ELSE IF ~dalive /\ dph # "unspawned"
                 THEN cpc' = "salvage" /\ Seen("stale") /\ UNCHANGED <<cseq, cb, wf, ucnt, final, ghost, bad>>
                 ELSE IF ~psOK
                      THEN IF Mutation = "stale_on_unknown"
                           THEN cpc' = "salvage" /\ G("staleAlive") /\ UNCHANGED <<cseq, cb, wf, ucnt, final, seen, bad>>
                           ELSE /\ ucnt' = ucnt + 1 /\ cpc' = IF ucnt + 1 >= UMax THEN "gaveup" ELSE "wait"
                                /\ Seen("still_waiting_unknown") /\ UNCHANGED <<cseq, cb, wf, final, ghost, bad>>
                      ELSE FALSE
         /\ UNCHANGED <<envV, dV, fV, sres, svw, sp, inbox, firstInbox, bad>>
\* CLI の出力が JSON でなかった（1 回）。司令塔は salvage を呼ぶ。
Garbled == /\ cpc = "wait" /\ Once("garbled") /\ cpc' = "salvage" /\ Seen("salvage_garbled")
           /\ UNCHANGED <<hasLimit, deadline, psOK, dV, fV, sres, svw, sp, cseq, cb, wf, ucnt, final, inbox, firstInbox, ghost, bad>>
\* salvage。E_BUSY の役が run-daemon なら wait に、salvage なら salvage に戻る（変異 busy_daemon_to_salvage・busy_salvage_to_wait）。
CSalvage ==
  /\ cpc = "salvage"
  /\ IF dalive
     THEN /\ ucnt' = (IF psOK THEN ucnt ELSE ucnt + 1)
          /\ cpc' = (IF ucnt' >= UMax THEN "gaveup" ELSE IF Mutation = "busy_daemon_to_salvage" THEN "salvage" ELSE "wait")
          /\ ghost' = [ghost EXCEPT !.wrongBusy = ghost.wrongBusy \/ cpc' \notin {"wait", "gaveup"}]
          /\ Seen("busy_daemon")
          /\ UNCHANGED <<cseq, cb, wf, final, sres, svw, bad>>
     ELSE IF HasResult /\ bad.r
          THEN IF Mutation = "unreadable_returns_new"
               THEN sres' = RS /\ Finish(RS) /\ Seen("unreadable_new") /\ UNCHANGED <<ucnt, svw, ghost>>
               ELSE Unreadable /\ UNCHANGED <<ucnt, sres, svw, ghost>>
     ELSE IF Saved # NoRes
          THEN Finish(Saved) /\ Seen("terminal_by_status") /\ UNCHANGED <<ucnt, sres, svw, ghost, bad>>
          ELSE IF svw = "running"
               THEN /\ cpc' = IF Mutation = "busy_salvage_to_wait" THEN "wait" ELSE "salvage"
                    /\ ghost' = [ghost EXCEPT !.wrongBusy = ghost.wrongBusy \/ cpc' # "salvage"]
                    /\ Seen("busy_salvage") /\ UNCHANGED <<cseq, cb, wf, ucnt, final, sres, svw, bad>>
               ELSE \/ sres' = RS /\ Finish(RS) /\ Seen("terminal_by_salvage") /\ svw' = (IF svw = None THEN "done" ELSE svw) /\ UNCHANGED <<ucnt, ghost, bad>>
                    \/ svw = None /\ svw' = "running" /\ Seen("salvage_hang") /\ UNCHANGED <<cV, sres, ghost, bad>>
  /\ UNCHANGED <<envV, dV, fV, sp, inbox, firstInbox, bad>>
\* ホストの時間の上限で返らなかった勝者は、background で結果を作り終えるか、落ちる。
SvwEnd == /\ svw = "running"
          /\ \/ svw' = "done" /\ sres' = (IF sres = NoRes THEN RS ELSE sres) /\ UNCHANGED envUsed
             \/ svw' = "dead" /\ Once("svcrash") /\ UNCHANGED sres
          /\ UNCHANGED <<hasLimit, deadline, psOK, dV, fV, sp, cV, inbox, firstInbox, seen, ghost, bad>>

DNext == DRename \/ DFirstStatus \/ DAccept \/ DSkipStage \/ DOpen \/ DRead \/ DBatchDeadline \/ DRunDeadline
         \/ DEnterExec \/ DStartCheck \/ DSkipDep \/ ToolEnd \/ DExecDeadline \/ DQuestionStop \/ DExecDone
         \/ DAgg \/ DPubResult \/ DPubStatus \/ DExit
SNext == SCall \/ SExit \/ SStatus \/ STimeout \/ SKill
CNext == CSubmit \/ CWait \/ CSalvage
Next == DNext \/ SNext \/ CNext \/ DSaveFail \/ DCrash \/ Deadline \/ BatchClock \/ PsBreak \/ Corrupt \/ StatusBad
        \/ WfReturn \/ StaleSubmit \/ Garbled \/ SvwEnd

\* 公平性: run-daemon・start・司令塔の動作と時間の経過（期限・batch の期限）、道具の終わり（検査ごとの時間の上限）。
\* 担当（WfReturn）・crash・保存の失敗・環境の出来事には置かない。
Fairness == WF_vars(DNext) /\ WF_vars(SNext) /\ WF_vars(CNext) /\ WF_vars(Deadline) /\ WF_vars(BatchClock)
            /\ WF_vars(SvwEnd /\ svw' = "done")
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ Fairness

\* ---- 性質 ----
\* 結果として数えるのは、result.json（rpub・sres）、呼出し元が読める status.json の terminal、司令塔が受け取った結果。
\* 読めない status.json の terminal は、wait も salvage も読まないので数えない（Lock.tla の発見を参照）。
Produced == {r \in {IF rpub \/ (statusAct = "terminal" /\ ~bad.s) THEN dres ELSE NoRes, sres, final} : r # NoRes}
\* (1) 全ての run は、ちょうど 1 つの結果で終わる。
OneResult == Cardinality(Produced) <= 1
Ended == cpc \in {"done", "unreadable"}   \* 結果か、結果を 2 つにしない誤り（E_RESULT_UNREADABLE）で終わる
Termination == ([]psOK) => <>Ended
CommanderEnds == <>(cpc \in {"done", "unreadable", "gaveup"})
\* (1) E_RESULT_UNREADABLE は、公開済みの result.json があって読めないときだけで、新しい結果を作らない。
UnreadableNoNewResult == cpc = "unreadable" => (final = NoRes /\ HasResult /\ bad.r)
\* (2) 時間の上限の後に、道具の実行（確認用を含む）と担当を始めない。
NothingStartsAfterDeadline == ~ghost.afterDeadline
\* (3) 古い・二重の submit は状態を変えない: run-daemon が記録した batch の返り値は、その batch の最初の受け箱の内容だけ。
StaleSubmitNoEffect == \A s \in BatchStages : dRec[s] \in {None, "missing"} \/ dRec[s] = firstInbox[s]
\* (4) 保存の失敗は、status.json の terminal か salvage の結果に届き、その結果は停止である。
ResultExists == statusAct = "terminal" \/ sres # NoRes \/ rpub
SaveFailureReaches == ([]psOK) => (ghost.saveFail ~> ResultExists)
SaveFailureStops == (ghost.saveFail /\ final # NoRes) => final.st = "stopped"
\* (5) 完了は、完了の条件が全て成り立つときだけ。
CompleteOnlyIf == (final # NoRes /\ final.st = "complete") => CondTrue
\* (6) 反例・問いがあっても、独立な検査は（時間の上限・保存の失敗が無ければ）終わるまで動く（D1・D2）。
IndependentRunsToEnd == (execDone /\ ~deadline) =>
                          /\ (~dep /\ cst["K1"] = "cex" /\ cst["K2"] # "notplanned") => cst["K2"] \in {"ok", "cex", "unk"}
                          /\ (Question /\ ~dep /\ cst["K2"] # "notplanned") => cst["K2"] \in {"ok", "cex", "unk"}
\* (7) client は状態を書かない。wait は seq の増加か保持者の終了でだけ返る（terminal は seq によらず返す。cli-contract.md の wait）。
ClientWritesNothing == ~ghost.clientWrote
WaitReturnsOnlyOnChange == ~ghost.waitEarly /\ ~ghost.staleAlive
\* (8) salvage の E_BUSY の後、役が run-daemon なら wait に、salvage なら salvage に戻る。
BusyFollowsRole == ~ghost.wrongBusy
\* (9) start は全ての場合で、status か結果のちょうど 1 つを返す（結果を 2 つ作らないことは OneResult）。
StartReturnsOnce == ~ghost.startTwice /\ (sp = "done" => cpc # "start")
\* start が起動の失敗（run_dir が null の受付の停止）を返すのは、run の領域が無く、以後も現れない場合だけ。
StartFailOnlyWithoutDir == (final = RF) => ~runDir

TypeOK == /\ stage \in 1..LastStage /\ statusSeq \in 0..10 /\ ucnt \in 0..UMax /\ cpc \in {"start", "wf", "wait", "salvage", "done", "gaveup", "unreadable"}

\* ---- 到達の証人 ----
Never(t) == t \notin seen
Fin(st) == final # NoRes /\ final.st = st
NeverCompleted == ~Fin("complete")
NeverStoppedCex == ~(Fin("stopped") /\ final.k = "D" /\ cst["K1"] = "cex" /\ ~deadline /\ ~ghost.saveFail)
NeverStoppedDeadline == ~(Fin("stopped") /\ final.k = "D" /\ deadline /\ \E k \in Checks : cst[k] \in {"stopped", "notrun"})
NeverStoppedSave == ~(Fin("stopped") /\ ghost.saveFail)
NeverStoppedQuestion == ~(Fin("stopped") /\ final.k = "D" /\ Question /\ cst["K2"] = "ok")
NeverStoppedUndetected == ~(Fin("stopped") /\ final.k = "D" /\ cst["K1"] = "ok" /\ cst["K2"] = "ok" /\ cst["M"] = "cex")
NeverRejected == ~(Fin("stopped") /\ rejected)
NeverSalvageFinal == ~(final # NoRes /\ final.k = "V")
NeverStartFail == ~(final # NoRes /\ final.k = "F")
NeverGaveUp == cpc # "gaveup"
NeverUnreadable == cpc # "unreadable"
NeverDuplicateNoEffect == ~(\E s \in BatchStages : firstInbox[s] # None /\ dRec[s] = firstInbox[s] /\ "duplicate_submit" \in seen)
=============================================================================
