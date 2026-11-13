# 小契約C層 run32 固定入力の独立レビュー

対象: `contract-run-20261113-32/input.smt2` 2455行、SHA-256 `a61cbfa45c426ba12aa6ddaf1e5e307bc3e967963e93624a7b2ad6668feea436`。同runのinput/output hash、Z3 5.3.3版、exit 0、raw、期待/実測TSVを照合した。固定入力を保存Z3絶対pathで**一度だけ**read-only再生し、保存stdoutとの`diff`はexit 0。166 queryはSAT 105/UNSAT 61、不一致0。166は局所query数であり33S/56要求の達成数ではない。

判定: **run29 preflightの四欠けは、選定した有限C関係に関して修復された。C全域・全source句の意味合格は未達。** この票はrun32固定版に限り、旧run29の失敗を遡及して解消したとは扱わない。

1. `RewriteChoice`はauthoringの非形式不合格かつ形式失敗なしに限る書直しfieldの選択へ分かれ、`CoreClass`はactiveな停止/完了の義務違反をA/Fで扱う（1624–1698行）。普通不合格で停止して未達/理由/報告を欠く出力はF、形式不成立と同時ならrewrite choiceは非適用（1727–1765行）。O011のmayをOut全体のChoiceへ広げていない。報告義務のsource対応はO010の未達報告に加え、適用するO013/O040等の段/理由を別に保つ必要があり、全操作/段での意味対応は未確認。
2. `HintAckClass`は返却済み同deliveryへのframed rejectionの原因がsourceで決まらない領域をUにし、acceptedで旧既読factを失う出力はF（2026–2079行）。`HintAddClass`は完了状態への追記拒否をA・受理をF、非完了のframed rejectionを原因未定Uに分ける（2405–2455行）。単なるRejectedをChoiceとはしない。これらのU全領域とその到達はまだ列挙していない。
3. review needs_input+savefailでは、O005を局所NoClassとしても、同じreview op/run/停止episodeのIState/Outを`BPReportJoin`で結び、O052の5欄、O013の段/理由、O051経由の保存失敗義務を和集合にする（2306–2403行）。Realizableは文脈/停止入力、Compliantは報告義務を追加して別SAT。決めること欄・段・保存理由の各欠落は同前件UNSAT、決めること欄義務だけを外したmutantはSAT。可用性と保存状態は別型で、既知材料を未保存という理由だけで不存在へ変えない。
4. `EntryScope`は対象Workflowの有限StageRef 4値と2item rank値域、`EntryReach`は同域の状態整合、`EntryApplicable`は完了/入力変更の先行例外を分ける（1792–1856行）。4 phase×2 rankの各正常SAT、symbolic A/Fの不一致UNSAT、域外phase/重複rank/完了の別扱いは保存結果と一致した（1860–1918行）。この4 phaseは実装段の強制でもS20–22任意段の保証でもない。候補の型値を`EntryInputFeasible`で生成前に除外した全域証拠は無く、到達不能候補の意味分類省略はScope/Reach理由とともに**未処理**として残す必要がある。

**残余の区分**: (a) 未実装・未検証: 型付き候補K全域の生成/重複・欠落、全33signatureのA/F/Choice/U、各Uの到達、4projectionの全同時context join、source短句spanのcovered確定、remaining groups 2–4、33Sの全正常/禁止/例外。`contract-domain.tsv`の33行はquery名の接続で意味保証ではない。(b) `contract-source-inventory.tsv`の235 unitは132文+103規範offsetの**重なる索引**で、assignmentはgroup2=59/group3=25/group4=55/U=96、covered判定済みspanは無い。索引全数をsource句被覆へ変換しない。(c) 真にこの要求定義の有限整合モデル外: 実host/CLIの強制、物理保存の実体、LLM文章・検証の品質。任意件数/無界時間は有限境界の外で未検証と明記し、モデル外というだけで要求を完了扱いしない。旧50action/24遷移の保証未達も維持する。

参照: run32固定input/raw/hash/receipt/TSV、`contract-domain.tsv`、`contract-source-inventory.tsv`、O005/O010/O011/O013/O040/O051/O052とdesign hint/entryの該当原文、前票`contract-run-20261112-29-c-preflight.md`・`contract-c4-repair-design-review.md`。BP仕様6本・CLI実装・旧SMT全文は未読。source/コード/solver入力/rawは変更していない。
