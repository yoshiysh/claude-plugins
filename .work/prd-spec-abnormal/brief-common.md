# 照合役の共通 brief（A・B 共通）

リポジトリ: /Users/yoshi/github/yoshiysh/claude-plugins/.claude/worktrees/skill-update-generic-design-720616（以下 R）。
目的: prd-spec スキル自身の要求文書・仕様書の準正常系・異常系（blocked の条件、止まる・保留・失敗・やり直し・上限・無応答・回答の検査落ち など）を、実装と照らして欠陥を洗い出す。あなたは照合役で、文書も実装も書き換えない。

## 材料（R/.work/prd-spec-abnormal/）
- inventory/impl-workflow.tsv（prd-spec.js・SKILL.md・workflow-io.md の異常系の棚卸し 295 行）と .coverage.md
- inventory/impl-doccheck.tsv（doc_check.mjs の 358 行）と .coverage.md
- inventory/docs.tsv（6 文書の 197 行）と docs.coverage.md
- 棚卸しは別の役が作った材料で、誤り・取りこぼしがありうる。結論の根拠には必ず原文の該当行を自分で読み直す。
- 棚卸しが「読んでいない」とした範囲は、原文で確かめる場所: docs 側は INDEX（R/docs/requirements/INDEX.md・R/docs/specifications/INDEX.md）・SKILL.md・workflow-io.md を読んでいない。doc_check 側は prd-spec.js・agents/・schemas を読んでいない（blocking・exit code・FIXERS_BY_CODE を受ける側が未確認）。
- 「未定義」「無い」と判定するときは、6 文書と INDEX の両方に別の定義が無いことを grep で確かめ、使った検索語を rationale に書く。
- hypotheses.md は依頼元が挙げた未検証の仮説。確かめるか反証する。成立しないなら findings に入れず、notes.md に「不成立: 理由」と書く。

## 原文
- 文書: R/docs/requirements/requester.md・consumer.md（+ .tbd.json）、R/docs/specifications/flow.md・verification.md・elicitation.md・authoring.md（+ .tbd.json）
- 実装: R/plugins/workflow/workflows/prd-spec.js、R/plugins/workflow/skills/prd-spec/scripts/doc_check.mjs、R/plugins/workflow/skills/prd-spec/SKILL.md、R/plugins/workflow/skills/prd-spec/references/workflow-io.md（必要なら同 skill の agents/・schemas/ も）

## 出力
- 形は schema.md に従う。出力先はあなた専用のディレクトリ（下の個別 brief）だけ。他の場所へは書かない。
- findings.tsv（schema.md の形）、notes.md（仮説の成否、見なかった範囲、判断に迷った候補）。
- 引用は逐語。空白を除いた文字列で原文と機械照合する。照合に落ちた行は無効になる。
- 重複を作らない。同じ欠陥が文書・実装の複数箇所に出るなら 1 行にまとめ、ref を ; で並べる。
- decision は「利用者が決める価値の選択（例: 無応答のとき止めるか既定値で進むか）」と「正本から一意に決まる修正」を分ける。迷ったら user にして理由を書く。

## 禁止
- Write・Bash の書き込みが hook や権限で拒否されたら、別の場所へ書く・別の手段で書くなどで迂回しない。拒否された内容をそのまま最終報告に書いて止まる。
- prd-spec スキル・Workflow を使わない。git の commit・push をしない（司令塔がする）。
- 最終報告は短く: 件数（class×severity）、出力ファイルのパス、見なかった範囲。
