# AGENTS.md 改稿（#207）の設計役の brief

対象: PR #207（ブランチ docs/agents-design-flow-formal）。作業ツリーは /private/tmp/claude-501/-Users-yoshi-github-yoshiysh-claude-plugins--claude-worktrees-skill-update-generic-design-720616/f6b90e1a-11d7-4c39-9c96-2124180c0d5e/scratchpad/agents-wt（AGENTS.md は 36 行を足した版）。main の AGENTS.md と比べるには `git -C /private/tmp/claude-501/-Users-yoshi-github-yoshiysh-claude-plugins--claude-worktrees-skill-update-generic-design-720616/f6b90e1a-11d7-4c39-9c96-2124180c0d5e/scratchpad/agents-wt diff origin/main -- AGENTS.md`。
あなたは設計役。AGENTS.md は書き換えない。設計を R/.work/agents-md/design-1/design.tsv と changes-plan.tsv に書く（R=/Users/yoshi/github/yoshiysh/claude-plugins/.claude/worktrees/skill-update-generic-design-720616）。.md の報告ファイルは書かない。書き込みが拒否されたら迂回せず報告して止まる。git 操作をしない。

## 利用者が決めたこと（変えない）
1. 作業の流れを「設計 → 設計レビュー → 実装 → 実装レビュー」に徹底させる。検証で欠陥が出たら、指摘を直接直さず設計に戻ってから実装する。
2. 設計と設計レビューは「解決は常に根本原因の除去を目指す」を規範とすることを明記する。
3. 形式検証をルールにする。範囲は要求・仕様・実装の全て。
4. AGENTS.md には規範と理由だけを置く。手順（変異・両方向の照合・模型の置き場・道具の版・状態を持たない対象の扱い・判定の限定など）は書かない。既存の規範（特に「解決は常に根本原因の除去を目指す」）と同じことを書き直さず参照する。

## 入力
- 今の #207 の差分（上のコマンド）と main の AGENTS.md の全文（作業ルール節は全文読む）
- fresh な検証役の指摘 12 件: R/.work/agents-md/review-1/summary.relay.txt（要点）。全文が要る指摘は次: [高] 道具の正本の二重 / [中] 要求・仕様が流れのどの段か読み手で割れる / [中] 差し戻しの経路に設計レビューが無い / [中] 「高・中の判定は模型で」が既存の diff-verifier・REVIEW.md の重大度判定と衝突 / [中] 小さな変更（typo・文書だけ）に流れと形式検証を掛けるか / [中] 状態を持たない対象を誰が判定するか / [中] 利用者が決めていない義務 / [低] 実測の主語（33 は requester だけ）/ [低] 既存規範との重複（見ていないものの宣言、手段でスコープ）/ [低] 236 行の「設計レビュー」が別の意味 / [低] 98-100 行の検証の構成に形式検証が無い / [低] 置き場の規則が既存配置と合わない
- 実測の理由の材料（各 1 文に圧縮する）: requester の要求が設計を経ない改稿で 2 往復のうちに 33 項目から約 70 項目に膨らみ、足した項目の大半は手段だった / 文ごとの軽い検査の抜き取りの見落とし率は約 29%（標本 15 項目）で、TLA+ で全状態を探索して初めて決定どうしの衝突と実装の欠陥が出た / 指摘を 1 件ずつ足す模型の修正が新しい欠陥を 3 件持ち込んだ

## 設計の規範
解決は常に根本原因の除去を目指す。指摘 1 件ごとに文を足して塞がない。指摘のそれぞれについて、それを生んだ原因（例: 手順を AGENTS.md に列挙したこと）を特定し、原因を除けば消える指摘はまとめて扱う。

## 出力
- design.tsv（列: item	decision	rationale）: AGENTS.md に置く規範の一覧（項目ごとに、規範の要旨・置く位置・参照する既存の規範・理由に使う実測）。置かないものとその理由も行にする。
- changes-plan.tsv（列: finding	root_cause	resolution	how）: 指摘 12 件の全件について、根本原因と、どう解くか（原因の除去で消える / 規範の文で解く / 対象外 + 理由）。
- 利用者に決めてもらう必要がある点があれば questions.tsv（列: q	options	recommend）。決定 1〜4 から導けるものは問いにしない。
最終報告は短く日本語で。
