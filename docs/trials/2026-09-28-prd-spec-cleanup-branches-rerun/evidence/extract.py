import json,re,glob,hashlib,sys
S='/tmp/claude-0/-home-user-claude-plugins/bbfbc7eb-d042-5c7d-8fa6-ab266c5cd669/scratchpad/'
MAIN='/root/.claude/projects/-home-user-claude-plugins/bbfbc7eb-d042-5c7d-8fa6-ab266c5cd669.jsonl'
T='/root/.claude/projects/-home-user-claude-plugins/bbfbc7eb-d042-5c7d-8fa6-ab266c5cd669/subagents/workflows/'
RUNS=['wf_cfb5b04b-b59','wf_1ff7d0e4-637','wf_aee918a8-e02','wf_f679c9fb-dd6']
W='/root/.claude/prd-spec-workspace-rerun/cleanup-branches'
rows=json.load(open(sys.argv[1]))
out={}
na={k:json.load(open(S+f'rerun/next_args_{k}.json')) for k in ['g0','g0-2','g1']}
out['next_args_chars']={k:len(json.dumps(v,ensure_ascii=False)) for k,v in na.items()}
out['next_args_has_state_flow']={k:('flow' in v['state']) for k,v in na.items()}
prev={'g0':'next_args_g0.json','g0-2':'next_args_g02.json','g1':'next_args_g1.json'}
out['prev_next_args']={k:{'chars_json_dumps':len(json.dumps(json.load(open(S+f),encoding='utf-8') if False else json.load(open(S+f)),ensure_ascii=False)),'file_bytes':len(open(S+f,'rb').read())} for k,f in prev.items()}
out['next_args_equal_run_result']={}
for i,k in [(1,'g0'),(2,'g0-2'),(3,'g1')]:
    out['next_args_equal_run_result'][k]=json.load(open(S+f'rerun/run{i}.output'))['result']['next_args']==na[k]
# main transcript: Workflow calls, AskUserQuestion, diagnostics args echo
dec=json.JSONDecoder(); auq=[]; wf=[]; echo={}
for l in open(MAIN):
    d=json.loads(l); ts=d.get('timestamp','')
    if ts<'2026-09-27T23:40': continue
    m=d.get('message'); c=m.get('content') if isinstance(m,dict) else None
    if isinstance(c,list):
        for x in c:
            if isinstance(x,dict) and x.get('type')=='tool_use':
                if x['name']=='AskUserQuestion': auq.append({'ts':ts,'questions':len(x['input']['questions'])})
                if x['name']=='Workflow':
                    a=x['input'].get('args'); wf.append({'ts':ts,'from':a.get('from'),'args_equals_next_args':[k for k,v in na.items() if v==a]})
    if d.get('type')=='user' and '<diagnostics>' in l:
        txt=c if isinstance(c,str) else ''.join(y.get('text','') for y in (c or []) if isinstance(y,dict))
        for dg in re.findall(r'<diagnostics>(.*?)</diagnostics>',txt,re.S):
            w=re.search(r'wf_[0-9a-f-]+',dg).group(0)
            if w in echo or w not in RUNS: continue
            i=dg.find('{"workspace"'); a,_=dec.raw_decode(dg[i:])
            echo[w]={'from':a.get('from'),'equals_next_args':[k for k,v in na.items() if v==a],'chars':len(json.dumps(a,ensure_ascii=False))}
out['main_transcript_workflow_calls']=wf
out['main_transcript_ask_user_question']=auq
out['diagnostics_args_echo']=echo
# doc_check rejections (stderr lines)
rej=[]
for r in rows:
    if r['tool']=='Bash' and 'doc_check.mjs' in r['input']['command']:
        for e in re.findall(r'^doc_check [a-z-]+:.*$',r['out'],re.M): rej.append({'run':r['run'],'label':r['label'],'agent':r['agent'],'ts':r['ts'],'stderr':e})
out['doc_check_stderr_lines']=rej
# flow checks
fc=[]
for r in rows:
    if r['tool']=='Bash' and re.search(r'doc_check\.mjs"?\s+flow\b|\$S flow\b',r['input']['command']):
        pass
    if r['tool']=='Bash':
        for m in re.findall(r'^\{"findings":\d+,"open":\d+,"path":"checks/flow\.json".*$',r['out'],re.M):
            j=json.loads(m); fc.append({'run':r['run'],'label':r['label'],'ts':r['ts'],'findings':j['findings'],'unverified':j.get('unverified')})
out['doc_check_flow_outputs']=fc
# writes outside W
ow=[]
for r in rows:
    if r['tool'] in ('Write','Edit') and not r['input']['file_path'].startswith(W+'/'): ow.append({'run':r['run'],'label':r['label'],'tool':r['tool'],'path':r['input']['file_path']})
    if r['tool']=='Bash' and '/tmp/claude-0' in r['input']['command']:
        ow.append({'run':r['run'],'label':r['label'],'tool':'Bash','ts':r['ts'],'err':r['err'],'command':r['input']['command'][-400:],'out':r['out'][:200]})
out['commands_touching_outside_W']=ow
out['write_edit_paths']=sorted({r['input']['file_path'] for r in rows if r['tool'] in ('Write','Edit')})
# verifier fails from journals
lab={}; vf=[]
for w in RUNS:
    for l in open(T+w+'/journal.jsonl'):
        d=json.loads(l)
        if d['type']=='started': lab[d['agentId']]=d['label']
        if d['type']=='result' and lab.get(d['agentId'],'').startswith('verifier'):
            vf.append({'wf':w,'label':lab[d['agentId']],'fail':[f.get('id') if isinstance(f,dict) else f for f in d['result'].get('fail',[])],'pass':d['result'].get('pass',[])})
out['verifier_fail']=vf
out['tool_calls_total']=len(rows)
json.dump(out,open(sys.argv[2],'w'),ensure_ascii=False,indent=1)
