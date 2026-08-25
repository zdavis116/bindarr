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
  console.log('card detector fallback: PASS (missing, corrupt, null, and the '
    + 'scan path still detects with no model)');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
