#!/usr/bin/env python3
"""Fetch card art for the synthetic detector dataset, to a DURABLE path.

WHY THIS EXISTS. The first version of the Phase 4b pipeline read card images
from /tmp. A gateway restart cleared /tmp and took 1,199 downloaded images with
it, along with the generated dataset. Anything that costs an hour to rebuild
does not belong in /tmp.

Rate-limited to ~10/s per Scryfall's guidance. Resumable: already-downloaded
files are skipped, so an interrupted run costs nothing.
"""
import argparse
import json
import random
import sys
import time
import urllib.request
from pathlib import Path

UA = 'Bindarr/1.0 (collection manager; github zdavis116/bindarr)'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--index', default=str(Path(__file__).resolve().parents[2]
                                           / 'hash-index' / 'rgbart-index.json'))
    ap.add_argument('--out', default=str(Path.home() / 'bindarr-cardart'))
    ap.add_argument('--n', type=int, default=1500)
    ap.add_argument('--seed', type=int, default=11)
    a = ap.parse_args()

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    have = {p.stem for p in out.glob('*.jpg')}
    print(f'{len(have)} already downloaded in {out}')

    cards = json.load(open(a.index))['cards']
    random.seed(a.seed)
    # A SPREAD of sets and frames, not the first N: the detector must learn
    # "card" in general, not "the border style of one recent set".
    picks = random.sample(cards, min(a.n, len(cards)))

    got = skipped = failed = 0
    t0 = time.time()
    for i, c in enumerate(picks):
        stem = c['id']
        if stem in have:
            skipped += 1
            continue
        try:
            req = urllib.request.Request(c['img'], headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=25) as r:
                (out / f'{stem}.jpg').write_bytes(r.read())
            got += 1
        except Exception as e:
            failed += 1
            if failed <= 5:
                print(f'  fail {c["name"]}: {str(e)[:60]}', file=sys.stderr)
        time.sleep(0.1)                       # ~10/s, Scryfall's stated limit
        if got and got % 200 == 0:
            rate = got / (time.time() - t0)
            print(f'  {got} fetched  {rate:.1f}/s  ({failed} failed)')

    print(f'done: {got} fetched, {skipped} already present, {failed} failed')
    print(f'total images: {len(list(out.glob("*.jpg")))} in {out}')


if __name__ == '__main__':
    main()
