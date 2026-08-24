// WHY ARE LIVE DISTANCES SO HIGH?
//
// Zach's session: p50 distance 82, and even scans where ORB and rgbArt AGREE
// (so both are probably right) sit at 98-108 bits. Gate 1a measured 26-64 on
// real photos, and clean scans in the smoke test hit 32-58. A gap that appears
// on CORRECT answers is systematic, not noise.
//
// Hypothesis to test: the rectified image and the index images are not the same
// KIND of picture. rectifyCard warps to the card's detected quad -- edge to
// edge, no border. Scryfall's `normal` images include the full card INCLUDING
// its black border. If the index was built on bordered images and queries are
// borderless, every hash is computed over a different framing, and the art-box
// crop (8%/11%/84%/43% of the image) lands on the wrong region too.
//
// This measures the same card both ways instead of arguing about it.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const sharp = require('sharp');
const rgbArt = require('../src/rgbArtMatch');

const SCAN_DIR = process.argv[2] || '/tmp/scans';

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

// Trim a proportional border off an image -- simulating what a tighter or
// looser crop does to the hash.
async function inset(buf, frac) {
  const m = await sharp(buf).metadata();
  const dx = Math.round(m.width * frac), dy = Math.round(m.height * frac);
  return sharp(buf).extract({ left: dx, top: dy, width: m.width - 2 * dx, height: m.height - 2 * dy })
    .png().toBuffer();
}

function ham(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i];
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

(async () => {
  // A card we know was scanned and correctly identified, with its Scryfall id
  // taken from the index itself.
  const idxRaw = JSON.parse(fs.readFileSync(path.join(__dirname,'../../hash-index/rgbart-index.json'), 'utf8'));
  const target = idxRaw.cards.find(c => c.name === 'HULK SMASH!' && c.set === 'msh')
    || idxRaw.cards.find(c => c.name === 'HULK SMASH!');
  if (!target) { console.log('reference card not in index'); return; }
  console.log(`reference: ${target.name} [${target.set} ${target.number}]`);

  const ref = await get(target.img);
  const refHash = rgbArt.packBits(await rgbArt.rgbArtBits(ref));
  const stored = Buffer.from(target.hash, 'base64');
  console.log(`  index hash vs re-hashed source image: ${ham(refHash, stored)} bits ` +
    `(0 = the build is reproducible)`);

  // How much does CROPPING the reference move its own hash? This is the
  // sensitivity of the hash to framing, measured rather than assumed.
  console.log('\n  effect of cropping the SAME image (self-distance):');
  for (const f of [0.01, 0.02, 0.03, 0.05, 0.08]) {
    const h = rgbArt.packBits(await rgbArt.rgbArtBits(await inset(ref, f)));
    console.log(`    inset ${(f * 100).toFixed(0).padStart(2)}%  ->  ${ham(h, stored)} bits`);
  }

  // And what does the index's own nearest-neighbour spacing look like from
  // here? If a 3% crop moves the hash further than the gap to a WRONG card,
  // framing alone can flip an identification.
  const hits = rgbArt.nearest(stored, 3);
  console.log(`\n  nearest OTHER cards to this one: ` +
    hits.slice(1).map(h => `${h.name} @ ${h.dist}`).join(', '));
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
