// ON-DEVICE CARD DETECTION FOR THE LIVE PREVIEW.
//
// WHY THIS EXISTS. The preview loop used an edge-projection detector
// (liveCardDetect.js) that finds the strongest horizontal and vertical edges in
// a 160px greyscale frame. That works when a card sits on a contrasting
// surface. Zach drops cards ON TOP OF A STACK OF OTHER CARDS, where there is no
// contrasting background at all -- so the strongest edges belong to the cards
// underneath, the mat, or the frame border.
//
// MEASURED on his 33 real scans: the edge detector finds a card in 9/33, and
// instrumenting every rejection path showed 21 of the 24 failures are the
// ASPECT test -- the box it found had aspect 0.196-2.176 against a card's
// 0.716. It was not finding cards; it was finding whatever had the strongest
// edges.
//
// Everything downstream hangs off that: auto-scan requires a detection on 3
// consecutive frames, so a detector at 9/33 on SETTLED photos makes live
// scanning intermittent. That is exactly what Zach reported: "it intermittently
// scanned cards".
//
// THE REPLACEMENT is the detector already trained in Phase 4b. Same model, same
// weights, same decode as the server's cardDetector.js -- which finds 31/33 of
// those same photos. Phase 4a measured it at 142ms p50 on Zach's iPhone 16 over
// 2,195 inferences with zero crashes, so it comfortably fits the ~7fps preview
// loop.
//
// Zach: "yeah I said this earlier about using the yolo detector for measuring
// this please build it." He did, and he was right; I used it only for a
// placement heuristic instead of replacing the detector outright.
//
// DESIGN RULES, learned the hard way in this project:
//   - Never block the preview. Every failure path returns null and the caller
//     carries on: a detector that throws would freeze the outline, and a
//     detector that never loads must degrade to "no detection", never to a
//     stuck promise.
//   - Never run two inferences at once. The loop ticks every 140ms and
//     inference is ~142ms, so overlapping calls are guaranteed without a latch.
//   - Load lazily and once. The model is ~10.7MB; fetching it per frame or per
//     mount would be worse than the bug being fixed.

let ort = null;
let session = null;
let loadPromise = null;
let busy = false;
let backendName = 'none';

// The exported graph is fixed at 416x416 (train-detector.py --imgsz 416).
// Feeding any other size throws — this is not negotiable at runtime.
const NET = 416;

// TWO DIFFERENT QUESTIONS, TWO DIFFERENT FLOORS.
//
// Zach: "the 1st one is just the empty box it shouldn't be scanning until a
// card is there."
//
// The server's floor is 0.25 and that is correct THERE, because the server is
// asked "Zach deliberately captured this photo -- where is the card in it?"
// A permissive floor is right for that: refusing a real capture is worse than
// a loose crop.
//
// The preview is asked a different question -- "should I take a photo AT ALL?"
// -- and a false positive there means scanning an empty box and putting a
// nonsense row in the queue. Zach counts queue entries as failures, and a scan
// of nothing is the least defensible one.
//
// MEASURED on his own captures: real cards score 0.933-0.951 (min 0.933,
// median 0.946). Synthetic empty frames -- flat surface, and an empty
// card-shaped tray outline -- produce NO detection at all. So there is a very
// wide gap between "a card" and "not a card", and 0.60 sits in the middle of
// it rather than near either edge.
//
// This is deliberately NOT the server's constant. The preview may be stricter
// than the server; it must never be looser, or it would draw an outline the
// server then refuses.
const CONF_MIN = 0.60;

// How much of the model's predicted box must remain after clamping to the
// frame. Below this the prediction was mostly off-screen, and what is left is a
// sliver of the mat rather than a card.
const VISIBLE_MIN = 0.55;

// A detection must plausibly BE a card-sized region of the frame.
//
// MEASURED on 98 detections from Zach's corpus, as a fraction of frame area:
//
//     min 0.530   p05 0.627   p50 0.686   p95 1.089   max 1.290
//
// Note the values ABOVE 1.0: a card held close legitimately extends past the
// frame edge, so the predicted box is larger than the frame itself. My first
// AREA_MAX of 0.98 would have rejected 8 REAL detections -- the check caught my
// own guard being wrong, which is exactly why it was written before shipping.
//
// So there is no upper bound on the CLAMPED area at all: the VISIBLE_MIN test
// above already handles a box that is mostly off-screen, and it does so without
// assuming anything about how close he holds the card.
//
// The lower bound stays well under the observed minimum of 0.530. A sliver is
// never a card, and nothing real in the corpus comes close to 0.12.
const AREA_MIN = 0.12;

export function detectorBackend() { return backendName; }
export function detectorReady() { return !!session; }

// Load the model once. Safe to call repeatedly; concurrent callers share the
// same promise, and a failure is remembered as "unavailable" rather than
// retried on every frame.
export function initCardDetector(basePath = '/models/') {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      // VENDORED, NOT FROM A CDN. server.js sets a CSP allowing 'self' only,
      // so a CDN import is blocked outright — and weakening the production CSP
      // to load a model would be the wrong trade.
      //
      // Pinned to the same 1.20.x build the Phase 4a spike measured on Zach's
      // phone. Newer JSEP builds are implicated in onnxruntime #26827 on iOS.
      ort = await import(/* @vite-ignore */ `${basePath}ort.webgpu.min.mjs`);
      ort.env.wasm.wasmPaths = basePath;
      // Threads off: cross-origin isolation is not configured, so
      // SharedArrayBuffer is unavailable and requesting threads fails in a
      // confusing way rather than an obvious one.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.simd = true;

      // WebGPU first, WASM fallback. On the spike this landed on WebGPU at
      // 142ms; WASM is slower but still usable, so a fallback is a degradation
      // rather than a failure.
      for (const ep of [['webgpu'], ['wasm']]) {
        try {
          session = await ort.InferenceSession.create(`${basePath}card-detector.onnx`, {
            executionProviders: ep, graphOptimizationLevel: 'all',
          });
          backendName = ep[0];
          break;
        } catch (e) {
          console.warn(`card detector: ${ep[0]} unavailable —`, String(e).slice(0, 120));
        }
      }
      if (!session) throw new Error('no execution provider could load the model');
      console.log(`card detector: ready on ${backendName}`);
      return true;
    } catch (e) {
      // DEGRADE, DO NOT THROW. The caller falls back to the edge detector, and
      // a scanner with a worse detector still beats a scanner that crashed.
      console.warn('card detector: unavailable —', e.message);
      session = null;
      backendName = 'none';
      return false;
    }
  })();
  return loadPromise;
}

// Letterbox RGBA into the network's square input, preserving aspect.
//
// SQUASHING WOULD BE A BUG, not a shortcut: the model trained on letterboxed
// images, so a distorted input moves every predicted corner. The padding
// offsets come back so the output maps to real pixels.
function letterbox(rgba, w, h) {
  const scale = Math.min(NET / w, NET / h);
  const nw = Math.round(w * scale), nh = Math.round(h * scale);
  const padX = Math.floor((NET - nw) / 2), padY = Math.floor((NET - nh) / 2);
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
// Identical to the server's decode in backend/src/cardDetector.js; if one
// changes the other must, or the preview and the server disagree about where
// the card is.
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

// Detect a card in an RGBA frame.
//
// Returns { x, y, w, h, confidence } in the SAME coordinate space the caller
// passed in — deliberately the shape liveCardDetect.detectCardInFrame returns,
// so this is a drop-in replacement and the outline-mapping code downstream does
// not change.
//
// Returns null for "no card" AND for every failure. The preview must never
// break because detection had a bad frame.
export async function detectCardOnDevice(rgba, w, h) {
  if (!session || busy) return null;
  busy = true;
  try {
    const { chw, scale, padX, padY } = letterbox(rgba, w, h);
    const tensor = new ort.Tensor('float32', chw, [1, 3, NET, NET]);
    const feeds = {};
    feeds[session.inputNames[0]] = tensor;
    const out = await session.run(feeds);
    const first = out[session.outputNames[0]];
    const d = bestDetection(first.data, first.dims);
    if (!d) return null;

    // The rotated box's corners, mapped back through the letterbox. The
    // PREVIEW only needs an axis-aligned box for the outline and the stability
    // comparison, so the enclosing rect of those corners is enough here — the
    // server does its own detection for the actual warp, at full resolution.
    const ca = Math.cos(d.angle), sa = Math.sin(d.angle);
    const hw = d.w / 2, hh = d.h / 2;
    const xs = [], ys = [];
    for (const [dx, dy] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
      xs.push((d.cx + dx * ca - dy * sa - padX) / scale);
      ys.push((d.cy + dx * sa + dy * ca - padY) / scale);
    }
    // REFUSE A BOX THAT IS MOSTLY OUTSIDE THE FRAME, rather than clamping it.
    //
    // Zach: "those crops were outside the card I could see it when I was
    // scanning it got stuck like that for a bit too."
    //
    // Several of his queue rows carried near-empty thumbnails (2.6KB against a
    // normal 15KB) -- pictures of the mat, not of a card.
    //
    // The raw box was CLAMPED to the frame here. When the model regresses a box
    // that is largely off-screen, clamping does not discard it: it squashes it
    // into a thin sliver against the edge, which then looks like a perfectly
    // valid detection to everything downstream. The stability gate sees a box
    // that agrees with itself frame after frame -- so it counts as STABLE, fires
    // the shutter, and keeps firing. That is the "got stuck like that" he saw.
    //
    // The server-side detector already refuses this exact case
    // (cardDetector.js: 'quad outside frame, deferring to classical'). The
    // preview inherited the geometry but not the guard, which is the same class
    // of mistake as inheriting the server's 0.25 confidence floor.
    //
    // Measured on his corpus: real detections cover 40-75% of the frame. A card
    // genuinely leaving the frame is transient -- refusing it costs one tick and
    // the next frame recovers. Accepting it costs a scan of the mat.
    const rawX0 = Math.min(...xs), rawX1 = Math.max(...xs);
    const rawY0 = Math.min(...ys), rawY1 = Math.max(...ys);
    const x0 = Math.max(0, rawX0), x1 = Math.min(w, rawX1);
    const y0 = Math.max(0, rawY0), y1 = Math.min(h, rawY1);
    if (x1 <= x0 || y1 <= y0) return null;

    // How much of the predicted box actually survived the clamp. A real card
    // near an edge keeps most of itself; a hallucinated box does not.
    const rawArea = Math.max(1, (rawX1 - rawX0) * (rawY1 - rawY0));
    if (((x1 - x0) * (y1 - y0)) / rawArea < VISIBLE_MIN) return null;

    // And a sliver is never a card, however confident the model is about it.
    const frac = ((x1 - x0) * (y1 - y0)) / (w * h);
    if (frac < AREA_MIN) return null;

    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, confidence: d.score };
  } catch (e) {
    console.warn('card detector: inference failed —', e.message);
    return null;
  } finally {
    busy = false;
  }
}
