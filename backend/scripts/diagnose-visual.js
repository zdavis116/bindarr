// LOOK AT THE ACTUAL RECTIFIED IMAGES.
//
// The numbers say session 2's queries are far from EVERY card in the index --
// a "Forest" scan sits 134 bits from its nearest of 372 Forest artworks. A hash
// that is far from everything is not a ranking problem; it means the picture
// being hashed is not much like a card image at all.
//
// Numbers have taken this as far as they can. Render the rectified image
// alongside the reference artwork and look.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const sharp = require('sharp');
const scanMatch = require('../src/scanMatch');

const OUT = process.argv[3] || '/tmp/compare';

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

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const idx = JSON.parse(fs.readFileSync(path.join(__dirname, '../../hash-index/rgbart-index.json'), 'utf8'));
  const pairs = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/pairs3.json', 'utf8'));

  const tiles = [];
  for (const p of pairs.slice(0, 6)) {
    const src = path.join('/tmp/scans2', p.file);
    if (!fs.existsSync(src)) continue;
    const rect = await scanMatch.rectifyCard(fs.readFileSync(src), { width: 488, height: 680 });
    if (!rect) continue;

    const ref = idx.cards.find(c => c.name === p.orbName);
    const refBuf = ref ? await get(ref.img).catch(() => null) : null;

    // Side by side: what the scanner hashed | what the index holds.
    const row = await sharp({
      create: { width: 976, height: 680, channels: 3, background: { r: 20, g: 20, b: 20 } },
    }).composite([
      { input: await sharp(rect).resize(488, 680, { fit: 'fill' }).toBuffer(), left: 0, top: 0 },
      ...(refBuf ? [{ input: await sharp(refBuf).resize(488, 680, { fit: 'fill' }).toBuffer(), left: 488, top: 0 }] : []),
    ]).png().toBuffer();
    tiles.push(row);
    console.log(`  ${p.orbName}  (scan | index reference)`);
  }

  if (!tiles.length) { console.log('nothing to render'); return; }
  // Downscale each row FIRST, then compose -- composing at full size and
  // resizing after overflows sharp's canvas bounds.
  const W = 700, H = Math.round(680 * (W / 976));
  const small = [];
  for (const t of tiles) small.push(await sharp(t).resize(W, H, { fit: 'fill' }).toBuffer());
  const sheet = await sharp({
    create: { width: W, height: H * small.length, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).composite(small.map((t, i) => ({ input: t, left: 0, top: i * H })))
    .jpeg({ quality: 82 }).toBuffer();

  const out = path.join(OUT, 'compare.jpg');
  fs.writeFileSync(out, sheet);
  console.log(`\nwrote ${out}`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
