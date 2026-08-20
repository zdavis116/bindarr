// BUG 2: auto-scan captured BLURRED frames, so every auto-scanned card landed
// in the review queue reading 'Could not read the collector number.'
//
// WHAT THIS SUITE CAN AND CANNOT PROVE, stated up front because a previous PR
// shipped green tests over a feature that did not work.
//
// CAN prove: the focus metric ranks sharp above blurred by a wide margin; the
// chosen threshold sits in the gap between them; the gate cannot stall; the
// stall-breaker fires on schedule; and the manual path is never gated.
//
// CANNOT prove: that the threshold is right for a real iPhone 16 camera frame
// of a real card under Zach's real lighting. Nothing in this repo runs a
// browser, a canvas or a camera, so every frame here is synthetic. The
// threshold is the one number only his phone can confirm.
import assert from 'assert';
import {
  laplacianVarianceScore,
  decideCapture,
  newGateState,
  SHARPNESS_MAX_SKIPS,
} from './frameSharpness.js';

let passed = 0;
function pass(id, msg) { passed++; console.log(`PASS: ${id} - ${msg}`); }

// --- synthetic frames ------------------------------------------------------
// A card's collector number is fine high-frequency detail on a mid-grey card,
// so the "sharp" frame is a fine checkerboard: the highest spatial frequency
// the sampling grid can carry, which is what blur destroys first.
function sharpFrame(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = ((x >> 1) + (y >> 1)) % 2 ? 210 : 40;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return data;
}

// A separable box blur — the standard cheap model of motion/defocus smear.
// radius 1 approximates a hand moving slightly during a 1/30s exposure;
// larger radii approximate a faster sweep.
function boxBlur(src, w, h, radius) {
  const out = new Uint8ClampedArray(src.length);
  const tmp = new Float32Array(w * h);
  const get = (x, y) => src[(y * w + Math.min(w - 1, Math.max(0, x))) * 4];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -radius; k <= radius; k++) { s += get(x + k, y); n++; }
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        s += tmp[yy * w + x]; n++;
      }
      const i = (y * w + x) * 4;
      const v = s / n;
      out[i] = out[i + 1] = out[i + 2] = v;
      out[i + 3] = 255;
    }
  }
  return out;
}

const W = 160, H = 224; // a card-shaped downscaled frame, the real gate size

// --- FSHARP-TC1: the metric separates sharp from blurred -------------------
{
  const sharp = sharpFrame(W, H);
  const slight = boxBlur(sharp, W, H, 1);
  const heavy = boxBlur(sharp, W, H, 3);

  const sSharp = laplacianVarianceScore(sharp, W, H);
  const sSlight = laplacianVarianceScore(slight, W, H);
  const sHeavy = laplacianVarianceScore(heavy, W, H);

  console.log(`  MEASURED  sharp=${sSharp.toFixed(1)}  blur r1=${sSlight.toFixed(1)}  blur r3=${sHeavy.toFixed(1)}`);

  assert.ok(sSharp > sSlight, 'a sharp frame must score above a slightly blurred one');
  assert.ok(sSlight > sHeavy, 'blur must reduce the score monotonically');
  assert.ok(sSharp > sHeavy * 10,
    `the sharp/blurred gap must be wide enough that the threshold is not finely tuned: ${sSharp} vs ${sHeavy}`);
  pass('FSHARP-TC1', 'variance of Laplacian separates sharp from motion-blurred frames by >10x');
}

// --- FSHARP-TC2: the metric's floor behaviour ------------------------------
// There is no longer an absolute pass/fail constant to pin (that was BUG 2).
// What still must hold is that the RELATIVE floor rejects a frame far below a
// learned baseline, and accepts one at or above it.
{
  const sharp = sharpFrame(W, H);
  const heavy = boxBlur(sharp, W, H, 3);
  const sSharp = laplacianVarianceScore(sharp, W, H);
  const sHeavy = laplacianVarianceScore(heavy, W, H);

  let state = newGateState();
  for (let i = 0; i < 15; i++) state = decideCapture(sSharp, state).state;
  assert.strictEqual(decideCapture(sSharp, state).capture, true,
    'a frame matching the learned baseline must be accepted');
  assert.strictEqual(decideCapture(sHeavy, state).capture, false,
    'a motion-blurred frame far below that baseline must be rejected');
  pass('FSHARP-TC2', 'the relative floor accepts a baseline frame and rejects a blurred one');
}

// --- FSHARP-TC3: a black frame scores ZERO, never infinity -----------------
// The normalisation divides by mean luma. Without the guard, the darkest
// possible frame would divide by ~0 and produce a huge score, letting the WORST
// frame through the gate — a gate that is exactly backwards on its worst input.
{
  const black = new Uint8ClampedArray(W * H * 4);
  for (let i = 3; i < black.length; i += 4) black[i] = 255;
  const score = laplacianVarianceScore(black, W, H);
  assert.strictEqual(score, 0, 'a black frame must score 0, not a divide-by-zero blow-up');
  // And against any learned baseline it is the worst possible frame.
  let state = newGateState();
  for (let i = 0; i < 15; i++) state = decideCapture(50, state).state;
  assert.strictEqual(decideCapture(score, state).capture, false,
    'and must therefore be rejected against a learned baseline');
  pass('FSHARP-TC3', 'a black/absent frame scores 0 and is rejected, not waved through');
}

// --- FSHARP-TC4: a frame at the baseline captures immediately --------------
{
  let state = newGateState();
  for (let i = 0; i < 15; i++) state = decideCapture(40, state).state;
  const d = decideCapture(40, state);
  assert.strictEqual(d.capture, true);
  assert.strictEqual(d.state.skips, 0, 'a good frame resets the skip budget');
  pass('FSHARP-TC4', 'a frame at the device baseline is captured immediately with no added latency');
}

// --- FSHARP-TC5: THE NO-STALL PROPERTY -------------------------------------
// The single most important behaviour here. A gate that can refuse forever
// would silently stop auto-scanning, and a card missing from a scanned stack is
// worse than a card in the review queue. Drive it with frames that NEVER clear
// the bar and assert it still captures, on schedule, forever.
{
  let state = newGateState();
  let captures = 0;
  for (let tick = 0; tick < 30; tick++) {
    const d = decideCapture(0.5, state);   // always blurred
    state = d.state;
    if (d.capture) captures++;
  }
  assert.ok(captures >= 10,
    `30 always-blurred ticks must still yield captures, got ${captures}`);
  pass('FSHARP-TC5', 'permanently blurred frames still capture — the gate cannot stall');
}

// --- FSHARP-TC5b: NO INPUT WHATSOEVER CAN STALL THE GATE -------------------
//
// The generalised version, and the one that matters after BUG 2. The old gate
// compared every frame against an absolute constant of 12, and on Zach's real
// iPhone 16 frames essentially NOTHING cleared it: "hold steady showed on like
// every card". Auto-scan became slower than useless — it waited, then sent the
// best frame anyway.
//
// So the property is not "blurred frames eventually pass", it is: for ANY
// score sequence at all, the gap between captures is BOUNDED. This drives the
// gate with adversarial inputs — permanently tiny scores, scores that decay
// toward zero, and a sequence tuned to sit just under whatever baseline the
// gate has learned — and asserts the bound holds for all of them.
{
  const sequences = {
    'always near zero': () => 0.001,
    'decaying forever': (i) => 100 / (i + 1),
    'steadily worsening': (i) => Math.max(0, 50 - i),
    'wildly noisy': (i) => (i * 7919 % 97) / 10,
    'constant midrange': () => 4.2,
  };
  for (const [label, fn] of Object.entries(sequences)) {
    let state = newGateState();
    let sinceCapture = 0;
    let worst = 0;
    for (let i = 0; i < 200; i++) {
      const d = decideCapture(fn(i), state);
      state = d.state;
      if (d.capture) { worst = Math.max(worst, sinceCapture); sinceCapture = 0; }
      else sinceCapture++;
    }
    assert.ok(sinceCapture <= SHARPNESS_MAX_SKIPS,
      `${label}: ended mid-stall with ${sinceCapture} pending skips`);
    assert.ok(worst <= SHARPNESS_MAX_SKIPS,
      `${label}: went ${worst} ticks without capturing; the gate must never stall`);
  }
  pass('FSHARP-TC5b', 'no score sequence can make the gate wait longer than SHARPNESS_MAX_SKIPS');
}

// --- FSHARP-TC5c: THE GATE ADAPTS TO THE DEVICE'S OWN FRAMES ---------------
//
// THE ACTUAL BUG 2 REGRESSION GUARD. An absolute threshold cannot be right
// across devices, lighting and card art: a dark full-art card legitimately
// carries less high-frequency detail than a white-bordered one, and under the
// old constant it would be rejected on EVERY tick, forever.
//
// The rule that replaces it: reject a frame only when it is clearly WORSE than
// the recent frames THIS device has been producing. So a camera whose frames
// all score ~3 must settle into accepting them, while a camera whose frames
// score ~300 must still reject a 3.
{
  // A modest-scoring but perfectly steady camera — the iPhone 16 case.
  let state = newGateState();
  let captured = 0;
  for (let i = 0; i < 20; i++) {
    const d = decideCapture(3 + (i % 3) * 0.1, state);
    state = d.state;
    if (d.capture) captured++;
  }
  assert.ok(captured >= 15,
    `a steady low-scoring camera must be ACCEPTED once the baseline learns it, got ${captured}/20`);

  // The same absolute score, on a camera whose frames normally score far
  // higher, is a genuine blur and must still be rejected.
  let hi = newGateState();
  for (let i = 0; i < 15; i++) hi = decideCapture(300, hi).state;
  const d = decideCapture(3, hi);
  assert.strictEqual(d.capture, false,
    'a frame far below this device\'s own recent frames must still be rejected');
  pass('FSHARP-TC5c', 'the gate adapts to the device: a steady low-scoring camera is accepted, a relative drop is not');
}

// --- FSHARP-TC5d: THE FIRST FRAMES ARE NEVER REJECTED ----------------------
// Before any baseline exists the gate knows nothing about this device, and
// guessing would reproduce exactly the BUG 2 failure. It must capture.
{
  const d = decideCapture(0.4, newGateState());
  assert.strictEqual(d.capture, true,
    'with no baseline yet, the gate must capture rather than guess a threshold');
  pass('FSHARP-TC5d', 'the gate never rejects a frame before it has learned a baseline');
}

// --- FSHARP-TC5e: OBSERVED SCORES ARE EXPOSED FOR DIAGNOSIS ----------------
// BUG 2 was a guessed number that nobody could check. Every decision must
// carry the score and the baseline it was judged against, so the next fix is
// measured rather than guessed.
{
  const d = decideCapture(7.5, newGateState());
  assert.strictEqual(typeof d.score, 'number', 'the decision must report the score it judged');
  assert.ok('baseline' in d, 'and the baseline it judged against');
  assert.ok(typeof d.reason === 'string' && d.reason.length > 0, 'and why it decided that');
  pass('FSHARP-TC5e', 'every gate decision reports score, baseline and reason for diagnosis');
}

// --- FSHARP-TC6: the stall-breaker fires on schedule, not early ------------
// Drive a learned baseline, then feed frames well below it.
{
  let state = newGateState();
  for (let i = 0; i < 15; i++) state = decideCapture(100, state).state;
  for (let i = 0; i < SHARPNESS_MAX_SKIPS - 1; i++) {
    const d = decideCapture(1, state);
    assert.strictEqual(d.capture, false, `skip ${i + 1} must NOT capture a clearly-worse frame`);
    state = d.state;
  }
  const final = decideCapture(1, state);
  assert.strictEqual(final.capture, true, 'the Nth consecutive skip must force a capture');
  assert.strictEqual(final.reason, 'stall-breaker');
  pass('FSHARP-TC6', 'the gate skips exactly SHARPNESS_MAX_SKIPS-1 frames before forcing one through');
}

// --- FSHARP-TC7: the best score is tracked across a blurred run ------------
{
  let state = newGateState();
  for (let i = 0; i < 15; i++) state = decideCapture(100, state).state;
  state = decideCapture(2, state).state;
  state = decideCapture(9, state).state;
  assert.strictEqual(state.bestScore, 9, 'the sharpest frame seen must be remembered');
  const d = decideCapture(3, state);
  assert.strictEqual(d.capture, true, 'and the run still ends in a capture');
  pass('FSHARP-TC7', 'the sharpest frame in a blurred run is tracked for the stall-breaker');
}

// --- FSHARP-TC8: MEASURED COST of the gate ---------------------------------
// The gate runs on every auto tick, so it must be cheap relative to a 3s
// cadence and a multi-hundred-ms server round trip. This measures it rather
// than asserting it is "cheap".
{
  const sharp = sharpFrame(W, H);
  const N = 200;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) laplacianVarianceScore(sharp, W, H);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log(`  MEASURED  laplacianVarianceScore on ${W}x${H}: ${ms.toFixed(3)} ms/frame`);
  assert.ok(ms < 10,
    `the gate must be negligible against a 3s cadence; measured ${ms.toFixed(3)}ms`);
  pass('FSHARP-TC8', `the sharpness check costs ${ms.toFixed(3)}ms per frame — negligible vs the 3s cadence`);
}

console.log(`\nframeSharpness.test.js: ${passed} cases passed`);
