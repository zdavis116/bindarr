#!/usr/bin/env python3
"""PHASE 4b GATE — does the trained detector beat the classical one on REAL photos?

THE ONLY QUESTION THAT MATTERS. Session 2 showed the classical detector locking
onto the toploader instead of the card. Training loss and mAP on synthetic data
say nothing about that: the model can score 0.99 against images it was born
from and still fail on Zach's camera. Synthetic-to-real transfer is exactly
where this kind of work fails, so it is measured on real scans, not assumed.

NO GROUND TRUTH IS AVAILABLE, so this does not claim accuracy. It reports what
can be honestly measured on unlabelled photos:

  1. DETECTION RATE   -- did anything get found at all? The classical detector
                         failed outright on 6 of 29 scans.
  2. QUAD ASPECT      -- a real card is 0.716. A detection at 0.85 is probably
                         a toploader (wider) and one at 0.5 is probably a crop.
                         Not proof, but the toploader signature is measurable:
                         a case is ~10% wider than the card it holds.
  3. AREA FRACTION    -- a card fills a predictable share of a deliberate scan.
                         A box covering 95% of frame is the classic
                         "locked onto everything" failure.
  4. SIDE-BY-SIDE     -- render both detectors' quads on the same photo. The
                         toploader bug was found by LOOKING, not by computing,
                         and this is the check that would catch it again.
"""
import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

CARD_ASPECT = 0.716


def quad_metrics(pts, W, H):
    w = (math.dist(pts[0], pts[1]) + math.dist(pts[3], pts[2])) / 2
    h = (math.dist(pts[0], pts[3]) + math.dist(pts[1], pts[2])) / 2
    if w <= 0 or h <= 0:
        return None
    short, long_ = min(w, h), max(w, h)
    area = 0.5 * abs(sum(pts[i][0] * pts[(i + 1) % 4][1] - pts[(i + 1) % 4][0] * pts[i][1]
                         for i in range(4)))
    return {'aspect': short / long_, 'area_frac': area / (W * H)}


def run_yolo(model_path, images, conf):
    from ultralytics import YOLO
    m = YOLO(model_path)
    out = {}
    for p in images:
        r = m.predict(str(p), imgsz=416, conf=conf, verbose=False, device='cpu')[0]
        obb = getattr(r, 'obb', None)
        if obb is None or obb.xyxyxyxy is None or len(obb.xyxyxyxy) == 0:
            out[p.name] = None
            continue
        # highest-confidence detection only: the scanner acts on one card
        i = int(obb.conf.argmax())
        pts = [(float(x), float(y)) for x, y in obb.xyxyxyxy[i].tolist()]
        out[p.name] = {'pts': pts, 'conf': float(obb.conf[i])}
    return out


def run_classical(images, repo):
    """The CURRENT production detector, via the exact call the route makes.

    MUST use preprocessCardWithDetection, not detectCard directly. Calling
    detectCard raw returned 0/33 on photos the live server detects 69/80 of --
    opencv-wasm is not ready when it is invoked cold, and the failure is silent
    (returns null, no error). A baseline that reports zero makes any new model
    look perfect, so this bug would have manufactured a fake victory.

    The script is written INTO backend/ because node resolves modules relative
    to the script's own path, not cwd; running it from /tmp fails with
    MODULE_NOT_FOUND regardless of the working directory.
    """
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
    script = Path(repo) / 'backend' / '_eval_classical.js'
    script.write_text(js)
    try:
        r = subprocess.run(['node', str(script)] + [str(p) for p in images],
                           capture_output=True, text=True, timeout=1800,
                           cwd=str(Path(repo) / 'backend'))
    finally:
        script.unlink(missing_ok=True)
    if r.returncode != 0:
        print('classical detector failed:', r.stderr[-400:], file=sys.stderr)
        return {}
    for line in r.stdout.splitlines():
        if line.startswith('__RESULT__'):
            return json.loads(line[len('__RESULT__'):])
    print('classical detector produced no result line', file=sys.stderr)
    return {}


def summarise(name, results, sizes):
    found = [k for k, v in results.items() if v]
    print(f'\n{name}')
    print(f'  detected on {len(found)}/{len(results)} scans')
    asp, ar = [], []
    for k in found:
        W, H = sizes[k]
        m = quad_metrics(results[k]['pts'], W, H)
        if m:
            asp.append(m['aspect'])
            ar.append(m['area_frac'])
    if not asp:
        return
    asp.sort(); ar.sort()
    q = lambda v, f: v[min(len(v) - 1, int(len(v) * f))]
    print(f'  quad aspect   p10 {q(asp,.1):.3f}  p50 {q(asp,.5):.3f}  p90 {q(asp,.9):.3f}   (card = 0.716)')
    print(f'  area of frame p10 {q(ar,.1):.2f}  p50 {q(ar,.5):.2f}  p90 {q(ar,.9):.2f}')
    off = [a for a in asp if abs(a - CARD_ASPECT) > 0.08]
    print(f'  detections >0.08 from card aspect: {len(off)}/{len(asp)}  <- toploader/crop suspects')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--weights', default=str(Path.home() / 'bindarr-yolo-runs' / 'cards' / 'weights' / 'best.pt'))
    ap.add_argument('--scans', default=str(Path.home() / 'bindarr-realscans'))
    ap.add_argument('--repo', default=str(Path.home() / 'repos' / 'bindarr'))
    ap.add_argument('--conf', type=float, default=0.25)
    ap.add_argument('--out', default=str(Path.home() / 'detector-compare.jpg'))
    ap.add_argument('--n', type=int, default=8)
    a = ap.parse_args()

    images = sorted(Path(a.scans).glob('*.jpg'))
    if not images:
        sys.exit(f'no scans in {a.scans}')
    print(f'{len(images)} real scans')
    sizes = {p.name: Image.open(p).size for p in images}

    yolo = run_yolo(a.weights, images, a.conf)

    cls_raw = run_classical(images, a.repo)
    classical = {}
    for k, v in cls_raw.items():
        if not v:
            classical[k] = None
            continue
        # quad is in DETECTION pixels; scale to full image
        s = v['W'] / v['detW']
        classical[k] = {'pts': [(p['x'] * s, p['y'] * s) for p in v['quad']], 'conf': None}

    summarise('CLASSICAL (current production detector)', classical, sizes)
    summarise('YOLO (trained on synthetic data)', yolo, sizes)

    # HARNESS SANITY CHECK. The live server detects on ~86% of real scans. If
    # the baseline here reports near zero, the harness is broken -- not the
    # detector -- and every comparison above is meaningless. This exact failure
    # happened twice while writing this script (module path, then calling
    # detectCard cold before opencv-wasm was ready), and both times it made the
    # new model look flawless.
    cls_rate = sum(1 for v in classical.values() if v) / max(len(classical), 1)
    if cls_rate < 0.20:
        print(f'\n  *** WARNING: classical baseline detected on only {cls_rate:.0%} of scans.')
        print('  The live server manages ~86% on this kind of photo, so the BASELINE')
        print('  is probably broken, not the detector. Do not trust the comparison')
        print('  above until this is explained.')

    # visual comparison -- the check that found the bug in the first place
    picks = [p for p in images if yolo.get(p.name) or classical.get(p.name)][:a.n]
    cols, cell = 4, 300
    rows = (len(picks) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * cell, rows * cell), (10, 10, 12))
    for i, p in enumerate(picks):
        im = Image.open(p).convert('RGB')
        d = ImageDraw.Draw(im)
        if classical.get(p.name):
            c = classical[p.name]['pts']
            d.line(c + [c[0]], fill=(255, 80, 80), width=9)      # RED = classical
        if yolo.get(p.name):
            c = yolo[p.name]['pts']
            d.line(c + [c[0]], fill=(0, 255, 90), width=9)       # GREEN = YOLO
        sheet.paste(im.resize((cell, cell)), ((i % cols) * cell, (i // cols) * cell))
    sheet.save(a.out, quality=85)
    print(f'\nwrote {a.out}   RED = classical, GREEN = YOLO')


if __name__ == '__main__':
    main()
