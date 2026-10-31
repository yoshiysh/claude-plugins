# 仕様書: 対象スキルが備える性質の判定基準と、対象スキルに課す確定値

本書は `docs/requirements/bp-designed-skill.md` の要求を実現する判定基準と、設計方針文書（`docs/design/skill-design-patterns.md`）が「（暫定）」とした値を確定した値を定める。表記規約と要求側の用語は `docs/requirements/bp-operations.md` に従う。複数の仕様書で使う語（起動数など）は `docs/specifications/bp-run.md` の用語定義を正とする。

## 対象範囲

- 本書は `####` 見出し 1 つを 1 仕様項目とする。
- 主担当: PR-BPDESIGNEDSKILL-001〜023 の 23 件と、PR-BPDESIGNEDSKILL-028〜036・038〜040・042（対象スキルの run の記録）、043・044・047（探索グラフ型の実行役の時間の上限）、048（役ごとのモデルと effort の指定）。このうち 016・017・019〜023 は、`docs/specifications/bp-run.md` と `docs/specifications/bp-entry.md` が best-practices 自身に当てたものとして併せて実現する。
- 併せて実現: PR-BPOPERATIONS-003・007・008・011・024・025 と PR-BPDESIGNEDSKILL-045・046・049・050。この 10 件の主担当は、`docs/specifications/bp-authoring.md`・`bp-inspection.md` が持つ。本書は対象スキルの判定基準と値だけを受け持つ。
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
| 重い形 | 固定集合の反復型と探索グラフ型。どちらも形の判定の図で、問い Q1（段と段の間に結果による戻りが無い）に「いいえ」と答えて初めて到達する形である。問い A・問い Q3 のどちらで着いたターンごとの指揮も含まない |
| 起動数の上限 | PR-BPDESIGNEDSKILL-016 が定める、対象スキルが入力として受け取る起動数の上限 |
| 予約分 | 起動数の上限を渡された run で、止まるときに起動しうる、状態を書く呼び出し（未着手の項目と停止の記録、停止の前に書く記録）の最大の数。上限の中に残しておく。停止の前に書く記録は、それが要る停止のときだけ起動するが、予約には常に入れる（SP-BPCONFORMANCE-022 の式の `R`） |

## 機能仕様

### 判定の当て方

#### SP-BPCONFORMANCE-001 判定基準の正本
create・update の検証役と review のフローの観点は、対象スキルに本書の判定基準を当てなければならない。`docs/specifications/bp-authoring.md` と `docs/specifications/bp-inspection.md` は本書の判定基準を ID で参照し、書き写してはならない（同じ基準が 2 箇所にあると、片方だけが直る）。

#### SP-BPCONFORMANCE-002 判定の単位
設計方針文書の節を参照する要求（PR-BPDESIGNEDSKILL-006〜013）について、判定する者は、参照する節の原則の表の各行を 1 つの判定の単位としなければならない。そのうえで、行ごとに判定の結果を付けなければならない。本書は行の中身を書き写さない。判定の単位を示す値の形は `docs/specifications/bp-findings.md` の SP-BPFINDINGS-010 に従う。

#### SP-BPCONFORMANCE-003 適用の判定表
判定する者は、下の判定表で、対象スキルに当たる要求を決めなければならない。表の結果の列の番号は、PR-BPDESIGNEDSKILL- を略した要求番号である（例: 003 は PR-BPDESIGNEDSKILL-003）。条件の「形」は、対象スキルのフローに SP-BPCONFORMANCE-004 の順で問いを当てて得る形である（対象スキルが選んだと称する形ではない）。「資産台帳」と「fan-out」は、対象スキルが実際に持つかどうかである。PR-BPDESIGNEDSKILL-001・002・006・014・015・046 と、run の記録の 028〜036・038〜040・042（SP-BPCONFORMANCE-039）はどの行でも当たる。形が固定パイプライン型・固定集合の反復型・探索グラフ型の行では、048（SP-BPCONFORMANCE-035）も当たる。それ以外で結果の列に無い要求は対象外とし、その判定の単位には「対象外」を付ける。

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
PR-BPDESIGNEDSKILL-002 の判定の単位は対象スキルに 1 つとし、判定する者は、対象スキルの run ごとの形から下の表で結果を決めなければならない。問い W で run を分けない対象スキルは run が 1 つで、その形を当てる。問い W で分けた対象スキルは、分けた各 run の形を当てる。重い形の run は、形が重い形（用語定義）の run とする。重い形の run について、対象スキルの設計の説明は、問い Q1 以降の各問いへの答えを到達した形まで全て載せ、各答えにその答えを強いたフローの事実（どの段の結果がどの段への戻りを要するか、試すものの集合が何で変わるか）を 1 文以上添える。ターンごとの指揮の run を含むことは、他の重い形の run の記録の義務を消さない。

> 条件の値: 重い形の run = 無い / 有る
> 条件の値: 重い形の run の記録 = 全ての run で答えと事実が揃う / 答えが欠けるか事実の無い答えがある run が有る

| 条件: 重い形の run | 条件: 重い形の run の記録 | 結果 |
|---|---|---|
| 無い | * | 適合（対象外にも未検査にもしない） |
| 有る | 全ての run で答えと事実が揃う | 適合 |
| 有る | 答えが欠けるか事実の無い答えがある run が有る | 不適合（理由にその run を書く） |

#### SP-BPCONFORMANCE-007 Workflow にしない判定
形がターンごとの指揮のとき、対象スキルは、自分の plugin の workflow script も、スキルのディレクトリの中の Workflow script も持ってはならない。SKILL.md に `Workflow(` の callsite を持ってもならない。どちらかがあれば、PR-BPDESIGNEDSKILL-003 を不適合とする。

#### SP-BPCONFORMANCE-008 部品による組み立て
Workflow script を持つ対象スキルの各段は、設計方針文書「形の判定」の節の部品の例のどれか、または「部品」の定義（1 つ以上の段からなり、段と段の間に戻りの無い定型の並び）に合う並びでなければならない。対象スキルの設計の説明は、段ごとに使った部品の名前を載せなければならない。部品の例に無い並びを使うときは、それが部品の定義に合う理由を 1 文添える。

### 資産台帳

#### SP-BPCONFORMANCE-009 資産台帳の要否
判定する者は、設計方針文書「資産台帳」の節の適用条件で、資産台帳の要否を決めなければならない。適用条件は、fan-out した結果について、どこまで見たかを宣言する必要があるときである。fan-out を持たない対象スキルは、適用条件を満たさないとして扱う。

- 適用条件を満たす対象スキルが資産台帳を持たなければ、PR-BPDESIGNEDSKILL-005 を不適合とする。
- 満たさない対象スキルが資産台帳を持てば、PR-BPDESIGNEDSKILL-018 を不適合とする。

### run の記録

#### SP-BPCONFORMANCE-039 run の記録の判定
判定する者は、run の記録の要求を、下の表の行ごとに 1 つの判定の単位として、対象スキルのフローと、対象スキルが記録を書く CLI か script の仕様から判定しなければならない。表の「不適合とするとき」に当たれば不適合、当たらず見るものから性質があると言えれば適合とする。見るものを読めず決められない単位は SP-BPCONFORMANCE-038 の未検査とする。記録台帳は資産台帳と別のもので、資産台帳を持つことは記録台帳を持つことに代わらない（PR-BPDESIGNEDSKILL-018）。

| 要求 | 不適合とするとき |
|---|---|
| PR-BPDESIGNEDSKILL-028 | 作業記録を残さない担当があるか、作業記録に担当・対象・実行内容・結果・根拠・失敗・未確認のどれかの欄が無い |
| PR-BPDESIGNEDSKILL-029 | 各 run の作業記録と証拠を指す記録台帳が無い |
| PR-BPDESIGNEDSKILL-039 | 作業記録・証拠・記録台帳のどれかを実行環境に保存しない |
| PR-BPDESIGNEDSKILL-030 | 担当が記録台帳に直接書き込む箇所がある |
| PR-BPDESIGNEDSKILL-031 | 当たるときは無い（作業記録を責務か対象ごとに分けても分けなくても不適合としない） |
| PR-BPDESIGNEDSKILL-032 | 同じ内容を 2 つ以上の作業記録か記録台帳に正本として書くか、別の記録が要る内容を正本への参照でなく写しで持つ |
| PR-BPDESIGNEDSKILL-033 | 作業記録を文書の一般規約に従って書くことを、フローか仕様が定めていない |
| PR-BPDESIGNEDSKILL-040 | 対象スキルのフローか仕様が、実行先で読める文書の一般規約の置き場を名指していない |
| PR-BPDESIGNEDSKILL-042 | 作業記録に、適用した文書の一般規約の版の欄か、その版を後から特定できる不変の参照の欄が無い |
| PR-BPDESIGNEDSKILL-034 | 保存できた作業記録・証拠・記録台帳を、利用者の削除の指示なしに消す箇所がある |
| PR-BPDESIGNEDSKILL-038 | 新しい run が、利用者が削除を指示していない過去の run の記録と判断を辿れなくする箇所がある |
| PR-BPDESIGNEDSKILL-035 | 作業記録・証拠・記録台帳を保存できないときに、止まらないか、保存できたものを消すか、保存できなかった範囲と理由を報告しないか、run を完了と報告する |
| PR-BPDESIGNEDSKILL-036 | 各 run の所要時間・人の介入・再試行・実行環境で取得できた費用のどれかを記録しないか、取得できなかった情報を取得できた値と区別しない |

#### SP-BPCONFORMANCE-040 run の記録の置き場
判定する者は、対象スキルの作業記録・証拠・記録台帳の置き場のパスを、SP-BPCONFORMANCE-039 の判定に使ってはならない（本書は置き場のパスを定めない）。best-practices 自身の置き場と形式は `docs/specifications/bp-run.md` を正とする。

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

#### SP-BPCONFORMANCE-034 実行役の時間の上限
探索グラフ型の対象スキルについて、判定する者は、設計方針文書「実行役・回収役・検証役」の表の「実行役の時間に上限を置く」の行の判定の単位を、下の 3 つの確かめの結果から判定表で判定しなければならない。上限の値は対象スキルが自ら決めて書き、本書は値の大きさを定めない。値の大きさは判定の外とする。探索グラフ型でない対象スキルには、この行を当てない（SP-BPCONFORMANCE-003）。

| 確かめ | 見るもの | 満たす | 満たさない |
|---|---|---|---|
| 値（PR-BPDESIGNEDSKILL-043） | 対象スキルの SKILL.md か Workflow script | 実行役の時間の上限の値が単位つきの数で書かれている。書いた箇所（パスと行）を理由に書く | 値が書かれていない |
| Codex runner での制限（PR-BPDESIGNEDSKILL-047） | SKILL.md の Workflow callsite（経路の見分け方は SP-BPCONFORMANCE-026 と同じ） | Codex runner の経路の callsite の契約が、runner の request の `limits.agentTimeoutMs` に値を ms にした値を渡している（Workflow source の `meta.limits` を request の `limits` に渡す形を含む）。Codex runner の経路が無いときも満たすとする | Codex runner の経路があり、値を `limits.agentTimeoutMs` に渡していない |
| Claude Code での記録（PR-BPDESIGNEDSKILL-044） | Claude Code の native Workflow の経路の script とフロー | 対象スキル自身の run の結果（返り値か run の記録）に、Claude Code では実行役の時間の上限を守らせられないことを残す。native Workflow の経路が無いときも満たすとする | native Workflow の経路があり、残さない |

見るものを読めず満たすとも満たさないとも決められない確かめの結果は「読めない」とする。

> 条件の値: 値 = 満たす / 満たさない / 読めない
> 条件の値: Codex runner での制限 = 満たす / 満たさない / 読めない
> 条件の値: Claude Code での記録 = 満たす / 満たさない / 読めない

| 条件: 値 | 条件: Codex runner での制限 | 条件: Claude Code での記録 | 結果 |
|---|---|---|---|
| 満たさない | * | * | 不適合 |
| 満たす | 満たさない | * | 不適合 |
| 読めない | 満たさない | * | 不適合 |
| 満たす | 満たす | 満たさない | 不適合 |
| 満たす | 読めない | 満たさない | 不適合 |
| 読めない | 満たす | 満たさない | 不適合 |
| 読めない | 読めない | 満たさない | 不適合 |
| 満たす | 満たす | 満たす | 適合 |
| 上記以外 | * | * | 未検査（SP-BPCONFORMANCE-038。読めなかった箇所を理由に書く） |

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
| Claude Code | 役ごとの制限を 1 件ずつ、無視される設定の一覧に照らす。一覧は、判定基準の写し（`docs/specifications/bp-run.md` の SP-BPRUN-036）の設計方針文書のうち、plugin から読み込む agent で無視される frontmatter の設定を名前で挙げた記述（現在は「形の判定」の節の表の行）とし、見出しの有無を問わない。制限が一覧の設定に頼るなら、効かないと確かめた制限とする。写しの設計方針文書を読めないかその記述が無いときだけ、一覧を読めないとする | 一覧を読めたときは無し。一覧を読めないときは役ごとの制限の全て |
| Codex runner | 確かめない。runner は agent ごとの道具の許可を持たず、権限は全ての呼び出しに一律に効く（`plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/README.md`。道具の許可を持たないことは Explicit live execution の節の tool allowlists の段落と Deliberate gaps / rollout gate の節、権限の一律は Explicit writable and isolated checkouts の節） | 役ごとの制限の全て |

Claude Code の確かめの結果は、次の判定表で判定の単位に付ける。版が上がって一覧が古くなる危険は受け入れ、判定する者は agent の記憶や写しの外の文書で一覧を補ってはならない。

> 条件の値: 一覧 = 読めた / 読めない
> 条件の値: 照らした結果 = 全て効く / 効かない制限がある

| 条件: 一覧 | 条件: 照らした結果 | 結果 |
|---|---|---|
| 読めた | 全て効く | PR-BPDESIGNEDSKILL-014 の判定の単位と、PR-BPDESIGNEDSKILL-010 の判定の単位のうち設計方針文書「権限」の表の最後の行（SP-BPCONFORMANCE-014）を、Claude Code について適合とする。PR-BPDESIGNEDSKILL-046 の判定の単位を適合とする |
| 読めた | 効かない制限がある | PR-BPDESIGNEDSKILL-014 の判定の単位と、PR-BPDESIGNEDSKILL-010 の判定の単位のうち設計方針文書「権限」の表の最後の行（SP-BPCONFORMANCE-014）を、Claude Code について適合とする。PR-BPDESIGNEDSKILL-046 の判定の単位を不適合とし、効かない制限ごとに指摘の候補を出す |
| 読めない | * | PR-BPDESIGNEDSKILL-014 の判定の単位と、PR-BPDESIGNEDSKILL-010 の判定の単位のうち設計方針文書「権限」の表の最後の行（SP-BPCONFORMANCE-014）を、Claude Code について強いられた未検査とする（create・update の合否を妨げない：`docs/specifications/bp-authoring.md` の用語「強いられた未検査」）。PR-BPDESIGNEDSKILL-046 の判定の単位を適合とする（効かないと確かめた制限が無い） |

#### SP-BPCONFORMANCE-020 確かめられなかった制限の報告
SP-BPCONFORMANCE-019 で確かめられなかった制限ごとに、create・update は「残る危険」として結果に載せなければならない。載せる項目は、役の名前・制限の中身・配布先・確かめられなかった理由の 4 つである。一覧を読めないときの Claude Code の理由は、無視される設定の一覧を読めないこととする。一覧に照らした制限は、Claude Code で確かめられなかった制限として載せない。結果の中のどこに載せるかは、`docs/specifications/bp-authoring.md` の完了時の出力を正とする。

### fan-out の起動数の上限

本節は、Workflow script が fan-out を含む対象スキルに当たる（SP-BPCONFORMANCE-003）。上限が要る理由は Codex runner にある。runner の `limits.maxAgents` は 1 run の agent 呼び出しの総数の上限で、既定は 2 である。超えると run 全体が失敗し、agent の失敗を catch しても避けられない（`plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/README.md` の Contract・Explicit live execution の節）。

#### SP-BPCONFORMANCE-021 起動数の上限の受け取り
対象スキルの Workflow script は、起動数の上限を、省略できる入力（`args` の 1 項目）として受け取らなければならない。値は 1 以上の整数とする。項目の綴りは対象スキルが決め、SKILL.md の Workflow callsite の契約に書かなければならない。項目が無いときは、上限を渡されなかったものとして扱う。

#### SP-BPCONFORMANCE-037 起動数の上限の入力が不正なとき
起動数の上限の項目に 1 以上の整数でない値が渡されたとき、対象スキルの script は、`docs/specifications/bp-run.md` の SP-BPRUN-037 のとおり止まらなければならない。反すれば PR-BPDESIGNEDSKILL-016 を不適合とする。

#### SP-BPCONFORMANCE-022 上限を渡された run の起動数
起動数の上限を渡された run で、script は、項目を、最後まで走らせても上限を超えないと確かめられるときだけ始めなければならない（項目は同時に走る（SP-BPCONFORMANCE-027）ので、呼び終えた数だけで確かめると、同時に始めた項目どうしの残りの呼び出しが合わさって上限を超える）。項目の処理の外で呼ぶ役（計画役・集約・完了の照合など）も、呼ぶ前に同じく確かめる。確かめは、script が定数から決定的に行う。

止まるときに起動しうる記録の呼び出し（予約分）は上限の中に必ず残し、その呼び出し自体を確かめで締め出してはならない。確かめの式は次のとおりとする。起動の単位 u は、fan-out の項目 1 件か、fan-out でない段の 1 回の agent の起動（とその結果を書く呼び出し）を指す。

```
used + Σ_{走っている単位 v} (worst(v) − usedBy(v)) + worst(u) + R ≤ L
```

| 記号 | 値 |
|---|---|
| `L` | 渡された起動数の上限 |
| `used` | この run でここまでに呼んだ `agent()` の数（結果が null の呼び出しを含む） |
| `worst(u)` | 単位 u を最後まで走らせたときの最悪の呼び出しの数。fan-out の項目は、試行の上限 ×（工程の agent の数 + 工程の中で状態を書く呼び出しの数） |
| `usedBy(v)` | 走っている単位 v がここまでに呼んだ数 |
| `R` | 予約分（用語の定義に従う） |

判定する者は、上の 2 つの規則を判定する。式と違う形で確かめていても、2 つの規則を満たせば適合とする（式は 2 つの規則を満たす確かめの形の 1 つで、対象スキルの段の組み方で項の中身が変わる）。best-practices 自身の確かめ（`docs/specifications/bp-run.md` の SP-BPRUN-020）はこの式で行い、4 機能の値と `R` の中身は同文書の SP-BPRUN-021 に置く。

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
対象スキルの Workflow script で同時に走る agent は、3 体以下でなければならない（設計方針文書「体数と同時実行」の表の初期値）。残りは枠が空くまで待たせ、切り捨ててはならない。守らせ方（runtime の設定か script か）は対象スキルの実装が決める。判定する者は同時に走る数と待たせることを判定し、守らせ方が runtime の設定か script かで適合・不適合を分けてはならない。best-practices 自身は、host の設定に頼らず script の名前付きの定数で守る。

#### SP-BPCONFORMANCE-028 until-pass の繰り返しの上限
項目ごとの until-pass の部品で、1 項目の工程を繰り返す回数は、最初の 1 回を含めて 3 回以下でなければならない（設計方針文書「停止」の表が引く、同じ課題の自動の続行は 2〜3 回まで、の上端）。最初の 1 回を含めて数えるのは本書の決定である。出所は最初の 1 回を含むかを定めておらず、含めて数えれば、続行を最初の後の回数と読んでも全体の回数と読んでも 3 を超えない。本書の「最初の 1 回を含めて 3 回以下」は全てこの数え方による。3 回目で通らなければ、その項目の結果として、通らなかったことと理由を返す。

#### SP-BPCONFORMANCE-029 固定集合の反復型の反復の上限
固定集合の反復型で、段の並びを回す回数は、最初の 1 回を含めて 3 回以下でなければならない（出所は SP-BPCONFORMANCE-028 と同じ）。create・update の書き直し（PR-BPOPERATIONS-011）もこの値に従う。値を書き直しにどう当てるかは `docs/specifications/bp-authoring.md` を正とする。

#### SP-BPCONFORMANCE-030 探索グラフの周の上限
探索グラフ型で、1 run の周は 5 周以下でなければならない（依頼者の裁定）。5 周目の終わりで完了していなければ、反復の上限で止まる。

#### SP-BPCONFORMANCE-031 同じ意図の試行の上限
探索グラフ型での同じ意図の試行と、それ以外の形で fan-out の項目の工程が結果を返さなかったときに同じ項目を起動し直す試行は、どちらも最初の 1 回を含めて 3 回以下でなければならない（出所は SP-BPCONFORMANCE-028 と同じ。どちらも 1 つの課題を自動で続行する回数に当たる）。3 回とも工程の欠けになった意図・項目は打ち切る。best-practices 自身の項目への当て方は `docs/specifications/bp-run.md` の SP-BPRUN-028 を、fan-out でない段の agent の結果が拒否されたときの起動し直しへの当て方は `docs/specifications/bp-findings.md` の SP-BPFINDINGS-034 を正とする。試行の回数は run の外の状態に持ち、再開しても数え直してはならない。

#### SP-BPCONFORMANCE-032 乾きの定義と乾き停止
乾きは、設計方針文書「用語」の節の「乾き」の定義を、本書の確定した定義として採る。乾き停止の K は 2 とする（K ≥ 2 の最小。設計方針文書「停止」の表の docs の例と同じ）。2 周連続の乾きで、読まれていないヒントが無いときに乾きで止まる。同じ方向の再確認の意図（設計方針文書「計画役」の表の「見つからなかった」の行）は、1 つの方向につき 1 回までとする（K = 2 の 2 周の間に再確認が 1 回収まる）。

#### SP-BPCONFORMANCE-033 要約の大きさの上限
CLI が作る状態の要約は、8,000 字以下でなければならない（依頼者の裁定。トークン数はモデルで変わるので字数で置く）。字数は CLI が決定的に数える。載せなかったものは、件数と種類を要約の中で宣言する。

#### SP-BPCONFORMANCE-035 役ごとのモデルと effort の指定
対象スキルの Workflow script は、全ての `agent()` 呼び出しで `model` と `effort` を指定しなければならない（省略すると、セッションのモデルを体数分継承する）。判定する者は、PR-BPDESIGNEDSKILL-048 の判定の単位を、全ての `agent()` 呼び出しに `model` と `effort` の option があるかで判定しなければならない。option の値は名前付きの定数を通してもよく、どの値かは照らさない（設計方針文書「モデル・effort・prompt」の節の役ごとの初期値の表、モデルを変えたときの effort の測り直しの行、xhigh と max を使ってよい役を限る行にも照らさない：PR-BPDESIGNEDSKILL-009）。この 3 つの行の判定の単位（PR-BPDESIGNEDSKILL-009 の単位：SP-BPCONFORMANCE-013）には、照らさずに「適合」を付ける（役ごとのモデルと effort への適合は PR-BPDESIGNEDSKILL-048 の単位だけが表し、SP-BPCONFORMANCE-038 の判定できない単位には当たらない）。全ての呼び出しにあれば適合、1 つでも欠ければ不適合とし、欠けた呼び出しの場所（パスと行）を理由に書く。script を読めず決められないときは SP-BPCONFORMANCE-038 の未検査とする。

best-practices 自身の役の値は、次の表とする（依頼者の裁定が優先する。eval で決め直す）。`docs/specifications/bp-run.md` の SP-BPRUN-023 と `docs/specifications/bp-entry.md` の SP-BPENTRY-016 はこの表を参照し、値を書き写さない。

| best-practices の役 | `model` | `effort` |
|---|---|---|
| 書き手 | `opus` | `high` |
| 検証役 | `opus` | `high` |
| 反証役 | `opus` | `high` |
| 抽出役 | `sonnet` | `medium` |
| 運搬役 | `haiku` | `low` |

#### SP-BPCONFORMANCE-036 確定値の置き方
対象スキルは、本章の各値を、script の中の名前付きの定数 1 箇所に置かなければならない。同じ値を 2 箇所に書いてはならない。本章と違う値を使う対象スキルは、PR-BPOPERATIONS-025 の仕様の観点で不適合とする（役ごとのモデルと effort の値は、この判定に含めない：SP-BPCONFORMANCE-035）。値を変えるときは、eval で測って決め直し、本章と設計方針文書へ書き戻してから対象スキルに当てる（対象スキルごとに値を変えると、review が照らす値が 1 つに決まらない）。

## エラー処理と異常系

本書の機能に固有の異常系だけを置く。agent の失敗・続けられない失敗・途中終了は `docs/specifications/bp-run.md` を正とする。

#### SP-BPCONFORMANCE-038 判定の単位を判定できないとき
判定の単位に当たる記述が対象スキルに見つからず、適合とも不適合とも決められないとき、判定する者は、その単位に理由を付けて「未検査」を付けなければならない（SP-BPCONFORMANCE-018）。「適合」としてはならない。

## 検証方法

- 判定表・形の判定（SP-BPCONFORMANCE-003〜009）: 形・資産台帳の有無・fan-out の有無の組み合わせごとに、正例と負例の fixture の対象スキルを用意する。そのうえで、create・update の検証役と review が付ける判定の結果を、期待値と照らす。
- 原則の表の行（SP-BPCONFORMANCE-010〜018）: 1 行ずつ違反を仕込んだ fixture で、その行だけが不適合になり、他の行は適合のままであることを確かめる。
- 配布先での確認（SP-BPCONFORMANCE-019・020）: 無視される設定に頼る制限を持つ fixture について確かめる。Claude Code では、一覧を持つ写しで PR-BPDESIGNEDSKILL-046 の判定の単位が不適合になり、その制限が「残る危険」に載らないことを確かめる。一覧の記述を消した写しで、PR-BPDESIGNEDSKILL-014 の判定の単位が強いられた未検査になり、全ての制限が「残る危険」に載ることを確かめる。Codex runner では、全ての制限が載ることを確かめる。
- run の記録（SP-BPCONFORMANCE-039・040）: 表の行ごとに性質を欠いた fixture で、その行だけが不適合になることを確かめる。置き場のパスだけを変えた fixture で、判定の結果が変わらないことを確かめる。
- 実行役の時間の上限（SP-BPCONFORMANCE-034）: 探索グラフ型の fixture で、判定表の行ごとに 3 つの確かめの結果を作り、期待する判定の結果と照らす。Codex runner の経路と native Workflow の経路の有無を変えた fixture を含める。
- 起動数の上限（SP-BPCONFORMANCE-021〜026・037）: runner の mock backend で、上限と同時実行の数を変えて対象スキルを走らせる。同時実行が 2 以上で項目が重なって走る場合を必ず含める。そのうえで次を照らす。
  - 起動数の記録が、項目が重なって走る場合も上限を超えないこと
  - 残った項目が順位付きで状態に残ること
  - 再開した run が残った項目だけを処理すること
  - 上限を渡さない run が項目を切らないこと
  - 不正な入力で `agent()` が 0 回であること
- 確定値（SP-BPCONFORMANCE-027〜033・036）: 対象スキルの script の定数を読み、本章の値と一致するかを決定的に照合する。そのうえで、上限に達する fixture で、上限の回数で止まることを確かめる。
- 役ごとのモデルと effort（SP-BPCONFORMANCE-035）: `agent()` 呼び出しごとに `model` と `effort` の option の有無を決定的に照合する。option を 1 つ消した fixture で不適合になり、値だけを変えた fixture で適合のままであることを確かめる。
- ターンごとの指揮（SP-BPCONFORMANCE-006）: 形がターンごとの指揮の fixture で、PR-BPDESIGNEDSKILL-002 の判定の単位が適合になることを確かめる。

best-practices 自身の挙動で測れない行（対象スキルに対する検証役の判断の質を問う行）は、模擬の検証役では配線しか測れないので、本物の agent での試走（`docs/specifications/bp-authoring.md` の「検証方法」）で確かめる。どの行がそれに当たり、どの試走で測るかは次の試走の表を正とする。行の検証方法のうち決定的に測れる句はテストで確かめるが、行は試走で当たるまで「完了」にしない。

- 次の 4 項目は、違反を仕込む review の試走（試走の表の「review の試走」）にだけ当てる。仕込まない試走は、4 項目の後の 2 項目に従う。
- review の試走の題材は、判定表の「探索グラフ型・資産台帳 有・fan-out 有」の行に到達する対象スキルとする（1 回の review が到達する判定表の行は 1 つなので、当たる単位の最も多い行を選ぶ）。違反を仕込む前の版の review で指摘が 0 件になることを、先に確かめる（基準の run。省くと、仕込んだ違反と元からの違反を見分けられない）。
- フローの観点の違反は資産 1 つに 1 つだけ仕込む（同じ資産の違反どうしが干渉すると、指摘がどの違反に当たったかを読めない）。仕様の観点の違反は確定値ごとに script の定数へ仕込み、同じ資産に置いてよい（script のファイルは 1 つの資産で、指摘の種類が仕様項目 ID なので読み分けられる）。行ごとに当たり・偽陽性・偽陰性を読む。原則の表の仕様項目は単位を無作為に 1 つ選んで仕込み、選ばなかった単位は確かめていないと宣言する。仕込んだ単位と測る行は正解表（`tests/fixtures/bp-trial/review-target.expected.json`）を正とする。
- 次のどれかに当たれば、仕込んだ全ての行を「作成中」のままにする（一部だけを「完了」にしない。どれも、指摘の有無を違反の当たり・外れとして読めなくする）。
  - 基準の run が完了で止まっていないか、open の指摘が 0 件でないか、題材の判定表の行に着かない。
  - 仕込んだ版の run が完了で止まっていないか、題材の判定表の行に着かない。
  - どちらかの返り値に指摘の一覧の欄が無いか、仕込んだ版の返り値に未検査の観点の欄が無い（欄の欠けを 0 件と読むと、測っていない行を「完了」にする）。
  - 仕込んだ違反の指摘が、仕込んだ資産に別の単位の種類で出た（干渉）。
- 上のどれにも当たらないとき、行ごとに次の全てがそろった行だけを「完了」にする。
  - 行の仕様項目に仕込んだ違反が全て、仕込んだ資産に、仕込んだ単位の種類の指摘として出た。
  - 行の仕様項目の強いられた未検査が全て、判定の単位の範囲で、出所の仕様項目 ID を理由として未検査の観点に載った。
  - 行の仕様項目を種類に持つ偽陽性（仕込まなかった資産・観点の指摘）が無い。
  - run 全体で読む仕様項目は、仕込んだ違反の全ての指摘と強いられた未検査の全てがそろい、偽陽性が 0 件である。
  - 試走で測れない句が無い。
- ターンごとの指揮の題材の review の試走（違反を仕込まない）は、判定表の「ターンごとの指揮」の行のうち fan-out 有の行（2 行目）に到達し、自分の Workflow script を持つ（SP-BPCONFORMANCE-007 に反する）対象スキルを題材とする。題材そのものが測る違反なので、基準の run は置かない。run が完了で止まり、題材の判定表の行に着き、フローの観点で種類が SP-BPCONFORMANCE-007 の open の指摘が出たときだけ、その行を「完了」にする。
- 仕込まない試走（上のターンごとの指揮の題材の review の試走と、create・update の試走）の行は、run が完了で止まり、run ごとの正解表（`tests/fixtures/bp-trial/expected/<run>.json`）の行の句の読みが全て当たり、試走で測れない句が無いときだけ「完了」にする。句の読みは正解表を正とする。
- 「無し」の行は、どの試走でも条件の組が作れないので、測る試走を足すまで「作成中」とする。

| 要求 ID | 仕様項目 ID | 測る試走 |
|---|---|---|
| PR-BPDESIGNEDSKILL-001 | SP-BPCONFORMANCE-001, SP-BPCONFORMANCE-003, SP-BPCONFORMANCE-004 | 無し（形ごとの正例・負例を要し、1 回の review は 1 つの形しか見ない） |
| PR-BPDESIGNEDSKILL-002 | SP-BPCONFORMANCE-006 | review の試走（答えだけで事実の無い設計の説明を仕込む） |
| PR-BPDESIGNEDSKILL-003 | SP-BPCONFORMANCE-007 | ターンごとの指揮の題材の review の試走（題材は script を持つ。同じ題材の update の試走の前に走らせ、update はその指摘を修正の根拠に受ける。update が script を消した後の題材では不適合を作れない） |
| PR-BPDESIGNEDSKILL-004 | SP-BPCONFORMANCE-008 | review の試走（部品名の無い段を仕込む） |
| PR-BPDESIGNEDSKILL-005 | SP-BPCONFORMANCE-009 | 無し（資産台帳の無い対象スキルを要し、review の試走の題材は台帳を持つ） |
| PR-BPDESIGNEDSKILL-018 | SP-BPCONFORMANCE-009 | 無し（fan-out の無い対象スキルを要し、review の試走の題材は fan-out を持つ） |
| PR-BPDESIGNEDSKILL-006 | SP-BPCONFORMANCE-002, SP-BPCONFORMANCE-010 | review の試走（原則の行を 1 つ選んで違反を仕込む） |
| PR-BPDESIGNEDSKILL-007 | SP-BPCONFORMANCE-002, SP-BPCONFORMANCE-011 | review の試走（原則の行を 1 つ選んで違反を仕込む） |
| PR-BPDESIGNEDSKILL-008 | SP-BPCONFORMANCE-012, SP-BPCONFORMANCE-027 | review の試走（原則の行を 1 つ選んで違反を仕込み、同時実行の定数を変える）。runtime の設定で守る形と script で守る形を比べる句は、題材が script の形だけなので測れず、行は「作成中」に留まる |
| PR-BPDESIGNEDSKILL-009 | SP-BPCONFORMANCE-013, SP-BPCONFORMANCE-035 | review の試走（原則の行を 1 つ選んで違反を仕込み、`agent()` 呼び出しの 1 つから `model` か `effort` の option を消す） |
| PR-BPDESIGNEDSKILL-010 | SP-BPCONFORMANCE-014 | review の試走（原則の行を 1 つ選んで違反を仕込む） |
| PR-BPDESIGNEDSKILL-011 | SP-BPCONFORMANCE-015, SP-BPCONFORMANCE-030, SP-BPCONFORMANCE-031, SP-BPCONFORMANCE-032, SP-BPCONFORMANCE-034 | review の試走（原則の行を 1 つ選んで違反を仕込み、周と試行の上限の定数を変える）。上限に達する fixture での停止の句は、review が題材を走らせないので測れず、行は「作成中」に留まる |
| PR-BPDESIGNEDSKILL-012 | SP-BPCONFORMANCE-016, SP-BPCONFORMANCE-033 | review の試走（原則の行を 1 つ選んで違反を仕込み、要約の上限の定数を変える） |
| PR-BPDESIGNEDSKILL-013 | SP-BPCONFORMANCE-017 | review の試走（原則の行を 1 つ選んで違反を仕込む） |
| PR-BPDESIGNEDSKILL-014 | SP-BPCONFORMANCE-019 | 無し（配布先ごとの試走を要し、試走は Claude Code の 1 つだけ） |
| PR-BPDESIGNEDSKILL-015 | SP-BPCONFORMANCE-020 | update の試走（無視される設定に頼る役を持つ題材で、一覧を持つ写しでは、その役の Claude Code の制限が PR-BPDESIGNEDSKILL-046 の不適合になって残る危険に載らず、Codex runner で確かめられなかった制限の全てが 4 項目で残る危険に載る。create の書き手には無視される設定に頼る役を作らせられないので、その役を持つ題材を直す update で測る。`docs/specifications/bp-authoring.md` の SP-BPAUTHORING-033 の fixture の run の行と同じ試走。4 項目の形と返り値への運搬は決定的なテストで測るが、全ての制限が載るかは検証役の判断） |
| PR-BPOPERATIONS-003 | SP-BPCONFORMANCE-010 | create の試走（目標の固定に「目標の固定」の行を当てた判定の結果） |
| PR-BPOPERATIONS-007 | SP-BPCONFORMANCE-005 | create の試走（依頼文を 1 回で解ける課題にする） |
| PR-BPOPERATIONS-024 | SP-BPCONFORMANCE-001, SP-BPCONFORMANCE-002, SP-BPCONFORMANCE-003, SP-BPCONFORMANCE-018, SP-BPCONFORMANCE-038 | review の試走（仕込んだ違反が指摘として、仕込まない単位が指摘の無いまま返る） |
| PR-BPOPERATIONS-025 | SP-BPCONFORMANCE-028, SP-BPCONFORMANCE-029, SP-BPCONFORMANCE-030, SP-BPCONFORMANCE-031, SP-BPCONFORMANCE-032, SP-BPCONFORMANCE-033, SP-BPCONFORMANCE-035, SP-BPCONFORMANCE-027, SP-BPCONFORMANCE-036 | review の試走（仕様の観点で、確定値の定数ごとに違反を仕込む）。SP-BPCONFORMANCE-028・SP-BPCONFORMANCE-029 は探索グラフ型の題材に当てる部品が無く測れないので、測る題材の試走を足すまで「作成中」 |

## トレーサビリティ表

| 要求 ID | 仕様項目 ID | 検証方法 | ステータス |
|---|---|---|---|
| PR-BPDESIGNEDSKILL-001 | SP-BPCONFORMANCE-001, SP-BPCONFORMANCE-003, SP-BPCONFORMANCE-004 | fixture（形ごとの正例・負例）で判定の結果を照合 | 作成中 |
| PR-BPDESIGNEDSKILL-002 | SP-BPCONFORMANCE-006 | fixture（答えだけで事実の無い設計の説明）で不適合、ターンごとの指揮で適合を照合 | 作成中 |
| PR-BPDESIGNEDSKILL-003 | SP-BPCONFORMANCE-007 | fixture（ターンごとの指揮で script を持つもの）で不適合を照合 | 作成中 |
| PR-BPDESIGNEDSKILL-004 | SP-BPCONFORMANCE-008 | fixture（部品名の無い段）で不適合を照合 | 作成中 |
| PR-BPDESIGNEDSKILL-005 | SP-BPCONFORMANCE-009 | fixture（適用条件を満たすが台帳の無いもの）で不適合を照合 | 作成中 |
| PR-BPDESIGNEDSKILL-018 | SP-BPCONFORMANCE-009 | fixture（fan-out が無いのに台帳を持つもの）で不適合を照合 | 作成中 |
| PR-BPDESIGNEDSKILL-006 | SP-BPCONFORMANCE-002, SP-BPCONFORMANCE-010 | 原則の行ごとに違反を仕込んだ fixture | 作成中 |
| PR-BPDESIGNEDSKILL-007 | SP-BPCONFORMANCE-002, SP-BPCONFORMANCE-011 | 原則の行ごとに違反を仕込んだ fixture | 作成中 |
| PR-BPDESIGNEDSKILL-008 | SP-BPCONFORMANCE-012, SP-BPCONFORMANCE-027 | 原則の行ごとの fixture と、同時実行数の記録の照合。同時実行の上限を runtime の設定で守る fixture と script で守る fixture が、同じ判定の結果になることの照合 | 作成中 |
| PR-BPDESIGNEDSKILL-009 | SP-BPCONFORMANCE-013, SP-BPCONFORMANCE-035 | 原則の行ごとの fixture と、`agent()` の model・effort の有無の決定的照合。値だけを変えた fixture が適合のままであることの照合。best-practices 自身の script の定数が SP-BPCONFORMANCE-035 の best-practices の役の表と一致することの照合 | 作成中 |
| PR-BPDESIGNEDSKILL-048 | SP-BPCONFORMANCE-003, SP-BPCONFORMANCE-035 | `agent()` 呼び出しの 1 つから `model` か `effort` を消した fixture で不適合と場所の理由を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-010 | SP-BPCONFORMANCE-014 | 原則の行ごとに違反を仕込んだ fixture | 作成中 |
| PR-BPDESIGNEDSKILL-011 | SP-BPCONFORMANCE-015, SP-BPCONFORMANCE-030, SP-BPCONFORMANCE-031, SP-BPCONFORMANCE-032, SP-BPCONFORMANCE-034 | 原則の行ごとの fixture と、上限に達する fixture での停止の照合 | 作成中 |
| PR-BPDESIGNEDSKILL-043 | SP-BPCONFORMANCE-034 | 上限の値を書かない探索グラフ型の fixture で不適合を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-047 | SP-BPCONFORMANCE-034 | Codex runner の経路で `limits.agentTimeoutMs` に値を渡さない fixture で不適合、経路の無い fixture で不適合にならないことを照合 | 未着手 |
| PR-BPDESIGNEDSKILL-044 | SP-BPCONFORMANCE-034 | native Workflow の経路で守らせられないことを残さない fixture で不適合、経路の無い fixture で不適合にならないことを照合 | 未着手 |
| PR-BPDESIGNEDSKILL-012 | SP-BPCONFORMANCE-016, SP-BPCONFORMANCE-033 | 原則の行ごとの fixture と、要約の字数の決定的照合 | 作成中 |
| PR-BPDESIGNEDSKILL-013 | SP-BPCONFORMANCE-017 | 原則の行ごとに違反を仕込んだ fixture | 作成中 |
| PR-BPDESIGNEDSKILL-014 | SP-BPCONFORMANCE-019 | 無視される設定に頼る制限を持つ fixture を配布先ごとに確かめる | 作成中 |
| PR-BPDESIGNEDSKILL-015 | SP-BPCONFORMANCE-020 | 確かめられなかった制限が 4 項目そろって結果に載り、一覧に照らした制限が Claude Code の行として載らないことを照合 | 作成中 |
| PR-BPDESIGNEDSKILL-045 | SP-BPCONFORMANCE-019 | 一覧を持つ写しで、制限ごとに一覧に照らした結果が出ることを照合 | 未着手 |
| PR-BPDESIGNEDSKILL-046 | SP-BPCONFORMANCE-003, SP-BPCONFORMANCE-019 | 一覧の設定に頼る制限を持つ fixture で不適合を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-049 | SP-BPCONFORMANCE-019, SP-BPCONFORMANCE-020 | 一覧の記述を消した写しで、全ての制限が Claude Code の残る危険に載ることを照合 | 未着手 |
| PR-BPDESIGNEDSKILL-050 | SP-BPCONFORMANCE-019 | 一覧の記述を消した写しで、PR-BPDESIGNEDSKILL-014 の判定の単位が強いられた未検査になり不適合にならないことを照合 | 未着手 |
| PR-BPDESIGNEDSKILL-028 | SP-BPCONFORMANCE-003, SP-BPCONFORMANCE-039 | 作業記録の欄を欠いた fixture で不適合を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-029 | SP-BPCONFORMANCE-039 | 記録台帳の無い fixture で不適合を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-039 | SP-BPCONFORMANCE-039, SP-BPCONFORMANCE-040 | 記録を実行環境に保存しない fixture で不適合、置き場のパスだけを変えた fixture で結果が変わらないことを照合 | 未着手 |
| PR-BPDESIGNEDSKILL-030 | SP-BPCONFORMANCE-039 | 担当が記録台帳に直接書く fixture で不適合を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-031 | SP-BPCONFORMANCE-039 | 作業記録を分けた fixture と分けない fixture が不適合にならないことを照合 | 未着手 |
| PR-BPDESIGNEDSKILL-032 | SP-BPCONFORMANCE-039 | 同じ内容を 2 つの記録に正本として書く fixture で不適合を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-033 | SP-BPCONFORMANCE-039 | 一般規約に従うことを定めない fixture で不適合を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-040 | SP-BPCONFORMANCE-039 | 一般規約の置き場を名指さない fixture で不適合を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-042 | SP-BPCONFORMANCE-039 | 版か不変の参照の欄を欠いた fixture で不適合を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-034 | SP-BPCONFORMANCE-039 | 保存できた記録を消す fixture で不適合を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-038 | SP-BPCONFORMANCE-039 | 新しい run が過去の記録を辿れなくする fixture で不適合を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-035 | SP-BPCONFORMANCE-039 | 保存の失敗で完了と報告する fixture で不適合を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-036 | SP-BPCONFORMANCE-039 | 費用を記録しないか取得できなかった情報を区別しない fixture で不適合を照合 | 未着手 |
| PR-BPDESIGNEDSKILL-016 | SP-BPCONFORMANCE-021, SP-BPCONFORMANCE-037 | mock backend で上限の有無・不正な値を渡して走らせ、不正な値で `agent()` が 0 回で BLOCKED になることを照合 | 完了 |
| PR-BPDESIGNEDSKILL-017 | SP-BPCONFORMANCE-022 | mock backend で起動数の記録が上限を超えないことを照合 | 完了 |
| PR-BPDESIGNEDSKILL-019 | SP-BPCONFORMANCE-023 | mock backend で、残った項目が順位付きで状態に残り、停止の種類が反復の上限で、理由に起動数の上限・その時点の起動数・件数が載ることを照合 | 完了 |
| PR-BPDESIGNEDSKILL-020 | SP-BPCONFORMANCE-024 | mock backend で再開した run が残った項目だけを順位の順に処理し、next_args に上限が無いことを照合 | 完了 |
| PR-BPDESIGNEDSKILL-021 | SP-BPCONFORMANCE-025 | mock backend で上限を渡さない run が項目を切らないことを照合 | 完了 |
| PR-BPDESIGNEDSKILL-022 | SP-BPCONFORMANCE-026 | fixture の callsite で、Codex runner の経路の上限が `limits.maxAgents` 以下であることを照合 | 未着手 |
| PR-BPDESIGNEDSKILL-023 | SP-BPCONFORMANCE-026 | fixture の callsite で、native Workflow の経路が上限を渡さないことを照合 | 未着手 |
| PR-BPOPERATIONS-003 | SP-BPCONFORMANCE-010 | create の目標の固定に「目標の固定」の行を当てた判定の結果を照合 | 作成中 |
| PR-BPOPERATIONS-007 | SP-BPCONFORMANCE-005 | fixture（1 回で解ける課題）で Q3 が「いいえ」になることを照合 | 作成中 |
| PR-BPOPERATIONS-008 | SP-BPCONFORMANCE-001, SP-BPCONFORMANCE-018, SP-BPCONFORMANCE-038 | create の検証役が当たる判定の単位の全てに結果を付けることを照合 | 完了 |
| PR-BPOPERATIONS-011 | SP-BPCONFORMANCE-029 | 書き直しが 3 回で止まることを照合 | 完了 |
| PR-BPOPERATIONS-024 | SP-BPCONFORMANCE-001, SP-BPCONFORMANCE-002, SP-BPCONFORMANCE-003, SP-BPCONFORMANCE-018, SP-BPCONFORMANCE-038 | review のフローの観点が本書の判定の単位の全てに結果を付け、不適合が指摘、未検査が未検査の観点として返り値に載ることを照合 | 作成中 |
| PR-BPOPERATIONS-025 | SP-BPCONFORMANCE-028, SP-BPCONFORMANCE-029, SP-BPCONFORMANCE-030, SP-BPCONFORMANCE-031, SP-BPCONFORMANCE-032, SP-BPCONFORMANCE-033, SP-BPCONFORMANCE-035, SP-BPCONFORMANCE-027, SP-BPCONFORMANCE-036 | 対象スキルの定数と本章の値の決定的照合 | 作成中 |
