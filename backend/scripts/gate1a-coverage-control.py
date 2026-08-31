#!/usr/bin/env python3
"""NEGATIVE CONTROL for gate1a-coverage.py.

The coverage check reported 100.00% with zero misses in every bucket.  That is
either a real result or a check that cannot fail.  This tells them apart: it
re-runs the same matching logic against a DELIBERATELY DAMAGED index with 5% of
the artwork keys removed.  If coverage still reports ~100%, the check is
broken and its PASS means nothing.  It should report ~95%.
"""
import json
import gzip
import random

idx = json.load(open('hash-index/rgbart-index.json'))
keys = [c['key'] for c in idx['cards']]
random.seed(1)
drop = set(random.sample(keys, len(keys) // 20))
idx_keys = set(keys) - drop
print(f'damaged index: removed {len(drop)} of {len(keys)} keys')

cc = json.load(open('hash-index/card_cache.json'))


def open_maybe_gz(p):
    with open(p, 'rb') as f:
        gz = f.read(2) == b'\x1f\x8b'
    return gzip.open(p, 'rt', encoding='utf-8') if gz else open(p, encoding='utf-8')


lookup = {}
with open_maybe_gz('hash-index/default_cards.json') as f:
    for line in f:
        t = line.strip().rstrip(',')
        if not t or t in '[]':
            continue
        try:
            c = json.loads(t)
        except Exception:
            continue
        ill = (c.get('illustration_id')
               or (c.get('card_faces') or [{}])[0].get('illustration_id')
               or c.get('id'))
        lookup[(c.get('set', '').lower(), str(c.get('collector_number', '')).lower())] = ill

cov = sum(1 for r in cc
          if lookup.get((str(r.get('set') or '').lower(),
                         str(r.get('number') or '').lower())) in idx_keys)
pct = 100 * cov / len(cc)
print(f'coverage against damaged index: {pct:.2f}%  ({cov}/{len(cc)})')
print('CONTROL', 'PASS - the check detects missing artwork' if pct < 99
      else 'FAIL - check is vacuous, it cannot detect a broken index')
