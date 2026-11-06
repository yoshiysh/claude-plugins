import os,sys
R='/Users/yoshi/github/yoshiysh/claude-plugins/.claude/worktrees/skill-update-generic-design-720616'
V='.work/agents-md/design-v5-review/views/'
P='.work/agents-md/design-v3/purpose.txt'
A='.work/agents-md/design-review-1/answers.txt'
rows=[
("変更全体","ok","-","無変更では AGENTS.md が 235 行のまま流れの規範も無く、目的の達成することを満たさない。削除だけ（AGENTS.md を縮めるだけ）では「流れを規範にする」「観点を agent として定義する」が満たせない。既存の仕組みの再利用（repo-implement を作り手、repo-review・diff-verifier・claim-gate・make test を検証）は設計が既に取り込んでいる",P,"AGENTS.md を約 100 行の地図にする"),
("files.tsv: AGENTS.md（全体）","ok","-","目的が約 100 行を求め、main は 235 行。縮める以外の案は無い。72 行は目的の範囲内",V+"files.decisions.tsv","235 行を約 72 行にする"),
("files.tsv: AGENTS.md 節「作業ルール」","ok","-","抜粋 A・B・C は D1〜D3・V5 が AGENTS.md に置くと決めたもの。残りの (1)〜(15) は main の規則の移し替えと短縮で、新しい規則を足していない（main-lines.tsv で main の行ごとの行き先が閉じている）",V+"main-lines.decisions.tsv","AGENTS.md「作業ルール」（L85-94 と 1 つの箇条に）"),
("files.tsv: AGENTS.md 節「規範の置き場」","ok","-","既存の docs/guidelines/README.md の表は guidelines の 3 文書だけを指し、スキル・workflow・REVIEW.md への地図は無い。目的の「地図」を満たすには新しい節が要る","docs/guidelines/README.md","| [文書](documentation.md) | 簡潔さ、正本、理由、変更経緯 |"),
("files.tsv: docs/guidelines/workflow.md","ok","-","docs/guidelines/ の既存の文書（README・documentation・javascript・testing の 4 つ。ls で全列挙）に作業の流れを扱うものは無く、既存の文書へ足すと対象が混ざる。目的が流れの規範と docs 側の正本を求める","docs/guidelines/README.md","| [テスト](testing.md) | ケース設計、仕様との対応、実行結果、コードカバレッジ |"),
("files.tsv: docs/guidelines/workflow.md (3) 設計の体裁","ng","低","置き場に scenes.md を常に置くとしているが、読むのは reader だけで、reader は指示を変えるときだけ立ち、無ければ無いと宣言して本文から場面を挙げる入力の形になっている。reader を立てる変更でだけ scenes.md を作る、より小さい案で同じ目的が満たせる（読み手の推測は要らないが、要らない成果物を毎回作らせる）",V+"agents.decisions.tsv","scenes.md（無ければ無いことを宣言して本文から場面を挙げる）"),
("files.tsv: docs/guidelines/review-lenses.md","ok","-","既存の REVIEW.md は PR のレビュー用で段（設計・実装）の対応を持たず、plugins/workflow/skills/pr-review/references/review-lenses.md は 1 つのスキルの中の観点の列で段も担い手も持たない。目的の「どの段でどの観点を当てるかを 1 か所に置く」を既存の文書の再利用では満たせない","REVIEW.md","PR をレビューする AI 向けの指示"),
("files.tsv: docs/guidelines/placement.md","ok","-","目的が置き場の基準を正本の 1 つとして置くことを明示している。既存の documentation.md は簡潔さ・正本・理由を扱い、AGENTS.md と文書の間の置き分けの問いを持たない",P,"何を AGENTS.md に置くかの基準も、それ自体を正本の 1 つとして置く"),
("agents.tsv: purpose-auditor・alternatives-auditor・placement-auditor・decision-verifier","ok","-","既存の再利用の案として、diff-verifier に「追加の観点」を渡す案と repo-review の reviewer.md（観点を引数に取る reviewer）を比べた。どちらも REVIEW.md を基準に読み、観点ごとに読まない入力（reasons.md）を外せず、目的・決定を照らす正本にできない。目的が観点を agent として定義することを求めるので、新しい定義が要る",".claude/agents/diff-verifier.md","追加の観点（例: 「この指摘の根本原因が直ったか」）も同じ基準で見る。"),
("agents.tsv: risk-auditor","ok","-","費用対効果は alternatives-auditor の「より小さい案で満たせるか」と近いが、後者は案どうしの比較、前者は提案そのものの費用と達成することの比較と fail-open の経路で、既存の観点（REVIEW.md の観点の列）にも無い。統合すると 1 体の問いが 2 つになり、review-lenses.md の条件（agent・段・ファイルを足す決定）も別なので、分けたままでよい","REVIEW.md","**根本解決と対症療法**"),
("agents.tsv: reader","ok","-","既存の review-document の平易さの軸は文単位の読みやすさで、場面ごとに読み手が取る行動と複数の解釈を見る観点ではない。checks-for-impl.tsv が reader を使う場面を 4 件持ち、要る","plugins/workflow/skills/review-document/references/rubric.md","予備知識の無い読み手が 1 回読んで意味を取れるかを見る観点。"),
("agents.tsv: severity-assigner","ok","-","既存の diff-verifier と repo-review の reviewer も重大度を出すが、利用者が専用の agent を 1 体置くと決めた（Y2）。より小さい案（指摘した agent の重大度をそのまま使う）は決定に反する",A,"重大度を付ける専用の agent を 1 体置く"),
("agents.tsv: diff-verifier（既存。定義は変えない）","ok","-","既存の agent を定義を変えずに再利用しており、これより小さい変更は無い（V3）",V+"agents.decisions.tsv","diff-verifier（既存。定義は変えない）"),
("canon-inventory.tsv: claim-gate の claim-judge","ok","-","不在・網羅の断定の検査に新しい agent（claim-checker）を作らず、既存の REVIEW.md の観点と diff-verifier で受ける。既存の仕組みの再利用になっている",V+"canon-inventory.decisions.tsv","claim-checker を作らない"),
("files.tsv: tests/agents-md-excerpts.test.mjs","ok","-","tests/・tools/・scripts/ を「抜粋・excerpt・逐語」で grep した範囲では、文書の写しの一致を照らす汎用の検査は無い（tests/bp-criteria-copy.test.mjs は best-practices の criteria 専用）。写しを無くす案（workflow.md が AGENTS.md を指すだけ）は正本を AGENTS.md 側に移すことになり V5 に反する。写しがある限りテストが要る",A,"正本が docs 側にあって重複しても AGENTS.md に含める"),
("files.tsv: .codex/hooks.json","ng","低","ファイルごと消すと、検査の時機と関係の無い Stop の通知（macOS の通知音）も消える。目的が求めるのは make test の PostToolUse の hook の削除で（検査の時機の問題）、PostToolUse の 1 項目だけを消す、より小さい変更で目的は満たせる。設計自身も通知を個人設定へ逃がすと書いており、消す必要を目的から導いていない。Q8 の「hooks」が通知を含むかは利用者の確認が要る",V+"limits.decisions.tsv","削除は決定の字義どおり。通知が要るなら利用者の個人設定に置く"),
("files.tsv: README.md","ok","-","README.md の「インストール」は Claude Code の 2 行だけで、Codex の登録・依存の手での導入・Worktree のセットアップは無い。AGENTS.md から消すだけでは Codex の利用者の手順が失われるので、移す必要がある","README.md","claude plugin install <plugin>@yoshiysh-claude-plugins"),
("files.tsv: docs/guidelines/testing.md","ok","-","testing.md を quick_validate・SKIP・workflows/・tests/ で grep すると 0 件で、移す先に既存の記述は無い。AGENTS.md から消す内容の受け皿として足す必要がある","docs/guidelines/testing.md","# テスト"),
("files.tsv: REVIEW.md","ok","-","(1)〜(3) は AGENTS.md「注意点」を消すことに伴う参照の付け替えで必須。(8) は今の「重大度」の表が配布・コードの欠陥だけで、設計段の指摘（目的に要らない要素など）を当てる行が無いので、severity-assigner が REVIEW.md を尺度にする限り要る","REVIEW.md","| LOW | 冗長なコメント、誤字、テストの品質、軽微な改善 |"),
("files.tsv: tests/repo-review-workflow.test.mjs","ok","-","REVIEW.md の「読むもの」の表を変えることに伴う期待値の更新で、表を変える限り避けられない",V+"files.decisions.tsv","591〜593 行の期待値を新しい表に合わせる"),
("files.tsv: docs/design/develop-plugin.md","ok","-","消える節（「plugin 間でスキルは共有できない」など）を指す参照の付け替えで、節を消す限り避けられない",V+"files.decisions.tsv","201 行目の「AGENTS.md「plugin 間でスキルは共有できない」」を「AGENTS.md「現在の実体」」に改める"),
("files.tsv: docs/guidelines/README.md","ok","-","文書表がガイドラインの一覧の正本なので、新しい 3 文書を足すなら表への追加は要る",V+"files.decisions.tsv","ガイドラインの一覧の正本はこの表"),
("files.tsv: documentation.md・javascript.md・diff-verifier.md・manage-marketplace-plugin/SKILL.md・traceability.config.json（変更なし）","ok","-","無変更で済むことを確かめた行で、変更を足していない",V+"files.decisions.tsv","modify（変更なし。確認の行）"),
("rules.tsv: 目的の固定（置き場 docs/design/changes/<slug>/）","ok","-","既存の docs/design/ は個別の設計文書の置き場で、変更ごとの目的・設計・レビューの記録の置き場は無い。規模で分ける置き場は利用者の決定（X1）",A,"規模で分ける（typo 級は PR 本文、それ以外は commit。docs/design/ など）"),
("out-of-scope.tsv: cut の行（multi-agent.md・distribution.md・evidence-packer・claim-checker・norm-auditor・documentation.md への追記）","ok","-","新しいファイル・agent を足す案を既存の仕組み（documentation.md:11・REVIEW.md・claim-gate）の再利用に置き換えて削っており、より小さい変更の側に寄せてある",V+"out-of-scope.decisions.tsv","新しい docs/guidelines/multi-agent.md・distribution.md"),
]
def norm(s): return ''.join(s.split())
bad=0
for r in rows:
    src=os.path.join(R,r[4])
    if not norm(r[5]) in norm(open(src,encoding='utf-8').read()):
        print('QUOTE MISS',r[0],r[4]); bad+=1
out=os.path.join(R,'.work/agents-md/design-v5-review/alternatives/findings.tsv')
with open(out,'w',encoding='utf-8') as f:
    f.write('ref\tverdict\tseverity\treason\tevidence_ref\tevidence_quote\n')
    for r in rows: f.write('\t'.join(r)+'\n')
q=os.path.join(R,'.work/agents-md/design-v5-review/alternatives/questions.tsv')
with open(q,'w',encoding='utf-8') as f:
    f.write('q\toptions\trecommend\n')
    f.write('Q8 の「Codex の hooks をいったん削除」は、検査の時機と関係の無い Stop の通知（macOS の通知音）の hook も含むか\t(a) 含む: .codex/hooks.json をファイルごと消す / (b) 含まない: PostToolUse の make test の項目だけを消し、Stop の通知は残す\t(b)。目的が問題にしたのは検査の時機だけで、通知を消す理由が目的から出ない\n')
print('rows',len(rows),'bad',bad)
