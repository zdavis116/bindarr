// AUTO-SCAN MUST NOT CAPTURE THE SAME CARD TWICE.
//
// Zach: "it did scan 2 cards twice because I was too slow to move to the next
// card... We shouldn't capture a card until we know there is a card in view and
// if a new card doesn't come in view we shouldn't just keep scanning the same
// card."
//
// For software tracking PHYSICAL objects a duplicate is not cosmetic: it claims
// he owns two of something he owns one of, and he cannot reconcile that against
// the stack in his hand without recounting it.
//
// These test the two pure functions the gate is built on. The gate itself is
// three lines of ref reads; the logic that can actually be wrong is here.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The functions live in a .jsx module full of React. Rather than pull in a JSX
// pipeline for two pure functions, extract and evaluate them directly — if the
// extraction fails the test fails loudly rather than silently testing nothing.
const src = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'CameraScanner.jsx'), 'utf8');

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in CameraScanner.jsx — did it get renamed?`);
  let depth = 0, i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const consts = ['SIG_COLS', 'SIG_ROWS', 'SIG_DIFFERENT_THRESHOLD', 'PLACEMENT_MOVE_FRACTION']
  .map((n) => {
    const m = src.match(new RegExp(`const ${n} = ([^;]+);`));
    assert.ok(m, `${n} not found`);
    return `const ${n} = ${m[1]};`;
  }).join('\n');

// eslint-disable-next-line no-eval
const mod = eval(`(() => { ${consts}\n${extract('frameSignature')}\n${extract('signaturesDiffer')}\n${extract('detectionMoved')}\n`
  + 'return { frameSignature, signaturesDiffer, detectionMoved, SIG_DIFFERENT_THRESHOLD }; })()');
const { frameSignature, signaturesDiffer, detectionMoved, SIG_DIFFERENT_THRESHOLD } = mod;

let passed = 0;
const pass = (id, msg) => { console.log(`PASS: ${id} ${msg}`); passed++; };

// A synthetic "card": a grey field with a distinguishing bright block.
function makeCard(w, h, blockX, blockY, shade) {
  const g = new Uint8ClampedArray(w * h).fill(90);
  for (let y = blockY; y < blockY + 20; y++) {
    for (let x = blockX; x < blockX + 20; x++) g[y * w + x] = shade;
  }
  return g;
}

const W = 160, H = 220;
const DET = { x: 20, y: 20, w: 120, h: 180 };

// 1. THE SAME CARD, HELD STILL, IS THE SAME CARD.
{
  const a = frameSignature(makeCard(W, H, 40, 60, 220), W, H, DET);
  const b = frameSignature(makeCard(W, H, 40, 60, 220), W, H, DET);
  assert.strictEqual(signaturesDiffer(a, b), false,
    'an identical frame must not read as a new card');
  pass('FDUP-TC1', 'holding the same card still does not trigger a rescan');
}

// 2. CAMERA NOISE IS NOT A NEW CARD. A steady hand still jitters.
{
  const base = makeCard(W, H, 40, 60, 220);
  const noisy = Uint8ClampedArray.from(base, (v, i) => v + ((i * 7) % 5) - 2);
  assert.strictEqual(signaturesDiffer(frameSignature(base, W, H, DET),
    frameSignature(noisy, W, H, DET)), false,
    'sensor noise must not read as a new card');
  pass('FDUP-TC2', 'camera noise does not trigger a rescan');
}

// 3. A DIFFERENT CARD IS A DIFFERENT CARD. This is the failure that matters
//    MOST: skipping a real card is worse than a duplicate, because a missing
//    card is much harder to notice than an extra one.
{
  const a = frameSignature(makeCard(W, H, 40, 60, 220), W, H, DET);
  const b = frameSignature(makeCard(W, H, 90, 140, 20), W, H, DET);
  assert.strictEqual(signaturesDiffer(a, b), true,
    'a visibly different card MUST be scannable');
  pass('FDUP-TC3', 'a different card is detected as different');
}

// 3b. THE THRESHOLD MUST CLEAR REAL CARDS, NOT JUST SYNTHETIC ONES.
//
//    THIS IS THE REGRESSION THAT SHIPPED. The threshold was tuned on the
//    synthetic fixtures above, which say a different card scores 3.67, so 2.0
//    looked safe. Real Magic cards photographed in the same spot share border,
//    layout and overall luma, and measured MUCH closer:
//
//        same image re-hashed   0.00
//        different real cards   1.08, 2.08, 2.67, 6.71
//
//    At 2.0 the scanner refused real cards Zach placed in front of it. This
//    test pins the real-world numbers so a future tweak cannot re-break it
//    while the synthetic cases still pass.
{
  const MEASURED_REAL_CARD_DIFFS = [1.08, 2.08, 2.67, 6.71];
  const MEASURED_SAME_CARD = 0.00;
  const min = Math.min(...MEASURED_REAL_CARD_DIFFS);
  assert.ok(SIG_DIFFERENT_THRESHOLD < min,
    `threshold ${SIG_DIFFERENT_THRESHOLD} must be BELOW the smallest real-card `
    + `difference (${min}) or genuinely different cards get skipped`);
  assert.ok(SIG_DIFFERENT_THRESHOLD > MEASURED_SAME_CARD,
    `threshold ${SIG_DIFFERENT_THRESHOLD} must be ABOVE the same-card floor `
    + `(${MEASURED_SAME_CARD}) or a held card rescans forever`);
  pass('FDUP-TC6', 'the threshold sits between the measured real-card and same-card values');
}

// 4. UNKNOWN STATE NEVER BLOCKS A SCAN. A null signature means "we do not know",
//    and not knowing must never silently refuse to scan a card he is holding.
{
  const a = frameSignature(makeCard(W, H, 40, 60, 220), W, H, DET);
  assert.strictEqual(signaturesDiffer(a, null), true, 'null last-scanned must allow a scan');
  assert.strictEqual(signaturesDiffer(null, a), true, 'null current must allow a scan');
  assert.strictEqual(signaturesDiffer(null, null), true, 'both null must allow a scan');
  pass('FDUP-TC4', 'an unknown fingerprint never blocks a scan');
}

// 5. THE SIGNATURE READS THE CARD, NOT THE BACKGROUND. Otherwise a hand or a
//    shifting mat would look like a new card and re-trigger scanning.
{
  const base = makeCard(W, H, 40, 60, 220);
  const bgChanged = Uint8ClampedArray.from(base);
  for (let y = 0; y < 15; y++) for (let x = 0; x < W; x++) bgChanged[y * W + x] = 250;
  assert.strictEqual(signaturesDiffer(frameSignature(base, W, H, DET),
    frameSignature(bgChanged, W, H, DET)), false,
    'a change OUTSIDE the detected card must not read as a new card');
  pass('FDUP-TC5', 'background changes outside the card do not trigger a rescan');
}

// 7. A NEW PLACEMENT IS DETECTED FROM GEOMETRY, NOT A CLOCK.
//
//    Zach's rule after the first fix used a 4s timeout: "Nothing should be
//    measured on time. That's how we are in this in the first place. We have
//    yolo for object detection why not lean on that."
//
//    Placing a card on top of another moves and resizes the detected box. That
//    event replaces the timer entirely, so a card whose luma happens to match
//    the last one is still scannable the moment it is physically placed.
{
  const a = { x: 20, y: 30, w: 100, h: 140 };
  assert.strictEqual(detectionMoved(a, { ...a }), false,
    'an undisturbed card must not read as a new placement');
  assert.strictEqual(detectionMoved(a, { x: 34, y: 48, w: 104, h: 146 }), true,
    'a card set down in a new position MUST read as a new placement');
  assert.strictEqual(detectionMoved(a, { x: 20.4, y: 30.3, w: 100, h: 140 }), false,
    'sub-pixel jitter must not read as a new placement');
  assert.strictEqual(detectionMoved(a, null), true,
    'unknown previous detection must allow a scan');
  assert.strictEqual(detectionMoved(null, a), true,
    'unknown current detection must allow a scan');
  pass('FDUP-TC7', 'a new placement is recognised from detector geometry, with no timer');
}

console.log(`\nscan-dedupe.test.js: ${passed} cases passed`);
