// CONFIRM THE FRAMING DEFECT, AND SIZE THE FIX.
//
// diagnose-distance.js showed the hash is extremely sensitive to framing: a 3%
// crop of the SAME image moves its hash 46 bits, and 5% moves it 68 -- which is
// most of the way to a wrong card (nearest wrong card was 120).
//
// That explains Zach's session. rectifyCard warps to the DETECTED CARD EDGE, so
// a query is a borderless card. Scryfall's `normal` images -- what the index was
// built from -- include the black border, roughly 3-4% on each side. So every
// query is being compared against images framed differently from itself, and
// pays a systematic 40-70 bit penalty before any real difference is considered.
//
// This measures the actual border on Scryfall images and tests whether cropping
// the REFERENCE to match the query framing collapses the distance.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const sharp = require('sharp');
const rgbArt = require('../src/rgbArtMatch');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Bindarr/1.0 (diagnostic)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(get(res.headers.location));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(Buffer.concat(c)));
    }).on('error', reject);
  });
}

function ham(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) { let x = a[i] ^ b[i]; while (x) { d += x & 1; x >>= 1; } }
  return d;
}

// Find the real border: scan in from each edge until pixels stop being dark.
async function measureBorder(buf) {
  const { data, info } = await sharp(buf).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const lum = (x, y) => {
    const i = (y * w + x) * 3;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  const midY = h >> 1, midX = w >> 1;
  let l = 0; while (l < w / 4 && lum(l, midY) < 60) l++;
  let r = 0; while (r < w / 4 && lum(w - 1 - r, midY) < 60) r++;
  let t = 0; while (t < h / 4 && lum(midX, t) < 60) t++;
  let b = 0; while (b < h / 4 && lum(midX, h - 1 - b) < 60) b++;
  return { w, h, l, r, t, b, fx: (l + r) / 2 / w, fy: (t + b) / 2 / h };
}

(async () => {
  const idx = JSON.parse(fs.readFileSync(path.join(__dirname, '../../hash-index/rgbart-index.json'), 'utf8'));
  const picks = ['HULK SMASH!', 'Plains', 'Namor the Sub-Mariner', 'The Kingpin of Crime'];
  console.log('Measuring the black border on Scryfall `normal` images:\n');
  const fracs = [];
  for (const name of picks) {
    const c = idx.cards.find(x => x.name === name);
    if (!c) continue;
    const buf = await get(c.img);
    const b = await measureBorder(buf);
    fracs.push(b.fx, b.fy);
    console.log(`  ${name.padEnd(26)} ${b.w}x${b.h}  border L${b.l} R${b.r} T${b.t} B${b.b}` +
      `  -> ${(b.fx * 100).toFixed(1)}% x / ${(b.fy * 100).toFixed(1)}% y`);
  }
  const avg = fracs.reduce((a, x) => a + x, 0) / fracs.length;
  console.log(`\n  mean border: ${(avg * 100).toFixed(2)}% of each dimension`);

  // Now the decisive test: hash a reference card BOTH ways and see how far
  // apart they are. If de-bordering is the fix, the borderless version of a
  // card should be much closer to a borderless query than the bordered one.
  const ref = idx.cards.find(x => x.name === 'HULK SMASH!');
  const buf = await get(ref.img);
  const meta = await sharp(buf).metadata();
  const bordered = rgbArt.packBits(await rgbArt.rgbArtBits(buf));

  console.log('\n  distance between the bordered and de-bordered hash of the SAME card:');
  for (const f of [0.02, 0.03, 0.035, 0.04, 0.05]) {
    const dx = Math.round(meta.width * f), dy = Math.round(meta.height * f);
    const crop = await sharp(buf).extract({
      left: dx, top: dy, width: meta.width - 2 * dx, height: meta.height - 2 * dy,
    }).png().toBuffer();
    const h = rgbArt.packBits(await rgbArt.rgbArtBits(crop));
    console.log(`    de-border ${(f * 100).toFixed(1)}%  ->  ${ham(h, bordered)} bits from the bordered hash`);
  }
  console.log('\n  Read this as: the index and the live queries currently differ by');
  console.log('  roughly this much BEFORE any real difference between cards is seen.');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
