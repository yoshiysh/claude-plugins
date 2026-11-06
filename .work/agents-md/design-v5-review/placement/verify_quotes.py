import sys,re
R=sys.argv[1]; P=sys.argv[2]
bad=0
for i,l in enumerate(open(P+'/findings.tsv').read().split('\n')[1:],2):
    if not l: continue
    c=l.split('\t')
    assert len(c)==6,(i,len(c))
    path,ln=c[4].rsplit(':',1)
    text=open(R+'/'+path).read().split('\n')[int(ln)-1]
    norm=lambda s:re.sub(r'\s','',s)
    if norm(c[5]) not in norm(text) or not c[5]:
        bad+=1; print('BAD',i,c[0],c[4])
print('bad',bad)
