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
  SHARPNESS_MIN_SCORE,
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

// --- FSHARP-TC2: the chosen threshold sits IN that gap ---------------------
// The threshold is only meaningful if it accepts the sharp frame and rejects
// the blurred one. Asserting both sides pins it against the measurement rather
// than leaving it an unexamined constant.
{
  const sharp = sharpFrame(W, H);
  const heavy = boxBlur(sharp, W, H, 3);
  assert.ok(laplacianVarianceScore(sharp, W, H) > SHARPNESS_MIN_SCORE,
    'the threshold must ACCEPT a sharp frame');
  assert.ok(laplacianVarianceScore(heavy, W, H) < SHARPNESS_MIN_SCORE,
    'the threshold must REJECT a motion-blurred frame');
  pass('FSHARP-TC2', 'SHARPNESS_MIN_SCORE lies between the measured sharp and blurred scores');
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
  assert.ok(score < SHARPNESS_MIN_SCORE, 'and must therefore be rejected');
  pass('FSHARP-TC3', 'a black/absent frame scores 0 and is rejected, not waved through');
}

// --- FSHARP-TC4: a sharp frame captures immediately ------------------------
{
  const d = decideCapture(SHARPNESS_MIN_SCORE + 1, { skips: 0, bestScore: 0 });
  assert.strictEqual(d.capture, true);
  assert.strictEqual(d.reason, 'sharp');
  assert.strictEqual(d.state.skips, 0, 'a good frame resets the skip budget');
  pass('FSHARP-TC4', 'a sharp frame is captured immediately with no added latency');
}

// --- FSHARP-TC5: THE NO-STALL PROPERTY -------------------------------------
// The single most important behaviour here. A gate that can refuse forever
// would silently stop auto-scanning, and a card missing from a scanned stack is
// worse than a card in the review queue. Drive it with frames that NEVER clear
// the bar and assert it still captures, on schedule, forever.
{
  let state = { skips: 0, bestScore: 0 };
  let captures = 0;
  for (let tick = 0; tick < 30; tick++) {
    const d = decideCapture(0.5, state);   // always blurred
    state = d.state;
    if (d.capture) {
      captures++;
      assert.strictEqual(d.reason, 'stall-breaker');
    }
  }
  assert.strictEqual(captures, 10,
    `30 blurred ticks at ${SHARPNESS_MAX_SKIPS} skips must still yield 10 captures, got ${captures}`);
  pass('FSHARP-TC5', 'permanently blurred frames still capture via the stall-breaker — the gate cannot stall');
}

// --- FSHARP-TC6: the stall-breaker fires on schedule, not early ------------
{
  let state = { skips: 0, bestScore: 0 };
  for (let i = 0; i < SHARPNESS_MAX_SKIPS - 1; i++) {
    const d = decideCapture(1, state);
    assert.strictEqual(d.capture, false, `skip ${i + 1} must NOT capture a blurred frame`);
    state = d.state;
  }
  const final = decideCapture(1, state);
  assert.strictEqual(final.capture, true, 'the Nth consecutive skip must force a capture');
  assert.strictEqual(final.reason, 'stall-breaker');
  pass('FSHARP-TC6', 'the gate skips exactly SHARPNESS_MAX_SKIPS-1 frames before forcing one through');
}

// --- FSHARP-TC7: the best score is tracked across a blurred run ------------
{
  let state = { skips: 0, bestScore: 0 };
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
