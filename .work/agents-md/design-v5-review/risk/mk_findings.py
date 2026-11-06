import re, pathlib, sys
R = pathlib.Path('/Users/yoshi/github/yoshiysh/claude-plugins/.claude/worktrees/skill-update-generic-design-720616')
W = R/'.work/agents-md'
D = W/'design-v5'
rows = [
("files.tsv docs/guidelines/workflow.md (5)・(7)／rules.tsv 「PR 本文の範囲と限界」", "ng", "高",
 "Z1 で受け入れたリスクの唯一の歯止めは「PR 本文の LOW の一覧をマージの前に人が読む」こと（limits.tsv の risk 行）。ところが設計は LOW の一覧に REVIEW.md の上限（1 回のレビューで 5 件、超過分は件数だけ）を当てるので、上限を超えた LOW は本文に載らず人が読めない。付け間違えた MEDIUM が超過分に入ると、読み落としではなく読む手段が無いまま merge に届く（Z1 の受け入れ範囲の外）。上限が「1 回のレビュー」ごとか PR 本文全体かも決まっていない。数え方: 非 typo の最小構成で 1 周に観点の agent は設計 3・実装 2 の 5 体（review-lenses.md の yes 列）、往復の上限は無いので、LOW が 5 件を超えるのは常態になりうる。severity-assigner が付けた LOW は件数でなく全件を載せる（または別ファイルに全件を置き本文から指す）のどちらかに決める必要がある",
 "design-v5/files.tsv:13（REVIEW.md:58 の上限、design-v5/limits.tsv:2 の Z1 の扱い）",
 "agent と bot の LOW は直さず PR 本文に載せて追わない（REVIEW.md の LOW の件数の上限を超えた分は件数を載せる）"),
("files.tsv docs/guidelines/workflow.md (5)「ready の後に設計へ戻るときも draft に戻さず」／rules.tsv 実装レビューの振り分け・bot のレビュー", "ng", "高",
 "bot（.github/workflows/claude_review.yml）が走るのは opened・reopened・ready_for_review の時だけで、push（synchronize）では走らない。また draft の間は走らない（draft == false の条件）。設計は ready の後に設計へ戻っても draft に戻さないので、作り直しの後は ready_for_review のイベントが起きず、規則「ready の後は bot のレビューと振り分けを経て人間ゲートへ進む」の bot のレビューが来ない。司令塔は来ない bot を待って止まるか（止まってよい場所に無い）、bot 無しで人間ゲートへ進むか（fail-open）で振る舞いが割れる。さらに作り直しの間も PR は ready のままで、未レビューの途中の差分が merge 可能な状態に見え、作り直し中であることを人へ示す手段が無い。この「draft に戻さない」は利用者の決定ではなく導いた答え（answers.txt の Z の後の「導けるので問いにしなかったもの」）で、その根拠は diff-verifier の役が空になることだけで、bot の発火条件を比べていない",
 ".github/workflows/claude_review.yml:5",
 "types: [opened, reopened, ready_for_review]"),
("rules.tsv 「重大度」／agents.tsv severity-assigner・diff-verifier（既存）", "ng", "中",
 "振り分けは「指摘」の節を呼ぶ側が選び、severity-assigner の値だけで決める。しかし (a) 観点の agent が節を出さない・形が崩れる、(b) severity-assigner が指摘を落とす・4 値の外を返す、の時の扱いが規則に無い。節が無ければ指摘 0 件、値が無ければ MEDIUM 以上でない、と読めて次の段へ進む（fail-open）。模型の Triage の guard「bot 以外の全ての指摘に重大度」は規則の文（rules.tsv の重大度・設計レビューの振り分けの行）に写っておらず、入った指摘の数と重大度の付いた数の照合を誰がするかも無い。diff-verifier は定義を変えないので出力に「指摘」の見出しが無く（diff-verifier.md の出力節は問題を並べ、問題の無かった観点の行も混ぜる）、どの行が指摘かを呼ぶ側が判断することになり「節と列を選ぶだけ」が成り立たない。形が崩れた時・件数が合わない時は設計に戻すか同じ agent を再度立てる、のどちらかに fail-closed で決める必要がある",
 "design-v5/rules.tsv:13（.claude/agents/diff-verifier.md の「## 出力」）",
 "呼ぶ側はその節の file:line と何が誤りかの欄だけを渡す（節と列を選ぶだけで、どれを指摘にするかを決めない）"),
("files.tsv AGENTS.md 節「作業ルール」(7)／rules.tsv 「止まってよい場所」", "ng", "中",
 "止まってよい場所は人間ゲートと「作り手の検査の失敗のうち除けないもの」の報告だけ。レビュー役・severity-assigner が走れない失敗（レート制限・timeout・agent の起動の失敗）は作り手の検査ではないので分類と報告の経路に乗らない。司令塔は止まれず（規則違反）、レビューを飛ばして進めば未検証の成果物が次の段へ届く（fail-open）、待ち続ければ終わらない。レート制限は main の AGENTS.md が実測として挙げる失敗（60 agent が 5 時間の窓を約 3 分で使い切った）で、この設計は 1 周に最大で設計 8 体・実装 6 体（review-lenses.md の行を数えた。うち opus・high は agents.tsv で 6 種）を立てるので起きうる。レビューの担い手の失敗も「除けない環境」と同じく分類と理由を記録して報告して止まる、とするか、レビューを通らずには次の段へ進めない（fail-closed）と明記するかが要る",
 "design-v5/files.tsv:8",
 "止まってよいのは人間ゲート（マージ）と、作り手の検査の失敗のうち作り手が自分では除けないものを、記録した分類と理由とともに利用者へ報告するときだけ"),
("files.tsv docs/guidelines/review-lenses.md「体数」・表の条件の列", "ng", "中",
 "条件つきの観点（alternatives・placement・risk・reader、実装段の purpose「実装が設計より大きくなったとき」）を立てるかを誰が判定するかが書かれていない。rules.tsv「観点の異なる検証」は actor を orch とするが、条件の判定は決定や差分の中身を読む判断で、司令塔の「内容の採点をしない」と衝突し、外れたら観点が黙って立たない。立てなかった観点とその理由を記録する規則も、その判定を誰かが確かめる規則も無いので、立てなかった観点が「問題なし」に化ける（fail-open）。設計に戻った後の再レビューでも同じ選択が毎周起き、変えたものの再検証が選択に含まれる（作業ルール (11) が避ける形）。判定がつかない時は立てる（fail-closed）とし、立てなかった観点と条件の判定を reviews/ に記録して decision-verifier が見る、のように決める必要がある",
 "design-v5/files.tsv:14",
 "体数: 条件に当たる観点だけを立て、固定の全員を当てない。"),
("files.tsv docs/guidelines/review-lenses.md「Codex での立て方の 1 行」／rules.tsv 「Codex での検証役の立て方」", "ng", "中",
 "作業ルール (12) は「agent ごとに model と effort を明示」を正本とするが、review-lenses.md の Codex の 1 行は model を親から継承させる。どちらが勝つかが書かれていないので、Codex で (12) を守ろうとする読み手と 1 行に従う読み手で割れる。従った場合の費用: 1 周に最大 14 体（設計 8・実装 6）が親の model で走り、agents.tsv が sonnet・medium を当てた reader と severity-assigner（閉集合の選択）も上位 model になる。(12) が理由に挙げる「最上位 model × 体数」の消費をそのまま生む。W1 は生成を後の PR へ回したが、この 1 行は今の PR で入る。(12) の例外であることと費用を範囲と限界に載せるか、Codex では model を指定できる手段（Codex の agent 設定）を確かめてから書く必要がある",
 "design-v5/files.tsv:14",
 "model は親を継承する（Claude の model 名は Codex に渡せない）"),
("limits.tsv 「設計の時点で模型が走っているのは…」の行", "ng", "中",
 "抜粋 C（形式検証は「その段の生成者が模型を書いて走らせ」る）を自分で引きながら、「走らせないまま実装へ進むなら、このずれを PR 本文に載せる」という出口を残している。これは模型を走らせずに実装へ進むことを PR 本文への記載で許す fail-open の経路で、#207 が入れる規範（D3・抜粋 C）に #207 自身が最初の例外を作る。重大度を agent の指摘に限ること・ready の後も draft に戻さないこと・draft の間の指摘を振り分けに加えることは、まさに上の 2 件の ng（bot が来ない・形の崩れ）に関わる遷移で、模型に入っていない。出口を消し、走らせて結果で行を書き直すことを実装の前提条件にする必要がある",
 "design-v5/limits.tsv:10",
 "走らせないまま実装へ進むなら、このずれを PR 本文に載せる"),
("files.tsv .codex/hooks.json（delete）／limits.tsv の hook の行", "ok", "-",
 "Codex で編集のたびに make test が走る唯一の自動の検査が消え、作り手が自分で走らせない限り合否ゲートは PR の CI まで遅れる（fail-open 寄りの悪化）。ただし Q8 の決定どおりで、通知音の hook も消えることは limits.tsv に載っている。検査の時機の設計は out-of-scope に送られている",
 "design-v5/limits.tsv:15", ".codex/hooks.json を消すと、Stop の通知（macOS の通知音）の hook も消える"),
("files.tsv tests/agents-md-excerpts.test.mjs", "ok", "-",
 "両方向でちょうど 3 行と文の集合の一致を照らし、片方の削除・印の除去・両方の印の除去（0 行で 3 に届かない）のどれでも落ちる fail-closed。Makefile:25 の REPO_NODE_TEST_FILES が tests/*.test.mjs を拾うので make test に乗る",
 "design-v5/files.tsv:22", "両方がちょうど 3 行で、除いた後の文の集合が完全に一致することを照らす（両方向。片方を削っても、印を外しても落ちる）"),
("out-of-scope.tsv cut「作り手の検査の指摘に重大度を付けて LOW を PR 本文に載せる経路」", "ok", "-",
 "作り手の検査の失敗を全て設計へ戻すのは fail-closed で、合否ゲートで同じ欠陥が再び落ちる循環（flow-model-2-verify/assumptions.tsv の最終行の反例）を構造で除いている。費用は戻りの回数だが Z2 で上限を置かないことは受け入れ済み",
 "design-v5/out-of-scope.tsv:17", "直さない欠陥は合否ゲートで再び落ち、往復が終わらない。全て設計へ戻す"),
("limits.tsv 「誤分類で止まる」", "ok", "-",
 "除けない環境への誤分類は止まる側（fail-closed）に倒れ、欠陥が merge に届く方向ではない。費用は要らない報告 1 回で、利用者が分類を確かめる。逆向き（欠陥を除ける環境と誤分類して覆う）は F5・F6 として Z2 で受け入れ済み",
 "design-v5/limits.tsv:7", "欠陥はマージに届かない。報告を読む利用者が分類を確かめる"),
("limits.tsv 「重大度の付け間違い」・往復の仮定の 3 行", "ok", "-",
 "Z1・Z2 で利用者が受け入れたリスクで、仮定とリスクを PR 本文の範囲と限界に載せる扱いは決定どおり（Z1 の歯止めが LOW の上限で崩れる点は別の ng 行）",
 "design-v5/limits.tsv:2", "受け入れる。PR 本文の LOW の一覧をマージの前に人が読むことで拾い、人の指摘は重大度を問わず設計へ戻る。読み落とせば届く"),
("rules.tsv 「人の指摘の振り分け」／out-of-scope.tsv cut「人の指摘への重大度の付与」", "ok", "-",
 "人の指摘は重大度を問わず設計へ戻る fail-closed で、agent の呼び出しを 1 回省ける。X3 に沿う",
 "design-v5/rules.tsv:20", "重大度を付けずに、重大度を問わず設計へ戻す"),
("rules.tsv 「typo 級の定義」", "ok", "-",
 "作り手の規模の判定で体数が 1 体に減るが、その 1 体（decision-verifier）が判定の当否を確かめ、外れなら指摘として設計へ戻る。誤判定は戻りに倒れる。typo 級の費用は各段 opus・high 1 体で W5 の比例の決定どおり",
 "design-v5/rules.tsv:3", "作り手の判定は、設計レビューで decision-verifier が当たるかを確かめ、外れていれば指摘として出す"),
("limits.tsv 「観点の agent が読まない入力」／「diff-verifier は定義を変えないので自分でも重大度を出す」", "ok", "-",
 "入力の除外が読み取りの禁止でないこと、diff-verifier の重大度が使われず捨てられることは、どちらも黙らずに限界として宣言されている。費用は diff-verifier の出力の一部が無駄になるだけ",
 "design-v5/limits.tsv:12", "外し方は渡すパスの選択までで、読み取りの禁止ではない"),
("limits.tsv 「スキルの改修までの間…食い違う」", "ok", "-",
 "間の期間に repo-implement の上限つきの修正ループが新しい規則と食い違うことは Q1 の決定（規範を先、スキルは直後の別 PR）で受け入れられ、限界として載っている",
 "design-v5/limits.tsv:14", "改修は直後の別 PR。優先の規則を書かない"),
("files.tsv 全体（費用対効果）", "ok", "-",
 "数えた費用: AGENTS.md 235 行→見込み約 72 行、新しい agent 定義 7 本（files.tsv の .claude/agents/ の create 行）、新しい docs/guidelines/ 3 本、テスト 1 本。1 周のレビューは非 typo の最小で設計 3 体＋severity・実装 2 体＋severity、最大で設計 8・実装 6（review-lenses.md の行）。目的の「多角的なレビュー観点を agent として定義する」「AGENTS.md を約 100 行の地図にする」に直接対応し、typo 級は 1 体に縮むので、上の ng（失敗時の扱い）を除けば費用は達成することに見合う",
 "design-v3/purpose.txt", "多角的なレビュー観点を agent として定義する。"),
]
def norm(s): return re.sub(r'\s+','',s)
srcmap = {
 'design-v5/files.tsv': D/'files.tsv','design-v5/rules.tsv': D/'rules.tsv','design-v5/limits.tsv': D/'limits.tsv',
 'design-v5/out-of-scope.tsv': D/'out-of-scope.tsv','.github/workflows/claude_review.yml': R/'.github/workflows/claude_review.yml',
 'design-v3/purpose.txt': W/'design-v3/purpose.txt'}
bad=0
for r in rows:
    key = r[4].split(':')[0]
    txt = srcmap[key].read_text()
    if norm(r[5]) not in norm(txt):
        print('QUOTE MISS', r[0], key); bad+=1
out = pathlib.Path(__file__).parent/'findings.tsv'
with out.open('w') as f:
    f.write('ref\tverdict\tseverity\treason\tevidence_ref\tevidence_quote\n')
    for r in rows:
        assert all('\t' not in c and '\n' not in c for c in r)
        f.write('\t'.join(r)+'\n')
print('rows', len(rows), 'ng', sum(r[1]=='ng' for r in rows), 'bad', bad)
