// Hybrid card identification: CLIP embedding recall + ORB geometric verification.
//
// 1. Recall: embedMatch (CLIP) returns the top-RECALL_K visually-nearest cards.
// 2. Verify: for each, match ORB descriptors to the query and fit a RANSAC
//    homography; the inlier count is decisive (only the true card produces many
//    geometrically-consistent matches). Rank by inliers.
//
// Falls back to CLIP-only ranking if the ORB DB for a game isn't built yet.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { cv } = require('opencv-wasm');
const embedMatch = require('./embedMatch');
const setIndex = require('./setIndex');
const { parseSetList } = require('./utils/setQuery');
const languages = require('./utils/languages');
const scanProfile = require('./scanProfile');
const cardDetector = require('./cardDetector');

const DATA_DIR = process.env.INDEX_DATA_DIR || path.join(__dirname, '..', 'data');
// CLIP candidates to geometrically verify.
//
// Measured on the dev box against the global (unscoped) index, 8 varied cards
// including Alpha originals, modern frames and a double-faced card. Card
// identification was 8/8 at EVERY value tested; only latency moved:
//
//   250 -> 4952ms    100 -> 1642ms    50 -> 1118ms    25 -> 752ms    10 -> 587ms
//
// So verifying 250 candidates was almost entirely wasted work: CLIP already
// ranks the right card at or near the top, exactly as the note further down
// this file predicted ("if these stay well below K, RECALL_K can be lowered
// losslessly"). The sweep ran DESCENDING, so the fast numbers came last and are
// not a warm-cache artefact.
//
// 50 rather than 10 deliberately. Every test image was a clean Scryfall render:
// no glare, no sleeve, no angle, no worn edges. Geometric verification exists
// for exactly those cases and none of them are in the sample, so the measurement
// proves 250 is wasteful - NOT that 10 is safe. 50 keeps a 5x margin over the
// point where accuracy could start to matter and still cuts a scan from ~5s to
// ~1.1s, which is the difference between cataloguing a collection and giving up.
//
// Callers may still pass a lower recallK per request for speed-critical paths.
const RECALL_K = 50;
const REF_WIDTH = 500;     // must match build-card-orb.mjs
const DESC_BYTES = 32;
const RATIO = 0.75;        // Lowe ratio test
const RANSAC_PX = 5.0;
const CARD_ASPECT = 2.5 / 3.5;
const WARP_W = 500, WARP_H = Math.round(500 / CARD_ASPECT); // rectified card size

// Order 4 quad points as [tl, tr, br, bl].
//
// The sum/diff trick is exact for an axis-aligned-ish quad but degenerates near
// 45°, where one point can win two slots and leave another unused — that feeds
// warpPerspective a collapsed quad and produces the badly sheared crops. So the
// result is checked for duplicates and falls back to ordering by angle around the
// centroid, which is rotation-proof.
function orderQuad(pts) {
  const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  const guess = [bySum[0], byDiff[0], bySum[3], byDiff[3]]; // tl, tr, br, bl
  if (new Set(guess).size === 4) return guess;

  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  // Clockwise from the top-left-most quadrant so the order still reads tl,tr,br,bl.
  const byAngle = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  const start = byAngle.reduce((bi, p, i) => (p.x + p.y < byAngle[bi].x + byAngle[bi].y ? i : bi), 0);
  return [0, 1, 2, 3].map(i => byAngle[(start + i) % 4]);
}

// Geometry of an ordered quad, or null if it is too small to judge. Used to throw
// out candidates that are not plausibly a card seen at an angle.
function quadMetrics(pts) {
  const [tl, tr, br, bl] = orderQuad(pts);
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const top = d(tl, tr), bottom = d(bl, br), left = d(tl, bl), right = d(tr, br);
  if (Math.min(top, bottom, left, right) < 20) return null;
  const w = (top + bottom) / 2, h = (left + right) / 2;
  // How much the opposite sides agree. A real card (even in perspective) keeps
  // this high; a blob merging the card with a hand or a neighbouring card does not.
  const parallelism = (Math.min(top, bottom) / Math.max(top, bottom)) * (Math.min(left, right) / Math.max(left, right));
  return { corners: [tl, tr, br, bl], w, h, ar: w / h, parallelism };
}

// Is this quad plausibly a portrait card?
//
// Portrait is required rather than rotated into place: the scanner's guide box is
// portrait and every indexed reference image is portrait upright, so a landscape
// quad means the detector merged the card with something else. Rotating it would
// be a coin flip on which way is up, and dHash recall is rotation-sensitive — so a
// landscape candidate is rejected instead of guessed at.
function isCardQuad(m) {
  return !!m && m.ar <= 0.95 && m.ar >= 0.5 && m.parallelism >= 0.6;
}

// Locate the card and return a rectified raw-RGBA image, or null if no card-like
// region is found. Two strategies, tried in order:
//   1. A clean 4-point convex quad -> perspective-warp flat (handles tilt/skew).
//   2. Else the largest card-aspect region's bounding box -> plain crop (slinger
//      cards sit flat and upright, so a crop is enough and works when the card is
//      small/far where a crisp quad isn't found).
// Both prefer the region nearest the frame center (the card the user aimed at).
// The area floor is low (4%) so distant cards are still detected instead of
// falling back to a background-dominated center crop.
// Finds the 4 true perspective corners of a card contour by dynamically stepping
// epsilon on its convex hull to simplify rounded corners into exactly 4 primary vertices.
function findCardQuad(c) {
  const hull = new cv.Mat();
  cv.convexHull(c, hull);
  const peri = cv.arcLength(hull, true);
  let quad = null;

  for (let epsScale = 0.015; epsScale <= 0.12; epsScale += 0.005) {
    const approx = new cv.Mat();
    cv.approxPolyDP(hull, approx, epsScale * peri, true);
    if (approx.rows === 4 && cv.isContourConvex(approx)) {
      quad = Array.from({ length: 4 }, (_, j) => ({
        x: approx.data32S[j * 2],
        y: approx.data32S[j * 2 + 1]
      }));
      approx.delete();
      break;
    }
    approx.delete();
  }
  hull.delete();
  return quad;
}

// Every way we know of turning a photo into "regions that might be a card".
// One segmentation is not enough in practice:
//   - OTSU (both polarities) is the cheapest and wins on a plain table, but it
//     merges the card with anything of similar brightness touching it — a hand, a
//     neighbouring card in the binder — and then the region's outline is not the
//     card's outline, which is what produced skewed crops.
//   - Canny keys on the card's BORDER instead of its brightness, so it survives a
//     hand, glare, and a background whose tone is close to the card's.
// Candidates from all of them compete on the same score, so adding a strategy can
// only help: a wrong region still has to beat a right one on card-likeness.
function segmentations(blur, w, h) {
  const closeK = Math.max(15, Math.round(Math.min(w, h) * 0.035));
  const kClose = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(closeK, closeK));
  const masks = [];

  for (const polarity of [cv.THRESH_BINARY_INV, cv.THRESH_BINARY]) {
    const thresh = new cv.Mat(), closed = new cv.Mat();
    cv.threshold(blur, thresh, 0, 255, polarity | cv.THRESH_OTSU);
    cv.morphologyEx(thresh, closed, cv.MORPH_CLOSE, kClose);
    thresh.delete();
    masks.push(closed);
  }

  // Edge pass: Canny, then a light dilate to close the small gaps a card border
  // picks up over busy art, then close to fill it into a solid region. The kernel
  // is deliberately much smaller than the OTSU one — a big kernel is exactly what
  // bridges the card to a hand resting against it.
  const edges = new cv.Mat(), dil = new cv.Mat(), filled = new cv.Mat();
  const kEdge = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const kFill = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(5, Math.round(Math.min(w, h) * 0.01)), Math.max(5, Math.round(Math.min(w, h) * 0.01))));
  cv.Canny(blur, edges, 50, 150);
  cv.dilate(edges, dil, kEdge);
  cv.morphologyEx(dil, filled, cv.MORPH_CLOSE, kFill);
  edges.delete(); dil.delete(); kEdge.delete(); kFill.delete();
  masks.push(filled);

  kClose.delete();
  return masks;
}

// Card must cover at least this fraction of the frame. Low on purpose: a card held
// back from the camera is small, and rejecting it means matching the whole photo —
// background included — which is far worse than a slightly loose crop. (The old
// floor was 0.15 while the comment above claimed 0.04; 4% is the intent.)
const MIN_AREA_FRAC = 0.04;
// Upper cap earns its keep: with the wrong OTSU polarity the BACKGROUND becomes
// the blob, and "the whole frame" has whatever aspect the sensor has — 3:4 sails
// through the card-aspect gate, scores enormously on area, and crops the entire
// photo. Keep this comfortably below 1.
const MAX_AREA_FRAC = 0.85;

function detectCard(rgbaData, w, h) {
  const src = cv.matFromImageData({ data: rgbaData, width: w, height: h });
  const gray = new cv.Mat(), blur = new cv.Mat();
  let out = null;
  let masks = [];
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    const imgArea = w * h, cx = w / 2, cy = h / 2, halfDiag = Math.hypot(w, h) / 2;
    let best = null; // { score, pts }

    // Freed in the finally below, not inline: an exception between here and there
    // would otherwise strand three full-frame Mats on the wasm heap, which never
    // shrinks — the failure mode that used to kill scanning after ~67 cards.
    masks = segmentations(blur, w, h);
    const MASK_NAMES = ['otsu-inv', 'otsu', 'canny'];
    for (let mi = 0; mi < masks.length; mi++) {
      const mask = masks[mi];
      const maskName = MASK_NAMES[mi] || `mask${mi}`;
      const contours = new cv.MatVector(), hier = new cv.Mat();
      try {
        cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        for (let i = 0; i < contours.size(); i++) {
          const c = contours.get(i);
          const area = cv.contourArea(c);
          if (area >= MIN_AREA_FRAC * imgArea && area <= MAX_AREA_FRAC * imgArea) {
            const rect = cv.minAreaRect(c);
            let rw = rect.size.width;
            let rh = rect.size.height;
            if (rw > rh) { const tmp = rw; rw = rh; rh = tmp; } // ensure portrait
            const ar = rw / rh; // ideal card aspect = 0.714

            if (ar >= 0.55 && ar <= 0.88) {
              const rcx = rect.center.x, rcy = rect.center.y;
              const centrality = 1 - Math.min(1, Math.hypot(rcx - cx, rcy - cy) / halfDiag);
              const aspectFit = 1 - Math.min(1, Math.abs(ar - CARD_ASPECT) / 0.15);

              // opencv-wasm calls this rotatedRectPoints and returns the points
              // directly. It has NO cv.boxPoints — the old code called that in its
              // fallback branch, so any contour without a clean hull quad threw
              // TypeError, aborted the whole detection (no catch inside), and the
              // scan silently fell back to matching the uncropped photo.
              const boxPts = cv.rotatedRectPoints(rect).map(p => ({ x: p.x, y: p.y }));

              // The hull quad follows real perspective, so it beats the bounding
              // box when it is trustworthy — but only then. An unvalidated quad was
              // preferred outright (1.2x), which is how a hand-merged blob's
              // garbage quad won over its own sane bounding box and sheared the crop.
              const hullQuad = findCardQuad(c);
              const hullMetrics = hullQuad && quadMetrics(hullQuad);
              const rectArea = rect.size.width * rect.size.height;
              const hullOk = isCardQuad(hullMetrics)
                // A trustworthy quad also has to explain the region it came from:
                // a sliver cutting across the blob does not.
                && hullMetrics.w * hullMetrics.h >= 0.7 * rectArea;

              const candidates = [];
              if (hullOk) candidates.push({ pts: hullMetrics.corners, bonus: 1.2, par: hullMetrics.parallelism, m: hullMetrics });
              const boxMetrics = quadMetrics(boxPts);
              if (isCardQuad(boxMetrics)) candidates.push({ pts: boxMetrics.corners, bonus: 1.0, par: boxMetrics.parallelism, m: boxMetrics });

              for (const cand of candidates) {
                // Belt to the area cap's braces: a quad that spans essentially the
                // whole frame is the background, not a card. Cropping to it is a
                // no-op that still runs the image through a perspective warp.
                if (cand.m.w >= 0.95 * w && cand.m.h >= 0.95 * h) continue;
                // How much of the quad the region actually fills. A card fills its
                // own outline almost completely; a region that merged the card with
                // a hand or a neighbouring card is L-shaped, so the quad drawn
                // around it is mostly empty.
                const fill = Math.min(1, area / Math.max(1, cand.m.w * cand.m.h));
                const score = (area / imgArea) * (aspectFit * aspectFit) * (0.4 + 0.6 * centrality) * cand.bonus * (0.5 + 0.5 * cand.par) * fill;
                if (!best || score > best.score) best = { score, pts: cand.pts, source: maskName, fill, par: cand.par, ar };
              }
            }
          }
          c.delete();
        }
      } finally { contours.delete(); hier.delete(); }
    }

    if (best && best.pts) {
      const [tl, tr, brc, bl] = orderQuad(best.pts);
      const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, brc.x, brc.y, bl.x, bl.y]);
      const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, WARP_W, 0, WARP_W, WARP_H, 0, WARP_H]);
      const M = cv.getPerspectiveTransform(srcTri, dstTri);
      const warped = new cv.Mat();
      cv.warpPerspective(src, warped, M, new cv.Size(WARP_W, WARP_H));
      // `quad`/`pick` are diagnostics only (preprocessCard ignores them); they make
      // a bad crop debuggable — which segmentation won, and where it thought the
      // card was — instead of guessable.
      out = {
        data: Buffer.from(warped.data), width: WARP_W, height: WARP_H, channels: 4,
        quad: [tl, tr, brc, bl].map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })),
        pick: { source: best.source, score: +best.score.toFixed(4), fill: +best.fill.toFixed(2), par: +best.par.toFixed(2), ar: +best.ar.toFixed(3) },
      };
      srcTri.delete(); dstTri.delete(); M.delete(); warped.delete();
    }
  } finally {
    for (const m of masks) { try { m.delete(); } catch { /* already freed */ } }
    src.delete(); gray.delete(); blur.delete();
  }
  return out;
}

// PHASE 4b: YOLO FIRST, CLASSICAL AS FALLBACK.
//
// The classical detector locks onto the TOPLOADER rather than the card it
// holds — the defect that broke Zach's sleeved scans. The trained detector
// fixes 8 of its 10 worst failures with zero regressions, so it leads.
//
// It is a FALLBACK, not a replacement, because the classical path still works
// on the cases it always worked on. If the model is missing, corrupt, slow to
// load, or unsure, we get today's behaviour rather than a broken scan.
//
// YOLO returns geometry only; the warp is done here so both paths produce the
// identical `{ data, width, height, quad, pick }` shape callers already expect.
// Doing it any other way would leak the choice of detector into every caller.
async function detectWithFallback(rgbaData, w, h) {
  let yolo = null;
  try {
    yolo = await cardDetector.detect(rgbaData, w, h);
  } catch (e) {
    console.warn('yolo detect threw, falling back:', e.message);
  }
  if (yolo && yolo.quad) {
    const warped = warpToQuad(rgbaData, w, h, yolo.quad);
    if (warped) return { ...warped, quad: yolo.quad, pick: yolo.pick };
    // A warp failure means the quad was unusable; fall through rather than
    // return a card-shaped nothing.
  }
  return detectCard(rgbaData, w, h);
}

// Warp an arbitrary quad to the matcher's canonical WARP_W x WARP_H card.
// Extracted from detectCard so both detectors share one implementation --
// two copies of a perspective transform is two chances to get the corner
// order subtly different, and that failure looks like a bad photo.
function warpToQuad(rgbaData, w, h, quad) {
  let src = null, srcTri = null, dstTri = null, M = null, warped = null;
  try {
    const [tl, tr, br, bl] = orderQuad(quad);
    src = cv.matFromImageData({ data: rgbaData, width: w, height: h });
    srcTri = cv.matFromArray(4, 1, cv.CV_32FC2,
      [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
    dstTri = cv.matFromArray(4, 1, cv.CV_32FC2,
      [0, 0, WARP_W, 0, WARP_W, WARP_H, 0, WARP_H]);
    M = cv.getPerspectiveTransform(srcTri, dstTri);
    warped = new cv.Mat();
    cv.warpPerspective(src, warped, M, new cv.Size(WARP_W, WARP_H));
    return { data: Buffer.from(warped.data), width: WARP_W, height: WARP_H, channels: 4 };
  } catch (e) {
    console.warn('warpToQuad failed:', e.message);
    return null;
  } finally {
    // Freed here, not inline: an exception mid-way would otherwise strand
    // full-frame Mats on the wasm heap, which never shrinks — the leak that
    // used to kill scanning after ~67 cards.
    for (const m of [src, srcTri, dstTri, M, warped]) {
      if (m) { try { m.delete(); } catch { /* already freed */ } }
    }
  }
}

// The width detection runs at. Detection is TUNED at this size (crop.test.js
// scores against it) so it is deliberately NOT a parameter — see rectifyCard.
const DETECT_W = 1200;

// Detect once and return BOTH the matcher's rectified card and the geometry that
// produced it. Split out of preprocessCard so the OCR path can re-warp the SAME
// quad at a larger size WITHOUT paying for a second detection: detectCard is
// ~350ms of the ~1.1s scan, and running it twice was by far the largest part of
// the OCR surcharge.
//
// `detect` is null when no card was found, which is how the caller distinguishes
// "rectified to the detected card" from "fell back to the whole photo".
async function preprocessCardWithDetection(imageBuffer) {
  try {
    const { data, info } = await sharp(imageBuffer).resize({ width: DETECT_W, withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const card = await detectWithFallback(new Uint8ClampedArray(data), info.width, info.height);
    if (card) {
      const buf = await sharp(card.data, { raw: { width: card.width, height: card.height, channels: 4 } }).png().toBuffer();
      return { buf, detect: { quad: card.quad, detW: info.width, detH: info.height } };
    }
  } catch (e) {
    console.warn('preprocessCard failed:', e.message);
  }
  return { buf: await sharp(imageBuffer).png().toBuffer(), detect: null };
}

// Produce the card image to match on: auto-crop + deskew to the detected card
// outline (works on light and dark backgrounds via dual-polarity thresholding),
// else fall back to the client's framed guide-box capture.
//
// Unchanged contract: still returns just the PNG buffer, still 500x700.
async function preprocessCard(imageBuffer) {
  return (await preprocessCardWithDetection(imageBuffer)).buf;
}

// Cap on the source image the OCR warp samples from, in pixels of width.
//
// NOT for accuracy — for the wasm heap. cv.matFromImageData copies the whole
// frame into the opencv-wasm heap, which never shrinks; a 12MP phone photo is
// ~48MB of RGBA per scan and that is the exact failure shape that used to kill
// scanning after ~67 cards. 2000px still leaves the card itself far larger than
// the 750x1050 the warp writes out, so this bounds memory without costing
// detail: it is a downsample of the strip, not an upsample.
const OCR_SRC_MAX_W = 2000;

// Rectify the detected card at an ARBITRARY output size, sampling from the
// ORIGINAL upload rather than from the matcher's output.
//
// WHY THIS EXISTS, and why it is not just `preprocessCard(buf, { width, height })`.
//
// The collector-number strip is ~5% of the card's height. preprocessCard warps
// to 500x700, so that strip leaves this module ~8px tall and already blurred;
// collectorNumberOcr then upscaled it 1.5x, which cannot put back detail that
// was thrown away. Measured through the real route, EVERY crop offset from 0.86
// to 0.96 scored 0/4 — and the offsets where the text half-appeared produced
// FABRICATED numbers that still reported confident=true.
//
// An option on preprocessCard would NOT have fixed it. preprocessCard detects on
// a 1200px downscale, so with the card at ~35% of the frame it is only ~420px
// wide there; warping THAT to 750x1050 is the identical upsample one layer down.
// The pixels have to come from the original buffer or nothing changes.
//
// So: reuse the SAME detected quad the matcher already found (pass it in as
// `detection`; card identification cannot move because detection is not re-run
// and its input is untouched), scale that quad back into original-image
// coordinates, and warp from the full-resolution source. Same card, same region,
// same crop fractions — just sampled with real pixels.
//
// Returns null if no card is known, so the caller can decline to OCR rather than
// read a number off the background.
// `region` (optional): { left, top, width, height } as FRACTIONS of the card.
// When given, only that part of the rectified card is produced -- same
// transform, same sampling, same pixels, just a smaller output canvas.
//
// WHY. Measured on 40 real captures, this warp costs 322ms and is the single
// most expensive step after ORB. It is expensive because it samples a 2000px
// source and writes a 1500x2100 card. But OCR only ever looks at two small
// bands: the collector strip (~2.8% of the card's area) and the title
// (~3.8%). The other ~93% is warped at full resolution and thrown away.
//
// This is NOT the "merge the two warps" idea, which I measured and rejected --
// deriving the matcher's 500x700 by downscaling the big warp cost 84ms against
// the 76ms warp it replaced, a net LOSS of 8ms. This is the opposite: warp
// less, not warp once.
//
// The maths is the same perspective transform with the destination corners
// SHIFTED so the requested region lands at the origin. warpPerspective then
// only computes pixels inside the smaller output, so the saving is real work
// avoided rather than a crop after the fact.
async function rectifyCard(imageBuffer, { width, height, detection, region } = {}) {
  const outW = Math.max(1, Math.round(width || WARP_W));
  const outH = Math.max(1, Math.round(height || WARP_H));
  // Where the region sits within the full rectified card, in output pixels.
  const rx = region ? region.left * outW : 0;
  const ry = region ? region.top * outH : 0;
  const rw = region ? Math.max(1, Math.round(region.width * outW)) : outW;
  const rh = region ? Math.max(1, Math.round(region.height * outH)) : outH;
  let srcMat = null, srcTri = null, dstTri = null, M = null, warped = null;
  try {
    let det = detection;
    if (!det) {
      // No detection supplied: do it ourselves, on EXACTLY the input
      // preprocessCard feeds detectCard. Do not "improve" this by detecting at a
      // higher resolution — the thresholds, morphology kernel sizes and area
      // floor are all tuned to 1200px.
      const d = await sharp(imageBuffer).resize({ width: DETECT_W, withoutEnlargement: true })
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const card = await detectWithFallback(new Uint8ClampedArray(d.data), d.info.width, d.info.height);
      if (!card) return null;
      det = { quad: card.quad, detW: d.info.width, detH: d.info.height };
    }
    if (!det.quad || !det.detW) return null;

    const src = await sharp(imageBuffer).resize({ width: OCR_SRC_MAX_W, withoutEnlargement: true })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    // The quad is in DETECTION coordinates. Both images came from the same
    // original with aspect preserved, so one scalar maps between them.
    const k = src.info.width / det.detW;
    const [tl, tr, br, bl] = det.quad;

    srcMat = cv.matFromImageData({ data: new Uint8ClampedArray(src.data), width: src.info.width, height: src.info.height });
    srcTri = cv.matFromArray(4, 1, cv.CV_32FC2,
      [tl.x * k, tl.y * k, tr.x * k, tr.y * k, br.x * k, br.y * k, bl.x * k, bl.y * k]);
    // Full-card destination, shifted so the requested region starts at (0,0).
    // With no region this is exactly the old [0,0,outW,0,outW,outH,0,outH].
    dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0 - rx, 0 - ry,
      outW - rx, 0 - ry,
      outW - rx, outH - ry,
      0 - rx, outH - ry,
    ]);
    M = cv.getPerspectiveTransform(srcTri, dstTri);
    warped = new cv.Mat();
    cv.warpPerspective(srcMat, warped, M, new cv.Size(rw, rh));
    return await sharp(Buffer.from(warped.data), { raw: { width: rw, height: rh, channels: 4 } }).png().toBuffer();
  } catch (e) {
    // Never throws: OCR is an enhancement. A failure here must degrade to "no
    // read" (review queue), never to a failed scan that loses a card Zach
    // physically scanned.
    console.warn('rectifyCard failed:', e.message);
    return null;
  } finally {
    for (const m of [srcMat, srcTri, dstTri, M, warped]) {
      if (m) { try { m.delete(); } catch { /* already freed */ } }
    }
  }
}

const orbDbs = {};         // game -> { map: Map(key->{name,offset,count}), descFd, kpFd } | null

function key(set, number) { return `${set}|${number}`; }

// Load a game's ORB index (offsets in RAM; descriptors/keypoints read from disk
// per candidate). Returns null if not built.
function loadOrbDb(game) {
  if (game in orbDbs) return orbDbs[game];
  const descPath = path.join(DATA_DIR, `${game}-orb-desc.bin`);
  const kpPath = path.join(DATA_DIR, `${game}-orb-kp.bin`);
  const metaPath = path.join(DATA_DIR, `${game}-orb-meta.json`);
  if (!fs.existsSync(descPath) || !fs.existsSync(kpPath) || !fs.existsSync(metaPath)) { orbDbs[game] = null; return null; }
  const meta = JSON.parse(fs.readFileSync(metaPath));
  const map = new Map();
  // A double-faced card has multiple rows under one set|number (one per face).
  // Store them as a list so verify can test each face and keep the best.
  for (const c of meta.cards) {
    const k = key(c[1], c[2]);
    const face = { name: c[0], offset: c[3], count: c[4] };
    const arr = map.get(k);
    if (arr) arr.push(face); else map.set(k, [face]);
  }
  orbDbs[game] = { map, descFd: fs.openSync(descPath, 'r'), kpFd: fs.openSync(kpPath, 'r') };
  console.log(`scanMatch: loaded ${game} ORB DB (${meta.cards.length} cards)`);
  return orbDbs[game];
}

// Read one card's stored descriptors (cv.Mat CV_8U) + keypoints (Float32Array xy).
function readOrb(db, offset, count) {
  const descBuf = Buffer.alloc(count * DESC_BYTES);
  fs.readSync(db.descFd, descBuf, 0, descBuf.length, offset * DESC_BYTES);
  const kpBuf = Buffer.alloc(count * 2 * 4);
  fs.readSync(db.kpFd, kpBuf, 0, kpBuf.length, offset * 2 * 4);
  const desc = new cv.Mat(count, DESC_BYTES, cv.CV_8U);
  desc.data.set(descBuf); // faster than matFromArray(Array.from(buf)); same bytes
  const kp = new Float32Array(kpBuf.buffer, kpBuf.byteOffset, count * 2);
  return { desc, kp };
}

// Query ORB features from an image buffer (grayscale, resized like the build).
async function queryOrb(orb, imageBuffer) {
  const { data, info } = await sharp(imageBuffer).resize({ width: REF_WIDTH, withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = cv.matFromImageData({ data: new Uint8ClampedArray(data), width: info.width, height: info.height });
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  const kpv = new cv.KeyPointVector();
  const desc = new cv.Mat();
  orb.detectAndCompute(gray, new cv.Mat(), kpv, desc);
  const kp = new Float32Array(kpv.size() * 2);
  for (let i = 0; i < kpv.size(); i++) { const p = kpv.get(i).pt; kp[i * 2] = p.x; kp[i * 2 + 1] = p.y; }
  rgba.delete(); gray.delete(); kpv.delete();
  return { desc, kp }; // caller deletes desc
}

// RANSAC-homography inlier count between query and a candidate's ORB features.
function inlierCount(bf, qDesc, qKp, cand) {
  if (cand.count < 4 || qDesc.rows < 4) return 0;
  const knn = new cv.DMatchVectorVector();
  bf.knnMatch(qDesc, cand.desc, knn, 2);
  const src = [], dst = [];
  for (let i = 0; i < knn.size(); i++) {
    const m = knn.get(i);
    if (m.size() >= 2) {
      const m0 = m.get(0), m1 = m.get(1);
      if (m0.distance < RATIO * m1.distance) {
        src.push(qKp[m0.queryIdx * 2], qKp[m0.queryIdx * 2 + 1]);
        dst.push(cand.kp[m0.trainIdx * 2], cand.kp[m0.trainIdx * 2 + 1]);
      }
    }
    m.delete(); // embind DMatchVector wrapper; leaks the wasm heap if not freed
  }
  knn.delete();
  const good = src.length / 2;
  if (good < 4) return 0;
  const srcM = cv.matFromArray(good, 1, cv.CV_32FC2, src);
  const dstM = cv.matFromArray(good, 1, cv.CV_32FC2, dst);
  const mask = new cv.Mat();
  const H = cv.findHomography(srcM, dstM, cv.RANSAC, RANSAC_PX, mask);
  const inl = H.empty() ? 0 : cv.countNonZero(mask);
  srcM.delete(); dstM.delete(); mask.delete(); H.delete();
  return inl;
}

const STRONG_INLIERS = 25;

// Beyond argument: stop verifying further candidates entirely. See the break in
// verifyGame. Deliberately far above STRONG_INLIERS, which answers a different
// and much weaker question ("should we bother checking the other game").
const CERTAIN_INLIERS = 80;

// Compare a catalogue value with an OCR reading. Collector numbers are strings
// ('123a', 'GR1'), and the card prints '0207' where the catalogue stores '207',
// so leading zeros are stripped on BOTH sides. No numeric coercion: parseInt
// would turn '123a' into 123 and match a different printing.
function normHint(v) {
  return String(v == null ? '' : v).trim().toLowerCase().replace(/^0+/, '');
}

// Cards whose printings are visually near-identical, so a strong ORB match does
// NOT imply the best ORB match. See the break in verifyGame: these are excluded
// from the early exit because dozens of their printings score 80+ against the
// same photo.
const BASIC_LAND_NAMES = new Set([
  'plains', 'island', 'swamp', 'mountain', 'forest', 'wastes',
  'snow-covered plains', 'snow-covered island', 'snow-covered swamp',
  'snow-covered mountain', 'snow-covered forest',
]);

// Score one game: CLIP recall + ORB verify against the shared query features.
// `ocrHint` is { sets: [...], numbers: [...] } read from the collector strip
// BEFORE this runs. It is a STOP CONDITION ONLY -- see the break below. It can
// never introduce, reorder or select a candidate, so a wrong hint costs time
// and nothing else.
// Move candidates whose set+number match the OCR reading to the front,
// preserving relative order otherwise. A stable partition over <=50 items.
function hintFirst(recall, hint) {
  const hit = [];
  const rest = [];
  for (const c of recall) {
    if (hint.numbers.includes(normHint(c.number)) && hint.sets.includes(normHint(c.set))) hit.push(c);
    else rest.push(c);
  }
  return hit.length ? hit.concat(rest) : recall;
}

function verifyGame(cardBuf, game, q, bf, recall, topK, ocrHint = null) {
  const db = loadOrbDb(game);
  if (!db) return { verified: false, candidates: recall.slice(0, topK), top: 0 };
  const scored = [];
  const seen = new Set(); // recall may list both faces of a DFC; verify each card once

  // VERIFY THE PRINTED NUMBER'S CANDIDATE FIRST.
  //
  // Zach: "how would you fix the ordering?"
  //
  // THE MEASUREMENT THAT FORCED THIS. Adding the agreement break below bought
  // only 10% -- against the ~45% I predicted -- and the reason was the order
  // this loop walks. `recall` is CLIP's artwork ranking, which knows nothing
  // about the collector strip. Measured on the corpus, the true card sits at
  // p50 rank 1 but p90 rank 19 and max 40 IN RECALL ORDER, so the break fired
  // immediately on about half of scans and only after 19-40 verifications on
  // the rest.
  //
  // (My earlier "rank 1 in 93% of scans" was measured on the OUTPUT list, which
  // is sorted by inliers AFTER all the work is done. Real number, wrong list.)
  //
  // The strip has already been read by the time this runs, so the candidate it
  // names can simply be checked FIRST. Rank 19 becomes rank 1 and the break
  // fires on the first verification.
  //
  // THIS CANNOT CHANGE WHICH CARD WINS, and that is the whole safety argument:
  //
  //   - nothing is added to the list and nothing is removed
  //   - every candidate still gets an identical inlierCount call
  //   - `scored` is sorted by inliers afterwards regardless of visit order
  //
  // So the ONLY observable difference is where the loop stops -- and it stops
  // only where the break's own conditions are met.
  //
  // A WRONG NUMBER COSTS MILLISECONDS, NOT CORRECTNESS. If OCR misread, the
  // candidate promoted here will not match the artwork, its inlier count stays
  // low, the break does not fire, and the loop continues through the entire
  // list exactly as before. The 10 confidently-wrong reads in the corpus are
  // still caught by ORB disagreeing.
  const ordered = ocrHint ? hintFirst(recall, ocrHint) : recall;

  for (const cand of ordered) {
    const k = key(cand.set, cand.number);
    if (seen.has(k)) continue;
    seen.add(k);
    const faces = db.map.get(k);
    let inliers = 0;
    if (faces) {
      for (const face of faces) {
        const ref = readOrb(db, face.offset, face.count);
        const inl = inlierCount(bf, q.desc, q.kp, ref);
        ref.desc.delete();
        if (inl > inliers) inliers = inl; // best-matching face wins
      }
    }
    scored.push({ name: cand.name, set: cand.set, number: cand.number, score: cand.score, inliers });

    // STOP ONCE A MATCH IS BEYOND ARGUMENT.
    //
    // Zach: "I would like to work on speed next." Measured over 38 real scans,
    // orb-verify is 1195ms of a 3112ms scan -- 38%, the largest single cost. It
    // verified all ~50 recalled candidates every time, even after finding a
    // 141-inlier match at rank 2.
    //
    // The obvious lever, cutting recallK, is NOT safe: measured on the corpus,
    // the correct card is present in 71.7% of scans at K=50 but only 65.2% at
    // K=25. Its rank is p50 2 but p90 25 -- usually near the top, sometimes
    // deep. Trading six points of recall for speed is the wrong trade for an
    // app that must not misidentify a physical card.
    //
    // This is the safe version of the same idea: keep looking at all 50
    // candidates, but stop EARLY when the current best is so strong that no
    // later candidate could displace it.
    //
    // WHY THIS THRESHOLD. Measured inlier separation across every scan in this
    // project: WRONG matches top out at 30, RIGHT matches run 35-162. Genuine
    // winners on Zach's cards sit at 65-167. CERTAIN_INLIERS is set at 80 --
    // more than twice the highest wrong match ever observed, and comfortably
    // above STRONG_INLIERS (25), which only means "confident enough to skip the
    // OTHER GAME".
    //
    // The cost of being wrong here is bounded and small: the only thing skipped
    // is the chance that a LATER candidate scores even higher. Both would be
    // the same card in practice, since two different cards do not both produce
    // 80+ geometric inliers against one photo. And a lower-ranked candidate
    // beating an 80+ match has never been observed in the corpus.
    //
    // MEASURED AND REJECTED AT 80, THEN RESTRICTED. Running the corpus with and
    // without this break changed 7 identifications in 160 -- and EVERY ONE was a
    // basic land (Forest), swapping one printing for another:
    //
    //     withExit Forest/eld#266 (86)   vs   full Forest/soi#297 (91)
    //     withExit Forest/akh#268 (80)   vs   full Forest/hou#199 (113)
    //
    // Basic lands break the assumption the threshold rests on. Every Forest
    // shares a frame, a mana symbol and a similar landscape, so DOZENS of
    // different printings all score 80-120 inliers against one photo. "No later
    // candidate could beat this" is simply false for them: the first 80+ match
    // is not the best 80+ match, just the earliest.
    //
    // For a basic land that is nearly harmless -- Zach picks the printing
    // anyway, and the art matcher was never going to separate them. But the
    // check is absolute: an optimisation that changes ANY answer does not ship
    // as-is. So the break only fires when the card ALSO has a distinguishing
    // name, which is exactly the case where a strong ORB match is decisive.
    if (inliers >= CERTAIN_INLIERS && !BASIC_LAND_NAMES.has((cand.name || '').toLowerCase())) break;

    // TWO INDEPENDENT METHODS AGREE: STOP.
    //
    // Zach: "So would it make sense to have OCR go first and then see if orb
    // agrees? And stop it early if it does? That way it's almost always
    // stopping early regardless of card?"
    //
    // Measured on his 208-scan corpus, this is exactly right:
    //   - when ORB finds the card at all it is candidate #1 in 93% of scans
    //     (rank <=3 in 99%, p90 rank 1), so candidates 2-50 are near-pure waste
    //   - the printed collector number is correct on 81% of scans
    //   - orb-verify was 997ms of a 1896ms scan -- 49%, the largest single cost
    //
    // WHY THIS IS SAFER THAN THE CERTAIN_INLIERS BREAK ABOVE, not merely
    // faster. That one trusts ORB alone past a threshold. This one requires the
    // ARTWORK and the PRINTED TEXT -- two methods that fail in unrelated ways --
    // to name the same printing. Two independent agreeing signals is a stronger
    // claim than either alone at any threshold.
    //
    // THE THRESHOLD IS CERTAIN_INLIERS (80), NOT A LOWER "AGREEMENT" FLOOR.
    //
    // A 35-inlier floor shipped here first, and code review caught that it was
    // unsafe. The reasoning it rested on -- "`scored` is sorted afterwards, so
    // visit order cannot change the winner" -- holds only while the loop visits
    // the SAME SET of candidates. The break truncates that set, and hintFirst
    // decides which candidates fall inside the truncation. The winner is
    // max(inliers) over the VISITED PREFIX, so the hint really could change it.
    // Reproduced before fixing:
    //
    //   recall: [.., msh#213 (OCR's WRONG read, 40), .., msh#432 (TRUE, 60)]
    //   no hint    -> msh#432 wins   (visits 4)
    //   wrong hint -> msh#213 WINS   (visits 1)
    //
    // 40 inliers is not noise -- measured RIGHT matches run 35-162, so a wrong
    // card scoring 40 sits inside the legitimate band and no floor in that
    // range could exclude it. OCR reads a confident WRONG printing on ~5% of
    // scans (10 of 208 on the corpus), which is exactly when this fires.
    //
    // Worse, it destroyed the cross-check the optimisation claimed to preserve:
    // once ORB's top can be FORCED to agree with the OCR read, the resolver's
    // disagreement branch sees agreement and stages silently. Two independent
    // signals stop being independent.
    //
    // At CERTAIN_INLIERS the break is a genuine no-op on the result: 80 is more
    // than twice the highest wrong match ever observed here, so no later
    // candidate can plausibly beat it. The speed win survives because a hinted
    // candidate that IS the true card measures 65-167 on Zach's cards. Basic
    // lands are excluded for the same reason as the break above -- dozens of
    // Forest printings all score 80+, so the first is not the best.
    //
    // This fires less often than the unsafe version, so it is slower. A wrong
    // card is worse than a slow scan.
    if (ocrHint && inliers >= CERTAIN_INLIERS
        && !BASIC_LAND_NAMES.has((cand.name || '').toLowerCase())
        && ocrHint.numbers.includes(normHint(cand.number))
        && ocrHint.sets.includes(normHint(cand.set))) {
      break;
    }
  }
  scored.sort((a, b) => (b.inliers - a.inliers) || (b.score - a.score));
  const top = scored[0];
  // SCAN_RANK_LOG=1: measure where the ORB winner sat in the CLIP recall list.
  // 0-indexed rank; if these stay well below K, RECALL_K can be lowered losslessly.
  // Appended to a file (flushed) instead of stdout, which block-buffers through pipes.
  if (process.env.SCAN_RANK_LOG && top && top.inliers > 0) {
    const rank = recall.findIndex(r => r.set === top.set && r.number === top.number);
    fs.appendFileSync(path.join(__dirname, '..', 'scan-rank.log'),
      `game=${game} K=${recall.length} winnerClipRank=${rank} inliers=${top.inliers} name=${top.name}\n`);
  }
  return { verified: true, candidates: scored.slice(0, topK), top: top ? top.inliers : 0 };
}

// Identify a card image. Auto-detects the game: verifies the requested game
// first and, if the match is weak, also tries the other game and keeps whichever
// scores higher — so scanning in the wrong mode still works. Returns
// { game, verified, candidates:[{name,set,number,score,inliers}], crop }.
async function match(imageBuffer, requestedGame, topK = 8, setCode = '', opts = {}) {
  requestedGame = 'mtg';
  const lang = 'en';
  // Stage timing, no-op unless SCAN_PROFILE=1. `opts.prof` is passed by the
  // route so one profiler spans the whole request; a bare call still works.
  const prof = opts.prof || scanProfile.start();
  // THE COLLECTOR-STRIP READING, when the caller read it first. Purely a stop
  // condition for verifyGame -- it never selects, adds or reorders a candidate.
  // Absent (the default) means the old exhaustive behaviour, so every caller
  // that does not supply it is unaffected.
  const ocrHint = (opts.ocrHint
    && Array.isArray(opts.ocrHint.sets) && opts.ocrHint.sets.length
    && Array.isArray(opts.ocrHint.numbers) && opts.ocrHint.numbers.length)
    ? { sets: opts.ocrHint.sets.map(normHint), numbers: opts.ocrHint.numbers.map(normHint) }
    : null;
  // Scan-detail knobs (client "Scan Detail" slider). Fewer CLIP candidates to
  // verify + fewer ORB features = faster, less accurate. Clamped to sane bounds.
  // RECALL_K STAYS AT 50, AND THE DEPTH QUESTION IS SETTLED. Measured over six
  // full corpus replays (208 scans each) at K=50, 150 and 300:
  //
  //   break+reorder K=50   p50 1448ms   p90 2174ms   173 correct
  //   conditional  K=150   p50 1449ms   p90 2116ms   173 correct
  //   conditional  K=300   p50 1451ms   p90 2089ms   173 correct
  //
  // Indistinguishable. Deeper recall finds more cards -- true card within K=50
  // 63%, K=150 76%, K=300 79% -- but the curve flattens hard and the extra
  // cards were ALREADY being rescued by the collector number afterwards, so
  // K=150 recovered exactly one resolution in 208 and K=300 recovered none.
  //
  // The mechanism is self-cancelling: when the card IS recalled the agreement
  // break fires early and the extra depth is free; when it is NOT, ORB grinds
  // the whole longer list. Depth costs most where it helps least.
  //
  // The ~15% remaining are not deep in the list -- CLIP does not recognise them
  // from those photos at all (glare, angle, foil). That is an EMBEDDING
  // problem, not a recall-depth one, and no K short of the full catalogue
  // touches it.
  const recallK = Math.max(10, Math.min(RECALL_K, opts.recallK || RECALL_K));
  const orbN = Math.max(150, Math.min(800, opts.orb || 500));
  // Auto-crop + deskew the card once; everything matches on the rectified image.
  //
  // The DETECTION GEOMETRY is kept, not just the image. Callers that want a
  // different rendering of the same card (the OCR path needs the collector strip
  // at collectorNumberOcr.OCR_W x OCR_H, sampled from the original upload) can re-warp this exact quad
  // instead of running detectCard a second time — which costs ~350ms, a third of
  // the whole scan. `detection` is returned on the result and is inert for every
  // caller that ignores it.
  // REUSE A DETECTION THE CALLER ALREADY PAID FOR.
  //
  // The route now reads the collector strip BEFORE matching (to give
  // verifyGame a stop condition), which means it has already run
  // preprocessCardWithDetection. Detecting again here would cost ~130ms and
  // hand back the identical quad, turning a reordering into a regression.
  //
  // opts.preprocessed is the { buf, detect } pair from that call. Absent, this
  // behaves exactly as before.
  const pre = opts.preprocessed;
  const { buf: cardBuf, detect } = (pre && pre.buf)
    ? pre
    : await prof.time('detect+preprocess', () => preprocessCardWithDetection(imageBuffer));
  // The 220px JPEG thumbnail returned to the client. Never timed before, and it
  // is a full JPEG encode on every scan.
  const crop = await prof.time('crop-thumb-jpeg', async () =>
    'data:image/jpeg;base64,' + (await sharp(cardBuf).resize({ width: 220 }).jpeg({ quality: 70 }).toBuffer()).toString('base64'));

  // Query ORB features are game-independent — extract once, reuse everywhere.
  const orb = new cv.ORB(orbN);
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const q = await prof.time('orb-query-features', () => queryOrb(orb, cardBuf));
  try {
    // Set-scoped fast path: if the user gave set code(s) and their index is
    // built, match only within them (~300 cards each) — accurate, no global
    // recall. Multiple sets ("ltr,ltc") match each ready set and merge by inliers.
    const readySets = parseSetList(setCode).filter(s => setIndex.isReady(requestedGame, s, lang));
    if (readySets.length) {
      const qHash = await setIndex.dhash(cardBuf); // cheap recall pre-filter within the set
      const perSet = await Promise.all(readySets.map(s => setIndex.matchSet(q, requestedGame, s, topK, qHash, lang)));
      const merged = perSet.filter(Boolean).flat().sort((a, b) => b.inliers - a.inliers).slice(0, topK);
      if (merged.length) return { game: requestedGame, verified: true, candidates: merged, crop, scoped: true, lang, detection: detect };
    }

    // Nothing built for this language: the global fallback below would only ever
    // answer in English, so say why instead of handing back a wrong card.
    if (lang !== 'en') {
      return { game: requestedGame, verified: false, candidates: [], crop, lang, englishOnly: true, detection: detect };
    }

    const order = ['mtg'];
    let best = null;
    for (const g of order) {
      // THE TWO HALVES OF THE GLOBAL PATH, timed separately. Together these are
      // the ~1.6s "ORB matching", but they are very different work: recall is a
      // CLIP embedding + vector search, verify is ORB geometric matching over
      // recallK candidates. Which one dominates decides what to fix.
      const recall = await prof.time('clip-recall', () => embedMatch.match(cardBuf, g, recallK));
      if (recall.length === 0) continue;
      const r = await prof.time('orb-verify', async () => verifyGame(cardBuf, g, q, bf, recall, topK, ocrHint));
      prof.set('recallK', recallK);
      prof.set('recallReturned', recall.length);
      prof.set('orbN', orbN);
      if (!best || r.top > best.top) best = { ...r, game: g };
      if (best.top >= STRONG_INLIERS) break; // confident — no need to try the other game
    }
    if (!best) return { game: requestedGame, verified: false, candidates: [], crop, detection: detect };
    return { game: best.game, verified: best.verified, candidates: best.candidates, crop, detection: detect };
  } finally {
    q.desc.delete(); bf.delete(); orb.delete();
  }
}

// Evict a game's cached ORB DB (closing its file descriptors) so the next match
// reloads from disk. Called after a global rebuild swaps in fresh files.
function reload(game) {
  const db = orbDbs[game];
  if (db) { try { fs.closeSync(db.descFd); fs.closeSync(db.kpFd); } catch { /* already closed */ } }
  delete orbDbs[game];
}

// _warpToQuad is exported for diagnostics only (measuring how quad geometry
// affects match quality); the scan path uses it via detectWithFallback.
module.exports = { match, reload, preprocessCard, preprocessCardWithDetection, detectCard, rectifyCard, _warpToQuad: warpToQuad };
