# 仕様書: 対象スキルが備える性質の判定基準と、対象スキルに課す確定値

本書は `docs/requirements/bp-designed-skill.md` の要求を実現する判定基準と、設計方針文書（`docs/design/skill-design-patterns.md`）が「（暫定）」とした値を確定した値を定める。表記規約と要求側の用語は `docs/requirements/bp-operations.md` に従う。複数の仕様書で使う語（起動数など）は `docs/specifications/bp-run.md` の用語定義を正とする。

## 対象範囲

- 本書は `####` 見出し 1 つを 1 仕様項目とする。
- 本書が実現する要求は末尾のトレーサビリティ表を正とする。
- 本書の判定基準を当てる者は 2 つある。create・update の検証役（PR-BPOPERATIONS-008）と、review のフローの観点（PR-BPOPERATIONS-024）である。ただし SP-BPCONFORMANCE-041 は、この 2 つでなく CLI の機械照合が当てる（`docs/specifications/bp-findings.md` の SP-BPFINDINGS-010）。review の仕様の観点（PR-BPOPERATIONS-025）は、「性能・容量（対象スキルに課す確定値）」の章に照らす。
- 本書が扱わないもの:
  - 判定の結果を指摘・資産台帳にする方法（`docs/specifications/bp-findings.md`）
  - 停止の種類・状態・next_args・CLI（`docs/specifications/bp-run.md`）
  - best-practices 自身の callsite（`docs/specifications/bp-entry.md`）
  - create・update の手順（`docs/specifications/bp-authoring.md`）

## 用語定義

| 用語 | 意味 |
|---|---|
| 問い A・W・Q1・Q2・Q3 | 設計方針文書「形の判定」の図の問いの名前。A は人間の入力が要るところを run の境界にできるか、W は書き込む役と、書き込ませない役が、同じ区間に要るか、Q1 は段と段の間に結果による戻りが無いか、Q2 は試すものの集合が事前に決まり結果で増減しないか、Q3 は探索グラフの適用条件を満たすか、を問う |
| run の並び | 問い W に「はい」と答える対象スキルで、分けた各 run（対象スキルが run を分けていなくても、SP-BPCONFORMANCE-003 のとおり分けたもの）を並べた全体。分けた各 run と同じく、問い Q1 以降を当てて形を得る（SP-BPCONFORMANCE-004） |
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
設計方針文書の節を参照する要求（PR-BPDESIGNEDSKILL-006・007・008・009・010・011・012・013）について、判定する者は、参照する節の原則の表の各行を 1 つの判定の単位としなければならない。そのうえで、行ごとに判定の結果を付けなければならない。本書は行の中身を書き写さない。判定の単位を示す値の形は `docs/specifications/bp-findings.md` の SP-BPFINDINGS-010 に従う。

#### SP-BPCONFORMANCE-003 適用の判定表
適用する判定の単位は、下の表と、どの形にも当たる SP-BPCONFORMANCE-004・005・006・009・010・019・020・039・040・041 から決めなければならない。表の番号は SP-BPCONFORMANCE- を略した仕様項目番号であり、要求を統合しても個々の適用条件を広げてはならない。各単位の根拠要求はトレーサビリティ表が持つ。形は対象の実際のフローから問いを当てて決め、資産台帳・fan-out は実際に備えるかで決める。

問い W の答えが「はい」でない対象スキルは、対象スキル全体で下の表の 1 行を引く。問い W の答えが「はい」の対象スキルでは、対象スキルが run を分けていなくても、判定する者は、対象スキルのフローを、図のとおり書き込む役だけを置く run とそれ以外の run に分けたものとして run の並びと各 run に名前を付け、run の並びと分けた各 run のそれぞれに SP-BPCONFORMANCE-004 の順で問いを当てて形を得て、それぞれの形と、それぞれが実際に持つ資産台帳・fan-out で、下の表の行を 1 行ずつ引かなければならない。適用する判定の単位は、引いた行の基準の和とする。各単位は、それを適用した行の run（run の並びを含む）ごとに判定し、行の結果の「不適合とする」も、その行の run について付ける。資産の属する run は、適用の判定の記録の `runs` の要素ごとの `assets`（`docs/specifications/bp-inspection.md` の SP-BPINSPECTION-006）で決める。分けた各 run が実際に持つ資産台帳・fan-out は、その run に属する資産だけが持つかで決める。run の並びが実際に持つ資産台帳・fan-out は、どの要素の `assets` にも無い資産だけが持つかで決め、分けた各 run に属する資産の持つものを含めない。1 つの資産が 2 つ以上の run に属するときも、1 つの判定の単位を 2 つ以上の run で判定したときとして扱う。ただし、PR-BPDESIGNEDSKILL-051 の判定の単位は run ごとに判定せず、対象スキルに 1 つとする（SP-BPCONFORMANCE-041）。1 つの判定の単位を 2 つ以上の run で判定したときは、どれかが不適合なら不適合、不適合が無くどれかが未検査なら未検査、全てが適合のときだけ適合とし、判定の単位ごとの結果は 1 つにして、不適合か未検査の理由にその run を書く。

> 条件の値: 形 = 固定パイプライン型 / 固定集合の反復型 / 探索グラフ型 / ターンごとの指揮
> 条件の値: 資産台帳 = 有 / 無
> 条件の値: fan-out = 有 / 無

| 条件: 形 | 条件: 資産台帳 | 条件: fan-out | 追加する判定基準と不適合 |
|---|---|---|---|
| ターンごとの指揮 | 無 | 無 | 007 |
| ターンごとの指揮 | 無 | 有 | 007。不適合（Workflow の段を持つ） |
| ターンごとの指揮 | 有 | * | 007。009 を不適合とする |
| 固定パイプライン型 | 無 | 無 | 008・011・012・013・014・035 |
| 固定パイプライン型 | 無 | 有 | 008・011・012・013・014・035・021・022・023・024・025・026・037 |
| 固定パイプライン型 | 有 | 無 | 008・011・012・013・014・035・016・017。009 を不適合とする |
| 固定パイプライン型 | 有 | 有 | 008・011・012・013・014・035・016・017・021・022・023・024・025・026・037 |
| 固定集合の反復型 | 無 | 無 | 008・011・012・013・014・035 |
| 固定集合の反復型 | 無 | 有 | 008・011・012・013・014・035・021・022・023・024・025・026・037 |
| 固定集合の反復型 | 有 | 無 | 008・011・012・013・014・035・016・017。009 を不適合とする |
| 固定集合の反復型 | 有 | 有 | 008・011・012・013・014・035・016・017・021・022・023・024・025・026・037 |
| 探索グラフ型 | 無 | 無 | 008・011・012・013・014・035・015・016・034。015 の意図を fan-out する原則を不適合とする |
| 探索グラフ型 | 無 | 有 | 008・011・012・013・014・035・015・016・034・021・022・023・024・025・026・037 |
| 探索グラフ型 | 有 | 無 | 008・011・012・013・014・035・015・016・017・034。009 と 015 の意図を fan-out する原則を不適合とする |
| 探索グラフ型 | 有 | 有 | 008・011・012・013・014・035・015・016・017・034・021・022・023・024・025・026・037 |

表に無い単位は対象外としなければならない。SP-BPCONFORMANCE-027〜033・036 の確定値の適用は、各項目が定める形・部品の条件に従う。review の観点を分ける単位は SP-BPINSPECTION-007・008 に従う。

### 配置の原則

#### SP-BPCONFORMANCE-041 判断点の表の照合
PR-BPDESIGNEDSKILL-051 の判定の単位は対象スキルに 1 つとし、問い W の答えが「はい」の対象スキルでも run ごとに分けない（設計の説明は対象スキルに 1 つ）。設計方針文書の「配置の原則」の節の表の行は、判定の単位にしない。

対象スキルは、判断点の列挙を、設計の説明の中に次の形の Markdown の表（以下、判断点の表）として 1 つだけ置かなければならない。判断点が無いときは、データ行を 0 行にした判断点の表を置き、これを判断点が無いことの記述とする（判断点が無いことを表すデータ行を書くと、照合の側から理由の付いた判断点 1 つと区別できない）。

- 行: 行の終わりの改行（CR LF を含む）を除き、前後の空白を除いたもの。以下の照合は全てこの行で行う。
- 見出し行: 行が `| 判断点 | 硬い層へ置けない理由 |` と一致する行。ただし、`docs/specifications/bp-findings.md` の SP-BPFINDINGS-002 のフェンスの中の行は見出し行に数えない（依頼者の裁定。例は、フェンスに入れれば数えない）。
- 区切り行: 見出し行の次の行で、`|`・`-`・`:`・空白だけからなり、セルが 2 つの行。
- データ行: 区切り行に続く、`|` で始まる連続した行。`|` で始まらない最初の行か、探す範囲の終わりで終わる。1 行を判断点 1 つとし、1 つ目のセルに判断点を、2 つ目のセルに硬い層へ置けない理由を書く。
- セル: 行の先頭の `|` を除き、末尾が `|` ならそれも除いた残りを、`\|` でない `|` で分け、それぞれの前後の空白を除いたもの。

判定する者は、見出し行・区切り行・データ行を次の範囲から探さなければならない（範囲の外の行は、区切り行にもデータ行にもしない）。

| 機能 | 探す範囲 |
|---|---|
| create・update | 書く段の結果の `designNote` が指すファイルの、`startLine` から `endLine` までの行（`docs/specifications/bp-authoring.md` の SP-BPAUTHORING-011・SP-BPAUTHORING-013。最後に保存された作成結果の設計の説明を使う） |
| review | 対象スキルのパスの一覧（`docs/specifications/bp-run.md` の用語定義）の全てのファイルの行（ファイルごとに探し、ファイルの終わりを範囲の終わりとする。依頼者の裁定） |

判定する者は、見つけた見出し行の数とデータ行から、次の判定表で結果を決めなければならない。

> 条件の値: 見出し行の数 = 0 / 1 / 2 以上
> 条件の値: 表の行 = 区切り行が無い / セルが 2 つでないか空のセルを持つデータ行がある / 全てのデータ行がセルを 2 つ持ち、どちらも空でない（データ行が 0 行のときを含む）

| 条件: 見出し行の数 | 条件: 表の行 | 結果 |
|---|---|---|
| 0 | * | 不適合（判断点の列挙も判断点が無いことの記述も無い） |
| 2 以上 | * | 不適合（理由に、見出し行のパスと行番号の全てを書く。どれが列挙か決まらない） |
| 1 | 区切り行が無い | 不適合（理由に、見出し行のパスと行番号を書く） |
| 1 | セルが 2 つでないか空のセルを持つデータ行がある | 不適合（理由に、その行のパスと行番号の全てを書く） |
| 1 | 全てのデータ行がセルを 2 つ持ち、どちらも空でない（データ行が 0 行のときを含む） | 適合 |

判定する者は、結果を判断点の表の文字列だけから決めなければならない。次のことで結果を変えてはならず、指摘の候補にもしてはならない（照らすと、その判定自体が AI の判断に渡す層に置かれる）。

- 列挙が判断点を網羅しているか
- 列挙した判断点が AI の判断に渡す知識の層にあるか
- 理由の中身
- ルール・知識・処理を、表せる最も硬い層に置いたか
- AI の判断に渡す知識の層以外（人間の判定の層を含む）に置いたものに、理由が無いこと

探す範囲のファイルを読めず結果を決められないときは、SP-BPCONFORMANCE-038 の未検査とする。本項は CLI の機械照合だけで判定し、検証役は本項の単位を判定しない。結果の返し方は、create・update は `docs/specifications/bp-authoring.md` の SP-BPAUTHORING-021、review は `docs/specifications/bp-inspection.md` の SP-BPINSPECTION-007 に従う。

列挙が判断点を網羅しているかは、本項の照合では確かめない。網羅を確かめていないことは、次の場所に必ず 1 件ずつ含め、検証役の任意の省略に任せてはならない（内容は対象スキルによらず同じで、本項はどの行でも当たるので、agent に書かせると決まった事実を AI の判断に渡す層で写すことになる）。理由は「列挙が判断点を網羅していることを機械の照合で確かめていない」とし、この文言は本項だけに置く（以下、網羅の理由）。

| 機能 | 置き場 | 項目 |
|---|---|---|
| create・update | 残る危険（`docs/specifications/bp-authoring.md` の SP-BPAUTHORING-017） | 仕様項目 ID `SP-BPCONFORMANCE-041` と網羅の理由の 2 つ |
| review | 未検査の観点（`docs/specifications/bp-inspection.md` の SP-BPINSPECTION-025） | 同項の表の形 |

### 形の判定

#### SP-BPCONFORMANCE-004 形の判定の順序
create・update は、設計方針文書「形の判定」の図の問いを、次の順に 1 つずつ答え、最初に到達した形を形にしなければならない。答えた問いを飛ばしてはならない。

> 条件の値: 問い A の答え = はい / いいえ
> 条件の値: 問い W の答え = はい / いいえ / 問いに到達しない

| 条件: 問い A の答え | 条件: 問い W の答え | 結果 |
|---|---|---|
| いいえ | 問いに到達しない | A・W の順に答え、形はターンごとの指揮とする（Q1・Q2・Q3 は問いに到達しない） |
| はい | いいえ | A・W・Q1・Q2・Q3 の順に答え、最初に到達した形を対象スキルの形とする |
| はい | はい | A・W の後に、run の並びと分けた各 run（対象スキルが run を分けていなくても、SP-BPCONFORMANCE-003 のとおり分けたもの）のそれぞれに Q1・Q2・Q3 の順に答え、それぞれの最初に到達した形をその run（run の並びを含む）の形とする |
| いいえ | はい | 図の道に無い答えの並びとし、この並びで答えてはならない |
| いいえ | いいえ | 図の道に無い答えの並びとし、この並びで答えてはならない |
| はい | 問いに到達しない | 図の道に無い答えの並びとし、この並びで答えてはならない |

review のフローの観点の判定する者は、対象スキルのフローから同じ順に問いへ答える。そのうえで、最初に到達する形と対象スキルの形（問い W の答えが「はい」の対象スキルでは、run の並びと分けた各 run のそれぞれの形）が食い違えば、PR-BPDESIGNEDSKILL-001 を不適合としなければならない。たとえば、Q1 に「はい」と答えられるフローで固定集合の反復型を選んでいれば不適合である。問い W の答えが「はい」なのに対象スキルが run を分けていないことも、この食い違いに当たる。

#### SP-BPCONFORMANCE-005 探索グラフの適用条件
問い Q3 では、設計方針文書「探索グラフ」の節の適用条件 4 つが全て満たされるときだけ「はい」と答えなければならない。1 体の agent が 1 回の実行で解ける課題は、4 つの条件を問う前に「いいえ」としなければならない（1 回で解けるなら、スキルの形にする理由が無い）。

#### SP-BPCONFORMANCE-006 重い形を強いた条件の記録
PR-BPDESIGNEDSKILL-002 の判定の単位は対象スキルに 1 つとし、判定する者は、対象スキルの run ごとの形から下の表で結果を決めなければならない。問い W の答えが「はい」でない対象スキルは run が 1 つで、その形を当てる。問い W の答えが「はい」の対象スキルは、run の並びと分けた各 run の形を当てる（形の得方は SP-BPCONFORMANCE-003・SP-BPCONFORMANCE-004）。重い形の run は、形が重い形（用語定義）の run とし、run の並びの形が重い形なら run の並びも重い形の run とする。重い形の run（run の並びを含む）について、対象スキルの設計の説明は、問い Q1 以降の各問いへの答えを到達した形まで全て載せ、各答えにその答えを強いたフローの事実（どの段の結果がどの段への戻りを要するか、試すものの集合が何で変わるか）を 1 文以上添える。下の表の「全ての run」と、理由に書く「その run」も run の並びを含む。判定する者は、問い W の答えと run ごとの形を、適用の判定の記録（create・update は `docs/specifications/bp-authoring.md` の SP-BPAUTHORING-017、review は `docs/specifications/bp-inspection.md` の SP-BPINSPECTION-006）から読む。ターンごとの指揮の run を含むことは、他の重い形の run の記録の義務を消さない。

> 条件の値: 重い形の run = 無い / 有る
> 条件の値: 重い形の run の記録 = 全ての run で答えと事実が揃う / 答えが欠けるか事実の無い答えがある run が有る

| 条件: 重い形の run | 条件: 重い形の run の記録 | 結果 |
|---|---|---|
| 無い | * | 適合（対象外にも未検査にもしない） |
| 有る | 全ての run で答えと事実が揃う | 適合 |
| 有る | 答えが欠けるか事実の無い答えがある run が有る | 不適合（理由にその run を書く） |

#### SP-BPCONFORMANCE-007 Workflow にしない判定
形がターンごとの指揮のとき、対象スキルは、自分の plugin の workflow script も、スキルのディレクトリの中の Workflow script も持ってはならない。SKILL.md に `Workflow(` の callsite を持ってもならない。どちらかがあれば、PR-BPDESIGNEDSKILL-001 を不適合とする。問い W の答えが「はい」の対象スキルでは、判定する者は、本項をターンごとの指揮の行を引いた run（SP-BPCONFORMANCE-003）について、その run を実行する workflow script とその run の `Workflow(` の callsite が無いかで判定しなければならない。

#### SP-BPCONFORMANCE-008 部品による組み立て
Workflow script を持つ対象スキルの各段は、設計方針文書「形の判定」の節の部品の例のどれか、または「部品」の定義（1 つ以上の段からなり、段と段の間に戻りの無い定型の並び）に合う並びでなければならない。対象スキルの設計の説明は、段ごとに使った部品の名前を載せなければならない。部品の例に無い並びを使うときは、それが部品の定義に合う理由を 1 文添える。

### 資産台帳

#### SP-BPCONFORMANCE-009 資産台帳の要否
判定する者は、設計方針文書「資産台帳」の節の適用条件で、資産台帳の要否を決めなければならない。適用条件は、fan-out した結果について、どこまで見たかを宣言する必要があるときである。fan-out を持たない対象スキルは、適用条件を満たさないとして扱う。

- 適用条件を満たす対象スキルが資産台帳を持たなければ、PR-BPDESIGNEDSKILL-001 を不適合とする。
- 満たさない対象スキルが資産台帳を持てば、PR-BPDESIGNEDSKILL-001 を不適合とする。

### run の記録

#### SP-BPCONFORMANCE-039 run の記録の判定
判定する者は、run の記録の要求を、下の表の行ごとに 1 つの判定の単位として、対象スキルのフローと、対象スキルが記録を書く CLI か script の仕様から判定しなければならない。表の「不適合とするとき」に当たれば不適合、当たらず見るものから性質があると言えれば適合とする。見るものを読めず決められない単位は SP-BPCONFORMANCE-038 の未検査とする。記録台帳は資産台帳と別のもので、資産台帳を持つことは記録台帳を持つことに代わらない（PR-BPDESIGNEDSKILL-001）。

| 要求 | 不適合とするとき |
|---|---|
| PR-BPDESIGNEDSKILL-028 | 作業記録を残さない担当があるか、作業記録に担当・段・対象・入力・実行内容・結果・根拠・失敗・未確認のどれかの欄が無いか、設計方針文書「用語」の段の境界を 1 つも持たない run の作業記録で、段の欄に段が無いことを書かない（空欄にする） |
| PR-BPDESIGNEDSKILL-029 | 各 run の作業記録と証拠を指す記録台帳が無い |
| PR-BPDESIGNEDSKILL-029 | 作業記録・証拠・記録台帳のどれかを実行環境に保存しない |
| PR-BPDESIGNEDSKILL-029 | 担当が記録台帳に直接書き込む箇所がある |
| PR-BPDESIGNEDSKILL-032 | 当たるときは無い（作業記録を責務か対象ごとに分けても分けなくても不適合としない） |
| PR-BPDESIGNEDSKILL-032 | 同じ内容を 2 つ以上の作業記録か記録台帳に正本として書くか、別の記録が要る内容を正本への参照でなく写しで持つ |
| PR-BPDESIGNEDSKILL-040 | 作業記録を文書の一般規約に従って書くことを、フローか仕様が定めていない |
| PR-BPDESIGNEDSKILL-040 | 対象スキルのフローか仕様が、実行先で読める文書の一般規約の置き場を名指していない |
| PR-BPDESIGNEDSKILL-040 | 作業記録に、適用した文書の一般規約の版の欄か、その版を後から特定できる不変の参照の欄が無い |
| PR-BPDESIGNEDSKILL-034 | 保存できた作業記録・証拠・記録台帳を、利用者の削除の指示なしに消す箇所がある |
| PR-BPDESIGNEDSKILL-034 | 新しい run が、利用者が削除を指示していない過去の run の記録と判断を辿れなくする箇所がある |
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
| 値（PR-BPDESIGNEDSKILL-011） | 対象スキルの SKILL.md か Workflow script | 実行役の時間の上限の値が単位つきの数で書かれている。書いた箇所（パスと行）を理由に書く | 値が書かれていない |
| Codex runner での制限（PR-BPDESIGNEDSKILL-011） | SKILL.md の Workflow callsite（経路の見分け方は SP-BPCONFORMANCE-026 と同じ） | Codex runner の経路の callsite の契約が、runner の request の `limits.agentTimeoutMs` に値を ms にした値を渡している（Workflow source の `meta.limits` を request の `limits` に渡す形を含む）。Codex runner の経路が無いときも満たすとする | Codex runner の経路があり、値を `limits.agentTimeoutMs` に渡していない |
| Claude Code での記録（PR-BPDESIGNEDSKILL-011） | Claude Code の native Workflow の経路の script とフロー | 対象スキル自身の run の結果（返り値か run の記録）に、Claude Code では実行役の時間の上限を守らせられないことを残す。native Workflow の経路が無いときも満たすとする | native Workflow の経路があり、残さない |

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
起動数の上限を渡された run は、既に起動した数だけでなく、同時に実行中の項目が最後まで必要とする呼び出し、新しい項目の最悪の場合の呼び出し、停止と記録に必要な呼び出しを合わせて上限に収まるときだけ、新しい作業を始めなければならない。fan-out の外の担当と運搬も同じ上限に含めなければならない。

並行する作業がそれぞれ残枠を重複して使ってはならず、停止の記録を上限の外へ追い出してはならない。判定する者はこの 2 つの性質を確かめ、計算式や内部の予約方式の違いだけで適合を分けてはならない。

#### SP-BPCONFORMANCE-023 上限に収まらない項目
SP-BPCONFORMANCE-022 で始められない項目が 1 件以上残ったとき、script は新しい項目を始めてはならない。そのうえで、始めた項目が終わるのを待ち、次の 2 つを状態に書いて止まらなければならない。

- 残った項目の全てを、順位を付けた未着手として書く。
- 止まった理由に、上限・その時点の起動数・残った件数を含める。

状態への書き込みは、設計方針文書「状態の書き込み」の節の原則（CLI だけが書き、運搬役が呼ぶ）に従う。残った項目を切り捨ててはならない。

順位の付け方は次のとおり。

- 探索グラフ型では、計画役が最後に付けた順位を使う。
- それ以外の形では、script が項目を起動する予定だった順を使う。

止まるときの停止の種類と理由の書き方は `docs/specifications/bp-run.md` の SP-BPRUN-035 を、next_args に載せるものは同文書を正とする。上限が停止の記録と最初の項目の最悪の呼び出しを収められず、1 件も始められないときは、本項ではなく同文書の SP-BPRUN-037 に従う。理由には、上限が 1 件の項目にも足りないことを書く。何も処理しないまま、上限に達した通常の停止と見分けのつかない形で止まってはならない。

#### SP-BPCONFORMANCE-024 残した項目からの再開
SP-BPCONFORMANCE-023 で止まった run から再開した run は、`docs/specifications/bp-run.md` の SP-BPRUN-035 の手順に従わなければならない。反すれば PR-BPDESIGNEDSKILL-019 を不適合とする。

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

どちらかに反すれば PR-BPDESIGNEDSKILL-022 を不適合とする。経路の選び方（native-first の契約）は `docs/specifications/bp-entry.md` を正とする。

## 性能・容量（対象スキルに課す確定値）

本章の値は、設計方針文書が「（暫定）」とした値と規則を確定したものである。review の仕様の観点（PR-BPOPERATIONS-025）はこの章に照らす。best-practices 自身の実行も同じ値に従う（役ごとのモデルと effort は SP-BPCONFORMANCE-035 の best-practices の表に従う）。`docs/specifications/bp-run.md` は本章の SP ID を参照し、値を書き写さない。

#### SP-BPCONFORMANCE-027 同時実行の上限
対象スキルの Workflow script で同時に走る agent は、3 体以下でなければならない（設計方針文書「体数と同時実行」の表の初期値）。残りは枠が空くまで待たせ、切り捨ててはならない。守らせ方（runtime の設定か script か）は対象スキルの実装が決める。判定する者は同時に走る数と待たせることを判定し、守らせ方が runtime の設定か script かで適合・不適合を分けてはならない。best-practices 自身にも同じ同時実行の上限を適用しなければならない。

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
対象スキルの Workflow script は、全ての `agent()` 呼び出しで `model` と `effort` を指定しなければならない（省略すると、セッションのモデルを体数分継承する）。判定する者は、PR-BPDESIGNEDSKILL-009 の判定の単位を、全ての `agent()` 呼び出しに `model` と `effort` の option があるかで判定しなければならない。option の値は名前付きの定数を通してもよく、どの値かは照らさない（設計方針文書「モデル・effort・prompt」の節の役ごとの初期値の表、モデルを変えたときの effort の測り直しの行、xhigh と max を使ってよい役を限る行にも照らさない：PR-BPDESIGNEDSKILL-009）。この 3 つの行の判定の単位（PR-BPDESIGNEDSKILL-009 の単位：SP-BPCONFORMANCE-013）には、照らさずに「適合」を付ける（役ごとのモデルと effort への適合は PR-BPDESIGNEDSKILL-009 の単位だけが表し、SP-BPCONFORMANCE-038 の判定できない単位には当たらない）。全ての呼び出しにあれば適合、1 つでも欠ければ不適合とし、欠けた呼び出しの場所（パスと行）を理由に書く。script を読めず決められないときは SP-BPCONFORMANCE-038 の未検査とする。

best-practices 自身の役の値は、次の表とする（依頼者の裁定が優先する。eval で決め直す）。`docs/specifications/bp-run.md` の SP-BPRUN-023 と `docs/specifications/bp-entry.md` の SP-BPENTRY-016 はこの表を参照し、値を書き写さない。

| best-practices の役 | `model` | `effort` |
|---|---|---|
| 書き手 | `opus` | `high` |
| 検証役 | `opus` | `high` |
| 反証役 | `opus` | `high` |
| 抽出役 | `sonnet` | `medium` |
| 運搬役 | `haiku` | `low` |

#### SP-BPCONFORMANCE-036 確定値の置き方
確定値は一箇所を正本とし、対象スキルはそれを参照しなければならない。同じ値を複数の正本へ書き写してはならない。異なる値なら仕様の観点で不適合とするが、役ごとのモデル・effort の値は SP-BPCONFORMANCE-035 の例外に従わなければならない。

値を変える場合は eval で測り、確定値の正本と設計方針文書へ反映してから適用しなければならない。内部の定数名と保存先の選択は実装の設計で決める。

## エラー処理と異常系

本書の機能に固有の異常系だけを置く。agent の失敗・続けられない失敗・途中終了は `docs/specifications/bp-run.md` を正とする。

#### SP-BPCONFORMANCE-038 判定の単位を判定できないとき
判定の単位に当たる記述が対象スキルに見つからず、適合とも不適合とも決められないとき、判定する者は、その単位に理由を付けて「未検査」を付けなければならない（SP-BPCONFORMANCE-018）。「適合」としてはならない。

## 検証方法

形・資産台帳・fan-out と各判定条件を組み合わせ、適合する対象と単位ごとの違反を持つ対象で、適用・判定結果・未検査・指摘を照合する。形を分けた場合、重い形の根拠、判断点の公開された表構文、host の制限の既知不適合と未確認、上限あり/なし・不正/最小未満、モデル/effort の有無と値だけの差を含める。

判断点の照合は表の全ての行と、列挙の網羅や理由の意味を調べない例を検査する。確定値と上限は実際に境界へ達する試験で照合する。評価の意味の質は bp-authoring の本物の agent の試走で確認し、模擬判定や有限表の検査で代用しない。

検証方法の読み方と、決定的な検査・意味の判定・不適用の区別は、bp-run.md の「検証方法」を参照する。方法の正本は次の表の各 SP の 1 行とし、トレーサビリティ表は同じ方法を複製せずその行を参照する。

| 仕様項目 ID | 手段 | 入力と観測（条件・境界） |
|---|---|---|
| SP-BPCONFORMANCE-001 | 参照経路の静的照合・適合 fixture 比較 | create/update/review が同じ基準版と SP を参照し、基準を各 prompt へ別文で複製しないことを確認する。同じ違反題材の判定も比較する。 |
| SP-BPCONFORMANCE-002 | 判定単位の決定的照合 | 参照する原則表の全行を独立に列挙し、得られた単位と 1 行 1 結果の対応を照合する。行の欠落・重複と別基準版を与える負例も含める。 |
| SP-BPCONFORMANCE-003 | 適用表の全組テスト | 形・台帳・ fan-out の全組と W による run 分割、共有資産を与え、適用 SP ・不適合・対象外・複数 run の畳込みを照合する。要求統合で単位が広がる負例も試す。 |
| SP-BPCONFORMANCE-041 | 表構文の全組 fixture テスト | 見出し 0/1/複数、区切りの有無、2 セル/欠落/空欄、空表、フェンス内例、範囲外、読取不能を与え判定表と理由を照合する。理由の意味や列挙の網羅だけで結果を変えず、機能別の未確認開示 1 件も確認する。 |
| SP-BPCONFORMANCE-004 | 形の決定表の全組テスト・フローの独立レビュー | A/W/Q の有効・到達不能の全並びを与え、最初の到達形と拒否を照合する。実題材の答えの妥当性と未分割 run の違反は別 context で確認する。 |
| SP-BPCONFORMANCE-005 | 探索適用の独立 fixture レビュー | 4 適用条件が全成立/1 つずつ不成立、1agent の 1 回で解ける題材を与え、Q3 の答えと形を確認する。例示題材の分類だけを普遍的な判定証明にしない。 |
| SP-BPCONFORMANCE-006 | 根拠有無表の全組テスト・説明の独立レビュー | 重い run なし/あり、複数 run の説明完備/一部欠落を与え、適合か欠落 run 付き不適合を照合する。答えを強いた実際のフローの事実は原文と比較する。 |
| SP-BPCONFORMANCE-007 | Workflow 有無の静的 fixture 検査 | ターンごとの指揮の対象に、自 plugin/対象内 script や callsite を個別に足し、不適合になることを確認する。W で分けた該当 run だけを見る例も含める。 |
| SP-BPCONFORMANCE-008 | 部品と設計説明の独立レビュー | 各段が定義に合う題材、部品の例に無いが戻りの無い題材、戻りや名前/理由欠落の題材を比較し、部品の定義と説明の対応を判定する。 |
| SP-BPCONFORMANCE-009 | 台帳適用の全組テスト | fan-out と確認範囲の宣言の要否、実際の台帳あり/なしを組み合わせ、必要/不要の両違反を照合する。記録台帳の存在を資産台帳と混同しない題材も使う。 |
| SP-BPCONFORMANCE-039 | 記録要求表の行別 fixture 検査 | 各行の必要性質を 1 つずつ欠かした対象と準拠対象を与え、該当単位だけの不適合を確認する。原文の必要欄・保持・保存失敗・性能と未確認の扱いも照合する。 |
| SP-BPCONFORMANCE-040 | 保存先だけを変える同値テスト | 内容と記録能力が同じ対象で保存先だけを変え、039 の判定が変わらないことを確認する。BP 自身は RUN007/039 の裁定済み保存先を別に照合する。 |
| SP-BPCONFORMANCE-010 | 目標原則の独立 fixture レビュー | 原則表の各行を 1 つずつ欠く目標と準拠目標を与え、同じ単位で対象スキルと create の目標固定を判定する。数値や出所の決定部分は機械で照合する。 |
| SP-BPCONFORMANCE-011 | 停止・再開の結合テスト・規範レビュー | 入力不足、待たれない入力、保存後の再開を題材に、原則表の各行に沿う停止/材料/再開を確認する。run 内で入力待ちする違反題材も比較する。 |
| SP-BPCONFORMANCE-012 | 実行履歴の数値照合・原則レビュー | 複数項目を走らせ、同時実行上限と待機後の全件処理を観測する。体数決め打ち・項目切捨ての負例を原則表の単位で確認する。 |
| SP-BPCONFORMANCE-013 | 設定の静的照合・ prompt の独立レビュー | 各役の model/effort の有無は 035 で判定し、prompt が原則表の入力を満たすかを別 context で読む。裁定で除外した値・測直し・役限定だけでは不適合にしないことも確認する。 |
| SP-BPCONFORMANCE-014 | 権限境界のテスト・原則レビュー | 書く/書かない各役に許可/禁止操作を試し、原則表の権限と分離を確認する。host での確認結果は 019/020 の表へ照合し、設定の存在だけを実効性としない。 |
| SP-BPCONFORMANCE-015 | 探索 fixture の履歴照合・原則レビュー | 計画・実行・回収・検証・停止と検証方式の各表の行を、準拠/違反題材で照合する。回数/乾きは確定値の試験、意味の受理は独立レビューで分ける。 |
| SP-BPCONFORMANCE-034 | 時間制限の判定表テスト・ host 確認 | 探索型/非探索型、時間値の有無、Codex/native 経路の有無と確認可否を全組で与え、値・制限・強制不能開示と判定結果を照合する。 |
| SP-BPCONFORMANCE-016 | 共有状態の更新・再送テスト | 不正 ID、競合、同内容再送、遅延更新、中断を与え、原則表の状態更新・受理分離・追記・決定的要約を照合する。要約の字数は 033 で確認する。 |
| SP-BPCONFORMANCE-017 | 資産台帳の数値・参照テスト・原則レビュー | 安定 ID、結果の結付け、確認範囲と skip を複数資産の fixture で照合する。担当範囲が依存を欠く負例は独立に読み、本文が参照する全原則行へ対応付ける。 |
| SP-BPCONFORMANCE-018 | 判定結果集合の受理・公開 schema テスト | 適用単位を全件持つ結果と、単位/結果/理由の欠落を与え、無判定を残さないことと機能別の全単位結果・指摘・未検査への出力対応を照合する。 |
| SP-BPCONFORMANCE-019 | host 確認表の全組テスト | Claude の文書/名前付き一覧の可読性、一覧への依存、Codex の未確認を組み合わせ、適合/既知不適合/強いられた未検査と全未確認を照合する。一覧の見出しだけの有無で判定を変えないことも見る。 |
| SP-BPCONFORMANCE-020 | 未確認制限の公開結果テスト | 一覧で確認済みの Claude 制限と未読時の全制限、Codex の全制限を与え、役・制限・ host ・理由の 4 項目が未確認だけに出ることを確認する。 |
| SP-BPCONFORMANCE-021 | 対象スキルの入力 schema 検査 | 上限欄の省略/正整数、受取口の不存在、綴りの宣言欠落を持つ題材を与え、入力契約と適合判定を照合する。不正な値の停止は 037 で確認する。 |
| SP-BPCONFORMANCE-037 | 不正上限の境界テスト | 正整数でない値と最小に満たない値を渡し、対象スキルが RUN037 どおり agent0 の BLOCKED ・理由と状態不変更を返すことを確認する。 |
| SP-BPCONFORMANCE-022 | 並行作業と残枠の結合テスト | 実行中の残呼出し・新項目最悪・停止分の共有枠を競合させ、ちょうど収まる/1 回不足の境界で新規起動と停止記録が上限を超えないことを独立計数する。 |
| SP-BPCONFORMANCE-023 | 上限不足と順位の結合テスト | 一部処理後に次項目が収まらない条件を与え、新規停止・開始済み終了・順位付き全残件・上限/起動数/件数を確認する。1 件も始められない条件は RUN037 へ分ける。 |
| SP-BPCONFORMANCE-024 | 未着手からの再開テスト | 上限停止後に新 run を起動し、保存した順位の残りだけを処理して結果ありを再処理しないことを確認する。host ごとの上限授受と追加検証例外も照合する。 |
| SP-BPCONFORMANCE-025 | 上限なしの増量・静的検査 | 入力項目を増やし、固定件数での切捨てや固定起動数停止が無いことを確認する。同時実行待ちと反復/試行の停止は別に許されることを原則と照合する。 |
| SP-BPCONFORMANCE-026 | 経路と上限授受の全組テスト | native/Codex、上限なし/あり、host 上限の直前/一致/超過を組み合わせ、Codex の必要上限と native の禁止、同じ要求 ID への不適合を照合する。 |
| SP-BPCONFORMANCE-027 | 並行実行の境界テスト | 同時実行の上限を超える件数を投入し、実際の同時数が上限以下で、残りが待機して完了することを観測する。runtime 設定/対象制御の方式差だけで判定を変えない。 |
| SP-BPCONFORMANCE-028 | until-pass の回数境界テスト | 初回成功、上限直前成功、上限で不合格を返す項目を与え、最初を含む回数と最後の未達理由を照合する。 |
| SP-BPCONFORMANCE-029 | 固定集合反復の回数境界テスト | 反復ごとの合否を制御し、初回/上限直前/一致での成功と未達停止を確認する。create/update への適用と再開後の増分は AUTHOR024/RUN013 に照合する。 |
| SP-BPCONFORMANCE-030 | 探索の周数境界テスト | 上限の直前/一致で完了する探索と、上限で未完の探索を与え、周数と反復上限停止を履歴で確認する。 |
| SP-BPCONFORMANCE-031 | 試行数と再開の境界テスト | 同じ意図/項目が結果を返さない題材で、初回を含む上限までの試行・打切り・理由を確認する。途中再開でも試行累計を数え直さないことを照合する。 |
| SP-BPCONFORMANCE-032 | 乾き条件の決定表・履歴テスト | 新受理、空振り、既知、却下、全件失敗、未読ヒントを組み合わせ、連続した乾きの境界と同方向再確認の許容回数を照合する。 |
| SP-BPCONFORMANCE-033 | 要約字数の境界テスト | 要約の長さを上限直前/一致/超過にする状態を与え、上限以下の字数と省いた種類/件数の宣言を独立計数する。元記録の保持も確認する。 |
| SP-BPCONFORMANCE-035 | 全起動の静的検査・値差分 fixture | model/effort の全指定と 1 欄欠落を比較し、値だけの変更では対象の適合を変えないことを確認する。BP 自身の役の値は本項の表との一致を別に照合する。 |
| SP-BPCONFORMANCE-036 | 確定値の参照・改定手順レビュー | 同じ値を参照する題材と二重正本/異値の題材で適合を比べる。値改定では eval 結果から正本と上位方針へ反映されているかを確認し、モデル値の例外も照合する。 |
| SP-BPCONFORMANCE-038 | 判定不能の独立 fixture レビュー・公開結果テスト | 根拠記述の欠落/読取不能と、明示的な適合/違反を持つ題材を比較し、前者だけが理由付き未検査となり、適合にすり替わらないことを確認する。 |

## トレーサビリティ表

整理後の契約を実装が満たすかは未検証である。旧版のテストの「完了」を持ち越さず、各行は現契約に対応する実行証拠が得られてから更新する。

| 要求 ID | 仕様項目 ID | 検証方法 | ステータス |
|---|---|---|---|
| PR-BPDESIGNEDSKILL-001 | SP-BPCONFORMANCE-001 | [検証方法](#検証方法) の SP-BPCONFORMANCE-001 行 | 未着手 |
| PR-BPOPERATIONS-008 | SP-BPCONFORMANCE-001 | [検証方法](#検証方法) の SP-BPCONFORMANCE-001 行 | 未着手 |
| PR-BPOPERATIONS-024 | SP-BPCONFORMANCE-001 | [検証方法](#検証方法) の SP-BPCONFORMANCE-001 行 | 未着手 |
| PR-BPDESIGNEDSKILL-006 | SP-BPCONFORMANCE-002 | [検証方法](#検証方法) の SP-BPCONFORMANCE-002 行 | 未着手 |
| PR-BPDESIGNEDSKILL-007 | SP-BPCONFORMANCE-002 | [検証方法](#検証方法) の SP-BPCONFORMANCE-002 行 | 未着手 |
| PR-BPOPERATIONS-024 | SP-BPCONFORMANCE-002 | [検証方法](#検証方法) の SP-BPCONFORMANCE-002 行 | 未着手 |
| PR-BPDESIGNEDSKILL-001 | SP-BPCONFORMANCE-003 | [検証方法](#検証方法) の SP-BPCONFORMANCE-003 行 | 未着手 |
| PR-BPDESIGNEDSKILL-009 | SP-BPCONFORMANCE-003 | [検証方法](#検証方法) の SP-BPCONFORMANCE-003 行 | 未着手 |
| PR-BPDESIGNEDSKILL-028 | SP-BPCONFORMANCE-003 | [検証方法](#検証方法) の SP-BPCONFORMANCE-003 行 | 未着手 |
| PR-BPDESIGNEDSKILL-046 | SP-BPCONFORMANCE-003 | [検証方法](#検証方法) の SP-BPCONFORMANCE-003 行 | 未着手 |
| PR-BPDESIGNEDSKILL-051 | SP-BPCONFORMANCE-003 | [検証方法](#検証方法) の SP-BPCONFORMANCE-003 行 | 未着手 |
| PR-BPOPERATIONS-024 | SP-BPCONFORMANCE-003 | [検証方法](#検証方法) の SP-BPCONFORMANCE-003 行 | 未着手 |
| PR-BPDESIGNEDSKILL-051 | SP-BPCONFORMANCE-041 | [検証方法](#検証方法) の SP-BPCONFORMANCE-041 行 | 未着手 |
| PR-BPDESIGNEDSKILL-001 | SP-BPCONFORMANCE-004 | [検証方法](#検証方法) の SP-BPCONFORMANCE-004 行 | 未着手 |
| PR-BPOPERATIONS-008 | SP-BPCONFORMANCE-005 | [検証方法](#検証方法) の SP-BPCONFORMANCE-005 行 | 未着手 |
| PR-BPDESIGNEDSKILL-002 | SP-BPCONFORMANCE-006 | [検証方法](#検証方法) の SP-BPCONFORMANCE-006 行 | 未着手 |
| PR-BPDESIGNEDSKILL-001 | SP-BPCONFORMANCE-007 | [検証方法](#検証方法) の SP-BPCONFORMANCE-007 行 | 未着手 |
| PR-BPDESIGNEDSKILL-001 | SP-BPCONFORMANCE-008 | [検証方法](#検証方法) の SP-BPCONFORMANCE-008 行 | 未着手 |
| PR-BPDESIGNEDSKILL-001 | SP-BPCONFORMANCE-009 | [検証方法](#検証方法) の SP-BPCONFORMANCE-009 行 | 未着手 |
| PR-BPDESIGNEDSKILL-028 | SP-BPCONFORMANCE-039 | [検証方法](#検証方法) の SP-BPCONFORMANCE-039 行 | 未着手 |
| PR-BPDESIGNEDSKILL-029 | SP-BPCONFORMANCE-039 | [検証方法](#検証方法) の SP-BPCONFORMANCE-039 行 | 未着手 |
| PR-BPDESIGNEDSKILL-032 | SP-BPCONFORMANCE-039 | [検証方法](#検証方法) の SP-BPCONFORMANCE-039 行 | 未着手 |
| PR-BPDESIGNEDSKILL-034 | SP-BPCONFORMANCE-039 | [検証方法](#検証方法) の SP-BPCONFORMANCE-039 行 | 未着手 |
| PR-BPDESIGNEDSKILL-035 | SP-BPCONFORMANCE-039 | [検証方法](#検証方法) の SP-BPCONFORMANCE-039 行 | 未着手 |
| PR-BPDESIGNEDSKILL-036 | SP-BPCONFORMANCE-039 | [検証方法](#検証方法) の SP-BPCONFORMANCE-039 行 | 未着手 |
| PR-BPDESIGNEDSKILL-040 | SP-BPCONFORMANCE-039 | [検証方法](#検証方法) の SP-BPCONFORMANCE-039 行 | 未着手 |
| PR-BPDESIGNEDSKILL-029 | SP-BPCONFORMANCE-040 | [検証方法](#検証方法) の SP-BPCONFORMANCE-040 行 | 未着手 |
| PR-BPDESIGNEDSKILL-006 | SP-BPCONFORMANCE-010 | [検証方法](#検証方法) の SP-BPCONFORMANCE-010 行 | 未着手 |
| PR-BPOPERATIONS-003 | SP-BPCONFORMANCE-010 | [検証方法](#検証方法) の SP-BPCONFORMANCE-010 行 | 未着手 |
| PR-BPDESIGNEDSKILL-007 | SP-BPCONFORMANCE-011 | [検証方法](#検証方法) の SP-BPCONFORMANCE-011 行 | 未着手 |
| PR-BPDESIGNEDSKILL-008 | SP-BPCONFORMANCE-012 | [検証方法](#検証方法) の SP-BPCONFORMANCE-012 行 | 未着手 |
| PR-BPDESIGNEDSKILL-009 | SP-BPCONFORMANCE-013 | [検証方法](#検証方法) の SP-BPCONFORMANCE-013 行 | 未着手 |
| PR-BPDESIGNEDSKILL-010 | SP-BPCONFORMANCE-014 | [検証方法](#検証方法) の SP-BPCONFORMANCE-014 行 | 未着手 |
| PR-BPDESIGNEDSKILL-011 | SP-BPCONFORMANCE-015 | [検証方法](#検証方法) の SP-BPCONFORMANCE-015 行 | 未着手 |
| PR-BPDESIGNEDSKILL-011 | SP-BPCONFORMANCE-034 | [検証方法](#検証方法) の SP-BPCONFORMANCE-034 行 | 未着手 |
| PR-BPDESIGNEDSKILL-012 | SP-BPCONFORMANCE-016 | [検証方法](#検証方法) の SP-BPCONFORMANCE-016 行 | 未着手 |
| PR-BPDESIGNEDSKILL-013 | SP-BPCONFORMANCE-017 | [検証方法](#検証方法) の SP-BPCONFORMANCE-017 行 | 未着手 |
| PR-BPOPERATIONS-008 | SP-BPCONFORMANCE-018 | [検証方法](#検証方法) の SP-BPCONFORMANCE-018 行 | 未着手 |
| PR-BPOPERATIONS-024 | SP-BPCONFORMANCE-018 | [検証方法](#検証方法) の SP-BPCONFORMANCE-018 行 | 未着手 |
| PR-BPDESIGNEDSKILL-014 | SP-BPCONFORMANCE-019 | [検証方法](#検証方法) の SP-BPCONFORMANCE-019 行 | 未着手 |
| PR-BPDESIGNEDSKILL-046 | SP-BPCONFORMANCE-019 | [検証方法](#検証方法) の SP-BPCONFORMANCE-019 行 | 未着手 |
| PR-BPDESIGNEDSKILL-014 | SP-BPCONFORMANCE-020 | [検証方法](#検証方法) の SP-BPCONFORMANCE-020 行 | 未着手 |
| PR-BPDESIGNEDSKILL-015 | SP-BPCONFORMANCE-020 | [検証方法](#検証方法) の SP-BPCONFORMANCE-020 行 | 未着手 |
| PR-BPDESIGNEDSKILL-016 | SP-BPCONFORMANCE-021 | [検証方法](#検証方法) の SP-BPCONFORMANCE-021 行 | 未着手 |
| PR-BPDESIGNEDSKILL-016 | SP-BPCONFORMANCE-037 | [検証方法](#検証方法) の SP-BPCONFORMANCE-037 行 | 未着手 |
| PR-BPDESIGNEDSKILL-016 | SP-BPCONFORMANCE-022 | [検証方法](#検証方法) の SP-BPCONFORMANCE-022 行 | 未着手 |
| PR-BPDESIGNEDSKILL-019 | SP-BPCONFORMANCE-023 | [検証方法](#検証方法) の SP-BPCONFORMANCE-023 行 | 未着手 |
| PR-BPDESIGNEDSKILL-019 | SP-BPCONFORMANCE-024 | [検証方法](#検証方法) の SP-BPCONFORMANCE-024 行 | 未着手 |
| PR-BPDESIGNEDSKILL-021 | SP-BPCONFORMANCE-025 | [検証方法](#検証方法) の SP-BPCONFORMANCE-025 行 | 未着手 |
| PR-BPDESIGNEDSKILL-022 | SP-BPCONFORMANCE-026 | [検証方法](#検証方法) の SP-BPCONFORMANCE-026 行 | 未着手 |
| PR-BPDESIGNEDSKILL-008 | SP-BPCONFORMANCE-027 | [検証方法](#検証方法) の SP-BPCONFORMANCE-027 行 | 未着手 |
| PR-BPOPERATIONS-025 | SP-BPCONFORMANCE-027 | [検証方法](#検証方法) の SP-BPCONFORMANCE-027 行 | 未着手 |
| PR-BPOPERATIONS-025 | SP-BPCONFORMANCE-028 | [検証方法](#検証方法) の SP-BPCONFORMANCE-028 行 | 未着手 |
| PR-BPOPERATIONS-011 | SP-BPCONFORMANCE-029 | [検証方法](#検証方法) の SP-BPCONFORMANCE-029 行 | 未着手 |
| PR-BPOPERATIONS-025 | SP-BPCONFORMANCE-029 | [検証方法](#検証方法) の SP-BPCONFORMANCE-029 行 | 未着手 |
| PR-BPDESIGNEDSKILL-011 | SP-BPCONFORMANCE-030 | [検証方法](#検証方法) の SP-BPCONFORMANCE-030 行 | 未着手 |
| PR-BPOPERATIONS-025 | SP-BPCONFORMANCE-030 | [検証方法](#検証方法) の SP-BPCONFORMANCE-030 行 | 未着手 |
| PR-BPDESIGNEDSKILL-011 | SP-BPCONFORMANCE-031 | [検証方法](#検証方法) の SP-BPCONFORMANCE-031 行 | 未着手 |
| PR-BPOPERATIONS-025 | SP-BPCONFORMANCE-031 | [検証方法](#検証方法) の SP-BPCONFORMANCE-031 行 | 未着手 |
| PR-BPDESIGNEDSKILL-011 | SP-BPCONFORMANCE-032 | [検証方法](#検証方法) の SP-BPCONFORMANCE-032 行 | 未着手 |
| PR-BPOPERATIONS-025 | SP-BPCONFORMANCE-032 | [検証方法](#検証方法) の SP-BPCONFORMANCE-032 行 | 未着手 |
| PR-BPDESIGNEDSKILL-012 | SP-BPCONFORMANCE-033 | [検証方法](#検証方法) の SP-BPCONFORMANCE-033 行 | 未着手 |
| PR-BPOPERATIONS-025 | SP-BPCONFORMANCE-033 | [検証方法](#検証方法) の SP-BPCONFORMANCE-033 行 | 未着手 |
| PR-BPDESIGNEDSKILL-009 | SP-BPCONFORMANCE-035 | [検証方法](#検証方法) の SP-BPCONFORMANCE-035 行 | 未着手 |
| PR-BPOPERATIONS-025 | SP-BPCONFORMANCE-036 | [検証方法](#検証方法) の SP-BPCONFORMANCE-036 行 | 未着手 |
| PR-BPOPERATIONS-008 | SP-BPCONFORMANCE-038 | [検証方法](#検証方法) の SP-BPCONFORMANCE-038 行 | 未着手 |
| PR-BPOPERATIONS-024 | SP-BPCONFORMANCE-038 | [検証方法](#検証方法) の SP-BPCONFORMANCE-038 行 | 未着手 |
