# 模型の忠実さの検証役の brief（fresh）

R=/Users/yoshi/github/yoshiysh/claude-plugins/.claude/worktrees/skill-update-generic-design-720616
対象: R/.work/prd-spec-abnormal/model-1/ の TLA+ 模型（Run.tla・Issue.tla・Seam.tla・Composed.tla、cfg、trace.tsv・table.tsv・questions.tsv・results.tsv、mutants/・options/）。作り役の説明は読まない（.tla のコメントは読んでよい）。
目的: 模型が実装と利用者の決定を忠実に写しているか、性質が決定を正しく表しているか、問いが模型から正しく導かれているかを反証する。模型は書き換えない。
入力の正本: 実装 R/plugins/workflow/workflows/prd-spec.js・R/plugins/workflow/skills/prd-spec/SKILL.md・references/workflow-io.md、継ぎ目の閉集合 R/.work/prd-spec-abnormal/reconcile-A/seam.tsv（286 行）、決定 R/.work/prd-spec-abnormal/questions/questions.json・answers.json。
TLC: `java -XX:+UseParallelGC -Djava.io.tmpdir=<出力先>/tmp -cp /Users/yoshi/.local/share/tla/tla2tools.jar tlc2.TLC -metadir <出力先>/states -workers 4 -config X.cfg X.tla`（必要なら model-1 の .tla を出力先へ写して回す）。
出力先は R/.work/prd-spec-abnormal/model-1-verify/ のみ。.md の報告ファイルは書かない。書き込みが拒否されたら迂回せず報告して止まる。git 操作をしない。prd-spec・formal-methods スキル・Workflow は使わない。

## やること
1. 実装 → 模型: seam.tsv の全 286 行（コメント行を除く異常系の行）を、模型の action か「模型の外（理由）」のどれかに対応づける。対応の無い異常系の行は欠け。fwd.tsv（列: seam_line	snippet	model_action	verdict	note）。verdict は mapped / outside-ok / missing。
2. 模型 → 実装: trace.tsv の全 action について impl_ref の行を読み、模型の guard と遷移先が実装の振る舞いと一致するか（決定で変えた action は、決定どおりか）。rev.tsv（列: action	verdict	reason	evidence_ref	evidence_quote）。verdict は faithful / too-loose（実装にない遷移を許す）/ too-strong（実装にある遷移を禁じる・足した制約）/ wrong。
3. 性質: 各 INVARIANT・PROPERTY の式が、対応する決定（answers の選んだ選択肢の description）を過不足なく表すか。props.tsv（列: property	decision	verdict	reason）。
4. 再検査: base.cfg と impl.cfg を自分で回し、results.tsv の状態数と結果に一致するか確かめる。変異 17 本から seed 4242 で 5 本を選び（python3 -c "import random;print(random.Random(4242).sample(sorted(<変異の名前の list>),5))"）、検出されるか回す。rerun.tsv。
5. 問い: questions.tsv の 15 件について、(a) problem が模型・実装から本当に生じるか、(b) 決定から一意に導けて問いにする必要が無いものが混ざっていないか、(c) 選択肢と TLC の結果が正しいか、を確かめる。さらに要求と仕様の切り分け（R/plugins/workflow/skills/prd-spec/references/prd-and-spec.md §3〜§7）に照らし、各問いが目的（要求文書）の決定か手段（仕様書）の決定かを付ける。qcheck.tsv（列: qid	verdict	layer	reason）。verdict は holds / derivable:<根拠> / wrong。
最終報告は短く日本語で: 各表の verdict の内訳、missing・too-loose・too-strong・wrong の行、問いの検証結果。
