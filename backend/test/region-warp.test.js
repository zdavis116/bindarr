// --- THE REGION WARP MUST BE THE SAME PIXELS -------------------------------
//
// Zach: "I would rather not have duplicate work."
//
// rectifyCard's OCR warp cost 322-345ms -- the most expensive step after ORB --
// because it sampled a 2000px source and wrote a full 1500x2100 card. OCR only
// ever reads two small bands: the collector strip and the title. The other ~93%
// was warped at full resolution and discarded.
//
// The `region` option warps ONLY the requested band: same transform, same
// source, same sampling, smaller output canvas. Measured: 345ms -> 106ms for
// both bands, and through the real read path 695ms -> 159ms per scan.
//
// THE ENTIRE JUSTIFICATION is that the pixels are identical. Verified across 25
// captures at worst channel difference 0/255, and 91/91 identical parsed reads.
// If that ever stops being true, every OCR threshold tuned on the corpus is
// invalidated -- so it is pinned here.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const sm = require('../src/scanMatch');
const collectorOcr = require('../src/utils/collectorNumberOcr');

let passed = 0;
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

(async () => {
  // A synthetic card is enough: this tests the WARP's geometry, not card
  // content, and it keeps the suite independent of Zach's corpus.
  const W = 900, H = 1260;
  const src = await sharp({
    create: { width: W, height: H, channels: 3, background: { r: 30, g: 30, b: 30 } },
  }).composite([{
    // A bright block where the collector strip lives, so a misplaced crop is
    // obvious rather than subtle.
    input: await sharp({
      create: { width: 240, height: 110, channels: 3, background: { r: 240, g: 240, b: 240 } },
    }).png().toBuffer(),
    left: Math.round(W * 0.02), top: Math.round(H * 0.87),
  }]).jpeg().toBuffer();

  const detection = {
    quad: [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }],
    detW: W, detH: H,
  };
  const dims = { width: collectorOcr.OCR_W, height: collectorOcr.OCR_H, detection };

  // --- FRGN-TC1: region output has the expected dimensions -----------------
  {
    const band = await sm.rectifyCard(src, { ...dims, region: collectorOcr.STRIP });
    assert.ok(band, 'a region warp must produce an image');
    const m = await sharp(band).metadata();
    const wantW = Math.round(collectorOcr.STRIP.width * collectorOcr.OCR_W);
    const wantH = Math.round(collectorOcr.STRIP.height * collectorOcr.OCR_H);
    assert.strictEqual(m.width, wantW, `region width ${m.width} != ${wantW}`);
    assert.strictEqual(m.height, wantH, `region height ${m.height} != ${wantH}`);
    pass('FRGN-TC1', 'a region warp outputs exactly the requested band size');
  }

  // --- FRGN-TC2: identical to cropping the full warp (the whole point) -----
  {
    const full = await sm.rectifyCard(src, dims);
    const band = await sm.rectifyCard(src, { ...dims, region: collectorOcr.STRIP });
    const m = await sharp(full).metadata();
    const cropped = await sharp(full).extract({
      left: Math.round(m.width * collectorOcr.STRIP.left),
      top: Math.round(m.height * collectorOcr.STRIP.top),
      width: Math.round(m.width * collectorOcr.STRIP.width),
      height: Math.round(m.height * collectorOcr.STRIP.height),
    }).raw().toBuffer();
    const direct = await sharp(band).raw().toBuffer();

    assert.strictEqual(direct.length, cropped.length,
      'the region warp and the cropped full warp must have the same byte length');
    let worst = 0;
    for (let i = 0; i < cropped.length; i++) {
      const d = Math.abs(cropped[i] - direct[i]);
      if (d > worst) worst = d;
    }
    assert.ok(worst <= 1,
      `region warp differs from the cropped full warp by ${worst}/255 — every OCR `
      + 'threshold in this project was tuned on those exact pixels');
    pass('FRGN-TC2', 'a region warp is pixel-identical to cropping the full warp');
  }

  // --- FRGN-TC3: no region behaves exactly as before -----------------------
  //
  // Non-vacuous guard: if `region` were ignored entirely, TC2 would still pass
  // by accident only if the crop matched — this pins the default path too.
  {
    const full = await sm.rectifyCard(src, dims);
    const m = await sharp(full).metadata();
    assert.strictEqual(m.width, collectorOcr.OCR_W, 'a warp with no region must be full width');
    assert.strictEqual(m.height, collectorOcr.OCR_H, 'a warp with no region must be full height');
    pass('FRGN-TC3', 'omitting region still produces the whole card');
  }

  console.log(`\nregion-warp.test.js: ${passed} cases passed`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
