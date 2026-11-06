# 検証役の brief（A・B 共通。個別の対象は起動文で指定）

リポジトリ: /Users/yoshi/github/yoshiysh/claude-plugins/.claude/worktrees/skill-update-generic-design-720616（以下 R）。
あなたは fresh な検証役。別の照合役が、prd-spec スキル自身の要求文書・仕様書の準正常系・異常系を実装と照らした結果（findings.tsv）を作った。その結果を反証し、見落としを抜き取りで測る。文書・実装・照合結果は書き換えない。

## 照合結果の形
R/.work/prd-spec-abnormal/schema.md を読む（class a〜d、severity 高中低の定義、decision の user/derived）。

## 1. 反証（全行）
各行について、引用先の原文を自分で読み直し（前後の文脈と、6 文書・INDEX の他の箇所に別定義が無いかの grep を含む）、次を返す。
- verdict: holds（成立）/ refuted（不成立）/ reclass（分類違い）/ resev（重大度違い）/ redecide（user と derived の取り違え）/ merge:<id>（他行と重複）
- 該当しない値は書かず、理由を 1〜2 文。refuted には反証の根拠の file:line と逐語引用を付ける。
- 照合役の結論に寄りかからない。「無い」という主張は自分で検索して確かめる（使った検索語を書く）。
出力: verdicts.tsv（列: id	verdict	new_class	new_severity	new_decision	reason	evidence_ref	evidence_quote）。new_* は変える場合だけ、それ以外は -。

## 2. 見落としの抜き取り
起動文で指定された sample.json の各項目（棚卸しの行と、実装の grep 行）について、それが準正常系・異常系として文書に規定されるべきものか、照合結果のどれかの行で扱われているかを判定する。
- 項目ごとに: covered:<findings の id> / doc-ok:<一致する文書の req_id と file:line>（文書と実装が一致していて欠陥でない）/ not-abnormal:<理由> / missed（欠陥なのに照合結果に無い）
- missed は、照合結果と同じ形（schema.md）で新しい行 M-001… として missed.tsv に書く。
出力: sample-judgement.tsv（列: item	judgement	note）、missed.tsv、最後に見落とし率 = missed 件数 / (covered + missed 件数) と、母数の内訳を summary.md に書く。

## 出力・禁止
- 出力先は起動文で指定するあなた専用のディレクトリだけ。引用は逐語（空白を除いて原文と機械照合する）。
- 書き込みが hook や権限で拒否されたら迂回しない。拒否された内容を最終報告に書いて止まる。
- prd-spec スキル・Workflow を使わない。git の commit・push をしない。
- 最終報告は短く: verdict の内訳、missed 件数と見落とし率、出力パス、見なかった範囲。
