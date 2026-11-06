import sys, csv, re, pathlib
R = pathlib.Path(__file__).resolve().parents[3]
def norm(s): return re.sub(r'\s+', '', s)
cache = {}
def text(p):
    p = p.strip()
    for cand in [R / p, R / 'docs/requirements' / p, R / 'docs/specifications' / p,
                 R / 'plugins/workflow/workflows' / p, R / 'plugins/workflow/skills/prd-spec/scripts' / p,
                 R / 'plugins/workflow/skills/prd-spec' / p, R / 'plugins/workflow/skills/prd-spec/references' / p]:
        if cand.is_file():
            cache.setdefault(cand, norm(cand.read_text()))
            return cache[cand]
    return None
def files(ref):
    out = []
    for part in ref.split(';'):
        m = re.match(r'\s*([^\s:]+\.(?:md|js|mjs|json))', part)
        if m: out.append(m.group(1))
    return out
bad = 0; n = 0
for path in sys.argv[1:]:
    rows = list(csv.DictReader(open(path), delimiter='\t'))
    for r in rows:
        for refk, qk in (('doc_ref', 'doc_quote'), ('impl_ref', 'impl_quote')):
            q = (r.get(qk) or '').strip()
            if q in ('', '-'): continue
            n += 1
            segs = [s for s in re.split(r'\s*(?:…|\.\.\.|／|\s/\s)\s*', q) if norm(s)]
            texts = [t for t in (text(f) for f in files(r.get(refk) or '')) if t]
            ok = texts and all(any(norm(s) in t for t in texts) for s in segs)
            if not ok:
                bad += 1; print(f"NG\t{path}\t{r['id']}\t{qk}\t{q[:80]}")
print(f"checked={n} ng={bad}")
