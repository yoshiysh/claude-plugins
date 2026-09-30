import json, re, sys, os, statistics, collections
from datetime import datetime

E = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(E, '../../../..'))
MAIN = '/root/.claude/projects/-home-user-claude-plugins/bbfbc7eb-d042-5c7d-8fa6-ab266c5cd669.jsonl'
W = '/home/user/claude-plugins/plugins/workflow/skills/prd-spec/workspace/cleanup-branches'
RUNS = ['wf_f413a4a5-c3e', 'wf_0f45ed55-8ba']
sys.path.insert(0, os.path.join(REPO, 'plugins/workflow/skills/prd-spec/tests'))
import test_launch_reasons as TLR  # noqa: E402

rows = json.load(open(sys.argv[1]))
prompts = json.load(open(sys.argv[2]))
usage = json.load(open(f'{E}/usage.json'))
usage01 = json.load(open(f'{E}/usage-weights-0.1.json'))
copies = json.load(open(f'{E}/stdout-copies.json'))
outs = {i: json.load(open(f'{E}/run-outputs/run{i}.output.json')) for i in range(1, 6)}
out = {}


def ts(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()


# 1. agents: live / replayed per Workflow call, journal counts
live, replayed = {}, collections.defaultdict(list)
for i in range(1, 6):
    for a in outs[i]['workflowProgress']:
        if a['type'] != 'workflow_agent':
            continue
        if a.get('tokens') is None:
            replayed[i].append(a['label'])
        else:
            live[a['agentId']] = {'run': i, 'label': a['label'], 'model': a['model'], 'tokens': a['tokens'], 'durationMs': a['durationMs']}
journal = {}
for wf in RUNS:
    c = collections.Counter(json.loads(l)['type'] for l in open(f'{E}/journal-{wf}.jsonl') if l.strip())
    journal[wf] = dict(c)
out['agents'] = {
    'live_per_run': {i: sum(1 for v in live.values() if v['run'] == i) for i in range(1, 6)},
    'live_total': len(live),
    'replayed_per_run': {i: len(replayed[i]) for i in range(1, 6)},
    'replayed_total': sum(len(v) for v in replayed.values()),
    'agentCount_per_run': {i: outs[i]['agentCount'] for i in range(1, 6)},
    'journal_types': journal,
    'live_tokens_sum_per_run': {i: sum(v['tokens'] for v in live.values() if v['run'] == i) for i in range(1, 6)},
    'totalTokens_per_run': {i: outs[i]['totalTokens'] for i in range(1, 6)},
    'totalToolCalls_per_run': {i: outs[i]['totalToolCalls'] for i in range(1, 6)},
    'live_durationMs_sum_per_run': {i: sum(v['durationMs'] for v in live.values() if v['run'] == i) for i in range(1, 6)},
    'labels_per_run': {i: [v['label'] for v in live.values() if v['run'] == i] for i in range(1, 6)},
}
lab_count = collections.Counter(v['label'] for v in live.values())
out['agents']['labels_launched_more_than_once'] = {k: n for k, n in lab_count.items() if n > 1}

# 2. launch reasons (test_launch_reasons at HEAD)
fam_reason = {name: reason for name, reason, _, _ in TLR.LABEL_FAMILIES}
launches, bad = [], []
for aid, v in live.items():
    fams = TLR.families_of(v['label'])
    if len(fams) != 1:
        bad.append({'label': v['label'], 'families': fams})
        continue
    p = prompts[aid]['prompt']
    clues = [reason for fam, reason, frag in TLR.PROMPT_CLUES if fam == fams[0] and frag in p]
    launches.append({'run': v['run'], 'label': v['label'], 'family': fams[0], 'reason': fam_reason[fams[0]], 'prompt_clues': clues, 'tokens': v['tokens']})
by_family = collections.OrderedDict()
for name, reason, _, _ in TLR.LABEL_FAMILIES:
    got = [x for x in launches if x['family'] == name]
    if got:
        by_family[name] = {'reason': reason, 'launches': len(got), 'tokens': sum(x['tokens'] for x in got), 'per_run': dict(collections.Counter(x['run'] for x in got)), 'labels': sorted(collections.Counter(x['label'] for x in got).items())}
clue_counts = collections.Counter(c for x in launches for c in x['prompt_clues'])
out['launch_reasons'] = {'unclassified': bad, 'by_family': by_family, 'prompt_clue_counts': dict(clue_counts),
                         'launches_with_clues': [x for x in launches if x['prompt_clues']]}
sk = []
for i in range(1, 6):
    labs = {v['label'] for v in live.values() if v['run'] == i}
    for s in outs[i]['result'].get('skipped') or []:
        sk.append({'run': i, **s, 'label_launched_in_this_run': s['step'] in labs})
out['skipped'] = sk

# 3. run results
res = {}
for i in range(1, 6):
    r = outs[i]['result']
    na = r.get('next_args')
    res[i] = {'status': r['status'], 'gate': r.get('gate'), 'question_ids': r.get('question_ids'), 'reason': r.get('reason'),
              'holds': r.get('holds'), 'hold_drafts': r.get('hold_drafts'), 'open_tbd': r.get('open_tbd'), 'integrity': r.get('integrity'),
              'notices_count': len(r.get('notices') or []), 'notices': r.get('notices'), 'passes': r.get('passes'), 'stop_reason': r.get('stop_reason'),
              'remaining_blocking': r.get('remaining_blocking'), 'resumable': r.get('resumable'),
              'next_args_chars': len(json.dumps(na, ensure_ascii=False)) if na else None,
              'next_args_state_has_flow': ('flow' in (na.get('state') or {})) if na else None,
              'next_args_state_keys': sorted((na.get('state') or {}).keys()) if na else None}
out['run_results'] = res

# 4. usage split per Workflow call, cache at run starts, first-turn stats
pa = {r['file'][6:-6]: r for r in usage['per_agent']}
pa01 = {r['file'][6:-6]: r for r in usage01['per_agent']}
F = ('input', 'cache_read', 'cache_creation', 'cache_creation_5m', 'cache_creation_1h', 'output', 'turns')
per_run = {}
for i in range(1, 6):
    ids = [a for a, v in live.items() if v['run'] == i]
    rs = [pa[a] for a in ids]
    tot = {k: sum(r[k] for r in rs) for k in F}
    tot['input_all'] = tot['input'] + tot['cache_read'] + tot['cache_creation']
    tot['cache_read_share'] = round(tot['cache_read'] / tot['input_all'], 4)
    wi = 0.0
    for a in ids:
        wi += (pa[a] if 'opus' in pa[a]['model'] else pa01[a])['weighted_input']
    tot['weighted_input_model_matched'] = round(wi, 1)
    srt = sorted(ids, key=lambda a: pa[a]['start'])
    first = pa[srt[0]]
    first_opus = next(pa[a] for a in srt if 'opus' in pa[a]['model'])
    tot['first_agent'] = {'label': first['label'], 'model': first['model'], 'first_turn': first['first_turn']}
    tot['first_opus_agent'] = {'label': first_opus['label'], 'first_turn': first_opus['first_turn']}
    tot['start'] = min(pa[a]['start'] for a in ids)
    tot['end'] = max(pa[a]['start'] + pa[a]['seconds'] for a in ids)
    per_run[i] = tot
for i in range(2, 6):
    per_run[i]['idle_before_seconds'] = round(per_run[i]['start'] - per_run[i - 1]['end'], 1)
out['usage_per_run'] = per_run
wm = {}
for m, v in usage['by_model'].items():
    wm[m] = v['weighted_input'] if 'opus' in m else usage01['by_model'][m]['weighted_input']
out['weighted_input_by_model_matched'] = {'by_model': wm, 'total': round(sum(wm.values()), 2),
                                          'note': 'opus は --weights 0.05,1.25,2 の usage.json、haiku・sonnet は 0.1,1.25,2 の usage-weights-0.1.json から取った'}


def stats(v):
    return {'n': len(v), 'min': min(v), 'max': max(v), 'mean': round(statistics.mean(v), 1), 'median': statistics.median(v)} if v else None


ft = collections.defaultdict(list)
for a, r in pa.items():
    ft[r['model']].append(r['first_turn_input'])
out['first_turn_input_by_model'] = {m: stats(v) for m, v in ft.items()}
out['first_turn_cache_read_positive'] = {m: sum(1 for a, r in pa.items() if r['model'] == m and r['first_turn']['cache_read'] > 0) for m in ft}
fam_of = {a: TLR.families_of(v['label'])[0] for a, v in live.items() if len(TLR.families_of(v['label'])) == 1}
role_of = {a: re.sub(r'[:].*$', '', v['label']) for a, v in live.items()}
same = {'first_of_group': [], 'later_in_group': []}
for i in range(1, 6):
    groups = collections.defaultdict(list)
    for a, v in live.items():
        if v['run'] == i:
            groups[(pa[a]['model'], role_of[a])].append(a)
    for g, ids in groups.items():
        ids.sort(key=lambda a: pa[a]['start'])
        for k, a in enumerate(ids):
            ftn = pa[a]['first_turn']
            same['first_of_group' if k == 0 else 'later_in_group'].append({'run': i, 'group': list(g), 'label': live[a]['label'], 'first_turn_cache_read': ftn['cache_read'], 'first_turn_cache_creation': ftn['cache_creation'],
                                                                             'gap_from_prev_in_group_s': None if k == 0 else round(pa[a]['start'] - pa[ids[k - 1]]['start'], 1)})
out['same_role_first_turn'] = {k: {'n': len(v), 'cache_read_positive': sum(1 for x in v if x['first_turn_cache_read'] > 0), 'rows': v} for k, v in same.items()}
out['first_turn_cache_read_positive_all'] = {'n': len(pa), 'positive': sum(1 for r in pa.values() if r['first_turn']['cache_read'] > 0)}

# 4b. first-turn cache_read vs the gap since the last activity of an earlier agent of the same model and role
# (implementer と grounding は同じ組に数える。どちらも opus / high で監査の schema)
AUDIT = {'implementer': 'audit', 'grounding': 'audit'}
ua = sorted(({**r, 'end': r['start'] + r['seconds'], 'role': re.sub(r':.*', '', r['label'])} for r in usage['per_agent']), key=lambda r: r['start'])
gap_rows, tab = [], collections.Counter()
for k, r in enumerate(ua):
    g = (r['model'], AUDIT.get(r['role'], r['role']))
    prev = [p for p in ua[:k] if (p['model'], AUDIT.get(p['role'], p['role'])) == g]
    gap = None if not prev else round(r['start'] - max(p['end'] for p in prev), 1)
    b = 'none' if gap is None else ('overlap' if gap < 0 else ('lt300' if gap < 300 else ('300to3600' if gap < 3600 else 'ge3600')))
    hit = r['first_turn']['cache_read'] > 0
    tab[f"{'haiku' if 'haiku' in r['model'] else 'opus_sonnet'}|{b}|{'hit' if hit else 'miss'}"] += 1
    gap_rows.append({'label': r['label'], 'model': r['model'], 'gap_s': gap, 'bucket': b, 'first_turn_cache_read': r['first_turn']['cache_read'], 'first_turn_cache_creation': r['first_turn']['cache_creation']})
out['first_turn_cache_vs_gap'] = {'table': dict(sorted(tab.items())), 'rows': gap_rows,
                                  'miss_300to3600_first_turn_cache_creation': sum(x['first_turn_cache_creation'] for x in gap_rows if x['bucket'] == '300to3600' and not x['first_turn_cache_read']),
                                  'hit_first_turn_cache_read_values': sorted({x['first_turn_cache_read'] for x in gap_rows if x['first_turn_cache_read']})}

# 4b2. 同じ役の前から 300 秒以上空いて外れた opus・sonnet の初回ターンのうち、別の役の同じ model の agent が 300 秒以内に動いていたもの
cross = []
for k, r in enumerate(ua):
    if 'haiku' in r['model'] or r['first_turn']['cache_read'] > 0:
        continue
    g = AUDIT.get(r['role'], r['role'])
    same_ = [p for p in ua[:k] if p['model'] == r['model'] and AUDIT.get(p['role'], p['role']) == g]
    if not same_ or r['start'] - max(p['end'] for p in same_) < 300:
        continue
    other = [p['label'] for p in ua if p is not r and p['model'] == r['model'] and AUDIT.get(p['role'], p['role']) != g and p['start'] < r['start'] and r['start'] - p['end'] < 300]
    cross.append({'label': r['label'], 'other_role_within_300s': other})
out['cross_role_check'] = {'misses_same_role_gap_ge300': len(cross), 'with_other_role_within_300s': sum(1 for x in cross if x['other_role_within_300s']), 'rows': cross}
cwds = collections.Counter()
for wf in RUNS:
    for fn in sorted(os.listdir(os.path.join(os.path.dirname(MAIN), 'bbfbc7eb-d042-5c7d-8fa6-ab266c5cd669/subagents/workflows', wf))):
        if fn.endswith('.jsonl') and fn.startswith('agent-'):
            s_ = set()
            for l in open(os.path.join(os.path.dirname(MAIN), 'bbfbc7eb-d042-5c7d-8fa6-ab266c5cd669/subagents/workflows', wf, fn)):
                d = json.loads(l)
                if 'cwd' in d:
                    s_.add(d['cwd'])
            cwds['|'.join(sorted(s_))] += 1
out['transcript_cwd'] = dict(cwds)

# 4c. 推測: 1 時間の TTL なら 300〜3600 秒の空きで外れた初回ターンが、同じ組で観測した最大の cache_read の分だけ読みに変わるとみなす。
# 書き込みはすべて 1 時間の倍率になる。倍率は usage.json / usage-weights-0.1.json の weights（claude-api スキルの料金表）から取る
hitmax = collections.defaultdict(int)
for x, r in zip(gap_rows, ua):
    g = (r['model'], AUDIT.get(r['role'], r['role']))
    hitmax[g] = max(hitmax[g], x['first_turn_cache_read'])
est = {}
for m, v in usage['by_model'].items():
    w = (usage if 'opus' in m else usage01)['weights']
    moved = sum(hitmax[(r['model'], AUDIT.get(r['role'], r['role']))] for x, r in zip(gap_rows, ua) if r['model'] == m and x['bucket'] == '300to3600' and not x['first_turn_cache_read'])
    now = v['cache_read'] * w['cache_read'] + v['cache_creation_5m'] * w['cache_creation_5m']
    alt = (v['cache_read'] + moved) * w['cache_read'] + (v['cache_creation_5m'] - moved) * w['cache_creation_1h']
    est[m] = {'moved_write_to_read': moved, 'cache_weighted_now': round(now, 1), 'cache_weighted_1h_estimate': round(alt, 1), 'diff': round(alt - now, 1)}
out['ttl_1h_estimate'] = est

# 4d. 役（label の最初の : の前）ごとの起動と tokens。前回の再試走は agents_by_run.json から
prev = json.load(open(os.path.join(E, '../../2026-09-28-prd-spec-cleanup-branches-rerun/evidence/agents_by_run.json')))
role = lambda l: re.sub(r':.*', '', l)
rc = collections.defaultdict(lambda: {'prev_launches': 0, 'prev_tokens': 0, 'launches': 0, 'tokens': 0})
for a in prev:
    rc[role(a['label'])]['prev_launches'] += 1
    rc[role(a['label'])]['prev_tokens'] += a['tokens']
for v in live.values():
    rc[role(v['label'])]['launches'] += 1
    rc[role(v['label'])]['tokens'] += v['tokens']
out['role_counts_vs_rerun'] = dict(sorted(rc.items()))
defect = [x for x in launches if x['run'] == 4 and x['label'] in ('flow-check:3a-entry', 'flow-check:g0-2-answers', 'resolver:3a', 'flow-check:3a')]
out['rerun_from_3a_after_fix'] = {'launches': len(defect), 'tokens': sum(x['tokens'] for x in defect), 'labels': [x['label'] for x in defect]}

# 5. stdout copies
cs = collections.defaultdict(lambda: {'n': 0, 'chars': 0, 'max_chars': 0})
for c in copies:
    k = f"{'7d06d97' if c['run'] >= 4 else '7a208d0'}|{c['model']}|{c['status']}"
    cs[k]['n'] += 1
    cs[k]['chars'] += c['chars']
    cs[k]['max_chars'] = max(cs[k]['max_chars'], c['chars'])
out['stdout_copies'] = {'by_version_model_status': dict(cs), 'faults': [c for c in copies if c['status'] in ('bad_json', 'fnv_mismatch')],
                        'recopy_launches': [x['label'] for x in launches if x['family'] == 'recopy']}
out['rulings_flow_check_chars'] = [{'run': c['run'], 'label': c['label'], 'model': c['model'], 'chars': c['chars'], 'status': c['status']} for c in copies if c['field'] == 'flow_check' and (c['label'].startswith('verifier') or c['label'].startswith('flow-check'))]

# 6. doc_check outputs in agent Bash calls
stderr, flowouts, conf = [], [], []
for r in rows:
    if r['tool'] != 'Bash':
        continue
    for e in re.findall(r'^doc_check [a-z-]+:.*$', r['out'], re.M):
        stderr.append({'run': r['run'], 'label': r['label'], 'ts': r['ts'], 'line': e})
    for m in re.findall(r'^\{"findings":\d+,"codes":.*$', r['out'], re.M):
        try:
            j = json.loads(m)
        except json.JSONDecodeError:
            continue
        flowouts.append({'run': r['run'], 'label': r['label'], 'ts': r['ts'], 'findings': j['findings'], 'codes': j['codes'], 'open': j.get('open'), 'unverified_n': len(j.get('unverified') or []), 'rulings': 'rulings' in j})
    for m in re.findall(r'^\{"pairs":\d+.*$', r['out'], re.M):
        try:
            j = json.loads(m)
        except json.JSONDecodeError:
            continue
        conf.append({'run': r['run'], 'label': r['label'], 'pairs': j['pairs'], 'constraint_pairs': j.get('constraint_pairs'), 'self_sourced': j.get('self_sourced'), 'untargeted': j.get('untargeted')})
out['doc_check_stderr_lines'] = stderr
out['doc_check_flow_outputs'] = {'n': len(flowouts), 'findings_nonzero': sum(1 for x in flowouts if x['findings']), 'codes_nonempty': [x for x in flowouts if x['codes']], 'rows': flowouts}
out['doc_check_conflicts_outputs'] = {'n': len(conf), 'self_sourced_nonzero': [x for x in conf if x['self_sourced']], 'rows': conf}
out['permission_denials'] = [{'run': r['run'], 'label': r['label'], 'ts': r['ts'], 'text': r['out'][:160]} for r in rows if 'Permission to use' in r['out'] and 'has been denied' in r['out']]

# 7. writes outside W
ow = []
for r in rows:
    if r['tool'] in ('Write', 'Edit') and not r['input']['file_path'].startswith(W + '/'):
        ow.append({'run': r['run'], 'label': r['label'], 'tool': r['tool'], 'path': r['input']['file_path']})
    if r['tool'] == 'Bash':
        cmd = r['input']['command']
        if re.search(r'/tmp/claude-0|scratchpad|~/|\$HOME|/root/|(?<![\w/])/tmp/', cmd):
            ow.append({'run': r['run'], 'label': r['label'], 'tool': 'Bash', 'ts': r['ts'], 'paths': re.findall(r'scratchpad/[A-Za-z0-9._-]+', cmd), 'redirect_into_scratchpad': bool(re.search(r'>\s*/tmp/claude-0\S*scratchpad', cmd)), 'command': cmd[:300]})
out['commands_touching_outside_W'] = ow
out['write_edit_paths'] = sorted({r['input']['file_path'] for r in rows if r['tool'] in ('Write', 'Edit')})

# 8. main transcript: Workflow calls, AskUserQuestion
wf, auq, pend = [], [], {}
for l in open(MAIN):
    d = json.loads(l)
    t = d.get('timestamp', '')
    if not ('2026-09-29T20:40' <= t <= '2026-09-30T05:40'):
        continue
    m = d.get('message')
    c = m.get('content') if isinstance(m, dict) else None
    if not isinstance(c, list):
        continue
    for x in c:
        if not isinstance(x, dict):
            continue
        if x.get('type') == 'tool_use' and x['name'] == 'Workflow':
            inp = x['input']
            a = inp.get('args') or {}
            wf.append({'ts': t, 'name': inp.get('name'), 'scriptPath': inp.get('scriptPath'), 'resumeFromRunId': inp.get('resumeFromRunId'), 'from': a.get('from'),
                       'gates_answered': {k: len(v) for k, v in (a.get('gates_answered') or {}).items()}, 'result_head': None})
            pend[x['id']] = wf[-1]
        if x.get('type') == 'tool_use' and x['name'] == 'AskUserQuestion':
            auq.append({'ts': t, 'questions': len(x['input']['questions']), 'answered_ts': None})
            pend[x['id']] = auq[-1]
        if x.get('type') == 'tool_result' and x.get('tool_use_id') in pend:
            txt = x.get('content') if isinstance(x.get('content'), str) else ''.join(y.get('text', '') for y in x.get('content') or [] if isinstance(y, dict))
            rec = pend.pop(x['tool_use_id'])
            if 'questions' in rec:
                rec['answered_ts'] = t
            else:
                rec['result_head'] = txt[:120]
                rec['is_error'] = bool(x.get('is_error'))
out['main_workflow_calls'] = wf
na3 = outs[3]['result']['next_args']
eq = {}
for l in open(MAIN):
    if '"Workflow"' not in l:
        continue
    d = json.loads(l)
    for x in (d.get('message') or {}).get('content') or []:
        if isinstance(x, dict) and x.get('type') == 'tool_use' and x['name'] == 'Workflow':
            a = x['input'].get('args') or {}
            if a.get('from') and d['timestamp'] >= '2026-09-29T20:40':
                eq[d['timestamp']] = {'resume': x['input'].get('resumeFromRunId'), 'args_minus_gates_answered_equals_run3_next_args': {k: v for k, v in a.items() if k != 'gates_answered'} == na3}
out['workflow_args_vs_next_args'] = eq
out['main_ask_user_question'] = auq

# 9. findings per pass
fp, reversal = {}, []
dirs = collections.defaultdict(list)
for rn in range(1, 5):
    fs = []
    for f in sorted(os.listdir(f'{E}/findings')):
        if f.startswith(f'r{rn}-'):
            fs += json.load(open(f'{E}/findings/{f}'))['findings']
    ob = collections.Counter()
    for x in fs:
        ob[(x.get('origin'), x['blocking'])] += 1
        dirs[x['item_id']].append((rn, x.get('direction'), x['id']))
    fp[f'r{rn}'] = {'findings': len(fs), 'blocking': sum(1 for x in fs if x['blocking']), 'items': len({x['item_id'] for x in fs}),
                    'origin': {o: {'all': sum(v for (oo, b), v in ob.items() if oo == o), 'blocking': ob.get((o, True), 0)} for o in sorted({x.get('origin') for x in fs})},
                    'route': dict(collections.Counter(x.get('route') for x in fs)), 'blocking_items': sorted({x['item_id'] for x in fs if x['blocking']})}
for item, v in dirs.items():
    ds = [d for _, d, _ in v]
    if 'tighten' in ds and 'relax' in ds:
        reversal.append({'item': item, 'seq': v})
out['findings_per_pass'] = fp
out['direction_reversals'] = reversal
out['items_in_2plus_passes'] = {k: sorted({r for r, _, _ in v}) for k, v in dirs.items() if len({r for r, _, _ in v}) >= 2}

# 10. designated stdout copies of the audits
out['audit_designated_copies'] = [c for c in copies if c['label'].startswith(('crossDoc', 'grounding', 'implementer')) or 'recopy' in c['label']]

json.dump(out, open(sys.argv[3], 'w'), ensure_ascii=False, indent=1)
print('ok')
