"""模型の @row・@trace のコメントから table.tsv と trace.tsv を導出する。model-1 で `python3 tools/extract.py` と実行する。
表の正本は .tla のコメントで、tsv はその写しなので手で直さない。@row の source が impl のときは、その後の最初の @trace の impl_ref を使う
（行番号を 2 箇所に書かない）。駆動の Next に出る action に @trace が無ければ止める。"""
import os, re
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rows, traces, pending = [], [], []
for f in ['Run.tla', 'Issue.tla', 'Seam.tla']:
    for line in open(os.path.join(D, f)):
        line = line.strip()
        if line.startswith('\\* @row '):
            cells = line[len('\\* @row '):].split('|')
            if len(cells) != 7: raise SystemExit(f'{f}: @row の欄が 7 でない: {line}')
            rows.append(cells); pending.append(cells)
        elif line.startswith('\\* @trace '):
            cells = line[len('\\* @trace '):].split('|')
            if len(cells) != 4: raise SystemExit(f'{f}: @trace の欄が 4 でない: {line}')
            traces.append(cells)
            for r in pending:
                if r[6] == 'impl':
                    if cells[1] in ('-',) or cells[1].startswith('decision'): raise SystemExit(f'{f}: impl の @row の後の @trace が実装を指さない: {cells[0]}')
                    r[6] = 'impl:' + cells[1].split('/')[-1]
            pending = []
left = [r for r in rows if r[6] == 'impl']
if left: raise SystemExit(f'@trace の無い impl の @row: {left}')
named = {t[0].split('!')[-1] for t in traces}
nexts = ''
for f, names in [('Run.tla', ['RInternal', 'REnv']), ('Issue.tla', ['INext']), ('Seam.tla', ['SNext'])]:
    txt = open(os.path.join(D, f)).read()
    for n in names:
        m = re.search(rf'^{n} ==(.*?)(?=^\S)', txt, re.S | re.M)
        nexts += m.group(1)
comp = open(os.path.join(D, 'Composed.tla')).read()
for n in ['Internal', 'Env', 'Filing']:
    nexts += re.search(rf'^{n} ==(.*?)(?=^\S)', comp, re.S | re.M).group(1)
nexts = re.sub(r'\(\*.*?\*\)', '', nexts, flags=re.S)
nexts = re.sub(r'\\\*.*', '', nexts)
used = set(re.findall(r'(?<![A-Za-z0-9_])(?:[RIS]!)?([A-Z]\w*)', nexts))
skip = {'E', 'A', 'BOOLEAN', 'UNCHANGED', 'ENABLED', 'RunOnly', 'IF', 'THEN', 'ELSE', 'Issues', 'CanAsk', 'Running', 'AnyPending', 'AnyAnswered', 'AnyAsked',
        'Verdict', 'Ready', 'Terminal', 'IBounded', 'PendingAfter', 'NoHold', 'HoldLeftIf', 'CanLose', 'MUT', 'OPT_W', 'Report', 'Filing'}
missing = sorted(u for u in used - skip - named if not u.startswith(('OPT_', 'MAX_')))
if 'Report' not in named: missing.append('Report')
if missing: raise SystemExit(f'@trace の無い action: {missing}')
with open(os.path.join(D, 'table.tsv'), 'w') as fh:
    fh.write('unit\tstate\tevent\tguard\tnext_state\toutput\tsource\n')
    fh.writelines('\t'.join(r) + '\n' for r in rows)
with open(os.path.join(D, 'trace.tsv'), 'w') as fh:
    fh.write('action\timpl_ref\timpl_quote\tnote\n')
    fh.writelines('\t'.join(r) + '\n' for r in traces)
print(len(rows), 'rows', len(traces), 'traces')
