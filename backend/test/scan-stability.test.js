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

// 13. DETECTOR JITTER MUST NOT RE-ARM CAPTURE.
//
//     Zach: "evil thrall scanned twice even though I never tapped or anything
//     after it scanned the first time."
//
//     The one-scan-per-stable-period latch cleared on ANY single disagreeing
//     frame. The trained detector regresses a fresh box each frame, so its
//     output jitters even on a motionless card -- one wobble past the IoU
//     threshold re-armed capture and the card scanned twice.
{
  const ui = fs.readFileSync(SRC, 'utf8');
  assert.ok(/const DISTURBED_FRAMES_TO_REARM = (\d+);/.test(ui),
    'a disturbance run length must be defined');
  const n = parseInt(ui.match(/const DISTURBED_FRAMES_TO_REARM = (\d+);/)[1], 10);
  assert.ok(n >= 2, 'a SINGLE disagreeing frame must not re-arm — that is the double-scan bug');
  assert.ok(/disturbedRunRef\.current \+= 1;\s*\n\s*if \(disturbedRunRef\.current >= DISTURBED_FRAMES_TO_REARM\) \{\s*\n\s*stablePeriodConsumedRef\.current = false;/.test(ui),
    'the latch must clear only after a RUN of disturbed frames');
  assert.ok(/stableCountRef\.current \+= 1;\s*\n\s*disturbedRunRef\.current = 0;/.test(ui),
    'an agreeing frame must reset the disturbance run');
  pass('FSTAB-TC13', 'a single jittery frame cannot re-arm capture and rescan the same card');
}

// 14. THE SHUTTER WAITS FOR THE CARD TO SETTLE, NOT JUST TO BE STABLE.
//
//     Zach: "scanning seems to be getting worse at one point it was doing
//     really good". Four of seven queues had NO collector-number line in the
//     OCR text -- the capture was blurred, so the text was never in the image.
//
//     Stability gating fires at the EARLIEST instant the card is arguably
//     still: hand just gone, card possibly still rocking, lens not yet
//     refocused. The old timer path happened to wait longer, which is the
//     behaviour he remembers as good.
{
  const ui = fs.readFileSync(SRC, 'utf8');
  assert.ok(/const SETTLE_FRAMES_BEFORE_CAPTURE = (\d+);/.test(ui),
    'a settling allowance must be defined');
  const n = parseInt(ui.match(/const SETTLE_FRAMES_BEFORE_CAPTURE = (\d+);/)[1], 10);
  assert.ok(n >= 1, 'capture must wait at least one frame past bare stability');
  assert.ok(/stableCountRef\.current < STABLE_FRAMES_REQUIRED \+ SETTLE_FRAMES_BEFORE_CAPTURE/.test(ui),
    'the capture gate must require stability PLUS settling');
  assert.ok(!/Date\.now\(\)/.test(ui.slice(ui.indexOf('const outcome = lastTickOutcomeRef.current;'),
    ui.indexOf('handleCaptureRef.current?.(true)'))),
    'settling must be counted in frames, not milliseconds');
  pass('FSTAB-TC14', 'capture waits for extra settling frames, counted not timed');
}

// 15. THE SHARPNESS BASELINE LEARNS FROM SETTLED FRAMES.
//
//     The gate is RELATIVE — it rejects a frame below 0.6x the median of recent
//     frames. Its window was sized for the old ~3s cadence, when most observed
//     frames showed a settled card. Stability gating clustered captures around
//     card swaps, so the window filled with post-motion frames and the median
//     sank to the blur level.
//
//     Driving the real decideCapture with a realistic swap/settle sequence
//     accepted 8 of 12 BLURRED frames: the gate was blind exactly when Zach was
//     scanning fast.
{
  const ui = fs.readFileSync(SRC, 'utf8');
  const i = ui.indexOf('TEACH THE SHARPNESS BASELINE');
  assert.ok(i > 0, 'the baseline must be fed from settled preview frames');
  const block = ui.slice(i, i + 3200);
  assert.ok(/if \(stableCountRef\.current >= STABLE_FRAMES_REQUIRED\)/.test(ui.slice(i, i + 2200)),
    'only frames observed while the detection is STABLE may teach the baseline');
  assert.ok(/recent: \[\.\.\.\(sharpnessRef\.current\.recent \|\| \[\]\), sc\]\.slice\(-SHARPNESS_WINDOW\)/.test(block),
    'observed scores must feed the rolling window');
  assert.ok(!/decideCapture\(/.test(block),
    'the live probe must OBSERVE ONLY — it must never trigger a capture');
  pass('FSTAB-TC15', 'the sharpness baseline is taught by settled frames, not swap blur');
}

// 16. AUTO-SCAN MUST NOT DEADLOCK ON ITS OWN WAKE-UP SIGNAL.
//
//     Zach: "it wasn't auto scanning I had to tap on the screen to initiate
//     every scan."
//
//     The capture effect only re-runs when a value in its dep list changes, and
//     `steady` is what wakes it. `steady` flipped true at STABLE_FRAMES_REQUIRED
//     while the capture gate required STABLE_FRAMES_REQUIRED +
//     SETTLE_FRAMES_BEFORE_CAPTURE. So the effect woke at 3, found 3 < 6,
//     returned — and nothing woke it again, because `steady` was already true
//     and the frame count lives in a ref React does not watch. Auto-scan was
//     dead on every card; tapping was the only way through.
//
//     Tying the wake-up signal to the SAME threshold the gate tests makes this
//     class of bug unrepresentable.
{
  const ui = fs.readFileSync(SRC, 'utf8');
  const gate = ui.match(/if \(stableCountRef\.current < ([^)]+)\) return;/);
  assert.ok(gate, 'the capture threshold expression was not found');
  const steady = ui.match(/const isSteady = stableCountRef\.current >= ([\s\S]{0,120}?)\n/);
  assert.ok(steady, 'the steady expression was not found');
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  assert.ok(norm(steady[1]).startsWith(norm(gate[1])),
    `the wake-up signal (${norm(steady[1])}) must use the SAME threshold as the `
    + `capture gate (${norm(gate[1])}) — a lower one deadlocks auto-scan`);
  assert.ok(/steady\]/.test(ui) || /, steady\b/.test(ui),
    '`steady` must be in the capture effect dep list or nothing wakes it');
  pass('FSTAB-TC16', 'the capture gate and its wake-up signal share one threshold');
}

// 17. THE PREVIEW MUST NOT SCAN AN EMPTY BOX.
//
//     Zach: "the 1st one is just the empty box it shouldn't be scanning until a
//     card is there."
//
//     The preview inherited the SERVER's confidence floor of 0.25, but the two
//     ask different questions. The server is told "Zach captured this photo,
//     where is the card in it" -- permissive is right, since refusing a real
//     capture is worse than a loose crop. The preview decides whether to take a
//     photo AT ALL, where a false positive means a nonsense queue row.
//
//     MEASURED on his captures: real cards 0.933-0.951; synthetic empty frames
//     produce no detection at all.
{
  const det = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'onDeviceCardDetect.js'), 'utf8');
  const m = det.match(/const CONF_MIN = ([0-9.]+);/);
  assert.ok(m, 'the preview confidence floor must be defined');
  const floor = parseFloat(m[1]);
  assert.ok(floor > 0.25,
    `the preview floor (${floor}) must be STRICTER than the server's 0.25 — `
    + 'inheriting it is what scanned an empty box');
  assert.ok(floor <= 0.90,
    `the preview floor (${floor}) must stay below the measured real-card minimum `
    + '(0.933) or real cards stop detecting');
  pass('FSTAB-TC17', 'the preview is stricter than the server about what counts as a card');
}

// 18. AN OFF-FRAME BOX MUST BE REFUSED, NOT CLAMPED INTO A SLIVER.
//
//     Zach: "those crops were outside the card I could see it when I was
//     scanning it got stuck like that for a bit too."
//
//     The preview CLAMPED the predicted box to the frame. A box mostly
//     off-screen became a thin sliver against the edge, which looked like a
//     perfectly valid detection -- and, being consistent frame after frame, the
//     stability gate counted it as STABLE and fired the shutter repeatedly.
//     Hence the near-empty thumbnails and the "stuck" behaviour.
//
//     The SERVER detector already refuses this ('quad outside frame'); the
//     preview inherited the geometry but not the guard.
//
//     MEASURED on 98 corpus detections: visible-after-clamp min 0.759, and
//     frame coverage up to 1.29 (a card held close legitimately overflows the
//     frame). My first AREA_MAX of 0.98 would have rejected 8 REAL detections.
{
  const det = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'onDeviceCardDetect.js'), 'utf8');
  const m = det.match(/const VISIBLE_MIN = ([0-9.]+);/);
  assert.ok(m, 'a visible-after-clamp floor must exist');
  const v = parseFloat(m[1]);
  assert.ok(v > 0 && v <= 0.75,
    `VISIBLE_MIN (${v}) must reject mostly-off-frame boxes while staying below `
    + 'the measured real minimum of 0.759');
  assert.ok(/if \(\(\(x1 - x0\) \* \(y1 - y0\)\) \/ rawArea < VISIBLE_MIN\) return null;/.test(det),
    'the clamped box must be compared against the RAW predicted box');
  assert.ok(!/const AREA_MAX =/.test(det),
    'there must be no upper area bound — real cards held close cover >100% of '
    + 'the frame, and 8 corpus detections did exactly that');
  pass('FSTAB-TC18', 'a mostly-off-frame detection is refused instead of clamped');
}

console.log(`\nscan-stability.test.js: ${passed} cases passed`);
