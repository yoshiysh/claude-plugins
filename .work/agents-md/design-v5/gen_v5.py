import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent
EXA = "作業の最初に、防ぐ失敗・達成すること・やらないことを書いて目的を固定し、以後の追加はレビューで求められたものも含めて目的に要るかで判定する（固定しないと、指摘のたびに要素が足されて作業が膨らむ）。"
EXB = "変更は規模を問わず「目的の固定 → 設計 → 設計レビュー → 実装 → 実装レビュー」を通し、設計などの文書も実装も生成者と別の fresh なレビューを通す。MEDIUM 以上の指摘・人の指摘・作り手の検査で見つかった欠陥は成果物を直接直さずに設計へ戻し、agent と bot の LOW は直さず PR 本文に載せる（直接直すと、欠陥を生んだ原因が設計に残り、同じ欠陥が形を変えて戻る）。"
EXC = "形式検証は要求・仕様・実装の全てに掛け、その段の生成者が模型を書いて走らせ、状態や決定の衝突が起きえない変更では模型を書かずに理由を 1 行書く（機械で確かめない分岐は、散文の読み違いとして誰にも見つからずに残る）。"
MA = "（正本: docs/guidelines/workflow.md）"
MW = "（抜粋: AGENTS.md）"
PLACE = "置き場（typo 級は draft PR の本文、それ以外は docs/design/changes/<slug>/ に commit し PR 本文がそのパスを指す）"


def w(name, header, rows):
    for r in rows:
        assert len(r) == len(header), (name, r[0], len(r))
        for c in r:
            assert "\t" not in c and "\n" not in c, (name, r[0])
    text = "\t".join(header) + "\n" + "".join("\t".join(r) + "\n" for r in rows)
    (OUT / name).write_text(text, encoding="utf-8")


# ---------------------------------------------------------------- rules.tsv
R = [
    ("目的の固定: 作り手が防ぐ失敗・達成すること・やらないことを書き、その時点で draft PR を作り、規模で置き場を決める。以後の追加はレビューで求められたものも含め目的に要るかで判定する", "docs/guidelines/workflow.md「目的の固定」・AGENTS.md「作業ルール」の抜粋 A", "L2 purpose・FixPurpose・-", "builder", "依頼・利用者の決定", "目的（3 つの欄）・draft PR・置き場の決定", PLACE + "の purpose.md"),
    ("typo 級の定義: 目的 1 行・設計 1 行で書ける変更を typo 級とし、置き場とレビューの体数をこれで決める。作り手の判定は、設計レビューで decision-verifier が当たるかを確かめ、外れていれば指摘として出す", "docs/guidelines/workflow.md「目的の固定」・.claude/agents/decision-verifier.md", "L2 purpose・FixPurpose・-（置き場の分岐） / L11 dreview・Review・-（判定を確かめる）", "builder（判定）・reviewer（decision-verifier が確かめる）", "依頼・目的と設計", "規模の判定と、その確かめの指摘", PLACE + "の purpose.md と reviews/"),
    ("設計の作業: 作り手が決定・理由・利用場面を別のファイルに書き、要るなら模型を書いて走らせ、作業中の検査が通ったら設計レビューへ渡す", "docs/guidelines/workflow.md「段と担い手」「設計の体裁」", "L3 design・Work・chk=idle", "builder", "目的・前の段の振り分けの記録", "decisions.md・reasons.md・scenes.md・模型と結果・規則と遷移の対応表", PLACE),
    ("実装の作業: 作り手（このリポジトリでは repo-implement）が承認済みの設計を実装し、要求・仕様の文書もこの段で書き、作業中の検査が通ったら実装レビューへ渡す", "docs/guidelines/workflow.md「段と担い手」・AGENTS.md「規範の置き場」", "L4 impl・Work・chk=idle", "builder", "承認済みの設計", "差分（commit）・検査の結果", "PR の branch"),
    ("作り手の検査の失敗: 作業中に走らせる検査（make test・その段の形式検証）が落ちたら、作り手はその段の中で原因を分類する", "docs/guidelines/workflow.md「作り手の検査」", "L5 design|impl・SelfCheckFail・chk=idle", "builder", "検査の出力", "失敗の出力", "作り手の作業場所（記録は次の行）"),
    ("分類と記録: 作り手は原因を 欠陥・除ける環境・除けない環境 のどれかに分類し、環境と判じたら分類と理由を置き場に記録する", "docs/guidelines/workflow.md「作り手の検査」", "L6 design|impl・Classify・chk=fail", "builder", "失敗の出力", "分類・環境と判じたときの分類と理由", PLACE + "の records.md"),
    ("欠陥と分類したもの: 重大度を付けずに設計へ戻す（作り手の検査の失敗は直さないと合否ゲートで再び落ちるので、PR 本文に載せる経路を持たない）", "docs/guidelines/workflow.md「作り手の検査」・AGENTS.md 抜粋 B", "L7 design|impl・HandleDefect・cls=defect・真の原因が欠陥 / L8 design|impl・HandleDefect・cls=defect・真の原因が環境（検証役の判定で行き先を striage でなく design にする）", "orch", "作り手の分類", "段の選択（design）", "振り分けの記録（" + PLACE + "）"),
    ("除ける環境と分類したもの: 作り手が原因を除いて同じ検査をその場でやり直し、段を変えない", "docs/guidelines/workflow.md「作り手の検査」", "L9 design|impl・HandleEnvR・cls=envR", "builder", "分類と記録", "同じ検査のやり直しの結果", "records.md（分類と理由は前の行で記録済み）"),
    ("除けない環境と分類したもの: 司令塔が記録した分類と理由を利用者に報告して止まる", "docs/guidelines/workflow.md「作り手の検査」・AGENTS.md「作業ルール」の止まってよい場所", "L10 design|impl・HandleEnvU・cls=envU", "orch", "records.md の分類と理由", "利用者への報告", "会話（報告）と records.md"),
    ("設計レビュー: 作り手と別の fresh な観点の agent が設計を見る。観点と体数は review-lenses.md で規模に比例させて選ぶ。decision-verifier は records.md を読み、誤分類で残った欠陥を作り手の検査の指摘として出す。結果は司令塔が逐語で置き場に保存する", "docs/guidelines/workflow.md「レビューと振り分け」・docs/guidelines/review-lenses.md・AGENTS.md「作業ルール」の検証の行", "L11 dreview・Review・-", "reviewer（review-lenses.md の設計レビューの列の担い手）", "agent 定義の入力の欄のファイル（目的・決定・利用場面・records.md・模型と結果・設計のファイルの差分）", "返り値の「指摘」の節（file:line と何が誤りか）・decision-verifier の「作り手の検査の指摘」の節", PLACE + "の reviews/"),
    ("実装レビュー: 同じく fresh な観点の agent が差分を見る。ready の後に足した差分も diff-verifier がこの段で見る。decision-verifier は records.md を読む", "docs/guidelines/workflow.md「レビューと振り分け」・docs/guidelines/review-lenses.md", "L12 ireview・Review・-（ready の後の差分の担い手を diff-verifier にする）", "reviewer（review-lenses.md の実装レビューの列の担い手）", "差分・テストと形式検証の結果・承認済みの設計・records.md", "返り値の「指摘」の節（file:line と何が誤りか）・decision-verifier の「作り手の検査の指摘」の節", PLACE + "の reviews/"),
    ("重大度: 観点の agent の返り値の「指摘」の節にだけ、専用の severity-assigner が REVIEW.md「重大度」の尺度で重大度を付ける。呼ぶ側はその節の file:line と何が誤りかの欄だけを渡す（節と列を選ぶだけで、どれを指摘にするかを決めない）。振り分けに使う重大度はこの agent の値だけ", "docs/guidelines/workflow.md「レビューと振り分け」・.claude/agents/severity-assigner.md・REVIEW.md「重大度」", "L13 dtriage|itriage|htriage|striage・AssignSev・重大度の無い agent・自己検査・人の指摘がある（検証役の判定で、作り手の検査と人の指摘を guard から外し、agent の指摘だけにする）", "sevagent（severity-assigner）", "観点の agent の返り値の「指摘」の節（file:line と何が誤りか）・REVIEW.md「重大度」", "指摘ごとの重大度と当てた表の行", PLACE + "の reviews/"),
    ("設計レビューの振り分け: MEDIUM 以上の agent の指摘・作り手の検査の指摘・人の指摘が 1 つでもあれば設計へ戻る。無ければ実装へ進む。agent の LOW は直さず PR 本文に載せる", "docs/guidelines/workflow.md「レビューと振り分け」・AGENTS.md 抜粋 B", "L14 dtriage・Triage・bot 以外の全ての指摘に重大度（agent の指摘に重大度）", "orch", "指摘と重大度", "段の選択・PR 本文の LOW の一覧", "PR 本文と振り分けの記録"),
    ("実装レビューの振り分け: 戻る条件は設計レビューと同じ。戻らなければ PR を ready にする（「出す」は ready）。ready の後に戻るときも draft に戻さない", "docs/guidelines/workflow.md「レビューと振り分け」", "L15 itriage・Triage・同上", "orch", "指摘と重大度", "段の選択・PR を ready にする・PR 本文の LOW の一覧", "PR の状態と PR 本文"),
    ("bot のレビュー: ready の PR に bot が付けた重大度をそのまま使う", "docs/guidelines/workflow.md「レビューと振り分け」", "L16 prbot・BotReview・-", "bot", "ready の PR", "重大度つきの指摘", "PR のコメント"),
    ("bot の指摘の振り分け: MEDIUM 以上の bot の指摘があれば設計へ戻る。無ければ人間ゲートへ。LOW は PR 本文に載せる", "docs/guidelines/workflow.md「レビューと振り分け」", "L17 ptriage・Triage・-", "orch", "bot の指摘と重大度", "段の選択・PR 本文の LOW の一覧", "PR 本文と振り分けの記録"),
    ("人の指摘: 人間ゲートで人が指摘する", "docs/guidelines/workflow.md「レビューと振り分け」", "L18 gate・HumanComment・未修正の欠陥がある", "human", "PR（本文の LOW の一覧と範囲と限界を含む）", "指摘", "PR のコメント"),
    ("マージ: 人がマージする。マージが公開に当たる", "AGENTS.md「作業ルール」の登録と止まってよい場所の行", "L19 gate・HumanMerge・-", "human", "PR", "マージ", "main"),
    ("人の指摘の振り分け: 重大度を付けずに、重大度を問わず設計へ戻す", "docs/guidelines/workflow.md「レビューと振り分け」・AGENTS.md 抜粋 B", "L20 htriage・Triage・重大度が付いている（検証役の判定で重大度を待たない）", "orch", "人の指摘", "段の選択（design）", "振り分けの記録"),
    ("（写さない）作り手の検査の指摘を重大度で振り分ける段は置かない。作り手の検査の指摘は欠陥と分類した時点、またはレビューが記録から拾った時点で設計へ戻る", "-", "L21 striage・Triage・重大度が付いている", "-", "-", "-", "-"),
    ("draft の間に来た人・bot の指摘: その段のレビューの後の振り分け（設計レビューか実装レビュー）に加え、同じ規則で扱う", "docs/guidelines/workflow.md「レビューと振り分け」", "L22 design〜gate（draft の間を含む）・HumanComment・BotReview（ready の前）・?（利用者の決定で埋める）", "orch", "PR のコメント", "その段の振り分けに加えた指摘", "振り分けの記録"),
    ("終わり: マージか、除けない失敗の報告で作業が終わる", "AGENTS.md「作業ルール」の止まってよい場所の行", "L23 merged|reported・Done・-", "-", "-", "-", "-"),
    ("止まってよい場所: 途中で止めず、止まってよいのは人間ゲート（マージ）と、作り手が自分では除けない失敗を理由とともに利用者へ報告するときだけ", "AGENTS.md「作業ルール」", "L10 design|impl・HandleEnvU・cls=envU / L19 gate・HumanMerge・- / L23 merged|reported・Done・-", "orch", "段の状態", "止まるか進むかの選択", "振り分けの記録と、止まるときは利用者への報告"),
    ("生成と検証の分離: レビューと重大度は作り手以外が行い、作り手の分類の記録は段のレビューを通る前に作り手以外が読む", "AGENTS.md「作業ルール」", "L11 dreview・Review・- / L12 ireview・Review・- / L13 dtriage|itriage|htriage|striage・AssignSev・重大度の無い agent・自己検査・人の指摘がある（agent の指摘だけ）", "reviewer・sevagent", "成果物と records.md", "指摘と重大度", PLACE + "の reviews/"),
    ("司令塔の役: 司令塔は段を選び、指摘をそのまま relay し、承認後に機械的にコピーするだけで、成果物の生成・修正・採点をしない", "AGENTS.md「作業ルール」", "L7 design|impl・HandleDefect・cls=defect・真の原因が欠陥 / L10 design|impl・HandleEnvU・cls=envU / L14 dtriage・Triage・bot 以外の全ての指摘に重大度 / L15 itriage・Triage・同上 / L17 ptriage・Triage・- / L20 htriage・Triage・重大度が付いている", "orch", "agent と人の返り値", "段の選択・逐語の保存", "振り分けの記録"),
    ("規模に比例させる: 各段の成果物とレビューの体数を変更の規模に比例させ、免除しない。typo 級は目的 1 行・設計 1 行、レビューは各段 1 体", "docs/guidelines/workflow.md「段と担い手」・docs/guidelines/review-lenses.md「体数」", "模型の外: 規模は流れの遷移を変えない（成果物とレビューの大きさだけが変わる）", "builder・orch", "規模の判定", "成果物の大きさ・立てる観点の数", PLACE),
    ("観点の異なる検証: 検証は観点の異なる agent で行い、どの段にどの観点を何体当てるかは review-lenses.md の 1 か所で決める", "AGENTS.md「作業ルール」・docs/guidelines/review-lenses.md", "模型の外: 模型は reviewer を 1 つの担い手に畳む（観点の中身は遷移を変えない）", "orch（観点の選択）", "規模・決定の種類", "立てる agent の一覧", "振り分けの記録"),
    ("設計の体裁: 決定・理由・利用場面を別のファイルに書く（観点の agent に渡す入力を、ファイルの単位で分けて渡すため）", "docs/guidelines/workflow.md「設計の体裁」", "模型の外: 成果物の形で、遷移を変えない", "builder", "目的", "decisions.md・reasons.md・scenes.md", PLACE),
    ("形式検証の契約: 性質ごとに範囲と残りを宣言し、規則と模型の遷移を 1 対 1 で対応させ、模型を書かないときは理由を 1 行書き、忠実さと結果は decision-verifier が見る", "docs/guidelines/workflow.md「形式検証」・AGENTS.md 抜粋 C", "L5 design|impl・SelfCheckFail・chk=idle（形式検証は作り手の検査の中身。遷移は変えない）", "builder（書いて走らせる）・reviewer（decision-verifier）", "模型・検査の出力・規則と遷移の対応表", "宣言つきの結果・レビューの指摘", PLACE),
    ("根本原因の除去: 解決は常に根本原因の除去を目指し、設計と設計レビューもこれを規範にし、レビューは指摘が消えたかでなく原因が除かれたかを見る", "AGENTS.md「作業ルール」", "模型の外: 内容の判定で、遷移を変えない", "builder・reviewer", "指摘と設計", "原因を除いた設計・その判定", PLACE),
    ("PR 本文の範囲と限界: LOW の一覧（REVIEW.md の件数の上限を超えた分は件数）、仮定とリスク、見なかったものを PR 本文に載せ、人がマージの前に読む", "docs/guidelines/workflow.md「範囲と限界」", "L14 dtriage・Triage・bot 以外の全ての指摘に重大度 / L17 ptriage・Triage・-（LOW は PR 本文）。仮定とリスクの記録は模型の外", "builder（範囲と限界を書く）・orch（LOW の一覧を逐語で写す）", "振り分けの記録・模型の仮定", "PR 本文の節", "PR 本文"),
    ("置き場の基準: AGENTS.md と文書に何を置くかは placement.md の問いで決める", "docs/guidelines/placement.md・AGENTS.md 冒頭", "模型の外: 内容の置き場で、流れの遷移でない", "builder・reviewer（placement-auditor）", "内容の単位", "置き場", "placement-auditor の返り値（reviews/）"),
    ("抜粋の一致: AGENTS.md の 3 つの抜粋と workflow.md の文の一致を make test で照らす", "tests/agents-md-excerpts.test.mjs", "模型の外: 文書の写しの照合", "script（make test）", "AGENTS.md・docs/guidelines/workflow.md", "合否", "make test"),
    ("同じ値を 2 箇所に書かない: 写しが要るときは機械で一致を照らす", "AGENTS.md「作業ルール」・REVIEW.md「観点」", "模型の外: 文書の規則", "builder・reviewer（diff-verifier）", "変更", "正本 1 つと参照、または照合のテスト", "変更の差分と make test"),
    ("編集の置き場: .agents/skills/<name>/ から編集し、新規スキルもそこに実体で作り、公開済みの Workflow script だけは plugins/<plugin>/workflows/ を直接編集する", "AGENTS.md「作業ルール」", "模型の外: 既存の規則を残す", "builder", "変更の対象", "編集", ".agents/skills/<name>/ か plugins/<plugin>/workflows/"),
    ("未リリースの Workflow は scriptPath に checkout の絶対パスを渡して起動する", "AGENTS.md「作業ルール」", "模型の外: 既存の規則を残す", "builder・orch", "Workflow script", "起動", "checkout の絶対パスの scriptPath"),
    ("plugins/ 配下に symlink を作らない", "AGENTS.md「作業ルール」", "模型の外: 既存の規則を残す", "builder", "plugins/ への変更", "実体だけの配布サブツリー", "plugins/"),
    ("登録と公開: 登録・更新は manage-marketplace-plugin で PR の中で行い、公開はそのマージ", "AGENTS.md「作業ルール」", "L19 gate・HumanMerge・-（公開をマージに当てる）", "builder（登録）・human（マージ）", "スキル", "catalog と plugin の差分", "PR"),
    ("説明的なコメントを書かない", "AGENTS.md「作業ルール」", "模型の外: 既存の規則を残す", "builder", "コードの変更", "制約・根拠だけのコメント。経緯は commit message・PR 本文", "コードと commit message・PR 本文"),
    ("後方互換性は不要（version bump は対象外）", "AGENTS.md「作業ルール」", "模型の外: 既存の規則を残す", "builder", "形式の変更", "構造の検証で旧データを失敗させるコード", "コード"),
    ("不在・網羅の断定に裏付けを付け、sweep の後に再 grep で残 0 を確かめる", "AGENTS.md「作業ルール」", "模型の外: 既存の規則を残す", "builder・reviewer", "断定と sweep", "裏付けか手段のスコープ・再 grep の結果", "成果物の本文と PR 本文"),
    ("fan-out では agent ごとに model と effort を明示し、抽出を 1 回にして配り、上位 model へは絞った抜粋を渡して見なかったものを宣言する。正本は AGENTS.md のこの行で、Workflow script での書き方は best-practices.md §3・§13", "AGENTS.md「作業ルール」", "模型の外: 費用の規則", "orch", "agent の一覧", "model・effort の指定", "agent の呼び出し（Workflow script では agent() の引数）"),
    ("観点の agent の入力: 設計段は置き場のファイル（作り手が 1 回作る束）をパスで渡し、各体はそのファイルだけを読む", "docs/guidelines/review-lenses.md「入力の渡し方」・.claude/agents/*.md", "L11 dreview・Review・- / L12 ireview・Review・-（入力の形）", "orch（パスを渡す）", "置き場のファイルのパス", "agent への入力", "agent の呼び出し"),
    ("commit を作ったら同じ作業単位で push する", "AGENTS.md「作業ルール」", "模型の外: 既存の規則を残す", "builder", "commit", "push", "remote"),
    (".agents/skills/ の走査は symlink を辿る指定で行う", "AGENTS.md「現在の実体」", "模型の外: 既存の規則を残す", "builder・reviewer", "検索", "symlink を辿った結果", "-（作業中の検索）"),
    ("収録スキル・plugin・公開名は正本から得て、呼び出し名は frontmatter の name から書く", "AGENTS.md「現在の実体」", "模型の外: 既存の規則を残す", "builder", "marketplace.json・ls・frontmatter", "呼び出し名", "成果物の本文"),
    ("別 plugin のスキルは dependencies の宣言とスキル呼び出しで使う", "AGENTS.md「現在の実体」", "模型の外: 既存の規則を残す", "builder", "別 plugin への依存", "dependencies の宣言とスキル呼び出し", ".claude-plugin/plugin.json と SKILL.md"),
    ("テストの置き場: workflows/ に置かず、別 plugin を読むテストはリポジトリ直下の tests/", "docs/guidelines/testing.md", "模型の外: 既存の規則を題材の文書へ移す", "builder", "テスト", "テストのファイル", "scripts/*.test.mjs・tests/・直下の tests/"),
    ("make portability は exit 0 でも BLOCKER 行を人が読む", "AGENTS.md「検証」", "模型の外: 既存の規則を残す", "builder", "make portability の出力", "BLOCKER 行ごとの判断", "PR 本文"),
    ("Codex での検証役の立て方: agent 定義の本文を指示にし、effort だけを spawn で渡す（model は親を継承する）", "docs/guidelines/review-lenses.md", "模型の外: 道具ごとの立て方", "orch", "agent 定義", "spawn", "Codex の subagent の呼び出し"),
]
RULES_H = ["rule", "file", "model_transition", "actor", "input", "output", "place"]
w("rules.tsv", RULES_H, [tuple(r) for r in R])

# ---------------------------------------------------------------- agents.tsv
A = [
    ("purpose-auditor", "目的への必要性", "呼ぶ側はパスだけを渡す: 目的（purpose.md か PR 本文の目的の節）、対象（設計段は decisions.md、実装段は差分）", "reasons.md・過去のレビュー・前回の指摘（設計の前提に引き寄せられ、同じ死角が再生される）", "要素ごとに keep / cut / shrink と、対応する目的の文（path:line）。末尾に「指摘」の節を置き、cut・shrink とした要素を file:line・何が誤りかで並べる（重大度は付けない）", "opus・high（目的と要素の対応は閉集合でなく、読みの深さが要る）", "Read, Grep, Glob"),
    ("alternatives-auditor", "変更自体の必要性", "目的・decisions.md（実装段は差分）・既存の仕組みを探す範囲（scripts/・tools/・Makefile・.claude/agents/・docs/guidelines/・REVIEW.md・plugins/*/skills/・.agents/skills/）。既存の仕組みはこの体が探す", "reasons.md", "無変更・削除・既存の仕組みの再利用・より小さい変更のそれぞれで目的が満たせるかの比較（path:line）と、探した範囲。末尾に「指摘」の節を置き、提案された変更より小さい案で目的が満たせる決定を file:line・何が誤りかで並べる", "opus・high（探索と比較）", "Read, Grep, Glob"),
    ("placement-auditor", "置き場", "対象の内容の単位（decisions.md の決定か差分のパスと行範囲）・docs/guidelines/placement.md。今の置き場はこの体が読む", "reasons.md", "内容の単位ごとに、今の置き場・置くべき置き場・正本か写しか・当てた placement.md の問い（path:line）。末尾に「指摘」の節を置き、置き場が違う単位と写しの単位を file:line・何が誤りかで並べる", "opus・high", "Read, Grep, Glob"),
    ("risk-auditor", "費用対効果・設計段の失敗時の振る舞いの方針", "decisions.md・目的の「達成すること」（比べる相手）。実装段は差分とテストの結果。費用の材料（行数・agent の体数）はこの体が数える", "reasons.md（作り手の利点の主張。渡すと費用の見積もりが甘くなる）", "悪化する性質とその程度、目的の達成することとの比較、fail-open になる経路（path:line と条件）。数え方を書く。末尾に「指摘」の節を置き、費用が達成することに見合わない決定と fail-open の経路を file:line・何が誤りかで並べる", "opus・high", "Read, Grep, Glob"),
    ("decision-verifier", "決定への適合・検証可能性・形式検証の忠実さと結果・作り手の記録", "照らす正本（設計段は目的と利用者の決定、実装段は承認済みの decisions.md）・対象・テストと形式検証の結果（模型・検査の出力・規則と遷移の対応表・模型を書かない理由）・records.md", "目的への必要性の判断（purpose-auditor の担当。兼ねると「満たすか」が「要るか」を上書きする）", "決定ごとに満たす / 満たさない / 検証不能（path:line）。模型ごとに性質と抽象化の忠実さ、性質ごとの範囲と残りの宣言の有無、結果。模型を書かない理由が当たるか。typo 級という作り手の判定が当たるか。末尾に「指摘」の節を置き、満たさない・検証不能の決定、忠実でない模型、宣言の欠け、当たらない判定を file:line・何が誤りかで並べる。別に「作り手の検査の指摘」の節を置き、records.md の分類が誤りで残った欠陥を並べる（重大度を付けず設計へ戻る）", "opus・high（模型の忠実さの判断）", "Read, Grep, Glob"),
    ("reader", "初見の読み手での適用", "対象の本文のパス・scenes.md（無ければ無いことを宣言して本文から場面を挙げる）", "規範の束・reasons.md・目的（書いた側の文脈で読めてしまう）", "場面ごとに、読み手が取る行動・迷う箇所・複数の解釈ができる箇所（path:line）。末尾に「指摘」の節を置き、迷う箇所と複数の解釈ができる箇所を file:line・何が誤りかで並べる", "sonnet・medium（初見の読み手を模すので上位の推論を要しない）", "Read, Grep, Glob"),
    ("diff-verifier（既存。定義は変えない）", "REVIEW.md の観点の全般と、指摘を生んだ原因が除かれたか（両段。ready の後に足した差分を含む）", "差分（設計段は設計のファイルの差分、実装段は実装の差分）・テストの結果・追加の観点", "修正案の本文（書かせない）", "問題を file:line・誤り・重大度で（今の定義のまま。この並びを「指摘」の節として扱い、重大度の欄は振り分けに使わない）。見た範囲と、問題の無かった観点の確かめ方", "opus・high（今の定義のまま）", "Read, Grep, Glob, WebFetch（今の定義のまま）"),
    ("severity-assigner（新規）", "重大度の付与（agent の指摘だけ）", "観点の agent の返り値の「指摘」の節の file:line と何が誤りかの欄（呼ぶ側は節と列を選ぶだけ）・REVIEW.md「重大度」。引かれた行はこの体が読む", "指摘した agent が付けた重大度・指摘した agent の名前・reasons.md（付ける値が指摘した側や作り手の判断に引き寄せられる）", "指摘ごとに CRITICAL / HIGH / MEDIUM / LOW の 1 つと、当てた REVIEW.md「重大度」の行（path:line）。指摘を足さず、消さず、言い換えない", "sonnet・medium（閉集合からの選択。付け間違いのリスクは範囲と限界に載せる）", "Read, Grep, Glob"),
    ("make test・make portability・verify_install.py（agent にしない）", "書式・参照・配布", "作業ツリー", "-", "合否と BLOCKER 行", "none（script）", "-"),
]
w("agents.tsv", ["agent", "lenses", "input", "excluded_input", "output", "model", "tools"], A)

# ---------------------------------------------------------------- files.tsv
AG_COMMON = "frontmatter に name・description・tools（agents.tsv の tools 列）・model・effort を持つ。本文は観点の問い・入力・読まない入力とその理由・出力を agents.tsv の行のとおりに書き、出力の末尾の「指摘」の節（file:line・何が誤りか。重大度を付けない）を severity-assigner への入力の形として固定する。結果はファイルに書かず返り値で返す（保存は呼ぶ側の逐語のコピー）。段の条件と体数は書かない（正本は review-lenses.md）"
F = [
    ("（全ファイル共通の書き方）", "-", "本文に、設計の作業用の参照（利用者の回答の番号・main の行番号・作業用ディレクトリのパス・模型の性質の番号）を書かない。規則には守られないと何が壊れるかを 1 行で添え、理由は各行の content_gist にあるものを使う。docs/guidelines/ の新しい文書の規則には、既存の文書と同じく「検査:」の行を付ける", "作業用の参照は本文に写ると辿れない。理由を実装役が作ると設計の外で内容が生まれる。検査の行の書式は docs/guidelines/README.md「規約の書き方と検査」が求める", "P3"),
    ("AGENTS.md（全体）", "modify", "235 行を約 72 行にする（下の節の見込みの合計と節の間の空行）。実装は 1 項目を 1 行で書き、行を折り返さない（見込みの前提。折り返すと行数が見込みを超える）。節は 7 つ（冒頭・リポジトリ概要・現在の実体・作業ルール・規範の置き場・検証・言語）と、現在の実体の下位の節 1 つ。「インストール」「注意点」「Claude Code 固有」「Codex 固有」の 4 節を消す", "main の各行の行き先は main-lines.tsv。入口が重いと重要な制約が埋もれる。見出し「現在の実体」「作業ルール」「検証」「実体が plugins/ 側にある理由」は外から名指されるので名前を残す（V2・P10）", "P1 P2 P3 P9 P10"),
    ("AGENTS.md 節「冒頭」", "modify", "（見込み 4 行）見出しと 1 文: この文書は Claude Code と Codex が共に読む地図で、CLAUDE.md はこの文書の symlink。規則を足すときは docs/guidelines/placement.md の基準で置き場を決める（入口に足し続けると重要な制約が埋もれる）", "足し方を入口で言わないと次の改稿でまた膨らむ", "P2"),
    ("AGENTS.md 節「リポジトリ概要」", "modify", "（見込み 3 行）逐語のまま", "全作業の前提", "P1"),
    ("AGENTS.md 節「現在の実体」", "modify", "（見込み 11 行）(1) 公開済み・未公開の実体の置き場、.claude/skills、marketplace の定義と名前、公開用 plugin（置き場を誤ると公開時の移動と install が壊れる）。(2) 公開済みの Workflow script は plugins/<plugin>/workflows/ にあり名前で呼ぶ。2 段の規則は best-practices.md §13「script の置き場」。(3) 別 plugin のスキルは dependencies の宣言とスキル呼び出しで使い、実体のコピーもパス参照もしない（コピーは drift し、パスは install 先で解決しない。登録の手順は manage-marketplace-plugin）。この規則の正本はこの行。(4) .agents/skills/ の走査は find -L など symlink を辿る指定で行う（辿らないと結果が黙って 0 件になる）。(5) 収録スキル・plugin・公開名は写さず、正本（marketplace.json・ls・frontmatter の name）から得る。呼び出し名は <plugin>:<name> で、ディレクトリ名から推測しない（frontmatter の name がディレクトリ名より優先する）。テストの置き場は docs/guidelines/testing.md へ移す", "編集の置き場・検索・呼び出し名は題材を問わず毎回踏む。テストの置き場はテストを書くときだけ要る（V12）。plugin 間の規則の持ち主はこの行 1 つにし、手順だけを manage-marketplace-plugin が持つ（V11）", "P1 P2 P3 P5 P10"),
    ("AGENTS.md 節「現在の実体」の下位の節「実体が plugins/ 側にある理由」", "modify", "（見込み 3 行）見出しを残し 1 文: Codex は plugin のサブツリーだけを取得して symlink を落とすので、実体を plugins/ 側に置き、開発用の参照を .agents/skills/ の symlink にする。配布先に docs/ は入らない。ディレクトリ名は install 先のキャッシュ名になるので実体名に揃える。機序の詳細は .agents/skills/manage-marketplace-plugin/SKILL.md「設計上の不変条件（守るべきルール）」", "見出しを名指す外の参照が 3 件ある（develop-plugin.md:49・bp-run.md:487 とその写し）", "P2 P10"),
    ("AGENTS.md 節「作業ルール」", "modify", "（見込み 22 行）見出しの後に、抜粋 3 行を逐語で置き、各行の末尾に印「" + MA + "」を付ける。A: 「" + EXA + "」 B: 「" + EXB + "」 C: 「" + EXC + "」。続けて規則と 1 行の理由: (1) 編集は .agents/skills/<name>/ から行い（公開済みスキルは symlink 越しに plugins/ の実体を触る）、新規スキルもそこに実体で作り、plugins/ へ手で置かず、.claude/skills/ に実体を増やさない。公開済みの Workflow script だけは .agents/ から届かないので plugins/<plugin>/workflows/ を直接編集する（手で置くと公開時の移動と symlink がずれる）。(2) このリポジトリの未リリースの Workflow は Workflow({ scriptPath: \"<checkout の絶対パス>/plugins/<plugin>/workflows/<f>.js\", args }) で起動する（名前で起動すると install 済みの旧版が走るか、未 install なら not found になる）。(3) plugins/ 配下に symlink を作らない（理由は「実体が plugins/ 側にある理由」）。(4) plugin の登録・更新（公開済みスキルの変更の配布を含む）は manage-marketplace-plugin のスクリプトで PR の中で行い、公開はその PR のマージ（人間ゲート）とする（手で移すと catalog・plugin.json・symlink がずれる）。(5) 説明的なコメントを書かず、コメントはコードから読めない制約・根拠だけにし、経緯は commit message・PR 本文に置く（説明は読む量を増やし、コードと食い違って残る）。(6) 後方互換性は不要で、migration・旧形式の支持を書かず、合わない旧データは構造の検証で失敗させる。marketplace 配布の plugin の version bump は互換性管理ではなく配布機構なので対象外（互換層は合わない旧データを黙って通す）。(7) 途中で止めず完了まで実行し、作業の分割や Issue 化で完了を先送りしない。止まってよいのは人間ゲート（マージ）と、作り手の検査の失敗のうち作り手が自分では除けないものを、記録した分類と理由とともに利用者へ報告するときだけ（止まると利用者が状態を拾い直すことになり、先送りした作業は戻らない）。(8) 不在・網羅の断定には閉集合の全列挙・全文読み・形を変えた複数回の検索のどれかを示すか手段でスコープし、rename・削除の sweep の後は commit の前に再 grep で残 0 を確かめる（裏付けの無い断定は検証済みとして下流で使われる）。(9) 生成と検証を分離し、自分の成果物と修正差分に自分で合格を出さない（生成者には自分の欠陥が見えない）。(10) 検証は観点の異なる agent で行い、どの段にどの観点を何体当てるかは変更の規模に比例させて docs/guidelines/review-lenses.md で選ぶ（同じ観点の検証者を増やしても、全員に共通の死角は残る）。(11) 司令塔（メインセッションを含む）は、ループの内外と変更の大きさを問わず成果物を書かず、生成・修正・採点をしない。段を選び、返り値をそのまま relay し、承認後に機械的にコピーするだけにし、生成は builder 役の agent へ振る。変えたものの再検証は部品の側で強制し、ループの出口は役割の境界と一致させる（司令塔の手修正は欠陥を持ち込み、再検証を選択に含めると未検証の変更が成果物に届く）。(12) agent を fan-out するときは agent ごとに model と effort を明示し、同じ対象は抽出を 1 回にして配り、共有部分を prompt の先頭に置く。上位 model には絞った抜粋だけを渡し、絞る判断は閉集合からの選択にして見なかったものを宣言する（省くと最上位 model × 体数を消費し、黙って絞ると見なかった箇所が問題なしに化ける）。この規則の正本はこの行で、Workflow script での書き方は best-practices.md §3「model と effort は役割ごとに組で選ぶ」と §13「体数は測れる値から段階的に決める（作るスキル向けの設計指針）」。(13) 解決は常に根本原因の除去を目指し、構造で防げる誤りは構造を直す。設計と設計レビューもこれを規範にし、レビューは指摘が消えたかでなく原因が除かれたかを見る（注意書きは読まない経路で再発する。機序と判定の目安は best-practices.md §1「解決は根本原因の除去に置く（防御パッチを解決と呼ばない）」）。(14) 同じ値・列挙・上限・規則を 2 箇所に書かず、正本を 1 つにして他は参照にする。写しが要るときは機械で一致を照らす（書き写しは必ずずれる）。(15) commit を作ったら同じ作業単位のうちに remote へ push する（/tmp 系の worktree にしか無い commit は清掃で消える）", "毎回踏む規則だけを残し、機序と実測は正本へ出す。(1)(2)(3)(4)(11)(12) を作業ルールに残すのは外の参照が「作業ルール」で引くからでもある（refs.tsv）。(7) は利用者に問う停止を足さない（模型の停止点は人間ゲートと除けない失敗の報告だけ。limits.tsv）。(12) は ad-hoc の fan-out の正本をこの行と明記し、§3・§13 は Workflow script の詳細として指す（V3）。(C) は 1 文（Q3）", "P1 P2 P3 P10"),
    ("AGENTS.md 節「規範の置き場」", "create", "（見込み 13 行）作業の場面から読む正本を引く地図。場面ごとに 1 行: コード・テスト・文書を書く → docs/guidelines/README.md（ガイドラインの一覧の正本）。作業の流れ・目的と設計の置き場・作り手の検査の失敗とレビューの指摘の扱い → docs/guidelines/workflow.md。レビューの観点と体数を選ぶ → docs/guidelines/review-lenses.md、PR のレビューで読むもの → REVIEW.md。スキルを作る・直す・評価する → skill-creator-best-practices スキル（基準は best-practices.md）。要求・仕様を書く → prd-spec スキル（置き場は docs/requirements/INDEX.md・docs/specifications/INDEX.md）。形式検証の手順 → formal-methods スキル。このリポジトリの実装・修正の builder 役 → repo-implement スキル。plugin の登録・更新 → manage-marketplace-plugin スキル。Codex で Workflow を使うスキルを書く・走らせる → dynamic-workflow-runner スキル（Codex に native の Workflow は無い。caller が callsite に持つ route 契約は plugins/workflow/skills/dynamic-workflow-runner/references/claude-workflow-compatibility.md）。install・開発環境の設定 → README.md", "場面から引かないと、スキルの改稿・要求の作成・Codex での組み立ての入口が欠ける。ガイドラインの文書は個別に並べず README.md を指す（列挙を 2 か所にしない）", "P2"),
    ("AGENTS.md 節「検証」", "modify", "（見込み 6 行）Makefile が入口（make test は合否ゲート、make portability は配布 portability の一覧、make check はその両方）。対象スキルは .agents/skills/*/ から毎回導出する。make portability は exit 0 でも BLOCKER 行を人が読んで判断する（exit 0 を合格と読むと install 先で壊れるものが通る。既知の false positive は skills-audit.md §4.1b）。個別スキルの検証コマンドと quick_validate.py の SKIP: の読み方は docs/guidelines/testing.md。hook の記述と ready の後の差分の段落は置かない（hook は消し、段落は review-lenses.md へ移す）", "見出しは残す（implement-core.mjs:12・skill-design-patterns.md:521 とその写しが名指す）", "P1 P2 P4 P10"),
    ("AGENTS.md 節「言語」", "modify", "（見込み 3 行）ユーザーへの返答は日本語で行う", "全作業に当たる", "P1"),
    ("AGENTS.md 節「インストール」「注意点」「Claude Code 固有」「Codex 固有」", "modify", "4 節を消す。中身は README.md・manage-marketplace-plugin・runner の文書・「現在の実体」・testing.md へ移すか消す", "行ごとの行き先は main-lines.tsv。人の操作と既存の正本の写しで、agent の毎回の振る舞いを変えない", "P5 P8 P9 P12"),
    ("docs/guidelines/workflow.md", "create", "作業の流れの正本。各規則に「検査:」の行を付ける。節: (1) 目的の固定: 抜粋 A の行を逐語で置き末尾に印「" + MW + "」を付ける。作り手（builder 役の agent）が書く。固定した時点で draft PR を作る。置き場は規模で決める: 目的 1 行・設計 1 行で書ける変更（typo 級。作り手が判定し、設計レビューの decision-verifier が確かめる）は draft PR の本文、それ以外は docs/design/changes/<slug>/ に commit し PR 本文がそのパスを指す（PR から辿れないと、レビュー役と人が成果物と記録を見つけられない）。(2) 段と担い手: 抜粋 B の行を逐語で置き印を付ける。目的・設計・実装を書くのは builder 役の agent で、司令塔は段を選び返り値を relay するだけ（規則の正本は AGENTS.md「作業ルール」）。要求・仕様の文書は承認済みの設計の実装として実装段で書く。設計に戻った後は設計から実装レビューまでを順に通る。各段の成果物は規模に比例させ免除しない（typo 級は目的 1 行・設計 1 行）。(3) 設計の体裁: 置き場に purpose.md・decisions.md（決定）・reasons.md（理由）・scenes.md（利用場面）・records.md（作り手の検査の記録）・reviews/（レビューと振り分けの記録）を置き、模型を書くときは模型・結果・規則と模型の遷移の対応表も置く。typo 級は PR 本文の同じ名前の節にする（観点の agent が読まない入力をファイルの単位で外せるようにするため）。(4) 作り手の検査: 作業中に走らせる検査（make test・その段の形式検証）が落ちたら、作り手が原因を 欠陥・除ける環境・除けない環境 に分類し、環境と判じたら分類と理由を records.md に書く。欠陥なら重大度を付けずに設計へ戻る（直さない欠陥は合否ゲートで再び落ちる）。除ける環境なら原因を除いて同じ検査をその場でやり直し、段を変えない。除けない環境なら司令塔が分類と理由を利用者へ報告して止まる（止まってよい場所の正本は AGENTS.md「作業ルール」）。(5) レビューと振り分け: 各段のレビューは review-lenses.md が選ぶ観点の agent が行い、結果は司令塔が逐語で reviews/ に保存する。decision-verifier は records.md を読み、誤分類で残った欠陥を作り手の検査の指摘として出す。観点の agent は返り値の末尾に「指摘」の節（file:line・何が誤りか）を置き、severity-assigner がその節の指摘に REVIEW.md「重大度」で重大度を付ける。呼ぶ側はその節の file:line と何が誤りかの欄だけを渡す（節と列を選ぶだけで、どれを指摘にするかを決めない）。振り分けに使う重大度はこの値だけで、bot の指摘は bot の重大度をそのまま使い、作り手の検査の指摘と人の指摘には重大度を付けない。司令塔は、MEDIUM 以上の agent・bot の指摘、作り手の検査の指摘、人の指摘が 1 つでもあれば設計へ戻し、無ければ次の段へ進める。agent と bot の LOW は直さず PR 本文に載せて追わない（REVIEW.md の LOW の件数の上限を超えた分は件数を載せる）。実装レビューの振り分けを通ったら PR を ready にする（PR を出すとは ready にすること）。ready の後に設計へ戻るときも draft に戻さず、その後の差分は実装レビューで diff-verifier が見る。ready の後は bot のレビューと振り分けを経て人間ゲートへ進む。draft の間に来た人・bot の指摘は、その段のレビューの後の振り分けに加え同じ規則で扱う。往復の回数の上限は置かない。(6) 形式検証: 抜粋 C の行を逐語で置き印を付ける。性質ごとに、性質・検査器・前提と範囲・機械で確かめられない残りを宣言する（宣言の正本は docs/design/skill-design-patterns.md「機械で確かめる」）。設計の規則と模型の遷移を 1 対 1 で対応させ、表に無い遷移を規則に足さない。模型の忠実さと結果、模型を書かない理由は decision-verifier が見る。手順と道具は formal-methods スキルと docs/specifications/formal-methods.md。(7) 範囲と限界: PR 本文に、LOW の一覧、往復や分類が前提にする仮定とリスク、見なかったものを載せ、人がマージの前に読む。置かないもの: 観点の中身（review-lenses.md と agent 定義）、止まってよい場所の本文と根本原因の規範（AGENTS.md）、場面ごとの例外の条項", "抜粋の正本で、流れの模型の遷移を規則として持つ（rules.tsv）。出所ごとの例外を並べず、欠陥の扱いを 1 つの振り分けの規則にまとめる", "P3 P5"),
    ("docs/guidelines/review-lenses.md", "create", "段と観点の対応の正本。各規則に「検査:」の行を付ける。表の列は観点・担い手・設計レビュー・実装レビュー（yes・条件つき・no。条件は 1 行）。行: 目的への必要性（purpose-auditor。設計 yes、実装は実装が設計より大きくなったとき）・変更自体の必要性（alternatives-auditor。設計は新しいファイル・仕組み・agent を足す決定があるとき、実装は実装が設計より大きくなったとき）・置き場（placement-auditor。AGENTS.md・docs/・REVIEW.md・スキル・script の間で内容を足すか移す決定があるとき。実装 no）・費用対効果と設計段の失敗時の振る舞いの方針（risk-auditor。agent・段・ファイルを足す決定があるとき。実装 no）・決定への適合と検証可能性と形式検証と作り手の記録（decision-verifier。両段 yes）・初見の読み手での適用（reader。agent や人が読んで従う指示を変えるとき。両段）・REVIEW.md の観点の全般と原因が除かれたか（diff-verifier。設計は設計のファイルの差分に当て、実装は ready の後に足した差分を含む。両段 yes）・重大度（severity-assigner。agent の指摘があるとき。bot・作り手の検査・人の指摘には付けない）・書式と参照と配布（make test・make portability・verify_install.py。agent にしない）。体数: 条件に当たる観点だけを立て、固定の全員を当てない。typo 級は設計レビュー・実装レビューとも decision-verifier 1 体（指摘があれば severity-assigner を加える）。段階的に増やす決め方は best-practices.md §13「体数は測れる値から段階的に決める（作るスキル向けの設計指針）」。入力の渡し方: 呼ぶ側は agent 定義の入力の欄にあるファイルのパスを渡し、内容を書いて渡さない。設計段の置き場のファイルは作り手が 1 回作る束で、各体はそのファイルだけを読む。agent は結果を返り値で返し、保存は呼ぶ側の逐語のコピー。Codex での立て方の 1 行: .claude/agents/<name>.md の本文を指示として検証役を立て、frontmatter の effort を spawn のときに渡す。model は親を継承する（Claude の model 名は Codex に渡せない）。置かないもの: 各観点の問い・入力・出力（agent 定義が正本）", "どの段でどの観点を何体当てるかを 1 か所に置く。体数の例外を AGENTS.md と workflow.md に書かない（V9）。norm-auditor を作らず diff-verifier を設計段に当てる（V15）", "P2 P7"),
    ("docs/guidelines/placement.md", "create", "AGENTS.md と文書に何を置くかの基準の正本。基準ごとに問い・理由・「検査: レビュー」を置き、番号でなく名前で呼ぶ: 毎回踏む・地図として指す・規則と 1 行の理由だけ・機械で強制できる・題材の限られる規範・手順・検証の観点・人が行う設定・既に正本がある・節名で外から参照されている・道具ごとの差。出典の行番号と件数は移さない。作業に入れるかの判定（目的に要るか）は置かない（正本は workflow.md の目的の固定）", "AGENTS.md の冒頭から指す。基準が無いと次の改稿で入口が膨らむ。目的への要否を置き場の基準に混ぜると 3 か所目になる（V12）", "P2 P5"),
    ("docs/guidelines/README.md", "modify", "(1) 冒頭の文: 対象に作業の流れ・レビューの観点・置き場の基準を含める。(2) 文書表に workflow.md・review-lenses.md・placement.md を足す（ガイドラインの一覧の正本はこの表）。(3) 5 行目を「AGENTS.md は入口で、作業の流れ・レビューの観点・置き場の基準の詳細の正本は workflow.md・review-lenses.md・placement.md。AGENTS.md の作業ルールと配布の規則はここに写さない」に改める。26・27 行目は変えない", "向きを書いた文と文書の一覧を直さないと矛盾する。配布の規則の持ち主を 2 つ並べない（V11）", "P2 P10"),
    ("docs/guidelines/testing.md", "modify", "「検査の入口」に足す: (1) 個別スキルの検証コマンド（quick_validate.py・check_portability.py・check_references.py）。(2) quick_validate.py が通っても全項目の合格ではなく、SKIP: と申告された項目（検証者の有無・description の実発火など）は公開前にレビューで見る。(3) テストの置き場: workflows/ に置かない（runner は workflows/ 直下の .js を全て source として読む）。スキルのテストは scripts/*.test.mjs・tests/ に置き、別 plugin や plugin の外のファイルを読むテストは配布物に入れずリポジトリ直下の tests/ に置く（配布先で解決しない）", "テストを書くときだけ要る規則の受け皿。REVIEW.md のスクリプトとテストの行が既に testing.md を読む", "P5"),
    ("docs/guidelines/documentation.md", "modify（変更なし。確認の行）", "変えない。11 行目が規則の理由の正本、12 行目の「コードコメントの要否と変更経緯の置き場は AGENTS.md に従う」は作業ルール (5) が残るので有効", "既存の正本を再利用する", "P9"),
    ("docs/guidelines/javascript.md", "modify（変更なし。確認の行）", "変えない。34 行目の「source の配置と役割分担は AGENTS.md と best-practices の正本に従う」は、配置が「現在の実体」と作業ルール (1)、役割分担が作業ルール (11) に残るので有効", "参照の確認", "P10"),
    ("REVIEW.md", "modify", "(1) 13 行目の「AGENTS.md「注意点」」を「AGENTS.md「現在の実体」」に改める。(2) 14 行目の「AGENTS.md「注意点」（…）」を「.agents/skills/manage-marketplace-plugin/SKILL.md「設計上の不変条件（守るべきルール）」と README.md「インストール」（marketplace 名）」に改め、2 つの plugin.json の共通フィールドの一致と専用フィールドの混入は verify_install.py の L2 が検査すると 1 句で書く（節名は extractSections の完全一致に合わせ括弧まで書く）。(3) 21 行目の「「現在の実体」「注意点」」を「「現在の実体」」に改める。(4) 19 行目（すべて）に docs/guidelines/workflow.md を足す。(5) 行を足す: .claude/agents/*.md → docs/guidelines/review-lenses.md と best-practices.md §3「Sub-agent 設計」。(6) *.md の行に、AGENTS.md と docs/guidelines/ を変えるときは docs/guidelines/placement.md を足す。(7) 29 行目の「同じ値・列挙・上限が 2 箇所に書かれていないか」を「同じ値・列挙・上限が、機械で一致を照らさずに 2 箇所に書かれていないか」に改める。(8) 「重大度」の表に設計段の指摘を足す: HIGH に「目的・利用者の決定・承認済みの設計に反する決定」、MEDIUM に「目的に要らない要素・置き場の誤り・検証の手段が無い決定・読み手が複数に解釈できる指示」。3・11・15・35 行目は変えない", "repo-review は「読むもの」の表から方針の束を組み、AGENTS.md の指し先を辿らない。重大度の尺度を 1 つにし、設計段の指摘も同じ表で付ける（V1）。写しを機械で照らす規則が DRY の観点に届くようにする（V4）", "P5 P10"),
    ("tests/repo-review-workflow.test.mjs", "modify", "591〜593 行の期待値を新しい表に合わせる。591: 文書の集合に docs/guidelines/workflow.md・docs/guidelines/review-lenses.md・docs/guidelines/placement.md・.agents/skills/manage-marketplace-plugin/SKILL.md・README.md を足す。592: AGENTS.md の節は「作業ルール」「現在の実体」。593: best-practices.md の節番号の集合に §3 を 1 つ足す（.claude/agents の行が §3 を挙げる）", "表を変えると落ちる（テストのコメントがそう書く）", "P4"),
    ("tests/agents-md-excerpts.test.mjs", "create", "AGENTS.md の行のうち印「" + MA + "」で終わる行と、docs/guidelines/workflow.md の行のうち印「" + MW + "」で終わる行を取り出す。各行から行頭の「- 」と行末の印だけを除き、他は正規化しない。両方がちょうど 3 行で、除いた後の文の集合が完全に一致することを照らす（両方向。片方を削っても、印を外しても落ちる）。3 はこのテストの中の定数だけに書く。make test の Node テスト（Makefile の REPO_NODE_TEST_FILES が tests/*.test.mjs を拾う）に入り、traceability の登録は要らない", "受け入れた重複の一致を注意書きでなく機械で保つ。前例は tests/bp-criteria-copy.test.mjs", "P4"),
    ("README.md", "modify", "「インストール」に足す: Codex の marketplace の登録（codex plugin marketplace add）・Plugin Directory からの install・dependencies を推移的に手で入れること（jq での確かめ方）・marketplace.json の name が install の marketplace 名になること・旧 plugin の掃除（tools/update-plugins）。「開発」に足す: Codex Desktop の Worktree のセットアップ（scripts/worktree-setup.sh・.worktreeinclude は秘密を含むので最小限に）", "人が行う操作の正本。README には今 Codex の手順が無い", "P8 P12"),
    (".claude/agents/purpose-auditor.md", "create", AG_COMMON, "目的への必要性の死角を担う", "P7"),
    (".claude/agents/alternatives-auditor.md", "create", AG_COMMON, "変更自体の必要性の死角を担う", "P7"),
    (".claude/agents/placement-auditor.md", "create", AG_COMMON, "置き場の死角を担う", "P7"),
    (".claude/agents/risk-auditor.md", "create", AG_COMMON + "。比べる相手は目的の達成することで、作り手の利点の主張を受け取らない", "費用対効果を問う担い手が既存に無い。比べる相手を除外した入力の外から得る（V5）", "P7"),
    (".claude/agents/decision-verifier.md", "create", AG_COMMON + "。形式検証の模型・性質ごとの範囲と残りの宣言・規則と遷移の対応表と、作り手の記録 records.md を見る", "形式検証と作り手の分類を見る役が無いと、掛けたかも分類が正しいかも誰も確かめない（V13・Y3）", "P7"),
    (".claude/agents/reader.md", "create", AG_COMMON, "背景を持たない初見の読み手を模す担い手が既存に無い", "P7"),
    (".claude/agents/severity-assigner.md", "create", AG_COMMON + "。指摘ごとに REVIEW.md「重大度」の 4 つから 1 つを選び、当てた行を引く。指摘を足さず消さず言い換えない", "重大度を付ける専用の 1 体（Y2）。付ける者を指摘した者・作り手・司令塔と分ける", "P7"),
    (".claude/agents/diff-verifier.md", "modify（変更なし。確認の行）", "変えない。11 行目の「観点の分け方は AGENTS.md の規則に従い呼び出し側が決める」は、作業ルール (10) が review-lenses.md を指すので 1 段で届く", "役は変えない（V3）。参照が切れないので直さない（V15）", "P7 P10"),
    (".codex/hooks.json", "delete", "ファイルごと消す。PostToolUse の make test と Stop の通知（macOS の通知音）の 2 つが消える", "Codex の hooks をいったん削除する決定による（Q8）。通知も消えることは範囲と限界に載せる", "Q8"),
    ("docs/design/develop-plugin.md", "modify", "(1) 71 行目の「AGENTS.md「現在の実体」」を「docs/guidelines/testing.md」に改める（テストの置き場が移る）。(2) 201 行目の「AGENTS.md「plugin 間でスキルは共有できない」」を「AGENTS.md「現在の実体」」に改める。(3) 395 行目の「AGENTS.md「作業ルール」の規範の書き方」を「docs/guidelines/documentation.md」に改める", "消える見出しと、AGENTS.md から消える規則を名指す 3 行だけを直す", "P10"),
    (".agents/skills/manage-marketplace-plugin/SKILL.md", "modify（変更なし。確認の行）", "変えない。未公開で実体は .agents/skills/ 側。AGENTS.md から消す配布の詳細（共有の手順・2 つの plugin.json・初公開の script の移動・exit 4）は「設計上の不変条件（守るべきルール）」と依存の解決の手順の節が持つ", "既存の正本を再利用し、新しい配布の文書を作らない", "P6 P9"),
    ("traceability.config.json", "modify（変更なし。確認の行）", "変えない。tests/agents-md-excerpts.test.mjs は Makefile の REPO_NODE_TEST_FILES で拾われ、traceability の対象の外", "新しいテストが合否ゲートに乗ることの確認", "P4"),
]
w("files.tsv", ["path", "action", "content_gist", "reason", "criteria"], F)


# ---------------------------------------------------------------- refs.tsv
V4 = OUT.parent / "design-v4" / "refs.tsv"
rows = [l.split("\t") for l in V4.read_text(encoding="utf-8").splitlines()[1:]]
O = {
    "REVIEW.md:13": "AGENTS.md「現在の実体」（find -L の行の移動先。テストの置き場は同じ行が既に読む docs/guidelines/testing.md へ移る）",
    "REVIEW.md:14": ".agents/skills/manage-marketplace-plugin/SKILL.md「設計上の不変条件（守るべきルール）」と README.md「インストール」（marketplace 名）。フィールドの一致と混入は verify_install.py の L2 が検査すると 1 句",
    "REVIEW.md:19": "AGENTS.md「作業ルール」と docs/guidelines/workflow.md（足す）",
    "REVIEW.md:21": "AGENTS.md「現在の実体」",
    "tests/repo-review-workflow.test.mjs:591": "tests/repo-review-workflow.test.mjs:591（文書の集合に workflow.md・review-lenses.md・placement.md・manage-marketplace-plugin の SKILL.md・README.md を足す。593 行の §3 も足す）",
    "tests/repo-review-workflow.test.mjs:592": "tests/repo-review-workflow.test.mjs:592（['作業ルール','現在の実体']）",
    ".claude/agents/diff-verifier.md:11": "変更なし（作業ルールの検証の行が docs/guidelines/review-lenses.md を指し、1 段で届く）",
    "docs/design/develop-plugin.md:201": "AGENTS.md「現在の実体」（plugin 間の規則の行き先）",
    "docs/design/develop-plugin.md:71": "docs/guidelines/testing.md（テストの置き場の行き先）",
    "docs/design/develop-plugin.md:395": "docs/guidelines/documentation.md（規範の書き方は AGENTS.md から消え、documentation.md:11 が正本）",
    "docs/guidelines/README.md:5": "docs/guidelines/README.md:5（「AGENTS.md は入口で、作業の流れ・レビューの観点・置き場の基準の詳細の正本は workflow.md・review-lenses.md・placement.md。AGENTS.md の作業ルールと配布の規則はここに写さない」に改める）",
    "AGENTS.md:33": "消える（共有の手順と Codex の手動 install の正本は .agents/skills/manage-marketplace-plugin/SKILL.md「設計上の不変条件（守るべきルール）」）",
    "AGENTS.md:50": "消える（README.md「インストール」へ移る）",
    "AGENTS.md:174": "消える（Codex の hooks を消す）",
    "AGENTS.md:235": "消える（Codex の hooks を消す）",
}
OLD = {
    ".agents/skills/repo-implement/scripts/plan.js:12": "作業ルールの fan-out の規則（model と effort の明示）",
    ".agents/skills/repo-review/scripts/review.js:16": "同上",
    ".agents/skills/address-review/scripts/triage.js:12": "同上",
    "docs/specifications/bp-inspection.md:268": "作業ルールの fan-out の規則（共有部分を prompt の先頭に置く）",
    "plugins/skill-creator/skills/skill-creator-best-practices/references/criteria/specifications/bp-inspection.md:268": "同上",
    "docs/specifications/bp-entry.md:179": "AGENTS.md の Codex の Workflow caller の記述（消え、runner の文書が正本）",
    "plugins/skill-creator/skills/skill-creator-best-practices/references/criteria/specifications/bp-entry.md:179": "同上",
    "docs/specifications/bp-entry.md:244": "AGENTS.md の Codex の dependencies の記述（README.md へ移る）",
    "plugins/skill-creator/skills/skill-creator-best-practices/references/criteria/specifications/bp-entry.md:244": "同上",
    "docs/design/develop-plugin.md:140": "作業ルールの段の選択の項",
    "docs/design/develop-plugin.md:425": "作業ルールの scriptPath での起動の項",
    "docs/design/develop-skills-redesign.md:165": "作業ルールの fan-out の規則",
    "docs/design/develop-skills-redesign.md:175": "同上",
    "docs/design/develop-skills-redesign.md:195": "同上",
    "docs/design/develop-skills-redesign.md:209": "同上",
    "docs/design/develop-skills-redesign.md:327": "同上",
    "docs/design/develop-plugin.md:71": "AGENTS.md「現在の実体」のテストの置き場（docs/guidelines/testing.md へ移る）",
    "docs/design/develop-plugin.md:395": "作業ルールの規範の書き方（消える）",
    "docs/design/develop-plugin.md:374": "作業ルールの fan-out の規則",
}
out = []
for r in rows:
    ref = r[0]
    if ref.startswith("検索語"):
        continue
    if ref in OLD:
        r[2] = OLD[ref]
    if ref in O:
        r[3] = O[ref]
    out.append(r)
out.append(["検索語（閉集合の作り方）", "grep -rnIE 'AGENTS\\.md' --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.work . で 94 件（設計の時点で数え直した）。うち AGENTS.md:1 は自身の見出しで、外部は 92 件。全件を上の行に起こした。AGENTS.md の中の自己参照（25・33・50・174・235 行）は grep -nE 'AGENTS|作業ルール|注意点|Codex 固有|インストール」|hooks' AGENTS.md。hook は grep -rnIE 'hooks\\.json|\\.codex/hooks' から plugin 同梱の hooks/hooks.json（別物）を除いたもの。grep -r は symlink を辿らないので、公開済みスキルは plugins/ の実体で数えた", "判定の規則: 消える節・消える規則を名指す参照は直す。機械の読み手（REVIEW.md の表とそのテスト）は指し先を辿らないので直す。節が残り規則もその節に残る参照は変えない", "直す参照は REVIEW.md の 4 行（13・14・19・21）・テストの 3 行（591〜593）・develop-plugin.md の 3 行（71・201・395）・docs/guidelines/README.md:5 と、AGENTS.md 自身の 4 行（33・50 は移動で、174・235 は hook の削除で消える）"])
w("refs.tsv", ["referrer", "ref", "old_target", "new_target"], out)

# ---------------------------------------------------------------- out-of-scope.tsv
OS = [
    ("out-of-scope", "スキルの修正ループを「設計に戻る」と重大度の閾値に揃える（repo-implement・address-review・build_skill.js・pr-review-fix・prd-spec.js・review-document）", "purpose.txt（Q1）", "規範を先に入れ、スキルは直後の別 PR で直す", "直後の別 PR"),
    ("out-of-scope", "best-practices.md §13 のスコープの梯子と「設計に戻る」の食い違い", "W3", "best-practices を更新するので扱わず、優先の 1 行も書かない", "best-practices の更新"),
    ("out-of-scope", "formal-methods スキルの未決の解消（実行形態・契約の書式・取り込みの採否）", "purpose.txt（Q2）", "手順の正本として参照するだけ", "design-v2h/later.tsv"),
    ("out-of-scope", "quick_validate.py・address-review の evals.json の「設計レビュー」の語の揃え", "purpose.txt（Q4）", "スキルの改修と同じ別 PR。testing.md の SKIP: の文は段を名指さない", "直後の別 PR"),
    ("out-of-scope", "Codex の hook の再導入と、検査の時機の設計", "purpose.txt（Q8）", "削除だけを行う", "後で見直す"),
    ("out-of-scope", "Codex 用の agent 定義の生成（.codex/agents/*.toml・生成 script・照合テスト）", "W1", "観点の agent を呼ぶ側を組み込む PR へ回す。review-lenses.md に立て方を 1 行だけ置く", "呼ぶ側を組み込む PR"),
    ("out-of-scope", "観点の agent と severity-assigner を既存のスキル（repo-review・pr-review・skill-creator の reviewer）や Workflow へ組み込むこと", "purpose.txt", "agent 定義と段の対応表と流れの規則を置くまで。組み込みは直後の別 PR のスキルの改修で行う", "直後の別 PR"),
    ("out-of-scope", "規則を機械の検査へ昇格させること（plugins/ の深い階層の symlink の検査を make test に入れる・節名の参照の実在を check_references.py に入れる）", "purpose.txt", "候補を挙げるだけ。make test の check_references.py は skills の root と公開済みスキルの root の symlink を既に拒否し、それより深い階層は verify_install.py だけが見る。足す機械の検査は抜粋の一致の照合だけ", "別 PR"),
    ("out-of-scope", "docs/ の鮮度を定期的に検査する仕組み", "purpose.txt", "目的に要らない", "未定"),
    ("out-of-scope", "develop-skills-redesign.md の AGENTS.md の引用（止めない）の照合", "purpose.txt（later.tsv）", "3 スキルの再設計に入るときに照らす", "design-v2h/later.tsv"),
    ("out-of-scope", "この変更自身の目的・設計・模型を新しい置き場（docs/design/changes/）へ移すこと", "この設計（目的の達成することに照らした）", "目的は流れを規範にすることで、この変更の成果物を移すことは要らない。移すと本文の根拠が利用者の回答の番号を引く形のまま入る。この変更の成果物は今の作業用ディレクトリのまま PR 本文が指し、新しい置き場の規則はマージの後の変更から当てる", "利用者（作業用ディレクトリを PR に残すかの扱いを含む）"),
    ("cut", "新しい docs/guidelines/multi-agent.md・distribution.md", "束 B1", "既存の正本（best-practices §1・§3・§13、manage-marketplace-plugin の不変条件、runner の文書、verify_install.py）が持つ。持たない分は AGENTS.md に残す", "-"),
    ("cut", "evidence-packer・claim-checker の agent", "束 B1・B7・V2", "設計段の束は作り手が置き場のファイルとして 1 回作り、各体はパスで受ける。主張の裏付けは REVIEW.md「不在・網羅の断定」を diff-verifier が当てる", "-"),
    ("cut", "norm-auditor の agent", "V15", "diff-verifier に設計のファイルの差分と「原因が除かれたか」の観点を渡せば同じ仕事になる。同じ観点の担い手を 2 つにしない", "-"),
    ("cut", ".claude/agents/diff-verifier.md の 11 行目の書き換え", "V15", "作業ルールの検証の行が review-lenses.md を指すので参照が切れない", "-"),
    ("cut", "作り手の検査の指摘に重大度を付けて LOW を PR 本文に載せる経路", "flow-model-2-verify の判定", "直さない欠陥は合否ゲートで再び落ち、往復が終わらない。全て設計へ戻す", "-"),
    ("cut", "人の指摘への重大度の付与", "flow-model-2-verify の判定・X3", "人の指摘は重大度を問わず設計へ戻るので経路に効かず、agent の呼び出しが 1 回増えるだけ", "-"),
    ("cut", "ready の後に設計へ戻るとき PR を draft に戻すこと", "flow-model-2-verify の判定（C4 を外す）・V3", "戻すと ready の後の差分が無くなり diff-verifier の役が空になる", "-"),
    ("cut", "documentation.md への追記（規範の理由・同じ値の実例・コメント・sweep）", "束 B1・B6", "規範の理由は documentation.md:11 が持つ。実例は経緯で commit の履歴にある", "-"),
    ("cut", "docs/specifications/ とその写しの AGENTS.md への参照の付け替え", "refs.tsv", "規則が「作業ルール」に残るか、地図から 1 段で辿れる。写しを変えると skill-creator plugin の再配布が要る", "-"),
    ("cut", "場面ごとの個別の条項（作業中の検査・環境の原因・除けない失敗・typo・利用者への問い）を例外として並べること", "規範「端の場面を条項で閉じない」", "欠陥の扱いの 1 つの振り分けの規則と、規模に比例させる 1 つの規則と、止まってよい場所の 1 行にまとめる", "-"),
    ("cut", "main の実測の経緯（cycle 上限・timeout・60 体のレート制限・250K tokens/分・4 round の消失・手修正 3/3）", "束 B6", "規則と 1 行の理由だけを残し、経緯は commit の履歴に任せる", "-"),
]
w("out-of-scope.tsv", ["kind", "item", "source", "reason", "where_next"], OS)

# ---------------------------------------------------------------- limits.tsv
LM = [
    ("risk", "重大度の付け間違い: 真に MEDIUM の指摘を severity-assigner が LOW と付けると、直されずに PR 本文に載ったままマージに届きうる", "Z1・模型の I1", "受け入れる。PR 本文の LOW の一覧をマージの前に人が読むことで拾い、人の指摘は重大度を問わず設計へ戻る。読み落とせば届く"),
    ("assumption", "往復が終わる前提: 修正が欠陥を持ち込むのは有限回、と模型は仮定する。実際には修正は常に欠陥を持ち込みうる", "Z2・模型の F1", "回数の上限を置かない。往復が終わらないリスクとして載せる"),
    ("assumption", "記録を読んだレビュー役が誤分類を見落とさない、と模型は仮定する。実際には見落としうるので、環境と誤って分類された欠陥が残りうる", "Z2・模型の F6", "リスクとして載せる"),
    ("assumption", "レビュー役は実在の欠陥だけを指摘する（誤検出が無い）、と模型は仮定する。直した欠陥を MEDIUM と誤検出し続けると往復が終わらない", "Z2・flow-model-2-verify の assumptions", "回数の上限を置かない。リスクとして載せる"),
    ("assumption", "環境の失敗と誤分類はそれぞれ有限回、と模型は仮定する", "模型の F2・F5", "原因を除いてやり直すので続きにくいが、実測は無い"),
    ("risk", "誤分類で止まる: 作り手が欠陥や除ける環境を除けない環境と分類すると、要らない報告で止まる", "模型の I2", "欠陥はマージに届かない。報告を読む利用者が分類を確かめる"),
    ("limit", "模型が示したのは、止まった状態で次に動けるのが人だけであることまでで、次の行動が 1 つであることは示していない（人間ゲートでは指摘とマージの 2 つがある）", "flow-model-2-verify の判定（C3）", "そのまま載せる"),
    ("limit", "模型の結果は有限の定数での欠陥の証拠で、証明ではない", "Flow.tla の冒頭", "そのまま載せる"),
    ("limit", "設計の時点で模型が走っているのは、作り手の検査を全て設計へ戻す版までで、重大度を agent の指摘に限ること・ready の後も draft に戻さないこと・draft の間の指摘をその段の振り分けに加えることは模型に入っていない。模型は設計段の成果物なので、実装の前に設計段で直して走らせる（後に回すと「その段の生成者が模型を書いて走らせる」とずれる）", "flow-model-2-verify の判定・Z3", "走らせた結果でこの行を書き直す。走らせないまま実装へ進むなら、このずれを PR 本文に載せる"),
    ("limit", "利用者に価値判断を問うための停止は模型に無く、この設計は置かない。報告の後の再開も模型に無い（報告は終端）", "flow-model-2 の table.tsv・V10", "そのまま載せる"),
    ("limit", "観点の agent が読まない入力（理由のファイル）はファイルを分けて外すが、agent は Read を持つので読もうとすれば読める。外し方は渡すパスの選択までで、読み取りの禁止ではない", "V5", "そのまま載せる"),
    ("limit", "diff-verifier は定義を変えないので自分でも重大度を出すが、振り分けには severity-assigner の値だけを使い、呼ぶ側は指摘の file:line と何が誤りかの欄だけを渡す", "V3・Y2", "そのまま載せる"),
    ("limit", "スキルの改修までの間、repo-implement などの上限つきの修正ループと「欠陥は設計へ戻る」が食い違う", "Q1", "改修は直後の別 PR。優先の規則を書かない"),
    ("limit", ".codex/hooks.json を消すと、Stop の通知（macOS の通知音）の hook も消える", "Q8", "削除は決定の字義どおり。通知が要るなら利用者の個人設定に置く"),
    ("limit", "Codex では、呼ぶ側が spawn のときに effort を渡し、model は親を継承する。読み取り専用は Codex では指示でしか担保できない", "W1・V14", "生成と組み込みの PR で決める"),
    ("limit", "typo 級でない変更の置き場は docs/design/changes/ に溜まり、リポジトリに経緯が残る", "X1", "受け入れる"),
]
w("limits.tsv", ["kind", "item", "source", "handling"], LM)

# ---------------------------------------------------------------- checks-for-impl.tsv
CK = [
    ("地図の入口: PR やレビューの指摘に対応する場面から workflow.md の振り分けに辿れるか", "AGENTS.md「規範の置き場」", "V17", "reader に場面「指摘に対応する」を渡して読ませる"),
    ("地図の入口: runner は caller の callsite から内部利用されるという見え方が、Codex の場面の行で読めるか", "AGENTS.md「規範の置き場」", "V17", "reader に場面「Codex で Workflow caller を書く」を渡す"),
    ("未公開スキルの Workflow script の置き場が「現在の実体」(2) から読めるか（2 段の規則の指し先）", "AGENTS.md「現在の実体」", "V17", "reader に場面「新規スキルを作る」を渡す"),
    ("スキルの呼び出し名（<plugin>:<name>）の解決が本文から読めるか", "AGENTS.md「現在の実体」", "V17", "reader に場面全般で読ませる"),
    ("抜粋 C が 1 文のままで、AGENTS.md と workflow.md の 3 行が逐語で一致するか", "AGENTS.md「作業ルール」・docs/guidelines/workflow.md", "V4（D5）", "tests/agents-md-excerpts.test.mjs の実行と目視"),
    ("行数の見込み（AGENTS.md 全体・作業ルール）が本文の実測と合うか。見込みの数え方は 1 項目 1 行・折り返しなし", "AGENTS.md", "V18", "wc -l と節ごとの数え直し"),
    ("本文に作業用の参照（利用者の回答の番号・main の行番号・作業用ディレクトリのパス・模型の性質の番号）が無いか", "files.tsv の create・modify の全ファイル", "共通の行", "grep で番号とパスの形を探す"),
    ("規則ごとに守られないと何が壊れるかの 1 行があるか。新しい docs/guidelines/ の文書の規則に「検査:」の行があるか", "AGENTS.md・workflow.md・review-lenses.md・placement.md", "共通の行・V12", "diff-verifier と reader"),
    ("REVIEW.md の新しい表の節名が見出しと完全一致するか（括弧まで）", "REVIEW.md", "V18", "tests/repo-review-workflow.test.mjs の実行"),
]
w("checks-for-impl.tsv", ["check", "target", "source_bundle", "how"], CK)

# ---------------------------------------------------------------- main-lines.tsv / canon-inventory.tsv（v4 を土台に直した行だけ置き換える）
MM = "（.agents/skills/manage-marketplace-plugin/SKILL.md「設計上の不変条件（守るべきルール）」）"
ML = {
    "L19 後半": ["docs/guidelines/testing.md「検査の入口」", "理由つきで 1 行に移す。develop-plugin.md:71 の指し先を testing.md に付け替える", "テストを書くときだけ要る規則で、REVIEW.md のスクリプトとテストの行が既に testing.md を読む。best-practices §13 にこの規則は無い"],
    "L21": ["消す" + MM, "消す。作業ルール (4) の登録の行がスキルを指す", "正本が既にある"],
    "L23-27": ["AGENTS.md「現在の実体」の下位の節（見出しを残す）", "1 文に縮め、機序の詳細は manage-marketplace-plugin の不変条件を指す", "見出しを名指す外の参照が 3 件ある（develop-plugin.md:49・bp-run.md:487 とその写し）。AGENTS.md:25 は作業ルールを指し、この見出しを名指さない"],
    "L29-31": ["AGENTS.md「現在の実体」", "規則と 1 行の理由で残し、この規則の正本をこの行 1 つにする。手順は manage-marketplace-plugin。見出し「plugin 間でスキルは共有できない」は消す", "誤ると install 先で壊れる。見出しを名指す参照は develop-plugin.md:201 だけで、「現在の実体」へ付け替える"],
    "L33-37": ["消す" + MM, "消す。L31 の残しの 1 行が手順の持ち主を指す", "共有の手順・Codex の手動 install は不変条件と依存の解決の手順の節が持つ"],
    "L59": ["AGENTS.md「作業ルール」", "残す。理由は「実体が plugins/ 側にある理由」を指す", "make test の check_references.py は skills の root と公開済みスキルの root の symlink を拒否するが、それより深い階層は verify_install.py（登録後）だけが見る"],
    "L62": ["AGENTS.md「作業ルール」", "残し、登録・更新は PR の中で行い公開はマージ（人間ゲート）と書く", "手で移すと catalog と symlink がずれる。公開の意味を決めないと止まってよい場所が割れる"],
    "L70-71": ["AGENTS.md「作業ルール」（止まってよい場所の正本）", "止まってよい場所に「作り手の検査の失敗のうち作り手が除けないものを、分類と理由とともに報告するとき」を足す。利用者への問いのための停止は足さない（模型の停止点に無い）。workflow.md はこの行を指す", "全作業で踏む。正本をここ 1 か所にする"],
    "L79-81": ["AGENTS.md「作業ルール」", "残し、観点と体数は規模に比例させて docs/guidelines/review-lenses.md で選ぶと書く", "観点の中身と体数の例外を AGENTS.md に書かない"],
    "L101-107": ["AGENTS.md「作業ルール」（規則と 1 行の理由）", "規則と理由を残し、設計と設計レビューもこれを規範にすると書く。機序と判定の目安は best-practices.md §1 を指す", "§1 が機序の全文を持つ。設計と設計レビューの規範であることは利用者の決定"],
    "L108-117": ["AGENTS.md「作業ルール」（この行が ad-hoc の fan-out の正本）", "規則と 1 行の理由を残す。Workflow script での書き方として best-practices.md §3・§13 を指す", "§3・§13 は Workflow script と作るスキルの指針で、メインセッションの ad-hoc の fan-out を持たない。plan.js:12・review.js:16・triage.js:12・bp-inspection.md:268 が「作業ルール」で引く"],
    "L118-127": ["AGENTS.md「作業ルール」（L108-117 の行に 1 句）", "1 句で残す", "上位 model への入力を絞る規則は best-practices に無い"],
    "L85-94": ["AGENTS.md「作業ルール」", "3〜4 行に詰めて残す（実測は消す）", "Workflow の範囲で再検証を構造で強制する機序は best-practices.md §13「最後の書き込みも generator-verifier の内側に置く」が持つが、メインセッションと段の選択は持たないので AGENTS.md に残す。develop-plugin.md:140 が「作業ルール」の段の選択を引く"],
    "L176": ["docs/guidelines/review-lenses.md（diff-verifier の行と Codex での立て方の 1 行）", "移す。diff-verifier は設計段・実装段とも当て、実装段は ready の後に足した差分を含む", "段と観点の対応の正本は 1 つ"],
    "L204": ["README.md「インストール」", "1 文で移す。REVIEW.md:14 が marketplace 名のために README.md を読む", "install のコマンドに marketplace 名が出る場所"],
    "L205": ["消す（生成は manage-marketplace-plugin の不変条件、区別は verify_install.py の L2）", "消す。REVIEW.md:14 の指し先を manage-marketplace-plugin の SKILL.md「設計上の不変条件（守るべきルール）」と README.md に付け替え、L2 が検査することを 1 句で書く", "機械と正本が既にある。不変条件は 2 つの plugin.json の生成と dependencies が Claude 側だけであることを持ち、Codex 仕様に無いフィールドの混入は L2 が拒否する"],
    "L207": ["消す", "消す。caller の route 契約は claude-workflow-compatibility.md が持ち、地図の Codex の行がそこを指す。参照の列挙の grep は書かない（runner の名前で検索すれば得られる）", "正本が既にある"],
}
src = [l.split("\t") for l in (OUT.parent / "design-v4" / "main-lines.tsv").read_text(encoding="utf-8").splitlines()]
for r in src[1:]:
    if r[0] in ML:
        r[2], r[3], r[4] = ML[r[0]]
w("main-lines.tsv", src[0], src[1:])

CI = {
    "manage-marketplace-plugin SKILL.md「設計上の不変条件」": ["manage-marketplace-plugin SKILL.md「設計上の不変条件（守るべきルール）」", ".agents/skills/manage-marketplace-plugin/SKILL.md:170-185（未公開。実体は .agents/skills/ 側）と依存の解決の手順 :118-128"],
    "best-practices.md §1「解決は根本原因の除去に置く」": ["best-practices.md §1「解決は根本原因の除去に置く（防御パッチを解決と呼ばない）」", None],
    "best-practices.md §13「体数は測れる値から段階的に決める」": ["best-practices.md §13「体数は測れる値から段階的に決める（作るスキル向けの設計指針）」", None],
}
src = [l.split("\t") for l in (OUT.parent / "design-v4" / "canon-inventory.tsv").read_text(encoding="utf-8").splitlines()]
for r in src[1:]:
    if r[0] in CI:
        name, loc = CI[r[0]]
        r[0] = name
        if loc:
            r[1] = loc
    if r[0].startswith("best-practices.md §3「model"):
        r[4] = "AGENTS.md の作業ルール (12) が ad-hoc の fan-out の正本で、ここは Workflow script での書き方として指す"
    if r[0].startswith("best-practices.md §13「体数"):
        r[4] = "Workflow script の evidence pack の指針として作業ルール (12) と review-lenses.md から指す。観点の agent の束は作り手が置き場のファイルとして 1 回作る"
    if r[0].startswith(".claude/agents/diff-verifier.md"):
        r[4] = "そのまま残し、review-lenses.md で設計段（設計のファイルの差分）と実装段（ready の後の差分を含む）の REVIEW.md 観点の担い手にする。norm-auditor は作らない"
    if r[0].startswith("REVIEW.md「観点」"):
        r[4] = "両段の REVIEW.md 観点の担い手は diff-verifier（と PR の repo-review）にし、新しい agent を作らない"
    if r[0].startswith("claim-gate"):
        r[4] = "成果物の主張は REVIEW.md「不在・網羅の断定」を diff-verifier が当て、claim-checker を作らない"
src.append(["best-practices.md §13「最後の書き込みも generator-verifier の内側に置く」", "plugins/skill-creator/skills/skill-creator-best-practices/references/best-practices.md:797-822", "司令塔が握る最後の反映も別の担当の検証を通す。再検証を散文でなく構造（ダイジェストの照合）で強制する", "Workflow", "作業ルール (11) の「再検証は部品の側で強制する」の Workflow での機序として指せる。メインセッションの範囲は AGENTS.md に残す"])
src.append(["REVIEW.md「重大度」", "REVIEW.md:49-58", "CRITICAL / HIGH / MEDIUM / LOW の表と LOW の件数の上限", "PR の欠陥", "重大度の尺度の正本にし、設計段の指摘の行を足して両段で 1 つの尺度にする。severity-assigner がこれで付ける"])
w("canon-inventory.tsv", src[0], src[1:])
print("ok all")
