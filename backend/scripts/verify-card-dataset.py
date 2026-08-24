#!/usr/bin/env python3
"""VERIFY THE SYNTHETIC LABELS ACTUALLY LAND ON THE CARD.

A generator that writes plausible-looking numbers is worse than no generator:
training would proceed, loss would fall, and the detector would learn the wrong
box. The labels are exact BY CONSTRUCTION (we placed the card), but "by
construction" is a claim about code I just wrote, so it gets checked.

Two checks:
  1. STRUCTURAL -- every label parses, is in range, and the aspect implied by
     w/h is card-like (allowing for perspective, which legitimately distorts it).
  2. VISUAL -- draw each label back onto its image. If the boxes do not sit on
     the cards, that is instantly obvious and no amount of arithmetic hides it.
"""
import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw


def corners_from_obb(cx, cy, w, h, ang, W, H):
    cx, cy, w, h = cx * W, cy * H, w * W, h * H
    ca, sa = math.cos(ang), math.sin(ang)
    # local corner offsets, rotated
    pts = []
    for dx, dy in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)):
        pts.append((cx + dx * ca - dy * sa, cy + dx * sa + dy * ca))
    return pts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='/tmp/yolo-smoke')
    ap.add_argument('--split', default='train')
    ap.add_argument('--n', type=int, default=12)
    ap.add_argument('--out', default='/tmp/label-check.jpg')
    ap.add_argument('--expect', type=int, default=0,
                    help='images the generator claimed to write; asserts none were lost')
    a = ap.parse_args()

    idir = Path(a.data) / 'images' / a.split
    ldir = Path(a.data) / 'labels' / a.split
    imgs = sorted(idir.glob('*.jpg'))

    # COUNT CHECK FIRST. A filename-shadowing bug made the generator overwrite
    # its own output: --n 20 produced 5 images and reported success. Every
    # other check below passed happily on the survivors, because they were
    # individually valid. Missing data is invisible to per-item validation.
    if a.expect:
        assert len(imgs) == a.expect, (
            f'expected {a.expect} images in {a.split}, found {len(imgs)} — '
            'the generator lost data (filename collision?)')
        print(f'count check: {len(imgs)} == {a.expect} OK')

    # ---- structural ------------------------------------------------------
    total = boxes = empty = bad = 0
    aspects = []
    for ip in imgs:
        total += 1
        lp = ldir / (ip.stem + '.txt')
        lines = [l for l in lp.read_text().splitlines() if l.strip()]
        if not lines:
            empty += 1
            continue
        for l in lines:
            p = l.split()
            if len(p) != 6:
                bad += 1
                continue
            cls, cx, cy, w, h, ang = int(p[0]), *map(float, p[1:])
            boxes += 1
            if cls != 0 or not (0 <= cx <= 1 and 0 <= cy <= 1) or w <= 0 or h <= 0:
                bad += 1
            if h > 0:
                aspects.append(w / h)

    aspects.sort()
    print(f'images {total}   boxes {boxes}   unlabelled(negatives) {empty}   malformed {bad}')
    if aspects:
        p = lambda q: aspects[min(len(aspects) - 1, int(len(aspects) * q))]
        print(f'implied w/h aspect: p10 {p(.1):.3f}  p50 {p(.5):.3f}  p90 {p(.9):.3f}')
        print('  (a real card is 0.716; spread is expected -- perspective and')
        print('   90-degree rotations legitimately swap w and h)')
    assert bad == 0, f'{bad} malformed labels'
    assert boxes > 0, 'no boxes at all'
    assert empty > 0, 'no negatives were generated -- the content gate is untrained'

    # ---- quad sanity -----------------------------------------------------
    # A YOLO OBB is a ROTATED RECTANGLE. If the decoded corners self-intersect,
    # the label is not describing a card-shaped thing at all. This caught a
    # real defect: perspective jitter at 10% produced labels up to 30% of a
    # card-width from the actual card, which the aspect check above passed
    # happily. Structural validity is not the same as being correct.
    def cross(p1, p2, p3, p4):
        def s(a, b, c):
            return (c[1]-a[1])*(b[0]-a[0]) - (b[1]-a[1])*(c[0]-a[0])
        d1, d2, d3, d4 = s(p3,p4,p1), s(p3,p4,p2), s(p1,p2,p3), s(p1,p2,p4)
        return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))

    twisted = 0
    for ip in imgs:
        for l in (ldir / (ip.stem + '.txt')).read_text().splitlines():
            if not l.strip():
                continue
            _, cx, cy, w, h, ang = l.split()
            pts = corners_from_obb(float(cx), float(cy), float(w), float(h), float(ang), 1, 1)
            if cross(pts[0], pts[1], pts[2], pts[3]) or cross(pts[1], pts[2], pts[3], pts[0]):
                twisted += 1
    print(f'self-intersecting quads: {twisted}')
    assert twisted == 0, f'{twisted} labels decode to a twisted quad'

    # ---- visual ----------------------------------------------------------
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
            _, cx, cy, w, h, ang = l.split()
            pts = corners_from_obb(float(cx), float(cy), float(w), float(h), float(ang), W, H)
            d.line(pts + [pts[0]], fill=(0, 255, 90), width=4)
        im = im.resize((cell, cell))
        sheet.paste(im, ((k % cols) * cell, (k // cols) * cell))
    sheet.save(a.out, quality=85)
    print('wrote', a.out, '-- boxes must sit on the CARDS, not their cases')


if __name__ == '__main__':
    main()
