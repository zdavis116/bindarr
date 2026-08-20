// Build a realistic "photo of a card" from real card art, for tests that need
// the SCAN PIPELINE's input rather than a clean render.
//
// Shared by the OCR route tests. It exists because the collector-number bug was
// invisible to anything fed a clean full-frame card: the strip only degrades
// once the card is small in the frame and has to be detected and rectified. So
// the staging here mirrors what Zach actually photographs, per his description:
//
//   - the card occupies ~35% of the frame (not full-frame)
//   - it sits at a slight angle with mild perspective (handheld, in a white
//     plastic holder)
//   - another card intrudes at the edge (the rest of the stack)
//   - glare falls across the artwork
//
// The card ART is real (Scryfall PNG at full resolution, cached on disk), so the
// collector-number strip contains REAL TYPOGRAPHY at a real size. Compositing a
// real card into a synthetic scene is the same technique test/crop.test.js uses
// and for the same reason: it gives a KNOWN correct answer for something that is
// otherwise only checkable by eye.
//
// WHAT THIS STILL CANNOT PROVE, stated plainly because it changed how this test
// had to be written. It is not a photograph: no sensor noise, no motion blur, no
// real lens MTF falloff, no auto-exposure. Measured consequence — at Zach's
// stated framing (card ~35% of frame area, `scale: 0.62` below) the OLD broken
// path scores 4/4 on this fixture, so THIS FIXTURE DOES NOT REPRODUCE THE 0/4
// SEEN IN PRODUCTION. The old path only starts fabricating here once the card is
// far smaller in frame (~4%, `scale: 0.32`) or heavily blurred. Real phone
// photos evidently starve a 500x700 warp at framings this fixture survives.
//
// So this helper is a fair test of the RESOLUTION MECHANISM and a genuine
// regression gate, and it is NOT proof that live scanning is fixed. Zach's phone
// is the gate for that.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { cv } = require('opencv-wasm');

const CACHE = path.join(__dirname, '..', '..', '.bench-cache');

// Real printings with known collector numbers. Zero-padding and the
// rarity-first layout differ between these, which is the point.
const CARDS = [
  { key: 'sol-ring-c21', name: 'Sol Ring', set: 'c21', number: '263',
    url: 'https://cards.scryfall.io/png/front/4/c/4cbc6901-6a4a-4d0a-83ea-7eefa3b35021.png' },
  { key: 'counterspell-mh2', name: 'Counterspell', set: 'mh2', number: '267',
    url: 'https://cards.scryfall.io/png/front/1/9/1920dae4-fb92-4f19-ae4b-eb3276b8dac7.png' },
  { key: 'kodama-neo', name: 'Kodama of the West Tree', set: 'neo', number: '199',
    url: 'https://cards.scryfall.io/png/front/e/f/ef1e1dff-b559-441d-8df3-b6a418066aca.png' },
  { key: 'llanowar-dom', name: 'Llanowar Elves', set: 'dom', number: '168',
    url: 'https://cards.scryfall.io/png/front/5/8/581b7327-3215-4a4f-b4ae-d9d4002ba882.png' },
];

// Cached on disk and gitignored (.bench-cache), like crop.test.js. Needs network
// on first run only.
async function fetchArt(card) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, `ocr-${card.key}.png`);
  if (!fs.existsSync(f)) {
    const r = await axios.get(card.url, {
      responseType: 'arraybuffer', timeout: 30000,
      headers: { 'User-Agent': 'bindarr-test/1.0' },
    });
    fs.writeFileSync(f, Buffer.from(r.data));
  }
  return f;
}

// Composite the card into a scene at a rotated/tilted quad, then add clutter.
// Returns a JPEG buffer — the scanner receives a JPEG from the phone, and JPEG
// is lossy on exactly the small high-contrast text this reads, so testing on a
// PNG would be easier than production.
async function stagePhoto(artFile, {
  sceneW = 2400, sceneH = 3200, scale = 0.62, deg = 5, tilt = 0.09,
  glare = true, neighbour = true,
} = {}) {
  const meta = await sharp(artFile).metadata();
  const { data } = await sharp(artFile).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const cardMat = cv.matFromImageData({
    data: new Uint8ClampedArray(data), width: meta.width, height: meta.height,
  });

  // A white plastic holder: bright, slightly uneven, with a little noise so the
  // thresholding has something realistic to bite on.
  const scene = new cv.Mat(sceneH, sceneW, cv.CV_8UC4);
  for (let y = 0; y < sceneH; y++) {
    for (let x = 0; x < sceneW; x++) {
      const i = (y * sceneW + x) * 4;
      const v = Math.max(0, Math.min(255,
        228 + Math.round((x / sceneW) * 16 - 8) + (Math.floor(x * 7 + y * 13) % 7) - 3));
      scene.data[i] = v; scene.data[i + 1] = v; scene.data[i + 2] = v; scene.data[i + 3] = 255;
    }
  }

  // scale is of scene HEIGHT; at 0.62 with a 3:4 scene the card covers ~34% of
  // the frame area, which is what Zach described.
  const h = sceneH * scale, w = h * (meta.width / meta.height);
  const cx = sceneW / 2, cy = sceneH / 2;
  const rad = (deg * Math.PI) / 180;
  const quad = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
    .map(([x, y], i) => {
      const t = (i === 0 || i === 1) ? tilt : 0; // top edge leans back
      const nx = x * (1 - t);
      return [cx + nx * Math.cos(rad) - y * Math.sin(rad), cy + nx * Math.sin(rad) + y * Math.cos(rad)];
    });

  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, meta.width, 0, meta.width, meta.height, 0, meta.height]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flat());
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  cv.warpPerspective(cardMat, scene, M, new cv.Size(sceneW, sceneH), cv.INTER_LINEAR, cv.BORDER_TRANSPARENT);

  const px = (x, y, v) => {
    if (x < 0 || y < 0 || x >= sceneW || y >= sceneH) return;
    const i = (y * sceneW + x) * 4;
    scene.data[i] = v; scene.data[i + 1] = v; scene.data[i + 2] = v;
  };
  if (neighbour) {
    // The rest of the stack, intruding from the right edge.
    for (let y = Math.round(sceneH * 0.15); y < Math.round(sceneH * 0.8); y++) {
      for (let x = Math.round(sceneW * 0.9); x < sceneW; x++) px(x, y, 95);
    }
  }
  if (glare) {
    // Across the ARTWORK, deliberately not across the collector strip: glare on
    // the number would test the OCR's tolerance to a blown-out crop, which is a
    // different (and real, but separate) problem from the resolution bug.
    const gx = sceneW * 0.55, gy = sceneH * 0.36, r = Math.min(sceneW, sceneH) * 0.16;
    for (let y = 0; y < sceneH; y++) {
      for (let x = 0; x < sceneW; x++) {
        if (Math.hypot(x - gx, y - gy) < r) px(x, y, 248);
      }
    }
  }

  const out = await sharp(Buffer.from(scene.data), { raw: { width: sceneW, height: sceneH, channels: 4 } })
    .jpeg({ quality: 88 }).toBuffer();

  cardMat.delete(); scene.delete(); srcTri.delete(); dstTri.delete(); M.delete();
  return out;
}

// All four staged photos, as { ...card, jpeg }.
async function stagedCards(opts) {
  const out = [];
  for (const c of CARDS) {
    out.push({ ...c, jpeg: await stagePhoto(await fetchArt(c), opts) });
  }
  return out;
}

module.exports = { CARDS, fetchArt, stagePhoto, stagedCards };
