# AGENTS.md 改稿（PR #207）の設計役の brief（作り直し）

R=/Users/yoshi/github/yoshiysh/claude-plugins/.claude/worktrees/skill-update-generic-design-720616
#207 の作業ツリー: /private/tmp/claude-501/-Users-yoshi-github-yoshiysh-claude-plugins--claude-worktrees-skill-update-generic-design-720616/f6b90e1a-11d7-4c39-9c96-2124180c0d5e/scratchpad/agents-wt（今の版は手順を列挙した 36 行を足したもの。参考に見るだけで、土台にしない。土台は main の AGENTS.md）
あなたは設計役。AGENTS.md は書き換えない。出力は R/.work/agents-md/design-v2/ だけ。.md は書かない。書き込みが拒否されたら迂回せず報告して止まる。git 操作をしない。

## 利用者が決めたこと（変えない）
1. 作業の流れを「設計 → 設計レビュー → 実装 → 実装レビュー」に徹底させる。検証で欠陥が出たら、指摘を直接直さず設計に戻ってから実装する。
2. 設計と設計レビューは「解決は常に根本原因の除去を目指す」を規範とすることを明記する。
3. 形式検証をルールにする。範囲は要求・仕様・実装の全て。
4. AGENTS.md には規範と理由だけを置く。手順は書かない。既存の規範と同じことを書き直さず参照する。
Q1. 修正ループを持つスキル（repo-implement など）の改修は、直後の別 PR。#207 は AGENTS.md の規範だけ。
Q2. 形式検証の手順は、今の formal-methods スキル（.agents/skills/formal-methods/SKILL.md）を参照して先に入れる。
Q3. 形式検証をどの作業段階で誰が走らせるかを、AGENTS.md に 1 文置く。
Q4. 語の揃えは AGENTS.md の 1 行（236 行の「設計レビュー」）だけ。quick_validate.py・evals.json の語は直後の別 PR。

## 設計の規範
- 解決は常に根本原因の除去を目指す。
- 条項は足すより消す。AGENTS.md に置く条項は、それぞれ「無いと何が壊れるか」を 1 つ挙げられるものだけにする。挙げられない条項は置かない。
- 場面ごとの扱いを条項で閉じない。新しい場面には、規範に添えた理由（守られないと何が壊れるか）で読み手に適用させる（AGENTS.md の既存の規則「規範・ルール・スキル指示は…『守られないと何が壊れるか』を添えて書く」による）。
- 4 つの作業の呼び名は「作業段階」とする（リポジトリ全体で他の意味に使われていないことは確認済み。「段」「工程」は既存の別の意味がある）。
- 入り直しの引き金は「欠陥がどの作業段階の成果物にあるか」の軸で決めることを検討する（「誰が見つけたか」の軸は、生成者が走らせる形式検証が設計の欠陥を出したときに割れた）。この軸で 1 文にまとまるかを確かめ、まとまらなければ理由を書く。

## 過去の設計の往復で特定された根本原因（再び作らない）
- 手順を AGENTS.md に列挙すると、正本の二重化・既存のレビュー経路との衝突・利用者が決めていない義務が生じる。
- 検証の手段を 2 箇所で列挙すると食い違う（列挙は既存の「検証は決定的テスト + … が持つ」の 1 箇所）。
- AGENTS.md が重大度の尺度を名指すと、REVIEW.md と formal-methods の要求文書の尺度が 2 つ並ぶ。名指さない。
- 防御の注意書き（「〜の語を使わない」「〜しない」型）を AGENTS.md に入れる。
- AGENTS.md に写すものと設計の根拠を同じ列に混ぜる。
- 実測の数値を一次の記録を開かずに写す。実測の主語を広げる。
- 参照を行番号で書く（見出しか引用句で書く）。
- 語の衝突を確かめる範囲を狭くとる。

## 実測（理由に使う。数値は一次記録で確かめる）
- 設計を経ない改稿で、requester.md の要求項目が 33 から 70 に増えた（改稿したのは builder 役。R/docs/requirements/requester.md の main 版と R/.work/prd-spec-abnormal/draft-req-rejected/requester.md の見出しの数）。
- 文ごとの軽い検査の抜き取り（15 項目）で、反証役が項目ごとに挙げた欠け 21 件のうち 6 件（約 29%）を見落とした（R/.work/prd-spec-abnormal/insp-req-1/V/）。TLA+ で全状態を探索して初めて決定どうしの衝突と実装の欠陥が出た（R/.work/prd-spec-abnormal/model-1/questions.tsv）。
- 指摘を 1 件ずつ足す模型の修正が、新しい欠陥を 3 件持ち込んだ（R/.work/prd-spec-abnormal/model-2-verify/rev2.tsv の faithful でない 3 行）。
- この AGENTS.md 改稿の設計自体も、指摘を 1 件ずつ塞ぐ往復を 7 回続け、直近 4 回の中の指摘のうち 3 件は直前の修正が持ち込んだ（R/.work/agents-md/design-review-{4..7}/verdicts.tsv）。

## 設計レビューで見る観点（固定。回ごとに足さない）
(a) 決定 1〜4・Q1〜Q4 を過不足なく満たすか (b) 上の根本原因を再び作っていないか (c) 既存の規範と矛盾・重複しないか (d) 次の場面に、規範と理由から一意に適用できるか: 書く途中の自己検査の失敗／typo の修正／文書だけの変更／hook が走らせる make test／実装の作業段階の形式検証が設計の欠陥を出したとき

## 出力
- design.tsv（列: item	agents_norm	agents_reason	placement	design_rationale）。agents_norm（AGENTS.md に入る規範の文の要旨）と agents_reason（AGENTS.md に入る理由の文の要旨: 守られないと何が壊れるか）の 2 列だけが AGENTS.md に入る。placement は置く位置と既存行の修正、design_rationale は設計の根拠（AGENTS.md に入らない）。置かないものは agents_norm・agents_reason を - にした行で理由を書く。行は少ないほどよい。
- scenarios.tsv（列: scenario	applies	outcome）: 観点 (d) の 5 場面それぞれに、どの規範と理由がどう当たるか。
- later.tsv（列: item	where	what）: 直後の別 PR に残すもの（Q1・Q2・Q4 による）。#207 の PR 本文に載せる材料。
最終報告は短く日本語で。
