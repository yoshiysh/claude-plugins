from pathlib import Path

OUT = Path(__file__).resolve().parent
EXA = "作業の最初に、防ぐ失敗・達成すること・やらないことを書いて目的を固定し、以後の追加はレビューで求められたものも含めて目的に要るかで判定する（固定しないと、指摘のたびに要素が足されて作業が膨らむ）。"
EXB = "変更は規模を問わず「目的の固定 → 設計 → 設計レビュー → 実装 → 実装レビュー」を通し、設計などの文書も実装も段のレビューを通す。MEDIUM 以上の指摘と、重大度を付けない指摘（人の指摘・作り手の検査で見つかった欠陥・規模の判定の誤り）は成果物を直接直さずに設計へ戻し、agent と bot の LOW は直さず記録して追わない（直接直すと、欠陥を生んだ原因が設計に残り、同じ欠陥が形を変えて戻る）。"
EXC = "形式検証は要求・仕様・実装の全てに掛け、その段の生成者が模型を書いて走らせ、状態や決定の衝突が起きえない変更では模型を書かずに理由を 1 行書く（機械で確かめない分岐は、散文の読み違いとして誰にも見つからずに残る）。"
MA = "（正本: docs/guidelines/workflow.md）"
MW = "（抜粋: AGENTS.md）"
PLACE = "置き場（typo 級は draft PR の本文、それ以外は docs/design/changes/<slug>/）"
FM = "flow-model-4/table.tsv"


def w(name, header, rows):
    for r in rows:
        assert len(r) == len(header), (name, r[0][:30], len(r))
        for c in r:
            assert "\t" not in c and "\n" not in c, (name, r[0][:30])
    (OUT / name).write_text("\t".join(header) + "\n" + "".join("\t".join(r) + "\n" for r in rows), encoding="utf-8")


# ------------------------------------------------------------------ rules.tsv
R = [
    ("WF-01 目的の固定: 作り手が防ぐ失敗・達成すること・やらないことを書き、その時点で draft PR を作る（typo 級は空の commit で branch を作って PR を開く）。置き場は規模で決める", "docs/guidelines/workflow.md「WF-01」・AGENTS.md 抜粋 A", "L2 purpose・FixPurpose・-", "builder", "依頼・利用者の決定", "目的・draft PR・置き場", PLACE + " の purpose.md"),
    ("WF-02 規模の判定: typo 級は「差分が文言の誤り（誤字・脱字・リンク切れ）の訂正だけで、規則・挙動・構造を変えない変更」と定める（差分から観測できる基準）。作り手が判定し、設計レビューで decision-verifier が確かめる。判定の誤りは重大度を付けずに設計へ戻す", "docs/guidelines/workflow.md「WF-02」・.claude/agents/decision-verifier.md", "L2 purpose・FixPurpose・-（判定） / L13 dreview・Review・-（確かめる） / L16 dtriage・Triage・agent の指摘に 4 値の重大度（戻す。模型への追加が要る: questions.tsv の注記）", "builder（判定）・reviewer（decision-verifier）・orch（戻す）", "依頼・目的・差分", "規模の判定・判定の誤りの指摘・段の選択", PLACE + " の purpose.md と reviews/"),
    ("WF-03 設計の作業: 作り手が決定・理由・利用場面を別のファイルに書き、決定ごとに変更の種類（閉集合: 文言だけ・規則や挙動を変える・ファイルや仕組みや agent を足す・読み手が従う指示を変える）を宣言する。分岐を持つ規則には模型を書いて走らせる", "docs/guidelines/workflow.md「WF-03」", "L3 design・Work・chk=idle", "builder", "目的・前の振り分けの記録", "decisions.md・reasons.md・scenes.md・模型と結果", PLACE),
    ("WF-04 実装の作業: 作り手が設計レビューの振り分けを通った設計（これを承認済みとする）を実装する。要求・仕様の文書もこの段で書く。スキルの内部の検証は作り手の検査として扱い、段のレビューを別に通す", "docs/guidelines/workflow.md「WF-04」", "L4 impl・Work・chk=idle", "builder", "承認済みの設計", "差分・検査の結果", "PR の branch"),
    ("WF-05 作り手の検査: 作業中に走らせる検査（make test・その段の模型の実行）が落ちたら、その段の中で原因を分類する。模型の性質の破れも作り手の検査の失敗として扱う", "docs/guidelines/workflow.md「WF-05」", "L5 design|impl・SelfCheckFail・chk=idle", "builder", "検査の出力", "失敗の出力", "作り手の作業場所"),
    ("WF-06 分類と記録: 成果物を変えないと通らない失敗は欠陥、成果物を変えずに作り手が環境を直せば通る失敗は除ける環境、作り手には直せない環境の失敗は除けない環境と分類し、環境と判じたら分類と理由をその回の記録に書く", "docs/guidelines/workflow.md「WF-06」", "L6 design|impl・Classify・chk=fail", "builder", "失敗の出力", "分類と理由", PLACE + " の records/<段>-<回>.md"),
    ("WF-07 欠陥: 重大度を付けずに設計へ戻す", "docs/guidelines/workflow.md「WF-07」・AGENTS.md 抜粋 B", "L7 design|impl・HandleDefect・分類=欠陥", "orch", "作り手の分類", "段の選択（design）", PLACE + " の reviews/"),
    ("WF-08 除ける環境: 作り手が原因を除いて同じ検査をその場でやり直す", "docs/guidelines/workflow.md「WF-08」", "L8 design|impl・HandleEnvR・分類=除ける環境", "builder", "分類と記録", "やり直しの結果", "records/<段>-<回>.md"),
    ("WF-09 除けない環境: 司令塔が記録した分類と理由を利用者に報告して止まる。再開は利用者の答えを受けた新しい作業として目的の固定から始める", "docs/guidelines/workflow.md「WF-09」・AGENTS.md「作業ルール」の止まってよい場所", "L9 design|impl・HandleEnvU・分類=除けない環境", "orch", "records/ の分類と理由", "利用者への報告", "会話と records/"),
    ("WF-11 設計レビュー: 作り手と別の観点の agent が見る。立てる観点は宣言された変更の種類から review-lenses.md の表で機械的に引き、立てなかった観点と理由を記録する。decision-verifier はその回の records/ と前の振り分けの記録を読む", "docs/guidelines/workflow.md「WF-11」・docs/guidelines/review-lenses.md", "L13 dreview・Review・-", "reviewer（設計レビューの列の担い手。表は docs/guidelines/review-lenses.md）", "agent 定義の入力の欄のファイル", "返り値（review-lenses.md「返り値の形」）", PLACE + " の reviews/<段>-<回>/"),
    ("WF-12 実装レビュー: 承認済みの設計からの差分を見る。ready の後に足した差分も diff-verifier がこの段で見る", "docs/guidelines/workflow.md「WF-12」・docs/guidelines/review-lenses.md", "L14 ireview・Review・-", "reviewer（実装レビューの列の担い手。表は docs/guidelines/review-lenses.md）", "差分（承認の commit からの範囲）・検査と模型の結果・decisions.md・records/", "返り値", PLACE + " の reviews/<段>-<回>/"),
    ("WF-13 重大度: 返り値の「指摘」の節にだけ severity-assigner が REVIEW.md「重大度」で付ける。振り分けの前に、司令塔は指摘の数と重大度の数が一致し全てが 4 値のどれかであることを照らし、合わなければ同じ入力でやり直す（合うまで振り分けない）", "docs/guidelines/workflow.md「WF-13」・.claude/agents/severity-assigner.md", "L15 dtriage|itriage|ptriage|htriage・AssignSev・重大度の無い agent の指摘がある", "sevagent（severity-assigner）・orch（数の照合）", "「指摘」の節の file:line と何が誤りか・REVIEW.md「重大度」", "指摘ごとの重大度と当てた行", PLACE + " の reviews/<段>-<回>/"),
    ("WF-14 振り分け: 抜粋 B の規則で戻すか進むかを選ぶ。設計レビューを通れば実装へ。実装レビューを通れば PR を ready にする（PR を出すとは ready にすること）。ready の後に戻るときも draft に戻さない", "docs/guidelines/workflow.md「WF-14」・AGENTS.md 抜粋 B", "L16 dtriage・Triage・agent の指摘に 4 値の重大度 / L17 itriage・Triage・同上", "orch", "指摘・重大度・受け箱", "段の選択・PR の状態・LOW の記録", PLACE + " の reviews/ と PR"),
    ("WF-15 bot: 最初に ready にしたとき bot が走る。ready の後に戻って作り直し、実装レビューの振り分けを通ったら、司令塔が PR を close して reopen し bot を起こす（bot は opened・reopened・ready_for_review でだけ走る）。起こした run の完了を待ってから振り分ける。bot の重大度は REVIEW.md の語彙をそのまま使う", "docs/guidelines/workflow.md「WF-15」", "L18 wake・Wake・- / L19 prbot・BotReview・-", "orch（起こす・待つ）・bot", "ready の PR", "重大度つきの bot の指摘", "PR のコメント"),
    ("WF-16 bot の指摘の振り分け: 抜粋 B の規則で戻すか人間ゲートへ進むかを選ぶ", "docs/guidelines/workflow.md「WF-16」", "L20 ptriage・Triage・-", "orch", "bot の指摘と重大度", "段の選択・LOW の記録", PLACE + " の reviews/"),
    ("WF-17 人間ゲート: 人は PR 本文が指す LOW の全件と範囲と限界を読み、指摘するかマージする。マージが公開", "docs/guidelines/workflow.md「WF-17」", "L21 gate・HumanComment・未修正の欠陥がある（PR 本文の LOW を含む: Z1） / L22 gate・HumanMerge・-", "human", "PR（本文と、本文が指す reviews/）", "指摘かマージ", "PR"),
    ("WF-18 人の指摘: 重大度を付けずに設計へ戻す", "docs/guidelines/workflow.md「WF-18」・AGENTS.md 抜粋 B", "L23 htriage・Triage・-", "orch", "人の指摘", "段の選択（design）", PLACE + " の reviews/"),
    ("WF-19 人・bot の指摘: 来た時点（PR が draft の間・ready の後に設計へ戻った間・bot の run を待つ間）を問わず受け箱に入れ、次の振り分けに加えて同じ規則で扱う（時点ごとの条項を置かない）", "docs/guidelines/workflow.md「WF-19」", "L10 design〜itriage（PR が draft）・DraftHuman・PR が draft / L11 design〜itriage（PR が draft）・DraftBot・PR が draft / L12 design〜itriage（ready の後の戻り）・ReworkHuman・PR が ready / L24 wake|prbot|ptriage（ready・bot の run の間）・人の指摘・?（導いた原則で埋める）", "orch（受け箱に写す）", "PR のコメント", "受け箱の指摘", PLACE + " の reviews/ の受け箱"),
    ("WF-20 終わり: マージか除けない環境の報告で終わる", "AGENTS.md「作業ルール」の止まってよい場所", "L25 merged|reported・Done・-", "-", "-", "-", "-"),
    ("WF-21 LOW と範囲と限界の記録: agent と bot の LOW は reviews/ に全件を残し（typo 級は PR 本文に全件）、PR 本文はそこを指す。PR 本文の範囲と限界に、模型の仮定と残るリスクと見なかったものを書く", "docs/guidelines/workflow.md「WF-21」", "L16 dtriage・Triage・agent の指摘に 4 値の重大度 / L20 ptriage・Triage・-（LOW の行き先）。範囲と限界の記録は模型の外", "orch（逐語の保存）・builder（範囲と限界）", "振り分けの記録・模型の README", "LOW の全件・PR 本文の節", "reviews/ と PR 本文"),
    ("WF-22 形式検証の契約: 模型は tests/formal/<name>/ に置き、README に性質ごとの範囲と残りと仮定を書く。規則と模型の action の対応を trace.tsv に書き、テストが両方向で照らす。設計段で模型を走らせ、破れが残れば実装へ進まない（作り手の検査の失敗）", "docs/guidelines/workflow.md「WF-22」・tests/workflow-flow-trace.test.mjs", "L5 design|impl・SelfCheckFail・chk=idle（模型の実行は作り手の検査の中身）", "builder（書いて走らせる）・reviewer（decision-verifier）・script（make test の対応の照合）", "模型・規則", "結果・宣言・対応の照合", "tests/formal/<name>/"),
    ("観点の選び方と返り値の形と fan-out の細則は review-lenses.md の 1 か所に置く", "docs/guidelines/review-lenses.md", "模型の外: 模型は reviewer を 1 つの担い手に畳む", "orch", "宣言された変更の種類", "立てる agent・立てない理由", PLACE + " の reviews/"),
    ("止まってよい場所（既存の行を書き換える）: 人間ゲート（マージ）と、除けない環境の報告だけ", "AGENTS.md「作業ルール」", "L9 design|impl・HandleEnvU・分類=除けない環境 / L22 gate・HumanMerge・- / L25 merged|reported・Done・-", "orch", "段の状態", "止まるか進むかの選択", "会話"),
    ("司令塔の役（既存の行のまま）: 段の選択・relay・機械的なコピーだけ", "AGENTS.md「作業ルール」（変えない）", "L7 design|impl・HandleDefect・分類=欠陥 / L9 design|impl・HandleEnvU・分類=除けない環境 / L16 dtriage・Triage・agent の指摘に 4 値の重大度 / L17 itriage・Triage・同上 / L20 ptriage・Triage・- / L23 htriage・Triage・-", "orch", "返り値", "段の選択と逐語の保存", PLACE + " の reviews/"),
    ("生成と検証の分離（既存の行のまま）", "AGENTS.md「作業ルール」（変えない）", "L13 dreview・Review・- / L14 ireview・Review・- / L15 dtriage|itriage|ptriage|htriage・AssignSev・重大度の無い agent の指摘がある", "reviewer・sevagent", "成果物と records/", "返り値と重大度", PLACE + " の reviews/"),
    ("根本原因（既存の行に 1 句足す）: 設計と設計レビューもこの規範に従い、レビューは原因が除かれたかを見る", "AGENTS.md「作業ルール」", "模型の外: 内容の判定で遷移を変えない", "builder・reviewer", "指摘と設計", "原因を除いた設計", PLACE),
    ("同じ値を 2 箇所に書かない（既存の行に 1 句足す）: 写しが要るときは機械で一致を照らす", "AGENTS.md「作業ルール」・REVIEW.md「観点」", "模型の外: 文書の規則", "builder・reviewer", "変更", "正本と照合のテスト", "make test"),
    ("抜粋の一致を make test で照らす", "tests/agents-md-excerpts.test.mjs", "模型の外: 写しの照合", "script（make test）", "AGENTS.md・docs/guidelines/workflow.md", "合否", "make test"),
    ("fan-out の規則（既存の行を 1 行に縮める）: 規則 1 行・理由・指し先", "AGENTS.md「作業ルール」・docs/guidelines/review-lenses.md「fan-out」", "模型の外: 費用の規則", "orch", "agent の一覧", "model と effort の指定", "agent の呼び出し"),
    ("検証は単一視点にしない（既存の行を書き換える）: 観点と体数は規模に比例させ review-lenses.md で選ぶ", "AGENTS.md「作業ルール」・REVIEW.md「観点」", "L13 dreview・Review・- / L14 ireview・Review・-（体数）", "orch", "宣言された変更の種類と規模", "立てる agent", PLACE + " の reviews/"),
    ("Codex の hook を消す", ".codex/hooks.json・AGENTS.md", "模型の外: 検査の時機は目的の外", "builder", "-", "-", "-"),
]
w("rules.tsv", ["rule", "file", "model_transition", "actor", "input", "output", "place"], R)

# ------------------------------------------------------------------ agents.tsv
RET = "返り値は review-lenses.md「返り値の形」に従う（定義に形を写さない）"
A = [
    ("builder（新規）", "-（生成）", "段・目的・承認済みの設計（実装段）・前の振り分けの記録・作業の置き場のパス", "レビューの返り値の重大度（直すのは指摘の原因で、重大度に合わせない）", "その段の成果物・records/<段>-<回>.md・検査と模型の結果。レビューと採点をしない", "opus・high（生成）", "Read, Grep, Glob, Edit, Write, Bash"),
    ("purpose-auditor", "目的への必要性", "目的・decisions.md（実装段は差分）", "reasons.md・前の回の reviews/", "要素ごとに keep / cut / shrink と対応する目的の文。" + RET, "opus・high", "Read, Grep, Glob"),
    ("alternatives-auditor", "変更自体の必要性", "目的・decisions.md（実装段は差分）・既存の仕組みを探す範囲", "reasons.md", "無変更・削除・再利用・より小さい変更との比較と探した範囲。" + RET, "opus・high", "Read, Grep, Glob"),
    ("risk-auditor", "費用対効果・設計段の失敗時の振る舞い", "decisions.md・目的の「達成すること」（比べる相手）。実装段は差分とテストの結果", "reasons.md", "悪化する性質と程度、達成することとの比較、fail-open の経路と数え方。" + RET, "opus・high", "Read, Grep, Glob"),
    ("decision-verifier", "決定への適合・検証可能性・形式検証・作り手の記録・規模の判定・前の振り分け", "照らす正本（設計段は目的と利用者の決定、実装段は decisions.md）・対象・検査と模型の結果（tests/formal/<name>/ の README と trace.tsv）・その回の records/・前の回の振り分けの記録", "目的への必要性の判断", "決定ごとの満たす / 満たさない / 検証不能、模型の忠実さと宣言、前の振り分けが抜粋 B の規則どおりか。" + RET + "。別の節に「作り手の検査の指摘」と「規模の判定の誤り」を置く（どちらも重大度を付けない）", "opus・high", "Read, Grep, Glob"),
    ("reader", "初見の読み手での適用", "本文・scenes.md", "規範の束・reasons.md・目的", "場面ごとの行動・迷う箇所・複数の解釈。" + RET, "sonnet・medium", "Read, Grep, Glob"),
    ("diff-verifier（既存。定義は変えない）", "REVIEW.md の観点の全般と原因が除かれたか（両段。ready の後の差分を含む）", "差分・テストの結果・追加の観点", "修正案", "file:line・誤り・重大度の並び（この並びを「指摘」の節として扱い、重大度の欄は振り分けに使わない）", "opus・high", "Read, Grep, Glob, WebFetch"),
    ("severity-assigner（新規）", "重大度の付与", "返り値の「指摘」の節の file:line と何が誤りか（呼ぶ側は節と列を選ぶだけ）・REVIEW.md「重大度」", "指摘した側の重大度・指摘した agent の名前・reasons.md", "受けた指摘と同じ数・同じ順で CRITICAL / HIGH / MEDIUM / LOW の 1 つと当てた行。指摘を足さず消さず言い換えない", "sonnet・medium（閉集合からの選択）", "Read, Grep, Glob"),
    ("make test（agent にしない）", "書式・参照・抜粋と模型の対応の照合", "作業ツリー", "-", "合否", "none（script）", "-"),
]
w("agents.tsv", ["agent", "lenses", "input", "excluded_input", "output", "model", "tools"], A)

# ------------------------------------------------------------------ files.tsv
AGC = "frontmatter に name・description・tools・model・effort（agents.tsv の行）。本文は観点の問い・入力・読まない入力とその理由・出力。返り値の形と段の条件は書かず review-lenses.md を指す。結果はファイルに書かず返り値で返す"
F = [
    ("（全ファイル共通）", "-", "本文に作業用の参照（利用者の回答の番号・作業用ディレクトリのパス・模型の性質の番号）を書かない。規則には守られないと何が壊れるかを 1 行で添える。docs/guidelines/ の新しい文書の規則には「検査:」の行を付ける", "作業用の参照は本文に写ると辿れない", "P3"),
    ("AGENTS.md", "modify", "既存の行はほぼそのまま残し、次だけを変える（見込み 約 216 行）。(1) 作業ルールの見出しの次の「ガイドラインを参照する」行の後に、抜粋 3 行を逐語で置き、末尾に印「" + MA + "」を付ける。A: 「" + EXA + "」 B: 「" + EXB + "」 C: 「" + EXC + "」。(2) 止まってよい場所の行（「途中で止めず完了まで実行する。人間ゲート（マージ・公開）以外では止めない。」）を「途中で止めず完了まで実行する。止まってよいのは人間ゲート（マージ。マージが公開に当たる）と、作り手の検査の失敗のうち作り手には除けないものを、記録した分類と理由とともに利用者へ報告するときだけ。」に改める。(3) 検証は単一視点にしない行の 1 文目の後に「どの段にどの観点を何体当てるかは変更の規模に比例させ、docs/guidelines/review-lenses.md で選ぶ。」を足す。(4) 同じ値を 2 箇所に書かない行の 1 文目の後に「写しが要るときは、機械で一致を照らす。」を足す。(5) 1 役割 1 責務の行の「検証は決定的テスト + 生成者と別の fresh 監査 + PR レビュー（人間）が持つ」を「検証は決定的テスト + 形式検証 + 生成者と別の fresh なレビュー + PR レビュー（人間）が持つ」に改める。(6) 根本原因の行の 1 文目の後に「設計と設計レビューもこの規範に従い、レビューは指摘が消えたかでなく原因が除かれたかを見る。」を足す。(7) fan-out の 20 行を 1 行にする: 「agent を fan-out するときは agent ごとに model と effort を明示し、閉集合からの選択は小さい model に任せ、同じ対象は抽出を 1 回にして配り、共有部分を prompt の先頭に置き、上位 model へ渡すものは絞る（実測: model を省いた監査の workflow は最上位 model を継承し、5 時間のレート制限の窓を約 3 分で使い切った）。細則と理由は docs/guidelines/review-lenses.md「fan-out」。」(8) 検証の節の「make test は .codex/hooks.json の … hook からも呼ばれる。」の行と、Codex 固有の節の「.codex/hooks.json の … hook は編集のたびに make test を実行する。」の行を消す。(9) 検証の節の ready の後の差分の段落の括弧「（観点を分けるかは差分の大きさと種類で呼び出し側が決め、分けるときは検証役を観点ごとに立てる）」を「（観点と体数は docs/guidelines/review-lenses.md で選ぶ）」に改める。ほかの行は変えない", "抜粋は利用者の決定で入口に置く 3 つ。(2)〜(9) は新しい規範と重複・矛盾する既存の行だけ。(7) は fan-out の正本を review-lenses.md に移す決定。(7) の 1 行は外の参照が引く語（model と effort・閉集合は小さい model・抽出を 1 回・prompt の先頭・上位 model へ絞る・実測）を残し、参照を直さずに済ませる", "P1 P3"),
    ("docs/guidelines/workflow.md", "create", "作業の流れの正本。規則ごとに見出し「WF-nn 名前」を置き、本文と「検査:」の行を付ける。各規則は rules.tsv の WF-01〜WF-22 の rule の欄の内容（WF-10 は欠番。draft の間の指摘は WF-19 の 1 つの規則に含める）。WF-19 は指摘が来た時点を問わない 1 つの規則で、時点ごとの条項を置かない。抜粋 A を WF-01 に、B を WF-14 に、C を WF-22 に逐語で置き、末尾に印「" + MW + "」を付ける。戻すか進むかの閾値は抜粋 B の行だけに書き、WF-07・WF-16・WF-18 は抜粋 B を指す（言い直さない）。司令塔の役は AGENTS.md「作業ルール」を指し、言い直さない。置き場: typo 級は draft PR の本文の節、それ以外は docs/design/changes/<slug>/ に purpose.md・decisions.md・reasons.md・scenes.md（読み手が従う指示を変えない変更では、そう 1 行書く）・records/<段>-<回>.md・reviews/<段>-<回>/（観点ごとの返り値・重大度・立てなかった観点と理由・受け箱・振り分け）を置き、PR 本文がこのパスを指す。回を分けるのは、観点の agent に前の回を渡さないため。置かないもの: 観点・返り値の形・fan-out（review-lenses.md）、止まってよい場所・司令塔・根本原因（AGENTS.md）", "抜粋の正本で、模型の遷移を規則として持つ。規則と模型の action の対応は trace.tsv が持ちテストが照らす", "P3 P5"),
    ("docs/guidelines/review-lenses.md", "create", "観点の立て方の正本。節: (1) 表: 観点・担い手・設計レビュー・実装レビュー。条件は宣言された変更の種類（文言だけ・規則や挙動を変える・ファイルや仕組みや agent を足す・読み手が従う指示を変える）から機械的に引ける形で書く。purpose-auditor（両段。実装は差分が設計より大きいとき）・alternatives-auditor（足す種類があるとき）・risk-auditor（足す種類があるとき。実装 no）・decision-verifier（両段 yes）・reader（読み手が従う指示を変える種類があるとき）・diff-verifier（両段 yes。設計は設計のファイルの差分）・severity-assigner（指摘の節があるとき）・make test（両段）。typo 級は各段 decision-verifier 1 体。立てなかった観点と理由を reviews/ に記録する。(2) 返り値の形: 観点の agent は返り値の末尾に「指摘」の節（file:line・何が誤りか。重大度を付けない）を置く。decision-verifier はさらに「作り手の検査の指摘」「規模の判定の誤り」の節を置く。節が無い・形が崩れた返り値は、同じ入力でその agent をやり直す（振り分けに進めない）。(3) 入力の渡し方: 呼ぶ側は agent 定義の入力の欄のパスを渡す。typo 級は PR 本文を逐語で渡す。(4) fan-out: agent ごとに model と effort を明示する（省くと最上位 model × 体数を消費する）。閉集合からの選択は小さい model と低い effort に任せ、最上位 model は統合判断だけに使う。同じ対象を多数の agent が読むときは抽出役 1 体が行番号つきの束を 1 回作って配り、各体は引用行だけを読み直す。共有部分を prompt の先頭に置いて cache を効かせる。上位 model には絞った差分・抜粋・対象だけを渡す（全量は入力の上限を単発で超える）。絞る判断は閉集合からの選択にし、本文の写しは script が正本から逐語で行う（要約させると写しが drift し捏造が混じる）。見なかったもの（除外・skip・fail-open）を宣言し、可能なら skip から無作為に抜いて読み偽陰性を測る。実測: model を省いた ad-hoc の監査は 60 体が最上位 model を継承して同じ 10 ファイルを冷読みし、5 時間の窓を約 3 分で使い切った。Workflow script での書き方は best-practices.md §3「model と effort は役割ごとに組で選ぶ」と §13「体数は測れる値から段階的に決める（作るスキル向けの設計指針）」。(5) Codex: .claude/agents の定義は Codex に読まれないので、呼ぶ側が本文を指示として渡して立てる。model と effort は親を継承し、(4) の明示の例外になる。読み取り専用は指示でしか担保できない", "観点の選び方・返り値の形・fan-out の正本を 1 か所に置く", "P2 P5 P7"),
    ("docs/guidelines/README.md", "modify", "(1) 文書表に workflow.md・review-lenses.md を足す。(2) 5 行目を「作業の流れとレビューの観点は workflow.md・review-lenses.md が正本で、AGENTS.md はその抜粋と指し先を持つ。それ以外の AGENTS.md の作業ルールと配布の制約はここに写さない。…（以下同じ）」に改める", "正本の向きを書いた文と表を、新しい 2 文書に合わせる", "P2"),
    ("REVIEW.md", "modify", "(1) 観点「役割分担と正本の一意性」の「同じ値・列挙・上限が 2 箇所に書かれていないか」を「同じ値・列挙・上限が、機械で一致を照らさずに 2 箇所に書かれていないか」に改める。(2) 観点「生成と検証の分離」の「単一視点だけの検証になっていないか」の後に「（観点と体数は docs/guidelines/review-lenses.md で規模に比例させる）」を足す。(3) 「重大度」の表に設計段の指摘を足す: HIGH に「目的・利用者の決定・承認済みの設計に反する決定」、MEDIUM に「目的に要らない要素・検証の手段が無い決定・読み手が複数に解釈できる指示」。「読むもの」の表は変えない", "重大度の尺度を両段で 1 つにする。抜粋の写しと typo 級の 1 体が既存の観点と食い違わないようにする", "P4"),
    ("tests/agents-md-excerpts.test.mjs", "create", "AGENTS.md の印「" + MA + "」で終わる行と workflow.md の印「" + MW + "」で終わる行を取り出し、行頭の「- 」と印だけを除き、他は正規化せずに比べる。両方ちょうど 3 行で、文の集合が完全に一致する（両方向）。3 はこのテストの中だけに書く", "受け入れた写しを機械で保つ。前例は tests/bp-criteria-copy.test.mjs", "P4"),
    ("tests/formal/workflow/", "create", "流れの模型の置き場。Flow.tla・設定・README.md・trace.tsv。模型は流れの模型 3 の版に、規模の判定の誤りを重大度なしで設計へ戻す遷移を足し、人・bot の指摘を来た時点を問わず受け箱に入れて次の振り分けに加える遷移（流れの模型 4 の未定の行を含む）を足して、設計段で TLC を走らせる。注釈は workflow.md の WF の見出しで引く（利用者の回答の番号を書かない）。README に性質ごとの性質・前提と範囲・確かめられない残り・仮定（修正が欠陥を持ち込むのは有限回・環境の失敗と誤分類は有限回・記録を読んだレビュー役は誤分類を見落とさない・誤検出は有限回）と、走らせた版と結果を書く。trace.tsv は模型の action と WF の見出しの対応で、模型の外の WF は理由つきでそう書く", "形式検証の規範を自分の規則に当て、規則と遷移の対応を機械で照らせる形で残す。tests/formal/ に既存の模型の置き場がある", "P4"),
    ("tests/workflow-flow-trace.test.mjs", "create", "tests/formal/workflow/trace.tsv を読み、(1) Flow.tla の NonDone の action が全て trace.tsv にある、(2) trace.tsv の WF の見出しが全て workflow.md にある、(3) workflow.md の WF の見出しが全て trace.tsv にある（模型の外を含む）ことを照らす。TLC は走らせない（前例 tests/develop-formal-trace.test.mjs と同じく対応だけを見る）", "規則と模型の 1 対 1 を注意書きでなく機械で保つ", "P4"),
    (".claude/agents/builder.md", "create", AGC + "。成果物を書き、作り手の検査を走らせ、分類と理由を records/ に書く。レビューと採点をしない", "流れの担い手 builder の定義が無いと、誰が目的と設計を書くかが割れる", "P7"),
    (".claude/agents/purpose-auditor.md", "create", AGC, "目的への必要性の死角", "P7"),
    (".claude/agents/alternatives-auditor.md", "create", AGC, "変更自体の必要性の死角", "P7"),
    (".claude/agents/risk-auditor.md", "create", AGC + "。比べる相手は目的の達成すること", "費用対効果の死角", "P7"),
    (".claude/agents/decision-verifier.md", "create", AGC + "。形式検証・records/・規模の判定・前の振り分けを見る", "形式検証・作り手の分類・規模の判定・振り分けの記録を見る担い手", "P7"),
    (".claude/agents/reader.md", "create", AGC, "初見の読み手の死角", "P7"),
    (".claude/agents/severity-assigner.md", "create", "frontmatter（agents.tsv の行）。本文は入力・読まない入力とその理由・出力（受けた指摘と同じ数・順で 4 値の 1 つと当てた REVIEW.md の行）。「指摘」の節は持たない", "重大度を付ける専用の 1 体", "P7"),
    (".codex/hooks.json", "delete", "ファイルごと消す（PostToolUse の make test と Stop の通知）", "Codex の hooks をいったん削除する決定", "Q8"),
]
w("files.tsv", ["path", "action", "content_gist", "reason", "criteria"], F)

# ------------------------------------------------------------------ refs.tsv
RF = [
    ("AGENTS.md:174", "make test は .codex/hooks.json の hook から呼ばれる", ".codex/hooks.json", "消える（hook を消す）"),
    ("AGENTS.md:235", ".codex/hooks.json の hook は make test を実行する", ".codex/hooks.json", "消える（hook を消す）"),
    ("AGENTS.md:176", "ready の後の差分の検証役。観点を分けるかは呼び出し側", "AGENTS.md の同じ行", "AGENTS.md（同じ行の括弧を review-lenses.md を指す形に改める）"),
    (".claude/agents/diff-verifier.md:11", "観点の分け方は AGENTS.md の規則に従い呼び出し側が決める", "AGENTS.md「作業ルール」の単一視点の行", "変更なし（その行が review-lenses.md を指し、1 段で届く）"),
    (".agents/skills/repo-implement/scripts/plan.js:12", "計画は上位の model にする（AGENTS.md「作業ルール」）", "作業ルールの fan-out の行", "変更なし（1 行に model と effort の明示と閉集合は小さい model が残る）"),
    (".agents/skills/repo-review/scripts/review.js:16", "運搬役は小さい model（AGENTS.md「作業ルール」）", "同上", "変更なし（同上）"),
    (".agents/skills/address-review/scripts/triage.js:12", "分類は上位の model（AGENTS.md「作業ルール」）", "同上", "変更なし（同上）"),
    ("docs/specifications/bp-inspection.md:268", "prompt の先頭を揃えて cache を効かせる：AGENTS.md の作業ルール", "同上", "変更なし（1 行に「共有部分を prompt の先頭に置く」が残る）"),
    ("plugins/skill-creator/skills/skill-creator-best-practices/references/criteria/specifications/bp-inspection.md:268", "同上（写し）", "同上", "変更なし（同上。写しを変えると再配布が要る）"),
    ("docs/design/develop-skills-redesign.md:165", "AGENTS.md の実測（model を省いた監査がレート制限を使い切った）", "作業ルールの fan-out の行の実測", "変更なし（1 行の理由に実測が残る）"),
    ("docs/design/develop-skills-redesign.md:175", "閉集合からの選択は小さいモデルに任せる AGENTS.md の規則", "同上", "変更なし（1 行に残る）"),
    ("docs/design/develop-skills-redesign.md:195", "抽出役 1 体が束を配る AGENTS.md の規則", "同上", "変更なし（1 行に「抽出を 1 回にして配る」が残り、行番号つきの束の細則は review-lenses.md へ 1 段）"),
    ("docs/design/develop-skills-redesign.md:209", "上位モデルへ渡すものを絞る AGENTS.md の規則", "同上", "変更なし（1 行に残る）"),
    ("docs/design/develop-skills-redesign.md:327", "同上", "同上", "変更なし（同上）"),
    ("docs/design/develop-plugin.md:374", "model・effort の根拠が AGENTS.md を指す（指摘の記録）", "同上", "変更なし（過去の記録）"),
    ("docs/design/develop-skills-redesign.md:297", "AGENTS.md の「止めない」の旧文の引用", "作業ルールの止まってよい場所の行（文が変わる）", "変更なし（旧文の引用。照合は out-of-scope.tsv の行）"),
    ("docs/design/develop-plugin.md:344", "Issue 化で完了を先送りしない（AGENTS.md「作業ルール」）", "止まってよい場所の行の次の行", "変更なし（その行は変えない）"),
    ("docs/guidelines/README.md:5", "AGENTS.md の作業ルールと配布の制約はここに写さない", "正本の向き", "docs/guidelines/README.md（5 行目を改める）"),
    ("skills-audit.md:574", ".codex/hooks.json に make test hook がある（過去の監査）", ".codex/hooks.json", "変更なし（時点の記録）"),
    ("skills-audit.md:586", "同上", ".codex/hooks.json", "変更なし（同上）"),
    ("検索語（閉集合の作り方）", "grep -rnIE 'AGENTS\\.md' --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.work . の 94 件（設計 v5 の refs.tsv が全件を起こした）から、この PR が変える行（作業ルールの止まってよい場所・単一視点・DRY・1 役割 1 責務・根本原因・fan-out の行、検証の節の hook と ready の後の段落、Codex 固有の hook の行）を引く行を選んだ。hook は grep -rnIE 'hooks\\.json|\\.codex/hooks' から plugin 同梱の hooks/hooks.json を除いた", "判定: 変わる行の語を引く参照は、その語が残るか 1 段で届けば変えない", "直す参照は docs/guidelines/README.md:5 と AGENTS.md 自身の 3 行（174・235 は消え、176 は改める）"),
]
w("refs.tsv", ["referrer", "ref", "old_target", "new_target"], RF)

# ------------------------------------------------------------------ out-of-scope.tsv
NX = "次の PR（材料: design-v5/main-lines.tsv・refs.tsv・canon-inventory.tsv）"
OS = [
    ("out-of-scope", "AGENTS.md の約 100 行の地図化・節の移動と削除（インストール・注意点・Claude Code 固有・Codex 固有）・規範の置き場の節", "AA1", "流れの規範だけに絞る", NX),
    ("out-of-scope", "外の参照の付け替え（REVIEW.md の読むものの表・tests/repo-review-workflow.test.mjs の期待値・develop-plugin.md・docs/specifications の参照）", "AA1・束 G12・G14", "地図化と組で行う", NX),
    ("out-of-scope", "README.md・docs/guidelines/testing.md・manage-marketplace-plugin への移し替え（Codex の install・Worktree の設定・個別スキルの検証コマンド・SKIP:・テストの置き場）", "AA1・束 G13", "地図化と組で行う", NX),
    ("out-of-scope", "置き場の基準（docs/guidelines/placement.md）と placement-auditor", "AA1", "置き場の基準は地図化の物差しで、地図化と組で行う", NX),
    ("out-of-scope", "配布の規則の正本の 1 本化・正本と写しの向きの表どうしの照合（公開済み script の例外と §13、テストの置き場、REVIEW.md:3）", "束 G8・G9", "地図化で節を動かすときに決める", NX),
    ("out-of-scope", "規範の書き方の低自由度の例外・L2 の検査の限界の持ち主", "束 G13", "既存の行を動かさないので行き先の確かめも次の PR", NX),
    ("out-of-scope", "既存スキル（repo-implement・address-review・build_skill.js・pr-review-fix・prd-spec.js・review-document）の修正ループと開始時の停止・prd-spec の Issue を新しい流れに接続すること", "Q1・AA1・束 G16", "新しい流れで次の PR として行う", "次の PR"),
    ("out-of-scope", "観点の agent と severity-assigner を既存のスキルや Workflow に組み込むこと・Codex 用の agent 定義の生成", "AA1・W1", "定義と対応表を置くまで", "次の PR"),
    ("out-of-scope", "best-practices.md §13 のスコープの梯子との食い違い", "W3", "best-practices を更新する", "best-practices の更新"),
    ("out-of-scope", "formal-methods スキルの未決の解消", "Q2", "手順の正本として参照するだけ", "design-v2h/later.tsv"),
    ("out-of-scope", "quick_validate.py・evals.json の語の揃え", "Q4", "スキルの改修と同じ別 PR", "次の PR"),
    ("out-of-scope", "Codex の hook の再導入と検査の時機の設計", "Q8", "削除だけを行う", "後で見直す"),
    ("out-of-scope", "develop-skills-redesign.md の「止めない」の旧文の引用の照合", "later.tsv", "3 スキルの再設計に入るときに照らす", "design-v2h/later.tsv"),
    ("out-of-scope", "この変更自身の目的・設計を docs/design/changes/ へ移すこと（模型は tests/formal/workflow/ に置く）", "この設計", "目的は流れを規範にすることで、作業用の成果物を移すことは要らない。模型だけは形式検証の規範の適用として置く", "利用者（作業用ディレクトリの扱いを含む）"),
    ("cut", "norm-auditor・evidence-packer・claim-checker", "v4・v5 の束", "diff-verifier と作り手が 1 回作る置き場のファイルで足りる", "-"),
    ("cut", "作り手の検査の指摘・人の指摘・規模の判定の誤りへの重大度の付与", "流れの模型の検証・束 G15", "LOW として残すと合否ゲートで再び落ちるか、利用者の決定（置き場）に反したまま残る", "-"),
    ("cut", "ready の後に戻るとき draft に戻すこと", "AA2", "draft に戻さず bot を手で起こす", "-"),
]
w("out-of-scope.tsv", ["kind", "item", "source", "reason", "where_next"], OS)

# ------------------------------------------------------------------ limits.tsv
LM = [
    ("risk", "付け間違い: 真に MEDIUM の指摘が LOW と付くと直されずにマージに届きうる", "Z1・模型 decided_I1", "人がマージの前に reviews/ の LOW の全件を読んで拾う。bot の LOW は bot の出力が件数しか出さない分を読めない"),
    ("risk", "見逃し: レビュー・bot・人が見逃した真の MEDIUM はマージに届く", "模型 decided_I4", "見なかったものとして載せる"),
    ("risk", "誤分類で止まる: 欠陥を除けない環境と分類すると要らない報告で止まる", "模型 decided_I2", "報告を読む利用者が分類を確かめる"),
    ("assumption", "往復が終わる前提: 修正が欠陥を持ち込むのは有限回・環境の失敗は有限回・誤分類は有限回・誤検出は有限回。外すと終わらない", "Z2・模型 assume_F1off・F2off・F5off・F8off", "回数の上限を置かない"),
    ("assumption", "記録を読んだレビュー役は誤分類を見落とさない。外すと作り手の検査の欠陥が ready まで残る", "Z2・模型 assume_F6off_P8", "リスクとして載せる"),
    ("limit", "模型の結果は有限の定数での欠陥の証拠で、証明ではない。make test は TLC を走らせず、規則と action の対応だけを照らす", "Flow.tla・tests/develop-formal-trace.test.mjs の前例", "README に走らせた版と結果を書く"),
    ("limit", "bot を起こすのは PR の close と reopen で、利用者として操作する必要がある（bot は User の操作でだけ走る）。close の間は PR が閉じて見える", ".github/workflows/claude_review.yml", "そのまま載せる"),
    ("limit", "担い手が走れない（レート制限など）間は段を進めず待ってやり直す。作り手の検査の失敗ではないので報告して止まる経路は模型に無い", "束 G4", "そのまま載せる"),
    ("limit", "観点の agent が読まない入力はファイルとパスの選択で外すが、Read を持つので読もうとすれば読める", "v5 の束 V5", "そのまま載せる"),
    ("limit", "Codex では観点の agent の model と effort が親を継承し、読み取り専用も指示でしか担保できない", "W1・codex の公式文書の確認", "組み込みの PR で決める"),
    ("limit", "既存スキルの上限つきの修正ループと「欠陥は設計へ戻る」が、接続の PR まで食い違う", "Q1・AA1", "優先の規則を書かない"),
    ("limit", ".codex/hooks.json を消すと Stop の通知（macOS の通知音）も消える", "Q8・束 G20", "要るなら利用者の個人設定に置く"),
    ("limit", "AGENTS.md の行数は main とほぼ同じ（約 216 行）で、入口の重さは次の PR まで残る", "AA1", "そのまま載せる"),
]
w("limits.tsv", ["kind", "item", "source", "handling"], LM)

# ------------------------------------------------------------------ questions.tsv
Q = [
    ("FQ1（回答済み: 利用者の回答 AA4 で (a)。WF-19 に置いた）", "ready の後に設計へ戻って作り直している間（PR は ready のまま）に来た人・bot の指摘をどう扱うか。draft の間の指摘は「その段のレビューの後の振り分けに加える」と決まったが、ready の後の戻りの間はその外にある。bot は push では走らないので来るのは主に人の指摘", "(a) draft の間と同じに、その段のレビューの後の振り分けに加える / (b) 次の人間ゲートまで待たせる", "(a)。PR の状態に依らず作業中の指摘を 1 つの規則で扱え、人の指摘を作り直しの結果に取り込める。反対側: 作り直しの途中の段に人の指摘が混ざり、往復が長くなりうる", "WF-19・流れの模型 3 の table.tsv L22"),
    ("（注記）", "規模の判定の誤りの指摘は重大度を付けずに設計へ戻す（集約で導いた）。模型 3 の決定どおりの版にこの遷移は無く、v5 版で破れを示しただけなので、tests/formal/workflow/ の模型に足して走らせる", "-", "-", "WF-02・束 G15"),
]
w("questions.tsv", ["qid", "question", "options", "recommend", "affects"], Q)

# ------------------------------------------------------------------ checks-for-impl.tsv
CK = [
    ("抜粋の 3 行が両文書で逐語一致し、C が 1 文か", "AGENTS.md・workflow.md", "テストの実行と目視"),
    ("書き換える既存の行が設計の引用と逐語で一致する位置にあり、ほかの行が変わっていないか", "AGENTS.md", "git diff を読む"),
    ("本文に作業用の参照が無いか（模型の注釈を含む）", "全ての create・modify", "grep"),
    ("新しい docs/guidelines/ の文書の規則に「検査:」の行と 1 行の理由があるか", "workflow.md・review-lenses.md", "diff-verifier・reader"),
    ("workflow.md の WF の見出しと trace.tsv が一致するか", "workflow.md・tests/formal/workflow/trace.tsv", "tests/workflow-flow-trace.test.mjs"),
    ("記号（WF 以外の番号・束の名前）が本文に残っていないか", "全ての create・modify", "grep"),
]
w("checks-for-impl.tsv", ["check", "target", "how"], CK)
print("ok")
