# #207 の流れの模型の作り役の brief

R=/Users/yoshi/github/yoshiysh/claude-plugins/.claude/worktrees/skill-update-generic-design-720616
目的: #207 が AGENTS.md と docs/guidelines/workflow.md に入れる作業の流れを、設計の段で TLA+ の模型にし、TLC で欠陥の証拠を出す（証明とは扱わない）。この模型の結果を土台に、別の設計役が設計 v5 を作る。
prd-spec・formal-methods スキル・Workflow は使わない。文書・コードは書き換えない。出力先は R/.work/agents-md/flow-model/ だけ（.md は書かない。説明は .tla のコメントか .tsv）。スクリプトは出力先にだけ書き、この run で自分が書いていないスクリプトは実行しない（共有の /private/tmp/claude-501/scratch や既存の gen.py・mk.py は使わない）。書き込みが拒否されたら迂回せず報告して止まる。git 操作をしない。
TLC: `java -XX:+UseParallelGC -Djava.io.tmpdir=<出力先>/tmp -cp /Users/yoshi/.local/share/tla/tla2tools.jar tlc2.TLC -metadir <出力先>/states -workers 4 -config X.cfg X.tla`（1 回 2 分以内に収まる定数にする）。

## 正本
- 利用者の決定: R/.work/agents-md/design-review-1/answers.txt の全て（最初の決定、Q1〜Q10、V1〜V5、W1・W3〜W5、X1〜X3。Q8 は Q7 を置き換える）
- 目的: R/.work/agents-md/design-v3/purpose.txt
- 設計 v4: R/.work/agents-md/design-v4/（特に files.tsv の AGENTS.md「作業ルール」と workflow.md・review-lenses.md の content_gist、agents.tsv）
- v4 のレビューの集約: R/.work/agents-md/design-v4-review/aggregate/bundles.tsv（19 束。V1: 重大度を付ける者と尺度が無い、V2: 抽出を 1 回にして配る規則と各体の冷読みの矛盾、V7: 成果物と判定の記録の置き場、V8: 段と担い手の対応 など）
- 既存の規範: main の R/AGENTS.md の「作業ルール」（特に生成と検証の分離、役割の分担は構造で持つ、途中で止めない）

## 作るもの
1. 模型: 1 つの変更（作業）の生涯。状態: 目的の固定 → 設計 → 設計レビュー → 実装 → 実装レビュー → PR → マージ（人間ゲート）。イベント: 各段の生成者の作業と自己検査（成功／成果物の欠陥／除ける環境の原因／除けない環境の原因）、レビュー役の指摘（重大度つき・無し）、重大度の振り分け、人の PR 指摘、利用者への報告と停止。担い手（作り手・レビュー役・司令塔・人）を変数で持ち、誰がどの遷移を起こせるかを模型にする。規模（typo 級／それ以外、W5・X1）と成果物の置き場（PR 本文／commit）も持つ。
2. 性質（決定から立てる。最低限）:
   - 振り分ける前に、全ての指摘に重大度が付いている（付けるのは司令塔でない）
   - 設計レビューを通らずに実装へ進む経路が無い。実装レビューを通らずに PR を出す経路が無い
   - MEDIUM 以上の agent・bot の指摘は設計に戻る。LOW は PR 本文に載り直さない。人の指摘は重大度を問わず直る（X3）
   - 作業中の自己検査の成果物の欠陥は設計に戻る（Q5）。除ける環境の原因はその場でやり直す（Q10）。除けない環境の原因は報告して止まる（Q9）
   - 止まってよいのは人間ゲート（マージ、X2）と除けない失敗の報告だけ。止まった状態ごとに次の行動が 1 つに決まる
   - 生成者が自分の成果物の合否を決める遷移が無い
   - 非終端の状態から終端（マージ、または報告して停止）に到達できる（公平性の仮定を明記する）
3. 変異: 性質ごとに 1 つ以上（例: 重大度を付けずに振り分ける、司令塔が重大度を付ける、設計レビューを飛ばす）。TLC が検出することを示す。
4. 設計 v4 に当てた版: v4 の設計どおりに書いた模型（v4.cfg）で、どの性質が破れるか（反例を cex/ に保存）。
5. 出力: *.tla・*.cfg・results.tsv（列: check	cfg	states	result	cex	note）・trace.tsv（列: action	source	quote。source は決定の ID か design-v4 の行。quote は逐語）・table.tsv（列: state	event	guard	next	actor	source）・questions.tsv（決定から一意に導けない遷移だけ。列: qid	state	event	problem	options	recommend）
最終報告は短く日本語で: 状態数、性質ごとの結果（決定どおりの模型と v4 の模型）、問いの数。
