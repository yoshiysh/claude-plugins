# 仕様書: review と audit の観点と流れ

本文書は次の文書と同じ一式として扱う。相互に参照する記述は、この一式が揃っていることを前提とする。

- `docs/requirements/bp-operations.md`
- `docs/requirements/bp-designed-skill.md`
- `docs/design/skill-design-patterns.md`（以下「設計方針文書」）
- `docs/specifications/bp-entry.md`
- `docs/specifications/bp-authoring.md`
- `docs/specifications/bp-inspection.md`（本文書）
- `docs/specifications/bp-findings.md`
- `docs/specifications/bp-run.md`
- `docs/specifications/bp-conformance.md`

## 表記規約

本文書の仕様項目の語尾の区分は、`docs/requirements/bp-operations.md` の「表記規約」に従う。

## 対象範囲

本仕様書は、review と audit の観点と流れを定める。扱うのは、2 機能の段の並び、観点の集合と照らす先、review のフローの観点・仕様の観点、仕様書を読めないときの扱い、audit の監査の観点の一覧と範囲と優先、担当の作り方と検証役・反証役の起動、対象を書き換えないこと、review・audit の入力と、2 機能に固有の結果の項目である。本文書は `####` 見出し 1 つを 1 仕様項目とする。

### 本文書が実現する要求

- 主担当: `docs/requirements/bp-operations.md` の PR-BPOPERATIONS-024〜030・PR-BPOPERATIONS-047・PR-BPOPERATIONS-050
- 併せて実現: PR-BPOPERATIONS-031・PR-BPOPERATIONS-033・PR-BPOPERATIONS-034（検証役と反証役をいつ起動するか、担当の作り方。`docs/specifications/bp-findings.md` の「他の仕様書との境界」が本文書に任せた分）、`docs/requirements/bp-designed-skill.md` の PR-BPDESIGNEDSKILL-051（review での判断点の表の照合の結果の返し方。主担当は `docs/specifications/bp-conformance.md`）

### 他の仕様書との境界

| 事項 | 正となる文書 |
|---|---|
| 判定基準（フローの観点が当てる基準と、仕様の観点が照らす確定値） | `docs/specifications/bp-conformance.md`（SP-BPCONFORMANCE-001。本文書は ID で参照し、書き写さない） |
| 資産・台帳・指摘の ID・反証の記録・指摘の状態・カバレッジ・skip 一覧・skip 一覧への追加の起動・結果に載せる指摘と台帳の項目 | `docs/specifications/bp-findings.md` |
| run の境界・状態・停止の種類・再開・CLI の操作・役ごとのモデルと effort と権限・起動数の上限・共通の異常系 | `docs/specifications/bp-run.md` |
| 依頼の振り分けと、review・audit の結果を update へ渡す手順 | `docs/specifications/bp-entry.md` |

## 用語定義

用語は `docs/requirements/bp-operations.md` の「用語」を正とし、複数の仕様書で使う語は `docs/specifications/bp-run.md` の用語定義に、台帳の語は `docs/specifications/bp-findings.md` の用語定義に従う。本表は本仕様書で足す語だけを持つ。

| 語 | 定義 |
|---|---|
| 照らす先 | 観点ごとに検証役が当てる基準の出所のファイルと、その中の章・節（SP-BPINSPECTION-004） |
| 照らす先の指紋 | 照らす先のファイルの名前と内容から CLI が決定的に作る値（置き場のパスによらない） |
| 資産の束 | 台帳の資産を、資産 ID と行番号を付けて 1 つの作業ファイルに抜き出したもの（設計方針文書「資産台帳」の定義の箇条書き：根拠を行番号つきで 1 回だけ抜き出して各 agent に配る束） |
| 適用の判定 | review で、対象スキルのフローに形の判定の問いと、資産台帳・fan-out の有無を答えたもの（SP-BPINSPECTION-006） |
| 監査の観点の一覧 | audit の指摘の種類の閉集合。識別子（PA-1〜PA-6）は SP-BPINSPECTION-009 |
| 未検査の観点 | 観点の全体か一部を、照らさずに終えたことの宣言（形は SP-BPINSPECTION-025） |

## 機能仕様

### 形と段

#### SP-BPINSPECTION-001 段の並び
review と audit の Workflow script は、固定パイプライン型に、観点ごとの検証と反証の部品と資産台帳を足した形で組まなければならない（設計方針文書「形の判定」の例の着地の表：review は段と段の間に戻りが無い）。段は次の順に 1 回ずつ行わなければならない。段は「段」の列の名前で呼ぶ（「順」の列は並びを示すだけ）。段の agent が結果を返さなかったときの扱いは、段が fan-out の項目（`docs/specifications/bp-run.md` の用語定義）を持つかで決まる（SP-BPRUN-027・SP-BPRUN-028）。

| 順 | 段 | 部品 | 起動する役 | 機能 | 項目 | 定める項目 |
|---|---|---|---|---|---|---|
| 1 | 開始 | — | 運搬役 | review・audit | なし | `docs/specifications/bp-run.md` の SP-BPRUN-003 |
| 2 | 照らす先の決定 | — | 運搬役 | review・audit | なし | SP-BPINSPECTION-004 |
| 3 | 台帳の作成と資産の束 | — | 運搬役 | review・audit | なし | `docs/specifications/bp-findings.md` の SP-BPFINDINGS-001・SP-BPFINDINGS-005、SP-BPINSPECTION-017 |
| 4 | 担当の作成 | — | 抽出役・運搬役 | review・audit | なし | SP-BPINSPECTION-015 |
| 5 | 適用の判定 | — | 検証役・運搬役 | review だけ | なし | SP-BPINSPECTION-006 |
| 6 | 観点ごとの検証 | 観点ごとの検証（項目を並列化する） | 検証役・運搬役 | review・audit | 観点と担当の組（SP-BPINSPECTION-016）。skip 一覧への追加の起動では、観点と追加の起動の担当 | SP-BPINSPECTION-016・018、`docs/specifications/bp-findings.md` の SP-BPFINDINGS-025 |
| 7 | 反証 | 反証 | 反証役・運搬役 | review・audit | `docs/specifications/bp-findings.md` の SP-BPFINDINGS-012 でまとめた指摘の鍵 | SP-BPINSPECTION-018 |
| 8 | 消えた資産の照合 | 観点ごとの検証（項目を並列化する） | 検証役・運搬役 | review・audit | 照合を終えていない取り直しの回ごとに、その取り直しで消えた資産に結び付いた指摘ごと（`docs/specifications/bp-findings.md` の SP-BPFINDINGS-020） | `docs/specifications/bp-findings.md` の SP-BPFINDINGS-020・SP-BPFINDINGS-037 |
| 9 | 照合と停止 | — | 運搬役 | review・audit | なし | SP-BPINSPECTION-019、`docs/specifications/bp-run.md` の SP-BPRUN-026・SP-BPRUN-011 |

skip 一覧への追加の起動は、観点ごとの検証の段の中の部品として、段の slug `verify-extra` で記録する（`docs/specifications/bp-run.md` の SP-BPRUN-038）。

部品の列が「—」の段は、1 つの段からなり戻りの無い並びとして、設計方針文書「用語」の部品の定義に合う。best-practices の設計の説明は、この表の段と部品の対応を載せなければならない（`docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-008）。

#### SP-BPINSPECTION-002 段の間に戻りを置かない
review と audit の script は、ある段の結果によって、その段かそれより前の段へ戻ってはならない。観点ごとの検証の段の中の skip 一覧への追加の起動（`docs/specifications/bp-findings.md` の SP-BPFINDINGS-025）は、決まった資産の集合の残りに同じ段を当てるだけなので、戻りに数えない（設計方針文書「形の判定」）。この規則があるので、review・audit は反復の回数による反復の上限では止まらない。反復の上限を返すのは、起動数の上限で止まるときだけである（`docs/specifications/bp-run.md` の SP-BPRUN-010）。

### 観点

#### SP-BPINSPECTION-003 観点の集合
review と audit の観点は次の表のとおりとし、他の観点を足してはならない。指摘の種類の閉集合は `docs/specifications/bp-findings.md` の SP-BPFINDINGS-010 に従う。

| 機能 | 観点 | 照らす先 |
|---|---|---|
| review | フローの観点 | `docs/specifications/bp-conformance.md` の「機能仕様」の章と、そこが参照する設計方針文書の節（PR-BPOPERATIONS-024） |
| review | 仕様の観点 | `docs/specifications/bp-conformance.md` の「性能・容量（対象スキルに課す確定値）」の章（PR-BPOPERATIONS-025） |
| audit | 監査の観点 | 現行の prompt-audit（`docs/requirements/bp-operations.md` の用語）。best-practices のスキルのディレクトリの `references/prompt-audit.md` として読む |

表の行の順を、観点の順とする。review の 2 つの観点の照らす先は、run の中では `docs/specifications/bp-run.md` の SP-BPRUN-036 の判定基準の写しとして読む。

#### SP-BPINSPECTION-004 照らす先の決定
照らす先の決定の段で、script は運搬役を通じて CLI に、その機能の観点ごとに照らす先を読ませなければならない。CLI は観点ごとに、照らす先を読めたか、照らす先のファイルのパスと照らす先の指紋を状態に書き、読めた観点の集合を run の観点の集合として書かなければならない。読めたとするのは、照らす先の章・節の見出しがファイルにあり、その中に判定の単位（`docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-002）か監査の観点（SP-BPINSPECTION-009）が 1 件以上あるときだけとする。

review の照らす先のファイルは、`docs/specifications/bp-run.md` の SP-BPRUN-036 の判定基準の写しとする。照らす先の指紋には、照らす先の章・節のファイルに加えて、次の写しも含める。どれも run の中で判定に使い、停止の間に変わると、付けた指摘と判定の基準が 1 つの台帳の中で混ざる（SP-BPINSPECTION-029）。読めたかは、照らす先の章・節のファイルと、そこから判定の単位か監査の観点の一覧を作るのに要る写しで決める（フローの観点は bp-inspection の写しの除く単位の表が無いと判定の単位を作れないので、読めない。監査の観点は bp-inspection の写しの SP-BPINSPECTION-009 の表が読めないと、SP-BPINSPECTION-028 の食い違いとして止まる。bp-designed-skill の写しは読めたかに使わない）。

- フローの観点と監査の観点: 本文書の写し（除く単位の表：SP-BPINSPECTION-007、監査の観点の一覧：SP-BPINSPECTION-009、当て方：SP-BPINSPECTION-011〜SP-BPINSPECTION-013）
- 監査の観点: `docs/requirements/bp-designed-skill.md` の写し（SP-BPINSPECTION-012 が優先させる要求）

照らす先を読めない理由（SP-BPINSPECTION-027）は、欠けたファイルがあればそのパスを、無ければその観点の最初のファイルのパスを指す。run は、照らす先を照らす先の決定の段で読んだファイル以外から当ててはならず、当ててはならないものは同項に従う。

#### SP-BPINSPECTION-005 仕様書を読めないとき
照らす先の決定の段で仕様の観点の照らす先を読めなかったならば、script は、仕様の観点を run の観点の集合に入れてはならず、仕様の観点の全体を未検査の観点として結果に載せなければならない（PR-BPOPERATIONS-026）。このとき、仕様の観点の検証役を起動してはならない。カバレッジ・skip 一覧・skip 一覧への追加の起動は run の観点の集合の観点だけに作る（`docs/specifications/bp-findings.md` の SP-BPFINDINGS-022・SP-BPFINDINGS-023・SP-BPFINDINGS-025）ので、仕様の観点にはどれも作らない（観点を照らしていないことは、未検査の観点として 1 回だけ宣言する）。

### フローの観点

#### SP-BPINSPECTION-006 適用の判定
review の適用の判定の段で、script は検証役を 1 体起動し、対象スキルのフローについて次を答えさせなければならない。答えはどれも閉集合からの選択とし、答えごとに、その答えを示す箇所の資産 ID と行番号を添えた引用を返させる。

| 問い | 選択肢 | 判定基準 |
|---|---|---|
| 形の判定の問い A・W・Q1・Q2・Q3（問いの中身は `docs/specifications/bp-conformance.md` の用語定義。W は A の次の問い） | はい / いいえ / 問いに到達しない | `docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-004・SP-BPCONFORMANCE-005 |
| 資産台帳 | 有 / 無 | SP-BPCONFORMANCE-003 |
| fan-out | 有 / 無 | SP-BPCONFORMANCE-003 |

結果 `result` の `answers` は、A・W の `{answer, quotes}` を持つ。Q1・Q2・Q3 と資産台帳 `ledger`・fan-out `fanout` の置き場は、W の答えで次の表のとおりとする。

> 条件の値: W の答え = はい / いいえ / 問いに到達しない

| 条件: W の答え | 結果 |
|---|---|
| はい | `answers` は Q1・Q2・Q3 を持たず、`result` は `ledger`・`fanout` を持たず、`runs` を持つ |
| いいえ | `answers` は Q1・Q2・Q3 の `{answer, quotes}` を持ち、`result` は `ledger`・`fanout` の `{answer, quotes}` を持ち、`runs` を持たない |
| 問いに到達しない | 「いいえ」の行と同じ |

`runs` は `{run, answers, ledger, fanout, assets}` の並びとし、`answers` は Q1・Q2・Q3 の `{answer, quotes}`、`ledger`・`fanout` は `{answer, quotes}` とする。1 つ目の要素は run の並び（`docs/specifications/bp-conformance.md` の用語定義）で、`run` を `sequence` とする。2 つ目以降の要素は問い W で分けた各 run（対象スキルが run を分けていないときは、`docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-003 のとおり分けたもの）で、`run` はその run の名前（空でない文字列で、`runs` の中で一意で、`sequence` でない）とする。`assets` は、その run を実装する対象スキルの資産の資産 ID（状態の資産台帳にあるもの。run の Workflow script と、その run の `Workflow(` の callsite を持つ資産を含む）の重複の無い並びとする。資産の属する run と、2 つ以上の run に属する資産の判定の仕方は、`docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-003 の規則で決める。要素ごとの `ledger`・`fanout` は、SP-BPCONFORMANCE-003 が「実際に持つ」の範囲とした資産について答える。

受理する答えの並びと到達した形は次の表とする（設計方針文書「形の判定」の図の道）。「Q1・Q2・Q3 の並び」は、W がはいでないときは `answers` の Q1・Q2・Q3 を、W がはいのときは `runs` の要素ごとの Q1・Q2・Q3 を指す。

| A | Q1 | Q2 | Q3 | 到達した形 |
|---|---|---|---|---|
| いいえ | 問いに到達しない | 問いに到達しない | 問いに到達しない | ターンごとの指揮 |
| はい | はい | 問いに到達しない | 問いに到達しない | 固定パイプライン型 |
| はい | いいえ | はい | 問いに到達しない | 固定集合の反復型 |
| はい | いいえ | いいえ | はい | 探索グラフ型 |
| はい | いいえ | いいえ | いいえ | ターンごとの指揮 |

> 条件の値: A の答え = はい / いいえ
> 条件の値: W の答え = はい / いいえ / 問いに到達しない

| 条件: A の答え | 条件: W の答え | 結果 |
|---|---|---|
| いいえ | 問いに到達しない | `answers` の Q1・Q2・Q3 が全て問いに到達しないときだけ受理し、形はターンごとの指揮 |
| いいえ | はい | 受理しない |
| いいえ | いいえ | 受理しない |
| はい | いいえ | `answers` の Q1・Q2・Q3 の並びが上の表の A がはいの 4 行のどれかに当たるときだけ受理し、形はその行の形 |
| はい | はい | `runs` の要素が 3 つ以上（run の並びと、分けた 2 つ以上の run）で、要素ごとの Q1・Q2・Q3 の並びが上の表の A がはいの 4 行のどれかに当たるときだけ受理し、その行の形をその要素の形とする |
| はい | 問いに到達しない | 受理しない |

CLI は、次のどれかを含む結果の記録を拒否しなければならない（拒否した結果の扱いは `docs/specifications/bp-findings.md` の SP-BPFINDINGS-034）。

- 閉集合の外の答え
- 台帳に無い資産 ID（`runs` の要素の `assets` の資産 ID を含む）
- 上の 2 つの表で受理しない答えの並び（答えた問いを飛ばした並びと、形に到達した後の問いに答えた並びを含む：`docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-004）
- W の答えと合わない置き場（`answers` か `runs`）にある Q1・Q2・Q3・`ledger`・`fanout`
- W がはいなのに、要素が 3 つ未満の `runs`
- 1 つ目の要素の `run` が `sequence` でない `runs`
- 2 つ目以降の要素に、`run` が空か、重複するか、`sequence` である要素がある `runs`
- `assets` が、欠けているか、並びでないか、空の並びであるか、同じ資産 ID を 2 回以上含む要素がある `runs`（1 つ目の要素と 2 つ目以降の要素を同じに扱う。重複は 1 つの要素の `assets` の中で数え、同じ資産 ID が 2 つ以上の要素にあることは拒否しない）

CLI は、受理した答えを状態に書き、W がはいでないときは到達した形 `shape` と SP-BPCONFORMANCE-003 の判定表の行 `row` を、W がはいのときは `runs`（要素ごとの `{run, shape, row, assets}`）を状態に書かなければならない。判定の単位 `units` は全ての要素の行の判定の単位の和とし、判定の単位ごとの結果は 1 つとする（同じ単位を 2 つ以上の run で判定したときの結果のまとめ方は SP-BPCONFORMANCE-003）。

フローの観点の検証役には、W がはいでないときは形と資産台帳・fan-out の有無を、W がはいのときは `runs` の全ての要素の形と資産台帳・fan-out の有無と行と `assets` を、SP-BPCONFORMANCE-003 の判定表の条件として渡す。検証役は、それを使い、自分で答え直してはならず、資産の属する run を決め直してもならない（担当ごとに答えや資産の属する run が割れると、当たる要求が担当ごとに変わる）。

#### SP-BPINSPECTION-007 フローの観点の判定
フローの観点の検証役は、`docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-001・SP-BPCONFORMANCE-002・SP-BPCONFORMANCE-003・SP-BPCONFORMANCE-018・SP-BPCONFORMANCE-038 に従って、当たる要求の判定の単位に判定基準を当てなければならない。返し方は次のとおりとする。

- 担当の資産ごとの判定と指摘の候補は、`docs/specifications/bp-findings.md` の SP-BPFINDINGS-007 の形で返す。判定の結果が不適合の単位は、その単位を定める bp-conformance の仕様項目 ID と判定の単位の組（`docs/specifications/bp-findings.md` の SP-BPFINDINGS-010）を指摘の種類にした指摘の候補として、違反が現れている担当の資産に結び付けて返す。
- 判定の結果が未検査の単位は、単位と理由を未検査の観点の候補として返す（SP-BPINSPECTION-025）。

検証役は、判定のために担当の外の資産を読んでよい。判定を返すのは担当の資産だけにしなければならない。

フローの観点の検証役は、PR-BPDESIGNEDSKILL-014 の Claude Code の判定の単位と PR-BPDESIGNEDSKILL-046 の判定の単位を、create・update の適合の観点の検証役と同じく、`docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-019 の Claude Code の行と判定表で判定しなければならない。一覧の設定に頼る制限は、制限ごとに PR-BPDESIGNEDSKILL-046 の単位の指摘の候補にする（制限ごとの指摘の種類は `docs/specifications/bp-findings.md` の SP-BPFINDINGS-010）。同名の役（`docs/specifications/bp-findings.md` の SP-BPFINDINGS-010）の制限は照らさず、候補にもせず、`docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-019 のとおり強いられた未検査とした単位（`docs/specifications/bp-authoring.md` の用語「強いられた未検査」）を、未検査の観点の候補として返す（理由は SP-BPINSPECTION-025）。review は `checkedRoleLimits` を持たないので、効かない制限ごとに候補がそろっているかは検証役の判断だけで決まり、CLI は照らさない。一覧を読めないときに強いられた未検査とした単位（`docs/specifications/bp-authoring.md` の用語「強いられた未検査」）は、理由に保留の根拠と一覧を読めないことを書いて未検査の観点の候補として返す（SP-BPINSPECTION-025）。review は照らした制限 `checkedRoleLimits` と残る危険 `residualRisks` を返さない（PR-BPDESIGNEDSKILL-015 の報告は create・update の検証の結果に宛てたもの）。Codex runner の扱いは SP-BPCONFORMANCE-019 の Codex runner の行のとおりとする。

フローの観点の検証役は、`docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-041 の単位を判定してはならない（閉集合と単位からの除き方と拒否は `docs/specifications/bp-findings.md` の SP-BPFINDINGS-010）。この単位は、照合と停止の段で送る `placement`（`docs/specifications/bp-run.md` の SP-BPRUN-031。送る順は SP-BPINSPECTION-019）の記録で決まる。結果が適合なら何も載せず、未検査なら CLI が未検査の観点にする（SP-BPINSPECTION-025）。結果が不適合なら、CLI は、`placement` の `lines` が指す行を含む資産（`docs/specifications/bp-findings.md` の SP-BPFINDINGS-002）ごとに、次の指摘の候補を 1 件作らなければならない（依頼者の裁定）。`lines` が空のとき（見出し行が 0）は、対象スキルの根の `SKILL.md` の資産（`docs/specifications/bp-findings.md` の SP-BPFINDINGS-002）のうち、frontmatter の資産（位置 `{"k":"fm"}`）、最初の見出しより前の本文の資産（`{"k":"pre"}`）、文書の先頭から数えて最初の節の資産、の順で最初に台帳の今の資産にあるものに 1 件作る（同項の規則では、空白でない内容を持つ `SKILL.md` はこのどれかを必ず持つ）。`SKILL.md` の資産が台帳の今の資産に 1 つも無いとき（`SKILL.md` が空白だけのとき）は、台帳の今の資産のうち資産 ID の昇順で最初の資産に 1 件作る。

| 項目 | 値 |
|---|---|
| 資産 ID | その資産の資産 ID |
| 観点 | フローの観点 |
| 指摘の種類 | `SP-BPCONFORMANCE-041` |
| 引用 | その資産の中の `lines` の行の原文を、行番号を添えて並べたもの。`lines` が空のときは空の文字列 |
| 内容 | `placement` の `reason` |
| 直し方 | 判断点の表を `docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-041 の判定表の適合の行に当たる形に直すこと（文言は CLI の定数に置く） |

この候補の記録（反証を経ないこと、台帳に同じ鍵があるときの扱い、担当の指紋の組）は `docs/specifications/bp-findings.md` の SP-BPFINDINGS-014 の最後の段落に従う。指摘の鍵・指摘 ID と run をまたぐ扱いは、他の指摘と同じく同文書に従う。

`docs/specifications/bp-conformance.md` の「機能仕様」の章の仕様項目が「性能・容量（対象スキルに課す確定値）」の章の仕様項目の値で判定するとした行（SP-BPCONFORMANCE-012 の同時実行の行を含む。全ての行は下の除く単位の表）は、フローの観点の判定の単位にしてはならず、仕様の観点の判定の単位（SP-BPINSPECTION-008）としてだけ判定する（両方の観点が判定すると、同じ違反が観点の違う 2 件の指摘になる。指摘の鍵は観点を含むので、CLI は観点をまたいで指摘をまとめない：`docs/specifications/bp-findings.md` の SP-BPFINDINGS-011）。この規則は review にだけ当てる（create・update は仕様の観点を持たないので、適合の観点が値の行も判定する）。

除く単位は次の表とする（単位の値は `docs/specifications/bp-findings.md` の SP-BPFINDINGS-010 の判定の単位の値）。CLI はこの表を判定基準の写しから読み、review のフローの観点の閉集合と適用の判定の行の単位から除く。表の行は、bp-conformance の「機能仕様」の章で「SP-BPCONFORMANCE-0xx（の値）で判定する」とした文のうち、参照先が「性能・容量（対象スキルに課す確定値）」の章の仕様項目であるものの主語の行である。SP-BPCONFORMANCE-013 の「役ごとのモデルと effort は、SP-BPCONFORMANCE-035 で判定する」は、除く単位を持たない（SP-BPCONFORMANCE-035 は、フローの観点が判定表で当たる PR-BPDESIGNEDSKILL-048 の判定の単位として判定し、仕様の観点の判定の単位にしない：SP-BPINSPECTION-008）。

| 除く単位 | 判定する仕様の観点の仕様項目 |
|---|---|
| `SP-BPCONFORMANCE-012/体数と同時実行/t1/r3` | SP-BPCONFORMANCE-027 |
| `SP-BPCONFORMANCE-015/探索グラフ/計画役/t1/r9` | SP-BPCONFORMANCE-032 |
| `SP-BPCONFORMANCE-015/探索グラフ/停止/t1/r1` | SP-BPCONFORMANCE-030 |
| `SP-BPCONFORMANCE-015/探索グラフ/停止/t1/r4` | SP-BPCONFORMANCE-032 |
| `SP-BPCONFORMANCE-015/探索グラフ/停止/t1/r7` | SP-BPCONFORMANCE-031 |
| `SP-BPCONFORMANCE-016/状態の書き込み/t1/r12` | SP-BPCONFORMANCE-033 |

#### SP-BPINSPECTION-008 仕様の観点の判定
仕様の観点の検証役は、`docs/specifications/bp-conformance.md` の「性能・容量（対象スキルに課す確定値）」の章の仕様項目のうち SP-BPCONFORMANCE-035 を除いたものを 1 つずつ判定の単位とし（SP-BPCONFORMANCE-002）、対象スキルの値と規則をその章に照らさなければならない（PR-BPOPERATIONS-025）。SP-BPCONFORMANCE-035 は、フローの観点が判定表で当たる PR-BPDESIGNEDSKILL-048 の判定の単位として判定する（SP-BPINSPECTION-007）。不適合の単位は、その仕様項目 ID を指摘の種類にした指摘の候補として返し、未検査の単位は SP-BPINSPECTION-007 と同じく返す。検証役の prompt に章の値を書き写してはならず、照らす先のパスを渡さなければならない（写しは照らす先から drift する）。

### 監査の観点

#### SP-BPINSPECTION-009 監査の観点の一覧
audit の指摘の種類の閉集合は、次の識別子とする（PR-BPOPERATIONS-028）。PA-1〜PA-6 は、本文書が現行の prompt-audit の監査の観点に付けた識別子である（PA は prompt-audit の略）。各識別子の条件は、現行の prompt-audit の「Finding criteria」の節の、表の番号の項目を正とし、本文書は書き写さない。

| 識別子 | 現行の prompt-audit の「Finding criteria」の項目（番号と太字の名前） |
|---|---|
| PA-1 | 1. Conflicting instructions |
| PA-2 | 2. Unreachable or missing behavior |
| PA-3 | 3. Unbounded or unstable procedure |
| PA-4 | 4. Unsupported model or tool assumptions |
| PA-5 | 5. Output-contract mismatch |
| PA-6 | 6. Stale internal guidance |

#### SP-BPINSPECTION-010 一覧と出所の照合
照らす先の決定の段で、CLI は、現行の prompt-audit の「Finding criteria」の節の番号付きの項目を読み、件数・番号・太字の名前が SP-BPINSPECTION-009 の表と一致するかを照らさなければならない。一致しないときの扱いは SP-BPINSPECTION-028 に従う（出所が変わったのに一覧が古いまま当たると、足された基準が黙って照らされない）。

#### SP-BPINSPECTION-011 監査の範囲
監査の観点の検証役は、現行の prompt-audit の次の記述を、指摘の候補にするかどうかの範囲として当てなければならない。範囲は指摘の候補を絞るものであり、担当に割り当てる資産を減らしてはならない（資産を減らすと、カバレッジが見ていない資産を数えから外す）。

| 現行の prompt-audit の記述 | 当て方 |
|---|---|
| 「Scope」の節 | 照らす対象を、model・agent に向けた指示に限る。モデル・道具・API・版を名指す指示は、対象スキルか今の環境にある権威ある文書の証拠に照らす |
| 「Finding criteria」の節の導入文と、末尾の style preference の段落 | 具体的な証拠と実行への影響を説明できる箇所だけを指摘の候補にする。好みの違いを指摘の候補にしない |
| 「Confidence and action」の節の Low の行 | Low に当たる懸念を指摘の候補にしない |
| 「Confidence and action」の節の最後の 2 段落 | 指摘の候補の引用・内容・直し方（`docs/specifications/bp-findings.md` の SP-BPFINDINGS-007）を、引用と位置・実行への影響・証拠が支える最小の変更として書く。モデルや API に固有の主張には権威ある出所を内容に書く。対象が置き換えの指示を決めていないときは、直し方に具体的な置き換えを作らず、根拠が足りないことを書く |

#### SP-BPINSPECTION-012 監査の観点の優先
現行の prompt-audit は監査の観点の間に優先を定めないので、監査の観点の間に優先を置いてはならない。監査の観点の検証役は、全ての監査の観点を担当の全ての資産に当てなければならない。

監査の観点を当てた結果が `docs/requirements/bp-designed-skill.md` の要求と食い違うときは、bp-designed-skill の要求を優先しなければならない（4 機能を同じ設計方針に揃えるため：PR-BPOPERATIONS-029）。検証役は、その指摘の候補を返さず、監査の観点の識別子と優先した要求 ID と理由を、未検査の観点の候補として返さなければならない。次の 1 件は、検証役に判断させず、この規則の当て方として固定する。

- 起動数の上限を渡されない run で、fan-out の項目の件数と 1 run の起動数に上限が無いことに、PA-3 を当ててはならない（PR-BPDESIGNEDSKILL-021、`docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-025）。script は、この除外を PA-3 の一部の未検査の観点として毎回結果に載せなければならない。

#### SP-BPINSPECTION-013 モデルに固有の鮮度
対象スキルがモデル・道具・API・版を名指さないとき、または名指した対象について対象スキルにも今の環境にも権威ある文書の証拠が無いとき、監査の観点の検証役は、モデルに固有の指示が古いとする PA-4 の指摘の候補を返してはならない（現行の prompt-audit の「Scope」の節の 2 段落目）。検証役は、そのことを PA-4 の一部の未検査の観点の候補として、名指しが無いか証拠が無いかを理由にして返さなければならない（評価していない鮮度を、見ていないものとして宣言するため：設計方針文書「資産台帳」の skip 一覧の行と同じ目的）。

#### SP-BPINSPECTION-014 引き継がないもの
audit は、現行の prompt-audit のうち次のものを引き継いではならない。どれも監査の観点ではなく現行の結果の形か流れに当たり、結果の形は `docs/specifications/bp-findings.md` の SP-BPFINDINGS-029・SP-BPFINDINGS-030、流れは本文書が定める（PR-BPOPERATIONS-029）。

| 引き継がないもの | 現行の prompt-audit の箇所 |
|---|---|
| 確度の段階（High / Medium）を指摘の項目として持つこと | 「Confidence and action」の節 |
| `declared_only` の一覧 | 「Confidence and action」の節 |
| 直し方の語の集合（`remove` など） | 「Confidence and action」の節 |
| `audit_header` | 「Audit receipt」の節 |

`audit_header` が持たせていた、監査した範囲と基準の出所は、SP-BPINSPECTION-024 の照らした先と対象スキルのパスの一覧で返す。

### 担当と起動

#### SP-BPINSPECTION-015 担当の作り方
担当の作成の段で、script は抽出役を 1 体起動し、台帳の今の資産 ID の一覧と資産の束（SP-BPINSPECTION-017）を渡さなければならない。抽出役は、一緒に読まないと判断できない資産の組を、資産 ID の一覧から選んで返さなければならない（設計方針文書「資産台帳」：担当の単位はファイルではなく一緒に読まないと判断できない範囲にし、抽出役が閉集合から選ぶ）。組はファイルをまたいでよく、1 つの資産が 2 つ以上の組に入ってもよい。抽出役は資産 ID を作ってはならず、一覧にある資産 ID だけを返さなければならない。

CLI は、組ごとに担当 ID を付けて状態に書き、組の順を担当の順としなければならない。CLI は、一覧に無い資産 ID を含む組を拒否しなければならない（拒否した結果の扱いは `docs/specifications/bp-findings.md` の SP-BPFINDINGS-034）。どの組にも入らなかった資産は、観点ごとの検証の段の最初の起動では見られず skip 一覧に残り、SP-BPFINDINGS-025 の追加の起動で見られる。同じ担当の組を、run の観点の集合の全ての観点に使わなければならない。担当を割り当てるのは script とし、検証役に担当を選ばせてはならない（設計方針文書「資産台帳」）。

#### SP-BPINSPECTION-016 検証の項目と順位
観点ごとの検証の段の項目は、run の観点の集合の観点と担当の組とし、項目ごとに検証役を 1 体起動しなければならない。項目の順位は、観点の順（SP-BPINSPECTION-003）、同じ観点の中では担当の順とする。この順位を、起動数の上限で止まるときの未着手の項目の順位（`docs/specifications/bp-run.md` の SP-BPRUN-020）に使う。同時に走る検証役の数は `docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-027 に従い、検証役のモデルと effort は `docs/specifications/bp-run.md` の SP-BPRUN-023 に従う。

#### SP-BPINSPECTION-017 検証役に渡すもの
台帳の作成と資産の束の段で、script は運搬役を通じて CLI に、台帳の資産から資産の束を作業ファイルとして書かせなければならない。台帳を列挙し直したとき（`docs/specifications/bp-findings.md` の SP-BPFINDINGS-005）は、資産の束も書き直させなければならない。

script は、抽出役・検証役・反証役の prompt に、資産の束と照らす先のパスを渡し、内容を写してはならない。prompt は、全ての起動に共通する部分（照らす先のパス、資産の束のパス、役の指示と理由）を先頭に置き、起動ごとに違う部分（観点、担当の資産 ID、指摘の種類の閉集合、適用の判定）を後ろに置かなければならない（同じ対象を多数の agent が読むので、各体に冷読みさせず、prompt の先頭を揃えて cache を効かせる：AGENTS.md の作業ルール）。

検証役は、`docs/specifications/bp-findings.md` の SP-BPFINDINGS-007 の形に、同項が許す足した欄として、未検査の観点の候補（SP-BPINSPECTION-007・SP-BPINSPECTION-012・SP-BPINSPECTION-013）を加えて返さなければならない。候補は SP-BPINSPECTION-025 の観点・範囲・理由を持つ。範囲が SP-BPINSPECTION-025 の 3 種のどれでもない候補か、観点が run の観点の集合に無い候補を含む結果の記録を、CLI は拒否しなければならない（拒否された結果の扱いは SP-BPFINDINGS-034 と同じ）。

#### SP-BPINSPECTION-018 反証の起動
観点ごとの検証の段の最初の起動と skip 一覧への追加の起動が全て終わった後に、script は反証の段で、重複でない全ての指摘の候補を `docs/specifications/bp-findings.md` の SP-BPFINDINGS-012 でまとめた鍵ごとに、反証役を 1 体起動しなければならない（SP-BPFINDINGS-013）。追加の起動が返した指摘の候補も反証に回す。反証役には、まとめた候補、候補の観点の照らす先のパス、資産の束のパスを渡す。反証役の項目の順位は、鍵の最初の候補を返した検証の項目の順位、同じ項目の中では候補が返った順とする。

#### SP-BPINSPECTION-019 照合と停止
照合と停止の段で、script は、`docs/specifications/bp-run.md` の SP-BPRUN-026 で対象スキルが変わっていないことを確かめてから、review では停止の記録を書かせるのと同じ運搬役に、`stop` より先に `placement` を送らせ（SP-BPINSPECTION-007。停止の後のその run の書き込みは同文書の SP-BPRUN-017 に従う）、運搬役を通じて CLI に結果の項目（`docs/specifications/bp-findings.md` の SP-BPFINDINGS-030 と SP-BPINSPECTION-024）を作らせ、完了の停止の記録を書かせなければならない。結果の項目は CLI が状態から決定的に作り、agent に集約させてはならない（agent が要約すると、原典から drift した写しが混ざる：設計方針文書「状態の書き込み」）。

### 対象を書き換えない

#### SP-BPINSPECTION-020 書き手の役を持たない
review と audit の script は、運搬役・抽出役・検証役・反証役だけを起動し、書き手の役を起動してはならない（PR-BPOPERATIONS-030。修正は update が行う）。各役の prompt に、対象スキルを書き換える指示を書いてはならない。指摘の候補の直し方は、書き換えの内容を文で返すだけにする。書き込み先の制限と、対象を書き換えていないことの照合は `docs/specifications/bp-run.md` の SP-BPRUN-008・SP-BPRUN-025・SP-BPRUN-026 に従う。

### 対象スキル

#### SP-BPINSPECTION-021 対象は既にあるスキル
review と audit の対象スキルは、対象スキルのパスの一覧の根が既にあるディレクトリで、その直下に `SKILL.md` があるものでなければならない（PR-BPOPERATIONS-027。review も、`docs/requirements/bp-operations.md` の用語「対象スキル」により既にあるスキルを扱う）。これを確かめるのは、開始の段で CLI の開始の操作（`docs/specifications/bp-run.md` の SP-BPRUN-003）とし、当たらないときの扱いは SP-BPINSPECTION-026 に従う。

#### SP-BPINSPECTION-022 対象スキルのパスの一覧
開始の段に渡す対象スキルのパスの一覧（`docs/specifications/bp-run.md` の SP-BPRUN-031）は、入口が `docs/specifications/bp-entry.md` の SP-BPENTRY-006・SP-BPENTRY-022 で作った一覧をそのまま使わなければならない。run の中で一覧を作り直してはならない。解決できなかった callsite を利用者に返すのも SP-BPENTRY-023 と SP-BPENTRY-021 の 1 箇所とし、本文書の結果には載せない。

## 外部インタフェース

#### SP-BPINSPECTION-023 review と audit の入力
review と audit の Workflow の入力は、`docs/specifications/bp-entry.md` の SP-BPENTRY-013 の表を正とし、本文書に表を置かない（同じ表が 2 箇所にあると、片方の項目だけが変わる）。本文書が入力に課すのは、対象スキルのパスの一覧の根が既にあるスキルであること（SP-BPINSPECTION-021）だけとする。

#### SP-BPINSPECTION-024 review と audit に固有の結果の項目
review と audit は、完了したとき、`docs/specifications/bp-run.md` の SP-BPRUN-032 と `docs/specifications/bp-findings.md` の SP-BPFINDINGS-030 の項目に加えて、次の項目を返さなければならない。

| 項目 | 綴り | 機能 | 中身 |
|---|---|---|---|
| 照らした先 | `targets` | review・audit | 観点ごとの照らす先のパスと照らす先の指紋（SP-BPINSPECTION-004）。形は `docs/specifications/bp-run.md` の SP-BPRUN-031 の `targets` の操作の出力の `targets` と同じ |
| 適用の判定 | `applicability` | review | SP-BPINSPECTION-006 の答えと引用と、CLI が状態に書いた形と行（問い W がはいでないときは到達した形と SP-BPCONFORMANCE-003 の判定表の行、はいのときは `runs` の要素ごとの `{run, shape, row}`） |
| 未検査の観点 | `uncheckedViewpoints` | review・audit | SP-BPINSPECTION-025 の一覧。空でも項目を返す |
| 対象スキルのパスの一覧 | `target` | audit | 状態にある今の対象スキルのパスの一覧（`docs/specifications/bp-run.md` の SP-BPRUN-005）を、CLI が状態から逐語で写したもの（監査した範囲：SP-BPINSPECTION-014）。入力の `target`（`docs/specifications/bp-entry.md` の SP-BPENTRY-013）と同じ形にし、連鎖の次の run の入力にそのまま渡せるようにする |

review と audit が完了以外で止まったとき、返り値は `docs/specifications/bp-run.md` の SP-BPRUN-032 の項目に加えて、次の項目を持たなければならない。

| 項目 | 綴り | 中身（完了以外） |
|---|---|---|
| 止まった段 | `stoppedStage` | 停止の記録の段（CLI が `docs/specifications/bp-run.md` の SP-BPRUN-018 の規則で決めた段）の名前。名前は同文書の SP-BPRUN-038 の表の「段」の列とし、1 行に 2 つの名前がある `verify` は、create・update と同じ「検証」とする。停止の記録に段が無いときは「開始」（create・update と同じ）。再開の `start` を拒否された run（`docs/specifications/bp-run.md` の SP-BPRUN-032）は、状態を読まないので「開始」とする |

次の 2 つの run は、CLI の `outcome` を読まずに script が返り値を作る。止まった段は create・update（`docs/specifications/bp-authoring.md` の SP-BPAUTHORING-034）と同じ規則で決める。
- 状態を作らずに止まった run（SP-BPINSPECTION-026。入力の誤りで開始の操作の前に止まったときを含む）: 「開始」。
- 停止の記録を書けなかった BLOCKED（`docs/specifications/bp-run.md` の SP-BPRUN-027）: CLI の `stop-draft`（同文書の SP-BPRUN-031）の `stage`（`null` なら「開始」）。`stop-draft` を読めなかったときは `null` とし、段を読めなかったことを理由に書く（SP-BPRUN-027）。

#### SP-BPINSPECTION-025 未検査の観点の形と載せるもの
未検査の観点の 1 件は、観点、範囲、理由、記録した run を持たなければならない。範囲は、観点の全体か、判定の単位か、監査の観点の識別子のどれかとする。CLI は次の表の全ての場合に未検査の観点を作り、同じ観点と範囲と理由の重複は 1 件にまとめなければならない。

| 場合 | 観点 | 範囲 | 理由 |
|---|---|---|---|
| 仕様の観点の照らす先を読めない（SP-BPINSPECTION-005） | 仕様の観点 | 観点の全体 | 読めなかった照らす先のパス |
| 検証役が判定の単位を未検査とした（SP-BPINSPECTION-007・SP-BPINSPECTION-008） | フローの観点か仕様の観点 | 判定の単位 | 検証役の理由。`docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-019 で強いられた未検査とした単位は、その保留の根拠（`docs/specifications/bp-authoring.md` の用語「強いられた未検査」）と、一覧を読めないこと（一覧を読めないとき）か同名の役の名前とその定義のファイルのパス（同名の役があるとき） |
| bp-designed-skill の要求を優先して外した（SP-BPINSPECTION-012） | 監査の観点 | 監査の観点の識別子 | 優先した要求 ID と理由 |
| モデルに固有の鮮度を評価できない（SP-BPINSPECTION-013） | 監査の観点 | PA-4 | 名指しが無いか、証拠が無いか |
| 観点の全ての検証の項目が打ち切りになった（`docs/specifications/bp-run.md` の SP-BPRUN-028） | その観点 | 観点の全体 | 打ち切りの理由 |
| 照合と停止の段の `placement` の結果が未検査（SP-BPINSPECTION-007） | フローの観点 | 判定の単位 `SP-BPCONFORMANCE-041` | `placement` の `reason` |
| フローの観点を run の観点の集合に入れた（PR-BPDESIGNEDSKILL-051 はどの形でも当たる：`docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-003） | フローの観点 | 判定の単位 `SP-BPCONFORMANCE-041` | 同文書の SP-BPCONFORMANCE-041 の網羅の理由 |

未検査の観点に載せた観点と範囲を、結果の中で「問題なし」として返してはならない（照らしていない観点が照らしたと読まれる：PR-BPOPERATIONS-026）。

## エラー処理と異常系

本章は review と audit に固有の異常だけを扱う。agent の失敗・続けられない失敗・途中終了・CLI の拒否と BLOCKED の返し方は `docs/specifications/bp-run.md` の SP-BPRUN-027〜030 に従う。担当の作成の段の抽出役と適用の判定の段の検証役は fan-out の項目の外で起動する agent（SP-BPINSPECTION-001 の表の「項目」の列が「なし」の段）なので、失敗したら SP-BPRUN-027 で BLOCKED になる。資産が 0 件のときは `docs/specifications/bp-findings.md` の SP-BPFINDINGS-033 に従う。review と audit は needs_input で止まらない（`docs/specifications/bp-run.md` の SP-BPRUN-010）ので、利用者に直してもらう入力の不足も BLOCKED で返す。

#### SP-BPINSPECTION-026 対象が既にあるスキルでない
SP-BPINSPECTION-021 に当たらないとき、CLI の開始の操作は状態と作業場所を作らずに理由を返し、script は次の agent を起動せずに、BLOCKED と理由（渡されたパスと、ディレクトリが無いか `SKILL.md` が無いか）を返さなければならない。状態を作らないので、停止の記録を書かず、next_args を返さない（`docs/specifications/bp-run.md` の SP-BPRUN-011・SP-BPRUN-032）。

#### SP-BPINSPECTION-027 フローの観点・監査の観点の照らす先を読めない
照らす先の決定の段で、review のフローの観点か、audit の監査の観点の照らす先を読めなかったならば、script は、検証役を起動せずに、BLOCKED と理由（読めなかった照らす先のパス）を返さなければならない。指摘が 0 件の完了として返してはならない（照らさないまま「問題なし」と返すことになる）。audit で現行の prompt-audit（`references/prompt-audit.md` の写し）が無いときは、監査を実行せずに止まり、理由に読めなかったパスと、引き継ぐ監査の観点が無いことを書く。このときの返り値は、止まった段（照らす先の決定：SP-BPINSPECTION-024 の `stoppedStage`）と理由の報告とし（PR-BPOPERATIONS-047・050）、監査の結果を返さない。仕様の観点を読めないときだけは、SP-BPINSPECTION-005 のとおり止まらずに未検査とする（PR-BPOPERATIONS-026 が未検査として示すことを定めている）。

#### SP-BPINSPECTION-028 監査の観点の一覧が出所と食い違う
SP-BPINSPECTION-010 の照合で一致しなかったならば、script は、検証役を起動せずに、BLOCKED と理由（食い違った番号と名前）を返さなければならない。

#### SP-BPINSPECTION-029 再開したときの照らす先の食い違い
前の run が照らす先の決定の段を終えた状態から再開した run では、照らす先の決定の段で、CLI は照らす先を読み直し、状態にある照らす先の指紋と照らさなければならない。食い違ったならば、script は、検証役も反証役も起動せずに、BLOCKED と理由（食い違った照らす先のパス）を返さなければならない（違う基準で付けた指摘と判定が、1 つの台帳に混ざる）。状態にある観点の集合と、状態に結果のある担当の組と適用の判定の扱いは、`docs/specifications/bp-run.md` の SP-BPRUN-015 の 3 に従う。

前の run が照らす先の決定の段を終える前に止まったとき（照らす先を読めずに BLOCKED になったときなど）は、本項を当てず、照らす先の決定の段を最初から行う（SP-BPINSPECTION-030。照合すると、利用者が直した照らす先が前の記録と食い違い、再開のたびに BLOCKED になる）。段を終えたかは、状態の段の進み（`docs/specifications/bp-run.md` の SP-BPRUN-005）の終えた段で決める。

#### SP-BPINSPECTION-030 再開した run の入口の段
review と audit の再開した run は、`docs/specifications/bp-run.md` の SP-BPRUN-015 のとおり進む。入口の段（同項の 2）は、照らす先の決定の段とする（照らす先の食い違いを、検証役と反証役を起動する前に見つけるため：SP-BPINSPECTION-029）。照らす先の決定の段と台帳の作成と資産の束の段と照合と停止の段は、終えていても再開した run で、段の開始を書いてから最初から行う（同項の 3 のただし書き。照合と停止の段は、review の完了の `stop` が現在の run の `placement` を求めるため：SP-BPINSPECTION-019）。照らす先の決定の段は SP-BPINSPECTION-029 に従い、台帳の作成と資産の束の段は、台帳を作り直さず、開始の段の取り直しに合わせて資産の束を書き直す（SP-BPINSPECTION-017）。

## 検証方法

各仕様項目をどう確かめるかは、トレーサビリティ表の検証方法列が正である。本章はそこで用いる手段の意味を固定する。

| 手段 | 中身 |
|---|---|
| script の模擬実行 | 抽出役・検証役・反証役・運搬役の返り値を固定した模擬の backend で script を走らせ、起動の数と順と prompt の中身、状態の記録、返り値を照らす |
| CLI の単体テスト | 照らす先・対象スキル・prompt-audit の写しを与えて CLI の操作を呼び、状態の記録と出力と拒否を照らす |
| 静的な照合 | script の本文と各役の prompt を読み、起動する役の集合、prompt に書き写した基準の有無、対象を書き換える指示の有無を照らす |
| fixture | 違反を仕込んだ対象スキルを review・audit にかけ、指摘の種類と未検査の観点を期待値と照らす。模擬の検証役は対象スキルの中身によらず決めた答えを返すので、模擬で確かめられるのは配線（閉集合・未検査の観点の記録・PA-3 の固定の 1 件・除く単位・強いられた未検査）だけである。判断の質は `docs/specifications/bp-authoring.md` の「検証方法」の本物の agent での試走で確かめ、その試走で確かめた行だけを「完了」にする |

## トレーサビリティ表

本表は、本仕様書がカバーする要求の分だけを持つ。

| 要求 ID | 仕様項目 ID | 検証方法 | ステータス |
|---|---|---|---|
| PR-BPOPERATIONS-029 | SP-BPINSPECTION-001 | script の模擬実行（review と audit の起動が表の段の順に並び、audit に適用の判定の段が無いことを確認。抽出役の失敗で BLOCKED になり、観点ごとの検証の項目の欠けでは試行を繰り返すことを確認） | 完了 |
| PR-BPOPERATIONS-029 | SP-BPINSPECTION-001 | 静的な照合（best-practices の設計の説明に、本項の表の段と部品の対応があることを確認。設計の説明は新しい入口の SKILL.md とともに置く：`docs/specifications/bp-entry.md` の SP-BPENTRY-025 の変更） | 未着手 |
| PR-BPOPERATIONS-029 | SP-BPINSPECTION-002 | script の模擬実行（指摘のある結果を返しても観点ごとの検証の段より前の段の起動が再び起きないことを確認） | 完了 |
| PR-BPOPERATIONS-024 | SP-BPINSPECTION-003 | script の模擬実行（review の検証の項目の観点がフローと仕様の 2 つだけであることを確認） | 完了 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-003 | script の模擬実行（audit の検証の項目の観点が監査の観点だけであることを確認） | 完了 |
| PR-BPOPERATIONS-025 | SP-BPINSPECTION-004 | CLI の単体テスト（仕様の観点の照らす先のパスと指紋が状態に書かれることを確認） | 完了 |
| PR-BPOPERATIONS-026 | SP-BPINSPECTION-004 | CLI の単体テスト（「性能・容量」の章の見出しが無い写しを与え、仕様の観点が読めないと記録されることを確認） | 完了 |
| PR-BPOPERATIONS-026 | SP-BPINSPECTION-005 | script の模擬実行（仕様の観点を読めない review で、仕様の観点の検証役が起動されず、未検査の観点に全体が載り、仕様の観点の skip 一覧と追加の起動が無いことを確認） | 完了 |
| PR-BPOPERATIONS-024 | SP-BPINSPECTION-006 | script の模擬実行（CLI に拒否された適用の判定の結果で検証役が拒否の理由とともに起動し直され、フローの観点の全ての検証役に同じ形が渡ることを確認）と静的な照合（検証役の schema の答えの enum が閉集合と一致することを確認。閉集合の外の答えは host の schema が CLI に届く前に通さないので、CLI の拒否は CLI の単体テストで確かめる）と CLI の単体テスト（W がはいで要素が 3 つ以上の `runs` が受理されて要素ごとの `{run, shape, row, assets}` が状態に書かれ、要素が 2 つの `runs`、1 つ目の `run` が `sequence` でない `runs`、`run` が重複する `runs`、台帳に無い資産 ID を `assets` に持つ `runs`、W の答えと合わない置き場の Q1・Q2・Q3 を持つ結果がそれぞれ拒否されることを確認）と script の模擬実行（W がはいの結果で、フローの観点の全ての検証役に `runs` の要素ごとの形・資産台帳・fan-out・行と `assets` が渡ることを確認） | 作成中 |
| PR-BPOPERATIONS-024 | SP-BPINSPECTION-006 | CLI の単体テスト（本項の拒否の一覧の `assets` の箇条が拒否するとした場合を、1 つ目の要素と 2 つ目以降の要素のそれぞれで 1 つずつ作り、どれも拒否の記録を足した `E_RESULT` になることと、同じ箇条が拒否しないとした場合が受理されることを確認） | 未着手 |
| PR-BPOPERATIONS-024 | SP-BPINSPECTION-007 | fixture（SP-BPCONFORMANCE-003 の判定表の行ごとの違反を仕込み、指摘の種類がその仕様項目 ID になることを確認） | 作成中 |
| PR-BPOPERATIONS-025 | SP-BPINSPECTION-008 | fixture（同時実行の定数を 4 にした対象スキルで、指摘の種類が SP-BPCONFORMANCE-027 になることを確認）と静的な照合（仕様の観点の prompt に章の値が無いことを確認） | 作成中 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-009 | CLI の単体テスト（PA-1〜PA-6 以外の指摘の種類を含む候補が拒否されることを確認） | 完了 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-010 | CLI の単体テスト（項目を 1 つ足した prompt-audit の写しで照合が不一致になることを確認） | 完了 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-011 | fixture（指示でない文の欠陥と、好みの違いだけの箇所を含む対象スキルで、どちらも指摘にならず、担当の資産が減らないことを確認） | 作成中 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-012 | fixture（上限の無い fan-out を持つ対象スキルで PA-3 の指摘が出ず、PA-3 の一部の未検査の観点が載ることを確認） | 作成中 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-013 | fixture（モデルを名指さない対象スキルで PA-4 の鮮度の指摘が出ず、PA-4 の未検査の観点が載ることを確認） | 作成中 |
| PR-BPOPERATIONS-029 | SP-BPINSPECTION-014 | script の模擬実行（audit の結果に確度・declared_only・audit_header の項目が無く、照らした先と対象スキルのパスの一覧が載ることを確認） | 完了 |
| PR-BPOPERATIONS-033 | SP-BPINSPECTION-015 | script の模擬実行（抽出役が一覧に無い資産 ID を返すと組が拒否され、試行の上限の回まで拒否されると BLOCKED になり、どの組にも入らない資産が追加の起動の担当になることを確認） | 完了 |
| PR-BPOPERATIONS-034 | SP-BPINSPECTION-015 | script の模擬実行（どの組にも入らない資産が最初の起動の後に skip 一覧に載ることを確認） | 完了 |
| PR-BPOPERATIONS-029 | SP-BPINSPECTION-016 | script の模擬実行（起動数の上限で止めた review の未着手の項目が、観点の順・担当の順で残ることを確認） | 完了 |
| PR-BPOPERATIONS-024 | SP-BPINSPECTION-017 | 静的な照合（検証役の prompt が資産の束と照らす先のパスを持ち、共通の部分が先頭にあることを確認） | 完了 |
| PR-BPOPERATIONS-031 | SP-BPINSPECTION-018 | script の模擬実行（追加の起動が返した候補を含め、重複でない候補のまとめた鍵ごとに反証役が 1 体起動され、全ての反証役が観点ごとの検証の段の後に起動されることを確認） | 完了 |
| PR-BPOPERATIONS-029 | SP-BPINSPECTION-019 | script の模擬実行（結果の項目が CLI の出力から逐語で返り、集約の agent が起動されないことを確認） | 完了 |
| PR-BPOPERATIONS-030 | SP-BPINSPECTION-020 | 静的な照合（review・audit の script に書き手の起動が無く、各役の prompt に対象を書き換える指示が無いことを確認） | 完了 |
| PR-BPOPERATIONS-027 | SP-BPINSPECTION-021 | CLI の単体テスト（根が `SKILL.md` のあるディレクトリのときだけ、開始の操作が状態を作ることを確認） | 完了 |
| PR-BPOPERATIONS-027 | SP-BPINSPECTION-022 | script の模擬実行（入口が渡したパスの一覧がそのまま開始の操作に渡り、run の中でパスの一覧の作成が呼ばれないことを確認） | 完了 |
| PR-BPOPERATIONS-027 | SP-BPINSPECTION-023 | 静的な照合（review・audit の入力の表が `docs/specifications/bp-entry.md` の SP-BPENTRY-013 だけにあり、本文書に無いことを確認） | 完了 |
| PR-BPOPERATIONS-026 | SP-BPINSPECTION-024 | script の模擬実行（未検査の観点が空の run でも結果に項目があることを確認） | 完了 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-024 | script の模擬実行（audit の結果に prompt-audit のパスと指紋が載ることを確認） | 完了 |
| PR-BPOPERATIONS-026 | SP-BPINSPECTION-025 | CLI の単体テスト（表の 7 つの場合を 1 つずつ作り、未検査の観点の観点・範囲・理由を確認。同じ未検査を 2 体が返したとき 1 件になることを確認） | 作成中 |
| PR-BPDESIGNEDSKILL-051 | SP-BPINSPECTION-007 | script の模擬実行（照合と停止の段で `placement` が結果の項目より先に送られ、フローの観点の閉集合に SP-BPCONFORMANCE-041 が無いことを確認。理由の空いたデータ行を持つ対象スキルで、その行を含む資産に種類 `SP-BPCONFORMANCE-041` の open の指摘が反証の段を経ずに出ることを確認。判断点の表の無い対象スキルで、`SKILL.md` の frontmatter の資産に指摘が出ること、frontmatter の無い `SKILL.md` では最初の見出しより前の本文か最初の節の資産に出ること、空白だけの `SKILL.md` では資産 ID の昇順の最初の資産に出ることを確認。照合と停止の段で `placement` が `stop` より先に、停止と同じ運搬役で送られることを確認。検証役が種類 `SP-BPCONFORMANCE-041` の候補を返すと拒否されることを確認） | 未着手 |
| PR-BPOPERATIONS-024 | SP-BPINSPECTION-025 | fixture（無視される設定の一覧の記述を消した写しで、PR-BPDESIGNEDSKILL-014 の単位が、保留の根拠（`docs/specifications/bp-authoring.md` の用語「強いられた未検査」）と一覧を読めないことを理由に未検査の観点に載り、PR-BPDESIGNEDSKILL-046 の単位が未検査の観点に載らないことを確認） | 未着手 |
| PR-BPOPERATIONS-024 | SP-BPINSPECTION-007 | script の模擬実行（役の名前が同じ定義が 2 つある対象スキルの review で、同名の役の制限の候補が出ず、PR-BPDESIGNEDSKILL-014 の単位の未検査の観点が保留の根拠 `SP-BPCONFORMANCE-019` と同名の役の名前と定義のパスを理由に持つことを確認） | 未着手 |
| PR-BPOPERATIONS-024 | SP-BPINSPECTION-007 | fixture（一覧の設定に頼る制限を持つ対象スキルの review で、PR-BPDESIGNEDSKILL-046 の単位の指摘が制限ごとに出て、結果に `checkedRoleLimits` と `residualRisks` が無いことを確認） | 未着手 |
| PR-BPOPERATIONS-050 | SP-BPINSPECTION-027 | script の模擬実行（prompt-audit の写しが無い audit で、検証役を起動せず、BLOCKED と、引き継ぐ監査の観点が無いことを含む理由と、止まった段を返し、指摘の一覧を返さないことを確認） | 未着手 |
| PR-BPOPERATIONS-050 | SP-BPINSPECTION-024 | script の模擬実行（prompt-audit の写しが無い audit の返り値の `stoppedStage` が照らす先の決定であることを確認） | 未着手 |
| PR-BPOPERATIONS-027 | SP-BPINSPECTION-026 | script の模擬実行（存在しないパスと `SKILL.md` の無いディレクトリで、開始の運搬役の後に agent が起動されず、状態が作られず、BLOCKED と理由が返り、next_args が無いことを確認） | 完了 |
| PR-BPOPERATIONS-024 | SP-BPINSPECTION-027 | script の模擬実行（フローの観点の照らす先を読めない review が、指摘 0 件の完了ではなく BLOCKED を返すことを確認） | 完了 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-027 | script の模擬実行（prompt-audit を読めない audit が BLOCKED を返すことを確認） | 完了 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-028 | script の模擬実行（一覧が食い違う prompt-audit の写しで検証役が起動されず BLOCKED を返すことを確認） | 完了 |
| PR-BPOPERATIONS-024 | SP-BPINSPECTION-007 | fixture（同時実行の定数を 4 にした対象スキルの review で、フローの観点の指摘が出ず、仕様の観点の SP-BPCONFORMANCE-027 の指摘 1 件だけになることを確認） | 作成中 |
| PR-BPOPERATIONS-026 | SP-BPINSPECTION-017 | CLI の単体テスト（未検査の観点の候補を足した結果が受理され、範囲が 3 種の外の候補を含む結果が拒否されることを確認） | 完了 |
| PR-BPOPERATIONS-029 | SP-BPINSPECTION-029 | script の模擬実行（停止中に照らす先を書き換えて再開し BLOCKED になること、書き換えずに再開すると抽出役と適用の判定が再び起動されないこと、照らす先を読めずに BLOCKED になった run を照らす先を直して再開すると照らす先の決定の段をやり直して進むことを確認） | 完了 |
| PR-BPOPERATIONS-029 | SP-BPINSPECTION-030 | script の模擬実行（止まった段ごとに状態を作って再開し、終えた段の結果が作り直されず、照らす先の決定の段を終えた状態からの再開でだけ照合が行われることを確認） | 完了 |
| PR-BPOPERATIONS-029 | SP-BPINSPECTION-030 | script の模擬実行（止まった段の違う状態のそれぞれから再開した review・audit が、照らす先の決定の段から始まって資産の束を書き直し、終えた段の agent を起動し直さず、照合と停止の段で止まった review の再開で `placement` を送ってから完了の `stop` を送ることを確認） | 未着手 |
| PR-BPOPERATIONS-029 | SP-BPINSPECTION-030 | script の模擬実行（最初の流れの消えた資産の照合の段で止まった review を再開し、その回の未着手の項目を流れの消えた資産の照合の段で処理して照合と停止の段へ進むことと、再開した run が `ledger-retake` を呼ばず `start` の `retake` を使うことを確認） | 未着手 |
| PR-BPOPERATIONS-047 | SP-BPINSPECTION-024 | script の模擬実行（段の記録が 1 つも無いまま停止の記録を書いた review・audit の返り値の止まった段が「開始」になることを確認） | 未着手 |
| PR-BPOPERATIONS-047 | SP-BPINSPECTION-024 | script の模擬実行（再開の `start` を拒否された review・audit の返り値の止まった段が「開始」で、前の run の停止の値を持たないことを確認） | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-024 | script の模擬実行（audit の結果の対象スキルのパスの一覧が、状態にある今の一覧と 1 字も違わないことを確認） | 完了 |
| PR-BPOPERATIONS-047 | SP-BPINSPECTION-024 | script の模擬実行（完了以外の返り値の鍵が SP-BPRUN-032 の表の鍵と止まった段だけで、状態を作らずに止まった run の止まった段が「開始」、停止の記録を書けなかった BLOCKED の止まった段が `stop-draft` の段（読めなければ `null`）であることを確認） | 未着手 |
| PR-BPOPERATIONS-029 | SP-BPINSPECTION-030 | script の模擬実行（台帳の作成と資産の束の段を終えた状態から、停止の間に節を 1 つ書き換えて再開し、台帳が取り直され資産の束が書き直されることを確認） | 完了 |
