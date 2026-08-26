// THE YOLO DETECTOR MUST NEVER BE ABLE TO BREAK A SCAN.
//
// Phase 4b puts a trained model in front of the classical detector on the live
// scan path. The single promise that makes that acceptable: if ANYTHING about
// the model goes wrong, scanning degrades to exactly today's behaviour rather
// than failing. Zach is holding a physical card.
//
// That promise is easy to write in a comment and easy to break in a refactor,
// so it is tested against real failure modes.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  // 1. MISSING MODEL -> unavailable, no throw. A fresh checkout has no model
  //    (it is a 10MB binary); that must degrade, not crash.
  process.env.CARD_DETECTOR_MODEL = '/nonexistent/none.onnx';
  delete require.cache[require.resolve('../src/cardDetector')];
  let det = require('../src/cardDetector');
  det._reset();
  assert.strictEqual(await det.detect(new Uint8ClampedArray(4 * 10 * 10), 10, 10), null,
    'missing model must return null, not throw');

  // 2. CORRUPT MODEL -> same. Truncation is the realistic shape: an interrupted
  //    scp or a partial write.
  const tmp = path.join(os.tmpdir(), `bad-model-${process.pid}.onnx`);
  fs.writeFileSync(tmp, Buffer.from([0x08, 0x09, 0xff, 0xff, 0x00]));
  process.env.CARD_DETECTOR_MODEL = tmp;
  delete require.cache[require.resolve('../src/cardDetector')];
  det = require('../src/cardDetector');
  det._reset();
  assert.strictEqual(await det.detect(new Uint8ClampedArray(4 * 10 * 10), 10, 10), null,
    'corrupt model must return null');
  fs.unlinkSync(tmp);

  // 3. THE SCAN PATH STILL WORKS WITH NO MODEL AT ALL. This is the real
  //    promise: detectWithFallback must reach the classical detector.
  process.env.CARD_DETECTOR_MODEL = '/nonexistent/none.onnx';
  delete require.cache[require.resolve('../src/cardDetector')];
  delete require.cache[require.resolve('../src/scanMatch')];
  const sm = require('../src/scanMatch');
  const sharp = require('sharp');

  // A synthetic card: a light rectangle on a dark field, which the classical
  // contour detector is designed to find.
  const W = 900, H = 1200;
  const bg = { create: { width: W, height: H, channels: 3, background: { r: 20, g: 20, b: 25 } } };
  const cardW = 500, cardH = 700;
  const card = await sharp({
    create: { width: cardW, height: cardH, channels: 3, background: { r: 210, g: 205, b: 190 } },
  }).png().toBuffer();
  const photo = await sharp(bg)
    .composite([{ input: card, left: (W - cardW) / 2, top: (H - cardH) / 2 }])
    .jpeg().toBuffer();

  const r = await sm.preprocessCardWithDetection(photo);
  assert.ok(r && r.buf, 'preprocessCardWithDetection must always return an image');
  assert.ok(r.detect, 'classical fallback should still detect a plain card with no model');
  assert.strictEqual(r.detect.quad.length, 4, 'fallback must return a 4-corner quad');

  // 4. GARBAGE INPUT must not throw out of the detector.
  delete require.cache[require.resolve('../src/cardDetector')];
  det = require('../src/cardDetector');
  det._reset();
  assert.strictEqual(await det.detect(null, 0, 0), null, 'null input must return null');

  delete process.env.CARD_DETECTOR_MODEL;
  
// --- THE ORB EARLY EXIT MUST NOT CHANGE ANSWERS -----------------------------
//
// Zach: "I would like to work on speed next." orb-verify was 38% of a 3112ms
// scan, verifying all ~50 recalled candidates even after finding a 141-inlier
// match at rank 2.
//
// The break that fixes it is only acceptable because it changes NOTHING about
// what the scanner decides. Measured over 160 corpus captures: 991ms/scan ->
// 852ms/scan, with 0 of 160 identifications changed.
//
// THE FIRST VERSION FAILED THAT CHECK -- 7 of 160 answers changed, every one a
// basic land swapping printings (Forest/eld#266 vs Forest/soi#297). Dozens of
// Forest printings score 80+ inliers against one photo, so "no later candidate
// can beat this" is false for them: the first 80+ match is merely the earliest.
//
// These assertions pin the shape of the guard, so it cannot be loosened later
// without someone reading why it is shaped this way.
{
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'scanMatch.js'), 'utf8');

  const m = src.match(/const CERTAIN_INLIERS = (\d+);/);
  assert.ok(m, 'the early-exit threshold must exist and be named');
  const certain = Number(m[1]);

  // Measured across this project: WRONG matches top out at 30 inliers, RIGHT
  // ones run 35-162. The exit bar must sit far above the wrong band, not just
  // above the "confident" bar used for skipping the other game.
  assert.ok(certain >= 60,
    `CERTAIN_INLIERS (${certain}) must sit well above the highest observed `
    + 'WRONG match (30), or the scanner could stop early on a bad match');
  const strong = Number((src.match(/const STRONG_INLIERS = (\d+);/) || [])[1]);
  assert.ok(certain > strong,
    `CERTAIN_INLIERS (${certain}) must exceed STRONG_INLIERS (${strong}) — they `
    + 'answer different questions and must not collapse into one');

  // The basic-land exclusion is the whole reason this is safe.
  assert.ok(/const BASIC_LAND_NAMES = new Set\(/.test(src),
    'basic lands must be excluded from the early exit');
  assert.ok(/inliers >= CERTAIN_INLIERS && !BASIC_LAND_NAMES\.has\(/.test(src),
    'the early exit must skip basic lands — dozens of their printings score 80+ '
    + 'against one photo, so the first strong match is not the best one');
  for (const land of ['plains', 'island', 'swamp', 'mountain', 'forest']) {
    assert.ok(new RegExp(`'${land}'`).test(src), `${land} must be excluded`);
  }
  console.log('PASS: FCD-TC10 - the ORB early exit is bounded and excludes basic lands');
}

console.log('card detector fallback: PASS (missing, corrupt, null, and the '
    + 'scan path still detects with no model)');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
