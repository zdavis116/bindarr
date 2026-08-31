#!/usr/bin/env python3
"""Gate 1a check 2, re-run against the REAL dev catalogue (104,535 rows).

The first pass measured against prod's 43,569-row catalogue and concluded zero
cards were at risk.  Dev's catalogue is 2.4x larger and DOES carry the novelty
sets, so that conclusion does not transfer.  This re-does the classification
properly and, unlike the first pass, tests reachability EXACTLY.

The first pass tested `set in cc_sets AND name in cc_names` -- two independent
memberships, which is loose: it can call a pair reachable when the catalogue
merely contains that set somewhere and that name somewhere.  Here a card counts
as reachable only if the catalogue holds a row whose (name, set) both match.
"""
import json
import base64
import collections
import numpy as np

CC = 'hash-index/card_cache_dev.json'
idx = json.load(open('hash-index/rgbart-index.json'))
cards = idx['cards']
n = len(cards)
nn = np.load('hash-index/nn_dist.npy')

cc = json.load(open(CC))
cc_exact = {(str(r.get('name') or '').lower(), str(r.get('set') or '').lower()) for r in cc}
cc_names = collections.Counter(str(r.get('name') or '').lower() for r in cc)
print(f'catalogue: {len(cc)} rows, {len(cc_names)} distinct names')

mat = np.frombuffer(b''.join(base64.b64decode(c['hash']) for c in cards),
                    dtype=np.uint8).reshape(n, -1)
POP = np.unpackbits(np.arange(256, dtype=np.uint8)[:, None], axis=1).sum(1).astype(np.uint16)


def reachable(c):
    return (c['name'].lower(), c['set'].lower()) in cc_exact


for TIGHT in (8, 16, 24):
    risky = np.where(nn <= TIGHT)[0]
    benign = 0
    real = []
    for i in risky:
        d = POP[np.bitwise_xor(mat[i][None, :], mat)].sum(axis=1, dtype=np.uint16)
        d[i] = 9999
        j = int(d.argmin())
        a, b = cards[i], cards[j]
        if a['name'].lower() == b['name'].lower():
            benign += 1
        else:
            real.append((int(d[j]), a, b))

    both = [(d, a, b) for d, a, b in real if reachable(a) and reachable(b)]
    one = [(d, a, b) for d, a, b in real if reachable(a) != reachable(b)]

    print(f'\n=== THRESHOLD <= {TIGHT} BITS ===')
    print(f'  {len(risky):>4} cards with a close neighbour')
    print(f'  {benign:>4} benign (same card, different printing)')
    print(f'  {len(real):>4} distinct-name pairs')
    print(f'  {len(both):>4} with BOTH sides in the catalogue  <- true confusion risk')
    print(f'  {len(one):>4} with only ONE side in the catalogue (still answerable wrongly)')

    if TIGHT == 8:
        print('\n  --- the reachable pairs ---')
        for d, a, b in sorted(both, key=lambda t: t[0])[:60]:
            print(f'  {d:>3}  {a["name"][:30]:30} [{a["set"]} {a["number"]}]'
                  f'  <->  {b["name"][:30]:30} [{b["set"]} {b["number"]}]')
        sets = collections.Counter(a['set'] for _, a, _ in both)
        print('\n  --- sets involved ---')
        for s, c in sets.most_common(12):
            print(f'  {c:>4}  {s}')

        # Does the collector number rescue them?  It only helps if the two sides
        # differ there -- if two different cards share set AND number, no
        # tie-break exists and the scan is simply ambiguous.
        same_sn = [(d, a, b) for d, a, b in both
                   if (a['set'], a['number']) == (b['set'], b['number'])]
        print(f'\n  pairs sharing set AND collector number (no tie-break possible): '
              f'{len(same_sn)}')
        for d, a, b in same_sn[:15]:
            print(f'    {d:>3}  {a["name"][:30]:30} <-> {b["name"][:30]:30} '
                  f'[{a["set"]} {a["number"]}]')
