import os, re, subprocess, sys
D = os.path.dirname(os.path.abspath(__file__))
V = os.path.dirname(D)
JAR = '/Users/yoshi/.local/share/tla/tla2tools.jar'

def tlc(name, cfg, extra=()):
    cmd = ['java', '-XX:+UseParallelGC', f'-Djava.io.tmpdir={V}/tmp', '-cp', JAR, 'tlc2.TLC', '-metadir', f'{V}/states/{name}',
           '-workers', '4', *extra, '-config', cfg, 'Composed.tla']
    out = subprocess.run(cmd, cwd=D, capture_output=True, text=True, timeout=900).stdout
    open(f'{V}/run/log-{name}.txt', 'a').write(out + '\n=====\n')
    return out

def states(out):
    m = re.findall(r'([\d,]+) distinct states found', out)
    return m[-1].replace(',', '') if m else '-'

def parse(path):
    txt = open(path).read()
    consts = re.search(r'CONSTANTS\n(.*?)\n(?=INVARIANTS|PROPERTIES|$)', txt, re.S).group(1)
    inv = (re.search(r'^INVARIANTS (.*)$', txt, re.M) or [None, ''])[1].split()
    props = (re.search(r'^PROPERTIES (.*)$', txt, re.M) or [None, ''])[1].split()
    return consts, inv, props

def write(name, consts, inv, props):
    p = f'{D}/tmp-{name}.cfg'
    s = 'SPECIFICATION Spec\nCONSTANTS\n' + consts + '\n'
    if inv: s += 'INVARIANTS ' + ' '.join(inv) + '\n'
    if props: s += 'PROPERTIES ' + ' '.join(props) + '\n'
    open(p, 'w').write(s)
    return p

rows = []
for name, cfg in [a.split('=') for a in sys.argv[1:]]:
    consts, inv, props = parse(f'{D}/{cfg}')
    left, flags = list(inv), []
    while left:
        out = tlc(name, write(name, consts, left, []), flags)
        st = states(out)
        v = re.findall(r'Error: Invariant (\w+) is violated', out)
        if 'Error: Deadlock reached' in out:
            rows.append((name, cfg, 'deadlock', st, 'violated')); flags = ['-deadlock']; continue
        if v:
            rows.append((name, cfg, v[0], st, 'violated')); left.remove(v[0]); continue
        errs = [l for l in out.splitlines() if l.startswith('Error:')]
        if errs:
            rows.append((name, cfg, 'tlc-error', st, errs[0])); break
        rows += [(name, cfg, p, st, 'pass') for p in left]; break
    for p in props:
        out = tlc(name, write(name, consts, [], [p]), ['-deadlock'])
        st = states(out)
        r = 'violated' if 'Temporal properties were violated' in out else ('error' if 'Error:' in out else 'pass')
        rows.append((name, cfg, p, st, r))
with open(f'{V}/run/raw-{sys.argv[1].split("=")[0]}.tsv', 'w') as fh:
    fh.writelines('\t'.join(r) + '\n' for r in rows)
print('\n'.join('\t'.join(r) for r in rows))
