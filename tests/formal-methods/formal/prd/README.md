# formal-methods 要求の形式モデル

`docs/requirements/formal-methods.md`（以下、要求文書）のうち、run の状態を書き換える部分を TLA+ に写したモデルである。要求文書の PR-FORMALMETHODS-182・183 に従い、本文書を自分に当てた重い検査として置く。以下、要求の ID は番号だけで書く（例: 175 は PR-FORMALMETHODS-175）。

モデルは要求文書から自動で生成したものではない。要求の文を手で写した状態機械と判定の表であり、TLC が有限範囲で、到達状態の不変条件と遷移の上の性質を調べる。文書全体を 1 つのモデルにしない（245）。

## 単位

### 切り方と 068 からの逸脱

単位は、呼び出し側が指定した 6 つの状態の持ち主で切った。これは **068 の字面どおりの切り方ではない**（足した制約 A1）。

068 の手順は、組を組の対象ごとに集め、組の対象を変える主体ごとに単位にする。この文書で状態を書き換える主体は、formal-methods・作る機能・audit・CLI に尽きる。そのため字面どおりに切ると、run の状態の全体が 1 つの単位になる（軽い検査の `units.md` の U1）。ここでの 6 単位は、どれも U1 を細かく分けたものである。この切り方で 245 が実質的に働かないことは、要求の欠け F10 として返した。

| 単位（モジュール） | 自分だけが書き換える状態 | 外からの操作 |
|---|---|---|
| `StopTable.tla` 停止の決定 | 選ぶ停止の行と、その列（範囲と限界の記録の扱い・返す保存の失敗・next_args の有無） | 停止の判定に当たる条件の組（下の継ぎ目で他の単位が保証する） |
| `Launch.tla` 起動と続きからの起動 | 起動の同一性ごとの状態の、完了か未完了か・前の結果を返す状態か・121 の印・step と項目・項目の結果を計算した入力・ヒント | 起動（next_args の有無）、入力の変更と戻し、ヒントの追記、host による終わり |
| `Lock.tla` ロック | ロックの持ち主 | 起動、run の終わり、host による終わり |
| `Defects.tla` 欠けと帰属 | 対象の欠けの集合・帰属・判定の回数と 2 回目の結果・帰属の step を終えた印・停止の種類 | step の検査が見つける欠け、154 と 121 による停止 |
| `Convergence.tla` 修正の回と収束 | モデルの欠けが残るか・修正の回の結果の並び・累計・試行の回数の累計・項目の状態 | 続きからの起動、121 による step のやり直し、起動数による停止 |
| `Budget.tla` 起動数の上限 | 残りの起動数・停止の記録を書けたか | 起動数の上限の値 L |

### 単位にしなかったもの

軽い検査の `units.md` が挙げた単位のうち、U1 以外は次の扱いにした。

| 単位 | 扱い | 理由 |
|---|---|---|
| U2 範囲と限界の記録 | 保留 | StopTable の `RangeCol`（書いた・返り値だけ・作らない）に丸めた。記録を書く時点を持たないので、lc J-002・J-003（108・115・125 の書き込みと 150 の両立）が現れない |
| U3 モデル | 保留 | 作る機能が作るモデルの中身と置き場。修正の回は Convergence が持つが、置き場（175 の完了の行のモデルの列）と、121 でやり直すときの作りかけのモデル（lc J-006）は持たない |
| U4 記録台帳 | 保留 | 書く操作が要求の層に無い（lc J-004・M-07）。保存の失敗は StopTable の `ledgerFail` にだけ現れる |
| U5 書いてよい先 | 保留 | 並べる仕組みの無さ（lc M-07）。書けないことは StopTable の `miscFail` に丸めた |
| U6 道具の置き場 | 保留 | 取得と照合の失敗は StopTable の `trialCap` に丸めた |
| U7 自分の文書と写し | 対象外 | 開発時の主体の単位で、run の状態を持たない |

### 継ぎ目（単位の契約）

各行の仮定と保証は、同じ命題である。仮定を置く単位はその命題をガードか制約として使い、保証する単位は同じ命題を性質として確かめる。

| 継ぎ目（共有する状態か事象） | 持ち主（保証） | 仮定を置く単位 | 命題 | 保証の性質 |
|---|---|---|---|---|
| 走っている run | Lock | Launch（一度に 1 つの run だけを持つ） | 同じ起動の同一性で走る run は高々 1 つ | `LockMutex` |
| 停止の記録を書く起動 | Budget | StopTable（`stopRecFail` を CLI の拒否と運搬役の失敗だけとみなす） | 停止の記録を書くときに、それを書く起動が残っている | `StopRecordWritable`（**欠け F8 のため、要求のままでは成り立たない**） |
| 前の結果を返す状態の欠け | Defects | Launch（`Finish(defect)`・`Finish(fail163)` が `pr` を立てる） | 前の結果を返す状態の対象の欠けは、全て帰属を持つ | `NoUnattributedPrevResult`（読み方による F5） |
| 停止で返す欠け | Defects | StopTable（反復の上限と失敗の行も 138 の欠けを返す） | 止まった run が返す欠けは、全て帰属を持つ | `ReturnedDefectsAttributed`（**欠け K2**） |
| 収束しない判定と修正の回の上限 | Convergence | StopTable（Constraint の `fixCap => ~nonConv`） | 同じ停止で、165 の上限と 163 の判定は同時に当たらない | `Round` の順（上限を先に見る）による構成。性質ではなく足した制約 A7 で、外した変形 `st-relax-capFirst`・`cv-relax-judgeFirst` を回す |
| モデルの欠けが残るか | Convergence（`modelOpen`） | Defects（`modelOpen`・`modelFixed` を、修正の回が見つけて直す事象として持つ） | モデルの欠けは、修正の回の結果としてだけ増減する | Convergence の `Round` の `modelOpen'`。Defects は同じ変数を事象として写すだけで、合成の検査はしていない |
| step・項目と 121 の印 | Launch | Convergence（`Input121` と `failure121` からの `Resume`）、Defects（`fail121`） | 121 で止まった状態の続きは、止まった step を項目の結果を使わずにやり直す | `RedoStoppedStep` |
| 起動数の上限に当たる事象 | Budget | Launch の `IterLimit`、Convergence の `Budget154`、Defects の `limit154` | 起動数の上限に当たる停止は、停止の記録を書く起動を残して起きる | `StopRecordWritable`（F8）。Launch・Convergence・Defects の停止は、Budget に結ばずに非決定で起きる事象として写した |
| 入口の停止の行（043・155・192・231） | Launch | StopTable（入口の行を持たない） | 入口で止まる起動には、run の条件が 1 つも立たない | Launch の入口の CASE（177 の順） |

## 実行

必要なものは、TLC `v1.7.4` の `tla2tools.jar`、Java 11 以降、`shasum`、`tests/formal/bp-prd/` の `tlc_cases.sh` と `prd_sections.sh` である。2 つの script は写さずにパスで参照する。jar の SHA-256 は、`tests/formal/bp-prd/check.sh` の `expected_jar` を正とする。

```bash
TLA2TOOLS=/path/to/tla2tools.jar tests/formal-methods/formal/prd/check.sh
```

`check.sh` は次の順に確かめる。どれかで落ちると exit 1 で止まる。

1. jar の SHA-256 の照合。
2. `PRD.sections` の節の固定の照合。
3. 要求の見出しが 255 件で、`coverage.tsv` がその全件をちょうど 1 回ずつ割り当てていること。
4. 175 の表の行名が `rows.tsv` と一致し、`rows.tsv` の指す名前がモデルにあること。
5. 175 の表の「当たるとき」の列の要求の ID が、各モジュールの `RowIds` と一致すること（135）。
6. 043 の表の 18 行が `reject.tsv` と一致し、写した行の名前がモデルにあること（135）。
7. 固定した節を 1 行変えた文書の写しで、節の固定の照合が落ちること（214）。
8. TLC の検査を、各モジュールの baseline・欠けの反例・欠けを直した変形・足した制約を外した変形・変異・witness の順に回す。期待は終了コード（成功 0、不変条件の違反 12、行為の性質の違反 13）と出力のメッセージで判定する。

TLC の検査は 105 件の設計である（`check.sh` のループを手で数えた。今回の改稿の後は、`check.sh` の実行が許可で拒否されたため回していない）。

`make test` と CI には繋いでいない。183 の理由（文書を変えたら落ちる）を満たすには、bp-prd の `formal-bp-prd` ジョブと同じ形で、`.github/workflows/verification.yml` にジョブを足す必要がある（本ディレクトリの外なので、ここでは行っていない）。

### 節の固定

`PRD.sections` は、要求文書の次の 14 節を固定する：用語・前提と依存・位置づけ・2 つの機能・人の入力・best-practices の形・入口・手法と道具・モデルの作成と忠実さ・欠けの帰属と返し方・範囲と限界の記録・失敗・停止・完了・続きからの起動・停止の表と完了。

照合に落ちたら、`prd_sections.sh` の出力の手順に従う。変わった節を `coverage.tsv`・本 README の性質の表・足した制約の表と照らし、モデルを直してから固定し直す。出力の文は bp-prd の `BP.tla` を名指しするが、各モジュールと本 README に読み替える。

## 全行の対応表

`coverage.tsv` は、要求の 255 件の全てを「入れる」（写した先のモジュールと性質）か「入れない」（理由）に割り当てる。「入れる」は 57 件、「入れない」は 198 件である。

「入れる」は、変異か欠けの検査で落ちる性質を持つ行に限った。「入れない」には、遷移の形として写したが落ちる性質を持たない行（理由に「形だけ写した」と書いた 15 件）と、写したことで軽い検査の欠けが隠れる行（理由に lc の欠けの ID を書いた）を含む。

`rows.tsv` は 175 の表の 9 行を、`reject.tsv` は 043 の表の 18 行を、モデルの名前か「対象外（理由）」に対応させる。043 で写したのは 3 行、写していないのは 15 行である。

## 性質と要求

| モジュール | 性質 | 内容 | 要求 |
|---|---|---|---|
| StopTable | `ExactlyOneRow` | 停止が要る条件の組で、選ばれる停止の行がちょうど 1 つ | 175・232・251・252・254・259・260（読み方による F1） |
| StopTable | `StopRecFirst` | 停止の記録を書けないときは、その行だけ | 232 |
| StopTable | `DefectFirst` | 121 と停止の記録を書けない場合を除き、対象の欠けの行に当たればその行 | 251 |
| StopTable | `InputChangeIsFailure` | 121 は失敗の行 | 259・252・260 |
| StopTable | `FailureBeforeSave` | 失敗と記録の保存の失敗が重なれば失敗の行 | 260 |
| StopTable | `LimitWhenBudget` | 起動数の上限は、試行の上限と同時でも欠けがあっても、反復の上限 | 154・156・111・158 |
| StopTable | `CompleteOnlyClean` | BLOCKED の行に当たるときは完了しない | 254 |
| StopTable | `NoUnsavedRecordClaimed` | 範囲と限界の記録を「書いた」とする列は、記録の保存の失敗と停止の記録を書けないときに選ばれない | 253 の理由（無い記録を返さない） |
| StopTable | `EveryUnsavedScopeReturned` | 当たった保存の失敗の範囲を全て返す | 263 の理由 |
| StopTable | `NextArgsOnlyIfContinuable` | next_args を返す行は、前の結果を返す状態を残さない | 175・231・193（**欠け F2**） |
| Launch | `PrevResultClosed` | 前の結果を返す状態は、以後のどの遷移でも変わらない | 用語 82・231・234・177 |
| Launch | `PrevResultReturned` | 拒否されない起動が前の結果を返す状態に当たれば、前の結果を返す | 231・177 |
| Launch | `CompletedReturnsCompleted` | 完了した状態への起動は、状態を変えずに完了を返す | 192 |
| Launch | `ContinueKeepsProgress` | 未完了で前の結果を返す状態でない状態への起動は続きから始め、step と（121 の印が無ければ）項目を保つ | 193・170・168・250 |
| Launch | `RedoStoppedStep` | 121 の印のある状態の続きは、止まった step を項目 0 から結果を使わずに始める | 256・195 |
| Launch | `NewStateIsFresh` | 新しい状態は、別の起動の同一性から何も引き継がない | 229・249 |
| Launch | `InputChangeStopsAtStepEnd` | 入力が変わったまま step を進めない | 121・264 |
| Launch | `ResultsOnIdentity` | 受理した step の結果と続きで使う結果は、起動の同一性の入力だけから計算したもの | 121 の理由（**欠け F3**） |
| Launch | `NextArgsContinue` | 返した next_args（停止の記録を書けない行を除く）は、前の結果を返す状態を指さない | 175・193・231（**欠け F2**） |
| Launch | `NoUnreadHintAtComplete` | 完了した状態に未読のヒントを残さない | 018 の理由（**欠け F11 = lc J-008**） |
| Lock | `LockMutex` | 同じ起動の同一性で走る run は 1 つ | 043 |
| Lock | `StaleLockDoesNotBlock` | ロックでの拒否は、持ち主が走っているときだけ | 043 |
| Defects | `NoUnattributedPrevResult` | 前の結果を返す状態の欠けは全て帰属を持つ | 用語 82・138（読み方による F5） |
| Defects | `ReturnedDefectsAttributed` | 止まった run が返す欠けは全て帰属を持つ | 138（**欠け K2**） |
| Defects | `AttributionStepAttributesAll` | 帰属の step を終えたとき、その時点の欠けは全て帰属を持つ | 144・218・262 |
| Defects | `AmbiguousOnlyAfterTwo` | 「あいまい」は 2 回目の判定の後だけ | 144・218 |
| Defects | `SecondDecidedAdopted` | 2 回目の判定で決まった帰属は採る | 144 の理由（足した制約 A9。外すと落ちる = lc K3） |
| Defects | `NoDownstreamForUpstreamGap` | 上流に定めの無い欠けと 2 つの層にまたがる欠けは上流に帰属する | 143・142・246・006 |
| Defects | `WitnessCompleteAfterFix` | 直したモデルの欠けがあっても完了に届く（到達性） | 157・178（**欠け K1**） |
| Convergence | `WidthReached` | 修正の回の上限で止まる前に、幅を満たす判定が 1 回はある | 162・165・266（**欠け F7**） |
| Convergence | `ConvergenceOnIdentityRounds` | 判定に使う回は、起動の同一性の入力で行った回だけ | 256 の理由・266（**欠け F7**） |
| Convergence | `CountIsCumulative` | 累計と結果の並びの長さが、使う回の数と一致する（F7 の直しではやり直した step の回を数えない） | 166・265・173（**欠け F7**） |
| Convergence | `ExtraRoundAfterCap` | 上限に達した状態の続きは、1 回行ってから止まる | 167・165 |
| Convergence | `RoundBeforeRejudge` | 続きからの起動は、収束しないという判定で止まる前に修正の回を 1 回行う | 163・266（**欠け F9**） |
| Convergence | `TriedAfterReset` | 戻した項目を 1 回試してから試行の上限で止まる | 160・247 |
| Convergence | `NoCappedAfterResume` | 続きからの起動の後に、試行の上限に達した項目を残さない | 160 |
| Convergence | `TrialCapCumulative` | 試行の回数の累計は、上限に起動ごとの 1 回を足した数を超えない | 258 |
| Convergence | `TrialCountCarried` | 試行の回数の累計を、続きからの起動で失わない | 159・173 |
| Budget | `StopRecordWritable` | 停止の記録を書く起動が残っている | 前提と依存の起動数の予約・037・154（**欠け F8**） |
| Budget | `EntryWritesOnlyWithinLimit` | 入口で状態を書くのは、上限が要る起動数以上のとき | 155 |

返り値の列（`RangeCol`・`ReturnedSaveFailures`・`NextArgs`）は、175 の表の行ごとの列（`RangeColOf`・`ScopeOf`・`NextArgsOf`）と、253・263 の組み立て方から作る。性質は列の写しではなく、253・263 の理由と、231・193 との整合として書いた。

## 変異

各変異は要求の 1 文を壊す。欠けを直した変形に当て、対応する性質が落ちることを `check.sh` が確かめる。頭の番号が壊した文の要求の ID である。

| 変異 | 壊した文 | 落ちる性質 |
|---|---|---|
| `m232_drop` | 停止の記録を書けない行を先に当てる | `StopRecFirst` |
| `m251_drop` | 対象の欠けの行を先に当てる | `DefectFirst` |
| `m259_drop` | 入力が変わった run を先に当てる | `InputChangeIsFailure` |
| `m252_drop` | 失敗の行を反復の上限より先に当てる | `ExactlyOneRow` |
| `m260_drop` | 失敗の行を記録の保存の失敗の行より先に当てる | `FailureBeforeSave` |
| `m254_drop` | 完了は BLOCKED の行に当たらないときだけ | `CompleteOnlyClean` |
| `m253_drop` | 保存できなかったものの扱いを保存の失敗の行に従わせる | `NoUnsavedRecordClaimed` |
| `m263_only_selected` | 当たった保存の失敗の全てを返す | `EveryUnsavedScopeReturned` |
| `m156_trial_ignores_budget` | 111・158 の「156 に当たる場合を除き」 | `LimitWhenBudget` |
| `m154_defect_blocks_limit` | 154 の「既に欠けが見つかっていても」 | `LimitWhenBudget`・`ExactlyOneRow` |
| `m175_defect_next_args` | 対象の欠けの行は next_args を返さない | `NextArgsOnlyIfContinuable`（StopTable）・`NextArgsContinue`（Launch） |
| `m177_continue_before_prev` | 231 を 193 より先に当てる | `PrevResultReturned`・`PrevResultClosed` |
| `m177_limit_before_prev` | 231 を 155 より先に当てる | `PrevResultReturned` |
| `m192_skip_complete` | 完了した状態は前の完了を返す | `CompletedReturnsCompleted` |
| `m193_restart` | 未完了の状態の続きから始める | `ContinueKeepsProgress` |
| `m250_rewind_on_hint` | ヒントのために終えた step をやり直さない | `ContinueKeepsProgress` |
| `m256_keep_items` | 止まった step を項目の結果を使わずにやり直す | `RedoStoppedStep` |
| `m249_inherit` | 違う起動の状態から引き継がない | `NewStateIsFresh` |
| `m234_accept_hint` | 前の結果を返す状態へのヒントを拒む | `PrevResultClosed` |
| `m121_ignore` | 入力の指紋が変わったら止まる | `InputChangeStopsAtStepEnd` |
| `m264_skip_item_check` | （F3 の直し）項目ごとに指紋を照らす | `ResultsOnIdentity` |
| `m043_stale_lock_blocks` | 走っていない起動のロックを走っている起動とみなさない | `StaleLockDoesNotBlock` |
| `m043_no_lock` | 別の起動が走っていれば拒否する | `LockMutex` |
| `m246_position_first` | 143・142・140 の順に当てる | `NoDownstreamForUpstreamGap` |
| `m144_no_second` | 決まらなければもう一度判定する | `AmbiguousOnlyAfterTwo` |
| `m262_leave_unattributed` | あいまいな欠けを根拠の文の層に帰属させる | `NoUnattributedPrevResult`（直した変形）・`AttributionStepAttributesAll`（baseline） |
| `m162_width_eq_cap`（W = C の設定） | 幅を上限より小さくする | `WidthReached` |
| `m266_run_local` | 判定を run をまたいだ並びの全体で行う | `WidthReached` |
| `m166_reset_count` | 修正の回数の累計を持ち越す | `CountIsCumulative` |
| `m173_drop_carry` | 保持規則のために持ち越しを止めない | `CountIsCumulative` |
| `m256_keep_rounds` | （F7 の直し）やり直す step の回を使わない | `ConvergenceOnIdentityRounds` |
| `m167_no_extra_round` | 上限に達した状態の続きから 1 回は行う | `ExtraRoundAfterCap` |
| `m160_keep_capped` | 試行の上限の項目を未着手に戻す | `NoCappedAfterResume` |
| `m258_run_local` | 試行の上限を累計に当てる | `TrialCapCumulative` |
| `m159_reset_trials` | 試行の回数を持ち越す | `TrialCountCarried` |
| `m247_no_retry` | 戻した項目を 1 回は試す | `TriedAfterReset` |
| `m138_no_reserve` | 停止の記録を書く起動を残しておく | `StopRecordWritable` |
| `m155_drop` | 上限が足りなければ入口で止まる | `EntryWritesOnlyWithinLimit` |

変異を持たない性質は、次のとおりである。

- `RoundBeforeRejudge`：直し（F9）は、判定を修正の回より前に置く遷移を消すだけである。直した変形を壊す変異は、直しを外すことと同じになる。検出力は、直しを外した要求のままで反例が出ることでだけ示す。
- `ReturnedDefectsAttributed`・`SecondDecidedAdopted`・`NoUnreadHintAtComplete`・`WidthReached` 以外の欠けの性質は、上の表の直した変形への変異（`m175`・`m264`・`m262`・`m256_keep_rounds`）を持つ。`ReturnedDefectsAttributed` は `m262`（直した変形）でも落ちるが、`check.sh` には `NoUnattributedPrevResult` の検査として入れた。`SecondDecidedAdopted` は足した制約 A9 を外した変形で落ちる。`NoUnreadHintAtComplete` は直し（F11）を外すことでだけ落ちる。

## 恒真でないことの確かめ（witness）

性質の前件と各行・各停止が到達できることを確かめる。`check.sh` は witness の不変条件が破れること（到達できること）を期待する。

- StopTable：6 つの行のそれぞれが選ばれる組と、対象の欠けの行と失敗の行が同時に当たる組。
- Launch：前の結果を返す起動、121 の印のある状態の続き、完了、ヒントを読んだ続き、ヒントを読んだ後の完了。
- Lock：走っていない起動のロックがあるまま次の起動が走ること、ロックによる拒否。
- Defects：前の結果を返す状態、「あいまい」の欠け、欠けを持ったままの 154 の停止。
- Convergence：修正の回の上限、収束しないという判定、上限に達した状態からの続き、完了、続きの後の収束しないという判定（`RoundBeforeRejudge` の前件）、続きの後の試行の上限（`TriedAfterReset` の前件）。
- Budget：停止の記録を書けた停止、入口での拒否。

## 欠け（反例）

要求のままでは成り立たない性質は baseline の設定に入れず、違反を期待する検査として `check.sh` に置く。直し方の候補を `Fixes` に入れた変形で、性質が通ることを確かめる。要求が直されたら検査が反転して気づく。軌跡と直し方は scratchpad の `hc-findings.md` にある。

| 欠け | 性質 | 直し方の候補（変形の名） |
|---|---|---|
| F1（読み方による） | `ExactlyOneRow` | 152・153・163 で止まる前に帰属の step を終える（F1） |
| F2 | `NextArgsOnlyIfContinuable`・`NextArgsContinue` | 用語 82 の 163 を規則の散在に限る（F2） |
| F3 | `ResultsOnIdentity` | 項目ごとに指紋を照らす（F3） |
| F5（読み方による） | `NoUnattributedPrevResult` | 止まる前に全ての欠けの帰属の判定を終える（F5） |
| F7 | `WidthReached`・`ConvergenceOnIdentityRounds`・`CountIsCumulative` | 121 でやり直す step の修正の回の結果と回数をともに使わない（F7） |
| F8 | `StopRecordWritable` | 155 の比べる起動数に予約分を含める（F8） |
| F9 | `RoundBeforeRejudge` | 続きからの起動は判定の前に修正の回を 1 回行う（F9） |
| F11（= lc J-008） | `NoUnreadHintAtComplete` | 完了の前に未読のヒントを読ませる（F11） |
| K1 | `WitnessCompleteAfterFix`（到達しない） | 直したモデルの欠けを区別し、残りを数える（K1） |
| K2 | `ReturnedDefectsAttributed` | 154・121 で止まる前に帰属の判定を終える（K2。起動数を残す側の選択肢） |
| K3（足した制約 A9 を外すと出る） | `SecondDecidedAdopted` | 218 を「2 回目でも決まらないならば」に絞る |

## 有限範囲と根拠

- StopTable：16 の条件の全ての組（2^16）から、足した制約に合うものを総当たりする。条件は真偽の 2 値で、範囲の外は無い。
- Launch：起動の同一性 2 つ（入力の中身 A・B）、起動 3 回（直した変形は 4 回でも）、入力の変更 2 回（直した変形は 3 回でも）、step 2 つ、step ごとの項目 2 つ。ABA には変更 2 回、前の結果を返す状態への再起動には 2 回目以降の起動が要るので、これが最小である。
- Lock：起動 3 つ。走っていない起動のロックの後の起動と拒否に 3 つが要る。
- Defects：step 3 つ、欠け 2 件、モデルの欠けを見つけるのは 2 回まで。
- Convergence：幅・上限・試行の上限 W:C:T を 2:3:2、1:2:2、2:3:3 の 3 組。run 3 つまで。
- Budget：上限 L は 1〜4、入口の起動数と予約分 E:R は 1:1、2:2、1:2 の 3 組。
- 209：W・C・T・E・R の値は仕様書が持つ（前提と依存）。要求の層の制約は 162 の W < C だけで、上の組の外の値には届いていない。

## 足した制約

要求の文から逐語で決まらずモデルが置いた制約である。「外した変形」の欄は、その制約を外して回す `check.sh` の検査と、その期待である。

| | 制約 | 置いた場所 | 根拠 | 外した変形 |
|---|---|---|---|---|
| A1 | 単位を、呼び出し側が指定した 6 つの状態の持ち主で切る | 単位の表 | 068 の字面（主体ごと）からの逸脱（F10） | 無し（字面どおりでは単位が 1 つになり、245 と両立しない） |
| A2 | 全ての検査を終えたなら、その step の検査も終えた | StopTable の `Constraint` | 語の包含 | `st-relax-allDoneStep`：`ExactlyOneRow` が落ちる（完了と反復の上限が同時に当たり、順の規則が無い） |
| A3 | 起動数の上限に当たれば、その step を終えていない | StopTable | 154 の「step の検査を終えられない」 | `st-relax-budgetStep`：`ExactlyOneRow` が落ちる（同上） |
| A4 | 規則の散在は、帰属の step を終えた後だけ | StopTable | 164 の「その欠けが帰属する文書」 | `st-relax-scatterAttr`：全て通る（F1 の直しの下では効かない。baseline の F1 の反例から散在由来の偽の欠けを除くための制約） |
| A5 | 記録の保存の失敗と停止の記録を書けないことは、他の停止の条件があるときだけ起きる | StopTable | 147・175。停止の途中でだけ書く | `st-relax-saveNeedsTrigger`：全て通る |
| A6 | 収束・修正の回の上限・モデルの欠けは作る機能だけ。収束しないならモデルの欠けが残る。散在は収束しない判定のときだけ | StopTable | 161・165・164 の主語と条件 | 無し（主語の写し） |
| A7 | 修正の回では、上限の判定を収束の判定より先に行う（StopTable では `fixCap => ~nonConv`） | Convergence の `Round`・StopTable | 162 の理由と 165 の「判定する前に」 | `cv-relax-judgeFirst`・`st-relax-capFirst`：全て通る（予想。今回は回していない） |
| A8 | 一度に 1 つの run | Launch | Lock の保証を仮定に置いた | 無し（Lock で同時の起動を別に確かめる） |
| A9 | 2 回目の判定で決まれば、それを採る（218 の「食い違う」は 2 回目が決まらないときだけ） | Defects の `Judge` | 144 の理由 | `df-relax-conflict218`：`SecondDecidedAdopted` が落ちる（lc K3） |
| A10 | 停止の記録は最新のものだけが効く（新しい停止で 121 の印を消す） | Launch の `ClearMark` | 要求に明記は無い | `ln-relax-keep121mark`：全て通る（予想。今回は回していない） |
| A11 | 停止の記録を書けない 121 の停止は、121 の印を残さない | Launch | 175 の「停止の記録を書けない」行の返り値の欄 | 無し（要求の記述どおり） |
| A12 | 前の結果を返す起動はロックを取らない。ロックの確かめと取得は 1 回の遷移で起きる | Launch・Lock | 要求はロックの取り方を仕様書へ委ねる | 無し（確かめと取得の間の割り込みは見ていない） |
| A13 | `Finish(fail163)` は、帰属の step を終え、対象の欠けがあると仮定して `pr` を立てる | Launch | 用語 82 の条件。Launch は帰属と欠けを持たない | 無し（StopTable の `PrevResultCond` は両方を条件にして同じ F2 を出す） |
| A14 | `blocked163` からの続きは、対象の欠けが無い場合だけを表す | Convergence | 対象の欠けがあれば前の結果を返す状態になる（F2） | 無し |
| A15 | 178・180 の「モデルの欠け」を状態の見つけた欠けと読む | Defects の `ModelDefectsCounted` | 178 は直した欠けを数えないとも読める | `df-K1-fixed`：もう一方の読み方では完了に届く |
| A16 | 121 でやり直す step の修正の回を残す読み方では、その回を全て変わった入力の回とする | Convergence の `tainted` | 256 の理由 | 無し |
| A17 | 修正の回の結果を bad・ok の 2 値に、収束しないを「最後の W 回が全て bad」に丸める | Convergence | 「続いて」の読み | 無し |
| A18 | 帰属の step の位置を、step の間のどこか 1 か所に置く（非決定） | Defects | 要求は位置を決めていない | 無し（非決定にしたこと自体が F5 の読み方） |
| A19 | `prd_sections.sh` と `tlc_cases.sh` をパスで参照する | check.sh | 同じ処理を 2 か所に持たない | — |

## 宣言

### 前提と公平性（117・118）

公平性は置かない。全ての性質は安全性（不変条件か行為の性質）で、進行性は検査しない。起動・入力の変更・ヒントの追記・host による終わり・続きからの起動は、起きても起きなくてもよい非決定の遷移であり、起きると仮定しない。外の主体の前提のうち、「呼び出し側は同じ起動の同一性の起動を同時に 2 つ行わない」は、Lock で同時の起動を許して拒否を確かめる。Java と道具の取得の経路は、`miscFail`・`trialCap` の失敗としてだけ現れる。

### 忠実さの層（122）

| 層 | 宣言 |
|---|---|
| 状態・遷移 | 写した（各モジュールの遷移） |
| 記録と同一性 | 写した（Launch の起動の同一性、状態の鍵、next_args の指す先） |
| データの形 | 写していない：返り値と next_args の形は仕様書へ委ねる（176） |
| 判定の表 | 写した（175 の表の行・列・当てる順、043 の表の 3 行） |
| 用語と範囲 | 写した（用語 82・84。`coverage.tsv` の「入れない」の範囲） |

123（層の間の照合）は、`rows.tsv`・`RowIds`・`reject.tsv` で、判定の表の行名・当たるときの ID・拒否の行を、遷移の行き先とモデルの名前と機械で照らす範囲に限る。

### 列挙の欠落（125）

イベント・遷移の列挙そのものの欠落は、機械では見つからない。モデルに書いていない出来事（例：状態の壊れ、ロックの持ち主の誤認、同じ起動の同一性での並行の書き込み、範囲と限界の記録を書く時点）は、どの性質にも現れない。

### 生成と手で写した部分（113・114）

| 部分 | 生成か手か | 理由 |
|---|---|---|
| 175 の表の行名と「当たるとき」の ID | 文書から抜き出して照合（`rows.tsv`・`RowIds`） | — |
| 175 の「当たるとき」の文の条件と、当てる順 232〜263 | 手で写した | 列の中身が文で、機械で式にできない |
| 175 の列の値（`RangeColOf`・`NextArgsOf`・`ScopeOf`） | 手で写した | 列の中身が要求の ID と文の並び |
| 要求の ID の全体 | 文書から抜き出して照合（`coverage.tsv`） | — |
| 043 の拒否の行 | 文書から抜き出して照合（`reject.tsv`）。条件の式は手で写した（3 行） | 条件が文 |
| 用語 82 の条件 | 手で写した | 文の条件 |

### 丸めたもの（115）

欠けの中身・型・位置は持たず、有無と帰属だけに丸めた。性質の違反（233）は `Found` に入れた。起動数は抽象の整数で、役ごとの起動を区別しない。CLI による書き込みの拒否と Java の不在は `miscFail`、道具の取得の失敗と役の失敗は `trialCap` にまとめた。規則の散在の数えた箇所の数は 2 以上か否かに丸めた（lc J-001 が隠れる）。範囲と限界の記録は、書いた・返り値だけ・作らない、の 3 値に丸めた（lc J-002・J-003 が隠れる）。

### 状態の投影（124・211）

要求文書には状態の図が無いので、211 は対象外とした。124 の投影の導出は行っていない。

### 遷移から転記した条件（190・257）

遷移のガードを写した契約は置いていない。性質は要求の文かその理由から書いた。

## 固定した節の行ごとの対応

要求の見出しを持つ節の各要求は、`coverage.tsv` が ID で割り当てる。043 の表は `reject.tsv`、175 の表は `rows.tsv` が行ごとに割り当てる。用語と前提と依存の節は、次のとおり対応させる。

| 節 | 行 | 対応 |
|---|---|---|
| 用語 | 作る機能・audit | StopTable の `create`、Defects の `fn` |
| 用語 | 起動の同一性・入力の集合・指紋 | Launch の `content`（入力の集合の指紋を 2 値に丸め、起動の同一性はその値と同じとみなす。結果を変える指定と書いてよい先は、起動ごとに変えない） |
| 用語 | 作業場所 | Launch の `ws`（起動の同一性ごとに 1 つ） |
| 用語 | 項目・未着手 | Launch の `item`、Convergence の `item` |
| 用語 | 試行・試行の上限 | Convergence の `tc`・`T` |
| 用語 | 入口の step・入力の拒否 | Launch の `Launch` |
| 用語 | 停止の記録 | StopTable の行、Launch の `ret` |
| 用語 | 欠け・対象の欠け | Defects の `defects`（対象の欠け）と `modelFound`・`modelOpen`（作る機能のモデルの欠け） |
| 用語 | 状態に書いて止まる run・状態に書かずに止まる run | StopTable の `Rows`（`StopRec` が書かずに止まる行）、Launch の `reject`・`reject155` |
| 用語 | step | Launch の `step`、Defects の `step` |
| 用語 | run・状態・CLI・運搬役・作業ファイル・停止の種類・BLOCKED・ヒント・next_args | run と状態は各モジュールの変数、停止の種類は StopTable の `Rows`、ヒントは Launch の `hint`、next_args は Launch の `na`。CLI・運搬役・作業ファイルは対象外（書き手を区別しない） |
| 用語 | 前の結果を返す状態 | Launch の `pr`、Defects の `PrevResult`、StopTable の `PrevResultCond` |
| 用語 | 続きからの起動 | Launch の `continue`、Convergence の `Resume` |
| 用語 | 上記以外の 49 行（スキルの作り手・リポジトリの検証・検査対象・文書の層・規範文・上流・呼び出し側・自分の文書・写し・記録台帳の置き場・書いてよい先・組・組の対象・軽い検査・重い検査・重い検査の候補・要求が安定している・単位を前提にした重い検査・単位を前提にした確かめ・モデル・固定した版・既定値の表・性質の種別・検出力・仕分けの記録・節の固定・判定の表・検査対象の状態・単位・根の単位・単位の契約・継ぎ目・横・縦・使う関係・作る関係・終端条件・忠実さの層・範囲と限界の記録・照らす型・欠けの型・確かめていない範囲・未実施・対象外・見送り・保留・対象なし・AI の判断の印・差し込み口・作業記録・記録台帳・文書の一般規約・着手不能の未確定事項・取り込みの表） | 対象外。検査の中身と開発時の主体の語で、run の状態を書き換えない |
| 前提と依存 | best-practices の形を取り入れる・対象スキルは formal-methods を指す | 対象外（取り込みの表への委譲） |
| 前提と依存 | 試行の上限・修正の回数の上限・幅の値は仕様書 | Convergence の定数 `T`・`C`・`W` |
| 前提と依存 | 停止の記録を書く起動を残す方法は仕様書 | Budget の `R`（欠け F8） |
| 前提と依存 | 264 で照らす時点の細部は仕様書 | Launch の指紋の照合を step の終わりに置く（欠け F3） |
| 前提と依存 | 外の主体について次が成り立つものとする（導入の行） | 対象外（導入の文） |
| 前提と依存 | install 先に docs/ が届かない | 対象外（写しの規則） |
| 前提と依存 | host が Workflow script を実行し役を起動できる | 対象外（役の起動を区別しない） |
| 前提と依存 | Codex runner が maxAgents で制限し run 全体を失敗させる | Budget の `L` |
| 前提と依存 | Java の実行環境が用意されている | StopTable の `miscFail` |
| 前提と依存 | 道具の固定した版を取得する経路がある・許可が付与されている | StopTable の `trialCap` |
| 前提と依存 | .tbd.json とトレーサビリティ表の形式 | 対象外（安定の判定の材料） |
| 前提と依存 | 呼び出し側の next_args の渡し方 | Launch の `Launch(arg, short)` の `arg` |
| 前提と依存 | 呼び出し側は同じ起動の同一性の起動を同時に 2 つ行わない | Lock（行われたときの拒否を確かめる） |

## 対象と限界

### 見ていない範囲

- `coverage.tsv` の「入れない」198 件。そのうち、写したことで軽い検査の欠けが隠れるもの：145・147・150（lc J-002・J-003）、164（lc J-001）、230（lc J-007）。
- 単位にしなかった U2〜U7（上の表）。lc J-004・J-006・M-07 は現れない。
- 043 の表のうち写していない 15 行。175 の表の、状態の列の中身・モデルの列・返り値の中身と、033 の区分の値。
- 進行性。124 の状態の投影。返り値の形（176）。
- 単位の間の継ぎ目は、仮定と保証の命題を結んだだけで、合成したモデルでは検査していない（091 に照らすと、継ぎ目の確かめは表と各単位の性質の対応まで）。Budget と、Launch・Convergence・Defects の起動数による停止は、結ばずに別々に起きる事象として写した。
- ロックの確かめと取得の間の割り込み（A12）。
- W・C・T・E・R の、上の組の外の値。

### 既知の限界として要求が書いているもの

「停止の記録を書けない」行で 121 の印を書けないとき、続きからの起動は変わった入力で計算した結果を使いうる。175 の表の返り値の欄が申告している（L1）。Launch の `Stop121NoRecord` はこの経路で、F3 の直しの下では変わった入力の項目が状態に入らないので `ResultsOnIdentity` を破らない。

### TLC

TLC の到達状態の探索には、ハッシュの衝突のごく小さな可能性がある。
