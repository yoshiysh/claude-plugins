# 読んだものの内訳（概算）。費用の精査 §5.1 の cat.py と同じ按分: ターンごとのコンテキストの増分を、直前の応答が
# 出した tool の結果の文字数で分ける。増分には model の出力と reminder も入り、並列の呼び出しは 1 つの増分を分け合う。
import json, glob, os, re, sys, collections

T = '/root/.claude/projects/-home-user-claude-plugins/bbfbc7eb-d042-5c7d-8fa6-ab266c5cd669/subagents/workflows/'
RUNS = ['wf_f413a4a5-c3e', 'wf_0f45ed55-8ba']
CATS = [('contracts', r'agent-contracts\.md'), ('rolefile', r'/agents/[a-z-]+\.md'),
        ('doc_check_src', r'doc_check\.mjs(?! (put|del|sha|flow|conflicts|questions|doc|tree-digest|snapshot|diff|report|get|describe))|sed -n [0-9,]+p [^|]*doc_check|grep[^|]*doc_check\.mjs'),
        ('references', r'references/'), ('resolutions', r'resolutions\.json|/tool-results/|--ledger resolutions'), ('flow', r'flow\.json|flow\.txt|--ledger flow'),
        ('verifications', r'verifications\.json|--ledger verifications'), ('input', r'input\.md'), ('answers', r'answers/'),
        ('doc', r'requirements-cleanup-branches\.md|meta\.json'), ('findings', r'findings/'), ('checks', r'checks/'),
        ('decisions', r'decisions\.json|plan\.json|open\.json|precedent|--ledger (decisions|open)')]


def text_of(c):
    return c if isinstance(c, str) else ''.join(y.get('text', '') for y in (c or []) if isinstance(y, dict))


def agent(path):
    msgs = collections.OrderedDict()
    tools, res = {}, {}
    for l in open(path):
        d = json.loads(l)
        m = d.get('message')
        if not isinstance(m, dict):
            continue
        c = m.get('content')
        if d.get('type') == 'assistant' and isinstance(m.get('usage'), dict):
            mid = m.get('id')
            u = m['usage']
            msgs.setdefault(mid, 0)
            msgs[mid] = max(msgs[mid], u.get('input_tokens', 0) + u.get('cache_read_input_tokens', 0) + u.get('cache_creation_input_tokens', 0))
            for x in c if isinstance(c, list) else []:
                if isinstance(x, dict) and x.get('type') == 'tool_use':
                    tools[x['id']] = (list(msgs).index(mid), x['name'], json.dumps(x['input'], ensure_ascii=False))
        if isinstance(c, list):
            for x in c:
                if isinstance(x, dict) and x.get('type') == 'tool_result':
                    res[x['tool_use_id']] = len(text_of(x.get('content')))
    ctx = list(msgs.values())
    byturn = collections.defaultdict(list)
    for tid, (k, name, arg) in tools.items():
        byturn[k + 1].append((name, arg, res.get(tid, 0)))
    cat = collections.Counter()
    for k, ts in byturn.items():
        if k >= len(ctx):
            continue
        d = max(0, ctx[k] - ctx[k - 1])
        tc = sum(t[2] for t in ts)
        for name, arg, n in ts:
            share = d * (n / tc) if tc else d / len(ts)
            c = 'other'
            for cn, rx in CATS:
                if re.search(rx, arg):
                    c = cn
                    break
            if name in ('Write', 'Edit'):
                c = 'write/edit'
            cat[c] += share
    return {'first': ctx[0] if ctx else 0, 'cat': cat}


tot, first, n = collections.Counter(), 0, 0
for wf in RUNS:
    for p in sorted(glob.glob(T + wf + '/agent-*.jsonl')):
        a = agent(p)
        tot += a['cat']
        first += a['first']
        n += 1
json.dump({'agents': n, 'first_turn_context_sum': first, 'by_category_tokens_estimate': {k: round(v) for k, v in tot.most_common()},
           'sum_categories': round(sum(tot.values()))}, open(sys.argv[1], 'w'), ensure_ascii=False, indent=1)
print(n, first, {k: round(v) for k, v in tot.most_common()})
