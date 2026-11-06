import sys
R=sys.argv[1]
V='.work/agents-md/design-v5-review/views/'
F=V+'files.decisions.tsv'; M=V+'main-lines.decisions.tsv'; C=V+'canon-inventory.decisions.tsv'
PC='.work/agents-md/design-v3/placement-criteria.tsv'
MMP='.agents/skills/manage-marketplace-plugin/SKILL.md'
BP='plugins/skill-creator/skills/skill-creator-best-practices/references/best-practices.md'
rows=[]
def r(ref,v,s,reason,ev,q): rows.append((ref,v,s,reason,ev,q))
# ---- files ----
r('files.tsv:（全ファイル共通の書き方）','ok','-','作業用の参照を本文に置かず PR 本文・commit へ回す。置き場の振り分けとして P3 に合う',F+':2','本文に、設計の作業用の参照（利用者の回答の番号・main の行番号・作業用ディレクトリのパス・模型の性質の番号）を書かない')
r('files.tsv:AGENTS.md（全体）','ok','-','人の install は README（P8）、道具別の節は消す（P12）、重複は消す（P9）。節の構成は置く基準に合う。消える節への外部参照は REVIEW.md:13・14・21、tests/repo-review-workflow.test.mjs:592、develop-plugin.md:201 で、grep（注意点|「インストール」|Claude Code 固有|Codex 固有|plugin 間でスキルは共有できない、.git・node_modules・.work を除く）で見た範囲では全て refs に行がある',F+':3','「インストール」「注意点」「Claude Code 固有」「Codex 固有」の 4 節を消す')
r('files.tsv:AGENTS.md 節「冒頭」','ok','-','置き場の基準の正本は placement.md 1 つで、AGENTS.md は指し先の 1 行（P2）',F+':4','規則を足すときは docs/guidelines/placement.md の基準で置き場を決める')
r('files.tsv:AGENTS.md 節「リポジトリ概要」','ok','-','毎回踏む前提（P1）。正本は AGENTS.md',F+':5','逐語のまま')
r('files.tsv:AGENTS.md 節「現在の実体」(1)(2)(4)(5)','ok','-','実体の置き場・find -L・公開名の得方は毎回踏む（P1）。2 段の規則は §13 を指し写さない（P2）。テストの置き場を testing.md へ出すのは P5 に合う（REVIEW.md:12・13 の Workflow script・テストの行が testing.md を読ませる）',F+':6','2 段の規則は best-practices.md §13「script の置き場」')
r('files.tsv:AGENTS.md 節「現在の実体」(3)','ng','中','別 plugin のスキルの使い方を「この規則の正本はこの行」とするが、manage-marketplace-plugin SKILL.md の不変条件「本体は単一ソース」「plugin 間依存は宣言と呼び出しで解く」が同じ規則を本文で持ち続ける（files.tsv の同スキルの行は変更なし）。canon-inventory の同スキルの行は main L23〜37（L29-31 を含む）の詳細の正本をスキル側とし、設計の中でも正本の宣言が 2 通りある。照合の検査は無く、作業ルール (14) の「正本を 1 つにして他は参照」と同時に満たせない。AGENTS.md を規則の正本にするならスキルの不変条件は AGENTS.md を指す形に、スキルを正本にするなら AGENTS.md の行から「正本はこの行」を外して指し先にする',MMP+':184','**plugin 間依存は宣言と呼び出しで解く**：別 plugin のスキルが必要な場合は')
r('files.tsv:AGENTS.md 節「現在の実体」の下位の節「実体が plugins/ 側にある理由」','ok','-','見出しは develop-plugin.md:49・bp-run.md:487 から節名で参照されるので残す（P10）。中身は 1 文の理由と、機序の正本（manage-marketplace-plugin の不変条件）への指し先（P2・P3）',F+':7','機序の詳細は .agents/skills/manage-marketplace-plugin/SKILL.md「設計上の不変条件（守るべきルール）」')
r('files.tsv:AGENTS.md 節「作業ルール」抜粋 A・B・C','ok','-','正本は workflow.md、AGENTS.md は写し。利用者の決定 V5 が重複を許し、写しは tests/agents-md-excerpts.test.mjs が両方向で照らす（作業ルール (14) の「写しが要るときは機械で一致を照らす」を満たす）',F+':8','抜粋 3 行を逐語で置き、各行の末尾に印「（正本: docs/guidelines/workflow.md）」を付ける')
r('files.tsv:AGENTS.md 節「作業ルール」(1)','ng','低','公開済みの Workflow script を plugins/<plugin>/workflows/ で直接編集する例外は best-practices.md §13:704 が既に規則として持つ。canon-inventory の §13 の行は「AGENTS.md の公開済み script の直接編集の例外はここを指す」とするが、files.tsv の (1) は規則を本文で書き、§13 を指さない。写しか指し先かを canon-inventory に揃える',BP+':704','公開後の script は plugin の `workflows/` を直接編集する（スキルのディレクトリからは届かない）')
r('files.tsv:AGENTS.md 節「作業ルール」(2)(3)(4)(5)(6)(8)(9)(15)','ok','-','どれも題材を問わず作業の最初から振る舞いを変える規則と 1 行の理由（P1・P3）。(3) の理由は下位の節を指し写さない。(4) の手順はスキルを指す（P6）',F+':8','plugins/ 配下に symlink を作らない（理由は「実体が plugins/ 側にある理由」）')
r('files.tsv:AGENTS.md 節「作業ルール」(7)(11)(13)(14)','ok','-','止まってよい場所・司令塔・根本原因・正本の一意性の正本を AGENTS.md に置き、workflow.md は置かないものとして明示し指す。根本原因の機序は best-practices §1 を指し写さない（P3）',F+':13','止まってよい場所の本文と根本原因の規範（AGENTS.md）')
r('files.tsv:AGENTS.md 節「作業ルール」(10)','ok','-','P7 のとおり、AGENTS.md は検証を観点の異なる agent で行う規則と review-lenses.md への指し先だけ。diff-verifier.md:11 も 1 段で届く',F+':8','どの段にどの観点を何体当てるかは変更の規模に比例させて docs/guidelines/review-lenses.md で選ぶ')
r('files.tsv:AGENTS.md 節「作業ルール」(12)','ng','中','fan-out の model・effort・evidence pack・入力の絞り方は multi-agent の作業でだけ要る題材の規範で、P1 は出典欄でこの種の規則を AGENTS.md に置かない例として挙げ、P5 は docs/guidelines/ の題材別の文書を正本にするとする。設計は「この規則の正本はこの行」と AGENTS.md を正本にしている。P10 は理由にならない（参照元は節名「作業ルール」を指すので、規則を docs/guidelines/ へ移し作業ルールに指し先 1 行を残せば参照は 1 段で解決する）。新しい文書の cut（束 B1）との取り合いなので questions.tsv に問いを立てた',PC+':2','作業ルールの箇条の多くが fan-out workflow など題材の限られる規則')
r('files.tsv:AGENTS.md 節「規範の置き場」','ok','-','場面から正本を引く指し先だけで中身を写さない（P2）。ガイドラインの一覧の正本は docs/guidelines/README.md の表と明示している',F+':9','コード・テスト・文書を書く → docs/guidelines/README.md（ガイドラインの一覧の正本）')
r('files.tsv:AGENTS.md 節「検証」','ok','-','入口の make だけを残し、個別コマンドと SKIP: は testing.md、hook は消す、ready 後の段落は review-lenses.md（P4・P5・P7）',F+':10','個別スキルの検証コマンドと quick_validate.py の SKIP: の読み方は docs/guidelines/testing.md')
r('files.tsv:AGENTS.md 節「言語」','ok','-','毎回踏む（P1）',F+':11','ユーザーへの返答は日本語で行う')
r('files.tsv:AGENTS.md 節「インストール」「注意点」「Claude Code 固有」「Codex 固有」','ok','-','行き先は main-lines の各行で決まり、README（P8）・スキル（P6）・runner の文書（P9）・testing.md（P5）に分かれる',F+':12','4 節を消す。中身は README.md・manage-marketplace-plugin・runner の文書・「現在の実体」・testing.md へ移すか消す')
r('files.tsv:docs/guidelines/workflow.md（全体）','ok','-','作業の流れの正本を docs/guidelines/ に置くので、REVIEW.md の「すべて」の行と repo-implement の plan.js:200 の docs/guidelines/ の読み込みから届く（P5）。観点の中身と止まってよい場所を置かないものとして明示',F+':13','置かないもの: 観点の中身（review-lenses.md と agent 定義）')
r('files.tsv:docs/guidelines/workflow.md (2)','ng','中','司令塔の役（段を選び返り値を relay するだけ）を言い換えて本文に書き、括弧で正本を AGENTS.md「作業ルール」と言う。抜粋の印が無いので一致のテストの外で、作業ルール (11) を直すとこの言い換えが古いまま残る。正本を指す 1 句だけにする',F+':13','司令塔は段を選び返り値を relay するだけ（規則の正本は AGENTS.md「作業ルール」）')
r('files.tsv:docs/guidelines/workflow.md (5) の振り分けの閾値','ng','低','MEDIUM 以上・作り手の検査の指摘・人の指摘で設計へ戻し LOW を PR 本文に載せる、は抜粋 B と同じ規則で、(5) で印の無い文として言い直している。同じ文書の中だが一致のテストは印の付いた行しか照らさないので、B を直すと (5) が残る。(5) は B を指して bot・ready・draft の詳細だけを書く',F+':13','司令塔は、MEDIUM 以上の agent・bot の指摘、作り手の検査の指摘、人の指摘が 1 つでもあれば設計へ戻し')
r('files.tsv:docs/guidelines/workflow.md (6)','ng','低','形式検証の宣言（性質・検査器・前提と範囲・残り）を本文で書いたうえで、正本を docs/design/skill-design-patterns.md「機械で確かめる」とする。全作業に掛かる規範の正本が docs/design/ の設計文書にあると、REVIEW.md の表と repo-implement の docs/guidelines/ の読み込みからは届かない（P5）。正本を workflow.md に置き設計文書が指すか、本文を書かずに指し先だけにするかのどちらか',F+':13','宣言の正本は docs/design/skill-design-patterns.md「機械で確かめる」')
r('files.tsv:docs/guidelines/review-lenses.md','ok','-','段と観点の対応を 1 か所に置き、各観点の問い・入力・出力は agent 定義を正本として置かない（P7）。Codex の立て方の 1 行は W1',F+':14','置かないもの: 各観点の問い・入力・出力（agent 定義が正本）')
r('files.tsv:docs/guidelines/placement.md','ok','-','置き場の基準の正本を 1 つにし、目的に要るかは workflow.md の目的の固定を正本として置かない。REVIEW.md の *.md の行から引かれる（P5）',F+':15','作業に入れるかの判定（目的に要るか）は置かない（正本は workflow.md の目的の固定）')
r('files.tsv:docs/guidelines/README.md','ok','-','ガイドラインの一覧の正本は表で、AGENTS.md の地図はそこを指す。26・27 行目の AGENTS.md への参照も残る規則を指す',F+':16','文書表に workflow.md・review-lenses.md・placement.md を足す（ガイドラインの一覧の正本はこの表）')
r('files.tsv:docs/guidelines/testing.md (1)(3)','ok','-','検証コマンドとテストの置き場は題材の限られる規範で testing.md「検査の入口」が受け皿（P5）。REVIEW.md の Workflow script とテストの行が testing.md を読ませる',F+':17','スキルのテストは scripts/*.test.mjs・tests/ に置き')
r('files.tsv:docs/guidelines/testing.md (2)','ng','低','quick_validate.py の SKIP: はスキルを公開する前の確認で、REVIEW.md の SKILL.md の行は testing.md を読ませず best-practices §10「チェックリスト（スキル公開前の確認）」を読ませる。P5 の経路ではスキルを直す読み手に届かない（AGENTS.md「検証」の指し先からは届く）。受け皿は §10 か、REVIEW.md の SKILL.md の行に testing.md を足すか',R and 'REVIEW.md:11','§10「チェックリスト（スキル公開前の確認）」')
r('files.tsv:docs/guidelines/documentation.md','ok','-','規則の理由の正本は documentation.md:11 で、main L128-134 を AGENTS.md から消して写さない（P9）',F+':18','11 行目が規則の理由の正本')
r('files.tsv:docs/guidelines/javascript.md','ok','-','34 行目の参照先は残る',F+':19','変えない')
r('files.tsv:REVIEW.md (1)〜(6)(8)','ok','-','読むものの表の行き先を新しい正本へ付け替える。重大度の尺度の正本は REVIEW.md「重大度」1 つにして両段で使う',F+':20','重大度の尺度の正本にし') if False else None
r('files.tsv:REVIEW.md (1)〜(6)(8)','ok','-','読むものの表の行き先を新しい正本へ付け替える（P5・P10）。重大度の尺度は REVIEW.md「重大度」1 つを両段で使う',C+':25','重大度の尺度の正本にし、設計段の指摘の行を足して両段で 1 つの尺度にする')
r('files.tsv:REVIEW.md (7)','ng','低','REVIEW.md:29 に作業ルール (14) の新しい句「機械で一致を照らさずに」を足し、同じ規則を 2 か所に書く。一致の検査は抜粋 3 行にしか無い。REVIEW.md の観点が作業ルールを広く写しているのは既存の問題だが、この句はこの PR で足す写し',F+':20','「同じ値・列挙・上限が、機械で一致を照らさずに 2 箇所に書かれていないか」に改める')
r('files.tsv:tests/repo-review-workflow.test.mjs','ok','-','表の変更に伴う期待値の追随で、置き場の変更ではない',F+':21','591〜593 行の期待値を新しい表に合わせる')
r('files.tsv:tests/agents-md-excerpts.test.mjs','ok','-','写しの一致を機械で照らす（P4）。AGENTS.md と docs を読むので配布物でなくリポジトリ直下の tests/ が置き場。定数 3 はテストの中だけ',F+':22','3 はこのテストの中の定数だけに書く')
r('files.tsv:README.md','ok','-','人が 1 回行う install と Codex Desktop の worktree の設定は README（P8・P12）',F+':23','Codex Desktop の Worktree のセットアップ')
r('files.tsv:.claude/agents/purpose-auditor.md〜severity-assigner.md（7 行）','ng','中','7 つの agent 定義が同じ文で「指摘」の節の形（file:line・何が誤りか・重大度を付けない）と「ファイルに書かず返り値で返す」を持ち、workflow.md (5) も同じ形を本文で書く。形の正本が無く 8 か所の写しで、照合の検査も無い。既存の diff-verifier は基準を写さず REVIEW.md を Read する作りで、P7 はそれを出典に挙げる。形の正本を review-lenses.md（か REVIEW.md「出力」）に 1 つ置き、agent 定義はそれを Read する',' .claude/agents/diff-verifier.md:16'.strip(),'基準の中身はここに写していない。写すと REVIEW.md を直したときに検証役だけ古い基準で通す。')
r('files.tsv:.claude/agents/diff-verifier.md','ok','-','定義を変えず、段への当て方は review-lenses.md が持つ（P7・V3）',F+':31','作業ルール (10) が review-lenses.md を指すので 1 段で届く')
r('files.tsv:.codex/hooks.json','ok','-','Q8 の削除。AGENTS.md の hook の記述も消え写しが残らない',F+':32','ファイルごと消す')
r('files.tsv:docs/design/develop-plugin.md','ok','-','節名の参照の付け替え（P10）。71 行目はテストの置き場の行き先 testing.md、201 行目は消える見出しの代わりに「現在の実体」',F+':33','71 行目の「AGENTS.md「現在の実体」」を「docs/guidelines/testing.md」に改める')
r('files.tsv:.agents/skills/manage-marketplace-plugin/SKILL.md','ok','-','AGENTS.md から消す配布の詳細の受け皿として正しい（P6・P9）。正本の宣言の食い違いは「現在の実体」(3) の行に書いた',F+':34','共有の手順・2 つの plugin.json・初公開の script の移動・exit 4')
r('files.tsv:traceability.config.json','ok','-','置き場の変更なし',F+':35','変えない')
rows=[x for x in rows if x]
# ---- canon-inventory ----
ci={2:'best-practices §1 Orchestrator はスキルの範囲で、メインセッションの規則は AGENTS.md に残す。範囲が違うので正本が 2 つにならない',
3:'機序の正本を best-practices §1 にし、AGENTS.md は規則と 1 行の理由（P3）',
4:'スキル内の文書はスキル側、リポジトリのコードのコメントは AGENTS.md と範囲で分ける',
5:'Workflow script の書き方は §3、ad-hoc の fan-out は AGENTS.md と範囲で分ける。ただし ad-hoc の側を AGENTS.md に置くことは files.tsv の (12) の行で ng',
6:'配布物向けの独立した形として触れない。配布先に docs/ が無いので写しでなく別物',
7:'L61 を消し REVIEW.md の §5 の指し先に任せる（P9）',
9:'evidence pack の指針として指すだけ',
10:'観点を分ける根拠として指すだけ。§13 との食い違いは W3',
12:'L205 のフィールドの区別は L2 が検査し散文に写さない（P4）',
13:'L63 を消す（P4）',
14:'L60 を消す（P4）',
15:'main L186〜196・L207・L208 の正本を runner の文書にする。claude-workflow-compatibility.md:25・34 が caller の route 契約を持つことを確かめた',
16:'規則の理由の正本は documentation.md:11（P9）',
17:'testing.md「検査の入口」を受け皿にする（P5）',
18:'REVIEW.md 観点の担い手を diff-verifier にして新しい agent を作らない',
19:'diff-verifier を残し段の対応は review-lenses.md',
20:'claim-judge の範囲は応答で、成果物は diff-verifier が REVIEW.md で当てる',
21:'別 PR の候補として記録するだけ',
22:'同上',
23:'builder の担い手として規範の置き場から指すだけ',
24:'メインセッションの範囲は AGENTS.md、Workflow の機序は §13 と範囲で分ける',
25:'重大度の尺度の正本を REVIEW.md 1 つにする'}
lines=open(R+'/'+C).read().split('\n')
for n in range(2,26):
    cols=lines[n-1].split('\t')
    if n==8:
        r('canon-inventory.tsv:best-practices.md §13「script の置き場」','ng','中','テストの置き場を「AGENTS.md に残す」と書くが、files.tsv の「現在の実体」(5) と testing.md の行、main-lines の L19 後半は docs/guidelines/testing.md へ移すとする。同じ設計の中でテストの置き場の正本が 2 通りに読め、実装者が推測することになる。列名は used_in_v4_for だが design-v5 の成果物として置かれている。v5 の決定（testing.md）に書き直すか、v4 の記録だと明示する',C+':8','テストの置き場（workflows/ に置かない）は §13 に無い（grep で 0 件）ので AGENTS.md に残す')
    elif n==11:
        r('canon-inventory.tsv:manage-marketplace-plugin SKILL.md「設計上の不変条件（守るべきルール）」','ng','中','main L23〜37 の詳細の正本をスキル側にするとするが、files.tsv の「現在の実体」(3) と main-lines の L29-31 は plugin 間の共有の規則の正本を AGENTS.md の行とする。L29-31 は L23〜37 の内側で、正本の宣言が衝突する（「現在の実体」(3) の行と同根）',C+':11','main L23〜37・L205・L168〜172 の詳細の正本にする')
    else:
        r('canon-inventory.tsv:'+cols[0],'ok','-',ci[n],C+':'+str(n),cols[4][:40])
# ---- main-lines ----
ml=open(R+'/'+M).read().split('\n')
special={
 'L19 後半':('ok','-','testing.md が受け皿（P5）。REVIEW.md の Workflow script・テストの行から届く。canon-inventory の §13 の行との食い違いは同行に書いた'),
 'L29-31':('ng','中','AGENTS.md の行をこの規則の正本にするが、manage-marketplace-plugin SKILL.md:183-184 が同じ規則を不変条件として持ち続ける。正本が 2 つ（files.tsv「現在の実体」(3) と同根）'),
 'L56':('ok','-','編集の置き場は毎回踏む（P1）。例外の文が best-practices §13:704 と重なる点は files.tsv の作業ルール (1) の行に書いた'),
 'L108-117':('ng','中','fan-out の規則は題材の限られる規範（P1 の出典が例に挙げる・P5）なのに、AGENTS.md をこの規則の正本にする（files.tsv の作業ルール (12) と同根）'),
 'L118-127':('ng','中','L108-117 と同じ。上位 model へ渡す入力の絞り方は multi-agent の題材の規範（P5）'),
 'L200':('ng','低','SKIP: はスキル公開前の確認で、REVIEW.md の SKILL.md の行からは testing.md に届かない（files.tsv の testing.md (2) と同根）'),
}
defaults={'消す':'既に正本がある・機械が判定する・決定（Q8）で消す行で、正本が how の欄に名指しされている（P4・P6・P9）'}
for n,row in enumerate(ml[1:],2):
    if not row: continue
    c=row.split('\t')
    key=c[0]
    if key in special:
        v,s,reason=special[key]
    else:
        dest=c[2]
        if dest.startswith('消す'):
            reason=defaults['消す']+'。行き先: '+dest
        elif dest.startswith('README'):
            reason='人が行う install・設定は README（P8・P12）'
        elif dest.startswith('docs/guidelines/testing.md'):
            reason='検証コマンドの詳細は testing.md「検査の入口」（P5）。AGENTS.md「検証」が指す'
        elif dest.startswith('docs/guidelines/review-lenses.md'):
            reason='ready 後の差分の役は段と観点の対応表に置く（P7・V3）'
        else:
            reason='毎回踏む規則か地図の指し先で AGENTS.md に残す（P1・P2・P3）'
        v,s='ok','-'
    r('main-lines.tsv:'+key,v,s,reason,M+':'+str(n),c[3][:30])
out=open(R+'/.work/agents-md/design-v5-review/placement/findings.tsv','w')
out.write('ref\tverdict\tseverity\treason\tevidence_ref\tevidence_quote\n')
for x in rows:
    out.write('\t'.join(x)+'\n')
