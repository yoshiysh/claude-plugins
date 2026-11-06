# 要求の切り分けの brief

R=/Users/yoshi/github/yoshiysh/claude-plugins/.claude/worktrees/skill-update-generic-design-720616
目的: prd-spec 自身の要求文書（R/docs/requirements/requester.md・consumer.md、main の版）の全項目を、要求文書に置くべき「目的」と、仕様書へ移すべき「手段」に切り分ける。要求文書は関係者の認識を一致させる文書であり、分量は認識の差だけで決まる（網羅性では決まらない）。
基準の正本: R/plugins/workflow/skills/prd-spec/references/prd-and-spec.md の §3（軸 B: 要求 = 目的、仕様 = 手段）・§4（目的側に書くもの、やらないことへ回す判定）・§5（手段側に書くもの、1 項目の単位、項目を残すかの判定）・§7（目的の定義が分量を決める）。最初に全文読む。
prd-spec スキル・Workflow は使わない。文書は書き換えない。出力先は起動文で指定するディレクトリだけ。.md の報告ファイルは書かない（hook が拒否する）。書き込みが hook や権限で拒否されたら迂回せず、最終報告に書いて止まる。git 操作をしない。最終報告は短く日本語で。

## 役 K（切り分け役）
入力: classify-1/items.tsv（全項目の閉集合と行範囲）、両文書の本文（前文・用語・背景・スコープ・トレーサビリティ表も読む）、仕様 4 本（R/docs/specifications/flow.md・verification.md・elicitation.md・authoring.md）、利用者の 12 の決定（R/.work/prd-spec-abnormal/questions/questions.json・answers.json）。
1. 各項目を次のいずれかに分ける。
   - purpose: 何のために・誰のために・どんな状況で・やらないこと・前提と依存のいずれか。消すと関係者の認識が割れる。
   - means: 実現の仕方（手順・状態・回数・判定の規則・入出力の形）。仕様書に置けば足りる。
   - mixed: 目的の部分と手段の部分が 1 項目に混ざる。目的の部分の逐語と手段の部分の逐語を分けて示す。
   - drop: 合意済みで認識の差が無い・他の項目と重複・他の項目から導かれる（§4 の「その要求が無くても価値は成立するか」と §5 の Necessary の両方を当てる）。
2. means と mixed の手段の部分には、移し先の仕様書と、そこに既に同じ規定があるか（あれば SP-ID と file:line）を書く。
3. 12 の決定のそれぞれについて、要求文書に目的として現れるべき部分があるか（あればその 1 文の要旨）、仕様だけの決定かを分ける。
4. 切り分けた後の要求文書が持つべき目的の集合を、項目 ID の束（既存の purpose と mixed の目的部分、決定から足す目的）として示す。新しい文面は書かない（書くのは builder）。
出力:
- classes.tsv（列: item	class	purpose_quote	means_quote	dest_spec	existing_sp	reason）。quote は逐語（空白を除いて原文の部分文字列）、無ければ -。
- decisions.tsv（列: q	in_requirements	purpose_gist	spec_only_reason）
- purpose-set.tsv（列: group	items	gist）

## 役 W（反証役。fresh）
入力: 役 K の classes.tsv・decisions.tsv・purpose-set.tsv と、役 K と同じ原文・基準。
1. classes.tsv の全行について、基準の正本に照らして分け方を反証する。verdicts.tsv（列: item	verdict	new_class	reason	evidence_ref	evidence_quote）。verdict は holds / reclass。
2. 特に、purpose とされた項目が手段を含まないか、drop とされた項目を消すと認識が割れる関係者がいないか、を確かめる。
3. purpose-set.tsv が、要求文書の目的側に必須の 5 項目（§4 の表）を覆っているか確かめ、欠けを gaps.tsv（列: item	gap	reason）に書く。
4. 最終報告に、verdict の内訳と reclass の向きの内訳（purpose→means など）、切り分け後の項目数の見込みを書く。
