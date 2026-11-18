# 仕様書: review と audit の観点と流れ

[設計時点の出典／旧規約 @ c7759f1]: https://github.com/yoshiysh/claude-plugins/blob/c7759f152c1e51369818f21e34a98cb0146e5e76/AGENTS.md
[agent-work の現行案内]: https://github.com/yoshiysh/claude-plugins/blob/main/docs/guidelines/agent-work.md

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

本書の各仕様項目と要求の対応は、末尾のトレーサビリティ表を正とする。

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

#### SP-BPINSPECTION-001 評価と監査に必要な依存順
review・audit は、基準と対象を確定してから観点を適用し、独立した反証を経て指摘を返さなければならない。review はフローの形と適用範囲を確定し、audit は現行の監査基準を確認しなければならない。どちらも資産台帳に確認範囲を結び付け、必要な追加確認と消えた資産の照合を反映し、対象を変更していないことを確かめてから完了しなければならない。

内部の worker の段数・担当の起動回数・運搬の束ね方は実装の設計で決める。上位の形の判定、部品と独立性の制約は満たさなければならない。

#### SP-BPINSPECTION-002 対象を書き直す反復をしない
review・audit は対象を書き直す反復を行ってはならない。未確認の同じ資産集合への追加確認は SP-BPFINDINGS-025 に従い、書き直しの反復と数えてはならない。反復の回数による停止は使わず、起動数の上限に達した場合だけ反復の上限として止まらなければならない。

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
観点ごとの基準を読めたかと、そのファイル・章節・内容の指紋を確定し、同じ run とその再開でどの版を適用したかを辿れるようにしなければならない。読めたとするのは対応する基準が存在し、適用する単位または監査項目が 1 件以上ある場合だけとする。

判定に依存する要求・設計方針・単位の除外と監査の当て方を定める BP 仕様も基準の同一性に含めなければならない。別の基準を黙って補うことは禁止し、読めない基準は SP-BPINSPECTION-005・027 のとおり扱わなければならない。

#### SP-BPINSPECTION-005 仕様書を読めないとき
照らす先の決定の段で仕様の観点の照らす先を読めなかったならば、script は、仕様の観点を run の観点の集合に入れてはならず、仕様の観点の全体を未検査の観点として結果に載せなければならない（PR-BPOPERATIONS-025）。このとき、仕様の観点の検証役を起動してはならない。カバレッジ・skip 一覧・skip 一覧への追加の起動は run の観点の集合の観点だけに作る（`docs/specifications/bp-findings.md` の SP-BPFINDINGS-022・SP-BPFINDINGS-023・SP-BPFINDINGS-025）ので、仕様の観点にはどれも作らない（観点を照らしていないことは、未検査の観点として 1 回だけ宣言する）。

### フローの観点

#### SP-BPINSPECTION-006 適用の判定
review は対象スキルのフローについて次の答えと根拠を確定しなければならない。答えはどれも閉集合からの選択とし、答えごとに、その答えを示す箇所の資産 ID と行番号を添えた引用を返させる。

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

`runs` は `{run, answers, ledger, fanout, assets}` の並びとし、`answers` は Q1・Q2・Q3 の `{answer, quotes}`、`ledger`・`fanout` は `{answer, quotes}` とする。1 つ目の要素は run の並び（`docs/specifications/bp-conformance.md` の用語定義）で、`run` を `sequence` とする。2 つ目以降の要素は問い W で分けた各 run（対象スキルが run を分けていないときは、`docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-003 のとおり分けたもの）で、`run` はその run の名前（空でない文字列で、`runs` の中で一意で、`sequence` でない）とする。`assets` は、その run を実装する対象スキルの資産の資産 ID（状態の資産台帳にあるもの。run の Workflow script と、その run の `Workflow(` の callsite を持つ資産を含む）の重複の無い並びとする。どの要素の `assets` にも無い資産は run の並び（1 つ目の要素）に属するとし、2 つ以上の要素の `assets` にある資産は、その全ての run の行で判定して SP-BPCONFORMANCE-003 の規則で結果を 1 つにする。要素ごとの `ledger`・`fanout` は、SP-BPCONFORMANCE-003 が「実際に持つ」の範囲とした資産について答える。

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

`runs` の要素の `assets` が、欠けている・並びでない・空の並びである・同じ資産 ID を 2 回以上含む、のどれかに当たるときに CLI がその結果を受理するか拒否するか（1 つ目の要素（run の並び）と 2 つ目以降の要素で扱いを分けるかを含む）の裁定が下るまで、本項と `docs/specifications/bp-authoring.md` の SP-BPAUTHORING-017 の適用の判定の受理を実装する者は、次を守らなければならない。

- それらの場合を受理する実装も拒否する実装も確定させてはならない。
- それらの場合の CLI の単体テストの期待値を書いてはならない。
- それらの場合の扱いを決めないまま適用の判定の受理を配布してはならない。

受理した答えと、W がはいでないときは到達した形 `shape` と SP-BPCONFORMANCE-003 の判定表の行 `row` を、W がはいのときは `runs`（要素ごとの `{run, shape, row, assets}`）を保存しなければならない。判定の単位 `units` は全ての要素の行の判定の単位の和とし、判定の単位ごとの結果は 1 つとする（同じ単位を 2 つ以上の run で判定したときの結果のまとめ方は SP-BPCONFORMANCE-003）。

フローの観点の検証役には、W がはいでないときは形と資産台帳・fan-out の有無を、W がはいのときは `runs` の全ての要素の形と資産台帳・fan-out の有無と行と `assets` を、SP-BPCONFORMANCE-003 の判定表の条件として渡す。検証役は、それを使い、自分で答え直してはならず、資産の属する run を決め直してもならない（担当ごとに答えや資産の属する run が割れると、当たる要求が担当ごとに変わる）。

#### SP-BPINSPECTION-007 フローの観点の判定
フローの観点の検証役は、`docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-001・SP-BPCONFORMANCE-002・SP-BPCONFORMANCE-003・SP-BPCONFORMANCE-018・SP-BPCONFORMANCE-038 に従って、当たる要求の判定の単位に判定基準を当てなければならない。返し方は次のとおりとする。

- 担当の資産ごとの判定と指摘の候補は、`docs/specifications/bp-findings.md` の SP-BPFINDINGS-007 の形で返す。判定の結果が不適合の単位は、その単位を定める bp-conformance の仕様項目 ID と判定の単位の組（`docs/specifications/bp-findings.md` の SP-BPFINDINGS-010）を指摘の種類にした指摘の候補として、違反が現れている担当の資産に結び付けて返す。
- 判定の結果が未検査の単位は、単位と理由を未検査の観点の候補として返す（SP-BPINSPECTION-025）。

検証役は、判定のために担当の外の資産を読んでよい。判定を返すのは担当の資産だけにしなければならない。

フローの観点の検証役は、PR-BPDESIGNEDSKILL-014 の Claude Code の判定の単位と PR-BPDESIGNEDSKILL-046 の判定の単位を、create・update の適合の観点の検証役と同じく、`docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-019 の Claude Code の行と判定表で判定しなければならない。一覧の設定に頼る制限は、制限ごとに PR-BPDESIGNEDSKILL-046 の単位の指摘の候補にする。一覧を読めないときに強いられた未検査とした単位は、未検査の観点の候補として返す（SP-BPINSPECTION-025）。review は照らした制限 `checkedRoleLimits` と残る危険 `residualRisks` を返さない（PR-BPDESIGNEDSKILL-015 の報告は create・update の検証の結果に宛てたもの）。Codex runner の扱いは SP-BPCONFORMANCE-019 の Codex runner の行のとおりとする。

SP-BPCONFORMANCE-041 は LLM の判定から除き、公開された表の構文を機械だけで照合しなければならない。未検査なら未検査の観点にし、不適合なら、理由が指す各行の資産へ次の指摘を結び付けなければならない（依頼者の裁定）。見出しが無く指す行が無い場合は、根の SKILL.md の frontmatter、見出し前の本文、最初の節の順で最初に存在する資産を使う。SKILL.md に資産が無い場合は、現在の資産 ID の昇順で最初の資産を使う。

| 項目 | 値 |
|---|---|
| 資産 ID | その資産の資産 ID |
| 観点 | フローの観点 |
| 指摘の種類 | `SP-BPCONFORMANCE-041` |
| 引用 | その資産の中の `lines` の行の原文を、行番号を添えて並べたもの。指す行が無いときは空の文字列 |
| 内容 | 機械照合の理由 |
| 直し方 | 判断点の表を `docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-041 の判定表の適合の行に当たる形に直すこと |

この候補の記録（反証を経ないこと、台帳に同じ鍵があるときの扱い、担当の指紋の組）は `docs/specifications/bp-findings.md` の SP-BPFINDINGS-014 の最後の段落に従う。指摘の鍵・指摘 ID と run をまたぐ扱いは、他の指摘と同じく同文書に従う。

`docs/specifications/bp-conformance.md` の「機能仕様」の章の仕様項目が「性能・容量（対象スキルに課す確定値）」の章の仕様項目の値で判定するとした行（SP-BPCONFORMANCE-012 の同時実行の行を含む。全ての行は下の除く単位の表）は、フローの観点の判定の単位にしてはならず、仕様の観点の判定の単位（SP-BPINSPECTION-008）としてだけ判定する（両方の観点が判定すると、同じ違反が観点の違う 2 件の指摘になる。指摘の鍵は観点を含むので、CLI は観点をまたいで指摘をまとめない：`docs/specifications/bp-findings.md` の SP-BPFINDINGS-011）。この規則は review にだけ当てる（create・update は仕様の観点を持たないので、適合の観点が値の行も判定する）。

除く単位は次の表とする（単位の値は `docs/specifications/bp-findings.md` の SP-BPFINDINGS-010 の判定の単位の値）。この表の単位を review のフローの観点の閉集合と適用範囲から除かなければならない。表の行は、bp-conformance の「機能仕様」の章で「SP-BPCONFORMANCE-0xx（の値）で判定する」とした文のうち、参照先が「性能・容量（対象スキルに課す確定値）」の章の仕様項目であるものの主語の行である。SP-BPCONFORMANCE-013 の「役ごとのモデルと effort は、SP-BPCONFORMANCE-035 で判定する」は、除く単位を持たない（SP-BPCONFORMANCE-035 は、フローの観点が判定表で当たる PR-BPDESIGNEDSKILL-009 の判定の単位として判定し、仕様の観点の判定の単位にしない：SP-BPINSPECTION-008）。

| 除く単位 | 判定する仕様の観点の仕様項目 |
|---|---|
| `SP-BPCONFORMANCE-012/体数と同時実行/t1/r3` | SP-BPCONFORMANCE-027 |
| `SP-BPCONFORMANCE-015/探索グラフ/計画役/t1/r9` | SP-BPCONFORMANCE-032 |
| `SP-BPCONFORMANCE-015/探索グラフ/停止/t1/r1` | SP-BPCONFORMANCE-030 |
| `SP-BPCONFORMANCE-015/探索グラフ/停止/t1/r4` | SP-BPCONFORMANCE-032 |
| `SP-BPCONFORMANCE-015/探索グラフ/停止/t1/r7` | SP-BPCONFORMANCE-031 |
| `SP-BPCONFORMANCE-016/状態の書き込み/t1/r12` | SP-BPCONFORMANCE-033 |

#### SP-BPINSPECTION-008 仕様の観点の判定
仕様の観点の検証役は、`docs/specifications/bp-conformance.md` の「性能・容量（対象スキルに課す確定値）」の章の仕様項目のうち SP-BPCONFORMANCE-035 を除いたものを 1 つずつ判定の単位とし（SP-BPCONFORMANCE-002）、対象スキルの値と規則をその章に照らさなければならない（PR-BPOPERATIONS-025）。SP-BPCONFORMANCE-035 は、フローの観点が判定表で当たる PR-BPDESIGNEDSKILL-009 の判定の単位として判定する（SP-BPINSPECTION-007）。不適合の単位は、その仕様項目 ID を指摘の種類にした指摘の候補として返し、未検査の単位は SP-BPINSPECTION-007 と同じく返す。検証役の prompt に章の値を書き写してはならず、照らす先のパスを渡さなければならない（写しは照らす先から drift する）。

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

監査の観点を当てた結果が `docs/requirements/bp-designed-skill.md` の要求と食い違うときは、bp-designed-skill の要求を優先しなければならない（4 機能を同じ設計方針に揃えるため：PR-BPOPERATIONS-028）。検証役は、その指摘の候補を返さず、監査の観点の識別子と優先した要求 ID と理由を、未検査の観点の候補として返さなければならない。次の 1 件は、検証役に判断させず、この規則の当て方として固定する。

- 起動数の上限を渡されない run で、fan-out の項目の件数と 1 run の起動数に上限が無いことに、PA-3 を当ててはならない（PR-BPDESIGNEDSKILL-021、`docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-025）。script は、この除外を PA-3 の一部の未検査の観点として毎回結果に載せなければならない。

#### SP-BPINSPECTION-013 モデルに固有の鮮度
対象スキルがモデル・道具・API・版を名指さないとき、または名指した対象について対象スキルにも今の環境にも権威ある文書の証拠が無いとき、監査の観点の検証役は、モデルに固有の指示が古いとする PA-4 の指摘の候補を返してはならない（現行の prompt-audit の「Scope」の節の 2 段落目）。検証役は、そのことを PA-4 の一部の未検査の観点の候補として、名指しが無いか証拠が無いかを理由にして返さなければならない（評価していない鮮度を、見ていないものとして宣言するため：設計方針文書「資産台帳」の skip 一覧の行と同じ目的）。

#### SP-BPINSPECTION-014 引き継がないもの
audit は、現行の prompt-audit のうち次のものを引き継いではならない。どれも監査の観点ではなく現行の結果の形か流れに当たり、結果の形は `docs/specifications/bp-findings.md` の SP-BPFINDINGS-029・SP-BPFINDINGS-030、流れは本文書が定める（PR-BPOPERATIONS-028）。

| 引き継がないもの | 現行の prompt-audit の箇所 |
|---|---|
| 確度の段階（High / Medium）を指摘の項目として持つこと | 「Confidence and action」の節 |
| `declared_only` の一覧 | 「Confidence and action」の節 |
| 直し方の語の集合（`remove` など） | 「Confidence and action」の節 |
| `audit_header` | 「Audit receipt」の節 |

`audit_header` が持たせていた、監査した範囲と基準の出所は、SP-BPINSPECTION-024 の照らした先と対象スキルのパスの一覧で返す。

### 担当と起動

#### SP-BPINSPECTION-015 担当の作り方
一緒に読まないと判断できない資産を同じ担当範囲に含め、範囲は現在の資産 ID の閉集合から確定しなければならない。ファイルをまたぐ組と、複数の組に同じ資産を含めることは許容する。存在しない資産 ID を受理してはならない。

同じ範囲と順位をその run の全ての観点に使い、検証役ごとに担当範囲を作り直してはならない。最初の担当から漏れた資産は skip として残し、SP-BPFINDINGS-025 の追加確認の対象にしなければならない。範囲の決め方は設計方針文書「資産台帳」の決定的な規則または閉集合からの選択に従う。

#### SP-BPINSPECTION-016 検証の項目と順位
観点ごとの検証の段の項目は、run の観点の集合の観点と担当の組とし、項目ごとに検証役を 1 体起動しなければならない。項目の順位は、観点の順（SP-BPINSPECTION-003）、同じ観点の中では担当の順とする。この順位を、起動数の上限で止まるときの未着手の項目の順位（`docs/specifications/bp-run.md` の SP-BPRUN-020）に使う。同時に走る検証役の数は `docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-027 に従い、検証役のモデルと effort は `docs/specifications/bp-run.md` の SP-BPRUN-023 に従う。

#### SP-BPINSPECTION-017 検証役に渡すもの
検証には、担当の資産 ID・位置・原文を辿れる行番号付きの証拠と、観点の基準・許容する指摘の種類・未検査の扱いを使わなければならない。共通の原文は決定的に抽出して参照し、agent の要約を原文の代わりにしてはならない。対象版が変わった場合は証拠の対応も更新し、古い版を現在の根拠として渡してはならない。

結果の未検査は SP-BPINSPECTION-025 の観点・範囲・理由を持ち、割り当てと閉集合に反する結果は SP-BPFINDINGS-034 に従って拒否しなければならない。証拠の内部ファイル名と運搬手順は実装の設計で決める。

#### SP-BPINSPECTION-018 反証の起動
観点ごとの検証の段の最初の起動と skip 一覧への追加の起動が全て終わった後に、反証では、重複でない全ての指摘の候補を `docs/specifications/bp-findings.md` の SP-BPFINDINGS-012 でまとめた鍵ごとに、同じ候補の生成と別の context で 1 つの反証結果を得なければならない（SP-BPFINDINGS-013）。追加の起動が返した指摘の候補も反証に回す。反証役には、まとめた候補、候補の観点の照らす先のパス、資産の束のパスを渡す。反証役の項目の順位は、鍵の最初の候補を返した検証の項目の順位、同じ項目の中では候補が返った順とする。

#### SP-BPINSPECTION-019 照合と停止
完了前に対象が変わっていないことを SP-BPRUN-026 で確かめ、review の判断点の機械照合と未検査を含む全ての結果を保存しなければならない。結果と集計は保存した根拠から決定的に作り、agent の集約や言い換えで置き換えてはならない。停止後の書き込みの拒否は SP-BPRUN-017 に従わなければならない。

### 対象を書き換えない

#### SP-BPINSPECTION-020 書き手の役を持たない
review・audit では対象を書き換える役を起動せず、どの担当にも対象を変更する権限・指示を与えてはならない。直し方は指摘の文として返すだけとし、変更を適用してはならない。実際の制限と変更の照合は SP-BPRUN-025・026 に従わなければならない。

### 対象スキル

#### SP-BPINSPECTION-021 対象は既にあるスキル
review と audit の対象スキルは、対象スキルのパスの一覧の根が既にあるディレクトリで、その直下に `SKILL.md` があるものでなければならない（PR-BPOPERATIONS-028。review も、`docs/requirements/bp-operations.md` の用語「対象スキル」により既にあるスキルを扱う）。これを確かめるのは、開始の段で CLI の開始の操作（`docs/specifications/bp-run.md` の SP-BPRUN-003）とし、当たらないときの扱いは SP-BPINSPECTION-026 に従う。

#### SP-BPINSPECTION-022 対象スキルのパスの一覧
開始の段に渡す対象スキルのパスの一覧（`docs/specifications/bp-run.md` の「用語定義」）は、入口が `docs/specifications/bp-entry.md` の SP-BPENTRY-006・SP-BPENTRY-022 で作った一覧をそのまま使わなければならない。run の中で一覧を作り直してはならない。解決できなかった callsite を利用者に返すのも SP-BPENTRY-023 と SP-BPENTRY-021 の 1 箇所とし、本文書の結果には載せない。

## 外部インタフェース

#### SP-BPINSPECTION-023 review と audit の入力
review と audit の Workflow の入力は、`docs/specifications/bp-entry.md` の SP-BPENTRY-013 の表を正とし、本文書に表を置かない（同じ表が 2 箇所にあると、片方の項目だけが変わる）。本文書が入力に課すのは、対象スキルのパスの一覧の根が既にあるスキルであること（SP-BPINSPECTION-021）だけとする。

#### SP-BPINSPECTION-024 review と audit に固有の結果の項目
review と audit は、完了したとき、`docs/specifications/bp-run.md` の SP-BPRUN-032 と `docs/specifications/bp-findings.md` の SP-BPFINDINGS-030 の項目に加えて、次の項目を返さなければならない。

| 項目 | 綴り | 機能 | 中身 |
|---|---|---|---|
| 照らした先 | `targets` | review・audit | 観点ごとの照らす先のパスと照らす先の指紋（SP-BPINSPECTION-004）。各観点は `viewpoint`・`files`・`section`・`fingerprint`・`readable`・`reason` を持つ。files の各要素は `name`・`path`・`sha256` を持ち、存在しないファイルの sha256 は null とする |
| 適用の判定 | `applicability` | review | SP-BPINSPECTION-006 の答えと引用と、CLI が状態に書いた形と行（問い W がはいでないときは到達した形と SP-BPCONFORMANCE-003 の判定表の行、はいのときは `runs` の要素ごとの `{run, shape, row}`） |
| 未検査の観点 | `uncheckedViewpoints` | review・audit | SP-BPINSPECTION-025 の一覧。空でも項目を返す |
| 対象スキルのパスの一覧 | `target` | audit | 状態にある今の対象スキルのパスの一覧（`docs/specifications/bp-run.md` の SP-BPRUN-005）を、CLI が状態から逐語で写したもの（監査した範囲：SP-BPINSPECTION-014）。入力の `target`（`docs/specifications/bp-entry.md` の SP-BPENTRY-013）と同じ形にし、連鎖の次の run の入力にそのまま渡せるようにする |

review と audit が完了以外で止まったとき、返り値は `docs/specifications/bp-run.md` の SP-BPRUN-032 の項目に加えて、次の項目を持たなければならない。

| 項目 | 綴り | 中身（完了以外） |
|---|---|---|
| 止まった段 | `stoppedStage` | 停止の記録の段（CLI が `docs/specifications/bp-run.md` の SP-BPRUN-018 の規則で決めた段）の名前。名前は同文書の SP-BPRUN-038 が列挙する名前とし、停止の記録に段が無いときは `null` |

次の 2 つの場合は、返り値に stoppedStage を持たない。
- 状態を作らずに止まった run（SP-BPINSPECTION-026。入力の誤りで開始の操作の前に止まったときを含む）。
- 停止の記録を書けなかった BLOCKED（`docs/specifications/bp-run.md` の SP-BPRUN-027）。止まった段は、CLI の保存済みの進みから読めたときだけ、理由に書く（SP-BPRUN-027）。

targets の files の name は conformance・design・inspection・promptAudit・designedSkill とする。section はフローの観点が「機能仕様」、仕様の観点が「性能・容量」で始まる章、監査の観点が「Finding criteria」とする。fingerprint は基準の名前と内容の同一性を指し、保存場所だけの違いで変えてはならない。

#### SP-BPINSPECTION-025 未検査の観点の形と載せるもの
未検査の観点の 1 件は、観点、範囲、理由、記録した run を持たなければならない。範囲は、観点の全体か、判定の単位か、監査の観点の識別子のどれかとする。CLI は次の表の全ての場合に未検査の観点を作り、同じ観点と範囲と理由の重複は 1 件にまとめなければならない。

| 場合 | 観点 | 範囲 | 理由 |
|---|---|---|---|
| 仕様の観点の照らす先を読めない（SP-BPINSPECTION-005） | 仕様の観点 | 観点の全体 | 読めなかった照らす先のパス |
| 検証役が判定の単位を未検査とした（SP-BPINSPECTION-007・SP-BPINSPECTION-008） | フローの観点か仕様の観点 | 判定の単位 | 検証役の理由。`docs/specifications/bp-conformance.md` が未検査に固定した単位（SP-BPCONFORMANCE-019）は、その仕様項目 ID |
| bp-designed-skill の要求を優先して外した（SP-BPINSPECTION-012） | 監査の観点 | 監査の観点の識別子 | 優先した要求 ID と理由 |
| モデルに固有の鮮度を評価できない（SP-BPINSPECTION-013） | 監査の観点 | PA-4 | 名指しが無いか、証拠が無いか |
| 観点の全ての検証の項目が打ち切りになった（`docs/specifications/bp-run.md` の SP-BPRUN-028） | その観点 | 観点の全体 | 打ち切りの理由 |
| 判断点の表の機械照合の結果が未検査（SP-BPINSPECTION-007） | フローの観点 | 判定の単位 `SP-BPCONFORMANCE-041` | 機械照合の理由 |
| フローの観点を run の観点の集合に入れた（PR-BPDESIGNEDSKILL-051 はどの形でも当たる：`docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-003） | フローの観点 | 判定の単位 `SP-BPCONFORMANCE-041` | 同文書の SP-BPCONFORMANCE-041 の網羅の理由 |

未検査の観点に載せた観点と範囲を、結果の中で「問題なし」として返してはならない（照らしていない観点が照らしたと読まれる：PR-BPOPERATIONS-025）。

## エラー処理と異常系

本章は review と audit に固有の異常だけを扱う。agent の失敗・続けられない失敗・途中終了・CLI の拒否と BLOCKED の返し方は `docs/specifications/bp-run.md` の SP-BPRUN-027〜030 に従う。失敗の分類は、担当が fan-out の項目の工程の中で起動したか、その外で起動したかで決めなければならない。fan-out の外の担当の失敗は SP-BPRUN-027 の BLOCKED、fan-out の項目の工程の欠けは SP-BPRUN-028 の試行と打ち切りに従わなければならない。役の名前だけで分類を変えてはならない。資産が 0 件のときは `docs/specifications/bp-findings.md` の SP-BPFINDINGS-033 に従う。review と audit は needs_input で止まらない（`docs/specifications/bp-run.md` の SP-BPRUN-010）ので、利用者に直してもらう入力の不足も BLOCKED で返す。

#### SP-BPINSPECTION-026 対象が既にあるスキルでない
SP-BPINSPECTION-021 に当たらないとき、CLI の開始の操作は状態と作業場所を作らずに理由を返し、script は次の agent を起動せずに、BLOCKED と理由（渡されたパスと、ディレクトリが無いか `SKILL.md` が無いか）を返さなければならない。状態を作らないので、停止の記録を書かず、next_args を返さない（`docs/specifications/bp-run.md` の SP-BPRUN-011・SP-BPRUN-032）。

#### SP-BPINSPECTION-027 フローの観点・監査の観点の照らす先を読めない
照らす先の決定の段で、review のフローの観点か、audit の監査の観点の照らす先を読めなかったならば、script は、検証役を起動せずに、BLOCKED と理由（読めなかった照らす先のパス）を返さなければならない。指摘が 0 件の完了として返してはならない（照らさないまま「問題なし」と返すことになる）。audit で現行の prompt-audit（`references/prompt-audit.md` の写し）が無いときは、監査を実行せずに止まり、理由に読めなかったパスと、引き継ぐ監査の観点が無いことを書く。このときの返り値は、止まった段（照らす先の決定：SP-BPINSPECTION-024 の `stoppedStage`）と理由の報告とし（PR-BPOPERATIONS-013・028）、監査の結果を返さない。仕様の観点を読めないときだけは、SP-BPINSPECTION-005 のとおり止まらずに未検査とする（PR-BPOPERATIONS-025 が未検査として示すことを定めている）。

#### SP-BPINSPECTION-028 監査の観点の一覧が出所と食い違う
SP-BPINSPECTION-010 の照合で一致しなかったならば、script は、検証役を起動せずに、BLOCKED と理由（食い違った番号と名前）を返さなければならない。

#### SP-BPINSPECTION-029 再開したときの照らす先の食い違い
前の run が照らす先の決定の段を終えた状態から再開した run では、照らす先の決定の段で、CLI は照らす先を読み直し、状態にある照らす先の指紋と照らさなければならない。食い違ったならば、script は、検証役も反証役も起動せずに、BLOCKED と理由（食い違った照らす先のパス）を返さなければならない（違う基準で付けた指摘と判定が、1 つの台帳に混ざる）。再開した run は、状態にある観点の集合と、状態に結果のある担当の組と適用の判定をそのまま使い、作り直してはならない。

前の run が照らす先の決定の段を終える前に止まったとき（照らす先を読めずに BLOCKED になったときなど）は、本項を当てず、照らす先の決定の段を最初から行う（SP-BPINSPECTION-030。照合すると、利用者が直した照らす先が前の記録と食い違い、再開のたびに BLOCKED になる）。段を終えたかは、状態の段の進み（`docs/specifications/bp-run.md` の SP-BPRUN-005）の終えた段で決める。

#### SP-BPINSPECTION-030 再開した run の段の順
再開した review・audit は、今の対象資産を取り直し、照らす先の版を確認してから、必要な消えた資産の照合を行い、終えていない作業の未着手だけを順位の順に続けなければならない。既に確定した担当範囲と適用判定、結果のある項目、打ち切った項目を作り直してはならない。基準を確定する前に止まった場合だけ基準の決定をやり直し、確定済みの場合は SP-BPINSPECTION-029 の照合を行わなければならない。

対象資産の取り直しと証拠の対応の更新、取り直しで消えた資産の照合は、以前に終えた作業でも行わなければならない。検証を終えた後で対象が変わっていても検証を巻き戻して現在の合格を作らず、変わった資産は skip と、今の内容で判定したかの値で示さなければならない。

追加確認の途中では残りを処理し、skip が空になるか新しく見た資産が増えなくなるまで続けなければならない。反証の途中では未反証の残りを処理し、打ち切りの候補は未反証のまま残さなければならない。照合と停止で中断した場合は、現在の保存済み根拠で照合と停止を行わなければならない。

## 検証方法

既存スキル・基準・指摘候補を制御した fixture で、観点、適用判定、確認範囲、反証、状態、未検査と出力を観測する。基準の全部/一部の欠落、監査一覧の不一致、反証の失敗、資産の変更/消失、上限停止と再開、対象変更の検出を含める。

適用表と保持規則は正常・異常・境界を区別して照合し、未裁定の期待値を作らない。模擬の判定を返す試験は配線だけの検証とし、判断の質は bp-authoring の本物の agent の試走で確かめる。

検証方法の読み方と、決定的な検査・意味の判定・不適用の区別は、bp-run.md の「検証方法」を参照する。方法の正本は次の表の各 SP の 1 行とし、トレーサビリティ表は同じ方法を複製せずその行を参照する。

| 仕様項目 ID | 手段 | 入力と観測（条件・境界） |
|---|---|---|
| SP-BPINSPECTION-001 | 評価の結合テスト・独立性レビュー | 基準/対象の確定、適用、反証、追加確認、消失照合と対象版照合を持つ題材で、必要結果が揃う前の完了を拒否することを確認する。内部 worker 件数は期待値にしない。 |
| SP-BPINSPECTION-002 | readonly 機能の履歴照合 | 指摘あり/追加確認ありの review/audit を与え、対象の書直しへ戻らず、追加確認を反復回数に数えず、起動数だけが上限停止を生むことを確認する。 |
| SP-BPINSPECTION-003 | 機能別観点の全組テスト | review/audit の結果と適用基準を照合し、表の観点だけが使われることを確認する。未定義の追加観点と片方欠落の負例を含める。 |
| SP-BPINSPECTION-004 | 基準可読性と版の fixture テスト | 章/単位あり、章なし、単位 0 件、依存する基準の欠落と版変更を与え、可読性・出所・指紋と run 内の基準固定を確認する。 |
| SP-BPINSPECTION-005 | 部分基準欠落の結合テスト | review の仕様観点だけを読めなくし、全体の未検査を 1 件返し、その観点の検証・ coverage ・ skip ・追加確認を作らないことを確認する。フロー欠落は 027 と区別する。 |
| SP-BPINSPECTION-006 | 適用判定 schema ・決定表の全組テスト | 閉集合の答え、A/W/Q の全並び、runs の数/名前/資産参照/置場を変え、形と適用行または拒否を照合する。未裁定の assets 入力に期待値や配布を先行させないことも確認する。 |
| SP-BPINSPECTION-007 | 単位割当ての決定的検査・フローの独立レビュー | 準拠/違反/未判定の対象で、フローの指摘と未検査を確認する。値の単位の除外、host 例外、機械照合指摘の資産選択と反証除外は固定 fixture で照合する。 |
| SP-BPINSPECTION-008 | 確定値差分の fixture テスト | 値/規則を 1 つずつ違反させた対象で、仕様観点の種類と未検査が該当 SP に対応することを確認する。モデル値の除外と prompt への値の二重記載も静的照合する。 |
| SP-BPINSPECTION-009 | 監査観点の閉集合検査 | 現行基準の項目と PA 識別子を対応させ、有効な各種類と未知種類を与えて受理/拒否を確認する。基準の観点本文は写さず原典へ照合する。 |
| SP-BPINSPECTION-010 | 基準一覧の一致・不一致テスト | 件数・番号・太字名を各 1 つ変えた基準と一致基準を与え、一覧の照合と不一致での停止を確認する。 |
| SP-BPINSPECTION-011 | 監査範囲の独立 fixture レビュー | agent 向け指示と説明文、具体的影響のある違反と好み/Low だけの懸念、権威ある証拠の有無を混ぜ、候補の範囲と根拠・最小修正を照合する。資産の分母が減らないことも確認する。 |
| SP-BPINSPECTION-012 | 監査競合の fixture ・公開結果テスト | 複数監査項目と BP 要求に衝突する候補を与え、全観点適用、要求優先による除外と未検査理由を確認する。上限なしの PA-3 除外が毎回出る固定例も照合する。 |
| SP-BPINSPECTION-013 | 鮮度根拠の独立 fixture レビュー | モデル等の名指しあり/なしと権威ある証拠あり/なしを与え、根拠が無い PA-4 候補を作らず、理由付きの一部未検査へ出すことを確認する。 |
| SP-BPINSPECTION-014 | 公開出力の schema ・監査 flow レビュー | 現行 audit の固有出力欄を持つ題材と新しい結果を比較し、引き継がない欄を作らず、監査範囲・基準出所は 024 の欄で返ることを確認する。 |
| SP-BPINSPECTION-015 | 担当範囲の独立レビュー・閉集合検査 | ファイル間依存、重なる担当、担当漏れ、未知資産 ID を与え、依存を含む同じ範囲/順位を全観点に渡し、漏れは skip ・未知 ID は拒否となることを確認する。 |
| SP-BPINSPECTION-016 | 観点×担当と順位の決定的テスト | 複数観点・担当と skip 追加を与え、全ての組が対象となり、残作業は観点順・担当順で保持されることを確認する。同時完了の順が変わっても順位を保つ例を含める。 |
| SP-BPINSPECTION-017 | 配達する原文と参照の照合 | 対象版と行番号、担当 ID ・基準・種別を受取側で比較し、要約で原文を代用しないことを確認する。版変更、未検査欄欠落、不正な範囲/閉集合の拒否も試す。 |
| SP-BPINSPECTION-018 | 反証対象と順位の結合テスト | 最初/追加確認から同鍵/異鍵候補を返し、重複以外の全鍵が同じ基準と原文で独立反証されることを確認する。順位が候補の出所と返却順に一致することも照合する。 |
| SP-BPINSPECTION-019 | 完了直前の結合テスト | 対象変更と機械照合/未検査の保存失敗を起こし、未保存または変更したまま完了しないことを確認する。元記録と最終結果の集計・内容も比較する。 |
| SP-BPINSPECTION-020 | 役の権限と対象版の静的・動的照合 | review/audit の全担当の書込み権限と指示を検査し、修正案を返しても対象が変更されないことを確認する。実変更の負例は RUN026 の BLOCKED に照合する。 |
| SP-BPINSPECTION-021 | 既存対象の境界テスト | 既存 dir と SKILL.md あり、dir なし、通常ファイル、SKILL.md なしを与え、有効な対象だけ受け付けることを確認する。 |
| SP-BPINSPECTION-022 | 起動入力と対象範囲の結合テスト | 入口で確定した根/外部 Workflow/解決不能 callsite を渡し、run で一覧を作り直さず、除外報告が入口の 1 箇所だけに出ることを確認する。 |
| SP-BPINSPECTION-023 | 入力 schema の機能別テスト | review/audit の新規と再開で ENTRY013 の必須/禁止欄を変え、対象の既存性と入力受理/状態なし拒否を照合する。 |
| SP-BPINSPECTION-024 | 機能・停止別の公開 schema テスト | review/audit の完了/各未完停止/状態なし/停止保存不能で、targets ・適用判定・未検査・対象・段の条件付き出力を照合する。基準内容が同じで保存場所だけ違う指紋も比較する。 |
| SP-BPINSPECTION-025 | 未検査一覧の全場合テスト | 表の各発生理由と重複を入力し、観点・範囲・理由・ run が残り、同じ内容は 1 件にまとまり、問題なしへ変わらないことを確認する。 |
| SP-BPINSPECTION-026 | 対象不正の起動前テスト | 既存性の条件を 1 つずつ欠かし、理由にパスと欠落が含まれる BLOCKED、状態/作業場所/next_args なし、次担当の起動なしを確認する。 |
| SP-BPINSPECTION-027 | 観点基準の欠落テスト | フロー/監査/仕様の基準を個別に読めなくし、前 2 者は検証を始めず段と理由付き BLOCKED、監査基準なしでは監査結果を返さず、仕様だけは未検査で続行することを確認する。 |
| SP-BPINSPECTION-028 | 監査一覧不一致の停止テスト | 番号/名前/件数の違う基準を与え、検証を起動せず、不一致箇所を理由に BLOCKED となることを確認する。 |
| SP-BPINSPECTION-029 | 基準確定前後の再開テスト | 確定後に基準を変更して再開すると検証/反証なしで BLOCKED となり、既存の担当/適用を保つことを確認する。確定前の欠落復旧は基準を決め直せる例と対にする。 |
| SP-BPINSPECTION-030 | readonly 再開の結合テスト | 各停止段で結果あり/未着手/打切りを作り、未完だけを再開することを確認する。対象変更/消失では必要な取直しと照合だけを行い、古い確認を現在版の合格にせず skip ・現版判定へ示す。 |

## トレーサビリティ表

整理後の契約を実装が満たすかは未検証である。旧版のテストの「完了」を持ち越さず、各行は現契約に対応する実行証拠が得られてから更新する。

| 要求 ID | 仕様項目 ID | 検証方法 | ステータス |
|---|---|---|---|
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-001 | [検証方法](#検証方法) の SP-BPINSPECTION-001 行 | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-002 | [検証方法](#検証方法) の SP-BPINSPECTION-002 行 | 未着手 |
| PR-BPOPERATIONS-024 | SP-BPINSPECTION-003 | [検証方法](#検証方法) の SP-BPINSPECTION-003 行 | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-003 | [検証方法](#検証方法) の SP-BPINSPECTION-003 行 | 未着手 |
| PR-BPOPERATIONS-025 | SP-BPINSPECTION-004 | [検証方法](#検証方法) の SP-BPINSPECTION-004 行 | 未着手 |
| PR-BPOPERATIONS-025 | SP-BPINSPECTION-005 | [検証方法](#検証方法) の SP-BPINSPECTION-005 行 | 未着手 |
| PR-BPOPERATIONS-024 | SP-BPINSPECTION-006 | [検証方法](#検証方法) の SP-BPINSPECTION-006 行 | 未着手 |
| PR-BPDESIGNEDSKILL-051 | SP-BPINSPECTION-007 | [検証方法](#検証方法) の SP-BPINSPECTION-007 行 | 未着手 |
| PR-BPOPERATIONS-024 | SP-BPINSPECTION-007 | [検証方法](#検証方法) の SP-BPINSPECTION-007 行 | 未着手 |
| PR-BPOPERATIONS-025 | SP-BPINSPECTION-008 | [検証方法](#検証方法) の SP-BPINSPECTION-008 行 | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-009 | [検証方法](#検証方法) の SP-BPINSPECTION-009 行 | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-010 | [検証方法](#検証方法) の SP-BPINSPECTION-010 行 | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-011 | [検証方法](#検証方法) の SP-BPINSPECTION-011 行 | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-012 | [検証方法](#検証方法) の SP-BPINSPECTION-012 行 | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-013 | [検証方法](#検証方法) の SP-BPINSPECTION-013 行 | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-014 | [検証方法](#検証方法) の SP-BPINSPECTION-014 行 | 未着手 |
| PR-BPOPERATIONS-033 | SP-BPINSPECTION-015 | [検証方法](#検証方法) の SP-BPINSPECTION-015 行 | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-016 | [検証方法](#検証方法) の SP-BPINSPECTION-016 行 | 未着手 |
| PR-BPOPERATIONS-024 | SP-BPINSPECTION-017 | [検証方法](#検証方法) の SP-BPINSPECTION-017 行 | 未着手 |
| PR-BPOPERATIONS-025 | SP-BPINSPECTION-017 | [検証方法](#検証方法) の SP-BPINSPECTION-017 行 | 未着手 |
| PR-BPOPERATIONS-031 | SP-BPINSPECTION-018 | [検証方法](#検証方法) の SP-BPINSPECTION-018 行 | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-019 | [検証方法](#検証方法) の SP-BPINSPECTION-019 行 | 未着手 |
| PR-BPOPERATIONS-030 | SP-BPINSPECTION-020 | [検証方法](#検証方法) の SP-BPINSPECTION-020 行 | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-021 | [検証方法](#検証方法) の SP-BPINSPECTION-021 行 | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-022 | [検証方法](#検証方法) の SP-BPINSPECTION-022 行 | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-023 | [検証方法](#検証方法) の SP-BPINSPECTION-023 行 | 未着手 |
| PR-BPOPERATIONS-013 | SP-BPINSPECTION-024 | [検証方法](#検証方法) の SP-BPINSPECTION-024 行 | 未着手 |
| PR-BPOPERATIONS-025 | SP-BPINSPECTION-024 | [検証方法](#検証方法) の SP-BPINSPECTION-024 行 | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-024 | [検証方法](#検証方法) の SP-BPINSPECTION-024 行 | 未着手 |
| PR-BPOPERATIONS-024 | SP-BPINSPECTION-025 | [検証方法](#検証方法) の SP-BPINSPECTION-025 行 | 未着手 |
| PR-BPOPERATIONS-025 | SP-BPINSPECTION-025 | [検証方法](#検証方法) の SP-BPINSPECTION-025 行 | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-026 | [検証方法](#検証方法) の SP-BPINSPECTION-026 行 | 未着手 |
| PR-BPOPERATIONS-024 | SP-BPINSPECTION-027 | [検証方法](#検証方法) の SP-BPINSPECTION-027 行 | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-027 | [検証方法](#検証方法) の SP-BPINSPECTION-027 行 | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-028 | [検証方法](#検証方法) の SP-BPINSPECTION-028 行 | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-029 | [検証方法](#検証方法) の SP-BPINSPECTION-029 行 | 未着手 |
| PR-BPOPERATIONS-028 | SP-BPINSPECTION-030 | [検証方法](#検証方法) の SP-BPINSPECTION-030 行 | 未着手 |
