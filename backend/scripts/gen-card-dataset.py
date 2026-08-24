#!/usr/bin/env python3
"""PHASE 4b — SYNTHETIC TRAINING DATA FOR THE CARD DETECTOR.

WHY SYNTHETIC. The detector's job is to find the CARD, and the bug we are
fixing is that the classical detector locks onto the toploader instead. Hand
labelling enough real photos to teach that distinction would take days. Real
card images composited onto real backgrounds give us exact ground truth for
free -- we KNOW where we pasted the card, to the pixel.

WHAT THIS MUST TEACH, taken from what actually failed on Zach's scans:

  1. THE CARD, NOT ITS CONTAINER. Session 2's failure was detection grabbing
     the toploader. So a large share of samples put the card inside a
     brighter plastic rectangle -- the exact confuser, labelled as background.
  2. PERSPECTIVE. Cards are photographed at an angle; the quad is genuinely
     not 0.716. Per the capture-pipeline skill, that deviation is the payload
     the warp consumes, not error, so training data must contain it.
  3. GLARE. Foils blow out the artwork, which is what rgbArt keys on.
  4. SLEEVES. A sleeve adds a second, slightly larger rectangle around the
     card -- another wrong-rectangle confuser.

WHAT IT MUST NOT DO: produce a detector that fires on any card-shaped
rectangle. A blank rectangle of the right proportions must NOT be a card, so
some samples are empty sleeves and empty toploaders with NO card and NO label.
(capture-pipeline-diagnosis: "Content gate, not just shape.")

Outputs YOLO OBB format: one .txt per image, lines of
    class cx cy w h angle      (all normalised 0-1, angle in radians)
"""
import argparse
import json
import math
import os
import random
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance


def rand_background(w, h, rng):
    """A surface to place cards on. Deliberately varied: the detector must not
    learn 'card = the only textured thing in frame'."""
    kind = rng.choice(['wood', 'fabric', 'desk', 'noise', 'mat'])
    base = {
        'wood':   (rng.integers(90, 160), rng.integers(60, 110), rng.integers(30, 70)),
        'fabric': (rng.integers(30, 90), rng.integers(30, 90), rng.integers(40, 110)),
        'desk':   (rng.integers(150, 225),) * 3,
        'noise':  (rng.integers(40, 200),) * 3,
        'mat':    (rng.integers(20, 60), rng.integers(40, 80), rng.integers(30, 70)),
    }[kind]
    img = Image.new('RGB', (w, h), base)
    px = np.array(img).astype(np.int16)
    px += rng.integers(-18, 18, px.shape, dtype=np.int16)
    if kind == 'wood':                      # directional grain
        for _ in range(rng.integers(8, 26)):
            y = rng.integers(0, h)
            px[max(0, y - 1):y + 2, :] += rng.integers(-25, 25)
    img = Image.fromarray(np.clip(px, 0, 255).astype(np.uint8))
    return img.filter(ImageFilter.GaussianBlur(rng.uniform(0.3, 1.4)))


def perspective_coeffs(src, dst):
    """Solve the 8 coefficients PIL needs for a perspective warp."""
    m = []
    for (sx, sy), (dx, dy) in zip(src, dst):
        m.append([dx, dy, 1, 0, 0, 0, -sx * dx, -sx * dy])
        m.append([0, 0, 0, dx, dy, 1, -sy * dx, -sy * dy])
    A = np.array(m, dtype=np.float64)
    B = np.array(src, dtype=np.float64).reshape(8)
    return np.linalg.solve(A, B)


def place_card(canvas, card, rng, in_case, sleeved):
    """Composite one card, optionally inside a toploader/sleeve, at a random
    perspective. Returns the card's four corners in canvas coordinates --
    the CARD's corners, never the container's."""
    W, H = canvas.size
    target_h = rng.uniform(0.35, 0.85) * H
    scale = target_h / card.height
    cw, ch = int(card.width * scale), int(card.height * scale)
    if cw < 20 or ch < 20:
        return None
    card = card.resize((cw, ch), Image.LANCZOS)

    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    # A tall card at a large target height can exceed the canvas, which makes
    # the placement range negative. Allow the card to overhang the frame (real
    # scans do) but keep its centre inside, so the label stays meaningful.
    mx, my = cw * 0.6, ch * 0.6
    cx = rng.uniform(min(mx, W / 2), max(W - mx, W / 2))
    cy = rng.uniform(min(my, H / 2), max(H - my, H / 2))
    ox, oy = int(cx - cw / 2), int(cy - ch / 2)

    # THE CONFUSER. A brighter, slightly larger rectangle around the card is
    # exactly what the classical detector locked onto.
    if in_case:
        pad_x, pad_y = int(cw * rng.uniform(0.05, 0.13)), int(ch * rng.uniform(0.04, 0.10))
        d = ImageDraw.Draw(layer)
        shade = rng.integers(200, 250)
        d.rectangle([ox - pad_x, oy - pad_y, ox + cw + pad_x, oy + ch + pad_y],
                    fill=(int(shade), int(shade), int(shade), int(rng.integers(150, 225))))
    elif sleeved:
        pad = int(cw * rng.uniform(0.02, 0.06))
        d = ImageDraw.Draw(layer)
        c = rng.integers(10, 70)
        d.rectangle([ox - pad, oy - pad, ox + cw + pad, oy + ch + pad],
                    fill=(int(c), int(c), int(c), 235))

    layer.paste(card.convert('RGBA'), (ox, oy))

    # PERSPECTIVE. Jitter each corner independently -- a card photographed at
    # an angle projects to a genuine non-rectangle.
    #
    # The full range is back. An earlier version capped this at 3% because the
    # label format was (cx,cy,w,h,angle), a rotated RECTANGLE that could not
    # represent a perspective quad -- at 10% jitter the label sat up to 30% of
    # a card-width from the real card. The 8-corner format represents the quad
    # EXACTLY, so the cap is no longer needed and real-world angles can be
    # trained on. Per capture-pipeline-diagnosis: that deviation from 0.716 is
    # not error, it is the payload the warp consumes.
    j = rng.uniform(0.01, 0.10)
    corners = [(ox, oy), (ox + cw, oy), (ox + cw, oy + ch), (ox, oy + ch)]
    moved = [(x + rng.uniform(-j, j) * cw, y + rng.uniform(-j, j) * ch) for x, y in corners]

    rot = rng.uniform(-math.pi, math.pi) if rng.random() < 0.5 else rng.uniform(-0.5, 0.5)
    ca, sa = math.cos(rot), math.sin(rot)
    moved = [((x - cx) * ca - (y - cy) * sa + cx, (x - cx) * sa + (y - cy) * ca + cy)
             for x, y in moved]

    try:
        coeffs = tuple(perspective_coeffs(
            [(ox, oy), (ox + cw, oy), (ox + cw, oy + ch), (ox, oy + ch)], moved))
    except np.linalg.LinAlgError:
        return None
    warped = layer.transform((W, H), Image.PERSPECTIVE, coeffs, Image.BICUBIC)
    canvas.paste(warped, (0, 0), warped)
    return moved


def add_glare(img, rng):
    """Specular highlight, the way a foil reflects a ceiling light."""
    W, H = img.size
    g = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(g)
    gx, gy = rng.uniform(0, W), rng.uniform(0, H)
    rx, ry = rng.uniform(W * .1, W * .5), rng.uniform(H * .05, H * .3)
    d.ellipse([gx - rx, gy - ry, gx + rx, gy + ry], fill=int(rng.integers(90, 210)))
    g = g.filter(ImageFilter.GaussianBlur(rng.uniform(18, 55)))
    return Image.composite(Image.new('RGB', (W, H), (255, 255, 255)), img, g)


def visible_fraction(corners, later, W, H):
    """How much of this card is still visible after later cards are pasted on
    top, and after clipping to the frame.

    Rasterised rather than computed with polygon clipping: the shapes are
    arbitrary quads, and a mask is both obviously correct and cheap at this
    size. Correctness matters more than speed here -- a wrong answer silently
    poisons the training labels.
    """
    own = Image.new('1', (W, H), 0)
    ImageDraw.Draw(own).polygon([tuple(p) for p in corners], fill=1)
    total = np.count_nonzero(np.array(own))
    if total == 0:
        return 0.0
    if later:
        cover = Image.new('1', (W, H), 0)
        cd = ImageDraw.Draw(cover)
        for c in later:
            cd.polygon([tuple(p) for p in c], fill=1)
        remaining = np.array(own) & ~np.array(cover)
        return float(np.count_nonzero(remaining)) / total
    return 1.0


def obb_label(corners, W, H):
    """YOLO OBB label: class x1 y1 x2 y2 x3 y3 x4 y4, all normalised 0-1.

    FOUR CORNERS, NOT (cx, cy, w, h, angle). I wrote the latter first and
    ultralytics silently ignored every file -- training ran to completion and
    reported "no labels found in obb set", having learned nothing. The format
    is the DOTA-style 8-coordinate polygon; see
    ultralytics.data.converter.convert_dota_to_yolo_obb.

    This is strictly better for us anyway: four corners represent a PERSPECTIVE
    QUAD exactly, whereas the rotated-rectangle form could not. The 3% jitter
    ceiling that form forced is no longer needed -- the label can now say
    precisely where the card's corners are, which is what rectifyCard consumes
    downstream.
    """
    pts = []
    for x, y in corners:
        pts.append(f'{min(max(x / W, 0.0), 1.0):.6f}')
        pts.append(f'{min(max(y / H, 0.0), 1.0):.6f}')
    return '0 ' + ' '.join(pts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cards', default='/tmp/phash_test/img')
    ap.add_argument('--out', default='/tmp/yolo-cards')
    ap.add_argument('--n', type=int, default=2000)
    ap.add_argument('--size', type=int, default=640)
    ap.add_argument('--seed', type=int, default=7)
    a = ap.parse_args()

    rng = np.random.default_rng(a.seed)
    random.seed(a.seed)
    pool = [p for p in Path(a.cards).iterdir()
            if p.suffix.lower() in ('.jpg', '.jpeg', '.png')]
    if not pool:
        raise SystemExit(f'no card images in {a.cards}')
    print(f'{len(pool)} source card images')

    counts = {'plain': 0, 'case': 0, 'sleeved': 0, 'empty': 0, 'multi': 0, 'occluded_dropped': 0}
    for split, n in (('train', int(a.n * 0.9)), ('val', a.n - int(a.n * 0.9))):
        (Path(a.out) / 'images' / split).mkdir(parents=True, exist_ok=True)
        (Path(a.out) / 'labels' / split).mkdir(parents=True, exist_ok=True)
        for i in range(n):
            W = H = a.size
            canvas = rand_background(W, H, rng)

            # NEGATIVES: an empty sleeve or toploader, no card, NO LABEL. The
            # detector must require print, not just proportions.
            if rng.random() < 0.08:
                d = ImageDraw.Draw(canvas)
                bw, bh = rng.integers(80, 300), rng.integers(110, 420)
                bx, by = rng.integers(0, max(1, W - bw)), rng.integers(0, max(1, H - bh))
                s = int(rng.integers(190, 245))
                d.rectangle([int(bx), int(by), int(bx + bw), int(by + bh)], fill=(s, s, s))
                labels = []
                counts['empty'] += 1
            else:
                ncards = 1 if rng.random() < 0.85 else int(rng.integers(2, 4))
                if ncards > 1:
                    counts['multi'] += 1
                labels = []
                placed = []          # (corners, area) in paste order
                for _ in range(ncards):
                    # random.choice, NOT rng.choice: numpy's choice cannot take
                    # a list of Path objects and raises at runtime.
                    card = Image.open(random.choice(pool)).convert('RGB')
                    r = rng.random()
                    in_case, sleeved = r < 0.30, 0.30 <= r < 0.50
                    counts['case' if in_case else 'sleeved' if sleeved else 'plain'] += 1
                    corners = place_card(canvas, card, rng, in_case, sleeved)
                    if corners:
                        placed.append(corners)

                # OCCLUSION CULL. Cards are pasted in order, so a later card
                # covers earlier ones. Labelling a card that is 90% hidden
                # teaches the detector to find cards it cannot see -- the
                # visual check caught exactly this: three cards, one almost
                # entirely behind another, all three labelled.
                #
                # Keep a label only if enough of the card is still visible.
                # NOTE the loop variable is `k`, NOT `i`. Using `i` here shadows
                # the outer image counter, so every multi-card image reused a
                # low index as its filename and silently OVERWROTE earlier
                # images -- a --n 20 run produced 5 files. Nothing raised; the
                # dataset was just quietly a quarter of its stated size.
                for k, corners in enumerate(placed):
                    vis = visible_fraction(corners, placed[k + 1:], W, H)
                    if vis >= 0.55:
                        labels.append(obb_label(corners, W, H))
                    else:
                        counts['occluded_dropped'] += 1

            if rng.random() < 0.30:
                canvas = add_glare(canvas, rng)
            if rng.random() < 0.5:
                canvas = ImageEnhance.Brightness(canvas).enhance(rng.uniform(0.55, 1.45))
            if rng.random() < 0.4:
                canvas = canvas.filter(ImageFilter.GaussianBlur(rng.uniform(0.4, 1.9)))

            stem = f'{split}_{i:06d}'
            canvas.save(Path(a.out) / 'images' / split / f'{stem}.jpg', quality=int(rng.integers(62, 93)))
            (Path(a.out) / 'labels' / split / f'{stem}.txt').write_text('\n'.join(labels))
        print(f'  {split}: {n}')

    yaml = Path(a.out) / 'cards.yaml'
    yaml.write_text(f"path: {Path(a.out).resolve()}\ntrain: images/train\nval: images/val\nnames:\n  0: card\n")
    print('composition:', json.dumps(counts))
    print('wrote', yaml)


if __name__ == '__main__':
    main()
