# impl-workflow 棚卸しの coverage

## 読んだ範囲

- plugins/workflow/workflows/prd-spec.js: L1-3171 の全行（Read で 1-600, 601-1200, 1201-1750, 1751-2300, 2301-2800, 2801-3171 を連続して読んだ）
- plugins/workflow/skills/prd-spec/SKILL.md: L1-234 の全行
- plugins/workflow/skills/prd-spec/references/workflow-io.md: L1-258 の全行

読めなかった範囲: なし。

## 行番号と trigger の作り方

- 各行の trigger は対象ファイルから文字列検索で取った逐語の断片（複数行にまたがるものは改行を空白に置き換えて 1 セルにした）。file:line は断片の先頭行。
- 関数名は、行番号から手前の `function X` / `const X =` を機械的に引いて照合した（モジュール最上位・「定数」・「メイン loop」の行は最上位コードなので関数名に代えた）。
- doc 側の行（SKILL.md / workflow-io.md）の outcome・note は文書の記述の要約であり、js の挙動の確認結果ではない。js との対応は note に「js: ...」と書いたものだけ。

## 件数の内訳

prd-spec.js 240 行 / SKILL.md 20 行 / workflow-io.md 35 行（計 295 行）。

## 判断に迷って入れなかった候補

- prd-spec.js:1101-1119 reconcile / 1124-1133 rulingsFromW: W の台帳と script の持つ合否が合わない resolution を carry にして再検証に回す。異常分岐というより状態の整合なので行にしていない。再検証後の失敗側は verifyLeft の行（L2029 の error）に出ている。
- prd-spec.js:1306-1322 absorbResolver（特に L1314: 問いとして返した ID が既に answered なら answered から外す）: 状態更新で、停止や分岐にならないため。
- prd-spec.js:1984-1996 adopt の早期 return（採った問いも指定外 hold も無ければ `{ fc }`）: 正常系のため。
- prd-spec.js:1394-1396 fixedDocLine / repoLine: decidable の出典を受け取る条件の一部。decidableDefect の行の note に含めた。
- prd-spec.js:2236-2241 specOnly の判定本体: IW の specOnly 行で結果だけ書いた。
- prd-spec.js:2290-2297 answerExcerpt: 異常経路ではない。
- prd-spec.js:3027-3029 finalHold の flowLeft: finalHold の最後の return-blocked 行の outcome に含めた。
- prd-spec.js:2910 `if (!h.results[0] || !usable(d)) return null`: 行にした（fail-open）。直後の L2930-2933 で blocked になるので、追加監査が飛ぶのは blocked の場合に限る、と note に書いた。
- doc 側: SKILL.md の「## 参照ファイル」表、workflow-io.md §6（L225-258）の doc_check CLI の各モードの内部の異常（exit 3、exit 1、place・reset・report が引数や形の不整合で何も書かずに止まる記述）は、司令塔の分岐として書かれていないため行にしていない。js 側から見える形は resetEntry の blocked 行（L2321）、stage8 の diff_error 行（L2930）に出ている。

## 見ていないものを「無い」と扱わないための注記

- 「回数で打ち切る定数を見つけていない」類の記述（rerunTx の note）は、prd-spec.js を全文読んだうえでの「読んだ範囲では見つけていない」であり、grep の網羅確認ではない。
- doc_check.mjs・agents/*.md・schemas/*.md は対象外で読んでいない。finish が載せる返り値の欄の意味（holds・integrity など）は workflow-io.md §3 の記述を参照しただけで、doc_check.mjs 側の挙動は確認していない。
- `rerun` の扱い: js 内の内部返り値 `{ error, rerun }` を blocked に変換する式は段関数ごとに違う。`res.rerun === false ? null : <段>`（stage2・3・3a・3a'・3b・6、enterFromDisk、holdLeft の呼び出し側）と、`rerun ? <段> : null`（finalHold、fixedMoved の呼び出し側 stage5・stage8）がある。rerun キーを持たない error（onlyAsked 由来・settle 由来など）は前者の式では next_args あり。各行の outcome に変換の式を書いたが、呼び出し経路の全列挙はしていない。
