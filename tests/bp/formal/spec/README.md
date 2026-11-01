# best-practices の仕様書の形式検査

`docs/specifications/bp-*.md` を、実装に入る前に機械で検査する。見るのは次の 3 つ。

| 範囲 | 道具 | 置き場 |
|---|---|---|
| 段の遷移（開始の操作の確かめの順、run の状態とイベント、create・update の段と再開、review・audit の段と再開） | TLA+（TLC） | `StartChecks.tla`・`RunLifecycle.tla`・`Authoring.tla`・`Inspection.tla`、`check.sh` |
| 判定の表（網羅と排他、表どうしの食い違い） | Node のテスト（`make test` に入る） | `tables.test.mjs` |
| 情報の流れ（操作が読む欄の作り手） | Node のテスト | `flow.test.mjs`・`flow.mjs`・`flow-limits.json` |

判定の表は手で写さない。`extract.mjs` が markdown から毎回抜き出し、`gen_tables.mjs` が TLC に渡す `SpecTables.tla` をその場で作る（`check.sh` の一時ディレクトリにだけ置き、リポジトリには置かない）。手で書いたのは、段・状態の名前を ASCII に写す対応（`extract.mjs` の `*_IDS`）と、表の文の読み方（始め方の列の語の分類など）だけで、対応に無い名前・文は投げる（仕様が変わったら黙って古くならない）。

## 実行

```bash
TLA2TOOLS=/path/to/tla2tools.jar tests/bp/formal/spec/check.sh   # TLC（jar は prd と同じ版を SHA-256 で固定）
node --test tests/bp/formal/spec/                                  # 判定の表と情報の流れ（make test でも走る）
node tests/bp/formal/spec/flow.mjs --print > tests/bp/formal/spec/flow-limits.json   # 情報の流れの検査の限界の一覧を作り直す
```

`check.sh` は、PRD のモデル（`../prd/`）の `tlc_cases.sh`（並列実行と照合）と `prd_sections.sh`（節の切り出し）を、そのまま呼んで使う（prd 側は変えていない）。CI は `.github/workflows/verification.yml` の `formal-bp-spec-scope`・`formal-bp-spec`。

### 固定（`SPEC.sections`）

モデルは表を生成で受け取るが、遷移の動き（再開の手順、CLI の拒否、記録の鍵など）は散文から手で写している。写した節の sha256 を `SPEC.sections` に固定し、`check.sh` の最初に照らす。節が変わると、変わった節を挙げて止まる。モデルと本書を直してから、`check.sh` が出す手順で固定を作り直す。CI の `formal-bp-spec-scope` は、固定した仕様書か、この置き場・共有の道具・`docs/specifications/` が変わった PR で走る（表は生成なので、表しか変わらない場合も走らせる）。

## TLC の定数

| モデル | 定数 | 値 | 理由 |
|---|---|---|---|
| StartChecks | — | — | 確かめの数は生成した `StartChecks`（SP-BPRUN-003 の番号つきの箇条）の長さ。落ちる確かめの集合を初期状態で全て選ぶ |
| RunLifecycle | `MaxRuns` | 2 | 古い run と現在の run が並ぶ最小の数。3 でも 1 回確かめた（最初の版で 4,237,845 状態、違反なし、約 9 分）が、CI には重いので 2 にした |
| RunLifecycle | `Vals` | `{"a","b"}` | 同じ鍵に同じ内容と違う内容を送る 2 通り |
| Authoring | `Fn` | `"update"`（`"create"` の case も走る） | 作り直す前の写しの段の有無 |
| Authoring | `MaxRuns` | 3 | 停止 → 再開 → 停止 → 再開 |
| Authoring | `Limit` | 2 | run ごとの反復の上限（SP-BPCONFORMANCE-029 の値でなく、上限に達する経路と達しない経路の両方を作る最小の値） |
| Authoring | `MaxIter` | 3 | 反復の番号の上限（状態の有限化。`CONSTRAINT BoundOK`） |
| Authoring | `MaxRound` | 3 | 形式検証の段の回の上限（同上） |
| Inspection | `Fn` | `"review"`（`"audit"` の case も走る） | 適用の判定の段の有無 |
| Inspection | `MaxRuns` | 3 | 同上 |

読みの違いを選ぶ定数は無い（4 回目の改稿で、前の版の読みの違いと既知の反例 N3〜N5 は全て仕様が決めた）。

`check.sh` は、基準の構成 6 個のほかに、`Mutation` で 1 箇所を壊した構成 29 個（性質が効いていることの確認）、今の仕様に対する既知の反例 2 個（N6）、到達すべき状態の witness 16 個を走らせる。基準以外は全て違反が出ることを期待する。

## 仕様の行とモデルの対応表

### 段の遷移（TLC）

case の列は `check.sh` の case ID。`mut` は `Mutation` で 1 箇所を壊して性質が破れることを確かめる case、`gap` は今の仕様に対する既知の反例、`wit` は到達すべき状態の witness。基準の構成（`start`・`run`・`auth-update`・`auth-create`・`insp-review`・`insp-audit`）は全ての性質が成り立つことを期待する。行番号は 4 回目の改稿の後の版。

| 仕様項目 ID・file:line | action | 性質 | case |
|---|---|---|---|
| SP-BPRUN-003 `docs/specifications/bp-run.md:75-85`（確かめの順。生成：`StartChecks`） | `Check`（番号の順に確かめ、最初に当たったもので答える）・`Begin`（全て通ってから状態か run を書く） | `RefusalWritesNothing`（拒否は状態を書かない）、`FirstApplicable`（答えは当たる最初の確かめ。新規だけ・再開だけの確かめは当てない）、`StartOnlyWhenClean` | mut `start-write-early`（確かめ 6 の前に run を書く）、mut `start-reverse-order`、wit `start-WitnessRefusedAtLast` |
| bp-run 状態とイベント `docs/specifications/bp-run.md:545-613`（図と表の全行。生成：`RunAllowed`・`RunNever`） | `E1`・`StopDeliver`（E2〜E6）・`E7`（現在の run だけ）・`E8`・`Deliver`（E9）・`E10`。再開の拒否 `Refuse` は E8 でなく状態を変えない（`bp-run.md:550`） | `TableConformance`、`NeverOccurs`、`RefusalChangesNothing` | mut `run-resume-done`（TableConformance）、mut `run-e7-any-run`（NeverOccurs）、mut `run-refusal-registers`（拒否で run と停止を書く前の版の振る舞い。RefusalChangesNothing） |
| SP-BPRUN-005（状態は log から導き、別の写しを持たない） | `Status(log)` | 全ての性質が `Status(log)` で状態を見る | — |
| SP-BPRUN-006、SP-BPRUN-005 の同一性の鍵 | `Deliver`（同じ鍵の同じ内容は `same`、違う内容は `conflict`） | `OneRecordPerKey`（送り直しで記録が増えない） | mut `run-resend-appends` |
| SP-BPRUN-017（E9） | `Deliver`・`StopDeliver` の拒否 | `NoWriteOutsideCurrent`、`StaleNotStopReason`（古い run の拒否を現在の run の停止の理由にしない） | mut `run-accept-stale`、mut `run-stale-blocks`、wit `run-WitnessStaleRejected` |
| SP-BPRUN-018（実行中からの再開） | `E8` | `TableConformance` の E8 の行 | wit `run-WitnessResumeFromRunning` |
| SP-BPRUN-014（完了した状態の再開を拒否） | `E8` | `CompletedStaysCompleted` | mut `run-resume-done-stays` |
| SP-BPRUN-029 | `StopSend` の前提（`E_CONFLICT` を受けた run は E6） | `StaleNotStopReason` | mut `run-stale-blocks` |
| SP-BPAUTHORING-005（生成：`AuthStageSeq`） | `StepStart`〜`StepFormal` | `NoSkippedStage`（合否の前に検証、検証の前に書く、書く前に目標、形式検証の結果の前に合格） | mut `auth-resume-skips-check` |
| SP-BPAUTHORING-004 `bp-authoring.md:75`、SP-BPAUTHORING-035 の起動数の上限の行 | `StepSnapshot`・`ResumeEnter`（update で写しの記録が無ければ写しの段から） | `SnapshotBeforeGoal` | mut `auth-skip-snapshot-on-resume` |
| SP-BPAUTHORING-021、SP-BPRUN-031 `gate`・`placement` | `StepGate`（`placement` を先に積む。書く段の結果を持つ反復が無ければ BLOCKED） | `PlacementBeforeGate` | mut `auth-skip-placement` |
| SP-BPAUTHORING-024・SP-BPRUN-013 | `FollowGate`・`ContinueGate`（run の中の増分を上限に当てる） | `IterationLimitPerRun` | mut `auth-limit-unchecked`、wit `auth-WitnessIterationLimit` |
| SP-BPAUTHORING-025（生成：`GateNext`） | `FollowGate` | 進み方は表の行だけから決まる | — |
| SP-BPAUTHORING-026、SP-BPRUN-031 `stop`、SP-BPAUTHORING-032 `formalVerification` | `Complete`（`FreshPass`：最後の合否が合格で、その後に始めた最後の回の結果が通る。違えば CLI が拒否して BLOCKED） | `CompleteAfterGateAndFormal`、`NoRefusedCompletion` | mut `auth-skip-formal`（CompleteAfterGateAndFormal）。`NoRefusedCompletion` は CLI の拒否を script が引き起こさないことの性質で、基準の構成で成り立つことだけを見る |
| SP-BPAUTHORING-042・044・045（生成：`FormalRows`）、SP-BPAUTHORING-036 `bp-authoring.md:102` | `StepFormal`・`ContinueGate`（合否の段から進むときは新しい回。同じ回は止まった段が形式検証の段のときだけ） | `NoStaleFormalResult`（合否より前に始めた回の結果で停止を決めない） | mut `auth-same-round-after-gate` |
| SP-BPAUTHORING-027 | `Fail("needs_input")` は目標の固定の段だけ | `NeedsInputOnlyAtGoal` | mut `auth-needs-input-anywhere` |
| SP-BPAUTHORING-035 `bp-authoring.md:472-497`（生成：`AuthResume`。段の名前の「（create）」「（update）」は機能ごとの段として読む）、SP-BPRUN-015、SP-BPRUN-018 `bp-run.md:404-422`、SP-BPRUN-003 | `ResumeStart`（再開の `start`。頭の段 1 で、台帳の取り直しを含む）→ 取り直しで消えた資産が見つかれば `ResumeVanish`・`ResumeVanishFin`（頭の段の消えた資産の照合。`head: true` の開始と終わり）→ `ResumeEnter`（始め方の段の開始）。どの間でも止まれる。止まった段は SP-BPRUN-018 の 1〜3（頭の段を除く。出所の停止は前の run の最後の停止）、`lastStop` は 1 に当たるときだけ出所の停止で、当たらなければ「停止の記録が無い」 | `ResumeRowUnique`、`NoLostRestart`（空の run（頭の段だけの run）を除いた log と同じ始め方になる）、`HeadStagesFinished`（始めた頭の段の消えた資産の照合が完了の前に終わる。N6 のため基準には入れない） | mut `auth-laststop-always`（1 に当たらないときも出所の停止を返す。ResumeRowUnique）、mut `auth-head-counts`（NoLostRestart）、mut `auth-needs-input-no-row`、gap `auth-n6-head-vanish-open`（N6）、wit `auth-WitnessBlockedAtStart`・`auth-WitnessHeadVanishDone`・`auth-WitnessDoneAfterFormalFailed`・`auth-WitnessDoneAfterVerifiers`・`auth-WitnessDoneAfterLaunchAtGate`・`auth-WitnessDoneAfterResume`・`auth-WitnessDone` |
| SP-BPRUN-010（生成：`StopUse`） | 停止の記録 | `StopKindsUsed` | mut `auth-stop-dry`、mut `insp-stop-needs-input` |
| SP-BPRUN-014（Authoring・Inspection 側） | `ResumeStart`・`Resume` は完了の後に起きない | `NoRunAfterDone` | mut `auth-resume-done`、mut `insp-resume-done` |
| SP-BPINSPECTION-001（生成：`InspStageSeqReview`・`InspStageSeqAudit`） | `Step`・`Targets`・`Close` | `NoSkippedStage`（完了の前に全ての段を終える） | mut `insp-skip-stage` |
| SP-BPINSPECTION-002 | `Step` | `NoBackEdge`（run の中で頭の段でない段が前へ戻らない） | mut `insp-back-edge` |
| SP-BPINSPECTION-019 `bp-inspection.md:270`、SP-BPRUN-031 `stop` `bp-run.md:683`（review の完了は現在の run の `placement` の記録を求める）、SP-BPINSPECTION-030 の照合と停止の行 `bp-inspection.md:364`（生成：`InspClosePlacement`） | `Close`（review は `placement` を `stop` より先に積む。記録が無ければ CLI が `E_INPUT` で拒否して BLOCKED） | `PlacementBeforeStop` | mut `insp-omit-placement`（再開で `placement` を送らず、CLI も照らさない） |
| SP-BPINSPECTION-004・029 | `Targets`（前の run が段を終えていて照らす先が変わっていれば BLOCKED） | `NoVerifyAfterMismatch`（その run は検証・追加の起動・反証の段を始めない） | mut `insp-mismatch-continues`、wit `insp-WitnessMismatch` |
| SP-BPINSPECTION-030 `bp-inspection.md:344-367`（生成：`InspResume`・`InspResumeSeq`。最初の流れの消えた資産の照合の行 `:364` は「照合と停止から」）、SP-BPRUN-018、SP-BPRUN-031 `stage-finish` `bp-run.md:680`（同じ段・回・`head` の終わりの無い最後の開始を閉じる） | `Resume`、頭の段（照らす先の決定・台帳・消えた資産の照合。`head: true`。消えた資産の照合は、止まった段が最初の流れの消えた資産の照合か、取り直しで消えた資産が見つかったとき）、`Resolve` | `ResumeRowUnique`、`NoLostRestart`（空の run を除き、頭の段の終わりが頭の段の開始だけを閉じる log と同じ止まった段になる）、`HeadStagesFinished`（N6 のため基準には入れない） | mut `insp-head-counts`、mut `insp-fin-ignores-head`（頭の段の終わりが最初の流れの段の開始を閉じる。NoLostRestart）、gap `insp-n6-head-vanish-open`（N6）、wit `insp-WitnessDoneAfterResume`・`insp-WitnessDoneAfterCloseStop`・`insp-WitnessHeadVanishDone`・`insp-WitnessDoneAfterVanishStop` |

### 判定の表（`tables.test.mjs`）

| 対象 | 検査 |
|---|---|
| 「条件:」の列を持つ全ての判定表（6 文書の 23 表。`bp-entry.md:104,141,184`、`bp-run.md:195,289,322`、`bp-authoring.md:214,262,336,357,403,443,505,550,583`、`bp-inspection.md:117,138`、`bp-conformance.md:48,91,124,144,226,267`） | 「> 条件の値」の積の全ての組で当たる行がちょうど 1 つ。宣言に無い値のセルが無い。宣言に無い「上記以外」（`bp-conformance.md:236`）は、上の行のどれにも当たらない組に当たる行と読む |
| 状態 × イベント（`bp-run.md:537-600`、`bp-findings.md:381-432`） | 図と表を合わせて全ての組をちょうど 1 回定める |
| SP-BPFINDINGS-019 `bp-findings.md:255-260` | 4 状態 × 3 判定が揃い、状態とイベントの E3〜E5・E6 の行き先と一致する（E6 は SP-BPFINDINGS-018 の 5 行目の「最後の判定と同じ値」で導く） |
| SP-BPFINDINGS-018 `bp-findings.md:229-246` | 4 つの条件の値の全ての組から起こりえない組（5 つの箇条）を除くと、上から順に当てて当たらない組が無い |
| SP-BPINSPECTION-006 `bp-inspection.md:127-133` | 受ける答えの並びが、図の道（最初の「はい」で止まる並び）とちょうど同じ。到達する形の集合が SP-BPCONFORMANCE-003 の「形」の値と同じ |
| SP-BPCONFORMANCE-004 `bp-conformance.md:124-131` と SP-BPINSPECTION-006 `bp-inspection.md:138-145` | 「答えてはならない」並びと「受理しない」並びが一致する |
| SP-BPAUTHORING-044・045 と SP-BPRUN-031 `stop` | 通らない行の `cause` と 045 の値が `stop` の受ける 3 値の中 |
| SP-BPAUTHORING-025 と SP-BPRUN-031 `gate` | 進み方の行き先と `next` の値が同じ集合 |
| SP-BPAUTHORING-035 `bp-authoring.md:474-489` | SP-BPRUN-010 が create・update に使う停止と、SP-BPAUTHORING-005 の段と、停止の原因の区分の、止まりうる全ての組（needs_input は SP-BPAUTHORING-027 の段、反復の回数の上限は合否、`formal*` は形式検証、`verifiers` は検証役・反証役を起動する段と合否）に当たる行がちょうど 1 つ |
| SP-BPINSPECTION-030 `bp-inspection.md:354-364` | 表の段が、文の段の並びをちょうど 1 回ずつ覆う。並びは SP-BPINSPECTION-001 の段から開始と消えた資産の照合を除き、追加の起動の部品を検証の後に足したもの |
| SP-BPRUN-010 `bp-run.md:322-334` | review・audit は needs_input を使わず、反復の上限は起動数の上限のときだけ。create・update は 4 つを使う |

### 情報の流れ（`flow.test.mjs`）

`bp-run.md` の SP-BPRUN-031 の操作の表から、操作ごとに受け取るもの（括弧の外の欄の名前）と返すもの（同）を抜き出し、`bp-entry.md` の SP-BPENTRY-013 の綴りの表を Workflow の入力とする。操作は、段の表（`bp-authoring.md` の SP-BPAUTHORING-005 の「定める仕様項目」、`bp-inspection.md` の SP-BPINSPECTION-001 の「定める項目」）と操作の表の「実現する項目」が共有する仕様項目 ID で段に結び付ける。「`<操作>` の記録が無ければ」で名指す前提（`gate` ← `placement`）は、両方が段に結び付くとき同じか前の段にあることを確かめ、結び付かない組は「見ていない」と出力に宣言する。

**検査の限界**：操作の表にも段の表にも、操作と段の対応・欄の出所の列が無いので、列だけからは多くの操作の段と欄の作り手が決まらない。これは仕様の欠けではない（例：review の `placement` は `bp-inspection.md` の SP-BPINSPECTION-019 が照合と停止の段で送ると散文で定めている）。共有する仕様項目 ID で段に結べた操作は 41 個のうち create・update で 16 個、review で 10 個、audit で 9 個で、受け取る欄 49 個は名前の同じ返すものも Workflow の入力も無い（`item` は `stage-start` の `items` の要素、`verdict` は反証役の結果、`attempt`・`number` は script の数えのように、散文が出所を定める）。名前だけが同じで別の値の欄（`paths-retake.iteration` と `placement` の出力など 3 件）は見分けられない。見ていないこの範囲は `flow-limits.json` に一覧で置き、テストは毎回その一覧を出力に宣言し、今の仕様から作った一覧と違えば落ちる（見ていない範囲が黙って増減しない）。散文から操作の段を写すのは手で写すことになるので、行わない。

## 見つけた仕様の違反・あいまいさ・欠け

検査を緩めて通したものは無い。今の仕様に対する既知の反例は、違反の出る構成を期待する case（`check.sh` の出力で `[known spec ambiguity or gap: see README]`）として残した。仕様が直って違反が消えると、その case が落ちるので、本節から外す合図になる。

### 残っているもの（4 回目の改稿の後の仕様に対して）

- **N6（major）頭の段の消えた資産の照合が途中で止まると、その回の未着手の項目が拾われない**：SP-BPAUTHORING-035 の 3（`bp-authoring.md:478`）と SP-BPINSPECTION-030 の 4（`bp-inspection.md:352`）は、再開の頭で消えた資産の照合を「取り直しで消えた資産に結び付いた指摘があるとき」（review・audit は加えて「止まった段が最初の流れの消えた資産の照合の段のとき」）だけ、その回の項目で行う。頭の段は SP-BPRUN-018（`bp-run.md:420-422`）で止まった段の計算から外れるので、頭の段の消えた資産の照合の途中で止まった run の次の再開では、止まった段にも `pending` にもその回の未着手が出ない。次の取り直しは前の取り直しで消えたと記録した資産を新しく消えたとは数えないので、その回の項目は誰も処理しない。反例（TLC `auth-n6-head-vanish-open`・`insp-n6-head-vanish-open`、`HeadStagesFinished` が破れる）：run 1 が止まる → run 2 の開始の取り直しで消えた資産が見つかり、頭の段の消えた資産の照合を始めて、途中で起動数の上限で止まる → run 3 は前の停止の段から続けて完了し、run 2 の回の照合は終わらない。直し方の候補：頭の段の、終わりの無い開始の未着手を再開の頭で処理すると書く（CLI が `start` の出力にその回と未着手を返す）。

### 4 回目の改稿で消えたもの

| ID | 前の版での中身 | 確かめ方 |
|---|---|---|
| N3 | 始め方の出所の停止の種類を、後の run が段を始めた後にも使う | `lastStop` が 1 に当たらないとき `null` になり、読みの定数を外した基準で `ResumeRowUnique` が成り立つ。前の振る舞いは mutation `auth-laststop-always` |
| N4 | 最初の流れの消えた資産の照合の段で止まると再開の行が無い | 表に行ができ（生成で「照合と停止から」と読む）、この段で止まれる基準で `ResumeRowUnique`・`NoLostRestart` が成り立つ。到達は wit `insp-WitnessDoneAfterVanishStop` |
| N5 | SP-BPRUN-045 の再開の拒否が状態とイベントの表に無い | 再開の拒否は状態を変えない（`bp-run.md:550`）。`RefusalChangesNothing` と `TableConformance` が基準で成り立ち、前の振る舞いは mutation `run-refusal-registers` |

### 3 回目の改稿で消えたもの

A1（E7・E10 の主語）・A2（合否の後の形式検証の回）・A3（review の再開の `placement`）・A4（create の BLOCKED｜開始）・A5 と N1（止まった段を決める時点・空の run）・N2（update の写しの段）・G2（`checkedRoleLimits`）・G3（`meaning`）。どれも基準の構成の性質（`NeverOccurs`・`NoStaleFormalResult`・`PlacementBeforeStop`・`ResumeRowUnique`・`NoLostRestart`・`SnapshotBeforeGoal`）と Node のテストで毎回検査し、前の振る舞いはそれぞれの mutation で破れる。

判定の表の網羅と排他（23 表）、状態 × イベントの網羅、SP-BPFINDINGS-018・019 と状態とイベントの一致、形の判定の表どうしの一致、再開の表の網羅は、どの版でも違反が無かった。

## モデルに入れなかった仕様と理由

| 仕様 | 理由 |
|---|---|
| fan-out の項目ごとの試行・打ち切り・全件の欠け（SP-BPRUN-028・029 の 1 つ目、SP-BPINSPECTION-016・018） | 項目の数で状態が増える。段の単位の BLOCKED（`Fail("verifiers")`）に畳んだ |
| 台帳の取り直しと消えた資産の照合の中身（SP-BPFINDINGS-005・020・037） | 資産の内容を持たないモデルでは「消えた」が起きない。再開の頭の段（`head: true`）としてだけ扱った（取り直しは再開の `start` の中で行う。頭の段の消えた資産の照合は、項目を持たない 1 つの段の開始と終わりとして入れた） |
| 指摘の状態遷移（SP-BPFINDINGS-016〜019） | 有限の表なので Node で全ての組を照らした（TLC にしても同じ組を数えるだけ） |
| 起動数の上限の式と予約分（SP-BPRUN-019〜022・035・037、SP-BPCONFORMANCE-022） | 数の大きさに依る。上限に当たったことを、どの段でも起こせる停止（`Fail("launch")`）として扱った |
| 停止の記録を書けない BLOCKED と `stop-draft`（SP-BPRUN-027） | CLI から見ると停止の記録の無い run（E7）と同じなので、`Fail("crash")` に含めた |
| 運搬役の送り直し・`sum`・ロック（SP-BPRUN-005 の書く時点、SP-BPRUN-031 の要求の形） | RunLifecycle では送り直しを同じ要求の再配達として扱い、要求の形とロックは扱わない |
| 目標の固定の段の出所の照合と until-pass（SP-BPAUTHORING-006〜009） | 段の中の繰り返しで、段の遷移を変えない。目標の固定は 1 回で通るか needs_input で止まるとした |
| 合否の中身（SP-BPAUTHORING-021〜023 の単位と指摘からの合否） | 合否の値（合格・不合格・検証が成り立たない）を環境の選択にした。表の網羅は Node で照らした |
| 書いたファイルの一覧と検証を通った記録（SP-BPRUN-009、SP-BPAUTHORING-026 の後半） | 完了の条件は合否と形式検証の順で見た。ファイルの単位は扱わない |
| 返り値の項目（SP-BPRUN-032、SP-BPAUTHORING-032〜034、SP-BPINSPECTION-024） | 状態から決定的に作る読み出しで、遷移を持たない |
| 入口と連鎖（bp-entry 全体） | 判定の表の網羅だけを Node で照らした |
| 適用の判定・判断点の表の照合の中身（SP-BPCONFORMANCE-003・041、SP-BPINSPECTION-006・007） | 表の網羅と表どうしの一致を Node で照らした。TLC の Inspection では段の結果だけを扱う |
| 列挙できなかった表 | 「条件:」の列を持たない表のうち、SP-BPAUTHORING-035 と SP-BPINSPECTION-030 は文の語を分類して照らし、SP-BPFINDINGS-018 は文ごとの述語で照らした。SP-BPRUN-005 の記録の表・SP-BPRUN-031 の操作の表のような説明の表は、入力の組を持たないので対象外。`bp-findings.md:104`（SP-BPFINDINGS-005 の取り直しの記録）・`:201`（SP-BPFINDINGS-014 の反証の結果の記録）・`:286`（SP-BPFINDINGS-024 の資産の結末）の 3 表は、条件を「> 条件の値」で宣言しない文で書いていて、条件の値の集合を表から機械で得られないので対象外（024 は「上記以外」の行で終わる上から順の表なので、当たる行が 0 個の組は構造上無いが、行どうしの重なりは見ていない） |
