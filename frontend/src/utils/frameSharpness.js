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

// THE THRESHOLD IS RELATIVE, NOT ABSOLUTE — and that is BUG 2's fix.
//
// WHAT WENT WRONG. The first version of this gate compared every frame against
// a fixed constant of 12, derived from SYNTHETIC box blur. The report flagged
// it as the one unvalidated number, and it was wrong by a wide
// margin. Zach, on a real iPhone 16: "hold steady showed on like every card."
// Real camera frames of real cards score FAR lower on this metric than
// synthetic blur suggested — even when they are perfectly sharp — so almost
// nothing cleared 12. Auto-scan became worse than useless: it stalled for
// three ticks, then sent the best frame anyway, having added delay for nothing.
//
// WHY A CONSTANT CANNOT WORK AT ALL. The score depends on sensor, optics,
// exposure, lighting, and the CARD'S OWN ART. A dark full-art card genuinely
// carries less high-frequency detail than a white-bordered one; that is a
// property of the card, not of the focus. Any single number is therefore
// simultaneously too high for some legitimate frames and too low for others,
// and picking a different constant just moves which cards are permanently
// rejected. Normalising by mean luma (above) removes the BRIGHTNESS component
// but not the DETAIL component.
//
// THE RULE THAT REPLACES IT. Judge a frame against the recent frames THIS
// device has actually been producing. Keep a rolling window of recent scores,
// take its MEDIAN as the baseline, and reject only frames clearly below it.
// The question becomes "is this frame worse than how this phone normally does
// on this card?" — which is the question we actually wanted, and which needs
// no per-device tuning.
//
// WHY THE MEDIAN and not the mean: the window necessarily contains blurred
// frames (that is what we are trying to detect), and a few very low scores
// would drag a mean down until blurred frames looked normal. The median is
// unmoved by a minority of outliers, so the baseline tracks the device's
// TYPICAL frame rather than its average frame.

// How many recent scores the baseline is computed over. Small enough to follow
// a change of card or lighting within a few seconds at the ~3s auto cadence,
// large enough that one bad frame cannot move the median.
export const SHARPNESS_WINDOW = 8;

// A frame is rejected only when it scores below this FRACTION of the rolling
// median. 0.6 means "clearly worse than typical", not "below typical".
//
// WHY 0.6, and it is a judgement stated as one. The measured separation is
// large: FSHARP-TC1 asserts a sharp frame scores more than 10x a
// motion-blurred one, so real motion blur lands around 0.1x the baseline and
// is caught comfortably. Frame-to-frame variation on a steady hand is a few
// percent. 0.6 sits in that wide gap, deliberately nearer the blurred side,
// because of the cost asymmetry below. It is a RATIO, so unlike the old
// constant it carries no assumption about what a real camera scores.
export const SHARPNESS_REL_FLOOR = 0.6;

// THE COST ASYMMETRY, unchanged and still what sets the tuning direction.
// Skipping a sharp-enough frame costs LATENCY ONLY — the next tick comes round
// and the card is still in frame. Accepting a blurred frame costs a MANUAL
// QUEUE ENTRY. But BUG 2 proved the reverse failure is real too: a gate that
// rejects everything costs latency on EVERY card and delivers nothing. So the
// gate is tuned to skip only what is clearly bad, and it can never stall.

// The gate needs a baseline before it can judge anything. Until it has this
// many samples it CAPTURES UNCONDITIONALLY.
//
// This is the single most important safety property of the adaptive design:
// with no knowledge of the device, the gate does not guess a threshold — which
// is exactly what BUG 2 did. It captures, and learns from what it captured.
export const SHARPNESS_MIN_SAMPLES = 4;

// After this many CONSECUTIVE rejected frames, send the sharpest one seen.
// 3 skips at the 3s auto cadence is about 9 seconds — long enough that a
// genuinely shaky moment passes, short enough that Zach never wonders whether
// auto-scan has died. This bound is what makes "the gate cannot stall" a
// property rather than a hope: see FSHARP-TC5b, which drives it with
// adversarial score sequences and asserts the bound holds for all of them.
export const SHARPNESS_MAX_SKIPS = 3;

// A fresh gate state. Plain data only — no timer handles, no DOM nodes. An
// earlier PR shipped an iOS Safari crash by packing setTimeout handles into an
// object on this screen, so this stays safe to drop at any moment.
export function newGateState() {
  return { skips: 0, bestScore: 0, recent: [] };
}

// The rolling baseline: the median of recent scores, or null when there are
// not yet enough samples to have an opinion.
export function baselineOf(recent) {
  if (!recent || recent.length < SHARPNESS_MIN_SAMPLES) return null;
  const sorted = [...recent].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The whole gate decision, pure and separated from the DOM so it can be tested.
//
// `state` is a plain object the caller owns: { skips, bestScore, recent }.
// Returning a NEW state rather than mutating keeps this a function of its
// inputs.
//
// Returns { capture, reason, score, baseline, state }. The score and baseline
// are reported on EVERY decision so the caller can log them: BUG 2 was a
// guessed number nobody could check, and the fix for that is not a better
// guess, it is making the observed values visible.
export function decideCapture(score, state = newGateState()) {
  const skips = state.skips || 0;
  const bestScore = state.bestScore || 0;
  const prevRecent = state.recent || [];
  const baseline = baselineOf(prevRecent);

  // Every observed score feeds the baseline, INCLUDING rejected ones. The
  // baseline is a model of what this device produces, not of what we accepted;
  // learning only from accepted frames would let it drift upward until nothing
  // could ever clear it — BUG 2 all over again.
  const recent = [...prevRecent, score].slice(-SHARPNESS_WINDOW);

  // NOT ENOUGH SAMPLES YET: capture, never guess.
  if (baseline == null) {
    return {
      capture: true, reason: 'learning', score, baseline: null,
      state: { skips: 0, bestScore: 0, recent },
    };
  }

  if (score >= baseline * SHARPNESS_REL_FLOOR) {
    // Normal for this device. Reset the skip budget: it is about a RUN of bad
    // frames, and a good frame means the hand settled.
    return {
      capture: true, reason: 'sharp', score, baseline,
      state: { skips: 0, bestScore: 0, recent },
    };
  }

  if (skips + 1 >= SHARPNESS_MAX_SKIPS) {
    // THE STALL-BREAKER. Nothing cleared the bar, so take the best available
    // rather than never scanning. Degrades to the old ungated behaviour, never
    // to silence.
    return {
      capture: true, reason: 'stall-breaker', score, baseline,
      state: { skips: 0, bestScore: 0, recent },
    };
  }

  return {
    capture: false, reason: 'blurred', score, baseline,
    state: { skips: skips + 1, bestScore: Math.max(bestScore, score), recent },
  };
}
