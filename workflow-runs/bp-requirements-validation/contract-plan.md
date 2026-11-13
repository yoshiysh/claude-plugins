# 要求層の最小契約モデル案

状態: 設計案。独立 method review と明示承認前は実装・実行しない。

## 目的と境界

D29/O27 の現行56要求を検証する作業について、sourceで定めた条件から義務が両立し得るか、停止・報告・外部入力・新run・再開の関係が矛盾しないかを小さく表す。対象は `validation.md` の33個の独立期待 S01–S33 と S32 の明示裁定。仕様6本のoracle検証は56要求の検証完了まで始めない。

旧モデルの50 action/24遷移の実装内部パイプライン再現は新契約にしない。既存モデル・実行結果・未達履歴はそのまま凍結する。旧24遷移/50 actionの保証は未達のまま履歴へ残す。この案の承認は旧結果の合格化、予算のリセット、56要求全体の合格を意味しない。

## 最小表現

1. **要求関係**: source句ごとに `subject, source_guard, obligation/forbidden_outcome, exception, source_ref` を持つ。有限の入力context `c` に対し、source guardを満たす要求群から義務集合 `O(c)` を作る。挙動出力の候補 `x` が義務集合を同時に満たす関係 `Sat(c,x)` を定める。義務の実装順、worker呼出、CLI保存手順はモデル化しない。
2. **二つのSAT判定**: (a) `Realizable(c)` は context の前提だけを満たす状態/履歴が存在するか、(b) `Compliant(c)` はその同じ context の下で全義務・禁止を満たす出力が存在するかを独立に問う。`Realizable(c)=UNSAT` のとき義務競合の証拠にしない。義務の一つを落とした変異がsource期待と同一contextで通ることを確認し、独立source reviewerの期待と照合する。局所禁止式だけのUNSATを要求適合の証明と呼ばない。
3. **小さい履歴関係**: 正規のsource cutpointだけを持つ遷移 `(snapshot,event,result,snapshot')` を置く。必要な状態は、run/epoch/停止episode、最初の停止位置と段内未記録集合、不足入力bit、複数保持可能な停止理由/cleanup理由/未保存範囲、段結果記録有無、hint既読集合、配達IDと不変配達snapshot（run/epoch/phase/role/hint集合）、指摘ID・根拠ID・旧受理履歴・現run状態。拒否は明示resultとし、拒否receipt以外のsemantic stateをframeで不変にする。
4. **時系列と到達**: 各正常/禁止性質は同じ対象ID、直前直後境界、必要なrun/epoch/episode/delivery、sourceが要求するevent順を束縛する。初期状態とsource遷移から目的終点までの到達性を別queryにし、個々のSAT witnessの寄せ集めをpath到達と扱わない。有限episode/delivery境界の外、unknown、timeout、未対応signatureは未検証として保持する。
5. **contextの閉領域**: 候補context/event/result値とsignatureの自由変数を事前に固定し、各領域を `A=sourceで許される`, `F=sourceで禁止`, `Choice=sourceが選択を義務/禁止していないと確認できる`, `U=source対応をまだ確定できない` に分類する。Choiceには対応するsource句と、義務/禁止を課さないとした理由の両方を記録し、単なる空欄をChoiceにしない。`F` は `not A` から生成しない。A/F/Choice/Uを各partitionで重複なく全域分類し、A∩F、未分類、U領域ごとの到達性を出し、非採用/未対応の理由を保存する。閉集合外は未検証であり、正常/禁止へ丸めない。
6. **報告観測**: 論理5材料（理由、判断事項、検証結果、影響、残作業）をslot単位で扱う。不存在既知、未保存範囲、理由、停止phaseを区別する。実際の文章品質、hostでの制限強制、独立contextの意味品質は保証対象外。

通常不合格と形式不成立、入力不足、起動上限、保存失敗等は互いに排他的なenumにしない。source guardが同時に満たされる同一contextでは、義務を和集合として同時充足可能か調べる。段の順序により同時に起こり得ない事象は履歴制約から除くが、排他性を仮定して消さない。

### 閉じた領域・型と観測値

| 型 | このgroupの有限値域と意味 |
|---|---|
| operation | `create / update / review / audit`。要求の主体・対象操作を区別する。
| namespace / host | namespace `target-skill / BP-operation`、host `Codex-runner / native-Workflow`。要求が区別しないhost値はそのcontextで `not-applicable` とせずsource未指定のChoiceとして残す。
| identity | 対象、run, epoch, 停止episode, item, 起動attempt, hint, delivery, role, finding, groundref, evidence, dependency-result。case-local閉集合は最低限 `run={old,current}`, `epoch={e0,e1}`, `episode={0,1,2}`, `item={i0,i1}`, `hint={h0,h1}`, `delivery={d0,d1}`, `finding={f_old,f_current}`, `groundref={g_old,g_new}`, `evidence={ev0,ev1}`, `dependency-result={r_affected,r_unaffected}`。旧/現findingは異なるID。S08のattemptはcase入力Nに応じ許可呼出し `{a1..aN}` と超過境界の入力 `{aN+1}` を持たせ、結果は `returned / no-response / over-cap-attempt` を区別する。固定値Nの拒否境界だけを観測し、任意N/無界の保証にはしない。
| role | source cutpointで必要な `planner / stage-role / old-run-issuer / current-run-issuer`。未指定の実役名・権限を発明しない。
| phase / item-state | source cutpointのみ: `input / goal-fixing / goal-fixed / plan / execute / check / decide / report / complete` と、`unstarted / started-no-result / recorded`。goal phaseと別に`goal-fixed={false,true}`を持つ。`goal-fixing`でfixed=falseの停止と、fixed=trueの停止を潰さない。値は現在の期待caseに現れるものへ閉じ、実装内部段を網羅しない。
| event | `StartOperation, StartWorkflow, NewRun, NeedInput, SupplyAnswer, ExternalRepair, GoalFixing, GoalFixed, FanoutAttempt, CapReached, NonformalFail, Rewrite, IndependentReverify, VerificationPass, FormalUnavailable, FormalFail, Persist, PersistFail, AddHint, Deliver, ReturnOutput, AcceptCommand, RejectCommand, Stop, Report, Resume, DependencyChanged, MarkEvidenceInvalid, ReverifyAffectedEvidence, ReceivePriorFindingGround, EvaluateCurrentFinding, ReportCurrentFindingStatus`。実装コマンド名ではなく、sourceで区別する出来事とその因果cutpointのみ。
| transition result | `Accepted / Rejected / Stopped / Reported / Completed`。sourceで観測する遷移結果。event/resultは遷移後phaseから推定しない。
| classification | `A / F / Choice / U`。source文とcontextについての分類層であり、遷移resultではない。
| solver metadata | `sat / unsat / unknown / timeout / error / not-run` と理由・solver版・制限。検証器の実行状態であり、model transition/resultでもA/F/Uでもない。
| report slot | O052の5欄: `理由 / 決めること / 検証結果 / 影響範囲 / 残作業`。各欄は `present / known-absent / unsaved / U`。目標前では検証結果・残作業を `known-absent`、目標固定時は既得検証結果・残作業の有無と実値参照を保持する。

各signatureは上表から参照するfield一覧を宣言する。各signatureが参照するfieldへの射影だけを有限列挙し、全fieldの巨大な直積は作らない。candidateは射影内の型として可能な全値組合せから作り、source guard・正規Nextを生成時に前提化しない。型違いの組合せは `type-invalid` として数え、source禁止や義務違反に数えない。source fieldが足りない/意味対応が未確認のsignatureはUとし、候補集合から除かない。既存case/oracleに無い数値上限・実役IDの選択が必要なら推測せず親へ戻し、その依存queryは未実行とする。

### source cutpointからの初期・終点・遷移

開始状態は要求が対象とする操作が依頼された直後の `StartOperation(operation)` と、その操作がWorkflowを開始する場合の `StartWorkflow(namespace,run,epoch)` のみを置く。内部の準備段取りは作らない。終点は source が要求する `Completed`、`Stopped → Reported`、または停止snapshotを引き継ぐ `NewRun → Resume`。報告/cleanupは対象操作の前進とは別event/resultとする。

閉じた経路群は、33Sの各期待で列挙した同一source対象の順序関係から作る。最低限、(a) Start→必要条件を満たす処理→Completed、(b) Start→停止条件→Stopped→Reported、(c) Stopped→（回答/修復が入力された場合のみ）SupplyAnswer/ExternalRepair→NewRun→Resume→当該期待の完了/停止先、(d) 完了後のResume拒否を分けて初期から終点まで到達を問う。回答/修復が無い場合はStopped/Reportedから先を要求しない。S18の完了後再開禁止とS24の入力変更による新状態開始を先に適用し、S19–22/25の再開entry規則は残る非完了・同状態の再開だけに適用する。S33では O015/022 が許す old finding と originGround を現在runの入力contextに置き、その後の `ReceivePriorFindingGround` と別IDのcurrent finding評価/報告を順序化する。old statusは初期contextから引き継がない。どのsource経路も閉じていない部分は `U` とする。

S08–10/19/29は同じ対象・item ID・順位・attempt順・run・episodeで、呼出し数（返答なしを含む）と未着手集合の直前/直後を観測する。新runの試行countは0から始め、前runの順位付き未処理集合を引き継ぐ。上限変更/打切許可と再開受付は同じepisodeで照合する。S26は固定した有限値の反例探索に限り、その結果から入力非依存上限が無界に存在しないと証明しない。

## S01–S33 source対応表

`validation.md` の各行が期待・反期待・根拠の正本。本表は新signatureの割当て案であり、独立レビューで原文の主体/前件/義務/例外との双方向照合が通るまで未検証とする。

| S | source refs | context/signature fields → invariant / temporal observation |
|---|---|---|
| S01 | O009/010/014/051 | create/update, verify-context, persist-status → `Complete`前に別context検証・成果/説明/結果を観測。自己評価のみ/手順終了のみのCompleteは禁止。 |
| S02 | O011/010 | create/update, run, failed-verification-context, rewrite, new-verification-context → `NonformalFail→Rewrite→IndependentReverify→VerificationPass`を同一run内の許容pathとして表す。書直しを義務化しない。再検証なしCompleteは禁止。 |
| S03 | D027/O011 | create/update, formal-unavailable, run → 現run `Stopped→Reported(target,reason)`。同runで環境修復後に続ける遷移は禁止。別runで復旧・再検証は許容であり実施義務ではない。 |
| S04 | D027/O011 | create/update, formal-fail, run → 必要形式性質不成立時に現run停止・対象/理由報告。別runの修正・再検証は許容、義務ではない。 |
| S05 | O005/052/003 | create/update, missing-approval-or-answer, run, external-answer → `NeedInput→Stopped→Reported`は回答の有無によらず必要。`SupplyAnswer`で不足回答が満たされた場合だけ`NewRun→Resume` pathを許す。回答無しにgoalを確定/Workflow内待機することは禁止し、回答無しでNewRunを義務化しない。 |
| S06 | O052 | phase-before-goal-fixing, goal-fixed=false, 5 report slots → 5欄を保持し、検証結果/残作業はknown-absentと示す。 |
| S07 | O052 | phase=goal-fixing, goal-fixed=false, 5 report slots, prior-results, remaining-work → 目標を固定中の停止として表す。5欄と既得検証結果・残作業を実値またはknown-absentで区別する。phase=goal-fixed / goal-fixed=trueへ読み替えない。 |
| S08 | D016/019 | target, item, rank, run, attempt, reply, cap, remaining-set → 各起動attempt（無返答含む）を数え、順位付き未処理を保持して停止。 |
| S09 | D019/S再開回数上限 | target, old/current-run, remaining-set, run-local-count → 新run count=0、前runの未処理集合から開始。不要な上限変更入力は要求しない。 |
| S10 | S再開受付 | stop-episode, handoff-count, input-cap, truncation-permission → 同episodeの上限引上げ又は許可範囲の打切り入力を条件に受付。各fieldを区別する。 |
| S11 | D035/034, O051 | save-results, saved-set, unsaved-set, reason, run → 保存済保持、未保存範囲と理由を報告、完了禁止。報告を対象処理続行と同一化しない。 |
| S12 | O040 | create/update, written-files, verified/unverified, phase → file保持と検証済/未検証/phase/reason報告。rollbackしない。 |
| S13 | O013 | review/audit, stop-reason, phase → 失敗以外の中断もphase/reasonを報告。 |
| S14 | O013/038 | operation-chain, blocked, phase, downstream-op → 4機能で続行不能失敗なら`BLOCKED`。成果完了/後続機能を禁止。 |
| S15 | D007→S | run, current-phase, hint, receiving-role, delivery → 稼働runを停止せずplan roleまたは次stage roleへ配達。hintを承認待ちに変換しない。 |
| S16 | D007→S | delivery, hint-set, role-output, failure → 役が出力を返さず失敗したらhint未読を保持。delivery単独で既読化しない。 |
| S17 | D007→S | delivery-id, delivered-hints, output-return, CLI-accept, rejected-completion-claim → 受付したそのdeliveryのhint集合だけ既読。未配達hintで広げない。 |
| S18 | D007→S | completed-run, add-hint/resume → `Rejected`。complete stateを再開へ遷移させない。 |
| S19 | D019/D007→S/G | unread-hint, planner-present, remaining-set, entry → plan role先行、残集合を維持して順位見直し。最初の実行段へ固定しない。 |
| S20 | D007→S | prior-stop, same-input, entry-phase, unrecorded-items, unread-hints=false → 同じ停止段/itemから再開。既記録item再生成は禁止。 |
| S21 | D007→S | prior-stop, same-input, entry-phase, unrecorded-items=empty, unread-hints=false → 次判断段へ。完了段を再判定して即停止しない。 |
| S22 | D007→S | planner-absent, unread-hint, stop-snapshot, stage-role, delivery → snapshot位置の段役がhintを読む。plan roleを強制せずhintを捨てない。 |
| S23 | D007→S, D012→W | old/current-run, delayed-command, state/plan-frame → old commandは現runの状態/計画を不変にする。 |
| S24 | D007→S但書 | blocked-cause, old/new-input, run, epoch → 原因修正とinput変更後は新状態から新run開始。old input判定を残す同状態Resumeは禁止。 |
| S25 | D007→S | blocked-cause-fixed, input-unchanged, stop-snapshot, entry → 非完了stopから新run。停止種別だけでentryを固定せずS18/S24後の位置規則へ渡す。 |
| S26 | D021/022 | host, cap-input, fanout-size, total-attempts, concurrency → 有限値のfixed-cap counterだけを調べる。無界主張は未検証。並行数を総数へ流用しない。 |
| S27 | O011/D027 | same-context nonformal-fail, formal-fail, rewrite, run → 非形式書直し`Allowed`を形式失敗時の同run継続義務へ強めず、形式停止を保持。 |
| S28 | D027/035, O005/052/040/051 | same-context fail/input/cap, persist-fail, saved/unsaved, reason-set, report → 義務を合成。対象処理停止、保存済保持、全理由/未保存範囲報告、完了禁止。cleanup/reportは処理前進ではない。 |
| S29 | D016/019/D007→S | old/current-run, attempt-count, remaining-set, unread-hint, planner, entry → count reset・同じ順位付き残集合・plan先行を一つのordered pathで観測。 |
| S30 | D007→S/D012→W | old/current-run, epoch, delivery-id, role, hint-set, old/current-command, semantic-frame → 同一deliveryでold `Rejected`後frame不変、続いてcurrent `Accepted`だけが同じdelivery集合を既読化。 |
| S31 | O038 | chain-position, stopped-op, downstream-ops, report → stop/report後に後続機能を開始しない。修正用inputだけでupdateを自動開始しない。 |
| S32 | design未決事項(i), O028, 明示裁定 | old-history, dependency-field, affected/unaffected-result, eligibility, reuse-choice → `DependencyChanged→MarkEvidenceInvalid(affected-result)→ReverifyAffectedEvidence`を同一evidence/result/run lineageで順序化。無関係結果はeligible/useableでも任意選択。旧source記載へ偽装しない。 |
| S33 | O015/022 | old-finding, originGround, new-ground, `f_current`, new-run, current-status, history → `old finding→ReceivePriorFindingGround→EvaluateCurrentFinding(f_current != f_old)→ReportCurrentFindingStatus`を同一ordered pathへ束縛。履歴保持、old statusの自動継承なし、現run statusのみ報告。 |

このgroupの33Sは第一group/停止再開部分句用の直接source期待であり、56要求の全句を包含しない。既存 `coverage.json` を全要求indexとして使い、各source sentence/exceptionを `covered-by-S / residual-group-2 / residual-group-3 / residual-group-4 / unclassified-U` のいずれかへ句単位で割り当てる。remaining groupsの検査対象は次の範囲であり、新しい56件engineは作らない。

割当て単位は `coverage.json` の132個の `source_sentences` と103個の `normative_occurrences` が示す原文範囲・offset/anchor。Sのsource refで一文に触れただけでは一文全体をcoveredにしない。各一文を規範offsetと接続語/条件節の短いsource spanへ分け、`source path + sentence hash + span start/end (又は normative offset/anchor) + source clause + S/contract-rule` で対応範囲を示す。同じ文中でもSが表すspanだけを `covered-by-S` とし、未表現spanは残余group 2/3/4または `unclassified-U` のいずれかで明示する。特に複数義務が同居するD034/O038は一部Sで文全体を被覆しない。元hash・line・offsetはcoverage既存値を参照し、部分句anchorはこのplanに短く記し、IDごとの新規要求評価engineや別の大きなregistryは作らない。

| coverage上の句群 | このgroupで扱う句 | 残す句（独立method/source reviewへ） |
|---|---|---|
| D007, D016, D019, D027, D035, O005, O011, O013, O038, O040, O051, O052, O022, D034等、各Sのsource refs | 33Sで列挙した停止/entry/上限/結果受渡/保持句とS32追加入力だけ。 | 各要求のS期待に使っていないsource sentence、横断関係の残り、該当しない例外はUのまま句単位に列挙。 |
| remaining group 2: D001/002/006/008/009/010/011/014/015/046/051、D021/022、O003/008 | 33Sと重なる上限なし/native分岐、目標前後条件の句だけ。 | 形の選択、役設定、host制限実効性、prompt/探索グラフ説明、D051網羅性などは残余。有限例を意味・host保証にしない。 |
| remaining group 3: D012/013/028/029/032/034/036/040, O051とD011の追加句 | 33Sの停止時保存保持・履歴到達のsource句だけ。 | 書込actor、受理/運搬、冪等/競合、正本、証拠意味対応、性能情報などは残余。 |
| remaining group 4: D024/025/026, O001/014/015/018/019/021/024/025/028/030/031/032/033/036/038 | 33Sの停止/再開・finding引渡し・report義務に使ったsource句だけ。 | 機能非該当、検証法適合、既存動作保持、指摘反証/却下、監査基準、coverage/skip/asset結合などは残余。 |

remaining groups文書に記載されていないがcoverageで未対応の句は `unclassified-U` に残し、新しい分類を推測しない。正常/禁止mutant/例外比較は33Sのsource ID・句を同一contextで束縛する。禁止はsource前件とsource期待mutationから独立に作り、`F=not A`や遷移実装から期待値を導出しない。

同一contextの明示比較は次の通り。O011/D027では `NonformalFail` の書直しは許容（必須でない）、`FormalUnavailable/FormalFail` は同run続行禁止であり、別run復旧・修正・再検証は許容（実施義務ではない）。O005/O052と上限停止/保存失敗では理由集合を併存させ、(a)対象処理停止、(b)cleanup/保存済保持/未保存範囲記録、(c)5欄報告を別resultとして検査する。S30は同じ `d,role,epoch,hint-set` のdeliveryをold reject→frame不変→current acceptの順で比較する。S33は `f_old` を `g_old` に基づくoriginGround、`f_current != f_old` として同一traceに束縛し、旧根拠の受領可能性と現runだけのfinding statusを分ける。S02/S03/S04では許容を常時義務へ強めず、禁止mutantは各sourceの該当guardでのみ適用する。

## 独立レビューの受入条件と保証限界

- source reviewerが全33件の条件・主体・義務/禁止・例外から署名への対応と逆向きの過剰条件を照合する。S32の外部裁定入力はsource本文の既存要求と偽装しない。
- method reviewerが同時成立可能なordinary/formal context、各contextのrealizability対complianceの独立SAT、単義務欠落mutant、禁止のsource前件、拒否frame、初期状態からの到達pathを確認する。
- A/F/U領域、有限境界、未到達・閉領域外、unknown/timeoutの扱いと非採用理由を実行前に固定する。非空な適用contextを確認し、矛盾前提や空初期状態でのSAT/UNSATを成功根拠にしない。
- S32に対する独立関係は保存し、dependency変更のある結果はcurrent reuseから外して再検証する。該当する依存が変わらない証拠は旧証拠のまま保持できる。結論は依存fieldの対応に限る。
- 保証はsourceで定義したcontextとcutpoint、有限run/episode/delivery境界内の関係と到達性まで。実BP code、host/API実動作、文章の意味品質、無界回数、独立検証の実品質は保証しない。過去の43 SAT・多数のunknownやC700分類のsource未対応は本案の成功数に加算しない。

## 参照

- `workflow-runs/bp-requirements-validation/validation.md` — S01–S33、正常/禁止期待、5群、前回未達、S32裁定、継続phase境界。
- `workflow-runs/bp-requirements-validation/source-table.md` と `coverage.json` — D29/O27 source mappingと原文hash/条件候補。意味合格の証拠ではない。
- `workflow-runs/bp-requirements-validation/reviews/remaining-requirement-groups.md` — 後続5群の未検査句と機械関係/独立意味確認の境界。
- `docs/requirements/formal-method.md` PR-FORMALMETHOD-003/004/005/009/010、`docs/specifications/formal-method.md` SP-FORMALMETHOD-006/011/012 — 閉集合分類、到達可能性、source対応、判定/原因、独立確認と変異検出。
- `docs/guidelines/agent-work.md` の目的固定・設計/レビュー分離・独立検証・有限反復・最小成果、`docs/guidelines/documentation.md` の具体条件/参照/保証境界。
