from pathlib import Path

OUT = Path(__file__).resolve().parent
A1 = "作業の最初に、防ぐ失敗・達成すること・やらないことを書いて目的を固定し、以後の追加はレビューで求められたものも含めて目的に要るかで判定する（固定しないと、指摘のたびに要素が足されて作業が膨らむ）。"
B1 = "変更は規模を問わず「目的の固定 → 設計 → 設計レビュー → 実装 → 実装レビュー」を通し、各段の成果物とレビューは規模に比例させる。設計などの文書も実装も、生成の後にレビューを通す（免除すると、小さな変更ほど検証の無いまま入る）。"
B2 = "欠陥が出たら、見つかった段を問わず成果物を直接直さずに設計へ戻る。agent と bot の指摘は重大度を付け、MEDIUM 以上を設計へ戻し、LOW は直さず PR 本文に載せて追わない。人の指摘と作り手の検査で見つかった欠陥は重大度を問わず設計へ戻る。重大度は指摘した者でなく専用の agent（severity-assigner）が付ける（直接直すと、欠陥を生んだ原因が設計に残り、同じ欠陥が形を変えて戻る）。"
C1 = "形式検証は要求・仕様・実装の全てに掛け、その段の生成者が模型を書いて走らせ、状態や決定の衝突が起きえない変更では模型を書かずに理由を 1 行書き、手順は formal-methods スキルに従う（機械で確かめない分岐は、散文の読み違いとして誰にも見つからずに残る）。"
STOP = "途中で止めず完了まで実行する。止まってよいのは人間ゲート（マージ。マージが公開に当たる）と、作り手の検査の失敗のうち環境が原因で作り手には除けないものを、分類と理由とともに利用者へ報告するときだけ。環境が原因で作り手が除けるものは、除いて同じ検査をやり直す。"
FAN = "agent を fan-out するときは agent ごとに model と effort を明示し、閉集合からの選択は小さい model に任せ、同じ対象は抽出を 1 回にして配り、共有部分を prompt の先頭に置き、上位 model へ渡すものは絞る（実測: model を省いた監査の workflow は最上位 model を継承し、5 時間のレート制限の窓を約 3 分で使い切った）。細則は docs/guidelines/review-lenses.md「fan-out」。"


def w(name, header, rows):
    for r in rows:
        assert len(r) == len(header), (name, r[0][:30])
        for c in r:
            assert "\t" not in c and "\n" not in c, (name, r[0][:30])
    (OUT / name).write_text("\t".join(header) + "\n" + "".join("\t".join(r) + "\n" for r in rows), encoding="utf-8")


# ------------------------------------------------------------------ files.tsv
AGC = "frontmatter に name・description・tools・model・effort（agents.tsv の行）。本文は観点の問い・入力・読まない入力とその理由・出力。返り値の末尾に「指摘」の節（file:line・何が誤りか。重大度を付けない）を置く形は review-lenses.md「返り値の形」を指し、写さない。結果はファイルに書かず返り値で返す"
F = [
    ("（全ファイル共通）", "-", "本文に作業用の参照（利用者の回答の番号・作業用ディレクトリのパス・模型の性質の番号）を書かない。規則には守られないと何が壊れるかを 1 行で添える。運用の手順（受け箱・bot の起こし方・指摘の時点ごとの扱い・数の照合・再開・置き場の分け方）を書かない", "規範の水準に留める決定。手順は流れを実行するスキルの改修で決める", "BB1"),
    ("AGENTS.md 作業ルール: 冒頭の「ガイドラインを参照する」行の後に 4 行を足す", "modify", "(1) 目的: 「" + A1 + "」 (2) 流れ: 「" + B1 + "」 (3) 欠陥の扱い: 「" + B2 + "」 (4) 形式検証: 「" + C1 + "」", "利用者の決定で、目的の固定・生成の後のレビュー・形式検証の 3 つは重複しても入口に置く。この 4 行が規範の正本で、詳しい手順を置く別文書は作らない（手順は運用の水準）", "D1 D3 Q3 Q5 V5 W4 W5 X3 Y2"),
    ("AGENTS.md 作業ルール: 止まってよい場所の行（「途中で止めず完了まで実行する。人間ゲート（マージ・公開）以外では止めない。」）", "modify", "1 文目を「" + STOP + "」に改める。次の行（作業の分割や Issue 化で先送りしない）は変えない", "除けない失敗の報告と環境の原因のやり直しの決定を、止まってよい場所の唯一の行に入れる（別の行に例外を書くと止まる場所が 2 か所になる）", "Q9 Q10 X2"),
    ("AGENTS.md 作業ルール: 検証は単一視点にしない行", "modify", "1 文目の後に「観点は目的に応じて選び、どの段にどの観点を当てるかと担い手は docs/guidelines/review-lenses.md に置く。」を足す。後半（multi-agent workflow として設計することを考慮する）は変えない", "観点の中身を入口に写さず、選び方の原則だけを置く", "BB2 V5"),
    ("AGENTS.md 作業ルール: 1 役割 1 責務の行", "modify", "「検証は決定的テスト + 生成者と別の fresh 監査 + PR レビュー（人間）が持つ」を「検証は決定的テスト + 形式検証 + 生成者と別の fresh なレビュー + PR レビュー（人間）が持つ」に改める", "検証の担い手の列挙に形式検証が無いと、形式検証の行と食い違う", "D3"),
    ("AGENTS.md 作業ルール: 根本原因の行", "modify", "1 文目の後に「設計と設計レビューもこの規範に従い、レビューは指摘が消えたかでなく原因が除かれたかを見る。」を足す", "設計と設計レビューの規範であることを明記する決定", "D2"),
    ("AGENTS.md 作業ルール: fan-out の行（20 行）", "modify", "1 行にする: 「" + FAN + "」", "正本を review-lenses.md に置き入口は規則 1 行・理由・指し先にする決定。外の参照が引く語（model と effort・閉集合は小さい model・抽出を 1 回・prompt の先頭・上位 model へ絞る・実測）を 1 行に残し、参照を直さずに済ませる", "AA3"),
    ("AGENTS.md 検証: hook の行と ready の後の差分の段落", "modify", "(1) 「make test は .codex/hooks.json の PostToolUse hook … からも呼ばれる。」の行を消す。(2) ready の後の差分の段落の括弧「（観点を分けるかは差分の大きさと種類で呼び出し側が決め、分けるときは検証役を観点ごとに立てる）」を「（観点は docs/guidelines/review-lenses.md で選ぶ）」に改める。(3) 「公開前にはそこを設計レビューで見る」を「公開前にはそこをレビューで見る」に改める", "(1) は hook を消す決定。(2) は観点の選び方の正本を 1 つにする。(3) は「設計レビュー」が流れの段の名前になるので語を揃える（ツールの出力の語は次の PR）", "Q8 V3 Q4"),
    ("AGENTS.md Codex 固有: hook の行", "modify", "「.codex/hooks.json の PostToolUse hook … は編集のたびに make test を実行する。」の行を消す", "hook を消す決定", "Q8"),
    ("docs/guidelines/review-lenses.md", "create", "観点の正本。節: (1) 選び方: 観点は目的に応じて選び、目的に要らない観点を立てない。体数は規模に比例させる。規範の水準の設計レビュー（規範・規則の文を決める設計）の合格基準は「規範どうしの矛盾が無い・利用者の決定を満たす・根本原因を除いている」で、当てるのは norm（diff-verifier に「規範どうしの矛盾」「原因が除かれたか」を追加の観点として渡す）と decision（decision-verifier）の 2 体。本文ができた実装レビューでは、読み手（reader）・主張の裏付け（diff-verifier の不在・網羅の観点）を要る分だけ足す。(2) 観点の表: 観点・担い手・問い・当てる場面（目的への必要性 purpose-auditor・変更自体の必要性 alternatives-auditor・決定への適合と検証可能性と形式検証 decision-verifier・初見の読み手 reader・REVIEW.md の観点の全般と規範の整合と根本原因 diff-verifier。diff-verifier は ready の後に足した差分も持つ）。(3) 重大度: agent の指摘には severity-assigner が REVIEW.md「重大度」で付ける。(4) 返り値の形: 観点の agent は返り値の末尾に「指摘」の節（file:line・何が誤りか。重大度を付けない）を置く。(5) fan-out: model と effort の明示、閉集合の選択は小さい model、抽出役 1 体が行番号つきの束を 1 回作って配り各体は引用行だけを読む、共有部分を prompt の先頭に置く、上位 model には絞った差分・抜粋だけを渡す、絞る判断は閉集合からの選択にし本文の写しは script が逐語で行う、見なかったものを宣言し可能なら skip から無作為に抜いて偽陰性を測る。それぞれに理由を 1 行（実測を含む）。Workflow script での書き方は best-practices.md §3「model と effort は役割ごとに組で選ぶ」と §13「体数は測れる値から段階的に決める（作るスキル向けの設計指針）」。(6) Codex: .claude/agents の定義は Codex に読まれないので、呼ぶ側が本文を指示として渡す。model と effort は親を継承し (5) の明示の例外になる。読み取り専用は指示でしか担保できない。各規則に「検査:」の行を付ける", "どの段にどの観点を当てるかを 1 か所に置く（目的）。観点は目的に応じて選ぶ決定と、fan-out の正本をここに置く決定", "V1 V3 V4 V5 W1 Y2 AA3 BB2"),
    ("docs/guidelines/README.md", "modify", "文書表に review-lenses.md（観点の選び方・担い手・fan-out）を足す。5 行目は変えない（AGENTS.md の規範を写さず、AGENTS.md が指す細則を持つだけなので向きは保たれる）", "ガイドラインの一覧の正本に載せないと、REVIEW.md の「すべて」の行から辿れない", "P2"),
    ("REVIEW.md", "modify", "「重大度」の表に設計段の指摘を足す: HIGH に「目的・利用者の決定・承認済みの設計に反する決定」、MEDIUM に「目的に要らない要素・検証の手段が無い決定・読み手が複数に解釈できる指示」。他は変えない（読むものの表を変えないので tests/repo-review-workflow.test.mjs も変わらない）", "severity-assigner が設計段の指摘にも同じ 1 つの尺度で付けられるようにする", "Y2 W4"),
    (".claude/agents/purpose-auditor.md", "create", AGC, "目的に要るかの死角（目的の防ぐ失敗 2）", "BB2"),
    (".claude/agents/alternatives-auditor.md", "create", AGC, "変更自体が要るかの死角（目的の防ぐ失敗 2）", "BB2"),
    (".claude/agents/decision-verifier.md", "create", AGC + "。利用者の決定と目的を照らす正本にし、形式検証の模型の忠実さと結果、模型を書かない理由も見る", "規範の水準の設計レビューの decision の担い手。形式検証を見る担い手", "BB2 D3"),
    (".claude/agents/reader.md", "create", AGC, "本文ができた実装レビューで初見の読み手を模す担い手", "BB2"),
    (".claude/agents/severity-assigner.md", "create", "frontmatter（agents.tsv の行）。本文は入力・読まない入力とその理由・出力（受けた指摘と同じ数・順で CRITICAL / HIGH / MEDIUM / LOW の 1 つと当てた REVIEW.md の行。指摘を足さず消さず言い換えない）", "重大度を付ける専用の 1 体（指摘した者・作り手・司令塔と分ける）", "Y2"),
    (".claude/agents/diff-verifier.md", "modify（変更なし。確認の行）", "変えない。norm の担い手として追加の観点（規範どうしの矛盾・原因が除かれたか）を呼ぶ側から受ける。11 行目は、作業ルールの単一視点の行が review-lenses.md を指すので 1 段で届く", "役を変えない決定。norm-auditor を作らず既存の担い手を使う", "V3"),
    ("tests/review-lenses-agents.test.mjs", "create", "review-lenses.md の観点の表の担い手の列と .claude/agents/*.md の集合を照らす: 表の担い手（agent 名）は全て定義があり、定義のある agent は全て表か重大度の節に現れる。各定義の frontmatter に name・description・tools・model・effort がある（fan-out の明示の規則を定義の側で保つ）。make test の Node テスト（Makefile の REPO_NODE_TEST_FILES）に入る", "観点の一覧と定義の集合が 2 か所に分かれるので、ずれを注意書きでなく機械で止める", "P4"),
    (".codex/hooks.json", "delete", "ファイルごと消す（PostToolUse の make test と Stop の通知）", "Codex の hooks をいったん削除する決定", "Q8"),
    ("docs/guidelines/workflow.md", "作らない（判断の行）", "作らない", "規範は AGENTS.md の作業ルールの 4 行が正本で足りる。v6 の workflow.md の中身は WF-01〜22 の運用の細則で、規範の水準に戻す決定により次の PR でスキルの側に置く。作れば AGENTS.md と同じ規範の写しになり、照合のテストも要る", "BB1 D4"),
    (".claude/agents/builder.md", "作らない（判断の行）", "作らない", "作業ルールの 1 役割 1 責務の行が既に「生成は builder 役の agent へ dispatch」を規範として持ち、このリポジトリの builder の定義は repo-implement の implementer が持つ。新しい定義は流れを実行するスキルの改修（次の PR）でスキルとの接続と一緒に決める", "BB1"),
]
w("files.tsv", ["path", "action", "content_gist", "reason", "criteria"], F)

# ------------------------------------------------------------------ agents.tsv
RET = "末尾に「指摘」の節（review-lenses.md「返り値の形」）"
A = [
    ("purpose-auditor", "目的への必要性", "目的・対象（設計の決定の文か差分）", "設計の理由・過去のレビュー（設計の前提に引き寄せられる）", "要素ごとに keep / cut / shrink と対応する目的の文。" + RET, "opus・high", "Read, Grep, Glob"),
    ("alternatives-auditor", "変更自体の必要性", "目的・対象・既存の仕組みを探す範囲", "設計の理由", "無変更・削除・再利用・より小さい変更との比較と探した範囲。" + RET, "opus・high", "Read, Grep, Glob"),
    ("decision-verifier", "decision（利用者の決定と目的への適合・検証可能性・形式検証）", "利用者の決定・目的・対象・テストと形式検証の結果（模型を書かない理由を含む）", "目的への必要性の判断（purpose-auditor の担当）", "決定ごとに満たす / 満たさない / 検証不能、模型の忠実さと結果。" + RET, "opus・high", "Read, Grep, Glob"),
    ("reader", "初見の読み手での適用", "本文・利用場面", "規範の束・設計の理由・目的", "場面ごとの行動・迷う箇所・複数の解釈。" + RET, "sonnet・medium", "Read, Grep, Glob"),
    ("diff-verifier（既存。定義は変えない）", "norm（REVIEW.md の観点の全般・規範どうしの矛盾・根本原因・不在と網羅の断定）。ready の後の差分も持つ", "差分・テストの結果・追加の観点", "修正案", "file:line・誤り・重大度の並び（この並びを「指摘」の節として扱い、重大度の欄は振り分けに使わない）", "opus・high", "Read, Grep, Glob, WebFetch"),
    ("severity-assigner（新規）", "重大度の付与", "「指摘」の節の file:line と何が誤りか・REVIEW.md「重大度」", "指摘した側の重大度・指摘した agent の名前・設計の理由", "受けた指摘と同じ数・順で 4 値の 1 つと当てた行", "sonnet・medium（閉集合からの選択）", "Read, Grep, Glob"),
    ("make test（agent にしない）", "書式・参照・観点の表と定義の照合", "作業ツリー", "-", "合否", "none（script）", "-"),
]
w("agents.tsv", ["agent", "lenses", "input", "excluded_input", "output", "model", "tools"], A)

# ------------------------------------------------------------------ out-of-scope.tsv
NX = "流れを実行するスキル（repo-implement・address-review など）を改修する次の PR"
MAP = "AGENTS.md の地図化の PR"
OS = [
    ("out-of-scope", "運用の手順: v6 の rules.tsv の WF-01〜22（目的の固定の時点の draft PR・置き場の分け方・規模の判定の基準と確かめ・分類の基準と記録・受け箱と指摘の時点ごとの扱い・ready と bot の起こし方・数の照合・LOW の全件の記録・再開の扱い・trace の照合）", "BB1・v6", "規範の水準に戻す決定。入力として design-v6/rules.tsv・files.tsv・agents.tsv を指す", NX),
    ("out-of-scope", "流れの模型（flow-model-4 の Flow.tla・table.tsv・結果）と tests/formal/ への置き場・規則と模型の対応の照合のテスト", "BB1", "運用の規則と組で次の PR の入力にする。flow-model-4/ を指す", NX),
    ("out-of-scope", "builder の agent 定義・docs/guidelines/workflow.md・抜粋の照合のテスト", "BB1", "files.tsv の判断の行のとおり規範の水準では要らない", NX),
    ("out-of-scope", "既存スキルの上限つきの修正ループ・開始時の停止・prd-spec の Issue を新しい流れに揃えること、観点の agent と severity-assigner の組み込み", "Q1・BB1", "規範を先に入れ、スキルは次の PR", NX),
    ("out-of-scope", "quick_validate.py・evals.json の「設計レビュー」の語の揃え", "Q4", "スキルの改修と同じ PR", NX),
    ("out-of-scope", "AGENTS.md の約 100 行の地図化・節の移動・参照の付け替え・README と testing.md と manage-marketplace-plugin への移し替え", "AA1", "入力として design-v5/main-lines.tsv・refs.tsv・canon-inventory.tsv を指す", MAP),
    ("out-of-scope", "置き場の基準（placement.md）と placement-auditor・risk-auditor・claim の担い手", "BB2・AA1", "目的に要る観点だけを置く。置き場の物差しは地図化と組", MAP),
    ("out-of-scope", "Codex 用の agent 定義の生成", "W1", "呼ぶ側を組み込む PR", NX),
    ("out-of-scope", "best-practices.md §13 との食い違い", "W3", "best-practices を更新する", "best-practices の更新"),
    ("out-of-scope", "formal-methods スキルの未決の解消", "Q2", "手順の正本として参照するだけ", "design-v2h/later.tsv"),
    ("out-of-scope", "Codex の hook の再導入と検査の時機の設計", "Q6・Q8", "削除だけを行う", "後で見直す"),
    ("out-of-scope", "develop-skills-redesign.md の「止めない」の旧文の引用の照合", "later.tsv", "3 スキルの再設計で照らす", "design-v2h/later.tsv"),
]
w("out-of-scope.tsv", ["kind", "item", "source", "reason", "where_next"], OS)

# ------------------------------------------------------------------ limits.tsv
LM = [
    ("risk", "重大度の付け間違い: 真に MEDIUM の指摘が LOW と付くと直されずにマージに届きうる", "Z1", "受け入れる。PR 本文の LOW をマージの前に人が読んで拾う。読み落とせば届く"),
    ("risk", "見逃し: レビュー・bot・人が見逃した欠陥はマージに届く", "流れの模型の測定", "見なかったものとして載せる"),
    ("assumption", "往復が終わる前提: 修正が欠陥を持ち込むのは有限回・環境の失敗と誤分類は有限回・誤検出は有限回。外すと終わらない", "Z2・流れの模型の仮定", "回数の上限を置かない"),
    ("assumption", "作り手の環境の分類を読むレビュー役は誤分類を見落とさない。外すと作り手の検査の欠陥が残る", "Z2・流れの模型の仮定", "リスクとして載せる"),
    ("risk", "誤分類で止まる: 欠陥を除けない環境と分類すると要らない報告で止まる", "流れの模型の測定", "報告を読む利用者が分類を確かめる"),
    ("limit", "規範は入るが、流れを実行するスキルはまだ従っていない。次の PR まで、既存スキルの上限つきの修正ループや自分で直す手順と「欠陥は設計へ戻る」が食い違い、受け箱・bot の起こし方などの運用は決まっていない", "BB1・Q1", "優先の規則を書かない。次の PR で揃える"),
    ("limit", "流れの模型は規範の決定を検査したもので作業用の置き場にあり、この PR には入れない。規範の文と模型の対応は機械で照らしていない", "BB1", "次の PR で運用の規則と組で置く"),
    ("limit", "観点を目的に応じて選ぶ判断は選ぶ者に任され、立てなかった観点を照らす仕組みはまだ無い", "BB2", "次の PR で選び方の記録を決める"),
    ("limit", "Codex では観点の agent の model と effort が親を継承し、読み取り専用も指示でしか担保できない", "W1", "組み込みの PR で決める"),
    ("limit", ".codex/hooks.json を消すと Stop の通知（macOS の通知音）も消える", "Q8", "要るなら利用者の個人設定に置く"),
]
w("limits.tsv", ["kind", "item", "source", "handling"], LM)

# ------------------------------------------------------------------ decisions-map.tsv
WF = "AGENTS.md 作業ルール"
DM = [
    ("D1 流れを徹底し、欠陥は直接直さず設計に戻る", WF + "「流れ」「欠陥の扱い」の行", ""),
    ("D2 設計と設計レビューは根本原因の除去を規範とする", WF + "の根本原因の行に足す 1 文", ""),
    ("D3 形式検証を要求・仕様・実装の全てに", WF + "「形式検証」の行・1 役割 1 責務の行の検証の列挙", ""),
    ("D4 AGENTS.md には規範と理由だけ", "files.tsv の全ての AGENTS.md の行（手順を書かない）", ""),
    ("Q1 規範が先、スキルは別 PR", "out-of-scope.tsv", "次の PR"),
    ("Q2 形式検証の手順は formal-methods スキルを参照", WF + "「形式検証」の行の指し先", ""),
    ("Q3 段と形式検証は AGENTS.md に 1 文", WF + "「形式検証」の行（理由の括弧を除き 1 文）", ""),
    ("Q4 AGENTS.md の「設計レビュー」の 1 行だけ揃える", "AGENTS.md 検証の節の SKIP: の行", "ツールの語は次の PR"),
    ("Q5 作り手の検査の欠陥も設計に戻る", WF + "「欠陥の扱い」の行", ""),
    ("Q6 往復の原因は検査の時機", "out-of-scope.tsv（検査の時機）", "後で見直す"),
    ("Q7 hook の順序", "Q8 が置き換えた", ""),
    ("Q8 Codex の hooks を消す", ".codex/hooks.json の削除・AGENTS.md の hook の 2 行", ""),
    ("Q9 除けない失敗は報告して止める", WF + "の止まってよい場所の行", ""),
    ("Q10 除ける環境はやり直す（設計に戻らない）", WF + "の止まってよい場所の行", ""),
    ("V1 目的を確定", "review-lenses.md（段と観点を 1 か所に）・AGENTS.md の 4 行", "地図化は次の PR（BB1・AA1 で目的を狭めた）"),
    ("V2 節名を残す", "AGENTS.md の見出しを変えない", ""),
    ("V3 diff-verifier を残し ready 後の差分の役に", "review-lenses.md の表・AGENTS.md 検証の節の段落", ""),
    ("V4 Codex の agent の扱い", "review-lenses.md の Codex の節", "生成は次の PR（W1）"),
    ("V5 目的・生成後のレビュー・形式検証を AGENTS.md に。観点の中身は別ファイル", WF + "の 4 行・review-lenses.md", ""),
    ("W1 Codex の生成は組み込みの PR", "review-lenses.md の Codex の節・out-of-scope.tsv", "次の PR"),
    ("W3 best-practices §13 との食い違いを扱わない", "out-of-scope.tsv", ""),
    ("W4 MEDIUM 以上は設計へ、LOW は PR 本文で追わない、上限なし", WF + "「欠陥の扱い」の行・limits.tsv（上限なし）", ""),
    ("W5 免除せず規模に比例", WF + "「流れ」の行", "typo 級の具体は次の PR"),
    ("X1 置き場は規模で分ける", "-", "次の PR（運用）"),
    ("X2 マージが公開", WF + "の止まってよい場所の行", ""),
    ("X3 人の指摘は重大度を問わず直す", WF + "「欠陥の扱い」の行", ""),
    ("Y1 目的の固定で draft PR・出すは ready", "-", "次の PR（運用）"),
    ("Y2 重大度を付ける専用の agent", WF + "「欠陥の扱い」の行・.claude/agents/severity-assigner.md・review-lenses.md・REVIEW.md の重大度の表", ""),
    ("Y3 環境の判定の記録を次のレビューが見る", WF + "の生成と検証の分離の行（既存）", "記録の形は次の PR"),
    ("Y4 bot の重大度をそのまま使う", "-", "次の PR（運用）"),
    ("Z1 付け間違いをリスクとして受け入れる", "limits.tsv", ""),
    ("Z2 上限を置かず仮定とリスクを記録", "limits.tsv", ""),
    ("Z3 draft の間の指摘", "-", "次の PR（運用）"),
    ("導いた答え: ready の後に戻るとき draft に戻さない", "-", "次の PR（運用）"),
    ("導いた答え: 作り手の検査の失敗に重大度を付けない", WF + "「欠陥の扱い」の行", ""),
    ("導いた答え: 人の指摘に重大度を付けない", WF + "「欠陥の扱い」の行", ""),
    ("導いた答え: 目的と設計を書くのは builder 役の agent", WF + "の 1 役割 1 責務の行（既存）", ""),
    ("AA1 流れの規範に絞る", "BB1 が置き換えた（地図化は次の PR）", ""),
    ("AA2 ready のまま戻り bot を手で起こす", "-", "次の PR（運用）"),
    ("AA3 fan-out の正本は review-lenses.md", "review-lenses.md「fan-out」・" + WF + "の fan-out の 1 行", ""),
    ("AA4 ready の後の戻りの間の指摘", "-", "次の PR（運用）"),
    ("導いた答え: 指摘は来た時点を問わず次の振り分けに", "-", "次の PR（運用）"),
    ("BB1 規範の水準に戻す", "files.tsv 全体・out-of-scope.tsv", ""),
    ("BB2 観点は目的に応じて選ぶ・規範の水準の設計レビューは norm と decision の 2 体", "review-lenses.md「選び方」・" + WF + "の単一視点の行", ""),
]
w("decisions-map.tsv", ["decision", "where", "note"], DM)
print("ok")
