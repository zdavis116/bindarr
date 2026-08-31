#!/usr/bin/env python3
"""GATE 1a — measure the real nearest-neighbour distribution at full scale.

Section 3.3 of the plan argued rgbArt's 378-bit hash separates cards well
enough to be recall-only.  That was proven on a ~1200-card sample.  This
proves or disproves it on the whole 51k index.

What matters is not the average distance -- it is the MINIMUM.  If any pair of
DIFFERENT cards sits closer together than photo noise moves a hash of the SAME
card, recall-only is unsafe and the gate fails.

Memory note: the full 51k x 51k distance matrix is 2.6e9 entries.  We never
build it.  We stream row-chunks and keep only each row's minimum, so peak
memory stays a few hundred MB on the 2GB box.
"""
import json
import sys
import numpy as np
import base64

IDX = sys.argv[1] if len(sys.argv) > 1 else 'hash-index/rgbart-index.json'
# 32 rows x 51k cards x 48 bytes, promoted to uint16 by the popcount lookup,
# is ~160MB peak.  The box has 2GB total; a larger chunk is faster but OOMs.
CHUNK = 32

print('loading index...', flush=True)
d = json.load(open(IDX))
cards = d['cards']
n = len(cards)
bits = d['bits']

# 378 bits -> 48 bytes (the last 6 bits are padding and are identical in every
# row, so they add a constant 0 to every distance and cannot bias the result).
mat = np.frombuffer(b''.join(base64.b64decode(c['hash']) for c in cards),
                    dtype=np.uint8).reshape(n, -1)
print(f'  {n} cards, {mat.shape[1]} bytes each ({bits} bits)', flush=True)

POP = np.unpackbits(np.arange(256, dtype=np.uint8)[:, None], axis=1).sum(1).astype(np.uint16)

nn_dist = np.empty(n, dtype=np.uint16)
nn_idx = np.empty(n, dtype=np.int32)

for s in range(0, n, CHUNK):
    e = min(s + CHUNK, n)
    # XOR every row in the chunk against every row in the index, popcount the
    # bytes, sum -> Hamming distance.
    x = np.bitwise_xor(mat[s:e, None, :], mat[None, :, :])
    dist = POP[x].sum(axis=2, dtype=np.uint16)
    # a card's nearest neighbour is not itself
    for i in range(e - s):
        dist[i, s + i] = 9999
    nn_idx[s:e] = dist.argmin(axis=1)
    nn_dist[s:e] = dist.min(axis=1)
    if s % (CHUNK * 40) == 0:
        print(f'  {e}/{n}', flush=True)

print('\n=== NEAREST-NEIGHBOUR DISTANCE DISTRIBUTION (different cards) ===')
for p in [0, 0.01, 0.1, 1, 5, 25, 50, 75, 95, 100]:
    print(f'  p{p:<6} {np.percentile(nn_dist, p):.0f}')
print(f'  mean   {nn_dist.mean():.1f}')

for thr in [8, 12, 16, 20, 24, 32, 40, 48]:
    c = int((nn_dist <= thr).sum())
    print(f'  pairs within {thr:>3} bits: {c:>6}  ({100*c/n:.2f}% of index)')

print('\n=== THE 25 TIGHTEST PAIRS — these are the ones that can be confused ===')
order = np.argsort(nn_dist)[:25]
for i in order:
    j = nn_idx[i]
    a, b = cards[i], cards[j]
    print(f'  {nn_dist[i]:>3}  {a["name"][:34]:34} [{a["set"]} {a["number"]}]'
          f'  <->  {b["name"][:34]:34} [{b["set"]} {b["number"]}]')

np.save('hash-index/nn_dist.npy', nn_dist)
print('\nsaved hash-index/nn_dist.npy')
