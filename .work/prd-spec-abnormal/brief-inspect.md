# 軽い検査の brief（役ごとの節。起動文で役・対象・出力先・seed を指定する）

R=/Users/yoshi/github/yoshiysh/claude-plugins/.claude/worktrees/skill-update-generic-design-720616
考え方は formal-methods の要求（R/docs/requirements/formal-methods.md の PR-FORMALMETHODS-051〜061・073・239・074・075）から借りる。formal-methods スキル・prd-spec スキル・Workflow は使わない。文書は書き換えない。
書き込みは起動文で指定する出力先のディレクトリだけ。.md の報告ファイルは書かない（hook が拒否する）。書き込みが hook や権限で拒否されたら迂回せず、内容を最終報告に書いて止まる。git 操作をしない。最終報告は短く日本語で。

## 対象の閉集合
起動文の items.tsv（script が `####` の PR-/SP- 項目ごとに本文と行範囲を出したもの）。項目の外（用語の表・トレーサビリティ表・前文）は、項目が参照するときだけ読む。項目の外にある規範文を見つけたら、その行を「閉集合の外」として記録する。

## 役 X（抽出役。X1・X2 が独立に同じ仕事をする）
items.tsv の全項目について、規範文ごとに組を作り tuples.tsv に書く。列:
item	tid	line	subject	condition	modality	action	object	quote
- tid は <item>#<連番>。line はその規範文の行（ファイルの実際の行番号）。
- subject・condition・action・object は quote の中の語をそのまま使い、言い換えない（無ければ -）。modality は must / must-not / may / should のいずれか。
- quote は規範文の逐語（改行は空白に置換）。空白を除いて原文の部分文字列になること。
- 1 項目に規範文が無ければ tid=<item>#0 で 1 行書き、action に「規範文なし」と書く。

## 役 C（照合役）
入力: X1・X2 の tuples.tsv、items.tsv、対象文書と上流（起動文で指定）。
1. X1 と X2 が食い違う組（片方にしか無い・要素が違う）を、原文を読んで決め、tuples-final.tsv（X の列 + 列 decided_by: agree / X1 / X2 / C）にする。決められない食い違いは欠けとして返す（type=extraction）。
2. 全ての組を次の 12 型の全てに照らす（選んで照らさない）。
   - 組ごと: out-of-scope / no-repair-path / edge-case / term-drift / inferred-concept / unrealizable / table-gap / identity / missing-subject / missing-location（定義は formal-methods.md の PR-FORMALMETHODS-061 の表）
   - 単位を切った後: coverage-gap / missing-external-contract（PR-FORMALMETHODS-073）。単位は状態の対象ごと（書き手が 1 つの実体を 1 単位、書き手が複数なら継ぎ目）。停止・再開・拒否の種類は、対象文書と上流が閉集合として定める分だけを使い、定めていない種類は照らさず「対象外」と記録する（PR-FORMALMETHODS-239）。
   - 加えて、組の主体・対象が用語の表か本文の初出定義に結びつかない語（unbound-term）も返す。
3. 欠けを defects.tsv に書く。列: did	type	severity	tids	file:line	quote	why	fix_hint
   - severity: 高=止まる行・結論が決まらない／規範が同時に満たせない、中=推測が要り run ごとに振る舞いが変わる、低=文言だけ
   - quote は逐語。fix_hint は直す方向を 1 文（文面は書かない）。
4. 照らした結果の網羅を coverage.tsv に書く: 単位ごとの行（unit	writers	states	kinds_checked	kinds_out_of_scope）。

## 役 V（反証役。fresh）
入力: C の defects.tsv・tuples-final.tsv・coverage.tsv、対象文書と上流、起動文で指定する sample の項目 ID の列（seed 固定で script が選んだもの）。
1. defects.tsv の全行を原文で確かめ、verdicts.tsv（did	verdict	new_severity	reason	evidence_ref	evidence_quote）に書く。verdict は holds / refuted / resev。refuted には反証の file:line と逐語。
2. sample の各項目を、C の結果を見ずに自分で 12 型（+ unbound-term）に照らし、欠けを独自に挙げる。C の defects に同じ欠けがあれば covered:<did>、無ければ missed として missed.tsv（defects.tsv と同じ列、did は M-001…）に書く。sample-judgement.tsv（item	judgement	note）に項目ごとの結果を書く。
3. 最終報告に: verdict の内訳、高・中の成立件数、missed の件数と見落とし率（missed / (covered + missed)、欠けが 0 件の項目は母数に入れない）。
