#!/usr/bin/env python3
"""GATE 1a, part 2 — does the index cover what the app actually has?

THE TRAP THIS AVOIDS: the index is deduplicated by illustration_id, so it keeps
ONE printing per artwork.  Most card_cache rows are therefore NOT present in the
index by (set, number) -- yet their artwork IS covered, which is all recall
needs.  Naively matching on (set, number) would report ~70% coverage and fail a
gate that actually passes.

So: resolve each card_cache row through the Scryfall bulk file to its
illustration_id, then ask whether THAT is in the index.  That is the real
question -- "if Zach scans this card, can recall identify it?"

Reports the residue by reason, because 'uncovered' has three very different
causes and only one of them is a defect.
"""
import json
import gzip
import collections

BULK = 'hash-index/default_cards.json'
IDX = 'hash-index/rgbart-index.json'
CC = 'hash-index/card_cache.json'


def open_maybe_gz(p):
    with open(p, 'rb') as f:
        magic = f.read(2)
    return gzip.open(p, 'rt', encoding='utf-8') if magic == b'\x1f\x8b' else open(p, encoding='utf-8')


print('loading index...', flush=True)
idx = json.load(open(IDX))
idx_keys = {c['key'] for c in idx['cards']}
print(f'  {len(idx_keys)} artwork keys')

print('loading card_cache...', flush=True)
cc = json.load(open(CC))
print(f'  {len(cc)} rows')

# (set, number) -> (illustration_id, games) for every printing Scryfall knows
print('streaming bulk...', flush=True)
lookup = {}
with open_maybe_gz(BULK) as f:
    for line in f:
        t = line.strip().rstrip(',')
        if not t or t in '[]':
            continue
        try:
            c = json.loads(t)
        except Exception:
            continue
        ill = c.get('illustration_id') or (c.get('card_faces') or [{}])[0].get('illustration_id') or c.get('id')
        lookup[(c.get('set', '').lower(), str(c.get('collector_number', '')).lower())] = (
            ill, tuple(c.get('games') or ()))
print(f'  {len(lookup)} printings indexed by (set, number)')

reasons = collections.Counter()
misses = []
for r in cc:
    k = (str(r.get('set') or '').lower(), str(r.get('number') or '').lower())
    hit = lookup.get(k)
    if hit is None:
        reasons['not_in_scryfall_bulk'] += 1
        misses.append(('not_in_bulk', r))
        continue
    ill, games = hit
    if ill in idx_keys:
        reasons['COVERED'] += 1
    elif 'paper' not in games:
        # correctly excluded: digital-only, cannot be physically scanned
        reasons['digital_only_excluded'] += 1
    else:
        reasons['MISSING_paper_card'] += 1
        misses.append(('missing', r))

n = len(cc)
print('\n=== COVERAGE OF card_cache ===')
for k, v in reasons.most_common():
    print(f'  {v:>7}  {100*v/n:6.2f}%  {k}')

covered = reasons['COVERED']
scannable = n - reasons['digital_only_excluded']
print(f'\n  raw coverage        {100*covered/n:.2f}%  ({covered}/{n})')
print(f'  of SCANNABLE cards  {100*covered/scannable:.2f}%  ({covered}/{scannable})')
print(f'\n  GATE 1a (>=99% of scannable): '
      f'{"PASS" if covered/scannable >= 0.99 else "FAIL"}')

print('\n=== SAMPLE MISSES ===')
for why, r in misses[:20]:
    print(f'  {why:14} {str(r.get("name"))[:38]:38} [{r.get("set")} {r.get("number")}]')
