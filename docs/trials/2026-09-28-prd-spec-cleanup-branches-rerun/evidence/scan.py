import json,glob,os,re,sys
T='/root/.claude/projects/-home-user-claude-plugins/bbfbc7eb-d042-5c7d-8fa6-ab266c5cd669/subagents/workflows/'
RUNS=['wf_cfb5b04b-b59','wf_1ff7d0e4-637','wf_aee918a8-e02','wf_f679c9fb-dd6']
labels={}
for i in range(1,5):
    d=json.load(open(f'/tmp/claude-0/-home-user-claude-plugins/bbfbc7eb-d042-5c7d-8fa6-ab266c5cd669/scratchpad/rerun/run{i}.output'))
    for a in d['workflowProgress']:
        if a['type']=='workflow_agent': labels[a['agentId']]=(i,a['label'])
rows=[]
for wf in RUNS:
    for p in sorted(glob.glob(T+wf+'/agent-*.jsonl')):
        aid=os.path.basename(p)[6:-6]
        uses={}
        for l in open(p):
            d=json.loads(l); c=d.get('message',{}).get('content') if isinstance(d.get('message'),dict) else None
            if not isinstance(c,list): continue
            for x in c:
                if not isinstance(x,dict): continue
                if x.get('type')=='tool_use': uses[x['id']]=(x['name'],x['input'],d.get('timestamp'))
                if x.get('type')=='tool_result' and x.get('tool_use_id') in uses:
                    n,inp,ts=uses[x['tool_use_id']]
                    cc=x.get('content'); t=cc if isinstance(cc,str) else ''.join(y.get('text','') for y in cc if isinstance(y,dict))
                    rows.append(dict(run=labels[aid][0],label=labels[aid][1],agent=aid,tool=n,input=inp,err=bool(x.get('is_error')),out=t,ts=ts))
json.dump(rows,open(sys.argv[1],'w'),ensure_ascii=False)
print(len(rows))
