#!/usr/bin/env python3
"""VERIFY THE SYNTHETIC LABELS ACTUALLY LAND ON THE CARD.

A generator that writes plausible-looking numbers is worse than no generator:
training proceeds, loss falls, and the detector learns the wrong box. The labels
are exact by construction (we placed the card), but "by construction" is a claim
about code, so it gets checked.

FOUR CHECKS, each earned by a real defect this caught:

  1. COUNT     -- a filename collision silently overwrote 75% of the output.
                  Per-item checks all passed on the survivors.
  2. STRUCTURE -- format, ranges, and card-like proportions.
  3. LOADABLE  -- ultralytics must actually PARSE these labels. The first
                  version used (cx,cy,w,h,angle); ultralytics wants 8 corner
                  coordinates, ignored every file, trained to completion and
                  reported "no labels found". A dataset the trainer cannot read
                  is worse than no dataset, because training still "succeeds".
  4. VISUAL    -- draw the labels back onto the images. This is the only check
                  that caught the occluded-card and wrong-rectangle bugs.
"""
import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw


def parse_corners(parts, W, H):
    """8 normalised coords -> pixel corners."""
    v = [float(x) for x in parts[1:9]]
    return [(v[i] * W, v[i + 1] * H) for i in range(0, 8, 2)]


def shoelace(p):
    return 0.5 * abs(sum(p[i][0] * p[(i + 1) % 4][1] - p[(i + 1) % 4][0] * p[i][1]
                         for i in range(4)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='/tmp/yolo-cards')
    ap.add_argument('--split', default='train')
    ap.add_argument('--n', type=int, default=12)
    ap.add_argument('--out', default='/tmp/label-check.jpg')
    ap.add_argument('--expect', type=int, default=0,
                    help='images the generator claimed to write; asserts none were lost')
    a = ap.parse_args()

    idir = Path(a.data) / 'images' / a.split
    ldir = Path(a.data) / 'labels' / a.split
    imgs = sorted(idir.glob('*.jpg'))

    # ---- 1. count --------------------------------------------------------
    if a.expect:
        assert len(imgs) == a.expect, (
            f'expected {a.expect} images in {a.split}, found {len(imgs)} — '
            'the generator lost data (filename collision?)')
        print(f'count check: {len(imgs)} == {a.expect} OK')

    # ---- 2. structure ----------------------------------------------------
    total = boxes = empty = bad = 0
    aspects, degen = [], 0
    for ip in imgs:
        total += 1
        lines = [l for l in (ldir / (ip.stem + '.txt')).read_text().splitlines() if l.strip()]
        if not lines:
            empty += 1
            continue
        for l in lines:
            p = l.split()
            if len(p) != 9 or p[0] != '0':
                bad += 1
                continue
            boxes += 1
            c = parse_corners(p, 1.0, 1.0)
            if any(not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0) for x, y in c):
                bad += 1
            w = (math.dist(c[0], c[1]) + math.dist(c[3], c[2])) / 2
            h = (math.dist(c[0], c[3]) + math.dist(c[1], c[2])) / 2
            if w <= 0 or h <= 0 or shoelace(c) <= 0:
                degen += 1
            else:
                aspects.append(min(w, h) / max(w, h))

    aspects.sort()
    print(f'images {total}   boxes {boxes}   unlabelled(negatives) {empty}   '
          f'malformed {bad}   degenerate {degen}')
    if aspects:
        q = lambda f: aspects[min(len(aspects) - 1, int(len(aspects) * f))]
        print(f'short/long side ratio: p10 {q(.1):.3f}  p50 {q(.5):.3f}  p90 {q(.9):.3f}')
        print('  (a real card is 0.716; perspective legitimately spreads this)')
    assert bad == 0, f'{bad} malformed labels'
    assert degen == 0, f'{degen} degenerate quads'
    assert boxes > 0, 'no boxes at all'
    assert empty > 0, 'no negatives generated -- the content gate is untrained'

    # ---- 3. the trainer must be able to READ them ------------------------
    try:
        from ultralytics.data.dataset import YOLODataset
        ds = YOLODataset(
            img_path=str(idir),
            data={'names': {0: 'card'}, 'channels': 3, 'nc': 1},
            task='obb',
        )
        found = sum(1 for lb in ds.labels if len(lb.get('bboxes', [])) > 0)
        print(f'ultralytics parsed {found} labelled images of {len(ds.labels)}')
        assert found > 0, (
            'ULTRALYTICS SEES NO LABELS. The files exist and are well-formed, '
            'but the trainer cannot read them -- training would run to '
            'completion and learn nothing.')
    except ImportError:
        print('ultralytics not installed — skipping loader check')

    # ---- 4. visual -------------------------------------------------------
    picks = [ip for ip in imgs if (ldir / (ip.stem + '.txt')).read_text().strip()][:a.n]
    if not picks:
        print('no labelled images to render')
        return
    cols, cell = 4, 260
    rows = (len(picks) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * cell, rows * cell), (10, 10, 12))
    for k, ip in enumerate(picks):
        im = Image.open(ip).convert('RGB')
        W, H = im.size
        d = ImageDraw.Draw(im)
        for l in (ldir / (ip.stem + '.txt')).read_text().splitlines():
            if not l.strip():
                continue
            c = parse_corners(l.split(), W, H)
            d.line(c + [c[0]], fill=(0, 255, 90), width=4)
        sheet.paste(im.resize((cell, cell)), ((k % cols) * cell, (k // cols) * cell))
    sheet.save(a.out, quality=85)
    print('wrote', a.out, '-- boxes must sit on the CARDS, not their cases')


if __name__ == '__main__':
    main()
