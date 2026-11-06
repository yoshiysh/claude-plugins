# impl-doccheck coverage

対象: plugins/workflow/skills/prd-spec/scripts/doc_check.mjs（wc -l で 4570 行）

## 読んだ範囲

- 1-4569 行を Read で全て読んだ。4566-4570 行は sed で確認（4570 行は export の閉じ括弧 `}`）。
- 読めなかった範囲は無い。
- 検算: `grep -n "throw "` が返した行番号（428 から 4486 まで、94 行）を、TSV の行に全て対応づけた。`process.exit` は 3 箇所（4507 = 3 または 1、4513 = 2、4520 = 1）で、いずれも TSV にある。
- `DigestMismatch` を投げるのは 4008（wsDiff）だけで、exit 3 になるのはこの経路だけ（grep で確認）。
- `blocking`・`degraded`・`stray`・`undeclared` の語はこのファイルに出る。`missed`・`integrity`・`defect` は 0 件。`notices` は 3966-3967 のコメントに 2 回出るだけで、コードには無い。notices・missed・integrity・defect という欄はこのファイルにも出力 JSON にも無い（grep 結果）。これらの欄を作る側は prd-spec.js などで、このファイルの範囲外。

## TSV の構成上の注意

- 件数は 358 行。kind ごとの内訳は throw 77、check-fail 152、fail-open 42、fallback 33、limit 12、state-check 33、exit-error 9。
- `exit-error` は process.exit の 3 箇所と、parseWorkspaceArgs / runWorkspace の引数・workspace・モードの検査（4420, 4451, 4460, 4462, 4486）に限った。ほかの throw は kind を `throw` にしてある。実際は全て main の catch で exit 1 になる（`LedgerRejected` も `Error` も区別されない）。
- `check-fail` の outcome の `ST-…` は、FINDING_TEXT / WORKSPACE_TEXT / LINT_TEXT の id の書式。文面（issue / fix）は転記していない。文面は 106-422、1391-1627、1633-1662 行にあり、全て読んだ。
- `severity: 'degraded'` が付く符号は NOUNIT・MODAL・IDHEADING・TBD_NORESOLVE。これらは着手を止めない区分。それ以外は severity 無し。wsDoc は severity 無しの指摘と degraded を `blocking = counted - degraded` で分ける。
- 状態の検査と判定表の検査は、`stateCheck`・`decisionCheck` の構文条件に合った表だけが対象。合わない表は無言で対象外になる（TSV の fail-open 行）。
- 「呼び出し側の範囲」と書いた箇所は、prd-spec.js・agents/・schemas を読んでいないので未確認。例えば FIXERS_BY_CODE、notices の組み立て、exit code を受けた側の処理、blocking を受けた側の停止条件。

## 判断に迷って入れなかった候補

| file:line | 理由 |
|---|---|
| 34-43 newlineCount / lineTotal の `String(md || '')` | 入力の空文字化。検査の分岐に影響せず、個別に列挙するほどの fallback ではない |
| 48-101 changedLineRanges | 範囲計算で、失敗も fail-open も無い。前稿が無い場合は呼び出し元（1355）で null になるので、そこを記録した |
| 519, 563 splitAxis / AXIS_START | 軸宣言の構文の定義。宣言が構文に合わないときの扱いは stateCheck の `declaredStates` が null になる経路（654 の fallback に含めた） |
| 614-623 namesIn | 状態名の部分一致の消し込み。名前が他の名前の部分文字列のとき長い方を優先するだけ |
| 939 fixable | DUP の d を固定でない文書へ寄せる。TSV 940-943 の行の note に含めた |
| 1235-1242 stableKey | ハッシュ。衝突時の扱いは無い |
| 1272-1276 stampStdout | `JSON.parse(JSON.stringify(value))` は循環参照・BigInt で TypeError になりうるが、本ファイルの出力は JSON 化できる形だけなので候補にとどめた |
| 1681 listOf | 配列でも `{key: 配列}` でもなければ `[]`。全台帳の読み取りで使うが、個別の行にしていない（台帳が無い・形が違うとき空として扱う fallback） |
| 1845-1847 sortDeep / ledgerText | 正規形の定義。非正規形の検出は 1891-1893 に記録した |
| 2132 fileSha | ファイルが無ければ null。restore / reset の戻り値に出るだけ |
| 2288-2296 answerTexts | `answers/` の個々のファイル読み取りに try/catch が無い。読めない `.md` があれば throw になりうる（TSV 2290 の行は存在しない場合の `[]` だけを記録） |
| 2452-2472 answerSections | 節の頭は台帳にある ID の行だけ。ID が台帳に無い `RS-n:` 行は前の節の続きとして扱われる。検査ではなく切り出しの定義 |
| 2550-2603 mergeList / dropByCase / mergeElement | 重複 ID の拒否（2574）だけ記録した。groupBy 配列（meta.trace）は同じ ID の重複を許す |
| 2752 aboutText | 論点の同一性判定（pair 配列を文字列ソート）。aboutRejects（2756-2764）に含めた |
| 3243-3245 decisionRefs / constraintsOf | 引数の正規化。例えば constrained_by が配列でなければ [] |
| 3282-3287 failBranches | 失敗の枝の集合を求める。`上記以外` と `*` は除く、とコメントにある。FLOW_INPUT_UNKNOWN の判定で使う（3359）ので note で触れた |
| 3293-3306 reach | 到達集合。stop 要素を越えない |
| 3698-3699 DOMAIN / PLAN_VERDICT_NEEDS | 定数。使用箇所（wsPlan, domainAssessmentRejects）を記録した |
| 4040-4068 headingWalk | INDEX の導出。fallback は 4057 / 4125 に含めた |
| 4414-4454 parseWorkspaceArgs | 受理する引数名の列挙は 4451 の行に含めた。`--check` `--rulings` `--lint` `--sweep` 以外が値を取ること、カンマ区切りの空要素除去は個別の行にしていない |
| 4524-4569 export | テスト用の公開。エラー経路は無い |

## 見ていない箇所を「無い」と扱わないための補足

- このファイルは `schemas/agent-contracts.md`・`references/domain-analysis.md` を実行時に読む（3703, 3851, 3890）。これらの中身は読んでいない。契約の見出しが無い・所有表が読めない場合の throw は TSV にある。
- `TX_TOKEN`・`txOrder` の順序規則（2078-2085）は、token の形 `t<数>` / `t<数>r<数>` だけを受け付ける。通し番号が大きい token の控えがあれば restore は何も戻さず pruned_by を返す経路は TSV の 2171-2172 の行。
- `wsRestore`（2166-2190）が「控えの dir が無く、後の token も無い」場合に `restored: 0` で成功を返す経路は、exit 0 のまま通る（TSV に記録）。この結果を受けた側（script）が成功と扱うか止めるかは範囲外。
- `wsFormalModel`（4181-4412）が出力する check.test.mjs の失敗条件は、生成する文字列の中身であり、doc_check の実行時には評価されない（TSV 4381-4389 の行に注記）。
- `wsDoc` の `blocking` は固定文書の指摘を除いて数える（3788-3790）が、`not_checked` の件数は blocking に入らない（件数だけ返す）。つまり not_checked があっても blocking が 0 件なら、このファイルの出力上は blocking 0 件になる。これを完了判定でどう扱うかは範囲外（呼び出し側）。
