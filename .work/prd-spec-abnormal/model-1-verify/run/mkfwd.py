import re
rows=[l.rstrip('\n').split('\t') for l in open('reconcile-A/seam.tsv')][2:]
NR='FailNotRun（next_args あり。代表の段に畳む）'
NI='FailIntegrity（next_args なし。代表の段 draft に畳む）'
M={}
def put(lines, act, v='mapped', note=''):
    for l in lines: M[l]=(act,v,note)
put([446,453,611,622],'ApplyRework','mapped','flowDefect/rework の差し戻しの内部。MAX_CHECK_REWORK を代表にした')
put([606],'ApplyReworkLimit','mapped','stdout なし=count Infinity。上限で next_args ありの blocked')
put([608],'ApplyReworkLimit','mapped','FIXERS_BY_CODE に無い符号=stop。next_args なしの blocked（Block("script")）')
put([1146,1168,1213,1276,1296,2614,2720,2866,2928,3157],NR,'mapped','notRun / agent の例外')
put([1866,1879,1903,2188,2351,2352],'ApplyRework / ApplyReworkLimit','mapped','段 2・3 の flow・lint・plan・問いの形の差し戻し。模型のコメントのとおり apply の MAX_CHECK_REWORK を代表にした')
put([2152],'ApplyReworkLimit','mapped','')
put([2359,2364,2368,2373,2374,2401],'FailNotRun（rs=intake）','mapped','blocked(…, \'1\')')
put([1144,1160,1166,1182,3156],'FailBudget','mapped','段の途中の budget。模型は段 6 だけに注入')
put([3138],'FailBudget','mapped','段の境界の budget は next_args が次の段。模型は from=止まった段で表し、境界の形は区別しない')
put([845,2724,2758,2947],'Seam!Verdict → Audit / Reaudit（v=zero）','mapped','A-024 の fail-open（IMPL_A024）')
put([2846],'ReviseFinal','mapped','')
put([2972,2973],'JudgeReport / Judge*','mapped','')
put([2978,2979],'JudgeNoProgress','mapped','実装の条件（尽きた項目・doc_blocking が減らない・新しい TBD なし）は環境の非決定性で過大近似')
put([2981],'JudgeLimit','mapped','')
put([2983],'JudgeLoop','mapped','')
put([2988,2997,3000,3018,3032],'ReviseFinal / JudgeNoProgress / JudgeLimit ＋ Issue!HoldLeft','mapped','finalHold の本体（next_args なし・report_path）')
put([3021,3025],'FailNotRun（代表）','mapped','finalHold の中の flowKept・independentFlow の失敗は next_args あり（段 7・8）。模型は finalHold を常に next_args なしにし、この分岐は reaudit の FailNotRun でしか表さない（段 7 では注入されない）')
put([14],'Issue!HoldLeft（finalHold）','mapped','')
put([2247],'Decide2Upstream','mapped','')
put([2263],'Decide2Ask / Apply2Ask（OpenGate）','mapped','')
put([2281,2282],'ReqLoseNoCount ＋ Issue!LoseReask','mapped','同じゲート名で止め直す（gates を数えない）')
put([1279],'Seam!Recopy（fault）→ Verdict=rerun','mapped','')
put([1334,1437,1669,1806,2151,2321,2330,2395,2598,2725,2931,2933,3085,3113],NR,'mapped','規定の形の stdout が返らない')
put([1187,1189,1194,1203,1226,1991,2002,1362,1576],NR,'mapped','resolver・verifier の返り値の契約違反（rerunStage / rerun: true）')
put([1572,1639,1741,1753,1755,1828,2109,2129],NR,'mapped','{ error } で rerun 欄なし → 呼び出し側の res.rerun === false ? null : 段 で next_args あり')
put([2392,2454,2488,2494,2514,2518,2546,2775,2781,2786,3125],'FailNotRun / FailIntegrity（rerun の値で分岐）','mapped','発生元の rerun を受け渡す blocked')
put([1338],'FailNotRun / FailIntegrity（rerun: flowChecked）','mapped','')
put([1345,1359,1672,3164,3165],NR,'mapped','照合の食い違いで next_args あり（questionsDrift を含む）')
put([3166,3167],NR,'mapped','聞ける段で script の指定の無い hold を持って出る → next_args あり')
put([1440,1673,2334,2930,3088,3128],NI,'mapped','所有表の外の書き込み・基準の digest 不一致（next_args なし）')
put([2727,2935],'FailNotRun / FailIntegrity（fixedMoved の rerun で分岐）','mapped','')
put([1344,1350,1358,1682,3115],'-','outside-ok','noteIntegrity は integrity の行を積むだけで遷移を変えない（事後報告に載る。SKILL.md「保存と事後報告」5）')
put([1348,1676],'ApplyReworkLimit（stop 側）/ FailScript','mapped','直し手の表に無い符号 → rerun: false（script の表の欠陥）')
put([938,1157,1158,3155,3161],'FailScript','mapped','callDefect → scriptDefect')
put([3046,3047,3055,3162,3163],'FailScript','mapped','exitViolation')
put([902,907,911,928],'-','missing','起動の前の args・state の検査（state_hash 不一致・旧版の next_args・fixed_sha 不一致・tx.try 不正）で Workflow が例外で終わる経路。返り値（status）が無く、依頼者の行動（返った next_args を変えずに渡す／段 1 から）は workflow-io.md §5 にある。模型の Rerun は next_args が常に正しいと置き、この停止も Obs の形も持たない')
put([2104],'FailVerify','mapped','rerun: true')
put([2029],'FailVerify','mapped','rerun: true')
put([1351,1914],NR,'mapped','rerun: true')
put([1979,2091],'FailVerify','mapped','rerun 欄なし → next_args あり')
put([1598,1653,1769,1776,1779],'-','missing','A-017 の rerun: false の検証落ち（domain assessment の独立検証が修正後も失敗・問いへの変換後の独立検証が合格しない）は next_args なしの blocked。模型の FailVerify は next_args ありだけで、この経路が無い（Intended(verify_stuck)=rerun_stage と Obs=restart が食い違う経路を TLC が見ていない）')
out=['seam_line\tsnippet\tmodel_action\tverdict\tnote']
for line,snip,disp in rows:
    l=int(line)
    if disp.startswith('異常系ではない'):
        act,v,note='-','outside-ok','seam.tsv の disposition: '+disp
    elif l in M:
        act,v,note=M[l]; note=(disp+'。'+note) if note else disp
    else:
        raise SystemExit(f'unmapped {l} {disp}')
    out.append('\t'.join([line,snip.replace('\t',' '),act,v,note]))
open('model-1-verify/fwd.tsv','w').write('\n'.join(out)+'\n')
from collections import Counter
print(Counter(r.split('\t')[3] for r in out[1:]))
extra=set(M)-{int(r[0]) for r in rows}; print('extra',extra)
