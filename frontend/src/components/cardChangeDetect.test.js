// A NEW CARD IN THE SAME POSITION MUST STILL SCAN.
//
// Zach: "I put down 3 forest in a row and it only scanned the 1st because it
// thought the next 2 were the same card... Every time a new card gets put down
// it should scan but if there is a card just sitting in the tray it shouldn't
// continuously scan that card."
//
// Both halves of that sentence are requirements, and they pull against each
// other. These cases pin both, because a fix for one that breaks the other is
// worse than the bug: a missed card costs a tap, a repeated card puts a wrong
// count against physical cardboard.
import assert from 'node:assert';
import {
  artFingerprint, fingerprintDistance, isDifferentCard, CHANGE_THRESHOLD, GRID,
} from '../utils/cardChangeDetect.js';

let passed = 0;
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// Build a fake RGBA frame with a card-shaped region of a given brightness
// pattern, so fingerprints are predictable.
function frame(w, h, paint) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = paint(x, y);
      const i = (y * w + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return data;
}

const W = 400, H = 560;
const BOX = { x: 40, y: 40, w: 320, h: 448 };

// --- FCHG-TC1: the same card, frame to frame, is NOT a new card -------------
//
// The costly direction. If this fails, a card lying still rescans forever.
{
  const a = artFingerprint(frame(W, H, (x, y) => (x * 7 + y * 3) % 256), W, H, BOX);
  // A second frame of the SAME card: sensor noise only.
  const b = artFingerprint(
    frame(W, H, (x, y) => Math.min(255, ((x * 7 + y * 3) % 256) + ((x + y) % 3) - 1)),
    W, H, BOX);
  const d = fingerprintDistance(a, b);
  assert.ok(d < CHANGE_THRESHOLD,
    `the same card between frames scored ${d.toFixed(2)}, at or above the `
    + `${CHANGE_THRESHOLD} threshold — it would rescan itself forever`);
  assert.strictEqual(isDifferentCard(b, a), false);
  pass('FCHG-TC1', 'a card sitting still is not mistaken for a new one');
}

// --- FCHG-TC2: a different card in the SAME position IS a new card ----------
//
// This is the Forest-on-Forest case. The box is identical; only the art differs.
{
  const forest1 = artFingerprint(frame(W, H, (x, y) => (x * 7 + y * 3) % 256), W, H, BOX);
  const forest2 = artFingerprint(frame(W, H, (x, y) => (x * 3 + y * 11) % 256), W, H, BOX);
  const d = fingerprintDistance(forest1, forest2);
  assert.ok(d >= CHANGE_THRESHOLD,
    `two different cards scored ${d.toFixed(2)}, below the ${CHANGE_THRESHOLD} `
    + 'threshold — the second card would never scan');
  assert.strictEqual(isDifferentCard(forest2, forest1), true);
  pass('FCHG-TC2', 'a different card in the same position is detected as new');
}

// --- FCHG-TC3: unknown means "same", never "new" ----------------------------
//
// Every uncertain case must fall to the side that costs a tap, not the side
// that adds a duplicate to a collection of physical objects.
{
  const fp = artFingerprint(frame(W, H, () => 128), W, H, BOX);
  assert.strictEqual(isDifferentCard(fp, null), false,
    'with no reference yet, nothing may be declared a NEW card');
  assert.strictEqual(isDifferentCard(null, fp), false,
    'with no current fingerprint, nothing may be declared a NEW card');
  assert.strictEqual(fingerprintDistance(fp, new Float32Array(3)), null,
    'mismatched fingerprints are incomparable, not "different"');
  pass('FCHG-TC3', 'an unknown comparison reports "same card", never "new"');
}

// --- FCHG-TC4: a box outside the frame yields no fingerprint ----------------
//
// The off-frame detector guard already rejects these, but a fingerprint read
// from out-of-bounds memory would silently be garbage and could read as a new
// card on every frame.
{
  assert.strictEqual(artFingerprint(frame(W, H, () => 100), W, H,
    { x: -200, y: -200, w: 320, h: 448 }), null);
  assert.strictEqual(artFingerprint(frame(W, H, () => 100), W, H,
    { x: 0, y: 0, w: GRID - 1, h: GRID - 1 }), null,
    'a box too small to sample must report null rather than a degenerate print');
  pass('FCHG-TC4', 'an out-of-frame or tiny box produces no fingerprint');
}

console.log(`\ncard-change-detect.test.js: ${passed} cases passed`);
