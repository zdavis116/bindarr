// AUTO-SCAN MUST NOT REFUSE A REAL CARD.
//
// HISTORY, because it is the whole point of this file. Zach reported the
// scanner adding the same card twice when he was slow to swap. I tried twice to
// stop that by inferring "is this a new card?" from the PREVIEW FRAME:
//
//   attempt 1  coarse luma fingerprint of the detected region
//   attempt 2  detector geometry -- had the box moved?
//
// Both SKIPPED REAL CARDS. The premise was wrong: he stacks each new card in
// the SAME POSITION on top of the last, so the box does not move, and two cards
// under identical lighting in the same spot have nearly identical coarse luma.
// There is no reliable "different card" signal in a preview frame.
//
// So the preview-frame guessing is gone. Duplicate suppression happens AFTER
// identification, on card IDENTITY, where the answer is known -- and the bug
// that made it misfire was that a NOISE-LEVEL match was being treated as an
// identity. Two different foil cards both matched 'Jeskai Ascendancy' at 11 and
// 14 inliers, so the second was suppressed as "same card still in view".
//
// These tests pin the rule that came out of that: only a TRUSTED match may
// suppress a scan.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'CameraScanner.jsx');
const src = fs.readFileSync(SRC, 'utf8');

let passed = 0;
const pass = (id, msg) => { console.log(`PASS: ${id} ${msg}`); passed++; };

// 1. THE PREVIEW-FRAME GUESSING IS GONE AND MUST STAY GONE.
//
//    Both attempts shipped a scanner that refused cards Zach physically placed
//    in front of it. A skipped card is the worst failure this app has: it is
//    only findable by recounting the physical stack.
{
  for (const dead of ['frameSignature', 'signaturesDiffer', 'detectionMoved',
    'SIG_DIFFERENT_THRESHOLD', 'PLACEMENT_MOVE_FRACTION']) {
    assert.ok(!src.includes(dead),
      `${dead} is back — preview-frame "same card" guessing skipped real cards twice`);
  }
  pass('FDUP-TC1', 'no preview-frame fingerprinting decides whether to scan');
}

// 2. NO WALL-CLOCK IN THE CAPTURE DECISION.
//
//    Zach: "Nothing should be measured on time. That's how we are in this in
//    the first place." An earlier fix used a 4s guard expiry; a timer is a
//    guess about the user dressed up as logic.
{
  const start = src.indexOf('const outcome = lastTickOutcomeRef.current;');
  const end = src.indexOf('handleCaptureRef.current?.(true)', start);
  assert.ok(start > 0 && end > start, 'auto-scan capture block not found');
  const block = src.slice(start, end);
  assert.ok(!/Date\.now\(\)/.test(block),
    'the capture decision must not consult the clock');
  assert.ok(!/GUARD_MAX_MS/.test(block),
    'the capture decision must not use a guard timeout');
  pass('FDUP-TC2', 'the capture decision contains no wall-clock logic');
}

// 3. A CARD MUST BE IN VIEW BEFORE CAPTURING. This part of Zach's rule works
//    and stays: auto-scan used to fire on a timer regardless, uploading empty
//    mats and hands to be matched against 57,000 cards.
{
  const start = src.indexOf('const outcome = lastTickOutcomeRef.current;');
  const end = src.indexOf('handleCaptureRef.current?.(true)', start);
  const block = src.slice(start, end);
  assert.ok(/if \(!liveDetectRef\.current\) return;/.test(block),
    'auto-scan must not capture when no card is detected in frame');
  pass('FDUP-TC3', 'auto-scan only captures when a card is actually in view');
}

// 4. ONLY A TRUSTED MATCH MAY SUPPRESS A SCAN.
//
//    THE BUG ZACH HIT. The duplicate guards keyed on card ID, and a noise-level
//    match supplies a WRONG id — two different foils both read as 'Jeskai
//    Ascendancy' (11 and 14 inliers), so the second card was suppressed and
//    never scanned. Both guards must now require a trusted match.
{
  const start = src.indexOf('const identityIsTrusted');
  assert.ok(start > 0, 'identityIsTrusted gate not found');
  const block = src.slice(start, start + 1200);
  assert.ok(/identityIsTrusted && id === resolvedDupIdRef\.current/.test(block),
    'the "same card still in view" guard must require a trusted match');
  assert.ok(/identityIsTrusted && id === lastAddedIdRef\.current/.test(block),
    'the "already added" guard must require a trusted match');
  pass('FDUP-TC4', 'a noise-level match cannot suppress the next card');
}

// 5. THE STRENGTH ACTUALLY REACHES THAT GATE.
//
//    `top.card` is a hydrated catalogue row with no inliers field, so reading
//    matches[0].inliers alone would be undefined — which would silently
//    DISABLE duplicate detection rather than fix it. The strength is passed
//    explicitly.
{
  assert.ok(/applyMatches = async \(matches, notFoundMsg, autoSingle = false, matchInliers = null\)/.test(src),
    'applyMatches must accept the match strength explicitly');
  assert.ok(/applyMatches\(\[top\.card\], '', true, top\.inliers\)/.test(src),
    'the instant path must pass top.inliers — top.card does not carry it');
  pass('FDUP-TC5', 'match strength is passed explicitly, not read off a hydrated row');
}

console.log(`\nscan-dedupe.test.js: ${passed} cases passed`);
