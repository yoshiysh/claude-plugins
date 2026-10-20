# 仕様書: 対象スキルが備える性質の判定基準と、対象スキルに課す確定値

本書は `docs/requirements/bp-designed-skill.md` の要求を実現する判定基準と、設計方針文書（`docs/design/skill-design-patterns.md`）が「（暫定）」とした値を確定した値を定める。表記規約と要求側の用語は `docs/requirements/bp-operations.md` に従う。複数の仕様書で使う語（起動数など）は `docs/specifications/bp-run.md` の用語定義を正とする。

## 対象範囲

- 主担当: PR-BPDESIGNEDSKILL-001〜023 の 23 件。このうち 016・017・019〜023 は、`docs/specifications/bp-run.md` と `docs/specifications/bp-entry.md` が best-practices 自身に当てたものとして併せて実現する。
- 併せて実現: PR-BPOPERATIONS-003・007・008・011・024・025。この 6 件の主担当は、`docs/specifications/bp-authoring.md`・`bp-inspection.md` が持つ。本書は対象スキルの判定基準と値だけを受け持つ。
- 本書の判定基準を当てる者は 2 つある。create・update の検証役（PR-BPOPERATIONS-008）と、review のフローの観点（PR-BPOPERATIONS-024）である。review の仕様の観点（PR-BPOPERATIONS-025）は、「性能・容量（対象スキルに課す確定値）」の章に照らす。
- 本書が扱わないもの:
  - 判定の結果を指摘・資産台帳にする方法（`docs/specifications/bp-findings.md`）
  - 停止の種類・状態・next_args・CLI（`docs/specifications/bp-run.md`）
  - best-practices 自身の callsite（`docs/specifications/bp-entry.md`）
  - create・update の手順（`docs/specifications/bp-authoring.md`）

## 用語定義

| 用語 | 意味 |
|---|---|
| 問い A・Q1・Q2・Q3 | 設計方針文書「形の判定」の図の問いの名前。A は人間の入力が要るところを run の境界にできるか、Q1 は段と段の間に結果による戻りが無いか、Q2 は試すものの集合が事前に決まり結果で増減しないか、Q3 は探索グラフの適用条件を満たすか、を問う |
| 判定の単位 | 判定基準を 1 回当てる単位。設計方針文書の節の原則の表の 1 行か、本書の 1 つの仕様項目を指す |
| 判定の結果 | 判定の単位ごとに付ける、適合・不適合・対象外・未検査のどれか 1 つ。対象外は、適用の判定表（SP-BPCONFORMANCE-003）でその単位が当たらないことを指す。未検査は、判定できなかったか、本書が判定を保留させたことを指す |
| 重い形 | 固定集合の反復型と探索グラフ型。どちらも形の判定の図で、問い Q1（段と段の間に結果による戻りが無い）に「いいえ」と答えて初めて到達する形である |
| 起動数の上限 | PR-BPDESIGNEDSKILL-016 が定める、対象スキルが入力として受け取る起動数の上限 |
| 予約分 | 起動数の上限を渡された run で、未着手の項目を状態に書いて止まるのに要る呼び出しのために、上限の中に残しておく起動数（SP-BPCONFORMANCE-022。内訳は TBD-SBPCONFORMANCE-004） |

## 機能仕様

### 判定の当て方

#### SP-BPCONFORMANCE-001 判定基準の正本
create・update の検証役と review のフローの観点は、対象スキルに本書の判定基準を当てなければならない。`docs/specifications/bp-authoring.md` と `docs/specifications/bp-inspection.md` は本書の判定基準を ID で参照し、書き写してはならない（同じ基準が 2 箇所にあると、片方だけが直る）。

#### SP-BPCONFORMANCE-002 判定の単位
設計方針文書の節を参照する要求（PR-BPDESIGNEDSKILL-006〜013）について、判定する者は、参照する節の原則の表の各行を 1 つの判定の単位としなければならない。そのうえで、行ごとに判定の結果を付けなければならない。本書は行の中身を書き写さない。判定の単位を示す値の形は `docs/specifications/bp-findings.md` の TBD-SBPFINDINGS-001 で決める。

#### SP-BPCONFORMANCE-003 適用の判定表
判定する者は、下の判定表で、対象スキルに当たる要求を決めなければならない。表の結果の列の番号は、PR-BPDESIGNEDSKILL- を略した要求番号である（例: 003 は PR-BPDESIGNEDSKILL-003）。条件の「形」は、対象スキルのフローに SP-BPCONFORMANCE-004 の順で問いを当てて得る形である（対象スキルが選んだと称する形ではない）。「資産台帳」と「fan-out」は、対象スキルが実際に持つかどうかである。PR-BPDESIGNEDSKILL-001・002・006・014・015 はどの行でも当たる。それ以外で結果の列に無い要求は対象外とし、その判定の単位には「対象外」を付ける。

> 条件の値: 形 = 固定パイプライン型 / 固定集合の反復型 / 探索グラフ型 / ターンごとの指揮
> 条件の値: 資産台帳 = 有 / 無
> 条件の値: fan-out = 有 / 無

| 条件: 形 | 条件: 資産台帳 | 条件: fan-out | 結果 |
|---|---|---|---|
| ターンごとの指揮 | 無 | 無 | 003 が当たる |
| ターンごとの指揮 | 無 | 有 | 003 が当たり、不適合とする（fan-out は Workflow script の段なので、script を持っている） |
| ターンごとの指揮 | 有 | * | 003・018 が当たり、018 を不適合とする（形の判定の図は、ターンごとの指揮から資産台帳の問いへ進まない） |
| 固定パイプライン型 | 無 | 無 | 004・005・007〜010・018 が当たる |
| 固定パイプライン型 | 無 | 有 | 004・005・007〜010・016〜023 が当たる |
| 固定パイプライン型 | 有 | 無 | 004・005・007〜010・012・013・018 が当たり、018 を不適合とする（SP-BPCONFORMANCE-009） |
| 固定パイプライン型 | 有 | 有 | 004・005・007〜010・012・013・016〜023 が当たる |
| 固定集合の反復型 | 無 | 無 | 004・005・007〜010・018 が当たる |
| 固定集合の反復型 | 無 | 有 | 004・005・007〜010・016〜023 が当たる |
| 固定集合の反復型 | 有 | 無 | 004・005・007〜010・012・013・018 が当たり、018 を不適合とする（SP-BPCONFORMANCE-009） |
| 固定集合の反復型 | 有 | 有 | 004・005・007〜010・012・013・016〜023 が当たる |
| 探索グラフ型 | 無 | 無 | 004・005・007〜012・018 が当たる（意図を fan-out しないので、011 の判定で「探索グラフ」の節の、意図ごとに `pipeline()` の 1 item として流す行が不適合になる） |
| 探索グラフ型 | 無 | 有 | 004・005・007〜012・016〜023 が当たる |
| 探索グラフ型 | 有 | 無 | 004・005・007〜013・018 が当たり、018 を不適合とする（SP-BPCONFORMANCE-009）。011 の判定は上の行と同じ |
| 探索グラフ型 | 有 | 有 | 004・005・007〜013・016〜023 が当たる |

### 形の判定

#### SP-BPCONFORMANCE-004 形の判定の順序
create・update は、設計方針文書「形の判定」の図の問いを、A・Q1・Q2・Q3 の順に 1 つずつ答え、最初に到達した形を対象スキルの形にしなければならない。答えた問いを飛ばしてはならない。

review のフローの観点の判定する者は、対象スキルのフローから同じ順に問いへ答える。そのうえで、最初に到達する形と対象スキルの形が食い違えば、PR-BPDESIGNEDSKILL-001 を不適合としなければならない。たとえば、Q1 に「はい」と答えられるフローで固定集合の反復型を選んでいれば不適合である。

#### SP-BPCONFORMANCE-005 探索グラフの適用条件
問い Q3 では、設計方針文書「探索グラフ」の節の適用条件 4 つが全て満たされるときだけ「はい」と答えなければならない。1 体の agent が 1 回の実行で解ける課題は、4 つの条件を問う前に「いいえ」としなければならない（1 回で解けるなら、スキルの形にする理由が無い）。

#### SP-BPCONFORMANCE-006 重い形を強いた条件の記録
対象スキルの形が重い形のとき、対象スキルの設計の説明は、問い Q1 以降の各問いへの答えを、到達した形まで全て載せなければならない。各答えには、その答えを強いたフローの事実（どの段の結果がどの段への戻りを要するか、試すものの集合が何で変わるか）を 1 文以上添える。答えだけで事実の無い記録は、PR-BPDESIGNEDSKILL-002 を不適合とする。

ターンごとの指揮が重い形に当たるかは、形の判定の図から決まらない（TBD-SBPCONFORMANCE-002）。この裁定が下るまで、判定する者は、ターンごとの指揮の対象スキルの PR-BPDESIGNEDSKILL-002 を「未検査」としなければならない。適合とも不適合ともしてはならない。

#### SP-BPCONFORMANCE-007 Workflow にしない判定
形がターンごとの指揮のとき、対象スキルは、自分の plugin の workflow script も、スキルのディレクトリの中の Workflow script も持ってはならない。SKILL.md に `Workflow(` の callsite を持ってもならない。どちらかがあれば、PR-BPDESIGNEDSKILL-003 を不適合とする。

#### SP-BPCONFORMANCE-008 部品による組み立て
Workflow script を持つ対象スキルの各段は、設計方針文書「形の判定」の節の部品の例のどれか、または「部品」の定義（1 つ以上の段からなり、段と段の間に戻りの無い定型の並び）に合う並びでなければならない。対象スキルの設計の説明は、段ごとに使った部品の名前を載せなければならない。部品の例に無い並びを使うときは、それが部品の定義に合う理由を 1 文添える。

### 資産台帳

#### SP-BPCONFORMANCE-009 資産台帳の要否
判定する者は、設計方針文書「資産台帳」の節の適用条件で、資産台帳の要否を決めなければならない。適用条件は、fan-out した結果について、どこまで見たかを宣言する必要があるときである。fan-out を持たない対象スキルは、適用条件を満たさないとして扱う。

- 適用条件を満たす対象スキルが資産台帳を持たなければ、PR-BPDESIGNEDSKILL-005 を不適合とする。
- 満たさない対象スキルが資産台帳を持てば、PR-BPDESIGNEDSKILL-018 を不適合とする。

### 形に関わる原則

#### SP-BPCONFORMANCE-010 目標の固定
対象スキルは、入口で、設計方針文書「目標の固定」の節の原則の表の全ての行に適合しなければならない。判定の単位は SP-BPCONFORMANCE-002 に従う。create が依頼文から目標を固定するとき（PR-BPOPERATIONS-003）も、同じ行を判定の単位とする。

#### SP-BPCONFORMANCE-011 停止・再開と人間の入力
Workflow script を持つ対象スキルは、設計方針文書「停止・再開と人間の入力」の節の原則の表の全ての行に適合しなければならない。

#### SP-BPCONFORMANCE-012 体数と同時実行
Workflow script を持つ対象スキルは、設計方針文書「体数と同時実行」の節の原則の表の全ての行に適合しなければならない。同時実行の行は、SP-BPCONFORMANCE-027 の値で判定する。

#### SP-BPCONFORMANCE-013 モデル・effort・prompt
Workflow script を持つ対象スキルは、設計方針文書「モデル・effort・prompt」の節の原則の表の全ての行に適合しなければならない。役ごとのモデルと effort は、SP-BPCONFORMANCE-035 で判定する。

#### SP-BPCONFORMANCE-014 権限
Workflow script を持つ対象スキルは、設計方針文書「権限」の節の原則の表の全ての行に適合しなければならない。表の最後の行（役ごとの制限が配布先で効くかの確認）は、SP-BPCONFORMANCE-019・020 で判定する。

#### SP-BPCONFORMANCE-015 探索グラフ
探索グラフ型の対象スキルは、設計方針文書「探索グラフ」の節の、計画役・実行役・回収役・検証役・停止の各表の全ての行に適合しなければならない。検証方式の表もこれに含む。

- 上限と回数の行は、SP-BPCONFORMANCE-030〜032 の値で判定する。
- 実行役の時間の上限の行は、SP-BPCONFORMANCE-034 に従う。

#### SP-BPCONFORMANCE-016 状態の書き込み
探索グラフか資産台帳を備える対象スキルは、設計方針文書「状態の書き込み」の節の原則の表の全ての行に適合しなければならない。要約の大きさの上限の行は、SP-BPCONFORMANCE-033 の値で判定する。

#### SP-BPCONFORMANCE-017 資産台帳の原則
資産台帳を備える対象スキルは、設計方針文書「資産台帳」の節の原則の表の全ての行と、同節の定義の箇条書きに適合しなければならない。指摘の ID・状態・skip 一覧の形は、`docs/specifications/bp-findings.md` を正とする。

#### SP-BPCONFORMANCE-018 判定の範囲と結果の宣言
判定する者は、当たる要求（SP-BPCONFORMANCE-003）の判定の単位の全てに、判定の結果を付けなければならない。判定の結果を付けない単位を残してはならない。判定できなかった単位には、理由を付けて「未検査」を付ける（付けないと、判定していない単位が適合と読まれる）。

付けた判定の結果を返り値のどこに載せるかは、機能ごとに次のとおりとする。

- create・update は、全ての単位の結果を載せる（`docs/specifications/bp-authoring.md` の SP-BPAUTHORING-032 の「判定の単位ごとの結果」。合否がこの結果で決まるため）。
- review は、不適合を指摘として（`docs/specifications/bp-inspection.md` の SP-BPINSPECTION-007）、未検査を未検査の観点として（SP-BPINSPECTION-025）載せ、適合と対象外は単位ごとには載せない。対象外は、返り値の適用の判定（SP-BPINSPECTION-024）と本書の適用の判定表から決まる。それ以外の単位で、open の指摘も未検査の観点も無いものは適合と読む。

### 配布先での確認

#### SP-BPCONFORMANCE-019 役ごとの制限の確かめ方
create・update は、対象スキルの役ごとの制限について、配布先ごとに次のとおり確かめなければならない。役ごとの制限には、agent の定義の道具の許可・モデル・権限の指定を含む。

| 配布先 | 確かめ方 | 確かめられなかった制限 |
|---|---|---|
| Claude Code | 確かめない。plugin から読み込む agent で無視される設定の一覧は Claude Code 公式 docs「Create custom subagents」にあり、判定基準の写し（`docs/specifications/bp-run.md` の SP-BPRUN-036）に入る文書が一覧を持たない間は、PR-BPDESIGNEDSKILL-014 の判定の単位（設計方針文書「権限」の表の最後の行を含む）を「未検査」とし、適合とも不適合ともしてはならない（TBD-SBPCONFORMANCE-005。create・update の合否を妨げない：`docs/specifications/bp-authoring.md` の用語「強いられた未検査」） | 役ごとの制限の全て |
| Codex runner | 確かめない。runner は agent ごとの道具の許可を持たず、権限は全ての呼び出しに一律に効く（`plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/README.md` の Codex SDK backend と workspace の節） | 役ごとの制限の全て |

#### SP-BPCONFORMANCE-020 確かめられなかった制限の報告
SP-BPCONFORMANCE-019 で確かめられなかった制限ごとに、create・update は「残る危険」として結果に載せなければならない。載せる項目は、役の名前・制限の中身・配布先・確かめられなかった理由の 4 つである。結果の中のどこに載せるかは、`docs/specifications/bp-authoring.md` の完了時の出力を正とする。

### fan-out の起動数の上限

本節は、Workflow script が fan-out を含む対象スキルに当たる（SP-BPCONFORMANCE-003）。上限が要る理由は Codex runner にある。runner の `limits.maxAgents` は 1 run の agent 呼び出しの総数の上限で、既定は 2 である。超えると run 全体が失敗し、agent の失敗を catch しても避けられない（`plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/README.md` の Contract・Explicit live execution の節）。

#### SP-BPCONFORMANCE-021 起動数の上限の受け取り
対象スキルの Workflow script は、起動数の上限を、省略できる入力（`args` の 1 項目）として受け取らなければならない。値は 1 以上の整数とする。項目の綴りは対象スキルが決め、SKILL.md の Workflow callsite の契約に書かなければならない。項目が無いときは、上限を渡されなかったものとして扱う。

#### SP-BPCONFORMANCE-022 上限を渡された run の起動数
起動数の上限を渡された run で、script は、項目を、最後まで走らせても上限を超えないと確かめられるときだけ始めなければならない（項目は同時に走る（SP-BPCONFORMANCE-027）ので、呼び終えた数だけで確かめると、同時に始めた項目どうしの残りの呼び出しが合わさって上限を超える）。項目の処理の外で呼ぶ役（計画役・集約・完了の照合など）も、呼ぶ前に同じく確かめる。確かめは、script が定数から決定的に行う。

止まるのに要る記録の呼び出し（予約分）は上限の中に必ず残し、その呼び出し自体を確かめで締め出してはならない。確かめの具体の式（最悪の回数の和の項と、予約分の内訳）は TBD-SBPCONFORMANCE-004 で決める。この裁定が下るまで、判定する者は、上の 2 つの規則だけを判定し、式の形で適合・不適合を分けてはならない。best-practices 自身の確かめ（`docs/specifications/bp-run.md` の SP-BPRUN-020）も本項に従う。

#### SP-BPCONFORMANCE-023 上限に収まらない項目
SP-BPCONFORMANCE-022 で始められない項目が 1 件以上残ったとき、script は新しい項目を始めてはならない。そのうえで、始めた項目が終わるのを待ち、次の 2 つを状態に書いて止まらなければならない。

- 残った項目の全てを、順位を付けた未着手として書く。
- 止まった理由に、上限・その時点の起動数・残った件数を含める。

状態への書き込みは、設計方針文書「状態の書き込み」の節の原則（CLI だけが書き、運搬役が呼ぶ）に従う。残った項目を切り捨ててはならない。

順位の付け方は次のとおり。

- 探索グラフ型では、計画役が最後に付けた順位を使う。
- それ以外の形では、script が項目を起動する予定だった順を使う。

止まるときの停止の種類と理由の書き方は `docs/specifications/bp-run.md` の SP-BPRUN-035 を、next_args に載せるものは同文書を正とする。上限が予約分と 1 件目の項目の最悪の回数の和より小さく、1 件も始められないときは、本項ではなく同文書の SP-BPRUN-037 に従う。理由には、上限が 1 件の項目にも足りないことを書く。何も処理しないまま、上限に達した通常の停止と見分けのつかない形で止まってはならない。

#### SP-BPCONFORMANCE-024 残した項目からの再開
SP-BPCONFORMANCE-023 で止まった run から再開した run は、`docs/specifications/bp-run.md` の SP-BPRUN-035 の手順に従わなければならない。反すれば PR-BPDESIGNEDSKILL-020 を不適合とする。

#### SP-BPCONFORMANCE-025 上限を渡されない run
起動数の上限を渡されない run で、対象スキルは、fan-out の項目の件数にも 1 run の起動数にも上限を置いてはならない。

次のものは、項目の件数や起動数の上限ではない。

- 同時実行の上限（SP-BPCONFORMANCE-027）は、同時に走る数を限るだけで、残りを待たせる。
- 反復の上限・周の上限・試行の上限・until-pass の繰り返しの上限（SP-BPCONFORMANCE-028〜031）は、反復の回数を限る。
- 計画役の prompt に書く意図の件数の目安は、上限ではない（設計方針文書「計画役」の表）。

本項に反するのは、項目の一覧を固定の件数で切ることと、起動数が固定の数に達したら止めることの 2 つである。

#### SP-BPCONFORMANCE-026 callsite の経路と上限の受け渡し
対象スキルの SKILL.md の Workflow callsite について、判定する者は次を確かめなければならない。

- Codex runner の経路では、起動数の上限を渡す。渡す値は、その run の host の request の `limits.maxAgents` 以下でなければならない（`limits.maxAgents` を超える値を渡すと、上限に収めても runner に run 全体を失敗させられる）。
- Claude Code の native Workflow の経路では、起動数の上限を渡さない。

どちらかに反すれば、Codex runner の経路なら PR-BPDESIGNEDSKILL-022 を、native Workflow の経路なら PR-BPDESIGNEDSKILL-023 を不適合とする。経路の選び方（native-first の契約）は `docs/specifications/bp-entry.md` を正とする。

## 性能・容量（対象スキルに課す確定値）

本章の値は、設計方針文書が「（暫定）」とした値と規則を確定したものである。review の仕様の観点（PR-BPOPERATIONS-025）はこの章に照らす。best-practices 自身の実行も同じ値に従う（役ごとのモデルと effort は SP-BPCONFORMANCE-035 の best-practices の表に従う）。`docs/specifications/bp-run.md` は本章の SP ID を参照し、値を書き写さない。

#### SP-BPCONFORMANCE-027 同時実行の上限
対象スキルの Workflow script で同時に走る agent は、3 体以下でなければならない（設計方針文書「体数と同時実行」の表の初期値）。残りは枠が空くまで待たせ、切り捨ててはならない。守らせ方（runtime の設定か script か）は TBD-SBPCONFORMANCE-003 で決める（Claude Code で、利用者の環境変数のほかにスキルから同時実行の上限を設定できるかが入力から決まらず、設計方針文書「体数と同時実行」の表も実装で決めるとしている）。この裁定が下るまで、判定する者は同時に走る数だけを判定し、守らせ方が runtime の設定か script かで適合・不適合を分けてはならない。

#### SP-BPCONFORMANCE-028 until-pass の繰り返しの上限
項目ごとの until-pass の部品で、1 項目の工程を繰り返す回数は、最初の 1 回を含めて 3 回以下でなければならない（設計方針文書「停止」の表が引く、同じ課題の自動の続行は 2〜3 回まで、の上端）。最初の 1 回を含めて数えるのは本書の決定である。出所は最初の 1 回を含むかを定めておらず、含めて数えれば、続行を最初の後の回数と読んでも全体の回数と読んでも 3 を超えない。本書の「最初の 1 回を含めて 3 回以下」は全てこの数え方による。3 回目で通らなければ、その項目の結果として、通らなかったことと理由を返す。

#### SP-BPCONFORMANCE-029 固定集合の反復型の反復の上限
固定集合の反復型で、段の並びを回す回数は、最初の 1 回を含めて 3 回以下でなければならない（出所は SP-BPCONFORMANCE-028 と同じ）。create・update の書き直し（PR-BPOPERATIONS-011）もこの値に従う。値を書き直しにどう当てるかは `docs/specifications/bp-authoring.md` を正とする。

#### SP-BPCONFORMANCE-030 探索グラフの周の上限
探索グラフ型で、1 run の周は 5 周以下でなければならない（依頼者の裁定）。5 周目の終わりで完了していなければ、反復の上限で止まる。

#### SP-BPCONFORMANCE-031 同じ意図の試行の上限
探索グラフ型での同じ意図の試行と、それ以外の形で fan-out の項目の工程が結果を返さなかったときに同じ項目を起動し直す試行は、どちらも最初の 1 回を含めて 3 回以下でなければならない（出所は SP-BPCONFORMANCE-028 と同じ。どちらも 1 つの課題を自動で続行する回数に当たる）。3 回とも工程の欠けになった意図・項目は打ち切る。best-practices 自身の項目への当て方は `docs/specifications/bp-run.md` の SP-BPRUN-028 を正とする。試行の回数は run の外の状態に持ち、再開しても数え直してはならない。

#### SP-BPCONFORMANCE-032 乾きの定義と乾き停止
乾きは、設計方針文書「用語」の節の「乾き」の定義を、本書の確定した定義として採る。乾き停止の K は 2 とする（K ≥ 2 の最小。設計方針文書「停止」の表の docs の例と同じ）。2 周連続の乾きで、読まれていないヒントが無いときに乾きで止まる。同じ方向の再確認の意図（設計方針文書「計画役」の表の「見つからなかった」の行）は、1 つの方向につき 1 回までとする（K = 2 の 2 周の間に再確認が 1 回収まる）。

#### SP-BPCONFORMANCE-033 要約の大きさの上限
CLI が作る状態の要約は、8,000 字以下でなければならない（依頼者の裁定。トークン数はモデルで変わるので字数で置く）。字数は CLI が決定的に数える。載せなかったものは、件数と種類を要約の中で宣言する。

#### SP-BPCONFORMANCE-034 実行役の時間の上限
探索グラフ型の実行役の時間の上限は、値も守らせ方も決まっていない（TBD-SBPCONFORMANCE-001）。この裁定が下るまで、判定する者は、設計方針文書「実行役・回収役・検証役」の表の「実行役の時間に上限を置く」の行を「未検査」としなければならない。適合とも不適合ともしてはならない。また create・update は、実行役の時間の上限の値を対象スキルに書き込んではならない。

#### SP-BPCONFORMANCE-035 役ごとのモデルと effort の初期値
対象スキルの Workflow script は、全ての `agent()` 呼び出しで `model` と `effort` を指定しなければならない（省略すると、セッションのモデルを体数分継承する）。値は、設計方針文書「モデル・effort・prompt」の節の役ごとの表の「初期値」の列に従う。本書はこの列を確定した初期値として採る。対象スキルが表に無い役を持つときは、表のどの役の性質に当たるかを設計の説明に書き、その役の値に従う。

best-practices 自身の役には、設計方針文書の役ごとの表と SP-BPCONFORMANCE-036 の「本章と違う値は不適合」に代えて、次の表を当てる（依頼者の裁定が優先する。eval で決め直す）。best-practices を対象スキルとして判定するときも、この表の値を不適合としない。`docs/specifications/bp-run.md` の SP-BPRUN-023 と `docs/specifications/bp-entry.md` の SP-BPENTRY-016 はこの表を参照し、値を書き写さない。

| best-practices の役 | `model` | `effort` |
|---|---|---|
| 書き手 | `opus` | `high` |
| 検証役 | `opus` | `high` |
| 反証役 | `opus` | `high` |
| 抽出役 | `sonnet` | `medium` |
| 運搬役 | `haiku` | `low` |

#### SP-BPCONFORMANCE-036 確定値の置き方
対象スキルは、本章の各値を、script の中の名前付きの定数 1 箇所に置かなければならない。同じ値を 2 箇所に書いてはならない。本章と違う値を使う対象スキルは、PR-BPOPERATIONS-025 の仕様の観点で不適合とする。値を変えるときは、eval で測って決め直し、本章と設計方針文書へ書き戻してから対象スキルに当てる（対象スキルごとに値を変えると、review が照らす値が 1 つに決まらない）。

## エラー処理と異常系

本書の機能に固有の異常系だけを置く。agent の失敗・続けられない失敗・途中終了は `docs/specifications/bp-run.md` を正とする。

#### SP-BPCONFORMANCE-037 起動数の上限の入力が不正なとき
起動数の上限の項目に 1 以上の整数でない値が渡されたとき、対象スキルの script は、`docs/specifications/bp-run.md` の SP-BPRUN-037 のとおり止まらなければならない。反すれば PR-BPDESIGNEDSKILL-016 を不適合とする。

#### SP-BPCONFORMANCE-038 判定の単位を判定できないとき
判定の単位に当たる記述が対象スキルに見つからず、適合とも不適合とも決められないとき、判定する者は、その単位に理由を付けて「未検査」を付けなければならない（SP-BPCONFORMANCE-018）。「適合」としてはならない。

## 検証方法

- 判定表・形の判定（SP-BPCONFORMANCE-003〜009）: 形・資産台帳の有無・fan-out の有無の組み合わせごとに、正例と負例の fixture の対象スキルを用意する。そのうえで、create・update の検証役と review が付ける判定の結果を、期待値と照らす。
- 原則の表の行（SP-BPCONFORMANCE-010〜018）: 1 行ずつ違反を仕込んだ fixture で、その行だけが不適合になり、他の行は適合のままであることを確かめる。
- 配布先での確認（SP-BPCONFORMANCE-019・020）: 無視される設定に頼る制限を持つ fixture について確かめる。Claude Code では、判定の単位が「未検査」になり、全ての制限が「残る危険」に載ることを確かめる。Codex runner では、全ての制限が載ることを確かめる。
- 起動数の上限（SP-BPCONFORMANCE-021〜026・037）: runner の mock backend で、上限と同時実行の数を変えて対象スキルを走らせる。同時実行が 2 以上で項目が重なって走る場合を必ず含める。そのうえで次を照らす。
  - 起動数の記録が、項目が重なって走る場合も上限を超えないこと
  - 残った項目が順位付きで状態に残ること
  - 再開した run が残った項目だけを処理すること
  - 上限を渡さない run が項目を切らないこと
  - 不正な入力で `agent()` が 0 回であること
- 確定値（SP-BPCONFORMANCE-027〜033・035・036）: 対象スキルの script の定数を読み、本章の値と一致するかを決定的に照合する。そのうえで、上限に達する fixture で、上限の回数で止まることを確かめる。
- 保留の項目（SP-BPCONFORMANCE-006 のターンごとの指揮、SP-BPCONFORMANCE-019 の Claude Code、SP-BPCONFORMANCE-034）: 判定の結果が「未検査」になり、適合にも不適合にもならないことを確かめる。

## TBD の宣言

本書が所属先の TBD。どれも着手を止めない（blocking: false）。保持規則は各 TBD を参照する仕様項目に置く。

| TBD ID | 決めること | 決めない理由 | blocking | 保持規則 |
|---|---|---|---|---|
| TBD-SBPCONFORMANCE-001 | 探索グラフ型の実行役の時間の上限の値と、守らせ方 | Claude Code の `agent()` に経過時間の上限を指定する手段が入力に無い（Codex runner は `agentTimeoutMs` を持つ）。当たるのは探索グラフ型の対象スキルの実行役だけで、best-practices 自身は実行役を持たない | false | SP-BPCONFORMANCE-034 |
| TBD-SBPCONFORMANCE-002 | ターンごとの指揮が重い形に当たるか | 形の判定の図では、ターンごとの指揮に問い A の「いいえ」からも、問い Q1 に「いいえ」と答えた後の問い Q3 の「いいえ」からも到達するので、重い形（Q1 に「いいえ」と答えて初めて到達する形）に当たるかが道によって変わり、図から決まらない | false | SP-BPCONFORMANCE-006 |
| TBD-SBPCONFORMANCE-003 | 同時実行の上限の守らせ方（runtime の設定か script か） | Claude Code でスキルから同時実行の上限を設定できるかが入力から決まらず（入力にあるのは利用者の環境変数だけ）、設計方針文書「体数と同時実行」の表も実装で決めるとしている。値（SP-BPCONFORMANCE-027）は決まっている | false | SP-BPCONFORMANCE-027 |
| TBD-SBPCONFORMANCE-004 | 起動数の上限の確かめの具体の式（最悪の回数の和の項、項目ごとの最悪の回数の求め方、予約分の内訳） | 式は script の段の組み方で決まり、最初の実装でテストとともに決め、本書へ書き戻す細部である（設計方針文書「水準と未決事項」） | false | SP-BPCONFORMANCE-022 |
| TBD-SBPCONFORMANCE-005 | Claude Code の plugin から読み込む agent で無視される設定の一覧を、判定基準の写しに入る文書に持つか | 一覧は Claude Code 公式 docs にあり、run の中の agent は写し（`docs/specifications/bp-run.md` の SP-BPRUN-036）の外を判定基準として当てられない | false | SP-BPCONFORMANCE-019。加えて、決まるまで、判定する者は agent の記憶や写しの外の文書で一覧を補って判定してはならない |

## トレーサビリティ表

| 要求 ID | 仕様項目 ID | 検証方法 | ステータス |
|---|---|---|---|
| PR-BPDESIGNEDSKILL-001 | SP-BPCONFORMANCE-001, SP-BPCONFORMANCE-003, SP-BPCONFORMANCE-004 | fixture（形ごとの正例・負例）で判定の結果を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-002 | SP-BPCONFORMANCE-006 | fixture（答えだけで事実の無い設計の説明）で不適合、ターンごとの指揮で未検査を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-003 | SP-BPCONFORMANCE-007 | fixture（ターンごとの指揮で script を持つもの）で不適合を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-004 | SP-BPCONFORMANCE-008 | fixture（部品名の無い段）で不適合を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-005 | SP-BPCONFORMANCE-009 | fixture（適用条件を満たすが台帳の無いもの）で不適合を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-018 | SP-BPCONFORMANCE-009 | fixture（fan-out が無いのに台帳を持つもの）で不適合を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-006 | SP-BPCONFORMANCE-002, SP-BPCONFORMANCE-010 | 原則の行ごとに違反を仕込んだ fixture | 未着手 |
| PR-BPDESIGNEDSKILL-007 | SP-BPCONFORMANCE-002, SP-BPCONFORMANCE-011 | 原則の行ごとに違反を仕込んだ fixture | 未着手 |
| PR-BPDESIGNEDSKILL-008 | SP-BPCONFORMANCE-012, SP-BPCONFORMANCE-027 | 原則の行ごとの fixture と、同時実行数の記録の照合。同時実行の上限を runtime の設定で守る fixture と script で守る fixture が、同じ判定の結果になることの照合 | 未着手 |
| PR-BPDESIGNEDSKILL-009 | SP-BPCONFORMANCE-013, SP-BPCONFORMANCE-035 | 原則の行ごとの fixture と、`agent()` の model・effort の有無の決定的照合。best-practices 自身の script の定数が SP-BPCONFORMANCE-035 の best-practices の役の表と一致することの照合 | 未着手 |
| PR-BPDESIGNEDSKILL-010 | SP-BPCONFORMANCE-014 | 原則の行ごとに違反を仕込んだ fixture | 未着手 |
| PR-BPDESIGNEDSKILL-011 | SP-BPCONFORMANCE-015, SP-BPCONFORMANCE-030, SP-BPCONFORMANCE-031, SP-BPCONFORMANCE-032, SP-BPCONFORMANCE-034 | 原則の行ごとの fixture と、上限に達する fixture での停止の照合 | 未着手 |
| PR-BPDESIGNEDSKILL-012 | SP-BPCONFORMANCE-016, SP-BPCONFORMANCE-033 | 原則の行ごとの fixture と、要約の字数の決定的照合 | 未着手 |
| PR-BPDESIGNEDSKILL-013 | SP-BPCONFORMANCE-017 | 原則の行ごとに違反を仕込んだ fixture | 未着手 |
| PR-BPDESIGNEDSKILL-014 | SP-BPCONFORMANCE-019 | 無視される設定に頼る制限を持つ fixture を配布先ごとに確かめる | 未着手 |
| PR-BPDESIGNEDSKILL-015 | SP-BPCONFORMANCE-020 | 確かめられなかった制限が 4 項目そろって結果に載ることを照合 | 未着手 |
| PR-BPDESIGNEDSKILL-016 | SP-BPCONFORMANCE-021, SP-BPCONFORMANCE-037 | mock backend で上限の有無・不正な値を渡して走らせ、不正な値で `agent()` が 0 回で BLOCKED になることを照合 | 未着手 |
| PR-BPDESIGNEDSKILL-017 | SP-BPCONFORMANCE-022 | mock backend で起動数の記録が上限を超えないことを照合 | 未着手 |
| PR-BPDESIGNEDSKILL-019 | SP-BPCONFORMANCE-023 | mock backend で、残った項目が順位付きで状態に残り、停止の種類が反復の上限で、理由に起動数の上限・その時点の起動数・件数が載ることを照合 | 未着手 |
| PR-BPDESIGNEDSKILL-020 | SP-BPCONFORMANCE-024 | mock backend で再開した run が残った項目だけを順位の順に処理し、next_args に上限が無いことを照合 | 未着手 |
| PR-BPDESIGNEDSKILL-021 | SP-BPCONFORMANCE-025 | mock backend で上限を渡さない run が項目を切らないことを照合 | 未着手 |
| PR-BPDESIGNEDSKILL-022 | SP-BPCONFORMANCE-026 | fixture の callsite で、Codex runner の経路の上限が `limits.maxAgents` 以下であることを照合 | 未着手 |
| PR-BPDESIGNEDSKILL-023 | SP-BPCONFORMANCE-026 | fixture の callsite で、native Workflow の経路が上限を渡さないことを照合 | 未着手 |
| PR-BPOPERATIONS-003 | SP-BPCONFORMANCE-010 | create の目標の固定に「目標の固定」の行を当てた判定の結果を照合 | 未着手 |
| PR-BPOPERATIONS-007 | SP-BPCONFORMANCE-005 | fixture（1 回で解ける課題）で Q3 が「いいえ」になることを照合 | 未着手 |
| PR-BPOPERATIONS-008 | SP-BPCONFORMANCE-001, SP-BPCONFORMANCE-018, SP-BPCONFORMANCE-038 | create の検証役が当たる判定の単位の全てに結果を付けることを照合 | 未着手 |
| PR-BPOPERATIONS-011 | SP-BPCONFORMANCE-029 | 書き直しが 3 回で止まることを照合 | 未着手 |
| PR-BPOPERATIONS-024 | SP-BPCONFORMANCE-001, SP-BPCONFORMANCE-002, SP-BPCONFORMANCE-003, SP-BPCONFORMANCE-018, SP-BPCONFORMANCE-038 | review のフローの観点が本書の判定の単位の全てに結果を付け、不適合が指摘、未検査が未検査の観点として返り値に載ることを照合 | 未着手 |
| PR-BPOPERATIONS-025 | SP-BPCONFORMANCE-028, SP-BPCONFORMANCE-029, SP-BPCONFORMANCE-030, SP-BPCONFORMANCE-031, SP-BPCONFORMANCE-032, SP-BPCONFORMANCE-033, SP-BPCONFORMANCE-035, SP-BPCONFORMANCE-027, SP-BPCONFORMANCE-036 | 対象スキルの定数と本章の値の決定的照合 | 未着手 |
