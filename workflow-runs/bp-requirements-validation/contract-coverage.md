# 要求句とsource-cutpointの対応（first-group bridge）

状態: 実装者作成のsource bridge。独立意味確認は未完了。これはD29/O27全体のcoverage完了を示さない。

source freeze: `coverage.json` SHA-256 `5188874ed264d7a09542dde4f463a2fb593f913c75794857ad126634e522a042`。参照する原文は `docs/requirements/bp-designed-skill.md` SHA `e7fd43456763d8327ce8a008fd68e0a9511f3149ebfecf987f0e687f72ecbe0c`、`docs/requirements/bp-operations.md` SHA `ce0b67b9c97c839d1eae2f809aaf726e77f8c4303f9353c256c1584e7cc76290`、設計方針 `docs/design/skill-design-patterns.md` SHA `13dcf260e06158fbed3cf89725be6462cc0af5dc88e7aa6c6f073e7622ede023`。原文ファイルは変更していない。

`contract-source-inventory.tsv` は上記 `coverage.json` から導出した全132 source sentence/103 normative offsetの機械索引。unitごとのsource path・ID・半開区間・SHA・短いanchorを保持する。現割当ては`residual-group2=59`、`group3=25`、`group4=55`、`unclassified-U=96`（両unit型の合計235）。group番号は後続調査の行先であり、個々の句が意味確認済みという判定ではない。ここでの`unclassified-U`は、下表の部分句候補を含む文/規範offsetについても**unit全体のcovered判定をまだ出していない**意味である。部分句候補と残部を独立source reviewで確定するまで、indexのunitをcoveredに昇格しない。

機械索引のgroup割当ては `contract-plan.md` のremaining-group listで**所属が一意のIDだけ**に付けた。group 2 は D001/002/006/008/009/010/014/015/046/051・O003/008、group 3 は D013/028/029/032/036/040、group 4 は D024/025/026・O001/018/019/021/024/025/030/031/032/033/036。first groupと重なるID、複数groupの追加句を持つID、O037など行先を定めていないIDはUのまま。これらの行も`coverage.json`の既存hash/offsetを写した機械索引で、残余の意味分類を証明しない。

## 割当ての規則

`coverage.json` の `source_sentences` は文境界/hash、`normative_occurrences` は規範語のoffset/anchorとして使う。Sからsource IDへ参照があるだけでは規範文全体をcoveredとしない。以下の表では、Sで表した範囲だけをcovered候補とし、同じ文内の他の必須・禁止・許容句は残余に置く。spanの厳密なchar範囲は参照hashとnormative offsetの組を保持して後続の独立source reviewで確定するまで、未検証としている。offsetの文区切り・条件節をまたぐ対応を推測しない。

| source | coverage上のnormative offset / source sentence anchor | Sで表す部分句（covered候補） | 残余の扱い |
|---|---|---|---|
| D007 | 79; sentence 0–88「判断材料と再開に必要な情報…中断を完了と扱…」, 88–112 | S15–25/29/30: 人入力境界の停止・報告・再開、完了状態から再開しない、入力変更を新状態とする境界。 | Workflowの全停止・再開条件を33Sが網羅したとはしない。S対象外の文言・host適用はU/group 2へ。 |
| D012 | 85; sentence 0–94「同じ更新の再送・競合・中断…」、94–143「CLIだけ…運搬、受理…」 | S23/S30: 旧run遅延書込で現run状態/計画を変えない部分だけ。 | 再送/競合時の冪等性、CLIのみ書込、運搬と受理の分離、追記・決定的照合はgroup 3。 |
| D016 | 52, 82; sentence 0–61「1 runの起動数…入力…上限」、61–91「結果を返さなかった呼出し…」 | S08: 入力Nと同一run起動数、無返答起動も計数する有限case。 | 任意host上での計数実動作、任意Nは保証せずgroup 2/未検証。 |
| D019 | 67, 98; sentence 0–76「順位付き未着手…新run…残り」、76–105「未処理を切捨…」 | S08/09/19/29: 同一有限item/rankの残集合保持、run-local count reset、再開で残りから続ける。 | 任意件数・無界run数・動的順位変更の全域保証は未検証。 |
| D021 | 62; sentence 0–69「fan-out項目数と1 run起動数に入力非依存の固定上限を置いてはならない」、69–95「同時実行…対象外」 | S26: 選定有限値で固定上限counterを観測し、並行上限と総数を別fieldにする。 | 有限caseから無界の「上限なし」を証明しない。group 2へ。 |
| D022 | 77; sentence 0–84「Codex runnerでは…native Workflowでは渡してはならない」、84–134「hostの制約…」 | S26: native側で起動上限を渡さない有限観測の候補。 | Codex/native間の完全なhost分岐、実hostの授受・強制はgroup 2。 |
| D027 | 64; sentence 0–73「形式検証を実行できないか…runを止め…」、73–102「別のrunで行ってよい」、102–139「形式検証以外…」 | S03/04/27/28: 形式不能/不成立時の現run停止・対象/理由報告・同run続行禁止。別run修正等は許容。 | 非形式書直しはO011側の許容。D027の別run許容は実施義務として扱わない。 |
| D034 | 73; sentence 0–82「保存できた作業記録・証拠・台帳と過去判断を…保持し、新しいrunで更新しても過去へ辿れる」 | S11: 保存失敗時の保存済記録保持に関係する部分のみ。 | 利用者削除指示までの一般保持、成功時/新run更新後の過去traceabilityはgroup 3。D034全体をcoveredにしない。 |
| D035 | 60, 80; sentence 0–69「保存不能…止まり、保存できたものを保持…未保存範囲と理由を報告」、69–87「完了と報告してはならない」 | S11/28: save-fail時stop、saved-set保持、unsaved範囲/reason報告、完了禁止。 | 任意の記録資産種別への意味適用はD035全体の独立照合を待つ。 |
| O003 | 57, 79, 129; sentence 0–66「create依頼と回答から目標」、66–86「依頼にない目標・制約禁止」、86–138「update目的と修正根拠」 | S05: create/updateの承認/回答不足で目標を確定しない部分だけ。 | 依頼外目的/制約禁止、updateの対象目的/修正根拠の全適用はgroup 4。 |
| O005 | 62, 96; sentence 0–71「承認・回答不足ならneeds_input・判断材料・stop」、71–103「Workflow内で待ち続けない」 | S05: 欠落入力でstop/report、外部回答前の待機禁止。NewRunは回答後の条件付きpath。 | 他のcreate/update goal conditionsはO003 residual。 |
| O009 | 45, 73; sentence 0–54「生成者と別contextで検証」、54–80「説明/自己評価を根拠にしない」 | S01/S02: 完了経路で生成contextと検証contextを分離。 | 別contextの実際の独立性・検証品質はformal bool model外。 |
| O010 | 35, 67; sentence 0–42「必要検証まで完了報告禁止」、42–76「未達停止時に未達と理由」 | S01/S02/S03/04: 合格前完了禁止、停止時未達理由。 | 全種の必要検証充足性は56要求全体の残余。 |
| O011 | 45, 122; sentence 0–50「形式以外の不合格は書直し独立再検証してもよい」、50–129「形式検証不能/不成立で同run書直し続行禁止」 | S02/03/04/27: 非形式rewriteは許容(義務ではない)、形式失敗後同run続行禁止。 | 許容は経路の存在であり書直しの常時必須化をしない。 |
| O013 | 44, 100; sentence 0–53「続行不能でBLOCKED/phase」、53–109「review/auditは全ての完了前停止でphase/reason」、109–138 | S13/14: review/auditの失敗以外を含む停止報告、続行不能時BLOCKED。 | source文の他の適用条件を別操作へ拡張しない。 |
| O014 | 46, 101; sentence 0–55「完了時にskill/説明/結果」、55–110「指摘状態/skip/残る危険」 | S01: 完了出力の主要3種と検証結果。 | finding status、skip一覧、残危険の完全性はgroup 4/意味確認。 |
| O015 | 49, 99, 128; sentence 0–58「対象全体と1件以上の根拠」、58–108「件数上限なし/全件受領」、108–135「件数による拒否/切捨禁止」 | S33: old findingを修正根拠として受け入れる有限case。 | 任意件数すべての受領、対象全体/1件以上の前提はgroup 4。 |
| O022 | 74, 107, 166; sentence 0–81「old resolved/regressed禁止」、81–116「現run状態のみ」、116–173「old finding根拠として受取可・追跡継承不可」 | S33: 1つのold finding/groundを受け、別IDのcurrent finding状態を報告し、old statusを継承しない。 | 任意件数/全状態/任意run数はgroup 4/無界境界。 |
| O028 | 103, 200; sentence 0–112「audit基準・証拠継承」、112–132「未決事項は裁定しない」、132–209「基準なしで監査を止め理由報告」 | S32にはO028への参照があるが、追加裁定をO028の新しい要求とはしない。 | O028の全audit dutiesはgroup 4。S32のreuse判定は別の裁定入力。 |
| O038 | 97, 148, 196; sentence 0–114「指定順/依存順/不明なら確認」、114–155「順実行・不足入力代用禁止」、155–205「途中停止時後続禁止・停止報告」 | S14/S31: 途中停止後の後続不実行と連鎖停止報告。 | 指定順、依存順、利用者確認、不十分入力の受渡禁止はgroup 4。O038文全体をcoveredにしない。 |
| O040 | 67; sentence 0–76「完了前停止時、書込file保持、検証済/未検証/phase/reason、rollbackは利用者判断」 | S12: 中断file保持と範囲/phase/reason報告。 | run全体の意味でのfile状態把握は別途意味確認。 |
| O051 | 74; sentence 0–83「4機能各runへDの記録/証拠/台帳/保持/保存失敗を適用」、83–116「自らの判断も検証可能」 | S11: BP operationのsave-fail stop/保持のbridge。 | 4機能全体に対する各D要求の適用・記録到達はgroup 3。 |
| O052 | 85, 158; sentence 0–94「needs_input時の理由/決めること/結果/影響/残作業と不存在明示」、94–167「目標前は結果/残作業なし、目標固定で残作業/既得結果」 | S05–07: 5欄を保持、goal前不存在、goal-fixing/goal-fixedを区別。 | 文章の意味品質ではなくslot存在/値区分だけをモデル化。 |

## 33S以外のsource句

coverage.jsonのD29/O27全56要求から上表にないsource ID、および上表IDでも「covered候補」に明記しないsentence span・normative offsetは、この契約modelでcoveredにしない。`remaining-requirement-groups.md` group 2/3/4に該当する部分句へ振り分け、対応先が決められない句はUのまま残す。132文・103規範offsetの全数値はindex総数であり、この表が全件割当て済みという意味ではない。実装時に各元hash/offsetと部分句の照合を独立source reviewerが再確認する。

## 実装後に切り出したsource span候補

以下は `coverage.json` の source sentence half-open offset とSHAをそのまま参照する。`候補` は対象句をSMTの局所関係へ写した範囲を示し、独立意味合格や文全体の被覆を意味しない。残りの句・例外は前表の残余欄とremaining groupsに保持する。本文のhashは上記source freezeと `coverage.json` の各IDの `body_sha256` による。

| source path / ID | source sentence span / SHA-256; normative offset | 実装の候補句 / rule | 判定 |
|---|---|---|---|
| `bp-designed-skill.md` D016 | 61–91 / `4ad1b39064509067500da7fcd4395d6256f9db0fb608443743b1f3a77d82212a`; 82 | 無返答の起動もrun-local countに含める / `SourceAttemptDuty`、S08 | 候補。cap入力の受け渡し全体は残余 |
| `bp-designed-skill.md` D019 | 0–76 / `d3a713a5e59fb16f9139a2d5fa858c8904f3350bddc608fcbddd2c0378efa562`; 67 | 上限停止時の順位付き未着手と新run残集合 / `CapStop`、`CapNewRun`、`CapToResume`、S08/09/29 | 候補。任意項目数と順位再設定は残余 |
| `bp-designed-skill.md` D027 | 0–73 / `ee2d01900918401426888fe959bfed59dfaea32a821ae3b15e42f50fdbb5afc8`; 64 | 形式不能/不成立の当run停止、対象と理由 / `FormalObservation`、`FormalStop`、S03/04 | 候補。別run復旧許容は独立検査待ち |
| `bp-designed-skill.md` D035 | sentence 0–69 / `96308853a9b17b6b131044d8eab55f5ae1837da933cb5437c2d034731b19ae29`; clauses 0–30, 30–69; 60 | 保存不能前件→停止 / `SourceDuty`、保存済み保持と未保存範囲・理由 / `PersistFailureDuty`、`ReportStopDuty`、S11/28 | 候補。全資産種別への適用と実保存は残余 |
| `bp-designed-skill.md` D035 | 69–87 / `8a11efc92c30f1d0a2224ae5e5150c22c41c62f3cd906db74088e3f680dad41e`; 80 | 完了報告禁止 / `SourceDuty`、S11/28 | 候補 |
| `bp-operations.md` O005 | 0–71 / `aab4a2f5b869903738672c691d35732181fa868074482654b5aea28297f8f0ce`; 62 | create/update承認・回答不足でneeds_input/判断材料/停止 / `SourceDuty`、`StopInputDuty`、S05 | 候補。判断材料の実質は残余 |
| `bp-operations.md` O011 | 0–50 / `5b46618d817b1cfebe6aedc1fdb6ed232d8361694e394a5df3907f0025eb8e38`; 45 | 非形式不合格の書直・別context再検証は許容 / `RewriteAndReverify`、`RewriteChoice`、S02 | 候補。Choiceはrewrite fieldだけでOut全体や停止報告を免除しない |
| `bp-operations.md` O011 | 50–129 / `8f2aafcd3623203f8e90ed9a5e6e7c182e48f564ee5456a0dd2da3473686e214`; 122 | 形式不能/不成立の同run書直続行禁止 / `FormalStop`、S03/04/27 | 候補 |
| `bp-operations.md` O022 | 0–81 / `f7ff1479a3dabb43f74421e62dcc41c15f3522ef8289203f54046f300b7457b5`; 74 | old findingのresolved/regressed報告禁止 / `ReportCurrent`、S33 | 候補。status意味品質は残余 |
| `bp-operations.md` O052 | sentence 0–94 / `d7d4675675745e479c788ccdef6390fb212ec7d8c168d0adc98dadb5ef804815`; clauses 0–36, 36–94; 85 | 全機能needs_input前件をO005の承認不足から分離し、論理5欄と`present/known-absent/unknown`を扱う / `SourceDuty`、S05–07。保存状態は別軸 | 候補。実際の文面・判断材料の意味品質は残余 |
| `bp-operations.md` O052 | 94–167 / `bcdee3cde962ca241eb3e5b81d75126f256d5743da4df3bf56d5ca45fab65bd6`; 158 | 目標前の結果/残作業不存在、GoalFixingでは既得結果と残作業の有無を区別 / `SourceDuty`、S06/07 | 候補。GoalFixed=trueは別状態 |
| `bp-designed-skill.md` D007 | sentence 0–88 / `38f5966fec5c06de69c07474bc8d9bff122715c010def4e27214ea6741ae6af8`; clause 42–88; 79 | 人入力境界の停止・判断材料・新run再開への一部観測 / `StopInputDuty`、`ResumeEntry`、S05/19–25 | 候補。主語/設計参照0–42と全停止理由/host実効性は残余group 2/U |
| `bp-designed-skill.md` D012 | sentence 0–94 / `ba6021c1149b23c4403566f04a878c99b9b1d2c7b624b57df8be4236d31ae42a`; clause 53–94; 85 | 再送・競合・中断で意味不変のうち、旧run遅延書込が現runのモデル化状態を変えない有限例 / `CommandDuty`、S23/30 | 一部候補。一般冪等・競合・中断意味全体は残余group 3 |
| `bp-designed-skill.md` D021 | 0–69 / `eae677a86466085a20dcea65fd2e0300313357476c31a74f80760773f22f862b`; 62 | 入力非依存の固定総数上限を置かない有限native 2/3項目例 / `HostCapDuty`、S26 | 有限sampleのみ。無界性は残余group 2 |
| `bp-designed-skill.md` D022 | 0–84 / `a669a37ac47453ea176af710255456d154caa5629d567ee0ed6caf60ae626270`; 77 | nativeに入力capを渡さずCodexでは渡す有限host分岐 / `HostCapDuty`、S26 | 候補。実hostへの授受と強制は残余group 2 |
| `bp-designed-skill.md` D034 | 0–82 / `2ab12e5f51f09ac0a8931af46152063002afdb1c134363443a5effd5fda1d18a`; 73 | 保存済mask/旧history値の有限保持は観測したが、この要求の削除指示までの一般保持を表さない | U。D034全文は残余group 3 |
| `bp-operations.md` O009 | 0–54 / `ae2f0b1911c68ed5189226fca9bcb21cd389c6d191f7ab0a18579b407ca85fb4`; 45 | generator ctxとchecker ctxを区別して完了へ / `VerificationPass`、S01/02 | 候補。実contextの独立性・検証意味は残余group 4 |
| `bp-operations.md` O010 | 0–42 / `5bead754a3c9831468e1781cbb665c4d5da5dcc6907597abacd00fd89c959855`; 35 | 合格前完了禁止 / `CompleteAfterPass`、S01/02 | 候補。全必要検証の網羅は残余group 4 |
| `bp-operations.md` O010 | 42–76 / `04aa9c1270745b2f4eb55771b4bf67376d158a33660052edf77ea8044e1cd65c`; 67 | 検証不合格で止まる時の未達/理由 / `SourceDuty`の`o-unmet`・普通/形式別reason、S02–04/27 | 候補。停止段/途中fileはO013/O040の別句、実reason文面は未検証 |
| `bp-operations.md` O013 | 0–53 / `6083f8386111009b5af181c751339fc001cec7a3ba0b81aa1cd07d7afe25d03b`; 44 | 続行不能時BLOCKED/理由/段 / `Interrupt`、`InterruptReport`、S14 | 候補。全原因種別はU |
| `bp-operations.md` O013 | 53–109 / `eb309b68b521c4695dfb4271d0ddaf3f30778eba2e75d30f5430dd245a042f53`; 100 | review/auditの非失敗中断でも段と理由 / `InterruptReport`、S13 | 候補。全停止前件はU |
| `bp-operations.md` O015 | 0–58 / `38b365fbbe44807e96e5aa24e6a700a239510581aa263070c50ee1da6d7e473e`; 49 | old findingを根拠入力の一例として受ける / `ReceiveGround`、S33 | 候補。任意件数/対象全体受理は残余group 4 |
| `bp-operations.md` O038 | 155–205 / `651042fe7029ac2e6b33c3e61b36efbdc405e3bc4e01c8cb070bb58627d35798`; 196 | 途中機能停止後の後続禁止と連鎖報告 / `InterruptReport`、S31 | 候補。指定順・依存順・入力判定は残余group 4 |
| `bp-operations.md` O040 | 0–76 / `c291b9ca465b6bb74e6519ab84c03726fce0b1ad0c18e7411bd37834418dfd3c`; 67 | 途中fileを戻さず検証済/未検証/段/理由を報告 / `InterruptReport`、S12 | 候補。実file内容・利用者の後判断はU |
| `bp-operations.md` O051 | sentence 0–83 / `bd25c0dd28ba4d1e7a9cdeec054e9e3e7564e133ab12ae681d830819f50d8c5e`; clause 63–83; 74 | BP operationにも保存失敗停止/保持を適用 / `SourceDuty`、S11/28 | 候補。他の記録・証拠・台帳・保持の全適用は残余group 3 |
| `bp-operations.md` O014 | 0–55 / `c9afa7ce52b0ff2408971377238e5a0ba8f010d9f4b304afd8d2df9ef6cb9ebb`; 46 | 完了時の成果物3種は現モデルで出力内容を表していない | U。S01の独立検証だけでO014の句はcoveredにしない。残余group 4 |

この表にない `source_sentences` と `normative_occurrences` は `covered` へ昇格させない。S32は独立した人間の裁定を入力にした関係で、O028のsource句へ混入しない。全132 sentence/103 offsetの一対一分類と独立source reviewは未了。

### 停止・再開cutpointの設計参照

`docs/design/skill-design-patterns.md` SHA-256 `13dcf260e06158fbed3cf89725be6462cc0af5dc88e7aa6c6f073e7622ede023` の下記行は、要求が明示参照する部分だけの観測候補である。表のsource path/lineは、`coverage.json` のD007/D012/D019/O005/O011/O022の句と併せて用い、設計行全体をcoveredへ昇格させない。

| design行・短い句 | contract rule / S | 表現できない残り |
|---|---|---|
| 186「停止した段・未記録項目・順位付き未着手」 | `TargetStage`、`TargetToResume`、`CapStop`、S08/20/21/29 | 任意段・任意項目数、打切結果の全意味 |
| 192「配達後、役の出力をCLIが受け付けた時点で既読」 | `BindResumeDelivery`、`HintDeliver`、`HintOutputReturns`、`HintCliAccept`、`AckBackToResume`、S15–17/19/22/29/30。旧既読集合と配達集合のunion、未読はallからの差分を同run/episodeで保持する2hint有限枝を含む | 実役の読解、実CLIの受理品質、任意hint数と再送仕様 |
| 195「旧run遅延書込で現run状態を変えない」 | `CommandDuty` rejected時の`Record`全等値、S23/30 | モデル化していない実記録内容とhostの競合 |
| 196「BLOCKED原因修復・入力内容変化なら新状態、同一なら再開」 | `RepairMatchesBlocked`、`NewStateAfterInputChange`、`SameStateAfterRepair`、S24/25 | 外部修復の意味品質、後続結果の現在性 |
| 197「未読hintと計画役、未記録項目、次判断段でentryを決める」 | `ResumeEntry`、`TargetStage`、`BindResumeDelivery`、S19–22/29。計画役なし・未記録0では`decide-entry`の段役へ同hintを配達して受付する有限枝を含む。Entry Cではtarget StageRefのplan/execute/check/decide×2順位を局所照合 | 任意の実装段・3項目以上・実際の計画品質。S19のplan後の順位見直し結果は`順位付き残集合の保持`とは別で、未検査の残余 |
| 198「runまたぎに引き継ぐhandoff数は上限変更/打切許可で受付」 | `HandoffResume`、`MaskSubset`、S10 | 任意item数・任意上限値、入力の妥当性 |
