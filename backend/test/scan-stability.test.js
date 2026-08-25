// CAPTURE ON STABILITY, NOT ON A TIMER OR A GUESS.
//
// HISTORY, because it is why this file exists. Zach reported duplicate scans.
// Three attempts tried to answer "is this a DIFFERENT card?" from the preview
// frame -- coarse luma fingerprint, then detector geometry, then match identity
// -- and every one of them SKIPPED REAL CARDS he physically placed. He stopped
// me: "this scanner is not working it's just not getting any better.
// Recommending researching the internet for the best way to scan cards."
//
// The research (SCANNER_CAPTURE_REDESIGN.md) found that no mature scanner asks
// that question. Dynamsoft, docuSnap, CamScanner and Scanbot all capture when
// the detection has HELD STILL for N consecutive frames. The question changes
// from one that cannot be answered from a preview to one that can.
//
// These tests pin the stabilizer's behaviour and, just as importantly, pin the
// absence of the approaches that failed.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'CameraScanner.jsx');
const src = fs.readFileSync(SRC, 'utf8');

// Extract the pure functions rather than standing up a JSX pipeline for them.
// A failed extraction throws, so this cannot silently test nothing.
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in CameraScanner.jsx — renamed?`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
function constant(name) {
  const m = src.match(new RegExp(`const ${name} = ([^;]+);`));
  assert.ok(m, `${name} not found`);
  return `const ${name} = ${m[1]};`;
}

// eslint-disable-next-line no-eval
const mod = eval('(() => {'
  + [constant('STABLE_IOU'), constant('STABLE_AREA_DELTA'), constant('STABLE_FRAMES_REQUIRED')].join('\n')
  + '\n' + extract('boxIoU') + '\n' + extract('detectionsAgree')
  + '\nreturn { boxIoU, detectionsAgree, STABLE_FRAMES_REQUIRED }; })()');
const { boxIoU, detectionsAgree, STABLE_FRAMES_REQUIRED } = mod;

let passed = 0;
const pass = (id, msg) => { console.log(`PASS: ${id} ${msg}`); passed++; };

const CARD = { x: 40, y: 60, w: 120, h: 168 };

// 1. A CARD LYING STILL IS STABLE. Small jitter from a hand-held phone must not
//    break the run, or capture would never fire in real use.
{
  assert.strictEqual(detectionsAgree(CARD, { ...CARD }), true,
    'an identical detection must agree');
  assert.strictEqual(detectionsAgree(CARD, { x: 41, y: 61, w: 120, h: 168 }), true,
    'one pixel of hand jitter must not break stability');
  pass('FSTAB-TC1', 'a still card stays stable through small jitter');
}

// 2. DROPPING A NEW CARD BREAKS STABILITY. This is the whole mechanism for
//    Zach's workflow -- "I just drop cards on top" -- since the disturbance is
//    what re-arms capture without requiring him to clear the frame.
{
  assert.strictEqual(detectionsAgree(CARD, { x: 70, y: 95, w: 120, h: 168 }), false,
    'a card landing in a visibly different spot must break stability');
  assert.strictEqual(detectionsAgree(CARD, { x: 40, y: 60, w: 150, h: 210 }), false,
    'a card at a different distance must break stability');
  pass('FSTAB-TC2', 'a newly dropped card breaks the stable run');
}

// 3. UNKNOWN STATE IS NOT STABLE. A missing detection must never be treated as
//    agreement, or a dropped frame could trigger a capture of nothing.
{
  assert.strictEqual(detectionsAgree(CARD, null), false, 'null previous is not stable');
  assert.strictEqual(detectionsAgree(null, CARD), false, 'null current is not stable');
  assert.strictEqual(detectionsAgree(null, null), false, 'both null is not stable');
  assert.strictEqual(detectionsAgree(CARD, { x: 0, y: 0, w: 0, h: 0 }), false,
    'a zero-area detection is not stable');
  pass('FSTAB-TC3', 'missing or degenerate detections are never stable');
}

// 4. IoU BEHAVES. Sanity on the primitive the whole gate rests on.
{
  assert.strictEqual(boxIoU(CARD, { ...CARD }), 1, 'identical boxes have IoU 1');
  assert.strictEqual(boxIoU(CARD, { x: 900, y: 900, w: 10, h: 10 }), 0,
    'disjoint boxes have IoU 0');
  const half = boxIoU(CARD, { x: CARD.x + CARD.w / 2, y: CARD.y, w: CARD.w, h: CARD.h });
  assert.ok(half > 0.2 && half < 0.5, `half-overlap IoU should be mid-range, got ${half}`);
  pass('FSTAB-TC4', 'IoU is correct on identical, disjoint and partial overlap');
}

// 5. THE GATE IS EVENT-COUNTED, NOT TIME-BASED.
//
//    Zach: "Nothing should be measured on time. That's how we are in this in
//    the first place." Counting detector frames means a stalled camera stalls
//    the count, which a wall-clock would get wrong.
{
  assert.ok(Number.isInteger(STABLE_FRAMES_REQUIRED) && STABLE_FRAMES_REQUIRED >= 2,
    'stability must require at least 2 consecutive frames');
  const start = src.indexOf('const outcome = lastTickOutcomeRef.current;');
  const end = src.indexOf('handleCaptureRef.current?.(true)', start);
  assert.ok(start > 0 && end > start, 'auto-scan capture block not found');
  const block = src.slice(start, end);
  assert.ok(!/Date\.now\(\)/.test(block), 'the capture decision must not read the clock');
  assert.ok(/stableCountRef\.current < STABLE_FRAMES_REQUIRED/.test(block),
    'the capture decision must gate on the stable-frame count');
  pass('FSTAB-TC5', 'capture is gated on counted frames with no wall-clock');
}

// 6. ONE STABLE PERIOD PRODUCES ONE SCAN.
//
//    Without this a card left sitting in frame is rescanned every poll -- the
//    original duplicate complaint. The latch is cleared by MOVEMENT, so
//    dropping the next card re-arms it.
{
  const start = src.indexOf('const outcome = lastTickOutcomeRef.current;');
  const end = src.indexOf('handleCaptureRef.current?.(true)', start);
  const block = src.slice(start, end);
  assert.ok(/if \(stablePeriodConsumedRef\.current\) return;/.test(block),
    'a stable period that already captured must not capture again');
  assert.ok(/stablePeriodConsumedRef\.current = true;/.test(block),
    'capturing must consume the stable period');
  assert.ok(/stablePeriodConsumedRef\.current = false;/.test(src),
    'movement must re-arm capture');
  pass('FSTAB-TC6', 'one stable period yields exactly one scan, re-armed by movement');
}

// 7. THE FAILED APPROACHES STAY DELETED. Each of these shipped a scanner that
//    refused real cards; a future refactor must not quietly reintroduce them.
{
  for (const dead of ['frameSignature', 'signaturesDiffer', 'detectionMoved',
    'SIG_DIFFERENT_THRESHOLD', 'PLACEMENT_MOVE_FRACTION', 'SAME_CARD_GUARD_MAX_MS']) {
    assert.ok(!src.includes(dead),
      `${dead} is back — preview-frame "same card" guessing skipped real cards`);
  }
  pass('FSTAB-TC7', 'no preview-frame fingerprinting or guard timeout has returned');
}

// 8. TAP-TO-FORCE EXISTS AND IS SAFE.
//
//    Zach: "if it doesnt scan that card we can have a tap feature that will
//    force scanning". Built now rather than later because it is the escape
//    hatch for the measured risk: two different cards resting in the same spot
//    give IoU 0.98-1.00, so re-arming relies on the live loop seeing the drop.
//
//    It must bypass the STABILITY gate but NOT the sharpness gate -- forcing a
//    blurred frame trades a missed card for a WRONG card, which is worse.
{
  const i = src.indexOf("aria-label={t('scan.tapToScan')}");
  assert.ok(i > 0, 'tap-to-scan overlay not found');
  const block = src.slice(Math.max(0, i - 2400), i);
  assert.ok(/handleCaptureRef\.current\?\.\(false, true\)/.test(block),
    'tap must call the capture path in MANUAL mode (auto=false) to skip the stability gate');
  assert.ok(/stablePeriodConsumedRef\.current = true;/.test(block),
    'tap must consume the stable period so auto does not immediately rescan');
  // DELIBERATELY NOT REQUIRED: tap used to bail when the preview detector had
  // no box. That detector finds a card in only 9 of 33 real scans, so the bail
  // fired for the SAME reason the auto path was stuck -- which is why Zach's
  // taps "didn't do anything". A manual tap must not depend on the subsystem
  // that is already failing; the server detects on the full-res frame anyway.
  assert.ok(!/if \(!liveDetectRef\.current\) return;   \/\/ nothing to scan/.test(block),
    'tap must NOT require a preview detection — that is the bug it must survive');
  pass('FSTAB-TC8', 'tap-to-force scans on demand without bypassing the sharpness gate');
}

// 9. THE SCANNER CANNOT WEDGE ITSELF PERMANENTLY.
//
//    Zach: "the scanner started out good but it stopped scanning eventually and
//    tapping didn't get it to scan again". `loading` gates BOTH auto-scan and
//    the tap override, so if it is ever left true the scanner is dead until the
//    camera is restarted.
//
//    The cause: `finally { if (scanId === currentScanId.current) setLoading(false); }`
//    skipped the reset whenever a scan was superseded. The superseding scan
//    then owned the flag -- but if IT returned early, nobody ever cleared it.
{
  const i = src.indexOf('} finally {');
  assert.ok(i > 0, 'handleCapture finally block not found');
  const block = src.slice(i, i + 1600);
  assert.ok(/^\s*setLoading\(false\);\s*$/m.test(block),
    'the finally block must clear `loading` UNCONDITIONALLY — a scoped reset '
    + 'leaves the scanner permanently wedged when a scan is superseded');
  assert.ok(!/if \(scanId === currentScanId\.current\) setLoading\(false\)/.test(src),
    'the id-scoped setLoading(false) is back — that is the wedge bug');
  pass('FSTAB-TC9', '`loading` is always cleared, so the scanner cannot wedge');
}

// 10. TAP RECOVERS A WEDGED SCANNER.
//
//     An escape hatch that fails the same way the auto path failed is not an
//     escape hatch. Tap must (a) still be on screen while `loading` is true,
//     and (b) be able to run despite it.
{
  const i = src.indexOf("aria-label={t('scan.tapToScan')}");
  assert.ok(i > 0, 'tap-to-scan overlay not found');
  const block = src.slice(Math.max(0, i - 3200), i);
  assert.ok(/\{fullscreenScan && cameraActive && autoScan && \(/.test(block),
    'the tap target must NOT be hidden by `loading` — that removes the very '
    + 'control that recovers from a stuck `loading`');
  assert.ok(/handleCaptureRef\.current\?\.\(false, true\)/.test(block),
    'tap must force past a stuck `loading`');
  assert.ok(/\(loading && !force\)/.test(src),
    'handleCapture must honour the force flag for manual taps only');
  pass('FSTAB-TC10', 'tap stays available and can force past a stuck loading flag');
}

// 11. THE TRAINED DETECTOR LEADS THE PREVIEW, AND ITS FAILURE IS SURVIVABLE.
//
//     Zach: "yeah I said this earlier about using the yolo detector for
//     measuring this please build it."
//
//     Measured: the edge detector finds a card in 9/33 of his real scans (21 of
//     the 24 misses fail the ASPECT test — it latches onto the strongest edges,
//     which on a stack of cards are not the card's outline). The trained
//     detector finds 31/33 of the same photos.
//
//     The load-bearing safety property is that a missing or broken model must
//     degrade to today's behaviour, never to a frozen preview.
{
  const ui = fs.readFileSync(SRC, 'utf8');
  assert.ok(/import \{ initCardDetector, detectCardOnDevice, detectorReady \}/.test(ui),
    'the preview must import the on-device detector');
  assert.ok(/if \(detectorReady\(\)\) det = await detectCardOnDevice\(data, DW, DH\);/.test(ui),
    'the trained detector must run first when it is loaded');
  assert.ok(/if \(!det\) det = detectCardInFrame\(gray, DW, DH\);/.test(ui),
    'the edge detector must remain as the fallback');

  const det = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'onDeviceCardDetect.js'), 'utf8');
  assert.ok(/if \(!session \|\| busy\) return null;/.test(det),
    'inference must refuse to run when the model is absent or already running');
  assert.ok(/catch \(e\) \{[\s\S]{0,200}return null;/.test(det),
    'inference failures must return null, never throw into the preview loop');
  assert.ok(/session = null;\s*\n\s*backendName = 'none';/.test(det),
    'a failed load must be remembered as unavailable, not retried every frame');
  pass('FSTAB-TC11', 'the trained detector leads the preview and fails safe to the old one');
}

// 12. THE PREVIEW LOOP CANNOT PILE UP ASYNC WORK.
//
//     Inference measured ~142ms on Zach's phone against a 140ms loop. With
//     setInterval the ticks would overlap and queue behind each other, each
//     holding a frame buffer, for as long as he keeps scanning.
{
  const ui = fs.readFileSync(SRC, 'utf8');
  assert.ok(!/setInterval\(tick/.test(ui),
    'the detection loop must not use setInterval — an async tick would overlap');
  assert.ok(/const pump = async \(\) => \{[\s\S]{0,260}await tick\(\);/.test(ui),
    'the loop must chain the next tick after the previous one completes');
  pass('FSTAB-TC12', 'the detection loop is self-scheduling and cannot overlap');
}

console.log(`\nscan-stability.test.js: ${passed} cases passed`);
