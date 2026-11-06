# 照合役 A の個別 brief
担当文書: requester.md・consumer.md・flow.md（と各 .tbd.json）。出力先: R/.work/prd-spec-abnormal/reconcile-A/ のみ。id は A-001 から。

## 継ぎ目（あなたが一手に持つ）
prd-spec.js が doc_check の結果を受ける箇所すべて、および prd-spec.js で blocked・hold・finalHold・error・status を返す／作る箇所すべて。
- まず grep で閉集合を作る: `grep -nE "doc_check|docCheck|blocking|exit|status:|blocked|finalHold|hold\(|error|next_args" R/plugins/workflow/workflows/prd-spec.js` など（使ったパターンをそのまま記録）。
- 結果を seam.tsv（列: line	snippet	disposition）に全件書く。disposition は「findings の id」「文書と一致（根拠 req_id）」「異常系ではない（理由）」のいずれか。これが (a) の網羅の根拠になる。
- 特に error を blocked に変える式が段ごとに何通りあり、それぞれ next_args を持つか持たないかを確かめ、文書（flow.md・workflow-io.md）の規定と照らす。
