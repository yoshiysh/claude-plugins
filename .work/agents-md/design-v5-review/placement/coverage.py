import re,sys
R=sys.argv[1]
lines=open(R+'/AGENTS.md').read().split('\n')
cov=set()
for row in open(R+'/.work/agents-md/design-v5-review/views/main-lines.decisions.tsv').read().split('\n')[1:]:
    if not row: continue
    m=re.match(r'L(\d+)(?:-(\d+))?',row.split('\t')[0])
    a=int(m.group(1)); b=int(m.group(2) or a)
    cov.update(range(a,b+1))
for i,l in enumerate(lines,1):
    if l.strip() and i not in cov: print(i,l[:80])
