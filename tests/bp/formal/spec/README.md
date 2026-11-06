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
| RunLifecycle | `MaxRuns` | 2 | 古い run と現在の run が並ぶ最小の数 |
| RunLifecycle | `Vals` | `{"a","b"}` | 同じ鍵に同じ内容と違う内容を送る 2 通り |
| Authoring | `Fn` | `"update"`（`"create"` の case も走る） | 作り直す前の写しの段の有無 |
| Authoring | `MaxRuns` | 2 | 停止 → 再開（最後の run も止まれる）。3 では 1 回の検査に約 10 分（4 worker）かかり、5 回目の改稿の途中の版で 1 回確かめた（3,762,971 状態、違反なし） |
| Authoring | `Limit` | 2 | run ごとの反復の上限（上限に達する経路と達しない経路の両方を作る最小の値） |
| Authoring | `MaxIter` | 2 | 反復の番号の上限（状態の有限化。`CONSTRAINT BoundOK`）。3 では 1 回の検査に数分かかる |
| Authoring | `MaxRound` | 2 | 形式検証の段の回の上限（同上） |
| Inspection | `Fn` | `"review"`（`"audit"` の case も走る） | 適用の判定の段の有無 |
| Inspection | `MaxRuns` | 3 | 停止 → 再開 → 停止 → 再開（最後の run は止まれない） |

項目の数は、検証の段（Authoring の check、Inspection の verify）を 2 件、他の項目を持つ段を 1 件とした（「全件の打ち切り」と「一部の打ち切り」の両方が起きる最小の数）。起動数の上限と運搬役の失敗は段の始めで起こし、項目の途中の止まりは停止の記録の無い終わり（crash）で起こす（どちらも同じ記録を残す）。

`check.sh` は、基準の構成 6 個のほかに、`Mutation` で 1 箇所を壊した構成、今の仕様に対する既知の反例（N7）と、到達しないことを確かめる構成（N9）、到達すべき状態の witness を走らせる。基準以外は全て違反が出ることを期待する。

## 仕様の行とモデルの対応表

### 段の遷移（TLC）

case の列は `check.sh` の case ID。`mut` は `Mutation` で 1 箇所を壊して性質が破れることを確かめる case、`gap` は今の仕様に対する既知の反例、`wit` は到達すべき状態の witness。基準の構成（`start`・`run`・`auth-update`・`auth-create`・`insp-review`・`insp-audit`）は全ての性質が成り立つことを期待する。行番号は 7 回目の改稿の後の版。

| 仕様項目 ID・file:line | action | 性質 | case |
|---|---|---|---|
| SP-BPRUN-003 `docs/specifications/bp-run.md:71-`（確かめの順。生成：`StartChecks`） | `Check`・`Begin` | `RefusalWritesNothing`、`FirstApplicable`、`StartOnlyWhenClean` | mut `start-write-early`・`start-reverse-order`、wit `start-WitnessRefusedAtLast` |
| bp-run 状態とイベント `bp-run.md:558-`（生成：`RunAllowed`・`RunNever`） | `E1`・`StopDeliver`（E2〜E6）・`E7`（現在の run だけ）・`E8`・`Deliver`（E9）・`E10`、再開の拒否 `Refuse`（E8 でなく状態を変えない） | `TableConformance`、`NeverOccurs`、`RefusalChangesNothing` | mut `run-resume-done`・`run-e7-any-run`・`run-refusal-registers` |
| SP-BPRUN-005・006 | `Deliver` | `OneRecordPerKey` | mut `run-resend-appends` |
| SP-BPRUN-017 | `Deliver`・`StopDeliver` の拒否 | `NoWriteOutsideCurrent`、`StaleNotStopReason` | mut `run-accept-stale`・`run-stale-blocks`、wit `run-WitnessStaleRejected`・`run-WitnessResumeFromRunning` |
| SP-BPRUN-014 | `E8` | `CompletedStaysCompleted` | mut `run-resume-done-stays` |
| SP-BPRUN-005 の記録の表 `bp-run.md:141-`（同一性の鍵。生成：`RecordKeys`：run の開始・段の読み直し・段の開始と項目の列挙・段の終わり・項目の結果・打ち切り・停止） | Authoring・Inspection の全ての記録 | `KeyUnique`（同じ種類の記録は表の鍵で 1 つ） | mut `auth-enter-again`・`insp-enter-again`（記録済みの段・回に段の開始をもう 1 つ書く） |
| SP-BPRUN-015（再開した run の進み方）、SP-BPAUTHORING-035（入口の段の表 12 行。生成：`AuthEntry`。上から順に当てる。8 の行の 3 つの条件（照合で状態を変えた・照合の「判定できない」・合否の後の内容の変化）は語の集合で読み、Node で確かめる） | `Resume`（開始の記録、取り直し、入口の段。update は写しの段を先に行う）→ `Begin`（終えた段は記録を書かずに通す。始めた段は鍵を省いた `stage-start` で段の読み直しを書き、未着手だけを `ItemStep` で処理する。始めていない段は段の開始を書く）→ `EndStage` | `EntryDefined`（状態から入口がちょうど 1 つ決まる）、`NoRelaunch`（結果か打ち切りのある項目と、終えた段の agent を起動し直さない。PR-BPDESIGNEDSKILL-020）、`DiscardOnlyAllAborted`（合否の無い反復を新しい反復で捨てるのは、全件打ち切りの段を持つときだけ） | mut `auth-drop-last-row`（EntryDefined）、`auth-rerun-finished`・`auth-redo-all-items`（NoRelaunch）、`auth-discard-any`（DiscardOnlyAllAborted）、wit `auth-WitnessDiscardAllAborted`・`auth-WitnessCompleteByEntry`・`auth-WitnessDoneAfterResume` |
| SP-BPRUN-018 `bp-run.md:430-`（止まった段：段の開始・段の読み直し・段の終わりの記録の最後） | 停止の記録の `stage` | `StoppedStageOfRun`（段を始めるか読み直してその中で止まった run は、その段を止まった段にする）、`StoppedStageReal`（終えた段を通った後に止まった run も、通った段を止まった段にする。N7 のため基準には入れない） | mut `auth-no-reread`・`insp-no-reread`（StoppedStageOfRun）、gap `auth-n7-stopped-stage-lags`・`insp-n7-stopped-stage-lags`（N7） |
| SP-BPFINDINGS-020 `bp-findings.md:274`（消えた資産の照合は流れの中の段で、終えていない取り直しの回を全て順に行う）、SP-BPAUTHORING-035 の入口より前の照合（9〜12 の行。生成：`AuthPreVanish`） | Authoring は check の段の終わりで回を閉じ、入口より前の照合を `EntryStep` → vanish の段 → `EntryStep`（表を当て直す）で行う。Inspection は `BeginVanish` | `AllRoundsMatched`（完了の前に全ての取り直しの回の照合を終える）、`PreVanishUnreached`（N9） | mut `insp-vanish-latest-only`、`auth-pre-vanish-unreached`（expect pass）、wit `insp-WitnessTwoRoundsMatched` |
| SP-BPAUTHORING-005（生成：`AuthStageSeq`）、SP-BPAUTHORING-004 | `Begin`〜`EndStage`、写しの段 | `SnapshotBeforeGoal` | mut `auth-skip-snapshot-on-resume` |
| SP-BPAUTHORING-021、SP-BPRUN-031 `gate`・`placement` | 合否の段の終わり | `PlacementBeforeGate` | mut `auth-skip-placement` |
| SP-BPAUTHORING-024・025（生成：`GateNext`）、SP-BPRUN-013 | 合否の段の終わり | `IterationLimitPerRun` | mut `auth-limit-unchecked`、wit `auth-WitnessIterationLimit` |
| SP-BPAUTHORING-026・042・044・045（生成：`FormalRows`）、SP-BPRUN-031 `stop` | `Complete`（最後の合否が合格で、その後に始めた最後の回の結果が通る） | `CompleteAfterGateAndFormal`、`NoRefusedCompletion` | mut `auth-skip-formal`、wit `auth-WitnessDone`・`auth-WitnessFormalFailedThenDone` |
| SP-BPAUTHORING-027 | 目標の固定の段の結果（足りない入力） | `NeedsInputOnlyAtGoal` | mut `auth-needs-input-anywhere` |
| SP-BPRUN-010（生成：`StopUse`） | 停止の記録 | `StopKindsUsed` | mut `auth-stop-dry`・`insp-stop-needs-input` |
| SP-BPRUN-014（Authoring・Inspection 側） | `Resume` は完了の後に起きない | `NoRunAfterDone` | mut `auth-resume-done`・`insp-resume-done` |
| SP-BPINSPECTION-030 `bp-inspection.md:344-`（入口は照らす先の決定。照らす先の決定と台帳の作成と資産の束は終えていても段の開始を書いてから行う） | `Resume`・`Begin`（`Redo`） | `EntryIsTargets` | mut `insp-entry-skips-targets` |
| SP-BPINSPECTION-001・002（生成：`InspStageSeqReview`・`InspStageSeqAudit`） | `Begin`・`EndStage` | `NoSkippedStage`、`NoBackEdge`（run の中の段の開始と段の読み直しが段の並びの順） | mut `insp-skip-stage`・`insp-back-edge` |
| SP-BPINSPECTION-019、SP-BPRUN-031 `stop`（review の完了は現在の run の `placement` の記録を求める） | `Close` | `PlacementBeforeStop` | mut `insp-omit-placement` |
| SP-BPINSPECTION-004・029 | 照らす先の決定の段の終わり | `NoVerifyAfterMismatch` | mut `insp-mismatch-continues`、wit `insp-WitnessMismatch` |

### 判定の表（`tables.test.mjs`）

| 対象 | 検査 |
|---|---|
| 「条件:」の列を持つ全ての判定表（6 文書の 23 表。`bp-entry.md:104,141,184`、`bp-run.md:195,289,322`、`bp-authoring.md:214,262,336,357,403,443,505,550,583`、`bp-inspection.md:117,138`、`bp-conformance.md:48,91,124,144,226,267`） | 「> 条件の値」の積の全ての組で当たる行がちょうど 1 つ。宣言に無い値のセルが無い。宣言に無い「上記以外」（`bp-conformance.md:236`）は、上の行のどれにも当たらない組に当たる行と読む |
| 状態 × イベント（`bp-run.md:537-600`、`bp-findings.md:381-432`） | 図と表を合わせて全ての組をちょうど 1 回定める |
| SP-BPFINDINGS-019 `bp-findings.md:255-260` | 4 状態 × 3 判定が揃い、状態とイベントの E3〜E5・E6 の行き先と一致する（E6 は SP-BPFINDINGS-018 の 5 行目の「最後の判定と同じ値」で導く） |
| SP-BPFINDINGS-018 `bp-findings.md:229-246` | 4 つの条件の値の全ての組から起こりえない組（5 つの箇条）を除くと、上から順に当てて当たらない組が無い |
| SP-BPINSPECTION-006 `bp-inspection.md:127-133` | 受ける答えの並びが、図の道（最初の「はい」で止まる並び）とちょうど同じ。到達する形の集合が SP-BPCONFORMANCE-003 の「形」の値と同じ |
| SP-BPCONFORMANCE-004 `bp-conformance.md:124-131` と SP-BPINSPECTION-006 `bp-inspection.md:138-145` | 「答えてはならない」並びと「受理しない」並びが一致する |
| SP-BPAUTHORING-044 | 通らない行は必ず `cause`（`formalUnrunnable` か `formalFailed`）を持つ |
| SP-BPAUTHORING-025 と SP-BPRUN-031 `gate` | 進み方の行き先と `next` の値が同じ集合 |
| SP-BPAUTHORING-035 の入口の段の表 | 10 行の全てを閉じた語の集合で読め、合否の 3 値・合否の無い反復・反復の無い状態・目標の無い状態に行があり、「上記以外」の合格の行が最後にある（上から順に当てる表なので網羅は TLC の `EntryDefined` でも見る） |
| SP-BPRUN-005 の記録の表と SP-BPRUN-031 の `stage-start`・`stage-finish` | 段の開始・段の終わり・段の読み直しの鍵が、操作が受け取る鍵の欄（`stage`・`round`・`part`、値つきで書いた欄を含む）と食い違わない。前の版の blocking（段の終わりの鍵は段・回なのに `stage-finish` が `head: true` を受けた）は、この検査で落ちる（4 回目の改稿の版に当てて確かめた） |
| SP-BPRUN-010 `bp-run.md:322-334` | review・audit は needs_input を使わず、反復の上限は起動数の上限のときだけ。create・update は 4 つを使う |

### 情報の流れ（`flow.test.mjs`）

`bp-run.md` の SP-BPRUN-031 の操作の表から、操作ごとに受け取るもの（括弧の外の欄の名前）と返すもの（同）を抜き出し、`bp-entry.md` の SP-BPENTRY-013 の綴りの表を Workflow の入力とする。操作は、段の表（`bp-authoring.md` の SP-BPAUTHORING-005 の「定める仕様項目」、`bp-inspection.md` の SP-BPINSPECTION-001 の「定める項目」）と操作の表の「実現する項目」が共有する仕様項目 ID で段に結び付ける。「`<操作>` の記録が無ければ」で名指す前提（`gate` ← `placement`）は、両方が段に結び付くとき同じか前の段にあることを確かめ、結び付かない組は「見ていない」と出力に宣言する。

**検査の限界**：操作の表にも段の表にも、操作と段の対応・欄の出所の列が無いので、列だけからは多くの操作の段と欄の作り手が決まらない。これは仕様の欠けではない（例：review の `placement` は `bp-inspection.md` の SP-BPINSPECTION-019 が照合と停止の段で送ると散文で定めている）。共有する仕様項目 ID で段に結べた操作は 39 個のうち create・update で 16 個、review で 10 個、audit で 9 個で、受け取る欄 44 個は名前の同じ返すものも Workflow の入力も無い（`item` は `stage-start` の `items` の要素、`verdict` は反証役の結果、`attempt`・`number` は script の数えのように、散文が出所を定める）。名前だけが同じで別の値の欄（`paths-retake.iteration` と `placement` の出力など 3 件）は見分けられない。見ていないこの範囲は `flow-limits.json` に一覧で置き、テストは毎回その一覧を出力に宣言し、今の仕様から作った一覧と違えば落ちる（見ていない範囲が黙って増減しない）。散文から操作の段を写すのは手で写すことになるので、行わない。

## 見つけた仕様の違反・あいまいさ・欠け

検査を緩めて通したものは無い。今の仕様に対する既知の反例は、違反の出る構成を期待する case（`check.sh` の出力で `[known spec ambiguity or gap: see README]`）として残した。仕様が直って違反が消えると、その case が落ちるので、本節から外す合図になる。

### 残っているもの（7 回目の改稿の後の仕様に対して）

- **N7（minor）終えた段を通った後に止まった run の止まった段が、通る前の段を指す**：SP-BPRUN-015 の 3 は、終えた段を段の記録を書かずに通し、SP-BPRUN-018 は止まった段を最後の段の記録（段の開始・段の読み直し・段の終わり）から決める。再開した run が終えた段を通り、次の段の開始を書く前に止まると、止まった段はその run が通る前に書いた記録の段を指す。反例（TLC `auth-n7-stopped-stage-lags`・`insp-n7-stopped-stage-lags`、`StoppedStageReal` が破れる）：run 1 が書く段を終えた後に止まる → run 2 は写しの段を読み直し、書く段を通り、検証の段の開始を書く前に止まる → 停止の記録の止まった段は「作り直す前の写し」。review・audit では台帳の作成と資産の束の読み直しを指したまま、担当の作成〜反証を通った後に止まる。止まった段は報告にだけ使う（SP-BPRUN-018）ので、影響は報告と `stop-draft`・`list` の表示。直し方の候補：終えた段を通るときも段の読み直しを書くか、止まった段の定義を「通った段」まで広げる。
- **N9（minor・観察）入口より前の消えた資産の照合に、モデルでは到達しない**：SP-BPAUTHORING-035 は、9〜12 の行に当たり照合を終えていない取り直しの回があるとき、入口より前に消えた資産の照合を行う。取り直しの回は資産が消えた（対象スキルの内容が変わった）ときにだけでき、そのとき指紋も変わるので、8 の行（合否の後に内容が変わった）が先に当たり、9〜12 の行に当たらない。合否の前にできた回は、合否の前の流れの照合の段が閉じる。TLC `auth-pre-vanish-unreached`（`PreVanishUnreached` が成り立つことを確かめる構成）。仕様の違反ではないが、この規定が効く状態があるなら、指紋と取り直しの関係（指紋が変わらずに取り直しの回ができる場合）を仕様に書くと読み手が迷わない。到達するようになれば、この構成が落ちて知らせる。

前の版の N8（入口が形式検証か完了のとき、取り直しの回を照合しないまま完了する）は、7 回目の改稿の 8 の行（合否の後に内容が変わったら新しい反復）と入口より前の照合で消えた（create・update でも `AllRoundsMatched` が基準で成り立つ）。N6 は review・audit・create・update の全てで消えた。

### 4 回目までの改稿で消えたもの

以下の表と次の節の性質名・case は、その版のモデルのもの。5 回目の改稿で再開の規則（止まった段ごとの始め方の表・頭の段・`lastStop`）が無くなり、モデルを作り直したので、今のモデルには無い。

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
| fan-out の項目ごとの試行の回数と試行の上限（SP-BPRUN-028）、担当の組・skip 一覧の部分（SP-BPINSPECTION-016・018、SP-BPFINDINGS-025） | 項目は段ごとに 1〜2 件にし、試行の失敗は打ち切りに畳んだ（結果か打ち切りのどちらかで項目が終わる）。全件の打ち切りの BLOCKED（SP-BPRUN-029）は入れた |
| 台帳の取り直しと消えた資産の照合の中身（SP-BPFINDINGS-005・037） | 資産の内容を持たないモデルでは「消えた」を環境の選択（再開の開始の取り直しが取り直しの回を作るか）にした。回ごとの照合の段の開始と終わりは入れた（Authoring は検証の段に畳んだ check の終わりで回を閉じる） |
| 指摘の状態遷移（SP-BPFINDINGS-016〜019） | 有限の表なので Node で全ての組を照らした（TLC にしても同じ組を数えるだけ） |
| 起動数の上限の式と予約分（SP-BPRUN-019〜022・035・037、SP-BPCONFORMANCE-022） | 数の大きさに依る。上限に当たったことを、段の始めで起こせる停止（`Fail("launch")`）として扱った |
| 停止の記録を書けない BLOCKED と `stop-draft`（SP-BPRUN-027）、目標の固定の回の数え方の細目（SP-BPAUTHORING-036） | CLI から見ると停止の記録の無い run（E7）と同じなので、`Fail("crash")` に含めた |
| 運搬役の送り直し・`sum`・ロック（SP-BPRUN-005 の書く時点、SP-BPRUN-031 の要求の形） | RunLifecycle では送り直しを同じ要求の再配達として扱い、要求の形とロックは扱わない |
| 目標の固定の段の出所の照合と until-pass（SP-BPAUTHORING-006〜009） | 段の中の繰り返しで、段の遷移を変えない。目標の固定は 1 回で通るか needs_input で止まるとした |
| 合否の中身（SP-BPAUTHORING-021〜023 の単位と指摘からの合否） | 合否の値（合格・不合格・検証が成り立たない）を環境の選択にした。表の網羅は Node で照らした |
| 書いたファイルの一覧と検証を通った記録（SP-BPRUN-009、SP-BPAUTHORING-026 の後半） | 完了の条件は合否と形式検証の順で見た。ファイルの単位は扱わない |
| 返り値の項目（SP-BPRUN-032、SP-BPAUTHORING-032〜034、SP-BPINSPECTION-024） | 状態から決定的に作る読み出しで、遷移を持たない |
| 入口と連鎖（bp-entry 全体） | 判定の表の網羅だけを Node で照らした |
| 適用の判定・判断点の表の照合の中身（SP-BPCONFORMANCE-003・041、SP-BPINSPECTION-006・007） | 表の網羅と表どうしの一致を Node で照らした。TLC の Inspection では段の結果だけを扱う |
| 列挙できなかった表 | 「条件:」の列を持たない表のうち、SP-BPAUTHORING-035 の入口の段の表は文の語を分類して生成し、SP-BPFINDINGS-018 は文ごとの述語で照らした。SP-BPRUN-005 の記録の表・SP-BPRUN-031 の操作の表のような説明の表は、入力の組を持たないので対象外。`bp-findings.md:104`（SP-BPFINDINGS-005 の取り直しの記録）・`:201`（SP-BPFINDINGS-014 の反証の結果の記録）・`:286`（SP-BPFINDINGS-024 の資産の結末）の 3 表は、条件を「> 条件の値」で宣言しない文で書いていて、条件の値の集合を表から機械で得られないので対象外（024 は「上記以外」の行で終わる上から順の表なので、当たる行が 0 個の組は構造上無いが、行どうしの重なりは見ていない） |
| 前提の記録（SP-BPRUN-004）と再開の回答（`answer`） | 目標の固定の段の結果（固定・足りない入力）で表した |
