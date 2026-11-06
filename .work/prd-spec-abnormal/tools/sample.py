import csv, random, subprocess, sys, pathlib, json
SEED = 20261106
R = pathlib.Path(__file__).resolve().parents[3]
I = R / '.work/prd-spec-abnormal/inventory'
rng = random.Random(SEED)
weights = {'limit': 4, 'throw': 3, 'exit-error': 4, 'state-check': 4}
def strat(tsv, kindcol, base=2):
    rows = list(csv.DictReader(open(I / tsv), delimiter='\t'))
    by = {}
    for r in rows: by.setdefault(r[kindcol], []).append(r)
    out = []
    for k in sorted(by):
        n = min(len(by[k]), weights.get(k, base))
        out += rng.sample(by[k], n)
    return out
s1 = strat('impl-workflow.tsv', 'kind') + strat('impl-doccheck.tsv', 'kind') + strat('docs.tsv', 'kind')
pat = r'blocked|hold|status:|throw |process\.exit|exit\(|finalHold|next_args'
grep = []
for f in ['plugins/workflow/workflows/prd-spec.js', 'plugins/workflow/skills/prd-spec/scripts/doc_check.mjs']:
    o = subprocess.run(['grep', '-nE', pat, str(R / f)], capture_output=True, text=True).stdout.splitlines()
    grep += [f"{f}:{l}" for l in o]
s2 = rng.sample(grep, 25)
json.dump({'seed': SEED, 'grep_pattern': pat, 'grep_total': len(grep),
           'inventory_sample': [{k: r[k] for k in list(r)[:3]} for r in s1],
           'grep_sample': s2}, open(sys.argv[1], 'w'), ensure_ascii=False, indent=1)
print(len(s1), len(s2), len(grep))
