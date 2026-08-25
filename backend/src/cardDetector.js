// PHASE 4b — YOLO CARD DETECTION.
//
// Replaces the classical contour detector, which locked onto the TOPLOADER
// rather than the card it holds. Measured on Zach's 33 real scans: of the 10
// where the classical detector returns nothing or a >90%-of-frame box, this
// finds a plausible card on 8, with ZERO regressions where the old one worked.
//
// DROP-IN BY DESIGN. `detect()` takes the same RGBA buffer detectCard() takes
// and returns the same `{ quad, pick }` shape, so scanMatch.js keeps ownership
// of warping, sizing and everything downstream. Nothing here knows what a card
// image is for.
//
// FALLBACK IS THE WHOLE POINT. Returning null means "no opinion", and every
// caller already handles that by falling back to the classical detector. A
// missing model file, a corrupt model, a failed inference — all degrade to the
// behaviour Zach has today rather than to a broken scan. He is holding a
// physical card; a detector upgrade must never be able to lose it.
'use strict';

const fs = require('fs');
const path = require('path');

const MODEL_PATH = process.env.CARD_DETECTOR_MODEL
  || path.join(__dirname, '..', 'models', 'card-detector.onnx');

// The exported graph is fixed at 416x416 (see train-detector.py --imgsz 416).
// Feeding any other size throws; the size is not negotiable at runtime.
const NET = 416;

// Below this the detection is not trusted and we defer to the classical path
// rather than warp to a guess.
const CONF_MIN = Number(process.env.CARD_DETECTOR_CONF || 0.25);

let state = null;   // null = untried, false = unavailable, object = loaded

async function load() {
  if (state !== null) return state;
  try {
    if (!fs.existsSync(MODEL_PATH)) {
      console.warn(`card detector: no model at ${MODEL_PATH}, using classical detection`);
      state = false;
      return state;
    }
    const ort = require('onnxruntime-node');
    const session = await ort.InferenceSession.create(MODEL_PATH, {
      // One thread. The box has 2 cores and the scan path already competes with
      // ORB, OCR and the HTTP server; letting ORT grab both cores made the
      // whole request slower, not faster.
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
    });
    state = { ort, session };
    console.log(`card detector: loaded ${path.basename(MODEL_PATH)}`);
  } catch (e) {
    console.warn('card detector unavailable:', e.message);
    state = false;      // permanent: do not retry per scan
  }
  return state;
}

// Letterbox RGBA -> the network's square input, preserving aspect.
//
// SQUASHING WOULD BE A BUG, not a shortcut: the model was trained on letterboxed
// images, and a distorted input moves every predicted corner. The padding
// offsets are returned so the output can be mapped back to real pixels.
function letterbox(rgba, w, h) {
  const scale = Math.min(NET / w, NET / h);
  const nw = Math.round(w * scale), nh = Math.round(h * scale);
  const padX = Math.floor((NET - nw) / 2), padY = Math.floor((NET - nh) / 2);

  // CHW float32, RGB, 0-1 — the layout ultralytics exports expect.
  const chw = new Float32Array(3 * NET * NET);
  const plane = NET * NET;
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor(y / scale));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor(x / scale));
      const si = (sy * w + sx) * 4;
      const di = (y + padY) * NET + (x + padX);
      chw[di] = rgba[si] / 255;
      chw[plane + di] = rgba[si + 1] / 255;
      chw[2 * plane + di] = rgba[si + 2] / 255;
    }
  }
  return { chw, scale, padX, padY };
}

// YOLO OBB output: [1, 6, N] = cx, cy, w, h, class-score, angle (radians).
function bestDetection(data, dims) {
  const n = dims[2];
  let bi = -1, bs = -1;
  for (let i = 0; i < n; i++) {
    const s = data[4 * n + i];
    if (s > bs) { bs = s; bi = i; }
  }
  if (bi < 0 || bs < CONF_MIN) return null;
  return {
    cx: data[bi], cy: data[n + bi], w: data[2 * n + bi], h: data[3 * n + bi],
    angle: data[5 * n + bi], score: bs,
  };
}

// Rotated box -> four corners.
//
// THE ORDER MATTERS MORE THAN IT LOOKS, and getting it wrong is nearly
// invisible. The model's `angle` describes a rotated rectangle, but nothing in
// it says which edge is the card's TOP. Four corners can enclose the card
// perfectly while starting at the wrong one, and the warp then yields a card
// rotated 90 or 180 degrees. The artwork matcher barely cares -- but the
// collector number ends up sideways or upside down, and OCR returns either
// nothing or a confident WRONG number. That is the "silently record a card
// Zach doesn't own" failure, and the OCR regression test caught it twice here:
// first a 90-degree rotation, then a 180-degree flip.
//
// The model cannot tell us which end is up (it was trained on cards at every
// orientation), so this only guarantees the SHAPE is right: short edge first,
// so the warp produces a portrait card rather than a landscape one.
// Up-vs-down is resolved downstream, where the card's own content can vote.
function corners(d, scale, padX, padY) {
  const ca = Math.cos(d.angle), sa = Math.sin(d.angle);
  const hw = d.w / 2, hh = d.h / 2;
  const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx, dy]) => ({
    x: Math.round((d.cx + dx * ca - dy * sa - padX) / scale),
    y: Math.round((d.cy + dx * sa + dy * ca - padY) / scale),
  }));

  // A Magic card is 63x88mm -- taller than wide. If the leading edge is the
  // longer one, the box is described sideways; rotate the list so the short
  // edge leads and the warp comes out portrait.
  const len = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const rotated = len(pts[0], pts[1]) > len(pts[1], pts[2])
    ? [pts[1], pts[2], pts[3], pts[0]]
    : pts;

  // ...then make the TOP edge the one nearer the top of the photo. Without
  // this the card comes out upside down half the time -- the 180-degree case
  // that survived the fix above.
  const midY = (a, b) => (a.y + b.y) / 2;
  if (midY(rotated[0], rotated[1]) > midY(rotated[2], rotated[3])) {
    return [rotated[2], rotated[3], rotated[0], rotated[1]];
  }
  return rotated;
}

/**
 * Detect a card. Same input and output contract as scanMatch.detectCard's
 * geometry half, so it can stand in front of it.
 *
 * @returns {Promise<{quad: {x,y}[], pick: object}|null>} null = no opinion,
 *          caller should fall back.
 */
async function detect(rgbaData, w, h) {
  try {
    const st = await load();
    if (!st) return null;

    const { chw, scale, padX, padY } = letterbox(rgbaData, w, h);
    const t0 = Date.now();
    const out = await st.session.run({
      images: new st.ort.Tensor('float32', chw, [1, 3, NET, NET]),
    });
    const tensor = out[Object.keys(out)[0]];
    const det = bestDetection(tensor.data, tensor.dims);
    if (!det) return null;

    const quad = corners(det, scale, padX, padY);

    // A quad outside the frame means the mapping is wrong, not that the card is
    // outside the photo. Refuse rather than hand scanMatch a bad warp.
    const slack = 0.15;
    const okX = quad.every(p => p.x > -w * slack && p.x < w * (1 + slack));
    const okY = quad.every(p => p.y > -h * slack && p.y < h * (1 + slack));
    if (!okX || !okY) {
      console.warn('card detector: quad outside frame, deferring to classical');
      return null;
    }

    return {
      quad,
      pick: { source: 'yolo', score: +det.score.toFixed(4), ms: Date.now() - t0 },
    };
  } catch (e) {
    console.warn('card detector failed:', e.message);
    return null;
  }
}

function available() { return state !== false; }

module.exports = { detect, available, _reset: () => { state = null; }, MODEL_PATH, NET };
