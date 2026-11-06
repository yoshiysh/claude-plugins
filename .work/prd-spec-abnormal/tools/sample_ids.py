import csv, random, sys
seed = int(sys.argv[2]); n = int(sys.argv[3])
rows = list(csv.DictReader(open(sys.argv[1]), delimiter='\t'))
pick = sorted(random.Random(seed).sample([r['item'] for r in rows], min(n, len(rows))))
print(' '.join(pick))
