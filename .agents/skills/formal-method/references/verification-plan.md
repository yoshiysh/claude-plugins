# 検証計画: formal-method

仕様（`docs/specifications/formal-method.md`）の受入条件 AC-01〜21 と、[設計](architecture.md)の内部の仕組みを、何でどう確かめるかを定める。

ケースの作り方は `docs/guidelines/testing.md` に従う（正常・準正常・異常・境界の観点、パラメタライズ、期待値は仕様から決める）。ここには観点の割当てだけを置く。

## 目次

- [検証の層](#検証の層)
- [AC ごとの検証の層](#ac-ごとの検証の層)
- [判定のオラクル照合](#判定のオラクル照合)
- [内部の設計に当てる形式手法](#内部の設計に当てる形式手法)
- [要求の形式検証の作り直し](#要求の形式検証の作り直し)
- [テストの作成役に渡すもの](#テストの作成役に渡すもの)
- [依頼者の決定と残る論点](#依頼者の決定と残る論点)

## 検証の層

| 層 | 何を確かめるか | 置き場と入口 |
|---|---|---|
| unit | `scripts/lib/` の純粋関数（依頼の検査、判定の集約、照合、グラフの導出、同時に動かす数の決め方）の入出力と、作用の境界を引数で差し替えて呼ぶ内部の入口（`publishResult`・`runExecution`）の振る舞い | `scripts/lib/**/*.test.mjs`。`make test` |
| 結合 | `formal-method-cli.mjs` を本番と同じ入口（標準入力の JSON）から呼び、担当の代わりの harness と差し替えた道具（`PATH` に置く偽の z3）で、結果・記録・観測できる process を確かめる | `scripts/*.test.mjs`、`scripts/test-fixtures/`。`make test` |
| eval | 実際の model で担当を動かしたときの意味の判断。抽出の網羅、意味の食い違いの発見、原因の分類、司令塔が判定を足さないこと | `evals/evals.json`（T が実装の前に仕様から作る）。skill-creator の eval |
| 形式 | 判定の規則とオラクルの一致、run の進行と停止・排他の性質、要求の整合 | `tests/formal/formal-method-skill/`、`tests/formal/formal-method-spec/`、`tests/formal/formal-method-requirements/` |

結合のテストで観測してよいのは、仕様の検証方法の節が許すものだけである。返った結果、結果が参照する記録、実行環境で観測できるもの（process・ファイル）に限る。

依頼の項目以外の入力の口は使わない。道具の振る舞いを変えるときは、`PATH` に置く道具を差し替える。担当の振る舞いは、Workflow の代わりに harness が attempt の領域へ返り値を書いて変える。harness は、本番の担当と同じ return の契約（`artifact-formats.md`）だけを使う。

## AC ごとの検証の層

○ は主に確かめる層、△ は補う層。

| AC | unit | 結合 | eval | 形式 | 確かめ方の要点 |
|---|---|---|---|---|---|
| AC-01 | △ 正規化 | ○ | ○ | | 結合: 同じ依頼の JSON を `start` に 2 回渡し、`verified_scope` の対象・版・範囲が一致することを見る。範囲の外の対象と指定していない目標が `検証済み` に現れないことも見る。eval: 人の自然文の依頼と、別のスキルが渡す JSON が同じ項目の依頼になることを見る |
| AC-02 | ○ coverage | ○ | ○ | | 結合: 性質の一覧が分かっている対象と harness の抽出で、出所付きで全て含まれることを見る。読めない区間を含む対象で網羅済みにならないこと、形式化できない性質の理由・確認した者・未確認の区別も見る。eval: 実際の抽出役が既知の一覧を拾うこと 網羅済みかは `verified_scope.extraction_coverage.complete` で観測する（読めない区間を含む対象で false、全て読めて抽出の確認が成り立つ対象で true）。 |
| AC-03 | ○ matrix・paths・diagram | ○ | | △ | 結合: 定めの無い組合せと到達できない目標を含む対象で、3 区分と根拠、未検証、`完了` にならないことを見る。図とモデルの突き合わせは、T が独立に書いた比較で行い、結果の余分・欠け・省いた条件と一致することを見る |
| AC-04 | ○ mapping | ○ 構造 | ○ | △ 空虚性 | 結合: 意味の確認の記録が、項目の判定・確認した者・渡した資料を持つこと。保証と境界・証明の義務、公平性の前提、矛盾した前提で成功にならないこと（偽の z3 の sanity が unsat を返す）を見る。eval: 否定・量化・時間の順序を逆にしたモデルを、忠実さの検証者が一致としないことを見る。inspection: 人がモデルと要求を読む |
| AC-05 | ○ decode | ○ | △ 比較の中身 | | 結合: 道具を `PATH` から除く、異常終了する、読めない出力を返す偽の z3 に差し替え、`未実行` か `実行失敗` になること。実測どおりのメモリ不足（標準エラーに `(error "out of memory")`、終了コード 101）と構文の誤り（標準出力に `(error …)`、終了コード 1）が、どちらも `実行失敗` になること。答えとしての `unknown` は `unknown` になること。候補の比較に Rust と Z3 を含み、見積りが取れない値を 0 にしないこと |
| AC-06 | ○ graph | ○ | ○ 実行時の参照 | △ 性質ベース | 結合（analysis）: 返されたモデルからグラフを T の独立の実装で導き直し、要素・辺・箇所が一致すること。返された `criteria` を当て直して候補が一致すること。候補だけで独立に検証できると示されないこと。実行時にしか決まらない参照を含む対象でその関係が未確認として示されることは、主に eval と inspection で確かめる。理由: その参照をモデルにどう書くかはモデル作成役が決め、CLI が機械的に見つけられるのは宣言の無い記号・添字・関数の値による参照に限られる。結合は、その形の参照が未確認に出ることだけを補う |
| AC-07 | ○ compose | ○ | ○ 合成の検証者 | △ | 結合（analysis）: 分割前後の要素と契約・責任・合成の条件を T の独立の照合で突き合わせ、`unmatched`・`excluded` と一致すること。相互の前提だけの分割、環境の前提が依頼に無い分割で `検証済み` にならないこと |
| AC-08 | △ 原因の受付 | ○ 構造 | ○ | | eval: 判定に要る決まりが無い対象で `要求の不足` と問い（不足・影響先・選択肢）になること。性質に反する対象で `対象が性質を満たさない` になること。結合: 問いに依存する性質が成功にならないこと。inspection: `形式モデルの欠陥`・`分類処理の欠陥` とされたものを、根拠とモデル・出所で読む |
| AC-09 | ○ 集約 | ○ | | ○ オラクル | 結合: 偽の z3 が成り立つ・反する・判定できない・時間の上限を返す 4 性質で、各判定が区別され、反例の項目が揃い、`停止` になること。独立な検査が D1 のとおり最後まで動くことも見る。常に成功を返す道具では変異の検出が `検出せず` になり、成功にならないこと。`property`・`composition` の検査の道具の引数に `-model` があり、他の種類（`contract`・`sanity`・`mutation`・`replay`）に無いこと。反例の replay の `input.smt2` が、反例の検査の query の `(check-sat)` の直前に証人の値の assert を持つこと。形に合わないモデルでは、反例の検査は `反例` のままで、replay が始まらず `確認できず` になること（[CLI 契約の証人](cli-contract.md#証人)）。部分の契約の検査が `checks[]` に `kind: contract` で現れ、`properties[].check_ids` に入らないこと。外からの照合: 各性質の `properties[].check_ids`（結び付きの正本）が指す `checks[].verdict` に SP-011 の集約の規則を当て直し、性質の判定の集合と一致すること。確認用の道具の実行（`confirmations`）は照合に入れない。オラクル: [判定のオラクル照合](#判定のオラクル照合) |
| AC-10 | △ 同時に動かす数 | ○ demonstration | | △ | 結合: 互いに依存しない性質を複数持つ対象を与え、`ps` の標本で、道具の process が同時に複数あることを見る（偽の z3 に応答を遅らせる指示を書いて、重なりを観測できるようにする）。時間の上限で止めた場合に、完了と未完了の範囲が示されることを見る。確認用の実行も時間の上限で止まり、`stop_report` に出ることを見る。CPU とメモリの上限は観測しない（要求・仕様の対象外） 時間の上限が小さい依頼（1 秒）では、期限の過ぎた担当と道具を出さず、`停止` と理由 `時間の上限` を返し、完了と未完了の範囲が示されることを見る。 |
| AC-12 | ○ performance・条件の照合 | ○ | | | 結合（結果だけで観測する）: 環境変数 `CI` の有無で `performance` の実行の場所が分かれること。取れない値が `取得できず` で 0 と区別されること。道具の候補を比べた性質で `method.comparison_conditions` があり、性質・前提・範囲・保証・判定の規則の版の一致を確かめた結果を持つこと。条件の一致しない候補の組（範囲や保証の違う候補）では `一致を確認できず` となり、優劣が示されないこと。改善の候補の検討の結果が「この run では採用しない」で、結果のどこにも、条件の一致を確かめていない改善・優劣が現れないこと。初回とキャッシュの区別は観測しない（要求・仕様から外した） **条件の一致しない比較の作り方**: 担当の代わりの harness が、計画作成役の返り値（`PlanFile`）に、`performance_claim` を持ち `comparison_basis` の範囲・保証が他の候補と違う候補を書く。結果の `method.comparison_conditions` が `一致を確認できず` になり、その候補の `performance_claim` が `null` で、`reason` と `chosen` の理由に優劣が出ないことを見る。条件が一致する組では `一致を確認` になることも見る。依頼や環境に新しい口は要らない（harness は担当の返り値の契約だけを使う）。 |
| AC-13 | △ | ○ | | △ | 結合: 保存先の root を書込み不可にして `start` し、標準出力の結果が `停止` で、`records.saved` が空、`records.unsaved` に結果のファイルを含む全ての記録と理由が出ること。途中の段で書込み不可にして（ディレクトリの権限を変える）、保存できたものの参照と保存できなかったものが分かれることも見る |
| AC-14 | ○ decideStatus | ○ | | ○ オラクル | 結合（パラメタライズ）: 未対応・未実行・unknown・時間切れ・実行失敗・未確認・未保存を 1 つずつ残すと `停止`、全て成り立つときだけ `完了` になること。必要な性質が 0 件の場合と `検出能力未確認` が残る場合に `完了` にならないこと。形式: オラクルの Q10 群 |
| AC-15 | ○ request | ○ | | | 作業ツリーの根を対象にした run を 2 回続けて行い、2 回目の集まりに作業ツリーの根の `.formal-method/` が入らず、2 回の集まりの指紋が同じで（作業ツリーの他のファイルを変えない場合）、除いたものが `unread` に載らず、`verified_scope.exclude` に `origin: "formal-method"`・理由「formal-method が除く」で載ること。そのうえで、他に読めない箇所が無ければ `extraction_coverage.complete` が true になりうること。名前が `.git` のものは、ディレクトリでもファイル（worktree・submodule の形）でも、どの深さでも除かれること。深い場所に利用者が作った `.formal-method/` は除かれずに集まりに入ること。`location` が symbolic link のとき、解決した先を読み、`resolved_location` に出ること。依頼に秘密値の 4 つの型のどれかがあるとき、`request.input.json` が書かれず、`保存の失敗` の停止になること。4 つの型に無い形（`password=…`、`sk-…`）では停止しないこと。対象のファイルに秘密値の型があっても、写しが保存され、停止しないこと。未知のキーは拒まず、`unverified[]` に載ること（拒むケースに入れない）。対象はファイルとディレクトリの両方で、バイナリや読めないファイルが受け付けない依頼にならず `unread` に載り、`target_unavailable` は `location` が無い・根を読めない・扱えない URI の場合だけであること。git の外のファイルに `revision` を添えると `revision_mismatch` になること。パラメタライズ: 対象なし、目標なし、識別子の重複、理由の無い除外、依頼に無いもの・対象に無い箇所を指す範囲と除外、0・負・整数でない時間の上限、取得できない対象、版・指紋の不一致。どれも検証を始めず（対象の写し・検査の記録が無い）、項目と理由が出ること |
| AC-19 | | ○ | | △ | 結合: 段ごとに失敗を起こす（harness が欠けた返り値を書く、その段の書込み先を書込み不可にする）。`stop_report.stage` がその処理の作業記録の段と一致すること、停止の報告の 7 項目が区別されることを見る |
| AC-21 | ○ result の schema | ○ | | | 結合: `完了` と `停止` の両方の結果が、`stop_report` 以外の全てのキーを持ち、schema に通ること。`停止` だけが `stop_report` を持つこと。`report.md` に現れる成功の語が、全て構造の該当する欄にあること |

欠番（AC-11・16・17・18・20）は検証しない。AC-02・04・08 の意味の部分は、eval と inspection の結果を証拠として扱い、自動テストの完了に数えない（`testing.md`「仕様との対応と完了」）。

## 判定のオラクル照合

`tests/formal/formal-method-spec/` は、仕様の SP-011・015 を Z3 に符号化したオラクルである。実装の `classifyCheck`・`aggregateProperty`・`decideStatus` をこれと照合する。

**前提の確認（照合の前に必ず行う）**

- オラクルは r11（CPU とメモリの上限を外した網羅）である。`gen.py`・`questions.py`・`endstates.py` の規則の名前（`L157`・`L138` など）は、290 行版の仕様の行番号に合わせてある。
- 照合の前に、F が規則ごとに 290 行版の仕様の文を当て、符号化が今の文と一致することを確かめる。
- 確かめた結果は、規則名から今の SP の段落への対応表として `tests/formal/formal-method-spec/` の外（`tests/formal/formal-method-skill/oracle-map.md`）に記録する。オラクルそのものは変えない。
- 行番号の名前は直さず、この対応表で足りるとする（依頼者の決定）。対応を付けるときに旧い版と今の版の意味の違いが見つかったら、F は照合を進めずに依頼者へ報告する（依頼者の決定）。
- Z3 の実行体は、環境変数 `Z3` を優先して読む（r11 で直してある）。CI の formal の job は `Z3` を設定して走らせる。

**照合 1: 検査の判定（`enum_table.txt`）**

- `endstates.py` の網羅表は、1 つの検査の終わり方の全ての組（返り 8 × 止め方 3 × 時間の上限 3 = 72 行）を、検査の判定に写す。
- T は表を読むパラメタライズドテストを書く（`tests/formal/formal-method-skill/verdict-oracle.test.mjs`）。
  - 判定が一意の行は、`classifyCheck` がその値を返すことを確かめる。
  - `unsat` の行（例: 依頼元の時間の上限に達したのに止めていない）と `除外` の行は、`classifyCheck` が例外で拒むことを確かめる。
  - scheduler がその終わり方を作らないことも確かめる（scheduler の unit。`scripts/lib/scheduler.test.mjs`）。入口は設計の「scheduler の unit の入口」の `runExecution(execution, io)` で、`io.clock`・`io.spawn` を偽の時計と偽の process に、`io.signal` を `AbortController` の signal に差し替える。偽の process は `killGroup` の後に close を出す。次の順で出来事を起こし、各行で返った `end` が設計の規則どおりの値であること、`killGroup` を呼んだかが規則どおりであること、`classifyCheck(end)` が例外を投げないことを確かめる。
    - close → 期限、close → 停止の要求（`stopped_by: null`。`killGroup` を呼ばない。`execution.expected` と偽の出力・終了コードを決め、`tool_result` と `time_limit_hit` まで `cli-contract.md` の読む順と答えの対応どおりか照らす）
    - `with_model: false` で期限 → close（期限の前に答えの行を含む出力を受けていても `tool_result: "なし"`・`stopped_by: "時間"`・`time_limit_hit: "依頼元"`）
    - `with_model: false` で停止の要求 → close（`stopped_by: "その他"`・`time_limit_hit: null`）
    - 期限 → 停止の要求、停止の要求 → 期限（先の方で決まる）
    - 止めた後の close が 0 以外か null の終了コード（`abnormal_exit: false`）
    - `with_model: true` で答えの行を受けた後、close の前に期限（答えの行が chunk にまたがる場合を含む。`stopped_by: null`・`killGroup` を呼ぶ・`tool_result` は答えの行で決まる・`model_cut: "stopped_after_answer"`）。`with_model: true` で答えの行を読み終える前に期限（`stopped_by: "時間"`・`tool_result: "なし"`）
    - 標準出力が `TOOL_OUTPUT_MAX_BYTES` を超える（`with_model: false` なら `stopped_by: "その他"`・`unreadable_output: true`。`with_model: true` で答えの行の後なら止めず、`end` は close が最初の行と同じで `model_cut: "truncated"`。答えの行の改行が上限以内で同じ chunk の終わりが上限を超える場合も同じ。出力がちょうど `TOOL_OUTPUT_MAX_BYTES` バイトで終わる場合は `model_cut: "none"`。`model_cut` の値を挙げていない他の行は全て `none`）
    - 呼ぶ前に期限が過ぎているか停止の要求が済んでいる（`spawn` を呼ばず `started: false`）
- 表は commit 済みの事実として読むので、このテストに Z3 は要らない。`make test` で走る。

**照合 2: 性質の判定と完了（`questions.py`・`summary.txt`）**

- `summary.txt` で「一意」の Q は、その期待を `aggregateProperty`・`decideStatus` の期待値にする。r11 の一覧は Q1〜Q7・Q9〜Q28 で、Q8（メモリの不足）は削除、Q20 は「資源を理由にした判定できない」が `unknown` に変わった（`Q20_unknown_citing_resource`）、Q28（道具の判定以外のエラー → `実行失敗`）は追加である。
- 「未確定」の 2 つ（Q5・Q6）は、仕様が複数の答えを許す点である。
  - Q5 は、依頼者の決定 D1（独立な検査を最後まで続ける）から期待値を決める（P1 は `反例`、P2 は `検証済み`）。
  - Q6 の P1 は、オラクルのどちらの答えでも `未実行` に一意に決まるので、照合 2 の期待値を `未実行` とする（D2 は使わない）。この入力（問いに依存する性質に計画した検査があり、始めていない）は、今の設計では生じない（問いに依存する性質は検査を作らない）。それでも `aggregateProperty` は入力の形として受け付けるので、関数の照合としては `未実行` を期待する。
  - Q6 の P2 は、依頼者の決定 D2（回答に依存しない検証も続ける）から `検証済み` とする。
  - テストには、出所を「依頼者の決定」と書く。
- Q の入力（`chk`・`prop`・`glob`）は、実装の入力の形へ写す関数を 1 つ置き、その写しを T が書く。

**照合 3: 有界の全数照合**

- 性質 1〜2 個、検査 0〜2 個の範囲で、実装の入力の全ての組を作る。
- 依頼者の決定 D1・D2 を、`gen.py` の Model に名前付きの assert（`D1_…`・`D2_…`）として加える。仕様が複数の答えを許す入力（Q5・Q6 の型）で、決定が答えを 1 つに絞るためである。
- 入力ごとに、次の 2 つを別々に確かめる。
  - 整合: 仕様 ∧ 決定 ∧ 実装の出力 が sat になる。実装の出力が仕様と決定に反しないことを示す。
  - 一意: 仕様 ∧ 決定 ∧ ¬実装の出力 が unsat になる。仕様と決定の下で、実装の出力以外があり得ないことを示す。
- 一意が成り立たない入力（決定を加えても答えが複数ある入力）は、合格にも不合格にもせず一覧に出し、依頼者に返す。
- 理由: 一意だけを見ると、仕様が複数の答えを許す入力で、正しい実装を不合格にする。整合だけを見ると、仕様が許す答えのどれを出しても通るので、決定が絞った 1 つの答えを出したかを確かめられない。
- 退けた案: 「仕様 ∧ ¬実装の出力 が unsat」だけで合格とする（前の稿）。
- 外部の Z3 が要るので、CI の formal の job で走らせる。
- 範囲の外（性質 3 個以上、検査 3 個以上）は未検証として README に書く。
- 理由: 照合 1・2 は、オラクルの作者が選んだ組だけを見る。全数で、規則の重なりと漏れを見つける（`skill-design-patterns.md`「機械で確かめる」の閉じた有限対象）。

## 内部の設計に当てる形式手法

| 対象 | 性質 | 手段 | 範囲と前提 |
|---|---|---|---|
| run の進行と停止（司令塔・`run-daemon`・client・担当・環境） | (1) 全ての run は、`status.json` の `terminal` か salvage の結果の、ちょうど 1 つの結果で終わる。公平性は `run-daemon`・司令塔の動作と時間の経過にだけ置き、担当には置かない。担当の batch の内部の期限があるので、時間の上限の無い run でも成り立つ。道具の実行は道具の時間の上限で終わる前提を置く。(2) 時間の上限の後に、道具の実行（確認用を含む）と担当を始めない。(3) 古い・二重の `submit` は状態を変えない。(4) 保存の失敗は、`status.json` か salvage の結果のどちらかに届く。(5) `完了` は完了の条件が全て成り立つときだけ。(6) 反例・問いがあっても、独立な検査は終わるまで動く（D1）。(7) client は状態を書かない。`wait` は `status.json` の `seq` か保持者の終了でだけ返る。(8) salvage の `E_BUSY` の後、司令塔は、役が `run-daemon` なら `wait` に、`salvage` なら `salvage` に戻る。(9) `start` は、起動の失敗と起動の途中の crash の全ての場合で、`status` か結果のちょうど 1 つを返す。遅いだけの `run-daemon` を落ちたものとみなして、結果を 2 つ作らない | TLA+・TLC（`tests/formal/formal-method-skill/Run.tla`） | 段を 7 つ、性質 2、検査 2（独立 1 組と依存 1 組）と確認用の実行 1、batch の返り値の種類、保存の失敗、時間の上限、`run-daemon` の起動の失敗、一時の領域を作った後で rename の前の crash、rename の後で最初の `status.json` の前の crash、`CALL_MAX_MS` までに rename しない遅い `run-daemon`、`run-daemon` の crash、salvage の到着の時点を非決定で選ぶ。各性質に、それを壊す変異と到達の証人を置き、空虚な成功を除く（旧 check.sh の枠を流用） |
| 排他と salvage | (1) `state.json`・`status.json`・`ledger.json` を書くのは `run-daemon` だけで、`result.json` は `run-daemon` か salvage の link だけで作られる。(2) run の領域は lock を持った状態でだけ現れる。(3) salvage は `state.json`・`status.json`・`ledger.json` を書かない。(4) **結果の一意**: 公開される `result.json` は 1 つだけで、生死を誤判定する場合を含めて成り立つ（両者が同じ名前へ link で公開し、負けた側は既にある結果を返す）。(4b) **受け取った結果**: 受け取った結果が仮の結果（`provisional: true`）でないなら、それは公開された `result.json` と一致する。仮の結果は、あとで公開された結果と食い違ってよい（依頼者の決定: 公開された結果を正とする）。(4c) 仮の結果は、`records.unsaved` に `result` を持ち、状態が `停止` である。(5) 公開された結果は、それを登録した台帳を `records.ledger_refs` に持つ（台帳 → 結果の順）。(6) `完了` が `status.json` か標準出力に出るのは、`result.json` の公開と再読込の照合に通ったときだけ（`run-literal-publish-CompleteOnlyIf`）。(7) **生死を判定できる間は**、crash の後も、salvage か `start` が結果を返す。生死を判定できない状態が続けば、司令塔は `LIVENESS_UNKNOWN_MAX` 回の後に結果を作らずに終わる（限界。`lock-termination-unconditional` はこの読みで成り立つ）。(8) 受け箱は書き終えた内容でだけ見え、1 batch に 1 つだけ公開される。(9) 見える `salvage.mark` は常に識別を持つ。(10) 保存の失敗の組合せのどれでも、返した結果の `records.saved` に、保存していない記録が載らない | TLA+・TLC（`Lock.tla` を作り直す） | `run-daemon` 1、`start` 1、client 2、salvage 2、crash 1 回、pid の再利用 1 回、生死の誤判定（生きている保持者を死んだと判定する）を非決定で起こす。非決定の出来事: `run-daemon` の起動の失敗、rename の前後の crash、遅い `run-daemon`、`run-daemon` の書込みの途中、結果の公開と `state.json` の間の crash、勝者の台帳と公開の間の salvage の到着と crash、受け箱の書込みの途中の crash、`salvage.mark` の書込みの途中の crash、台帳の公開の失敗、結果の公開の失敗（I/O）と負け、`status.json` の書込みの失敗、生死を判定できない状態の継続。結果の内容は、保存済みの範囲の関数として抽象化する。変異: 結果を 2 つの名前に公開する（前の稿）、負けた側が自分の結果を返す、公開の前に `完了` を返す、台帳の公開に失敗しても結果を公開する、`salvage.mark` を排他作成してから書く、保持者の生死を見ない、生死を pid だけで判定する。どれも反例が出ることを確かめる |
| ホストの時間の上限と process の回収 | (1) 前景の呼出しは `CALL_MAX_MS` 以内に返る。(2) 前景の client が殺されても、状態は変わらない。(3) `run-daemon` が殺されても、salvage の後に道具の process が残らない | 結合（実際の process を kill する）。定数の関係（`CALL_MAX_MS` + `CALL_MARGIN_MS` ≤ 司令塔が指定するホストの timeout ≤ 600000ms、`CLEANUP_BUDGET_MS` < `CALL_MAX_MS`、`WAIT_POLL_MS` < `CALL_MAX_MS`）は `schemas.mjs` の unit で検査する | Linux と macOS。子 process が自分で別の group へ移る場合は対象外（設計の限界）。Codex のコマンドの上限は確かめていない |
| 判定の規則 | オラクルとの一致 | Z3（[判定のオラクル照合](#判定のオラクル照合)） | 照合 3 の範囲 |
| 同時に動かす数 | 同時に動く道具の実行の数が、内部で決めた数（実行環境の CPU の数と互いに依存しない実行の数の小さい方）を超えない。依存先の終わっていない実行を始めない | 状態の全数列挙（unit。実行の数・依存の小さな全ての組） | 内部の選択の検査で、仕様の受入条件ではない |
| 依存グラフと合成の照合 | 同じグラフ・基準で同じ候補。分割前の全ての要素が、対応か除外に入る | 性質ベースのテスト（無作為の小さなモデル。T の独立の導出と比べる） | 無作為の範囲の外は未検証 |

**旧 `Lock.tla` が見つけた種類の欠陥を、今回どう防ぐか**

旧版では、モデルが正しい手順（番号付きの lock）を検査していた一方、実装は欠陥のある手順（1 つの path の lock を消す）のままだった。モデルの成功が実装の正しさとして読まれた。

今回は次の 3 つで防ぐ。

1. **手順そのものを減らす**（設計）
   - lock を消すのは作った process だけで、奪う・外す手順を持たない。
   - 回収の手順は状態を書かない。
   - 守る規則が小さいほど、モデルと実装の食い違いが入る場所も小さい。
2. **実装の構造を検査する**（unit。T が作る）
   - 対象は `cli-contract.md` に書く構造の契約である。契約の内容は「`run.lock` を消す呼出しは `scripts/lib/store.mjs` の `releaseOwnLock` だけで、nonce の照合の後にだけ消す」。
   - T はこの契約だけを受け取ってソースの走査を書く。実装のコードは渡されない。
   - 確かめること: lock の path を消す呼出しがこの 1 関数にだけあること。その関数が nonce の照合の後にだけ消すこと。
   - 失敗のときは、違反箇所と直し方を返す。
3. **実装を相手にした並行テスト**（結合）
   - `run-daemon` を lock を握ったまま kill する。確かめること:
     - client の `wait` が `E_STALE` を返し、`submit` が受け箱の外を書かないこと
     - `state.json` が最後に rename された内容のままであること
     - run の領域を作る途中（rename の前）で kill した場合に、最終の名前の run の領域が現れないこと
   - salvage の規則を順に確かめる:
     - 保持者が生きていれば `E_BUSY` と役 `run-daemon` を返し、何も書かないこと。司令塔の手順が `wait` に戻ること（eval）
     - 公開済みの `result.json` があり、指紋が `ledger.json` の `registered_result_hash` と一致すれば、`state.json` によらずそれを返すこと（結果の公開の直後、`state.json` の前に `run-daemon` を kill して確かめる）
     - 既にある記録の指紋が同じなら公開を成功とみなし、違えば失敗とすること
     - `status.json` が `terminal` で `result.json` が無い（台帳は保存できたが結果を保存できなかった）とき、salvage がその結果を返し、`result.json` を作らないこと
     - 追補台帳の公開が「既にあって指紋が違う」で失敗したとき、`result.json` があればそれを返し、無ければ「台帳が失敗」の行のとおりになること
     - `ps` を使えない環境（`PATH` から `ps` を除く）で、`wait` と salvage が `liveness: "unknown"` を返し、司令塔の手順が `LIVENESS_UNKNOWN_MAX` 回の後に終わること（eval）
     - salvage を 2 回、並行に呼んで、勝者が生きている間は他方が `E_BUSY`（役 `salvage`）を返すこと。最後に `result.json` が 1 つで、どの呼出しも同じ内容の結果を返すこと
     - 勝者を台帳の後・公開の前で kill した場合に、次の salvage が同じ内容の台帳と結果を作り、公開すること（内容の指紋が、勝者が作るはずだったものと一致すること）
     - 結果に時刻・pid・nonce が入っていないこと
     - 結果の公開が失敗した R' が `provisional: true` で、`records.unsaved` に `result` を持ち、状態が `停止` であること。公開された `result.json` は常に `provisional: false` であること。仮の結果を返した後に、領域を書けるようにして salvage を呼ぶと、`result.json` が公開されて正の結果になること
     - 司令塔が仮の結果を受けたとき、仮であることと `run_dir` を依頼元に伝えること（eval）
     - 保存の失敗の組合せ（台帳だけ失敗、結果だけ失敗、両方失敗）を、書込み不可の path で起こす。設計の表どおりに公開の有無と `records` が決まり、台帳の公開に失敗したときに結果が公開されないこと（`run-daemon` と salvage の両方）
     - `salvage.mark` の書込みの途中で kill しても、識別の無い印が見えず、次の salvage が `E_BUSY` のまま止まらないこと
     - 公開された結果の指紋が、追補台帳に載っていること
     - 追補台帳を保存できない場合は `records.unsaved` に出ること
     - `salvage.mark` を置いた後に `run-daemon` が書込みを試みても、何も書かずに終わること（生死の判定を誤らせる偽の環境で）
   - 起動の手順: `run-daemon` の起動に失敗させる（実行体の path を壊した環境）、一時の領域の作成の後で rename の前に kill する、rename の後で最初の `status.json` の前に kill する、rename を遅らせて `CALL_MAX_MS` を超えさせる。どの場合も `start` が `status` か結果の 1 つだけを返し、結果が 2 つできないこと。`start` が自分の起動した process の `.tmp-*` だけを消すこと
   - 受け箱: `submit` の書込みの途中で kill した場合に、`inbox/<batch_id>.json` が見えないか、書き終えた内容で見えること。2 回目の `submit` が `duplicate` を返すこと。読めない受け箱（形の違う JSON を link で置く）で、その batch の項目が `未確認` になること
   - pid の再利用: lock の pid を、開始時刻の違う生きた process の pid に書き換えておく。保持者は終了しているので `E_STALE` になることを確かめる。
   - ホストに殺された場合: 実行の段の最中に、前景の client と `run-daemon` をそれぞれ kill する。client を kill しても状態が変わらないこと、`run-daemon` を kill した後の salvage で道具の process group が残らないことを、`ps` で確かめる。

**結合テストで起こせない場面**（テスト専用の口は足さない）

- 次の 2 つは、結合テストで作る口を契約に足さない。形式モデル（`Lock.tla`・`Run.tla` の非決定の出来事）と unit で覆う。
  - `start` の `E_BUSY`: `run-daemon` が rename の後、最初の `status.json` の前に落ち、かつ `salvage.mark` の勝者が生きている場合。`start` は `status.json` が現れた時点で返るので、外から時機を合わせられない。unit では、`start` の判断の関数に観測（daemon の終了、run の領域の有無、`result.json`・`status.json`・`salvage.mark` の状態、勝者の生死）を与え、`E_BUSY` と `detail.run_dir` を返すことを確かめる。
  - 台帳の公開は成功し、結果の公開だけが I/O で失敗する組: 同じ領域の 2 つのファイルの片方だけを、外から書けなくする手段が無い。unit では、公開の関数に、ファイル操作の境界の差し替え（link の I/O 失敗）を与え、R' の `records` と状態 `停止` を確かめる。
- 理由: 一時ファイルの置き場などを、テストのために契約で決めると、テストでしか使わない経路が契約に入る（`javascript.md` の「差し替えは本番でも意味のある依存の境界に置く」）。ファイル操作の差し替えは、本番でも意味のある作用の境界である。
- 起こせる場面（`salvage.mark` の I/O 失敗は run の領域を書込み不可にして作る、壊れた `status.json` はファイルを置き換えて作る）は、結合テストで確かめる。

TLA+ のモデルは実装の抽象であり、詳細化は証明しない。モデルとの対応は、上の 2 と 3 で実装の側から確かめる。README に未検証として書く。

## 要求の形式検証の作り直し

旧 `tests/formal/formal-method/`（旧要求のモデル）は削除する。新しい要求 `docs/requirements/formal-method.md` に対して、`tests/formal/formal-method-requirements/` を作る。F が作る。

| 対象 | 性質 | 手段 |
|---|---|---|
| PR-001・009・010・011・015 の完了・停止・報告の条件 | 条件どうしが矛盾しない（完了に到達できる入力がある）。停止の条件と完了の条件が重ならない。未実行・unknown・時間切れ・実行失敗・未確認のどれかが残れば完了と報告しない | Z3（要求の文ごとに名前付きの assert、`formal-method-spec` と同じ作り） |
| PR-003 の組合せの 3 区分と到達可能性 | 3 区分が閉じた集合を分割する（重ならず漏れない） | Z3 |
| PR-012 の並列の実行と完了・未完了の範囲 | 途中で止まったとき、計画した検査が完了・未完了・未実行のどれか 1 つに入る | Z3 |
| PR-004 の対応の無い項目の分類 | 対応の無い形式化できる性質は未検証になり、形式化できない性質は PR-002 の扱いになる。2 つは重ならず漏れない | Z3 |
| PR-008 の合成の条件 | 前提を確認できないか、相互の前提だけで結論を支える分割では、全体が検証済みにならない。部分の成功だけでは全体が検証済みにならない | Z3 |
| 全ての PR と SP・AC の対応 | 各 PR に SP と AC が 1 つ以上結び付き、欠番を参照しない | 決定的な検査（トレーサビリティ表の照合） |

PR-002・005〜007・014 は形式化しない。

- 理由: どれも、何を記録し区別するかという能力を述べる要求で、条件の組合せから判定や遷移を導く文を持たない。
- 例外として、PR-005 の進行性の前提と PR-002 の未確認の記録は、PR-004・010・015 の符号化の入力の事実として現れる。
- この理由を README に書き、AC での確かめに委ねる（`agent-work.md` の、対象外とする性質に理由を示す規約）。

## テストの作成役に渡すもの

テストは、仕様と契約だけを見る別の担当（T）が、実装の前に作る。契約の 2 文書は、テストに要る外から見える形と手順を自己完結して持つ。そのため、設計書は渡さない。

**渡すもの**（読む順）

| ファイル | 読む目的 |
|---|---|
| `docs/specifications/formal-method.md` | 振る舞いと受入条件（AC）の正本 |
| `docs/requirements/formal-method.md` | 要求の正本 |
| `docs/requirements/bp-designed-skill.md` の PR-028〜036・038〜040・042 | 作業記録の要求 |
| `references/cli-contract.md`（スキルの根から） | コマンド、誤り、`status.json`、起動・受け箱・生死・salvage・保存の失敗の手順、配置、構造の契約、秘密値の走査の型、Z3 の adapter、定数 |
| `references/artifact-formats.md` | 依頼・結果・終わり方・判定の 3 関数・担当の成果物と返り値・task・Workflow の返り値・作業記録・台帳の形 |
| `references/verification-plan.md`（この文書） | 層の割当て、オラクルの照合の方法、ケースの観点 |
| `tests/formal/formal-method-spec/`（`gen.py`・`questions.py`・`endstates.py`・`enum_table.txt`・`summary.txt`） | 判定のオラクル（r11、290 行版の仕様）。Z3 は環境変数 `Z3` |
| `scripts/test-fixtures/fake-z3.mjs` | 流用できる偽の z3。T が、受け取った引数の記録、応答の遅延、構文の誤り（標準出力に `(error …)`、終了コード 1）、メモリ不足（標準エラーに `(error "out of memory")`、終了コード 101）、常に成功を返す振る舞い、`-model` を受けたとき `sat`・`unknown` の後に実測の形のモデルを出す振る舞い、形に合わないモデルを出す振る舞い、`TOOL_OUTPUT_MAX_BYTES` を超えるモデルを出す振る舞いを足す |
| `scripts/test-fixtures/result-schema.mjs` | 結果の形と不変の照合。T が契約に合わせて直す: `Check.kind` に `contract`、形式化 の行は `check_ids` が空なら `reason` が非 null、`check_ids` の各欄・`Counterexample.check_id`・`detector_check_id` の `kind`、`composition_conditions[].check_ids` の空を許すこと（[成果物の形式](artifact-formats.md)の検査・分割と合成・反例と原因・plan と mutations の節） |
| `docs/guidelines/documentation.md` と、同梱の写し `references/document-rules.md` の path | 一致の検査を T が書く（写しは A が作る） |
| `docs/guidelines/testing.md`、`docs/guidelines/javascript.md`、`docs/guidelines/agent-work.md` | テストの規約 |

**渡さないもの**

- 設計書 `references/architecture.md`（内部の選択の理由と退けた案を含む）
- 実装のコード（新旧とも）と旧版のテスト（`formal-method-cli.test.mjs`・`lib.test.mjs`・`harness.mjs`）
- 旧実装の棚卸しの表、旧版の契約の 2 文書

理由: 実装やその理由を読むと、テストの期待値が実装の判断に寄り、実装と同じ誤りを期待値に持ち込む（`testing.md`「期待値は仕様から決め、検査対象の処理で作らない」）。

**T が作るもの**

- AC ごとのケース計画（観点ごとの適用・不適用と理由）
- 単体・結合のテスト（`scripts/**/*.test.mjs`、`tests/formal/formal-method-skill/*.test.mjs`）と、担当の代わりの harness（`scripts/test-fixtures/`）
- `evals/evals.json`（AC-01・02・04・06・08 の意味の部分、司令塔が判定を足さないこと、発火の境界）
- 構造の契約の走査（`run.lock` を消すのは `releaseOwnLock` だけ）
- 同梱の規約と正本の一致の検査
- 次のケース（契約の変更で増えたもの）: `start` が `run-daemon` の生きている間に返り、`run-daemon` の出力が `start` の標準出力に混ざらないこと。形式化 の行で `check_ids` が空で `reason` を持つ結果（判定が `未確認`、SP-007 なら `未実行`）。契約の検査が `stop_report.checks_*` と `performance.executions` に `kind: contract` で出ること。mutation と replay の `-T` が元の検査の値であること。`-model` の下での `unknown`（モデルが続いても `unknown`）と、上限を超えるモデル（判定は `反例` のまま、replay は `確認できず`、切り詰めが `Check.reason` に出る）。答えの後のモデルを読んでいる間に期限が来た実行が、答えで判定され `stopped_by: null` になること。`(check-sat)` が最後の input の最後の form でない計画（変異を含む）が計画の欠陥になること。`selection` の `chosen.tool` が `z3` でない性質と、計画作成役が返らない run で、性質の判定が `未実行`・`未確認` に正しく分かれること
- `tests/formal/formal-method-skill/z3_streams.py` の実測の場合に、`-model` を渡した `sat`・`unsat`・`unknown`・`timeout` と、`(check-sat)` の後の誤った form を足す（F が測り、契約の表と照らす）

**T が返すもの**

- 上の成果物と、読めなかった参照
- 仕様と契約が期待値を一意に決めない点の一覧。T は推測で決めず、依頼者に返す

## 依頼者の決定と残る論点

依頼者の決定（前の稿の確認事項 1〜7 への答え）は次のとおりで、設計と本計画に反映した。

1. 失敗した検査を同じ run の中で再試行しない。反例の再実行は別の確認として残す。
2. （取り消し）メモリの守り方。依頼者が要求と仕様から CPU とメモリの上限に関わる規定を外したので、守る仕組みを全て除いた。
3. 規約は同梱する。正本は `docs/guidelines/documentation.md` とし、同梱の写しとの一致を `make test` で検査する。作業ツリーにあれば優先する経路は持たない。
4. オラクルの Z3 のパスは環境から読むよう直す。行番号の名前は直さず、対応表で足りる。旧い版との意味の違いが見つかったら報告する。
5. 未 commit の CI の job は、新しいモデルの入口に付け替えるまで外す。
6. 初回とキャッシュの区別は持たない。要求・仕様から外した。
7. （取り消し）メモリの枠で止めた検査の扱い。上の 2 と同じ理由で除いた。

**残る論点**（依頼者に聞く）

- **Codex**: 配布先は、今は Claude Code だけである（依頼者の決定）。Codex での動作は未検証として記録し、公開のときに実測して扱いを決める。
- **session の終了の後**: Claude Code でも、session やアプリの終了の後に `run-daemon` が生きるかは確かめていない。終了で殺される場合は、`wait` が `E_STALE` を観測し、salvage が保存済みの範囲で結果を作る（設計の範囲内の振る舞い）。
- **Linux での実測**: Z3 の出力の流れと終了コード、detach の振る舞いは、Linux では未測定である。
