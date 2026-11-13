# 現行BP要求の検証（source/design草稿）

目的は要求2本の56要求（D29/O27）について、満たす主体・前件・義務・禁止・例外と未確認を確定し、特に完了・停止・再開が両立するかを原文から独立に確認することである。現在は初回有限モデル実行と限定3query修復を終えたが、独立レビューでモデルの未達が残り、第一group/56要求全体は未完了である。現在結果は末尾を参照。仕様6本、CLI実装、旧73仕様は要求のoracleとして読んでいない。所有はこのディレクトリのみ。原文は変更せず、本文の版コピーを作らない。

`coverage.json` は56現IDの機械inventory、短い原文anchor・出典行・body hash・主体・前件・規範・例外・方法候補を持つ。`source-table.md` はその人向けの短い表。原文句を意味的に落としていないかは独立レビューが必要であり、ID照合成功を要求合格に数えない。source/mapの独立意味確認と形式検証合格は別で、56要求全体の形式合格は付けていない。修復の共通上限は親作業で3cycle、query 10秒、check 120秒、CPU 2と固定されている。独立source/design承認前にモデル/solver codeを実装しない。

## 満たす対象と参照

Dの全件がBP自身のrunの状態機械を直接定めるわけではない。D001/002/009/010/051は主に対象スキルの設計定義、D006/007/008/011/012/013/016/019/021/022/028/029/032/034/035/036/040は対象スキルの実行能力・run、D014/015/024–027/046はcreate/updateの評価・検証操作である。D051はcreate/update/reviewそれぞれの照合操作と開示も定める。O008はcreate/updateがその性質を持つスキルを提供するbridge、O024はreviewの評価基準bridge、O051はBPの全4機能に記録要求を適用するbridgeであり、BP操作runと対象スキルrunを一つの状態変数へ無条件に畳まない。

読了した正本は AGENTS.md 全文、agent-work.md 全文、documentation.md 全文、repository-operations.mdの検証・監査証拠、formal-method.md 全文、要求2本全文、designの用語/構成要素/配置/形/目標/停止再開/体数/モデルprompt/権限/探索グラフ（計画・実行回収検証・停止を含む）/状態書込/機械検査/資産台帳/証拠保存照会/記録/未決事項である。designの形式手法候補の表、出所URLの外部資料、文脈配達節は未読。外部hostの現実は調査対象にせず、designに課された制約として扱う。

明示参照のうち BP仕様6本と現行prompt-auditの本文は未読。O025の実評価内容とO028の監査観点内容は未確認として残す。designが引用するhost公式頁の現状も未確認。design本文の記述があることと、host上の実効性・自然言語判断の妥当性を分ける。formal-method要求は今回のmanual検証契約として適用し、同skillを実行したとは報告しない。

## 第一groupの独立期待（モデルを書く前のoracle草稿）

D/Oは短縮ID。Sはdesign「停止・再開と人間の入力」（172–203行）、Gはdesign探索グラフ（255–366行）、Wは状態書込（367–385行）。ここでいう禁止は、原文が禁止する結果又は義務に反する結果である。正常とは要求と両立する候補であって、生成者の合格判定ではない。

| ID | 対象・出来事 | 正常/許容結果 | 禁止・境界結果 | 根拠 |
|---|---|---|---|---|
| S01 | BP create/update、必要検証合格・記録保存成功 | 独立検証を経て成果/設計説明/検証結果を返し完了する経路 | 手順終了だけで完了、自己評価だけで完了 | O009/010/014/051 |
| S02 | BP create/update、非形式検証の不合格 | 同runで書直し、別context再検証後に合格する経路を許す | 書直しを必須と断定、再検証せず完了 | O011/O010 |
| S03 | BP create/update、必要形式検証が実行不能 | 当run停止、対象と理由を報告、復旧と再検証は別run | 当runで環境だけ直して検証を再実行し続行 | D027/O011 |
| S04 | BP create/update、形式検証で必要性質不成立 | 当run停止、対象と理由、別runで修正/再検証 | 非形式のuntil-passを流用して当runを書直し続行 | D027/O011 |
| S05 | BP create/update、目標承認/回答不足 | needs_input、判断材料を返し停止、新runで回答を読む | Workflow内で回答待ちを続ける、回答なしで目標確定を推定 | O005/052/O003 |
| S06 | BP、目標前の入力確認でneeds_input | 5材料の欄を保ち検証結果/残作業は無いと示す | 欄省略、存在しない検証結果を埋める | O052 |
| S07 | BP、目標固定時にneeds_input | 5材料、残作業、既得検証結果を示す | 目標前と同じ理由で常に結果/残作業なしとする | O052 |
| S08 | 対象fan-out、上限Nで未処理あり | 結果なし起動も計数し、順位付き残集合を保持して停止 | 返答数だけ計数、残りを確認済/破棄、上限超過 | D016/019 |
| S09 | 上限で止まった対象runの再開 | 新runの起動数は0、前run残集合から続行 | 起動数を引き継ぎすぐ同理由で停止、不要な上限変更入力を必須化 | D019/Sの回数上限区別 |
| S10 | 引継回数上限で止まった対象run | 上限引上げ、又は打切ってよい範囲の入力がある場合だけ再開受付、引継回数と入力上限/打切許可を区別 | 同じ上限のまま無入力再開、回数0化で上限迂回 | Sの再開受付 |
| S11 | 全対象run、保存失敗（一部成功を含む） | 停止、保存済を保持、未保存範囲と理由を返す | 完了、保存済の破棄、報告を対象処理の続行と同一視 | D035/034、BPにはO051 |
| S12 | BP create/update、中断時の途中ファイル | 残して検証済/未検証/段/理由を報告、戻す判断は利用者 | 自動rollback、未検証を検証済として報告 | O040 |
| S13 | BP review/audit、中断（失敗外も） | 段と理由を報告 | 上限や入力停止なら段報告不要とする | O013 |
| S14 | 全4機能、続行不能失敗 | BLOCKED、理由と止まった段 | 成果の完了扱い、後続機能実行 | O013/038 |
| S15 | 対象Workflow、稼働中hint追加 | 現runを止めず、計画役か次段役へ配達 | hintを待たれる承認へ変換、hintだけでneeds_input | D007→S |
| S16 | hint配達後、役が出力を返さず失敗 | 既読にしない | 配達時点で既読、未読hintを失う | D007→S |
| S17 | hint読取役出力がCLIで受付（完了主張却下も含む） | 配達済hintだけを既読化 | 検証役の意味受理まで既読を遅延、未配達も既読化 | D007→S |
| S18 | 完了状態へのhint/再開 | hint追加拒否、完了からの再開なし | 完了後hintを受理して読まれないまま保持、完了を同作業再開 | D007→S |
| S19 | 未読hintあり、計画役あり、残集合あり | 計画役から始めhintを読ませ、残集合を引き継ぎ順位を見直す | D019を理由に最初の実行段へ固定、残集合を捨てる | D019/D007→S/G |
| S20 | S18/S24を先に適用し再開可能、未読hintなし、停止段に結果未記録項目あり | 停止種別によらずその段のその項目から再開 | 常に計画から、既記録項目も再生成 | D007→S |
| S21 | S18/S24を先に適用し再開可能、未読hintなし、停止段の結果未記録項目なし | 次の手を決める段から再開 | 完了済段の同判定ですぐ再停止 | D007→S |
| S22 | S18/S24を先に適用し再開可能、計画役なし、未読hintあり | 記録した位置で開始する段役がhintを読む | 存在しない計画役を強制、hintを捨てる | D007→S |
| S23 | 新run開始後、旧runの遅延書込 | 現runの状態を変更させない | 古い結果で新runの状態/計画を上書き | D007→S/D012→W |
| S24 | BLOCKED原因を外部主体が修正、入力内容が変わる形 | 原因を直し新しい状態から開始 | 旧入力判定結果を残す同状態再開 | D007→Sの但書 |
| S25 | BLOCKED原因修復、入力内容は変わらない | 非完了停止から新runで再開し位置規則を適用 | 停止種別だけでentry段を固定、run relaunch | D007→S |
| S26 | 上限入力なし/native | fan-out項目/総起動数に入力非依存固定上限を設けない | 同時実行上限を総起動上限に流用 | D021/022 |
| S27 | 非形式不合格と形式不合格が同時に既知 | 形式不合格の停止義務を保持、当run書直続行なし | O011の許容でD027を打ち消す | O011/D027 |
| S28 | 形式不合格または入力不足または上限停止と保存失敗 | 対象実処理は停止、完了禁止、保存済保持、各必要理由/未保存範囲を報告 | 単一enum選択で片方理由を消す、停止処理の報告/保存を実処理続行と誤分類 | D027/035/O005/052/040/051 |
| S29 | 上限停止と未読hintと新run | 上限計数リセット、残集合保持、計画役があればhint先行 | hintによって残集合消去、旧run起動数持越し | D016/019/D007→S |
| S30 | 新runと旧run遅延書込とhint受付 | 現runのhint配達/既読は現runの受付で決め、旧書込は状態不変 | 旧runの受付で新hintを既読、停止理由を消去 | D007→S/D012→W |
| S31 | BPの複数機能、途中機能で停止 | 後続を実行せず停止報告を連鎖報告にする | 修正用入力があることだけで後続updateを自動実行 | O038 |
| S32 | 証拠依存版変化が再開と同時発生、S24の形以外 | 依存変化と保存履歴を識別し、再利用優先の未決を明示 | 再利用照合と受理事実そのまま再開の優先を勝手に裁定 | design水準と未決事項(i)、O028 |
| S33 | 新runで前run指摘をupdate根拠として入力 | 修正根拠として全件受取可、旧指摘の状態追跡は継承せず現runで付けた指摘状態だけ報告（根拠履歴は保持） | 旧指摘をresolved/regressedと報告 | O015/022 |

33行は独立した全称命題ではない。S20–S22のentry位置規則は、S18の完了状態から再開しない規則とS24の入力変更時は新状態から始める但書を先に適用し、再開可能な同状態に対して適用する。S33は旧指摘の状態追跡の非継承だけを指し、根拠履歴保持や現runで新しい指摘に状態を付けることを禁止しない。

同時発生を排他的な停止enumに変換しない。普通の不合格・形式失敗・入力不足・起動上限・保存失敗は、別々の前件と義務として交差させる。ただし目標固定前の入力不足と、その後に初めて実行できる形式検証の結果を同一時点の到達可能なイベントだと勝手に仮定しない。原文が両立を禁じていない履歴の組合せと、段の順序によって到達不能な組合せは別に判定する。

第一groupでは「対象実処理の停止」「必要な停止報告・監査記録・保持」「新runでの復旧/再開」を分ける。停止後に理由を返すことや保存済を保持することを、禁止された同run対象処理続行として反例にしない。停止理由を一つに絞る優先順位/単一enumは要求されていない。複数理由の報告内容は要求ごとの義務を満たせばよく、返却serializationを今回新設しない。

## 保証の候補と残余

第一groupで形式化する候補は、前件と義務の充足関係、同run書直可否、新run identity、再開段と残集合の独立性、起動計数と返答計数の区別、hint配達/受付/既読、旧run書込の拒否、保存/未保存/保持/完了の関係である。これは有限対象の条件・順序が両立するかを調べる候補で、任意の自然言語目的が達成されたこと、検証/反証の品質、実hostの書込禁止、実保存、任意件数/任意run数の保証は有限boolモデルで主張しない。

モデルが原文を含意として書き写しただけなら、禁止queryのUNSATはその写しが効くことしか示さない。独立source oracleの正常経路到達、全規範を同時に満たす非空性、前件相互の衝突、停止/再開の位置、単独規則弱化mutantの想定違反検出を分けて確認する必要がある。さらにモデル/原文の意味対応を別contextが確認する。現在はいずれも未実行。

分類基準は次の通り。原文で同じ対象・適用条件の義務が両立不能なら要求矛盾候補、原文に選択を要する空白があって結果が決まらないなら要求不足候補、モデルの層混同/不要な排他enum/過剰guard/順序誤訳ならモデル欠陥、抽出漏れ/ID誤対応なら分類処理欠陥とする。モデルのUNSATだけを要求矛盾へ転記しない。モデル未実装なので現時点でモデル欠陥の確定はしない。

回答待ちは一つの既知未決依存に限る（親が利用者へ質問中）。designが明示未決とする「依存条件が変わった証拠の再利用停止」と「受理事実をそのまま使う再開」の優先（S24の但書の形を除く）を、この検証で決める権限はない。S32の回答依存部分は保留し、他のsource/designを進める。その領域は未確認で分離する。他の同時停止理由やD019/Sのentry段は、直ちに要求不足として質問せず上の合成義務で扱えるか独立レビューする。

## 既存証拠の利用可否

旧 `workflow-runs/bp-contract-scope/formal/report.md` の対象source hashはD `60b6c7d82795be0d7e890121e8cf044ef063086305fe86994699d55b7d0b3275`、O `3b0f28d4c1056e47eb6f47dfbe736b32e80e011f09bacc9f857945ea006261ff`。現在hashはcoverage.jsonの通りD `e7fd43456763d8327ce8a008fd68e0a9511f3149ebfecf987f0e687f72ecbe0c`、O `ce0b67b9c97c839d1eae2f809aaf726e77f8c4303f9353c256c5073fcfecb0c0`。両方が変わっており旧成功を現56要求へ転用できない。同報告は34件の部分形式化・11件意味確認・11件design依存という候補分類と制限を持つが、design未展開であり全要求の意味合格ではない。今回のsource tableは現原文から独立抽出し、旧主分類のまま全件済にしない。

旧 `independent-review-relay.md` は旧仕様への限定承認通知の履歴であり現在版の承認記録ではないと自ら明記する。旧spec-report/73spec/仕様対応表は今回の要求oracleに読まない。旧SMTの実装も未読である。上の旧report本文とinputs.sha256だけを範囲・hashの候補確認に用いた。

既存 `tests/formal/bp-prd/README.md` の冒頭～「性質と要求」を読んだ。対象/記録をrun単位に丸める、BP operation runと対象runを区別しない、再開を計画役開始に抽象化する、O010を形式verificationと混同しないという限界がある。従ってS19–S22の再開位置や全56要求をそのまま保証できない。BP.tla/BP.cfg/スクリプトはまだ未読・未実行。既存モデル利用を後で採用する場合も原文対応/抽象化/有限境界/変異検出を別途再評価する。既存成功は現在結果に加算しない。

## 具体実行計画（実装前freezeの記録）

親からsource修復cycle 1と分解方針の独立承認通知を受けた。共通修復予算は2/3使用済み。具体設計レビューの必須2点（閉集合分類、打切許可入力）だけを修復cycle 2で反映した。以下は独立承認へ渡した実装前の計画記録。現在の実装/実行状態は末尾を正とする。範囲はS01–S31・S33の32例に含まれる有限な制御/記録関係。S32の証拠再利用の優先は回答待ちとして除外し、それを前提にした現在性/証拠再利用の合格を主張しない。56要求全体やBP実装を表すengineは作らない。

### 手法・有限境界

第一候補は既存Z3を使うplain SMT-LIBの有界trace検査。主体別の段、停止前件、停止後の記録、2 run間の順序関係に対して、単時点の含意だけでは不足するため選ぶ。新runner・Rust基盤・TLC実行環境は作らない。旧TLCの「常にplanningから再開」「対象runとBP runを同一視」は採用しない。元要求とoracle表を期待値の正本とし、checker式やsolver出力から期待値を生成しない。

| 有限集合/値 | 今回の範囲 | この有限化で示さないこと |
|---|---|---|
| 主体namespace | `b`=BP操作のrun、`t`=生成/評価対象スキルのWorkflow run。操作はcreate/update/review/auditの4値 | BP自身を無条件に対象スキルと扱わない。bにcap/hintを自動適用しない |
| 役・context | 生成/検証/計画/次段/記録受付の役区別、生成・検証contextは2値 | 実context非継承、prompt理解、検証の質 |
| run/状態世代 | 各namespaceのrunは0/1、対象状態世代も0/1（外部修正で入力内容変化を区別） | 3 run以降、旧証拠の現在性、無界履歴 |
| phase | b: input/goal/write/verify/stopping/stopped/done。t: plan/execute/check/round_end/stopping/stopped/done | 任意スキルの全段。phase順序はこの検査traceの抽象化で、全実装に強制しない |
| 対象項目/指摘 | 項目i0/i1、指摘f0/f1。順位0/1。項目は未起動/起動済・返答なし/返答済・結果未記録/結果記録を区別 | 任意件数、一般の指摘同一性。2件で1件処理/1件残留の境界を見る |
| hint | h0/h1。追加/その役へ配達/出力返却/CLI受付/既読を区別 | 3件以上、任意の外部書込競合 |
| 上限/回数 | host=Codex/native、入力上限なし/1/2、run起動数0–2、引継回数0–2、引継上限1/2、打切許可集合∅/{i0}/{i1}/{i0,i1}、返答数0–2 | D021/O015の任意入力に対する無上限性。上限なしは有限な設定禁止関係だけ |
| 記録/検証 | run別保存済/未保存、過去履歴参照、必要検証のpending/pass/nonformal_fail/formal_unavailable/formal_falseを分離。書直世代0/1 | 実保存、内容妥当性、自然言語目標達成。検証状態は外部観測の抽象入力 |
| 時間 | 初期状態+最大24遷移。各namespaceは1stepに1 action又はstutterを選び、b/tは同stepに動いてよい | 25遷移以降の反例、無界安全性/進行性。到達未確認を不可能と断定しない |

停止理由は一つのenumでなく、namespace/run別に入力不足・形式実行不能・形式不成立・起動上限・引継上限・続行不能失敗・保存失敗の適用済集合を持つ。非形式不合格は修正許容の観測であり、それだけを必須停止理由にしない。保存済/未保存範囲と元停止理由は別に保持する。新runでrun-local起動数を0へ、引継回数/残集合/保存済履歴は保持する。引継上限停止への入力は、数値上限の引上げと、対象項目の打切許可集合（i0/i1の部分集合）を別値にする。数値上限据置でも非空の打切許可範囲の入力があれば受付可能な経路を置く。許可集合外の残項目を捨てず、打切許可の意味や許可範囲が再開後の実処理を十分に進めるかは別の確認とする。新状態開始でも履歴は消さず、現在の項目状態への継承だけを分ける。

### 遷移の閉集合とguardの出所

以下だけを正規actionとし、各actionは自分の変更対象以外を不変にする。表のsource guardを後で式へ写す。正規関係から外れた更新を黙って許さない。late-writeや拒否された再開/hintは「入力は来たが状態不変」を観測する明示actionにする。意味的に未決の再利用更新actionは置かない。

| action群 | namespace・source guard | 許可する更新/次段 |
|---|---|---|
| Receive/SetGoal | b input/goal、O003/005/015。updateは対象と根拠1件以上 | 入力/目標確認へ。目標承認不足は後述StopInput。目標前に書込なし |
| Produce/Rewrite | b write、O009/010/011/018。Rewriteは同run非形式失敗後だけ | 書直世代更新、必要検証をpendingへ戻す。過去passは現成果のpassにしない |
| Verify | b verify、O009/010/011/D027 | contextを分離し非形式pass/fail又は形式pass/不能/不成立を観測。不能/不成立は同stepでStopFormal |
| Plan/Dispatch/Return/RecordResult/Check/EndRound | t該当phase、D007/008/016/019とdesign探索グラフ | 記録位置と項目別結果を保持。起動は上限に収まる場合だけ、返答なしでも起動数を数える。Check成功と記録成功後だけ完了 |
| StopInput/StopFormal/StopFailure/StopCap | b又はtの適用主体・phase、O005/013/D027、D007/016/019→design | b入力不足=needs_input、b形式不能/不成立=実処理停止、b続行不能失敗=BLOCKED。t人入力境界/上限は実処理停止。元段/残集合/理由を保持 |
| Persist/PersistFail | bはO051、tはD029/034/035。稼働中又は停止処理中 | 部分保存を含め保存済を保持。失敗は未保存範囲/理由を足し、stoppingへ。停止後の保存も対象実処理再開とはしない |
| ReportStop/FinalizeStop | 停止の適用義務を持つb/t、O013/040/052/D007/035 | needs_inputの5材料（無い材料含む）、段/元理由/未保存範囲等を報告。stoppedへ。報告を対象file書直しに流用しない |
| Complete | bはO009/010/014/051、tはD007→design完了照合、D035 | bは必要な独立検証・現在成果の必要形式結果・記録、tは対象Workflowの完了照合・記録を満たす場合だけ当namespaceをdoneへ（tにbの形式結果を課さない）。bの保存義務とtの検証義務を相互に代替しない |
| AddHint/DeliverHint/ReturnHintOutput/AcceptHintOutput | t、D007→design。追加はdone以外、配達は次計画役/次段役 | 配達snapshotだけを受付時に既読。返却なしは受付不可。検証の意味受理とは別の受付 |
| Repair/SupplyAnswer/ChangeLimit/PermitCutoff | b/t、O005/D027、D007→design再開条件 | run外の原因復旧/回答/引継上限変更/打切許可集合入力。PermitCutoffは∅以外のi0/i1部分集合を受け、数値上限を変えない。修正で入力内容が変わるかも区別。これだけでは稼働phaseへ戻さない |
| Resume/StartNewState/RejectResume | tはD007/019→design、bはO005/011/D027の別run | done拒否、原因未復旧拒否、引継上限停止は上限引上げ又は打切許可範囲の入力が無ければ拒否。run-local上限停止は無入力でも可。外部修正で入力内容変更の形は新状態。その他同状態のentryはhint/記録位置で決定 |
| RejectLateWrite/RejectCompletedHint | t、D007→design。書込run≠現run又はdoneへのhint | 現runの項目/phase/hint/履歴を変更しない。旧runの要求を新runの受付として扱わない |
| ChainNext/ReturnFinding/KeepHistory | b、O038/022。入力十分/前機能完了、旧指摘を識別 | 途中停止なら後続不実行。旧指摘は修正根拠として保持、旧state追跡非継承、現runで新指摘にstateを付けることは許す |
| Stutter | 両namespace、全phase | 状態不変。回数境界に達しても勝手に完了/停止へ変換しない |

bでD027の形式停止を表し、tの起動上限やhintをbへ自動流入させない。D007の対象Workflowが独自に形式検証を行う振る舞いは、このgroupでは追加しない。bに適用する記録契約のbridgeはO051、tの設計・実行適合を評価する関係はO008/O024の範囲だけ。bのverifyにtのrunが必ず実行されるという実装は仮定しない。

初期状態は両namespaceがrun0、未検証、書込前、起動/返答0、hintなし、理由なし、履歴なし。シナリオごとに操作/host/目標材料/上限/計画役有無の初期条件だけを固定する。通常は入力→対象処理→検証/照合→保存→done、停止は対象実処理停止→必要な保持/保存試行/報告→stoppedを終点とする。停止後に外部入力を与え、条件を満たす新run1への到達を別に検査する。保存失敗の報告も有効な停止終点であり、常にdoneへ達する進行性は要求しない。

### 同時reasonの実到達と不能の扱い

各reasonの前件を強制したqueryを先に置き、SATで実traceがある組合せと、phase/主体のため今回のモデルにtraceがない組合せを分ける。後者は「要求がその組合せを禁止した」の証明ではなく、抽象化/経路設定の限界も独立に見る。停止対象処理と停止後報告は別actionなので、停止後にPersistFailを観測して元理由と保存失敗を両方報告できる。

| 組合せ | source期待 |
|---|---|
| b非形式失敗後に同run形式不成立 | 到達可能な履歴候補。後者で停止し、非形式修正許容で覆さない（S27） |
| b形式停止→保存失敗、b入力不足停止→保存失敗、t上限停止→保存失敗 | 各々到達可能な停止処理履歴候補。元理由と未保存範囲/理由を併存（S28） |
| t上限停止+未読hint→新run、t旧run遅延書込+新runhint受付 | 到達可能候補。残集合保持/entry分離/新run状態保護（S29/30） |
| b目標前承認不足と、目標確定/生成後に初めて得る形式検証失敗を同時刻発火 | 今回のb段順では到達不能。入力不足が後で新たに発生する業務は追加仮定にせず未保証 |
| 同一namespaceのb-only形式結果とt-only起動上限/hint | 主体不一致として未適用。両namespaceに別々に起きる積状態は許すが同runの理由に混ぜない |
| 複数停止前件に保存失敗が重なる | 単一優先enumなし。実際に到達した各前件の義務を累積する。理由のserializationは対象外 |

### 閉集合の分類（PR-FORMALMETHOD-003）

シナリオqueryとは別に、上表のnamespace別phase/action、有限state、候補resultの閉集合を検査する。resultは上表の状態差分に対応する「対象実処理前進・停止処理・停止報告・同状態新run・新状態新run・拒否で不変・完了・項目/hint/記録更新・stutter」の9種と、その種に必要なphase/run/項目/hintの差分とする。state/event/resultに型/値域以外の正規遷移制約を先にassertして、未対応を消してはならない。

source guardに対応する許可集合Aと、原文の義務/禁止に反する結果の集合Fを別々に書き、A/Fの根拠sourceを記録する。各phase/action群ごとに関係する有限guard（主体・完了・未読hint・未記録項目・停止原因・入力変化・上限入力等）の真偽partitionをSMTで全数扱い、候補resultについて `AかつF`（分類重複）と `AでもFでもない`（未対応）の充足可能性を調べる。guard=falseを一律Fにしない。stutterが可能な組合せでも、別のresultがA/Fに入るとはみなさない。明示的な拒否actionの「入力受理を拒否し状態不変」は、その拒否のsourceがある場合だけAに分類する。

C-OVERLAPは型が合うstate/event/resultについてA∩Fを検索しUNSATを期待する。C-UNCLASSIFIEDはA∪Fの補集合を検索し、SATなら分類上未対応として反例を保存し、要求不足か抽象化/分類欠陥かは別に確認する。未対応0を期待値として捏造せず、見つけたpartitionは「未対応・原文の適用未確定」「型は合うが正規traceでは到達未確認」「モデル/分類欠陥疑い」の理由候補とともに報告する。C-REACHは得たpartitionを正規初期状態から24step以内に到達できるか別queryで確認し、不能/未確認をsource禁止へ変換しない。分類結果をC-REACHの結果だけで削除しない。

新engineは作らず、phase/action群のSMT query内でguard signatureを列挙し、SATで得たsignatureだけをblockして次の未対応/重複を探す。全件の直積stateをJSONへ展開せず、出力は `namespace/phase/action/result/guard signature/source refs/A-F-U分類/到達結果/理由` のpartition単位にする。全signatureを調べ終えた群と未処理群を区別する。query/check上限で列挙が止まった場合は残るpartitionを未確認として報告し、閉集合網羅の完了を主張しない。分類用source predicateからguard名を固定し、分類式と無関係な恣意的な圧縮で組合せを併合しない。

### Queryと期待値の固定

後のSMTファイルは1つ、raw logと結果対応JSONを各1つにし、この文書に参照を足す。各queryは`case ID / source scenario / premise / expected / actual / witness又は反例 / limit`を保存する。SMTのechoにcase IDと期待を記し、solverの生出力順を対応させる。正常/禁止の期待は上のS表から手で固定し、その写しを独立reviewで確認してから式を書く。checkerに期待を推定させない。

| query群 | sourceと入力 | 期待/解釈 |
|---|---|---|
| G-ALL | 32例の範囲にあるsource規範を全て同時に有効、b/tの正常完了traceを要求 | SAT。今回抽象化した全規範の両立・正常終点の非空性。56要求全体の無矛盾証明ではない |
| N-S01…N-S31,N-S33 | 各Sの前件と正常/許容到達先を固定、全source規範有効 | 各SAT。前件を満たすtraceがあることを確認。S18の正常結果は拒否actionへの到達であり完了再開ではない |
| P-S01…P-S31,P-S33 | 同じ前件から表の禁止結果が24step以内に一度でも発生するtraceを要求 | 各UNSAT期待。ただし規範をassertしてその否定を尋ねるだけの部分は局所規則検査と表示し、独立要求適合導出と呼ばない |
| X-REWRITE | S02/03/04/27、旧pass→書直し→形式失敗後に旧passだけで完了する履歴 | UNSAT。現成果と検証世代の跨段対応。正常側は非形式失敗→書直→独立pass→保存→完了でSAT |
| X-HINT-RESUME | S08/09/19–23/29/30、未返答起動・残集合・hint配達受付・旧run書込を連続させる | 正常履歴SAT、未起動消失/誤ったentry/旧run更新/未配達hint既読の各違反UNSAT。段のguardが誤って全経路を消していないかN群と合わせる |
| X-SAVE-STOP | S05/11–14/28/31、元理由停止→部分保存/保存失敗→報告→後続抑止 | 正常履歴SAT、元理由消去/保存済破棄/未保存なのに完了/後続実行はUNSAT |
| X-CUTOFF | S10、引継上限停止後の同上限据置で、許可入力なし/非空許可集合入力ありを分ける | 入力なしのResumeは拒否到達SAT、受理UNSAT。{i0}等の許可範囲入力後の受付はSAT、許可外i1の黙った破棄はUNSAT。数値上限引上げの受付SATも別に保持 |
| C-PARTITIONS | 上の閉集合とguard partition | A/F重複UNSAT、未対応はSAT/UNSATを観測して保存。未対応/未処理を通常query成功で埋めない |
| X-FINDING | S33、旧根拠入力→新run新指摘→現runstate報告、履歴保持 | SAT。旧指摘stateをresolved/regressedへ継承する結果はUNSAT |
| M01–M10 | 下表の一つのsource規則だけ弱化、他の規則/初期条件/深さは同一 | 想定禁止traceを得るSAT。そのtraceを未弱化checkerに戻すと対応P/Xが拒否することを確認。複数規則を同時に外して数を合わせない |

| mutant | 単独で弱化する規則 | 想定される違反/対応 |
|---|---|---|
| M01 | 形式失敗後の同run書直し続行禁止 | formal失敗後Rewrite、S03/04/27 |
| M02 | 返答なし呼出を起動数へ算入 | 1上限で未返答起動を数えず2件起動、S08 |
| M03 | 上限停止時の未起動残集合保持 | i1消失、S08/09 |
| M04 | 同状態再開時の未読hint計画役優先 | 残項目実行へ直行、S19/29 |
| M05 | hint既読は出力受付時だけ | 配達のみで既読、S16/17 |
| M06 | 旧run遅延書込が新run状態を変えない | old runが現hint/結果を変更、S23/30 |
| M07 | 保存不能時の完了禁止 | 完了に必要な他条件は全て満たすが未保存のまま完了、S11/28 |
| M08 | 引継回数上限の再開には上限引上げ又は打切許可範囲の入力が必要 | 両入力なしで同上限へ再開、S10 |
| M09 | 停止中機能の後続不実行 | 保存失敗報告後にChainNext、S31 |
| M10 | 旧指摘state追跡を新runへ継承しない | 旧指摘をresolvedへ、S33 |

mutantのSATは当該弱化で到達可能な違反を検査が拾えることだけを示す。別規範が同じ違反を独立に防ぐ場合は、単弱化でもUNSATになり得るので、勝手に他規範を外さず冗長な規則/不適切mutant/モデル欠陥を分けてレビューする。期待と違う結果は失敗又は未確認として返し、検出できたことへ読み替えない。

### 実行条件・結果の限界

使用候補は既存 `/Users/yoshi/.codex/workflow-runs/claude-plugins/formal-method-prd/tools/z3-5.3.3-arm64-osx-13.3/bin/z3` のみ。実行承認後に版/存在/実行条件を記録する。新solverを取得しない。query 10秒、全check 120秒、CPU上限2。plain SMTの一実行で順にpush/popし、独立queryをsolver内で共有する。全体時間内に終わらない場合は未実行/timeoutを残し、深さ/対象/義務を黙って減らさない。性能のための再設計が必要なら残り2cycleの中で独立承認を受ける。同じ検査が成功した後は根拠なしに再実行しない。

この深さの安全性/正常到達だけを扱い、公平性を置いた無界進行性は今回主張しない。人間の回答・原因修復・hint・agent結果は任意の外部actionで、必ず起こるとは仮定しない。正常queryでは必要な外部入力が存在する経路を選ぶだけである。探索できない経路・モデル外の意味・S32・24step超は未検証。source/map/モデル/期待の独立意味確認、正常非空性、禁止結果、変異検出、実装適合を別の証拠欄に保ち、一つのsolver成功へ合算しない。

## S32の利用者裁定（新しい検証入力、モデル未反映）

親から利用者の明示回答「過去の受理履歴は保持し、影響する結果の再利用を止めて再検証する」を受領した。これは今回追加された裁定で、旧designに既に明記されていたとは扱わない。元design/要求は変更していない。S32の正常期待は、受理履歴を保持し、依存変更の影響を受ける結果の現在の根拠/合否への再利用を止め、再検証してから現在の結果へ結び直すこと。影響しない結果は依存条件が一致するなら従来の扱いとする。禁止候補は履歴削除、影響結果を未再検証の現行passへ使用、依存変更と無関係な結果の無差別破棄。これらはsource差分と設計の独立承認待ちで、既実装中の他32例へ勝手に追加しない。

## 実行結果と未達（現在の集計・次の判断の正本）

静的モデル唯一正本はchecks.smt2。不要なPython著作generatorと重複model.smt2は削除した。run_checks.shは既存Z3へSMTを渡すだけで、diagnostic/supplemental/repairはcanonical prefixを含まないquery tail。初回入力hashはinitial-input.sha256、コード/source hash・版・command・case結果・限界はexecution-receipt.jsonに保存した。原文/仕様/CLI/tests不変、commit/外部投稿なし。

| run | 観測 | 意味と保存先 |
|---|---|---|
| 初稿83query | exit0、80期待一致、3期待UNSAT→SAT、unknown/errorなし | raw.log/results.json。3件はP-S08/P-S10/X-CUTOFF-NOINPUT-ACCEPT。S07はN SAT/P UNSAT |
| 利用者が限定承認した3query修復 | 3件とも期待UNSAT/実UNSAT | repair-raw.log/repair-results.json。旧new predicate/premise/prefix不変はquery-repair.json。80成功は再実行なし |
| C/S32初回追加420query | exit0、C-OVERLAP UNSAT、C-U405件=404SAT/1UNSAT | supplemental-raw.log/supplemental-results.json。UのUNSATはidle/stutter。signature全列挙/全到達照合は未完 |
| C-REACH-HINT-REJECT | 期待UNSAT/実SAT | hint_accept後のphase=stoppedをreject結果と誤分類したquery欠陥。source反例ではない。修復なし |
| S32利用者裁定の有限関係10query | 全期待一致（正常/禁止/変異） | 履歴/eligibility/任意useを分離。条件一致の無関係結果を不使用とする経路もSAT。全S32の適合承認とはしない |

source全文の独立意味レビュー（bp_req_source_review、親から通知）は56要求の確認済矛盾/不足0。source/map承認を、第一groupや56要求全体の形式合格へ変換しない。設計レビュー担当bp_req_model_reviewへのfreeze hashはexecution-receipt.jsonのapprovalsに記録した。初稿の3SATは独立レビューで、既記録i1と別pendingi0の停止、及び先の再開と後のcarry停止を誤結合するquery欠陥と確定した。追加修復は同itemのstop_cap直前/直後、Resume直前r_carryと当episodeの入力無しへ束縛した3件だけ。モデルprefixや他queryは変えていない。

独立実装/followupレビューから通知された未達は次の通りで、全て未修正。これらをsource矛盾と扱わない。

| 未達 | 影響と次の最小修復案（未承認） |
|---|---|
| stopping中PersistFailが元stop_phaseをstoppingで上書き | 元実処理の停止位置とcleanup理由追加を分離し、最初の位置を保持する |
| 結果記録済checkからもcheckへ再開 | 項目結果の未記録有無をentry選択へ反映。計画役なしcheck再開のhint配達経路も必要 |
| goal承認不足のresume受付がinput_okだけ | approvedを含む、その停止episodeで不足していた入力条件を受付時に確認する |
| S30の現run/hint配達snapshotの結び付き不足 | 旧runの既読化/理由変更を含む禁止効果を、現runとその配達snapshotへ結ぶ |
| C分類の未対応/到達/結果束縛 | 未対応signatureと未処理を残す。hint_acceptの結果をpost phaseだけでrejectとみなさない |

元P-S08/P-S10がSATだったため旧M03/M08のSATを識別可能な変異検出成功に数えず、修正Pへ成功を転用しない。S32は今回の明示裁定に基づく追加入力で、旧sourceに既記載と偽装しない。eligibilityは使用可能条件であってreuse必須ではない。再検証の取得/判定/時点一致と別contextの実品質はBoolモデル保証外。

caseごとのsource IDはcases.json、部分句と残余は本書のscenario/source-table/coverage.jsonを参照。IDにcaseがあることをID全体の合格としない。正常SAT/禁止UNSATはこの有限関係に対する結果で、原文から独立に導出した適合証明でも、実BP実装/任意host/無界runの保証でもない。

既存Z3 5.3.3を使用し新downloadなし。24遷移/query10秒/process120秒/SMT・SAT threads2。CPU秒/peak memory/費用/OS総CPU上限は未計測。診断3traceを補助診断追加時に重複実行した記録は残し、検証票には加算しない。

現在は **モデル未承認、第一group未完了、56要求全体未完了**。新修復や成功run再実行は行わず、保存済証拠と親が受領した独立followup記録を用いて次の修復範囲を判断する。

## 続行phaseの修復設計（独立承認待ち）

利用者の「続きの実行」を受け、残余5群を一括して直す新phaseを開始する。今回の上限は、実行結果付きfreeze→独立review→必須欠陥をまとめて設計修復する差戻し最大4回（現在0/4）。旧phaseの失敗や限定3query修復は履歴として維持し、旧上限を更新したとは扱わない。source56要求/33SとS32裁定を変更せず、所有は本ディレクトリのみ。今回は設計だけで、以下のcode修正は独立承認後に行う。

共通原因は、出来事の有無をrun/停止episode/段/項目/配達snapshotと切り離していたことである。修復は個別queryの追加guardだけで済ませず、停止snapshotとcommand/resultの同一性を遷移全体で共有する。

| 共通値/所有者 | 最小の表現・不変条件 |
|---|---|
| 実行の同一性 | namespace b/t、state epoch 0/1、run 0/1、停止episode番号0–2。commandは発行時のnamespace/epoch/runを保持し、現実行と異なるcommandは拒否する |
| 最初の停止snapshot | stopが無い→最初の停止だけで作成。run/epoch/episode/実処理phase/その段の未記録item集合/段結果未記録Bool/不足入力maskを保持。保存失敗のcleanup・理由追加・報告でsnapshotを上書きしない |
| 停止理由/cleanup | 元停止理由集合と、保存失敗理由/未保存範囲/cleanup位置を分離。PersistFailは稼働中なら停止snapshotを作り、停止処理中ならそのsnapshotのまま追加理由だけを記録する。報告はsnapshotの段から材料を区分する |
| 段とentry | executeはi0/i1の未記録集合、check/plan等は段結果未記録Boolを持つ。check_passの受付はcheck結果記録済にする。未読hint＋計画役ありなら計画先行、それ以外はsnapshotに未記録があればその段の残り、無ければ次判断段。計画役なしの次判断段はDecideとして役と区別し、存在しない計画役を起動しない |
| episodeの入力不足 | 不足maskはInputとApprovalの2bit。input段不足はInput、goal段不足はApproval。Resumeはsnapshotが求めた各bitの解消を確認し、同じepisodeの上限引上げ/打切許可も確認する。SupplyAnswerは停止中に入力値を満たすだけで、Resumeとは別action |
| hint配達と受付 | h0/h1の追加状態に加え、配達snapshot=(epoch,run,段/周,role,hint集合)と返却/CLI受付を持つ。再開後は開始段の役へ未読hintを配達し、計画役なしのcheck/Decideも対象にする。既読化は現snapshotへの出力が返りCLI受付された場合だけ、その配達集合へ行う |
| transition resultとframe | resultはAccepted/Rejected/Stopped/Reported/Completed等の明示値。post.phaseから推定しない。拒否はsemantic state（phase/item/hint/reason/snapshot/履歴）不変で、拒否receiptの記録だけを許す。停止/報告は対象実処理前進と別result |

同じsourceを満たすための有限表現としてepisodeを追加するが、3回目以降の停止を無理に同じ番号へ丸めない。範囲を超えるtraceは未検証として記録する。run/epoch/episodeの最大値で停止/完了を捏造しない。既存の24遷移、i0/i1、h0/h1、2 run、生成/検証2context、Codex/native、上限/打切許可は維持する。段結果記録BoolとDecideは、既に要求された「その段に未記録があるか」「次の手を決める段」を表すための追加で、対象スキルの新要件ではない。

### C分類を閉じる方法

candidate Kはnamespace別の型付きstate/event/resultの有限直積と明示した値域だけで定める。source guardや正規Nextをcandidateの前提に埋め込まず、誤phaseのcommand等を黙って落とさない。構造上型が違う組合せは別途type-invalidとして列挙し、source禁止には変換しない。sourceにある各許可A/禁止Fはsource ID/句と結び、F=not Aにはしない。sourceがその結果を制約していないと独立確認できた実現選択Choiceと、対応をまだ作れていないU-mapも別にする。Choiceの存在を勝手に推測せず、未確認ならU-mapのままにする。

Rust emitterの一つのtransition定義がactual resultのtagとframeを生成し、source側A/F/Choice predicateは別の手書き対応から生成する。共有するのは型・field名・result観測の意味だけで、Nextから期待分類/expectedを推定しない。hint_acceptが受付更新ならAcceptedであり、stoppedに留まってもRejectedには分類しない。

全signatureの具体値リストを作る代わりに、各event/resultの有限guard partitionをSMTのcharacteristic formulaとして保存する。signatureの構成は、そのsource predicateが参照するstate/command/result fieldの閉集合（自由変数一覧）とし、syntaxで参照漏れを照合する。A∩Fの重複、A/F/Choice/U-mapの未分類重複、同signatureで分類が異なる反例をSMTで検索する。これは分類式の網羅/一貫性検査であって原文の意味証明ではない。

U-mapは条件式とsource未対応理由を保存し、候補領域を消さず、同じevent/result/guard signatureを持つ正規24step prefixと結果への到達を検索する。UNSATならそのU領域の今回有界到達不能、SATならwitness付き未対応、unknown/timeoutなら未確認とする。各queryが領域全体を量化して扱うため、404個の存在witnessを全signatureの列挙と取り違えない。guard partitionごとのquery/status/source refs/到達式/理由を出力し、budgetで止まったpartitionとsource対応未完を可視化する。U=0のためのscope縮小・任意phase前提・source禁止追加はしない。

### 影響範囲と最小regression

| 修復群 | source/S | 必須の正常・禁止・変異比較 |
|---|---|---|
| snapshot/cleanup | D007/035、O052、S05–14/20/24/28 | input/goal/execute/checkで最初の停止→部分保存/保存失敗→報告。元phase/未記録集合/不足maskの保持SAT、上書き禁止UNSAT。元理由と保存失敗併存、未保存で完了不可 |
| stage entry/hint | D007→design再開、S19–22/25/29 | check未記録→check、check記録済→次判断段を分離。計画役なしでcheck/Decideへ再開→その段へhint配達→受付既読。未読hint計画役優先は別軸 |
| 不足episodeの解消 | O005/052、S05–07/10 | input_ok=true/approved=falseでgoal停止→回答なしResume拒否、SupplyAnswer後に新run受付。input不足/上限引上げ/打切許可も同episodeで比較 |
| S30/old command frame | D007/012、S16/17/23/30 | 新runで新hintを配達・出力返却し、旧run受付commandを投入→Rejectedかつ現hint/理由/phase/item/snapshot/history不変。現runの同配達受付→配達集合だけ既読。未配達hint追加との競合も比較 |
| C分類/変異識別 | FM003、S08/10/30 | explicit Accepted/Rejectedとsemantic frameで到達を照合。未対応領域の全guard式と処理状態を保存。M03/M08は修正後P08/P10と完全に同じ禁止predicate・前提を使い、baseline UNSAT/単規則弱化SATを比較 |

snapshot/frameは共有遷移の変更なので、その依存を持つ既存N/P/Xは再実行が必要。単なる型/値域設定だけで影響しないhost固定上限relationと、独立S32有限関係は変更箇所の依存が無ければ旧証拠を保持して再実行しない。再実行対象/保持対象の根拠はfield依存をcaseに結んで保存する。初稿/旧3query修復結果は新結果へ上書きしない。正常witnessが違うepisode/対象で成立した場合は成功にせず、禁止と正常を同じ直前/直後境界で確認する。

### 実装形態と証拠

14k行の展開SMTを手編集するとframe/guardの一部だけがずれるため、この修復では小さいRustの型付きSMT emitter一つを著作正本にする案を採る。namespace/phase/event/result/field/domainをenum/定数で一箇所へ置き、transitionごとの変更field以外は共通frameで不変にする。汎用engine/CLI/外部依存/新solver/Pythonは作らない。手書きsource oracleのcase ID/期待値は別データとして固定し、emitterは期待を導出しない。Rustcは既存toolを使い、生成したSMTをそのrunの再現入力として保存する。

code変更前に旧checks/各query tailと対応metadataを内容hashのpathへ凍結し、manifestに「旧runの再現入力・原文成果物の版コピーではない」責務とraw/reviewへの参照を書く。旧hash/raw/review/3queryrepairは保持する。新runは別証拠directoryへinput/command/solver版/hash/expected/actual/trace/未処理/資源を保存し、現在成果の入口だけを更新する。実行はsolver1 processずつ、query10秒/check120秒/threads最大2。新phaseの差戻し数は親の一箇所で管理し、通常コンパイル整備を独立review cycleとして数えない。生成者は自己合格を出さず、設計承認→実装/実行freeze→fresh reviewの順に進める。

## 続行phase 差戻し1/4の一括修復設計（独立承認待ち）

初回freeze（`runs/continuation-initial/observation.md`）の独立reviewに対する設計。先の5群と33S・S32裁定を変えず、初回83 query中の5 UNSAT、10 unknown、68未完は履歴として保持する。以下は設計であり、承認前にcodeや旧証拠を変更しない。

### 同一対象・順序を持つqueryと実遷移

- S22: 再開時刻 r で未読の同じ hint h を選び、r後に再開先phaseで現run/epochの delivery d を作り、dにhを含み、同じdの返却・受付がこの順で成功して初めてhが既読になる一連の境界をNに置く。Pは同じh/d/phase境界で配達・受付を欠く既読化、または誤った段への配達を検査する。別hintや旧runの受付を正常witnessにしない。
- S30: 新runで配達dとその返却を得た後、同じdに対応する旧run commandを投入してRejectedかつ全semantic frameを確認し、その後、現run commandで同じdを受付する。N/P/M06は同じd、hint、旧・現run、時刻順とframeの観測境界を共有し、Pは旧commandによる受付またはframe変化を検出する。別々の `happens` の存在だけでは成功にしない。
- S33: 有限の指摘IDと根拠IDを同一対象として持ち、旧runで指摘→停止・再開→新runで同じ指摘の根拠を受領→現在の指摘/状態へ反映、の順を明示する。旧受理履歴を保持しつつ、過去状態の自動継承だけを禁止する。N/P/M10は同一ID・run・根拠の直前直後を共有し、正当な新根拠による現run判断を禁止として扱わない。
- 既存の全33Sと対応するN/P、変異、cross/regressionについて、sourceが因果・同一性を要する箇所を一件ずつ点検し、case IDごとに対象ID、順序、run/epoch、前後境界、source句との対応を記録する。単なる `seen(A) ∧ seen(B)` を理由に到達を認めず、無関係な発生で成立するqueryは同じ設計原則でまとめて修復する。source上同一性が必要ない場合はその根拠を記録する。未対応は未確認のまま残す。

DeliveryIdの初回実装は、Deliver時のみ増加し、上限2以内で再利用しない一方、同actionでphase/role/run/epoch/hint集合を一括保存する。次のDeliverまで当該snapshotが不変であること、IDに対応するreturn/acceptの照合、run/epoch間で再利用しないことを遷移全体から検査する。IDが同じでもsnapshotが変わる反例があれば修復する。ID上限を超える3回目以降の配達は未検証とし、phase値だけの比較追加を意味上の代用品にしない。

### 未完部分と性能

Cのcandidate型付き有限直積・独立source A/F/根拠あるChoice/U-map、分類重複/欠落と各U到達、S32の現裁定（受理履歴保持と依存変化後の結果reuse停止・再検証）を承認済み設計に従い実装する。U-mapのsource未対応やunknownは消さずに保存し、S32の過去独立関係を現在遷移に接続してcurrent queryとして検査する。各queryの期待は遷移実装から導出しない。

まず以上の意味修復を施したunspecialized emitterを基点に固定する。性能改善はこのモデル専用で、caseの既固定config/mutant値を式構築時に定数化するだけとし、両namespace、24遷移、全field/action/guard/result/frame/command、型域、初期状態、global前提、case premise/propertyを保持する。初回83件では固定値組は19種で、追加caseを含め再集計する。汎用optimizerは作らない。

各固定値組とnamespaceについて任意の型内pre/post/action/outcome/commandに対するunspecializedと定数化後の1-step relationのXOR、初期条件とglobal前提の差を検索し、同一queryの保持と合わせて24段合成の同値根拠を残す。固定値下の非空性も確認する。invalid値/commandの拒否領域を同値検査から除外しない。UNSATの組のみ同値確認済み、SATは反例、unknown/未実行は未確認とする。意味修復前の初回modelとの同値を要求・主張しない。性能は実測まで未確認。

次runは入力hash、実際のcommand、実行solver/compilerの絶対path・版、exit/status、制限、個々の期待/結果/未処理と時間を保存する。unknownに続くget-value失敗は主結果をunknownとし、別の従属診断として記録する。query10秒、check120秒、CPU2、全体1200秒を維持し、上限到達時は残件を未処理とする。成功済みの証拠を理由なく再実行せず、変更依存のあるqueryのみ再検証する。設計独立承認→実装と実行のfreeze→fresh-context独立reviewを経る。
