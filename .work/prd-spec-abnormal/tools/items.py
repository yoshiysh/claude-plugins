import re, sys, pathlib
R = pathlib.Path(__file__).resolve().parents[3]
rows = []
for f in sys.argv[2:]:
    lines = (R / f).read_text().splitlines()
    cur = None; start = 0; body = []
    def flush(end):
        if cur: rows.append((cur, f, start, end, ' '.join(x.strip() for x in body if x.strip())))
    for i, l in enumerate(lines, 1):
        m = re.match(r'####\s+((?:PR|SP)-[A-Z]+-\d+)', l)
        if m or re.match(r'#{1,3}\s', l):
            flush(i - 1); cur = m.group(1) if m else None; start = i; body = []
            continue
        if cur: body.append(l)
    flush(len(lines))
with open(sys.argv[1], 'w') as w:
    w.write('item\tfile\tfrom\tto\ttext\n')
    for r in rows: w.write('\t'.join(map(str, r[:4])) + '\t' + r[4].replace('\t', ' ') + '\n')
print(len(rows))
