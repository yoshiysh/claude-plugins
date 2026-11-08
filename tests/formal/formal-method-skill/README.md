# formal-method の内部の設計の形式検証

対象は、formal-method の内部の設計のうち、run の進行と停止、排他、起動、salvage、保存である。正本は次のとおり（いずれも `.agents/skills/formal-method/references/`）。

- `architecture.md` の「段と処理の順序」「司令塔と CLI の分担」「保存と排他」「停止の手順」「時計と資源」
- `cli-contract.md` の「コマンド」「誤りと終了コード」「起動の手順」「受け箱」「生死の判定」「salvage の手順」「結果と台帳の保存の失敗」
- 検証の範囲と性質・変異は `verification-plan.md` の「内部の設計に当てる形式手法」

モデルは設計の抽象で、実装（`scripts/`）との詳細化は証明しない。実装との対応は、検証計画の構造の契約の走査と並行の結合テスト（T が作る）で確かめる。

| ファイル | 内容 |
|---|---|
| `Lock.tla` | 排他と salvage。ファイル操作 1 つ（作成・link・rename・再読込）と、`run-daemon` の「`salvage.mark` を確かめる」「書く」を別の動作にし、どの間にも crash が入る |
| `Run.tla` | run の進行と停止。司令塔・`start`・`run-daemon`・client・担当・道具・時計。salvage の内部は Lock.tla に任せ、規則 1〜4 の判定と勝者の結果の作成に畳む |
| `check.sh` | TLC の入口。基準・到達の証人・変異・発見を回し、結果を JSON で返す |
| `z3_streams.py` | Z3 の出力の流れと終了コードの実測（cli-contract.md の adapter の表との照合） |

## 実行

```bash
TLA2TOOLS=/absolute/path/to/tla2tools.jar sh tests/formal/formal-method-skill/check.sh
Z3=/absolute/path/to/z3 python3 -I tests/formal/formal-method-skill/z3_streams.py
```

- TLC は `tests/formal/bp-prd/check.sh` と同じ v1.7.4 を使い、`check.sh` が jar の SHA-256 を照合する。
- `check.sh` は 1 ケースごとに JSON を 1 行出す。持つ項目は `id`・`module`・`kind`・`properties`・`expect`・`observed`・`violated`・`match`・`exit`・`states_generated`・`distinct_states`・`config`・`trace`。最後に集計の行を出す。
  - `kind` は `baseline`（成り立つ）、`witness`（到達の証人。名指しした不変条件が破れる＝その状態に届く）、`mutation`（変異。名指しした性質の反例が出る）、`finding`・`limit`（下の「発見」。性質が成り立つことを期待して回し、反例が出る）。
  - 期待と違うケースが 1 つでもあれば exit 1。`finding`・`limit` の反例も期待と違うものとして数える。設計か性質のどちらを直すかを依頼者が決めるまで、緑にしない。
  - 反例の trace は `OUT_DIR`（既定は一時の領域。消さない）に残す。
  - `ONLY` に拡張正規表現を渡すと、id が合うケースだけを回す。
- CI では `verification.yml` の `formal-method-skill` job が走らせ、JSON と trace を artifact に残す。`z3_streams.py` は `formal-method-z3` job が Linux の Z3 で走らせる。

## Lock.tla

**範囲**: `run-daemon` 1、`start` 1、client 2、salvage 2、`run-daemon` の crash 1 回と他の process（salvage・client）の crash 1 回、pid の再利用 1 回、ps が使えなくなる出来事 1 回、state.json の確定の範囲 0〜1、LIVENESS_UNKNOWN_MAX を 2 回とした。

**非決定の出来事**: `run-daemon` の起動の失敗と保存先の能力の確認の失敗、rename の前後の crash、遅い `run-daemon` と `start` による停止（確認と停止の間の rename を含む）、`run-daemon` の書込みの途中、結果の公開と status.json の間の crash、勝者の台帳と公開の間の salvage の到着と crash、受け箱の書込みの途中の crash、`salvage.mark` の書込みの途中の crash（変異のとき）、**生死の誤判定**（生きている保持者・勝者を死んだと判定する。基準で常に起こしうる）、台帳・結果・`salvage.mark` の公開の I/O の失敗、結果の公開の負け、status.json の書込みの失敗、生死を判定できない状態の継続、`result.json` が読めないか形に合わなくなる、status.json が読めなくなる（`Corrupt_` で選ぶ）。

**前提**: link・rename・排他作成は不可分。死んだ process は生き返らない。`start` は起動した process の終了を親として正確に観測する。salvage を呼べるのは呼出し元が `run_dir` を受け取った後だけ。結果の内容は <<作った者, 保存済みの範囲, 状態>> とし、状態は `C`（完了）・`S`（停止）・`X`（保存の失敗で作り直した停止 R'）。`records.saved` は内容と別に持つ。「読めない」は一度起きたら続く（以後どの読み手も読めない）とした。

**仮の結果と性質 (4)**（依頼者の決定: 公開された結果を正とする）: 結果の内容に `provisional` の印を持たせ、公開されずに返る R'（run-daemon が status.json で返すもの、salvage が標準出力で返すもの）にだけ付ける。性質 (4b) は「仮の結果でない受け取った結果は、公開された `result.json` と一致する」とし、仮の結果があとの正の結果と食い違うことは許す。前の稿の除外（生死の誤判定と I/O の誤りが重なる run、`Limit`）は要らなくなったので外した。外した形で、誤判定・I/O の失敗・読めない出来事を全て起こしうる基準が成り立つ。前の稿の限界の重なりに届くことは、証人 `NeverMisjudgeAndIO` で確かめる。

**E_RESULT_UNREADABLE の加え方**: `result.json` が公開されているのに読めないか形に合わないとき、salvage の規則 2・結果の公開に負けた salvage・start の 5-1 は、結果を作らずに誤り（`env2.errs`）で終わり、負けた `run-daemon` は status.json を書かずに終わる。性質 (1)（Run.tla）と (7) の「終わった」に、この誤りの終わり方を加えた（`Done`・`Ended`）。この終わり方が結果を 2 つにしないことは、`UnreadableOnlyWithPublished`（Lock）と `UnreadableNoNewResult`（Run）で確かめる。どちらも「公開済みの読めない result.json があるときだけ起こり、新しい結果を作らない」。変異 `unreadable_returns_new`（読めないときに新しい結果を作る。前の稿の「規則 3 に進む」に近い）が反例を出すことも確かめる。

| 性質（計画の番号） | 名前 | 変異 |
|---|---|---|
| (1) state.json・status.json・ledger.json を書くのは lock を持つ `run-daemon` だけ | `WritersOnlyDaemon` | `salvage_writes_state` |
| (2) run の領域は lock を持った状態でだけ現れる | `RunDirAppearsWithLock` | `dir_before_lock` |
| lock を消すのは作った者だけ | `LockRemovedOnlyByOwner` | `foreign_unlock` |
| (3) salvage は state.json・status.json・ledger.json を書かない | `SalvageWritesNoState` | `salvage_writes_state` |
| (4) 公開される `result.json` は 1 つ（誤判定を含めて） | `OneResultPublished` | `two_names`（2 つの名前に公開する。前の稿） |
| (4b) 仮の結果でない受け取った結果は、公開された `result.json` と一致する | `ReceivedNonProvisionalMatches` | `no_provisional`（R' に仮の印を付け忘れる）、`loser_returns_own`、`slow_no_kill`、`unreadable_returns_new` |
| (4c) 仮の結果は `unsaved` に `result` を持ち、状態は停止。公開された結果は仮でない | `ProvisionalShape` | `saved_without_reload` |
| (4) 勝者が生きている間、他の salvage は規則 5 に入らない（誤判定を除く） | `ExclusiveSalvageWork` | `no_winner_check` |
| (4) salvage の結果は保存済みの範囲だけで決まる（誤判定を除く） | `DeterministicSalvageResult` | `creator_in_result`、`no_holder_check`（保持者の生死を見ない。生きている保持者が範囲を進める） |
| (5) 公開された結果は、それを登録した台帳を持つ | `ResultInLedger` | `result_before_ledger`、`result_despite_ledger_fail` |
| (6) `完了` を受け取るのは、`result.json` に公開できた結果だけ | `CompleteOnlyIfPublished` | `complete_before_publish` |
| 印を確かめた時点で印が見えていた書込みが無い | `NoWriteAfterMarkSeen` | `no_mark_check` |
| (7) 生死を判定できる間は、crash の後も結果を返す | `TerminationIfDeterminable` | `pid_only`、`winner_always_busy` |
| (7) 判定できない状態が続けば、司令塔は結果を作らずに終える（限界） | `Termination`（結果・E_RESULT_UNREADABLE・諦めのどれかで終わる） | — |
| (8) 受け箱は書き終えた内容でだけ見え、1 batch に 1 つ | `InboxComplete` | `inbox_create_then_write` |
| (9) 見える `salvage.mark` は識別を持つ | `MarkHasIdentity` | `mark_create_then_write` |
| (10) `records.saved` に保存していない記録が載らない | `SavedOnlyPublished` | `saved_without_reload` |
| (1) E_RESULT_UNREADABLE は結果を 2 つにしない | `UnreadableOnlyWithPublished` | `unreadable_returns_new`（(4b) で検出） |

## Run.tla

**範囲**: 段 7 つ（担当の batch を開く段は 3 モデル化・6 確認の 2 つ。4 つ（2・3・4・6）の場合は環境の出来事を crash・保存の失敗・時間の上限に絞って別に回す）、性質 2（P1・P2）、検査 2（K1・K2。初期状態で独立か K2 が K1 に依存するかを選ぶ）と確認用の実行 1（K2 の変異 M）、担当の返り値（ok・不良・問い・返らない）、司令塔の `start`・`submit`・`wait`・`salvage`、LIVENESS_UNKNOWN_MAX を 2 回とした。

**非決定の出来事**（`Env` で選ぶ。基準は全て）: `run-daemon` の起動の失敗、rename の前の crash、rename の後で最初の status.json の前の crash、START_WAIT_MS までに rename しない遅い `run-daemon`、`run-daemon` の crash、保存の失敗（途中・結果・status.json）、時間の上限、ps が使えなくなる、古い・二重の submit、CLI の出力が JSON でない（salvage の到着）、ホストの時間の上限で返らない salvage の勝者とその crash、`result.json` が読めない（"corrupt"）、status.json が読めない（"statusread"。wait は seq が増えていないものとして扱い、salvage の規則 3 は当たらない）。

**公平性**: `run-daemon`・`start`・司令塔の動作、時間の経過（run の期限・batch の期限）、道具の終わり（検査ごとの時間の上限）、background の salvage の完了。担当には置かない。

**抽象**:

- 結果（台帳 → `result.json`）を公開できなければ、R を捨てて停止の R' を status.json で返す（契約の「状態を決める順序」）。status.json の書込みの失敗は記録の保存の失敗に数えない（契約のとおり）。
- `result.json` は `run-daemon`（`rpub`）と salvage（`sres`）が同じ名前に公開するものとして扱う。読めない status.json の terminal は、wait も salvage も読まないので、結果に数えない。
- E_RESULT_UNREADABLE で終わった司令塔は `unreadable` の状態で止まる。
- `SALVAGE_RETRY_MAX` は数えない。契約の関係 `SALVAGE_RETRY_MAX` × `SALVAGE_RETRY_MS` > `CALL_MAX_MS` から、勝者が 1 回の呼出しで終える間は呼び直しが尽きない、とした。
- 判定（`classifyCheck`・`aggregateProperty`・`decideStatus`）は、完了の条件の連言に畳んだ。判定の規則そのものはオラクル（`tests/formal/formal-method-spec/`）が扱う。

| 性質（計画の番号） | 名前 | 変異 |
|---|---|---|
| (1) 全ての run は、ちょうど 1 つの結果か、結果を 2 つにしない誤り（E_RESULT_UNREADABLE）で終わる | `OneResult`、`UnreadableNoNewResult`、`Termination`（ps が使える間）、`CommanderEnds`（前提なしで司令塔が終わる） | `slow_no_kill`、`no_batch_deadline`、`unreadable_returns_new` |
| (2) 時間の上限の後に、道具の実行（確認用を含む）と担当を始めない | `NothingStartsAfterDeadline` | `check_after_deadline`、`confirm_after_deadline`、`batch_after_deadline` |
| (3) 古い・二重の submit は状態を変えない | `StaleSubmitNoEffect` | `inbox_overwrite`、`read_any_batch` |
| (4) 保存の失敗は status.json か salvage の結果に届く | `SaveFailureReaches`、`SaveFailureStops` | `hang_on_save_failure`、`ignore_save_failure` |
| (5) 完了は、完了の条件が全て成り立つときだけ | `CompleteOnlyIf` | `complete_ignores_confirmation`、`ignore_save_failure`、`complete_before_publish` |
| (6) 反例・問いがあっても、独立な検査は終わるまで動く | `IndependentRunsToEnd` | `stop_on_failure`、`stop_on_question` |
| (7) client は状態を書かず、`wait` は seq の増加か保持者の終了でだけ返る | `ClientWritesNothing`、`WaitReturnsOnlyOnChange` | `client_writes_status`、`wait_ignores_seq`、`stale_on_unknown` |
| (8) E_BUSY の後、役に応じて wait か salvage に戻る | `BusyFollowsRole` | `busy_daemon_to_salvage`、`busy_salvage_to_wait` |
| (9) `start` は status か結果のちょうど 1 つを返す | `StartReturnsOnce`、`StartFailOnlyWithoutDir`、`OneResult` | `slow_no_kill` |

## 結果

macOS arm64、TLC v1.7.4、8 workers での実行。137 ケースが全て期待どおり（exit 0）。

| ケース | 範囲 | 結果 | 異なる状態 |
|---|---|---|---|
| `lock-baseline`（不変条件 16 個） | client 2、誤判定あり、result.json が読めない | 成り立つ | 25,622,130 |
| `lock-baseline-status-unreadable`（同じ 16 個） | client 0、誤判定あり、result.json・status.json が読めない | 成り立つ | 2,695,691 |
| `lock-termination-determinable`・`lock-termination` | client 0、公平性つき | 成り立つ | 1,393,972 |
| `run-baseline`（不変条件 13 個） | batch の段 2、crash・保存の失敗・時間の上限・ps・古い submit・JSON でない出力・勝者の crash | 成り立つ | 17,941,250 |
| `run-baseline-unreadable` | 同上の一部に、result.json・status.json が読めない出来事 | 成り立つ | 1,156,838 |
| `run-baseline-4stages` | batch の段 4、crash・保存の失敗・時間の上限 | 成り立つ | 6,479,584 |
| `run-termination` | batch の段 2、ps 以外の出来事 | 成り立つ | 5,535,854 |
| `run-termination-unreadable` | crash・保存の失敗・読めない出来事 | 成り立つ | 462,246 |
| `run-termination-ps`・`run-commander-ends` | crash・ps・salvage の勝者の crash | 成り立つ | 130,020 |
| `run-save-failure-reaches` | crash・保存の失敗・ps | 成り立つ | 425,188 |

- 到達の証人 82 個（Lock 43、Run 39）は全て届いた。仮の結果があとの正の結果に置き換わる経路（`NeverProvisionalSuperseded`）と、前の稿の限界の重なり（`NeverMisjudgeAndIO`）にも届く。
- 変異 43 個（Lock 22、Run 21）は全て、名指しした性質の反例を出した。
- 変異を置かない性質: `TypeOK`、Run の `StartReturnsOnce`（構造で成り立つ）、`CommanderEnds`（`Termination` の変異 `no_batch_deadline` が同じ経路を壊す）、Lock の `Termination`。
- **検出しない変異（外した）**: `no_saved_check`（salvage の規則 2・3 を飛ばす）。公開された結果を正とする規則の下では、飛ばしても規則 5 で負けて既にある結果を返すか、仮の結果を正の結果で置き換えるだけで、どの性質も壊さない（重なる作業が増えるだけ）。計画の変異の一覧にも無いので外した。
- 前の稿で発見とした 4 ケース（salvage の仮の R' の後に別の salvage が公開する、status.json が読めなくなった後に公開する）は、依頼者の決定で「仮の結果は正の結果に置き換わってよい」となり、(4b) の下では反例でなくなった。どちらの経路も到達の証人で届く。
- `ExclusiveSalvageWork` は、「勝者が生きている間は、勝者でない salvage は規則 5 に居ない」と書き直した（前の稿は「2 体が同時に規則 5 に居ない」で、勝者が死んだ後に何体でも続けてよいという設計より強かった）。

## 未検証の範囲

- モデルと実装の詳細化は証明していない。
- `start` 自身の crash（ホストに殺された `start`）は扱わない。`run_dir` を呼出し元が受け取れないので、以後の salvage は呼ばれない（`architecture.md` の「ホストに殺された start の .tmp-*」の範囲の外）。
- start が terminal の結果を返した後は、呼出し元は `run_dir` を知らないものとし、salvage を呼ばない（E_BUSY・E_RESULT_UNREADABLE・working を返した後だけ呼ぶ）。
- 「読めない」は一度起きたら続くとした。読めたり読めなかったりする場合（一時的な I/O の誤り）は探索していない。
- Run.tla の batch を開く段を 4 つにした場合は、環境の出来事を crash・保存の失敗・時間の上限に絞った。性質・検査・batch・process の数を増やした探索はしていない。
- Run.tla と Lock.tla を合成したモデルは作っていない。Run.tla の salvage の内容の一意は Lock.tla の `OneResult` に依る。
- 秘密値の走査、担当の書込み範囲、子 process の回収、ホストの時間の上限（`CALL_MAX_MS`）の数値の関係はモデルの外である。
