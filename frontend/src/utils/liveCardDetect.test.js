// Live card detection, tested against synthetic frames — including the case
// that broke production: a card inside a white box.
//
// These are PURE-FUNCTION tests over pixel arrays. That is deliberate: the
// thing being asserted is the DISCRIMINATION (card vs container), which is
// arithmetic and can be pinned exactly. A test that fed it a real photo would
// prove less and fail for unrelated reasons.
import assert from 'node:assert/strict';
import { detectCardInFrame, isLocked, LOCK_CONFIDENCE, CARD_ASPECT } from './liveCardDetect.js';

let passed = 0;
function test(id, name, fn) {
  try { fn(); passed++; console.log(`PASS: ${id} ${name}`); }
  catch (e) { console.error(`FAIL: ${id} ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// Build a greyscale frame. `rects` are drawn in order, later ones on top.
// `noise` adds interior texture, which is how a printed card differs from a
// blank surface.
function frame(w, h, bg, rects) {
  const g = new Uint8ClampedArray(w * h).fill(bg);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        let v = r.fill;
        if (r.noise) {
          // Deterministic pseudo-texture: no RNG, so the test cannot flake.
          v = r.fill + (((x * 7 + y * 13) % 11) - 5) * r.noise;
        }
        g[y * w + x] = Math.max(0, Math.min(255, v));
      }
    }
  }
  return g;
}

const W = 200, H = 280;
const cardW = 96, cardH = Math.round(96 / CARD_ASPECT); // ~134

test('LCD-TC1', 'finds a card on a plain surface', () => {
  const g = frame(W, H, 210, [
    { x: 52, y: 73, w: cardW, h: cardH, fill: 90, noise: 4 },
  ]);
  const d = detectCardInFrame(g, W, H);
  assert.ok(d, 'a card on a contrasting surface must be detected');
  assert.ok(Math.abs(d.w - cardW) <= 6, `width ${d.w} should be ~${cardW}`);
  assert.ok(Math.abs(d.h - cardH) <= 6, `height ${d.h} should be ~${cardH}`);
  assert.ok(isLocked(d), `confidence ${d.confidence.toFixed(2)} should reach lock`);
});

test('LCD-TC2', 'THE PRODUCTION BUG: locks the card, not the white box around it', () => {
  // Zach scans in a small white box. His failed lands stored matched_name = ''
  // — the card was never identified — and the crop showed a sharp card filling
  // only ~28% of the frame, surrounded by the box's walls and corners.
  //
  // The box interior is BIGGER, equally rectangular and equally centred, so any
  // "largest centred rectangle" rule picks the box. Shape + interior detail is
  // what rejects it: a box floor is flat and is not 63x88.
  const g = frame(W, H, 235, [
    // Box interior: large, centred, rectangular, FLAT, and not card-shaped.
    { x: 20, y: 24, w: 160, h: 232, fill: 200, noise: 0 },
    // The card, smaller, off-centre, busy.
    { x: 60, y: 90, w: cardW, h: cardH, fill: 85, noise: 5 },
  ]);
  const d = detectCardInFrame(g, W, H);
  assert.ok(d, 'the card must still be found when it sits inside a container');
  // The decisive assertion: the detection must be the CARD's size, not the box's.
  assert.ok(Math.abs(d.w - cardW) <= 10,
    `locked width ${d.w} must be the card (~${cardW}), not the box (160)`);
  assert.ok(d.h < 200, `locked height ${d.h} must not be the box interior (232)`);
});

test('LCD-TC3', 'returns null on an empty frame instead of inventing a card', () => {
  // A confident-but-wrong lock is the dangerous failure: the outline turning
  // green is a promise that the app has the card. No card must mean no lock.
  assert.equal(detectCardInFrame(frame(W, H, 180, []), W, H), null);
});

test('LCD-TC4', 'rejects a rectangle that is not card-shaped', () => {
  // A square-ish object (a deck box, a phone, a coaster) must not read as a card.
  const g = frame(W, H, 220, [{ x: 50, y: 90, w: 110, h: 115, fill: 80, noise: 4 }]);
  const d = detectCardInFrame(g, W, H);
  assert.equal(d, null, 'a square object must not be reported as a card');
});

test('LCD-TC5', 'a flat rectangle of the right shape still fails on detail', () => {
  // Card-shaped but blank — a white card sleeve, a piece of paper. Shape alone
  // is not enough; scanning it would produce a match against nothing.
  const g = frame(W, H, 235, [
    { x: 52, y: 73, w: cardW, h: cardH, fill: 120, noise: 0 },
  ]);
  const d = detectCardInFrame(g, W, H);
  if (d) {
    assert.ok(!isLocked(d),
      `a featureless card-shaped rectangle must not LOCK (got ${d.confidence.toFixed(2)})`);
  }
});

test('LCD-TC6', 'the lock threshold is a named, sane constant', () => {
  // The outline turning green is a promise to the user. The number backing that
  // promise must be visible and deliberate, not a literal buried at a call site.
  assert.ok(LOCK_CONFIDENCE > 0.4 && LOCK_CONFIDENCE < 0.9,
    `LOCK_CONFIDENCE ${LOCK_CONFIDENCE} should be a meaningful middle threshold`);
  assert.equal(isLocked(null), false, 'no detection can never be locked');
});

test('LCD-TC7', 'never throws on malformed input', () => {
  // This runs on every preview frame. A throw here would kill the camera loop.
  assert.equal(detectCardInFrame(null, W, H), null);
  assert.equal(detectCardInFrame(new Uint8ClampedArray(4), 2, 2), null);
});

console.log(`liveCardDetect: ${passed} cases passed`);
if (process.exitCode) process.exit(process.exitCode);
