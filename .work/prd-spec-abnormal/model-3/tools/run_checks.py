"""cfg を生成して TLC を回し、results.tsv と cex/ を書く。model-3 で `python3 tools/run_checks.py [名前の接頭辞…]` と実行する。
基礎の定数は BASE が正本で、変異（mutants/）と選択肢（options/）は BASE からの差分だけを持つ。性質と決定の対応は PROP_NOTE が正本。"""
import concurrent.futures as cf, os, re, subprocess, sys, time
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JAR = '/Users/yoshi/.local/share/tla/tla2tools.jar'

BASE = dict(MAX_AUDIT_PASSES='2', MAX_GATES='4', MAX_CHECK_REWORK='1', MAX_RERUN='1', MAX_VERIFY_REWORK='1', MAX_LOSS='1', ASK_BOUND='9',
            Issues='{1}', IMPL_A024='FALSE', OPT_NC='"record"', OPT_LOSTCOUNT='"count"', OPT_DIGEST='"restart"', OPT_DOUBT='"ask_end"',
            OPT_W='"home"', OPT_ARGS='"q10"', OPT_FIXER='"q10"', OPT_WLOST='"q10"', OPT_FILE='"manual"', MUT='"none"', VARY='{}')
IMPL = dict(VARY='{"nc"}', IMPL_A024='TRUE', OPT_NC='"impl"', OPT_LOSTCOUNT='"nocount"', OPT_DIGEST='"undef"', OPT_W='"skilldir"',
            OPT_ARGS='"impl"', OPT_FIXER='"impl"', OPT_WLOST='"impl"')
INV = 'TypeOK Q1 Q1nc Q2 Q3a Q3b Q4 Q5 Q6 Q7 Q7W Q8 Q9 Q10'.split()
PROPS = ['Term']
REACH = 'ReachSaved ReachDone ReachUpstream ReachPassLimit ReachNoProgress ReachGateMax ReachPassMax ReachRedraft ReachException ReachVerifyHard ReachHold ReachReask ReachEmptyReask ReachFiled'.split()

# 性質と決定の対応（model-1-verify/props.tsv への応答）。dropped は model-2 で検査から外したもの。
PROP_NOTE = {
  'TypeOK': '型。決定に対応しない',
  'Q1': '決定 Q1: 直せていない指摘（blk・docBlk）か検査できなかった箇所（unchecked）が残る稿は保存しない',
  'Q1nc': '決定 Q11: 実施しなかった検査（not_checked）を残して保存するなら検査記録に載っている',
  'Q2': '決定 Q2: done のとき論点はすべて確定か保持規則（固定の文書の TBD は「完成しました」と言わない語の規則で、状態の性質にしない）',
  'Q3a': '決定 Q3: gates・pass・rework（MAX_CHECK_REWORK）・vfail が実装の定数を超えない',
  'Q3b': '決定 Q3: 依頼者を止める回数（stops）≤ MAX_GATES（prd-spec.js:57 の注記の読み）',
  'Q4': '決定 Q4: 結果の無い doc_check を 0 件として進まない',
  'Q5': '決定 Q5: 承認待ちは止まる条件（不変条件・git 管理外・上書き）のときだけ',
  'Q6': '決定 Q6: 最初のゲートは初稿の監査の後',
  'Q7': '決定 Q7: needs_answers は next_args を持つ',
  'Q7W': '決定 Q7（next_args でいつでも続けられる）の前提: next_args を持つ返り値の間は W がある',
  'Q8': '決定 Q8・A-018・PR-REQUESTER-007: 既に回答した論点の同じ中身の再質問は記録の消失のときだけ（model-2 で狭めた。空の回答行は回答に数えない）',
  'Q9': '決定 Q9: 仕様書だけの run はゲートを開かず、upstream_gap は監査の後で next_args なし',
  'Q10': '決定 Q10・workflow-io.md §3・§5・SKILL.md「中継」: 返り値の形から文書が割り当てる行動がちょうど 1 つで、文書の閉集合に入り、止めた原因を除く行動（Remedy）と一致する',
  'Term': '決定 Q3（上限と進展なしで止まる）・brief: 非終端から終端へ必ず至る',
  'IssueTracked': '問い QM-14 の選択肢を見る性質（決定に無い）',
  'FilingLive': '問い QM-14 の選択肢を見る性質（決定に無い）',
}
DROPPED = [
  ('Q1strict', '問いの選択肢（QM-02 strict）の性質で、決定 Q11 が record を選んだので外した（QM-02 は導出済み）'),
  ('Q2fixed', '決定 Q2 の本文（固定の文書の開いた TBD があっても done を返し件数を示す）が退けた読みなので外した（QM-12 は導出済み）。実装の欠陥の証拠でもない'),
  ('Q10set', 'model-1 が置いた 4 つの閉集合は決定に無いので外し、Q10 を文書の閉集合で立て直した'),
  ('ConsumerAllZero', '決定 Q11 が退けた読み（全件 0 件）なので外した。consumer の完了条件（D-023）の改訂が要るという帰結は QM-13 の答えとして table.tsv の JudgeReport の行に残す'),
]

def q(v): return f'"{v}"'
RUNS = []  # (名前, 置き場, 定数の差分, 不変式, 性質, 注記)
RUNS.append(('base', '.', {}, INV, PROPS, '決定に合わせた基礎（残った問いは推奨側）'))
RUNS.append(('base-2issues', '.', {'Issues': '{1, 2}', 'MAX_RERUN': '0', 'MAX_AUDIT_PASSES': '1', 'MAX_GATES': '3'}, INV, [], '基礎を論点 2 件で（不変式だけ。2 分に収めるため MAX_RERUN=0・MAX_AUDIT_PASSES=1・MAX_GATES=3 にし活性を外す）'))
RUNS.append(('reach', '.', {'VARY': '{"nc"}'}, REACH, [], '到達の確認: どれも破れれば、その状態に到達できる（空振りでない）'))
RUNS.append(('impl', '.', IMPL, INV, [], '実装のまま（A-024 の fail-open・not_checked を記録しない・記録消失を数えない・照合落ちの後が未定義・907・911 の例外の文が 2 つの行動を示す・直し手の表に無い符号の停止に接頭辞が無い・W が無いと enterFromDisk が next_args ありの blocked を繰り返す・W は skill の install 先）。作成前の迷い・起票の失敗は実装に無いので基礎と同じ推奨側'))
RUNS.append(('impl-term', '.', {**IMPL, 'VARY': '{}'}, [], PROPS, '実装のままの活性（not_checked は活性に効かないので VARY={} にして 2 分に収める）'))
MUTANTS = [('Q1', {'MUT': q('Q1')}, 'Q1', 'blocking が残っても段 7 から段 9 へ進む'),
           ('Q1nc', {'OPT_NC': q('impl'), 'VARY': '{"nc"}'}, 'Q1nc', 'not_checked を検査記録に載せない（B-012 の実装）'),
           ('Q2', {'MUT': q('Q2')}, 'Q2', '聞けない段でも問いのまま残し、保持規則にしないまま段 9 へ進む'),
           ('Q3gates', {'MUT': q('Q3gates')}, 'Q3a', 'canAsk の境界を 1 つずらす（gates <= MAX_GATES）'),
           ('Q3pass', {'MUT': q('Q3pass')}, 'Q3a', 'pass の上限の境界を 1 つずらす'),
           ('Q3rework', {'MUT': q('Q3rework')}, 'Q3a', 'MAX_CHECK_REWORK の境界を 1 つずらす'),
           ('Q3b', {'OPT_LOSTCOUNT': q('nocount')}, 'Q3b', '記録消失の聞き直しをゲートに数えない（実装）'),
           ('Q4', {'IMPL_A024': 'TRUE'}, 'Q4', 'A-024: 指名された監査役が doc_check の出力を返さないと doc_blocking を 0 とする'),
           ('Q5', {'MUT': q('Q5')}, 'Q5', 'git で戻せる保存先でも承認を待つ'),
           ('Q6', {'MUT': q('Q6')}, 'Q6', '段 3 の問いを持ち越さず、初稿の前にゲートを開く'),
           ('Q7', {'MUT': q('Q7')}, 'Q7', 'needs_answers に next_args を付けない'),
           ('Q7W', {'OPT_W': q('skilldir')}, 'Q7W', 'W を skill の install 先に置く（plugin の更新で消える）'),
           ('Q8', {'MUT': q('Q8')}, 'Q8', 'なお着手できない回答の論点を同じ中身の問いのまま聞き直す'),
           ('Q9', {'MUT': q('Q9')}, 'Q9', '仕様書だけの run でもゲートを開く'),
           ('Q10', {'MUT': q('Q10')}, 'Q10', 'budget の停止に next_args を付けない'),
           ('TERM', {'MUT': q('TERM')}, 'Term', '段 8 から段 6 へ戻るときに pass を増やさない')]
MUTANTS += [('ARGS', {'OPT_ARGS': q('impl')}, 'Q10', '実装の欠陥: 907・911 の例外の文が 2 つの行動を示す'),
            ('FIXER', {'OPT_FIXER': q('impl')}, 'Q10', '実装の欠陥: 直し手の表に無い符号の停止が §5 に回らない'),
            ('WLOST', {'OPT_WLOST': q('impl'), 'OPT_W': q('skilldir')}, 'Q10', '実装の欠陥: W が無いと next_args ありの blocked を繰り返す')]
for n, d, target, note in MUTANTS:
    RUNS.append((f'mut-{n}', 'mutants', d, [x for x in INV if x == target], [x for x in PROPS if x == target], f'変異（期待: {target} が破れる）: {note}'))
OPTIONS = {
  'QM-03': ('OPT_LOSTCOUNT', ['"nocount"', '"count"']),
  'QM-04': ('OPT_DIGEST', ['"undef"', '"restart"', '"rerun8"', '"existing"']),
  'QM-05': ('OPT_W', ['"skilldir"', '"home"', '"ask"']),
  'QM-06': ('OPT_DOUBT', ['"ask_end"', '"defer"', '"pregate"']),
  'QM-14': ('OPT_FILE', ['"manual"', '"retry"']),
}
EXTRA_OF = {}
INV_OF = {'QM-14': INV + ['IssueTracked']}
PROPS_OF = {'QM-14': PROPS + ['FilingLive']}
for qid, (k, vals) in OPTIONS.items():
    for v in vals:
        RUNS.append((f'{qid}-{v.strip(chr(34)).lower()}', 'options', {k: v, **EXTRA_OF.get(qid, {})}, INV_OF.get(qid, INV), PROPS_OF.get(qid, PROPS), f'{qid} の選択肢 {k}={v}'))
UNITS = [('unit-Run', 'Run.tla', 'RSpec', 'RTypeOK Q1 Q3a Q4 Q6 Q7 Q9 Q10'.split(), ['RTerm'], 'Run 単位: 論点と継ぎ目を非決定的な引数で置く。Q1・Q4 の反例は設計どおり（Run は継ぎ目の zero を環境から受け取り、止める仕組みは Seam にある）'),
         ('unit-Issue', 'Issue.tla', 'ISpec', 'ITypeOK Q8 IssueTracked'.split(), [], 'Issue 単位: canAsk と依頼者を非決定的に置く'),
         ('unit-Seam-impl', 'Seam.tla', 'SSpec', ['STypeOK', 'SeamQ4'], [], 'Seam 単位（IMPL_A024 = TRUE）'),
         ('unit-Seam-fixed', 'Seam.tla', 'SSpec', ['STypeOK', 'SeamQ4'], [], 'Seam 単位（IMPL_A024 = FALSE）')]

def cfg_text(consts, spec, inv, props, note):
    lines = [f'\\* {note}', f'SPECIFICATION {spec}', 'CONSTANTS'] + [f'  {k} = {v}' for k, v in consts.items()]
    if inv: lines.append('INVARIANTS ' + ' '.join(inv))
    if props: lines.append('PROPERTIES ' + ' '.join(props))
    return '\n'.join(lines) + '\n'

def tlc(name, cfg, tla, extra=()):
    meta = os.path.join(D, 'states', name)
    cmd = ['java', '-XX:+UseParallelGC', f'-Djava.io.tmpdir={D}/tmp', '-cp', JAR, 'tlc2.TLC', '-metadir', meta, '-workers', '2',
           *extra, '-config', cfg, tla]
    try:
        return subprocess.run(cmd, cwd=D, capture_output=True, text=True, timeout=120).stdout
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or '')
        return out + '\n@@TIMEOUT'

def keep(out):
    return '\n'.join(l for l in out.splitlines() if not l.startswith(('Parsing file', 'Semantic processing', 'Progress(', 'Checking temporal', 'Finished checking'))) + '\n'

def states_of(out, prev):
    m = re.findall(r'([\d,]+) distinct states found', out)
    return m[-1].replace(',', '') if m else prev

# -continue は破った状態の後を探索しないので使わない。破れた不変式を外して回し直し、残りが通るまで繰り返す。
def run(r):
    name, where, diff, inv, props, note = r
    t = time.time()
    if name.startswith('unit-'):
        u = [x for x in UNITS if x[0] == name][0]
        tla, spec, inv, props, note = u[1], u[2], u[3], u[4], u[5]
        if tla == 'Issue.tla':
            consts = {k: BASE[k] for k in ['Issues', 'MAX_VERIFY_REWORK', 'MAX_LOSS', 'OPT_FILE', 'MUT']}
            consts['ASK_BOUND'] = '4'
        elif tla == 'Seam.tla':
            consts = {'IMPL_A024': 'TRUE' if name.endswith('impl') else 'FALSE', 'VARY': '{"nc"}'}
        else:
            consts = {k: BASE[k] for k in ['MAX_GATES', 'MAX_AUDIT_PASSES', 'MAX_CHECK_REWORK', 'MAX_RERUN', 'OPT_NC', 'OPT_LOSTCOUNT', 'OPT_DIGEST', 'OPT_DOUBT', 'OPT_W', 'OPT_ARGS', 'OPT_FIXER', 'OPT_WLOST', 'MUT', 'VARY']}
        cfg = f'{name}.cfg'
    else:
        consts = dict(BASE); consts.update(diff); tla, spec = 'Composed.tla', 'Spec'
        cfg = os.path.join(where, f'{name}.cfg') if where != '.' else f'{name}.cfg'
    open(os.path.join(D, cfg), 'w').write(cfg_text(consts, spec, inv, props, note))
    tmpcfg = os.path.join('tmp', f'{name}.cfg')
    rows, left, states, flags = [], list(inv), '-', []
    while left or not rows and not props:
        open(os.path.join(D, tmpcfg), 'w').write(cfg_text(consts, spec, left, [], note))
        out = tlc(name, tmpcfg, tla, flags)
        states = states_of(out, states)
        v = re.findall(r'Error: Invariant (\w+) is violated', out)
        if '@@TIMEOUT' in out:
            rows += [(p, cfg, states, 'timeout', '-', note) for p in left]; break
        if 'Error: Deadlock reached' in out:
            cex = f'cex/{name}-deadlock.txt'; open(os.path.join(D, cex), 'w').write(keep(out))
            rows.append(('deadlock', cfg, states, 'violated', cex, note)); flags = ['-deadlock']; continue
        if v:
            cex = f'cex/{name}-{v[0]}.txt'; open(os.path.join(D, cex), 'w').write(keep(out))
            rows.append((v[0], cfg, states, 'violated', cex, note)); left.remove(v[0]); continue
        errs = [l for l in out.splitlines() if l.startswith('Error:')]
        if errs:
            cex = f'cex/{name}-error.txt'; open(os.path.join(D, cex), 'w').write(keep(out))
            rows.append(('tlc-error', cfg, states, 'error', cex, errs[0])); break
        rows += [(p, cfg, states, 'pass', '-', note) for p in left]; break
    for p in props:
        open(os.path.join(D, tmpcfg), 'w').write(cfg_text(consts, spec, [], [p], note))
        out = tlc(name, tmpcfg, tla, ['-deadlock'])
        st = states_of(out, '-')
        if '@@TIMEOUT' in out: rows.append((p, cfg, st, 'timeout', '-', note))
        elif 'Error: Temporal properties were violated' in out:
            cex = f'cex/{name}-{p}.txt'; open(os.path.join(D, cex), 'w').write(keep(out))
            rows.append((p, cfg, st, 'violated', cex, note))
        elif [l for l in out.splitlines() if l.startswith('Error:')]:
            cex = f'cex/{name}-{p}-error.txt'; open(os.path.join(D, cex), 'w').write(keep(out))
            rows.append((p, cfg, st, 'error', cex, note))
        else: rows.append((p, cfg, st, 'pass', '-', note))
    rows = [(r[0], r[1], r[2], r[3], r[4], r[5] + (' ／ ' + PROP_NOTE[r[0]] if r[0] in PROP_NOTE else '')) for r in rows]
    order = {p: i for i, p in enumerate(list(inv) + ['deadlock', 'tlc-error'] + list(props))}
    rows.sort(key=lambda x: order.get(x[0], 99))
    return name, rows, time.time() - t

if __name__ == '__main__':
    pick = sys.argv[1:]
    runs = [r for r in RUNS if not pick or any(r[0].startswith(p) for p in pick)]
    runs += [(u[0], '.', {}, [], [], '') for u in UNITS if not pick or any(u[0].startswith(p) for p in pick)]
    path = os.path.join(D, 'results.tsv')
    old = {}
    if os.path.exists(path):
        for l in open(path).read().splitlines()[1:]:
            c = l.split('\t')
            if c[1] != '-': old.setdefault(c[1], []).append(l)
    with cf.ThreadPoolExecutor(4) as ex:
        for name, rows, secs in ex.map(run, runs):
            cfg = rows[0][1] if rows else name
            old[cfg] = ['\t'.join(r) for r in rows]
            print(f'{name}: {secs:.0f}s ' + ' '.join(f'{r[0]}={r[3]}' for r in rows if r[3] != 'pass'), flush=True)
    with open(path, 'w') as f:
        f.write('check\tcfg\tstates\tresult\tcounterexample_file\tnote\n')
        for k in sorted(old): f.write('\n'.join(old[k]) + '\n')
        for p, why in DROPPED: f.write(f'{p}\t-\t-\tdropped\t-\t{why}\n')
