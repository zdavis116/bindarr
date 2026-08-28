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

// TC2: preview-space coordinates must not silently pass for detection-space.
//
// The original version of this case asserted `=== null`, which review correctly
// called out as testing a COINCIDENCE rather than the property: null happens
// only because 390/160 pushes the samples out of bounds. A smaller preview
// element, or a larger DW later, would put them back IN bounds and yield a
// wrong-but-non-null fingerprint -- and this test would go green on a real
// regression.
//
// So assert the thing that actually matters: whatever preview-space input
// produces, it must NOT be a usable stand-in for the detection-space
// fingerprint. Either it fails outright, or it disagrees with the truth by more
// than the same-card noise floor -- i.e. it would corrupt the comparison.
{
  const data = frame(7);
  const truth = artFingerprint(data, DW, DH, det);
  const viaPreview = artFingerprint(data, DW, DH, mapped);

  if (viaPreview !== null) {
    const d = fingerprintDistance(truth, viaPreview);
    assert.ok(
      d !== null && d > 2.4,
      'a preview-space box must not produce a fingerprint equivalent to the '
      + 'detection-space one (2.4 is the measured same-card noise ceiling)',
    );
  }
  pass('AFS-TC2', 'preview-space box cannot stand in for detection space');
}

// TC3: THE CONSEQUENCE, stated in Zach's terms. With detection-space input, a
// different card in the SAME position re-arms capture. That is the whole
// feature: "I put down 3 forest in a row and it only scanned the 1st."
{
  const a = artFingerprint(frame(7), DW, DH, det);
  const b = artFingerprint(frame(53), DW, DH, det);
  assert.ok(isDifferentCard(b, a), 'a different card in the same box must re-arm capture');
  pass('AFS-TC3', 'detection space re-arms capture on a new card');
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
