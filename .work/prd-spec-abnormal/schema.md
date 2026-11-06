# 照合結果の形（findings.tsv、タブ区切り、1 行目は見出し）
列: id	class	doc_ref	doc_quote	impl_ref	impl_quote	severity	decision	rationale	confidence
- id: A-001 / B-001 …（照合役の記号 + 連番）
- class: a=実装にあり文書に無い停止・保留・失敗条件 / b=文書と実装の食い違い / c=文書内の未定義・矛盾 / d=文書にあり実装に無い
- doc_ref: file:line（複数は ; 区切り）＋ req_id。無い場合は -
- doc_quote: 文書からの逐語引用（改行は空白 1 個に置換。空白を除いた文字列が原文の部分文字列になること。script で機械照合する）。無い場合は -
- impl_ref / impl_quote: 同じ規則で実装側。無い場合は -
- severity: 高=止まる行・結論が決まらない／規範が同時に満たせない、中=推測が要り run ごとに振る舞いが変わる、低=文言だけ
- decision: user:<利用者が選ぶ価値の選択を 1 行> または derived:<正本（どの文書・実装のどこから修正が一意に決まるか）>
- rationale: 1〜3 文
- confidence: high / medium / low
