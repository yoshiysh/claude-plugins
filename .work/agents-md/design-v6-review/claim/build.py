import csv,re,sys
R='/Users/yoshi/github/yoshiysh/claude-plugins/.claude/worktrees/skill-update-generic-design-720616/'
rows=[
# ref, verdict, severity, reason, evidence_ref, evidence_quote
("refs.tsv:.agents/skills/repo-implement/scripts/plan.js:12|address-review/scripts/triage.js:12|repo-review/scripts/review.js:16","ng","低",
 "unsupported: 「変更なし（1 行に model と effort の明示と閉集合は小さい model が残る）」。3 つの参照が引くのは「判断する役は上位の model」の側で、現行の fan-out の行はそれを「最上位モデルは司令塔と統合判断だけに使う」と書く。files.tsv (7) の新しい 1 行はこの文を持たない（上位 model は「渡すものを絞る」の文脈にしか出ない）。この文は review-lenses.md (4) にだけ残るので、引き先は 1 段遠くなる。review.js の「機械的照合」の語も落ちる",
 ".agents/skills/repo-implement/scripts/plan.js:12","計画も計画の照合も判断なので、どちらも上位の model にする（AGENTS.md「作業ルール」）"),
("refs.tsv: 検索語（閉集合の作り方）","ng","低",
 "scoped 不足: 「94 件から、この PR が変える行を引く行を選んだ」としつつ、変える止まってよい場所の行を引く docs/design/develop-skills-redesign.md の :318・:342・:432 を載せていない（grep 'AGENTS.md' + 「止めない」で 3 件増える。:342 は旧文をそのまま現行の列に引く）。載せた :297 は out-of-scope.tsv の「旧文の引用の照合」に回しているので結論（直さない）は同じだが、閉集合の主張は偽",
 "docs/design/develop-skills-redesign.md:342","途中で止めず完了まで実行する。人間ゲート（マージ・公開）以外では止めない"),
("rules.tsv WF-19 の L24 / selfcheck.tsv「rules: model_transition が table.tsv の行と逐語で一致」","ng","低",
 "scoped 不足: L24（bot の run を待つ間の人の指摘）の次の状態は table.tsv 自身が「?」で、模型 4 の Flow.tla に対応する action も results.tsv の検査も無い。selfcheck の「一致」は「?」の行どうしの照合にすぎず、WF-19 の「bot の run を待つ間」の節は原則からの導出で、模型の結果の裏付けは無い。files.tsv は模型に足すと書くが、limits.tsv に「この節は導出で未検査」の行が無い。さらに flow-model-4/trace.tsv は WF-10（draft の間）と別の WF-19（ready の後の戻り）を持ち、WF 見出しが design-v6/rules.tsv と合わない",
 "flow-model-4/table.tsv:24","?（FQ1）"),
("selfcheck.tsv「AGENTS.md の行数の見込み」・limits.tsv「AGENTS.md の行数は main とほぼ同じ（約 216 行）」","ng","低",
 "unsupported な数: 計算は 235+3+1−19−4=216 だが、fan-out の 20 行を折り返さない 1 物理行として −19 と数える一方、追加の句は「各 0〜1 行」とし止まってよい場所だけ +1 と数える。AGENTS.md は 80 桁ほどで折り返す書式で、表示幅で数えると (7) の新しい行は約 5 行、(2) は 3 行、(3)(6) は各 2 行になり、見込みは 216 でなく 225 前後。「約」と「ほぼ同じ」の結論は保つが、数の根拠が書式と合わない",
 "AGENTS.md:70","- 途中で止めず完了まで実行する。人間ゲート（マージ・公開）以外では止めない。"),
("files.tsv tests/formal/workflow/","ng","低",
 "unsupported: 「模型は流れの模型 3 の版に、規模の判定の誤りを重大度なしで設計へ戻す遷移を足し、人・bot の指摘を…受け箱に入れる遷移を足して」。流れの模型 4 の Flow.tla は規模の誤判定（SjBudget・src=scale の指摘）も DraftHuman・DraftBot・ReworkHuman も WF-13 の Recount も既に持ち、足りないのは L24 だけ。模型 3 から始めると 4 の結果（results.tsv）を引き継げない。本文の gist に作業用の模型番号も入る（selfcheck の作業用の参照 0 件の検索式は D/Q/V/X/Y/Z・W・AA だけで、この「流れの模型 3/4」を数えない）",
 "flow-model-4/Flow.tla","SjBudget 規模の誤判定（id 0）"),
("limits.tsv「Codex では観点の agent の model と effort が親を継承し、読み取り専用も指示でしか担保できない」・review-lenses.md (5)","ng","低",
 "scoped 不足: 出所を「W1・codex の公式文書の確認」とするが、W1 の回答は「呼ぶ側を組み込む PR へ回す」で、公式文書を確かめた記録がどの設計ファイルにも無い。公式文書（learn.chatgpt.com の subagents。developers.openai.com/codex/subagents の転送先）を実際に読むと、model と effort は親を継承（設定が無いとき）、読み取り専用は指示で頼むだけ（sandbox_mode は上書きされない）は裏付く。「.claude/agents の定義は Codex に読まれない」は、文書が .codex/agents/ の TOML だけを載せ .claude/agents に触れない、という不在からの推論で、手段でスコープされていない",
 "design-review-1/answers.txt:W1","観点の agent を呼ぶ側を組み込む PR へ回す"),
("limits.tsv / rules.tsv WF-15「bot は opened・reopened・ready_for_review でだけ走る」・「bot は User の操作でだけ走る」","ok","低",
 "supported: caller の claude_review.yml に types と sender.type == 'User' と draft == false がある。scoped: 実際の review を行うのは固定 SHA の外部の再利用 workflow で、reopened で毎回走るかは本リポジトリから読めない（caller の発火条件までが裏付け）",
 ".github/workflows/claude_review.yml","types: [opened, reopened, ready_for_review]"),
("refs.tsv AGENTS.md:174・AGENTS.md:235・AGENTS.md:176 と hook の閉集合","ok","低",
 "supported: 3 行の位置と内容が原文と一致。grep 'hooks\\.json|\\.codex/hooks'（plugin 同梱の hooks/hooks.json を除く）の結果は AGENTS.md 2 行と skills-audit.md 2 行だけで refs.tsv と一致。.claude/settings.json・Makefile・tests・.codex/config.toml に参照は無い",
 "AGENTS.md:174","`make test` は `.codex/hooks.json` の PostToolUse hook（matcher `Edit|Write|MultiEdit`）からも呼ばれる。"),
("refs.tsv: diff-verifier.md:11・bp-inspection.md:268（docs と plugin 内の写し）・develop-skills-redesign.md:165/175/195/209/327・develop-plugin.md:344/374・docs/guidelines/README.md:5・skills-audit.md:574/586","ok","低",
 "supported: 全 referrer の行が実在し、引いている語が refs.tsv の説明どおり（195 の「行番号つきの束」は新しい 1 行に残らず review-lenses.md へ 1 段と、設計が自分で書いている）",
 "docs/design/develop-skills-redesign.md:195","AGENTS.md の、抽出役 1 体が行番号つきの束を 1 回作って配る規則に従う"),
("files.tsv AGENTS.md (1)〜(9) の「書き換える既存の文」と selfcheck.tsv「AGENTS.md: 書き換える既存の文が実在する」","ok","低",
 "supported: (1) の「ガイドラインを参照する」行（作業ルール見出しの次）、(2)(5)(9) の引用、(3)(4)(6)(7) の行頭、(8) の 2 行、すべて AGENTS.md に空白を除いて実在（独立に照合）。fan-out の行は 108〜127 行の 20 行。AGENTS.md は 235 行で main と同一",
 "AGENTS.md:52","コード・テスト・文書の変更では [ガイドライン](docs/guidelines/README.md) を参照する。"),
("rules.tsv の model_transition と selfcheck.tsv「table: 行が rules.tsv に現れる」","ok","低",
 "supported: rules.tsv の L 番号の指す state・event が flow-model-4/table.tsv の同じ行と一致し（24 行目の state 内の「・」で正規表現が 1 件外れたのは検査側の都合）、L2〜L25 に欠けが無い。WF は 01〜09・11〜22 の 21 個で WF-10 は欠番の記述と合う。ただし L24 の次の状態は上の行のとおり「?」",
 "flow-model-4/table.tsv:2","FixPurpose"),
("files.tsv REVIEW.md・docs/guidelines/README.md・limits.tsv の best-practices 参照（§3・§13 の見出し、REVIEW.md の文と節名）","ok","低",
 "supported: best-practices.md に「model と effort は役割ごとに組で選ぶ」(§3、160 行) と「体数は測れる値から段階的に決める（作るスキル向けの設計指針）」(774 行。§13 の 567〜843 行の中) が完全一致で実在。REVIEW.md に 2 つの書き換える文、「観点」「重大度」の節、README.md の 5 行目と文書表が実在。README の「検査:」の書式も実在",
 "plugins/skill-creator/skills/skill-creator-best-practices/references/best-practices.md","### 体数は測れる値から段階的に決める（作るスキル向けの設計指針）"),
("files.tsv tests/agents-md-excerpts.test.mjs・tests/workflow-flow-trace.test.mjs と「make test が拾う」","ok","低",
 "supported: Makefile の REPO_NODE_TEST_FILES が tests/ 以下の *.test.mjs を再帰で拾う。前例 tests/bp-criteria-copy.test.mjs・tests/develop-formal-trace.test.mjs・tests/formal/ が実在。scoped: 前例は run.sh の起動を mock で試し変異を patch --dry-run で照らすので「対応だけを見る」は言い過ぎだが、実 TLC を走らせない点は合う。AGENTS.md の節名（作業ルール・注意点・現在の実体）は tests/repo-review-workflow.test.mjs が読むので、節名を残す設計は合う",
 "Makefile","REPO_NODE_TEST_FILES := $(shell $(FIND) tests -type f -name '*.test.mjs' -print 2>/dev/null)"),
("files.tsv .codex/hooks.json delete と limits.tsv「Stop の通知（macOS の通知音）も消える」","ok","低",
 "supported: .codex/hooks.json は PostToolUse の make test と Stop の osascript・afplay 通知の 2 つだけ",
 ".codex/hooks.json","afplay -v 0.3 /System/Library/Sounds/Sosumi.aiff"),
("questions.tsv FQ1（回答済み）と rules.tsv WF-19 の「時点を問わない」","ok","低",
 "supported: AA4 と「導けた答え（模型 4 の FQ1）」が answers.txt にある。scoped: bot の run を待つ間の節は利用者の決定でなく導いた答え（模型の裏付けは上の L24 の行）",
 "design-review-1/answers.txt:AA4","draft の間と同じに扱う（その段のレビューの後の振り分けに加え、同じ規則で扱う）"),
("rules.tsv WF-01「typo 級は空の commit で branch を作って PR を開く」","ok","低",
 "scoped: 設計内に裏付けは無い。差分の無い branch では PR を開けない GitHub の仕様から空の commit が要る、という一般知識で、本リポジトリの実測は無い（実装時に gh で 1 回試せる）",
 "rules.tsv:WF-01","typo 級は空の commit で branch を作って PR を開く"),
]
import os
bad=0
out=open(os.path.dirname(os.path.abspath(__file__))+'/findings.tsv','w',newline='')
w=csv.writer(out,delimiter='\t',lineterminator='\n'); w.writerow(['ref','verdict','severity','reason','evidence_ref','evidence_quote'])
base={'AGENTS.md':R+'AGENTS.md','answers':R+'.work/agents-md/design-review-1/answers.txt'}
def path(e):
    e=e.split(':')[0] if not e.startswith('.github') else e
    for cand in (R+e, R+'.work/agents-md/'+e, R+'.work/agents-md/design-v6/'+e):
        if os.path.isfile(cand): return cand
for r in rows:
    ep=r[4]; p=None
    m=re.match(r'^(.*?\.(?:md|js|yml|json|tsv|txt|tla|mjs))(?::.*)?$',ep)
    f=m.group(1) if m else ep
    for cand in (R+f, R+'.work/agents-md/'+f, R+'.work/agents-md/design-v6/'+f, R+'.work/agents-md/design-v6/'+f.replace('rules.tsv','rules.tsv')):
        if os.path.isfile(cand): p=cand;break
    if not p: print('NOFILE',ep); bad+=1; continue
    t=re.sub(r'\s+','',open(p).read())
    if re.sub(r'\s+','',r[5]) not in t: print('QUOTE MISSING',ep,r[5][:40]); bad+=1
    w.writerow(r)
print('bad',bad)
