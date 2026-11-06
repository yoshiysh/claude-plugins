# #207 の設計 v5 の設計役の brief

R=/Users/yoshi/github/yoshiysh/claude-plugins/.claude/worktrees/skill-update-generic-design-720616
あなたは PR #207 の設計役（fresh）。文書・コードは書き換えない。出力は R/.work/agents-md/design-v5/ だけ（.md は書かない）。スクリプトは出力先にだけ書き、この run で自分が書いていないスクリプトは実行しない（共有の /private/tmp/claude-501/scratch や既存の gen.py・mk.py は使わない）。書き込みが拒否されたら迂回せず報告して止まる。git 操作をしない。

## 正本（この順に優先）
1. 利用者の決定: R/.work/agents-md/design-review-1/answers.txt の全て（D1〜D4、Q1〜Q10、V1〜V5、W1・W3〜W5、X1〜X3、Y1〜Y4、Z1〜Z3 と、導けた答え）。Q8 は Q7 を置き換える。
2. 目的: R/.work/agents-md/design-v3/purpose.txt。置く基準: R/.work/agents-md/design-v3/placement-criteria.tsv。
3. 流れの模型: R/.work/agents-md/flow-model-2/table.tsv（状態×イベント）と Flow.tla。ただし検証役の判定 R/.work/agents-md/flow-model-2-verify/ を当てる（C4 は外す、自己検査の失敗は重大度を付けず全て設計に戻す、人の指摘に重大度は付けない、C3 は「次の行動が 1 つ」を表していない）。模型の表の遷移は設計の規則に 1 対 1 で写す。表に無い遷移を足さない。

## 土台
- 前の設計 v4: R/.work/agents-md/design-v4/（files.tsv・refs.tsv・agents.tsv・out-of-scope.tsv・canon-inventory.tsv・main-lines.tsv）。正しい部分は残す。
- v4 のレビューの集約: R/.work/agents-md/design-v4-review/aggregate/（bundles.tsv の 19 束、classified.tsv）。layer が design と fact の束を直す。text の束は、本文ができた段の実装レビューで見る項目として checks-for-impl.tsv に持ち越す。
- v4 の作り直しで 74 件中 45 件が持ち込まれた。原因の多くは、規則を足したときにその規則が要る役・入力・尺度を決めなかったこと。v5 では、規則を 1 つ足すたびに、その規則を実行する担い手・入力・出力・置き場が決まっているかを、模型の表と agents.tsv で照らす。

## 規範
- 解決は常に根本原因の除去を目指す。目的に要るかで切る。端の場面を条項で閉じない。
- 同じ値・規則を 2 箇所に書かない（V5 の 3 つの抜粋は逐語の写しとし、テストで照らす）。
- 本文に作業用の参照（Q・V・W・X・Y・Z の番号、main の行番号、.work のパス）を書かない。

## 出力
- files.tsv・refs.tsv・agents.tsv・out-of-scope.tsv（v4 と同じ列。agents.tsv に tools 列と、重大度を付ける専用の agent を足す）
- rules.tsv（列: rule	file	model_transition	actor	input	output	place）: 設計が置く規則と、模型の遷移・担い手・入出力・置き場の対応。全ての規則が模型の遷移か、模型の外（理由）のどちらかに当たる。
- limits.tsv: PR 本文の範囲と限界に載せるもの（Z1・Z2 のリスクと仮定を含む）。
- checks-for-impl.tsv: 実装レビューに持ち越す text の層の項目。
- 最後に自分の出力を機械で照らす（refs.tsv の new_target が files.tsv にあること、rules.tsv の model_transition が table.tsv にあること、AGENTS.md の行数の見込み）。照らした結果を selfcheck.tsv に書く（合否は付けない）。
最終報告は短く日本語で。
