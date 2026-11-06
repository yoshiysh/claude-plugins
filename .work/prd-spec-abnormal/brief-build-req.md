# builder（要求文書）の brief

R=/Users/yoshi/github/yoshiysh/claude-plugins/.claude/worktrees/skill-update-generic-design-720616
あなたは要求文書の書き手（builder）。prd-spec スキル自身の要求文書 2 本を、準正常系・異常系の照合結果と利用者の回答に従って書き直す。
prd-spec スキル・Workflow は使わない（不具合を抱えた道具で自分を直さないため）。doc_check.mjs を決定的な検査として実行するのは可。

## 書いてよいファイル（これ以外は書かない）
- R/docs/requirements/requester.md・requester.tbd.json・consumer.md・consumer.tbd.json
- R/docs/requirements/INDEX.md は導出物。doc_check に INDEX を導出する手段があれば使い、無ければ触らず changes.tsv にそう書く。
- 作業記録: R/.work/prd-spec-abnormal/<起動文で指定する出力先>/ に changes.tsv（列: finding_id	file:line	what	why）と open.tsv（直さなかった・直せなかった行と理由）。.md の報告ファイルは書かない（hook が拒否する）。

## 入力（R/.work/prd-spec-abnormal/）
- reconcile-A/findings.tsv・reconcile-B/findings.tsv・verify-B/missed.tsv（照合結果。形は schema.md）
- verify-A/verdicts.tsv・verify-B/verdicts.tsv（検証役の判定。A-019 は A-014 に併合、B-006 は中）
- questions/questions.json（問いと mapping）と questions/answers.json（利用者の回答。12 問すべて推奨を選択）
- 起動文で指定する「前回の検査結果」があれば、それを直す。

## やること
1. 全行から、直し先が要求文書 2 本にあるもの（要求の追加・削除・改訂、要求間の矛盾、要求 ID の未定義の解消、仕様が参照する要求の新設）を選ぶ。直し先が仕様書や実装だけにある行は触らず open.tsv に「仕様段で扱う」と書く。
2. 回答（answers.json と、選ばれた選択肢の description）と derived の正本に従って直す。回答に無い価値の判断を自分で決めない。必要なら open.tsv に「未決」として書く（推測で埋めない）。
3. 要求文書は「関係者の認識が一致する状態」まで詰める文書で、仕様の値（定数・状態名）は書かない。Q3 の回答（実装の定数を正本にし文書は値を書き写さない）は、要求側では値に触れない形で反映する。
4. 文書の既存の作法（助動詞規約・ID・トレーサビリティ表・TBD の sidecar）と R/docs/guidelines/documentation.md に従う。要求 ID を消す・番号を変えるときは、6 文書と INDEX から参照されている箇所を grep し、仕様書側の参照が切れる場合は open.tsv に書く（仕様書は次の段で直す）。
5. 書き終えたら doc_check の要求文書向けの検査（workflow-io.md §6 にある CLI。lint など）をかけ、結果を changes.tsv の末尾の行か open.tsv に載せる。自分の成果物に合格判定は出さない（検査は別の役が行う）。

## 禁止
- 書き込みが hook や権限で拒否されたら、迂回しない（別の場所・別の手段で書かない）。拒否された内容を最終報告に書いて止まる。
- git 操作をしない。
- 最終報告は短く日本語で: 直した行の件数、open の件数、検査コマンドと結果。
