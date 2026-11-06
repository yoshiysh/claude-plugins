"""questions.tsv を導出する。各選択肢の TLC の結果は results.tsv の options/<qid>-<値>.cfg の行から写す（手で書き写さない）。
model-3 で `python3 tools/questions.py` と実行する。model-1 の QM-01・02・07・08・09・10・11・12・13（model-1-verify/qcheck.tsv）と model-2 の QM-16・17・18
（model-2-verify/qcheck2.tsv）は決定から導けたので問いから外し、答えを table.tsv の source（decision:Qn）に入れた。layer は prd-and-spec.md §3〜§7 の軸 B
（要求 = 目的側・価値の判断、仕様 = 手段側）。"""
import csv, os
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DR = 'R/.work/prd-spec-abnormal/draft-req-rejected'
JS = 'plugins/workflow/workflows/prd-spec.js'
SK = 'plugins/workflow/skills/prd-spec/SKILL.md'
WIO = 'plugins/workflow/skills/prd-spec/references/workflow-io.md'

# (qid, layer, state, event, problem, [(OPT 値, 選択肢, 帰結)], 推奨の番号, 推奨の根拠, evidence)
# (qid, layer, state, event, problem, [(OPT 値, 選択肢, 帰結)], 推奨の番号, 推奨の根拠, 決めないと未定のまま残る遷移, evidence)
Q = [
 ('QM-03', '仕様', 'Run:needs_answers（Issue: 回答の記録が失われた）', '依頼者が next_args で呼び直し、answers の検査に落ちる',
  '遷移が 2 本: 実装は同じゲート名で聞き直し gates を数えない。決定 Q3 の 2 つの記述が逆を指す（「依頼者を止める回数の上限」は数える側、「数える単位も実装に揃う」は実装の単位であるゲートを数え、記録の消失を数えない側）',
  [('"nocount"', '数えない（実装）', '依頼者の回答を失わないが、止める回数は記録の消失の回数だけ MAX_GATES を超える'),
   ('"count"', '数える', '止める回数が MAX_GATES に収まる。上限の後に失われた回答の論点は保持規則と Issue の文案になる')],
  2, '数える側の根拠: 決定 Q3 の問いの文が上限を「依頼者を止める回数」と呼び、prd-spec.js:57 の注記も同じ。数えない側の根拠: Q3 の「数える単位も実装に揃う」は実装の数え方（ゲート単位）を正とする読みで、これを採ると Q3b は決定の性質でなくなる。ただし「単位も揃う」の文は flow.md:609 のような試験が実装で落ちなくなることを理由に挙げており、試験の数え方の話として読む方が文脈に合う。記録の消失は依頼者の責任でなく、その分だけ止める回数が増えるのは上限の目的（依頼者を止めすぎない）に反するので count を推す',
  '決めないと、Run の needs_answers で「記録の消失による呼び直し」が来たときに gates を増やすか（上限で保持規則に回すか）が未定のまま残る',
  f'{JS}:2281 ac.exists !== true ? \'ファイルがありません（段 1 の reset が消したことがある）\' / {JS}:57 依頼者を止める回数の上限 / build-req-2/open.tsv D-035 / {DR}/requester.md PR-REQUESTER-048 / decision:Q3・Q8'),
 ('QM-04', '仕様', 'Run:save（tree digest が最後の監査と違う）', '保存しないと決めた後の依頼者の次の行動',
  '遷移が 0 本: SKILL.md は「違えば保存しない」だけを書き、done は next_args を持たないので、決定 Q10 の「再監査は依頼者が実行し直して行う」の実行し直し方が決まらない（実装の模型で Q10 の反例: 行動の集合が空）',
  [('"undef"', '実装のまま（行動を書かない）', '返り値の形に当てる行動が無い'),
   ('"restart"', 'S0 から同じ args で起こし直す', '行動は「最初から」。監査済みの稿と裁定と依頼者の回答を捨て、初稿から書き直す。実装の変更は要らない'),
   ('"rerun8"', 'done の代わりに段 8 から続ける next_args を返す', '行動は「段から再実行」。監査だけをやり直す。照合を Workflow の中（保存の前の段）に移す実装の変更が要る'),
   ('"existing"', 'W の文書を entry: existing で監査し直す', '行動が workflow-io.md §3・§5 の閉集合の外（existing_rerun）')],
  3, 'rerun8 の根拠: 決定 Q10 の文は「再監査」を求め、作り直しを求めていない。restart の根拠: 実装の変更が要らず、照合に落ちる原因（最後の監査の後に誰かが文書を書き換えた）は稀で、捨てるものの重さは稀さで割り引ける。どちらも Q10 を通るので、決定の文言に沿う rerun8 を推す。実装の変更の重さを優先するなら restart に替えてよい',
  '決めないと、Run の save で tree digest が一致しないときの依頼者の次の行動（再監査をどこから始めるか）が未定のまま残る',
  f'{SK}:157 違えば保存しない。 / {WIO}:222 保存しない。最後の監査の後に文書が変わっている / reconcile-A/findings.tsv A-022 / decision:Q10'),
 ('QM-05', '仕様', 'Run:needs_answers・blocked（next_args あり）', 'plugin の更新の後に next_args で呼び直す',
  '遷移が 2 本: 決定 Q7 は「next_args でいつでも続けられる」とするが、native の W は skill の版ごとの install 先にあり plugin の更新で引き継がれない（SKILL.md:70）。続ける遷移と W が無く止まる遷移の両方がある（D-014）。skilldir は Q7 で外れるが、home と ask の間は決定から一意に決まらない',
  [('"skilldir"', '実装のまま（skill の install 先）', 'plugin を更新すると続けられない'),
   ('"home"', '依頼者のホームの下（版に依らない場所）に置き、案件名は依頼文の題名にする', '版を跨いで続けられる。題名が同じ案件で置き場が重なりうる。実装の変更が要る'),
   ('"ask"', '案件名を依頼者に聞く', '名前は確実だが、S0 で依頼者を 1 回止める')],
  2, 'ask が Q3b を破るのは QM-03 で count（止める回数を数える）を採る場合で、nocount を採るなら ask も通る。QM-03 に依らない根拠として、決定 Q6 の推奨が「依頼者を止める回数が減る」ことを利点に挙げ、ask は理由なく 1 回増やす。home は題名の重なりを避ける工夫（日付や連番を足す）が要るが、依頼者を止めずに Q7 を満たすので推す',
  '決めないと、Run の S0 で W の置き場と案件名を決める遷移（依頼者に聞くか）と、plugin の更新の後の呼び直しで W が見つかるかが未定のまま残る',
  f'{SK}:70 native はこの skill の版ごとの install 先に置くので、plugin を更新すると W は新しい版に引き継がれない / build-req-2/open.tsv D-014 / decision:Q6・Q7'),
 ('QM-06', '要求', 'Run:S0（作成に入る前: 対象外か・単語だけか・実行基盤が足りるかの判定に迷う）', '迷いが生じる',
  '遷移が 0 本: 決定 Q7 は迷いを「次のゲートの問い」にするが、作成の前にはゲートが無い（D-006・A-011）。Q7 の文言（起動の判定を迷いの例に挙げ、推測で決めずに次のゲートで聞く）は defer に寄るが、defer は既定で作成に入るので起動の判定を既定で決めており、「推測で決めずに」とも読み合う',
  [('"ask_end"', '迷った点を示して尋ね、実行を終える', '誤った作成は起きない。依頼者は依頼文を直して出し直す（最初から）。Q7 の「次のゲートで聞く」には合わない'),
   ('"defer"', '既定（対象外とみなさない）で作成に入り、迷いを最初のゲートの問いにする', '止まらない。対象外だったときは初稿と監査が無駄になる（決定 Q6 は初稿の書き直しの無駄を受け入れている）'),
   ('"pregate"', '作成の前に専用の中断点を置いて待つ', '初稿の前にゲートが開き Q6 を破り、仕様書だけの run でもゲートを開くので Q9 も破る。Q7 が退けた確認ごとの待ち状態に当たる')],
  2, 'model-2 の推奨（ask_end）を変えた。defer の根拠: 決定 Q7 は起動の判定の迷いを名指しして「次のゲートの問いとして聞く」とし、決定 Q6 は初稿の無駄を受け入れて問いを 1 回にまとめる。ask_end の根拠: SKILL.md:35 の空入力の扱い（取り違えた文書は害の方が大きい）と同じ形で、対象外の依頼に初稿と監査を回さない。ただし空入力は対象が全く無い場合で、迷いは対象がある場合なので広げる根拠が弱い。決定の文言に沿う defer を推す。対象外の誤作成の害を重く見るなら ask_end',
  '決めないと、Run の S0 で作成に入る前の判定に迷ったときに、作成に入るか（問いを持ち越すか）と返して終えるかが未定のまま残る',
  f'{SK}:35 空入力・単語のみのときは、推測で対象を決めずに次を返して終える / build-req-2/open.tsv D-006;A-011 / decision:Q6・Q7・Q9'),
 ('QM-14', '仕様', 'Issue:approved（依頼者が承認した Issue の文案）', '起票に失敗する（権限・ネットワーク・gh が無い）',
  '遷移が 0 本: SKILL.md は承認後に gh issue create で起票するとだけ書き、失敗の後が無い（D-017）',
  [('"manual"', '文案をそのまま示し、依頼者に手で起票してもらう', '止まらないが、起票の有無が記録に残らない（IssueTracked を破る）'),
   ('"retry"', '起票できるまで保存の完了と扱わない', '起票の有無は残るが、外部の不調が続くと終わらない（FilingLive を破る）')],
  1, 'manual の根拠: 決定 Q5 の「人間ゲート以外では止めない」と、外部の不調で run を終わらせない方針。retry の根拠: 決定 Q2 は決まらない論点を保持規則と Issue にして完了するとし、Issue が起票されないと裁定の経路が残らない。manual を採り、事後報告に「未起票」の文案と ID を残す規則を足して Q2 の経路を記録で保つのを推す',
  '決めないと、Issue の approved で起票に失敗したときの遷移（手で起票に回すか、完了と扱わずにやり直すか）が未定のまま残る',
  f'{SK}:179 文案は、依頼者の承認を得てから `gh issue create` で起票し、番号を報告する。 / build-req-2/open.tsv D-017 / decision:Q2・Q5'),
 ('QM-15', '要求', '模型の外（保存の INDEX の導出）', '保存先の同じディレクトリに一式でない文書がある',
  '状態とイベントでは表せない: 読む文書の範囲の規則（M-003）で、run の状態の遷移を変えない。模型に入れず TLC も回していない',
  [('-', '載せる（実装）。S0 で保存先の他の文書も W に置いて existing_docs に fixed: true で並べ、INDEX に載せる。並べ忘れた文書は書き換えてよい文書として監査され改稿されうる', 'INDEX がディレクトリの全体を表す。所在を示されない文書を読み、固定の文書として run の根拠にもなりうる'),
   ('-', '載せない。INDEX の対象を一式の文書に限る', '所在の規則は例外なく保てるが、INDEX が一部しか表さない')],
  1, '選択肢 1 の根拠: INDEX は導出物で、ディレクトリの一部しか表さない INDEX は読み手を誤らせる（SKILL.md:162 が他の文書を W に置く理由）。選択肢 2 の根拠: 実装は他の文書を読むだけでなく固定の文書として run に渡すので、所在を示されない文書を根拠にしない規則（PR-REQUESTER-032・035）が守られない。選択肢 1 を推すが、固定の文書を INDEX の導出だけに使い根拠に渡さない実装の変更を条件にする',
  '決めないと、保存の INDEX の導出で、所在を示されない保存先の文書を読んで載せるかが未定のまま残る（run の状態の遷移には効かない）',
  f'build-req-2/open.tsv M-003 / {SK}:162 W に無い文書は INDEX に載らないので / {DR}/requester.md PR-REQUESTER-032・035'),
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
    fh.write('qid\tlayer\tstate\tevent\tproblem\toptions\trecommend\tundecided\tevidence\n')
    for qid, layer, state, event, problem, opts, rec, why, undecided, ev in Q:
        o = ' ／ '.join(f'({i + 1}) {lab}（{"OPT=" + v if v != "-" else "模型の外"}）— {cons}。{tlc(qid, v)}' for i, (v, lab, cons) in enumerate(opts))
        fh.write('\t'.join([qid, layer, state, event, problem, o, f'({rec}) {why}', undecided, ev]) + '\n')
print(len(Q), 'questions')
