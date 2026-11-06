"""cfg を生成して TLC を回し、results.tsv と cex/ を書く。model-1 で `python3 tools/run_checks.py [名前の接頭辞…]` と実行する。
基礎の定数は BASE が正本で、変異（mutants/）と選択肢（options/）は BASE からの差分だけを持つ。"""
import concurrent.futures as cf, os, re, subprocess, sys, time
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JAR = '/Users/yoshi/.local/share/tla/tla2tools.jar'

BASE = dict(MAX_AUDIT_PASSES='2', MAX_GATES='4', MAX_CHECK_REWORK='1', MAX_RERUN='1', MAX_VERIFY_REWORK='1', MAX_LOSS='1', ASK_BOUND='9',
            Issues='{1}', IMPL_A024='FALSE', OPT_NC='"record"', OPT_LOW='"blocking0"', OPT_LOSTCOUNT='"count"',
            OPT_DIGEST='"restart"', OPT_SCRIPT='"own"', OPT_DOUBT='"ask_end"', OPT_W='"home"', OPT_FIXEDTBD='"allow"',
            OPT_EMPTY='"noask"', OPT_STILL='"changed"', OPT_UNMAPPED='"changed"', OPT_VFAIL='"changed"', OPT_FILE='"manual"',
            MUT='"none"', VARY='{}')
IMPL = dict(VARY='{"nc", "fixed"}', IMPL_A024='TRUE', OPT_NC='"impl"', OPT_LOSTCOUNT='"nocount"', OPT_DIGEST='"undef"', OPT_SCRIPT='"impl"', OPT_W='"skilldir"')
INV = 'TypeOK Q1 Q1nc Q1strict Q2 Q2fixed Q3a Q3b Q4 Q5 Q6 Q7 Q7W Q8 Q9 Q10 Q10set ConsumerAllZero IssueTracked'.split()
PROPS = ['Term', 'FilingLive']
REACH = 'ReachSaved ReachDone ReachUpstream ReachPassLimit ReachNoProgress ReachGateMax ReachPassMax ReachRedraft ReachDoneFixedTbd ReachHold ReachReask ReachFiled'.split()

def q(v): return f'"{v}"'
RUNS = []  # (名前, 置き場, 定数の差分, 不変式, 性質, 注記)
RUNS.append(('base', '.', {}, INV, PROPS, '決定に合わせた基礎（未決は推奨側）。VARY={} なので not_checked・低重大度の残り・固定の文書の TBD は起きない（Q1strict・ConsumerAllZero・Q2fixed は QM-02・QM-13・QM-12 の選択肢で見る）'))
RUNS.append(('base-2issues', '.', {'Issues': '{1, 2}'}, INV, [], '基礎を論点 2 件で（不変式だけ。活性は 2 分に収まらない）'))
RUNS.append(('reach', '.', {'VARY': '{"nc", "low", "fixed"}'}, REACH, [], '到達の確認: どれも破れれば、その状態に到達できる（空振りでない）'))
RUNS.append(('impl', '.', IMPL, INV, PROPS, '実装のまま。実装の振る舞いが読めない遷移（空の回答・なお着手できない・対応づけられない・差し戻し後・作成前の迷い・起票の失敗）には基礎と同じ推奨側を置いた（A-024 の fail-open・not_checked 無視・記録消失を数えない・照合落ちの後が未定義・script 欠陥の形・W は skill の install 先）'))
MUTANTS = [('Q1', {'MUT': q('Q1')}, 'Q1', 'blocking が残っても段 7 から段 9 へ進む'),
           ('Q1nc', {'OPT_NC': q('impl'), 'VARY': '{"nc"}'}, 'Q1nc', 'not_checked を検査記録に載せない（B-012 の実装）'),
           ('Q2', {'MUT': q('Q2')}, 'Q2', '聞かない問い（上限の後・空の回答で持ち越した論点）を保持規則にしないまま段 9 へ進む'),
           ('Q3gates', {'MUT': q('Q3gates')}, 'Q3a', 'canAsk の境界を 1 つずらす（gates <= MAX_GATES）'),
           ('Q3pass', {'MUT': q('Q3pass')}, 'Q3a', 'pass の上限の境界を 1 つずらす'),
           ('Q3rework', {'MUT': q('Q3rework')}, 'Q3a', 'MAX_CHECK_REWORK の境界を 1 つずらす'),
           ('Q3b', {'OPT_LOSTCOUNT': q('nocount')}, 'Q3b', '記録消失の聞き直しをゲートに数えない（実装）'),
           ('Q4', {'IMPL_A024': 'TRUE'}, 'Q4', 'A-024: 指名された監査役が doc_check の出力を返さないと doc_blocking を 0 とする'),
           ('Q5', {'MUT': q('Q5')}, 'Q5', 'git で戻せる保存先でも承認を待つ'),
           ('Q6', {'MUT': q('Q6')}, 'Q6', '段 3 の問いを持ち越さず、初稿の前にゲートを開く'),
           ('Q7', {'MUT': q('Q7')}, 'Q7', 'needs_answers に next_args を付けない'),
           ('Q7W', {'OPT_W': q('skilldir')}, 'Q7W', 'W を skill の install 先に置く（plugin の更新で消える）'),
           ('Q8', {'MUT': q('Q8')}, 'Q8', '記録の消失を数えずに同じ問いを聞き直す'),
           ('Q9', {'MUT': q('Q9')}, 'Q9', '仕様書だけの run でもゲートを開く'),
           ('Q10', {'MUT': q('Q10')}, 'Q10', 'budget の停止に next_args を付けない'),
           ('Q10set', {'OPT_DIGEST': q('existing'), 'OPT_SCRIPT': q('restart')}, 'Q10set', '照合落ちの後に 4 つの外の行動（entry: existing で W から）を求める'),
           ('TERM', {'MUT': q('TERM')}, 'Term', '段 8 から段 6 へ戻るときに pass を増やさない')]
for n, d, target, note in MUTANTS:
    inv = [x for x in INV if x == target]
    RUNS.append((f'mut-{n}', 'mutants', d, inv, [x for x in PROPS if x == target], f'変異（期待: {target} が破れる）: {note}'))
OPTIONS = {
  'QM-01': ('IMPL_A024', ['TRUE', 'FALSE']),
  'QM-02': ('OPT_NC', ['"impl"', '"record"', '"strict"']),
  'QM-03': ('OPT_LOSTCOUNT', ['"nocount"', '"count"']),
  'QM-04': ('OPT_DIGEST', ['"undef"', '"restart"', '"rerun8"', '"existing"']),
  'QM-05': ('OPT_W', ['"skilldir"', '"home"', '"ask"']),
  'QM-06': ('OPT_DOUBT', ['"ask_end"', '"defer"', '"pregate"']),
  'QM-07': ('OPT_EMPTY', ['"noask"', '"reask"', '"once"']),
  'QM-08': ('OPT_STILL', ['"changed"', '"hold"', '"same"']),
  'QM-09': ('OPT_UNMAPPED', ['"changed"', '"same"', '"hold"']),
  'QM-10': ('OPT_VFAIL', ['"changed"', '"same"', '"hold"']),
  'QM-11': ('OPT_SCRIPT', ['"impl"', '"own"', '"restart"']),
  'QM-12': ('OPT_FIXEDTBD', ['"allow"', '"block"']),
  'QM-13': ('OPT_LOW', ['"blocking0"', '"allzero"']),
  'QM-14': ('OPT_FILE', ['"manual"', '"retry"']),
}
VARY_OF = {'QM-02': {'VARY': '{"nc"}'}, 'QM-12': {'VARY': '{"fixed"}'}, 'QM-13': {'VARY': '{"low"}'}, 'QM-04': {'OPT_SCRIPT': '"restart"'}}
for qid, (k, vals) in OPTIONS.items():
    for v in vals:
        RUNS.append((f'{qid}-{v.strip(chr(34)).lower()}', 'options', {k: v, **VARY_OF.get(qid, {})}, INV, PROPS, f'{qid} の選択肢 {k}={v}'))
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
            consts = {k: BASE[k] for k in ['Issues', 'MAX_VERIFY_REWORK', 'MAX_LOSS', 'OPT_EMPTY', 'OPT_STILL', 'OPT_UNMAPPED', 'OPT_VFAIL', 'OPT_FILE', 'MUT']}
            consts['ASK_BOUND'] = '4'
        elif tla == 'Seam.tla':
            consts = {'IMPL_A024': 'TRUE' if name.endswith('impl') else 'FALSE', 'VARY': '{"nc"}'}
        else:
            consts = {k: BASE[k] for k in ['MAX_GATES', 'MAX_AUDIT_PASSES', 'MAX_CHECK_REWORK', 'MAX_RERUN', 'OPT_NC', 'OPT_LOW', 'OPT_LOSTCOUNT', 'OPT_DIGEST', 'OPT_SCRIPT', 'OPT_DOUBT', 'OPT_W', 'OPT_FIXEDTBD', 'MUT', 'VARY']}
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
            c = l.split('\t'); old.setdefault(c[1], []).append(l)
    with cf.ThreadPoolExecutor(4) as ex:
        for name, rows, secs in ex.map(run, runs):
            cfg = rows[0][1] if rows else name
            old[cfg] = ['\t'.join(r) for r in rows]
            print(f'{name}: {secs:.0f}s ' + ' '.join(f'{r[0]}={r[3]}' for r in rows if r[3] != 'pass'), flush=True)
    with open(path, 'w') as f:
        f.write('check\tcfg\tstates\tresult\tcounterexample_file\tnote\n')
        for k in sorted(old): f.write('\n'.join(old[k]) + '\n')
