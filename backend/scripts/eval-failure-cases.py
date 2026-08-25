#!/usr/bin/env python3
"""Where the CLASSICAL detector fails, does YOLO succeed?

The summary metrics were misleading. YOLO's median quad aspect (0.756) sits
further from a true card (0.716) than the classical detector's (0.718), which
reads as "YOLO is worse". Looking at the images says the opposite: on the
tray/toploader shots, the classical detector grabs the WHOLE FRAME while YOLO
sits tightly on the card.

Both facts are true. The aspect metric is dominated by the many scans where the
card fills nearly the entire photo -- there, any box that covers the frame
scores a "card-like" aspect by accident. The metric cannot separate "found the
card" from "found everything" when the card IS almost everything.

So this measures the failure directly: find scans where the classical detector
returns a near-full-frame box (its toploader signature) and report what YOLO
did on those same photos.
"""
import json
import math
import subprocess
import sys
from pathlib import Path

from PIL import Image



def quad_area_frac(pts, W, H):
    a = 0.5 * abs(sum(pts[i][0] * pts[(i + 1) % 4][1] - pts[(i + 1) % 4][0] * pts[i][1]
                      for i in range(4)))
    return a / (W * H)


def aspect(pts):
    w = (math.dist(pts[0], pts[1]) + math.dist(pts[3], pts[2])) / 2
    h = (math.dist(pts[0], pts[3]) + math.dist(pts[1], pts[2])) / 2
    return min(w, h) / max(w, h) if w and h else 0


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--weights', default=str(Path.home() / 'bindarr-yolo-runs' / 'cards' / 'weights' / 'best.pt'))
    ap.add_argument('--scans', default=str(Path.home() / 'bindarr-realscans'))
    ap.add_argument('--repo', default=str(Path.home() / 'repos' / 'bindarr'))
    a = ap.parse_args()

    images = sorted(Path(a.scans).glob('*.jpg'))
    sizes = {p.name: Image.open(p).size for p in images}

    # --- classical, via the production entry point -------------------------
    js = r'''
const fs=require('fs'),path=require('path');
const sharp=require('sharp');
const sm=require('./src/scanMatch');
(async()=>{const out={};
for(const f of process.argv.slice(2)){
  try{
    const buf=fs.readFileSync(f);
    const meta=await sharp(buf).metadata();
    const r=await sm.preprocessCardWithDetection(buf);
    out[path.basename(f)]=r.detect?{quad:r.detect.quad,detW:r.detect.detW,W:meta.width,H:meta.height}:null;
  }catch(e){out[path.basename(f)]=null;}
}
console.log('__RESULT__'+JSON.stringify(out));})();
'''
    script = Path(a.repo) / 'backend' / '_fc.js'
    script.write_text(js)
    try:
        r = subprocess.run(['node', str(script)] + [str(p) for p in images],
                           capture_output=True, text=True, timeout=1800,
                           cwd=str(Path(a.repo) / 'backend'))
    finally:
        script.unlink(missing_ok=True)
    cls_raw = {}
    for line in r.stdout.splitlines():
        if line.startswith('__RESULT__'):
            cls_raw = json.loads(line[len('__RESULT__'):])

    classical = {}
    for k, v in cls_raw.items():
        if not v:
            classical[k] = None
            continue
        s = v['W'] / v['detW']
        classical[k] = [(p['x'] * s, p['y'] * s) for p in v['quad']]

    # --- yolo ---------------------------------------------------------------
    from ultralytics import YOLO
    m = YOLO(a.weights)
    yolo = {}
    for p in images:
        res = m.predict(str(p), imgsz=416, conf=0.25, verbose=False, device='cpu')[0]
        obb = getattr(res, 'obb', None)
        if obb is None or obb.xyxyxyxy is None or len(obb.xyxyxyxy) == 0:
            yolo[p.name] = None
        else:
            i = int(obb.conf.argmax())
            yolo[p.name] = [(float(x), float(y)) for x, y in obb.xyxyxyxy[i].tolist()]

    # --- the actual question -----------------------------------------------
    FRAME_GRAB = 0.90          # a box this large is not a card, it is the photo
    fails, wins, both_bad = [], [], []
    for p in images:
        W, H = sizes[p.name]
        c, y = classical.get(p.name), yolo.get(p.name)
        c_bad = (c is None) or quad_area_frac(c, W, H) > FRAME_GRAB
        if not c_bad:
            continue
        fails.append(p.name)
        if y and quad_area_frac(y, W, H) <= FRAME_GRAB:
            wins.append((p.name, quad_area_frac(y, W, H), aspect(y)))
        else:
            both_bad.append(p.name)

    print(f'{len(images)} real scans\n')
    print(f'CLASSICAL FAILED (no detection, or box > {FRAME_GRAB:.0%} of frame): {len(fails)}')
    print(f'  of those, YOLO found a plausible card: {len(wins)}')
    print(f'  of those, YOLO also failed:            {len(both_bad)}')
    if wins:
        print('\n  YOLO rescues:')
        for n, ar, asp in wins:
            print(f'    {n:32} area {ar:.2f}  aspect {asp:.3f}')

    # And the reverse -- be fair about regressions.
    regress = []
    for p in images:
        W, H = sizes[p.name]
        c, y = classical.get(p.name), yolo.get(p.name)
        c_ok = c is not None and quad_area_frac(c, W, H) <= FRAME_GRAB
        y_bad = (y is None) or quad_area_frac(y, W, H) > FRAME_GRAB
        if c_ok and y_bad:
            regress.append(p.name)
    print(f'\nREGRESSIONS (classical fine, YOLO failed): {len(regress)}')
    for n in regress:
        print(f'    {n}')


if __name__ == '__main__':
    main()
