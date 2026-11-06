"""questions.tsv を導出する。各選択肢の TLC の結果は results.tsv の options/<qid>-<値>.cfg の行から写す（手で書き写さない）。
model-2 で `python3 tools/questions.py` と実行する。model-1 の QM-01・02・07・08・09・10・11・12・13 は決定から導けた
（model-1-verify/qcheck.tsv）ので問いから外し、答えを table.tsv の source（decision:Qn）に入れた。layer は prd-and-spec.md §3〜§7 の軸 B
（要求 = 目的側・価値の判断、仕様 = 手段側）。"""
import csv, os
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DR = 'R/.work/prd-spec-abnormal/draft-req-rejected'
JS = 'plugins/workflow/workflows/prd-spec.js'
SK = 'plugins/workflow/skills/prd-spec/SKILL.md'
WIO = 'plugins/workflow/skills/prd-spec/references/workflow-io.md'

# (qid, layer, state, event, problem, [(OPT 値, 選択肢, 帰結)], 推奨の番号, 推奨の根拠, evidence)
Q = [
 ('QM-03', '仕様', 'Run:needs_answers（Issue: 回答の記録が失われた）', '依頼者が next_args で呼び直し、answers の検査に落ちる',
  '遷移が 2 本: 実装は同じゲート名で聞き直し gates を数えないので、依頼者を止める回数が MAX_GATES を超えうる（Q3b の反例）。数えると上限の後に失われた回答の論点が保持規則に回る（D-035）',
  [('"nocount"', '数えない（実装）', '依頼者の回答を失わないが、止める回数は記録の消失の回数だけ増える'),
   ('"count"', '数える', '止める回数が MAX_GATES に収まる。上限の後に失われた回答の論点は保持規則と Issue の文案になる')],
  2, '決定 Q3 は MAX_GATES を依頼者を止める回数の上限として正本にした（prd-spec.js:56 の注記）。数えない側は Q3b を破る。失われた回答の論点は保持規則と Issue の文案で依頼者に届くので、決定 Q2 の閉じ方に入る',
  f'{JS}:2281 ac.exists !== true ? \'ファイルがありません（段 1 の reset が消したことがある）\' / {JS}:2282 resumable: false / build-req-2/open.tsv D-035 / {DR}/requester.md PR-REQUESTER-048 / decision:Q3・Q8'),
 ('QM-04', '仕様', 'Run:save（tree digest が最後の監査と違う）', '保存しないと決めた後の依頼者の次の行動',
  '遷移が 0 本: SKILL.md は「違えば保存しない」だけを書き、done は next_args を持たないので、決定 Q10 の「再監査は依頼者が実行し直して行う」の実行し直し方が決まらない（実装の模型で Q10 の反例: 行動の集合が空）',
  [('"undef"', '実装のまま（行動を書かない）', '返り値の形に当てる行動が無い'),
   ('"restart"', 'S0 から同じ args で起こし直す', '行動は「最初から」。監査済みの稿と裁定を捨て、初稿から書き直す'),
   ('"rerun8"', 'done の代わりに段 8 から続ける next_args を返す', '行動は「段から再実行」。監査だけをやり直す。実装の変更（照合を保存の前の段に入れ、落ちたら blocked と next_args を返す）が要る'),
   ('"existing"', 'W の文書を entry: existing で監査し直す', '行動が workflow-io.md §3・§5 の閉集合の外（existing_rerun）')],
  3, '決定 Q10 は「再監査」を求め、作り直しを求めていない。restart も Q10 を通るが、監査済みの稿と裁定と依頼者の回答を捨てて初稿から書き直す。rerun8 は監査だけをやり直し、行動が「段から再実行」1 つに決まる',
  f'{SK}:157 違えば保存しない。 / {WIO}:222 保存しない。最後の監査の後に文書が変わっている / reconcile-A/findings.tsv A-022 / decision:Q10'),
 ('QM-05', '仕様', 'Run:needs_answers・blocked（next_args あり）', 'plugin の更新の後に next_args で呼び直す',
  '遷移が 2 本: 決定 Q7 は「next_args でいつでも続けられる」とするが、native の W は skill の版ごとの install 先にあり plugin の更新で引き継がれない（SKILL.md:70）。続ける遷移と W が無く止まる遷移の両方がある（D-014 の置き場の未決と同じ根）',
  [('"skilldir"', '実装のまま（skill の install 先）', 'plugin を更新すると続けられない'),
   ('"home"', '依頼者のホームの下（版に依らない場所）に置き、案件名は依頼文の題名にする', '版を跨いで続けられる。実装の変更が要る'),
   ('"ask"', '案件名を依頼者に聞く', '名前は確実だが、S0 で依頼者を 1 回止める（Q3b を破る）')],
  2, '決定 Q7 の「いつでも続けられる」を満たすのは home と ask で、ask は依頼者を止める回数を 1 回増やし決定 Q3 の上限を破る。home だけが両方を満たす',
  f'{SK}:70 native はこの skill の版ごとの install 先に置くので、plugin を更新すると W は新しい版に引き継がれない / build-req-2/open.tsv D-014 / decision:Q7'),
 ('QM-06', '要求', 'Run:S0（作成に入る前: 対象外か・単語だけか・実行基盤が足りるかの判定に迷う）', '迷いが生じる',
  '遷移が 0 本: 決定 Q7 は迷いを「次のゲートの問い」にするが、作成の前にはゲートが無い（D-006・A-011）。ask_end と defer はどちらも Q7 の文言に合う',
  [('"ask_end"', '迷った点を示して尋ね、実行を終える', '誤った作成は起きない。依頼者は依頼文を直して出し直す（最初から）'),
   ('"defer"', '既定（対象外とみなさない）で作成に入り、迷いを最初のゲートの問いにする', '止まらないが、対象外だったときは初稿と監査が無駄になる'),
   ('"pregate"', '作成の前に専用の中断点を置いて待つ', '初稿の前にゲートが開き Q6 を破り、仕様書だけの run でもゲートを開くので Q9 も破る。Q7 が退けた確認ごとの待ち状態に当たる')],
  1, 'pregate は決定 Q6・Q9・Q7 に反する。defer は対象外の依頼に初稿と監査を回し、SKILL.md の「取り違えた文書は害の方が大きい」（空入力の扱い）と食い違う。ask_end は既存の空入力の扱いと同じ形で、依頼者の行動は「最初から」1 つに決まる',
  f'{SK}:35 空入力・単語のみのときは、推測で対象を決めずに次を返して終える / build-req-2/open.tsv D-006;A-011 / decision:Q6・Q7・Q9'),
 ('QM-14', '仕様', 'Issue:approved（依頼者が承認した Issue の文案）', '起票に失敗する（権限・ネットワーク・gh が無い）',
  '遷移が 0 本: SKILL.md は承認後に gh issue create で起票するとだけ書き、失敗の後が無い（D-017）',
  [('"manual"', '文案をそのまま示し、依頼者に手で起票してもらう', '止まらないが、起票の有無が記録に残らない（IssueTracked を破る）'),
   ('"retry"', '起票できるまで保存の完了と扱わない', '起票の有無は残るが、外部の不調が続くと終わらない（FilingLive を破る）')],
  1, 'どちらも 1 つずつ性質を破る。決定 Q5 は「人間ゲート以外では止めない」を採り、外部の不調で run を終わらせない方に合う。manual を採るなら、事後報告に「未起票」の文案と ID を残す規則を足して IssueTracked の穴を記録で塞ぐ',
  f'{SK}:179 文案は、依頼者の承認を得てから `gh issue create` で起票し、番号を報告する。 / build-req-2/open.tsv D-017 / decision:Q5'),
 ('QM-15', '要求', '模型の外（保存の INDEX の導出）', '保存先の同じディレクトリに一式でない文書がある',
  '状態とイベントでは表せない: 読む文書の範囲の規則（M-003）で、run の状態の遷移を変えない。模型に入れず TLC も回していない',
  [('-', '載せる。INDEX の導出のためだけに保存先の文書を読み、根拠には使わない（実装）', 'INDEX がディレクトリの全体を表す。所在を示されない文書を読む'),
   ('-', '載せない。INDEX の対象を一式の文書に限る', '所在の規則は例外なく保てるが、INDEX が一部しか表さない')],
  1, 'INDEX は導出物で、ディレクトリの一部しか表さない INDEX は読み手を誤らせる。読む目的を INDEX の導出に限り根拠に使わないと書けば、所在を示されない文書を根拠にしないという規則の目的は保てる（模型の外なので TLC の裏付けは無い）',
  f'build-req-2/open.tsv M-003 / {SK}:162 W に無い文書は INDEX に載らないので'),
 ('QM-16', '仕様', 'Workflow の起動の前（next_args と違う args・旧版の next_args・固定の文書の sha の不一致）', '例外で終わった後の依頼者の次の行動',
  '遷移が 2 本: 旧版の next_args（907）は「S0 から流し直し」、固定の文書の sha の不一致（911）は「返った next_args を変えずに渡すか、段 1 から」と 2 つの行動を示し、workflow-io.md §5 は args の検査を「渡した args が返った next_args かを確かめる」とする。打ち間違いと固定の文書の変化が同じ文になり、行動が 1 つに決まらない（実装の模型で Q10 の反例）',
  [('"impl"', '実装のまま（文が 2 つの行動を示す）', '依頼者が試して外れるまで、どちらか分からない'),
   ('"split"', '起動の前の検査を原因で分ける: 打ち間違い・tx.try・state_hash は「返った next_args を変えずに渡す」、旧版の next_args と固定の文書の変化は「段 1（S0）から」', '例外の文から行動が 1 つに決まる。911 の照合に、existing_docs の sha と固定の文書の今の sha の比較を足す実装の変更が要る')],
  2, '決定 Q10 は「Block の条件が文書で一意になり試験を書ける」ことを求める。split だけが Q10 を通る',
  f'{JS}:911 返った next_args を変えずに渡すか、段 1 から始めてください / {JS}:907 S0 から流し直してください / {WIO}:217 args の検査なら、渡した args が返った `next_args`（§3 の環境の欄のほかは変えない）かを確かめる / model-1-verify/fwd.tsv 902・907・911・928 / decision:Q10'),
 ('QM-17', '仕様', 'Run:apply（回答を当てた flow の差し戻しが上限に達し、符号が直し手の表に無い）', '依頼者の次の行動',
  '遷移が 2 本: rerun: !done.defect.stop で next_args なしの blocked になるが、reason は「script の不変条件に反しました」を持たず SKILL.md の中継が workflow-io.md §5 に回さない。返り値の形からは「最初から」と読めるが、表の欠陥なので同じ所で止まり続ける（実装の模型で Q10 の反例。model-1-verify/qcheck.tsv QM-11 の残り）',
  [('"impl"', '実装のまま（接頭辞なし）', '依頼者は最初からやり直し、同じ所で止まる'),
   ('"prefix"', 'reason に「script の不変条件に反しました」の接頭辞を付け、§5 の「prd-spec.js を直す」に回す', '行動が 1 つに決まる。2152・1879・1348・1676 の 4 箇所の文の変更が要る')],
  2, '決定 Q10 の「段から再実行と最初から」の区別に加え、直すべきものが script なら依頼者を再実行に向けない。prefix だけが Q10 を通る',
  f'{JS}:2152 rerun: !done.defect.stop / {JS}:608 直し手の表（FIXERS_BY_CODE）に無い符号 / {WIO}:217 / decision:Q10'),
 ('QM-18', '仕様', 'Run:needs_answers・blocked（next_args あり、W が無い）', 'next_args で呼び直す',
  '遷移が実装から読めない（model-1-verify/rev.tsv の ReqWLost unverified）: prd-spec.js は W の有無を検査せず（872 は絶対パスかだけ）、最初の flow-check の doc_check が 4462 で落ちる。その agent が stdout を返さなければ next_args ありの blocked になり、同じ呼び直しで同じ所に戻る',
  [('"loop"', '実装の推定（next_args ありの blocked）', '行動は「段から再実行」と読めるが、W が無いので終わらない'),
   ('"check"', '起動の前に W の有無を検査し、無ければ例外で「S0 から」と返す', '行動が「最初から」1 つに決まる。起動の前の検査を 1 つ足す実装の変更が要る')],
  2, '決定 Q10 は「読み取れない文書があれば run を始めずに止める」とし、W は run の前提の文書の置き場なので同じ扱いになる。check だけが Q10 を通る（どちらも Q7W は破る。W が無くなる原因は QM-05 が除く）',
  f'{JS}:872 args.workspace に workspace の絶対パスを渡してください / plugins/workflow/skills/prd-spec/scripts/doc_check.mjs:4462 workspace がディレクトリではありません / decision:Q10'),
]

res = {}
if os.path.exists(os.path.join(D, 'results.tsv')):
    for r in csv.DictReader(open(os.path.join(D, 'results.tsv')), delimiter='\t'):
        res.setdefault(r['cfg'], []).append(r)

def tlc(qid, v):
    if v == '-': return 'TLC: 模型の外のため回していない'
    rows = res.get(f'options/{qid}-{v.strip(chr(34)).lower()}.cfg')
    if not rows: return 'TLC: 未実行'
    bad = [r['check'] for r in rows if r['result'] != 'pass']
    return f'TLC（{rows[0]["states"]} 状態）: ' + (('破れた性質 ' + '・'.join(bad)) if bad else '性質はすべて通る')

with open(os.path.join(D, 'questions.tsv'), 'w') as fh:
    fh.write('qid\tlayer\tstate\tevent\tproblem\toptions\trecommend\tevidence\n')
    for qid, layer, state, event, problem, opts, rec, why, ev in Q:
        o = ' ／ '.join(f'({i + 1}) {lab}（{"OPT=" + v if v != "-" else "模型の外"}）— {cons}。{tlc(qid, v)}' for i, (v, lab, cons) in enumerate(opts))
        fh.write('\t'.join([qid, layer, state, event, problem, o, f'({rec}) {why}', ev]) + '\n')
print(len(Q), 'questions')
