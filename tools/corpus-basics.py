import json, glob, os
from collections import Counter

files = sorted(glob.glob('/var/lib/bindarr-dev/scandump/*.json'), key=os.path.getmtime)[-60:]
names = []
for f in files:
    try:
        d = json.load(open(f))
        n = (d.get('truth') or {}).get('name')
        if n:
            names.append(n)
    except Exception:
        pass

basics = {'plains', 'island', 'swamp', 'mountain', 'forest'}
c = Counter(names)
nb = sum(v for k, v in c.items() if k.lower() in basics)
print('labelled scans:', len(names), ' basic lands:', nb,
      f'({100*nb/max(1,len(names)):.0f}%)')
for k, v in c.most_common(10):
    print('  ', k, v)
