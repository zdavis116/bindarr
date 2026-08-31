#!/usr/bin/env python3
"""GATE 1a check 2, ANALYSIS — do the tight pairs actually threaten a scan?

The raw nearest-neighbour run found pairs at distance 0.  That looks alarming
and is mostly harmless, but 'mostly' is not an engineering answer, so this
separates the two cases:

  BENIGN   - the pair is the SAME physical artwork appearing twice (a foil
             variant, a token reprint, an art-series card).  Recall returning
             either one is CORRECT; the collector number picks the printing.
  REAL     - the pair is two DIFFERENT cards Zach could physically own and
             scan.  These are the only ones that can produce a wrong answer.

and then asks the only question that decides the gate: are the REAL ones
reachable from card_cache at all?
"""
import json
import base64
import numpy as np

idx = json.load(open('hash-index/rgbart-index.json'))
cards = idx['cards']
n = len(cards)
nn = np.load('hash-index/nn_dist.npy')

print('=== DISTRIBUTION (recovered) ===')
for p in [0, 0.01, 0.1, 1, 5, 25, 50, 75, 95, 100]:
    print(f'  p{p:<6} {np.percentile(nn, p):.0f}')
print(f'  mean   {nn.mean():.1f}')
print()
for thr in [0, 2, 4, 8, 12, 16, 20, 24, 32, 40]:
    c = int((nn <= thr).sum())
    print(f'  cards with a neighbour within {thr:>3} bits: {c:>6}  ({100*c/n:.2f}%)')

# Which of these are reachable from the app's own catalogue?
cc = json.load(open('hash-index/card_cache.json'))
cc_sets = {str(r.get('set') or '').lower() for r in cc}
cc_names = {str(r.get('name') or '').lower() for r in cc}

mat = np.frombuffer(b''.join(base64.b64decode(c['hash']) for c in cards),
                    dtype=np.uint8).reshape(n, -1)
POP = np.unpackbits(np.arange(256, dtype=np.uint8)[:, None], axis=1).sum(1).astype(np.uint16)

TIGHT = 8
risky = np.where(nn <= TIGHT)[0]
print(f'\n=== CLASSIFYING THE {len(risky)} CARDS WITH A NEIGHBOUR <= {TIGHT} BITS ===')

benign_same_name = 0
real_pairs = []
for i in risky:
    x = np.bitwise_xor(mat[i][None, :], mat)
    d = POP[x].sum(axis=1, dtype=np.uint16)
    d[i] = 9999
    j = int(d.argmin())
    a, b = cards[i], cards[j]
    if a['name'].lower() == b['name'].lower():
        benign_same_name += 1          # same card, different printing/finish
    else:
        real_pairs.append((int(d[j]), a, b))

print(f'  {benign_same_name:>5}  BENIGN  - same card name, different printing')
print(f'  {len(real_pairs):>5}  distinct-name pairs (candidate real confusions)')

in_cc = [(d, a, b) for d, a, b in real_pairs
         if a['set'].lower() in cc_sets and b['set'].lower() in cc_sets
         and a['name'].lower() in cc_names and b['name'].lower() in cc_names]

print(f'\n=== OF THOSE, REACHABLE FROM card_cache (scannable in practice) ===')
print(f'  {len(in_cc)} pairs')
for d, a, b in sorted(in_cc)[:40]:
    print(f'  {d:>3}  {a["name"][:32]:32} [{a["set"]} {a["number"]}]'
          f'  <->  {b["name"][:32]:32} [{b["set"]} {b["number"]}]')

print(f'\n  cards at real risk: {len(in_cc)} of {len(cc)} catalogue rows '
      f'({100*len(in_cc)/max(len(cc),1):.4f}%)')

sets = {}
for d, a, b in real_pairs:
    sets[a['set']] = sets.get(a['set'], 0) + 1
print('\n=== WHICH SETS PRODUCE THE COLLISIONS ===')
for s, c in sorted(sets.items(), key=lambda kv: -kv[1])[:12]:
    print(f'  {c:>5}  {s}{"   <-- NOT in card_cache" if s.lower() not in cc_sets else ""}')
