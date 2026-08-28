// THE ARTWORK FINGERPRINT MUST BE FED DETECTION-SPACE COORDINATES.
//
// This is a regression test for a bug that shipped, was announced as fixed, and
// was completely inert in production -- Zach tested it and reported "still
// having to tap because steady frame is hanging around."
//
// WHAT HAPPENED. The preview loop computes two boxes per frame:
//
//   det     the detector's output, in the DWxDH (160px-wide) DETECTION buffer
//   mapped  det scaled and offset to the PREVIEW ELEMENT's CSS box, for drawing
//           the outline the user sees
//
// artFingerprint samples the DETECTION buffer, so it needs `det`. The caller
// passed `mapped`. On a phone the preview element is ~390 CSS px against
// DW=160, so every sample landed far outside the buffer, the bounds check
// returned null on every single frame, and the caller's catch-and-continue
// swallowed it as "enhancement unavailable".
//
// WHY NO TEST CAUGHT IT. cardChangeDetect.test.js tests artFingerprint with
// correct inputs and passes -- the UNIT was always right. The defect was
// entirely in which coordinate space the CALLER handed it. So the test has to
// assert the property that actually failed: a box scaled to preview space must
// NOT produce a fingerprint, and the detection-space box must.
//
// That asymmetry is the whole point. If someone "simplifies" the caller back to
// `mapped`, TC2 fails.
import assert from 'node:assert';
import { artFingerprint, fingerprintDistance, isDifferentCard } from '../utils/cardChangeDetect.js';

let passed = 0;
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// The real detection buffer geometry from CameraScanner: DW is fixed at 160 and
// DH follows the video aspect.
const DW = 160;
const DH = 284;

// A frame with a distinguishable card region, so a real fingerprint is possible.
function frame(seed) {
  const data = new Uint8ClampedArray(DW * DH * 4);
  for (let i = 0; i < DW * DH; i++) {
    const v = (i * seed) % 251;
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  return data;
}

const det = { x: 20, y: 30, w: 100, h: 180 };

// Reproduce the caller's mapping exactly: object-fit: cover onto a ~390px-wide
// preview element.
const previewWidth = 390;
const scale = previewWidth / DW;
const mapped = { x: det.x * scale, y: det.y * scale, w: det.w * scale, h: det.h * scale };

// TC1: detection-space coordinates produce a usable fingerprint.
{
  const fp = artFingerprint(frame(7), DW, DH, det);
  assert.ok(fp, 'detection-space box must produce a fingerprint');
  assert.strictEqual(fp.length, 64, 'fingerprint is an 8x8 grid');
  pass('AFS-TC1', 'detection-space box produces a fingerprint');
}

// TC2: preview-space coordinates produce NOTHING. This is the shipped bug.
{
  const fp = artFingerprint(frame(7), DW, DH, mapped);
  assert.strictEqual(
    fp, null,
    'preview-space box samples outside the detection buffer and must return null -- '
    + 'if this ever returns a fingerprint the bug becomes silent again',
  );
  pass('AFS-TC2', 'preview-space box yields no fingerprint (the shipped defect)');
}

// TC3: THE CONSEQUENCE, stated in Zach's terms. With detection-space input, a
// different card in the SAME position re-arms capture. With preview-space input
// it never can, which is precisely "I have to tap every card".
{
  const a = artFingerprint(frame(7), DW, DH, det);
  const b = artFingerprint(frame(53), DW, DH, det);
  assert.ok(isDifferentCard(b, a), 'a different card in the same box must re-arm capture');

  const badA = artFingerprint(frame(7), DW, DH, mapped);
  const badB = artFingerprint(frame(53), DW, DH, mapped);
  assert.strictEqual(
    isDifferentCard(badB, badA), false,
    'with preview-space input the feature is inert -- it can never report a new card',
  );
  pass('AFS-TC3', 'detection space re-arms on a new card; preview space is inert');
}

// TC4: the same card sitting still must NOT re-arm. The dangerous direction:
// a false "different" scans one piece of cardboard twice.
{
  const a = artFingerprint(frame(7), DW, DH, det);
  const b = artFingerprint(frame(7), DW, DH, det);
  assert.strictEqual(fingerprintDistance(a, b), 0, 'identical frames are identical');
  assert.strictEqual(isDifferentCard(b, a), false, 'a still card must not re-arm capture');
  pass('AFS-TC4', 'a card sitting still does not re-arm capture');
}

console.log(`\nart-fingerprint-space.test.js: ${passed} cases passed`);
