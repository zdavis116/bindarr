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

const consts = ['SIG_COLS', 'SIG_ROWS', 'SIG_DIFFERENT_THRESHOLD']
  .map((n) => {
    const m = src.match(new RegExp(`const ${n} = ([^;]+);`));
    assert.ok(m, `${n} not found`);
    return `const ${n} = ${m[1]};`;
  }).join('\n');

// eslint-disable-next-line no-eval
const mod = eval(`(() => { ${consts}\n${extract('frameSignature')}\n${extract('signaturesDiffer')}\n`
  + 'return { frameSignature, signaturesDiffer }; })()');
const { frameSignature, signaturesDiffer } = mod;

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

console.log(`\nscan-dedupe.test.js: ${passed} cases passed`);
