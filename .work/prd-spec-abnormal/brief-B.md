# 照合役 B の個別 brief
担当文書: verification.md・elicitation.md・authoring.md（と各 .tbd.json）。出力先: R/.work/prd-spec-abnormal/reconcile-B/ のみ。id は B-001 から。
- doc_check.mjs の check-fail・fail-open・limit・state-check の行が、担当文書のどの規定に対応するかを照らす。対応が無い停止・無言で対象外になる経路は (a)。
- elicitation の状態×イベント表は全セルを確かめ、未定義のセルを数えて列挙する（cells.tsv: state	event	cell_text	defined_by）。
- 担当文書から flow.md・requester.md・consumer.md へ渡す・受ける項目（検査不能、残った指摘、問いの回答の検査落ちなど）は、受け手側の文書に対応項目があるかまで確かめる（受け手の文書は読むだけで、その文書内部の欠陥は A の担当）。
