import json, glob, os, sys

E = os.path.dirname(os.path.abspath(__file__))
T = '/root/.claude/projects/-home-user-claude-plugins/bbfbc7eb-d042-5c7d-8fa6-ab266c5cd669/subagents/workflows/'
RUNS = ['wf_f413a4a5-c3e', 'wf_0f45ed55-8ba']


def live_agents():
    live, replayed = {}, []
    for i in range(1, 6):
        d = json.load(open(f'{E}/run-outputs/run{i}.output.json'))
        for a in d['workflowProgress']:
            if a['type'] != 'workflow_agent':
                continue
            if a.get('tokens') is None:
                replayed.append({'run': i, 'label': a['label'], 'agent': a['agentId'], 'live_run': live.get(a['agentId'], {}).get('run')})
            else:
                live[a['agentId']] = {'run': i, 'label': a['label'], 'index': a['index'], 'model': a['model'], 'tokens': a['tokens'], 'durationMs': a.get('durationMs'), 'toolCalls': a.get('toolCalls')}
    return live, replayed


def text_of(c):
    return c if isinstance(c, str) else ''.join(y.get('text', '') for y in (c or []) if isinstance(y, dict))


def main(out_rows, out_prompts):
    live, _ = live_agents()
    rows, prompts = [], {}
    for wf in RUNS:
        for p in sorted(glob.glob(T + wf + '/agent-*.jsonl')):
            aid = os.path.basename(p)[6:-6]
            info = live[aid]
            uses = {}
            for l in open(p):
                d = json.loads(l)
                m = d.get('message')
                c = m.get('content') if isinstance(m, dict) else None
                if d.get('type') == 'user' and aid not in prompts:
                    prompts[aid] = {'run': info['run'], 'label': info['label'], 'prompt': text_of(c)}
                if not isinstance(c, list):
                    continue
                for x in c:
                    if not isinstance(x, dict):
                        continue
                    if x.get('type') == 'tool_use':
                        uses[x['id']] = (x['name'], x['input'], d.get('timestamp'))
                    if x.get('type') == 'tool_result' and x.get('tool_use_id') in uses:
                        n, inp, ts = uses[x['tool_use_id']]
                        rows.append(dict(run=info['run'], wf=wf, label=info['label'], agent=aid, tool=n, input=inp, err=bool(x.get('is_error')), out=text_of(x.get('content')), ts=ts))
    json.dump(rows, open(out_rows, 'w'), ensure_ascii=False)
    json.dump(prompts, open(out_prompts, 'w'), ensure_ascii=False)
    print(len(rows), len(prompts))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
