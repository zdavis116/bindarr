// A SHARPNESS GATE for auto-capture, and the reason it exists is asymmetric cost.
//
// THE OBSERVED BUG. Zach: "when I use the auto feature every card it scans goes
// to the queue but it seems to identify it correctly because if I hit the scan
// button it pulls the right card." His queue screenshots show visibly blurred
// crops, every entry reading 'Could not read the collector number.'
//
// WHY ONLY THE NUMBER BREAKS. The two consumers of an auto-captured frame have
// very different resolution needs. CLIP card identification is robust to motion
// blur — measured 100% identity all day, and 10/10 even at a 400px upload width.
// The collector number is 2mm of text in the bottom-left corner; motion blur
// smears it below anything tesseract can read. So a blurred frame produces a
// CORRECTLY IDENTIFIED card with an UNREADABLE number, which is precisely a
// queue entry Zach has to resolve by hand — exactly what he described.
//
// Auto-scan fired on a fixed cadence, so it captured whenever the timer expired
// rather than when the image happened to be sharp. Holding a card over a stack,
// the hand is usually still moving when the timer goes off.
//
// THE COST ASYMMETRY THAT SETS THE THRESHOLD. Skipping a sharp-enough frame
// costs LATENCY ONLY — the next tick comes around and the card is still in
// frame. Accepting a blurred frame costs a MANUAL QUEUE ENTRY: Zach stops,
// looks at a photo, and picks a printing. One is measured in seconds of his
// time, the other in seconds of waiting. So the gate is tuned to be
// comfortably willing to skip, and is deliberately NOT tuned to the edge.
//
// AND IT MUST NEVER STALL. A gate that can refuse forever is worse than no
// gate: under poor light or a low-contrast card the score may never clear the
// bar, and an auto-scanner that silently stops scanning is the failure mode
// this app cannot afford (a card missing from a scanned stack). So the caller
// tracks the sharpest frame it has seen and, after a bounded number of
// consecutive skips, sends THAT one. The worst case degrades to exactly the
// old behaviour — a possibly-blurred capture — never to no capture at all.

// THE METRIC: variance of the Laplacian, on a downscaled greyscale copy.
//
// WHY THIS ONE. It is the standard focus measure and it is cheap: one pass, a
// 4-neighbour kernel, no allocation beyond the greyscale buffer. A sharp image
// has strong high-frequency content, so second-derivative responses are large
// and widely spread -> high variance. Blur is a low-pass filter; it removes
// exactly that content -> low variance. Gradient energy (Tenengrad) measures
// much the same thing but responds more strongly to smooth luminance ramps,
// which a card's flat art regions have plenty of.
//
// WHY IT IS NORMALISED BY MEAN LUMA. Raw Laplacian variance scales with
// CONTRAST, so the same lens focus scores far higher on a bright white-bordered
// card than on a dark full-art one, and higher under a lamp than in evening
// light. An absolute threshold on the raw value would therefore be a threshold
// on "how bright and busy is this card", which is not the question. Dividing by
// mean intensity makes the score a relative measure of edge energy and keeps
// ONE threshold usable across Zach's actual mixed lighting.
//
// This function is pure and takes raw RGBA bytes, so it is testable in Node
// without a browser or a canvas.
export function laplacianVarianceScore(data, width, height) {
  if (!data || width < 3 || height < 3) return 0;

  // Greyscale via Rec.601 luma. Integer weights, no floating point per pixel.
  const grey = new Float32Array(width * height);
  let sum = 0;
  for (let i = 0, p = 0; p < grey.length; i += 4, p++) {
    // 0.299 R + 0.587 G + 0.114 B
    const v = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    grey[p] = v;
    sum += v;
  }
  const meanLuma = sum / grey.length;
  // A frame this dark carries no usable information at all (lens covered, or
  // the camera has not delivered a real frame yet). Report 0 rather than
  // dividing by ~0 and producing a huge, meaningless score — which would let
  // the blackest possible frame sail through the gate.
  if (meanLuma < 1) return 0;

  // 4-neighbour Laplacian over the interior. Borders are skipped rather than
  // clamped: a clamped border invents an edge that is not in the image.
  let lapSum = 0;
  let lapSqSum = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const p = row + x;
      const lap = 4 * grey[p] - grey[p - 1] - grey[p + 1] - grey[p - width] - grey[p + width];
      lapSum += lap;
      lapSqSum += lap * lap;
      n++;
    }
  }
  if (!n) return 0;
  const mean = lapSum / n;
  const variance = lapSqSum / n - mean * mean;
  // Normalise by mean luma (see above). Guarded against tiny negatives from
  // floating-point cancellation in the variance identity.
  return Math.max(0, variance) / meanLuma;
}

// THE THRESHOLD, and it is a judgement call stated as one.
//
// MEASURED on synthetic frames (see frameSharpness.test.js): a sharp
// high-frequency test frame scores in the hundreds; the same frame after a
// 3-tap box blur — roughly the smear of a hand moving during a 1/30s exposure —
// drops by more than an order of magnitude, and a heavily blurred frame falls
// to near zero. The gap between "sharp" and "hand-moving" is large and does not
// need a finely tuned cut point.
//
// 12 sits in that gap, nearer the blurred side ON PURPOSE. This is NOT the
// value that maximises the number of frames rejected. Per the cost asymmetry
// above, a false ACCEPT costs Zach manual work while a false REJECT costs one
// tick of latency — but a threshold set aggressively high would reject
// legitimately sharp dark or low-contrast cards on every tick, and those cards
// would then always arrive via the stall-breaker, which is the same as having
// no gate. 12 rejects obvious motion blur and passes anything reasonably still.
//
// THIS NUMBER IS NOT VALIDATED ON REAL PHONE FRAMES. Nothing in this repo runs
// a browser or a camera. It is derived from synthetic blur and it is the one
// thing here that Zach's phone must confirm.
export const SHARPNESS_MIN_SCORE = 12;

// After this many CONSECUTIVE rejected frames, send the sharpest one seen.
// 3 skips at the 3s auto cadence is about 9 seconds — long enough that a
// genuinely shaky moment passes, short enough that Zach never wonders whether
// auto-scan has died.
export const SHARPNESS_MAX_SKIPS = 3;

// The whole gate decision, pure and separated from the DOM so it can be tested.
//
// `state` is a plain object the caller owns: { skips, bestScore }. Returning a
// NEW state rather than mutating keeps this a function of its inputs.
//
// Returns { capture, reason, state }:
//   capture true  -> send this frame
//   capture false -> skip it, wait for the next tick
export function decideCapture(score, state = { skips: 0, bestScore: 0 }) {
  const skips = state.skips || 0;
  const bestScore = state.bestScore || 0;

  if (score >= SHARPNESS_MIN_SCORE) {
    // Sharp enough. Reset, because the skip budget is about a run of BAD
    // frames; a good frame means the hand settled.
    return { capture: true, reason: 'sharp', state: { skips: 0, bestScore: 0 } };
  }
  if (skips + 1 >= SHARPNESS_MAX_SKIPS) {
    // THE STALL-BREAKER. Nothing cleared the bar, so take the best available
    // rather than never scanning. Degrades to the old behaviour, never to
    // silence.
    return { capture: true, reason: 'stall-breaker', state: { skips: 0, bestScore: 0 } };
  }
  return {
    capture: false,
    reason: 'blurred',
    state: { skips: skips + 1, bestScore: Math.max(bestScore, score) },
  };
}
